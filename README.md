# AURORA Trial Power Calculator

Interactive web application for exploring minimum detectable effects (MDEs) and sample size requirements for the AURORA clinical trial.

## Features

- **HAM-D Power Analysis**: Calculate MDEs for depression severity outcomes with adjustable intracluster correlation, covariate R², and measurement model options
- **Retention Analysis**: Model study retention using survival analysis efficiency gains
- **Intraclass Correlation Validation**: Estimate precision for AURORA-clinician agreement in the treatment arm
- **Interactive Controls**: Adjust power, alpha, cluster size, treatment:control ratio, attrition rates, and other parameters in real-time
- **Visualization**: Power curves showing MDE across sample sizes with clinically meaningful thresholds
- **Persistent Settings**: User preferences are saved locally and restored on return visits

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
