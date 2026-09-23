/**
 * App state machine: a pure reducer over AppState plus a tiny store. No DOM, no audio.
 *
 * Screens: idle -> requesting -> listening -> locked (banner) -> hunting, with paused and error
 * branches, plus idle -> station (this device listens for another device's hunt) and hunting ->
 * found (the Found it summary: Keep hunting goes back, Done ends the session, New hunt starts a
 * fresh one). Events that do not apply to the current screen return the SAME state object, so
 * the store (and anything comparing references) can skip work. Times are ms on the caller's
 * clock (performance.now() in the app); events that carry nowMs also advance state.nowMs.
 */
import type { Config } from './config.ts'
import { normalizeBand, sameBand } from './band.ts'
import type {
  AppEvent,
  AppState,
  Capabilities,
  HuntPanel,
  HuntRecord,
  LogEntry,
  PausedFrom,
  ScanState,
  Screen,
  Settings,
  StationModeView,
} from './types.ts'

const IDLE: Screen = Object.freeze({ kind: 'idle' })
const HUNTING: Screen = Object.freeze({ kind: 'hunting' })
const STATION: Screen = Object.freeze({ kind: 'station' })
const FOUND: Screen = Object.freeze({ kind: 'found' })
const FOUND_MIC_OFF: Screen = Object.freeze({ kind: 'found', micOff: true })
/** Direction scan closed (the only scan state outside the hunting screen). */
export const SCAN_CLOSED: ScanState = Object.freeze({ open: false, status: 'off', radar: null })
const NO_LOG: readonly LogEntry[] = Object.freeze([])
const NO_HISTORY: readonly HuntRecord[] = Object.freeze([])
const METER: HuntPanel = 'meter'

/** Longest a toast stays up, however long its text (audit item 14). */
export const TOAST_MAX_MS = 10_000
/** Toast time = TOAST_BASE_MS + TOAST_PER_CHAR_MS per character, capped at TOAST_MAX_MS. */
export const TOAST_BASE_MS = 2_000
export const TOAST_PER_CHAR_MS = 55

/** How long a toast with this text stays up: long enough to read, at most TOAST_MAX_MS. */
export function toastDurationMs(text: string): number {
  return Math.min(TOAST_MAX_MS, TOAST_BASE_MS + TOAST_PER_CHAR_MS * text.length)
}

/**
 * Station screen state before main reports anything (main replaces it with its own view right
 * after 'stationStart'), so the station screen can rely on stationMode being present there.
 */
export const STATION_INITIAL: StationModeView = Object.freeze({
  step: 'name',
  name: '',
  answerCode: null,
  f0Hz: null,
  level: 0,
  lastChirpDb: null,
  lastChirpAtMs: null,
  chirpsSent: 0,
  message: null,
  canScan: false,
})

/** Fresh state on the landing screen: mic level 0, no mic, lock, hunt, toast, log or pending dialogs. */
export function initialState(caps: Capabilities, settings: Settings, debug: boolean, nowMs: number): AppState {
  return {
    screen: IDLE,
    nowMs,
    settings,
    caps,
    mic: null,
    micLevel: 0,
    lock: null,
    hunt: null,
    toast: null,
    confirmStop: false,
    wakeLockFailed: false,
    debug,
    scan: SCAN_CLOSED,
    pending: null,
    panel: METER,
    log: NO_LOG,
    stations: null,
    stationMode: null,
    found: null,
    foundRecordId: null,
    history: NO_HISTORY,
  }
}

/**
 * Back to the landing screen, dropping the session (mic, lock, hunt, pending beep, log, station
 * view, Found it summary) but keeping settings, toast, past hunts and the stations view (main owns
 * the hub's lifetime and dispatches `stations: null` when it tears the hub down).
 */
function toIdle(state: AppState): AppState {
  return {
    ...state,
    screen: IDLE,
    mic: null,
    micLevel: 0,
    lock: null,
    hunt: null,
    confirmStop: false,
    scan: SCAN_CLOSED,
    pending: null,
    panel: METER,
    log: NO_LOG,
    stationMode: null,
    found: null,
    foundRecordId: null,
  }
}

/** Where a paused session came from; the locked banner is skipped on return (it resumes as hunting). */
function pausedFrom(screen: Screen): PausedFrom | null {
  switch (screen.kind) {
    case 'listening':
      return 'listening'
    case 'locked':
    case 'hunting':
      return 'hunting'
    default:
      return null
  }
}

/** The screen a paused session returns to; listening and locked restart their timers at nowMs. */
function resumeScreen(from: PausedFrom, nowMs: number): Screen {
  switch (from) {
    case 'listening':
      return { kind: 'listening', sinceMs: nowMs }
    case 'locked':
      return { kind: 'locked', sinceMs: nowMs }
    case 'hunting':
      return HUNTING
  }
}

function clamp01(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0 // NaN -> 0
}

/** At most `max` UTF-16 units, never splitting a surrogate pair (an emoji typed into a note). */
function truncate(text: string, max: number): string {
  const n = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0
  if (text.length <= n) return text
  const code = n > 0 ? text.charCodeAt(n - 1) : 0
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n)
}

/**
 * The Listening range a settings patch asks for, when it is a pair of numbers that makes a valid
 * band (normalizeBand; a string, null or boolean is not coerced); the current band otherwise, and
 * also when it asks for the band already set (same reference, so the reducer can tell that nothing
 * changed).
 */
function patchedBand(raw: unknown, current: readonly [number, number], cfg: Config): readonly [number, number] {
  if (!Array.isArray(raw) || raw.length !== 2) return current
  const [lo, hi] = raw as [unknown, unknown]
  if (typeof lo !== 'number' || typeof hi !== 'number') return current
  const band = normalizeBand(lo, hi, cfg)
  return band === null || sameBand(band, current) ? current : band
}

/**
 * Insert a log entry, or replace the entry with the same id in place, keeping its note (a merged
 * chirp group updates its reading). New entries are appended, so the log stays in arrival order
 * (oldest first) even when reading ids restart; the oldest entries are dropped beyond
 * cfg.logMaxEntries.
 */
function upsertLog(log: readonly LogEntry[], entry: LogEntry, cfg: Config): readonly LogEntry[] {
  const i = log.findIndex((e) => e.id === entry.id)
  if (i >= 0) {
    const old = log[i]!
    const copy = log.slice()
    copy[i] = old.note === entry.note ? entry : { ...entry, note: old.note }
    return copy
  }
  const max = Number.isFinite(cfg.logMaxEntries) ? Math.max(0, Math.floor(cfg.logMaxEntries)) : 0
  const appended = [...log, entry]
  return appended.length > max ? appended.slice(appended.length - max) : appended
}

/**
 * Pure transition function (see the table in docs/PLAN.md section 4 and the module header).
 * Returns `state` itself when the event does not apply or changes nothing.
 */
export function reduce(state: AppState, event: AppEvent, cfg: Config): AppState {
  const screen = state.screen
  switch (event.type) {
    case 'start':
      // New hunt on the Found it screen: a fresh session (main has torn the old one down).
      if (screen.kind === 'found') {
        return { ...toIdle(state), stations: null, nowMs: event.nowMs, screen: { kind: 'requesting', sinceMs: event.nowMs } }
      }
      if (screen.kind !== 'idle') return state
      return { ...state, nowMs: event.nowMs, screen: { kind: 'requesting', sinceMs: event.nowMs } }

    case 'micReady':
      if (screen.kind !== 'requesting') return state
      return {
        ...state,
        nowMs: event.nowMs,
        screen: { kind: 'listening', sinceMs: event.nowMs },
        mic: event.mic,
        lock: null,
        hunt: null,
        pending: null,
      }

    case 'micError':
      // Also from paused: re-acquiring the mic on resume can fail (permission revoked, device gone).
      if (screen.kind !== 'requesting' && screen.kind !== 'paused') return state
      return { ...toIdle(state), screen: { kind: 'error', code: event.code } }

    case 'lock':
      if (screen.kind !== 'listening') return state
      return {
        ...state,
        nowMs: event.nowMs,
        screen: { kind: 'locked', sinceMs: event.nowMs },
        lock: event.lock,
        pending: null,
      }

    case 'confirmLock':
      if (screen.kind !== 'locked') return state
      return { ...state, screen: HUNTING }

    case 'holdLock':
      if (screen.kind !== 'locked' || screen.held === true) return state
      return { ...state, screen: { ...screen, held: true } }

    case 'notIt':
      if (screen.kind !== 'locked') return state
      return {
        ...state,
        nowMs: event.nowMs,
        screen: { kind: 'listening', sinceMs: event.nowMs },
        lock: null,
        hunt: null,
        confirmStop: false,
        pending: null,
      }

    case 'hunt':
      if (screen.kind !== 'locked' && screen.kind !== 'hunting') return state
      if (event.view === state.hunt) return state
      return { ...state, hunt: event.view }

    case 'relisten':
      // The log is kept: listening again is part of the same search.
      if (screen.kind !== 'hunting') return state
      return {
        ...state,
        nowMs: event.nowMs,
        screen: { kind: 'listening', sinceMs: event.nowMs },
        lock: null,
        hunt: null,
        confirmStop: false,
        scan: SCAN_CLOSED,
        pending: null,
        panel: METER,
      }

    case 'resetBest':
      // main resets the hunt and dispatches the new view as a 'hunt' event.
      return state

    case 'stopRequest':
      switch (screen.kind) {
        case 'hunting':
          if (state.hunt !== null && state.hunt.readings.length >= cfg.stopConfirmMinReadings) {
            return state.confirmStop ? state : { ...state, confirmStop: true }
          }
          return toIdle(state)
        case 'requesting': // the Cancel button while the permission prompt is open
        case 'listening':
        case 'locked':
        case 'paused': // the way out when resuming keeps failing (e.g. iOS 'interrupted' during a call)
          return toIdle(state)
        default:
          return state
      }

    case 'stopConfirm':
      return state.confirmStop ? toIdle(state) : state

    case 'stopCancel':
      return state.confirmStop ? { ...state, confirmStop: false } : state

    case 'hidden': {
      const from = pausedFrom(screen)
      if (from === null) return state
      return { ...state, screen: { kind: 'paused', from, needsGesture: false } }
    }

    case 'visible':
      if (screen.kind !== 'paused') return state
      if (event.healthy) return { ...state, screen: resumeScreen(screen.from, state.nowMs) }
      if (screen.needsGesture) return state
      return { ...state, screen: { kind: 'paused', from: screen.from, needsGesture: true } }

    case 'micLost': {
      if (screen.kind === 'paused') {
        if (screen.needsGesture) return state
        return { ...state, screen: { kind: 'paused', from: screen.from, needsGesture: true } }
      }
      const from = pausedFrom(screen)
      if (from === null) return state
      return { ...state, screen: { kind: 'paused', from, needsGesture: true } }
    }

    case 'resumed':
      if (screen.kind !== 'paused') return state
      return { ...state, screen: resumeScreen(screen.from, state.nowMs) }

    case 'retry':
      if (screen.kind !== 'error') return state
      return { ...state, nowMs: event.nowMs, screen: { kind: 'requesting', sinceMs: event.nowMs } }

    case 'back':
      if (screen.kind !== 'error') return state
      return toIdle(state)

    case 'tick': {
      const nowMs = event.nowMs
      const micLevel = event.micLevel === undefined ? state.micLevel : clamp01(event.micLevel)
      const toast = state.toast !== null && state.toast.untilMs <= nowMs ? null : state.toast
      // A held banner (the user touched it) waits for Start hunting or Wrong sound.
      const next =
        screen.kind === 'locked' && screen.held !== true && nowMs - screen.sinceMs >= cfg.lockedBannerMs
          ? HUNTING
          : screen
      if (nowMs === state.nowMs && micLevel === state.micLevel && toast === state.toast && next === screen) {
        return state
      }
      return { ...state, nowMs, micLevel, toast, screen: next }
    }

    case 'toast':
      return {
        ...state,
        nowMs: event.nowMs,
        toast: { text: event.text, untilMs: event.nowMs + toastDurationMs(event.text) },
      }

    case 'settings': {
      // A toggle is merged only when it is a boolean and the Listening range only when it is a
      // valid band: a key present with the value undefined (possible from untyped callers despite
      // exactOptionalPropertyTypes) or a broken band must not wipe a setting.
      const cur = state.settings
      const clicks = typeof event.patch.clicks === 'boolean' ? event.patch.clicks : cur.clicks
      const haptics = typeof event.patch.haptics === 'boolean' ? event.patch.haptics : cur.haptics
      const bandHz = patchedBand(event.patch.bandHz, cur.bandHz, cfg)
      if (clicks === cur.clicks && haptics === cur.haptics && bandHz === cur.bandHz) return state
      return { ...state, settings: { clicks, haptics, bandHz } }
    }

    case 'wakeLockFailed':
      return state.wakeLockFailed ? state : { ...state, wakeLockFailed: true }

    case 'scanOpen':
      if (screen.kind !== 'hunting' || !state.caps.compass || state.scan.open) return state
      return { ...state, scan: { open: true, status: 'starting', radar: null } }

    case 'scanStatus':
      if (!state.scan.open || state.scan.status === event.status) return state
      return { ...state, scan: { ...state.scan, status: event.status } }

    case 'radar':
      if (!state.scan.open || state.scan.radar === event.view) return state
      return { ...state, scan: { ...state.scan, radar: event.view } }

    case 'scanClose':
      return state.scan.open ? { ...state, scan: SCAN_CLOSED } : state

    case 'pending':
      if (screen.kind !== 'listening' || event.pending === state.pending) return state
      return { ...state, pending: event.pending }

    case 'panel':
      // Choosing a panel neither opens nor closes the direction scan: main does that in onPanel.
      if (screen.kind !== 'hunting' || event.panel === state.panel) return state
      if (event.panel === 'direction' && !state.caps.compass) return state
      return { ...state, panel: event.panel }

    case 'logUpsert':
      if (screen.kind !== 'hunting' && screen.kind !== 'locked') return state
      return { ...state, log: upsertLog(state.log, event.entry, cfg) }

    case 'logNote': {
      const i = state.log.findIndex((e) => e.id === event.id)
      if (i < 0) return state
      const note = truncate(event.note, cfg.logNoteMaxLength)
      const old = state.log[i]!
      if (old.note === note) return state
      const log = state.log.slice()
      log[i] = { ...old, note }
      return { ...state, log }
    }

    case 'stations':
      return event.view === state.stations ? state : { ...state, stations: event.view }

    case 'stationStart':
      if (screen.kind !== 'idle') return state
      return { ...state, screen: STATION, stationMode: STATION_INITIAL }

    case 'stationView':
      if (screen.kind !== 'station' || event.view === state.stationMode) return state
      return { ...state, stationMode: event.view }

    case 'stationStop':
      if (screen.kind !== 'station') return state
      return toIdle(state)

    case 'found':
      // Lock, hunt, log, stations and the panel stay, so Keep hunting carries on where it left off.
      if (screen.kind !== 'hunting') return state
      return {
        ...state,
        screen: FOUND,
        found: event.summary,
        foundRecordId: event.recordId ?? null,
        confirmStop: false,
        scan: SCAN_CLOSED,
      }

    case 'keepHunting':
      if (screen.kind !== 'found') return state
      return { ...state, screen: HUNTING, found: null, foundRecordId: null }

    case 'history':
      return event.history === state.history ? state : { ...state, history: event.history }

    case 'foundDone':
      // The session is over, exactly like a confirmed Stop.
      if (screen.kind !== 'found') return state
      return toIdle(state)

    case 'foundMicOff':
      // Only the screen changes: the summary and the hunt stay for Keep hunting.
      if (screen.kind !== 'found' || screen.micOff === true) return state
      return { ...state, screen: FOUND_MIC_OFF }

    default:
      // Unknown event (only possible from untyped callers): leave the state alone.
      return state
  }
}

/** Minimal observable store around reduce. */
export interface Store {
  get(): AppState
  dispatch(event: AppEvent): void
  /** fn(state, prev) runs after every change; returns an unsubscribe function. */
  subscribe(fn: (state: AppState, prev: AppState) => void): () => void
}

/**
 * Store that notifies subscribers only when reduce returned a new object. Events dispatched from
 * inside a subscriber are queued and applied after the current notification round, in order, so
 * every subscriber sees each transition exactly once with a consistent (state, prev) pair.
 * A subscriber removed during a round is not called for the rest of it.
 * A throwing subscriber does not stop the others; the first error is re-thrown once the queue drains.
 * If reduce itself throws, the queued events are dropped (they were dispatched in a context that
 * no longer holds) and the store stays usable.
 */
export function createStore(initial: AppState, cfg: Config): Store {
  let state = initial
  const subscribers = new Set<(state: AppState, prev: AppState) => void>()
  const queue: AppEvent[] = []
  let draining = false

  function dispatch(event: AppEvent): void {
    queue.push(event)
    if (draining) return
    draining = true
    let failed = false
    let firstError: unknown = null
    try {
      for (let ev = queue.shift(); ev !== undefined; ev = queue.shift()) {
        const prev = state
        const next = reduce(prev, ev, cfg)
        if (next === prev) continue
        state = next
        for (const fn of Array.from(subscribers)) {
          if (!subscribers.has(fn)) continue
          try {
            fn(next, prev)
          } catch (err) {
            if (!failed) {
              failed = true
              firstError = err
            }
          }
        }
      }
    } finally {
      queue.length = 0
      draining = false
    }
    if (failed) throw firstError
  }

  return {
    get: () => state,
    dispatch,
    subscribe(fn) {
      subscribers.add(fn)
      return () => {
        subscribers.delete(fn)
      }
    },
  }
}
