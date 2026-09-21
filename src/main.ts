import './style.css'

// Temporary shell: replaced by the real app once the audio engine and UI land.
const app = document.querySelector<HTMLElement>('#app')!

const checks: Array<[string, boolean]> = [
  ['Secure context (https or localhost)', window.isSecureContext],
  ['Microphone API (getUserMedia)', typeof navigator.mediaDevices?.getUserMedia === 'function'],
  ['Web Audio (AudioContext)', typeof window.AudioContext === 'function'],
  ['Screen Wake Lock', 'wakeLock' in navigator],
  ['Vibration', 'vibrate' in navigator],
]

app.innerHTML = `
  <section class="shell">
    <h1>Soundwave</h1>
    <p class="tagline">Follow the beep.</p>
    <ul class="checks">
      ${checks.map(([label, ok]) => `<li class="${ok ? 'ok' : 'no'}"><span>${ok ? '✓' : '✗'}</span> ${label}</li>`).join('')}
    </ul>
  </section>
`
