import { describe, expect, it } from 'vitest';
import {
  computeSketchProfileAnalysis,
  computeSketchRegions,
  controlSpline,
  ellipticalArcSweepDegrees,
  fitSplineThrough,
  mergeAdjacentProfiles,
  regionLoopSignedArea,
  resolveSplineGeometry,
  reverseSpline,
  splineAreaTerm,
  splineBezierSegments,
  splineDerivatives,
  splineDomain,
  splinePoint,
  splineSelfIntersection,
  splineSubcurve,
  type CurvePoint,
  type SketchRegionObject
} from '@openzcad/geometry';
import type { ParamValue, SketchObjectData } from '@openzcad/shared';

/**
 * I01 (schema v27): ellipse and spline sketch entities through region and
 * profile analysis. Areas are compared with closed forms (πab, elliptical
 * segments) or with a dense Green's-theorem sum over the curve itself.
 */

const resolve = (value: ParamValue): number =>
  typeof value === 'number' ? value : Number(value);

let nextId = 0;
function object(data: SketchObjectData): SketchRegionObject {
  nextId += 1;
  return { id: `obj_${nextId}`, data };
}

function ellipse(
  radiusX: number,
  radiusY: number,
  options: Partial<{
    centerX: number;
    centerY: number;
    rotationDeg: number;
    startParamDeg: number;
    endParamDeg: number;
  }> = {}
): SketchRegionObject {
  return object({
    objectKind: 'ellipse',
    centerX: options.centerX ?? 0,
    centerY: options.centerY ?? 0,
    radiusX,
    radiusY,
    rotationDeg: options.rotationDeg ?? 0,
    ...(options.startParamDeg === undefined
      ? {}
      : {
          startParamDeg: options.startParamDeg,
          endParamDeg: options.endParamDeg!
        })
  });
}

function line(x1: number, y1: number, x2: number, y2: number) {
  return object({ objectKind: 'line', x1, y1, x2, y2 });
}

function spline(
  method: 'fit' | 'control',
  points: CurvePoint[],
  closed = false,
  degree?: 2 | 3
): SketchRegionObject {
  return object({
    objectKind: 'spline',
    method,
    ...(degree ? { degree } : {}),
    points: points.map((point) => ({ x: point.x, y: point.y })),
    ...(closed ? { closed: true } : {})
  });
}

/** Twice-signed-area of a densely sampled closed curve, for cross-checks. */
function denseArea(points: CurvePoint[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return twice / 2;
}

function denseSpline(
  points: CurvePoint[],
  closed: boolean,
  method: 'fit' | 'control' = 'fit'
): CurvePoint[] {
  const curve =
    method === 'fit'
      ? fitSplineThrough(points, closed)
      : controlSpline(points, 3, closed);
  const [from, to] = splineDomain(curve);
  // An open curve keeps its final point; a closed one would repeat its first.
  return Array.from({ length: closed ? 20000 : 20001 }, (_, index) =>
    splinePoint(curve, from + ((to - from) * index) / 20000)
  );
}

const close = (a: CurvePoint, b: CurvePoint, digits = 9) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
};

describe('spline construction', () => {
  const fitPoints = [
    { x: 0, y: 0 },
    { x: 10, y: 8 },
    { x: 25, y: 3 },
    { x: 32, y: 15 },
    { x: 40, y: 0 }
  ];

  it('passes an open fit spline through every point, ends bit-exact', () => {
    const curve = fitSplineThrough(fitPoints, false);
    expect(curve.degree).toBe(3);
    expect(curve.knots).toHaveLength(curve.controls.length + 4);
    expect(curve.controls[0]).toEqual(fitPoints[0]);
    expect(curve.controls.at(-1)).toEqual(fitPoints.at(-1));
    // Chord-length parameters: every fit point lies on the curve.
    const chords = [0];
    for (let index = 1; index < fitPoints.length; index += 1) {
      chords.push(
        chords[index - 1]! +
          Math.hypot(
            fitPoints[index]!.x - fitPoints[index - 1]!.x,
            fitPoints[index]!.y - fitPoints[index - 1]!.y
          )
      );
    }
    chords.forEach((length, index) => {
      close(splinePoint(curve, length / chords.at(-1)!), fitPoints[index]!);
    });
  });

  it('closes a periodic fit spline smoothly through its seam', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 20, y: -4 },
      { x: 26, y: 14 },
      { x: 6, y: 18 }
    ];
    const curve = fitSplineThrough(points, true);
    expect(curve.closed).toBe(true);
    const [from, to] = splineDomain(curve);
    close(splinePoint(curve, from), points[0]!);
    close(splinePoint(curve, to), points[0]!);
    const start = splineDerivatives(curve, from);
    const end = splineDerivatives(curve, to);
    // C2 through the seam: the periodic curve was clamped, not altered.
    close(start.d1, end.d1, 6);
    close(start.d2, end.d2, 4);
    for (const point of points) {
      const nearest = Math.min(
        ...denseSpline(points, true).map((sample) =>
          Math.hypot(sample.x - point.x, sample.y - point.y)
        )
      );
      expect(nearest).toBeLessThan(5e-3);
    }
  });

  it('starts and ends a control spline on its end control points', () => {
    const curve = controlSpline(fitPoints, 3, false);
    expect(curve.knots).toEqual([0, 0, 0, 0, 0.5, 1, 1, 1, 1]);
    close(splinePoint(curve, 0), fitPoints[0]!);
    close(splinePoint(curve, 1), fitPoints.at(-1)!);
    // Lowered degree when the polygon is short.
    expect(controlSpline(fitPoints.slice(0, 3), 3, false).degree).toBe(2);
  });

  it('extracts pieces, Bézier segments and reversals exactly', () => {
    const curve = fitSplineThrough(fitPoints, false);
    const piece = splineSubcurve(curve, 0.2, 0.7);
    for (const u of [0.2, 0.33, 0.5, 0.61, 0.7]) {
      close(splinePoint(piece, u), splinePoint(curve, u));
    }
    const segments = splineBezierSegments(curve);
    expect(segments.length).toBe(curve.knots.length - 2 * 4 + 1);
    close(segments[0]![0]!, fitPoints[0]!);
    close(segments.at(-1)!.at(-1)!, fitPoints.at(-1)!);
    const reversed = reverseSpline(curve);
    close(splinePoint(reversed, 0.25), splinePoint(curve, 0.75));
    expect(splineAreaTerm(reversed, 0, 1)).toBeCloseTo(
      -splineAreaTerm(curve, 0, 1),
      9
    );
  });

  it('refuses repeated and too few points', () => {
    expect(() =>
      fitSplineThrough(
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 5, y: 5 }
        ],
        false
      )
    ).toThrow(/same point/);
    expect(() =>
      resolveSplineGeometry(
        {
          objectKind: 'spline',
          method: 'fit',
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 }
          ]
        },
        resolve
      )
    ).toThrow(/at least 3/);
  });
});

describe('ellipse regions', () => {
  it('bounds πab inside a full ellipse, rotated or not', () => {
    for (const rotationDeg of [0, 30, 90]) {
      const regions = computeSketchRegions(
        [ellipse(20, 10, { centerX: 5, centerY: -3, rotationDeg })],
        resolve
      );
      expect(regions).toHaveLength(1);
      expect(regions[0]!.area).toBeCloseTo(Math.PI * 200, 9);
      expect(regions[0]!.outer.curves).toHaveLength(1);
      expect(regions[0]!.outer.curves[0]!.kind).toBe('ellipse');
    }
  });

  it('splits an ellipse along its major axis into equal exact halves', () => {
    const regions = computeSketchRegions(
      [
        ellipse(20, 10, { rotationDeg: 30 }),
        line(-30, -30 * Math.tan(Math.PI / 6), 30, 30 * Math.tan(Math.PI / 6))
      ],
      resolve
    );
    expect(regions).toHaveLength(2);
    for (const region of regions) {
      expect(region.area).toBeCloseTo(Math.PI * 100, 7);
    }
    // The two halves merge back into the whole ellipse.
    const merged = mergeAdjacentProfiles(regions);
    expect(regionLoopSignedArea(merged.outer)).toBeCloseTo(Math.PI * 200, 7);
  });

  it('closes an elliptical arc with its chord into an exact segment', () => {
    // Upper half (t from 0° to 180°) of a 20×10 ellipse, closed by the axis.
    const regions = computeSketchRegions(
      [
        ellipse(20, 10, { startParamDeg: 0, endParamDeg: 180 }),
        line(-20, 0, 20, 0)
      ],
      resolve
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo(Math.PI * 100, 9);
    // A quarter segment: πab/4 − ab/2.
    const quarter = computeSketchRegions(
      [
        ellipse(20, 10, { startParamDeg: 0, endParamDeg: 90 }),
        line(20, 0, 0, 10)
      ],
      resolve
    );
    expect(quarter).toHaveLength(1);
    expect(quarter[0]!.area).toBeCloseTo(Math.PI * 50 - 100, 9);
  });

  it('holds a circle as a hole inside an ellipse', () => {
    const regions = computeSketchRegions(
      [
        ellipse(30, 15),
        object({ objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 })
      ],
      resolve
    );
    expect(regions).toHaveLength(2);
    const ring = regions.find((region) => region.holes.length === 1)!;
    expect(ring.area).toBeCloseTo(Math.PI * (450 - 25), 6);
  });

  it('crosses a rectangle edge and splits both', () => {
    // A 20×10 ellipse straddling x = 10: the line meets it at y = ±10·√0.75.
    const regions = computeSketchRegions(
      [ellipse(20, 10), line(10, -20, 10, 20)],
      resolve
    );
    expect(regions).toHaveLength(2);
    const total = regions.reduce((sum, region) => sum + region.area, 0);
    expect(total).toBeCloseTo(Math.PI * 200, 7);
    // Segment beyond x = 10: ab·(θ − sinθ cosθ) with cosθ = 0.5.
    const theta = Math.acos(0.5);
    const segment = 200 * (theta - Math.sin(theta) * Math.cos(theta));
    expect(Math.min(...regions.map((region) => region.area))).toBeCloseTo(
      segment,
      7
    );
  });

  it('refuses an elliptical arc whose range wraps to nothing (review case)', () => {
    // start 360, end 0: a raw −360° that wraps to a zero sweep.
    expect(() => ellipticalArcSweepDegrees(360, 0)).toThrow(/non-zero/);
    expect(ellipticalArcSweepDegrees(0, 360)).toBe(360);
    expect(() => ellipticalArcSweepDegrees(300, -60)).toThrow(/non-zero/);
    expect(ellipticalArcSweepDegrees(300, 30)).toBe(90);
    // The sketch reports it as an unusable dimension, not a silent nothing.
    const analysis = computeSketchProfileAnalysis(
      [ellipse(20, 8, { startParamDeg: 360, endParamDeg: 0 })],
      resolve
    );
    expect(analysis.diagnostics.map((item) => item.code)).toContain(
      'unresolved-parameter'
    );
  });

  it('flags a zero radius as degenerate and leaves no region', () => {
    const analysis = computeSketchProfileAnalysis([ellipse(0, 5)], resolve);
    expect(analysis.profiles).toHaveLength(0);
    expect(analysis.diagnostics.map((item) => item.code)).toContain(
      'unresolved-parameter'
    );
  });
});

describe('spline regions', () => {
  it('bounds a closed fit spline by its exact Green area', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 20, y: -4 },
      { x: 26, y: 14 },
      { x: 6, y: 18 }
    ];
    const regions = computeSketchRegions(
      [spline('fit', points, true)],
      resolve
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.outer.curves.map((curve) => curve.kind)).toEqual([
      'spline'
    ]);
    expect(regions[0]!.area).toBeCloseTo(
      denseArea(denseSpline(points, true)),
      4
    );
  });

  it('closes an open fit spline with a line into one profile', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 12 },
      { x: 30, y: 9 },
      { x: 40, y: 0 }
    ];
    const regions = computeSketchRegions(
      [spline('fit', points), line(40, 0, 0, 0)],
      resolve
    );
    expect(regions).toHaveLength(1);
    const expected = -denseArea([...denseSpline(points, false)]);
    expect(regions[0]!.area).toBeCloseTo(Math.abs(expected), 3);
    const curveKinds = regions[0]!.outer.curves.map((curve) => curve.kind);
    expect(curveKinds.sort()).toEqual(['line', 'spline']);
  });

  it('splits a control spline crossed by a line into exact pieces', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 0, y: 20 },
      { x: 30, y: 20 },
      { x: 30, y: 0 }
    ];
    const regions = computeSketchRegions(
      [spline('control', points), line(0, 0, 30, 0), line(15, -5, 15, 30)],
      resolve
    );
    expect(regions).toHaveLength(2);
    // Symmetric curve: equal halves summing to the whole.
    expect(regions[0]!.area).toBeCloseTo(regions[1]!.area, 6);
    const whole = computeSketchRegions(
      [spline('control', points), line(0, 0, 30, 0)],
      resolve
    );
    expect(regions[0]!.area + regions[1]!.area).toBeCloseTo(whole[0]!.area, 6);
    // Every spline piece in a loop starts where the previous curve ended.
    for (const region of regions) {
      const curves = region.outer.curves;
      for (const curve of curves) {
        if (curve.kind === 'spline') {
          expect(curve.controls[0]).toBe(curve.a);
          expect(curve.knots).toHaveLength(
            curve.controls.length + curve.degree + 1
          );
        }
      }
    }
  });

  it('reports a self-intersecting spline and builds no profile from it', () => {
    const analysis = computeSketchProfileAnalysis(
      [
        spline('fit', [
          { x: 0, y: 0 },
          { x: 20, y: 20 },
          { x: 20, y: 0 },
          { x: 0, y: 20 }
        ]),
        line(0, 20, 0, 0)
      ],
      resolve
    );
    expect(analysis.diagnostics.map((item) => item.code)).toContain(
      'self-intersection'
    );
    expect(analysis.profiles).toHaveLength(0);
  });

  it('finds a small loop inside one cubic span (review case)', () => {
    // One span crossing itself near t ≈ 0.339 and t ≈ 0.428 — a loop no
    // coarse chord sampling of the span would see.
    const loop = [
      { x: 6.089, y: 8.879 },
      { x: -4.494, y: 1.869 },
      { x: 2.642, y: 8.503 },
      { x: 7.084, y: 5.369 }
    ];
    const curve = controlSpline(loop, 3, false);
    expect(curve.knots).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    const crossing = splineSelfIntersection(curve, 1e-6)!;
    expect(crossing).not.toBeNull();
    for (const t of [0.339, 0.428]) {
      const near = splinePoint(curve, t);
      expect(Math.hypot(near.x - crossing.x, near.y - crossing.y)).toBeLessThan(
        0.05
      );
    }
    const analysis = computeSketchProfileAnalysis(
      [spline('control', loop, false, 3), line(7.084, 5.369, 6.089, 8.879)],
      resolve
    );
    expect(analysis.diagnostics.map((item) => item.code)).toContain(
      'self-intersection'
    );
    expect(analysis.profiles).toHaveLength(0);
  });

  it('agrees with a dense ground truth on random control splines', () => {
    // Deterministic pseudo-random polygons; the oracle is a 4000-chord
    // polyline crossing test, far finer than any loop these can make.
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const denseCrosses = (points: CurvePoint[]) => {
      const n = points.length - 1;
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 2; j < n; j += 1) {
          const a0 = points[i]!;
          const a1 = points[i + 1]!;
          const b0 = points[j]!;
          const b1 = points[j + 1]!;
          const d =
            (a1.x - a0.x) * (b1.y - b0.y) - (a1.y - a0.y) * (b1.x - b0.x);
          if (d === 0) continue;
          const r =
            ((b0.x - a0.x) * (b1.y - b0.y) - (b0.y - a0.y) * (b1.x - b0.x)) / d;
          const q =
            ((b0.x - a0.x) * (a1.y - a0.y) - (b0.y - a0.y) * (a1.x - a0.x)) / d;
          if (r > 0 && r < 1 && q > 0 && q < 1) return true;
        }
      }
      return false;
    };
    let crossings = 0;
    for (let trial = 0; trial < 120; trial += 1) {
      const count = 4 + Math.floor(random() * 3);
      const polygon = Array.from({ length: count }, () => ({
        x: random() * 10,
        y: random() * 10
      }));
      const curve = controlSpline(polygon, 3, false);
      const dense = Array.from({ length: 4001 }, (_, index) =>
        splinePoint(curve, index / 4000)
      );
      const expected = denseCrosses(dense);
      crossings += expected ? 1 : 0;
      expect(splineSelfIntersection(curve, 1e-6) !== null).toBe(expected);
    }
    // Both outcomes are exercised.
    expect(crossings).toBeGreaterThan(10);
    expect(crossings).toBeLessThan(110);
  });

  it('finds two crossings that fall between the same pair of samples (review case)', () => {
    // One cubic span, x = 100t and y = 1000(t − .34)(t − .35)(t − 2): it
    // rises above y = 0 only for t in (.34, .35), between samples at 1/3 and
    // .375, so a fixed sampling never saw the lens it bounds with the line.
    const cubic = (t: number) => 1000 * (t - 0.34) * (t - 0.35) * (t - 2);
    const c0 = cubic(0);
    // Power-basis coefficients of the cubic, then its Bézier ordinates.
    const c3 = 1000;
    const c2 = -1000 * (0.34 + 0.35 + 2);
    const c1 = 1000 * (0.34 * 0.35 + 0.34 * 2 + 0.35 * 2);
    const ordinates = [
      c0,
      c0 + c1 / 3,
      c0 + (2 * c1) / 3 + c2 / 3,
      c0 + c1 + c2 + c3
    ];
    const points = ordinates.map((y, index) => ({ x: (100 * index) / 3, y }));
    const regions = computeSketchRegions(
      [spline('control', points, false, 3), line(-50, 0, 250, 0)],
      resolve
    );
    expect(regions).toHaveLength(1);
    // Lens area: 100 · ∫ y dt over (.34, .35), integrated in closed form.
    const antiderivative = (t: number) =>
      1000 *
      (t ** 4 / 4 -
        ((0.34 + 0.35 + 2) * t ** 3) / 3 +
        ((0.34 * 0.35 + 0.34 * 2 + 0.35 * 2) * t ** 2) / 2 -
        0.34 * 0.35 * 2 * t);
    const lens = 100 * (antiderivative(0.35) - antiderivative(0.34));
    expect(regions[0]!.area).toBeCloseTo(lens, 9);
    expect(regions[0]!.area).toBeGreaterThan(0.02);
  });

  it('keeps two distinct splines that agree at the five key samples (review case)', () => {
    // Eight control points, clamped cubic. Perturb y by a combination of
    // basis functions that vanishes at t = 0, ¼, ½, ¾ and 1, so the sampled
    // duplicate key matches while the curves differ between those samples.
    const base = Array.from({ length: 8 }, (_, index) => ({
      x: index * 10,
      y: index % 2 === 0 ? 0 : 6
    }));
    const basis = (i: number, t: number) =>
      splinePoint(
        controlSpline(
          base.map((point, index) => ({ x: point.x, y: index === i ? 1 : 0 })),
          3,
          false
        ),
        t
      ).y;
    // δ4..δ6 chosen; solve δ1..δ3 so φ(¼) = φ(½) = φ(¾) = 0 (δ0 = δ7 = 0
    // already pins both ends).
    const chosen = [0, 0, 0, 0, 2, -3, 2, 0];
    const ts = [0.25, 0.5, 0.75];
    const m = ts.map((t) => [1, 2, 3].map((i) => basis(i, t)));
    const rhs = ts.map(
      (t) => -[4, 5, 6].reduce((sum, i) => sum + basis(i, t) * chosen[i]!, 0)
    );
    const det = (a: number[][]) =>
      a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!) -
      a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!) +
      a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!);
    const d = det(m);
    for (let column = 0; column < 3; column += 1) {
      const replaced = m.map((row, r) =>
        row.map((value, c) => (c === column ? rhs[r]! : value))
      );
      chosen[column + 1] = det(replaced) / d;
    }
    const perturbed = base.map((point, index) => ({
      x: point.x,
      y: point.y + chosen[index]!
    }));
    const a = controlSpline(base, 3, false);
    const b = controlSpline(perturbed, 3, false);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(splinePoint(b, t).y).toBeCloseTo(splinePoint(a, t).y, 9);
    }
    expect(
      Math.abs(splinePoint(b, 0.4).y - splinePoint(a, 0.4).y)
    ).toBeGreaterThan(0.1);

    const analysis = computeSketchProfileAnalysis(
      [
        spline('control', base, false, 3),
        spline('control', perturbed, false, 3)
      ],
      resolve
    );
    expect(analysis.diagnostics.map((item) => item.code)).not.toContain(
      'duplicate-entity'
    );
    // The lenses between them add up to the area between the two curves.
    const steps = 20000;
    let between = 0;
    for (let index = 0; index < steps; index += 1) {
      const t0 = index / steps;
      const t1 = (index + 1) / steps;
      const gap = (t: number) =>
        Math.abs(splinePoint(b, t).y - splinePoint(a, t).y);
      between +=
        ((gap(t0) + gap(t1)) / 2) *
        (splinePoint(a, t1).x - splinePoint(a, t0).x);
    }
    const total = analysis.profiles.reduce(
      (sum, region) => sum + region.area,
      0
    );
    expect(analysis.profiles.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(total - between) / between).toBeLessThan(1e-4);
  });

  it('still refuses a true duplicate spline, drawn either way round', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 12 },
      { x: 30, y: 9 },
      { x: 40, y: 0 }
    ];
    for (const second of [points, [...points].reverse()]) {
      const analysis = computeSketchProfileAnalysis(
        [
          spline('control', points, false, 3),
          spline('control', second, false, 3)
        ],
        resolve
      );
      expect(analysis.diagnostics.map((item) => item.code)).toContain(
        'duplicate-entity'
      );
    }
  });

  it('keeps fingerprints stable across rebuilds and object order', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 12 },
      { x: 30, y: 9 },
      { x: 40, y: 0 }
    ];
    const curve = spline('fit', points);
    const chord = line(40, 0, 0, 0);
    const first = computeSketchRegions([curve, chord], resolve)[0]!;
    const second = computeSketchRegions([chord, curve], resolve)[0]!;
    expect(second.regionFingerprint).toBe(first.regionFingerprint);
    expect(second.profileId).toBe(first.profileId);
  });
});
