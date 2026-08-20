import { describe, expect, it } from 'vitest';
import { toolDisabledReason } from './tools';

describe('finish tool selection order', () => {
  it('allows launching fillet before an edge is selected', () => {
    expect(
      toolDisabledReason('fillet', {
        sketchCount: 0,
        liveBodyCount: 1,
        exactGeometryReady: true,
        hasEdgeSelected: false
      })
    ).toBeNull();
  });

  it('still requires a body before launching an edge modifier', () => {
    expect(
      toolDisabledReason('chamfer', {
        sketchCount: 0,
        liveBodyCount: 0,
        exactGeometryReady: true,
        hasEdgeSelected: false
      })
    ).toBe('Needs a body');
  });

  it('keeps topology modifiers disabled while the exact projection is stale', () => {
    expect(
      toolDisabledReason('fillet', {
        sketchCount: 0,
        liveBodyCount: 1,
        exactGeometryReady: false,
        hasEdgeSelected: true
      })
    ).toBe('Waiting for exact geometry');
  });

  it('gates exact body modifiers on one exact live body', () => {
    for (const tool of [
      'mirror',
      'split',
      'shell',
      'solid-offset',
      'draft',
      'thicken',
      'hole'
    ] as const) {
      expect(
        toolDisabledReason(tool, {
          sketchCount: 0,
          liveBodyCount: 1,
          exactGeometryReady: false,
          hasEdgeSelected: false
        })
      ).toBe('Waiting for exact geometry');
      expect(
        toolDisabledReason(tool, {
          sketchCount: 0,
          liveBodyCount: 0,
          exactGeometryReady: true,
          hasEdgeSelected: false
        })
      ).toBe('Needs a body');
      expect(
        toolDisabledReason(tool, {
          sketchCount: 0,
          liveBodyCount: 1,
          exactGeometryReady: true,
          hasEdgeSelected: false
        })
      ).toBeNull();
    }
  });

  it('gates profile tools on authored sketch profiles', () => {
    expect(
      toolDisabledReason('loft', {
        sketchCount: 1,
        liveBodyCount: 0,
        exactGeometryReady: true,
        hasEdgeSelected: false
      })
    ).toBe('Create at least two closed sketch profiles');
    expect(
      toolDisabledReason('sweep', {
        sketchCount: 1,
        liveBodyCount: 0,
        exactGeometryReady: true,
        hasEdgeSelected: false
      })
    ).toBeNull();
  });
});
