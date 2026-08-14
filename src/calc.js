// Power calculations for the AURORA trial, split out from the UI so the maths can be
// exercised directly from Node (see scripts/verify.mjs) instead of only through the browser.
//
// Supports a two-arm cluster-randomized design (the original) and a three-arm design:
//   A = clinician + patient use of AURORA
//   B = patient-only use
//   C = usual-care control
// All arms are randomized at the clinician (cluster) level, so every contrast carries the
// full clustering design effect.

// ---------------------------------------------------------------------------
// Normal distribution
// ---------------------------------------------------------------------------

// Hart (1968) rational approximation. Accurate to roughly 1e-15 across the range.
export function normCdf(x) {
  const z = Math.abs(x);
  let p;
  if (z > 37) {
    p = 0;
  } else {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      p = (e * n) / d;
    } else {
      const f = z + 1 / (z + 2 / (z + 3 / (z + 4 / (z + 0.65))));
      p = e / (f * 2.506628274631);
    }
  }
  return x > 0 ? 1 - p : p;
}

function normPdf(x) {
  return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
}

// Acklam's inverse normal CDF, refined by one Halley step.
// Replaces the hardcoded z lookup tables the calculator used to carry, so alpha and
// power are no longer restricted to a handful of tabulated values.
export function normInv(p) {
  if (p <= 0 || p >= 1)
    throw new Error(`normInv: p must be in (0,1), got ${p}`);

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let x;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  // Halley refinement to full double precision.
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

// Student-t quantile via the Cornish-Fisher expansion around the normal quantile.
// Only used for the optional small-sample correction, where df is always >= ~50,
// well inside the range where this expansion is accurate.
export function tQuantile(p, df) {
  if (!(df > 0) || !isFinite(df)) return normInv(p);
  const z = normInv(p);
  const z2 = z * z;
  const z3 = z2 * z;
  const z5 = z3 * z2;
  const z7 = z5 * z2;
  return (
    z +
    (z3 + z) / (4 * df) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * df * df) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df * df * df)
  );
}

// ---------------------------------------------------------------------------
// Dunnett's two-sided critical value
// ---------------------------------------------------------------------------

// For k active arms of size n_i sharing a control of size n_0, the test statistics are
// equicorrelated through the shared control with rho_ij = lambda_i * lambda_j, where
// lambda_i = sqrt(n_i / (n_i + n_0)). That product form makes the joint probability a
// single integral over the control's sampling error:
//
//   P(all |T_i| < c) = INT phi(y) PROD_i [ Phi((c + lam_i y)/s_i) - Phi((-c + lam_i y)/s_i) ] dy
//
// with s_i = sqrt(1 - lambda_i^2). Parameterising by lambda (rather than assuming a common
// rho) means unequal allocation is handled correctly, not just 1:1:1.
export function dunnettProb(c, lambdas) {
  const lo = -8;
  const hi = 8;
  const n = 800; // even, for Simpson's rule
  const h = (hi - lo) / n;

  const s = lambdas.map((lam) => Math.sqrt(1 - lam * lam));

  const f = (y) => {
    let v = normPdf(y);
    for (let i = 0; i < lambdas.length; i++) {
      const lam = lambdas[i];
      v *= normCdf((c + lam * y) / s[i]) - normCdf((-c + lam * y) / s[i]);
    }
    return v;
  };

  let sum = f(lo) + f(hi);
  for (let i = 1; i < n; i++) {
    sum += f(lo + i * h) * (i % 2 === 0 ? 2 : 4);
  }
  return (sum * h) / 3;
}

export function dunnettCrit(lambdas, alpha) {
  if (lambdas.length === 0) return normInv(1 - alpha / 2);
  // A single comparison has no multiplicity to correct, and the integral form degenerates,
  // so short-circuit to the plain two-sided normal quantile.
  if (lambdas.length === 1) return normInv(1 - alpha / 2);

  const target = 1 - alpha;
  let lo = 0.5;
  let hi = 8;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (dunnettProb(mid, lambdas) < target) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Cluster allocation
// ---------------------------------------------------------------------------

// Largest-remainder apportionment: the per-arm counts always sum exactly to the total.
// 100 clinicians across 1:1:1 becomes 34/33/33, not three rounded 33.3s.
// Ties in the fractional part are broken in favour of the earlier arm, which reproduces
// the old two-arm `Math.round(nClusters * proportion)` behaviour exactly.
export function allocateClusters(total, weights) {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) return weights.map(() => 0);

  const exact = weights.map((w) => (total * w) / sumW);
  const counts = exact.map(Math.floor);
  let remaining = total - counts.reduce((a, b) => a + b, 0);

  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((x, y) => y.frac - x.frac); // stable: equal fractions keep arm order

  for (let k = 0; remaining > 0; k++, remaining--) {
    counts[order[k % order.length].i] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Arms and contrasts
// ---------------------------------------------------------------------------

export const ARM_LABELS = {
  A3: "Clinician + Patient",
  B3: "Patient-only",
  C3: "Control",
  A2: "Treatment",
  C2: "Control",
};

export function buildArms(s) {
  if (s.designArms === 3) {
    return [
      { key: "A", label: ARM_LABELS.A3, short: "Clin+Pt", weight: s.allocA },
      { key: "B", label: ARM_LABELS.B3, short: "Pt-only", weight: s.allocB },
      { key: "C", label: ARM_LABELS.C3, short: "Control", weight: s.allocC },
    ];
  }
  return [
    { key: "A", label: ARM_LABELS.A2, short: "Tx", weight: s.treatmentRatio },
    { key: "C", label: ARM_LABELS.C2, short: "Ctrl", weight: 1 },
  ];
}

export function buildContrasts(s) {
  if (s.designArms === 3) {
    return [
      {
        id: "AC",
        a: "A",
        b: "C",
        label: "Clinician+Patient vs Control",
        short: "A vs C",
        primary: true,
        family: "dunnett", // active vs shared control
      },
      {
        id: "BC",
        a: "B",
        b: "C",
        label: "Patient-only vs Control",
        short: "B vs C",
        primary: false,
        family: "dunnett",
      },
      {
        id: "AB",
        a: "A",
        b: "B",
        label: "Incremental value of clinician involvement",
        short: "A vs B",
        primary: false,
        family: "exploratory", // no shared control, so outside the Dunnett family
      },
    ];
  }
  return [
    {
      id: "AC",
      a: "A",
      b: "C",
      label: "Treatment vs Control",
      short: "Tx vs Ctrl",
      primary: true,
      family: "single",
    },
  ];
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const SIGMA_HAMD = 7;
const IPCW_VIF = 1.2;
const REPEATED_MEASURES_GAIN = 1.43;

export function createModel(s) {
  const arms = buildArms(s);
  const contrasts = buildContrasts(s);
  const armIndex = Object.fromEntries(arms.map((a, i) => [a.key, i]));

  // --- critical values -----------------------------------------------------

  // lambda_i for the active-vs-control family. Attrition is applied uniformly across
  // arms, so the allocation weights are proportional to the analysed sample sizes and
  // give the same lambda as the completer counts would.
  const controlW = arms[arms.length - 1].weight;
  const activeLambdas = arms
    .slice(0, -1)
    .map((a) => Math.sqrt(a.weight / (a.weight + controlW)));

  const nPairwise = contrasts.length;
  const zUnadjusted = normInv(1 - s.alpha / 2);
  const zBonferroni = normInv(1 - s.alpha / (2 * nPairwise));
  const zDunnett =
    arms.length === 2 ? zUnadjusted : dunnettCrit(activeLambdas, s.alpha);

  // Degrees of freedom for cluster-level inference: clusters minus arms.
  const dfFor = (totalN) =>
    Math.round(totalN / s.patientsPerCluster) - arms.length;

  function critInfo(contrast, totalN) {
    let z;
    let method;
    if (s.analysisFraming === "exploratory") {
      // An exploratory study makes no confirmatory efficacy claim, so there is no
      // family-wise error rate to protect and no multiplicity adjustment is applied.
      // Note this only affects testing quantities: the confidence interval WIDTH is
      // crit * SE, so dropping the adjustment narrows the interval, but the underlying
      // standard error - the thing that actually determines precision - is untouched.
      z = zUnadjusted;
      method = "exploratory, unadjusted";
    } else if (arms.length === 2 || s.multiplicity === "none") {
      z = zUnadjusted;
      method = arms.length === 2 ? "unadjusted" : "none";
    } else if (s.multiplicity === "bonferroni") {
      z = zBonferroni;
      method = `Bonferroni (m=${nPairwise})`;
    } else {
      // Dunnett strategy: the two active-vs-control tests form the corrected family.
      // A vs B shares no control arm, so it sits outside that family and is reported
      // unadjusted and flagged exploratory rather than silently borrowing the Dunnett value.
      if (contrast.family === "dunnett") {
        z = zDunnett;
        method = `Dunnett (k=${activeLambdas.length})`;
      } else {
        z = zUnadjusted;
        method = "exploratory, unadjusted";
      }
    }

    if (s.smallSampleT) {
      const df = dfFor(totalN);
      if (df > 2) {
        // Re-derive the tail probability this z implies, then take the t quantile at
        // the same tail. Keeps whichever multiplicity adjustment was chosen intact.
        //
        // APPROXIMATION: for the Dunnett value this substitutes a univariate t for what
        // should strictly be Dunnett's multivariate-t quantile. It is slightly
        // conservative and the gap is small at the df this design produces (97 at 100
        // clinicians across 3 arms), but it is not the exact Dunnett-t critical value.
        // The effect is minor at the design point (<2%) and grows toward the small end
        // of the sweep (~5% at 40 clusters), which is where it matters most.
        z = tQuantile(normCdf(z), df);
        method += `, t(${df})`;
      }
    }
    return { z, method };
  }

  const zBeta = normInv(s.power);

  // --- measurement model ---------------------------------------------------

  const useRasch =
    s.measurementModel === "rasch" || s.measurementModel === "mfrm";
  const useMFRM = s.measurementModel === "mfrm";

  let measurementVarianceMultiplier = 1.0;
  if (useRasch) {
    const sumScoreError = 1 - s.sumScoreReliability;
    const raschError = 1 - s.raschReliability;
    const errorReduction = (sumScoreError - raschError) / sumScoreError;
    measurementVarianceMultiplier *= 1 - errorReduction * sumScoreError;
  }
  if (useMFRM) {
    measurementVarianceMultiplier *= 1 - s.raterVarianceProp;
  }

  // --- allocation ----------------------------------------------------------

  function allocation(totalN) {
    const nClusters = Math.round(totalN / s.patientsPerCluster);
    const clusters = allocateClusters(
      nClusters,
      arms.map((a) => a.weight),
    );
    const randomized = clusters.map((c) => c * s.patientsPerCluster);
    const completers = randomized.map((n) => n * (1 - s.controlAttrition));
    return { nClusters, clusters, randomized, completers, arms };
  }

  function pairOf(alloc, contrast, field) {
    return [
      alloc[field][armIndex[contrast.a]],
      alloc[field][armIndex[contrast.b]],
    ];
  }

  // --- HAM-D ---------------------------------------------------------------

  function hamdVariance() {
    const sigma2Adj = SIGMA_HAMD * SIGMA_HAMD * (1 - s.r2Hamd);
    const clusterSize = s.patientsPerCluster * (1 - s.controlAttrition);
    const designEffect =
      (1 + (clusterSize - 1) * s.iccHamd) *
      (1 + s.clusterSizeCV * s.clusterSizeCV);
    const baseVariance =
      (sigma2Adj * designEffect * IPCW_VIF) / REPEATED_MEASURES_GAIN;
    return {
      baseVariance,
      netVariance: baseVariance * measurementVarianceMultiplier,
      designEffect,
    };
  }

  function hamd(totalN, contrast) {
    const alloc = allocation(totalN);
    const [n1, n2] = pairOf(alloc, contrast, "completers");
    const { baseVariance, netVariance } = hamdVariance();
    const { z, method } = critInfo(contrast, totalN);
    const mult = z + zBeta;

    // sqrt(V * (1/n1 + 1/n2)); the old code wrote this as sqrt(2V/nHarmonic), which is
    // the same quantity for two arms.
    const invN = 1 / n1 + 1 / n2;
    const se = Math.sqrt(netVariance * invN);
    const baselineSe = Math.sqrt(baseVariance * invN);

    return {
      mde: mult * se,
      baselineMDE: mult * baselineSe, // sum-score comparison, unchanged
      // Half-width of the (1 - alpha) confidence interval on the effect estimate. Uses the
      // same critical value as the test, so it is a simultaneous interval whenever an
      // arm-level adjustment is in force. This is the quantity an exploratory study should
      // be sized on: unlike the MDE it answers "how precisely will we know the effect?"
      // rather than "what could we declare significant?".
      ciHalfWidth: z * se,
      se,
      effectSize: (mult * se) / SIGMA_HAMD,
      crit: z,
      critMethod: method,
      nClusters: alloc.nClusters,
      clusters: alloc.clusters,
      nCompleters: Math.round(alloc.completers.reduce((acc, v) => acc + v, 0)),
      nContrastCompleters: Math.round(n1 + n2),
      varianceReduction: (1 - measurementVarianceMultiplier) * 100,
      // Kept for the two-arm summary cards.
      nTreatmentClusters: alloc.clusters[0],
      nControlClusters: alloc.clusters[alloc.clusters.length - 1],
    };
  }

  // Power for a specified effect, rather than the effect detectable at fixed power.
  function hamdPower(totalN, contrast, delta) {
    const { se } = hamd(totalN, contrast);
    const { z } = critInfo(contrast, totalN);
    return normCdf(Math.abs(delta) / se - z);
  }

  // --- Retention -----------------------------------------------------------

  function retention(totalN, contrast) {
    const alloc = allocation(totalN);
    const [n1, n2] = pairOf(alloc, contrast, "randomized");
    const designEffect =
      (1 + (s.patientsPerCluster - 1) * s.iccRetention) *
      (1 + s.clusterSizeCV * s.clusterSizeCV);
    const p0 = s.controlAttrition;

    const baseSE = Math.sqrt(p0 * (1 - p0) * (1 / n1 + 1 / n2));
    const clusteredSE = baseSE * Math.sqrt(designEffect);
    const adjustedSE = clusteredSE * Math.sqrt(1 - s.r2Retention);
    const survivalSE = adjustedSE / Math.sqrt(s.survivalEfficiency);

    const { z, method } = critInfo(contrast, totalN);
    const mde = (z + zBeta) * survivalSE;

    return {
      mde: mde * 100, // percentage points
      controlRate: p0 * 100,
      treatmentRate: (p0 - mde) * 100,
      binaryMDE: (z + zBeta) * adjustedSE * 100,
      ciHalfWidth: z * survivalSE * 100, // percentage points
      se: survivalSE,
      crit: z,
      critMethod: method,
      nClusters: alloc.nClusters,
    };
  }

  // --- ICC substudy --------------------------------------------------------

  // Arms contributing AURORA-vs-clinician rating pairs. In three-arm mode both A and B
  // generate AURORA scores alongside clinician ratings; arm-B clinicians simply do not
  // see the output. In two-arm mode this is the single treatment arm, as before.
  const iccArmKeys = s.designArms === 3 ? ["A", "B"] : ["A"];

  function icc(totalN) {
    const alloc = allocation(totalN);
    const idx = iccArmKeys.map((k) => armIndex[k]);
    const nPatients = idx.reduce((acc, i) => acc + alloc.completers[i], 0);
    const nClustersIcc = idx.reduce((acc, i) => acc + alloc.clusters[i], 0);

    const nObservations = nPatients * s.nFollowups;
    const avgObsPerCluster = nObservations / nClustersIcc;
    const designEffect = 1 + (avgObsPerCluster - 1) * s.iccClusterCorr;
    const nEffective = nObservations / designEffect;

    const seIcc =
      (1 - s.expectedIcc * s.expectedIcc) * Math.sqrt(2 / (nEffective - 1));
    const ciHalfWidth = 1.96 * seIcc;
    const lowerBound = s.expectedIcc - ciHalfWidth;

    return {
      armKeys: iccArmKeys,
      nTreatmentPatients: Math.round(nPatients),
      nTreatmentClusters: nClustersIcc,
      nObservations: Math.round(nObservations),
      nEffective: Math.round(nEffective),
      seIcc,
      ciHalfWidth,
      lowerBound,
      upperBound: s.expectedIcc + ciHalfWidth,
      canRuleOutPoor: lowerBound > s.targetIcc,
    };
  }

  // --- Fairness / DIF substudy --------------------------------------------

  // Differential item functioning across a subgroup of the sample - the "fair" half of
  // the measurement aim. Only AURORA users generate item responses, so this draws on the
  // same arms as the ICC substudy.
  //
  // Unlike the ICC substudy, this uses RANDOMIZED counts rather than completers: DIF is
  // assessed on item responses that exist from the baseline assessment, which everyone
  // randomized provides, whereas agreement needs follow-up pairs.
  function dif(totalN) {
    const alloc = allocation(totalN);
    const idx = iccArmKeys.map((k) => armIndex[k]);
    const nUsers = idx.reduce((acc, i) => acc + alloc.randomized[i], 0);

    // Round the focal group once and take the remainder, rather than rounding both
    // independently - otherwise the two displayed counts can sum to one more than the
    // total (at a 5% share of 670: 34 + 637 = 671). Clamped to >= 1 so the SE stays
    // finite at extreme shares.
    const nFocal = Math.max(
      1,
      Math.min(nUsers - 1, Math.round(nUsers * s.difSubgroupShare)),
    );
    const nReference = nUsers - nFocal;

    // SE of the difference in item location between groups. For an item carrying
    // information I at the targeted ability, Var(b_hat) ~ 1/(n * I); the well-targeted
    // dichotomous case I = 0.25 recovers the familiar SE(b) ~ 2/sqrt(n).
    const info = s.difItemInfo;

    // Patients are still nested in clinicians, so the item-parameter SE carries a design
    // effect. It has to be computed on the RANDOMIZED cluster size, not the post-attrition
    // one used for the HAM-D outcome: this analysis uses everyone's baseline responses, so
    // the clusters really are `patientsPerCluster` big. Borrowing the HAM-D design effect
    // here would pair a full-sample N with a shrunken cluster size and understate the SE.
    const designEffect =
      (1 + (s.patientsPerCluster - 1) * s.iccHamd) *
      (1 + s.clusterSizeCV * s.clusterSizeCV);

    const seRaw = Math.sqrt(1 / (nFocal * info) + 1 / (nReference * info));
    const se = seRaw * Math.sqrt(designEffect);

    // DIF is a measurement question, not an arm comparison, so no arm-level multiplicity
    // applies - only the alpha level (and the small-sample correction, since the
    // clustering that motivates it is still present).
    let z = zUnadjusted;
    if (s.smallSampleT) {
      const df = dfFor(totalN);
      if (df > 2) z = tQuantile(normCdf(z), df);
    }

    const mde = (z + zBeta) * se;
    const power = normCdf(Math.abs(s.difTargetLogits) / se - z);

    return {
      armKeys: iccArmKeys,
      nUsers,
      nFocal,
      nReference,
      adequate: nFocal >= s.difThresholdN,
      shortfall: Math.max(0, Math.ceil(s.difThresholdN - nFocal)),
      // Total N that would put the smallest subgroup on the adequacy threshold.
      nRequired:
        s.difSubgroupShare > 0
          ? Math.ceil(
              (s.difThresholdN / s.difSubgroupShare) * (totalN / nUsers),
            )
          : Infinity,
      se,
      designEffect,
      crit: z,
      ciHalfWidth: z * se,
      mde, // smallest DIF detectable at nominal power, in logits
      power, // power to detect difTargetLogits
    };
  }

  return {
    arms,
    contrasts,
    allocation,
    dif,
    hamd,
    hamdPower,
    retention,
    icc,
    critInfo,
    dfFor,
    zBeta,
    zUnadjusted,
    zBonferroni,
    zDunnett,
    activeLambdas,
    measurementVarianceMultiplier,
    useRasch,
    useMFRM,
  };
}
