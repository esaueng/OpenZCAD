/**
 * The `'bezier'` region-curve kind.
 *
 * Glyph outlines reach the kernel as exact quadratic and cubic beziers rather
 * than polylines (`docs/plans/text-feature-plan.md`, design decision 4), which
 * means every place `regions.ts` reasons about a curve — exact area, direction
 * canonical signatures, reversal, sampling — has to handle one. These tests
 * check each of those against an independently computed answer, not against
 * the implementation's own arithmetic.
 */
import { describe, expect, it } from 'vitest';
import {
  mergeAdjacentProfiles,
  regionFingerprintOf,
  regionLoopSignedArea,
  type RegionCurve,
  type RegionLoop,
  type SketchProfile,
  type Vec2Like
} from '@openzcad/geometry';

const OBJECT_ID = 'obj_bezier';

function line(a: Vec2Like, b: Vec2Like): RegionCurve {
  return { kind: 'line', a, b, sourceObjectId: OBJECT_ID };
}

function bezier(a: Vec2Like, controls: Vec2Like[], b: Vec2Like): RegionCurve {
  return { kind: 'bezier', a, b, controls, sourceObjectId: OBJECT_ID };
}

function bezierPoint(points: Vec2Like[], t: number): Vec2Like {
  let current = points;
  while (current.length > 1) {
    const next: Vec2Like[] = [];
    for (let index = 0; index + 1 < current.length; index += 1) {
      const p = current[index]!;
      const q = current[index + 1]!;
      next.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
    current = next;
  }
  return current[0]!;
}

/**
 * Shoelace area of a densely sampled loop. Independent of the exact
 * integration under test: it converges to the same number from a completely
 * different direction, so both being wrong the same way is not plausible.
 */
function sampledSignedArea(curves: RegionCurve[], steps = 20_000): number {
  const points: Vec2Like[] = [];
  for (const curve of curves) {
    if (curve.kind === 'line') {
      points.push(curve.a);
      continue;
    }
    if (curve.kind === 'bezier') {
      const control = [curve.a, ...curve.controls, curve.b];
      for (let index = 0; index < steps; index += 1) {
        points.push(bezierPoint(control, index / steps));
      }
      continue;
    }
    throw new Error('arcs are covered elsewhere');
  }
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return twice / 2;
}

function loopOf(curves: RegionCurve[]): RegionLoop {
  const polyline: Vec2Like[] = [];
  for (const curve of curves) {
    if (curve.kind === 'bezier') {
      const control = [curve.a, ...curve.controls, curve.b];
      for (let index = 0; index < 16; index += 1) {
        polyline.push(bezierPoint(control, index / 16));
      }
      continue;
    }
    polyline.push(curve.kind === 'line' ? curve.a : { x: 0, y: 0 });
  }
  return { curves, polyline };
}

function profileOf(curves: RegionCurve[], area: number): SketchProfile {
  const outer = loopOf(curves);
  const fingerprint = regionFingerprintOf(outer, []);
  const xs = outer.polyline.map((point) => point.x);
  const ys = outer.polyline.map((point) => point.y);
  return {
    profileId: `profile_${fingerprint}`,
    regionFingerprint: fingerprint,
    sourceEntityIds: [OBJECT_ID],
    outer,
    holes: [],
    signedArea: area,
    area,
    centroid: { x: 0, y: 0 },
    boundingBox: {
      min: { x: Math.min(...xs), y: Math.min(...ys) },
      max: { x: Math.max(...xs), y: Math.max(...ys) }
    },
    validity: 'valid',
    diagnostics: [],
    samplePoint: { x: outer.polyline[0]!.x, y: outer.polyline[0]!.y }
  };
}

// A quadratic bulging +2 in x at its apex, closed back by a straight chord.
// Area between a quadratic and its chord is exactly 2/3 · base · height, so
// this loop's area is a number that can be written down: 2/3 · 10 · 2.
const QUAD_BULGE = bezier({ x: 0, y: 0 }, [{ x: 4, y: 5 }], { x: 0, y: 10 });

describe('exact area of bezier region curves', () => {
  it('matches the closed form for a quadratic against its chord', () => {
    const loop = loopOf([QUAD_BULGE, line({ x: 0, y: 10 }, { x: 0, y: 0 })]);
    // Travelling up the bulge and back down the chord keeps the enclosed
    // sliver on the left, so the loop is counter-clockwise and positive.
    expect(regionLoopSignedArea(loop)).toBeCloseTo((2 / 3) * 10 * 2, 12);
  });

  it('matches a dense shoelace sampling for a cubic', () => {
    // Deliberately asymmetric: a cubic whose control points mirror across the
    // chord encloses equal and opposite lobes, and would pass any area test
    // by cancelling to zero.
    const curves = [
      bezier(
        { x: 0, y: 0 },
        [
          { x: 6, y: 2 },
          { x: -2, y: 9 }
        ],
        { x: 0, y: 10 }
      ),
      line({ x: 0, y: 10 }, { x: 0, y: 0 })
    ];
    const exact = regionLoopSignedArea(loopOf(curves));
    expect(exact).toBeCloseTo(sampledSignedArea(curves), 6);
    // The S-curve is not degenerate: it encloses real area on both sides, so
    // this is not the trivially-zero case passing by accident.
    expect(Math.abs(exact)).toBeGreaterThan(0.1);
  });

  it('negates under reversal and keeps the same fingerprint', () => {
    const forward = [QUAD_BULGE, line({ x: 0, y: 10 }, { x: 0, y: 0 })];
    const backward: RegionCurve[] = [
      line({ x: 0, y: 0 }, { x: 0, y: 10 }),
      bezier({ x: 0, y: 10 }, [{ x: 4, y: 5 }], { x: 0, y: 0 })
    ];
    expect(regionLoopSignedArea(loopOf(backward))).toBeCloseTo(
      -regionLoopSignedArea(loopOf(forward)),
      12
    );
    // Signatures are direction-canonical, so the same boundary traced either
    // way hashes the same. `mergeAdjacentProfiles` depends on this to cancel
    // a shared edge that two cells traverse in opposite directions.
    expect(regionFingerprintOf(loopOf(backward), [])).toBe(
      regionFingerprintOf(loopOf(forward), [])
    );
  });

  it('distinguishes a quadratic from a cubic with the same endpoints', () => {
    const quad = loopOf([QUAD_BULGE, line({ x: 0, y: 10 }, { x: 0, y: 0 })]);
    const cubic = loopOf([
      bezier(
        { x: 0, y: 0 },
        [
          { x: 4, y: 5 },
          { x: 4, y: 5 }
        ],
        { x: 0, y: 10 }
      ),
      line({ x: 0, y: 10 }, { x: 0, y: 0 })
    ]);
    expect(regionFingerprintOf(cubic, [])).not.toBe(
      regionFingerprintOf(quad, [])
    );
  });
});

describe('merging profiles across a shared bezier boundary', () => {
  // Two cells that share the bulging quadratic: the left one gains the bulge,
  // the right one loses it, and merging must cancel the shared piece.
  const bulge = (2 / 3) * 10 * 2;
  const left = profileOf(
    [
      QUAD_BULGE,
      line({ x: 0, y: 10 }, { x: -10, y: 10 }),
      line({ x: -10, y: 10 }, { x: -10, y: 0 }),
      line({ x: -10, y: 0 }, { x: 0, y: 0 })
    ],
    100 + bulge
  );
  const right = profileOf(
    [
      line({ x: 0, y: 0 }, { x: 10, y: 0 }),
      line({ x: 10, y: 0 }, { x: 10, y: 10 }),
      line({ x: 10, y: 10 }, { x: 0, y: 10 }),
      bezier({ x: 0, y: 10 }, [{ x: 4, y: 5 }], { x: 0, y: 0 })
    ],
    100 - bulge
  );

  it('drops the shared bezier and leaves the outer rectangle', () => {
    const merged = mergeAdjacentProfiles([left, right]);
    expect(merged.outer.curves).toHaveLength(6);
    expect(merged.outer.curves.every((curve) => curve.kind === 'line')).toBe(
      true
    );
    expect(merged.holes).toHaveLength(0);
    expect(merged.area).toBeCloseTo(200, 9);
    // The merged boundary is the 20 × 10 rectangle: exact area confirms the
    // bulge really cancelled rather than being counted once.
    expect(Math.abs(regionLoopSignedArea(merged.outer))).toBeCloseTo(200, 9);
  });

  it('keeps an unshared bezier exact and samples it off its chord', () => {
    // Same pair, but the right cell's far edge bows outward and is shared
    // with nothing, so it must survive the merge as a bezier.
    const bowed = profileOf(
      [
        line({ x: 0, y: 0 }, { x: 10, y: 0 }),
        bezier(
          { x: 10, y: 0 },
          [
            { x: 14, y: 3 },
            { x: 14, y: 7 }
          ],
          { x: 10, y: 10 }
        ),
        line({ x: 10, y: 10 }, { x: 0, y: 10 }),
        bezier({ x: 0, y: 10 }, [{ x: 4, y: 5 }], { x: 0, y: 0 })
      ],
      100 - bulge
    );
    const merged = mergeAdjacentProfiles([left, bowed]);
    const beziers = merged.outer.curves.filter(
      (curve) => curve.kind === 'bezier'
    );
    expect(beziers).toHaveLength(1);
    // The sampled polyline must follow the bow, not the chord: the chord runs
    // along x = 10, and the curve reaches x = 13 at its apex.
    const maximumX = Math.max(...merged.outer.polyline.map((point) => point.x));
    expect(maximumX).toBeGreaterThan(12.5);
    expect(maximumX).toBeLessThanOrEqual(13);
  });
});
