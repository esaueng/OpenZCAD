/** One summary row of `measure-active1-baselines.mjs`. */
export interface Active1SummaryRow {
  measurement: string;
  runs: number;
  median: number | null;
  min: number | null;
  max: number | null;
  budget: number | null | undefined;
  unit: string;
  withinBudget: boolean | null;
}

/** Medians across a finished run's probes, with their budgets. */
export function summarize(dir: string): Active1SummaryRow[];

/** The public `perf-face-drag-trace` cases the `face-drag` probe runs. */
export const FACE_DRAG_CASES: string;
