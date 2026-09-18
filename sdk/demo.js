/**
 * Standalone test harness for glixify-vitals-sdk.js.
 * Samples a forehead ROI via MediaPipe FaceMesh and feeds the SDK — kept
 * separate from the main app so the SDK can be validated on its own first.
 */

const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const startBtn = document.getElementById("startBtn");
const logEl = document.getElementById("log");
const waveformCanvas = document.getElementById("waveform");

const mHr = document.getElementById("mHr");
const mHrv = document.getElementById("mHrv");
const mRr = document.getElementById("mRr");
const mStress = document.getElementById("mStress");
const mConf = document.getElementById("mConf");
const mFs = document.getElementById("mFs");

// Forehead landmark indices (MediaPipe FaceMesh 468-point model).
const FOREHEAD_INDICES = [10, 151, 9, 108, 337, 69, 299, 108, 151];

const sdk = new GlixifyVitalsSDK({ windowSeconds: 10 });
const workCanvas = document.createElement("canvas");

let faceMesh = null;
let camera = null;

function log(msg) {
  logEl.textContent = `${new Date().toLocaleTimeString()}  ${msg}\n` + logEl.textContent.split("\n").slice(0, 8).join("\n");
}

async function start() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 480, height: 360, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  overlay.width = video.videoWidth || 480;
  overlay.height = video.videoHeight || 360;
  workCanvas.width = video.videoWidth || 480;
  workCanvas.height = video.videoHeight || 360;

  faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  });
  faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
  faceMesh.onResults(onResults);

  camera = new Camera(video, {
    onFrame: async () => faceMesh.send({ image: video }),
    width: 480,
    height: 360,
  });
  camera.start();

  startBtn.disabled = true;
  startBtn.textContent = "Running...";
  log("Camera started. Sampling forehead ROI.");
  requestAnimationFrame(renderLoop);
}

function onResults(results) {
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) return;
  const landmarks = results.multiFaceLandmarks[0];

  const w = workCanvas.width;
  const h = workCanvas.height;
  const wctx = workCanvas.getContext("2d");
  wctx.drawImage(video, 0, 0, w, h);

  let xs = FOREHEAD_INDICES.map((i) => landmarks[i].x * w);
  let ys = FOREHEAD_INDICES.map((i) => landmarks[i].y * h);
  const x0 = Math.max(0, Math.min(...xs) - 8);
  const x1 = Math.min(w, Math.max(...xs) + 8);
  const y0 = Math.max(0, Math.min(...ys) - 8);
  const y1 = Math.min(h, Math.max(...ys) + 8);
  const rw = Math.max(1, x1 - x0);
  const rh = Math.max(1, y1 - y0);

  const data = wctx.getImageData(x0, y0, rw, rh).data;
  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    rSum += data[i];
    gSum += data[i + 1];
    bSum += data[i + 2];
    count++;
  }
  if (count === 0) return;

  sdk.pushSample(rSum / count, gSum / count, bSum / count, performance.now());

  ctx.strokeStyle = "rgba(124,158,255,0.8)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, rw, rh);
}

function renderLoop() {
  const vitals = sdk.getVitals();
  if (vitals) {
    mHr.textContent = `${vitals.hr} bpm`;
    mHrv.textContent = `${vitals.hrv} ms`;
    mRr.textContent = vitals.rr ? `${vitals.rr} /min` : "–";
    mStress.textContent = `${vitals.stress}/100`;
    mConf.textContent = `${Math.round(vitals.confidence * 100)}%`;
    mFs.textContent = `${vitals.fs} fps`;
    drawWaveform();
  }
  requestAnimationFrame(renderLoop);
}

function drawWaveform() {
  const wave = sdk.getWaveform();
  const ctx = waveformCanvas.getContext("2d");
  waveformCanvas.width = waveformCanvas.clientWidth;
  waveformCanvas.height = waveformCanvas.clientHeight;
  const w = waveformCanvas.width;
  const h = waveformCanvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!wave.length) return;

  const min = Math.min(...wave);
  const max = Math.max(...wave);
  const range = max - min || 1;

  ctx.strokeStyle = "#5fd487";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  wave.forEach((v, i) => {
    const x = (i / (wave.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

startBtn.addEventListener("click", () => {
  start().catch((err) => {
    console.error(err);
    log("Camera error: " + err.message);
  });
});
