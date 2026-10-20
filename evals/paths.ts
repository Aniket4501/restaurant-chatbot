import path from "node:path";

// D-21: where runs, reports and the baseline pointer live. The app runs from the repository root (npm scripts), so
// process.cwd() is the root here; EVALS_RESULTS_DIR moves results for tests and side runs.
export const APP_ROOT = process.cwd();
export const resultsDir = () => (process.env.EVALS_RESULTS_DIR ? path.resolve(process.env.EVALS_RESULTS_DIR) : path.join(APP_ROOT, "evals/results"));
export const reportsDir = () => path.join(APP_ROOT, "evals/reports");
export const baselineFile = () => (process.env.EVALS_BASELINE_FILE ? path.resolve(process.env.EVALS_BASELINE_FILE) : path.join(APP_ROOT, "evals/baseline.json"));
