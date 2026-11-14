import { describe, expect, it } from 'vitest';
import type { MeshGeometry } from '@openzcad/shared';
import { cylinderFaceIsBoss, facePickKey } from './cylinderSide';
import type { FacePick } from './tools';

/**
 * A closed thick-walled tube up +Z, wound outward: its outer wall is a boss
 * face (triangles 0..2n), its inner wall a bore face (2n..4n), then the two
 * annular caps.
 */
function tube(n: number, outer: number, inner: number, height: number) {
  const vertices: number[] = [];
  const ring = (radius: number, z: number) => {
    const start = vertices.length / 3;
    for (let k = 0; k < n; k += 1) {
      const angle = (2 * Math.PI * k) / n;
      vertices.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
    }
    return start;
  };
  const [ob, ot, ib, it] = [
    ring(outer, 0),
    ring(outer, height),
    ring(inner, 0),
    ring(inner, height)
  ];
  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) =>
    indices.push(a, b, c, a, c, d);
  for (let k = 0; k < n; k += 1) {
    const j = (k + 1) % n;
    quad(ob + k, ob + j, ot + j, ot + k); // outer wall, facing out
  }
  for (let k = 0; k < n; k += 1) {
    const j = (k + 1) % n;
    quad(ib + k, it + k, it + j, ib + j); // inner wall, facing the axis
  }
  for (let k = 0; k < n; k += 1) {
    const j = (k + 1) % n;
    quad(ot + k, ot + j, it + j, it + k); // top, facing +Z
    quad(ob + k, ib + k, ib + j, ob + j); // bottom, facing −Z
  }
  return {
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array(vertices),
      indices: new Uint32Array(indices)
    } satisfies MeshGeometry,
    outerWall: { triangleStart: 0, triangleCount: 2 * n },
    innerWall: { triangleStart: 2 * n, triangleCount: 2 * n }
  };
}

const AXIS = [
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 12 }
] as const;

describe('cylinderFaceIsBoss', () => {
  it('reads a tube’s outer wall as a boss and its inner wall as a bore', () => {
    const { mesh, outerWall, innerWall } = tube(24, 10, 6, 12);
    expect(cylinderFaceIsBoss(mesh, outerWall, ...AXIS)).toBe(true);
    expect(cylinderFaceIsBoss(mesh, innerWall, ...AXIS)).toBe(false);
  });

  it('orients by the mesh’s own winding, not an assumed one', () => {
    const { mesh, outerWall, innerWall } = tube(24, 10, 6, 12);
    const flipped = new Uint32Array(mesh.indices);
    for (let t = 0; t < flipped.length; t += 3) {
      [flipped[t + 1], flipped[t + 2]] = [flipped[t + 2]!, flipped[t + 1]!];
    }
    const inward = { ...mesh, indices: flipped };
    expect(cylinderFaceIsBoss(inward, outerWall, ...AXIS)).toBe(true);
    expect(cylinderFaceIsBoss(inward, innerWall, ...AXIS)).toBe(false);
    // The axis may run either way.
    expect(cylinderFaceIsBoss(mesh, outerWall, AXIS[1], AXIS[0])).toBe(true);
  });

  it('cannot say for an empty face, an empty mesh or a degenerate axis', () => {
    const { mesh, outerWall } = tube(24, 10, 6, 12);
    expect(
      cylinderFaceIsBoss(mesh, { triangleStart: 0, triangleCount: 0 }, ...AXIS)
    ).toBeNull();
    const empty = { ...mesh, indices: new Uint32Array(0) };
    expect(cylinderFaceIsBoss(empty, outerWall, ...AXIS)).toBeNull();
    expect(cylinderFaceIsBoss(mesh, outerWall, AXIS[0], AXIS[0])).toBeNull();
  });
});

describe('facePickKey (review #1458)', () => {
  it('changes when only a picked cylinder’s axial length or radius does', () => {
    // Sol's resize: a boss 20 → 20.00000004 tall moved to keep its middle,
    // where hash, placement and click stay as they were.
    const pick: FacePick = {
      bodyId: 'body_a' as FacePick['bodyId'],
      hash: 9,
      topologyId: 't',
      center: { x: 0, y: 0, z: 10 },
      cylinder: {
        axisStart: { x: 0, y: 0, z: 0 },
        axisEnd: { x: 0, y: 0, z: 20 },
        radius: 3,
        axialLength: 20,
        boss: true
      }
    };
    const resized: FacePick = {
      ...pick,
      cylinder: { ...pick.cylinder!, axialLength: 20.00000004 }
    };
    expect(facePickKey(resized)).not.toBe(facePickKey(pick));
    expect(
      facePickKey({ ...pick, cylinder: { ...pick.cylinder!, radius: 3.1 } })
    ).not.toBe(facePickKey(pick));
    expect(facePickKey({ ...pick })).toBe(facePickKey(pick));
  });
});
