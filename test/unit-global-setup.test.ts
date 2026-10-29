import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import prepareUnitFixtures from './unit-global-setup';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
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
      'python3',
      ['scripts/prepare-fleet-test-fixtures.py'],
      expect.objectContaining({ timeout: 60_000, stdio: 'inherit' })
    );
  });
});
