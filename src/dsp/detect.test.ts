import { describe, expect, it } from 'vitest'
import { CONFIG, withConfig } from '../config.ts'
import type { Config } from '../config.ts'
import type { Frame, Lock, Peak } from '../types.ts'
import { createDetector, detectStep, findPeaks, recentPeaks } from './detect.ts'
import type { DetectorOptions } from './detect.ts'
import {
  bandFloorDb,
  bandLevelDb,
  localFloorDb,
  locatePeak,
  lockToleranceBins,
  median,
  parabolicPeak,
  peakWidthBins,
} from './spectrum.ts'
import { iterateFrames, synthFrames, synthSignal, toneLevelForSnr } from './synth.ts'
import type { NoiseBurstSpec, ToneSpec } from './synth.ts'

const SR = 48000
const N = CONFIG.fftSize
const BW = SR / N
const NOISE_DB = -60
const HOP = CONFIG.hopMs

// ---- Helpers -----------------------------------------------------------------------------------

interface Scene {
  readonly durationS: number
  readonly seed: number
  readonly tones?: readonly ToneSpec[]
  readonly noiseBursts?: readonly NoiseBurstSpec[]
}

/** Frames of white noise at NOISE_DB plus the scene, analysed like the app's engine. */
function sceneFrames(scene: Scene): Frame[] {
  return synthFrames({ sampleRate: SR, noiseDb: NOISE_DB, ...scene }, { fftSize: N, hopMs: HOP })
}

/** A tone of `ms` at `hz` starting at `onS`, scaled to a per-bin peak SNR of `snrDb`. */
function chirp(hz: number, snrDb: number, onS: number, ms: number): ToneSpec {
  return { hz, levelDb: toneLevelForSnr(snrDb, NOISE_DB, N), onS, offS: onS + ms / 1000 }
}

interface RunResult {
  readonly lock: Lock | null
  /** Index of the frame that returned the lock, -1 without one. */
  readonly index: number
}

function runDetector(frames: Iterable<Frame>, cfg: Config = CONFIG, opts: DetectorOptions = {}): RunResult {
  const det = createDetector(cfg, opts)
  let i = 0
  for (const f of frames) {
    const lock = detectStep(det, f, cfg)
    if (lock !== null) return { lock, index: i }
    i++
  }
  return { lock: null, index: -1 }
}

/** The candidate within trackMatchBins of `hz`, if findPeaks reports one in this frame. */
function peakNear(f: Frame, hz: number): Peak | undefined {
  return findPeaks(f.db, f.binHz, CONFIG).find((p) => Math.abs(p.binF - hz / f.binHz) <= CONFIG.trackMatchBins)
}

/** Highest per-bin SNR of the candidates near `hz` in frames with t0Ms <= tMs <= t1Ms. */
function maxSnrNear(frames: readonly Frame[], hz: number, t0Ms: number, t1Ms: number): number {
  let best = -Infinity
  for (const f of frames) {
    if (f.tMs < t0Ms || f.tMs > t1Ms) continue
    const p = peakNear(f, hz)
    if (p !== undefined && p.snrDb > best) best = p.snrDb
  }
  return best
}

/**
 * findPeaks written straight from the specification (no skip-ahead, no early rejection), as an
 * oracle for the optimised implementation. Assumes the search band lies well inside the spectrum.
 */
function referencePeaks(db: Float32Array, binHz: number, cfg: Config, excludeHz: readonly number[] = []): Peak[] {
  const out: Peak[] = []
  const half = cfg.localMaxHalfBins
  for (let k = Math.ceil(cfg.searchBandHz[0] / binHz); k <= Math.floor(cfg.searchBandHz[1] / binHz); k++) {
    let isMax = true
    for (let j = k - half; j < k; j++) if (!(db[j]! < db[k]!)) isMax = false
    for (let j = k + 1; j <= k + half; j++) if (db[j]! > db[k]!) isMax = false
    if (!isMax) continue
    const p = parabolicPeak(db[k - 1]!, db[k]!, db[k + 1]!)
    const floorDb = localFloorDb(db, k, cfg.floorHalfBins, cfg.floorGuardBins)
    const snrDb = p.peakDb - floorDb
    if (snrDb < cfg.candSnrDb) continue
    const widthBins = peakWidthBins(db, k, cfg.widthDropDb, floorDb, cfg.widthFloorMarginDb)
    if (widthBins > cfg.maxWidthBins) continue
    const binF = k + p.delta
    const tol = (hz: number) => lockToleranceBins(hz, binHz, cfg.lockTolPct, cfg.lockTolMinBins)
    if (excludeHz.some((hz) => Math.abs(binF - hz / binHz) <= tol(hz))) continue
    const bandDb = bandLevelDb(db, binF, cfg.bandBins)
    const bandSnrDb = bandDb - bandFloorDb(floorDb, cfg.bandBins, cfg.bandFloorOffsetDb)
    out.push({ bin: k, binF, f0Hz: binF * binHz, peakDb: p.peakDb, floorDb, snrDb, widthBins, bandDb, bandSnrDb })
  }
  return out.sort((a, b) => b.snrDb - a.snrDb).slice(0, cfg.maxCandidates)
}

// Hand-made spectra: a flat floor with exact parabolic peaks, for deterministic tracker tests.
const FLOOR_DB = -100
/** dB drop of the parabola one bin from its vertex (keeps peaks 2-3 bins wide). */
const CURVE_DB = 6

interface Line {
  /** Fractional bin of the vertex (parabolic interpolation recovers it exactly). */
  readonly bin: number
  readonly snrDb: number
}

function handFrame(tMs: number, lines: readonly Line[], extra: Partial<Frame> = {}): Frame {
  const db = new Float32Array(N / 2).fill(FLOOR_DB)
  for (const l of lines) {
    const k = Math.round(l.bin)
    const d = l.bin - k
    for (let j = -1; j <= 1; j++) db[k + j] = FLOOR_DB + l.snrDb - CURVE_DB * (j - d) ** 2
  }
  return { tMs, db, binHz: BW, clipFrac: 0, rmsDb: -60, dtMs: HOP, gap: false, clickTainted: false, ...extra }
}

/**
 * `hits` frames with the given lines (one per hop from t0Ms), then `quiet` empty frames.
 * `lines` may vary per frame.
 */
function handRun(t0Ms: number, hits: number, lines: (i: number) => readonly Line[], quiet = CONFIG.trackCloseMissFrames): Frame[] {
  const out: Frame[] = []
  for (let i = 0; i < hits; i++) out.push(handFrame(t0Ms + i * HOP, lines(i)))
  for (let i = 0; i < quiet; i++) out.push(handFrame(t0Ms + (hits + i) * HOP, []))
  return out
}

const BIN_3120 = 3120 / BW

// ---- findPeaks ---------------------------------------------------------------------------------

describe('findPeaks', () => {
  it('finds a 3120 Hz tone within 2 Hz, with snrDb matching the requested per-bin SNR', () => {
    const snr = 25
    const frames = sceneFrames({ durationS: 1.2, seed: 1, tones: [chirp(3120, snr, 0, 1200)] })
    const snrs: number[] = []
    for (const f of frames) {
      const p = peakNear(f, 3120)
      expect(p).toBeDefined()
      expect(Math.abs(p!.f0Hz - 3120)).toBeLessThan(2)
      expect(p!.widthBins).toBeLessThanOrEqual(CONFIG.maxWidthBins)
      expect(p!.f0Hz).toBeCloseTo(p!.binF * BW, 9)
      expect(p!.snrDb).toBeCloseTo(p!.peakDb - p!.floorDb, 9)
      snrs.push(p!.snrDb)
    }
    // Per frame the 42-bin median floor scatters by a few dB; the median is unbiased.
    expect(Math.abs(median(snrs) - snr)).toBeLessThan(1.5)
  })

  it('reports band SNR about 4 dB below the per-bin SNR', () => {
    const frames = sceneFrames({ durationS: 1.2, seed: 2, tones: [chirp(3120, 30, 0, 1200)] })
    const diffs = frames.map((f) => {
      const p = peakNear(f, 3120)!
      return p.snrDb - p.bandSnrDb
    })
    expect(median(diffs)).toBeGreaterThan(3)
    expect(median(diffs)).toBeLessThan(5)
  })

  it('ignores tones below and above the search band', () => {
    const frames = sceneFrames({
      durationS: 0.6,
      seed: 3,
      tones: [chirp(1000, 30, 0, 600), chirp(8000, 30, 0, 600)],
    })
    const [lo, hi] = CONFIG.searchBandHz
    // Control: with the search band widened to include them, both tones are found in every frame.
    const wide = withConfig({ searchBandHz: [500, 9000] })
    for (const f of frames) {
      for (const p of findPeaks(f.db, f.binHz, CONFIG)) {
        expect(p.f0Hz).toBeGreaterThanOrEqual(lo - BW)
        expect(p.f0Hz).toBeLessThanOrEqual(hi + BW)
      }
      const widePeaks = findPeaks(f.db, f.binHz, wide)
      for (const hz of [1000, 8000]) expect(widePeaks.some((p) => Math.abs(p.f0Hz - hz) < 2)).toBe(true)
    }
  })

  it('rejects a tone at 8 dB SNR in the large majority of frames', () => {
    // 8 dB is 4 dB under candSnrDb; the per-frame floor scatter lets it through now and then.
    const frames = sceneFrames({ durationS: 4, seed: 4, tones: [chirp(3120, 8, 0, 4000)] })
    const hits = frames.filter((f) => peakNear(f, 3120) !== undefined).length
    expect(hits / frames.length).toBeLessThan(0.2)
  })

  it('finds nothing above noise level in a broadband noise burst', () => {
    const frames = sceneFrames({ durationS: 1.2, seed: 5, noiseBursts: [{ atS: 0.5, ms: 200, levelDb: NOISE_DB + 20 }] })
    const windowMs = (N / SR) * 1000
    let burstFrames = 0
    for (const f of frames) {
      if (f.tMs <= 500 || f.tMs - windowMs >= 700) continue
      burstFrames++
      for (const p of findPeaks(f.db, f.binHz, CONFIG)) expect(p.snrDb).toBeLessThan(CONFIG.slowLockSnrDb)
    }
    expect(burstFrames).toBeGreaterThan(10)
  })

  it('drops peaks within lock tolerance of an excluded frequency and keeps the others', () => {
    const frames = sceneFrames({ durationS: 0.5, seed: 6, tones: [chirp(3120, 30, 0, 500), chirp(4000, 30, 0, 500)] })
    for (const f of frames) {
      const all = findPeaks(f.db, f.binHz, CONFIG)
      expect(all.some((p) => Math.abs(p.f0Hz - 3120) < 2)).toBe(true)
      const kept = findPeaks(f.db, f.binHz, CONFIG, [3120])
      expect(kept.some((p) => Math.abs(p.f0Hz - 3120) < 2)).toBe(false)
      expect(kept.some((p) => Math.abs(p.f0Hz - 4000) < 2)).toBe(true)
    }
  })

  it('excludes exactly lockToleranceBins around the excluded frequency', () => {
    const tol = lockToleranceBins(3120, BW, CONFIG.lockTolPct, CONFIG.lockTolMinBins)
    const inside = [BIN_3120 - tol + 0.2, BIN_3120 + tol - 0.2]
    const outside = [BIN_3120 - tol - 0.2, BIN_3120 + tol + 0.2]
    for (const bin of inside) expect(findPeaks(handFrame(0, [{ bin, snrDb: 30 }]).db, BW, CONFIG, [3120])).toEqual([])
    for (const bin of outside) {
      const peaks = findPeaks(handFrame(0, [{ bin, snrDb: 30 }]).db, BW, CONFIG, [3120])
      expect(peaks).toHaveLength(1)
      expect(peaks[0]!.binF).toBeCloseTo(bin, 4)
    }
  })

  it('recovers hand-made peaks exactly, sorted by SNR, capped at maxCandidates', () => {
    const lines: Line[] = []
    for (let i = 0; i < CONFIG.maxCandidates + 3; i++) lines.push({ bin: 140 + i * 30 + 0.25, snrDb: 13 + i })
    const peaks = findPeaks(handFrame(0, lines).db, BW, CONFIG)
    expect(peaks).toHaveLength(CONFIG.maxCandidates)
    const expected = [...lines].sort((a, b) => b.snrDb - a.snrDb).slice(0, CONFIG.maxCandidates)
    peaks.forEach((p, i) => {
      expect(p.binF).toBeCloseTo(expected[i]!.bin, 4)
      expect(p.snrDb).toBeCloseTo(expected[i]!.snrDb, 3)
      expect(p.floorDb).toBeCloseTo(FLOOR_DB, 4)
    })
  })

  it('drops excluded peaks before applying the maxCandidates cap', () => {
    const lines: Line[] = []
    for (let i = 0; i <= CONFIG.maxCandidates; i++) lines.push({ bin: 140 + i * 30, snrDb: 13 + i })
    const strongest = lines[lines.length - 1]!
    const peaks = findPeaks(handFrame(0, lines).db, BW, CONFIG, [strongest.bin * BW])
    // The excluded strongest peak does not use up a slot, so the weakest one is still reported.
    expect(peaks.map((p) => p.bin)).toEqual(lines.slice(0, -1).reverse().map((l) => l.bin))
  })

  it('gives one peak for a plateau and none below candSnrDb or wider than maxWidthBins', () => {
    const db = new Float32Array(N / 2).fill(FLOOR_DB)
    db[300] = db[301] = FLOOR_DB + 30 // plateau
    db[299] = db[302] = FLOOR_DB + 24
    db[360] = FLOOR_DB + CONFIG.candSnrDb - 0.5 // too weak (single-bin spike, no interpolation gain)
    for (let k = 400; k < 400 + CONFIG.maxWidthBins + 2; k++) db[k] = FLOOR_DB + 30 - (k === 402 ? 0 : 1) // too wide
    const peaks = findPeaks(db, BW, CONFIG)
    expect(peaks).toHaveLength(1)
    expect(peaks[0]!.bin).toBe(300)
  })

  it('matches a direct implementation of the specification exactly', () => {
    // Noise plus tones straddling candSnrDb, one of them excluded. The low-threshold variant turns
    // many noise maxima into candidates, exercising the early rejection right at its boundary.
    const snrs = [10, 11, 12, 13, 14, 16, 20, 30]
    const tones = snrs.map((snr, i) => chirp(1700 + i * 530 + i * 3.7, snr, 0.3 + i * 0.4, 2500))
    const frames = sceneFrames({ durationS: 6, seed: 7, tones })
    const low = withConfig({ candSnrDb: CONFIG.candSnrDb - 6, maxCandidates: 1000 })
    const exclude = [tones[5]!.hz]
    let compared = 0
    for (const f of frames) {
      for (const [cfg, ex] of [[CONFIG, []], [CONFIG, exclude], [low, []]] as const) {
        const want = referencePeaks(f.db, f.binHz, cfg, ex)
        expect(findPeaks(f.db, f.binHz, cfg, ex)).toEqual(want)
        compared += want.length
      }
    }
    expect(compared).toBeGreaterThan(20 * frames.length)
  })
})

// ---- Lock policy on synthetic audio ------------------------------------------------------------

describe('detectStep: no lock', () => {
  it('never locks on 5 minutes of white noise', () => {
    const signal = synthSignal({ sampleRate: SR, durationS: 300, noiseDb: NOISE_DB, seed: 101 })
    const { lock } = runDetector(iterateFrames(signal, SR, { fftSize: N, hopMs: HOP }))
    expect(lock).toBeNull()
  }, 30_000)

  it('does not lock on a broadband noise burst 20 dB above the background', () => {
    const frames = sceneFrames({ durationS: 1.5, seed: 11, noiseBursts: [{ atS: 0.5, ms: 200, levelDb: NOISE_DB + 20 }] })
    expect(runDetector(frames).lock).toBeNull()
  })

  it('does not lock on a loud speech-like glide (2500 -> 3500 Hz in 400 ms)', () => {
    const frames = sceneFrames({ durationS: 1.5, seed: 12, tones: [{ hz: 2500, hzEnd: 3500, levelDb: -20, onS: 0.5, offS: 0.9 }] })
    // At 2.5 kHz/s the glide sweeps about 18 bins within one analysis window, so every frame shows it
    // as a loud peak smeared wider than maxWidthBins (the slower glide below reaches the tracker).
    let loudFrames = 0
    for (const f of frames) {
      const at = locatePeak(f.db, 3000 / BW, 600 / BW)
      if (at.peakDb - localFloorDb(f.db, at.bin, CONFIG.floorHalfBins, CONFIG.floorGuardBins) < CONFIG.fastLockSnrDb) continue
      loudFrames++
      expect(peakWidthBins(f.db, at.bin, CONFIG.widthDropDb, -Infinity, 0)).toBeGreaterThan(CONFIG.maxWidthBins)
      expect(findPeaks(f.db, f.binHz, CONFIG).filter((p) => Math.abs(p.bin - at.bin) <= CONFIG.maxWidthBins)).toEqual([])
    }
    expect(loudFrames).toBeGreaterThan(10)
    expect(runDetector(frames).lock).toBeNull()
  })

  it('does not lock on a loud glide that stays narrow in every frame (track matching and stability)', () => {
    // Moving trackMatchBins per hop, each frame is a clean narrow candidate, but a track never keeps
    // persistFrames frames within trackMatchBins of its mean with a std below maxFreqStdBins.
    const hzPerS = (CONFIG.trackMatchBins * BW * 1000) / HOP
    const frames = sceneFrames({
      durationS: 1.6,
      seed: 15,
      tones: [{ hz: 3000, hzEnd: 3000 + hzPerS * 0.6, levelDb: toneLevelForSnr(30, NOISE_DB, N), onS: 0.5, offS: 1.1 }],
    })
    const during = frames.filter((f) => f.tMs >= 600 && f.tMs <= 1050)
    const narrow = during.filter((f) => findPeaks(f.db, f.binHz, CONFIG).some((p) => p.snrDb >= CONFIG.fastLockSnrDb))
    expect(narrow.length / during.length).toBeGreaterThan(0.9)
    expect(runDetector(frames).lock).toBeNull()
  })

  it('does not lock on a loud 5 ms tone burst at 3100 Hz (spectrally wide)', () => {
    const frames = sceneFrames({ durationS: 1.5, seed: 13, tones: [{ hz: 3100, levelDb: -20, onS: 0.5, offS: 0.505 }] })
    // Control: the burst lifts the 3100 Hz band far above the background in several frames, but its
    // energy spreads over tens of bins, so it never shows up as a narrow candidate near 3100 Hz.
    const bin = 3100 / BW
    const tol = lockToleranceBins(3100, BW, CONFIG.lockTolPct, CONFIG.lockTolMinBins)
    const quietDb = median(frames.filter((f) => f.tMs < 450).map((f) => bandLevelDb(f.db, bin, CONFIG.bandBins)))
    const loud = frames.filter((f) => bandLevelDb(f.db, bin, CONFIG.bandBins) - quietDb >= CONFIG.fastLockSnrDb)
    expect(loud.length).toBeGreaterThanOrEqual(CONFIG.persistFrames)
    for (const f of loud) expect(findPeaks(f.db, f.binHz, CONFIG).filter((p) => Math.abs(p.binF - bin) <= tol)).toEqual([])
    expect(runDetector(frames).lock).toBeNull()
  })

  it('does not lock on a continuous tone at 8 dB SNR', () => {
    const frames = sceneFrames({ durationS: 4, seed: 14, tones: [chirp(3120, 8, 0.2, 3800)] })
    expect(runDetector(frames).lock).toBeNull()
  })
})

describe('detectStep: fast lock', () => {
  it('locks on one 200 ms chirp at 25 dB SNR, right after the track closes', () => {
    const snr = 25
    const frames = sceneFrames({ durationS: 1.5, seed: 21, tones: [chirp(3120, snr, 0.5, 200)] })
    const { lock, index } = runDetector(frames)
    expect(lock).not.toBeNull()
    expect(lock!.mode).toBe('chirp')
    expect(lock!.reason).toBe('fast')
    expect(Math.abs(lock!.f0Hz - 3120)).toBeLessThan(2)
    expect(lock!.snrDb).toBeGreaterThanOrEqual(CONFIG.fastLockSnrDb)
    expect(lock!.tMs).toBe(frames[index]!.tMs)
    expect(lock!.chirps).toHaveLength(1)
    const c = lock!.chirps[0]!
    expect(c.f0Hz).toBe(lock!.f0Hz)
    expect(c.durationMs).toBe(c.tEndMs - c.tOnsetMs)
    expect(c.snrDb).toBeCloseTo(c.peakDb - c.bandFloorDb, 9)
    expect(c.clipped).toBe(false)
    expect(c.taintedFrac).toBe(0)
    // The tone becomes visible a few tens of ms after its onset and lasts about D + 40..80 ms.
    expect(c.tOnsetMs).toBeGreaterThan(500)
    expect(c.tOnsetMs).toBeLessThan(500 + 100)
    expect(c.durationMs).toBeGreaterThan(200 - 100)
    expect(c.durationMs).toBeLessThan(200 + 100)

    // Returned within trackCloseMissFrames + 2 hops of the chirp's last visible frame.
    let lastVisible = -1
    for (let i = 0; i < index; i++) if (peakNear(frames[i]!, lock!.f0Hz) !== undefined) lastVisible = i
    expect(index - lastVisible).toBeGreaterThanOrEqual(CONFIG.trackCloseMissFrames)
    expect(index - lastVisible).toBeLessThanOrEqual(CONFIG.trackCloseMissFrames + 2)

    // Peak band level matches the same tone measured steady state.
    const steady = sceneFrames({ durationS: 1.2, seed: 22, tones: [chirp(3120, snr, 0, 1200)] })
    const levels = steady.map((f) => bandLevelDb(f.db, locatePeak(f.db, BIN_3120, 2).binF, CONFIG.bandBins))
    expect(Math.abs(c.peakDb - median(levels))).toBeLessThan(1)
  })

  // KNOWN SPEC GAP (reported): with fftSize 4096 a 20 ms tone is 7-10 bins wide at -10 dB in every
  // frame that contains it (its own bandwidth is about 1 / 20 ms = 50 Hz, and the frames where it
  // sits at the window's tapered ends are wider still), so no frame passes maxWidthBins = 4 and no
  // sighting forms. The next test pins down that diagnosis; the shortest chirps that lock reliably
  // are about 80 ms (the test after it). `it.fails` keeps the spec's assertion: it starts failing
  // loudly once the behaviour is fixed.
  it.fails('locks on a 20 ms chirp at 35 dB SNR (apparent duration >= persistSpanMs)', () => {
    const frames = sceneFrames({ durationS: 1.2, seed: 23, tones: [chirp(3120, 35, 0.5, 20)] })
    const { lock } = runDetector(frames)
    expect(lock).not.toBeNull()
    expect(lock!.reason).toBe('fast')
    expect(Math.abs(lock!.f0Hz - 3120)).toBeLessThan(2)
  })

  it('a 20 ms chirp at 35 dB persists and is strong enough, but is wider than maxWidthBins', () => {
    const frames = sceneFrames({ durationS: 1.2, seed: 23, tones: [chirp(3120, 35, 0.5, 20)] })
    const visible: { tMs: number; snrDb: number; widthBins: number }[] = []
    for (const f of frames) {
      const at = locatePeak(f.db, BIN_3120, CONFIG.localMaxHalfBins)
      const floorDb = localFloorDb(f.db, at.bin, CONFIG.floorHalfBins, CONFIG.floorGuardBins)
      if (at.peakDb - floorDb < CONFIG.candSnrDb) continue
      const widthBins = peakWidthBins(f.db, at.bin, CONFIG.widthDropDb, floorDb, CONFIG.widthFloorMarginDb)
      visible.push({ tMs: f.tMs, snrDb: at.peakDb - floorDb, widthBins })
    }
    // Persistence and SNR would allow a fast lock ...
    expect(visible.length).toBeGreaterThanOrEqual(CONFIG.persistFrames)
    expect(visible[visible.length - 1]!.tMs - visible[0]!.tMs).toBeGreaterThanOrEqual(CONFIG.persistSpanMs)
    expect(Math.max(...visible.map((v) => v.snrDb))).toBeGreaterThanOrEqual(CONFIG.fastLockSnrDb)
    // ... but the width test rejects every frame.
    for (const v of visible) expect(v.widthBins).toBeGreaterThan(CONFIG.maxWidthBins)
  })

  it('locks on an 80 ms chirp at 25 dB SNR', () => {
    for (const seed of [24, 25, 26]) {
      const frames = sceneFrames({ durationS: 1.2, seed, tones: [chirp(3120, 25, 0.5, 80)] })
      const { lock } = runDetector(frames)
      expect(lock?.reason).toBe('fast')
      expect(lock!.chirps[0]!.durationMs).toBeGreaterThanOrEqual(CONFIG.persistSpanMs)
      expect(Math.abs(lock!.f0Hz - 3120)).toBeLessThan(2)
    }
  })

  it('flags a clipped chirp', () => {
    const frames = sceneFrames({ durationS: 1.2, seed: 27, tones: [{ hz: 3120, levelDb: 3, onS: 0.5, offS: 0.7 }] })
    const { lock } = runDetector(frames)
    expect(lock?.reason).toBe('fast')
    expect(lock!.chirps[0]!.clipped).toBe(true)
  })
})

describe('detectStep: slow lock', () => {
  const SLOW_SNR = 17 // between slowLockSnrDb and fastLockSnrDb

  /**
   * Scenario check: each chirp (hz, onset in ms) is a slow-lock sighting on its own. The per-frame
   * SNR scatters by about +-2.5 dB (mostly the 42-bin median floor), so about 13 % of 150 ms chirps
   * at a nominal 17 dB reach fastLockSnrDb in one frame; the seeds below are ones where none does.
   */
  function expectSlowSightings(frames: readonly Frame[], chirps: readonly (readonly [number, number])[]): void {
    for (const [hz, t0] of chirps) {
      const snr = maxSnrNear(frames, hz, t0, t0 + 300)
      expect(snr).toBeGreaterThanOrEqual(CONFIG.slowLockSnrDb)
      expect(snr).toBeLessThan(CONFIG.fastLockSnrDb)
    }
  }

  it('locks on two 150 ms chirps at 17 dB SNR, 10 s apart', () => {
    const frames = sceneFrames({ durationS: 11, seed: 33, tones: [chirp(3120, SLOW_SNR, 0.5, 150), chirp(3120, SLOW_SNR, 10.5, 150)] })
    expectSlowSightings(frames, [[3120, 500], [3120, 10_500]])
    const { lock } = runDetector(frames)
    expect(lock).not.toBeNull()
    expect(lock!.mode).toBe('chirp')
    expect(lock!.reason).toBe('slow')
    expect(lock!.tMs).toBeGreaterThan(10_500)
    expect(lock!.chirps).toHaveLength(2)
    const [a, b] = lock!.chirps
    expect(a!.tOnsetMs).toBeLessThan(b!.tOnsetMs)
    expect(a!.tOnsetMs).toBeGreaterThan(500)
    expect(a!.tOnsetMs).toBeLessThan(700)
    expect(b!.tOnsetMs).toBeGreaterThan(10_500)
    expect(lock!.f0Hz).toBeCloseTo((a!.f0Hz + b!.f0Hz) / 2, 9)
    expect(Math.abs(lock!.f0Hz - 3120)).toBeLessThan(2)
    expect(lock!.snrDb).toBeGreaterThanOrEqual(CONFIG.slowLockSnrDb)
    expect(lock!.snrDb).toBeLessThan(CONFIG.fastLockSnrDb)
  })

  it('does not lock on two chirps 6 % apart in frequency', () => {
    const hz2 = 3120 * 1.06
    const frames = sceneFrames({ durationS: 11, seed: 31, tones: [chirp(3120, SLOW_SNR, 0.5, 150), chirp(hz2, SLOW_SNR, 10.5, 150)] })
    expectSlowSightings(frames, [[3120, 500], [hz2, 10_500]])
    expect(runDetector(frames).lock).toBeNull()
  })

  it('does not lock on a double chirp 0.5 s apart, but locks with a third chirp 30 s later', () => {
    const onsets = [0.5, 1.0, 31.0]
    const frames = sceneFrames({ durationS: 32, seed: 31, tones: onsets.map((on) => chirp(3120, SLOW_SNR, on, 150)) })
    expectSlowSightings(frames, onsets.map((on) => [3120, on * 1000] as const))
    const { lock } = runDetector(frames)
    expect(lock).not.toBeNull()
    expect(lock!.reason).toBe('slow')
    expect(lock!.tMs).toBeGreaterThan(31_000)
    const [a, b] = lock!.chirps
    expect(a!.tOnsetMs).toBeLessThan(1_300)
    expect(b!.tOnsetMs).toBeGreaterThan(31_000)
  })
})

describe('detectStep: sustained lock', () => {
  it('locks in live mode on a continuous tone at 20 dB SNR within sustainedLockMs + 150 ms', () => {
    const frames = sceneFrames({ durationS: 3, seed: 41, tones: [chirp(3120, 20, 0.5, 2500)] })
    const { lock } = runDetector(frames)
    expect(lock).not.toBeNull()
    expect(lock!.mode).toBe('live')
    expect(lock!.reason).toBe('sustained')
    expect(lock!.chirps).toEqual([])
    expect(Math.abs(lock!.f0Hz - 3120)).toBeLessThan(2)
    const visibleMs = frames.find((f) => peakNear(f, 3120) !== undefined)!.tMs
    expect(lock!.tMs - visibleMs).toBeGreaterThanOrEqual(CONFIG.sustainedLockMs)
    expect(lock!.tMs - visibleMs).toBeLessThanOrEqual(CONFIG.sustainedLockMs + 150)
  })
})

describe('detectStep: exclusions and gaps', () => {
  it('ignores an excluded frequency but locks on another one', () => {
    const frames = sceneFrames({ durationS: 2.5, seed: 51, tones: [chirp(3120, 25, 0.5, 200), chirp(4000, 25, 1.5, 200)] })
    // Control: without the exclusion the first chirp locks.
    expect(Math.abs(runDetector(frames).lock!.f0Hz - 3120)).toBeLessThan(2)
    const { lock } = runDetector(frames, CONFIG, { excludeHz: [3120] })
    expect(lock?.reason).toBe('fast')
    expect(Math.abs(lock!.f0Hz - 4000)).toBeLessThan(2)
    expect(lock!.chirps[0]!.tOnsetMs).toBeGreaterThan(1_500)
  })

  it('a frame gap in the middle of a strong chirp stops that chirp from locking', () => {
    const frames = sceneFrames({ durationS: 4, seed: 52, tones: [chirp(3120, 30, 0.5, 300), chirp(3120, 30, 3.0, 300)] })
    // Control: without the gap the first chirp locks.
    expect(runDetector(frames).lock!.chirps[0]!.tOnsetMs).toBeLessThan(1_000)
    const mid = frames.findIndex((f) => f.tMs >= 650)
    const gapped = frames.map((f, i) => (i === mid ? { ...f, gap: true, dtMs: CONFIG.frameGapAbortMs + HOP } : f))
    const { lock } = runDetector(gapped)
    // Only the second, uninterrupted chirp locks.
    expect(lock?.reason).toBe('fast')
    expect(lock!.chirps[0]!.tOnsetMs).toBeGreaterThan(3_000)
  })
})

// ---- Tracker rules on hand-made spectra --------------------------------------------------------

describe('detectStep: tracker rules', () => {
  const at = (bin: number, snrDb = 30) => (): readonly Line[] => [{ bin, snrDb }]
  /** Per-bin SNR between slowLockSnrDb and fastLockSnrDb. */
  const SLOW = (CONFIG.slowLockSnrDb + CONFIG.fastLockSnrDb) / 2

  it('needs persistFrames frames spanning persistSpanMs', () => {
    expect(CONFIG.persistSpanMs).toBeLessThanOrEqual((CONFIG.persistFrames - 1) * HOP)
    expect(runDetector(handRun(0, CONFIG.persistFrames - 1, at(300.2))).lock).toBeNull()
    const frames = handRun(0, CONFIG.persistFrames, at(300.2))
    const { lock, index } = runDetector(frames)
    expect(lock?.reason).toBe('fast')
    // Returned on the trackCloseMissFrames-th frame without a match.
    expect(index).toBe(CONFIG.persistFrames - 1 + CONFIG.trackCloseMissFrames)
    expect(lock!.f0Hz).toBeCloseTo(300.2 * BW, 3)
    expect(lock!.chirps[0]!.tOnsetMs).toBe(0)
    expect(lock!.chirps[0]!.tEndMs).toBe((CONFIG.persistFrames - 1) * HOP)
  })

  it('bridges fewer than trackCloseMissFrames missing frames', () => {
    const frames = [
      handFrame(0, [{ bin: 300, snrDb: 30 }]),
      handFrame(HOP, [{ bin: 300, snrDb: 30 }]),
      ...Array.from({ length: CONFIG.trackCloseMissFrames - 1 }, (_, i) => handFrame((2 + i) * HOP, [])),
      handFrame((1 + CONFIG.trackCloseMissFrames) * HOP, [{ bin: 300, snrDb: 30 }]),
      ...Array.from({ length: CONFIG.trackCloseMissFrames }, (_, i) => handFrame((2 + CONFIG.trackCloseMissFrames + i) * HOP, [])),
    ]
    const { lock } = runDetector(frames)
    expect(lock?.chirps[0]!.tEndMs).toBe((1 + CONFIG.trackCloseMissFrames) * HOP)
  })

  it('records the loudest frame, the mean frequency, clipping and click taint', () => {
    const snrs = [22, 34, 28, 25, 23]
    const bins = [300.1, 300.3, 300.2, 300.4, 300.0]
    const frames = handRun(0, snrs.length, (i) => [{ bin: bins[i]!, snrDb: snrs[i]! }]).map((f, i) =>
      i === 2 ? { ...f, clipFrac: CONFIG.clipFraction * 2 } : i === 1 || i === 3 ? { ...f, clickTainted: true } : f,
    )
    const { lock } = runDetector(frames)
    const c = lock!.chirps[0]!
    const loud = findPeaks(frames[1]!.db, BW, CONFIG)[0]!
    expect(c.peakDb).toBeCloseTo(loud.bandDb, 6)
    expect(c.snrDb).toBeCloseTo(loud.bandSnrDb, 6)
    expect(c.f0Hz).toBeCloseTo((bins.reduce((a, b) => a + b, 0) / bins.length) * BW, 3)
    expect(c.clipped).toBe(true)
    expect(c.taintedFrac).toBeCloseTo(2 / snrs.length, 9)
    expect(lock!.snrDb).toBeCloseTo(Math.max(...snrs), 3)
  })

  it('rejects a track whose frequency wanders by maxFreqStdBins or more', () => {
    // Offsets that always stay within trackMatchBins of the running mean, so one track holds them.
    const wander = (scale: number) => Array.from({ length: 7 }, (_, i) => (i === 0 ? 0 : i % 2 ? 0.9 : -0.45) * scale)
    const std = (xs: readonly number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)
    }
    const wobbly = wander(1)
    const steady = wander(0.7)
    expect(std(wobbly)).toBeGreaterThan(CONFIG.maxFreqStdBins)
    expect(std(steady)).toBeLessThan(CONFIG.maxFreqStdBins)
    const run = (offsets: readonly number[]) => runDetector(handRun(0, offsets.length, (i) => [{ bin: 300 + offsets[i]!, snrDb: 30 }]))
    expect(run(steady).lock?.reason).toBe('fast')
    expect(run(wobbly).lock).toBeNull()
  })

  it('rejects a track longer than maxChirpMs as a chirp', () => {
    const cfg = withConfig({ sustainedLockMs: CONFIG.maxChirpMs * 2 })
    const frames = (spanMs: number) => handRun(0, spanMs / HOP + 1, at(300))
    expect(runDetector(frames(CONFIG.maxChirpMs), cfg).lock?.reason).toBe('fast')
    expect(runDetector(frames(CONFIG.maxChirpMs + HOP), cfg).lock).toBeNull()
  })

  it('keeps at most maxTracks tracks, dropping the weakest', () => {
    const lines = Array.from({ length: CONFIG.maxTracks + 2 }, (_, i) => ({ bin: 140 + i * 40, snrDb: 13 + i }))
    const det = createDetector(CONFIG)
    detectStep(det, handFrame(0, lines), CONFIG)
    expect(det.tracks).toHaveLength(CONFIG.maxTracks)
    expect(Math.min(...det.tracks.map((t) => t.maxSnrDb))).toBe(13 + 2)
  })

  it('matches the strongest candidate first, one candidate per track', () => {
    // A wider match window so that two candidates (which findPeaks keeps > localMaxHalfBins apart)
    // can both reach one track. The stronger one takes it even though the weaker one is nearer.
    const cfg = withConfig({ trackMatchBins: 3 })
    const det = createDetector(cfg)
    detectStep(det, handFrame(0, [{ bin: 302.4, snrDb: 25 }]), cfg)
    detectStep(det, handFrame(HOP, [{ bin: 300, snrDb: 20 }, { bin: 305, snrDb: 30 }]), cfg)
    expect(det.tracks).toHaveLength(2)
    const [kept, opened] = det.tracks
    expect(kept!.frames).toBe(2)
    expect(kept!.meanBin).toBeCloseTo((302.4 + 305) / 2, 4)
    expect(kept!.maxSnrDb).toBeCloseTo(30, 3)
    expect(opened!.frames).toBe(1)
    expect(opened!.meanBin).toBeCloseTo(300, 4)
  })

  it('returns a lock only once', () => {
    const frames = [...handRun(0, 5, at(300)), ...handRun(1000, 5, at(400))]
    const det = createDetector(CONFIG)
    const locks = frames.map((f) => detectStep(det, f, CONFIG)).filter((l) => l !== null)
    expect(locks).toHaveLength(1)
  })

  it('slow-locks two sightings slowLockGapMs apart but not closer', () => {
    const pair = (gapMs: number) => [...handRun(0, 5, at(300, SLOW)), ...handRun(gapMs, 5, at(300.5, SLOW))]
    const lock = runDetector(pair(CONFIG.slowLockGapMs)).lock
    expect(lock?.reason).toBe('slow')
    expect(lock!.f0Hz).toBeCloseTo(300.25 * BW, 3)
    expect(lock!.chirps.map((c) => c.tOnsetMs)).toEqual([0, CONFIG.slowLockGapMs])
    expect(runDetector(pair(CONFIG.slowLockGapMs - HOP)).lock).toBeNull()
  })

  it('slow-locks only within lock tolerance and below the memory age', () => {
    const tol = lockToleranceBins(300 * BW, BW, CONFIG.lockTolPct, CONFIG.lockTolMinBins)
    const pair = (gapMs: number, bin2: number) => [...handRun(0, 5, at(300, SLOW)), ...handRun(gapMs, 5, at(bin2, SLOW))]
    expect(runDetector(pair(5000, 300 + tol - 0.5)).lock?.reason).toBe('slow')
    expect(runDetector(pair(5000, 300 + tol + 0.5)).lock).toBeNull()
    expect(runDetector(pair(CONFIG.slowLockMemoryMs - 200, 300)).lock?.reason).toBe('slow')
    expect(runDetector(pair(CONFIG.slowLockMemoryMs + HOP, 300)).lock).toBeNull()
  })

  it('slow-locks only when both sightings reach slowLockSnrDb', () => {
    const weak = CONFIG.slowLockSnrDb - 0.5
    const weakFirst = [...handRun(0, 5, at(300, weak)), ...handRun(5000, 5, at(300, SLOW))]
    expect(runDetector(weakFirst).lock).toBeNull()
    const weakSecond = [...handRun(0, 5, at(300, SLOW)), ...handRun(5000, 5, at(300, weak))]
    expect(runDetector(weakSecond).lock).toBeNull()
  })

  it('prefers a fast lock over a slow pair', () => {
    const frames = [...handRun(0, 5, at(300, SLOW)), ...handRun(5000, 5, at(300, CONFIG.fastLockSnrDb + 5))]
    const lock = runDetector(frames).lock
    expect(lock?.reason).toBe('fast')
    expect(lock!.chirps.map((c) => c.tOnsetMs)).toEqual([5000])
  })

  describe('memory of sightings closed out of onset order', () => {
    // A long sighting at bin 300 (onset 0 ms, 2 s long) closes after a short one at bin `shortBin`
    // (onset 1000 ms), so the memory holds them in closing order, not onset order.
    const cfg = withConfig({ slowLockMemoryMs: 5000, sustainedLockMs: 60_000 })
    const longHits = 2000 / HOP + 1
    const shortFrom = 1000 / HOP
    const scene = (shortBin: number, thirdBin: number, thirdMs: number): Frame[] => {
      const lines = (i: number): Line[] => [
        { bin: 300, snrDb: SLOW },
        ...(i >= shortFrom && i < shortFrom + 5 ? [{ bin: shortBin, snrDb: SLOW }] : []),
      ]
      return [...handRun(0, longHits, lines), ...handRun(thirdMs, 5, at(thirdBin, SLOW))]
    }

    it('forgets a sighting older than slowLockMemoryMs even behind a newer one', () => {
      // The third sighting closes (5 + trackCloseMissFrames - 1) hops after its onset.
      const closeMs = (onsetMs: number) => onsetMs + (4 + CONFIG.trackCloseMissFrames) * HOP
      const inTime = cfg.slowLockMemoryMs - closeMs(0) - HOP
      expect(runDetector(scene(400, 300, inTime), cfg).lock?.chirps.map((c) => c.tOnsetMs)).toEqual([0, inTime])
      const tooLate = cfg.slowLockMemoryMs - closeMs(0) + HOP
      expect(closeMs(tooLate) - 1000).toBeLessThan(cfg.slowLockMemoryMs) // the short one is still remembered
      expect(runDetector(scene(400, 300, tooLate), cfg).lock).toBeNull()
    })

    it('pairs with the most recently started matching sighting', () => {
      // Bins 300 and 305 are separate tracks but both within lock tolerance of bin 302.5.
      const lock = runDetector(scene(305, 302.5, 4000), cfg).lock
      expect(lock?.reason).toBe('slow')
      expect(lock!.chirps.map((c) => c.tOnsetMs)).toEqual([1000, 4000])
      expect(lock!.f0Hz).toBeCloseTo(((305 + 302.5) / 2) * BW, 3)
    })
  })

  it('gap frames discard open tracks; a track opened on a gap frame never becomes a sighting', () => {
    const frames = handRun(0, 8, at(300)).map((f, i) => (i === 4 ? { ...f, gap: true } : f))
    expect(runDetector(frames).lock).toBeNull()
    // The same with the gap before the tone: the onset is seen normally and it locks.
    const clean = [handFrame(0, [], { gap: true }), ...handRun(HOP, 8, at(300))]
    expect(runDetector(clean).lock?.reason).toBe('fast')
  })

  it('a continuous tone interrupted by a gap still locks as sustained', () => {
    const hits = CONFIG.sustainedLockMs / HOP + 20
    const frames = handRun(0, hits, at(300), 0).map((f, i) => (i === 10 ? { ...f, gap: true } : f))
    const { lock, index } = runDetector(frames)
    expect(lock?.reason).toBe('sustained')
    expect(frames[index]!.tMs - frames[10]!.tMs).toBe(CONFIG.sustainedLockMs)
  })

  it('a change of bin width discards open tracks like a gap', () => {
    const bw2 = 44100 / N
    const withBw = (frames: Frame[]) => frames.map((f) => ({ ...f, binHz: bw2 }))
    // Bin 300 before and after the change is two different frequencies, not one six-frame track.
    const frames = [...handRun(0, 3, at(300), 0), ...withBw(handRun(3 * HOP, 3, at(300)))]
    expect(runDetector(frames).lock).toBeNull()
    // A chirp that starts after the change locks at the new bin width.
    const { lock } = runDetector([...frames, ...withBw(handRun(1000, 5, at(300)))])
    expect(lock?.reason).toBe('fast')
    expect(lock!.f0Hz).toBeCloseTo(300 * bw2, 3)
    expect(lock!.chirps[0]!.tOnsetMs).toBe(1000)
  })

  it('a new time base forgets remembered sightings and the peak ring', () => {
    const det = createDetector(CONFIG)
    for (const f of handRun(10_000, 5, at(300, SLOW))) expect(detectStep(det, f, CONFIG)).toBeNull()
    expect(det.memory).toHaveLength(1)
    expect(recentPeaks(det, 10_140, 1000)).toHaveLength(5)
    expect(detectStep(det, handFrame(0, []), CONFIG)).toBeNull() // frame times restart at 0
    expect(det.memory).toHaveLength(0)
    expect(recentPeaks(det, 10_140, 1000)).toEqual([])
    // 2.5 s "after" the old sighting on the new time base: no pairing across time bases.
    for (const f of handRun(12_500, 5, at(300, SLOW))) expect(detectStep(det, f, CONFIG)).toBeNull()
  })
})

// ---- Peak ring buffer --------------------------------------------------------------------------

describe('recentPeaks', () => {
  /** Frame i carries one peak at a bin that identifies it; every 7th frame has no peak. */
  const binOf = (i: number) => 140 + (i % 40) * 9
  const frameAt = (i: number) => handFrame(i * HOP, i % 7 === 3 ? [] : [{ bin: binOf(i), snrDb: 15 }])

  it('returns the strongest peak of each frame in the window, oldest first', () => {
    const det = createDetector(CONFIG)
    for (let i = 0; i < 30; i++) {
      detectStep(det, handFrame(i * HOP, [{ bin: binOf(i), snrDb: 15 }, { bin: binOf(i + 20), snrDb: 13 }]), CONFIG)
    }
    const now = 29 * HOP
    const got = recentPeaks(det, now, 5 * HOP)
    expect(got.map((p) => p.bin)).toEqual([25, 26, 27, 28, 29].map(binOf))
    expect(got.every((p) => Math.abs(p.snrDb - 15) < 1e-3)).toBe(true)
  })

  it('skips frames without peaks and excludes frames outside the window', () => {
    const det = createDetector(CONFIG)
    for (let i = 0; i < 30; i++) detectStep(det, frameAt(i), CONFIG)
    const now = 29 * HOP
    const expected = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29].filter((i) => i % 7 !== 3).map(binOf)
    expect(recentPeaks(det, now, 10 * HOP).map((p) => p.bin)).toEqual(expected)
    // Asking about an earlier moment ignores the newer frames (frame 10 has no peak).
    expect(recentPeaks(det, 12 * HOP, 3 * HOP).map((p) => p.bin)).toEqual([11, 12].map(binOf))
  })

  it('keeps only the last candidateRingMs', () => {
    const det = createDetector(CONFIG)
    const count = (2 * CONFIG.candidateRingMs) / HOP
    for (let i = 0; i < count; i++) detectStep(det, frameAt(i), CONFIG)
    const now = (count - 1) * HOP
    const got = recentPeaks(det, now, 10 * CONFIG.candidateRingMs)
    const expected: number[] = []
    for (let i = 0; i < count; i++) if (i * HOP > now - CONFIG.candidateRingMs && i % 7 !== 3) expected.push(binOf(i))
    expect(got.map((p) => p.bin)).toEqual(expected)
  })
})
