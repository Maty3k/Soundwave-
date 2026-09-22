# Soundwave

**Follow the beep.**

Soundwave helps you find where a mystery beep is coming from: a smoke detector's low-battery chirp, a UPS, a fridge alarm, a forgotten gadget. Pure beeps are nearly impossible to locate by ear, and a single microphone cannot hear direction, so Soundwave plays hot/cold: it locks onto the beep's exact frequency, then tells you whether each chirp is louder or quieter than the last one while you walk around. On phones, a direction scan adds a radar that uses your body as a shield to show the loudest side.

Everything runs in your browser, and after the first visit it also works offline: the app keeps its own files on the device, so an installed Soundwave opens without a connection. Audio is analysed live and never recorded, stored or uploaded. After the page has loaded it talks to no server; the only network traffic is between your own devices when you pair listening stations (see below), and even then only loudness numbers are exchanged, never audio.

## How to use it

1. Tap **Start listening** and allow the microphone.
2. Wait for the beep. Soundwave listens until it has heard the same chirp twice, so it does not lock onto a random sound; a continuous beep locks after about 2 seconds. If you are sure after the first chirp, tap **Use it now**. It then shows the frequency it locked onto, for example 3,120 Hz. Tap **Wrong sound? Listen again** if that was not it.
3. The bar under the verdict tells you what to do: **Move now** between chirps, **Hold still…** just before the next one. Each chirp gives a verdict, **WARMER**, **COLDER** or **SAME**, with the change in dB and a meter relative to your best reading so far.
4. Geiger-style clicks, plus vibration on Android phones, speed up as you get closer, so you can watch where you walk instead of the screen. They stop when it is time to hold still.
5. When you have found it, tap **Found it**. You get a summary (frequency, how long it took, how many chirps, your notes and, with stations, which one heard it loudest) and a tip for smoke alarms. **Keep hunting** takes you back if it was not the right thing after all. After two minutes on this screen the microphone turns off; Keep hunting turns it back on. Each hunt you find is saved under **Past hunts** on the start screen, on this device only: give it a name on the Found it screen ("Hallway smoke alarm") and next time you can see its frequency, when you found it and your notes.

Continuous tones and rapid beep trains switch to a live meter automatically. Room acoustics make small moves unreliable at these frequencies, so trust trends over several chirps and move a few metres at a time. **VERY HOT** means the microphone is overloaded: you are probably within arm's reach. Smoke detectors live on ceilings.

The hunting screen has tabs: **Meter**, **Direction** (phones with a compass), **Log** and **Stations**.

### Log

Every chirp adds a line to the **Log** tab: time, verdict, level change and frequency, plus a note field where you can type where you stood ("hallway by the door"). **Copy log** puts the whole log on the clipboard as text.

### Direction scan (phones with a compass)

A single microphone cannot hear direction, so Soundwave uses your body as a shield instead. Open the **Direction** tab, hold the phone flat in front of your chest with the top pointing away from you, and stay on the spot:

- **Chirps:** after each chirp, turn a quarter turn. After three or four chirps the radar shows an arrow toward the loudest side.
- **Continuous tones:** turn slowly, one full turn in about 20 seconds.

The radar is drawn from the phone's point of view: up is where the phone points, so the arrow keeps pointing the right way as you turn. Your body makes sound from behind a few dB quieter. Close to the source the difference is large and the arrow points at it. From another room it usually points at the doorway the sound comes through, which is still the way to go. "No clear direction" means the sound reaches you equally from everywhere: move toward the warmest room and scan again. Laptops have no compass, so the tab only appears on touch devices.

### Stations and extra microphones

To pinpoint the beep faster, let several listeners compare every chirp:

- **Stations.** On another phone or laptop, open the same page and choose **Use this device as a station**, give it a name such as "Kitchen", and leave it in another room. On your main phone, open **Stations**, tap **Add a phone** and let the station scan the QR code (or copy, share and paste the code). The station then shows a reply code for the main phone to scan or paste. Both devices must be on the same Wi-Fi. They connect directly to each other (WebRTC, no server, no account) and exchange only loudness numbers.
- **Extra microphones.** A laptop with several microphones (for example USB microphones on long cables) can add them under **Add a microphone**. iPhones and Safari record from one microphone at a time, and Android phones usually refuse a second one, so this is mainly for laptops.

On every chirp the Stations tab shows which listener heard it loudest, for example "Loudest: Kitchen, 12 dB louder than this phone". Different devices have different microphones: put them side by side and tap **Calibrate** once before spreading them out.

## Browser support

| Browser | Status |
|---|---|
| Chrome on Android | Primary target, including vibration |
| Chrome, Edge, Firefox on desktop | Supported |
| Safari on macOS | Supported, but Safari cannot switch off automatic gain control or noise suppression, so readings are less precise. The app shows a notice. Not tested yet. |
| Safari on iPhone | Best effort: no vibration, listening pauses when you switch apps, and the direction scan asks for motion access |

The microphone only works in a secure context: `https://…` or a `localhost` address.

### Why the audio processing is switched off

Soundwave asks the browser for the microphone with `echoCancellation`, `noiseSuppression` and `autoGainControl` all set to `false`. With automatic gain control on, the browser would turn quiet chirps up and loud chirps down, which destroys exactly the loudness difference the hot/cold meter depends on. The app checks what the browser actually applied and warns when it could not switch processing off.

## Development

Requires Node 24 or newer. On this project's Windows machine Node comes from Laravel Herd's bundled nvm.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload at `http://localhost:5173/` |
| `npm run build` | Typecheck and production build into `dist/` |
| `npm run build:watch` | Rebuild `dist/` on every change (keeps the Herd site current) |
| `npm test` | Unit tests (Vitest, Node environment) |
| `npm run typecheck` | TypeScript only |
| `npm run chirps` | Write test-signal WAVs into `public/dev/` |

### Laravel Herd

Herd serves the production build in `dist/` through two links:

- `http://soundwave.localhost`: browsers treat `*.localhost` as a secure context, so the microphone works without any certificate.
- `http://soundwave.test`: the microphone is blocked on plain HTTP. Run `herd secure soundwave` once to get `https://soundwave.test`; it asks Windows for admin approval to trust Herd's local certificate authority.

The links are directory junctions in `%USERPROFILE%\.config\herd\config\valet\Sites` pointing at `dist/`, because `herd link` needs admin rights for symbolic links on this machine. Rebuild with `npm run build` to update what Herd serves.

### Test signals

`npm run chirps` writes these files into `public/dev/`. Play one from another device, or open it from the dev server at `/dev/<name>.wav`.

| File | Signal |
|---|---|
| `chirp-10s.wav` | 3.1 kHz, 150 ms chirp every 10 s at a constant level |
| `walk-10s.wav` | Same, with levels that simulate walking: warmer, warmer, colder, … |
| `ups-30s.wav` | UPS style: 4 beeps 1 s apart, every 30 s, at 2.4 kHz |
| `tone-2k.wav` | Continuous 2 kHz tone for 20 s (live mode) |

For custom signals, see the options documented at the top of `tools/make-chirp-wav.mjs`.

### Testing on an Android phone

Phones cannot resolve Herd's local names, and the corporate firewall blocks LAN access, so use USB:

1. Enable USB debugging on the phone and plug it in.
2. In desktop Chrome open `chrome://inspect/#devices`, enable port forwarding and map port `5173` to `localhost:5173`.
3. Run `npm run dev` and open `http://localhost:5173/` on the phone. This counts as a secure context.

### Debug flags

- `?debug` shows a diagnostics panel: microphone settings, sample rates, locked frequency, live level, noise floor, SNR and the last chirps.
- `?warmth=1` forces the maximum click rate while hunting. It is used to check that the app's own clicks do not register as chirps.
- `?nosw` unregisters the offline service worker (useful when debugging caching).

### Known limits

- Chirps shorter than about 40 ms are spectrally wide and may need several chirps to lock; 20 ms chirps do not lock (recorded as a known failing test).
- The meter is relative to your best reading so far, so a high percentage means "loudest yet", not "close".
- Scanning a pairing QR code needs a camera. Chrome on Android, macOS and ChromeOS use their built-in QR detector; other browsers load a small bundled decoder (qr by Paul Miller) the first time they scan. Without a camera, use Copy code or Share and paste the code on the other device.
- Station pairing has been tested between Chrome and Edge instances. Firefox and Safari as stations are untested.

### Tuning

Every threshold lives in `src/config.ts` and every user-facing string in `src/copy.ts`. The signal-processing thresholds were calibrated against two hours of synthetic noise through a reference copy of the browser's analyser (`src/dsp/synth.ts`). Field tuning with a real detector should change only those two files; the unit tests import their thresholds from the config.

## Project layout

```
src/
  main.ts          wiring: Start gesture, audio context, frames, render loop
  config.ts        every tunable constant
  types.ts         shared types
  app.ts           pure state machine and store
  copy.ts          all user-facing text
  ui.ts, style.css DOM rendering and styles
  platform.ts      capabilities, wake lock, haptics, settings storage
  history.ts       past hunts, saved on this device (localStorage)
  hub.ts           stations and extra microphones on the main device (pairing, comparison)
  stationMode.ts   this device as a listening station
  extraMics.ts     extra microphones on the same device
  net/             pairing codes, QR codes, messages and clock sync between devices
  ui/              log panel, stations panel, station screen, past hunts
  orientation.ts   compass heading for the direction scan
  radarUi.ts       direction-scan radar panel
  audio/           microphone, analyser loop, Geiger clicker (browser code)
  dsp/             pure signal processing: spectrum, detection, hunting, click maths, radar, listener comparison, test harness
tools/make-chirp-wav.mjs   test-signal generator
docs/PLAN.md               design plan and decisions
```

## Offline mode

`public/sw.js` is a small hand-written service worker. At build time `tools/sw-precache-plugin.mjs` writes the list of built files and a content hash into it, so every deploy gets a new cache and the old one is removed. The page itself is fetched from the network first (falling back to the cached copy offline), the hashed assets come from the cache. The worker is registered only in production builds, and the test signals under `dev/` are never cached.

## Deployment

`.github/workflows/deploy-pages.yml` builds, tests and publishes to GitHub Pages on every push to `main`. Before the first push, set the repository's Settings → Pages → Source to "GitHub Actions". The build uses a relative base path, so the same `dist/` works on Herd and under `/Soundwave-/` on Pages.
