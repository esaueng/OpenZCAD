import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/trusted-pr.yml', 'utf8');

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

const trustedEvent = {
  EVENT_NAME: 'pull_request',
  REPOSITORY: 'esaueng/OpenZCAD',
  HEAD_REPOSITORY: 'esaueng/OpenZCAD',
  PR_AUTHOR: 'petergstfsn',
  ACTOR: 'petergstfsn',
  TRIGGERING_ACTOR: 'petergstfsn',
  REF: 'refs/pull/123/merge'
};

function route(overrides: Partial<typeof trustedEvent>): string {
  const directory = mkdtempSync(join(tmpdir(), 'trusted-pr-policy-'));
  try {
    const output = join(directory, 'output');
    const result = spawnSync(
      'bash',
      ['-e', '-c', stepScript('Select trusted PRs')],
      {
        env: {
          ...process.env,
          ...trustedEvent,
          ...overrides,
          GITHUB_OUTPUT: output
        }
      }
    );
    expect(result.status, result.stderr.toString()).toBe(0);
    return readFileSync(output, 'utf8').trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('immutable trusted PR policy', () => {
  it("routes the owner's same-repository PR to the VPS", () => {
    expect(route({})).toBe('trusted=true');
  });

  it.each([
    { HEAD_REPOSITORY: 'petergstfsn/OpenZCAD' },
    { HEAD_REPOSITORY: '' },
    { PR_AUTHOR: 'outside-contributor' },
    { ACTOR: 'outside-contributor' },
    { TRIGGERING_ACTOR: 'outside-contributor' },
    { ACTOR: 'dependabot[bot]' },
    { EVENT_NAME: 'pull_request_target' },
    { EVENT_NAME: 'workflow_dispatch' },
    { EVENT_NAME: 'push' },
    { REF: 'refs/heads/main' },
    { REF: 'refs/pull/123/head' },
    { REPOSITORY: 'esaueng/Other', HEAD_REPOSITORY: 'esaueng/Other' }
  ])('keeps untrusted or non-PR contexts hosted: %j', (event) => {
    expect(route(event)).toBe('trusted=false');
  });

  it('keeps routing ahead of checkout and disallows caller overrides and secrets', () => {
    expect(workflow.indexOf('Select trusted PRs')).toBeLessThan(
      workflow.indexOf('actions/checkout@')
    );
    expect(workflow).toContain('group: ci-trusted-main');
    expect(workflow).toContain('labels: ci-small');
    expect(workflow).toContain("if: needs.select.outputs.trusted == 'true'");
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).not.toMatch(
      /inputs:|secrets:|secrets\.|pull_request_target:|workflow_dispatch:|\bref:|\brepository:/
    );
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(workflow).toContain('corepack pnpm install --frozen-lockfile');
  });

  it.each([
    ['true', 'success', 'skipped', 0],
    ['false', 'skipped', 'success', 0],
    ['true', 'failure', 'skipped', 1],
    ['true', 'cancelled', 'skipped', 1],
    ['true', 'skipped', 'skipped', 1],
    ['false', 'skipped', 'failure', 1],
    ['false', 'skipped', 'cancelled', 1],
    ['false', 'skipped', 'skipped', 1],
    ['', 'skipped', 'skipped', 1],
    ['true', 'success', 'success', 1]
  ])(
    'fails closed for route %s, VPS %s, hosted %s',
    (trusted, vps, hosted, status) => {
      const result = spawnSync(
        'bash',
        ['-e', '-c', stepScript('Require the selected checks to succeed')],
        {
          env: {
            ...process.env,
            SELECT_RESULT: 'success',
            TRUSTED: String(trusted),
            VPS_RESULT: String(vps),
            HOSTED_RESULT: String(hosted)
          }
        }
      );
      expect(result.status).toBe(status);
    }
  );

  it('fails when routing failed even if a worker succeeded', () => {
    const result = spawnSync(
      'bash',
      ['-e', '-c', stepScript('Require the selected checks to succeed')],
      {
        env: {
          ...process.env,
          SELECT_RESULT: 'failure',
          TRUSTED: 'true',
          VPS_RESULT: 'success',
          HOSTED_RESULT: 'skipped'
        }
      }
    );
    expect(result.status).toBe(1);
  });
});

describe('required validation gate', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

  it('pins runner policy independently of PR edits and retains both dependencies', () => {
    expect(ci).toMatch(
      /uses: esaueng\/OpenZCAD\/\.github\/workflows\/trusted-pr\.yml@[0-9a-f]{40}\n/
    );
    expect(ci).not.toMatch(/secrets: inherit|runs-on:.*ci-small/);
    expect(ci).toContain('needs: [quality, validation]\n    if: always()');
  });

  it.each([
    ['success', 'success', 0],
    ['failure', 'success', 1],
    ['cancelled', 'success', 1],
    ['skipped', 'success', 1],
    ['success', 'failure', 1],
    ['success', 'cancelled', 1],
    ['success', 'skipped', 1]
  ])('requires quality %s and validation %s', (quality, validation, status) => {
    const result = spawnSync(
      'bash',
      ['-e', '-c', stepScript('Require all validation checks', ci)],
      {
        env: {
          ...process.env,
          QUALITY_RESULT: String(quality),
          VALIDATION_RESULT: String(validation)
        }
      }
    );
    expect(result.status).toBe(status);
  });
});
