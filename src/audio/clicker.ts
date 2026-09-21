/**
 * Geiger clicker: short Hann-windowed sine bursts on the shared AudioContext, scheduled with a
 * lookahead timer at random (shifted-exponential) intervals whose mean follows the click rate.
 * Scheduled click times are remembered so the engine can flag frames the clicks may have tainted.
 */
import type { Config } from '../config.ts'
import { CLICK_CURVE_POINTS, dbToGain, hannClickCurve, nextClickDelayS } from '../dsp/geiger.ts'

/** The oscillator runs this long past the gain curve, so the envelope is back at 0 before it stops. */
const STOP_TAIL_S = 0.002
/** How long scheduled click times are kept for clickedBetween(), in seconds. */
const HISTORY_S = 3
/** No click is scheduled closer than this to the context's current time, so it starts whole. */
const START_MARGIN_S = 0.01

interface Voice {
  /** Start time in AudioContext seconds. */
  readonly t: number
  readonly osc: OscillatorNode
  readonly gain: GainNode
}

/**
 * Plays Poisson-like clicks at a settable mean rate on a settable carrier. Silent while the rate
 * is 0, paused, muted, disposed or the context is not running; going silent also cancels clicks
 * already scheduled in the lookahead window, so muting is instant. Never throws on Web Audio errors.
 */
export class Clicker {
  private readonly ctx: AudioContext
  private readonly cfg: Config
  private readonly rng: () => number
  private readonly master: GainNode
  private readonly curve: Float32Array
  private readonly clickS: number
  private carrierHz: number | null
  private rateHz = 0
  private paused = false
  private muted = false
  private disposed = false
  /** Start time (context s) of the next click not yet handed to Web Audio; null = draw a fresh first delay. */
  private nextTime: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  /** Start times (context s) of scheduled clicks, oldest first, kept for HISTORY_S. */
  private readonly times: number[] = []
  /** Clicks whose nodes are still connected. */
  private readonly voices = new Set<Voice>()

  /**
   * Builds master gain -> destination. The carrier starts at the first entry of
   * cfg.clickCarriersHz; `rng` gives uniform draws in [0, 1) for the click intervals.
   */
  constructor(ctx: AudioContext, cfg: Config, rng: () => number = Math.random) {
    this.ctx = ctx
    this.cfg = cfg
    this.rng = rng
    this.clickS = cfg.clickMs / 1000
    // geiger.ts owns the point count (setValueCurveAtTime interpolates linearly between points).
    this.curve = hannClickCurve(CLICK_CURVE_POINTS, dbToGain(cfg.clickGainDb))
    this.carrierHz = cfg.clickCarriersHz[0] ?? null
    this.master = ctx.createGain()
    this.master.connect(ctx.destination)
  }

  /** Carrier frequency in Hz for clicks scheduled from now on (ignored unless finite and > 0). */
  setCarrier(hz: number): void {
    if (Number.isFinite(hz) && hz > 0) this.carrierHz = hz
    this.sync()
  }

  /**
   * Mean click rate in Hz; 0 (or anything not finite and positive) silences the clicker. Cheap to
   * call on every render. A new rate applies from the next drawn interval; the click already
   * drawn keeps its time (at most clickMaxGapS away).
   */
  setRate(hz: number): void {
    this.rateHz = Number.isFinite(hz) && hz > 0 ? hz : 0
    this.sync()
  }

  /** Pause for the hold window (or while a chirp is in progress). */
  setPaused(paused: boolean): void {
    this.paused = paused
    this.sync()
  }

  /** The user's Clicks toggle. */
  setMuted(muted: boolean): void {
    this.muted = muted
    this.sync()
  }

  /**
   * True if any scheduled click, sounding over [t, t + clickMs], overlaps [t0, t1]
   * (AudioContext seconds). Covers clicks scheduled within the last few seconds; cancelled clicks
   * (mute, pause, rate 0) are not counted.
   */
  clickedBetween(t0: number, t1: number): boolean {
    // times is sorted by start: scan from the newest and stop at the first click ending before t0.
    for (let i = this.times.length - 1; i >= 0; i--) {
      const t = this.times[i]!
      if (t + this.clickS < t0) return false
      if (t <= t1) return true
    }
    return false
  }

  /** Stop the scheduler, cut every click and disconnect from the destination. Final. */
  dispose(): void {
    this.disposed = true
    this.stopTimer()
    this.nextTime = null
    for (const v of this.voices) this.cancel(v)
    try {
      this.master.disconnect()
    } catch {
      // Already disconnected.
    }
  }

  private wanted(): boolean {
    return !this.disposed && this.carrierHz !== null && this.rateHz > 0 && !this.paused && !this.muted
  }

  /** Run the scheduler while clicks are wanted; otherwise stop it and cancel pending clicks. */
  private sync(): void {
    if (this.wanted()) {
      if (this.timer === null) {
        this.timer = setInterval(this.pump, this.cfg.clickSchedulerMs)
        this.pump()
      }
    } else {
      this.stopTimer()
      this.silence()
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Next inter-click delay in seconds, or null if the draw is unusable. */
  private draw(): number | null {
    const d = nextClickDelayS(this.rateHz, this.rng(), this.cfg)
    return Number.isFinite(d) && d > 0 ? d : null
  }

  /** Schedule every click due within the lookahead window. */
  private readonly pump = (): void => {
    if (!this.wanted() || this.ctx.state !== 'running') {
      this.silence()
      return
    }
    const now = this.ctx.currentTime
    const earliest = now + START_MARGIN_S
    if (this.nextTime === null) {
      const d = this.draw()
      if (d === null) return
      this.nextTime = Math.max(now + d, earliest)
    } else if (this.nextTime < earliest) {
      // The timer stalled past a due click: play one click soon instead of a burst of missed ones.
      this.nextTime = earliest
    }
    const horizon = now + this.cfg.clickLookaheadS
    while (this.nextTime !== null && this.nextTime < horizon) {
      this.scheduleClick(this.nextTime)
      const d = this.draw()
      this.nextTime = d === null ? null : this.nextTime + d
    }
    this.prune(now)
  }

  private scheduleClick(t: number): void {
    const carrier = this.carrierHz
    if (carrier === null) return
    let osc: OscillatorNode
    let gain: GainNode
    try {
      osc = this.ctx.createOscillator()
      gain = this.ctx.createGain()
    } catch {
      return
    }
    const voice: Voice = { t, osc, gain }
    try {
      osc.type = 'sine'
      osc.frequency.value = carrier
      gain.gain.setValueCurveAtTime(this.curve, t, this.clickS)
      osc.connect(gain)
      gain.connect(this.master)
      osc.onended = () => this.release(voice)
      osc.start(t)
      osc.stop(t + this.clickS + STOP_TAIL_S)
    } catch {
      this.release(voice)
      return
    }
    this.voices.add(voice)
    this.times.push(t)
  }

  /** Disconnect a click's nodes (after it ended, or to cut it). */
  private release(v: Voice): void {
    this.voices.delete(v)
    v.osc.onended = null
    try {
      v.osc.disconnect()
    } catch {
      // Not connected.
    }
    try {
      v.gain.disconnect()
    } catch {
      // Not connected.
    }
  }

  /**
   * Stop a click now (before its start time it then never sounds) and disconnect it. stop() takes
   * effect by time on the audio thread, independently of when the disconnect is applied.
   */
  private cancel(v: Voice): void {
    try {
      v.osc.stop()
    } catch {
      // Older engines throw on a second stop(); the disconnect still silences it.
    }
    this.release(v)
  }

  /** Forget the next click time and cut clicks that have not started yet. */
  private silence(): void {
    this.nextTime = null
    if (this.voices.size === 0) return
    const now = this.ctx.currentTime
    for (const v of this.voices) {
      if (v.t > now) {
        this.cancel(v)
        const i = this.times.lastIndexOf(v.t)
        if (i >= 0) this.times.splice(i, 1)
      }
    }
  }

  /** Drop click times that ended more than HISTORY_S ago. */
  private prune(now: number): void {
    let drop = 0
    while (drop < this.times.length && this.times[drop]! + this.clickS < now - HISTORY_S) drop++
    if (drop > 0) this.times.splice(0, drop)
  }
}
