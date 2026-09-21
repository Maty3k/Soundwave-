import { describe, expect, it } from 'vitest'
import { OCTANT_HOLD_DEG, steadyOctant } from './radarUi.ts'

describe('steadyOctant', () => {
  it('names the nearest octant when there is no previous answer', () => {
    expect(steadyOctant(null, 0)).toBe('ahead')
    expect(steadyOctant(null, 44)).toBe('aheadRight')
    expect(steadyOctant(null, -100)).toBe('left')
    expect(steadyOctant(null, 179)).toBe('behind')
    expect(steadyOctant(null, -179)).toBe('behind')
  })

  it('keeps the previous octant across a boundary until the bearing is well past it', () => {
    // 'ahead' is centred on 0: the plain boundary is at 22.5, the steadied one at 32.5.
    expect(steadyOctant('ahead', 23)).toBe('ahead')
    expect(steadyOctant('ahead', OCTANT_HOLD_DEG)).toBe('ahead')
    expect(steadyOctant('ahead', OCTANT_HOLD_DEG + 0.5)).toBe('aheadRight')
    expect(steadyOctant('ahead', -30)).toBe('ahead')
    expect(steadyOctant('aheadLeft', -14)).toBe('aheadLeft')
    expect(steadyOctant('aheadLeft', -12)).toBe('ahead')
  })

  it('handles the wrap-around behind the user', () => {
    expect(steadyOctant('behind', -150)).toBe('behind')
    expect(steadyOctant('behind', 150)).toBe('behind')
    expect(steadyOctant('behind', 140)).toBe('behindRight')
    expect(steadyOctant('behindLeft', 170)).toBe('behind')
  })

  it('does not flip when a wobbling bearing crosses a plain boundary back and forth', () => {
    let octant = steadyOctant(null, 10)
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      octant = steadyOctant(octant, 22.5 + (i % 2 === 0 ? 6 : -6))
      seen.add(octant)
    }
    expect([...seen]).toEqual(['ahead'])
  })
})
