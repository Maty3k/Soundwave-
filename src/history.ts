/**
 * Past hunts: the beeps found with Found it, kept on this device only (localStorage), newest
 * first, so the same alarm is quicker to find next time. The functions that change the history
 * are pure and return a new array (or the same one when nothing changed); main.ts saves the
 * result and dispatches it.
 */
import type { Config } from './config.ts'
import type { FoundNote, FoundSummary, HuntRecord, LockMode, Verdict } from './types.ts'

/** localStorage key of the history. */
export const HISTORY_KEY = 'soundwave.history.v1'

type HistoryConfig = Pick<Config, 'historyMaxEntries' | 'historyLabelMaxLength' | 'historyMaxNotes' | 'logNoteMaxLength'>

const VERDICTS: readonly Verdict[] = ['first', 'warmer', 'colder', 'same', 'max']
const MODES: readonly LockMode[] = ['chirp', 'live']
/** Longest station name kept (the stations panel allows shorter ones). */
const MAX_LISTENER_NAME = 60

/** An id not used in `history`: nowMs (whole ms), or the next free number after it. */
export function newRecordId(history: readonly HuntRecord[], nowMs: number): number {
  const taken = new Set(history.map((r) => r.id))
  let id = Number.isFinite(nowMs) ? Math.floor(nowMs) : 0
  while (taken.has(id)) id++
  return id
}

/** A label as stored: at most historyLabelMaxLength characters (edited text is kept as typed). */
export function cleanLabel(label: string, cfg: HistoryConfig): string {
  return label.slice(0, cfg.historyLabelMaxLength)
}

/** The record for `summary`, keeping only the newest historyMaxNotes notes. */
export function recordFromSummary(id: number, label: string, summary: FoundSummary, cfg: HistoryConfig): HuntRecord {
  const notes = summary.notes.slice(-cfg.historyMaxNotes)
  return { id, label: cleanLabel(label, cfg), summary: notes.length === summary.notes.length ? summary : { ...summary, notes } }
}

/** Newest found first; ties keep the higher (later) id first. */
function byNewest(a: HuntRecord, b: HuntRecord): number {
  return b.summary.foundAtWallMs - a.summary.foundAtWallMs || b.id - a.id
}

/** `record` added, or put in place of the record with its id; newest first, at most historyMaxEntries. */
export function upsertRecord(history: readonly HuntRecord[], record: HuntRecord, cfg: HistoryConfig): HuntRecord[] {
  const next = history.filter((r) => r.id !== record.id)
  next.push(record)
  next.sort(byNewest)
  return next.slice(0, Math.max(1, cfg.historyMaxEntries))
}

/** The history with the record's label changed; the same array when there is no such record or no change. */
export function relabelRecord(history: readonly HuntRecord[], id: number, label: string, cfg: HistoryConfig): readonly HuntRecord[] {
  const i = history.findIndex((r) => r.id === id)
  if (i < 0) return history
  const clean = cleanLabel(label, cfg)
  if (history[i]!.label === clean) return history
  const next = history.slice()
  next[i] = { ...history[i]!, label: clean }
  return next
}

/** The history without the record; the same array when there is no such record. */
export function removeRecord(history: readonly HuntRecord[], id: number): readonly HuntRecord[] {
  return history.some((r) => r.id === id) ? history.filter((r) => r.id !== id) : history
}

// ---- Reading what was stored (it may be from an older version, edited by hand, or garbage) ------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finiteOrNull(v: unknown): number | null | undefined {
  if (v === null) return null
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function parseNote(v: unknown, cfg: HistoryConfig): FoundNote | null {
  if (!isRecord(v)) return null
  const { wallMs, note, verdict, pct } = v
  if (typeof wallMs !== 'number' || !Number.isFinite(wallMs) || typeof note !== 'string' || note.trim() === '') return null
  if (!VERDICTS.includes(verdict as Verdict)) return null
  const p = finiteOrNull(pct)
  if (p === undefined) return null
  return { wallMs, note: note.slice(0, cfg.logNoteMaxLength), verdict: verdict as Verdict, pct: p }
}

function parseSummary(v: unknown, cfg: HistoryConfig): FoundSummary | null {
  if (!isRecord(v)) return null
  const found = v['foundAtWallMs']
  if (typeof found !== 'number' || !Number.isFinite(found)) return null
  const started = finiteOrNull(v['startedAtWallMs'])
  const f0 = finiteOrNull(v['f0Hz'])
  const best = finiteOrNull(v['bestLevelDb'])
  if (started === undefined || f0 === undefined || best === undefined) return null
  const mode = v['mode']
  if (mode !== null && !MODES.includes(mode as LockMode)) return null
  const readings = v['readings']
  const listeners = v['listeners']
  if (typeof readings !== 'number' || !Number.isInteger(readings) || readings < 0) return null
  if (typeof listeners !== 'number' || !Number.isInteger(listeners) || listeners < 1) return null
  const loudest = v['loudestListener']
  if (loudest !== null && typeof loudest !== 'string') return null
  const notes = Array.isArray(v['notes']) ? v['notes'] : []
  return {
    foundAtWallMs: found,
    startedAtWallMs: started,
    f0Hz: f0,
    mode: mode as LockMode | null,
    readings,
    bestLevelDb: best,
    notes: notes.map((n) => parseNote(n, cfg)).filter((n): n is FoundNote => n !== null).slice(-cfg.historyMaxNotes),
    loudestListener: loudest === null ? null : loudest.slice(0, MAX_LISTENER_NAME),
    listeners,
  }
}

/**
 * The history stored as JSON (`raw`), newest first and within the limits. Entries that are not
 * valid are dropped, as are duplicate ids; anything unreadable gives an empty history.
 */
export function parseHistory(raw: string | null, cfg: HistoryConfig): HuntRecord[] {
  if (raw === null || raw === '') return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  const list = isRecord(data) && Array.isArray(data['hunts']) ? data['hunts'] : []
  const out: HuntRecord[] = []
  const ids = new Set<number>()
  for (const item of list) {
    if (!isRecord(item)) continue
    const { id, label } = item
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || ids.has(id)) continue
    const summary = parseSummary(item['summary'], cfg)
    if (summary === null) continue
    ids.add(id)
    out.push({ id, label: typeof label === 'string' ? cleanLabel(label, cfg) : '', summary })
  }
  out.sort(byNewest)
  return out.slice(0, Math.max(1, cfg.historyMaxEntries))
}

/** The JSON stored for `history` (versioned by the key, wrapped so fields can be added later). */
export function serializeHistory(history: readonly HuntRecord[]): string {
  return JSON.stringify({ hunts: history })
}

/** The history from localStorage; empty when storage is missing, blocked or holds garbage. */
export function loadHistory(cfg: HistoryConfig): HuntRecord[] {
  try {
    return parseHistory(localStorage.getItem(HISTORY_KEY), cfg)
  } catch {
    return []
  }
}

/** Save the history (removing the key when it is empty); false when storage is blocked or full. */
export function saveHistory(history: readonly HuntRecord[]): boolean {
  try {
    if (history.length === 0) localStorage.removeItem(HISTORY_KEY)
    else localStorage.setItem(HISTORY_KEY, serializeHistory(history))
    return true
  } catch {
    return false
  }
}
