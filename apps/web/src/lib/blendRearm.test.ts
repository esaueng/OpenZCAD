import { describe, expect, it } from 'vitest';
import { toBodyId, type BodyTopology } from '@openzcad/shared';
import { newBlendFacePick } from './blendRearm';

type Face = BodyTopology['faces'][number];

const bodyId = toBodyId('block');

function plane(hash: number): Face {
  return {
    topologyId: `plane:${hash}`,
    hash,
    triangleStart: 0,
    triangleCount: 2,
    geometry: { surfaceType: 'plane', area: 1, center: { x: 0, y: 0, z: 0 } }
  };
}

function blend(hash: number): Face {
  return {
    topologyId: `blend:${hash}`,
    hash,
    triangleStart: 0,
    triangleCount: 8,
    geometry: {
      surfaceType: 'cylinder',
      featureType: 'blend',
      area: 3,
      center: { x: 0, y: 0, z: 0 },
      centroid: { x: 2, y: 0, z: 5 },
      axisStart: { x: 0, y: 0, z: 0 },
      axisEnd: { x: 0, y: 0, z: 10 },
      radius: 2
    }
  };
}

describe('re-arming on a new fillet', () => {
  it('picks the blend face the commit created, facing out from its axis', () => {
    const pick = newBlendFacePick(
      bodyId,
      [plane(1), plane(2)],
      [plane(1), plane(2), blend(3)]
    );
    expect(pick).toEqual({
      selection: { bodyId, kind: 'face', topologyId: 'blend:3', hash: 3 },
      detail: { point: { x: 2, y: 0, z: 5 }, normal: { x: 1, y: 0, z: 0 } }
    });
  });

  it('ignores blend faces that existed before, and non-cylindrical blends', () => {
    const existing = blend(3);
    const torus: Face = {
      ...blend(4),
      geometry: { ...blend(4).geometry!, surfaceType: 'torus' }
    };
    expect(
      newBlendFacePick(
        bodyId,
        [plane(1), existing],
        [plane(1), existing, torus]
      )
    ).toBeNull();
  });

  it('is quiet with no topology to compare', () => {
    expect(newBlendFacePick(bodyId, undefined, undefined)).toBeNull();
  });
});
