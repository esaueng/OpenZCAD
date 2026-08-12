import { describe, expect, it } from 'vitest';
import { resolveSourceCommit } from './sourceCommit';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

const noGit = () => null;

describe('resolveSourceCommit', () => {
  it('reads the commit Workers Builds injects', () => {
    // openzcad deploys through Workers Builds. This variable is the only
    // commit source that exists in that container, and the build-meta gate
    // rejects anything that is not 40 hex characters — so missing it here
    // fails the deploy, not a test.
    expect(
      resolveSourceCommit({ WORKERS_CI_COMMIT_SHA: SHA }, noGit)
    ).toBe(SHA);
  });

  it('still reads the Pages variable, for anything building that way', () => {
    expect(resolveSourceCommit({ CF_PAGES_COMMIT_SHA: SHA }, noGit)).toBe(SHA);
  });

  it('reads GITHUB_SHA in Actions', () => {
    expect(resolveSourceCommit({ GITHUB_SHA: SHA }, noGit)).toBe(SHA);
  });

  it('lets an explicit override win over every CI variable', () => {
    expect(
      resolveSourceCommit(
        {
          OPENZCAD_BUILD_COMMIT: SHA,
          GITHUB_SHA: OTHER,
          WORKERS_CI_COMMIT_SHA: OTHER,
          CF_PAGES_COMMIT_SHA: OTHER
        },
        noGit
      )
    ).toBe(SHA);
  });

  it('falls back to git only when no variable is set', () => {
    expect(resolveSourceCommit({}, () => `${SHA}\n`)).toBe(SHA);
  });

  it('ignores a variable that is set but blank', () => {
    expect(
      resolveSourceCommit({ WORKERS_CI_COMMIT_SHA: '   ' }, () => SHA)
    ).toBe(SHA);
  });

  it('returns "unknown" with no variable and no git, so the gate rejects it', () => {
    // Failing closed is the point: 'unknown' is not 40 hex characters, so
    // report-bundle-sizes --check refuses the build rather than shipping a
    // bundle whose provenance nobody can trace.
    expect(resolveSourceCommit({}, noGit)).toBe('unknown');
    expect(resolveSourceCommit({}, () => '')).toBe('unknown');
  });
});
