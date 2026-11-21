import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PointPatternMeshWorker } from './point-pattern-mesh-worker';

const quality = { linearDeflection: 0.02, angularDeflection: 0.06 };
const mesh = {
  positions: new Float32Array(9),
  indices: new Uint32Array([0, 1, 2]),
  faceOffsets: new Uint32Array([0, 3])
};

function setup() {
  const worker = {
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    onmessageerror: undefined as (() => void) | undefined,
    postMessage: vi.fn(),
    terminate: vi.fn()
  };
  const stage = vi.fn();
  const create = vi.fn(() => worker as unknown as Worker);
  const helper = new PointPatternMeshWorker(stage, create);
  helper.warm();
  const start = (signal?: { isCancelled(): boolean }) =>
    helper.start(17, new Uint8Array([1]), quality, signal);
  return { helper, worker, stage, create, start };
}

describe('a point pattern mesh helper', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('uses an exact reply once for the same handle and deflections', async () => {
    const { helper, worker, stage, start } = setup();
    start();
    const ready = helper.wait([17]);
    worker.onmessage!({ data: { id: 1, mesh } });
    await ready;
    expect(stage).not.toHaveBeenCalled();
    expect(helper.take(99, quality)).toBeUndefined();
    expect(
      helper.take(17, { ...quality, linearDeflection: 0.04 })
    ).toBeUndefined();
    expect(stage).not.toHaveBeenCalled();
    expect(helper.take(17, quality)).toBe(mesh);
    expect(stage).toHaveBeenCalledExactlyOnceWith(mesh);
    expect(helper.take(17, quality)).toBeUndefined();
    vi.advanceTimersByTime(15_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('ignores stale replies after a rebuild reuses the same solid handle', async () => {
    const { helper, worker, stage, start } = setup();
    start();
    const prior = helper.wait([17]);
    helper.reset();
    await prior;
    start();
    worker.onmessage!({ data: { id: 1, mesh } });
    expect(stage).not.toHaveBeenCalled();
    expect(helper.take(17, quality)).toBeUndefined();
    worker.onmessage!({ data: { id: 2, mesh } });
    expect(helper.take(17, quality)).toBe(mesh);
  });
  it('releases the waiting rebuild on project disposal, a message error, or timeout', async () => {
    for (const reason of ['dispose', 'error', 'timeout']) {
      const { helper, worker, stage, start } = setup();
      start();
      const ready = helper.wait([17]);
      if (reason === 'dispose') helper.dispose();
      if (reason === 'error') worker.onmessageerror!();
      if (reason === 'timeout') vi.advanceTimersByTime(250);
      await ready;
      worker.onmessage!({ data: { id: 1, mesh } });
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(stage).not.toHaveBeenCalled();
      expect(helper.take(17, quality)).toBeUndefined();
    }
  });
  it('uses the live kernel for later edits while the helper is unavailable, then permits a retry', async () => {
    const { helper, create, start } = setup();
    start();
    const ready = helper.wait([17]);
    vi.advanceTimersByTime(250);
    await ready;
    helper.warm();
    expect(create).toHaveBeenCalledTimes(1);
    expect(helper.available).toBe(false);
    vi.advanceTimersByTime(15_000);
    helper.warm();
    expect(helper.available).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('discards a cancelled build even if the helper completes', async () => {
    const { helper, worker, stage, start } = setup();
    let cancelled = false;
    start({ isCancelled: () => cancelled });
    const ready = helper.wait([17]);
    cancelled = true;
    worker.onmessage!({ data: { id: 1, mesh } });
    await ready;
    expect(stage).not.toHaveBeenCalled();
    expect(helper.take(17, quality)).toBeUndefined();
  });
  it('declines oversized input and falls back on an oversized reply', async () => {
    const { helper, worker, stage, start } = setup();
    helper.start(17, new Uint8Array(384 * 1024 + 1), quality);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    start();
    const ready = helper.wait([17]);
    worker.onmessage!({
      data: { id: 1, mesh: { ...mesh, positions: new Float32Array(524289) } }
    });
    await ready;
    expect(stage).not.toHaveBeenCalled();
    expect(helper.wait([17])).toBeUndefined();
    expect(helper.take(17, quality)).toBeUndefined();
  });
});
