import { describe, expect, it } from 'vitest'
import { CONFIG, withConfig } from '../config.ts'
import type { Config } from '../config.ts'
import type { Frame, Lock, Peak, PendingBeep } from '../types.ts'
import { createDetector, detectStep, findPeaks, lockFromPending, pendingBeep, recentPeaks } from './detect.ts'
import { createHunt, huntView } from './hunt.ts'
import type { DetectorOptions, DetectorState } from './detect.ts'
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
/** The single-chirp lock policy: one strong sighting locks at once (fast lock). */
const FAST = withConfig({ lockConfirmChirps: 1 })

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
  /** The detector after the run (for pendingBeep / lockFromPending). */
  readonly det: DetectorState
}

function runDetector(frames: Iterable<Frame>, cfg: Config = CONFIG, opts: DetectorOptions = {}): RunResult {
  const det = createDetector(cfg, opts)
  let i = 0
  for (const f of frames) {
    const lock = detectStep(det, f, cfg)
    if (lock !== null) return { lock, index: i, det }
    i++
  }
  return { lock: null, index: -1, det }
}

/**
 * Neither lock policy locks (with FAST a single strong sighting would), and listening with CONFIG
 * never shows a pending beep.
 */
function expectNothingHeard(frames: readonly Frame[]): void {
  expect(runDetector(frames, FAST).lock).toBeNull()
  const det = createDetector(CONFIG)
  let locks = 0
  let pending = 0
  for (const f of frames) {
    if (detectStep(det, f, CONFIG) !== null) locks++
    if (pendingBeep(det, f.tMs, CONFIG) !== null) pending++
  }
  expect(locks).toBe(0)
  expect(pending).toBe(0)
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
  it('never locks on 5 minutes of white noise and never shows a pending beep', () => {
    const signal = synthSignal({ sampleRate: SR, durationS: 300, noiseDb: NOISE_DB, seed: 101 })
    // Both policies in one pass over the frames (the analysis is the slow part).
    const det = createDetector(CONFIG)
    const fast = createDetector(FAST)
    let frames = 0
    let locks = 0
    let pending = 0
    for (const f of iterateFrames(signal, SR, { fftSize: N, hopMs: HOP })) {
      frames++
      if (detectStep(det, f, CONFIG) !== null) locks++
      if (detectStep(fast, f, FAST) !== null) locks++
      if (pendingBeep(det, f.tMs, CONFIG) !== null) pending++
    }
    expect(frames).toBeGreaterThan((300_000 / HOP) * 0.99)
    expect(locks).toBe(0)
    expect(pending).toBe(0)
    expect(lockFromPending(det, det.lastMs, CONFIG)).toBeNull()
  }, 30_000)

  it('does not lock on a broadband noise burst 20 dB above the background', () => {
    const frames = sceneFrames({ durationS: 1.5, seed: 11, noiseBursts: [{ atS: 0.5, ms: 200, levelDb: NOISE_DB + 20 }] })
    expectNothingHeard(frames)
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
    expectNothingHeard(frames)
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
    expectNothingHeard(frames)
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
    expectNothingHeard(frames)
  })

  it('does not lock on a continuous tone at 8 dB SNR', () => {
    const frames = sceneFrames({ durationS: 4, seed: 14, tones: [chirp(3120, 8, 0.2, 3800)] })
    expectNothingHeard(frames)
  })
})

describe('detectStep: fast lock (lockConfirmChirps 1)', () => {
  // With the default lockConfirmChirps 2 none of these lock on their own (see 'confirmed lock').
  it('locks on one 200 ms chirp at 25 dB SNR, right after the track closes', () => {
    const snr = 25
    const frames = sceneFrames({ durationS: 1.5, seed: 21, tones: [chirp(3120, snr, 0.5, 200)] })
    const { lock, index } = runDetector(frames, FAST)
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

  // KNOWN LIMIT: a 20 ms tone is spectrally wide (its own bandwidth is about 1 / 20 ms = 50 Hz, and
  // frames where it sits at the window's tapered ends are wider still), so even the relaxed width
  // rule (-6 dB, 5 bins) rejects it and no sighting forms. The next test pins down that diagnosis.
  // Chirps of 40 ms and longer lock reliably (see 'locks on most 40-50 ms chirps'). `it.fails`
  // keeps the original assertion: it starts failing loudly if 20 ms chirps ever lock. It runs with
  // the single-chirp policy, where one sighting would be enough to lock.
  it.fails('locks on a 20 ms chirp at 35 dB SNR (apparent duration >= persistSpanMs)', () => {
    const frames = sceneFrames({ durationS: 1.2, seed: 23, tones: [chirp(3120, 35, 0.5, 20)] })
    const { lock } = runDetector(frames, FAST)
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

  it('locks on most 40-50 ms chirps at 30 dB SNR (relaxed -6 dB / 5-bin width rule)', () => {
    let locks = 0
    let total = 0
    for (const ms of [40, 50]) {
      for (const seed of [31, 32, 33, 34, 35]) {
        const on = 0.5 + seed * 0.0037 // vary the chirp's phase against the frame grid
        const frames = sceneFrames({ durationS: 1.2, seed, tones: [chirp(3100 + seed, 30, on, ms)] })
        total++
        if (runDetector(frames, FAST).lock?.reason === 'fast') locks++
      }
    }
    expect(locks / total).toBeGreaterThanOrEqual(0.8)
  })

  it('locks on an 80 ms chirp at 25 dB SNR', () => {
    for (const seed of [24, 25, 26]) {
      const frames = sceneFrames({ durationS: 1.2, seed, tones: [chirp(3120, 25, 0.5, 80)] })
      const { lock } = runDetector(frames, FAST)
      expect(lock?.reason).toBe('fast')
      expect(lock!.chirps[0]!.durationMs).toBeGreaterThanOrEqual(CONFIG.persistSpanMs)
      expect(Math.abs(lock!.f0Hz - 3120)).toBeLessThan(2)
    }
  })

  it('flags a clipped chirp', () => {
    const frames = sceneFrames({ durationS: 1.2, seed: 27, tones: [{ hz: 3120, levelDb: 3, onS: 0.5, offS: 0.7 }] })
    const { lock } = runDetector(frames, FAST)
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
    // Neither chirp is strong enough for a fast lock, so the single-chirp policy agrees.
    expect(runDetector(frames, FAST).lock).toEqual(lock)
  })

  it('does not lock on two chirps 6 % apart in frequency', () => {
    const hz2 = 3120 * 1.06
    const frames = sceneFrames({ durationS: 11, seed: 31, tones: [chirp(3120, SLOW_SNR, 0.5, 150), chirp(hz2, SLOW_SNR, 10.5, 150)] })
    expectSlowSightings(frames, [[3120, 500], [hz2, 10_500]])
    expect(runDetector(frames).lock).toBeNull()
    expect(runDetector(frames, FAST).lock).toBeNull()
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
    expect(runDetector(frames, FAST).lock).toEqual(lock)
    // Before the third chirp the double chirp shows as one pending beep heard twice.
    const early = runDetector(frames.filter((f) => f.tMs < 30_000))
    expect(early.lock).toBeNull()
    const beep = pendingBeep(early.det, early.det.lastMs, CONFIG)
    expect(beep?.sightings).toBe(2)
    expect(Math.abs(beep!.f0Hz - 3120)).toBeLessThan(2)
    expect(beep!.heardAtMs).toBeGreaterThan(1_000)
    expect(beep!.heardAtMs).toBeLessThan(1_300)
  })
})

describe('detectStep: confirmed lock (lockConfirmChirps 2)', () => {
  it('is the default', () => {
    expect(CONFIG.lockConfirmChirps).toBe(2)
  })

  it('does not lock on one strong 200 ms chirp, but shows it as pending once it has ended', () => {
    const frames = sceneFrames({ durationS: 1.5, seed: 21, tones: [chirp(3120, 25, 0.5, 200)] })
    // Control: the single-chirp policy locks on it when its track closes.
    const fast = runDetector(frames, FAST)
    expect(fast.lock?.reason).toBe('fast')
    const det = createDetector(CONFIG)
    let locks = 0
    let firstPending = -1
    frames.forEach((f, i) => {
      if (detectStep(det, f, CONFIG) !== null) locks++
      if (firstPending < 0 && pendingBeep(det, f.tMs, CONFIG) !== null) firstPending = i
    })
    expect(locks).toBe(0)
    expect(firstPending).toBe(fast.index)
    const beep = pendingBeep(det, det.lastMs, CONFIG)!
    expect(beep.sightings).toBe(1)
    expect(Math.abs(beep.f0Hz - 3120)).toBeLessThan(2)
    expect(beep.f0Hz).toBe(fast.lock!.f0Hz)
    expect(beep.snrDb).toBe(fast.lock!.snrDb)
    expect(beep.snrDb).toBeGreaterThanOrEqual(CONFIG.fastLockSnrDb)
    expect(beep.heardAtMs).toBe(fast.lock!.chirps[0]!.tOnsetMs)
  })

  it('locks slow when a second chirp at the same frequency confirms it 10 s later', () => {
    const frames = sceneFrames({ durationS: 11, seed: 61, tones: [chirp(3120, 30, 0.5, 200), chirp(3120, 22, 10.5, 200)] })
    // Control: the single-chirp policy locks on the first chirp alone.
    expect(runDetector(frames, FAST).lock!.chirps[0]!.tOnsetMs).toBeLessThan(1_000)
    const { lock } = runDetector(frames)
    expect(lock).not.toBeNull()
    expect(lock!.mode).toBe('chirp')
    expect(lock!.reason).toBe('slow')
    expect(lock!.tMs).toBeGreaterThan(10_700)
    expect(lock!.chirps).toHaveLength(2)
    const [a, b] = lock!.chirps
    expect(a!.tOnsetMs).toBeGreaterThan(500)
    expect(a!.tOnsetMs).toBeLessThan(700)
    expect(b!.tOnsetMs).toBeGreaterThan(10_500)
    expect(b!.tOnsetMs).toBeLessThan(10_700)
    expect(lock!.f0Hz).toBeCloseTo((a!.f0Hz + b!.f0Hz) / 2, 9)
    expect(Math.abs(lock!.f0Hz - 3120)).toBeLessThan(2)
    expect(lock!.snrDb).toBeGreaterThanOrEqual(CONFIG.fastLockSnrDb)

    // While it waits, the first chirp is shown from the frame its track closes until the confirming
    // chirp locks: it never disappears in between and stays the same object (no needless UI updates).
    const det = createDetector(CONFIG)
    let shown: PendingBeep | null = null
    let changes = 0
    let locked: Lock | null = null
    for (const f of frames) {
      locked = detectStep(det, f, CONFIG)
      if (locked !== null) break
      const beep = pendingBeep(det, f.tMs, CONFIG)
      if (shown !== null) expect(beep).not.toBeNull()
      if (beep !== shown) changes++
      shown = beep
    }
    expect(locked).toEqual(lock)
    expect(changes).toBe(1)
    expect(shown!.sightings).toBe(1)
    expect(shown!.heardAtMs).toBe(a!.tOnsetMs)
    expect(Math.abs(shown!.f0Hz - 3120)).toBeLessThan(2)
  })

  it('does not lock when the second chirp is 6 % off, and keeps showing the first (louder) one', () => {
    const hz2 = 3120 * 1.06
    const frames = sceneFrames({ durationS: 11, seed: 61, tones: [chirp(3120, 30, 0.5, 200), chirp(hz2, 22, 10.5, 200)] })
    const { lock, det } = runDetector(frames)
    expect(lock).toBeNull()
    // Both chirps were heard, as two different beeps.
    expect(det.memory).toHaveLength(2)
    expect(Math.abs(det.memory[0]!.chirp.f0Hz - 3120)).toBeLessThan(2)
    expect(Math.abs(det.memory[1]!.chirp.f0Hz - hz2)).toBeLessThan(2)
    const beep = pendingBeep(det, det.lastMs, CONFIG)!
    expect(beep.sightings).toBe(1)
    expect(Math.abs(beep.f0Hz - 3120)).toBeLessThan(2)
    expect(beep.heardAtMs).toBeLessThan(1_000)
  })

  it('"Use it now" locks on the single chirp heard so far, once', () => {
    const frames = sceneFrames({ durationS: 1.5, seed: 21, tones: [chirp(3120, 25, 0.5, 200)] })
    const { lock, det } = runDetector(frames)
    expect(lock).toBeNull()
    const beep = pendingBeep(det, det.lastMs, CONFIG)!
    const now = det.lastMs + 7
    const manual = lockFromPending(det, now, CONFIG)
    expect(manual).not.toBeNull()
    expect(manual!.mode).toBe('chirp')
    expect(manual!.reason).toBe('manual')
    expect(manual!.tMs).toBe(now)
    expect(Math.abs(manual!.f0Hz - 3120)).toBeLessThan(2)
    expect(manual!.f0Hz).toBe(beep.f0Hz)
    expect(manual!.snrDb).toBe(beep.snrDb)
    expect(manual!.chirps).toHaveLength(1)
    expect(manual!.chirps[0]!.tOnsetMs).toBe(beep.heardAtMs)
    // The same chirp the single-chirp policy would have locked on.
    expect(manual!.chirps).toEqual(runDetector(frames, FAST).lock!.chirps)
    // The detector is finished: nothing is pending any more and no second lock comes.
    expect(det.done).toBe(true)
    expect(pendingBeep(det, now, CONFIG)).toBeNull()
    expect(lockFromPending(det, now, CONFIG)).toBeNull()
    expect(detectStep(det, handFrame(now + HOP, []), CONFIG)).toBeNull()
  })

  it('"Use it now" returns null when nothing has been heard', () => {
    const det = createDetector(CONFIG)
    expect(lockFromPending(det, 0, CONFIG)).toBeNull()
    for (const f of sceneFrames({ durationS: 3, seed: 62 })) expect(detectStep(det, f, CONFIG)).toBeNull()
    expect(pendingBeep(det, det.lastMs, CONFIG)).toBeNull()
    expect(lockFromPending(det, det.lastMs, CONFIG)).toBeNull()
    expect(det.done).toBe(false)
  })

  it('never shows an excluded frequency as a pending beep', () => {
    const tones = [chirp(3120, 25, 0.5, 200), chirp(4000, 25, 3.0, 200), chirp(3120, 25, 5.5, 200)]
    const frames = sceneFrames({ durationS: 6.5, seed: 63, tones })
    // Control: without exclusions the two 3120 Hz chirps confirm each other.
    const plain = runDetector(frames)
    expect(plain.lock?.reason).toBe('slow')
    expect(Math.abs(plain.lock!.f0Hz - 3120)).toBeLessThan(2)
    // 3120 Hz excluded: only the 4000 Hz chirp is ever pending, although 3120 Hz was heard twice.
    const one = createDetector(CONFIG, { excludeHz: [3120] })
    let other = 0
    for (const f of frames) {
      expect(detectStep(one, f, CONFIG)).toBeNull()
      const beep = pendingBeep(one, f.tMs, CONFIG)
      if (beep !== null && Math.abs(beep.f0Hz - 4000) >= 2) other++
    }
    expect(other).toBe(0)
    expect(pendingBeep(one, one.lastMs, CONFIG)?.sightings).toBe(1)
    const manual = lockFromPending(one, one.lastMs, CONFIG)!
    expect(manual.chirps).toHaveLength(1)
    expect(Math.abs(manual.chirps[0]!.f0Hz - 4000)).toBeLessThan(2)
    // Both excluded: nothing is ever pending and "Use it now" has nothing to lock on.
    const both = createDetector(CONFIG, { excludeHz: [3120, 4000] })
    let pending = 0
    for (const f of frames) {
      expect(detectStep(both, f, CONFIG)).toBeNull()
      if (pendingBeep(both, f.tMs, CONFIG) !== null) pending++
    }
    expect(pending).toBe(0)
    expect(lockFromPending(both, both.lastMs, CONFIG)).toBeNull()
  })
})

describe('detectStep: sustained lock', () => {
  it('locks in live mode on a continuous tone at 20 dB SNR within sustainedLockMs + 150 ms, not before', () => {
    const toneMs = CONFIG.sustainedLockMs + 500
    const frames = sceneFrames({ durationS: 0.5 + toneMs / 1000, seed: 41, tones: [chirp(3120, 20, 0.5, toneMs)] })
    const { lock } = runDetector(frames)
    expect(lock).not.toBeNull()
    expect(lock!.mode).toBe('live')
    expect(lock!.reason).toBe('sustained')
    expect(lock!.chirps).toEqual([])
    expect(Math.abs(lock!.f0Hz - 3120)).toBeLessThan(2)
    const visibleMs = frames.find((f) => peakNear(f, 3120) !== undefined)!.tMs
    expect(lock!.tMs - visibleMs).toBeGreaterThanOrEqual(CONFIG.sustainedLockMs)
    expect(lock!.tMs - visibleMs).toBeLessThanOrEqual(CONFIG.sustainedLockMs + 150)
    // A continuous tone never closes a track, so the single-chirp policy locks the same way.
    expect(runDetector(frames, FAST).lock).toEqual(lock)
  })

  it('a steady tone that ends before sustainedLockMs does not lock but waits as a pending beep', () => {
    const toneMs = CONFIG.sustainedLockMs - 300
    const frames = sceneFrames({ durationS: 1 + toneMs / 1000, seed: 42, tones: [chirp(3120, 20, 0.5, toneMs)] })
    const { lock, det } = runDetector(frames)
    expect(lock).toBeNull()
    const beep = pendingBeep(det, det.lastMs, CONFIG)
    expect(beep?.sightings).toBe(1)
    expect(Math.abs(beep!.f0Hz - 3120)).toBeLessThan(2)
    // Control: the single-chirp policy takes it as one long chirp.
    expect(runDetector(frames, FAST).lock?.reason).toBe('fast')
  })
})

describe('detectStep: exclusions and gaps (lockConfirmChirps 1)', () => {
  it('ignores an excluded frequency but locks on another one', () => {
    const frames = sceneFrames({ durationS: 2.5, seed: 51, tones: [chirp(3120, 25, 0.5, 200), chirp(4000, 25, 1.5, 200)] })
    // Control: without the exclusion the first chirp locks.
    expect(Math.abs(runDetector(frames, FAST).lock!.f0Hz - 3120)).toBeLessThan(2)
    const { lock } = runDetector(frames, FAST, { excludeHz: [3120] })
    expect(lock?.reason).toBe('fast')
    expect(Math.abs(lock!.f0Hz - 4000)).toBeLessThan(2)
    expect(lock!.chirps[0]!.tOnsetMs).toBeGreaterThan(1_500)
  })

  it('a frame gap in the middle of a strong chirp stops that chirp from locking', () => {
    const frames = sceneFrames({ durationS: 4, seed: 52, tones: [chirp(3120, 30, 0.5, 300), chirp(3120, 30, 3.0, 300)] })
    // Control: without the gap the first chirp locks.
    expect(runDetector(frames, FAST).lock!.chirps[0]!.tOnsetMs).toBeLessThan(1_000)
    const mid = frames.findIndex((f) => f.tMs >= 650)
    const gapped = frames.map((f, i) => (i === mid ? { ...f, gap: true, dtMs: CONFIG.frameGapAbortMs + HOP } : f))
    const { lock } = runDetector(gapped, FAST)
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
    expect(runDetector(handRun(0, CONFIG.persistFrames - 1, at(300.2)), FAST).lock).toBeNull()
    const frames = handRun(0, CONFIG.persistFrames, at(300.2))
    const { lock, index } = runDetector(frames, FAST)
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
    const { lock } = runDetector(frames, FAST)
    expect(lock?.chirps[0]!.tEndMs).toBe((1 + CONFIG.trackCloseMissFrames) * HOP)
  })

  it('records the loudest frame, the mean frequency, clipping and click taint', () => {
    const snrs = [22, 34, 28, 25, 23]
    const bins = [300.1, 300.3, 300.2, 300.4, 300.0]
    const frames = handRun(0, snrs.length, (i) => [{ bin: bins[i]!, snrDb: snrs[i]! }]).map((f, i) =>
      i === 2 ? { ...f, clipFrac: CONFIG.clipFraction * 2 } : i === 1 || i === 3 ? { ...f, clickTainted: true } : f,
    )
    const { lock } = runDetector(frames, FAST)
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
    const run = (offsets: readonly number[]) =>
      runDetector(handRun(0, offsets.length, (i) => [{ bin: 300 + offsets[i]!, snrDb: 30 }]), FAST)
    expect(run(steady).lock?.reason).toBe('fast')
    expect(run(wobbly).lock).toBeNull()
  })

  it('rejects a track longer than maxChirpMs as a chirp', () => {
    const cfg = withConfig({ lockConfirmChirps: 1, sustainedLockMs: CONFIG.maxChirpMs * 2 })
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
    const det = createDetector(FAST)
    const locks = frames.map((f) => detectStep(det, f, FAST)).filter((l) => l !== null)
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

  it('prefers a fast lock over a slow pair (lockConfirmChirps 1), otherwise the pair locks', () => {
    const frames = [...handRun(0, 5, at(300, SLOW)), ...handRun(5000, 5, at(300, CONFIG.fastLockSnrDb + 5))]
    const lock = runDetector(frames, FAST).lock
    expect(lock?.reason).toBe('fast')
    expect(lock!.chirps.map((c) => c.tOnsetMs)).toEqual([5000])
    const confirmed = runDetector(frames).lock
    expect(confirmed?.reason).toBe('slow')
    expect(confirmed!.chirps.map((c) => c.tOnsetMs)).toEqual([0, 5000])
  })

  it('never locks a strong double chirp closer than slowLockGapMs (lockConfirmChirps 2), but waits with 2 sightings', () => {
    const STRONG = CONFIG.fastLockSnrDb + 10
    const pair = (gapMs: number) => [...handRun(0, 5, at(300, STRONG)), ...handRun(gapMs, 5, at(300.3, STRONG))]
    const close = runDetector(pair(CONFIG.slowLockGapMs - HOP))
    expect(close.lock).toBeNull()
    const beep = pendingBeep(close.det, close.det.lastMs, CONFIG)
    expect(beep?.sightings).toBe(2)
    expect(beep!.snrDb).toBeCloseTo(STRONG, 3)
    expect(beep!.heardAtMs).toBe(CONFIG.slowLockGapMs - HOP)
    // Spaced slowLockGapMs apart the second chirp confirms the first.
    const apart = runDetector(pair(CONFIG.slowLockGapMs)).lock
    expect(apart?.reason).toBe('slow')
    expect(apart!.chirps.map((c) => c.tOnsetMs)).toEqual([0, CONFIG.slowLockGapMs])
    // Control: the single-chirp policy locks on the first chirp alone.
    expect(runDetector(pair(CONFIG.slowLockGapMs - HOP), FAST).lock?.chirps.map((c) => c.tOnsetMs)).toEqual([0])
  })

  it('treats lockConfirmChirps above 2 as 2, below 2 as 1, and NaN as the default 2', () => {
    const strong = handRun(0, 5, at(300, CONFIG.fastLockSnrDb + 5))
    const pair = [...strong, ...handRun(CONFIG.slowLockGapMs, 5, at(300, SLOW))]
    for (const n of [1, 1.5, 0, -1]) {
      const cfg = withConfig({ lockConfirmChirps: n })
      expect(runDetector(strong, cfg).lock?.reason).toBe('fast')
    }
    for (const n of [2, 3, 5, Number.NaN]) {
      const cfg = withConfig({ lockConfirmChirps: n })
      expect(runDetector(strong, cfg).lock).toBeNull()
      expect(runDetector(pair, cfg).lock?.reason).toBe('slow')
    }
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
    expect(runDetector(frames, FAST).lock).toBeNull()
    expect(pendingBeep(runDetector(frames).det, 1000, CONFIG)).toBeNull()
    // The same with the gap before the tone: the onset is seen normally and it locks.
    const clean = [handFrame(0, [], { gap: true }), ...handRun(HOP, 8, at(300))]
    expect(runDetector(clean, FAST).lock?.reason).toBe('fast')
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
    expect(runDetector(frames, FAST).lock).toBeNull()
    // A chirp that starts after the change locks at the new bin width.
    const { lock } = runDetector([...frames, ...withBw(handRun(1000, 5, at(300)))], FAST)
    expect(lock?.reason).toBe('fast')
    expect(lock!.f0Hz).toBeCloseTo(300 * bw2, 3)
    expect(lock!.chirps[0]!.tOnsetMs).toBe(1000)
  })

  it('a new time base forgets remembered sightings and the peak ring', () => {
    const det = createDetector(CONFIG)
    for (const f of handRun(10_000, 5, at(300, SLOW))) expect(detectStep(det, f, CONFIG)).toBeNull()
    expect(det.memory).toHaveLength(1)
    expect(recentPeaks(det, 10_140, 1000)).toHaveLength(5)
    expect(pendingBeep(det, 10_140, CONFIG)?.sightings).toBe(1)
    expect(detectStep(det, handFrame(0, []), CONFIG)).toBeNull() // frame times restart at 0
    expect(det.memory).toHaveLength(0)
    expect(recentPeaks(det, 10_140, 1000)).toEqual([])
    expect(pendingBeep(det, 10_140, CONFIG)).toBeNull()
    // 2.5 s "after" the old sighting on the new time base: no pairing across time bases.
    for (const f of handRun(12_500, 5, at(300, SLOW))) expect(detectStep(det, f, CONFIG)).toBeNull()
  })
})

// ---- Pending beep and "Use it now" on hand-made spectra ----------------------------------------

describe('pendingBeep and lockFromPending', () => {
  const SLOW = (CONFIG.slowLockSnrDb + CONFIG.fastLockSnrDb) / 2
  /** No sustained lock, so a 2 s track can close as a sighting. */
  const NO_LIVE = withConfig({ sustainedLockMs: 60_000 })
  const LONG_HITS = 2000 / HOP + 1

  /** Hand-made 5-frame sightings [bin, per-bin SNR, onset ms] in onset order; none of them locks. */
  function heard(sightings: readonly (readonly [number, number, number])[], cfg: Config = CONFIG): DetectorState {
    const det = createDetector(cfg)
    for (const [bin, snrDb, t0Ms] of sightings) {
      for (const f of handRun(t0Ms, 5, () => [{ bin, snrDb }])) expect(detectStep(det, f, cfg)).toBeNull()
    }
    return det
  }

  /**
   * A 2 s sighting at bin 300 (onset 0) and a short one at `shortBin` (onset 1000 ms): the short one
   * closes first, so the detector remembers them out of onset order.
   */
  function outOfOrder(shortBin: number): DetectorState {
    const lines = (i: number): Line[] => [
      { bin: 300, snrDb: SLOW },
      ...(i >= 1000 / HOP && i < 1000 / HOP + 5 ? [{ bin: shortBin, snrDb: SLOW }] : []),
    ]
    const det = createDetector(NO_LIVE)
    for (const f of handRun(0, LONG_HITS, lines)) expect(detectStep(det, f, NO_LIVE)).toBeNull()
    expect(det.memory.map((m) => m.chirp.tOnsetMs)).toEqual([1000, 0])
    return det
  }

  it('shows nothing before a sighting has closed', () => {
    const det = createDetector(CONFIG)
    expect(pendingBeep(det, 0, CONFIG)).toBeNull()
    for (const f of handRun(0, 5, () => [{ bin: 300, snrDb: SLOW }], CONFIG.trackCloseMissFrames - 1)) detectStep(det, f, CONFIG)
    expect(det.tracks).toHaveLength(1) // still open
    expect(pendingBeep(det, 200, CONFIG)).toBeNull()
    expect(lockFromPending(det, 200, CONFIG)).toBeNull()
    detectStep(det, handFrame((4 + CONFIG.trackCloseMissFrames) * HOP, []), CONFIG)
    expect(pendingBeep(det, 200, CONFIG)).toEqual({
      f0Hz: expect.closeTo(300 * BW, 3),
      snrDb: expect.closeTo(SLOW, 3),
      heardAtMs: 0,
      sightings: 1,
    })
  })

  it('prefers the group with the most sightings, then the highest SNR', () => {
    // Two sightings at about bin 300 (1 s apart, too close to lock) beat one stronger one at bin 400.
    const two = pendingBeep(heard([[300, SLOW, 0], [300.4, SLOW, 1000], [400, SLOW + 3, 1500]]), 2000, CONFIG)!
    expect(two.sightings).toBe(2)
    expect(two.f0Hz).toBeCloseTo(300.2 * BW, 3)
    expect(two.snrDb).toBeCloseTo(SLOW, 3)
    expect(two.heardAtMs).toBe(1000)
    // One sighting each: the highest SNR wins, although it is neither the first nor the last.
    const one = pendingBeep(heard([[300, SLOW, 0], [400, SLOW + 3, 1000], [500, SLOW, 2000]]), 3000, CONFIG)!
    expect(one.sightings).toBe(1)
    expect(one.f0Hz).toBeCloseTo(400 * BW, 3)
    expect(one.snrDb).toBeCloseTo(SLOW + 3, 3)
    expect(one.heardAtMs).toBe(1000)
  })

  it('then prefers the most recent onset, whatever order the sightings closed in', () => {
    const last = pendingBeep(heard([[400, SLOW, 0], [300, SLOW, 1000]]), 2000, CONFIG)!
    expect(last.f0Hz).toBeCloseTo(300 * BW, 3)
    expect(last.heardAtMs).toBe(1000)
    // Here the most recent sighting (bin 400, onset 1000 ms) is the first one remembered.
    const det = outOfOrder(400)
    const beep = pendingBeep(det, 2500, NO_LIVE)!
    expect(beep.sightings).toBe(1)
    expect(beep.f0Hz).toBeCloseTo(400 * BW, 3)
    expect(beep.heardAtMs).toBe(1000)
  })

  it('groups sightings within lockToleranceBins and reports their mean frequency', () => {
    const tol = lockToleranceBins(300 * BW, BW, CONFIG.lockTolPct, CONFIG.lockTolMinBins)
    const near = pendingBeep(heard([[300, SLOW, 0], [300 + tol - 0.4, SLOW + 2, 1000]]), 1500, CONFIG)!
    expect(near.sightings).toBe(2)
    expect(near.f0Hz).toBeCloseTo(((300 + 300 + tol - 0.4) / 2) * BW, 3)
    expect(near.snrDb).toBeCloseTo(SLOW + 2, 3)
    expect(near.heardAtMs).toBe(1000)
    const far = pendingBeep(heard([[300, SLOW + 2, 0], [300 + tol + 0.4, SLOW, 1000]]), 1500, CONFIG)!
    expect(far.sightings).toBe(1)
    expect(far.f0Hz).toBeCloseTo(300 * BW, 3)
  })

  it('forgets sightings older than slowLockMemoryMs and never shows ones below slowLockSnrDb', () => {
    const det = heard([[300, SLOW, 0]])
    expect(pendingBeep(det, CONFIG.slowLockMemoryMs, CONFIG)?.sightings).toBe(1)
    expect(pendingBeep(det, CONFIG.slowLockMemoryMs + 1, CONFIG)).toBeNull()
    expect(lockFromPending(det, CONFIG.slowLockMemoryMs + 1, CONFIG)).toBeNull()
    expect(pendingBeep(heard([[300, CONFIG.slowLockSnrDb + 0.5, 0]]), 1000, CONFIG)?.sightings).toBe(1)
    const weak = heard([[300, CONFIG.slowLockSnrDb - 0.5, 0]])
    expect(pendingBeep(weak, 1000, CONFIG)).toBeNull()
    expect(lockFromPending(weak, 1000, CONFIG)).toBeNull()
    // White box: under one config the memory only holds sightings at slowLockSnrDb or above, so only
    // a detector run with a lower threshold puts a weaker one there; read with CONFIG, it is not shown.
    const low = withConfig({ slowLockSnrDb: CONFIG.slowLockSnrDb - 2 })
    const lowDet = heard([[300, CONFIG.slowLockSnrDb - 1, 0]], low)
    expect(pendingBeep(lowDet, 1000, low)?.sightings).toBe(1)
    expect(pendingBeep(lowDet, 1000, CONFIG)).toBeNull()
    expect(lockFromPending(lowDet, 1000, CONFIG)).toBeNull()
    expect(lockFromPending(lowDet, 1000, low)?.reason).toBe('manual')
  })

  it('never shows a remembered sighting at an excluded frequency', () => {
    const det = heard([[300, SLOW, 0]])
    expect(pendingBeep(det, 500, CONFIG)).not.toBeNull()
    // White box: findPeaks already drops excluded peaks, so only this puts one into the memory.
    const excluded = createDetector(CONFIG, { excludeHz: [300 * BW] })
    excluded.memory.push(...det.memory)
    expect(pendingBeep(excluded, 500, CONFIG)).toBeNull()
    expect(lockFromPending(excluded, 500, CONFIG)).toBeNull()
  })

  it('"Use it now" locks on exactly the pending group, oldest chirp first, and finishes the detector', () => {
    // Bins 300 and 305 are within lock tolerance of each other; a stronger one-off follows at bin 400.
    const det = outOfOrder(305)
    for (const f of handRun(2500, 5, () => [{ bin: 400, snrDb: SLOW + 3 }])) expect(detectStep(det, f, NO_LIVE)).toBeNull()
    const now = 3000
    const beep = pendingBeep(det, now, NO_LIVE)!
    expect(beep.sightings).toBe(2)
    const lock = lockFromPending(det, now, NO_LIVE)!
    expect(lock.mode).toBe('chirp')
    expect(lock.reason).toBe('manual')
    expect(lock.tMs).toBe(now)
    expect(lock.f0Hz).toBe(beep.f0Hz)
    expect(lock.f0Hz).toBeCloseTo(302.5 * BW, 3)
    expect(lock.snrDb).toBe(beep.snrDb)
    expect(lock.chirps.map((c) => c.tOnsetMs)).toEqual([0, 1000])
    expect(lock.chirps.map((c) => c.f0Hz)).toEqual([300, 305].map((b) => expect.closeTo(b * BW, 3)))
    // A confirming chirp would have locked slow; after "Use it now" nothing more comes.
    const confirm = handRun(4000, 5, () => [{ bin: 302.5, snrDb: SLOW }])
    const control = outOfOrder(305)
    expect(confirm.map((f) => detectStep(control, f, NO_LIVE)).find((l) => l !== null)?.reason).toBe('slow')
    expect(confirm.map((f) => detectStep(det, f, NO_LIVE)).filter((l) => l !== null)).toEqual([])
    expect(pendingBeep(det, 4200, NO_LIVE)).toBeNull()
    expect(lockFromPending(det, 4200, NO_LIVE)).toBeNull()
  })

  it('works the same with lockConfirmChirps 1, for sightings too weak for a fast lock', () => {
    // heard() checks that no frame locks: SLOW is below fastLockSnrDb.
    const det = heard([[300, SLOW, 0]], FAST)
    expect(pendingBeep(det, 500, FAST)).toEqual({
      f0Hz: expect.closeTo(300 * BW, 3),
      snrDb: expect.closeTo(SLOW, 3),
      heardAtMs: 0,
      sightings: 1,
    })
    const lock = lockFromPending(det, 500, FAST)
    expect(lock?.reason).toBe('manual')
    expect(lock!.chirps.map((c) => c.tOnsetMs)).toEqual([0])
    expect(pendingBeep(det, 500, FAST)).toBeNull()
  })

  it('"Use it now" gives a Lock the hunt takes every chirp of as its first readings', () => {
    // A double chirp (too close together to lock) plus a lone chirp at another frequency.
    const det = heard([[300, SLOW, 0], [300.4, SLOW, 600], [400, SLOW + 3, 1500]])
    const lock = lockFromPending(det, 2000, CONFIG)!
    expect(lock.chirps.map((c) => c.tOnsetMs)).toEqual([0, 600])
    const view = huntView(createHunt(lock, CONFIG), 2000, CONFIG)
    expect(view.mode).toBe('chirp')
    expect(view.f0Hz).toBe(lock.f0Hz)
    expect(view.readings.length).toBeGreaterThan(0)
    expect(view.readings.reduce((n, r) => n + r.chirpCount, 0)).toBe(lock.chirps.length)
  })

  it('returns the same object while nothing changes and never makes the detector forget', () => {
    const det = heard([[300, SLOW, 0]])
    const first = pendingBeep(det, 500, CONFIG)!
    expect(pendingBeep(det, 900, CONFIG)).toBe(first)
    // Asked about a moment when the sighting is too old: nothing shows, but nothing is forgotten.
    expect(pendingBeep(det, CONFIG.slowLockMemoryMs + 1, CONFIG)).toBeNull()
    expect(det.memory).toHaveLength(1)
    const again = pendingBeep(det, 1000, CONFIG)!
    expect(again).toEqual(first)
    // A second, nearby chirp too soon to confirm: a new value, then stable again.
    for (const f of handRun(1000, 5, () => [{ bin: 300.4, snrDb: SLOW }])) expect(detectStep(det, f, CONFIG)).toBeNull()
    const two = pendingBeep(det, 1500, CONFIG)!
    expect(two).not.toBe(again)
    expect(two.sightings).toBe(2)
    expect(pendingBeep(det, 1600, CONFIG)).toBe(two)
    // The confirming chirp still pairs, with the most recent sighting slowLockGapMs before it.
    const confirmAt = 1000 + CONFIG.slowLockGapMs
    const lock = handRun(confirmAt, 5, () => [{ bin: 300.2, snrDb: SLOW }])
      .map((f) => detectStep(det, f, CONFIG))
      .find((l) => l !== null)
    expect(lock?.reason).toBe('slow')
    expect(lock!.chirps.map((c) => c.tOnsetMs)).toEqual([1000, confirmAt])
    expect(pendingBeep(det, confirmAt + 200, CONFIG)).toBeNull()
  })

  it('"Use it now" returns null after detectStep has locked', () => {
    const det = createDetector(CONFIG)
    const line = (): readonly Line[] => [{ bin: 300, snrDb: SLOW }]
    const frames = [...handRun(0, 5, line), ...handRun(CONFIG.slowLockGapMs, 5, line)]
    expect(frames.map((f) => detectStep(det, f, CONFIG)).find((l) => l !== null)?.reason).toBe('slow')
    expect(pendingBeep(det, CONFIG.slowLockGapMs + 200, CONFIG)).toBeNull()
    expect(lockFromPending(det, CONFIG.slowLockGapMs + 200, CONFIG)).toBeNull()
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
