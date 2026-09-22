import { describe, expect, it } from 'vitest'
import { qrMatrix } from './qr.ts'
import { decodeFrame } from './qrDecode.ts'
import { CODE_MAX_CHARS } from './sdpCode.ts'

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const CODE = 'SW1.AQIEWHEzdhg3czlUZlVxTDJrUHorUi84d1h5NG1OMWJPGpwie-AT2FaqAf48iJRtsgdewSn0gDrdYhebxUDocQMAwKgBF-RL'

/** A pairing code of the longest allowed length. */
function longestCode(): string {
  let code = 'SW1.'
  for (let i = 0; code.length < CODE_MAX_CHARS; i++) code += B64URL[(i * 29 + 7) % 64]
  return code
}

interface FrameOptions {
  readonly width?: number
  readonly height?: number
  /** Width of one QR module in pixels. */
  readonly modulePx?: number
  readonly angleDeg?: number
  /** Deterministic noise amplitude (0-255). */
  readonly noise?: number
}

/**
 * A grey camera frame (RGBA) showing `text` as the app draws it: dark modules on white with a
 * 4-module quiet zone, centred, optionally rotated, on a mid-grey background. null text: no code.
 */
function cameraFrame(text: string | null, o: FrameOptions = {}): { width: number; height: number; data: Uint8ClampedArray } {
  const width = o.width ?? 640
  const height = o.height ?? 480
  const modulePx = o.modulePx ?? 4
  const noise = o.noise ?? 0
  const m = text === null ? null : qrMatrix(text)
  const n = m?.length ?? 0
  const units = n + 8
  const size = units * modulePx
  const a = ((o.angleDeg ?? 0) * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const data = new Uint8ClampedArray(width * height * 4)
  let seed = 12345
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - width / 2
      const dy = y + 0.5 - height / 2
      // Rotate the pixel back into the code's own square (0..1 on both axes).
      const u = (dx * cos + dy * sin) / size + 0.5
      const v = (-dx * sin + dy * cos) / size + 0.5
      let value = 110
      if (m !== null && u >= 0 && u < 1 && v >= 0 && v < 1) {
        const col = Math.floor(u * units) - 4
        const row = Math.floor(v * units) - 4
        const dark = row >= 0 && col >= 0 && row < n && col < n && m[row]![col]!
        value = dark ? 25 : 230
      }
      seed = (seed * 1103515245 + 12345) >>> 0
      value += noise * ((seed / 4294967296) * 2 - 1)
      const i = (y * width + x) * 4
      data[i] = data[i + 1] = data[i + 2] = value
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}

describe('decodeFrame', () => {
  it('reads a pairing code from a camera frame', () => {
    expect(decodeFrame(cameraFrame(CODE))).toBe(CODE)
  })

  it('reads the longest allowed pairing code', () => {
    const code = longestCode()
    expect(code).toHaveLength(CODE_MAX_CHARS)
    expect(decodeFrame(cameraFrame(code, { width: 800, height: 600 }))).toBe(code)
  })

  it('reads a tilted, noisy code with small modules', () => {
    expect(decodeFrame(cameraFrame(CODE, { angleDeg: 25, noise: 20 }))).toBe(CODE)
    expect(decodeFrame(cameraFrame(CODE, { modulePx: 3, noise: 10 }))).toBe(CODE)
  })

  it('reads a frame the size of an HD camera', () => {
    expect(decodeFrame(cameraFrame(CODE, { width: 1280, height: 720, modulePx: 6 }))).toBe(CODE)
  })

  it('returns null when there is no code or the frame is malformed', () => {
    expect(decodeFrame(cameraFrame(null, { noise: 30 }))).toBeNull()
    const ok = cameraFrame(CODE)
    expect(decodeFrame({ ...ok, width: ok.width + 1 })).toBeNull()
    expect(decodeFrame({ width: 0, height: 0, data: new Uint8ClampedArray(0) })).toBeNull()
    expect(decodeFrame({ width: 2.5, height: 2, data: new Uint8ClampedArray(20) })).toBeNull()
    expect(decodeFrame({ width: 4, height: 4, data: new Uint8ClampedArray(64) })).toBeNull()
  })
})
