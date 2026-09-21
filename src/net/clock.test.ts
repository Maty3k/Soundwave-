import { describe, expect, it } from 'vitest'
import { CONFIG } from '../config.ts'
import { clockSample, estimateOffset, pushClockSample, toHubTime } from './clock.ts'
import type { ClockSample } from './clock.ts'

/** The station's clock runs this far ahead of the hub's in the simulations. */
const TRUE_OFFSET_MS = 83_421.5

/**
 * One simulated ping: sent at hubSendMs, outbound one-way delay `outMs`, the station answers at
 * once, return delay `backMs`.
 */
function ping(hubSendMs: number, outMs: number, backMs: number): ClockSample {
  const stationMs = hubSendMs + outMs + TRUE_OFFSET_MS
  return clockSample(hubSendMs, hubSendMs + outMs + backMs, stationMs)
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('clockSample', () => {
  it('measures the round trip and the offset at its midpoint', () => {
    expect(clockSample(1000, 1040, 5020)).toEqual({ rttMs: 40, offsetMs: 4000 })
    expect(clockSample(1000, 1000, 900)).toEqual({ rttMs: 0, offsetMs: -100 })
  })

  it('is exact for symmetric delays', () => {
    for (const d of [0, 1, 7.5, 150]) expect(ping(2000, d, d).offsetMs).toBeCloseTo(TRUE_OFFSET_MS, 9)
  })

  it('errs by half the delay asymmetry', () => {
    const s = ping(2000, 30, 10)
    expect(s.rttMs).toBe(40)
    expect(s.offsetMs - TRUE_OFFSET_MS).toBeCloseTo(10, 9)
  })
})

describe('estimateOffset', () => {
  it('is null without valid samples', () => {
    expect(estimateOffset([])).toBeNull()
    expect(estimateOffset([{ rttMs: Number.NaN, offsetMs: 1 }])).toBeNull()
    expect(estimateOffset([{ rttMs: -5, offsetMs: 1 }])).toBeNull()
    expect(estimateOffset([{ rttMs: 5, offsetMs: Number.POSITIVE_INFINITY }])).toBeNull()
  })

  it('uses the single sample, and the faster of two', () => {
    expect(estimateOffset([{ rttMs: 12, offsetMs: 50 }])).toBe(50)
    expect(estimateOffset([{ rttMs: 300, offsetMs: 900 }, { rttMs: 12, offsetMs: 50 }])).toBe(50)
  })

  it('takes the median offset of the fastest half', () => {
    const samples: ClockSample[] = [
      { rttMs: 10, offsetMs: 100 },
      { rttMs: 11, offsetMs: 104 },
      { rttMs: 12, offsetMs: 102 },
      { rttMs: 13, offsetMs: 140 },
      { rttMs: 400, offsetMs: -500 },
      { rttMs: 500, offsetMs: 700 },
      { rttMs: 600, offsetMs: 800 },
      { rttMs: 700, offsetMs: 900 },
    ]
    // Fastest half: offsets 100, 104, 102, 140 -> median 103.
    expect(estimateOffset(samples)).toBe(103)
    // Order of the samples does not matter.
    expect(estimateOffset([...samples].reverse())).toBe(103)
    // Odd count: the fastest ceil(n / 2) = 3 of 5 (offsets 102, 140, -500).
    expect(estimateOffset(samples.slice(2, 7))).toBe(102)
  })

  it('ignores slow round trips with large asymmetric delays', () => {
    const samples = [
      ping(0, 6, 5),
      ping(3000, 180, 4), // the sleeping station phone wakes its Wi-Fi late
      ping(6000, 5, 7),
      ping(9000, 350, 20),
      ping(12000, 6, 6),
      ping(15000, 260, 3), // queued behind a burst of other traffic
      ping(18000, 7, 5),
      ping(21000, 400, 400),
    ]
    const est = estimateOffset(samples)!
    expect(Math.abs(est - TRUE_OFFSET_MS)).toBeLessThanOrEqual(1)
    // The outliers really are misleading: the plain mean is far off.
    const mean = samples.reduce((a, s) => a + s.offsetMs, 0) / samples.length
    expect(Math.abs(mean - TRUE_OFFSET_MS)).toBeGreaterThan(20)
  })

  it('stays within a few ms under random bursty delays (fixed seeds)', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const r = rng(seed)
      const oneWay = (): number => 2 + 6 * r() + (r() < 0.3 ? 100 + 400 * r() : 0)
      let samples: ClockSample[] = []
      for (let i = 0; i < CONFIG.stationPingKeep; i++) {
        samples = pushClockSample(samples, ping(i * CONFIG.stationPingMs, oneWay(), oneWay()), CONFIG.stationPingKeep)
      }
      const est = estimateOffset(samples)!
      // Without bursts the error is at most half the 6 ms jitter spread.
      expect(Math.abs(est - TRUE_OFFSET_MS), `seed ${seed}`).toBeLessThanOrEqual(3)
    }
  })
})

describe('pushClockSample', () => {
  it('keeps the newest samples', () => {
    let samples: ClockSample[] = []
    for (let i = 0; i < 12; i++) samples = pushClockSample(samples, { rttMs: i, offsetMs: i }, 8)
    expect(samples.map((s) => s.rttMs)).toEqual([4, 5, 6, 7, 8, 9, 10, 11])
    const before = samples
    pushClockSample(before, { rttMs: 99, offsetMs: 99 }, 8)
    expect(before).toHaveLength(8)
    expect(pushClockSample([], { rttMs: 1, offsetMs: 1 }, 0)).toHaveLength(1)
  })
})

describe('toHubTime', () => {
  it('maps station time onto the hub clock', () => {
    expect(toHubTime(10_000, 4000)).toBe(6000)
    expect(toHubTime(500, -250)).toBe(750)
    // A chirp heard by the station at hub time 7000 maps back to 7000.
    const offset = estimateOffset([ping(0, 5, 5), ping(3000, 6, 6), ping(6000, 90, 30)])!
    expect(toHubTime(7000 + TRUE_OFFSET_MS, offset)).toBeCloseTo(7000, 9)
  })
})
