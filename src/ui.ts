/**
 * DOM rendering for every screen, without a framework.
 *
 * mountUi builds the shell once; render(state) is called at most once per animation frame. A
 * screen's DOM is rebuilt only when its identity changes (screen kind, paused needsGesture or error
 * code; the stop dialog is its own layer, rebuilt when confirmStop flips). Everything else is
 * patched in place: text via textContent (never innerHTML), attributes, and CSS custom properties
 * (--pct, --ghost, --heat, --level, --p). Each patch is skipped when the value did not change,
 * because render runs about 60 times per second while hunting.
 */
import type { Config } from './config.ts'
import {
  COPY,
  countdownText,
  debugText,
  deltaLine,
  ERROR_COPY,
  formatClock,
  formatHz,
  formatPct,
  GUIDANCE,
  guidanceText,
  heardText,
  heroLabel,
  historyItemLabel,
  historyItemText,
  liveDeltaLine,
  meterValueText,
  rawAudioText,
} from './copy.ts'
import type { ErrorAction } from './copy.ts'
import type { AppState, ErrorCode, HuntView, LockMode, MicDiag, Reading, Screen, Verdict } from './types.ts'

/** Callbacks for every control. main.ts turns them into store events and side effects. */
export interface UiHandlers {
  onStart(): void
  onStopRequest(): void
  onStopConfirm(): void
  onStopCancel(): void
  onConfirmLock(): void
  onNotIt(): void
  onRelisten(): void
  onResetBest(): void
  onResume(): void
  onRetry(): void
  onBack(): void
  onReload(): void
  onCopyLink(): void
  onToggleClicks(): void
  onToggleHaptics(): void
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

type ButtonVariant = 'primary' | 'secondary' | 'danger'

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
    h('p', { class: 'card-body' }, copy.body),
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
}

function landingView(state: AppState, handlers: UiHandlers): ScreenView {
  const L = COPY.landing
  const title = heading(COPY.appName, 'screen-title brand-title')
  const caps = state.caps
  const supported = caps.secureContext && caps.getUserMedia && caps.audioContext
  const cta = supported
    ? h(
        'div',
        { class: 'cta' },
        button(L.start, () => handlers.onStart(), 'primary'),
        h('p', { class: 'caption' }, L.caption),
      )
    : h('div', { class: 'cta' }, errorCard('unsupported', handlers, 'h2', ['back']).el) // Back has nowhere to go here
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
  return { el, focus: title, update() {} }
}

function requestingView(handlers: UiHandlers, cfg: Config): ScreenView {
  const R = COPY.requesting
  const title = heading(R.title)
  const hint = h('p', { class: 'hint', hidden: true }, R.hint)
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
  const el = section(
    'listening',
    h(
      'div',
      { class: 'listening-main' },
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
      h('p', { class: 'tip' }, T.tip),
      h('div', { 'aria-live': 'polite' }, noBeep),
      rawBadge.el,
    ),
    h('div', { class: 'bottombar' }, button(T.stop, () => handlers.onStopRequest(), 'secondary')),
  )
  return {
    el,
    focus: title,
    update(state) {
      const screen = state.screen
      if (screen.kind !== 'listening') return
      const sinceMs = state.nowMs - screen.sinceMs
      setText(elapsed, formatClock(sinceMs / 1000))
      setVar(micRow, '--level', clamp(state.micLevel, 0, 1).toFixed(3))
      setHidden(noBeep, sinceMs < cfg.noBeepHintMs)
      syncBadge(rawBadge, state.mic)
    },
  }
}

function lockedView(handlers: UiHandlers, cfg: Config): ScreenView {
  const K = COPY.locked
  const title = heading(K.banner, 'screen-title banner')
  const freq = h('p', { class: 'freq-big num' })
  const heard = h('p', { class: 'heard' })
  const advance = h('div', { class: 'advance', 'aria-hidden': 'true' }, h('span', { class: 'advance-fill' }))
  const el = section(
    'locked centered',
    h('span', { class: 'banner-dot', 'aria-hidden': 'true' }),
    title,
    freq,
    heard,
    advance,
    h(
      'div',
      { class: 'actions' },
      button(K.startHunting, () => handlers.onConfirmLock(), 'primary'),
      button(K.notIt, () => handlers.onNotIt(), 'secondary'),
    ),
  )
  return {
    el,
    focus: title,
    update(state) {
      const screen = state.screen
      if (screen.kind !== 'locked') return
      const lock = state.lock
      setText(freq, formatHz(lock?.f0Hz ?? Number.NaN))
      setText(heard, lock ? heardText(lock) : '')
      const p = clamp((state.nowMs - screen.sinceMs) / cfg.lockedBannerMs, 0, 1)
      setVar(advance, '--p', p.toFixed(3))
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

const HEAT_STOPS: readonly (readonly [number, number, number])[] = ['#2F5BE0', '#3F9BE8', '#7FC4D8', '#F2C14E', '#FF8A1F'].map(
  (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] as const,
)

/** Colour of the heat ramp (same stops as --heat-ramp in style.css) at 0..100. */
function heatColor(pct: number): string {
  const t = (clamp(pct, 0, 100) / 100) * (HEAT_STOPS.length - 1)
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(t))
  const f = t - i
  const a = HEAT_STOPS[i]!
  const b = HEAT_STOPS[i + 1]!
  const mix = (k: 0 | 1 | 2): number => Math.round(a[k] + (b[k] - a[k]) * f)
  return `rgb(${mix(0)} ${mix(1)} ${mix(2)})`
}

/** Countdown kinds worth a polite announcement when they begin. */
const ANNOUNCED_PHASES: ReadonlySet<string> = new Set(['hold', 'late', 'overdue', 'lost'])

function huntingView(state: AppState, handlers: UiHandlers, cfg: Config): ScreenView {
  const H = COPY.hunting
  const title = heading(H.title, 'screen-title sr-only')

  // Top bar: frequency, mode, toggles.
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

  // Verdict hero: the word is the assertive live region; the sub-line carries the raw dB change.
  const verdict = h('p', { class: 'verdict', 'aria-live': 'assertive', 'aria-atomic': 'true' })
  const delta = h('span', { class: 'delta num' })
  const newBest = h('span', { class: 'newbest', hidden: true }, h('span', { 'aria-hidden': 'true' }, '★ '), H.newBest)
  const hero = h('div', { class: 'hero', 'data-verdict': 'none' }, verdict, h('p', { class: 'subline' }, delta, newBest))

  // Heat meter: gradient track, a mask from pct to the end, ghost at the previous reading, MAX cap.
  const numeral = h('span', { class: 'numeral num', 'aria-hidden': 'true' })
  const ghost = h('span', { class: 'meter-ghost', hidden: true })
  const cap = h('span', { class: 'meter-cap', hidden: true }, h('span', { class: 'meter-cap-label' }, H.max))
  const meter = h(
    'div',
    { class: 'meter', role: 'meter', 'aria-label': H.meterLabel, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 },
    h('span', { class: 'meter-track' }, h('span', { class: 'meter-rest' }), cap, ghost),
  )
  const meterBlock = h(
    'div',
    { class: 'meter-block' },
    h('div', { class: 'meter-head' }, numeral, h('span', { class: 'numeral-unit', 'aria-hidden': 'true' }, H.ofHundred)),
    meter,
    h('div', { class: 'meter-scale', 'aria-hidden': 'true' }, h('span', {}, H.scaleCold), h('span', {}, H.scaleHot)),
  )

  // Countdown with the "hearing it" dot; phase changes are announced politely.
  const hearing = h('span', { class: 'hearing', hidden: true }, h('span', { class: 'hearing-dot', 'aria-hidden': 'true' }), H.hearing)
  const countdown = h('span', { class: 'countdown-text' })
  const countdownRow = h('p', { class: 'countdown' }, hearing, countdown)
  const phaseLive = h('span', { class: 'sr-only', 'aria-live': 'polite' })

  // History strip: a fixed pool of historyShown items, oldest left. `shows` remembers the Reading
  // object each item was last drawn from (hunt views reuse unchanged Reading objects).
  const pool = Array.from({ length: Math.max(0, cfg.historyShown) }, () => {
    const vis = h('span', { 'aria-hidden': 'true' })
    const sr = h('span', { class: 'sr-only' })
    return { li: h('li', { hidden: true }, vis, sr), vis, sr, shows: null as Reading | null, current: false }
  })
  const history = h('ol', { class: 'history', 'aria-label': H.history, hidden: true }, ...pool.map((p) => p.li))

  const guidance = h('p', { class: 'guidance' })
  const rawBadge = badge()

  const el = section(
    'hunting',
    title,
    topbar,
    hero,
    meterBlock,
    h('div', { class: 'info' }, countdownRow, phaseLive, history, guidance, rawBadge.el),
    h(
      'div',
      { class: 'bottombar' },
      button(H.resetBest, () => handlers.onResetBest(), 'secondary'),
      button(H.relisten, () => handlers.onRelisten(), 'secondary'),
      button(H.stop, () => handlers.onStopRequest(), 'secondary'),
    ),
  )

  let heroKey: string | null = null
  let phase: string | null = null
  let shownF0: number | null = null
  let meterKey = ''

  return {
    el,
    focus: title,
    update(state) {
      const view = state.hunt
      const lock = state.lock
      const mode: LockMode = view?.mode ?? lock?.mode ?? 'chirp'

      const f0 = view?.f0Hz ?? lock?.f0Hz ?? Number.NaN
      if (!Object.is(f0, shownF0)) {
        shownF0 = f0
        setText(freqValue, formatHz(f0))
      }
      setText(modeValue, mode === 'live' ? H.modeLive : H.modeChirp)
      setAttr(modeChip, 'data-mode', mode)
      syncToggle(clicks, state.settings.clicks)
      if (haptics) syncToggle(haptics, state.settings.haptics)

      const m = heroModel(view, mode, cfg)
      if (m.key !== heroKey) {
        heroKey = m.key
        announce(verdict, heroLabel(view))
        setAttr(hero, 'data-verdict', m.verdict ?? 'none')
      }
      setText(delta, m.sub)
      setHidden(delta, m.sub === '')
      setHidden(newBest, !m.newBest)

      // The meter changes once per reading (or per held-level change in live mode): skip the
      // string and colour work on the ~60 frames per second where nothing moved.
      const key = `${m.pct}|${m.prevPct}|${m.clipped}`
      if (key !== meterKey) {
        meterKey = key
        const pct = m.pct ?? 0
        setVar(meterBlock, '--pct', pct.toFixed(1))
        setVar(meterBlock, '--heat', heatColor(pct))
        setAttr(meterBlock, 'data-empty', m.pct === null ? '' : null)
        setText(numeral, formatPct(m.pct))
        setAttr(meter, 'aria-valuenow', String(Math.round(pct)))
        setAttr(meter, 'aria-valuetext', meterValueText(m.pct, m.prevPct, m.clipped))
        setHidden(ghost, m.prevPct === null)
        if (m.prevPct !== null) setVar(meterBlock, '--ghost', m.prevPct.toFixed(1))
        setHidden(cap, !m.clipped)
      }

      const cd = mode === 'live' ? null : (view?.countdown ?? null)
      const cdText = countdownText(cd)
      const isHearing = view?.hearing ?? false
      setText(countdown, cdText)
      setAttr(countdownRow, 'data-kind', cd?.kind ?? 'none')
      setHidden(countdown, cdText === '')
      setHidden(hearing, !isHearing)
      setHidden(countdownRow, cdText === '' && !isHearing)
      const kind = cd?.kind ?? 'none'
      if (kind !== phase) {
        phase = kind
        setText(phaseLive, ANNOUNCED_PHASES.has(kind) ? cdText : '')
      }

      const readings = view?.readings ?? []
      const start = Math.max(0, readings.length - pool.length)
      const shown = readings.length - start
      for (let i = 0; i < pool.length; i++) {
        const item = pool[i]!
        const r = i < shown ? (readings[start + i] ?? null) : null
        const current = i === shown - 1
        if (r === item.shows && current === item.current) continue // same Reading object: nothing to redraw
        item.shows = r
        item.current = current
        setHidden(item.li, r === null)
        if (r === null) continue
        setText(item.vis, historyItemText(r))
        setText(item.sr, historyItemLabel(r))
        setAttr(item.li, 'data-verdict', r.isNewBest ? 'best' : r.verdict)
        setAttr(item.li, 'aria-current', current ? 'true' : null)
      }
      setHidden(history, shown === 0)

      setText(guidance, view ? guidanceText(view) : GUIDANCE.default)
      syncBadge(rawBadge, state.mic)
    },
  }
}

function pausedView(needsGesture: boolean, handlers: UiHandlers): ScreenView {
  const P = COPY.paused
  const title = heading(P.title)
  const resume = needsGesture ? button(P.resume, () => handlers.onResume(), 'primary') : null
  const el = section(
    'paused centered',
    h('div', { class: 'pause-icon', 'aria-hidden': 'true' }, h('span'), h('span')),
    title,
    resume ?? h('p', { class: 'muted', role: 'status' }, P.resuming),
  )
  return { el, focus: resume ?? title, update() {} }
}

function errorView(code: ErrorCode, handlers: UiHandlers): ScreenView {
  const card = errorCard(code, handlers, 'h1')
  return { el: section('error centered', card.el), focus: card.title, update() {} }
}

/** Identity of the screen DOM: rebuilt only when this changes. */
function screenKey(screen: Screen): string {
  switch (screen.kind) {
    case 'paused':
      return `paused:${screen.needsGesture ? 'gesture' : 'auto'}`
    case 'error':
      return `error:${screen.code}`
    default:
      return screen.kind
  }
}

function buildView(state: AppState, handlers: UiHandlers, cfg: Config): ScreenView {
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
      return huntingView(state, handlers, cfg)
    case 'paused':
      return pausedView(screen.needsGesture, handlers)
    case 'error':
      return errorView(screen.code, handlers)
  }
}

// ---- Stop confirmation dialog --------------------------------------------------------------------

interface Dialog {
  readonly el: HTMLElement
  readonly focus: HTMLElement
}

/** Modal alertdialog; Escape or a tap on the backdrop keeps going, Tab cycles between the two buttons. */
function stopDialog(handlers: UiHandlers): Dialog {
  const C = COPY.stopConfirm
  const stop = button(C.stop, () => handlers.onStopConfirm(), 'danger')
  const keep = button(C.keepGoing, () => handlers.onStopCancel(), 'primary')
  // tabindex -1: a click on the dialog's text focuses the dialog instead of <body>, so Escape and
  // Tab still reach the scrim's key handler.
  const dialog = h(
    'div',
    { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'stop-title', tabindex: -1 },
    h('h2', { class: 'dialog-title', id: 'stop-title' }, C.title),
    h('div', { class: 'dialog-actions' }, stop, keep),
  )
  const scrim = h('div', { class: 'scrim' }, dialog)
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) handlers.onStopCancel()
  })
  scrim.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      handlers.onStopCancel()
    } else if (e.key === 'Tab') {
      const active = document.activeElement
      if (e.shiftKey && active === stop) {
        e.preventDefault()
        keep.focus()
      } else if (!e.shiftKey && active === keep) {
        e.preventDefault()
        stop.focus()
      }
    }
  })
  return { el: scrim, focus: keep }
}

// ---- Mount ---------------------------------------------------------------------------------------

/**
 * Take over `root` (the <main id="app">) and return the renderer. render(state) is idempotent and
 * cheap when nothing changed; focus moves to a new screen's heading (or its main action) only when
 * focus was inside the app, so page load and background updates never steal it.
 */
export function mountUi(root: HTMLElement, handlers: UiHandlers, cfg: Config): { render(state: AppState): void } {
  const screenHost = h('div', { class: 'screen-host' })
  const debugPre = h('pre', { class: 'debug-text' })
  const debugPanel = h('section', { class: 'debug', 'aria-label': COPY.debug.title, hidden: true }, h('h2', {}, COPY.debug.title), debugPre)
  const toastText = h('p', { class: 'toast', hidden: true })
  const toastRegion = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' }, toastText)
  const dialogHost = h('div', { class: 'dialog-host' })
  root.classList.add('app')
  root.replaceChildren(screenHost, debugPanel, toastRegion, dialogHost)

  let view: ScreenView | null = null
  let viewKey = ''
  let dialog: Dialog | null = null
  let focusBeforeDialog: HTMLElement | null = null
  let last: AppState | null = null

  function render(state: AppState): void {
    if (state === last) return
    const firstRender = last === null
    last = state

    const active = document.activeElement
    const focusInApp = active === null || active === document.body || root.contains(active)

    // Screen layer.
    const key = screenKey(state.screen)
    let rebuilt = false
    if (view === null || key !== viewKey) {
      view = buildView(state, handlers, cfg)
      viewKey = key
      screenHost.replaceChildren(view.el)
      root.setAttribute('data-screen', state.screen.kind)
      rebuilt = true
    }
    view.update(state)

    // Stop-confirm layer.
    let dialogClosed = false
    if (state.confirmStop && dialog === null) {
      focusBeforeDialog = active instanceof HTMLElement && root.contains(active) ? active : null
      dialog = stopDialog(handlers)
      dialogHost.replaceChildren(dialog.el)
      screenHost.inert = true
      debugPanel.inert = true
      dialog.focus.focus()
    } else if (!state.confirmStop && dialog !== null) {
      dialog = null
      dialogHost.replaceChildren()
      screenHost.inert = false
      debugPanel.inert = false
      dialogClosed = true
    }

    if (dialog === null && focusInApp && !firstRender) {
      if (rebuilt) view.focus.focus()
      // The screen may have been rebuilt behind the dialog (paused while it was open): the element
      // that had focus is gone then, so fall back to the current screen's focus target.
      else if (dialogClosed) (focusBeforeDialog?.isConnected ? focusBeforeDialog : view.focus).focus()
    }
    if (dialogClosed) focusBeforeDialog = null

    // Toast layer (expired toasts hide even before the reducer clears them on the next tick).
    const toast = state.toast !== null && state.toast.untilMs > state.nowMs ? state.toast.text : ''
    setText(toastText, toast)
    setHidden(toastText, toast === '')

    // Debug layer.
    setHidden(debugPanel, !state.debug)
    if (state.debug) setText(debugPre, debugText(state))
  }

  return { render }
}
