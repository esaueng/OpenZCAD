export type QualificationFailures = Record<
  'unit' | 'web' | 'browser',
  string[]
>;

export interface QualificationReceipt {
  source: string;
  run: string;
  results: Record<string, string>;
  success: boolean;
  lastGreen: { source: string; url: string } | null;
  failures: QualificationFailures | null;
}

export const BROWSER_SHARDS: number;

export function qualificationReceipt(
  results: Record<string, { result: string }>,
  meta: { source: string; run: string },
  previous?: { head_sha: string; html_url: string } | null,
  failures?: QualificationFailures | null
): QualificationReceipt;

export function vitestFailures(report: unknown, root: string): string[];

export function playwrightFailures(report: unknown, root: string): string[];

export function collectFailures(
  directory: string,
  root: string
): QualificationFailures;
