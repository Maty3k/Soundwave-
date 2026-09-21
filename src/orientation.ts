/**
 * Compass heading of "forward" (the direction the user faces while holding the phone in front of
 * the chest) from the DeviceOrientation API. Used by the direction scan.
 *
 * - Chrome on Android: 'deviceorientationabsolute' (magnetometer, north-referenced); falls back
 *   to 'deviceorientation' (relative, fine for a short scan).
 * - Safari on iOS: 'deviceorientation' with webkitCompassHeading, after
 *   DeviceOrientationEvent.requestPermission() inside a user gesture.
 * - Laptops: the API exists but never delivers angles, so start() reports 'unavailable'.
 */
import type { Config } from './config.ts'

const RAD = Math.PI / 180

/**
 * Heading (degrees clockwise from the sensor's north) of the user's forward direction for a device
 * with W3C DeviceOrientation angles alpha (around z), beta (around x), gamma (around y).
 *
 * Forward is the horizontal part of (screen-top + device-back): the top edge points forward when
 * the phone lies flat, the back points forward when it is held upright, and both do in between.
 * screenAngleDeg is screen.orientation.angle (0 in portrait). Returns null when both vectors are
 * vertical (e.g. screen facing straight down).
 */
export function forwardHeadingDeg(alpha: number, beta: number, gamma: number, screenAngleDeg = 0): number | null {
  const ca = Math.cos(alpha * RAD)
  const sa = Math.sin(alpha * RAD)
  const cb = Math.cos(beta * RAD)
  const sb = Math.sin(beta * RAD)
  const cg = Math.cos(gamma * RAD)
  const sg = Math.sin(gamma * RAD)
  // World frame: x east, y north, z up. R = Rz(alpha) * Rx(beta) * Ry(gamma).
  // Screen "up" in device coordinates for the current screen rotation: (sin t, cos t, 0).
  const st = Math.sin(screenAngleDeg * RAD)
  const ct = Math.cos(screenAngleDeg * RAD)
  // R * (st, ct, 0)
  const ux = st * (ca * cg - sa * sb * sg) + ct * -sa * cb
  const uy = st * (sa * cg + ca * sb * sg) + ct * ca * cb
  // R * (0, 0, -1): the back of the device
  const bx = -ca * sg - sa * sb * cg
  const by = -sa * sg + ca * sb * cg
  const fx = ux + bx
  const fy = uy + by
  if (Math.hypot(fx, fy) < 1e-3) return null
  const deg = Math.atan2(fx, fy) / RAD
  return deg < 0 ? deg + 360 : deg
}

/** Circular moving average: moves `prev` toward `next` by `weight`, the short way round. */
export function circularEma(prev: number | null, next: number, weight: number): number {
  if (prev === null) return ((next % 360) + 360) % 360
  let d = (((next - prev) % 360) + 360) % 360
  if (d > 180) d -= 360
  const out = prev + weight * d
  return ((out % 360) + 360) % 360
}

/**
 * Weight of a new reading after dtMs for an exponential smoother with time constant tauMs:
 * 1 - exp(-dt / tau). Independent of the event rate (60 Hz on most phones, much lower on some).
 */
export function smoothingWeight(dtMs: number, tauMs: number): number {
  if (!(tauMs > 0) || !Number.isFinite(dtMs)) return 1
  return 1 - Math.exp(-Math.max(0, dtMs) / tauMs)
}

export type HeadingStatus = 'ok' | 'denied' | 'unavailable'

interface IosOrientationEvent extends DeviceOrientationEvent {
  readonly webkitCompassHeading?: number
}

interface OrientationPermissionApi {
  requestPermission?: () => Promise<'granted' | 'denied'>
}

/** True if this browser might deliver compass headings (a touch device with the API). */
export function headingMaybeSupported(): boolean {
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window && navigator.maxTouchPoints > 0
}

export class HeadingSource {
  private readonly cfg: Config
  private heading: number | null = null
  private lastMs: number | null = null
  private absoluteSeen = false
  private listening = false
  private readonly onAbsolute = (e: Event): void => this.handle(e as DeviceOrientationEvent, true)
  private readonly onRelative = (e: Event): void => this.handle(e as DeviceOrientationEvent, false)

  constructor(cfg: Config) {
    this.cfg = cfg
  }

  /** Smoothed heading in degrees, or null before the first reading. */
  get headingDeg(): number | null {
    return this.heading
  }

  /** Whether the heading is north-referenced (magnetometer) rather than relative. */
  get absolute(): boolean {
    return this.absoluteSeen
  }

  /**
   * Start listening. Call it synchronously from a click handler: on iOS the permission prompt
   * only appears inside a user gesture. Resolves 'unavailable' if no heading arrives in time.
   */
  start(): Promise<HeadingStatus> {
    if (!headingMaybeSupported()) return Promise.resolve('unavailable')
    const api = (window as unknown as { DeviceOrientationEvent: OrientationPermissionApi }).DeviceOrientationEvent
    const permission = typeof api.requestPermission === 'function' ? api.requestPermission() : Promise.resolve('granted' as const)
    return permission
      .catch(() => 'denied' as const)
      .then((p) => {
        if (p !== 'granted') return 'denied' as const
        this.listen()
        return this.waitForFirst()
      })
  }

  stop(): void {
    if (!this.listening) return
    window.removeEventListener('deviceorientationabsolute', this.onAbsolute)
    window.removeEventListener('deviceorientation', this.onRelative)
    this.listening = false
    this.heading = null
    this.lastMs = null
    this.absoluteSeen = false
  }

  private listen(): void {
    if (this.listening) return
    window.addEventListener('deviceorientationabsolute', this.onAbsolute)
    window.addEventListener('deviceorientation', this.onRelative)
    this.listening = true
  }

  private waitForFirst(): Promise<HeadingStatus> {
    return new Promise((resolve) => {
      const started = performance.now()
      const check = (): void => {
        if (this.heading !== null) resolve('ok')
        else if (!this.listening) resolve('unavailable')
        else if (performance.now() - started > this.cfg.headingTimeoutMs) {
          this.stop()
          resolve('unavailable')
        } else setTimeout(check, 100)
      }
      check()
    })
  }

  private handle(e: DeviceOrientationEvent, fromAbsoluteEvent: boolean): void {
    const ios = (e as IosOrientationEvent).webkitCompassHeading
    let h: number | null = null
    let absolute = false
    if (typeof ios === 'number' && Number.isFinite(ios)) {
      h = ios
      absolute = true
    } else if (e.alpha !== null && e.beta !== null && e.gamma !== null) {
      // Once absolute events arrive, ignore the relative stream (it has a different zero).
      if (!fromAbsoluteEvent && this.absoluteSeen) return
      h = forwardHeadingDeg(e.alpha, e.beta, e.gamma, screen.orientation?.angle ?? 0)
      absolute = fromAbsoluteEvent || e.absolute
    }
    if (h === null) return
    if (absolute && !this.absoluteSeen) {
      this.absoluteSeen = true
      this.heading = null // switch reference frame cleanly
    }
    const t = performance.now()
    const dt = this.lastMs === null ? Infinity : Math.max(0, t - this.lastMs)
    this.lastMs = t
    this.heading = circularEma(this.heading, h, smoothingWeight(dt, this.cfg.headingSmoothingMs))
  }
}
