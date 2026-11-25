import { describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toBodyId,
  toUserId,
  type BodyRepresentation,
  type EdgeTopology,
  type FaceTopology,
  type Vector3
} from '@openzcad/shared';
import {
  FACE_SWEEP_BLOCKED,
  FACE_SWEEP_UNPROVEN,
  plainRefusal,
  withFaceSweepReading
} from '../refusalLanguage';
import { planFaceOffset } from './faceOffsetPlan';
import { planarFaceSweepClear, planarFaceTravel } from './planarFaceTravel';

/**
 * The limits are measured on the display mesh, so these build tiny meshes by
 * hand: a 10 × 10 × 2 plate whose top face (hash 1) is the one moved, and
 * whatever else each case needs around it. The kernel-backed counterpart on
 * the demo bracket lives in `test/bracket-face-offset.test.ts`.
 */

type Quad = [Vector3, Vector3, Vector3, Vector3];

interface FaceSpec {
  hash: number;
  quad: Quad;
  normal: Vector3;
  surfaceType?: 'plane' | 'bspline';
}

const v = (x: number, y: number, z: number): Vector3 => ({ x, y, z });

function horizontal(
  hash: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z: number,
  up: boolean
): FaceSpec {
  const quad: Quad = up
    ? [v(x0, y0, z), v(x1, y0, z), v(x1, y1, z), v(x0, y1, z)]
    : [v(x0, y0, z), v(x0, y1, z), v(x1, y1, z), v(x1, y0, z)];
  return { hash, quad, normal: v(0, 0, up ? 1 : -1) };
}

const TOP = horizontal(1, 0, 10, 0, 10, 2, true);
const BOTTOM = horizontal(2, 0, 10, 0, 10, 0, false);
const SIDE: FaceSpec = {
  hash: 3,
  quad: [v(0, 0, 0), v(10, 0, 0), v(10, 0, 2), v(0, 0, 2)],
  normal: v(0, -1, 0)
};

function body(
  faces: FaceSpec[],
  adjacency: Array<[number, number]> | null
): BodyRepresentation {
  const vertices: number[] = [];
  const indices: number[] = [];
  const topologyFaces: FaceTopology[] = [];
  for (const face of faces) {
    const base = vertices.length / 3;
    for (const corner of face.quad) {
      vertices.push(corner.x, corner.y, corner.z);
    }
    topologyFaces.push({
      topologyId: `face:${face.hash}`,
      hash: face.hash,
      triangleStart: indices.length / 3,
      triangleCount: 2,
      geometry: {
        surfaceType: face.surfaceType ?? 'plane',
        normal: face.normal,
        center: face.quad[0],
        area: 1
      }
    });
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const edges: EdgeTopology[] = (adjacency ?? [[1, 3]]).map(
    ([a, b], index) => ({
      topologyId: `edge:${index}`,
      hash: 1000 + index,
      points: [],
      ...(adjacency ? { adjacentFaceHashes: [a, b].sort() } : {})
    })
  );
  return {
    bodyId: toBodyId('body_travel'),
    name: 'Plate',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array(vertices),
      indices: new Uint32Array(indices)
    },
    faceCount: faces.length,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: 200,
    bbox: { min: v(0, 0, 0), max: v(10, 10, 2) },
    topology: { faces: topologyFaces, edges }
  };
}

function topOf(representation: BodyRepresentation): FaceTopology {
  return representation.topology!.faces.find((face) => face.hash === 1)!;
}

describe('planarFaceTravel', () => {
  it('reads the plate thickness behind the face, and nothing in front', () => {
    const plate = body(
      [TOP, BOTTOM, SIDE],
      [
        [1, 3],
        [2, 3]
      ]
    );
    expect(planarFaceTravel(plate, topOf(plate))).toMatchObject({
      inward: 2,
      outward: null
    });
  });

  it('stops outward travel at a nonadjacent face hanging over the footprint', () => {
    // A boss underside 3 above the top face, over part of it only.
    const plate = body(
      [TOP, BOTTOM, SIDE, horizontal(4, 2, 4, 2, 4, 5, false)],
      [
        [1, 3],
        [2, 3]
      ]
    );
    const travel = planarFaceTravel(plate, topOf(plate));
    expect(travel.inward).toBe(2);
    expect(travel.outward).toBeCloseTo(3, 9);
  });

  it('catches an obstacle whose corners all lie outside the footprint', () => {
    // A long bar crossing the whole plate: none of its vertices stand over
    // the face and no face vertex stands under it, only edge crossings.
    const plate = body(
      [TOP, BOTTOM, SIDE, horizontal(4, -5, 15, 4, 6, 7, false)],
      [
        [1, 3],
        [2, 3]
      ]
    );
    expect(planarFaceTravel(plate, topOf(plate)).outward).toBeCloseTo(5, 9);
  });

  it('ignores what does not overhang the face', () => {
    const plate = body(
      [TOP, BOTTOM, SIDE, horizontal(4, 12, 14, 2, 4, 5, false)],
      [
        [1, 3],
        [2, 3]
      ]
    );
    expect(planarFaceTravel(plate, topOf(plate)).outward).toBeNull();
  });

  it('ignores faces that share an edge with the moved face: they stretch', () => {
    const plate = body(
      [TOP, BOTTOM, SIDE, horizontal(4, 2, 4, 2, 4, 5, false)],
      [
        [1, 3],
        [2, 3],
        [1, 4]
      ]
    );
    expect(planarFaceTravel(plate, topOf(plate)).outward).toBeNull();
  });

  it('measures nothing without the kernel edge-to-face map', () => {
    const plate = body([TOP, BOTTOM, SIDE], null);
    expect(planarFaceTravel(plate, topOf(plate))).toMatchObject({
      inward: null,
      outward: null
    });
  });
});

describe('planarFaceSweepClear', () => {
  const ADJACENCY: Array<[number, number]> = [
    [1, 3],
    [2, 3]
  ];

  it('shows the path clear up to an overhang and blocked past it', () => {
    // An overhang 3 above the top face, over part of it.
    const plate = body(
      [TOP, BOTTOM, SIDE, horizontal(4, 2, 4, 2, 4, 5, false)],
      ADJACENCY
    );
    expect(planarFaceSweepClear(plate, topOf(plate), 2)).toBe(true);
    expect(planarFaceSweepClear(plate, topOf(plate), 2.9)).toBe(true);
    expect(planarFaceSweepClear(plate, topOf(plate), 4)).toBe(false);
    // Asked again after a farther answer: the same, from what was searched.
    expect(planarFaceSweepClear(plate, topOf(plate), 2)).toBe(true);
  });

  it('allows the mesh tolerance past the end of the move', () => {
    const plate = body(
      [TOP, BOTTOM, SIDE, horizontal(4, 2, 4, 2, 4, 5, false)],
      ADJACENCY
    );
    // 3 − 0.001 is within the 0.004 allowance of the overhang.
    expect(planarFaceSweepClear(plate, topOf(plate), 2.999)).toBe(false);
  });

  it('shows a path clear past something beside the face, however far', () => {
    const plate = body(
      [TOP, BOTTOM, SIDE, horizontal(4, 12, 14, 2, 4, 5, false)],
      ADJACENCY
    );
    expect(planarFaceSweepClear(plate, topOf(plate), 50)).toBe(true);
  });

  it('meets the far side of the body on an inward move', () => {
    const plate = body([TOP, BOTTOM, SIDE], ADJACENCY);
    expect(planarFaceSweepClear(plate, topOf(plate), -1)).toBe(true);
    expect(planarFaceSweepClear(plate, topOf(plate), -3)).toBe(false);
  });

  it('cannot say without the kernel edge-to-face map', () => {
    const plate = body([TOP, BOTTOM, SIDE], null);
    expect(planarFaceSweepClear(plate, topOf(plate), 1)).toBeNull();
  });

  it('sees a face just past the plane flatness allowance', () => {
    // 1.5 µm above and below the 10 mm face, whose allowance is 1 µm.
    const above = body(
      [TOP, BOTTOM, SIDE, horizontal(4, 2, 4, 2, 4, 2 + 1.5e-6, false)],
      ADJACENCY
    );
    expect(planarFaceSweepClear(above, topOf(above), 1)).toBe(false);
    const below = body(
      [TOP, BOTTOM, SIDE, horizontal(4, 2, 4, 2, 4, 2 - 1.5e-6, true)],
      ADJACENCY
    );
    expect(planarFaceSweepClear(below, topOf(below), -1)).toBe(false);
  });

  it('sees a face that rises through the slab from a shared corner', () => {
    // Touches the top face only at its corner (0, 0, 2) and climbs to 10
    // above it over the face: every sample is on the plane or past a 1 mm
    // move, yet the swept face meets it at once.
    const ramp: FaceSpec = {
      hash: 4,
      quad: [v(0, 0, 2), v(6, 0, 12), v(6, 6, 12), v(0, 6, 12)],
      normal: v(-0.857, 0, 0.514)
    };
    const plate = body([TOP, BOTTOM, SIDE, ramp], ADJACENCY);
    expect(planarFaceSweepClear(plate, topOf(plate), 1)).toBe(false);
  });
});

/**
 * The captured refusal (offset-face-refused-20261124231418731): a filleted
 * top face pushed 10 mm beside an M24 threaded bore. The kernel's footprint
 * check compares bounding boxes, the thread's box overlapped the face's, and
 * the move was refused with the thread about 22 mm from the face. The
 * capture is user data and stays out of the repository; this stands in for
 * it with the same shape on the display mesh: a plate, and beside it a ring
 * of freeform patches whose box reaches over the plate's corner while no
 * patch stands over the plate.
 */
describe('a refused face move beside a thread', () => {
  const KERNEL =
    'offset: move-face would change topology at face Some(Id(11608)), edge None: swept face reaches nonadjacent face 11744 before completing the move';

  /** Twelve vertical patches around an axis just off the plate's corner. */
  function thread(): FaceSpec[] {
    const axis = { x: -3, y: -3 };
    const radius = 3.5;
    return Array.from({ length: 12 }, (_, index) => {
      const a0 = (index / 12) * 2 * Math.PI;
      const a1 = ((index + 1) / 12) * 2 * Math.PI;
      const at = (angle: number, z: number) =>
        v(
          axis.x + radius * Math.cos(angle),
          axis.y + radius * Math.sin(angle),
          z
        );
      const mid = (a0 + a1) / 2;
      return {
        hash: 100 + index,
        quad: [at(a0, -4), at(a1, -4), at(a1, 12), at(a0, 12)],
        normal: v(-Math.cos(mid), -Math.sin(mid), 0),
        surfaceType: 'bspline'
      };
    });
  }

  function refusalFor(faces: FaceSpec[], offset: number) {
    const representation = body(faces, [
      [1, 3],
      [2, 3]
    ]);
    const document = createProjectDocument(
      'Thread stand-in',
      toUserId('user_thread_stand_in')
    );
    document.derived = {
      ...document.derived,
      bodyRepresentations: { [representation.bodyId]: representation }
    };
    const face = topOf(representation);
    const plan = planFaceOffset({
      document,
      bodyId: representation.bodyId,
      face,
      faceHash: face.hash,
      offset,
      localOnly: true
    });
    expect(plan?.kind).toBe('direct-edit');
    const sweepReading =
      plan?.kind === 'direct-edit' ? plan.sweepReading : undefined;
    return withFaceSweepReading(plainRefusal(KERNEL), sweepReading);
  }

  it('says the kernel could not prove a move the mesh shows clear', () => {
    const refusal = refusalFor([TOP, BOTTOM, SIDE, ...thread()], 10);
    expect(refusal.message).toBe(FACE_SWEEP_UNPROVEN);
    // The kernel's words, as the activity log records them, are untouched.
    expect(refusal.detail).toBe(KERNEL);
  });

  it('keeps the collision sentence and its estimate for a real obstruction', () => {
    const overhang = horizontal(4, 2, 4, 2, 4, 5, false);
    const refusal = refusalFor([TOP, BOTTOM, SIDE, overhang, ...thread()], 10);
    expect(refusal.message).toBe(FACE_SWEEP_BLOCKED);
    expect(refusal.detail).toBe(
      'The display mesh suggests another part of the body about 3 mm in front of this face.\n' +
        KERNEL
    );
  });

  it('keeps the collision sentence on a body with no curved faces to blame', () => {
    const refusal = refusalFor([TOP, BOTTOM, SIDE], 10);
    expect(refusal.message).toBe(FACE_SWEEP_BLOCKED);
    expect(refusal.detail).toBe(KERNEL);
  });
});
