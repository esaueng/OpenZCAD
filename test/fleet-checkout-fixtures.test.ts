import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const script = 'scripts/test-fleet-checkout-fixtures.py';
let history: string;

beforeAll(() => {
  history = mkdtempSync(join(tmpdir(), 'fleet-checkout-history-'));
  // Construct disposable history once; every regression assertion runs below
  // within the existing test deadline, and setup retains its default deadline.
  execFileSync('python3', [script, '--prepare', history], { encoding: 'utf8' });
});

afterAll(() => {
  if (history) rmSync(history, { recursive: true, force: true });
});

it.each([
  'cold_prepare_uses_one_main_transfer_and_warm_checkout_stays_offline',
  'partly_warm_checkout_still_prepares_comparison',
  'direct_entrypoint_prepares_both_snapshots_before_vitest_setup',
  'fetched_off_main_active_pin_is_rejected',
  'fetched_off_main_comparison_pin_is_rejected',
  'missing_comparison_fails_instead_of_skipping',
  'large_pinned_policy_survives_worktree_edits'
])('preserves real shallow Git provenance: %s', (name) => {
  const result = spawnSync('python3', [script, '--origin', history, `FleetCheckoutFixtureTests.test_${name}`], {
    encoding: 'utf8'
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 1 test');
});
