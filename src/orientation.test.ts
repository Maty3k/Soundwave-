import { describe, expect, it } from 'vitest'
import { circularEma, forwardHeadingDeg, smoothingWeight } from './orientation.ts'

/** Smallest absolute difference between two headings. */
const diff = (a: number, b: number): number => {
  const d = Math.abs((((a - b) % 360) + 360) % 360)
  return Math.min(d, 360 - d)
}

describe('forwardHeadingDeg', () => {
  it('uses the top edge when the phone lies flat (alpha counts counter-clockwise)', () => {
    expect(forwardHeadingDeg(0, 0, 0)).toBeCloseTo(0, 6)
    expect(forwardHeadingDeg(90, 0, 0)).toBeCloseTo(270, 6) // turned left
    expect(forwardHeadingDeg(270, 0, 0)).toBeCloseTo(90, 6) // turned right
  })

  it('uses the back of the device when held upright, facing the same way', () => {
    expect(forwardHeadingDeg(0, 90, 0)).toBeCloseTo(0, 6)
    expect(forwardHeadingDeg(90, 90, 0)).toBeCloseTo(270, 6)
  })

  it('is stable across the usual reading tilts for the same facing direction', () => {
    for (const alpha of [0, 30, 135, 250]) {
      const flat = forwardHeadingDeg(alpha, 0, 0)!
      for (const beta of [15, 30, 45, 60, 75, 89]) {
        expect(diff(forwardHeadingDeg(alpha, beta, 0)!, flat)).toBeLessThan(0.001)
      }
      // A small sideways roll moves the heading only a little.
      expect(diff(forwardHeadingDeg(alpha, 45, 10)!, flat)).toBeLessThan(10)
    }
  })

  it('turns with the user: a quarter turn right adds 90 degrees at any tilt', () => {
    for (const beta of [0, 40, 80]) {
      const a = forwardHeadingDeg(20, beta, 0)!
      const b = forwardHeadingDeg(20 - 90, beta, 0)!
      expect(diff(b, a + 90)).toBeLessThan(0.001)
    }
  })

  it('accounts for a rotated screen (landscape): forward follows the screen top', () => {
    // Device rotated 90 degrees counter-clockwise and lying flat: its +x edge points to the screen top.
    const h = forwardHeadingDeg(90, 0, 0, 90)!
    expect(diff(h, 0)).toBeLessThan(0.001)
  })

  it('returns null only when the top edge and the back cancel horizontally', () => {
    // beta -45: the top edge points forward-down and the back points backward-down by the same amount.
    expect(forwardHeadingDeg(0, -45, 0)).toBeNull()
    expect(forwardHeadingDeg(123, -45, 0)).toBeNull()
    expect(forwardHeadingDeg(0, -90, 0)).not.toBeNull() // upright upside down: the back is still horizontal
  })
})

describe('smoothingWeight', () => {
  it('is 1 - exp(-dt / tau): rate independent, instant after a long gap', () => {
    expect(smoothingWeight(120, 120)).toBeCloseTo(1 - Math.exp(-1), 12)
    expect(smoothingWeight(0, 120)).toBe(0)
    expect(smoothingWeight(Infinity, 120)).toBe(1)
    expect(smoothingWeight(5000, 120)).toBeGreaterThan(0.999)
    expect(smoothingWeight(10, 0)).toBe(1)
    // Ten 16 ms steps smooth exactly like one 160 ms step.
    let a = 0
    for (let i = 0; i < 10; i++) a = a + smoothingWeight(16, 120) * (1 - a)
    expect(a).toBeCloseTo(smoothingWeight(160, 120), 12)
  })
})

describe('circularEma', () => {
  it('starts at the first value and wraps the short way round', () => {
    expect(circularEma(null, 370, 0.3)).toBe(10)
    expect(circularEma(350, 10, 0.5)).toBeCloseTo(0, 9)
    expect(circularEma(10, 350, 0.5)).toBeCloseTo(0, 9)
    expect(circularEma(90, 180, 0.25)).toBeCloseTo(112.5, 9)
  })
})
