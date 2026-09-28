import { describe, expect, it } from 'vitest';
import {
  toBodyId,
  type BodyRepresentation,
  type EdgeTopology,
  type FaceTopology,
  type Vector3
} from '@openzcad/shared';
import { planarFaceTravel } from './planarFaceTravel';

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
        surfaceType: 'plane',
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
