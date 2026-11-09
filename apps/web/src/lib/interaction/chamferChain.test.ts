import { describe, expect, it } from 'vitest';
import {
  toBodyId,
  type BodyRepresentation,
  type EdgeTopology,
  type TopologySelection
} from '@openzcad/shared';
import { faceBoundaryEdges, outlineChamferChain } from './chamferChain';
const bodyId = toBodyId('chain-body');
const edge = (index: number, support = 10): EdgeTopology => ({
  hash: index,
  topologyId: `e${index}`,
  length: 1,
  points: [index, 0, 0, index + 1, 0, 0],
  vertexIds: [index, index + 1],
  adjacentFaceHashes: [support, 20],
  curve: { type: 'LINE' }
});
const picked: TopologySelection = {
  kind: 'edge',
  bodyId,
  hash: 0,
  topologyId: 'e0'
};
function body(
  normalZ = -1,
  lastSupport = 10,
  surfaceType = 'plane',
  extraEdges: EdgeTopology[] = []
) {
  return {
    bodyId,
    topology: {
      edges: [edge(0), edge(1, lastSupport), ...extraEdges],
      faces: [
        {
          hash: 10,
          topologyId: 'bottom',
          triangleStart: 0,
          triangleCount: 0,
          geometry: {
            surfaceType,
            area: 2,
            center: { x: 0, y: 0, z: 0 },
            normal: { x: 0, y: 0, z: normalZ }
          }
        }
      ]
    }
  } as BodyRepresentation;
}
describe('single-pick outline chamfer', () => {
  it('takes the shared lower planar run', () =>
    expect(outlineChamferChain(body(), picked).map((e) => e.hash)).toEqual([
      0, 1
    ]));
  // The recording that asked for this: the bottom was the case it was built
  // for, but a top rim is the same request and used to stay one edge.
  it('takes a top or side outline the same way', () => {
    expect(outlineChamferChain(body(1), picked).map((e) => e.hash)).toEqual([
      0, 1
    ]);
    expect(outlineChamferChain(body(0), picked).map((e) => e.hash)).toEqual([
      0, 1
    ]);
  });
  it('keeps a run on a curved support local', () =>
    expect(outlineChamferChain(body(-1, 10, 'cylinder'), picked)).toEqual([
      picked
    ]));
  it('does not let a smooth run leave its common support', () =>
    expect(outlineChamferChain(body(-1, 30), picked)).toEqual([picked]));
  it('keeps a missing projection local', () =>
    expect(outlineChamferChain(undefined, picked)).toEqual([picked]));
});

describe('edges around a picked face', () => {
  const face = { bodyId, topologyId: 'bottom', hash: 10 };
  it('takes every edge bounding the face, with its identities', () => {
    const edges = faceBoundaryEdges(body(), face);
    expect(edges.map((e) => [e.kind, e.topologyId, e.hash])).toEqual([
      ['edge', 'e0', 0],
      ['edge', 'e1', 1]
    ]);
    expect(edges.every((e) => e.bodyId === bodyId)).toBe(true);
  });
  it('finds the face by hash when the pick has no topology id', () =>
    expect(
      faceBoundaryEdges(body(), { bodyId, hash: 10 }).map((e) => e.hash)
    ).toEqual([0, 1]));
  it('leaves out edges of other faces, seams and tangent boundaries', () => {
    const seam = { ...edge(2), displayRole: 'seam' as const };
    const smooth = { ...edge(3), isSmooth: true };
    const elsewhere = edge(4, 30);
    expect(
      faceBoundaryEdges(
        body(-1, 30, 'plane', [seam, smooth, elsewhere]),
        face
      ).map((e) => e.hash)
    ).toEqual([0]);
  });
  it('is empty for an unknown face or a missing projection', () => {
    expect(faceBoundaryEdges(body(), { bodyId, topologyId: 'nope' })).toEqual(
      []
    );
    expect(faceBoundaryEdges(undefined, face)).toEqual([]);
  });
});
