/**
 * Heuristic knowledge base for the Face & Metabolism Insight POC.
 * NOT medically validated — rule-of-thumb mappings inspired by common
 * folk/wellness heuristics (dark circles -> fatigue, pale lips -> low iron, etc).
 */

// Landmark indices from MediaPipe FaceMesh (468-point model).
const REGION_LANDMARKS = {
  foreheadCenter: [10, 151, 9],
  foreheadLeft: [109, 108, 69],
  foreheadRight: [338, 337, 299],
  leftTemple: [127, 234, 71],
  rightTemple: [356, 454, 301],
  leftUnderEye: [145, 153, 154, 155],
  rightUnderEye: [374, 380, 381, 382],
  leftCheek: [50, 101, 118],
  rightCheek: [280, 330, 347],
  nose: [4, 5, 195],
  lips: [13, 14, 61, 291],
  chin: [152, 175, 199],
};

// Landmarks used to estimate head yaw (left/right turn).
const POSE_LANDMARKS = {
  noseTip: 1,
  leftEarProxy: 234, // near left temple/ear
  rightEarProxy: 454, // near right temple/ear
};

// Sample a small square of pixels around each landmark and average.
const SAMPLE_RADIUS_RATIO = 0.012; // relative to canvas width

// Regions whose samples are unreliable when that side of the face is turned away from camera.
const REGION_SIDE = {
  foreheadLeft: "left",
  foreheadRight: "right",
  leftTemple: "left",
  rightTemple: "right",
  leftUnderEye: "left",
  rightUnderEye: "right",
  leftCheek: "left",
  rightCheek: "right",
};

/**
 * Estimate head yaw from nose tip vs. left/right ear-proxy landmarks.
 * Returns { angleLabel, yawScore, visibleSide } where visibleSide is
 * "left" | "right" | "both" (both visible enough on a near-frontal face).
 */
function estimateHeadAngle(landmarks) {
  const nose = landmarks[POSE_LANDMARKS.noseTip];
  const leftEar = landmarks[POSE_LANDMARKS.leftEarProxy];
  const rightEar = landmarks[POSE_LANDMARKS.rightEarProxy];
  if (!nose || !leftEar || !rightEar) {
    return { angleLabel: "Unknown", yawScore: 0, visibleSide: "both" };
  }

  const distLeft = Math.hypot(nose.x - leftEar.x, nose.y - leftEar.y);
  const distRight = Math.hypot(nose.x - rightEar.x, nose.y - rightEar.y);
  const total = distLeft + distRight;
  const yawScore = total === 0 ? 0 : (distRight - distLeft) / total; // -1..1

  // Positive yawScore: nose closer to right ear proxy => face turned so
  // the camera sees more of the LEFT side (viewer's perspective, mirrored feed).
  let angleLabel = "Straight";
  let visibleSide = "both";
  if (yawScore > 0.18) {
    angleLabel = "Turned — showing left side";
    visibleSide = "left";
  } else if (yawScore < -0.18) {
    angleLabel = "Turned — showing right side";
    visibleSide = "right";
  }

  return { angleLabel, yawScore, visibleSide };
}

function evaluateFindings(stats, visibleSide = "both") {
  const findings = [];

  // Helper: pick the reliable value for a bilateral pair given which side is visible.
  const bilateral = (leftVal, rightVal) => {
    if (visibleSide === "left") return leftVal;
    if (visibleSide === "right") return rightVal;
    return (leftVal + rightVal) / 2;
  };

  const baselineBrightness = bilateral(stats.leftCheek.brightness, stats.rightCheek.brightness);
  const baselineSaturation = bilateral(stats.leftCheek.saturation, stats.rightCheek.saturation);

  // 1. Dark circles under eyes
  const underEyeBrightness = bilateral(stats.leftUnderEye.brightness, stats.rightUnderEye.brightness);
  const darkCircleDelta = baselineBrightness - underEyeBrightness;
  if (darkCircleDelta > 18) {
    findings.push({
      title: "Under-eye dark circles",
      severity: darkCircleDelta > 32 ? "high" : "medium",
      region: "Under-eye",
      description: `Under-eye skin is noticeably darker than cheek tone (Δbrightness ≈ ${darkCircleDelta.toFixed(1)}).`,
      remedy:
        "Often linked to poor sleep, dehydration, or low iron. Try: 7-8h consistent sleep, more water, iron-rich foods (spinach, lentils). See a doctor if it persists despite good sleep.",
    });
  }

  // 2. Temple hollowness / shading (visible mainly on frontal or slight turn)
  const templeBrightness = bilateral(stats.leftTemple.brightness, stats.rightTemple.brightness);
  const templeDelta = baselineBrightness - templeBrightness;
  if (templeDelta > 14) {
    findings.push({
      title: "Temple shading / hollowness",
      severity: templeDelta > 26 ? "medium" : "low",
      region: "Temple",
      description: `Temple area appears darker/more sunken than cheek tone (Δbrightness ≈ ${templeDelta.toFixed(1)}).`,
      remedy:
        "Sometimes associated with tension, eye strain, or fatigue in wellness heuristics. Try: reduce screen time strain, stay hydrated, light temple massage, adequate rest.",
    });
  }

  // 3. Forehead pigmentation / dark patches
  const foreheadSamples = [stats.foreheadCenter.brightness];
  if (visibleSide !== "right") foreheadSamples.push(stats.foreheadLeft.brightness);
  if (visibleSide !== "left") foreheadSamples.push(stats.foreheadRight.brightness);
  const foreheadAvgBrightness = foreheadSamples.reduce((a, b) => a + b, 0) / foreheadSamples.length;
  const foreheadVariance = Math.max(...foreheadSamples.map((v) => Math.abs(v - foreheadAvgBrightness)));
  if (foreheadVariance > 14 || foreheadAvgBrightness < baselineBrightness - 15) {
    findings.push({
      title: "Forehead discoloration / patches",
      severity: foreheadVariance > 24 ? "high" : "medium",
      region: "Forehead",
      description: `Uneven or darker patches detected on the forehead (variance ≈ ${foreheadVariance.toFixed(1)}).`,
      remedy:
        "Can relate to sun exposure, stress, or hormonal changes in some wellness traditions. Try: daily SPF, hydration, stress management. Consult a dermatologist for persistent pigmentation.",
    });
  }

  // 3. Pale lips (possible low iron / circulation)
  if (stats.lips.saturation < baselineSaturation - 12 && stats.lips.brightness > baselineBrightness - 5) {
    findings.push({
      title: "Pale lips",
      severity: "medium",
      region: "Lips",
      description: `Lip color is desaturated compared to skin tone (Δsaturation ≈ ${(baselineSaturation - stats.lips.saturation).toFixed(1)}).`,
      remedy:
        "May relate to low iron or poor circulation. Try: iron/vitamin C rich meals, light exercise for circulation. Get a blood test if fatigue also present.",
    });
  }

  // 4. Yellowish tint (dehydration / metabolic stress heuristic)
  const cheekYellowness = bilateral(stats.leftCheek.yellowness, stats.rightCheek.yellowness);
  const avgYellowness = (stats.foreheadCenter.yellowness + cheekYellowness) / 2;
  if (avgYellowness > 28) {
    findings.push({
      title: "Yellowish skin undertone",
      severity: avgYellowness > 38 ? "high" : "low",
      region: "Overall face",
      description: `Detected elevated yellow undertone (index ≈ ${avgYellowness.toFixed(1)}).`,
      remedy:
        "Traditionally associated with dehydration or sluggish metabolism/liver load. Try: more water, less processed/fried food, whole fruits & vegetables. If skin/eyes look distinctly yellow, seek medical advice promptly.",
    });
  }

  // 5. Redness / flushed cheeks & nose
  const cheekRedness = bilateral(stats.leftCheek.redness, stats.rightCheek.redness);
  const avgRedness = (cheekRedness + stats.nose.redness) / 2;
  if (avgRedness > 22) {
    findings.push({
      title: "Facial redness / flushing",
      severity: avgRedness > 32 ? "medium" : "low",
      region: "Cheeks & nose",
      description: `Elevated redness detected on cheeks/nose (index ≈ ${avgRedness.toFixed(1)}).`,
      remedy:
        "Could relate to heat, spicy food, alcohol, or mild inflammation. Try: reduce spicy/alcohol intake, stay cool & hydrated. Consult a doctor if redness is persistent or with visible blood vessels.",
    });
  }

  // 6. Overall dullness (low saturation across the board = possible fatigue/dehydration)
  const overallSaturation = (baselineSaturation + stats.foreheadCenter.saturation + stats.chin.saturation) / 3;
  if (overallSaturation < 22) {
    findings.push({
      title: "Overall skin dullness",
      severity: "low",
      region: "Overall face",
      description: `Low color vibrancy detected across face (saturation ≈ ${overallSaturation.toFixed(1)}).`,
      remedy:
        "Often tied to dehydration, poor sleep or nutrient gaps. Try: hydration, balanced diet with fruits/vegetables, consistent sleep schedule.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      title: "No notable patterns detected",
      severity: "low",
      region: "Overall face",
      description: "Skin tone across sampled regions looks fairly even and within typical ranges for this heuristic model.",
      remedy: "Keep up healthy hydration, sleep, and nutrition habits.",
    });
  }

  return findings;
}
