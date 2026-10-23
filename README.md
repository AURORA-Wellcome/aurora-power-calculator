# AURORA Trial Power Calculator

Interactive web application for exploring the precision and minimum detectable effects achievable at a given sample size in the AURORA clinical trial.

## Features

- **Exploratory or confirmatory framing**: an exploratory study makes no efficacy claim, so no multiplicity adjustment is applied and the design is justified on **precision** (confidence interval width) rather than on power to declare significance. Charts and tables switch between CI half-width and MDE.
- **Two-arm and three-arm designs**: switch between the original treatment/control design and a three-arm design (clinician + patient / patient-only / usual care), with adjustable allocation. All arms are randomized at the clinician (cluster) level.
- **Pairwise contrasts**: in three-arm mode all three contrasts are reported: clinician+patient vs control, patient-only vs control, and the incremental value of clinician involvement (A vs B).
- **Pooled A+B vs control**: a fourth selectable contrast treating either AURORA arm as exposed. Most apt for retention, where the mechanism is plausibly patient-facing and the clinician dashboard should not affect whether a patient stays enrolled. Assumes the effect is homogeneous across A and B; reported *instead of* the decomposition, so it does not inflate the multiplicity count.
- **Arm-level multiplicity**: Dunnett's correction for the active-vs-control family (critical value computed by numerical integration, not looked up), with Bonferroni and unadjusted alternatives. The resulting critical value is always shown.
- **Cost of the third arm**: three-arm charts overlay the equivalent two-arm MDE so the efficiency trade-off is visible rather than inferred.
- **HAM-D Power Analysis**: MDEs for depression severity with adjustable intracluster correlation, covariate R², and measurement model options (sum score, Rasch partial credit, multi-facet Rasch). MFRM is the default planned analysis; charts keep a sum-score baseline line so the gain it assumes stays visible.
- **Retention Analysis**: study retention modelled with survival analysis efficiency gains.
- **Intraclass Correlation Validation**: precision for AURORA-clinician agreement. In three-arm mode both AURORA-using arms contribute rating pairs.
- **Measurement fairness (DIF)**: subgroup sizes among AURORA users against a per-group adequacy minimum, plus the precision and detectable magnitude of a differential-item-functioning estimate in logits. Covers the "fair" half of the measurement aim, which is usually constrained by subgroup size rather than total N.
- **Responsiveness interviews (Aim 2.2)**: the extra HAM-Ds held when the AURORA algorithm reports a change (triggered, for PPV) and at random (audits, for the miss rate). Reports interviews per participant, precision of the miss rate and PPV, peak weekly load and cost by site, and the fit against the application's assessment budget. How the algorithm behaves at each threshold comes from simulation presets (see below).
- **Hybrid cluster-individual randomization**: clinicians randomized to ROM vs no-ROM, then patients within no-ROM clinicians individually randomized to app-only vs TAU. That makes app-only vs TAU a within-clinician contrast, removing the between-clinician variance from it.
- **Allocation presets** matching the study design memo: `B.1` 33/33/33, `B.2` 50/25/25, `B.3` 40/30/30. Under hybrid, B.3 is the recommendation: it ties the balanced 45/27.5/27.5 allocation on the binding A-vs-C contrast (1.396 vs 1.395 at 110 clinicians) and beats it on B-vs-C and on the pooled contrast, because equalising the contrasts means giving back the free advantage hybrid hands to B-vs-C.
- **Power for an assumed effect**: alongside the MDE, a direct power readout for a specified HAM-D difference.
- **Optional small-sample t correction**, with the cluster-level degrees of freedom displayed.
- **R code for verification**: a self-contained base-R script that reproduces every displayed number, runnable in the browser via WebR or pasted into a local R session. The WebR runtime is pinned to a specific version in `src/App.jsx` rather than tracking `latest`, so what a reader's browser executes cannot change without a commit here.
- **Linkable configurations**: the address bar always carries a token encoding the full configuration, so any view can be shared or pasted into a document and reopened exactly. A "Copy link" button puts it on the clipboard. Following a link overrides locally saved settings.
- **Persistent Settings**: preferences are saved locally and restored on return visits.

## Layout

| Path | Purpose |
|---|---|
| `src/calc.js` | All statistics: quantiles, Dunnett critical values, cluster apportionment, the three outcome calculators. No React, so it can be exercised directly from Node. |
| `src/rcode.js` | Generates the R verification script (single source for both the displayed code and the WebR run). |
| `src/defaults.js` | Shipped default settings, importable without React so the checks can pin them. |
| `src/responsiveness.js` | Inputs for the Aim 2.2 panel: the simulation presets, the follow-up schedule, and interview time. |
| `src/budget.js`, `src/budget.example.js` | Budget figures for the Aim 2.2 costs: public placeholders, or the gitignored `src/budget.local.js` when present (see "Budget figures"). |
| `simulations/` | Python simulations behind the Aim 2.2 presets, with their saved output. Not part of the build. |
| `src/urlState.js` | Reversible URL token codec for the full configuration, with validation of untrusted input. |
| `src/App.jsx` | UI and charts. |
| `scripts/verify.mjs` | Checks for `src/calc.js`, described below. |
| `scripts/crosscheck-r.mjs` | Emits the generated R for a design plus the corresponding JS values, for side-by-side comparison. |
| `vite.config.js` | Build config. `base` must match the GitHub Pages project path; it replaces the `homepage` field react-scripts used to read. |
| `tailwind.config.js` | Tailwind is a build step, pinned to 3.x. See the note below. |

## Run Locally

### Prerequisites

- Node.js 24, pinned in `.node-version`. CI reads the same file, so local and
  deploy builds cannot drift apart. fnm and nodenv pick it up with no setup; mise
  needs `mise trust` once in this directory, which the committed `mise.toml` then
  wires up. **nvm reads only `.nvmrc`**, so nvm users need
  `nvm use $(cat .node-version)`.

  The file holds one bare version and no comment, deliberately: fnm parses the
  whole file as a version, while mise and nodenv read only the first line or word,
  so no comment position is safe across all of them. The note about when to move
  to Node 26 is in `mise.toml`, which is TOML and can carry one.
- R, only for `scripts/crosscheck-r.mjs`. Everything else runs without it.

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Opens the app at [http://localhost:5173](http://localhost:5173).

### Verification

```bash
npm run verify
```

Runs the checks in `scripts/verify.mjs`: normal and t quantiles, Dunnett critical values against published tables, cluster apportionment, a regression of two-arm results against the pre-three-arm implementation, and direction-of-effect sanity checks.

To compare the JavaScript against an independent R implementation of the same formulas (requires R):

```bash
node scripts/crosscheck-r.mjs 3 > /tmp/three.R   # JS values go to stderr
Rscript /tmp/three.R
```

A second argument overrides settings, which is how the substudies get exercised. The
spillover block is emitted by both sides only when the substudy is on, so the default
run stays quiet:

```bash
node scripts/crosscheck-r.mjs 3 '{"mixedShare":0.3}' > /tmp/spill.R
Rscript /tmp/spill.R
```

### Build

```bash
npm run build
```

Creates a production build in the `dist/` folder. `npm run preview` serves it
locally at the same `/aurora-power-calculator/` base path GitHub Pages uses, which is
the only way to catch a broken `base` before deploying.

## Styling

Tailwind is compiled at build time via PostCSS and **pinned to 3.4.17**. The app
previously loaded `cdn.tailwindcss.com`, which is the browser JIT compiler: render-blocking,
unpinned, and a hard external dependency, so the app rendered completely unstyled anywhere
that CDN was unreachable. The CDN redirects to 3.4.17, so pinning to that version made the
migration pixel-identical (verified by byte-identical screenshots against the deployed site).

Tailwind 4 moved the default palette to OKLCH and replaced the config format. Upgrading
would restyle every surface, so it needs to be its own change with its own visual check.

## Effect sizes

HAM-D reports Cohen's d (`MDE / 7`, the assumed SD). Retention reports Cohen's h,
`|2 asin(sqrt(p1)) - 2 asin(sqrt(p2))|`, because d is defined for a mean difference and
does not transfer to proportions: a proportion's variance is tied to its level, so the
same absolute gap is a much larger effect near 0 or 1 than in the middle. A 5 percentage
point gap is h = 0.19 at 5 to 10%, but h = 0.10 at 45 to 50%. Both use the same rough
benchmarks (0.2 small, 0.5 medium, 0.8 large). In precision mode the reported effect size
is that of the CI half-width rather than the MDE, so it can be read against the same scale.

## Statistical notes

- The default measurement model is **multi-facet Rasch (MFRM)**, credited with removing rater severity only: it cuts HAM-D error variance by 7% and the MDE by about 3.6% against a sum score. Rasch scoring gets no reliability gain (both reliabilities default to 0.86). With complete item data the raw sum score is a sufficient statistic for the Rasch person measure, so rescoring makes the scale interval-level but adds little information; and the full HAM-D-17 does not fit the Rasch model in published re-analyses, while the HAM-D-6 does (Bech et al. 2014, [doi:10.1016/j.psychres.2014.03.024](https://doi.org/10.1016/j.psychres.2014.03.024)). The 7% rater-severity share is a placeholder, to be replaced by an estimate from the raters' shared calibration recordings. Removing it requires that linked rating design, and it covers scoring severity only: differences in how interviewers elicit answers in live interviews remain. Until October 2026 the defaults also credited Rasch scoring with a 0.86 to 0.91 reliability gain (11.7% off the error variance, about 6% off the MDE); that figure had no source. The sum-score baseline stays on the chart so the size of the assumption is visible.

- **Precision does not depend on alpha or multiplicity.** The CI half-width is `crit x SE`, and the standard error, which is what determines how precisely an effect is estimated, is untouched by the alpha level or the multiplicity rule. Only the MDE, a testing quantity, moves. If the study is sized on precision, the whole multiplicity debate is moot.
- Under the exploratory framing no adjustment is applied at either level, and alpha sets the confidence level rather than a significance threshold.
- Under the confirmatory framing, alpha is the per-outcome level (0.025 reflects Benjamini-Hochberg across the three outcomes) and any arm-level adjustment (Dunnett/Bonferroni) is applied on top of it. These are two separate layers.
- Outcome-level adjustment is only required when *any one* of several outcomes could carry the claim. A single designated primary (with secondaries tested hierarchically), or co-primaries where *all* must succeed (an intersection-union test), need no penalty.
- The ICC substudy is an estimation objective (ruling out ICC < 0.75 with a confidence interval) rather than a hypothesis test, so it does not belong in any alpha family. It takes no arm-level multiplicity adjustment for that reason, but it is still reported at the level `alpha` sets, and with the small-sample t when that is on: no multiplicity is not the same thing as always 95%. It previously hardcoded 1.96 and a "95%" label, so setting alpha to 0.01 gave a page reporting 99% intervals everywhere except this panel.
- A-vs-B shares no control arm, so it falls outside the Dunnett family. Under the Dunnett strategy it is reported unadjusted and labelled exploratory rather than silently borrowing the Dunnett critical value.
- All power figures are per-comparison, not disjunctive or conjunctive across contrasts.
- A single control-arm attrition rate drives both the completer counts and the retention event rate; arm-specific attrition is not modelled.
- The optional t correction uses a univariate t at the adjusted tail, which approximates rather than exactly reproduces Dunnett's multivariate-t quantile. The t quantile itself is a Cornish-Fisher expansion rather than an exact inverse, but it is accurate to 1.5e-5 or better everywhere in the reachable parameter space, including at 40 clinicians and at the most extreme tail the URL codec permits. That is far below display precision, so the substitution above is the only approximation in this path that matters.
- The DIF substudy uses randomized counts, not completers: item responses come from the baseline assessment, which everyone randomized provides. Its design effect is therefore computed on the randomized cluster size, unlike the HAM-D outcome which uses the post-attrition one. It uses the same total cluster-size variation as the outcome path (between-site and within-site in quadrature); the spillover substudy does too.
- DIF standard errors assume `Var(b) ~ 1/(n x I)`, where `I` is the information one respondent contributes about one item's location. For a dichotomous Rasch item `I = p(1-p)`, so the 0.25 default is that item type's *ceiling* (perfect targeting), not a low estimate; it is conservative only relative to HAM-D, whose partial-credit items carry more. This is the most leveraged assumption in the panel: 0.25 to 0.6 moves power at 0.43 logits from 46% to 82%. Set it from real item parameters.
- Multiplicity across items is not modelled. Testing DIF on ~17 HAM-D items per subgroup dimension would raise the critical value, partly offsetting the gain from higher item information. No arm-level multiplicity applies either way, since DIF is a measurement question rather than an arm comparison.

## Hybrid randomization

Under `randomization: "hybrid"` the clinicians are the randomization unit for ROM vs
no-ROM only; app-only vs TAU is randomized within the no-ROM clinicians. Consequences the
model accounts for:

- **App-only vs TAU becomes a within-clinician contrast.** The clinician effect is common
  to both arms and cancels, so its variance factor is `(1 - ICC)(1/n1 + 1/n2)` rather than
  a design effect above 1. At ICC 0.04 this is roughly a 14% improvement in that MDE.
- **The other two contrasts stay between-clinician**, but improve slightly anyway: control
  patients are now spread across all no-ROM clinicians rather than concentrated, so each
  clinician contributes fewer of them and the arm's design effect falls.
- **The ICC and DIF substudies gain**, because the same AURORA users are spread over more
  clinicians. Clinician counts are deduped by randomization unit so shared clinicians are
  not double counted.
- **Not modelled: spillover.** A no-ROM clinician treats both app-only and TAU patients, so
  any behaviour change they carry across patients would dilute that contrast. The
  within-clinician gain assumes none.
- **Dunnett is approximate under hybrid.** Its lambda parameterisation assumes the
  active-vs-control statistics share a variance structure; here app-only vs TAU has a
  materially smaller variance, so the true correlation is lower and the correct critical
  value slightly higher. The default exploratory framing applies no adjustment, so this
  only matters under a confirmatory framing, where Bonferroni is the conservative choice.

## Site-stratified randomization

Clinicians are randomized **within site** (11 sites, eTable 1 of the design memo), so the
calculator allocates per site and aggregates rather than apportioning one pool. Three
consequences that are not apparent by inspection:

- **Realized allocation drifts from nominal, in a direction that depends on the roster.**
  B.3 40/30/30 comes out 42.3/57.7 at 111 clinicians but 38.0/62.0 at 100. Extreme ratios
  drift most: 3:1 realizes as 77/23, because every site's exact split leaves a 0.75
  fraction and largest-remainder awards the odd clinician to the larger arm each time.
- **Exact ties must be rotated.** A 6-clinician site at 3:1 splits 4.5/1.5, a genuine tie.
  Resolving it the same way at every site turned 75/25 into 79/21; `allocateClusters`
  therefore takes a `tieBreak` index that rotates which arm wins, which recovers 77/23.
- **Cell feasibility is non-monotonic.** At `mixedShare` 0.15 five sites get a single mixed
  clinician; at 0.20 none do.

Variance is pooled across strata by inverse variance, `1/V = SUM_s 1/V_s`. With one site
this reduces exactly to the unstratified formula, which is why a one-site roster reproduces
the pre-stratification numbers bit for bit — the property the regression checks rely on.

### Why `clusterSizeCV` survives

Cluster-size variation has two independent sources that add in quadrature,
`CV_total^2 = CV_between^2 + CV_within^2`. The roster supplies only the first. Its panel
sizes barely vary (nine sites at exactly 10 patients per clinician, two at 11), giving
`CV_between = 0.038` and an inflation of 1.0014 against 1.04 for an assumed 0.2. The
dominant term is clinicians differing from **each other within a site**, and a roster of
planned targets holds no information about it. Replacing the parameter with the roster
would make every MDE about 1.9% more optimistic by dropping a real variance component, so
the parameter stays, relabelled as the within-site residual.

## Within-clinician effect spillover substudy

Setting `mixedShare` above zero introduces a third clinician type: ROM-trained, dashboard
in hand, but with only some of their patients on it. Comparing the *same arm* across
clinician types identifies spillover of the clinician's training onto patients who are not
on the dashboard, which the parallel design has to assume away.

Panels are split proportionally to the target allocation, which makes the arm allocation
invariant to the number of mixed panels. Writing `pA` for arm A's share:

```
P = pA (J - M),   K = (1 - pA)(J - M),   so P + M + K = J for any M
A patients = P m + M (m pA) = pA J m,    unchanged; same for B and C
```

So the dial changes only how patients are *arranged* across clinicians, never how many are
in each arm. The cost is that the clean primary contrast draws on fewer pure-ROM and
no-ROM clinicians, which widens its interval; the panel reports that cost per row.

The substudy has an on/off toggle. `mixedShare` remains the **effective** share (0 when
off) so links written before the toggle existed keep their numbers exactly; the toggle
moves the value between it and `spilloverPreset`, which is what the substudy returns to
when switched back on. A link can therefore pre-specify "off, but configured at 25%", and
switching off then on restores the value that was there rather than a default. The panel
collapses when off, and expands when enabled or when a link targets `#spillover`.

The panel reports practicality per site alongside the statistical trade-off, because the
two pull in opposite directions on this roster: the settings that are affordable
statistically are the ones that fail operationally. At a 10% mixed share every site gets
exactly one mixed clinician, so nothing is interpretable; only at 30% does every site clear
two, and that is the setting where the primary interval already exceeds the effect the
literature expects. A single mixed clinician contributes roughly two completers per
spillover cell, which is the number that decides whether the substudy is worth running.

Caveats worth carrying into a protocol: the per-path estimates (onto app-only, onto TAU)
are much weaker than the pooled one and should be treated as descriptive; spillover should
attenuate the treatment effect, so an estimate of the opposite sign is noise; and a mixed
panel needs the full patients-per-clinician target to preserve its three-way split, which
makes the design fragile to under-recruitment and hard to run at sites with few clinicians.

## Responsiveness interviews (Aim 2.2)

Aim 2.2 promises PPV, sensitivity and specificity for AURORA-detected severity shifts,
from clinician ratings "obtained within 24 hours, as well as at random". That takes two
kinds of extra HAM-D, both only in the arms that use AURORA, since the algorithm does not
run in TAU:

- **Triggered interviews**, when the algorithm's estimate has moved by the threshold since
  the last HAM-D, at most one per four-week interval. They estimate PPV, defined as a
  change of 3 or more points in the flagged direction.
- **Random audits**, scheduled at randomization, one in each of k equal strata of days
  7–111 and never within 3 days of a scheduled HAM-D. They estimate the miss rate: the
  share of audits the algorithm scores negative that hold a real change.

The panel splits the work the same way the rest of the calculator does. **Computed here, in
closed form and mirrored in the R script:**

- requests and completions per app user;
- precision of the miss rate (overall and in the smallest fairness subgroup) and of PPV;
- peak weekly interviews and rater hours per site;
- cost by site;
- the fit against the application's assessment budget.

**Taken from the simulation:** how often the algorithm triggers at each threshold, how
often an audit finds it negative, and its true and observed miss rate and PPV. Those rest
on a stand-in algorithm and uncalibrated trajectories, so they are presets in
`src/responsiveness.js`, regenerated from `simulations/` when AURORA's real trigger rule
and pilot data arrive, rather than settings to tune.

Statistical notes:

- **Dropout.** Exponential, reaching `controlAttrition` at day 112. Audits are requested
  only while the participant is enrolled, so the share requested is their mean survival
  over the eligible days. Triggers cluster early in follow-up, so they are discounted by
  survival to their mean day instead. At the simulation's own 20% attrition this
  reproduces its request rates within 0.005 at every threshold.
- **Precision is binomial** at the observed (as-scored) rate, taking whichever HAM-D model
  gives the wider interval. Repeated audits on one person are correlated, but the
  simulated intervals match the binomial within 0.002 at 1, 2 and 4 audits per person.
  No arm-level multiplicity applies; alpha and the small-sample t do, as in the ICC and DIF
  panels.
- **Rater error is the binding problem.** It inflates the observed miss rate several-fold:
  at a 5-point change it is 0.02–0.07 in truth but 0.22–0.26 with one rater. PPV, as
  defined, barely moves. The panel shows true and as-scored values for both HAM-D models,
  so the scoring choice is visible alongside the precision it buys.
- **Load and cost.** Peak weekly load assumes even enrollment over `respEnrollWeeks`, or
  16 weeks if enrollment is faster. Each interview takes 40 minutes of rater time, plus 25
  for each extra rater scoring the recording, and 45 minutes of the participant's. Hourly
  rates and per-site cost factors come from the budget module (see "Budget figures"
  below); sites whose assessment is covered by salaried staff are reported as staff time.
- **Budget fit.** The budget pays a number of assessment hours per patient; the scheduled
  interviews take 140–255 minutes. The panel reports whether the design's rater hours fit
  in the remaining margin, spread over the app users.

## Budget figures

The cost and budget-fit estimates use figures from the AURORA application budget, which
is internal and is not in this public repository.

- `src/budget.example.js` (committed) holds clearly labeled placeholder figures. The public
  site, which CI builds, shows these, and the panel marks its costs as placeholders.
- `src/budget.local.js` (gitignored) holds the real figures on study-team machines. When it
  exists, `vite.config.js` points imports of `src/budget.js` at it, so `npm run dev` and a
  local `npm run build` show real costs. `AURORA_PUBLIC_BUILD=1 npm run build` forces the
  placeholders.
- `npm run verify` always runs on the placeholders, and its cost checks are written as
  formulas over the imported rates, so they pass with either file.

Don't publish a local build made with the real figures: its bundle and source maps contain
them. To set up a new machine, copy `src/budget.example.js` to `src/budget.local.js` and
fill in the figures from the application budget.

## Simulations

`simulations/` holds the Python simulations behind the Aim 2.2 presets, with their output
from 22 October 2026. They need numpy and run from inside the folder, because the second
imports the first:

```bash
cd simulations
python aurora_random_hamd_audit_sim.py --reps 200        # random audits by number and design
python aurora_responsiveness_interview_sim.py --reps 200 # triggered interviews, timing, slots, cost
python aurora_responsiveness_interview_sim.py --reps 200 --recall 7   # HAM-D reflects the past week
python aurora_responsiveness_interview_sim.py --presets --reps 200    # the calculator's presets
```

The cost tables read the same budget module as the app (through Node), so on a study-team
machine they show the internal figures. Run with `AURORA_PUBLIC_BUILD=1` before saving
output into this folder; the saved output uses the placeholders.

After regenerating the presets, copy them into `src/responsiveness.js` and run
`npm run verify`. Several checks pin the panel to the simulation it summarizes, so a
changed simulation shows up there.

## The pooled contrast

`A+B vs C` is not a merged arm run through the pairwise machinery. Under hybrid the pooled
arm straddles both randomization units, so it needs its own variance in component form:

```
Var/s^2 = rho * [ SUM_k w_k^2/J_k + 1/J_ref
                  + 2 SUM_{k<l} w_k w_l [same unit]/J
                  - 2 SUM_k w_k [same unit as ref]/J ]
        + (1 - rho) * [ SUM_k w_k^2/n_k + 1/n_ref ]
```

The cross terms are the part a naive merge would miss: under hybrid, B and C share
clinicians, so their means are positively correlated and part of the between-clinician
variance cancels. Weights are proportional to sample size. Pooling a single arm reproduces
the ordinary pairwise factor exactly (checked at `clusterSizeCV = 0`).

**Cluster-size-variation convention.** The inherited pairwise design effect is
`(1 + (m-1)rho)(1 + CV^2)`, which inflates the *whole* variance including the
within-clinician part that unequal cluster sizes should not affect. The pooled and
within-cluster forms apply `(1 + CV^2)` to the between-clinician component only. The two
therefore diverge slightly when `CV > 0`, with the pooled form about 1.5% less inflated
at `CV = 0.2`. The inherited formula is retained on the pairwise path so the two-arm
regression against the original implementation continues to hold exactly.

## Section anchors

Every panel heading carries a stable `id` and a hover-revealed anchor that copies a link
combining the **current configuration token with the section fragment**, e.g.
`?c=1_0_0_3_…#spillover`. That lands a reader on the right panel showing the right numbers,
which is what makes a figure citable from a memo.

Stable ids: `design-summary`, `trial-design`, `parameters`, `measurement-model`,
`icc-validation`, `responsiveness`, `site-feasibility`, `spillover`, `fairness`, `chart-hamd`,
`chart-retention`, `chart-icc`, `sample-size`, `r-code`. Treat them as a wire format like
`FIELD_ORDER` — renaming one breaks every link already circulating.

Headings are also numbered, for citing a panel in a meeting ("section 6"). The numbers
live in `SECTION_NUMBERS` in `src/App.jsx` and are fixed per panel rather than computed
from page order, so a panel the current design hides (the spillover substudy, in two-arm
mode) leaves a gap instead of renumbering everything after it. Treat them like the ids:
give a new panel a new number, or a sub-number such as `6a`, rather than shifting existing
ones that memos may already cite.

Two things this needs that a plain `#id` does not. React renders after the document is
parsed, so a fragment in the initial URL never resolves natively (the target does not exist
yet) and the app scrolls once on mount instead. And `syncLocation` rewrites the URL on every
settings change, so it has to preserve the fragment or the anchor disappears the moment
anyone touches a control.

## URL tokens

The `?c=` parameter encodes every setting positionally (`1_<v0>_<v1>_...`, ~100 characters), not a diff against the defaults. That is deliberate: a link names every value it depends on, so changing an app default later cannot silently re-interpret a link shared before the change. `FIELD_ORDER` in `src/urlState.js` is therefore **append-only**. Inserting or reordering a field would change the meaning of every link already in circulation. Older, shorter tokens decode with their trailing fields falling back to defaults, which is the correct reading since those links genuinely did not specify them.

## License

This project is part of the AURORA Wellcome Trust grant application.
