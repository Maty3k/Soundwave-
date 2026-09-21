import { describe, expect, it } from 'vitest'
import { CONFIG } from '../config.ts'
import {
  argmaxInRange,
  bandFloorDb,
  bandLevelDb,
  binHz,
  binToHz,
  clipFraction,
  hzToBin,
  localFloorDb,
  locatePeak,
  lockToleranceBins,
  measureBandAt,
  median,
  parabolicPeak,
  peakWidthBins,
  rmsDb,
  sanitizeDb,
  SILENT_DB,
} from './spectrum.ts'
import {
  expectedFloorDb,
  iterateFrames,
  mulberry32,
  ReferenceAnalyser,
  synthSignal,
  toneLevelForSnr,
  tonePeakDb,
} from './synth.ts'

const SR = 48000
const N = CONFIG.fftSize
const BW = SR / N
const NOISE_DB = -60

/** Analyse a noiseless tone at a fractional bin position; returns the dB spectrum. */
function toneSpectrum(bin: number, levelDb = -20): Float32Array {
  const s = synthSignal({
    sampleRate: SR,
    durationS: 0.2,
    noiseDb: -Infinity,
    tones: [{ hz: bin * BW, levelDb, onS: 0, offS: 0.2 }],
  })
  return new ReferenceAnalyser(N).analyse(s, s.length)
}

describe('bin conversions', () => {
  it('binHz is sampleRate / fftSize', () => {
    expect(binHz(48000, 4096)).toBe(11.71875)
    expect(binHz(44100, 4096)).toBeCloseTo(10.7666, 4)
  })

  it('hzToBin and binToHz round-trip at 44.1 and 48 kHz', () => {
    for (const sr of [44100, 48000]) {
      const w = binHz(sr, 4096)
      for (const hz of [1500, 3120.5, 5999]) expect(binToHz(hzToBin(hz, w), w)).toBeCloseTo(hz, 9)
    }
  })
})

describe('sanitizeDb', () => {
  it('maps -Infinity, NaN and values below the silent level to SILENT_DB and keeps the rest', () => {
    const src = new Float32Array([-Infinity, Number.NaN, -1000, -900, -161, -160, -95.5, 0])
    expect(Array.from(sanitizeDb(src))).toEqual([SILENT_DB, SILENT_DB, SILENT_DB, SILENT_DB, SILENT_DB, -160, -95.5, 0])
  })

  it('can sanitise in place', () => {
    const buf = new Float32Array([-Infinity, -50])
    expect(sanitizeDb(buf, buf)).toBe(buf)
    expect(Array.from(buf)).toEqual([SILENT_DB, -50])
  })
})

describe('median', () => {
  it('handles odd, even and empty lists without reordering the input', () => {
    const odd = [5, 1, 3]
    expect(median(odd)).toBe(3)
    expect(odd).toEqual([5, 1, 3])
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(Number.isNaN(median([]))).toBe(true)
  })
})

describe('synthetic reference analyser (self-check against theory)', () => {
  it('puts a bin-centred sine at levelDb + 20*log10(0.21)', () => {
    const db = toneSpectrum(265, -20)
    expect(db[265]).toBeCloseTo(tonePeakDb(-20), 2)
  })

  it('has Blackman sidelobes below -57 dB relative to the peak', () => {
    const db = toneSpectrum(265, -20)
    const peak = db[265]!
    for (let k = 265 + 4; k < 265 + 40; k++) expect(db[k]! - peak).toBeLessThan(-57)
  })

  it('produces a per-bin median floor matching expectedFloorDb for white noise', () => {
    const s = synthSignal({ sampleRate: SR, durationS: 20, noiseDb: NOISE_DB, seed: 3 })
    const floors: number[] = []
    for (const f of iterateFrames(s, SR, { fftSize: N, hopMs: 100 })) floors.push(localFloorDb(f.db, 265, 24, 3))
    expect(median(floors)).toBeCloseTo(expectedFloorDb(NOISE_DB, N), 0)
    expect(Math.abs(median(floors) - expectedFloorDb(NOISE_DB, N))).toBeLessThan(0.5)
  })

  it('mulberry32 is deterministic per seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 5; i++) expect(a()).toBe(b())
  })
})

describe('localFloorDb', () => {
  it('ignores a strong tone inside the guard band', () => {
    const s = synthSignal({
      sampleRate: SR,
      durationS: 2,
      noiseDb: NOISE_DB,
      seed: 11,
      tones: [{ hz: 265 * BW, levelDb: -20, onS: 0, offS: 2 }],
    })
    const floors: number[] = []
    for (const f of iterateFrames(s, SR, { fftSize: N, hopMs: 100 })) floors.push(localFloorDb(f.db, 265, 24, 3))
    expect(Math.abs(median(floors) - expectedFloorDb(NOISE_DB, N))).toBeLessThan(1)
  })

  it('returns SILENT_DB when no bins are available', () => {
    expect(localFloorDb(new Float32Array(2), 1, 0, 0)).toBe(SILENT_DB)
  })
})

describe('parabolicPeak', () => {
  it('recovers sub-bin offsets within 0.05 bin and the peak within 0.3 dB on Blackman peaks', () => {
    const rng = mulberry32(5)
    for (let i = 0; i < 40; i++) {
      const offset = rng() - 0.5
      const db = toneSpectrum(265 + offset, -20)
      const k = argmaxInRange(db, 260, 270)
      const p = parabolicPeak(db[k - 1]!, db[k]!, db[k + 1]!)
      expect(Math.abs(k + p.delta - (265 + offset))).toBeLessThan(0.05)
      expect(Math.abs(p.peakDb - tonePeakDb(-20))).toBeLessThan(0.3)
    }
  })

  it('returns the centre value when the points are not a maximum', () => {
    expect(parabolicPeak(1, 1, 1)).toEqual({ delta: 0, peakDb: 1 })
    expect(parabolicPeak(3, 2, 1)).toEqual({ delta: 0, peakDb: 2 })
  })
})

describe('peakWidthBins', () => {
  it('is about 3 bins for a pure tone and at most 4 anywhere across a bin', () => {
    for (const off of [0, 0.25, 0.5]) {
      const db = toneSpectrum(265 + off)
      const k = argmaxInRange(db, 260, 270)
      expect(peakWidthBins(db, k, 10, SILENT_DB, 0)).toBeLessThanOrEqual(4)
      expect(peakWidthBins(db, k, 10, SILENT_DB, 0)).toBeGreaterThanOrEqual(3)
    }
  })

  it('is wide for a broad bump', () => {
    const db = new Float32Array(100).fill(-100)
    for (let k = 40; k <= 60; k++) db[k] = -60 - Math.abs(k - 50) * 0.3
    expect(peakWidthBins(db, 50, 10, -100, 6)).toBeGreaterThan(CONFIG.maxWidthBins)
  })

  it('stays narrow for weak true tones (12-14 dB SNR) in at least 95 % of frames', () => {
    let pass = 0
    let total = 0
    for (const [seed, snr] of [[21, 12], [22, 13], [23, 14]] as const) {
      const s = synthSignal({
        sampleRate: SR,
        durationS: 4,
        noiseDb: NOISE_DB,
        seed,
        tones: [{ hz: 265.3 * BW, levelDb: toneLevelForSnr(snr, NOISE_DB, N), onS: 0, offS: 4 }],
      })
      for (const f of iterateFrames(s, SR, { fftSize: N, hopMs: 20 })) {
        const lp = locatePeak(f.db, 265.3, 2)
        const floor = localFloorDb(f.db, lp.bin, CONFIG.floorHalfBins, CONFIG.floorGuardBins)
        total++
        if (peakWidthBins(f.db, lp.bin, CONFIG.widthDropDb, floor, CONFIG.widthFloorMarginDb) <= CONFIG.maxWidthBins) pass++
      }
    }
    expect(pass / total).toBeGreaterThanOrEqual(0.95)
  })
})

describe('bandLevelDb', () => {
  it('uses the 3 bins nearest the centre', () => {
    const db = new Float32Array(20).fill(-200)
    db[9] = 0
    db[10] = 0
    db[11] = 0
    db[12] = 0
    expect(bandLevelDb(db, 10.3, 3)).toBeCloseTo(10 * Math.log10(3), 6) // bins 9, 10, 11
    expect(bandLevelDb(db, 10.6, 3)).toBeCloseTo(10 * Math.log10(3), 6) // bins 10, 11, 12
  })

  it('varies by less than 0.5 dB as a tone sweeps across a bin', () => {
    const levels: number[] = []
    for (let i = 0; i <= 10; i++) {
      const pos = 265 + i / 10
      const db = toneSpectrum(pos)
      levels.push(bandLevelDb(db, locatePeak(db, pos, 2).binF, 3))
    }
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(0.5)
    // Main lobe power: about 2.3 dB above the bin-centred peak.
    expect(levels[0]! - tonePeakDb(-20)).toBeGreaterThan(1.5)
    expect(levels[0]! - tonePeakDb(-20)).toBeLessThan(3)
  })
})

describe('measureBandAt on pure noise', () => {
  it('matches the band floor on average and has no 3-frame onset at the configured threshold', () => {
    const s = synthSignal({ sampleRate: SR, durationS: 120, noiseDb: NOISE_DB, seed: 31 })
    const snrs: number[] = []
    let run = 0
    let onsets = 0
    for (const f of iterateFrames(s, SR, { fftSize: N, hopMs: CONFIG.hopMs })) {
      const m = measureBandAt(f.db, 3100 / BW, CONFIG.bandBins, CONFIG.floorHalfBins, CONFIG.floorGuardBins, CONFIG.bandFloorOffsetDb)
      snrs.push(m.snrDb)
      run = m.snrDb >= CONFIG.onsetSnrDb ? run + 1 : 0
      if (run === CONFIG.onsetFrames) onsets++
    }
    // bandFloorDb is the expected MEAN noise power of the band, so the mean power ratio is ~0 dB.
    const meanRatioDb = 10 * Math.log10(snrs.reduce((a, s) => a + 10 ** (s / 10), 0) / snrs.length)
    expect(Math.abs(meanRatioDb)).toBeLessThan(0.5)
    // The median of a sum of 3 correlated Rayleigh-power bins sits about 1 dB below its mean.
    expect(median(snrs)).toBeGreaterThan(-1.5)
    expect(median(snrs)).toBeLessThan(0)
    expect(onsets).toBe(0)
  })

  it('reports band SNR about 4 dB below the per-bin SNR of a steady tone', () => {
    const s = synthSignal({
      sampleRate: SR,
      durationS: 2,
      noiseDb: NOISE_DB,
      seed: 41,
      tones: [{ hz: 265 * BW, levelDb: toneLevelForSnr(30, NOISE_DB, N), onS: 0, offS: 2 }],
    })
    const snrs: number[] = []
    for (const f of iterateFrames(s, SR, { fftSize: N, hopMs: 100 })) {
      snrs.push(measureBandAt(f.db, 265, CONFIG.bandBins, CONFIG.floorHalfBins, CONFIG.floorGuardBins, CONFIG.bandFloorOffsetDb).snrDb)
    }
    expect(median(snrs)).toBeGreaterThan(30 - 5)
    expect(median(snrs)).toBeLessThan(30 - 3)
  })

  it('bandFloorDb adds 10*log10(n) plus the Rayleigh offset', () => {
    expect(bandFloorDb(-100, 3, 1.59)).toBeCloseTo(-100 + 4.771 + 1.59, 3)
  })
})

describe('locatePeak', () => {
  it('finds the loudest bin within the window and interpolates it', () => {
    const db = toneSpectrum(300.3)
    const p = locatePeak(db, 298, 5)
    expect(p.bin).toBe(300)
    expect(p.binF).toBeCloseTo(300.3, 1)
  })
})

describe('time-domain helpers', () => {
  it('clipFraction counts |x| >= threshold and is 0 for a -6 dBFS sine', () => {
    expect(clipFraction(new Float32Array([0, 0.99, -1, 0.5]), 0.98)).toBe(0.5)
    const sine = new Float32Array(1000).map((_, i) => 0.5 * Math.sin(i / 10))
    expect(clipFraction(sine, 0.98)).toBe(0)
    expect(clipFraction(new Float32Array(0), 0.98)).toBe(0)
  })

  it('rmsDb is 20*log10(rms) and SILENT_DB for silence', () => {
    expect(rmsDb(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(-6.0206, 3)
    expect(rmsDb(new Float32Array(16))).toBe(SILENT_DB)
  })
})

describe('lockToleranceBins', () => {
  it('is 3 % of f0 but never below the minimum bin count', () => {
    const bw = 48000 / 4096
    expect(lockToleranceBins(3120, bw, 3, 3)).toBeCloseTo((3120 * 0.03) / bw, 9)
    expect(lockToleranceBins(500, bw, 3, 3)).toBe(3)
  })
})
