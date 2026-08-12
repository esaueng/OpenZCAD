import { describe, expect, it } from 'vitest';
import { GeometryWorkerQueue } from './geometryWorkerQueue';

interface Job {
  value: number;
  requestId?: string;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('GeometryWorkerQueue', () => {
  it('serializes kernel work and coalesces superseded broadcasts', async () => {
    const first = deferred();
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;
    const queue = new GeometryWorkerQueue<Job>(async (job) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(job.value);
      if (job.value === 1) {
        await first.promise;
      }
      active -= 1;
    });

    queue.enqueue({ value: 1 });
    queue.enqueue({ value: 2 });
    queue.enqueue({ value: 3 });
    first.resolve();
    await queue.whenIdle();

    expect(started).toEqual([1, 3]);
    expect(maxActive).toBe(1);
  });

  it('never coalesces explicit sync and export requests', async () => {
    const first = deferred();
    const completed: number[] = [];
    const queue = new GeometryWorkerQueue<Job>(async (job) => {
      if (job.value === 1) {
        await first.promise;
      }
      completed.push(job.value);
    });

    queue.enqueue({ value: 1 });
    queue.enqueue({ value: 2, requestId: 'sync-once' });
    queue.enqueue({ value: 3 });
    queue.enqueue({ value: 4, requestId: 'export' });
    queue.enqueue({ value: 5 });
    first.resolve();
    await queue.whenIdle();

    expect(completed).toEqual([1, 2, 4, 5]);
  });
});
