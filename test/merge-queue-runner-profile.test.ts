import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { FLEET_CI_PATH } from './fleet-workflow';

const workflow = readFileSync(FLEET_CI_PATH, 'utf8');
const alignment =
  '          CI_MEMORY=$((CI_MEMORY / $(getconf PAGESIZE) * $(getconf PAGESIZE)))\n';

it('keeps the reviewed runner isolation step byte for byte', () => {
  expect(workflow.split(alignment)).toHaveLength(2);
  const isolation = workflow.match(
    /^ {6}- &fleet-isolation\n[\s\S]*?(?=^ {6}- |^ {2}[\w-]+:)/m
  )![0];
  // Digest of the isolation step in the reviewed v2 callee (6cd1c223), whose
  // whole-file digest against e3248bad pinned the three-slot profile. Later
  // callees change application steps only; scripts/test-merge-queue-routing.py
  // holds every other job to the reviewed baseline plus its listed edits.
  expect(createHash('sha256').update(isolation).digest('hex')).toBe(
    '5cefec73a90d616050ae04e3d56d233952ea40eb17bc34e70fb3d4c6fbdc9b0c'
  );
  expect(workflow).toContain('labels: ci-server-jane-5gb\n');
  expect(workflow).not.toContain('"labels":"ci-server-jane"');
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
