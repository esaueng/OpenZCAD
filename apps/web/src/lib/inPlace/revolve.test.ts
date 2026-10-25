import { describe, expect, it } from 'vitest';
import type { PlaneBasis } from '@openzcad/geometry';
import type { FeatureId } from '@openzcad/shared';
import {
  clampRevolveAngle,
  revolveAxisCandidates,
  revolveHint,
  revolveProfileRegions,
  revolveRigPlacement,
  sketchAxisForLine
} from './revolve';

/** The Front (XZ) plane: u = +X, v = +Z, normal = −Y. */
const FRONT: PlaneBasis = {
  origin: { x: 0, y: 0, z: 0 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 0, z: 1 },
  normal: { x: 0, y: -1, z: 0 }
};

describe('revolve axis candidates', () => {
  it('offers the sketch axes first', () => {
    const candidates = revolveAxisCandidates(FRONT, undefined, String);
    expect(candidates.map((c) => c.id)).toEqual([
      'sketch-horizontal',
      'sketch-vertical'
    ]);
    expect(candidates[1]!.direction).toEqual({ x: 0, y: 0, z: 1 });
    expect(candidates[1]!.choice).toEqual({ axis: 'vertical' });
  });

  it('adds datum axes in the sketch plane and skips ones that leave it', () => {
    const candidates = revolveAxisCandidates(
      FRONT,
      {
        ['in' as FeatureId]: {
          origin: { x: 10, y: 0, z: 0 },
          direction: { x: 0, y: 0, z: 1 }
        },
        ['tilted' as FeatureId]: {
          origin: { x: 0, y: 0, z: 0 },
          direction: { x: 0, y: 1, z: 0 }
        },
        ['parallel-off' as FeatureId]: {
          origin: { x: 0, y: 5, z: 0 },
          direction: { x: 0, y: 0, z: 1 }
        }
      },
      (id) => `Axis ${id}`
    );
    expect(candidates.map((c) => c.id)).toEqual([
      'sketch-horizontal',
      'sketch-vertical',
      'datum:in'
    ]);
    expect(candidates[2]!.label).toBe('Axis in');
    expect(candidates[2]!.choice).toEqual({ datumFeatureId: 'in' });
  });
});

describe('a datum axis along a sketch axis', () => {
  it('stands in for that sketch axis instead of drawing over it', () => {
    const candidates = revolveAxisCandidates(
      FRONT,
      {
        ['z' as FeatureId]: {
          origin: { x: 0, y: 0, z: 5 },
          direction: { x: 0, y: 0, z: -1 }
        }
      },
      () => 'Axis 1'
    );
    expect(candidates.map((c) => c.id)).toEqual([
      'sketch-horizontal',
      'datum:z'
    ]);
  });
});

describe('a picked sketch line', () => {
  it('maps a line on the vertical axis to the vertical axis', () => {
    expect(sketchAxisForLine({ x: 0, y: 2 }, { x: 0, y: 9 })).toBe('vertical');
  });

  it('maps a line on the horizontal axis to the horizontal axis', () => {
    expect(sketchAxisForLine({ x: -3, y: 0 }, { x: 4, y: 0 })).toBe(
      'horizontal'
    );
  });

  it('refuses an off-axis or degenerate line', () => {
    expect(sketchAxisForLine({ x: 1, y: 0 }, { x: 1, y: 5 })).toBeNull();
    expect(sketchAxisForLine({ x: 0, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });
});

describe('angle handle placement', () => {
  const vertical = {
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 2 }
  };
  // A 10 × 12 rectangle from x = 14 to 24, z = 3 to 15, on Front.
  const outline = [
    { x: 14, y: 0, z: 3 },
    { x: 24, y: 0, z: 3 },
    { x: 24, y: 0, z: 15 },
    { x: 14, y: 0, z: 15 }
  ];

  it('centres on the axis level with the profile and points at it', () => {
    const placement = revolveRigPlacement(outline, vertical)!;
    expect(placement.center).toEqual({ x: 0, y: 0, z: 9 });
    expect(placement.axis).toEqual({ x: 0, y: 0, z: 1 });
    expect(placement.startDirection).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('draws just outside the farthest point of the profile', () => {
    expect(revolveRigPlacement(outline, vertical)!.radius).toBeCloseTo(
      24 * 1.15
    );
  });

  it('refuses a profile lying on the axis', () => {
    expect(
      revolveRigPlacement(
        [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 5 }
        ],
        vertical
      )
    ).toBeNull();
    expect(revolveRigPlacement([], vertical)).toBeNull();
  });
});

describe('the hint names the next step', () => {
  it('walks profile → axis → angle', () => {
    expect(revolveHint({ sketchId: null, axis: null })).toMatch(/profile/);
    expect(revolveHint({ sketchId: 's' as never, axis: null })).toMatch(/axis/);
    expect(
      revolveHint({
        sketchId: 's' as never,
        axis: revolveAxisCandidates(FRONT, undefined, String)[1]!
      })
    ).toMatch(/angle/);
  });
});

describe('revolve angles', () => {
  it('stay in the kernel range', () => {
    expect(clampRevolveAngle(0)).toBe(1e-3);
    expect(clampRevolveAngle(0.5)).toBe(0.5);
    expect(clampRevolveAngle(400)).toBe(360);
    expect(clampRevolveAngle(Number.NaN)).toBe(360);
    expect(clampRevolveAngle(270)).toBe(270);
  });
});

describe('the regions a pick names', () => {
  const regions = [
    { regionFingerprint: 1, sourceEntityIds: ['a', 'b'] },
    { regionFingerprint: 2, sourceEntityIds: ['c', 'd'] }
  ];

  it('finds a renumbered region again by its entities', () => {
    expect(
      revolveProfileRegions(regions, {
        regionFingerprint: 99,
        reference: { sourceEntityIds: ['d', 'c'] }
      }).map((region) => region.regionFingerprint)
    ).toEqual([2]);
  });

  it('keeps an exact fingerprint and spans every region for an entity-wide pick', () => {
    expect(
      revolveProfileRegions(regions, {
        regionFingerprint: 1,
        reference: { sourceEntityIds: ['c', 'd'] }
      }).map((region) => region.regionFingerprint)
    ).toEqual([1]);
    expect(
      revolveProfileRegions(regions, {
        reference: { all: true, sourceEntityIds: ['a'] }
      })
    ).toHaveLength(2);
  });
});
