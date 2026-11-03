import { describe, expect, it } from 'vitest';
import type {
  AssemblyFrame,
  BodyTopology,
  EdgeTopology,
  FaceTopology,
  Vector3
} from '@openzcad/shared';
import { deriveJointFrame, fitCircle, nearestVertex } from './framePick';

const EPS = 1e-9;

function expectVector(actual: Vector3, expected: Vector3, tolerance = EPS) {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.z - expected.z)).toBeLessThanOrEqual(tolerance);
}

function expectOrthonormal(frame: AssemblyFrame) {
  const { xAxis: x, zAxis: z } = frame;
  expect(Math.abs(Math.hypot(x.x, x.y, x.z) - 1)).toBeLessThan(1e-12);
  expect(Math.abs(Math.hypot(z.x, z.y, z.z) - 1)).toBeLessThan(1e-12);
  expect(Math.abs(x.x * z.x + x.y * z.y + x.z * z.z)).toBeLessThan(1e-12);
}

function circlePoints(
  center: Vector3,
  radius: number,
  count: number,
  closed = true
): number[] {
  const points: number[] = [];
  const steps = closed ? count : count - 1;
  for (let k = 0; k <= steps; k += 1) {
    const a = ((closed ? 2 * Math.PI : Math.PI / 2) * k) / count;
    points.push(
      center.x + radius * Math.cos(a),
      center.y + radius * Math.sin(a),
      center.z
    );
  }
  return points;
}

function face(
  topologyId: string,
  hash: number,
  geometry: FaceTopology['geometry']
): FaceTopology {
  return { topologyId, hash, triangleStart: 0, triangleCount: 1, geometry };
}

/** A 20 × 20 × 4 plate on z ∈ [0, 4] with a Ø6 through hole at (5, 5). */
function plate(): BodyTopology {
  const top = face('face_top', 11, {
    surfaceType: 'PLANE',
    area: 400,
    center: { x: 10, y: 10, z: 4 },
    centroid: { x: 10, y: 10, z: 4 },
    normal: { x: 0, y: 0, z: 1 },
    planeOffset: 4
  });
  const bore = face('face_bore', 12, {
    surfaceType: 'CYLINDER',
    area: 1,
    center: { x: 5, y: 5, z: 2 },
    radius: 3,
    axisStart: { x: 5, y: 5, z: 0 },
    axisEnd: { x: 5, y: 5, z: 4 }
  });
  const rim: EdgeTopology = {
    topologyId: 'edge_rim',
    hash: 21,
    adjacentFaceHashes: [11, 12],
    vertexIds: [0, 0],
    // The kernel's canonical, unoriented sign: here pointing into the plate.
    curve: {
      type: 'CIRCLE',
      circle: {
        center: { x: 5, y: 5, z: 4 },
        axis: { x: 0, y: 0, z: -1 },
        radius: 3
      }
    },
    points: circlePoints({ x: 5, y: 5, z: 4 }, 3, 32)
  };
  const side: EdgeTopology = {
    topologyId: 'edge_side',
    hash: 22,
    adjacentFaceHashes: [11],
    vertexIds: [1, 2],
    curve: { type: 'LINE' },
    points: [0, 0, 4, 10, 0, 4, 20, 0, 4]
  };
  return {
    faces: [top, bore],
    edges: [rim, side],
    vertices: [
      { id: 0, point: { x: 8, y: 5, z: 4 } },
      { id: 1, point: { x: 0, y: 0, z: 4 } },
      { id: 2, point: { x: 20, y: 0, z: 4 } }
    ]
  };
}

describe('joint frame picking', () => {
  it('snaps a circular edge to its exact centre, Z out of the face it rims', () => {
    const picked = deriveJointFrame(plate(), {
      kind: 'edge',
      topologyId: 'edge_rim',
      point: { x: 5, y: 2, z: 4 }
    });
    expect(picked?.source.kind).toBe('circle');
    expect(picked?.source.label).toBe('Circular edge · centre');
    expectVector(picked!.frame.origin, { x: 5, y: 5, z: 4 });
    expectVector(picked!.frame.zAxis, { x: 0, y: 0, z: 1 });
    expectOrthonormal(picked!.frame);
  });

  it('gives the same frame for every point on the same edge', () => {
    const a = deriveJointFrame(plate(), {
      kind: 'edge',
      topologyId: 'edge_rim',
      point: { x: 5, y: 2, z: 4 }
    });
    const b = deriveJointFrame(plate(), {
      kind: 'edge',
      topologyId: 'edge_rim',
      point: { x: 2, y: 5, z: 4 }
    });
    expect(b).toEqual(a);
  });

  it('fits a circle when the kernel published none, and says so', () => {
    const topology = plate();
    const rim = topology.edges[0]!;
    topology.edges[0] = { ...rim, curve: { type: 'CIRCLE' } };
    const picked = deriveJointFrame(topology, {
      kind: 'edge',
      topologyId: 'edge_rim',
      point: { x: 5, y: 2, z: 4 }
    });
    expect(picked?.source.kind).toBe('circle');
    expect(picked?.source.label).toContain('fitted');
    expectVector(picked!.frame.origin, { x: 5, y: 5, z: 4 }, 1e-9);
    expectVector(picked!.frame.zAxis, { x: 0, y: 0, z: 1 }, 1e-12);
  });

  it('takes a cylinder axis at the point nearest the hit', () => {
    const picked = deriveJointFrame(plate(), {
      kind: 'face',
      topologyId: 'face_bore',
      point: { x: 8, y: 5, z: 1.5 }
    });
    expect(picked?.source.kind).toBe('cylinder');
    expectVector(picked!.frame.origin, { x: 5, y: 5, z: 1.5 });
    expectVector(picked!.frame.zAxis, { x: 0, y: 0, z: 1 });
  });

  it('snaps to a cylinder axis end within the tolerance', () => {
    const picked = deriveJointFrame(
      plate(),
      { kind: 'face', topologyId: 'face_bore', point: { x: 2, y: 5, z: 0.2 } },
      { snapTolerance: 0.5 }
    );
    expect(picked?.source.label).toBe('Cylinder axis · end');
    expectVector(picked!.frame.origin, { x: 5, y: 5, z: 0 });
  });

  it('drops a planar hit onto the exact plane, Z the outward normal', () => {
    const picked = deriveJointFrame(plate(), {
      kind: 'face',
      topologyId: 'face_top',
      point: { x: 15, y: 12, z: 4.0001 },
      normal: { x: 0, y: 0.1, z: 1 }
    });
    expect(picked?.source.kind).toBe('plane');
    expectVector(picked!.frame.origin, { x: 15, y: 12, z: 4 });
    expectVector(picked!.frame.zAxis, { x: 0, y: 0, z: 1 });
    // X is the world axis least aligned with Z, in X, Y, Z order.
    expectVector(picked!.frame.xAxis, { x: 1, y: 0, z: 0 });
  });

  it('snaps a planar hit near the face centroid onto it', () => {
    const picked = deriveJointFrame(
      plate(),
      {
        kind: 'face',
        topologyId: 'face_top',
        point: { x: 10.2, y: 9.9, z: 4 }
      },
      { snapTolerance: 0.5 }
    );
    expect(picked?.source.label).toBe('Face · centre');
    expectVector(picked!.frame.origin, { x: 10, y: 10, z: 4 });
  });

  it('takes a straight edge at its midpoint along its direction', () => {
    const picked = deriveJointFrame(plate(), {
      kind: 'edge',
      topologyId: 'edge_side',
      point: { x: 3, y: 0, z: 4 }
    });
    expect(picked?.source.kind).toBe('line');
    expectVector(picked!.frame.origin, { x: 10, y: 0, z: 4 });
    expectVector(picked!.frame.zAxis, { x: 1, y: 0, z: 0 });
    // X follows the adjacent face's normal.
    expectVector(picked!.frame.xAxis, { x: 0, y: 0, z: 1 });
    expectOrthonormal(picked!.frame);
  });

  it('snaps to a vertex within the tolerance, Z an adjacent plane normal', () => {
    const picked = deriveJointFrame(
      plate(),
      { kind: 'edge', topologyId: 'edge_side', point: { x: 19.8, y: 0, z: 4 } },
      { snapTolerance: 0.5 }
    );
    expect(picked?.source.kind).toBe('vertex');
    expectVector(picked!.frame.origin, { x: 20, y: 0, z: 4 });
    expectVector(picked!.frame.zAxis, { x: 0, y: 0, z: 1 });
  });

  it('ignores vertices without a tolerance', () => {
    expect(nearestVertex(plate(), { x: 20, y: 0, z: 4 }, 0)).toBeNull();
    expect(nearestVertex(plate(), { x: 20, y: 0, z: 4 }, 1e-6)?.id).toBe(2);
  });

  it('falls back to the hit triangle for a surface with no exact data', () => {
    const topology: BodyTopology = {
      faces: [
        face('face_spline', 5, {
          surfaceType: 'BSPLINE_SURFACE',
          area: 1,
          center: { x: 0, y: 0, z: 0 }
        })
      ],
      edges: []
    };
    const picked = deriveJointFrame(topology, {
      kind: 'face',
      topologyId: 'face_spline',
      point: { x: 1, y: 2, z: 3 },
      normal: { x: 0, y: 2, z: 0 }
    });
    expect(picked?.source.kind).toBe('plane');
    expect(picked?.source.label).toContain('fitted');
    expectVector(picked!.frame.origin, { x: 1, y: 2, z: 3 });
    expectVector(picked!.frame.zAxis, { x: 0, y: 1, z: 0 });
  });

  it('refuses a hit with nothing to build a frame from', () => {
    expect(
      deriveJointFrame(undefined, { kind: 'body', point: { x: 0, y: 0, z: 0 } })
    ).toBeNull();
  });
});

describe('circle fitting', () => {
  it('recovers a tilted arc exactly enough to snap to', () => {
    const tilt = Math.PI / 6;
    const points: Vector3[] = [];
    for (let k = 0; k <= 16; k += 1) {
      const a = (k / 16) * (Math.PI / 2);
      const x = 4 * Math.cos(a);
      const y = 4 * Math.sin(a);
      points.push({
        x: 1 + x,
        y: 2 + y * Math.cos(tilt),
        z: 3 + y * Math.sin(tilt)
      });
    }
    const fitted = fitCircle(points);
    expect(fitted).not.toBeNull();
    expectVector(fitted!.center, { x: 1, y: 2, z: 3 }, 1e-9);
    expect(Math.abs(fitted!.radius - 4)).toBeLessThan(1e-9);
    const n = fitted!.axis;
    expect(
      Math.abs(Math.abs(n.y * -Math.sin(tilt) + n.z * Math.cos(tilt)) - 1)
    ).toBeLessThan(1e-9);
  });

  it('refuses samples that are not a circle', () => {
    expect(
      fitCircle([
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 }
      ])
    ).toBeNull();
    expect(
      fitCircle([
        { x: 0, y: 0, z: 0 },
        { x: 4, y: 0, z: 0 },
        { x: 4, y: 1, z: 0 },
        { x: 1, y: 3, z: 0 },
        { x: 0, y: 1, z: 0 }
      ])
    ).toBeNull();
  });
});
