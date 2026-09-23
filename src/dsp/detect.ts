/**
 * Listening phase: find the beep and lock onto it.
 *
 * Every frame, findPeaks lists narrowband candidates in the search band. A small tracker strings
 * candidates at a stable frequency together; a track that closes after persisting briefly with a
 * steady frequency is a "sighting" (one heard chirp). The lock policy then decides:
 * - fast (only with config.lockConfirmChirps 1): one sighting whose best per-bin SNR reaches
 *   fastLockSnrDb;
 * - slow: two sightings at >= slowLockSnrAt, within lock tolerance, >= slowLockGapMs apart and of
 *   the same shape (sameShape), both clear (isClearSighting) when they are more than
 *   slowLockMemoryMs apart (with
 *   lockConfirmChirps 2 this is the only way a chirp locks: the second sighting confirms the first);
 * - sustained: a stable track that is still open after sustainedLockMs (continuous tone, live mode).
 * config.lockConfirmChirps is limited to 1 or 2: values above 2 act as 2 (a confirmed pair is the
 * most the slow-lock rules express), values below 2 act as 1, and NaN acts as the default 2.
 * While it waits, pendingBeep tells the UI what has been heard so far, and lockFromPending ("Use it
 * now") locks on that without waiting for the confirmation.
 * The search band (config.searchBandHz) can change between frames when the person narrows the
 * Listening range: sightings outside the current band (inBand), remembered or just closed, are
 * then neither shown as pending nor locked on or paired into a lock, and "I heard it" skips the
 * frames whose strongest peak lies outside it (a continuous tone outside it simply gets no more
 * candidates, so it cannot lock as sustained either).
 * Pure and deterministic; no DOM or Web Audio.
 */
import type { Config } from '../config.ts'
import type { Chirp, Frame, Lock, Peak, PendingBeep, SoundShape } from '../types.ts'
import { bandFloorDb, bandLevelDb, localFloorDb, lockToleranceBins, parabolicPeak, peakWidthBins } from './spectrum.ts'
import { sameShape, soundShape } from './shape.ts'

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
  /** Band level and time of each matched frame (bounded), for the sighting's shape. */
  readonly levels: number[]
  readonly times: number[]
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
   * Sightings that reached slowLockSnrDb and found no partner, in the order their tracks closed (a
   * long track can close after a later, shorter one, so this is not onset order). Forgotten after
   * sightingMemoryMs. pendingBeep and lockFromPending read them.
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
  /** A Lock has been returned (by detectStep or lockFromPending); the detector is finished. */
  done: boolean
  /** The last value pendingBeep returned, handed out again while it is unchanged (stable identity). */
  lastPending: PendingBeep | null
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
    lastPending: null,
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
 * Only the last config.candidateRingMs of frames are kept. lockFromRecent ("I heard it") reads them.
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

/**
 * The beep heard so far that is most worth showing while listening waits for the confirming chirp,
 * or null when there is none (or the detector has already returned a Lock).
 *
 * Only remembered sightings that could still lock count: best per-bin SNR >= slowLockSnrAt, onset
 * at most sightingMemoryMs before nowMs, and not within lock tolerance of an excluded frequency. A
 * group is one of them plus every other one within lockToleranceBins of it (compared in Hz, so
 * sightings from before a change of bin width still group). A group with a clear sighting
 * (isClearSighting) wins over one without, so a real beep is not pushed aside by faint noise;
 * then the group with the most sightings, then the one with the highest SNR, then the most recent. f0Hz is the group's mean
 * frequency, snrDb its best per-bin SNR, heardAtMs its latest onset (the time a hunt reading of that
 * chirp carries). A double chirp shows as 2 sightings although it does not lock (its two chirps are
 * closer than slowLockGapMs). Only chirps that have ended count: nothing shows while the first one
 * is still sounding.
 *
 * nowMs is on the frames' clock (frame.tMs). Call it after each detectStep; it never changes what
 * the detector locks on. While the result is unchanged it returns the same object as the previous
 * call, so a caller can skip an update by comparing references.
 */
export function pendingBeep(state: DetectorState, nowMs: number, cfg: Config): PendingBeep | null {
  const group = pendingGroup(state, nowMs, cfg)
  const beep = group.length === 0 ? null : summarise(group)
  const prev = state.lastPending
  if (beep !== null && prev !== null && samePending(beep, prev)) return prev
  state.lastPending = beep
  return beep
}

/**
 * "Use it now": lock on the beep that pendingBeep(state, nowMs, cfg) shows, without waiting for the
 * confirming chirp. Returns a Lock { mode 'chirp', reason 'manual', f0Hz and snrDb as pendingBeep
 * reports them, tMs nowMs, chirps: the group's sightings, oldest onset first } and finishes the
 * detector (detectStep returns null from then on); null whenever pendingBeep would return null,
 * including after detectStep has returned a Lock (a tap racing an automatic lock). nowMs is on the
 * frames' clock. The caller starts the hunt from this Lock exactly as from one of detectStep.
 */
export function lockFromPending(state: DetectorState, nowMs: number, cfg: Config): Lock | null {
  const group = pendingGroup(state, nowMs, cfg)
  if (group.length === 0) return null
  const beep = summarise(group)
  state.done = true
  state.lastPending = null
  return {
    f0Hz: beep.f0Hz,
    mode: 'chirp',
    reason: 'manual',
    tMs: nowMs,
    snrDb: beep.snrDb,
    chirps: group.map((s) => s.chirp),
  }
}

/**
 * "I heard it" while listening: the beep the person just heard, looked for among the strongest
 * peak of each frame in (nowMs - windowMs, nowMs] (recentPeaks). Frames whose peaks lie within
 * trackMatchBins of a sound's mean bin, with at most trackCloseMissFrames frames missing in
 * between, form that sound. One that spans persistFrames frames and persistSpanMs, holds its pitch
 * (robust spread below maxFreqStdBins) and is not within lock tolerance of an excluded frequency
 * counts; the one with the highest per-bin SNR wins (the latest on a tie). A frame whose strongest
 * peak lies outside the current search band (inBand: it was found before the Listening range was
 * narrowed) counts as silent. Returns a manual Lock on it (mode 'live', without chirps, when it
 * lasted longer than maxChirpMs) and finishes the detector, or null, leaving the detector
 * listening, when the window holds no such sound.
 */
export function lockFromRecent(state: DetectorState, nowMs: number, windowMs: number, cfg: Config): Lock | null {
  if (state.done) return null
  interface Heard {
    startMs: number
    endMs: number
    lastFrame: number
    meanBin: number
    bins: number[]
    levels: number[]
    times: number[]
    maxSnrDb: number
    best: Peak
    binHz: number
  }
  const done: Heard[] = []
  let open: Heard[] = []
  const cap = state.ringT.length
  let frame = 0
  for (let i = 0; i < state.ringCount; i++) {
    const idx = (state.ringHead + i) % cap
    const t = state.ringT[idx]!
    if (t <= nowMs - windowMs || t > nowMs) continue
    frame++
    open = open.filter((h) => {
      if (frame - h.lastFrame <= cfg.trackCloseMissFrames) return true
      done.push(h)
      return false
    })
    const p = state.ringPeaks[idx]
    if (p == null || !(p.binF > 0) || !inBand(p.f0Hz, p.f0Hz / p.binF, cfg)) continue
    let match: Heard | null = null
    for (const h of open) {
      const d = Math.abs(p.binF - h.meanBin)
      if (d <= cfg.trackMatchBins && (match === null || d < Math.abs(p.binF - match.meanBin))) match = h
    }
    if (match === null) {
      open.push({ startMs: t, endMs: t, lastFrame: frame, meanBin: p.binF, bins: [p.binF], levels: [p.bandDb], times: [t], maxSnrDb: p.snrDb, best: p, binHz: p.f0Hz / p.binF })
      continue
    }
    match.endMs = t
    match.lastFrame = frame
    match.bins.push(p.binF)
    match.meanBin += (p.binF - match.meanBin) / match.bins.length
    if (match.levels.length < levelsCap(cfg)) {
      match.levels.push(p.bandDb)
      match.times.push(t)
    }
    if (p.snrDb > match.maxSnrDb) {
      match.maxSnrDb = p.snrDb
      match.best = p
    }
  }
  done.push(...open)

  let pick: Heard | null = null
  for (const h of done) {
    if (h.bins.length < cfg.persistFrames || h.endMs - h.startMs < cfg.persistSpanMs) continue
    if (robustSpreadBins(h.bins) >= cfg.maxFreqStdBins) continue
    if (isExcluded(h.meanBin, h.binHz, state.excludeHz, cfg)) continue
    if (pick === null || h.maxSnrDb > pick.maxSnrDb || (h.maxSnrDb === pick.maxSnrDb && h.endMs > pick.endMs)) pick = h
  }
  if (pick === null) return null

  state.done = true
  state.lastPending = null
  const f0Hz = pick.meanBin * pick.binHz
  const durationMs = pick.endMs - pick.startMs
  if (durationMs > cfg.maxChirpMs) {
    return { f0Hz, mode: 'live', reason: 'manual', tMs: nowMs, snrDb: pick.maxSnrDb, chirps: [] }
  }
  const floor = bandFloorDb(pick.best.floorDb, cfg.bandBins, cfg.bandFloorOffsetDb)
  const chirp: Chirp = {
    tOnsetMs: pick.startMs,
    tEndMs: pick.endMs,
    durationMs,
    peakDb: pick.best.bandDb,
    bandFloorDb: floor,
    snrDb: pick.best.bandDb - floor,
    f0Hz,
    clipped: false,
    taintedFrac: 0,
    ...withShape(soundShape(pick.levels, pick.times, pick.maxSnrDb, cfg)),
  }
  return { f0Hz, mode: 'chirp', reason: 'manual', tMs: nowMs, snrDb: pick.maxSnrDb, chirps: [chirp] }
}

// ---- Internals ---------------------------------------------------------------------------------

/** { shape } when there is one (Chirp.shape is optional, never undefined). */
function withShape(shape: SoundShape | null): { shape?: SoundShape } {
  return shape === null ? {} : { shape }
}

/** Robust spread (1.4826 x median absolute deviation) of bin positions. */
function robustSpreadBins(bins: readonly number[]): number {
  const med = (xs: readonly number[]): number => {
    const s = [...xs].sort((a, b) => a - b)
    const m = s.length >> 1
    return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
  }
  const m = med(bins)
  return 1.4826 * med(bins.map((b) => Math.abs(b - m)))
}

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
    levels: [p.bandDb],
    times: [frame.tMs],
    binHz: frame.binHz,
    onsetSeen,
    hit: true,
  }
}

/** Levels kept per track: a sighting is at most maxChirpMs long. */
function levelsCap(cfg: Config): number {
  return Math.ceil(cfg.maxChirpMs / cfg.hopMs) + 8
}

function addToTrack(t: Track, p: Peak, frame: Frame, cfg: Config): void {
  t.lastMs = frame.tMs
  t.frames++
  t.misses = 0
  if (t.levels.length < levelsCap(cfg)) {
    t.levels.push(p.bandDb)
    t.times.push(frame.tMs)
  }
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
    ...withShape(soundShape(t.levels, t.times, t.maxSnrDb, cfg)),
  }
  return { chirp, maxSnrDb: t.maxSnrDb, binHz: t.binHz }
}

/**
 * Chirps the lock policy waits for: config.lockConfirmChirps limited to 1 or 2. Values above 2 act
 * as 2 (a confirmed pair is the most the slow-lock rules express) and values below 2 act as 1; a
 * value that is not a number (NaN) acts as the default 2, so a broken setting never re-enables the
 * single-chirp lock.
 */
function confirmChirps(cfg: Config): 1 | 2 {
  return cfg.lockConfirmChirps < 2 ? 1 : 2
}

/**
 * f0Hz lies within cfg.searchBandHz, give or take one bin (binHz): findPeaks searches whole bins,
 * so an interpolated peak at the edge of the band can sit up to half a bin outside it and must
 * still count. Sightings at other pitches are ignored, so that a band narrowed while listening
 * also shuts out what was heard before.
 */
export function inBand(f0Hz: number, binHz: number, cfg: Config): boolean {
  const slack = Number.isFinite(binHz) && binHz > 0 ? binHz : 0
  return f0Hz >= cfg.searchBandHz[0] - slack && f0Hz <= cfg.searchBandHz[1] + slack
}

/**
 * Best per-bin SNR a sighting at f0Hz needs to be remembered, shown as a pending beep and paired
 * into a slow lock: slowLockSnrDb, plus highBandExtraSnrDb from highBandFromHz up.
 */
export function slowLockSnrAt(f0Hz: number, cfg: Config): number {
  return f0Hz >= cfg.highBandFromHz ? cfg.slowLockSnrDb + cfg.highBandExtraSnrDb : cfg.slowLockSnrDb
}

/**
 * Fast lock first (lockConfirmChirps 1 only), then slow lock; remembers slow-lock-worthy sightings
 * that found no partner. A slow lock pairs with the qualifying remembered sighting that started
 * most recently. Sightings outside the current search band (inBand) neither lock nor pair: a
 * track that was open when the band was narrowed still closes as a sighting.
 */
function lockFromSightings(state: DetectorState, sightings: readonly Sighting[], nowMs: number, cfg: Config): Lock | null {
  const memory = state.memory
  forgetOld(memory, nowMs, cfg)
  if (sightings.length === 0) return null

  if (confirmChirps(cfg) === 1) {
    let fast: Sighting | null = null
    for (const s of sightings) {
      if (!sightingInBand(s, cfg)) continue
      if (s.maxSnrDb >= cfg.fastLockSnrDb && (fast === null || s.maxSnrDb > fast.maxSnrDb)) fast = s
    }
    if (fast !== null) {
      return { f0Hz: fast.chirp.f0Hz, mode: 'chirp', reason: 'fast', tMs: nowMs, snrDb: fast.maxSnrDb, chirps: [fast.chirp] }
    }
  }

  for (const s of sightings) {
    if (!sightingInBand(s, cfg) || s.maxSnrDb < slowLockSnrAt(s.chirp.f0Hz, cfg)) continue
    const tol = lockToleranceBins(s.chirp.f0Hz, s.binHz, cfg.lockTolPct, cfg.lockTolMinBins)
    let partner: Sighting | null = null
    for (const e of memory) {
      // A sighting outside the band (heard before it was narrowed) cannot confirm a beep.
      if (!sightingInBand(e, cfg)) continue
      const gapMs = s.chirp.tOnsetMs - e.chirp.tOnsetMs
      const apart = gapMs >= cfg.slowLockGapMs
      const near = Math.abs(s.chirp.f0Hz - e.chirp.f0Hz) / s.binHz <= tol
      // Beyond the short memory only two clear sightings confirm each other: a faint one (often
      // microphone noise) must not confirm a beep heard up to clearSightingMemoryMs earlier.
      const trusted = gapMs <= cfg.slowLockMemoryMs || (isClearSighting(s, cfg) && isClearSighting(e, cfg))
      // The same beep twice: about as long and fading alike (a clink does not confirm a beep).
      const alike = sameShape(s.chirp.shape, e.chirp.shape, cfg)
      if (apart && near && trusted && alike && (partner === null || e.chirp.tOnsetMs > partner.chirp.tOnsetMs)) partner = e
    }
    if (partner !== null) {
      return {
        f0Hz: snrWeightedHz(partner, s),
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

/** The remembered sightings pendingBeep summarises (see there), oldest onset first; empty when none. */
function pendingGroup(state: DetectorState, nowMs: number, cfg: Config): Sighting[] {
  if (state.done) return []
  const usable = state.memory.filter(
    (s) =>
      sightingInBand(s, cfg) &&
      s.maxSnrDb >= slowLockSnrAt(s.chirp.f0Hz, cfg) &&
      nowMs - s.chirp.tOnsetMs <= sightingMemoryMs(s, cfg) &&
      !isExcluded(s.chirp.f0Hz / s.binHz, s.binHz, state.excludeHz, cfg),
  )
  let best: Sighting[] = []
  let bestClear = false
  let bestSnrDb = -Infinity
  let bestLatestMs = -Infinity
  for (const seed of usable) {
    const tol = lockToleranceBins(seed.chirp.f0Hz, seed.binHz, cfg.lockTolPct, cfg.lockTolMinBins)
    const group = usable.filter((s) => Math.abs(s.chirp.f0Hz - seed.chirp.f0Hz) / seed.binHz <= tol)
    let snrDb = -Infinity
    let latestMs = -Infinity
    let clear = false
    for (const s of group) {
      snrDb = Math.max(snrDb, s.maxSnrDb)
      latestMs = Math.max(latestMs, s.chirp.tOnsetMs)
      clear ||= isClearSighting(s, cfg)
    }
    const better =
      clear !== bestClear
        ? clear
        : group.length !== best.length
          ? group.length > best.length
          : snrDb !== bestSnrDb
            ? snrDb > bestSnrDb
            : latestMs > bestLatestMs
    if (better) {
      best = group
      bestClear = clear
      bestSnrDb = snrDb
      bestLatestMs = latestMs
    }
  }
  return best.sort((a, b) => a.chirp.tOnsetMs - b.chirp.tOnsetMs)
}

/** A non-empty sighting group as a PendingBeep: mean frequency, best SNR, latest onset, count. */
function summarise(group: readonly Sighting[]): PendingBeep {
  let sumHz = 0
  let snrDb = -Infinity
  let heardAtMs = -Infinity
  for (const s of group) {
    sumHz += s.chirp.f0Hz
    snrDb = Math.max(snrDb, s.maxSnrDb)
    heardAtMs = Math.max(heardAtMs, s.chirp.tOnsetMs)
  }
  return { f0Hz: sumHz / group.length, snrDb, heardAtMs, sightings: group.length }
}

/** Field-by-field equality of two pending beeps. */
function samePending(a: PendingBeep, b: PendingBeep): boolean {
  return a.f0Hz === b.f0Hz && a.snrDb === b.snrDb && a.heardAtMs === b.heardAtMs && a.sightings === b.sightings
}

/** The sighting's frequency lies within the current search band (inBand, with its own bin width as slack). */
function sightingInBand(s: Sighting, cfg: Config): boolean {
  return inBand(s.chirp.f0Hz, s.binHz, cfg)
}

type SightingLike = { readonly chirp: { readonly f0Hz: number }; readonly maxSnrDb: number }

/** A clear sighting: best per-bin SNR at least clearSightingExtraSnrDb above slowLockSnrAt its frequency. */
export function isClearSighting(s: SightingLike, cfg: Config): boolean {
  return s.maxSnrDb >= slowLockSnrAt(s.chirp.f0Hz, cfg) + cfg.clearSightingExtraSnrDb
}

/** How long a sighting is remembered: clearSightingMemoryMs when it is clear, else slowLockMemoryMs. */
export function sightingMemoryMs(s: SightingLike, cfg: Config): number {
  return isClearSighting(s, cfg) ? Math.max(cfg.clearSightingMemoryMs, cfg.slowLockMemoryMs) : cfg.slowLockMemoryMs
}

/**
 * The frequency of a slow-locked pair: the mean weighted by per-bin SNR in power, so two equal
 * sightings give their plain mean and a strong beep confirmed by a faint one keeps the beep's own
 * frequency (the faint one may be noise that only happened to fall within lock tolerance).
 */
function snrWeightedHz(a: SightingLike, b: SightingLike): number {
  const top = Math.max(a.maxSnrDb, b.maxSnrDb)
  const wa = 10 ** ((a.maxSnrDb - top) / 10)
  const wb = 10 ** ((b.maxSnrDb - top) / 10)
  return (a.chirp.f0Hz * wa + b.chirp.f0Hz * wb) / (wa + wb)
}

/** Drop remembered sightings that started longer ago than their memory time (sightingMemoryMs), wherever they sit. */
function forgetOld(memory: Sighting[], nowMs: number, cfg: Config): void {
  let kept = 0
  for (const s of memory) if (nowMs - s.chirp.tOnsetMs <= sightingMemoryMs(s, cfg)) memory[kept++] = s
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
