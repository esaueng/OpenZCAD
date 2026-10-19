import { describe, expect, it } from 'vitest';
import {
  computeSketchProfileAnalysis,
  computeSketchRegions,
  controlSpline,
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
