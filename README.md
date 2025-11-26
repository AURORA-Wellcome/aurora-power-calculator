# AURORA Trial Power Calculator

Interactive web application for exploring minimum detectable effects (MDEs) and sample size requirements for the AURORA clinical trial.

## Features

- **HAM-D Power Analysis**: Calculate MDEs for depression severity outcomes with adjustable ICC, covariate R², and measurement model options (Rasch PCM, MFRM)
- **Retention Analysis**: Model study retention using survival analysis efficiency gains
- **Interactive Controls**: Adjust power, alpha, cluster size, attrition rates, and other parameters in real-time
- **Visualization**: Power curves showing MDE across sample sizes with clinically meaningful thresholds

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

## Statistical Model

The calculator models a 3:1 treatment:control cluster-randomized trial with:

- **HAM-D outcomes**: SD=7, 4 repeated measures, IPCW variance inflation, optional Rasch/MFRM scoring
- **Retention outcomes**: Survival analysis with configurable efficiency gain over binary endpoints
- **Clustering**: Adjustable ICC and patients per cluster
- **Multiple comparison correction**: Benjamini-Hochberg adjusted alpha levels

## License

This project is part of the AURORA Wellcome Trust grant application.
