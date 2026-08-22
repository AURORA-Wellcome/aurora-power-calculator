// Site roster and site-stratified allocation.
//
// The trial randomizes clinicians STRATIFIED BY SITE: 111 clinicians across 11 sites in
// 8 countries (eTable 1 of the design memo). Allocating within each site and aggregating
// gives a different answer from allocating one undifferentiated pool, in ways that are
// not reasonable to work out by inspection:
//
//   - the realized allocation drifts from the nominal one, always in one direction,
//     because largest-remainder rounding at each site favours the larger share;
//   - the number of mixed panels in the spillover design overshoots its target;
//   - whether a site can support a cell at all is non-monotonic in the target share.
//
// The roster plays two distinct roles, and keeping them separate avoids double-counting:
//
//   1. SHAPE - how many clinicians each site has, which drives allocation feasibility.
//      Scaled to whatever nClinicians is set to, so planning at 100 against a roster of
//      111 works without either number having to give way.
//   2. PANEL SIZE VARIATION - patients per clinician differs by site (11 at MGH and BCM,
//      10 elsewhere), which contributes a between-site component to the cluster-size
//      design effect. See cvBetween below for why this does NOT replace the assumed
//      within-site variation.

// Largest-remainder apportionment: the per-arm counts always sum exactly to the total.
// 100 clinicians across 1:1:1 becomes 34/33/33, not three rounded 33.3s.
// Ties in the fractional part are broken in favour of the earlier arm, which reproduces
// the old two-arm `Math.round(nClusters * proportion)` behaviour exactly.
export function allocateClusters(total, weights, tieBreak = 0) {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) return weights.map(() => 0);

  const exact = weights.map((w) => (total * w) / sumW);
  const counts = exact.map(Math.floor);
  let remaining = total - counts.reduce((a, b) => a + b, 0);

  // `tieBreak` rotates which arm wins an exact tie. It matters because this runs once per
  // SITE: a 6-clinician site at 3:1 splits 4.5/1.5, a genuine tie, and always resolving it
  // the same way accumulates a systematic bias across sites. With the eTable 1 roster that
  // turned a nominal 75/25 into a realized 79/21. Rotating spreads the odd clinician
  // around, which is what balanced stratified randomization does in practice.
  // tieBreak = 0 preserves the original single-pool behaviour exactly, so the two-arm
  // regression against the pre-site implementation still holds.
  const n = weights.length;
  // JS % keeps the sign of the dividend, so a bare (i - tieBreak) % n goes negative once
  // tieBreak exceeds i and sorts that arm ahead of everything. Force it non-negative.
  // (R's %% is already mathematical, which is how the cross-check caught this.)
  const rank = (i) => (((i - tieBreak) % n) + n) % n;
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((x, y) => y.frac - x.frac || rank(x.i) - rank(y.i));

  for (let k = 0; remaining > 0; k++, remaining--) {
    counts[order[k % order.length].i] += 1;
  }
  return counts;
}

// eTable 1 of the design memo. Patients and clinicians per site.
export const DEFAULT_ROSTER = [
  { name: "Peru (CITBM)", patients: 140, clinicians: 14 },
  { name: "Paraguay (UNA)", patients: 140, clinicians: 14 },
  { name: "Indonesia (UB)", patients: 140, clinicians: 14 },
  { name: "Bolivia (unifranz)", patients: 140, clinicians: 14 },
  { name: "MGH", patients: 110, clinicians: 10 },
  { name: "BCM", patients: 110, clinicians: 10 },
  { name: "Spain (la paz)", patients: 70, clinicians: 7 },
  { name: "Colombia (unisabana)", patients: 70, clinicians: 7 },
  { name: "Colombia (u rosario)", patients: 70, clinicians: 7 },
  { name: "UK (NHS london)", patients: 70, clinicians: 7 },
  { name: "UK (Avon and Wilt)", patients: 70, clinicians: 7 },
];

export const MAX_SITES = 40;

// Wire format: "140-14.140-14.70-7". Both "." and "-" survive URLSearchParams untouched,
// unlike "," which becomes %2C and would inflate every link.
const ROSTER_RE = /^\d{1,5}-\d{1,4}(\.\d{1,5}-\d{1,4})*$/;

export function formatRoster(roster) {
  return roster.map((s) => `${s.patients}-${s.clinicians}`).join(".");
}

/** Returns a roster array, or null if the string is malformed or out of bounds. */
export function parseRoster(str) {
  if (typeof str !== "string") return null;
  const clean = str.replace(/\s+/g, "");
  if (!ROSTER_RE.test(clean)) return null;

  const parts = clean.split(".");
  if (parts.length === 0 || parts.length > MAX_SITES) return null;

  const roster = [];
  for (const part of parts) {
    const [patients, clinicians] = part.split("-").map(Number);
    // A site cannot have fewer patients than clinicians: every clinician needs a panel.
    if (!(clinicians >= 1) || !(patients >= clinicians)) return null;
    roster.push({ name: `Site ${roster.length + 1}`, patients, clinicians });
  }
  return roster;
}

export function rosterFromSettings(s) {
  const parsed = parseRoster(s.siteRoster);
  if (!parsed) return DEFAULT_ROSTER;
  // The wire format carries sizes but not names, so recover the real site names whenever
  // the roster still matches eTable 1. Makes the feasibility table readable without
  // having to encode names in every link.
  if (formatRoster(parsed) === formatRoster(DEFAULT_ROSTER))
    return DEFAULT_ROSTER;
  return parsed;
}

export function totalClinicians(roster) {
  return roster.reduce((a, s) => a + s.clinicians, 0);
}

/**
 * Rescale a roster's clinician counts to a target total, preserving relative site sizes.
 * Lets the roster describe the real sites while the power calculation plans at a
 * different (usually more conservative) number.
 */
export function scaleRoster(roster, target) {
  const have = totalClinicians(roster);
  if (!(target > 0) || have === 0)
    return roster.map((s) => ({ ...s, clinicians: 0 }));
  if (target === have) return roster.map((s) => ({ ...s }));

  const counts = allocateClusters(
    target,
    roster.map((s) => s.clinicians),
  );
  return roster.map((s, i) => ({
    ...s,
    clinicians: counts[i],
    // Panel size per clinician is a property of the site, not of the scaling.
    patients: Math.round((s.patients / s.clinicians) * counts[i]),
  }));
}

/** Panel size (patients per clinician) for each site. */
export function panelSizes(roster) {
  return roster.map((s) => s.patients / s.clinicians);
}

/**
 * Clinician-weighted coefficient of variation of panel size ACROSS SITES.
 *
 * This is deliberately not a replacement for the assumed within-site variation. The
 * roster records PLANNED panel sizes, which barely vary (nine sites at exactly 10
 * patients per clinician, two at 11), giving CV about 0.038 against a typical assumption
 * of 0.2. The dominant source of cluster-size variation is clinicians differing from each
 * other WITHIN a site, and a roster of targets holds no information about it. The two
 * combine in quadrature: CV_total^2 = CV_between^2 + CV_within^2.
 */
export function cvBetween(roster) {
  const totalC = totalClinicians(roster);
  if (totalC === 0) return 0;
  const sizes = panelSizes(roster);
  const mean = roster.reduce((a, s) => a + s.patients, 0) / totalC;
  if (!(mean > 0)) return 0;
  const varr =
    roster.reduce((a, s, i) => a + s.clinicians * (sizes[i] - mean) ** 2, 0) /
    totalC;
  return Math.sqrt(varr) / mean;
}

/**
 * Allocate each site's clinicians across arm groups independently, then aggregate.
 * This is what stratified randomization actually does, and it is why the realized
 * allocation differs from the nominal one.
 */
export function allocateRoster(roster, weights) {
  // Rotate the tie-break by site index so ties do not all resolve toward the same arm.
  const perSite = roster.map((s, i) =>
    allocateClusters(s.clinicians, weights, i),
  );
  const aggregate = weights.map((_, i) =>
    perSite.reduce((a, cells) => a + cells[i], 0),
  );
  const total = aggregate.reduce((a, b) => a + b, 0);
  const sumW = weights.reduce((a, b) => a + b, 0);
  return {
    perSite,
    aggregate,
    total,
    // Nominal counts, for comparison against what stratification actually yields.
    nominal: weights.map((w) => (sumW > 0 ? (total * w) / sumW : 0)),
    shares: aggregate.map((c) => (total > 0 ? c / total : 0)),
  };
}

/**
 * Flag sites that cannot support a cell. A cell of 1 is not an error but it is a real
 * problem for any between-clinician contrast: that site's entire contribution is
 * confounded with one individual's practice.
 */
export function feasibility(roster, weights, labels) {
  const { perSite, aggregate, nominal, shares } = allocateRoster(
    roster,
    weights,
  );
  const empty = [];
  const singleton = [];
  perSite.forEach((cells, si) => {
    cells.forEach((c, ai) => {
      const entry = {
        site: roster[si].name,
        cell: labels?.[ai] ?? `group ${ai}`,
      };
      if (c === 0) empty.push(entry);
      else if (c === 1) singleton.push(entry);
    });
  });
  return {
    perSite,
    aggregate,
    nominal,
    shares,
    empty,
    singleton,
    // Largest absolute drift between realized and nominal share, in percentage points.
    maxDriftPp: Math.max(
      ...aggregate.map((c, i) =>
        Math.abs(
          (c /
            Math.max(
              1,
              aggregate.reduce((a, b) => a + b, 0),
            )) *
            100 -
            (nominal[i] /
              Math.max(
                1,
                aggregate.reduce((a, b) => a + b, 0),
              )) *
              100,
        ),
      ),
    ),
  };
}
