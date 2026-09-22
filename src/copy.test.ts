import { describe, expect, it } from 'vitest'
import { initialState } from './app.ts'
import { CONFIG } from './config.ts'
import {
  COPY,
  countdownText,
  debugText,
  deltaLine,
  ERROR_COPY,
  formatClock,
  formatDelta,
  formatHz,
  formatPct,
  GUIDANCE,
  guidanceText,
  heardText,
  heroLabel,
  historyItemText,
  liveDeltaLine,
  MINUS,
  NO_VALUE,
  rawAudioText,
  verdictLabel,
  RADAR_COPY,
  radarDirectionText,
  radarStatusText,
  errorBody,
  historyItemLabel,
  liveAnnouncement,
  pendingSightingsText,
  pendingText,
  PERMISSION_HELP,
  readingAnnouncement,
  tabBadgeLabel,
  tabName,
  TEXT,
  formatClockTime,
  LOG_COPY,
  logAsText,
  logClipText,
  logCountText,
  logEntryParts,
  logEntrySummary,
  logNoteLabel,
} from './copy.ts'
import type { Countdown, HuntView, LiveView, Lock, LogEntry, MicDiag, RadarView, Reading, ScanState, Verdict } from './types.ts'
import {
  comparisonHeadline,
  listenerDeltaText,
  listenerKindText,
  listenerLevelText,
  listenerStatusText,
  micButtonText,
  removeListenerLabel,
  stationChirpsText,
  stationFreqText,
  stationLastChirpText,
  stationNameText,
  STATIONS_COPY,
  stationTitle,
} from './copy.ts'
import type { Comparison, ComparisonEntry, ListenerView, StationStep } from './types.ts'
import {
  FOUND_COPY,
  formatDuration,
  foundListenersLine,
  foundListenersParts,
  foundSummaryLine,
  foundSummaryParts,
} from './copy.ts'
import type { FoundSummary } from './types.ts'

// ---- Fixtures ------------------------------------------------------------------------------------

let nextId = 0
function r(verdict: Verdict, pct: number | null = 50, extra: Partial<Reading> = {}): Reading {
  const first = verdict === 'first'
  return {
    id: nextId++,
    tMs: nextId * 30_000,
    levelDb: -60,
    snrDb: 30,
    verdict,
    deltaPrevDb: first ? null : 4,
    pct: first ? null : pct,
    isNewBest: false,
    clipped: verdict === 'max',
    chirpCount: 1,
    missedBefore: 0,
    source: 'chirp',
    ...extra,
  }
}

function chirpView(readings: readonly Reading[]): HuntView {
  return {
    mode: 'chirp',
    f0Hz: 3120,
    readings,
    last: readings.at(-1) ?? null,
    bestDb: null,
    warmth: null,
    countdown: null,
    holdActive: false,
    hearing: false,
    live: null,
    levelDb: -90,
    bandFloorDb: -96,
    snrDb: 6,
    missedChirps: 0,
    chirps: [],
  }
}

function liveView(live: LiveView | null): HuntView {
  return { ...chirpView([]), mode: 'live', live }
}

function cd(kind: Countdown['kind'], etaS: number | null, sinceLastS: number | null): Countdown {
  return { kind, etaS, sinceLastS, intervalS: sinceLastS === null ? null : 40, confident: etaS !== null }
}

// ---- Formatters ----------------------------------------------------------------------------------

describe('formatHz', () => {
  it('rounds and groups thousands with a comma regardless of locale', () => {
    expect(formatHz(3120)).toBe('3,120 Hz')
    expect(formatHz(3119.6)).toBe('3,120 Hz')
    expect(formatHz(3120.4)).toBe('3,120 Hz')
    expect(formatHz(999.5)).toBe('1,000 Hz')
    expect(formatHz(950)).toBe('950 Hz')
    expect(formatHz(0)).toBe('0 Hz')
    expect(formatHz(12_345.4)).toBe('12,345 Hz')
    expect(formatHz(1_234_567)).toBe('1,234,567 Hz')
  })

  it('shows a placeholder for non-finite input', () => {
    expect(formatHz(Number.NaN)).toBe(`${NO_VALUE} Hz`)
  })
})

describe('formatClock', () => {
  it('formats whole seconds as m:ss', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(7)).toBe('0:07')
    expect(formatClock(52)).toBe('0:52')
    expect(formatClock(59.9)).toBe('0:59')
    expect(formatClock(60)).toBe('1:00')
    expect(formatClock(130)).toBe('2:10')
    expect(formatClock(3_725)).toBe('62:05')
  })

  it('reads 0:00 for negative or non-finite input', () => {
    expect(formatClock(-3)).toBe('0:00')
    expect(formatClock(Number.NaN)).toBe('0:00')
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})

describe('formatDelta', () => {
  it('prints a signed whole number of dB with a real minus sign', () => {
    expect(formatDelta(4)).toBe('+4 dB')
    expect(formatDelta(3.6)).toBe('+4 dB')
    expect(formatDelta(-3)).toBe(`${MINUS}3 dB`)
    expect(formatDelta(-3.4)).toBe('\u22123 dB')
    expect(formatDelta(12.2)).toBe('+12 dB')
  })

  it('prints 0 dB without a sign, also for values that round to zero', () => {
    expect(formatDelta(0)).toBe('0 dB')
    expect(formatDelta(0.4)).toBe('0 dB')
    expect(formatDelta(-0.4)).toBe('0 dB')
    expect(formatDelta(-0)).toBe('0 dB')
  })

  it('rounds halves away from zero symmetrically', () => {
    expect(formatDelta(2.5)).toBe('+3 dB')
    expect(formatDelta(-2.5)).toBe(`${MINUS}3 dB`)
  })
})

describe('formatPct', () => {
  it('rounds, clamps to 0..100 and shows a placeholder for null', () => {
    expect(formatPct(72.4)).toBe('72')
    expect(formatPct(100.2)).toBe('100')
    expect(formatPct(-1)).toBe('0')
    expect(formatPct(null)).toBe(NO_VALUE)
  })
})

describe('verdict text', () => {
  it('labels every verdict', () => {
    expect(verdictLabel('first')).toBe('FIRST READING')
    expect(verdictLabel('warmer')).toBe('WARMER')
    expect(verdictLabel('colder')).toBe('COLDER')
    expect(verdictLabel('same')).toBe('SAME')
    expect(verdictLabel('max')).toBe('VERY HOT')
  })

  it('hero follows the last reading in chirp mode and the live verdict in live mode', () => {
    expect(heroLabel(null)).toBe(COPY.hunting.waiting)
    expect(heroLabel(chirpView([]))).toBe(COPY.hunting.waiting)
    expect(heroLabel(chirpView([r('first'), r('colder')]))).toBe('COLDER')
    expect(heroLabel(liveView(null))).toBe(COPY.hunting.waiting)
    const live: LiveView = { levelDb: -50, pct: 60, verdict: 'warmer', deltaDb: 4, clipped: false }
    expect(heroLabel(liveView(live))).toBe('WARMER')
  })

  it('sub-lines show the delta vs last, or the starting point for the first reading', () => {
    expect(deltaLine(r('first'))).toBe(COPY.hunting.startingPoint)
    expect(deltaLine(r('warmer', 60, { deltaPrevDb: 4.2 }))).toBe('+4 dB vs last')
    expect(deltaLine(r('colder', 30, { deltaPrevDb: -3.6 }))).toBe(`${MINUS}4 dB vs last`)
    expect(deltaLine(r('same', 60, { deltaPrevDb: 0.4 }))).toBe('Same as last spot')
    expect(liveDeltaLine(-3, CONFIG.liveRefMs)).toBe(`${MINUS}3 dB vs ${CONFIG.liveRefMs / 1000} s ago`)
    expect(liveDeltaLine(-0.3, CONFIG.liveRefMs)).toBe(`Same as ${CONFIG.liveRefMs / 1000} s ago`)
    expect(liveDeltaLine(null, CONFIG.liveRefMs)).toBe('')
  })

  it('history items read "pct marker"', () => {
    expect(historyItemText(r('first'))).toBe('Start')
    expect(historyItemText(r('warmer', 72))).toBe('72 ▲')
    expect(historyItemText(r('colder', 40))).toBe('40 ▼')
    expect(historyItemText(r('same', 55))).toBe('55 =')
    expect(historyItemText(r('warmer', 97, { isNewBest: true }))).toBe('97 ★')
    expect(historyItemText(r('max', 100))).toBe('100 ▲')
    expect(historyItemText(r('warmer', null))).toBe(`${NO_VALUE} ▲`)
  })

  it('history labels speak the percent, the verdict and a new best', () => {
    expect(historyItemLabel(r('first'))).toBe('first reading, your starting point')
    expect(historyItemLabel(r('same', 55))).toBe('55 of 100, about the same')
    expect(historyItemLabel(r('warmer', 92, { isNewBest: true }))).toBe('92 of 100, warmer, new best')
  })

  it('announces a reading with its number and a new best, and a live verdict by its word', () => {
    expect(readingAnnouncement(r('warmer', 92.4, { isNewBest: true }))).toBe('Warmer. 92 of 100. New best.')
    expect(readingAnnouncement(r('colder', 40))).toBe('Colder. 40 of 100.')
    expect(readingAnnouncement(r('same', 61))).toBe('About the same. 61 of 100.')
    expect(readingAnnouncement(r('max', 100))).toBe('Very hot. 100 of 100.')
    expect(readingAnnouncement(r('first'))).toBe(`First reading. ${COPY.hunting.startingPoint}.`)
    expect(readingAnnouncement(r('warmer', null))).toBe('Warmer.')
    expect(liveAnnouncement('colder')).toBe('Colder.')
    expect(liveAnnouncement('same')).toBe('About the same.')
  })
})

describe('heardText and rawAudioText', () => {
  const chirp = { tOnsetMs: 0, tEndMs: 150, durationMs: 150, peakDb: -50, bandFloorDb: -90, snrDb: 40, f0Hz: 3120, clipped: false, taintedFrac: 0 }
  const lock: Lock = { f0Hz: 3120, mode: 'chirp', reason: 'fast', tMs: 0, snrDb: 30, chirps: [chirp] }

  it('counts the chirps heard while locking, or says continuous tone', () => {
    expect(heardText(lock)).toBe('Heard 1 chirp')
    expect(heardText({ ...lock, reason: 'slow', chirps: [chirp, chirp] })).toBe('Heard 2 chirps')
    expect(heardText({ ...lock, mode: 'live', reason: 'sustained' })).toBe('Continuous tone')
  })

  it('warns only when the processing is not verified off', () => {
    const mic: MicDiag = {
      echoCancellation: 'off', noiseSuppression: 'off', autoGainControl: 'off', rawAudio: 'raw',
      deviceLabel: '', trackSampleRate: null, contextSampleRate: 48000, channelCount: null,
    }
    expect(rawAudioText(null)).toBeNull()
    expect(rawAudioText(mic)).toBeNull()
    expect(rawAudioText({ ...mic, rawAudio: 'partial' })).toBe(COPY.rawAudio.partial)
    expect(rawAudioText({ ...mic, rawAudio: 'unknown' })).toBe(COPY.rawAudio.unknown)
  })
})

// ---- Countdown -----------------------------------------------------------------------------------

describe('countdownText', () => {
  it('covers every countdown kind', () => {
    // A no-break space between the number and 's', so '~37 s' never splits across lines.
    expect(countdownText(cd('eta', 36.6, 10))).toBe('Move now · next chirp in ~37\u00a0s')
    expect(countdownText(cd('eta', 0.2, 39))).toBe('Move now · next chirp in ~1\u00a0s')
    expect(countdownText(cd('hold', 3, 37))).toBe('Hold still…')
    expect(countdownText(cd('late', -1, 41))).toBe('Hold still… chirp is late')
    expect(countdownText(cd('overdue', -20, 60))).toBe('Keep holding still. Chirps can be irregular.')
    expect(countdownText(cd('lost', -90, 130))).toBe("Haven't heard it for 2:10. Keep waiting, or tap Listen again.")
    expect(countdownText(cd('unknown', null, 52))).toBe('Move 2–3 m now, then hold still for the next chirp.')
    expect(countdownText(cd('unknown', null, null))).toBe('Waiting for the first chirp…')
  })

  it('names the Listen again button the hunting screen really has', () => {
    expect(countdownText(cd('lost', -90, 130))).toContain(COPY.hunting.relisten)
  })

  it('falls back gracefully when a field is missing, and is empty in live mode', () => {
    expect(countdownText(cd('eta', null, 12))).toBe('Move 2–3 m now, then hold still for the next chirp.')
    expect(countdownText(cd('lost', null, null))).toBe("Haven't heard it for a while. Keep waiting, or tap Listen again.")
    expect(countdownText(null)).toBe('')
  })
})

// ---- Guidance ------------------------------------------------------------------------------------

describe('guidanceText', () => {
  const hot = 94 // where a new best lands on the relative meter (best - 45 .. best + 3 dB)
  const cool = hot - 20

  it('first reading: move and wait', () => {
    expect(guidanceText(chirpView([r('first')]))).toBe(GUIDANCE.first)
    expect(GUIDANCE.first).toBe('Now walk 2–3 m in any direction, then hold still for the next chirp.')
  })

  it('colder: go back', () => {
    expect(guidanceText(chirpView([r('first'), r('colder', cool)]))).toBe(GUIDANCE.colder)
    expect(guidanceText(chirpView([r('first'), r('warmer', cool), r('colder', hot)]))).toBe(GUIDANCE.colder)
  })

  it('two warmer in a row: keep going', () => {
    expect(guidanceText(chirpView([r('first'), r('warmer', cool - 10), r('warmer', cool)]))).toBe(GUIDANCE.warmerTwice)
  })

  it('two same in a row: bigger move', () => {
    expect(guidanceText(chirpView([r('first'), r('same', cool), r('same', cool)]))).toBe(GUIDANCE.sameTwice)
  })

  it('very hot only when the microphone clipped', () => {
    expect(guidanceText(chirpView([r('first'), r('max', 100)]))).toBe(GUIDANCE.veryHot)
    expect(guidanceText(chirpView([r('first'), r('warmer', cool), r('max', 100)]))).toBe(GUIDANCE.veryHot)
  })

  it('a high meter position alone is not very hot (the meter is relative to the best so far)', () => {
    // Regression: every new best lands near 94 %, even two rooms away from the beep.
    expect(guidanceText(chirpView([r('first'), r('warmer', hot)]))).toBe(GUIDANCE.warmer)
    expect(guidanceText(chirpView([r('first'), r('warmer', cool), r('warmer', hot)]))).toBe(GUIDANCE.warmerTwice)
    expect(guidanceText(chirpView([r('first'), r('same', hot)]))).toBe(GUIDANCE.same)
    expect(guidanceText(chirpView([r('first'), r('same', cool), r('same', 100)]))).toBe(GUIDANCE.sameTwice)
  })

  it('live mode: walk slowly, very hot only when clipped', () => {
    const live: LiveView = { levelDb: -50, pct: cool, verdict: 'warmer', deltaDb: 4, clipped: false }
    expect(guidanceText(liveView(live))).toBe(GUIDANCE.live)
    expect(guidanceText(liveView(null))).toBe(GUIDANCE.live)
    expect(guidanceText(liveView({ ...live, pct: 100 }))).toBe(GUIDANCE.live)
    expect(guidanceText(liveView({ ...live, clipped: true, verdict: 'max', pct: 100 }))).toBe(GUIDANCE.veryHot)
  })

  it('a single warmer or same reading gets its own tip, not the default routine', () => {
    expect(guidanceText(chirpView([r('first'), r('warmer', cool)]))).toBe(GUIDANCE.warmer)
    expect(guidanceText(chirpView([r('first'), r('colder', cool), r('warmer', cool)]))).toBe(GUIDANCE.warmer)
    expect(guidanceText(chirpView([r('first'), r('same', cool)]))).toBe(GUIDANCE.same)
    expect(guidanceText(chirpView([r('first'), r('warmer', cool), r('same', cool)]))).toBe(GUIDANCE.same)
    expect(GUIDANCE.warmer).toBe('Warmer. Keep going this way.')
    expect(GUIDANCE.same).toBe('About the same. Try a bigger move, 3–5 m.')
  })

  it('default routine before any reading', () => {
    expect(guidanceText(chirpView([]))).toBe(GUIDANCE.default)
    expect(GUIDANCE.default).toBe('Move 2–3 m after each chirp, then hold still for the next one.')
  })
})

// ---- Static copy and debug -----------------------------------------------------------------------

describe('direction scan text', () => {
  const view = (patch: Partial<RadarView>): RadarView => ({
    mode: 'chirp',
    sectors: Array.from({ length: 8 }, (_, i) => ({ centerDeg: i * 45, levelDb: null, samples: 0 })),
    bearingDeg: null,
    contrastDb: null,
    quality: 'needMore',
    samples: 0,
    maxGapDeg: null,
    suggestDeg: null,
    headingDeg: 0,
    ...patch,
  })
  const measured = (n: number) =>
    Array.from({ length: 8 }, (_, i) => ({ centerDeg: i * 45, levelDb: i < n ? -50 : null, samples: i < n ? 1 : 0 }))
  const scan = (status: ScanState['status'], radar: RadarView | null = null): ScanState => ({ open: true, status, radar })

  it('explains compass problems and the first step', () => {
    expect(radarStatusText(scan('starting'), 'chirp')).toBe(RADAR_COPY.starting)
    expect(radarStatusText(scan('unavailable'), 'chirp')).toBe(RADAR_COPY.unavailable)
    expect(radarStatusText(scan('denied'), 'live')).toBe(RADAR_COPY.denied)
    expect(radarStatusText({ open: false, status: 'off', radar: null }, 'chirp')).toBe('')
    expect(radarStatusText(scan('active'), 'chirp')).toBe(RADAR_COPY.firstChirp)
    expect(radarStatusText(scan('active', view({})), 'live')).toBe(RADAR_COPY.firstLive)
  })

  it('counts measured directions and asks for a quarter turn (chirp mode)', () => {
    expect(radarStatusText(scan('active', view({ samples: 1, sectors: measured(1) })), 'chirp')).toBe(
      '1 direction measured. Turn a quarter turn before the next chirp.',
    )
    expect(radarStatusText(scan('active', view({ samples: 2, sectors: measured(2) })), 'chirp')).toBe(
      '2 directions measured. Turn a quarter turn before the next chirp.',
    )
    expect(radarStatusText(scan('active', view({ mode: 'live', samples: 30, sectors: measured(2) })), 'live')).toBe(
      RADAR_COPY.keepTurning,
    )
  })

  it('states, hedges or declines an answer depending on quality, relative to where the phone points', () => {
    const answer = { samples: 4, sectors: measured(4), bearingDeg: 90, contrastDb: 12.4 }
    expect(radarStatusText(scan('active', view({ ...answer, quality: 'clear' })), 'chirp')).toBe('Loudest to your right.')
    expect(radarStatusText(scan('active', view({ ...answer, quality: 'rough' })), 'chirp')).toBe(
      'Probably to your right. Measure a few more directions to be sure.',
    )
    expect(radarStatusText(scan('active', view({ ...answer, quality: 'clear', headingDeg: 180 })), 'chirp')).toBe(
      'Loudest to your left.',
    )
    expect(radarStatusText(scan('active', view({ samples: 4, sectors: measured(4), quality: 'unclear' })), 'chirp')).toBe(
      RADAR_COPY.unclear,
    )
  })

  it('names a given (steadied) direction instead of recomputing it from the heading', () => {
    const answer = { samples: 4, sectors: measured(4), bearingDeg: 90, contrastDb: 12.4 }
    expect(radarStatusText(scan('active', view({ ...answer, quality: 'clear' })), 'chirp', 'aheadRight')).toBe(
      'Loudest ahead to the right.',
    )
    expect(radarStatusText(scan('active', view({ ...answer, quality: 'rough' })), 'chirp', 'behind')).toBe(
      'Probably behind you. Measure a few more directions to be sure.',
    )
    expect(radarStatusText(scan('active', view({ ...answer, quality: 'clear' })), 'chirp', null)).toBe('Loudest to your right.')
  })

  it('detail line: angle and strength, or where to face next', () => {
    expect(radarDirectionText(view({ bearingDeg: 320, headingDeg: 0, contrastDb: 12.4, quality: 'clear' }))).toBe(
      'About 40° left · 12\u00a0dB louder than the quietest side',
    )
    expect(radarDirectionText(view({ bearingDeg: 5, headingDeg: 0, contrastDb: 9, quality: 'clear' }))).toBe(
      'Straight ahead · 9\u00a0dB louder than the quietest side',
    )
    expect(radarDirectionText(view({ suggestDeg: 90, headingDeg: 0 }))).toBe('Next: face the empty side, about 90° right.')
    expect(radarDirectionText(view({ suggestDeg: 180, headingDeg: 0 }))).toBe('Next: face the empty side, behind you.')
    expect(radarDirectionText(view({ suggestDeg: 2, headingDeg: 0 }))).toBe('Next: keep facing this way for the next reading.')
    expect(radarDirectionText(view({ headingDeg: null, bearingDeg: 90, quality: 'clear' }))).toBe('')
    expect(radarDirectionText(view({ quality: 'unclear', suggestDeg: 90 }))).toBe('')
  })
})

describe('static copy', () => {
  it('has the agreed tagline, start button and error actions', () => {
    expect(COPY.tagline).toBe('Follow the beep.')
    expect(COPY.landing.start).toBe('Start listening')
    expect(ERROR_COPY.permission.actions).toEqual(['retry', 'reload'])
    expect(ERROR_COPY.noMic.actions).toEqual(['retry'])
    expect(ERROR_COPY.busy.actions).toEqual(['retry'])
    expect(ERROR_COPY.unsupported.actions).toEqual(['copyLink', 'back'])
  })

  it('uses the audited wording on the hunting, locked, paused and dialog screens', () => {
    expect(COPY.hunting.haptics).toBe('Vibrate')
    expect(COPY.hunting.relisten).toBe('Listen again')
    expect(COPY.hunting.resetBest).toBe('Start over here')
    expect(COPY.locked.notIt).toBe('Wrong sound? Listen again')
    expect(COPY.paused.title).toBe('Paused')
    expect(COPY.paused.resume).toBe('Resume')
    expect(COPY.stopConfirm.title).toBe('Stop hunting? Your readings will be cleared.')
    expect(COPY.relistenConfirm.title).toBe('Listen again? Your readings will be cleared.')
    expect(COPY.relistenConfirm.confirm).toBe('Listen again')
    expect(COPY.landing.steps[1]).toEqual({ title: 'Move', text: 'walk between chirps, freeze during them.' })
    expect(COPY.landing.caption).toBe('Your browser will ask to use the microphone.')
    expect(COPY.landing.station).toBe('Use this device as a station')
    expect(COPY.landing.stationHint).toBe('Leave it in another room to help the main phone compare.')
    expect(COPY.hunting.notHearing).toBe("Can't hear the tone right now")
    expect(COPY.listening.useNow).toBe('Use it now')
    expect(COPY.locked.auto).toBe('Starting automatically…')
    expect(TEXT.wakeLockFailed).toBe('Your screen may go dark while hunting. Tap it now and then to keep it on.')
    expect(TEXT.resetBest).toBe('Cleared. The next chirp is your new starting point.')
    expect(TEXT.stillBlocked).toBe('Still blocked. Change the setting first, then tap Try again.')
    expect(Object.keys(COPY.hunting.tabs)).toEqual(['meter', 'direction', 'log', 'stations'])
  })

  it('explains a blocked microphone for touch browsers, the installed app and desktop', () => {
    expect(errorBody('permission', 'touch')).toBe(PERMISSION_HELP.touch.body)
    expect(PERMISSION_HELP.touch.body).toContain('Tap the icon at the left of the address bar')
    expect(PERMISSION_HELP.standalone.body).not.toContain('address bar')
    expect(PERMISSION_HELP.standalone.hint).not.toContain('address bar')
    expect(errorBody('permission', 'desktop')).toBe(ERROR_COPY.permission.body)
    expect(ERROR_COPY.permission.body).not.toContain('Nothing is recorded')
    expect(PERMISSION_HELP.desktop.hint).toBe(COPY.requesting.hint)
    for (const code of ['noMic', 'busy', 'unsupported'] as const) {
      expect(errorBody(code, 'touch')).toBe(ERROR_COPY[code].body)
    }
  })

  it('describes a beep waiting for confirmation', () => {
    const pending = { f0Hz: 3119.6, snrDb: 16, heardAtMs: 0, sightings: 1 }
    expect(pendingText(pending)).toBe('Heard a beep at 3,120 Hz. Waiting for it again to confirm…')
    expect(pendingSightingsText(1, 2)).toBe('Heard once, just now')
    expect(pendingSightingsText(2, 40.7)).toBe('Heard 2 times, 40 s ago')
    expect(pendingSightingsText(1, 185)).toBe('Heard once, 3 min ago')
    expect(pendingSightingsText(0, Number.NaN)).toBe('Heard once, just now')
  })

  it('labels the tab badges for screen readers', () => {
    expect(tabBadgeLabel('log', 1)).toBe('1 reading')
    expect(tabBadgeLabel('log', 12)).toBe('12 readings')
    expect(tabBadgeLabel('stations', 2)).toBe('2 listening')
    expect(tabName('log', 4)).toBe('Log, 4 readings')
    expect(tabName('log', 0)).toBe('Log')
    expect(tabName('stations', 1)).toBe('Stations, 1 listening')
    expect(tabName('meter', 3)).toBe('Meter')
    expect(tabName('direction', 0)).toBe('Direction')
  })
})

describe('debugText', () => {
  const caps = { secureContext: true, getUserMedia: true, audioContext: true, wakeLock: false, haptics: false, compass: false }
  const BLANK = initialState(caps, { clicks: true, haptics: false }, true, 0)

  it('lists the mic diagnostics, measurements and last chirps', () => {
    const mic: MicDiag = {
      echoCancellation: 'off', noiseSuppression: 'on', autoGainControl: 'unknown', rawAudio: 'partial',
      deviceLabel: 'USB mic', trackSampleRate: 48000, contextSampleRate: 44100, channelCount: 1,
    }
    const chirp = { tOnsetMs: 0, tEndMs: 180, durationMs: 180, peakDb: -52.14, bandFloorDb: -92, snrDb: 39.86, f0Hz: 3120, clipped: true, taintedFrac: 0.25 }
    const hunt: HuntView = { ...chirpView([r('first')]), warmth: 0.62, holdActive: true, missedChirps: 2, chirps: [chirp] }
    const state = { ...BLANK, screen: { kind: 'hunting' } as const, mic, micLevel: 0.5, hunt }
    const text = debugText(state)
    expect(text).toContain('USB mic')
    expect(text).toContain('track 48000 Hz, context 44100 Hz')
    expect(text).toContain('EC off, NS on, AGC unknown')
    expect(text).toContain('level    -90.0 dB, floor -96.0 dB, SNR 6.0 dB')
    expect(text).toContain('warmth   0.62, hold yes')
    expect(text).toContain('missed 2')
    expect(text).toMatch(/-52\.1\s+39\.9\s+180\s+yes\s+25%/)
  })

  it('says when the mic has not started', () => {
    expect(debugText(BLANK)).toContain('not started')
  })
})

// ---- Log -----------------------------------------------------------------------------------------

describe('log copy', () => {
  /** Epoch ms of a local time, so the expected HH:MM:SS does not depend on the machine's time zone. */
  const at = (hh: number, mm: number, ss: number): number => new Date(2026, 8, 21, hh, mm, ss).getTime()

  function entry(extra: Partial<LogEntry> = {}): LogEntry {
    return {
      id: 1,
      wallMs: at(3, 4, 5),
      verdict: 'warmer',
      deltaPrevDb: 4.2,
      pct: 72,
      levelDb: -50,
      f0Hz: 3100,
      clipped: false,
      chirpCount: 1,
      source: 'chirp',
      loudest: null,
      note: '',
      ...extra,
    }
  }
  const first = entry({ id: 0, wallMs: at(3, 3, 30), verdict: 'first', deltaPrevDb: null, pct: null })

  describe('formatClockTime', () => {
    it('formats local time as 24 h HH:MM:SS with leading zeros', () => {
      expect(formatClockTime(at(3, 4, 5))).toBe('03:04:05')
      expect(formatClockTime(at(0, 0, 0))).toBe('00:00:00')
      expect(formatClockTime(at(23, 59, 59))).toBe('23:59:59')
      expect(formatClockTime(at(15, 7, 9) + 999)).toBe('15:07:09')
    })

    it('reads --:--:-- for an invalid time', () => {
      expect(formatClockTime(Number.NaN)).toBe('--:--:--')
      expect(formatClockTime(Number.POSITIVE_INFINITY)).toBe('--:--:--')
    })
  })

  describe('logEntrySummary and logEntryParts', () => {
    it('shows the verdict, the dB change vs the previous reading and the meter position', () => {
      expect(logEntrySummary(entry(), first)).toBe('WARMER · +4 dB · 72 of 100')
      expect(logEntrySummary(entry({ verdict: 'colder', deltaPrevDb: -3.6, pct: 40 }), first)).toBe(
        `COLDER · ${MINUS}4 dB · 40 of 100`,
      )
      // The verdict word is the hero's own label (verdictLabel), whatever its wording.
      expect(logEntrySummary(entry({ verdict: 'same', deltaPrevDb: 0.4, pct: 70 }), first)).toBe(
        `${verdictLabel('same')} · 0 dB · 70 of 100`,
      )
    })

    it('shows just the verdict word for the first reading', () => {
      expect(logEntrySummary(first, null)).toBe(verdictLabel('first'))
      expect(logEntryParts(first, null)).toEqual([])
    })

    it('shows the frequency only when it moved more than 1 % from the previous entry', () => {
      expect(logEntrySummary(entry({ f0Hz: 3130 }), first)).not.toContain('Hz')
      expect(logEntrySummary(entry({ f0Hz: 3132 }), first)).toBe('WARMER · +4 dB · 72 of 100 · 3,132 Hz')
      expect(logEntrySummary(entry({ f0Hz: 3068 }), first)).toContain('3,068 Hz')
      expect(logEntrySummary(entry({ f0Hz: 3500 }), null)).not.toContain('Hz')
      expect(logEntrySummary(entry({ f0Hz: Number.NaN }), first)).not.toContain('Hz')
    })

    it('names the loudest listener, merged chirps and live readings', () => {
      expect(logEntrySummary(entry({ loudest: 'Kitchen', chirpCount: 3 }), first)).toBe(
        'WARMER · +4 dB · 72 of 100 · Loudest: Kitchen · ×3 chirps',
      )
      expect(logEntrySummary(entry({ source: 'train' }), first)).toBe('WARMER · +4 dB · 72 of 100 · Live')
      expect(logEntrySummary(entry({ loudest: '  ' }), first)).not.toContain('Loudest')
    })

    it('marks clipped readings without repeating VERY HOT', () => {
      const clipped = entry({ verdict: 'max', clipped: true, pct: 100, deltaPrevDb: 9 })
      expect(logEntrySummary(clipped, first)).toBe(`${verdictLabel('max')} · clipped · +9 dB · 100 of 100`)
      expect(logClipText(clipped)).toBe(LOG_COPY.clippedShort)
      expect(logClipText(entry({ clipped: true }))).toBe('VERY HOT / clipped')
      expect(logClipText(entry())).toBeNull()
      expect(logEntryParts(clipped, first)).toEqual(['+9 dB', '100 of 100'])
    })
  })

  it('counts readings and labels note fields', () => {
    expect(logCountText(1)).toBe('1 reading')
    expect(logCountText(12)).toBe('12 readings')
    expect(logNoteLabel('03:04:05')).toBe('Note for the 03:04:05 reading')
  })

  describe('logAsText', () => {
    it('exports a header and one line per reading, oldest first, with notes', () => {
      const log = [
        first,
        entry({ note: '  hallway\n door ' }),
        entry({ id: 2, wallMs: at(3, 5, 0), verdict: 'colder', deltaPrevDb: -5, pct: 50, f0Hz: 3180, loudest: 'Bedroom' }),
      ]
      expect(logAsText(log, 3100.4)).toBe(
        [
          'Soundwave log - 3,100 Hz',
          `03:03:30 ${verdictLabel('first')}`,
          '03:04:05 WARMER · +4 dB · 72 of 100 · Note: hallway door',
          `03:05:00 COLDER · ${MINUS}5 dB · 50 of 100 · 3,180 Hz · Loudest: Bedroom`,
        ].join('\n'),
      )
    })

    it('leaves out an unknown frequency and says when there are no readings', () => {
      expect(logAsText([], null)).toBe('Soundwave log\nNo readings yet.')
      expect(logAsText([first], Number.NaN).split('\n')[0]).toBe('Soundwave log')
    })
  })

  it('uses the agreed panel strings', () => {
    expect(LOG_COPY.title).toBe('Log')
    expect(LOG_COPY.copy).toBe('Copy log')
    expect(LOG_COPY.notePlaceholder).toBe('Where were you? e.g. hallway door')
    expect(LOG_COPY.empty).toBe(
      'Each chirp adds a line here. Add a note about where you stood, so you can retrace the warm spots.',
    )
  })

  it('gives the panel whole parts that add up to the summary line', () => {
    // The panel draws the verdict, the clipped marker and each part in its own element, joined by
    // LOG_COPY.sep: the screen and the Copy log export must read the same.
    const cases: [LogEntry, LogEntry | null][] = [
      [first, null],
      [entry({ loudest: 'Upstairs landing', chirpCount: 2, source: 'train', f0Hz: 3300 }), first],
      [entry({ verdict: 'max', clipped: true, pct: 100 }), first],
      [entry({ verdict: 'colder', clipped: true, deltaPrevDb: -2 }), first],
    ]
    for (const [e, prev] of cases) {
      const clip = logClipText(e)
      const pieces = [verdictLabel(e.verdict), ...(clip === null ? [] : [clip]), ...logEntryParts(e, prev)]
      expect(pieces.join(LOG_COPY.sep)).toBe(logEntrySummary(e, prev))
    }
    // 'Loudest: <name>' and '×2 chirps' are single parts, so a row never breaks inside them.
    expect(logEntryParts(cases[1]![0], first)).toEqual([
      '+4 dB',
      '72 of 100',
      '3,300 Hz',
      'Loudest: Upstairs landing',
      '×2 chirps',
      LOG_COPY.live,
    ])
  })
})

// ---- Stations ------------------------------------------------------------------------------------

describe('stations text', () => {
  function listener(id: string, kind: ListenerView['kind'], extra: Partial<ListenerView> = {}): ListenerView {
    return { id, name: id, kind, status: 'listening', levelDb: null, deltaDb: null, isLoudest: false, offsetDb: 0, lastSeenMs: null, ...extra }
  }
  const self = listener('self', 'self', { name: STATIONS_COPY.selfName })
  const kitchen = listener('station-1', 'station', { name: 'Kitchen' })
  const hall = listener('station-2', 'station', { name: 'Hall' })
  function entry(l: ListenerView, levelDb: number, clipped = false): ComparisonEntry {
    return { id: l.id, name: l.name, levelDb, clipped }
  }
  function comparison(ranking: ComparisonEntry[], loudestId: string | null, marginDb: number | null): Comparison {
    return { readingId: 7, tMs: 1000, ranking, loudestId, marginDb }
  }

  it('names kinds and statuses in words', () => {
    expect(listenerKindText('self')).toBe('This phone')
    expect(listenerKindText('mic')).toBe('Microphone')
    expect(listenerKindText('station')).toBe('Station')
    expect(listenerStatusText('listening')).toBe('Listening')
    expect(listenerStatusText('connecting')).toBe('Connecting…')
    expect(listenerStatusText('lost')).toBe('Lost – out of range?')
  })

  it('formats levels in whole dB with a real minus sign', () => {
    expect(listenerLevelText(-42.4)).toBe(`${MINUS}42 dB`)
    expect(listenerLevelText(-41.5)).toBe(`${MINUS}42 dB`)
    expect(listenerLevelText(-0.4)).toBe('0 dB')
    expect(listenerLevelText(3)).toBe('3 dB')
    expect(listenerLevelText(null)).toBe(NO_VALUE)
    expect(listenerLevelText(Number.NaN)).toBe(NO_VALUE)
  })

  it('says loudest, or the difference to the top of the comparison', () => {
    expect(listenerDeltaText({ ...kitchen, levelDb: -40, deltaDb: 0, isLoudest: true })).toBe('loudest')
    expect(listenerDeltaText({ ...hall, levelDb: -46.2, deltaDb: -6.2 })).toBe(`${MINUS}6 dB`)
    expect(listenerDeltaText({ ...hall, levelDb: -40, deltaDb: 0 })).toBe('0 dB')
    // A clipped listener ranks first even when its level reads lower: never show a positive difference.
    expect(listenerDeltaText({ ...hall, levelDb: -38, deltaDb: 2 })).toBe('0 dB')
    expect(listenerDeltaText({ ...hall, levelDb: null, deltaDb: null })).toBe('')
    expect(listenerDeltaText({ ...hall, levelDb: -40, deltaDb: null })).toBe('')
  })

  describe('comparisonHeadline', () => {
    it('explains stations while this phone is the only listener', () => {
      expect(comparisonHeadline(null, [self])).toEqual({ kind: 'empty', title: '', detail: STATIONS_COPY.empty })
      expect(comparisonHeadline(null, [])).toMatchObject({ kind: 'empty' })
    })

    it('waits for a chirp before the first comparison', () => {
      expect(comparisonHeadline(null, [self, kitchen])).toMatchObject({ kind: 'waiting', title: 'Waiting for the next chirp' })
      expect(comparisonHeadline(comparison([], null, null), [self, kitchen])).toMatchObject({ kind: 'waiting' })
    })

    it('names the loudest listener and its margin over the runner-up', () => {
      const c = comparison([entry(kitchen, -40), entry(hall, -48.4), entry(self, -55)], kitchen.id, 8.4)
      expect(comparisonHeadline(c, [self, kitchen, hall])).toEqual({
        kind: 'loudest',
        title: 'Loudest: Kitchen',
        detail: '8 dB louder than Hall',
      })
    })

    it('falls back to the level difference when the margin is missing', () => {
      const c = comparison([entry(kitchen, -40), entry(hall, -45)], kitchen.id, null)
      expect(comparisonHeadline(c, [self, kitchen, hall]).detail).toBe('5 dB louder than Hall')
    })

    it("reads this device's own name in lower case mid-sentence", () => {
      const c = comparison([entry(kitchen, -40), entry(self, -46)], kitchen.id, 6)
      expect(comparisonHeadline(c, [self, kitchen]).detail).toBe('6 dB louder than this phone')
      const mine = comparison([entry(self, -40), entry(kitchen, -46)], self.id, 6)
      expect(comparisonHeadline(mine, [self, kitchen]).title).toBe('Loudest: This phone')
      // A laptop names itself 'This device'.
      const laptop = listener('self', 'self', { name: STATIONS_COPY.selfNameDevice })
      const l = comparison([entry(kitchen, -40), entry(laptop, -46)], kitchen.id, 6)
      expect(comparisonHeadline(l, [laptop, kitchen]).detail).toBe('6 dB louder than this device')
      const close = comparison([entry(kitchen, -40), entry(laptop, -40.5)], null, 0.5)
      expect(comparisonHeadline(close, [laptop, kitchen]).detail).toBe('Kitchen and this device heard it about equally loud.')
      expect(comparisonHeadline(comparison([entry(laptop, -50)], null, null), [laptop, kitchen]).title).toBe('Only this device heard it')
    })

    it('keeps a station that is really called This phone as it is', () => {
      // Only this device's own entry is lower-cased, not a station someone named the same.
      const twin = listener('station-3', 'station', { name: 'This phone' })
      const c = comparison([entry(kitchen, -40), entry(twin, -46)], kitchen.id, 6)
      expect(comparisonHeadline(c, [self, kitchen, twin]).detail).toBe('6 dB louder than This phone')
    })

    it('says too loud to measure when only the loudest clipped', () => {
      const c = comparison([entry(kitchen, -20, true), entry(hall, -19)], kitchen.id, 0)
      expect(comparisonHeadline(c, [self, kitchen, hall])).toEqual({
        kind: 'loudest',
        title: 'Loudest: Kitchen',
        detail: 'Louder than Hall: too loud to measure exactly',
      })
    })

    it('calls it too close when nobody was named', () => {
      const c = comparison([entry(kitchen, -40), entry(self, -41)], null, 1)
      expect(comparisonHeadline(c, [self, kitchen])).toEqual({
        kind: 'close',
        title: 'Too close to call',
        detail: 'Kitchen and this phone heard it about equally loud.',
      })
    })

    it('says when a single listener heard the chirp', () => {
      const c = comparison([entry(self, -50)], null, null)
      expect(comparisonHeadline(c, [self, kitchen])).toMatchObject({ kind: 'single', title: 'Only this phone heard it' })
    })
  })

  it('labels extra microphones and remove buttons', () => {
    expect(micButtonText(' USB Audio ', 0)).toBe('USB Audio')
    expect(micButtonText('', 1)).toBe('Other microphone 2')
    expect(removeListenerLabel('Kitchen', false)).toBe('Remove Kitchen')
    expect(removeListenerLabel('Kitchen', true)).toBe('Tap again to remove Kitchen')
  })

  it('gives every station step a heading', () => {
    const steps: StationStep[] = ['name', 'starting', 'scanOffer', 'pasteOffer', 'answering', 'showAnswer', 'connected', 'lost', 'error']
    for (const step of steps) expect(stationTitle(step)).not.toBe('')
    expect(stationTitle('name')).toBe('Use this device as a station')
    expect(stationTitle('connected')).toBe('Connected')
    expect(stationTitle('lost')).toBe('Connection lost')
  })

  it('describes a connected station', () => {
    expect(stationNameText('Kitchen')).toBe('This station: Kitchen')
    expect(stationFreqText(3100.4)).toBe('Listening at 3,100 Hz')
    expect(stationFreqText(null)).toBe('Waiting for the main phone to lock onto the beep')
    expect(stationFreqText(Number.NaN)).toBe(stationFreqText(null))
    const at = new Date(2026, 8, 21, 14, 32, 5).getTime()
    expect(stationLastChirpText(-42.2, at)).toBe(`${MINUS}42 dB · 14:32:05`)
    expect(stationLastChirpText(-42.2, null)).toBe(`${MINUS}42 dB`)
    expect(stationLastChirpText(null, at)).toBe('None yet')
    expect(stationChirpsText(1204)).toBe('1,204')
    expect(stationChirpsText(0)).toBe('0')
    expect(stationChirpsText(Number.NaN)).toBe('0')
  })

  it('says that only numbers travel between devices, never audio', () => {
    expect(STATIONS_COPY.privacy).toMatch(/never audio/)
    expect(STATIONS_COPY.station.intro).toMatch(/no audio/)
    expect(STATIONS_COPY.station.privacy).toMatch(/never audio/)
  })

  it('tells what to do once the levels are calibrated', () => {
    expect(STATIONS_COPY.calibrated).toMatch(/^Calibrated\./)
    expect(STATIONS_COPY.calibrated).toMatch(/room/)
    expect(STATIONS_COPY.calibrating).not.toBe(STATIONS_COPY.calibrated)
  })

  it('labels the reply code differently from the pairing code', () => {
    expect(STATIONS_COPY.station.answerText).not.toBe(STATIONS_COPY.pair.codeText)
    expect(STATIONS_COPY.station.answerText.startsWith(STATIONS_COPY.station.answerQrLabel)).toBe(true)
  })

  it('never splits Wi-Fi across two lines', () => {
    const all = JSON.stringify(STATIONS_COPY)
    expect(all).toContain('Wi\u2011Fi')
    expect(all).not.toContain('Wi-Fi')
  })
})

// ---- Found it ------------------------------------------------------------------------------------

describe('Found it text', () => {
  const T = 1_758_000_000_000
  const SUMMARY: FoundSummary = {
    foundAtWallMs: T + 380_000,
    startedAtWallMs: T,
    f0Hz: 3100.4,
    mode: 'chirp',
    readings: 14,
    bestLevelDb: -41,
    notes: [],
    loudestListener: null,
    listeners: 1,
  }

  it('formats a duration: seconds only under a minute, then minutes, hours for very long hunts', () => {
    expect(formatDuration(0)).toBe('0 s')
    expect(formatDuration(999)).toBe('0 s')
    expect(formatDuration(45_900)).toBe('45 s')
    expect(formatDuration(59_999)).toBe('59 s')
    expect(formatDuration(60_000)).toBe('1 min')
    expect(formatDuration(380_000)).toBe('6 min 20 s')
    expect(formatDuration(3_599_999)).toBe('59 min 59 s')
    expect(formatDuration(3_600_000)).toBe('1 h')
    expect(formatDuration(3_900_000 + 59_000)).toBe('1 h 5 min')
    expect(formatDuration(7_200_000 + 30_000)).toBe('2 h')
    expect(formatDuration(30 * 3_600_000)).toBe('30 h')
  })

  it('gives no duration for a negative or non-finite time', () => {
    expect(formatDuration(-1)).toBe('')
    expect(formatDuration(Number.NaN)).toBe('')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('')
  })

  it('sums up the hunt: frequency, time and chirps', () => {
    expect(foundSummaryLine(SUMMARY)).toBe('3,100 Hz beep · found in 6 min 20 s · 14 chirps')
    expect(foundSummaryParts(SUMMARY)).toEqual(['3,100 Hz beep', 'found in 6 min 20 s', '14 chirps'])
    expect(foundSummaryLine({ ...SUMMARY, readings: 1, foundAtWallMs: T + 42_000 })).toBe('3,100 Hz beep · found in 42 s · 1 chirp')
    expect(foundSummaryLine({ ...SUMMARY, readings: 1_204, foundAtWallMs: T + 4_000_000 })).toBe(
      '3,100 Hz beep · found in 1 h 6 min · 1,204 chirps',
    )
  })

  it('leaves out what is unknown, starting with a capital', () => {
    expect(foundSummaryLine({ ...SUMMARY, f0Hz: null })).toBe('Found in 6 min 20 s · 14 chirps')
    expect(foundSummaryLine({ ...SUMMARY, startedAtWallMs: null })).toBe('3,100 Hz beep · 14 chirps')
    expect(foundSummaryLine({ ...SUMMARY, readings: 0 })).toBe('3,100 Hz beep · found in 6 min 20 s')
    expect(foundSummaryLine({ ...SUMMARY, f0Hz: null, startedAtWallMs: null })).toBe('14 chirps')
    expect(foundSummaryLine({ ...SUMMARY, f0Hz: null, startedAtWallMs: null, readings: 0 })).toBe('')
    expect(foundSummaryParts({ ...SUMMARY, f0Hz: null, startedAtWallMs: null, readings: 0 })).toEqual([])
  })

  it('never shows a broken number', () => {
    expect(foundSummaryLine({ ...SUMMARY, f0Hz: Number.NaN })).toBe('Found in 6 min 20 s · 14 chirps')
    expect(foundSummaryLine({ ...SUMMARY, f0Hz: 0 })).toBe('Found in 6 min 20 s · 14 chirps')
    // A clock that went backwards (the first reading after the tap) has no duration.
    expect(foundSummaryLine({ ...SUMMARY, startedAtWallMs: T + 400_000 })).toBe('3,100 Hz beep · 14 chirps')
    expect(foundSummaryLine({ ...SUMMARY, readings: Number.NaN })).toBe('3,100 Hz beep · found in 6 min 20 s')
    expect(foundSummaryLine({ ...SUMMARY, readings: -2 })).toBe('3,100 Hz beep · found in 6 min 20 s')
  })

  it('calls a continuous tone a tone and does not count its readings as chirps', () => {
    expect(foundSummaryLine({ ...SUMMARY, mode: 'live' })).toBe('3,100 Hz tone · found in 6 min 20 s')
    expect(foundSummaryLine({ ...SUMMARY, mode: null })).toBe('3,100 Hz beep · found in 6 min 20 s · 14 chirps')
  })

  it('names the loudest listener and how many devices compared', () => {
    expect(foundListenersLine(SUMMARY)).toBe('')
    expect(foundListenersParts(SUMMARY)).toEqual([])
    expect(foundListenersLine({ ...SUMMARY, loudestListener: 'Kitchen' })).toBe('Loudest station at the end: Kitchen')
    expect(foundListenersLine({ ...SUMMARY, listeners: 3 })).toBe('Compared on 3 devices')
    expect(foundListenersLine({ ...SUMMARY, loudestListener: ' Kitchen ', listeners: 3 })).toBe(
      'Loudest station at the end: Kitchen · Compared on 3 devices',
    )
    expect(foundListenersLine({ ...SUMMARY, loudestListener: '   ', listeners: Number.NaN })).toBe('')
  })

  it('has the agreed wording', () => {
    expect(FOUND_COPY.title).toBe('Found it!')
    expect(COPY.hunting.found).toBe('Found it')
    expect(`${FOUND_COPY.tipTitle} ${FOUND_COPY.tip}`).toBe(
      'Smoke or CO alarm? A low-battery chirp stops once you put in a fresh battery. ' +
        'Press its test button afterwards to check it still works.',
    )
    expect(FOUND_COPY.notesTitle).toBe('Where you were')
    expect(FOUND_COPY.keepHint).toBe('Not it after all? Carry on where you left off.')
    expect(FOUND_COPY.keepHintMicOff).toBe('The microphone is off now. Not it after all? Keep hunting turns it back on.')
    expect([FOUND_COPY.done, FOUND_COPY.newHunt, FOUND_COPY.keepHunting, FOUND_COPY.copyLog]).toEqual([
      'Done',
      'New hunt',
      'Keep hunting',
      LOG_COPY.copy,
    ])
  })
})
