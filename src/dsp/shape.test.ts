import { describe, expect, it } from 'vitest'
import { CONFIG, withConfig } from '../config.ts'
import type { SoundShape } from '../types.ts'
import { fingerprintOf, sameShape, shapeMatches, soundShape } from './shape.ts'

const HOP = CONFIG.hopMs
const CLEAR = CONFIG.shapeMinFadeSnrDb + 10

/** A steady beep as frames see it: two ramp frames each side (the analysis window) around `frames` level frames. */
function flat(frames: number, level = -40): number[] {
  return [level - 12, level - 5, ...Array<number>(frames).fill(level), level - 5, level - 12]
}

/** A sound fading at dbPerS from its first frame. */
function fading(frames: number, dbPerS: number, start = -40): number[] {
  return Array.from({ length: frames }, (_, i) => start - dbPerS * ((i * HOP) / 1000))
}

/** soundShape of levels one hop apart. */
function sh(levels: readonly number[], snrDb: number): SoundShape | null {
  return soundShape(levels, levels.map((_, i) => i * HOP), snrDb, CONFIG)
}

function shape(coreMs: number, fadeDbPerS: number | null): SoundShape {
  return { coreMs, coreFrames: Math.round(coreMs / HOP), fadeDbPerS }
}

describe('soundShape', () => {
  it('measures a steady beep: the core runs from the first to the last frame within coreDropDb, no fade', () => {
    const s = sh(flat(8), CLEAR)!
    expect(s.coreFrames).toBe(10) // the -5 dB ramp frames are within 6 dB of the peak
    expect(s.coreMs).toBe(10 * HOP)
    expect(s.fadeDbPerS).toBeCloseTo(0, 6)
  })

  it('measures how fast a sound fades across its core', () => {
    const s = sh(fading(40, 40), CLEAR)!
    expect(s.coreFrames).toBe(8) // 0.8 dB per frame: frames 0..7 are within 6 dB
    expect(s.fadeDbPerS).toBeCloseTo(40, 6)
  })

  it('leaves the fade unknown for a short core or a faint sound', () => {
    expect(sh(flat(1), CLEAR)!.fadeDbPerS).toBeNull() // core of 3 frames
    expect(sh(fading(40, 40), CONFIG.shapeMinFadeSnrDb - 1)!.fadeDbPerS).toBeNull()
    expect(sh(fading(40, 40), CONFIG.shapeMinFadeSnrDb - 1)!.coreFrames).toBe(8)
  })

  it('is null without a finite level', () => {
    expect(sh([], CLEAR)).toBeNull()
    expect(sh([-Infinity, Number.NaN], CLEAR)).toBeNull()
  })
})

describe('shapeMatches', () => {
  const beep = shape(160, -4)

  it('takes sounds about as long as the beep, longer ones more readily (a room echo lengthens a beep)', () => {
    const lo = beep.coreMs / CONFIG.shapeCoreShorterRatio - CONFIG.shapeCoreSlackMs
    const hi = beep.coreMs * CONFIG.shapeCoreLongerRatio + CONFIG.shapeCoreSlackMs
    expect(shapeMatches(shape(lo, 0), beep, CONFIG)).toBe(true)
    expect(shapeMatches(shape(lo - 1, 0), beep, CONFIG)).toBe(false)
    expect(shapeMatches(shape(hi, 0), beep, CONFIG)).toBe(true)
    expect(shapeMatches(shape(hi + 1, 0), beep, CONFIG)).toBe(false)
    expect(beep.coreMs - lo).toBeLessThan(hi - beep.coreMs)
  })

  it('sets aside a sound that fades much faster than the beep, not one that fades slower', () => {
    const limit = beep.fadeDbPerS! + CONFIG.shapeFadeTolDbPerS
    expect(shapeMatches(shape(160, limit), beep, CONFIG)).toBe(true)
    expect(shapeMatches(shape(160, limit + 1), beep, CONFIG)).toBe(false)
    expect(shapeMatches(shape(160, -30), beep, CONFIG)).toBe(true)
    // Unknown fades are not judged.
    expect(shapeMatches(shape(160, null), beep, CONFIG)).toBe(true)
    expect(shapeMatches(shape(160, 80), shape(160, null), CONFIG)).toBe(true)
  })
})

describe('sameShape', () => {
  it('is symmetric and lets unknown shapes pass', () => {
    expect(sameShape(shape(160, 0), shape(200, 10), CONFIG)).toBe(true)
    expect(sameShape(shape(200, 10), shape(160, 0), CONFIG)).toBe(true)
    expect(sameShape(shape(160, 0), shape(60, 0), CONFIG)).toBe(false)
    expect(sameShape(shape(60, 0), shape(160, 0), CONFIG)).toBe(false)
    expect(sameShape(shape(160, 0), shape(160, CONFIG.shapeFadeTolDbPerS + 1), CONFIG)).toBe(false)
    expect(sameShape(shape(160, 0), shape(160, null), CONFIG)).toBe(true)
    expect(sameShape(undefined, shape(60, 0), CONFIG)).toBe(true)
  })

  it('follows the configured tolerances', () => {
    const loose = withConfig({ shapeCoreShorterRatio: 10, shapeCoreLongerRatio: 10 })
    expect(sameShape(shape(160, 0), shape(60, 0), loose)).toBe(true)
  })
})

describe('fingerprintOf', () => {
  it('takes the median of each measure, of the known fades only', () => {
    expect(fingerprintOf([])).toBeNull()
    const fp = fingerprintOf([shape(160, 0), shape(200, null), shape(140, 10), shape(400, 40)])!
    expect(fp.coreMs).toBe(180)
    expect(fp.fadeDbPerS).toBe(10)
    expect(fingerprintOf([shape(160, null)])!.fadeDbPerS).toBeNull()
  })
})
