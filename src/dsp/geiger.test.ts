import { beforeAll, describe, expect, it } from 'vitest'
import { CONFIG, withConfig } from '../config.ts'
import type { Config } from '../config.ts'
import type { Frame } from '../types.ts'
import {
  carrierQualifies,
  chooseClickFreq,
  chooseClickFreqSticky,
  CLICK_CURVE_POINTS,
  clickRateHz,
  dbToGain,
  effectiveMaxClickHz,
  hannClickCurve,
  minClearanceHz,
  nextClickDelayS,
  vibrationTier,
} from './geiger.ts'
import { measureBandAt } from './spectrum.ts'
import { framesFromSignal, mulberry32, synthSignal } from './synth.ts'
import type { BurstSpec } from './synth.ts'

const SR = 48000
const NOISE_DB = -60
/** f0 grid step for sweeps over the search band. */
const F0_STEP_HZ = 5
/** Carrier list of the worked examples, pinned so tuning CONFIG.clickCarriersHz cannot break them. */
const PLAN_CARRIERS_HZ = [900, 700, 1100, 500, 1300, 6000]

/** Smallest distance (Hz) from f0 to harmonics 1..clickHarmonics of a carrier (independent of geiger.ts). */
function nearestHarmonicHz(carrierHz: number, f0Hz: number, cfg: Config): number {
  let d = Number.POSITIVE_INFINITY
  for (let h = 1; h <= cfg.clickHarmonics; h++) d = Math.min(d, Math.abs(h * carrierHz - f0Hz))
  return d
}

function clears(carrierHz: number, f0Hz: number, cfg: Config): boolean {
  return (
    nearestHarmonicHz(carrierHz, f0Hz, cfg) >= 2 / (cfg.clickMs / 1000) &&
    Math.abs(carrierHz - f0Hz) >= cfg.clickMinCarrierDistanceHz
  )
}

/**
 * Checks chooseClickFreq for every f0 of the search band against an independent statement of the
 * rule: the first qualifying carrier, else the farthest one (first on a tie). Returns how many f0
 * values needed the fallback and how many of those did not simply return the first carrier.
 */
function sweepCarrierRule(cfg: Config): { checked: number; fallbacks: number; nonTrivialFallbacks: number } {
  const [lo, hi] = cfg.searchBandHz
  const carriers = cfg.clickCarriersHz
  let checked = 0
  let fallbacks = 0
  let nonTrivialFallbacks = 0
  for (let f0 = lo; f0 <= hi; f0 += F0_STEP_HZ) {
    const c = chooseClickFreq(f0, cfg)
    expect(carriers).toContain(c)
    const firstQualifying = carriers.find((k) => clears(k, f0, cfg))
    if (firstQualifying === undefined) {
      fallbacks++
      const dists = carriers.map((k) => nearestHarmonicHz(k, f0, cfg))
      const farthest = carriers[dists.indexOf(Math.max(...dists))]
      expect(c).toBe(farthest)
      if (c !== carriers[0]) nonTrivialFallbacks++
    } else {
      expect(c).toBe(firstQualifying)
      expect(clears(c, f0, cfg)).toBe(true)
    }
    checked++
  }
  expect(checked).toBe((hi - lo) / F0_STEP_HZ + 1)
  return { checked, fallbacks, nonTrivialFallbacks }
}

describe('clickRateHz', () => {
  it('spans clickMinHz at warmth 0 to clickMaxHz at warmth 1', () => {
    expect(clickRateHz(0, CONFIG)).toBeCloseTo(CONFIG.clickMinHz, 12)
    expect(clickRateHz(1, CONFIG)).toBeCloseTo(CONFIG.clickMaxHz, 12)
  })

  it('is strictly increasing and exponential (constant ratio per warmth step)', () => {
    const steps = 20
    const rates = Array.from({ length: steps + 1 }, (_, i) => clickRateHz(i / steps, CONFIG))
    const ratio = (CONFIG.clickMaxHz / CONFIG.clickMinHz) ** (1 / steps)
    for (let i = 1; i <= steps; i++) {
      expect(rates[i]!).toBeGreaterThan(rates[i - 1]!)
      expect(rates[i]! / rates[i - 1]!).toBeCloseTo(ratio, 12)
    }
  })

  it('has its midpoint at the geometric mean sqrt(min * max)', () => {
    const mid = clickRateHz(0.5, CONFIG)
    expect(mid).toBeCloseTo(Math.sqrt(CONFIG.clickMinHz * CONFIG.clickMaxHz), 12)
    const oneToTwelve = withConfig({ clickMinHz: 1, clickMaxHz: 12 })
    expect(clickRateHz(0.5, oneToTwelve)).toBeCloseTo(3.4641, 4)
  })

  it('normalises by clickMinHz (a minimum other than 1 still spans min..max geometrically)', () => {
    // With clickMinHz = 1 a formula that forgets the division (min * max ^ w) is indistinguishable.
    const cfg = withConfig({ clickMinHz: 2, clickMaxHz: 8 })
    expect(clickRateHz(0, cfg)).toBeCloseTo(cfg.clickMinHz, 12)
    expect(clickRateHz(1, cfg)).toBeCloseTo(cfg.clickMaxHz, 12)
    expect(clickRateHz(0.5, cfg)).toBeCloseTo(Math.sqrt(cfg.clickMinHz * cfg.clickMaxHz), 12)
    expect(clickRateHz(0.25, cfg)).toBeCloseTo(cfg.clickMinHz * (cfg.clickMaxHz / cfg.clickMinHz) ** 0.25, 12)
    const blank = withConfig({ clickMinHz: 2, clickMaxHz: 12, blankTaintedFrames: true, blankingClickMaxHz: 8 })
    expect(clickRateHz(1, blank)).toBeCloseTo(blank.blankingClickMaxHz, 12)
    expect(clickRateHz(0.5, blank)).toBeCloseTo(Math.sqrt(blank.clickMinHz * blank.blankingClickMaxHz), 12)
  })

  it('clamps warmth outside [0, 1] and treats NaN as 0', () => {
    expect(clickRateHz(-0.5, CONFIG)).toBe(clickRateHz(0, CONFIG))
    expect(clickRateHz(1.7, CONFIG)).toBe(clickRateHz(1, CONFIG))
    expect(clickRateHz(Number.NaN, CONFIG)).toBe(clickRateHz(0, CONFIG))
  })

  it('caps the maximum at blankingClickMaxHz when tainted frames are blanked', () => {
    const blank = withConfig({ blankTaintedFrames: true })
    const cap = Math.min(CONFIG.clickMaxHz, CONFIG.blankingClickMaxHz)
    expect(effectiveMaxClickHz(CONFIG)).toBe(CONFIG.clickMaxHz)
    expect(effectiveMaxClickHz(blank)).toBe(cap)
    expect(clickRateHz(1, blank)).toBeCloseTo(cap, 12)
    expect(clickRateHz(0, blank)).toBeCloseTo(CONFIG.clickMinHz, 12)
    // The blanking cap only ever lowers the rate.
    const looseCap = withConfig({ blankTaintedFrames: true, blankingClickMaxHz: CONFIG.clickMaxHz * 2 })
    expect(effectiveMaxClickHz(looseCap)).toBe(CONFIG.clickMaxHz)
  })
})

describe('nextClickDelayS', () => {
  const DRAWS = 100_000
  const MEAN_TOL = 0.03
  const { clickMinGapS: minGap, clickMaxGapS: maxGap } = CONFIG

  /** Exact mean of min(minGap + s * Exp(1), maxGap) with s = 1 / rate - minGap. */
  function cappedMeanS(rateHz: number): number {
    const s = 1 / rateHz - minGap
    return minGap + s * (1 - Math.exp(-(maxGap - minGap) / s))
  }

  it.each([1.5, 4, 12])('has sample mean within 3 %% of the expected gap at %s Hz, inside [min, max] gap', (rate) => {
    const rng = mulberry32(1000 + rate * 10)
    let sum = 0
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (let i = 0; i < DRAWS; i++) {
      const d = nextClickDelayS(rate, rng(), CONFIG)
      sum += d
      lo = Math.min(lo, d)
      hi = Math.max(hi, d)
    }
    const mean = sum / DRAWS
    const expected = cappedMeanS(rate)
    expect(Math.abs(mean - expected) / expected).toBeLessThan(MEAN_TOL)
    // The cap only matters near the lowest rates; above that the mean is 1 / rate itself.
    if (Math.abs(expected - 1 / rate) / (1 / rate) < 1e-3) {
      expect(Math.abs(mean - 1 / rate) / (1 / rate)).toBeLessThan(MEAN_TOL)
    }
    expect(lo).toBeGreaterThanOrEqual(minGap)
    expect(hi).toBeLessThanOrEqual(maxGap)
  })

  it('is noticeably trimmed by the cap at the lowest rate (why the analytic mean is used there)', () => {
    expect(cappedMeanS(1.5)).toBeLessThan((1 / 1.5) * (1 - MEAN_TOL))
  })

  it('is the exact inverse CDF of the shifted exponential (quantiles pinned)', () => {
    // The 3 % mean test cannot tell a slightly wrong distribution apart; pin the quantiles exactly.
    const rate = 4
    const scale = 1 / rate - minGap
    expect(nextClickDelayS(rate, 1 - Math.exp(-1), CONFIG)).toBeCloseTo(minGap + scale, 12)
    expect(nextClickDelayS(rate, 0.5, CONFIG)).toBeCloseTo(minGap + scale * Math.LN2, 12)
    expect(nextClickDelayS(rate, 0.9, CONFIG)).toBeCloseTo(minGap + scale * Math.log(10), 12)
  })

  it('maps u = 0 to the minimum gap and u -> 1 to the cap', () => {
    expect(nextClickDelayS(4, 0, CONFIG)).toBe(minGap)
    expect(nextClickDelayS(4, 1 - 2 ** -53, CONFIG)).toBe(maxGap)
    expect(nextClickDelayS(4, 1, CONFIG)).toBe(maxGap)
    expect(nextClickDelayS(4, -0.5, CONFIG)).toBe(minGap)
  })

  it('returns exactly clickMinGapS when 1 / rate <= clickMinGapS', () => {
    const rng = mulberry32(77)
    for (const rate of [1 / minGap, 4 / minGap]) {
      for (let i = 0; i < 1000; i++) expect(nextClickDelayS(rate, rng(), CONFIG)).toBe(minGap)
    }
  })

  it('returns clickMaxGapS for a zero, negative or NaN rate', () => {
    expect(nextClickDelayS(0, 0.5, CONFIG)).toBe(maxGap)
    expect(nextClickDelayS(-3, 0.5, CONFIG)).toBe(maxGap)
    expect(nextClickDelayS(Number.NaN, 0.5, CONFIG)).toBe(maxGap)
  })

  it('takes the floor and the cap from the config it is given', () => {
    const cfg = withConfig({ clickMinGapS: 0.1, clickMaxGapS: 1 })
    const rate = 5
    const scale = 1 / rate - cfg.clickMinGapS
    expect(nextClickDelayS(rate, 0, cfg)).toBe(cfg.clickMinGapS)
    expect(nextClickDelayS(rate, 1 - Math.exp(-1), cfg)).toBeCloseTo(cfg.clickMinGapS + scale, 12)
    expect(nextClickDelayS(rate, 1, cfg)).toBe(cfg.clickMaxGapS)
    expect(nextClickDelayS(1 / cfg.clickMinGapS, 0.5, cfg)).toBe(cfg.clickMinGapS)
    expect(nextClickDelayS(0, 0.5, cfg)).toBe(cfg.clickMaxGapS)
  })
})

describe('chooseClickFreqSticky', () => {
  it('keeps the current carrier while it still qualifies, even where the plain choice would differ', () => {
    // Find an f0 where the first qualifying carrier differs from a still-qualifying current one.
    const [lo, hi] = CONFIG.searchBandHz
    let checked = 0
    for (let f0 = lo; f0 <= hi; f0 += 5) {
      const plain = chooseClickFreq(f0, CONFIG)
      for (const current of CONFIG.clickCarriersHz) {
        if (current === plain || !carrierQualifies(current, f0, CONFIG)) continue
        expect(chooseClickFreqSticky(f0, current, CONFIG)).toBe(current)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('switches when the current carrier stops qualifying, and chooses normally without one', () => {
    for (const f0 of [1600, 2400, 3100, 4500]) {
      expect(chooseClickFreqSticky(f0, null, CONFIG)).toBe(chooseClickFreq(f0, CONFIG))
      const bad = CONFIG.clickCarriersHz.find((c) => !carrierQualifies(c, f0, CONFIG))
      if (bad !== undefined) expect(chooseClickFreqSticky(f0, bad, CONFIG)).toBe(chooseClickFreq(f0, CONFIG))
    }
  })

  it('carrierQualifies requires both the harmonic clearance and the fundamental distance', () => {
    const f0 = 2000
    // 1100 Hz: harmonics 1100, 2200 (200 Hz away) -> fails the harmonic clearance.
    expect(carrierQualifies(1100, f0, CONFIG)).toBe(false)
    // 1500 Hz: nearest harmonic 1500 (500 Hz away, clears 400) but the fundamental is only 500 Hz away.
    expect(carrierQualifies(1500, f0, withConfig({ clickCarriersHz: [1500] }))).toBe(false)
    expect(carrierQualifies(1500, f0, withConfig({ clickMinCarrierDistanceHz: 400 }))).toBe(true)
  })
})

describe('minClearanceHz', () => {
  it('is the main-lobe half-width 2 / clickLength of a Hann burst', () => {
    expect(minClearanceHz(CONFIG)).toBeCloseTo(2 / (CONFIG.clickMs / 1000), 9)
    expect(minClearanceHz(withConfig({ clickMs: 5 }))).toBe(400)
    expect(minClearanceHz(withConfig({ clickMs: 4 }))).toBe(500)
  })
})

describe('chooseClickFreq', () => {
  it('picks the first carrier whose harmonics clear f0 everywhere in the search band', () => {
    const { fallbacks } = sweepCarrierRule(CONFIG)
    // With the default carriers every f0 in 1.5-6 kHz has a clear carrier: no fallbacks at all.
    expect(fallbacks).toBe(0)
  })

  it('falls back correctly across the band when few carriers are configured', () => {
    // The default sweep never reaches the fallback branch, so exercise it with a short list.
    const { fallbacks, nonTrivialFallbacks } = sweepCarrierRule(withConfig({ clickCarriersHz: [900, 700, 1100] }))
    expect(fallbacks).toBeGreaterThan(0)
    expect(nonTrivialFallbacks).toBeGreaterThan(0)
  })

  it('matches the worked examples: 3100 Hz -> 900 Hz, 3000 Hz -> 1300 Hz', () => {
    const cfg = withConfig({ clickMs: 5, clickHarmonics: 6, clickCarriersHz: PLAN_CARRIERS_HZ })
    // 900 x 3 = 2700 is exactly 400 Hz from 3100 (on the clearance edge); 900 x 4 = 3600 is 500 Hz away.
    expect(chooseClickFreq(3100, cfg)).toBe(900)
    // 2700, 2800, 3300 and 3000 are too close to 3000; 1300 x 2 = 2600 is 400 Hz away.
    expect(chooseClickFreq(3000, cfg)).toBe(1300)
    expect(chooseClickFreq(3100, CONFIG)).toBe(chooseClickFreq(3100, cfg))
    expect(chooseClickFreq(3000, CONFIG)).toBe(chooseClickFreq(3000, cfg))
  })

  it('takes the clearance from clickMs and the harmonic count from clickHarmonics', () => {
    // A 4 ms click needs 500 Hz: 900 x 3 = 2700 no longer clears 3100, and 1300 (2600, 3900) does.
    expect(chooseClickFreq(3100, withConfig({ clickMs: 4, clickCarriersHz: PLAN_CARRIERS_HZ }))).toBe(1300)
    // f0 2700 = 900 x 3: fine when only harmonics 1..2 count, disqualifying from 3 on.
    const two = withConfig({ clickCarriersHz: [900, 1300], clickHarmonics: 2 })
    const three = withConfig({ clickCarriersHz: [900, 1300], clickHarmonics: 3 })
    expect(chooseClickFreq(2700, two)).toBe(900)
    expect(chooseClickFreq(2700, three)).toBe(1300)
  })

  it('falls back to the carrier whose nearest harmonic is farthest from f0 (first on a tie)', () => {
    // f0 2900: 900 has 2700 at 200 Hz, 1000 has 3000 at 100 Hz; neither clears 400 Hz.
    expect(chooseClickFreq(2900, withConfig({ clickCarriersHz: [1000, 900] }))).toBe(900)
    expect(chooseClickFreq(2900, withConfig({ clickCarriersHz: [900, 1000] }))).toBe(900)
    // f0 3000: 950 has 2850 at 150 Hz and 1050 has 3150 at 150 Hz: a tie keeps the first.
    expect(chooseClickFreq(3000, withConfig({ clickCarriersHz: [1050, 950] }))).toBe(1050)
  })

  it('throws when no carriers are configured', () => {
    expect(() => chooseClickFreq(3100, withConfig({ clickCarriersHz: [] }))).toThrow(RangeError)
  })
})

describe('click leakage into the measured band (reference analyser)', () => {
  const F0 = 3100
  const DURATION_S = 3
  const SEED = 7
  /** Largest allowed rise of the mean band level at f0 (plan: self-noise < 1 dB). */
  const MAX_RISE_DB = 1

  /** Click onsets over DURATION_S at the fastest configured rate, timed by the app's own sampler. */
  function clickTimes(): number[] {
    const rng = mulberry32(99)
    const rate = clickRateHz(1, CONFIG)
    const times: number[] = []
    for (let t = nextClickDelayS(rate, rng(), CONFIG); t < DURATION_S; t += nextClickDelayS(rate, rng(), CONFIG)) times.push(t)
    return times
  }

  function clicksAt(hz: number, levelDb: number = CONFIG.clickGainDb): BurstSpec[] {
    return clickTimes().map((atS) => ({ atS, hz, ms: CONFIG.clickMs, levelDb }))
  }

  /** Reference-analyser frames of the fixture noise plus `bursts`. */
  function analyse(bursts: readonly BurstSpec[]): Frame[] {
    const s = synthSignal({ sampleRate: SR, durationS: DURATION_S, noiseDb: NOISE_DB, seed: SEED, bursts })
    return framesFromSignal(s, SR, { fftSize: CONFIG.fftSize, hopMs: CONFIG.hopMs })
  }

  /** Mean band level at f0Hz over all frames, averaged in the power domain, in dB. */
  function meanBandAt(frames: readonly Frame[], f0Hz: number): number {
    let sum = 0
    for (const f of frames) {
      const m = measureBandAt(f.db, f0Hz / f.binHz, CONFIG.bandBins, CONFIG.floorHalfBins, CONFIG.floorGuardBins, CONFIG.bandFloorOffsetDb)
      sum += 10 ** (m.levelDb / 10)
    }
    return 10 * Math.log10(sum / frames.length)
  }

  const meanBandDb = (bursts: readonly BurstSpec[]): number => meanBandAt(analyse(bursts), F0)

  let quietFrames: Frame[] = []
  let quiet = 0
  beforeAll(() => {
    quietFrames = analyse([])
    quiet = meanBandAt(quietFrames, F0)
  })

  it('plays about clickMaxHz clicks per second in the fixture', () => {
    const n = clickTimes().length
    expect(n).toBeGreaterThan(0.8 * CONFIG.clickMaxHz * DURATION_S)
    expect(n).toBeLessThan(1.2 * CONFIG.clickMaxHz * DURATION_S)
  })

  it('raises the band at f0 by less than 1 dB with clicks on the chosen carrier', () => {
    const carrier = chooseClickFreq(F0, CONFIG)
    expect(meanBandDb(clicksAt(carrier)) - quiet).toBeLessThan(MAX_RISE_DB)
  })

  it('still stays under 1 dB with distortion products 20 dB below the click at harmonics 2..clickHarmonics', () => {
    const DISTORTION_DB = -20 // assumed per-harmonic loudspeaker distortion relative to the click
    const carrier = chooseClickFreq(F0, CONFIG)
    const bursts = clicksAt(carrier)
    for (let h = 2; h <= CONFIG.clickHarmonics; h++) bursts.push(...clicksAt(carrier * h, CONFIG.clickGainDb + DISTORTION_DB))
    expect(meanBandDb(bursts) - quiet).toBeLessThan(MAX_RISE_DB)
  })

  it('shows the clearance rule matters: a click component 100 Hz from f0 raises the band by more than 3 dB', () => {
    const offender = F0 - 100
    expect(nearestHarmonicHz(offender, F0, CONFIG)).toBeLessThan(minClearanceHz(CONFIG))
    expect(meanBandDb(clicksAt(offender)) - quiet).toBeGreaterThan(3)
  })

  /**
   * The plan's rule: clicks at the chosen carrier raise the band at f0 by less than 1 dB, for every
   * f0 in the search band. The main-lobe clearance alone failed this for 105 of 901 f0 values
   * (1500-2195 Hz, up to +10.6 dB) because the carrier's sidelobes reached the band;
   * clickMinCarrierDistanceHz fixed it.
   */
  it('keeps the band rise under 1 dB for every f0 in the search band', () => {
    const [lo, hi] = CONFIG.searchBandHz
    const byCarrier = new Map<number, Frame[]>()
    const tooLoud: number[] = []
    for (let f0 = lo; f0 <= hi; f0 += F0_STEP_HZ) {
      const carrier = chooseClickFreq(f0, CONFIG)
      let frames = byCarrier.get(carrier)
      if (frames === undefined) {
        frames = analyse(clicksAt(carrier))
        byCarrier.set(carrier, frames)
      }
      if (meanBandAt(frames, f0) - meanBandAt(quietFrames, f0) >= MAX_RISE_DB) tooLoud.push(f0)
    }
    expect(tooLoud).toEqual([])
  }, 30_000) // about 2,000 frequencies across the search band: slow when the suite runs in parallel
})

describe('vibrationTier', () => {
  const tiers = [...CONFIG.hapticTiers].sort((a, b) => a.minWarmth - b.minWarmth)
  const lowest = tiers[0]!
  const top = tiers[tiers.length - 1]!
  const JUST_BELOW = 0.01

  it('returns null below the lowest tier and each tier pattern from its boundary up', () => {
    expect(vibrationTier(lowest.minWarmth - JUST_BELOW, false, CONFIG)).toBeNull()
    expect(vibrationTier(0, false, CONFIG)).toBeNull()
    tiers.forEach((tier, i) => {
      expect(vibrationTier(tier.minWarmth, false, CONFIG)).toBe(tier.pattern)
      const below = i === 0 ? null : tiers[i - 1]!.pattern
      expect(vibrationTier(tier.minWarmth - JUST_BELOW, false, CONFIG)).toBe(below)
    })
    expect(vibrationTier(1, false, CONFIG)).toBe(top.pattern)
  })

  it('handles quarter-step boundaries: 0.24 -> null, 0.25 / 0.5 / 0.75 -> their tier, 1 -> top tier', () => {
    const quarter = withConfig({
      hapticTiers: [
        { minWarmth: 0.75, pattern: [30, 220, 30] },
        { minWarmth: 0.5, pattern: [30, 470, 30] },
        { minWarmth: 0.25, pattern: [30] },
      ],
    })
    const [t75, t50, t25] = quarter.hapticTiers
    expect(vibrationTier(0.24, false, quarter)).toBeNull()
    expect(vibrationTier(0.25, false, quarter)).toBe(t25!.pattern)
    expect(vibrationTier(0.49, false, quarter)).toBe(t25!.pattern)
    expect(vibrationTier(0.5, false, quarter)).toBe(t50!.pattern)
    expect(vibrationTier(0.75, false, quarter)).toBe(t75!.pattern)
    expect(vibrationTier(1, false, quarter)).toBe(t75!.pattern)
  })

  it('does not depend on the order of the tiers in the config', () => {
    const reversed = withConfig({ hapticTiers: [...CONFIG.hapticTiers].reverse() })
    for (const w of [0, 0.3, 0.6, 0.9, 1]) expect(vibrationTier(w, false, reversed)).toBe(vibrationTier(w, false, CONFIG))
  })

  it('returns null for null (or NaN) warmth and the clipped pattern whenever clipped', () => {
    expect(vibrationTier(null, false, CONFIG)).toBeNull()
    expect(vibrationTier(Number.NaN, false, CONFIG)).toBeNull()
    for (const w of [null, 0, 0.5, 1]) expect(vibrationTier(w, true, CONFIG)).toBe(CONFIG.hapticClippedPattern)
  })

  it('keeps every pattern within one haptic period, with positive integer durations', () => {
    const patterns = [...CONFIG.hapticTiers.map((t) => t.pattern), CONFIG.hapticClippedPattern, CONFIG.hapticReadingPattern]
    for (const p of patterns) {
      expect(p.length).toBeGreaterThan(0)
      expect(p.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(CONFIG.hapticPeriodMs)
      for (const ms of p) {
        expect(Number.isInteger(ms)).toBe(true)
        expect(ms).toBeGreaterThan(0)
      }
    }
  })

  it('pulses more often per period in each warmer tier (vibration that gets faster)', () => {
    // Vibration patterns alternate on / off, starting with on: pulses = ceil(length / 2).
    const pulses = tiers.map((t) => Math.ceil(t.pattern.length / 2))
    for (let i = 1; i < pulses.length; i++) expect(pulses[i]!).toBeGreaterThan(pulses[i - 1]!)
  })
})

describe('dbToGain', () => {
  it('converts dB to linear amplitude', () => {
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(-20)).toBeCloseTo(0.1, 12)
    expect(dbToGain(20)).toBeCloseTo(10, 12)
    expect(dbToGain(-6.0206)).toBeCloseTo(0.5, 4)
    expect(dbToGain(CONFIG.clickGainDb)).toBeCloseTo(10 ** (CONFIG.clickGainDb / 20), 12)
  })
})

describe('hannClickCurve', () => {
  const peak = dbToGain(CONFIG.clickGainDb)
  const peak32 = Math.fround(peak)

  it('uses an odd default point count', () => {
    expect(CLICK_CURVE_POINTS % 2).toBe(1)
  })

  it.each([CLICK_CURVE_POINTS, 3, 5, 33, 4, 6, 64])('with %i points is symmetric, 0 at the ends and peakGain at the centre', (n) => {
    const c = hannClickCurve(n, peak)
    expect(c).toBeInstanceOf(Float32Array)
    expect(c.length).toBe(n)
    expect(c[0]).toBe(0)
    expect(c[n - 1]).toBe(0)
    for (let i = 0; i < n; i++) {
      expect(c[i]).toBe(c[n - 1 - i])
      expect(c[i]!).toBeGreaterThanOrEqual(0)
      expect(c[i]!).toBeLessThanOrEqual(peak32)
    }
    // Rises monotonically to the centre sample(s), which equal peakGain.
    const mid = (n - 1) >> 1
    for (let i = 1; i <= mid; i++) expect(c[i]!).toBeGreaterThanOrEqual(c[i - 1]!)
    expect(c[mid]).toBe(peak32)
    expect(c[n - 1 - mid]).toBe(peak32)
  })

  it('has the Hann shape: half the peak a quarter of the way in', () => {
    const n = CLICK_CURVE_POINTS
    const c = hannClickCurve(n, peak)
    expect((n - 1) % 4).toBe(0)
    expect(c[(n - 1) / 4]!).toBeCloseTo(peak / 2, 6)
  })

  it('rejects fewer than 3 or fractional points', () => {
    expect(() => hannClickCurve(2, peak)).toThrow(RangeError)
    expect(() => hannClickCurve(4.5, peak)).toThrow(RangeError)
  })

  it('rejects a non-finite or negative peak gain (setValueCurveAtTime would throw at click time)', () => {
    expect(() => hannClickCurve(CLICK_CURVE_POINTS, Number.NaN)).toThrow(RangeError)
    expect(() => hannClickCurve(CLICK_CURVE_POINTS, Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => hannClickCurve(CLICK_CURVE_POINTS, -peak)).toThrow(RangeError)
    expect(Array.from(hannClickCurve(CLICK_CURVE_POINTS, 0)).every((v) => v === 0)).toBe(true)
  })
})
