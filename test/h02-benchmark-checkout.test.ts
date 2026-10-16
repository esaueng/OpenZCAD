import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  assertBenchmarkCheckout,
  benchmarkCheckout
} from './support/benchmarkCheckout';

it('refuses dirty benchmark arms and a different clean revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h02-checkout-'));
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  const sourceGit = (...args: string[]) =>
    execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  try {
    // Borrow public source objects; all fixture mutations stay in this repo.
    git('init', '--quiet');
    await writeFile(
      join(directory, '.git/objects/info/alternates'),
      `${sourceGit('rev-parse', '--path-format=absolute', '--git-path', 'objects')}\n`
    );
    git('update-ref', 'HEAD', sourceGit('rev-parse', 'HEAD'));
    git(
      'sparse-checkout',
      'set',
      '--no-cone',
      '/package.json',
      '/pnpm-lock.yaml'
    );
    git('reset', '--hard', 'HEAD');
    const initial = benchmarkCheckout({ cwd: directory });
    expect(() => assertBenchmarkCheckout(initial, directory)).not.toThrow();
    const nested = join(directory, 'apps', 'web');
    await mkdir(nested, { recursive: true });
    expect(benchmarkCheckout({ cwd: nested })).toEqual(initial);
    await writeFile(join(directory, 'package.json'), '{}\n');
    expect(() => benchmarkCheckout({ cwd: directory })).toThrow(
      /clean source checkout/
    );
    expect(() => assertBenchmarkCheckout(initial, directory)).toThrow(
      /clean source checkout/
    );
    git('add', 'package.json');
    expect(() => benchmarkCheckout({ cwd: directory })).toThrow(
      /clean source checkout/
    );
    git('reset', '--hard', 'HEAD');
    await writeFile(
      join(directory, 'new-benchmark-source.ts'),
      '// public test fixture\n'
    );
    expect(() => benchmarkCheckout({ cwd: directory })).toThrow(
      /clean source checkout/
    );
    await rm(join(directory, 'new-benchmark-source.ts'));
    expect(() =>
      assertBenchmarkCheckout(
        { ...initial, lockfileSha256: 'different' },
        directory
      )
    ).toThrow(/changed after the build/);
    // CI checkouts can be shallow. Make an isolated same-tree revision using
    // the source commit's existing metadata, without needing parent history.
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
    expect(() => assertBenchmarkCheckout(initial, directory)).toThrow(
      /changed after the build/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
