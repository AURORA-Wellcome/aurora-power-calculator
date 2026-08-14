# AURORA Trial Power Calculator

Interactive web application for exploring the precision and minimum detectable effects achievable at a given sample size in the AURORA clinical trial.

## Features

- **Exploratory or confirmatory framing**: an exploratory study makes no efficacy claim, so no multiplicity adjustment is applied and the design is justified on **precision** (confidence interval width) rather than on power to declare significance. Charts and tables switch between CI half-width and MDE.
- **Two-arm and three-arm designs**: switch between the original treatment/control design and a three-arm design (clinician + patient / patient-only / usual care), with adjustable allocation. All arms are randomized at the clinician (cluster) level.
- **Pairwise contrasts**: in three-arm mode all three contrasts are reported — clinician+patient vs control, patient-only vs control, and the incremental value of clinician involvement (A vs B).
- **Arm-level multiplicity**: Dunnett's correction for the active-vs-control family (critical value computed by numerical integration, not looked up), with Bonferroni and unadjusted alternatives. The resulting critical value is always shown.
- **Cost of the third arm**: three-arm charts overlay the equivalent two-arm MDE so the efficiency trade-off is visible rather than inferred.
- **HAM-D Power Analysis**: MDEs for depression severity with adjustable intracluster correlation, covariate R², and measurement model options (sum score, Rasch partial credit, multi-facet Rasch).
- **Retention Analysis**: study retention modelled with survival analysis efficiency gains.
- **Intraclass Correlation Validation**: precision for AURORA-clinician agreement. In three-arm mode both AURORA-using arms contribute rating pairs.
- **Measurement fairness (DIF)**: subgroup sizes among AURORA users against a per-group adequacy minimum, plus the precision and detectable magnitude of a differential-item-functioning estimate in logits. Covers the "fair" half of the measurement aim, which subgroup size — not total N — usually constrains.
- **Allocation presets**: one-click `1:1:1` (balanced) and `2:2:1` (psychometric-weighted, more AURORA users) in three-arm mode.
- **Power for an assumed effect**: alongside the MDE, a direct power readout for a specified HAM-D difference.
- **Optional small-sample t correction**, with the cluster-level degrees of freedom displayed.
- **R code for verification**: a self-contained base-R script that reproduces every displayed number, runnable in the browser via WebR or pasted into a local R session.
- **Linkable configurations**: the address bar always carries a token encoding the full configuration, so any view can be shared or pasted into a document and reopened exactly. A "Copy link" button puts it on the clipboard. Following a link overrides locally saved settings.
- **Persistent Settings**: preferences are saved locally and restored on return visits.

## Layout

| Path | Purpose |
|---|---|
| `src/calc.js` | All statistics — quantiles, Dunnett critical values, cluster apportionment, the three outcome calculators. No React, so it can be exercised directly from Node. |
| `src/rcode.js` | Generates the R verification script (single source for both the displayed code and the WebR run). |
| `src/defaults.js` | Shipped default settings, importable without React so the checks can pin them. |
| `src/urlState.js` | Reversible URL token codec for the full configuration, with validation of untrusted input. |
| `src/App.js` | UI and charts. |
| `scripts/verify.mjs` | Checks for `src/calc.js` — see below. |
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

## Statistical notes

- **Precision does not depend on alpha or multiplicity.** The CI half-width is `crit x SE`, and the standard error — the thing that determines how precisely an effect is estimated — is untouched by the alpha level or the multiplicity rule. Only the MDE, a testing quantity, moves. If the study is sized on precision, the whole multiplicity debate is moot.
- Under the **exploratory** framing no adjustment is applied at either level, and alpha sets the confidence level rather than a significance threshold.
- Under the **confirmatory** framing, alpha is the **per-outcome** level (0.025 reflects Benjamini-Hochberg across the three outcomes) and any arm-level adjustment (Dunnett/Bonferroni) is applied **on top** of it. These are two separate layers.
- Outcome-level adjustment is only required when *any one* of several outcomes could carry the claim. A single designated primary (with secondaries tested hierarchically), or co-primaries where *all* must succeed (an intersection-union test), need no penalty.
- The ICC substudy is an **estimation** objective — ruling out ICC < 0.75 with a confidence interval — not a hypothesis test, so it does not belong in any alpha family.
- A-vs-B shares no control arm, so it falls outside the Dunnett family. Under the Dunnett strategy it is reported unadjusted and labelled exploratory rather than silently borrowing the Dunnett critical value.
- All power figures are per-comparison, not disjunctive or conjunctive across contrasts.
- A single control-arm attrition rate drives both the completer counts and the retention event rate; arm-specific attrition is not modelled.
- The optional t correction uses a univariate t at the adjusted tail, which approximates rather than exactly reproduces Dunnett's multivariate-t quantile.
- The DIF substudy uses **randomized** counts, not completers: item responses come from the baseline assessment, which everyone randomized provides. Its design effect is therefore computed on the randomized cluster size, unlike the HAM-D outcome which uses the post-attrition one.
- DIF standard errors assume `Var(b) ~ 1/(n x I)`, where `I` is the information **one respondent contributes about one item's location**. For a dichotomous Rasch item `I = p(1-p)`, so the 0.25 default is that item type's *ceiling* (perfect targeting), not a low estimate; it is conservative only relative to HAM-D, whose partial-credit items carry more. This is the most leveraged assumption in the panel — 0.25 to 0.6 moves power at 0.43 logits from 46% to 82% — and should be set from real item parameters.
- Multiplicity **across items** is not modelled. Testing DIF on ~17 HAM-D items per subgroup dimension would raise the critical value, partly offsetting the gain from higher item information. No arm-level multiplicity applies either way — DIF is a measurement question, not an arm comparison.

## URL tokens

The `?c=` parameter encodes every setting positionally (`1_<v0>_<v1>_...`, ~100 characters), not a diff against the defaults. That is deliberate: a link names every value it depends on, so changing an app default later cannot silently re-interpret a link shared before the change. `FIELD_ORDER` in `src/urlState.js` is therefore **append-only** — inserting or reordering a field would change the meaning of every link already in circulation. Older, shorter tokens decode with their trailing fields falling back to defaults, which is the correct reading since those links genuinely did not specify them.

## License

This project is part of the AURORA Wellcome Trust grant application.
