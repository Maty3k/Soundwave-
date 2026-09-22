import { describe, expect, it } from 'vitest'
import { CONFIG, withConfig } from '../config.ts'
import type { Config } from '../config.ts'
import type { Chirp, Frame, HuntEvent, HuntView, Lock, LockMode, Reading } from '../types.ts'
import {
  countdownAt,
  createHunt,
  estimateInterval,
  huntStep,
  huntView,
  reconcileGap,
  resetBest,
  robustStdBins,
  updateRange,
} from './hunt.ts'
import type { HuntState } from './hunt.ts'
import { measureBandAt, median } from './spectrum.ts'
import type { BandMeasurement } from './spectrum.ts'
import { chirpTrain, framesFromSignal, iterateFrames, mulberry32, synthSignal, toneLevelForSnr } from './synth.ts'
import type { FrameOptions, SignalSpec, ToneSpec } from './synth.ts'

const SR = 48000
const N = CONFIG.fftSize
const HOP = CONFIG.hopMs
const NOISE_DB = -60
const F0 = 3100
/** Sine amplitude (dBFS) giving a 30 dB per-bin peak SNR, about 26 dB band SNR. */
const LEVEL = toneLevelForSnr(30, NOISE_DB, N)
/** A sine this loud (dBFS) is hard-clipped by the synthetic ADC. */
const CLIPPING_LEVEL = 6

// ---- Helpers -----------------------------------------------------------------------------------

function lockAt(opts: { f0Hz?: number; mode?: LockMode; tMs?: number; chirps?: readonly Chirp[] } = {}): Lock {
  return {
    f0Hz: opts.f0Hz ?? F0,
    mode: opts.mode ?? 'chirp',
    reason: opts.mode === 'live' ? 'sustained' : 'fast',
    tMs: opts.tMs ?? 0,
    snrDb: 30,
    chirps: opts.chirps ?? [],
  }
}

/** Hand-made chirp (as the detector would hand over) with its onset at tOnsetMs. */
function chirpAt(tOnsetMs: number, peakDb: number, extra: Partial<Chirp> = {}): Chirp {
  const bandFloorDb = -97
  return {
    tOnsetMs,
    tEndMs: tOnsetMs + 150,
    durationMs: 150,
    peakDb,
    bandFloorDb,
    snrDb: peakDb - bandFloorDb,
    f0Hz: F0,
    clipped: false,
    taintedFrac: 0,
    ...extra,
  }
}

function samplesOf(durationS: number, tones: readonly ToneSpec[], extra: Partial<SignalSpec> = {}): Float32Array {
  return synthSignal({ sampleRate: SR, durationS, noiseDb: NOISE_DB, seed: 1, tones, ...extra })
}

function framesOf(samples: Float32Array, opts: FrameOptions = {}): Iterable<Frame> {
  return iterateFrames(samples, SR, { fftSize: N, hopMs: HOP, ...opts })
}

interface Stamped {
  readonly tMs: number
  readonly event: HuntEvent
}

/** Feeds frames through huntStep; returns every event stamped with its frame time. */
function feed(
  state: HuntState,
  frames: Iterable<Frame>,
  cfg: Config = CONFIG,
  onFrame?: (frame: Frame, events: readonly HuntEvent[]) => void,
): Stamped[] {
  const out: Stamped[] = []
  for (const f of frames) {
    const events = huntStep(state, f, cfg)
    for (const event of events) out.push({ tMs: f.tMs, event })
    if (onFrame) onFrame(f, events)
  }
  return out
}

function count(events: readonly Stamped[], type: HuntEvent['type']): number {
  return events.filter((e) => e.event.type === type).length
}

/** Readings as first registered ('reading' events). */
function newReadings(events: readonly Stamped[]): Reading[] {
  const out: Reading[] = []
  for (const { event } of events) if (event.type === 'reading') out.push(event.reading)
  return out
}

function modeEvents(events: readonly Stamped[]): { tMs: number; mode: LockMode }[] {
  const out: { tMs: number; mode: LockMode }[] = []
  for (const { tMs, event } of events) if (event.type === 'mode') out.push({ tMs, mode: event.mode })
  return out
}

/** Adds a sine whose level (dBFS peak) follows straight lines in dB through [timeS, levelDb] points. */
function addEnvelopeTone(x: Float32Array, hz: number, points: readonly (readonly [number, number])[]): void {
  const i0 = Math.round(points[0]![0] * SR)
  const i1 = Math.min(x.length, Math.round(points[points.length - 1]![0] * SR))
  const ramp = Math.round(0.001 * SR)
  let k = 0
  for (let i = i0; i < i1; i++) {
    const t = i / SR
    while (k < points.length - 2 && t >= points[k + 1]![0]) k++
    const [ta, da] = points[k]!
    const [tb, db] = points[k + 1]!
    let amp = 10 ** ((da + ((db - da) * (t - ta)) / (tb - ta)) / 20)
    const fromStart = i - i0
    const fromEnd = i1 - 1 - i
    if (fromStart < ramp) amp *= 0.5 - 0.5 * Math.cos((Math.PI * fromStart) / ramp)
    if (fromEnd < ramp) amp *= 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / ramp)
    x[i] = x[i]! + amp * Math.sin((2 * Math.PI * hz * i) / SR)
  }
}

function lastOf<T>(a: readonly T[]): T {
  return a[a.length - 1]!
}

/** The hunt's own per-frame measurement: band level and noise reference at f0. */
function bandAt(f: Frame, f0Hz: number = F0): BandMeasurement {
  return measureBandAt(f.db, f0Hz / f.binHz, CONFIG.bandBins, CONFIG.floorHalfBins, CONFIG.floorGuardBins, CONFIG.bandFloorOffsetDb)
}

/** Median band level at F0 of a steady tone of levelDb dBFS (the reference for peak hold). */
function steadyBandDb(levelDb: number): number {
  const levels: number[] = []
  for (const f of framesOf(samplesOf(2, [{ hz: F0, levelDb, onS: 0, offS: 2 }]), { startMs: 200 })) levels.push(bandAt(f).levelDb)
  return median(levels)
}

/** A timer stall: frames in (fromMs, toMs] never arrive and the next one comes flagged as a gap. */
function stall(frames: Iterable<Frame>, fromMs: number, toMs: number): Frame[] {
  const out: Frame[] = []
  let pending = false
  for (const f of frames) {
    if (f.tMs > fromMs && f.tMs <= toMs) {
      pending = true
      continue
    }
    const prev = out[out.length - 1]
    out.push(pending && prev !== undefined ? { ...f, gap: true, dtMs: f.tMs - prev.tMs } : f)
    pending = false
  }
  return out
}

// ---- Pure helpers ------------------------------------------------------------------------------

describe('estimateInterval', () => {
  it('returns null without gaps', () => {
    expect(estimateInterval([], CONFIG)).toBeNull()
  })

  it('gives the median and MAD of the gaps and is confident for a steady detector', () => {
    const gaps = [45000, 45500, 43500]
    const med = median(gaps)
    const mad = median(gaps.map((g) => Math.abs(g - med)))
    const est = estimateInterval(gaps, CONFIG)!
    expect(est.medianMs).toBe(med)
    expect(est.madMs).toBe(mad)
    expect(mad / med).toBeLessThan(CONFIG.madRatio)
    expect(est.confident).toBe(true)
  })

  it('is not confident with a single gap or with irregular gaps', () => {
    expect(estimateInterval([45000], CONFIG)!.confident).toBe(false)
    const irregular = [20000, 45000, 70000]
    const est = estimateInterval(irregular, CONFIG)!
    expect(est.madMs / est.medianMs).toBeGreaterThanOrEqual(CONFIG.madRatio)
    expect(est.confident).toBe(false)
  })
})

describe('reconcileGap', () => {
  const med = 45000
  const tol = CONFIG.missedGapTolPct / 100
  const [k2, k3] = CONFIG.missedGapFactors as readonly [number, number]

  it('counts a gap of about 2x the median as one missed chirp', () => {
    const gap = k2 * med + 1000
    expect(reconcileGap(gap, med, CONFIG)).toEqual({ estimateMs: gap / k2, missed: k2 - 1 })
  })

  it('counts a gap of about 3x the median as two missed chirps', () => {
    const gap = k3 * med - 1000
    expect(reconcileGap(gap, med, CONFIG)).toEqual({ estimateMs: gap / k3, missed: k3 - 1 })
  })

  it('accepts gaps up to the tolerance edge and takes unrelated gaps as they are', () => {
    const edge = k2 * med * (1 + tol)
    expect(reconcileGap(edge, med, CONFIG).missed).toBe(k2 - 1)
    const unrelated = (1 + k2) * 0.5 * med // halfway between 1x and 2x
    expect(reconcileGap(unrelated, med, CONFIG)).toEqual({ estimateMs: unrelated, missed: 0 })
    expect(reconcileGap(med + 1000, med, CONFIG)).toEqual({ estimateMs: med + 1000, missed: 0 })
  })

  it('takes the gap as is without a median', () => {
    expect(reconcileGap(2 * med, null, CONFIG)).toEqual({ estimateMs: 2 * med, missed: 0 })
  })
})

describe('updateRange', () => {
  const noise = -100
  const best = -50

  it('starts at the target floor and puts the ceiling above the best', () => {
    const r = updateRange(null, noise, best, CONFIG)
    expect(r.floorDb).toBe(Math.max(noise + CONFIG.rangeFloorOverNoiseDb, best - CONFIG.rangeFloorBelowBestDb))
    expect(r.ceilDb).toBe(best + CONFIG.rangeCeilOverBestDb)
  })

  it('drops the floor to a lower target immediately', () => {
    const prev = { floorDb: -60, ceilDb: best + CONFIG.rangeCeilOverBestDb }
    const r = updateRange(prev, noise, best, CONFIG)
    expect(r.floorDb).toBe(noise + CONFIG.rangeFloorOverNoiseDb)
  })

  it('raises the floor by at most rangeFloorRiseDb per update', () => {
    const prev = updateRange(null, noise, best, CONFIG)
    const louderNoise = noise + 20
    const r = updateRange(prev, louderNoise, best, CONFIG)
    expect(louderNoise + CONFIG.rangeFloorOverNoiseDb).toBeGreaterThan(prev.floorDb + CONFIG.rangeFloorRiseDb)
    expect(r.floorDb).toBeCloseTo(prev.floorDb + CONFIG.rangeFloorRiseDb, 9)
    // Several updates converge on the target.
    let s = r
    for (let i = 0; i < 20; i++) s = updateRange(s, louderNoise, best, CONFIG)
    expect(s.floorDb).toBe(louderNoise + CONFIG.rangeFloorOverNoiseDb)
  })

  it('never gets narrower than rangeMinSpanDb', () => {
    const weakBest = noise + 8
    const r = updateRange(null, noise, weakBest, CONFIG)
    expect(r.ceilDb).toBe(weakBest + CONFIG.rangeCeilOverBestDb)
    expect(r.ceilDb - r.floorDb).toBeCloseTo(CONFIG.rangeMinSpanDb, 9)
  })

  it('follows the best down to best - rangeFloorBelowBestDb when the tone is far above the noise', () => {
    const loudBest = noise + 80
    const r = updateRange(null, noise, loudBest, CONFIG)
    expect(r.floorDb).toBe(loudBest - CONFIG.rangeFloorBelowBestDb)
  })
})

describe('robustStdBins', () => {
  it('ignores one bad edge frame but not a steady glide', () => {
    expect(robustStdBins([-0.3, 0.02, -0.01, 0.03, 0, 1.9])).toBeLessThan(CONFIG.maxFreqStdBins)
    expect(robustStdBins([-3, -2, -1, 0, 1, 2, 3])).toBeGreaterThan(CONFIG.maxFreqStdBins)
    expect(robustStdBins([])).toBe(0)
  })
})

// ---- Segmenter ---------------------------------------------------------------------------------

describe('segmenter', () => {
  it.each([100, 400])('opens within 60 ms of a %i ms chirp and reports an apparent duration of D to D + 90 ms', (d) => {
    for (const startS of [1, 1.007, 1.013]) {
      const hunt = createHunt(lockAt(), CONFIG)
      const events = feed(hunt, framesOf(samplesOf(startS + d / 1000 + 0.5, [{ hz: F0, levelDb: LEVEL, onS: startS, offS: startS + d / 1000 }])))
      expect(count(events, 'onset')).toBe(1)
      const chirps = huntView(hunt, 0, CONFIG).chirps
      expect(chirps).toHaveLength(1)
      const c = chirps[0]!
      const lagMs = c.tOnsetMs - startS * 1000
      expect(lagMs).toBeGreaterThanOrEqual(0)
      expect(lagMs).toBeLessThanOrEqual(60)
      expect(c.durationMs).toBeGreaterThanOrEqual(d)
      expect(c.durationMs).toBeLessThanOrEqual(d + 90)
      expect(c.tEndMs - c.tOnsetMs).toBe(c.durationMs)
      expect(Math.abs(c.f0Hz - F0)).toBeLessThan(2)
      expect(c.clipped).toBe(false)
    }
  })

  it('ignores +20 dB broadband noise bursts', () => {
    const hunt = createHunt(lockAt(), CONFIG)
    const burst = NOISE_DB + 20
    const levels: number[] = []
    const events = feed(
      hunt,
      framesOf(
        samplesOf(6, [], {
          noiseBursts: [
            { atS: 1, ms: 300, levelDb: burst },
            { atS: 2.5, ms: 50, levelDb: burst },
            { atS: 4, ms: 10, levelDb: burst },
          ],
        }),
      ),
      CONFIG,
      () => levels.push(hunt.levelDb),
    )
    expect(events).toEqual([])
    // Not vacuous: the band level itself jumped far beyond the onset threshold (the floor with it).
    expect(Math.max(...levels) - median(levels)).toBeGreaterThan(2 * CONFIG.onsetSnrDb)
  })

  it('ignores a tone 5 % off the locked frequency', () => {
    const hunt = createHunt(lockAt(), CONFIG)
    const loud = toneLevelForSnr(40, NOISE_DB, N)
    const events = feed(hunt, framesOf(samplesOf(2, [{ hz: F0 * 1.05, levelDb: loud, onS: 1, offS: 1.4 }])))
    expect(events).toEqual([])
    expect(huntView(hunt, 2000, CONFIG).chirps).toEqual([])
  })

  it.each([
    [2600, 3600],
    [3050, 3150],
  ])('rejects a speech-like glide %i -> %i Hz over 300 ms that opens a segment', (fromHz, toHz) => {
    const hunt = createHunt(lockAt(), CONFIG)
    const loud = toneLevelForSnr(40, NOISE_DB, N)
    const events = feed(hunt, framesOf(samplesOf(2, [{ hz: fromHz, hzEnd: toHz, levelDb: loud, onS: 1, offS: 1.3 }])))
    expect(count(events, 'onset')).toBe(1) // the band did light up ...
    expect(newReadings(events)).toEqual([]) // ... but validation dropped it
    expect(huntView(hunt, 2000, CONFIG).chirps).toEqual([])
  })

  it('holds the chirp peak at the steady-state band level of the same tone (within 1 dB)', () => {
    const steady = steadyBandDb(LEVEL)
    const hunt = createHunt(lockAt(), CONFIG)
    const readings = newReadings(feed(hunt, framesOf(samplesOf(2, [{ hz: F0, levelDb: LEVEL, onS: 1, offS: 1.2 }]))))
    expect(readings).toHaveLength(1)
    expect(Math.abs(readings[0]!.levelDb - steady)).toBeLessThan(1)
  })

  it('keeps a chirp whole when click-tainted frames are blanked, and reports the tainted share otherwise', () => {
    const samples = samplesOf(3, [{ hz: F0, levelDb: LEVEL, onS: 1, offS: 1.4 }])
    const tainted = (t: number): boolean => t > 1150 && t < 1250
    const blanking = withConfig({ blankTaintedFrames: true })
    const a = createHunt(lockAt(), blanking)
    const eventsA = feed(a, framesOf(samples, { tainted }), blanking)
    expect(newReadings(eventsA)).toHaveLength(1)
    expect(count(eventsA, 'missed')).toBe(0)
    expect(huntView(a, 3000, blanking).chirps[0]!.taintedFrac).toBe(0)

    const b = createHunt(lockAt(), CONFIG)
    expect(newReadings(feed(b, framesOf(samples, { tainted })))).toHaveLength(1)
    expect(huntView(b, 3000, CONFIG).chirps[0]!.taintedFrac).toBeGreaterThan(0)
  })

  it('drops a chirp interrupted by a frame gap with a missed event and no reading', () => {
    const samples = samplesOf(7, [
      { hz: F0, levelDb: LEVEL, onS: 1, offS: 1.4 },
      { hz: F0, levelDb: LEVEL, onS: 5, offS: 5.15 },
    ])
    const stalled = stall(framesOf(samples), 1200, 1400)
    expect(stalled.filter((f) => f.gap)).toHaveLength(1)
    expect(stalled.find((f) => f.gap)!.dtMs).toBeGreaterThan(CONFIG.frameGapAbortMs)
    const hunt = createHunt(lockAt(), CONFIG)
    const events = feed(hunt, stalled)
    expect(count(events, 'missed')).toBe(1)
    expect(count(events, 'onset')).toBe(2) // the tail of the aborted chirp does not reopen
    const readings = newReadings(events)
    expect(readings).toHaveLength(1)
    expect(readings[0]!.tMs).toBeGreaterThan(5000)
    expect(readings[0]!.verdict).toBe('first')
    expect(huntView(hunt, 7000, CONFIG).missedChirps).toBe(1)
  })

  it('restarts the onset run after a frame gap, without a missed event', () => {
    const frames = [...framesOf(samplesOf(2, [{ hz: F0, levelDb: LEVEL, onS: 1, offS: 1.3 }]))]
    const runStart = frames.findIndex((f) => f.tMs >= 1000 && bandAt(f).snrDb >= CONFIG.onsetSnrDb)
    expect(CONFIG.onsetFrames).toBeGreaterThan(1) // otherwise a gap cannot fall inside a run
    const clean = newReadings(feed(createHunt(lockAt(), CONFIG), frames))
    expect(clean).toHaveLength(1)
    expect(clean[0]!.tMs).toBe(frames[runStart]!.tMs)

    const gapAt = runStart + 1 // the run's second frame arrives late
    const hunt = createHunt(lockAt(), CONFIG)
    const events = feed(hunt, frames.map((f, i) => (i === gapAt ? { ...f, gap: true } : f)))
    expect(count(events, 'missed')).toBe(0)
    const readings = newReadings(events)
    expect(readings).toHaveLength(1)
    expect(readings[0]!.tMs).toBeGreaterThan(frames[gapAt]!.tMs)
  })

  it('references a chirp to the median band floor of the preOnsetFloorFrames frames before its onset', () => {
    const frames = [...framesOf(samplesOf(2, [{ hz: F0, levelDb: LEVEL, onS: 1, offS: 1.2 }]))]
    const hunt = createHunt(lockAt(), CONFIG)
    feed(hunt, frames)
    const c = huntView(hunt, 2000, CONFIG).chirps[0]!
    const onset = frames.findIndex((f) => f.tMs === c.tOnsetMs)
    expect(onset).toBeGreaterThan(CONFIG.preOnsetFloorFrames)
    const floors = frames.slice(onset - CONFIG.preOnsetFloorFrames, onset).map((f) => bandAt(f).bandFloorDb)
    expect(c.bandFloorDb).toBe(median(floors))
    expect(c.snrDb).toBe(c.peakDb - c.bandFloorDb)
  })

  it('does not mark a chirp clipped when the mic clips only after the tone has gone off', () => {
    const frames = [...framesOf(samplesOf(2, [{ hz: F0, levelDb: LEVEL, onS: 1, offS: 1.15 }]))]
    // A bump clips the mic in every quiet frame of the 300 ms after the chirp.
    const bumped = frames.map((f) =>
      f.tMs > 1150 && f.tMs < 1450 && bandAt(f).snrDb < CONFIG.offsetSnrDb ? { ...f, clipFrac: 1 } : f,
    )
    const hunt = createHunt(lockAt(), CONFIG)
    const readings = newReadings(feed(hunt, bumped))
    expect(readings).toHaveLength(1)
    expect(readings[0]!.clipped).toBe(false)
    expect(readings[0]!.verdict).toBe('first')
    // Not vacuous: clipped frames were among the off frames that closed the segment.
    const c = huntView(hunt, 2000, CONFIG).chirps[0]!
    const closing = bumped.filter((f) => f.tMs > c.tEndMs && f.tMs <= c.tEndMs + CONFIG.offsetFrames * HOP)
    expect(closing.some((f) => f.clipFrac > CONFIG.clipFraction)).toBe(true)
  })

  it('treats a change of bin width like a frame gap and measures at f0 on the new grid', () => {
    const before = [...framesOf(samplesOf(3, [{ hz: F0, levelDb: LEVEL, onS: 1, offS: 1.4 }]))]
    const sr2 = 44_100
    const after = synthSignal({
      sampleRate: sr2,
      durationS: 4,
      noiseDb: NOISE_DB,
      seed: 2,
      tones: [{ hz: F0, levelDb: LEVEL, onS: 2, offS: 2.15 }],
    })
    const switchMs = 1200 // mid-chirp; the next frame comes one 44.1 kHz FFT length later, not flagged as a gap
    const frames = [
      ...before.filter((f) => f.tMs <= switchMs),
      ...iterateFrames(after, sr2, { fftSize: N, hopMs: HOP, tOffsetMs: switchMs }),
    ]
    expect(frames.some((f) => f.gap)).toBe(false)
    const hunt = createHunt(lockAt(), CONFIG)
    const events = feed(hunt, frames)
    expect(events.map((e) => e.event.type)).toEqual(['onset', 'missed', 'onset', 'reading'])
    const reading = newReadings(events)[0]!
    expect(reading.tMs).toBeGreaterThan(switchMs + 2000)
    const v = huntView(hunt, switchMs + 4000, CONFIG)
    expect(v.chirps).toHaveLength(1)
    expect(Math.abs(v.chirps[0]!.f0Hz - F0)).toBeLessThan(2)
    expect(Math.abs(v.f0Hz - F0)).toBeLessThan(1)
  })

  it('ignores blanked click-tainted frames for onsets and for hearing', () => {
    const blanking = withConfig({ blankTaintedFrames: true })
    // Every third frame carries a click leaking into the band at f0 (+30 dB).
    const leaked = [...framesOf(samplesOf(3, []))].map((f, i) => {
      if (i % 3 !== 0) return f
      const db = f.db.slice()
      const c = Math.round(F0 / f.binHz)
      for (let k = c - 1; k <= c + 1; k++) db[k] = db[k]! + 30
      return { ...f, db, clickTainted: true }
    })
    const heardOnTainted = (cfg: Config): { events: Stamped[]; heard: number } => {
      const hunt = createHunt(lockAt(), cfg)
      let heard = 0
      const events = feed(hunt, leaked, cfg, (f) => {
        if (f.clickTainted && huntView(hunt, f.tMs, cfg).hearing) heard++
      })
      return { events, heard }
    }
    const blanked = heardOnTainted(blanking)
    expect(blanked.events).toEqual([])
    expect(blanked.heard).toBe(0)
    // Not vacuous: without blanking every leaked click reads as hearing the beep.
    const raw = heardOnTainted(CONFIG)
    expect(raw.heard).toBe(leaked.filter((f) => f.clickTainted).length)
  })
})

// ---- Readings ----------------------------------------------------------------------------------

describe('readings', () => {
  // Chirps every 8 s stepping +5, -5, +2 dB, then one clipped chirp.
  const everyS = 8
  const tones: ToneSpec[] = [
    ...chirpTrain({ hz: F0, levelDb: LEVEL, count: 4, everyS, firstS: 1, ms: 150, stepDb: [5, -5, 2] }),
    { hz: F0, levelDb: CLIPPING_LEVEL, onS: 1 + 4 * everyS, offS: 1 + 4 * everyS + 0.15 },
  ]
  let cached: { readings: Reading[]; views: HuntView[]; final: HuntView } | null = null
  function run(): { readings: Reading[]; views: HuntView[]; final: HuntView } {
    if (cached) return cached
    const hunt = createHunt(lockAt(), CONFIG)
    const views: HuntView[] = []
    const events = feed(hunt, framesOf(samplesOf(1 + 4 * everyS + 1.5, tones)), CONFIG, (f, evs) => {
      if (evs.some((e) => e.type === 'reading')) views.push(huntView(hunt, f.tMs, CONFIG))
    })
    cached = { readings: newReadings(events), views, final: huntView(hunt, 40_000, CONFIG) }
    return cached
  }

  it('gives first, warmer (new best), colder and same for +5, -5, +2 dB steps', () => {
    const { readings } = run()
    expect(readings.slice(0, 4).map((r) => r.verdict)).toEqual(['first', 'warmer', 'colder', 'same'])
    expect(readings.slice(0, 4).map((r) => r.isNewBest)).toEqual([false, true, false, false])
    const deltas = readings.slice(1, 4).map((r) => r.deltaPrevDb!)
    ;[5, -5, 2].forEach((step, i) => expect(Math.abs(deltas[i]! - step)).toBeLessThan(1))
    expect(readings[0]!.deltaPrevDb).toBeNull()
    expect(readings.map((r) => r.id)).toEqual([1, 2, 3, 4, 5])
  })

  it('has no percent for the first reading and a percent from the second on', () => {
    const { readings, views } = run()
    expect(readings[0]!.pct).toBeNull()
    expect(views[0]!.warmth).toBeNull() // no click feedback after one reading
    for (const r of readings.slice(1, 4)) {
      expect(r.pct).not.toBeNull()
      expect(r.pct!).toBeGreaterThanOrEqual(0)
      expect(r.pct!).toBeLessThanOrEqual(100)
    }
    expect(readings[1]!.pct!).toBeGreaterThan(readings[2]!.pct!) // the loudest chirp sits highest
    expect(views[1]!.warmth).toBeCloseTo(readings[1]!.pct! / 100, 9)
  })

  it('marks a clipped chirp as max with pct 100 and leaves the best alone', () => {
    const { readings, views, final } = run()
    const clipped = readings[4]!
    expect(clipped.clipped).toBe(true)
    expect(clipped.verdict).toBe('max')
    expect(clipped.pct).toBe(100)
    expect(clipped.isNewBest).toBe(false)
    expect(clipped.levelDb).toBeGreaterThan(readings[1]!.levelDb)
    expect(views[3]!.bestDb).toBe(readings[1]!.levelDb)
    expect(final.bestDb).toBe(readings[1]!.levelDb)
    expect(final.warmth).toBe(1)
  })

  it('moves f0 by f0Alpha toward chirps 10 Hz off the lock', () => {
    const offHz = F0 + 10
    const hunt = createHunt(lockAt(), CONFIG)
    const f0s: number[] = []
    feed(hunt, framesOf(samplesOf(10, chirpTrain({ hz: offHz, levelDb: LEVEL, count: 2, everyS: 7, firstS: 1, ms: 200 }))), CONFIG, (f, evs) => {
      if (evs.some((e) => e.type === 'reading')) f0s.push(huntView(hunt, f.tMs, CONFIG).f0Hz)
    })
    const chirps = huntView(hunt, 10_000, CONFIG).chirps
    expect(chirps).toHaveLength(2)
    expect(Math.abs(chirps[0]!.f0Hz - offHz)).toBeLessThan(1)
    const a = CONFIG.f0Alpha
    expect(f0s[0]).toBeCloseTo((1 - a) * F0 + a * chirps[0]!.f0Hz, 9)
    expect((f0s[0]! - F0) / (offHz - F0)).toBeCloseTo(a, 1)
    expect(f0s[1]).toBeCloseTo((1 - a) * f0s[0]! + a * chirps[1]!.f0Hz, 9)
  })

  it('resetBest clears readings and best but keeps f0, mode and the interval', () => {
    const lock = lockAt({ chirps: [chirpAt(1000, -70), chirpAt(13000, -65), chirpAt(25000, -68), chirpAt(37000, -66)] })
    const hunt = createHunt(lock, CONFIG)
    const before = huntView(hunt, 40_000, CONFIG)
    expect(before.readings).toHaveLength(4)
    expect(before.bestDb).toBe(-65)
    expect(before.countdown!.confident).toBe(true)

    resetBest(hunt, CONFIG)
    const after = huntView(hunt, 40_000, CONFIG)
    expect(after.readings).toEqual([])
    expect(after.last).toBeNull()
    expect(after.bestDb).toBeNull()
    expect(after.warmth).toBeNull()
    expect(after.f0Hz).toBe(before.f0Hz)
    expect(after.mode).toBe(before.mode)
    expect(after.countdown).toEqual(before.countdown)

    // The next chirp is a fresh first reading; the interval keeps counting.
    const events = feed(hunt, framesOf(samplesOf(2, [{ hz: F0, levelDb: LEVEL, onS: 1, offS: 1.15 }]), { tOffsetMs: 48_000 }))
    const next = newReadings(events)
    expect(next).toHaveLength(1)
    expect(next[0]!.verdict).toBe('first')
    expect(next[0]!.pct).toBeNull()
    expect(next[0]!.isNewBest).toBe(false)
    expect(next[0]!.missedBefore).toBe(0)
    expect(next[0]!.id).toBeGreaterThan(4)
    expect(huntView(hunt, 50_000, CONFIG).countdown!.confident).toBe(true)
  })

  it('resetBest in the middle of a burst keeps the interval: the rest of the burst is not a new gap', () => {
    // UPS-like bursts of 4 beeps 1 s apart every 12 s; the user resets after the second beep of burst 2.
    const everyMs = 12_000
    const burst = (startMs: number): number[] => [0, 1000, 2000, 3000].map((d) => startMs + d)
    const heard = [...burst(1000), 13_000, 14_000]
    const hunt = createHunt(lockAt({ chirps: heard.map((t) => chirpAt(t, -70)) }), CONFIG)
    expect(huntView(hunt, 14_500, CONFIG).readings.map((r) => r.chirpCount)).toEqual([4, 2])
    resetBest(hunt, CONFIG)

    // Frames from 14 s: the rest of burst 2 (15, 16 s) and burst 3 (25-28 s).
    const fromMs = 14_000
    const beeps = [15_000, 16_000, ...burst(25_000)]
    const tones = beeps.map((t) => ({ hz: F0, levelDb: LEVEL, onS: (t - fromMs) / 1000, offS: (t - fromMs) / 1000 + 0.15 }))
    const events = feed(hunt, framesOf(samplesOf(15, tones), { tOffsetMs: fromMs }))
    const created = newReadings(events)
    expect(created.map((r) => r.verdict)).toEqual(['first', 'same'])
    const v = huntView(hunt, 29_000, CONFIG)
    expect(v.readings.map((r) => r.chirpCount)).toEqual([2, 4])
    expect(v.readings.map((r) => r.missedBefore)).toEqual([0, 0])
    expect(v.missedChirps).toBe(0)
    expect(v.countdown!.confident).toBe(true)
    expect(Math.abs(v.countdown!.intervalS! - everyMs / 1000)).toBeLessThan(0.1)
    expect(Math.abs(v.countdown!.sinceLastS! - (29_000 - 25_000) / 1000)).toBeLessThan(0.1)
  })

  it('turns the chirps of a lock into the first readings (slow lock: two readings)', () => {
    const hunt = createHunt(lockAt({ chirps: [chirpAt(1000, -70), chirpAt(9000, -64)] }), CONFIG)
    const v = huntView(hunt, 10_000, CONFIG)
    expect(v.readings.map((r) => r.verdict)).toEqual(['first', 'warmer'])
    expect(v.readings.map((r) => r.tMs)).toEqual([1000, 9000])
    expect(v.chirps).toHaveLength(2)
    expect(v.countdown!.intervalS).toBe(8)
    expect(v.countdown!.confident).toBe(false)
  })

  it('keeps the last readingsKept readings and chirpsKept chirps', () => {
    const n = CONFIG.readingsKept + 3
    const chirps = Array.from({ length: n }, (_, i) => chirpAt(1000 + i * 10_000, -70 + (i % 2)))
    const v = huntView(createHunt(lockAt({ chirps }), CONFIG), n * 10_000, CONFIG)
    expect(v.readings.map((r) => r.id)).toEqual(Array.from({ length: CONFIG.readingsKept }, (_, i) => n - CONFIG.readingsKept + 1 + i))
    expect(v.last).toBe(lastOf(v.readings))
    expect(v.chirps).toEqual(chirps.slice(-CONFIG.chirpsKept))
  })

  it('counts a chirp lost to a frame gap once, even when the next gap spans two intervals', () => {
    const everyMs = 10_000
    const hunt = createHunt(lockAt({ chirps: [1000, 11_000, 21_000].map((t) => chirpAt(t, -70)) }), CONFIG)
    // Hunt frames from 25 s on: the chirp due at 31 s is cut by a timer stall, the one at 41 s is heard.
    const fromMs = 25_000
    const samples = samplesOf(17, [
      { hz: F0, levelDb: LEVEL, onS: 6, offS: 6.4 },
      { hz: F0, levelDb: LEVEL, onS: 16, offS: 16.15 },
    ])
    const events = feed(hunt, stall(framesOf(samples, { tOffsetMs: fromMs }), fromMs + 6200, fromMs + 6400))
    expect(count(events, 'missed')).toBe(1)
    const readings = newReadings(events)
    expect(readings).toHaveLength(1)
    const [k2] = CONFIG.missedGapFactors as readonly [number]
    expect(Math.abs(readings[0]!.tMs - 21_000 - k2 * everyMs)).toBeLessThan(200)
    expect(readings[0]!.missedBefore).toBe(k2 - 1)
    const v = huntView(hunt, 42_000, CONFIG)
    expect(v.missedChirps).toBe(k2 - 1) // the 'missed' event and the 2x gap are the same chirp
    expect(Math.abs(v.countdown!.intervalS! - everyMs / 1000)).toBeLessThan(0.1)
  })

  it('counts a skipped chirp from a gap of twice the interval', () => {
    const hunt = createHunt(lockAt({ chirps: [0, 10_000, 20_000, 40_000].map((t) => chirpAt(t, -70)) }), CONFIG)
    const v = huntView(hunt, 41_000, CONFIG)
    expect(v.readings.map((r) => r.missedBefore)).toEqual([0, 0, 0, 1])
    expect(v.missedChirps).toBe(1)
    expect(v.countdown!.intervalS).toBe(10)
  })
})

// ---- Countdown ---------------------------------------------------------------------------------

describe('countdown', () => {
  const onsets = [1000, 13000, 25200, 36800]
  const gaps = onsets.slice(1).map((t, i) => t - onsets[i]!)

  it('walks eta -> hold -> late -> overdue -> lost around the expected chirp', () => {
    const hunt = createHunt(lockAt({ chirps: onsets.map((t) => chirpAt(t, -70)) }), CONFIG)
    const est = estimateInterval(gaps, CONFIG)!
    expect(est.confident).toBe(true)
    const last = lastOf(onsets)
    const expected = last + est.medianMs
    const holdStart = expected - CONFIG.holdStartS * 1000 - 2 * est.madMs
    const holdEnd = expected + Math.max(2 * est.madMs, CONFIG.holdEndMinS * 1000) + CONFIG.holdEndExtraS * 1000
    const overdue = last + CONFIG.overdueX * est.medianMs
    const lost = last + CONFIG.lostX * est.medianMs
    expect(holdEnd).toBeLessThan(overdue) // otherwise there is no 'late' phase to test

    const at = (t: number): { countdown: ReturnType<typeof countdownAt>['countdown']; holdActive: boolean } =>
      countdownAt(hunt, t, CONFIG)
    const eta = at(last + 1000)
    expect(eta.countdown).toEqual({
      kind: 'eta',
      etaS: (expected - last - 1000) / 1000,
      sinceLastS: 1,
      intervalS: est.medianMs / 1000,
      confident: true,
    })
    expect(eta.holdActive).toBe(false)
    expect(at(holdStart - 1).countdown!.kind).toBe('eta')
    expect(at(holdStart)).toMatchObject({ countdown: { kind: 'hold' }, holdActive: true })
    expect(at(expected)).toMatchObject({ countdown: { kind: 'hold', etaS: 0 }, holdActive: true })
    expect(at(holdEnd)).toMatchObject({ countdown: { kind: 'hold' }, holdActive: true })
    expect(at(holdEnd + 1)).toMatchObject({ countdown: { kind: 'late' }, holdActive: false })
    expect(at(holdEnd + 1).countdown!.etaS!).toBeLessThan(0)
    expect(at(overdue).countdown!.kind).toBe('late')
    expect(at(overdue + 1)).toMatchObject({ countdown: { kind: 'overdue' }, holdActive: false })
    expect(at(lost).countdown!.kind).toBe('overdue')
    expect(at(lost + 1)).toMatchObject({ countdown: { kind: 'lost' }, holdActive: false })
    // huntView uses the same countdown: once the hold phase expires without a chirp, clicks resume.
    expect(huntView(hunt, holdEnd + 1, CONFIG).holdActive).toBe(false)
    expect(huntView(hunt, holdStart, CONFIG).holdActive).toBe(true)
  })

  it('is unknown before a confident interval', () => {
    const none = createHunt(lockAt(), CONFIG)
    expect(countdownAt(none, 5000, CONFIG).countdown).toEqual({
      kind: 'unknown',
      etaS: null,
      sinceLastS: null,
      intervalS: null,
      confident: false,
    })
    const one = createHunt(lockAt({ chirps: [chirpAt(1000, -70)] }), CONFIG)
    expect(countdownAt(one, 5000, CONFIG).countdown).toEqual({
      kind: 'unknown',
      etaS: null,
      sinceLastS: 4,
      intervalS: null,
      confident: false,
    })
    const two = createHunt(lockAt({ chirps: [chirpAt(1000, -70), chirpAt(13000, -70)] }), CONFIG)
    expect(countdownAt(two, 15000, CONFIG).countdown).toEqual({
      kind: 'unknown',
      etaS: null,
      sinceLastS: 2,
      intervalS: 12,
      confident: false,
    })
  })

  it('is null in live mode, where nothing is held', () => {
    const hunt = createHunt(lockAt({ mode: 'live' }), CONFIG)
    expect(countdownAt(hunt, 1000, CONFIG)).toEqual({ countdown: null, holdActive: false })
  })

  it('says to stay put once the last beep is longWaitS old and the rhythm is unknown', () => {
    const longMs = CONFIG.longWaitS * 1000
    const one = createHunt(lockAt({ chirps: [chirpAt(1000, -70)] }), CONFIG)
    expect(countdownAt(one, 1000 + longMs - 1, CONFIG)).toMatchObject({ countdown: { kind: 'unknown' }, holdActive: false })
    expect(countdownAt(one, 1000 + longMs, CONFIG)).toEqual({
      countdown: { kind: 'wait', etaS: null, sinceLastS: CONFIG.longWaitS, intervalS: null, confident: false },
      holdActive: true,
    })
    // One gap of 8 minutes (not confident yet): move in the first minute, then stay put.
    const two = createHunt(lockAt({ chirps: [chirpAt(1000, -70), chirpAt(481_000, -70)] }), CONFIG)
    expect(countdownAt(two, 481_000 + 30_000, CONFIG)).toMatchObject({ countdown: { kind: 'unknown' }, holdActive: false })
    expect(countdownAt(two, 481_000 + longMs, CONFIG)).toMatchObject({
      countdown: { kind: 'wait', intervalS: 480 },
      holdActive: true,
    })
    expect(huntView(two, 481_000 + longMs, CONFIG).holdActive).toBe(true)
  })

  it('beeps 7-10 minutes apart: move early, then stay put from 2 MAD before the median until lost', () => {
    const beeps = [0, 480_000, 1_020_000, 1_440_000, 2_010_000] // gaps of 8, 9, 7 and 9.5 min
    const hunt = createHunt(lockAt({ chirps: beeps.map((t) => chirpAt(t, -70)) }), CONFIG)
    const est = estimateInterval(beeps.slice(1).map((t, i) => t - beeps[i]!), CONFIG)!
    expect(est.confident).toBe(true)
    expect(est.medianMs).toBeGreaterThanOrEqual(CONFIG.longWaitS * 1000)
    const last = lastOf(beeps)
    const expected = last + est.medianMs
    const waitFrom = expected - CONFIG.holdStartS * 1000 - 2 * est.madMs
    const lost = last + CONFIG.lostX * est.medianMs
    // These beeps come up to 1.5 min early: the wait starts well before the median.
    expect(expected - waitFrom).toBeGreaterThan(60_000)

    const at = (t: number): ReturnType<typeof countdownAt> => countdownAt(hunt, t, CONFIG)
    expect(at(last + 60_000)).toMatchObject({ countdown: { kind: 'eta', confident: true }, holdActive: false })
    expect(at(waitFrom - 1).countdown!.kind).toBe('eta')
    expect(at(waitFrom)).toMatchObject({ countdown: { kind: 'wait' }, holdActive: true })
    // Where short intervals say 'late' and 'overdue', a long wait just goes on.
    expect(at(expected + 5 * 60_000)).toMatchObject({ countdown: { kind: 'wait' }, holdActive: true })
    expect(at(last + CONFIG.overdueX * est.medianMs + 1)).toMatchObject({ countdown: { kind: 'wait' }, holdActive: true })
    expect(at(lost).countdown!.kind).toBe('wait')
    expect(at(lost + 1)).toMatchObject({ countdown: { kind: 'lost' }, holdActive: false })
  })
})

// ---- Chirp / live mode classifier --------------------------------------------------------------

describe('mode classifier', () => {
  it('keeps a UPS burst (4 beeps 1 s apart) in chirp mode as one reading per burst', () => {
    const beepStarts = [1, 2, 3, 4, 13, 14, 15, 16]
    const tones = beepStarts.map((s) => ({ hz: F0, levelDb: LEVEL, onS: s, offS: s + 0.15 }))
    const hunt = createHunt(lockAt(), CONFIG)
    const events = feed(hunt, framesOf(samplesOf(17.5, tones)))
    expect(modeEvents(events)).toEqual([])
    expect(count(events, 'reading')).toBe(2)
    expect(count(events, 'readingUpdated')).toBe(6)
    const v = huntView(hunt, 17_500, CONFIG)
    expect(v.mode).toBe('chirp')
    expect(v.readings.map((r) => r.chirpCount)).toEqual([4, 4])
    expect(v.readings.map((r) => r.source)).toEqual(['chirp', 'chirp'])
    expect(v.readings[1]!.tMs).toBeGreaterThan(13_000) // a reading keeps its group's first onset
    expect(v.readings[1]!.tMs).toBeLessThan(13_100)
  })

  it('merges a double chirp (2 beeps 0.5 s apart) into one reading, re-judged against the previous reading', () => {
    // The second pair's second beep is 6 dB louder: the merged reading turns from same to warmer.
    const beeps: [number, number][] = [
      [1, 0],
      [1.5, 0],
      [11, 0],
      [11.5, 6],
    ]
    const tones = beeps.map(([s, step]) => ({ hz: F0, levelDb: LEVEL + step, onS: s, offS: s + 0.15 }))
    const hunt = createHunt(lockAt(), CONFIG)
    const events = feed(hunt, framesOf(samplesOf(13, tones)))
    expect(modeEvents(events)).toEqual([])
    const updates = events.flatMap((e) => (e.event.type === 'readingUpdated' ? [e.event.reading] : []))
    expect(updates).toHaveLength(2)
    const created = newReadings(events)
    expect(created.map((r) => r.verdict)).toEqual(['first', 'same'])
    const v = huntView(hunt, 13_000, CONFIG)
    expect(v.readings.map((r) => r.chirpCount)).toEqual([2, 2])
    const [first, second] = v.readings as [Reading, Reading]
    expect(second).toEqual(lastOf(updates))
    expect(second.id).toBe(created[1]!.id)
    expect(second.tMs).toBe(created[1]!.tMs) // keeps the group's first onset
    expect(second.verdict).toBe('warmer')
    expect(second.isNewBest).toBe(true)
    expect(second.deltaPrevDb).toBeCloseTo(second.levelDb - first.levelDb, 9)
    expect(Math.abs(second.deltaPrevDb! - 6)).toBeLessThan(1)
    expect(v.bestDb).toBe(second.levelDb)
    expect(first.verdict).toBe('first') // merging into the first group kept it a first reading
    expect(first.pct).toBeNull()
  })

  it('switches 2 beeps/s for 6 s to live and back after the silence, closing the train as one reading', () => {
    const beeps = 12
    const tones = Array.from({ length: beeps }, (_, i) => ({ hz: F0, levelDb: LEVEL, onS: 1 + i * 0.5, offS: 1.1 + i * 0.5 }))
    const lastEndS = 1.1 + (beeps - 1) * 0.5
    const hunt = createHunt(lockAt(), CONFIG)
    let liveSeen = false
    const events = feed(hunt, framesOf(samplesOf(lastEndS + 4, tones)), CONFIG, (f) => {
      const v = huntView(hunt, f.tMs, CONFIG)
      if (v.mode === 'live') {
        liveSeen = true
        expect(v.countdown).toBeNull()
        expect(v.live).not.toBeNull()
      }
    })
    const modes = modeEvents(events)
    expect(modes.map((m) => m.mode)).toEqual(['live', 'chirp'])
    expect(liveSeen).toBe(true)
    expect(modes[0]!.tMs).toBeGreaterThan(1000 + CONFIG.liveEnterCoverS * 1000)
    expect(modes[0]!.tMs).toBeLessThan(1000 + CONFIG.liveEnterCoverS * 1000 + 200)
    expect(modes[1]!.tMs - lastEndS * 1000).toBeGreaterThanOrEqual(CONFIG.liveExitSilenceS * 1000)
    // The exit frame announces the mode change before the train's reading.
    expect(events.filter((e) => e.tMs === modes[1]!.tMs).map((e) => e.event.type)).toEqual(['mode', 'reading'])
    const trains = newReadings(events).filter((r) => r.source === 'train')
    expect(trains).toHaveLength(1)
    expect(trains[0]!.chirpCount).toBe(beeps)
    expect(trains[0]!.tMs).toBeLessThan(1100) // the train starts with the first beep
    const v = huntView(hunt, (lastEndS + 4) * 1000, CONFIG)
    expect(v.mode).toBe('chirp')
    expect(v.live).toBeNull()
    expect(lastOf(v.readings).source).toBe('train')
    expect(v.countdown!.intervalS).toBeNull() // a train is not a new interval
  })

  it('keeps a single 3.5 s tone in chirp mode as one reading', () => {
    const hunt = createHunt(lockAt(), CONFIG)
    const events = feed(hunt, framesOf(samplesOf(9, [{ hz: F0, levelDb: LEVEL, onS: 1, offS: 4.5 }])))
    expect(modeEvents(events)).toEqual([])
    const readings = newReadings(events)
    expect(readings).toHaveLength(1)
    expect(readings[0]!.chirpCount).toBe(1)
    expect(readings[0]!.source).toBe('chirp')
  })
})

// ---- Live meter --------------------------------------------------------------------------------

describe('live meter', () => {
  it('holds the running max of the band level over liveHoldMs', () => {
    const rng = mulberry32(9)
    const tones: ToneSpec[] = []
    for (let s = 0.3; s < 8; s += 0.3) tones.push({ hz: F0, levelDb: LEVEL + (rng() - 0.5) * 16, onS: s, offS: s + 0.1 })
    const hunt = createHunt(lockAt({ mode: 'live' }), CONFIG)
    const start = huntView(hunt, 0, CONFIG)
    expect(start.mode).toBe('live')
    expect(start.live).not.toBeNull()
    expect(start.warmth).toBeNull()
    const seen: { tMs: number; levelDb: number }[] = []
    let checked = 0
    feed(hunt, framesOf(samplesOf(8, tones)), CONFIG, (f) => {
      const v = huntView(hunt, f.tMs, CONFIG)
      seen.push({ tMs: f.tMs, levelDb: v.levelDb })
      expect(v.mode).toBe('live')
      const held = Math.max(...seen.filter((s) => s.tMs > f.tMs - CONFIG.liveHoldMs).map((s) => s.levelDb))
      expect(v.live!.levelDb).toBe(held)
      expect(v.warmth).not.toBeNull()
      checked++
    })
    expect(checked).toBeGreaterThan(300)
  })

  it('ends a live lock after liveExitSilenceS of silence as one train reading; a stall inside is not a miss', () => {
    const toneEndMs = 2000
    const frames = stall(framesOf(samplesOf(6, [{ hz: F0, levelDb: LEVEL, onS: 0, offS: toneEndMs / 1000 }])), 1000, 1200)
    const hunt = createHunt(lockAt({ mode: 'live', tMs: 0 }), CONFIG)
    const events = feed(hunt, frames)
    expect(events.map((e) => e.event.type)).toEqual(['onset', 'mode', 'reading'])
    const [, mode, reading] = events as [Stamped, Stamped, Stamped]
    expect(mode.event).toEqual({ type: 'mode', mode: 'chirp' })
    expect(reading.tMs).toBe(mode.tMs)
    expect(mode.tMs - toneEndMs).toBeGreaterThanOrEqual(CONFIG.liveExitSilenceS * 1000)
    expect(mode.tMs - toneEndMs).toBeLessThan(CONFIG.liveExitSilenceS * 1000 + 200)
    const r = newReadings(events)[0]!
    expect(r).toMatchObject({ source: 'train', verdict: 'first', tMs: 0, chirpCount: 1, pct: null, clipped: false })
    expect(Math.abs(r.levelDb - steadyBandDb(LEVEL))).toBeLessThan(1)
    const v = huntView(hunt, 6000, CONFIG)
    expect(v.mode).toBe('chirp')
    expect(v.live).toBeNull()
    expect(v.missedChirps).toBe(0)
  })

  it('shows clipping in the live hold as max at 100 % and never takes it as the live best', () => {
    const steady = steadyBandDb(LEVEL)
    const tones: ToneSpec[] = [
      { hz: F0, levelDb: LEVEL, onS: 0, offS: 3 },
      { hz: F0, levelDb: CLIPPING_LEVEL, onS: 3, offS: 4 },
      { hz: F0, levelDb: LEVEL, onS: 4, offS: 9 },
    ]
    const hunt = createHunt(lockAt({ mode: 'live', tMs: 0 }), CONFIG)
    let clippedFrames = 0
    let maxVerdicts = 0
    let heldMax = -Infinity
    const events = feed(hunt, framesOf(samplesOf(9, tones)), CONFIG, (f) => {
      const v = huntView(hunt, f.tMs, CONFIG)
      const live = v.live!
      heldMax = Math.max(heldMax, live.levelDb)
      if (live.clipped) {
        clippedFrames++
        expect(live.pct).toBe(100)
        expect(v.warmth).toBe(1)
        if (live.verdict === 'max') maxVerdicts++
      }
      expect(v.bestDb!).toBeLessThan(steady + CONFIG.deadBandDb)
    })
    expect(modeEvents(events)).toEqual([])
    expect(clippedFrames).toBeGreaterThan(0)
    expect(maxVerdicts).toBeGreaterThan(0)
    expect(heldMax - steady).toBeGreaterThan(CONFIG.rangeMinSpanDb) // the clipped level really was held
    expect(huntView(hunt, 9000, CONFIG).live!.clipped).toBe(false) // released liveHoldMs after the clipping
  })

  it('switches a continuous tone to live, then reads a 10 dB rise over 6 s as warmer, once per liveVerdictMs', () => {
    const onS = 1
    const rampS = 10
    const endS = rampS + 6
    const samples = samplesOf(endS, [])
    addEnvelopeTone(samples, F0, [
      [onS, LEVEL],
      [rampS, LEVEL],
      [endS, LEVEL + 10],
    ])
    const hunt = createHunt(lockAt(), CONFIG)
    const verdicts: { tMs: number; verdict: string; deltaDb: number; heldDb: number }[] = []
    let lastDelta: number | null = null
    const events = feed(hunt, framesOf(samples), CONFIG, (f) => {
      const v = huntView(hunt, f.tMs, CONFIG)
      if (v.live !== null && v.live.deltaDb !== null && v.live.deltaDb !== lastDelta) {
        verdicts.push({ tMs: f.tMs, verdict: v.live.verdict!, deltaDb: v.live.deltaDb, heldDb: v.live.levelDb })
        lastDelta = v.live.deltaDb
      }
    })
    const modes = modeEvents(events)
    expect(modes.map((m) => m.mode)).toEqual(['live'])
    const enteredMs = modes[0]!.tMs
    expect(enteredMs).toBeGreaterThan(onS * 1000 + CONFIG.liveEnterCoverS * 1000)
    expect(enteredMs).toBeLessThan(onS * 1000 + CONFIG.liveEnterCoverS * 1000 + 200)
    expect(newReadings(events)).toEqual([]) // the open segment was abandoned, not read

    // The first verdict needs liveRefMs of history; then one verdict per liveVerdictMs.
    expect(verdicts[0]!.tMs - enteredMs).toBeGreaterThanOrEqual(CONFIG.liveRefMs)
    for (let i = 1; i < verdicts.length; i++) {
      expect(verdicts[i]!.tMs - verdicts[i - 1]!.tMs).toBeGreaterThanOrEqual(CONFIG.liveVerdictMs)
    }
    const expectedTicks = Math.floor((endS * 1000 - enteredMs - CONFIG.liveRefMs) / CONFIG.liveVerdictMs)
    expect(verdicts.length).toBeGreaterThanOrEqual(expectedTicks)

    // Steady tone: about the same; the reference sample inside the ramp: warmer.
    const steady = verdicts.filter((v) => v.tMs <= rampS * 1000)
    expect(steady.length).toBeGreaterThan(0)
    for (const v of steady) expect(v.verdict).toBe('same')
    const final = lastOf(verdicts)
    expect(final.verdict).toBe('warmer')
    expect(final.deltaDb).toBeGreaterThan(CONFIG.deadBandDb)
    const v = huntView(hunt, endS * 1000, CONFIG)
    expect(v.live!.verdict).toBe('warmer')
    expect(v.warmth).not.toBeNull()
    expect(v.bestDb).toBe(final.heldDb) // still rising: the best is the held level at the last tick
  })
})

// ---- Whole pipeline ----------------------------------------------------------------------------

describe('whole pipeline', () => {
  it('turns a lock plus a chirp train with +-5 dB steps into the expected readings and countdown', () => {
    const everyS = 10
    const samples = samplesOf(
      44,
      chirpTrain({ hz: F0, levelDb: LEVEL, count: 5, everyS, firstS: 1, ms: 150, stepDb: [5, -5, -5, 5] }),
    )
    const frames = framesFromSignal(samples, SR, { fftSize: N, hopMs: HOP })

    // The detector heard the first chirp while listening: take it from a scratch hunt.
    const scratch = createHunt(lockAt(), CONFIG)
    feed(scratch, frames.filter((f) => f.tMs < 2000))
    const heard = huntView(scratch, 2000, CONFIG).chirps
    expect(heard).toHaveLength(1)
    const lock = lockAt({ tMs: heard[0]!.tEndMs + 100, chirps: heard })

    const hunt = createHunt(lock, CONFIG)
    expect(huntView(hunt, lock.tMs, CONFIG).readings.map((r) => r.verdict)).toEqual(['first'])
    const afterReading: HuntView[] = []
    const between: HuntView[] = []
    let onsetViews = 0
    feed(
      hunt,
      frames.filter((f) => f.tMs > lock.tMs),
      CONFIG,
      (f, evs) => {
        const v = huntView(hunt, f.tMs, CONFIG)
        if (evs.some((e) => e.type === 'onset')) {
          expect(v.holdActive).toBe(true) // a chirp in progress silences the clicks
          expect(v.hearing).toBe(true)
          onsetViews++
        }
        if (evs.some((e) => e.type === 'reading')) afterReading.push(v)
        const last = v.last
        if (last !== null && f.tMs - last.tMs >= 2000 && f.tMs - last.tMs < 2000 + HOP) between.push(v)
      },
    )
    expect(onsetViews).toBe(4)
    const v = huntView(hunt, 44_000, CONFIG)
    expect(v.readings.map((r) => r.verdict)).toEqual(['first', 'warmer', 'colder', 'colder', 'warmer'])
    expect(v.readings.map((r) => r.isNewBest)).toEqual([false, true, false, false, false])
    expect(v.readings.map((r) => r.missedBefore)).toEqual([0, 0, 0, 0, 0])
    expect(v.missedChirps).toBe(0)
    expect(v.bestDb).toBe(v.readings[1]!.levelDb)

    // afterReading[i] is the view right after reading #(i + 2): 1, 2, 3, 4 gaps.
    expect(afterReading.map((a) => a.countdown!.confident)).toEqual([false, true, true, true])
    for (const a of afterReading) expect(Math.abs(a.countdown!.intervalS! - everyS)).toBeLessThan(0.1)
    // Two seconds after a reading with a confident interval: counting down to the next chirp.
    const counting = between.filter((b) => b.countdown!.confident)
    expect(counting.length).toBeGreaterThanOrEqual(3)
    for (const b of counting) {
      expect(b.countdown!.kind).toBe('eta')
      expect(Math.abs(b.countdown!.etaS! - (everyS - 2))).toBeLessThan(0.2)
      expect(b.holdActive).toBe(false)
    }
  })

  it('stays silent through five minutes of pure noise', () => {
    const hunt = createHunt(lockAt(), CONFIG)
    let onsets = 0
    let events = 0
    for (let minute = 0; minute < 5; minute++) {
      const samples = synthSignal({ sampleRate: SR, durationS: 60, noiseDb: NOISE_DB, seed: 500 + minute })
      for (const e of feed(hunt, framesOf(samples, { tOffsetMs: minute * 60_000 }))) {
        events++
        if (e.event.type === 'onset') onsets++
      }
    }
    const v = huntView(hunt, 300_000, CONFIG)
    expect(onsets).toBe(0)
    expect(events).toBe(0)
    expect(v.readings).toEqual([])
    expect(v.mode).toBe('chirp')
  }, 30_000) // about 15,000 reference-FFT frames; slower when other suites run in parallel
})
