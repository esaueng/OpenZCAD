import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface BenchmarkCheckout {
  sourceCommit: string;
  lockfileSha256: string;
}

export function benchmarkCheckout({
  cwd = process.cwd(),
  requireClean = true
} = {}): BenchmarkCheckout {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const root = git(['rev-parse', '--show-toplevel']);
  if (
    requireClean &&
    git(['status', '--porcelain=v1', '--untracked-files=normal'])
  )
    throw new Error('H02 matched benchmarks require a clean source checkout.');
  return {
    sourceCommit: git(['rev-parse', 'HEAD']),
    lockfileSha256: createHash('sha256')
      .update(readFileSync(resolve(root, 'pnpm-lock.yaml')))
      .digest('hex')
  };
}

export function assertBenchmarkCheckout(
  expected: BenchmarkCheckout,
  cwd = process.cwd()
): void {
  const actual = benchmarkCheckout({ cwd });
  if (
    actual.sourceCommit !== expected.sourceCommit ||
    actual.lockfileSha256 !== expected.lockfileSha256
  )
    throw new Error(
      'The H02 source checkout changed after the build was selected.'
    );
}
