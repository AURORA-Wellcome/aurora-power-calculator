# AURORA Trial Power Calculator

Interactive web application for exploring minimum detectable effects (MDEs) and sample size requirements for the AURORA clinical trial.

## Features

- **HAM-D Power Analysis**: Calculate MDEs for depression severity outcomes with adjustable intracluster correlation, covariate R², and measurement model options (Rasch Partial Credit Model, Multi-Facet Rasch Model)
- **Retention Analysis**: Model study retention using survival analysis efficiency gains
- **Intraclass Correlation Validation**: Estimate precision for AURORA-clinician agreement in the treatment arm
- **Interactive Controls**: Adjust power, alpha, cluster size, treatment:control ratio (1:1 to 4:1), attrition rates, and other parameters in real-time
- **Visualization**: Power curves showing MDE across sample sizes with clinically meaningful thresholds

## Statistical Model

The calculator models a cluster-randomized trial with configurable treatment:control allocation (default 3:1):

**Primary Outcome (HAM-D)**
- Variance: SD=7, adjusted for covariate R² (default 0.35)
- Repeated measures: 4 timepoints with ~0.5 correlation, yielding 1.43× efficiency gain
- Clustering: Design effect = 1 + (cluster size - 1) × intracluster correlation
- Inverse Probability of Censoring Weights: 1.20 variance inflation factor
- Optional measurement models: Rasch Partial Credit Model (interval scoring) and Multi-Facet Rasch Model (rater adjustment)

**Secondary Outcome (Retention)**
- Survival analysis with configurable efficiency gain (1-5×) over binary week-16 endpoint
- Clustering adjustment via intracluster correlation

**Intraclass Correlation Validation (Treatment Arm)**
- Estimates 95% CI precision for AURORA-clinician agreement
- Tests whether lower bound exceeds threshold for "good" reliability (default 0.75)
- Accounts for clustering in ICC estimation

**Multiple Comparisons**
- Benjamini-Hochberg adjusted alpha levels (default 0.025)

## Getting Started

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

### Build

```bash
npm run build
```

Creates a production build in the `build/` folder.

## License

This project is part of the AURORA Wellcome Trust grant application.
