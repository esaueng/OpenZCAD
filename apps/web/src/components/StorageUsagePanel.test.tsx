import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AccountStorageUsage } from '@openzcad/shared';
import { useAccountStorageUsage } from './StorageUsagePanel';
import { formatUsedBytes } from '../lib/storageUsage';

const MB = 1024 * 1024;
const GB = 1024 * MB;

function report(storageBytes: number): AccountStorageUsage {
  return {
    projectCount: 1,
    documentBytes: 0,
    revisionBytes: 0,
    revisionCount: 0,
    projectStorageBytes: storageBytes,
    storageBytes,
    storageLimitBytes: GB,
    documentLimitBytes: 16 * MB,
    maxRevisionsPerProject: 50,
    artifactBytes: 0,
    artifactCount: 0,
    artifactLimitBytes: GB
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Props whose key may later turn null, as it does while a save runs. */
function keyProps(refreshKey: string | null): { refreshKey: string | null } {
  return { refreshKey };
}

describe('useAccountStorageUsage', () => {
  it('still retries on request while a save run holds the automatic asks', async () => {
    // PR review: with the key null the first ask set the last key, and Retry
    // bumped a counter the guard then ignored, so the panel stayed failed.
    const load = vi
      .fn<() => Promise<AccountStorageUsage>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(report(42 * MB));
    const { result } = renderHook(() =>
      useAccountStorageUsage(load, 'user-1', null)
    );
    await waitFor(() => expect(result.current.state).toBe('failed'));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.usage?.storageBytes).toBe(42 * MB);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('lets an answer in flight land when a save run starts', async () => {
    // PR review: the key turning null ran the effect's cleanup, which threw
    // the pending answer away and left the panel loading for the whole run.
    const pending = deferred<AccountStorageUsage>();
    const load = vi.fn(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ refreshKey }: { refreshKey: string | null }) =>
        useAccountStorageUsage(load, 'user-1', refreshKey),
      { initialProps: keyProps('1') }
    );
    expect(result.current.state).toBe('loading');

    rerender({ refreshKey: null });
    await act(async () => pending.resolve(report(7 * MB)));
    expect(result.current.state).toBe('ready');
    expect(result.current.usage?.storageBytes).toBe(7 * MB);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('asks again only when the key changes, and not for an unchanged one', async () => {
    const load = vi.fn().mockResolvedValue(report(MB));
    const { rerender } = renderHook(
      ({ refreshKey }: { refreshKey: string | null }) =>
        useAccountStorageUsage(load, 'user-1', refreshKey),
      { initialProps: keyProps('a') }
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    rerender({ refreshKey: 'a' });
    rerender({ refreshKey: null });
    rerender({ refreshKey: 'b' });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('never shows one account the answer meant for another', async () => {
    const first = deferred<AccountStorageUsage>();
    const load = vi
      .fn<() => Promise<AccountStorageUsage>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(report(2 * MB));
    const { result, rerender } = renderHook(
      ({ account }: { account: string }) =>
        useAccountStorageUsage(load, account, 'k'),
      { initialProps: { account: 'user-1' } }
    );
    rerender({ account: 'user-2' });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    await act(async () => first.resolve(report(900 * MB)));
    expect(result.current.usage?.storageBytes).toBe(2 * MB);
  });
});

describe('formatUsedBytes', () => {
  it('keeps one decimal place where it already tells the figures apart', () => {
    expect(formatUsedBytes(42 * MB, GB)).toBe('42 MB');
    expect(formatUsedBytes(GB, GB)).toBe('1 GB');
  });

  it('adds the places an overage needs to differ from the allowance', () => {
    // "1 GB of 1 GB" sat beside "101%".
    expect(formatUsedBytes(1034 * MB, GB)).toBe('1.01 GB');
    // 20 KB short rounds up to "1 GB" at one place: still short, so it says so.
    expect(formatUsedBytes(GB - 20 * 1024, GB)).toBe('1,023.98 MB');
  });
});
