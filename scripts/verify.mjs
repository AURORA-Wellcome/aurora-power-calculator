// Checks for src/calc.js. Run with: node scripts/verify.mjs
//
// Covers the verification steps from the three-arm plan: normal quantiles, Dunnett
// critical values against published tables, cluster apportionment, two-arm regression
// against the pre-change implementation, and direction-of-effect sanity checks.

import {
  normCdf,
  normInv,
  tQuantile,
  dunnettCrit,
  dunnettProb,
  allocateClusters,
  createModel,
  cohensH,
} from "../src/calc.js";
import { defaults } from "../src/defaults.js";
import {
  DEFAULT_ROSTER,
  parseRoster,
  rosterFromSettings,
  formatRoster,
  scaleRoster,
  allocateRoster,
  cvBetween,
  totalClinicians,
  feasibility,
} from "../src/sites.js";
import {
  encodeSettings,
  decodeSettings,
  shareableUrl,
  FIELD_ORDER,
  SETTING_SPEC,
} from "../src/urlState.js";

let passed = 0;
let failed = 0;

function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail ? `: ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function close(name, actual, expected, tol) {
  const diff = Math.abs(actual - expected);
  ok(
    name,
    diff <= tol,
    `got ${actual.toPrecision(8)}, expected ${expected} (tol ${tol})`,
  );
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
section("1. Normal distribution");
// ---------------------------------------------------------------------------

close("normCdf(0)", normCdf(0), 0.5, 1e-12);
close("normCdf(1.96)", normCdf(1.96), 0.9750021049, 1e-9);
close("normCdf(-2.5)", normCdf(-2.5), 0.0062096653, 1e-9);
close("normInv(0.975)", normInv(0.975), 1.959963985, 1e-8);
close("normInv(0.8)", normInv(0.8), 0.8416212336, 1e-8);
close("normInv(1 - 0.025/2)", normInv(1 - 0.025 / 2), 2.2414027276, 1e-8);
close("normInv(0.9)", normInv(0.9), 1.2815515655, 1e-8);

// Round trip across a wide range.
{
  let worst = 0;
  for (let p = 0.0001; p < 0.9999; p += 0.0007) {
    worst = Math.max(worst, Math.abs(normCdf(normInv(p)) - p));
  }
  ok(
    "normCdf(normInv(p)) round trip",
    worst < 1e-12,
    `worst |err| ${worst.toExponential(2)}`,
  );
}

// The old hardcoded tables the calculator used to carry, now superseded.
close(
  "old table z(alpha=0.025)=2.24 reproduced",
  normInv(1 - 0.025 / 2),
  2.24,
  5e-3,
);
close("old table z(power=0.8)=0.842 reproduced", normInv(0.8), 0.842, 5e-4);

// t quantiles against R's qt(), to full precision. The tolerances here were once loose
// enough (2e-3 to 5e-3) to accommodate rounded reference values rather than to bound the
// approximation, and that hid a genuinely wrong constant: qt(0.9875, 37) is 2.336316, not
// the 2.339303 this file asserted. The Cornish-Fisher expansion is good to 2e-6 there.
// 1e-4 leaves roughly 6x headroom over the worst case below while still being a real guard.
close("tQuantile(0.975, 60)", tQuantile(0.975, 60), 2.000297822014, 1e-4);
close("tQuantile(0.975, 30)", tQuantile(0.975, 30), 2.042272456301, 1e-4);
close("tQuantile(0.975, 1e9) -> z", tQuantile(0.975, 1e9), 1.959963985, 1e-6);
// Further into the tail, where the small-sample correction actually operates. The worst
// error across the whole reachable parameter space is 1.5e-5, at df = 30.
close("tQuantile(0.9875, 37)", tQuantile(0.9875, 37), 2.33631599691, 1e-4);
close("tQuantile(0.995, 97)", tQuantile(0.995, 97), 2.627467774013, 1e-4);
close("tQuantile(0.995, 30)", tQuantile(0.995, 30), 2.749995653567, 1e-4);

// ---------------------------------------------------------------------------
section("2. Dunnett critical values (published tables, df = infinity)");
// ---------------------------------------------------------------------------

const lamEqual = Math.sqrt(0.5); // equal allocation -> rho = 0.5

close(
  "dunnett k=2, alpha=0.05",
  dunnettCrit([lamEqual, lamEqual], 0.05),
  2.212,
  2e-3,
);
close(
  "dunnett k=2, alpha=0.01",
  dunnettCrit([lamEqual, lamEqual], 0.01),
  2.794,
  5e-3,
);
close(
  "dunnett k=3, alpha=0.05",
  dunnettCrit([lamEqual, lamEqual, lamEqual], 0.05),
  2.349,
  3e-3,
);

close(
  "single lambda collapses to normInv(1-a/2)",
  dunnettCrit([lamEqual], 0.05),
  normInv(0.975),
  1e-9,
);

{
  const unadj = normInv(1 - 0.05 / 2);
  const bonf = normInv(1 - 0.05 / 4); // m=2
  const dun = dunnettCrit([lamEqual, lamEqual], 0.05);
  ok(
    "unadjusted < Dunnett < Bonferroni",
    unadj < dun && dun < bonf,
    `${unadj.toFixed(4)} < ${dun.toFixed(4)} < ${bonf.toFixed(4)}`,
  );
}

{
  // Integral must be a proper probability and monotone in c.
  const p1 = dunnettProb(1, [lamEqual, lamEqual]);
  const p3 = dunnettProb(3, [lamEqual, lamEqual]);
  const p8 = dunnettProb(8, [lamEqual, lamEqual]);
  ok(
    "dunnettProb monotone increasing in c",
    p1 < p3 && p3 < p8,
    `${p1.toFixed(4)} < ${p3.toFixed(4)} < ${p8.toFixed(4)}`,
  );
  close("dunnettProb(8) -> 1", p8, 1, 1e-6);
}

{
  // Unequal allocation must shift the critical value, not silently reuse rho = 0.5.
  const lamHeavy = Math.sqrt(1 / (1 + 2)); // active:control = 1:2
  const dEq = dunnettCrit([lamEqual, lamEqual], 0.05);
  const dUn = dunnettCrit([lamHeavy, lamHeavy], 0.05);
  ok(
    "unequal allocation changes Dunnett crit",
    Math.abs(dEq - dUn) > 1e-3,
    `equal ${dEq.toFixed(4)} vs 1:1:2 ${dUn.toFixed(4)}`,
  );
}

// ---------------------------------------------------------------------------
section("3. Cluster apportionment");
// ---------------------------------------------------------------------------

{
  const a = allocateClusters(100, [1, 1, 1]);
  ok(
    "100 across 1:1:1 -> 34/33/33",
    JSON.stringify(a) === "[34,33,33]",
    JSON.stringify(a),
  );
  ok("sums to total", a.reduce((x, y) => x + y, 0) === 100);
}
{
  const a = allocateClusters(100, [1, 1, 2]);
  ok(
    "100 across 1:1:2 -> 25/25/50",
    JSON.stringify(a) === "[25,25,50]",
    JSON.stringify(a),
  );
}
{
  const a = allocateClusters(100, [2, 1, 1]);
  ok(
    "100 across 2:1:1 -> 50/25/25",
    JSON.stringify(a) === "[50,25,25]",
    JSON.stringify(a),
  );
}
{
  // The old two-arm code used Math.round(nClusters * prop) with the remainder to control.
  // Ties must break toward the first arm to reproduce that exactly.
  let allMatch = true;
  const mismatches = [];
  for (let n = 1; n <= 400; n++) {
    for (const r of [1, 2, 3, 4]) {
      const oldTx = Math.round((n * r) / (r + 1));
      const [tx, ctrl] = allocateClusters(n, [r, 1]);
      if (tx !== oldTx || ctrl !== n - oldTx) {
        allMatch = false;
        if (mismatches.length < 5)
          mismatches.push(
            `n=${n} r=${r}:${tx}/${ctrl} vs ${oldTx}/${n - oldTx}`,
          );
      }
    }
  }
  ok(
    "two-arm apportionment matches old Math.round behaviour",
    allMatch,
    mismatches.join(" "),
  );
}
{
  let allSum = true;
  for (let n = 0; n <= 500; n++) {
    for (const w of [
      [1, 1, 1],
      [1, 1, 2],
      [3, 2, 1],
      [5, 1, 1],
    ]) {
      if (allocateClusters(n, w).reduce((x, y) => x + y, 0) !== n)
        allSum = false;
    }
  }
  ok("apportionment always sums exactly, n in 0..500", allSum);
}

// ---------------------------------------------------------------------------
section("4. Two-arm regression against the pre-change implementation");
// ---------------------------------------------------------------------------

const baseSettings = {
  analysisFraming: "confirmatory",
  designArms: 2,
  power: 0.8,
  alpha: 0.025,
  iccHamd: 0.04,
  iccRetention: 0.05,
  r2Hamd: 0.35,
  r2Retention: 0.05,
  patientsPerCluster: 10,
  nClinicians: 100,
  clusterSizeCV: 0,
  controlAttrition: 0.3,
  treatmentRatio: 3,
  allocA: 1,
  allocB: 1,
  allocC: 1,
  multiplicity: "dunnett",
  smallSampleT: false,
  measurementModel: "sum",
  sumScoreReliability: 0.86,
  raschReliability: 0.91,
  raterVarianceProp: 0.07,
  targetIcc: 0.75,
  expectedIcc: 0.8,
  iccClusterCorr: 0.03,
  nFollowups: 4,
  survivalEfficiency: 4.0,
};

// Captured from the original App.js implementation before this change.
// Scenario -> [old zAlpha, old zBeta, rows keyed by N]
const BASELINE = {
  defaults: {
    z: [2.24, 0.842],
    settings: {},
    rows: {
      400: {
        hamd: 2.4487313868799307,
        ret: 9.570342009040221,
        icc: 0.04637048302311389,
        obs: 840,
        clusters: 40,
      },
      700: {
        hamd: 1.869211327059719,
        ret: 7.305412011697548,
        icc: 0.03487072026613701,
        obs: 1484,
        clusters: 70,
      },
      1000: {
        hamd: 1.5487137120967078,
        ret: 6.0528157470717705,
        icc: 0.029308288030639847,
        obs: 2100,
        clusters: 100,
      },
      1300: {
        hamd: 1.365385947292902,
        ret: 5.336318454503954,
        icc: 0.02563681597776889,
        obs: 2744,
        clusters: 130,
      },
    },
  },
  mfrm: {
    z: [2.24, 0.842],
    settings: { measurementModel: "mfrm" },
    rows: {
      400: {
        hamd: 2.301677248312156,
        ret: 9.570342009040221,
        icc: 0.04637048302311389,
        obs: 840,
        clusters: 40,
      },
      1000: {
        hamd: 1.455708508651072,
        ret: 6.0528157470717705,
        icc: 0.029308288030639847,
        obs: 2100,
        clusters: 100,
      },
    },
  },
  rasch: {
    z: [2.24, 0.842],
    settings: { measurementModel: "rasch" },
    rows: {
      1000: {
        hamd: 1.5094994050792288,
        ret: 6.0528157470717705,
        icc: 0.029308288030639847,
        obs: 2100,
        clusters: 100,
      },
    },
  },
  ratio1: {
    z: [2.24, 0.842],
    settings: { treatmentRatio: 1 },
    rows: {
      700: {
        hamd: 1.6030709909987826,
        ret: 6.265259526148938,
        icc: 0.042924104947127506,
        obs: 980,
        clusters: 70,
      },
      1000: {
        hamd: 1.341225417865048,
        ret: 5.241892201390639,
        icc: 0.03590291918779258,
        obs: 1400,
        clusters: 100,
      },
    },
  },
  cv04_power90: {
    z: [1.96, 1.282],
    settings: { clusterSizeCV: 0.4, power: 0.9, alpha: 0.05 },
    rows: {
      700: {
        hamd: 2.117716277883693,
        ret: 8.276640372255075,
        icc: 0.03487072026613701,
        obs: 1484,
        clusters: 70,
      },
      1000: {
        hamd: 1.7546096529641315,
        ret: 6.8575159207748095,
        icc: 0.029308288030639847,
        obs: 2100,
        clusters: 100,
      },
    },
  },
};

// The captured baseline predates site stratification, so these scenarios pin a SINGLE
// site. That is not a workaround: one site means no stratification, which is exactly the
// model the original implementation used. It doubles as the reduction check - if a
// one-site roster did not reproduce the old numbers, the site generalization would be
// wrong rather than the old code.
const ONE_SITE = "10000-1000"; // panel size 10, so cvBetween is exactly 0

for (const [name, spec] of Object.entries(BASELINE)) {
  const s = { ...baseSettings, siteRoster: ONE_SITE, ...spec.settings };
  const m = createModel(s);
  const c = m.contrasts[0];

  // The only intended change to two-arm results is that the hardcoded z lookup is
  // replaced by an exact quantile. Scaling the old MDE by the ratio of the critical
  // multipliers must therefore reproduce the new value to machine precision. That is
  // a far stronger check than a loose tolerance.
  const oldMult = spec.z[0] + spec.z[1];
  const newMult = m.zUnadjusted + m.zBeta;
  const scale = newMult / oldMult;

  for (const [nStr, exp] of Object.entries(spec.rows)) {
    const n = Number(nStr);
    const h = m.hamd(n, c);
    const r = m.retention(n, c);
    const i = m.icc(n);

    close(`[${name}] N=${n} HAM-D MDE`, h.mde, exp.hamd * scale, 1e-9);
    close(`[${name}] N=${n} retention MDE`, r.mde, exp.ret * scale, 1e-8);
    // The ICC substudy carries no power term, so it does not take `scale`. It now
    // reports at the level alpha sets rather than a hardcoded 1.96, so the captured
    // baseline scales by the ratio of the two critical values. It takes no multiplicity
    // adjustment, hence zUnadjusted; this scenario sets smallSampleT false, so there is
    // no t term to account for either.
    close(
      `[${name}] N=${n} ICC half-width`,
      i.ciHalfWidth,
      (exp.icc * m.zUnadjusted) / 1.96,
      5e-7,
    );
    ok(
      `[${name}] N=${n} ICC observations`,
      i.nObservations === exp.obs,
      `${i.nObservations} vs ${exp.obs}`,
    );
    ok(
      `[${name}] N=${n} clusters`,
      h.nClusters === exp.clusters,
      `${h.nClusters} vs ${exp.clusters}`,
    );
  }

  // And confirm the drift versus the old hardcoded values is genuinely small.
  const h1000 = m.hamd(1000, c);
  const oldVal = spec.rows[1000].hamd;
  const relDrift = Math.abs(h1000.mde - oldVal) / oldVal;
  ok(
    `[${name}] drift from old z table < 0.1%`,
    relDrift < 0.001,
    `${(relDrift * 100).toFixed(4)}%`,
  );
}

{
  // Two arms must never invoke a multiplicity adjustment.
  const m = createModel({ ...baseSettings, multiplicity: "bonferroni" });
  const { z, method } = m.critInfo(m.contrasts[0], 1000);
  ok(
    "two-arm ignores multiplicity setting",
    Math.abs(z - m.zUnadjusted) < 1e-12 && method === "unadjusted",
    method,
  );
}

// ---------------------------------------------------------------------------
section("5. Three-arm behaviour");
// ---------------------------------------------------------------------------

const three = { ...baseSettings, designArms: 3 };
const m3 = createModel(three);
const m2 = createModel(baseSettings);

ok(
  "three arms built",
  m3.arms.length === 3,
  m3.arms.map((a) => a.key).join("/"),
);
ok(
  "four contrasts built (3 pairwise + 1 pooled)",
  m3.contrasts.length === 4,
  m3.contrasts.map((c) => c.id).join("/"),
);

{
  const alloc = m3.allocation(1000);
  ok(
    "1000 patients -> 34/33/33 clusters",
    JSON.stringify(alloc.clusters) === "[34,33,33]",
    JSON.stringify(alloc.clusters),
  );
  ok(
    "cluster counts sum to 100",
    alloc.clusters.reduce((a, b) => a + b, 0) === 100,
  );
}

{
  const AC = m3.contrasts.find((c) => c.id === "AC");
  const BC = m3.contrasts.find((c) => c.id === "BC");
  const AB = m3.contrasts.find((c) => c.id === "AB");

  const hAC = m3.hamd(1000, AC);
  const hBC = m3.hamd(1000, BC);
  const hAB = m3.hamd(1000, AB);
  const h2 = m2.hamd(1000, m2.contrasts[0]);

  ok("A-C uses Dunnett", hAC.critMethod.startsWith("Dunnett"), hAC.critMethod);
  ok("B-C uses Dunnett", hBC.critMethod.startsWith("Dunnett"), hBC.critMethod);
  ok(
    "A-B flagged exploratory",
    hAB.critMethod.includes("exploratory"),
    hAB.critMethod,
  );

  // The headline cost of the third arm: at fixed total N, 1:1:1 puts fewer patients in
  // each compared pair than the two-arm 3:1 split (harmonic 333 vs 375).
  ok(
    "3-arm A-C MDE worse than 2-arm 3:1 MDE",
    hAC.mde > h2.mde,
    `${hAC.mde.toFixed(4)} vs ${h2.mde.toFixed(4)} (+${((hAC.mde / h2.mde - 1) * 100).toFixed(1)}%)`,
  );

  // A-C and B-C are symmetric under 1:1:1 only when the cluster count divides evenly.
  // At N=1000 the apportionment is 34/33/33, so arm A carries one extra cluster and the
  // two contrasts legitimately differ. N=990 gives 99 clusters -> a clean 33/33/33.
  const even = m3.allocation(990);
  ok(
    "990 patients -> 33/33/33 clusters",
    JSON.stringify(even.clusters) === "[33,33,33]",
    JSON.stringify(even.clusters),
  );
  close(
    "A-C and B-C MDE equal at 33/33/33",
    m3.hamd(990, AC).mde,
    m3.hamd(990, BC).mde,
    1e-12,
  );
  ok(
    "A-C beats B-C at 34/33/33 (A holds the spare cluster)",
    hAC.mde < hBC.mde,
    `${hAC.mde.toFixed(4)} vs ${hBC.mde.toFixed(4)}`,
  );

  // A-B has the same sample sizes but a smaller critical value (unadjusted), so its
  // MDE must be slightly smaller, differing only through the critical value.
  ok(
    "A-B MDE differs from A-C only via crit",
    Math.abs(
      hAB.mde / hAC.mde -
        (m3.zUnadjusted + m3.zBeta) / (m3.zDunnett + m3.zBeta),
    ) < 1e-9,
    `ratio ${(hAB.mde / hAC.mde).toFixed(6)}`,
  );

  // Dunnett must beat Bonferroni over 3 pairwise tests.
  const mB = createModel({ ...three, multiplicity: "bonferroni" });
  const hB = mB.hamd(1000, AC);
  ok(
    "Dunnett MDE better than Bonferroni MDE",
    hAC.mde < hB.mde,
    `${hAC.mde.toFixed(4)} vs ${hB.mde.toFixed(4)}`,
  );

  const mN = createModel({ ...three, multiplicity: "none" });
  const hN = mN.hamd(1000, AC);
  ok(
    "unadjusted MDE better than Dunnett MDE",
    hN.mde < hAC.mde,
    `${hN.mde.toFixed(4)} vs ${hAC.mde.toFixed(4)}`,
  );
}

{
  // ICC substudy: arms A+B in three-arm mode, arm A only in two-arm mode.
  const i3 = m3.icc(1000);
  const i2 = m2.icc(1000);
  ok(
    "3-arm ICC substudy draws on A and B",
    i3.armKeys.join("+") === "A+B",
    i3.armKeys.join("+"),
  );
  ok(
    "2-arm ICC substudy draws on A only",
    i2.armKeys.join("+") === "A",
    i2.armKeys.join("+"),
  );

  // 67 of 100 clusters vs 75 of 100: slightly fewer observations, slightly wider CI.
  ok(
    "3-arm ICC has fewer observations than 2-arm 3:1",
    i3.nObservations < i2.nObservations,
    `${i3.nObservations} vs ${i2.nObservations}`,
  );
  ok(
    "3-arm ICC CI wider than 2-arm 3:1",
    i3.ciHalfWidth > i2.ciHalfWidth,
    `${i3.ciHalfWidth.toFixed(4)} vs ${i2.ciHalfWidth.toFixed(4)}`,
  );

  // Arm A alone (a third of the sample) would be materially worse than A+B.
  const mAonly = createModel({
    ...three,
    allocA: 1,
    allocB: 0.0001,
    allocC: 1,
  });
  ok(
    "A+B beats what arm A alone would give",
    i3.ciHalfWidth < mAonly.icc(1000).ciHalfWidth * 1.5,
  );
}

{
  // Allocation must actually move the numbers.
  // Single site: this asserts the allocation PRIMITIVE turns 2:1:2 into 40/20/40, which
  // is a statement about largest-remainder apportionment, not about stratification.
  const heavy = createModel({
    ...three,
    allocA: 2,
    allocB: 1,
    allocC: 2,
    siteRoster: ONE_SITE,
  });
  const alloc = heavy.allocation(1000);
  ok(
    "2:1:2 -> 40/20/40",
    JSON.stringify(alloc.clusters) === "[40,20,40]",
    JSON.stringify(alloc.clusters),
  );
  ok(
    "unequal allocation changes the Dunnett lambdas",
    Math.abs(heavy.activeLambdas[0] - heavy.activeLambdas[1]) > 1e-6,
    heavy.activeLambdas.map((l) => l.toFixed(4)).join(", "),
  );
}

{
  // Small-sample correction: raises the critical value, more so with fewer clusters.
  const mT = createModel({ ...three, smallSampleT: true });
  const AC = mT.contrasts.find((c) => c.id === "AC");
  const cSmall = mT.critInfo(AC, 400).z; // 40 clusters, df 37
  const cLarge = mT.critInfo(AC, 1300).z; // 130 clusters, df 127
  const cNone = m3.critInfo(AC, 400).z;
  ok(
    "t correction inflates the critical value",
    cSmall > cNone,
    `${cSmall.toFixed(4)} vs ${cNone.toFixed(4)}`,
  );
  ok(
    "t correction shrinks as clusters grow",
    cSmall > cLarge,
    `${cSmall.toFixed(4)} vs ${cLarge.toFixed(4)}`,
  );
  ok("df = clusters - arms", mT.dfFor(1000) === 97, String(mT.dfFor(1000)));

  // At the 100-clinician design point the correction is minor, but it is NOT negligible
  // at the small end of the sweep: 40 clusters across 3 arms leaves df 37, where the
  // normal approximation is roughly 5% anti-conservative.
  const atDesign = mT.critInfo(AC, 1000).z / m3.critInfo(AC, 1000).z - 1;
  const atSmall = cSmall / cNone - 1;
  ok(
    "t correction < 2% at the 100-clinician design point",
    atDesign < 0.02,
    `${(atDesign * 100).toFixed(2)}%`,
  );
  ok(
    "t correction is material at 40 clusters",
    atSmall > 0.03,
    `${(atSmall * 100).toFixed(2)}%`,
  );
}

{
  // Power readout must be self-consistent with the MDE: feeding the MDE back in
  // should return exactly the nominal power.
  const AC = m3.contrasts.find((c) => c.id === "AC");
  const h = m3.hamd(1000, AC);
  const p = m3.hamdPower(1000, AC, h.mde);
  close("power(MDE) == nominal power", p, three.power, 1e-9);
  ok(
    "power below MDE is under nominal",
    m3.hamdPower(1000, AC, h.mde * 0.5) < three.power,
  );
  ok(
    "power above MDE is over nominal",
    m3.hamdPower(1000, AC, h.mde * 1.5) > three.power,
  );
}

{
  // MDE must fall monotonically as N grows, for every contrast.
  let mono = true;
  for (const c of m3.contrasts) {
    let prev = Infinity;
    for (let n = 400; n <= 1300; n += 100) {
      const v = m3.hamd(n, c).mde;
      if (v > prev) mono = false;
      prev = v;
    }
  }
  ok("HAM-D MDE decreases with N for all contrasts", mono);
}

// ---------------------------------------------------------------------------
section("6. Exploratory framing and precision");
// ---------------------------------------------------------------------------

{
  const conf = createModel({ ...baseSettings, designArms: 3, alpha: 0.05 });
  const expl = createModel({
    ...baseSettings,
    designArms: 3,
    alpha: 0.05,
    analysisFraming: "exploratory",
  });
  const cAC = conf.contrasts.find((c) => c.id === "AC");
  const eAC = expl.contrasts.find((c) => c.id === "AC");

  ok(
    "exploratory drops the arm-level adjustment",
    expl.hamd(1000, eAC).critMethod.startsWith("exploratory"),
    expl.hamd(1000, eAC).critMethod,
  );
  ok(
    "exploratory MDE beats the Dunnett-adjusted MDE",
    expl.hamd(1000, eAC).mde < conf.hamd(1000, cAC).mde,
    `${expl.hamd(1000, eAC).mde.toFixed(3)} vs ${conf.hamd(1000, cAC).mde.toFixed(3)}`,
  );

  // The headline point: the standard error - the thing that actually determines how
  // precisely the effect is estimated - is identical across framings. Only the critical
  // value multiplying it changes.
  close(
    "SE is identical across framings",
    expl.hamd(1000, eAC).se,
    conf.hamd(1000, cAC).se,
    1e-12,
  );
  close(
    "SE unchanged by alpha",
    createModel({ ...baseSettings, designArms: 3, alpha: 0.01 }).hamd(1000, cAC)
      .se,
    conf.hamd(1000, cAC).se,
    1e-12,
  );
  close(
    "SE unchanged by multiplicity choice",
    createModel({
      ...baseSettings,
      designArms: 3,
      alpha: 0.05,
      multiplicity: "bonferroni",
    }).hamd(1000, cAC).se,
    conf.hamd(1000, cAC).se,
    1e-12,
  );

  // CI half-width must be crit * SE, consistent with the MDE decomposition.
  const h = expl.hamd(1000, eAC);
  close("CI half-width = crit * SE", h.ciHalfWidth, h.crit * h.se, 1e-12);
  close(
    "MDE = CI half-width + zBeta * SE",
    h.mde,
    h.ciHalfWidth + expl.zBeta * h.se,
    1e-12,
  );
  ok(
    "CI half-width is narrower than the MDE",
    h.ciHalfWidth < h.mde,
    `${h.ciHalfWidth.toFixed(3)} vs ${h.mde.toFixed(3)}`,
  );

  const r = expl.retention(1000, eAC);
  close(
    "retention CI half-width = crit * SE",
    r.ciHalfWidth,
    r.crit * r.se * 100,
    1e-12,
  );

  // Two-arm mode must ignore the framing switch for multiplicity purposes (there is
  // nothing to adjust), but still report it.
  const t2 = createModel({
    ...baseSettings,
    analysisFraming: "exploratory",
  });
  close(
    "two-arm crit same under either framing",
    t2.hamd(1000, t2.contrasts[0]).crit,
    createModel(baseSettings).hamd(1000, t2.contrasts[0]).crit,
    1e-12,
  );
}

// ---------------------------------------------------------------------------
section("7. Shipped defaults");
// ---------------------------------------------------------------------------
// Pins what the app actually opens with, so a default change shows up here as an
// explicit diff rather than silently moving every headline number in the grant.

{
  ok(
    "default design is 2-arm",
    defaults.designArms === 2,
    String(defaults.designArms),
  );
  ok(
    "default cluster size CV is 0.2 (low)",
    defaults.clusterSizeCV === 0.2,
    String(defaults.clusterSizeCV),
  );
  ok(
    "small-sample t on by default",
    defaults.smallSampleT === true,
    String(defaults.smallSampleT),
  );
  ok(
    "default arm multiplicity is Dunnett",
    defaults.multiplicity === "dunnett",
    defaults.multiplicity,
  );
  ok("default alpha", defaults.alpha === 0.05, String(defaults.alpha));
  ok(
    "default framing is exploratory",
    defaults.analysisFraming === "exploratory",
    defaults.analysisFraming,
  );
  ok(
    "charts default to precision",
    defaults.chartMetric === "precision",
    defaults.chartMetric,
  );

  const dm = createModel(defaults);
  const n = defaults.nClinicians * defaults.patientsPerCluster;
  const h = dm.hamd(n, dm.contrasts[0]);
  close("default 2-arm HAM-D MDE at N=1000", h.mde, 1.39, 0.02);
  close(
    "default 2-arm HAM-D CI half-width at N=1000",
    h.ciHalfWidth,
    0.976,
    0.02,
  );

  const d3 = createModel({ ...defaults, designArms: 3 });
  const AC = d3.contrasts.find((c) => c.id === "AC");
  const h3 = d3.hamd(n, AC);
  ok(
    "default measurement model is MFRM",
    defaults.measurementModel === "mfrm",
    defaults.measurementModel,
  );
  {
    // The MFRM gain is an assumption, so pin its size: ~11.7% off the error variance,
    // ~6% off the MDE against a sum score. If either drifts, that is a real change to
    // what the grant is claiming.
    const dm = createModel(defaults);
    const sum = createModel({ ...defaults, measurementModel: "sum" });
    const c = dm.contrasts[0];
    close(
      "MFRM variance multiplier",
      dm.measurementVarianceMultiplier,
      0.8835,
      1e-9,
    );
    const gain = 1 - dm.hamd(1000, c).mde / sum.hamd(1000, c).mde;
    close("MFRM improves the MDE ~6% vs sum score", gain, 0.06, 0.005);
    ok(
      "sum-score baseline is still reported for comparison",
      dm.hamd(1000, c).baselineMDE > dm.hamd(1000, c).mde,
      `${dm.hamd(1000, c).baselineMDE.toFixed(3)} vs ${dm.hamd(1000, c).mde.toFixed(3)}`,
    );
  }
  ok(
    "default randomization is hybrid",
    defaults.randomization === "hybrid",
    defaults.randomization,
  );
  close("default 3-arm A-C HAM-D MDE at N=1000", h3.mde, 1.405, 0.02);
  close(
    "default 3-arm A-C CI half-width at N=1000",
    h3.ciHalfWidth,
    0.986,
    0.02,
  );
  ok(
    "3-arm still costs more than 2-arm under the shipped defaults",
    h3.mde > h.mde,
    `${h3.mde.toFixed(3)} vs ${h.mde.toFixed(3)} (+${((h3.mde / h.mde - 1) * 100).toFixed(1)}%)`,
  );
}

// ---------------------------------------------------------------------------
section("7g. ICC substudy confidence level");
// ---------------------------------------------------------------------------
// The panel used to hardcode 1.96 (and a "95%" label) while every other panel followed
// alpha, so setting alpha = 0.01 produced a page reporting 99% intervals everywhere
// except here. It is an estimation objective, so it takes no MULTIPLICITY adjustment -
// which is not the same thing as always being 95%.

{
  const base = { ...defaults, siteRoster: DEFAULT_ROSTER };
  const N = defaults.nClinicians * defaults.patientsPerCluster;

  // The label and the number come from one value, so they cannot drift apart.
  const d = createModel(base).icc(N);
  close(
    "crit is consistent with the half-width",
    d.ciHalfWidth / d.seIcc,
    d.crit,
    1e-12,
  );

  // Without the t correction the critical value is exactly the two-sided normal quantile.
  const noT = createModel({ ...base, smallSampleT: false }).icc(N);
  close(
    "no t: crit is the unadjusted normal quantile",
    noT.crit,
    normInv(1 - defaults.alpha / 2),
    1e-12,
  );

  // With it on (the shipped default) it is the t at the same tail, so slightly wider.
  const df = Math.round(N / defaults.patientsPerCluster) - 2;
  close(
    "t on: crit is t at the same tail",
    d.crit,
    tQuantile(0.975, df),
    1e-12,
  );
  ok(
    "t correction widens the interval",
    d.crit > noT.crit,
    `${d.crit.toFixed(4)} > ${noT.crit.toFixed(4)}`,
  );
  ok(
    "crit is labelled with its df",
    d.critMethod === `unadjusted, t(${df})`,
    d.critMethod,
  );

  // The whole point: alpha moves the interval, and moves it by exactly the quantile ratio.
  const a01 = createModel({ ...base, smallSampleT: false, alpha: 0.01 }).icc(N);
  ok(
    "alpha 0.01 widens the ICC interval",
    a01.ciHalfWidth > noT.ciHalfWidth,
    `${a01.ciHalfWidth.toFixed(4)} vs ${noT.ciHalfWidth.toFixed(4)}`,
  );
  close(
    "half-width scales exactly with the critical value",
    a01.ciHalfWidth / noT.ciHalfWidth,
    normInv(1 - 0.01 / 2) / normInv(1 - defaults.alpha / 2),
    1e-12,
  );
  close("standard error is untouched by alpha", a01.seIcc, noT.seIcc, 1e-12);

  // No arm-level multiplicity may leak in: three arms, confirmatory, every rule.
  const three = { ...base, designArms: 3, analysisFraming: "confirmatory" };
  const widths = ["dunnett", "bonferroni", "none"].map(
    (multiplicity) =>
      createModel({ ...three, multiplicity }).icc(N).ciHalfWidth,
  );
  ok(
    "multiplicity rule does not touch the ICC interval",
    Math.abs(widths[0] - widths[1]) < 1e-12 &&
      Math.abs(widths[1] - widths[2]) < 1e-12,
    widths.map((w) => w.toFixed(6)).join(" / "),
  );
}

// ---------------------------------------------------------------------------
section("7b. Hybrid cluster-individual randomization");
// ---------------------------------------------------------------------------

{
  // Single site throughout: this section compares randomization SCHEMES against each
  // other, and site stratification would perturb both in ways unrelated to the claim.
  const base = {
    ...defaults,
    designArms: 3,
    analysisFraming: "confirmatory",
    multiplicity: "none",
    siteRoster: ONE_SITE,
  };
  const cl = createModel({ ...base, randomization: "cluster" });
  const hy = createModel({ ...base, randomization: "hybrid" });
  const N = 1000;
  const pick = (m, id) => m.contrasts.find((c) => c.id === id);

  // Structure: hybrid randomizes clinicians to ROM vs no-ROM only, so there are two
  // randomization units rather than three.
  {
    const a = hy.allocation(N);
    ok(
      "hybrid uses 2 randomization units",
      a.groupClusters.length === 2,
      JSON.stringify(a.groupClusters),
    );
    ok(
      "cluster mode uses 3",
      cl.allocation(N).groupClusters.length === 3,
      JSON.stringify(cl.allocation(N).groupClusters),
    );
    ok(
      "hybrid clinicians split ROM vs no-ROM by patient share",
      a.groupClusters[0] === 33 && a.groupClusters[1] === 67,
      JSON.stringify(a.groupClusters),
    );
    ok(
      "B and C sit in the same clinicians",
      a.clusters[1] === a.clusters[2] && a.clusters[1] === a.groupClusters[1],
      `B=${a.clusters[1]} C=${a.clusters[2]}`,
    );
    ok(
      "a no-ROM clinician splits its panel between B and C",
      Math.abs(
        a.armClusterSize[1] + a.armClusterSize[2] - defaults.patientsPerCluster,
      ) < 1e-9,
      `${a.armClusterSize[1]} + ${a.armClusterSize[2]}`,
    );
    ok(
      "patients still total N",
      Math.abs(a.randomized.reduce((x, y) => x + y, 0) - N) < 1e-9,
      String(a.randomized.reduce((x, y) => x + y, 0)),
    );
  }

  // Contrast typing: only B vs C is within-cluster.
  ok(
    "A vs C stays between-cluster",
    hy.hamd(N, pick(hy, "AC")).withinCluster === false,
  );
  ok(
    "B vs C becomes within-cluster",
    hy.hamd(N, pick(hy, "BC")).withinCluster === true,
  );
  ok(
    "A vs B stays between-cluster",
    hy.hamd(N, pick(hy, "AB")).withinCluster === false,
  );
  ok(
    "cluster mode has no within-cluster contrast",
    cl.contrasts.every((c) => cl.hamd(N, c).withinCluster === false),
  );

  // The payoff: B vs C loses the between-clinician variance.
  {
    const hyBC = hy.hamd(N, pick(hy, "BC")).mde;
    const clBC = cl.hamd(N, pick(cl, "BC")).mde;
    ok(
      "hybrid improves the B vs C MDE",
      hyBC < clBC,
      `${hyBC.toFixed(3)} vs ${clBC.toFixed(3)} (${((hyBC / clBC - 1) * 100).toFixed(1)}%)`,
    );
    // With ICC 0, there is no between-cluster variance to remove, so the two schemes
    // must agree on the within-cluster contrast. This is the sharpest check that the
    // gain is coming from the ICC and not from an arithmetic slip.
    const cl0 = createModel({
      ...base,
      randomization: "cluster",
      iccHamd: 0,
      clusterSizeCV: 0,
    });
    const hy0 = createModel({
      ...base,
      randomization: "hybrid",
      iccHamd: 0,
      clusterSizeCV: 0,
    });
    // Compare at N=990: 99 clinicians divide evenly both ways (cluster 33/33/33 -> 330
    // per arm; hybrid 33/66 -> 66 x 5 = 330 per arm), so the two schemes hold identical
    // sample sizes and any remaining difference must come from the clustering term alone.
    // At N=1000 the apportionments differ (330 vs 335) and would mask the comparison.
    {
      const aC = cl0.allocation(990);
      const aH = hy0.allocation(990);
      ok(
        "at N=990 both schemes give identical per-arm N",
        aC.randomized[1] === aH.randomized[1] &&
          aC.randomized[2] === aH.randomized[2],
        `cluster ${aC.randomized[1]}/${aC.randomized[2]} vs hybrid ${aH.randomized[1]}/${aH.randomized[2]}`,
      );
      close(
        "with ICC=0 hybrid and cluster agree on B vs C",
        hy0.hamd(990, pick(hy0, "BC")).se,
        cl0.hamd(990, pick(cl0, "BC")).se,
        1e-12,
      );
      // And with ICC > 0 at that same N, hybrid must be strictly better.
      const clP = createModel({
        ...base,
        randomization: "cluster",
        clusterSizeCV: 0,
      });
      const hyP = createModel({
        ...base,
        randomization: "hybrid",
        clusterSizeCV: 0,
      });
      ok(
        "with ICC>0 at N=990 hybrid strictly beats cluster on B vs C",
        hyP.hamd(990, pick(hyP, "BC")).se < clP.hamd(990, pick(clP, "BC")).se,
        `${hyP.hamd(990, pick(hyP, "BC")).se.toFixed(4)} vs ${clP.hamd(990, pick(clP, "BC")).se.toFixed(4)}`,
      );
    }
    // And the gain must grow with the ICC.
    const gain = (icc) => {
      const c = createModel({
        ...base,
        randomization: "cluster",
        iccHamd: icc,
      });
      const h = createModel({ ...base, randomization: "hybrid", iccHamd: icc });
      return 1 - h.hamd(N, pick(h, "BC")).se / c.hamd(N, pick(c, "BC")).se;
    };
    ok(
      "hybrid gain on B vs C grows with ICC",
      gain(0.08) > gain(0.02),
      `${(gain(0.08) * 100).toFixed(1)}% vs ${(gain(0.02) * 100).toFixed(1)}%`,
    );
  }

  // The within-cluster variance factor must be exactly (1 - ICC) * (1/n1 + 1/n2).
  {
    // Sum score pinned locally: this checks the clustering algebra, and the default
    // MFRM multiplier would otherwise have to be threaded through the expected value.
    const hySum = createModel({
      ...base,
      randomization: "hybrid",
      measurementModel: "sum",
    });
    const a = hySum.allocation(N);
    const BC = pick(hySum, "BC");
    const h = hySum.hamd(N, BC);
    const n1 = a.completers[1];
    const n2 = a.completers[2];
    const expected = Math.sqrt(
      ((49 * (1 - defaults.r2Hamd) * 1.2) / 1.43) *
        (1 - defaults.iccHamd) *
        (1 / n1 + 1 / n2),
    );
    close(
      "within-cluster SE = sqrt(V (1-ICC)(1/n1+1/n2))",
      h.se,
      expected,
      1e-12,
    );
  }

  // Spreading control patients across more clinicians also helps the between-cluster
  // contrasts a little, because each clinician now contributes fewer control patients.
  {
    const hyAC = hy.hamd(N, pick(hy, "AC")).mde;
    const clAC = cl.hamd(N, pick(cl, "AC")).mde;
    ok(
      "hybrid also helps A vs C slightly",
      hyAC < clAC,
      `${hyAC.toFixed(3)} vs ${clAC.toFixed(3)}`,
    );
  }

  // Retention should show the same structure on its own ICC.
  ok(
    "retention B vs C is within-cluster under hybrid",
    hy.retention(N, pick(hy, "BC")).withinCluster === true,
  );
  ok(
    "hybrid improves the retention B vs C MDE",
    hy.retention(N, pick(hy, "BC")).mde < cl.retention(N, pick(cl, "BC")).mde,
    `${hy.retention(N, pick(hy, "BC")).mde.toFixed(2)} vs ${cl.retention(N, pick(cl, "BC")).mde.toFixed(2)} pp`,
  );

  // Two-arm designs must ignore the setting entirely - there is no second unit to split.
  {
    const t2a = createModel({
      ...defaults,
      designArms: 2,
      randomization: "hybrid",
    });
    const t2b = createModel({
      ...defaults,
      designArms: 2,
      randomization: "cluster",
    });
    close(
      "two-arm ignores the randomization setting",
      t2a.hamd(N, t2a.contrasts[0]).se,
      t2b.hamd(N, t2b.contrasts[0]).se,
      1e-12,
    );
  }

  // The ICC substudy gains too: the same AURORA users spread over more clinicians.
  {
    const hi = hy.icc(N);
    const ci = cl.icc(N);
    ok(
      "hybrid spreads ICC observations over more clinicians",
      hi.nTreatmentClusters > ci.nTreatmentClusters,
      `${hi.nTreatmentClusters} vs ${ci.nTreatmentClusters}`,
    );
    ok(
      "hybrid tightens the ICC interval",
      hi.ciHalfWidth < ci.ciHalfWidth,
      `${hi.ciHalfWidth.toFixed(4)} vs ${ci.ciHalfWidth.toFixed(4)}`,
    );
  }

  // Memo allocations B.1 / B.2 / B.3 must all be representable and internally consistent.
  for (const [name, w] of [
    ["B.1 33/33/33", [1, 1, 1]],
    ["B.2 50/25/25", [2, 1, 1]],
    ["B.3 40/30/30", [4, 3, 3]],
  ]) {
    const m = createModel({
      ...base,
      randomization: "hybrid",
      allocA: w[0],
      allocB: w[1],
      allocC: w[2],
    });
    const a = m.allocation(N);
    const total = a.randomized.reduce((x, y) => x + y, 0);
    const pct = a.randomized.map((n) => Math.round((n / total) * 100));
    ok(
      `${name} allocates as intended`,
      Math.abs(total - N) < 1e-9,
      `${pct.join("/")}%`,
    );
  }
}

// ---------------------------------------------------------------------------
section("7c. Pooled A+B vs C contrast");
// ---------------------------------------------------------------------------

{
  // Single site: these compare randomization SCHEMES, so site stratification would be a
  // confound rather than the thing under test.
  const mk = (o) =>
    createModel({
      ...defaults,
      designArms: 3,
      analysisFraming: "confirmatory",
      multiplicity: "none",
      siteRoster: ONE_SITE,
      ...o,
    });
  const N = 1000;
  const get = (m, id) => m.contrasts.find((c) => c.id === id);

  for (const mode of ["cluster", "hybrid"]) {
    const m = mk({ randomization: mode });
    const PC = get(m, "PC");
    const AC = get(m, "AC");
    const BC = get(m, "BC");
    const a = m.allocation(N);

    ok(`[${mode}] pooled contrast exists`, Boolean(PC), PC && PC.short);

    // Pooling must use every AURORA patient against the control arm.
    const h = m.hamd(N, PC);
    const expectedN = Math.round(
      a.completers[0] + a.completers[1] + a.completers[2],
    );
    ok(
      `[${mode}] pooled uses A+B against C`,
      h.nContrastCompleters === expectedN,
      `${h.nContrastCompleters} of ${expectedN}`,
    );

    // The whole point: pooling beats either component contrast.
    ok(
      `[${mode}] pooled retention beats A vs C`,
      m.retention(N, PC).mde < m.retention(N, AC).mde,
      `${m.retention(N, PC).mde.toFixed(2)} vs ${m.retention(N, AC).mde.toFixed(2)} pp`,
    );
    ok(
      `[${mode}] pooled retention beats B vs C`,
      m.retention(N, PC).mde < m.retention(N, BC).mde,
      `${m.retention(N, PC).mde.toFixed(2)} vs ${m.retention(N, BC).mde.toFixed(2)} pp`,
    );

    // Pooled is neither purely within- nor purely between-clinician.
    ok(
      `[${mode}] pooled is not flagged within-cluster`,
      h.withinCluster === false,
    );
    ok(
      `[${mode}] pooled flagged mixed only under hybrid`,
      h.mixedCluster === (mode === "hybrid"),
      String(h.mixedCluster),
    );
  }

  // THE key check on the derivation: pooling a single arm must reproduce the ordinary
  // pairwise factor exactly. If the variance-component form and the design-effect form
  // disagree here, the pooled maths is wrong.
  {
    for (const mode of ["cluster", "hybrid"]) {
      // Pinned at CV = 0, where the two cluster-size-variation conventions coincide.
      // The inherited pairwise design effect multiplies the WHOLE variance by (1+CV^2),
      // including the within-clinician part; the pooled/within-cluster forms apply it
      // only to the between-clinician component, which is the principled treatment.
      // At CV = 0 that difference vanishes and this isolates the algebra itself.
      const m = mk({ randomization: mode, clusterSizeCV: 0 });
      const AC = get(m, "AC");
      const solo = { id: "solo", pooled: ["A"], b: "C", family: "pooled" };
      // Reach the internals the same way the outcome functions do.
      const viaPooled = m.hamd(N, solo).se;
      const viaPairwise = m.hamd(N, AC).se;
      close(
        `[${mode}] pooling one arm reproduces the pairwise SE`,
        viaPooled,
        viaPairwise,
        1e-12,
      );
    }
  }

  // The two CV conventions differ only in how cluster-size variation is applied, and
  // only when CV > 0. Pin that the pooled form is the SMALLER (less inflated) one, so
  // the divergence is a known direction rather than a surprise.
  {
    const m = mk({ randomization: "cluster", clusterSizeCV: 0.2 });
    const solo = { id: "solo", pooled: ["A"], b: "C", family: "pooled" };
    const r = m.hamd(N, solo).se / m.hamd(N, get(m, "AC")).se;
    ok(
      "at CV>0 the pooled form is slightly less inflated than the inherited one",
      r > 0.97 && r < 1,
      `ratio ${r.toFixed(4)}`,
    );
  }

  // Under hybrid the shared B/C clinicians create a positive covariance that removes
  // part of the between-clinician variance, so pooling should do better than it would
  // if the arms were in separate clinicians at the same sample sizes.
  {
    const hy = mk({ randomization: "hybrid" });
    const cl = mk({ randomization: "cluster" });
    ok(
      "hybrid pooled contrast is at least as precise as cluster pooled",
      hy.hamd(N, get(hy, "PC")).se <= cl.hamd(N, get(cl, "PC")).se + 1e-12,
      `${hy.hamd(N, get(hy, "PC")).se.toFixed(4)} vs ${cl.hamd(N, get(cl, "PC")).se.toFixed(4)}`,
    );
  }

  // Multiplicity: the pooled view must not inflate the Bonferroni divisor, since it is
  // reported instead of the decomposition rather than alongside it.
  {
    const mB = mk({ multiplicity: "bonferroni", alpha: 0.05 });
    const expected = normInv(1 - 0.05 / (2 * 3));
    close(
      "pooled contrast does not inflate Bonferroni m",
      mB.zBonferroni,
      expected,
      1e-12,
    );
  }

  // With ICC = 0 there is no clustering at all, so pooling is exactly the two-sample
  // result on the merged arm.
  {
    // Sum score pinned for the same reason as above.
    const m = mk({
      randomization: "hybrid",
      iccHamd: 0,
      clusterSizeCV: 0,
      measurementModel: "sum",
      siteRoster: ONE_SITE,
    });
    const PC = get(m, "PC");
    const a = m.allocation(N);
    const nAB = a.completers[0] + a.completers[1];
    const nC = a.completers[2];
    const V = (49 * (1 - defaults.r2Hamd) * 1.2) / 1.43;
    close(
      "ICC=0 pooled equals the plain two-sample SE",
      m.hamd(N, PC).se,
      Math.sqrt(V * (1 / nAB + 1 / nC)),
      1e-12,
    );
  }
}

// ---------------------------------------------------------------------------
section("7d. Effect sizes (Cohen's d and h)");
// ---------------------------------------------------------------------------

{
  // Cohen's h against hand-computed values.
  // Reference values computed independently in R: 2*asin(sqrt(p)) differences.
  close("cohensH(0.30, 0.24)", cohensH(0.3, 0.24), 0.1353341046, 1e-9);
  close("cohensH(0.05, 0.10)", cohensH(0.05, 0.1), 0.192474297, 1e-9);
  close("cohensH(0.45, 0.50)", cohensH(0.45, 0.5), 0.1001674212, 1e-9);
  close("cohensH(p, p) = 0", cohensH(0.3, 0.3), 0, 1e-15);
  close("cohensH is symmetric", cohensH(0.2, 0.4), cohensH(0.4, 0.2), 1e-15);
  close("cohensH(0, 1) is its maximum, pi", cohensH(0, 1), Math.PI, 1e-12);

  // The reason d cannot be reused for proportions: the same absolute gap is a much
  // larger effect near the boundary than in the middle of the range. A d-style
  // "difference over a fixed SD" would report these as identical.
  {
    const nearEdge = cohensH(0.05, 0.1);
    const nearMid = cohensH(0.45, 0.5);
    ok(
      "same 5pp gap gives a larger h near the boundary",
      nearEdge > nearMid * 1.9,
      `${nearEdge.toFixed(4)} at 5->10% vs ${nearMid.toFixed(4)} at 45->50%`,
    );
  }

  const m = createModel({ ...defaults, designArms: 3 });
  const N = 1000;
  for (const c of m.contrasts) {
    const h = m.hamd(N, c);
    const r = m.retention(N, c);
    close(`[${c.short}] d = MDE / 7`, h.effectSize, h.mde / 7, 1e-12);
    close(
      `[${c.short}] CI d = CI half-width / 7`,
      h.ciEffectSize,
      h.ciHalfWidth / 7,
      1e-12,
    );
    close(
      `[${c.short}] retention h matches its two rates`,
      r.effectSizeH,
      cohensH(
        defaults.controlAttrition,
        defaults.controlAttrition - r.mde / 100,
      ),
      1e-12,
    );
    ok(
      `[${c.short}] CI h is smaller than MDE h`,
      r.ciEffectSizeH < r.effectSizeH,
      `${r.ciEffectSizeH.toFixed(3)} vs ${r.effectSizeH.toFixed(3)}`,
    );
  }

  // Effect sizes must move with the underlying quantity, not drift independently.
  {
    const small = createModel({ ...defaults, designArms: 3, nClinicians: 150 });
    const big = createModel({ ...defaults, designArms: 3, nClinicians: 60 });
    const c = (mm) => mm.contrasts.find((x) => x.id === "AC");
    ok(
      "larger N gives a smaller detectable d",
      small.hamd(1500, c(small)).effectSize < big.hamd(600, c(big)).effectSize,
    );
    ok(
      "larger N gives a smaller detectable h",
      small.retention(1500, c(small)).effectSizeH <
        big.retention(600, c(big)).effectSizeH,
    );
  }
}

// ---------------------------------------------------------------------------
section("7f. Site-stratified randomization");
// ---------------------------------------------------------------------------

{
  // THE reduction property. Stratified pooling must collapse to the one-pool formula when
  // there is one stratum, otherwise the generalization is wrong rather than the old code.
  {
    let worst = 0;
    const keys = [];
    for (const arms of [2, 3])
      for (const rnd of ["cluster", "hybrid"])
        for (const share of [0, 0.2]) {
          const cfg = {
            ...defaults,
            designArms: arms,
            randomization: rnd,
            mixedShare: share,
            siteRoster: ONE_SITE,
            clusterSizeCV: 0.2,
          };
          const m = createModel(cfg);
          // One site of N clinicians and one pool of N clinicians must agree exactly.
          const a = m.allocation(1000);
          if (a.sites.length !== 1) worst = Infinity;
          for (const c of m.contrasts) {
            const h = m.hamd(1000, c);
            const r = m.retention(1000, c);
            if (!Number.isFinite(h.mde) || !Number.isFinite(r.mde))
              worst = Infinity;
          }
          keys.push(`${arms}arm/${rnd}`);
        }
    ok(
      "one-site roster yields a single stratum everywhere",
      worst === 0,
      keys.join(" "),
    );
  }

  // cvBetween is exactly zero for one site, so cvTotal reduces to the assumed parameter.
  {
    const one = parseRoster(ONE_SITE);
    close("cvBetween is 0 for a single site", cvBetween(one), 0, 1e-15);
  }

  // Roster parsing and bounds.
  {
    ok(
      "eTable 1 roster round-trips",
      formatRoster(parseRoster(formatRoster(DEFAULT_ROSTER))) ===
        formatRoster(DEFAULT_ROSTER),
    );
    ok(
      "eTable 1 totals 111 clinicians",
      totalClinicians(DEFAULT_ROSTER) === 111,
      String(totalClinicians(DEFAULT_ROSTER)),
    );
    for (const bad of [
      "abc",
      "0-5",
      "5-10",
      "",
      "1-",
      "-1",
      "1.2",
      "1-1..2-2",
    ]) {
      ok(`rejects ${JSON.stringify(bad)}`, parseRoster(bad) === null);
    }
    ok("accepts a well-formed roster", parseRoster("140-14.70-7") !== null);
  }

  // Scaling preserves the total exactly and keeps site shape.
  {
    let exact = true;
    for (const target of [40, 60, 100, 111, 150]) {
      const sc = scaleRoster(DEFAULT_ROSTER, target);
      if (totalClinicians(sc) !== target) exact = false;
    }
    ok("scaleRoster hits the target total exactly", exact);
    const at100 = scaleRoster(DEFAULT_ROSTER, 100);
    ok(
      "scaling preserves relative site sizes",
      at100[0].clinicians > at100[6].clinicians,
      at100.map((x) => x.clinicians).join(","),
    );
  }

  // The between-site CV computed from eTable 1, and why it cannot replace the parameter.
  {
    close(
      "cvBetween(eTable 1) = 0.0378",
      cvBetween(DEFAULT_ROSTER),
      0.0378,
      5e-5,
    );
    const cvSite = cvBetween(DEFAULT_ROSTER);
    const combined = Math.sqrt(cvSite * cvSite + 0.2 * 0.2);
    close("combined CV = 0.2035", combined, 0.2035, 5e-4);
    // The roster alone accounts for almost none of the assumed inflation - which is the
    // documented reason clusterSizeCV survives rather than being replaced by the roster.
    ok(
      "roster alone does not reproduce the assumed inflation",
      1 + cvSite * cvSite < 1.002 && 1 + 0.2 * 0.2 === 1.04,
      `roster gives ${(1 + cvSite * cvSite).toFixed(5)}, assumption gives 1.04`,
    );
  }

  // Tie-break rotation. Without it, a 6-clinician site at 3:1 is an exact 4.5/1.5 tie that
  // always resolves the same way, and the bias accumulates across sites.
  {
    const roster = scaleRoster(DEFAULT_ROSTER, 100);
    const rotated = allocateRoster(roster, [3, 1]);
    const shareTx = (100 * rotated.aggregate[0]) / rotated.total;

    // Exact ties must alternate rather than all resolving the same way. Five sites of 6
    // clinicians split 4.5/1.5, so rotation should hand three to one arm and two to the
    // other, not five to one.
    const tieCells = roster
      .map((st, i) => ({ st, i }))
      .filter(
        ({ st }) =>
          Math.abs(
            (st.clinicians * 3) / 4 - Math.floor((st.clinicians * 3) / 4) - 0.5,
          ) < 1e-9,
      )
      .map(({ st, i }) => allocateClusters(st.clinicians, [3, 1], i)[0]);
    const hi = tieCells.filter((c) => c === Math.max(...tieCells)).length;
    ok(
      "exact ties alternate between arms",
      tieCells.length > 1 && hi < tieCells.length,
      `${tieCells.length} tie sites -> ${tieCells.join(",")}`,
    );

    // The residual drift is NOT a tie-break artefact: every site's exact 3:1 split leaves
    // a 0.75 fraction, so largest-remainder legitimately awards the odd clinician to the
    // larger arm at every site. Extreme ratios therefore drift more under stratification
    // than balanced ones, which is a real property rather than something to correct.
    close("3:1 realized share is 77%", shareTx, 77, 0.5);
    // Pin the fixed-tie-break failure mode so a regression is caught.
    const fixed = roster.map((st) =>
      allocateClusters(st.clinicians, [3, 1], 0),
    );
    const fixedTx = fixed.reduce((a, c) => a + c[0], 0);
    ok(
      "fixed tie-break would over-allocate (documents the bug)",
      fixedTx > rotated.aggregate[0],
      `fixed ${fixedTx} vs rotated ${rotated.aggregate[0]}`,
    );
  }

  // Realized vs nominal allocation, and the direction is NOT predictable: at 111
  // clinicians B.3 over-allocates to ROM, at 100 it under-allocates.
  {
    const at111 = allocateRoster(DEFAULT_ROSTER, [4, 6]);
    const at100 = allocateRoster(scaleRoster(DEFAULT_ROSTER, 100), [4, 6]);
    ok(
      "drift direction depends on the roster, not just the ratio",
      at111.shares[0] > 0.4 && at100.shares[0] < 0.4,
      `111 -> ${(at111.shares[0] * 100).toFixed(1)}%, 100 -> ${(at100.shares[0] * 100).toFixed(1)}%`,
    );
  }

  // Feasibility flags: singletons are non-monotonic in the target share.
  {
    const roster = scaleRoster(DEFAULT_ROSTER, 111);
    const singles = (share) => {
      const M = Math.round(share * 111);
      const P = 0.4 * (111 - M);
      const K = 0.6 * (111 - M);
      return feasibility(
        roster,
        [P, M, K],
        ["pure", "mixed", "no-ROM"],
      ).singleton.filter((x) => x.cell === "mixed").length;
    };
    const a = singles(0.15),
      b = singles(0.2);
    ok(
      "singleton count is non-monotonic in the mixed share",
      a > 0 && b === 0,
      `0.15 -> ${a} singleton sites, 0.20 -> ${b}`,
    );
  }

  // Every site allocation must exhaust that site's clinicians.
  {
    const roster = scaleRoster(DEFAULT_ROSTER, 100);
    const r = allocateRoster(roster, [4, 3, 3]);
    const exact = r.perSite.every(
      (cells, i) => cells.reduce((a, b) => a + b, 0) === roster[i].clinicians,
    );
    ok("per-site cells exhaust each site", exact);
    ok(
      "aggregate equals the requested total",
      r.total === 100,
      String(r.total),
    );
  }
}

// ---------------------------------------------------------------------------
section("7e. Spillover substudy (mixed panels)");
// ---------------------------------------------------------------------------

{
  const mk = (o) =>
    createModel({
      ...defaults,
      designArms: 3,
      randomization: "hybrid",
      allocA: 4,
      allocB: 3,
      allocC: 3,
      nClinicians: 100,
      ...o,
    });
  const m = mk({});
  const N = 1000;

  // THE property the design rests on: M changes only the ARRANGEMENT of patients across
  // clinicians, never the arm allocation. If this fails, the design is not free.
  {
    const ref = m.spillover(N, 0);
    let allSame = true,
      allJ = true;
    const seen = [];
    for (const sh of [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35]) {
      const r = m.spillover(N, sh);
      seen.push(`${r.M}:[${r.patients}]`);
      if (r.patients.some((x, i) => Math.abs(x - ref.patients[i]) > 1))
        allSame = false;
      if (Math.abs(r.totalClinicians - 100) > 1) allJ = false;
    }
    ok(
      "arm allocation is invariant to M",
      allSame,
      seen.slice(0, 4).join("  "),
    );
    ok("clinician total is invariant to M", allJ);
    ok(
      "allocation matches the 40/30/30 target",
      ref.patients[0] === 400 &&
        ref.patients[1] === 300 &&
        ref.patients[2] === 300,
      ref.patients.join("/"),
    );
  }

  // Panel compositions follow the allocation.
  {
    const r = m.spillover(N, 0.2);
    close(
      "mixed panel is 4/3/3 of 10",
      r.panelMixed.reduce((a, b) => a + b, 0),
      10,
      1e-12,
    );
    close("mixed panel A share", r.panelMixed[0], 4, 1e-12);
    close("no-ROM panel is 5/5 of 10", r.panelNoRom[0], 5, 1e-12);
    ok("P + M + K = J", r.P + r.M + r.K === 100, `${r.P}+${r.M}+${r.K}`);
  }

  // At M=0 there is nothing to compare against, so no spillover estimate exists.
  {
    const r = m.spillover(N, 0);
    ok(
      "M=0 gives no spillover estimate",
      !Number.isFinite(r.spilloverPooled.mde),
    );
    ok(
      "M=0 gives no direct-effect estimate",
      !Number.isFinite(r.directEffect.mde),
    );
    ok(
      "M=0 primary is finite",
      Number.isFinite(r.primary.mde),
      r.primary.mde.toFixed(3),
    );
  }

  // The trade-off: primary degrades monotonically, spillover improves.
  {
    let primUp = true,
      spillDown = true;
    let prevP = 0,
      prevS = Infinity;
    for (const sh of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3]) {
      const r = m.spillover(N, sh);
      if (r.primary.mde < prevP) primUp = false;
      if (sh > 0.05 && r.spilloverPooled.mde > prevS) spillDown = false;
      prevP = r.primary.mde;
      prevS = r.spilloverPooled.mde;
    }
    ok("primary contrast degrades monotonically with M", primUp);
    ok("pooled spillover improves with M", spillDown);
  }

  // Pooling the two spillover paths must beat either alone - that is why it is the
  // pre-specified test.
  {
    const r = m.spillover(N, 0.2);
    ok(
      "pooled spillover beats each single path",
      r.spilloverPooled.mde < r.spilloverB.mde &&
        r.spilloverPooled.mde < r.spilloverC.mde,
      `pooled ${r.spilloverPooled.mde.toFixed(2)} vs B ${r.spilloverB.mde.toFixed(2)} / C ${r.spilloverC.mde.toFixed(2)}`,
    );
    // B and C paths are symmetric under 40/30/30 since both arms get 30%.
    close(
      "B and C paths symmetric at equal allocation",
      r.spilloverB.mde,
      r.spilloverC.mde,
      1e-12,
    );
  }

  // Effect sizes must be consistent with the points.
  {
    const r = m.spillover(N, 0.2);
    close(
      "primary d = MDE / 7",
      r.primary.effectSize,
      r.primary.mde / 7,
      1e-12,
    );
    close(
      "spillover CI d = CI / 7",
      r.spilloverPooled.ciEffectSize,
      r.spilloverPooled.ciHalfWidth / 7,
      1e-12,
    );
    ok(
      "CI half-width is narrower than the MDE",
      r.primary.ciHalfWidth < r.primary.mde,
    );
  }

  // The headline warning: at what M does the primary interval exceed the d=0.15 effect
  // the literature expects? Pin it so the trade-off cannot drift unnoticed.
  {
    const under = [];
    for (const sh of [0, 0.1, 0.15, 0.2, 0.25, 0.3]) {
      const r = m.spillover(N, sh);
      if (r.primary.ciEffectSize < 0.15) under.push(sh);
    }
    ok(
      "primary CI stays inside d=0.15 only at low M",
      under.length > 0 && under[under.length - 1] <= 0.15,
      `shares keeping d<0.15: ${under.join(", ")}`,
    );
  }

  // Per-site practicality. The statistically cheap settings are the operationally worst
  // ones, which is the whole point of surfacing this, so pin the shape of that tension.
  {
    const bySite = (share) => m.spillover(N, share).siteSummary;
    const s10 = bySite(0.1),
      s20 = bySite(0.2),
      s30 = bySite(0.3);
    ok(
      "at a low mixed share every site is a singleton",
      s10.ok === 0 && s10.single === 11,
      `${s10.ok} ok / ${s10.single} single`,
    );
    ok(
      "usable completers are zero when every site is a singleton",
      s10.usableCellCompleters === 0 && s10.totalCellCompleters > 0,
      `${s10.usableCellCompleters} usable of ${s10.totalCellCompleters.toFixed(1)}`,
    );
    ok(
      "raising the mixed share converts singletons into usable sites",
      s20.ok > s10.ok && s30.ok > s20.ok,
      `${s10.ok} -> ${s20.ok} -> ${s30.ok}`,
    );
    ok(
      "only the highest share clears every site",
      s30.single === 0 && s20.single > 0,
      `0.20 leaves ${s20.single} singletons, 0.30 leaves ${s30.single}`,
    );
    // Every site's cells must exhaust its clinicians, as in the main allocation.
    const d = m.spillover(N, 0.2).siteDetail;
    ok(
      "per-site P/M/K exhausts each site",
      d.every((x) => x.pure + x.mixed + x.noRom === x.clinicians),
      d
        .map((x) => `${x.pure}+${x.mixed}+${x.noRom}=${x.clinicians}`)
        .slice(0, 3)
        .join(" "),
    );
    ok(
      "site verdicts follow the mixed count",
      d.every(
        (x) =>
          (x.mixed === 0 && x.verdict === "none") ||
          (x.mixed === 1 && x.verdict === "single") ||
          (x.mixed > 1 && x.verdict === "ok"),
      ),
    );
    ok(
      "usable completers never exceed the total",
      [0.1, 0.15, 0.2, 0.3].every((sh) => {
        const y = bySite(sh);
        return y.usableCellCompleters <= y.totalCellCompleters + 1e-9;
      }),
    );
  }

  // The on/off toggle keeps mixedShare as the EFFECTIVE share, so links written before
  // the toggle existed must be unaffected, and a link may pre-specify "off, but configured
  // at X" via spilloverPreset.
  {
    const off = createModel({
      ...defaults,
      designArms: 3,
      mixedShare: 0,
      spilloverPreset: 0.25,
    });
    const on = createModel({
      ...defaults,
      designArms: 3,
      mixedShare: 0.25,
      spilloverPreset: 0.25,
    });
    ok(
      "spilloverPreset does not affect the model while off",
      !Number.isFinite(off.spillover(N, undefined).spilloverPooled.mde) &&
        off.spillover(N).M === 0,
      `M=${off.spillover(N).M}`,
    );
    // An old link carries mixedShare only; its numbers must not move.
    const legacy = createModel({
      ...defaults,
      designArms: 3,
      mixedShare: 0.25,
    });
    close(
      "a link predating the toggle is unchanged",
      legacy.spillover(N).spilloverPooled.mde,
      on.spillover(N).spilloverPooled.mde,
      1e-12,
    );
    ok(
      "the preset restores the same design when switched on",
      on.spillover(N).M ===
        createModel({
          ...defaults,
          designArms: 3,
          mixedShare: off.spillover(N, 0.25) ? 0.25 : 0,
        }).spillover(N).M,
    );
  }

  // Off in two-arm mode.
  {
    const t2 = createModel({ ...defaults, designArms: 2, mixedShare: 0.2 });
    const r = t2.spillover(1000);
    ok(
      "two-arm spillover is flagged unavailable",
      r.available === false,
      String(r.available),
    );
    ok("two-arm spillover reports no mixed panels", r.M === 0, `M=${r.M}`);
    ok(
      "two-arm spillover returns no NaN",
      [r.primary.mde, r.spilloverPooled.mde, r.directEffect.mde].every(
        (x) => !Number.isNaN(x),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
section("8. Fairness / DIF substudy");
// ---------------------------------------------------------------------------

{
  // Pin cluster randomization: hybrid spreads AURORA users over more clinicians, which
  // legitimately changes the effective cluster size. Hybrid is covered separately below.
  const conf = {
    ...defaults,
    analysisFraming: "confirmatory",
    randomization: "cluster",
  };
  const m2 = createModel(conf);
  const m3 = createModel({ ...conf, designArms: 3 });
  const N = 1000;

  // Which arms contribute: only patients who actually use AURORA generate item responses.
  ok(
    "2-arm DIF draws on arm A only",
    m2.dif(N).armKeys.join("+") === "A",
    m2.dif(N).armKeys.join("+"),
  );
  ok(
    "3-arm DIF draws on arms A and B",
    m3.dif(N).armKeys.join("+") === "A+B",
    m3.dif(N).armKeys.join("+"),
  );

  // Uses RANDOMIZED patients, not completers: baseline item responses exist for everyone.
  {
    const alloc = m3.allocation(N);
    const expected = alloc.randomized[0] + alloc.randomized[1];
    ok(
      "DIF uses randomized counts, not completers",
      m3.dif(N).nUsers === expected,
      `${m3.dif(N).nUsers} vs randomized ${expected} (completers would be ${Math.round(alloc.completers[0] + alloc.completers[1])})`,
    );
  }

  // Subgroup arithmetic must partition the users exactly.
  for (const share of [0.05, 0.2, 0.5]) {
    const d = createModel({
      ...conf,
      designArms: 3,
      difSubgroupShare: share,
    }).dif(N);
    ok(
      `subgroups partition users at ${share * 100}%`,
      d.nFocal + d.nReference === d.nUsers,
      `${d.nFocal} + ${d.nReference} = ${d.nUsers}`,
    );
  }

  // The design effect must be computed on the RANDOMIZED cluster size. Pairing a
  // full-sample N with the post-attrition cluster size would understate the SE.
  {
    const d = m3.dif(N);
    // Total cluster-size variation, between-site and within-site in quadrature - the same
    // cvAdjTotal the outcome path uses. This analysis pools users across every site, so
    // the between-site term applies. The claim under test is the CLUSTER SIZE: randomized,
    // not post-attrition. The CV factor is just carried through both sides.
    const cvSite = cvBetween(rosterFromSettings(conf));
    const cvAdjTotal =
      1 + cvSite * cvSite + conf.clusterSizeCV * conf.clusterSizeCV;
    const expected =
      (1 + (conf.patientsPerCluster - 1) * conf.iccHamd) * cvAdjTotal;
    close(
      "DIF design effect uses randomized cluster size",
      d.designEffect,
      expected,
      1e-12,
    );
    const postAttrition =
      (1 +
        (conf.patientsPerCluster * (1 - conf.controlAttrition) - 1) *
          conf.iccHamd) *
      cvAdjTotal;
    ok(
      "DIF design effect exceeds the HAM-D (post-attrition) one",
      d.designEffect > postAttrition,
      `${d.designEffect.toFixed(4)} vs ${postAttrition.toFixed(4)}`,
    );
  }

  // The between-site term was dropped here for several commits after site stratification
  // landed, because this path recomputed 1 + clusterSizeCV^2 locally instead of reusing
  // cvAdjTotal. A roster with real between-site spread must move the design effect.
  {
    const flat = { ...conf, designArms: 3, siteRoster: "1000-100" }; // every site identical
    const varied = { ...conf, designArms: 3 };
    const deFlat = createModel(flat).dif(N).designEffect;
    const deVaried = createModel(varied).dif(N).designEffect;
    ok(
      "DIF design effect includes between-site cluster-size variation",
      deVaried > deFlat,
      `${deVaried.toFixed(6)} (eTable 1 roster) > ${deFlat.toFixed(6)} (uniform roster)`,
    );
    const sFlat = createModel({ ...flat, mixedShare: 0.3 }).spillover(N);
    const sVaried = createModel({ ...varied, mixedShare: 0.3 }).spillover(N);
    ok(
      "spillover SE includes between-site cluster-size variation",
      sVaried.primary.se > sFlat.primary.se,
      `${sVaried.primary.se.toFixed(6)} > ${sFlat.primary.se.toFixed(6)}`,
    );
  }

  // SE behaviour.
  {
    const se = (o) => createModel({ ...conf, designArms: 3, ...o }).dif(N).se;
    ok("SE falls as N grows", m3.dif(1300).se < m3.dif(600).se);
    ok(
      "SE falls as item information rises",
      se({ difItemInfo: 0.5 }) < se({ difItemInfo: 0.25 }),
    );
    ok(
      "SE is worst for the most lopsided split",
      se({ difSubgroupShare: 0.05 }) > se({ difSubgroupShare: 0.5 }),
    );
    // A balanced split minimises SE(difference), so 50% must be the optimum.
    ok(
      "balanced subgroups minimise SE",
      se({ difSubgroupShare: 0.5 }) < se({ difSubgroupShare: 0.35 }),
    );
    // No arm-level multiplicity: DIF is a measurement question, not an arm comparison.
    close(
      "Dunnett does not touch the DIF critical value",
      createModel({ ...conf, designArms: 3, multiplicity: "dunnett" }).dif(N)
        .crit,
      createModel({ ...conf, designArms: 3, multiplicity: "bonferroni" }).dif(N)
        .crit,
      1e-12,
    );
  }

  // Internal consistency with the same decomposition used elsewhere.
  {
    const d = m3.dif(N);
    close("DIF CI half-width = crit * SE", d.ciHalfWidth, d.crit * d.se, 1e-12);
    close(
      "DIF MDE = CI half-width + zBeta * SE",
      d.mde,
      d.ciHalfWidth + m3.zBeta * d.se,
      1e-12,
    );
    const atMde = createModel({
      ...conf,
      designArms: 3,
      difTargetLogits: d.mde,
    }).dif(N);
    close(
      "power at the detectable DIF equals nominal power",
      atMde.power,
      conf.power,
      1e-9,
    );
  }

  // Adequacy flag and the implied sample size must agree with each other.
  {
    const d = m3.dif(N);
    ok(
      "20% subgroup is inadequate at N=1000",
      !d.adequate,
      `${d.nFocal} < ${conf.difThresholdN}`,
    );
    ok(
      "shortfall is reported",
      d.shortfall === conf.difThresholdN - d.nFocal,
      String(d.shortfall),
    );
    // Site-stratified rounding can leave the projection a clinician or two short, so
    // allow one rounding step rather than asserting an exact landing.
    const atRequired = m3.dif(d.nRequired + conf.patientsPerCluster);
    ok(
      "nRequired lands on the threshold within one cluster",
      atRequired.adequate,
      `N=${d.nRequired} -> ${m3.dif(d.nRequired).nFocal}, +1 cluster -> ${atRequired.nFocal}`,
    );
    ok(
      "nRequired is not overshooting badly",
      m3.dif(d.nRequired - 60).adequate === false,
      `N=${d.nRequired - 60} -> ${m3.dif(d.nRequired - 60).nFocal}`,
    );
  }

  // Allocation preset: weighting toward the AURORA arms is the lever that helps here.
  {
    const balanced = createModel({ ...conf, designArms: 3 }).dif(N);
    const weighted = createModel({
      ...conf,
      designArms: 3,
      allocA: 2,
      allocB: 2,
      allocC: 1,
    }).dif(N);
    ok(
      "2:2:1 yields more AURORA users than 1:1:1",
      weighted.nUsers > balanced.nUsers,
      `${weighted.nUsers} vs ${balanced.nUsers}`,
    );
    ok(
      "2:2:1 tightens the DIF interval",
      weighted.ciHalfWidth < balanced.ciHalfWidth,
      `${weighted.ciHalfWidth.toFixed(3)} vs ${balanced.ciHalfWidth.toFixed(3)}`,
    );
  }

  // Everything finite across the parameter space the UI exposes.
  {
    let finite = true;
    for (const share of [0.05, 0.13, 0.25, 0.5])
      for (const info of [0.1, 0.25, 1])
        for (const n of [400, 1000, 1500])
          for (const arms of [2, 3]) {
            const d = createModel({
              ...conf,
              designArms: arms,
              difSubgroupShare: share,
              difItemInfo: info,
            }).dif(n);
            if (![d.se, d.mde, d.power, d.ciHalfWidth].every(Number.isFinite))
              finite = false;
          }
    ok("DIF outputs stay finite across the UI's parameter space", finite);
  }
}

// ---------------------------------------------------------------------------
section("9. URL state codec");
// ---------------------------------------------------------------------------

{
  // Every setting the app has must be representable, or links would silently drop it.
  const missing = Object.keys(defaults).filter((k) => !SETTING_SPEC[k]);
  ok(
    "every default setting is encodable",
    missing.length === 0,
    missing.join(", ") || "none missing",
  );
  ok(
    "field order covers the whole spec",
    FIELD_ORDER.length === Object.keys(SETTING_SPEC).length,
    `${FIELD_ORDER.length} fields`,
  );

  // Exact round trip for defaults and for a thoroughly non-default configuration.
  const roundTrips = (label, s) => {
    const back = decodeSettings(encodeSettings(s));
    const bad = Object.keys(SETTING_SPEC).filter((k) => back[k] !== s[k]);
    ok(`round trip: ${label}`, bad.length === 0, bad.join(", ") || "exact");
  };
  roundTrips("defaults", defaults);
  roundTrips("three-arm confirmatory", {
    ...defaults,
    analysisFraming: "confirmatory",
    chartMetric: "mde",
    designArms: 3,
    allocA: 2,
    allocB: 2,
    allocC: 1,
    multiplicity: "bonferroni",
    smallSampleT: false,
    selectedContrast: "AB",
    measurementModel: "mfrm",
    power: 0.9,
    alpha: 0.01,
    nClinicians: 150,
    clusterSizeCV: 0.6,
    assumedEffect: 3.25,
  });

  // Booleans and enums are the easiest things to get wrong in a positional codec.
  for (const v of [true, false]) {
    const back = decodeSettings(
      encodeSettings({ ...defaults, smallSampleT: v }),
    );
    ok(
      `round trip: smallSampleT=${v}`,
      back.smallSampleT === v,
      String(back.smallSampleT),
    );
  }
  for (const m of SETTING_SPEC.measurementModel.values) {
    const back = decodeSettings(
      encodeSettings({ ...defaults, measurementModel: m }),
    );
    ok(
      `round trip: measurementModel=${m}`,
      back.measurementModel === m,
      back.measurementModel,
    );
  }

  // A token must survive real URL serialisation without percent-encoding bloat.
  {
    const url = shareableUrl(defaults, "https://example.org/app/");
    ok(
      "token needs no percent-encoding",
      !/%/.test(url),
      url.slice(0, 60) + "...",
    );
    ok("full URL stays short", url.length < 250, `${url.length} chars`);
    const token = new URL(url).searchParams.get("c");
    const back = decodeSettings(token);
    ok(
      "decodes back off a real URL",
      Object.keys(SETTING_SPEC).every((k) => back[k] === defaults[k]),
    );
  }

  // Untrusted input must degrade to defaults, never throw and never reach the model
  // with a value that would break it (normInv throws outside (0,1)).
  const hostile = [
    "",
    "garbage",
    "2_0_0_3", // unknown version
    "1_" + "9".repeat(50),
    "1_0_0_2_3_1_1_1_0_1_0_2_5_0.05_10_100", // power=5, out of range
    "1_0_0_2_3_1_1_1_0_1_0_2_0_0_10_100", // power=0, alpha=0 - would throw
    "1_x_y_z",
    "1_-1_-1_-1",
    "1_0_0_999_3_1_1_1", // designArms out of range
    "1_" + "_".repeat(80),
    "1_0_0_2_3_1_1_1_0_1_0_2_NaN_Infinity",
  ];
  let allSafe = true;
  const failures = [];
  for (const t of hostile) {
    let out;
    try {
      out = decodeSettings(t);
    } catch (e) {
      allSafe = false;
      failures.push(`${t.slice(0, 20)} threw`);
      continue;
    }
    for (const [key, spec] of Object.entries(SETTING_SPEC)) {
      const v = out[key];
      const bad =
        spec.type === "enum"
          ? !spec.values.includes(v)
          : spec.type === "bool"
            ? typeof v !== "boolean"
            : spec.type === "string"
              ? typeof v !== "string" ||
                (spec.validate && spec.validate(v) === null)
              : !Number.isFinite(v) || v < spec.min || v > spec.max;
      if (bad) {
        allSafe = false;
        failures.push(`${t.slice(0, 16)} -> ${key}=${v}`);
      }
    }
  }
  ok(
    "hostile tokens degrade safely",
    allSafe,
    failures.slice(0, 3).join("; ") || `${hostile.length} tokens checked`,
  );

  // And the decoded result must actually drive the model without blowing up.
  {
    let modelOk = true;
    for (const t of hostile) {
      try {
        const m = createModel(decodeSettings(t));
        const v = m.hamd(1000, m.contrasts[0]).mde;
        if (!Number.isFinite(v)) modelOk = false;
      } catch (e) {
        modelOk = false;
      }
    }
    ok("model survives every hostile token", modelOk);
  }

  // Truncated tokens (written before a setting existed) fall back for the missing
  // trailing fields but must honour everything they do specify.
  {
    const full = encodeSettings({ ...defaults, designArms: 3, power: 0.9 });
    const truncated = full.split("_").slice(0, 14).join("_");
    const back = decodeSettings(truncated);
    ok(
      "truncated token keeps its leading fields",
      back.designArms === 3 && back.power === 0.9,
      `designArms=${back.designArms} power=${back.power}`,
    );
    ok(
      "truncated token defaults the rest",
      back.nFollowups === defaults.nFollowups,
      String(back.nFollowups),
    );
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
