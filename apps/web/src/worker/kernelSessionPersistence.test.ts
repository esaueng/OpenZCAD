import { createProjectDocument } from '@openzcad/document-core';
import type { PersistedHistorySession } from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KERNEL_SESSION_IDLE_MS,
  KERNEL_SESSION_LOAD_BUDGET_MS,
  KERNEL_SESSION_MIN_INTERVAL_MS,
  KERNEL_SESSION_WARMUP_IDLE_MS,
  KernelSessionPersistence,
  type KernelSessionPersistenceDeps
} from './kernelSessionPersistence';

const SESSION = { format: 1 } as unknown as PersistedHistorySession;

function harness(overrides: Partial<KernelSessionPersistenceDeps> = {}) {
  let serial = 0;
  const deps = {
    identity: vi.fn(() => 'identity'),
    load: vi.fn(async () => SESSION),
    save: vi.fn(async () => true),
    remove: vi.fn(async () => undefined),
    touch: vi.fn(async () => undefined),
    isSession: (value: unknown): value is PersistedHistorySession =>
      value === SESSION,
    estimateBytes: () => 10,
    workSerial: () => serial,
    yieldControl: () => () => undefined,
    now: () => Date.now(),
    setTimer: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimer: (timer: unknown) =>
      clearTimeout(timer as ReturnType<typeof setTimeout>),
    ...overrides
  } satisfies KernelSessionPersistenceDeps;
  const adapter = {
    hasHistoryFor: vi.fn(() => false),
    captureHistorySession: vi.fn(
      async () => SESSION as PersistedHistorySession | null
    ),
    needsHistoryWarmup: vi.fn(() => true),
    warmHistory: vi.fn(
      async (
        _document: ProjectDocument,
        _options?: { cancellation?: { isCancelled(): boolean } }
      ) => true
    )
  };
  return {
    deps,
    adapter,
    persistence: new KernelSessionPersistence(deps),
    work: () => {
      serial += 1;
    }
  };
}

let document: ProjectDocument;
beforeEach(() => {
  vi.useFakeTimers();
  document = createProjectDocument('Session', toUserId('user-1'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('offer', () => {
  it('offers the stored session only to a kernel without the project', async () => {
    const { persistence, adapter, deps } = harness();
    expect(await persistence.offer(adapter, document, 'key')).toBe(SESSION);
    expect(deps.load).toHaveBeenCalledWith(
      document.projectId,
      'key',
      'identity'
    );
    adapter.hasHistoryFor.mockReturnValue(true);
    expect(await persistence.offer(adapter, document, 'key')).toBeUndefined();
    expect(deps.load).toHaveBeenCalledTimes(1);
  });

  it('offers nothing for an unidentified build, a failed or invalid read', async () => {
    const unidentified = harness({ identity: () => null });
    expect(
      await unidentified.persistence.offer(unidentified.adapter, document, 'k')
    ).toBeUndefined();
    expect(unidentified.deps.load).not.toHaveBeenCalled();
    const failing = harness({
      load: async () => Promise.reject(new Error('x'))
    });
    expect(
      await failing.persistence.offer(failing.adapter, document, 'k')
    ).toBeUndefined();
    const invalid = harness({
      load: async () => ({}) as PersistedHistorySession
    });
    expect(
      await invalid.persistence.offer(invalid.adapter, document, 'k')
    ).toBeUndefined();
  });

  it('never holds a reopen behind a stalled read', async () => {
    const { persistence, adapter } = harness({
      load: () => new Promise<never>(() => undefined)
    });
    const offered = persistence.offer(adapter, document, 'k');
    await vi.advanceTimersByTimeAsync(KERNEL_SESSION_LOAD_BUDGET_MS);
    expect(await offered).toBeUndefined();
  });

  it('forgets a rejected session and refreshes a restored one', async () => {
    const { persistence, deps } = harness();
    persistence.noteOutcome(document.projectId, 'restored');
    expect(deps.touch).toHaveBeenCalledWith(document.projectId);
    persistence.noteOutcome(document.projectId, 'rejected');
    expect(deps.remove).toHaveBeenCalledWith(document.projectId);
  });
});

describe('capture', () => {
  it('waits for idle, then stores the captured session once', async () => {
    const { persistence, adapter, deps } = harness();
    persistence.schedule(adapter, document, 'key');
    await vi.advanceTimersByTimeAsync(KERNEL_SESSION_IDLE_MS - 1);
    expect(adapter.captureHistorySession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.captureHistorySession).toHaveBeenCalledWith(document);
    expect(deps.save).toHaveBeenCalledWith({
      projectId: document.projectId,
      contentKey: 'key',
      identity: 'identity',
      bytes: 10,
      session: SESSION
    });
    // The same content is not written again.
    persistence.schedule(adapter, document, 'key');
    await vi.advanceTimersByTimeAsync(KERNEL_SESSION_MIN_INTERVAL_MS * 2);
    expect(deps.save).toHaveBeenCalledTimes(1);
  });

  it('yields to new work and throttles writes per project', async () => {
    const { persistence, adapter, deps, work } = harness();
    persistence.schedule(adapter, document, 'key-1');
    await vi.advanceTimersByTimeAsync(KERNEL_SESSION_IDLE_MS - 1);
    work();
    await vi.advanceTimersByTimeAsync(KERNEL_SESSION_IDLE_MS);
    expect(adapter.captureHistorySession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KERNEL_SESSION_IDLE_MS);
    expect(deps.save).toHaveBeenCalledTimes(1);

    // Idle again, but the last write was moments ago.
    persistence.schedule(adapter, document, 'key-2');
    await vi.advanceTimersByTimeAsync(KERNEL_SESSION_IDLE_MS * 2);
    expect(deps.save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(KERNEL_SESSION_MIN_INTERVAL_MS);
    expect(deps.save).toHaveBeenCalledTimes(2);
  });

  it('stores nothing the adapter does not vouch for', async () => {
    const { persistence, adapter, deps } = harness();
    adapter.captureHistorySession.mockResolvedValue(null);
    persistence.schedule(adapter, document, 'key');
    await vi.advanceTimersByTimeAsync(KERNEL_SESSION_IDLE_MS);
    expect(deps.save).not.toHaveBeenCalled();
  });
});

describe('warm-up', () => {
  it('rebuilds a restored kernel once idle, and retries when cancelled', async () => {
    const { persistence, adapter, work } = harness();
    adapter.warmHistory.mockImplementationOnce(async (_document, options) => {
      work();
      return !options?.cancellation?.isCancelled();
    });
    persistence.scheduleWarmup(adapter, document, []);
    await vi.advanceTimersByTimeAsync(KERNEL_SESSION_WARMUP_IDLE_MS);
    expect(adapter.warmHistory).toHaveBeenCalledTimes(1);
    expect(adapter.warmHistory.mock.calls[0]![1]).toMatchObject({
      lineageDemand: []
    });
    await vi.advanceTimersByTimeAsync(KERNEL_SESSION_WARMUP_IDLE_MS);
    expect(adapter.warmHistory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(KERNEL_SESSION_WARMUP_IDLE_MS * 3);
    expect(adapter.warmHistory).toHaveBeenCalledTimes(2);
  });

  it('does nothing for a kernel that needs no warm-up', async () => {
    const { persistence, adapter } = harness();
    adapter.needsHistoryWarmup.mockReturnValue(false);
    persistence.scheduleWarmup(adapter, document, undefined);
    await vi.advanceTimersByTimeAsync(KERNEL_SESSION_WARMUP_IDLE_MS * 2);
    expect(adapter.warmHistory).not.toHaveBeenCalled();
  });
});
