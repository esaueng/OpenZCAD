import { describe, expect, it } from 'vitest';
import {
  kernelBuildDetail,
  kernelBuildLabel,
  resolveKernelBuild,
  shortCommit
} from '../apps/web/src/lib/kernelBuild';

const PINNED = resolveKernelBuild({
  OZ_BREPKIT_VERSION: '0.4.2',
  OZ_BREPKIT_COMMIT: 'c4edaeb539a74feae8e03333ccc5337a3e6e151d'
});

describe('kernel build identity', () => {
  it('reads the version and commit Vite defines', () => {
    expect(PINNED).toEqual({
      adapter: 'brepkit',
      packageVersion: '0.4.2',
      sourceCommit: 'c4edaeb539a74feae8e03333ccc5337a3e6e151d'
    });
  });

  it('says so rather than reporting undefined outside a Vite build', () => {
    // Vitest applies neither define, and a settings row is a bad place to
    // discover that: "unknown" is a fact, "undefined" is a bug report.
    expect(resolveKernelBuild({})).toEqual({
      adapter: 'brepkit',
      packageVersion: 'unknown',
      sourceCommit: 'unknown'
    });
    expect(
      resolveKernelBuild({ OZ_BREPKIT_VERSION: '', OZ_BREPKIT_COMMIT: '' })
    ).toEqual(resolveKernelBuild({}));
  });
});

describe('kernel build formatting', () => {
  it('abbreviates a full sha and leaves anything else alone', () => {
    expect(shortCommit('c4edaeb539a74feae8e03333ccc5337a3e6e151d')).toBe(
      'c4edaeb'
    );
    expect(shortCommit('unknown')).toBe('unknown');
    expect(shortCommit('c4edaeb')).toBe('c4edaeb');
    // Not a sha: 40 characters, but not all hex.
    expect(shortCommit('z'.repeat(40))).toBe('z'.repeat(40));
  });

  it('labels the row with the version and an abbreviated commit', () => {
    expect(kernelBuildLabel(PINNED)).toBe('BrepKit 0.4.2 · c4edaeb');
    expect(kernelBuildLabel(resolveKernelBuild({}))).toBe(
      'BrepKit unknown · unknown'
    );
  });

  it('keeps the unabbreviated commit for the tooltip', () => {
    // A short sha is ambiguous across repositories; a defect report needs the
    // repository and the whole commit.
    expect(kernelBuildDetail(PINNED)).toBe(
      'BrepKit 0.4.2 — esaueng/brepkit@c4edaeb539a74feae8e03333ccc5337a3e6e151d'
    );
  });
});
