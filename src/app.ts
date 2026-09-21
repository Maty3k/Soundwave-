/**
 * App state machine: a pure reducer over AppState plus a tiny store. No DOM, no audio.
 *
 * Screens: idle -> requesting -> listening -> locked (banner) -> hunting, with paused and error
 * branches. Events that do not apply to the current screen return the SAME state object, so the
 * store (and anything comparing references) can skip work. Times are ms on the caller's clock
 * (performance.now() in the app); events that carry nowMs also advance state.nowMs.
 */
import type { Config } from './config.ts'
import type { AppEvent, AppState, Capabilities, PausedFrom, ScanState, Screen, Settings } from './types.ts'

const IDLE: Screen = Object.freeze({ kind: 'idle' })
const HUNTING: Screen = Object.freeze({ kind: 'hunting' })
/** Direction scan closed (the only scan state outside the hunting screen). */
export const SCAN_CLOSED: ScanState = Object.freeze({ open: false, status: 'off', radar: null })

/** Fresh state on the landing screen: mic level 0, no mic, lock, hunt, toast or pending dialogs. */
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
  }
}

/** Back to the landing screen, dropping the session (mic, lock, hunt) but keeping settings and toast. */
function toIdle(state: AppState): AppState {
  return { ...state, screen: IDLE, mic: null, micLevel: 0, lock: null, hunt: null, confirmStop: false, scan: SCAN_CLOSED }
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

/**
 * Pure transition function (see the table in docs/PLAN.md section 4 and the module header).
 * Returns `state` itself when the event does not apply or changes nothing.
 */
export function reduce(state: AppState, event: AppEvent, cfg: Config): AppState {
  const screen = state.screen
  switch (event.type) {
    case 'start':
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
      }

    case 'micError':
      // Also from paused: re-acquiring the mic on resume can fail (permission revoked, device gone).
      if (screen.kind !== 'requesting' && screen.kind !== 'paused') return state
      return { ...toIdle(state), screen: { kind: 'error', code: event.code } }

    case 'lock':
      if (screen.kind !== 'listening') return state
      return { ...state, nowMs: event.nowMs, screen: { kind: 'locked', sinceMs: event.nowMs }, lock: event.lock }

    case 'confirmLock':
      if (screen.kind !== 'locked') return state
      return { ...state, screen: HUNTING }

    case 'notIt':
      if (screen.kind !== 'locked') return state
      return {
        ...state,
        nowMs: event.nowMs,
        screen: { kind: 'listening', sinceMs: event.nowMs },
        lock: null,
        hunt: null,
        confirmStop: false,
      }

    case 'hunt':
      if (screen.kind !== 'locked' && screen.kind !== 'hunting') return state
      if (event.view === state.hunt) return state
      return { ...state, hunt: event.view }

    case 'relisten':
      if (screen.kind !== 'hunting') return state
      return {
        ...state,
        nowMs: event.nowMs,
        screen: { kind: 'listening', sinceMs: event.nowMs },
        lock: null,
        hunt: null,
        confirmStop: false,
        scan: SCAN_CLOSED,
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
      const next =
        screen.kind === 'locked' && nowMs - screen.sinceMs >= cfg.lockedBannerMs ? HUNTING : screen
      if (nowMs === state.nowMs && micLevel === state.micLevel && toast === state.toast && next === screen) {
        return state
      }
      return { ...state, nowMs, micLevel, toast, screen: next }
    }

    case 'toast':
      return { ...state, nowMs: event.nowMs, toast: { text: event.text, untilMs: event.nowMs + cfg.toastMs } }

    case 'settings': {
      // Only boolean fields are merged: a key present with the value undefined (possible from
      // untyped callers despite exactOptionalPropertyTypes) must not wipe a setting.
      const clicks = typeof event.patch.clicks === 'boolean' ? event.patch.clicks : state.settings.clicks
      const haptics = typeof event.patch.haptics === 'boolean' ? event.patch.haptics : state.settings.haptics
      if (clicks === state.settings.clicks && haptics === state.settings.haptics) return state
      return { ...state, settings: { ...state.settings, clicks, haptics } }
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
