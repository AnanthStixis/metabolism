/**
 * Combines vitals + questionnaire + skin findings into the Metabolic Snapshot
 * shown at the end of the flow. Heuristic demo output only — not a diagnosis.
 */

function classifySkinSignal(findingsByAngle) {
  const all = Object.values(findingsByAngle).filter(Boolean).flat();
  if (all.length === 0) {
    return { label: "No signal captured", detail: "Skin scan did not complete for any angle." };
  }
  const highSeverity = all.filter((f) => f.severity === "high");
  const pigmentationFlag = all.find(
    (f) => f.title.toLowerCase().includes("discoloration") || f.title.toLowerCase().includes("pigment")
  );
  if (pigmentationFlag) {
    return {
      label: "Pigmentation signal detected",
      detail:
        "Forehead/jawline discoloration pattern flagged — a placeholder for acanthosis-associated neck pigmentation detection, which needs a dedicated model (see feasibility scope). Not a diagnosis.",
    };
  }
  if (highSeverity.length > 0) {
    return {
      label: "Notable signal detected",
      detail: highSeverity.map((f) => f.title).join(", "),
    };
  }
  return { label: "No notable pattern", detail: "Skin tone across sampled regions looked even." };
}

function severityToClass(label) {
  if (label === "Good" || label === "No notable pattern") return "good";
  if (label === "Moderate" || label === "Notable signal detected" || label === "Pigmentation signal detected")
    return "moderate";
  if (label === "Not resolved" || label === "No signal captured") return "";
  return "risk";
}

function renderSnapshot(container, { vitals, questionnaire, findingsByAngle }) {
  const cardio = classifyCardiovascular(vitals);
  const recovery = classifyRecovery(vitals);
  const respiratory = classifyRespiratory(vitals);
  const skin = classifySkinSignal(findingsByAngle);

  const rows = [
    { title: "Cardiovascular Signal", value: cardio, sub: `HR ≈ ${vitals.hr.toFixed(0)} bpm · HRV ≈ ${vitals.hrv.toFixed(0)} ms` },
    { title: "Recovery Signal", value: recovery, sub: `Stress index ≈ ${vitals.stress.toFixed(0)}/100` },
    { title: "Respiratory Signal", value: respiratory, sub: vitals.rr ? `RR ≈ ${vitals.rr.toFixed(0)} breaths/min` : "RR signal not resolved" },
    { title: "Metabolic Risk Signal", value: questionnaire.tier, sub: `Questionnaire score ${questionnaire.total}/${questionnaire.max}` },
    { title: "Skin/Metabolic Signal", value: skin.label, sub: skin.detail },
  ];

  container.innerHTML = `
    <h2>Your Glixify Metabolic Snapshot</h2>
    <div class="snapshot-grid">
      ${rows
        .map(
          (r) => `
        <div class="snapshot-card ${severityToClass(r.value)}">
          <div class="snapshot-title">${r.title}</div>
          <div class="snapshot-value">${r.value}</div>
          <div class="snapshot-sub">${r.sub}</div>
        </div>`
        )
        .join("")}
    </div>
    <p class="snapshot-disclaimer">
      This is a screening signal from a demo model, not a medical measurement or diagnosis.
      Consult a doctor for clinical evaluation.
    </p>
    <div class="snapshot-cta">
      <p>Your face gives us a signal. Your glucose data tells us the story.</p>
      <button id="startAssessmentBtn">Start your Glixify Metabolic Assessment</button>
    </div>
  `;
}
