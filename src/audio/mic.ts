/**
 * Microphone capture with the browser's voice processing switched off, plus the pure helpers that
 * classify what the browser actually applied and map getUserMedia failures to an ErrorCode.
 * Everything is feature-detected; nothing here throws on a missing API.
 */
import type { ErrorCode, MicDiag, ProcessorState, RawAudioStatus } from '../types.ts'

/**
 * Audio constraints for raw capture: echo cancellation, noise suppression and auto gain off.
 * Bare booleans are "ideal" values, so a browser that cannot honour them still opens the mic
 * (never `exact`, which would fail with OverconstrainedError). No sampleRate or channelCount:
 * the AudioContext resamples and the analyser mixes down to mono.
 */
export const RAW_AUDIO_CONSTRAINTS: MediaTrackConstraints = Object.freeze({
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
})

/**
 * Classify one processor value from MediaStreamTrack.getSettings(): false -> 'off', true -> 'on',
 * missing or anything else -> 'unknown'. The string forms newer browsers may report for
 * echoCancellation ('all', 'remote-only') both mean cancellation is active, so they read 'on'.
 */
export function processorState(v: unknown): ProcessorState {
  if (v === false) return 'off'
  if (v === true || v === 'all' || v === 'remote-only') return 'on'
  return 'unknown'
}

/** 'raw' when all three processors are off, 'partial' when any is on, otherwise 'unknown'. */
export function rawAudioStatus(ec: ProcessorState, ns: ProcessorState, agc: ProcessorState): RawAudioStatus {
  if (ec === 'on' || ns === 'on' || agc === 'on') return 'partial'
  if (ec === 'off' && ns === 'off' && agc === 'off') return 'raw'
  return 'unknown'
}

const PERMISSION_ERRORS: ReadonlySet<string> = new Set(['NotAllowedError', 'SecurityError', 'PermissionDeniedError'])
const NO_MIC_ERRORS: ReadonlySet<string> = new Set(['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'])
const BUSY_ERRORS: ReadonlySet<string> = new Set(['NotReadableError', 'TrackStartError', 'AbortError'])

/** The `name` of an Error / DOMException-like value, or null when it has none. */
function errorName(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const name = (err as { readonly name?: unknown }).name
  return typeof name === 'string' ? name : null
}

/**
 * Map a getUserMedia rejection to an ErrorCode by its name (current and legacy Chrome / Firefox
 * names): denied or blocked -> 'permission'; no device or impossible constraints -> 'noMic';
 * device in use or failed to start -> 'busy'; TypeError and anything unrecognised -> 'unsupported'.
 */
export function mapMicError(err: unknown): ErrorCode {
  const name = errorName(err)
  if (name === null) return 'unsupported'
  if (PERMISSION_ERRORS.has(name)) return 'permission'
  if (NO_MIC_ERRORS.has(name)) return 'noMic'
  if (BUSY_ERRORS.has(name)) return 'busy'
  return 'unsupported'
}

/** An open microphone and what the browser reported about it after the raw-audio request. */
export interface MicHandle {
  readonly stream: MediaStream
  readonly track: MediaStreamTrack
  readonly echoCancellation: ProcessorState
  readonly noiseSuppression: ProcessorState
  readonly autoGainControl: ProcessorState
  readonly rawAudio: RawAudioStatus
  /** Device label ('' when the browser hides it). */
  readonly deviceLabel: string
  /** Capture sample rate in Hz as reported by getSettings(), null when not reported. */
  readonly trackSampleRate: number | null
  readonly channelCount: number | null
}

/** Result of acquireMic: the open mic, or why it could not be opened. */
export type MicResult = { readonly ok: true; readonly mic: MicHandle } | { readonly ok: false; readonly code: ErrorCode }

interface ProcessorSettings {
  readonly echoCancellation: ProcessorState
  readonly noiseSuppression: ProcessorState
  readonly autoGainControl: ProcessorState
}

/** track.getSettings(), or {} when the method is missing or throws. */
function safeSettings(track: MediaStreamTrack): MediaTrackSettings {
  try {
    return typeof track.getSettings === 'function' ? track.getSettings() : {}
  } catch {
    return {}
  }
}

function readProcessors(s: MediaTrackSettings): ProcessorSettings {
  return {
    echoCancellation: processorState(s.echoCancellation),
    noiseSuppression: processorState(s.noiseSuppression),
    autoGainControl: processorState(s.autoGainControl),
  }
}

function anyOn(p: ProcessorSettings): boolean {
  return p.echoCancellation === 'on' || p.noiseSuppression === 'on' || p.autoGainControl === 'on'
}

/** A positive finite number, otherwise null. */
function positiveOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/**
 * Open the microphone with RAW_AUDIO_CONSTRAINTS and report what was applied. Call it from (or
 * soon after) a user gesture. 'unsupported' unless isSecureContext is true and
 * navigator.mediaDevices.getUserMedia exists. If getSettings() shows a processor still on, the constraints
 * are applied once more on the track (only Firefox reconfigures; Chromium just validates) and the
 * settings are re-read; applyConstraints errors are ignored. getUserMedia is called exactly once:
 * never a retry with default (processed) constraints. Never rejects.
 */
export async function acquireMic(): Promise<MicResult> {
  // Same rule as detectCapabilities().secureContext: only an explicit true counts as secure.
  if (globalThis.isSecureContext !== true) return { ok: false, code: 'unsupported' }
  const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
  if (typeof mediaDevices?.getUserMedia !== 'function') return { ok: false, code: 'unsupported' }

  let stream: MediaStream
  try {
    stream = await mediaDevices.getUserMedia({ audio: RAW_AUDIO_CONSTRAINTS })
  } catch (err) {
    return { ok: false, code: mapMicError(err) }
  }

  const track = stream.getAudioTracks()[0]
  if (track === undefined) {
    stopMic(stream)
    return { ok: false, code: 'noMic' }
  }

  let settings = safeSettings(track)
  let processors = readProcessors(settings)
  if (anyOn(processors) && typeof track.applyConstraints === 'function') {
    try {
      await track.applyConstraints(RAW_AUDIO_CONSTRAINTS)
    } catch {
      // Keep whatever the browser applied; the raw-audio badge reports it.
    }
    settings = safeSettings(track)
    processors = readProcessors(settings)
  }

  return {
    ok: true,
    mic: {
      stream,
      track,
      ...processors,
      rawAudio: rawAudioStatus(processors.echoCancellation, processors.noiseSuppression, processors.autoGainControl),
      deviceLabel: typeof track.label === 'string' ? track.label : '',
      trackSampleRate: positiveOrNull(settings.sampleRate),
      channelCount: positiveOrNull(settings.channelCount),
    },
  }
}

/** Diagnostics for the app state: the mic's report plus the AudioContext sample rate in Hz. */
export function toMicDiag(mic: MicHandle, contextSampleRate: number): MicDiag {
  return {
    echoCancellation: mic.echoCancellation,
    noiseSuppression: mic.noiseSuppression,
    autoGainControl: mic.autoGainControl,
    rawAudio: mic.rawAudio,
    deviceLabel: mic.deviceLabel,
    trackSampleRate: mic.trackSampleRate,
    contextSampleRate,
    channelCount: mic.channelCount,
  }
}

/** Stop every track of the stream (releases the mic and the browser's recording indicator). Never throws. */
export function stopMic(stream: MediaStream): void {
  let tracks: MediaStreamTrack[] = []
  try {
    tracks = stream.getTracks()
  } catch {
    return
  }
  for (const t of tracks) {
    try {
      t.stop()
    } catch {
      // Already stopped or detached.
    }
  }
}
