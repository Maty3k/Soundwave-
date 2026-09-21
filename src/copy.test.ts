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
} from './copy.ts'
import type { Countdown, HuntView, LiveView, Lock, MicDiag, RadarView, Reading, ScanState, Verdict } from './types.ts'

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
    expect(verdictLabel('same')).toBe('ABOUT THE SAME')
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
    expect(liveDeltaLine(-3, CONFIG.liveRefMs)).toBe(`${MINUS}3 dB vs ${CONFIG.liveRefMs / 1000} s ago`)
    expect(liveDeltaLine(null, CONFIG.liveRefMs)).toBe('')
  })

  it('history items read "pct marker"', () => {
    expect(historyItemText(r('first'))).toBe(`${NO_VALUE} •`)
    expect(historyItemText(r('warmer', 72))).toBe('72 ▲')
    expect(historyItemText(r('colder', 40))).toBe('40 ▼')
    expect(historyItemText(r('same', 55))).toBe('55 =')
    expect(historyItemText(r('warmer', 97, { isNewBest: true }))).toBe('97 ★')
    expect(historyItemText(r('max', 100))).toBe('100 ▲')
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
    expect(countdownText(cd('eta', 36.6, 10))).toBe('Next chirp in ~37 s')
    expect(countdownText(cd('eta', 0.2, 39))).toBe('Next chirp in ~1 s')
    expect(countdownText(cd('hold', 3, 37))).toBe('Hold still…')
    expect(countdownText(cd('late', -1, 41))).toBe('Listening… the chirp is a little late')
    expect(countdownText(cd('overdue', -20, 60))).toBe('Overdue. Chirps can be irregular, so stay still a little longer.')
    expect(countdownText(cd('lost', -90, 130))).toBe("Haven't heard it for 2:10. Keep waiting, or tap Re-listen.")
    expect(countdownText(cd('unknown', null, 52))).toBe('Waiting for the next chirp… 0:52 since the last one')
    expect(countdownText(cd('unknown', null, null))).toBe('Waiting for the first chirp…')
  })

  it('falls back gracefully when a field is missing, and is empty in live mode', () => {
    expect(countdownText(cd('eta', null, 12))).toBe('Waiting for the next chirp… 0:12 since the last one')
    expect(countdownText(cd('lost', null, null))).toBe("Haven't heard it for a while. Keep waiting, or tap Re-listen.")
    expect(countdownText(null)).toBe('')
  })
})

// ---- Guidance ------------------------------------------------------------------------------------

describe('guidanceText', () => {
  const hot = 94 // where a new best lands on the relative meter (best - 45 .. best + 3 dB)
  const cool = hot - 20

  it('first reading: move and wait', () => {
    expect(guidanceText(chirpView([r('first')]))).toBe(GUIDANCE.first)
    expect(GUIDANCE.first).toBe('Now move 2–3 m and wait for the next chirp.')
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
    expect(guidanceText(chirpView([r('first'), r('warmer', hot)]))).toBe(GUIDANCE.default)
    expect(guidanceText(chirpView([r('first'), r('warmer', cool), r('warmer', hot)]))).toBe(GUIDANCE.warmerTwice)
    expect(guidanceText(chirpView([r('first'), r('same', hot)]))).toBe(GUIDANCE.default)
    expect(guidanceText(chirpView([r('first'), r('same', cool), r('same', 100)]))).toBe(GUIDANCE.sameTwice)
  })

  it('live mode: walk slowly, very hot only when clipped', () => {
    const live: LiveView = { levelDb: -50, pct: cool, verdict: 'warmer', deltaDb: 4, clipped: false }
    expect(guidanceText(liveView(live))).toBe(GUIDANCE.live)
    expect(guidanceText(liveView(null))).toBe(GUIDANCE.live)
    expect(guidanceText(liveView({ ...live, pct: 100 }))).toBe(GUIDANCE.live)
    expect(guidanceText(liveView({ ...live, clipped: true, verdict: 'max', pct: 100 }))).toBe(GUIDANCE.veryHot)
  })

  it('default routine otherwise', () => {
    expect(guidanceText(chirpView([]))).toBe(GUIDANCE.default)
    expect(guidanceText(chirpView([r('first'), r('warmer', cool)]))).toBe(GUIDANCE.default)
    expect(guidanceText(chirpView([r('first'), r('same', cool)]))).toBe(GUIDANCE.default)
    expect(guidanceText(chirpView([r('first'), r('colder', cool), r('warmer', cool)]))).toBe(GUIDANCE.default)
    expect(GUIDANCE.default).toBe('Stand still until the next chirp, read the verdict, then move 2–3 m.')
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

  it('detail line: angle and strength, or where to face next', () => {
    expect(radarDirectionText(view({ bearingDeg: 320, headingDeg: 0, contrastDb: 12.4, quality: 'clear' }))).toBe(
      'About 40° left · 12 dB louder than the quietest side',
    )
    expect(radarDirectionText(view({ bearingDeg: 5, headingDeg: 0, contrastDb: 9, quality: 'clear' }))).toBe(
      'Straight ahead · 9 dB louder than the quietest side',
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
