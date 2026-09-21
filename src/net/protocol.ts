/**
 * Messages between the hub (the phone running the hunt) and its stations (other devices listening
 * in other rooms), sent as JSON over the WebRTC data channel. Only numbers travel: audio never
 * leaves a device. Everything received comes from another device, so it is validated strictly and
 * rebuilt field by field; anything unexpected is dropped (null).
 *
 * Pure: no DOM or WebRTC APIs.
 */
import type { LockMode, RawAudioStatus } from '../types.ts'

/** Bumped on any incompatible change; exchanged in 'hello' / 'hi'. */
export const PROTOCOL_VERSION = 1

/** Longest device name (code points, after trimming). */
export const MAX_NAME_LENGTH = 40

/** Hub -> station. */
export type HubMessage =
  /** First message after the channel opens. */
  | { t: 'hello'; v: number; hubName: string }
  /** Frequency to listen to; both null while the hub has no lock. */
  | { t: 'lock'; f0Hz: number | null; mode: LockMode | null }
  /** Clock alignment: the station answers with a 'pong' at once. */
  | { t: 'ping'; id: number; hubMs: number }
  /** Level calibration started / ended on the hub. */
  | { t: 'calibrate'; on: boolean }
  | { t: 'bye' }

/** Station -> hub. Times are on the station's own clock (performance.now()). */
export type StationMessage =
  | { t: 'hi'; v: number; name: string; rawAudio: RawAudioStatus }
  | { t: 'pong'; id: number; hubMs: number; stationMs: number }
  /** One chirp heard at the hub's frequency. */
  | { t: 'chirp'; onsetMs: number; levelDb: number; snrDb: number; clipped: boolean }
  /** Held level in live mode, every config.stationLevelReportMs. */
  | { t: 'level'; levelDb: number; atMs: number; clipped: boolean }
  | { t: 'bye' }

/** Largest accepted absolute timestamp in ms (about 30 years of uptime). */
const MAX_TIME_MS = 1e12
const MAX_VERSION = 1000
/** Accepted frequency range of a lock. */
const MIN_F0_HZ = 1
const MAX_F0_HZ = 100_000
/** Accepted level / SNR ranges (analyser dB; generous, only absurd values are rejected). */
const MIN_LEVEL_DB = -400
const MAX_LEVEL_DB = 100
const MAX_ABS_SNR_DB = 400
/** Raw strings longer than this are rejected before any processing. */
const MAX_RAW_NAME_CHARS = 200

const RAW_AUDIO: readonly RawAudioStatus[] = ['raw', 'partial', 'unknown']
const LOCK_MODES: readonly LockMode[] = ['chirp', 'live']

/** Control characters, line / paragraph separators and bidi overrides would garble the UI. */
function hasForbiddenChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true
    if (c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true
  }
  return false
}

type Fields = Readonly<Record<string, unknown>>

function isRecord(raw: unknown): raw is Fields {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
}

function num(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null
}

function time(v: unknown): number | null {
  return num(v, -MAX_TIME_MS, MAX_TIME_MS)
}

function nonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
}

function version(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_VERSION ? v : null
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

/**
 * A device name as it may be shown: trimmed, 1..MAX_NAME_LENGTH code points, no control or
 * bidi-override characters. null otherwise. Use it on the name the user types, too.
 */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > MAX_RAW_NAME_CHARS || hasForbiddenChar(v)) return null
  const s = v.trim()
  const length = [...s].length
  return length >= 1 && length <= MAX_NAME_LENGTH ? s : null
}

/** Validate a message received by a station. Returns a fresh object with only the known fields, or null. */
export function parseHubMessage(raw: unknown): HubMessage | null {
  if (!isRecord(raw)) return null
  switch (raw.t) {
    case 'hello': {
      const v = version(raw.v)
      const hubName = cleanName(raw.hubName)
      return v === null || hubName === null ? null : { t: 'hello', v, hubName }
    }
    case 'lock': {
      if (raw.f0Hz === null && raw.mode === null) return { t: 'lock', f0Hz: null, mode: null }
      const f0Hz = num(raw.f0Hz, MIN_F0_HZ, MAX_F0_HZ)
      const mode = LOCK_MODES.find((m) => m === raw.mode)
      return f0Hz === null || mode === undefined ? null : { t: 'lock', f0Hz, mode }
    }
    case 'ping': {
      const id = nonNegInt(raw.id)
      const hubMs = time(raw.hubMs)
      return id === null || hubMs === null ? null : { t: 'ping', id, hubMs }
    }
    case 'calibrate': {
      const on = bool(raw.on)
      return on === null ? null : { t: 'calibrate', on }
    }
    case 'bye':
      return { t: 'bye' }
    default:
      return null
  }
}

/** Validate a message received by the hub. Returns a fresh object with only the known fields, or null. */
export function parseStationMessage(raw: unknown): StationMessage | null {
  if (!isRecord(raw)) return null
  switch (raw.t) {
    case 'hi': {
      const v = version(raw.v)
      const name = cleanName(raw.name)
      const rawAudio = RAW_AUDIO.find((s) => s === raw.rawAudio)
      return v === null || name === null || rawAudio === undefined ? null : { t: 'hi', v, name, rawAudio }
    }
    case 'pong': {
      const id = nonNegInt(raw.id)
      const hubMs = time(raw.hubMs)
      const stationMs = time(raw.stationMs)
      return id === null || hubMs === null || stationMs === null ? null : { t: 'pong', id, hubMs, stationMs }
    }
    case 'chirp': {
      const onsetMs = time(raw.onsetMs)
      const levelDb = num(raw.levelDb, MIN_LEVEL_DB, MAX_LEVEL_DB)
      const snrDb = num(raw.snrDb, -MAX_ABS_SNR_DB, MAX_ABS_SNR_DB)
      const clipped = bool(raw.clipped)
      if (onsetMs === null || levelDb === null || snrDb === null || clipped === null) return null
      return { t: 'chirp', onsetMs, levelDb, snrDb, clipped }
    }
    case 'level': {
      const levelDb = num(raw.levelDb, MIN_LEVEL_DB, MAX_LEVEL_DB)
      const atMs = time(raw.atMs)
      const clipped = bool(raw.clipped)
      return levelDb === null || atMs === null || clipped === null ? null : { t: 'level', levelDb, atMs, clipped }
    }
    case 'bye':
      return { t: 'bye' }
    default:
      return null
  }
}
