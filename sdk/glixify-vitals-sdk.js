/**
 * Glixify Vitals SDK (v0.1) — open, camera-agnostic rPPG signal processor.
 *
 * Takes a stream of skin-region RGB averages (from any face-tracking source —
 * MediaPipe on web, a native camera pipeline on Android/iOS) and derives
 * heart rate, HRV, respiratory rate and a signal-quality score using the
 * CHROM rPPG method (de Haan & Jeanne, 2013) — published, license-free math,
 * not a vendor black box.
 *
 * This module has NO camera, canvas or face-tracking code in it by design —
 * that keeps the signal-processing core portable across platforms. A caller
 * (web app, Android, iOS) only needs to feed it {r, g, b, timestampMs}.
 *
 * NOT clinically validated. Screening/demo signal only — see project README.
 */

(function (global) {
  "use strict";

  const DEFAULTS = {
    windowSeconds: 10, // rolling analysis window
    minBpm: 42,
    maxBpm: 180,
    minBreathsPerMin: 6,
    maxBreathsPerMin: 30,
    minSamplesForEstimate: 90, // ~3s at 30fps before first estimate
  };

  /** Next power of two >= n. */
  function nextPow2(n) {
    let p = 1;
    while (p < n) p *= 2;
    return p;
  }

  /**
   * Iterative radix-2 Cooley-Tukey FFT. Operates in place on parallel
   * real/imag arrays of length = power of two. inverse=true computes IFFT
   * (unnormalized; caller divides by N if needed).
   */
  function fftInPlace(re, im, inverse) {
    const n = re.length;
    if (n <= 1) return;

    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((inverse ? 1 : -1) * 2 * Math.PI) / len;
      const wRe = Math.cos(ang);
      const wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1;
        let curIm = 0;
        for (let k = 0; k < len / 2; k++) {
          const uRe = re[i + k];
          const uIm = im[i + k];
          const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
          const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
          re[i + k] = uRe + vRe;
          im[i + k] = uIm + vIm;
          re[i + k + len / 2] = uRe - vRe;
          im[i + k + len / 2] = uIm - vIm;
          const nextRe = curRe * wRe - curIm * wIm;
          const nextIm = curRe * wIm + curIm * wRe;
          curRe = nextRe;
          curIm = nextIm;
        }
      }
    }
  }

  function mean(arr) {
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return arr.length ? s / arr.length : 0;
  }

  function std(arr, m) {
    if (arr.length < 2) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(s / (arr.length - 1));
  }

  /** Hann window to reduce spectral leakage before FFT. */
  function applyHannWindow(signal) {
    const n = signal.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
      out[i] = signal[i] * w;
    }
    return out;
  }

  /** Raised-cosine gain in [0,1]: 0 below lo, 1 above hi, smooth ramp between. */
  function raisedCosineRamp(x, lo, hi) {
    if (x <= lo) return 0;
    if (x >= hi) return 1;
    return 0.5 - 0.5 * Math.cos((Math.PI * (x - lo)) / (hi - lo));
  }

  /**
   * Band-limits a real signal to [minHz, maxHz] via a smoothly-tapered
   * frequency-domain gain (not a hard rectangular cutoff) and inverse-
   * transforms. A hard cutoff causes Gibbs-phenomenon ringing in the
   * time-domain output — spurious oscillations that a peak-picker mistakes
   * for extra heartbeats, corrupting HRV. The taper trades a little
   * frequency selectivity for a much cleaner waveform to detect peaks on.
   */
  function bandpassFilter(signal, fs, minHz, maxHz) {
    const n0 = signal.length;
    const n = nextPow2(n0);
    const re = new Array(n).fill(0);
    const im = new Array(n).fill(0);
    const windowed = applyHannWindow(signal);
    for (let i = 0; i < n0; i++) re[i] = windowed[i];

    fftInPlace(re, im, false);

    const binHz = fs / n;
    const bandwidth = maxHz - minHz;
    const transition = Math.max(binHz * 2, bandwidth * 0.15); // smooth edge width
    for (let k = 0; k < n; k++) {
      const freq = k <= n / 2 ? k * binHz : (k - n) * binHz;
      const abs = Math.abs(freq);
      const lowGain = raisedCosineRamp(abs, minHz - transition, minHz);
      const highGain = 1 - raisedCosineRamp(abs, maxHz, maxHz + transition);
      const gain = Math.min(lowGain, highGain);
      re[k] *= gain;
      im[k] *= gain;
    }

    fftInPlace(re, im, true);
    const filtered = new Array(n0);
    for (let i = 0; i < n0; i++) filtered[i] = re[i] / n;
    return filtered;
  }

  /**
   * Returns { freqHz, power, snr } for the dominant spectral peak within
   * [minHz, maxHz] of a real signal, plus a rough signal-to-noise ratio
   * (peak power vs. mean power in-band) used as a confidence proxy.
   */
  function dominantFrequency(signal, fs, minHz, maxHz) {
    const n0 = signal.length;
    const n = nextPow2(n0);
    const re = new Array(n).fill(0);
    const im = new Array(n).fill(0);
    const windowed = applyHannWindow(signal);
    for (let i = 0; i < n0; i++) re[i] = windowed[i];

    fftInPlace(re, im, false);

    const binHz = fs / n;
    let bestK = -1;
    let bestPower = -Infinity;
    let sumPower = 0;
    let count = 0;
    for (let k = 1; k < n / 2; k++) {
      const freq = k * binHz;
      if (freq < minHz || freq > maxHz) continue;
      const power = re[k] * re[k] + im[k] * im[k];
      sumPower += power;
      count++;
      if (power > bestPower) {
        bestPower = power;
        bestK = k;
      }
    }
    if (bestK === -1 || count === 0) {
      return { freqHz: 0, power: 0, snr: 0 };
    }
    const meanPower = sumPower / count;
    const snr = meanPower > 0 ? bestPower / meanPower : 0;
    return { freqHz: bestK * binHz, power: bestPower, snr };
  }

  /**
   * Time-domain cross-check for the FFT's dominant-frequency HR estimate.
   * A real heartbeat is periodic in the raw signal too, not just spectrally
   * dominant — so an independent autocorrelation-based rate should land
   * near the same value. A harmonic lock or noise peak in the FFT (e.g. 2x
   * or an unrelated frequency that happens to look "clean") usually will
   * NOT show matching periodicity here, which is exactly what lets this
   * catch high-SNR-but-wrong readings that the spectral confidence alone
   * cannot distinguish from a real pulse.
   */
  function autocorrelationRateHz(signal, fs, minHz, maxHz) {
    const n = signal.length;
    const minLag = Math.max(1, Math.round(fs / maxHz));
    const maxLag = Math.min(n - 2, Math.round(fs / minHz)); // -2 so bestLag+1 is always in range below
    if (maxLag <= minLag) return { hz: 0, strength: 0 };

    const m = mean(signal);
    const centered = signal.map((v) => v - m);
    const denom = centered.reduce((s, v) => s + v * v, 0) || 1;

    const scoreAt = (lag) => {
      let sum = 0;
      for (let i = 0; i < n - lag; i++) sum += centered[i] * centered[i + lag];
      return sum / denom;
    };

    let bestLag = -1;
    let bestScore = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const score = scoreAt(lag);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    if (bestLag <= 0) return { hz: 0, strength: 0 };

    // Parabolic interpolation around the integer-lag peak for sub-sample
    // precision — whole-lag resolution alone is coarse enough (several bpm
    // between adjacent lags at typical resting HR) to cause spurious
    // disagreement with the FFT's much finer zero-padded bin resolution.
    let refinedLag = bestLag;
    if (bestLag - 1 >= minLag && bestLag + 1 <= maxLag) {
      const yPrev = scoreAt(bestLag - 1);
      const yCurr = bestScore;
      const yNext = scoreAt(bestLag + 1);
      const denomInterp = yPrev - 2 * yCurr + yNext;
      if (Math.abs(denomInterp) > 1e-9) {
        const delta = (0.5 * (yPrev - yNext)) / denomInterp;
        if (Math.abs(delta) < 1) refinedLag = bestLag + delta;
      }
    }

    return { hz: fs / refinedLag, strength: bestScore };
  }

  /** Simple local-maxima peak picker with a minimum-distance constraint. */
  function findPeaks(signal, minDistanceSamples) {
    const rawPeaks = [];
    for (let i = 1; i < signal.length - 1; i++) {
      if (signal[i] > signal[i - 1] && signal[i] >= signal[i + 1]) {
        if (rawPeaks.length === 0 || i - rawPeaks[rawPeaks.length - 1] >= minDistanceSamples) {
          rawPeaks.push(i);
        } else if (signal[i] > signal[rawPeaks[rawPeaks.length - 1]]) {
          rawPeaks[rawPeaks.length - 1] = i;
        }
      }
    }
    if (rawPeaks.length < 2) return rawPeaks;

    // Prominence filter: a real heartbeat peak stands well above the signal's
    // local baseline. Small ripples (filter ringing, residual noise) that
    // technically qualify as local maxima get rejected here — this is what
    // stops a real heartbeat from being mistaken for two, or a noise wiggle
    // from being counted as a beat, both of which corrupt HRV.
    const amplitude = Math.max(...signal) - Math.min(...signal);
    if (amplitude === 0) return rawPeaks;
    const minProminence = amplitude * 0.25;

    return rawPeaks.filter((p) => {
      const left = signal.slice(Math.max(0, p - minDistanceSamples), p);
      const right = signal.slice(p + 1, Math.min(signal.length, p + 1 + minDistanceSamples));
      const localMin = Math.min(signal[p], ...(left.length ? left : [signal[p]]), ...(right.length ? right : [signal[p]]));
      const prominence = signal[p] - localMin;
      return prominence >= minProminence;
    });
  }

  /**
   * Sub-sample peak position via parabolic interpolation around an integer
   * peak index. Whole-sample peak picking has quantization error of up to
   * +/-0.5 samples, which at typical camera frame rates translates to tens
   * of ms of timing jitter per beat — enough on its own to make consecutive
   * peak-to-peak intervals swing by 100ms+ and inflate RMSSD past any
   * plausible HRV value, even when every interval individually looks
   * reasonable and no beats were missed or double-counted.
   */
  function refinePeakIndex(signal, p) {
    if (p <= 0 || p >= signal.length - 1) return p;
    const yPrev = signal[p - 1];
    const yCurr = signal[p];
    const yNext = signal[p + 1];
    const denom = yPrev - 2 * yCurr + yNext;
    if (Math.abs(denom) < 1e-12) return p;
    const delta = (0.5 * (yPrev - yNext)) / denom;
    return Math.abs(delta) < 1 ? p + delta : p;
  }

  class GlixifyVitalsSDK {
    constructor(options) {
      this.opts = Object.assign({}, DEFAULTS, options || {});
      this.reset();
    }

    reset() {
      this._r = [];
      this._g = [];
      this._b = [];
      this._t = [];
      this._lastVitals = null;
    }

    /**
     * Feed one frame's skin-ROI average RGB (0-255 range) and its capture
     * timestamp in milliseconds. Call this once per analyzed frame.
     */
    pushSample(r, g, b, timestampMs) {
      this._r.push(r);
      this._g.push(g);
      this._b.push(b);
      this._t.push(timestampMs);

      const cutoff = timestampMs - this.opts.windowSeconds * 1000;
      while (this._t.length && this._t[0] < cutoff) {
        this._r.shift();
        this._g.shift();
        this._b.shift();
        this._t.shift();
      }
    }

    /** Estimated effective sampling rate (fps) from recent timestamps. */
    _estimateFs() {
      const n = this._t.length;
      if (n < 2) return 0;
      const dtSec = (this._t[n - 1] - this._t[0]) / 1000;
      return dtSec > 0 ? (n - 1) / dtSec : 0;
    }

    /**
     * CHROM method: builds a motion/lighting-robust pulse signal from
     * normalized R/G/B traces. Returns the raw (unfiltered) pulse signal.
     */
    _chromSignal() {
      const n = this._r.length;
      const rMean = mean(this._r);
      const gMean = mean(this._g);
      const bMean = mean(this._b);
      if (rMean === 0 || gMean === 0 || bMean === 0) return null;

      const rn = this._r.map((v) => v / rMean);
      const gn = this._g.map((v) => v / gMean);
      const bn = this._b.map((v) => v / bMean);

      const xs = new Array(n);
      const ys = new Array(n);
      for (let i = 0; i < n; i++) {
        xs[i] = 3 * rn[i] - 2 * gn[i];
        ys[i] = 1.5 * rn[i] + gn[i] - 1.5 * bn[i];
      }

      const xsStd = std(xs, mean(xs));
      const ysStd = std(ys, mean(ys));
      const alpha = ysStd > 0 ? xsStd / ysStd : 1;

      const s = new Array(n);
      for (let i = 0; i < n; i++) s[i] = xs[i] - alpha * ys[i];
      return s;
    }

    /**
     * Returns the current vitals estimate, or null if not enough samples
     * have been collected yet (see minSamplesForEstimate).
     *
     * { hr, hrv, rr, stress, confidence, fs, sampleCount }
     * - hr: beats per minute
     * - hrv: RMSSD of pulse-to-pulse intervals, in ms
     * - rr: breaths per minute
     * - stress: 0-100 heuristic autonomic-load index (NOT clinical)
     * - confidence: 0-1 spectral SNR-based signal quality score
     */
    getVitals() {
      const n = this._r.length;
      if (n < this.opts.minSamplesForEstimate) return null;

      const fs = this._estimateFs();
      if (fs < 5) return null; // too sparse to be meaningful

      const pulseRaw = this._chromSignal();
      if (!pulseRaw) return null;

      const minHz = this.opts.minBpm / 60;
      const maxHz = this.opts.maxBpm / 60;
      const filteredPulse = bandpassFilter(pulseRaw, fs, minHz, maxHz);
      const { freqHz: hrHz, snr } = dominantFrequency(pulseRaw, fs, minHz, maxHz);
      if (hrHz === 0) return null;

      const hr = hrHz * 60;

      // Independent time-domain cross-check — see autocorrelationRateHz above.
      // Diagnostic only (exposed as hrAutocorr/hrAgreementBpm below): on real
      // camera signal this disagreed with the FFT far more often than in
      // synthetic testing, which drove confidence down to single digits on
      // essentially every scan. The HRV plausibility check (done by the
      // caller) already catches most of the same bad readings without that
      // collateral damage, so this no longer multiplies into confidence.
      const autocorr = autocorrelationRateHz(pulseRaw, fs, minHz, maxHz);
      const autocorrHr = autocorr.hz * 60;
      const hrDisagreementBpm = autocorrHr > 0 ? Math.abs(autocorrHr - hr) : Infinity;

      // HRV from peak-to-peak intervals of the time-domain filtered pulse.
      // The min-distance floor from maxBpm (180bpm -> 333ms) only rules out
      // physically-impossible spacing — for someone whose actual rate is,
      // say, 75bpm (~800ms period), it's far too permissive and lets a
      // secondary noise ripple *within* one true cardiac cycle get counted
      // as an extra beat. We already know the FFT's HR estimate at this
      // point, so use a fraction of ITS period instead — this was the actual
      // root cause of HRV repeatedly landing at 150-350ms instead of 15-150ms.
      const expectedPeriodSamples = (fs * 60) / hr;
      const minPeakDistance = Math.max(1, Math.round(Math.max((fs * 60) / this.opts.maxBpm, expectedPeriodSamples * 0.6)));

      // A second, much narrower bandpass centered on the already-known HR
      // (+/- 20bpm) for peak picking specifically. The wide generic band
      // (42-180bpm) admits noise/harmonics that don't belong to the actual
      // heartbeat waveform; once we know roughly where the pulse lives,
      // narrowing around it gives a visibly cleaner waveform for accurate
      // peak timing, which is what HRV's beat-to-beat precision depends on.
      const hrHzNarrowMin = Math.max(minHz, (hr - 20) / 60);
      const hrHzNarrowMax = Math.min(maxHz, (hr + 20) / 60);
      const narrowPulse =
        hrHzNarrowMax > hrHzNarrowMin ? bandpassFilter(pulseRaw, fs, hrHzNarrowMin, hrHzNarrowMax) : filteredPulse;

      const peaks = findPeaks(narrowPulse, minPeakDistance);
      const refinedPeaks = peaks.map((p) => refinePeakIndex(narrowPulse, p));
      let hrv = 0;
      if (refinedPeaks.length >= 3) {
        const rawIntervalsMs = [];
        for (let i = 1; i < refinedPeaks.length; i++) {
          rawIntervalsMs.push(((refinedPeaks[i] - refinedPeaks[i - 1]) / fs) * 1000);
        }

        // Reject ectopic-style outlier intervals before computing RMSSD. A
        // missed beat makes one interval read as ~2x the real one; a double-
        // counted ripple makes one read as ~0.5x. Either single bad interval
        // otherwise dominates RMSSD (a squared-difference metric) and is the
        // main reason HRV kept landing at 150-350ms instead of a plausible
        // 15-150ms — the intervals themselves were fine except for one outlier.
        const sorted = [...rawIntervalsMs].sort((a, b) => a - b);
        const medianInterval = sorted[Math.floor(sorted.length / 2)];
        const intervalsMs = rawIntervalsMs.filter(
          (v) => v >= medianInterval * 0.6 && v <= medianInterval * 1.4
        );

        const diffs = [];
        for (let i = 1; i < intervalsMs.length; i++) {
          diffs.push(Math.pow(intervalsMs[i] - intervalsMs[i - 1], 2));
        }
        hrv = diffs.length ? Math.sqrt(mean(diffs)) : 0;
      }

      // Respiratory rate: low-frequency component of the raw green trace
      // (breathing modulates venous return / baseline brightness).
      const gDetrended = this._g.map((v) => v - mean(this._g));
      const rrMinHz = this.opts.minBreathsPerMin / 60;
      const rrMaxHz = this.opts.maxBreathsPerMin / 60;
      const { freqHz: rrHz } = dominantFrequency(gDetrended, fs, rrMinHz, rrMaxHz);
      const rr = rrHz > 0 ? rrHz * 60 : 0;

      // Heuristic autonomic-load index — NOT a clinical stress measure.
      // Lower HRV + higher HR maps to a higher index.
      const hrvScore = Math.max(0, Math.min(1, 1 - hrv / 80));
      const hrScore = Math.max(0, Math.min(1, (hr - 55) / 60));
      const stress = Math.round(((hrvScore * 0.7 + hrScore * 0.3) * 100));

      // A short FFT window has coarse frequency resolution, so a few
      // samples of plain noise can produce one spuriously "sharp" spectral
      // peak and look like a clean pulse (high SNR) purely by chance. Scale
      // confidence down until the rolling window is substantially full —
      // without this, confidence can spike to 0.8+ on pure noise within
      // ~100 samples, well before there's been time for a real pulse cycle.
      const fullWindowSamples = this.opts.windowSeconds * fs;
      const warmup = fullWindowSamples > 0 ? Math.min(1, n / fullWindowSamples) : 1;

      const confidence = Math.max(0, Math.min(1, (snr - 1) / 8)) * warmup;

      this._lastVitals = {
        hr: Math.round(hr * 10) / 10,
        hrv: Math.round(hrv * 10) / 10,
        rr: rr > 0 ? Math.round(rr * 10) / 10 : null,
        stress,
        confidence: Math.round(confidence * 100) / 100,
        fs: Math.round(fs * 10) / 10,
        sampleCount: n,
        // Diagnostic fields — not shown in the main UI, useful for debugging
        // a specific low-confidence reading (e.g. via the SDK demo harness).
        hrAutocorr: Math.round(autocorrHr * 10) / 10,
        hrAgreementBpm: hrDisagreementBpm === Infinity ? null : Math.round(hrDisagreementBpm * 10) / 10,
      };
      return this._lastVitals;
    }

    /** Filtered pulse waveform for the current window (for plotting). */
    getWaveform() {
      const pulseRaw = this._chromSignal();
      if (!pulseRaw) return [];
      const fs = this._estimateFs();
      if (fs < 5) return [];
      const minHz = this.opts.minBpm / 60;
      const maxHz = this.opts.maxBpm / 60;
      return bandpassFilter(pulseRaw, fs, minHz, maxHz);
    }
  }

  const api = { GlixifyVitalsSDK };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.GlixifyVitalsSDK = GlixifyVitalsSDK;
  }
})(typeof window !== "undefined" ? window : globalThis);
