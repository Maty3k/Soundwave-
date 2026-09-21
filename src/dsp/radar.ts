/**
 * Direction scan ("radar") by body shadowing.
 *
 * A single microphone cannot hear direction. But held in front of the chest, the phone hears
 * sound arriving from behind the user several dB quieter than sound from in front, because the
 * body is a large obstacle at beep frequencies (wavelength about 11 cm at 3 kHz). Turning on the
 * spot and recording the beep's level per compass heading therefore reveals the loudest direction:
 * toward the source when it is near, or toward the doorway its sound comes through when it is in
 * another room.
 *
 * Headings are in degrees clockwise in the compass sensor's frame. Only differences matter, so a
 * relative (non-north-referenced) sensor works as long as it does not drift during the scan.
 */
import type { Config } from '../config.ts'
import type { LockMode, RadarQuality, RadarSector, RadarView } from '../types.ts'

export interface RadarState {
  readonly mode: LockMode
  /** Number of sectors; sector i is centred on i * 360 / n degrees. */
  readonly n: number
  /** Sum of linear power of the samples per sector. */
  readonly power: Float64Array
  readonly count: Uint32Array
  samples: number
  /** The last sample, so a merged chirp group can raise it instead of adding a new one. */
  last: { sector: number; power: number } | null
}

/** Normalise any angle to [0, 360). */
export function normDeg(deg: number): number {
  const d = deg % 360
  return d < 0 ? d + 360 : d
}

/** Signed smallest difference a - b in (-180, 180]. Positive means a is clockwise of b. */
export function angleDiff(a: number, b: number): number {
  const d = normDeg(a - b)
  return d > 180 ? d - 360 : d
}

/** Sector index for a heading; sector 0 is centred on 0 degrees. */
export function sectorIndex(headingDeg: number, n: number): number {
  const width = 360 / n
  return Math.floor(normDeg(headingDeg + width / 2) / width) % n
}

export function createRadar(mode: LockMode, cfg: Config): RadarState {
  const n = mode === 'chirp' ? cfg.radarChirpSectors : cfg.radarLiveSectors
  return { mode, n, power: new Float64Array(n), count: new Uint32Array(n), samples: 0, last: null }
}

/** Record the beep's level (dB) heard while the device pointed at headingDeg. Non-finite input is ignored. */
export function addRadarSample(state: RadarState, headingDeg: number, levelDb: number): void {
  if (!Number.isFinite(headingDeg) || !Number.isFinite(levelDb)) return
  const sector = sectorIndex(headingDeg, state.n)
  const p = 10 ** (levelDb / 10)
  state.power[sector] = state.power[sector]! + p
  state.count[sector] = state.count[sector]! + 1
  state.samples++
  state.last = { sector, power: p }
}

/**
 * Raise the last sample to levelDb if that is louder (a chirp group grew by a louder chirp).
 * Quieter updates are ignored: the reading keeps its peak.
 */
export function raiseLastSample(state: RadarState, levelDb: number): void {
  const last = state.last
  if (!last || !Number.isFinite(levelDb)) return
  const p = 10 ** (levelDb / 10)
  if (p <= last.power) return
  state.power[last.sector] = state.power[last.sector]! + (p - last.power)
  last.power = p
}

export function clearRadar(state: RadarState): void {
  state.power.fill(0)
  state.count.fill(0)
  state.samples = 0
  state.last = null
}

/** Signed heading of the loudest direction relative to where the device points (-180..180, + = right). */
export function relativeBearing(bearingDeg: number, headingDeg: number): number {
  return angleDiff(bearingDeg, headingDeg)
}

export type Direction8 = 'ahead' | 'aheadRight' | 'right' | 'behindRight' | 'behind' | 'behindLeft' | 'left' | 'aheadLeft'

const DIRECTIONS: readonly Direction8[] = ['ahead', 'aheadRight', 'right', 'behindRight', 'behind', 'behindLeft', 'left', 'aheadLeft']

/** Eight-way description of a relative bearing (0 = ahead, 90 = right). */
export function direction8(relDeg: number): Direction8 {
  return DIRECTIONS[sectorIndex(relDeg, 8)]!
}

/** Snapshot for the UI. headingDeg is the device's current heading (null without a compass). */
export function radarView(state: RadarState, headingDeg: number | null, cfg: Config): RadarView {
  const n = state.n
  const width = 360 / n
  const sectors: RadarSector[] = []
  const covered: number[] = []
  for (let i = 0; i < n; i++) {
    const c = state.count[i]!
    const levelDb = c > 0 ? 10 * Math.log10(state.power[i]! / c) : null
    sectors.push({ centerDeg: i * width, levelDb, samples: c })
    if (c > 0) covered.push(i)
  }

  let maxGapDeg: number | null = null
  let suggestDeg: number | null = null
  if (covered.length > 0) {
    let bestGap = -1
    let bestFrom = 0
    for (let k = 0; k < covered.length; k++) {
      const from = covered[k]!
      const to = covered[(k + 1) % covered.length]!
      let gapSectors = to - from
      if (gapSectors <= 0) gapSectors += n
      const gap = gapSectors * width
      if (gap > bestGap) {
        bestGap = gap
        bestFrom = from
      }
    }
    maxGapDeg = bestGap
    // A gap of one sector width means neighbouring sectors are both measured: nothing is missing.
    suggestDeg = bestGap > width ? normDeg(bestFrom * width + bestGap / 2) : null
  }

  let contrastDb: number | null = null
  let loudest = -1
  if (covered.length >= 2) {
    let max = -Infinity
    let min = Infinity
    for (const i of covered) {
      const l = sectors[i]!.levelDb!
      if (l > max) {
        max = l
        loudest = i
      }
      if (l < min) min = l
    }
    contrastDb = max - min
  }

  let quality: RadarQuality
  if (covered.length < cfg.radarMinSectors || maxGapDeg === null || maxGapDeg > cfg.radarRoughMaxGapDeg) quality = 'needMore'
  else if (contrastDb === null || contrastDb < cfg.radarMinContrastDb) quality = 'unclear'
  else if (contrastDb >= cfg.radarClearContrastDb && maxGapDeg <= cfg.radarClearMaxGapDeg) quality = 'clear'
  else quality = 'rough'

  let bearingDeg: number | null = null
  if ((quality === 'rough' || quality === 'clear') && loudest >= 0) {
    // Refine with the measured sectors within +-90 degrees of the loudest one: circular mean
    // weighted by the power above the quietest measured sector. (+-90 degrees reaches the
    // neighbouring quarter turns of a chirp scan as well as the fine sectors of a live sweep.)
    let minP = Infinity
    for (const i of covered) minP = Math.min(minP, state.power[i]! / state.count[i]!)
    const half = Math.max(1, Math.round(90 / width))
    let sx = 0
    let sy = 0
    for (let i = loudest - half; i <= loudest + half; i++) {
      const j = ((i % n) + n) % n
      if (state.count[j] === 0) continue
      const w = Math.max(0, state.power[j]! / state.count[j]! - minP)
      const a = (j * width * Math.PI) / 180
      sx += w * Math.sin(a)
      sy += w * Math.cos(a)
    }
    bearingDeg = sx === 0 && sy === 0 ? loudest * width : normDeg((Math.atan2(sx, sy) * 180) / Math.PI)
  }

  return {
    mode: state.mode,
    sectors,
    bearingDeg,
    contrastDb,
    quality,
    samples: state.samples,
    maxGapDeg,
    suggestDeg,
    headingDeg: headingDeg === null ? null : normDeg(headingDeg),
  }
}
