/**
 * Past hunts on the start screen: a collapsible list of the beeps found on this device (newest
 * first) with their name, when, frequency, how long it took, the loudest station and the notes.
 * Each one can be removed. Hidden while there are none.
 */
import {
  formatHuntDate,
  foundListenersParts,
  HISTORY_COPY,
  historyDetailParts,
  historyRemoveLabel,
  historyTitle,
  LOG_COPY,
} from '../copy.ts'
import type { AppState, HuntRecord } from '../types.ts'
import { h, setHidden, setText } from './stationsPanel.ts'

export interface HistoryHandlers {
  onHistoryRemove(id: number): void
}

export interface HistoryPanel {
  readonly el: HTMLElement
  update(state: AppState): void
}

/**
 * `fallbackFocus` takes the focus when the last past hunt is removed (the list disappears); after
 * any other removal the next Remove button (or the new last one) gets it.
 */
export function createHistoryPanel(handlers: HistoryHandlers, fallbackFocus: HTMLElement): HistoryPanel {
  const C = HISTORY_COPY
  const count = h('span', { class: 'past-hunts__count' })
  const summary = h('summary', { class: 'past-hunts__summary' }, h('h2', { class: 'past-hunts__title' }, C.title), count)
  const list = h('ol', { class: 'past-hunts__list' })
  const details = h('details', { class: 'past-hunts__details' }, summary, h('p', { class: 'past-hunts__intro' }, C.intro), list)
  const el = h('section', { class: 'past-hunts', hidden: true }, details)

  let shown: readonly HuntRecord[] | null = null
  /** Index of a Remove button that was just used: focus moves to the one now in its place. */
  let focusIndex: number | null = null

  /** Parts as whole items that wrap only between them; the separator dot stays with the part before it. */
  function partsLine(cls: string, parts: readonly (string | HTMLElement)[]): HTMLElement {
    const dot = LOG_COPY.sep.trim()
    const nodes: (Node | string)[] = []
    parts.forEach((part, i) => {
      if (i > 0) nodes.push(' ')
      const last = i === parts.length - 1
      nodes.push(h('span', { class: 'past-hunt__part' }, part, last ? '' : `\u00a0${dot}`))
    })
    const p = h('p', { class: cls })
    p.replaceChildren(...nodes)
    return p
  }

  function item(record: HuntRecord, index: number, nowMs: number): HTMLElement {
    const s = record.summary
    const remove = h('button', { type: 'button', class: 'past-hunt__remove', 'aria-label': historyRemoveLabel(record) }, C.remove)
    remove.addEventListener('click', () => {
      focusIndex = index
      handlers.onHistoryRemove(record.id)
    })
    const head = h('div', { class: 'past-hunt__head' }, h('h3', { class: 'past-hunt__title' }, historyTitle(record)), remove)

    const when = formatHuntDate(s.foundAtWallMs, nowMs)
    const date = new Date(s.foundAtWallMs)
    const time = h('time', { datetime: Number.isNaN(date.getTime()) ? null : date.toISOString() }, when)
    const meta = [...(when === '' ? [] : [time]), ...historyDetailParts(record)]
    const children: HTMLElement[] = [head]
    if (meta.length > 0) children.push(partsLine('past-hunt__meta', meta))
    const listeners = foundListenersParts(s)
    if (listeners.length > 0) children.push(partsLine('past-hunt__listeners', listeners))
    if (s.notes.length > 0) {
      children.push(
        h(
          'ul',
          { class: 'past-hunt__notes', 'aria-label': C.notesLabel },
          ...s.notes.map((n) => h('li', { class: 'past-hunt__note' }, n.note)),
        ),
      )
    }
    return h('li', { class: 'past-hunt' }, ...children)
  }

  function draw(history: readonly HuntRecord[]): void {
    const nowMs = Date.now()
    list.replaceChildren(...history.map((r, i) => item(r, i, nowMs)))
    setText(count, String(history.length))
    setHidden(el, history.length === 0)
    const i = focusIndex
    focusIndex = null
    if (i === null) return
    const buttons = list.querySelectorAll<HTMLButtonElement>('.past-hunt__remove')
    const next = buttons[Math.min(i, buttons.length - 1)]
    ;(next ?? fallbackFocus).focus()
  }

  return {
    el,
    update(state) {
      if (state.history === shown) return
      shown = state.history
      draw(state.history)
    },
  }
}
