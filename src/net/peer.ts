/**
 * WebRTC data channel between the hub and a station, with the user as the signalling channel:
 * the hub shows an offer code (QR), the station scans it and shows an answer code, the hub scans
 * that. No signalling server and no TURN relay. The one outside request is a STUN lookup
 * (cfg.iceServers) while a pairing code is being prepared: it tells the device its public address
 * so that the code also works across networks, and the STUN server sees the device's IP address
 * and nothing else (the browser may repeat the lookup now and then while connected). When no STUN
 * server answers in time the code carries the host candidates alone, and both devices must share
 * a network, as before.
 *
 * Both sides open the same pre-negotiated channel (id 0), so no in-band channel announcement is
 * needed. Messages are JSON; the pure parts (codes, SDP) live in sdpCode.ts.
 *
 * Every entry point feature-detects RTCPeerConnection and reports failures as rejected promises
 * with user-presentable messages; nothing throws synchronously.
 *
 * Chrome, Firefox and Safari hide the local IP addresses behind random mDNS names ('<uuid>.local')
 * until the page has camera or microphone permission. Open the microphone before pairing: the codes
 * get shorter and the connection does not depend on mDNS, which some routers block.
 */
import type { Config } from '../config.ts'
import { buildSdp, CODE_MAX_CANDIDATES, CODE_MAX_CHARS, decodeCode, encodeCodeWithin, offerTag, parseSdp } from './sdpCode.ts'
import type { CompactSdp } from './sdpCode.ts'

/** State of a link: 'closed' is final (the channel or the connection closed, or failed once open). */
export type LinkState = 'connecting' | 'open' | 'closed'

/** An established (or establishing) connection to one other device. */
export interface PeerLink {
  readonly state: LinkState
  /** Send one JSON message; false when the link is not open or the message cannot be sent. */
  send(message: unknown): boolean
  /**
   * Close the link: onStateChange fires with 'closed' (at once) if it was not closed yet. What was
   * sent just before (a 'bye') is still delivered: the connection is released once the channel
   * has closed cleanly, or after about a second.
   */
  close(): void
  /**
   * Each received message, parsed from JSON (invalid JSON, binary and oversized messages are
   * dropped). Messages that arrive while this is null are kept (up to 64) and delivered, in order,
   * right after a handler is set (in a microtask); closing the link discards them.
   */
  onMessage: ((data: unknown) => void) | null
  /** Called on every state change; 'closed' is final. */
  onStateChange: ((state: LinkState) => void) | null
}

/** How many candidates of each kind a pairing code carries: local (host) addresses and public ones (srflx, prflx, relay). */
export interface CandidateCount {
  readonly host: number
  readonly public: number
}

/**
 * Pairing diagnostics for the debug panel: the candidates in this device's code, those in the
 * other device's code once it is known (null before), and the latest ICE / connection state the
 * browser reported ('new' before any). Read off the screen when a pairing fails.
 */
export interface PairDiag {
  readonly mine: CandidateCount
  readonly theirs: CandidateCount | null
  readonly ice: string
}

/** Hub side of a pairing in progress. */
export interface Offer {
  /** Compact offer code to show as a QR code and as text. */
  readonly code: string
  /**
   * Connect with the station's answer code. Resolves with the link once the channel is open;
   * rejects with a user-presentable Error on a bad code or an answer to another pairing code (the
   * offer stays usable for another try), after 20 s without a connection, or when cancelled.
   */
  accept(answerCode: string): Promise<PeerLink>
  /** Abandon the pairing (no effect once accept() has delivered a link). */
  cancel(): void
  /** Diagnostics snapshot; theirs is known once accept() has taken an answer. */
  diag(): PairDiag
}

/** Station side of a pairing in progress. */
export interface Answer {
  /** Compact answer code to show to the hub as a QR code and as text. */
  readonly code: string
  /**
   * Resolves when the hub has accepted the code and the channel is open; rejects with a
   * user-presentable Error after 60 s, when the connection is closed before it opened, or when
   * cancelled. Already marked as handled: a caller that never awaits it causes no unhandled rejection.
   */
  readonly link: Promise<PeerLink>
  /** Abandon the pairing and release the connection at once (no effect once the link is open). */
  cancel(): void
  /**
   * True once the hub answers this reply's connectivity checks (ICE connected, the channel may
   * still be opening): the hub can be reached from here and the checks keep the path alive by
   * themselves. On the same network this happens within a second or two of the code being made;
   * across networks it stays false until the hub has taken the code.
   */
  iceConnected(): boolean
  /** Diagnostics snapshot; theirs is the offer this answer was made for. */
  diag(): PairDiag
}

const CHANNEL_LABEL = 'soundwave'
const CHANNEL_INIT: RTCDataChannelInit = { negotiated: true, id: 0, ordered: true }
const HUB_CONNECT_TIMEOUT_MS = 20_000
/** The station user still has to show the answer code to the hub. */
const STATION_CONNECT_TIMEOUT_MS = 60_000
/** After close(), the connection waits this long at most for the channel to flush and close. */
const CLOSE_GRACE_MS = 1000
/** Longest accepted incoming message, in UTF-16 units; protocol messages are far shorter. */
const MAX_MESSAGE_CHARS = 16_384
/** Messages kept while no onMessage handler is set. */
const MAX_QUEUED_MESSAGES = 64
/** send() refuses while this much is still queued (a stalled link). */
const MAX_BUFFERED_BYTES = 1_000_000

// User-presentable messages, in the words of the UI copy (src/copy.ts STATIONS_COPY): the hub is
// the "main phone", a station the "other phone", an answer code a "reply code". 'Wi‑Fi' has a
// non-breaking hyphen, as everywhere in the copy.
const ERR_UNSUPPORTED = 'This browser cannot connect to other devices.'
const ERR_PREPARE = 'Could not prepare the pairing code. Try again.'
const ERR_NO_NETWORK = 'No network connection found. Connect this device to Wi‑Fi and try again.'
const ERR_CONNECT =
  "Could not connect. On the same Wi‑Fi, try again. Across networks, scan the reply code as soon as it appears, or put both devices on one phone's hotspot."
const ERR_STATION_TIMEOUT =
  "The main phone did not connect. Show it the code again as soon as you can. Across networks, put both devices on one phone's hotspot."
const ERR_CANCELLED = 'Pairing was cancelled.'
const ERR_ENDED = 'This pairing has ended. Start again.'
const ERR_HUB_CODE = "That is a main phone's code. Scan the reply code shown on the other phone instead."
const ERR_STATION_CODE = 'That is a reply code. Scan the code shown on the main phone instead.'
const ERR_ANSWER_REJECTED = 'This reply code does not fit. Scan the code on the other phone again.'
const ERR_OTHER_OFFER =
  'This reply was made for a different code. On the other phone, tap Start over and scan the code shown here.'
const ERR_OFFER_REJECTED = 'This code could not be used. On the main phone, cancel and tap Add a phone again.'

/** An error whose message can be shown to the user as it is. */
class PairingError extends Error {}

function userError(err: unknown, fallback: string): Error {
  return err instanceof PairingError ? err : new PairingError(fallback)
}

/** Run a callback; an exception in it is reported, but does not stop the caller's bookkeeping. */
function safely(fn: () => void): void {
  try {
    fn()
  } catch (err) {
    setTimeout(() => {
      throw err
    }, 0)
  }
}

/** True when this browser has WebRTC (RTCPeerConnection). */
export function peerSupported(): boolean {
  return typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function'
}

/** A connection that gathers host candidates and, through cfg.iceServers, the public address. */
function newPeerConnection(cfg: Config): RTCPeerConnection {
  if (!peerSupported()) throw new PairingError(ERR_UNSUPPORTED)
  try {
    return new RTCPeerConnection({ iceServers: cfg.iceServers.map((urls) => ({ urls })) })
  } catch {
    throw new PairingError(ERR_UNSUPPORTED)
  }
}

function closeQuietly(pc: RTCPeerConnection): void {
  try {
    pc.close()
  } catch {
    // Already closed.
  }
}

class Link implements PeerLink {
  onStateChange: ((state: LinkState) => void) | null = null
  private handler: ((data: unknown) => void) | null = null
  private readonly queue: unknown[] = []
  private flushScheduled = false
  private current: LinkState = 'connecting'
  private readonly pc: RTCPeerConnection
  private readonly dc: RTCDataChannel
  /** Internal state listeners (pairing), independent of the app's onStateChange. */
  private readonly watchers = new Set<(state: LinkState) => void>()
  /** Latest connectionState / iceConnectionState the browser reported (diagnostics). */
  private iceState = 'new'

  constructor(pc: RTCPeerConnection, dc: RTCDataChannel) {
    this.pc = pc
    this.dc = dc
    dc.addEventListener('open', () => this.setState('open'))
    dc.addEventListener('close', () => this.setState('closed'))
    dc.addEventListener('message', (e: MessageEvent) => this.receive(e.data))
    pc.addEventListener('connectionstatechange', () => this.onPeerState(pc.connectionState))
    // Firefox before 113 has no connectionState.
    pc.addEventListener('iceconnectionstatechange', () => this.onPeerState(pc.iceConnectionState))
  }

  /**
   * 'closed' always ends the link; 'failed' only once it is open. While connecting, the station
   * checks the hub's addresses before the hub has its answer, and a hub that does not answer those
   * early checks (Firefox) lets them fail after about 15 s, while the user may still be showing the
   * answer code. libwebrtc recovers once the hub's own checks arrive, so a connecting link is left
   * to the pairing timeouts (20 s on the hub after accept(), 60 s on the station).
   */
  private onPeerState(state: RTCPeerConnectionState | RTCIceConnectionState): void {
    this.iceState = state
    if (state === 'closed' || (state === 'failed' && this.current === 'open')) this.setState('closed')
  }

  get state(): LinkState {
    return this.current
  }

  /** The latest connectionState / iceConnectionState string seen; 'new' before any. */
  get ice(): string {
    return this.iceState
  }

  get onMessage(): ((data: unknown) => void) | null {
    return this.handler
  }

  set onMessage(fn: ((data: unknown) => void) | null) {
    this.handler = fn
    if (fn !== null && this.queue.length > 0) this.scheduleFlush()
  }

  send(message: unknown): boolean {
    if (this.current !== 'open' || this.dc.readyState !== 'open') return false
    try {
      if (this.dc.bufferedAmount > MAX_BUFFERED_BYTES) return false
      const text = JSON.stringify(message)
      if (typeof text !== 'string') return false
      this.dc.send(text)
      return true
    } catch {
      return false
    }
  }

  close(): void {
    this.setState('closed', true)
  }

  /** Listen to state changes (pairing internals); returns the unsubscribe function. */
  watch(fn: (state: LinkState) => void): () => void {
    this.watchers.add(fn)
    return () => this.watchers.delete(fn)
  }

  private receive(data: unknown): void {
    if (this.current === 'closed' || typeof data !== 'string' || data.length > MAX_MESSAGE_CHARS) return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const fn = this.handler
    if (fn !== null && this.queue.length === 0) {
      safely(() => fn(parsed))
      return
    }
    // No handler yet, or older messages are still waiting: keep the order.
    if (this.queue.length < MAX_QUEUED_MESSAGES) this.queue.push(parsed)
    if (fn !== null) this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => {
      this.flushScheduled = false
      while (this.queue.length > 0 && this.current !== 'closed') {
        const fn = this.handler
        if (fn === null) return
        const message = this.queue.shift()
        safely(() => fn(message))
      }
    })
  }

  /** Move to `next`; `graceful` (a local close()) lets the channel deliver what was sent first. */
  private setState(next: LinkState, graceful = false): void {
    if (this.current === 'closed' || this.current === next) return
    this.current = next
    if (next === 'closed') {
      this.queue.length = 0
      this.release(graceful)
    }
    for (const fn of [...this.watchers]) safely(() => fn(next))
    const app = this.onStateChange
    if (app !== null) safely(() => app(next))
  }

  /**
   * Close the channel, then the connection. RTCPeerConnection.close() is abrupt: messages still on
   * their way (the 'bye' sent just before close()) would be lost. So on a graceful close of an open
   * channel the channel is closed first, which delivers what was sent and tells the other side, and
   * the connection follows when the channel reports 'close', or after CLOSE_GRACE_MS. After a
   * failure or a close by the other side the connection is released at once.
   */
  private release(graceful: boolean): void {
    let open = false
    try {
      open = this.dc.readyState === 'open'
      this.dc.close()
    } catch {
      open = false
    }
    if (!graceful || !open) {
      closeQuietly(this.pc)
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      this.dc.removeEventListener('close', done)
      closeQuietly(this.pc)
    }
    const timer = setTimeout(done, CLOSE_GRACE_MS)
    this.dc.addEventListener('close', done)
  }
}

/**
 * Resolve when ICE gathering has what a pairing code needs, at the latest after timeoutMs (the
 * candidates gathered so far are used then):
 * - gathering completes (or the null candidate arrives);
 * - a public (srflx) candidate arrives: the STUN lookup worked, so the code works across networks;
 * - a UDP host candidate is in and every STUN server in stunUrls has reported an error (no
 *   internet, blocked DNS or firewall): no public address will come, so do not wait for one;
 * - a UDP host candidate is in and stunGraceMs has passed without a public one (STUN packets
 *   dropped silently). Without STUN servers there is no grace wait: gathering completes by itself.
 * When not one UDP candidate has arrived by timeoutMs (a busy device still registering its mDNS
 * name), wait one more timeoutMs before giving up: an empty result is reported to the user as
 * "no network". Exported for the tests.
 */
export function gathered(pc: RTCPeerConnection, timeoutMs: number, stunGraceMs: number, stunUrls: readonly string[]): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const wait = Math.max(0, timeoutMs)
    let usable = false
    let extended = false
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    const failed = new Set<string>()
    const done = (): void => {
      clearTimeout(timer)
      if (graceTimer !== null) clearTimeout(graceTimer)
      pc.removeEventListener('icegatheringstatechange', onState)
      pc.removeEventListener('icecandidate', onCandidate)
      pc.removeEventListener('icecandidateerror', onError)
      resolve()
    }
    const allStunFailed = (): boolean => stunUrls.length > 0 && stunUrls.every((u) => failed.has(u))
    const onState = (): void => {
      if (pc.iceGatheringState === 'complete') done()
    }
    const onCandidate = (e: RTCPeerConnectionIceEvent): void => {
      if (e.candidate === null) {
        done()
        return
      }
      const line = e.candidate.candidate
      if (!/ udp /i.test(line)) return
      if (/ typ srflx/i.test(line)) {
        done()
        return
      }
      if (usable) return
      usable = true
      if (allStunFailed()) done()
      else if (stunUrls.length > 0) graceTimer = setTimeout(done, Math.max(0, stunGraceMs))
    }
    const onError = (e: RTCPeerConnectionIceErrorEvent): void => {
      if (typeof e.url === 'string' && e.url !== '') failed.add(e.url)
      if (usable && allStunFailed()) done()
    }
    const onTimeout = (): void => {
      if (usable || extended) {
        done()
        return
      }
      extended = true
      timer = setTimeout(onTimeout, wait)
    }
    let timer = setTimeout(onTimeout, wait)
    pc.addEventListener('icegatheringstatechange', onState)
    pc.addEventListener('icecandidate', onCandidate)
    pc.addEventListener('icecandidateerror', onError)
  })
}

/** Local (host) and public (any other type: srflx, prflx, relay) candidates in a compact SDP. Exported for the tests. */
export function countCandidates(c: CompactSdp): CandidateCount {
  let host = 0
  for (const cand of c.candidates) if (cand.typ === 'host') host++
  return { host, public: c.candidates.length - host }
}

/**
 * The local description in compact form and its pairing code, keeping the best few candidates
 * (at most CODE_MAX_CANDIDATES, fewer when the code would outgrow CODE_MAX_CHARS). An answer
 * carries the tag of the offer it answers. `mine` counts the candidates the code carries (what
 * the other device gets), not every candidate the browser gathered.
 */
function localCode(
  pc: RTCPeerConnection,
  type: 'offer' | 'answer',
  answersTo: number | null,
): { readonly code: string; readonly compact: CompactSdp; readonly mine: CandidateCount } {
  const sdp = pc.localDescription?.sdp
  if (typeof sdp !== 'string' || sdp === '') throw new PairingError(ERR_PREPARE)
  let compact: CompactSdp
  try {
    compact = parseSdp(sdp, type)
  } catch {
    throw new PairingError(ERR_PREPARE)
  }
  if (compact.candidates.length === 0) throw new PairingError(ERR_NO_NETWORK)
  try {
    const tagged: CompactSdp = answersTo === null ? compact : { ...compact, answersTo }
    const code = encodeCodeWithin(tagged, CODE_MAX_CANDIDATES, CODE_MAX_CHARS)
    return { code, compact, mine: countCandidates(decodeCode(code)) }
  } catch {
    throw new PairingError(ERR_PREPARE)
  }
}

/** Decode a scanned or pasted code, turning its error into a PairingError. */
function decodeUserCode(code: string): CompactSdp {
  try {
    return decodeCode(code)
  } catch (err) {
    throw new PairingError(err instanceof Error ? err.message : ERR_PREPARE)
  }
}

/**
 * Resolve with the link when its channel opens; reject when it closes first (closedMessage()) or
 * after timeoutMs (timeoutMessage; the link is then closed).
 */
function whenOpen(
  link: Link,
  timeoutMs: number,
  timeoutMessage: string,
  closedMessage: () => string,
): Promise<PeerLink> {
  return new Promise((resolve, reject) => {
    if (link.state === 'open') {
      resolve(link)
      return
    }
    if (link.state === 'closed') {
      reject(new PairingError(closedMessage()))
      return
    }
    const timer = setTimeout(() => {
      unwatch()
      reject(new PairingError(timeoutMessage))
      link.close()
    }, timeoutMs)
    const unwatch = link.watch((state) => {
      clearTimeout(timer)
      unwatch()
      if (state === 'open') resolve(link)
      else reject(new PairingError(closedMessage()))
    })
  })
}

class HubOffer implements Offer {
  readonly code: string
  private readonly pc: RTCPeerConnection
  private readonly link: Link
  /** offerTag of this offer: an answer made for it carries the same tag. */
  private readonly tag: number
  private readonly mine: CandidateCount
  /** Candidates of the answer taken by accept(); null before. */
  private theirs: CandidateCount | null = null
  private pending: Promise<PeerLink> | null = null
  private abort: ((err: Error) => void) | null = null
  private cancelled = false
  private delivered = false

  constructor(code: string, tag: number, mine: CandidateCount, pc: RTCPeerConnection, link: Link) {
    this.code = code
    this.tag = tag
    this.mine = mine
    this.pc = pc
    this.link = link
  }

  diag(): PairDiag {
    return { mine: this.mine, theirs: this.theirs, ice: this.link.ice }
  }

  accept(answerCode: string): Promise<PeerLink> {
    if (this.cancelled || this.link.state === 'closed') return Promise.reject(new PairingError(ERR_ENDED))
    // A second scan of an answer while connecting (or after) gets the same outcome.
    if (this.pending !== null) return this.pending
    let answer: CompactSdp
    try {
      answer = decodeUserCode(answerCode)
    } catch (err) {
      return Promise.reject(userError(err, ERR_ANSWER_REJECTED))
    }
    if (answer.type !== 'answer') return Promise.reject(new PairingError(ERR_HUB_CODE))
    // An answer to another offer (an older code, or one another station already used) could only
    // fail after the 20 s timeout; this offer stays usable for the right answer.
    if (answer.answersTo !== undefined && answer.answersTo !== this.tag) {
      return Promise.reject(new PairingError(ERR_OTHER_OFFER))
    }
    this.theirs = countCandidates(answer)

    const pending = new Promise<PeerLink>((resolve, reject) => {
      // cancel() rejects directly: operations pending on a closed RTCPeerConnection never settle.
      this.abort = reject
      this.connect(answer).then(resolve, reject)
    })
    this.pending = pending
    pending.then(
      () => {
        this.delivered = true
        this.abort = null
      },
      () => {
        this.abort = null
        // An attempt that failed before connecting (a bad answer) may be retried with another code.
        if (this.pending === pending && this.link.state !== 'closed' && !this.cancelled) this.pending = null
      },
    )
    return pending
  }

  cancel(): void {
    if (this.delivered || this.cancelled) return
    this.cancelled = true
    const abort = this.abort
    this.abort = null
    abort?.(new PairingError(ERR_CANCELLED))
    this.link.close()
  }

  private async connect(answer: CompactSdp): Promise<PeerLink> {
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: buildSdp(answer) })
    } catch {
      if (this.cancelled) throw new PairingError(ERR_CANCELLED)
      // setRemoteDescription failures leave the offer in place: another code can be tried.
      throw new PairingError(ERR_ANSWER_REJECTED)
    }
    return whenOpen(this.link, HUB_CONNECT_TIMEOUT_MS, ERR_CONNECT, () => (this.cancelled ? ERR_CANCELLED : ERR_CONNECT))
  }
}

/**
 * Hub side: start a pairing. Resolves once ICE gathering has finished (or after
 * cfg.pairingGatherTimeoutMs with what was gathered; twice that when nothing was) with the offer
 * code to show. Gathering asks the STUN servers in cfg.iceServers for this device's public
 * address, the only request that goes to an outside server; on the same network the code works
 * without it. Rejects with a user-presentable Error without WebRTC or without any network
 * candidate. The caller must either get a link from accept() or call cancel(), which releases the
 * connection.
 */
export async function createOffer(cfg: Config): Promise<Offer> {
  const pc = newPeerConnection(cfg)
  try {
    const link = new Link(pc, pc.createDataChannel(CHANNEL_LABEL, CHANNEL_INIT))
    await pc.setLocalDescription(await pc.createOffer())
    await gathered(pc, cfg.pairingGatherTimeoutMs, cfg.stunGraceMs, cfg.iceServers)
    const local = localCode(pc, 'offer', null)
    return new HubOffer(local.code, offerTag(local.compact), local.mine, pc, link)
  } catch (err) {
    closeQuietly(pc)
    throw userError(err, ERR_PREPARE)
  }
}

/**
 * Station side: answer a hub's offer code. Resolves as soon as the answer code is ready (to show
 * to the hub) with the link promise, which resolves when the channel opens and rejects after 60 s
 * or on cancel(). Preparing the code includes the same STUN lookup as createOffer. Rejects with a
 * user-presentable Error on a bad offer code, without WebRTC or without any network candidate. A
 * caller that abandons the answer before it connects should call cancel(), which releases the
 * connection at once.
 */
export async function answerOffer(offerCode: string, cfg: Config): Promise<Answer> {
  const offer = decodeUserCode(offerCode)
  if (offer.type !== 'offer') throw new PairingError(ERR_STATION_CODE)
  const pc = newPeerConnection(cfg)
  let link: Link
  let code: string
  let mine: CandidateCount
  try {
    link = new Link(pc, pc.createDataChannel(CHANNEL_LABEL, CHANNEL_INIT))
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: buildSdp(offer) })
    } catch {
      throw new PairingError(ERR_OFFER_REJECTED)
    }
    await pc.setLocalDescription(await pc.createAnswer())
    await gathered(pc, cfg.pairingGatherTimeoutMs, cfg.stunGraceMs, cfg.iceServers)
    const local = localCode(pc, 'answer', offerTag(offer))
    code = local.code
    mine = local.mine
  } catch (err) {
    closeQuietly(pc)
    throw userError(err, ERR_PREPARE)
  }
  let cancelled = false
  // Timing out usually means the hub never took the answer code, or the devices cannot reach each
  // other: a connection that fails while connecting is left to this timeout (see Link.onPeerState).
  // The station keeps a fresh answer knocking meanwhile (src/stationMode.ts, stationAnswerRefreshMs).
  const linkPromise = whenOpen(link, STATION_CONNECT_TIMEOUT_MS, ERR_STATION_TIMEOUT, () =>
    cancelled ? ERR_CANCELLED : ERR_CONNECT,
  )
  // Mark the rejection as handled for callers that leave before connecting; awaiting it still rejects.
  linkPromise.catch(() => undefined)
  const cancel = (): void => {
    if (link.state !== 'connecting') return
    cancelled = true
    link.close()
  }
  const theirs = countCandidates(offer)
  const diag = (): PairDiag => ({ mine, theirs, ice: link.ice })
  const iceConnected = (): boolean => pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed'
  return { code, link: linkPromise, cancel, iceConnected, diag }
}
