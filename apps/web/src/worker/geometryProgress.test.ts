import { expect, it, vi } from 'vitest';
import { geometryProgress } from './geometryProgress';

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
