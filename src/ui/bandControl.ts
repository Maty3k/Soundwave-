/**
 * Listening range: a collapsed <details> on the start and listening screens with two sliders for
 * the lowest and highest pitch the detector searches while listening (Settings.bandHz). The
 * summary shows the title and the current band as a pill; inside are a hint, the two sliders with
 * live readouts and a link that puts the default band back.
 *
 * Dragging one thumb past the other pushes the other along (clampBand), so the band never gets
 * narrower than cfg.bandMinSpanHz. Every move updates the readouts and the pill at once and sends
 * handlers.onBand after a short pause (a drag fires 'input' many times a second); letting go
 * ('change') sends it right away, and so does dispose() when the screen goes away, so the last
 * move is never lost. update(state) syncs the sliders from the settings, except while a send is
 * still waiting, so the store never fights a drag in progress.
 */
import type { Config } from '../config.ts'
import { clampBand, sameBand, type Band } from '../band.ts'
import { BAND_COPY, bandText, formatHz } from '../copy.ts'
import type { AppState } from '../types.ts'
import { h, setAttr, setHidden, setText, uid } from './stationsPanel.ts'

export interface BandHandlers {
  /** The person set the Listening range: lowest and highest pitch in Hz (already a valid band). */
  onBand(lo: number, hi: number): void
}

export interface BandControl {
  readonly el: HTMLElement
  update(state: AppState): void
  /** The screen is being replaced: a band still waiting for its timer is sent at once. */
  dispose(): void
}

/** How long after the last slider move the new band is sent. */
const SEND_DELAY_MS = 150

interface Slider {
  readonly row: HTMLElement
  readonly input: HTMLInputElement
  readonly value: HTMLOutputElement
}

export function createBandControl(handlers: BandHandlers, cfg: Config): BandControl {
  const C = BAND_COPY
  const [minHz, maxHz] = cfg.bandLimitsHz

  function slider(label: string): Slider {
    const id = uid('band')
    const input = h('input', { type: 'range', class: 'band__slider', id, min: minHz, max: maxHz, step: cfg.bandStepHz })
    const value = h('output', { class: 'band__value num', for: id })
    const row = h('div', { class: 'band__row' }, h('label', { class: 'band__label', for: id }, label), value, input)
    return { row, input, value }
  }

  const spoken = h('span', { class: 'sr-only' })
  const pill = h('span', { class: 'band__pill num', 'aria-hidden': 'true' })
  const summary = h('summary', { class: 'band__summary' }, h('h2', { class: 'band__title' }, C.title), spoken, pill)
  const low = slider(C.low)
  const high = slider(C.high)
  const reset = h('button', { type: 'button', class: 'band__reset', hidden: true }, C.reset(cfg.searchBandHz[0], cfg.searchBandHz[1]))
  const body = h('div', { class: 'band__body' }, h('p', { class: 'band__hint' }, C.hint), low.row, high.row, reset)
  const details = h('details', { class: 'band__details' }, summary, body)
  const el = h('section', { class: 'band' }, details)

  /** The band the control shows. */
  let shown: Band = cfg.searchBandHz
  /** A band the person set that has not been sent yet (its timer is running). */
  let pending: Band | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function show(band: Band): void {
    shown = band
    const [lo, hi] = band
    if (low.input.valueAsNumber !== lo) low.input.value = String(lo)
    if (high.input.valueAsNumber !== hi) high.input.value = String(hi)
    setAttr(low.input, 'aria-valuetext', formatHz(lo))
    setAttr(high.input, 'aria-valuetext', formatHz(hi))
    setText(low.value, formatHz(lo))
    setText(high.value, formatHz(hi))
    setText(pill, bandText(lo, hi))
    setText(spoken, C.summary(lo, hi))
    setHidden(reset, sameBand(band, cfg.searchBandHz))
  }

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function send(): void {
    cancelTimer()
    const band = pending
    pending = null
    if (band !== null) handlers.onBand(band[0], band[1])
  }

  /** The person moved a slider: show the band at once, send it after SEND_DELAY_MS. */
  function moved(moving: 'lo' | 'hi'): void {
    const band = clampBand(low.input.valueAsNumber, high.input.valueAsNumber, cfg, moving)
    show(band)
    pending = band
    cancelTimer()
    timer = setTimeout(send, SEND_DELAY_MS)
  }

  low.input.addEventListener('input', () => moved('lo'))
  high.input.addEventListener('input', () => moved('hi'))
  low.input.addEventListener('change', send)
  high.input.addEventListener('change', send)
  reset.addEventListener('click', () => {
    show(cfg.searchBandHz)
    pending = cfg.searchBandHz
    send()
    summary.focus()
  })

  show(shown)

  return {
    el,
    update(state) {
      const band = state.settings.bandHz
      if (pending !== null || sameBand(band, shown)) return
      show(band)
    },
    dispose: send,
  }
}
