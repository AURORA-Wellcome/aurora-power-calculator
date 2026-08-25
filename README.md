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
- **Hybrid cluster-individual randomization**: clinicians randomized to ROM vs no-ROM, then patients within no-ROM clinicians individually randomized to app-only vs TAU. That makes app-only vs TAU a within-clinician contrast, removing the between-clinician variance from it.
- **Allocation presets** matching the study design memo: `B.1` 33/33/33, `B.2` 50/25/25, `B.3` 40/30/30. Under hybrid, B.3 is the recommendation: it ties the balanced 45/27.5/27.5 allocation on the binding A-vs-C contrast (1.396 vs 1.395 at 110 clinicians) and beats it on B-vs-C and on the pooled contrast, because equalising the contrasts means giving back the free advantage hybrid hands to B-vs-C.
- **Power for an assumed effect**: alongside the MDE, a direct power readout for a specified HAM-D difference.
- **Optional small-sample t correction**, with the cluster-level degrees of freedom displayed.
- **R code for verification**: a self-contained base-R script that reproduces every displayed number, runnable in the browser via WebR or pasted into a local R session.
- **Linkable configurations**: the address bar always carries a token encoding the full configuration, so any view can be shared or pasted into a document and reopened exactly. A "Copy link" button puts it on the clipboard. Following a link overrides locally saved settings.
- **Persistent Settings**: preferences are saved locally and restored on return visits.

## Layout

| Path | Purpose |
|---|---|
| `src/calc.js` | All statistics: quantiles, Dunnett critical values, cluster apportionment, the three outcome calculators. No React, so it can be exercised directly from Node. |
| `src/rcode.js` | Generates the R verification script (single source for both the displayed code and the WebR run). |
| `src/defaults.js` | Shipped default settings, importable without React so the checks can pin them. |
| `src/urlState.js` | Reversible URL token codec for the full configuration, with validation of untrusted input. |
| `src/App.js` | UI and charts. |
| `scripts/verify.mjs` | Checks for `src/calc.js`, described below. |
| `scripts/crosscheck-r.mjs` | Emits the generated R for a design plus the corresponding JS values, for side-by-side comparison. |

## Run Locally

### Prerequisites

- Node.js (v18 or higher recommended)

### Installation

```bash
npm install
```

### Development

```bash
npm start
```

Opens the app at [http://localhost:3000](http://localhost:3000).

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

### Build

```bash
npm run build
```

Creates a production build in the `build/` folder.

## Effect sizes

HAM-D reports Cohen's d (`MDE / 7`, the assumed SD). Retention reports Cohen's h,
`|2 asin(sqrt(p1)) - 2 asin(sqrt(p2))|`, because d is defined for a mean difference and
does not transfer to proportions: a proportion's variance is tied to its level, so the
same absolute gap is a much larger effect near 0 or 1 than in the middle. A 5 percentage
point gap is h = 0.19 at 5 to 10%, but h = 0.10 at 45 to 50%. Both use the same rough
benchmarks (0.2 small, 0.5 medium, 0.8 large). In precision mode the reported effect size
is that of the CI half-width rather than the MDE, so it can be read against the same scale.

## Statistical notes

- The default measurement model is **multi-facet Rasch (MFRM)**, which takes both the Rasch interval-scoring gain and the removal of rater variance: together they cut HAM-D error variance by 11.7% and the MDE by about 6% against a sum score. This is an assumption about the planned analysis, not a property of the data. It requires the model to actually be fitted, and a rating design that lets rater effects be separated (raters linked across patients rather than each patient rated by one rater alone). The sum-score baseline stays on the chart so the size of the assumption is visible.

- **Precision does not depend on alpha or multiplicity.** The CI half-width is `crit x SE`, and the standard error, which is what determines how precisely an effect is estimated, is untouched by the alpha level or the multiplicity rule. Only the MDE, a testing quantity, moves. If the study is sized on precision, the whole multiplicity debate is moot.
- Under the exploratory framing no adjustment is applied at either level, and alpha sets the confidence level rather than a significance threshold.
- Under the confirmatory framing, alpha is the per-outcome level (0.025 reflects Benjamini-Hochberg across the three outcomes) and any arm-level adjustment (Dunnett/Bonferroni) is applied on top of it. These are two separate layers.
- Outcome-level adjustment is only required when *any one* of several outcomes could carry the claim. A single designated primary (with secondaries tested hierarchically), or co-primaries where *all* must succeed (an intersection-union test), need no penalty.
- The ICC substudy is an estimation objective (ruling out ICC < 0.75 with a confidence interval) rather than a hypothesis test, so it does not belong in any alpha family.
- A-vs-B shares no control arm, so it falls outside the Dunnett family. Under the Dunnett strategy it is reported unadjusted and labelled exploratory rather than silently borrowing the Dunnett critical value.
- All power figures are per-comparison, not disjunctive or conjunctive across contrasts.
- A single control-arm attrition rate drives both the completer counts and the retention event rate; arm-specific attrition is not modelled.
- The optional t correction uses a univariate t at the adjusted tail, which approximates rather than exactly reproduces Dunnett's multivariate-t quantile.
- The DIF substudy uses randomized counts, not completers: item responses come from the baseline assessment, which everyone randomized provides. Its design effect is therefore computed on the randomized cluster size, unlike the HAM-D outcome which uses the post-attrition one.
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

## Spillover substudy

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

## URL tokens

The `?c=` parameter encodes every setting positionally (`1_<v0>_<v1>_...`, ~100 characters), not a diff against the defaults. That is deliberate: a link names every value it depends on, so changing an app default later cannot silently re-interpret a link shared before the change. `FIELD_ORDER` in `src/urlState.js` is therefore **append-only**. Inserting or reordering a field would change the meaning of every link already in circulation. Older, shorter tokens decode with their trailing fields falling back to defaults, which is the correct reading since those links genuinely did not specify them.

## License

This project is part of the AURORA Wellcome Trust grant application.
