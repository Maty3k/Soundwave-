/**
 * Direction-scan panel: a 360-degree radar drawn from the phone's point of view ("up" is where
 * the phone points right now), the loudest-direction arrow, where to face next, and plain-language
 * status. Static SVG elements are created once and patched on every render.
 */
import type { LockMode, RadarView, ScanState } from './types.ts'
import { angleDiff, direction8, relativeBearing } from './dsp/radar.ts'
import { RADAR_COPY, radarStatusText, radarDirectionText } from './copy.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'
const R = 100
/** Heat ramp shared with the meter (lightness-monotonic, colour-blind safe). */
const RAMP = ['#2F5BE0', '#3F9BE8', '#7FC4D8', '#F2C14E', '#FF8A1F'] as const

export interface RadarPanelHandlers {
  onClear(): void
  onDone(): void
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

function button(label: string, onClick: () => void, cls: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

export function createRadarPanel(handlers: RadarPanelHandlers): RadarPanel {
  const el = document.createElement('section')
  el.className = 'scan'
  el.setAttribute('aria-labelledby', 'scan-title')

  const title = document.createElement('h2')
  title.id = 'scan-title'
  title.className = 'scan__title'
  title.textContent = RADAR_COPY.title

  const how = document.createElement('p')
  how.className = 'scan__how'

  const figure = svg('svg', { viewBox: '-120 -128 240 248', class: 'scan__radar', role: 'img' })
  const rings = svg('g', { class: 'scan__rings' })
  for (const f of [1 / 3, 2 / 3, 1]) rings.append(svg('circle', { cx: 0, cy: 0, r: (R * f).toFixed(1) }))
  const sectorLayer = svg('g', { class: 'scan__sectors' })
  const suggest = svg('g', { class: 'scan__suggest' })
  const suggestLine = svg('line', { x1: 0, y1: 0, x2: 0, y2: -R })
  suggest.append(suggestLine)
  const arrow = svg('g', { class: 'scan__arrow' })
  // White arrow with a dark halo: readable on every sector colour, including the orange loudest one.
  arrow.append(
    svg('line', { x1: 0, y1: 0, x2: 0, y2: -(R * 0.82), class: 'scan__arrow-halo' }),
    svg('line', { x1: 0, y1: 0, x2: 0, y2: -(R * 0.82), class: 'scan__arrow-shaft' }),
    svg('path', { d: `M0 ${-R} L-10 ${-R + 20} L10 ${-R + 20} Z`, class: 'scan__arrow-head' }),
  )
  const forward = svg('g', { class: 'scan__forward' })
  forward.append(svg('path', { d: `M0 ${-R - 16} L-6 ${-R - 6} L6 ${-R - 6} Z` }))
  const you = svg('circle', { cx: 0, cy: 0, r: 5, class: 'scan__you' })
  figure.append(rings, sectorLayer, suggest, arrow, forward, you)

  const status = document.createElement('p')
  status.className = 'scan__status'
  status.setAttribute('aria-live', 'polite')
  const detail = document.createElement('p')
  detail.className = 'scan__detail'

  const actions = document.createElement('div')
  actions.className = 'scan__actions'
  actions.append(button(RADAR_COPY.clear, handlers.onClear, 'btn btn-secondary'), button(RADAR_COPY.done, handlers.onDone, 'btn btn-primary'))

  el.append(title, how, figure, status, detail, actions)

  let sectorEls: SVGPathElement[] = []
  let sectorCount = 0
  let lastStatus = ''

  function ensureSectors(n: number): void {
    if (n === sectorCount) return
    sectorLayer.replaceChildren()
    sectorEls = []
    for (let i = 0; i < n; i++) {
      const p = svg('path', { d: '' })
      sectorLayer.append(p)
      sectorEls.push(p)
    }
    sectorCount = n
  }

  function render(scan: ScanState, huntMode: LockMode): void {
    const radar: RadarView | null = scan.radar
    how.textContent = huntMode === 'chirp' ? RADAR_COPY.howChirp : RADAR_COPY.howLive
    const heading = radar?.headingDeg ?? 0

    if (radar) {
      const n = radar.sectors.length
      ensureSectors(n)
      const width = 360 / n
      let min = Infinity
      let max = -Infinity
      for (const s of radar.sectors) {
        if (s.levelDb === null) continue
        min = Math.min(min, s.levelDb)
        max = Math.max(max, s.levelDb)
      }
      radar.sectors.forEach((s, i) => {
        const p = sectorEls[i]!
        // Draw 1 degree narrower than the sector so neighbours stay visually separate.
        p.setAttribute('d', wedgePath(angleDiff(s.centerDeg, heading), width - 1, R))
        if (s.levelDb === null) {
          p.setAttribute('class', 'scan__sector scan__sector--empty')
          p.removeAttribute('fill')
          p.removeAttribute('fill-opacity')
        } else {
          const t = max > min ? (s.levelDb - min) / (max - min) : 0.5
          p.setAttribute('class', 'scan__sector')
          p.setAttribute('fill', rampColour(t))
          p.setAttribute('fill-opacity', (0.35 + 0.65 * t).toFixed(2))
        }
      })
      if (radar.bearingDeg !== null) {
        arrow.setAttribute('transform', `rotate(${angleDiff(radar.bearingDeg, heading).toFixed(1)})`)
        arrow.style.display = ''
      } else arrow.style.display = 'none'
      if (radar.suggestDeg !== null && radar.quality !== 'clear') {
        suggest.setAttribute('transform', `rotate(${angleDiff(radar.suggestDeg, heading).toFixed(1)})`)
        suggest.style.display = ''
      } else suggest.style.display = 'none'
    } else {
      ensureSectors(0)
      arrow.style.display = 'none'
      suggest.style.display = 'none'
    }

    const statusText = radarStatusText(scan, huntMode)
    if (statusText !== lastStatus) {
      status.textContent = statusText
      lastStatus = statusText
    }
    detail.textContent = radar ? radarDirectionText(radar) : ''
    const rel = radar?.bearingDeg != null && radar.headingDeg !== null ? relativeBearing(radar.bearingDeg, radar.headingDeg) : null
    figure.setAttribute(
      'aria-label',
      rel === null ? RADAR_COPY.ariaNoDirection : `${RADAR_COPY.ariaLoudest} ${RADAR_COPY.directions[direction8(rel)]}`,
    )
    el.dataset['quality'] = radar?.quality ?? 'none'
  }

  return { el, render }
}
