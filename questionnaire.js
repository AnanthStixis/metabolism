/**
 * Rapid metabolic questionnaire — mirrors the sprint brief's 4-6 question set.
 * Produces a simple point-based risk tier, not a clinical score.
 */

const QUESTIONS = [
  {
    id: "age",
    label: "Your age group",
    type: "select",
    options: ["Under 25", "25-34", "35-44", "45-54", "55+"],
    points: [0, 1, 2, 3, 4],
  },
  {
    id: "waist",
    label: "Waist circumference feels above typical for your height",
    type: "select",
    options: ["No", "Somewhat", "Yes"],
    points: [0, 1, 2],
  },
  {
    id: "familyHistory",
    label: "Family history of diabetes",
    type: "select",
    options: ["None", "One parent/sibling", "Multiple relatives"],
    points: [0, 2, 3],
  },
  {
    id: "sleep",
    label: "Average sleep per night",
    type: "select",
    options: ["7-9 hours", "5-6 hours", "Under 5 hours"],
    points: [0, 1, 2],
  },
  {
    id: "activity",
    label: "Physical activity",
    type: "select",
    options: ["Regular (3+ times/week)", "Occasional", "Rarely"],
    points: [0, 1, 2],
  },
  {
    id: "afternoonCrash",
    label: "Afternoon energy crash after meals",
    type: "select",
    options: ["Rarely", "Sometimes", "Almost daily"],
    points: [0, 1, 2],
  },
];

function renderQuestionnaire(container) {
  container.innerHTML = "";
  QUESTIONS.forEach((q) => {
    const row = document.createElement("div");
    row.className = "q-row";
    const label = document.createElement("label");
    label.textContent = q.label;
    label.setAttribute("for", `q-${q.id}`);
    const select = document.createElement("select");
    select.id = `q-${q.id}`;
    select.dataset.qid = q.id;
    q.options.forEach((opt, i) => {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = opt;
      select.appendChild(o);
    });
    row.appendChild(label);
    row.appendChild(select);
    container.appendChild(row);
  });
}

function scoreQuestionnaire(container) {
  let total = 0;
  let max = 0;
  const answers = {};
  QUESTIONS.forEach((q) => {
    const select = container.querySelector(`#q-${q.id}`);
    const idx = select ? Number(select.value) : 0;
    answers[q.id] = q.options[idx];
    total += q.points[idx];
    max += Math.max(...q.points);
  });
  const ratio = max === 0 ? 0 : total / max;
  let tier = "Good";
  if (ratio > 0.6) tier = "High";
  else if (ratio > 0.3) tier = "Moderate";
  return { answers, total, max, tier };
}
