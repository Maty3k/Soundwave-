/**
 * Every user-facing string, plus the pure formatters that turn numbers and hunt state into text.
 * Field tuning may change this file and config.ts only. No DOM access here.
 *
 * Conventions: short sentences, no jargon on the main screens, ASCII apostrophes, a real
 * ellipsis (…) and a real minus sign (−, U+2212) in signed numbers.
 */
import type {
  AppState,
  Chirp,
  Countdown,
  ErrorCode,
  FoundSummary,
  HuntPanel,
  HuntRecord,
  HuntView,
  Lock,
  LockMode,
  LogEntry,
  MicDiag,
  PendingBeep,
  RadarView,
  Reading,
  ScanState,
  Verdict,
} from './types.ts'
import { direction8, relativeBearing, type Direction8 } from './dsp/radar.ts'
import type { Comparison, ComparisonEntry, ListenerKind, ListenerStatus, ListenerView, StationStep } from './types.ts'

/** Real minus sign (U+2212) used by every signed number on the main screens. */
export const MINUS = '\u2212'

/** Placeholder (en dash) for a number that is not known yet. */
export const NO_VALUE = '\u2013'

/** Static strings, grouped by screen. */
export const COPY = {
  appName: 'Soundwave',
  tagline: 'Follow the beep.',
  landing: {
    lead: 'Find that mystery chirp. Walk around and Soundwave tells you if you are getting warmer or colder.',
    steps: [
      { title: 'Listen', text: 'it locks onto the beep.' },
      { title: 'Move', text: 'walk between chirps, freeze during them.' },
      { title: 'Follow', text: 'warmer means closer.' },
    ],
    privacy: 'No audio leaves your device: it is analysed live in your browser and never recorded or uploaded.',
    start: 'Start listening',
    caption: 'Your browser will ask to use the microphone.',
    station: 'Use this device as a station',
    stationHint: 'Leave it in another room to help the main phone compare.',
  },
  requesting: {
    title: 'Allow microphone access',
    body: 'Choose Allow when your browser asks.',
    /** Desktop wording; see PERMISSION_HELP for touch and installed-app variants. */
    hint: "Don't see a prompt? Look for the microphone icon next to the address bar.",
    cancel: 'Cancel',
  },
  listening: {
    title: 'Listening for the beep…',
    tip: 'Stay quiet and still. Heard the beep? Tap I heard it within 10 seconds.',
    noBeep: 'No beep yet. Move to where you last heard it, turn off fans or the TV, and wait for the next chirp.',
    micLabel: 'Mic',
    elapsedLabel: 'Elapsed',
    useNow: 'Use it now',
    /** Looks back 10 s for the beep the person just heard and locks on it. */
    heardIt: 'I heard it',
    stop: 'Stop',
  },
  rawAudio: {
    partial: 'Your browser kept audio processing on. Readings may be less reliable; Chrome or Firefox give the best results.',
    unknown: "Couldn't verify the audio settings. Readings may be less reliable.",
  },
  locked: {
    banner: 'Locked on',
    continuous: 'Continuous tone',
    startHunting: 'Start hunting',
    auto: 'Starting automatically…',
    notIt: 'Wrong sound? Listen again',
  },
  hunting: {
    title: 'Hunting for the beep',
    /** Counts a beep the filters set aside in the last 10 s. */
    heardIt: 'I heard the beep',
    modeChirp: 'Chirp',
    modeLive: 'Live',
    frequencyLabel: 'Locked frequency',
    modeLabel: 'Mode',
    clicks: 'Clicks',
    haptics: 'Vibrate',
    on: 'On',
    off: 'Off',
    waiting: 'LISTENING',
    scanning: 'SCANNING',
    newBest: 'New best!',
    startingPoint: 'Your starting point',
    meterLabel: 'Warmth',
    max: 'MAX',
    meterEmpty: 'The meter starts with the next chirp.',
    meterWarmup: 'Warming up…',
    scaleCold: 'Cold',
    scaleHot: 'Hot',
    scaleBest: 'Best',
    hearing: 'Hearing it',
    notHearing: "Can't hear the tone right now",
    history: 'Recent readings',
    resetBest: 'Start over here',
    relisten: 'Listen again',
    /** Ends the hunt with the Found it summary (the positive action of the bottom bar). */
    found: 'Found it',
    stop: 'Stop',
    tabsLabel: 'Hunting views',
    tabs: {
      meter: 'Meter',
      direction: 'Direction',
      log: 'Log',
      stations: 'Stations',
    } satisfies Record<HuntPanel, string>,
  },
  paused: {
    title: 'Paused',
    body: 'Soundwave stops listening when you leave the app or the screen locks.',
    kept: 'Your readings are kept.',
    resume: 'Resume',
    resuming: 'Resuming…',
    stop: 'Stop',
  },
  stopConfirm: {
    title: 'Stop hunting? Your readings will be cleared.',
    stop: 'Stop',
    keepGoing: 'Keep going',
  },
  relistenConfirm: {
    title: 'Listen again? Your readings will be cleared.',
    confirm: 'Listen again',
    keepGoing: 'Keep going',
  },
  toasts: {
    wakeLock: 'Your screen may go dark while hunting. Tap it now and then to keep it on.',
    live: 'Continuous tone. Switched to the live meter.',
    chirp: 'Back to chirp mode.',
    linkCopied: 'Link copied.',
    linkCopyFailed: "Couldn't copy the link. Copy it from the address bar.",
    resetBest: 'Cleared. The next chirp is your new starting point.',
    stillBlocked: 'Still blocked. Change the setting first, then tap Try again.',
    codeCopied: 'Code copied. Paste it on the other device.',
    codeCopyFailed: "Couldn't copy the code. Select it and copy it by hand.",
    micAddFailed: "Couldn't open that microphone. It may be in use or unplugged.",
    stationMicFailed: "Couldn't open the microphone, so this device can't be a station.",
  },
  errorActions: {
    retry: 'Try again',
    reload: 'Reload page',
    back: 'Back',
    copyLink: 'Copy link',
  },
  debug: {
    title: 'Debug',
  },
} as const

/** Toast texts that main.ts dispatches (aliases of COPY.toasts). */
export const TEXT = {
  /** "I heard it" while listening found no steady tone in the last 10 s. */
  heardNothingListening: 'Nothing clear in the last 10 seconds. Tap right after the next beep.',
  /** "I heard the beep" while hunting: a set-aside sound became a reading. */
  heardCounted: 'Counted it.',
  /** ... a reading had already started in the last 10 s. */
  heardAlready: 'Already counted.',
  /** ... nothing at the beep's pitch in the last 10 s. */
  heardNothingHunting: "Didn't catch a beep at this pitch in the last 10 seconds. It may be too faint here.",
  wakeLockFailed: COPY.toasts.wakeLock,
  modeLive: COPY.toasts.live,
  modeChirp: COPY.toasts.chirp,
  linkCopied: COPY.toasts.linkCopied,
  linkCopyFailed: COPY.toasts.linkCopyFailed,
  /** After 'Start over here' (onResetBest). */
  resetBest: COPY.toasts.resetBest,
  /** When Try again ends in 'permission' again within about 1.5 s. */
  stillBlocked: COPY.toasts.stillBlocked,
  /** Copy code / Share fallback in pairing. */
  codeCopied: COPY.toasts.codeCopied,
  codeCopyFailed: COPY.toasts.codeCopyFailed,
  /** Adding an extra microphone failed. */
  micAddFailed: COPY.toasts.micAddFailed,
  /** Station mode could not open the microphone. */
  stationMicFailed: COPY.toasts.stationMicFailed,
} as const

/** Recovery action offered on an error card. */
export type ErrorAction = 'retry' | 'reload' | 'back' | 'copyLink'

/** Heading, body and recovery actions (primary first) for each microphone error. */
export const ERROR_COPY: Record<ErrorCode, { heading: string; body: string; actions: readonly ErrorAction[] }> = {
  permission: {
    heading: 'Microphone blocked',
    /** Desktop wording; see PERMISSION_HELP for touch and installed-app variants. */
    body:
      'Soundwave needs the microphone to hear the beep. ' +
      'Click the icon next to the address bar, allow the microphone for this site, then try again.',
    actions: ['retry', 'reload'],
  },
  noMic: {
    heading: 'No microphone found',
    body: 'Plug in or enable a microphone and try again. On a laptop, check the system sound settings.',
    actions: ['retry'],
  },
  busy: {
    heading: 'Microphone is busy',
    body: 'Another app or tab may be using it. Close it and try again.',
    actions: ['retry'],
  },
  unsupported: {
    heading: "This browser can't use the microphone here",
    body:
      'Open Soundwave in Chrome, Firefox or Safari over https (or on localhost). ' +
      'If you opened this link inside another app, use its menu to open it in your browser.',
    actions: ['copyLink', 'back'],
  },
}

/**
 * Where Soundwave runs, for instructions that depend on it: an installed app (no address bar),
 * a touch browser, or a desktop browser. ui.ts picks it with matchMedia.
 */
export type Platform = 'standalone' | 'touch' | 'desktop'

/** How to allow a blocked microphone (error card body) and where the prompt is (requesting hint). */
export const PERMISSION_HELP: Record<Platform, { readonly body: string; readonly hint: string }> = {
  standalone: {
    body:
      'Soundwave needs the microphone to hear the beep. Open Chrome, tap ⋮ › Settings › Site settings › Microphone ' +
      'and allow this site. Then come back and tap Try again.',
    hint: "Don't see a prompt? Open Chrome, tap ⋮ › Settings › Site settings › Microphone and allow this site.",
  },
  touch: {
    body:
      'Soundwave needs the microphone to hear the beep. Tap the icon at the left of the address bar, open ' +
      'Permissions and turn on Microphone. Then tap Try again. Nothing is recorded.',
    hint: "Don't see a prompt? Tap the icon at the left of the address bar and allow the microphone.",
  },
  desktop: {
    body: ERROR_COPY.permission.body,
    hint: COPY.requesting.hint,
  },
}

/** Error card body for this platform (only the permission error depends on it). */
export function errorBody(code: ErrorCode, platform: Platform): string {
  return code === 'permission' ? PERMISSION_HELP[platform].body : ERROR_COPY[code].body
}

// ---- Number formatters ---------------------------------------------------------------------------

/** Round half away from zero (so +2.5 and -2.5 both move outwards) and never return -0. */
function roundSym(x: number): number {
  const r = Math.sign(x) * Math.round(Math.abs(x))
  return r === 0 ? 0 : r
}

/** Integer with a comma every three digits, independent of the runtime locale. */
function groupThousands(n: number): string {
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return n < 0 ? MINUS + digits : digits
}

/** Frequency in Hz, rounded, with a comma thousands separator: 3120.4 -> '3,120 Hz'. */
export function formatHz(hz: number): string {
  if (!Number.isFinite(hz)) return `${NO_VALUE} Hz`
  return `${groupThousands(roundSym(hz))} Hz`
}

/** Whole seconds (floored) as 'm:ss'; minutes are not capped at 59; negative or non-finite input reads '0:00'. */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s < 10 ? '0' : ''}${s}`
}

/** Signed level change in whole dB, rounded half away from zero: '+4 dB', '−3 dB' (U+2212), '0 dB'. */
export function formatDelta(db: number): string {
  if (!Number.isFinite(db)) return `${NO_VALUE} dB`
  const r = roundSym(db)
  if (r === 0) return '0 dB'
  return `${r > 0 ? '+' : MINUS}${Math.abs(r)} dB`
}

/** 0..100 meter position as a whole number (clamped), or the placeholder when unknown. */
export function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return NO_VALUE
  return String(Math.round(Math.min(100, Math.max(0, pct))))
}

// ---- Verdicts and readings -----------------------------------------------------------------------

/**
 * Hero words. 'SAME' rather than 'ABOUT THE SAME' or 'NO CHANGE': every label must fit one line at
 * the hero size on a 360 px phone; the sub-line qualifies it.
 */
const VERDICT_LABELS: Record<Verdict, string> = {
  first: 'FIRST READING',
  warmer: 'WARMER',
  colder: 'COLDER',
  same: 'SAME',
  max: 'VERY HOT',
}

/** The same verdicts as spoken by a screen reader (sentence case reads better than capitals). */
const VERDICT_SPOKEN: Record<Verdict, string> = {
  first: 'First reading',
  warmer: 'Warmer',
  colder: 'Colder',
  same: 'About the same',
  max: 'Very hot',
}

/** Big verdict word shown in the hunting hero. */
export function verdictLabel(verdict: Verdict): string {
  return VERDICT_LABELS[verdict]
}

/** Hero word for a hunt view: the last reading's verdict (chirp mode) or the live verdict; LISTENING before either exists. */
export function heroLabel(view: HuntView | null): string {
  if (view === null) return COPY.hunting.waiting
  if (view.mode === 'live') return view.live?.verdict ? verdictLabel(view.live.verdict) : COPY.hunting.waiting
  return view.last ? verdictLabel(view.last.verdict) : COPY.hunting.waiting
}

/**
 * What a screen reader says for a new chirp reading: the verdict, the meter position and a new
 * best, e.g. 'Warmer. 92 of 100. New best.'; the first reading is the starting point.
 */
export function readingAnnouncement(reading: Reading): string {
  if (reading.verdict === 'first') return `${VERDICT_SPOKEN.first}. ${COPY.hunting.startingPoint}.`
  const parts: string[] = [VERDICT_SPOKEN[reading.verdict]]
  if (reading.pct !== null && Number.isFinite(reading.pct)) parts.push(`${formatPct(reading.pct)} of 100`)
  if (reading.isNewBest) parts.push('New best')
  return `${parts.join('. ')}.`
}

/** What a screen reader says for a settled live-mode verdict, e.g. 'Colder.'. */
export function liveAnnouncement(verdict: Verdict): string {
  return `${VERDICT_SPOKEN[verdict]}.`
}

/** Sub-line under a chirp verdict: '+4 dB vs last', 'Same as last spot', or the starting-point note. */
export function deltaLine(reading: Reading): string {
  if (reading.deltaPrevDb === null) return COPY.hunting.startingPoint
  const text = formatDelta(reading.deltaPrevDb)
  return text === '0 dB' ? 'Same as last spot' : `${text} vs last`
}

/** Sub-line under the live verdict: '+4 dB vs 3 s ago' or 'Same as 3 s ago' (refMs = config.liveRefMs); empty without a reference. */
export function liveDeltaLine(deltaDb: number | null, refMs: number): string {
  if (deltaDb === null) return ''
  const ago = `${Math.round(refMs / 1000)} s ago`
  const text = formatDelta(deltaDb)
  return text === '0 dB' ? `Same as ${ago}` : `${text} vs ${ago}`
}

/** History marker: ★ new best, ▲ warmer or clipped (very hot), ▼ colder, = about the same, • first reading. */
export function historyMarker(reading: Reading): string {
  if (reading.isNewBest) return '★'
  switch (reading.verdict) {
    case 'warmer':
    case 'max':
      return '▲'
    case 'colder':
      return '▼'
    case 'same':
      return '='
    case 'first':
      return '•'
  }
}

/** Visible history item 'pct marker', e.g. '72 ▲'; the first reading (no percent yet) reads 'Start'. */
export function historyItemText(reading: Reading): string {
  if (reading.verdict === 'first') return 'Start'
  return `${formatPct(reading.pct)} ${historyMarker(reading)}`
}

/** Screen-reader label for one history item, e.g. '72 of 100, warmer, new best'. */
export function historyItemLabel(reading: Reading): string {
  if (reading.verdict === 'first') return 'first reading, your starting point'
  const parts = [
    reading.pct === null ? 'no percent' : `${formatPct(reading.pct)} of 100`,
    VERDICT_SPOKEN[reading.verdict].toLowerCase(),
  ]
  if (reading.isNewBest) parts.push('new best')
  return parts.join(', ')
}

/** aria-valuetext of the heat meter, e.g. '72 of 100, previous 55'. */
export function meterValueText(pct: number | null, prevPct: number | null, clipped: boolean): string {
  if (pct === null) return 'No reading yet'
  let text = `${formatPct(pct)} of 100`
  if (clipped) text += ', maximum'
  if (prevPct !== null) text += `, previous ${formatPct(prevPct)}`
  return text
}

/** Locked banner detail: 'Heard 1 chirp', 'Heard 2 chirps', or 'Continuous tone' for a live lock. */
export function heardText(lock: Lock): string {
  if (lock.mode === 'live') return COPY.locked.continuous
  const n = Math.max(1, lock.chirps.length)
  return `Heard ${n} ${n === 1 ? 'chirp' : 'chirps'}`
}

/** Badge text for a microphone whose processing could not be verified as off; null when raw (or no mic). */
export function rawAudioText(mic: MicDiag | null): string | null {
  if (mic === null || mic.rawAudio === 'raw') return null
  return mic.rawAudio === 'partial' ? COPY.rawAudio.partial : COPY.rawAudio.unknown
}

// ---- Listening: a beep waiting for confirmation --------------------------------------------------

/** Main line of the listening screen's pending card: 'Heard a beep at 3,120 Hz. Waiting for it again to confirm…'. */
export function pendingText(pending: PendingBeep): string {
  return `Heard a beep at ${formatHz(pending.f0Hz)}. Waiting for it again to confirm…`
}

/** How often and how long ago: 'Heard once, just now', 'Heard 2 times, 40 s ago', 'Heard once, 3 min ago'. */
export function pendingSightingsText(sightings: number, agoS: number): string {
  const n = Number.isFinite(sightings) ? Math.max(1, Math.round(sightings)) : 1
  const count = n === 1 ? 'once' : `${n} times`
  const s = Number.isFinite(agoS) && agoS > 0 ? Math.floor(agoS) : 0
  const ago = s < 5 ? 'just now' : s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`
  return `Heard ${count}, ${ago}`
}

// ---- Hunting tabs --------------------------------------------------------------------------------

/**
 * Screen-reader text of a tab's count badge: '4 readings' (Log), '2 listening' (Stations).
 * The visible badge shows only the number.
 */
export function tabBadgeLabel(panel: 'log' | 'stations', n: number): string {
  if (panel === 'log') return `${n} ${n === 1 ? 'reading' : 'readings'}`
  return `${n} listening`
}

/** Accessible name of a hunting tab: its label, plus the badge when it shows a count ('Log, 4 readings'). */
export function tabName(panel: HuntPanel, n: number): string {
  const label = COPY.hunting.tabs[panel]
  if ((panel !== 'log' && panel !== 'stations') || !(n > 0)) return label
  return `${label}, ${tabBadgeLabel(panel, n)}`
}

// ---- Countdown and guidance ----------------------------------------------------------------------

/** Between readings without a confident interval: say what to do (move now), not how long it has been. */
function waitingText(sinceLastS: number | null): string {
  return sinceLastS === null ? 'Waiting for the first chirp…' : 'Move 2–3 m now, then hold still for the next chirp.'
}

/**
 * The status line under the verdict: what to do right now. Between chirps it says to move (with
 * the expected time when the interval is confident); from the hold window on it says to freeze.
 * eta rounds to whole seconds (at least 1), or to whole minutes from 2 min; wait (beeps minutes
 * apart) and lost show sinceLastS as m:ss. Empty for null (live mode has no countdown).
 */
export function countdownText(countdown: Countdown | null): string {
  if (countdown === null) return ''
  switch (countdown.kind) {
    case 'eta':
      if (countdown.etaS === null) return waitingText(countdown.sinceLastS)
      // A no-break space keeps '~23 s' together when the line wraps on a narrow screen.
      if (countdown.etaS >= 120) return `Move now · next chirp in ~${Math.round(countdown.etaS / 60)}\u00a0min`
      return `Move now · next chirp in ~${Math.max(1, Math.round(countdown.etaS))}\u00a0s`
    case 'hold':
      return 'Hold still…'
    case 'wait':
      return countdown.sinceLastS === null
        ? 'Stay here until the next beep'
        : `Stay here until the next beep · last one ${formatClock(countdown.sinceLastS)} ago`
    case 'late':
      return 'Hold still… chirp is late'
    case 'overdue':
      return 'Keep holding still. Chirps can be irregular.'
    case 'lost':
      return countdown.sinceLastS === null
        ? "Haven't heard it for a while. Keep waiting, or tap Listen again."
        : `Haven't heard it for ${formatClock(countdown.sinceLastS)}. Keep waiting, or tap Listen again.`
    case 'unknown':
      return waitingText(countdown.sinceLastS)
  }
}

/** Guidance lines, one per situation (see guidanceText). */
export const GUIDANCE = {
  first: 'Now walk 2–3 m in any direction, then hold still for the next chirp.',
  colder: 'Colder. Go back and try another direction.',
  warmer: 'Warmer. Keep going this way.',
  warmerTwice: 'Warmer twice. Keep going this way.',
  same: 'About the same. Try a bigger move, 3–5 m.',
  sameTwice: 'About the same twice. Make a bigger move or try another room.',
  veryHot:
    "Very hot. It is probably within arm's reach. Look up: detectors live on ceilings. Check cupboards and drawers for gadgets.",
  live: 'Walk slowly. The meter follows the tone.',
  default: 'Move 2–3 m after each chirp, then hold still for the next one.',
} as const

/**
 * One context-sensitive tip from the latest readings. Priority: live mode (very hot when clipped,
 * else the walk-slowly tip); no reading yet (default); first reading; clipped (very hot); colder;
 * warmer twice; warmer; same twice; same; default.
 *
 * "Very hot" is claimed only when the microphone clips. The 0..100 meter is relative to the best
 * reading so far, so a high percentage only means "loudest yet", which can still be rooms away.
 */
export function guidanceText(view: HuntView): string {
  if (view.mode === 'live') {
    const live = view.live
    if (live && (live.clipped || live.verdict === 'max')) return GUIDANCE.veryHot
    return GUIDANCE.live
  }
  const readings = view.readings
  const n = readings.length
  const last = view.last ?? readings[n - 1] ?? null
  if (last === null) return GUIDANCE.default
  // The reading before `last` (readings normally ends with last; tolerate a view where it does not).
  const lastIdx = readings.findLastIndex((r) => r.id === last.id)
  const prev = (lastIdx >= 0 ? readings[lastIdx - 1] : readings[n - 1]) ?? null
  switch (last.verdict) {
    case 'first':
      return GUIDANCE.first
    case 'max':
      return GUIDANCE.veryHot
    case 'colder':
      return GUIDANCE.colder
    case 'warmer':
      return prev?.verdict === 'warmer' ? GUIDANCE.warmerTwice : GUIDANCE.warmer
    case 'same':
      return prev?.verdict === 'same' ? GUIDANCE.sameTwice : GUIDANCE.same
  }
}

// ---- Direction scan (radar) ----------------------------------------------------------------------

/** Static strings of the direction scan panel. */
export const RADAR_COPY = {
  title: 'Direction scan',
  howChirp:
    'Hold the phone flat in front of your chest, top pointing away from you. Stay on the spot. After each chirp, turn a quarter turn.',
  howLive:
    'Hold the phone flat in front of your chest, top pointing away from you. Stay on the spot and turn slowly, one full turn in about 20 seconds.',
  clear: 'Clear scan',
  starting: 'Waiting for the compass…',
  unavailable: "This device has no compass, so the direction scan can't run here. Use a phone.",
  denied: 'Motion and orientation access was blocked. Allow it in the browser settings to use the direction scan.',
  firstChirp: 'Stand still and wait for the next chirp.',
  firstLive: 'Turn slowly on the spot.',
  keepTurning: 'Keep turning slowly on the spot.',
  unclear: 'No clear direction. The sound may be bouncing around you. Move toward the warmest room and scan again.',
  ariaNoDirection: 'Radar: no direction yet',
  ariaLoudest: 'Radar: loudest',
  directions: {
    ahead: 'straight ahead',
    aheadRight: 'ahead to the right',
    right: 'to your right',
    behindRight: 'behind you to the right',
    behind: 'behind you',
    behindLeft: 'behind you to the left',
    left: 'to your left',
    aheadLeft: 'ahead to the left',
  } satisfies Record<Direction8, string>,
} as const

/** Directions (sectors) measured at least once. */
export function measuredSectors(radar: RadarView): number {
  let n = 0
  for (const s of radar.sectors) if (s.samples > 0) n++
  return n
}

/**
 * Where the loudest direction is, in words, relative to where the phone points now. `direction`
 * overrides the eight-way word (the radar panel passes a steadied one, see radarUi.ts).
 */
function loudestWords(radar: RadarView, direction: Direction8 | null): string {
  if (direction !== null) return RADAR_COPY.directions[direction]
  if (radar.bearingDeg === null || radar.headingDeg === null) return 'toward the arrow'
  return RADAR_COPY.directions[direction8(relativeBearing(radar.bearingDeg, radar.headingDeg))]
}

/**
 * Main status line of the scan panel: compass problems, what to do next, or the answer.
 * 'rough' hedges ("Probably ..."); 'clear' states it; 'unclear' explains why there is no answer.
 * `direction` is the eight-way direction to name (null: computed from the bearing and heading).
 */
export function radarStatusText(scan: ScanState, mode: LockMode, direction: Direction8 | null = null): string {
  switch (scan.status) {
    case 'off':
      return ''
    case 'starting':
      return RADAR_COPY.starting
    case 'unavailable':
      return RADAR_COPY.unavailable
    case 'denied':
      return RADAR_COPY.denied
    case 'active':
      break
  }
  const radar = scan.radar
  if (radar === null || radar.samples === 0) return mode === 'chirp' ? RADAR_COPY.firstChirp : RADAR_COPY.firstLive
  switch (radar.quality) {
    case 'needMore': {
      if (mode === 'live') return RADAR_COPY.keepTurning
      const n = measuredSectors(radar)
      return `${n} ${n === 1 ? 'direction' : 'directions'} measured. Turn a quarter turn before the next chirp.`
    }
    case 'unclear':
      return RADAR_COPY.unclear
    case 'rough':
      return `Probably ${loudestWords(radar, direction)}. Measure a few more directions to be sure.`
    case 'clear':
      return `Loudest ${loudestWords(radar, direction)}.`
  }
}

/** '40° left', '90° right', 'straight ahead' or 'turn around' for a relative angle. */
function turnWords(relDeg: number): string {
  const a = Math.round(Math.abs(relDeg))
  if (a < 10) return 'straight ahead'
  if (a > 165) return 'turn around'
  return `${a}° ${relDeg < 0 ? 'left' : 'right'}`
}

/**
 * Detail line: the angle and strength of the answer, or where to face next while directions are
 * missing. Empty when there is nothing useful to add (no compass heading yet).
 */
export function radarDirectionText(radar: RadarView): string {
  if (radar.headingDeg === null) return ''
  if (radar.bearingDeg !== null) {
    const turn = turnWords(relativeBearing(radar.bearingDeg, radar.headingDeg))
    const strength = radar.contrastDb === null ? '' : ` · ${Math.round(radar.contrastDb)}\u00a0dB louder than the quietest side`
    return `${turn === 'straight ahead' ? 'Straight ahead' : `About ${turn}`}${strength}`
  }
  if (radar.suggestDeg !== null && radar.quality === 'needMore') {
    const turn = turnWords(relativeBearing(radar.suggestDeg, radar.headingDeg))
    return turn === 'straight ahead' ? 'Next: keep facing this way for the next reading.' : `Next: face the empty side, ${turn === 'turn around' ? 'behind you' : `about ${turn}`}.`
  }
  return ''
}

// ---- Debug readout -------------------------------------------------------------------------------

/** Fixed-point number for the debug panel (ASCII minus so columns line up); placeholder for null. */
function num(x: number | null, digits = 1): string {
  if (x === null || !Number.isFinite(x)) return NO_VALUE
  const s = Math.abs(x).toFixed(digits)
  return Number(s) === 0 ? s : (x < 0 ? '-' : '') + s
}

function chirpRow(c: Chirp): string {
  return [
    num(c.peakDb).padStart(7),
    num(c.snrDb).padStart(6),
    String(Math.round(c.durationMs)).padStart(6),
    (c.clipped ? 'yes' : 'no').padStart(5),
    `${Math.round(c.taintedFrac * 100)}%`.padStart(8),
  ].join('')
}

/**
 * Plain-text diagnostics for the ?debug panel, one fact per line: mic diag (device label, track and
 * context sample rates, EC/NS/AGC), lock, f0, current level / band floor / SNR (dB), warmth,
 * holdActive, missed chirps, and a table of the last chirps (dB, SNR dB, duration ms, clipped, tainted %).
 */
export function debugText(state: AppState): string {
  const lines: string[] = [`screen   ${state.screen.kind}`]
  const mic = state.mic
  if (mic === null) {
    lines.push('mic      not started')
  } else {
    lines.push(`mic      ${mic.deviceLabel || '(no label)'}`)
    lines.push(
      `rates    track ${mic.trackSampleRate ?? '?'} Hz, context ${mic.contextSampleRate} Hz, ` +
        `channels ${mic.channelCount ?? '?'}`,
    )
    lines.push(
      `process  EC ${mic.echoCancellation}, NS ${mic.noiseSuppression}, AGC ${mic.autoGainControl} (${mic.rawAudio})`,
    )
  }
  lines.push(`mic lvl  ${num(state.micLevel, 2)}`)
  const lock = state.lock
  if (lock !== null) {
    lines.push(`lock     ${num(lock.f0Hz)} Hz, ${lock.mode}, ${lock.reason}, SNR ${num(lock.snrDb)} dB`)
  }
  const hunt = state.hunt
  if (hunt !== null) {
    lines.push(`f0       ${num(hunt.f0Hz)} Hz (${hunt.mode})`)
    lines.push(`level    ${num(hunt.levelDb)} dB, floor ${num(hunt.bandFloorDb)} dB, SNR ${num(hunt.snrDb)} dB`)
    lines.push(
      `warmth   ${num(hunt.warmth, 2)}, hold ${hunt.holdActive ? 'yes' : 'no'}, ` +
        `hearing ${hunt.hearing ? 'yes' : 'no'}, missed ${hunt.missedChirps}`,
    )
    lines.push(`best     ${num(hunt.bestDb)} dB, readings ${hunt.readings.length}`)
    if (hunt.chirps.length > 0) {
      lines.push('chirps        dB   SNR    ms  clip tainted')
      for (const c of hunt.chirps) lines.push(`      ${chirpRow(c)}`)
    }
  }
  return lines.join('\n')
}

// ---- Log -----------------------------------------------------------------------------------------

/** Static strings of the Log panel (a hunting-screen tab) and of its plain-text export. */
export const LOG_COPY = {
  title: 'Log',
  copy: 'Copy log',
  empty: 'Each chirp adds a line here. Add a note about where you stood, so you can retrace the warm spots.',
  listLabel: 'Readings, newest first',
  notePlaceholder: 'Where were you? e.g. hallway door',
  /** Marker of a reading that clipped the microphone ... */
  clipped: 'VERY HOT / clipped',
  /** ... shortened when the verdict word next to it already says VERY HOT. */
  clippedShort: 'clipped',
  /** A reading that sums up a stretch of live mode (a continuous tone or rapid chirps). */
  live: 'Live',
  /** Between the parts of a log line, on screen and in the export. */
  sep: ' · ',
  exportTitle: 'Soundwave log',
  exportEmpty: 'No readings yet.',
  exportNote: 'Note:',
  /** Toasts for main.ts after Copy log. */
  copied: 'Log copied.',
  copyFailed: "Couldn't copy the log. Your browser blocked the clipboard.",
} as const

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Local wall-clock time as 24 h 'HH:MM:SS', independent of the runtime locale; '--:--:--' when invalid. */
export function formatClockTime(wallMs: number): string {
  const d = new Date(wallMs)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** The frequency moved more than 1 % from the previous entry's (a drift, or a different beep). */
function frequencyMoved(f0Hz: number, prevHz: number): boolean {
  if (!Number.isFinite(f0Hz) || !Number.isFinite(prevHz) || prevHz <= 0) return false
  return Math.abs(f0Hz - prevHz) > 0.01 * prevHz
}

/**
 * Detail parts of a log row after the verdict word, in order: dB change vs the previous reading,
 * meter position, frequency (only when it moved more than 1 % from `prev`), loudest listener,
 * merged chirps ('×3 chirps'), live. The clipped marker is separate (logClipText).
 */
export function logEntryParts(entry: LogEntry, prev: LogEntry | null): string[] {
  const parts: string[] = []
  if (entry.deltaPrevDb !== null && Number.isFinite(entry.deltaPrevDb)) parts.push(formatDelta(entry.deltaPrevDb))
  if (entry.pct !== null && Number.isFinite(entry.pct)) parts.push(`${formatPct(entry.pct)} of 100`)
  if (prev !== null && frequencyMoved(entry.f0Hz, prev.f0Hz)) parts.push(formatHz(entry.f0Hz))
  const loudest = entry.loudest?.trim() ?? ''
  if (loudest !== '') parts.push(`Loudest: ${loudest}`)
  if (entry.chirpCount > 1) parts.push(`×${entry.chirpCount} chirps`)
  if (entry.source === 'train') parts.push(LOG_COPY.live)
  return parts
}

/** Clipped marker of a log row, or null when the reading did not clip. */
export function logClipText(entry: LogEntry): string | null {
  if (!entry.clipped) return null
  return entry.verdict === 'max' ? LOG_COPY.clippedShort : LOG_COPY.clipped
}

/** One line per reading: 'WARMER · +4 dB · 72 of 100 · Loudest: Kitchen' (verdict, clipped marker, parts). */
export function logEntrySummary(entry: LogEntry, prev: LogEntry | null): string {
  const parts = [verdictLabel(entry.verdict)]
  const clip = logClipText(entry)
  if (clip !== null) parts.push(clip)
  parts.push(...logEntryParts(entry, prev))
  return parts.join(LOG_COPY.sep)
}

/** Reading count in the log header: '1 reading', '12 readings'. */
export function logCountText(n: number): string {
  return n === 1 ? '1 reading' : `${n} readings`
}

/** Accessible name of a row's note field: 'Note for the 03:04:05 reading'. */
export function logNoteLabel(time: string): string {
  return `Note for the ${time} reading`
}

/**
 * Plain-text export for Copy log: the header 'Soundwave log - 3,100 Hz' (just 'Soundwave log' when
 * the frequency is unknown), then one line per reading, oldest first, with its note:
 * '03:04:05 WARMER · +4 dB · 72 of 100 · Note: hallway door'.
 */
export function logAsText(log: readonly LogEntry[], f0Hz: number | null): string {
  const head =
    f0Hz !== null && Number.isFinite(f0Hz) ? `${LOG_COPY.exportTitle} - ${formatHz(f0Hz)}` : LOG_COPY.exportTitle
  const lines = [head]
  if (log.length === 0) lines.push(LOG_COPY.exportEmpty)
  log.forEach((entry, i) => {
    const note = entry.note.replace(/\s+/g, ' ').trim()
    const noteText = note === '' ? '' : `${LOG_COPY.sep}${LOG_COPY.exportNote} ${note}`
    lines.push(`${formatClockTime(entry.wallMs)} ${logEntrySummary(entry, log[i - 1] ?? null)}${noteText}`)
  })
  return lines.join('\n')
}

// ---- Found it ------------------------------------------------------------------------------------

/** Static strings of the Found it screen (the hunt's summary once the beep is found). */
export const FOUND_COPY = {
  title: 'Found it!',
  /** What the summary line calls the sound: a chirping beep, or a continuous tone (live mode). */
  beep: 'beep',
  tone: 'tone',
  tipTitle: 'Smoke or CO alarm?',
  tip: 'A low-battery chirp stops once you put in a fresh battery. Press its test button afterwards to check it still works.',
  notesTitle: 'Where you were',
  done: 'Done',
  newHunt: 'New hunt',
  keepHunting: 'Keep hunting',
  keepHint: 'Not it after all? Carry on where you left off.',
  /** The same hint once the microphone has been turned off on this screen (foundMicOffMs). */
  keepHintMicOff: 'The microphone is off now. Not it after all? Keep hunting turns it back on.',
  copyLog: LOG_COPY.copy,
} as const

/**
 * How long a hunt took, in words: seconds only under a minute ('45 s'), minutes and seconds under
 * an hour ('6 min 20 s', '6 min' on the minute), hours and minutes beyond ('1 h 5 min', '2 h').
 * Whole seconds, rounded down; '' for a negative or non-finite duration.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total} s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** Upper-case first letter ('found in 2 min' -> 'Found in 2 min'). */
function capitalize(text: string): string {
  return text === '' ? text : text[0]!.toUpperCase() + text.slice(1)
}

/**
 * Parts of the Found it summary line, each left out when unknown: the frequency with what was
 * heard ('3,100 Hz beep', or 'tone' in live mode), how long since the hunt's first reading
 * ('found in 6 min 20 s') and the chirps heard ('14 chirps', not in live mode, where readings are
 * stretches of a continuous tone). The first part starts with a capital.
 */
export function foundSummaryParts(summary: FoundSummary): string[] {
  const parts: string[] = []
  const f0 = summary.f0Hz
  if (f0 !== null && Number.isFinite(f0) && f0 > 0) {
    parts.push(`${formatHz(f0)} ${summary.mode === 'live' ? FOUND_COPY.tone : FOUND_COPY.beep}`)
  }
  const started = summary.startedAtWallMs
  if (started !== null && Number.isFinite(started) && Number.isFinite(summary.foundAtWallMs) && summary.foundAtWallMs >= started) {
    parts.push(`found in ${formatDuration(summary.foundAtWallMs - started)}`)
  }
  const n = Number.isFinite(summary.readings) ? Math.round(summary.readings) : 0
  if (summary.mode !== 'live' && n > 0) parts.push(n === 1 ? '1 chirp' : `${groupThousands(n)} chirps`)
  if (parts.length > 0) parts[0] = capitalize(parts[0]!)
  return parts
}

/** The Found it summary line: '3,100 Hz beep · found in 6 min 20 s · 14 chirps'; '' when nothing is known. */
export function foundSummaryLine(summary: FoundSummary): string {
  return foundSummaryParts(summary).join(LOG_COPY.sep)
}

/**
 * Parts of the listeners line: the listener that heard the last compared chirp loudest ('Loudest
 * station at the end: Kitchen') and how many listeners took part when more than this device
 * ('Compared on 3 devices'). Empty when neither applies.
 */
export function foundListenersParts(summary: FoundSummary): string[] {
  const parts: string[] = []
  const loudest = summary.loudestListener?.trim() ?? ''
  if (loudest !== '') parts.push(`Loudest station at the end: ${loudest}`)
  const n = Number.isFinite(summary.listeners) ? Math.round(summary.listeners) : 0
  if (n > 1) parts.push(`Compared on ${n} devices`)
  return parts
}

/** 'Loudest station at the end: Kitchen · Compared on 3 devices', either part alone, or ''. */
export function foundListenersLine(summary: FoundSummary): string {
  return foundListenersParts(summary).join(LOG_COPY.sep)
}

// ---- Stations: extra microphones and other devices -----------------------------------------------

/**
 * Static strings of the Stations panel (hub side), its pairing flow and the station screen.
 * 'Wi‑Fi' is written with a non-breaking hyphen (U+2011), so it never splits across two lines.
 */
export const STATIONS_COPY = {
  title: 'Stations',
  /** Name main.ts gives this device's own listener ('self') on a phone; lower-cased mid-sentence. */
  selfName: 'This phone',
  /** The same on a device without haptics (a laptop or tablet); lower-cased mid-sentence. */
  selfNameDevice: 'This device',
  kinds: {
    self: 'This phone',
    mic: 'Microphone',
    station: 'Station',
  } satisfies Record<ListenerKind, string>,
  statuses: {
    listening: 'Listening',
    connecting: 'Connecting…',
    lost: 'Lost – out of range?',
  } satisfies Record<ListenerStatus, string>,
  empty: 'Add phones in other rooms, or extra microphones, to see which one hears the beep loudest.',
  waiting: 'Waiting for the next chirp',
  waitingDetail: "On every chirp, each listener's level is compared.",
  singleDetail: 'The others may be too far away to hear it.',
  tooClose: 'Too close to call',
  listLabel: 'Listeners',
  loudest: 'loudest',
  /** Screen-reader context before a listener's level difference ('−6 dB'). */
  deltaPrefix: 'compared with the loudest:',
  removeConfirm: 'Remove?',
  addPhone: 'Add a phone',
  addMic: 'Add a microphone',
  calibrate: 'Calibrate',
  calibrateHint: 'Put all devices side by side, then wait for one chirp.',
  calibrating: 'Calibrating… waiting for a chirp heard by every device',
  calibrated: 'Calibrated. Now put each device in its room.',
  privacy:
    "Only loudness numbers travel between devices, never audio. They connect directly to each other. To find each other across networks, each device asks a public address server (run by Google) for its own address; that server sees the device's address and nothing else.",
  pair: {
    step1: 'Add a phone · step 1 of 2',
    step2: 'Add a phone · step 2 of 2',
    preparing: 'Preparing a code…',
    showOfferTitle: 'Scan this code with the other phone',
    showOfferHelp: 'On the other phone, open this page and choose Use this device as a station. Then scan this code.',
    qrLabel: 'Pairing code',
    codeText: 'Pairing code as text',
    copy: 'Copy code',
    share: 'Share',
    then: 'When the other phone shows its reply code:',
    scanAnswer: 'Scan their reply',
    pasteAnswer: 'Paste their reply',
    scanHelp: "Point this phone's camera at the reply code on the other phone.",
    pasteHelp: 'On the other phone, tap Copy code or Share, send the code to this device and paste it here.',
    pasteLabel: 'Reply code',
    pastePlaceholder: 'SW1.…',
    connect: 'Connect',
    showCode: 'Show my code again',
    connecting: 'Connecting…',
    connectingHint: 'Same Wi‑Fi works best. Across networks it can take longer, and some mobile networks block it.',
    errorTitle: "Couldn't connect",
    errorFallback: 'Something went wrong. Try again.',
    tryAgain: 'Try again',
    /** Error after a wrong reply code (the hub kept its code): the way out is a new code. */
    newCode: 'Start again with a new code',
    cancel: 'Cancel',
  },
  scan: {
    label: 'Camera view for scanning the code',
    starting: 'Starting the camera…',
    notOurs: 'That QR code is not a Soundwave pairing code.',
    failed: 'The camera could not be started. Paste the code instead.',
    retry: 'Try the camera again',
    qrFailed: "This code can't be shown as a QR code. Copy it instead.",
  },
  station: {
    titles: {
      name: 'Use this device as a station',
      starting: 'Opening the microphone…',
      scanOffer: 'Scan the code shown on the main phone',
      pasteOffer: 'Paste the code from the main phone',
      answering: 'Preparing the reply…',
      showAnswer: 'Now show this code to the main phone',
      connected: 'Connected',
      lost: 'Connection lost',
      error: 'Something went wrong',
    } satisfies Record<StationStep, string>,
    step1: 'Step 1 of 2',
    step2: 'Step 2 of 2',
    intro:
      "Leave this device in another room. It listens at the main phone's frequency and sends only loudness numbers – no audio – over the network.",
    nameLabel: 'Name shown on the main phone',
    namePlaceholder: 'e.g. Kitchen',
    start: 'Start',
    startCaption: 'Uses the microphone, and the camera to scan a code. Your browser will ask for permission.',
    back: 'Back',
    startingHint: 'Choose Allow when your browser asks.',
    scanHelp: 'On the main phone, open the Stations tab and tap Add a phone. Then point this camera at the code it shows.',
    pasteInstead: 'Paste the code instead',
    pasteHelp: 'On the main phone, tap Copy code or Share, send the code to this device and paste it here.',
    pasteLabel: 'Code from the main phone',
    continue: 'Continue',
    scanInstead: 'Scan instead',
    answerHelp: 'On the main phone, tap Scan their reply and point it at this code.',
    answerQrLabel: 'Reply code',
    answerText: 'Reply code as text',
    waitingForHub: 'Waiting for the main phone to connect…',
    startOver: 'Start over',
    waitingLock: 'Waiting for the main phone to lock onto the beep',
    level: 'Level',
    lastChirp: 'Last chirp',
    noChirp: 'None yet',
    chirpsSent: 'Chirps sent',
    keepOn: 'Keep this screen on. Put the phone down with the microphone uncovered.',
    privacy: 'Only loudness numbers are sent, never audio.',
    stop: 'Stop station',
    stopShort: 'Stop',
    lostBody: "The main phone can't be reached. It may be out of Wi‑Fi range, or its hunt has stopped. This device keeps listening.",
    pairAgain: 'Pair again',
    tryAgain: 'Try again',
    errorFallback: 'Something went wrong.',
  },
} as const

/** Kind label of a listener: 'This phone', 'Microphone' or 'Station'. */
export function listenerKindText(kind: ListenerKind): string {
  return STATIONS_COPY.kinds[kind]
}

/** Status of a listener in words ('Listening', 'Connecting…', 'Lost – out of range?'), never colour alone. */
export function listenerStatusText(status: ListenerStatus): string {
  return STATIONS_COPY.statuses[status]
}

/** A calibrated level in whole dB with a real minus sign ('−42 dB'); the placeholder when unknown. */
export function listenerLevelText(db: number | null): string {
  if (db === null || !Number.isFinite(db)) return NO_VALUE
  const r = roundSym(db)
  return `${r < 0 ? MINUS : ''}${Math.abs(r)} dB`
}

/**
 * A listener's level against the top of the last comparison: 'loudest' for the named loudest
 * listener, otherwise the whole-dB difference ('−6 dB'; '0 dB' for an undecided top, never
 * positive); '' when the listener has no level in that comparison.
 */
export function listenerDeltaText(view: ListenerView): string {
  if (view.levelDb === null) return ''
  if (view.isLoudest) return STATIONS_COPY.loudest
  if (view.deltaDb === null || !Number.isFinite(view.deltaDb)) return ''
  return formatDelta(Math.min(0, view.deltaDb))
}

export type StationsHeadlineKind = 'empty' | 'waiting' | 'single' | 'loudest' | 'close'

/** Summary at the top of the Stations panel; title is '' for 'empty' (the detail explains). */
export interface StationsHeadline {
  readonly kind: StationsHeadlineKind
  readonly title: string
  readonly detail: string
}

/**
 * Summary of the last comparison: 'Loudest: Kitchen' + '8 dB louder than Hall' when a listener
 * was named (marginDb, rounded), 'Too close to call' when not, 'Only Kitchen heard it' when a
 * single listener reported, a waiting line before any comparison, and an explanation when there
 * is no listener besides this device. This device's own name reads 'this phone' mid-sentence.
 */
export function comparisonHeadline(comparison: Comparison | null, listeners: readonly ListenerView[]): StationsHeadline {
  const S = STATIONS_COPY
  if (!listeners.some((l) => l.kind !== 'self')) return { kind: 'empty', title: '', detail: S.empty }
  const ranking = comparison?.ranking ?? []
  const first = ranking[0]
  if (comparison === null || first === undefined) return { kind: 'waiting', title: S.waiting, detail: S.waitingDetail }
  const name = (e: ComparisonEntry, start: boolean): string => {
    const isSelf = listeners.some((l) => l.id === e.id && l.kind === 'self')
    const generic = e.name === S.selfName || e.name === S.selfNameDevice
    return !start && isSelf && generic ? e.name.toLowerCase() : e.name
  }
  const second = ranking[1]
  if (second === undefined) return { kind: 'single', title: `Only ${name(first, false)} heard it`, detail: S.singleDetail }
  const loud = comparison.loudestId === null ? undefined : ranking.find((e) => e.id === comparison.loudestId)
  if (loud !== undefined) {
    const runner = ranking.find((e) => e.id !== loud.id) ?? second
    const margin = comparison.marginDb ?? loud.levelDb - runner.levelDb
    const detail =
      loud.clipped && !runner.clipped
        ? `Louder than ${name(runner, false)}: too loud to measure exactly`
        : `${Math.abs(roundSym(Number.isFinite(margin) ? margin : 0))} dB louder than ${name(runner, false)}`
    return { kind: 'loudest', title: `Loudest: ${name(loud, true)}`, detail }
  }
  return {
    kind: 'close',
    title: S.tooClose,
    detail: `${name(first, true)} and ${name(second, false)} heard it about equally loud.`,
  }
}

/** Button text for an extra microphone: its label, or 'Other microphone 1' while labels are hidden. */
export function micButtonText(label: string, index: number): string {
  const t = label.trim()
  return t === '' ? `Other microphone ${index + 1}` : t
}

/** Accessible name of a listener's remove button; armed = waiting for the confirming second tap. */
export function removeListenerLabel(name: string, armed: boolean): string {
  return armed ? `Tap again to remove ${name}` : `Remove ${name}`
}

/** Heading of the station screen for each step. */
export function stationTitle(step: StationStep): string {
  return STATIONS_COPY.station.titles[step]
}

/** Name line of a connected station: 'This station: Kitchen'. */
export function stationNameText(name: string): string {
  return `This station: ${name}`
}

/** 'Listening at 3,100 Hz', or the waiting line while the main phone has no lock yet. */
export function stationFreqText(f0Hz: number | null): string {
  if (f0Hz === null || !Number.isFinite(f0Hz) || f0Hz <= 0) return STATIONS_COPY.station.waitingLock
  return `Listening at ${formatHz(f0Hz)}`
}

/** The last chirp a station sent: '−42 dB · 14:32:05' (local 24 h time); 'None yet' before the first. */
export function stationLastChirpText(db: number | null, wallMs: number | null): string {
  if (db === null || !Number.isFinite(db)) return STATIONS_COPY.station.noChirp
  const level = listenerLevelText(db)
  return wallMs === null || !Number.isFinite(wallMs) ? level : `${level} · ${formatClockTime(wallMs)}`
}

/** Chirps a station has sent, grouped: '1,204'. */
export function stationChirpsText(n: number): string {
  return groupThousands(Number.isFinite(n) && n > 0 ? Math.round(n) : 0)
}

// ---- Past hunts ----------------------------------------------------------------------------------

/** Static strings of the Past hunts list (start screen) and the name field on the Found it screen. */
export const HISTORY_COPY = {
  title: 'Past hunts',
  intro: 'Beeps you found, saved on this device only.',
  remove: 'Remove',
  removed: 'Removed from past hunts.',
  notesLabel: 'Notes',
  nameLabel: 'What was it?',
  namePlaceholder: 'e.g. Hallway smoke alarm',
  nameHint: 'Saved on this device under Past hunts.',
  /** Title of a past hunt without a name or a known frequency. */
  untitled: 'Beep',
} as const

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * When a past hunt was found, in local time: 'Mon 22 Sep, 14:05', with the year when it differs
 * from nowMs's ('Tue 3 Dec 2024, 09:30'). '' when unknown.
 */
export function formatHuntDate(wallMs: number, nowMs: number): string {
  const d = new Date(wallMs)
  if (!Number.isFinite(wallMs) || Number.isNaN(d.getTime())) return ''
  const now = new Date(nowMs)
  const sameYear = !Number.isNaN(now.getTime()) && now.getFullYear() === d.getFullYear()
  const day = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`
  return `${day}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** '3,100 Hz beep' ('tone' in live mode), or null without a usable frequency. */
function beepName(summary: FoundSummary): string | null {
  const f0 = summary.f0Hz
  if (f0 === null || !Number.isFinite(f0) || f0 <= 0) return null
  return `${formatHz(f0)} ${summary.mode === 'live' ? FOUND_COPY.tone : FOUND_COPY.beep}`
}

/** A past hunt's name with runs of white space collapsed; '' when it has none. */
export function historyName(record: HuntRecord): string {
  return record.label.replace(/\s+/g, ' ').trim()
}

/** What a past hunt is called: its name, else '3,100 Hz beep', else 'Beep'. */
export function historyTitle(record: HuntRecord): string {
  const name = historyName(record)
  if (name !== '') return name
  return beepName(record.summary) ?? HISTORY_COPY.untitled
}

/**
 * The details of a past hunt after its date: the frequency (only when the title is the name, as
 * an unnamed hunt is titled by it), how long it took and the chirps heard, as on Found it.
 */
export function historyDetailParts(record: HuntRecord): string[] {
  const s = record.summary
  const parts: string[] = []
  const beep = beepName(s)
  if (beep !== null && historyName(record) !== '') parts.push(beep)
  const started = s.startedAtWallMs
  if (started !== null && Number.isFinite(started) && Number.isFinite(s.foundAtWallMs) && s.foundAtWallMs >= started) {
    parts.push(`found in ${formatDuration(s.foundAtWallMs - started)}`)
  }
  const n = Number.isFinite(s.readings) ? Math.round(s.readings) : 0
  if (s.mode !== 'live' && n > 0) parts.push(n === 1 ? '1 chirp' : `${groupThousands(n)} chirps`)
  return parts
}

/** Accessible name of a past hunt's Remove button. */
export function historyRemoveLabel(record: HuntRecord): string {
  return `Remove ${historyTitle(record)} from past hunts`
}

// ---- Beep fingerprint -----------------------------------------------------------------------------

/** Under 'I heard the beep': sounds at the beep's pitch that were not taken as the beep; '' for none. */
export function ignoredSoundsText(n: number): string {
  const k = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
  if (k === 0) return ''
  return k === 1 ? 'Ignored 1 other sound at this pitch' : `Ignored ${groupThousands(k)} other sounds at this pitch`
}
