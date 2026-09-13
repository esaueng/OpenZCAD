import { describe, expect, it } from 'vitest';

import { RemusKernel } from './remus-runtime';
import {
  chamferSketchCorner,
  filletSketchCorner,
  offsetSketchLoop,
  signedLoopArea,
  type Sketch2dPoint,
  type SketchCorner
} from './sketch-2d-ops';

function withKernel<T>(run: (kernel: RemusKernel) => T): T {
  const kernel = new RemusKernel();
  try {
    return run(kernel);
  } finally {
    kernel.free();
  }
}

/** A corner at the origin with legs of the given length and included angle. */
function corner(angleDeg: number, lengthA = 10, lengthB = 10): SketchCorner {
  const angle = (angleDeg * Math.PI) / 180;
  return {
    corner: { x: 0, y: 0 },
    farA: { x: lengthA, y: 0 },
    farB: { x: Math.cos(angle) * lengthB, y: Math.sin(angle) * lengthB }
  };
}

function distance(a: Sketch2dPoint, b: Sketch2dPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('kernel-backed sketch corner chamfer', () => {
  it('cuts both legs back by the requested distance', () => {
    const result = withKernel((kernel) =>
      chamferSketchCorner(kernel, corner(90), 3)
    );
    expect(result.a.x).toBeCloseTo(3, 9);
    expect(result.a.y).toBeCloseTo(0, 9);
    expect(result.b.x).toBeCloseTo(0, 9);
    expect(result.b.y).toBeCloseTo(3, 9);
  });

  it('keeps an equal setback at an oblique corner', () => {
    for (const angle of [30, 60, 120, 150]) {
      const input = corner(angle);
      const result = withKernel((kernel) =>
        chamferSketchCorner(kernel, input, 2)
      );
      expect(distance(result.a, input.corner)).toBeCloseTo(2, 9);
      expect(distance(result.b, input.corner)).toBeCloseTo(2, 9);
    }
  });

  it('refuses a distance the legs cannot carry', () => {
    expect(() =>
      withKernel((kernel) => chamferSketchCorner(kernel, corner(90, 10, 4), 6))
    ).toThrow(/only 4\.000 long/);
  });

  it('refuses instead of returning the clamp the kernel applies', () => {
    // The kernel clamps a chamfer to half of the shorter adjacent edge and
    // says nothing. Half of the 4-long leg is 2, so 2.5 comes back as 2 and
    // has to be refused rather than accepted as the requested chamfer.
    const clamped = withKernel((kernel) =>
      kernel.chamfer2d(Float64Array.of(10, 0, 0, 0, 0, 4), 2.5)
    );
    expect(Math.hypot(clamped[4]!, clamped[5]!)).toBeCloseTo(2, 9);
    expect(() =>
      withKernel((kernel) =>
        chamferSketchCorner(kernel, corner(90, 10, 4), 2.5)
      )
    ).toThrow(/instead of the requested 2\.500/);
  });

  it('refuses a non-positive distance', () => {
    expect(() =>
      withKernel((kernel) => chamferSketchCorner(kernel, corner(90), 0))
    ).toThrow(/positive number/);
  });

  it('refuses a corner whose legs are collinear', () => {
    expect(() =>
      withKernel((kernel) => chamferSketchCorner(kernel, corner(180), 1))
    ).toThrow(/collinear/);
  });
});

describe('exact sketch corner fillet', () => {
  it('inscribes a tangent arc at a right-angle corner', () => {
    const fillet = filletSketchCorner(corner(90), 2);
    expect(fillet.a.x).toBeCloseTo(2, 12);
    expect(fillet.a.y).toBeCloseTo(0, 12);
    expect(fillet.b.x).toBeCloseTo(0, 12);
    expect(fillet.b.y).toBeCloseTo(2, 12);
    expect(fillet.center.x).toBeCloseTo(2, 12);
    expect(fillet.center.y).toBeCloseTo(2, 12);
    expect(fillet.startsAt).toBe('b');
    expect(fillet.startAngleDeg).toBeCloseTo(180, 9);
    expect(fillet.endAngleDeg).toBeCloseTo(270, 9);
  });

  it('stays tangent at every corner angle, which is what the solver is told', () => {
    for (const angle of [20, 45, 90, 120, 160]) {
      const input = corner(angle, 100, 100);
      const fillet = filletSketchCorner(input, 3);
      // Tangency: the centre is exactly the radius from each leg, and each
      // trim point is the foot of that perpendicular.
      for (const [far, trim] of [
        [input.farA, fillet.a],
        [input.farB, fillet.b]
      ] as const) {
        const length = Math.hypot(far.x, far.y);
        const dir = { x: far.x / length, y: far.y / length };
        const foot = fillet.center.x * dir.x + fillet.center.y * dir.y;
        const lateral = Math.abs(
          fillet.center.x * dir.y - fillet.center.y * dir.x
        );
        expect(lateral).toBeCloseTo(3, 9);
        expect(trim.x).toBeCloseTo(dir.x * foot, 9);
        expect(trim.y).toBeCloseTo(dir.y * foot, 9);
      }
      // The arc is the minor one: it sweeps 180 degrees less the corner.
      expect(fillet.endAngleDeg - fillet.startAngleDeg).toBeCloseTo(
        180 - angle,
        9
      );
    }
  });

  it('sweeps counter-clockwise from start to end whichever leg was picked first', () => {
    const forward = filletSketchCorner(corner(90), 2);
    const reversed = filletSketchCorner(
      {
        corner: { x: 0, y: 0 },
        farA: { x: 0, y: 10 },
        farB: { x: 10, y: 0 }
      },
      2
    );
    expect(reversed.startsAt).toBe('a');
    expect(reversed.startAngleDeg).toBeCloseTo(forward.startAngleDeg, 9);
    expect(reversed.endAngleDeg).toBeCloseTo(forward.endAngleDeg, 9);
  });

  it('refuses a radius whose setback would eat a whole entity', () => {
    expect(() => filletSketchCorner(corner(90, 10, 4), 5)).toThrow(
      /only 4\.000 long/
    );
  });

  it('refuses a non-positive radius', () => {
    expect(() => filletSketchCorner(corner(90), -1)).toThrow(/positive number/);
  });
});

describe('why the kernel fillet2d is not the sketch fillet', () => {
  // Pinned deliberately: if a later kernel makes fillet2d a true tangent
  // fillet, this test fails and the exact construction above can be retired.
  it('parameterises by setback rather than by radius', () => {
    const filleted = withKernel((kernel) =>
      // A 120-degree corner at the origin, legs 20 long.
      kernel.fillet2d(
        Float64Array.of(
          20,
          0,
          0,
          0,
          20 * Math.cos((120 * Math.PI) / 180),
          20 * Math.sin((120 * Math.PI) / 180)
        ),
        2
      )
    );
    const points: Sketch2dPoint[] = [];
    for (let index = 0; index < filleted.length; index += 2) {
      points.push({ x: filleted[index]!, y: filleted[index + 1]! });
    }
    const nearCorner = points.filter(
      (point) => Math.hypot(point.x, point.y) < 6
    );
    expect(nearCorner.length).toBeGreaterThan(2);
    // Both ends of the inserted run sit exactly the requested "radius" from
    // the corner, which is the setback, not the radius: a true radius-2
    // fillet of a 120-degree corner sets back 2 / tan(60) = 1.155.
    expect(Math.hypot(nearCorner[0]!.x, nearCorner[0]!.y)).toBeCloseTo(2, 6);
    expect(2 / Math.tan((60 * Math.PI) / 180)).toBeCloseTo(1.1547, 4);
  });

  it('is not tangent to the legs it joins', () => {
    const filleted = withKernel((kernel) =>
      kernel.fillet2d(
        Float64Array.of(
          20,
          0,
          0,
          0,
          20 * Math.cos((120 * Math.PI) / 180),
          20 * Math.sin((120 * Math.PI) / 180)
        ),
        2
      )
    );
    // The first inserted point leaves the +X leg; a tangent fillet would leave
    // it along the leg, so the departure angle would be zero.
    const first = { x: filleted[0]!, y: filleted[1]! };
    const second = { x: filleted[2]!, y: filleted[3]! };
    const departure = Math.abs(
      Math.atan2(second.y - first.y, second.x - first.x)
    );
    expect(departure).toBeGreaterThan(0.05);
  });
});

describe('kernel-backed sketch loop offset', () => {
  const square: Sketch2dPoint[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 }
  ];

  it('rounds the outward corners with true arcs of the offset radius', () => {
    const curves = withKernel((kernel) =>
      offsetSketchLoop(kernel, square, 2, 'arc')
    );
    expect(curves.filter((curve) => curve.kind === 'line')).toHaveLength(4);
    const arcs = curves.filter((curve) => curve.kind === 'arc');
    expect(arcs).toHaveLength(4);
    for (const arc of arcs) {
      expect(arc.radius).toBeCloseTo(2, 9);
      expect(arc.endAngleDeg - arc.startAngleDeg).toBeCloseTo(90, 6);
    }
  });

  it('reads a straight-cornered outward offset back exactly', () => {
    const curves = withKernel((kernel) =>
      offsetSketchLoop(kernel, square, 2, 'intersection')
    );
    expect(curves).toHaveLength(4);
    const corners = curves.map((curve) =>
      curve.kind === 'line' ? curve.a : { x: NaN, y: NaN }
    );
    for (const wanted of [
      { x: -2, y: -2 },
      { x: 12, y: -2 },
      { x: 12, y: 12 },
      { x: -2, y: 12 }
    ]) {
      expect(
        corners.some(
          (point) =>
            Math.abs(point.x - wanted.x) < 1e-9 &&
            Math.abs(point.y - wanted.y) < 1e-9
        )
      ).toBe(true);
    }
  });

  it('shrinks the loop for an inward offset whichever way it was wound', () => {
    const clockwise = [...square].reverse();
    for (const loop of [square, clockwise]) {
      const curves = withKernel((kernel) =>
        offsetSketchLoop(kernel, loop, -2, 'arc')
      );
      const points = curves.map((curve) =>
        curve.kind === 'line' ? curve.a : curve.center
      );
      expect(Math.abs(signedLoopArea(points))).toBeCloseTo(36, 6);
    }
  });

  it('refuses an inward offset that collapses the loop', () => {
    // The kernel answers a collapsed offset with a zero-length wire rather
    // than an error, so the refusal has to come from the area witness.
    expect(() =>
      withKernel((kernel) => offsetSketchLoop(kernel, square, -5, 'arc'))
    ).toThrow(/collapses the loop|did not move the loop/);
    expect(() =>
      withKernel((kernel) => offsetSketchLoop(kernel, square, -8, 'arc'))
    ).toThrow(/collapses the loop|did not move the loop/);
  });

  it('refuses a zero distance and a loop that is not a loop', () => {
    expect(() =>
      withKernel((kernel) => offsetSketchLoop(kernel, square, 0, 'arc'))
    ).toThrow(/non-zero/);
    expect(() =>
      withKernel((kernel) =>
        offsetSketchLoop(kernel, square.slice(0, 2), 1, 'arc')
      )
    ).toThrow(/at least three lines/);
  });
});
