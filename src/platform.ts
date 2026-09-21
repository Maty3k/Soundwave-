/**
 * Browser platform helpers: capability detection, the AudioContext factory, URL flags, persisted
 * settings, the screen wake lock, the vibration scheduler and visibility events.
 * Every browser API is feature-detected; nothing here throws on a missing API.
 */
import type { Config } from './config.ts'
import type { Capabilities, Settings } from './types.ts'

// ---- Capabilities and AudioContext -------------------------------------------------------------

type AudioContextCtor = new () => AudioContext

/** AudioContext, or Safari's legacy webkitAudioContext, or null. */
function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as typeof globalThis & { readonly webkitAudioContext?: AudioContextCtor }
  if (typeof g.AudioContext === 'function') return g.AudioContext
  if (typeof g.webkitAudioContext === 'function') return g.webkitAudioContext
  return null
}

function hasNavigator(): boolean {
  return typeof navigator !== 'undefined'
}

/** What this browser offers. Safe to call anywhere (all false outside a browser). */
export function detectCapabilities(): Capabilities {
  const nav = hasNavigator()
  return {
    secureContext: globalThis.isSecureContext === true,
    getUserMedia: nav && typeof navigator.mediaDevices?.getUserMedia === 'function',
    audioContext: audioContextCtor() !== null,
    wakeLock: nav && 'wakeLock' in navigator,
    haptics: nav && 'vibrate' in navigator && (navigator.maxTouchPoints ?? 0) > 0,
  }
}

/**
 * A new AudioContext at the device's native rate (sampleRate is never passed: forcing one makes
 * Firefox refuse to connect a microphone recorded at another rate). Create it synchronously in the
 * Start tap handler so it may start running. Throws when Web Audio is missing: check
 * detectCapabilities().audioContext first.
 */
export function createAudioContext(): AudioContext {
  const Ctor = audioContextCtor()
  if (Ctor === null) throw new Error('Web Audio (AudioContext) is not available')
  return new Ctor()
}

// ---- URL flags ---------------------------------------------------------------------------------

/** Flags read from the page's query string. */
export interface QueryFlags {
  /** `?debug` present (with any value). */
  readonly debug: boolean
  /** `?warmth=x`: forces the feedback warmth to x clamped to [0, 1]; null when absent or not a number. */
  readonly forceWarmth: number | null
}

/** Parse `location.search` (with or without the leading '?'). Pure. */
export function readQueryFlags(search: string): QueryFlags {
  const params = new URLSearchParams(search)
  const raw = params.get('warmth')
  let forceWarmth: number | null = null
  if (raw !== null && raw.trim() !== '') {
    const v = Number(raw)
    if (Number.isFinite(v)) forceWarmth = Math.min(1, Math.max(0, v))
  }
  return { debug: params.has('debug'), forceWarmth }
}

// ---- Settings ----------------------------------------------------------------------------------

/** localStorage key of the persisted settings. */
export const SETTINGS_KEY = 'soundwave.settings.v1'

/** Clicks and haptics both on. */
export const DEFAULT_SETTINGS: Settings = Object.freeze({ clicks: true, haptics: true })

/**
 * Settings from their stored JSON. Tolerant: null, invalid JSON, a non-object or a field that is
 * not a boolean falls back to the default for that field. Unknown fields are dropped. Pure.
 */
export function parseSettings(raw: string | null): Settings {
  if (raw === null) return { ...DEFAULT_SETTINGS }
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ...DEFAULT_SETTINGS }
  const o = v as { readonly clicks?: unknown; readonly haptics?: unknown }
  return {
    clicks: typeof o.clicks === 'boolean' ? o.clicks : DEFAULT_SETTINGS.clicks,
    haptics: typeof o.haptics === 'boolean' ? o.haptics : DEFAULT_SETTINGS.haptics,
  }
}

/** Settings from localStorage; defaults when storage is missing, blocked or holds garbage. */
export function loadSettings(): Settings {
  try {
    return parseSettings(localStorage.getItem(SETTINGS_KEY))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** Persist settings; silently does nothing when storage is missing, blocked or full. */
export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ clicks: s.clicks, haptics: s.haptics }))
  } catch {
    // Private mode, blocked storage or quota: the toggles just will not persist.
  }
}

// ---- Visibility --------------------------------------------------------------------------------

function isVisible(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible'
}

/** Call `cb(visible)` on every visibilitychange. Returns the unsubscribe function. */
export function onVisibilityChange(cb: (visible: boolean) => void): () => void {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => {}
  const handler = (): void => cb(document.visibilityState === 'visible')
  document.addEventListener('visibilitychange', handler)
  return () => document.removeEventListener('visibilitychange', handler)
}

// ---- Screen wake lock --------------------------------------------------------------------------

function wakeLockApi(): WakeLock | null {
  if (!hasNavigator() || !('wakeLock' in navigator)) return null
  const api = navigator.wakeLock
  return typeof api?.request === 'function' ? api : null
}

function errorName(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const name = (err as { readonly name?: unknown }).name
  return typeof name === 'string' ? name : null
}

/**
 * Keeps the screen on while enabled. Requests a 'screen' wake lock only while the page is visible,
 * re-requests when the page becomes visible again and when the browser releases the lock while
 * visible. A release or rejection while hidden is expected and ignored. `onFailure` is called at
 * most once, for a real failure: no Wake Lock API, or NotAllowedError while visible.
 */
export class WakeLockKeeper {
  private readonly onFailure: () => void
  private enabled = false
  private sentinel: WakeLockSentinel | null = null
  private pending = false
  /** A request was wanted while one was pending (the page came back meanwhile): retry once it settles. */
  private again = false
  /** Counts visibilitychange events, so a rejection caused by hiding during the request is recognised. */
  private visibilityChanges = 0
  private failed = false
  private unsubscribe: (() => void) | null = null

  constructor(onFailure: () => void) {
    this.onFailure = onFailure
  }

  /** Start keeping the screen on. Resolves once the first request settles; never rejects. */
  async enable(): Promise<void> {
    this.enabled = true
    this.unsubscribe ??= onVisibilityChange((visible) => {
      this.visibilityChanges++
      if (visible) void this.request()
    })
    await this.request()
  }

  /** Stop keeping the screen on and release the lock. */
  disable(): void {
    this.enabled = false
    this.again = false
    this.unsubscribe?.()
    this.unsubscribe = null
    const s = this.sentinel
    this.sentinel = null
    if (s !== null) releaseSentinel(s)
  }

  private async request(): Promise<void> {
    if (!this.enabled || this.sentinel !== null || !isVisible()) return
    if (this.pending) {
      this.again = true
      return
    }
    const api = wakeLockApi()
    if (api === null) {
      this.fail()
      return
    }
    this.pending = true
    const changes = this.visibilityChanges
    try {
      const s = await api.request('screen')
      if (!this.enabled) {
        releaseSentinel(s)
        return
      }
      this.sentinel = s
      s.addEventListener('release', () => {
        if (this.sentinel === s) this.sentinel = null
        if (this.enabled && isVisible()) void this.request()
      })
    } catch (err) {
      // A rejection while hidden, or for a request the page was hidden during, is expected.
      const stayedVisible = changes === this.visibilityChanges && isVisible()
      if (stayedVisible && errorName(err) === 'NotAllowedError') this.fail()
    } finally {
      this.pending = false
      if (this.again) {
        this.again = false
        void this.request()
      }
    }
  }

  private fail(): void {
    if (this.failed) return
    this.failed = true
    this.onFailure()
  }
}

function releaseSentinel(s: WakeLockSentinel): void {
  try {
    if (!s.released) s.release().catch(() => undefined)
  } catch {
    // Already released.
  }
}

// ---- Haptics -----------------------------------------------------------------------------------

function vibrationSupported(): boolean {
  return hasNavigator() && typeof navigator.vibrate === 'function'
}

/** navigator.vibrate that never throws; false when blocked or unsupported. */
function vibrate(pattern: number | readonly number[]): boolean {
  try {
    return navigator.vibrate(typeof pattern === 'number' ? pattern : Array.from(pattern))
  } catch {
    return false
  }
}

/** Total length of a vibrate pattern in ms (vibrations and pauses). */
function patternMs(pattern: readonly number[]): number {
  let ms = 0
  for (const v of pattern) if (Number.isFinite(v) && v > 0) ms += v
  return ms
}

function samePattern(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === b) return true
  if (a === null || b === null || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * Vibration feedback with one scheduler. The tier pattern is re-issued every cfg.hapticPeriodMs;
 * a different pattern starts as soon as the one playing has finished (at once when nothing is
 * playing); a pulse plays immediately and holds the tier off until it has finished. Nothing
 * vibrates before unlock() (call it from the Start tap), while disabled, or where
 * navigator.vibrate is missing.
 */
export class Haptics {
  private readonly cfg: Config
  private unlocked = false
  private enabled = true
  private tier: readonly number[] | null = null
  /** Tier pattern last issued (null: none since the last pulse or silence) and when (performance.now ms). */
  private issued: readonly number[] | null = null
  private issuedAtMs = Number.NEGATIVE_INFINITY
  /** The issued tier pattern runs until then (performance.now ms); a different pattern waits for it. */
  private tierEndMs = 0
  /** The issued tier pattern may still be vibrating (false once cut with vibrate(0) or replaced by a pulse). */
  private tierLive = false
  /** A pulse is playing until then; the tier waits. */
  private pulseUntilMs = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(cfg: Config) {
    this.cfg = cfg
  }

  /** Allow vibration (the Start tap is the user activation browsers require). */
  unlock(): void {
    this.unlocked = true
    this.update()
  }

  /** The user's Haptics toggle. Disabling stops any vibration; enabling resumes the current tier. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (enabled) this.update()
    else this.silence()
  }

  /**
   * Pattern to repeat every hapticPeriodMs, or null for none. Cheap to call on every render: a
   * pattern equal (by value) to the current one changes nothing. A different pattern starts once
   * the playing one has finished, so a tier flickering at a boundary cannot restart the vibration
   * at render rate; the same pattern coming back within its period waits for the period. null cuts
   * the tier pattern with vibrate(0) if it is still playing (a pulse keeps playing).
   */
  setTier(pattern: readonly number[] | null): void {
    if (samePattern(this.tier, pattern)) return
    this.tier = pattern
    if (pattern !== null) {
      this.update()
      return
    }
    this.clearTimer()
    if (this.tierLive && nowMs() < this.tierEndMs) vibrate(0)
    this.tierLive = false
  }

  /** Vibrate `pattern` now (for example on a new reading); the tier resumes once it has finished. */
  pulse(pattern: readonly number[]): void {
    if (!this.active()) return
    vibrate(pattern)
    this.pulseUntilMs = nowMs() + patternMs(pattern)
    // The pulse replaced whatever the tier was playing; the tier restarts as soon as it is over.
    this.tierLive = false
    this.tierEndMs = 0
    this.issued = null
    this.update()
  }

  /** Clear the tier and stop any vibration. unlock() and the toggle are kept. */
  stop(): void {
    this.tier = null
    this.silence()
  }

  private active(): boolean {
    return this.unlocked && this.enabled && vibrationSupported()
  }

  /** The scheduler step: issue the tier if due, then arm the timer for the next step. */
  private update(): void {
    this.clearTimer()
    const tier = this.tier
    if (tier === null || !this.active()) return
    const now = nowMs()
    if (now < this.pulseUntilMs) {
      this.arm(this.pulseUntilMs - now)
      return
    }
    const period = this.cfg.hapticPeriodMs
    // Same pattern: once per period. A different one: as soon as the issued pattern has finished.
    let dueMs = samePattern(this.issued, tier) ? this.issuedAtMs + period : this.tierEndMs
    if (now >= dueMs) {
      vibrate(tier)
      this.issued = tier
      this.issuedAtMs = now
      this.tierEndMs = now + patternMs(tier)
      this.tierLive = true
      dueMs = now + period
    }
    this.arm(dueMs - now)
  }

  private arm(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      this.update()
    }, Math.max(0, delayMs))
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Stop the scheduler and anything vibrating (vibrate(0) only if something may still play). */
  private silence(): void {
    this.clearTimer()
    const now = nowMs()
    if (now < this.pulseUntilMs || (this.tierLive && now < this.tierEndMs)) vibrate(0)
    this.issued = null
    this.tierLive = false
    this.tierEndMs = 0
    this.pulseUntilMs = 0
  }
}
