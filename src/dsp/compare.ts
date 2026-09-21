/**
 * Comparing several listeners per chirp.
 *
 * A listener is this device's main mic ('self', which runs the hunt), another microphone on this
 * device ('mic') or another device left in another room ('station'). Every listener measures the
 * hub's locked frequency and reports each chirp it hears: onset (already on the hub's clock), level
 * in its own device's dB, SNR and clipped. Reports whose onsets lie within config.compareWindowMs
 * of a group's reference onset are the same chirp, and each hub reading has a group of its own.
 * Per chirp the listeners are ranked by calibrated
 * level (raw level plus a per-listener offset, because mic sensitivities differ), and the loudest
 * is only named when it clearly beats the second. A one-shot calibration equalises the offsets on
 * a chirp heard by every listener (for example with all devices placed side by side).
 *
 * Pure TypeScript, no DOM, Web Audio or WebRTC. Times are ms on the hub's app clock.
 */
import { CONFIG } from '../config.ts'
import type { Config } from '../config.ts'
import type { Comparison, ComparisonEntry, ListenerKind, ListenerStatus, ListenerView } from '../types.ts'

/** Chirp groups whose latest report is older than this are forgotten. */
export const GROUP_KEEP_MS = 60_000
/** At most this many chirp groups are kept (the least recently updated go first). */
export const MAX_GROUPS = 64
/** A live level is fresh while younger than this many config.stationLevelReportMs periods. */
export const LIVE_FRESH_PERIODS = 3
/** Float slack so a margin of exactly config.compareMinMarginDb counts. */
const EPS_DB = 1e-9

// ---- Types -------------------------------------------------------------------------------------

/** One listener as the hub tracks it. */
export interface ListenerInfo {
  readonly id: string
  name: string
  readonly kind: ListenerKind
  status: ListenerStatus
  /** Calibration offset (dB) added to this listener's raw levels before comparing. */
  offsetDb: number
  /** App-clock time of the last message or report from this listener; null if never seen. */
  lastSeenMs: number | null
}

/** One chirp as heard by one listener. */
export interface ChirpReport {
  readonly listenerId: string
  /**
   * Chirp onset on the hub's clock. For a 'self' report of an updated (merged) reading pass the
   * reading's tMs, which merging does not change, so the update lands in the same group.
   */
  readonly onsetMs: number
  /** Raw level in the listener's own device dB. */
  readonly levelDb: number
  readonly snrDb: number
  readonly clipped: boolean
  /**
   * The hub's reading id; only read from 'self' reports. A 'self' report with an id joins its own
   * reading's group and never the group of another reading.
   */
  readonly readingId?: number | null
}

/** Every listener's report of one chirp. */
export interface ReportGroup {
  readonly id: number
  /** Reference onset: the kept 'self' report's onset when there is one, else the first report's. */
  tMs: number
  /** One report per listener, in arrival order (the louder one when a listener reported twice). */
  readonly reports: Map<string, ChirpReport>
  /** The hub's reading id, from the group's 'self' report. */
  readingId: number | null
  /** App-clock time of the latest report added (for pruning). */
  updatedMs: number
  /** Update order; the group with the highest value is the last comparison. */
  seq: number
}

/** A listener's latest live (held) level. */
export interface LiveLevel {
  readonly levelDb: number
  readonly clipped: boolean
  readonly atMs: number
  /** Arrival order (CompareState.liveSeq when received). */
  readonly seq: number
}

/** Everything the comparison keeps. Mutated in place by the functions below. */
export interface CompareState {
  /** Listeners by id, in insertion order. */
  readonly listeners: Map<string, ListenerInfo>
  /** Recent chirp groups, oldest first. */
  groups: ReportGroup[]
  /** Latest live level per listener id. */
  readonly live: Map<string, LiveLevel>
  /** Waiting for a chirp heard by every listening listener to equalise their offsets. */
  calibrating: boolean
  /**
   * Only chirp groups with at least this id (created after startCalibration) may calibrate: a chirp
   * whose first report arrived before the user asked may have been heard with the devices apart.
   */
  calibrateFromGroupId: number
  /** Only live levels with at least this seq (received after startCalibration) may calibrate. */
  calibrateFromLiveSeq: number
  /**
   * Start of the lost timer for listeners set back to 'listening' after a quiet spell, so a stale
   * lastSeenMs does not mark them lost at once. null: starts at the next updateStatuses call.
   */
  readonly graceFromMs: Map<string, number | null>
  nextGroupId: number
  /** Counter behind ReportGroup.seq. */
  seq: number
  /** Counter behind LiveLevel.seq. */
  liveSeq: number
}

// ---- Listeners ---------------------------------------------------------------------------------

const KIND_RANK: Readonly<Record<ListenerKind, number>> = { self: 0, mic: 1, station: 2 }

/** An empty comparison state. */
export function createCompare(): CompareState {
  return {
    listeners: new Map(),
    groups: [],
    live: new Map(),
    calibrating: false,
    calibrateFromGroupId: 1,
    calibrateFromLiveSeq: 1,
    graceFromMs: new Map(),
    nextGroupId: 1,
    seq: 0,
    liveSeq: 0,
  }
}

/** Status of a newly added listener when none is given: stations still have to connect. */
export function defaultStatus(kind: ListenerKind): ListenerStatus {
  return kind === 'station' ? 'connecting' : 'listening'
}

/**
 * Add a listener or update an existing one. An existing listener keeps its kind, and keeps its
 * offset and status unless new ones are given. A new listener counts as seen at nowMs; when nowMs
 * is not finite it is never seen and its lost timer starts at the next updateStatuses call.
 */
export function upsertListener(
  state: CompareState,
  info: {
    readonly id: string
    readonly name: string
    readonly kind: ListenerKind
    readonly status?: ListenerStatus
    readonly offsetDb?: number
  },
  nowMs: number,
): void {
  const offsetDb = info.offsetDb !== undefined && Number.isFinite(info.offsetDb) ? info.offsetDb : null
  const seenMs = Number.isFinite(nowMs) ? nowMs : null
  const existing = state.listeners.get(info.id)
  if (existing === undefined) {
    const status = info.status ?? defaultStatus(info.kind)
    state.listeners.set(info.id, {
      id: info.id,
      name: info.name,
      kind: info.kind,
      status,
      offsetDb: offsetDb ?? 0,
      lastSeenMs: seenMs,
    })
    if (seenMs === null && status === 'listening') state.graceFromMs.set(info.id, null)
    return
  }
  existing.name = info.name
  if (offsetDb !== null) existing.offsetDb = offsetDb
  if (info.status !== undefined && info.status !== existing.status) {
    existing.status = info.status
    if (info.status === 'listening') state.graceFromMs.set(info.id, seenMs)
    else state.graceFromMs.delete(info.id)
  }
}

/**
 * Forget a listener with its reports (groups left empty are dropped) and live level. While
 * calibrating, a chirp that every remaining listening listener heard calibrates at once (the
 * removed listener may have been the only one missing).
 */
export function removeListener(state: CompareState, id: string): void {
  const listener = state.listeners.get(id)
  if (listener === undefined) return
  state.listeners.delete(id)
  state.live.delete(id)
  state.graceFromMs.delete(id)
  for (const g of state.groups) {
    if (g.reports.delete(id) && listener.kind === 'self') g.readingId = null
  }
  state.groups = state.groups.filter((g) => g.reports.size > 0)
  if (state.calibrating) {
    // Oldest first: the first chirp that qualifies calibrates.
    const byAge = [...state.groups].sort((a, b) => a.id - b.id)
    for (const g of byAge) if (tryCalibrate(state, g)) break
  }
}

/** A message from the listener arrived: remember when, and a 'lost' listener is 'listening' again. */
export function touchListener(state: CompareState, id: string, nowMs: number): void {
  const l = state.listeners.get(id)
  if (l === undefined || !Number.isFinite(nowMs)) return
  l.lastSeenMs = l.lastSeenMs === null ? nowMs : Math.max(l.lastSeenMs, nowMs)
  if (l.status === 'lost') {
    l.status = 'listening'
    state.graceFromMs.delete(id)
  }
}

/**
 * Set a listener's status. Switching to 'listening' restarts its lost timer at the next
 * updateStatuses call, so an old lastSeenMs does not mark it lost straight away.
 */
export function setListenerStatus(state: CompareState, id: string, status: ListenerStatus): void {
  const l = state.listeners.get(id)
  if (l === undefined || l.status === status) return
  l.status = status
  if (status === 'listening') state.graceFromMs.set(id, null)
  else state.graceFromMs.delete(id)
}

/** 'listening' listeners not heard from for cfg.listenerLostMs become 'lost' ('self' never does). */
export function updateStatuses(state: CompareState, nowMs: number, cfg: Config): void {
  if (!Number.isFinite(nowMs)) return
  for (const l of state.listeners.values()) {
    if (l.status !== 'listening' || l.kind === 'self') continue
    let fromMs = l.lastSeenMs ?? -Infinity
    const grace = state.graceFromMs.get(l.id)
    if (grace === null) {
      state.graceFromMs.set(l.id, nowMs)
      continue
    }
    if (grace !== undefined) fromMs = Math.max(fromMs, grace)
    if (nowMs - fromMs >= cfg.listenerLostMs) {
      l.status = 'lost'
      state.graceFromMs.delete(l.id)
    }
  }
}

/** Listeners in display order: 'self' first, then extra mics, then stations, each in insertion order. */
export function orderedListeners(state: CompareState): ListenerInfo[] {
  return [...state.listeners.values()].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])
}

// ---- Chirp reports -----------------------------------------------------------------------------

/** a is louder than b: a clipped report beats an unclipped one, otherwise the higher level wins. */
function louder(a: { readonly levelDb: number; readonly clipped: boolean }, b: typeof a): boolean {
  if (a.clipped !== b.clipped) return a.clipped
  return a.levelDb > b.levelDb
}

function emptyComparison(tMs: number): Comparison {
  return { readingId: null, tMs, ranking: [], loudestId: null, marginDb: null }
}

/**
 * The group a report joins: the one whose reference onset is nearest, within cfg.compareWindowMs.
 * A 'self' report with a reading id (readingId, else null) joins the group of that reading and
 * skips the groups of other readings, so every hub reading keeps a comparison of its own (e.g. a
 * reading started by a reset in the middle of a burst, or a train reading right after the chirp
 * reading of the same episode).
 */
function findGroup(state: CompareState, onsetMs: number, readingId: number | null, cfg: Config): ReportGroup | null {
  let best: ReportGroup | null = null
  let bestDist = Infinity
  let same: ReportGroup | null = null
  let sameDist = Infinity
  for (const g of state.groups) {
    const dist = Math.abs(onsetMs - g.tMs)
    if (dist > cfg.compareWindowMs) continue
    if (readingId !== null && g.readingId !== null) {
      if (g.readingId === readingId && dist < sameDist) {
        same = g
        sameDist = dist
      }
      continue
    }
    // On a tie the newer group wins (groups are oldest first): a station's merged train report
    // shares its onset with the earlier chirp reading of the same episode.
    if (dist <= bestDist) {
      best = g
      bestDist = dist
    }
  }
  return same ?? best
}

/** Drop groups not updated for GROUP_KEEP_MS and cap their number; `keep` always stays. */
function pruneGroups(state: CompareState, nowMs: number, keep: ReportGroup): void {
  state.groups = state.groups.filter((g) => g === keep || nowMs - g.updatedMs <= GROUP_KEEP_MS)
  while (state.groups.length > MAX_GROUPS) {
    let oldest = -1
    for (let i = 0; i < state.groups.length; i++) {
      const g = state.groups[i]!
      if (g !== keep && (oldest < 0 || g.seq < state.groups[oldest]!.seq)) oldest = i
    }
    if (oldest < 0) break
    state.groups.splice(oldest, 1)
  }
}

/** A raw (uncalibrated) level as a report or a live level carries it. */
type RawLevel = { readonly levelDb: number; readonly clipped: boolean }

/**
 * When levelOf gives an unclipped raw level for every 'listening' listener (at least 2), set their
 * offsets so each calibrated level equals the 'self' listener's (or, without an unclipped 'self'
 * level, the members' mean calibrated level) and stop calibrating. Returns whether it calibrated.
 */
function equalise(state: CompareState, levelOf: (id: string) => RawLevel | undefined): boolean {
  const members: { readonly listener: ListenerInfo; readonly levelDb: number }[] = []
  for (const l of state.listeners.values()) {
    if (l.status !== 'listening') continue
    const r = levelOf(l.id)
    if (r === undefined || r.clipped) return false
    members.push({ listener: l, levelDb: r.levelDb })
  }
  if (members.length < 2) return false
  const self = [...state.listeners.values()].find((l) => l.kind === 'self')
  const selfLevel = self === undefined ? undefined : levelOf(self.id)
  let refDb: number
  if (self !== undefined && selfLevel !== undefined && !selfLevel.clipped) {
    refDb = selfLevel.levelDb + self.offsetDb
  } else {
    let sum = 0
    for (const m of members) sum += m.levelDb + m.listener.offsetDb
    refDb = sum / members.length
  }
  for (const m of members) m.listener.offsetDb = refDb - m.levelDb
  state.calibrating = false
  return true
}

/** While calibrating, equalise the offsets on `group` if it was created after startCalibration. */
function tryCalibrate(state: CompareState, group: ReportGroup): boolean {
  if (!state.calibrating || group.id < state.calibrateFromGroupId) return false
  return equalise(state, (id) => group.reports.get(id))
}

/**
 * Record one listener's chirp report and return the comparison of the chirp group it joined.
 * The report goes into the group whose reference onset is nearest and within
 * cfg.compareWindowMs, else it starts a new group; a 'self' report with a reading id only joins
 * its own reading's group. A listener reporting twice in one group keeps its louder report. The
 * listener counts as heard from at nowMs. Reports from unknown listeners, with a non-finite onset
 * or level, or with a non-finite nowMs are ignored (an empty comparison is returned). Only a group
 * created after startCalibration can calibrate.
 */
export function addReport(state: CompareState, report: ChirpReport, nowMs: number, cfg: Config): Comparison {
  const listener = state.listeners.get(report.listenerId)
  if (listener !== undefined) touchListener(state, listener.id, nowMs)
  const valid = Number.isFinite(report.onsetMs) && Number.isFinite(report.levelDb) && Number.isFinite(nowMs)
  if (listener === undefined || !valid) {
    return emptyComparison(Number.isFinite(report.onsetMs) ? report.onsetMs : Number.isFinite(nowMs) ? nowMs : 0)
  }

  const readingId = listener.kind === 'self' ? (report.readingId ?? null) : null
  let group = findGroup(state, report.onsetMs, readingId, cfg)
  if (group === null) {
    group = {
      id: state.nextGroupId++,
      tMs: report.onsetMs,
      reports: new Map(),
      readingId: null,
      updatedMs: nowMs,
      seq: 0,
    }
    state.groups.push(group)
  }
  const prev = group.reports.get(listener.id)
  const kept = prev === undefined || louder(report, prev)
  if (kept) group.reports.set(listener.id, report)
  if (listener.kind === 'self' && kept) group.tMs = report.onsetMs
  // findGroup only returns a group without a reading id or with this one.
  if (readingId !== null) group.readingId = readingId
  group.updatedMs = Math.max(group.updatedMs, nowMs)
  group.seq = ++state.seq
  pruneGroups(state, nowMs, group)
  tryCalibrate(state, group)
  return comparisonOf(state, group, cfg)
}

/** Forget all chirp groups and live levels (e.g. after a new lock); listeners and offsets stay. */
export function clearReports(state: CompareState): void {
  state.groups = []
  state.live.clear()
}

// ---- Comparisons -------------------------------------------------------------------------------

/**
 * Rank calibrated entries loudest first (clipped first: a clipped mic is at least that loud; ties
 * in display order). The loudest is named only with >= 2 entries and when it is clipped while the
 * second is not, or beats the second by cfg.compareMinMarginDb (two clipped leaders cannot be told
 * apart). marginDb is the top two's level difference, never negative.
 */
export function rankEntries(
  entries: readonly ComparisonEntry[],
  readingId: number | null,
  tMs: number,
  cfg: Config,
): Comparison {
  const ranking = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.clipped !== b.e.clipped) return a.e.clipped ? -1 : 1
      if (a.e.levelDb !== b.e.levelDb) return b.e.levelDb - a.e.levelDb
      return a.i - b.i
    })
    .map((x) => x.e)
  const first = ranking[0]
  const second = ranking[1]
  if (first === undefined || second === undefined) {
    return { readingId, tMs, ranking, loudestId: null, marginDb: null }
  }
  const diff = first.levelDb - second.levelDb
  const clear = first.clipped
    ? !second.clipped
    : diff >= cfg.compareMinMarginDb - EPS_DB
  return { readingId, tMs, ranking, loudestId: clear ? first.id : null, marginDb: Math.max(0, diff) }
}

/** The up-to-date comparison of one chirp group, with the listeners' current offsets (cfg defaults to CONFIG). */
export function comparisonOf(state: CompareState, group: ReportGroup, cfg: Config = CONFIG): Comparison {
  const entries: ComparisonEntry[] = []
  for (const l of orderedListeners(state)) {
    const r = group.reports.get(l.id)
    if (r === undefined) continue
    entries.push({ id: l.id, name: l.name, levelDb: r.levelDb + l.offsetDb, clipped: r.clipped })
  }
  return rankEntries(entries, group.readingId, group.tMs, cfg)
}

/** The comparison of the most recently updated chirp group, or null without any (cfg defaults to CONFIG). */
export function lastComparison(state: CompareState, cfg: Config = CONFIG): Comparison | null {
  let last: ReportGroup | null = null
  for (const g of state.groups) if (last === null || g.seq > last.seq) last = g
  return last === null ? null : comparisonOf(state, last, cfg)
}

/**
 * Start waiting for a chirp heard by every listening listener (or, through calibrateLive, fresh
 * live levels from all of them) to equalise their offsets. Only chirps whose first report arrives,
 * and live levels received, from now on count: earlier ones may have been heard before the
 * devices were put side by side.
 */
export function startCalibration(state: CompareState): void {
  state.calibrating = true
  state.calibrateFromGroupId = state.nextGroupId
  state.calibrateFromLiveSeq = state.liveSeq + 1
}

/** Stop waiting for a calibration chirp; offsets stay as they are. */
export function cancelCalibration(state: CompareState): void {
  state.calibrating = false
}

// ---- Live mode ---------------------------------------------------------------------------------

/**
 * Record a listener's live (held) level, measured at atMs (hub clock). The latest level received
 * replaces the previous one even when its atMs is earlier: messages arrive in order, and a
 * station's atMs shifts when the hub re-estimates its clock. Unknown listeners and non-finite
 * values are ignored. It does not touch the listener, because atMs may come from another device's
 * clock: the caller calls touchListener with the arrival time.
 */
export function addLiveLevel(state: CompareState, id: string, levelDb: number, clipped: boolean, atMs: number): void {
  if (!state.listeners.has(id) || !Number.isFinite(levelDb) || !Number.isFinite(atMs)) return
  state.live.set(id, { levelDb, clipped, atMs, seq: ++state.liveSeq })
}

/** A live level is fresh while |nowMs - atMs| < LIVE_FRESH_PERIODS * cfg.stationLevelReportMs. */
function isFresh(lv: LiveLevel, nowMs: number, cfg: Config): boolean {
  return Math.abs(nowMs - lv.atMs) < LIVE_FRESH_PERIODS * cfg.stationLevelReportMs
}

/**
 * Compare the listeners' latest live levels younger than LIVE_FRESH_PERIODS *
 * cfg.stationLevelReportMs (same ranking rules, readingId null, tMs = nowMs); null without any. A
 * level stamped that far or further in the future (a wrong station clock) is not fresh either.
 */
export function liveComparison(state: CompareState, nowMs: number, cfg: Config): Comparison | null {
  if (!Number.isFinite(nowMs)) return null
  const entries: ComparisonEntry[] = []
  for (const l of orderedListeners(state)) {
    const lv = state.live.get(l.id)
    if (lv === undefined || !isFresh(lv, nowMs, cfg)) continue
    entries.push({ id: l.id, name: l.name, levelDb: lv.levelDb + l.offsetDb, clipped: lv.clipped })
  }
  if (entries.length < 1) return null
  return rankEntries(entries, null, nowMs, cfg)
}

/**
 * Live-mode calibration (a continuous tone has no chirps to calibrate on). While calibrating, once
 * every 'listening' listener (at least 2) has a fresh unclipped live level received after
 * startCalibration, equalise their offsets as a calibration chirp does and stop calibrating. Call
 * it after live levels arrive (or every frame) while the lock is 'live'. Returns whether it
 * calibrated.
 */
export function calibrateLive(state: CompareState, nowMs: number, cfg: Config): boolean {
  if (!state.calibrating || !Number.isFinite(nowMs)) return false
  return equalise(state, (id) => {
    const lv = state.live.get(id)
    return lv === undefined || lv.seq < state.calibrateFromLiveSeq || !isFresh(lv, nowMs, cfg) ? undefined : lv
  })
}

// ---- Views -------------------------------------------------------------------------------------

/**
 * One view per listener in display order ('self' first, then mics, then stations). levelDb,
 * deltaDb (vs the top of the ranking) and isLoudest come from `comparison` and are null / false
 * for listeners not in it. cfg is unused for now (kept for a stable signature).
 */
export function listenerViews(state: CompareState, comparison: Comparison | null, _cfg: Config): ListenerView[] {
  const entries = new Map<string, ComparisonEntry>()
  for (const e of comparison?.ranking ?? []) entries.set(e.id, e)
  const top = comparison?.ranking[0]
  return orderedListeners(state).map((l) => {
    const e = entries.get(l.id)
    return {
      id: l.id,
      name: l.name,
      kind: l.kind,
      status: l.status,
      levelDb: e === undefined ? null : e.levelDb,
      deltaDb: e === undefined || top === undefined ? null : e.levelDb - top.levelDb,
      isLoudest: comparison !== null && comparison.loudestId === l.id,
      offsetDb: l.offsetDb,
      lastSeenMs: l.lastSeenMs,
    }
  })
}
