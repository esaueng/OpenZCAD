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
  it('aims an outside edge into the material at 45° to each face', () => {
    const frame = edgeBlendFrame({
      points: EDGE,
      ...corner(),
      bodyCenter: BOX_CENTRE
    });
    expect(frame!.origin).toEqual({ x: 5, y: 0, z: 0 });
    expect(frame!.direction.x).toBeCloseTo(0, 9);
    expect(frame!.direction.y).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(frame!.direction.z).toBeCloseTo(-Math.SQRT1_2, 9);
  });

  it('rides the middle of the blend: r(√2 − 1) for a fillet, d/√2 for a chamfer', () => {
    const frame = edgeBlendFrame({
      points: EDGE,
      ...corner(),
      bodyCenter: BOX_CENTRE
    });
    expect(frame!.travel!.fillet).toBeCloseTo(Math.SQRT2 - 1, 9);
    expect(frame!.travel!.chamfer).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it('aims an inside edge out into the corner it fills', () => {
    const frame = edgeBlendFrame({
      points: EDGE,
      ...corner({ inside: true }),
      bodyCenter: { x: 5, y: 1, z: -1 }
    });
    expect(frame!.direction.y).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(frame!.direction.z).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it('reads the same frame from a mesh wound inside out', () => {
    const frame = edgeBlendFrame({
      points: EDGE,
      ...corner({ flipWinding: true }),
      bodyCenter: BOX_CENTRE
    });
    expect(frame!.direction.y).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(frame!.direction.z).toBeCloseTo(-Math.SQRT1_2, 9);
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

  it('floors travel on a nearly flat edge', () => {
    // Two faces meeting at 170°: the blend barely moves the surface.
    const tilt = Math.tan((10 * Math.PI) / 180) * 2;
    const frame = edgeBlendFrame({
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
    expect(frame!.direction.z).toBeLessThan(-0.99);
    expect(frame!.travel!.fillet).toBe(MIN_EDGE_TRAVEL);
    expect(frame!.travel!.fillet).toBeLessThanOrEqual(MAX_EDGE_TRAVEL);
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
