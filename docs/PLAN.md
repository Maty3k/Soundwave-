# Soundwave — implementation plan v0.1

Tagline: "Follow the beep."

Status: proposed 2026-09-21; build started the same day with local hosting on Laravel Herd (see the amendment below). Produced from four research agents, three independent plan drafts, a three-judge panel and a three-critic adversarial review.

## Amendment 2026-09-21: Laravel Herd

The owner asked to run Soundwave on their Laravel Herd. Herd (1.30, installed the same day) changes these parts of the plan. Where the body below disagrees, this amendment wins.

- **Node comes from Herd.** Herd's bundled nvm installed Node 26.9.0 with npm 11.19. No separate Node install is needed, and step 1 reduces to setting `NODE_USE_SYSTEM_CA=1` for GitHub-bound Node tools. `.node-version` is `26` so CI matches local; `engines` is `>=24`. Node 26 becomes LTS on 2026-10-28.
- **Relative base path.** `vite.config.ts` uses `base: './'` instead of `'/Soundwave-/'`. The same build then works at the root of a Herd site and under `/Soundwave-/` on GitHub Pages. The app is a single page with no routes, so relative URLs are safe.
- **Herd serves the production build (`dist/`).** Two Herd links point at `dist/` through directory junctions in `%USERPROFILE%\.config\herd\configalet\Sites`. Junctions are used because `herd link` creates a symbolic link, which needs admin rights on this machine.
  - `http://soundwave.localhost`: browsers treat `*.localhost` as a secure context, so the microphone works with no certificate. This is the Herd URL to use today.
  - `http://soundwave.test`: served, but plain HTTP is not a secure context, so the microphone API is missing. It becomes `https://soundwave.test` after `herd secure soundwave`, which needs one admin (UAC) approval to trust Herd's local certificate authority, or a per-user import of that CA with one confirmation click.
  - Rebuild to update the Herd site: `npm run build`, or keep `npm run build:watch` running while working.
- **Dev server unchanged.** `npm run dev` serves `http://localhost:5173/` with hot reload. It is also the target for the USB phone loop, since phones cannot resolve Herd's local names.
- **GitHub Pages stays in the repo but is not pushed** until the owner confirms they still want a public deployment next to Herd.


## 0. What you will experience

1. Tap Start. The browser asks for the microphone once.
2. Wait for one chirp. Soundwave shows the frequency it locked onto (for example 3,120 Hz) and takes that chirp as the first reading.
3. Stand still until the next chirp, read WARMER / COLDER / ABOUT THE SAME plus a 0–100 meter and the raw dB change, then move 2–3 m and wait again. A countdown says when the next chirp is due and tells you to hold still for the last 5 s.
4. Geiger clicks (and vibration on Android) speed up as readings get louder, so you can watch where you walk instead of the screen.
5. Continuous tones or rapid beep trains switch the app to a live meter automatically.

## 1. How it works

One Start tap creates and resumes a single AudioContext, requests a Screen Wake Lock, then opens the mic with echoCancellation / noiseSuppression / autoGainControl all `false` (bare booleans, never `exact`) and verifies what the browser applied via `track.getSettings()`. A 4096-point AnalyserNode with `smoothingTimeConstant 0` is polled every 20 ms from a self-correcting timer. Each frame (dB spectrum, bin width, clip fraction, timing) goes through pure TypeScript reducers: `detectStep` finds and locks a narrowband peak while listening; `huntStep` segments chirps, peak-holds each one, compares last vs previous vs best, estimates the chirp interval and drives the meter. A Geiger clicker on the same AudioContext plays Poisson-timed clicks whose rate follows the held level; Android phones also get vibration tiers.

Key bets:
- **Purely relative meter.** Verdict is this chirp vs the previous one; the 0–100 meter is relative to the best chirp so far. Android keeps a hardware gain stage even with AGC off, and Safari cannot disable AGC/NS at all, so absolute dB would mislead.
- **All temporal logic in pure TS.** The AnalyserNode only supplies spectra; persistence, segmentation, interval and click rate are testable functions.
- **Clicks kept out of the measurement.** The click carrier is chosen per locked frequency so its harmonics stay at least 2/clickLength Hz away (400 Hz for a 5 ms click), rate is capped at 12/s, clicks pause before the expected chirp, and frames overlapping a click are flagged. Self-noise is measured explicitly before shipping.
- **Zero network after load.** No fonts, CDNs, analytics or error reporting. Audio is never recorded, buffered or stored; only the locked Hz, best dB and toggle settings ever touch storage.
- **Few files, one state machine, two toggles.** No settings sheet, no service worker in v0.1.

## 2. Stack and toolchain

| Piece | Choice | Verified 2026-09-21 |
|---|---|---|
| Runtime | Node 26.9 from Laravel Herd's bundled nvm; `.node-version` 26, `engines` >=24 | Node 26 becomes LTS on 2026-10-28 |
| Build | Vite `^8.3`, `base: './'` (works on Herd and Pages), no plugins | 8.3.0 is latest |
| Language | TypeScript `~6.0.2`, strict, `erasableSyntaxOnly` | npm `latest` is 7.0.2, unsupported by PhpStorm's TS service |
| Tests | Vitest `^5.0.1`, node environment, `src/**/*.test.ts` | 5.0.1 published 2026-09-15; `^4.1` is the fallback |
| Styling | one `style.css`, custom properties, dark-first | |
| Lint/format | none in v0.1 (strict tsc + PhpStorm) | |
| PWA | hand-written manifest + icons, no service worker | |
| Deploy | one workflow: typecheck → test → build → `upload-pages-artifact@v5` → `deploy-pages@v5` on push to main | checkout v7.0.1, setup-node v7.0.0 |
| Phone loop | USB: `chrome://inspect/#devices` port forwarding 5173 → `localhost:5173`; phone opens `http://localhost:5173/` (secure context) | Chrome 153 installed, DevTools not policy-locked |

Machine facts that shape the steps: account is not a local administrator; TLS to github.com and nodejs.org is intercepted by a Fortinet DPI proxy (registry.npmjs.org is not); Firefox is not installed (Chrome and Edge are); every Claude tool call is a fresh `powershell.exe` that inherits PhpStorm's environment, so PATH and env-var changes need an explicit refresh prefix until PhpStorm is restarted; the Vite scaffolder cannot answer its "directory not empty" prompt from a non-interactive shell, so the six scaffold files are hand-written instead.

## 3. File structure

```
Soundwave-/
├── .github/workflows/
│   └── deploy-pages.yml        # push main: npm ci → typecheck → test → build → upload-pages-artifact → deploy-pages
├── public/
│   ├── favicon.svg             # sonar arcs + one orange dot; source for all icons
│   ├── manifest.webmanifest    # (last step) start_url "./", scope "./", standalone, #0B0F19
│   ├── icons/                  # (last step) 192, 512, 512-maskable PNG
│   └── dev/                    # git-ignored: generated chirp WAVs served by the dev server for manual tests
├── tools/
│   └── make-chirp-wav.mjs      # Node script: WAV with a 3.1 kHz 150 ms chirp every N s
├── src/
│   ├── main.ts                 # wiring only: Start tap → ctx → mic → engine → reducers → store → ui/clicker/haptics
│   ├── config.ts               # EVERY tunable constant; the only file touched during field tuning
│   ├── types.ts                # Frame, Peak, Lock, Chirp, HuntState, Reading, AppState, AppEvent, ErrorCode
│   ├── app.ts (+ .test.ts)     # pure reducer reduce(state, event) + 20-line store
│   ├── copy.ts                 # every user-facing string, error map, formatHz, formatClock
│   ├── ui.ts                   # idempotent render(state, settings); meter via CSS vars; aria-live verdict
│   ├── style.css               # tokens (dark-first, heat ramp), 100dvh column, safe-area, reduced-motion
│   ├── platform.ts             # capabilities, wake lock, haptics scheduler, visibility, storage try/catch
│   ├── audio/
│   │   ├── mic.ts              # getUserMedia + getSettings tri-state check + DOMException → ErrorCode
│   │   ├── engine.ts           # MediaStreamSource → AnalyserNode(4096, τ 0); 20 ms loop → Frame; track/ctx events
│   │   └── clicker.ts          # Geiger click synth + lookahead Poisson scheduler on the same AudioContext
│   └── dsp/                    # pure TS, zero DOM / Web Audio imports (checked with a search in review)
│       ├── spectrum.ts (+test) # binHz, sanitizeDb, localFloorDb, bandFloorDb, parabolicPeak, peakWidthBins, bandLevelDb, clipFraction
│       ├── detect.ts   (+test) # findPeaks, candidate tracker, lock policy (fast / slow / sustained), peak ring buffer
│       ├── hunt.ts     (+test) # segmenter, peak-hold, verdict, range, interval + countdown, live max-hold, mode classifier
│       ├── geiger.ts   (+test) # clickRateHz, nextClickDelayS, chooseClickFreq, vibrationTier
│       └── synth.ts            # TEST-ONLY: seeded RNG, exact Blackman kernel, log-Rayleigh floor, smeared chirp frames, reference FFT
├── index.html                  # viewport-fit=cover, theme-color, <main id="app">
├── vite.config.ts              # base './' (Herd root and Pages subpath)
├── vitest.config.ts            # environment node, include src/**/*.test.ts
├── tsconfig.json               # strict, include ["src"]
├── package.json                # scripts: dev, build (tsc && vite build), preview, typecheck, test, test:watch
├── .node-version  .editorconfig  .gitattributes  .gitignore  README.md   (LICENSE only if you choose one)
```

## 4. Architecture

Data flow, all inside one AudioContext created synchronously in the Start `click` handler (`pointerup` from a mouse is not an activation-triggering event):

```
Start tap → ctx = new AudioContext(); ctx.resume()   // never pass sampleRate
         → wakeLock.request()                           // re-requested on visibilitychange→visible; a release while hidden is expected, no toast
         → await mic.acquire()                          // EC/NS/AGC=false; getSettings → rawAudio 'on' | 'partial' | 'unknown'
         → engine.start(ctx, stream)                    // Source → Analyser (not connected to destination)
         → clicker.start(ctx)                           // click graph → master gain → destination
engine loop (20 ms hop, deadline-corrected setTimeout, stamped with ctx.currentTime):
   Frame { tMs, db: Float32Array (sanitised, -Inf → -160), binHz: ctx.sampleRate/4096, clipFrac, dt, gap, clickTainted }
main.onFrame:
   listening        → detectStep(det, frame, cfg) → on lock: dispatch {lock, firstChirp}
   locked | hunting → huntStep(hunt, frame, cfg)  → dispatch {hunt, event?}   // runs during the Locked banner too, so no chirp is lost
store.subscribe → ui.render (rAF-flushed), clicker.setRate / pause(holdWindow), haptics.set(tier, event)
track 'ended' / 'mute' and ctx 'statechange' ('suspended' and 'interrupted' alike) → Paused overlay with tap-to-resume
```

State machine (`src/app.ts`, pure, tested):

```
idle → requesting → listening → locked (2 s banner, "Not it") → hunting{mode: chirp | live}
any active state → paused{prev, needsGesture} → prev
requesting → error{permission | noMic | busy | unsupported} → retry | back
hunting → relisten → listening (mic kept)   ·   hunting → resetBest   ·   any → stop → idle
```

`Reading { verdict, deltaPrevDb, deltaBestDb, pct, isNewBest }` is the single UI-facing type produced by `hunt.ts`.

## 5. Behaviour (plain language; every number lives in `config.ts`, full table in Appendix A)

- **Detects beeps between 1.5 and 6 kHz.** Covers smoke/CO detectors, UPS and fridge buzzers, watch alarms. Lower or higher gadgets need one constant widened later.
- **Locks on the first clear chirp.** One narrowband sighting with strong signal (SNR ≥ 20 dB) locks immediately; two weaker sightings (≥ 12 dB) at least 2 s apart, or a tone held for 1 s, also lock. A candidate must persist for 3 consecutive frames spanning ≥ 40 ms with a stable frequency (speech glides, piezos do not). The 2 s Locked banner with "Not it" is the safety net.
- **Measures only the locked frequency.** Level = power in the 3 FFT bins nearest the locked Hz; the noise reference is the local median floor corrected for a 3-bin sum (+6.4 dB), so onset/offset thresholds mean the same thing on every device.
- **Each chirp becomes one reading.** Peak level over the chirp is held. Verdict is WARMER / COLDER / ABOUT THE SAME vs the previous chirp with a 3 dB dead-band; the raw ±dB is always printed. The 0–100 meter is relative to the best chirp so far (best never decays; a clipped chirp reads VERY HOT but never updates best). The first chirp shows FIRST READING with no percent; clicks stay silent until two readings exist.
- **Countdown to the next chirp.** Median of the recent gaps; a gap of about 2× or 3× the median counts as missed chirps rather than a new interval. HOLD STILL for the last 5 s; clicks and haptics pause from then until the chirp ends or the window expires (T + max(2·MAD, 2 s) + 2 s), then overdue (> 1.5×) and lost (> 3×) messages follow.
- **Live mode for continuous or rapid beeps.** Switches when a tone, or onsets less than 1.5 s apart, cover more than 5 s without a 3 s silence; switches back after 3 s of silence, closing the train as one reading. A 4-beep UPS burst every 30 s therefore stays in chirp mode as one reading per burst. Live meter = 2 s max-hold, verdict vs 3 s earlier, once per second. Mode changes are announced with a toast.
- **Geiger clicks 1–12 per second.** Rate follows the held level exponentially; intervals are random (Poisson) with a 50 ms floor built into the draw so the mean rate is exact. Click = 4–6 ms Hann-windowed sine at −18 dBFS on a carrier whose harmonics 1–6 all clear the locked Hz by ≥ 2/clickLength (400 Hz at 5 ms), picked from [900, 700, 1100, 500, 1300, 6000] Hz. Mute toggle.
- **Vibration where supported.** Shown when `'vibrate' in navigator && navigator.maxTouchPoints > 0` (in practice Chrome on Android; desktop Chrome exposes a no-op). Tiers of ≥ 30 ms pulses whose density follows the level, plus one short pulse when a chirp is registered. Nothing vibrates before the Start tap.
- **Self-noise is measured, not assumed.** A 60 s test at forced maximum click rate with a live lock must produce zero chirp events and < 1 dB band rise. Fallback ladder, in order: click gain −24 dBFS → onset threshold +2 dB → blank click-tainted frames with the rate capped at 6/s. Only timer stalls (dt > 150 ms) abort a chirp, never blanked frames.
- **Honest about what it cannot do.** Web pages cannot listen with the screen off; wake lock plus an explicit Paused screen cover it. Room acoustics at 3 kHz make sub-metre moves noisy; copy insists on 2–3 m moves and trends over single readings.

## 6. MVP scope

IN:
- Landing with tagline, 3-step explanation, privacy line, one Start button
- Raw-audio capture with a verification badge (amber "processing still on" when a browser keeps AGC/NS, info "couldn't verify")
- Automatic lock in 1.5–6 kHz with the fast / slow / sustained policy; 2 s Locked banner with frequency and "Not it"
- Chirp hunting: verdict hero (aria-live), 0–100 meter with previous-chirp ghost and best tick, countdown with hold / overdue / lost, last-6 history line, one context-sensitive guidance line
- Automatic live mode (and back) for continuous tones and rapid beep trains, with toast
- Geiger clicks (mute toggle) and haptics where supported (toggle hidden otherwise); toggles persisted in localStorage
- Screen Wake Lock, Paused overlay with tap-to-resume, mic-lost recovery keeping lock and best
- Clipping → VERY HOT / MAX ("look up, detectors live on ceilings")
- Error screens: permission denied, no mic, mic busy, unsupported or insecure context (generic recovery copy, no UA sniffing)
- `?debug` diagnostics readout (device label, track and context sample rates, EC/NS/AGC, binHz, floor, clip %, last 5 chirps, click-taint share)
- Browser targets: Chrome Android, desktop Chrome, desktop Firefox (see the question about installing it), desktop Safari via the same feature-detected path (not verifiable from this machine), iOS Safari best-effort
- Tests: Vitest, node environment, no browser. Unit tests for every pure DSP function, one whole-pipeline synthetic chirp-train test (pure TS), and, as a small addition to your decision, table-driven tests for the pure `app.ts` state machine. `tools/make-chirp-wav.mjs` for manual tests
- Deploy to GitHub Pages on push to main with typecheck + test + build as the gate
- Responsive single column: 360×640 and 390×844 portrait, 844×390 landscape, 1366×768 laptop; 48 px targets, 64 px primary buttons; prefers-reduced-motion; keyboard Start → Stop
- PWA installability: manifest + icons + apple-touch-icon (last step)
- README: privacy statement, browser matrix, why the constraints are off, Windows/corporate setup, USB loop, deploy, field notes

OUT (deferred until field evidence asks for it):
- Manual frequency picker, typed Hz, candidate sheet. The peak ring buffer is built now; a minimal "I hear it now" button is the contingency if the field test shows no-lock failures
- Settings sheet, click volume slider, manual mode chip
- Distinct haptic patterns per verdict (tiers plus one chirp pulse satisfy "vibration that gets faster")
- sessionStorage "Resume hunt?" card (motivated by iOS reloads; iOS is best-effort)
- Rotating tips; the 90 s "no beep yet" panel is one static line
- Service worker / offline cache
- Per-browser permission hints via UA sniffing
- AGC-pumping detector, SNR-based fallback metric, Bluetooth-headset warning, AudioWorklet / Goertzel path
- Harmonic confirmation (piezos often suppress harmonics 20–40 dB)
- Automatic re-lock after missed chirps (Re-listen is one tap)
- "Found it" end screen, sparkline, light theme, install pill
- ESLint / Prettier, coverage reports, Dependabot, a separate PR-only CI workflow (every step commits to main, so it would never run)

## 7. Steps

Each step ends with a commit on main; pushes happen whenever a step needs the live URL. Commands run from this session via the tool unless marked *you*. Until PhpStorm is restarted, every node/npm/adb call I issue is prefixed with a PATH and env refresh (Appendix B).

1. **Machine prep (Node).** Preferred, because you are not a local administrator: per-user install. Download `node-v24.21.0-win-x64.zip` from nodejs.org with `Invoke-WebRequest` (trusts the Windows certificate store, so the Fortinet-intercepted path works; verified with a HEAD request), check SHA-256 against `SHASUMS256.txt`, extract to `%LOCALAPPDATA%\Programs\nodejs`, add it to the User PATH. Alternative if you have admin credentials: `winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements` (UAC prompt; gives 24.19.0). Then `[Environment]::SetEnvironmentVariable('NODE_USE_SYSTEM_CA','1','User')` so Node trusts the corporate certificate (supported since Node 24.6). Repo-local identity: `git config user.name "Darius"` and `git config user.email "darius@artisan.build"` (no `--global`). *You*: when convenient, restart PhpStorm and resume with `claude --continue` so new shells inherit the PATH. Verify: `node -v` prints v24.x, `npm -v` prints 11.x, `npm view vite version` prints 8.x, and `node -e "fetch('https://api.github.com').then(r=>console.log(r.status))"` prints 200.
2. **Scaffold + hygiene + shell (hand-written).** `package.json` (type module, scripts, `engines.node ^24`), `npm install -D vite@^8.3 typescript@~6.0.2 vitest@^5.0.1` from a clean tree so the lockfile records the Linux optional bindings CI needs, strict `tsconfig.json`, `vite.config.ts` with `base: '/Soundwave-/'`, `vitest.config.ts`, `index.html`, `.node-version` = 24, `.editorconfig`, `.gitattributes` (`* text=auto eol=lf`), `.gitignore` (Node/Vite template + `.idea/`, `public/dev/`, `.vitest/`, `coverage/`), `config.ts` and `types.ts` skeletons, a static dark landing with the tagline and a capability list (isSecureContext, getUserMedia, AudioContext, wakeLock, vibrate), one smoke test (`binHz(48000, 4096)` = 11.71875). Verify: `npm run dev` serves `/Soundwave-/`; `npm run typecheck`, `npm test`, `npm run build` exit 0; `dist/index.html` references `/Soundwave-/assets/`.
3. **Pages deploy of the shell.** `deploy-pages.yml` (checkout@v7, setup-node@v7 with `.node-version` and npm cache, `npm ci`, typecheck, test, build, upload-pages-artifact@v5, deploy-pages@v5; `pages: write` + `id-token: write`, environment `github-pages`, concurrency `pages`). *You*: Settings → Pages → Source = "GitHub Actions" (30 s click; the workflow token cannot do it, and I do not want a PAT pasted into chat). Precondition check before pushing: `(Invoke-RestMethod 'https://api.github.com/repos/Maty3k/Soundwave-' -Headers @{'User-Agent'='soundwave'}).has_pages` is `True`. Push main. Recovery if the deploy job 404s with "Ensure GitHub Pages has been enabled": flip the source, then re-run the failed workflow. If `npm ci` fails on ubuntu with a missing `@rolldown/binding-linux-*`: delete `node_modules` and `package-lock.json`, `npm install`, commit. Verify: workflow green; `https://maty3k.github.io/Soundwave-/` loads on the phone over mobile data with the lock icon and the capability list.
4. **USB phone loop.** *You*: enable USB debugging on the Android phone, plug in, accept the RSA prompt. Then `chrome://inspect/#devices` → Port forwarding 5173 → `localhost:5173` (alternative: per-user `winget install Google.PlatformTools` + `adb reverse tcp:5173 tcp:5173`). Verify: `Get-PnpDevice | Where-Object { $_.FriendlyName -match 'ADB|Android' }` shows Status OK; the phone appears in chrome://inspect; `http://localhost:5173/Soundwave-/` loads on the phone with `isSecureContext` true and remote DevTools attached. Fallback if MDM blocks it: every phone check becomes a push to main plus a 1–2 min deploy; `?debug` and `?warmth=1` work in the production build.
5. **Audio engine + debug readout.** `mic.ts` (constraints as bare booleans, `getSettings` tri-state; one `applyConstraints` retry only because Firefox honours it, Chromium validates without changing the source), `engine.ts`, `platform.capabilities`, Start flow in `main.ts`, `?debug` readout (sample rates, EC/NS/AGC, loudest in-band peak Hz/dB/floor via `spectrum.ts` primitives, clip %). Verify on desktop Chrome, Edge and Firefox if installed, and on Android over USB: all three settings read `false`, a 3.1 kHz tone shows ~3,100 Hz with ≥ 30 dB SNR, finger snaps show as broadband/low SNR, covering the mic drops the floor.
6. **Synthetic harness + DSP primitives with tests.** `synth.ts` (seeded RNG, exact Blackman kernel, log-Rayleigh floor, window-smeared frame sequences, small reference FFT), `spectrum.ts` with property tests: parabolic interpolation ≤ 0.05 bin; 3-bin band level < 0.5 dB scalloping; on pure noise the median band SNR lies in [−1, +1] dB and no 2-frame onset occurs in 10⁴ frames; width test passes ≥ 95 % of true tones at 12–14 dB SNR; false-positive bound derived from the actual threshold with ≥ 10× margin. `tools/make-chirp-wav.mjs` writing into `public/dev/`. Verify: `npm test` green; the WAV plays from the laptop (Media Player) and from the phone via the dev-server URL.
7. **Detection, hunting and geiger reducers with tests.** `detect.ts` (tracker, fast / slow / sustained lock, ring buffer; a "sighting" = a track that passed persistence, width and stability), `hunt.ts` (segmenter with gap abort, peak-hold, verdict, range rules, interval with missed-chirp reconciliation for 2× and 3×, countdown phases and shared hold window, live max-hold, two-way mode classifier), `geiger.ts` (rate map, shifted-exponential sampler, `chooseClickFreq` with `minClearHz = 2/clickSec`, tiers). Whole-pipeline synthetic test: chirp train with ±5 dB steps → lock, chirp count, verdict sequence, isNewBest, confident interval. Mode tests: 4 beeps/30 s and 2 beeps/45 s stay chirp; 2 beeps/s for 6 s → live; live + 4 s silence → chirp with one grouped reading. Reference-FFT test: one 5 ms click at the chosen carrier raises the band at f0 by < 1 dB. All thresholds in tests come from `config.ts`. Verify: green suite; `Select-String -Path src/dsp/*.ts -Pattern 'document|window|AudioContext'` finds nothing.
8. **State machine + UI + wiring: first visual hunt.** `app.ts` with table-driven tests, `copy.ts`, `ui.ts`, `style.css`; `main.ts` replaces the readout (kept behind `?debug`). Screens: landing, requesting, listening (elapsed, mic-alive bar, one static tips line, static "no beep yet" line after 90 s, raw-audio badge), locked banner, hunting chirp/live, paused overlay, errors. Verify on desktop Chrome, Edge and Firefox if installed, with the chirp WAV: lock within one chirp, FIRST READING, then verdicts and a countdown near the WAV period; continuous tone flips to live within ~5 s and back after silence; Re-listen / Reset best / Not it / Stop follow the table; denying the mic shows the permission screen; mouse and keyboard Start → Stop work. Then the same on the phone over USB.
9. **Geiger clicks + haptics + self-noise test.** `clicker.ts` (harmonic-safe carrier, lookahead scheduler, silent until two readings, hold-window pause, mute), haptics scheduler (tiers + chirp pulse), frame taint flag from scheduled click times. Verify: clicks speed up after a louder chirp and slow after a quieter one; Clicks off is instant; the phone buzzes in tiers; 60 s at forced max rate (`?warmth=1`) with a 3.1 kHz lock yields zero chirp events and < 1 dB band rise, otherwise walk the fallback ladder and record the outcome.
10. **Foreground robustness.** Wake lock after Start, re-request only on visibilitychange → visible (a release while hidden is expected), one-time toast if rejected; hidden → paused; visible → auto-resume if healthy, else tap-to-resume (`ctx.resume`, re-acquire an ended track, keep lock and best); track/ctx listeners; clipping → VERY HOT; badge everywhere. Verify on Android: screen stays on 3 min untouched; app switch and back resumes with lock and best intact; desktop Chrome and Firefox hidden tab pauses clicks and resumes.
11. **Field test and tuning.** Android over USB and laptop, with the chirp WAV and, if you have one, a real smoke detector on a low battery (plus a UPS or fridge alarm if available). Change only `config.ts` and `copy.ts` (dead-band 2–4 dB, onset/offset thresholds, minimum duration, click gain/carrier, hold window, timers; `fftSize 2048` is the documented fallback if real chirps are 10–20 ms and lock fails at distance). Record field notes in README. Contingency: if no-lock is the observed failure, add the minimal "I hear it now" button. Verify: from two rooms away the hunter reaches the right room within ~6 chirps with consistent WARMER verdicts on room changes; 5 min of TV and talking produce zero false chirps; `npm test` still green.
12. **Responsive + accessibility pass, README, PWA last.** Layout check at the four sizes, targets ≥ 48 px, aria-live verdict, `role=meter`, reduced motion; README rewrite. Then `manifest.webmanifest` (relative start_url/scope, standalone, `#0B0F19`, 192/512/maskable icons rendered once from `favicon.svg`), apple-touch-icon, theme-color. Verify on the live URL: DevTools Network shows no requests after the initial load; Manifest shows no errors and id `/Soundwave-/`; Chrome Android offers Install and the installed app hunts with a working mic. Tag `v0.1.0`.

## 8. Risks

- **Room acoustics at ~3 kHz.** Beyond 1–2 m the reverberant field flattens level vs distance and standing waves add ±5 dB. The app reliably tells rooms apart and the last 1–2 m; small moves within a room can contradict each other. Copy insists on 2–3 m moves and trends; the dead-band is tuned in the field.
- **Self-noise from the phone's own clicks** with echo cancellation off. Carrier clearance, rate cap, hold-window pause and frame tainting, measured in step 9 with a fallback ladder.
- **Residual hardware AGC on Android; AGC/NS not disableable on Safari.** The relative metric absorbs constant offsets; gain pumping would show as a rising floor after chirps and is recorded per device in step 11.
- **Background operation is impossible in a web page.** Chrome Android drops the mic about a minute after backgrounding; timers throttle. Wake lock plus explicit Paused handling and honest copy.
- **Short chirps.** Some detectors emit 10–20 ms horn pulses. Apparent duration in an 85 ms window is roughly D + (0.4–0.8) × 85 ms depending on SNR, so at ≤ 30 dB SNR a 10 ms chirp may show for only 2 frames. `fftSize 2048` is the documented fallback; validated on a real unit in step 11.
- **Corporate machine.** Non-admin, Fortinet TLS interception, inbound firewall (no LAN testing), USB debugging possibly blocked by MDM, no Firefox installed. Toolchain is early-adopter (Vite 8, Vitest 5) with documented fallbacks.
- **Desktop Safari ships untested** unless a Mac is available; the code path is the same feature-detected one, and the README browser matrix will say so.

## 9. Questions and what I need from you

1. **OK on this plan.** The OK also covers committing after each step and pushing main to deploy.
2. **Node install route.** You are not a local admin. Per-user zip (no UAC, Node 24.21) is my recommendation; say so if you have admin credentials and prefer the winget MSI.
3. **Firefox.** Not installed here. May I install it per-user (no admin needed), or will you check Firefox on another machine?
4. **Desktop Safari.** Do you have a Mac for a check before v0.1.0? If not, it ships untested and the README says so.
5. **License.** MIT, another, or none for now? I will not add a LICENSE file without an answer.
6. **GitHub Pages source.** Flip Settings → Pages → Source to "GitHub Actions" when I reach step 3.
7. **Hardware.** An Android phone with USB debugging for steps 4 onward; ideally a smoke detector or any beeping gadget for step 11.

After the OK I commit this document as `docs/PLAN.md` in the first commit.

---

## Appendix A. `config.ts` defaults

| Constant | Default | Meaning |
|---|---|---|
| fftSize | 4096 | 85 ms window at 48 kHz, 11.7 Hz bins; 2048 is the short-chirp fallback |
| smoothingTimeConstant | 0 | all smoothing in TS |
| minDecibels / maxDecibels | −120 / 0 | AnalyserNode range; use `getFloatFrequencyData` only |
| hopMs | 20 | poll period, deadline-corrected |
| searchBandHz | [1500, 6000] | candidate search band |
| floorHalfBins / floorGuardBins | 24 / 3 | local median floor: ±24 bins excluding ±3 |
| bandBins | 3 | bins nearest the interpolated centre, power sum |
| bandFloorOffsetDb | 10·log10(3) + 1.6 ≈ 6.4 | per-bin median → expected 3-bin noise power |
| candSnrDb | 12 | per-bin peak minus per-bin median floor |
| widthDropDb / widthFloorMarginDb / maxWidth10 | 10 / 6 / 4 | width measured down to max(peak − 10, floor + 6), must be ≤ 4 bins |
| persistFrames / persistSpanMs / maxFreqStdBins | 3 / 40 / 0.5 | candidate persistence and stability |
| fastLockSnrDb | 20 | one sighting locks |
| slowLockSnrDb / slowLockGapMs | 12 / 2000 | two sightings lock |
| sustainedLockMs | 1000 | tone held → live lock |
| lockTolPct / lockTolMinBins | 3 / 3 | acceptance window around f0 |
| f0Alpha | 0.3 | EMA of f0 per accepted chirp |
| onsetSnrDb / onsetFrames | 10 / 2 | segmenter onset on band SNR |
| offsetSnrDb / offsetFrames | 6 / 3 | segmenter offset on band SNR |
| minChirpMs / maxChirpMs | 40 / 3000 | apparent duration bounds |
| frameGapAbortMs | 150 | timer stall aborts an open chirp (blanked frames never do) |
| preOnsetFloorFrames | 10 | floor reference for a chirp |
| clipThreshold / clipFraction | 0.98 / 0.01 | clipping detection |
| deadBandDb | 3 | WARMER / COLDER threshold |
| rangeCeilDb / rangeFloorDb / rangeMinSpanDb / rangeFloorRiseDb | best + 3 / max(bandFloor + 6, best − 45) / 20 / 2 per event | meter range |
| groupGapMs | 3000 | onsets closer than this form one reading |
| intervalN / madRatio | 5 / 0.25 | interval estimator and confidence |
| missedGapFactors / missedGapTolPct | [2, 3] / 20 | gaps near k× median count as k−1 missed chirps |
| holdStartS / holdEndExtraS | 5 / max(2·MAD, 2) + 2 | shared hold window |
| overdueX / lostX | 1.5 / 3 | countdown phases |
| liveEnterCoverS / liveRapidGapMs / liveExitSilenceS | 5 / 1500 / 3 | two-way mode classifier |
| liveHoldMs / liveVerdictMs / liveRefMs | 2000 / 1000 / 3000 | live meter |
| clickMinHz / clickMaxHz | 1 / 12 | Geiger rate range, λ = 12^x |
| clickMinGapS / clickMaxGapS | 0.05 / 2 | shifted-exponential draw |
| clickMs / clickGainDb | 5 / −18 | click length and level |
| clickCarriers | [900, 700, 1100, 500, 1300, 6000] | first whose harmonics 1–6 clear f0 by ≥ 2/clickSec |
| taintPadMs | 5 | frames within ±5 ms of a click are flagged |
| selfNoiseFallback | gain −24 → onset +2 dB → blank + 6 Hz cap | ordered ladder |
| hapticMinPulseMs / hapticTiers | 30 / 4 | vibration tiers |
| noBeepHintMs / lockedBannerMs | 90000 / 2000 | UI timers |

## Appendix B. PowerShell 5.1 command notes

- Session prefix for every node/npm/adb call until PhpStorm restarts:
  `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); $env:NODE_USE_SYSTEM_CA = '1'`
- Per-user Node: `$ProgressPreference = 'SilentlyContinue'; $v = 'v24.21.0'; $dst = "$env:LOCALAPPDATA\Programs\nodejs"; Invoke-WebRequest "https://nodejs.org/dist/$v/node-$v-win-x64.zip" -OutFile "$env:TEMP\node.zip"; (Get-FileHash "$env:TEMP\node.zip" -Algorithm SHA256).Hash` compared with `Invoke-RestMethod "https://nodejs.org/dist/$v/SHASUMS256.txt"`; then `Expand-Archive "$env:TEMP\node.zip" "$env:TEMP\node-x" -Force; Move-Item "$env:TEMP\node-x\node-$v-win-x64" $dst; [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ";$dst", 'User')`
- Use `npm.cmd` if the `npm.ps1` shim is blocked by execution policy; no `&&` chaining; `curl.exe` not `curl`; `Select-String` not `grep`.
- winget MSI route needs the tool timeout raised to 10 min and a foreground UAC prompt.

## Appendix C. Unit-test list

- spectrum: binHz round-trip at 44.1 and 48 kHz; sanitizeDb maps −Infinity and ≤ −900 to −160
- spectrum: localFloorDb on seeded log-Rayleigh noise within ±1 dB of the seeded floor, unaffected by a 40 dB tone inside the guard band
- spectrum: bandFloorDb on pure noise: median band SNR in [−1, +1] dB; no 2-frame onset in 10⁴ frames
- spectrum: parabolicPeak recovers sub-bin offsets within 0.05 bin and level within 0.3 dB (200 seeded cases)
- spectrum: peakWidthBins ≤ 4 for ≥ 95 % of true tones at 12–14 dB SNR; > 4 for a wide Gaussian bump
- spectrum: bandLevelDb scalloping < 0.5 dB across sub-bin positions; equals tone level within 1 dB
- spectrum: clipFraction counts |x| ≥ 0.98; 0 for a −6 dBFS sine
- detect: findPeaks finds a 3,120 Hz tone within 2 Hz; ignores out-of-band, low-SNR and wide peaks; false-positive rate on noise below the bound computed from the threshold with ≥ 10× margin
- detect: no lock for a 1-frame transient, a gliding tone (std > 0.5 bin) or an event shorter than one hop
- detect: fast lock after one 200 ms chirp at 20 dB SNR with firstChirp.peakDb equal to the tone level; slow lock after two 12 dB sightings 2 s apart; live lock after 1 s sustained
- hunt: segmenter onset within one hop and apparent duration within one window for 100 and 400 ms chirps; ignores a broadband +20 dB transient; ignores a tone 5 % off f0
- hunt: peak-hold records the maximum; +5 dB → WARMER and isNewBest; −5 dB → COLDER; ±2 dB → SAME; clipped → MAX with best unchanged
- hunt: range floor/ceiling/min-span rules; first reading has no pct; second reading defines pct
- hunt: interval median/MAD on regular, irregular and grouped onsets (expected values computed from the fixture, not hard-coded); gaps near 2× and 3× median count as missed chirps
- hunt: countdown phases unknown → eta → hold → overdue → lost; hold window expiry resumes clicks
- hunt: mode 4 beeps/30 s and 2 beeps/45 s stay chirp; 2 beeps/s for 6 s → live; live + 4 s silence → chirp with one grouped reading; 3.5 s single tone then silence returns to chirp
- hunt: live heldDb = 2 s running max; verdict vs 3 s earlier at most once per second
- geiger: clickRateHz(0) = 1, (1) = 12, exponential; sampler mean = 1/λ within 3 % over 10⁵ draws, min gap 50 ms respected
- geiger: chooseClickFreq harmonics 1–6 clear f0 by ≥ 2/clickSec for f0 in 1.5–6 kHz; 6000 chosen only when nothing lower fits
- geiger (reference FFT): one 5 ms click at the chosen carrier raises the 3-bin band at f0 by < 1 dB
- geiger: vibrationTier boundaries; null below the first tier; nothing before Start
- app: every transition in the table, unknown events leave state unchanged
- synth self-check: exact Blackman kernel first sidelobe ≈ −58 dB, −3 dB width ≈ 1.68 bins
