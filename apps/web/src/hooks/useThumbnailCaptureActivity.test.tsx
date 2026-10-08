import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { toProjectId } from '@openzcad/shared';
import { createThumbnailCapture } from '../lib/projectThumbnailCapture';
import { useThumbnailCaptureActivity } from './useThumbnailCaptureActivity';

afterEach(() => vi.useRealTimers());

it('defers card rendering during input and regeneration, and removes activity listeners on unmount', async () => {
  vi.useFakeTimers();
  const capture = createThumbnailCapture();
  const render = vi.fn(() => null);
  const stage = (version: number) =>
    capture.stage(
      {
        projectId: toProjectId('thumbnail_activity'),
        version,
        updatedAt: '2026-10-08',
        bodies: []
      },
      {
        render,
        load: async () => null,
        save: async () => undefined,
        queue: async (work) => work()
      }
    );
  const hook = renderHook(
    ({ busy }) => useThumbnailCaptureActivity(capture, busy),
    {
      initialProps: { busy: false }
    }
  );
  stage(1);
  await act(() => vi.advanceTimersByTimeAsync(3500));
  await act(() => window.dispatchEvent(new Event('input')));
  await act(() => vi.advanceTimersByTimeAsync(3500));
  expect(render).not.toHaveBeenCalled();
  hook.rerender({ busy: true });
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(render).not.toHaveBeenCalled();
  hook.rerender({ busy: false });
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(render).toHaveBeenCalledOnce();
  hook.unmount();
  stage(2);
  await act(() => vi.advanceTimersByTimeAsync(3500));
  await act(() => window.dispatchEvent(new Event('keydown')));
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(render).toHaveBeenCalledTimes(2);
});
