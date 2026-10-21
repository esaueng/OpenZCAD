import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('superseded CI recovery', () => {
  const workflow = readFileSync('.github/workflows/ci-recovery.yml', 'utf8');

  it('exercises the actual recovery script against current heads, races and queue candidates', () => {
    const result = spawnSync(
      'python3',
      ['.github/ci-recovery/test_recovery.py'],
      {
        encoding: 'utf8'
      }
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('uses only metadata from a trusted workflow with narrowly scoped permissions', () => {
    expect(workflow).toContain('workflow_run:\n');
    expect(workflow).not.toContain('pull_request_target:');
    expect(workflow).toContain('workflows: [ci]');
    expect(workflow).toContain('types: [requested]');
    expect(workflow).toContain('  actions: write\n  pull-requests: read\n');
    expect(workflow).not.toMatch(
      /^\s*(?:uses:|contents: write|id-token: write)/m
    );
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\b/);
    const script = workflow.split("python3 - <<'PY'\n")[1];
    expect(script).not.toContain('${{');
    // Cancellation recovery must not change the required gates into skipped
    // successes when validation fails or the current run is canceled.
    const gates = readFileSync('.github/workflows/fleet-ci.yml', 'utf8');
    expect(gates).toContain(
      'needs: [quality, unit, validation]\n    if: always()'
    );
    expect(gates).toContain(
      'needs: [e2e-tests, e2e-tests-pr]\n    if: always()'
    );
  });
});
