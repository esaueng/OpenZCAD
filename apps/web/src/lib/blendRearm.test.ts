import { describe, expect, it } from 'vitest';
import { toBodyId, toFeatureId, type BodyTopology } from '@openzcad/shared';
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
      [plane(1), plane(2), blend(3)],
      'fillet-1'
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
        [plane(1), existing, torus],
        'fillet-2'
      )
    ).toBeNull();
  });

  // QA 2026-11-14 finding #10: Fillet 4 landed beside Fillet 3, trimming
  // Fillet 3's band to a new hash, and that band was re-armed instead.
  describe('beside an earlier fillet', () => {
    function named(face: Face, featureId: string, lineageName: string): Face {
      return {
        ...face,
        reference: {
          kind: 'face',
          producingFeatureId: toFeatureId(featureId),
          lineageName
        } as Face['reference']
      };
    }
    function along(face: Face, x: number, radius = 2): Face {
      return {
        ...face,
        geometry: {
          ...face.geometry!,
          centroid: { x: x + radius, y: 0, z: 5 },
          axisStart: { x, y: 0, z: 0 },
          axisEnd: { x, y: 0, z: 10 },
          radius,
          blendRadius: radius
        }
      };
    }
    const earlierBand = 'modifier.fillet.face.band-between.a|b';

    it('re-arms the new fillet, not the earlier band it trimmed', () => {
      const before = [
        plane(1),
        named(along(blend(3), 0, 3), 'fillet-3', earlierBand)
      ];
      // The trimmed band: same identity and carrier, new hash, listed first.
      const trimmed = named(along(blend(30), 0, 3), 'fillet-3', earlierBand);
      const created = named(
        along(blend(4), 20),
        'fillet-4',
        'modifier.fillet.face.band-between.b|c'
      );
      const pick = newBlendFacePick(
        bodyId,
        before,
        [plane(1), trimmed, created],
        'fillet-4'
      );
      expect(pick?.selection.hash).toBe(4);
    });

    it("picks nothing rather than another feature's band", () => {
      const before = [
        plane(1),
        named(along(blend(3), 0, 3), 'fillet-3', earlierBand)
      ];
      const trimmed = named(along(blend(30), 0, 3), 'fillet-3', earlierBand);
      // The new fillet made only a corner patch: nothing of its own to pick.
      expect(
        newBlendFacePick(bodyId, before, [plane(1), trimmed], 'fillet-4')
      ).toBeNull();
    });

    it('rules out a hash-only band left on an earlier carrier', () => {
      // A shelled or fused body publishes no names: the trimmed band keeps
      // only its carrier, the same radius about the same axis line.
      const before = [plane(1), along(blend(3), 0, 3)];
      const trimmed: Face = {
        ...along(blend(30), 0, 3),
        geometry: {
          ...along(blend(30), 0, 3).geometry!,
          axisStart: { x: 0, y: 0, z: 2 },
          axisEnd: { x: 0, y: 0, z: 7 }
        }
      };
      const created = along(blend(4), 20);
      expect(
        newBlendFacePick(
          bodyId,
          before,
          [plane(1), trimmed, created],
          'fillet-4'
        )?.selection.hash
      ).toBe(4);
      expect(
        newBlendFacePick(bodyId, before, [plane(1), trimmed], 'fillet-4')
      ).toBeNull();
    });

    it('keeps a band the new fillet names even on an earlier carrier', () => {
      const before = [plane(1), along(blend(3), 0, 2)];
      const created = named(
        along(blend(4), 0, 2),
        'fillet-4',
        'modifier.fillet.face.band-between.b|c'
      );
      expect(
        newBlendFacePick(bodyId, before, [plane(1), created], 'fillet-4')
          ?.selection.hash
      ).toBe(4);
    });
  });

  it('is quiet with no topology to compare', () => {
    expect(
      newBlendFacePick(bodyId, undefined, undefined, 'fillet-1')
    ).toBeNull();
  });
});
