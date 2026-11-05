import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { qualificationReceipt } from '../scripts/ci-qualification-report.mjs';

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
