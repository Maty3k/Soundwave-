import { describe, expect, it } from 'vitest'
import { CONFIG, withConfig } from '../config.ts'
import {
  addRadarSample,
  angleDiff,
  clearRadar,
  createRadar,
  direction8,
  normDeg,
  radarView,
  raiseLastSample,
  relativeBearing,
  sectorIndex,
} from './radar.ts'

/** A chirp-mode radar with one sample per listed [heading, level] pair. */
function scan(samples: ReadonlyArray<readonly [number, number]>) {
  const r = createRadar('chirp', CONFIG)
  for (const [h, l] of samples) addRadarSample(r, h, l)
  return r
}

describe('angles', () => {
  it('normDeg maps any angle into [0, 360)', () => {
    expect(normDeg(0)).toBe(0)
    expect(normDeg(360)).toBe(0)
    expect(normDeg(-10)).toBe(350)
    expect(normDeg(725)).toBe(5)
  })

  it('angleDiff is the signed smallest difference', () => {
    expect(angleDiff(10, 350)).toBe(20)
    expect(angleDiff(350, 10)).toBe(-20)
    expect(angleDiff(180, 0)).toBe(180)
    expect(angleDiff(90, 90)).toBe(0)
  })

  it('sectorIndex centres sector 0 on north', () => {
    expect(sectorIndex(0, 8)).toBe(0)
    expect(sectorIndex(22.4, 8)).toBe(0)
    expect(sectorIndex(22.5, 8)).toBe(1)
    expect(sectorIndex(-22.4, 8)).toBe(0)
    expect(sectorIndex(-22.6, 8)).toBe(7)
    expect(sectorIndex(359.9, 8)).toBe(0)
    expect(sectorIndex(180, 8)).toBe(4)
    expect(sectorIndex(725, 24)).toBe(0) // 5 degrees, inside the 15-degree sector 0
  })

  it('relativeBearing and direction8 describe where to turn', () => {
    expect(relativeBearing(90, 0)).toBe(90)
    expect(direction8(relativeBearing(90, 0))).toBe('right')
    expect(direction8(relativeBearing(352, 90))).toBe('left') // -98 degrees
    expect(direction8(0)).toBe('ahead')
    expect(direction8(180)).toBe('behind')
    expect(direction8(-135)).toBe('behindLeft')
    expect(direction8(40)).toBe('aheadRight')
  })
})

describe('radar sectors', () => {
  it('uses coarse sectors for chirps and fine sectors for live scans', () => {
    expect(createRadar('chirp', CONFIG).n).toBe(CONFIG.radarChirpSectors)
    expect(createRadar('live', CONFIG).n).toBe(CONFIG.radarLiveSectors)
  })

  it('averages samples in the same sector in the power domain', () => {
    const r = createRadar('live', CONFIG)
    addRadarSample(r, 2, 0)
    addRadarSample(r, 4, -10)
    const v = radarView(r, null, CONFIG)
    expect(v.sectors[0]!.samples).toBe(2)
    expect(v.sectors[0]!.levelDb).toBeCloseTo(10 * Math.log10((1 + 0.1) / 2), 9)
    expect(v.sectors[1]!.levelDb).toBeNull()
    expect(v.samples).toBe(2)
  })

  it('ignores non-finite samples', () => {
    const r = createRadar('chirp', CONFIG)
    addRadarSample(r, Number.NaN, -40)
    addRadarSample(r, 0, -Infinity)
    expect(r.samples).toBe(0)
  })
})

describe('radarView quality and bearing', () => {
  it('four quarter turns with a loud front give a clear bearing near the loudest heading', () => {
    // N 0 dB, E -10, S -16, W -8: the bearing leans from N slightly toward W.
    const v = radarView(scan([[0, -40], [90, -50], [180, -56], [270, -48]]), 0, CONFIG)
    expect(v.quality).toBe('clear')
    expect(v.contrastDb).toBeCloseTo(16, 9)
    expect(v.maxGapDeg).toBe(90)
    expect(v.bearingDeg).not.toBeNull()
    expect(Math.abs(angleDiff(v.bearingDeg!, 0))).toBeLessThan(15)
    expect(angleDiff(v.bearingDeg!, 0)).toBeLessThan(0) // pulled toward the louder neighbour (W)
  })

  it('needs at least radarMinSectors distinct directions', () => {
    const v = radarView(scan([[0, -40], [180, -60]]), 0, CONFIG)
    expect(v.quality).toBe('needMore')
    expect(v.bearingDeg).toBeNull()
    expect(v.contrastDb).toBeCloseTo(20, 9)
  })

  it('needs the measured directions to be spread around the circle', () => {
    // Three neighbouring sectors: the gap back around is 270 degrees.
    const v = radarView(scan([[0, -40], [45, -50], [90, -55]]), 0, CONFIG)
    expect(v.maxGapDeg).toBe(270)
    expect(v.quality).toBe('needMore')
    expect(v.bearingDeg).toBeNull()
  })

  it('reports unclear when loud and quiet sides differ too little', () => {
    const v = radarView(scan([[0, -40], [90, -41], [180, -42], [270, -41.5]]), 0, CONFIG)
    expect(v.quality).toBe('unclear')
    expect(v.bearingDeg).toBeNull()
  })

  it('is rough with a moderate contrast or a half-circle gap', () => {
    const moderate = radarView(scan([[0, -40], [90, -45], [180, -46], [270, -45]]), 0, CONFIG)
    expect(moderate.quality).toBe('rough')
    expect(moderate.bearingDeg).not.toBeNull()
    const halfGap = radarView(scan([[0, -40], [90, -55], [180, -60]]), 0, CONFIG)
    expect(halfGap.maxGapDeg).toBe(180)
    expect(halfGap.quality).toBe('rough')
  })

  it('suggests facing the middle of the largest unmeasured gap', () => {
    const v = radarView(scan([[0, -40], [90, -50]]), 0, CONFIG)
    expect(v.suggestDeg).toBe(225)
    const full = createRadar('chirp', CONFIG)
    for (let h = 0; h < 360; h += 45) addRadarSample(full, h, -50)
    expect(radarView(full, 0, CONFIG).suggestDeg).toBeNull()
    expect(radarView(createRadar('chirp', CONFIG), 0, CONFIG).suggestDeg).toBeNull()
  })

  it('finds the loudest direction of a simulated body-shadow scan in live mode', () => {
    // Level falls off by up to 12 dB as the user faces away from 200 degrees; small ripple from room modes.
    const r = createRadar('live', CONFIG)
    for (let turn = 0; turn < 2; turn++) {
      for (let h = 0; h < 360; h += 3) {
        const away = Math.abs(angleDiff(h, 200)) / 180
        addRadarSample(r, h + turn * 1.5, -45 - 12 * away + 1.5 * Math.sin(h * 0.7))
      }
    }
    const v = radarView(r, 0, CONFIG)
    expect(v.quality).toBe('clear')
    expect(Math.abs(angleDiff(v.bearingDeg!, 200))).toBeLessThan(15)
  })

  it('passes the device heading through, normalised', () => {
    expect(radarView(scan([]), -90, CONFIG).headingDeg).toBe(270)
    expect(radarView(scan([]), null, CONFIG).headingDeg).toBeNull()
  })

  it('respects configured thresholds', () => {
    const lenient = withConfig({ radarMinContrastDb: 1, radarClearContrastDb: 2 })
    const v = radarView(scan([[0, -40], [90, -41.5], [180, -42], [270, -41.5]]), 0, lenient)
    expect(v.quality).toBe('clear')
  })
})

describe('updating and clearing', () => {
  it('raiseLastSample lifts a merged chirp group but never lowers it', () => {
    const r = scan([[0, -50]])
    raiseLastSample(r, -45)
    expect(radarView(r, 0, CONFIG).sectors[0]!.levelDb).toBeCloseTo(-45, 9)
    raiseLastSample(r, -60)
    expect(radarView(r, 0, CONFIG).sectors[0]!.levelDb).toBeCloseTo(-45, 9)
    expect(r.samples).toBe(1)
  })

  it('clearRadar forgets everything', () => {
    const r = scan([[0, -40], [90, -50], [180, -56]])
    clearRadar(r)
    const v = radarView(r, 0, CONFIG)
    expect(v.samples).toBe(0)
    expect(v.sectors.every((s) => s.levelDb === null)).toBe(true)
    expect(v.maxGapDeg).toBeNull()
    raiseLastSample(r, -10)
    expect(radarView(r, 0, CONFIG).samples).toBe(0)
  })
})
