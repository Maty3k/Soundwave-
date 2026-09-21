/**
 * Extra microphones on this device (a USB mic, a headset, a laptop's second array). Each one gets
 * its own raw-audio stream and Engine on the shared AudioContext and measures at the hunt's lock,
 * so the hub can compare what it heard with the main mic. Everything is feature-detected; nothing
 * here throws on a missing API.
 *
 * Platform limits: desktop Chrome, Edge and Firefox capture several inputs at once. Safari on
 * iOS / iPadOS captures one microphone at a time (a second getUserMedia ends or mutes the first
 * track, the main mic included); WebKit on macOS shares one capture unit between its microphone
 * tracks too, so treat every WebKit browser as single-microphone unless tested otherwise. Android
 * Chrome usually refuses a second input (NotReadableError -> 'busy'). listAudioInputs also lists
 * the input the main mic uses under its real id (only the 'default' / 'communications' aliases are
 * dropped), so the caller should leave that one out.
 */
import type { Config } from './config.ts'
import type { ErrorCode, Frame, LockMode, Reading } from './types.ts'
import { Engine } from './audio/engine.ts'
import { mapMicError, RAW_AUDIO_CONSTRAINTS, stopMic } from './audio/mic.ts'
import { LockFollower } from './stationMode.ts'

/** A microphone that can be added as an extra listener. */
export interface AudioInput {
  readonly deviceId: string
  readonly label: string
}

/** Pseudo-devices that alias another input (Chromium on Windows / Android). */
const ALIAS_IDS: ReadonlySet<string> = new Set(['default', 'communications'])

/**
 * The audio inputs of this device, without the 'default' / 'communications' aliases and without
 * unlabelled entries (labels are only known after mic permission). [] on any error.
 */
export async function listAudioInputs(): Promise<AudioInput[]> {
  try {
    const md = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    if (typeof md?.enumerateDevices !== 'function') return []
    const devices = await md.enumerateDevices()
    const out: AudioInput[] = []
    const seen = new Set<string>()
    for (const d of devices) {
      if (d.kind !== 'audioinput' || ALIAS_IDS.has(d.deviceId) || d.deviceId === '' || d.label === '') continue
      if (seen.has(d.deviceId)) continue
      seen.add(d.deviceId)
      out.push({ deviceId: d.deviceId, label: d.label })
    }
    return out
  } catch {
    return []
  }
}

export interface ExtraMicOptions {
  readonly ctx: AudioContext
  readonly input: AudioInput
  readonly cfg: Config
  /** A new or merged reading of this mic at the lock. */
  readonly onReading: (reading: Reading) => void
  /** Held level in live mode, at most every cfg.stationLevelReportMs. */
  readonly onLive: (levelDb: number, clipped: boolean) => void
  /** The mic's track ended (unplugged, revoked). Optional. */
  readonly onEnded?: () => void
  /** Frame clock; defaults to the Engine's (performance.now()), which is also the main mic's. */
  readonly now?: () => number
  /** The app's own click taint query (see Engine); optional. */
  readonly isTainted?: (ctxStartS: number, ctxEndS: number) => boolean
}

/** One extra microphone measuring at the lock. Readings go to onReading, live levels to onLive. */
export class ExtraMic {
  /** 'mic:' + deviceId. */
  readonly id: string
  readonly label: string
  private readonly opts: ExtraMicOptions
  private readonly follower: LockFollower
  private stream: MediaStream | null = null
  private engine: Engine | null = null
  private disposed = false
  private started = false
  /** The start() in progress (concurrent calls share it: one getUserMedia, one stream). */
  private starting: Promise<'ok' | ErrorCode> | null = null
  /** Answers a start() still waiting for getUserMedia (an unanswered permission prompt) with 'busy'. */
  private abortStart: (() => void) | null = null

  constructor(opts: ExtraMicOptions) {
    this.opts = opts
    this.id = 'mic:' + opts.input.deviceId
    this.label = opts.input.label
    this.follower = new LockFollower(opts.cfg)
  }

  /**
   * Open this device's mic with raw-audio constraints and start measuring. Resolves 'ok' or the
   * getUserMedia error mapped to an ErrorCode ('unsupported' without getUserMedia or when the
   * Engine cannot be built, 'busy' when dispose() came first, also while a permission prompt is
   * still open: the mic, if granted later, is released at once). Concurrent calls share one
   * attempt; after a failure start() may be called again. Never rejects.
   */
  start(): Promise<'ok' | ErrorCode> {
    if (this.disposed) return Promise.resolve('busy')
    if (this.started) return Promise.resolve('ok')
    if (this.starting === null) {
      const attempt = this.open().catch((): ErrorCode => 'unsupported')
      this.starting = attempt
      void attempt.then(() => {
        if (this.starting === attempt) this.starting = null
      })
    }
    return this.starting
  }

  /** getUserMedia for this input, then an Engine on the shared context (see start()). */
  private async open(): Promise<'ok' | ErrorCode> {
    const md = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    if (typeof md?.getUserMedia !== 'function') return 'unsupported'
    const constraints: MediaStreamConstraints = {
      audio: { ...RAW_AUDIO_CONSTRAINTS, deviceId: { exact: this.opts.input.deviceId } },
    }
    const opened = await new Promise<MediaStream | ErrorCode>((resolve) => {
      this.abortStart = () => resolve('busy')
      let request: Promise<MediaStream>
      try {
        request = Promise.resolve(md.getUserMedia(constraints))
      } catch (err) {
        resolve(mapMicError(err))
        return
      }
      request.then(
        (stream) => {
          if (this.disposed) stopMic(stream) // start() already answered 'busy'
          else resolve(stream)
        },
        (err: unknown) => resolve(mapMicError(err)),
      )
    })
    this.abortStart = null
    if (typeof opened === 'string') return opened
    const stream = opened
    if (this.disposed) {
      stopMic(stream)
      return 'busy'
    }
    const track = stream.getAudioTracks()[0]
    if (track === undefined) {
      stopMic(stream)
      return 'noMic'
    }
    let engine: Engine
    try {
      engine = new Engine({
        ctx: this.opts.ctx,
        stream,
        cfg: this.opts.cfg,
        onFrame: this.onFrame,
        ...(this.opts.now !== undefined ? { now: this.opts.now } : {}),
        ...(this.opts.isTainted !== undefined ? { isTainted: this.opts.isTainted } : {}),
      })
    } catch {
      stopMic(stream)
      return 'unsupported'
    }
    const onEnded = this.opts.onEnded
    if (onEnded !== undefined) {
      try {
        track.addEventListener('ended', () => {
          if (!this.disposed) onEnded()
        })
      } catch {
        // No event support: the listener just goes quiet.
      }
    }
    this.stream = stream
    this.engine = engine
    this.started = true
    engine.start()
    return 'ok'
  }

  /**
   * Measure at this lock (null: stop measuring). A frequency outside cfg.lockTolPct of the previous
   * lock starts a fresh hunt (reason 'manual', no chirps); a small drift or a chirp <-> live switch
   * of the same beep keeps it (see LockFollower). Pass null on relisten so a new beep starts afresh.
   */
  setLock(lock: { readonly f0Hz: number; readonly mode: LockMode } | null): void {
    this.follower.setLock(lock)
  }

  /** Stop the engine and release the mic; a start() still waiting for the mic resolves 'busy'. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const abort = this.abortStart
    this.abortStart = null
    abort?.()
    this.engine?.dispose()
    this.engine = null
    if (this.stream !== null) stopMic(this.stream)
    this.stream = null
  }

  private readonly onFrame = (frame: Frame): void => {
    if (this.disposed) return
    this.follower.step(
      frame,
      (reading) => this.opts.onReading(reading),
      (levelDb, clipped) => this.opts.onLive(levelDb, clipped),
    )
  }
}
