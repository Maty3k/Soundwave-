import { describe, expect, it } from 'vitest'
import {
  buildSdp,
  CODE_MAX_CANDIDATES,
  CODE_MAX_CHARS,
  CODE_PREFIX,
  decodeCode,
  encodeCode,
  encodeCodeWithin,
  formatIpv6,
  offerTag,
  parseIpv4,
  parseIpv6,
  parseSdp,
  pickCandidates,
} from './sdpCode.ts'
import type { CompactCandidate, CompactSdp } from './sdpCode.ts'

const FINGERPRINT_HEX =
  '4F:1A:9C:22:7B:E0:13:D8:56:AA:01:FE:3C:88:94:6D:B2:07:5E:C1:29:F4:80:3A:DD:62:17:9B:C5:40:E8:71'
const FINGERPRINT = Uint8Array.from(FINGERPRINT_HEX.split(':'), (h) => parseInt(h, 16))
const UUID_NAME = '7c9d5e1a-3b2f-4c8d-9e6f-0a1b2c3d4e5f.local'

/** A data-channel-only offer as Chrome writes it (IPv4, IPv6, mDNS, TCP and srflx candidates). */
const CHROME_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:2999745851 1 udp 2122260223 192.168.1.23 58443 typ host generation 0 network-id 1 network-cost 10',
  'a=candidate:1425990487 1 udp 2122194687 10.8.0.6 49152 typ host generation 0 network-id 2',
  'a=candidate:3350409123 1 udp 2122129151 2a02:0810:0bc0:0d00:0000:0000:0000:0042 60231 typ host generation 0 network-id 3',
  `a=candidate:842163049 1 udp 2122063615 ${UUID_NAME} 51234 typ host generation 0 network-id 4`,
  'a=candidate:4233069003 1 tcp 1518280447 192.168.1.23 9 typ host tcptype active generation 0 network-id 1 network-cost 10',
  'a=candidate:3010537417 1 tcp 1518214911 2a02:810:bc0:d00::42 9 typ host tcptype active generation 0 network-id 3',
  'a=candidate:1034719810 1 udp 1686052607 203.0.113.7 58443 typ srflx raddr 192.168.1.23 rport 58443 generation 0 network-id 1',
  'a=ice-ufrag:Xq3v',
  'a=ice-pwd:7s9TfUqL2kPz+R/8wXy4mN1b',
  'a=ice-options:trickle',
  `a=fingerprint:sha-256 ${FINGERPRINT_HEX}`,
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n')

/** A Firefox-style answer: session-level fingerprint, 'UDP' in capitals, 8 / 32 character credentials. */
const FIREFOX_ANSWER = [
  'v=0',
  'o=mozilla...THIS_IS_SDPARTA-99.0 7063183838491427345 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  `a=fingerprint:sha-256 ${FINGERPRINT_HEX}`,
  'a=group:BUNDLE 0',
  'a=ice-options:trickle',
  'a=msid-semantic:WMS *',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:0 1 UDP 2122252543 192.168.1.40 61022 typ host',
  'a=candidate:1 1 UDP 2122187007 fd00::1c2b:3aff:fe4d:5e6f 50344 typ host',
  'a=candidate:2 1 TCP 2105524479 192.168.1.40 9 typ host tcptype active',
  'a=sendrecv',
  'a=end-of-candidates',
  'a=ice-pwd:9d4c2b1a0f8e7d6c5b4a39281706f5e4',
  'a=ice-ufrag:3f8a9c1e',
  'a=mid:0',
  'a=setup:active',
  'a=sctp-port:5000',
  'a=max-message-size:1073741823',
  '',
].join('\r\n')

function sdpWith(candidates: readonly CompactCandidate[], patch: Partial<CompactSdp> = {}): CompactSdp {
  return {
    type: 'offer',
    ufrag: 'Xq3v',
    pwd: '7s9TfUqL2kPz+R/8wXy4mN1b',
    fingerprint: FINGERPRINT,
    setup: 'actpass',
    candidates,
    ...patch,
  }
}

function host(address: string, port = 50000): CompactCandidate {
  return { address, port, typ: 'host' }
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Base64url body of a code as bytes (independent test implementation). */
function codeBytes(code: string): Uint8Array {
  const body = code.slice(CODE_PREFIX.length)
  const bits = Array.from(body, (ch) => B64URL.indexOf(ch).toString(2).padStart(6, '0')).join('')
  const out = new Uint8Array(Math.floor(bits.length / 8))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(8 * i, 8 * i + 8), 2)
  return out
}

function codeFromBytes(bytes: Uint8Array): string {
  const bits = Array.from(bytes, (b) => b.toString(2).padStart(8, '0')).join('')
  let out = ''
  for (let i = 0; i < bits.length; i += 6) out += B64URL[parseInt(bits.slice(i, i + 6).padEnd(6, '0'), 2)]
  return CODE_PREFIX + out
}

/** Same CRC-8 (polynomial 0x07) as the codec, to forge codes that pass the checksum. */
function crc8(bytes: ArrayLike<number>, end: number): number {
  let crc = 0
  for (let i = 0; i < end; i++) {
    crc ^= bytes[i]!
    for (let k = 0; k < 8; k++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  }
  return crc
}

function withValidCrc(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice()
  out[out.length - 1] = crc8(out, out.length - 1)
  return out
}

describe('parseSdp', () => {
  it('extracts credentials, fingerprint, role and the UDP candidates of a Chrome offer', () => {
    const c = parseSdp(CHROME_OFFER, 'offer')
    expect(c.type).toBe('offer')
    expect(c.ufrag).toBe('Xq3v')
    expect(c.pwd).toBe('7s9TfUqL2kPz+R/8wXy4mN1b')
    expect(c.setup).toBe('actpass')
    expect(Array.from(c.fingerprint)).toEqual(Array.from(FINGERPRINT))
    expect(c.candidates).toEqual([
      { address: '192.168.1.23', port: 58443, typ: 'host' },
      { address: '10.8.0.6', port: 49152, typ: 'host' },
      { address: '2a02:810:bc0:d00::42', port: 60231, typ: 'host' },
      { address: UUID_NAME, port: 51234, typ: 'host' },
      { address: '203.0.113.7', port: 58443, typ: 'srflx' },
    ])
  })

  it('reads a Firefox answer (session-level fingerprint, UDP in capitals, TCP dropped)', () => {
    const c = parseSdp(FIREFOX_ANSWER, 'answer')
    expect(c.type).toBe('answer')
    expect(c.ufrag).toBe('3f8a9c1e')
    expect(c.pwd).toBe('9d4c2b1a0f8e7d6c5b4a39281706f5e4')
    expect(c.setup).toBe('active')
    expect(c.candidates).toEqual([
      { address: '192.168.1.40', port: 61022, typ: 'host' },
      { address: 'fd00::1c2b:3aff:fe4d:5e6f', port: 50344, typ: 'host' },
    ])
  })

  it('accepts LF-only line endings and defaults a missing a=setup by type', () => {
    const lf = CHROME_OFFER.replace(/\r\n/g, '\n').replace('a=setup:actpass\n', '')
    expect(parseSdp(lf, 'offer').setup).toBe('actpass')
    expect(parseSdp(lf, 'answer').setup).toBe('active')
    expect(parseSdp(lf, 'offer').candidates).toHaveLength(5)
  })

  it('drops component-2, unknown-type and unparseable candidates', () => {
    const extra = [
      'a=candidate:9 2 udp 2122260222 192.168.1.23 58444 typ host',
      'a=candidate:9 1 udp 2122260222 192.168.1.23 58445 typ weird',
      'a=candidate:9 1 udp 2122260222 not_a_host 58446 typ host',
      'a=candidate:9 1 udp 2122260222 192.168.1.300 58447 typ host',
      'a=candidate:9 1 udp 2122260222 192.168.1.23 0 typ host',
      'a=candidate:9 1 udp 2122260222 192.168.1.23',
    ].join('\r\n')
    const c = parseSdp(CHROME_OFFER.replace('a=ice-ufrag', `${extra}\r\na=ice-ufrag`), 'offer')
    expect(c.candidates).toHaveLength(5)
  })

  it('throws a clear error when ufrag, pwd or the sha-256 fingerprint is missing', () => {
    expect(() => parseSdp(CHROME_OFFER.replace(/a=ice-ufrag:.*\r\n/, ''), 'offer')).toThrow(/ice-ufrag/)
    expect(() => parseSdp(CHROME_OFFER.replace(/a=ice-pwd:.*\r\n/, ''), 'offer')).toThrow(/ice-pwd/)
    expect(() => parseSdp(CHROME_OFFER.replace(/a=fingerprint:.*\r\n/, ''), 'offer')).toThrow(/fingerprint/)
    const sha1Line = 'a=fingerprint:sha-1 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01\r\n'
    const sha1 = CHROME_OFFER.replace(/a=fingerprint:.*\r\n/, sha1Line)
    expect(() => parseSdp(sha1, 'offer')).toThrow(/sha-256/)
    expect(() => parseSdp('', 'offer')).toThrow(Error)
  })
})

describe('encodeCode / decodeCode', () => {
  it('round-trips a parsed Chrome offer and a Firefox answer exactly', () => {
    for (const [sdp, type] of [
      [CHROME_OFFER, 'offer'],
      [FIREFOX_ANSWER, 'answer'],
    ] as const) {
      const c = parseSdp(sdp, type)
      const code = encodeCode(c)
      expect(code.startsWith(CODE_PREFIX)).toBe(true)
      expect(code).toMatch(/^SW1\.[A-Za-z0-9_-]+$/)
      expect(decodeCode(code)).toEqual(c)
    }
  })

  it('round-trips every setup, type and candidate type', () => {
    for (const setup of ['actpass', 'active', 'passive'] as const) {
      for (const type of ['offer', 'answer'] as const) {
        for (const typ of ['host', 'srflx', 'prflx', 'relay'] as const) {
          const c = sdpWith([{ address: '192.168.0.9', port: 65535, typ }, host('10.0.0.1', 1)], { setup, type })
          expect(decodeCode(encodeCode(c))).toEqual(c)
        }
      }
    }
  })

  it('round-trips a code without candidates', () => {
    const c = sdpWith([])
    expect(decodeCode(encodeCode(c))).toEqual(c)
  })

  it('keeps a typical offer with 2-3 IPv4 host candidates under 160 characters', () => {
    const three = [host('192.168.1.23', 58443), host('10.8.0.6', 49152), host('172.20.10.2', 61000)]
    const chrome = encodeCode(sdpWith(three))
    expect(chrome.length).toBeLessThan(160)
    // Firefox credentials are longer (8 + 32 characters).
    const firefox = encodeCode(sdpWith(three, { ufrag: '3f8a9c1e', pwd: '9d4c2b1a0f8e7d6c5b4a39281706f5e4' }))
    expect(firefox.length).toBeLessThan(160)
    expect(encodeCode(sdpWith(three.slice(0, 2), { type: 'answer', setup: 'active' })).length).toBeLessThan(160)
  })

  it('finds the code inside surrounding whitespace and other text', () => {
    const c = parseSdp(CHROME_OFFER, 'offer')
    const code = encodeCode(c)
    expect(decodeCode(`  \n\t${code}\n  `)).toEqual(c)
    expect(decodeCode(`Here is my code: ${code}. Thanks!`)).toEqual(c)
    expect(decodeCode(`https://example.test/soundwave/#pair=${code}`)).toEqual(c)
  })

  it('rejects text without a code', () => {
    for (const bad of ['', '   ', 'hello', 'SW1', 'SW.abc', 'https://example.test/']) {
      expect(() => decodeCode(bad)).toThrow(/not a Soundwave pairing code/)
    }
  })

  it('rejects codes of another format version', () => {
    const code = encodeCode(sdpWith([host('192.168.1.2')]))
    expect(() => decodeCode(code.replace('SW1.', 'SW2.'))).toThrow(/different version/)
    const bytes = codeBytes(code)
    bytes[0] = 2
    expect(() => decodeCode(codeFromBytes(withValidCrc(bytes)))).toThrow(/different version/)
    // A misread first character (checksum broken) is damage, not another app version.
    const misread = codeBytes(code)
    misread[0] = 5
    expect(() => decodeCode(codeFromBytes(misread))).toThrow(/damaged/)
    const firstChar = code[CODE_PREFIX.length] === 'B' ? 'C' : 'B'
    const typo = CODE_PREFIX + firstChar + code.slice(CODE_PREFIX.length + 1)
    expect(() => decodeCode(typo)).toThrow(/damaged/)
  })

  it('rejects every truncation of a code', () => {
    const code = encodeCode(parseSdp(CHROME_OFFER, 'offer'))
    for (let len = CODE_PREFIX.length; len < code.length; len++) {
      expect(() => decodeCode(code.slice(0, len)), `length ${len}`).toThrow(/incomplete|damaged/)
    }
    expect(() => decodeCode('SW1.')).toThrow(/incomplete/)
    expect(() => decodeCode(code.slice(0, code.length - 10))).toThrow(/incomplete/)
  })

  it('rejects damaged codes: any changed character, extra bytes, reserved bits', () => {
    const code = encodeCode(parseSdp(CHROME_OFFER, 'offer'))
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    // The last character carries only 2-4 payload bits; stop before it.
    for (let i = CODE_PREFIX.length; i < code.length - 1; i++) {
      const ch = code[i]!
      const swapped = alphabet[(alphabet.indexOf(ch) + 17) % 64]!
      const bad = code.slice(0, i) + swapped + code.slice(i + 1)
      expect(() => decodeCode(bad), `position ${i}`).toThrow(Error)
    }

    const bytes = codeBytes(code)
    const longer = new Uint8Array(bytes.length + 1)
    longer.set(bytes)
    longer[longer.length - 1] = crc8(longer, longer.length - 1)
    expect(() => decodeCode(codeFromBytes(longer))).toThrow(/damaged/)

    for (const bit of [0x10, 0x20, 0x40, 0x80]) {
      const reserved = bytes.slice()
      reserved[1] = reserved[1]! | bit
      expect(() => decodeCode(codeFromBytes(withValidCrc(reserved))), `bit ${bit}`).toThrow(/damaged/)
    }

    const badSetup = bytes.slice()
    badSetup[1] = (badSetup[1]! & 1) | (3 << 1)
    expect(() => decodeCode(codeFromBytes(withValidCrc(badSetup)))).toThrow(/damaged/)
  })

  it('carries the tag of the answered offer in an answer', () => {
    const offer = parseSdp(CHROME_OFFER, 'offer')
    const answer = { ...parseSdp(FIREFOX_ANSWER, 'answer'), answersTo: offerTag(offer) }
    const code = encodeCode(answer)
    const back = decodeCode(code)
    expect(back).toEqual(answer)
    expect(back.answersTo).toBe(offerTag(offer))
    // Two more bytes than the same answer without a tag (base64url: 2-3 more characters).
    const untagged = encodeCode(parseSdp(FIREFOX_ANSWER, 'answer'))
    expect(code.length - untagged.length).toBeGreaterThanOrEqual(2)
    expect(code.length - untagged.length).toBeLessThanOrEqual(3)
    // Codes without a tag decode without the field.
    expect('answersTo' in decodeCode(untagged)).toBe(false)
    for (const tag of [0, 1, 0x1234, 0xffff]) {
      expect(decodeCode(encodeCode(sdpWith([host('10.0.0.1')], { type: 'answer', answersTo: tag }))).answersTo).toBe(tag)
    }
    for (const bad of [-1, 0x10000, 1.5, Number.NaN]) {
      expect(() => encodeCode(sdpWith([], { type: 'answer', answersTo: bad })), String(bad)).toThrow(Error)
    }
  })

  it('rejects every truncation of a tagged answer', () => {
    const code = encodeCode({ ...parseSdp(FIREFOX_ANSWER, 'answer'), answersTo: 0xbeef })
    for (let len = CODE_PREFIX.length; len < code.length; len++) {
      expect(() => decodeCode(code.slice(0, len)), `length ${len}`).toThrow(/incomplete|damaged/)
    }
  })

  it('rejects a checksum-valid code whose credentials are not ICE characters', () => {
    const code = encodeCode(sdpWith([host('192.168.1.2')], { ufrag: 'abcd' }))
    const bytes = codeBytes(code)
    bytes[3] = 0x20 // first ufrag character -> space
    expect(() => decodeCode(codeFromBytes(withValidCrc(bytes)))).toThrow(/damaged/)
  })

  it('refuses to encode what the layout cannot hold', () => {
    expect(() => encodeCode(sdpWith([], { fingerprint: new Uint8Array(31) }))).toThrow(Error)
    expect(() => encodeCode(sdpWith([host('printer.example.com')]))).toThrow(Error)
    expect(() => encodeCode(sdpWith([host('192.168.1.2', 0)]))).toThrow(Error)
    expect(() => encodeCode(sdpWith([host('192.168.1.2', 70000)]))).toThrow(Error)
    expect(() => encodeCode(sdpWith([], { ufrag: 'x'.repeat(256) }))).toThrow(Error)
  })
})

describe('addresses', () => {
  it('parses IPv4 dotted quads only', () => {
    expect(Array.from(parseIpv4('192.168.1.23')!)).toEqual([192, 168, 1, 23])
    expect(parseIpv4('256.1.1.1')).toBeNull()
    expect(parseIpv4('1.2.3')).toBeNull()
    expect(parseIpv4('1.2.3.4.5')).toBeNull()
    expect(parseIpv4('a.b.c.d')).toBeNull()
  })

  it('writes IPv6 in RFC 5952 form', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['2001:0db8:0000:0000:0000:ff00:0042:8329', '2001:db8::ff00:42:8329'],
      ['2001:DB8::FF00:42:8329', '2001:db8::ff00:42:8329'],
      ['::1', '::1'],
      ['::', '::'],
      ['1::', '1::'],
      ['fe80::1%en0', 'fe80::1'],
      ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
      ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
      ['2001:0:0:1:0:0:0:1', '2001:0:0:1::1'],
      ['2001:db8::0:1', '2001:db8::1'],
      ['::ffff:192.0.2.1', '::ffff:192.0.2.1'],
      ['64:ff9b::192.0.2.33', '64:ff9b::c000:221'],
      ['fd00:0:0:0:1c2b:3aff:fe4d:5e6f', 'fd00::1c2b:3aff:fe4d:5e6f'],
    ]
    for (const [input, canonical] of cases) {
      const bytes = parseIpv6(input)
      expect(bytes, input).not.toBeNull()
      expect(formatIpv6(bytes!), input).toBe(canonical)
      expect(formatIpv6(parseIpv6(canonical)!), canonical).toBe(canonical)
    }
  })

  it('rejects malformed IPv6', () => {
    const bad = ['1:2:3', '1::2::3', 'gggg::1', '1:2:3:4:5:6:7:8:9', '12345::1', '::1.2.3', '1.2.3.4', ':1:2:3:4:5:6:7']
    for (const address of bad) {
      expect(parseIpv6(address), address).toBeNull()
    }
  })

  it('round-trips compressed IPv6 candidates through a code', () => {
    const addresses = [
      '2001:db8::ff00:42:8329',
      '::1',
      'fe80::1',
      '2001:db8:0:1:1:1:1:1',
      '2001:0:0:1::1',
      '::ffff:192.0.2.1',
    ]
    const c = sdpWith(addresses.map((a, i) => host(a, 40000 + i)))
    expect(decodeCode(encodeCode(c))).toEqual(c)
    // Written out in full in the SDP, they come back canonical.
    const full = parseSdp(
      CHROME_OFFER.replace('2a02:0810:0bc0:0d00:0000:0000:0000:0042', '2001:0DB8:0000:0000:0000:0000:0000:0001'),
      'offer',
    )
    expect(full.candidates[2]!.address).toBe('2001:db8::1')
    expect(decodeCode(encodeCode(full)).candidates[2]!.address).toBe('2001:db8::1')
  })

  it('round-trips mDNS names, storing Chrome UUID names compactly', () => {
    const names = [UUID_NAME, UUID_NAME.toUpperCase().replace('.LOCAL', '.local'), 'my-laptop.local', 'a.b-c.local']
    const c = sdpWith(names.map((n) => host(n)))
    expect(decodeCode(encodeCode(c))).toEqual(c)

    const uuidCode = encodeCode(sdpWith([host(UUID_NAME)]))
    const textCode = encodeCode(sdpWith([host(names[1]!)]))
    expect(uuidCode.length).toBeLessThan(textCode.length - 20)
  })
})

describe('buildSdp', () => {
  it('writes every field of a data-channel-only session with CRLF line endings', () => {
    const c = parseSdp(CHROME_OFFER, 'offer')
    const sdp = buildSdp(c)
    expect(sdp.endsWith('\r\n')).toBe(true)
    expect(sdp.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    const lines = sdp.split('\r\n')
    expect(lines[0]).toBe('v=0')
    expect(lines[1]).toMatch(/^o=- [1-9]\d* 2 IN IP4 127\.0\.0\.1$/)
    for (const line of [
      's=-',
      't=0 0',
      'a=group:BUNDLE 0',
      'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
      'a=ice-ufrag:Xq3v',
      'a=ice-pwd:7s9TfUqL2kPz+R/8wXy4mN1b',
      'a=ice-options:trickle',
      `a=fingerprint:sha-256 ${FINGERPRINT_HEX}`,
      'a=setup:actpass',
      'a=mid:0',
      'a=sctp-port:5000',
      'a=max-message-size:262144',
      'a=end-of-candidates',
    ]) {
      expect(lines, line).toContain(line)
    }
    // Session lines come before the media section, the transport attributes after it.
    const media = lines.indexOf('m=application 9 UDP/DTLS/SCTP webrtc-datachannel')
    expect(lines.indexOf('t=0 0')).toBeLessThan(media)
    expect(lines.indexOf('a=ice-ufrag:Xq3v')).toBeGreaterThan(media)

    const candidates = lines.filter((l) => l.startsWith('a=candidate:'))
    expect(candidates).toHaveLength(c.candidates.length)
    expect(candidates[0]).toBe('a=candidate:1 1 udp 2130706431 192.168.1.23 58443 typ host')
    expect(candidates[2]).toBe('a=candidate:3 1 udp 2130705919 2a02:810:bc0:d00::42 60231 typ host')
    expect(candidates[4]).toBe('a=candidate:5 1 udp 1694497791 203.0.113.7 58443 typ srflx raddr 0.0.0.0 rport 0')
    const priorities = candidates.map((l) => Number(l.split(' ')[3]))
    for (let i = 1; i < 4; i++) expect(priorities[i]).toBeLessThan(priorities[i - 1]!)
    expect(lines.indexOf('a=end-of-candidates')).toBeGreaterThan(lines.indexOf(candidates.at(-1)!))
  })

  it('parses back to the same compact form', () => {
    for (const [sdp, type] of [
      [CHROME_OFFER, 'offer'],
      [FIREFOX_ANSWER, 'answer'],
    ] as const) {
      const c = parseSdp(sdp, type)
      expect(parseSdp(buildSdp(c), type)).toEqual(c)
      expect(parseSdp(buildSdp(decodeCode(encodeCode(c))), type)).toEqual(c)
    }
    const relay = sdpWith([
      { address: '198.51.100.4', port: 3478, typ: 'relay' },
      { address: '::1', port: 9999, typ: 'prflx' },
    ])
    expect(buildSdp(relay)).toContain('typ relay raddr 0.0.0.0 rport 0')
    expect(buildSdp(relay)).toContain('typ prflx raddr 0.0.0.0 rport 0')
    expect(parseSdp(buildSdp(relay), 'offer')).toEqual(relay)
  })

  it('is deterministic', () => {
    const c = parseSdp(CHROME_OFFER, 'offer')
    expect(buildSdp(c)).toBe(buildSdp(decodeCode(encodeCode(c))))
  })
})

describe('offerTag', () => {
  it('is a deterministic 16-bit value of the credentials and fingerprint', () => {
    const offer = parseSdp(CHROME_OFFER, 'offer')
    const tag = offerTag(offer)
    expect(Number.isInteger(tag)).toBe(true)
    expect(tag).toBeGreaterThanOrEqual(0)
    expect(tag).toBeLessThanOrEqual(0xffff)
    // The station computes it from the decoded code, the hub from its own parsed SDP.
    expect(offerTag(decodeCode(encodeCode(offer)))).toBe(tag)
    // Candidates, type and role do not matter.
    expect(offerTag({ ...offer, candidates: [], setup: 'passive', type: 'answer' })).toBe(tag)
  })

  it('tells different offers apart', () => {
    const offer = parseSdp(CHROME_OFFER, 'offer')
    const fp2 = FINGERPRINT.slice()
    fp2[31] = fp2[31]! ^ 1
    expect(offerTag({ ...offer, ufrag: 'Xq3w' })).not.toBe(offerTag(offer))
    expect(offerTag({ ...offer, pwd: '7s9TfUqL2kPz+R/8wXy4mN1c' })).not.toBe(offerTag(offer))
    expect(offerTag({ ...offer, fingerprint: fp2 })).not.toBe(offerTag(offer))
    // Spread over the 16-bit range: 2000 random-looking offers give (almost) no collisions.
    const tags = new Set<number>()
    for (let i = 0; i < 2000; i++) tags.add(offerTag({ ...offer, ufrag: `u${i.toString(36)}x`, pwd: `p${i * 7919}` }))
    expect(tags.size).toBeGreaterThan(1960)
  })
})

describe('encodeCodeWithin', () => {
  /** Host candidates on 192.168.0.x and mDNS text names (the long kind), in browser order. */
  const many: CompactCandidate[] = [
    host('fe80::1', 1),
    host('192.168.0.10', 2),
    host('printer-room-laptop-with-a-long-name.local', 3),
    host('192.168.0.11', 4),
    host('2001:db8::7', 5),
    host('192.168.0.12', 6),
    host('another-very-long-mdns-host-name-here.local', 7),
    host('10.0.0.2', 8),
    host('10.0.0.3', 9),
  ]

  it('keeps at most maxCandidates, in pickCandidates order', () => {
    const c = sdpWith(many)
    const code = encodeCodeWithin(c, CODE_MAX_CANDIDATES, 10_000)
    const back = decodeCode(code)
    expect(back.candidates).toEqual(pickCandidates(many, CODE_MAX_CANDIDATES))
    expect(back.candidates.map((x) => x.port)).toEqual([2, 4, 6, 8, 9, 3])
    // Everything else is carried unchanged.
    expect({ ...back, candidates: [] }).toEqual({ ...c, candidates: [] })
  })

  it('drops the least useful candidates until the code fits maxChars', () => {
    const c = sdpWith(many)
    const full = encodeCodeWithin(c, CODE_MAX_CANDIDATES, 10_000)
    expect(full.length).toBeGreaterThan(160)
    const fitted = encodeCodeWithin(c, CODE_MAX_CANDIDATES, 160)
    expect(fitted.length).toBeLessThanOrEqual(160)
    const kept = decodeCode(fitted).candidates
    expect(kept.length).toBeGreaterThanOrEqual(1)
    expect(kept.length).toBeLessThan(CODE_MAX_CANDIDATES)
    // The best ones stay: a prefix of the full choice.
    expect(kept).toEqual(pickCandidates(many, CODE_MAX_CANDIDATES).slice(0, kept.length))
    // As many as fit: one more would not.
    const oneMore = encodeCode({ ...c, candidates: pickCandidates(many, kept.length + 1) })
    expect(oneMore.length).toBeGreaterThan(160)
  })

  it('keeps one candidate even when the code is still too long, and carries the answer tag', () => {
    const c = sdpWith([host('a-rather-long-name-for-a-single-mdns-host.local'), host('192.168.0.9')], {
      type: 'answer',
      setup: 'active',
      answersTo: 0x0abc,
    })
    const back = decodeCode(encodeCodeWithin(c, CODE_MAX_CANDIDATES, 10))
    expect(back.candidates).toEqual([host('192.168.0.9')])
    expect(back.answersTo).toBe(0x0abc)
    expect(back.type).toBe('answer')
    expect(decodeCode(encodeCodeWithin(sdpWith([]), CODE_MAX_CANDIDATES, CODE_MAX_CHARS)).candidates).toEqual([])
  })

  it('keeps real offers and answers whole within CODE_MAX_CHARS', () => {
    for (const [sdp, type] of [
      [CHROME_OFFER, 'offer'],
      [FIREFOX_ANSWER, 'answer'],
    ] as const) {
      const c = parseSdp(sdp, type)
      const code = encodeCodeWithin({ ...c, ...(type === 'answer' ? { answersTo: 0xffff } : {}) }, CODE_MAX_CANDIDATES, CODE_MAX_CHARS)
      expect(code.length).toBeLessThanOrEqual(CODE_MAX_CHARS)
      expect(decodeCode(code).candidates).toEqual(pickCandidates(c.candidates, CODE_MAX_CANDIDATES))
    }
    // Chrome without microphone permission: only mDNS names (two networks), tagged answer.
    const mdns = sdpWith([host(UUID_NAME, 51234), host('0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0.local', 51235)], {
      type: 'answer',
      setup: 'active',
      answersTo: 0x1234,
    })
    expect(encodeCodeWithin(mdns, CODE_MAX_CANDIDATES, CODE_MAX_CHARS).length).toBeLessThan(160)
  })
})

describe('pickCandidates', () => {
  it('drops duplicates, puts IPv4 first, then mDNS, then IPv6 with link-local last, then non-host', () => {
    const cands: CompactCandidate[] = [
      { address: '203.0.113.7', port: 1, typ: 'srflx' },
      host('fe80::1', 2),
      host('2001:db8::1', 3),
      host(UUID_NAME, 4),
      host('192.168.1.2', 5),
      host('192.168.1.2', 5),
      host('10.0.0.2', 6),
    ]
    expect(pickCandidates(cands, 10).map((c) => c.port)).toEqual([5, 6, 4, 3, 2, 1])
    expect(pickCandidates(cands, 3).map((c) => c.port)).toEqual([5, 6, 4])
    expect(pickCandidates(cands, 0)).toEqual([])
    expect(pickCandidates([], 5)).toEqual([])
  })

  it('puts link-local IPv4 (169.254/16) with the link-local addresses', () => {
    const cands: CompactCandidate[] = [host('169.254.10.20', 1), host('fe80::2', 2), host('2001:db8::5', 3), host('192.168.0.4', 4)]
    expect(pickCandidates(cands, 10).map((c) => c.port)).toEqual([4, 3, 1, 2])
  })
})
