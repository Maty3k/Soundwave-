import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIG, withConfig } from './config.ts'
import {
  cleanLabel,
  HISTORY_KEY,
  loadHistory,
  newRecordId,
  parseHistory,
  recordFromSummary,
  relabelRecord,
  removeRecord,
  saveHistory,
  serializeHistory,
  upsertRecord,
} from './history.ts'
import type { FoundNote, FoundSummary, HuntRecord } from './types.ts'

const T = 1_790_000_000_000

const SUMMARY: FoundSummary = {
  foundAtWallMs: T,
  startedAtWallMs: T - 380_000,
  f0Hz: 3100.4,
  mode: 'chirp',
  readings: 14,
  bestLevelDb: -41,
  notes: [{ wallMs: T - 60_000, note: 'hallway by the door', verdict: 'warmer', pct: 82 }],
  loudestListener: 'Kitchen',
  listeners: 2,
}

function rec(id: number, foundAt: number, label = ''): HuntRecord {
  return { id, label, summary: { ...SUMMARY, foundAtWallMs: foundAt } }
}

function note(i: number): FoundNote {
  return { wallMs: T - 100_000 + i * 1000, note: `note ${i}`, verdict: 'same', pct: null }
}

describe('newRecordId', () => {
  it('is the found time, or the next free number after it', () => {
    expect(newRecordId([], T + 0.7)).toBe(T)
    expect(newRecordId([rec(T, T), rec(T + 1, T)], T)).toBe(T + 2)
    expect(newRecordId([rec(T + 5, T)], T)).toBe(T)
    expect(newRecordId([], Number.NaN)).toBe(0)
  })
})

describe('recordFromSummary', () => {
  it('keeps the summary as it is when its notes fit', () => {
    const r = recordFromSummary(7, 'Hallway smoke alarm', SUMMARY, CONFIG)
    expect(r).toEqual({ id: 7, label: 'Hallway smoke alarm', summary: SUMMARY })
    expect(r.summary).toBe(SUMMARY)
  })

  it('keeps only the newest notes and a label of at most the maximum length', () => {
    const notes = Array.from({ length: CONFIG.historyMaxNotes + 3 }, (_, i) => note(i))
    const r = recordFromSummary(7, 'x'.repeat(CONFIG.historyLabelMaxLength + 10), { ...SUMMARY, notes }, CONFIG)
    expect(r.summary.notes).toEqual(notes.slice(3))
    expect(r.label).toHaveLength(CONFIG.historyLabelMaxLength)
  })
})

describe('upsertRecord', () => {
  it('adds a hunt newest first', () => {
    const old = [rec(1, T - 2000), rec(2, T - 1000)]
    expect(upsertRecord(old, rec(3, T), CONFIG).map((r) => r.id)).toEqual([3, 2, 1])
    expect(upsertRecord(old, rec(0, T - 5000), CONFIG).map((r) => r.id)).toEqual([2, 1, 0])
  })

  it('replaces the record with the same id (Keep hunting, then Found it again) and re-sorts', () => {
    const history = [rec(2, T - 1000), rec(1, T - 2000, 'Fridge')]
    const again = { ...rec(1, T, 'Fridge'), summary: { ...SUMMARY, foundAtWallMs: T, readings: 20 } }
    const next = upsertRecord(history, again, CONFIG)
    expect(next.map((r) => r.id)).toEqual([1, 2])
    expect(next[0]!.summary.readings).toBe(20)
    expect(next[0]!.label).toBe('Fridge')
  })

  it('keeps at most historyMaxEntries, dropping the oldest', () => {
    const cfg = withConfig({ historyMaxEntries: 3 })
    const history = [rec(3, T - 1000), rec(2, T - 2000), rec(1, T - 3000)]
    expect(upsertRecord(history, rec(4, T), cfg).map((r) => r.id)).toEqual([4, 3, 2])
  })
})

describe('relabelRecord and removeRecord', () => {
  const history = [rec(2, T, 'Fridge'), rec(1, T - 1000)]

  it('renames a record, keeping the text as typed up to the maximum length', () => {
    const next = relabelRecord(history, 1, 'Hallway ', CONFIG)
    expect(next[1]!.label).toBe('Hallway ')
    expect(next[0]).toBe(history[0])
    expect(relabelRecord(history, 1, 'y'.repeat(99), CONFIG)[1]!.label).toBe(cleanLabel('y'.repeat(99), CONFIG))
    expect(cleanLabel('y'.repeat(99), CONFIG)).toHaveLength(CONFIG.historyLabelMaxLength)
  })

  it('returns the same array when nothing changes', () => {
    expect(relabelRecord(history, 2, 'Fridge', CONFIG)).toBe(history)
    expect(relabelRecord(history, 99, 'x', CONFIG)).toBe(history)
    expect(removeRecord(history, 99)).toBe(history)
  })

  it('removes a record', () => {
    expect(removeRecord(history, 2).map((r) => r.id)).toEqual([1])
  })
})

describe('parseHistory', () => {
  it('reads back what serializeHistory wrote', () => {
    const history = [rec(2, T, 'Hallway smoke alarm'), { ...rec(1, T - 1000), summary: { ...SUMMARY, foundAtWallMs: T - 1000, mode: 'live' as const, startedAtWallMs: null, f0Hz: null, bestLevelDb: null, loudestListener: null, listeners: 1 } }]
    expect(parseHistory(serializeHistory(history), CONFIG)).toEqual(history)
  })

  it('gives an empty history for nothing or garbage', () => {
    for (const raw of [null, '', 'not json', '42', 'null', '[]', '{}', '{"hunts": 3}', '{"hunts": [1, "x", null]}']) {
      expect(parseHistory(raw, CONFIG), String(raw)).toEqual([])
    }
  })

  it('drops invalid entries and duplicate ids, keeping the valid ones', () => {
    const good = rec(1, T)
    const bad: unknown[] = [
      { ...good, id: 'x' },
      { ...good, id: 1.5 },
      { ...good, id: 1 }, // duplicate of the first valid one
      { ...good, id: 3, summary: null },
      { ...good, id: 4, summary: { ...SUMMARY, foundAtWallMs: 'yesterday' } },
      { ...good, id: 5, summary: { ...SUMMARY, mode: 'loud' } },
      { ...good, id: 6, summary: { ...SUMMARY, readings: -1 } },
      { ...good, id: 7, summary: { ...SUMMARY, listeners: 0 } },
      { ...good, id: 8, summary: { ...SUMMARY, f0Hz: '3100' } },
      { ...good, id: 9, summary: { ...SUMMARY, loudestListener: 5 } },
    ]
    const raw = JSON.stringify({ hunts: [good, ...bad] })
    expect(parseHistory(raw, CONFIG)).toEqual([good])
  })

  it('cleans up what it keeps: invalid notes dropped, long texts cut, a missing label empty', () => {
    const notes = [
      note(0),
      { wallMs: T, note: '   ', verdict: 'same', pct: null },
      { wallMs: T, note: 'x', verdict: 'hotter', pct: null },
      { wallMs: 'noon', note: 'x', verdict: 'same', pct: null },
      { wallMs: T, note: 'z'.repeat(500), verdict: 'max', pct: 100 },
    ]
    const raw = JSON.stringify({
      hunts: [{ id: 1, label: 7, summary: { ...SUMMARY, notes, loudestListener: 'K'.repeat(200) } }],
    })
    const [r] = parseHistory(raw, CONFIG)
    expect(r!.label).toBe('')
    expect(r!.summary.notes.map((n) => n.note)).toEqual(['note 0', 'z'.repeat(CONFIG.logNoteMaxLength)])
    expect(r!.summary.loudestListener).toHaveLength(60)
  })

  it('sorts newest first and keeps at most historyMaxEntries', () => {
    const cfg = withConfig({ historyMaxEntries: 2 })
    const raw = serializeHistory([rec(1, T - 2000), rec(3, T), rec(2, T - 1000)])
    expect(parseHistory(raw, cfg).map((r) => r.id)).toEqual([3, 2])
  })
})

describe('loadHistory and saveHistory', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function installStorage(): Map<string, string> {
    const map = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    })
    return map
  }

  it('round-trips through localStorage and removes the key when the history is empty', () => {
    const map = installStorage()
    const history = [rec(2, T, 'Fridge'), rec(1, T - 1000)]
    expect(saveHistory(history)).toBe(true)
    expect(map.has(HISTORY_KEY)).toBe(true)
    expect(loadHistory(CONFIG)).toEqual(history)
    expect(saveHistory([])).toBe(true)
    expect(map.has(HISTORY_KEY)).toBe(false)
    expect(loadHistory(CONFIG)).toEqual([])
  })

  it('copes with blocked or missing storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    })
    expect(loadHistory(CONFIG)).toEqual([])
    expect(saveHistory([rec(1, T)])).toBe(false)
    vi.stubGlobal('localStorage', undefined)
    expect(loadHistory(CONFIG)).toEqual([])
    expect(saveHistory([rec(1, T)])).toBe(false)
  })
})
