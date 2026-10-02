import { describe, expect, it } from 'vitest';
import { holeGhost } from './holeGhost';

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

describe('holeGhost', () => {
  it('drills where the builder drills: U along −Y, V along +X, into the face', () => {
    const ghost = holeGhost({
      face: top,
      anchor: 'centroid',
      u: 20,
      v: -40,
      diameter: 6,
      depth: 'through',
      bodyPositions: plate
    })!;
    expect(ghost.entry).toEqual({ x: 10, y: 10, z: 6 });
    expect(ghost.axis).toEqual({ x: -0, y: -0, z: -1 });
    expect(ghost.radius).toBe(3);
    // Through: to the far side of the body along the bore.
    expect(ghost.depth).toBeCloseTo(6, 9);
  });

  it('still draws a hole that misses, so the miss is visible', () => {
    const ghost = holeGhost({
      face: top,
      anchor: 'centroid',
      u: -40,
      v: 0,
      diameter: 6,
      depth: 4,
      bodyPositions: plate
    })!;
    // 40 mm along +Y from the centre is y = 70, past the 60 mm side.
    expect(ghost.entry).toEqual({ x: 50, y: 70, z: 6 });
    expect(ghost.depth).toBe(4);
  });

  it('measures from the vertex mean when the hole was placed that way', () => {
    const ghost = holeGhost({
      face: { ...top, center: { x: 0, y: 0, z: 6 } },
      anchor: 'center',
      u: 0,
      v: 0,
      diameter: 6,
      depth: 2,
      bodyPositions: plate
    })!;
    expect(ghost.entry).toEqual({ x: 0, y: 0, z: 6 });
  });

  it('has nothing to draw without a planar normal, an anchor or a size', () => {
    const base = {
      anchor: 'centroid' as const,
      u: 0,
      v: 0,
      diameter: 6,
      depth: 2,
      bodyPositions: plate
    };
    expect(holeGhost({ ...base, face: { center: top.center } })).toBeNull();
    expect(
      holeGhost({ ...base, face: { normal: top.normal, center: top.center } })
    ).toBeNull();
    expect(holeGhost({ ...base, face: top, diameter: 0 })).toBeNull();
    expect(holeGhost({ ...base, face: top, u: Number.NaN })).toBeNull();
  });
});
