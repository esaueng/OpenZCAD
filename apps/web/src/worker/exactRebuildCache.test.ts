import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toRevisionId, toUserId } from '@openzcad/shared';
import {
  ExactRebuildCache,
  LatestBroadcastGate,
  canonicalProjectContentKey
} from './exactRebuildCache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('canonical exact rebuild keys', () => {
  it('ignores derived output and object insertion order', () => {
    const document = createProjectDocument('Cache key', toUserId('user'));
    const reordered = {
      ...Object.fromEntries(Object.entries(document).reverse()),
      derived: {
        ...document.derived,
        warnings: ['stale projection'],
        updatedAt: '2099-01-01T00:00:00.000Z'
      }
    } as typeof document;

    expect(canonicalProjectContentKey(reordered)).toBe(
      canonicalProjectContentKey(document)
    );
    expect(
      canonicalProjectContentKey({ ...document, name: 'Changed content' })
    ).not.toBe(canonicalProjectContentKey(document));
  });

  it('ignores version, revisions, commandLog, and checkpoints so undo/redo hit the cache', () => {
    const document = createProjectDocument('Cache key', toUserId('user'));
    // Undo restores earlier content under a NEW version with extra log and
    // revision entries. The rebuild replays only canonical content, so those
    // bookkeeping fields must not invalidate the cached exact result.
    const afterUndo: typeof document = {
      ...document,
      version: document.version + 3,
      revisions: [
        ...document.revisions,
        {
          revisionId: toRevisionId('rev-undo'),
          createdAt: '2099-01-01T00:00:00.000Z',
          reason: 'undo',
          commandCount: 3
        }
      ],
      commandLog: [
        ...document.commandLog,
        {
          kind: 'noop',
          payload: {},
          replayVersion: 1,
          label: 'noop',
          timestamp: '2099-01-01T00:00:00.000Z'
        }
      ],
      checkpoints: [...document.checkpoints]
    };

    expect(canonicalProjectContentKey(afterUndo)).toBe(
      canonicalProjectContentKey(document)
    );
  });
});

describe('bounded exact rebuild cache', () => {
  it('executes identical concurrent requests once and clones every result', async () => {
    const pending = deferred<{ values: number[] }>();
    const load = vi.fn(() => pending.promise);
    const cache = new ExactRebuildCache<{ values: number[] }>({
      maxEntries: 2,
      maxBytes: 1024,
      maxInFlight: 2
    });

    const left = cache.get('same', load);
    const right = cache.get('same', load);
    expect(load).toHaveBeenCalledOnce();
    expect(cache.inFlightCount).toBe(1);
    pending.resolve({ values: [1] });

    const [leftResult, rightResult] = await Promise.all([left, right]);
    leftResult.values.push(2);
    expect(rightResult.values).toEqual([1]);
    const cached = await cache.get('same', load);
    expect(cached.values).toEqual([1]);
    expect(cached).not.toBe(rightResult);
    expect(load).toHaveBeenCalledOnce();
  });

  it('evicts least-recently-used results within entry and byte limits', async () => {
    const loads = new Map<string, number>();
    const cache = new ExactRebuildCache<{ value: string }>({
      maxEntries: 2,
      maxBytes: 80,
      maxInFlight: 1,
      sizeOf: () => 20
    });
    const get = (key: string) =>
      cache.get(key, async () => {
        loads.set(key, (loads.get(key) ?? 0) + 1);
        return { value: key };
      });

    await get('a');
    await get('b');
    await get('a');
    await get('c');
    expect(cache.entryCount).toBe(2);
    expect(cache.bytes).toBeLessThanOrEqual(80);
    await get('b');
    expect(loads.get('a')).toBe(1);
    expect(loads.get('b')).toBe(2);
  });

  it('bounds in-flight work and rejects callers on termination', async () => {
    const first = deferred<number>();
    const overflowLoad = vi.fn(async () => 2);
    const cache = new ExactRebuildCache<number>({
      maxEntries: 1,
      maxBytes: 64,
      maxInFlight: 1
    });
    const left = cache.get('left', () => first.promise);
    expect(cache.inFlightCount).toBe(1);
    await expect(cache.get('right', overflowLoad)).rejects.toThrow(
      'in-flight limit'
    );
    expect(overflowLoad).not.toHaveBeenCalled();

    cache.terminate(new Error('Worker closed.'));
    await expect(left).rejects.toThrow('Worker closed');
    await expect(cache.get('later', async () => 3)).rejects.toThrow(
      'Worker closed'
    );
    first.resolve(1);
  });
});

describe('newest broadcast publication', () => {
  it('suppresses a running result after a newer broadcast is issued', () => {
    const gate = new LatestBroadcastGate();
    const running = gate.issue(true);
    expect(gate.isCurrent(running)).toBe(true);
    const newest = gate.issue(true);
    expect(gate.isCurrent(running)).toBe(false);
    expect(gate.isCurrent(newest)).toBe(true);
    expect(gate.isCurrent(gate.issue(false))).toBe(true);
  });
});
