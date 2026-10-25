import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The staged v4 callee (docs/runner-routing.md). Once `ci.yml` pins it,
// trusted-pr-policy.test.ts covers the active file and this moves there.
const workflow = readFileSync('.github/workflows/fleet-ci-v4.yml', 'utf8');
const v3 = readFileSync('.github/workflows/fleet-ci-v3.yml', 'utf8');

function job(name: string, source = workflow): string {
  const start = source.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const end = source.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
  // Drop the comment block introducing the next job.
  return source
    .slice(start, end === -1 ? undefined : start + 1 + end)
    .replace(/(\n {2}#[^\n]*|\n)*$/, '');
}

function gateScript(): string {
  const step = workflow.slice(
    workflow.indexOf('- name: Require one green shard set')
  );
  const lines = step
    .slice(step.indexOf('run: |\n') + 'run: |\n'.length)
    .split('\n');
  const script: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('          ')) break;
    script.push(line.slice(10));
  }
  return script.join('\n');
}

describe('staged fleet-ci-v4', () => {
  it('changes only the e2e shard trigger and gate relative to v3', () => {
    // Everything above the direct shard job's comment is v3 verbatim.
    expect(workflow.slice(0, workflow.indexOf('\n  # Main pushes and'))).toBe(
      v3.slice(0, v3.indexOf('\n  # Queue candidates, main pushes'))
    );
    expect(job('e2e-tests-pr')).toBe(job('e2e-tests-pr', v3));
  });

  it('runs shards on pull requests and dispatches, not queue candidates', () => {
    expect(job('e2e-tests')).toContain(
      "if: ${{ !cancelled() && github.event_name != 'pull_request' && github.event_name != 'merge_group' }}\n"
    );
    expect(job('e2e-tests-pr')).toContain(
      "if: ${{ !cancelled() && needs.quality.result == 'success' && (github.event_name == 'pull_request') }}\n"
    );
    expect(job('e2e')).toContain(
      'needs: [queue-trust, e2e-tests, e2e-tests-pr]\n    if: always()'
    );
    expect(job('validate')).toContain(
      'needs: [queue-trust, quality, unit, validation]\n    if: always()'
    );
  });

  it.each([
    ['pull_request', 'skipped', 'success', 0],
    ['pull_request', 'skipped', 'skipped', 1],
    ['pull_request', 'skipped', 'failure', 1],
    ['pull_request', 'skipped', 'cancelled', 1],
    ['pull_request', 'success', 'success', 1],
    ['workflow_dispatch', 'success', 'skipped', 0],
    ['workflow_dispatch', 'skipped', 'skipped', 1],
    ['workflow_dispatch', 'failure', 'skipped', 1],
    ['workflow_dispatch', 'cancelled', 'skipped', 1],
    ['merge_group', 'skipped', 'skipped', 0],
    ['merge_group', 'success', 'skipped', 0],
    ['merge_group', 'failure', 'skipped', 1],
    ['merge_group', 'cancelled', 'skipped', 1],
    ['merge_group', 'skipped', 'success', 0],
    ['', 'skipped', 'skipped', 1]
  ])('gates %s: direct %s, pull request %s', (event, direct, pr, status) => {
    const result = spawnSync('bash', ['-e', '-c', gateScript()], {
      env: {
        ...process.env,
        EVENT_NAME: event,
        DIRECT_RESULT: direct,
        PR_RESULT: pr
      }
    });
    expect(result.status).toBe(status);
  });
});
