import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QrScanner, qrMatrix, qrPath, qrScanSupported, qrSvg, type CodeDetector } from './qr.ts'
import { CODE_MAX_CHARS, encodeCode } from './sdpCode.ts'

/** QR version from the module count (21 + 4 * (version - 1)). */
function versionOf(matrix: readonly (readonly boolean[])[]): number {
  return (matrix.length - 17) / 4
}

/** The 7x7 finder pattern with its top-left corner at (row, col): ring, gap, 3x3 centre. */
function hasFinder(m: readonly (readonly boolean[])[], row: number, col: number): boolean {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6
      const centre = r >= 2 && r <= 4 && c >= 2 && c <= 4
      if (m[row + r]![col + c] !== (ring || centre)) return false
    }
  }
  return true
}

/** The light separator around a finder pattern, inside the symbol. */
function hasSeparator(m: readonly (readonly boolean[])[], row: number, col: number): boolean {
  const n = m.length
  for (let i = -1; i <= 7; i++) {
    for (const [r, c] of [
      [row - 1, col + i],
      [row + 7, col + i],
      [row + i, col - 1],
      [row + i, col + 7],
    ] as const) {
      if (r >= 0 && r < n && c >= 0 && c < n && m[r]![c]) return false
    }
  }
  return true
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

describe('qrMatrix', () => {
  it('is square with 21 + 4k modules and the three finder patterns', () => {
    for (const text of ['a', 'SW1.hello', 'x'.repeat(100), 'SW1.' + 'A'.repeat(300)]) {
      const m = qrMatrix(text)
      const n = m.length
      expect(n, text).toBeGreaterThanOrEqual(21)
      expect((n - 21) % 4, text).toBe(0)
      for (const row of m) expect(row).toHaveLength(n)
      expect(hasFinder(m, 0, 0)).toBe(true)
      expect(hasFinder(m, 0, n - 7)).toBe(true)
      expect(hasFinder(m, n - 7, 0)).toBe(true)
      expect(hasSeparator(m, 0, 0)).toBe(true)
      expect(hasSeparator(m, 0, n - 7)).toBe(true)
      expect(hasSeparator(m, n - 7, 0)).toBe(true)
      // No finder in the fourth corner.
      expect(hasFinder(m, n - 7, n - 7)).toBe(false)
    }
  })

  it('has the timing patterns between the finders', () => {
    const m = qrMatrix('SW1.timing')
    const n = m.length
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0)
      expect(m[i]![6]).toBe(i % 2 === 0)
    }
  })

  it('is deterministic', () => {
    const text = 'SW1.AQIEWHEzdhg3czlUZlVxTDJrUHorUi84d1h5NG1OMWJPGpwie-AT2FaqAf48iJRtsgdewSn0gDrdYhebxUDocQMAwKgBF-RL'
    expect(qrMatrix(text)).toEqual(qrMatrix(text))
    expect(qrMatrix(text)).not.toEqual(qrMatrix(text.slice(0, -1) + 'M'))
  })

  it('fits a 160-character pairing code in version 10 or lower', () => {
    let code = 'SW1.'
    for (let i = 0; code.length < 160; i++) code += B64URL[(i * 37 + 11) % 64]
    expect(code).toHaveLength(160)
    expect(versionOf(qrMatrix(code))).toBeLessThanOrEqual(10)
  })

  it('fits the longest code peer.ts shows (CODE_MAX_CHARS) in version 10 or lower', () => {
    let code = 'SW1.'
    for (let i = 0; code.length < CODE_MAX_CHARS; i++) code += B64URL[(i * 29 + 5) % 64]
    expect(versionOf(qrMatrix(code))).toBeLessThanOrEqual(10)
  })

  it('fits a real offer code with three IPv4 candidates in a small symbol', () => {
    const code = encodeCode({
      type: 'offer',
      ufrag: 'Xq3v',
      pwd: '7s9TfUqL2kPz+R/8wXy4mN1b',
      fingerprint: Uint8Array.from({ length: 32 }, (_, i) => (i * 97 + 13) & 0xff),
      setup: 'actpass',
      candidates: [
        { address: '192.168.1.23', port: 58443, typ: 'host' },
        { address: '10.8.0.6', port: 49152, typ: 'host' },
        { address: '172.20.10.2', port: 61000, typ: 'host' },
      ],
    })
    expect(versionOf(qrMatrix(code))).toBeLessThanOrEqual(8)
  })

  it('encodes non-ASCII text as UTF-8 and rejects text that cannot fit', () => {
    expect(() => qrMatrix('Küche, Schlafzimmer')).not.toThrow()
    expect(qrMatrix('Küche')).not.toEqual(qrMatrix('Kuche'))
    expect(() => qrMatrix('x'.repeat(5000))).toThrow(Error)
    // Right at the capacity of version 40-M, and one byte over it (no stack overflow on huge text).
    expect(qrMatrix('x'.repeat(2331))).toHaveLength(177)
    expect(() => qrMatrix('x'.repeat(2332))).toThrow(/too long/)
    expect(() => qrMatrix('x'.repeat(1_000_000))).toThrow(/too long/)
  })
})

describe('qrPath', () => {
  it('draws horizontal runs of dark modules offset by the quiet zone', () => {
    const m = [
      [true, true, false],
      [false, true, true],
      [true, false, true],
    ]
    expect(qrPath(m, 4)).toBe('M4 4h2v1h-2zM5 5h2v1h-2zM4 6h1v1h-1zM6 6h1v1h-1z')
    expect(qrPath([[false, false]], 4)).toBe('')
  })

  it('covers exactly the dark modules of a real code', () => {
    const m = qrMatrix('SW1.path')
    const dark = m.flat().filter(Boolean).length
    const widths = [...qrPath(m, 4).matchAll(/h(\d+)v1/g)].map((x) => Number(x[1]))
    expect(widths.reduce((a, b) => a + b, 0)).toBe(dark)
  })
})

describe('qrScanSupported', () => {
  it('is false without BarcodeDetector (Node)', async () => {
    await expect(qrScanSupported()).resolves.toBe(false)
  })
})

// ---- Browser parts, against small fakes of the DOM, BarcodeDetector and the camera -------------

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Just enough of an SVG element for qrSvg. */
class FakeElement {
  readonly ns: string
  readonly tag: string
  readonly attrs = new Map<string, string>()
  readonly children: FakeElement[] = []
  constructor(ns: string, tag: string) {
    this.ns = ns
    this.tag = tag
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }
}

interface FakeTrack {
  stopped: boolean
  stop(): void
}

function fakeStream(): { readonly stream: MediaStream; readonly tracks: readonly FakeTrack[] } {
  const tracks: FakeTrack[] = [
    {
      stopped: false,
      stop() {
        this.stopped = true
      },
    },
  ]
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks }
}

/** Just enough of an HTMLVideoElement for QrScanner. */
class FakeVideo {
  muted = false
  playsInline = false
  srcObject: unknown = null
  readyState = 4
  paused = true
  readonly attrs = new Map<string, string>()
  playResult: () => Promise<void> = () => Promise.resolve()
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  play(): Promise<void> {
    this.paused = false
    return this.playResult()
  }
  pause(): void {
    this.paused = true
  }
}

type Detection = readonly { readonly rawValue?: unknown }[]

/** Installs a fake BarcodeDetector whose detect() returns the next batch (then empty batches). */
function installDetector(
  batches: (Detection | Error)[],
  formats: readonly string[] = ['qr_code'],
): { detectCalls: number; options: unknown[] } {
  const log = { detectCalls: 0, options: [] as unknown[] }
  class FakeDetector {
    static getSupportedFormats(): Promise<readonly string[]> {
      return Promise.resolve(formats)
    }
    constructor(options?: unknown) {
      log.options.push(options)
    }
    detect(): Promise<Detection> {
      log.detectCalls++
      // An explicit null batch stays null (a misbehaving polyfill); an exhausted list gives [].
      const next = batches.length > 0 ? batches.shift() : []
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as Detection)
    }
  }
  vi.stubGlobal('BarcodeDetector', FakeDetector)
  return log
}

function installCamera(getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>): MediaStreamConstraints[] {
  const calls: MediaStreamConstraints[] = []
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: (c: MediaStreamConstraints) => {
        calls.push(c)
        return getUserMedia(c)
      },
    },
  })
  return calls
}

function scannerWith(video: FakeVideo): { readonly scanner: QrScanner; readonly results: string[] } {
  const scanner = new QrScanner(video as unknown as HTMLVideoElement)
  const results: string[] = []
  scanner.onResult = (text) => results.push(text)
  return { scanner, results }
}

describe('qrSvg', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('draws the dark modules as one path on a white square with a 4-module quiet zone', () => {
    vi.stubGlobal('document', { createElementNS: (ns: string, tag: string) => new FakeElement(ns, tag) })
    const text = 'SW1.svg-test'
    const matrix = qrMatrix(text)
    const units = matrix.length + 8
    const svg = qrSvg(text) as unknown as FakeElement
    expect(svg.ns).toBe(SVG_NS)
    expect(svg.tag).toBe('svg')
    expect(svg.attrs.get('viewBox')).toBe(`0 0 ${units} ${units}`)
    expect(svg.attrs.get('width')).toBe('240')
    expect(svg.attrs.get('height')).toBe('240')
    expect(svg.attrs.get('shape-rendering')).toBe('crispEdges')
    expect(svg.attrs.get('role')).toBe('img')
    expect(svg.attrs.has('aria-label')).toBe(false)

    expect(svg.children.map((c) => c.tag)).toEqual(['rect', 'path'])
    const [bg, path] = svg.children
    expect(bg!.ns).toBe(SVG_NS)
    expect(bg!.attrs.get('width')).toBe(String(units))
    expect(bg!.attrs.get('height')).toBe(String(units))
    expect(bg!.attrs.get('fill')).toBe('#FFFFFF')
    expect(path!.ns).toBe(SVG_NS)
    expect(path!.attrs.get('fill')).toBe('#0B0F19')
    expect(path!.attrs.get('d')).toBe(qrPath(matrix, 4))

    const small = qrSvg(text, 180) as unknown as FakeElement
    expect(small.attrs.get('width')).toBe('180')
    expect(small.attrs.get('height')).toBe('180')
  })
})

describe('qrScanSupported (fakes)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is true with a QR-capable BarcodeDetector and a camera API', async () => {
    installDetector([])
    installCamera(() => Promise.resolve(fakeStream().stream))
    await expect(qrScanSupported()).resolves.toBe(true)
  })

  it('is false without QR support, without a camera API or on errors', async () => {
    installDetector([], ['ean_13', 'code_128'])
    installCamera(() => Promise.resolve(fakeStream().stream))
    await expect(qrScanSupported()).resolves.toBe(false)

    installDetector([])
    vi.stubGlobal('navigator', {})
    await expect(qrScanSupported()).resolves.toBe(false)

    installCamera(() => Promise.resolve(fakeStream().stream))
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        static getSupportedFormats(): Promise<string[]> {
          return Promise.reject(new Error('not now'))
        }
      },
    )
    await expect(qrScanSupported()).resolves.toBe(false)

    vi.stubGlobal('BarcodeDetector', class {})
    await expect(qrScanSupported()).resolves.toBe(false)
  })
})

describe('QrScanner (fakes)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('rejects with a readable message where scanning is not possible', async () => {
    const { scanner } = scannerWith(new FakeVideo())
    await expect(scanner.start()).rejects.toThrow(/cannot scan QR codes/)
    installDetector([])
    vi.stubGlobal('navigator', {})
    await expect(scanner.start()).rejects.toThrow(/cannot scan QR codes/)
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        constructor() {
          throw new TypeError('unsupported format')
        }
      },
    )
    installCamera(() => Promise.resolve(fakeStream().stream))
    await expect(scanner.start()).rejects.toThrow(/cannot scan QR codes/)
  })

  it('opens the rear camera inline and muted and reports each distinct code once', async () => {
    const log = installDetector([
      [],
      [{ rawValue: 'SW1.first' }],
      [{ rawValue: 'SW1.first' }, { rawValue: 'SW1.second' }],
      [{ rawValue: '' }, { rawValue: 42 }, {}],
      [{ rawValue: 'SW1.second' }],
    ])
    const { stream } = fakeStream()
    const calls = installCamera(() => Promise.resolve(stream))
    const video = new FakeVideo()
    const { scanner, results } = scannerWith(video)
    await scanner.start()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.video).toEqual({ facingMode: 'environment' })
    expect(calls[0]!.audio).toBe(false)
    expect(log.options).toEqual([{ formats: ['qr_code'] }])
    expect(video.srcObject).toBe(stream)
    expect(video.muted).toBe(true)
    expect(video.playsInline).toBe(true)
    expect(video.attrs.has('playsinline')).toBe(true)
    expect(video.paused).toBe(false)

    expect(log.detectCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(249)
    expect(log.detectCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(log.detectCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(4 * 250)
    expect(log.detectCalls).toBe(5)
    expect(results).toEqual(['SW1.first', 'SW1.second'])
    scanner.stop()
  })

  it('stop() turns the camera off and ends the detection; start() again reports codes anew', async () => {
    const log = installDetector([[{ rawValue: 'SW1.code' }]])
    const first = fakeStream()
    const second = fakeStream()
    const streams = [first.stream, second.stream]
    installCamera(() => Promise.resolve(streams.shift()!))
    const video = new FakeVideo()
    const { scanner, results } = scannerWith(video)
    await scanner.start()
    await vi.advanceTimersByTimeAsync(250)
    expect(results).toEqual(['SW1.code'])

    scanner.stop()
    expect(first.tracks.every((t) => t.stopped)).toBe(true)
    expect(video.srcObject).toBeNull()
    expect(video.paused).toBe(true)
    const calls = log.detectCalls
    await vi.advanceTimersByTimeAsync(2000)
    expect(log.detectCalls).toBe(calls)
    scanner.stop()

    await scanner.start()
    expect(video.srcObject).toBe(second.stream)
    await vi.advanceTimersByTimeAsync(250)
    expect(log.detectCalls).toBe(calls + 1)
    scanner.stop()
    expect(second.tracks.every((t) => t.stopped)).toBe(true)
  })

  it('reports the same code again after a restart', async () => {
    installDetector([[{ rawValue: 'SW1.same' }], [], [{ rawValue: 'SW1.same' }]])
    installCamera(() => Promise.resolve(fakeStream().stream))
    const { scanner, results } = scannerWith(new FakeVideo())
    await scanner.start()
    await vi.advanceTimersByTimeAsync(500)
    await scanner.start()
    await vi.advanceTimersByTimeAsync(250)
    expect(results).toEqual(['SW1.same', 'SW1.same'])
    scanner.stop()
  })

  it('explains camera failures', async () => {
    installDetector([])
    const video = new FakeVideo()
    const { scanner } = scannerWith(video)
    const cases: ReadonlyArray<readonly [string, RegExp]> = [
      ['NotAllowedError', /blocked/],
      ['SecurityError', /blocked/],
      ['NotFoundError', /No camera found/],
      ['OverconstrainedError', /No camera found/],
      ['NotReadableError', /could not be started/],
    ]
    for (const [name, message] of cases) {
      installCamera(() => Promise.reject(Object.assign(new Error('x'), { name })))
      await expect(scanner.start(), name).rejects.toThrow(message)
    }
  })

  it('gives up quietly when stopped while the camera permission prompt is open', async () => {
    const log = installDetector([[{ rawValue: 'SW1.late' }]])
    let grant: (s: MediaStream) => void = () => undefined
    let deny: (e: unknown) => void = () => undefined
    const { stream, tracks } = fakeStream()
    installCamera(
      () =>
        new Promise<MediaStream>((resolve, reject) => {
          grant = resolve
          deny = reject
        }),
    )
    const video = new FakeVideo()
    const { scanner, results } = scannerWith(video)

    const granted = scanner.start()
    scanner.stop()
    grant(stream)
    await expect(granted).resolves.toBeUndefined()
    expect(tracks.every((t) => t.stopped)).toBe(true)
    expect(video.srcObject).toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    expect(log.detectCalls).toBe(0)
    expect(results).toEqual([])

    const denied = scanner.start()
    scanner.stop()
    deny(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    await expect(denied).resolves.toBeUndefined()
  })

  it('does not wait for playback, and scans only once the video has frames', async () => {
    const log = installDetector([[{ rawValue: 'SW1.frames' }]])
    installCamera(() => Promise.resolve(fakeStream().stream))
    const video = new FakeVideo()
    video.readyState = 0
    video.playResult = () => new Promise<void>(() => undefined)
    const { scanner, results } = scannerWith(video)
    await scanner.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(log.detectCalls).toBe(0)
    video.readyState = 2
    await vi.advanceTimersByTimeAsync(250)
    expect(results).toEqual(['SW1.frames'])

    // A refused play() (autoplay policy) is not an error either.
    video.playResult = () => Promise.reject(new Error('NotAllowedError'))
    await expect(scanner.start()).resolves.toBeUndefined()
    scanner.stop()
  })

  it('keeps scanning after a frame that could not be analysed', async () => {
    installDetector([
      new Error('frame not ready'),
      // A polyfill returning something odd is ignored too.
      null as unknown as Detection,
      [null, { rawValue: 'SW1.after' }] as unknown as Detection,
    ])
    installCamera(() => Promise.resolve(fakeStream().stream))
    const { scanner, results } = scannerWith(new FakeVideo())
    await scanner.start()
    await vi.advanceTimersByTimeAsync(750)
    expect(results).toEqual(['SW1.after'])
    scanner.stop()
  })

  it('keeps scanning when onResult throws, and still reports the error', async () => {
    installDetector([[{ rawValue: 'SW1.bad' }, { rawValue: 'SW1.next' }], [{ rawValue: 'SW1.later' }]])
    installCamera(() => Promise.resolve(fakeStream().stream))
    const scanner = new QrScanner(new FakeVideo() as unknown as HTMLVideoElement)
    const results: string[] = []
    scanner.onResult = (text) => {
      results.push(text)
      if (text === 'SW1.bad') throw new Error('app bug')
    }
    await scanner.start()
    // The error is rethrown from a timer of its own; catch it there.
    const thrown: unknown[] = []
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) =>
      realSetTimeout(() => {
        try {
          fn()
        } catch (err) {
          thrown.push(err)
        }
      }, ms)) as typeof setTimeout)
    await vi.advanceTimersByTimeAsync(500)
    expect(results).toEqual(['SW1.bad', 'SW1.next', 'SW1.later'])
    expect(thrown).toHaveLength(1)
    expect((thrown[0] as Error).message).toBe('app bug')
    vi.restoreAllMocks()
    scanner.stop()
  })

  it('lets onResult stop the scanner: later codes of the same frame are not reported', async () => {
    const log = installDetector([[{ rawValue: 'SW1.one' }, { rawValue: 'SW1.two' }], [{ rawValue: 'SW1.three' }]])
    const { stream, tracks } = fakeStream()
    installCamera(() => Promise.resolve(stream))
    const scanner = new QrScanner(new FakeVideo() as unknown as HTMLVideoElement)
    const results: string[] = []
    scanner.onResult = (text) => {
      results.push(text)
      scanner.stop()
    }
    await scanner.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(results).toEqual(['SW1.one'])
    expect(log.detectCalls).toBe(1)
    expect(tracks.every((t) => t.stopped)).toBe(true)
  })
})

// ---- Without BarcodeDetector: the fallback decoder (qrFallback.ts, replaced by a fake here) -----

describe('QrScanner without BarcodeDetector (fallback decoder)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Just enough DOM for the fallback (it draws frames onto a canvas). */
  function installDom(): void {
    vi.stubGlobal('document', { createElement: () => ({}) })
  }

  function fakeFallback(batches: Detection[]): {
    readonly detector: CodeDetector & { closed: number }
    readonly load: () => Promise<CodeDetector>
    readonly loads: () => number
  } {
    let loads = 0
    const detector = {
      closed: 0,
      detect(): Promise<Detection> {
        return Promise.resolve(batches.length > 0 ? batches.shift()! : [])
      },
      close(): void {
        this.closed++
      },
    }
    return {
      detector,
      load: () => {
        loads++
        return Promise.resolve(detector)
      },
      loads: () => loads,
    }
  }

  function scanner(load: () => Promise<CodeDetector>): { readonly scanner: QrScanner; readonly results: string[] } {
    const sc = new QrScanner(new FakeVideo() as unknown as HTMLVideoElement, { loadFallback: load })
    const results: string[] = []
    sc.onResult = (text) => results.push(text)
    return { scanner: sc, results }
  }

  it('reports scanning as possible with a DOM and a camera', async () => {
    installDom()
    installCamera(() => Promise.resolve(fakeStream().stream))
    await expect(qrScanSupported()).resolves.toBe(true)
    vi.stubGlobal('navigator', {})
    await expect(qrScanSupported()).resolves.toBe(false)
  })

  it('loads the decoder once, reports codes and closes it with the camera on stop()', async () => {
    installDom()
    const { stream, tracks } = fakeStream()
    installCamera(() => Promise.resolve(stream))
    const fb = fakeFallback([[], [{ rawValue: 'SW1.fallback' }], [{ rawValue: 'SW1.fallback' }]])
    const { scanner: sc, results } = scanner(fb.load)
    await sc.start()
    expect(fb.loads()).toBe(1)
    await vi.advanceTimersByTimeAsync(750)
    expect(results).toEqual(['SW1.fallback'])
    sc.stop()
    expect(fb.detector.closed).toBe(1)
    expect(tracks.every((t) => t.stopped)).toBe(true)
  })

  it('prefers the built-in BarcodeDetector', async () => {
    installDom()
    installDetector([[{ rawValue: 'SW1.native' }]])
    installCamera(() => Promise.resolve(fakeStream().stream))
    const fb = fakeFallback([])
    const { scanner: sc, results } = scanner(fb.load)
    await sc.start()
    await vi.advanceTimersByTimeAsync(250)
    expect(results).toEqual(['SW1.native'])
    expect(fb.loads()).toBe(0)
    sc.stop()
  })

  it('uses the fallback when the BarcodeDetector refuses QR codes', async () => {
    installDom()
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        constructor() {
          throw new TypeError('unsupported format')
        }
      },
    )
    installCamera(() => Promise.resolve(fakeStream().stream))
    const fb = fakeFallback([[{ rawValue: 'SW1.fallback' }]])
    const { scanner: sc, results } = scanner(fb.load)
    await sc.start()
    await vi.advanceTimersByTimeAsync(250)
    expect(results).toEqual(['SW1.fallback'])
    sc.stop()
  })

  it('turns the camera off again when the decoder cannot be loaded', async () => {
    installDom()
    const { stream, tracks } = fakeStream()
    installCamera(() => Promise.resolve(stream))
    const { scanner: sc } = scanner(() => Promise.reject(new Error('offline')))
    await expect(sc.start()).rejects.toThrow(/cannot scan QR codes/)
    expect(tracks.every((t) => t.stopped)).toBe(true)
  })

  it('closes a decoder that finishes loading after stop()', async () => {
    installDom()
    const { stream, tracks } = fakeStream()
    installCamera(() => Promise.resolve(stream))
    const fb = fakeFallback([[{ rawValue: 'SW1.late' }]])
    let release: (d: CodeDetector) => void = () => undefined
    const { scanner: sc, results } = scanner(() => new Promise<CodeDetector>((r) => (release = r)))
    const started = sc.start()
    await vi.advanceTimersByTimeAsync(0)
    sc.stop()
    release(fb.detector)
    await started
    expect(fb.detector.closed).toBe(1)
    expect(tracks.every((t) => t.stopped)).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(results).toEqual([])
  })

  it('closes the decoder when the camera cannot be opened', async () => {
    installDom()
    installCamera(() => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })))
    const fb = fakeFallback([])
    const { scanner: sc } = scanner(fb.load)
    await expect(sc.start()).rejects.toThrow(/Camera access was blocked/)
    await vi.advanceTimersByTimeAsync(0)
    expect(fb.detector.closed).toBe(1)
  })
})
