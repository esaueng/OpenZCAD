import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/fleet-ci.yml', 'utf8');

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
  it('retires the orphan OIDC workflow and exercises immutable fleet routing', () => {
    expect(existsSync('.github/workflows/trusted-pr.yml')).toBe(false);
    const result = spawnSync('python3', ['scripts/test-direct-fleet.py'], {
      encoding: 'utf8'
    });
    expect(result.status, result.stderr).toBe(0);
  });
  const caller = readFileSync('.github/workflows/ci.yml', 'utf8');
  const ci = readFileSync('.github/workflows/fleet-ci.yml', 'utf8');

  it('keeps the immutable runner policy identical to the reviewed source', () => {
    const pin = caller.match(/fleet-ci\.yml@([0-9a-f]{40})/)?.[1];
    expect(pin).toBeDefined();
    const pinned = execFileSync('git', ['show', `${pin}:.github/workflows/fleet-ci.yml`], {encoding:'utf8'});
    expect(pinned, 'Re-pin ci.yml after changing fleet-ci.yml.').toBe(ci);
  });

  it('pins runner policy independently of PR edits and retains both dependencies', () => {
    expect(caller).toMatch(
      /uses: esaueng\/OpenZCAD\/\.github\/workflows\/fleet-ci\.yml@[0-9a-f]{40}\n/
    );
    expect(caller).not.toMatch(/secrets: inherit|runs-on:/);
    expect(ci).toContain(
      'needs: [quality, unit, validation]\n    if: always()'
    );
  });

  it.each([
    ['success', 'success', 'success', 0],
    ['failure', 'success', 'success', 1],
    ['cancelled', 'success', 'success', 1],
    ['skipped', 'success', 'success', 1],
    ['success', 'failure', 'success', 1],
    ['success', 'cancelled', 'success', 1],
    ['success', 'skipped', 'success', 1],
    ['success', 'success', 'failure', 1],
    ['success', 'success', 'cancelled', 1],
    ['success', 'success', 'skipped', 1]
  ])(
    'requires quality %s, unit %s and validation %s',
    (quality, unit, validation, status) => {
      const result = spawnSync(
        'bash',
        ['-e', '-c', stepScript('Require all validation checks', ci)],
        {
          env: {
            ...process.env,
            QUALITY_RESULT: String(quality),
            UNIT_RESULT: String(unit),
            VALIDATION_RESULT: String(validation)
          }
        }
      );
      expect(result.status).toBe(status);
    }
  );

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
    expect(unit).toContain('- run: pnpm exec vitest run\n');
    expect(validation).toContain('- run: pnpm test:web\n');
    expect(validation).toContain('- run: pnpm test:parity-corpus\n');
    expect(validation).toContain('run: pnpm build\n');
  });
});
