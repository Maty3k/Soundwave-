#!/usr/bin/env node
/**
 * Writes test-signal WAV files (16-bit PCM, mono, 48 kHz) for trying Soundwave without a real
 * chirping smoke detector. Play one from a second device (or the laptop) while hunting.
 *
 *   npm run chirps                         # writes the presets below into public/dev/
 *   node tools/make-chirp-wav.mjs --hz 3200 --ms 120 --every 30 --count 10 --out my.wav
 *
 * Presets (public/dev/, git-ignored, served by the dev server and Herd at ./dev/<name>.wav):
 *   chirp-10s.wav  3.1 kHz, 150 ms chirp every 10 s, constant level (lock + countdown test)
 *   walk-10s.wav   same, but the level changes like a walk: warmer, warmer, colder, ... (verdict test)
 *   ups-30s.wav    UPS-style: 4 beeps (200 ms, 1 s apart) every 30 s at 2.4 kHz (grouped readings)
 *   tone-2k.wav    continuous 2 kHz tone for 20 s (live mode)
 *
 * Options: --hz <Hz> --ms <chirp ms> --every <s> --count <n> --first <s> --level <dBFS peak>
 *          --steps <comma-separated dB changes per chirp> --noise <dBFS RMS | none>
 *          --rate <Hz> --tail <s of silence after the last chirp> --out <file>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

/** Seeded PRNG so every run writes identical files. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * @param {{ rate: number, durationS: number, noiseDb: number | null,
 *           tones: Array<{ hz: number, levelDb: number, onS: number, offS: number }> }} spec
 */
function render(spec) {
  const n = Math.round(spec.durationS * spec.rate)
  const x = new Float64Array(n)
  const rng = mulberry32(12345)
  if (spec.noiseDb !== null) {
    const sigma = 10 ** (spec.noiseDb / 20)
    for (let i = 0; i < n; i++) {
      let u = rng()
      while (u <= Number.MIN_VALUE) u = rng()
      x[i] = sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
    }
  }
  const ramp = Math.round(0.002 * spec.rate) // 2 ms raised-cosine edges
  for (const t of spec.tones) {
    const amp = 10 ** (t.levelDb / 20)
    const i0 = Math.max(0, Math.floor(t.onS * spec.rate))
    const i1 = Math.min(n, Math.ceil(t.offS * spec.rate))
    for (let i = i0; i < i1; i++) {
      const pos = i - i0
      const fromEnd = i1 - 1 - i
      let env = 1
      if (pos < ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * pos) / ramp)
      if (fromEnd < ramp) env = Math.min(env, 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / ramp))
      x[i] += amp * env * Math.sin((2 * Math.PI * t.hz * pos) / spec.rate)
    }
  }
  const pcm = Buffer.alloc(44 + n * 2)
  pcm.write('RIFF', 0, 'ascii')
  pcm.writeUInt32LE(36 + n * 2, 4)
  pcm.write('WAVE', 8, 'ascii')
  pcm.write('fmt ', 12, 'ascii')
  pcm.writeUInt32LE(16, 16) // fmt chunk size
  pcm.writeUInt16LE(1, 20) // PCM
  pcm.writeUInt16LE(1, 22) // mono
  pcm.writeUInt32LE(spec.rate, 24)
  pcm.writeUInt32LE(spec.rate * 2, 28) // byte rate
  pcm.writeUInt16LE(2, 32) // block align
  pcm.writeUInt16LE(16, 34) // bits per sample
  pcm.write('data', 36, 'ascii')
  pcm.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, x[i]))
    pcm.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  return pcm
}

/** Chirps of `ms` every `every` s; `steps[i]` is the level change before chirp i + 1. */
function chirps({ hz, ms, every, count, first, level, steps }) {
  const tones = []
  let lv = level
  for (let i = 0; i < count; i++) {
    if (i > 0) lv += steps[(i - 1) % Math.max(1, steps.length)] ?? 0
    const on = first + i * every
    tones.push({ hz, levelDb: lv, onS: on, offS: on + ms / 1000 })
  }
  return tones
}

function write(file, spec) {
  const path = resolve(ROOT, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, render(spec))
  const last = spec.tones.at(-1)
  console.log(`${file}  ${spec.durationS.toFixed(1)} s, ${spec.tones.length} tone(s)${last ? `, last at ${last.onS.toFixed(1)} s` : ''}`)
}

const args = parseArgs(process.argv.slice(2))
const rate = Number(args.rate ?? 48000)
const noiseDb = args.noise === 'none' ? null : Number(args.noise ?? -60)

if (args.out) {
  const every = Number(args.every ?? 10)
  const count = Number(args.count ?? 12)
  const first = Number(args.first ?? 2)
  const tones = chirps({
    hz: Number(args.hz ?? 3100),
    ms: Number(args.ms ?? 150),
    every,
    count,
    first,
    level: Number(args.level ?? -30),
    steps: String(args.steps ?? '0').split(',').map(Number),
  })
  write(String(args.out), { rate, noiseDb, tones, durationS: first + (count - 1) * every + Number(args.tail ?? 3) })
} else {
  // Levels are sine peak dBFS; with -60 dBFS noise, -40 dBFS is about 49 dB per-bin SNR.
  write('public/dev/chirp-10s.wav', {
    rate,
    noiseDb,
    tones: chirps({ hz: 3100, ms: 150, every: 10, count: 12, first: 2, level: -35, steps: [0] }),
    durationS: 2 + 11 * 10 + 3,
  })
  write('public/dev/walk-10s.wav', {
    rate,
    noiseDb,
    // warmer, warmer, colder, warmer, same, warmer, warmer, colder, warmer, warmer, warmer
    tones: chirps({ hz: 3100, ms: 150, every: 10, count: 12, first: 2, level: -50, steps: [5, 5, -6, 6, 1, 5, 5, -7, 6, 5, 5] }),
    durationS: 2 + 11 * 10 + 3,
  })
  const ups = []
  for (let burst = 0; burst < 5; burst++) for (let b = 0; b < 4; b++) {
    const on = 2 + burst * 30 + b
    ups.push({ hz: 2400, levelDb: -35, onS: on, offS: on + 0.2 })
  }
  write('public/dev/ups-30s.wav', { rate, noiseDb, tones: ups, durationS: 2 + 4 * 30 + 6 })
  write('public/dev/tone-2k.wav', { rate, noiseDb, tones: [{ hz: 2000, levelDb: -35, onS: 1, offS: 21 }], durationS: 24 })
}
