import { expect, it } from 'vitest';
import { rebuildProgressLabel } from './rebuildProgressLabel';
it('shows the active feature and completed operation timing', () => {
  expect(rebuildProgressLabel()).toBeNull();
  expect(
    rebuildProgressLabel({
      stage: 'feature',
      name: 'Opening',
      index: 6,
      total: 17,
      status: 'started'
    })
  ).toBe('Building: Opening (6/17)');
  expect(
    rebuildProgressLabel({
      stage: 'measurement',
      name: 'Holder',
      index: 1,
      total: 1,
      status: 'completed',
      durationMs: 1234
    })
  ).toBe('Measuring: Holder (1/1) completed in 1.2s');
});
