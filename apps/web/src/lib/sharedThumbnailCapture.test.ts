import { expect, it, vi } from 'vitest';
import { toProjectId } from '@openzcad/shared';
import { createThumbnailCapture } from './projectThumbnailCapture';
import { lazyThumbnailCapture } from './sharedThumbnailCapture';

it('retries failed imports and replays the latest stage and active subscribers', async () => {
  const actual = createThumbnailCapture();
  const load = vi
    .fn<() => Promise<typeof actual>>()
    .mockRejectedValueOnce(new Error('Network unavailable'))
    .mockResolvedValue(actual);
  const capture = lazyThumbnailCapture(load);
  capture.setBusy(true);
  const listener = vi.fn();
  const unsubscribe = capture.subscribe(listener);
  const cancelledListener = vi.fn();
  capture.subscribe(cancelledListener)();
  const render = vi.fn(() => null);
  const save = vi.fn(async () => undefined);
  for (const version of [1, 2]) {
    capture.stage(
      {
        projectId: toProjectId('retry_card'),
        version,
        updatedAt: '2026-10-08',
        bodies: []
      },
      { render, save, load: async () => null, queue: async (work) => work() }
    );
  }
  await vi.waitFor(() =>
    expect(load.mock.results[0]!.value).rejects.toThrow('Network unavailable')
  );
  // flush retries the import and still owns the work staged before failure.
  await capture.flush();
  expect(load).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenCalledWith(
    'retry_card',
    expect.objectContaining({ version: 2 })
  );
  expect(render).toHaveBeenCalledOnce();
  expect(listener).toHaveBeenCalledOnce();
  expect(cancelledListener).not.toHaveBeenCalled();
  unsubscribe();
  capture.discard();
});

it('does not revive discarded work when a failed import is retried', async () => {
  const actual = createThumbnailCapture();
  const load = vi
    .fn<() => Promise<typeof actual>>()
    .mockRejectedValueOnce(new Error('Network unavailable'))
    .mockResolvedValue(actual);
  const capture = lazyThumbnailCapture(load);
  const render = vi.fn(() => null);
  capture.stage(
    {
      projectId: toProjectId('discarded_card'),
      version: 1,
      updatedAt: '2026-10-08',
      bodies: []
    },
    {
      render,
      save: async () => undefined,
      load: async () => null,
      queue: async (work) => work()
    }
  );
  await vi.waitFor(() =>
    expect(load.mock.results[0]!.value).rejects.toThrow('Network unavailable')
  );
  capture.discard();
  await capture.flush();
  expect(load).toHaveBeenCalledTimes(2);
  expect(render).not.toHaveBeenCalled();
});

it('buffers staged versions and leave-time flush while loading, without loading on input alone', async () => {
  const actual = createThumbnailCapture();
  let resolve!: (capture: typeof actual) => void;
  const load = vi.fn(
    () =>
      new Promise<typeof actual>((done) => {
        resolve = done;
      })
  );
  const capture = lazyThumbnailCapture(load);
  capture.setBusy(true);
  capture.activity();
  expect(load).not.toHaveBeenCalled();
  const cancelledListener = vi.fn();
  capture.subscribe(cancelledListener)();
  const listener = vi.fn();
  const unsubscribe = capture.subscribe(listener);
  const render = vi.fn(() => null);
  const save = vi.fn(async () => undefined);
  for (const version of [1, 2]) {
    capture.stage(
      {
        projectId: toProjectId('lazy_card'),
        version,
        updatedAt: '2026-10-08',
        bodies: []
      },
      {
        render,
        save,
        load: async () => null,
        queue: async (work) => work()
      }
    );
  }
  const flushed = capture.flush();
  expect(render).not.toHaveBeenCalled();
  resolve(actual);
  await flushed;
  expect(load).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledWith(
    'lazy_card',
    expect.objectContaining({ version: 2 })
  );
  expect(listener).toHaveBeenCalledOnce();
  expect(cancelledListener).not.toHaveBeenCalled();
  unsubscribe();
  capture.discard();
  await capture.flush();
  expect(render).toHaveBeenCalledOnce();
});
