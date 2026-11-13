import { describe, expect, it } from 'vitest';
import { toolDescription, toolDisabledReason } from './tools';

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

  it('gates profile tools on closed profiles, not on any sketch', () => {
    const openOnly = {
      sketchCount: 1,
      closedProfileSketchCount: 0,
      liveBodyCount: 0,
      exactGeometryReady: true,
      hasEdgeSelected: false
    };
    expect(toolDisabledReason('extrude', openOnly)).toBe(
      'Close a sketch profile first'
    );
    expect(toolDisabledReason('revolve', openOnly)).toBe(
      'Close a sketch profile first'
    );
    expect(toolDisabledReason('sweep', openOnly)).toBe(
      'Create a closed sketch profile first'
    );
    // Moving an open chain is still a real operation.
    expect(toolDisabledReason('transform', openOnly)).toBeNull();
    expect(
      toolDisabledReason('extrude', {
        ...openOnly,
        closedProfileSketchCount: 1
      })
    ).toBeNull();
  });
});

// Design review I10: while the workspace's own notice explains the shared
// lock, tool rows keep their descriptions; other reasons still show.
describe('toolDescription', () => {
  const base = {
    sketchCount: 1,
    liveBodyCount: 1,
    exactGeometryReady: true,
    hasEdgeSelected: false
  };
  it('keeps the hint while the workspace explains the lock', () => {
    expect(
      toolDescription(
        'box',
        {
          ...base,
          editDisabledReason: 'Connecting to the live session…',
          editDisabledExplained: true
        },
        'Rectangular solid'
      )
    ).toBe('Rectangular solid');
  });
  it('shows a lock the workspace does not explain elsewhere', () => {
    expect(
      toolDescription(
        'box',
        { ...base, editDisabledReason: 'This shared project is read-only' },
        'Rectangular solid'
      )
    ).toBe('This shared project is read-only');
  });
  it('still shows a tool-specific reason under an explained lock', () => {
    expect(
      toolDescription(
        'fillet',
        { ...base, exactGeometryReady: false },
        'Round an edge'
      )
    ).toBe('Waiting for exact geometry');
  });
});
