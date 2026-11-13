import { describe, expect, it } from 'vitest';
import { liveCylindricalFace, toolDisabledReason } from './tools';

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

describe('Thread and Gear teeth on a model with no cylindrical face', () => {
  const READY = {
    sketchCount: 0,
    liveBodyCount: 1,
    exactGeometryReady: true,
    hasEdgeSelected: false
  };
  const face = (surfaceType: string) => ({ geometry: { surfaceType } });
  const body = (bodyId: string, surfaces: string[] | null, consumed = false) =>
    ({
      bodyId,
      consumed,
      ...(surfaces ? { topology: { faces: surfaces.map(face) } } : {})
    }) as never;

  it('says what is missing rather than offering a dead end', () => {
    // 13 November review: both were offered on a box-only model.
    for (const tool of ['thread', 'gear-teeth'] as const) {
      expect(
        toolDisabledReason(tool, { ...READY, hasCylindricalFace: false })
      ).toBe('Needs a cylindrical face');
      expect(
        toolDisabledReason(tool, { ...READY, hasCylindricalFace: true })
      ).toBeNull();
      // Unknown (topology still building) leaves them offered.
      expect(toolDisabledReason(tool, READY)).toBeNull();
    }
    expect(
      toolDisabledReason('hole', { ...READY, hasCylindricalFace: false })
    ).toBeNull();
  });

  it('reads the live bodies faces, skipping consumed and hidden ones', () => {
    const box = body('box', ['Plane', 'Plane', 'Plane']);
    const rod = body('rod', ['Plane', 'Cylinder', 'Plane']);
    expect(liveCylindricalFace({ box }, new Set())).toBe(false);
    expect(liveCylindricalFace({ box, rod }, new Set())).toBe(true);
    expect(liveCylindricalFace({ box, rod }, new Set(['rod']))).toBe(false);
    expect(
      liveCylindricalFace(
        { box, rod: body('rod', ['Cylinder'], true) },
        new Set()
      )
    ).toBe(false);
    expect(
      liveCylindricalFace({ box, mesh: body('mesh', null) }, new Set())
    ).toBe(undefined);
    expect(liveCylindricalFace(null, new Set())).toBeUndefined();
  });
});
