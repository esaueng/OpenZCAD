import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const required = ['unit', 'web', 'browser'];
export const BROWSER_SHARDS = 6;
export function qualificationReceipt(
  results,
  meta,
  previous = null,
  failures = null
) {
  return {
    source: meta.source,
    run: meta.run,
    results: Object.fromEntries(
      required.map((name) => [name, results[name]?.result ?? 'missing'])
    ),
    success: required.every((name) => results[name]?.result === 'success'),
    lastGreen: previous
      ? { source: previous.head_sha, url: previous.html_url }
      : null,
    // Advisory detail for triage. The verdict above never depends on it.
    failures
  };
}

function repositoryPath(root, path) {
  if (!path) return '(unknown file)';
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const inside = relative(root, absolute);
  return inside && !inside.startsWith('..') && !isAbsolute(inside)
    ? inside.split('\\').join('/')
    : path;
}

function firstLine(text) {
  return (
    String(text ?? '')
      .split('\n')
      .find((line) => line.trim()) ?? 'unknown error'
  )
    .trim()
    .slice(0, 200);
}

/** Failing test files in a Vitest JSON report, relative to the repository. */
export function vitestFailures(report, root) {
  const files = (report.testResults ?? [])
    .filter((file) => file.status === 'failed')
    .map((file) => repositoryPath(root, file.name));
  // Unhandled errors fail the run without failing any one file.
  if (!files.length && report.success === false)
    files.push('(run failed outside any test file; see the job log)');
  return [...new Set(files)].sort();
}

/** Failing spec files and run-level errors in a Playwright JSON report. */
export function playwrightFailures(report, root) {
  const testDir = report.config?.rootDir ?? join(root, 'test/e2e');
  const files = new Set();
  const visit = (suite) => {
    for (const spec of suite.specs ?? [])
      if (spec.ok === false)
        files.add(repositoryPath(root, join(testDir, spec.file ?? suite.file)));
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  const errors = (report.errors ?? []).map(
    (error) => `(run error: ${firstLine(error.message ?? error.value)})`
  );
  return [...[...files].sort(), ...errors];
}

function readReport(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Failing files per project from the downloaded `qualification-report-*`
 * artifacts. A missing or unreadable report is named, never treated as green.
 */
export function collectFailures(directory, root) {
  const unreadable = (what, report) =>
    report === null
      ? [`(no ${what} report: the job ended before writing it)`]
      : [`(unreadable ${what} report)`];
  const vitest = (artifact, file, what) => {
    const report = readReport(join(directory, artifact, file));
    return report ? vitestFailures(report, root) : unreadable(what, report);
  };
  const browser = [];
  for (let shard = 1; shard <= BROWSER_SHARDS; shard++) {
    const report = readReport(
      join(
        directory,
        `qualification-report-browser-${shard}`,
        'qualification-browser.json'
      )
    );
    browser.push(
      ...(report
        ? playwrightFailures(report, root)
        : unreadable(`browser shard ${shard}`, report))
    );
  }
  return {
    unit: vitest(
      'qualification-report-root',
      'qualification-root.json',
      'root'
    ),
    web: vitest('qualification-report-web', 'qualification-web.json', 'web'),
    browser
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
  let failures = null;
  try {
    failures = collectFailures(
      process.env.QUALIFICATION_REPORTS ?? 'qualification-reports',
      process.cwd()
    );
  } catch (error) {
    console.error(`Failing files are unavailable: ${firstLine(error.message)}`);
  }
  const receipt = qualificationReceipt(
    results,
    { source: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID },
    previous,
    failures
  );
  writeFileSync(
    'qualification-receipt.json',
    `${JSON.stringify(receipt, null, 2)}\n`
  );
  const failing = (name) =>
    receipt.results[name] === 'success' || !failures?.[name]?.length
      ? ''
      : `\n${failures[name].map((file) => `  - ${file}`).join('\n')}`;
  const summary =
    `## Full application qualification\n\nSource: \`${receipt.source}\`\n\n` +
    required
      .map((name) => `- ${name}: ${receipt.results[name]}${failing(name)}`)
      .join('\n') +
    `\n\nLast green scheduled main: ${previous ? `[${previous.head_sha}](${previous.html_url})` : 'unavailable'}\n`;
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (!receipt.success) process.exitCode = 1;
}
