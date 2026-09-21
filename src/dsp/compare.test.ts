import { describe, expect, it } from 'vitest'
import { CONFIG, withConfig } from '../config.ts'
import type { Config } from '../config.ts'
import type { Comparison } from '../types.ts'
import {
  GROUP_KEEP_MS,
  LIVE_FRESH_PERIODS,
  MAX_GROUPS,
  addLiveLevel,
  addReport,
  calibrateLive,
  cancelCalibration,
  clearReports,
  comparisonOf,
  createCompare,
  lastComparison,
  listenerViews,
  liveComparison,
  rankEntries,
  removeListener,
  setListenerStatus,
  startCalibration,
  touchListener,
  updateStatuses,
  upsertListener,
} from './compare.ts'
import type { ChirpReport, CompareState } from './compare.ts'

const W = CONFIG.compareWindowMs
const MARGIN = CONFIG.compareMinMarginDb
const LOST = CONFIG.listenerLostMs
const LIVE_MAX_AGE = LIVE_FRESH_PERIODS * CONFIG.stationLevelReportMs

// ---- Helpers -----------------------------------------------------------------------------------

/** Hub with its own mic, a second mic and one station, all listening and seen at t = 0. */
function hub(): CompareState {
  const s = createCompare()
  upsertListener(s, { id: 'self', name: 'This phone', kind: 'self', status: 'listening' }, 0)
  upsertListener(s, { id: 'usb', name: 'USB mic', kind: 'mic', status: 'listening' }, 0)
  upsertListener(s, { id: 'kitchen', name: 'Kitchen', kind: 'station', status: 'listening' }, 0)
  return s
}

function rep(listenerId: string, onsetMs: number, levelDb: number, extra: Partial<ChirpReport> = {}): ChirpReport {
  return { listenerId, onsetMs, levelDb, snrDb: 20, clipped: false, ...extra }
}

/** Ids of each group's reports, groups in creation order, reports sorted. */
function groupMembers(s: CompareState): string[][] {
  return s.groups.map((g) => [...g.reports.keys()].sort())
}

function ids(c: Comparison | null): string[] {
  return c === null ? [] : c.ranking.map((e) => e.id)
}

function levelOf(c: Comparison, id: string): number {
  const e = c.ranking.find((x) => x.id === id)
  if (e === undefined) throw new Error(`${id} not in comparison`)
  return e.levelDb
}

function statusOf(s: CompareState, id: string): string | undefined {
  return s.listeners.get(id)?.status
}

// ---- Grouping ----------------------------------------------------------------------------------

describe('grouping reports into chirps', () => {
  it('reports within compareWindowMs of the reference onset share a group, later ones start a new one', () => {
    const s = hub()
    addReport(s, rep('self', 10_000, -50), 10_100, CONFIG)
    addReport(s, rep('kitchen', 10_000 + W, -60), 10_200, CONFIG)
    expect(groupMembers(s)).toEqual([['kitchen', 'self']])
    addReport(s, rep('usb', 10_000 - W - 1, -55), 10_300, CONFIG)
    expect(groupMembers(s)).toEqual([['kitchen', 'self'], ['usb']])
  })

  it('the window comes from the config', () => {
    const cfg = withConfig({ compareWindowMs: 200 })
    const s = hub()
    addReport(s, rep('self', 10_000, -50), 10_100, cfg)
    addReport(s, rep('kitchen', 10_300, -60), 10_400, cfg)
    expect(s.groups).toHaveLength(2)
  })

  it('keeps one group per chirp when reports of two chirps arrive out of order', () => {
    const s = hub()
    const now = 41_000
    addReport(s, rep('kitchen', 40_010, -61), now, CONFIG)
    addReport(s, rep('self', 0, -50), now, CONFIG)
    addReport(s, rep('usb', 40_005, -52), now, CONFIG)
    addReport(s, rep('kitchen', 20, -60), now, CONFIG)
    addReport(s, rep('self', 40_000, -51), now, CONFIG)
    addReport(s, rep('usb', -30, -53), now, CONFIG)
    expect(s.groups).toHaveLength(2)
    const byTime = [...s.groups].sort((a, b) => a.tMs - b.tMs)
    expect([...byTime[0]!.reports.keys()].sort()).toEqual(['kitchen', 'self', 'usb'])
    expect([...byTime[1]!.reports.keys()].sort()).toEqual(['kitchen', 'self', 'usb'])
    expect(byTime[0]!.reports.get('usb')!.levelDb).toBe(-53)
    expect(byTime[1]!.reports.get('kitchen')!.levelDb).toBe(-61)
  })

  it('the reference onset is the self report once present, and a report joins the nearest group', () => {
    const s = hub()
    addReport(s, rep('kitchen', 1000, -60), 5000, CONFIG)
    const c = addReport(s, rep('self', 1400, -50), 5000, CONFIG)
    expect(c.tMs).toBe(1400)
    addReport(s, rep('usb', 1400 + W + 600, -40), 5000, CONFIG)
    expect(s.groups).toHaveLength(2)
    // A report inside both windows joins the group whose reference onset is nearer.
    const second = s.groups[1]!
    const between = second.tMs - (W / 2 - 100)
    expect(between - 1400).toBeLessThanOrEqual(W)
    addReport(s, rep('kitchen', between, -45), 5000, CONFIG)
    expect([...second.reports.keys()].sort()).toEqual(['kitchen', 'usb'])
    expect(s.groups[0]!.reports.get('kitchen')!.levelDb).toBe(-60)
  })

  it('a listener reporting twice in one group keeps its louder report', () => {
    const s = hub()
    addReport(s, rep('self', 0, -50, { readingId: 3 }), 100, CONFIG)
    let c = addReport(s, rep('self', 0, -45, { readingId: 3 }), 2000, CONFIG)
    expect(levelOf(c, 'self')).toBe(-45)
    c = addReport(s, rep('self', 0, -48, { readingId: 3 }), 3000, CONFIG)
    expect(levelOf(c, 'self')).toBe(-45)
    expect(c.ranking).toHaveLength(1)
    // A clipped report beats a louder-looking unclipped one.
    addReport(s, rep('kitchen', 100, -30), 3000, CONFIG)
    c = addReport(s, rep('kitchen', 200, -35, { clipped: true }), 3000, CONFIG)
    const kitchen = c.ranking.find((e) => e.id === 'kitchen')
    expect(kitchen).toEqual({ id: 'kitchen', name: 'Kitchen', levelDb: -35, clipped: true })
    expect(s.groups).toHaveLength(1)
  })

  it('takes readingId and tMs from the self report, whatever arrived first', () => {
    const s = hub()
    let c = addReport(s, rep('kitchen', 5000, -60, { readingId: 99 }), 6000, CONFIG)
    expect(c.readingId).toBeNull()
    expect(c.tMs).toBe(5000)
    c = addReport(s, rep('self', 5300, -50, { readingId: 7 }), 6000, CONFIG)
    expect(c.readingId).toBe(7)
    expect(c.tMs).toBe(5300)
    c = addReport(s, rep('usb', 5100, -52), 6000, CONFIG)
    expect(c.readingId).toBe(7)
    expect(ids(c)).toEqual(['self', 'usb', 'kitchen'])
  })

  it('gives every hub reading its own group, and a merged update joins its reading', () => {
    const s = hub()
    // Reading 5 at 0; a reset in the middle of the burst makes the next chirp reading 6 at 1000.
    addReport(s, rep('self', 0, -50, { readingId: 5 }), 100, CONFIG)
    addReport(s, rep('kitchen', 20, -60), 200, CONFIG)
    let c = addReport(s, rep('self', 1000, -45, { readingId: 6 }), 1100, CONFIG)
    expect(s.groups).toHaveLength(2)
    expect(c.readingId).toBe(6)
    expect(c.tMs).toBe(1000)
    expect(ids(c)).toEqual(['self'])
    // Reading 5's comparison is untouched.
    const first = comparisonOf(s, s.groups[0]!, CONFIG)
    expect(first.readingId).toBe(5)
    expect(levelOf(first, 'self')).toBe(-50)
    expect(ids(first)).toEqual(['self', 'kitchen'])
    // A merged (louder) update of reading 5 joins its own group even though reading 6's is nearer.
    c = addReport(s, rep('self', 900, -40, { readingId: 5 }), 3000, CONFIG)
    expect(c.readingId).toBe(5)
    expect(levelOf(c, 'self')).toBe(-40)
    expect(s.groups).toHaveLength(2)
    expect(levelOf(comparisonOf(s, s.groups[1]!, CONFIG), 'self')).toBe(-45)
    // Stations and mics still join the nearest group.
    c = addReport(s, rep('usb', 990, -47), 3100, CONFIG)
    expect(c.readingId).toBe(6)
  })

  it('a self report joins a group whose only self report had no reading id', () => {
    const s = hub()
    addReport(s, rep('self', 0, -40), 100, CONFIG)
    const c = addReport(s, rep('self', 0, -50, { readingId: 9 }), 200, CONFIG)
    expect(s.groups).toHaveLength(1)
    expect(c.readingId).toBe(9)
    expect(levelOf(c, 'self')).toBe(-40)
  })

  it('forgets groups not updated for about a minute', () => {
    const s = hub()
    addReport(s, rep('self', 0, -50), 0, CONFIG)
    addReport(s, rep('self', 30_000, -50), 30_000, CONFIG)
    addReport(s, rep('self', 30_000 + GROUP_KEEP_MS, -50), 30_000 + GROUP_KEEP_MS, CONFIG)
    expect(s.groups.map((g) => g.tMs)).toEqual([30_000, 30_000 + GROUP_KEEP_MS])
    // A very late report for the forgotten chirp starts a group of its own.
    addReport(s, rep('kitchen', 10, -60), 30_000 + GROUP_KEEP_MS, CONFIG)
    expect(s.groups).toHaveLength(3)
    expect(s.groups[2]!.reports.has('self')).toBe(false)
  })

  it('keeps at most MAX_GROUPS groups, dropping the least recently updated', () => {
    const s = hub()
    const now = 1000
    // Chirps 2 * W apart, all within GROUP_KEEP_MS of now, so only the cap prunes.
    for (let i = 0; i < MAX_GROUPS + 5; i++) addReport(s, rep('self', i * 2 * W, -50), now + i, CONFIG)
    expect(s.groups).toHaveLength(MAX_GROUPS)
    expect(Math.min(...s.groups.map((g) => g.tMs))).toBe(5 * 2 * W)
    // Updating the oldest kept group protects it; the next oldest goes instead.
    addReport(s, rep('kitchen', 5 * 2 * W, -60), now + 200, CONFIG)
    addReport(s, rep('self', (MAX_GROUPS + 5) * 2 * W, -50), now + 201, CONFIG)
    expect(s.groups).toHaveLength(MAX_GROUPS)
    const onsets = s.groups.map((g) => g.tMs)
    expect(onsets).toContain(5 * 2 * W)
    expect(onsets).not.toContain(6 * 2 * W)
  })

  it('ignores a report stamped with a non-finite hub clock', () => {
    const s = hub()
    const c = addReport(s, rep('self', 1000, -50), Number.NaN, CONFIG)
    expect(c.ranking).toEqual([])
    expect(s.groups).toHaveLength(0)
    // The state is not corrupted: later reports group and prune normally.
    addReport(s, rep('self', 1000, -50), 1100, CONFIG)
    addReport(s, rep('kitchen', 1000, -40), 1200, CONFIG)
    expect(groupMembers(s)).toEqual([['kitchen', 'self']])
    expect(s.groups[0]!.updatedMs).toBe(1200)
  })

  it('ignores reports from unknown listeners and non-finite values', () => {
    const s = hub()
    const c = addReport(s, rep('ghost', 0, -40), 100, CONFIG)
    expect(c.ranking).toEqual([])
    expect(c.loudestId).toBeNull()
    addReport(s, rep('self', Number.NaN, -40), 100, CONFIG)
    addReport(s, rep('self', 0, Number.NEGATIVE_INFINITY), 100, CONFIG)
    expect(s.groups).toHaveLength(0)
    expect(s.listeners.has('ghost')).toBe(false)
  })

  it('lastComparison is the most recently updated group', () => {
    const s = hub()
    expect(lastComparison(s)).toBeNull()
    addReport(s, rep('self', 0, -50), 100, CONFIG)
    addReport(s, rep('self', 40_000, -40), 40_100, CONFIG)
    expect(lastComparison(s, CONFIG)!.tMs).toBe(40_000)
    addReport(s, rep('kitchen', 50, -60), 40_200, CONFIG)
    const last = lastComparison(s, CONFIG)!
    expect(last.tMs).toBe(0)
    expect(ids(last)).toEqual(['self', 'kitchen'])
    expect(comparisonOf(s, s.groups[1]!, CONFIG).tMs).toBe(40_000)
  })

  it('clearReports forgets groups and live levels but keeps listeners and offsets', () => {
    const s = hub()
    upsertListener(s, { id: 'kitchen', name: 'Kitchen', kind: 'station', offsetDb: 4 }, 0)
    addReport(s, rep('self', 0, -50), 100, CONFIG)
    addLiveLevel(s, 'self', -50, false, 100)
    clearReports(s)
    expect(s.groups).toHaveLength(0)
    expect(liveComparison(s, 100, CONFIG)).toBeNull()
    expect(s.listeners.size).toBe(3)
    expect(s.listeners.get('kitchen')!.offsetDb).toBe(4)
  })
})

// ---- Ranking -----------------------------------------------------------------------------------

describe('ranking', () => {
  /** A group of self and kitchen at the given raw levels. */
  function pair(selfDb: number, kitchenDb: number, cfg: Config = CONFIG, extra: Partial<ChirpReport> = {}): Comparison {
    const s = hub()
    addReport(s, rep('self', 0, selfDb), 100, cfg)
    return addReport(s, rep('kitchen', 0, kitchenDb, extra), 100, cfg)
  }

  it('sorts loudest first and names the loudest only with compareMinMarginDb to spare', () => {
    const named = pair(-50, -50 + MARGIN)
    expect(ids(named)).toEqual(['kitchen', 'self'])
    expect(named.loudestId).toBe('kitchen')
    expect(named.marginDb).toBeCloseTo(MARGIN, 9)

    const close = pair(-50, -50 + MARGIN - 0.1)
    expect(ids(close)).toEqual(['kitchen', 'self'])
    expect(close.loudestId).toBeNull()
    expect(close.marginDb).toBeCloseTo(MARGIN - 0.1, 9)
  })

  it('the margin comes from the config', () => {
    const cfg = withConfig({ compareMinMarginDb: 6 })
    expect(pair(-50, -45, cfg).loudestId).toBeNull()
    expect(pair(-50, -44, cfg).loudestId).toBe('kitchen')
  })

  it('needs two listeners to name a loudest', () => {
    const s = hub()
    const c = addReport(s, rep('kitchen', 0, -20), 100, CONFIG)
    expect(ids(c)).toEqual(['kitchen'])
    expect(c.loudestId).toBeNull()
    expect(c.marginDb).toBeNull()
  })

  it('adds each listener offset before comparing', () => {
    const s = hub()
    upsertListener(s, { id: 'kitchen', name: 'Kitchen', kind: 'station', offsetDb: 10 }, 0)
    addReport(s, rep('self', 0, -50), 100, CONFIG)
    const c = addReport(s, rep('kitchen', 0, -55), 100, CONFIG)
    expect(ids(c)).toEqual(['kitchen', 'self'])
    expect(levelOf(c, 'kitchen')).toBe(-45)
    expect(c.loudestId).toBe('kitchen')
    expect(c.marginDb).toBeCloseTo(5, 9)
  })

  it('puts clipped reports first and names a clipped leader over an unclipped second', () => {
    const c = pair(-20, -35, CONFIG, { clipped: true })
    expect(ids(c)).toEqual(['kitchen', 'self'])
    expect(c.loudestId).toBe('kitchen')
    expect(c.marginDb).toBe(0)
  })

  it('cannot tell two clipped leaders apart', () => {
    const c = rankEntries(
      [
        { id: 'a', name: 'A', levelDb: -30, clipped: true },
        { id: 'b', name: 'B', levelDb: -10, clipped: true },
        { id: 'c', name: 'C', levelDb: -5, clipped: false },
      ],
      null,
      0,
      CONFIG,
    )
    expect(c.ranking.map((e) => e.id)).toEqual(['b', 'a', 'c'])
    expect(c.loudestId).toBeNull()
    expect(c.marginDb).toBeCloseTo(20, 9)
  })

  it('includes lost listeners that reported', () => {
    const s = hub()
    addReport(s, rep('self', 0, -50), 0, CONFIG)
    addReport(s, rep('kitchen', 0, -40), 0, CONFIG)
    updateStatuses(s, LOST, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('lost')
    const c = lastComparison(s, CONFIG)!
    expect(ids(c)).toEqual(['kitchen', 'self'])
    expect(c.loudestId).toBe('kitchen')
  })
})

// ---- Calibration -------------------------------------------------------------------------------

describe('calibration', () => {
  it('equalises every listener to the self level on a chirp heard by all, then ends', () => {
    const s = hub()
    startCalibration(s)
    expect(s.calibrating).toBe(true)
    addReport(s, rep('self', 0, -50), 100, CONFIG)
    addReport(s, rep('usb', 0, -44), 100, CONFIG)
    const c = addReport(s, rep('kitchen', 0, -62), 100, CONFIG)
    expect(s.calibrating).toBe(false)
    expect(s.listeners.get('self')!.offsetDb).toBe(0)
    expect(s.listeners.get('usb')!.offsetDb).toBe(-6)
    expect(s.listeners.get('kitchen')!.offsetDb).toBe(12)
    // The returned comparison already uses the new offsets.
    for (const e of c.ranking) expect(e.levelDb).toBeCloseTo(-50, 9)
    expect(c.loudestId).toBeNull()
    expect(c.marginDb).toBeCloseTo(0, 9)

    // Later chirps keep the offsets.
    addReport(s, rep('self', 40_000, -40), 40_100, CONFIG)
    addReport(s, rep('usb', 40_000, -40), 40_100, CONFIG)
    const next = addReport(s, rep('kitchen', 40_000, -60), 40_100, CONFIG)
    expect(ids(next)).toEqual(['self', 'usb', 'kitchen'])
    expect(levelOf(next, 'kitchen')).toBeCloseTo(-48, 9)
    expect(levelOf(next, 'usb')).toBeCloseTo(-46, 9)
    expect(next.loudestId).toBe('self')
    expect(s.listeners.get('kitchen')!.offsetDb).toBe(12)
  })

  it('keeps the self offset as the reference', () => {
    const s = hub()
    upsertListener(s, { id: 'self', name: 'This phone', kind: 'self', offsetDb: 2 }, 0)
    startCalibration(s)
    addReport(s, rep('self', 0, -50), 100, CONFIG)
    addReport(s, rep('usb', 0, -40), 100, CONFIG)
    addReport(s, rep('kitchen', 0, -60), 100, CONFIG)
    expect(s.listeners.get('self')!.offsetDb).toBe(2)
    expect(s.listeners.get('usb')!.offsetDb).toBe(-8)
    expect(s.listeners.get('kitchen')!.offsetDb).toBe(12)
  })

  it('uses the group mean without a self listener', () => {
    const s = createCompare()
    upsertListener(s, { id: 'a', name: 'Hall', kind: 'station', status: 'listening' }, 0)
    upsertListener(s, { id: 'b', name: 'Attic', kind: 'station', status: 'listening' }, 0)
    startCalibration(s)
    addReport(s, rep('a', 0, -50), 100, CONFIG)
    const c = addReport(s, rep('b', 0, -40), 100, CONFIG)
    expect(s.calibrating).toBe(false)
    expect(s.listeners.get('a')!.offsetDb).toBe(5)
    expect(s.listeners.get('b')!.offsetDb).toBe(-5)
    expect(levelOf(c, 'a')).toBeCloseTo(-45, 9)
    expect(levelOf(c, 'b')).toBeCloseTo(-45, 9)
  })

  it('waits for a chirp heard unclipped by every listening listener', () => {
    const s = hub()
    startCalibration(s)
    // Only two of three listening listeners heard the first chirp.
    addReport(s, rep('self', 0, -50), 100, CONFIG)
    addReport(s, rep('usb', 0, -44), 100, CONFIG)
    expect(s.calibrating).toBe(true)
    // The second chirp clipped one of them.
    addReport(s, rep('self', 40_000, -50), 40_100, CONFIG)
    addReport(s, rep('usb', 40_000, -3, { clipped: true }), 40_100, CONFIG)
    addReport(s, rep('kitchen', 40_000, -60), 40_100, CONFIG)
    expect(s.calibrating).toBe(true)
    for (const l of s.listeners.values()) expect(l.offsetDb).toBe(0)
    // The third chirp is heard cleanly by all.
    addReport(s, rep('self', 80_000, -50), 80_100, CONFIG)
    addReport(s, rep('usb', 80_000, -47), 80_100, CONFIG)
    expect(s.calibrating).toBe(true)
    addReport(s, rep('kitchen', 80_000, -58), 80_100, CONFIG)
    expect(s.calibrating).toBe(false)
    expect(s.listeners.get('usb')!.offsetDb).toBe(-3)
    expect(s.listeners.get('kitchen')!.offsetDb).toBe(8)
  })

  it('does not wait for lost or connecting listeners, but needs two listening ones', () => {
    const s = hub()
    upsertListener(s, { id: 'attic', name: 'Attic', kind: 'station' }, 0)
    expect(statusOf(s, 'attic')).toBe('connecting')
    touchListener(s, 'self', LOST)
    touchListener(s, 'usb', LOST)
    updateStatuses(s, LOST, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('lost')
    startCalibration(s)
    addReport(s, rep('self', LOST, -50), LOST, CONFIG)
    addReport(s, rep('usb', LOST, -56), LOST, CONFIG)
    expect(s.calibrating).toBe(false)
    expect(s.listeners.get('usb')!.offsetDb).toBe(6)
    expect(s.listeners.get('kitchen')!.offsetDb).toBe(0)

    const solo = createCompare()
    upsertListener(solo, { id: 'self', name: 'This phone', kind: 'self' }, 0)
    startCalibration(solo)
    addReport(solo, rep('self', 0, -50), 100, CONFIG)
    expect(solo.calibrating).toBe(true)
  })

  it('does not calibrate on a chirp whose first report arrived before calibration started', () => {
    const s = createCompare()
    upsertListener(s, { id: 'self', name: 'This phone', kind: 'self' }, 0)
    upsertListener(s, { id: 'kitchen', name: 'Kitchen', kind: 'station', status: 'listening' }, 0)
    // The chirp was heard with the devices apart; the station's report is still on its way.
    addReport(s, rep('self', 1000, -50), 1300, CONFIG)
    startCalibration(s)
    addReport(s, rep('kitchen', 1020, -70), 1500, CONFIG)
    expect(s.calibrating).toBe(true)
    expect(s.listeners.get('kitchen')!.offsetDb).toBe(0)
    // The next chirp, heard side by side, calibrates.
    addReport(s, rep('kitchen', 40_020, -58), 40_300, CONFIG)
    expect(s.calibrating).toBe(true)
    const c = addReport(s, rep('self', 40_000, -50), 40_400, CONFIG)
    expect(s.calibrating).toBe(false)
    expect(s.listeners.get('kitchen')!.offsetDb).toBe(8)
    expect(levelOf(c, 'kitchen')).toBeCloseTo(-50, 9)
  })

  it('removing the only listener that missed the chirp calibrates on it at once', () => {
    const s = hub()
    startCalibration(s)
    addReport(s, rep('self', 0, -50), 100, CONFIG)
    addReport(s, rep('usb', 0, -44), 100, CONFIG)
    // The kitchen station cannot hear the chirp; the user removes it.
    expect(s.calibrating).toBe(true)
    removeListener(s, 'kitchen')
    expect(s.calibrating).toBe(false)
    expect(s.listeners.get('usb')!.offsetDb).toBe(-6)
    const c = lastComparison(s, CONFIG)!
    for (const e of c.ranking) expect(e.levelDb).toBeCloseTo(-50, 9)
  })

  it('removing a listener while calibrating does not calibrate on an incomplete or older chirp', () => {
    const s = hub()
    upsertListener(s, { id: 'hall', name: 'Hall', kind: 'station', status: 'listening' }, 0)
    addReport(s, rep('self', 0, -50), 100, CONFIG)
    addReport(s, rep('usb', 0, -44), 100, CONFIG)
    startCalibration(s)
    addReport(s, rep('self', 40_000, -50), 40_100, CONFIG)
    removeListener(s, 'kitchen')
    // The chirp before startCalibration is complete now but does not count; the new one misses usb and hall.
    expect(s.calibrating).toBe(true)
    for (const l of s.listeners.values()) expect(l.offsetDb).toBe(0)
  })

  it('waits while the self report is clipped', () => {
    const s = hub()
    startCalibration(s)
    addReport(s, rep('self', 0, -2, { clipped: true }), 100, CONFIG)
    addReport(s, rep('usb', 0, -44), 100, CONFIG)
    addReport(s, rep('kitchen', 0, -62), 100, CONFIG)
    expect(s.calibrating).toBe(true)
    for (const l of s.listeners.values()) expect(l.offsetDb).toBe(0)
  })

  it('cancelCalibration leaves the offsets alone', () => {
    const s = hub()
    startCalibration(s)
    cancelCalibration(s)
    addReport(s, rep('self', 0, -50), 100, CONFIG)
    addReport(s, rep('usb', 0, -44), 100, CONFIG)
    addReport(s, rep('kitchen', 0, -62), 100, CONFIG)
    expect(s.calibrating).toBe(false)
    for (const l of s.listeners.values()) expect(l.offsetDb).toBe(0)
  })
})

// ---- Listener status ---------------------------------------------------------------------------

describe('listener status', () => {
  it('marks a listening listener lost after listenerLostMs of silence and recovers on touch', () => {
    const s = hub()
    updateStatuses(s, LOST - 1, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('listening')
    updateStatuses(s, LOST, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('lost')
    expect(statusOf(s, 'usb')).toBe('lost')
    touchListener(s, 'kitchen', LOST + 500)
    expect(statusOf(s, 'kitchen')).toBe('listening')
    expect(s.listeners.get('kitchen')!.lastSeenMs).toBe(LOST + 500)
    updateStatuses(s, 2 * LOST + 499, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('listening')
    updateStatuses(s, 2 * LOST + 500, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('lost')
  })

  it('never marks self lost, nor listeners still connecting', () => {
    const s = hub()
    upsertListener(s, { id: 'attic', name: 'Attic', kind: 'station', status: 'connecting' }, 0)
    updateStatuses(s, 100 * LOST, CONFIG)
    expect(statusOf(s, 'self')).toBe('listening')
    expect(statusOf(s, 'attic')).toBe('connecting')
    expect(statusOf(s, 'kitchen')).toBe('lost')
  })

  it('ignores a non-finite clock in upsert and updateStatuses', () => {
    const s = hub()
    upsertListener(s, { id: 'hall', name: 'Hall', kind: 'station', status: 'listening' }, Number.NaN)
    expect(s.listeners.get('hall')!.lastSeenMs).toBeNull()
    updateStatuses(s, Number.NaN, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('listening')
    updateStatuses(s, LOST, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('lost')
    // Added at an unknown time: its lost timer starts at the first updateStatuses with a clock.
    expect(statusOf(s, 'hall')).toBe('listening')
    updateStatuses(s, 2 * LOST - 1, CONFIG)
    expect(statusOf(s, 'hall')).toBe('listening')
    updateStatuses(s, 2 * LOST, CONFIG)
    expect(statusOf(s, 'hall')).toBe('lost')
  })

  it('touch ignores unknown listeners and a non-finite clock, and does not end connecting', () => {
    const s = hub()
    upsertListener(s, { id: 'attic', name: 'Attic', kind: 'station' }, 0)
    touchListener(s, 'ghost', 100)
    expect(s.listeners.has('ghost')).toBe(false)
    touchListener(s, 'kitchen', Number.NaN)
    expect(s.listeners.get('kitchen')!.lastSeenMs).toBe(0)
    touchListener(s, 'attic', 500)
    expect(statusOf(s, 'attic')).toBe('connecting')
    expect(s.listeners.get('attic')!.lastSeenMs).toBe(500)
    // A touch never moves lastSeenMs back.
    touchListener(s, 'attic', 400)
    expect(s.listeners.get('attic')!.lastSeenMs).toBe(500)
  })

  it('upsert ignores a non-finite offset', () => {
    const s = hub()
    upsertListener(s, { id: 'kitchen', name: 'Kitchen', kind: 'station', offsetDb: 5 }, 0)
    upsertListener(s, { id: 'kitchen', name: 'Kitchen', kind: 'station', offsetDb: Number.NaN }, 0)
    expect(s.listeners.get('kitchen')!.offsetDb).toBe(5)
    upsertListener(s, { id: 'hall', name: 'Hall', kind: 'station', offsetDb: Number.POSITIVE_INFINITY }, 0)
    expect(s.listeners.get('hall')!.offsetDb).toBe(0)
  })

  it('the lost time comes from the config', () => {
    const s = hub()
    updateStatuses(s, 1000, withConfig({ listenerLostMs: 1000 }))
    expect(statusOf(s, 'kitchen')).toBe('lost')
  })

  it('a report from a lost listener brings it back', () => {
    const s = hub()
    updateStatuses(s, LOST, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('lost')
    addReport(s, rep('kitchen', LOST, -60), LOST + 100, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('listening')
    expect(s.listeners.get('kitchen')!.lastSeenMs).toBe(LOST + 100)
  })

  it('a listener switched back to listening gets a fresh lost timer', () => {
    const s = hub()
    setListenerStatus(s, 'kitchen', 'connecting')
    setListenerStatus(s, 'kitchen', 'listening')
    const t = 5 * LOST
    updateStatuses(s, t, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('listening')
    updateStatuses(s, t + LOST - 1, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('listening')
    updateStatuses(s, t + LOST, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('lost')

    upsertListener(s, { id: 'usb', name: 'USB mic', kind: 'mic', status: 'connecting' }, 0)
    upsertListener(s, { id: 'usb', name: 'USB mic', kind: 'mic', status: 'listening' }, t)
    updateStatuses(s, t + LOST - 1, CONFIG)
    expect(statusOf(s, 'usb')).toBe('listening')
  })

  it('upsert keeps offset, status and kind unless given, and defaults new stations to connecting', () => {
    const s = hub()
    upsertListener(s, { id: 'kitchen', name: 'Kitchen', kind: 'station', offsetDb: 7 }, 10)
    upsertListener(s, { id: 'kitchen', name: 'Kitchen corner', kind: 'station' }, 20)
    const k = s.listeners.get('kitchen')!
    expect(k.name).toBe('Kitchen corner')
    expect(k.offsetDb).toBe(7)
    expect(k.status).toBe('listening')
    expect(k.lastSeenMs).toBe(0)
    upsertListener(s, { id: 'hall', name: 'Hall', kind: 'station' }, 30)
    upsertListener(s, { id: 'usb2', name: 'Headset', kind: 'mic' }, 30)
    expect(statusOf(s, 'hall')).toBe('connecting')
    expect(statusOf(s, 'usb2')).toBe('listening')
    expect(s.listeners.get('hall')!.lastSeenMs).toBe(30)
    expect(s.listeners.get('hall')!.offsetDb).toBe(0)
  })
})

// ---- Live mode ---------------------------------------------------------------------------------

describe('live comparison', () => {
  it('uses only levels younger than three report periods', () => {
    const s = hub()
    addLiveLevel(s, 'self', -50, false, 1000)
    addLiveLevel(s, 'usb', -40, false, 1000)
    addLiveLevel(s, 'kitchen', -30, false, 0)
    const c = liveComparison(s, LIVE_MAX_AGE, CONFIG)!
    expect(ids(c)).toEqual(['usb', 'self'])
    expect(c.readingId).toBeNull()
    expect(c.tMs).toBe(LIVE_MAX_AGE)
    expect(c.loudestId).toBe('usb')
    expect(c.marginDb).toBeCloseTo(10, 9)
    expect(ids(liveComparison(s, 1000 + LIVE_MAX_AGE - 1, CONFIG))).toEqual(['usb', 'self'])
    expect(liveComparison(s, 1000 + LIVE_MAX_AGE, CONFIG)).toBeNull()
  })

  it('follows stationLevelReportMs, offsets and clipping', () => {
    const cfg = withConfig({ stationLevelReportMs: 100 })
    const s = hub()
    upsertListener(s, { id: 'kitchen', name: 'Kitchen', kind: 'station', offsetDb: -20 }, 0)
    addLiveLevel(s, 'self', -30, false, 0)
    addLiveLevel(s, 'kitchen', -15, false, 0)
    addLiveLevel(s, 'usb', -60, true, 0)
    const c = liveComparison(s, 299, cfg)!
    expect(ids(c)).toEqual(['usb', 'self', 'kitchen'])
    expect(levelOf(c, 'kitchen')).toBe(-35)
    expect(c.loudestId).toBe('usb')
    expect(liveComparison(s, 300, cfg)).toBeNull()
  })

  it('one fresh level is a comparison without a loudest; unknown listeners and non-finite values are ignored', () => {
    const s = hub()
    addLiveLevel(s, 'ghost', -10, false, 100)
    expect(liveComparison(s, 100, CONFIG)).toBeNull()
    addLiveLevel(s, 'kitchen', -40, false, 100)
    addLiveLevel(s, 'kitchen', Number.NaN, false, 110)
    addLiveLevel(s, 'kitchen', -20, false, Number.POSITIVE_INFINITY)
    const c = liveComparison(s, 100, CONFIG)!
    expect(c.ranking).toEqual([{ id: 'kitchen', name: 'Kitchen', levelDb: -40, clipped: false }])
    expect(c.loudestId).toBeNull()
    expect(c.marginDb).toBeNull()
    expect(liveComparison(s, Number.NaN, CONFIG)).toBeNull()
  })

  it('the latest level received wins, even when a re-estimated station clock stamps it earlier', () => {
    const s = hub()
    addLiveLevel(s, 'kitchen', -40, false, 1000)
    addLiveLevel(s, 'kitchen', -30, false, 900)
    const c = liveComparison(s, 1000, CONFIG)!
    expect(c.ranking).toEqual([{ id: 'kitchen', name: 'Kitchen', levelDb: -30, clipped: false }])
  })

  it('a level stamped far in the future is not fresh and does not block later levels', () => {
    const s = hub()
    addLiveLevel(s, 'self', -50, false, 1000)
    addLiveLevel(s, 'kitchen', -10, false, 1000 + LIVE_MAX_AGE)
    expect(ids(liveComparison(s, 1000, CONFIG))).toEqual(['self'])
    // A little ahead (clock estimate error) still counts.
    addLiveLevel(s, 'kitchen', -60, false, 1000 + LIVE_MAX_AGE - 1)
    expect(ids(liveComparison(s, 1000, CONFIG))).toEqual(['self', 'kitchen'])
    // Once the station goes quiet after a bogus far-future level, it drops out instead of sticking.
    addLiveLevel(s, 'kitchen', -10, false, 1e12)
    expect(ids(liveComparison(s, 1000, CONFIG))).toEqual(['self'])
    addLiveLevel(s, 'kitchen', -65, false, 1100)
    expect(ids(liveComparison(s, 1100, CONFIG))).toEqual(['self', 'kitchen'])
    expect(levelOf(liveComparison(s, 1100, CONFIG)!, 'kitchen')).toBe(-65)
  })

  it('a live level does not touch the listener: its time may come from another clock', () => {
    const s = hub()
    updateStatuses(s, LOST, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('lost')
    // A level stamped far ahead (bad clock offset) must not push lastSeenMs into the future.
    addLiveLevel(s, 'kitchen', -40, false, 1e9)
    expect(statusOf(s, 'kitchen')).toBe('lost')
    expect(s.listeners.get('kitchen')!.lastSeenMs).toBe(0)
    // The caller touches with the arrival time; the station can then go lost again normally.
    touchListener(s, 'kitchen', LOST + 10)
    addLiveLevel(s, 'kitchen', -40, false, 1e9)
    expect(statusOf(s, 'kitchen')).toBe('listening')
    expect(s.listeners.get('kitchen')!.lastSeenMs).toBe(LOST + 10)
    updateStatuses(s, 2 * LOST + 10, CONFIG)
    expect(statusOf(s, 'kitchen')).toBe('lost')
  })
})

// ---- Live calibration --------------------------------------------------------------------------

describe('calibrateLive', () => {
  it('equalises on fresh live levels from every listening listener, then ends', () => {
    const s = hub()
    startCalibration(s)
    addLiveLevel(s, 'self', -50, false, 1000)
    addLiveLevel(s, 'usb', -44, false, 1000)
    expect(calibrateLive(s, 1000, CONFIG)).toBe(false)
    expect(s.calibrating).toBe(true)
    addLiveLevel(s, 'kitchen', -62, false, 1100)
    expect(calibrateLive(s, 1100, CONFIG)).toBe(true)
    expect(s.calibrating).toBe(false)
    expect(s.listeners.get('self')!.offsetDb).toBe(0)
    expect(s.listeners.get('usb')!.offsetDb).toBe(-6)
    expect(s.listeners.get('kitchen')!.offsetDb).toBe(12)
    const c = liveComparison(s, 1100, CONFIG)!
    for (const e of c.ranking) expect(e.levelDb).toBeCloseTo(-50, 9)
    // Done: later levels do not recalibrate.
    addLiveLevel(s, 'kitchen', -40, false, 1200)
    expect(calibrateLive(s, 1200, CONFIG)).toBe(false)
    expect(s.listeners.get('kitchen')!.offsetDb).toBe(12)
  })

  it('does nothing unless calibrating, and ignores levels from before startCalibration', () => {
    const s = hub()
    addLiveLevel(s, 'self', -50, false, 1000)
    addLiveLevel(s, 'usb', -44, false, 1000)
    addLiveLevel(s, 'kitchen', -62, false, 1000)
    expect(calibrateLive(s, 1000, CONFIG)).toBe(false)
    startCalibration(s)
    expect(calibrateLive(s, 1000, CONFIG)).toBe(false)
    for (const l of s.listeners.values()) expect(l.offsetDb).toBe(0)
    addLiveLevel(s, 'self', -50, false, 1100)
    addLiveLevel(s, 'usb', -44, false, 1100)
    expect(calibrateLive(s, 1100, CONFIG)).toBe(false)
    addLiveLevel(s, 'kitchen', -60, false, 1100)
    expect(calibrateLive(s, Number.NaN, CONFIG)).toBe(false)
    expect(calibrateLive(s, 1100, CONFIG)).toBe(true)
    expect(s.listeners.get('kitchen')!.offsetDb).toBe(10)
  })

  it('waits for fresh unclipped levels, but not for lost or connecting listeners', () => {
    const cfg = withConfig({ stationLevelReportMs: 100 })
    const s = hub()
    upsertListener(s, { id: 'attic', name: 'Attic', kind: 'station' }, 0)
    startCalibration(s)
    addLiveLevel(s, 'self', -50, false, 0)
    addLiveLevel(s, 'usb', -44, false, 0)
    addLiveLevel(s, 'kitchen', -3, true, 0)
    expect(calibrateLive(s, 0, cfg)).toBe(false)
    addLiveLevel(s, 'kitchen', -62, false, 0)
    // Stale after 3 * 100 ms.
    expect(calibrateLive(s, 300, cfg)).toBe(false)
    expect(s.calibrating).toBe(true)
    setListenerStatus(s, 'kitchen', 'lost')
    addLiveLevel(s, 'self', -50, false, 300)
    addLiveLevel(s, 'usb', -47, false, 300)
    expect(calibrateLive(s, 300, cfg)).toBe(true)
    expect(s.listeners.get('usb')!.offsetDb).toBe(-3)
    expect(s.listeners.get('kitchen')!.offsetDb).toBe(0)
    expect(s.listeners.get('attic')!.offsetDb).toBe(0)
  })
})

// ---- Removal -----------------------------------------------------------------------------------

describe('removeListener', () => {
  it('drops the listener, its reports, emptied groups and its live level', () => {
    const s = hub()
    addReport(s, rep('self', 0, -50), 100, CONFIG)
    addReport(s, rep('kitchen', 0, -40), 100, CONFIG)
    addReport(s, rep('kitchen', 40_000, -45), 40_100, CONFIG)
    addLiveLevel(s, 'kitchen', -40, false, 40_100)
    removeListener(s, 'kitchen')
    expect(s.listeners.has('kitchen')).toBe(false)
    expect(groupMembers(s)).toEqual([['self']])
    const last = lastComparison(s, CONFIG)!
    expect(last.tMs).toBe(0)
    expect(ids(last)).toEqual(['self'])
    expect(liveComparison(s, 40_100, CONFIG)).toBeNull()
    expect(listenerViews(s, null, CONFIG).map((v) => v.id)).toEqual(['self', 'usb'])
    // Late reports from the removed listener are ignored.
    addReport(s, rep('kitchen', 0, -40), 40_200, CONFIG)
    expect(groupMembers(s)).toEqual([['self']])
    removeListener(s, 'nobody')
    expect(s.listeners.size).toBe(2)
  })

  it('removing self clears the groups reading id', () => {
    const s = hub()
    addReport(s, rep('self', 0, -50, { readingId: 4 }), 100, CONFIG)
    addReport(s, rep('usb', 0, -40), 100, CONFIG)
    removeListener(s, 'self')
    const c = lastComparison(s, CONFIG)!
    expect(c.readingId).toBeNull()
    expect(ids(c)).toEqual(['usb'])
  })
})

// ---- Views -------------------------------------------------------------------------------------

describe('listenerViews', () => {
  it('lists self first, then mics, then stations, with levels and deltas from the comparison', () => {
    const s = createCompare()
    upsertListener(s, { id: 'kitchen', name: 'Kitchen', kind: 'station', status: 'listening' }, 0)
    upsertListener(s, { id: 'usb', name: 'USB mic', kind: 'mic' }, 0)
    upsertListener(s, { id: 'attic', name: 'Attic', kind: 'station', status: 'listening', offsetDb: 2 }, 0)
    upsertListener(s, { id: 'self', name: 'This phone', kind: 'self' }, 0)
    addReport(s, rep('self', 0, -50), 500, CONFIG)
    addReport(s, rep('kitchen', 0, -40), 600, CONFIG)
    const c = addReport(s, rep('attic', 0, -60), 700, CONFIG)
    const views = listenerViews(s, c, CONFIG)
    expect(views.map((v) => v.id)).toEqual(['self', 'usb', 'kitchen', 'attic'])
    const byId = new Map(views.map((v) => [v.id, v]))
    expect(byId.get('kitchen')).toEqual({
      id: 'kitchen',
      name: 'Kitchen',
      kind: 'station',
      status: 'listening',
      levelDb: -40,
      deltaDb: 0,
      isLoudest: true,
      offsetDb: 0,
      lastSeenMs: 600,
    })
    expect(byId.get('self')!.deltaDb).toBe(-10)
    expect(byId.get('self')!.isLoudest).toBe(false)
    expect(byId.get('attic')!.levelDb).toBe(-58)
    expect(byId.get('attic')!.deltaDb).toBe(-18)
    expect(byId.get('attic')!.offsetDb).toBe(2)
    expect(byId.get('usb')!.levelDb).toBeNull()
    expect(byId.get('usb')!.deltaDb).toBeNull()
    expect(byId.get('usb')!.isLoudest).toBe(false)
  })

  it('without a comparison every level is null and nobody is loudest', () => {
    const s = hub()
    const views = listenerViews(s, null, CONFIG)
    expect(views.map((v) => v.id)).toEqual(['self', 'usb', 'kitchen'])
    for (const v of views) {
      expect(v.levelDb).toBeNull()
      expect(v.deltaDb).toBeNull()
      expect(v.isLoudest).toBe(false)
    }
  })

  it('shows a delta but no loudest when the margin is too small', () => {
    const s = hub()
    addReport(s, rep('self', 0, -50), 100, CONFIG)
    const c = addReport(s, rep('usb', 0, -49), 100, CONFIG)
    const views = listenerViews(s, c, CONFIG)
    expect(views.find((v) => v.id === 'self')!.deltaDb).toBeCloseTo(-1, 9)
    expect(views.some((v) => v.isLoudest)).toBe(false)
  })
})
