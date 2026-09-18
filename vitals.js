/**
 * Vitals classification helpers. The actual HR/HRV/RR/stress numbers now
 * come from the live GlixifyVitalsSDK (see sdk/glixify-vitals-sdk.js) —
 * this file just maps those readings to the Good/Moderate/Needs attention
 * labels shown in the UI.
 */

function classifyCardiovascular(vitals) {
  if (vitals.hr <= 90 && vitals.hrv >= 45) return "Good";
  if (vitals.hr <= 100 && vitals.hrv >= 25) return "Moderate";
  return "Needs attention";
}

function classifyRecovery(vitals) {
  if (vitals.hrv >= 55 && vitals.stress <= 40) return "Good";
  if (vitals.hrv >= 30 && vitals.stress <= 65) return "Moderate";
  return "Needs attention";
}

function classifyRespiratory(vitals) {
  if (!vitals.rr) return "Not resolved";
  if (vitals.rr >= 12 && vitals.rr <= 18) return "Good";
  if (vitals.rr >= 10 && vitals.rr <= 22) return "Moderate";
  return "Needs attention";
}
