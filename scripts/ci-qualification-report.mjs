import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const required = ['unit', 'web', 'browser'];
export function qualificationReceipt(results, meta, previous = null) {
  return {
    source: meta.source,
    run: meta.run,
    results: Object.fromEntries(
      required.map((name) => [name, results[name]?.result ?? 'missing'])
    ),
    success: required.every((name) => results[name]?.result === 'success'),
    lastGreen: previous
      ? { source: previous.head_sha, url: previous.html_url }
      : null
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const results = JSON.parse(process.env.QUALIFICATION_RESULTS);
  let previous = null;
  try {
    const history = JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          `repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/daily-validation.yml/runs?branch=main&event=schedule&status=success&per_page=1`
        ],
        { encoding: 'utf8' }
      )
    );
    previous = history.workflow_runs?.[0] ?? null;
  } catch {
    console.error(
      'Last green scheduled qualification is unavailable; no success is inferred.'
    );
  }
  const receipt = qualificationReceipt(
    results,
    { source: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID },
    previous
  );
  writeFileSync(
    'qualification-receipt.json',
    `${JSON.stringify(receipt, null, 2)}\n`
  );
  const summary =
    `## Full application qualification\n\nSource: \`${receipt.source}\`\n\n` +
    required.map((name) => `- ${name}: ${receipt.results[name]}`).join('\n') +
    `\n\nLast green scheduled main: ${previous ? `[${previous.head_sha}](${previous.html_url})` : 'unavailable'}\n`;
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (!receipt.success) process.exitCode = 1;
}
