import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG, withConfig } from './config.ts'
import { normalizeBand } from './band.ts'
import {
  createAudioContext,
  DEFAULT_SETTINGS,
  detectCapabilities,
  Haptics,
  loadSettings,
  onVisibilityChange,
  parseSettings,
  readQueryFlags,
  saveSettings,
  SETTINGS_KEY,
  WakeLockKeeper,
} from './platform.ts'

describe('readQueryFlags', () => {
  it('has no flags for an empty query', () => {
    expect(readQueryFlags('')).toEqual({ debug: false, forceWarmth: null })
    expect(readQueryFlags('?')).toEqual({ debug: false, forceWarmth: null })
  })

  it('turns debug on for ?debug with any value, with or without the leading ?', () => {
    for (const q of ['?debug', '?debug=', '?debug=1', '?debug=0', '?debug=false', 'debug', '?x=1&debug']) {
      expect(readQueryFlags(q).debug).toBe(true)
    }
    expect(readQueryFlags('?debugging=1').debug).toBe(false)
  })

  it('reads warmth in [0, 1] as given', () => {
    expect(readQueryFlags('?warmth=0').forceWarmth).toBe(0)
    expect(readQueryFlags('?warmth=0.5').forceWarmth).toBe(0.5)
    expect(readQueryFlags('?warmth=1').forceWarmth).toBe(1)
    expect(readQueryFlags('?warmth=1e-1').forceWarmth).toBeCloseTo(0.1, 12)
    expect(readQueryFlags('?warmth=%200.25%20').forceWarmth).toBe(0.25)
  })

  it('clamps warmth outside [0, 1]', () => {
    expect(readQueryFlags('?warmth=1.7').forceWarmth).toBe(1)
    expect(readQueryFlags('?warmth=-2').forceWarmth).toBe(0)
    expect(Object.is(readQueryFlags('?warmth=-0').forceWarmth, 0)).toBe(true)
  })

  it('ignores missing, empty and non-numeric warmth', () => {
    for (const q of ['?warmth', '?warmth=', '?warmth=%20', '?warmth=abc', '?warmth=NaN', '?warmth=Infinity', '?warmth=0.5x']) {
      expect(readQueryFlags(q).forceWarmth).toBeNull()
    }
  })

  it('reads both flags together and uses the first warmth value', () => {
    expect(readQueryFlags('?debug&warmth=0.75&warmth=0.1')).toEqual({ debug: true, forceWarmth: 0.75 })
  })
})

describe('parseSettings', () => {
  /** The default Listening range: the search band. */
  const BAND = CONFIG.searchBandHz

  it('returns the defaults for nothing stored', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS).toEqual({ clicks: true, haptics: true, bandHz: [1500, 12_000] })
    expect(DEFAULT_SETTINGS.bandHz).toEqual(BAND)
  })

  it('returns the defaults for garbage', () => {
    for (const raw of ['', ' ', '{', 'garbage', 'null', 'true', '42', '"clicks"', '[]', '[false, false]']) {
      expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('reads stored booleans', () => {
    expect(parseSettings('{"clicks":false,"haptics":false}')).toEqual({ clicks: false, haptics: false, bandHz: BAND })
    expect(parseSettings('{"clicks":true,"haptics":false}')).toEqual({ clicks: true, haptics: false, bandHz: BAND })
  })

  it('falls back per field for missing or non-boolean values', () => {
    expect(parseSettings('{"clicks":false}')).toEqual({ clicks: false, haptics: true, bandHz: BAND })
    expect(parseSettings('{"clicks":"no","haptics":0}')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('{"clicks":null,"haptics":false}')).toEqual({ clicks: true, haptics: false, bandHz: BAND })
  })

  it('drops unknown fields', () => {
    expect(parseSettings('{"clicks":false,"haptics":true,"volume":3}')).toStrictEqual({ clicks: false, haptics: true, bandHz: BAND })
  })

  it('reads a stored Listening range', () => {
    expect(parseSettings('{"clicks":true,"haptics":true,"bandHz":[8000,12000]}')).toEqual({ clicks: true, haptics: true, bandHz: [8000, 12_000] })
    expect(parseSettings('{"bandHz":[500,16000]}')).toEqual({ ...DEFAULT_SETTINGS, bandHz: [500, 16_000] })
    // Exactly the minimum span is fine.
    expect(parseSettings('{"bandHz":[3000,3500]}').bandHz).toEqual([3000, 3500])
  })

  it('rounds a stored Listening range to the slider step, like the reducer and the sliders do', () => {
    expect(parseSettings('{"bandHz":[9730,10730]}').bandHz).toEqual([9700, 10_700])
    expect(parseSettings('{"bandHz":[1549,12049]}').bandHz).toEqual([1500, 12_000])
    expect(parseSettings('{"bandHz":[1999.6,9000.4]}').bandHz).toEqual([2000, 9000])
    expect(parseSettings('{"bandHz":[499.6,16000.4]}').bandHz).toEqual([500, 16_000])
    // Rounding lands on the limit: fine.
    expect(parseSettings('{"bandHz":[499.4,9000]}').bandHz).toEqual([500, 9000])
    // What is stored ends up in the state exactly as the reducer would store it.
    for (const [lo, hi] of [[9730, 10_730], [1549, 12_049], [3001, 3549], [500.4, 15_999.6]] as const) {
      expect(parseSettings(JSON.stringify({ bandHz: [lo, hi] })).bandHz).toEqual(normalizeBand(lo, hi, CONFIG))
    }
    // The step comes from the config; a step of 0 means no rounding.
    expect(parseSettings('{"bandHz":[9730,10730]}', withConfig({ bandStepHz: 1000 })).bandHz).toEqual([10_000, 11_000])
    expect(parseSettings('{"bandHz":[9730,10730]}', withConfig({ bandStepHz: 0 })).bandHz).toEqual([9730, 10_730])
  })

  it('falls back to the default Listening range for a missing or broken one, keeping the other fields', () => {
    const broken = [
      '{"clicks":false}',
      '{"clicks":false,"bandHz":null}',
      '{"clicks":false,"bandHz":"1500-12000"}',
      '{"clicks":false,"bandHz":{"lo":1500,"hi":12000}}',
      '{"clicks":false,"bandHz":[]}',
      '{"clicks":false,"bandHz":[3000]}',
      '{"clicks":false,"bandHz":[3000,9000,12000]}',
      '{"clicks":false,"bandHz":["3000",9000]}',
      '{"clicks":false,"bandHz":["3000","9000"]}',
      '{"clicks":false,"bandHz":[3000,null]}',
      '{"clicks":false,"bandHz":[null,9000]}',
      '{"clicks":false,"bandHz":[3000,true]}',
      // JSON.parse reads 1e999 as Infinity.
      '{"clicks":false,"bandHz":[3000,1e999]}',
      '{"clicks":false,"bandHz":[-1e999,9000]}',
    ]
    for (const raw of broken) expect(parseSettings(raw), raw).toEqual({ clicks: false, haptics: true, bandHz: BAND })
  })

  it('falls back to the default Listening range for one that is too narrow, reversed or out of range', () => {
    const [min, max] = CONFIG.bandLimitsHz
    const span = CONFIG.bandMinSpanHz
    const step = CONFIG.bandStepHz
    const bad: (readonly [number, number])[] = [
      [3000, 3000 + span - step],
      [3000, 3000 + span - step / 2 - 1],
      [3000, 3000],
      [9000, 2000],
      [min - step, 9000],
      [min - step / 2 - 1, 9000],
      [3000, max + step],
      [3000, max + step / 2 + 1],
      [0, 20_000],
      [-3000, 3000],
    ]
    for (const band of bad) {
      expect(parseSettings(JSON.stringify({ bandHz: band })).bandHz, JSON.stringify(band)).toEqual(BAND)
    }
  })

  it('checks the Listening range against the config it is given', () => {
    const cfg = withConfig({ bandLimitsHz: [1000, 5000], bandMinSpanHz: 1000 })
    expect(parseSettings('{"bandHz":[2000,4000]}', cfg).bandHz).toEqual([2000, 4000])
    expect(parseSettings('{"bandHz":[2000,2500]}', cfg).bandHz).toEqual(BAND)
    expect(parseSettings('{"bandHz":[8000,12000]}', cfg).bandHz).toEqual(BAND)
  })

  it('round-trips its own JSON', () => {
    for (const s of [
      { clicks: true, haptics: true, bandHz: [1500, 12_000] },
      { clicks: false, haptics: true, bandHz: [1500, 12_000] },
      { clicks: true, haptics: false, bandHz: [8000, 12_000] },
      { clicks: false, haptics: false, bandHz: [500, 16_000] },
    ]) {
      expect(parseSettings(JSON.stringify(s))).toEqual(s)
    }
  })

  it('returns a fresh object each time', () => {
    const a = parseSettings(null)
    expect(a).not.toBe(DEFAULT_SETTINGS)
    expect(a).not.toBe(parseSettings(null))
  })
})

// ---- Browser wrappers with stubbed globals --------------------------------------------------------

/**
 * Manual timers and clock. Timers run only inside advance(), in due order; block() lets time pass
 * with no timer running (a busy main thread). Replaces setTimeout / setInterval and performance.
 */
class ManualClock {
  now = 0
  private seq = 0
  private readonly timers = new Map<number, { due: number; fn: () => void; every: number | null }>()

  install(): void {
    vi.stubGlobal('setTimeout', (fn: () => void, ms = 0) => this.add(fn, ms, null))
    vi.stubGlobal('clearTimeout', (id: number) => this.timers.delete(id))
    vi.stubGlobal('setInterval', (fn: () => void, ms = 0) => this.add(fn, ms, ms))
    vi.stubGlobal('clearInterval', (id: number) => this.timers.delete(id))
    vi.stubGlobal('performance', { now: () => this.now })
  }

  get pending(): number {
    return this.timers.size
  }

  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      let id = -1
      let due = Number.POSITIVE_INFINITY
      for (const [k, t] of this.timers) if (t.due <= end && t.due < due) [id, due] = [k, t.due]
      const t = this.timers.get(id)
      if (t === undefined) break
      this.now = Math.max(this.now, t.due)
      if (t.every === null) this.timers.delete(id)
      else t.due = this.now + Math.max(1, t.every)
      t.fn()
    }
    this.now = end
  }

  block(ms: number): void {
    this.now += ms
  }

  private add(fn: () => void, ms: number, every: number | null): number {
    const id = ++this.seq
    this.timers.set(id, { due: this.now + Math.max(0, ms), fn, every })
    return id
  }
}

/** document stand-in: visibilityState plus real visibilitychange events. */
class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible'
  listeners = 0

  override addEventListener(type: string, cb: EventListenerOrEventListenerObject | null): void {
    this.listeners++
    super.addEventListener(type, cb)
  }

  override removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null): void {
    this.listeners--
    super.removeEventListener(type, cb)
  }

  setVisible(visible: boolean): void {
    this.visibilityState = visible ? 'visible' : 'hidden'
    this.dispatchEvent(new Event('visibilitychange'))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('detectCapabilities', () => {
  it('reports everything missing outside a browser without throwing', () => {
    vi.stubGlobal('navigator', undefined)
    vi.stubGlobal('isSecureContext', undefined)
    vi.stubGlobal('AudioContext', undefined)
    expect(detectCapabilities()).toEqual({
      secureContext: false,
      getUserMedia: false,
      audioContext: false,
      wakeLock: false,
      haptics: false,
      compass: false,
    })
  })

  it('reads each capability from the browser globals', () => {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('AudioContext', class {})
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => Promise.reject(new Error('unused')) },
      wakeLock: {},
      vibrate: () => true,
      maxTouchPoints: 5,
    })
    vi.stubGlobal('window', { DeviceOrientationEvent: class {} })
    expect(detectCapabilities()).toEqual({
      secureContext: true,
      getUserMedia: true,
      audioContext: true,
      wakeLock: true,
      haptics: true,
      compass: true,
    })
  })

  it('offers the compass only on a touch device with the DeviceOrientation API', () => {
    vi.stubGlobal('window', { DeviceOrientationEvent: class {} })
    vi.stubGlobal('navigator', { maxTouchPoints: 0 })
    expect(detectCapabilities().compass).toBe(false) // desktop: the API exists but never fires
    vi.stubGlobal('navigator', { maxTouchPoints: 5 })
    expect(detectCapabilities().compass).toBe(true)
    vi.stubGlobal('window', {})
    expect(detectCapabilities().compass).toBe(false)
  })

  it('needs a touch screen for haptics and accepts the legacy webkitAudioContext', () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', class {})
    vi.stubGlobal('navigator', { vibrate: () => true, maxTouchPoints: 0 })
    const caps = detectCapabilities()
    expect(caps.haptics).toBe(false)
    expect(caps.audioContext).toBe(true)
    expect(caps.getUserMedia).toBe(false)
  })
})

describe('createAudioContext', () => {
  class Recorder {
    static calls: unknown[][] = []
    constructor(...args: unknown[]) {
      Recorder.calls.push(args)
    }
  }

  beforeEach(() => {
    Recorder.calls = []
  })

  it('creates an AudioContext without options (never forces a sample rate)', () => {
    vi.stubGlobal('AudioContext', Recorder)
    expect(createAudioContext()).toBeInstanceOf(Recorder)
    expect(Recorder.calls).toEqual([[]])
  })

  it('falls back to webkitAudioContext and throws only when Web Audio is missing', () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', Recorder)
    expect(createAudioContext()).toBeInstanceOf(Recorder)
    vi.stubGlobal('webkitAudioContext', undefined)
    expect(() => createAudioContext()).toThrow()
  })
})

describe('loadSettings / saveSettings', () => {
  it('round-trips through localStorage under SETTINGS_KEY', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    saveSettings({ clicks: false, haptics: true, bandHz: [8000, 12_000] })
    expect(JSON.parse(store.get(SETTINGS_KEY)!)).toEqual({ clicks: false, haptics: true, bandHz: [8000, 12_000] })
    expect(loadSettings()).toEqual({ clicks: false, haptics: true, bandHz: [8000, 12_000] })
    saveSettings(DEFAULT_SETTINGS)
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to the defaults and never throws when storage is missing or blocked', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    expect(() => saveSettings({ clicks: false, haptics: false, bandHz: [1500, 12_000] })).not.toThrow()
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError')
      },
    })
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    expect(() => saveSettings({ clicks: false, haptics: false, bandHz: [1500, 12_000] })).not.toThrow()
  })
})

describe('onVisibilityChange', () => {
  it('reports each change until unsubscribed', () => {
    const doc = new FakeDocument()
    vi.stubGlobal('document', doc)
    const seen: boolean[] = []
    const off = onVisibilityChange((v) => seen.push(v))
    doc.setVisible(false)
    doc.setVisible(true)
    off()
    doc.setVisible(false)
    expect(seen).toEqual([false, true])
    expect(doc.listeners).toBe(0)
  })

  it('is a no-op without a document', () => {
    vi.stubGlobal('document', undefined)
    expect(() => onVisibilityChange(() => undefined)()).not.toThrow()
  })
})

// ---- WakeLockKeeper ---------------------------------------------------------------------------------

class FakeSentinel extends EventTarget {
  released = false
  release(): Promise<void> {
    if (!this.released) {
      this.released = true
      this.dispatchEvent(new Event('release'))
    }
    return Promise.resolve()
  }
}

/** navigator.wakeLock stand-in; 'manual' requests wait until settle() is called. */
class FakeWakeLock {
  mode: 'grant' | 'reject' | 'manual' = 'grant'
  rejectName = 'NotAllowedError'
  readonly types: string[] = []
  readonly sentinels: FakeSentinel[] = []
  private readonly waiting: Array<{ ok: (s: FakeSentinel) => void; fail: (e: unknown) => void }> = []

  request(type: string): Promise<FakeSentinel> {
    this.types.push(type)
    if (this.mode === 'grant') return Promise.resolve(this.grant())
    if (this.mode === 'reject') return Promise.reject(new DOMException('no', this.rejectName))
    return new Promise((ok, fail) => this.waiting.push({ ok, fail }))
  }

  /** Settle the oldest waiting request: grant it, or reject it with an error of this name. */
  settle(rejectWith: string | null = null): void {
    const w = this.waiting.shift()
    if (w === undefined) throw new Error('no waiting request')
    if (rejectWith === null) w.ok(this.grant())
    else w.fail(new DOMException('no', rejectWith))
  }

  private grant(): FakeSentinel {
    const s = new FakeSentinel()
    this.sentinels.push(s)
    return s
  }
}

/** Let pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('WakeLockKeeper', () => {
  let doc: FakeDocument
  let wl: FakeWakeLock
  let failures: number
  let keeper: WakeLockKeeper

  beforeEach(() => {
    doc = new FakeDocument()
    wl = new FakeWakeLock()
    failures = 0
    vi.stubGlobal('document', doc)
    vi.stubGlobal('navigator', { wakeLock: wl })
    keeper = new WakeLockKeeper(() => failures++)
  })

  it('requests a screen lock while visible and releases it on disable', async () => {
    await keeper.enable()
    expect(wl.types).toEqual(['screen'])
    expect(wl.sentinels[0]!.released).toBe(false)
    await keeper.enable() // already held: no second request
    expect(wl.types).toHaveLength(1)
    keeper.disable()
    expect(wl.sentinels[0]!.released).toBe(true)
    expect(doc.listeners).toBe(0)
    doc.setVisible(false)
    doc.setVisible(true)
    await flush()
    expect(wl.types).toHaveLength(1)
    expect(failures).toBe(0)
  })

  it('waits for the page to be visible before requesting', async () => {
    doc.visibilityState = 'hidden'
    await keeper.enable()
    expect(wl.types).toHaveLength(0)
    doc.setVisible(true)
    await flush()
    expect(wl.types).toHaveLength(1)
  })

  it('re-requests after a release while visible, and after a release while hidden once visible again', async () => {
    await keeper.enable()
    wl.sentinels[0]!.release() // the browser dropped the lock while visible
    await flush()
    expect(wl.types).toHaveLength(2)
    doc.setVisible(false)
    wl.sentinels[1]!.release() // released because the page is hidden: expected, no request
    await flush()
    expect(wl.types).toHaveLength(2)
    doc.setVisible(true)
    await flush()
    expect(wl.types).toHaveLength(3)
    expect(wl.sentinels[2]!.released).toBe(false)
    expect(failures).toBe(0)
  })

  it('ignores a rejection for a request the page was hidden during, and retries once visible', async () => {
    wl.mode = 'manual'
    const first = keeper.enable()
    doc.setVisible(false)
    doc.setVisible(true) // back while the first request is still pending
    wl.settle('NotAllowedError') // rejected because the page was hidden meanwhile
    await first
    await flush()
    expect(failures).toBe(0)
    expect(wl.types).toHaveLength(2)
    wl.settle()
    await flush()
    expect(wl.sentinels).toHaveLength(1)
    expect(wl.sentinels[0]!.released).toBe(false)
  })

  it('ignores a rejection that arrives while hidden', async () => {
    wl.mode = 'manual'
    const first = keeper.enable()
    doc.setVisible(false)
    wl.settle('NotAllowedError')
    await first
    expect(failures).toBe(0)
  })

  it('reports NotAllowedError while visible once, and other errors not at all', async () => {
    wl.mode = 'reject'
    await keeper.enable()
    expect(failures).toBe(1)
    doc.setVisible(false)
    doc.setVisible(true)
    await flush()
    expect(wl.types).toHaveLength(2)
    expect(failures).toBe(1)

    const other = new WakeLockKeeper(() => failures++)
    wl.rejectName = 'AbortError'
    await other.enable()
    expect(failures).toBe(1)
  })

  it('reports a missing Wake Lock API once and never throws', async () => {
    vi.stubGlobal('navigator', {})
    await expect(keeper.enable()).resolves.toBeUndefined()
    doc.setVisible(false)
    doc.setVisible(true)
    await flush()
    expect(failures).toBe(1)
  })

  it('releases a lock granted after disable()', async () => {
    wl.mode = 'manual'
    const first = keeper.enable()
    keeper.disable()
    wl.settle()
    await first
    expect(wl.sentinels[0]!.released).toBe(true)
  })
})

// ---- Haptics ----------------------------------------------------------------------------------------

describe('Haptics', () => {
  let clock: ManualClock
  /** [time ms, pattern] of every navigator.vibrate call; pattern 0 = cancel. */
  let calls: Array<[number, number | number[]]>
  const period = CONFIG.hapticPeriodMs
  const sortedTiers = [...CONFIG.hapticTiers].sort((a, b) => a.minWarmth - b.minWarmth)
  const low = sortedTiers[0]!.pattern
  const mid = sortedTiers[1]!.pattern
  const high = sortedTiers[sortedTiers.length - 1]!.pattern
  const pulsePattern = CONFIG.hapticReadingPattern
  const lengthMs = (p: readonly number[]): number => p.reduce((a, b) => a + b, 0)
  const patterns = (): Array<number | number[]> => calls.map(([, p]) => p)

  beforeEach(() => {
    clock = new ManualClock()
    clock.install()
    clock.now = 1000
    calls = []
    vi.stubGlobal('navigator', {
      maxTouchPoints: 5,
      vibrate: (p: number | number[]) => {
        calls.push([clock.now, p])
        return true
      },
    })
  })

  it('uses tiers of different lengths from the config (fixture check)', () => {
    expect(lengthMs(mid)).toBeGreaterThan(lengthMs(low))
    expect(lengthMs(high)).toBeLessThanOrEqual(period)
    expect(lengthMs(pulsePattern)).toBeLessThan(period)
  })

  it('never vibrates before unlock(), while disabled or without navigator.vibrate', () => {
    const h = new Haptics(CONFIG)
    h.setTier(mid)
    h.pulse(pulsePattern)
    clock.advance(3 * period)
    expect(calls).toEqual([])

    h.setEnabled(false)
    h.unlock()
    h.pulse(pulsePattern)
    clock.advance(3 * period)
    expect(calls).toEqual([])

    vi.stubGlobal('navigator', { maxTouchPoints: 5 })
    const bare = new Haptics(CONFIG)
    bare.unlock()
    expect(() => {
      bare.setTier(mid)
      bare.pulse(pulsePattern)
      bare.stop()
    }).not.toThrow()
  })

  it('issues a tier at once, repeats it every hapticPeriodMs, and ignores equal patterns', () => {
    const h = new Haptics(CONFIG)
    h.unlock()
    h.setTier(mid)
    expect(calls).toEqual([[1000, [...mid]]])
    for (let t = 0; t < 5 * period; t += 16) {
      h.setTier([...mid]) // a render passing an equal copy changes nothing
      clock.advance(16)
    }
    const times = calls.map(([t]) => t)
    expect(patterns().every((p) => Array.isArray(p) && p.join() === mid.join())).toBe(true)
    expect(times).toEqual([0, 1, 2, 3, 4, 5].map((k) => 1000 + k * period))
    expect(clock.pending).toBe(1)
  })

  it('starts a changed tier when the playing pattern has finished, so flicker cannot restart it', () => {
    const h = new Haptics(CONFIG)
    h.unlock()
    h.setTier(mid)
    clock.advance(10)
    h.setTier(high) // escalation while mid is still playing
    expect(calls).toHaveLength(1)
    clock.advance(lengthMs(mid))
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual([1000 + lengthMs(mid), [...high]])

    // Warmth flickering across a tier boundary at render rate for 5 s.
    for (let t = 0; t < 5 * period; t += 16) {
      h.setTier(t % 32 === 0 ? low : mid)
      clock.advance(16)
    }
    expect(calls.length).toBeGreaterThan(4)
    for (let i = 1; i < calls.length; i++) {
      const [t0, p0] = calls[i - 1]!
      const [t1] = calls[i]!
      // No pattern is cut short by the next one.
      expect(t1 - t0).toBeGreaterThanOrEqual(lengthMs(p0 as number[]))
    }
  })

  it('issues a tier flickering with null at most once per period', () => {
    const h = new Haptics(CONFIG)
    h.unlock()
    const durationMs = 3 * period
    for (let t = 0; t < durationMs; t += 16) {
      h.setTier(t % 32 === 0 ? low : null)
      clock.advance(16)
    }
    const issued = calls.filter(([, p]) => p !== 0)
    expect(issued.length).toBeGreaterThan(0)
    expect(issued.length).toBeLessThanOrEqual(Math.floor(durationMs / period) + 1)
  })

  it('cuts a playing tier with one vibrate(0) on setTier(null), and nothing when nothing plays', () => {
    const h = new Haptics(CONFIG)
    h.unlock()
    h.setTier(mid)
    clock.advance(10)
    h.setTier(null)
    h.setTier(null)
    expect(patterns()).toEqual([[...mid], 0])
    expect(clock.pending).toBe(0)

    // A different tier right after the cut waits until the cut pattern would have ended.
    calls = []
    h.setTier(low)
    clock.advance(2 * period)
    expect(calls[0]).toEqual([1000 + lengthMs(mid), [...low]])
    clock.advance(lengthMs(low) + 1)
    h.setTier(null) // low has finished: nothing to cut
    expect(patterns().filter((p) => p === 0)).toEqual([])
  })

  it('plays a pulse at once and holds the tier off until the pulse has finished', () => {
    const h = new Haptics(CONFIG)
    h.unlock()
    h.setTier(mid)
    clock.advance(100)
    h.pulse(pulsePattern)
    expect(calls[1]).toEqual([1100, [...pulsePattern]])
    clock.advance(lengthMs(pulsePattern) - 1)
    expect(calls).toHaveLength(2)
    clock.advance(1)
    expect(calls[2]).toEqual([1100 + lengthMs(pulsePattern), [...mid]])
    clock.advance(period)
    expect(calls[3]).toEqual([1100 + lengthMs(pulsePattern) + period, [...mid]])
  })

  it('does not let setTier(null) cut a pulse, but stop() and disabling do', () => {
    const h = new Haptics(CONFIG)
    h.unlock()
    h.pulse(pulsePattern)
    h.setTier(null)
    expect(patterns()).toEqual([[...pulsePattern]])
    h.stop()
    expect(patterns()).toEqual([[...pulsePattern], 0])

    calls = []
    h.setTier(mid)
    h.setEnabled(false)
    expect(patterns()).toEqual([[...mid], 0])
    clock.advance(3 * period)
    expect(calls).toHaveLength(2)
    h.setEnabled(true) // resumes the current tier at once
    expect(patterns()).toEqual([[...mid], 0, [...mid]])
  })

  it('survives navigator.vibrate throwing', () => {
    vi.stubGlobal('navigator', {
      maxTouchPoints: 5,
      vibrate: () => {
        throw new Error('blocked')
      },
    })
    const h = new Haptics(CONFIG)
    h.unlock()
    expect(() => {
      h.setTier(mid)
      h.pulse(pulsePattern)
      clock.advance(3 * period)
      h.stop()
    }).not.toThrow()
  })
})
