/**
 * QR reading for browsers without a built-in BarcodeDetector (Safari, Firefox, Chrome on Windows
 * and Linux). Each check draws the current video frame onto a canvas, at most MAX_SIDE px on its
 * long side, and decodes it in a worker (qrDecode.worker.ts). qr.ts loads this module on demand,
 * so browsers with a built-in detector never download the decoder. If the worker cannot start or
 * fails, frames are decoded on the main thread instead.
 */
import QrWorker from './qrDecode.worker.ts?worker'
import type { CodeDetector, DetectedCode } from './qr.ts'

/**
 * Larger frames are scaled down to this long side (px). Not further: the decoder needs modules
 * about 3 px wide, and a pairing code held up to the camera is often only a third of the frame.
 */
const MAX_SIDE = 1280
/** A frame the worker has not answered by then counts as unreadable. */
const WORKER_TIMEOUT_MS = 2000

interface WorkerAnswer {
  readonly id: number
  readonly text: unknown
}

export function createFallbackDetector(): CodeDetector {
  return new FallbackDetector()
}

class FallbackDetector implements CodeDetector {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private worker: Worker | null = null
  private readonly pending = new Map<number, (text: string | null) => void>()
  private nextId = 1
  private closed = false

  constructor() {
    try {
      const worker = new QrWorker()
      worker.addEventListener('message', (event: MessageEvent<WorkerAnswer>) => {
        const answer = event.data
        const settle = this.pending.get(answer.id)
        if (settle === undefined) return
        this.pending.delete(answer.id)
        settle(typeof answer.text === 'string' && answer.text !== '' ? answer.text : null)
      })
      worker.addEventListener('error', () => this.dropWorker())
      this.worker = worker
    } catch {
      // No worker here: decodeHere() takes over.
    }
  }

  async detect(video: HTMLVideoElement): Promise<readonly DetectedCode[]> {
    if (this.closed) return []
    const frame = this.grab(video)
    if (frame === null) return []
    const text = this.worker !== null ? await this.decodeInWorker(this.worker, frame) : await this.decodeHere(frame)
    return text === null ? [] : [{ rawValue: text }]
  }

  close(): void {
    this.closed = true
    this.dropWorker()
    if (this.canvas !== null) {
      // Frees the pixel memory at once instead of at the next garbage collection.
      this.canvas.width = 0
      this.canvas.height = 0
    }
    this.canvas = null
    this.ctx = null
  }

  /** The current video frame as RGBA pixels, or null before the first frame or on an error. */
  private grab(video: HTMLVideoElement): ImageData | null {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!(vw > 0) || !(vh > 0)) return null
    const scale = Math.min(1, MAX_SIDE / Math.max(vw, vh))
    const w = Math.max(1, Math.round(vw * scale))
    const h = Math.max(1, Math.round(vh * scale))
    try {
      if (this.canvas === null) {
        this.canvas = document.createElement('canvas')
        // Read back every time: keep the canvas in memory instead of on the GPU.
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })
      }
      const canvas = this.canvas
      const ctx = this.ctx
      if (ctx === null) return null
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      ctx.drawImage(video, 0, 0, w, h)
      return ctx.getImageData(0, 0, w, h)
    } catch {
      return null
    }
  }

  private decodeInWorker(worker: Worker, frame: ImageData): Promise<string | null> {
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve(null)
      }, WORKER_TIMEOUT_MS)
      this.pending.set(id, (text) => {
        clearTimeout(timer)
        resolve(text)
      })
      try {
        worker.postMessage({ id, width: frame.width, height: frame.height, data: frame.data }, [frame.data.buffer])
      } catch {
        this.dropWorker()
      }
    })
  }

  private async decodeHere(frame: ImageData): Promise<string | null> {
    try {
      const { decodeFrame } = await import('./qrDecode.ts')
      return this.closed ? null : decodeFrame(frame)
    } catch {
      return null
    }
  }

  /** Stop the worker (failed or closed); frames still waiting for it count as unreadable. */
  private dropWorker(): void {
    const worker = this.worker
    this.worker = null
    try {
      worker?.terminate()
    } catch {
      // Already gone.
    }
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const settle of waiting) settle(null)
  }
}
