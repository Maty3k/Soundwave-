/** Width of one FFT bin in Hz. */
export function binHz(sampleRate: number, fftSize: number): number {
  return sampleRate / fftSize
}
