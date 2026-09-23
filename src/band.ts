/**
 * The Listening range: the pitch band (Hz) the detector searches while listening, chosen by the
 * person with two sliders (Settings.bandHz). Pure helpers shared by the settings store, the reducer
 * and the slider control. No DOM.
 */
import type { Config } from './config.ts'

/** Lowest and highest pitch in Hz. */
export type Band = readonly [number, number]

/** Nearest multiple of `step`; unchanged when step is not a positive finite number. */
function roundToStep(hz: number, step: number): number {
  return Number.isFinite(step) && step > 0 ? Math.round(hz / step) * step : hz
}

function clampHz(hz: number, cfg: Config): number {
  const [min, max] = cfg.bandLimitsHz
  return Math.min(max, Math.max(min, hz))
}

/**
 * One end of the band rounded to cfg.bandStepHz, the way the sliders round it; not clamped, and a
 * value that is not a finite number comes back as it is.
 */
export function roundHz(hz: number, cfg: Config): number {
  return roundToStep(hz, cfg.bandStepHz)
}

/** One end of the band, rounded to cfg.bandStepHz and clamped into cfg.bandLimitsHz. */
function snapHz(hz: number, cfg: Config): number {
  return clampHz(roundHz(hz, cfg), cfg)
}

/** Both ends equal. */
export function sameBand(a: Band, b: Band): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

/**
 * A band the app can use: both ends rounded to cfg.bandStepHz and clamped into cfg.bandLimitsHz.
 * Null when either value is not a finite number, or when the span (hi - lo) after rounding is
 * below cfg.bandMinSpanHz (a reversed pair included).
 */
export function normalizeBand(lo: number, hi: number, cfg: Config): [number, number] | null {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  const a = snapHz(lo, cfg)
  const b = snapHz(hi, cfg)
  if (b - a < cfg.bandMinSpanHz) return null
  return [a, b]
}

/**
 * The band after one slider moved. `moving` names the slider that was dragged: it keeps its
 * (rounded, clamped) value and the other end is pushed along when it would otherwise come closer
 * than cfg.bandMinSpanHz, so a drag past the other thumb carries it. Only when the limits leave no
 * room for the span does the moving end give way. A value that is not a finite number is taken as
 * that end of cfg.searchBandHz (the default band), so a broken input can never wreck the band.
 */
export function clampBand(lo: number, hi: number, cfg: Config, moving: 'lo' | 'hi'): [number, number] {
  const span = Math.max(0, cfg.bandMinSpanHz)
  const [min, max] = cfg.bandLimitsHz
  let a = snapHz(Number.isFinite(lo) ? lo : cfg.searchBandHz[0], cfg)
  let b = snapHz(Number.isFinite(hi) ? hi : cfg.searchBandHz[1], cfg)
  if (b - a >= span) return [a, b]
  if (moving === 'lo') {
    b = Math.min(max, a + span)
    a = Math.min(a, b - span)
  } else {
    a = Math.max(min, b - span)
    b = Math.max(b, a + span)
  }
  return [clampHz(a, cfg), clampHz(b, cfg)]
}
