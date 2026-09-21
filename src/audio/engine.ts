/**
 * Audio engine: MediaStream -> AnalyserNode, polled on a deadline-corrected timer that turns each
 * snapshot into a Frame for the pure reducers. The analyser feeds a GainNode fixed at 0 that is
 * connected to the destination: silent (no feedback path), but it guarantees the context pulls the
 * analyser on every engine, including WebKit versions that skip nodes not reaching the output.
 */
import type { Config } from '../config.ts'
import { clipFraction, rmsDb, sanitizeDb, SILENT_DB } from '../dsp/spectrum.ts'
import type { Frame } from '../types.ts'

/**
 * Extra seconds added to the click-taint query window to cover output latency (click scheduled ->
 * played) and input latency (played -> in the analyser's buffer).
 */
const TAINT_LATENCY_S = 0.1

export interface EngineOptions {
  readonly ctx: AudioContext
  readonly stream: MediaStream
  readonly cfg: Config
  /** Receives every frame; the frame owns its `db` array. */
  readonly onFrame: (frame: Frame) => void
  /** True when one of the app's own clicks sounds within [ctxStartS, ctxEndS] (AudioContext time, s). */
  readonly isTainted?: (ctxStartS: number, ctxEndS: number) => boolean
  /** Millisecond clock for Frame.tMs and for the poll deadlines; defaults to performance.now(). */
  readonly now?: () => number
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * Polls an AnalyserNode (fftSize cfg.fftSize, smoothing 0) every cfg.hopMs and delivers Frames.
 * The constructor builds the graph and throws only if Web Audio does (for example a stream without
 * an audio track); start() / stop() / dispose() never throw.
 */
export class Engine {
  private readonly ctx: AudioContext
  private readonly cfg: Config
  private readonly onFrame: (frame: Frame) => void
  private readonly isTainted: ((ctxStartS: number, ctxEndS: number) => boolean) | undefined
  private readonly now: () => number
  private readonly source: MediaStreamAudioSourceNode
  private readonly node: AnalyserNode
  /** Gain 0 -> destination: keeps the analyser pulled without making any sound. */
  private readonly sink: GainNode
  private readonly spectrum: Float32Array<ArrayBuffer>
  private readonly samples: Float32Array<ArrayBuffer>
  private bytes: Uint8Array<ArrayBuffer> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private active = false
  private disposed = false
  /** Poll deadlines are t0Ms + n * hopMs. */
  private t0Ms = 0
  private n = 0
  private prevTMs: number | null = null
  /** The next delivered frame gets gap = true (first frame after start(), or a tick was skipped). */
  private gapPending = false

  constructor(opts: EngineOptions) {
    this.ctx = opts.ctx
    this.cfg = opts.cfg
    this.onFrame = opts.onFrame
    this.isTainted = opts.isTainted
    this.now = opts.now ?? defaultNow

    const cfg = opts.cfg
    const node = opts.ctx.createAnalyser()
    node.fftSize = cfg.fftSize
    node.smoothingTimeConstant = 0
    // minDecibels must stay below maxDecibels at every step, so the order depends on the new range.
    if (cfg.minDecibels < node.maxDecibels) {
      node.minDecibels = cfg.minDecibels
      node.maxDecibels = cfg.maxDecibels
    } else {
      node.maxDecibels = cfg.maxDecibels
      node.minDecibels = cfg.minDecibels
    }
    this.node = node
    this.source = opts.ctx.createMediaStreamSource(opts.stream)
    this.source.connect(node)
    this.sink = opts.ctx.createGain()
    this.sink.gain.value = 0
    node.connect(this.sink)
    this.sink.connect(opts.ctx.destination)
    this.spectrum = new Float32Array(node.frequencyBinCount)
    this.samples = new Float32Array(node.fftSize)
  }

  /** True between start() and stop(). */
  get running(): boolean {
    return this.active
  }

  /** The analyser node (for diagnostics). */
  get analyser(): AnalyserNode {
    return this.node
  }

  /**
   * Start polling. The first frame arrives one hop later with dtMs 0 and gap true: the engine
   * cannot vouch for continuity with anything delivered before, so open measurements are dropped.
   * No-op when already running or disposed.
   */
  start(): void {
    if (this.active || this.disposed) return
    this.active = true
    this.prevTMs = null
    this.gapPending = true
    this.t0Ms = this.now()
    this.n = 0
    this.schedule()
  }

  /** Stop polling; start() resumes with a fresh first frame. */
  stop(): void {
    this.active = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Stop and disconnect the nodes. The engine cannot be restarted afterwards. */
  dispose(): void {
    this.stop()
    this.disposed = true
    try {
      this.source.disconnect()
    } catch {
      // Already disconnected.
    }
    try {
      this.node.disconnect()
    } catch {
      // Already disconnected.
    }
    try {
      this.sink.disconnect()
    } catch {
      // Already disconnected.
    }
  }

  /**
   * Arm the timer for the next deadline t0 + n * hop. When more than one hop behind (throttled
   * timer, busy main thread), resync to the next future deadline instead of firing a burst.
   */
  private schedule(): void {
    const hop = this.cfg.hopMs
    const now = this.now()
    this.n++
    let deadline = this.t0Ms + this.n * hop
    if (now - deadline > hop) {
      this.n = Math.floor((now - this.t0Ms) / hop) + 1
      deadline = this.t0Ms + this.n * hop
    }
    this.timer = setTimeout(this.onTimer, Math.max(0, deadline - now))
  }

  private readonly onTimer = (): void => {
    this.timer = null
    if (!this.active) return
    try {
      this.tick()
    } finally {
      // onFrame may have stopped (or stopped and restarted) the engine.
      if (this.active && this.timer === null) this.schedule()
    }
  }

  /** Take one snapshot and deliver it, or remember the skip while the context is not running. */
  private tick(): void {
    const ctx = this.ctx
    if (ctx.state !== 'running') {
      this.gapPending = true
      return
    }
    const cfg = this.cfg
    const node = this.node

    node.getFloatFrequencyData(this.spectrum)
    const db = sanitizeDb(this.spectrum, new Float32Array(this.spectrum.length), cfg.silentDb)
    this.readTimeDomain()
    const clipFrac = clipFraction(this.samples, cfg.clipThreshold)
    const r = rmsDb(this.samples)
    const rms = r <= SILENT_DB || r < cfg.silentDb ? cfg.silentDb : r

    const tMs = this.now()
    const dtMs = this.prevTMs === null ? 0 : tMs - this.prevTMs
    const gap = this.gapPending || dtMs > cfg.frameGapAbortMs
    const sampleRate = ctx.sampleRate
    const padS = cfg.taintPadMs / 1000
    const endS = ctx.currentTime
    const clickTainted =
      this.isTainted?.(endS - cfg.fftSize / sampleRate - padS - TAINT_LATENCY_S, endS + padS) ?? false

    this.prevTMs = tMs
    this.gapPending = false
    this.onFrame({
      tMs,
      db,
      binHz: sampleRate / cfg.fftSize,
      clipFrac,
      rmsDb: rms,
      dtMs,
      gap,
      clickTainted,
    })
  }

  /** Fill `samples` with the analysis window, using the byte API where the float one is missing. */
  private readTimeDomain(): void {
    const node = this.node
    if (typeof node.getFloatTimeDomainData === 'function') {
      node.getFloatTimeDomainData(this.samples)
      return
    }
    const bytes = (this.bytes ??= new Uint8Array(this.samples.length))
    node.getByteTimeDomainData(bytes)
    for (let i = 0; i < bytes.length; i++) this.samples[i] = (bytes[i]! - 128) / 128
  }
}
