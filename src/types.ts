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
/** fast: one strong chirp (lockConfirmChirps 1); slow: confirmed by a second chirp; sustained: continuous tone; manual: 'Use it now'. */
export type LockReason = 'fast' | 'slow' | 'sustained' | 'manual'

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

/** A beep heard while listening that still waits for confirmation (lockConfirmChirps). */
export interface PendingBeep {
  readonly f0Hz: number
  /** Best per-bin SNR of its sightings. */
  readonly snrDb: number
  /** Time (ms, app clock) of the latest sighting. */
  readonly heardAtMs: number
  /** Sightings so far (1 while waiting for the confirming chirp). */
  readonly sightings: number
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

// ---- Log ---------------------------------------------------------------------------------------

/** One line of the hunt log: a reading plus the user's own note (e.g. where they stood). */
export interface LogEntry {
  /** The reading's id (a merged chirp group updates its entry in place). */
  readonly id: number
  /** Wall-clock time of the reading (epoch ms), for display. */
  readonly wallMs: number
  readonly verdict: Verdict
  readonly deltaPrevDb: number | null
  readonly pct: number | null
  readonly levelDb: number
  readonly f0Hz: number
  readonly clipped: boolean
  readonly chirpCount: number
  readonly source: 'chirp' | 'train'
  /** Name of the listener that heard this chirp loudest (stations / extra mics), if known. */
  readonly loudest: string | null
  /** Free text typed by the user; kept when the entry is updated. */
  readonly note: string
}

// ---- Listeners: extra microphones on this device and stations on other devices ----------------

/** self: this device's main mic (runs the hunt); mic: another mic on this device; station: another device. */
export type ListenerKind = 'self' | 'mic' | 'station'
export type ListenerStatus = 'connecting' | 'listening' | 'lost'

export interface ListenerView {
  readonly id: string
  readonly name: string
  readonly kind: ListenerKind
  readonly status: ListenerStatus
  /** Calibrated level of this listener's report for the latest compared chirp (or live held level). */
  readonly levelDb: number | null
  /** levelDb minus the loudest listener's level in the same comparison (0 for the loudest). */
  readonly deltaDb: number | null
  readonly isLoudest: boolean
  /** Calibration offset added to this listener's raw levels. */
  readonly offsetDb: number
  /** App-clock time of the last message / report from this listener. */
  readonly lastSeenMs: number | null
}

export interface ComparisonEntry {
  readonly id: string
  readonly name: string
  /** Calibrated level. */
  readonly levelDb: number
  readonly clipped: boolean
}

/** Every listener's report for one chirp, loudest first. */
export interface Comparison {
  /** The hub's reading id this comparison belongs to (null in live mode). */
  readonly readingId: number | null
  readonly tMs: number
  readonly ranking: readonly ComparisonEntry[]
  /** Named only when it beats the second by config.compareMinMarginDb. */
  readonly loudestId: string | null
  readonly marginDb: number | null
}

export type PairStep = 'idle' | 'preparing' | 'showOffer' | 'scanAnswer' | 'pasteAnswer' | 'connecting' | 'error'

export interface PairingView {
  readonly step: PairStep
  /** Compact offer code shown as QR and text while step is showOffer / scanAnswer / pasteAnswer. */
  readonly offerCode: string | null
  readonly message: string | null
  /** This device can scan QR codes with its camera (BarcodeDetector, or the bundled decoder). */
  readonly canScan: boolean
}

/** Hub side: everything the Stations panel shows. */
export interface StationsView {
  /** 'self' first, then extra mics, then stations. */
  readonly listeners: readonly ListenerView[]
  /** Other microphones on this device that can be added (after mic permission, labels are known). */
  readonly availableMics: readonly { readonly deviceId: string; readonly label: string }[]
  readonly pairing: PairingView
  readonly comparison: Comparison | null
  /** Waiting for a chirp heard by every listener, to equalise their levels. */
  readonly calibrating: boolean
}

export type StationStep =
  | 'name'
  | 'starting'
  | 'scanOffer'
  | 'pasteOffer'
  | 'answering'
  | 'showAnswer'
  | 'connected'
  | 'lost'
  | 'error'

/** Station side: the screen of a device used as a listening station. */
export interface StationModeView {
  readonly step: StationStep
  readonly name: string
  /** Compact answer code to show to the hub (QR + text) while step is showAnswer. */
  readonly answerCode: string | null
  /** Frequency the hub asked this station to listen to (null until the hub has a lock). */
  readonly f0Hz: number | null
  /** Current band level at f0 (0..1 for the bar), and the last chirp's level in dB. */
  readonly level: number
  readonly lastChirpDb: number | null
  readonly lastChirpAtMs: number | null
  readonly chirpsSent: number
  readonly message: string | null
  readonly canScan: boolean
}

// ---- Found it ---------------------------------------------------------------------------------

/** A log note shown on the Found it screen ("where you were"). */
export interface FoundNote {
  readonly wallMs: number
  readonly note: string
  readonly verdict: Verdict
  readonly pct: number | null
}

/** Summary of a finished hunt, built by main.ts when the user taps Found it. Plain data. */
export interface FoundSummary {
  /** Epoch ms when Found it was tapped. */
  readonly foundAtWallMs: number
  /**
   * Epoch ms the hunt began: its first reading (the chirps heard while locking) or the lock,
   * whichever came first. A continuous tone logs no reading until a stretch of tone ends, so there
   * the lock is the start. Null if neither is known.
   */
  readonly startedAtWallMs: number | null
  readonly f0Hz: number | null
  readonly mode: LockMode | null
  /** Readings in this hunt (not the whole session log). */
  readonly readings: number
  readonly bestLevelDb: number | null
  /** Notes the user typed in this hunt's log entries, oldest first (entries without a note are left out). */
  readonly notes: readonly FoundNote[]
  /** Listener that heard the last compared chirp loudest (stations / extra mics), if one was named. */
  readonly loudestListener: string | null
  /** Listeners that took part, including this device (1 without stations or extra mics). */
  readonly listeners: number
}

/** A hunt that ended with Found it, kept under Past hunts on this device only (history.ts). */
export interface HuntRecord {
  /** Unique in the history: epoch ms of the hunt's first Found it (bumped past a clash). */
  readonly id: number
  /** The person's name for it ('Hallway smoke alarm'); '' until they give one. */
  readonly label: string
  /** As of the hunt's last Found it (Keep hunting and Found it again updates it). */
  readonly summary: FoundSummary
}

/** Which panel the hunting screen shows under the verdict. */
export type HuntPanel = 'meter' | 'direction' | 'log' | 'stations'

// ---- Direction scan (radar) --------------------------------------------------------------------

/**
 * needMore: too few directions measured; unclear: measured, but loud and quiet sides differ too
 * little; rough / clear: a direction is shown, with clear meaning a bigger difference and no gaps.
 */
export type RadarQuality = 'needMore' | 'unclear' | 'rough' | 'clear'

export interface RadarSector {
  /** Compass heading (degrees clockwise, in the sensor's frame) at the centre of the sector. */
  readonly centerDeg: number
  /** Power-mean level of the samples in this sector; null when not measured. */
  readonly levelDb: number | null
  readonly samples: number
}

export interface RadarView {
  /** 'chirp': one sample per chirp, coarse sectors; 'live': continuous sampling, fine sectors. */
  readonly mode: LockMode
  readonly sectors: readonly RadarSector[]
  /** Heading of the loudest direction; null unless quality is 'rough' or 'clear'. */
  readonly bearingDeg: number | null
  /** Loudest minus quietest measured sector; null with fewer than two sectors. */
  readonly contrastDb: number | null
  readonly quality: RadarQuality
  /** Samples taken so far (chirps in chirp mode, frames in live mode). */
  readonly samples: number
  /** Largest angular gap between measured sector centres; null before any sample. */
  readonly maxGapDeg: number | null
  /** Where to face next: the middle of the largest unmeasured gap; null when nothing is missing. */
  readonly suggestDeg: number | null
  /** The device's current heading; null without a compass reading. */
  readonly headingDeg: number | null
}

/** off: not scanning; starting: waiting for the first compass reading; unavailable / denied: no compass. */
export type ScanStatus = 'off' | 'starting' | 'active' | 'unavailable' | 'denied'

export interface ScanState {
  /** The scan panel is shown (replaces the meter while hunting). */
  readonly open: boolean
  readonly status: ScanStatus
  readonly radar: RadarView | null
}

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
  /** DeviceOrientation API on a touch device: a compass may be available for the direction scan. */
  readonly compass: boolean
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
  /** held: the user touched the screen, so it no longer advances to hunting on its own. */
  | { readonly kind: 'locked'; readonly sinceMs: number; readonly held?: boolean }
  | { readonly kind: 'hunting' }
  | { readonly kind: 'paused'; readonly from: PausedFrom; readonly needsGesture: boolean }
  | { readonly kind: 'error'; readonly code: ErrorCode }
  /** This device is a listening station for another device's hunt. */
  | { readonly kind: 'station' }
  /**
   * The hunt ended with Found it: a summary; audio is paused, the hunt can be resumed. micOff: the
   * microphones were closed after foundMicOffMs on this screen (Keep hunting opens them again).
   */
  | { readonly kind: 'found'; readonly micOff?: boolean }

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
  /** Direction scan (radar) while hunting. */
  readonly scan: ScanState
  /** A beep heard while listening, waiting for a confirming chirp. */
  readonly pending: PendingBeep | null
  /** Hunting screen panel under the verdict. */
  readonly panel: HuntPanel
  /** Hunt log, oldest first (at most config.logMaxEntries). */
  readonly log: readonly LogEntry[]
  /** Hub side: extra mics and stations (null until the hunt has one or the panel was opened). */
  readonly stations: StationsView | null
  /** Station side: present while screen.kind is 'station'. */
  readonly stationMode: StationModeView | null
  /** Present while screen.kind is 'found'. */
  readonly found: FoundSummary | null
  /** The history record of the hunt on the Found it screen (its name is edited there). */
  readonly foundRecordId: number | null
  /** Past hunts on this device, newest first (main loads and saves them; history.ts). */
  readonly history: readonly HuntRecord[]
}

export type AppEvent =
  | { readonly type: 'start'; readonly nowMs: number }
  | { readonly type: 'micReady'; readonly mic: MicDiag; readonly nowMs: number }
  | { readonly type: 'micError'; readonly code: ErrorCode }
  | { readonly type: 'tick'; readonly nowMs: number; readonly micLevel?: number }
  | { readonly type: 'lock'; readonly lock: Lock; readonly nowMs: number }
  | { readonly type: 'confirmLock' }
  /** The user interacted with the locked screen: stop the automatic advance. */
  | { readonly type: 'holdLock' }
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
  | { readonly type: 'scanOpen' }
  | { readonly type: 'scanStatus'; readonly status: ScanStatus }
  | { readonly type: 'radar'; readonly view: RadarView }
  | { readonly type: 'scanClose' }
  | { readonly type: 'pending'; readonly pending: PendingBeep | null }
  | { readonly type: 'panel'; readonly panel: HuntPanel }
  | { readonly type: 'logUpsert'; readonly entry: LogEntry }
  | { readonly type: 'logNote'; readonly id: number; readonly note: string }
  | { readonly type: 'stations'; readonly view: StationsView | null }
  /** Landing -> station screen (this device becomes a station). */
  | { readonly type: 'stationStart' }
  | { readonly type: 'stationView'; readonly view: StationModeView }
  | { readonly type: 'stationStop' }
  /** hunting -> found (keeps lock, hunt, log and stations so Keep hunting can resume). */
  | { readonly type: 'found'; readonly summary: FoundSummary; readonly recordId?: number }
  /** The past hunts changed (loaded at start, a hunt found, renamed or removed). */
  | { readonly type: 'history'; readonly history: readonly HuntRecord[] }
  /** found -> hunting. */
  | { readonly type: 'keepHunting' }
  /** found -> idle (the session is over; the log is cleared like after Stop). */
  | { readonly type: 'foundDone' }
  /** found -> found with micOff (main.ts closed the microphones after foundMicOffMs). */
  | { readonly type: 'foundMicOff' }
