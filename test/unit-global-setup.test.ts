import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import prepareUnitFixtures from './unit-global-setup';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('./support/testTools', () => ({
  pythonExecutable: () => 'fixture-python',
  pythonEnvironment: () => ({ ...process.env, PYTHONUTF8: '1' })
}));

const originalArgv = process.argv;
beforeEach(() => {
  process.argv = ['node', 'vitest', 'run', 'test/unrelated.test.ts'];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  process.argv = originalArgv;
});

describe('pre-worker Git fixture acquisition', () => {
  it('does no network acquisition for ordinary local runs', () => {
    vi.stubEnv('CI', '');
    prepareUnitFixtures();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('fails CI when acquiring the immutable evidence fails', () => {
    vi.stubEnv('CI', 'true');
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('fixture fetch refused');
    });
    expect(() => prepareUnitFixtures()).toThrow('fixture fetch refused');
  });

  it('bounds the acquisition separately from the unchanged policy hook deadline', () => {
    vi.stubEnv('CI', 'true');
    prepareUnitFixtures();
    expect(execFileSync).toHaveBeenCalledWith(
      'fixture-python',
      ['scripts/prepare-fleet-test-fixtures.py'],
      expect.objectContaining({ timeout: 60_000, stdio: 'inherit' })
    );
  });

  it.each([[], ['test/fleet-checkout-fixtures.test.ts']])(
    'prepares selected disposable history before workers and cleans only its owned directory (%j)',
    (...files) => {
      vi.stubEnv('CI', '');
      vi.stubEnv('OPENZCAD_UNIT_SUITE', 'full');
      vi.stubEnv('OPENZCAD_FLEET_CHECKOUT_HISTORY', 'caller-owned-history');
      process.argv = ['node', 'vitest', 'run', ...files];
      const cleanup = prepareUnitFixtures();
      const history = process.env.OPENZCAD_FLEET_CHECKOUT_HISTORY!;
      try {
        expect(execFileSync).toHaveBeenCalledWith(
          'fixture-python',
          ['scripts/test-fleet-checkout-fixtures.py', '--prepare', history],
          expect.objectContaining({ timeout: 60_000, stdio: 'inherit' })
        );
        expect(history).not.toBe('caller-owned-history');
        expect(existsSync(history)).toBe(true);
      } finally {
        cleanup!();
      }
      expect(existsSync(history)).toBe(false);
      expect(process.env.OPENZCAD_FLEET_CHECKOUT_HISTORY).toBe(
        'caller-owned-history'
      );
    }
  );

  it('does not construct checkout histories when CI smoke is filtered to another file', () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('OPENZCAD_UNIT_SUITE', 'smoke');
    process.argv = ['node', 'vitest', 'run', 'test/unrelated.test.ts'];
    prepareUnitFixtures();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
