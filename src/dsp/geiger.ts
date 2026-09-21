/**
 * Pure maths behind the Geiger clicks and the haptic tiers: warmth -> click rate, the
 * shifted-exponential click scheduler, the harmonic-safe click carrier, vibration tiers and the
 * Hann gain curve of one click. No Web Audio here; audio/clicker.ts and platform.ts apply it.
 */
import type { Config } from '../config.ts'

/** Odd point count for hannClickCurve, so the curve has an exact centre sample at the peak. */
export const CLICK_CURVE_POINTS = 129

/**
 * Highest click rate in Hz the configuration allows: clickMaxHz, or at most blankingClickMaxHz
 * when the last self-noise fallback (blankTaintedFrames) is active.
 */
export function effectiveMaxClickHz(cfg: Config): number {
  return cfg.blankTaintedFrames ? Math.min(cfg.clickMaxHz, cfg.blankingClickMaxHz) : cfg.clickMaxHz
}

/**
 * Mean click rate in Hz for a warmth in [0, 1]: clickMinHz * (max / clickMinHz) ^ warmth, with
 * max = effectiveMaxClickHz. Exponential, so equal warmth steps sound like equal tempo steps.
 * Warmth outside [0, 1] is clamped; NaN counts as 0.
 */
export function clickRateHz(warmth: number, cfg: Config): number {
  const w = warmth > 0 ? Math.min(1, warmth) : 0
  return cfg.clickMinHz * (effectiveMaxClickHz(cfg) / cfg.clickMinHz) ** w
}

/**
 * Delay in seconds until the next click, drawn from a shifted exponential so clicks sound random
 * (Poisson-like) while keeping a hard minimum gap:
 * d = clickMinGapS + Exp(1) * (1 / rate - clickMinGapS), with Exp(1) = -ln(1 - u).
 * The mean is exactly 1 / rate until the cap at clickMaxGapS trims the tail (noticeable only when
 * 1 / rate is within a few scale lengths of the cap, e.g. about 4 % low at 1.5 Hz).
 * If 1 / rate <= clickMinGapS the gap is clickMinGapS; rate <= 0 (or NaN) gives clickMaxGapS.
 * `u` is a uniform draw in [0, 1); values outside are clamped.
 */
export function nextClickDelayS(rateHz: number, u: number, cfg: Config): number {
  if (!(rateHz > 0)) return cfg.clickMaxGapS
  const meanS = 1 / rateHz
  if (meanS <= cfg.clickMinGapS) return cfg.clickMinGapS
  const uu = u > 0 ? Math.min(u, 1) : 0
  const d = cfg.clickMinGapS - Math.log1p(-uu) * (meanS - cfg.clickMinGapS)
  return Math.min(d, cfg.clickMaxGapS)
}

/**
 * Half-width in Hz of the main lobe of a Hann burst clickMs long: 2 / (clickMs / 1000),
 * i.e. 400 Hz for a 5 ms click. Beyond it only sidelobes remain, but they are not negligible:
 * the first one (about -31.5 dB, 2.5 / clickLength from the carrier) is well above a quiet floor.
 */
export function minClearanceHz(cfg: Config): number {
  return 2000 / cfg.clickMs // = 2 / (clickMs / 1000), exact for integer clickMs
}

/** Smallest distance in Hz between f0 and any of the carrier's harmonics 1..harmonics. */
function harmonicDistanceHz(carrierHz: number, f0Hz: number, harmonics: number): number {
  let d = Number.POSITIVE_INFINITY
  for (let h = 1; h <= harmonics; h++) d = Math.min(d, Math.abs(h * carrierHz - f0Hz))
  return d
}

/**
 * True when a carrier keeps the click out of the band measured at f0: every harmonic
 * 1..clickHarmonics at least minClearanceHz away (clears the main lobe of the click and of its
 * loudspeaker distortion products) and the fundamental at least clickMinCarrierDistanceHz away
 * (clears the fundamental's sidelobes, which are loud enough to matter).
 */
export function carrierQualifies(carrierHz: number, f0Hz: number, cfg: Config): boolean {
  return (
    harmonicDistanceHz(carrierHz, f0Hz, cfg.clickHarmonics) >= minClearanceHz(cfg) &&
    Math.abs(carrierHz - f0Hz) >= cfg.clickMinCarrierDistanceHz
  )
}

/**
 * Click carrier frequency in Hz for a locked f0: the first entry of clickCarriersHz that
 * qualifies (carrierQualifies). If none does, the one whose nearest harmonic is farthest from f0
 * (first such entry on a tie). With the default carriers every f0 in the search band has a
 * qualifying carrier and the band rises by less than 1 dB (see geiger.test.ts).
 * Throws a RangeError when clickCarriersHz is empty.
 */
export function chooseClickFreq(f0Hz: number, cfg: Config): number {
  const carriers = cfg.clickCarriersHz
  let bestHz = carriers[0]
  if (bestHz === undefined) throw new RangeError('config.clickCarriersHz is empty')
  let bestDist = Number.NEGATIVE_INFINITY
  for (const c of carriers) {
    if (carrierQualifies(c, f0Hz, cfg)) return c
    const d = harmonicDistanceHz(c, f0Hz, cfg.clickHarmonics)
    if (d > bestDist) {
      bestDist = d
      bestHz = c
    }
  }
  return bestHz
}

/**
 * Like chooseClickFreq, but keeps currentHz while it still qualifies for the new f0. The locked
 * frequency drifts by a few Hz per chirp (EMA); without this the click pitch could flip between
 * two carriers whenever f0 sits on a clearance edge.
 */
export function chooseClickFreqSticky(f0Hz: number, currentHz: number | null, cfg: Config): number {
  if (currentHz !== null && carrierQualifies(currentHz, f0Hz, cfg)) return currentHz
  return chooseClickFreq(f0Hz, cfg)
}

/**
 * Vibration pattern (ms, on/off alternating) to repeat every hapticPeriodMs:
 * clipped -> hapticClippedPattern; null warmth -> null (no feedback yet); otherwise the pattern of
 * the tier with the highest minWarmth that warmth reaches; below every tier (or NaN) -> null.
 * Tier order in the config does not matter.
 */
export function vibrationTier(warmth: number | null, clipped: boolean, cfg: Config): readonly number[] | null {
  if (clipped) return cfg.hapticClippedPattern
  if (warmth === null) return null
  let best: Config['hapticTiers'][number] | null = null
  for (const tier of cfg.hapticTiers) {
    if (warmth >= tier.minWarmth && (best === null || tier.minWarmth > best.minWarmth)) best = tier
  }
  return best === null ? null : best.pattern
}

/** Linear gain for a level in dB: 10 ^ (db / 20). */
export function dbToGain(db: number): number {
  return 10 ** (db / 20)
}

/**
 * Hann-shaped gain envelope for AudioParam.setValueCurveAtTime over one click: `points` samples,
 * exactly symmetric, 0 at both ends and peakGain at the centre. With an odd count (see
 * CLICK_CURVE_POINTS) the centre sample is the Hann peak; with an even count the curve is scaled
 * so the two middle samples equal peakGain. Every value lies in [0, peakGain] after Float32
 * rounding. Throws a RangeError unless points is an integer >= 3 and peakGain is finite and >= 0
 * (setValueCurveAtTime rejects non-finite values, so a bad gain fails here, not at click time).
 */
export function hannClickCurve(points: number, peakGain: number): Float32Array {
  if (!Number.isInteger(points) || points < 3) {
    throw new RangeError(`hannClickCurve needs an integer >= 3 points, got ${points}`)
  }
  if (!Number.isFinite(peakGain) || peakGain < 0) {
    throw new RangeError(`hannClickCurve needs a finite peakGain >= 0, got ${peakGain}`)
  }
  const n = points
  const out = new Float32Array(n)
  const hann = (i: number): number => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  const mid = (n - 1) >> 1 // centre (odd n) or the left of the two middle samples (even n)
  const top = hann(mid)
  for (let i = 0; i <= mid; i++) {
    const v = peakGain * (hann(i) / top) // x / x is exactly 1, so the middle is exactly peakGain
    out[i] = v
    out[n - 1 - i] = v
  }
  return out
}
