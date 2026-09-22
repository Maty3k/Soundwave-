/**
 * Hunting phase: everything after the lock. Each frame is measured at the locked frequency only
 * (3-bin band level against a local noise reference). A hysteresis segmenter turns tone bursts
 * into Chirps; chirps (or merged groups, or whole live trains) become Readings with a
 * WARMER / COLDER / ABOUT THE SAME verdict and a 0..100 position in an auto range; the gaps
 * between readings drive a countdown with a HOLD STILL phase; long or rapid activity switches
 * to a live max-hold meter and back.
 *
 * Pure TypeScript, no DOM or Web Audio. Times are ms on the frame clock (frame.tMs), levels are
 * AnalyserNode dB (see config.ts), every tunable comes from Config.
 */
import type { Config } from '../config.ts'
import type {
  Chirp,
  Countdown,
  CountdownKind,
  Frame,
  HuntEvent,
  HuntView,
  LiveView,
  Lock,
  LockMode,
  Reading,
  Verdict,
} from '../types.ts'
import { locatePeak, lockToleranceBins, measureBandAt, median } from './spectrum.ts'

// ---- Public helper types -----------------------------------------------------------------------

/** Auto range of the 0..100 meter, in band-level dB. */
export interface MeterRange {
  readonly floorDb: number
  readonly ceilDb: number
}

/** Median and median absolute deviation of recent gaps between readings, in ms. */
export interface IntervalEstimate {
  readonly medianMs: number
  readonly madMs: number
  readonly confident: boolean
}

/** A gap between two readings after missed-chirp reconciliation. */
export interface ReconciledGap {
  /** Interval estimate in ms this gap contributes (gap / k when it spans k intervals). */
  readonly estimateMs: number
  /** Chirps assumed missed inside the gap (k - 1). */
  readonly missed: number
}

/** Live-meter verdicts (a live comparison is never 'first'). */
export type LiveVerdict = Exclude<Verdict, 'first'>

// ---- Internal state ----------------------------------------------------------------------------

/** One frame as seen by the segmenter (onset run or open segment). */
interface SegFrame {
  readonly tMs: number
  readonly levelDb: number
  readonly snrDb: number
  readonly bandFloorDb: number
  /** Interpolated per-bin peak position near f0. */
  readonly binF: number
  /** binF minus the band centre of this frame, in bins. */
  readonly offsetBins: number
  readonly binHz: number
  readonly clipped: boolean
  readonly tainted: boolean
}

/** An open chirp segment and its accumulators. */
interface Segment {
  readonly tOnsetMs: number
  /** Band noise reference: median of the pre-onset floor ring (or the first frame's floor). */
  readonly noiseDb: number
  lastAboveMs: number
  offCount: number
  peakDb: number
  peakBinF: number
  peakOffsetBins: number
  peakBinHz: number
  clipped: boolean
  frames: number
  taintedFrames: number
  /** p.binF of frames with snr >= onsetSnrDb (bounded; see strongCap). */
  strongBinF: number[]
  /** Aborted by a frame gap: keeps tracking on/off (activity) but never becomes a Chirp. */
  discarded: boolean
  /** Opened in, or carried into, live mode: may become a Chirp but never a reading. */
  noReading: boolean
}

/** Meter baseline in force before a reading (group) was first created. */
interface Baseline {
  readonly prevLevelDb: number | null
  readonly bestDb: number | null
  readonly range: MeterRange | null
}

/** The latest reading while further chirps may still merge into it. */
interface Group {
  readonly id: number
  readonly tMs: number
  readonly baseline: Baseline
  readonly noiseDb: number
  readonly missedBefore: number
  lastEndMs: number
  levelDb: number
  snrDb: number
  clipped: boolean
  chirpCount: number
}

/** What the reading pipeline needs from a chirp or a finished live train. */
interface ReadingInput {
  readonly tMs: number
  readonly endMs: number
  readonly levelDb: number
  readonly snrDb: number
  readonly noiseDb: number
  readonly clipped: boolean
  readonly chirpCount: number
  readonly source: 'chirp' | 'train'
}

/** One frame in the live max-hold buffer. */
interface HoldEntry {
  readonly tMs: number
  readonly levelDb: number
  readonly clipped: boolean
  readonly bandFloorDb: number
}

/** Live meter and the train it will turn into. */
interface LiveState {
  /** Start of the activity episode that became this train. */
  readonly trainStartMs: number
  trainOnsets: number
  trainPeakDb: number | null
  trainClipped: boolean
  heldDb: number
  heldClipped: boolean
  lastTickMs: number | null
  history: { readonly tMs: number; readonly heldDb: number }[]
  verdict: LiveVerdict | null
  deltaDb: number | null
}

/** Mutable hunt state. Create with createHunt, advance with huntStep, read with huntView. */
export interface HuntState {
  f0Hz: number
  mode: LockMode
  /** Measurements of the latest frame (debug view; blanked frames included). */
  levelDb: number
  bandFloorDb: number
  snrDb: number
  /** Band SNR of the latest frame the segmenter may use (blanked click-tainted frames skipped). */
  hearingSnrDb: number
  /** Bin width of the previous frame; a change is a discontinuity like a frame gap. */
  lastBinHz: number | null
  // Segmenter
  run: SegFrame[]
  seg: Segment | null
  /** Band floors of the last preOnsetFloorFrames idle frames (the onset run excluded). */
  floorRing: number[]
  // Readings
  readings: Reading[]
  nextId: number
  prevLevelDb: number | null
  bestDb: number | null
  range: MeterRange | null
  group: Group | null
  /**
   * lastEndMs of the group that resetBest detached. A chirp continuing that burst starts the first
   * new reading but is not a new interval (the burst's first onset stays the timing reference).
   */
  resetGroupEndMs: number | null
  chirps: Chirp[]
  missedChirps: number
  /** Chirps aborted by frame gaps since the last new reading (already counted in missedChirps). */
  abortedSinceReading: number
  // Interval (kept by resetBest)
  lastOnsetMs: number | null
  gapsMs: number[]
  // Activity episodes (mode classifier)
  lastActiveMs: number | null
  episodeStartMs: number
  episodeOnsets: number
  // Live meter
  /** Frames of the last liveHoldMs (all modes), for the live max-hold and its noise reference. */
  holdFrames: HoldEntry[]
  live: LiveState | null
  liveBestDb: number | null
  liveRange: MeterRange | null
}

// ---- Pure helpers ------------------------------------------------------------------------------

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/**
 * Meter range update shared by readings and the live meter (dB in, dB out).
 * Target floor = max(noiseDb + rangeFloorOverNoiseDb, bestDb - rangeFloorBelowBestDb). The first
 * range takes the target; later the floor drops to the target immediately but rises by at most
 * rangeFloorRiseDb per update. Ceiling = bestDb + rangeCeilOverBestDb. If the span is below
 * rangeMinSpanDb the floor is lowered to ceiling - rangeMinSpanDb.
 */
export function updateRange(prev: MeterRange | null, noiseDb: number, bestDb: number, cfg: Config): MeterRange {
  const target = Math.max(noiseDb + cfg.rangeFloorOverNoiseDb, bestDb - cfg.rangeFloorBelowBestDb)
  let floorDb: number
  if (prev === null || target < prev.floorDb) floorDb = target
  else floorDb = Math.min(target, prev.floorDb + cfg.rangeFloorRiseDb)
  const ceilDb = bestDb + cfg.rangeCeilOverBestDb
  if (ceilDb - floorDb < cfg.rangeMinSpanDb) floorDb = ceilDb - cfg.rangeMinSpanDb
  return { floorDb, ceilDb }
}

/** Position of levelDb within a range as 0..100 (clamped). */
export function rangePct(levelDb: number, range: MeterRange): number {
  const span = range.ceilDb - range.floorDb
  return span > 0 ? clamp01((levelDb - range.floorDb) / span) * 100 : 100
}

/**
 * Verdict of a level change (dB): clipped -> 'max', no previous level (delta null) -> 'first',
 * otherwise 'warmer' / 'colder' beyond +-deadBandDb, else 'same'.
 */
export function verdictFor(deltaDb: number | null, clipped: boolean, cfg: Config): Verdict {
  if (clipped) return 'max'
  if (deltaDb === null) return 'first'
  if (deltaDb > cfg.deadBandDb) return 'warmer'
  if (deltaDb < -cfg.deadBandDb) return 'colder'
  return 'same'
}

/**
 * Interval estimate from gaps between reading onsets (ms): null for no gaps, otherwise the
 * median, the median absolute deviation, and confident when there are >= 2 gaps and
 * madMs / medianMs < madRatio.
 */
export function estimateInterval(gapsMs: readonly number[], cfg: Config): IntervalEstimate | null {
  if (gapsMs.length === 0) return null
  const medianMs = median(gapsMs)
  const madMs = median(gapsMs.map((g) => Math.abs(g - medianMs)))
  const confident = gapsMs.length >= 2 && medianMs > 0 && madMs / medianMs < cfg.madRatio
  return { medianMs, madMs, confident }
}

/**
 * Missed-chirp reconciliation of one gap (ms). With a median, the first k in missedGapFactors for
 * which |gap - k * median| <= missedGapTolPct % of k * median means the gap spans k intervals:
 * estimateMs = gap / k, missed = k - 1. Otherwise the gap is taken as is with missed = 0.
 */
export function reconcileGap(gapMs: number, medianMs: number | null, cfg: Config): ReconciledGap {
  if (medianMs !== null && medianMs > 0) {
    for (const k of cfg.missedGapFactors) {
      const expected = k * medianMs
      if (Math.abs(gapMs - expected) <= (cfg.missedGapTolPct / 100) * expected) {
        return { estimateMs: gapMs / k, missed: k - 1 }
      }
    }
  }
  return { estimateMs: gapMs, missed: 0 }
}

// ---- Creation ----------------------------------------------------------------------------------

function newLive(trainStartMs: number, onsets: number, cfg: Config): LiveState {
  return {
    trainStartMs,
    trainOnsets: onsets,
    trainPeakDb: null,
    trainClipped: false,
    heldDb: cfg.silentDb,
    heldClipped: false,
    lastTickMs: null,
    history: [],
    verdict: null,
    deltaDb: null,
  }
}

/**
 * Start hunting at lock.f0Hz in lock.mode. The lock's chirps (oldest first) go through the normal
 * reading pipeline, so a chirp heard while listening is reading #1 (and #2 for a slow lock).
 * A live lock starts a live episode (and train) at lock.tMs.
 */
export function createHunt(lock: Lock, cfg: Config): HuntState {
  const state: HuntState = {
    f0Hz: lock.f0Hz,
    mode: lock.mode,
    levelDb: cfg.silentDb,
    bandFloorDb: cfg.silentDb,
    snrDb: 0,
    hearingSnrDb: 0,
    lastBinHz: null,
    run: [],
    seg: null,
    floorRing: [],
    readings: [],
    nextId: 1,
    prevLevelDb: null,
    bestDb: null,
    range: null,
    group: null,
    resetGroupEndMs: null,
    chirps: [],
    missedChirps: 0,
    abortedSinceReading: 0,
    lastOnsetMs: null,
    gapsMs: [],
    lastActiveMs: null,
    episodeStartMs: lock.tMs,
    episodeOnsets: 0,
    holdFrames: [],
    live: null,
    liveBestDb: null,
    liveRange: null,
  }
  const ignored: HuntEvent[] = []
  for (const c of lock.chirps) {
    keepChirp(state, c, cfg)
    addReading(state, chirpInput(c), ignored, cfg)
  }
  if (lock.mode === 'live') {
    state.group = null
    state.lastActiveMs = lock.tMs
    state.episodeStartMs = lock.tMs
    state.live = newLive(lock.tMs, 0, cfg)
  }
  return state
}

// ---- Frame step --------------------------------------------------------------------------------

/**
 * Advance the hunt by one frame. Mutates `state` and returns the events it produced, in order:
 * 'onset' when a chirp segment opens, 'reading' / 'readingUpdated' when a chirp, merged group or
 * live train is registered, 'mode' on chirp <-> live switches, and 'missed' when a frame gap
 * aborts an open chirp (chirp mode only). A change of frame.binHz (a new audio context) is
 * treated like a frame gap: the open chirp was measured on a different spectrum grid.
 */
export function huntStep(state: HuntState, frame: Frame, cfg: Config): HuntEvent[] {
  const events: HuntEvent[] = []
  const centre = state.f0Hz / frame.binHz
  const m = measureBandAt(frame.db, centre, cfg.bandBins, cfg.floorHalfBins, cfg.floorGuardBins, cfg.bandFloorOffsetDb)
  state.levelDb = m.levelDb
  state.bandFloorDb = m.bandFloorDb
  state.snrDb = m.snrDb
  const clipped = frame.clipFrac > cfg.clipFraction
  const blanked = cfg.blankTaintedFrames && frame.clickTainted
  const newGrid = state.lastBinHz !== null && frame.binHz !== state.lastBinHz
  state.lastBinHz = frame.binHz
  if (newGrid) state.floorRing = [] // band floors on the old grid are not comparable

  if (!blanked) {
    state.hearingSnrDb = m.snrDb
    pushHold(state, { tMs: frame.tMs, levelDb: m.levelDb, clipped, bandFloorDb: m.bandFloorDb }, cfg)
  }

  if (frame.gap || newGrid) {
    abortSegment(state, events)
  } else if (!blanked) {
    const tol = lockToleranceBins(state.f0Hz, frame.binHz, cfg.lockTolPct, cfg.lockTolMinBins)
    const p = locatePeak(frame.db, centre, tol)
    const sf: SegFrame = {
      tMs: frame.tMs,
      levelDb: m.levelDb,
      snrDb: m.snrDb,
      bandFloorDb: m.bandFloorDb,
      binF: p.binF,
      offsetBins: p.binF - centre,
      binHz: frame.binHz,
      clipped,
      tainted: frame.clickTainted,
    }
    const opened = segmentStep(state, sf, cfg, events)
    activityStep(state, frame.tMs, opened, cfg, events)
  }

  if (state.live !== null) liveStep(state, state.live, frame.tMs, cfg, events)
  return events
}

// ---- Segmenter ---------------------------------------------------------------------------------

function pushFloor(state: HuntState, floorDb: number, cfg: Config): void {
  state.floorRing.push(floorDb)
  while (state.floorRing.length > cfg.preOnsetFloorFrames) state.floorRing.shift()
}

function accumulate(seg: Segment, f: SegFrame, cfg: Config): void {
  seg.frames++
  if (f.tainted) seg.taintedFrames++
  // Only while the tone is on: a bump or a door slam that clips the mic during the closing
  // off frames must not turn the chirp into a MAX reading. A tone loud enough to clip also clips
  // the frames that hold it well inside the analysis frame, far above offsetSnrDb (checked for
  // 10-400 ms chirps at 0 to +6 dBFS); only edge frames it has barely entered are skipped.
  if (f.clipped && f.snrDb >= cfg.offsetSnrDb) seg.clipped = true
  if (f.levelDb > seg.peakDb) {
    seg.peakDb = f.levelDb
    seg.peakBinF = f.binF
    seg.peakOffsetBins = f.offsetBins
    seg.peakBinHz = f.binHz
  }
  // A segment longer than maxChirpMs is rejected anyway, so more positions are never needed.
  if (f.snrDb >= cfg.onsetSnrDb && seg.strongBinF.length < strongCap(cfg)) seg.strongBinF.push(f.binF)
}

function strongCap(cfg: Config): number {
  return Math.ceil(cfg.maxChirpMs / cfg.hopMs) + cfg.onsetFrames
}

/** The frequency-stability check needs at least this many strong frames. */
const MIN_STABILITY_FRAMES = 3

/** MAD of a normal distribution times this equals its standard deviation. */
const MAD_TO_STD = 1.4826

/**
 * Robust standard deviation (1.4826 x median absolute deviation) of per-frame peak positions, in
 * bins. A glide moves the peak steadily, so every estimator sees it; the robust one also ignores
 * the one or two frames at a chirp's edges, where the tone fills only a sliver of the analysis
 * FFT frame and the peak position is unreliable (a plain std rejected 5-25 % of true chirps).
 */
export function robustStdBins(positions: readonly number[]): number {
  if (positions.length === 0) return 0
  const m = median(positions)
  return MAD_TO_STD * median(positions.map((p) => Math.abs(p - m)))
}

/** Runs the segmenter on one usable frame; returns the segment if it opened on this frame. */
function segmentStep(state: HuntState, f: SegFrame, cfg: Config, events: HuntEvent[]): Segment | null {
  const open = state.seg
  if (open !== null) {
    if (!open.discarded) accumulate(open, f, cfg)
    if (f.snrDb >= cfg.offsetSnrDb) {
      open.offCount = 0
      open.lastAboveMs = f.tMs
    } else if (++open.offCount >= cfg.offsetFrames) {
      state.seg = null
      closeSegment(state, open, cfg, events)
    }
    return null
  }

  if (f.snrDb >= cfg.onsetSnrDb) {
    state.run.push(f)
    if (state.run.length < cfg.onsetFrames) return null
    const first = state.run[0]!
    const seg: Segment = {
      tOnsetMs: first.tMs,
      noiseDb: state.floorRing.length > 0 ? median(state.floorRing) : first.bandFloorDb,
      lastAboveMs: first.tMs,
      offCount: 0,
      peakDb: -Infinity,
      peakBinF: first.binF,
      peakOffsetBins: first.offsetBins,
      peakBinHz: first.binHz,
      clipped: false,
      frames: 0,
      taintedFrames: 0,
      strongBinF: [],
      discarded: false,
      noReading: state.mode === 'live',
    }
    for (const r of state.run) {
      accumulate(seg, r, cfg)
      seg.lastAboveMs = r.tMs
    }
    state.run = []
    state.seg = seg
    events.push({ type: 'onset' })
    return seg
  }

  // Not a run frame: an interrupted run was idle history after all.
  for (const r of state.run) pushFloor(state, r.bandFloorDb, cfg)
  state.run = []
  pushFloor(state, f.bandFloorDb, cfg)
  return null
}

/**
 * Frame gap (or a new bin width): the open chirp can no longer be measured. It is discarded but
 * still tracked until the tone goes off, so its remainder cannot reopen as a new (truncated)
 * chirp. In live mode, or for a segment that could not become a reading, this is silent.
 */
function abortSegment(state: HuntState, events: HuntEvent[]): void {
  state.run = []
  const seg = state.seg
  if (seg === null || seg.discarded) return
  seg.discarded = true
  if (!seg.noReading && state.mode === 'chirp') {
    events.push({ type: 'missed' })
    state.missedChirps++
    state.abortedSinceReading++
  }
}

/** Validates a closed segment; a valid one becomes a Chirp, updates f0 and (chirp mode) a reading. */
function closeSegment(state: HuntState, seg: Segment, cfg: Config, events: HuntEvent[]): void {
  if (seg.discarded) return
  const durationMs = seg.lastAboveMs - seg.tOnsetMs
  if (durationMs < cfg.minChirpMs || durationMs > cfg.maxChirpMs) return
  if (Math.abs(seg.peakOffsetBins) > cfg.chirpMaxOffsetBins) return
  if (seg.strongBinF.length >= MIN_STABILITY_FRAMES && robustStdBins(seg.strongBinF) >= cfg.maxFreqStdBins) return

  const chirp: Chirp = {
    tOnsetMs: seg.tOnsetMs,
    tEndMs: seg.lastAboveMs,
    durationMs,
    peakDb: seg.peakDb,
    bandFloorDb: seg.noiseDb,
    snrDb: seg.peakDb - seg.noiseDb,
    f0Hz: seg.peakBinF * seg.peakBinHz,
    clipped: seg.clipped,
    taintedFrac: seg.frames > 0 ? seg.taintedFrames / seg.frames : 0,
  }
  keepChirp(state, chirp, cfg)
  state.f0Hz = (1 - cfg.f0Alpha) * state.f0Hz + cfg.f0Alpha * chirp.f0Hz
  if (!seg.noReading && state.mode === 'chirp') addReading(state, chirpInput(chirp), events, cfg)
}

function keepChirp(state: HuntState, chirp: Chirp, cfg: Config): void {
  state.chirps.push(chirp)
  while (state.chirps.length > cfg.chirpsKept) state.chirps.shift()
}

function chirpInput(c: Chirp): ReadingInput {
  return {
    tMs: c.tOnsetMs,
    endMs: c.tEndMs,
    levelDb: c.peakDb,
    snrDb: c.snrDb,
    noiseDb: c.bandFloorDb,
    clipped: c.clipped,
    chirpCount: 1,
    source: 'chirp',
  }
}

// ---- Readings ----------------------------------------------------------------------------------

interface Evaluated {
  readonly verdict: Verdict
  readonly deltaPrevDb: number | null
  readonly pct: number | null
  readonly isNewBest: boolean
  readonly bestDb: number | null
  readonly range: MeterRange | null
}

/** Verdict, best, range and pct of a reading level against the baseline before the reading. */
function evaluate(base: Baseline, levelDb: number, clipped: boolean, noiseDb: number, cfg: Config): Evaluated {
  const first = base.prevLevelDb === null
  const deltaPrevDb = base.prevLevelDb === null ? null : levelDb - base.prevLevelDb
  const beatsBest = !clipped && (base.bestDb === null || levelDb > base.bestDb)
  const bestDb = beatsBest ? levelDb : base.bestDb
  const range = bestDb === null ? base.range : updateRange(base.range, noiseDb, bestDb, cfg)
  let pct: number | null = null
  if (!first) pct = clipped ? 100 : range !== null ? rangePct(levelDb, range) : null
  return {
    verdict: verdictFor(deltaPrevDb, clipped, cfg),
    deltaPrevDb,
    pct,
    isNewBest: !first && beatsBest,
    bestDb,
    range,
  }
}

function makeReading(
  id: number,
  tMs: number,
  levelDb: number,
  snrDb: number,
  ev: Evaluated,
  clipped: boolean,
  chirpCount: number,
  missedBefore: number,
  source: 'chirp' | 'train',
): Reading {
  return {
    id,
    tMs,
    levelDb,
    snrDb,
    verdict: ev.verdict,
    deltaPrevDb: ev.deltaPrevDb,
    pct: ev.pct,
    isNewBest: ev.isNewBest,
    clipped,
    chirpCount,
    missedBefore,
    source,
  }
}

/** Registers a chirp or a live train: merges into the open group or creates a new reading. */
function addReading(state: HuntState, input: ReadingInput, events: HuntEvent[], cfg: Config): void {
  const g = state.group
  if (g !== null && input.source === 'chirp' && input.tMs - g.lastEndMs <= cfg.groupGapMs) {
    g.lastEndMs = Math.max(g.lastEndMs, input.endMs)
    g.levelDb = Math.max(g.levelDb, input.levelDb)
    g.snrDb = Math.max(g.snrDb, input.snrDb)
    g.clipped = g.clipped || input.clipped
    g.chirpCount += input.chirpCount
    const ev = evaluate(g.baseline, g.levelDb, g.clipped, g.noiseDb, cfg)
    state.bestDb = ev.bestDb
    state.range = ev.range
    state.prevLevelDb = g.levelDb
    const reading = makeReading(g.id, g.tMs, g.levelDb, g.snrDb, ev, g.clipped, g.chirpCount, g.missedBefore, 'chirp')
    const idx = state.readings.findIndex((r) => r.id === g.id)
    if (idx >= 0) state.readings[idx] = reading
    events.push({ type: 'readingUpdated', reading })
    return
  }

  let missedBefore = 0
  const prevOnset = state.lastOnsetMs
  const resetEndMs = state.resetGroupEndMs
  state.resetGroupEndMs = null
  const continuesResetBurst = resetEndMs !== null && input.source === 'chirp' && input.tMs - resetEndMs <= cfg.groupGapMs
  if (!continuesResetBurst) {
    // A train starting at or before the previous reading (the chirp-mode start of the same
    // episode) adds no interval.
    if (prevOnset !== null && input.tMs > prevOnset) {
      const est = estimateInterval(state.gapsMs, cfg)
      const r = reconcileGap(input.tMs - prevOnset, est === null ? null : est.medianMs, cfg)
      state.gapsMs.push(r.estimateMs)
      while (state.gapsMs.length > cfg.intervalN) state.gapsMs.shift()
      missedBefore = r.missed
      state.missedChirps += Math.max(0, r.missed - state.abortedSinceReading)
    }
    state.lastOnsetMs = prevOnset === null ? input.tMs : Math.max(prevOnset, input.tMs)
    state.abortedSinceReading = 0
  }

  const baseline: Baseline = { prevLevelDb: state.prevLevelDb, bestDb: state.bestDb, range: state.range }
  const ev = evaluate(baseline, input.levelDb, input.clipped, input.noiseDb, cfg)
  state.bestDb = ev.bestDb
  state.range = ev.range
  state.prevLevelDb = input.levelDb
  const id = state.nextId++
  const reading = makeReading(
    id,
    input.tMs,
    input.levelDb,
    input.snrDb,
    ev,
    input.clipped,
    input.chirpCount,
    missedBefore,
    input.source,
  )
  state.readings.push(reading)
  while (state.readings.length > cfg.readingsKept) state.readings.shift()
  state.group =
    input.source === 'chirp'
      ? {
          id,
          tMs: input.tMs,
          baseline,
          noiseDb: input.noiseDb,
          missedBefore,
          lastEndMs: input.endMs,
          levelDb: input.levelDb,
          snrDb: input.snrDb,
          clipped: input.clipped,
          chirpCount: input.chirpCount,
        }
      : null
  events.push({ type: 'reading', reading })
}

/**
 * Forget readings, best, previous level, meter ranges (readings and live), the live train peak and
 * any open reading group, so the next reading is 'first' again. Keeps f0, mode, the interval
 * estimate and the onset history: the detector's timing does not change, so the countdown
 * carries on, and a reset in the middle of a burst does not turn the rest of that burst into a
 * new interval. cfg is unused; it keeps the signature uniform with the other hunt functions.
 */
export function resetBest(state: HuntState, _cfg: Config): void {
  state.readings = []
  state.prevLevelDb = null
  state.bestDb = null
  state.range = null
  state.resetGroupEndMs = state.group !== null ? state.group.lastEndMs : null
  state.group = null
  state.liveBestDb = null
  state.liveRange = null
  if (state.live !== null) {
    state.live.trainPeakDb = null
    state.live.trainClipped = false
  }
}

// ---- Activity episodes and the mode classifier -------------------------------------------------

/**
 * A frame is active while a chirp segment is open (in both modes). Activity starting more than
 * liveRapidGapMs after the previous active frame starts a new episode (at the segment's onset);
 * in chirp mode an episode covering more than liveEnterCoverS switches to live.
 */
function activityStep(state: HuntState, tMs: number, opened: Segment | null, cfg: Config, events: HuntEvent[]): void {
  if (state.seg === null) return
  const startMs = opened !== null ? opened.tOnsetMs : tMs
  if (state.lastActiveMs === null || startMs - state.lastActiveMs > cfg.liveRapidGapMs) {
    state.episodeStartMs = startMs
    state.episodeOnsets = 0
  }
  if (opened !== null) {
    state.episodeOnsets++
    if (state.live !== null) state.live.trainOnsets++
  }
  state.lastActiveMs = tMs
  if (state.mode === 'chirp' && state.lastActiveMs - state.episodeStartMs > cfg.liveEnterCoverS * 1000) {
    enterLive(state, cfg, events)
  }
}

/** Chirp -> live: the open segment is abandoned for readings and the open group is closed. */
function enterLive(state: HuntState, cfg: Config, events: HuntEvent[]): void {
  state.mode = 'live'
  events.push({ type: 'mode', mode: 'live' })
  if (state.seg !== null) state.seg.noReading = true
  state.group = null
  state.live = newLive(state.episodeStartMs, state.episodeOnsets, cfg)
}

// ---- Live meter --------------------------------------------------------------------------------

function pushHold(state: HuntState, e: HoldEntry, cfg: Config): void {
  state.holdFrames.push(e)
  const cutoff = e.tMs - cfg.liveHoldMs
  while (state.holdFrames.length > 0 && state.holdFrames[0]!.tMs <= cutoff) state.holdFrames.shift()
}

function holdNoiseDb(state: HuntState): number {
  return state.holdFrames.length > 0 ? median(state.holdFrames.map((e) => e.bandFloorDb)) : state.bandFloorDb
}

function liveStep(state: HuntState, lv: LiveState, tMs: number, cfg: Config, events: HuntEvent[]): void {
  let held = cfg.silentDb
  let heldClipped = false
  for (const e of state.holdFrames) {
    if (e.levelDb > held) held = e.levelDb
    if (e.clipped) heldClipped = true
  }
  lv.heldDb = held
  lv.heldClipped = heldClipped
  if (lv.trainPeakDb === null || held > lv.trainPeakDb) lv.trainPeakDb = held
  if (heldClipped) lv.trainClipped = true

  if (lv.lastTickMs === null || tMs - lv.lastTickMs >= cfg.liveVerdictMs) liveTick(state, lv, tMs, cfg)

  const lastActive = state.lastActiveMs ?? lv.trainStartMs
  if (tMs - lastActive >= cfg.liveExitSilenceS * 1000) exitLive(state, lv, tMs, cfg, events)
}

/** Once per liveVerdictMs: verdict vs the held level liveRefMs earlier, live best and range. */
function liveTick(state: HuntState, lv: LiveState, tMs: number, cfg: Config): void {
  lv.history.push({ tMs, heldDb: lv.heldDb })
  const cutoff = tMs - cfg.liveRefMs
  while (lv.history.length >= 2 && lv.history[1]!.tMs <= cutoff) lv.history.shift()
  const ref = lv.history[0]!.tMs <= cutoff ? lv.history[0]! : null
  lv.deltaDb = ref === null ? null : lv.heldDb - ref.heldDb
  if (lv.heldClipped) lv.verdict = 'max'
  else if (lv.deltaDb === null) lv.verdict = null
  else lv.verdict = lv.deltaDb > cfg.deadBandDb ? 'warmer' : lv.deltaDb < -cfg.deadBandDb ? 'colder' : 'same'
  if (!lv.heldClipped && (state.liveBestDb === null || lv.heldDb > state.liveBestDb)) state.liveBestDb = lv.heldDb
  if (state.liveBestDb !== null) state.liveRange = updateRange(state.liveRange, holdNoiseDb(state), state.liveBestDb, cfg)
  lv.lastTickMs = tMs
}

/** liveExitSilenceS without activity: back to chirp mode; the finished train becomes one reading. */
function exitLive(state: HuntState, lv: LiveState, tMs: number, cfg: Config, events: HuntEvent[]): void {
  state.live = null
  state.mode = 'chirp'
  if (state.seg !== null) state.seg.noReading = true
  events.push({ type: 'mode', mode: 'chirp' })
  if (lv.trainPeakDb === null) return
  const noiseDb = holdNoiseDb(state)
  addReading(
    state,
    {
      tMs: lv.trainStartMs,
      endMs: state.lastActiveMs ?? tMs,
      levelDb: lv.trainPeakDb,
      snrDb: lv.trainPeakDb - noiseDb,
      noiseDb,
      clipped: lv.trainClipped,
      chirpCount: Math.max(1, lv.trainOnsets),
      source: 'train',
    },
    events,
    cfg,
  )
}

function liveView(state: HuntState, lv: LiveState): LiveView {
  let pct: number | null = null
  if (lv.lastTickMs !== null) {
    if (lv.heldClipped) pct = 100
    else if (state.liveRange !== null) pct = rangePct(lv.heldDb, state.liveRange)
  }
  return { levelDb: lv.heldDb, pct, verdict: lv.verdict, deltaDb: lv.deltaDb, clipped: lv.heldClipped }
}

// ---- Countdown and view ------------------------------------------------------------------------

/**
 * Countdown to the next expected chirp at nowMs (chirp mode; null in live mode), from the onset L
 * of the last reading and the interval estimate:
 * - no reading yet: 'unknown' with null times;
 * - no or unconfident interval: 'unknown' with sinceLastS (and intervalS once a gap exists), then
 *   'wait' once L is longWaitS old (beeps minutes apart: stay put until the next one);
 * - confident, T = L + median: 'eta' before T - holdStartS - 2 * MAD, 'hold' until
 *   T + max(2 * MAD, holdEndMinS) + holdEndExtraS, then 'late', 'overdue' past overdueX * median
 *   since L and 'lost' past lostX * median. With a median of at least longWaitS, 'hold', 'late'
 *   and 'overdue' are all 'wait'.
 * holdActive (clicks and haptics silent) = 'hold', 'wait' or a chirp segment currently open;
 * always false in live mode. L comes from the onset history, which resetBest keeps.
 */
export function countdownAt(
  state: HuntState,
  nowMs: number,
  cfg: Config,
): { countdown: Countdown | null; holdActive: boolean } {
  if (state.mode === 'live') return { countdown: null, holdActive: false }
  const segOpen = state.seg !== null
  const last = state.lastOnsetMs
  if (last === null) {
    return {
      countdown: { kind: 'unknown', etaS: null, sinceLastS: null, intervalS: null, confident: false },
      holdActive: segOpen,
    }
  }
  const est = estimateInterval(state.gapsMs, cfg)
  const sinceMs = nowMs - last
  const longMs = cfg.longWaitS * 1000
  if (est === null || !est.confident) {
    // No rhythm yet. A beep this long ago means beeps minutes apart: stay put for the next one.
    const wait = sinceMs >= longMs
    return {
      countdown: {
        kind: wait ? 'wait' : 'unknown',
        etaS: null,
        sinceLastS: sinceMs / 1000,
        intervalS: est === null ? null : est.medianMs / 1000,
        confident: false,
      },
      holdActive: wait || segOpen,
    }
  }
  const expectedMs = last + est.medianMs
  // Irregular beeps come early as often as late: the hold starts 2 MAD sooner, as it ends 2 MAD later.
  const holdStartMs = expectedMs - cfg.holdStartS * 1000 - 2 * est.madMs
  const holdEndMs = expectedMs + Math.max(2 * est.madMs, cfg.holdEndMinS * 1000) + cfg.holdEndExtraS * 1000
  const long = est.medianMs >= longMs
  let kind: CountdownKind
  if (nowMs < holdStartMs) kind = 'eta'
  else if (nowMs <= holdEndMs) kind = long ? 'wait' : 'hold'
  else if (sinceMs > cfg.lostX * est.medianMs) kind = 'lost'
  else if (sinceMs > cfg.overdueX * est.medianMs) kind = long ? 'wait' : 'overdue'
  else kind = long ? 'wait' : 'late'
  return {
    countdown: {
      kind,
      etaS: (expectedMs - nowMs) / 1000,
      sinceLastS: sinceMs / 1000,
      intervalS: est.medianMs / 1000,
      confident: true,
    },
    holdActive: kind === 'hold' || kind === 'wait' || segOpen,
  }
}

/** Plain snapshot of the hunt at nowMs (frame clock) for the UI and the click / haptic feedback. */
export function huntView(state: HuntState, nowMs: number, cfg: Config): HuntView {
  const last = state.readings.length > 0 ? state.readings[state.readings.length - 1]! : null
  const live = state.mode === 'live' && state.live !== null ? liveView(state, state.live) : null
  let warmth: number | null = null
  if (live !== null) {
    if (live.pct !== null) warmth = live.clipped ? 1 : live.pct / 100
  } else if (last !== null && last.pct !== null) {
    warmth = last.clipped ? 1 : last.pct / 100
  }
  const cd = countdownAt(state, nowMs, cfg)
  return {
    mode: state.mode,
    f0Hz: state.f0Hz,
    readings: state.readings.slice(),
    last,
    bestDb: state.mode === 'live' ? state.liveBestDb : state.bestDb,
    warmth,
    countdown: cd.countdown,
    holdActive: cd.holdActive,
    hearing: state.seg !== null || state.hearingSnrDb >= cfg.onsetSnrDb,
    live,
    levelDb: state.levelDb,
    bandFloorDb: state.bandFloorDb,
    snrDb: state.snrDb,
    missedChirps: state.missedChirps,
    chirps: state.chirps.slice(),
  }
}
