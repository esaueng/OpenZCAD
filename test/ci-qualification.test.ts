import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findTrackingIssue,
  issueBody,
  TRACKING_MARKER,
  trackingPlan
} from '../scripts/ci-qualification-issue.mjs';
import {
  collectFailures,
  playwrightFailures,
  qualificationReceipt,
  vitestFailures
} from '../scripts/ci-qualification-report.mjs';

const workflowJobs = (workflow: string) =>
  Object.fromEntries(
    [
      ...workflow
        .split('\njobs:\n')[1]!
        .matchAll(/^ {2}([\w-]+):\n(.*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/gms)
    ].map((match) => [match[1]!, match[2]!])
  );

describe('complete application qualification', () => {
  it('cannot report green when a complete project failed, skipped or never ran', () => {
    const green = {
      unit: { result: 'success' },
      web: { result: 'success' },
      browser: { result: 'success' }
    };
    const meta = { source: 'a'.repeat(40), run: '42' };
    expect(qualificationReceipt(green, meta).success).toBe(true);
    for (const name of ['unit', 'web', 'browser']) {
      for (const result of ['failure', 'cancelled', 'skipped'])
        expect(
          qualificationReceipt({ ...green, [name]: { result } }, meta).success
        ).toBe(false);
      const absent = { ...green } as Record<string, { result: string }>;
      delete absent[name];
      expect(qualificationReceipt(absent, meta).success).toBe(false);
    }
    expect(qualificationReceipt(green, meta).lastGreen).toBeNull();
    expect(
      qualificationReceipt(green, meta, {
        head_sha: 'b'.repeat(40),
        html_url: 'https://example.invalid/run/1'
      }).lastGreen?.source
    ).toBe('b'.repeat(40));
  });

  it('schedules complete unit, web, browser and coverage runs, independent of smoke defaults', () => {
    const workflow = readFileSync(
      '.github/workflows/daily-validation.yml',
      'utf8'
    );
    expect(workflow).toContain("cron: '37 7 * * *'");
    expect(workflow).toContain('OPENZCAD_UNIT_SUITE: full');
    expect(workflow).toContain('OPENZCAD_E2E_SUITE: full');
    expect(workflow).toContain('pnpm test:coverage');
    expect(workflow).toContain(
      'pnpm --filter @openzcad/web test:full --coverage'
    );
    expect(workflow).toContain('pnpm test:e2e:full');
    expect(workflow).toContain('scripts/e2e-shards.mjs --suite full');
    expect(workflow).toContain('needs: [unit, web, browser]');
    expect(workflow).toContain('QUALIFICATION_RESULTS: ${{ toJSON(needs) }}');
    expect(workflow).not.toMatch(
      /continue-on-error|contents: write|id-token: write|secrets\./
    );
  });

  it('grants issue writes only to a tracking job that runs for scheduled main', () => {
    const workflow = readFileSync(
      '.github/workflows/daily-validation.yml',
      'utf8'
    );
    const jobs = workflowJobs(workflow);
    expect(workflow.split('\njobs:\n')[0]).toContain(
      'permissions:\n  contents: read\n'
    );
    for (const [name, job] of Object.entries(jobs))
      expect(job.includes('issues: write'), name).toBe(name === 'track');
    expect(workflow.match(/issues: write/g)).toHaveLength(1);
    const track = jobs.track!;
    expect(track).toContain(
      "if: always() && github.event_name == 'schedule' && github.ref == 'refs/heads/main' && needs.report.result != 'skipped'"
    );
    expect(track).toContain(
      'permissions:\n      contents: read\n      issues: write\n    steps:'
    );
    expect(track).toContain('needs: [report]');
    expect(track).toContain('persist-credentials: false');
    expect(track).toContain(
      'node scripts/ci-qualification-issue.mjs qualification-receipt.json'
    );
    // The report job keeps read-only credentials and always writes a receipt.
    expect(jobs.report).toContain(
      'permissions:\n      contents: read\n      actions: read\n    steps:'
    );
    expect(jobs.report).toContain(
      '- name: Record verdict and last green main qualification\n        # A failed report download leaves files unnamed, never the verdict unwritten.\n        if: always()'
    );
    for (const name of ['root', 'web', 'browser-${{ matrix.shard }}'])
      expect(workflow).toContain(`name: qualification-report-${name}\n`);
    for (const action of workflow.matchAll(/uses: ([^\s@]+)@(\S+)/g))
      expect(action[2], action[1]).toMatch(/^[0-9a-f]{40}$/);
  });

  it('does not resolve runtime-only runner expressions in job environments', () => {
    const workflow = readFileSync('.github/workflows/fleet-ci-v7.yml', 'utf8');
    // GitHub resolves a job's env before a runner exists. Step env and
    // action inputs can use runner paths, but job env cannot.
    const environments = [
      ...workflow.matchAll(/^ {4}env:\n((?: {6,}[^\n]*\n)+)/gm)
    ];
    expect(environments.length).toBeGreaterThan(0);
    for (const environment of environments)
      expect(environment[1]).not.toMatch(/\$\{\{[^}]*\brunner(?:\.|\[)/);
  });

  it('stages sharded affected tests and requires real browser coverage of combined queue trees', () => {
    const staged = readFileSync('.github/workflows/fleet-ci-v7.yml', 'utf8');
    expect(staged).toContain(
      'node scripts/run-ci-units.mjs root --shard=${{ matrix.shard }}/2'
    );
    expect(staged).toContain('node scripts/run-ci-units.mjs web');
    expect(staged).toContain('pnpm test:parity-corpus');
    expect(staged).toContain('test "$TYPECHECK_RESULT" = success');
    expect(staged).toContain(
      'pnpm test:e2e test/e2e/save-state-history.spec.ts test/e2e/feature-history.spec.ts'
    );
    expect(staged).toContain('merge_group/skipped/skipped/success)');
    expect(staged).not.toContain(
      'Queue candidate: e2e passed on the pull request head'
    );
    expect(staged).toContain('QUEUE_RESULT: ${{ needs.e2e-queue.result }}');
  });
});

describe('qualification failure tracking', () => {
  const root = '/work/OpenZCAD';
  const meta = { server: 'https://github.com', repository: 'owner/repo' };
  const failed = qualificationReceipt(
    {
      unit: { result: 'failure' },
      web: { result: 'success' },
      browser: { result: 'failure' }
    },
    { source: 'c'.repeat(40), run: '99' },
    { head_sha: 'b'.repeat(40), html_url: 'https://example.invalid/run/1' },
    {
      unit: ['test/kernel-ledger.test.ts'],
      web: [],
      browser: [
        'test/e2e/gear.spec.ts',
        '(no browser shard 3 report: the job ended before writing it)'
      ]
    }
  );

  it('names failing Vitest files relative to the repository, including run-level failures', () => {
    expect(
      vitestFailures(
        {
          success: false,
          testResults: [
            { name: `${root}/apps/web/src/b.test.ts`, status: 'failed' },
            { name: `${root}/apps/web/src/a.test.ts`, status: 'failed' },
            { name: `${root}/apps/web/src/c.test.ts`, status: 'passed' }
          ]
        },
        root
      )
    ).toEqual(['apps/web/src/a.test.ts', 'apps/web/src/b.test.ts']);
    expect(
      vitestFailures(
        {
          success: false,
          testResults: [{ name: `${root}/x.test.ts`, status: 'passed' }]
        },
        root
      )
    ).toEqual(['(run failed outside any test file; see the job log)']);
    expect(vitestFailures({ success: true, testResults: [] }, root)).toEqual(
      []
    );
  });

  it('names failing Playwright spec files in nested suites and run errors', () => {
    expect(
      playwrightFailures(
        {
          config: { rootDir: `${root}/test/e2e` },
          suites: [
            {
              file: 'gear.spec.ts',
              specs: [{ ok: true, file: 'gear.spec.ts' }],
              suites: [{ specs: [{ ok: false, file: 'gear.spec.ts' }] }]
            },
            {
              file: 'save.spec.ts',
              specs: [{ ok: true, file: 'save.spec.ts' }]
            }
          ],
          errors: [{ message: '\nError: webServer exited early\n    at x' }]
        },
        root
      )
    ).toEqual([
      'test/e2e/gear.spec.ts',
      '(run error: Error: webServer exited early)'
    ]);
  });

  it('reports a missing or unreadable report instead of treating it as green', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qualification-reports-'));
    try {
      mkdirSync(join(directory, 'qualification-report-root'));
      writeFileSync(
        join(directory, 'qualification-report-root', 'qualification-root.json'),
        JSON.stringify({
          success: false,
          testResults: [{ name: `${root}/test/a.test.ts`, status: 'failed' }]
        })
      );
      mkdirSync(join(directory, 'qualification-report-web'));
      writeFileSync(
        join(directory, 'qualification-report-web', 'qualification-web.json'),
        '{'
      );
      const failures = collectFailures(directory, root);
      expect(failures.unit).toEqual(['test/a.test.ts']);
      expect(failures.web).toEqual(['(unreadable web report)']);
      expect(failures.browser).toHaveLength(6);
      expect(failures.browser[0]).toBe(
        '(no browser shard 1 report: the job ended before writing it)'
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('opens one issue naming the source SHA and failing files, then updates and closes it', () => {
    const created = trackingPlan(failed, null, meta);
    expect(created.action).toBe('create');
    if (created.action !== 'create') return;
    expect(created.body.startsWith(TRACKING_MARKER)).toBe(true);
    expect(created.body).toContain(`\`${'c'.repeat(40)}\``);
    expect(created.body).toContain(
      'https://github.com/owner/repo/actions/runs/99'
    );
    expect(created.body).toContain(
      '- **unit**: failure\n  - `test/kernel-ledger.test.ts`'
    );
    expect(created.body).toContain('  - `test/e2e/gear.spec.ts`');
    expect(created.body).not.toContain('**web**');
    expect(created.body).toContain(`\`${'b'.repeat(40)}\``);

    const open = {
      number: 7,
      user: { login: 'github-actions[bot]' },
      body: created.body
    };
    const updated = trackingPlan(failed, open, meta);
    expect(updated).toMatchObject({ action: 'update', body: created.body });
    if (updated.action === 'update')
      expect(updated.comment).toContain('unit, browser');

    const green = qualificationReceipt(
      {
        unit: { result: 'success' },
        web: { result: 'success' },
        browser: { result: 'success' }
      },
      { source: 'd'.repeat(40), run: '100' }
    );
    expect(trackingPlan(green, open, meta).action).toBe('close');
    expect(trackingPlan(green, null, meta).action).toBe('none');
  });

  it('only adopts the open issue this workflow created and keeps quoted text inert', () => {
    const marked = { body: `${TRACKING_MARKER}\n...` };
    expect(
      findTrackingIssue([
        { number: 1, user: { login: 'someone' }, ...marked },
        { number: 2, user: { login: 'github-actions[bot]' }, body: 'other' },
        {
          number: 3,
          user: { login: 'github-actions[bot]' },
          pull_request: {},
          ...marked
        },
        { number: 4, user: { login: 'github-actions[bot]' }, ...marked }
      ])?.number
    ).toBe(4);
    expect(findTrackingIssue([])).toBeNull();
    const hostile = {
      ...failed,
      failures: { unit: ['a`@owner #1`.test.ts'], web: [], browser: [] }
    };
    expect(issueBody(hostile, meta)).toContain("- `a'@owner #1'.test.ts`");
    expect(issueBody({ ...failed, failures: null }, meta)).toContain(
      'failing files unavailable; see the run'
    );
  });
});
