import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function changedPaths(base, cwd = process.cwd()) {
  if (!/^[0-9a-f]{40}$/.test(base ?? ''))
    throw new Error('CI selection requires an exact base commit.');
  try {
    execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], {
      cwd,
      stdio: 'pipe'
    });
  } catch {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', base], {
      cwd,
      stdio: 'inherit'
    });
  }
  return execFileSync(
    'git',
    ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD'],
    {
      cwd,
      encoding: 'utf8'
    }
  )
    .split('\0')
    .filter(Boolean);
}

export function selectCI(
  paths,
  { event = 'pull_request', labels = [], deleted = false } = {}
) {
  const broad =
    /^(?:\.github\/|scripts\/|test\/support\/|test\/setup|test\/unit-global|test\/unit-ci-files|test\/e2e\/fixtures\/|test\/parity\/|packages\/(?:crypto|mls)\/|packages\/kernel-adapter\/package\.json$|(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|vitest.*|playwright.*|tsconfig.*|eslint.*|turbo\.json)$)|(?:^|\/)package\.json$/;
  const known =
    /^(?:apps\/web\/(?:src|worker)\/|packages\/[^/]+\/src\/|test\/|docs\/|public\/)|\.(?:md|css|svg|png|jpg|webp)$/;
  const explicitFull =
    event === 'schedule' ||
    event === 'workflow_dispatch' ||
    labels.includes('ci:full');
  const unitFull =
    explicitFull ||
    labels.includes('kernel-bump') ||
    deleted ||
    !paths.length ||
    paths.some((p) => broad.test(p) || !known.test(p));
  // Extended browser coverage has its own qualification lane. Removing a
  // browser regression still requires the full remaining matrix.
  const browserFull =
    explicitFull ||
    (deleted &&
      paths.some((p) => p.startsWith('test/e2e/') && p.endsWith('.spec.ts')));
  return {
    unit: unitFull ? 'full' : 'smoke',
    e2e: browserFull ? 'full' : 'smoke'
  };
}

export function changedBrowserSpecs(base, all, cwd = process.cwd()) {
  if (!base) return [];
  return browserSpecsFromChanges(changedPaths(base, cwd), all);
}

export function browserSpecsFromChanges(paths, all) {
  const changed = paths.filter(
    (p) => p.startsWith('test/e2e/') && p.endsWith('.spec.ts')
  );
  const names = changed.map((p) => p.slice('test/e2e/'.length));
  for (const name of names) {
    if (!all.includes(name))
      throw new Error(`Changed browser spec is missing: ${name}`);
  }
  return names;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const base = event.pull_request?.base.sha ?? event.merge_group?.base_sha;
  const paths = base ? changedPaths(base) : [];
  const plan = selectCI(paths, {
    event: process.env.GITHUB_EVENT_NAME,
    labels: event.pull_request?.labels?.map((l) => l.name) ?? [],
    deleted: paths.some((p) => !existsSync(p))
  });
  const output = `base=${base ?? ''}\nunit=${plan.unit}\ne2e=${plan.e2e}\n`;
  process.stdout.write(output);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, output);
}
