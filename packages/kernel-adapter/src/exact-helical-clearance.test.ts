import { describe, expect, it } from 'vitest';
import {
  helicalCoilOverlap,
  helicalSectionExtent,
  type HelicalClearanceKernel
} from './exact-helical-clearance';

type Triple = readonly [number, number, number];
const TAU = 2 * Math.PI;

/** A face whose edges are the given curves, each over [0, 1]. */
function faceOf(...curves: ((t: number) => Triple)[]): HelicalClearanceKernel {
  return {
    getFaceEdges: () => Uint32Array.from(curves.map((_curve, index) => index)),
    getEdgeParamSpan: () => Float64Array.of(0, 1),
    evaluateEdgeCurve: (edge: number, t: number) =>
      Float64Array.from(curves[edge]!(t)),
    getNurbsCurveData: () => JSON.stringify({ distinctKnots: [0, 1] })
  };
}

/** A circle of `radius` about `centre` in the plane of `u` and `v`. */
const circle =
  (centre: Triple, radius: number, u: Triple, v: Triple) =>
  (t: number): Triple => {
    const c = radius * Math.cos(TAU * t);
    const s = radius * Math.sin(TAU * t);
    return [
      centre[0] + u[0] * c + v[0] * s,
      centre[1] + u[1] * c + v[1] * s,
      centre[2] + u[2] * c + v[2] * s
    ];
  };

/** The span as the kernel reads it: the best of `count` points on the curve. */
function sampledSpan(
  curve: (t: number) => Triple,
  origin: Triple,
  axis: Triple,
  count: number
): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const p = curve(index / count);
    const z =
      (p[0] - origin[0]) * axis[0] +
      (p[1] - origin[1]) * axis[1] +
      (p[2] - origin[2]) * axis[2];
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  return hi - lo;
}

describe('helicalSectionExtent', () => {
  it("reads a circle's span on an oblique axis exactly, where 48 samples fall short (#2188)", () => {
    // The wire of #2188: Ø3 mm at (27.6, 0, −11.2), its plane holding the
    // axis through (18, 0, −4) along (0.6, 0, 0.8).
    const origin: Triple = [18, 0, -4];
    const axis: Triple = [0.6, 0, 0.8];
    const wire = circle([27.6, 0, -11.2], 1.5, [1, 0, 0], [0, 0, 1]);
    // Read from 48 points, the span comes up short wherever the highest
    // and lowest points fall between them (the kernel made it 2.9938 mm),
    // and a pitch between the two readings is let past.
    expect(sampledSpan(wire, origin, axis, 48)).toBeLessThan(3 - 1e-4);
    const extent = helicalSectionExtent(faceOf(wire), 0, origin, axis, 2.997)!;
    expect(Math.abs(extent.span - 3)).toBeLessThan(1e-12);
    // In a plane through the axis the profile subtends no angle at it.
    expect(extent.angularWidth).toBeLessThan(1e-12);
    expect(extent.minRadius).toBeCloseTo(10.5, 10);
  });

  it('measures a profile tilted off the axis by the screw, not along the axis alone', () => {
    // A wire in the XZ plane wound about an axis leaning 30° out of that
    // plane. Its points stand at different angles about the axis, and a
    // turn carries each on by pitch × angle / 2π: with the pitch the span
    // grows, against it the span shrinks. The plain axial span is 3·cos 30°.
    const lean = Math.PI / 6;
    const axis: Triple = [0, Math.sin(lean), Math.cos(lean)];
    const wire = circle([12, 0, 0], 1.5, [1, 0, 0], [0, 0, 1]);
    const kernel = faceOf(wire);
    const up = helicalSectionExtent(kernel, 0, [0, 0, 0], axis, 1)!;
    const down = helicalSectionExtent(kernel, 0, [0, 0, 0], axis, -1)!;
    expect(up.span).toBeCloseTo(2.6179459078712752, 9);
    expect(down.span).toBeCloseTo(2.578208876314947, 9);
    // Seen along the axis the wire is half as wide as it is tall (sin 30°):
    // about 2·asin(0.75 / 12) across.
    expect(up.angularWidth).toBeGreaterThan(0.12);
    expect(up.angularWidth).toBeLessThan(0.13);
    expect(down.angularWidth).toBeCloseTo(up.angularWidth, 12);
  });

  it('follows a profile round the axis past half a turn', () => {
    // A C-shaped strip square to the axis, 300° of a ring: its angle runs
    // on through ±180° instead of jumping back, and the screw spans it by
    // 300/360 of a pitch although it has no height along the axis at all.
    const sweep = (300 / 360) * TAU;
    const arc =
      (radius: number, from: number, to: number) =>
      (t: number): Triple => {
        const angle = from + (to - from) * t;
        return [radius * Math.cos(angle), radius * Math.sin(angle), 4];
      };
    const side =
      (angle: number, from: number, to: number) =>
      (t: number): Triple => {
        const radius = from + (to - from) * t;
        return [radius * Math.cos(angle), radius * Math.sin(angle), 4];
      };
    const strip = faceOf(
      arc(10, 0, sweep),
      side(sweep, 10, 9),
      arc(9, sweep, 0),
      side(0, 9, 10)
    );
    const extent = helicalSectionExtent(strip, 0, [0, 0, 0], [0, 0, 1], 6)!;
    expect(extent.angularWidth).toBeCloseTo(sweep, 10);
    expect(extent.span).toBeCloseTo(6 * (300 / 360), 10);
    expect(extent.minRadius).toBeCloseTo(9, 10);
  });

  it('places a hole by the boundary round it', () => {
    // A hole read before any of its outline shares no end with it; it takes
    // its angle from the nearest point already placed.
    const outline = circle([12, 0, 0], 3, [1, 0, 0], [0, 0, 1]);
    const hole = circle([12, 0, 0], 1, [1, 0, 0], [0, 0, 1]);
    const lean = Math.PI / 6;
    const axis: Triple = [0, Math.sin(lean), Math.cos(lean)];
    const alone = helicalSectionExtent(faceOf(outline), 0, [0, 0, 0], axis, 1)!;
    const holed = helicalSectionExtent(
      faceOf(outline, hole),
      0,
      [0, 0, 0],
      axis,
      1
    )!;
    expect(holed.span).toBeCloseTo(alone.span, 12);
    expect(holed.angularWidth).toBeCloseTo(alone.angularWidth, 12);
  });

  it('answers nothing for a profile it cannot read, leaving the kernel to refuse', () => {
    // Touching the axis, where the angle has no value.
    const onAxis = circle([1.5, 0, 0], 1.5, [1, 0, 0], [0, 0, 1]);
    expect(
      helicalSectionExtent(faceOf(onAxis), 0, [0, 0, 0], [0, 0, 1], 5)
    ).toBeNull();
    expect(
      helicalSectionExtent(faceOf(), 0, [0, 0, 0], [0, 0, 1], 5)
    ).toBeNull();
    const broken: HelicalClearanceKernel = {
      ...faceOf(onAxis),
      getFaceEdges: () => {
        throw new Error('invalid face handle');
      }
    };
    expect(helicalSectionExtent(broken, 0, [0, 0, 0], [0, 0, 1], 5)).toBeNull();
  });
});

describe('helicalCoilOverlap', () => {
  const wire = { span: 3, angularWidth: 0, minRadius: 10.5 };

  it('refuses a full turn that climbs no more than the profile spans', () => {
    for (const pitch of [2.99, 2.997, -2.997, 3, 3 + 1e-9]) {
      expect(helicalCoilOverlap(wire, pitch, 1), String(pitch)).toMatch(
        /^helical sweep coils would overlap: the profile spans 3 along the axis/
      );
    }
    expect(helicalCoilOverlap(wire, 2.997, 6.25)).not.toBeNull();
  });

  it('builds a turn with clearance, and any pitch short of a full turn', () => {
    expect(helicalCoilOverlap(wire, 3.0001, 1)).toBeNull();
    expect(helicalCoilOverlap(wire, 3.02, 1)).toBeNull();
    expect(helicalCoilOverlap(wire, -3.02, 40)).toBeNull();
    expect(helicalCoilOverlap(wire, 2.99, 0.999)).toBeNull();
    expect(helicalCoilOverlap(wire, 0.1, 0.5)).toBeNull();
  });

  it('counts the angle the profile subtends toward the turn', () => {
    // A profile a twentieth of a turn wide meets itself that much sooner.
    const wide = { span: 3, angularWidth: TAU / 20, minRadius: 10.5 };
    expect(helicalCoilOverlap(wide, 2, 0.94)).toBeNull();
    expect(helicalCoilOverlap(wide, 2, 0.96)).not.toBeNull();
    expect(helicalCoilOverlap(wide, 3.5, 0.96)).toBeNull();
  });
});
