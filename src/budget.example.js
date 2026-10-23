// Placeholder budget figures for the public build. The real figures come from the
// application budget, which is internal, and live in src/budget.local.js (gitignored).
// When that file exists, the Vite build uses it instead of this one; Node scripts
// (npm run verify) and CI always use this file, so the checks test the arithmetic, not
// the figures. See the "Budget figures" section of the README.

export const BUDGET_IS_ILLUSTRATIVE = true;
export const BUDGET_SOURCE = "illustrative placeholder figures";

// Hourly rates: assessment and admin time, and participant time.
export const RATER_RATE = 40;
export const PATIENT_RATE = 25;

// Assessment hours paid per patient.
export const BUDGETED_ASSESSMENT_HOURS = 5;

// Per-site cost relative to US rates: { factor, staff }. staff marks sites whose
// assessment is covered by salaried staff, so their cost is reported as staff time.
// A site not listed here is costed at US rates.
export const SITE_COSTING = {};
