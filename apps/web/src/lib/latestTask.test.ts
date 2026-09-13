import { expect, it, vi } from 'vitest';
import { LatestTask } from './latestTask';

it('runs the active exact job and only the newest pending edit', async () => {
  const queue = new LatestTask<number>();
  let finish!: (value: number) => void;
  const active = queue.request(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const staleRun = vi.fn(async () => 2);
  const stale = queue
    .request(staleRun)
    .catch((error: unknown) => error as Error);
  const latest = queue.request(async () => 3);
  expect(((await stale) as Error).name).toBe('AbortError');
  expect(staleRun).not.toHaveBeenCalled();
  finish(1);
  expect(await active).toBe(1);
  expect(await latest).toBe(3);
});

it('cancels pending work and recovers after a failed active job', async () => {
  const queue = new LatestTask<number>();
  let fail!: (reason: Error) => void;
  const active = queue
    .request(
      () =>
        new Promise<number>((_, reject) => {
          fail = reject;
        })
    )
    .catch((error: unknown) => error as Error);
  const pending = queue
    .request(async () => 2)
    .catch((error: unknown) => error as Error);
  queue.cancelPending();
  expect(((await pending) as Error).name).toBe('AbortError');
  fail(new Error('Invalid solid'));
  expect(((await active) as Error).message).toBe('Invalid solid');
  expect(await queue.request(async () => 3)).toBe(3);
});
