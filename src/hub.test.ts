import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIG } from './config.ts'
import type { Config } from './config.ts'
import type { Frame, ListenerView, Reading, StationsView } from './types.ts'
import { StationHub } from './hub.ts'
import { cleanStationName, LockFollower, StationRuntime } from './stationMode.ts'
import { ExtraMic, listAudioInputs } from './extraMics.ts'
import type { LinkState, Offer, PairDiag, PeerLink } from './net/peer.ts'
import { PROTOCOL_VERSION } from './net/protocol.ts'
import { createHunt, huntStep } from './dsp/hunt.ts'
import { iterateFrames, ReferenceAnalyser, synthSignal, toneLevelForSnr, tonePeakDb } from './dsp/synth.ts'
import type { ToneSpec } from './dsp/synth.ts'

const SR = 48000
const N = CONFIG.fftSize
const HOP = CONFIG.hopMs
const NOISE_DB = -60
const F0 = 3100
/** Sine amplitude (dBFS) giving a 30 dB per-bin peak SNR. */
const LEVEL = toneLevelForSnr(30, NOISE_DB, N)
/** Station clock minus hub clock in the tests (each device's performance.now() starts at its page load). */
const STATION_OFFSET_MS = 50_000
const WINDOW_MS = (N / SR) * 1000
/** peer.ts's message for a connection that never opened (a non-breaking hyphen in Wi‑Fi, as in the copy). */
const ERR_CONNECT =
  "Could not connect. On the same Wi‑Fi, try again. Across networks, scan the reply code as soon as it appears, or put both devices on one phone's hotspot."

// ---- Fakes -------------------------------------------------------------------------------------

type Msg = { readonly t: string } & Record<string, unknown>

/** In-memory PeerLink. Messages go through JSON like the real data channel and wait in the peer's inbox. */
class FakeLink implements PeerLink {
  state: LinkState
  onMessage: ((data: unknown) => void) | null = null
  onStateChange: ((s: LinkState) => void) | null = null
  /** Everything sent on this link, as the other side receives it. */
  readonly sent: Msg[] = []
  peer: FakeLink | null = null
  private readonly inbox: unknown[] = []

  constructor(state: LinkState = 'open') {
    this.state = state
  }

  send(message: unknown): boolean {
    if (this.state !== 'open') return false
    const wire = JSON.parse(JSON.stringify(message)) as Msg
    this.sent.push(wire)
    this.peer?.inbox.push(wire)
    return true
  }

  close(): void {
    this.setState('closed')
  }

  /** Inject a raw incoming message. */
  receive(raw: unknown): void {
    if (this.state !== 'closed') this.onMessage?.(raw)
  }

  /** Deliver the messages the peer sent since the last call. */
  deliver(): void {
    while (this.inbox.length > 0) this.receive(this.inbox.shift())
  }

  setState(s: LinkState): void {
    if (this.state === 'closed' || this.state === s) return
    this.state = s
    this.onStateChange?.(s)
  }

  types(): string[] {
    return this.sent.map((m) => m.t)
  }

  last(t: string): Msg | undefined {
    return this.sent.filter((m) => m.t === t).at(-1)
  }
}

function linkedPair(): [FakeLink, FakeLink] {
  const a = new FakeLink()
  const b = new FakeLink()
  a.peer = b
  b.peer = a
  return [a, b]
}

/** What the fakes report as pairing diagnostics. */
const FAKE_DIAG: PairDiag = { mine: { host: 1, public: 1 }, theirs: { host: 2, public: 1 }, ice: 'checking' }

class FakeOffer implements Offer {
  readonly code: string
  cancelled = false
  readonly answers: string[] = []
  /** Fails the connection of a 'SLOW' answer (peer.ts: no connection within its timeout). */
  failConnection: (err: Error) => void = () => undefined
  private readonly link: FakeLink

  constructor(code: string, link: FakeLink) {
    this.code = code
    this.link = link
  }

  diag(): PairDiag {
    return FAKE_DIAG
  }

  accept(answerCode: string): Promise<PeerLink> {
    this.answers.push(answerCode)
    if (answerCode === 'BAD') return Promise.reject(new Error('This code does not fit.'))
    if (answerCode === 'SLOW') return new Promise<PeerLink>((_res, rej) => (this.failConnection = rej))
    return Promise.resolve(this.link)
  }

  cancel(): void {
    this.cancelled = true
  }
}

interface HubRig {
  readonly hub: StationHub
  readonly clock: { now: number }
  readonly offers: FakeOffer[]
  /** Link handed out by the next offer (default: a fresh open FakeLink). */
  nextLink: (() => FakeLink) | null
  changes: number
  view(): StationsView
  listener(id: string): ListenerView
}

function hubRig(cfg: Config = CONFIG): HubRig {
  const clock = { now: 1000 }
  const offers: FakeOffer[] = []
  const rig: HubRig = {
    hub: null as unknown as StationHub,
    clock,
    offers,
    nextLink: null,
    changes: 0,
    view: () => rig.hub.view([], false),
    listener: (id) => {
      const l = rig.view().listeners.find((v) => v.id === id)
      if (l === undefined) throw new Error(`no listener ${id}`)
      return l
    },
  }
  ;(rig as { hub: StationHub }).hub = new StationHub({
    cfg,
    now: () => clock.now,
    onChange: () => {
      rig.changes++
    },
    hubName: 'Kitchen phone',
    createOffer: () => {
      const link = rig.nextLink?.() ?? new FakeLink()
      const offer = new FakeOffer(`OFFER-${offers.length + 1}`, link)
      offers.push(offer)
      return Promise.resolve(offer)
    },
  })
  return rig
}

/** Pair one station through the hub's pairing flow; returns the hub's end of the link. */
async function pair(rig: HubRig, link: FakeLink = new FakeLink()): Promise<FakeLink> {
  rig.nextLink = () => link
  await rig.hub.startPairing()
  await rig.hub.acceptAnswer('ANSWER')
  rig.nextLink = null
  return link
}

function hi(name: string): Msg {
  return { t: 'hi', v: PROTOCOL_VERSION, name, rawAudio: 'raw' }
}

/** Answer the hub's latest ping from a station whose clock is STATION_OFFSET_MS ahead, rttMs after it was sent. */
function pong(rig: HubRig, link: FakeLink, rttMs = 40): void {
  const ping = link.last('ping')
  if (ping === undefined) throw new Error('no ping sent')
  const hubMs = ping.hubMs as number
  rig.clock.now = hubMs + rttMs
  link.receive({ t: 'pong', id: ping.id, hubMs, stationMs: hubMs + rttMs / 2 + STATION_OFFSET_MS })
}

function reading(id: number, tMs: number, levelDb: number, extra: Partial<Reading> = {}): Reading {
  return {
    id,
    tMs,
    levelDb,
    snrDb: 25,
    verdict: 'first',
    deltaPrevDb: null,
    pct: null,
    isNewBest: false,
    clipped: false,
    chirpCount: 1,
    missedBefore: 0,
    source: 'chirp',
    ...extra,
  }
}

function stationChirp(hubOnsetMs: number, levelDb: number): Msg {
  return { t: 'chirp', onsetMs: hubOnsetMs + STATION_OFFSET_MS, levelDb, snrDb: 25, clipped: false }
}

// ---- Hub: pairing ------------------------------------------------------------------------------

describe('StationHub pairing', () => {
  it('shows the offer, registers the station when the link opens and greets it', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    await rig.hub.startPairing()
    expect(rig.view().pairing).toEqual({ step: 'showOffer', offerCode: 'OFFER-1', message: null, canScan: false, diag: FAKE_DIAG })
    rig.hub.setPairStep('pasteAnswer')
    expect(rig.view().pairing.step).toBe('pasteAnswer')
    expect(rig.view().pairing.offerCode).toBe('OFFER-1')

    const link = new FakeLink()
    rig.nextLink = () => link
    await rig.hub.startPairing() // a new pairing cancels the previous offer
    expect(rig.offers[0]!.cancelled).toBe(true)
    await rig.hub.acceptAnswer('  ANSWER\n')
    expect(rig.offers[1]!.answers).toEqual(['ANSWER'])

    const view = rig.view()
    expect(view.pairing.step).toBe('idle')
    expect(view.pairing.offerCode).toBeNull()
    expect(view.listeners.map((l) => [l.id, l.name, l.kind, l.status])).toEqual([
      ['self', 'This phone', 'self', 'listening'],
      ['station-1', 'Station 1', 'station', 'connecting'],
    ])
    expect(link.types()).toEqual(['hello', 'lock', 'ping'])
    expect(link.sent[0]).toEqual({ t: 'hello', v: PROTOCOL_VERSION, hubName: 'Kitchen phone' })
    expect(link.sent[1]).toEqual({ t: 'lock', f0Hz: null, mode: null })
    expect(link.sent[2]).toMatchObject({ t: 'ping', hubMs: 1000 })
  })

  it('registers a link that is still connecting only once it opens', async () => {
    const rig = hubRig()
    const link = new FakeLink('connecting')
    rig.nextLink = () => link
    await rig.hub.startPairing()
    await rig.hub.acceptAnswer('ANSWER')
    expect(rig.view().pairing.step).toBe('connecting')
    expect(rig.view().listeners).toHaveLength(0)
    expect(link.sent).toHaveLength(0)
    link.setState('open')
    expect(rig.view().pairing.step).toBe('idle')
    expect(rig.view().listeners.map((l) => l.id)).toEqual(['station-1'])
    expect(link.types()).toEqual(['hello', 'lock', 'ping'])
  })

  it('a rejected answer shows the error; another answer or a new pairing can follow', async () => {
    const rig = hubRig()
    await rig.hub.startPairing()
    await rig.hub.acceptAnswer('BAD')
    // The offer is still usable, so its code stays on screen for another scan or paste.
    expect(rig.view().pairing).toMatchObject({ step: 'error', message: 'This code does not fit.', offerCode: 'OFFER-1' })
    expect(rig.view().listeners).toHaveLength(0)
    // The offer stays usable: back to scanning, then the right answer connects.
    rig.hub.setPairStep('scanAnswer')
    expect(rig.view().pairing).toMatchObject({ step: 'scanAnswer', message: null, offerCode: 'OFFER-1' })
    await rig.hub.acceptAnswer('ANSWER')
    expect(rig.view().listeners.map((l) => l.id)).toEqual(['station-1'])

    await rig.hub.startPairing()
    await rig.hub.acceptAnswer('BAD')
    await rig.hub.startPairing()
    expect(rig.offers[1]!.cancelled).toBe(true)
    expect(rig.view().pairing).toMatchObject({ step: 'showOffer', offerCode: 'OFFER-3' })
  })

  it('reports a failed offer and can be cancelled', async () => {
    const clock = { now: 0 }
    const hub = new StationHub({
      cfg: CONFIG,
      now: () => clock.now,
      onChange: () => undefined,
      hubName: 'Hub',
      createOffer: () => Promise.reject(new Error('No network connection found.')),
    })
    await hub.startPairing()
    expect(hub.view([], true).pairing).toEqual({
      step: 'error',
      offerCode: null,
      message: 'No network connection found.',
      canScan: true,
    })
    hub.cancelPairing()
    expect(hub.view([], true).pairing.step).toBe('idle')
    expect(hub.view([], true).pairing.message).toBeNull()
  })

  it("carries the offer's pairing diagnostics while the offer is open, and not otherwise", async () => {
    const rig = hubRig()
    expect(rig.view().pairing).not.toHaveProperty('diag')
    await rig.hub.startPairing()
    expect(rig.view().pairing.diag).toEqual(FAKE_DIAG)
    const connecting = rig.hub.acceptAnswer('SLOW')
    expect(rig.view().pairing).toMatchObject({ step: 'connecting', diag: FAKE_DIAG })
    rig.clock.now += 20_000
    rig.offers[0]!.failConnection(new Error(ERR_CONNECT))
    await connecting
    expect(rig.view().pairing.step).toBe('error')
    // The failed attempt's diagnostics stay readable on the error step (the debug panel shows them) ...
    expect(rig.view().pairing.diag).toEqual(FAKE_DIAG)
    // ... until the pairing is cancelled or started again.
    rig.hub.cancelPairing()
    expect(rig.view().pairing).not.toHaveProperty('diag')
    await rig.hub.startPairing()
    expect(rig.view().pairing.diag).toEqual(FAKE_DIAG)
  })

  it('cancelPairing cancels the open offer; acceptAnswer without one is an error', async () => {
    const rig = hubRig()
    await rig.hub.startPairing()
    rig.hub.cancelPairing()
    expect(rig.offers[0]!.cancelled).toBe(true)
    expect(rig.view().pairing.step).toBe('idle')
    await rig.hub.acceptAnswer('ANSWER')
    expect(rig.view().pairing.step).toBe('error')
    expect(rig.view().listeners).toHaveLength(0)
  })
})

// ---- Hub: station messages ---------------------------------------------------------------------

describe('StationHub station messages', () => {
  it("'hi' renames the station and marks it listening", async () => {
    const rig = hubRig()
    const link = await pair(rig)
    link.receive(hi('  Bedroom  '))
    expect(rig.listener('station-1')).toMatchObject({ name: 'Bedroom', status: 'listening' })
    link.receive(hi('A very long station name that goes on'))
    expect(rig.listener('station-1').name).toBe('A very long station name'.slice(0, 24))
  })

  it('converts chirp onsets to hub time with the ping offset and compares them with self', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    const link = await pair(rig)
    link.receive(hi('Bedroom'))

    // Before any pong there is no offset: the chirp cannot be placed and is ignored.
    rig.clock.now = 1010
    link.receive(stationChirp(900, -30))
    expect(rig.view().comparison).toBeNull()

    pong(rig, link, 40)
    rig.clock.now = 5300
    link.receive(stationChirp(5000, -30))
    const c1 = rig.view().comparison
    expect(c1).not.toBeNull()
    expect(c1!.tMs).toBeCloseTo(5000, 6) // 55 000 on the station's clock
    expect(c1!.ranking.map((e) => e.id)).toEqual(['station-1'])

    // The hub's own reading of the same chirp (onset 120 ms later) joins the same comparison.
    const c2 = rig.hub.report('self', reading(7, 5120, -42))
    expect(c2.readingId).toBe(7)
    expect(c2.ranking.map((e) => [e.id, e.name, e.levelDb])).toEqual([
      ['station-1', 'Bedroom', -30],
      ['self', 'This phone', -42],
    ])
    expect(c2.loudestId).toBe('station-1')
    expect(c2.marginDb).toBeCloseTo(12, 9)
    expect(rig.hub.latestLoudestName()).toBe('Bedroom')
    expect(rig.view().comparison).toEqual(c2)
    const views = rig.view().listeners
    expect(views.find((v) => v.id === 'station-1')).toMatchObject({ isLoudest: true, levelDb: -30, deltaDb: 0 })
    expect(views.find((v) => v.id === 'self')).toMatchObject({ isLoudest: false, levelDb: -42, deltaDb: -12 })

    // A chirp far from the reading (another chirp) starts a new comparison.
    rig.clock.now = 40_000
    link.receive(stationChirp(39_000, -33))
    expect(rig.view().comparison!.ranking.map((e) => e.id)).toEqual(['station-1'])
    expect(rig.view().comparison!.readingId).toBeNull()
  })

  it('names nobody when the loudest does not beat the second by compareMinMarginDb', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    const link = await pair(rig)
    link.receive(hi('Hall'))
    pong(rig, link)
    rig.clock.now = 9000
    link.receive(stationChirp(8000, -40))
    const c = rig.hub.report('self', reading(1, 8050, -40 - CONFIG.compareMinMarginDb / 2))
    expect(c.ranking[0]!.id).toBe('station-1')
    expect(c.loudestId).toBeNull()
    expect(rig.hub.latestLoudestName()).toBeNull()
  })

  it('marks a silent station lost and brings it back when it speaks again', async () => {
    const rig = hubRig()
    const link = await pair(rig)
    link.receive(hi('Garage'))
    rig.hub.tick()
    const t0 = rig.clock.now
    for (let t = t0; t < t0 + CONFIG.listenerLostMs - 100; t += 100) {
      rig.clock.now = t
      rig.hub.tick()
    }
    expect(rig.listener('station-1').status).toBe('listening')
    // Pings went out every stationPingMs but were never answered.
    expect(link.types().filter((t) => t === 'ping').length).toBe(1 + Math.floor((CONFIG.listenerLostMs - 100) / CONFIG.stationPingMs))
    const before = rig.changes
    rig.clock.now = t0 + CONFIG.listenerLostMs + 50
    rig.hub.tick()
    expect(rig.listener('station-1').status).toBe('lost')
    expect(rig.changes).toBeGreaterThan(before)

    pong(rig, link, 30)
    expect(rig.listener('station-1').status).toBe('listening')
    expect(rig.listener('station-1').lastSeenMs).toBe(rig.clock.now)
  })

  it('keeps a station whose link closed, listed as lost, and stops talking to it', async () => {
    const rig = hubRig()
    const link = await pair(rig)
    link.receive(hi('Attic'))
    link.setState('closed')
    expect(rig.listener('station-1').status).toBe('lost')
    const sent = link.sent.length
    rig.clock.now += CONFIG.stationPingMs * 3
    rig.hub.tick()
    rig.hub.setLock(F0, 'chirp')
    expect(link.sent.length).toBe(sent)
    expect(rig.listener('station-1').status).toBe('lost')
  })

  it("a station's bye marks it lost and closes the link", async () => {
    const rig = hubRig()
    const link = await pair(rig)
    link.receive(hi('Attic'))
    link.receive({ t: 'bye' })
    expect(rig.listener('station-1').status).toBe('lost')
    expect(link.state).toBe('closed')
  })

  it('removeListener says bye to a station, closes its link and forgets it', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    const link = await pair(rig)
    link.receive(hi('Office'))
    rig.hub.removeListener('station-1')
    expect(link.sent.at(-1)).toEqual({ t: 'bye' })
    expect(link.state).toBe('closed')
    expect(rig.view().listeners.map((l) => l.id)).toEqual(['self'])
    // Messages arriving after the removal are ignored.
    link.onMessage?.(hi('Ghost'))
    expect(rig.view().listeners.map((l) => l.id)).toEqual(['self'])
  })

  it('setLock is broadcast to every open station once, and sent to stations paired later', async () => {
    const rig = hubRig()
    const a = await pair(rig)
    const b = await pair(rig)
    rig.hub.setLock(F0, 'chirp')
    expect(a.last('lock')).toEqual({ t: 'lock', f0Hz: F0, mode: 'chirp' })
    expect(b.last('lock')).toEqual({ t: 'lock', f0Hz: F0, mode: 'chirp' })
    const count = a.types().filter((t) => t === 'lock').length
    rig.hub.setLock(F0, 'chirp')
    expect(a.types().filter((t) => t === 'lock').length).toBe(count)
    rig.hub.setLock(F0, 'live')
    expect(b.last('lock')).toEqual({ t: 'lock', f0Hz: F0, mode: 'live' })

    const c = await pair(rig)
    expect(c.sent[1]).toEqual({ t: 'lock', f0Hz: F0, mode: 'live' })
    expect(rig.view().listeners.map((l) => l.name)).toEqual(['Station 1', 'Station 2', 'Station 3'])

    rig.hub.setLock(null, null)
    for (const l of [a, b, c]) expect(l.last('lock')).toEqual({ t: 'lock', f0Hz: null, mode: null })
  })

  it('ignores invalid messages entirely', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    const link = await pair(rig)
    pong(rig, link)
    const seen = rig.listener('station-1').lastSeenMs
    const changes = rig.changes
    rig.clock.now += 5000
    const junk: unknown[] = [
      'hi',
      42,
      null,
      [],
      { t: 'teleport' },
      { t: 'hi', v: PROTOCOL_VERSION, name: '', rawAudio: 'raw' },
      { t: 'hi', v: PROTOCOL_VERSION, name: 'Evil' + String.fromCodePoint(0x202e) + 'Name', rawAudio: 'raw' },
      { t: 'hi', v: PROTOCOL_VERSION, name: 'Den', rawAudio: 'cooked' },
      { t: 'chirp', onsetMs: 'soon', levelDb: -30, snrDb: 20, clipped: false },
      { t: 'chirp', onsetMs: 60_000, levelDb: Number.NaN, snrDb: 20, clipped: false },
      { t: 'chirp', onsetMs: 60_000, levelDb: -30, snrDb: 20 },
      { t: 'pong', id: -1, hubMs: 1000, stationMs: 51_000 },
      { t: 'level', levelDb: -30, atMs: 60_000, clipped: 'no' },
    ]
    for (const j of junk) link.receive(j)
    expect(rig.listener('station-1')).toMatchObject({ name: 'Station 1', status: 'listening', lastSeenMs: seen })
    expect(rig.view().comparison).toBeNull()
    expect(rig.changes).toBe(changes)
    // A pong for a ping the hub never sent is valid, but does not change the clock estimate.
    link.receive({ t: 'pong', id: 9999, hubMs: 0, stationMs: 0 })
    rig.clock.now = 7000
    link.receive(stationChirp(6000, -30))
    expect(rig.view().comparison!.tMs).toBeCloseTo(6000, 6)
  })

  it('pings every stationPingMs and uses the recorded send time', async () => {
    const rig = hubRig()
    const link = await pair(rig)
    const t0 = rig.clock.now
    rig.clock.now = t0 + CONFIG.stationPingMs - 1
    rig.hub.tick()
    expect(link.types().filter((t) => t === 'ping')).toHaveLength(1)
    rig.clock.now = t0 + CONFIG.stationPingMs
    rig.hub.tick()
    const pings = link.sent.filter((m) => m.t === 'ping')
    expect(pings).toHaveLength(2)
    expect(pings[1]!.hubMs).toBe(t0 + CONFIG.stationPingMs)
    expect(pings[1]!.id).not.toBe(pings[0]!.id)
    // The station echoes a wrong hubMs: the hub trusts its own record of the send time.
    rig.clock.now = t0 + CONFIG.stationPingMs + 20
    link.receive({ t: 'pong', id: pings[1]!.id, hubMs: 0, stationMs: t0 + CONFIG.stationPingMs + 10 + STATION_OFFSET_MS })
    rig.clock.now = 20_000
    link.receive(stationChirp(19_000, -30))
    expect(rig.view().comparison!.tMs).toBeCloseTo(19_000, 6)
  })

  it('calibration tells the stations and equalises levels on a chirp heard by everyone', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    const link = await pair(rig)
    link.receive(hi('Den'))
    pong(rig, link)
    rig.hub.calibrate()
    expect(link.last('calibrate')).toEqual({ t: 'calibrate', on: true })
    expect(rig.view().calibrating).toBe(true)

    rig.clock.now = 10_000
    rig.hub.report('self', reading(1, 9000, -36))
    expect(rig.view().calibrating).toBe(true)
    link.receive(stationChirp(9100, -30))
    expect(rig.view().calibrating).toBe(false)
    expect(link.last('calibrate')).toEqual({ t: 'calibrate', on: false })
    expect(rig.listener('station-1').offsetDb).toBeCloseTo(-6, 9)

    // Next chirp: 10 dB raw difference is 4 dB after calibration, enough to name the station.
    rig.clock.now = 40_000
    rig.hub.report('self', reading(2, 39_000, -40))
    link.receive(stationChirp(39_050, -30))
    const c = rig.view().comparison!
    expect(c.readingId).toBe(2)
    expect(c.ranking[0]).toMatchObject({ id: 'station-1', levelDb: -36 })
    expect(c.loudestId).toBe('station-1')

    rig.hub.calibrate()
    rig.hub.cancelCalibration()
    expect(rig.view().calibrating).toBe(false)
    expect(link.last('calibrate')).toEqual({ t: 'calibrate', on: false })
  })

  it('shows the live comparison while live levels arrive, then the last chirp comparison', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    rig.hub.addLocalListener('mic:usb', 'USB mic', 'mic')
    const link = await pair(rig)
    link.receive(hi('Loft'))
    pong(rig, link)
    rig.hub.setLock(F0, 'live')
    rig.clock.now = 20_000
    rig.hub.liveLevel('self', -50, false)
    rig.hub.liveLevel('mic:usb', -47, false)
    link.receive({ t: 'level', levelDb: -40, atMs: 19_900 + STATION_OFFSET_MS, clipped: false })
    const live = rig.view().comparison!
    expect(live.readingId).toBeNull()
    expect(live.ranking.map((e) => e.id)).toEqual(['station-1', 'mic:usb', 'self'])
    expect(live.loudestId).toBe('station-1')
    expect(rig.view().listeners.map((l) => l.id)).toEqual(['self', 'mic:usb', 'station-1'])

    rig.clock.now = 20_000 + CONFIG.liveHoldMs + 2 * CONFIG.stationLevelReportMs
    expect(rig.view().comparison).toBeNull()
  })

  it('an extra mic report is compared without a reading id; mics already added are not offered again', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    rig.hub.addLocalListener('mic:usb', 'USB mic', 'mic')
    rig.hub.report('self', reading(3, 5000, -45))
    const c = rig.hub.report('mic:usb', reading(1, 5040, -38))
    expect(c.readingId).toBe(3)
    expect(c.loudestId).toBe('mic:usb')
    expect(rig.hub.latestLoudestName()).toBe('USB mic')
    const mics = [
      { deviceId: 'usb', label: 'USB mic' },
      { deviceId: 'headset', label: 'Headset' },
    ]
    expect(rig.hub.view(mics, false).availableMics).toEqual([{ deviceId: 'headset', label: 'Headset' }])
    // Local listeners never go lost, even without chirps for a long time.
    for (let t = 5000; t < 5000 + 3 * CONFIG.listenerLostMs; t += 500) {
      rig.clock.now = t
      rig.hub.tick()
    }
    expect(rig.view().listeners.every((l) => l.status === 'listening')).toBe(true)
  })

  it('dispose says bye to every open station and closes the pairing', async () => {
    const rig = hubRig()
    const a = await pair(rig)
    const b = await pair(rig)
    await rig.hub.startPairing()
    rig.hub.dispose()
    expect(a.sent.at(-1)).toEqual({ t: 'bye' })
    expect(b.sent.at(-1)).toEqual({ t: 'bye' })
    expect(a.state).toBe('closed')
    expect(b.state).toBe('closed')
    expect(rig.offers.at(-1)!.cancelled).toBe(true)
  })
})

describe('StationHub edge cases', () => {
  it('a station that never sends a valid message goes lost after listenerLostMs, and recovers when it does', async () => {
    const rig = hubRig()
    const link = await pair(rig)
    const t0 = rig.clock.now
    link.receive({ t: 'hi', v: PROTOCOL_VERSION, name: 'Old app', rawAudio: 'maybe' })
    rig.clock.now = t0 + CONFIG.listenerLostMs - 1
    rig.hub.tick()
    expect(rig.listener('station-1').status).toBe('connecting')
    const before = rig.changes
    rig.clock.now = t0 + CONFIG.listenerLostMs
    rig.hub.tick()
    expect(rig.listener('station-1').status).toBe('lost')
    expect(rig.changes).toBeGreaterThan(before)
    link.receive(hi('Late'))
    expect(rig.listener('station-1')).toMatchObject({ name: 'Late', status: 'listening' })
  })

  it('tick notices a link that closed without an event and stops talking to it', async () => {
    const rig = hubRig()
    const link = await pair(rig)
    link.receive(hi('Shed'))
    link.state = 'closed' // no onStateChange
    rig.hub.tick()
    expect(rig.listener('station-1').status).toBe('lost')
    const sent = link.sent.length
    rig.clock.now += 2 * CONFIG.stationPingMs
    rig.hub.tick()
    rig.hub.setLock(F0, 'chirp')
    rig.hub.calibrate()
    expect(link.sent.length).toBe(sent)
  })

  it('a link that closes before it opens is a pairing error; cancel closes a link still connecting', async () => {
    const rig = hubRig()
    const early = new FakeLink('connecting')
    rig.nextLink = () => early
    await rig.hub.startPairing()
    await rig.hub.acceptAnswer('ANSWER')
    early.setState('closed')
    expect(rig.view().pairing).toMatchObject({ step: 'error', message: 'The connection closed before it opened.' })
    expect(rig.view().listeners).toHaveLength(0)

    const slow = new FakeLink('connecting')
    rig.nextLink = () => slow
    await rig.hub.startPairing()
    await rig.hub.acceptAnswer('ANSWER')
    expect(rig.view().pairing.step).toBe('connecting')
    rig.hub.cancelPairing()
    expect(slow.state).toBe('closed')
    expect(rig.view().pairing).toMatchObject({ step: 'idle', message: null })
    expect(rig.view().listeners).toHaveLength(0)
  })

  it('an answer while the offer is still being prepared is ignored and does not abandon it', async () => {
    let resolveOffer: (o: Offer) => void = () => undefined
    const offer = new FakeOffer('OFFER-X', new FakeLink())
    const hub = new StationHub({
      cfg: CONFIG,
      now: () => 0,
      onChange: () => undefined,
      hubName: 'Hub',
      createOffer: () => new Promise<Offer>((res) => (resolveOffer = res)),
    })
    const preparing = hub.startPairing()
    expect(hub.view([], false).pairing.step).toBe('preparing')
    await hub.acceptAnswer('ANSWER')
    expect(hub.view([], false).pairing.step).toBe('preparing')
    resolveOffer(offer)
    await preparing
    expect(hub.view([], false).pairing).toMatchObject({ step: 'showOffer', offerCode: 'OFFER-X' })
    expect(offer.cancelled).toBe(false)
    expect(offer.answers).toEqual([])
  })

  it('setLock forgets chirp comparisons on relisten or a new frequency, not on drift or a mode switch', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    rig.hub.setLock(F0, 'chirp')
    rig.hub.report('self', reading(1, 5000, -40))
    rig.hub.setLock(F0 * 1.01, 'chirp')
    rig.hub.setLock(F0 * 1.01, 'live')
    expect(rig.view().comparison?.readingId).toBe(1)
    rig.hub.setLock(F0 * 1.2, 'chirp')
    expect(rig.view().comparison).toBeNull()
    rig.hub.report('self', reading(2, 9000, -40))
    rig.hub.setLock(null, null)
    expect(rig.view().comparison).toBeNull()

    // A frequency the stations would reject is no lock at all (they would keep the old one).
    const link = await pair(rig)
    for (const bad of [-5, 0, Number.NaN, 1e9]) {
      rig.hub.setLock(F0, 'chirp')
      rig.hub.setLock(bad, 'chirp')
      expect(link.last('lock')).toEqual({ t: 'lock', f0Hz: null, mode: null })
    }
  })

  it('live levels are compared only in live mode; afterwards the chirp comparison is back', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    const link = await pair(rig)
    link.receive(hi('Loft'))
    pong(rig, link)
    rig.hub.setLock(F0, 'chirp')
    rig.clock.now = 20_000
    rig.hub.report('self', reading(4, 19_500, -44))
    // A station whose own hunt went live sends levels while the hub is in chirp mode.
    link.receive({ t: 'level', levelDb: -30, atMs: 19_990 + STATION_OFFSET_MS, clipped: false })
    rig.hub.liveLevel('self', -50, false)
    expect(rig.view().comparison).toMatchObject({ readingId: 4 })

    rig.hub.setLock(F0, 'live')
    expect(rig.view().comparison).toMatchObject({ readingId: null, loudestId: 'station-1' })
    expect(rig.view().comparison!.ranking.map((e) => e.id)).toEqual(['station-1', 'self'])
    rig.clock.now = 20_000 + 3 * CONFIG.stationLevelReportMs
    expect(rig.view().comparison).toMatchObject({ readingId: 4 })
  })

  it("a level before any clock offset is stamped with the hub's arrival time", async () => {
    const rig = hubRig()
    const link = await pair(rig)
    link.receive(hi('Porch'))
    rig.hub.setLock(F0, 'live')
    rig.clock.now = 3000
    link.receive({ t: 'level', levelDb: -40, atMs: 999_999, clipped: false })
    expect(rig.view().comparison!.ranking).toEqual([{ id: 'station-1', name: 'Porch', levelDb: -40, clipped: false }])
    expect(rig.listener('station-1').lastSeenMs).toBe(3000)
    rig.clock.now = 3000 + 3 * CONFIG.stationLevelReportMs - 1
    rig.hub.tick()
    const changes = rig.changes
    expect(rig.view().comparison).not.toBeNull()
    rig.clock.now = 3000 + 3 * CONFIG.stationLevelReportMs
    rig.hub.tick() // the level went stale: the panel must be redrawn although nothing arrived
    expect(rig.changes).toBe(changes + 1)
    expect(rig.view().comparison).toBeNull()
    rig.hub.tick()
    expect(rig.changes).toBe(changes + 1)
  })

  it("a station's merged chirp (same onset) keeps its louder level in the comparison", async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    const link = await pair(rig)
    link.receive(hi('Hall'))
    pong(rig, link)
    rig.clock.now = 9000
    rig.hub.report('self', reading(6, 8050, -40))
    link.receive(stationChirp(8000, -39))
    expect(rig.view().comparison!.loudestId).toBeNull()
    link.receive(stationChirp(8000, -33)) // the second chirp of a double chirp was louder
    link.receive(stationChirp(8000, -45)) // a quieter update does not lower it
    const c = rig.view().comparison!
    expect(c.readingId).toBe(6)
    expect(c.ranking.map((e) => [e.id, e.levelDb])).toEqual([
      ['station-1', -33],
      ['self', -40],
    ])
    expect(c.loudestId).toBe('station-1')
  })

  it('loudestNameFor names the loudest of one reading, also when the station report comes later', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    const link = await pair(rig)
    link.receive(hi('Porch'))
    pong(rig, link)
    rig.clock.now = 9000
    rig.hub.report('self', reading(5, 8000, -45))
    expect(rig.hub.loudestNameFor(5)).toBeNull()
    link.receive(stationChirp(8100, -35))
    expect(rig.hub.loudestNameFor(5)).toBe('Porch')
    // A later chirp only the station heard is the last comparison now; reading 5 keeps its answer.
    rig.clock.now = 40_000
    link.receive(stationChirp(39_000, -30))
    expect(rig.hub.latestLoudestName()).toBeNull()
    expect(rig.hub.loudestNameFor(5)).toBe('Porch')
    expect(rig.hub.loudestNameFor(99)).toBeNull()
  })

  it('after dispose nothing reaches the stations or the UI any more', async () => {
    const rig = hubRig()
    const link = await pair(rig)
    link.receive(hi('Den'))
    const offers = rig.offers.length
    rig.hub.dispose()
    const sent = link.sent.length
    const changes = rig.changes
    rig.clock.now += 2 * CONFIG.stationPingMs
    rig.hub.tick()
    rig.hub.setLock(F0, 'chirp')
    rig.hub.calibrate()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    await rig.hub.startPairing()
    await rig.hub.acceptAnswer('ANSWER')
    expect(link.sent.length).toBe(sent)
    expect(link.sent.at(-1)).toEqual({ t: 'bye' })
    expect(rig.changes).toBe(changes)
    expect(rig.offers.length).toBe(offers)
  })

  it('a connection that fails after the answer was taken ends the offer; a code rejected at once keeps it', async () => {
    const rig = hubRig()
    await rig.hub.startPairing()
    const ended = rig.offers[0]!
    const connecting = rig.hub.acceptAnswer('SLOW')
    expect(rig.view().pairing.step).toBe('connecting')
    rig.clock.now += 20_000 // peer.ts gives up after 20 s without a connection; the offer has ended
    ended.failConnection(new Error(ERR_CONNECT))
    await connecting
    expect(rig.view().pairing).toEqual({
      step: 'error',
      offerCode: null,
      message: ERR_CONNECT,
      canScan: false,
      diag: FAKE_DIAG, // the failed attempt's diagnostics stay readable on the error step
    })
    expect(ended.cancelled).toBe(true)
    // Its code is not shown again and no further answer goes to it.
    rig.hub.setPairStep('showOffer')
    expect(rig.view().pairing).toMatchObject({ step: 'error', offerCode: null })
    await rig.hub.acceptAnswer('ANSWER')
    expect(ended.answers).toEqual(['SLOW'])
    expect(rig.view().pairing).toMatchObject({ step: 'error', offerCode: null })
    expect(rig.view().listeners).toHaveLength(0)
    await rig.hub.startPairing()
    expect(rig.view().pairing).toMatchObject({ step: 'showOffer', offerCode: 'OFFER-2' })

    // Rejected quickly: a problem with the code itself (peer.ts keeps the offer for another answer).
    const kept = rig.offers[1]!
    const quick = rig.hub.acceptAnswer('SLOW')
    rig.clock.now += 40
    kept.failConnection(new Error('This code does not fit. Scan the code shown on the station again.'))
    await quick
    // Kept offer: its code stays visible in the error step (unlike the ended offer above).
    expect(rig.view().pairing).toMatchObject({ step: 'error', offerCode: 'OFFER-2' })
    expect(kept.cancelled).toBe(false)
    rig.hub.setPairStep('scanAnswer')
    expect(rig.view().pairing).toMatchObject({ step: 'scanAnswer', offerCode: 'OFFER-2', message: null })
    await rig.hub.acceptAnswer('ANSWER')
    expect(rig.view().listeners.map((l) => l.id)).toEqual(['station-1'])
  })

  it('in a live lock, calibration completes on fresh live levels from every listener received after the request', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    const link = await pair(rig)
    link.receive(hi('Loft'))
    pong(rig, link)

    // Chirp lock: live levels (a station's own hunt went live) do not calibrate.
    rig.hub.setLock(F0, 'chirp')
    rig.hub.calibrate()
    rig.clock.now = 20_000
    rig.hub.liveLevel('self', -50, false)
    link.receive({ t: 'level', levelDb: -44, atMs: 19_990 + STATION_OFFSET_MS, clipped: false })
    expect(rig.view().calibrating).toBe(true)
    rig.hub.cancelCalibration()

    // Live lock: levels from before the request do not count (the devices may not be together yet).
    rig.hub.setLock(F0, 'live')
    rig.clock.now = 21_000
    rig.hub.liveLevel('self', -50, false)
    link.receive({ t: 'level', levelDb: -44, atMs: 20_990 + STATION_OFFSET_MS, clipped: false })
    rig.hub.calibrate()
    expect(link.last('calibrate')).toEqual({ t: 'calibrate', on: true })
    rig.clock.now = 21_400
    rig.hub.liveLevel('self', -52, false)
    expect(rig.view().calibrating).toBe(true)
    link.receive({ t: 'level', levelDb: -46, atMs: 21_390 + STATION_OFFSET_MS, clipped: false })
    expect(rig.view().calibrating).toBe(false)
    expect(link.last('calibrate')).toEqual({ t: 'calibrate', on: false })
    expect(rig.listener('station-1').offsetDb).toBeCloseTo(-6, 9)
    expect(rig.listener('self').offsetDb).toBe(0)
    const c = rig.view().comparison!
    expect(c.ranking.map((e) => [e.id, e.levelDb])).toEqual([
      ['self', -52],
      ['station-1', -52],
    ])
    expect(c.loudestId).toBeNull()
  })
})

describe('StationHub races and untrusted reports', () => {
  it('dispose while an offer is being prepared cancels it on arrival, silently', async () => {
    let resolveOffer: (o: Offer) => void = () => undefined
    const offer = new FakeOffer('OFFER-X', new FakeLink())
    let changes = 0
    const hub = new StationHub({
      cfg: CONFIG,
      now: () => 0,
      onChange: () => {
        changes++
      },
      hubName: 'Hub',
      createOffer: () => new Promise<Offer>((res) => (resolveOffer = res)),
    })
    const preparing = hub.startPairing()
    hub.dispose()
    const after = changes
    resolveOffer(offer)
    await preparing
    expect(offer.cancelled).toBe(true)
    expect(changes).toBe(after)
    expect(hub.view([], false).pairing.offerCode).toBeNull()
  })

  it('dispose while an answer is being accepted closes the link that arrives afterwards', async () => {
    let resolveLink: (l: PeerLink) => void = () => undefined
    const link = new FakeLink()
    const hub = new StationHub({
      cfg: CONFIG,
      now: () => 0,
      onChange: () => undefined,
      hubName: 'Hub',
      createOffer: () =>
        Promise.resolve<Offer>({
          code: 'OFFER-Y',
          // Resolves even after cancel(): the hub must not rely on the rejection.
          accept: () => new Promise<PeerLink>((res) => (resolveLink = res)),
          cancel: () => undefined,
          diag: () => FAKE_DIAG,
        }),
    })
    await hub.startPairing()
    const accepting = hub.acceptAnswer('ANSWER')
    hub.dispose()
    resolveLink(link)
    await accepting
    expect(link.state).toBe('closed')
    expect(link.sent).toHaveLength(0)
    expect(hub.view([], false).listeners).toHaveLength(0)
  })

  it('a second answer while connecting is ignored; a new pairing closes the link still connecting', async () => {
    const rig = hubRig()
    const slow = new FakeLink('connecting')
    rig.nextLink = () => slow
    await rig.hub.startPairing()
    await rig.hub.acceptAnswer('ANSWER')
    await rig.hub.acceptAnswer('ANSWER-AGAIN')
    expect(rig.offers[0]!.answers).toEqual(['ANSWER'])
    rig.hub.setPairStep('showOffer')
    expect(rig.view().pairing).toMatchObject({ step: 'connecting', offerCode: null })
    rig.nextLink = null
    await rig.hub.startPairing()
    expect(slow.state).toBe('closed')
    expect(rig.view().pairing).toMatchObject({ step: 'showOffer', offerCode: 'OFFER-2' })
    expect(rig.view().listeners).toHaveLength(0)
  })

  it('ignores a station chirp whose onset lies in the future on the hub clock', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    rig.hub.setLock(F0, 'chirp')
    const link = await pair(rig)
    link.receive(hi('Hall'))
    pong(rig, link)
    rig.clock.now = 9000
    rig.hub.report('self', reading(1, 8900, -40))
    link.receive(stationChirp(9000 + CONFIG.compareWindowMs + 1, -30))
    expect(rig.view().comparison!.ranking.map((e) => e.id)).toEqual(['self'])
    // Still a valid message from a live station.
    expect(rig.listener('station-1')).toMatchObject({ status: 'listening', lastSeenMs: 9000 })
    // A little in the future (a clock estimate slightly off) is fine and matches the reading.
    link.receive(stationChirp(9100, -30))
    const c = rig.view().comparison!
    expect(c.readingId).toBe(1)
    expect(c.ranking.map((e) => e.id)).toEqual(['station-1', 'self'])
  })

  it("a station's report of the old beep that arrives after relisten does not outlive the next lock", async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    rig.hub.setLock(F0, 'chirp')
    const link = await pair(rig)
    link.receive(hi('Hall'))
    pong(rig, link)
    rig.clock.now = 9000
    rig.hub.report('self', reading(3, 8000, -40))
    rig.hub.setLock(null, null) // relisten
    link.receive(stationChirp(8050, -30)) // was already on its way
    // The same beep locked again: a new hunt, whose reading ids start over.
    rig.hub.setLock(F0 * 1.001, 'chirp')
    expect(rig.view().comparison).toBeNull()
    expect(rig.hub.latestLoudestName()).toBeNull()
    const c = rig.hub.report('self', reading(1, 30_000, -41))
    expect(c.ranking.map((e) => e.id)).toEqual(['self'])
  })

  it('removing the only listener that missed the calibration chirp completes the calibration', async () => {
    const rig = hubRig()
    rig.hub.addLocalListener('self', 'This phone', 'self')
    rig.hub.addLocalListener('mic:usb', 'USB mic', 'mic')
    const link = await pair(rig)
    link.receive(hi('Den'))
    pong(rig, link)
    rig.hub.calibrate()
    rig.clock.now = 10_000
    rig.hub.report('self', reading(1, 9000, -36))
    link.receive(stationChirp(9100, -30))
    expect(rig.view().calibrating).toBe(true) // the USB mic did not hear it
    rig.hub.removeListener('mic:usb')
    expect(rig.view().calibrating).toBe(false)
    expect(link.last('calibrate')).toEqual({ t: 'calibrate', on: false })
    expect(rig.listener('station-1').offsetDb).toBeCloseTo(-6, 9)
  })
})

// ---- Station runtime---------------------------------------------------------------------------

interface StationRig {
  readonly station: StationRuntime
  readonly clock: { now: number }
  readonly link: FakeLink
  resolveLink: (l: PeerLink) => void
  /** Fails the link of the latest answer (peer.ts: the hub never connected within 60 s). */
  rejectLink: (err: Error) => void
  rejectAnswer: boolean
  /** Answer.cancel() calls (the station releasing an abandoned attempt). */
  cancels: number
  /** Station clock at every onChange call. */
  readonly changeAt: number[]
}

function stationRig(link: FakeLink = new FakeLink()): StationRig {
  const clock = { now: 0 }
  let resolveLink: (l: PeerLink) => void = () => undefined
  let rejectLink: (err: Error) => void = () => undefined
  const rig: StationRig = {
    station: null as unknown as StationRuntime,
    clock,
    link,
    resolveLink: (l) => resolveLink(l),
    rejectLink: (err) => rejectLink(err),
    rejectAnswer: false,
    cancels: 0,
    changeAt: [],
  }
  ;(rig as { station: StationRuntime }).station = new StationRuntime({
    cfg: CONFIG,
    now: () => clock.now,
    onChange: () => {
      rig.changeAt.push(clock.now)
    },
    answerOffer: (code) => {
      if (rig.rejectAnswer || code !== 'OFFER') return Promise.reject(new Error('This is not a Soundwave pairing code.'))
      return Promise.resolve({
        code: 'ANSWER-CODE',
        link: new Promise<PeerLink>((res, rej) => {
          resolveLink = res
          rejectLink = rej
        }),
        cancel: () => {
          rig.cancels++
        },
        iceConnected: () => false,
        diag: () => FAKE_DIAG,
      })
    },
  })
  return rig
}

async function connectStation(rig: StationRig): Promise<void> {
  rig.station.setName('Garage')
  rig.station.micReady(true)
  const done = rig.station.acceptOffer('OFFER')
  await Promise.resolve()
  await Promise.resolve()
  rig.resolveLink(rig.link)
  await done
}

function stationFrames(tones: readonly ToneSpec[], durationS: number, tOffsetMs = 0): Frame[] {
  const x = synthSignal({ sampleRate: SR, durationS, noiseDb: NOISE_DB, seed: 7, tones })
  return Array.from(iterateFrames(x, SR, { fftSize: N, hopMs: HOP, tOffsetMs }))
}

function feedStation(rig: StationRig, frames: readonly Frame[]): void {
  for (const f of frames) {
    rig.clock.now = f.tMs
    rig.station.onFrame(f)
  }
}

describe('StationRuntime', () => {
  it('walks through naming and pairing, says hi and answers pings', async () => {
    const rig = stationRig()
    const s = rig.station
    expect(s.view(true)).toMatchObject({ step: 'name', name: 'Station', answerCode: null, f0Hz: null, chirpsSent: 0 })
    s.setName('   Garage \n  freezer   ')
    expect(s.view(true)).toMatchObject({ step: 'starting', name: 'Garage freezer' })
    s.micReady(false)
    expect(s.view(false).step).toBe('pasteOffer')
    s.setStep('scanOffer')
    expect(s.view(true).step).toBe('scanOffer')
    s.setRawAudio('raw')

    const done = s.acceptOffer(' OFFER ')
    expect(s.view(true).step).toBe('answering')
    await Promise.resolve()
    await Promise.resolve()
    expect(s.view(true)).toMatchObject({ step: 'showAnswer', answerCode: 'ANSWER-CODE' })
    rig.resolveLink(rig.link)
    await done
    expect(s.view(true)).toMatchObject({ step: 'connected', answerCode: null, message: null })
    expect(rig.link.sent[0]).toEqual({ t: 'hi', v: PROTOCOL_VERSION, name: 'Garage freezer', rawAudio: 'raw' })

    rig.link.receive({ t: 'hello', v: PROTOCOL_VERSION, hubName: 'Kitchen phone' })
    expect(s.hubName).toBe('Kitchen phone')
    rig.clock.now = 123_456.5
    rig.link.receive({ t: 'ping', id: 3, hubMs: 1234 })
    expect(rig.link.last('pong')).toEqual({ t: 'pong', id: 3, hubMs: 1234, stationMs: 123_456.5 })
    rig.link.receive({ t: 'lock', f0Hz: F0, mode: 'chirp' })
    expect(s.view(true).f0Hz).toBe(F0)
    rig.link.receive({ t: 'lock', f0Hz: null, mode: null })
    expect(s.view(true).f0Hz).toBeNull()
    // Invalid hub messages are ignored.
    rig.link.receive({ t: 'lock', f0Hz: -5, mode: 'chirp' })
    rig.link.receive({ t: 'ping', id: 'x', hubMs: 1 })
    rig.link.receive('bye')
    expect(s.view(true)).toMatchObject({ step: 'connected', f0Hz: null })
    expect(rig.link.types().filter((t) => t === 'pong')).toHaveLength(1)
  })

  it('shows an error for a bad offer code and can start over', async () => {
    const rig = stationRig()
    rig.station.setName('Den')
    rig.station.micReady(true)
    await rig.station.acceptOffer('NOT-A-CODE')
    expect(rig.station.view(true)).toMatchObject({ step: 'error', message: 'This is not a Soundwave pairing code.' })
    rig.station.setStep('scanOffer')
    expect(rig.station.view(true)).toMatchObject({ step: 'scanOffer', message: null })
  })

  it("goes 'lost' on the hub's bye or when the link closes, and dispose says bye", async () => {
    const a = stationRig()
    await connectStation(a)
    a.link.receive({ t: 'bye' })
    expect(a.station.view(true).step).toBe('lost')
    expect(a.link.state).toBe('closed')

    const b = stationRig()
    await connectStation(b)
    b.link.setState('closed')
    expect(b.station.view(true).step).toBe('lost')

    const c = stationRig()
    await connectStation(c)
    c.station.dispose()
    expect(c.link.sent.at(-1)).toEqual({ t: 'bye' })
    expect(c.link.state).toBe('closed')
  })

  it("a chirp at the hub's frequency produces exactly one 'chirp' message with a plausible level", async () => {
    const rig = stationRig()
    await connectStation(rig)
    // Before the lock nothing is measured.
    feedStation(rig, stationFrames([{ hz: F0, levelDb: LEVEL, onS: 0.5, offS: 0.65 }], 1, 0))
    expect(rig.link.types()).toEqual(['hi'])
    expect(rig.station.view(true).level).toBe(0)

    rig.link.receive({ t: 'lock', f0Hz: F0, mode: 'chirp' })
    const t0 = 5000
    const onS = 2
    feedStation(rig, stationFrames([{ hz: F0, levelDb: LEVEL, onS, offS: onS + 0.15 }], 4, t0))
    const chirps = rig.link.sent.filter((m) => m.t === 'chirp')
    expect(chirps).toHaveLength(1)
    const msg = chirps[0]!
    const onsetMs = msg.onsetMs as number
    expect(onsetMs).toBeGreaterThanOrEqual(t0 + onS * 1000)
    expect(onsetMs).toBeLessThanOrEqual(t0 + onS * 1000 + WINDOW_MS + 3 * HOP)
    // Band level (3-bin power sum) of the tone: within a few dB of the analyser's peak-bin reading.
    expect(Math.abs((msg.levelDb as number) - tonePeakDb(LEVEL))).toBeLessThan(4)
    expect(msg.snrDb as number).toBeGreaterThan(CONFIG.onsetSnrDb)
    expect(msg.clipped).toBe(false)
    const view = rig.station.view(true)
    expect(view).toMatchObject({ chirpsSent: 1, lastChirpDb: msg.levelDb, lastChirpAtMs: onsetMs, f0Hz: F0 })
    expect(view.level).toBeGreaterThanOrEqual(0)
    expect(view.level).toBeLessThan(0.5) // the chirp is over: back near the noise floor
  })

  it('a chirp at another frequency sends nothing', async () => {
    const rig = stationRig()
    await connectStation(rig)
    rig.link.receive({ t: 'lock', f0Hz: F0, mode: 'chirp' })
    feedStation(rig, stationFrames([{ hz: 4500, levelDb: LEVEL, onS: 2, offS: 2.15 }], 4))
    expect(rig.link.types().filter((t) => t === 'chirp')).toHaveLength(0)
    expect(rig.station.view(true).chirpsSent).toBe(0)
  })

  it('in live mode sends the held level every stationLevelReportMs', async () => {
    const rig = stationRig()
    await connectStation(rig)
    rig.link.receive({ t: 'lock', f0Hz: F0, mode: 'live' })
    const durationS = 4
    feedStation(rig, stationFrames([{ hz: F0, levelDb: LEVEL, onS: 0, offS: durationS }], durationS))
    const levels = rig.link.sent.filter((m) => m.t === 'level')
    const spanMs = durationS * 1000 - WINDOW_MS
    expect(levels.length).toBeGreaterThanOrEqual(Math.floor(spanMs / CONFIG.stationLevelReportMs) - 1)
    expect(levels.length).toBeLessThanOrEqual(Math.floor(spanMs / CONFIG.stationLevelReportMs) + 1)
    for (let i = 1; i < levels.length; i++) {
      expect((levels[i]!.atMs as number) - (levels[i - 1]!.atMs as number)).toBeGreaterThanOrEqual(CONFIG.stationLevelReportMs)
    }
    const last = levels.at(-1)!
    expect(Math.abs((last.levelDb as number) - tonePeakDb(LEVEL))).toBeLessThan(4)
    expect(rig.station.view(true).level).toBeGreaterThan(0.4)
  })

  it('cleanStationName trims, collapses, strips control characters and caps the length', () => {
    expect(cleanStationName('  a\tb\u0000c  ')).toBe('a b c')
    expect(cleanStationName('   ')).toBe('Station')
    expect(cleanStationName('', 'Hub')).toBe('Hub')
    expect(cleanStationName('x'.repeat(40))).toHaveLength(24)
    expect(cleanStationName('\u{1F514}'.repeat(30))).toBe('\u{1F514}'.repeat(24))
  })
})

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('StationRuntime edge cases', () => {
  it('going back to the offer while waiting for the hub abandons that attempt', async () => {
    // Back while the answer code is shown: a hub that still connects gets the link closed at once.
    const a = stationRig()
    a.station.setName('Den')
    a.station.micReady(true)
    const doneA = a.station.acceptOffer('OFFER')
    await flushMicrotasks()
    expect(a.station.view(true).step).toBe('showAnswer')
    a.station.setStep('pasteOffer')
    expect(a.station.view(false)).toMatchObject({ step: 'pasteOffer', answerCode: null })
    expect(a.cancels).toBe(1)
    a.resolveLink(a.link)
    await doneA
    expect(a.station.view(false).step).toBe('pasteOffer')
    expect(a.link.state).toBe('closed')
    expect(a.link.sent).toHaveLength(0)

    // Back while the answer is still being prepared.
    const b = stationRig()
    b.station.setName('Den')
    b.station.micReady(true)
    const doneB = b.station.acceptOffer('OFFER')
    expect(b.station.view(true).step).toBe('answering')
    b.station.setStep('scanOffer')
    await doneB
    expect(b.station.view(true)).toMatchObject({ step: 'scanOffer', answerCode: null })
    expect(b.cancels).toBe(1)
    b.resolveLink(b.link)
    await flushMicrotasks()
    expect(b.station.view(true).step).toBe('scanOffer')
    expect(b.link.state).toBe('closed')
    expect(b.link.sent).toHaveLength(0)
  })

  it('dispose or a new offer releases the attempt still waiting; a connected one is not cancelled', async () => {
    const a = stationRig()
    a.station.setName('Den')
    a.station.micReady(true)
    void a.station.acceptOffer('OFFER')
    await flushMicrotasks()
    a.station.dispose()
    expect(a.cancels).toBe(1)

    const b = stationRig()
    b.station.setName('Den')
    b.station.micReady(true)
    void b.station.acceptOffer('OFFER')
    await flushMicrotasks()
    const second = b.station.acceptOffer('OFFER') // the user scanned another offer
    expect(b.cancels).toBe(1)
    await flushMicrotasks()
    b.resolveLink(b.link)
    await second
    expect(b.station.view(true).step).toBe('connected')

    const c = stationRig()
    await connectStation(c)
    c.station.setStep('scanOffer')
    c.station.dispose()
    expect(c.cancels).toBe(0)
    expect(c.link.sent.at(-1)).toEqual({ t: 'bye' })
  })

  it('re-sends hi when the name or the raw-audio status changes, and notes calibration requests', async () => {
    const rig = stationRig()
    await connectStation(rig)
    expect(rig.link.sent).toEqual([{ t: 'hi', v: PROTOCOL_VERSION, name: 'Garage', rawAudio: 'unknown' }])
    rig.station.setRawAudio('partial')
    rig.station.setRawAudio('partial')
    rig.station.setName('Cellar')
    expect(rig.link.sent.filter((m) => m.t === 'hi')).toEqual([
      { t: 'hi', v: PROTOCOL_VERSION, name: 'Garage', rawAudio: 'unknown' },
      { t: 'hi', v: PROTOCOL_VERSION, name: 'Garage', rawAudio: 'partial' },
      { t: 'hi', v: PROTOCOL_VERSION, name: 'Cellar', rawAudio: 'partial' },
    ])
    expect(rig.station.calibrationRequested).toBe(false)
    rig.link.receive({ t: 'calibrate', on: true })
    expect(rig.station.calibrationRequested).toBe(true)
    rig.link.receive({ t: 'calibrate', on: false })
    expect(rig.station.calibrationRequested).toBe(false)
  })

  it('a double chirp sends the merged, louder level again with the same onset', async () => {
    const rig = stationRig()
    await connectStation(rig)
    rig.link.receive({ t: 'lock', f0Hz: F0, mode: 'chirp' })
    feedStation(
      rig,
      stationFrames(
        [
          { hz: F0, levelDb: LEVEL - 6, onS: 2, offS: 2.15 },
          { hz: F0, levelDb: LEVEL, onS: 2.6, offS: 2.75 },
        ],
        4,
      ),
    )
    const chirps = rig.link.sent.filter((m) => m.t === 'chirp')
    expect(chirps).toHaveLength(2)
    expect(chirps[1]!.onsetMs).toBe(chirps[0]!.onsetMs)
    expect((chirps[1]!.levelDb as number) - (chirps[0]!.levelDb as number)).toBeGreaterThan(4)
    expect(rig.station.view(true)).toMatchObject({ chirpsSent: 1, lastChirpDb: chirps[1]!.levelDb })
  })

  it('in a live lock it reports its noise level when it hears nothing, and never a made-up train', async () => {
    const rig = stationRig()
    await connectStation(rig)
    rig.link.receive({ t: 'lock', f0Hz: F0, mode: 'live' })
    const durationS = 8
    feedStation(rig, stationFrames([], durationS))
    expect(rig.link.types().filter((t) => t === 'chirp')).toHaveLength(0)
    const levels = rig.link.sent.filter((m) => m.t === 'level')
    const spanMs = durationS * 1000 - WINDOW_MS
    expect(levels.length).toBeGreaterThanOrEqual(Math.floor(spanMs / CONFIG.stationLevelReportMs) - 1)
    expect(levels.at(-1)!.atMs as number).toBeGreaterThan(durationS * 1000 - 2 * CONFIG.stationLevelReportMs)
    expect(levels.at(-1)!.levelDb as number).toBeLessThan(tonePeakDb(LEVEL) - 15)
  })

  it('in a chirp lock it sends no live levels, even when its own hunt hears a continuous tone', async () => {
    const rig = stationRig()
    await connectStation(rig)
    rig.link.receive({ t: 'lock', f0Hz: F0, mode: 'chirp' })
    feedStation(rig, stationFrames([{ hz: F0, levelDb: LEVEL, onS: 0.5, offS: 9 }], 10))
    expect(rig.link.types().filter((t) => t === 'level')).toHaveLength(0)
  })

  it('an answer the hub never connects to is an error with its message; the user can scan again', async () => {
    const rig = stationRig()
    rig.station.setName('Den')
    rig.station.micReady(true)
    const done = rig.station.acceptOffer('OFFER')
    await flushMicrotasks()
    expect(rig.station.view(true)).toMatchObject({ step: 'showAnswer', answerCode: 'ANSWER-CODE' })
    rig.rejectLink(new Error(ERR_CONNECT))
    await done
    expect(rig.station.view(true)).toMatchObject({
      step: 'error',
      answerCode: null,
      message: ERR_CONNECT,
    })
    rig.station.setStep('scanOffer')
    expect(rig.station.view(true)).toMatchObject({ step: 'scanOffer', message: null })
    expect(rig.link.sent).toHaveLength(0)
  })

  it("after pairing again nothing is reported until the new hub's lock arrives", async () => {
    const rig = stationRig()
    await connectStation(rig)
    rig.link.receive({ t: 'hello', v: PROTOCOL_VERSION, hubName: 'Kitchen phone' })
    rig.link.receive({ t: 'lock', f0Hz: F0, mode: 'live' })
    rig.link.receive({ t: 'bye' })
    // Lost: it keeps measuring at the old lock for its level bar.
    expect(rig.station.view(true)).toMatchObject({ step: 'lost', f0Hz: F0 })

    const next = new FakeLink()
    rig.station.setStep('scanOffer')
    const done = rig.station.acceptOffer('OFFER')
    await flushMicrotasks()
    rig.resolveLink(next)
    await done
    expect(rig.station.view(true)).toMatchObject({ step: 'connected', f0Hz: null })
    expect(rig.station.hubName).toBeNull()
    // The old live lock would have sent levels (and this chirp) to a hub that asked for nothing.
    feedStation(rig, stationFrames([{ hz: F0, levelDb: LEVEL, onS: 1, offS: 1.15 }], 3, 10_000))
    expect(next.types()).toEqual(['hi'])

    next.receive({ t: 'hello', v: PROTOCOL_VERSION, hubName: 'Attic laptop' })
    next.receive({ t: 'lock', f0Hz: F0, mode: 'chirp' })
    feedStation(rig, stationFrames([{ hz: F0, levelDb: LEVEL, onS: 1, offS: 1.15 }], 3, 13_000))
    expect(next.types()).toEqual(['hi', 'chirp'])
    expect(rig.station.hubName).toBe('Attic laptop')
  })

  it('leaving a connected hub for a new pairing says bye and drops its calibration request', async () => {
    const rig = stationRig()
    await connectStation(rig)
    rig.link.receive({ t: 'calibrate', on: true })
    expect(rig.station.calibrationRequested).toBe(true)
    rig.station.setStep('scanOffer')
    expect(rig.link.sent.at(-1)).toEqual({ t: 'bye' })
    expect(rig.link.state).toBe('closed')
    expect(rig.station.calibrationRequested).toBe(false)
  })

  it('announces the level bar only when it moves, at most every 100 ms apart from chirps', async () => {
    const rig = stationRig()
    await connectStation(rig)
    // No lock: the bar stays at 0, so nothing is announced.
    const before = rig.changeAt.length
    feedStation(rig, stationFrames([{ hz: F0, levelDb: LEVEL, onS: 0.5, offS: 0.65 }], 2))
    expect(rig.changeAt.length).toBe(before)

    rig.link.receive({ t: 'lock', f0Hz: F0, mode: 'chirp' })
    const locked = rig.changeAt.length
    feedStation(rig, stationFrames([{ hz: F0, levelDb: LEVEL, onS: 1, offS: 1.15 }], 3, 2000))
    const times = rig.changeAt.slice(locked)
    expect(times.length).toBeGreaterThan(5)
    expect(times.length).toBeLessThanOrEqual(3000 / 100 + 2)
    // Only the chirp message may follow a level announcement within 100 ms.
    let quick = 0
    for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! < 100) quick++
    expect(quick).toBeLessThanOrEqual(1)
    expect(rig.station.view(true).chirpsSent).toBe(1)
  })
})

describe('LockFollower', () => {
  /** Feed frames; each action runs once, before the first frame at or after its time. */
  function follow(
    f: LockFollower,
    frames: readonly Frame[],
    actions: readonly { readonly atMs: number; readonly run: () => void }[] = [],
  ): { readings: Reading[]; lives: number[] } {
    const readings: Reading[] = []
    const lives: number[] = []
    const pending = [...actions]
    for (const fr of frames) {
      while (pending.length > 0 && fr.tMs >= pending[0]!.atMs) pending.shift()!.run()
      f.step(
        fr,
        (r) => readings.push(r),
        (_db, _clipped, atMs) => lives.push(atMs),
      )
    }
    return { readings, lives }
  }

  it('keeps its hunt on a small drift, restarts it on a new frequency, stops on null', () => {
    const f = new LockFollower(CONFIG)
    expect(f.setLock({ f0Hz: F0, mode: 'chirp' })).toBe(true)
    expect(f.setLock({ f0Hz: F0, mode: 'chirp' })).toBe(false)
    const far = F0 * 1.3
    const frames = stationFrames(
      [
        { hz: F0, levelDb: LEVEL, onS: 1, offS: 1.15 },
        { hz: F0, levelDb: LEVEL - 10, onS: 11, offS: 11.15 },
        { hz: far, levelDb: LEVEL, onS: 21, offS: 21.15 },
      ],
      23,
    )
    const changed: boolean[] = []
    // The hub's estimate settling by a few Hz (a fraction of a bin) keeps the hunt and its history.
    const { readings } = follow(f, frames, [
      { atMs: 5000, run: () => changed.push(f.setLock({ f0Hz: F0 + 4, mode: 'chirp' })) },
      { atMs: 15_000, run: () => changed.push(f.setLock({ f0Hz: far, mode: 'chirp' })) },
    ])
    expect(changed).toEqual([true, true])
    expect(readings.map((r) => r.verdict)).toEqual(['first', 'colder', 'first'])
    expect(f.current).toEqual({ f0Hz: far, mode: 'chirp' })
    expect(f.setLock(null)).toBe(true)
    expect(f.setLock(null)).toBe(false)
    expect(f.current).toBeNull()
    expect(f.snrDb).toBe(0)
  })

  it('a mode switch keeps the hunt, so the train is reported with its real start', () => {
    const f = new LockFollower(CONFIG)
    f.setLock({ f0Hz: F0, mode: 'chirp' })
    const onS = 1
    const frames = stationFrames([{ hz: F0, levelDb: LEVEL, onS, offS: 8 }], 13)
    // The hub goes live a little after this hunt's own classifier did, and back to chirp mode
    // after the tone ended.
    const { readings, lives } = follow(f, frames, [
      { atMs: 6500, run: () => f.setLock({ f0Hz: F0, mode: 'live' }) },
      { atMs: 9000, run: () => f.setLock({ f0Hz: F0, mode: 'chirp' }) },
    ])
    expect(readings).toHaveLength(1)
    expect(readings[0]!.source).toBe('train')
    expect(readings[0]!.tMs).toBeGreaterThanOrEqual(onS * 1000)
    expect(readings[0]!.tMs).toBeLessThanOrEqual(onS * 1000 + WINDOW_MS + 3 * HOP)
    expect(Math.abs(readings[0]!.levelDb - tonePeakDb(LEVEL))).toBeLessThan(4)
    // Live levels only while the lock was live: 6.5 s .. 9 s.
    expect(lives.length).toBeGreaterThanOrEqual(4)
    expect(lives.every((t) => t >= 6500 && t < 9000)).toBe(true)
  })
})

// ---- Hub and station end to end----------------------------------------------------------------

describe('hub and station together', () => {
  it("the station's louder chirp is converted to hub time and named loudest", async () => {
    const [hubEnd, stationEnd] = linkedPair()
    const hub = hubRig()
    hub.nextLink = () => hubEnd
    const st = stationRig(stationEnd)
    hub.clock.now = 0
    st.clock.now = STATION_OFFSET_MS
    st.station.setName('Bedroom')
    st.station.micReady(true)

    hub.hub.addLocalListener('self', 'This phone', 'self')
    await hub.hub.startPairing()
    expect(hub.view().pairing.offerCode).toBe('OFFER-1')
    const answered = st.station.acceptOffer('OFFER')
    await Promise.resolve()
    await Promise.resolve()
    st.resolveLink(stationEnd)
    await answered
    await hub.hub.acceptAnswer('ANSWER-CODE')
    hub.hub.setLock(F0, 'chirp')

    // Same chirp; the hub's own mic hears it 10 dB quieter than the station.
    const onS = 2
    const hubFrames = stationFrames([{ hz: F0, levelDb: LEVEL - 10, onS, offS: onS + 0.2 }], 4, 0)
    const stationFramesList = stationFrames([{ hz: F0, levelDb: LEVEL, onS, offS: onS + 0.2 }], 4, STATION_OFFSET_MS)
    const selfHunt = createHunt({ f0Hz: F0, mode: 'chirp', reason: 'manual', tMs: 0, snrDb: 0, chirps: [] }, CONFIG)
    let selfReading: Reading | null = null
    for (let i = 0; i < hubFrames.length; i++) {
      const hf = hubFrames[i]!
      hub.clock.now = hf.tMs
      st.clock.now = hf.tMs + STATION_OFFSET_MS
      for (const ev of huntStep(selfHunt, hf, CONFIG)) {
        if (ev.type === 'reading' || ev.type === 'readingUpdated') {
          selfReading = ev.reading
          hub.hub.report('self', ev.reading)
        }
      }
      st.station.onFrame(stationFramesList[i]!)
      hub.hub.tick()
      stationEnd.deliver()
      hubEnd.deliver()
    }
    expect(selfReading).not.toBeNull()
    expect(hub.listener('station-1')).toMatchObject({ name: 'Bedroom', status: 'listening' })
    const c = hub.view().comparison!
    expect(c.readingId).toBe(selfReading!.id)
    expect(c.ranking.map((e) => e.id)).toEqual(['station-1', 'self'])
    expect(c.loudestId).toBe('station-1')
    expect(c.marginDb!).toBeGreaterThan(7)
    expect(c.marginDb!).toBeLessThan(13)
    expect(hub.hub.latestLoudestName()).toBe('Bedroom')
    expect(st.station.view(true)).toMatchObject({ step: 'connected', chirpsSent: 1, f0Hz: F0 })
  })
})

// ---- Extra microphones -------------------------------------------------------------------------

describe('extra microphones', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listAudioInputs lists real, labelled inputs only', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: () =>
          Promise.resolve([
            { kind: 'audioinput', deviceId: 'default', label: 'Default - Mic', groupId: 'g' },
            { kind: 'audioinput', deviceId: 'communications', label: 'Communications - Mic', groupId: 'g' },
            { kind: 'audioinput', deviceId: 'abc', label: 'Built-in mic', groupId: 'g' },
            { kind: 'audioinput', deviceId: 'def', label: '', groupId: 'g' },
            { kind: 'videoinput', deviceId: 'cam', label: 'Camera', groupId: 'g' },
            { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers', groupId: 'g' },
            { kind: 'audioinput', deviceId: 'usb', label: 'USB mic', groupId: 'h' },
          ]),
      },
    })
    expect(await listAudioInputs()).toEqual([
      { deviceId: 'abc', label: 'Built-in mic' },
      { deviceId: 'usb', label: 'USB mic' },
    ])
  })

  it('listAudioInputs returns [] without the API or on an error', async () => {
    vi.stubGlobal('navigator', {})
    expect(await listAudioInputs()).toEqual([])
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: () => Promise.reject(new Error('nope')) } })
    expect(await listAudioInputs()).toEqual([])
  })

  it('ExtraMic asks for that exact device with raw audio and maps failures', async () => {
    const calls: MediaStreamConstraints[] = []
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: (c: MediaStreamConstraints) => {
          calls.push(c)
          return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
        },
      },
    })
    const mic = new ExtraMic({
      ctx: {} as AudioContext,
      input: { deviceId: 'usb', label: 'USB mic' },
      cfg: CONFIG,
      onReading: () => undefined,
      onLive: () => undefined,
    })
    expect(mic.id).toBe('mic:usb')
    expect(mic.label).toBe('USB mic')
    expect(await mic.start()).toBe('permission')
    expect(calls[0]).toEqual({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: { exact: 'usb' } },
    })
    mic.dispose()
    expect(await mic.start()).toBe('busy')

    vi.stubGlobal('navigator', {})
    const other = new ExtraMic({
      ctx: {} as AudioContext,
      input: { deviceId: 'x', label: 'X' },
      cfg: CONFIG,
      onReading: () => undefined,
      onLive: () => undefined,
    })
    expect(await other.start()).toBe('unsupported')
    other.dispose()
  })

  it('ExtraMic releases a mic that opens after dispose; a stream without an audio track is noMic', async () => {
    let resolveStream: (s: FakeStream) => void = () => undefined
    const track = new FakeTrack()
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => new Promise<FakeStream>((res) => (resolveStream = res)) },
    })
    const mic = new ExtraMic({
      ctx: {} as AudioContext,
      input: { deviceId: 'usb', label: 'USB mic' },
      cfg: CONFIG,
      onReading: () => undefined,
      onLive: () => undefined,
    })
    const started = mic.start()
    mic.dispose()
    resolveStream(new FakeStream([track]))
    expect(await started).toBe('busy')
    expect(track.stopped).toBe(true)

    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve(new FakeStream([])) } })
    const empty = new ExtraMic({
      ctx: {} as AudioContext,
      input: { deviceId: 'x', label: 'X' },
      cfg: CONFIG,
      onReading: () => undefined,
      onLive: () => undefined,
    })
    expect(await empty.start()).toBe('noMic')
  })

  it('ExtraMic shares one attempt between start() calls and answers busy at once when disposed during the prompt', async () => {
    let resolveStream: (s: FakeStream) => void = () => undefined
    let requests = 0
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () => {
          requests++
          return new Promise<FakeStream>((res) => (resolveStream = res))
        },
      },
    })
    const mic = new ExtraMic({
      ctx: {} as AudioContext,
      input: { deviceId: 'usb', label: 'USB mic' },
      cfg: CONFIG,
      onReading: () => undefined,
      onLive: () => undefined,
    })
    const first = mic.start()
    const second = mic.start()
    expect(requests).toBe(1)
    // The permission prompt is still open: dispose must not leave start() waiting for it.
    mic.dispose()
    expect(await first).toBe('busy')
    expect(await second).toBe('busy')
    // Granted later: the mic is released at once.
    const track = new FakeTrack()
    resolveStream(new FakeStream([track]))
    await flushMicrotasks()
    expect(track.stopped).toBe(true)
  })

  it('ExtraMic can be started again after a failure', async () => {
    let deny = true
    const tracks: FakeTrack[] = []
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () => {
          if (deny) return Promise.reject(Object.assign(new Error('in use'), { name: 'NotReadableError' }))
          const t = new FakeTrack()
          tracks.push(t)
          return Promise.resolve(new FakeStream([t]))
        },
      },
    })
    const mic = new ExtraMic({
      ctx: {} as AudioContext,
      input: { deviceId: 'usb', label: 'USB mic' },
      cfg: CONFIG,
      onReading: () => undefined,
      onLive: () => undefined,
    })
    expect(await mic.start()).toBe('busy')
    deny = false
    // A fake context without Web Audio: the Engine cannot be built, so the stream is released.
    expect(await mic.start()).toBe('unsupported')
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.stopped).toBe(true)
    mic.dispose()
  })

  describe('with a fake AudioContext', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    interface MicRig {
      readonly mic: ExtraMic
      readonly ctx: FakeAudioContext
      readonly tracks: FakeTrack[]
      readonly readings: Reading[]
      readonly lives: { readonly levelDb: number; readonly atMs: number }[]
      ended: number
    }

    function micRig(tones: readonly ToneSpec[], durationS: number): MicRig {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const signal = synthSignal({ sampleRate: SR, durationS, noiseDb: NOISE_DB, seed: 11, tones })
      const now = (): number => Date.now()
      const ctx = new FakeAudioContext(signal, now)
      const tracks: FakeTrack[] = []
      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: () => {
            const t = new FakeTrack()
            tracks.push(t)
            return Promise.resolve(new FakeStream([t]))
          },
        },
      })
      const rig: MicRig = {
        mic: null as unknown as ExtraMic,
        ctx,
        tracks,
        readings: [],
        lives: [],
        ended: 0,
      }
      ;(rig as { mic: ExtraMic }).mic = new ExtraMic({
        ctx: ctx as unknown as AudioContext,
        input: { deviceId: 'usb', label: 'USB mic' },
        cfg: CONFIG,
        onReading: (r) => rig.readings.push(r),
        onLive: (levelDb) => rig.lives.push({ levelDb, atMs: now() }),
        onEnded: () => {
          rig.ended++
        },
        now,
      })
      return rig
    }

    it('measures its frames at the lock and reports one reading per chirp', async () => {
      const onS = 1.5
      const rig = micRig([{ hz: F0, levelDb: LEVEL, onS, offS: onS + 0.15 }], 3.5)
      rig.mic.setLock({ f0Hz: F0, mode: 'chirp' })
      expect(await rig.mic.start()).toBe('ok')
      vi.advanceTimersByTime(3000)
      expect(rig.ctx.analyser!.calls).toBeGreaterThan(140)
      expect(rig.readings).toHaveLength(1)
      const r = rig.readings[0]!
      expect(r.tMs).toBeGreaterThanOrEqual(onS * 1000)
      expect(r.tMs).toBeLessThanOrEqual(onS * 1000 + WINDOW_MS + 3 * HOP)
      expect(Math.abs(r.levelDb - tonePeakDb(LEVEL))).toBeLessThan(4)
      expect(rig.lives).toHaveLength(0)

      // A second start is a no-op; dispose stops the frames and releases the mic.
      expect(await Promise.all([rig.mic.start(), rig.mic.start()])).toEqual(['ok', 'ok'])
      expect(rig.tracks).toHaveLength(1)
      rig.mic.dispose()
      expect(rig.tracks[0]!.stopped).toBe(true)
      const calls = rig.ctx.analyser!.calls
      vi.advanceTimersByTime(500)
      expect(rig.ctx.analyser!.calls).toBe(calls)
    })

    it('reports the held level every stationLevelReportMs in a live lock, and tells when the track ends', async () => {
      const rig = micRig([{ hz: F0, levelDb: LEVEL, onS: 0, offS: 3.5 }], 3.5)
      rig.mic.setLock({ f0Hz: F0, mode: 'live' })
      expect(await rig.mic.start()).toBe('ok')
      vi.advanceTimersByTime(3000)
      expect(rig.lives.length).toBeGreaterThanOrEqual(5)
      expect(rig.lives.length).toBeLessThanOrEqual(7)
      for (let i = 1; i < rig.lives.length; i++) {
        expect(rig.lives[i]!.atMs - rig.lives[i - 1]!.atMs).toBeGreaterThanOrEqual(CONFIG.stationLevelReportMs)
      }
      expect(Math.abs(rig.lives.at(-1)!.levelDb - tonePeakDb(LEVEL))).toBeLessThan(4)

      rig.tracks[0]!.end()
      expect(rig.ended).toBe(1)
      rig.mic.dispose()
      rig.tracks[0]!.end()
      expect(rig.ended).toBe(1)
    })

    it('measures nothing while the lock is cleared, and again once it is set', async () => {
      const rig = micRig(
        [
          { hz: F0, levelDb: LEVEL, onS: 1.5, offS: 1.65 },
          { hz: F0, levelDb: LEVEL, onS: 4.5, offS: 4.65 },
        ],
        6,
      )
      rig.mic.setLock({ f0Hz: F0, mode: 'chirp' })
      const [a, b] = await Promise.all([rig.mic.start(), rig.mic.start()])
      expect([a, b]).toEqual(['ok', 'ok'])
      expect(rig.tracks).toHaveLength(1)
      rig.mic.setLock(null) // relisten
      vi.advanceTimersByTime(3000)
      expect(rig.readings).toHaveLength(0)
      rig.mic.setLock({ f0Hz: F0, mode: 'chirp' })
      vi.advanceTimersByTime(2900)
      expect(rig.readings).toHaveLength(1)
      expect(rig.readings[0]!.tMs).toBeGreaterThanOrEqual(4500)
      expect(rig.readings[0]!.tMs).toBeLessThanOrEqual(4500 + WINDOW_MS + 3 * HOP)
      rig.mic.dispose()
    })
  })
})

// ---- Web Audio / media fakes for ExtraMic --------------------------------------------------------

class FakeTrack {
  stopped = false
  private readonly listeners: { readonly type: string; readonly fn: () => void }[] = []

  stop(): void {
    this.stopped = true
  }

  addEventListener(type: string, fn: () => void): void {
    this.listeners.push({ type, fn })
  }

  /** The device went away: fire 'ended' (stop() does not). */
  end(): void {
    for (const l of this.listeners) if (l.type === 'ended') l.fn()
  }
}

class FakeStream {
  private readonly tracks: FakeTrack[]

  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks
  }

  getTracks(): FakeTrack[] {
    return this.tracks
  }
}

/** AnalyserNode stand-in: the reference analyser over a synthetic signal, at the fake clock's time. */
class FakeAnalyser {
  fftSize = 2048
  smoothingTimeConstant = 0.8
  minDecibels = -100
  maxDecibels = -30
  calls = 0
  private readonly signal: Float32Array
  private readonly now: () => number
  private ref: ReferenceAnalyser | null = null

  constructor(signal: Float32Array, now: () => number) {
    this.signal = signal
    this.now = now
  }

  get frequencyBinCount(): number {
    return this.fftSize / 2
  }

  connect(): void {
    // Graph wiring is not simulated.
  }

  disconnect(): void {
    // Graph wiring is not simulated.
  }

  getFloatFrequencyData(out: Float32Array<ArrayBuffer>): void {
    this.calls++
    if (this.ref === null || this.ref.fftSize !== this.fftSize) this.ref = new ReferenceAnalyser(this.fftSize)
    this.ref.analyse(this.signal, this.endSample(), out)
  }

  getFloatTimeDomainData(out: Float32Array): void {
    const end = this.endSample()
    for (let i = 0; i < out.length; i++) {
      const idx = end - out.length + i
      out[i] = idx >= 0 && idx < this.signal.length ? this.signal[idx]! : 0
    }
  }

  private endSample(): number {
    return Math.round((this.now() / 1000) * SR)
  }
}

/** Just enough AudioContext for the Engine. */
class FakeAudioContext {
  readonly sampleRate = SR
  readonly state = 'running'
  readonly destination = {}
  analyser: FakeAnalyser | null = null
  private readonly signal: Float32Array
  private readonly now: () => number

  constructor(signal: Float32Array, now: () => number) {
    this.signal = signal
    this.now = now
  }

  get currentTime(): number {
    return this.now() / 1000
  }

  createAnalyser(): FakeAnalyser {
    this.analyser = new FakeAnalyser(this.signal, this.now)
    return this.analyser
  }

  createMediaStreamSource(): { connect(): void; disconnect(): void } {
    return { connect: () => undefined, disconnect: () => undefined }
  }

  createGain(): { gain: { value: number }; connect(): void; disconnect(): void } {
    return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined }
  }
}
