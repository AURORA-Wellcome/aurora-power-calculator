// Inputs for the Aim 2.2 responsiveness-interview panel: the HAM-D interviews held when
// the AURORA algorithm reports a change (triggered, for PPV) and at random (audits, for
// the miss rate). The panel computes counts, precision, load and cost in closed form, so
// the generated R can reproduce them. What it cannot compute is how the algorithm
// behaves - how often it triggers at a threshold, how often an audit finds it negative,
// and how often it is right - so those come from the simulation below.
//
// They rest on a stand-in algorithm (an EWMA of AI-COA every second day) and trajectories
// not yet calibrated to pilot data. Treat them as presets: regenerate them when AURORA's
// real trigger rule and pilot data arrive, rather than tuning them here.
//
//   cd simulations && python aurora_responsiveness_interview_sim.py --presets --reps 200 \
//     --rater-sem 2.5 1.8 1.5
//
// Output kept in simulations/aurora_responsiveness_presets_2026-10-26.json, where the
// keys 2.5, 1.8 and 1.5 are the single, double and consensus columns below.

export const INTERVIEW_PRESETS_SOURCE =
  "simulations/aurora_responsiveness_interview_sim.py --presets (700 app users, 200 trials, seed 20261022, interview the day after the trigger)";

// Per threshold, in HAM-D points:
//   triggerRequests  triggered interviews requested per participant who stays enrolled
//                    for all 16 weeks (at most one per four-week interval)
//   meanTriggerDay   mean day of those requests; triggers come early in follow-up, so
//                    dropout removes fewer of them than of the evenly spread audits
//   negativeShare    share of completed audits the algorithm scores negative
//   sameDay/pastWeek the two HAM-D models that bound the truth: the HAM-D reflects the
//                    interview day, or the mean of the past seven days
//     missTrue/missObserved  miss rate among negative audits, true and as scored
//     ppvTrue/ppvObserved    share of triggers followed by a change of >= 3 points in
//                            the flagged direction, true and as scored
export const INTERVIEW_PRESETS = {
  3: {
    triggerRequests: 2.332,
    meanTriggerDay: 49.1,
    negativeShare: 0.741,
    sameDay: {
      missTrue: 0.242,
      missObserved: { single: 0.493, double: 0.407, consensus: 0.366 },
      ppvTrue: 0.389,
      ppvObserved: { single: 0.438, double: 0.424, consensus: 0.416 },
    },
    pastWeek: {
      missTrue: 0.103,
      missObserved: { single: 0.45, double: 0.336, consensus: 0.282 },
      ppvTrue: 0.272,
      ppvObserved: { single: 0.398, double: 0.37, consensus: 0.354 },
    },
  },
  4: {
    triggerRequests: 1.464,
    meanTriggerDay: 46.2,
    negativeShare: 0.854,
    sameDay: {
      missTrue: 0.134,
      missObserved: { single: 0.369, double: 0.28, consensus: 0.242 },
      ppvTrue: 0.475,
      ppvObserved: { single: 0.488, double: 0.485, consensus: 0.483 },
    },
    pastWeek: {
      missTrue: 0.046,
      missObserved: { single: 0.322, double: 0.212, consensus: 0.166 },
      ppvTrue: 0.388,
      ppvObserved: { single: 0.455, double: 0.442, consensus: 0.433 },
    },
  },
  5: {
    triggerRequests: 0.858,
    meanTriggerDay: 42.3,
    negativeShare: 0.92,
    sameDay: {
      missTrue: 0.07,
      missObserved: { single: 0.264, double: 0.181, consensus: 0.149 },
      ppvTrue: 0.564,
      ppvObserved: { single: 0.541, double: 0.547, consensus: 0.551 },
    },
    pastWeek: {
      missTrue: 0.022,
      missObserved: { single: 0.222, double: 0.127, consensus: 0.091 },
      ppvTrue: 0.508,
      ppvObserved: { single: 0.509, double: 0.51, consensus: 0.51 },
    },
  },
  7: {
    triggerRequests: 0.263,
    meanTriggerDay: 33.9,
    negativeShare: 0.978,
    sameDay: {
      missTrue: 0.017,
      missObserved: { single: 0.123, double: 0.068, consensus: 0.05 },
      ppvTrue: 0.735,
      ppvObserved: { single: 0.646, double: 0.676, consensus: 0.688 },
    },
    pastWeek: {
      missTrue: 0.004,
      missObserved: { single: 0.092, double: 0.039, consensus: 0.024 },
      ppvTrue: 0.719,
      ppvObserved: { single: 0.619, double: 0.648, consensus: 0.662 },
    },
  },
};

export const TRIGGER_THRESHOLDS = [3, 4, 5, 7];
export const HAMD_MODELS = ["sameDay", "pastWeek"];

// How each extra interview is scored: by the interviewing rater alone (SEM 2.5 HAM-D
// points, inter-rater ICC about 0.85), or by the interviewer plus one or two raters
// scoring the recording, averaged. One and three raters' SEMs (2.5, 1.5) imply error
// variance of about 0.25 shared by all raters plus 6.0 that averages out, so two raters
// give sqrt(0.25 + 6/2) = 1.8. These are the simulation's three cases; the SEM itself is
// not an input here.
export const SCORING = {
  single: { raters: 1, sem: 2.5, label: "One rater" },
  double: { raters: 2, sem: 1.8, label: "Two raters" },
  consensus: { raters: 3, sem: 1.5, label: "Three raters" },
};

// Follow-up schedule (protocol v1): scheduled HAM-Ds on days 0, 28, 56, 84 and 112.
// Audits fall on days 7-111 but never within 3 days of a scheduled HAM-D, one drawn
// uniformly in each of k equal strata of those days.
export const FOLLOW_UP_DAYS = 112;
export const SCHEDULED_DAYS = [0, 28, 56, 84, 112];
export const AUDIT_DAYS = (() => {
  const days = [];
  for (let d = 7; d <= 111; d++) {
    if (SCHEDULED_DAYS.every((s) => Math.abs(s - d) > 3)) days.push(d);
  }
  return days;
})();
// One triggered interview per four-week interval at most.
export const TRIGGER_CAP = SCHEDULED_DAYS.length - 1;

// Time of one extra interview: the GenAI check-in, PHQ-9 and GRID-HAM-D package the
// scheduled assessments use. GRID-HAM-D takes 15-30 minutes; the rest are planning
// estimates.
export const RATER_MINUTES = 40; // interview, scheduling and notes
export const EXTRA_RATER_MINUTES = 25; // each additional rater scoring the recording
export const PATIENT_MINUTES = 45;

// Protocol v1's scheduled interviews (MINI, then GRID-HAM-D and HAM-A five times) take
// 140-255 minutes per patient (measurement burden table).
export const SCHEDULED_IE_MINUTES = [140, 255];

// Rates, assessment hours paid per patient, and per-site cost factors come from the
// application budget, which is internal. budget.js serves public placeholders unless the
// build finds src/budget.local.js; see the README's "Budget figures" section.
export {
  BUDGET_IS_ILLUSTRATIVE,
  BUDGET_SOURCE,
  RATER_RATE,
  PATIENT_RATE,
  BUDGETED_ASSESSMENT_HOURS,
  SITE_COSTING,
} from "./budget.js";
