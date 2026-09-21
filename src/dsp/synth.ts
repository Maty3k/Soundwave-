/**
 * TEST-ONLY synthetic signals and a reference AnalyserNode.
 *
 * Signals are built in the time domain (white noise, tones with ramps and glides, Hann-windowed
 * click bursts, broadband noise bursts) and analysed exactly like Chromium's RealtimeAnalyser:
 * the last fftSize samples, a periodic Blackman window (alpha 0.16), an FFT, |X[k]| / fftSize,
 * 20*log10. Frames therefore smear onsets and offsets like the real analyser does.
 *
 * Nothing in the app imports this file.
 */
import { clipFraction, rmsDb, sanitizeDb, SILENT_DB } from './spectrum.ts'
import type { Frame } from '../types.ts'

// ---- Random numbers ----------------------------------------------------------------------------

/** Seeded PRNG (mulberry32), uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Standard normal sample from a uniform PRNG (Box-Muller). */
export function gaussian(rng: () => number): number {
  let u = rng()
  while (u <= Number.MIN_VALUE) u = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

// ---- Reference analyser ------------------------------------------------------------------------

/** Periodic Blackman window as used by Chromium's AnalyserNode (a0 0.42, a1 0.5, a2 0.08). */
export function blackmanWindow(n: number): Float64Array {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const x = i / n
    w[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x)
  }
  return w
}

/** Radix-2 complex FFT with precomputed tables. */
export class Fft {
  readonly n: number
  private readonly rev: Uint32Array
  private readonly cos: Float64Array
  private readonly sin: Float64Array

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`)
    this.n = n
    const bits = Math.log2(n)
    this.rev = new Uint32Array(n)
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
    this.cos = new Float64Array(n / 2)
    this.sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n)
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n)
    }
  }

  /** In-place forward transform of (re, im). */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.n
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]!
      if (j > i) {
        const tr = re[i]!
        re[i] = re[j]!
        re[j] = tr
        const ti = im[i]!
        im[i] = im[j]!
        im[j] = ti
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step]!
          const wi = this.sin[k * step]!
          const a = start + k
          const b = a + half
          const xr = re[b]! * wr - im[b]! * wi
          const xi = re[b]! * wi + im[b]! * wr
          re[b] = re[a]! - xr
          im[b] = im[a]! - xi
          re[a] = re[a]! + xr
          im[a] = im[a]! + xi
        }
      }
    }
  }
}

/** Reference AnalyserNode (smoothingTimeConstant 0) over a sample buffer. */
export class ReferenceAnalyser {
  readonly fftSize: number
  private readonly fft: Fft
  private readonly window: Float64Array
  private readonly re: Float64Array
  private readonly im: Float64Array

  constructor(fftSize: number) {
    this.fftSize = fftSize
    this.fft = new Fft(fftSize)
    this.window = blackmanWindow(fftSize)
    this.re = new Float64Array(fftSize)
    this.im = new Float64Array(fftSize)
  }

  /**
   * dB spectrum (length fftSize / 2) of the fftSize samples ending just before `end`.
   * Samples before index 0 are treated as silence.
   */
  analyse(samples: Float32Array, end: number, out = new Float32Array(this.fftSize / 2)): Float32Array {
    const n = this.fftSize
    const start = end - n
    for (let i = 0; i < n; i++) {
      const idx = start + i
      const x = idx >= 0 && idx < samples.length ? samples[idx]! : 0
      this.re[i] = x * this.window[i]!
      this.im[i] = 0
    }
    this.fft.transform(this.re, this.im)
    const scale = 1 / n
    for (let k = 0; k < n / 2; k++) {
      const mag = Math.hypot(this.re[k]!, this.im[k]!) * scale
      out[k] = mag > 0 ? 20 * Math.log10(mag) : -Infinity
    }
    out[0] = SILENT_DB // Chromium blows away the DC / packed Nyquist term
    return sanitizeDb(out, out)
  }
}

// ---- Level helpers -----------------------------------------------------------------------------

const BLACKMAN_A0 = 0.42
/** Sum of squared window samples divided by n for the periodic Blackman window. */
const BLACKMAN_POWER = BLACKMAN_A0 ** 2 + 0.5 ** 2 / 2 + 0.08 ** 2 / 2

/** Expected per-bin median noise floor (dB) for white noise of RMS `noiseDb` dBFS. */
export function expectedFloorDb(noiseDb: number, fftSize: number): number {
  const sigma2 = 10 ** (noiseDb / 10)
  const meanPower = (sigma2 * BLACKMAN_POWER) / fftSize
  return 10 * Math.log10(meanPower * Math.LN2)
}

/** Analyser reading of a bin-centred sine with peak amplitude `levelDb` dBFS (about levelDb - 13.6). */
export function tonePeakDb(levelDb: number): number {
  return levelDb + 20 * Math.log10(BLACKMAN_A0 / 2)
}

/** Sine amplitude (dBFS) that gives a per-bin peak SNR of `snrDb` over white noise of RMS `noiseDb`. */
export function toneLevelForSnr(snrDb: number, noiseDb: number, fftSize: number): number {
  return expectedFloorDb(noiseDb, fftSize) + snrDb - 20 * Math.log10(BLACKMAN_A0 / 2)
}

// ---- Signal synthesis --------------------------------------------------------------------------

export interface ToneSpec {
  readonly hz: number
  /** End frequency for a linear glide (speech-like harmonics). Defaults to hz. */
  readonly hzEnd?: number
  /** Peak amplitude in dBFS (0 dB = amplitude 1). */
  readonly levelDb: number
  readonly onS: number
  readonly offS: number
  /** Raised-cosine attack and release, default 1 ms. */
  readonly rampMs?: number
  readonly phase?: number
}

/** Hann-windowed sine burst, like one Geiger click. */
export interface BurstSpec {
  readonly atS: number
  readonly hz: number
  readonly ms: number
  /** Peak amplitude in dBFS. */
  readonly levelDb: number
}

/** Broadband white-noise burst (door, dishes, footsteps). */
export interface NoiseBurstSpec {
  readonly atS: number
  readonly ms: number
  /** RMS in dBFS. */
  readonly levelDb: number
}

export interface SignalSpec {
  readonly sampleRate: number
  readonly durationS: number
  /** RMS of stationary white noise in dBFS; -Infinity for none. */
  readonly noiseDb: number
  readonly tones?: readonly ToneSpec[]
  readonly bursts?: readonly BurstSpec[]
  readonly noiseBursts?: readonly NoiseBurstSpec[]
  readonly seed?: number
  /** Hard-clip to [-1, 1] like an ADC (default true). */
  readonly clip?: boolean
}

export function synthSignal(spec: SignalSpec): Float32Array {
  const sr = spec.sampleRate
  const n = Math.round(spec.durationS * sr)
  const x = new Float64Array(n)
  const rng = mulberry32(spec.seed ?? 1)

  if (Number.isFinite(spec.noiseDb)) {
    const sigma = 10 ** (spec.noiseDb / 20)
    for (let i = 0; i < n; i++) x[i] = sigma * gaussian(rng)
  }

  for (const t of spec.tones ?? []) {
    const amp = 10 ** (t.levelDb / 20)
    const i0 = Math.max(0, Math.floor(t.onS * sr))
    const i1 = Math.min(n, Math.ceil(t.offS * sr))
    const ramp = Math.max(1, Math.round(((t.rampMs ?? 1) / 1000) * sr))
    const f0 = t.hz
    const f1 = t.hzEnd ?? t.hz
    const len = Math.max(1, i1 - i0)
    let phase = t.phase ?? 0
    for (let i = i0; i < i1; i++) {
      const pos = i - i0
      const f = f0 + ((f1 - f0) * pos) / len
      let env = 1
      if (pos < ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * pos) / ramp)
      const fromEnd = i1 - 1 - i
      if (fromEnd < ramp) env = Math.min(env, 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / ramp))
      x[i] = x[i]! + amp * env * Math.sin(phase)
      phase += (2 * Math.PI * f) / sr
    }
  }

  for (const b of spec.bursts ?? []) {
    const amp = 10 ** (b.levelDb / 20)
    const i0 = Math.round(b.atS * sr)
    const len = Math.max(2, Math.round((b.ms / 1000) * sr))
    for (let j = 0; j < len; j++) {
      const i = i0 + j
      if (i < 0 || i >= n) continue
      const env = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (len - 1))
      x[i] = x[i]! + amp * env * Math.sin((2 * Math.PI * b.hz * j) / sr)
    }
  }

  for (const nb of spec.noiseBursts ?? []) {
    const sigma = 10 ** (nb.levelDb / 20)
    const i0 = Math.round(nb.atS * sr)
    const len = Math.round((nb.ms / 1000) * sr)
    for (let j = 0; j < len; j++) {
      const i = i0 + j
      if (i >= 0 && i < n) x[i] = x[i]! + sigma * gaussian(rng)
    }
  }

  const out = new Float32Array(n)
  const clip = spec.clip ?? true
  for (let i = 0; i < n; i++) {
    const v = x[i]!
    out[i] = clip ? Math.max(-1, Math.min(1, v)) : v
  }
  return out
}

// ---- Frames ------------------------------------------------------------------------------------

export interface FrameOptions {
  readonly fftSize?: number
  readonly hopMs?: number
  /** Signal time (ms) of the first frame; defaults to one full window. */
  readonly startMs?: number
  /** Added to every frame's tMs (to simulate a hunt that started later). */
  readonly tOffsetMs?: number
  readonly clipThreshold?: number
  /** Marks frames as clickTainted (signal time in ms of the frame end). */
  readonly tainted?: (tMs: number) => boolean
}

/** Lazily analyse a signal into Frames every hopMs, like the app's engine loop. */
export function* iterateFrames(samples: Float32Array, sampleRate: number, opts: FrameOptions = {}): Generator<Frame> {
  const fftSize = opts.fftSize ?? 4096
  const hopMs = opts.hopMs ?? 20
  const analyser = new ReferenceAnalyser(fftSize)
  const windowMs = (fftSize / sampleRate) * 1000
  const startMs = opts.startMs ?? windowMs
  const durationMs = (samples.length / sampleRate) * 1000
  const binWidth = sampleRate / fftSize
  const clipThr = opts.clipThreshold ?? 0.98
  const td = new Float32Array(fftSize)
  let first = true
  for (let t = startMs; t <= durationMs + 1e-9; t += hopMs) {
    const end = Math.round((t / 1000) * sampleRate)
    const db = analyser.analyse(samples, end)
    for (let i = 0; i < fftSize; i++) {
      const idx = end - fftSize + i
      td[i] = idx >= 0 && idx < samples.length ? samples[idx]! : 0
    }
    yield {
      tMs: t + (opts.tOffsetMs ?? 0),
      db,
      binHz: binWidth,
      clipFrac: clipFraction(td, clipThr),
      rmsDb: rmsDb(td),
      dtMs: first ? 0 : hopMs,
      gap: false,
      clickTainted: opts.tainted ? opts.tainted(t) : false,
    }
    first = false
  }
}

/** All frames of a signal as an array (fine for signals up to a few minutes). */
export function framesFromSignal(samples: Float32Array, sampleRate: number, opts: FrameOptions = {}): Frame[] {
  return Array.from(iterateFrames(samples, sampleRate, opts))
}

/** Convenience: synthesise and analyse in one call. */
export function synthFrames(spec: SignalSpec, opts: FrameOptions = {}): Frame[] {
  return framesFromSignal(synthSignal(spec), spec.sampleRate, opts)
}

/** A chirp train: `count` chirps of `ms` every `everyS`, starting at `firstS`, level stepping by `stepDb`. */
export function chirpTrain(opts: {
  readonly hz: number
  readonly levelDb: number
  readonly count: number
  readonly everyS: number
  readonly firstS: number
  readonly ms: number
  readonly stepDb?: number | readonly number[]
}): ToneSpec[] {
  const tones: ToneSpec[] = []
  let level = opts.levelDb
  for (let i = 0; i < opts.count; i++) {
    if (i > 0) {
      const step = Array.isArray(opts.stepDb) ? (opts.stepDb[i - 1] ?? 0) : ((opts.stepDb as number | undefined) ?? 0)
      level += step
    }
    const on = opts.firstS + i * opts.everyS
    tones.push({ hz: opts.hz, levelDb: level, onS: on, offS: on + opts.ms / 1000 })
  }
  return tones
}
