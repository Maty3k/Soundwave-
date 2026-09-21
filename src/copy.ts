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
  HuntView,
  Lock,
  LockMode,
  MicDiag,
  RadarView,
  Reading,
  ScanState,
  Verdict,
} from './types.ts'
import { direction8, relativeBearing, type Direction8 } from './dsp/radar.ts'

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
      { title: 'Walk', text: 'stand still for each chirp.' },
      { title: 'Follow', text: 'warmer means closer.' },
    ],
    privacy: 'Nothing leaves your device. Audio is analysed live in your browser and never recorded or uploaded.',
    start: 'Start listening',
    caption: 'Uses your microphone. Your browser will ask for permission. Keep the screen on while you hunt.',
  },
  requesting: {
    title: 'Allow microphone access',
    body: 'Choose Allow when your browser asks.',
    hint: "Don't see a prompt? Look for the microphone icon next to the address bar.",
    cancel: 'Cancel',
  },
  listening: {
    title: 'Listening for the beep…',
    tip: 'Stay quiet and still. Chirps every 30–60 s are normal.',
    noBeep: 'No beep yet. Is it still chirping? Stay quiet and wait for the next one.',
    micLabel: 'Mic',
    elapsedLabel: 'Elapsed',
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
    notIt: 'Not it, listen again',
  },
  hunting: {
    title: 'Hunting for the beep',
    modeChirp: 'Chirp',
    modeLive: 'Live',
    frequencyLabel: 'Locked frequency',
    modeLabel: 'Mode',
    clicks: 'Clicks',
    haptics: 'Haptics',
    direction: 'Direction',
    on: 'On',
    off: 'Off',
    waiting: 'LISTENING',
    newBest: 'New best!',
    startingPoint: 'Your starting point',
    meterLabel: 'Warmth',
    max: 'MAX',
    ofHundred: 'of 100',
    scaleCold: 'Cold',
    scaleHot: 'Hot',
    hearing: 'Hearing it',
    history: 'Recent readings',
    resetBest: 'Reset best',
    relisten: 'Re-listen',
    stop: 'Stop',
  },
  paused: {
    title: 'Paused. Soundwave was in the background.',
    resume: 'Tap to resume listening',
    resuming: 'Resuming…',
    stop: 'Stop',
  },
  stopConfirm: {
    title: 'Stop hunting? Your best-so-far will be lost.',
    stop: 'Stop',
    keepGoing: 'Keep going',
  },
  toasts: {
    wakeLock: 'Your screen may turn off while hunting. Tap it now and then, or raise your display timeout.',
    live: 'Continuous tone. Switched to the live meter.',
    chirp: 'Back to chirp mode.',
    linkCopied: 'Link copied.',
    linkCopyFailed: "Couldn't copy the link. Copy it from the address bar.",
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
  wakeLockFailed: COPY.toasts.wakeLock,
  modeLive: COPY.toasts.live,
  modeChirp: COPY.toasts.chirp,
  linkCopied: COPY.toasts.linkCopied,
  linkCopyFailed: COPY.toasts.linkCopyFailed,
} as const

/** Recovery action offered on an error card. */
export type ErrorAction = 'retry' | 'reload' | 'back' | 'copyLink'

/** Heading, body and recovery actions (primary first) for each microphone error. */
export const ERROR_COPY: Record<ErrorCode, { heading: string; body: string; actions: readonly ErrorAction[] }> = {
  permission: {
    heading: 'Microphone blocked',
    body:
      "Soundwave can't hear anything without the microphone. Nothing is recorded: it only measures loudness at one frequency. " +
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

const VERDICT_LABELS: Record<Verdict, string> = {
  first: 'FIRST READING',
  warmer: 'WARMER',
  colder: 'COLDER',
  same: 'ABOUT THE SAME',
  max: 'VERY HOT',
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

/** Sub-line under a chirp verdict: '+4 dB vs last', or the starting-point note for the first reading. */
export function deltaLine(reading: Reading): string {
  if (reading.deltaPrevDb === null) return COPY.hunting.startingPoint
  return `${formatDelta(reading.deltaPrevDb)} vs last`
}

/** Sub-line under the live verdict: '+4 dB vs 3 s ago' (refMs = config.liveRefMs); empty without a reference. */
export function liveDeltaLine(deltaDb: number | null, refMs: number): string {
  if (deltaDb === null) return ''
  return `${formatDelta(deltaDb)} vs ${Math.round(refMs / 1000)} s ago`
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

/** Visible history item 'pct marker', e.g. '72 ▲'; the first reading has no percent and reads '– •'. */
export function historyItemText(reading: Reading): string {
  return `${formatPct(reading.pct)} ${historyMarker(reading)}`
}

/** Screen-reader label for one history item, e.g. '72 of 100, warmer, new best'. */
export function historyItemLabel(reading: Reading): string {
  const parts = [
    reading.pct === null ? 'no percent' : `${formatPct(reading.pct)} of 100`,
    verdictLabel(reading.verdict).toLowerCase(),
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

// ---- Countdown and guidance ----------------------------------------------------------------------

function waitingText(sinceLastS: number | null): string {
  return sinceLastS === null
    ? 'Waiting for the first chirp…'
    : `Waiting for the next chirp… ${formatClock(sinceLastS)} since the last one`
}

/**
 * One line about the next expected chirp. eta rounds to whole seconds (at least 1);
 * lost and unknown use sinceLastS as m:ss. Empty for null (live mode has no countdown).
 */
export function countdownText(countdown: Countdown | null): string {
  if (countdown === null) return ''
  switch (countdown.kind) {
    case 'eta':
      if (countdown.etaS === null) return waitingText(countdown.sinceLastS)
      return `Next chirp in ~${Math.max(1, Math.round(countdown.etaS))} s`
    case 'hold':
      return 'Hold still…'
    case 'late':
      return 'Listening… the chirp is a little late'
    case 'overdue':
      return 'Overdue. Chirps can be irregular, so stay still a little longer.'
    case 'lost':
      return countdown.sinceLastS === null
        ? "Haven't heard it for a while. Keep waiting, or tap Re-listen."
        : `Haven't heard it for ${formatClock(countdown.sinceLastS)}. Keep waiting, or tap Re-listen.`
    case 'unknown':
      return waitingText(countdown.sinceLastS)
  }
}

/** Guidance lines, one per situation (see guidanceText). */
export const GUIDANCE = {
  first: 'Now move 2–3 m and wait for the next chirp.',
  colder: 'Colder. Go back and try another direction.',
  warmerTwice: 'Warmer twice. Keep going this way.',
  sameTwice: 'About the same twice. Make a bigger move or try another room.',
  veryHot:
    "Very hot. It is probably within arm's reach. Look up: detectors live on ceilings. Check cupboards and drawers for gadgets.",
  live: 'Walk slowly. The meter follows the tone.',
  default: 'Stand still until the next chirp, read the verdict, then move 2–3 m.',
} as const

/**
 * One context-sensitive tip from the latest readings. Priority: live mode (very hot when clipped,
 * else the walk-slowly tip); no reading yet (default); first reading; clipped (very hot); colder;
 * warmer twice; same twice; default.
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
  if (last.verdict === 'first') return GUIDANCE.first
  if (last.verdict === 'max') return GUIDANCE.veryHot
  if (last.verdict === 'colder') return GUIDANCE.colder
  if (last.verdict === 'warmer' && prev?.verdict === 'warmer') return GUIDANCE.warmerTwice
  if (last.verdict === 'same' && prev?.verdict === 'same') return GUIDANCE.sameTwice
  return GUIDANCE.default
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
  done: 'Done',
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

function measuredSectors(radar: RadarView): number {
  let n = 0
  for (const s of radar.sectors) if (s.samples > 0) n++
  return n
}

/** Where the loudest direction is, in words, relative to where the phone points now. */
function loudestWords(radar: RadarView): string {
  if (radar.bearingDeg === null || radar.headingDeg === null) return 'toward the arrow'
  return RADAR_COPY.directions[direction8(relativeBearing(radar.bearingDeg, radar.headingDeg))]
}

/**
 * Main status line of the scan panel: compass problems, what to do next, or the answer.
 * 'rough' hedges ("Probably ..."); 'clear' states it; 'unclear' explains why there is no answer.
 */
export function radarStatusText(scan: ScanState, mode: LockMode): string {
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
      return `Probably ${loudestWords(radar)}. Measure a few more directions to be sure.`
    case 'clear':
      return `Loudest ${loudestWords(radar)}.`
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
    const strength = radar.contrastDb === null ? '' : ` · ${Math.round(radar.contrastDb)} dB louder than the quietest side`
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
