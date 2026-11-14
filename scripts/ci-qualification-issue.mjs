import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Keeps one tracking issue in step with scheduled full qualification on main:
 * opened on the first red run, updated on each later red run, closed by the
 * next green one. It reports; it never changes the qualification verdict.
 */
export const TRACKING_MARKER = '<!-- openzcad:daily-qualification -->';
export const TRACKING_TITLE = 'Daily full qualification is failing on main';
const PROJECTS = ['unit', 'web', 'browser'];
const LISTED_FILES = 40;

// Issue text quotes test paths and error lines. Code spans keep them inert
// (no @-mentions or issue links); a backtick cannot end the span early.
const code = (text) => `\`${String(text).replaceAll('`', "'")}\``;

export function runUrl(receipt, meta) {
  return `${meta.server}/${meta.repository}/actions/runs/${receipt.run}`;
}

function failingLines(receipt) {
  const lines = [];
  for (const name of PROJECTS) {
    const result = receipt.results[name];
    if (result === 'success') continue;
    const files = receipt.failures?.[name];
    lines.push(`- **${name}**: ${result}`);
    if (!files) {
      lines.push('  - failing files unavailable; see the run');
      continue;
    }
    for (const file of files.slice(0, LISTED_FILES))
      lines.push(`  - ${code(file)}`);
    if (files.length > LISTED_FILES)
      lines.push(`  - …and ${files.length - LISTED_FILES} more in the run`);
  }
  return lines;
}

export function issueBody(receipt, meta) {
  const lastGreen = receipt.lastGreen
    ? `${code(receipt.lastGreen.source)} ([run](${receipt.lastGreen.url}))`
    : 'none recorded';
  return [
    TRACKING_MARKER,
    'Scheduled full qualification (`.github/workflows/daily-validation.yml`) ' +
      'is red on `main`. Pull-request CI runs the smoke selection, so these ' +
      'failures can stay invisible there.',
    '',
    `**Latest failing source:** ${code(receipt.source)} ([run](${runUrl(receipt, meta)}))`,
    `**Last green scheduled main:** ${lastGreen}`,
    '',
    '### Failing projects and files',
    '',
    ...failingLines(receipt),
    '',
    'Triage per `docs/ci-qualification.md`: separate product failures from ' +
      'harness or resource failures, and promote a confirmed regression into ' +
      'the critical or affected PR coverage. This issue closes itself on the ' +
      'next green scheduled run.'
  ].join('\n');
}

/** What to do with the tracking issue for one scheduled receipt. */
export function trackingPlan(receipt, openIssue, meta) {
  if (receipt.success) {
    return openIssue
      ? {
          action: 'close',
          comment: `Scheduled full qualification passed on ${code(receipt.source)} ([run](${runUrl(receipt, meta)})). Closing.`
        }
      : { action: 'none' };
  }
  const body = issueBody(receipt, meta);
  if (!openIssue) return { action: 'create', title: TRACKING_TITLE, body };
  const failed = PROJECTS.filter((name) => receipt.results[name] !== 'success');
  return {
    action: 'update',
    body,
    comment: `Still failing on ${code(receipt.source)} ([run](${runUrl(receipt, meta)})): ${failed.join(', ')}.`
  };
}

/** The open tracking issue this workflow opened earlier, if any. */
export function findTrackingIssue(issues) {
  return (
    issues.find(
      (issue) =>
        !issue.pull_request &&
        issue.user?.login === 'github-actions[bot]' &&
        issue.body?.startsWith(TRACKING_MARKER)
    ) ?? null
  );
}

function api(path, method = 'GET', payload) {
  const output = execFileSync(
    'gh',
    ['api', '-X', method, path, ...(payload ? ['--input', '-'] : [])],
    { encoding: 'utf8', input: payload ? JSON.stringify(payload) : undefined }
  );
  return output.trim() ? JSON.parse(output) : null;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const receipt = JSON.parse(
    readFileSync(process.argv[2] ?? 'qualification-receipt.json', 'utf8')
  );
  const repository = process.env.GITHUB_REPOSITORY;
  const meta = {
    server: process.env.GITHUB_SERVER_URL ?? 'https://github.com',
    repository
  };
  const issues = `repos/${repository}/issues`;
  const open = findTrackingIssue(
    api(
      `${issues}?state=open&creator=${encodeURIComponent('github-actions[bot]')}&per_page=100`
    )
  );
  const plan = trackingPlan(receipt, open, meta);
  if (plan.action === 'create') {
    const issue = api(issues, 'POST', { title: plan.title, body: plan.body });
    console.log(`Opened ${issue.html_url}`);
  } else if (plan.action === 'update') {
    api(`${issues}/${open.number}`, 'PATCH', { body: plan.body });
    api(`${issues}/${open.number}/comments`, 'POST', { body: plan.comment });
    console.log(`Updated ${open.html_url}`);
  } else if (plan.action === 'close') {
    api(`${issues}/${open.number}/comments`, 'POST', { body: plan.comment });
    api(`${issues}/${open.number}`, 'PATCH', {
      state: 'closed',
      state_reason: 'completed'
    });
    console.log(`Closed ${open.html_url}`);
  } else {
    console.log('Qualification is green and no tracking issue is open.');
  }
}
