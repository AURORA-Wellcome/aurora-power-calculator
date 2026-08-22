// Power calculations for the AURORA trial, split out from the UI so the maths can be
// exercised directly from Node (see scripts/verify.mjs) instead of only through the browser.
//
// Supports a two-arm cluster-randomized design (the original) and a three-arm design:
//   A = clinician + patient use of AURORA
//   B = patient-only use
//   C = usual-care control
// All arms are randomized at the clinician (cluster) level, so every contrast carries the
// full clustering design effect.

import {
  allocateClusters,
  rosterFromSettings,
  scaleRoster,
  allocateRoster,
  cvBetween,
} from "./sites.js";

// allocateClusters lives in sites.js (it is the allocation primitive both modules need),
// re-exported here so existing importers and tests are unaffected.
export { allocateClusters };

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
// Arms and contrasts
// ---------------------------------------------------------------------------

export const ARM_LABELS = {
  A3: "Clinician + Patient",
  B3: "Patient-only",
  C3: "Control",
  A2: "Treatment",
  C2: "Control",
};

// Hybrid randomization only exists for the three-arm design: it needs a no-ROM cluster
// containing two patient-level conditions.
export function isHybrid(s) {
  return s.designArms === 3 && s.randomization === "hybrid";
}

export function buildArms(s) {
  if (s.designArms === 3) {
    // clusterGroup identifies the randomization unit an arm's patients sit in. Under
    // HYBRID randomization clinicians are randomized to ROM vs no-ROM, and patients
    // inside no-ROM clinicians are then individually randomized to app-only vs TAU - so
    // B and C share clusters and their contrast is a within-cluster comparison.
    const hybrid = isHybrid(s);
    return [
      {
        key: "A",
        label: ARM_LABELS.A3,
        short: "Clin+Pt",
        weight: s.allocA,
        clusterGroup: 0,
      },
      {
        key: "B",
        label: ARM_LABELS.B3,
        short: "Pt-only",
        weight: s.allocB,
        clusterGroup: hybrid ? 1 : 1,
      },
      {
        key: "C",
        label: ARM_LABELS.C3,
        short: "Control",
        weight: s.allocC,
        clusterGroup: hybrid ? 1 : 2,
      },
    ];
  }
  return [
    {
      key: "A",
      label: ARM_LABELS.A2,
      short: "Tx",
      weight: s.treatmentRatio,
      clusterGroup: 0,
    },
    {
      key: "C",
      label: ARM_LABELS.C2,
      short: "Ctrl",
      weight: 1,
      clusterGroup: 1,
    },
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
      {
        id: "PC",
        pooled: ["A", "B"],
        b: "C",
        label: "AURORA pooled (either arm) vs Control",
        short: "A+B vs C",
        primary: false,
        // Not an extra test in the multiplicity family: it is an alternative view of the
        // same data, reported INSTEAD of the decomposition, so it does not inflate m.
        family: "pooled",
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

// Cohen's h: the effect-size analogue of d for a difference between two proportions.
// d is defined for a mean difference and does not transfer to proportions, whose variance
// is tied to their level; the arcsine transform removes that dependence. Same rough
// benchmarks as d (0.2 small, 0.5 medium, 0.8 large).
export function cohensH(p1, p2) {
  const clamp = (p) => Math.min(1, Math.max(0, p));
  const phi = (p) => 2 * Math.asin(Math.sqrt(clamp(p)));
  return Math.abs(phi(p1) - phi(p2));
}

const SIGMA_HAMD = 7;
const IPCW_VIF = 1.2;
const REPEATED_MEASURES_GAIN = 1.43;

export function createModel(s) {
  const hybrid = isHybrid(s);
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

  // The pooled contrast is an alternative presentation, not a fourth hypothesis, so it
  // is excluded from the multiplicity count.
  const nPairwise = contrasts.filter((c) => c.family !== "pooled").length;
  const zUnadjusted = normInv(1 - s.alpha / 2);
  const zBonferroni = normInv(1 - s.alpha / (2 * nPairwise));
  // CAVEAT under hybrid randomization: Dunnett's lambda parameterisation assumes the
  // active-vs-control statistics share a common variance structure through the control
  // arm. With hybrid, B vs C is a within-clinician contrast with a materially smaller
  // variance than A vs C, so the true correlation between the two statistics is lower
  // than this formula implies, and the correct critical value is slightly HIGHER (closer
  // to Bonferroni). The default exploratory framing applies no adjustment so this does
  // not bite; under a confirmatory framing with hybrid, prefer Bonferroni.
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

  // Distinct randomization units. Under cluster randomization every arm has its own
  // clinicians; under hybrid, arms B and C share the no-ROM clinicians.
  const roster = rosterFromSettings(s);

  // Cluster-size variation has two independent sources and they add in quadrature:
  //   between-site  - computed from the roster's panel sizes (known)
  //   within-site   - clinicians differing from each other (assumed, s.clusterSizeCV)
  // The roster cannot supply the second: it records planned targets, not realized
  // recruitment spread, and the between-site term is far smaller (~0.038 vs ~0.2).
  const cvSite = cvBetween(roster);
  const cvTotal = Math.sqrt(
    cvSite * cvSite + s.clusterSizeCV * s.clusterSizeCV,
  );
  const cvAdjTotal = 1 + cvTotal * cvTotal;

  const nGroups = Math.max(...arms.map((a) => a.clusterGroup)) + 1;
  const groupWeights = Array.from({ length: nGroups }, (_, g) =>
    arms
      .filter((a) => a.clusterGroup === g)
      .reduce((acc, a) => acc + a.weight, 0),
  );

  function allocation(totalN) {
    const nClusters = Math.round(totalN / s.patientsPerCluster);

    // Randomization is stratified by SITE, so clinicians are apportioned within each site
    // and then aggregated. That is not the same as apportioning one pool: largest-
    // remainder rounding at each site shifts the realized allocation away from the
    // nominal one, and the direction depends on the roster shape rather than being
    // predictable. A single-site roster reproduces the one-pool behaviour exactly.
    const sitesScaled = scaleRoster(roster, nClusters);
    const perSite = allocateRoster(sitesScaled, groupWeights);
    const groupClusters = perSite.aggregate;

    // Within a unit, patients split by the arms' relative weights. That share is 1 for a
    // cluster-randomized arm and b/(b+c) or c/(b+c) for the two hybrid patient-level arms.
    const shareInGroup = arms.map(
      (a) => a.weight / groupWeights[a.clusterGroup],
    );
    // Patients of THIS arm per clinician it is present in - the cluster size that drives
    // this arm's design effect. Under hybrid a no-ROM clinician contributes only part of
    // its panel to each of B and C.
    const armClusterSize = shareInGroup.map((f) => f * s.patientsPerCluster);

    const clusters = arms.map((a) => groupClusters[a.clusterGroup]);
    const randomized = arms.map(
      (a, i) => groupClusters[a.clusterGroup] * armClusterSize[i],
    );
    const completers = randomized.map((n) => n * (1 - s.controlAttrition));

    // Per-site breakdown, in the same arm-indexed shape as the aggregates, so a contrast
    // can be evaluated stratum by stratum and pooled.
    const sites = perSite.perSite.map((gc, si) => {
      const cl = arms.map((a) => gc[a.clusterGroup]);
      const rand = arms.map((a, i) => gc[a.clusterGroup] * armClusterSize[i]);
      return {
        name: sitesScaled[si].name,
        nClusters: sitesScaled[si].clinicians,
        groupClusters: gc,
        clusters: cl,
        randomized: rand,
        completers: rand.map((n) => n * (1 - s.controlAttrition)),
      };
    });

    return {
      nClusters,
      groupClusters,
      clusters,
      randomized,
      completers,
      armClusterSize,
      arms,
      hybrid: hybrid,
      sites,
      siteRoster: sitesScaled,
      nominalGroupClusters: perSite.nominal,
    };
  }

  // Variance for a POOLED contrast (several arms averaged, against one comparator),
  // written in variance-component form because the pooled arm can straddle two
  // randomization units. With total variance s^2 split as between-clinician (rho) and
  // within-clinician (1 - rho):
  //
  //   Var(T)/s^2 = rho * [ SUM_k w_k^2/J_k + 1/J_ref
  //                        + 2 SUM_{k<l} w_k w_l [same unit]/J
  //                        - 2 SUM_k w_k [same unit as ref]/J ]
  //              + (1 - rho) * [ SUM_k w_k^2/n_k + 1/n_ref ]
  //
  // The cross terms are what make this more than a merged arm: under hybrid, B and C
  // share clinicians, so their means are positively correlated and part of the
  // between-clinician variance cancels. Weights are proportional to sample size.
  //
  // Sanity: with one pooled arm and distinct units this reduces to rho(1/J_i + 1/J_j) +
  // (1-rho)(1/n_i + 1/n_j), which equals the pairwise DE_i/n_i + DE_j/n_j exactly when
  // clusterSizeCV = 0.
  //
  // CONVENTION NOTE: the inherited pairwise design effect is (1 + (m-1)rho)(1 + CV^2),
  // which inflates the whole variance by cluster-size variation - including the
  // within-clinician part, which unequal cluster sizes should not affect. The pooled and
  // within-cluster forms here apply (1 + CV^2) only to the between-clinician component,
  // which is the principled treatment. The two therefore diverge slightly when CV > 0
  // (the pooled form being ~1.5% less inflated at CV = 0.2). The inherited formula is
  // kept for the pairwise path so the two-arm regression against the original
  // implementation continues to hold exactly.
  function pooledFactorOne(cells, alloc, contrast, icc, field) {
    const idx = contrast.pooled.map((k) => armIndex[k]);
    const ref = armIndex[contrast.b];
    const ns = idx.map((i) => cells[field][i]);
    const total = ns.reduce((a, b) => a + b, 0);
    const w = ns.map((n) => n / total);
    const cvAdj = cvAdjTotal;
    const J = (i) => cells.clusters[i];
    const sameUnit = (i, j) => arms[i].clusterGroup === arms[j].clusterGroup;

    let between = 1 / J(ref);
    let within = 1 / cells[field][ref];
    idx.forEach((i, a) => {
      between += (w[a] * w[a]) / J(i);
      within += (w[a] * w[a]) / cells[field][i];
      if (sameUnit(i, ref)) between -= (2 * w[a]) / J(i);
    });
    for (let a = 0; a < idx.length; a++) {
      for (let b = a + 1; b < idx.length; b++) {
        if (sameUnit(idx[a], idx[b])) {
          between += (2 * w[a] * w[b]) / J(idx[a]);
        }
      }
    }
    return icc * cvAdj * between + (1 - icc) * within;
  }

  // Variance multiplier for a contrast: the sum of design-effect-weighted inverse sample
  // sizes. Returned separately from the outcome variance so each contrast can carry its
  // own clustering, which is the whole point of the hybrid design.
  function contrastFactorOne(cells, alloc, contrast, icc, field) {
    if (contrast.pooled)
      return pooledFactorOne(cells, alloc, contrast, icc, field);
    const i = armIndex[contrast.a];
    const j = armIndex[contrast.b];
    const n1 = cells[field][i];
    const n2 = cells[field][j];
    const attrition = field === "completers" ? 1 - s.controlAttrition : 1;

    if (arms[i].clusterGroup === arms[j].clusterGroup) {
      // WITHIN-CLUSTER contrast: both arms sit inside the same clinicians, so the
      // clinician effect is common to both and cancels from the difference. Only the
      // within-clinician variance remains, hence (1 - ICC) instead of a design effect
      // above 1. This is where hybrid randomization buys its power.
      return (1 - icc) * (1 / n1 + 1 / n2);
    }

    // BETWEEN-CLUSTER contrast: each arm carries its own design effect, computed on the
    // number of that arm's patients per clinician. Arm-specific rather than shared,
    // because under hybrid the ROM and no-ROM arms have different effective sizes.
    const cvAdj = cvAdjTotal;
    const de = (m) => (1 + (m * attrition - 1) * icc) * cvAdj;
    return de(alloc.armClusterSize[i]) / n1 + de(alloc.armClusterSize[j]) / n2;
  }

  // Randomization is stratified by site, so each site yields its own estimate of the
  // contrast and a stratified analysis pools them by inverse variance:
  //
  //   1/V = SUM_over_sites 1/V_s
  //
  // With S identical sites this reduces EXACTLY to the one-pool formula: V_s = S*V_single,
  // so 1/V = S/(S*V_single) = 1/V_single. A one-site roster therefore reproduces the
  // pre-stratification numbers bit for bit, which is what the regression checks assert.
  //
  // Sites contributing no information to a contrast (a cell allocated zero clinicians)
  // simply drop out of the sum rather than making the whole contrast undefined.
  function contrastFactor(alloc, contrast, icc, field) {
    let inv = 0;
    for (const site of alloc.sites) {
      const f = contrastFactorOne(site, alloc, contrast, icc, field);
      if (Number.isFinite(f) && f > 0) inv += 1 / f;
    }
    return inv > 0 ? 1 / inv : Infinity;
  }

  // A pooled contrast straddles both randomization units under hybrid, so it is neither
  // purely within- nor purely between-clinician.
  function isWithin(contrast) {
    if (contrast.pooled) return false;
    return (
      arms[armIndex[contrast.a]].clusterGroup ===
      arms[armIndex[contrast.b]].clusterGroup
    );
  }

  function pairOf(alloc, contrast, field) {
    const rhs = alloc[field][armIndex[contrast.b]];
    if (contrast.pooled) {
      return [
        contrast.pooled.reduce((acc, k) => acc + alloc[field][armIndex[k]], 0),
        rhs,
      ];
    }
    return [alloc[field][armIndex[contrast.a]], rhs];
  }

  // --- HAM-D ---------------------------------------------------------------

  // Per-patient outcome variance, WITHOUT any clustering term - the design effect now
  // varies by contrast (see contrastFactor) rather than being shared across all of them.
  function hamdVariance() {
    const sigma2Adj = SIGMA_HAMD * SIGMA_HAMD * (1 - s.r2Hamd);
    const baseVariance = (sigma2Adj * IPCW_VIF) / REPEATED_MEASURES_GAIN;
    return {
      baseVariance,
      netVariance: baseVariance * measurementVarianceMultiplier,
    };
  }

  function hamd(totalN, contrast) {
    const alloc = allocation(totalN);
    const [n1, n2] = pairOf(alloc, contrast, "completers");
    const { baseVariance, netVariance } = hamdVariance();
    const { z, method } = critInfo(contrast, totalN);
    const mult = z + zBeta;

    // Design-effect-weighted sum of inverse sample sizes. For a cluster-randomized
    // two-arm design this reduces to DE * (1/n1 + 1/n2), exactly as before.
    const invN = contrastFactor(alloc, contrast, s.iccHamd, "completers");
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
      // Same units for the precision reading, so a CI half-width can be judged against
      // the same benchmarks as the MDE.
      ciEffectSize: (z * se) / SIGMA_HAMD,
      crit: z,
      critMethod: method,
      nClusters: alloc.nClusters,
      clusters: alloc.clusters,
      nCompleters: Math.round(alloc.completers.reduce((acc, v) => acc + v, 0)),
      nContrastCompleters: Math.round(n1 + n2),
      withinCluster: isWithin(contrast),
      mixedCluster: Boolean(contrast.pooled) && hybrid,
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
    const p0 = s.controlAttrition;

    // The clustering term is folded into the inverse-N factor so a within-cluster
    // contrast can drop the between-clinician variance.
    const invN = contrastFactor(alloc, contrast, s.iccRetention, "randomized");
    const clusteredSE = Math.sqrt(p0 * (1 - p0) * invN);
    const adjustedSE = clusteredSE * Math.sqrt(1 - s.r2Retention);
    const survivalSE = adjustedSE / Math.sqrt(s.survivalEfficiency);

    const { z, method } = critInfo(contrast, totalN);
    const mde = (z + zBeta) * survivalSE;

    return {
      mde: mde * 100, // percentage points
      // Effect sizes are computed on the proportions, not the percentage points: h is a
      // function of the two rates, so it depends on where p0 sits, not just the gap.
      effectSizeH: cohensH(p0, p0 - mde),
      ciEffectSizeH: cohensH(p0, p0 - z * survivalSE),
      controlRate: p0 * 100,
      treatmentRate: (p0 - mde) * 100,
      binaryMDE: (z + zBeta) * adjustedSE * 100,
      ciHalfWidth: z * survivalSE * 100, // percentage points
      se: survivalSE,
      crit: z,
      critMethod: method,
      nClusters: alloc.nClusters,
      withinCluster: isWithin(contrast),
      mixedCluster: Boolean(contrast.pooled) && hybrid,
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
    // Dedupe by randomization unit: under hybrid two contributing arms can live in the
    // same clinicians, and counting those clinicians twice would understate the design
    // effect. (Spreading the same patients over more clinicians genuinely helps here.)
    const nClustersIcc = [
      ...new Set(idx.map((i) => arms[i].clusterGroup)),
    ].reduce((acc, g) => acc + alloc.groupClusters[g], 0);

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
    const nClustersUsed = [
      ...new Set(idx.map((i) => arms[i].clusterGroup)),
    ].reduce((acc, g) => acc + alloc.groupClusters[g], 0);

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
    // Effective cluster size is the AURORA users per contributing clinician, which is
    // patientsPerCluster under cluster randomization but lower under hybrid, where a
    // no-ROM clinician contributes only its app-only patients.
    const usersPerCluster = nUsers / nClustersUsed;
    const designEffect =
      (1 + (usersPerCluster - 1) * s.iccHamd) *
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

  // --- Spillover substudy (mixed panels) -----------------------------------

  // A THIRD clinician type: ROM-trained, dashboard in hand, but only some of their
  // patients on it. Their panel carries all three conditions; the rest of their patients
  // are app-only or TAU and are invisible to the dashboard.
  //
  //   pure-ROM (P)  every patient on the dashboard          -> all arm A
  //   mixed    (M)  panel split across all three conditions -> A, B and C
  //   no-ROM   (K)  never trained                           -> B and C
  //
  // Spillover is identified by comparing the SAME arm across clinician types: a B patient
  // of a mixed clinician gets exactly what a B patient of a no-ROM clinician gets, except
  // that their clinician has been changed by ROM. Any outcome gap is spillover.
  //
  // Panels are split proportionally to the target allocation, which makes the overall
  // allocation invariant to M. Writing pA for arm A's share:
  //
  //   P = pA (J - M),  K = (1 - pA)(J - M),  so P + M + K = J for any M,
  //   A patients = P m + M (m pA) = pA J m,  unchanged. Same for B and C.
  //
  // So M is a free dial: it changes only how patients are ARRANGED across clinicians,
  // never how many are in each arm.
  // shareOverride lets the UI sweep M without rebuilding the model for each row.
  function spillover(totalN, shareOverride) {
    const share = shareOverride === undefined ? s.mixedShare : shareOverride;
    const alloc = allocation(totalN);
    // Needs three arms: a mixed panel has to carry a dashboard condition, an app-only
    // condition and a control condition. With two arms there is no app-only arm to
    // spill onto, so return an inert result rather than propagating NaN.
    const none = {
      se: Infinity,
      mde: Infinity,
      effectSize: Infinity,
      ciHalfWidth: Infinity,
      ciEffectSize: Infinity,
    };
    if (arms.length < 3) {
      return {
        M: 0,
        P: alloc.nClusters,
        K: 0,
        panelMixed: [],
        panelNoRom: [],
        totalClinicians: alloc.nClusters,
        patients: alloc.randomized.map(Math.round),
        available: false,
        primary: none,
        spilloverB: none,
        spilloverC: none,
        spilloverPooled: none,
        directEffect: none,
      };
    }
    const J = alloc.nClusters;
    const m = s.patientsPerCluster;
    const keep = 1 - s.controlAttrition;
    const cvAdj = 1 + s.clusterSizeCV * s.clusterSizeCV;
    const rho = s.iccHamd;
    const de = (size) => (1 + (size * keep - 1) * rho) * cvAdj;
    const betw = (Jk, nk) =>
      Jk > 0 && nk > 0 ? de(nk / (Jk * keep)) / nk : Infinity;

    const w = arms.map((a) => a.weight);
    const sumW = w.reduce((x, y) => x + y, 0);
    const [pA, pB, pC] = w.map((x) => x / sumW);

    const M = Math.round(share * J);
    const P = pA * (J - M);
    const K = (1 - pA) * (J - M);

    // Panel compositions.
    const mixA = m * pA,
      mixB = m * pB,
      mixC = m * pC;
    const noB = (m * pB) / (pB + pC),
      noC = (m * pC) / (pB + pC);

    // Completer counts per cell.
    const nA_pure = P * m * keep,
      nA_mix = M * mixA * keep;
    const nB_mix = M * mixB * keep,
      nB_no = K * noB * keep;
    const nC_mix = M * mixC * keep,
      nC_no = K * noC * keep;

    const { netVariance } = hamdVariance();
    const { z } = critInfo(contrasts[0], totalN);
    const mult = z + zBeta;
    const out = (factor) => {
      const se = Math.sqrt(netVariance * factor);
      return {
        se,
        mde: mult * se,
        effectSize: (mult * se) / SIGMA_HAMD,
        ciHalfWidth: z * se,
        ciEffectSize: (z * se) / SIGMA_HAMD,
      };
    };

    return {
      M,
      P: Math.round(P),
      K: Math.round(K),
      panelMixed: [mixA, mixB, mixC],
      panelNoRom: [noB, noC],
      totalClinicians: Math.round(P) + M + Math.round(K),
      // Allocation must be untouched by M; exposed so the UI can prove it.
      patients: [
        Math.round(nA_pure / keep + nA_mix / keep),
        Math.round(nB_mix / keep + nB_no / keep),
        Math.round(nC_mix / keep + nC_no / keep),
      ],
      // Primary contrast kept clean: only clinicians with no dashboard exposure supply
      // the controls, and only fully-exposed clinicians supply the treated patients.
      primary: out(betw(P, nA_pure) + betw(K, nC_no)),
      spilloverB: out(betw(M, nB_mix) + betw(K, nB_no)),
      spilloverC: out(betw(M, nC_mix) + betw(K, nC_no)),
      spilloverPooled: out(betw(M, nB_mix + nC_mix) + betw(K, nB_no + nC_no)),
      // Within a mixed panel the clinician effect is shared, so this isolates the
      // patient-specific part of the ROM effect from any general practice change.
      directEffect:
        M > 0
          ? out((1 - rho) * (1 / nA_mix + 1 / nC_mix))
          : {
              se: Infinity,
              mde: Infinity,
              effectSize: Infinity,
              ciHalfWidth: Infinity,
              ciEffectSize: Infinity,
            },
    };
  }

  return {
    arms,
    contrasts,
    allocation,
    dif,
    spillover,
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
    roster,
    cvSite,
    cvTotal,
    groupWeights,
  };
}
