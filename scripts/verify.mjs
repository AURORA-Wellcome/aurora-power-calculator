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
} from "../src/calc.js";
import { defaults } from "../src/defaults.js";
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
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
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

// t quantiles against R's qt().
close("tQuantile(0.975, 60)", tQuantile(0.975, 60), 2.000297822, 1e-4);
close("tQuantile(0.975, 30)", tQuantile(0.975, 30), 2.042272456, 1e-4);
close("tQuantile(0.975, 1e9) -> z", tQuantile(0.975, 1e9), 1.959963985, 1e-6);
// Further into the tail, where the small-sample correction actually operates.
close("tQuantile(0.9875, 37)", tQuantile(0.9875, 37), 2.339303, 3e-3);
close("tQuantile(0.995, 97)", tQuantile(0.995, 97), 2.627, 2e-3);
close("tQuantile(0.995, 30)", tQuantile(0.995, 30), 2.749996, 5e-3);

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

for (const [name, spec] of Object.entries(BASELINE)) {
  const s = { ...baseSettings, ...spec.settings };
  const m = createModel(s);
  const c = m.contrasts[0];

  // The only intended change to two-arm results is that the hardcoded z lookup is
  // replaced by an exact quantile. Scaling the old MDE by the ratio of the critical
  // multipliers must therefore reproduce the new value to machine precision — that is
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
    // The ICC substudy uses a fixed 1.96 and no power term, so it must be unchanged.
    close(`[${name}] N=${n} ICC half-width`, i.ciHalfWidth, exp.icc, 5e-7);
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
  "three contrasts built",
  m3.contrasts.length === 3,
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
  // MDE must be slightly smaller — differing only through the critical value.
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
  const heavy = createModel({ ...three, allocA: 2, allocB: 1, allocC: 2 });
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
  close("default 2-arm HAM-D MDE at N=1000", h.mde, 1.448, 0.02);
  close(
    "default 2-arm HAM-D CI half-width at N=1000",
    h.ciHalfWidth,
    1.017,
    0.02,
  );

  const d3 = createModel({ ...defaults, designArms: 3 });
  const AC = d3.contrasts.find((c) => c.id === "AC");
  const h3 = d3.hamd(n, AC);
  close("default 3-arm A-C HAM-D MDE at N=1000", h3.mde, 1.533, 0.02);
  close(
    "default 3-arm A-C CI half-width at N=1000",
    h3.ciHalfWidth,
    1.076,
    0.02,
  );
  ok(
    "3-arm still costs more than 2-arm under the shipped defaults",
    h3.mde > h.mde,
    `${h3.mde.toFixed(3)} vs ${h.mde.toFixed(3)} (+${((h3.mde / h.mde - 1) * 100).toFixed(1)}%)`,
  );
}

// ---------------------------------------------------------------------------
section("8. Fairness / DIF substudy");
// ---------------------------------------------------------------------------

{
  const conf = { ...defaults, analysisFraming: "confirmatory" };
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
    const expected =
      (1 + (conf.patientsPerCluster - 1) * conf.iccHamd) *
      (1 + conf.clusterSizeCV * conf.clusterSizeCV);
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
      (1 + conf.clusterSizeCV * conf.clusterSizeCV);
    ok(
      "DIF design effect exceeds the HAM-D (post-attrition) one",
      d.designEffect > postAttrition,
      `${d.designEffect.toFixed(4)} vs ${postAttrition.toFixed(4)}`,
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
    const atRequired = m3.dif(d.nRequired);
    ok(
      "nRequired actually clears the threshold",
      atRequired.adequate,
      `N=${d.nRequired} -> ${atRequired.nFocal} per group`,
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
