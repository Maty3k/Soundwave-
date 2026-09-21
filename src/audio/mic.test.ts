/**
 * Tests for the audio layer: mic.ts helpers and acquireMic with a stubbed navigator, plus Engine
 * and Clicker against fake Web Audio nodes and a manual clock (this is the audio folder's only
 * test file, so all three modules are covered here).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIG, withConfig, type Config } from '../config.ts'
import { CLICK_CURVE_POINTS, clickRateHz, dbToGain, hannClickCurve, nextClickDelayS } from '../dsp/geiger.ts'
import { mulberry32 } from '../dsp/synth.ts'
import type { Frame, ProcessorState } from '../types.ts'
import { Clicker } from './clicker.ts'
import { Engine } from './engine.ts'
import { acquireMic, mapMicError, processorState, RAW_AUDIO_CONSTRAINTS, rawAudioStatus, stopMic, toMicDiag } from './mic.ts'

const STATES: readonly ProcessorState[] = ['off', 'on', 'unknown']

describe('RAW_AUDIO_CONSTRAINTS', () => {
  it('turns the three processors off with bare booleans and sets nothing else', () => {
    expect(RAW_AUDIO_CONSTRAINTS).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false })
  })
})

describe('processorState', () => {
  it('maps false to off and true to on', () => {
    expect(processorState(false)).toBe('off')
    expect(processorState(true)).toBe('on')
  })

  it('reads the echoCancellation string forms as on', () => {
    expect(processorState('all')).toBe('on')
    expect(processorState('remote-only')).toBe('on')
  })

  it('maps missing and unexpected values to unknown', () => {
    for (const v of [undefined, null, 0, 1, '', 'false', 'true', {}, []]) expect(processorState(v)).toBe('unknown')
  })
})

describe('rawAudioStatus', () => {
  it('is raw only when all three are off', () => {
    expect(rawAudioStatus('off', 'off', 'off')).toBe('raw')
  })

  it('is partial when any processor is on, whatever the others report', () => {
    expect(rawAudioStatus('on', 'off', 'off')).toBe('partial')
    expect(rawAudioStatus('off', 'on', 'unknown')).toBe('partial')
    expect(rawAudioStatus('unknown', 'unknown', 'on')).toBe('partial')
  })

  it('is unknown when nothing is on but something is unreported', () => {
    expect(rawAudioStatus('off', 'off', 'unknown')).toBe('unknown')
    expect(rawAudioStatus('unknown', 'unknown', 'unknown')).toBe('unknown')
  })

  it('covers all 27 combinations consistently', () => {
    for (const ec of STATES) {
      for (const ns of STATES) {
        for (const agc of STATES) {
          const all = [ec, ns, agc]
          const status = rawAudioStatus(ec, ns, agc)
          expect(status === 'partial').toBe(all.includes('on'))
          expect(status === 'raw').toBe(all.every((s) => s === 'off'))
        }
      }
    }
  })
})

describe('mapMicError', () => {
  it('maps permission errors', () => {
    for (const name of ['NotAllowedError', 'SecurityError', 'PermissionDeniedError']) {
      expect(mapMicError({ name })).toBe('permission')
    }
  })

  it('maps missing-device errors', () => {
    for (const name of ['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError']) {
      expect(mapMicError({ name })).toBe('noMic')
    }
  })

  it('maps device-busy errors', () => {
    for (const name of ['NotReadableError', 'TrackStartError', 'AbortError']) {
      expect(mapMicError({ name })).toBe('busy')
    }
  })

  it('works with real DOMException and Error instances', () => {
    expect(mapMicError(new DOMException('denied', 'NotAllowedError'))).toBe('permission')
    const e = new Error('in use')
    e.name = 'NotReadableError'
    expect(mapMicError(e)).toBe('busy')
  })

  it('maps TypeError and anything unrecognised to unsupported', () => {
    expect(mapMicError(new TypeError('getUserMedia is not a function'))).toBe('unsupported')
    for (const v of [{ name: 'NotSupportedError' }, { name: 42 }, {}, null, undefined, 'NotAllowedError', 7]) {
      expect(mapMicError(v)).toBe('unsupported')
    }
  })
})

// ---- acquireMic with a stubbed navigator ------------------------------------------------------

interface FakeTrack {
  readonly label: string
  readonly getSettings: () => MediaTrackSettings
  readonly applyConstraints: (c: MediaTrackConstraints) => Promise<void>
  readonly stop: () => void
  stopped: boolean
  applied: MediaTrackConstraints[]
  /** A successful applyConstraints() switched the settings to `after`. */
  reconfigured: boolean
}

/** A track whose getSettings() returns `before` until applyConstraints() succeeds, then `after`. */
function fakeTrack(before: MediaTrackSettings, after: MediaTrackSettings, applyFails = false): FakeTrack {
  const t: FakeTrack = {
    label: 'Test mic',
    getSettings: () => (t.reconfigured ? after : before),
    applyConstraints: (c) => {
      t.applied.push(c)
      if (applyFails) return Promise.reject(new DOMException('no', 'OverconstrainedError'))
      t.reconfigured = true
      return Promise.resolve()
    },
    stop: () => {
      t.stopped = true
    },
    stopped: false,
    applied: [],
    reconfigured: false,
  }
  return t
}

function fakeStream(tracks: readonly FakeTrack[]): MediaStream {
  return { getAudioTracks: () => [...tracks], getTracks: () => [...tracks] } as unknown as MediaStream
}

function stubMediaDevices(getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>): void {
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
}

const RAW: MediaTrackSettings = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

describe('acquireMic', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is unsupported without getUserMedia', async () => {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('navigator', {})
    expect(await acquireMic()).toEqual({ ok: false, code: 'unsupported' })
  })

  it('is unsupported in an insecure context without calling getUserMedia', async () => {
    const gum = vi.fn(() => Promise.reject(new Error('should not be called')))
    stubMediaDevices(gum)
    vi.stubGlobal('isSecureContext', false)
    expect(await acquireMic()).toEqual({ ok: false, code: 'unsupported' })
    expect(gum).not.toHaveBeenCalled()
  })

  it('requests raw audio once and reports a raw track without re-applying constraints', async () => {
    const track = fakeTrack({ ...RAW, sampleRate: 48000, channelCount: 1 }, RAW)
    const gum = vi.fn((_c: MediaStreamConstraints) => Promise.resolve(fakeStream([track])))
    stubMediaDevices(gum)
    const r = await acquireMic()
    expect(gum).toHaveBeenCalledTimes(1)
    expect(gum.mock.calls[0]![0]).toEqual({ audio: RAW_AUDIO_CONSTRAINTS })
    expect(track.applied).toEqual([])
    if (!r.ok) throw new Error(`expected ok, got ${r.code}`)
    expect(r.mic.rawAudio).toBe('raw')
    expect(r.mic.deviceLabel).toBe('Test mic')
    expect(r.mic.trackSampleRate).toBe(48000)
    expect(r.mic.channelCount).toBe(1)
    expect(toMicDiag(r.mic, 44100)).toMatchObject({ rawAudio: 'raw', contextSampleRate: 44100, trackSampleRate: 48000 })
  })

  it('re-applies the constraints once when a processor is still on and reports the new settings', async () => {
    const track = fakeTrack({ ...RAW, autoGainControl: true }, RAW)
    const gum = vi.fn(() => Promise.resolve(fakeStream([track])))
    stubMediaDevices(gum)
    const r = await acquireMic()
    expect(gum).toHaveBeenCalledTimes(1)
    expect(track.applied).toEqual([RAW_AUDIO_CONSTRAINTS])
    expect(r.ok && r.mic.rawAudio).toBe('raw')
  })

  it('keeps the track and reports partial when the processor stays on or applyConstraints fails', async () => {
    const stuck = fakeTrack({ ...RAW, noiseSuppression: true }, { ...RAW, noiseSuppression: true })
    stubMediaDevices(() => Promise.resolve(fakeStream([stuck])))
    const a = await acquireMic()
    expect(a.ok && a.mic.noiseSuppression).toBe('on')
    expect(a.ok && a.mic.rawAudio).toBe('partial')

    const failing = fakeTrack({ ...RAW, echoCancellation: true }, RAW, true)
    const gum = vi.fn(() => Promise.resolve(fakeStream([failing])))
    stubMediaDevices(gum)
    const b = await acquireMic()
    expect(gum).toHaveBeenCalledTimes(1)
    expect(failing.applied).toHaveLength(1)
    expect(b.ok && b.mic.rawAudio).toBe('partial')
    expect(failing.stopped).toBe(false)
  })

  it('reports unknown when getSettings omits processors, with null sample rate and channels', async () => {
    const track = fakeTrack({ echoCancellation: false }, {})
    stubMediaDevices(() => Promise.resolve(fakeStream([track])))
    const r = await acquireMic()
    if (!r.ok) throw new Error(`expected ok, got ${r.code}`)
    expect(r.mic.echoCancellation).toBe('off')
    expect(r.mic.autoGainControl).toBe('unknown')
    expect(r.mic.rawAudio).toBe('unknown')
    expect(r.mic.trackSampleRate).toBeNull()
    expect(r.mic.channelCount).toBeNull()
    expect(track.applied).toEqual([])
  })

  it('maps a getUserMedia rejection and never retries with other constraints', async () => {
    const gum = vi.fn(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    stubMediaDevices(gum)
    expect(await acquireMic()).toEqual({ ok: false, code: 'permission' })
    expect(gum).toHaveBeenCalledTimes(1)
  })

  it('is unsupported when isSecureContext is missing, like detectCapabilities', async () => {
    const gum = vi.fn(() => Promise.reject(new Error('should not be called')))
    stubMediaDevices(gum)
    vi.stubGlobal('isSecureContext', undefined)
    expect(await acquireMic()).toEqual({ ok: false, code: 'unsupported' })
    expect(gum).not.toHaveBeenCalled()
  })

  it('survives getSettings throwing and a track without applyConstraints', async () => {
    const throwing = { ...fakeTrack(RAW, RAW), getSettings: () => { throw new Error('gone') } }
    stubMediaDevices(() => Promise.resolve(fakeStream([throwing])))
    const a = await acquireMic()
    expect(a.ok && a.mic.rawAudio).toBe('unknown')

    const old = { ...fakeTrack({ ...RAW, autoGainControl: true }, RAW), applyConstraints: undefined }
    stubMediaDevices(() => Promise.resolve(fakeStream([old as unknown as FakeTrack])))
    const b = await acquireMic()
    expect(b.ok && b.mic.rawAudio).toBe('partial')
  })

  it('maps a synchronous getUserMedia throw', async () => {
    stubMediaDevices(() => {
      throw new TypeError('bad constraints')
    })
    expect(await acquireMic()).toEqual({ ok: false, code: 'unsupported' })
  })

  it('returns noMic and releases the stream when it has no audio track', async () => {
    const video = fakeTrack(RAW, RAW)
    const stream = { getAudioTracks: () => [], getTracks: () => [video] } as unknown as MediaStream
    stubMediaDevices(() => Promise.resolve(stream))
    expect(await acquireMic()).toEqual({ ok: false, code: 'noMic' })
    expect(video.stopped).toBe(true)
  })
})

describe('stopMic', () => {
  it('stops every track and tolerates a track that throws', () => {
    const a = fakeTrack(RAW, RAW)
    const bad = { ...fakeTrack(RAW, RAW), stop: () => { throw new Error('gone') } }
    const c = fakeTrack(RAW, RAW)
    stopMic(fakeStream([a, bad, c]))
    expect(a.stopped).toBe(true)
    expect(c.stopped).toBe(true)
  })
})

// ---- Fake clock and Web Audio for Engine and Clicker ------------------------------------------------

/**
 * Manual timers and clock (ms). Timers run only inside advance(), in due order; block() lets time
 * pass with no timer running (a busy or throttled main thread). An interval that fired late
 * repeats from the time it actually ran, like browsers do.
 */
class ManualClock {
  now = 0
  private seq = 0
  private readonly timers = new Map<number, { due: number; fn: () => void; every: number | null }>()

  install(): void {
    vi.stubGlobal('setTimeout', (fn: () => void, ms = 0) => this.add(fn, ms, null))
    vi.stubGlobal('clearTimeout', (id: number) => this.timers.delete(id))
    vi.stubGlobal('setInterval', (fn: () => void, ms = 0) => this.add(fn, ms, ms))
    vi.stubGlobal('clearInterval', (id: number) => this.timers.delete(id))
  }

  get pending(): number {
    return this.timers.size
  }

  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      let id = -1
      let due = Number.POSITIVE_INFINITY
      for (const [k, t] of this.timers) if (t.due <= end && t.due < due) [id, due] = [k, t.due]
      const t = this.timers.get(id)
      if (t === undefined) break
      this.now = Math.max(this.now, t.due)
      if (t.every === null) this.timers.delete(id)
      else t.due = this.now + Math.max(1, t.every)
      t.fn()
    }
    this.now = end
  }

  block(ms: number): void {
    this.now += ms
  }

  private add(fn: () => void, ms: number, every: number | null): number {
    const id = ++this.seq
    this.timers.set(id, { due: this.now + Math.max(0, ms), fn, every })
    return id
  }
}

class FakeNode {
  /** Current connections (cleared by disconnect). */
  readonly outputs: unknown[] = []
  /** Every connection ever made. */
  readonly connectedTo: unknown[] = []
  disconnects = 0

  connect<T>(dest: T): T {
    this.outputs.push(dest)
    this.connectedTo.push(dest)
    return dest
  }

  disconnect(): void {
    this.outputs.length = 0
    this.disconnects++
  }
}

/** AnalyserNode stand-in that enforces minDecibels < maxDecibels like the real one. */
class FakeAnalyser extends FakeNode {
  fftSize = 2048
  smoothingTimeConstant = 0.8
  private min = -100
  private max = -30
  spectrum: (out: Float32Array) => void = (out) => out.fill(-100)
  timeDomain: (out: Float32Array) => void = (out) => out.fill(0)
  getFloatTimeDomainData: ((out: Float32Array) => void) | undefined = (out) => this.timeDomain(out)

  get frequencyBinCount(): number {
    return this.fftSize / 2
  }

  get minDecibels(): number {
    return this.min
  }

  set minDecibels(v: number) {
    if (v >= this.max) throw new DOMException('minDecibels >= maxDecibels', 'IndexSizeError')
    this.min = v
  }

  get maxDecibels(): number {
    return this.max
  }

  set maxDecibels(v: number) {
    if (v <= this.min) throw new DOMException('maxDecibels <= minDecibels', 'IndexSizeError')
    this.max = v
  }

  getFloatFrequencyData(out: Float32Array): void {
    this.spectrum(out)
  }

  getByteTimeDomainData(out: Uint8Array): void {
    const f = new Float32Array(out.length)
    this.timeDomain(f)
    for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.max(0, Math.round(128 + 128 * f[i]!)))
  }
}

class FakeParam {
  value = 1
  readonly curves: Array<{ readonly values: number[]; readonly t: number; readonly d: number }> = []

  setValueCurveAtTime(values: ArrayLike<number>, t: number, d: number): this {
    this.curves.push({ values: Array.from(values), t, d })
    return this
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam()
}

class FakeOsc extends FakeNode {
  type = 'square'
  readonly frequency = { value: 440 }
  onended: (() => void) | null = null
  startAt: number | null = null
  /** ctx.currentTime when start() was called. */
  scheduledAt: number | null = null
  stopAt: number | null = null
  stops = 0
  ended = false
  private readonly ctx: FakeContext

  constructor(ctx: FakeContext) {
    super()
    this.ctx = ctx
  }

  start(t = 0): void {
    this.startAt = t
    this.scheduledAt = this.ctx.currentTime
  }

  stop(t = 0): void {
    this.stopAt = t
    this.stops++
  }
}

/** AudioContext stand-in whose currentTime (s) follows the manual clock. */
class FakeContext {
  state = 'running'
  sampleRate = 48000
  readonly destination = { kind: 'destination' }
  readonly analysers: FakeAnalyser[] = []
  readonly sources: FakeNode[] = []
  readonly gains: FakeGain[] = []
  readonly oscs: FakeOsc[] = []
  private readonly clock: ManualClock

  constructor(clock: ManualClock) {
    this.clock = clock
  }

  get currentTime(): number {
    return this.clock.now / 1000
  }

  get audio(): AudioContext {
    return this as unknown as AudioContext
  }

  createAnalyser(): FakeAnalyser {
    const a = new FakeAnalyser()
    this.analysers.push(a)
    return a
  }

  createMediaStreamSource(): FakeNode {
    const s = new FakeNode()
    this.sources.push(s)
    return s
  }

  createGain(): FakeGain {
    const g = new FakeGain()
    this.gains.push(g)
    return g
  }

  createOscillator(): FakeOsc {
    const o = new FakeOsc(this)
    this.oscs.push(o)
    return o
  }

  /** What the audio thread does: fire 'ended' on oscillators whose stop time has passed. */
  render(): void {
    for (const o of this.oscs) {
      if (!o.ended && o.stopAt !== null && o.stopAt <= this.currentTime) {
        o.ended = true
        o.onended?.()
      }
    }
  }
}

// ---- Engine -------------------------------------------------------------------------------------

/** Spec: the taint window reaches 0.1 s further back to cover output + input latency. */
const TAINT_LATENCY_S = 0.1

describe('Engine', () => {
  const hop = CONFIG.hopMs
  const T0 = 1000

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function setup(
    opts: {
      readonly cfg?: Config
      readonly isTainted?: (a: number, b: number) => boolean
      readonly onFrame?: (engine: Engine, index: number) => void
    } = {},
  ) {
    const clock = new ManualClock()
    clock.install()
    clock.now = T0
    const ctx = new FakeContext(clock)
    const frames: Frame[] = []
    const engine: Engine = new Engine({
      ctx: ctx.audio,
      stream: {} as MediaStream,
      cfg: opts.cfg ?? CONFIG,
      now: () => clock.now,
      onFrame: (f) => {
        frames.push(f)
        opts.onFrame?.(engine, frames.length - 1)
      },
      ...(opts.isTainted ? { isTainted: opts.isTainted } : {}),
    })
    return { clock, ctx, frames, engine, analyser: ctx.analysers[0]!, source: ctx.sources[0]! }
  }

  it('builds source -> analyser -> silent gain -> destination with the configured size, smoothing and range', () => {
    const { analyser, source, engine, ctx } = setup()
    expect(analyser.fftSize).toBe(CONFIG.fftSize)
    expect(analyser.smoothingTimeConstant).toBe(0)
    expect(analyser.minDecibels).toBe(CONFIG.minDecibels)
    expect(analyser.maxDecibels).toBe(CONFIG.maxDecibels)
    expect(source.connectedTo).toEqual([analyser])
    // The analyser reaches the destination only through a gain fixed at 0: no feedback, always pulled.
    expect(ctx.gains).toHaveLength(1)
    const sink = ctx.gains[0]!
    expect(analyser.connectedTo).toEqual([sink])
    expect(sink.gain.value).toBe(0)
    expect(sink.connectedTo).toEqual([ctx.destination])
    expect(engine.analyser).toBe(analyser as unknown as AnalyserNode)
    expect(engine.running).toBe(false)
  })

  it('sets a dB range above or below the analyser default without tripping min < max', () => {
    for (const cfg of [withConfig({ minDecibels: -20, maxDecibels: 0 }), withConfig({ minDecibels: -200, maxDecibels: -150 })]) {
      const { analyser } = setup({ cfg })
      expect([analyser.minDecibels, analyser.maxDecibels]).toEqual([cfg.minDecibels, cfg.maxDecibels])
    }
  })

  it('delivers one frame per hop; the first after start has dtMs 0 and gap, then dtMs = hopMs', () => {
    const { clock, frames, engine, ctx } = setup()
    engine.start()
    expect(engine.running).toBe(true)
    clock.advance(hop - 1)
    expect(frames).toHaveLength(0)
    clock.advance(1)
    clock.advance(9 * hop)
    expect(frames.map((f) => f.tMs)).toEqual(Array.from({ length: 10 }, (_, k) => T0 + (k + 1) * hop))
    expect(frames[0]).toMatchObject({ dtMs: 0, gap: true })
    for (const f of frames.slice(1)) expect(f).toMatchObject({ dtMs: hop, gap: false, clickTainted: false })
    for (const f of frames) expect(f.binHz).toBe(ctx.sampleRate / CONFIG.fftSize)
  })

  it('takes binHz from the context rate (44.1 kHz)', () => {
    const { clock, frames, engine, ctx } = setup()
    ctx.sampleRate = 44100
    engine.start()
    clock.advance(hop)
    expect(frames[0]!.binHz).toBe(44100 / CONFIG.fftSize)
  })

  it('gives every frame its own sanitised spectrum', () => {
    const { clock, frames, engine, analyser } = setup()
    analyser.spectrum = (out) => {
      out.fill(-80)
      out[0] = Number.NEGATIVE_INFINITY
      out[1] = Number.NaN
      out[2] = -1000
      out[3] = CONFIG.silentDb + 1
    }
    engine.start()
    clock.advance(2 * hop)
    const [a, b] = frames
    expect(a!.db).toHaveLength(CONFIG.fftSize / 2)
    expect(Array.from(a!.db.slice(0, 5))).toEqual([CONFIG.silentDb, CONFIG.silentDb, CONFIG.silentDb, CONFIG.silentDb + 1, -80])
    expect(a!.db).not.toBe(b!.db)
    a!.db[10] = 0
    expect(b!.db[10]).toBe(-80)
  })

  it('measures clipping and RMS over the time-domain window; digital silence reads silentDb', () => {
    const { clock, frames, engine, analyser } = setup()
    // A quarter of the samples at full scale (clipped), the rest at 0.5 (not clipped).
    analyser.timeDomain = (out) => {
      for (let i = 0; i < out.length; i++) out[i] = i % 4 === 0 ? -1 : 0.5
    }
    engine.start()
    clock.advance(hop)
    expect(0.5).toBeLessThan(CONFIG.clipThreshold)
    expect(frames[0]!.clipFrac).toBe(0.25)
    expect(frames[0]!.rmsDb).toBeCloseTo(10 * Math.log10((1 + 3 * 0.25) / 4), 4)
    analyser.timeDomain = (out) => out.fill(0)
    clock.advance(hop)
    expect(frames[1]).toMatchObject({ clipFrac: 0, rmsDb: CONFIG.silentDb })
  })

  it('falls back to the byte time-domain API when the float one is missing', () => {
    const { clock, frames, engine, analyser } = setup()
    analyser.getFloatTimeDomainData = undefined
    analyser.timeDomain = (out) => out.fill(1)
    engine.start()
    clock.advance(hop)
    expect(frames[0]!.clipFrac).toBe(1)
    expect(frames[0]!.rmsDb).toBeCloseTo(20 * Math.log10(127 / 128), 4)
  })

  it('flags a late frame as a gap only when dtMs exceeds frameGapAbortMs', () => {
    for (const stallMs of [CONFIG.frameGapAbortMs, CONFIG.frameGapAbortMs + 1]) {
      const { clock, frames, engine } = setup()
      engine.start()
      clock.advance(5 * hop)
      clock.block(stallMs) // main thread busy: the pending timer fires late
      clock.advance(0)
      expect(frames).toHaveLength(6)
      expect(frames[5]!.dtMs).toBe(stallMs)
      expect(frames[5]!.gap).toBe(stallMs > CONFIG.frameGapAbortMs)
    }
  })

  it('resyncs to the hop grid after a stall instead of bursting', () => {
    const { clock, frames, engine } = setup()
    engine.start()
    clock.advance(5 * hop)
    clock.block(1000 + hop / 2)
    clock.advance(0)
    expect(frames).toHaveLength(6) // the late tick only, not the ~50 missed ones
    clock.advance(5 * hop)
    const after = frames.slice(6)
    expect(after).toHaveLength(5)
    for (const f of after) {
      expect((f.tMs - T0) % hop).toBe(0) // back on the deadline grid t0 + n * hop
      expect(f.gap).toBe(false)
    }
    expect(after.slice(1).every((f) => f.dtMs === hop)).toBe(true)
  })

  it('skips ticks while the context is not running and flags the next delivered frame', () => {
    const { clock, frames, engine, ctx } = setup()
    expect(6 * hop).toBeLessThanOrEqual(CONFIG.frameGapAbortMs) // the gap below comes from the skip alone
    engine.start()
    clock.advance(3 * hop)
    ctx.state = 'suspended'
    clock.advance(5 * hop)
    expect(frames).toHaveLength(3)
    ctx.state = 'running'
    clock.advance(2 * hop)
    expect(frames[3]).toMatchObject({ dtMs: 6 * hop, gap: true })
    expect(frames[4]).toMatchObject({ dtMs: hop, gap: false })
  })

  it('stop() halts the timer; start() begins again with a fresh first frame and is idempotent', () => {
    const { clock, frames, engine } = setup()
    engine.start()
    clock.advance(3 * hop)
    engine.stop()
    expect(engine.running).toBe(false)
    expect(clock.pending).toBe(0)
    clock.advance(10 * hop)
    expect(frames).toHaveLength(3)
    const restartMs = clock.now
    engine.start()
    engine.start()
    expect(clock.pending).toBe(1)
    clock.advance(3 * hop)
    expect(frames).toHaveLength(6)
    expect(frames[3]).toMatchObject({ tMs: restartMs + hop, dtMs: 0, gap: true })
    expect(frames[4]).toMatchObject({ dtMs: hop, gap: false })
  })

  it('can be restarted or stopped from inside onFrame without doubling or leaking the timer', () => {
    const restarted = setup({
      onFrame: (e, i) => {
        if (i === 2) {
          e.stop()
          e.start()
        }
      },
    })
    restarted.engine.start()
    restarted.clock.advance(8 * hop)
    expect(restarted.frames).toHaveLength(8)
    expect(restarted.frames[3]).toMatchObject({ dtMs: 0, gap: true })
    expect(restarted.clock.pending).toBe(1)

    const stopped = setup({ onFrame: (e, i) => (i === 1 ? e.stop() : undefined) })
    stopped.engine.start()
    stopped.clock.advance(8 * hop)
    expect(stopped.frames).toHaveLength(2)
    expect(stopped.engine.running).toBe(false)
    expect(stopped.clock.pending).toBe(0)
  })

  it('dispose() stops and disconnects every node; start() afterwards is a no-op', () => {
    const { clock, frames, engine, analyser, source, ctx } = setup()
    engine.start()
    clock.advance(hop)
    engine.dispose()
    expect(source.disconnects).toBe(1)
    expect(analyser.disconnects).toBe(1)
    expect(ctx.gains[0]!.disconnects).toBe(1)
    engine.start()
    expect(engine.running).toBe(false)
    expect(clock.pending).toBe(0)
    clock.advance(5 * hop)
    expect(frames).toHaveLength(1)
    expect(() => engine.dispose()).not.toThrow()
  })

  it('asks isTainted about the analysis window plus padding and latency, in context seconds', () => {
    const windows: Array<[number, number]> = []
    const { clock, frames, engine, ctx } = setup({
      isTainted: (a, b) => {
        windows.push([a, b])
        return windows.length === 2
      },
    })
    engine.start()
    clock.advance(2 * hop)
    expect(frames.map((f) => f.clickTainted)).toEqual([false, true])
    const pad = CONFIG.taintPadMs / 1000
    const windowS = CONFIG.fftSize / ctx.sampleRate
    windows.forEach(([a, b], k) => {
      const nowS = (T0 + (k + 1) * hop) / 1000
      expect(a).toBeCloseTo(nowS - windowS - pad - TAINT_LATENCY_S, 9)
      expect(b).toBeCloseTo(nowS + pad, 9)
    })
  })
})

// ---- Clicker ------------------------------------------------------------------------------------

describe('Clicker', () => {
  const clickS = CONFIG.clickMs / 1000
  /** Spec: the oscillator stops 2 ms after the gain curve ends. */
  const STOP_TAIL_S = 0.002
  /** Implementation margin: nothing is scheduled closer than this to currentTime. */
  const START_MARGIN_S = 0.01
  const EPS = 1e-9

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function setup(rng: () => number = mulberry32(7)) {
    const clock = new ManualClock()
    clock.install()
    const ctx = new FakeContext(clock)
    const clicker = new Clicker(ctx.audio, CONFIG, rng)
    return { clock, ctx, clicker, master: ctx.gains[0]! }
  }

  /** Clicks scheduled but not started yet. */
  const pendingClicks = (ctx: FakeContext): FakeOsc[] => ctx.oscs.filter((o) => o.startAt! > ctx.currentTime && o.stops === 1)

  /** Advance in small steps until a click is waiting in the lookahead window. */
  function untilPending(clock: ManualClock, ctx: FakeContext): FakeOsc[] {
    for (let i = 0; i < 1000; i++) {
      const p = pendingClicks(ctx)
      if (p.length > 0) return p
      clock.advance(5)
    }
    throw new Error('no click became pending')
  }

  it('is silent with no timer until a rate is set, and routes master gain -> destination', () => {
    const { clock, ctx, clicker, master } = setup()
    expect(master.connectedTo).toEqual([ctx.destination])
    clicker.setCarrier(1100)
    clicker.setPaused(false)
    clicker.setMuted(false)
    clock.advance(2000)
    expect(ctx.oscs).toHaveLength(0)
    expect(clock.pending).toBe(0)
  })

  it('plays each click as a Hann-shaped sine burst on the carrier, then uses a new carrier', () => {
    const { clock, ctx, clicker, master } = setup()
    clicker.setRate(clickRateHz(0.5, CONFIG))
    clock.advance(3000)
    const first = ctx.oscs.slice()
    expect(first.length).toBeGreaterThan(3)
    const curve = Array.from(hannClickCurve(CLICK_CURVE_POINTS, dbToGain(CONFIG.clickGainDb)))
    for (const o of first) {
      expect(o.type).toBe('sine')
      expect(o.frequency.value).toBe(CONFIG.clickCarriersHz[0])
      const g = o.connectedTo[0] as FakeGain
      expect(g).toBeInstanceOf(FakeGain)
      expect(g.connectedTo).toEqual([master])
      expect(g.gain.curves).toEqual([{ values: curve, t: o.startAt, d: clickS }])
      expect(o.stopAt!).toBeCloseTo(o.startAt! + clickS + STOP_TAIL_S, 12)
    }
    clicker.setCarrier(1100)
    clock.advance(3000)
    const later = ctx.oscs.slice(first.length).filter((o) => o.scheduledAt! > 3)
    expect(later.length).toBeGreaterThan(3)
    for (const o of later) expect(o.frequency.value).toBe(1100)
  })

  it.each([clickRateHz(0.75, CONFIG), CONFIG.clickMaxHz])(
    'at %f Hz: mean rate, minimum gap and lookahead as configured, never scheduled in the past',
    (rate) => {
      const { clock, ctx, clicker } = setup(mulberry32(42))
      const durationS = 600
      clicker.setRate(rate)
      clock.advance(durationS * 1000)
      const starts = ctx.oscs.map((o) => o.startAt!)
      // Renewal count of shifted-exponential gaps: CV = 1 - clickMinGapS * rate; allow 4 sigma.
      const expected = durationS * rate
      const cv = 1 - CONFIG.clickMinGapS * rate
      expect(Math.abs(starts.length / expected - 1)).toBeLessThan((4 * cv) / Math.sqrt(expected))
      for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(CONFIG.clickMinGapS - EPS)
      for (const o of ctx.oscs) {
        const lead = o.startAt! - o.scheduledAt!
        expect(lead).toBeGreaterThanOrEqual(START_MARGIN_S - EPS)
        expect(lead).toBeLessThan(CONFIG.clickLookaheadS)
      }
    },
  )

  it('recovers from a stalled scheduler with at most a lookahead of clicks, none in the past', () => {
    const { clock, ctx, clicker } = setup(mulberry32(5))
    clicker.setRate(CONFIG.clickMaxHz)
    clock.advance(1000)
    const n0 = ctx.oscs.length
    clock.block(1000) // the interval is starved for a second
    clock.advance(0)
    const burst = ctx.oscs.slice(n0)
    expect(burst.length).toBeGreaterThan(0)
    expect(burst.length).toBeLessThanOrEqual(Math.floor(CONFIG.clickLookaheadS / CONFIG.clickMinGapS) + 1)
    for (const o of burst) expect(o.startAt! - o.scheduledAt!).toBeGreaterThanOrEqual(START_MARGIN_S - EPS)
    clock.advance(1000)
    const starts = ctx.oscs.map((o) => o.startAt!)
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(CONFIG.clickMinGapS - EPS)
  })

  const silencers: ReadonlyArray<readonly [string, (c: Clicker) => void, (c: Clicker) => void]> = [
    ['setMuted', (c) => c.setMuted(true), (c) => c.setMuted(false)],
    ['setPaused', (c) => c.setPaused(true), (c) => c.setPaused(false)],
    ['setRate(0)', (c) => c.setRate(0), (c) => c.setRate(CONFIG.clickMaxHz)],
  ]

  it.each(silencers)('%s is instant: pending clicks are stopped, disconnected and forgotten', (_name, off, on) => {
    const { clock, ctx, clicker } = setup(mulberry32(11))
    clicker.setRate(CONFIG.clickMaxHz)
    clock.advance(500)
    const pending = untilPending(clock, ctx)
    const before = ctx.oscs.length
    off(clicker)
    expect(clock.pending).toBe(0)
    for (const o of pending) {
      expect(o.stops).toBe(2)
      expect(o.stopAt!).toBeLessThanOrEqual(o.startAt!)
      expect(o.outputs).toEqual([])
      expect((o.connectedTo[0] as FakeGain).outputs).toEqual([])
      expect(clicker.clickedBetween(o.startAt!, o.startAt! + clickS)).toBe(false)
    }
    clock.advance(2000)
    expect(ctx.oscs).toHaveLength(before)
    on(clicker)
    clock.advance(2000)
    expect(ctx.oscs.length).toBeGreaterThan(before)
  })

  it('schedules nothing while the context is not running and resumes when it runs again', () => {
    const { clock, ctx, clicker } = setup(mulberry32(3))
    ctx.state = 'suspended'
    clicker.setRate(CONFIG.clickMaxHz)
    clock.advance(2000)
    expect(ctx.oscs).toHaveLength(0)
    ctx.state = 'running'
    clock.advance(2000)
    expect(ctx.oscs.length).toBeGreaterThan(0)
  })

  it('draws a random first delay, and reports overlap with each click interval via clickedBetween', () => {
    const u = 0.5
    const { clock, ctx, clicker } = setup(() => u)
    const d = nextClickDelayS(CONFIG.clickMinHz, u, CONFIG)
    expect(d).toBeGreaterThan(CONFIG.clickLookaheadS + clickS) // one click at a time in the window
    clicker.setRate(CONFIG.clickMinHz)
    clock.advance(d * 1000)
    const t1 = ctx.oscs[0]!.startAt!
    expect(t1).toBeCloseTo(d, 9)
    expect(clicker.clickedBetween(t1 - 0.01, t1 - 1e-6)).toBe(false)
    expect(clicker.clickedBetween(t1 - 0.01, t1)).toBe(true) // touches the start
    expect(clicker.clickedBetween(t1 + 0.001, t1 + 0.002)).toBe(true) // inside
    expect(clicker.clickedBetween(t1 + clickS, t1 + 0.05)).toBe(true) // touches the end
    expect(clicker.clickedBetween(t1 + clickS + 1e-6, t1 + d - 1e-6)).toBe(false) // between clicks
    expect(clicker.clickedBetween(t1 - 1, t1 + d - 1e-6)).toBe(true)

    // After going silent the next first delay is drawn from the time the clicks resume.
    clicker.setRate(0)
    clock.advance(500)
    const resumeS = ctx.currentTime
    clicker.setRate(CONFIG.clickMinHz)
    clock.advance(d * 1000)
    expect(ctx.oscs.at(-1)!.startAt!).toBeCloseTo(resumeS + d, 9)

    // Click times are forgotten after a few seconds.
    clock.advance(4000)
    expect(clicker.clickedBetween(t1, t1 + clickS)).toBe(false)
    const last = ctx.oscs.at(-1)!.startAt!
    expect(clicker.clickedBetween(last, last)).toBe(true)
  })

  it('disconnects each click once it has ended', () => {
    const { clock, ctx, clicker } = setup()
    clicker.setRate(CONFIG.clickMaxHz)
    clock.advance(1000)
    ctx.render()
    const ended = ctx.oscs.filter((o) => o.ended)
    expect(ended.length).toBeGreaterThan(0)
    for (const o of ended) {
      expect(o.outputs).toEqual([])
      expect((o.connectedTo[0] as FakeGain).outputs).toEqual([])
      expect(o.onended).toBeNull()
    }
  })

  it('dispose() stops the scheduler, cuts pending clicks and disconnects the master for good', () => {
    const { clock, ctx, clicker, master } = setup()
    clicker.setRate(CONFIG.clickMaxHz)
    const pending = untilPending(clock, ctx)
    clicker.dispose()
    expect(clock.pending).toBe(0)
    expect(master.outputs).toEqual([])
    for (const o of pending) expect(o.outputs).toEqual([])
    const n = ctx.oscs.length
    clicker.setRate(CONFIG.clickMaxHz)
    clock.advance(2000)
    expect(ctx.oscs).toHaveLength(n)
    expect(clock.pending).toBe(0)
  })
})
