/**
 * Scan worker: decodes the camera frames qrFallback.ts posts, off the main thread, so the audio
 * analysis keeps its rhythm while the camera is open.
 * In: { id, width, height, data } (the pixel buffer is transferred). Out: { id, text }, where text
 * is null when no QR code could be read.
 */
import { decodeFrame } from './qrDecode.ts'

interface FrameMessage {
  readonly id: number
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray
}

const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<FrameMessage>) => void): void
  postMessage(message: { readonly id: number; readonly text: string | null }): void
}

scope.addEventListener('message', (event) => {
  const { id, width, height, data } = event.data
  scope.postMessage({ id, text: decodeFrame({ width, height, data }) })
})
