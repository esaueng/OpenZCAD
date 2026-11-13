import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { FLEET_CI_PATH, FLEET_CI_PIN } from './fleet-workflow';
import {
  bashExecutable,
  pythonEnvironment,
  pythonExecutable
} from './support/testTools';

const workflow = readFileSync(FLEET_CI_PATH, 'utf8');

function stepScript(name: string, source = workflow): string {
  const step = source.slice(source.indexOf(`- name: ${name}`));
  const lines = step
    .slice(step.indexOf('run: |\n') + 'run: |\n'.length)
    .split('\n');
  const script: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('          ')) break;
    script.push(line.slice(10));
  }
  expect(script.length).toBeGreaterThan(0);
  return script.join('\n');
}

describe('required validation gate', () => {
  beforeAll(() => {
    // A depth-one CI checkout needs immutable Git objects and main history.
    // Obtain fixtures in setup; every policy assertion still runs below
    // under the unchanged test deadline, with fetch failures remaining fatal.
    execFileSync(
      pythonExecutable(),
      ['scripts/prepare-fleet-test-fixtures.py'],
      {
        env: pythonEnvironment(),
        encoding: 'utf8'
      }
    );
  });

  it('retires the orphan OIDC workflow and exercises immutable fleet routing', () => {
    expect(existsSync('.github/workflows/trusted-pr.yml')).toBe(false);
    const result = spawnSync(
      pythonExecutable(),
      ['scripts/test-direct-fleet.py'],
      {
        env: pythonEnvironment(),
        encoding: 'utf8',
        timeout: 25_000
      }
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it(
    'prepares cold Git evidence without bypassing offline or stale-pin assertions',
    { timeout: 30_000 },
    () => {
      const result = spawnSync(
        pythonExecutable(),
        ['scripts/test-fleet-test-fixtures.py'],
        {
          env: pythonEnvironment(),
          encoding: 'utf8'
        }
      );
      expect(result.status, result.stderr).toBe(0);
    }
  );
  const caller = readFileSync('.github/workflows/ci.yml', 'utf8');
  const ci = workflow;

  it('keeps the immutable runner policy identical to the reviewed source', () => {
    const pinned = execFileSync(
      'git',
      ['show', `${FLEET_CI_PIN}:${FLEET_CI_PATH}`],
      { encoding: 'utf8' }
    );
    expect(
      pinned,
      `Edit a new versioned fleet-ci file, not ${FLEET_CI_PATH}; see docs/runner-routing.md.`
    ).toBe(ci);
  });

  it('pins runner policy independently of PR edits and retains queue trust and validation dependencies', () => {
    expect(caller).toMatch(
      /uses: esaueng\/OpenZCAD\/\.github\/workflows\/fleet-ci(?:-v\d+)?\.yml@[0-9a-f]{40}\n/
    );
    expect(caller).not.toMatch(/secrets: inherit|runs-on:/);
    expect(caller).toContain(
      '      contents: read\n      pull-requests: read\n'
    );
    expect(ci).toContain(
      'needs: [queue-trust, plan, quality, typecheck, unit, validation]\n    if: always()'
    );
  });

  const gates = ['PLAN', 'QUALITY', 'TYPECHECK', 'UNIT', 'VALIDATION'];
  const gateCases: [string, string, number][] = [
    ['all', 'success', 0],
    ...gates.flatMap((gate) =>
      ['failure', 'cancelled', 'skipped'].map(
        (result): [string, string, number] => [gate, result, 1]
      )
    )
  ];
  it.each(gateCases)(
    'requires validation gates: %s %s',
    (gate, result, status) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const name of gates) env[`${name}_RESULT`] = 'success';
      if (gate !== 'all') env[`${gate}_RESULT`] = result;
      const run = spawnSync(
        bashExecutable(),
        ['-e', '-c', stepScript('Require all validation checks', ci)],
        { env }
      );
      expect(run.status).toBe(status);
    }
  );

  it('starts pull-request shards beside quality and runs only combined-tree canaries for queue candidates', () => {
    const job = (name: string) => {
      const start = ci.indexOf(`\n  ${name}:\n`);
      expect(start).toBeGreaterThan(-1);
      const end = ci.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
      return ci.slice(start, end === -1 ? undefined : start + 1 + end);
    };
    const direct = job('e2e-tests');
    const pr = job('e2e-tests-pr');
    const queue = job('e2e-queue');
    // Queue candidates run five tagged canaries against the combined tree,
    // or the full shard set when the plan asks for it; dispatches run the
    // direct set.
    expect(direct).toContain(
      "if: ${{ !cancelled() && needs.plan.result == 'success' && github.event_name != 'pull_request' && (github.event_name != 'merge_group' || needs.plan.outputs.e2e == 'full') }}\n"
    );
    expect(direct).toContain('needs: [queue-trust, plan]\n');
    expect(queue).toContain(
      "if: ${{ !cancelled() && needs.plan.result == 'success' && github.event_name == 'merge_group' && needs.plan.outputs.e2e != 'full' }}\n"
    );
    expect(queue).toContain('needs: [queue-trust, plan]\n');
    // Pull-request shards do not wait for lint and typecheck: on the Team
    // plan's 60 runners the wait cost more than the runners it saved.
    expect(pr).toContain(
      "if: ${{ !cancelled() && needs.plan.result == 'success' && (github.event_name == 'pull_request') }}\n"
    );
    expect(pr).toContain('needs: [queue-trust, plan]\n');
    expect(pr).not.toContain('quality');
    // Both shard sets run the same matrix and steps, not drifting copies.
    expect(direct).toContain('strategy: &e2e-strategy\n');
    expect(direct).toContain('steps: &e2e-steps\n');
    expect(pr).toContain('strategy: *e2e-strategy\n');
    expect(pr).toContain('steps: *e2e-steps\n');
    expect(job('e2e')).toContain(
      'needs: [queue-trust, plan, e2e-tests, e2e-tests-pr, e2e-queue]\n    if: always()'
    );
  });

  it.each([
    ['pull_request', 'skipped', 'success', 'skipped', 0],
    ['pull_request', 'skipped', 'skipped', 'skipped', 1],
    ['pull_request', 'skipped', 'failure', 'skipped', 1],
    ['pull_request', 'skipped', 'cancelled', 'skipped', 1],
    ['pull_request', 'success', 'success', 'skipped', 1],
    ['pull_request', 'success', 'failure', 'skipped', 1],
    ['workflow_dispatch', 'success', 'skipped', 'skipped', 0],
    ['workflow_dispatch', 'skipped', 'skipped', 'skipped', 1],
    ['workflow_dispatch', 'failure', 'skipped', 'skipped', 1],
    ['workflow_dispatch', 'cancelled', 'skipped', 'skipped', 1],
    // A candidate needs executed browser coverage of the combined tree:
    // prior PR success no longer stands in for it.
    ['merge_group', 'skipped', 'skipped', 'success', 0],
    ['merge_group', 'success', 'skipped', 'skipped', 0],
    ['merge_group', 'skipped', 'skipped', 'skipped', 1],
    ['merge_group', 'skipped', 'skipped', 'failure', 1],
    ['merge_group', 'skipped', 'skipped', 'cancelled', 1],
    ['merge_group', 'failure', 'skipped', 'skipped', 1],
    ['merge_group', 'cancelled', 'skipped', 'skipped', 1],
    ['merge_group', 'skipped', 'failure', 'skipped', 1],
    ['', 'skipped', 'skipped', 'skipped', 1]
  ])(
    'requires one green shard set on %s: direct %s, pull request %s, queue %s',
    (event, direct, pr, queue, status) => {
      const result = spawnSync(
        bashExecutable(),
        ['-e', '-c', stepScript('Require one green shard set', ci)],
        {
          env: {
            ...process.env,
            EVENT_NAME: String(event),
            PLAN_RESULT: 'success',
            DIRECT_RESULT: String(direct),
            PR_RESULT: String(pr),
            QUEUE_RESULT: String(queue)
          }
        }
      );
      expect(result.status).toBe(status);
    }
  );

  it('fails the browser gate when the plan did not succeed', () => {
    const result = spawnSync(
      bashExecutable(),
      ['-e', '-c', stepScript('Require one green shard set', ci)],
      {
        env: {
          ...process.env,
          EVENT_NAME: 'pull_request',
          PLAN_RESULT: 'failure',
          DIRECT_RESULT: 'skipped',
          PR_RESULT: 'success',
          QUEUE_RESULT: 'skipped'
        }
      }
    );
    expect(result.status).not.toBe(0);
  });

  it('runs both halves of `pnpm test` across the unit and validation jobs', () => {
    // `pnpm test` is the root project followed by the web project; the jobs
    // split them, so each half has to appear or a whole project goes untested.
    const unit = ci.slice(
      ci.indexOf('\n  unit:\n'),
      ci.indexOf('\n  validate:\n')
    );
    const validation = ci.slice(
      ci.indexOf('\n  validation:\n'),
      ci.indexOf('\n  unit:\n')
    );
    expect(unit).toContain(
      'run: node scripts/run-ci-units.mjs root --shard=${{ matrix.shard }}/2\n'
    );
    expect(unit).toContain('shard: [1, 2]\n');
    expect(validation).toContain('run: node scripts/run-ci-units.mjs web\n');
    expect(validation).toContain('- run: pnpm test:parity-corpus\n');
    expect(validation).toContain('run: pnpm build\n');
  });
});

describe('routing fixture deadlines', () => {
  let evidence: {
    control: {
      exit_code: number;
      five_second_timeout: boolean;
      fetches: number;
    };
    prepared: {
      exit_code: number;
      five_second_timeout: boolean;
      fetches: number;
    };
    fixture_delay_seconds: number;
  };

  // This outer harness starts two Vitest processes. Their setup/test deadlines
  // remain 10s/5s; allow acquisition and native process startup outside them.
  beforeAll(() => {
    evidence = JSON.parse(
      execFileSync(
        pythonExecutable(),
        ['scripts/test-fleet-test-fixtures.py', '--deadline-evidence'],
        {
          env: pythonEnvironment(),
          encoding: 'utf8'
        }
      )
    ) as typeof evidence;
  }, 30_000);

  it('keeps a six-second fixture fetch outside the five-second policy test', () => {
    expect(evidence.fixture_delay_seconds).toBe(6);
    expect(evidence.control.fetches).toBe(1);
    expect(evidence.control.exit_code).not.toBe(0);
    expect(evidence.control.five_second_timeout).toBe(true);
    expect(evidence.prepared.fetches).toBe(1);
    expect(evidence.prepared.exit_code).toBe(0);
    expect(evidence.prepared.five_second_timeout).toBe(false);
  });
});
