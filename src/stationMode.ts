/**
 * A device used as a listening station for another device's hunt (the hub). The station pairs
 * with the hub by scanning or pasting the hub's offer code and showing its own answer code, then
 * measures at the frequency the hub locked on and sends only numbers over the WebRTC data channel:
 * each chirp's onset time (station clock), level, SNR and clipping, and in live mode its held level.
 * Audio never leaves the device. Clock offsets are the hub's business: the station just answers
 * pings with its own time.
 *
 * Also home of LockFollower, the measurement shared with the extra microphones (src/extraMics.ts):
 * a hunt at a lock set by someone else, with the live-level throttle.
 *
 * No DOM or Web Audio here; WebRTC is reached only through src/net/peer.ts.
 */
import type { Config } from './config.ts'
import type { Frame, LockMode, RawAudioStatus, Reading, StationModeView, StationStep } from './types.ts'
import { createHunt, huntStep } from './dsp/hunt.ts'
import type { HuntState } from './dsp/hunt.ts'
import { answerOffer } from './net/peer.ts'
import type { Answer, LinkState, PeerLink } from './net/peer.ts'
import { parseHubMessage, PROTOCOL_VERSION } from './net/protocol.ts'
import type { HubMessage, StationMessage } from './net/protocol.ts'

// ---- LockFollower ------------------------------------------------------------------------------

/** Frequency and mode another component locked on. */
export interface FollowedLock {
  readonly f0Hz: number
  readonly mode: LockMode
}

/**
 * Runs a hunt at a lock chosen elsewhere (the hub's lock, or this device's own lock for an extra
 * mic). The hunt is created on the first frame after the lock was set (reason 'manual', no chirps,
 * in the lock's mode) and recreated only when the frequency moves outside the lock tolerance. A
 * small drift (the hub's frequency estimate settling) is followed in place, and so is a mode
 * switch: the hunt's own classifier follows the same sound, and recreating it would lose the held
 * level and move a live train's start away from the one the hub measures.
 *
 * Live levels follow the lock's mode, not the hunt's: while the lock is 'live' the held level (max
 * band level over config.liveHoldMs) is reported every config.stationLevelReportMs, also when this
 * listener hears nothing (it then reports its noise level, which is the answer), and never while
 * the lock is 'chirp'. A live train in which no chirp segment ever opened is not reported as a
 * reading: a hunt started in live mode that never hears the tone would otherwise turn its noise
 * into a train reading.
 */
export class LockFollower {
  private readonly cfg: Config
  private lock: FollowedLock | null = null
  private hunt: HuntState | null = null
  private lastLiveMs: number | null = null
  /** A chirp segment opened since the hunt started or since its last reading. */
  private heard = false

  constructor(cfg: Config) {
    this.cfg = cfg
  }

  /** The lock being followed, or null. */
  get current(): FollowedLock | null {
    return this.lock
  }

  /** Band SNR (dB) of the latest frame at the lock; 0 without a lock. */
  get snrDb(): number {
    return this.hunt?.snrDb ?? 0
  }

  /**
   * Follow a new lock (null stops measuring). Returns true when anything changed. A frequency
   * outside cfg.lockTolPct of the previous one starts a fresh hunt; anything else keeps it.
   */
  setLock(lock: FollowedLock | null): boolean {
    const prev = this.lock
    if (lock === null || !Number.isFinite(lock.f0Hz) || lock.f0Hz <= 0) {
      this.lock = null
      this.hunt = null
      this.lastLiveMs = null
      this.heard = false
      return prev !== null
    }
    if (prev !== null && prev.f0Hz === lock.f0Hz && prev.mode === lock.mode) return false
    this.lock = { f0Hz: lock.f0Hz, mode: lock.mode }
    const near = prev !== null && Math.abs(lock.f0Hz - prev.f0Hz) <= (prev.f0Hz * this.cfg.lockTolPct) / 100
    if (near && this.hunt !== null) {
      this.hunt.f0Hz = lock.f0Hz
    } else {
      this.hunt = null
      this.heard = false
    }
    if (lock.mode !== 'live') this.lastLiveMs = null
    return true
  }

  /**
   * Measure one frame. onReading gets every new ('updated' false) or merged ('updated' true)
   * reading; while the lock is 'live' onLive gets the held level (dB, clipped, frame time) at most
   * every cfg.stationLevelReportMs. Does nothing without a lock.
   */
  step(
    frame: Frame,
    onReading: (reading: Reading, updated: boolean) => void,
    onLive: (levelDb: number, clipped: boolean, atMs: number) => void,
  ): void {
    const lock = this.lock
    if (lock === null) return
    const cfg = this.cfg
    let hunt = this.hunt
    if (hunt === null) {
      hunt = createHunt({ f0Hz: lock.f0Hz, mode: lock.mode, reason: 'manual', tMs: frame.tMs, snrDb: 0, chirps: [] }, cfg)
      this.hunt = hunt
      this.heard = false
    }
    for (const ev of huntStep(hunt, frame, cfg)) {
      if (ev.type === 'onset') {
        this.heard = true
      } else if (ev.type === 'reading' || ev.type === 'readingUpdated') {
        const heard = this.heard
        this.heard = false
        if (ev.reading.source === 'train' && !heard) continue
        onReading(ev.reading, ev.type === 'readingUpdated')
      }
    }
    if (lock.mode !== 'live') {
      this.lastLiveMs = null
      return
    }
    if (this.lastLiveMs !== null && frame.tMs - this.lastLiveMs < cfg.stationLevelReportMs) return
    // The hunt keeps the frames of the last liveHoldMs in every mode (its live max-hold input).
    let heldDb = -Infinity
    let clipped = false
    for (const e of hunt.holdFrames) {
      if (e.levelDb > heldDb) heldDb = e.levelDb
      if (e.clipped) clipped = true
    }
    if (!(heldDb > cfg.silentDb)) return
    this.lastLiveMs = frame.tMs
    onLive(heldDb, clipped, frame.tMs)
  }
}

// ---- Station runtime ---------------------------------------------------------------------------

/** Injectable answerOffer (tests); the app uses src/net/peer.ts. */
export type AnswerOfferFn = (offerCode: string) => Promise<Answer>

export interface StationDeps {
  readonly cfg: Config
  /** Millisecond clock; must be the clock of the frames' tMs (performance.now() in the app). */
  readonly now: () => number
  /** Called after anything the station screen shows has changed. */
  readonly onChange: () => void
  /** Test seam: replaces peer.answerOffer. */
  readonly answerOffer?: AnswerOfferFn
}

/** Longest station name sent to the hub. */
export const STATION_NAME_MAX = 24
const DEFAULT_NAME = 'Station'
/** The level bar changes every frame; onChange for it is sent at most this often. */
const LEVEL_CHANGE_MS = 100
/** Band SNR (dB) that fills the level bar. */
const LEVEL_FULL_SNR_DB = 40

/** Control, line / paragraph separator and bidi control code points (protocol.cleanName rejects them). */
function unshowable(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  )
}

/**
 * A device name as sent and shown: unshowable characters become spaces, whitespace runs collapse,
 * trimmed, at most STATION_NAME_MAX code points; `fallback` ('Station') when nothing is left.
 */
export function cleanStationName(name: string, fallback: string = DEFAULT_NAME): string {
  const shown = [...name].map((ch) => (unshowable(ch.codePointAt(0) ?? 0) ? ' ' : ch)).join('')
  const s = [...shown.replace(/\s+/g, ' ').trim()].slice(0, STATION_NAME_MAX).join('').trim()
  return s === '' ? fallback : s
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message !== '') return err.message
  if (typeof err === 'string' && err !== '') return err
  return fallback
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** Release an answer's connection; never throws. */
function cancelAnswer(answer: Answer): void {
  try {
    answer.cancel()
  } catch {
    // Already released.
  }
}

/**
 * Station side state machine: name -> starting (main opens the mic) -> scanOffer / pasteOffer ->
 * answering -> showAnswer -> connected, with lost / error at the end. Frames go to onFrame.
 */
export class StationRuntime {
  private readonly deps: StationDeps
  private readonly follower: LockFollower
  private step: StationStep = 'name'
  private name = DEFAULT_NAME
  private answerCode: string | null = null
  private message: string | null = null
  private rawAudio: RawAudioStatus = 'unknown'
  private link: PeerLink | null = null
  private hub: string | null = null
  private calibrating = false
  /** Increments on every pairing attempt and when one is abandoned; stale async results are discarded. */
  private seq = 0
  /** The answer code being shown, until its link opens (cancelled when the attempt is abandoned). */
  private pending: Answer | null = null
  private disposed = false
  private level = 0
  private lastChirpDb: number | null = null
  private lastChirpAtMs: number | null = null
  private chirpsSent = 0
  private lastLevelChangeMs: number | null = null
  /** The level when onChange was last called (the screen shows at least that recent a value). */
  private announcedLevel = 0

  constructor(deps: StationDeps) {
    this.deps = deps
    this.follower = new LockFollower(deps.cfg)
  }

  /** Name of the hub that paired with this station (from its hello), or null. */
  get hubName(): string | null {
    return this.hub
  }

  /** The hub asked the stations to take part in a level calibration. */
  get calibrationRequested(): boolean {
    return this.calibrating
  }

  /** Set the name shown on the hub (trimmed, max 24 characters, default 'Station'); 'name' -> 'starting'. */
  setName(name: string): void {
    if (this.disposed) return
    this.name = cleanStationName(name)
    if (this.step === 'name') this.step = 'starting'
    if (this.link !== null && this.link.state === 'open') this.sendHi()
    this.changed()
  }

  /** The mic is open: show the offer scanner (canScan) or the paste box. Only from 'name' / 'starting'. */
  micReady(canScan: boolean): void {
    if (this.disposed || (this.step !== 'name' && this.step !== 'starting')) return
    this.step = canScan ? 'scanOffer' : 'pasteOffer'
    this.message = null
    this.changed()
  }

  /**
   * Switch between scanning and pasting the hub's offer. From answering / showAnswer / error /
   * lost (or even connected) this starts over: the pending pairing attempt is abandoned (its
   * connection released at once) and an open link gets a bye.
   */
  setStep(step: 'scanOffer' | 'pasteOffer'): void {
    if (this.disposed || this.step === 'name' || this.step === 'starting') return
    if (this.step !== 'scanOffer' && this.step !== 'pasteOffer') {
      this.abandonAttempt()
      this.dropLink(true)
    }
    this.step = step
    this.answerCode = null
    this.message = null
    this.changed()
  }

  /**
   * Answer the hub's offer code: 'answering' -> 'showAnswer' (the hub scans or pastes the answer
   * code) -> 'connected' once the data channel opens. Errors -> 'error' with a message. A pairing
   * attempt still waiting for the hub is abandoned first.
   */
  async acceptOffer(code: string): Promise<void> {
    if (this.disposed) return
    this.abandonAttempt()
    this.dropLink(true)
    const seq = this.seq
    this.step = 'answering'
    this.answerCode = null
    this.message = null
    this.changed()
    let answer: Answer
    try {
      const fn = this.deps.answerOffer ?? ((offer: string) => answerOffer(offer, this.deps.cfg))
      answer = await fn(code.trim())
    } catch (err) {
      if (seq === this.seq && !this.disposed) this.fail(errorText(err, 'This code did not work.'))
      return
    }
    if (seq !== this.seq || this.disposed) {
      cancelAnswer(answer)
      answer.link.then((l) => l.close()).catch(() => undefined)
      return
    }
    this.pending = answer
    this.step = 'showAnswer'
    this.answerCode = answer.code
    this.changed()
    let link: PeerLink
    try {
      link = await answer.link
    } catch (err) {
      if (seq === this.seq && !this.disposed) this.fail(errorText(err, 'The connection failed.'))
      return
    }
    if (seq !== this.seq || this.disposed) {
      link.close()
      return
    }
    this.pending = null
    this.attach(link)
  }

  /** Raw-audio status of this device's mic, reported to the hub in 'hi'. */
  setRawAudio(status: RawAudioStatus): void {
    if (status === this.rawAudio) return
    this.rawAudio = status
    if (this.link !== null && this.link.state === 'open') this.sendHi()
  }

  /** Measure one frame at the hub's lock and report chirps (and live levels) to the hub. */
  onFrame(frame: Frame): void {
    if (this.disposed) return
    let discrete = false
    this.follower.step(
      frame,
      (reading, updated) => {
        const sent = this.send({
          t: 'chirp',
          onsetMs: reading.tMs,
          levelDb: reading.levelDb,
          snrDb: reading.snrDb,
          clipped: reading.clipped,
        })
        this.lastChirpDb = reading.levelDb
        this.lastChirpAtMs = reading.tMs
        if (sent && !updated) this.chirpsSent++
        discrete = true
      },
      (levelDb, clipped, atMs) => {
        this.send({ t: 'level', levelDb, atMs, clipped })
      },
    )
    this.level = this.follower.current === null ? 0 : clamp01(this.follower.snrDb / LEVEL_FULL_SNR_DB)
    // The bar moves every frame while a lock is followed: announce it at most every
    // LEVEL_CHANGE_MS, and not at all while it stays put (no lock: always 0).
    const due = this.lastLevelChangeMs === null || frame.tMs - this.lastLevelChangeMs >= LEVEL_CHANGE_MS
    if (discrete || (due && this.level !== this.announcedLevel)) {
      this.lastLevelChangeMs = frame.tMs
      this.changed()
    }
  }

  /** Snapshot for the station screen. */
  view(canScan: boolean): StationModeView {
    return {
      step: this.step,
      name: this.name,
      answerCode: this.step === 'showAnswer' ? this.answerCode : null,
      f0Hz: this.follower.current?.f0Hz ?? null,
      level: this.level,
      lastChirpDb: this.lastChirpDb,
      lastChirpAtMs: this.lastChirpAtMs,
      chirpsSent: this.chirpsSent,
      message: this.message,
      canScan,
    }
  }

  /** Say bye to the hub, close the link and release a pairing attempt. The runtime is inert afterwards. */
  dispose(): void {
    if (this.disposed) return
    this.abandonAttempt()
    this.dropLink(true)
    this.disposed = true
  }

  // ---- Internals ---------------------------------------------------------------------------------

  /** Invalidate the running pairing attempt (stale async results are dropped) and release its connection. */
  private abandonAttempt(): void {
    this.seq++
    const pending = this.pending
    this.pending = null
    if (pending !== null) cancelAnswer(pending)
  }

  private attach(link: PeerLink): void {
    this.link = link
    // A lock followed for an earlier hub (a re-pairing after 'lost') must not produce reports for
    // this one: nothing is measured until this hub's own lock arrives, right after its hello.
    this.follower.setLock(null)
    this.level = 0
    this.hub = null
    link.onMessage = (data) => {
      if (this.link === link) this.onHubMessage(data)
    }
    link.onStateChange = (s) => {
      if (this.link === link) this.onLinkState(s)
    }
    if (link.state === 'open') this.onLinkState('open')
    else if (link.state === 'closed') this.onLinkState('closed')
  }

  private onLinkState(s: LinkState): void {
    if (s === 'open') {
      if (this.step === 'connected') return
      this.step = 'connected'
      this.answerCode = null
      this.message = null
      this.sendHi()
      this.changed()
    } else if (s === 'closed') {
      this.lose()
    }
  }

  private onHubMessage(raw: unknown): void {
    const msg: HubMessage | null = parseHubMessage(raw)
    if (msg === null) return
    switch (msg.t) {
      case 'hello':
        this.hub = msg.hubName
        this.changed()
        break
      case 'lock':
        if (this.follower.setLock(msg.f0Hz === null || msg.mode === null ? null : { f0Hz: msg.f0Hz, mode: msg.mode })) {
          this.level = 0
          this.changed()
        }
        break
      case 'ping':
        this.send({ t: 'pong', id: msg.id, hubMs: msg.hubMs, stationMs: this.deps.now() })
        break
      case 'calibrate':
        this.calibrating = msg.on
        this.changed()
        break
      case 'bye':
        this.lose()
        break
    }
  }

  private sendHi(): void {
    this.send({ t: 'hi', v: PROTOCOL_VERSION, name: this.name, rawAudio: this.rawAudio })
  }

  /** Send to the hub; false when there is no open link or the channel refused the message. */
  private send(msg: StationMessage): boolean {
    const link = this.link
    if (link === null || link.state !== 'open') return false
    try {
      return link.send(msg)
    } catch {
      // A failing channel shows up as a state change.
      return false
    }
  }

  /** The hub went away: keep measuring (the level bar still works) but stop sending. */
  private lose(): void {
    this.dropLink(false)
    this.step = 'lost'
    this.answerCode = null
    this.changed()
  }

  private fail(message: string): void {
    this.pending = null // its link already failed
    this.dropLink(false)
    this.step = 'error'
    this.answerCode = null
    this.message = message
    this.changed()
  }

  /** Detach and close the current link (after a bye when sayBye and it is open). */
  private dropLink(sayBye: boolean): void {
    const link = this.link
    this.link = null
    this.calibrating = false // only a connected hub can be calibrating
    if (link === null) return
    link.onMessage = null
    link.onStateChange = null
    if (sayBye && link.state === 'open') {
      try {
        link.send({ t: 'bye' } satisfies StationMessage)
      } catch {
        // Closing anyway.
      }
    }
    try {
      link.close()
    } catch {
      // Already closed.
    }
  }

  private changed(): void {
    if (this.disposed) return
    this.announcedLevel = this.level
    this.deps.onChange()
  }
}
