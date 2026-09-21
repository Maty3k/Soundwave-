/**
 * Wiring only. The Start gesture creates the AudioContext and opens the mic; frames flow into the
 * detector (listening), the hunt (locked / hunting) or, on a station device, the station runtime.
 * A requestAnimationFrame loop pushes snapshots (hunt, radar, stations, station mode) and a clock
 * tick into the store, drives clicks and haptics, and renders. All decisions live in the pure
 * modules (src/dsp, src/app.ts) and the runtimes (hub, station, extra mics).
 */
import './style.css'
import { CONFIG } from './config.ts'
import type { AppState, Frame, HuntEvent, HuntPanel, Lock, LogEntry, MicDiag, PendingBeep, Reading } from './types.ts'
import { createStore, initialState } from './app.ts'
import { mountUi } from './ui.ts'
import { LOG_COPY, logAsText, STATIONS_COPY, TEXT } from './copy.ts'
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
import { HeadingSource } from './orientation.ts'
import { acquireMic, stopMic, type MicHandle } from './audio/mic.ts'
import { Engine } from './audio/engine.ts'
import { Clicker } from './audio/clicker.ts'
import { createDetector, detectStep, lockFromPending, pendingBeep, type DetectorState } from './dsp/detect.ts'
import { createHunt, huntStep, huntView, resetBest, type HuntState } from './dsp/hunt.ts'
import { chooseClickFreqSticky, clickRateHz, vibrationTier } from './dsp/geiger.ts'
import { addRadarSample, clearRadar, createRadar, radarView, raiseLastSample, type RadarState } from './dsp/radar.ts'
import { StationHub } from './hub.ts'
import { StationRuntime } from './stationMode.ts'
import { ExtraMic, listAudioInputs, type AudioInput } from './extraMics.ts'
import { qrScanSupported } from './net/qr.ts'

declare global {
  interface Window {
    /** Read-only state accessor, present only with ?debug (used by the end-to-end checks). */
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
  /** Current click carrier; kept while it still suits the (slowly drifting) locked frequency. */
  carrierHz: number | null
  /** Direction-scan accumulator while the Direction tab is open. */
  radar: RadarState | null
  /** A frame arrived since the loop last sampled the live radar. */
  newFrame: boolean
  /** The next frame must be flagged as a gap (after a pause), so open measurements are discarded. */
  forceGap: boolean
  readonly unwatch: Array<() => void>
  /** Stations and extra microphones compared per chirp (created on the first lock). */
  hub: StationHub | null
  readonly extraMics: Map<string, ExtraMic>
  /** Other microphones on this device that could be added. */
  inputs: AudioInput[]
}

/** This device used as a listening station for another device's hunt. */
interface StationSession {
  readonly runtime: StationRuntime
  ctx: AudioContext | null
  mic: MicHandle | null
  engine: Engine | null
}

const now = (): number => performance.now()
/** Epoch ms of an app-clock (performance.now) time, for display. */
const wallMs = (tMs: number): number => Date.now() - (performance.now() - tMs)
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
const heading = new HeadingSource(CONFIG)
/**
 * WebKit (Safari on iPhone, iPad and probably macOS) captures one microphone at a time: opening a
 * second one ends or mutes the first. Extra microphones are only offered elsewhere.
 */
const singleMicPlatform =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
  /^((?!chrome|chromium|crios|fxios|edg|android).)*safari/i.test(navigator.userAgent)

let canScan = false
void qrScanSupported().then((ok) => {
  canScan = ok
})

let session: Session | null = null
let station: StationSession | null = null
/** Increments on every capture attempt; a stale getUserMedia result (after Cancel) is discarded. */
let captureSeq = 0
let lastRmsDb: number = CONFIG.silentDb
/** Frequencies rejected with "Wrong sound", ignored by new detectors until untilMs. */
let exclusions: Array<{ hz: number; untilMs: number }> = []
/** When the last Try again was tapped, to explain a repeated permission error. */
let retryAtMs = -Infinity
let stationsDirty = false
let stationDirty = false
let lastPendingKey = ''
let lastPendingCheckMs = 0
let lastLiveReportMs = 0
/**
 * Log entries are keyed per hunt: reading ids restart at 1 in every hunt while the log is kept
 * across Listen again, so entry id = huntSeq * LOG_ID_STRIDE + reading id.
 */
let huntSeq = 0
const LOG_ID_STRIDE = 100_000
const logId = (readingId: number): number => huntSeq * LOG_ID_STRIDE + readingId
let lastStationViewMs = 0
let wasHolding = false

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('#app missing')
const ui = mountUi(
  root,
  {
    onStart: () => beginCapture('start'),
    onRetry: () => {
      retryAtMs = now()
      beginCapture('retry')
    },
    onStopRequest,
    onStopConfirm: () => {
      store.dispatch({ type: 'stopConfirm' })
      teardownIfIdle()
    },
    onStopCancel: () => store.dispatch({ type: 'stopCancel' }),
    onConfirmLock: () => store.dispatch({ type: 'confirmLock' }),
    onHoldLock: () => store.dispatch({ type: 'holdLock' }),
    onNotIt,
    onUseNow,
    onRelistenConfirm,
    onResetBest,
    onResume: () => void resumeFromPause(),
    onBack: () => store.dispatch({ type: 'back' }),
    onReload: () => location.reload(),
    onCopyLink: () => void copyText(location.href, TEXT.linkCopied, TEXT.linkCopyFailed),
    onToggleClicks: () => updateSettings({ clicks: !store.get().settings.clicks }),
    onToggleHaptics: () => updateSettings({ haptics: !store.get().settings.haptics }),
    onPanel,
    onScanClear: () => {
      if (session?.radar) clearRadar(session.radar)
    },
    onLogNote: (id, note) => store.dispatch({ type: 'logNote', id, note }),
    onCopyLog: () => {
      const st = store.get()
      void copyText(logAsText(st.log, st.hunt?.f0Hz ?? st.lock?.f0Hz ?? null), LOG_COPY.copied, LOG_COPY.copyFailed)
    },
    onPairStart: () => void session?.hub?.startPairing(),
    onPairStep: (step) => session?.hub?.setPairStep(step),
    onPairAnswer: (code) => void session?.hub?.acceptAnswer(code),
    onPairCancel: () => session?.hub?.cancelPairing(),
    onAddMic: (deviceId) => void addExtraMic(deviceId),
    onRemoveListener,
    onCalibrate: () => session?.hub?.calibrate(),
    onCopyCode: (code) => void copyText(code, TEXT.codeCopied, TEXT.codeCopyFailed),
    onShareCode: (code) => void shareText(code),
    onStationMode,
    onStationName,
    onStationStep: (step) => station?.runtime.setStep(step),
    onStationOffer: (code) => void station?.runtime.acceptOffer(code),
    onStationStop: stopStation,
  },
  CONFIG,
)

// ---- Capture lifecycle (hunting device) ---------------------------------------------------------

/** Must run synchronously inside the click handler: the AudioContext is created and resumed here. */
function beginCapture(via: 'start' | 'retry'): void {
  if (session || station || store.get().screen.kind === 'requesting') return
  const seq = ++captureSeq
  let ctx: AudioContext
  try {
    ctx = createAudioContext()
  } catch {
    store.dispatch({ type: via, nowMs: now() })
    store.dispatch({ type: 'micError', code: 'unsupported' })
    return
  }
  void ctx.resume().catch(() => undefined)
  haptics.unlock()
  void wakeLock.enable()
  store.dispatch({ type: via, nowMs: now() })

  void acquireMic().then((res) => {
    const current = seq === captureSeq && store.get().screen.kind === 'requesting'
    if (!current) {
      // Cancelled while the permission prompt was open (or superseded by a newer attempt).
      if (res.ok) stopMic(res.mic.stream)
      void ctx.close().catch(() => undefined)
      return
    }
    if (!res.ok) {
      void ctx.close().catch(() => undefined)
      wakeLock.disable()
      store.dispatch({ type: 'micError', code: res.code })
      if (via === 'retry' && res.code === 'permission' && now() - retryAtMs < 1500) toast(TEXT.stillBlocked)
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
      carrierHz: null,
      radar: null,
      newFrame: false,
      forceGap: false,
      unwatch: [],
      hub: null,
      extraMics: new Map(),
      inputs: [],
    }
    session = s
    watchSession(s)
    s.engine.start()
    store.dispatch({ type: 'micReady', mic: micDiag(res.mic, ctx), nowMs: now() })
    void refreshInputs(s)
  })
}

function makeEngine(ctx: AudioContext, stream: MediaStream, clicker: Clicker | null, onFrameFn: (f: Frame) => void = onFrame): Engine {
  return new Engine({
    ctx,
    stream,
    cfg: CONFIG,
    onFrame: onFrameFn,
    ...(clicker ? { isTainted: (t0: number, t1: number) => clicker.clickedBetween(t0, t1) } : {}),
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
  stopScanSensors()
  const s = session
  session = null
  if (!s) return
  for (const off of s.unwatch) off()
  s.hub?.dispose()
  if (s.hub) store.dispatch({ type: 'stations', view: null })
  for (const m of s.extraMics.values()) m.dispose()
  s.extraMics.clear()
  s.engine.dispose()
  s.clicker.dispose()
  stopMic(s.mic.stream)
  void s.ctx.close().catch(() => undefined)
  haptics.stop()
  wakeLock.disable()
  lastRmsDb = CONFIG.silentDb
  lastPendingKey = ''
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
  s.newFrame = true
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
  huntSeq++
  s.hunt = createHunt(lock, CONFIG)
  s.carrierHz = chooseClickFreqSticky(lock.f0Hz, null, CONFIG)
  s.clicker.setCarrier(s.carrierHz)
  lastPendingKey = ''
  store.dispatch({ type: 'pending', pending: null })
  store.dispatch({ type: 'lock', lock, nowMs: tMs })
  const view = huntView(s.hunt, tMs, CONFIG)
  store.dispatch({ type: 'hunt', view })
  if (store.get().settings.haptics) haptics.pulse(CONFIG.hapticReadingPattern)
  // Other listeners follow the same frequency.
  if (!s.hub) {
    s.hub = new StationHub({ cfg: CONFIG, now, onChange: () => (stationsDirty = true), hubName: selfName() })
    s.hub.addLocalListener('self', selfName(), 'self')
  }
  followLock(s, lock.f0Hz, view.mode)
  // The chirps heard while listening are the first readings: log them.
  for (const r of view.readings) logReading(s, r)
}

function selfName(): string {
  return caps.haptics ? STATIONS_COPY.selfName : STATIONS_COPY.selfNameDevice
}

/** Tell the hub (stations) and the extra microphones which frequency and mode to follow. */
function followLock(s: Session, f0Hz: number | null, mode: 'chirp' | 'live' | null): void {
  s.hub?.setLock(f0Hz, mode)
  for (const m of s.extraMics.values()) m.setLock(f0Hz === null || mode === null ? null : { f0Hz, mode })
}

function handleHuntEvents(s: Session, events: readonly HuntEvent[]): void {
  for (const e of events) {
    switch (e.type) {
      case 'reading': {
        if (store.get().settings.haptics) haptics.pulse(CONFIG.hapticReadingPattern)
        const view = s.hunt ? huntView(s.hunt, now(), CONFIG) : null
        if (view) {
          const carrier = chooseClickFreqSticky(view.f0Hz, s.carrierHz, CONFIG)
          if (carrier !== s.carrierHz) {
            s.carrierHz = carrier
            s.clicker.setCarrier(carrier)
          }
          followLock(s, view.f0Hz, view.mode)
        }
        // Direction scan (chirp mode): one sample per reading, at the heading held during the chirp.
        const h = heading.headingDeg
        if (s.radar?.mode === 'chirp' && h !== null && !e.reading.clipped) addRadarSample(s.radar, h, e.reading.levelDb)
        s.hub?.report('self', e.reading)
        logReading(s, e.reading)
        break
      }
      case 'readingUpdated':
        // A chirp group grew (double chirp, UPS burst): keep the louder level for the same direction.
        if (s.radar?.mode === 'chirp' && !e.reading.clipped) raiseLastSample(s.radar, e.reading.levelDb)
        s.hub?.report('self', e.reading)
        logReading(s, e.reading)
        break
      case 'mode': {
        toast(e.mode === 'live' ? TEXT.modeLive : TEXT.modeChirp)
        // The two modes use different sector layouts: start the scan over.
        if (s.radar) s.radar = createRadar(e.mode, CONFIG)
        const f0 = s.hunt ? huntView(s.hunt, now(), CONFIG).f0Hz : null
        followLock(s, f0, e.mode)
        break
      }
      case 'onset':
      case 'missed':
        break
    }
  }
}

/** Add or update the log line of a reading (the reducer keeps the user's note). */
function logReading(s: Session, r: Reading): void {
  const f0Hz = s.hunt ? huntView(s.hunt, r.tMs, CONFIG).f0Hz : (store.get().lock?.f0Hz ?? 0)
  const id = logId(r.id)
  const existing = store.get().log.find((x) => x.id === id)
  const entry: LogEntry = {
    id,
    wallMs: existing?.wallMs ?? wallMs(r.tMs),
    verdict: r.verdict,
    deltaPrevDb: r.deltaPrevDb,
    pct: r.pct,
    levelDb: r.levelDb,
    f0Hz,
    clipped: r.clipped,
    chirpCount: r.chirpCount,
    source: r.source,
    loudest: s.hub?.loudestNameFor(r.id) ?? null,
    note: existing?.note ?? '',
  }
  store.dispatch({ type: 'logUpsert', entry })
}

/** Stations report a little after the hub's own reading: refresh the "loudest" of recent log lines. */
function refreshLogLoudest(s: Session): void {
  const hub = s.hub
  if (!hub) return
  const log = store.get().log
  for (let i = Math.max(0, log.length - 3); i < log.length; i++) {
    const e = log[i]!
    // Only entries of the current hunt map onto the hub's reading ids.
    if (Math.floor(e.id / LOG_ID_STRIDE) !== huntSeq) continue
    const loudest = hub.loudestNameFor(e.id % LOG_ID_STRIDE)
    if (loudest !== e.loudest) store.dispatch({ type: 'logUpsert', entry: { ...e, loudest } })
  }
}

// ---- Controls -----------------------------------------------------------------------------------

function onStopRequest(): void {
  // From requesting, the pending getUserMedia callback cleans up its own context.
  store.dispatch({ type: 'stopRequest' })
  teardownIfIdle()
}

function onNotIt(): void {
  const lock = store.get().lock
  if (lock) exclusions.push({ hz: lock.f0Hz, untilMs: now() + CONFIG.notItExcludeMs })
  restartListening()
  store.dispatch({ type: 'notIt', nowMs: now() })
}

function onUseNow(): void {
  const s = session
  if (!s?.detector || store.get().screen.kind !== 'listening') return
  const lock = lockFromPending(s.detector, now(), CONFIG)
  if (lock) onLock(s, lock, now())
}

function onRelistenConfirm(): void {
  const st = store.get()
  // A hunt that barely started was probably on the wrong sound: do not lock onto it again.
  if (st.lock && (st.hunt?.readings.length ?? 0) <= 1) exclusions.push({ hz: st.lock.f0Hz, untilMs: now() + CONFIG.notItExcludeMs })
  if (st.scan.open) store.dispatch({ type: 'scanClose' })
  restartListening()
  haptics.setTier(null)
  store.dispatch({ type: 'relisten', nowMs: now() })
}

/** Back to listening with a fresh detector; other listeners stop following the old frequency. */
function restartListening(): void {
  stopScanSensors()
  const s = session
  if (!s) return
  s.hunt = null
  s.detector = createDetector(CONFIG, { excludeHz: activeExclusions() })
  s.clicker.setRate(0)
  followLock(s, null, null)
  lastPendingKey = ''
  store.dispatch({ type: 'pending', pending: null })
}

function onResetBest(): void {
  const s = session
  if (!s?.hunt) return
  resetBest(s.hunt, CONFIG)
  store.dispatch({ type: 'resetBest' })
  store.dispatch({ type: 'hunt', view: huntView(s.hunt, now(), CONFIG) })
  toast(TEXT.resetBest)
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

async function copyText(text: string, ok: string, failed: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(ok)
  } catch {
    toast(failed)
  }
}

async function shareText(text: string): Promise<void> {
  if (typeof navigator.share !== 'function') {
    await copyText(text, TEXT.codeCopied, TEXT.codeCopyFailed)
    return
  }
  try {
    await navigator.share({ text })
  } catch {
    // Dismissed by the user, or not allowed: nothing to report.
  }
}

// ---- Hunting panels and the direction scan ------------------------------------------------------

/**
 * A hunting tab was chosen. Runs inside the click: entering Direction starts the compass
 * (HeadingSource.start asks iOS for access synchronously, which only works during a gesture).
 */
function onPanel(panel: HuntPanel): void {
  const prev = store.get().panel
  if (panel === prev) return
  store.dispatch({ type: 'panel', panel })
  if (store.get().panel !== panel) return // not allowed here (e.g. no compass)
  if (prev === 'direction') closeScan()
  if (panel === 'direction') openScan()
  if (panel === 'stations') stationsDirty = true
}

function openScan(): void {
  const s = session
  if (!s?.hunt || store.get().screen.kind !== 'hunting') return
  store.dispatch({ type: 'scanOpen' })
  if (!store.get().scan.open) return
  void heading.start().then((status) => {
    const cur = session
    if (!store.get().scan.open || cur === null || cur.hunt === null) {
      heading.stop()
      return
    }
    if (status !== 'ok') {
      heading.stop()
      store.dispatch({ type: 'scanStatus', status })
      return
    }
    cur.radar = createRadar(huntView(cur.hunt, now(), CONFIG).mode, CONFIG)
    store.dispatch({ type: 'scanStatus', status: 'active' })
  })
}

function closeScan(): void {
  stopScanSensors()
  if (store.get().scan.open) store.dispatch({ type: 'scanClose' })
}

function stopScanSensors(): void {
  heading.stop()
  if (session) session.radar = null
}

// ---- Extra microphones and stations (hub side) --------------------------------------------------

/** Microphones on this device other than the one in use (none on single-mic platforms). */
async function refreshInputs(s: Session): Promise<void> {
  if (singleMicPlatform) {
    s.inputs = []
    return
  }
  const mainId = s.mic.track.getSettings().deviceId ?? null
  const all = await listAudioInputs()
  if (session !== s) return
  s.inputs = all.filter((i) => i.deviceId !== mainId)
  stationsDirty = true
}

function availableMics(s: Session): Array<{ deviceId: string; label: string }> {
  return s.inputs.filter((i) => !s.extraMics.has(`mic:${i.deviceId}`)).map((i) => ({ deviceId: i.deviceId, label: i.label }))
}

async function addExtraMic(deviceId: string): Promise<void> {
  const s = session
  const hub = s?.hub
  if (!s || !hub) return
  const input = s.inputs.find((i) => i.deviceId === deviceId)
  if (!input || s.extraMics.has(`mic:${deviceId}`)) return
  const mic: ExtraMic = new ExtraMic({
    ctx: s.ctx,
    input,
    cfg: CONFIG,
    now,
    onReading: (r) => hub.report(mic.id, r),
    onLive: (levelDb, clipped) => hub.liveLevel(mic.id, levelDb, clipped),
    onEnded: () => onRemoveListener(mic.id),
    isTainted: (t0, t1) => s.clicker.clickedBetween(t0, t1),
  })
  s.extraMics.set(mic.id, mic)
  hub.addLocalListener(mic.id, mic.label, 'mic')
  stationsDirty = true
  const res = await mic.start()
  if (session !== s || !s.extraMics.has(mic.id)) return
  if (res !== 'ok') {
    s.extraMics.delete(mic.id)
    mic.dispose()
    hub.removeListener(mic.id)
    toast(TEXT.micAddFailed)
    return
  }
  const view = s.hunt ? huntView(s.hunt, now(), CONFIG) : null
  if (view) mic.setLock({ f0Hz: view.f0Hz, mode: view.mode })
}

function onRemoveListener(id: string): void {
  const s = session
  if (!s) return
  const mic = s.extraMics.get(id)
  if (mic) {
    s.extraMics.delete(id)
    mic.dispose()
  }
  s.hub?.removeListener(id)
  stationsDirty = true
}

// ---- Station mode (this device helps another device's hunt) -------------------------------------

function onStationMode(): void {
  if (session || station) return
  station = {
    runtime: new StationRuntime({ cfg: CONFIG, now, onChange: () => (stationDirty = true) }),
    ctx: null,
    mic: null,
    engine: null,
  }
  store.dispatch({ type: 'stationStart' })
  pushStationView(true)
}

/** Must run synchronously inside the Start click: the AudioContext is created and resumed here. */
function onStationName(name: string): void {
  const st = station
  if (!st || st.ctx) return
  st.runtime.setName(name)
  let ctx: AudioContext
  try {
    ctx = createAudioContext()
  } catch {
    toast(TEXT.stationMicFailed)
    stopStation()
    return
  }
  st.ctx = ctx
  void ctx.resume().catch(() => undefined)
  void wakeLock.enable()
  pushStationView(true)
  void acquireMic().then((res) => {
    if (station !== st) {
      if (res.ok) stopMic(res.mic.stream)
      return
    }
    if (!res.ok) {
      toast(TEXT.stationMicFailed)
      stopStation()
      return
    }
    st.mic = res.mic
    st.engine = makeEngine(ctx, res.mic.stream, null, (f) => st.runtime.onFrame(f))
    st.engine.start()
    st.runtime.setRawAudio(res.mic.rawAudio)
    st.runtime.micReady(canScan)
    pushStationView(true)
  })
}

function stopStation(): void {
  const st = station
  station = null
  if (st) {
    st.runtime.dispose()
    st.engine?.dispose()
    if (st.mic) stopMic(st.mic.stream)
    void st.ctx?.close().catch(() => undefined)
    wakeLock.disable()
  }
  store.dispatch({ type: 'stationStop' })
}

function pushStationView(force = false): void {
  const st = station
  if (!st || store.get().screen.kind !== 'station') return
  const t = now()
  if (!force && !stationDirty && t - lastStationViewMs < 200) return
  stationDirty = false
  lastStationViewMs = t
  store.dispatch({ type: 'stationView', view: st.runtime.view(canScan) })
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
  // Fresh clock first, so a resumed listening screen does not count the time spent hidden.
  store.dispatch({ type: 'tick', nowMs: now() })
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
  store.dispatch({ type: 'tick', nowMs: now() })
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

/** Warmth that drives the click rate, or null for silence. */
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
  // A clipped reading buzzes even before the meter has a value (the first reading can already clip).
  const holding = s.screen.kind === 'hunting' && (view?.holdActive ?? false)
  const quiet = s.screen.kind !== 'hunting' || !view || holding || !s.settings.haptics
  haptics.setTier(quiet ? null : clipped ? vibrationTier(w, true, CONFIG) : w === null ? null : vibrationTier(w, false, CONFIG))
  // One short buzz when it is time to freeze (the clicks stop at the same moment).
  if (holding && !wasHolding && s.settings.haptics && view?.mode === 'chirp') haptics.pulse(CONFIG.hapticReadingPattern)
  wasHolding = holding
}

/** Live-mode scan: sample the beep's band level at the current heading while it is heard. */
function sampleLiveRadar(s: Session, state: AppState): void {
  const radar = s.radar
  const view = state.hunt
  const h = heading.headingDeg
  if (!radar || radar.mode !== 'live' || !view || view.mode !== 'live' || !s.newFrame || h === null) return
  s.newFrame = false
  if (view.hearing && !(view.live?.clipped ?? false)) addRadarSample(radar, h, view.levelDb)
}

/** Listening: show a beep heard once while waiting for the confirming chirp (changes only). */
function updatePending(s: Session, t: number): void {
  if (!s.detector || t - lastPendingCheckMs < 200) return
  lastPendingCheckMs = t
  const p: PendingBeep | null = pendingBeep(s.detector, t, CONFIG)
  const key = p ? `${Math.round(p.f0Hz)}|${p.sightings}|${Math.round(p.heardAtMs)}` : ''
  if (key === lastPendingKey) return
  lastPendingKey = key
  store.dispatch({ type: 'pending', pending: p })
}

function updateStations(s: Session, t: number): void {
  const hub = s.hub
  if (!hub) return
  const view = store.get().hunt
  // Self live level for the live comparison, at the stations' report rate.
  if (view?.mode === 'live' && view.live && t - lastLiveReportMs >= CONFIG.stationLevelReportMs) {
    lastLiveReportMs = t
    hub.liveLevel('self', view.live.levelDb, view.live.clipped)
  }
  hub.tick()
  if (stationsDirty) {
    stationsDirty = false
    store.dispatch({ type: 'stations', view: hub.view(availableMics(s), canScan) })
    refreshLogLoudest(s)
  }
}

function loop(): void {
  const t = now()
  store.dispatch({ type: 'tick', nowMs: t, micLevel: session || station ? micLevel(lastRmsDb) : 0 })
  const s = session
  const kind = store.get().screen.kind
  if (s) {
    if (kind === 'listening') updatePending(s, t)
    if (s.hunt && (kind === 'locked' || kind === 'hunting')) store.dispatch({ type: 'hunt', view: huntView(s.hunt, t, CONFIG) })
    // The hub keeps pinging its stations whenever it exists (also while listening again).
    updateStations(s, t)
    if (store.get().scan.open) {
      sampleLiveRadar(s, store.get())
      if (s.radar) store.dispatch({ type: 'radar', view: radarView(s.radar, heading.headingDeg, CONFIG) })
    }
  }
  if (station) pushStationView()
  const state = store.get()
  updateFeedback(state)
  ui.render(state)
  requestAnimationFrame(loop)
}

window.addEventListener('pagehide', () => {
  teardown()
  if (station) stopStation()
})
requestAnimationFrame(loop)
