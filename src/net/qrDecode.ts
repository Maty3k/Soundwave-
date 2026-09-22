/**
 * Reads a QR code from one camera frame (RGBA pixels) with qr by Paul Miller (MIT OR Apache-2.0),
 * for browsers without a built-in BarcodeDetector. Pure: it runs in the scan worker
 * (qrDecode.worker.ts), on the main thread when no worker can be started, and in the tests.
 */
import { decodeQR } from 'qr/decode.js'

/** Time the decoder may spend on optional retries per frame (it normally runs in a worker). */
const RETRY_BUDGET_MS = 40

export interface RgbaFrame {
  readonly width: number
  readonly height: number
  /** width * height * 4 bytes, RGBA, row by row (ImageData.data). */
  readonly data: Uint8ClampedArray | Uint8Array
}

/** The text of the QR code in the frame, or null when there is none it can read. Never throws. */
export function decodeFrame(frame: RgbaFrame): string | null {
  const { width, height, data } = frame
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null
  if (data.length !== width * height * 4) return null
  try {
    const text = decodeQR({ width, height, data }, { format: 'RGBA', timeLimit: RETRY_BUDGET_MS })
    return typeof text === 'string' && text !== '' ? text : null
  } catch {
    return null
  }
}
