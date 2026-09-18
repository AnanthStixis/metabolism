# Glixify Vitals SDK (v0.1)

Open, camera-agnostic rPPG signal processor. Implements the **CHROM** method
(de Haan & Jeanne, 2013) — published research, not a vendor black box — to
derive heart rate, HRV, respiratory rate and a signal-quality score from a
stream of skin-region RGB averages.

**Not clinically validated.** Screening/demo signal only, same disclaimer
posture as the rest of this project — not a medical device, no diagnosis.

## Why it's built this way

The module has **no camera, canvas or face-tracking code**. It only consumes
`{r, g, b, timestampMs}` samples. That keeps the actual signal-processing
core — the part worth reusing — portable:

- **Web**: sample a forehead ROI via MediaPipe FaceMesh + canvas (see `demo.js`)
  and call `pushSample()` every frame.
- **Android/iOS**: a native camera + face-tracking layer (e.g. MediaPipe's
  native SDKs) would compute the same ROI RGB average and could call an
  equivalent port of this algorithm — the CHROM math ports directly to
  Kotlin/Swift since it has no browser dependencies.

## API

```js
const sdk = new GlixifyVitalsSDK({ windowSeconds: 10 });

// Call once per analyzed frame:
sdk.pushSample(rMean, gMean, bMean, performance.now());

// Poll whenever you want a fresh estimate:
const vitals = sdk.getVitals();
// => { hr, hrv, rr, stress, confidence, fs, sampleCount } or null
//    (null until ~3s of samples have accumulated)

// Optional, for plotting:
const waveform = sdk.getWaveform(); // filtered pulse trace, array of numbers
```

### `getVitals()` fields

| Field | Meaning |
|---|---|
| `hr` | Heart rate, beats per minute |
| `hrv` | RMSSD of pulse-to-pulse intervals, in ms |
| `rr` | Respiratory rate, breaths per minute (`null` if not resolvable) |
| `stress` | 0–100 heuristic autonomic-load index — **not a clinical measure** |
| `confidence` | 0–1 spectral SNR-based signal quality — gate your UI on this |
| `fs` | Estimated effective sampling rate (fps) from recent timestamps |
| `sampleCount` | Samples currently in the rolling window |

## Testing it standalone

Open `sdk/demo.html` via the project's static server (`npx serve .` from the
project root, then visit `/sdk/demo.html`). This harness is intentionally
separate from the main app — it exists to validate the SDK's accuracy and
stability on its own before wiring it into `vitals.js`/`app.js`.

## Known limitations (v0.1)

- Single ROI (forehead) — no multi-region fusion yet, which vendors use to
  improve robustness against motion and lighting changes.
- No skin-tone-stratified validation — the CHROM method is published as
  broadly tone-robust, but this implementation hasn't been tested against a
  reference device across Fitzpatrick types.
- Respiratory rate is a simplified low-frequency-component proxy, not a
  chest-motion or Hilbert-envelope-based method — expect lower accuracy than
  the HR estimate.
- No motion-artifact rejection (e.g. detecting when the face is turned/moving
  too much to trust the signal) beyond the confidence score.
