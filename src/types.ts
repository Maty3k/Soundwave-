/**
 * Types shared across modules. DSP modules (src/dsp) may import from here but never from DOM
 * or Web Audio code. Module-private state types (DetectorState, HuntState) live in their modules.
 */

// ---- Audio frames ------------------------------------------------------------------------------

/** One AnalyserNode snapshot, taken every config.hopMs. */
export interface Frame {
  /** Wall-clock time of the snapshot in ms (performance.now() in the app, synthetic in tests). */
  readonly tMs: number
  /**
   * Sanitised dB spectrum from getFloatFrequencyData, length fftSize / 2, bin k centred at k * binHz.
   * Never NaN or -Infinity (clamped to config.silentDb). Consumers must not mutate or retain it
   * beyond the current step unless they copy it.
   */
  readonly db: Float32Array
  /** Width of one bin in Hz (context sampleRate / fftSize). */
  readonly binHz: number
  /** Share of time-domain samples in the analysis window with |x| >= config.clipThreshold. */
  readonly clipFrac: number
  /** RMS of the analysis window in dBFS (config.silentDb for digital silence). */
  readonly rmsDb: number
  /** ms since the previous frame; 0 for the first frame after a (re)start. */
  readonly dtMs: number
  /** dtMs exceeded config.frameGapAbortMs: a timer stall; any open measurement must be discarded. */
  readonly gap: boolean
  /** The analysis window may contain one of the app's own Geiger clicks (diagnostic flag). */
  readonly clickTainted: boolean
}

// ---- Detection and lock ------------------------------------------------------------------------

/** A narrowband candidate found in one frame. */
export interface Peak {
  /** Integer bin of the local maximum. */
  readonly bin: number
  /** Parabolically interpolated bin position. */
  readonly binF: number
  readonly f0Hz: number
  /** Interpolated per-bin peak level. */
  readonly peakDb: number
  /** Per-bin local median floor around the peak. */
  readonly floorDb: number
  /** peakDb - floorDb. */
  readonly snrDb: number
  /** Contiguous bins above the width threshold. */
  readonly widthBins: number
  /** Power sum of config.bandBins bins nearest binF. */
  readonly bandDb: number
  /** bandDb - band floor (floorDb corrected to band power). */
  readonly bandSnrDb: number
}

/** One heard chirp (listening sighting or hunting segment). */
export interface Chirp {
  readonly tOnsetMs: number
  /** Time of the last frame above the offset threshold. */
  readonly tEndMs: number
  /** Apparent duration tEndMs - tOnsetMs (the analysis window smears short chirps). */
  readonly durationMs: number
  /** Maximum band level over the chirp (peak hold). */
  readonly peakDb: number
  /** Band noise reference measured just before the onset. */
  readonly bandFloorDb: number
  /** peakDb - bandFloorDb. */
  readonly snrDb: number
  /** Interpolated frequency at the loudest frame. */
  readonly f0Hz: number
  readonly clipped: boolean
  /** Share of the chirp's frames that were flagged clickTainted. */
  readonly taintedFrac: number
}

export type LockMode = 'chirp' | 'live'
export type LockReason = 'fast' | 'slow' | 'sustained'

export interface Lock {
  readonly f0Hz: number
  readonly mode: LockMode
  readonly reason: LockReason
  readonly tMs: number
  /** Best per-bin SNR seen while locking (for the Locked banner / debug). */
  readonly snrDb: number
  /** Sightings heard while listening; they become the first readings of the hunt, oldest first. */
  readonly chirps: readonly Chirp[]
}

// ---- Hunting -----------------------------------------------------------------------------------

export type Verdict = 'first' | 'warmer' | 'colder' | 'same' | 'max'

/** One reading = one chirp (or one merged group / live train) as the user sees it. */
export interface Reading {
  readonly id: number
  readonly tMs: number
  /** Peak band level of the reading. */
  readonly levelDb: number
  readonly snrDb: number
  readonly verdict: Verdict
  /** levelDb minus the previous reading's levelDb; null for the first reading. */
  readonly deltaPrevDb: number | null
  /** 0..100 position within the auto range; null for the first reading. 100 when clipped. */
  readonly pct: number | null
  /** Beat the previous best (never true for the first reading). */
  readonly isNewBest: boolean
  readonly clipped: boolean
  /** Chirps merged into this reading (double chirps, bursts, live trains). */
  readonly chirpCount: number
  /** Chirps estimated to have been missed between the previous reading and this one. */
  readonly missedBefore: number
  readonly source: 'chirp' | 'train'
}

export type CountdownKind = 'unknown' | 'eta' | 'hold' | 'late' | 'overdue' | 'lost'

export interface Countdown {
  readonly kind: CountdownKind
  /** Seconds until the expected chirp (negative once it is late); null without a confident interval. */
  readonly etaS: number | null
  /** Seconds since the last reading started; null before the first reading. */
  readonly sinceLastS: number | null
  /** Median interval in seconds when known (confident or not); null before two readings. */
  readonly intervalS: number | null
  readonly confident: boolean
}

export interface LiveView {
  /** Held (2 s max) band level. */
  readonly levelDb: number
  readonly pct: number | null
  /** Verdict vs the held level config.liveRefMs earlier; null until enough history. */
  readonly verdict: Exclude<Verdict, 'first'> | null
  readonly deltaDb: number | null
  readonly clipped: boolean
}

/** Snapshot of the hunt for the UI and the feedback (clicks, haptics). Plain data. */
export interface HuntView {
  readonly mode: LockMode
  readonly f0Hz: number
  /** Most recent last, at most config.readingsKept. */
  readonly readings: readonly Reading[]
  readonly last: Reading | null
  readonly bestDb: number | null
  /**
   * 0..1 drives the click rate and haptic tier; null = no feedback yet
   * (chirp mode with fewer than two readings).
   */
  readonly warmth: number | null
  /** null in live mode. */
  readonly countdown: Countdown | null
  /** Clicks and haptics must be silent (hold window or a chirp in progress). */
  readonly holdActive: boolean
  /** The beep is being heard right now (band SNR above the onset threshold). */
  readonly hearing: boolean
  readonly live: LiveView | null
  /** Current frame measurements, for the debug view. */
  readonly levelDb: number
  readonly bandFloorDb: number
  readonly snrDb: number
  readonly missedChirps: number
  /** Last raw chirps (debug), most recent last. */
  readonly chirps: readonly Chirp[]
}

export type HuntEvent =
  | { readonly type: 'onset' }
  | { readonly type: 'reading'; readonly reading: Reading }
  | { readonly type: 'readingUpdated'; readonly reading: Reading }
  | { readonly type: 'mode'; readonly mode: LockMode }
  /** An open chirp was discarded because of a frame gap. */
  | { readonly type: 'missed' }

// ---- Microphone and platform -------------------------------------------------------------------

/** What getSettings() reported for one audio processor: false -> 'off', true -> 'on', missing -> 'unknown'. */
export type ProcessorState = 'off' | 'on' | 'unknown'

/** 'raw' = all three processors reported off; 'partial' = at least one on; 'unknown' = none on, some unreported. */
export type RawAudioStatus = 'raw' | 'partial' | 'unknown'

export interface MicDiag {
  readonly echoCancellation: ProcessorState
  readonly noiseSuppression: ProcessorState
  readonly autoGainControl: ProcessorState
  readonly rawAudio: RawAudioStatus
  readonly deviceLabel: string
  readonly trackSampleRate: number | null
  readonly contextSampleRate: number
  readonly channelCount: number | null
}

export type ErrorCode = 'permission' | 'noMic' | 'busy' | 'unsupported'

export interface Capabilities {
  readonly secureContext: boolean
  readonly getUserMedia: boolean
  readonly audioContext: boolean
  readonly wakeLock: boolean
  /** Vibration API present on a touch device (in practice Chrome on Android). */
  readonly haptics: boolean
}

export interface Settings {
  readonly clicks: boolean
  readonly haptics: boolean
}

// ---- App state machine -------------------------------------------------------------------------

export type PausedFrom = 'listening' | 'locked' | 'hunting'

export type Screen =
  | { readonly kind: 'idle' }
  | { readonly kind: 'requesting'; readonly sinceMs: number }
  | { readonly kind: 'listening'; readonly sinceMs: number }
  | { readonly kind: 'locked'; readonly sinceMs: number }
  | { readonly kind: 'hunting' }
  | { readonly kind: 'paused'; readonly from: PausedFrom; readonly needsGesture: boolean }
  | { readonly kind: 'error'; readonly code: ErrorCode }

export interface Toast {
  readonly text: string
  readonly untilMs: number
}

export interface AppState {
  readonly screen: Screen
  readonly nowMs: number
  readonly settings: Settings
  readonly caps: Capabilities
  readonly mic: MicDiag | null
  /** 0..1 mic-alive bar. */
  readonly micLevel: number
  readonly lock: Lock | null
  readonly hunt: HuntView | null
  readonly toast: Toast | null
  readonly confirmStop: boolean
  readonly wakeLockFailed: boolean
  readonly debug: boolean
}

export type AppEvent =
  | { readonly type: 'start'; readonly nowMs: number }
  | { readonly type: 'micReady'; readonly mic: MicDiag; readonly nowMs: number }
  | { readonly type: 'micError'; readonly code: ErrorCode }
  | { readonly type: 'tick'; readonly nowMs: number; readonly micLevel?: number }
  | { readonly type: 'lock'; readonly lock: Lock; readonly nowMs: number }
  | { readonly type: 'confirmLock' }
  | { readonly type: 'notIt'; readonly nowMs: number }
  | { readonly type: 'hunt'; readonly view: HuntView }
  | { readonly type: 'relisten'; readonly nowMs: number }
  | { readonly type: 'resetBest' }
  | { readonly type: 'stopRequest' }
  | { readonly type: 'stopConfirm' }
  | { readonly type: 'stopCancel' }
  | { readonly type: 'hidden' }
  | { readonly type: 'visible'; readonly healthy: boolean }
  | { readonly type: 'micLost' }
  | { readonly type: 'resumed' }
  | { readonly type: 'retry'; readonly nowMs: number }
  | { readonly type: 'back' }
  | { readonly type: 'toast'; readonly text: string; readonly nowMs: number }
  | { readonly type: 'settings'; readonly patch: Partial<Settings> }
  | { readonly type: 'wakeLockFailed' }
