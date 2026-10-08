import { expect, it, vi } from 'vitest';
import { toProjectId } from '@openzcad/shared';
import { createThumbnailCapture } from './projectThumbnailCapture';
import { lazyThumbnailCapture } from './sharedThumbnailCapture';

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
