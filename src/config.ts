/**
 * Every tunable constant lives here. Field tuning changes only this file and copy.ts.
 * Units are part of each name: Ms, S, Hz, Db, Bins, Pct, Frames.
 *
 * Levels are in AnalyserNode units: dB of |X[k]| / fftSize after a Blackman window,
 * so a full-scale sine centred on a bin reads about -13.6 dB and a quiet room about -100 dB.
 */
export interface HapticTier {
  /** Tier applies when warmth >= minWarmth (tiers are checked from the highest down). */
  readonly minWarmth: number
  /** navigator.vibrate pattern, re-issued every hapticPeriodMs. Total length must be <= hapticPeriodMs. */
  readonly pattern: readonly number[]
}

export interface Config {
  // ---- Capture -------------------------------------------------------------------------------
  readonly fftSize: number
  readonly minDecibels: number
  readonly maxDecibels: number
  /** Analysis poll period (deadline-corrected timer). */
  readonly hopMs: number
  /** Value used for -Infinity / NaN / absurdly low bins after sanitising. */
  readonly silentDb: number
  /** A time-domain sample counts as clipped when |x| >= clipThreshold. */
  readonly clipThreshold: number
  /** A frame (and a chirp containing it) is clipped when more than this share of samples clip. */
  readonly clipFraction: number
  /** A frame arriving later than this after the previous one is a timer stall: open measurements are discarded. */
  readonly frameGapAbortMs: number

  // ---- Spectrum and noise floor --------------------------------------------------------------
  /**
   * Beeps are searched for in this band while listening. Smoke and CO alarms sit near 3 kHz; some
   * gadgets and appliance alarms beep far higher, and phone microphones still hear 12 kHz well.
   */
  readonly searchBandHz: readonly [number, number]
  /** Local noise floor = median of bins within +-floorHalfBins, excluding +-floorGuardBins around the peak. */
  readonly floorHalfBins: number
  readonly floorGuardBins: number
  /** Level of the locked tone = power sum of this many bins nearest the (interpolated) centre. Odd. */
  readonly bandBins: number
  /**
   * Correction from a per-bin median-magnitude floor to the expected noise power of the band:
   * bandFloorDb = floorDb + 10*log10(bandBins) + bandFloorOffsetDb.
   * 1.59 dB = 10*log10(2 / (2 ln 2)) is the Rayleigh mean-power / median-power ratio.
   */
  readonly bandFloorOffsetDb: number

  // ---- Candidate detection (listening) -------------------------------------------------------
  /** A candidate bin must be the maximum within +-localMaxHalfBins. */
  readonly localMaxHalfBins: number
  /** Per-bin peak (interpolated) minus per-bin local median floor. */
  readonly candSnrDb: number
  /** Peak width is measured down to max(peak - widthDropDb, floor + widthFloorMarginDb). */
  readonly widthDropDb: number
  readonly widthFloorMarginDb: number
  /**
   * Narrowband test: at most this many contiguous bins above the width threshold.
   * A short chirp is spectrally wider than a steady tone (a 50 ms burst is about 5 bins wide at
   * -6 dB), so the width is measured at -6 dB and allows 5 bins. Measured on synthetic chirps at
   * 30 dB per-bin SNR: 40 ms and longer lock 9-10 times in 10, 25-30 ms about half the time; zero
   * false locks in 30 min of noise. The earlier -10 dB / 4-bin rule only locked chirps >= 80 ms.
   */
  readonly maxWidthBins: number
  /** At most this many candidates (strongest SNR first) are kept per frame. */
  readonly maxCandidates: number

  // ---- Tracker and persistence ---------------------------------------------------------------
  /** A candidate continues a track when its interpolated bin is within this many bins of the track mean. */
  readonly trackMatchBins: number
  /** A track closes after this many consecutive frames without a matching candidate. */
  readonly trackCloseMissFrames: number
  readonly maxTracks: number
  /**
   * A track is a valid sighting when seen in >= persistFrames frames spanning >= persistSpanMs ...
   * (35 ms, a little under 2 hops, so timer jitter cannot reject a 3-frame track).
   */
  readonly persistFrames: number
  readonly persistSpanMs: number
  /** ... with the standard deviation of its interpolated bin below this (piezos do not glide, speech does). */
  readonly maxFreqStdBins: number

  // ---- Lock policy -----------------------------------------------------------------------------
  /**
   * One sighting whose best per-bin SNR reaches this locks immediately, but only when
   * lockConfirmChirps is 1; with the default 2 every chirp needs a confirming second sighting.
   */
  readonly fastLockSnrDb: number
  /**
   * Two sightings at >= slowLockSnrDb, within lock tolerance of each other and >= slowLockGapMs apart, lock.
   * Calibration (3 h of synthetic white noise, band 1.5-12 kHz): noise sightings reached 14 dB 5.7 times
   * per hour below 6 kHz and 9 times per hour from 6 to 12 kHz, 15 dB 1.3 and 2.3 times; the loudest
   * reached 15.6 dB below 6 kHz and 16.7 dB above. Hence highBandExtraSnrDb (17 dB from 6 kHz up) and
   * clearSightingExtraSnrDb (only 16 dB and more, or 19 dB from 6 kHz up, are remembered for 15 min):
   * with them, noise shows no more pending beeps than with the old 6 kHz band and 3 min memory, and
   * made no false pairs.
   */
  readonly slowLockSnrDb: number
  /**
   * From highBandFromHz up, a sighting needs slowLockSnrDb + highBandExtraSnrDb to count (to be
   * remembered, shown as a pending beep and paired into a lock). The band above it was added for
   * unusual high beeps; it holds more bins than the band below, and without the margin microphone
   * noise there alone made a false pending beep every few minutes. Smoke and CO alarms (about 3 kHz)
   * keep the full sensitivity.
   */
  readonly highBandFromHz: number
  readonly highBandExtraSnrDb: number
  readonly slowLockGapMs: number
  /** Sightings older than this are forgotten, unless they are clear (see clearSightingMemoryMs). */
  readonly slowLockMemoryMs: number
  /**
   * A clear sighting, at least clearSightingExtraSnrDb above what its frequency needs
   * (slowLockSnrAt), is remembered this long instead: some alarms beep only every 7-10 minutes, and
   * the second beep must still find the first one to confirm it ("Use it now" stays offered as
   * long). Borderline sightings keep the short memory, since microphone noise reaches them several
   * times an hour and would otherwise pair up into false locks; for the same reason two sightings
   * more than slowLockMemoryMs apart only lock when both are clear.
   */
  readonly clearSightingMemoryMs: number
  readonly clearSightingExtraSnrDb: number
  /** A stable track that stays present this long locks in live mode (continuous tone). */
  readonly sustainedLockMs: number
  /**
   * Chirps that must be heard (at the same frequency, >= slowLockGapMs apart) before locking.
   * 2 = listen a little longer and confirm the beep; 1 = lock on the first strong chirp
   * (fastLockSnrDb). The user can always lock on a single heard chirp with "Use it now".
   */
  readonly lockConfirmChirps: number
  /** Acceptance window around the locked frequency: max(lockTolPct % of f0, lockTolMinBins bins). */
  readonly lockTolPct: number
  readonly lockTolMinBins: number
  /** EMA weight of each accepted chirp's frequency when updating the lock. */
  readonly f0Alpha: number
  /** After "Not it", frequencies within lockTolPct of the rejected one are ignored for this long. */
  readonly notItExcludeMs: number
  /** How long listening-phase peaks are kept for a future "I hear it now" button. */
  readonly candidateRingMs: number

  // ---- Segmenter (hunting) -------------------------------------------------------------------
  /**
   * Band SNR (band level - band floor) at or above which a frame counts as "tone on".
   * Band SNR is about 4 dB below per-bin SNR for a pure tone, so 8 dB here matches candSnrDb = 12.
   * Calibrated on 2 h of synthetic white noise through the reference analyser: 8 dB for 3 frames
   * gave 0 false onsets; 8 dB for 2 frames gave 14.5 per hour (adjacent frames overlap by 76 %).
   */
  readonly onsetSnrDb: number
  readonly onsetFrames: number
  /** Band SNR below which a frame counts as "tone off". */
  readonly offsetSnrDb: number
  readonly offsetFrames: number
  /** Accepted apparent chirp duration (first to last frame above the offset threshold). */
  readonly minChirpMs: number
  readonly maxChirpMs: number
  /** Band-floor reference for a chirp = median band floor of this many frames before the onset. */
  readonly preOnsetFloorFrames: number
  /**
   * A segment is only a chirp if, at its loudest frame, the per-bin peak near f0 lies within this
   * many bins of the band centre, and its per-frame peak position varies by less than
   * maxFreqStdBins (rejects speech harmonics gliding through the band).
   */
  readonly chirpMaxOffsetBins: number

  // ---- Readings, verdict and meter range -----------------------------------------------------
  /** WARMER / COLDER need at least this change vs the previous reading; otherwise ABOUT THE SAME. */
  readonly deadBandDb: number
  /** Meter range: ceiling = best + rangeCeilOverBestDb. */
  readonly rangeCeilOverBestDb: number
  /** Meter range: floor target = max(band floor + rangeFloorOverNoiseDb, best - rangeFloorBelowBestDb). */
  readonly rangeFloorOverNoiseDb: number
  readonly rangeFloorBelowBestDb: number
  /** The range never gets narrower than this. */
  readonly rangeMinSpanDb: number
  /** The range floor drops immediately but rises at most this much per reading. */
  readonly rangeFloorRiseDb: number
  /** Readings kept in memory / shown in the history strip. */
  readonly readingsKept: number
  readonly historyShown: number
  /** Raw chirps kept for the debug view. */
  readonly chirpsKept: number

  // ---- Interval and countdown ----------------------------------------------------------------
  /** Chirps starting within this time after the previous chirp's end merge into the same reading. */
  readonly groupGapMs: number
  /** Interval = median of the last intervalN gaps between readings. */
  readonly intervalN: number
  /** Interval is confident with >= 2 gaps and MAD / median below this. */
  readonly madRatio: number
  /** A gap within missedGapTolPct % of k x median (k in this list) counts as k - 1 missed chirps. */
  readonly missedGapFactors: readonly number[]
  readonly missedGapTolPct: number
  /**
   * A long wait: the median interval (or, while the interval is unknown, the time since the last
   * reading) reaches this. The status bar then says to stay put until the next beep, with the time
   * since the last one, instead of the chirp countdown, and the clicks stay silent meanwhile.
   */
  readonly longWaitS: number
  /** HOLD STILL starts this long (plus 2 x the interval's MAD, for irregular beeps) before the expected chirp ... */
  readonly holdStartS: number
  /** ... and ends at expected + max(2 * MAD, holdEndMinS) + holdEndExtraS if no chirp arrives. */
  readonly holdEndMinS: number
  readonly holdEndExtraS: number
  /** Countdown phases relative to the median interval since the last reading. */
  readonly overdueX: number
  readonly lostX: number

  // ---- Chirp / live mode ---------------------------------------------------------------------
  /** Enter live mode when activity (tone on, or onsets less than liveRapidGapMs apart) covers this long without a pause. */
  readonly liveEnterCoverS: number
  readonly liveRapidGapMs: number
  /** Leave live mode after this much silence; the train becomes one reading. */
  readonly liveExitSilenceS: number
  /** Live meter = running max of the band level over this window. */
  readonly liveHoldMs: number
  /** Live verdict is recomputed at most this often, comparing with the held level liveRefMs earlier. */
  readonly liveVerdictMs: number
  readonly liveRefMs: number

  // ---- Geiger clicks -------------------------------------------------------------------------
  /** Click rate = clickMinHz * (clickMaxHz / clickMinHz) ^ warmth. */
  readonly clickMinHz: number
  readonly clickMaxHz: number
  /** Inter-click interval = clickMinGapS + Exp(mean 1/rate - clickMinGapS), capped at clickMaxGapS. */
  readonly clickMinGapS: number
  readonly clickMaxGapS: number
  /** Click = Hann-windowed sine burst of this length and peak level. */
  readonly clickMs: number
  readonly clickGainDb: number
  /** Carrier = first entry whose harmonics 1..clickHarmonics all stay >= 2 / (clickMs / 1000) Hz from f0. */
  readonly clickCarriersHz: readonly number[]
  readonly clickHarmonics: number
  /**
   * The carrier's fundamental must also lie at least this far from f0. The 2 / clickLength rule
   * only clears the click's main lobe; its sidelobes (about -31.5 and -41 dB) leaked up to +10 dB
   * into the band for beeps at 1.5-2.2 kHz until this was added.
   */
  readonly clickMinCarrierDistanceHz: number
  readonly clickLookaheadS: number
  readonly clickSchedulerMs: number
  /** Extra time around a click, beyond the analysis window, during which frames are flagged as tainted. */
  readonly taintPadMs: number
  /** Last rung of the self-noise fallback ladder: drop tainted frames and cap the click rate. */
  readonly blankTaintedFrames: boolean
  readonly blankingClickMaxHz: number

  // ---- Haptics -------------------------------------------------------------------------------
  readonly hapticPeriodMs: number
  readonly hapticTiers: readonly HapticTier[]
  readonly hapticClippedPattern: readonly number[]
  /** Short pulse when a new reading is registered. */
  readonly hapticReadingPattern: readonly number[]

  // ---- Direction scan (radar) ----------------------------------------------------------------
  /**
   * Sectors of the radar when each chirp contributes one sample (you turn between chirps).
   * The scan works by body shadowing: held in front of the chest, the phone hears sound from
   * behind you several dB quieter, so the loudest heading points toward the source (or toward the
   * doorway its sound comes through).
   */
  readonly radarChirpSectors: number
  /** Sectors when a continuous tone is sampled every frame while you turn slowly. */
  readonly radarLiveSectors: number
  /** At least this many distinct sectors must be measured before any direction is shown. */
  readonly radarMinSectors: number
  /** Loudest minus quietest sector below this: "no clear direction". */
  readonly radarMinContrastDb: number
  /** At or above this contrast (and with small gaps) the direction counts as clear. */
  readonly radarClearContrastDb: number
  /** Largest angular gap between measured sectors that still allows a rough / a clear answer. */
  readonly radarRoughMaxGapDeg: number
  readonly radarClearMaxGapDeg: number
  /**
   * Heading smoothing time constant: each compass reading moves the heading by 1 - exp(-dt / tau),
   * so the result does not depend on how often the device fires orientation events.
   */
  readonly headingSmoothingMs: number
  /** The scan is unavailable if no compass reading arrives within this time. */
  readonly headingTimeoutMs: number

  // ---- Comparing several listeners (extra mics on this device, stations on other devices) ------
  /** Chirp reports whose onsets lie within this window (after clock alignment) are the same chirp. */
  readonly compareWindowMs: number
  /** The loudest listener is only named when it beats the second by at least this much. */
  readonly compareMinMarginDb: number
  /** A listener that has not reported for this long is marked lost. */
  readonly listenerLostMs: number
  /** Stations send their held level this often in live mode. */
  readonly stationLevelReportMs: number
  /** Hub-station clock pings (the median offset of the fastest round trips is used). */
  readonly stationPingMs: number
  readonly stationPingKeep: number
  /** Pairing gives up waiting for ICE gathering after this long. */
  readonly pairingGatherTimeoutMs: number

  // ---- Log -----------------------------------------------------------------------------------
  readonly logMaxEntries: number
  readonly logNoteMaxLength: number

  // ---- Past hunts (history.ts) -----------------------------------------------------------------
  /** Hunts kept under Past hunts; the oldest is dropped beyond this. */
  readonly historyMaxEntries: number
  readonly historyLabelMaxLength: number
  /** Log notes kept per past hunt (the newest ones). */
  readonly historyMaxNotes: number

  // ---- UI ------------------------------------------------------------------------------------
  readonly noBeepHintMs: number
  readonly lockedBannerMs: number
  /** On the Found it screen the microphones close after this long (Keep hunting opens them again). */
  readonly foundMicOffMs: number
  readonly requestHintMs: number
  readonly toastMs: number
  /** Stop asks for confirmation once the hunt has at least this many readings. */
  readonly stopConfirmMinReadings: number
  /** Mic-alive bar maps the frame RMS from micLevelFloorDb (empty) to micLevelCeilDb (full). */
  readonly micLevelFloorDb: number
  readonly micLevelCeilDb: number
}

export const CONFIG: Config = Object.freeze({
  fftSize: 4096,
  minDecibels: -120,
  maxDecibels: 0,
  hopMs: 20,
  silentDb: -160,
  clipThreshold: 0.98,
  clipFraction: 0.01,
  frameGapAbortMs: 150,

  searchBandHz: [1500, 12_000] as const,
  floorHalfBins: 24,
  floorGuardBins: 3,
  bandBins: 3,
  bandFloorOffsetDb: 1.59,

  localMaxHalfBins: 3,
  candSnrDb: 12,
  widthDropDb: 6,
  widthFloorMarginDb: 6,
  maxWidthBins: 5,
  maxCandidates: 8,

  trackMatchBins: 1,
  trackCloseMissFrames: 3,
  maxTracks: 6,
  persistFrames: 3,
  persistSpanMs: 35,
  maxFreqStdBins: 0.5,

  fastLockSnrDb: 20,
  slowLockSnrDb: 14,
  highBandFromHz: 6000,
  highBandExtraSnrDb: 3,
  slowLockGapMs: 2000,
  slowLockMemoryMs: 180_000,
  clearSightingMemoryMs: 900_000,
  clearSightingExtraSnrDb: 2,
  sustainedLockMs: 2000,
  lockConfirmChirps: 2,
  lockTolPct: 3,
  lockTolMinBins: 3,
  f0Alpha: 0.3,
  notItExcludeMs: 600_000,
  candidateRingMs: 2500,

  onsetSnrDb: 8,
  onsetFrames: 3,
  offsetSnrDb: 4,
  offsetFrames: 3,
  minChirpMs: 40,
  maxChirpMs: 5000,
  preOnsetFloorFrames: 10,
  chirpMaxOffsetBins: 1.5,

  deadBandDb: 3,
  rangeCeilOverBestDb: 3,
  rangeFloorOverNoiseDb: 6,
  rangeFloorBelowBestDb: 45,
  rangeMinSpanDb: 20,
  rangeFloorRiseDb: 2,
  readingsKept: 20,
  historyShown: 6,
  chirpsKept: 10,

  groupGapMs: 3000,
  intervalN: 5,
  madRatio: 0.25,
  missedGapFactors: [2, 3] as const,
  missedGapTolPct: 20,
  holdStartS: 5,
  holdEndMinS: 2,
  longWaitS: 60,
  holdEndExtraS: 2,
  overdueX: 1.5,
  lostX: 3,

  liveEnterCoverS: 5,
  liveRapidGapMs: 1500,
  liveExitSilenceS: 3,
  liveHoldMs: 2000,
  liveVerdictMs: 1000,
  liveRefMs: 3000,

  clickMinHz: 1,
  clickMaxHz: 12,
  clickMinGapS: 0.05,
  clickMaxGapS: 2,
  clickMs: 5,
  clickGainDb: -18,
  clickCarriersHz: [900, 700, 1100, 500, 1300, 6000] as const,
  clickHarmonics: 6,
  clickMinCarrierDistanceHz: 1000,
  clickLookaheadS: 0.1,
  clickSchedulerMs: 25,
  taintPadMs: 5,
  blankTaintedFrames: false,
  blankingClickMaxHz: 6,

  hapticPeriodMs: 1000,
  hapticTiers: [
    { minWarmth: 0.75, pattern: [30, 220, 30, 220, 30, 220, 30] },
    { minWarmth: 0.5, pattern: [30, 470, 30] },
    { minWarmth: 0.25, pattern: [30] },
  ],
  hapticClippedPattern: [400, 100, 400],
  hapticReadingPattern: [60],

  radarChirpSectors: 8,
  radarLiveSectors: 24,
  radarMinSectors: 3,
  radarMinContrastDb: 4,
  radarClearContrastDb: 8,
  radarRoughMaxGapDeg: 180,
  radarClearMaxGapDeg: 90,
  headingSmoothingMs: 120,
  headingTimeoutMs: 1500,

  compareWindowMs: 1500,
  compareMinMarginDb: 3,
  listenerLostMs: 10_000,
  stationLevelReportMs: 500,
  stationPingMs: 3000,
  stationPingKeep: 8,
  pairingGatherTimeoutMs: 4000,

  logMaxEntries: 200,
  logNoteMaxLength: 120,

  historyMaxEntries: 20,
  historyLabelMaxLength: 60,
  historyMaxNotes: 12,

  noBeepHintMs: 90_000,
  lockedBannerMs: 5000,
  foundMicOffMs: 120_000,
  requestHintMs: 6000,
  toastMs: 3500,
  stopConfirmMinReadings: 3,
  micLevelFloorDb: -80,
  micLevelCeilDb: -20,
})

/** Copy of CONFIG with some fields replaced (tests, ?debug overrides). */
export function withConfig(patch: Partial<Config>): Config {
  return Object.freeze({ ...CONFIG, ...patch })
}
