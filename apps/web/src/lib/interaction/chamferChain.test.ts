import { describe, expect, it } from 'vitest';
import {
  toBodyId,
  type BodyRepresentation,
  type EdgeTopology,
  type TopologySelection
} from '@openzcad/shared';
import { bottomChamferChain } from './chamferChain';
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
function body(normalZ = -1, lastSupport = 10) {
  return {
    bodyId,
    topology: {
      edges: [edge(0), edge(1, lastSupport)],
      faces: [
        {
          hash: 10,
          topologyId: 'bottom',
          triangleStart: 0,
          triangleCount: 0,
          geometry: {
            surfaceType: 'plane',
            area: 2,
            center: { x: 0, y: 0, z: 0 },
            normal: { x: 0, y: 0, z: normalZ }
          }
        }
      ]
    }
  } as BodyRepresentation;
}
describe('single-pick bottom chamfer outline', () => {
  it('takes the shared lower planar run', () =>
    expect(bottomChamferChain(body(), picked).map((e) => e.hash)).toEqual([
      0, 1
    ]));
  it('keeps a top/end pick local', () =>
    expect(bottomChamferChain(body(1), picked)).toEqual([picked]));
  it('does not let a smooth run leave its common support', () =>
    expect(bottomChamferChain(body(-1, 30), picked)).toEqual([picked]));
  it('keeps a missing projection local', () =>
    expect(bottomChamferChain(undefined, picked)).toEqual([picked]));
});
