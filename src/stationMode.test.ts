/**
 * StationRuntime's reply refresh: while the station waits for the main phone to take its reply
 * code, a fresh reply replaces it every stationAnswerRefreshMs and the replaced one stays alive
 * for stationAnswerOverlapMs. The rest of the runtime (naming, messages, measuring) is tested in
 * hub.test.ts next to the hub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG } from './config.ts'
import type { Answer, LinkState, PairDiag, PeerLink } from './net/peer.ts'
import { StationRuntime } from './stationMode.ts'

const REFRESH = CONFIG.stationAnswerRefreshMs
const OVERLAP = CONFIG.stationAnswerOverlapMs
const TIMEOUT_MESSAGE = 'The main phone did not connect.'

/** Just enough of a PeerLink: its state and what was sent (no hub answers here). */
class FakeLink implements PeerLink {
  state: LinkState = 'open'
  onMessage: ((data: unknown) => void) | null = null
  onStateChange: ((s: LinkState) => void) | null = null
  readonly sent: unknown[] = []

  send(message: unknown): boolean {
    if (this.state !== 'open') return false
    this.sent.push(message)
    return true
  }

  close(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.onStateChange?.('closed')
  }
}

const DIAG: PairDiag = { mine: { host: 1, public: 1 }, theirs: { host: 2, public: 1 }, ice: 'checking' }

/** One answerOffer result: its code, a link promise the test settles, and a cancel counter. */
class FakeAnswer implements Answer {
  readonly code: string
  readonly link: Promise<PeerLink>
  /** The hub took this code and the channel opened. */
  readonly open: (link: PeerLink) => void
  /** peer.ts gave up on this reply (its 60 s timeout, a failed connection, a cancel). */
  readonly fail: (err: Error) => void
  cancels = 0
  /** The hub answers this reply's connectivity checks (same network). */
  connected = false

  constructor(code: string) {
    this.code = code
    let open: (link: PeerLink) => void = () => undefined
    let fail: (err: Error) => void = () => undefined
    this.link = new Promise<PeerLink>((res, rej) => {
      open = res
      fail = rej
    })
    this.link.catch(() => undefined) // marked as handled, like peer.ts
    this.open = open
    this.fail = fail
  }

  cancel(): void {
    this.cancels++
  }

  iceConnected(): boolean {
    return this.connected
  }

  diag(): PairDiag {
    return DIAG
  }
}

interface Rig {
  readonly station: StationRuntime
  /** The offer code of every answerOffer call, oldest first. */
  readonly offers: string[]
  /** The replies handed out (or held), oldest first. */
  readonly answers: FakeAnswer[]
  /** Makes this many of the next answerOffer calls reject (no network, say). */
  failNext: number
  /** While true, answerOffer does not settle until releaseHeld() (resolves) or failHeld() (rejects). */
  hold: boolean
  releaseHeld(): void
  failHeld(): void
  changes: number
}

function rig(): Rig {
  const held: { readonly release: () => void; readonly fail: () => void }[] = []
  const r: Rig = {
    station: null as unknown as StationRuntime,
    offers: [],
    answers: [],
    failNext: 0,
    hold: false,
    releaseHeld: () => {
      for (const h of held.splice(0)) h.release()
    },
    failHeld: () => {
      for (const h of held.splice(0)) h.fail()
    },
    changes: 0,
  }
  ;(r as { station: StationRuntime }).station = new StationRuntime({
    cfg: CONFIG,
    now: () => 0,
    onChange: () => {
      r.changes++
    },
    answerOffer: (code) => {
      r.offers.push(code)
      if (r.failNext > 0) {
        r.failNext--
        return Promise.reject(new Error('Could not prepare the pairing code. Try again.'))
      }
      const answer = new FakeAnswer(`ANSWER-${r.answers.length + 1}`)
      r.answers.push(answer)
      if (!r.hold) return Promise.resolve(answer)
      return new Promise<Answer>((res, rej) =>
        held.push({ release: () => res(answer), fail: () => rej(new Error('Could not prepare the pairing code. Try again.')) }),
      )
    },
  })
  return r
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/**
 * Name the station and answer 'OFFER' up to the reply code being shown. acceptOffer's promise
 * (settled when the attempt ends) comes back wrapped: an async function would adopt it.
 */
async function showAnswer(r: Rig): Promise<{ readonly done: Promise<void> }> {
  r.station.setName('Den')
  r.station.micReady(true)
  const done = r.station.acceptOffer(' OFFER ')
  await flush()
  expect(r.station.view(true)).toMatchObject({ step: 'showAnswer', answerCode: 'ANSWER-1' })
  return { done }
}

function cancels(r: Rig): number[] {
  return r.answers.map((a) => a.cancels)
}

describe('StationRuntime reply refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('prepares a fresh reply for the same offer every stationAnswerRefreshMs and shows its code', async () => {
    const r = rig()
    await showAnswer(r)
    await vi.advanceTimersByTimeAsync(REFRESH - 1)
    expect(r.offers).toEqual(['OFFER'])
    const changes = r.changes
    await vi.advanceTimersByTimeAsync(1)
    expect(r.offers).toEqual(['OFFER', 'OFFER'])
    expect(r.station.view(true)).toMatchObject({ step: 'showAnswer', answerCode: 'ANSWER-2' })
    expect(r.changes).toBe(changes + 1)
    await vi.advanceTimersByTimeAsync(REFRESH)
    expect(r.offers).toHaveLength(3)
    expect(r.station.view(true).answerCode).toBe('ANSWER-3')
    expect(cancels(r)).toEqual([0, 0, 0])
  })

  it("prepares no fresh reply while the hub answers the shown reply's checks, and resumes when it stops", async () => {
    const r = rig()
    await showAnswer(r)
    r.answers[0]!.connected = true // same network: the hub answers the checks within seconds
    await vi.advanceTimersByTimeAsync(3 * REFRESH)
    expect(r.offers).toEqual(['OFFER'])
    expect(r.station.view(true)).toMatchObject({ step: 'showAnswer', answerCode: 'ANSWER-1' })
    expect(cancels(r)).toEqual([0])
    r.answers[0]!.connected = false
    await vi.advanceTimersByTimeAsync(REFRESH)
    expect(r.offers).toEqual(['OFFER', 'OFFER'])
    expect(r.station.view(true).answerCode).toBe('ANSWER-2')
    // A fresh reply that the hub answers is kept in turn.
    r.answers[1]!.connected = true
    await vi.advanceTimersByTimeAsync(2 * REFRESH)
    expect(r.offers).toHaveLength(2)
    expect(r.station.view(true).answerCode).toBe('ANSWER-2')
  })

  it('releases a replaced reply stationAnswerOverlapMs after it was replaced, not before', async () => {
    const r = rig()
    await showAnswer(r)
    await vi.advanceTimersByTimeAsync(REFRESH)
    const first = r.answers[0]!
    await vi.advanceTimersByTimeAsync(OVERLAP - 1)
    expect(first.cancels).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(first.cancels).toBe(1)
    // The second reply was replaced later (at 2 x REFRESH) and is still within its overlap.
    expect(cancels(r)).toEqual([1, 0, 0])
    // A link of the released reply that opens late is closed, not attached.
    const late = new FakeLink()
    first.open(late)
    await flush()
    expect(late.state).toBe('closed')
    expect(r.station.view(true)).toMatchObject({ step: 'showAnswer', answerCode: 'ANSWER-3' })
  })

  it("attaches the replaced reply's link when the hub scanned the older code, and releases the new reply", async () => {
    const r = rig()
    const { done } = await showAnswer(r)
    await vi.advanceTimersByTimeAsync(REFRESH)
    const first = r.answers[0]!
    const second = r.answers[1]!
    const link = new FakeLink()
    first.open(link)
    await done
    expect(r.station.view(true)).toMatchObject({ step: 'connected', answerCode: null, message: null })
    expect(link.sent[0]).toMatchObject({ t: 'hi', name: 'Den' })
    expect(cancels(r)).toEqual([0, 1])
    // No refresh once connected.
    await vi.advanceTimersByTimeAsync(10 * REFRESH)
    expect(r.offers).toHaveLength(2)
    // The released reply's link opening after all is closed; the connection stays.
    const late = new FakeLink()
    second.open(late)
    await flush()
    expect(late.state).toBe('closed')
    expect(link.state).toBe('open')
    expect(r.station.view(true).step).toBe('connected')
  })

  it("attaches the new reply's link and releases the replaced one", async () => {
    const r = rig()
    const { done } = await showAnswer(r)
    await vi.advanceTimersByTimeAsync(REFRESH)
    const link = new FakeLink()
    r.answers[1]!.open(link)
    await done
    expect(r.station.view(true)).toMatchObject({ step: 'connected', answerCode: null })
    expect(cancels(r)).toEqual([1, 0])
    expect(link.sent[0]).toMatchObject({ t: 'hi', name: 'Den' })
    await vi.advanceTimersByTimeAsync(10 * REFRESH)
    expect(r.offers).toHaveLength(2)
  })

  it('a refresh that fails keeps the current code and tries again at the next tick', async () => {
    const r = rig()
    await showAnswer(r)
    r.failNext = 1
    await vi.advanceTimersByTimeAsync(REFRESH)
    expect(r.offers).toHaveLength(2)
    expect(r.station.view(true)).toMatchObject({ step: 'showAnswer', answerCode: 'ANSWER-1' })
    expect(cancels(r)).toEqual([0])
    await vi.advanceTimersByTimeAsync(REFRESH)
    expect(r.offers).toHaveLength(3)
    expect(r.station.view(true)).toMatchObject({ step: 'showAnswer', answerCode: 'ANSWER-2' })
    expect(cancels(r)).toEqual([0, 0])
  })

  it("only the shown reply's failure ends the attempt; a replaced reply's is ignored", async () => {
    const r = rig()
    const { done } = await showAnswer(r)
    await vi.advanceTimersByTimeAsync(REFRESH)
    r.answers[0]!.fail(new Error('Pairing was cancelled.'))
    await flush()
    expect(r.station.view(true)).toMatchObject({ step: 'showAnswer', answerCode: 'ANSWER-2', message: null })
    r.answers[1]!.fail(new Error(TIMEOUT_MESSAGE))
    await done
    expect(r.station.view(true)).toMatchObject({ step: 'error', answerCode: null, message: TIMEOUT_MESSAGE })
    expect(r.station.view(true)).not.toHaveProperty('diag')
    // Nothing refreshes after the failure, and the first reply's overlap timer is gone too.
    await vi.advanceTimersByTimeAsync(10 * REFRESH)
    expect(r.offers).toHaveLength(2)
    expect(cancels(r)).toEqual([0, 0])
  })

  it('Start over, dispose and a new offer release every reply and stop the refreshing', async () => {
    const a = rig()
    const { done: doneA } = await showAnswer(a)
    await vi.advanceTimersByTimeAsync(REFRESH)
    a.station.setStep('scanOffer')
    expect(cancels(a)).toEqual([1, 1])
    expect(a.station.view(true)).toMatchObject({ step: 'scanOffer', answerCode: null })
    await doneA
    await vi.advanceTimersByTimeAsync(10 * REFRESH)
    expect(a.offers).toHaveLength(2)

    const b = rig()
    const { done: doneB } = await showAnswer(b)
    await vi.advanceTimersByTimeAsync(REFRESH)
    b.station.dispose()
    expect(cancels(b)).toEqual([1, 1])
    await doneB
    await vi.advanceTimersByTimeAsync(10 * REFRESH)
    expect(b.offers).toHaveLength(2)

    const c = rig()
    const { done: doneC } = await showAnswer(c)
    await vi.advanceTimersByTimeAsync(REFRESH)
    const second = c.station.acceptOffer('OFFER-2')
    // The two replies of the old attempt are released at once; the new one is being prepared.
    expect(cancels(c)).toEqual([1, 1, 0])
    await doneC
    await flush()
    expect(c.offers).toEqual(['OFFER', 'OFFER', 'OFFER-2'])
    expect(c.station.view(true)).toMatchObject({ step: 'showAnswer', answerCode: 'ANSWER-3' })
    // Only the new attempt refreshes from here, with its own offer code.
    await vi.advanceTimersByTimeAsync(REFRESH)
    expect(c.offers).toEqual(['OFFER', 'OFFER', 'OFFER-2', 'OFFER-2'])
    expect(cancels(c)).toEqual([1, 1, 0, 0])
    c.answers[3]!.open(new FakeLink())
    await second
    expect(c.station.view(true).step).toBe('connected')
    expect(cancels(c)).toEqual([1, 1, 1, 0])
    // The reply that connected is never cancelled, not even by Start over or dispose.
    c.station.setStep('scanOffer')
    c.station.dispose()
    expect(cancels(c)).toEqual([1, 1, 1, 0])
  })

  it('a replaced reply that gives up by itself is dropped, and its overlap timer with it', async () => {
    const r = rig()
    await showAnswer(r)
    await vi.advanceTimersByTimeAsync(REFRESH)
    const first = r.answers[0]!
    // Its own 60 s timeout: peer.ts released the connection itself, so there is nothing to cancel.
    first.fail(new Error(TIMEOUT_MESSAGE))
    await flush()
    expect(r.station.view(true)).toMatchObject({ step: 'showAnswer', answerCode: 'ANSWER-2', message: null })
    await vi.advanceTimersByTimeAsync(OVERLAP)
    expect(first.cancels).toBe(0)
    expect(r.station.view(true).step).toBe('showAnswer')
  })

  it('Start over while a refresh is being prepared releases that reply on arrival and refreshes no more', async () => {
    const r = rig()
    const { done } = await showAnswer(r)
    r.hold = true
    await vi.advanceTimersByTimeAsync(REFRESH)
    expect(r.offers).toHaveLength(2)
    r.station.setStep('pasteOffer')
    await done
    expect(cancels(r)).toEqual([1, 0])
    expect(r.station.view(false)).toMatchObject({ step: 'pasteOffer', answerCode: null })
    expect(r.station.view(false)).not.toHaveProperty('diag')
    r.releaseHeld()
    await flush()
    expect(cancels(r)).toEqual([1, 1])
    expect(r.station.view(false)).toMatchObject({ step: 'pasteOffer', answerCode: null })
    // The stale reply's link opening after all is closed; nothing is attached.
    const late = new FakeLink()
    r.answers[1]!.open(late)
    await flush()
    expect(late.state).toBe('closed')
    expect(r.station.view(false).step).toBe('pasteOffer')
    await vi.advanceTimersByTimeAsync(10 * REFRESH)
    expect(r.offers).toHaveLength(2)
  })

  it('a refresh that fails after the attempt ended schedules no further refresh', async () => {
    const r = rig()
    const { done } = await showAnswer(r)
    r.hold = true
    await vi.advanceTimersByTimeAsync(REFRESH)
    expect(r.offers).toHaveLength(2)
    r.station.setStep('scanOffer')
    await done
    r.failHeld()
    await flush()
    await vi.advanceTimersByTimeAsync(10 * REFRESH)
    expect(r.offers).toHaveLength(2)
    expect(cancels(r)).toEqual([1, 0])
  })

  it('a refresh still being prepared when the attempt ends is discarded', async () => {
    const r = rig()
    const { done } = await showAnswer(r)
    r.hold = true
    await vi.advanceTimersByTimeAsync(REFRESH)
    expect(r.offers).toHaveLength(2)
    expect(r.station.view(true).answerCode).toBe('ANSWER-1')
    const link = new FakeLink()
    r.answers[0]!.open(link)
    await done
    expect(r.station.view(true).step).toBe('connected')
    r.releaseHeld()
    await flush()
    expect(cancels(r)).toEqual([0, 1])
    const late = new FakeLink()
    r.answers[1]!.open(late)
    await flush()
    expect(late.state).toBe('closed')
    expect(link.state).toBe('open')
    expect(r.station.view(true).step).toBe('connected')
  })

  it('exposes the pairing diagnostics of the shown reply, and nothing before or after', async () => {
    const r = rig()
    expect(r.station.view(true)).not.toHaveProperty('diag')
    r.station.setName('Den')
    r.station.micReady(true)
    const done = r.station.acceptOffer('OFFER')
    expect(r.station.view(true)).toMatchObject({ step: 'answering' })
    expect(r.station.view(true)).not.toHaveProperty('diag')
    await flush()
    expect(r.station.view(true).diag).toEqual(DIAG)
    await vi.advanceTimersByTimeAsync(REFRESH)
    expect(r.station.view(true).diag).toEqual(DIAG)
    r.answers[1]!.open(new FakeLink())
    await done
    expect(r.station.view(true)).toMatchObject({ step: 'connected' })
    expect(r.station.view(true)).not.toHaveProperty('diag')
  })
})
