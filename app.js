const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const workCanvas = document.getElementById("workCanvas");
const startBtn = document.getElementById("startBtn");
const captureBtn = document.getElementById("captureBtn");
const rescanBtn = document.getElementById("rescanBtn");
const statusEl = document.getElementById("status");
const statusRowEl = document.getElementById("statusRow");
const resultsPanel = document.getElementById("resultsPanel");
const liveDot = document.getElementById("liveDot");
const findingsContainer = document.getElementById("findingsContainer");
const resultsTabsEl = document.getElementById("resultsTabs");
const toQuestionnaireBtn = document.getElementById("toQuestionnaireBtn");
const toSnapshotBtn = document.getElementById("toSnapshotBtn");
const vitalsReadout = document.getElementById("vitalsReadout");
const questionnaireForm = document.getElementById("questionnaireForm");
const snapshotContainer = document.getElementById("snapshotContainer");

const vitalsSdk = new GlixifyVitalsSDK({ windowSeconds: 10 });
const MIN_VITALS_CONFIDENCE = 0.55;
const MIN_SCAN_MS = 6000; // don't finish before the SDK has a real window to analyze (counts only tracked, still time)
const MAX_SCAN_MS = 30000; // hard wall-clock timeout, counts even while the face is lost
const FACE_LOST_TIMEOUT_MS = 2000; // how long a lost face is tolerated before the buffer is discarded
const ALIGN_STABLE_MS = 800; // how long the user must sit well-framed + still before the countdown starts
const COUNTDOWN_MS = 3000; // "get ready" countdown before real sampling begins
const MOTION_PAUSE_THRESHOLD = 0.035; // normalized face-center movement/frame that counts as "not still"
const ANGLE_HOLD_MS = 700; // how long a turned angle must be held before its capture starts
const ANGLE_CAPTURE_MS = 2000; // how long each side's skin capture runs once turned correctly
const ANGLE_PROMPT_TIMEOUT_MS = 15000; // give up on a side (skip it) if it's never achieved
const LIGHTING_CHECK_INTERVAL_MS = 250; // throttle pixel sampling during align — no need to check every frame
const LIGHTING_MIN_BRIGHTNESS = 28; // HSV "v" (0-100) below this is too dark for reliable RGB-based skin/pulse readings
const LIGHTING_MAX_BRIGHTNESS = 88; // above this the sensor is likely clipping (glare/overexposure), color info is lost
const LIGHTING_MAX_IMBALANCE = 16; // left-vs-right cheek brightness delta beyond this means one side is shadowed —
// that directly corrupts the bilateral comparisons rules.js relies on (dark circles, redness, etc. all compare L vs R)
// Physiologically implausible HRV (RMSSD) values are a strong tell that the
// "pulse" the FFT locked onto is motion/lighting noise, not a real heartbeat.
const HRV_PLAUSIBLE_MIN = 5;
const HRV_PLAUSIBLE_MAX = 150;

let lastVitals = null;
let finalFindings = null;
// Kept as {straight, left, right} for compatibility with snapshot.js — this
// simplified single-pass scan only ever populates "straight".
const findingsByAngle = { straight: null, left: null, right: null };

// Multi-region ROI for rPPG sampling (MediaPipe FaceMesh 468-point model).
// Forehead + both cheeks, fused together — independent per-region pixel
// noise (compression, micro-motion, local shadow) averages out across the
// three separated regions while the true pulse signal, which is correlated
// across the whole face, does not. Standard practice in the rPPG literature,
// and a real accuracy lever (vs. our earlier single-forehead-ROI approach).
const VITALS_ROI_REGIONS = [
  [10, 151, 9, 108, 337, 69, 299], // forehead
  [50, 101, 118], // left cheek
  [280, 330, 347], // right cheek
];
// A small landmark set spanning forehead-top, chin, and both cheekbones —
// cheap to read every frame for a face bounding circle (vs. all 468 points).
const FACE_BOUNDS_INDICES = [10, 152, 234, 454];

let faceMesh = null;
let camera = null;
let cameraStream = null;
let lastLandmarks = null;
let liveRunning = false;
let scanPhase = "idle"; // idle | align | countdown | scanning
let scanStartTs = 0;
let countdownStartTs = 0;
let alignedSinceTs = 0;
let lastLightingCheckTs = 0;
let cachedLightingIssue = null;
let prevBoundsCenter = null; // {x, y} normalized, for frame-to-frame motion detection
let faceTrackedMs = 0; // accumulates only while a face is detected AND held still
let lastFrameTs = 0;
let faceLostSinceTs = 0; // 0 while tracked; set the moment the face is lost
let currentConfidence = 0;
let currentVitals = null;
let currentTip = "Hold still…";
let scanProgress = 0;
const EMA_ALPHA = 0.35;
let smoothedStats = null;
let angleSmoothedStats = null; // per-side skin stats, reset at the start of each side's capture
let angleHoldStartTs = 0;
let angleCaptureStartTs = 0;
let anglePromptStartTs = 0;
const ANALYSIS_INTERVAL_MS = 400; // throttle heavier skin-stats + confidence re-checks
let lastAnalysisTs = 0;

function setStatus(text) {
  statusEl.textContent = text;
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    cameraStream = stream;
    video.srcObject = stream;
    await video.play();

    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 480;
    workCanvas.width = video.videoWidth || 640;
    workCanvas.height = video.videoHeight || 480;

    setupFaceMesh();
    startTrackingLoop();

    captureBtn.disabled = false;
    startBtn.disabled = true;
    setStatus("Camera ready. Click Start Scan and hold still.");
  } catch (err) {
    console.error(err);
    setStatus("Camera access failed: " + err.message);
  }
}

function setupFaceMesh() {
  faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  faceMesh.onResults(onFaceMeshResults);
}

/** Runs continuously once the camera is on, independent of the scan window. */
function startTrackingLoop() {
  liveRunning = true;
  camera = new Camera(video, {
    onFrame: async () => {
      if (!liveRunning) return;
      await faceMesh.send({ image: video });
    },
    width: 640,
    height: 480,
  });
  camera.start();
}

function stopTrackingLoop() {
  liveRunning = false;
  if (camera) camera.stop();
  if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
  liveDot.classList.remove("on");
}

/** Entry point from the Start Scan / Rescan buttons — begins the align-then-countdown-then-scan sequence. */
function beginAlign() {
  scanPhase = "align";
  alignedSinceTs = 0;
  prevBoundsCenter = null;
  findingsByAngle.straight = null;
  findingsByAngle.left = null;
  findingsByAngle.right = null;
  angleSmoothedStats = null;
  activeResultsTab = "straight";
  captureBtn.disabled = true;
  toQuestionnaireBtn.disabled = true;
  rescanBtn.hidden = true;
  resultsPanel.hidden = true;
  statusRowEl.classList.add("coaching");
  setStatus("Align your face within the guide…");
}

/** Called automatically once the countdown finishes — starts real sampling. */
function beginScan() {
  scanPhase = "scanning";
  scanStartTs = performance.now();
  lastFrameTs = scanStartTs;
  faceTrackedMs = 0;
  faceLostSinceTs = 0;
  prevBoundsCenter = null;
  vitalsSdk.reset();
  smoothedStats = null;
  currentConfidence = 0;
  currentVitals = null;
  currentTip = "Hold still…";
  scanProgress = 0;
  setStatus("Scanning — hold still…");
}

/** Straight-phase failure/timeout path — the rPPG signal never became usable. */
function finishScan(timedOut) {
  scanPhase = "idle";
  clearOverlay();
  statusRowEl.classList.remove("coaching");

  const vitals = vitalsSdk.getVitals();
  lastVitals = vitals;

  const findings = smoothedStats ? evaluateFindings(smoothedStats, "both") : null;
  finalFindings = findings;
  findingsByAngle.straight = findings;

  const rawConfidence = vitals ? vitals.confidence : 0;
  const vitalsReady = rawConfidence >= MIN_VITALS_CONFIDENCE && hrvIsUsable(vitals);
  const suggestion = vitalsReady ? null : lowConfidenceSuggestion(vitals);

  renderFrozenResults(vitals, findingsByAngle, rawConfidence, suggestion);
  resultsPanel.hidden = false;
  captureBtn.disabled = false;
  captureBtn.textContent = "Start Scan";

  if (vitalsReady) {
    // Straight signal came good right at the timeout boundary — still worth
    // continuing to the left/right skin capture rather than discarding it.
    beginTurnPrompt("left");
  } else {
    setStatus(`Signal wasn't reliable — ${suggestion} Tap Rescan to try again.`);
    toQuestionnaireBtn.disabled = true;
    rescanBtn.hidden = false;
  }
}

/** Called once the straight-phase rPPG signal is genuinely good — freezes it and starts the left-side prompt. */
function proceedToAngleCapture() {
  lastVitals = vitalsSdk.getVitals();
  findingsByAngle.straight = smoothedStats ? evaluateFindings(smoothedStats, "both") : null;
  beginTurnPrompt("left");
}

function beginTurnPrompt(side) {
  scanPhase = `turn-${side}`;
  anglePromptStartTs = performance.now();
  angleHoldStartTs = 0;
  angleSmoothedStats = null;
  clearOverlay();
  setStatus(`Turn your head to show your ${side.toUpperCase()} side…`);
}

function beginAngleCapture(side) {
  scanPhase = `capture-${side}`;
  angleCaptureStartTs = performance.now();
  angleSmoothedStats = null;
  setStatus(`Hold — capturing your ${side} side…`);
}

/** All three angles are done (or skipped via timeout) — assemble and show the final results. */
function finalizeResults() {
  scanPhase = "idle";
  clearOverlay();
  statusRowEl.classList.remove("coaching");

  const rawConfidence = lastVitals ? lastVitals.confidence : 0;
  renderFrozenResults(lastVitals, findingsByAngle, rawConfidence, null);
  resultsPanel.hidden = false;
  captureBtn.disabled = false;
  captureBtn.textContent = "Start Scan";
  setStatus("Scan complete.");
  toQuestionnaireBtn.disabled = false;
  rescanBtn.hidden = true;
}

/**
 * Picks the most useful rescan suggestion once a scan has ended without a
 * usable signal — framing tips from the live coaching if they're still the
 * likely culprit, otherwise a reason tied to what actually failed.
 */
function lowConfidenceSuggestion(vitals) {
  if (currentTip && !currentTip.startsWith("signal locked") && !currentTip.startsWith("almost there")) {
    return currentTip.charAt(0).toUpperCase() + currentTip.slice(1);
  }
  if (!vitals) {
    return "No signal was captured — check the camera can see your face clearly.";
  }
  if (vitals.hrv > 0 && (vitals.hrv < HRV_PLAUSIBLE_MIN || vitals.hrv > HRV_PLAUSIBLE_MAX)) {
    return "The signal looked noisy — hold your head still and face a steady light source, not a window or flickering light.";
  }
  if (vitals.hrv === 0) {
    return "Not enough clean heartbeats were detected — hold still a little longer next time.";
  }
  return "Try again with steadier framing and more even, direct light on your face.";
}

/** True only when the SDK found enough real pulse peaks (hrv > 0) AND that HRV is physiologically plausible. */
function hrvIsUsable(vitals) {
  if (!vitals || !(vitals.hrv > 0)) return false;
  return vitals.hrv >= HRV_PLAUSIBLE_MIN && vitals.hrv <= HRV_PLAUSIBLE_MAX;
}

const ANGLE_LABELS = { straight: "Straight", left: "Left side", right: "Right side" };

/** Renders one angle's findings into the container — called on load and on tab switch. */
function renderResultsTab(angleKey) {
  if (!resultsFindingsByAngle || !resultsFindingsByAngle[angleKey]) return;
  findingsContainer.innerHTML = "";
  resultsFindingsByAngle[angleKey].forEach((f) => {
    const card = document.createElement("div");
    card.className = `finding-card severity-${f.severity}`;
    card.innerHTML = `
      <div class="finding-title">${f.title}</div>
      <div class="finding-meta">${f.region} · severity: ${f.severity}</div>
      <div class="finding-remedy">${f.description}<br/><strong>Suggestion:</strong> ${f.remedy}</div>
    `;
    findingsContainer.appendChild(card);
  });
}

function switchResultsTab(angleKey) {
  activeResultsTab = angleKey;
  resultsTabsEl.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.angle === angleKey);
  });
  renderResultsTab(angleKey);
}

let resultsFindingsByAngle = null;
let activeResultsTab = "straight";

function renderFrozenResults(vitals, findingsByAngleObj, adjustedConfidence, suggestion) {
  const angleKeys = ["straight", "left", "right"].filter((k) => findingsByAngleObj && findingsByAngleObj[k]);
  resultsFindingsByAngle = findingsByAngleObj;

  if (angleKeys.length === 0) {
    resultsTabsEl.hidden = true;
    findingsContainer.innerHTML = `<div class="empty-state">No face detected for long enough to analyze. Try rescanning.</div>`;
  } else {
    resultsTabsEl.hidden = angleKeys.length <= 1; // no point showing tabs for a single angle
    resultsTabsEl.querySelectorAll(".tab-btn").forEach((btn) => {
      const key = btn.dataset.angle;
      const has = angleKeys.includes(key);
      btn.hidden = !has;
      btn.classList.toggle("active", has && key === activeResultsTab);
    });
    activeResultsTab = angleKeys.includes(activeResultsTab) ? activeResultsTab : angleKeys[0];
    renderResultsTab(activeResultsTab);
  }

  if (!vitals) {
    vitalsReadout.innerHTML = suggestion
      ? `<div class="vitals-title">Vitals (rPPG)</div><div class="vitals-row"><span>Not enough signal captured</span></div><div class="vitals-flag">${suggestion}</div>`
      : `<div class="vitals-title">Vitals (rPPG)</div><div class="vitals-row"><span>Not enough signal captured</span></div>`;
    return;
  }

  const implausible = vitals.hrv > 0 && (vitals.hrv < HRV_PLAUSIBLE_MIN || vitals.hrv > HRV_PLAUSIBLE_MAX);
  let flag = "";
  if (implausible) {
    flag = `<div class="vitals-flag">HRV outside a plausible range — likely motion/noise, not a real pulse. Reading discarded.${suggestion ? ` <strong>Suggestion:</strong> ${suggestion}` : ""}</div>`;
  } else if (suggestion) {
    flag = `<div class="vitals-flag"><strong>Suggestion:</strong> ${suggestion}</div>`;
  }

  vitalsReadout.innerHTML = `
    <div class="vitals-title">Vitals (rPPG · confidence ${Math.round(adjustedConfidence * 100)}%)</div>
    <div class="vitals-row">
      <span>HR ${vitals.hr.toFixed(0)} bpm</span>
      <span>HRV ${vitals.hrv.toFixed(0)} ms</span>
      <span>RR ${vitals.rr ? vitals.rr.toFixed(0) : "–"} /min</span>
      <span>Stress ${vitals.stress.toFixed(0)}/100</span>
    </div>
    ${flag}
  `;
}

/** Samples the forehead ROI on the current frame and feeds the vitals SDK. */
/**
 * Averages one region's pixels, skipping near-saturated (specular glare) and
 * near-black (shadow/hair) pixels — both are non-physiological contamination
 * of the ROI signal rather than real skin reflectance.
 */
function sampleRoiRegion(ctx, landmarks, indices, w, h) {
  const xs = indices.map((i) => landmarks[i].x * w);
  const ys = indices.map((i) => landmarks[i].y * h);
  const x0 = Math.max(0, Math.min(...xs) - 8);
  const x1 = Math.min(w, Math.max(...xs) + 8);
  const y0 = Math.max(0, Math.min(...ys) - 8);
  const y1 = Math.min(h, Math.max(...ys) + 8);
  const rw = Math.max(1, x1 - x0);
  const rh = Math.max(1, y1 - y0);

  const data = ctx.getImageData(x0, y0, rw, rh).data;
  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    if (maxC >= 250 || maxC <= 8) continue; // specular glare or near-black — skip
    rSum += r;
    gSum += g;
    bSum += b;
    count++;
  }
  if (count === 0) return null;
  return { r: rSum / count, g: gSum / count, b: bSum / count, count };
}

function sampleVitalsFrame(landmarks) {
  const w = workCanvas.width;
  const h = workCanvas.height;
  const ctx = workCanvas.getContext("2d");
  ctx.drawImage(video, 0, 0, w, h);

  let rTotal = 0, gTotal = 0, bTotal = 0, weightTotal = 0;
  for (const indices of VITALS_ROI_REGIONS) {
    const region = sampleRoiRegion(ctx, landmarks, indices, w, h);
    if (!region) continue;
    // Weight by pixel count so a larger region (e.g. forehead) doesn't get
    // diluted to the same influence as a small one.
    rTotal += region.r * region.count;
    gTotal += region.g * region.count;
    bTotal += region.b * region.count;
    weightTotal += region.count;
  }
  if (weightTotal === 0) return;

  vitalsSdk.pushSample(rTotal / weightTotal, gTotal / weightTotal, bTotal / weightTotal, performance.now());
}

function onFaceMeshResults(results) {
  const now = performance.now();
  const faceFound = results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0;

  if (!faceFound) {
    lastLandmarks = null;
    liveDot.classList.remove("on");
    prevBoundsCenter = null;

    if (scanPhase === "idle") {
      setStatus("No face detected. Center your face in frame with good lighting.");
      return;
    }

    if (scanPhase === "align" || scanPhase === "countdown") {
      scanPhase = "align";
      alignedSinceTs = 0;
      clearOverlay();
      setStatus("No face detected — align your face within the guide.");
      return;
    }

    if (scanPhase.startsWith("turn-") || scanPhase.startsWith("capture-")) {
      const side = scanPhase.split("-")[1];
      angleHoldStartTs = 0;
      // Mid-capture loss drops back to prompting rather than discarding the
      // whole scan — only that one side needs to be redone.
      scanPhase = `turn-${side}`;
      clearOverlay();
      setStatus(`No face detected — turn to show your ${side} side.`);
      return;
    }

    // scanPhase === "scanning": freeze progress, stop feeding the SDK, and
    // tell the user plainly — don't let the scan silently finish on stale samples.
    if (!faceLostSinceTs) faceLostSinceTs = now;
    currentTip = "face not detected — move back into frame.";
    clearOverlay();
    setStatus(`Scanning paused — ${currentTip}`);

    // If the face has been gone too long, whatever's buffered is stale —
    // discard it so a resumed scan starts from a clean signal.
    if (now - faceLostSinceTs > FACE_LOST_TIMEOUT_MS) {
      vitalsSdk.reset();
      smoothedStats = null;
      faceTrackedMs = 0;
      scanProgress = 0;
      currentConfidence = 0;
    }

    if (now - scanStartTs >= MAX_SCAN_MS) finishScan(true);
    lastFrameTs = now;
    return;
  }

  lastLandmarks = results.multiFaceLandmarks[0];
  liveDot.classList.add("on");

  if (scanPhase === "idle") return;

  if (scanPhase === "align" || scanPhase === "countdown") {
    handleAlignmentFrame(lastLandmarks, now);
    return;
  }

  if (scanPhase === "turn-left" || scanPhase === "turn-right") {
    handleAnglePromptFrame(lastLandmarks, now, scanPhase.slice(5));
    return;
  }

  if (scanPhase === "capture-left" || scanPhase === "capture-right") {
    handleAngleCaptureFrame(lastLandmarks, now, scanPhase.slice(8));
    return;
  }

  // scanPhase === "scanning"
  faceLostSinceTs = 0;

  const bounds = getFaceBoundsCenter(lastLandmarks);
  const motion = prevBoundsCenter ? distance(bounds, prevBoundsCenter) : 0;
  prevBoundsCenter = bounds;
  const isStillEnough = motion < MOTION_PAUSE_THRESHOLD;

  // Only count time and feed the SDK while genuinely still — a moving face
  // produces motion-artifact samples that would just contaminate the signal,
  // so this is a real fix, not just a text hint, for "how do I get higher confidence."
  if (isStillEnough) {
    faceTrackedMs += now - lastFrameTs;
    sampleVitalsFrame(lastLandmarks); // unthrottled — rPPG needs a steady per-frame sample rate
  } else {
    currentTip = "hold very still — motion detected.";
  }
  lastFrameTs = now;

  // Heavier work (pixel-region sampling, FFT-based confidence, coaching
  // logic) is throttled — running it every frame isn't necessary and costs CPU.
  if (isStillEnough && now - lastAnalysisTs >= ANALYSIS_INTERVAL_MS) {
    lastAnalysisTs = now;

    const rawStats = computeRegionStats(lastLandmarks);
    smoothedStats = emaMerge(smoothedStats, rawStats);

    const vitals = vitalsSdk.getVitals();
    // The displayed/progress confidence is the SDK's raw spectral-SNR value —
    // it ramps up smoothly as the window fills with real signal. HRV
    // plausibility is checked SEPARATELY (see hrvIsUsable) because the SDK
    // reports hrv:0 while it simply hasn't found 3 pulse peaks yet, which is
    // "still gathering," not "noise" — conflating the two caused confidence
    // to sit hard-pinned at 0% and then jump the instant peaks appeared.
    currentConfidence = vitals ? vitals.confidence : 0;
    currentVitals = vitals;
    currentTip = computeCoachingTip(lastLandmarks, currentConfidence, rawStats);
  }

  // Progress reflects whichever gate is the current bottleneck — confidence,
  // the minimum-sampling-time floor, or HRV becoming computable — not just
  // confidence alone. Showing 100% only once ALL three are actually met
  // means finishScan fires within one tick of the bar reaching 100%, instead
  // of confidence alone hitting the threshold early and then appearing to
  // hang while the still-pending time floor / HRV catch up.
  const timeProgress = Math.min(1, faceTrackedMs / MIN_SCAN_MS);
  const confProgress = Math.min(1, currentConfidence / MIN_VITALS_CONFIDENCE);
  // Partial credit once HRV is at least computed (peaks found), even if not
  // yet in the plausible range — otherwise this gate looks binary/stalled.
  const hrvProgress = hrvIsUsable(currentVitals) ? 1 : currentVitals && currentVitals.hrv > 0 ? 0.85 : 0.4;
  const targetProgress = Math.min(timeProgress, confProgress, hrvProgress);

  // Monotonic on purpose: a real climb-then-dip is rare enough that a
  // backwards-moving bar would just read as broken. Only ever move up, smoothed.
  if (targetProgress > scanProgress) {
    scanProgress += (targetProgress - scanProgress) * 0.3;
  }
  drawFaceScanOverlay(lastLandmarks, scanProgress, now);
  setStatus(`Scanning — ${currentTip}`);

  const signalReady =
    faceTrackedMs >= MIN_SCAN_MS && currentConfidence >= MIN_VITALS_CONFIDENCE && hrvIsUsable(currentVitals);
  const timedOut = now - scanStartTs >= MAX_SCAN_MS;
  if (signalReady) {
    proceedToAngleCapture();
  } else if (timedOut) {
    finishScan(true);
  }
}

/** Drives the pre-scan align → countdown sequence, drawing the fixed positioning guide. */
function handleAlignmentFrame(landmarks, now) {
  const framingIssue = getFramingIssue(landmarks);
  // Lighting is real pixel work (getImageData), so it's throttled like the
  // in-scan analysis pass — but it still has to gate "aligned" here, before
  // scanning starts, since bad light corrupts every downstream measurement
  // (rPPG signal AND the skin-finding brightness/color comparisons).
  if (now - lastLightingCheckTs >= LIGHTING_CHECK_INTERVAL_MS) {
    lastLightingCheckTs = now;
    cachedLightingIssue = getLightingIssue(landmarks);
  }
  const issue = framingIssue || cachedLightingIssue;

  const bounds = getFaceBoundsCenter(landmarks);
  const motion = prevBoundsCenter ? distance(bounds, prevBoundsCenter) : 0;
  prevBoundsCenter = bounds;
  const isStill = motion < MOTION_PAUSE_THRESHOLD;
  const aligned = !issue && isStill;

  if (aligned) {
    if (!alignedSinceTs) alignedSinceTs = now;
  } else {
    alignedSinceTs = 0;
    if (scanPhase === "countdown") scanPhase = "align"; // moved/drifted mid-countdown — restart it
  }

  if (scanPhase === "align" && aligned && now - alignedSinceTs >= ALIGN_STABLE_MS) {
    scanPhase = "countdown";
    countdownStartTs = now;
  }

  if (scanPhase === "countdown") {
    const remainingMs = COUNTDOWN_MS - (now - countdownStartTs);
    if (remainingMs <= 0) {
      beginScan();
      return;
    }
    drawAlignmentGuide(landmarks, true, Math.ceil(remainingMs / 1000));
    setStatus("Hold still…");
  } else {
    drawAlignmentGuide(landmarks, aligned, null);
    setStatus(aligned ? "Aligned — hold still…" : issue ? `Align your face — ${issue}` : "Hold still to begin…");
  }
}

/** Waits for the user to turn to the requested side and hold it, then hands off to capture. */
function handleAnglePromptFrame(landmarks, now, side) {
  const angleInfo = estimateHeadAngle(landmarks);
  const matches = angleInfo.visibleSide === side;

  if (matches) {
    if (!angleHoldStartTs) angleHoldStartTs = now;
  } else {
    angleHoldStartTs = 0;
  }

  if (matches && now - angleHoldStartTs >= ANGLE_HOLD_MS) {
    beginAngleCapture(side);
    return;
  }

  clearOverlay();
  setStatus(matches ? `Hold — capturing your ${side} side…` : `Turn your head to show your ${side.toUpperCase()} side.`);

  if (now - anglePromptStartTs >= ANGLE_PROMPT_TIMEOUT_MS) {
    // Couldn't get this angle in a reasonable time — skip it rather than
    // stall the whole scan indefinitely; findingsByAngle[side] stays null.
    if (side === "left") {
      beginTurnPrompt("right");
    } else {
      finalizeResults();
    }
  }
}

/** Accumulates skin-region stats for the current side while the angle is held, then moves on. */
function handleAngleCaptureFrame(landmarks, now, side) {
  const angleInfo = estimateHeadAngle(landmarks);
  if (angleInfo.visibleSide !== side) {
    beginTurnPrompt(side); // drifted out of position mid-capture — go back to prompting
    return;
  }

  const rawStats = computeRegionStats(landmarks);
  angleSmoothedStats = emaMerge(angleSmoothedStats, rawStats);

  const elapsed = now - angleCaptureStartTs;
  const progress = Math.min(1, elapsed / ANGLE_CAPTURE_MS);
  drawFaceScanOverlay(landmarks, progress, now);

  if (elapsed >= ANGLE_CAPTURE_MS) {
    findingsByAngle[side] = angleSmoothedStats ? evaluateFindings(angleSmoothedStats, side) : null;
    if (side === "left") {
      beginTurnPrompt("right");
    } else {
      finalizeResults();
    }
  }
}

/**
 * Returns a lighting-fix tip if the frame is too dark, blown out (glare/
 * backlight), or lit unevenly left-to-right, else null. All three degrade
 * accuracy in ways framing checks can't catch: too dark/bright starves or
 * clips the RGB signal the rPPG SDK and skin-tone comparisons both depend
 * on, and left/right imbalance directly biases the bilateral skin-finding
 * comparisons in rules.js (dark circles, temple shading, redness) since
 * those compare one side's brightness against a same-photo baseline.
 */
function getLightingIssue(landmarks) {
  const w = workCanvas.width;
  const h = workCanvas.height;
  const ctx = workCanvas.getContext("2d");
  ctx.drawImage(video, 0, 0, w, h);

  const left = sampleRegion(ctx, landmarks, REGION_LANDMARKS.leftCheek, w, h);
  const right = sampleRegion(ctx, landmarks, REGION_LANDMARKS.rightCheek, w, h);
  const forehead = sampleRegion(ctx, landmarks, REGION_LANDMARKS.foreheadCenter, w, h);
  const avgBrightness = (left.brightness + right.brightness + forehead.brightness) / 3;
  const imbalance = Math.abs(left.brightness - right.brightness);

  if (avgBrightness < LIGHTING_MIN_BRIGHTNESS) return "too dark — move to brighter, even lighting.";
  if (avgBrightness > LIGHTING_MAX_BRIGHTNESS) return "too bright — reduce glare or step out of direct light.";
  if (imbalance > LIGHTING_MAX_IMBALANCE) return "uneven lighting — face your light source directly.";
  return null;
}

/** Returns a framing-fix tip if the face is too far/close/off-center, else null. */
function getFramingIssue(landmarks) {
  const w = overlay.width;
  const h = overlay.height;
  const xs = FACE_BOUNDS_INDICES.map((i) => landmarks[i].x * w);
  const ys = FACE_BOUNDS_INDICES.map((i) => landmarks[i].y * h);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const widthRatio = (maxX - minX) / w;
  const cx = (minX + maxX) / 2 / w;
  const cy = (minY + maxY) / 2 / h;

  if (widthRatio < 0.22) return "move a little closer to the camera.";
  if (widthRatio > 0.8) return "move back slightly.";
  if (Math.abs(cx - 0.5) > 0.18 || Math.abs(cy - 0.5) > 0.18) return "center your face in the frame.";
  return null;
}

/** Normalized (0-1) center of the face bounding box, for frame-to-frame motion detection. */
function getFaceBoundsCenter(landmarks) {
  const w = overlay.width;
  const h = overlay.height;
  const xs = FACE_BOUNDS_INDICES.map((i) => landmarks[i].x * w);
  const ys = FACE_BOUNDS_INDICES.map((i) => landmarks[i].y * h);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2 / w,
    y: (Math.min(...ys) + Math.max(...ys)) / 2 / h,
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Real-time coaching based on what's actually limiting signal quality:
 * framing (too far/close/off-center) first, since those are fixable in
 * one glance, then signal confidence once framing looks fine.
 */
function computeCoachingTip(landmarks, confidence, rawStats) {
  const framingIssue = getFramingIssue(landmarks);
  if (framingIssue) return framingIssue;
  if (rawStats) {
    const avgBrightness = (rawStats.leftCheek.brightness + rawStats.rightCheek.brightness + rawStats.foreheadCenter.brightness) / 3;
    const imbalance = Math.abs(rawStats.leftCheek.brightness - rawStats.rightCheek.brightness);
    if (avgBrightness < LIGHTING_MIN_BRIGHTNESS) return "too dark — move to brighter, even lighting.";
    if (avgBrightness > LIGHTING_MAX_BRIGHTNESS) return "too bright — reduce glare or step out of direct light.";
    if (imbalance > LIGHTING_MAX_IMBALANCE) return "uneven lighting — face your light source directly.";
  }
  if (confidence < MIN_VITALS_CONFIDENCE * 0.4) return "hold still, in even light.";
  if (confidence < MIN_VITALS_CONFIDENCE) return "almost there — keep holding steady.";
  // Confidence is already good at this point — if we're still not finishing,
  // it's because HRV (which needs several real heartbeat peaks, not just a
  // clean spectrum) hasn't resolved yet. Say so, instead of a generic
  // "finishing up" that then appears to stall for a few more seconds.
  if (!hrvIsUsable(currentVitals)) return "measuring heartbeat rhythm — a few more seconds.";
  return "signal locked, finishing up.";
}

const SWEEP_LOOP_MS = 1800; // continuous scanner-beam animation, independent of actual progress

/** Draws one L-shaped viewfinder corner at (x, y) opening toward (dx, dy). */
function drawCorner(ctx, x, y, dx, dy, len) {
  ctx.beginPath();
  ctx.moveTo(x, y + dy * len);
  ctx.lineTo(x, y);
  ctx.lineTo(x + dx * len, y);
  ctx.stroke();
}

/**
 * Fixed-position (not face-tracking) target oval the user aligns into before
 * scanning starts, plus a live dot showing their current face position, and
 * an optional big countdown number once they've held it steady.
 */
function drawAlignmentGuide(landmarks, aligned, countdownSeconds) {
  const ctx = overlay.getContext("2d");
  const w = overlay.width;
  const h = overlay.height;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const rx = w * 0.22;
  const ry = h * 0.34;
  const color = aligned ? "rgba(0, 225, 255, 0.95)" : "rgba(255, 255, 255, 0.5)";

  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Live marker showing the user's current face position relative to the target.
  const faceCenter = getFaceBoundsCenter(landmarks);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(faceCenter.x * w, faceCenter.y * h, 5, 0, Math.PI * 2);
  ctx.fill();

  if (countdownSeconds !== null) {
    ctx.font = "700 52px 'IBM Plex Mono', monospace";
    ctx.fillStyle = "#eef1ff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(countdownSeconds), cx, cy);
  }

  ctx.font = "600 12px 'IBM Plex Mono', monospace";
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(aligned ? "HOLD STILL" : "ALIGN FACE HERE", cx, Math.min(cy + ry + 26, h - 8));
}

/**
 * Biometric-scanner visual: a viewfinder-style bracket frame around the
 * face, a looping sweep line, and the real confidence-based percentage +
 * "ANALYZING" readout.
 */
function drawFaceScanOverlay(landmarks, progress, nowTs) {
  const ctx = overlay.getContext("2d");
  const w = overlay.width;
  const h = overlay.height;
  ctx.clearRect(0, 0, w, h);

  const boundsXs = FACE_BOUNDS_INDICES.map((i) => landmarks[i].x * w);
  const boundsYs = FACE_BOUNDS_INDICES.map((i) => landmarks[i].y * h);
  const minX = Math.min(...boundsXs), maxX = Math.max(...boundsXs);
  const minY = Math.min(...boundsYs), maxY = Math.max(...boundsYs);
  const pad = (maxX - minX) * 0.18;
  const fx0 = minX - pad, fx1 = maxX + pad;
  const fy0 = minY - pad * 1.3, fy1 = maxY + pad * 0.7;

  const accent = "rgba(0, 225, 255, 0.95)"; // vivid electric cyan — reads clearly against any video feed

  // Viewfinder corner brackets around the face.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.shadowColor = "rgba(0, 225, 255, 0.55)";
  ctx.shadowBlur = 6;
  const cornerLen = (fx1 - fx0) * 0.14;
  drawCorner(ctx, fx0, fy0, 1, 1, cornerLen);
  drawCorner(ctx, fx1, fy0, -1, 1, cornerLen);
  drawCorner(ctx, fx0, fy1, 1, -1, cornerLen);
  drawCorner(ctx, fx1, fy1, -1, -1, cornerLen);
  ctx.shadowBlur = 0;

  // Looping horizontal sweep line inside the frame — a "scanning" cue,
  // independent of the real (confidence-driven) percentage shown below.
  const loopT = (nowTs % SWEEP_LOOP_MS) / SWEEP_LOOP_MS;
  const beamY = fy0 + loopT * (fy1 - fy0);
  const gradient = ctx.createLinearGradient(fx0, 0, fx1, 0);
  gradient.addColorStop(0, "rgba(0, 225, 255, 0)");
  gradient.addColorStop(0.5, "rgba(0, 225, 255, 0.9)");
  gradient.addColorStop(1, "rgba(0, 225, 255, 0)");
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(fx0, beamY);
  ctx.lineTo(fx1, beamY);
  ctx.stroke();

  // Readout text, styled like a scanner HUD.
  ctx.font = "600 10px 'IBM Plex Mono', monospace";
  ctx.fillStyle = accent;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("ANALYZING DATA", fx0, Math.min(fy1 + 18, h - 8));

  const pct = `${Math.round(progress * 100)}%`;
  ctx.font = "700 20px 'IBM Plex Mono', monospace";
  ctx.textAlign = "right";
  ctx.fillText(pct, fx1, Math.min(fy1 + 20, h - 8));
}

function clearOverlay() {
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
}

function rgbToHsvAndMetrics(r, g, b) {
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const delta = max - min;
  const v = max * 100;
  const s = max === 0 ? 0 : (delta / max) * 100;
  const yellowness = (r + g) / 2 - b;
  const redness = r - (g + b) / 2;
  return { brightness: v, saturation: s, yellowness, redness };
}

function sampleRegion(ctx, landmarks, indices, canvasW, canvasH) {
  const radius = Math.max(2, Math.round(canvasW * 0.012));
  let rSum = 0, gSum = 0, bSum = 0, count = 0;

  indices.forEach((idx) => {
    const lm = landmarks[idx];
    if (!lm) return;
    const cx = Math.round(lm.x * canvasW);
    const cy = Math.round(lm.y * canvasH);
    const x0 = Math.max(0, cx - radius);
    const y0 = Math.max(0, cy - radius);
    const w = Math.min(canvasW - x0, radius * 2);
    const h = Math.min(canvasH - y0, radius * 2);
    if (w <= 0 || h <= 0) return;
    const data = ctx.getImageData(x0, y0, w, h).data;
    for (let i = 0; i < data.length; i += 4) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
      count++;
    }
  });

  if (count === 0) return { brightness: 0, saturation: 0, yellowness: 0, redness: 0 };
  return rgbToHsvAndMetrics(rSum / count, gSum / count, bSum / count);
}

function computeRegionStats(landmarks) {
  const w = workCanvas.width;
  const h = workCanvas.height;
  const ctx = workCanvas.getContext("2d");
  ctx.drawImage(video, 0, 0, w, h);

  const stats = {};
  for (const [name, indices] of Object.entries(REGION_LANDMARKS)) {
    stats[name] = sampleRegion(ctx, landmarks, indices, w, h);
  }
  return stats;
}

function emaMerge(prev, next) {
  if (!prev) return next;
  const merged = {};
  for (const region of Object.keys(next)) {
    merged[region] = {};
    for (const metric of Object.keys(next[region])) {
      const prevVal = prev[region] ? prev[region][metric] : next[region][metric];
      merged[region][metric] = prevVal * (1 - EMA_ALPHA) + next[region][metric] * EMA_ALPHA;
    }
  }
  return merged;
}

function showStep(stepId) {
  document.querySelectorAll(".step").forEach((s) => (s.hidden = s.id !== stepId));
  document.querySelectorAll(".stepper-item").forEach((p) => {
    p.classList.toggle("active", stepId === `step-${p.dataset.step}`);
  });
}

startBtn.addEventListener("click", startCamera);
captureBtn.addEventListener("click", beginAlign);
rescanBtn.addEventListener("click", beginAlign);
resultsTabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (btn && !btn.hidden) switchResultsTab(btn.dataset.angle);
});

toQuestionnaireBtn.addEventListener("click", () => {
  stopTrackingLoop();
  renderQuestionnaire(questionnaireForm);
  showStep("step-questionnaire");
});

toSnapshotBtn.addEventListener("click", () => {
  const questionnaire = scoreQuestionnaire(questionnaireForm);
  const vitals = lastVitals || { hr: 0, hrv: 0, rr: 0, stress: 0, confidence: 0 };
  renderSnapshot(snapshotContainer, { vitals, questionnaire, findingsByAngle });
  showStep("step-snapshot");

  const ctaBtn = document.getElementById("startAssessmentBtn");
  if (ctaBtn) {
    ctaBtn.addEventListener("click", () => {
      alert("This would hand off into the Glixify Band + CGM assessment journey.");
    });
  }
});
