import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as kernelCode from './pattern-kernel-module';
import {
  PatternOverlapWorkers,
  type PatternOverlapRequest
} from './pattern-overlap-workers';

class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  readonly requests: PatternOverlapRequest[] = [];
  readonly terminate = vi.fn();
  constructor() {
    super();
    TestWorker.instances.push(this);
  }
  postMessage(request: PatternOverlapRequest) {
    this.requests.push(request);
  }
  reply(volumes: (number | null)[] | null) {
    this.dispatchEvent(new MessageEvent('message', { data: { volumes } }));
  }
}

describe('pattern overlap workers', () => {
  let pool: PatternOverlapWorkers;
  const pairs = [4, 7, 9, 3, 6, 1].map((byte) => Uint8Array.of(byte));
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', TestWorker);
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    TestWorker.instances = [];
    pool = new PatternOverlapWorkers();
  });
  afterEach(() => {
    pool.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function ready() {
    pool.warm();
    const workers = TestWorker.instances.slice(-4);
    expect(workers).toHaveLength(4);
    expect(pool.measure(pairs)).toBeUndefined();
    for (const worker of workers) worker.reply([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.available).toBe(true);
    return workers;
  }
  it('sends compiled code only at startup and retries when cloning fails', async () => {
    const module = new WebAssembly.Module(
      Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)
    );
    const code = vi
      .spyOn(kernelCode, 'patternKernelModule')
      .mockReturnValue(module);
    const post = TestWorker.prototype.postMessage;
    const send = vi
      .spyOn(TestWorker.prototype, 'postMessage')
      .mockImplementation(function (this: TestWorker, request) {
        if (request.module && this === TestWorker.instances[0])
          throw new DOMException('Cannot clone module', 'DataCloneError');
        post.call(this, request);
      });
    try {
      const workers = await ready();
      expect(workers[0]!.requests[0]).toEqual({ pairs: [] });
      expect(
        workers.slice(1).every((w) => w.requests[0]?.module === module)
      ).toBe(true);
      const job = pool.measure(pairs.slice(0, 2));
      expect(workers.slice(2).map((worker) => worker.requests.length)).toEqual([
        1, 1
      ]);
      for (const worker of workers.slice(0, 2)) {
        const work = worker.requests[1]!;
        expect(work.module).toBeUndefined();
        worker.reply(work.pairs.map((bytes) => bytes[0]!));
      }
      await expect(job).resolves.toEqual(
        pairs.slice(0, 2).map((bytes) => bytes[0]!)
      );
    } finally {
      send.mockRestore();
      code.mockRestore();
    }
  });

  it('posts before returning and reconstructs pair order when replies arrive out of order', async () => {
    const workers = await ready();
    const job = pool.measure(pairs);
    expect(workers.every((worker) => worker.requests.length === 2)).toBe(true);
    expect(pool.measure(pairs)).toBeUndefined();
    for (const worker of workers.reverse())
      worker.reply(worker.requests[1]!.pairs.map((bytes) => bytes[0]!));
    await expect(job).resolves.toEqual([4, 7, 9, 3, 6, 1]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(
      workers.every((worker) => worker.terminate.mock.calls.length === 1)
    ).toBe(true);
    expect(pool.available).toBe(false);
    await ready();
  });
  it('allows finished replies after a synchronous live operation exceeds the response deadline', async () => {
    const workers = await ready();
    const job = pool.measure(pairs);
    // Advance wall time in one synchronous stack, as a WASM fuse does.
    vi.advanceTimersByTime(800);
    for (const worker of workers)
      worker.reply(worker.requests[1]!.pairs.map((bytes) => bytes[0]!));
    await expect(job).resolves.toEqual([4, 7, 9, 3, 6, 1]);
    expect(pool.available).toBe(true);
  });

  it.each([1, pairs.length])(
    'releases a cancelled caller on a %i-pair batch and reuses workers after their replies',
    async (count) => {
      const workers = await ready();
      let cancelled = false;
      const job = pool.measure(pairs.slice(0, count), {
        isCancelled: () => cancelled
      });
      cancelled = true;
      await vi.advanceTimersByTimeAsync(25);
      await expect(job).resolves.toBeUndefined();
      expect(workers.every((w) => w.terminate.mock.calls.length === 0)).toBe(
        true
      );
      expect(pool.available).toBe(false);
      expect(workers.slice(count).every((w) => w.requests.length === 1)).toBe(
        true
      );
      for (const w of workers.slice(0, count))
        w.reply(w.requests[1]!.pairs.map((bytes) => bytes[0]!));
      await vi.advanceTimersByTimeAsync(0);
      expect(pool.available).toBe(true);
      expect(TestWorker.instances.length).toBe(4);
    }
  );
  it('releases a partial batch on refusal and ignores late replies after a project change', async () => {
    const workers = await ready();
    const job = pool.measure(pairs);
    workers[0]!.reply([4, 6]);
    workers[1]!.reply(null);
    await expect(job).resolves.toBeUndefined();
    pool.warm();
    expect(TestWorker.instances.length).toBe(4);
    pool.dispose();
    await ready();
    workers[2]!.reply([999]);
    expect(pool.available).toBe(true);
  });
  it('finishes a waiting batch when disposed, even when a worker is silent', async () => {
    const workers = await ready();
    const job = pool.measure(pairs);
    pool.dispose();
    await expect(job).resolves.toBeUndefined();
    expect(workers.every((w) => w.terminate.mock.calls.length === 1)).toBe(
      true
    );
  });
  it('returns to serial measurement within the deadline and avoids retrying a failed pool', async () => {
    await ready();
    const job = pool.measure(pairs);
    await vi.advanceTimersByTimeAsync(350);
    await expect(job).resolves.toBeUndefined();
    pool.warm();
    expect(TestWorker.instances.length).toBe(4);
    expect(pool.available).toBe(false);
  });
  it('keeps the serial path on low-core devices', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
    pool.warm();
    expect(TestWorker.instances).toHaveLength(0);
    expect(pool.measure(pairs)).toBeUndefined();
  });
});
