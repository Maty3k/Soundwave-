/**
 * QR codes for the pairing codes: drawing them (qrcode-generator, MIT) and reading them with the
 * camera. Reading uses the browser's BarcodeDetector where it has one with QR support (Chrome and
 * Edge on Android, macOS and ChromeOS). Everywhere else (Safari, Firefox, Chrome on Windows and
 * Linux) qrFallback.ts is loaded on demand and decodes the frames itself, in a worker. Without a
 * camera the code is copied or pasted instead.
 *
 * qrMatrix and qrPath are pure; qrSvg, qrScanSupported and QrScanner need a browser and
 * feature-detect everything they use.
 */
import qrcode from 'qrcode-generator'

/** Light modules around the code, as the QR specification requires. */
const QUIET_ZONE = 4
const DARK = '#0B0F19'
const LIGHT = '#FFFFFF'
const SVG_NS = 'http://www.w3.org/2000/svg'
const SCAN_PERIOD_MS = 250
/** Byte-mode capacity of the largest symbol (version 40) at error correction M. */
const MAX_BYTES_M = 2331

const ERR_NO_SCAN = 'This browser cannot scan QR codes. Paste the code instead.'
const ERR_CAMERA = 'The camera could not be started. Paste the code instead.'

/**
 * Modules of the QR code for `text` (version chosen automatically, error correction M, byte mode,
 * UTF-8): matrix[row][col], true = dark. Throws an Error when the text is too long for any version.
 */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > MAX_BYTES_M) throw new Error(`Text too long for a QR code (${bytes.length} bytes)`)
  // Byte mode takes one char per byte (low 8 bits): hand it the UTF-8 bytes as chars.
  const utf8 = String.fromCharCode(...bytes)
  const qr = qrcode(0, 'M')
  qr.addData(utf8, 'Byte')
  try {
    qr.make()
  } catch (err) {
    throw new Error(`Text too long for a QR code (${String(err)})`)
  }
  const n = qr.getModuleCount()
  const rows: boolean[][] = []
  for (let r = 0; r < n; r++) {
    const row: boolean[] = []
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c))
    rows.push(row)
  }
  return rows
}

/**
 * SVG path data drawing every dark module as part of one path, offset by `quiet` modules
 * (one unit = one module). Horizontal runs of dark modules become single rectangles.
 */
export function qrPath(matrix: readonly (readonly boolean[])[], quiet: number): string {
  let d = ''
  matrix.forEach((row, r) => {
    for (let c = 0; c < row.length; ) {
      if (!row[c]) {
        c++
        continue
      }
      let end = c
      while (end < row.length && row[end]) end++
      d += `M${c + quiet} ${r + quiet}h${end - c}v1h-${end - c}z`
      c = end
    }
  })
  return d
}

/**
 * A square SVG of the QR code for `text`, sizePx wide: dark modules on white (a QR code needs a
 * light background even in a dark UI), 4-module quiet zone, crisp edges, role="img". The caller
 * sets aria-label. Throws when `text` is too long (see qrMatrix).
 */
export function qrSvg(text: string, sizePx = 240): SVGSVGElement {
  const matrix = qrMatrix(text)
  const units = matrix.length + 2 * QUIET_ZONE
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${units} ${units}`)
  svg.setAttribute('width', String(sizePx))
  svg.setAttribute('height', String(sizePx))
  svg.setAttribute('shape-rendering', 'crispEdges')
  svg.setAttribute('role', 'img')
  const bg = document.createElementNS(SVG_NS, 'rect')
  bg.setAttribute('width', String(units))
  bg.setAttribute('height', String(units))
  bg.setAttribute('fill', LIGHT)
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', qrPath(matrix, QUIET_ZONE))
  path.setAttribute('fill', DARK)
  svg.append(bg, path)
  return svg
}

// ---- Scanning ----------------------------------------------------------------------------------

/** The parts of the (not yet typed) Barcode Detection API used here; qrFallback.ts implements them too. */
export interface DetectedCode {
  readonly rawValue?: unknown
}
export interface CodeDetector {
  detect(source: HTMLVideoElement): Promise<readonly DetectedCode[]>
  /** Release what the detector holds (the fallback's worker). The native one has nothing to close. */
  close?(): void
}
interface CodeDetectorClass {
  new (options?: { formats: string[] }): CodeDetector
  getSupportedFormats?: () => Promise<readonly string[]>
}

function detectorClass(): CodeDetectorClass | null {
  const bd: unknown = (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector
  return typeof bd === 'function' ? (bd as CodeDetectorClass) : null
}

function cameraApi(): MediaDevices | null {
  const md = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
  return typeof md?.getUserMedia === 'function' ? md : null
}

/** The fallback decoder draws video frames onto a canvas, so it needs a DOM. */
function fallbackPossible(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function'
}

/** Loads qrFallback.ts (and with it the decoder) the first time a browser without BarcodeDetector scans. */
function loadFallbackDetector(): Promise<CodeDetector> {
  return import('./qrFallback.ts').then((m) => m.createFallbackDetector())
}

/** A BarcodeDetector for QR codes, or null where there is none (or it refuses QR). */
function nativeDetector(): CodeDetector | null {
  const BD = detectorClass()
  if (BD === null) return null
  try {
    return new BD({ formats: ['qr_code'] })
  } catch {
    return null
  }
}

/**
 * True when the browser can read QR codes from the camera: getUserMedia, plus a BarcodeDetector
 * whose getSupportedFormats() includes 'qr_code' or else a DOM for the fallback decoder. False on
 * any error.
 */
export async function qrScanSupported(): Promise<boolean> {
  try {
    if (cameraApi() === null) return false
    if (fallbackPossible()) return true
    const BD = detectorClass()
    if (BD === null || typeof BD.getSupportedFormats !== 'function') return false
    const formats = await BD.getSupportedFormats()
    return Array.isArray(formats) && formats.includes('qr_code')
  } catch {
    return false
  }
}

function cameraError(err: unknown): string {
  const name = typeof err === 'object' && err !== null ? (err as { readonly name?: unknown }).name : undefined
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was blocked. Paste the code instead.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found. Paste the code instead.'
  return ERR_CAMERA
}

function stopTracks(stream: MediaStream): void {
  try {
    for (const t of stream.getTracks()) t.stop()
  } catch {
    // Already stopped.
  }
}

/**
 * Reads QR codes from the (rear) camera into the given <video> element. Call start() from a user
 * gesture; onResult gets each distinct decoded text once per start(). stop() must be called when
 * the scanner is no longer shown, or the camera stays on.
 */
export class QrScanner {
  /** Called with each distinct decoded text (once per value until the next start()). */
  onResult: ((text: string) => void) | null = null
  private readonly video: HTMLVideoElement
  private readonly loadFallback: () => Promise<CodeDetector>
  private stream: MediaStream | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private detector: CodeDetector | null = null
  private busy = false
  private seen = new Set<string>()
  /** Incremented by start() and stop(): a start() that was overtaken gives up quietly. */
  private generation = 0

  /** options.loadFallback replaces the on-demand fallback decoder (tests). */
  constructor(video: HTMLVideoElement, options: { readonly loadFallback?: () => Promise<CodeDetector> } = {}) {
    this.video = video
    this.loadFallback = options.loadFallback ?? loadFallbackDetector
  }

  /**
   * Open the camera (facingMode 'environment', the rear camera where there is one), play it inline
   * and muted, and look for a QR code every 250 ms. Resolves once the camera is attached (without
   * waiting for playback, which some browsers hold back until the video is visible). Rejects with a
   * user-presentable Error when scanning is unsupported or the camera cannot be opened; resolves
   * quietly when stop() or another start() overtakes it. Without a BarcodeDetector the fallback
   * decoder loads while the camera opens.
   */
  async start(): Promise<void> {
    this.stop()
    const gen = ++this.generation
    this.seen = new Set()
    const camera = cameraApi()
    const native = camera === null ? null : nativeDetector()
    if (camera === null || (native === null && !fallbackPossible())) throw new Error(ERR_NO_SCAN)
    const loading: Promise<CodeDetector | null> =
      native !== null
        ? Promise.resolve(native)
        : this.loadFallback().then(
            (d) => d,
            () => null,
          )
    const discard = (): void => {
      void loading.then((d) => d?.close?.())
    }

    let stream: MediaStream
    try {
      stream = await camera.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    } catch (err) {
      discard()
      // Stopped while the permission prompt was open: nobody is waiting for this error.
      if (gen !== this.generation) return
      throw new Error(cameraError(err))
    }
    const detector = await loading
    if (gen !== this.generation) {
      stopTracks(stream)
      detector?.close?.()
      return
    }
    if (detector === null) {
      stopTracks(stream)
      throw new Error(ERR_NO_SCAN)
    }
    this.stream = stream
    this.detector = detector

    const v = this.video
    try {
      v.muted = true
      v.playsInline = true
      v.setAttribute('playsinline', '')
      v.setAttribute('muted', '')
      v.srcObject = stream
    } catch {
      this.stop()
      throw new Error(ERR_CAMERA)
    }
    this.timer = setInterval(() => void this.scan(gen), SCAN_PERIOD_MS)
    try {
      // Autoplay refusal or a hidden element: detection waits for frames (video.readyState).
      v.play().catch(() => undefined)
    } catch {
      // Old engines without a play() promise.
    }
  }

  /** Stop the camera and the detection timer. Never throws; safe to call repeatedly. */
  stop(): void {
    this.generation++
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.detector?.close?.()
    this.detector = null
    this.busy = false
    if (this.stream !== null) stopTracks(this.stream)
    this.stream = null
    try {
      this.video.pause()
      this.video.srcObject = null
    } catch {
      // Element already detached.
    }
  }

  private async scan(gen: number): Promise<void> {
    const detector = this.detector
    if (this.busy || detector === null || this.video.readyState < 2) return
    this.busy = true
    let codes: unknown = []
    try {
      codes = await detector.detect(this.video)
    } catch {
      // A frame that could not be analysed; try the next one.
    }
    if (gen !== this.generation) return
    this.busy = false
    if (!Array.isArray(codes)) return
    for (const code of codes as readonly (DetectedCode | null)[]) {
      const text = code?.rawValue
      if (typeof text !== 'string' || text === '' || this.seen.has(text)) continue
      this.seen.add(text)
      const fn = this.onResult
      try {
        fn?.(text)
      } catch (err) {
        // A bug in the callback must not stop the scanning: report it and carry on.
        setTimeout(() => {
          throw err
        }, 0)
      }
      // The callback may have stopped (or restarted) the scanner.
      if (gen !== this.generation) return
    }
  }
}
