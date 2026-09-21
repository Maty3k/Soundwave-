/**
 * Log panel (a tab on the hunting screen): one row per reading, newest first, each with a note
 * field for where the user stood, so the warm spots can be retraced later.
 *
 * render(state) runs about 60 times per second while hunting. It returns at once while state.log
 * is the same array; otherwise rows are keyed by entry id and patched only when their entry (or the
 * entry before it, which decides whether the frequency is shown) is a different object. New rows
 * are inserted without moving existing ones, so a note field keeps focus while readings arrive,
 * and a field that has focus or an unsent edit is never overwritten from the state.
 */
import type { Config } from '../config.ts'
import {
  formatClockTime,
  LOG_COPY,
  logClipText,
  logCountText,
  logEntryParts,
  logNoteLabel,
  verdictLabel,
} from '../copy.ts'
import type { AppState, LogEntry } from '../types.ts'

export interface LogPanelHandlers {
  /** The note of log entry `id` changed (debounced while typing, immediate on blur and Enter). */
  onLogNote(id: number, note: string): void
  onCopyLog(): void
}

export interface LogPanel {
  readonly el: HTMLElement
  render(state: AppState): void
}

/** A note edit is sent this long after the last keystroke, and at once on blur or Enter. */
const NOTE_DEBOUNCE_MS = 300

type AttrValue = string | number | boolean | null | undefined

/** createElement with attributes (false / null / undefined skipped, true -> empty) and text children. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, AttrValue>> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    el.setAttribute(name, value === true ? '' : String(value))
  }
  el.append(...children)
  return el
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

function setAttr(el: Element, name: string, value: string | null): void {
  if (el.getAttribute(name) === value) return
  if (value === null) el.removeAttribute(name)
  else el.setAttribute(name, value)
}

function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden
}

/** Touch-first device: Enter in a note also closes the on-screen keyboard (a keyboard user keeps focus). */
function coarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

interface Row {
  readonly id: number
  readonly el: HTMLLIElement
  readonly time: HTMLTimeElement
  readonly verdict: HTMLElement
  readonly clip: HTMLElement
  readonly details: HTMLElement
  readonly input: HTMLInputElement
  /** Entry and previous entry the row was last drawn from (log entries are replaced, never mutated). */
  entry: LogEntry | null
  prev: LogEntry | null
  /** Detail parts last drawn, joined (the part spans are rebuilt only when this changes). */
  detailsKey: string
  /** Note last seen in the state: the field is overwritten only when the state's note changes. */
  stateNote: string
  /** Note last passed to onLogNote (or taken over from the state). */
  sentNote: string
  timer: ReturnType<typeof setTimeout> | null
}

export function createLogPanel(handlers: LogPanelHandlers, cfg: Config): LogPanel {
  const maxLength = Math.max(0, Math.floor(cfg.logNoteMaxLength))
  // No region label on the section: the core's role=tabpanel is already named by the Log tab.
  const title = h('h2', { class: 'log__title' }, LOG_COPY.title)
  const count = h('span', { class: 'log__count' })
  // Plain .btn is the secondary look; 48 px tall.
  const copyBtn = h('button', { type: 'button', class: 'btn log__copy', disabled: true }, LOG_COPY.copy)
  copyBtn.addEventListener('click', () => handlers.onCopyLog())
  const empty = h('p', { class: 'log__empty' }, LOG_COPY.empty)
  const list = h('ol', { class: 'log__list', 'aria-label': LOG_COPY.listLabel, hidden: true })
  const el = h(
    'section',
    { class: 'log' },
    h('div', { class: 'log__head' }, title, ' ', count, ' ', copyBtn),
    empty,
    list,
  )

  const rows = new Map<number, Row>()
  let lastLog: readonly LogEntry[] | null = null

  function flush(row: Row): void {
    if (row.timer !== null) {
      clearTimeout(row.timer)
      row.timer = null
    }
    const note = row.input.value.slice(0, maxLength)
    if (note === row.sentNote) return
    row.sentNote = note
    handlers.onLogNote(row.id, note)
  }

  function createRow(id: number, note: string): Row {
    const time = h('time', { class: 'log-row__time' })
    const verdict = h('span', { class: 'log-row__verdict' })
    const clip = h('span', { class: 'log-row__clip', hidden: true })
    const details = h('span', { class: 'log-row__details' })
    const input = h('input', {
      type: 'text',
      class: 'log-row__note',
      maxlength: maxLength,
      placeholder: LOG_COPY.notePlaceholder,
      autocomplete: 'off',
      enterkeyhint: 'done',
    })
    input.value = note
    // The spaces are not laid out (flex items) but keep the parts apart for screen readers and copy-paste.
    const line = h('p', { class: 'log-row__line' }, time, ' ', verdict, ' ', clip, ' ', details)
    const li = h('li', { class: 'log-row' }, line, input)
    const row: Row = {
      id,
      el: li,
      time,
      verdict,
      clip,
      details,
      input,
      entry: null,
      prev: null,
      detailsKey: '',
      stateNote: note,
      sentNote: note,
      timer: null,
    }
    input.addEventListener('input', () => {
      if (row.timer !== null) clearTimeout(row.timer)
      row.timer = setTimeout(() => flush(row), NOTE_DEBOUNCE_MS)
    })
    input.addEventListener('blur', () => flush(row))
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return
      e.preventDefault()
      flush(row)
      if (coarsePointer()) input.blur() // closes the on-screen keyboard
    })
    return row
  }

  function syncNote(row: Row, note: string): void {
    if (note === row.stateNote) return
    row.stateNote = note
    // The field wins while the user edits it: their text is sent on the next flush.
    if (row.timer !== null || document.activeElement === row.input) return
    if (row.input.value !== note) row.input.value = note
    row.sentNote = note
  }

  /** Detail parts as separate spans, so a line breaks between parts ('Loudest: Kitchen' stays whole). */
  function drawDetails(row: Row, parts: readonly string[]): void {
    const key = parts.join(LOG_COPY.sep)
    if (key === row.detailsKey && row.entry !== null) return
    row.detailsKey = key
    const nodes: (Node | string)[] = []
    parts.forEach((part, i) => {
      if (i > 0) nodes.push(LOG_COPY.sep)
      nodes.push(h('span', { class: 'log-row__part' }, part))
    })
    row.details.replaceChildren(...nodes)
    setHidden(row.details, parts.length === 0)
  }

  function patchRow(row: Row, entry: LogEntry, prev: LogEntry | null): void {
    if (row.entry === entry && row.prev === prev) return
    const time = formatClockTime(entry.wallMs)
    setText(row.time, time)
    const date = new Date(entry.wallMs)
    setAttr(row.time, 'datetime', Number.isNaN(date.getTime()) ? null : date.toISOString())
    setAttr(row.input, 'aria-label', logNoteLabel(time))
    setText(row.verdict, verdictLabel(entry.verdict))
    setAttr(row.verdict, 'data-verdict', entry.verdict)
    const clip = logClipText(entry)
    setText(row.clip, clip ?? '')
    setHidden(row.clip, clip === null)
    drawDetails(row, logEntryParts(entry, prev))
    row.entry = entry
    row.prev = prev
    syncNote(row, entry.note)
  }

  function removeRow(row: Row): void {
    if (row.timer !== null) {
      clearTimeout(row.timer)
      row.timer = null
    }
    row.el.remove()
    rows.delete(row.id)
  }

  function render(state: AppState): void {
    const log = state.log
    if (log === lastLog) return
    lastLog = log

    const n = log.length
    setText(count, n === 0 ? '' : logCountText(n))
    if (copyBtn.disabled !== (n === 0)) copyBtn.disabled = n === 0
    setHidden(empty, n > 0)
    setHidden(list, n === 0)

    const ids = new Set<number>()
    for (const entry of log) ids.add(entry.id)
    for (const row of [...rows.values()]) if (!ids.has(row.id)) removeRow(row)

    // Newest first. Rows already in place are skipped over, so prepending a new reading (the usual
    // change) inserts one row and never detaches the others (detaching a focused field blurs it).
    // Ids are unique by contract; a repeated id is drawn once (its newest entry) instead of thrashing.
    const drawn = new Set<number>()
    let cursor: ChildNode | null = list.firstChild
    for (let i = n - 1; i >= 0; i--) {
      const entry = log[i]!
      if (drawn.has(entry.id)) continue
      drawn.add(entry.id)
      let row = rows.get(entry.id)
      if (row === undefined) {
        row = createRow(entry.id, entry.note)
        rows.set(entry.id, row)
      }
      patchRow(row, entry, log[i - 1] ?? null)
      if (row.el === cursor) cursor = cursor.nextSibling
      else list.insertBefore(row.el, cursor)
    }
  }

  return { el, render }
}
