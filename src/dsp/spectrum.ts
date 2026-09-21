/**
 * Per-frame spectrum primitives. Pure functions over Float32Array dB spectra as produced by
 * AnalyserNode.getFloatFrequencyData (Blackman window, |X[k]| / fftSize, 20*log10).
 */

/** Value used for bins that carry no information (-Infinity, NaN, <= -900 dB). */
export const SILENT_DB = -160

/** Width of one FFT bin in Hz. */
export function binHz(sampleRate: number, fftSize: number): number {
  return sampleRate / fftSize
}

export function hzToBin(hz: number, binWidthHz: number): number {
  return hz / binWidthHz
}

export function binToHz(bin: number, binWidthHz: number): number {
  return bin * binWidthHz
}

/**
 * Copy `src` into `out`, replacing NaN, -Infinity and anything below `silentDb` with `silentDb`.
 * Chrome reports -Infinity for exact zeros and some browsers report -1000-ish values for silence.
 */
export function sanitizeDb(
  src: Float32Array,
  out: Float32Array = new Float32Array(src.length),
  silentDb: number = SILENT_DB,
): Float32Array {
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!
    out[i] = v >= silentDb ? v : silentDb // NaN fails the comparison too
  }
  return out
}

/** Median of a numeric list (copies; does not reorder the input). NaN for an empty list. */
export function median(values: ArrayLike<number>): number {
  const n = values.length
  if (n === 0) return Number.NaN
  const a = Array.from(values).sort((x, y) => x - y)
  const mid = n >> 1
  return n % 2 === 1 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2
}

/**
 * Local noise floor around `center`: median of bins within +-halfBins, excluding +-guardBins
 * (so the tone's own main lobe does not raise it) and excluding bin 0 (DC).
 * Returns SILENT_DB when no bins are available.
 */
export function localFloorDb(db: Float32Array, center: number, halfBins: number, guardBins: number): number {
  const c = Math.round(center)
  const lo = Math.max(1, c - halfBins)
  const hi = Math.min(db.length - 1, c + halfBins)
  const vals: number[] = []
  for (let k = lo; k <= hi; k++) {
    if (Math.abs(k - c) > guardBins) vals.push(db[k]!)
  }
  return vals.length ? median(vals) : SILENT_DB
}

/**
 * Expected noise power of a `bandBins`-bin power sum, given a per-bin median-magnitude floor.
 * For Rayleigh-distributed magnitudes the mean power is 1.59 dB above the median power.
 */
export function bandFloorDb(floorDb: number, bandBins: number, offsetDb: number): number {
  return floorDb + 10 * Math.log10(bandBins) + offsetDb
}

export interface ParabolicPeak {
  /** Offset of the true peak from the centre bin, in bins, within [-0.5, 0.5]. */
  readonly delta: number
  /** Interpolated peak level in dB. */
  readonly peakDb: number
}

/**
 * Parabolic interpolation through three dB values around a local maximum b.
 * If the three points do not form a maximum, returns { delta: 0, peakDb: b }.
 */
export function parabolicPeak(a: number, b: number, c: number): ParabolicPeak {
  const denom = a - 2 * b + c
  if (!(denom < 0)) return { delta: 0, peakDb: b }
  let delta = (0.5 * (a - c)) / denom
  if (delta > 0.5) delta = 0.5
  else if (delta < -0.5) delta = -0.5
  return { delta, peakDb: b - 0.25 * (a - c) * delta }
}

/**
 * Number of contiguous bins around bin k (inclusive) whose level is at least
 * max(db[k] - dropDb, floorDb + floorMarginDb). The floor term keeps the width defined at low SNR,
 * where the -dropDb contour would lie inside the noise.
 */
export function peakWidthBins(
  db: Float32Array,
  k: number,
  dropDb: number,
  floorDb: number,
  floorMarginDb: number,
): number {
  const thr = Math.max(db[k]! - dropDb, floorDb + floorMarginDb)
  let width = 1
  for (let i = k - 1; i >= 0 && db[i]! >= thr; i--) width++
  for (let i = k + 1; i < db.length && db[i]! >= thr; i++) width++
  return width
}

/**
 * Power sum (in dB) of the `nBins` bins nearest `centerBin` (a fractional bin position).
 * With nBins = 3 this covers the Blackman main lobe and varies by well under 0.5 dB as a tone
 * moves across a bin (no scalloping).
 */
export function bandLevelDb(db: Float32Array, centerBin: number, nBins: number): number {
  const start = Math.round(centerBin - (nBins - 1) / 2)
  let sum = 0
  for (let i = 0; i < nBins; i++) {
    const k = Math.min(db.length - 1, Math.max(0, start + i))
    sum += 10 ** (db[k]! / 10)
  }
  return sum > 0 ? 10 * Math.log10(sum) : SILENT_DB
}

/** Index of the maximum of db[lo..hi] (inclusive, clamped to the array). */
export function argmaxInRange(db: Float32Array, lo: number, hi: number): number {
  const a = Math.max(0, Math.floor(lo))
  const b = Math.min(db.length - 1, Math.ceil(hi))
  let best = a
  for (let k = a + 1; k <= b; k++) if (db[k]! > db[best]!) best = k
  return best
}

/** Share of samples with |x| >= threshold. */
export function clipFraction(td: Float32Array, threshold: number): number {
  if (td.length === 0) return 0
  let n = 0
  for (let i = 0; i < td.length; i++) if (Math.abs(td[i]!) >= threshold) n++
  return n / td.length
}

/** RMS level in dBFS, or SILENT_DB for digital silence. */
export function rmsDb(td: Float32Array): number {
  if (td.length === 0) return SILENT_DB
  let s = 0
  for (let i = 0; i < td.length; i++) s += td[i]! * td[i]!
  const rms = Math.sqrt(s / td.length)
  return rms > 0 ? Math.max(SILENT_DB, 20 * Math.log10(rms)) : SILENT_DB
}

export interface BandMeasurement {
  /** Band level: power sum of the bandBins bins nearest the centre. */
  readonly levelDb: number
  /** Per-bin local median floor around the centre. */
  readonly floorDb: number
  /** Expected noise power of the band (floor corrected to a bandBins power sum). */
  readonly bandFloorDb: number
  /** levelDb - bandFloorDb. About 4 dB below the per-bin peak SNR of a pure tone. */
  readonly snrDb: number
}

/**
 * Band level and noise reference at a fixed (fractional) bin: the measurement used every frame
 * while hunting. Measuring at the tracked frequency rather than at the loudest nearby bin keeps
 * the noise baseline unbiased, so onset thresholds mean the same thing everywhere.
 */
export function measureBandAt(
  db: Float32Array,
  centerBin: number,
  bandBins: number,
  floorHalfBins: number,
  floorGuardBins: number,
  bandFloorOffset: number,
): BandMeasurement {
  const levelDb = bandLevelDb(db, centerBin, bandBins)
  const floorDb = localFloorDb(db, centerBin, floorHalfBins, floorGuardBins)
  const bf = bandFloorDb(floorDb, bandBins, bandFloorOffset)
  return { levelDb, floorDb, bandFloorDb: bf, snrDb: levelDb - bf }
}

export interface LocatedPeak {
  /** Integer bin of the maximum within the search window. */
  readonly bin: number
  /** Interpolated bin position. */
  readonly binF: number
  /** Interpolated per-bin peak level. */
  readonly peakDb: number
}

/** Loudest bin within expectedBin +- tolBins, refined by parabolic interpolation. */
export function locatePeak(db: Float32Array, expectedBin: number, tolBins: number): LocatedPeak {
  const k = argmaxInRange(db, expectedBin - tolBins, expectedBin + tolBins)
  if (k <= 0 || k >= db.length - 1) return { bin: k, binF: k, peakDb: db[k]! }
  const p = parabolicPeak(db[k - 1]!, db[k]!, db[k + 1]!)
  return { bin: k, binF: k + p.delta, peakDb: p.peakDb }
}
