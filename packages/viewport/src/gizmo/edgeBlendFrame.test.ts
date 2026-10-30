import { describe, expect, it } from 'vitest';
import {
  MAX_EDGE_TRAVEL,
  MIN_EDGE_TRAVEL,
  edgeBlendFrame
} from './edgeBlendFrame';

/**
 * Two quads meeting along the x axis, each as two outward-wound triangles.
 * `top` lies in z = 0 over y ∈ [-2, 0] facing +z; `side` lies in y = 0 over
 * z ∈ [-2, 0] facing +y — the top-front edge of a box. With `inside` the side
 * rises to z = 2 instead and the same winding faces -y: an inside corner.
 */
function corner(options: { inside?: boolean; flipWinding?: boolean } = {}) {
  const rise = options.inside ? 2 : -2;
  const vertices = [
    ...[0, -2, 0, 10, -2, 0, 10, 0, 0, 0, 0, 0],
    ...[0, 0, 0, 10, 0, 0, 10, 0, rise, 0, 0, rise]
  ];
  let indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  if (options.flipWinding) {
    indices = indices.flatMap((_, i, all) =>
      i % 3 === 0 ? [all[i]!, all[i + 2]!, all[i + 1]!] : []
    );
  }
  return {
    vertices,
    indices,
    faces: [
      { key: 1, triangleStart: 0, triangleCount: 2 },
      { key: 2, triangleStart: 2, triangleCount: 2 }
    ]
  };
}

const EDGE = [0, 0, 0, 10, 0, 0];
const BOX_CENTRE = { x: 5, y: -1, z: -1 };

describe('edgeBlendFrame', () => {
  it('lays the arrow across the edge on the face most across the view', () => {
    // Looking down from above: the top face lies across the view, the side
    // is seen edge on.
    const fromAbove = edgeBlendFrame({
      points: EDGE,
      ...corner(),
      bodyCenter: BOX_CENTRE,
      viewer: { x: 5, y: -1, z: 40 }
    });
    expect(fromAbove!.direction.x).toBeCloseTo(0, 9);
    expect(fromAbove!.direction.y).toBeCloseTo(-1, 9);
    expect(fromAbove!.direction.z).toBeCloseTo(0, 9);
    // Looking at the front: the side face, pointing down it.
    const fromFront = edgeBlendFrame({
      points: EDGE,
      ...corner(),
      bodyCenter: BOX_CENTRE,
      viewer: { x: 5, y: 40, z: -1 }
    });
    expect(fromFront!.direction.y).toBeCloseTo(0, 9);
    expect(fromFront!.direction.z).toBeCloseTo(-1, 9);
  });

  it('moves one for one with a square edge’s radius and setback', () => {
    const frame = edgeBlendFrame({
      points: EDGE,
      ...corner(),
      bodyCenter: BOX_CENTRE
    });
    // A right-angle fillet of radius r meets each face r from the edge; a
    // symmetric chamfer's setback is its distance on any edge.
    expect(frame!.travel!.fillet).toBeCloseTo(1, 9);
    expect(frame!.travel!.chamfer).toBe(1);
  });

  it('points away from an inside edge along the wall it rises up', () => {
    const frame = edgeBlendFrame({
      points: EDGE,
      ...corner({ inside: true }),
      bodyCenter: { x: 5, y: 1, z: -1 },
      viewer: { x: 5, y: -40, z: 1 }
    });
    expect(frame!.direction.z).toBeCloseTo(1, 9);
    expect(frame!.travel!.fillet).toBeCloseTo(1, 9);
  });

  it('reads the same frame from a mesh wound inside out', () => {
    const frame = edgeBlendFrame({
      points: EDGE,
      ...corner({ flipWinding: true }),
      bodyCenter: BOX_CENTRE,
      viewer: { x: 5, y: 40, z: -1 }
    });
    expect(frame!.direction.z).toBeCloseTo(-1, 9);
  });

  it('keeps the face it had when told which way it pointed', () => {
    const frame = edgeBlendFrame({
      points: EDGE,
      ...corner(),
      bodyCenter: BOX_CENTRE,
      viewer: { x: 5, y: 40, z: -1 },
      prefer: { x: 0, y: -1, z: 0 }
    });
    expect(frame!.direction.y).toBeCloseTo(-1, 9);
  });

  it('stands at the arc-length middle of a two-point line, not an end', () => {
    const frame = edgeBlendFrame({
      points: EDGE,
      ...corner(),
      bodyCenter: BOX_CENTRE
    });
    expect(frame!.origin.x).toBeCloseTo(5, 9);
  });

  it('stands where the edge was picked', () => {
    const frame = edgeBlendFrame({
      points: EDGE,
      ...corner(),
      bodyCenter: BOX_CENTRE,
      near: { x: 8.25, y: 0.02, z: 0.01 }
    });
    expect(frame!.origin).toEqual({ x: 8.25, y: 0, z: 0 });
  });

  it('turns a closed edge with no pick toward the viewer', () => {
    const ring: number[] = [];
    for (let i = 0; i <= 32; i++) {
      const angle = (i / 32) * Math.PI * 2;
      ring.push(Math.cos(angle) * 5, Math.sin(angle) * 5, 0);
    }
    const frame = edgeBlendFrame({
      points: ring,
      vertices: [],
      indices: [],
      faces: [],
      bodyCenter: { x: 0, y: 0, z: -5 },
      viewer: { x: 0, y: -40, z: 30 }
    });
    expect(frame!.origin.x).toBeCloseTo(0, 6);
    expect(frame!.origin.y).toBeCloseTo(-5, 6);
  });

  it('falls back to pointing away from the body without two faces', () => {
    const frame = edgeBlendFrame({
      points: EDGE,
      vertices: [],
      indices: [],
      faces: [],
      bodyCenter: { x: 5, y: 0, z: -3 }
    });
    expect(frame!.direction).toEqual({ x: 0, y: 0, z: 1 });
    expect(frame!.travel).toBeUndefined();
  });

  it('bounds travel on nearly flat and knife edges', () => {
    // Two faces meeting at 170°: the tangent line barely leaves the edge.
    const tilt = Math.tan((10 * Math.PI) / 180) * 2;
    const flat = edgeBlendFrame({
      points: EDGE,
      vertices: [
        ...[0, -2, 0, 10, -2, 0, 10, 0, 0, 0, 0, 0],
        ...[10, 2, -tilt, 0, 2, -tilt]
      ],
      indices: [0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5],
      faces: [
        { key: 'a', triangleStart: 0, triangleCount: 2 },
        { key: 'b', triangleStart: 2, triangleCount: 2 }
      ],
      bodyCenter: { x: 5, y: 0, z: -5 }
    });
    expect(flat!.travel!.fillet).toBe(MIN_EDGE_TRAVEL);
    // Two faces folded back on each other at 2°.
    const fold = Math.tan((2 * Math.PI) / 180) * 2;
    const knife = edgeBlendFrame({
      points: EDGE,
      vertices: [
        ...[0, -2, 0, 10, -2, 0, 10, 0, 0, 0, 0, 0],
        ...[10, -2, -fold, 0, -2, -fold]
      ],
      // The underside faces down, back along the top it nearly meets.
      indices: [0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5],
      faces: [
        { key: 'a', triangleStart: 0, triangleCount: 2 },
        { key: 'b', triangleStart: 2, triangleCount: 2 }
      ],
      bodyCenter: { x: 5, y: -1, z: -0.01 }
    });
    expect(knife!.travel!.fillet).toBe(MAX_EDGE_TRAVEL);
  });

  it('rejects a polyline with no span', () => {
    expect(
      edgeBlendFrame({
        points: [1, 2, 3],
        vertices: [],
        indices: [],
        faces: [],
        bodyCenter: { x: 0, y: 0, z: 0 }
      })
    ).toBeNull();
  });
});
