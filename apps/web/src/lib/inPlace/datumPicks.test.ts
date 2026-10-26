import { describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toBodyId,
  toUserId,
  type BodyRepresentation,
  type EdgeTopologyReferenceV5,
  type FaceTopologyReferenceV5,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  edgeAxisLine,
  edgeDirection,
  faceAxisLine,
  faceNormal
} from './datumPicks';

/**
 * U09: the lines and directions a model pick gives a turn, a ring or a
 * linear pattern, read from the published topology alone.
 */

const BODY = toBodyId('body_block');

const straight: EdgeTopologyReferenceV5 = {
  kind: 'edge',
  producingFeatureId: 'feat_block' as FeatureId,
  lineageName: 'edge.side',
  currentHash: 11,
  witnessVersion: 1,
  witness: {
    curveType: 'LINE',
    length: 20_000_000,
    closed: false,
    // Quantized at 1e-6 mm: (20, 0, 20) to (20, 0, 0), end 0 sorting first.
    endpoints: [
      [20_000_000, 0, 20_000_000],
      [20_000_000, 0, 0]
    ],
    midpoint: [20_000_000, 0, 10_000_000]
  }
};
const post: FaceTopologyReferenceV5 = {
  kind: 'face',
  producingFeatureId: 'feat_post' as FeatureId,
  lineageName: 'face.side',
  currentHash: 21,
  witnessVersion: 1,
  witness: {
    surfaceType: 'cylinder',
    perimeter: 1,
    centroid: null,
    analytic: { kind: 'none' },
    closure: { u: 'closed', v: 'open' }
  }
};

function document(): ProjectDocument {
  const base = createProjectDocument('Picks', toUserId('user_picks'));
  const body = {
    bodyId: BODY,
    name: 'Block',
    topology: {
      faces: [
        {
          topologyId: 'f1',
          hash: 21,
          reference: post,
          triangleStart: 0,
          triangleCount: 0,
          geometry: {
            surfaceType: 'cylinder',
            area: 1,
            center: { x: 0, y: 0, z: 0 },
            // Running down: the axis comes out canonical (+Z) all the same.
            axisStart: { x: 5, y: 5, z: 10 },
            axisEnd: { x: 5, y: 5, z: 0 }
          }
        },
        {
          topologyId: 'f2',
          hash: 22,
          triangleStart: 0,
          triangleCount: 0,
          geometry: {
            surfaceType: 'plane',
            area: 1,
            center: { x: 0, y: 0, z: 0 },
            normal: { x: 0, y: -1, z: 0 }
          }
        }
      ],
      edges: [
        {
          topologyId: 'e1',
          hash: 11,
          reference: straight,
          points: [20, 0, 0, 20, 0, 10, 20, 0, 20]
        },
        // No lineage: still a direction, never an axis.
        { topologyId: 'e2', hash: 12, points: [0, 0, 0, 3, 4, 0] },
        {
          topologyId: 'e3',
          hash: 13,
          points: [0, 0, 0, 1, 1, 0, 2, 0, 0]
        }
      ]
    }
  } as unknown as BodyRepresentation;
  return {
    ...base,
    derived: { ...base.derived, bodyRepresentations: { [BODY]: body } }
  };
}

const pick = (kind: 'edge' | 'face', hash: number) => ({
  kind,
  bodyId: BODY,
  topologyId: `${kind[0]}${hash}`,
  hash
});

describe('model picks as axes and directions', () => {
  it('a straight edge is an axis from its end 0, defined as that edge', () => {
    const line = edgeAxisLine(document(), pick('edge', 11));
    if ('reason' in line) throw new Error(line.reason);
    expect(line.origin).toEqual({ x: 20, y: 0, z: 0 });
    expect(line.direction).toEqual({ x: 0, y: 0, z: 1 });
    expect(line.choice).toEqual({
      define: {
        kind: 'edge',
        source: { type: 'edge', bodyId: BODY, edgeReference: straight }
      }
    });
    // An edge with no lineage cannot be followed by an axis.
    expect(edgeAxisLine(document(), pick('edge', 12))).toHaveProperty(
      'reason'
    );
  });

  it("a cylinder's axis runs through its span's middle, canonically", () => {
    const line = faceAxisLine(document(), pick('face', 21));
    if ('reason' in line) throw new Error(line.reason);
    expect(line.origin).toEqual({ x: 5, y: 5, z: 5 });
    expect(Math.abs(line.direction.x)).toBe(0);
    expect(Math.abs(line.direction.y)).toBe(0);
    expect(line.direction.z).toBe(1);
    expect(line.choice).toMatchObject({ define: { kind: 'cylinder' } });
    expect(faceAxisLine(document(), pick('face', 22))).toHaveProperty(
      'reason'
    );
  });

  it('a direction is a straight edge or a flat face’s normal', () => {
    expect(edgeDirection(document(), pick('edge', 12))).toEqual({
      x: 0.6,
      y: 0.8,
      z: 0
    });
    expect(edgeDirection(document(), pick('edge', 13))).toEqual({
      reason: 'A direction runs along a straight edge; this edge is curved.'
    });
    expect(faceNormal(document(), pick('face', 22))).toEqual({
      x: 0,
      y: -1,
      z: 0
    });
    expect(faceNormal(document(), pick('face', 21))).toHaveProperty('reason');
  });
});
