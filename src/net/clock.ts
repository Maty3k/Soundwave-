/**
 * Station clock alignment. Each device reports times on its own performance.now() clock, which
 * starts when its page loaded. The hub pings each station; from the round trip it estimates the
 * offset between the clocks (station minus hub) and maps station chirp onsets onto its own clock,
 * so reports of the same chirp can be matched.
 *
 * Wi-Fi delays are asymmetric and bursty: a slow round trip says little about the one-way delays,
 * so only the fastest half of the samples is used, and the median of those resists what is left.
 *
 * Pure.
 */

/** One ping / pong round trip. */
export interface ClockSample {
  readonly rttMs: number
  /** stationMs - (hubSendMs + rttMs / 2): station clock minus hub clock, assuming symmetric delays. */
  readonly offsetMs: number
}

/** The sample for a ping sent at hubSendMs, answered at stationMs and received back at hubRecvMs (hub clock). */
export function clockSample(hubSendMs: number, hubRecvMs: number, stationMs: number): ClockSample {
  const rttMs = hubRecvMs - hubSendMs
  return { rttMs, offsetMs: stationMs - (hubSendMs + rttMs / 2) }
}

/** Keep the newest `keep` samples (config.stationPingKeep): returns a new array with `sample` appended. */
export function pushClockSample(samples: readonly ClockSample[], sample: ClockSample, keep: number): ClockSample[] {
  const next = [...samples, sample]
  return next.slice(Math.max(0, next.length - Math.max(1, keep)))
}

/**
 * Offset estimate: the median offset of the fastest half (lowest rtt, rounded up) of the valid
 * samples. Samples with a negative or non-finite rtt or offset are ignored; null when none is left.
 */
export function estimateOffset(samples: readonly ClockSample[]): number | null {
  const valid = samples.filter((s) => Number.isFinite(s.rttMs) && Number.isFinite(s.offsetMs) && s.rttMs >= 0)
  if (valid.length === 0) return null
  const fastest = [...valid].sort((a, b) => a.rttMs - b.rttMs).slice(0, Math.ceil(valid.length / 2))
  const offsets = fastest.map((s) => s.offsetMs).sort((a, b) => a - b)
  const mid = offsets.length >> 1
  return offsets.length % 2 === 1 ? offsets[mid]! : (offsets[mid - 1]! + offsets[mid]!) / 2
}

/** A station timestamp on the hub clock. */
export function toHubTime(stationMs: number, offsetMs: number): number {
  return stationMs - offsetMs
}
