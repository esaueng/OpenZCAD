import { describe, expect, it, vi } from 'vitest';
import { COMMAND_CARD_CHUNKS, prefetchWhenIdle } from './cardChunkPrefetch';

/** A host whose idle slots run only when the test says so. */
function idleHost() {
  const queue = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    pending: () => queue.size,
    runIdle() {
      const tasks = [...queue.values()];
      queue.clear();
      for (const task of tasks) task();
    },
    requestIdleCallback(callback: () => void) {
      const handle = nextHandle++;
      queue.set(handle, callback);
      return handle;
    },
    cancelIdleCallback(handle: number) {
      queue.delete(handle);
    },
    setTimeout: vi.fn(() => 0),
    clearTimeout: vi.fn()
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('command card prefetch (G16)', () => {
  it('fetches nothing until the main thread is idle, then one chunk per slot', async () => {
    const host = idleHost();
    const loads = [vi.fn(async () => {}), vi.fn(async () => {})];
    prefetchWhenIdle(loads, host);
    expect(loads[0]).not.toHaveBeenCalled();

    host.runIdle();
    expect(loads[0]).toHaveBeenCalledOnce();
    expect(loads[1]).not.toHaveBeenCalled();
    await settle();
    host.runIdle();
    expect(loads[1]).toHaveBeenCalledOnce();
    await settle();
    expect(host.pending()).toBe(0);
  });

  it('carries on past a chunk that failed to load', async () => {
    const host = idleHost();
    const loads = [
      vi.fn(() => Promise.reject(new Error('offline'))),
      vi.fn(async () => {})
    ];
    prefetchWhenIdle(loads, host);
    host.runIdle();
    await settle();
    host.runIdle();
    expect(loads[1]).toHaveBeenCalledOnce();
  });

  it('stops when the workspace closes first', async () => {
    const host = idleHost();
    const loads = [vi.fn(async () => {}), vi.fn(async () => {})];
    const cancel = prefetchWhenIdle(loads, host);
    host.runIdle();
    cancel();
    await settle();
    host.runIdle();
    expect(loads[1]).not.toHaveBeenCalled();
    expect(host.pending()).toBe(0);
  });

  it('falls back to a timer where there is no idle callback', () => {
    const setTimeout = vi.fn(() => 7);
    const clearTimeout = vi.fn();
    const cancel = prefetchWhenIdle([vi.fn(async () => {})], {
      setTimeout,
      clearTimeout
    });
    expect(setTimeout).toHaveBeenCalledOnce();
    cancel();
    expect(clearTimeout).toHaveBeenCalledWith(7);
  });

  it('warms the cards a first tool opens', () => {
    // Box (the Inspector), the region Extrude card and the Move panel:
    // every lazily loaded command card.
    const sources = COMMAND_CARD_CHUNKS.map((load) => String(load));
    for (const module of [
      'components/Inspector',
      'components/ToolCard',
      'components/MoveOverlay'
    ]) {
      expect(sources.some((source) => source.includes(module))).toBe(true);
    }
  });
});
