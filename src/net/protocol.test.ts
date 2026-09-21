import { describe, expect, it } from 'vitest'
import { cleanName, MAX_NAME_LENGTH, parseHubMessage, parseStationMessage, PROTOCOL_VERSION } from './protocol.ts'
import type { HubMessage, StationMessage } from './protocol.ts'

/** What actually crosses the channel: JSON text, parsed on the other side. */
function wire(message: unknown): unknown {
  return JSON.parse(JSON.stringify(message))
}

const BELL = String.fromCharCode(7)
const NEWLINE = String.fromCharCode(10)
const RLO = String.fromCharCode(0x202e)
const LINE_SEP = String.fromCharCode(0x2028)

const VALID_HUB: readonly HubMessage[] = [
  { t: 'hello', v: PROTOCOL_VERSION, hubName: 'Kitchen phone' },
  { t: 'lock', f0Hz: 3150.5, mode: 'chirp' },
  { t: 'lock', f0Hz: 2000, mode: 'live' },
  { t: 'lock', f0Hz: null, mode: null },
  { t: 'ping', id: 0, hubMs: 0 },
  { t: 'ping', id: 17, hubMs: 123456.789 },
  { t: 'calibrate', on: true },
  { t: 'calibrate', on: false },
  { t: 'bye' },
]

const VALID_STATION: readonly StationMessage[] = [
  { t: 'hi', v: PROTOCOL_VERSION, name: 'Bedroom laptop', rawAudio: 'raw' },
  { t: 'hi', v: 2, name: 'Hall', rawAudio: 'partial' },
  { t: 'hi', v: 1, name: 'Attic', rawAudio: 'unknown' },
  { t: 'pong', id: 3, hubMs: 5000.25, stationMs: 91234.5 },
  { t: 'chirp', onsetMs: 91500.1, levelDb: -62.4, snrDb: 21.3, clipped: false },
  { t: 'chirp', onsetMs: 0, levelDb: -13.6, snrDb: 80, clipped: true },
  { t: 'level', levelDb: -70, atMs: 92000, clipped: false },
  { t: 'bye' },
]

describe('parseHubMessage', () => {
  it('accepts every hub message type as sent over the wire', () => {
    for (const m of VALID_HUB) expect(parseHubMessage(wire(m)), m.t).toEqual(m)
  })

  it('returns a fresh object with only the known fields', () => {
    const raw = { t: 'ping', id: 1, hubMs: 2, extra: 'x'.repeat(1000), __proto__x: 1 }
    const parsed = parseHubMessage(raw)
    expect(parsed).toEqual({ t: 'ping', id: 1, hubMs: 2 })
    expect(parsed).not.toBe(raw)
    expect(Object.keys(parsed!)).toEqual(['t', 'id', 'hubMs'])
  })

  it('trims the hub name', () => {
    expect(parseHubMessage({ t: 'hello', v: 1, hubName: '  Hub  ' })).toEqual({ t: 'hello', v: 1, hubName: 'Hub' })
  })

  it('rejects non-objects, unknown and station message types', () => {
    for (const raw of [null, undefined, 0, 'hello', true, [], [{ t: 'bye' }], {}, { t: 'nope' }, { t: 7 }]) {
      expect(parseHubMessage(raw), JSON.stringify(raw) ?? 'undefined').toBeNull()
    }
    for (const m of VALID_STATION) {
      if (m.t !== 'bye') expect(parseHubMessage(wire(m)), m.t).toBeNull()
    }
  })

  it('rejects malformed fields', () => {
    const bad: readonly unknown[] = [
      { t: 'hello', v: 1 },
      { t: 'hello', v: 0, hubName: 'Hub' },
      { t: 'hello', v: 1.5, hubName: 'Hub' },
      { t: 'hello', v: '1', hubName: 'Hub' },
      { t: 'hello', v: 1, hubName: '   ' },
      { t: 'hello', v: 1, hubName: 42 },
      { t: 'hello', v: 1, hubName: 'x'.repeat(MAX_NAME_LENGTH + 1) },
      { t: 'hello', v: 1, hubName: `Hub${BELL}` },
      { t: 'lock', f0Hz: 3000 },
      { t: 'lock', f0Hz: 3000, mode: null },
      { t: 'lock', f0Hz: null, mode: 'chirp' },
      { t: 'lock', f0Hz: 3000, mode: 'loud' },
      { t: 'lock', f0Hz: '3000', mode: 'chirp' },
      { t: 'lock', f0Hz: -5, mode: 'chirp' },
      { t: 'lock', f0Hz: 0, mode: 'chirp' },
      { t: 'lock', f0Hz: 1e9, mode: 'chirp' },
      { t: 'ping', id: -1, hubMs: 0 },
      { t: 'ping', id: 1.5, hubMs: 0 },
      { t: 'ping', id: 1 },
      { t: 'ping', id: 1, hubMs: 1e15 },
      { t: 'calibrate', on: 'yes' },
      { t: 'calibrate' },
    ]
    for (const raw of bad) expect(parseHubMessage(raw), JSON.stringify(raw)).toBeNull()
  })

  it('rejects NaN and infinite numbers', () => {
    for (const x of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(parseHubMessage({ t: 'lock', f0Hz: x, mode: 'chirp' })).toBeNull()
      expect(parseHubMessage({ t: 'ping', id: 1, hubMs: x })).toBeNull()
      expect(parseHubMessage({ t: 'ping', id: x, hubMs: 1 })).toBeNull()
      expect(parseHubMessage({ t: 'hello', v: x, hubName: 'Hub' })).toBeNull()
    }
  })
})

describe('parseStationMessage', () => {
  it('accepts every station message type as sent over the wire', () => {
    for (const m of VALID_STATION) expect(parseStationMessage(wire(m)), m.t).toEqual(m)
  })

  it('returns a fresh object with only the known fields', () => {
    const raw = { t: 'chirp', onsetMs: 1, levelDb: -50, snrDb: 20, clipped: false, audio: [1, 2, 3] }
    const parsed = parseStationMessage(raw)
    expect(parsed).toEqual({ t: 'chirp', onsetMs: 1, levelDb: -50, snrDb: 20, clipped: false })
    expect(Object.keys(parsed!)).toEqual(['t', 'onsetMs', 'levelDb', 'snrDb', 'clipped'])
  })

  it('rejects non-objects, unknown and hub message types', () => {
    for (const raw of [null, 3, 'chirp', [], {}, { t: 'CHIRP' }, { t: 'level ' }]) {
      expect(parseStationMessage(raw), JSON.stringify(raw)).toBeNull()
    }
    for (const m of VALID_HUB) {
      if (m.t !== 'bye') expect(parseStationMessage(wire(m)), m.t).toBeNull()
    }
  })

  it('rejects malformed fields', () => {
    const bad: readonly unknown[] = [
      { t: 'hi', v: 1, name: 'Hall' },
      { t: 'hi', v: 1, name: 'Hall', rawAudio: 'cooked' },
      { t: 'hi', v: 1, name: '', rawAudio: 'raw' },
      { t: 'hi', v: 1, name: 'x'.repeat(MAX_NAME_LENGTH + 1), rawAudio: 'raw' },
      { t: 'hi', v: 1, name: 'x'.repeat(10_000), rawAudio: 'raw' },
      { t: 'hi', v: 1, name: `Hall${NEWLINE}Bedroom`, rawAudio: 'raw' },
      { t: 'hi', v: 1, name: `${RLO}llaH`, rawAudio: 'raw' },
      { t: 'hi', v: 1, name: `Hall${LINE_SEP}`, rawAudio: 'raw' },
      { t: 'hi', v: 1, name: ['Hall'], rawAudio: 'raw' },
      { t: 'hi', v: -1, name: 'Hall', rawAudio: 'raw' },
      { t: 'pong', id: 1, hubMs: 1 },
      { t: 'pong', id: '1', hubMs: 1, stationMs: 2 },
      { t: 'chirp', onsetMs: 1, levelDb: -50, snrDb: 20 },
      { t: 'chirp', onsetMs: 1, levelDb: -50, snrDb: 20, clipped: 0 },
      { t: 'chirp', onsetMs: 1, levelDb: 1e6, snrDb: 20, clipped: false },
      { t: 'chirp', onsetMs: 1, levelDb: -1e6, snrDb: 20, clipped: false },
      { t: 'chirp', onsetMs: 1, levelDb: -50, snrDb: 1e6, clipped: false },
      { t: 'chirp', onsetMs: '1', levelDb: -50, snrDb: 20, clipped: false },
      { t: 'chirp', onsetMs: null, levelDb: -50, snrDb: 20, clipped: false },
      { t: 'level', levelDb: -50, clipped: false },
      { t: 'level', levelDb: -50, atMs: 1 },
      { t: 'level', levelDb: '-50', atMs: 1, clipped: false },
    ]
    for (const raw of bad) expect(parseStationMessage(raw), JSON.stringify(raw)).toBeNull()
  })

  it('rejects NaN and infinite numbers', () => {
    for (const x of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(parseStationMessage({ t: 'chirp', onsetMs: x, levelDb: -50, snrDb: 20, clipped: false })).toBeNull()
      expect(parseStationMessage({ t: 'chirp', onsetMs: 1, levelDb: x, snrDb: 20, clipped: false })).toBeNull()
      expect(parseStationMessage({ t: 'chirp', onsetMs: 1, levelDb: -50, snrDb: x, clipped: false })).toBeNull()
      expect(parseStationMessage({ t: 'level', levelDb: x, atMs: 1, clipped: false })).toBeNull()
      expect(parseStationMessage({ t: 'level', levelDb: -50, atMs: x, clipped: false })).toBeNull()
      expect(parseStationMessage({ t: 'pong', id: 1, hubMs: x, stationMs: 1 })).toBeNull()
      expect(parseStationMessage({ t: 'pong', id: 1, hubMs: 1, stationMs: x })).toBeNull()
    }
  })
})

describe('cleanName', () => {
  it('trims and bounds names by code points', () => {
    expect(cleanName('  Living room  ')).toBe('Living room')
    expect(cleanName('x'.repeat(MAX_NAME_LENGTH))).toBe('x'.repeat(MAX_NAME_LENGTH))
    expect(cleanName(`  ${'x'.repeat(MAX_NAME_LENGTH)}  `)).toBe('x'.repeat(MAX_NAME_LENGTH))
    expect(cleanName('x'.repeat(MAX_NAME_LENGTH + 1))).toBeNull()
    // Astral characters count once each (two UTF-16 units).
    const astral = String.fromCodePoint(0x1f50a)
    expect(cleanName(astral.repeat(MAX_NAME_LENGTH))).toBe(astral.repeat(MAX_NAME_LENGTH))
    expect(cleanName(astral.repeat(MAX_NAME_LENGTH + 1))).toBeNull()
    expect(cleanName('Küche')).toBe('Küche')
  })

  it('rejects empty, non-string and control-character names', () => {
    for (const bad of ['', '   ', 5, null, undefined, {}, `a${BELL}`, `a${NEWLINE}b`, `${RLO}x`, `x${LINE_SEP}`]) {
      expect(cleanName(bad)).toBeNull()
    }
  })
})
