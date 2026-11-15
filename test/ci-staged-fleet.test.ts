import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `fleet-ci-v9.yml` against the v8 it was copied from. v9 changes only
 * scheduling: jobs stop waiting on `plan`, and lint runs as two partitions.
 * The trust boundary and both required gates must stay byte-identical.
 */
const read = (version: string) =>
  readFileSync(`.github/workflows/fleet-ci-${version}.yml`, 'utf8');
const jobsOf = (workflow: string) =>
  Object.fromEntries(
    [
      ...workflow
        .split('\njobs:\n')[1]!
        .matchAll(/^ {2}([\w-]+):\n(.*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/gms)
    ].map((match) => [match[1]!, match[2]!])
  );

const previous = read('v8');
const staged = read('v9');
const before = jobsOf(previous);
const jobs = jobsOf(staged);
const needs = (job: string) => /^ {4}needs: (.+)$/m.exec(jobs[job]!)![1]!;
const runner = (workflow: string) =>
  /runs-on: &fleet-runner (.+)\n/.exec(workflow)![1]!;

describe('fleet-ci-v9 keeps the v8 trust boundary and required gates', () => {
  it('leaves triggers, queue authorization, isolation and routing untouched', () => {
    expect(staged.split('\njobs:\n')[0]).toBe(previous.split('\njobs:\n')[0]);
    expect(jobs['queue-trust']).toBe(before['queue-trust']);
    expect(runner(staged)).toBe(runner(previous));
    expect(Object.keys(jobs)).toEqual(Object.keys(before));
    for (const [name, body] of Object.entries(jobs)) {
      if (name === 'queue-trust' || name === 'plan') continue;
      // Every routed job still begins with the isolation guard, directly
      // or through the shared browser steps.
      expect(body, name).toMatch(
        / {4}steps:(?: &e2e-steps\n {6}- \*fleet-isolation| \*e2e-steps|\n {6}- \*fleet-isolation)\n/
      );
    }
  });

  it('keeps both required gates fail-closed on the kernel declaration', () => {
    expect(jobs.validate).toBe(before.validate);
    expect(jobs.e2e).toBe(before.e2e);
    expect(jobs.validate).toContain('test "$PLAN_RESULT" = success');
    expect(jobs.e2e).toContain('test "$PLAN_RESULT" = success');
    expect(jobs.plan).toContain('node scripts/kernel-pin-declaration.mjs');
    // The queue and manual browser sets are still chosen by `plan`.
    expect(jobs['e2e-tests']!.split('    runs-on:')[0]).toBe(
      before['e2e-tests']!.split('    runs-on:')[0]!.replace(
        '    env:\n      OPENZCAD_E2E_SUITE: ${{ needs.plan.outputs.e2e }}\n      CI_BASE_SHA: ${{ needs.plan.outputs.base }}\n',
        ''
      )
    );
    expect(jobs['e2e-queue']).toBe(before['e2e-queue']);
  });
});

describe('fleet-ci-v9 starts the checks without a serial preflight', () => {
  it('routes every check on queue trust alone and selects suites in the job', () => {
    for (const job of [
      'quality',
      'typecheck',
      'validation',
      'unit',
      'e2e-tests-pr'
    ]) {
      expect(needs(job), job).toBe('queue-trust');
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
    // PR shards reuse the shared browser steps, selection included.
    expect(jobs['e2e-tests-pr']).toContain('    steps: *e2e-steps\n');
    expect(staged).not.toMatch(/needs\.plan\.outputs\.(?:unit|base)/);
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
});
