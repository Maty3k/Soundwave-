/**
 * Direction-scan panel: a 360-degree radar drawn from the phone's point of view ("up" is where
 * the phone points right now), the loudest-direction arrow, where to face next, and plain-language
 * status. Static SVG elements are created once; render() runs every frame while the Direction tab
 * is open, so it writes to the DOM only what changed.
 *
 * Layout (compact, so the answer is visible without scrolling while the phone is held flat):
 * status line and a quiet Clear scan button first, then the how-to (only until the first sample),
 * the radar and the detail line. There is no Done button: choosing another tab leaves the scan.
 *
 * Steadiness: near an octant boundary the eight-way answer ('ahead to the left' / 'straight
 * ahead') would flip several times per second as the hand wobbles, so the named octant only
 * changes once the bearing is more than OCTANT_HOLD_DEG from its centre. Screen readers hear the
 * status through a separate polite region that is written only when the status text, the quality
 * or the number of measured directions changes.
 */
import type { LockMode, RadarView, ScanState } from './types.ts'
import { angleDiff, direction8, relativeBearing, type Direction8 } from './dsp/radar.ts'
import { measuredSectors, RADAR_COPY, radarDirectionText, radarStatusText } from './copy.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'
const R = 100
/**
 * Sector colours, quietest to loudest: the meter's heat ramp without its darkest blue, so the
 * quietest measured sector (about 3.9:1 at fill-opacity 0.75) stays distinct from the unmeasured
 * (outlined) ones. Lightness-monotonic and colour-blind safe.
 */
const RAMP = ['#3F9BE8', '#7FC4D8', '#F2C14E', '#FF8A1F'] as const

/** The named octant changes only when the bearing is more than this far from its centre (45 / 2 + 10). */
export const OCTANT_HOLD_DEG = 32.5

const OCTANT_CENTER_DEG: Record<Direction8, number> = {
  ahead: 0,
  aheadRight: 45,
  right: 90,
  behindRight: 135,
  behind: 180,
  behindLeft: -135,
  left: -90,
  aheadLeft: -45,
}

/**
 * Eight-way direction for a relative bearing (degrees, + = right) with hysteresis: keep `prev`
 * while the bearing stays within OCTANT_HOLD_DEG of its centre, otherwise take the nearest octant.
 */
export function steadyOctant(prev: Direction8 | null, relDeg: number): Direction8 {
  if (prev !== null && Math.abs(angleDiff(relDeg, OCTANT_CENTER_DEG[prev])) <= OCTANT_HOLD_DEG) return prev
  return direction8(relDeg)
}

export interface RadarPanelHandlers {
  /** Forget the measured directions and start the scan over. */
  onClear(): void
}

export interface RadarPanel {
  readonly el: HTMLElement
  render(scan: ScanState, huntMode: LockMode): void
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

/** Screen point for a clockwise angle from "up" (degrees) at radius r. */
function point(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180
  return [r * Math.sin(a), -r * Math.cos(a)]
}

function wedgePath(centerDeg: number, widthDeg: number, r: number): string {
  const [x1, y1] = point(centerDeg - widthDeg / 2, r)
  const [x2, y2] = point(centerDeg + widthDeg / 2, r)
  const f = (n: number): string => n.toFixed(2)
  return `M0 0 L${f(x1)} ${f(y1)} A${r} ${r} 0 0 1 ${f(x2)} ${f(y2)} Z`
}

function rampColour(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1)
  const i = Math.min(RAMP.length - 2, Math.floor(x))
  const f = x - i
  const a = RAMP[i]!
  const b = RAMP[i + 1]!
  const mix = (k: number): number => Math.round(parseInt(a.slice(k, k + 2), 16) * (1 - f) + parseInt(b.slice(k, k + 2), 16) * f)
  return `rgb(${mix(1)} ${mix(3)} ${mix(5)})`
}

function setAttr(el: Element, name: string, value: string | null): void {
  if (el.getAttribute(name) === value) return
  if (value === null) el.removeAttribute(name)
  else el.setAttribute(name, value)
}

function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

function setShown(el: SVGElement, shown: boolean): void {
  const value = shown ? '' : 'none'
  if (el.style.display !== value) el.style.display = value
}

export function createRadarPanel(handlers: RadarPanelHandlers): RadarPanel {
  const el = document.createElement('section')
  el.className = 'scan'
  el.setAttribute('aria-labelledby', 'scan-title')

  // Header: the (visually hidden) title, the answer, and a quiet Clear scan.
  const title = document.createElement('h2')
  title.id = 'scan-title'
  title.className = 'scan__title sr-only'
  title.textContent = RADAR_COPY.title
  const status = document.createElement('p')
  status.className = 'scan__status'
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'btn btn-quiet scan__clear'
  clear.textContent = RADAR_COPY.clear
  clear.addEventListener('click', () => {
    if (clear.getAttribute('aria-disabled') !== 'true') handlers.onClear()
  })
  const head = document.createElement('div')
  head.className = 'scan__head'
  head.append(title, status, clear)

  const how = document.createElement('p')
  how.className = 'scan__how'

  const figure = svg('svg', { viewBox: '-120 -128 240 248', class: 'scan__radar', role: 'img' })
  const rings = svg('g', { class: 'scan__rings' })
  for (const f of [1 / 3, 2 / 3, 1]) rings.append(svg('circle', { cx: 0, cy: 0, r: (R * f).toFixed(1) }))
  // Everything tied to compass headings lives in one group rotated by -heading, so turning the
  // phone rewrites one transform instead of every wedge.
  const world = svg('g', { class: 'scan__world' })
  const sectorLayer = svg('g', { class: 'scan__sectors' })
  const suggest = svg('g', { class: 'scan__suggest' })
  suggest.append(svg('line', { x1: 0, y1: 0, x2: 0, y2: -R }))
  const arrow = svg('g', { class: 'scan__arrow' })
  // White arrow with a dark halo: readable on every sector colour, including the orange loudest one.
  arrow.append(
    svg('line', { x1: 0, y1: 0, x2: 0, y2: -(R * 0.82), class: 'scan__arrow-halo' }),
    svg('line', { x1: 0, y1: 0, x2: 0, y2: -(R * 0.82), class: 'scan__arrow-shaft' }),
    svg('path', { d: `M0 ${-R} L-10 ${-R + 20} L10 ${-R + 20} Z`, class: 'scan__arrow-head' }),
  )
  world.append(sectorLayer, suggest, arrow)
  const forward = svg('g', { class: 'scan__forward' })
  forward.append(svg('path', { d: `M0 ${-R - 16} L-6 ${-R - 6} L6 ${-R - 6} Z` }))
  const you = svg('circle', { cx: 0, cy: 0, r: 5, class: 'scan__you' })
  figure.append(rings, world, forward, you)

  const detail = document.createElement('p')
  detail.className = 'scan__detail'

  // Polite announcer, written only on meaningful changes (the visible status is not a live region).
  const announcer = document.createElement('p')
  announcer.className = 'sr-only'
  announcer.setAttribute('aria-live', 'polite')
  announcer.setAttribute('aria-atomic', 'true')

  el.append(head, how, figure, detail, announcer)

  let sectorEls: SVGPathElement[] = []
  let sectorKey = ''
  let octant: Direction8 | null = null
  let announceKey = ''

  /** (Re)build the wedges when the sector layout changes (chirp and live modes differ). */
  function ensureSectors(radar: RadarView | null): void {
    const key = radar === null ? '' : radar.sectors.map((s) => s.centerDeg.toFixed(1)).join(',')
    if (key === sectorKey) return
    sectorKey = key
    sectorLayer.replaceChildren()
    sectorEls = []
    if (radar === null) return
    const width = 360 / radar.sectors.length
    for (const s of radar.sectors) {
      // Drawn 1 degree narrower than the sector so neighbours stay visually separate.
      const p = svg('path', { d: wedgePath(s.centerDeg, width - 1, R) })
      sectorLayer.append(p)
      sectorEls.push(p)
    }
  }

  function render(scan: ScanState, huntMode: LockMode): void {
    const radar: RadarView | null = scan.radar
    setText(how, huntMode === 'chirp' ? RADAR_COPY.howChirp : RADAR_COPY.howLive)
    const samples = radar?.samples ?? 0
    if (how.hidden !== samples > 0) how.hidden = samples > 0

    ensureSectors(radar)
    const heading = radar?.headingDeg ?? 0
    setAttr(world, 'transform', `rotate(${(-heading).toFixed(1)})`)

    if (radar !== null) {
      let min = Infinity
      let max = -Infinity
      for (const s of radar.sectors) {
        if (s.levelDb === null) continue
        min = Math.min(min, s.levelDb)
        max = Math.max(max, s.levelDb)
      }
      radar.sectors.forEach((s, i) => {
        const p = sectorEls[i]
        if (p === undefined) return
        if (s.levelDb === null) {
          setAttr(p, 'class', 'scan__sector scan__sector--empty')
          setAttr(p, 'fill', null)
          setAttr(p, 'fill-opacity', null)
        } else {
          const t = max > min ? (s.levelDb - min) / (max - min) : 0.5
          setAttr(p, 'class', 'scan__sector')
          setAttr(p, 'fill', rampColour(t))
          setAttr(p, 'fill-opacity', (0.75 + 0.25 * t).toFixed(2))
        }
      })
      setShown(arrow, radar.bearingDeg !== null)
      if (radar.bearingDeg !== null) setAttr(arrow, 'transform', `rotate(${radar.bearingDeg.toFixed(1)})`)
      const showSuggest = radar.suggestDeg !== null && radar.quality !== 'clear'
      setShown(suggest, showSuggest)
      if (showSuggest && radar.suggestDeg !== null) setAttr(suggest, 'transform', `rotate(${radar.suggestDeg.toFixed(1)})`)
    } else {
      setShown(arrow, false)
      setShown(suggest, false)
    }

    // The steadied eight-way answer, shared by the status line and the figure's label.
    const rel = radar !== null && radar.bearingDeg !== null && radar.headingDeg !== null ? relativeBearing(radar.bearingDeg, radar.headingDeg) : null
    octant = rel === null ? null : steadyOctant(octant, rel)

    // Compass not answered yet (the tab was just opened): say so instead of an empty line.
    const statusText = scan.status === 'off' ? RADAR_COPY.starting : radarStatusText(scan, huntMode, octant)
    setText(status, statusText)
    setText(detail, radar ? radarDirectionText(radar) : '')
    setAttr(figure, 'aria-label', octant === null ? RADAR_COPY.ariaNoDirection : `${RADAR_COPY.ariaLoudest} ${RADAR_COPY.directions[octant]}`)
    setAttr(el, 'data-quality', radar?.quality ?? 'none')
    setAttr(clear, 'aria-disabled', samples > 0 ? null : 'true')

    const key = `${statusText}|${radar?.quality ?? 'none'}|${radar === null ? 0 : measuredSectors(radar)}`
    if (key !== announceKey) {
      announceKey = key
      announcer.textContent = statusText
    }
  }

  return { el, render }
}
