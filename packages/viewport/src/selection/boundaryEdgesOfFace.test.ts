import { describe, expect, it } from 'vitest';
import type { BodyTopology, EdgeTopology } from '@openzcad/shared';
import { boundaryEdgesOfFace } from './boundaryEdgesOfFace';

const BORE_HASH = 30;

function edge(
  topologyId: string,
  adjacentFaceHashes: number[],
  options: Partial<EdgeTopology> = {}
): EdgeTopology {
  return {
    topologyId,
    hash: topologyId.length,
    adjacentFaceHashes,
    points: [],
    ...options
  };
}

const BORED_BOSS: BodyTopology = {
  faces: [
    {
      topologyId: 'top-annulus',
      hash: 10,
      triangleStart: 0,
      triangleCount: 2
    },
    {
      topologyId: 'bottom-annulus',
      hash: 20,
      triangleStart: 2,
      triangleCount: 2
    },
    {
      topologyId: 'bore-wall',
      hash: BORE_HASH,
      triangleStart: 4,
      triangleCount: 24,
      geometry: {
        surfaceType: 'cylinder',
        area: 16 * Math.PI,
        center: { x: 0, y: 0, z: 2 },
        radius: 2,
        diameter: 4,
        axisStart: { x: 0, y: 0, z: 0 },
        axisEnd: { x: 0, y: 0, z: 4 },
        axialLength: 4,
        featureType: 'through-hole',
        editableDimension: 'diameter'
      }
    }
  ],
  edges: [
    edge('top-bore-rim', [10, BORE_HASH], {
      curve: { type: 'CIRCLE' }
    }),
    edge('bottom-bore-rim', [20, BORE_HASH], {
      curve: { type: 'CIRCLE' }
    }),
    edge('bore-seam', [BORE_HASH, BORE_HASH], {
      displayRole: 'seam'
    }),
    edge('outer-top-rim', [10, 40], {
      curve: { type: 'CIRCLE' }
    }),
    edge('boss-fillet-rim', [40, 50], {
      curve: { type: 'CIRCLE' }
    })
  ]
};

describe('boundaryEdgesOfFace', () => {
  it('returns exactly the two physical circular rims of a bore wall', () => {
    const boundaries = boundaryEdgesOfFace(BORED_BOSS, BORE_HASH);

    expect(boundaries.map((candidate) => candidate.topologyId)).toEqual([
      'top-bore-rim',
      'bottom-bore-rim'
    ]);
    expect(
      boundaries.every((candidate) => candidate.curve?.type === 'CIRCLE')
    ).toBe(true);
  });

  it('returns no edges for an unknown face hash', () => {
    expect(boundaryEdgesOfFace(BORED_BOSS, 999)).toEqual([]);
  });
});
