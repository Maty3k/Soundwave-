import { describe, expect, it } from 'vitest'
import { createStore, initialState, reduce, SCAN_CLOSED } from './app.ts'
import { CONFIG, withConfig } from './config.ts'
import type {
  AppEvent,
  AppState,
  Capabilities,
  HuntView,
  Lock,
  MicDiag,
  RadarView,
  Reading,
  Screen,
  Settings,
} from './types.ts'

// ---- Hand-built fixtures -------------------------------------------------------------------------

const CAPS: Capabilities = { secureContext: true, getUserMedia: true, audioContext: true, wakeLock: true, haptics: false, compass: true }
const SETTINGS: Settings = { clicks: true, haptics: true }
const T0 = 1_000
const NOW = 50_000

const MIC: MicDiag = {
  echoCancellation: 'off',
  noiseSuppression: 'off',
  autoGainControl: 'off',
  rawAudio: 'raw',
  deviceLabel: 'Test microphone',
  trackSampleRate: 48000,
  contextSampleRate: 48000,
  channelCount: 1,
}

const LOCK: Lock = { f0Hz: 3120, mode: 'chirp', reason: 'fast', tMs: 40_000, snrDb: 32, chirps: [] }

function reading(id: number): Reading {
  return {
    id,
    tMs: 40_000 + id * 30_000,
    levelDb: -60 + id,
    snrDb: 30,
    verdict: id === 0 ? 'first' : 'warmer',
    deltaPrevDb: id === 0 ? null : 1,
    pct: id === 0 ? null : 50,
    isNewBest: id > 0,
    clipped: false,
    chirpCount: 1,
    missedBefore: 0,
    source: 'chirp',
  }
}

/** Chirp-mode hunt view with `n` readings. */
function huntView(n: number): HuntView {
  const readings = Array.from({ length: n }, (_, i) => reading(i))
  return {
    mode: 'chirp',
    f0Hz: 3120,
    readings,
    last: readings[n - 1] ?? null,
    bestDb: n > 0 ? -60 + n - 1 : null,
    warmth: n >= 2 ? 0.5 : null,
    countdown: { kind: 'unknown', etaS: null, sinceLastS: null, intervalS: null, confident: false },
    holdActive: false,
    hearing: false,
    live: null,
    levelDb: -95,
    bandFloorDb: -96,
    snrDb: 1,
    missedChirps: 0,
    chirps: [],
  }
}

const HUNT1 = huntView(1)
const HUNT_BELOW = huntView(CONFIG.stopConfirmMinReadings - 1)
const HUNT_AT = huntView(CONFIG.stopConfirmMinReadings)

const BASE = initialState(CAPS, SETTINGS, false, NOW)

/** A state on the given screen with session data consistent with it. */
function on(screen: Screen, patch: Partial<AppState> = {}): AppState {
  const phase = screen.kind === 'paused' ? screen.from : screen.kind
  const session: Partial<AppState> =
    phase === 'idle' || phase === 'requesting' || phase === 'error'
      ? {}
      : phase === 'listening'
        ? { mic: MIC, micLevel: 0.4 }
        : { mic: MIC, micLevel: 0.4, lock: LOCK, hunt: HUNT1 }
  return { ...BASE, ...session, ...patch, screen }
}

const S = {
  idle: { kind: 'idle' },
  requesting: { kind: 'requesting', sinceMs: T0 },
  listening: { kind: 'listening', sinceMs: T0 },
  locked: { kind: 'locked', sinceMs: T0 },
  hunting: { kind: 'hunting' },
  pausedListening: { kind: 'paused', from: 'listening', needsGesture: false },
  pausedHunting: { kind: 'paused', from: 'hunting', needsGesture: false },
  pausedLocked: { kind: 'paused', from: 'locked', needsGesture: false },
  pausedGesture: { kind: 'paused', from: 'hunting', needsGesture: true },
  error: { kind: 'error', code: 'permission' },
} as const satisfies Record<string, Screen>

const T1 = NOW + 7_000
const V2 = huntView(2)

/** Session fields reset by stop / back. */
const CLEARED: Partial<AppState> = { mic: null, lock: null, hunt: null, micLevel: 0, confirmStop: false }

// ---- Transition table ----------------------------------------------------------------------------

interface Row {
  readonly name: string
  readonly from: AppState
  readonly event: AppEvent
  /** Fields that change; everything else must be carried over unchanged. */
  readonly expect: Partial<AppState>
}

const TABLE: readonly Row[] = [
  { name: 'idle --start--> requesting', from: on(S.idle), event: { type: 'start', nowMs: T1 },
    expect: { nowMs: T1, screen: { kind: 'requesting', sinceMs: T1 } } },
  { name: 'requesting --micReady--> listening with the mic', from: on(S.requesting), event: { type: 'micReady', mic: MIC, nowMs: T1 },
    expect: { nowMs: T1, screen: { kind: 'listening', sinceMs: T1 }, mic: MIC } },
  ...(['permission', 'noMic', 'busy', 'unsupported'] as const).map((code): Row => ({
    name: `requesting --micError(${code})--> error`, from: on(S.requesting), event: { type: 'micError', code },
    expect: { screen: { kind: 'error', code } },
  })),
  { name: 'listening --lock--> locked with the lock', from: on(S.listening), event: { type: 'lock', lock: LOCK, nowMs: T1 },
    expect: { nowMs: T1, screen: { kind: 'locked', sinceMs: T1 }, lock: LOCK } },
  { name: 'locked --confirmLock--> hunting', from: on(S.locked), event: { type: 'confirmLock' },
    expect: { screen: { kind: 'hunting' } } },
  { name: 'locked --notIt--> listening without lock or hunt', from: on(S.locked), event: { type: 'notIt', nowMs: T1 },
    expect: { nowMs: T1, screen: { kind: 'listening', sinceMs: T1 }, lock: null, hunt: null } },
  { name: 'locked --hunt--> locked with the new view', from: on(S.locked), event: { type: 'hunt', view: V2 },
    expect: { hunt: V2 } },
  { name: 'hunting --hunt--> hunting with the new view', from: on(S.hunting), event: { type: 'hunt', view: V2 },
    expect: { hunt: V2 } },
  { name: 'hunting --relisten--> listening without lock or hunt', from: on(S.hunting), event: { type: 'relisten', nowMs: T1 },
    expect: { nowMs: T1, screen: { kind: 'listening', sinceMs: T1 }, lock: null, hunt: null } },
  { name: 'requesting --stopRequest (Cancel)--> idle', from: on(S.requesting), event: { type: 'stopRequest' },
    expect: { ...CLEARED, screen: { kind: 'idle' } } },
  { name: 'listening --stopRequest--> idle', from: on(S.listening), event: { type: 'stopRequest' },
    expect: { ...CLEARED, screen: { kind: 'idle' } } },
  { name: 'locked --stopRequest--> idle even with many readings', from: on(S.locked, { hunt: HUNT_AT }), event: { type: 'stopRequest' },
    expect: { ...CLEARED, screen: { kind: 'idle' } } },
  { name: 'hunting --stopRequest--> idle below the confirm threshold', from: on(S.hunting, { hunt: HUNT_BELOW }), event: { type: 'stopRequest' },
    expect: { ...CLEARED, screen: { kind: 'idle' } } },
  { name: 'hunting --stopRequest--> idle without a hunt view', from: on(S.hunting, { hunt: null }), event: { type: 'stopRequest' },
    expect: { ...CLEARED, screen: { kind: 'idle' } } },
  { name: 'hunting --stopRequest--> confirmStop at the confirm threshold', from: on(S.hunting, { hunt: HUNT_AT }), event: { type: 'stopRequest' },
    expect: { confirmStop: true } },
  { name: 'confirmStop --stopConfirm--> idle', from: on(S.hunting, { hunt: HUNT_AT, confirmStop: true }), event: { type: 'stopConfirm' },
    expect: { ...CLEARED, screen: { kind: 'idle' } } },
  { name: 'confirmStop --stopCancel--> keeps hunting', from: on(S.hunting, { hunt: HUNT_AT, confirmStop: true }), event: { type: 'stopCancel' },
    expect: { confirmStop: false } },
  { name: 'listening --hidden--> paused from listening', from: on(S.listening), event: { type: 'hidden' },
    expect: { screen: { kind: 'paused', from: 'listening', needsGesture: false } } },
  { name: 'locked --hidden--> paused from hunting (banner skipped)', from: on(S.locked), event: { type: 'hidden' },
    expect: { screen: { kind: 'paused', from: 'hunting', needsGesture: false } } },
  { name: 'hunting --hidden--> paused from hunting', from: on(S.hunting), event: { type: 'hidden' },
    expect: { screen: { kind: 'paused', from: 'hunting', needsGesture: false } } },
  { name: 'paused(listening) --visible healthy--> listening restarted at nowMs', from: on(S.pausedListening), event: { type: 'visible', healthy: true },
    expect: { screen: { kind: 'listening', sinceMs: NOW } } },
  { name: 'paused(hunting) --visible healthy--> hunting', from: on(S.pausedHunting), event: { type: 'visible', healthy: true },
    expect: { screen: { kind: 'hunting' } } },
  { name: 'paused(locked) --visible healthy--> locked restarted at nowMs', from: on(S.pausedLocked), event: { type: 'visible', healthy: true },
    expect: { screen: { kind: 'locked', sinceMs: NOW } } },
  { name: 'paused(gesture) --visible healthy--> hunting', from: on(S.pausedGesture), event: { type: 'visible', healthy: true },
    expect: { screen: { kind: 'hunting' } } },
  { name: 'paused --visible unhealthy--> paused needing a gesture', from: on(S.pausedListening), event: { type: 'visible', healthy: false },
    expect: { screen: { kind: 'paused', from: 'listening', needsGesture: true } } },
  { name: 'listening --micLost--> paused needing a gesture', from: on(S.listening), event: { type: 'micLost' },
    expect: { screen: { kind: 'paused', from: 'listening', needsGesture: true } } },
  { name: 'locked --micLost--> paused(hunting) needing a gesture', from: on(S.locked), event: { type: 'micLost' },
    expect: { screen: { kind: 'paused', from: 'hunting', needsGesture: true } } },
  { name: 'hunting --micLost--> paused needing a gesture', from: on(S.hunting), event: { type: 'micLost' },
    expect: { screen: { kind: 'paused', from: 'hunting', needsGesture: true } } },
  { name: 'paused --micLost--> needs a gesture, keeps from', from: on(S.pausedListening), event: { type: 'micLost' },
    expect: { screen: { kind: 'paused', from: 'listening', needsGesture: true } } },
  { name: 'paused(listening) --resumed--> listening restarted at nowMs', from: on({ kind: 'paused', from: 'listening', needsGesture: true }), event: { type: 'resumed' },
    expect: { screen: { kind: 'listening', sinceMs: NOW } } },
  { name: 'paused(hunting) --resumed--> hunting keeping lock and hunt', from: on(S.pausedGesture), event: { type: 'resumed' },
    expect: { screen: { kind: 'hunting' } } },
  { name: 'paused --micError--> error (re-acquire failed), closing an open confirm', from: on(S.pausedGesture, { hunt: HUNT_AT, confirmStop: true }),
    event: { type: 'micError', code: 'noMic' },
    expect: { ...CLEARED, screen: { kind: 'error', code: 'noMic' } } },
  { name: 'error --retry--> requesting', from: on(S.error), event: { type: 'retry', nowMs: T1 },
    expect: { nowMs: T1, screen: { kind: 'requesting', sinceMs: T1 } } },
  { name: 'error --back--> idle', from: on(S.error), event: { type: 'back' },
    expect: { ...CLEARED, screen: { kind: 'idle' } } },
  { name: 'tick updates nowMs and micLevel', from: on(S.listening), event: { type: 'tick', nowMs: T1, micLevel: 0.7 },
    expect: { nowMs: T1, micLevel: 0.7 } },
  { name: 'tick without micLevel keeps the mic level', from: on(S.listening), event: { type: 'tick', nowMs: T1 },
    expect: { nowMs: T1 } },
  { name: 'tick clamps the mic level to 0..1', from: on(S.listening), event: { type: 'tick', nowMs: T1, micLevel: 1.8 },
    expect: { nowMs: T1, micLevel: 1 } },
  { name: 'tick maps a NaN mic level to 0', from: on(S.listening), event: { type: 'tick', nowMs: T1, micLevel: Number.NaN },
    expect: { nowMs: T1, micLevel: 0 } },
  { name: 'toast shows for toastMs', from: on(S.hunting), event: { type: 'toast', text: 'Back to chirp mode.', nowMs: T1 },
    expect: { nowMs: T1, toast: { text: 'Back to chirp mode.', untilMs: T1 + CONFIG.toastMs } } },
  { name: 'toast replaces a visible toast', from: on(S.idle, { toast: { text: 'old', untilMs: T1 + 1 } }), event: { type: 'toast', text: 'new', nowMs: T1 },
    expect: { nowMs: T1, toast: { text: 'new', untilMs: T1 + CONFIG.toastMs } } },
  { name: 'settings patch is merged', from: on(S.hunting), event: { type: 'settings', patch: { clicks: false } },
    expect: { settings: { clicks: false, haptics: true } } },
  { name: 'wakeLockFailed sets the flag', from: on(S.hunting), event: { type: 'wakeLockFailed' },
    expect: { wakeLockFailed: true } },
]

describe('reduce: transition table', () => {
  it.each(TABLE.map((r) => [r.name, r] as const))('%s', (_name, row) => {
    const before = structuredClone(row.from)
    const next = reduce(row.from, row.event, CONFIG)
    expect(next).not.toBe(row.from)
    expect(next).toEqual({ ...row.from, ...row.expect })
    expect(row.from).toEqual(before) // never mutates its input
  })

  it('keeps settings, caps, debug, toast and wakeLockFailed across a stop', () => {
    const toast = { text: 'hi', untilMs: NOW + 100 }
    const from = on(S.listening, { debug: true, toast, wakeLockFailed: true, settings: { clicks: false, haptics: true } })
    const next = reduce(from, { type: 'stopRequest' }, CONFIG)
    expect(next.settings).toBe(from.settings)
    expect(next.caps).toBe(from.caps)
    expect(next.debug).toBe(true)
    expect(next.toast).toBe(toast)
    expect(next.wakeLockFailed).toBe(true)
  })

  it('walks a whole session: start, allow, lock, banner, hunt, hide, resume, stop with confirm', () => {
    let s = initialState(CAPS, SETTINGS, false, 0)
    const step = (e: AppEvent) => (s = reduce(s, e, CONFIG))
    step({ type: 'start', nowMs: 10 })
    step({ type: 'micReady', mic: MIC, nowMs: 500 })
    step({ type: 'lock', lock: LOCK, nowMs: 30_000 })
    step({ type: 'hunt', view: huntView(1) })
    step({ type: 'tick', nowMs: 30_000 + CONFIG.lockedBannerMs })
    expect(s.screen).toEqual({ kind: 'hunting' })
    step({ type: 'hunt', view: HUNT_AT })
    step({ type: 'hidden' })
    step({ type: 'visible', healthy: false })
    expect(s.screen).toEqual({ kind: 'paused', from: 'hunting', needsGesture: true })
    step({ type: 'resumed' })
    expect(s.screen).toEqual({ kind: 'hunting' })
    expect(s.lock).toBe(LOCK)
    expect(s.hunt).toBe(HUNT_AT)
    step({ type: 'stopRequest' })
    expect(s.confirmStop).toBe(true)
    expect(s.screen.kind).toBe('hunting')
    step({ type: 'stopConfirm' })
    expect(s).toEqual({ ...initialState(CAPS, SETTINGS, false, 30_000 + CONFIG.lockedBannerMs) })
  })
})

// ---- Unchanged reference for inapplicable events -------------------------------------------------

const SCREEN_EVENTS: readonly AppEvent[] = [
  { type: 'start', nowMs: T1 },
  { type: 'micReady', mic: MIC, nowMs: T1 },
  { type: 'micError', code: 'busy' },
  { type: 'lock', lock: LOCK, nowMs: T1 },
  { type: 'confirmLock' },
  { type: 'notIt', nowMs: T1 },
  { type: 'hunt', view: V2 },
  { type: 'relisten', nowMs: T1 },
  { type: 'resetBest' },
  { type: 'stopRequest' },
  { type: 'stopConfirm' },
  { type: 'stopCancel' },
  { type: 'hidden' },
  { type: 'visible', healthy: true },
  { type: 'visible', healthy: false },
  { type: 'micLost' },
  { type: 'resumed' },
  { type: 'retry', nowMs: T1 },
  { type: 'back' },
]

/** Event labels ('visible' split by health) that change each fixture; all others must be no-ops. */
const APPLIES: ReadonlyArray<readonly [string, AppState, readonly string[]]> = [
  ['idle', on(S.idle), ['start']],
  ['requesting', on(S.requesting), ['micReady', 'micError', 'stopRequest']],
  ['listening', on(S.listening), ['lock', 'stopRequest', 'hidden', 'micLost']],
  ['locked', on(S.locked), ['confirmLock', 'notIt', 'hunt', 'stopRequest', 'hidden', 'micLost']],
  ['hunting', on(S.hunting), ['hunt', 'relisten', 'stopRequest', 'hidden', 'micLost']],
  ['hunting, confirm open', on(S.hunting, { hunt: HUNT_AT, confirmStop: true }),
    ['hunt', 'relisten', 'stopConfirm', 'stopCancel', 'hidden', 'micLost']],
  ['paused', on(S.pausedHunting), ['micError', 'visible:healthy', 'visible:unhealthy', 'micLost', 'resumed', 'stopRequest']],
  ['paused, needs gesture', on(S.pausedGesture), ['micError', 'visible:healthy', 'resumed', 'stopRequest']],
  ['error', on(S.error), ['retry', 'back']],
]

function label(e: AppEvent): string {
  return e.type === 'visible' ? `visible:${e.healthy ? 'healthy' : 'unhealthy'}` : e.type
}

describe('reduce: events that do not apply return the same object', () => {
  it('the table only names events that are exercised (no typos that would pass silently)', () => {
    const known = new Set(SCREEN_EVENTS.map(label))
    for (const [, , applies] of APPLIES) for (const a of applies) expect(known, a).toContain(a)
  })

  for (const [name, state, applies] of APPLIES) {
    it(`on ${name}`, () => {
      for (const event of SCREEN_EVENTS) {
        const next = reduce(state, event, CONFIG)
        if (applies.includes(label(event))) expect(next, label(event)).not.toBe(state)
        else expect(next, label(event)).toBe(state)
      }
    })
  }

  it('an unknown event type leaves the state alone', () => {
    const s = on(S.hunting)
    expect(reduce(s, { type: 'bogus' } as unknown as AppEvent, CONFIG)).toBe(s)
  })

  it('resetBest never changes state (main dispatches the new view)', () => {
    const s = on(S.hunting)
    expect(reduce(s, { type: 'resetBest' }, CONFIG)).toBe(s)
  })

  it('a hunt event carrying the current view is a no-op', () => {
    const s = on(S.hunting)
    expect(reduce(s, { type: 'hunt', view: s.hunt! }, CONFIG)).toBe(s)
  })

  it('a repeated stopRequest while the confirm is open is a no-op', () => {
    const s = on(S.hunting, { hunt: HUNT_AT, confirmStop: true })
    expect(reduce(s, { type: 'stopRequest' }, CONFIG)).toBe(s)
  })

  it('a tick at the same time with the same level is a no-op', () => {
    const s = on(S.listening)
    expect(reduce(s, { type: 'tick', nowMs: s.nowMs }, CONFIG)).toBe(s)
    expect(reduce(s, { type: 'tick', nowMs: s.nowMs, micLevel: s.micLevel }, CONFIG)).toBe(s)
  })

  it('settings that match the current ones and a repeated wakeLockFailed are no-ops', () => {
    const s = on(S.hunting, { wakeLockFailed: true })
    expect(reduce(s, { type: 'settings', patch: { clicks: true } }, CONFIG)).toBe(s)
    expect(reduce(s, { type: 'settings', patch: {} }, CONFIG)).toBe(s)
    expect(reduce(s, { type: 'wakeLockFailed' }, CONFIG)).toBe(s)
  })
})

// ---- Stop-confirm threshold ----------------------------------------------------------------------

describe('reduce: stop confirmation threshold', () => {
  it('asks for confirmation from exactly stopConfirmMinReadings readings', () => {
    const min = CONFIG.stopConfirmMinReadings
    for (let n = 0; n <= min + 2; n++) {
      const next = reduce(on(S.hunting, { hunt: huntView(n) }), { type: 'stopRequest' }, CONFIG)
      if (n >= min) {
        expect(next.confirmStop, `n=${n}`).toBe(true)
        expect(next.screen.kind).toBe('hunting')
      } else {
        expect(next.confirmStop, `n=${n}`).toBe(false)
        expect(next.screen.kind).toBe('idle')
      }
    }
  })

  it('follows the configured threshold', () => {
    const cfg = withConfig({ stopConfirmMinReadings: 1 })
    expect(reduce(on(S.hunting, { hunt: huntView(1) }), { type: 'stopRequest' }, cfg).confirmStop).toBe(true)
    expect(reduce(on(S.hunting, { hunt: huntView(0) }), { type: 'stopRequest' }, cfg).screen.kind).toBe('idle')
  })

  it('stopConfirm and stopCancel do nothing without an open confirm', () => {
    const s = on(S.hunting, { hunt: HUNT_AT })
    expect(reduce(s, { type: 'stopConfirm' }, CONFIG)).toBe(s)
    expect(reduce(s, { type: 'stopCancel' }, CONFIG)).toBe(s)
  })
})

// ---- Timers: locked auto-advance and toast expiry ------------------------------------------------

describe('reduce: tick timers', () => {
  it('advances the locked banner to hunting once lockedBannerMs has passed', () => {
    const s = on(S.locked)
    const justBefore = reduce(s, { type: 'tick', nowMs: T0 + CONFIG.lockedBannerMs - 1 }, CONFIG)
    expect(justBefore.screen).toBe(s.screen)
    const atLimit = reduce(justBefore, { type: 'tick', nowMs: T0 + CONFIG.lockedBannerMs }, CONFIG)
    expect(atLimit.screen).toEqual({ kind: 'hunting' })
    expect(atLimit.lock).toBe(s.lock)
    expect(atLimit.hunt).toBe(s.hunt)
  })

  it('uses the configured banner duration', () => {
    const cfg = withConfig({ lockedBannerMs: 5_000 })
    const s = on(S.locked)
    expect(reduce(s, { type: 'tick', nowMs: T0 + 4_999 }, cfg).screen.kind).toBe('locked')
    expect(reduce(s, { type: 'tick', nowMs: T0 + 5_000 }, cfg).screen.kind).toBe('hunting')
  })

  it('does not advance other screens', () => {
    for (const screen of [S.listening, S.requesting, S.pausedHunting]) {
      const s = on(screen)
      expect(reduce(s, { type: 'tick', nowMs: T0 + 10 * CONFIG.lockedBannerMs }, CONFIG).screen).toBe(s.screen)
    }
  })

  it('clears a toast when untilMs <= nowMs and keeps it before', () => {
    let s = reduce(on(S.hunting), { type: 'toast', text: 'Back to chirp mode.', nowMs: T1 }, CONFIG)
    const until = T1 + CONFIG.toastMs
    s = reduce(s, { type: 'tick', nowMs: until - 1 }, CONFIG)
    expect(s.toast).toEqual({ text: 'Back to chirp mode.', untilMs: until })
    s = reduce(s, { type: 'tick', nowMs: until }, CONFIG)
    expect(s.toast).toBeNull()
  })

  it('uses the configured toast duration', () => {
    const cfg = withConfig({ toastMs: 1_000 })
    const s = reduce(on(S.idle), { type: 'toast', text: 'x', nowMs: T1 }, cfg)
    expect(s.toast?.untilMs).toBe(T1 + 1_000)
  })

  it('expires a toast and advances the banner in the same tick', () => {
    const s = on(S.locked, { toast: { text: 'x', untilMs: T0 + 10 } })
    const next = reduce(s, { type: 'tick', nowMs: T0 + CONFIG.lockedBannerMs, micLevel: -0.5 }, CONFIG)
    expect(next.screen).toEqual({ kind: 'hunting' })
    expect(next.toast).toBeNull()
    expect(next.micLevel).toBe(0) // negative levels clamp to 0
  })

  it('advances a banner restored from a pause once lockedBannerMs has passed again', () => {
    const resumed = reduce(on(S.pausedLocked), { type: 'resumed' }, CONFIG)
    expect(resumed.screen).toEqual({ kind: 'locked', sinceMs: NOW })
    expect(reduce(resumed, { type: 'tick', nowMs: NOW + CONFIG.lockedBannerMs - 1 }, CONFIG).screen.kind).toBe('locked')
    expect(reduce(resumed, { type: 'tick', nowMs: NOW + CONFIG.lockedBannerMs }, CONFIG).screen.kind).toBe('hunting')
  })
})

// ---- Events that apply on every screen -----------------------------------------------------------

describe('reduce: tick, toast, settings and wakeLockFailed apply on every screen', () => {
  for (const [name, state] of APPLIES) {
    it(`on ${name}`, () => {
      const tick = reduce(state, { type: 'tick', nowMs: state.nowMs + 16, micLevel: 0.25 }, CONFIG)
      expect(tick.nowMs).toBe(state.nowMs + 16)
      expect(tick.micLevel).toBe(0.25)

      const toast = reduce(state, { type: 'toast', text: 'hello', nowMs: T1 }, CONFIG)
      expect(toast.toast).toEqual({ text: 'hello', untilMs: T1 + CONFIG.toastMs })
      expect(toast.screen).toBe(state.screen)

      const settings = reduce(state, { type: 'settings', patch: { haptics: !state.settings.haptics } }, CONFIG)
      expect(settings.settings).toEqual({ ...state.settings, haptics: !state.settings.haptics })
      expect(settings.screen).toBe(state.screen)

      const wake = reduce(state, { type: 'wakeLockFailed' }, CONFIG)
      expect(wake).toEqual({ ...state, wakeLockFailed: true })
    })
  }
})

describe('reduce: settings', () => {
  it('merges both toggles at once', () => {
    const next = reduce(on(S.hunting), { type: 'settings', patch: { clicks: false, haptics: false } }, CONFIG)
    expect(next.settings).toEqual({ clicks: false, haptics: false })
  })

  it('never wipes a setting with a key that is present but undefined (untyped callers)', () => {
    const patch = { clicks: undefined, haptics: false } as unknown as Partial<Settings>
    const next = reduce(on(S.hunting), { type: 'settings', patch }, CONFIG)
    expect(next.settings).toEqual({ clicks: SETTINGS.clicks, haptics: false })
    const onlyUndefined = on(S.hunting)
    expect(reduce(onlyUndefined, { type: 'settings', patch: { clicks: undefined } as unknown as Partial<Settings> }, CONFIG))
      .toBe(onlyUndefined)
  })
})

// ---- The stop confirmation across a pause ------------------------------------------------------

describe('reduce: an open stop confirmation survives a pause', () => {
  const open = on(S.hunting, { hunt: HUNT_AT, confirmStop: true })

  it('stays open when the page is hidden or the mic is lost, and comes back with the hunt', () => {
    const hidden = reduce(open, { type: 'hidden' }, CONFIG)
    expect(hidden.screen).toEqual({ kind: 'paused', from: 'hunting', needsGesture: false })
    expect(hidden.confirmStop).toBe(true)
    const back = reduce(hidden, { type: 'visible', healthy: true }, CONFIG)
    expect(back.screen).toEqual({ kind: 'hunting' })
    expect(back.confirmStop).toBe(true)
    expect(reduce(open, { type: 'micLost' }, CONFIG).confirmStop).toBe(true)
  })

  it('can be answered while paused: Stop ends the session, Keep going keeps the pause', () => {
    const paused = reduce(open, { type: 'micLost' }, CONFIG)
    const stopped = reduce(paused, { type: 'stopConfirm' }, CONFIG)
    expect(stopped).toEqual({ ...paused, ...CLEARED, screen: { kind: 'idle' } })
    const kept = reduce(paused, { type: 'stopCancel' }, CONFIG)
    expect(kept).toEqual({ ...paused, confirmStop: false })
  })
})

// ---- Store ---------------------------------------------------------------------------------------

describe('reduce: paused screen way out', () => {
  it('stopRequest on a paused screen (either kind) returns to idle and drops the session', () => {
    for (const screen of [S.pausedHunting, S.pausedGesture, S.pausedListening]) {
      const next = reduce(on(screen), { type: 'stopRequest' }, CONFIG)
      expect(next.screen).toEqual({ kind: 'idle' })
      expect(next.mic).toBeNull()
      expect(next.hunt).toBeNull()
      expect(next.scan).toBe(SCAN_CLOSED)
    }
  })
})

describe('reduce: direction scan', () => {
  const RADAR: RadarView = {
    mode: 'chirp',
    sectors: [],
    bearingDeg: null,
    contrastDb: null,
    quality: 'needMore',
    samples: 0,
    maxGapDeg: null,
    suggestDeg: null,
    headingDeg: 12,
  }
  const OPEN = { open: true, status: 'active', radar: RADAR } as const

  it('starts closed', () => {
    expect(BASE.scan).toBe(SCAN_CLOSED)
    expect(SCAN_CLOSED).toEqual({ open: false, status: 'off', radar: null })
  })

  it('scanOpen only on the hunting screen with a compass, and only once', () => {
    const opened = reduce(on(S.hunting), { type: 'scanOpen' }, CONFIG)
    expect(opened.scan).toEqual({ open: true, status: 'starting', radar: null })
    expect(reduce(opened, { type: 'scanOpen' }, CONFIG)).toBe(opened)
    for (const screen of [S.idle, S.listening, S.locked, S.pausedHunting]) {
      const s = on(screen)
      expect(reduce(s, { type: 'scanOpen' }, CONFIG)).toBe(s)
    }
    const noCompass = on(S.hunting, { caps: { ...CAPS, compass: false } })
    expect(reduce(noCompass, { type: 'scanOpen' }, CONFIG)).toBe(noCompass)
  })

  it('scanStatus and radar update an open scan and are ignored when closed', () => {
    const opened = reduce(on(S.hunting), { type: 'scanOpen' }, CONFIG)
    const active = reduce(opened, { type: 'scanStatus', status: 'active' }, CONFIG)
    expect(active.scan.status).toBe('active')
    expect(reduce(active, { type: 'scanStatus', status: 'active' }, CONFIG)).toBe(active)
    const withRadar = reduce(active, { type: 'radar', view: RADAR }, CONFIG)
    expect(withRadar.scan.radar).toBe(RADAR)
    expect(reduce(withRadar, { type: 'radar', view: RADAR }, CONFIG)).toBe(withRadar)
    const unavailable = reduce(opened, { type: 'scanStatus', status: 'unavailable' }, CONFIG)
    expect(unavailable.scan).toEqual({ open: true, status: 'unavailable', radar: null })

    const closed = on(S.hunting)
    expect(reduce(closed, { type: 'scanStatus', status: 'active' }, CONFIG)).toBe(closed)
    expect(reduce(closed, { type: 'radar', view: RADAR }, CONFIG)).toBe(closed)
  })

  it('scanClose closes an open scan; closing a closed scan is a no-op', () => {
    const s = on(S.hunting, { scan: OPEN })
    expect(reduce(s, { type: 'scanClose' }, CONFIG).scan).toBe(SCAN_CLOSED)
    const closed = on(S.hunting)
    expect(reduce(closed, { type: 'scanClose' }, CONFIG)).toBe(closed)
  })

  it('leaving the hunt closes the scan; a pause keeps it', () => {
    const s = on(S.hunting, { scan: OPEN })
    expect(reduce(s, { type: 'relisten', nowMs: T1 }, CONFIG).scan).toBe(SCAN_CLOSED)
    expect(reduce(s, { type: 'stopRequest' }, CONFIG).scan).toBe(SCAN_CLOSED)
    expect(reduce(s, { type: 'hidden' }, CONFIG).scan).toBe(OPEN)
    const confirm = on(S.hunting, { scan: OPEN, hunt: HUNT_AT })
    const asked = reduce(confirm, { type: 'stopRequest' }, CONFIG)
    expect(asked.scan).toBe(OPEN)
    expect(reduce(asked, { type: 'stopConfirm' }, CONFIG).scan).toBe(SCAN_CLOSED)
  })
})

describe('createStore', () => {
  it('notifies subscribers with (state, prev) only when the state object changed', () => {
    const store = createStore(on(S.idle), CONFIG)
    const calls: Array<[AppState, AppState]> = []
    store.subscribe((s, p) => calls.push([s, p]))
    const first = store.get()
    store.dispatch({ type: 'confirmLock' }) // does not apply on idle
    expect(calls).toHaveLength(0)
    expect(store.get()).toBe(first)
    store.dispatch({ type: 'start', nowMs: T1 })
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toBe(first)
    expect(calls[0]![0]).toBe(store.get())
    expect(store.get().screen).toEqual({ kind: 'requesting', sinceMs: T1 })
  })

  it('stops notifying after unsubscribe', () => {
    const store = createStore(on(S.idle), CONFIG)
    let n = 0
    const off = store.subscribe(() => n++)
    store.dispatch({ type: 'tick', nowMs: T1 })
    off()
    store.dispatch({ type: 'tick', nowMs: T1 + 1 })
    expect(n).toBe(1)
  })

  it('queues events dispatched from a subscriber and delivers each transition once, in order', () => {
    const store = createStore(on(S.idle), CONFIG)
    const seenA: string[] = []
    const seenB: string[] = []
    store.subscribe((s, p) => {
      seenA.push(`${p.screen.kind}->${s.screen.kind}`)
      if (s.screen.kind === 'requesting') store.dispatch({ type: 'micReady', mic: MIC, nowMs: T1 + 1 })
    })
    store.subscribe((s, p) => seenB.push(`${p.screen.kind}->${s.screen.kind}`))
    store.dispatch({ type: 'start', nowMs: T1 })
    expect(seenA).toEqual(['idle->requesting', 'requesting->listening'])
    expect(seenB).toEqual(['idle->requesting', 'requesting->listening'])
    expect(store.get().screen.kind).toBe('listening')
  })

  it('keeps notifying other subscribers when one throws, then rethrows the error', () => {
    const store = createStore(on(S.idle), CONFIG)
    let reached = false
    store.subscribe(() => {
      throw new Error('boom')
    })
    store.subscribe(() => {
      reached = true
    })
    expect(() => store.dispatch({ type: 'start', nowMs: T1 })).toThrow('boom')
    expect(reached).toBe(true)
    expect(store.get().screen.kind).toBe('requesting')
    // The store is still usable afterwards.
    reached = false
    expect(() => store.dispatch({ type: 'tick', nowMs: T1 + 5 })).toThrow('boom')
    expect(reached).toBe(true)
  })

  it('does not call a subscriber that another subscriber removed during the same round', () => {
    const store = createStore(on(S.idle), CONFIG)
    let bCalls = 0
    let offB = (): void => undefined
    store.subscribe(() => offB())
    offB = store.subscribe(() => {
      bCalls++
    })
    store.dispatch({ type: 'start', nowMs: T1 })
    expect(bCalls).toBe(0)
  })

  it('drops queued events when reduce throws, and stays usable', () => {
    // A hunt view whose readings cannot be read makes stopRequest throw inside reduce.
    const broken = Object.defineProperty({ ...HUNT_AT }, 'readings', {
      get() {
        throw new Error('broken view')
      },
    })
    const store = createStore(on(S.hunting, { hunt: broken }), CONFIG)
    let armed = true
    store.subscribe(() => {
      if (!armed) return
      armed = false
      store.dispatch({ type: 'stopRequest' }) // throws when applied
      store.dispatch({ type: 'toast', text: 'late', nowMs: T1 }) // queued behind it: dropped
    })
    expect(() => store.dispatch({ type: 'tick', nowMs: T1 })).toThrow('broken view')
    expect(store.get().nowMs).toBe(T1)
    expect(store.get().toast).toBeNull()
    store.dispatch({ type: 'settings', patch: { clicks: false } })
    expect(store.get().settings.clicks).toBe(false)
    expect(store.get().toast).toBeNull() // the dropped toast does not resurface on the next dispatch
  })
})
