import { describe, expect, it } from 'vitest'
import { clampBand, normalizeBand, roundHz, sameBand } from './band.ts'
import { CONFIG, withConfig } from './config.ts'

const [MIN, MAX] = CONFIG.bandLimitsHz
const SPAN = CONFIG.bandMinSpanHz
const STEP = CONFIG.bandStepHz

describe('config', () => {
  it('has a default band inside the slider limits, on the step, at least the minimum span wide', () => {
    const [lo, hi] = CONFIG.searchBandHz
    expect(lo).toBeGreaterThanOrEqual(MIN)
    expect(hi).toBeLessThanOrEqual(MAX)
    expect(hi - lo).toBeGreaterThanOrEqual(SPAN)
    expect(lo % STEP).toBe(0)
    expect(hi % STEP).toBe(0)
    expect(MAX - MIN).toBeGreaterThanOrEqual(SPAN)
  })
})

describe('normalizeBand', () => {
  it('returns a valid band unchanged', () => {
    expect(normalizeBand(1500, 12_000, CONFIG)).toEqual([1500, 12_000])
    expect(normalizeBand(MIN, MAX, CONFIG)).toEqual([MIN, MAX])
    expect(normalizeBand(3000, 3000 + SPAN, CONFIG)).toEqual([3000, 3000 + SPAN])
  })

  it('rounds both ends to the step', () => {
    expect(normalizeBand(1549, 12_049, CONFIG)).toEqual([1500, 12_000])
    expect(normalizeBand(1551, 11_951, CONFIG)).toEqual([1600, 12_000])
    expect(normalizeBand(9730, 9730 + SPAN, CONFIG)).toEqual([9700, 10_200])
  })

  it('clamps both ends into the limits', () => {
    expect(normalizeBand(100, 20_000, CONFIG)).toEqual([MIN, MAX])
    expect(normalizeBand(-1e9, 1e9, CONFIG)).toEqual([MIN, MAX])
  })

  it('is null for a span below the minimum, after rounding, and for a reversed pair', () => {
    expect(normalizeBand(3000, 3000 + SPAN - STEP, CONFIG)).toBeNull()
    expect(normalizeBand(3000, 3000 + SPAN - STEP / 2 - 1, CONFIG)).toBeNull()
    expect(normalizeBand(3000, 3000, CONFIG)).toBeNull()
    expect(normalizeBand(9000, 2000, CONFIG)).toBeNull()
    // Clamping can eat the span: a band lying wholly above the limits collapses onto the top.
    expect(normalizeBand(MAX + 1000, MAX + 5000, CONFIG)).toBeNull()
  })

  it('is null for values that are not finite numbers', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(normalizeBand(bad, 12_000, CONFIG)).toBeNull()
      expect(normalizeBand(1500, bad, CONFIG)).toBeNull()
    }
  })

  it('follows the config: other limits, span and step', () => {
    const cfg = withConfig({ bandLimitsHz: [1000, 5000], bandMinSpanHz: 1000, bandStepHz: 250 })
    expect(normalizeBand(900, 6000, cfg)).toEqual([1000, 5000])
    expect(normalizeBand(1100, 2600, cfg)).toEqual([1000, 2500])
    expect(normalizeBand(2000, 3000, cfg)).toEqual([2000, 3000])
    expect(normalizeBand(2000, 2800, cfg)).toBeNull()
    // A step of 0 means no rounding.
    expect(normalizeBand(1234, 4321, withConfig({ bandStepHz: 0 }))).toEqual([1234, 4321])
  })
})

describe('clampBand', () => {
  it('leaves a band that is wide enough alone, rounding to the step', () => {
    expect(clampBand(1500, 12_000, CONFIG, 'lo')).toEqual([1500, 12_000])
    expect(clampBand(1500, 12_000, CONFIG, 'hi')).toEqual([1500, 12_000])
    expect(clampBand(1549, 12_049, CONFIG, 'lo')).toEqual([1500, 12_000])
  })

  it('pushes the highest pitch up when the lowest is dragged past it', () => {
    expect(clampBand(5000, 5200, CONFIG, 'lo')).toEqual([5000, 5000 + SPAN])
    expect(clampBand(8000, 6000, CONFIG, 'lo')).toEqual([8000, 8000 + SPAN])
  })

  it('pushes the lowest pitch down when the highest is dragged past it', () => {
    expect(clampBand(5000, 5200, CONFIG, 'hi')).toEqual([5200 - SPAN, 5200])
    expect(clampBand(8000, 6000, CONFIG, 'hi')).toEqual([6000 - SPAN, 6000])
  })

  it('lets the moving end give way only where the limits leave no room', () => {
    expect(clampBand(MAX - 100, 12_000, CONFIG, 'lo')).toEqual([MAX - SPAN, MAX])
    expect(clampBand(MAX, MAX, CONFIG, 'lo')).toEqual([MAX - SPAN, MAX])
    expect(clampBand(1500, MIN + 100, CONFIG, 'hi')).toEqual([MIN, MIN + SPAN])
    expect(clampBand(MIN, MIN, CONFIG, 'hi')).toEqual([MIN, MIN + SPAN])
  })

  it('clamps values beyond the limits before anything else', () => {
    expect(clampBand(-100, 12_000, CONFIG, 'lo')).toEqual([MIN, 12_000])
    expect(clampBand(1500, 99_999, CONFIG, 'hi')).toEqual([1500, MAX])
  })

  it('takes a value that is not a finite number as that end of the default band', () => {
    expect(clampBand(Number.NaN, 12_000, CONFIG, 'lo')).toEqual([CONFIG.searchBandHz[0], 12_000])
    expect(clampBand(3000, Number.POSITIVE_INFINITY, CONFIG, 'hi')).toEqual([3000, CONFIG.searchBandHz[1]])
    expect(clampBand(Number.NaN, Number.NaN, CONFIG, 'lo')).toEqual([...CONFIG.searchBandHz])
  })

  it('always returns a valid band (normalizeBand accepts it)', () => {
    const values = [-5000, 0, MIN, 1500, 3049, 5000, 9730, 12_000, MAX, MAX + 700, 1e6]
    for (const lo of values) {
      for (const hi of values) {
        for (const moving of ['lo', 'hi'] as const) {
          const band = clampBand(lo, hi, CONFIG, moving)
          expect(normalizeBand(band[0], band[1], CONFIG)).toEqual(band)
        }
      }
    }
  })
})

describe('roundHz', () => {
  it('rounds to the step without clamping and leaves a value that is not finite alone', () => {
    expect(roundHz(9730, CONFIG)).toBe(9700)
    expect(roundHz(9750, CONFIG)).toBe(9800)
    expect(roundHz(449, CONFIG)).toBe(400)
    expect(roundHz(16_049, CONFIG)).toBe(16_000)
    expect(roundHz(16_050, CONFIG)).toBe(16_100)
    expect(roundHz(-1000, CONFIG)).toBe(-1000)
    expect(roundHz(1234, withConfig({ bandStepHz: 0 }))).toBe(1234)
    expect(roundHz(Number.NaN, CONFIG)).toBeNaN()
    expect(roundHz(Number.POSITIVE_INFINITY, CONFIG)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('sameBand', () => {
  it('compares both ends by value', () => {
    expect(sameBand([1500, 12_000], CONFIG.searchBandHz)).toBe(true)
    expect(sameBand([1500, 12_100], CONFIG.searchBandHz)).toBe(false)
    expect(sameBand([1600, 12_000], CONFIG.searchBandHz)).toBe(false)
  })
})
