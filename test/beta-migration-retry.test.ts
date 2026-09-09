import { describe, expect, it, vi } from 'vitest';
import { applyBetaMigrations } from '../scripts/apply-beta-migrations.mjs';

const timeout = {
  status: 1,
  output:
    'D1 DB storage operation exceeded timeout which caused object to be reset. [code: 7429]'
};

describe('beta migration retry', () => {
  it('recovers from the logged D1 timeout with bounded exponential backoff', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce(timeout)
      .mockReturnValueOnce(timeout)
      .mockReturnValue({ status: 0, output: 'No migrations to apply' });
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(
      await applyBetaMigrations({
        run,
        sleep,
        random: () => 0.5,
        warn: vi.fn()
      })
    ).toBe(0);
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2500], [4500]]);
  });

  it('returns failure after three timeouts so deployment cannot proceed', async () => {
    const run = vi.fn().mockReturnValue(timeout);
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await applyBetaMigrations({ run, sleep, warn: vi.fn() })).toBe(1);
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 0, output: 'Applied' },
    { status: 1, output: 'SQLITE_ERROR: no such table' },
    { status: 1, output: 'Authentication error [code: 10000]' },
    { status: 2, output: '[code: 7429]' },
    { ...timeout, interrupted: true }
  ])(
    'does not retry success, other failures, or interrupted processes: %j',
    async (result) => {
      const run = vi.fn().mockReturnValue(result);
      const sleep = vi.fn();
      expect(await applyBetaMigrations({ run, sleep, warn: vi.fn() })).toBe(
        result.status
      );
      expect(run).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  );
});
