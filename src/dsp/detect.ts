/**
 * Listening phase: find the beep and lock onto it.
 *
 * Every frame, findPeaks lists narrowband candidates in the search band. A small tracker strings
 * candidates at a stable frequency together; a track that closes after persisting briefly with a
 * steady frequency is a "sighting" (one heard chirp). The lock policy then decides:
 * - fast: one sighting whose best per-bin SNR reaches fastLockSnrDb;
 * - slow: two sightings at >= slowLockSnrDb, within lock tolerance and >= slowLockGapMs apart;
 * - sustained: a stable track that is still open after sustainedLockMs (continuous tone, live mode).
 * Pure and deterministic; no DOM or Web Audio.
 */
import type { Config } from '../config.ts'
import type { Chirp, Frame, Lock, Peak } from '../types.ts'
import { bandFloorDb, bandLevelDb, localFloorDb, lockToleranceBins, parabolicPeak, peakWidthBins } from './spectrum.ts'

/** Options fixed for the lifetime of one detector. */
export interface DetectorOptions {
  /**
   * Frequencies (Hz) the user rejected with "Not it". Peaks within lockToleranceBins of any of them
   * are ignored. The caller decides how long an exclusion lasts (config.notItExcludeMs).
   */
  readonly excludeHz?: readonly number[]
}

/** A run of candidates at one frequency (module-private). */
interface Track {
  /** Frame times (ms) of the first and the latest matched candidate. */
  readonly startMs: number
  lastMs: number
  /** Matched frames, and consecutive frames without a match since the last one. */
  frames: number
  misses: number
  /** Welford running mean and sum of squared deviations of the interpolated bin. */
  meanBin: number
  m2: number
  /** Highest per-bin SNR (dB) of any matched candidate. */
  maxSnrDb: number
  /** Band level (dB) of the loudest frame and that frame's band floor. */
  bestBandDb: number
  bestBandFloorDb: number
  clipped: boolean
  taintedFrames: number
  readonly binHz: number
  /**
   * False for tracks opened on a discontinuity (gap frame, new bin width, new time base): the
   * beginning of whatever was sounding then was not seen, so the track can never become a
   * sighting (it can still lock as sustained).
   */
  readonly onsetSeen: boolean
  /** Scratch flag: matched in the current frame. */
  hit: boolean
}

/** A remembered sighting for the slow lock. */
interface Sighting {
  readonly chirp: Chirp
  /** Best per-bin SNR of the sighting's track. */
  readonly maxSnrDb: number
  readonly binHz: number
}

/** Mutable state of one listening session. Create with createDetector, advance with detectStep. */
export interface DetectorState {
  readonly excludeHz: readonly number[]
  readonly tracks: Track[]
  /**
   * Sightings that reached slowLockSnrDb, in the order their tracks closed (a long track can close
   * after a later, shorter one, so this is not onset order). Forgotten after slowLockMemoryMs.
   */
  readonly memory: Sighting[]
  /** Circular buffer of each frame's strongest peak (see recentPeaks). */
  readonly ringT: Float64Array
  readonly ringPeaks: (Peak | null)[]
  ringHead: number
  ringCount: number
  /** Bin width (Hz) and time (ms) of the previous frame; 0 and -Infinity before the first one. */
  binHz: number
  lastMs: number
  /** A Lock has been returned; the detector is finished. */
  done: boolean
}

/**
 * New detector. The peak ring buffer is sized for twice the nominal number of frames in
 * config.candidateRingMs, so catch-up frames after a timer stall never evict peaks that are still
 * inside candidateRingMs; entries older than candidateRingMs are dropped by time.
 */
export function createDetector(cfg: Config, opts: DetectorOptions = {}): DetectorState {
  const cap = Math.max(1, 2 * Math.ceil(cfg.candidateRingMs / cfg.hopMs))
  return {
    excludeHz: [...(opts.excludeHz ?? [])],
    tracks: [],
    memory: [],
    ringT: new Float64Array(cap),
    ringPeaks: new Array<Peak | null>(cap).fill(null),
    ringHead: 0,
    ringCount: 0,
    binHz: 0,
    lastMs: -Infinity,
    done: false,
  }
}

/**
 * Narrowband candidates in one dB spectrum, strongest per-bin SNR first, at most
 * config.maxCandidates. A candidate is a bin within searchBandHz that is the maximum within
 * +-localMaxHalfBins (strictly above the bins before it, >= the bins after it, so a plateau gives
 * one peak), whose parabolically interpolated level is >= candSnrDb above the local median floor
 * (localFloorDb), and whose width (peakWidthBins) is <= maxWidthBins. Peaks within
 * lockToleranceBins of any excluded frequency (Hz) are dropped before the cap. binHz is the width
 * of one bin in Hz; levels are in dB (AnalyserNode units).
 */
export function findPeaks(db: Float32Array, binHz: number, cfg: Config, excludeHz: readonly number[] = []): Peak[] {
  const lo = Math.max(1, Math.ceil(cfg.searchBandHz[0] / binHz))
  const hi = Math.min(db.length - 2, Math.floor(cfg.searchBandHz[1] / binHz))
  const half = cfg.localMaxHalfBins
  const peaks: Peak[] = []
  for (let k = lo; k <= hi; k++) {
    if (!isLocalMax(db, k, half)) continue
    const peak = candidateAt(db, k, binHz, cfg, excludeHz)
    if (peak !== null) peaks.push(peak)
    // The next `half` bins cannot be maxima: each has bin k among its earlier neighbours, and k >= it.
    k += half
  }
  peaks.sort((a, b) => b.snrDb - a.snrDb)
  if (peaks.length > cfg.maxCandidates) peaks.length = cfg.maxCandidates
  return peaks
}

/**
 * Advance the detector by one frame (mutates `state`). Returns a Lock at most once; afterwards it
 * returns null and the caller should discard the detector.
 *
 * A gap frame (timer stall) discards all open tracks without producing sightings; this frame's
 * candidates start fresh tracks whose onset was not observed, so they cannot become sightings
 * either (a chirp interrupted by a stall is missed as a whole, like in hunting), but a continuous
 * tone can still lock as sustained. A change of bin width (a rebuilt audio graph) is handled the
 * same way, since a bin index no longer means the same frequency; a frame time earlier than the
 * previous one (a new time base) also forgets the remembered sightings and the peak ring.
 */
export function detectStep(state: DetectorState, frame: Frame, cfg: Config): Lock | null {
  if (state.done) return null
  const tracks = state.tracks
  const newTimeBase = frame.tMs < state.lastMs
  const discontinuity = frame.gap || newTimeBase || (state.binHz > 0 && frame.binHz !== state.binHz)
  if (discontinuity) tracks.length = 0
  if (newTimeBase) {
    state.memory.length = 0
    clearRing(state)
  }
  state.binHz = frame.binHz
  state.lastMs = frame.tMs

  const peaks = findPeaks(frame.db, frame.binHz, cfg, state.excludeHz)
  ringPush(state, frame.tMs, peaks[0] ?? null, cfg)

  // Match candidates (strongest first) to the nearest unmatched track mean within trackMatchBins.
  for (const t of tracks) t.hit = false
  const fresh: Peak[] = []
  for (const p of peaks) {
    let best: Track | null = null
    let bestDist = Infinity
    for (const t of tracks) {
      if (t.hit) continue
      const d = Math.abs(p.binF - t.meanBin)
      if (d < bestDist) {
        bestDist = d
        best = t
      }
    }
    if (best !== null && bestDist <= cfg.trackMatchBins) {
      addToTrack(best, p, frame, cfg)
      best.hit = true
    } else {
      fresh.push(p)
    }
  }

  // Close tracks that missed too many frames; keep the sightings.
  const sightings: Sighting[] = []
  for (let i = tracks.length - 1; i >= 0; i--) {
    const t = tracks[i]!
    if (t.hit) continue
    t.misses++
    if (t.misses >= cfg.trackCloseMissFrames) {
      tracks.splice(i, 1)
      const s = toSighting(t, cfg)
      if (s !== null) sightings.push(s)
    }
  }
  sightings.sort((a, b) => a.chirp.tOnsetMs - b.chirp.tOnsetMs)

  // Unmatched candidates open new tracks; beyond maxTracks the weakest (lowest max SNR) go.
  for (const p of fresh) tracks.push(newTrack(p, frame, cfg, !discontinuity))
  while (tracks.length > cfg.maxTracks) {
    let weakest = 0
    for (let i = 1; i < tracks.length; i++) if (tracks[i]!.maxSnrDb < tracks[weakest]!.maxSnrDb) weakest = i
    tracks.splice(weakest, 1)
  }

  const lock = lockFromSightings(state, sightings, frame.tMs, cfg) ?? sustainedLock(tracks, frame.tMs, cfg)
  if (lock !== null) state.done = true
  return lock
}

/**
 * The strongest peak of each frame whose time lies in (nowMs - windowMs, nowMs], oldest first.
 * Only the last config.candidateRingMs of frames are kept. For a future "I hear it now" button.
 */
export function recentPeaks(state: DetectorState, nowMs: number, windowMs: number): Peak[] {
  const out: Peak[] = []
  const cap = state.ringT.length
  for (let i = 0; i < state.ringCount; i++) {
    const idx = (state.ringHead + i) % cap
    const t = state.ringT[idx]!
    const p = state.ringPeaks[idx]
    if (p != null && t > nowMs - windowMs && t <= nowMs) out.push(p)
  }
  return out
}

// ---- Internals ---------------------------------------------------------------------------------

function isLocalMax(db: Float32Array, k: number, half: number): boolean {
  const v = db[k]!
  for (let j = Math.max(0, k - half); j < k; j++) if (!(db[j]! < v)) return false
  const end = Math.min(db.length - 1, k + half)
  for (let j = k + 1; j <= end; j++) if (db[j]! > v) return false
  return true
}

/** The candidate at local maximum k, or null when it fails the SNR, width or exclusion test. */
function candidateAt(db: Float32Array, k: number, binHz: number, cfg: Config, excludeHz: readonly number[]): Peak | null {
  const p = parabolicPeak(db[k - 1]!, db[k]!, db[k + 1]!)
  // Most maxima are noise far below candSnrDb: rule them out without sorting the floor bins.
  if (floorCertainlyAbove(db, k, cfg.floorHalfBins, cfg.floorGuardBins, p.peakDb - cfg.candSnrDb)) return null
  const floorDb = localFloorDb(db, k, cfg.floorHalfBins, cfg.floorGuardBins)
  const snrDb = p.peakDb - floorDb
  if (!(snrDb >= cfg.candSnrDb)) return null
  const widthBins = peakWidthBins(db, k, cfg.widthDropDb, floorDb, cfg.widthFloorMarginDb)
  if (widthBins > cfg.maxWidthBins) return null
  const binF = k + p.delta
  if (isExcluded(binF, binHz, excludeHz, cfg)) return null
  const bandDb = bandLevelDb(db, binF, cfg.bandBins)
  return {
    bin: k,
    binF,
    f0Hz: binF * binHz,
    peakDb: p.peakDb,
    floorDb,
    snrDb,
    widthBins,
    bandDb,
    bandSnrDb: bandDb - bandFloorDb(floorDb, cfg.bandBins, cfg.bandFloorOffsetDb),
  }
}

/** Slack (dB) that keeps floorCertainlyAbove conservative against float rounding. */
const ROUNDING_SLACK_DB = 1e-9

/**
 * True when the median that localFloorDb(db, k, halfBins, guardBins) returns is certainly above
 * thrDb: fewer than half of the bins it takes the median of lie at or below the threshold. Scans the
 * same bins without allocating or sorting; false means "unknown", never "below".
 */
function floorCertainlyAbove(db: Float32Array, k: number, halfBins: number, guardBins: number, thrDb: number): boolean {
  const lo = Math.max(1, k - halfBins)
  const hi = Math.min(db.length - 1, k + halfBins)
  const thr = thrDb + ROUNDING_SLACK_DB
  let n = 0
  let atOrBelow = 0
  for (let j = lo; j <= hi; j++) {
    if (Math.abs(j - k) <= guardBins) continue
    n++
    if (db[j]! <= thr) atOrBelow++
  }
  return 2 * atOrBelow < n
}

function isExcluded(binF: number, binHz: number, excludeHz: readonly number[], cfg: Config): boolean {
  for (const hz of excludeHz) {
    const tol = lockToleranceBins(hz, binHz, cfg.lockTolPct, cfg.lockTolMinBins)
    if (Math.abs(binF - hz / binHz) <= tol) return true
  }
  return false
}

function newTrack(p: Peak, frame: Frame, cfg: Config, onsetSeen: boolean): Track {
  return {
    startMs: frame.tMs,
    lastMs: frame.tMs,
    frames: 1,
    misses: 0,
    meanBin: p.binF,
    m2: 0,
    maxSnrDb: p.snrDb,
    bestBandDb: p.bandDb,
    bestBandFloorDb: bandFloorDb(p.floorDb, cfg.bandBins, cfg.bandFloorOffsetDb),
    clipped: frame.clipFrac > cfg.clipFraction,
    taintedFrames: frame.clickTainted ? 1 : 0,
    binHz: frame.binHz,
    onsetSeen,
    hit: true,
  }
}

function addToTrack(t: Track, p: Peak, frame: Frame, cfg: Config): void {
  t.lastMs = frame.tMs
  t.frames++
  t.misses = 0
  const d = p.binF - t.meanBin
  t.meanBin += d / t.frames
  t.m2 += d * (p.binF - t.meanBin)
  if (p.snrDb > t.maxSnrDb) t.maxSnrDb = p.snrDb
  if (p.bandDb > t.bestBandDb) {
    t.bestBandDb = p.bandDb
    t.bestBandFloorDb = bandFloorDb(p.floorDb, cfg.bandBins, cfg.bandFloorOffsetDb)
  }
  if (frame.clipFrac > cfg.clipFraction) t.clipped = true
  if (frame.clickTainted) t.taintedFrames++
}

/** Population standard deviation of the track's interpolated bin. */
function stdBins(t: Track): number {
  return Math.sqrt(t.m2 / t.frames)
}

function isStable(t: Track, cfg: Config): boolean {
  return t.frames >= cfg.persistFrames && stdBins(t) < cfg.maxFreqStdBins
}

/** A closed track as a sighting, or null if it did not persist, glided, or lasted too long. */
function toSighting(t: Track, cfg: Config): Sighting | null {
  const span = t.lastMs - t.startMs
  if (!t.onsetSeen || !isStable(t, cfg) || span < cfg.persistSpanMs || span > cfg.maxChirpMs) return null
  const chirp: Chirp = {
    tOnsetMs: t.startMs,
    tEndMs: t.lastMs,
    durationMs: span,
    peakDb: t.bestBandDb,
    bandFloorDb: t.bestBandFloorDb,
    snrDb: t.bestBandDb - t.bestBandFloorDb,
    f0Hz: t.meanBin * t.binHz,
    clipped: t.clipped,
    taintedFrac: t.taintedFrames / t.frames,
  }
  return { chirp, maxSnrDb: t.maxSnrDb, binHz: t.binHz }
}

/**
 * Fast lock first, then slow lock; remembers slow-lock-worthy sightings that found no partner.
 * A slow lock pairs with the qualifying remembered sighting that started most recently.
 */
function lockFromSightings(state: DetectorState, sightings: readonly Sighting[], nowMs: number, cfg: Config): Lock | null {
  const memory = state.memory
  forgetOld(memory, nowMs, cfg)
  if (sightings.length === 0) return null

  let fast: Sighting | null = null
  for (const s of sightings) {
    if (s.maxSnrDb >= cfg.fastLockSnrDb && (fast === null || s.maxSnrDb > fast.maxSnrDb)) fast = s
  }
  if (fast !== null) {
    return { f0Hz: fast.chirp.f0Hz, mode: 'chirp', reason: 'fast', tMs: nowMs, snrDb: fast.maxSnrDb, chirps: [fast.chirp] }
  }

  for (const s of sightings) {
    if (s.maxSnrDb < cfg.slowLockSnrDb) continue
    const tol = lockToleranceBins(s.chirp.f0Hz, s.binHz, cfg.lockTolPct, cfg.lockTolMinBins)
    let partner: Sighting | null = null
    for (const e of memory) {
      const apart = s.chirp.tOnsetMs - e.chirp.tOnsetMs >= cfg.slowLockGapMs
      const near = Math.abs(s.chirp.f0Hz - e.chirp.f0Hz) / s.binHz <= tol
      if (apart && near && (partner === null || e.chirp.tOnsetMs > partner.chirp.tOnsetMs)) partner = e
    }
    if (partner !== null) {
      return {
        f0Hz: (partner.chirp.f0Hz + s.chirp.f0Hz) / 2,
        mode: 'chirp',
        reason: 'slow',
        tMs: nowMs,
        snrDb: Math.max(partner.maxSnrDb, s.maxSnrDb),
        chirps: [partner.chirp, s.chirp],
      }
    }
    memory.push(s)
  }
  return null
}

/** Drop remembered sightings that started more than slowLockMemoryMs before nowMs, wherever they sit. */
function forgetOld(memory: Sighting[], nowMs: number, cfg: Config): void {
  let kept = 0
  for (const s of memory) if (nowMs - s.chirp.tOnsetMs <= cfg.slowLockMemoryMs) memory[kept++] = s
  memory.length = kept
}

/** Live lock from the strongest open track that has stayed stable for sustainedLockMs. */
function sustainedLock(tracks: readonly Track[], nowMs: number, cfg: Config): Lock | null {
  let best: Track | null = null
  for (const t of tracks) {
    if (t.lastMs - t.startMs >= cfg.sustainedLockMs && isStable(t, cfg) && (best === null || t.maxSnrDb > best.maxSnrDb)) {
      best = t
    }
  }
  if (best === null) return null
  return { f0Hz: best.meanBin * best.binHz, mode: 'live', reason: 'sustained', tMs: nowMs, snrDb: best.maxSnrDb, chirps: [] }
}

/** Append a frame's strongest peak (or null) and drop entries older than candidateRingMs. */
function ringPush(state: DetectorState, tMs: number, peak: Peak | null, cfg: Config): void {
  const cap = state.ringT.length
  if (state.ringCount === cap) {
    // Full: drop the oldest entry; its slot is the one written next.
    state.ringHead = (state.ringHead + 1) % cap
    state.ringCount--
  }
  const idx = (state.ringHead + state.ringCount) % cap
  state.ringT[idx] = tMs
  state.ringPeaks[idx] = peak
  state.ringCount++
  while (state.ringCount > 0 && state.ringT[state.ringHead]! <= tMs - cfg.candidateRingMs) {
    state.ringPeaks[state.ringHead] = null
    state.ringHead = (state.ringHead + 1) % cap
    state.ringCount--
  }
}

/** Empty the peak ring (a new time base makes its timestamps meaningless). */
function clearRing(state: DetectorState): void {
  state.ringPeaks.fill(null)
  state.ringHead = 0
  state.ringCount = 0
}
