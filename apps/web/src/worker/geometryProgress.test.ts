import { expect, it, vi } from 'vitest';
import type { RebuildProgressListener } from '@openzcad/kernel-adapter/exact';
import { geometryProgress } from './geometryProgress';

it('publishes the final feature completion before moving to another phase', () => {
  const publish = vi.fn<RebuildProgressListener>();
  const progress = geometryProgress(publish, () => 0);
  const feature = {
    stage: 'feature' as const,
    status: 'started' as const,
    name: 'Box32',
    index: 33,
    total: 33
  };
  progress(feature);
  progress({ ...feature, status: 'completed' });
  progress({ ...feature, stage: 'checkpoint', status: 'completed' });
  expect(publish).toHaveBeenCalledOnce();
  progress({ ...feature, stage: 'history', status: 'completed' });
  expect(
    publish.mock.calls.map(([event]) => [event.stage, event.status])
  ).toEqual([
    ['feature', 'started'],
    ['feature', 'completed'],
    ['history', 'completed']
  ]);
});

it('samples dense feature/checkpoint status without delaying stage transitions', () => {
  let clock = 0;
  const publish = vi.fn();
  const progress = geometryProgress(publish, () => clock);
  const feature = {
    stage: 'feature' as const,
    status: 'started' as const,
    name: 'Box',
    index: 1,
    total: 100
  };
  progress(feature);
  for (let index = 2; index <= 100; index++) {
    progress({ ...feature, index });
    progress({ ...feature, stage: 'checkpoint', index });
  }
  expect(publish).toHaveBeenCalledOnce();
  clock = 49;
  progress(feature);
  expect(publish).toHaveBeenCalledOnce();
  clock = 50;
  progress({ ...feature, status: 'completed' });
  progress({ ...feature, stage: 'history', status: 'completed' });
  progress({ ...feature, stage: 'measurement' });
  expect(publish).toHaveBeenCalledTimes(4);
  // Each new job has independent progress and no deferred status task that
  // could run after its terminal result or a newer generation.
  geometryProgress(publish, () => clock)(feature);
  expect(publish).toHaveBeenCalledTimes(5);
});
