/**
 * Wiring only: the Start gesture creates the AudioContext and opens the mic; frames flow into the
 * detector (listening) or the hunt (locked / hunting); a requestAnimationFrame loop pushes a hunt
 * snapshot and a clock tick into the store, drives clicks and haptics, and renders.
 * All decisions live in the pure modules (src/dsp, src/app.ts); this file only connects them.
 */
import './style.css'
import { CONFIG } from './config.ts'
import type { AppState, Frame, HuntEvent, Lock, MicDiag } from './types.ts'
import { createStore, initialState } from './app.ts'
import { mountUi } from './ui.ts'
import { TEXT } from './copy.ts'
import {
  createAudioContext,
  detectCapabilities,
  Haptics,
  loadSettings,
  onVisibilityChange,
  readQueryFlags,
  saveSettings,
  WakeLockKeeper,
} from './platform.ts'
import { acquireMic, stopMic, type MicHandle } from './audio/mic.ts'
import { Engine } from './audio/engine.ts'
import { Clicker } from './audio/clicker.ts'
import { createDetector, detectStep, type DetectorState } from './dsp/detect.ts'
import { createHunt, huntStep, huntView, resetBest, type HuntState } from './dsp/hunt.ts'
import { chooseClickFreq, clickRateHz, vibrationTier } from './dsp/geiger.ts'

declare global {
  interface Window {
    /** Read-only state accessor, present only with ?debug (used by the end-to-end check). */
    __soundwave?: { state(): AppState }
  }
}

interface Session {
  readonly ctx: AudioContext
  mic: MicHandle
  engine: Engine
  readonly clicker: Clicker
  detector: DetectorState | null
  hunt: HuntState | null
  /** The next frame must be flagged as a gap (after a pause), so open measurements are discarded. */
  forceGap: boolean
  readonly unwatch: Array<() => void>
}

const now = (): number => performance.now()
const flags = readQueryFlags(location.search)
const caps = detectCapabilities()
const store = createStore(initialState(caps, loadSettings(), flags.debug, now()), CONFIG)
if (flags.debug) window.__soundwave = { state: () => store.get() }

const haptics = new Haptics(CONFIG)
haptics.setEnabled(store.get().settings.haptics && caps.haptics)
const wakeLock = new WakeLockKeeper(() => {
  store.dispatch({ type: 'wakeLockFailed' })
  toast(TEXT.wakeLockFailed)
})

let session: Session | null = null
let starting = false
let lastRmsDb: number = CONFIG.silentDb
/** Frequencies rejected with "Not it", ignored by new detectors until untilMs. */
let exclusions: Array<{ hz: number; untilMs: number }> = []

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('#app missing')
const ui = mountUi(root, {
  onStart: () => beginCapture('start'),
  onRetry: () => beginCapture('retry'),
  onStopRequest,
  onStopConfirm: () => {
    store.dispatch({ type: 'stopConfirm' })
    teardownIfIdle()
  },
  onStopCancel: () => store.dispatch({ type: 'stopCancel' }),
  onConfirmLock: () => store.dispatch({ type: 'confirmLock' }),
  onNotIt,
  onRelisten,
  onResetBest,
  onResume: () => void resumeFromPause(),
  onBack: () => store.dispatch({ type: 'back' }),
  onReload: () => location.reload(),
  onCopyLink: () => void copyLink(),
  onToggleClicks: () => updateSettings({ clicks: !store.get().settings.clicks }),
  onToggleHaptics: () => updateSettings({ haptics: !store.get().settings.haptics }),
}, CONFIG)

// ---- Capture lifecycle ---------------------------------------------------------------------------

/** Must run synchronously inside the click handler: the AudioContext is created and resumed here. */
function beginCapture(via: 'start' | 'retry'): void {
  if (session || starting) return
  starting = true
  let ctx: AudioContext
  try {
    ctx = createAudioContext()
  } catch {
    starting = false
    store.dispatch({ type: via === 'start' ? 'start' : 'retry', nowMs: now() })
    store.dispatch({ type: 'micError', code: 'unsupported' })
    return
  }
  void ctx.resume().catch(() => undefined)
  haptics.unlock()
  void wakeLock.enable()
  store.dispatch({ type: via, nowMs: now() })

  void acquireMic().then((res) => {
    starting = false
    if (!res.ok) {
      void ctx.close().catch(() => undefined)
      wakeLock.disable()
      store.dispatch({ type: 'micError', code: res.code })
      return
    }
    if (store.get().screen.kind !== 'requesting') {
      // Cancelled while the permission prompt was open.
      stopMic(res.mic.stream)
      void ctx.close().catch(() => undefined)
      return
    }
    const clicker = new Clicker(ctx, CONFIG)
    const s: Session = {
      ctx,
      mic: res.mic,
      clicker,
      engine: makeEngine(ctx, res.mic.stream, clicker),
      detector: createDetector(CONFIG, { excludeHz: activeExclusions() }),
      hunt: null,
      forceGap: false,
      unwatch: [],
    }
    session = s
    watchSession(s)
    s.engine.start()
    store.dispatch({ type: 'micReady', mic: micDiag(res.mic, ctx), nowMs: now() })
  })
}

function makeEngine(ctx: AudioContext, stream: MediaStream, clicker: Clicker): Engine {
  return new Engine({
    ctx,
    stream,
    cfg: CONFIG,
    onFrame,
    isTainted: (t0, t1) => clicker.clickedBetween(t0, t1),
  })
}

function micDiag(mic: MicHandle, ctx: AudioContext): MicDiag {
  return {
    echoCancellation: mic.echoCancellation,
    noiseSuppression: mic.noiseSuppression,
    autoGainControl: mic.autoGainControl,
    rawAudio: mic.rawAudio,
    deviceLabel: mic.deviceLabel,
    trackSampleRate: mic.trackSampleRate,
    contextSampleRate: ctx.sampleRate,
    channelCount: mic.channelCount,
  }
}

/** Mic loss (track ended or muted) and context interruptions pause the hunt behind a tap-to-resume. */
function watchSession(s: Session): void {
  const lost = (): void => {
    if (session !== s || document.visibilityState !== 'visible') return
    const kind = store.get().screen.kind
    if (kind !== 'listening' && kind !== 'locked' && kind !== 'hunting' && kind !== 'paused') return
    silence(s)
    store.dispatch({ type: 'micLost' })
  }
  const onState = (): void => {
    const st = s.ctx.state as string // 'interrupted' exists on iOS Safari
    if (st === 'suspended' || st === 'interrupted') lost()
  }
  const track = s.mic.track
  track.addEventListener('ended', lost)
  track.addEventListener('mute', lost)
  s.ctx.addEventListener('statechange', onState)
  s.unwatch.push(() => {
    track.removeEventListener('ended', lost)
    track.removeEventListener('mute', lost)
    s.ctx.removeEventListener('statechange', onState)
  })
}

function silence(s: Session): void {
  s.engine.stop()
  s.clicker.setRate(0)
  haptics.stop()
}

function teardown(): void {
  const s = session
  session = null
  if (!s) return
  for (const off of s.unwatch) off()
  s.engine.dispose()
  s.clicker.dispose()
  stopMic(s.mic.stream)
  void s.ctx.close().catch(() => undefined)
  haptics.stop()
  wakeLock.disable()
  lastRmsDb = CONFIG.silentDb
}

function teardownIfIdle(): void {
  if (store.get().screen.kind === 'idle') teardown()
}

// ---- Frames -------------------------------------------------------------------------------------

function onFrame(raw: Frame): void {
  const s = session
  if (!s) return
  const frame: Frame = s.forceGap ? { ...raw, gap: true } : raw
  s.forceGap = false
  lastRmsDb = frame.rmsDb
  const kind = store.get().screen.kind
  if (kind === 'listening' && s.detector) {
    const lock = detectStep(s.detector, frame, CONFIG)
    if (lock) onLock(s, lock, frame.tMs)
  } else if ((kind === 'locked' || kind === 'hunting') && s.hunt) {
    handleHuntEvents(s, huntStep(s.hunt, frame, CONFIG))
  }
}

function onLock(s: Session, lock: Lock, tMs: number): void {
  s.detector = null
  s.hunt = createHunt(lock, CONFIG)
  s.clicker.setCarrier(chooseClickFreq(lock.f0Hz, CONFIG))
  store.dispatch({ type: 'lock', lock, nowMs: tMs })
  store.dispatch({ type: 'hunt', view: huntView(s.hunt, tMs, CONFIG) })
  if (store.get().settings.haptics) haptics.pulse(CONFIG.hapticReadingPattern)
}

function handleHuntEvents(s: Session, events: readonly HuntEvent[]): void {
  for (const e of events) {
    if (e.type === 'reading') {
      if (store.get().settings.haptics) haptics.pulse(CONFIG.hapticReadingPattern)
      if (s.hunt) s.clicker.setCarrier(chooseClickFreq(huntView(s.hunt, now(), CONFIG).f0Hz, CONFIG))
    } else if (e.type === 'mode') {
      toast(e.mode === 'live' ? TEXT.modeLive : TEXT.modeChirp)
    }
  }
}

// ---- Controls -----------------------------------------------------------------------------------

function onStopRequest(): void {
  const kind = store.get().screen.kind
  if (kind === 'requesting') {
    // The permission prompt is still open; acquireMic's callback cleans up the context.
    store.dispatch({ type: 'stopRequest' })
    return
  }
  store.dispatch({ type: 'stopRequest' })
  teardownIfIdle()
}

function onNotIt(): void {
  const s = session
  const lock = store.get().lock
  if (lock) exclusions.push({ hz: lock.f0Hz, untilMs: now() + CONFIG.notItExcludeMs })
  if (s) {
    s.hunt = null
    s.detector = createDetector(CONFIG, { excludeHz: activeExclusions() })
    s.clicker.setRate(0)
  }
  store.dispatch({ type: 'notIt', nowMs: now() })
}

function onRelisten(): void {
  const s = session
  if (s) {
    s.hunt = null
    s.detector = createDetector(CONFIG, { excludeHz: activeExclusions() })
    s.clicker.setRate(0)
  }
  haptics.setTier(null)
  store.dispatch({ type: 'relisten', nowMs: now() })
}

function onResetBest(): void {
  const s = session
  if (!s?.hunt) return
  resetBest(s.hunt, CONFIG)
  store.dispatch({ type: 'resetBest' })
  store.dispatch({ type: 'hunt', view: huntView(s.hunt, now(), CONFIG) })
}

function activeExclusions(): number[] {
  const t = now()
  exclusions = exclusions.filter((e) => e.untilMs > t)
  return exclusions.map((e) => e.hz)
}

function updateSettings(patch: { clicks?: boolean; haptics?: boolean }): void {
  store.dispatch({ type: 'settings', patch })
  const settings = store.get().settings
  saveSettings(settings)
  haptics.setEnabled(settings.haptics && caps.haptics)
}

function toast(text: string): void {
  store.dispatch({ type: 'toast', text, nowMs: now() })
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(location.href)
    toast(TEXT.linkCopied)
  } catch {
    toast(location.href)
  }
}

// ---- Background / foreground --------------------------------------------------------------------

onVisibilityChange((visible) => {
  const s = session
  if (!s) return
  const kind = store.get().screen.kind
  if (!visible) {
    if (kind === 'listening' || kind === 'locked' || kind === 'hunting') {
      silence(s)
      store.dispatch({ type: 'hidden' })
    }
    return
  }
  if (kind !== 'paused') return
  void tryAutoResume(s)
})

async function tryAutoResume(s: Session): Promise<void> {
  try {
    await Promise.race([s.ctx.resume(), new Promise((r) => setTimeout(r, 600))])
  } catch {
    // needs a gesture
  }
  if (session !== s) return
  const healthy = s.ctx.state === 'running' && s.mic.track.readyState === 'live' && !s.mic.track.muted
  if (healthy) restartEngine(s)
  store.dispatch({ type: 'visible', healthy })
}

/** Tap-to-resume (a user gesture): resume the context and, if the track died, re-open the mic. */
async function resumeFromPause(): Promise<void> {
  const s = session
  if (!s) return
  try {
    await s.ctx.resume()
  } catch {
    // reported below via state
  }
  if (s.mic.track.readyState !== 'live' || s.mic.track.muted) {
    const res = await acquireMic()
    if (session !== s) {
      if (res.ok) stopMic(res.mic.stream)
      return
    }
    if (!res.ok) {
      teardown()
      store.dispatch({ type: 'micError', code: res.code })
      return
    }
    for (const off of s.unwatch.splice(0)) off()
    s.engine.dispose()
    stopMic(s.mic.stream)
    s.mic = res.mic
    s.engine = makeEngine(s.ctx, res.mic.stream, s.clicker)
    watchSession(s)
  }
  if (s.ctx.state !== 'running') return // still blocked; the overlay stays
  restartEngine(s)
  store.dispatch({ type: 'resumed' })
  void wakeLock.enable()
}

function restartEngine(s: Session): void {
  s.forceGap = true
  s.engine.start()
}

// ---- Render + feedback loop ---------------------------------------------------------------------

function micLevel(rmsDb: number): number {
  const x = (rmsDb - CONFIG.micLevelFloorDb) / (CONFIG.micLevelCeilDb - CONFIG.micLevelFloorDb)
  return Math.max(0, Math.min(1, x))
}

/** Warmth that drives clicks and haptics, or null for silence. */
function feedbackWarmth(s: AppState): number | null {
  if (s.screen.kind !== 'hunting' || !s.hunt) return null
  if (flags.forceWarmth !== null) return flags.forceWarmth // self-noise test: ignores the hold window
  if (s.hunt.holdActive) return null
  return s.hunt.warmth
}

function updateFeedback(s: AppState): void {
  const sess = session
  if (!sess) return
  const w = feedbackWarmth(s)
  sess.clicker.setRate(w === null || !s.settings.clicks ? 0 : clickRateHz(w, CONFIG))
  const view = s.hunt
  const clipped = view ? (view.mode === 'live' ? (view.live?.clipped ?? false) : (view.last?.clipped ?? false)) : false
  haptics.setTier(w === null || !s.settings.haptics ? null : vibrationTier(w, clipped, CONFIG))
}

function loop(): void {
  const t = now()
  store.dispatch({ type: 'tick', nowMs: t, micLevel: session ? micLevel(lastRmsDb) : 0 })
  const s = session
  const kind = store.get().screen.kind
  if (s?.hunt && (kind === 'locked' || kind === 'hunting')) store.dispatch({ type: 'hunt', view: huntView(s.hunt, t, CONFIG) })
  const state = store.get()
  updateFeedback(state)
  ui.render(state)
  requestAnimationFrame(loop)
}

window.addEventListener('pagehide', teardown)
requestAnimationFrame(loop)
