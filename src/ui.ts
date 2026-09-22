/**
 * DOM rendering for every screen, without a framework.
 *
 * mountUi builds the shell once; render(state) is called at most once per animation frame. A
 * screen's DOM is rebuilt only when its identity changes (screen kind, paused origin and
 * needsGesture, or error code); the confirmation dialog is its own layer. Everything else is
 * patched in place: text via textContent (never innerHTML), attributes, and CSS custom properties
 * (--pct, --ghost, --best, --level, --p). Each patch is skipped when the value did not change,
 * because render runs about 60 times per second while hunting.
 *
 * Hunting screen, top to bottom: one-row top bar (frequency, mode, Clicks, Vibrate), the verdict
 * hero, the status bar ("what to do now": move, or hold still), a tab row (Meter, Direction when
 * there is a compass, Log, Stations) with the selected panel under it, and a sticky bottom bar
 * (Listen again, Found it, Stop). Tabs follow state.panel; choosing one calls handlers.onPanel, and
 * main opens or closes the compass in reaction. The Log and Stations panels come from src/ui/ and
 * are created the first time their tab opens and rendered only while it is open.
 *
 * Found it screen: a check mark, the title, a summary of the hunt (state.found), a battery tip,
 * the notes typed in the log ("Where you were") and the way on: Done, New hunt, Copy log, and
 * Keep hunting for when it was not it after all.
 */
import type { Config } from './config.ts'
import {
  COPY,
  countdownText,
  debugText,
  deltaLine,
  ERROR_COPY,
  errorBody,
  formatClock,
  formatClockTime,
  formatHz,
  formatPct,
  FOUND_COPY,
  HISTORY_COPY,
  ignoredSoundsText,
  foundListenersParts,
  foundSummaryParts,
  GUIDANCE,
  guidanceText,
  heardText,
  heroLabel,
  historyItemLabel,
  historyItemText,
  liveAnnouncement,
  LOG_COPY,
  liveDeltaLine,
  meterValueText,
  pendingSightingsText,
  pendingText,
  PERMISSION_HELP,
  rawAudioText,
  readingAnnouncement,
  tabName,
  verdictLabel,
} from './copy.ts'
import type { ErrorAction, Platform } from './copy.ts'
import type {
  AppState,
  ErrorCode,
  FoundSummary,
  HuntPanel,
  HuntView,
  LockMode,
  MicDiag,
  PausedFrom,
  Reading,
  Screen,
  StationsView,
  Verdict,
} from './types.ts'
import { createRadarPanel } from './radarUi.ts'
import { createHistoryPanel } from './ui/historyPanel.ts'
import { createLogPanel } from './ui/logPanel.ts'
import { createStationsPanel } from './ui/stationsPanel.ts'
import { createStationScreen } from './ui/stationScreen.ts'

/** Callbacks for every control. main.ts turns them into store events and side effects. */
export interface UiHandlers {
  onStart(): void
  onStopRequest(): void
  onStopConfirm(): void
  onStopCancel(): void
  onConfirmLock(): void
  /** The person touched the locked screen (pointer, key or focus): dispatch 'holdLock'. */
  onHoldLock(): void
  onNotIt(): void
  /** Listening: lock onto the pending beep now instead of waiting for it to chirp again. */
  onUseNow(): void
  /**
   * "I heard it": the person just heard the beep. Listening: look back config.heardItWindowMs and
   * lock on it. Hunting: count a sound the filters set aside in that window.
   */
  onHeardIt(): void
  /**
   * Hunting: listen again. The ui asks for confirmation itself once the hunt has
   * cfg.stopConfirmMinReadings readings, so this call is always final.
   */
  onRelistenConfirm(): void
  onResetBest(): void
  /** Hunting: the beep is found. main builds the summary, pauses the audio and shows the Found it screen. */
  onFound(): void
  /** Found it: not it after all; resume the same hunt. */
  onKeepHunting(): void
  /** Found it: finish (the session ends like a confirmed Stop). */
  onFoundDone(): void
  /** Found it: end this session and start listening for another beep. Runs inside the click. */
  onNewHunt(): void
  /** Found it: the name of the hunt's past-hunts record was edited (sent debounced and on blur). */
  onHistoryLabel(id: number, label: string): void
  /** Start screen: remove a past hunt. */
  onHistoryRemove(id: number): void
  onResume(): void
  onRetry(): void
  onBack(): void
  onReload(): void
  onCopyLink(): void
  onToggleClicks(): void
  onToggleHaptics(): void
  /**
   * A hunting tab was chosen (click, or arrow keys on the tab row). Runs inside the event, so main
   * can open the compass here when entering 'direction' (iOS only asks during a gesture) and close
   * it when leaving.
   */
  onPanel(panel: HuntPanel): void
  onScanClear(): void

  // Log panel (src/ui/logPanel.ts); Copy log is also on the Found it screen.
  onLogNote(id: number, note: string): void
  onCopyLog(): void

  // Stations panel (src/ui/stationsPanel.ts).
  onPairStart(): void
  onPairStep(step: 'showOffer' | 'scanAnswer' | 'pasteAnswer'): void
  onPairAnswer(code: string): void
  onPairCancel(): void
  onAddMic(deviceId: string): void
  onRemoveListener(id: string): void
  onCalibrate(): void
  onCopyCode(code: string): void
  onShareCode(code: string): void

  // Station mode: the landing button and the station screen (src/ui/stationScreen.ts).
  onStationMode(): void
  onStationName(name: string): void
  onStationStep(step: 'scanOffer' | 'pasteOffer'): void
  onStationOffer(code: string): void
  onStationStop(): void
}

// ---- Tiny DOM helpers ----------------------------------------------------------------------------

type AttrValue = string | number | boolean | null | undefined
type Child = Node | string | null

/** createElement with attributes (false / null / undefined skipped, true -> empty) and text-safe children. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, AttrValue>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    el.setAttribute(name, value === true ? '' : String(value))
  }
  for (const child of children) if (child !== null) el.append(child) // strings become text nodes
  return el
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Readonly<Record<string, string>>, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value)
  el.append(...children)
  return el
}

const textCache = new WeakMap<Node, string>()

/** Set textContent only when it differs from what this module last wrote. */
function setText(el: HTMLElement, text: string): void {
  if (textCache.get(el) === text) return
  textCache.set(el, text)
  el.textContent = text
}

/**
 * Always rewrite a live region's text, even when it is unchanged: assigning textContent replaces
 * the text node, which screen readers announce again (two WARMER readings in a row are two news).
 */
function announce(el: HTMLElement, text: string): void {
  textCache.set(el, text)
  el.textContent = text
}

/** Set or remove (null) an attribute only when it changes. */
function setAttr(el: Element, name: string, value: string | null): void {
  if (el.getAttribute(name) === value) return
  if (value === null) el.removeAttribute(name)
  else el.setAttribute(name, value)
}

function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden
}

/** Set a CSS custom property only when it changes. */
function setVar(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value)
}

/** Clamp to [lo, hi]; NaN maps to lo, so a bad value can never reach a CSS variable or an array index. */
function clamp(x: number, lo: number, hi: number): number {
  return x > lo ? (x < hi ? x : hi) : lo
}

/** A 0..100 meter position, or null when it is missing or not a finite number. */
function finitePct(pct: number | null | undefined): number | null {
  return pct === null || pct === undefined || !Number.isFinite(pct) ? null : clamp(pct, 0, 100)
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet'

/** A real <button type="button">; primary buttons are 64 px tall, all others at least 48 px (style.css). */
function button(label: string, onClick: () => void, variant: ButtonVariant = 'secondary'): HTMLButtonElement {
  const b = h('button', { type: 'button', class: `btn btn-${variant}` }, label)
  b.addEventListener('click', onClick)
  return b
}

interface Toggle {
  readonly el: HTMLButtonElement
  readonly state: HTMLElement
}

/** On/off button: aria-pressed carries the state, the visible On/Off word repeats it without colour. */
function toggle(label: string, onClick: () => void): Toggle {
  const state = h('span', { class: 'toggle-state', 'aria-hidden': 'true' })
  const el = h('button', { type: 'button', class: 'toggle', 'aria-pressed': 'false' }, h('span', { class: 'toggle-label' }, label), state)
  el.addEventListener('click', onClick)
  return { el, state }
}

function syncToggle(t: Toggle, on: boolean): void {
  setAttr(t.el, 'aria-pressed', on ? 'true' : 'false')
  setText(t.state, on ? COPY.hunting.on : COPY.hunting.off)
}

/** Screen heading that receives focus when its screen appears after a user action. */
function heading(text: string, cls = 'screen-title'): HTMLHeadingElement {
  return h('h1', { class: cls, id: 'screen-title', tabindex: -1 }, text)
}

function section(cls: string, ...children: Child[]): HTMLElement {
  return h('section', { class: `screen ${cls}`, 'aria-labelledby': 'screen-title' }, ...children)
}

/** Sonar mark from the favicon: two pairs of arcs around an orange dot. */
function sonarMark(): SVGSVGElement {
  return s(
    'svg',
    { class: 'sonar', viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false' },
    s(
      'g',
      { fill: 'none', stroke: 'currentColor', 'stroke-width': '4', 'stroke-linecap': 'round' },
      s('path', { d: 'M22 42a14 14 0 0 1 0-20', opacity: '.55' }),
      s('path', { d: 'M15 49a24 24 0 0 1 0-34', opacity: '.35' }),
      s('path', { d: 'M42 22a14 14 0 0 1 0 20', opacity: '.55' }),
      s('path', { d: 'M49 15a24 24 0 0 1 0 34', opacity: '.35' }),
    ),
    s('circle', { class: 'sonar-dot', cx: '32', cy: '32', r: '6.5' }),
  )
}

function lockIcon(): SVGSVGElement {
  return s(
    'svg',
    { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { x: '5', y: '10.5', width: '14', height: '10', rx: '2.5', fill: 'currentColor' }),
    s('path', { d: 'M8 10.5V8a4 4 0 0 1 8 0v2.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }),
  )
}

/** The sonar mark's outer arcs around a filled check: the Found it screen's hero. */
function foundMark(): SVGSVGElement {
  return s(
    'svg',
    { class: 'found-mark', viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false' },
    s(
      'g',
      { class: 'found-mark__arcs', fill: 'none', stroke: 'currentColor', 'stroke-width': '4', 'stroke-linecap': 'round' },
      s('path', { d: 'M16.4 47.6a22 22 0 0 1 0-31.2', opacity: '.55' }),
      s('path', { d: 'M11.5 52.5a29 29 0 0 1 0-41', opacity: '.3' }),
      s('path', { d: 'M47.6 16.4a22 22 0 0 1 0 31.2', opacity: '.55' }),
      s('path', { d: 'M52.5 11.5a29 29 0 0 1 0 41', opacity: '.3' }),
    ),
    s(
      'g',
      { class: 'found-mark__check' },
      s('circle', { class: 'found-mark__dot', cx: '32', cy: '32', r: '14' }),
      s('path', {
        class: 'found-mark__tick',
        d: 'M25.5 32.5l4.5 4.5 8.5-9',
        fill: 'none',
        'stroke-width': '4',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    ),
  )
}

/** Battery glyph for the Found it screen's tip. */
function batteryIcon(): SVGSVGElement {
  return s(
    'svg',
    { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { x: '2.5', y: '7', width: '16', height: '10', rx: '2.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }),
    s('path', { d: 'M21 10.5v3', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }),
    s('rect', { x: '5.5', y: '10', width: '6', height: '4', rx: '1', fill: 'currentColor' }),
  )
}

/** Small station glyph (a phone with sound waves) for the landing's station button. */
function stationIcon(): SVGSVGElement {
  return s(
    'svg',
    { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { x: '7', y: '3', width: '10', height: '18', rx: '2.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }),
    s('path', { d: 'M3.5 9a5 5 0 0 0 0 6M20.5 9a5 5 0 0 1 0 6', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }),
  )
}

/** Where Soundwave runs, for instructions that depend on it (see PERMISSION_HELP). */
function detectPlatform(): Platform {
  const matches = (query: string): boolean => typeof matchMedia === 'function' && matchMedia(query).matches
  if (matches('(display-mode: standalone)')) return 'standalone'
  if (matches('(pointer: coarse)')) return 'touch'
  return 'desktop'
}

// ---- Shared pieces -------------------------------------------------------------------------------

interface Badge {
  readonly el: HTMLElement
  readonly icon: HTMLElement
  readonly text: HTMLElement
}

/** Raw-audio badge: amber '!' when processing stayed on, blue 'i' when it could not be verified. */
function badge(): Badge {
  const icon = h('span', { class: 'badge-icon', 'aria-hidden': 'true' })
  const text = h('span', { class: 'badge-text' })
  return { el: h('p', { class: 'badge', hidden: true }, icon, text), icon, text }
}

function syncBadge(b: Badge, mic: MicDiag | null): void {
  const text = rawAudioText(mic)
  setHidden(b.el, text === null)
  if (text === null || mic === null) return
  const partial = mic.rawAudio === 'partial'
  setAttr(b.el, 'data-tone', partial ? 'warn' : 'info')
  setText(b.icon, partial ? '!' : 'i')
  setText(b.text, text)
}

const ERROR_ACTIONS: Record<ErrorAction, (hs: UiHandlers) => void> = {
  retry: (hs) => hs.onRetry(),
  reload: (hs) => hs.onReload(),
  back: (hs) => hs.onBack(),
  copyLink: (hs) => hs.onCopyLink(),
}

/** Error card from ERROR_COPY; the first action is the primary button. */
function errorCard(
  code: ErrorCode,
  handlers: UiHandlers,
  titleTag: 'h1' | 'h2',
  omit: readonly ErrorAction[] = [],
): { el: HTMLElement; title: HTMLElement } {
  const copy = ERROR_COPY[code]
  const title =
    titleTag === 'h1'
      ? heading(copy.heading, 'card-title')
      : h('h2', { class: 'card-title' }, copy.heading)
  const actions = copy.actions
    .filter((a) => !omit.includes(a))
    .map((a, i) => button(COPY.errorActions[a], () => ERROR_ACTIONS[a](handlers), i === 0 ? 'primary' : 'secondary'))
  const el = h(
    'div',
    { class: 'card card-error' },
    h('span', { class: 'card-icon', 'aria-hidden': 'true' }, '!'),
    title,
    h('p', { class: 'card-body' }, errorBody(code, detectPlatform())),
    actions.length > 0 ? h('div', { class: 'card-actions' }, ...actions) : null,
  )
  return { el, title }
}

// ---- Screens -------------------------------------------------------------------------------------

interface ScreenView {
  readonly el: HTMLElement
  /** Receives focus when the screen appears after a user action. */
  readonly focus: HTMLElement
  update(state: AppState): void
  /** Called once when the screen is replaced (stop cameras, timers, peer UI). */
  dispose?(): void
}

function landingView(state: AppState, handlers: UiHandlers): ScreenView {
  const L = COPY.landing
  const title = heading(COPY.appName, 'screen-title brand-title')
  const caps = state.caps
  const supported = caps.secureContext && caps.getUserMedia && caps.audioContext
  let cta: HTMLElement
  if (supported) {
    const station = button(L.station, () => handlers.onStationMode(), 'secondary')
    station.prepend(stationIcon())
    station.classList.add('station-btn')
    station.setAttribute('aria-describedby', 'station-hint')
    cta = h(
      'div',
      { class: 'cta' },
      button(L.start, () => handlers.onStart(), 'primary'),
      h('p', { class: 'caption' }, L.caption),
      h('div', { class: 'station-cta' }, station, h('p', { class: 'caption', id: 'station-hint' }, L.stationHint)),
    )
  } else {
    cta = h('div', { class: 'cta' }, errorCard('unsupported', handlers, 'h2', ['back']).el) // Back has nowhere to go here
  }
  const el = section(
    'landing',
    h('header', { class: 'brand' }, sonarMark(), title, h('p', { class: 'tagline' }, COPY.tagline)),
    h('p', { class: 'lead' }, L.lead),
    h(
      'ol',
      { class: 'steps' },
      ...L.steps.map((step, i) =>
        h(
          'li',
          {},
          h('span', { class: 'step-n', 'aria-hidden': 'true' }, String(i + 1)),
          h('span', { class: 'step-text' }, h('strong', {}, `${step.title}:`), ` ${step.text}`),
        ),
      ),
    ),
    h('p', { class: 'privacy' }, lockIcon(), h('span', {}, L.privacy)),
    cta,
  )
  const history = createHistoryPanel(handlers, title)
  el.append(history.el)
  return {
    el,
    focus: title,
    update(s) {
      history.update(s)
    },
  }
}

function requestingView(handlers: UiHandlers, cfg: Config): ScreenView {
  const R = COPY.requesting
  const title = heading(R.title)
  const hint = h('p', { class: 'hint', hidden: true }, PERMISSION_HELP[detectPlatform()].hint)
  const el = section(
    'requesting centered',
    h('div', { class: 'dots', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
    title,
    h('p', { class: 'muted' }, R.body),
    h('div', { 'aria-live': 'polite' }, hint),
    h('div', { class: 'actions' }, button(R.cancel, () => handlers.onStopRequest(), 'secondary')),
  )
  return {
    el,
    focus: title,
    update(state) {
      const screen = state.screen
      if (screen.kind !== 'requesting') return
      setHidden(hint, state.nowMs - screen.sinceMs < cfg.requestHintMs)
    },
  }
}

function listeningView(handlers: UiHandlers, cfg: Config): ScreenView {
  const T = COPY.listening
  const title = heading(T.title)
  const elapsed = h('span', { class: 'num' }, '0:00')
  const micFill = h('span', { class: 'mic-fill' })
  const micRow = h(
    'div',
    { class: 'mic', 'aria-hidden': 'true' },
    h('span', { class: 'mic-label' }, T.micLabel),
    h('span', { class: 'mic-track' }, micFill),
  )
  const noBeep = h('p', { class: 'no-beep', hidden: true }, T.noBeep)
  const rawBadge = badge()

  // A beep heard once, waiting for the confirming chirp. The sightings line ticks every second,
  // so the card is not a live region; a separate polite node speaks the main line once.
  const pendingMain = h('p', { class: 'pending-text' })
  const pendingSeen = h('p', { class: 'pending-seen num' })
  const pendingCard = h(
    'div',
    { class: 'pending', hidden: true },
    h('span', { class: 'pending-dot', 'aria-hidden': 'true' }),
    h('div', { class: 'pending-body' }, pendingMain, pendingSeen),
    button(T.useNow, () => handlers.onUseNow(), 'secondary'),
  )
  const pendingLive = h('p', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' })

  const el = section(
    'listening',
    h(
      'div',
      { class: 'listening-main' },
      // Two groups, one column on phones held upright; side by side on landscape phones, so the
      // waiting-beep card and 'Use it now' stay on screen.
      h(
        'div',
        { class: 'listening-status' },
        h(
          'div',
          { class: 'ring', 'aria-hidden': 'true' },
          h('span', { class: 'ring-wave' }),
          h('span', { class: 'ring-wave' }),
          h('span', { class: 'ring-wave' }),
          h('span', { class: 'ring-core' }),
        ),
        title,
        h('p', { class: 'elapsed' }, h('span', { class: 'sr-only' }, `${T.elapsedLabel} `), elapsed),
        micRow,
      ),
      h(
        'div',
        { class: 'listening-side' },
        h('p', { class: 'tip' }, T.tip),
        pendingCard,
        pendingLive,
        h('div', { 'aria-live': 'polite' }, noBeep),
        rawBadge.el,
      ),
    ),
    h(
      'div',
      { class: 'bottombar' },
      button(T.heardIt, () => handlers.onHeardIt(), 'primary'),
      button(T.stop, () => handlers.onStopRequest(), 'secondary'),
    ),
  )

  let pendingKey = ''
  return {
    el,
    focus: title,
    update(state) {
      const screen = state.screen
      if (screen.kind !== 'listening') return
      const sinceMs = state.nowMs - screen.sinceMs
      setText(elapsed, formatClock(sinceMs / 1000))
      setVar(micRow, '--level', clamp(state.micLevel, 0, 1).toFixed(3))
      const pending = state.pending
      // A waiting beep can expire while 'Use it now' has focus: hand focus to the heading first.
      if (pending === null && pendingCard.contains(document.activeElement)) title.focus()
      setHidden(pendingCard, pending === null)
      setHidden(noBeep, sinceMs < cfg.noBeepHintMs || pending !== null)
      if (pending !== null) {
        setText(pendingMain, pendingText(pending))
        setText(pendingSeen, pendingSightingsText(pending.sightings, (state.nowMs - pending.heardAtMs) / 1000))
      }
      // Speak it when a beep first waits and when its frequency changes, not on every sighting.
      const key = pending === null ? '' : formatHz(pending.f0Hz)
      if (key !== pendingKey) {
        pendingKey = key
        announce(pendingLive, pending === null ? '' : pendingText(pending))
      }
      syncBadge(rawBadge, state.mic)
    },
  }
}

function lockedView(handlers: UiHandlers, cfg: Config): ScreenView {
  const K = COPY.locked
  const title = heading(K.banner, 'screen-title banner')
  const freq = h('p', { class: 'freq-big num' })
  const heard = h('p', { class: 'heard' })
  // The automatic advance is drawn inside Start hunting (--p) and explained by the caption.
  const start = button(K.startHunting, () => handlers.onConfirmLock(), 'primary')
  start.classList.add('btn-progress')
  const auto = h('p', { class: 'caption auto-caption', id: 'locked-auto' }, K.auto)
  const el = section(
    'locked centered',
    h('span', { class: 'banner-dot', 'aria-hidden': 'true' }),
    title,
    freq,
    heard,
    h('div', { class: 'actions' }, start, auto, button(K.notIt, () => handlers.onNotIt(), 'secondary')),
  )

  // Any touch, key press or focus on a control holds the screen: whoever is reading or reaching
  // for "Wrong sound?" gets all the time they need. Focus moved to the heading by the app itself
  // does not count.
  let asked = false
  let held = false
  const hold = (): void => {
    if (held || asked) return
    asked = true
    handlers.onHoldLock()
  }
  el.addEventListener('pointerdown', hold)
  el.addEventListener('keydown', hold)
  el.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLButtonElement) hold()
  })

  return {
    el,
    focus: title,
    update(state) {
      const screen = state.screen
      if (screen.kind !== 'locked') return
      held = screen.held === true
      const lock = state.lock
      setText(freq, formatHz(lock?.f0Hz ?? Number.NaN))
      setText(heard, lock ? heardText(lock) : '')
      setHidden(auto, held)
      setAttr(start, 'aria-describedby', held ? null : 'locked-auto')
      const p = held ? 0 : clamp((state.nowMs - screen.sinceMs) / cfg.lockedBannerMs, 0, 1)
      setVar(start, '--p', p.toFixed(3))
    },
  }
}

/** What the hero and the meter show: the last reading in chirp mode, the held level in live mode. */
interface HeroModel {
  /** Changes exactly when the announced verdict must change (new reading id, its verdict, or live verdict). */
  readonly key: string
  readonly verdict: Verdict | null
  readonly sub: string
  readonly newBest: boolean
  /** 0..100, or null when there is no position yet (first reading, live warm-up). Never NaN. */
  readonly pct: number | null
  readonly prevPct: number | null
  readonly clipped: boolean
}

function heroModel(view: HuntView | null, mode: LockMode, cfg: Config): HeroModel {
  const empty = { verdict: null, sub: '', newBest: false, pct: null, prevPct: null, clipped: false }
  if (view === null) return { key: 'none', ...empty }
  if (mode === 'live') {
    const live = view.live
    return {
      key: `live:${live?.verdict ?? 'none'}`,
      verdict: live?.verdict ?? null,
      sub: liveDeltaLine(live?.deltaDb ?? null, cfg.liveRefMs),
      newBest: false,
      pct: finitePct(live?.pct),
      prevPct: null,
      clipped: live?.clipped ?? false,
    }
  }
  const last = view.last
  if (last === null) return { key: 'chirp:none', ...empty }
  const readings = view.readings
  const i = readings.findLastIndex((r) => r.id === last.id)
  const prev = i > 0 ? readings[i - 1] : undefined
  return {
    key: `reading:${last.id}:${last.verdict}`,
    verdict: last.verdict,
    sub: deltaLine(last),
    newBest: last.isNewBest,
    pct: finitePct(last.pct),
    prevPct: finitePct(prev?.pct),
    clipped: last.clipped || last.verdict === 'max',
  }
}

/** The best reading's meter position (the 'Best' tick), or null before any reading has one. */
function bestPct(readings: readonly Reading[]): number | null {
  let best: number | null = null
  for (const r of readings) {
    const pct = finitePct(r.pct)
    if (pct !== null && (best === null || pct > best)) best = pct
  }
  return best
}

/** Other listeners (extra mics, stations) that are listening right now: the Stations tab badge. */
function listeningCount(view: StationsView | null): number {
  if (view === null) return 0
  let n = 0
  for (const l of view.listeners) if (l.kind !== 'self' && l.status === 'listening') n++
  return n
}

/** Countdown kinds worth a polite announcement when they begin (not 'late' / 'overdue': the chirp is due then). */
const ANNOUNCED_PHASES: ReadonlySet<string> = new Set(['hold', 'wait', 'lost'])
/** Live mode speaks a verdict at most this often, and only once it held for two verdict updates. */
const LIVE_ANNOUNCE_GAP_MS = 5_000
/** A past hunt's name is saved this long after the last keystroke (and at once on blur or Enter). */
const NAME_DEBOUNCE_MS = 400
const LIVE_ANNOUNCE_HOLD_UPDATES = 2

/** ui-internal services the hunting screen needs from mountUi. */
interface HuntingHooks {
  /** Open the 'Listen again?' confirmation (ui-local, not in AppState). */
  requestRelisten(): void
}

interface TabParts {
  readonly tab: HTMLButtonElement
  readonly badge: HTMLElement
  readonly panel: HTMLElement
}

function huntingView(state: AppState, handlers: UiHandlers, cfg: Config, hooks: HuntingHooks): ScreenView {
  const H = COPY.hunting
  const title = heading(H.title, 'screen-title sr-only')

  // Top bar, one row: frequency, mode, Clicks, Vibrate.
  const freqValue = h('span', { class: 'num' })
  const modeValue = h('span')
  const modeChip = h('span', { class: 'chip chip-mode' }, h('span', { class: 'sr-only' }, `${H.modeLabel}: `), modeValue)
  const clicks = toggle(H.clicks, () => handlers.onToggleClicks())
  const haptics = state.caps.haptics ? toggle(H.haptics, () => handlers.onToggleHaptics()) : null
  const topbar = h(
    'div',
    { class: 'topbar' },
    h('span', { class: 'chip chip-freq' }, h('span', { class: 'sr-only' }, `${H.frequencyLabel}: `), freqValue),
    modeChip,
    h('span', { class: 'topbar-spacer' }),
    clicks.el,
    haptics ? haptics.el : null,
  )

  // Verdict hero. The word itself is not a live region: chirp readings are spoken (with their
  // number) by `readout`; live verdicts, which can change every second, by the throttled
  // `liveReadout`, so speech does not keep competing with the microphone.
  const verdict = h('p', { class: 'verdict' })
  const delta = h('span', { class: 'delta num' })
  const newBest = h('span', { class: 'newbest', hidden: true }, h('span', { 'aria-hidden': 'true' }, '★ '), H.newBest)
  const subline = h('p', { class: 'subline' }, delta, newBest)
  const hero = h('div', { class: 'hero', 'data-verdict': 'none' }, verdict, subline)
  const readout = h('p', { class: 'sr-only', 'aria-live': 'assertive', 'aria-atomic': 'true' })
  const liveReadout = h('p', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' })

  // Status bar: what to do now (move / hold still), with the 'Hearing it' dot.
  const hearing = h('span', { class: 'hearing', hidden: true }, h('span', { class: 'hearing-dot', 'aria-hidden': 'true' }), H.hearing)
  const statusText = h('span', { class: 'countdown-text' })
  const statusBar = h('div', { class: 'countdown', 'data-kind': 'none' }, hearing, statusText)
  // Chirp mode: tell the app a beep was just heard (counts one the filters set aside).
  const heardNote = h('p', { class: 'heard-row__note', hidden: true })
  const heardRow = h('div', { class: 'heard-row' }, button(H.heardIt, () => handlers.onHeardIt(), 'quiet'), heardNote)
  const phaseLive = h('p', { class: 'sr-only', 'aria-live': 'polite' })

  // ---- Meter panel: meter (with Start over here), history strip, guidance.
  const numeral = h('span', { class: 'numeral num', 'aria-hidden': 'true' })
  const reset = button(H.resetBest, () => handlers.onResetBest(), 'quiet')
  reset.classList.add('meter-reset')
  const meterEmpty = h('p', { class: 'meter-empty' })
  const ghost = h('span', { class: 'meter-ghost', hidden: true })
  const bestTick = h('span', { class: 'meter-best', hidden: true })
  const cap = h('span', { class: 'meter-cap', hidden: true }, h('span', { class: 'meter-cap-label' }, H.max))
  const meter = h(
    'div',
    { class: 'meter', role: 'meter', 'aria-label': H.meterLabel, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 },
    h('span', { class: 'meter-track' }, h('span', { class: 'meter-rest' }), cap, ghost, bestTick),
  )
  const scaleHot = h('span', { class: 'scale-hot' }, H.scaleHot)
  const scaleBest = h('span', { class: 'scale-best', hidden: true }, '★ ', H.scaleBest)
  const meterBlock = h(
    'div',
    { class: 'meter-block' },
    h('div', { class: 'meter-head' }, numeral, reset),
    meterEmpty,
    meter,
    h('div', { class: 'meter-scale', 'aria-hidden': 'true' }, h('span', { class: 'scale-cold' }, H.scaleCold), scaleHot, scaleBest),
  )

  // History strip: a fixed pool of historyShown slots filled from the right, so the newest reading
  // always sits in the last slot and nothing reflows. `shows` remembers the Reading object each
  // slot was last drawn from (hunt views reuse unchanged Reading objects).
  const pool = Array.from({ length: Math.max(0, cfg.historyShown) }, (_, i) => {
    const vis = h('span', { 'aria-hidden': 'true' })
    const sr = h('span', { class: 'sr-only' })
    const li = h('li', { hidden: true }, vis, sr)
    li.style.gridColumn = String(i + 1)
    return { li, vis, sr, shows: null as Reading | null, current: false }
  })
  const history = h('ol', { class: 'history', 'aria-label': H.history, hidden: true }, ...pool.map((p) => p.li))
  setVar(history, '--slots', String(Math.max(1, pool.length)))
  const guidance = h('p', { class: 'guidance' })
  const rawBadge = badge()

  // ---- Direction panel: the radar with its own Clear scan (no Done: leaving = another tab).
  const radar = createRadarPanel({ onClear: () => handlers.onScanClear() })

  // ---- Tabs and panels.
  const order: readonly HuntPanel[] = state.caps.compass ? ['meter', 'direction', 'log', 'stations'] : ['meter', 'log', 'stations']
  const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': H.tabsLabel })
  const panelHost = h('div', { class: 'panels' })
  const tabs = new Map<HuntPanel, TabParts>()
  for (const p of order) {
    const badgeEl = h('span', { class: 'tab-badge num', 'aria-hidden': 'true', hidden: true })
    const tab = h(
      'button',
      {
        type: 'button',
        class: 'tab',
        role: 'tab',
        id: `tab-${p}`,
        'aria-controls': `panel-${p}`,
        'aria-selected': 'false',
        'aria-label': tabName(p, 0),
        tabindex: -1,
      },
      h('span', { class: 'tab-label', 'data-label': H.tabs[p] }, H.tabs[p]),
      badgeEl,
    )
    tab.addEventListener('click', () => choose(p))
    const panel = h('div', { class: `panel panel-${p}`, role: 'tabpanel', id: `panel-${p}`, 'aria-labelledby': `tab-${p}`, tabindex: 0, hidden: true })
    tablist.append(tab)
    panelHost.append(panel)
    tabs.set(p, { tab, badge: badgeEl, panel })
  }
  tabs.get('meter')!.panel.append(meterBlock, history, guidance, rawBadge.el)
  tabs.get('direction')?.panel.append(radar.el)

  // Arrow keys move between tabs and select them (automatic activation); Home / End jump.
  tablist.addEventListener('keydown', (e) => {
    const i = order.findIndex((p) => tabs.get(p)!.tab === document.activeElement)
    if (i < 0) return
    let next = -1
    if (e.key === 'ArrowRight') next = (i + 1) % order.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + order.length) % order.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = order.length - 1
    if (next < 0) return
    e.preventDefault()
    const p = order[next]!
    tabs.get(p)!.tab.focus()
    choose(p)
  })

  // The Log and Stations panels are created the first time their tab opens.
  let logPanel: ReturnType<typeof createLogPanel> | null = null
  let stationsPanel: ReturnType<typeof createStationsPanel> | null = null

  // Bottom bar in the thumb zone: Found it is the positive way out, Stop the destructive one.
  const relisten = button(H.relisten, () => {
    const readings = current.hunt?.readings.length ?? 0
    if (readings >= cfg.stopConfirmMinReadings) hooks.requestRelisten()
    else handlers.onRelistenConfirm()
  }, 'secondary')
  relisten.classList.add('bar-relisten')
  const found = button(H.found, () => {
    // A note being typed in the Log panel is sent on blur: send it now, so the summary has it.
    const active = document.activeElement
    if (active instanceof HTMLInputElement && el.contains(active)) active.blur()
    handlers.onFound()
  }, 'primary')
  found.classList.add('bar-found')
  const stop = button(H.stop, () => handlers.onStopRequest(), 'danger')
  stop.classList.add('bar-stop')
  const bottombar = h('div', { class: 'bottombar' }, relisten, found, stop)

  const el = section(
    'hunting',
    title,
    topbar,
    hero,
    readout,
    liveReadout,
    statusBar,
    heardRow,
    phaseLive,
    tablist,
    panelHost,
    bottombar,
  )

  let current = state
  let shownPanel: HuntPanel | null = null
  let shownF0: number | null = null
  let meterKey = ''
  let announcedKey: string | null = null
  let phase: string | null = null
  let liveVerdict: Verdict | null = null
  let liveSinceMs = 0
  let liveSpoken: Verdict | null = null
  let liveSpokenAtMs = -Infinity
  let bestFor: readonly Reading[] | null = null
  let best: number | null = null
  let stationsFor: StationsView | null | undefined
  let stationsN = 0
  let logN = -1

  function choose(p: HuntPanel): void {
    if (p !== current.panel) handlers.onPanel(p)
  }

  function showPanel(p: HuntPanel): void {
    if (p === shownPanel) return
    // A panel hidden under the focus (main switched the tab, e.g. the compass failed) would drop
    // focus to <body>: hand it to the newly selected tab instead.
    const old = shownPanel === null ? undefined : tabs.get(shownPanel)
    const refocus = old !== undefined && old.panel.contains(document.activeElement)
    shownPanel = p
    for (const [q, parts] of tabs) {
      const on = q === p
      setAttr(parts.tab, 'aria-selected', on ? 'true' : 'false')
      setAttr(parts.tab, 'tabindex', on ? '0' : '-1')
      setHidden(parts.panel, !on)
    }
    if (p === 'log' && logPanel === null) {
      logPanel = createLogPanel(handlers, cfg)
      tabs.get('log')!.panel.append(logPanel.el)
    }
    if (p === 'stations' && stationsPanel === null) {
      stationsPanel = createStationsPanel(handlers, cfg)
      tabs.get('stations')!.panel.append(stationsPanel.el)
    }
    setAttr(el, 'data-panel', p)
    if (refocus) tabs.get(p)?.tab.focus()
  }

  function setBadge(p: HuntPanel, n: number): void {
    const parts = tabs.get(p)
    if (parts === undefined) return
    setHidden(parts.badge, n <= 0)
    setText(parts.badge, n > 0 ? String(n) : '')
    setAttr(parts.tab, 'aria-label', tabName(p, n))
  }

  return {
    el,
    focus: title,
    dispose() {
      stationsPanel?.dispose()
      stationsPanel = null
    },
    update(state) {
      current = state
      const view = state.hunt
      const lock = state.lock
      const mode: LockMode = view?.mode ?? lock?.mode ?? 'chirp'
      const panel: HuntPanel = tabs.has(state.panel) ? state.panel : 'meter'
      const scanning = panel === 'direction'
      showPanel(panel)

      // Top bar.
      const f0 = view?.f0Hz ?? lock?.f0Hz ?? Number.NaN
      if (!Object.is(f0, shownF0)) {
        shownF0 = f0
        setText(freqValue, formatHz(f0))
      }
      setText(modeValue, mode === 'live' ? H.modeLive : H.modeChirp)
      setAttr(modeChip, 'data-mode', mode)
      syncToggle(clicks, state.settings.clicks)
      if (haptics) syncToggle(haptics, state.settings.haptics)

      // Hero. While scanning, turning on the spot changes the level through body shadowing, so
      // 'WARMER +8 dB' would mislead: show a muted SCANNING and no sub-line.
      const m = heroModel(view, mode, cfg)
      setText(verdict, scanning ? H.scanning : heroLabel(view))
      setAttr(hero, 'data-verdict', scanning ? 'scanning' : (m.verdict ?? 'none'))
      setHidden(subline, scanning)
      setText(delta, m.sub)
      setHidden(delta, m.sub === '')
      setHidden(newBest, !m.newBest)

      // Spoken verdicts: every chirp reading (with its number), or a settled live verdict at most
      // every few seconds. Nothing while scanning; the radar panel speaks for itself then.
      if (mode === 'chirp') {
        if (m.key !== announcedKey) {
          announcedKey = m.key
          const last = view?.last ?? null
          if (!scanning && last !== null) announce(readout, readingAnnouncement(last))
        }
        liveVerdict = null
        liveSpoken = null
      } else {
        announcedKey = null
        const v = view?.live?.verdict ?? null
        if (v !== liveVerdict) {
          liveVerdict = v
          liveSinceMs = state.nowMs
        }
        if (
          v !== null &&
          v !== liveSpoken &&
          !scanning &&
          state.nowMs - liveSinceMs >= LIVE_ANNOUNCE_HOLD_UPDATES * cfg.liveVerdictMs &&
          state.nowMs - liveSpokenAtMs >= LIVE_ANNOUNCE_GAP_MS
        ) {
          liveSpoken = v
          liveSpokenAtMs = state.nowMs
          announce(liveReadout, liveAnnouncement(v))
        }
      }

      // Status bar. Chirp mode: the countdown. Live mode: whether the tone is heard at all.
      const isHearing = view?.hearing ?? false
      let text: string
      let kind: string
      if (mode === 'live') {
        text = isHearing ? '' : H.notHearing
        kind = isHearing ? 'hearing' : 'quiet'
      } else {
        const cd = view?.countdown ?? null
        text = countdownText(cd)
        kind = cd?.kind ?? 'none'
      }
      // While a chirp sounds outside the hold window, 'Hearing it' alone is the news: the long
      // 'move now' line next to it would wrap to a third line and make the bar jump.
      const hearingOnly = mode === 'chirp' && isHearing && kind !== 'hold' && kind !== 'late' && kind !== 'wait'
      setText(statusText, text)
      setHidden(statusText, text === '' || hearingOnly)
      setHidden(heardRow, mode !== 'chirp')
      const ignoredText = ignoredSoundsText(view?.ignoredSounds ?? 0)
      setText(heardNote, ignoredText)
      setHidden(heardNote, ignoredText === '')
      setHidden(hearing, !isHearing)
      setAttr(statusBar, 'data-kind', kind)
      if (kind !== phase) {
        phase = kind
        setText(phaseLive, ANNOUNCED_PHASES.has(kind) ? text : '')
      }
      // The visible line is skipped by screen readers while the live region says the same.
      setAttr(statusText, 'aria-hidden', text !== '' && phaseLive.textContent === text ? 'true' : null)

      // Meter. It changes once per reading (or per held-level change in live mode): skip the
      // string work on the ~60 frames per second where nothing moved.
      const readings = view?.readings ?? []
      if (readings !== bestFor) {
        bestFor = readings
        best = bestPct(readings)
      }
      const bestShown = mode === 'chirp' ? best : null
      const key = `${m.pct}|${m.prevPct}|${m.clipped}|${bestShown}|${mode}`
      if (key !== meterKey) {
        meterKey = key
        const pct = m.pct ?? 0
        setVar(meterBlock, '--pct', pct.toFixed(1))
        // 'Start over here' empties the meter, which hides its own row: keep keyboard focus on the
        // Meter tab instead of letting it fall to <body>.
        if (m.pct === null && document.activeElement === reset) tabs.get('meter')?.tab.focus()
        setAttr(meterBlock, 'data-empty', m.pct === null ? '' : null)
        setText(meterEmpty, mode === 'live' ? H.meterWarmup : H.meterEmpty)
        setText(numeral, formatPct(m.pct))
        setAttr(meter, 'aria-valuenow', String(Math.round(pct)))
        setAttr(meter, 'aria-valuetext', meterValueText(m.pct, m.prevPct, m.clipped))
        setHidden(ghost, m.prevPct === null)
        if (m.prevPct !== null) setVar(meterBlock, '--ghost', m.prevPct.toFixed(1))
        setHidden(bestTick, bestShown === null)
        setHidden(scaleBest, bestShown === null)
        setHidden(scaleHot, bestShown !== null)
        if (bestShown !== null) setVar(meterBlock, '--best', bestShown.toFixed(1))
        setHidden(cap, !m.clipped)
      }
      setAttr(meterBlock, 'data-stale', mode === 'live' && !isHearing ? '' : null)

      // History, newest in the last slot.
      const shown = Math.min(pool.length, readings.length)
      const firstSlot = pool.length - shown
      for (let i = 0; i < pool.length; i++) {
        const item = pool[i]!
        const r = i >= firstSlot ? (readings[readings.length - pool.length + i] ?? null) : null
        const isCurrent = r !== null && i === pool.length - 1
        if (r === item.shows && isCurrent === item.current) continue // same Reading object: nothing to redraw
        item.shows = r
        item.current = isCurrent
        setHidden(item.li, r === null)
        if (r === null) continue
        setText(item.vis, historyItemText(r))
        setText(item.sr, historyItemLabel(r))
        setAttr(item.li, 'data-verdict', r.isNewBest ? 'best' : r.verdict)
        setAttr(item.li, 'aria-current', isCurrent ? 'true' : null)
      }
      setHidden(history, shown < 2)

      setText(guidance, view ? guidanceText(view) : GUIDANCE.default)
      syncBadge(rawBadge, state.mic)

      // Tab badges: readings in the log, other listeners that are listening.
      if (state.log.length !== logN) {
        logN = state.log.length
        setBadge('log', logN)
      }
      if (state.stations !== stationsFor) {
        stationsFor = state.stations
        stationsN = listeningCount(state.stations)
        setBadge('stations', stationsN)
      }

      // Only the open panel renders.
      if (panel === 'direction') radar.render(state.scan, mode)
      else if (panel === 'log') logPanel?.render(state)
      else if (panel === 'stations') stationsPanel?.render(state)
    },
  }
}

function pausedView(from: PausedFrom, needsGesture: boolean, handlers: UiHandlers): ScreenView {
  const P = COPY.paused
  const title = heading(P.title)
  const resume = needsGesture ? button(P.resume, () => handlers.onResume(), 'primary') : null
  const el = section(
    'paused centered',
    h('div', { class: 'pause-icon', 'aria-hidden': 'true' }, h('span'), h('span')),
    title,
    h('p', { class: 'muted pause-body' }, from === 'hunting' ? `${P.body} ${P.kept}` : P.body),
    resume ?? h('p', { class: 'muted', role: 'status' }, P.resuming),
    // A way out when resuming keeps failing (e.g. the microphone stays taken by a phone call).
    h('div', { class: 'actions' }, button(P.stop, () => handlers.onStopRequest(), 'danger')),
  )
  return { el, focus: resume ?? title, update() {} }
}

/**
 * The hunt is over: what was found, a battery tip, where the user stood (the notes typed in the
 * log) and the way on. The summary is drawn once per FoundSummary object; Copy log shows only
 * while the log has lines.
 */
function foundView(handlers: UiHandlers, cfg: Config): ScreenView {
  const F = FOUND_COPY
  const title = heading(F.title, 'screen-title found-title')
  const summaryLine = h('p', { class: 'found-summary num' })
  const listenersLine = h('p', { class: 'found-listeners' })
  const hero = h('header', { class: 'found-hero' }, foundMark(), title, summaryLine, listenersLine)

  // The name of this hunt under Past hunts ('Hallway smoke alarm'). Saved as it is typed.
  const nameInput = h('input', {
    type: 'text',
    id: 'found-name',
    class: 'found-name__input',
    maxlength: cfg.historyLabelMaxLength,
    placeholder: HISTORY_COPY.namePlaceholder,
    autocomplete: 'off',
    enterkeyhint: 'done',
    'aria-describedby': 'found-name-hint',
  })
  const nameField = h(
    'div',
    { class: 'found-name', hidden: true },
    h('label', { class: 'found-name__label', for: 'found-name' }, HISTORY_COPY.nameLabel),
    nameInput,
    h('p', { class: 'found-name__hint', id: 'found-name-hint' }, HISTORY_COPY.nameHint),
  )
  let recordId: number | null = null
  let sentName = ''
  let nameTimer: ReturnType<typeof setTimeout> | null = null
  function flushName(): void {
    if (nameTimer !== null) clearTimeout(nameTimer)
    nameTimer = null
    const value = nameInput.value.slice(0, cfg.historyLabelMaxLength)
    if (recordId === null || value === sentName) return
    sentName = value
    handlers.onHistoryLabel(recordId, value)
  }
  nameInput.addEventListener('input', () => {
    if (nameTimer !== null) clearTimeout(nameTimer)
    nameTimer = setTimeout(flushName, NAME_DEBOUNCE_MS)
  })
  nameInput.addEventListener('blur', flushName)
  nameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return
    e.preventDefault()
    flushName()
    // Touch devices: close the on-screen keyboard (a keyboard user keeps the focus).
    if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) nameInput.blur()
  })

  const tip = h('p', { class: 'found-tip' }, batteryIcon(), h('span', {}, h('strong', {}, F.tipTitle), ` ${F.tip}`))

  const notesList = h('ol', { class: 'found-notes__list' })
  const notes = h(
    'section',
    { class: 'found-notes', 'aria-labelledby': 'found-notes-title', hidden: true },
    h('h2', { class: 'found-notes__title', id: 'found-notes-title' }, F.notesTitle),
    notesList,
  )

  const copyLog = button(F.copyLog, () => handlers.onCopyLog(), 'secondary')
  const keep = button(F.keepHunting, () => handlers.onKeepHunting(), 'secondary')
  keep.setAttribute('aria-describedby', 'found-keep-hint')
  // A polite live region: it says so when the microphone turns off while this screen is open.
  const keepHint = h('p', { class: 'found-keep__hint', id: 'found-keep-hint', 'aria-live': 'polite' }, F.keepHint)
  const actions = h(
    'div',
    { class: 'found-actions' },
    button(F.done, () => handlers.onFoundDone(), 'primary'),
    h('div', { class: 'found-more' }, button(F.newHunt, () => handlers.onNewHunt(), 'secondary'), copyLog),
    h('div', { class: 'found-keep' }, keepHint, keep),
  )

  const el = section('found', hero, nameField, tip, notes, actions)

  /**
   * Parts as whole, unbreakable items: a line breaks only between them. The separator dot belongs
   * to the item before it, so a wrapped line never starts with a dot.
   */
  function drawParts(target: HTMLElement, parts: readonly string[]): void {
    const dot = LOG_COPY.sep.trim()
    const nodes: (Node | string)[] = []
    parts.forEach((part, i) => {
      if (i > 0) nodes.push(' ')
      nodes.push(h('span', { class: 'found-part' }, i < parts.length - 1 ? `${part}\u00a0${dot}` : part))
    })
    target.replaceChildren(...nodes)
    setHidden(target, parts.length === 0)
  }

  function drawNotes(summary: FoundSummary): void {
    const items = summary.notes.map((n) => {
      const time = formatClockTime(n.wallMs)
      const date = new Date(n.wallMs)
      return h(
        'li',
        { class: 'found-note' },
        h('time', { class: 'found-note__time', datetime: Number.isNaN(date.getTime()) ? null : date.toISOString() }, time),
        ' ',
        h('span', { class: 'found-note__verdict', 'data-verdict': n.verdict }, verdictLabel(n.verdict)),
        ' ',
        h('span', { class: 'found-note__text' }, n.note),
      )
    })
    notesList.replaceChildren(...items)
    setHidden(notes, items.length === 0)
  }

  let shown: FoundSummary | null = null
  return {
    el,
    focus: title,
    update(state) {
      if (state.screen.kind !== 'found') return
      const summary = state.found
      if (summary !== null && summary !== shown) {
        shown = summary
        drawParts(summaryLine, foundSummaryParts(summary))
        drawParts(listenersLine, foundListenersParts(summary))
        drawNotes(summary)
      }
      setHidden(copyLog, state.log.length === 0)
      if (state.foundRecordId !== recordId) {
        flushName()
        recordId = state.foundRecordId
        const record = state.history.find((r) => r.id === recordId)
        nameInput.value = record?.label ?? ''
        sentName = nameInput.value
      }
      setHidden(nameField, recordId === null || !state.history.some((r) => r.id === recordId))
      // Only on a change, so the live region announces it once.
      const hint = state.screen.micOff === true ? F.keepHintMicOff : F.keepHint
      if (keepHint.textContent !== hint) keepHint.textContent = hint
    },
    dispose() {
      // A name typed just before Done or New hunt is still saved.
      flushName()
    },
  }
}

function errorView(code: ErrorCode, handlers: UiHandlers): ScreenView {
  const card = errorCard(code, handlers, 'h1')
  return { el: section('error centered', card.el), focus: card.title, update() {} }
}

function stationView(handlers: UiHandlers, cfg: Config): ScreenView {
  const station = createStationScreen(handlers, cfg)
  return {
    el: station.el,
    focus: station.focus,
    update: (state) => station.update(state),
    dispose: () => station.dispose(),
  }
}

/** Identity of the screen DOM: rebuilt only when this changes. */
function screenKey(screen: Screen): string {
  switch (screen.kind) {
    case 'paused':
      return `paused:${screen.from}:${screen.needsGesture ? 'gesture' : 'auto'}`
    case 'error':
      return `error:${screen.code}`
    default:
      return screen.kind
  }
}

function buildView(state: AppState, handlers: UiHandlers, cfg: Config, hooks: HuntingHooks): ScreenView {
  const screen = state.screen
  switch (screen.kind) {
    case 'idle':
      return landingView(state, handlers)
    case 'requesting':
      return requestingView(handlers, cfg)
    case 'listening':
      return listeningView(handlers, cfg)
    case 'locked':
      return lockedView(handlers, cfg)
    case 'hunting':
      return huntingView(state, handlers, cfg, hooks)
    case 'paused':
      return pausedView(screen.from, screen.needsGesture, handlers)
    case 'error':
      return errorView(screen.code, handlers)
    case 'station':
      return stationView(handlers, cfg)
    case 'found':
      return foundView(handlers, cfg)
  }
}

// ---- Confirmation dialog (Stop, Listen again) ----------------------------------------------------

interface Dialog {
  readonly el: HTMLElement
  readonly focus: HTMLElement
}

interface DialogSpec {
  readonly title: string
  /** The destructive action (danger style). */
  readonly confirm: string
  /** The safe action (primary, under the thumb, focused first). */
  readonly cancel: string
  onConfirm(): void
  onCancel(): void
}

type DialogKind = 'stop' | 'relisten'

/** Modal alertdialog; Escape or a tap on the backdrop cancels, Tab cycles between the two buttons. */
function confirmDialog(spec: DialogSpec): Dialog {
  const confirm = button(spec.confirm, () => spec.onConfirm(), 'danger')
  const cancel = button(spec.cancel, () => spec.onCancel(), 'primary')
  // tabindex -1: a click on the dialog's text focuses the dialog instead of <body>, so Escape and
  // Tab still reach the scrim's key handler.
  const dialog = h(
    'div',
    { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title', tabindex: -1 },
    h('h2', { class: 'dialog-title', id: 'dialog-title' }, spec.title),
    h('div', { class: 'dialog-actions' }, confirm, cancel),
  )
  const scrim = h('div', { class: 'scrim' }, dialog)
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) spec.onCancel()
  })
  scrim.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      spec.onCancel()
    } else if (e.key === 'Tab') {
      const active = document.activeElement
      if (e.shiftKey && active === confirm) {
        e.preventDefault()
        cancel.focus()
      } else if (!e.shiftKey && active === cancel) {
        e.preventDefault()
        confirm.focus()
      }
    }
  })
  return { el: scrim, focus: cancel }
}

// ---- Mount ---------------------------------------------------------------------------------------

/**
 * Take over `root` (the <main id="app">) and return the renderer. render(state) is idempotent and
 * cheap when nothing changed; focus moves to a new screen's heading (or its main action) only when
 * focus was inside the app, so page load and background updates never steal it.
 *
 * Two bits of state live here rather than in AppState: the 'Listen again?' confirmation (the
 * Listen again button opens it once the hunt has cfg.stopConfirmMinReadings readings; its confirm
 * calls handlers.onRelistenConfirm) and a toast the person tapped away.
 */
export function mountUi(root: HTMLElement, handlers: UiHandlers, cfg: Config): { render(state: AppState): void } {
  const screenHost = h('div', { class: 'screen-host' })
  const debugPre = h('pre', { class: 'debug-text' })
  const debugPanel = h('section', { class: 'debug', 'aria-label': COPY.debug.title, hidden: true }, h('h2', {}, COPY.debug.title), debugPre)
  const toastEl = h('button', { type: 'button', class: 'toast', hidden: true })
  const toastRegion = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' }, toastEl)
  const dialogHost = h('div', { class: 'dialog-host' })
  root.classList.add('app')
  root.replaceChildren(screenHost, debugPanel, toastRegion, dialogHost)

  let view: ScreenView | null = null
  let viewKey = ''
  let dialog: Dialog | null = null
  let dialogKind: DialogKind | null = null
  let focusBeforeDialog: HTMLElement | null = null
  let last: AppState | null = null
  let relistenOpen = false
  let toastKey = ''
  let dismissedToast = ''

  const hooks: HuntingHooks = {
    requestRelisten() {
      relistenOpen = true
      if (last !== null) paint(last)
    },
  }

  function closeRelisten(): void {
    relistenOpen = false
    if (last !== null) paint(last)
  }

  const stopSpec: DialogSpec = {
    title: COPY.stopConfirm.title,
    confirm: COPY.stopConfirm.stop,
    cancel: COPY.stopConfirm.keepGoing,
    onConfirm: () => handlers.onStopConfirm(),
    onCancel: () => handlers.onStopCancel(),
  }
  const relistenSpec: DialogSpec = {
    title: COPY.relistenConfirm.title,
    confirm: COPY.relistenConfirm.confirm,
    cancel: COPY.relistenConfirm.keepGoing,
    onConfirm: () => {
      relistenOpen = false
      handlers.onRelistenConfirm()
      if (last !== null) paint(last) // closes the dialog even if main changed nothing
    },
    onCancel: closeRelisten,
  }

  toastEl.addEventListener('click', () => {
    dismissedToast = toastKey
    setHidden(toastEl, true)
  })

  function render(state: AppState): void {
    if (state === last) return
    paint(state)
  }

  function paint(state: AppState): void {
    const firstRender = last === null
    last = state

    const active = document.activeElement
    const focusInApp = active === null || active === document.body || root.contains(active)

    // Screen layer.
    const key = screenKey(state.screen)
    let rebuilt = false
    if (view === null || key !== viewKey) {
      view?.dispose?.()
      view = buildView(state, handlers, cfg, hooks)
      viewKey = key
      screenHost.replaceChildren(view.el)
      root.setAttribute('data-screen', state.screen.kind)
      rebuilt = true
    }
    view.update(state)

    // Dialog layer: the stop confirmation (AppState) wins over the ui-local Listen again one,
    // which only lives on the hunting screen.
    if (state.screen.kind !== 'hunting') relistenOpen = false
    const want: DialogKind | null = state.confirmStop ? 'stop' : relistenOpen ? 'relisten' : null
    let dialogClosed = false
    if (want !== dialogKind) {
      if (dialogKind === null) focusBeforeDialog = active instanceof HTMLElement && root.contains(active) ? active : null
      if (want === null) {
        dialog = null
        dialogHost.replaceChildren()
        screenHost.inert = false
        debugPanel.inert = false
        dialogClosed = true
      } else {
        dialog = confirmDialog(want === 'stop' ? stopSpec : relistenSpec)
        dialogHost.replaceChildren(dialog.el)
        screenHost.inert = true
        debugPanel.inert = true
        dialog.focus.focus()
      }
      dialogKind = want
    }

    if (dialog === null && focusInApp && !firstRender) {
      if (rebuilt) view.focus.focus()
      // The screen may have been rebuilt behind the dialog (paused while it was open): the element
      // that had focus is gone then, so fall back to the current screen's focus target.
      else if (dialogClosed) (focusBeforeDialog?.isConnected ? focusBeforeDialog : view.focus).focus()
    }
    if (dialogClosed) focusBeforeDialog = null

    // Toast layer (expired toasts hide even before the reducer clears them on the next tick; a
    // tapped toast stays hidden until another one arrives).
    const toast = state.toast !== null && state.toast.untilMs > state.nowMs ? state.toast : null
    toastKey = toast === null ? '' : `${toast.untilMs}|${toast.text}`
    setText(toastEl, toast?.text ?? '')
    setHidden(toastEl, toast === null || toastKey === dismissedToast)

    // Debug layer.
    setHidden(debugPanel, !state.debug)
    if (state.debug) setText(debugPre, debugText(state))
  }

  return { render }
}
