import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { E2eeApi } from './e2eeApi';
import { reportDeviceUse } from './accountKeys';

/**
 * An unlocked device reports its use at most once per UTC day (ADR-024
 * amendment 2026-11-25): stamped in this browser's storage, the id in the
 * request body, and a failure retried on a later load.
 */

const send = vi.fn<(deviceId: string) => Promise<{ recorded: boolean }>>();
const ctx = (userId = 'user_report') => ({
  userId,
  api: { recordDeviceUse: send } as unknown as E2eeApi
});

beforeEach(() => {
  window.localStorage.clear();
  send.mockReset();
  send.mockResolvedValue({ recorded: true });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T08:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reporting device use', () => {
  it('sends once a day per device, and again the next day', async () => {
    await reportDeviceUse(ctx(), 'dev_a');
    await reportDeviceUse(ctx(), 'dev_a');
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('dev_a');
    await reportDeviceUse(ctx(), 'dev_b');
    expect(send).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date('2026-11-26T00:01:00Z'));
    await reportDeviceUse(ctx(), 'dev_a');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('sends one report for parallel loads', async () => {
    await Promise.all([
      reportDeviceUse(ctx(), 'dev_a'),
      reportDeviceUse(ctx(), 'dev_a'),
      reportDeviceUse(ctx(), 'dev_a')
    ]);
    expect(send).toHaveBeenCalledOnce();
  });

  it('retries after a failure, and never throws', async () => {
    send.mockRejectedValueOnce(new Error('offline'));
    await expect(reportDeviceUse(ctx(), 'dev_a')).resolves.toBeUndefined();
    await reportDeviceUse(ctx(), 'dev_a');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('still reports when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await expect(reportDeviceUse(ctx(), 'dev_a')).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it('does nothing with an API that cannot report', async () => {
    await reportDeviceUse(
      { userId: 'user_report', api: {} as E2eeApi },
      'dev_a'
    );
    expect(send).not.toHaveBeenCalled();
  });
});
