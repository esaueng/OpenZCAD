import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/fleet-ci-v2.yml', 'utf8');
const alignment =
  '          CI_MEMORY=$((CI_MEMORY / $(getconf PAGESIZE) * $(getconf PAGESIZE)))\n';

it('preserves every reviewed queue workflow byte outside the approved profile', () => {
  expect(workflow.split(alignment)).toHaveLength(2);
  const previous = workflow
    .replace(
      'ci-server-jane-1|ci-server-jane-2|ci-server-jane-3)',
      'ci-server-jane-1|ci-server-jane-2)'
    )
    .replace('CI_MEMORY=5000000000', 'CI_MEMORY=6442450944')
    .replace(alignment, '')
    .replace('labels: ci-server-jane-5gb\n', 'labels: ci-server-jane\n')
    .replaceAll('"labels":"ci-server-jane-5gb"', '"labels":"ci-server-jane"');
  // Digest of the complete reviewed v2 callee in e3248bad. Keeping the
  // baseline here also verifies shallow CI checkouts without fetching a PR.
  // Only the explicit resource profile and selector literals can differ.
  expect(createHash('sha256').update(previous).digest('hex')).toBe(
    'bc1137220e6e4b943c8a944fc5b73f6f5f24b2011cad02fd1247d1c842026a5e'
  );
});

const profile = workflow.match(/case "\$RUNNER_NAME" in\n[\s\S]*?\besac/)![0];
function evaluateProfile(name: string): string {
  return execFileSync(
    'bash',
    [
      '-eu',
      '-c',
      'getconf() { printf "4096\\n"; };\n' +
        profile +
        '\n' +
        alignment +
        'printf "%s %s %s %s %s %s %s %s" "$CI_USER" "$CI_STORAGE" "$CI_SLICE" "$CI_DOCKER" "$CI_MEMORY" "$CI_CPUS" "$CARGO_BUILD_JOBS" "$RUST_TEST_THREADS"'
    ],
    {
      env: { ...process.env, RUNNER_NAME: name },
      encoding: 'utf8',
      stdio: 'pipe'
    }
  );
}

it('requires the exact isolated three-slot resources and page-aligned hard cap', () => {
  for (const slot of [1, 2, 3]) {
    expect(evaluateProfile(`ci-server-jane-${slot}`)).toBe(
      `ci-slot${slot} /srv/ci-slot${slot} cislot${slot}.slice ci-slot${slot}-docker 4999999488 6 3 6`
    );
  }
  expect(evaluateProfile('ci-server-john')).toBe(
    'ci-runner /srv/ci ci.slice ci-docker 3221225472 1 1 1'
  );
});

it('rejects unknown slot names instead of inferring access from a label', () => {
  for (const name of [
    '',
    'ci-server-jane-0',
    'ci-server-jane-4',
    'ci-server-jane-3-extra',
    'unknown'
  ]) {
    expect(() => evaluateProfile(name)).toThrow();
  }
});

it('keeps legacy callers quarantined behind a distinct profile selector', () => {
  expect(workflow).toContain('labels: ci-server-jane-5gb\n');
  expect(workflow.match(/"labels":"ci-server-jane-5gb"/g)).toHaveLength(2);
  expect(workflow).not.toContain('labels: ci-server-jane\n');
  expect(workflow).not.toContain('"labels":"ci-server-jane"');
  expect(workflow).toContain("vars.CI_FLEET_TARGET == 'ci-server-jane'");
});
