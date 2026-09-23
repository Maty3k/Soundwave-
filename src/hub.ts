/**
 * Hub side of the multi-listener comparison. The hunting device (the hub) compares, per chirp,
 * what several listeners heard: its own mic ('self', which runs the hunt), extra mics on the same
 * device ('mic') and stations on other devices ('station'), paired over the local Wi-Fi with a
 * WebRTC data channel (src/net/peer.ts, no signalling server). Stations send only numbers (chirp
 * onset on their clock, level, SNR, clipping; live held level); the hub turns their onsets into
 * hub time with a ping-based clock offset and hands every report to src/dsp/compare.ts, which
 * groups the reports of one chirp and names the loudest listener.
 *
 * Times: deps.now() must be the clock of the hunt's frames (performance.now() in the app), so the
 * local readings' tMs and the stations' onsets converted to hub time are comparable.
 */
import type { Config } from './config.ts'
import type { Comparison, LockMode, PairStep, Reading, StationsView } from './types.ts'
import {
  addLiveLevel,
  addReport,
  calibrateLive,
  cancelCalibration,
  clearReports,
  comparisonOf,
  createCompare,
  lastComparison,
  listenerViews,
  liveComparison,
  removeListener,
  setListenerStatus,
  startCalibration,
  touchListener,
  updateStatuses,
  upsertListener,
} from './dsp/compare.ts'
import type { ChirpReport, CompareState, ReportGroup } from './dsp/compare.ts'
import { createOffer } from './net/peer.ts'
import type { LinkState, Offer, PairDiag, PeerLink } from './net/peer.ts'
import { parseHubMessage, parseStationMessage, PROTOCOL_VERSION } from './net/protocol.ts'
import type { HubMessage, StationMessage } from './net/protocol.ts'
import { clockSample, estimateOffset, pushClockSample, toHubTime } from './net/clock.ts'
import type { ClockSample } from './net/clock.ts'
import { cleanStationName } from './stationMode.ts'

/** Injectable createOffer (tests); the app uses src/net/peer.ts. */
export type CreateOfferFn = () => Promise<Offer>

export interface HubDeps {
  readonly cfg: Config
  /** Millisecond clock; must be the clock of the hunt's frames (performance.now() in the app). */
  readonly now: () => number
  /** Called after anything the Stations panel shows has changed. */
  readonly onChange: () => void
  /** Name sent to the stations in 'hello'. */
  readonly hubName: string
  /** Test seam: replaces peer.createOffer. */
  readonly createOffer?: CreateOfferFn
}

/** One paired station and its link. */
interface Station {
  readonly id: string
  readonly link: PeerLink
  /** Name used until the station's 'hi' (and when its name is empty). */
  readonly provisionalName: string
  /** Ping id -> hub send time, for pings still waiting for their pong (oldest first). */
  readonly pings: Map<number, number>
  /** Clock samples of the last cfg.stationPingKeep round trips. */
  samples: ClockSample[]
  /** Station clock minus hub clock estimate; null until the first pong. */
  offsetMs: number | null
  lastPingMs: number
  /** Hub time the link opened (a station that never says anything valid goes lost from here). */
  readonly connectedMs: number
  /** The link is usable (false after close or bye). */
  open: boolean
}

/** A listener on this device: the main mic or an extra mic. */
interface Local {
  readonly name: string
  readonly kind: 'self' | 'mic'
}

/**
 * peer.ts rejects an answer code at once when the code itself is wrong (unreadable, a hub code, an
 * answer to another offer, a description the browser refuses) and keeps the offer usable for
 * another answer. Any later rejection is a failed connection (no connection within its timeout,
 * or the connection failed), after which the offer has ended: showing its code again would send
 * the station user round a pairing that can only fail. A rejection within this time counts as a
 * code problem; a later one abandons the offer (start pairing again).
 */
const ANSWER_CODE_CHECK_MS = 2000

function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message !== '') return err.message
  if (typeof err === 'string' && err !== '') return err
  return fallback
}

/**
 * Hub runtime: the local listeners, the paired stations and one pairing at a time. Call tick()
 * about every animation frame; it sends the clock pings and marks silent listeners lost.
 */
export class StationHub {
  private readonly deps: HubDeps
  private readonly compare: CompareState
  private readonly locals = new Map<string, Local>()
  private readonly stations = new Map<string, Station>()
  private stationCount = 0
  private nextPingId = 1
  private lock: { readonly f0Hz: number | null; readonly mode: LockMode | null } = { f0Hz: null, mode: null }
  private calibrating = false
  private disposed = false
  /** Listeners in the live comparison at the last tick: a level going stale changes the panel. */
  private liveKey = ''
  // Pairing
  private pairStep: PairStep = 'idle'
  private pairMessage: string | null = null
  private offer: Offer | null = null
  /** Diagnostics of the offer that just ended, kept through the 'error' step (debug panel). */
  private lastDiag: PairDiag | null = null
  /** A link from an accepted answer that has not opened yet. */
  private pendingLink: PeerLink | null = null
  /** Increments on every pairing start / cancel; stale async results are discarded. */
  private pairSeq = 0

  constructor(deps: HubDeps) {
    this.deps = deps
    this.compare = createCompare()
  }

  // ---- Listeners ---------------------------------------------------------------------------------

  /** Register this device's main mic ('self') or an extra mic ('mic', id 'mic:' + deviceId). */
  addLocalListener(id: string, name: string, kind: 'self' | 'mic'): void {
    if (this.disposed) return
    this.locals.set(id, { name, kind })
    upsertListener(this.compare, { id, name, kind, status: 'listening' }, this.deps.now())
    this.changed()
  }

  /** Forget a listener; a station gets a bye and its link is closed. */
  removeListener(id: string): void {
    const st = this.stations.get(id)
    if (st !== undefined) {
      this.stations.delete(id)
      this.closeStation(st, true)
    }
    this.locals.delete(id)
    removeListener(this.compare, id)
    this.syncCalibrating()
    this.changed()
  }

  // ---- Pairing -----------------------------------------------------------------------------------

  /** Create an offer code for a new station ('preparing' -> 'showOffer', or 'error'). Cancels any open pairing. */
  async startPairing(): Promise<void> {
    if (this.disposed) return
    this.abortPairing()
    this.lastDiag = null
    const seq = this.pairSeq
    this.pairStep = 'preparing'
    this.pairMessage = null
    this.changed()
    let offer: Offer
    try {
      offer = await (this.deps.createOffer ?? (() => createOffer(this.deps.cfg)))()
    } catch (err) {
      if (seq === this.pairSeq && !this.disposed) this.pairError(errorText(err, 'Could not prepare a pairing code.'))
      return
    }
    if (seq !== this.pairSeq || this.disposed) {
      offer.cancel()
      return
    }
    this.offer = offer
    this.pairStep = 'showOffer'
    this.changed()
  }

  /**
   * Move between showing the offer and scanning / pasting the answer while an offer is open, also
   * from 'error' after a rejected answer code (the offer stays usable, so the station keeps its
   * answer). Does nothing without an open offer (e.g. after a failed connection).
   */
  setPairStep(step: 'showOffer' | 'scanAnswer' | 'pasteAnswer'): void {
    if (this.offer === null) return
    const s = this.pairStep
    if (s !== 'showOffer' && s !== 'scanAnswer' && s !== 'pasteAnswer' && s !== 'error') return
    if (s === step) return
    this.pairStep = step
    this.pairMessage = null
    this.changed()
  }

  /**
   * Complete the pairing with the station's answer code ('connecting'). When the link opens the
   * station is registered ('station-N', named 'Station N' until its hi), gets hello + the current
   * lock and a first ping, and pairing returns to 'idle'. Failure: 'error' with the message. After
   * a rejected code the offer is kept, so another answer can be tried (setPairStep, acceptAnswer);
   * after a failed connection it has ended and only a new pairing (startPairing) can follow.
   */
  async acceptAnswer(code: string): Promise<void> {
    // While connecting the answer is already in; while preparing there is no offer yet to answer
    // (reporting an error here would also abandon the offer being prepared).
    if (this.disposed || this.pairStep === 'connecting' || this.pairStep === 'preparing') return
    const offer = this.offer
    if (offer === null) {
      this.pairError('Start pairing again: there is no open pairing code.')
      return
    }
    const seq = this.pairSeq
    const startedMs = this.deps.now()
    this.pairStep = 'connecting'
    this.pairMessage = null
    this.changed()
    let link: PeerLink
    try {
      link = await offer.accept(code.trim())
    } catch (err) {
      if (seq !== this.pairSeq || this.disposed) return
      const message = errorText(err, 'This answer code did not work.')
      if (this.deps.now() - startedMs > ANSWER_CODE_CHECK_MS) {
        this.pairError(message) // the connection failed: this offer has ended
        return
      }
      this.pairStep = 'error'
      this.pairMessage = message
      this.changed()
      return
    }
    if (seq !== this.pairSeq || this.disposed) {
      link.close()
      return
    }
    this.offer = null
    if (link.state === 'open') {
      this.connected(link)
      return
    }
    if (link.state === 'closed') {
      this.pairError('The connection closed before it opened.')
      return
    }
    this.pendingLink = link
    link.onStateChange = (s: LinkState) => {
      if (this.pendingLink !== link) return
      if (s === 'open') {
        this.pendingLink = null
        this.connected(link)
      } else if (s === 'closed') {
        this.pendingLink = null
        this.pairError('The connection closed before it opened.')
      }
    }
  }

  /** Abandon the open pairing (offer, or a link still connecting); back to 'idle'. */
  cancelPairing(): void {
    this.abortPairing()
    this.lastDiag = null
    if (this.pairStep === 'idle' && this.pairMessage === null) return
    this.pairStep = 'idle'
    this.pairMessage = null
    this.changed()
  }

  // ---- Lock and reports --------------------------------------------------------------------------

  /**
   * The hunt's lock (null when listening again). Sent to every open station now, when it changed,
   * and to each new station on connect. Call it on lock, on relisten and on chirp <-> live mode
   * switches: stations (like extra mics) report live levels only while the lock is 'live', and the
   * panel shows the live comparison only then. Relistening, the lock that follows it, or a
   * frequency outside the lock tolerance of the previous one forgets the old chirp comparisons
   * (listeners and offsets stay): a station's report of the old beep may still be on its way when
   * the hub listens again, and must not become the new beep's last comparison. A lock the
   * stations would reject (not a finite frequency in protocol range) counts as none.
   */
  setLock(f0Hz: number | null, mode: LockMode | null): void {
    const valid = f0Hz !== null && mode !== null && parseHubMessage({ t: 'lock', f0Hz, mode }) !== null
    const next = valid ? { f0Hz, mode } : { f0Hz: null, mode: null }
    const prev = this.lock
    if (next.f0Hz === prev.f0Hz && next.mode === prev.mode) return
    const newBeep =
      next.f0Hz === null ||
      prev.f0Hz === null ||
      Math.abs(next.f0Hz - prev.f0Hz) > (prev.f0Hz * this.deps.cfg.lockTolPct) / 100
    if (newBeep) clearReports(this.compare)
    this.lock = next
    this.broadcast(this.lockMessage())
    this.changed()
  }

  /**
   * A local listener's reading ('self' or 'mic'; call again with the merged reading on
   * 'readingUpdated'). Returns the comparison of that chirp.
   */
  report(listenerId: string, reading: Reading): Comparison {
    const now = this.deps.now()
    const local = this.locals.get(listenerId)
    const base = { listenerId, onsetMs: reading.tMs, levelDb: reading.levelDb, snrDb: reading.snrDb, clipped: reading.clipped }
    const rep: ChirpReport = local?.kind === 'self' ? { ...base, readingId: reading.id } : base
    touchListener(this.compare, listenerId, now)
    const comparison = addReport(this.compare, rep, now, this.deps.cfg)
    this.syncCalibrating()
    this.changed()
    return comparison
  }

  /**
   * A local listener's held live level (dB). Call at most every cfg.stationLevelReportMs per
   * listener. While the lock is 'live' a waiting calibration completes on fresh levels from all.
   */
  liveLevel(listenerId: string, levelDb: number, clipped: boolean): void {
    if (!Number.isFinite(levelDb)) return
    const now = this.deps.now()
    touchListener(this.compare, listenerId, now)
    addLiveLevel(this.compare, listenerId, levelDb, clipped, now)
    this.calibrateOnLive(now)
    this.changed()
  }

  /**
   * Wait for a chirp heard by every listener (in a 'live' lock: fresh live levels from every
   * listener) and equalise their levels with it; stations are told.
   */
  calibrate(): void {
    startCalibration(this.compare)
    this.calibrating = true
    this.broadcast({ t: 'calibrate', on: true })
    this.changed()
  }

  /** Stop waiting for the calibration chirp. */
  cancelCalibration(): void {
    cancelCalibration(this.compare)
    const was = this.calibrating
    this.calibrating = false
    if (was) this.broadcast({ t: 'calibrate', on: false })
    this.changed()
  }

  // ---- Frame loop and view -----------------------------------------------------------------------

  /**
   * About every animation frame: clock pings, closed links, lost / recovered statuses, and live
   * levels going stale (onChange for each of these).
   */
  tick(): void {
    if (this.disposed) return
    const now = this.deps.now()
    const cfg = this.deps.cfg
    let changed = false
    // Extra mics are alive as long as they are registered (they report only when they hear a
    // chirp, rarer than listenerLostMs; 'self' is never marked lost). Only stations go silent.
    for (const [id, local] of this.locals) if (local.kind === 'mic') touchListener(this.compare, id, now)
    for (const st of this.stations.values()) {
      if (!st.open) continue
      if (st.link.state === 'closed') {
        this.markClosed(st)
        changed = true
        continue
      }
      if (st.link.state === 'open' && now - st.lastPingMs >= cfg.stationPingMs) this.ping(st, now)
      // updateStatuses only times out 'listening' listeners: a station whose link opened but that
      // never sent one valid message (another app version, a stalled page) would stay 'connecting'.
      if (this.compare.listeners.get(st.id)?.status === 'connecting' && now - st.connectedMs >= cfg.listenerLostMs) {
        setListenerStatus(this.compare, st.id, 'lost')
        changed = true
      }
    }
    const before = this.statusKey()
    updateStatuses(this.compare, now, cfg)
    const live = this.lock.mode === 'live' ? liveComparison(this.compare, now, cfg) : null
    const liveKey = live === null ? '' : live.ranking.map((e) => e.id).join('|')
    if (liveKey !== this.liveKey) {
      this.liveKey = liveKey
      changed = true
    }
    if (changed || this.statusKey() !== before) this.changed()
  }

  /**
   * Snapshot for the Stations panel: listeners ('self', mics, stations), the mics that can still be
   * added, the pairing, the comparison (in live mode the live one while live levels arrive, else
   * the last chirp's) and whether a calibration is waiting.
   */
  view(availableMics: StationsView['availableMics'], canScan: boolean): StationsView {
    const comparison = this.currentComparison()
    // 'error' keeps the offer while it is still usable, so a mistyped reply can be scanned or pasted again.
    const showCode =
      this.pairStep === 'showOffer' ||
      this.pairStep === 'scanAnswer' ||
      this.pairStep === 'pasteAnswer' ||
      (this.pairStep === 'error' && this.offer !== null)
    return {
      listeners: listenerViews(this.compare, comparison, this.deps.cfg),
      availableMics: availableMics.filter((m) => !this.locals.has('mic:' + m.deviceId)),
      pairing: {
        step: this.pairStep,
        offerCode: showCode ? (this.offer?.code ?? null) : null,
        message: this.pairMessage,
        canScan,
        // The offer is open while its code is shown and while its answer connects; after a failed
        // connection its last diagnostics stay readable until the pairing is cancelled or restarted.
        ...(this.offer !== null ? { diag: this.offer.diag() } : this.pairStep === 'error' && this.lastDiag !== null ? { diag: this.lastDiag } : {}),
      },
      comparison,
      calibrating: this.calibrating,
    }
  }

  /** Name of the loudest listener of the last chirp comparison (for the log); null when none was named. */
  latestLoudestName(): string | null {
    return this.loudestName(lastComparison(this.compare, this.deps.cfg))
  }

  /**
   * Name of the loudest listener of the chirp that became the hub's reading `readingId`; null when
   * none was named (yet) or that chirp is no longer kept. A station's report usually arrives a
   * little after the hub's own reading, so the log entry should be refreshed on later changes.
   */
  loudestNameFor(readingId: number): string | null {
    let group: ReportGroup | null = null
    for (const g of this.compare.groups) {
      if (g.readingId === readingId && (group === null || g.seq > group.seq)) group = g
    }
    return group === null ? null : this.loudestName(comparisonOf(this.compare, group, this.deps.cfg))
  }

  /** Say bye to every station, close the links and cancel the pairing. The hub is inert afterwards. */
  dispose(): void {
    if (this.disposed) return
    this.abortPairing()
    for (const st of this.stations.values()) this.closeStation(st, true)
    this.stations.clear()
    this.disposed = true
  }

  // ---- Stations ----------------------------------------------------------------------------------

  /** A paired link opened: register the station, greet it and start the clock pings. */
  private connected(link: PeerLink): void {
    const n = ++this.stationCount
    const now = this.deps.now()
    const st: Station = {
      id: `station-${n}`,
      link,
      provisionalName: `Station ${n}`,
      pings: new Map(),
      samples: [],
      offsetMs: null,
      lastPingMs: -Infinity,
      connectedMs: now,
      open: true,
    }
    this.stations.set(st.id, st)
    upsertListener(this.compare, { id: st.id, name: st.provisionalName, kind: 'station', status: 'connecting' }, now)
    link.onMessage = (data: unknown) => this.onStationData(st, data)
    link.onStateChange = (s: LinkState) => {
      if (s === 'closed' && st.open) {
        this.markClosed(st)
        this.changed()
      }
    }
    this.sendTo(st, { t: 'hello', v: PROTOCOL_VERSION, hubName: cleanStationName(this.deps.hubName, 'Soundwave') })
    this.sendTo(st, this.lockMessage())
    if (this.calibrating) this.sendTo(st, { t: 'calibrate', on: true })
    this.ping(st, now)
    this.pairStep = 'idle'
    this.pairMessage = null
    this.changed()
  }

  private onStationData(st: Station, data: unknown): void {
    if (this.disposed || !st.open || this.stations.get(st.id) !== st) return
    const msg: StationMessage | null = parseStationMessage(data)
    if (msg === null) return
    const now = this.deps.now()
    const cfg = this.deps.cfg
    touchListener(this.compare, st.id, now)
    if (msg.t === 'bye') {
      this.markClosed(st)
      this.changed()
      return
    }
    setListenerStatus(this.compare, st.id, 'listening')
    switch (msg.t) {
      case 'hi': {
        upsertListener(this.compare, { id: st.id, name: cleanStationName(msg.name, st.provisionalName), kind: 'station', status: 'listening' }, now)
        break
      }
      case 'pong': {
        const sentMs = st.pings.get(msg.id)
        if (sentMs === undefined) break
        st.pings.delete(msg.id)
        st.samples = pushClockSample(st.samples, clockSample(sentMs, now, msg.stationMs), cfg.stationPingKeep)
        st.offsetMs = estimateOffset(st.samples)
        break
      }
      case 'chirp': {
        // Without a clock offset the onset cannot be placed on the hub's time line. The first
        // ping goes out on connect, so this only drops chirps within one round trip of pairing.
        if (st.offsetMs === null) {
          if (st.pings.size === 0) this.ping(st, now)
          break
        }
        const onsetMs = toHubTime(msg.onsetMs, st.offsetMs)
        // A chirp is reported after it ended. An onset further in the future than the matching
        // window means a broken clock estimate or a misbehaving station: it could match nothing
        // and would only replace the panel's comparison with a lone, misplaced report.
        if (onsetMs > now + cfg.compareWindowMs) break
        addReport(
          this.compare,
          {
            listenerId: st.id,
            onsetMs,
            levelDb: msg.levelDb,
            snrDb: msg.snrDb,
            clipped: msg.clipped,
          },
          now,
          cfg,
        )
        this.syncCalibrating()
        break
      }
      case 'level': {
        const atMs = st.offsetMs === null ? now : toHubTime(msg.atMs, st.offsetMs)
        addLiveLevel(this.compare, st.id, msg.levelDb, msg.clipped, atMs)
        this.calibrateOnLive(now)
        break
      }
    }
    this.changed()
  }

  private ping(st: Station, now: number): void {
    const id = this.nextPingId++
    st.lastPingMs = now
    st.pings.set(id, now)
    // Unanswered pings are forgotten once more than stationPingKeep are outstanding.
    while (st.pings.size > this.deps.cfg.stationPingKeep) {
      const oldest = st.pings.keys().next()
      if (oldest.done === true) break
      st.pings.delete(oldest.value)
    }
    this.sendTo(st, { t: 'ping', id, hubMs: now })
  }

  /** The station's link closed or it said bye: keep it listed as lost so the user sees it. */
  private markClosed(st: Station): void {
    if (!st.open) return
    this.closeStation(st, false)
    setListenerStatus(this.compare, st.id, 'lost')
  }

  /** Detach and close a station's link, after a bye when sayBye and the link is open. */
  private closeStation(st: Station, sayBye: boolean): void {
    const wasOpen = st.open
    st.open = false
    st.pings.clear()
    st.link.onMessage = null
    st.link.onStateChange = null
    if (sayBye && wasOpen && st.link.state === 'open') this.rawSend(st.link, { t: 'bye' })
    try {
      st.link.close()
    } catch {
      // Already closed.
    }
  }

  private lockMessage(): HubMessage {
    return { t: 'lock', f0Hz: this.lock.f0Hz, mode: this.lock.mode }
  }

  private broadcast(msg: HubMessage): void {
    for (const st of this.stations.values()) this.sendTo(st, msg)
  }

  private sendTo(st: Station, msg: HubMessage): void {
    if (st.open && st.link.state === 'open') this.rawSend(st.link, msg)
  }

  private rawSend(link: PeerLink, msg: HubMessage): void {
    try {
      link.send(msg)
    } catch {
      // A failing channel shows up as a state change.
    }
  }

  // ---- Pairing internals -------------------------------------------------------------------------

  private abortPairing(): void {
    this.pairSeq++
    const offer = this.offer
    this.offer = null
    if (offer !== null) {
      try {
        this.lastDiag = offer.diag()
      } catch {
        // Diagnostics are a bonus.
      }
      try {
        offer.cancel()
      } catch {
        // Nothing to cancel.
      }
    }
    const link = this.pendingLink
    this.pendingLink = null
    if (link !== null) {
      link.onStateChange = null
      try {
        link.close()
      } catch {
        // Already closed.
      }
    }
  }

  private pairError(message: string): void {
    this.abortPairing()
    this.pairStep = 'error'
    this.pairMessage = message
    this.changed()
  }

  // ---- View helpers ------------------------------------------------------------------------------

  /**
   * In live mode the live comparison while live levels keep arriving (liveComparison keeps only
   * fresh ones), otherwise the last chirp's. Levels arriving in chirp mode (a listener whose own
   * hunt heard a continuous tone) must not hide the chirp comparisons.
   */
  private currentComparison(): Comparison | null {
    const cfg = this.deps.cfg
    const live = this.lock.mode === 'live' ? liveComparison(this.compare, this.deps.now(), cfg) : null
    return live ?? lastComparison(this.compare, cfg)
  }

  /** Name of the named loudest listener of a comparison. */
  private loudestName(c: Comparison | null): string | null {
    if (c === null || c.loudestId === null) return null
    const id = c.loudestId
    return c.ranking.find((e) => e.id === id)?.name ?? this.compare.listeners.get(id)?.name ?? null
  }

  /** Listener statuses as a string, to notice changes made by updateStatuses. */
  private statusKey(): string {
    let key = ''
    for (const l of this.compare.listeners.values()) key += l.id + ':' + l.status + '|'
    return key
  }

  /**
   * A continuous tone has no chirps to calibrate on: while the lock is 'live', fresh live levels
   * from every listening listener complete a waiting calibration.
   */
  private calibrateOnLive(now: number): void {
    if (!this.calibrating || this.lock.mode !== 'live') return
    calibrateLive(this.compare, now, this.deps.cfg)
    this.syncCalibrating()
  }

  /** The calibration finishes inside compare (a chirp heard by everyone); tell the stations. */
  private syncCalibrating(): void {
    if (!this.calibrating || this.compare.calibrating) return
    this.calibrating = false
    this.broadcast({ t: 'calibrate', on: false })
  }

  private changed(): void {
    if (!this.disposed) this.deps.onChange()
  }
}

