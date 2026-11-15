import { describe, expect, it } from 'vitest';
import {
  SHEET_METAL_GAUGE_TABLES,
  SHEET_METAL_MATERIAL_PRESETS,
  applyAffine,
  bendAllowance,
  bendDeduction,
  bendZoneStart,
  bentZoneVolume,
  composeAffine,
  din6935KFactor,
  flatLengthFromOutsideFlanges,
  insideSetback,
  materialPresetById,
  minimumFlangeLength,
  outsideSetback,
  resolveKFactor,
  rotationAbout,
  sheetMetalBendMetrics,
  sheetMetalFold,
  sheetMetalGaugeById,
  sheetMetalMaterialById,
  type SheetMetalVec3
} from '@openzcad/shared';

const RIGHT = Math.PI / 2;

function expectPoint(actual: SheetMetalVec3, expected: SheetMetalVec3): void {
  expect(actual[0]).toBeCloseTo(expected[0], 9);
  expect(actual[1]).toBeCloseTo(expected[1], 9);
  expect(actual[2]).toBeCloseTo(expected[2], 9);
}

describe('bend arithmetic', () => {
  it('matches hand-computed values for a 90° bend, R = T = 1, K = 0.5', () => {
    expect(bendAllowance(RIGHT, 1, 1, 0.5)).toBeCloseTo(
      (Math.PI / 2) * 1.5,
      12
    );
    expect(outsideSetback(RIGHT, 1, 1)).toBeCloseTo(2, 12);
    expect(insideSetback(RIGHT, 1)).toBeCloseTo(1, 12);
    expect(bendDeduction(RIGHT, 1, 1, 0.5)).toBeCloseTo(
      4 - (Math.PI / 2) * 1.5,
      12
    );
  });

  it('lays out a 50 × 50 L bracket (T 2, R 2, K 0.44) from a 96.5239 blank', () => {
    const metrics = sheetMetalBendMetrics(RIGHT, 2, 2, 0.44);
    expect(metrics.bendAllowance).toBeCloseTo((Math.PI / 2) * 2.88, 12);
    expect(metrics.outsideSetback).toBeCloseTo(4, 12);
    expect(flatLengthFromOutsideFlanges([50, 50], [metrics])).toBeCloseTo(
      96.5239,
      4
    );
  });

  it('places the zone for each bend position', () => {
    const m = sheetMetalBendMetrics(RIGHT, 2, 2, 0.44);
    expect(bendZoneStart('centerline', m)).toBeCloseTo(
      -m.bendAllowance / 2,
      12
    );
    expect(bendZoneStart('fixed-side', m)).toBeCloseTo(-m.bendAllowance, 12);
    expect(bendZoneStart('moving-side', m)).toBe(0);
    expect(bendZoneStart('outside-mold-line', m)).toBeCloseTo(-4, 12);
    const hem = sheetMetalBendMetrics(Math.PI, 1, 1, 0.44);
    expect(hem.outsideSetback).toBe(Number.POSITIVE_INFINITY);
    expect(() => bendZoneStart('outside-mold-line', hem)).toThrow(
      /at most 179/
    );
    expect(bendZoneStart('centerline', hem)).toBeCloseTo(
      -hem.bendAllowance / 2,
      12
    );
    expect(() => flatLengthFromOutsideFlanges([50, 50], [hem])).toThrow(
      /180° bend/
    );
  });

  it('refuses out-of-range inputs', () => {
    expect(() => bendAllowance(0, 1, 1, 0.4)).toThrow(RangeError);
    expect(() => bendAllowance(Math.PI + 0.01, 1, 1, 0.4)).toThrow(RangeError);
    expect(() => bendAllowance(RIGHT, 0, 1, 0.4)).toThrow(/Inside radius/);
    expect(() => bendAllowance(RIGHT, 1, -1, 0.4)).toThrow(/Thickness/);
    expect(() => bendAllowance(RIGHT, 1, 1, 1)).toThrow(/K-factor/);
    expect(() => bendAllowance(RIGHT, 1, 1, Number.NaN)).toThrow(/K-factor/);
    expect(() => flatLengthFromOutsideFlanges([1, 2], [])).toThrow(/n \+ 1/);
  });

  it('computes DIN 6935 K-factors within [0.25, 0.5]', () => {
    expect(din6935KFactor(1, 1)).toBeCloseTo(0.325, 12);
    expect(din6935KFactor(5, 1)).toBe(0.5);
    expect(din6935KFactor(20, 1)).toBe(0.5);
    expect(din6935KFactor(0.1, 1)).toBe(0.25);
    expect(din6935KFactor(2, 1)).toBeCloseTo(
      0.5 * (0.65 + 0.5 * Math.log10(2)),
      12
    );
    expect(resolveKFactor('din-6935', 0.9, 1, 1)).toBeCloseTo(0.325, 12);
    expect(resolveKFactor('value', undefined, 1, 1)).toBe(0.44);
    expect(resolveKFactor('value', 0.38, 1, 1)).toBe(0.38);
    expect(() => resolveKFactor('value', 0, 1, 1)).toThrow(/K-factor/);
  });

  it('gives the bent zone volume between the inside and outside cylinders', () => {
    const r = 2;
    const t = 1;
    const expected = (RIGHT / 2) * ((r + t) ** 2 - r ** 2) * 10;
    expect(bentZoneVolume(RIGHT, r, t, 10)).toBeCloseTo(expected, 12);
    expect(minimumFlangeLength(1)).toBeCloseTo(5.6, 12);
  });
});

describe('affine helpers', () => {
  it('rotates about an offset axis and composes in order', () => {
    const turn = rotationAbout([1, 0, 0], [0, 0, 1], RIGHT);
    expectPoint(applyAffine(turn, [2, 0, 0]), [1, 1, 0]);
    const twice = composeAffine(turn, turn);
    expectPoint(applyAffine(twice, [2, 0, 0]), [0, 0, 0]);
  });
});

describe('fold kinematics', () => {
  // The L bracket of the spec: blank along +x, plate z ∈ [0, 2], centre-line
  // bend at x = 48.26195 so the fixed flange's outside reaches x = 50.
  const thickness = 2;
  const radius = 2;
  const metrics = sheetMetalBendMetrics(RIGHT, radius, thickness, 0.44);
  const blankLength = flatLengthFromOutsideFlanges([50, 50], [metrics]);
  const s0 = bendZoneStart('centerline', metrics);
  const lineX = 50 - metrics.outsideSetback - s0;

  const upFold = sheetMetalFold({
    linePoint: [lineX, 0, 0],
    movingNormal: [1, 0, 0],
    zoneStart: s0,
    metrics,
    direction: 'up',
    plateBottom: 0
  });

  it('folds the far end of an up bend to a 50 × 50 outside L', () => {
    expect(lineX + s0).toBeCloseTo(46, 9);
    expectPoint(upFold.axisPoint, [46, 0, 4]);
    expectPoint(upFold.axisDirection, [0, -1, 0]);
    // Far bottom (outside) corner: outside face at x = 50, top of flange at z = 50.
    expectPoint(upFold.mapPoint([blankLength, 3, 0]), [50, 3, 50]);
    // Far top (inside) corner: inside face at x = 48.
    expectPoint(upFold.mapPoint([blankLength, 3, 2]), [48, 3, 50]);
  });

  it('keeps the fixed side and is continuous at both zone edges', () => {
    expectPoint(upFold.mapPoint([10, 1, 1]), [10, 1, 1]);
    const zoneEnd = 46 + metrics.bendAllowance;
    for (const z of [0, 0.7, 2]) {
      const inside = upFold.mapPoint([zoneEnd - 1e-12, 0, z]);
      const beyond = upFold.mapPoint([zoneEnd + 1e-12, 0, z]);
      expectPoint(inside, beyond);
      expectPoint(upFold.mapPoint([46 + 1e-12, 0, z]), [46, 0, z]);
    }
  });

  it('keeps the neutral fibre length through the zone', () => {
    const neutralZ = thickness - 0.44 * thickness; // inside is the top for an up bend
    let length = 0;
    let previous = upFold.mapPoint([46, 0, neutralZ]);
    const steps = 2000;
    for (let i = 1; i <= steps; i += 1) {
      const next = upFold.mapPoint([
        46 + (metrics.bendAllowance * i) / steps,
        0,
        neutralZ
      ]);
      length += Math.hypot(
        next[0] - previous[0],
        next[1] - previous[1],
        next[2] - previous[2]
      );
      previous = next;
    }
    expect(length).toBeCloseTo(metrics.bendAllowance, 5);
    // The inside surface lies on the inside radius.
    const mid = upFold.mapPoint([46 + metrics.bendAllowance / 2, 0, thickness]);
    expect(Math.hypot(mid[0] - 46, mid[2] - 4)).toBeCloseTo(radius, 9);
  });

  it('mirrors a down bend below the plate', () => {
    const down = sheetMetalFold({
      linePoint: [lineX, 0, 0],
      movingNormal: [1, 0, 0],
      zoneStart: s0,
      metrics,
      direction: 'down',
      plateBottom: 0
    });
    expectPoint(down.axisPoint, [46, 0, -2]);
    expect(down.signedAngle).toBeCloseTo(-RIGHT, 12);
    // Outside is now the top face: it reaches x = 50 and the flange runs to z = -48.
    expectPoint(down.mapPoint([blankLength, 0, 2]), [50, 0, -48]);
    expectPoint(down.mapPoint([blankLength, 0, 0]), [48, 0, -48]);
  });

  it('follows the moving normal in any in-plane direction', () => {
    const diagonal: SheetMetalVec3 = [Math.SQRT1_2, Math.SQRT1_2, 0];
    const fold = sheetMetalFold({
      linePoint: [0, 0, 0],
      movingNormal: diagonal,
      zoneStart: 0,
      metrics,
      direction: 'up',
      plateBottom: 0
    });
    const far = 20 + metrics.bendAllowance;
    const folded = fold.mapPoint([far * Math.SQRT1_2, far * Math.SQRT1_2, 0]);
    // Outside face: R + T from the axis, 20 up from the axis height.
    expect(folded[0] * Math.SQRT1_2 + folded[1] * Math.SQRT1_2).toBeCloseTo(
      4,
      9
    );
    expect(folded[2]).toBeCloseTo(24, 9);
  });

  it('opens the radius for a partial fold and refuses bad fractions', () => {
    const half = sheetMetalFold({
      linePoint: [lineX, 0, 0],
      movingNormal: [1, 0, 0],
      zoneStart: s0,
      metrics,
      direction: 'up',
      plateBottom: 0,
      fraction: 0.5
    });
    expect(half.signedAngle).toBeCloseTo(RIGHT / 2, 12);
    expect(half.effectiveInsideRadius).toBeCloseTo(
      metrics.bendAllowance / (RIGHT / 2) - 0.44 * thickness,
      12
    );
    expect(half.effectiveInsideRadius).toBeGreaterThan(radius);
    expect(() =>
      sheetMetalFold({
        linePoint: [0, 0, 0],
        movingNormal: [1, 0, 0],
        zoneStart: 0,
        metrics,
        direction: 'up',
        plateBottom: 0,
        fraction: 0
      })
    ).toThrow(/fraction/);
    expect(() =>
      sheetMetalFold({
        linePoint: [0, 0, 0],
        movingNormal: [1, 0, 0.1],
        zoneStart: 0,
        metrics,
        direction: 'up',
        plateBottom: 0
      })
    ).toThrow(/unit in-plane/);
  });

  it('chains two bends into a U channel through the parent transform', () => {
    // 20-wide base, two 90° up bends on either side, flanges 20 high outside.
    const m = sheetMetalBendMetrics(RIGHT, 1, 1, 0.5);
    const left = sheetMetalFold({
      linePoint: [0, 0, 0],
      movingNormal: [-1, 0, 0],
      zoneStart: 0,
      metrics: m,
      direction: 'up',
      plateBottom: 0
    });
    const right = sheetMetalFold({
      linePoint: [20, 0, 0],
      movingNormal: [1, 0, 0],
      zoneStart: 0,
      metrics: m,
      direction: 'up',
      plateBottom: 0
    });
    const leftTip = left.mapPoint([-(m.bendAllowance + 10), 0, 0]);
    const rightTip = right.mapPoint([20 + m.bendAllowance + 10, 0, 0]);
    // Both outside faces stand R + T beyond the tangent lines, rising to z = 2 + 10.
    expectPoint(leftTip, [-2, 0, 12]);
    expectPoint(rightTip, [22, 0, 12]);
  });
});

describe('presets', () => {
  it('links materials to existing density presets and their gauge tables', () => {
    for (const material of SHEET_METAL_MATERIAL_PRESETS) {
      if (material.densityPresetId) {
        expect(materialPresetById(material.densityPresetId)).not.toBeNull();
      }
      expect(
        SHEET_METAL_GAUGE_TABLES[material.gaugeTableId].length
      ).toBeGreaterThan(0);
      expect(material.minInsideRadiusOverT).toBeGreaterThan(0);
      expect(sheetMetalMaterialById(material.id)).toBe(material);
    }
    const ids = SHEET_METAL_MATERIAL_PRESETS.map((material) => material.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('converts gauges to millimetres and finds them by id', () => {
    expect(sheetMetalGaugeById('steel-msg:16')?.thicknessMm).toBeCloseTo(
      1.5189,
      4
    );
    expect(sheetMetalGaugeById('aluminium-bs:14')?.thicknessMm).toBeCloseTo(
      1.6281,
      4
    );
    expect(sheetMetalGaugeById('metric:1.5')?.thicknessMm).toBe(1.5);
    expect(sheetMetalGaugeById('steel-msg:13')).toBeNull();
    expect(sheetMetalGaugeById('nope:1')).toBeNull();
    for (const table of Object.values(SHEET_METAL_GAUGE_TABLES)) {
      const ids = table.map((gauge) => gauge.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
