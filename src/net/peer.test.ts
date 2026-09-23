import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gathered } from './peer.ts'

const STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']
const TIMEOUT = 4000
const GRACE = 1500

/** Just enough of an RTCPeerConnection for gathered(): events and the gathering state. */
class FakePeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = 'gathering'

  candidate(line: string | null): void {
    this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: line === null ? null : { candidate: line } }))
  }

  error(url: string): void {
    this.dispatchEvent(Object.assign(new Event('icecandidateerror'), { url, errorCode: 701 }))
  }

  complete(): void {
    this.iceGatheringState = 'complete'
    this.dispatchEvent(new Event('icegatheringstatechange'))
  }
}

const HOST = 'candidate:1 1 udp 2113937151 8b4a2c0e-6f7e-4a1b-9c3d-2e5f6a7b8c9d.local 50000 typ host'
const HOST_TCP = 'candidate:2 1 tcp 1518280447 8b4a2c0e-6f7e-4a1b-9c3d-2e5f6a7b8c9d.local 9 typ host tcptype active'
const SRFLX = 'candidate:3 1 udp 1686052607 203.0.113.7 58443 typ srflx raddr 0.0.0.0 rport 0'

/** Whether a promise has settled by now (after pending microtasks). */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false
  void p.then(() => (done = true))
  await Promise.resolve()
  await Promise.resolve()
  return done
}

describe('gathered', () => {
  let pc: FakePeer
  const run = (urls: readonly string[] = STUN): Promise<void> => gathered(pc as unknown as RTCPeerConnection, TIMEOUT, GRACE, urls)

  beforeEach(() => {
    vi.useFakeTimers()
    pc = new FakePeer()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves at once when gathering is already complete, or as soon as it completes', async () => {
    pc.iceGatheringState = 'complete'
    expect(await settled(run())).toBe(true)
    const p2 = gathered(new FakePeer() as unknown as RTCPeerConnection, TIMEOUT, GRACE, STUN)
    expect(await settled(p2)).toBe(false)
  })

  it('ends the wait as soon as a public (srflx) candidate arrives', async () => {
    const p = run()
    pc.candidate(HOST)
    expect(await settled(p)).toBe(false)
    pc.candidate(SRFLX)
    expect(await settled(p)).toBe(true)
  })

  it('ends the wait when every STUN server has failed and a UDP host candidate is in', async () => {
    const p = run()
    pc.error(STUN[0]!)
    pc.error(STUN[1]!)
    expect(await settled(p)).toBe(false) // no candidate yet: an empty code is no use
    pc.candidate(HOST)
    expect(await settled(p)).toBe(true)
    // In the other order too (host first, errors after).
    pc = new FakePeer()
    const q = run()
    pc.candidate(HOST)
    pc.error(STUN[0]!)
    expect(await settled(q)).toBe(false) // one server may still answer
    pc.error(STUN[1]!)
    expect(await settled(q)).toBe(true)
  })

  it('gives the STUN servers stunGraceMs after the first UDP host candidate, then goes on without them', async () => {
    const p = run()
    pc.candidate(HOST_TCP) // TCP does not count
    await vi.advanceTimersByTimeAsync(GRACE + 100)
    expect(await settled(p)).toBe(false)
    pc.candidate(HOST)
    await vi.advanceTimersByTimeAsync(GRACE - 1)
    expect(await settled(p)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(p)).toBe(true)
  })

  it('without STUN servers there is no grace wait: it waits for completion (or the timeout)', async () => {
    const p = run([])
    pc.candidate(HOST)
    await vi.advanceTimersByTimeAsync(GRACE + 500)
    expect(await settled(p)).toBe(false)
    pc.complete()
    expect(await settled(p)).toBe(true)
    // The null candidate also ends it.
    pc = new FakePeer()
    const q = run([])
    pc.candidate(HOST)
    pc.candidate(null)
    expect(await settled(q)).toBe(true)
  })

  it('gives up after timeoutMs with a UDP candidate, and after twice that without one', async () => {
    const p = run()
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
    pc.candidate(HOST)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(p)).toBe(true) // the timeout, not the grace, ended it
    pc = new FakePeer()
    const q = run()
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT - 1)
    expect(await settled(q)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(q)).toBe(true)
  })

  it('stops listening once it has resolved', async () => {
    const p = run()
    pc.candidate(SRFLX)
    expect(await settled(p)).toBe(true)
    // No listeners left: further events go nowhere (and no timer fires later).
    pc.candidate(HOST)
    pc.error(STUN[0]!)
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT)
    expect(vi.getTimerCount()).toBe(0)
  })
})
