import { describe, expect, it } from 'vitest'
import { decodeCode, encodeCode, type CompactSdp } from '../net/sdpCode.ts'
import { isPairingCode } from './stationsPanel.ts'

// Which scanned QR codes the Stations panel and the station screen hand on as pairing codes.
// (The components themselves need a DOM, which the node test environment does not have.)
describe('isPairingCode', () => {
  const sdp: CompactSdp = {
    type: 'answer',
    ufrag: 'Xq3v',
    pwd: '7s9TfUqL2kPz+R/8wXy4mN1b',
    fingerprint: Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff),
    setup: 'active',
    candidates: [{ address: '192.168.1.20', port: 50123, typ: 'host' }],
    answersTo: 4242,
  }
  const code = encodeCode(sdp)

  it('accepts a real pairing code, also with text or white space around it', () => {
    expect(code.startsWith('SW1.')).toBe(true)
    expect(isPairingCode(code)).toBe(true)
    expect(isPairingCode(`  ${code}\n`)).toBe(true)
    expect(isPairingCode(`My code: ${code} (Soundwave)`)).toBe(true)
    // What is handed on (trimmed) still decodes: the decoder finds the code in the text.
    expect(decodeCode(`My code: ${code} (Soundwave)`.trim()).answersTo).toBe(4242)
  })

  it('hands on codes of other versions, so the decoder can say what is wrong', () => {
    expect(isPairingCode(code.replace('SW1.', 'SW2.'))).toBe(true)
    expect(isPairingCode(code.replace('SW1.', 'sw1.'))).toBe(true)
  })

  it('rejects other QR codes', () => {
    expect(isPairingCode('')).toBe(false)
    expect(isPairingCode('SW1.')).toBe(false)
    expect(isPairingCode('SW1.abc')).toBe(false)
    expect(isPairingCode('https://example.com/sw1.html')).toBe(false)
    expect(isPairingCode('WIFI:S:Home;T:WPA;P:secret;;')).toBe(false)
    expect(isPairingCode(code.slice(4))).toBe(false)
  })
})
