import { describe, expect, it } from 'vitest';
import { HOLE_MISSES_NOTICE, holePreview } from './holeGhost';

// A 100 × 60 × 6 plate, corner at the origin: its top face at z = 6.
const plate = new Float32Array([
  0, 0, 0, 100, 0, 0, 100, 60, 0, 0, 60, 0, 0, 0, 6, 100, 0, 6, 100, 60, 6, 0,
  60, 6
]);
const top = {
  normal: { x: 0, y: 0, z: 1 },
  centroid: { x: 50, y: 30, z: 6 },
  center: { x: 50, y: 30, z: 6 }
};
const base = {
  face: top,
  anchor: 'centroid' as const,
  u: 0,
  v: 0,
  diameter: 6,
  outerDiameter: 6,
  depth: 2 as number | 'through',
  bodyPositions: plate
};

describe('holePreview', () => {
  it('drills where the builder drills: U along −Y, V along +X, into the face', () => {
    const { ghost, notice } = holePreview({
      ...base,
      u: 20,
      v: -40,
      depth: 'through'
    });
    expect(notice).toBeNull();
    expect(ghost!.entry).toEqual({ x: 10, y: 10, z: 6 });
    expect(ghost!.axis).toEqual({ x: -0, y: -0, z: -1 });
    expect(ghost!.radius).toBe(3);
    // Through: to the far side of the body along the bore.
    expect(ghost!.depth).toBeCloseTo(6, 9);
  });

  it('runs a through bore to the far bounding-box corner, as the builder does', () => {
    // A tilted entry face: the builder takes the farthest corner of the
    // body's box along the bore, not the farthest mesh vertex.
    const tilted = Math.SQRT1_2;
    const { ghost } = holePreview({
      ...base,
      face: {
        normal: { x: tilted, y: 0, z: tilted },
        center: { x: 100, y: 30, z: 6 }
      },
      anchor: 'center',
      depth: 'through'
    });
    // Farthest corner along (−½√2, 0, −½√2) from (100, 30, 6) is (0, *, 0).
    expect(ghost!.depth).toBeCloseTo((100 + 6) * tilted, 6);
  });

  it('still draws a hole that misses, and says it misses', () => {
    const { ghost, notice } = holePreview({ ...base, u: -40, depth: 4 });
    // 40 mm along +Y from the centre is y = 70, past the 60 mm side.
    expect(ghost!.entry).toEqual({ x: 50, y: 70, z: 6 });
    expect(ghost!.depth).toBe(4);
    expect(notice).toBe(HOLE_MISSES_NOTICE);
  });

  it('does not call a hole that clips the edge a miss', () => {
    // Centre 2 mm past the 60 mm side, radius 3: the bore still cuts.
    expect(holePreview({ ...base, u: -32 }).notice).toBeNull();
    // The counterbore reaches the plate even when the bore does not.
    expect(
      holePreview({ ...base, u: -36, outerDiameter: 16 }).notice
    ).toBeNull();
    expect(holePreview({ ...base, u: -36 }).notice).toBe(HOLE_MISSES_NOTICE);
  });

  it('withholds the miss notice when the widest tool is unknown', () => {
    const { ghost, notice } = holePreview({
      ...base,
      u: -40,
      outerDiameter: null
    });
    expect(ghost).not.toBeNull();
    expect(notice).toBeNull();
  });

  it('measures from the vertex mean when the hole was placed that way', () => {
    const { ghost } = holePreview({
      ...base,
      face: { ...top, center: { x: 0, y: 0, z: 6 } },
      anchor: 'center'
    });
    expect(ghost!.entry).toEqual({ x: 0, y: 0, z: 6 });
  });

  it('says why there is no ghost instead of drawing nothing', () => {
    const refusal = (overrides: Partial<typeof base> | object) => {
      const preview = holePreview({ ...base, ...overrides });
      expect(preview.ghost).toBeNull();
      return preview.notice;
    };
    expect(refusal({ face: null })).toBe(
      'No preview — the entry face is no longer on this body. Pick the face again.'
    );
    expect(refusal({ face: { center: top.center } })).toBe(
      'No preview — a hole needs a planar entry face with an analytic normal.'
    );
    expect(
      refusal({ face: { normal: { x: 0, y: 0, z: 0 }, center: top.center } })
    ).toBe('No preview — the entry face normal is degenerate.');
    expect(refusal({ face: { normal: top.normal, center: top.center } })).toBe(
      'No preview — the entry face no longer reports an area centroid, and this hole is positioned from one.'
    );
    expect(refusal({ u: Number.NaN })).toBe(
      'No preview — the position must resolve to finite numbers.'
    );
    expect(refusal({ diameter: 0 })).toBe(
      'No preview — the hole diameter must be greater than zero.'
    );
    expect(refusal({ diameter: Number.POSITIVE_INFINITY })).toBe(
      'No preview — the hole diameter must be greater than zero.'
    );
    expect(refusal({ depth: -1 })).toBe(
      'No preview — the hole depth must be greater than zero.'
    );
  });

  it('refuses a through bore that points away from the body', () => {
    // An entry point above the plate on a face pointing down: the bore runs
    // up, away from everything.
    const { ghost, notice } = holePreview({
      ...base,
      face: {
        normal: { x: 0, y: 0, z: -1 },
        center: { x: 50, y: 30, z: 20 }
      },
      anchor: 'center',
      depth: 'through'
    });
    expect(ghost).toBeNull();
    expect(notice).toBe('No preview — the hole points away from the body.');
  });

  it('waits quietly while the body has no mesh', () => {
    expect(holePreview({ ...base, bodyPositions: new Float32Array() })).toEqual(
      { ghost: null, notice: null }
    );
  });
});
