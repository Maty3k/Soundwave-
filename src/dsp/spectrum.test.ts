import { describe, expect, it } from 'vitest'
import { binHz } from './spectrum.ts'

describe('binHz', () => {
  it('is sampleRate / fftSize', () => {
    expect(binHz(48000, 4096)).toBe(11.71875)
    expect(binHz(44100, 4096)).toBeCloseTo(10.7666, 4)
  })
})
