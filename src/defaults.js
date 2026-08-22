// Shipped default settings, kept in their own module so scripts/verify.mjs can pin them
// without pulling in React.

export const defaults = {
  // Analysis framing. "exploratory" makes no confirmatory efficacy claim, so no
  // multiplicity adjustment is applied and the design is justified on PRECISION
  // (confidence interval width) rather than on power to declare significance.
  analysisFraming: "exploratory",
  chartMetric: "precision", // "precision" | "mde" - what the outcome charts plot

  // Design
  designArms: 2,
  // "hybrid" randomizes clinicians to ROM vs no-ROM, then randomizes patients WITHIN
  // no-ROM clinicians to app-only vs TAU. That makes app-only vs TAU a within-clinician
  // comparison, which removes the between-clinician variance from that contrast. Only
  // meaningful for the three-arm design; ignored when designArms is 2.
  randomization: "hybrid",
  treatmentRatio: 3,
  allocA: 1,
  allocB: 1,
  allocC: 1,
  multiplicity: "dunnett",
  // On by default: t with df = clusters - arms is the standard reference distribution for
  // cluster-level inference in a CRT (Hayes & Moulton), and it costs only ~1% on the MDE
  // at 100 clinicians. Erring conservative is the safe direction for a power calculation.
  smallSampleT: true,
  selectedContrast: "AC",
  assumedEffect: 2,

  // Statistical
  power: 0.8,
  // 0.05 under the exploratory framing: with no efficacy claim there is nothing to
  // protect. Raise to 0.025 (Benjamini-Hochberg across outcomes) only if the study
  // becomes confirmatory with several outcomes any one of which could carry the claim.
  alpha: 0.05,

  // Structure
  patientsPerCluster: 10,
  nClinicians: 100,
  // Clinician panel sizes always vary in practice; equal clusters is an optimistic default.
  clusterSizeCV: 0.2,
  controlAttrition: 0.3,

  // Outcomes
  iccHamd: 0.04,
  iccRetention: 0.05,
  r2Hamd: 0.35,
  r2Retention: 0.05,
  survivalEfficiency: 4.0,

  // Measurement model. MFRM is the planned analysis: it takes the Rasch interval-scoring
  // gain AND removes rater variance, cutting HAM-D error variance ~11.7% and the MDE ~6%
  // against a sum score. That gain is contingent on actually fitting the model, and on a
  // rating design that lets rater effects be separated (raters linked across patients).
  // The charts keep a sum-score baseline line so the assumption stays visible.
  measurementModel: "mfrm",
  sumScoreReliability: 0.86,
  raschReliability: 0.91,
  raterVarianceProp: 0.07,

  // Spillover substudy: share of clinicians running a MIXED panel (some patients on the
  // dashboard, some not). 0 disables it, which is the current design. Only meaningful in
  // the three-arm design. The overall arm allocation is invariant to this.
  mixedShare: 0,

  // Fairness / DIF substudy (Aim 2: "fair"). Only AURORA users generate item responses.
  // Share of the sample in the SMALLEST subgroup on the fairness dimension being tested
  // (ethnicity, language, gender, age band) - the smallest group is always the binding
  // constraint on a DIF analysis.
  difSubgroupShare: 0.2,
  // Commonly cited minimum per group for stable Rasch item calibration / MH DIF.
  difThresholdN: 200,
  // 0.43 logits ~ 1.0 ETS delta, the A/B boundary between negligible and moderate DIF.
  difTargetLogits: 0.43,
  // Fisher information ONE respondent contributes about ONE item's location, i.e. the I
  // in Var(b_hat) ~ 1/(n*I). For a dichotomous Rasch item I = p(1-p), so 0.25 is its
  // CEILING (perfect targeting), not a low estimate - a mistargeted item falls below it.
  // It is conservative only relative to HAM-D, whose partial-credit items carry more.
  // This is the highest-leverage assumption in the fairness panel: 0.25 -> 0.6 moves
  // power at 0.43 logits from 46% to 82%. Pin it down from real item parameters.
  difItemInfo: 0.25,

  // ICC substudy
  targetIcc: 0.75,
  expectedIcc: 0.8,
  iccClusterCorr: 0.03,
  nFollowups: 4,
};
