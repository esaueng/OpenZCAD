import { describe, expect, it } from 'vitest';
import { toBodyId, toFeatureId } from '@openzcad/shared';
import type { BodyRepresentation } from '@openzcad/shared';
import {
  refreshEdgeReferenceForCommit,
  refreshFaceReferenceForCommit
} from './topologyResolution';

const bodyId = toBodyId('body_commit');
const producer = toFeatureId('feature_boolean');

function bodyWith(
  faces: NonNullable<BodyRepresentation['topology']>['faces'],
  edges: NonNullable<BodyRepresentation['topology']>['edges']
): BodyRepresentation {
  return {
    bodyId,
    name: 'Fuse',
    source: 'boolean',
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array(),
      indices: new Uint32Array()
    },
    faceCount: faces.length,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: 1,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    topology: { faces, edges }
  } as unknown as BodyRepresentation;
}

function edgeReference(lineageName: string, currentHash: number) {
  return {
    kind: 'edge' as const,
    producingFeatureId: producer,
    lineageName,
    currentHash,
    witnessVersion: 1 as const,
    witness: {
      curveType: 'LINE',
      length: 10,
      closed: false,
      endpoints: [
        [0, 0, 0],
        [10_000_000, 0, 0]
      ]
    }
  } as never;
}

function faceReference(lineageName: string, currentHash: number) {
  return {
    kind: 'face' as const,
    producingFeatureId: producer,
    lineageName,
    currentHash,
    witnessVersion: 1 as const,
    witness: {}
  } as never;
}

describe('commit-time reference refresh', () => {
  it('reads the current boolean.edge.* name for a hash-only pick', () => {
    const currentEdge = {
      topologyId: 'edge-7',
      hash: 77,
      reference: edgeReference('boolean.edge.fuse.7', 77)
    };
    const body = bodyWith([], [currentEdge as never]);
    const refreshed = refreshEdgeReferenceForCommit(body, {
      topologyId: 'edge-7',
      hash: 77
    });
    expect(refreshed?.lineageName).toBe('boolean.edge.fuse.7');
  });

  it('fails closed to the stale reference on ambiguity', () => {
    const stale = edgeReference('boolean.edge.fuse.7', 77);
    // Two edges share the hash: choosing would be a guess.
    const body = bodyWith(
      [],
      [
        { topologyId: 'edge-7', hash: 77, reference: stale },
        { topologyId: 'edge-8', hash: 77, reference: stale }
      ] as never
    );
    const refreshed = refreshEdgeReferenceForCommit(body, {
      topologyId: 'edge-7',
      hash: 77,
      reference: stale
    });
    expect(refreshed).toBe(stale);
  });

  it('keeps hash-only when the current topology names nothing', () => {
    const body = bodyWith(
      [],
      [{ topologyId: 'edge-7', hash: 77 } as never]
    );
    const refreshed = refreshEdgeReferenceForCommit(body, {
      topologyId: 'edge-7',
      hash: 77
    });
    expect(refreshed).toBeUndefined();
  });

  it('refreshes face references the same way', () => {
    const currentFace = {
      topologyId: 'face-3',
      hash: 33,
      reference: faceReference('boolean.face.carrier.3', 33)
    };
    const body = bodyWith([currentFace as never], []);
    const refreshed = refreshFaceReferenceForCommit(body, {
      topologyId: 'face-3',
      hash: 33
    });
    expect(refreshed?.lineageName).toBe('boolean.face.carrier.3');
  });
});
