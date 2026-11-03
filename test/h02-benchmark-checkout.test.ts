import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  assertBenchmarkCheckout,
  benchmarkCheckout
} from './support/benchmarkCheckout';

let directory: string;
let sourceCommit: string;
const repository = fileURLToPath(new URL('../', import.meta.url));
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
const sourceGit = (...args: string[]) =>
  execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'h02-checkout-'));
  git('init', '--quiet');
  await writeFile(
    join(directory, '.git/objects/info/alternates'),
    `${sourceGit('rev-parse', '--path-format=absolute', '--git-path', 'objects')}\n`
  );
  sourceCommit = sourceGit('rev-parse', 'HEAD');
  git('update-ref', 'HEAD', sourceCommit);
  git(
    'sparse-checkout',
    'set',
    '--no-cone',
    '/package.json',
    '/pnpm-lock.yaml'
  );
}, 30_000);
beforeEach(async () => {
  git('reset', '--hard', sourceCommit);
  await rm(join(directory, 'new-benchmark-source.ts'), { force: true });
}, 30_000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
}, 30_000);

it('identifies the same clean benchmark checkout from a nested directory', async () => {
  const initial = benchmarkCheckout({ cwd: directory });
  expect(() => assertBenchmarkCheckout(initial, directory)).not.toThrow();
  const nested = join(directory, 'apps', 'web');
  await mkdir(nested, { recursive: true });
  expect(benchmarkCheckout({ cwd: nested })).toEqual(initial);
}, 30_000);

it.each(['worktree', 'index', 'untracked'])(
  'refuses a dirty benchmark %s',
  { timeout: 30_000 },
  async (kind) => {
    const initial = benchmarkCheckout({ cwd: directory });
    const file =
      kind === 'untracked' ? 'new-benchmark-source.ts' : 'package.json';
    await writeFile(join(directory, file), '{}\n');
    if (kind === 'index') git('add', file);
    expect(() => benchmarkCheckout({ cwd: directory })).toThrow(
      /clean source checkout/
    );
    expect(() => assertBenchmarkCheckout(initial, directory)).toThrow(
      /clean source checkout/
    );
  }
);

it('refuses a different lockfile digest', () => {
  const initial = benchmarkCheckout({ cwd: directory });
  expect(() =>
    assertBenchmarkCheckout(
      { ...initial, lockfileSha256: 'different' },
      directory
    )
  ).toThrow(/changed after the build/);
}, 30_000);

it('refuses a different clean revision even with the same tree', () => {
  const initial = benchmarkCheckout({ cwd: directory });
  // Reuse public metadata and source objects; no parent history is required.
  const revision = execFileSync(
    'git',
    ['hash-object', '-t', 'commit', '-w', '--stdin'],
    {
      cwd: directory,
      encoding: 'utf8',
      input: `${sourceGit('cat-file', 'commit', 'HEAD')}\n\nH02 fixture revision.\n`
    }
  ).trim();
  git('reset', '--hard', revision);
  expect(benchmarkCheckout({ cwd: directory }).lockfileSha256).toBe(
    initial.lockfileSha256
  );
  expect(() => assertBenchmarkCheckout(initial, directory)).toThrow(
    /changed after the build/
  );
}, 30_000);
