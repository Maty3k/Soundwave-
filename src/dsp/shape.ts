/**
 * The shape of a sound, for telling the beep apart from other sounds at its pitch: an alarm beep
 * holds its level for a set time, while a clink, a knock or a plucked note fades from the start,
 * and voices and music vary in length. Pure.
 *
 * Measured through the app's own analysis (synthetic, 3.1 kHz, four frame alignments each): a
 * steady 150 ms beep of 40 dB or more has a 140-160 ms core fading -1..4 dB/s, 180-240 ms with a
 * room's echo; clinks fading 40, 60 and 120 dB/s measure 37-40, 46-60 and 67-120 dB/s over 80-180
 * ms cores. Weaker sounds scatter (a 25 dB beep once measured 28 dB/s), and a short beep with a
 * strong echo can look like a slow fade (80 ms, RT60 0.6 s: 14-38 dB/s), as does a plucked note
 * fading 20 dB/s (18-22 dB/s): those are why fades are judged only from shapeMinFadeSnrDb and with
 * shapeFadeTolDbPerS of room.
 */
import type { Config } from '../config.ts'
import type { SoundShape } from '../types.ts'

/** Median; 0 for none. */
function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

type ShapeConfig = Pick<
  Config,
  | 'coreDropDb'
  | 'shapeCoreShorterRatio'
  | 'shapeCoreLongerRatio'
  | 'shapeCoreSlackMs'
  | 'shapeFadeTolDbPerS'
  | 'shapeMinFadeFrames'
  | 'shapeMinFadeSnrDb'
>

/**
 * The shape of a sound from its frames' levels (dB) and times (ms, rising; parallel arrays) and its
 * SNR. The core is the span from the first to the last frame within coreDropDb of the loudest one;
 * coreMs is that span plus one frame step (the median time between frames, hopMs if unknown).
 * fadeDbPerS is the median of the core's frame-to-frame level changes per second, sign flipped
 * (positive when fading): a median, so the one or two ramp frames at a beep's ends (the analysis
 * window sliding over its start and end) and at a clink's start do not count, whatever the frames'
 * alignment. It is null when the core has fewer than shapeMinFadeFrames frames or the sound is
 * below shapeMinFadeSnrDb (noise dominates). Null without a finite level.
 */
export function soundShape(
  levelsDb: readonly number[],
  timesMs: readonly number[],
  snrDb: number,
  cfg: ShapeConfig & Pick<Config, 'hopMs'>,
): SoundShape | null {
  const n = Math.min(levelsDb.length, timesMs.length)
  let peak = -Infinity
  for (let i = 0; i < n; i++) if (Number.isFinite(levelsDb[i]!) && levelsDb[i]! > peak) peak = levelsDb[i]!
  if (!Number.isFinite(peak)) return null
  let first = -1
  let last = -1
  for (let i = 0; i < n; i++) {
    if (levelsDb[i]! >= peak - cfg.coreDropDb) {
      if (first < 0) first = i
      last = i
    }
  }
  const steps: number[] = []
  for (let i = 1; i < n; i++) {
    const dt = timesMs[i]! - timesMs[i - 1]!
    if (dt > 0) steps.push(dt)
  }
  const stepMs = steps.length > 0 ? median(steps) : cfg.hopMs
  const coreFrames = last - first + 1
  const coreMs = timesMs[last]! - timesMs[first]! + stepMs
  let fadeDbPerS: number | null = null
  if (coreFrames >= cfg.shapeMinFadeFrames && snrDb >= cfg.shapeMinFadeSnrDb) {
    const rates: number[] = []
    for (let i = first + 1; i <= last; i++) {
      const dt = timesMs[i]! - timesMs[i - 1]!
      const dl = levelsDb[i]! - levelsDb[i - 1]!
      if (dt > 0 && Number.isFinite(dl)) rates.push((dl / dt) * 1000)
    }
    if (rates.length > 0) fadeDbPerS = -median(rates)
  }
  return { coreMs, coreFrames, fadeDbPerS }
}

/**
 * A core that fits the reference core: at least 1/shapeCoreShorterRatio and at most
 * shapeCoreLongerRatio times as long, give or take shapeCoreSlackMs. Longer is allowed more room,
 * since a room's echo lengthens a beep's core but never shortens it.
 */
function coreFits(coreMs: number, refMs: number, cfg: ShapeConfig): boolean {
  return coreMs >= refMs / cfg.shapeCoreShorterRatio - cfg.shapeCoreSlackMs && coreMs <= refMs * cfg.shapeCoreLongerRatio + cfg.shapeCoreSlackMs
}

/**
 * The sound could be the beep whose fingerprint is `fp`: its core fits the beep's, and it does not
 * fade more than shapeFadeTolDbPerS faster than the beep (when both fades are known; fading slower
 * is fine).
 */
export function shapeMatches(shape: SoundShape, fp: SoundShape, cfg: ShapeConfig): boolean {
  if (!coreFits(shape.coreMs, fp.coreMs, cfg)) return false
  if (shape.fadeDbPerS !== null && fp.fadeDbPerS !== null && shape.fadeDbPerS > fp.fadeDbPerS + cfg.shapeFadeTolDbPerS) return false
  return true
}

/** Two sounds could be the same beep: each core fits the other, fades within shapeFadeTolDbPerS. Unknown shapes match. */
export function sameShape(a: SoundShape | undefined, b: SoundShape | undefined, cfg: ShapeConfig): boolean {
  if (a === undefined || b === undefined) return true
  if (!coreFits(a.coreMs, b.coreMs, cfg) || !coreFits(b.coreMs, a.coreMs, cfg)) return false
  if (a.fadeDbPerS === null || b.fadeDbPerS === null) return true
  return Math.abs(a.fadeDbPerS - b.fadeDbPerS) <= cfg.shapeFadeTolDbPerS
}

/** The beep's fingerprint from the shapes of its chirps: the median of each measure (of the known fades); null for none. */
export function fingerprintOf(shapes: readonly SoundShape[]): SoundShape | null {
  if (shapes.length === 0) return null
  const fades = shapes.map((s) => s.fadeDbPerS).filter((f): f is number => f !== null)
  return {
    coreMs: median(shapes.map((s) => s.coreMs)),
    coreFrames: Math.round(median(shapes.map((s) => s.coreFrames))),
    fadeDbPerS: fades.length === 0 ? null : median(fades),
  }
}
