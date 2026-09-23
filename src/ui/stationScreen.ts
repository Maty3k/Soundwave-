/**
 * Station screen: this device is a listening station for another device's hunt (the main phone).
 * The steps come from state.stationMode: name the station, open the microphone, scan or paste the
 * main phone's code, show the reply code, then listen and send loudness numbers (never audio)
 * while connected.
 *
 * update(state) runs about 60 times per second: a step's DOM is built when the step (or the reply
 * code) changes and patched in place otherwise, so typed text survives. The camera runs only in
 * the scanOffer step while the screen is visible; dispose() stops it for good.
 */
import type { Config } from '../config.ts'
import {
  STATIONS_COPY,
  stationChirpsText,
  stationFreqText,
  stationLastChirpText,
  stationNameText,
  stationTitle,
} from '../copy.ts'
import { STATION_NAME_MAX } from '../stationMode.ts'
import type { AppState, StationModeView } from '../types.ts'
import {
  button,
  codeCard,
  createScanBox,
  h,
  icon,
  isShown,
  linkButton,
  setAttr,
  setHidden,
  setText,
  uid,
  waitDots,
} from './stationsPanel.ts'

export interface StationScreenHandlers {
  onStationName(name: string): void
  onStationStep(step: 'scanOffer' | 'pasteOffer'): void
  onStationOffer(code: string): void
  onStationStop(): void
  onCopyCode(code: string): void
  onShareCode(code: string): void
}

export interface StationScreen {
  readonly el: HTMLElement
  /** The screen heading; it receives focus when the screen appears after a user action. */
  readonly focus: HTMLElement
  update(state: AppState): void
  /** Stop the camera; the screen does nothing afterwards. */
  dispose(): void
}

/** Shown while state.stationMode is still null (main has not created the station yet). */
const FALLBACK_VIEW: StationModeView = {
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
}

/** Elements of the connected step patched on every update. */
interface ConnectedRefs {
  readonly name: HTMLElement
  readonly freq: HTMLElement
  readonly meter: HTMLElement
  readonly last: HTMLElement
  readonly sent: HTMLElement
}

function clamp01(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0 // NaN -> 0
}

export function createStationScreen(handlers: StationScreenHandlers, _cfg: Config): StationScreen {
  const S = STATIONS_COPY.station

  const eyebrow = h('p', { class: 'station__eyebrow', hidden: true })
  const title = h('h1', { class: 'screen-title station__title', id: 'screen-title', tabindex: -1 })
  const body = h('div', { class: 'station__body' })
  const actions = h('div', { class: 'station__actions' })
  const el = h(
    'section',
    { class: 'screen station', 'aria-labelledby': 'screen-title', 'data-step': 'name' },
    h('header', { class: 'station__head' }, eyebrow, title),
    body,
    actions,
  )

  const scanBox = createScanBox((code) => handlers.onStationOffer(code))

  let builtKey = ''
  let latest: StationModeView = FALLBACK_VIEW
  let connected: ConnectedRefs | null = null
  let message: HTMLElement | null = null
  let scanOnly: HTMLElement[] = []
  let shownLevel = ''
  let chirpAtMs: number | null = null
  let chirpWallMs: number | null = null
  let disposed = false

  const stop = (): void => handlers.onStationStop()
  /** Start pairing over: scan the main phone's code where the camera can, else paste it. */
  const pairAgain = (): void => handlers.onStationStep(latest.canScan ? 'scanOffer' : 'pasteOffer')
  const para = (cls: string, text: string): HTMLElement => h('p', { class: cls }, text)
  const privacyLine = (): HTMLElement => h('p', { class: 'stations-privacy' }, icon('lock'), h('span', {}, S.privacy))

  /** A labelled monospace box for a pasted code; Enter submits (codes never contain line breaks). */
  function codeField(label: string, onSubmit: (code: string) => void): { readonly field: HTMLElement; readonly submit: () => void } {
    const id = uid('station-code')
    const area = h('textarea', {
      id,
      class: 'pair-paste',
      rows: 3,
      placeholder: STATIONS_COPY.pair.pastePlaceholder,
      spellcheck: 'false',
      autocomplete: 'off',
      autocapitalize: 'off',
      autocorrect: 'off',
      enterkeyhint: 'go',
    })
    // The trimmed text goes to the station runtime as it is: its decoder finds the code in it.
    const submit = (): void => {
      const code = area.value.trim()
      if (code === '') area.focus()
      else onSubmit(code)
    }
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        submit()
      }
    })
    return { field: h('div', { class: 'pair-field' }, h('label', { class: 'pair-field__label', for: id }, label), area), submit }
  }

  function build(v: StationModeView): void {
    connected = null
    message = null
    scanOnly = []
    shownLevel = ''
    setAttr(el, 'data-step', v.step)
    setText(title, stationTitle(v.step))
    const step = v.step === 'scanOffer' || v.step === 'pasteOffer' ? S.step1 : v.step === 'showAnswer' ? S.step2 : ''
    setText(eyebrow, step)
    setHidden(eyebrow, step === '')

    let content: Node[]
    let buttons: Node[]
    switch (v.step) {
      case 'name': {
        const id = uid('station-name')
        const input = h('input', {
          id,
          class: 'station__input',
          type: 'text',
          maxlength: STATION_NAME_MAX,
          placeholder: S.namePlaceholder,
          autocomplete: 'off',
          autocapitalize: 'words',
          spellcheck: 'false',
          enterkeyhint: 'go',
        })
        const start = (): void => handlers.onStationName(input.value)
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault()
            start()
          }
        })
        content = [
          para('station__intro', S.intro),
          h('div', { class: 'station__field' }, h('label', { class: 'station__label', for: id }, S.nameLabel), input),
        ]
        buttons = [button(S.start, start, 'primary'), para('station__caption', S.startCaption), button(S.back, stop)]
        break
      }
      case 'starting':
        content = [waitDots(), para('station__hint', S.startingHint)]
        buttons = [button(S.stopShort, stop)]
        break
      case 'scanOffer':
        content = [para('station__help', S.scanHelp), scanBox.el, linkButton(S.pasteInstead, () => handlers.onStationStep('pasteOffer'))]
        buttons = [button(S.stopShort, stop)]
        break
      case 'pasteOffer': {
        const code = codeField(S.pasteLabel, (c) => handlers.onStationOffer(c))
        const scan = linkButton(S.scanInstead, () => handlers.onStationStep('scanOffer'))
        scanOnly = [scan]
        content = [para('station__help', S.pasteHelp), code.field, scan]
        buttons = [button(S.continue, code.submit, 'primary'), button(S.stopShort, stop)]
        break
      }
      case 'answering':
        content = [waitDots()]
        buttons = [button(S.stopShort, stop)]
        break
      case 'showAnswer':
        content = [
          para('station__help', S.answerHelp),
          v.answerCode === null ? waitDots() : codeCard(v.answerCode, handlers, S.answerQrLabel, S.answerText),
          // The runtime replaces the code every stationAnswerRefreshMs (the render key rebuilds this step).
          para('station__hint', S.refreshNote),
          h('p', { class: 'station__waiting', role: 'status' }, S.waitingForHub),
        ]
        buttons = [button(S.startOver, pairAgain), button(S.stopShort, stop)]
        break
      case 'connected': {
        const refs: ConnectedRefs = {
          name: para('station__name', ''),
          freq: para('station__freq', ''),
          meter: h('div', { class: 'station__meter' }, h('span', { class: 'station__meter-fill' })),
          last: h('dd', { class: 'station__stat-value num' }),
          sent: h('dd', { class: 'station__stat-value num' }),
        }
        connected = refs
        content = [
          refs.name,
          refs.freq,
          // The bar moves several times a second; screen readers get the last chirp's level instead.
          h('div', { class: 'station__level', 'aria-hidden': 'true' }, para('station__level-label', S.level), refs.meter),
          h(
            'dl',
            { class: 'station__stats' },
            h('div', { class: 'station__stat' }, h('dt', {}, S.lastChirp), refs.last),
            h('div', { class: 'station__stat' }, h('dt', {}, S.chirpsSent), refs.sent),
          ),
          para('station__note', S.keepOn),
          privacyLine(),
        ]
        buttons = [button(S.stop, stop, 'danger')]
        break
      }
      case 'lost':
        content = [para('station__text', S.lostBody)]
        buttons = [button(S.pairAgain, pairAgain, 'primary'), button(S.stopShort, stop)]
        break
      case 'error': {
        const msg = h('p', { class: 'station__error', role: 'alert' })
        message = msg
        content = [msg]
        buttons = [button(S.tryAgain, pairAgain, 'primary'), button(S.stopShort, stop)]
        break
      }
    }
    body.replaceChildren(...content)
    actions.replaceChildren(...buttons)
  }

  function patchConnected(refs: ConnectedRefs, v: StationModeView): void {
    setText(refs.name, stationNameText(v.name))
    setText(refs.freq, stationFreqText(v.f0Hz))
    setAttr(refs.freq, 'data-waiting', v.f0Hz === null ? '' : null)
    // 2 % steps: the bar looks smooth and the style is written at most 50 distinct ways.
    const level = (Math.round(clamp01(v.level) * 50) / 50).toFixed(2)
    if (level !== shownLevel) {
      shownLevel = level
      refs.meter.style.setProperty('--level', level)
    }
    // lastChirpAtMs is on the performance.now() clock; turn it into a wall-clock time once per chirp
    // (recomputing every frame would let the shown second jitter).
    if (v.lastChirpAtMs !== chirpAtMs) {
      chirpAtMs = v.lastChirpAtMs
      chirpWallMs = chirpAtMs === null ? null : Date.now() - (performance.now() - chirpAtMs)
    }
    setText(refs.last, stationLastChirpText(v.lastChirpDb, chirpWallMs))
    setText(refs.sent, stationChirpsText(v.chirpsSent))
  }

  function update(state: AppState): void {
    if (disposed) return
    const v = state.stationMode ?? FALLBACK_VIEW
    latest = v
    const key = v.step === 'showAnswer' ? `${v.step}|${v.answerCode ?? ''}` : v.step
    if (key !== builtKey) {
      // The old step's controls disappear: keep keyboard and screen-reader users oriented by
      // moving focus to the new heading, but only when focus was on this screen already.
      const active = document.activeElement
      const hadFocus = builtKey !== '' && active !== null && el.contains(active)
      builtKey = key
      build(v)
      if (hadFocus) title.focus()
    }
    if (connected !== null) patchConnected(connected, v)
    if (message !== null) setText(message, v.message ?? S.errorFallback)
    for (const b of scanOnly) setHidden(b, !v.canScan)
    scanBox.setActive(v.step === 'scanOffer' && isShown(el))
  }

  function dispose(): void {
    disposed = true
    scanBox.dispose()
  }

  return { el, focus: title, update, dispose }
}
