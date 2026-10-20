import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('fleet-ci pin keeper', () => {
  const workflow = readFileSync('.github/workflows/fleet-ci-pin.yml', 'utf8');

  it('keeps only pins the pull request carries, against a fake API', () => {
    const result = spawnSync('python3', ['.github/fleet-pin/test_keep_pin.py'], {
      encoding: 'utf8'
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('runs the base-branch script with write access only to contents', () => {
    expect(workflow).toContain(
      'pull_request_target:\n    types: [opened, synchronize, reopened]\n    paths: [.github/workflows/ci.yml]\n'
    );
    expect(workflow).toContain('permissions: {}\n');
    expect(workflow).toContain('    permissions:\n      contents: write\n    steps:');
    expect(workflow).toContain(
      'if: github.event.pull_request.head.repo.full_name == github.repository'
    );
    // The checkout is the trusted base ref: no PR ref, no persisted token.
    expect(workflow).not.toMatch(/^\s+ref:/m);
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('sparse-checkout: .github/fleet-pin\n');
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\b/);
    expect(workflow).not.toMatch(/id-token: write|actions: write/);
    // Event fields reach the script only through the environment.
    const run = workflow.slice(workflow.indexOf('        run: '));
    expect(run).not.toContain('${{');
  });
});
