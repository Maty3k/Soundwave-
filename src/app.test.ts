import { describe, expect, it } from 'vitest'
import { createStore, initialState, reduce, SCAN_CLOSED, STATION_INITIAL, toastDurationMs, TOAST_MAX_MS } from './app.ts'
import { CONFIG, withConfig } from './config.ts'
import type {
  AppEvent,
  AppState,
  Capabilities,
  FoundSummary,
  HuntRecord,
  HuntView,
  Lock,
  LogEntry,
  MicDiag,
  PendingBeep,
  RadarView,
  Reading,
  Screen,
  Settings,
  StationModeView,
  StationsView,
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
    ignoredSounds: 0,
    chirps: [],
  }
}

const HUNT1 = huntView(1)
const HUNT_BELOW = huntView(CONFIG.stopConfirmMinReadings - 1)
const HUNT_AT = huntView(CONFIG.stopConfirmMinReadings)

const BASE = initialState(CAPS, SETTINGS, false, NOW)

const PENDING: PendingBeep = { f0Hz: 3120, snrDb: 16, heardAtMs: 45_000, sightings: 1 }

function logEntry(id: number, note = ''): LogEntry {
  return {
    id,
    wallMs: 1_700_000_000_000 + id * 30_000,
    verdict: id === 0 ? 'first' : 'warmer',
    deltaPrevDb: id === 0 ? null : 2,
    pct: id === 0 ? null : 60,
    levelDb: -60 + id,
    f0Hz: 3120,
    clipped: false,
    chirpCount: 1,
    source: 'chirp',
    loudest: null,
    note,
  }
}

const LOG2: readonly LogEntry[] = [logEntry(0, 'hall'), logEntry(1)]

const STATIONS: StationsView = {
  listeners: [
    { id: 'self', name: 'This phone', kind: 'self', status: 'listening', levelDb: null, deltaDb: null, isLoudest: false, offsetDb: 0, lastSeenMs: null },
  ],
  availableMics: [],
  pairing: { step: 'idle', offerCode: null, message: null, canScan: false },
  comparison: null,
  calibrating: false,
}

const STATION_VIEW: StationModeView = { ...STATION_INITIAL, step: 'connected', name: 'Kitchen', f0Hz: 3120, chirpsSent: 2 }

const SUMMARY: FoundSummary = {
  foundAtWallMs: 1_700_000_400_000,
  startedAtWallMs: 1_700_000_000_000,
  f0Hz: 3120,
  mode: 'chirp',
  readings: 2,
  bestLevelDb: -59,
  notes: [{ wallMs: 1_700_000_000_000, note: 'hall', verdict: 'first', pct: null }],
  loudestListener: null,
  listeners: 1,
}

/** A state on the given screen with session data consistent with it. */
function on(screen: Screen, patch: Partial<AppState> = {}): AppState {
  const phase = screen.kind === 'paused' ? screen.from : screen.kind
  const session: Partial<AppState> =
    phase === 'idle' || phase === 'requesting' || phase === 'error'
      ? {}
      : phase === 'station'
        ? { stationMode: STATION_VIEW }
        : phase === 'listening'
          ? { mic: MIC, micLevel: 0.4 }
          : phase === 'found'
            ? { mic: MIC, micLevel: 0.4, lock: LOCK, hunt: HUNT1, found: SUMMARY }
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
  lockedHeld: { kind: 'locked', sinceMs: T0, held: true },
  station: { kind: 'station' },
  found: { kind: 'found' },
  foundMicOff: { kind: 'found', micOff: true },
} as const satisfies Record<string, Screen>

const T1 = NOW + 7_000
const V2 = huntView(2)

/** Session fields reset by stop / back (a new hunt starts a new log). */
const CLEARED: Partial<AppState> = {
  mic: null,
  lock: null,
  hunt: null,
  micLevel: 0,
  confirmStop: false,
  pending: null,
  panel: 'meter',
  log: [],
  stationMode: null,
  found: null,
}

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
  { name: 'toast shows for a time that grows with its length', from: on(S.hunting), event: { type: 'toast', text: 'Back to chirp mode.', nowMs: T1 },
    expect: { nowMs: T1, toast: { text: 'Back to chirp mode.', untilMs: T1 + 2_000 + 55 * 19 } } },
  { name: 'toast replaces a visible toast', from: on(S.idle, { toast: { text: 'old', untilMs: T1 + 1 } }), event: { type: 'toast', text: 'new', nowMs: T1 },
    expect: { nowMs: T1, toast: { text: 'new', untilMs: T1 + 2_000 + 55 * 3 } } },
  { name: 'settings patch is merged', from: on(S.hunting), event: { type: 'settings', patch: { clicks: false } },
    expect: { settings: { clicks: false, haptics: true } } },
  { name: 'wakeLockFailed sets the flag', from: on(S.hunting), event: { type: 'wakeLockFailed' },
    expect: { wakeLockFailed: true } },

  // Locked banner: a touch holds it.
  { name: 'locked --holdLock--> locked and held', from: on(S.locked), event: { type: 'holdLock' },
    expect: { screen: { kind: 'locked', sinceMs: T0, held: true } } },
  { name: 'held locked --confirmLock--> hunting', from: on(S.lockedHeld), event: { type: 'confirmLock' },
    expect: { screen: { kind: 'hunting' } } },
  { name: 'held locked --notIt--> listening', from: on(S.lockedHeld), event: { type: 'notIt', nowMs: T1 },
    expect: { nowMs: T1, screen: { kind: 'listening', sinceMs: T1 }, lock: null, hunt: null } },

  // Pending beep while listening.
  { name: 'listening --pending--> listening with the pending beep', from: on(S.listening), event: { type: 'pending', pending: PENDING },
    expect: { pending: PENDING } },
  { name: 'listening --pending(null)--> pending cleared', from: on(S.listening, { pending: PENDING }), event: { type: 'pending', pending: null },
    expect: { pending: null } },
  { name: 'listening --lock--> locked, pending cleared', from: on(S.listening, { pending: PENDING }), event: { type: 'lock', lock: LOCK, nowMs: T1 },
    expect: { nowMs: T1, screen: { kind: 'locked', sinceMs: T1 }, lock: LOCK, pending: null } },
  { name: 'listening --stopRequest--> idle, pending cleared', from: on(S.listening, { pending: PENDING }), event: { type: 'stopRequest' },
    expect: { ...CLEARED, screen: { kind: 'idle' } } },
  { name: 'locked --notIt--> listening, pending cleared', from: on(S.locked, { pending: PENDING }), event: { type: 'notIt', nowMs: T1 },
    expect: { nowMs: T1, screen: { kind: 'listening', sinceMs: T1 }, lock: null, hunt: null, pending: null } },
  { name: 'hunting --relisten--> listening, pending cleared', from: on(S.hunting, { pending: PENDING }), event: { type: 'relisten', nowMs: T1 },
    expect: { nowMs: T1, screen: { kind: 'listening', sinceMs: T1 }, lock: null, hunt: null, pending: null } },

  // Hunting panel.
  { name: 'hunting --panel(log)--> log panel', from: on(S.hunting), event: { type: 'panel', panel: 'log' },
    expect: { panel: 'log' } },
  { name: 'hunting --panel(stations)--> stations panel', from: on(S.hunting, { panel: 'log' }), event: { type: 'panel', panel: 'stations' },
    expect: { panel: 'stations' } },
  { name: 'hunting --panel(direction)--> direction panel with a compass', from: on(S.hunting), event: { type: 'panel', panel: 'direction' },
    expect: { panel: 'direction' } },
  { name: 'hunting --panel(meter)--> back to the meter', from: on(S.hunting, { panel: 'direction' }), event: { type: 'panel', panel: 'meter' },
    expect: { panel: 'meter' } },
  { name: 'hunting --relisten--> listening, panel back to the meter, log kept', from: on(S.hunting, { panel: 'log', log: LOG2 }),
    event: { type: 'relisten', nowMs: T1 },
    expect: { nowMs: T1, screen: { kind: 'listening', sinceMs: T1 }, lock: null, hunt: null, panel: 'meter' } },
  { name: 'hunting --stopRequest--> idle, panel back to the meter, log cleared', from: on(S.hunting, { panel: 'stations', log: LOG2 }),
    event: { type: 'stopRequest' },
    expect: { ...CLEARED, screen: { kind: 'idle' } } },
  { name: 'confirmStop --stopConfirm--> idle, log cleared', from: on(S.hunting, { hunt: HUNT_AT, confirmStop: true, log: LOG2, panel: 'log' }),
    event: { type: 'stopConfirm' },
    expect: { ...CLEARED, screen: { kind: 'idle' } } },

  // Log.
  { name: 'hunting --logUpsert(new)--> appended', from: on(S.hunting, { log: LOG2 }), event: { type: 'logUpsert', entry: logEntry(2) },
    expect: { log: [...LOG2, logEntry(2)] } },
  { name: 'locked --logUpsert--> appended (sightings become readings)', from: on(S.locked), event: { type: 'logUpsert', entry: logEntry(0) },
    expect: { log: [logEntry(0)] } },
  { name: 'hunting --logUpsert(same id)--> replaced in place, note kept', from: on(S.hunting, { log: LOG2 }),
    event: { type: 'logUpsert', entry: { ...logEntry(0), levelDb: -40, chirpCount: 2 } },
    expect: { log: [{ ...logEntry(0, 'hall'), levelDb: -40, chirpCount: 2 }, logEntry(1)] } },
  { name: 'hunting --logNote--> note set on its entry', from: on(S.hunting, { log: LOG2 }), event: { type: 'logNote', id: 1, note: 'by the fridge' },
    expect: { log: [logEntry(0, 'hall'), logEntry(1, 'by the fridge')] } },
  { name: 'listening --logNote--> a note can still be edited after Listen again', from: on(S.listening, { log: LOG2 }),
    event: { type: 'logNote', id: 0, note: '' },
    expect: { log: [logEntry(0), logEntry(1)] } },

  // Stations (hub side) and station mode (this device is a station).
  { name: 'hunting --stations--> stations view stored', from: on(S.hunting), event: { type: 'stations', view: STATIONS },
    expect: { stations: STATIONS } },
  { name: 'idle --stations(null)--> stations view cleared', from: on(S.idle, { stations: STATIONS }), event: { type: 'stations', view: null },
    expect: { stations: null } },
  { name: 'idle --stationStart--> station screen with the initial view', from: on(S.idle), event: { type: 'stationStart' },
    expect: { screen: { kind: 'station' }, stationMode: STATION_INITIAL } },
  { name: 'station --stationView--> view stored', from: on(S.station), event: { type: 'stationView', view: { ...STATION_VIEW, chirpsSent: 3 } },
    expect: { stationMode: { ...STATION_VIEW, chirpsSent: 3 } } },
  { name: 'station --stationStop--> idle without a station view', from: on(S.station), event: { type: 'stationStop' },
    expect: { ...CLEARED, screen: { kind: 'idle' } } },

  // Found it: a summary screen; Keep hunting resumes, Done ends the session, New hunt starts over.
  { name: 'hunting --found--> found with the summary, keeping lock, hunt, log, stations and panel',
    from: on(S.hunting, { hunt: HUNT_AT, log: LOG2, stations: STATIONS, panel: 'log' }), event: { type: 'found', summary: SUMMARY },
    expect: { screen: { kind: 'found' }, found: SUMMARY } },
  { name: 'hunting (confirm open, scan open) --found--> found, confirm and scan closed',
    from: on(S.hunting, { hunt: HUNT_AT, confirmStop: true, panel: 'direction', scan: { open: true, status: 'active', radar: null } }),
    event: { type: 'found', summary: SUMMARY },
    expect: { screen: { kind: 'found' }, found: SUMMARY, confirmStop: false, scan: SCAN_CLOSED } },
  { name: 'found --keepHunting--> hunting without the summary',
    from: on(S.found, { hunt: HUNT_AT, log: LOG2, stations: STATIONS, panel: 'stations' }), event: { type: 'keepHunting' },
    expect: { screen: { kind: 'hunting' }, found: null } },
  { name: 'found --foundDone--> idle, session and log cleared like a confirmed stop',
    from: on(S.found, { hunt: HUNT_AT, log: LOG2, panel: 'log' }), event: { type: 'foundDone' },
    expect: { ...CLEARED, screen: { kind: 'idle' } } },
  { name: 'found --foundMicOff--> found with the microphone off, summary kept',
    from: on(S.found, { hunt: HUNT_AT, log: LOG2, found: SUMMARY }), event: { type: 'foundMicOff' },
    expect: { screen: { kind: 'found', micOff: true }, found: SUMMARY } },
  { name: 'found (mic off) --keepHunting--> hunting without the summary',
    from: on(S.foundMicOff, { hunt: HUNT_AT, log: LOG2, found: SUMMARY }), event: { type: 'keepHunting' },
    expect: { screen: { kind: 'hunting' }, found: null } },
  { name: 'found (mic off) --foundDone--> idle like a confirmed stop',
    from: on(S.foundMicOff, { hunt: HUNT_AT, log: LOG2, found: SUMMARY }), event: { type: 'foundDone' },
    expect: { ...CLEARED, screen: { kind: 'idle' } } },
  { name: 'found --start (New hunt)--> requesting, session, log, summary and stations cleared',
    from: on(S.found, { hunt: HUNT_AT, log: LOG2, stations: STATIONS, panel: 'log' }), event: { type: 'start', nowMs: T1 },
    expect: { ...CLEARED, stations: null, nowMs: T1, screen: { kind: 'requesting', sinceMs: T1 } } },
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
  { type: 'holdLock' },
  { type: 'pending', pending: PENDING },
  { type: 'panel', panel: 'log' },
  { type: 'logUpsert', entry: logEntry(7) },
  { type: 'stationStart' },
  { type: 'stationView', view: STATION_INITIAL },
  { type: 'stationStop' },
  { type: 'found', summary: SUMMARY },
  { type: 'keepHunting' },
  { type: 'foundDone' },
]

/** Event labels ('visible' split by health) that change each fixture; all others must be no-ops. */
const APPLIES: ReadonlyArray<readonly [string, AppState, readonly string[]]> = [
  ['idle', on(S.idle), ['start', 'stationStart']],
  ['requesting', on(S.requesting), ['micReady', 'micError', 'stopRequest']],
  ['listening', on(S.listening), ['lock', 'stopRequest', 'hidden', 'micLost', 'pending']],
  ['locked', on(S.locked), ['confirmLock', 'notIt', 'hunt', 'stopRequest', 'hidden', 'micLost', 'holdLock', 'logUpsert']],
  ['locked, held', on(S.lockedHeld), ['confirmLock', 'notIt', 'hunt', 'stopRequest', 'hidden', 'micLost', 'logUpsert']],
  ['hunting', on(S.hunting), ['hunt', 'relisten', 'stopRequest', 'hidden', 'micLost', 'panel', 'logUpsert', 'found']],
  ['hunting, confirm open', on(S.hunting, { hunt: HUNT_AT, confirmStop: true }),
    ['hunt', 'relisten', 'stopConfirm', 'stopCancel', 'hidden', 'micLost', 'panel', 'logUpsert', 'found']],
  ['paused', on(S.pausedHunting), ['micError', 'visible:healthy', 'visible:unhealthy', 'micLost', 'resumed', 'stopRequest']],
  ['paused, needs gesture', on(S.pausedGesture), ['micError', 'visible:healthy', 'resumed', 'stopRequest']],
  ['error', on(S.error), ['retry', 'back']],
  ['station', on(S.station), ['stationView', 'stationStop']],
  // Audio is paused on the Found it screen: hiding the page or losing the mic changes nothing there.
  ['found', on(S.found, { log: LOG2, stations: STATIONS }), ['start', 'keepHunting', 'foundDone']],
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
    const until = T1 + toastDurationMs('Back to chirp mode.')
    s = reduce(s, { type: 'tick', nowMs: until - 1 }, CONFIG)
    expect(s.toast).toEqual({ text: 'Back to chirp mode.', untilMs: until })
    s = reduce(s, { type: 'tick', nowMs: until }, CONFIG)
    expect(s.toast).toBeNull()
  })

  it('gives a toast 2 s plus 55 ms per character, at most 10 s', () => {
    expect(toastDurationMs('')).toBe(2_000)
    expect(toastDurationMs('Link copied.')).toBe(2_000 + 55 * 12)
    expect(toastDurationMs('x'.repeat(145))).toBe(9_975)
    expect(toastDurationMs('x'.repeat(146))).toBe(TOAST_MAX_MS)
    expect(toastDurationMs('x'.repeat(1_000))).toBe(10_000)
    const long = 'Your screen may go dark while hunting. Tap it now and then to keep it on.'
    const s = reduce(on(S.idle), { type: 'toast', text: long, nowMs: T1 }, CONFIG)
    expect(s.toast?.untilMs).toBe(T1 + 2_000 + 55 * long.length)
  })

  it('does not advance a held banner, however long it stays', () => {
    const held = reduce(on(S.locked), { type: 'holdLock' }, CONFIG)
    expect(held.screen).toEqual({ kind: 'locked', sinceMs: T0, held: true })
    const later = reduce(held, { type: 'tick', nowMs: T0 + 10 * CONFIG.lockedBannerMs }, CONFIG)
    expect(later.screen).toBe(held.screen)
    expect(later.nowMs).toBe(T0 + 10 * CONFIG.lockedBannerMs)
    expect(reduce(later, { type: 'confirmLock' }, CONFIG).screen).toEqual({ kind: 'hunting' })
  })

  it('holdLock on a held banner or another screen is a no-op', () => {
    const held = on(S.lockedHeld)
    expect(reduce(held, { type: 'holdLock' }, CONFIG)).toBe(held)
    for (const screen of [S.idle, S.listening, S.hunting, S.pausedHunting]) {
      const s = on(screen)
      expect(reduce(s, { type: 'holdLock' }, CONFIG)).toBe(s)
    }
  })

  it('a banner restored from a pause is not held any more', () => {
    const paused = reduce(on(S.lockedHeld), { type: 'hidden' }, CONFIG)
    expect(paused.screen).toEqual({ kind: 'paused', from: 'hunting', needsGesture: false })
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
      expect(toast.toast).toEqual({ text: 'hello', untilMs: T1 + toastDurationMs('hello') })
      expect(toast.screen).toBe(state.screen)

      const settings = reduce(state, { type: 'settings', patch: { haptics: !state.settings.haptics } }, CONFIG)
      expect(settings.settings).toEqual({ ...state.settings, haptics: !state.settings.haptics })
      expect(settings.screen).toBe(state.screen)

      const wake = reduce(state, { type: 'wakeLockFailed' }, CONFIG)
      expect(wake).toEqual({ ...state, wakeLockFailed: true })

      const stations = reduce(state, { type: 'stations', view: STATIONS }, CONFIG)
      expect(stations).toEqual({ ...state, stations: STATIONS })
      expect(reduce(stations, { type: 'stations', view: STATIONS }, CONFIG)).toBe(stations)
    })
  }
})

// ---- Pending beep, panels, log and station mode --------------------------------------------------

describe('reduce: pending beep', () => {
  it('is only taken while listening, and a repeated one is a no-op', () => {
    const s = reduce(on(S.listening), { type: 'pending', pending: PENDING }, CONFIG)
    expect(reduce(s, { type: 'pending', pending: PENDING }, CONFIG)).toBe(s)
    for (const screen of [S.idle, S.locked, S.hunting, S.pausedListening]) {
      const other = on(screen)
      expect(reduce(other, { type: 'pending', pending: PENDING }, CONFIG)).toBe(other)
    }
  })

  it('survives a pause of the listening screen', () => {
    const s = on(S.listening, { pending: PENDING })
    const back = reduce(reduce(s, { type: 'hidden' }, CONFIG), { type: 'visible', healthy: true }, CONFIG)
    expect(back.screen.kind).toBe('listening')
    expect(back.pending).toBe(PENDING)
  })
})

describe('reduce: hunting panel', () => {
  it('starts on the meter', () => {
    expect(BASE.panel).toBe('meter')
  })

  it('offers the direction panel only with a compass', () => {
    const noCompass = on(S.hunting, { caps: { ...CAPS, compass: false } })
    expect(reduce(noCompass, { type: 'panel', panel: 'direction' }, CONFIG)).toBe(noCompass)
    expect(reduce(noCompass, { type: 'panel', panel: 'log' }, CONFIG).panel).toBe('log')
  })

  it('changes only on the hunting screen, and choosing the current panel is a no-op', () => {
    const s = on(S.hunting, { panel: 'log' })
    expect(reduce(s, { type: 'panel', panel: 'log' }, CONFIG)).toBe(s)
    for (const screen of [S.idle, S.listening, S.locked, S.pausedHunting, S.station, S.found]) {
      const other = on(screen)
      expect(reduce(other, { type: 'panel', panel: 'stations' }, CONFIG)).toBe(other)
    }
  })

  it('does not open or close the scan (main does)', () => {
    const s = reduce(on(S.hunting), { type: 'panel', panel: 'direction' }, CONFIG)
    expect(s.scan).toBe(SCAN_CLOSED)
    const open = on(S.hunting, { panel: 'direction', scan: { open: true, status: 'active', radar: null } })
    expect(reduce(open, { type: 'panel', panel: 'meter' }, CONFIG).scan).toBe(open.scan)
  })

  it('is kept across a pause and reset when the hunt ends', () => {
    const s = on(S.hunting, { panel: 'stations' })
    const paused = reduce(s, { type: 'micLost' }, CONFIG)
    expect(paused.panel).toBe('stations')
    expect(reduce(paused, { type: 'resumed' }, CONFIG).panel).toBe('stations')
    expect(reduce(s, { type: 'relisten', nowMs: T1 }, CONFIG).panel).toBe('meter')
    expect(reduce(s, { type: 'stopRequest' }, CONFIG).panel).toBe('meter')
    expect(reduce(paused, { type: 'micError', code: 'busy' }, CONFIG).panel).toBe('meter')
  })
})

describe('reduce: log', () => {
  it('starts empty', () => {
    expect(BASE.log).toEqual([])
  })

  it('takes entries only while locked or hunting', () => {
    for (const screen of [S.idle, S.listening, S.pausedHunting, S.error, S.station, S.found]) {
      const s = on(screen)
      expect(reduce(s, { type: 'logUpsert', entry: logEntry(1) }, CONFIG)).toBe(s)
    }
  })

  it('drops the oldest entries beyond logMaxEntries', () => {
    const cfg = withConfig({ logMaxEntries: 3 })
    let s = on(S.hunting)
    for (let id = 0; id < 5; id++) s = reduce(s, { type: 'logUpsert', entry: logEntry(id) }, cfg)
    expect(s.log.map((e) => e.id)).toEqual([2, 3, 4])
    // An update of a kept entry stays in place and does not drop anything.
    s = reduce(s, { type: 'logUpsert', entry: { ...logEntry(3), chirpCount: 2 } }, cfg)
    expect(s.log.map((e) => [e.id, e.chirpCount])).toEqual([[2, 1], [3, 2], [4, 1]])
  })

  it('keeps the note of an updated entry even when the update carries another one', () => {
    const s = on(S.hunting, { log: LOG2 })
    const next = reduce(s, { type: 'logUpsert', entry: { ...logEntry(0), note: 'ignored', chirpCount: 3 } }, CONFIG)
    expect(next.log[0]).toEqual({ ...logEntry(0, 'hall'), chirpCount: 3 })
  })

  it('appends in arrival order even when a new hunt restarts at a lower id', () => {
    const s = on(S.hunting, { log: [logEntry(5), logEntry(6)] })
    expect(reduce(s, { type: 'logUpsert', entry: logEntry(1) }, CONFIG).log.map((e) => e.id)).toEqual([5, 6, 1])
  })

  it('cuts notes to logNoteMaxLength without splitting an emoji', () => {
    const cfg = withConfig({ logNoteMaxLength: 5 })
    const s = on(S.hunting, { log: LOG2 })
    expect(reduce(s, { type: 'logNote', id: 1, note: 'kitchen door' }, cfg).log[1]!.note).toBe('kitch')
    expect(reduce(s, { type: 'logNote', id: 1, note: 'abcd\u{1F50A}x' }, cfg).log[1]!.note).toBe('abcd')
    expect(reduce(s, { type: 'logNote', id: 1, note: 'ab\u{1F50A}x' }, cfg).log[1]!.note).toBe('ab\u{1F50A}x')
    const long = 'x'.repeat(CONFIG.logNoteMaxLength + 10)
    expect(reduce(s, { type: 'logNote', id: 1, note: long }, CONFIG).log[1]!.note).toHaveLength(CONFIG.logNoteMaxLength)
  })

  it('a note for an unknown entry, or the same note again, is a no-op', () => {
    const s = on(S.hunting, { log: LOG2 })
    expect(reduce(s, { type: 'logNote', id: 99, note: 'x' }, CONFIG)).toBe(s)
    expect(reduce(s, { type: 'logNote', id: 0, note: 'hall' }, CONFIG)).toBe(s)
  })

  it('is kept across Listen again and a pause, and cleared when the hunt stops', () => {
    const s = on(S.hunting, { log: LOG2 })
    expect(reduce(s, { type: 'relisten', nowMs: T1 }, CONFIG).log).toBe(LOG2)
    expect(reduce(s, { type: 'hidden' }, CONFIG).log).toBe(LOG2)
    expect(reduce(on(S.locked, { log: LOG2 }), { type: 'notIt', nowMs: T1 }, CONFIG).log).toBe(LOG2)
    expect(reduce(s, { type: 'stopRequest' }, CONFIG).log).toEqual([])
  })
})

describe('reduce: station mode', () => {
  it('starts only from the landing screen', () => {
    for (const screen of [S.requesting, S.listening, S.hunting, S.error]) {
      const s = on(screen)
      expect(reduce(s, { type: 'stationStart' }, CONFIG)).toBe(s)
    }
  })

  it('takes views only on the station screen; the same view again is a no-op', () => {
    const s = on(S.station)
    expect(reduce(s, { type: 'stationView', view: STATION_VIEW }, CONFIG)).toBe(s)
    const idle = on(S.idle)
    expect(reduce(idle, { type: 'stationView', view: STATION_VIEW }, CONFIG)).toBe(idle)
  })

  it('is not paused by the page going to the background (the station keeps its own mic)', () => {
    const s = on(S.station)
    expect(reduce(s, { type: 'hidden' }, CONFIG)).toBe(s)
    expect(reduce(s, { type: 'micLost' }, CONFIG)).toBe(s)
    expect(reduce(s, { type: 'stopRequest' }, CONFIG)).toBe(s)
  })

  it('round-trips: landing, station, landing', () => {
    let s = on(S.idle)
    s = reduce(s, { type: 'stationStart' }, CONFIG)
    s = reduce(s, { type: 'stationView', view: STATION_VIEW }, CONFIG)
    expect(s.stationMode).toBe(STATION_VIEW)
    s = reduce(s, { type: 'stationStop' }, CONFIG)
    expect(s).toEqual(on(S.idle))
  })
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
    for (const screen of [S.idle, S.listening, S.locked, S.pausedHunting, S.found]) {
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

describe('reduce: Found it', () => {
  const HUNTING_STATE = on(S.hunting, { hunt: HUNT_AT, log: LOG2, stations: STATIONS, panel: 'stations' })

  it('keeps lock, hunt, log, stations and panel by reference, so Keep hunting can resume', () => {
    const found = reduce(HUNTING_STATE, { type: 'found', summary: SUMMARY }, CONFIG)
    expect(found.screen).toEqual({ kind: 'found' })
    expect(found.found).toBe(SUMMARY)
    expect(found.lock).toBe(HUNTING_STATE.lock)
    expect(found.hunt).toBe(HUNTING_STATE.hunt)
    expect(found.log).toBe(LOG2)
    expect(found.stations).toBe(STATIONS)
    expect(found.panel).toBe('stations')
    expect(found.mic).toBe(MIC)
  })

  it('Keep hunting comes back to the same hunt', () => {
    const found = reduce(HUNTING_STATE, { type: 'found', summary: SUMMARY }, CONFIG)
    const back = reduce(found, { type: 'keepHunting' }, CONFIG)
    expect(back).toEqual(HUNTING_STATE)
    expect(back.hunt).toBe(HUNTING_STATE.hunt)
    expect(back.log).toBe(LOG2)
    // The hunt goes on: new views and log lines are taken again, and Found it works a second time.
    expect(reduce(back, { type: 'hunt', view: V2 }, CONFIG).hunt).toBe(V2)
    expect(reduce(back, { type: 'logUpsert', entry: logEntry(2) }, CONFIG).log).toHaveLength(3)
    const again = reduce(back, { type: 'found', summary: { ...SUMMARY, readings: 3 } }, CONFIG)
    expect(again.found?.readings).toBe(3)
  })

  it('Done ends the session exactly like a confirmed Stop', () => {
    const viaFound = reduce(reduce(HUNTING_STATE, { type: 'found', summary: SUMMARY }, CONFIG), { type: 'foundDone' }, CONFIG)
    const viaStop = reduce(reduce(HUNTING_STATE, { type: 'stopRequest' }, CONFIG), { type: 'stopConfirm' }, CONFIG)
    expect(viaFound).toEqual(viaStop)
    expect(viaFound.screen).toEqual({ kind: 'idle' })
    expect(viaFound.log).toEqual([])
    expect(viaFound.found).toBeNull()
  })

  it('New hunt starts a fresh session: requesting, then listening with an empty log', () => {
    let s = reduce(HUNTING_STATE, { type: 'found', summary: SUMMARY }, CONFIG)
    s = reduce(s, { type: 'start', nowMs: T1 }, CONFIG)
    expect(s.screen).toEqual({ kind: 'requesting', sinceMs: T1 })
    expect(s.lock).toBeNull()
    expect(s.hunt).toBeNull()
    expect(s.log).toEqual([])
    expect(s.found).toBeNull()
    expect(s.stations).toBeNull()
    expect(s.panel).toBe('meter')
    expect(s.settings).toBe(HUNTING_STATE.settings)
    s = reduce(s, { type: 'micReady', mic: MIC, nowMs: T1 + 300 }, CONFIG)
    expect(s.screen).toEqual({ kind: 'listening', sinceMs: T1 + 300 })
  })

  it('is taken only on the hunting screen', () => {
    for (const screen of [S.idle, S.requesting, S.listening, S.locked, S.lockedHeld, S.pausedHunting, S.pausedGesture, S.error, S.station, S.found]) {
      const s = on(screen)
      expect(reduce(s, { type: 'found', summary: SUMMARY }, CONFIG), screen.kind).toBe(s)
    }
  })

  it('Keep hunting and Done apply only on the Found it screen', () => {
    for (const screen of [S.idle, S.listening, S.locked, S.hunting, S.pausedHunting, S.error, S.station]) {
      const s = on(screen)
      expect(reduce(s, { type: 'keepHunting' }, CONFIG), screen.kind).toBe(s)
      expect(reduce(s, { type: 'foundDone' }, CONFIG), screen.kind).toBe(s)
    }
  })

  it('turns the microphone off only on the Found it screen, and only once', () => {
    for (const screen of [S.idle, S.requesting, S.listening, S.locked, S.hunting, S.pausedHunting, S.error, S.station, S.foundMicOff]) {
      const s = on(screen)
      expect(reduce(s, { type: 'foundMicOff' }, CONFIG), JSON.stringify(screen)).toBe(s)
    }
  })

  it('Keep hunting after the microphone turned off comes back to the same hunt', () => {
    const found = reduce(HUNTING_STATE, { type: 'found', summary: SUMMARY }, CONFIG)
    const off = reduce(found, { type: 'foundMicOff' }, CONFIG)
    expect(off.screen).toEqual({ kind: 'found', micOff: true })
    expect(off.found).toBe(SUMMARY)
    expect(off.hunt).toBe(HUNTING_STATE.hunt)
    expect(off.log).toBe(LOG2)
    expect(off.stations).toBe(STATIONS)
    const back = reduce(off, { type: 'keepHunting' }, CONFIG)
    expect(back).toEqual(HUNTING_STATE)
    // Found it a second time starts with the microphone on again.
    expect(reduce(back, { type: 'found', summary: SUMMARY }, CONFIG).screen).toEqual({ kind: 'found' })
  })

  it('is not paused by hiding the page or losing the mic (audio is already paused there)', () => {
    const s = on(S.found)
    const events: readonly AppEvent[] = [
      { type: 'hidden' },
      { type: 'visible', healthy: true },
      { type: 'visible', healthy: false },
      { type: 'micLost' },
      { type: 'resumed' },
    ]
    for (const event of events) expect(reduce(s, event, CONFIG), label(event)).toBe(s)
  })

  it('a tick only moves the clock, the mic level and the toast', () => {
    const s = on(S.found, { toast: { text: 'Log copied.', untilMs: T1 } })
    const later = reduce(s, { type: 'tick', nowMs: T1 + 10 * CONFIG.lockedBannerMs, micLevel: 0 }, CONFIG)
    expect(later).toEqual({ ...s, nowMs: T1 + 10 * CONFIG.lockedBannerMs, micLevel: 0, toast: null })
    expect(later.screen).toBe(s.screen)
    expect(reduce(s, { type: 'tick', nowMs: s.nowMs }, CONFIG)).toBe(s)
  })

  it('keeps note edits that arrive after Found it (a debounced note field)', () => {
    const s = on(S.found, { log: LOG2 })
    expect(reduce(s, { type: 'logNote', id: 1, note: 'kitchen' }, CONFIG).log[1]!.note).toBe('kitchen')
  })

  it('takes stations updates there: the hub and the extra mics keep running for Keep hunting', () => {
    const s = on(S.found, { stations: STATIONS })
    const view: StationsView = { ...STATIONS, calibrating: true }
    expect(reduce(s, { type: 'stations', view }, CONFIG).stations).toBe(view)
  })

  it('neither opens the direction scan nor switches panels there', () => {
    const s = on(S.found, { panel: 'direction' })
    expect(reduce(s, { type: 'scanOpen' }, CONFIG)).toBe(s)
    expect(reduce(s, { type: 'panel', panel: 'meter' }, CONFIG)).toBe(s)
    expect(reduce(s, { type: 'stopRequest' }, CONFIG)).toBe(s)
  })

  it('walks a whole session: hunt, Found it, Keep hunting, Found it, Done', () => {
    let s = initialState(CAPS, SETTINGS, false, 0)
    const step = (e: AppEvent): AppState => (s = reduce(s, e, CONFIG))
    step({ type: 'start', nowMs: 10 })
    step({ type: 'micReady', mic: MIC, nowMs: 500 })
    step({ type: 'lock', lock: LOCK, nowMs: 30_000 })
    step({ type: 'confirmLock' })
    step({ type: 'hunt', view: HUNT_AT })
    step({ type: 'logUpsert', entry: logEntry(0) })
    step({ type: 'found', summary: SUMMARY })
    expect(s.screen.kind).toBe('found')
    step({ type: 'hunt', view: V2 }) // main pushes no views there; one arriving anyway is ignored
    expect(s.hunt).toBe(HUNT_AT)
    step({ type: 'keepHunting' })
    expect(s.screen.kind).toBe('hunting')
    step({ type: 'logUpsert', entry: logEntry(1) })
    step({ type: 'found', summary: { ...SUMMARY, readings: 4 } })
    expect(s.found?.readings).toBe(4)
    expect(s.log).toHaveLength(2)
    step({ type: 'foundDone' })
    expect(s).toEqual(initialState(CAPS, SETTINGS, false, 30_000))
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

describe('reduce: past hunts', () => {
  const H: readonly HuntRecord[] = [{ id: 42, label: 'Hallway smoke alarm', summary: SUMMARY }]

  it('starts empty, with no record on the Found it screen', () => {
    const s = initialState(CAPS, SETTINGS, false, NOW)
    expect(s.history).toEqual([])
    expect(s.foundRecordId).toBeNull()
  })

  it('takes the history on every screen', () => {
    for (const screen of Object.values(S)) {
      const s = on(screen)
      const next = reduce(s, { type: 'history', history: H }, CONFIG)
      expect(next.history, JSON.stringify(screen)).toBe(H)
      expect(next.screen).toBe(s.screen)
      expect(reduce(next, { type: 'history', history: H }, CONFIG)).toBe(next)
    }
  })

  it('keeps it through Stop, Done, New hunt and station mode', () => {
    const hunting = on(S.hunting, { history: H })
    const stopped = reduce(reduce(hunting, { type: 'stopRequest' }, CONFIG), { type: 'stopConfirm' }, CONFIG)
    expect(stopped.history).toBe(H)
    const found = reduce(hunting, { type: 'found', summary: SUMMARY, recordId: 42 }, CONFIG)
    expect(reduce(found, { type: 'foundDone' }, CONFIG).history).toBe(H)
    expect(reduce(found, { type: 'start', nowMs: T1 }, CONFIG).history).toBe(H)
    const station = reduce(on(S.idle, { history: H }), { type: 'stationStart' }, CONFIG)
    expect(reduce(station, { type: 'stationStop' }, CONFIG).history).toBe(H)
  })

  it("holds the Found it screen's record id only while that screen is shown", () => {
    const hunting = on(S.hunting, { hunt: HUNT_AT, history: H })
    const found = reduce(hunting, { type: 'found', summary: SUMMARY, recordId: 42 }, CONFIG)
    expect(found.foundRecordId).toBe(42)
    expect(reduce(hunting, { type: 'found', summary: SUMMARY }, CONFIG).foundRecordId).toBeNull()
    expect(reduce(found, { type: 'foundMicOff' }, CONFIG).foundRecordId).toBe(42)
    expect(reduce(found, { type: 'keepHunting' }, CONFIG).foundRecordId).toBeNull()
    expect(reduce(found, { type: 'foundDone' }, CONFIG).foundRecordId).toBeNull()
    expect(reduce(found, { type: 'start', nowMs: T1 }, CONFIG).foundRecordId).toBeNull()
  })
})
