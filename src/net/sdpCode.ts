/**
 * Compact pairing codes. Two devices connect over WebRTC without a signalling server: the SDP
 * offer and answer are carried by the user as QR codes, so they must be tiny. A data-channel-only
 * session only needs the ICE credentials, the DTLS fingerprint, the DTLS role and the UDP
 * candidates; this module squeezes those into about 90 bytes ('SW1.' + base64url) and rebuilds a
 * complete SDP that Chrome, Firefox and Safari accept from them.
 *
 * Pure: no DOM or WebRTC APIs.
 */

/** One UDP ICE candidate (TCP candidates are dropped). */
export interface CompactCandidate {
  /** Canonical IPv4, canonical (RFC 5952) IPv6, or an mDNS name ending in .local. */
  readonly address: string
  readonly port: number
  readonly typ: 'host' | 'srflx' | 'prflx' | 'relay'
}

/** Everything a data-channel-only offer or answer needs. */
export interface CompactSdp {
  readonly type: 'offer' | 'answer'
  readonly ufrag: string
  readonly pwd: string
  /** SHA-256 DTLS certificate fingerprint, 32 bytes. */
  readonly fingerprint: Uint8Array
  readonly setup: 'actpass' | 'active' | 'passive'
  readonly candidates: readonly CompactCandidate[]
  /**
   * Answers: offerTag() of the offer this answer was made for (0..65535), so the hub can tell at
   * once that a scanned answer belongs to another pairing code. Absent on offers.
   */
  readonly answersTo?: number
}

/** Prefix of every pairing code; the digit is the code format version. */
export const CODE_PREFIX = 'SW1.'

/** Candidates a pairing code carries at most (see encodeCodeWithin). */
export const CODE_MAX_CANDIDATES = 6
/**
 * Longest pairing code worth showing: 210 characters still fit QR version 10 at error correction
 * M (57 modules, about 3.4 px per module in a 220 px square). A typical code is 100-150.
 */
export const CODE_MAX_CHARS = 210

const FORMAT_VERSION = 1
const FINGERPRINT_BYTES = 32
const MAX_TEXT_BYTES = 255
/** Flags byte: bit 0 answer, bits 1-2 setup, bit 3 an answersTo tag follows; the rest must be 0. */
const FLAG_ANSWER = 0x01
const FLAG_TAG = 0x08
const FLAG_RESERVED = 0xf0

const TYPS: readonly CompactCandidate['typ'][] = ['host', 'srflx', 'prflx', 'relay']
const SETUPS: readonly CompactSdp['setup'][] = ['actpass', 'active', 'passive']
/** RFC 8445 type preference per candidate type, for the rebuilt a=candidate priorities. */
const TYPE_PREF: Readonly<Record<CompactCandidate['typ'], number>> = { host: 126, prflx: 110, srflx: 100, relay: 0 }

/** Address kinds in the binary layout. */
const KIND_IPV4 = 0
const KIND_IPV6 = 1
/** Chrome's mDNS names: a lowercase UUID + '.local', stored as its 16 bytes. */
const KIND_MDNS_UUID = 2
/** Any other mDNS name, stored as length-prefixed ASCII. */
const KIND_MDNS_TEXT = 3

// ---- User-presentable decode errors ------------------------------------------------------------

const ERR_NOT_A_CODE = 'This is not a Soundwave pairing code.'
const ERR_INCOMPLETE = 'This pairing code is incomplete. Scan or copy the whole code and try again.'
const ERR_VERSION =
  'This pairing code comes from a different version of Soundwave. Reload the app on both devices and try again.'
const ERR_DAMAGED = 'This pairing code is damaged. Scan or copy it again.'

// ---- Addresses ---------------------------------------------------------------------------------

const ICE_CHARS = /^[A-Za-z0-9+/]+$/
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const MDNS_NAME = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.local$/
const MDNS_UUID = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/

/** The 4 bytes of a dotted-quad IPv4 address, or null. */
export function parseIpv4(s: string): Uint8Array | null {
  const m = IPV4.exec(s)
  if (m === null) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const v = Number(m[i + 1])
    if (v > 255) return null
    out[i] = v
  }
  return out
}

function formatIpv4(b: Uint8Array, offset = 0): string {
  return `${b[offset]}.${b[offset + 1]}.${b[offset + 2]}.${b[offset + 3]}`
}

function parseGroups(part: string): number[] | null {
  if (part === '') return []
  const out: number[] = []
  for (const g of part.split(':')) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    out.push(parseInt(g, 16))
  }
  return out
}

/**
 * The 16 bytes of an IPv6 address, or null. Accepts '::' compression, an embedded IPv4 tail and
 * a zone suffix ('%eth0', dropped: it only means something on the sending device).
 */
export function parseIpv6(s: string): Uint8Array | null {
  let text = s.toLowerCase()
  const pct = text.indexOf('%')
  if (pct >= 0) text = text.slice(0, pct)
  if (!text.includes(':')) return null

  let tail4: Uint8Array | null = null
  const lastColon = text.lastIndexOf(':')
  const last = text.slice(lastColon + 1)
  if (last.includes('.')) {
    tail4 = parseIpv4(last)
    if (tail4 === null) return null
    // Two placeholder groups; the ':' is kept so '::1.2.3.4' still splits correctly.
    text = text.slice(0, lastColon + 1) + '0:0'
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  let groups: number[]
  if (halves.length === 2) {
    const head = parseGroups(halves[0]!)
    const tail = parseGroups(halves[1]!)
    if (head === null || tail === null || head.length + tail.length > 7) return null
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail]
  } else {
    const all = parseGroups(text)
    if (all === null || all.length !== 8) return null
    groups = all
  }

  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    out[2 * i] = groups[i]! >> 8
    out[2 * i + 1] = groups[i]! & 0xff
  }
  if (tail4 !== null) out.set(tail4, 12)
  return out
}

/** RFC 5952 text form: lowercase, no leading zeros, the longest run (>= 2) of zero groups as '::'. */
export function formatIpv6(b: Uint8Array): string {
  const groups: number[] = []
  for (let i = 0; i < 8; i++) groups.push((b[2 * i]! << 8) | b[2 * i + 1]!)

  // IPv4-mapped addresses keep the dotted tail (RFC 5952 section 5).
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return `::ffff:${formatIpv4(b, 12)}`

  let bestStart = -1
  let bestLen = 0
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > bestLen) {
      bestStart = i
      bestLen = j - i
    }
    i = j
  }
  const hex = (gs: number[]): string => gs.map((g) => g.toString(16)).join(':')
  if (bestLen < 2) return hex(groups)
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLen))}`
}

/** Canonical form of a candidate address (IPv4, IPv6 or mDNS name), or null when unsupported. */
function canonicalAddress(address: string): string | null {
  const v4 = parseIpv4(address)
  if (v4 !== null) return formatIpv4(v4)
  const v6 = parseIpv6(address)
  if (v6 !== null) return formatIpv6(v6)
  if (address.length <= MAX_TEXT_BYTES && MDNS_NAME.test(address)) return address
  return null
}

// ---- SDP text ----------------------------------------------------------------------------------

function attribute(lines: readonly string[], name: string): string | null {
  const prefix = `a=${name}:`
  for (const line of lines) if (line.startsWith(prefix)) return line.slice(prefix.length).trim()
  return null
}

function parseCandidate(value: string): CompactCandidate | null {
  // foundation component transport priority address port 'typ' type [extensions...]
  const f = value.trim().split(/\s+/)
  if (f.length < 8 || f[1] !== '1' || f[2]!.toLowerCase() !== 'udp' || f[6] !== 'typ') return null
  const typ = TYPS.find((t) => t === f[7])
  if (typ === undefined) return null
  if (!/^\d{1,5}$/.test(f[5]!)) return null
  const port = Number(f[5])
  if (port < 1 || port > 65535) return null
  const address = canonicalAddress(f[4]!)
  if (address === null) return null
  return { address, port, typ }
}

function parseFingerprint(lines: readonly string[]): Uint8Array | null {
  for (const line of lines) {
    const m = /^a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)$/i.exec(line)
    if (m === null) continue
    const parts = m[1]!.split(':')
    if (parts.length !== FINGERPRINT_BYTES || !parts.every((p) => /^[0-9A-Fa-f]{2}$/.test(p))) continue
    return Uint8Array.from(parts, (p) => parseInt(p, 16))
  }
  return null
}

function validIceText(s: string): boolean {
  return s.length >= 1 && s.length <= MAX_TEXT_BYTES && ICE_CHARS.test(s)
}

/**
 * Extract the compact form from a browser's localDescription.sdp (data-channel-only session).
 * Keeps UDP candidates of component 1 in their original order; TCP and unparseable candidates are
 * dropped. Throws an Error naming what is missing when ufrag, pwd or a sha-256 fingerprint is absent.
 */
export function parseSdp(sdp: string, type: 'offer' | 'answer'): CompactSdp {
  const lines = sdp.split(/\r?\n/).map((l) => l.trim())
  const ufrag = attribute(lines, 'ice-ufrag')
  if (ufrag === null) throw new Error('SDP has no a=ice-ufrag line')
  if (!validIceText(ufrag)) throw new Error('SDP has an unsupported a=ice-ufrag value')
  const pwd = attribute(lines, 'ice-pwd')
  if (pwd === null) throw new Error('SDP has no a=ice-pwd line')
  if (!validIceText(pwd)) throw new Error('SDP has an unsupported a=ice-pwd value')
  const fingerprint = parseFingerprint(lines)
  if (fingerprint === null) throw new Error('SDP has no a=fingerprint:sha-256 line')

  const setupText = attribute(lines, 'setup')
  const setup = SETUPS.find((s) => s === setupText) ?? (type === 'offer' ? 'actpass' : 'active')

  const candidates: CompactCandidate[] = []
  for (const line of lines) {
    if (!line.startsWith('a=candidate:')) continue
    const c = parseCandidate(line.slice('a=candidate:'.length))
    if (c !== null) candidates.push(c)
  }
  return { type, ufrag, pwd, fingerprint, setup, candidates }
}

function hex2(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, '0')
}

/** Priority of the index-th candidate: RFC 8445 formula (local preference 65535 - index, component 1). */
function candidatePriority(typ: CompactCandidate['typ'], index: number): number {
  return TYPE_PREF[typ] * 2 ** 24 + (65535 - Math.min(index, 65535)) * 2 ** 8 + 255
}

/**
 * A complete SDP (CRLF line endings) for setRemoteDescription, rebuilt from the compact form.
 * Deterministic: the o= session id is derived from the fingerprint.
 */
export function buildSdp(c: CompactSdp): string {
  let sessionId = 0
  for (let i = 0; i < 6; i++) sessionId = sessionId * 256 + (c.fingerprint[i] ?? 0)
  sessionId += 1
  const lines = [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${c.ufrag}`,
    `a=ice-pwd:${c.pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${Array.from(c.fingerprint, hex2).join(':')}`,
    `a=setup:${c.setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ]
  c.candidates.forEach((cand, i) => {
    const related = cand.typ === 'host' ? '' : ' raddr 0.0.0.0 rport 0'
    const priority = candidatePriority(cand.typ, i)
    lines.push(`a=candidate:${i + 1} 1 udp ${priority} ${cand.address} ${cand.port} typ ${cand.typ}${related}`)
  })
  lines.push('a=end-of-candidates')
  return lines.join('\r\n') + '\r\n'
}

// ---- Candidate selection -----------------------------------------------------------------------

function candidateRank(c: CompactCandidate): number {
  const base = c.typ === 'host' ? 0 : 10
  const v4 = parseIpv4(c.address)
  if (v4 !== null) return base + (v4[0] === 169 && v4[1] === 254 ? 3 : 0)
  if (c.address.endsWith('.local')) return base + 1
  return base + (c.address.startsWith('fe80:') ? 3 : 2)
}

/**
 * The candidates worth putting in a pairing code, at most `max`: duplicates dropped, host before
 * the other types, and within each type IPv4, then mDNS names, then IPv6, with link-local
 * addresses (169.254/16, fe80::/10) last, keeping the browser's order within each class. When
 * `max` is 2 or more, the best non-host candidate (the server-reflexive one from the STUN lookup,
 * the only one that works across networks) always makes it in: it takes the last slot from a host
 * candidate when the host candidates alone would fill the code, as they do on a laptop with
 * virtual adapters.
 */
export function pickCandidates(candidates: readonly CompactCandidate[], max: number): CompactCandidate[] {
  const seen = new Set<string>()
  const unique: CompactCandidate[] = []
  for (const c of candidates) {
    const key = `${c.address} ${c.port}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(c)
  }
  const ranked = unique
    .map((c, i) => ({ c, i, r: candidateRank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c)
  const limit = Math.max(0, max)
  const bestOther = ranked.findIndex((c) => c.typ !== 'host')
  if (limit >= 2 && bestOther >= limit) return [...ranked.slice(0, limit - 1), ranked[bestOther]!]
  return ranked.slice(0, limit)
}

// ---- Binary layout -----------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function base64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6))
    for (let k = 0; k < chars; k++) out += B64[(n >> (18 - 6 * k)) & 63]
  }
  return out
}

/** Decoded bytes, or null for an impossible length. The text must only hold base64url characters. */
function fromBase64url(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((text.length * 6) / 8))
  let acc = 0
  let bits = 0
  let o = 0
  for (const ch of text) {
    acc = ((acc << 6) | B64.indexOf(ch)) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out
}

/**
 * 16-bit tag of an offer, from its ICE credentials and DTLS fingerprint (FNV-1a folded to 16 bits).
 * The station puts it in its answer (answersTo) so the hub can recognise an answer to another offer.
 */
export function offerTag(c: CompactSdp): number {
  let h = 0x811c9dc5
  const feed = (b: number): void => {
    h = Math.imul(h ^ b, 0x01000193) >>> 0
  }
  for (let i = 0; i < c.ufrag.length; i++) feed(c.ufrag.charCodeAt(i) & 0xff)
  feed(0)
  for (let i = 0; i < c.pwd.length; i++) feed(c.pwd.charCodeAt(i) & 0xff)
  feed(0)
  for (const b of c.fingerprint) feed(b)
  return (h ^ (h >>> 16)) & 0xffff
}

/** CRC-8 (polynomial 0x07) of bytes[0, end): catches damaged or mistyped codes. */
function crc8(bytes: ArrayLike<number>, end: number): number {
  let crc = 0
  for (let i = 0; i < end; i++) {
    crc ^= bytes[i]!
    for (let k = 0; k < 8; k++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  }
  return crc
}

function pushText(out: number[], s: string, what: string): void {
  if (s.length > MAX_TEXT_BYTES || !/^[\x20-\x7e]*$/.test(s)) throw new Error(`Cannot encode ${what}`)
  out.push(s.length)
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i))
}

/** Append the address bytes; returns the address kind. */
function pushAddress(out: number[], address: string): number {
  const v4 = parseIpv4(address)
  if (v4 !== null) {
    out.push(...v4)
    return KIND_IPV4
  }
  const uuid = MDNS_UUID.exec(address)
  if (uuid !== null) {
    const hex = uuid.slice(1).join('')
    for (let i = 0; i < 32; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16))
    return KIND_MDNS_UUID
  }
  const v6 = parseIpv6(address)
  if (v6 !== null) {
    out.push(...v6)
    return KIND_IPV6
  }
  if (!MDNS_NAME.test(address)) throw new Error(`Cannot encode candidate address ${address}`)
  pushText(out, address, 'an mDNS name')
  return KIND_MDNS_TEXT
}

/**
 * The pairing code: 'SW1.' + base64url (no padding) of
 * version u8 | flags u8 (bit 0 answer, bits 1-2 setup, bit 3 tag) | [answersTo u16 BE when bit 3] |
 * ufrag (u8 length + ASCII) | pwd (same) | 32 fingerprint bytes | candidate count u8 |
 * per candidate: kind << 4 | typ (u8), address (IPv4 4 bytes, IPv6 16, UUID mDNS name 16, other
 * mDNS name u8 length + ASCII), port u16 BE | CRC-8 of everything before it.
 * Throws on values the layout cannot hold.
 */
export function encodeCode(c: CompactSdp): string {
  if (c.fingerprint.length !== FINGERPRINT_BYTES) throw new Error('Fingerprint must be 32 bytes')
  if (c.candidates.length > 255) throw new Error('Too many candidates')
  const setup = SETUPS.indexOf(c.setup)
  if (setup < 0) throw new Error('Bad DTLS setup role')
  const tag = c.answersTo
  if (tag !== undefined && !(Number.isInteger(tag) && tag >= 0 && tag <= 0xffff)) throw new Error('Bad offer tag')
  const flags = (c.type === 'answer' ? FLAG_ANSWER : 0) | (setup << 1) | (tag !== undefined ? FLAG_TAG : 0)
  const out: number[] = [FORMAT_VERSION, flags]
  if (tag !== undefined) out.push(tag >> 8, tag & 0xff)
  pushText(out, c.ufrag, 'ufrag')
  pushText(out, c.pwd, 'pwd')
  out.push(...c.fingerprint, c.candidates.length)
  for (const cand of c.candidates) {
    if (!Number.isInteger(cand.port) || cand.port < 1 || cand.port > 65535) throw new Error('Bad candidate port')
    const typ = TYPS.indexOf(cand.typ)
    if (typ < 0) throw new Error('Bad candidate type')
    const at = out.length
    out.push(0)
    out[at] = (pushAddress(out, cand.address) << 4) | typ
    out.push(cand.port >> 8, cand.port & 0xff)
  }
  out.push(crc8(out, out.length))
  return CODE_PREFIX + base64url(Uint8Array.from(out))
}

/**
 * The pairing code of `c` with its most useful candidates (pickCandidates order): at most
 * maxCandidates, and fewer while the code is longer than maxChars, so the QR code stays easy to
 * scan (at least one candidate is kept when there is any). Each shorter choice is pickCandidates'
 * own, so the across-network candidate stays in the code as long as it keeps 2 or more. Throws
 * like encodeCode.
 */
export function encodeCodeWithin(c: CompactSdp, maxCandidates: number, maxChars: number): string {
  const picked = pickCandidates(c.candidates, maxCandidates)
  let code = encodeCode({ ...c, candidates: picked })
  for (let n = picked.length - 1; n >= 1 && code.length > maxChars; n--) {
    code = encodeCode({ ...c, candidates: pickCandidates(c.candidates, n) })
  }
  return code
}

/** Sequential reader that throws the "incomplete" error when the data runs out. */
class Reader {
  private readonly bytes: Uint8Array
  pos = 0
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }
  get remaining(): number {
    return this.bytes.length - this.pos
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new Error(ERR_INCOMPLETE)
    const out = this.bytes.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  u8(): number {
    return this.take(1)[0]!
  }
  u16(): number {
    const b = this.take(2)
    return (b[0]! << 8) | b[1]!
  }
  text(): string {
    return String.fromCharCode(...this.take(this.u8()))
  }
}

function readAddress(r: Reader, kind: number): string {
  switch (kind) {
    case KIND_IPV4:
      return formatIpv4(r.take(4))
    case KIND_IPV6:
      return formatIpv6(r.take(16))
    case KIND_MDNS_UUID: {
      const h = Array.from(r.take(16), (b) => b.toString(16).padStart(2, '0')).join('')
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`
    }
    case KIND_MDNS_TEXT: {
      const name = r.text()
      if (!MDNS_NAME.test(name)) throw new Error(ERR_DAMAGED)
      return name
    }
    default:
      throw new Error(ERR_DAMAGED)
  }
}

/** 'SW<n>.' where a code starts ('.' never occurs inside a code body). */
const TOKEN = /SW(\d+)\./gi
const BODY = /^[A-Za-z0-9_-]*/
/**
 * 'SW<n>' ending a run of code characters: the start of a second code pasted right behind the
 * first ('SW1.abcSW1.abc'), possibly with its '.' already cut off by the caller.
 */
const TRAILING_PREFIX = /SW\d+$/i

/**
 * Decode a pairing code. Tolerates surrounding whitespace and other text around it. When the text
 * holds several 'SW<n>.' tokens (a code pasted twice, or next to an older one) the first one that
 * decodes is used. Throws an Error with a user-presentable message when the text holds no code,
 * the code is truncated or damaged, or it comes from another format version.
 */
export function decodeCode(code: string): CompactSdp {
  const text = typeof code === 'string' ? code : ''
  const tokens = [...text.matchAll(TOKEN)]
  if (tokens.length === 0) throw new Error(ERR_NOT_A_CODE)
  /** Error of the first token of this version, else the version error. */
  let error: Error | null = null
  for (const token of tokens) {
    if (Number(token[1]) !== FORMAT_VERSION) {
      error ??= new Error(ERR_VERSION)
      continue
    }
    const run = BODY.exec(text.slice(token.index + token[0].length))![0]
    // A body may itself end in 'SW' + digits (rarely), so the whole run is tried first and the
    // layout and the CRC tell the two readings apart.
    const bodies = TRAILING_PREFIX.test(run) ? [run, run.replace(TRAILING_PREFIX, '')] : [run]
    let first: Error | null = null
    for (const body of bodies) {
      try {
        return decodeBody(body)
      } catch (err) {
        first ??= err instanceof Error ? err : new Error(ERR_DAMAGED)
      }
    }
    if (error === null || error.message === ERR_VERSION) error = first
  }
  throw error ?? new Error(ERR_NOT_A_CODE)
}

/** Decode the base64url part of a code (after 'SW1.'). */
function decodeBody(body: string): CompactSdp {
  if (body === '') throw new Error(ERR_INCOMPLETE)
  const bytes = fromBase64url(body)
  if (bytes === null) throw new Error(ERR_INCOMPLETE)

  const r = new Reader(bytes)
  if (r.u8() !== FORMAT_VERSION) {
    // The prefix said version 1: a different version byte with an intact checksum is a code from
    // another app version; with a broken checksum it is a mistyped or misread first character.
    const intact = bytes.length >= 2 && bytes[bytes.length - 1] === crc8(bytes, bytes.length - 1)
    throw new Error(intact ? ERR_VERSION : ERR_DAMAGED)
  }
  const flags = r.u8()
  const setup = SETUPS[(flags >> 1) & 3]
  if (setup === undefined || (flags & FLAG_RESERVED) !== 0) throw new Error(ERR_DAMAGED)
  const type = flags & FLAG_ANSWER ? 'answer' : 'offer'
  const answersTo = flags & FLAG_TAG ? r.u16() : null
  const ufrag = r.text()
  const pwd = r.text()
  const fingerprint = r.take(FINGERPRINT_BYTES)
  const count = r.u8()
  const candidates: CompactCandidate[] = []
  for (let i = 0; i < count; i++) {
    const head = r.u8()
    const typ = TYPS[head & 0x0f]
    if (typ === undefined) throw new Error(ERR_DAMAGED)
    const address = readAddress(r, head >> 4)
    const port = r.u16()
    if (port === 0) throw new Error(ERR_DAMAGED)
    candidates.push({ address, port, typ })
  }
  const end = r.pos
  const check = r.u8()
  if (r.remaining !== 0 || check !== crc8(bytes, end)) throw new Error(ERR_DAMAGED)
  if (!validIceText(ufrag) || !validIceText(pwd)) throw new Error(ERR_DAMAGED)
  const base: CompactSdp = { type, ufrag, pwd, fingerprint, setup, candidates }
  return answersTo === null ? base : { ...base, answersTo }
}
