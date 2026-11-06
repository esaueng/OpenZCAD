export function qualificationReceipt(
  results: Record<string, { result: string }>,
  meta: { source: string; run: string },
  previous?: { head_sha: string; html_url: string } | null
): {
  source: string;
  run: string;
  results: Record<string, string>;
  success: boolean;
  lastGreen: { source: string; url: string } | null;
};
