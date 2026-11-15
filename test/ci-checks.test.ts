import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CI_CHECKS_PATH } from './ci-workflow';
import {
  bashExecutable,
  pythonEnvironment,
  pythonExecutable
} from './support/testTools';

const ci = readFileSync(CI_CHECKS_PATH, 'utf8');
const jobs = Object.fromEntries(
  [
    ...ci
      .split('\njobs:\n')[1]!
      .matchAll(/^ {2}([\w-]+):\n(.*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/gms)
  ].map((match) => [match[1]!, match[2]!])
);

function stepScript(name: string): string {
  const step = ci.slice(ci.indexOf(`- name: ${name}`));
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
  it('calls hosted checks from the same commit and keeps the queue-facing workflows apart', () => {
    expect(existsSync('.github/workflows/trusted-pr.yml')).toBe(false);
    const result = spawnSync(
      pythonExecutable(),
      ['scripts/test-ci-workflows.py'],
      {
        env: pythonEnvironment(),
        encoding: 'utf8',
        timeout: 25_000
      }
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it('names exactly the jobs the two required contexts aggregate', () => {
    expect(Object.keys(jobs)).toEqual([
      'plan',
      'quality',
      'typecheck',
      'validation',
      'unit',
      'validate',
      'e2e-tests',
      'e2e-tests-pr',
      'e2e-queue',
      'e2e'
    ]);
    expect(jobs.validate).toContain(
      '    needs: [plan, quality, typecheck, unit, validation]\n    if: always()\n'
    );
    expect(jobs.e2e).toContain(
      '    needs: [plan, e2e-tests, e2e-tests-pr, e2e-queue]\n    if: always()\n'
    );
  });

  const gates = ['PLAN', 'QUALITY', 'TYPECHECK', 'UNIT', 'VALIDATION'];
  const gateCases: [string, string, number][] = [
    ['all', 'success', 0],
    ...gates.flatMap((gate) =>
      ['failure', 'cancelled', 'skipped', ''].map(
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
        ['-e', '-c', stepScript('Require all validation checks')],
        { env }
      );
      expect(run.status).toBe(status);
    }
  );

  it('starts every check without a serial preflight and selects suites in the job', () => {
    for (const job of [
      'plan',
      'quality',
      'typecheck',
      'validation',
      'unit',
      'e2e-tests-pr'
    ]) {
      // A job that waited on `plan` paid for a second hosted-runner wait.
      expect(jobs[job], job).not.toMatch(/^ {4}needs:/m);
      expect(jobs[job], job).not.toContain('needs.plan');
    }
    const select =
      '      - name: Select affected suites\n        id: select\n        run: node scripts/ci-selection.mjs\n';
    for (const [job, consumer] of [
      ['validation', 'node scripts/run-ci-units.mjs web'],
      ['unit', 'node scripts/run-ci-units.mjs root'],
      ['e2e-tests', 'node scripts/e2e-shards.mjs']
    ] as const) {
      const body = jobs[job]!;
      expect(body.split(select), job).toHaveLength(2);
      expect(body.indexOf(select), job).toBeLessThan(body.indexOf(consumer));
    }
    // The selection reaches the commands as step env, never as a default
    // that an unset output would silently narrow.
    for (const job of ['validation', 'unit']) {
      expect(jobs[job]).toContain(
        '          OPENZCAD_UNIT_SUITE: ${{ steps.select.outputs.unit }}\n          CI_BASE_SHA: ${{ steps.select.outputs.base }}\n'
      );
    }
    expect(jobs['e2e-tests']).toContain(
      '          OPENZCAD_E2E_SUITE: ${{ steps.select.outputs.e2e }}\n          CI_BASE_SHA: ${{ steps.select.outputs.base }}\n'
    );
    expect(ci).not.toMatch(/needs\.plan\.outputs\.(?:unit|base)/);
  });

  it('keeps the kernel declaration in `plan`, which both required gates demand', () => {
    expect(jobs.plan).toContain(
      "      - name: Refuse an unannounced geometry kernel bump\n        if: github.event_name == 'pull_request' || github.event_name == 'merge_group'\n        run: node scripts/kernel-pin-declaration.mjs\n"
    );
    expect(jobs.plan!.indexOf('kernel-pin-declaration.mjs')).toBeLessThan(
      jobs.plan!.indexOf('node scripts/ci-selection.mjs')
    );
    expect(jobs.validate).toContain('test "$PLAN_RESULT" = success');
    expect(jobs.e2e).toContain('test "$PLAN_RESULT" = success');
  });

  it('lints exactly the paths of `pnpm lint`, split over two runners', () => {
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const eslint =
      'node --max-old-space-size=6144 node_modules/eslint/bin/eslint.js';
    const whole = new RegExp(`^${eslint} (.+) --ext \\.ts,\\.tsx$`).exec(
      scripts.lint!
    )![1]!;
    expect(scripts['lint:paths']).toBe(`${eslint} --ext .ts,.tsx`);

    const partitions = JSON.parse(
      /^ {8}paths: (\[.+\])$/m.exec(jobs.quality!)![1]!.replaceAll("'", '"')
    ) as string[];
    expect(partitions).toHaveLength(2);
    expect(partitions.flatMap((paths) => paths.split(' ')).sort()).toEqual(
      whole.split(' ').sort()
    );
    expect(jobs.quality).toContain(
      '      - run: pnpm lint:paths ${{ matrix.paths }}\n'
    );
    expect(jobs.quality).toContain('      fail-fast: false\n');
    expect(jobs.quality).not.toContain('pnpm lint\n');
    expect(jobs.validate).toContain('test "$QUALITY_RESULT" = success');
  });

  it('starts pull-request shards beside quality and runs only combined-tree canaries for queue candidates', () => {
    const direct = jobs['e2e-tests']!;
    const pr = jobs['e2e-tests-pr']!;
    const queue = jobs['e2e-queue']!;
    // Queue candidates run five tagged canaries against the combined tree,
    // or the full shard set when the plan asks for it; dispatches run the
    // direct set.
    expect(direct).toContain(
      "    if: ${{ !cancelled() && needs.plan.result == 'success' && github.event_name != 'pull_request' && (github.event_name != 'merge_group' || needs.plan.outputs.e2e == 'full') }}\n"
    );
    expect(direct).toContain('    needs: plan\n');
    expect(queue).toContain(
      "    if: ${{ !cancelled() && needs.plan.result == 'success' && github.event_name == 'merge_group' && needs.plan.outputs.e2e != 'full' }}\n"
    );
    expect(queue).toContain('    needs: plan\n');
    expect(pr).toContain("    if: github.event_name == 'pull_request'\n");
    expect(pr).not.toContain('quality');
    // Both shard sets run the same matrix and steps, not drifting copies.
    expect(direct).toContain('strategy: &e2e-strategy\n');
    expect(direct).toContain('steps: &e2e-steps\n');
    expect(pr).toContain('strategy: *e2e-strategy\n');
    expect(pr).toContain('steps: *e2e-steps\n');
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
        ['-e', '-c', stepScript('Require one green shard set')],
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

  it.each(['failure', 'cancelled', 'skipped', ''])(
    'fails the browser gate when the plan result is "%s"',
    (plan) => {
      const result = spawnSync(
        bashExecutable(),
        ['-e', '-c', stepScript('Require one green shard set')],
        {
          env: {
            ...process.env,
            EVENT_NAME: 'pull_request',
            PLAN_RESULT: plan,
            DIRECT_RESULT: 'skipped',
            PR_RESULT: 'success',
            QUEUE_RESULT: 'skipped'
          }
        }
      );
      expect(result.status).not.toBe(0);
    }
  );

  it('runs both halves of `pnpm test` across the unit and validation jobs', () => {
    // `pnpm test` is the root project followed by the web project; the jobs
    // split them, so each half has to appear or a whole project goes untested.
    expect(jobs.unit).toContain(
      'run: node scripts/run-ci-units.mjs root --shard=${{ matrix.shard }}/2\n'
    );
    expect(jobs.unit).toContain('shard: [1, 2]\n');
    expect(jobs.validation).toContain(
      'run: node scripts/run-ci-units.mjs web\n'
    );
    expect(jobs.validation).toContain('- run: pnpm test:parity-corpus\n');
    expect(jobs.validation).toContain('run: pnpm build\n');
  });
});
