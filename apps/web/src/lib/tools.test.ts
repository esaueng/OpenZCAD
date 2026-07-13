import { describe, expect, it } from 'vitest';
import { toolDisabledReason } from './tools';

describe('finish tool selection order', () => {
  it('allows launching fillet before an edge is selected', () => {
    expect(
      toolDisabledReason('fillet', {
        sketchCount: 0,
        liveBodyCount: 1,
        hasEdgeSelected: false
      })
    ).toBeNull();
  });

  it('still requires a body before launching an edge modifier', () => {
    expect(
      toolDisabledReason('chamfer', {
        sketchCount: 0,
        liveBodyCount: 0,
        hasEdgeSelected: false
      })
    ).toBe('Needs a body');
  });
});
