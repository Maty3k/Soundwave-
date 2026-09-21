/**
 * Stations panel: a tab of the hunting screen on the device that runs the hunt (the hub). It says
 * which listener heard the last chirp loudest, lists the listeners (this phone, extra microphones,
 * stations on other devices) with their status and level, and adds phones (pairing with QR or
 * pasted codes), extra microphones and a level calibration.
 *
 * Built once; render(state) patches it in place and is cheap when nothing changed (it runs about
 * 60 times per second while hunting). The camera runs only while the pairing step is scanAnswer
 * and the panel is on screen; dispose() stops it for good.
 *
 * Also exports the pieces the station screen (stationScreen.ts) shares: small DOM helpers, the
 * pairing-code card (QR + text + Copy / Share) and the camera scan box.
 */
import type { Config } from '../config.ts'
import {
  comparisonHeadline,
  listenerDeltaText,
  listenerKindText,
  listenerLevelText,
  listenerStatusText,
  micButtonText,
  removeListenerLabel,
  STATIONS_COPY,
} from '../copy.ts'
import { QrScanner, qrScanSupported, qrSvg } from '../net/qr.ts'
import type { AppState, ListenerKind, ListenerView, PairingView, StationsView } from '../types.ts'

// ---- Small DOM helpers (shared with stationScreen.ts) --------------------------------------------

type AttrValue = string | number | boolean | null | undefined
type Child = Node | string | null

/** createElement with attributes (false / null / undefined skipped, true -> '') and text-safe children. */
export function h<K extends keyof HTMLElementTagNameMap>(
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

const textCache = new WeakMap<Node, string>()

/** Set textContent only when it differs from what was last written here. */
export function setText(el: HTMLElement, text: string): void {
  if (textCache.get(el) === text) return
  textCache.set(el, text)
  el.textContent = text
}

/** Set or remove (null) an attribute only when it changes. */
export function setAttr(el: Element, name: string, value: string | null): void {
  if (el.getAttribute(name) === value) return
  if (value === null) el.removeAttribute(name)
  else el.setAttribute(name, value)
}

export function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden
}

let uidCounter = 0

/** A document-unique id for label and ARIA wiring. */
export function uid(prefix: string): string {
  uidCounter++
  return `${prefix}-${uidCounter}`
}

const SVG_NS = 'http://www.w3.org/2000/svg'

export type IconName = ListenerKind | 'plus' | 'close' | 'lock'

/** 24 x 24 stroke icons (currentColor). */
const ICON_PATHS: Readonly<Record<IconName, readonly string[]>> = {
  self: ['M8.5 2.75h7a2 2 0 0 1 2 2v14.5a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2z', 'M11 18h2'],
  mic: ['M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z', 'M6 11a6 6 0 0 0 12 0', 'M12 17v4', 'M9 21h6'],
  station: [
    'M10 5h4a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 14 19h-4a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 10 5z',
    'M4.5 8a6 6 0 0 0 0 8',
    'M19.5 8a6 6 0 0 1 0 8',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  lock: ['M6.5 10.5h11A1.5 1.5 0 0 1 19 12v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19v-7a1.5 1.5 0 0 1 1.5-1.5z', 'M8 10.5V8a4 4 0 0 1 8 0v2.5'],
}

/** A decorative icon (aria-hidden); the text next to it carries the meaning. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const attrs: Record<string, string> = {
    viewBox: '0 0 24 24',
    class: 'st-icon',
    'aria-hidden': 'true',
    focusable: 'false',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v)
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

export type ButtonVariant = 'primary' | 'secondary' | 'danger'

/** A real <button type="button"> (.btn: at least 48 px tall), with an optional leading icon. */
export function button(label: string, onClick: () => void, variant: ButtonVariant = 'secondary', iconName?: IconName): HTMLButtonElement {
  const b = h('button', { type: 'button', class: `btn btn-${variant}` }, iconName === undefined ? null : icon(iconName), label)
  b.addEventListener('click', onClick)
  return b
}

/** A link-styled button for the other way through a step ('Paste the code instead'); 48 px tall. */
export function linkButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'stations-link' }, label)
  b.addEventListener('click', onClick)
  return b
}

/** Three pulsing dots for a short wait (static under prefers-reduced-motion). */
export function waitDots(): HTMLElement {
  return h('div', { class: 'stations-wait', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'))
}

/** The element is in the document, not hidden and the page is visible. */
export function isShown(el: HTMLElement): boolean {
  if (!el.isConnected || document.visibilityState === 'hidden') return false
  return typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.closest('[hidden]') === null
}

/** navigator.share exists (Share buttons are only offered then). */
export function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}

// ---- Pairing codes -------------------------------------------------------------------------------

/**
 * 'SW<n>.' (any format version, any case) and a run of base64url characters: how a pairing code
 * starts (a real one is 100-200 characters long). Anything else is some other QR code.
 */
const CODE_TOKEN = /SW\d+\.[A-Za-z0-9_-]{16}/i

/**
 * Scanned text that holds a pairing code, possibly with text around it or from another version of
 * the app. It goes to the hub or station as it is (trimmed), like a pasted code: their decoder
 * (sdpCode.decodeCode) tolerates text around the code, tries every code in it and explains what is
 * wrong with a bad one.
 */
export function isPairingCode(text: string): boolean {
  return CODE_TOKEN.test(text)
}

export interface CodeCardHandlers {
  onCopyCode(code: string): void
  onShareCode(code: string): void
}

/** QR size on screen; about 220 px keeps the pairing step on one 390 x 844 phone screen. */
const QR_PX = 220

/**
 * A pairing code to show to the other device: the QR code on a white card (with its quiet zone),
 * the code as text in a read-only monospace field, Copy code and (where the browser can) Share.
 */
export function codeCard(code: string, handlers: CodeCardHandlers, qrLabel: string, textLabel: string): HTMLElement {
  const C = STATIONS_COPY
  let qr: HTMLElement
  try {
    const svg = qrSvg(code, QR_PX)
    svg.setAttribute('aria-label', qrLabel)
    qr = h('div', { class: 'pair-qr' }, svg)
  } catch {
    qr = h('p', { class: 'pair-qr-failed' }, C.scan.qrFailed)
  }
  const text = h('textarea', {
    class: 'pair-code__text',
    readonly: true,
    rows: 4, // CSS sizes it to the code where the browser can (field-sizing)
    spellcheck: 'false',
    'aria-label': textLabel,
  })
  text.value = code
  text.addEventListener('focus', () => text.select())
  const copy = button(C.pair.copy, () => handlers.onCopyCode(code))
  const share = canShare() ? button(C.pair.share, () => handlers.onShareCode(code)) : null
  return h('div', { class: 'pair-code' }, qr, h('div', { class: 'pair-code__side' }, text, h('div', { class: 'pair-code__actions' }, copy, share)))
}

export interface ScanBox {
  readonly el: HTMLElement
  /**
   * Run the camera while `active`, stop it otherwise; call on every render. A failed start is not
   * retried until the box was inactive once (or the user taps Try the camera again), and after a
   * code was accepted the camera stays off until the box was inactive once.
   */
  setActive(active: boolean): void
  /** Stop the camera for good. */
  dispose(): void
}

/** While the camera runs, check this often that the box is still on screen (the hunting screen stops rendering a tab it hides). */
const WATCHDOG_MS = 250

/**
 * Live camera view (<video playsinline muted>) with a viewfinder frame, reading QR codes with
 * QrScanner. The first result that holds a pairing code (isPairingCode) goes to onCode (trimmed),
 * once; the camera is stopped at that moment. Other QR codes get a hint. The camera never outlives
 * the step: it stops on setActive(false), on dispose(), and from a watchdog when the box leaves the
 * screen or the page is hidden.
 */
export function createScanBox(onCode: (code: string) => void): ScanBox {
  const C = STATIONS_COPY.scan
  const video = h('video', { class: 'pair-scanner__video', playsinline: true, muted: true, 'aria-hidden': 'true' })
  video.muted = true
  video.playsInline = true
  const overlay = h('span', { class: 'pair-scanner__overlay', 'aria-hidden': 'true' }, C.starting)
  const view = h(
    'div',
    { class: 'pair-scanner__view', role: 'img', 'aria-label': C.label, tabindex: -1 },
    video,
    h('span', { class: 'pair-scanner__frame', 'aria-hidden': 'true' }),
    overlay,
  )
  const message = h('p', { class: 'pair-scanner__message', role: 'status' })
  const retry = button(C.retry, () => {
    // The button hides itself: keep focus on the camera view instead of dropping it to the page.
    const refocus = document.activeElement === retry
    failed = false
    reset()
    start()
    if (refocus) view.focus()
  })
  retry.hidden = true
  const el = h('div', { class: 'pair-scanner' }, view, message, retry)

  let scanner: QrScanner | null = null
  let running = false
  let failed = false
  let answered = false
  let disposed = false
  /** Bumped on every start and stop, so a late start() result of an older session is ignored. */
  let session = 0
  let watchdog: ReturnType<typeof setInterval> | null = null

  function showMessage(text: string): void {
    setText(message, text)
  }

  /** Back to the initial look: video area visible, no message, no retry button. */
  function reset(): void {
    showMessage('')
    setHidden(retry, true)
    setHidden(view, false)
  }

  function stop(): void {
    session++
    if (watchdog !== null) clearInterval(watchdog)
    watchdog = null
    if (running) scanner?.stop()
    running = false
  }

  function onResult(text: string): void {
    if (answered || disposed || !running) return
    const code = text.trim()
    if (!isPairingCode(code)) {
      showMessage(C.notOurs)
      return
    }
    answered = true
    stop()
    showMessage('')
    onCode(code)
  }

  function start(): void {
    if (disposed || running || failed || answered) return
    scanner ??= new QrScanner(video)
    const sc = scanner
    sc.onResult = onResult
    running = true
    const mine = ++session
    setHidden(view, false)
    setHidden(overlay, false)
    watchdog = setInterval(() => {
      if (!isShown(el)) stop()
    }, WATCHDOG_MS)
    sc.start().then(
      () => {
        if (mine === session) setHidden(overlay, true)
      },
      (err: unknown) => {
        if (mine !== session) return
        stop()
        failed = true
        setHidden(view, true)
        showMessage(err instanceof Error && err.message !== '' ? err.message : C.failed)
        // Offer a retry only when the camera itself failed (blocked, busy): a browser that cannot
        // read QR codes at all would fail the same way again.
        void qrScanSupported().then((ok) => {
          if (failed && !disposed) setHidden(retry, !ok)
        })
      },
    )
  }

  function setActive(active: boolean): void {
    if (active) {
      start()
      return
    }
    if (running) stop()
    if (failed || answered) {
      failed = false
      answered = false
      reset()
    } else if (message.textContent !== '') showMessage('')
  }

  function dispose(): void {
    if (running) stop()
    disposed = true
    if (scanner !== null) scanner.onResult = null
  }

  return { el, setActive, dispose }
}

// ---- The panel -----------------------------------------------------------------------------------

export interface StationsPanelHandlers {
  onPairStart(): void
  onPairStep(step: 'showOffer' | 'scanAnswer' | 'pasteAnswer'): void
  onPairAnswer(code: string): void
  onPairCancel(): void
  onAddMic(deviceId: string): void
  onRemoveListener(id: string): void
  onCalibrate(): void
  onCopyCode(code: string): void
  onShareCode(code: string): void
}

export interface StationsPanel {
  readonly el: HTMLElement
  render(state: AppState): void
  /** Stop the camera; the panel does nothing afterwards. */
  dispose(): void
}

/** A remove button waits this long for the confirming second tap. */
const REMOVE_CONFIRM_MS = 4000
/**
 * A new headline is read out once it has held this long: in live mode the loudest listener can
 * flip twice a second, and a station's report arriving just after the chirp would otherwise make
 * the headline read out twice ('Only this phone heard it', then 'Loudest: Kitchen').
 */
const ANNOUNCE_SETTLE_MS = 1500
/** A gap between renders longer than this means the tab was closed: what it shows on return is not news. */
const RENDER_GAP_MS = 1000

const IDLE_PAIRING: PairingView = { step: 'idle', offerCode: null, message: null, canScan: false }

interface Row {
  readonly li: HTMLLIElement
  readonly kind: ListenerKind
  readonly name: HTMLElement
  readonly kindText: HTMLElement
  readonly status: HTMLElement
  readonly db: HTMLElement
  readonly deltaWrap: HTMLElement
  readonly deltaPrefix: HTMLElement
  readonly delta: HTMLElement
  readonly remove: HTMLButtonElement | null
  listenerName: string
}

interface PairCard {
  readonly children: readonly Node[]
  /** Receives focus when the step appears after a user action inside the panel. */
  readonly focus: HTMLElement
  /** Shows pairing.message (the error step always shows a message). */
  readonly message: HTMLElement
  /** Shown only when this device can scan QR codes (pairing.canScan). */
  readonly scanOnly: readonly HTMLElement[]
}

export function createStationsPanel(handlers: StationsPanelHandlers, _cfg: Config): StationsPanel {
  const C = STATIONS_COPY
  const P = C.pair

  const titleId = uid('stations-title')
  const title = h('h2', { class: 'sr-only', id: titleId, tabindex: -1 }, C.title)

  // Summary: the loudest listener of the last chirp. Screen readers get changes through the
  // announcer below (settled headlines and calibration), not from the summary itself.
  const summaryTitle = h('p', { class: 'stations-summary__title' })
  const summaryDetail = h('p', { class: 'stations-summary__detail' })
  const summary = h('div', { class: 'stations-summary', 'data-kind': 'empty' }, summaryTitle, summaryDetail)

  const list = h('ul', { class: 'stations-list', 'aria-label': C.listLabel, hidden: true })

  const addPhone = button(C.addPhone, () => handlers.onPairStart(), 'secondary', 'plus')
  addPhone.classList.add('stations-add')
  const micTitleId = uid('stations-mics')
  const micButtons = h('div', { class: 'stations-mics__buttons' })
  const micGroup = h(
    'div',
    { class: 'stations-mics', role: 'group', 'aria-labelledby': micTitleId, hidden: true },
    h('p', { class: 'stations-group-title', id: micTitleId }, C.addMic),
    micButtons,
  )
  const calibText = h('p', { class: 'stations-calib__text' }, C.calibrateHint)
  const calibBtn = button(C.calibrate, () => handlers.onCalibrate())
  const calib = h('div', { class: 'stations-calib', hidden: true }, calibText, calibBtn)
  const actions = h('div', { class: 'stations-actions' }, addPhone, micGroup, calib)

  const pairHost = h('div', { class: 'pair', hidden: true })
  const privacy = h('p', { class: 'stations-privacy' }, icon('lock'), h('span', {}, C.privacy))
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' })

  const el = h('section', { class: 'stations', 'aria-labelledby': titleId }, title, summary, list, actions, pairHost, privacy, announcer)

  const scanBox = createScanBox((code) => handlers.onPairAnswer(code))
  const rows = new Map<string, Row>()
  let order = ''
  let micKey = ''
  let pairKey = 'idle|'
  let card: PairCard | null = null
  let armed: { readonly id: string; readonly untilMs: number } | null = null
  let lastView: StationsView | null | undefined = undefined
  let lastArmedId = ''
  let disposed = false
  /** Headline title on screen, since when, the last one read out, and the last render showing it. */
  let headTitle = ''
  let headSinceMs = 0
  let spokenTitle = ''
  let summaryShownAtMs = -Infinity
  /** Calibration state seen last (null before the first render) and a calibration that finished here. */
  let wasCalibrating: boolean | null = null
  let calibrated = false

  function say(text: string): void {
    setText(announcer, text)
  }

  // ---- Listener rows -----------------------------------------------------------------------------

  function createRow(l: ListenerView): Row {
    const name = h('span', { class: 'stations-row__name' })
    const kindText = h('span', { class: 'stations-row__kind' })
    const status = h('span', { class: 'stations-row__status' })
    const db = h('span', { class: 'stations-row__db num' })
    const delta = h('span', { class: 'stations-row__delta num' })
    const deltaPrefix = h('span', { class: 'sr-only' }, `${C.deltaPrefix} `)
    const deltaWrap = h('span', { class: 'stations-row__deltawrap' }, deltaPrefix, delta)
    let remove: HTMLButtonElement | null = null
    if (l.kind !== 'self') {
      remove = h('button', { type: 'button', class: 'stations-row__remove' }, icon('close'), h('span', { class: 'stations-row__remove-text' }, C.removeConfirm))
      const id = l.id
      remove.addEventListener('click', () => onRemoveClick(id))
    }
    const li = h(
      'li',
      { class: 'stations-row', 'data-kind': l.kind },
      h('span', { class: 'stations-row__icon', 'aria-hidden': 'true' }, icon(l.kind)),
      // Kind and status are separate words; the status shape (dot, ring, triangle) sits between them.
      h('span', { class: 'stations-row__main' }, name, h('span', { class: 'stations-row__meta' }, kindText, ' ', status)),
      h('span', { class: 'stations-row__level' }, db, deltaWrap),
      remove,
    )
    return { li, kind: l.kind, name, kindText, status, db, deltaWrap, deltaPrefix, delta, remove, listenerName: '' }
  }

  function syncRemove(row: Row, isArmed: boolean): void {
    if (row.remove === null) return
    setAttr(row.remove, 'data-armed', isArmed ? '' : null)
    setAttr(row.remove, 'aria-label', removeListenerLabel(row.listenerName, isArmed))
  }

  /** First tap arms the button ('Remove?'), a second tap within REMOVE_CONFIRM_MS removes. */
  function onRemoveClick(id: string): void {
    const now = performance.now()
    if (armed !== null && armed.id === id && now < armed.untilMs) {
      armed = null
      handlers.onRemoveListener(id)
      return
    }
    armed = { id, untilMs: now + REMOVE_CONFIRM_MS }
    for (const [rowId, row] of rows) syncRemove(row, rowId === id)
  }

  function patchRow(row: Row, l: ListenerView, armedId: string): void {
    row.listenerName = l.name
    setText(row.name, l.name)
    const kind = listenerKindText(l.kind)
    // This device's own row is named 'This phone' (or 'This device' on a laptop): its kind would
    // only repeat (or contradict) that.
    setText(row.kindText, kind)
    setHidden(row.kindText, l.kind === 'self' || kind === l.name)
    setText(row.status, listenerStatusText(l.status))
    setAttr(row.li, 'data-status', l.status)
    setAttr(row.li, 'data-loudest', l.isLoudest ? '' : null)
    setText(row.db, listenerLevelText(l.levelDb))
    const delta = listenerDeltaText(l)
    setText(row.delta, delta)
    setHidden(row.deltaWrap, delta === '')
    setHidden(row.deltaPrefix, l.isLoudest)
    syncRemove(row, armedId === l.id)
  }

  function syncRows(listeners: readonly ListenerView[], armedId: string): void {
    const seen = new Set<string>()
    let created = false
    for (const l of listeners) {
      let row = rows.get(l.id)
      if (row === undefined || row.kind !== l.kind) {
        row?.li.remove()
        row = createRow(l)
        rows.set(l.id, row)
        created = true
      }
      patchRow(row, l, armedId)
      seen.add(l.id)
    }
    for (const [id, row] of rows) {
      if (seen.has(id)) continue
      row.li.remove()
      rows.delete(id)
    }
    const key = listeners.map((l) => l.id).join('\n')
    if (key !== order || created) {
      // A listener that joined after the calibration has not been calibrated.
      if (key !== order && order !== '') calibrated = false
      order = key
      let i = 0
      for (const l of listeners) {
        const li = rows.get(l.id)?.li
        if (li === undefined) continue
        const at = list.children.item(i)
        if (at !== li) list.insertBefore(li, at)
        i++
      }
    }
    setHidden(list, listeners.length === 0)
  }

  function syncMics(mics: StationsView['availableMics']): void {
    const key = mics.map((m) => `${m.deviceId}\u0000${m.label}`).join('\u0001')
    if (key === micKey) return
    micKey = key
    micButtons.replaceChildren(...mics.map((m, i) => button(micButtonText(m.label, i), () => handlers.onAddMic(m.deviceId), 'secondary', 'plus')))
    setHidden(micGroup, mics.length === 0)
  }

  // ---- Pairing -----------------------------------------------------------------------------------

  const pairTitle = (text: string): HTMLElement => h('h3', { class: 'pair__title', tabindex: -1 }, text)
  const eyebrow = (text: string): HTMLElement => h('p', { class: 'pair__eyebrow' }, text)
  const help = (text: string): HTMLElement => h('p', { class: 'pair__help' }, text)
  const cancelButton = (): HTMLButtonElement => button(P.cancel, () => handlers.onPairCancel())
  const showCodeButton = (): HTMLButtonElement => button(P.showCode, () => handlers.onPairStep('showOffer'))

  function buildCard(p: PairingView): PairCard {
    const message = h('p', { class: 'pair__message', role: 'alert', hidden: true })
    switch (p.step) {
      case 'idle':
      case 'preparing': {
        const t = pairTitle(P.preparing)
        return { children: [t, waitDots(), message, cancelButton()], focus: t, message, scanOnly: [] }
      }
      case 'showOffer': {
        const t = pairTitle(P.showOfferTitle)
        const scan = button(P.scanAnswer, () => handlers.onPairStep('scanAnswer'))
        const paste = button(P.pasteAnswer, () => handlers.onPairStep('pasteAnswer'))
        const code = p.offerCode === null ? waitDots() : codeCard(p.offerCode, handlers, P.qrLabel, P.codeText)
        return {
          children: [
            eyebrow(P.step1),
            t,
            help(P.showOfferHelp),
            code,
            message,
            h('p', { class: 'pair__then' }, P.then),
            h('div', { class: 'pair__next' }, scan, paste),
            cancelButton(),
          ],
          focus: t,
          message,
          scanOnly: [scan],
        }
      }
      case 'scanAnswer': {
        const t = pairTitle(P.scanAnswer)
        const paste = button(P.pasteAnswer, () => handlers.onPairStep('pasteAnswer'))
        return {
          children: [eyebrow(P.step2), t, help(P.scanHelp), scanBox.el, message, h('div', { class: 'pair__next' }, paste, showCodeButton()), cancelButton()],
          focus: t,
          message,
          scanOnly: [],
        }
      }
      case 'pasteAnswer': {
        const t = pairTitle(P.pasteAnswer)
        const fieldId = uid('pair-paste')
        const area = h('textarea', {
          id: fieldId,
          class: 'pair-paste',
          rows: 3,
          placeholder: P.pastePlaceholder,
          spellcheck: 'false',
          autocomplete: 'off',
          autocapitalize: 'off',
          autocorrect: 'off',
          enterkeyhint: 'go',
        })
        const submit = (): void => {
          const code = area.value.trim()
          if (code === '') {
            area.focus()
            return
          }
          handlers.onPairAnswer(code)
        }
        // Codes never contain line breaks: Enter connects (Shift+Enter still types one).
        area.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault()
            submit()
          }
        })
        const scan = button(P.scanAnswer, () => handlers.onPairStep('scanAnswer'))
        return {
          children: [
            eyebrow(P.step2),
            t,
            help(P.pasteHelp),
            h('div', { class: 'pair-field' }, h('label', { class: 'pair-field__label', for: fieldId }, P.pasteLabel), area),
            message,
            button(P.connect, submit, 'primary'),
            h('div', { class: 'pair__next' }, scan, showCodeButton()),
            cancelButton(),
          ],
          focus: t,
          message,
          scanOnly: [scan],
        }
      }
      case 'connecting': {
        const t = pairTitle(P.connecting)
        return { children: [t, waitDots(), help(P.connectingHint), message, cancelButton()], focus: t, message, scanOnly: [] }
      }
      case 'error': {
        const t = pairTitle(P.errorTitle)
        if (p.offerCode !== null) {
          // The hub still has this pairing's code (only the reply was wrong): scan or paste the
          // reply again, so the other phone need not start over. A new code is the way out.
          const scan = button(P.scanAnswer, () => handlers.onPairStep('scanAnswer'), p.canScan ? 'primary' : 'secondary')
          const paste = button(P.pasteAnswer, () => handlers.onPairStep('pasteAnswer'), p.canScan ? 'secondary' : 'primary')
          return {
            children: [t, message, h('div', { class: 'pair__next' }, scan, paste), linkButton(P.newCode, () => handlers.onPairStart()), cancelButton()],
            focus: t,
            message,
            scanOnly: [scan],
          }
        }
        return {
          children: [t, message, h('div', { class: 'pair__next' }, button(P.tryAgain, () => handlers.onPairStart(), 'primary'), cancelButton())],
          focus: t,
          message,
          scanOnly: [],
        }
      }
    }
  }

  function syncPairing(p: PairingView, hadFocus: boolean): void {
    const key = `${p.step}|${p.offerCode ?? ''}`
    if (key !== pairKey) {
      const wasIdle = pairKey.startsWith('idle|')
      pairKey = key
      if (p.step === 'idle') {
        card = null
        pairHost.replaceChildren()
        setHidden(pairHost, true)
        // Back to the list: focus returns to the button that started the pairing.
        if (hadFocus && !wasIdle) addPhone.focus()
      } else {
        card = buildCard(p)
        pairHost.replaceChildren(...card.children)
        setAttr(pairHost, 'data-step', p.step)
        setHidden(pairHost, false)
        if (hadFocus) {
          card.focus.focus()
          // The code to scan (or the camera) is what this step is for: bring all of it on screen,
          // above the hunting screen's sticky bottom bar (scroll-margin in style.css).
          pairHost.querySelector('.pair-qr, .pair-scanner__view')?.scrollIntoView({ block: 'nearest' })
        }
      }
    }
    if (card !== null) {
      const text = p.step === 'error' ? (p.message ?? P.errorFallback) : (p.message ?? '')
      setText(card.message, text)
      setHidden(card.message, text === '')
      for (const b of card.scanOnly) setHidden(b, !p.canScan)
    }
  }

  // ---- Render ------------------------------------------------------------------------------------

  function render(state: AppState): void {
    if (disposed) return
    const view = state.stations
    const pairing = view?.pairing ?? IDLE_PAIRING
    const pairingActive = pairing.step !== 'idle'
    const active = document.activeElement
    const hadFocus = active !== null && el.contains(active)

    const now = performance.now()
    const armedId = armed !== null && now < armed.untilMs ? armed.id : ''
    if (armedId === '') armed = null
    // The hub hands out a new StationsView object whenever anything in it changed.
    if (view !== lastView || armedId !== lastArmedId) {
      lastView = view
      lastArmedId = armedId
      const listeners = view?.listeners ?? []
      setHidden(summary, pairingActive)
      setHidden(actions, pairingActive)
      if (pairingActive) setHidden(list, true)
      else {
        const head = comparisonHeadline(view?.comparison ?? null, listeners)
        setAttr(summary, 'data-kind', head.kind)
        setText(summaryTitle, head.title)
        setHidden(summaryTitle, head.title === '')
        setText(summaryDetail, head.detail)
        if (head.title !== headTitle) {
          headTitle = head.title
          headSinceMs = now
        }
        syncRows(listeners, armedId)
        syncMics(view?.availableMics ?? [])
        const calibrating = view?.calibrating ?? false
        if (calibrating !== wasCalibrating) {
          // Calibrate hides itself, so its result is read out: waiting, then done.
          if (wasCalibrating !== null) say(calibrating ? C.calibrating : C.calibrated)
          calibrated = wasCalibrating === true && !calibrating
          wasCalibrating = calibrating
        }
        setHidden(calib, listeners.length < 2 && !calibrating)
        setAttr(calib, 'data-calibrating', calibrating ? '' : null)
        setAttr(calib, 'data-calibrated', calibrated && !calibrating ? '' : null)
        setText(calibText, calibrating ? C.calibrating : calibrated ? C.calibrated : C.calibrateHint)
        setHidden(calibBtn, calibrating)
      }
      syncPairing(pairing, hadFocus)
      // The focused control went away (a removed listener, a microphone that was added, Calibrate
      // while calibrating): keep keyboard and screen-reader users in the panel.
      const focused = document.activeElement
      if (hadFocus && (focused === null || !el.contains(focused) || focused.closest('[hidden]') !== null)) title.focus()
    }
    if (!pairingActive) {
      // Read out a headline that changed and settled; not the one shown when the tab opens or the
      // pairing ends (it is on screen, and it is not news).
      if (now - summaryShownAtMs > RENDER_GAP_MS) spokenTitle = headTitle
      summaryShownAtMs = now
      if (headTitle !== spokenTitle && now - headSinceMs >= ANNOUNCE_SETTLE_MS) {
        spokenTitle = headTitle
        if (headTitle !== '') say(headTitle)
      }
    }
    scanBox.setActive(pairing.step === 'scanAnswer' && isShown(el))
  }

  function dispose(): void {
    disposed = true
    scanBox.dispose()
  }

  return { el, render, dispose }
}
