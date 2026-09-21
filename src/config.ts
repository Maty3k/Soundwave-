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
  /** Beeps are searched for in this band while listening. */
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
  /** Narrowband test: at most this many contiguous bins above the width threshold. */
  readonly maxWidthBins: number
  /** At most this many candidates (strongest SNR first) are kept per frame. */
  readonly maxCandidates: number

  // ---- Tracker and persistence ---------------------------------------------------------------
  /** A candidate continues a track when its interpolated bin is within this many bins of the track mean. */
  readonly trackMatchBins: number
  /** A track closes after this many consecutive frames without a matching candidate. */
  readonly trackCloseMissFrames: number
  readonly maxTracks: number
  /** A track is a valid sighting when seen in >= persistFrames frames spanning >= persistSpanMs ... */
  readonly persistFrames: number
  readonly persistSpanMs: number
  /** ... with the standard deviation of its interpolated bin below this (piezos do not glide, speech does). */
  readonly maxFreqStdBins: number

  // ---- Lock policy -----------------------------------------------------------------------------
  /** One sighting whose best per-bin SNR reaches this locks immediately. */
  readonly fastLockSnrDb: number
  /**
   * Two sightings at >= slowLockSnrDb, within lock tolerance of each other and >= slowLockGapMs apart, lock.
   * Calibration (2 h synthetic noise): noise sightings reach 12 dB about 10 times per hour but 14 dB only
   * 2.5 times per hour; the loudest noise candidate reached 18.2 dB, below fastLockSnrDb.
   */
  readonly slowLockSnrDb: number
  readonly slowLockGapMs: number
  /** Sightings older than this are forgotten. */
  readonly slowLockMemoryMs: number
  /** A stable track that stays present this long locks in live mode (continuous tone). */
  readonly sustainedLockMs: number
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
  /** HOLD STILL starts this long before the expected chirp ... */
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

  // ---- UI ------------------------------------------------------------------------------------
  readonly noBeepHintMs: number
  readonly lockedBannerMs: number
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

  searchBandHz: [1500, 6000] as const,
  floorHalfBins: 24,
  floorGuardBins: 3,
  bandBins: 3,
  bandFloorOffsetDb: 1.59,

  localMaxHalfBins: 3,
  candSnrDb: 12,
  widthDropDb: 10,
  widthFloorMarginDb: 6,
  maxWidthBins: 4,
  maxCandidates: 8,

  trackMatchBins: 1,
  trackCloseMissFrames: 3,
  maxTracks: 6,
  persistFrames: 3,
  persistSpanMs: 40,
  maxFreqStdBins: 0.5,

  fastLockSnrDb: 20,
  slowLockSnrDb: 14,
  slowLockGapMs: 2000,
  slowLockMemoryMs: 180_000,
  sustainedLockMs: 1000,
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

  noBeepHintMs: 90_000,
  lockedBannerMs: 2000,
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
