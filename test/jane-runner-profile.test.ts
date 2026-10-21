import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLEET_CI_PATH } from './fleet-workflow';

const staged = readFileSync('.github/workflows/fleet-ci-v3.yml', 'utf8');
const guard = (text: string) => {
  const value = /case "\$RUNNER_NAME" in\n[\s\S]*?\besac/.exec(text)?.[0];
  if (!value) throw new Error('Missing trusted runner guard');
  return value;
};

describe('three-slot Jane runner profile', () => {
  it('checks the exact kernel page-aligned memory cap', () => {
    const align = staged
      .split('\n')
      .find((line) => line.trim().startsWith('CI_MEMORY=$(('));
    expect(align).toBeDefined();
    const result = spawnSync(
      'bash',
      [
        '-eu',
        '-c',
        `getconf() { printf '4096\\n'; }; ${guard(staged)}\n${align}\nprintf '%s' "$CI_MEMORY"`
      ],
      {
        env: { ...process.env, RUNNER_NAME: 'ci-server-jane-3' },
        encoding: 'utf8'
      }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('4999999488');
  });
  it('changes only the reviewed slot names, memory cap and page alignment', () => {
    // SHA-256 of fleet-ci.yml at fe46bdaa8a64c92464fea42034284be34c58ceae.
    // A committed digest also works in a cold, shallow CI checkout.
    const baseline = staged
      .replace(
        'ci-server-jane-1|ci-server-jane-2|ci-server-jane-3)',
        'ci-server-jane-1|ci-server-jane-2)'
      )
      .replace('CI_MEMORY=5000000000', 'CI_MEMORY=6442450944')
      .replace(
        '          CI_MEMORY=$((CI_MEMORY / $(getconf PAGESIZE) * $(getconf PAGESIZE)))\n',
        ''
      );
    expect(createHash('sha256').update(baseline).digest('hex')).toBe(
      '8ef9ecab920f42cc84c883e6c02aac4dffd48d0ed7637915bd1d55c73365a5de'
    );
  });

  it.each([1, 2, 3])('uses the isolated 5 GB profile for slot %i', (slot) => {
    const result = spawnSync(
      'bash',
      [
        '-eu',
        '-c',
        `${guard(staged)}\nprintf '%s\\n' "$CI_USER $CI_STORAGE $CI_SLICE $CI_DOCKER $CI_MEMORY $CI_CPUS"`
      ],
      {
        env: { ...process.env, RUNNER_NAME: `ci-server-jane-${slot}` },
        encoding: 'utf8'
      }
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `ci-slot${slot} /srv/ci-slot${slot} cislot${slot}.slice ci-slot${slot}-docker 5000000000 6`
    );
  });

  it.each(['ci-server-jane-0', 'ci-server-jane-4', 'unknown'])(
    'rejects unprovisioned runner %s',
    (name) => {
      const result = spawnSync('bash', ['-eu', '-c', guard(staged)], {
        env: { ...process.env, RUNNER_NAME: name }
      });
      expect(result.status).not.toBe(0);
    }
  );

  it('keeps an activated workflow on the current resource contract', () => {
    if (FLEET_CI_PATH !== '.github/workflows/fleet-ci-v3.yml') return;
    const active = guard(readFileSync(FLEET_CI_PATH, 'utf8'));
    expect(active).toContain(
      'ci-server-jane-1|ci-server-jane-2|ci-server-jane-3)'
    );
    expect(active).toContain('CI_MEMORY=5000000000');
    expect(active).not.toContain('CI_MEMORY=6442450944');
  });
});
