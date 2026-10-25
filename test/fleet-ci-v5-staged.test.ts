import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLEET_CI_PATH } from './fleet-workflow';

// The staged v5 callee (docs/runner-routing.md). Once `ci.yml` pins it,
// trusted-pr-policy.test.ts covers the active file and this moves there.
const v5 = readFileSync('.github/workflows/fleet-ci-v5.yml', 'utf8');
const v4 = readFileSync(FLEET_CI_PATH, 'utf8');

// Every byte v5 changes relative to the active v4 callee.
const changes: Array<[string, string]> = [
  [
    "  # candidate held six of the org's 20 hosted runners while PRs and the next\n" +
      '  # candidate queued behind them. Lint, typecheck, both Vitest projects,\n' +
      '  # parity and the build still run on every candidate.\n',
    '  # candidate held six hosted runners while PRs and the next candidate queued\n' +
      '  # behind them. Lint, typecheck, both Vitest projects, parity and the build\n' +
      '  # still run on every candidate.\n'
  ],
  [
    '  # On a pull request the shards wait for lint and typecheck. Hosted runners\n' +
      '  # are a shared pool of concurrent jobs, and starting six browser shards on\n' +
      '  # every push let superseded and lint-red pushes hold them while queue\n' +
      '  # candidates waited 15-20 minutes for a runner. A push that `quality`\n' +
      '  # rejects, or that a newer push cancels within those minutes, now never\n' +
      '  # starts a shard. Queue candidates keep the parallel `e2e-tests` above.\n',
    '  # On a pull request the shards start at once, beside lint and typecheck.\n' +
      '  # They used to wait for `quality` so lint-red and superseded pushes would not\n' +
      "  # hold six runners of the Free plan's 20; on the Team plan's 60 that wait\n" +
      '  # (2-4 minutes per push) cost more than the runners it saved, and a newer\n' +
      "  # push still cancels a superseded run's shards. Queue candidates run none.\n"
  ],
  [
    "    if: ${{ !cancelled() && needs.quality.result == 'success' && (github.event_name == 'pull_request') }}\n" +
      '    needs: [queue-trust, quality]\n',
    "    if: ${{ !cancelled() && (github.event_name == 'pull_request') }}\n" +
      '    needs: queue-trust\n'
  ],
  [
    "              echo 'No shard ran; pull-request shards start only after quality passes.' >&2\n",
    "              echo 'No shard ran.' >&2\n"
  ]
];

describe('staged fleet-ci-v5', () => {
  it('is the active v4 callee plus only the parallel PR shard start', () => {
    expect(FLEET_CI_PATH).toBe('.github/workflows/fleet-ci-v4.yml');
    let expected = v4;
    for (const [before, after] of changes) {
      // A change that no longer matches once would approve nothing.
      expect(expected.split(before)).toHaveLength(2);
      expected = expected.replace(before, after);
    }
    expect(v5).toBe(expected);
  });

  it('starts pull-request shards beside quality and none on queue candidates', () => {
    const start = v5.indexOf('\n  e2e-tests-pr:\n');
    const job = v5.slice(start, v5.indexOf('\n    steps: *e2e-steps\n', start));
    expect(job).not.toContain('quality');
    expect(job).toContain('    needs: queue-trust\n');
    expect(v5).toContain(
      "if: ${{ !cancelled() && github.event_name != 'pull_request' && github.event_name != 'merge_group' }}\n"
    );
  });
});
