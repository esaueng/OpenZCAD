export const VSYNC_MS: number;

export interface Stats {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  mean: number | null;
  max: number | null;
}

export function stats(values: readonly number[]): Stats;

export function droppedFrames(
  intervals: readonly number[],
  periodMs?: number
): { missed: number; refreshes: number; pct: number | null };

export function readRun(dir: string): unknown[];

export function runMarkdown(results: readonly unknown[]): string;

export function writeRunSummary(dir: string): unknown[];

export function spread(
  values: readonly (number | null | undefined)[]
): { median: number; min: number; max: number; runs: number } | null;

export function compareMarkdown(options: {
  before: readonly (readonly unknown[])[];
  after: readonly (readonly unknown[])[];
  beforeLabel?: string;
  afterLabel?: string;
}): string;
