// Emits the generated R script for a design and prints the JS numbers beside it, so the
// two independent implementations can be compared. Run with:
//   node scripts/crosscheck-r.mjs 2 > /tmp/two-arm.R
//   Rscript /tmp/two-arm.R
// The JS values are written to stderr so stdout stays valid R.

import { createModel } from "../src/calc.js";
import { buildRCode } from "../src/rcode.js";
import { defaults } from "../src/defaults.js";

const arms = Number(process.argv[2] || 3);
const overrides = JSON.parse(process.argv[3] || "{}");

// Spread the real defaults rather than restating them: a hardcoded copy silently goes
// stale every time a setting is added, and the generated R then references undefined
// values instead of failing loudly.
const settings = { ...defaults, designArms: arms, ...overrides };

process.stdout.write(buildRCode(settings));

const m = createModel(settings);
const n = settings.nClinicians * settings.patientsPerCluster;
const alloc = m.allocation(n);
const lines = [];
lines.push(`--- JS values (${arms}-arm, N=${n}) ---`);
lines.push(`clusters: ${alloc.clusters.join(", ")} (total ${alloc.nClusters})`);
lines.push(
  `crit: unadjusted ${m.zUnadjusted.toFixed(4)}, Dunnett ${m.zDunnett.toFixed(4)}, Bonferroni ${m.zBonferroni.toFixed(4)}`,
);
for (const c of m.contrasts) {
  const h = m.hamd(n, c);
  const r = m.retention(n, c);
  lines.push(
    `${c.short}: HAM-D +/-${h.ciHalfWidth.toFixed(3)} MDE ${h.mde.toFixed(3)} (d=${h.effectSize.toFixed(3)}), retention +/-${r.ciHalfWidth.toFixed(2)} MDE ${r.mde.toFixed(2)} pp, crit ${h.crit.toFixed(4)} [${h.critMethod}]`,
  );
}
const icc = m.icc(n);
lines.push(
  `ICC: ${icc.nObservations} obs, CI ${icc.lowerBound.toFixed(3)}-${icc.upperBound.toFixed(3)}, half ${icc.ciHalfWidth.toFixed(4)}`,
);
lines.push(`completers: ${m.hamd(n, m.contrasts[0]).nCompleters}`);
const d = m.dif(n);
lines.push(
  `DIF: users=${d.nUsers} focal=${d.nFocal} ref=${d.nReference} adequate=${d.adequate ? "Yes" : "No"} needN=${d.nRequired} DE=${d.designEffect.toFixed(4)} CI=+/-${d.ciHalfWidth.toFixed(3)} mde=${d.mde.toFixed(3)} power=${Math.round(d.power * 100)}%`,
);
process.stderr.write(lines.join("\n") + "\n");
