import { describe, expect, it } from 'vitest';
import type { EdgeTopology, Vector3 } from '@openzcad/shared';
import { snapsFromEdges } from './topologySnaps';

function edge(topologyId: string, points: number[][]): EdgeTopology {
  return { topologyId, hash: 0, points: points.flat() };
}

/**
 * A circular edge as the kernel publishes one: samples taken ON the exact
 * curve, plus the circle record `EdgeCurve` carries.
 *
 * `segments` defaults to the app's real display sampling rather than a round
 * number — 0.06 rad of angular deflection puts 27 segments across a quarter
 * turn, which `test/edge-chain-characterization.test.ts` pins as 28 points.
 */
interface ArcSpec {
  center?: Vector3;
  /** Unit normal of the arc's plane; unoriented, as the payload's is. */
  axis?: Vector3;
  /** Unit vector in the plane that the arc's start angle is measured from. */
  seed?: Vector3;
  radius: number;
  startAngle?: number;
  sweep: number;
  segments?: number;
  /** Omit to model an edge the kernel refused to describe. */
  curve?: EdgeTopology['curve'];
}

const cross = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});

const sub = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
});

const dot = (a: Vector3, b: Vector3): number =>
  a.x * b.x + a.y * b.y + a.z * b.z;

const norm = (a: Vector3): number => Math.hypot(a.x, a.y, a.z);

const ORIGIN: Vector3 = { x: 0, y: 0, z: 0 };

function angularSegments(sweep: number): number {
  return Math.max(1, Math.ceil(Math.abs(sweep) / 0.06));
}

function arc(topologyId: string, spec: ArcSpec): EdgeTopology {
  const center = spec.center ?? ORIGIN;
  const axis = spec.axis ?? { x: 0, y: 0, z: 1 };
  const u = spec.seed ?? { x: 1, y: 0, z: 0 };
  const v = cross(axis, u);
  const segments = spec.segments ?? angularSegments(spec.sweep);
  const start = spec.startAngle ?? 0;
  const points: number[][] = [];
  for (let step = 0; step <= segments; step += 1) {
    const angle = start + (spec.sweep * step) / segments;
    const along = Math.cos(angle) * spec.radius;
    const across = Math.sin(angle) * spec.radius;
    points.push([
      center.x + u.x * along + v.x * across,
      center.y + u.y * along + v.y * across,
      center.z + u.z * along + v.z * across
    ]);
  }
  const built = edge(topologyId, points);
  if (spec.curve !== undefined) {
    built.curve = spec.curve;
  }
  return built;
}

/** The record the kernel publishes for an arc that lies on this circle. */
function circleRecord(spec: ArcSpec): EdgeTopology['curve'] {
  return {
    type: 'CIRCLE',
    circle: {
      center: spec.center ?? ORIGIN,
      axis: spec.axis ?? { x: 0, y: 0, z: 1 },
      radius: spec.radius
    }
  };
}

/** The arc an edge traces, published exactly, as the kernel hands it over. */
function exactArc(topologyId: string, spec: ArcSpec): EdgeTopology {
  return arc(topologyId, { ...spec, curve: circleRecord(spec) });
}

const midpointOf = (edges: EdgeTopology[]): Vector3 => {
  const found = snapsFromEdges(edges).find((c) => c.kind === 'midpoint');
  if (!found) {
    throw new Error('no midpoint snap was offered');
  }
  return found.point;
};

/** A circle in the z = plane, sampled evenly and closed on its seam. */
function circle(
  topologyId: string,
  cx: number,
  cy: number,
  z: number,
  radius: number,
  segments = 24
): EdgeTopology {
  const points: number[][] = [];
  for (let step = 0; step <= segments; step += 1) {
    const angle = (step / segments) * Math.PI * 2;
    points.push([
      cx + Math.cos(angle) * radius,
      cy + Math.sin(angle) * radius,
      z
    ]);
  }
  return edge(topologyId, points);
}

const kinds = (edges: EdgeTopology[]) =>
  snapsFromEdges(edges).map((candidate) => candidate.kind);

describe('what a straight edge offers', () => {
  const line = edge('a', [[0, 0, 0], [10, 0, 0]]);

  it('offers both ends and the middle', () => {
    expect(kinds([line]).sort()).toEqual(['endpoint', 'endpoint', 'midpoint']);
  });

  it('puts the midpoint halfway along', () => {
    const middle = snapsFromEdges([line]).find((c) => c.kind === 'midpoint');
    expect(middle?.point).toEqual({ x: 5, y: 0, z: 0 });
  });

  it('measures the middle by length, not by sample count', () => {
    // A sampler that crowds one end must not drag the midpoint with it.
    const uneven = edge('b', [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [10, 0, 0]
    ]);
    const middle = snapsFromEdges([uneven]).find((c) => c.kind === 'midpoint');
    expect(middle?.point.x).toBeCloseTo(5, 6);
  });

  it('is untouched by the curve record it now carries', () => {
    // A LINE publishes a type and no circle. Its polyline midpoint is already
    // exact, and nothing about the new path may perturb it.
    const straight = edge('line', [[0, 0, 0], [10, 0, 0]]);
    straight.curve = { type: 'LINE' };
    expect(snapsFromEdges([straight])).toEqual(snapsFromEdges([line]));
    expect(midpointOf([straight])).toEqual({ x: 5, y: 0, z: 0 });
  });
});

describe('what a closed edge offers', () => {
  const rim = circle('rim', 4, -2, 7, 3);

  it('offers its centre', () => {
    const found = snapsFromEdges([rim]);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe('center');
    expect(found[0]!.point.x).toBeCloseTo(4, 6);
    expect(found[0]!.point.y).toBeCloseTo(-2, 6);
    expect(found[0]!.point.z).toBeCloseTo(7, 6);
  });

  it('offers no ends, since a ring has none anyone aims at', () => {
    expect(kinds([rim])).toEqual(['center']);
  });

  it('leaves an open edge without a centre', () => {
    const arcish = edge('open', [[0, 0, 0], [3, 4, 0], [6, 0, 0]]);
    expect(kinds([arcish])).not.toContain('center');
  });
});

describe('sharing a model', () => {
  it('offers a shared corner once, not once per edge meeting it', () => {
    const meeting = [
      edge('x', [[0, 0, 0], [10, 0, 0]]),
      edge('y', [[0, 0, 0], [0, 10, 0]]),
      edge('z', [[0, 0, 0], [0, 0, 10]])
    ];
    const corners = snapsFromEdges(meeting).filter(
      (c) => c.kind === 'endpoint' && c.point.x === 0 && c.point.y === 0 && c.point.z === 0
    );
    expect(corners).toHaveLength(1);
  });

  it('narrows to the kinds a caller asked for', () => {
    const model = [edge('a', [[0, 0, 0], [10, 0, 0]]), circle('r', 0, 0, 0, 5)];
    expect(kinds(model)).toContain('midpoint');
    expect(
      snapsFromEdges(model, { kinds: ['endpoint', 'center'] }).map((c) => c.kind)
    ).not.toContain('midpoint');
  });

  it('skips an edge with nothing to measure', () => {
    expect(kinds([edge('degenerate', [[1, 2, 3]])])).toEqual([]);
  });

  it('does not offer snap targets on an invisible periodic seam', () => {
    const seam = edge('seam', [[0, 0, 0], [0, 0, 10]]);
    seam.displayRole = 'seam';
    expect(snapsFromEdges([seam])).toEqual([]);
  });

  it('carries the label a caller supplied, for the readout', () => {
    const labelled = snapsFromEdges([edge('a', [[0, 0, 0], [1, 0, 0]])], {
      label: 'Box Body'
    });
    expect(labelled.every((c) => c.label === 'Box Body')).toBe(true);
  });
});

/**
 * The properties an arc midpoint must have, stated as closed forms rather than
 * as a second implementation of the same arithmetic: the point is on the
 * circle, in its plane, and equidistant along the curve from both ends. Equal
 * chord to both ends is equal subtended angle is equal arc length, on a
 * circle, so the chord test is the arc-length test.
 */
function expectExactArcMidpoint(
  point: Vector3,
  spec: ArcSpec,
  ends: [Vector3, Vector3]
): void {
  const center = spec.center ?? ORIGIN;
  const axis = spec.axis ?? { x: 0, y: 0, z: 1 };
  const tolerance = spec.radius * 1e-9;
  const offset = sub(point, center);
  expect(Math.abs(norm(offset) - spec.radius)).toBeLessThan(tolerance);
  expect(Math.abs(dot(offset, axis))).toBeLessThan(tolerance);
  expect(
    Math.abs(norm(sub(point, ends[0])) - norm(sub(point, ends[1])))
  ).toBeLessThan(tolerance);
}

const endsOf = (built: EdgeTopology): [Vector3, Vector3] => {
  const last = built.points.length / 3 - 1;
  return [
    { x: built.points[0]!, y: built.points[1]!, z: built.points[2]! },
    {
      x: built.points[last * 3]!,
      y: built.points[last * 3 + 1]!,
      z: built.points[last * 3 + 2]!
    }
  ];
};

describe('the midpoint of an arc, taken from the published circle', () => {
  const quarter: ArcSpec = {
    center: { x: 4, y: -2, z: 7 },
    radius: 3,
    sweep: Math.PI / 2
  };

  it('lands on the curve, in its plane, halfway along it by arc length', () => {
    const built = exactArc('fillet', quarter);
    expectExactArcMidpoint(midpointOf([built]), quarter, endsOf(built));
  });

  it('is the point at half the swept angle, in closed form', () => {
    // Independently written: 45 degrees round from the start, not derived from
    // anything the implementation does.
    const built = exactArc('fillet', quarter);
    const expected = {
      x: 4 + Math.cos(Math.PI / 4) * 3,
      y: -2 + Math.sin(Math.PI / 4) * 3,
      z: 7
    };
    const middle = midpointOf([built]);
    expect(norm(sub(middle, expected))).toBeLessThan(3 * 1e-9);
  });

  it('fixes an error the chord midpoint really makes', () => {
    // The thing being repaired, pinned in both sizes it comes in. Left as
    // chords, a quarter arc's polyline midpoint sits radially inside the true
    // arc by r(1 - cos(half a segment)) — a full r(1 - sqrt(2)/2) when the
    // whole arc is one chord, and 4.2e-4 r at the app's real 27-segment
    // sampling. Both are wrong; the second is what shipping code was doing.
    const trueMiddle = {
      x: 4 + Math.cos(Math.PI / 4) * 3,
      y: -2 + Math.sin(Math.PI / 4) * 3,
      z: 7
    };
    const displaySampled = arc('sampled', quarter);
    const singleChord = arc('chord', { ...quarter, segments: 1 });
    expect(displaySampled.points.length / 3).toBe(28);

    const beforeAtDisplaySampling = norm(
      sub(midpointOf([displaySampled]), trueMiddle)
    );
    const beforeAsOneChord = norm(sub(midpointOf([singleChord]), trueMiddle));
    const after = norm(
      sub(midpointOf([exactArc('sampled', quarter)]), trueMiddle)
    );

    expect(beforeAsOneChord / 3).toBeCloseTo(1 - Math.SQRT1_2, 12);
    expect(beforeAtDisplaySampling / 3).toBeCloseTo(
      1 - Math.cos(Math.PI / 2 / 27 / 2),
      12
    );
    expect(beforeAtDisplaySampling / 3).toBeGreaterThan(4.2e-4);
    expect(after).toBeLessThan(3 * 1e-12);
    // The improvement, stated as a ratio so it cannot be met by luck.
    expect(beforeAtDisplaySampling / Math.max(after, Number.MIN_VALUE))
      .toBeGreaterThan(1e8);
  });

  it('takes the long way round when the edge does', () => {
    // Three quarters of a turn shares both endpoints with the quarter it
    // complements. Deriving the midpoint from the ends alone would put this
    // one on the wrong side of the circle, half a diameter out.
    const long: ArcSpec = { radius: 5, sweep: (3 * Math.PI) / 2 };
    const built = exactArc('long', long);
    const middle = midpointOf([built]);
    expectExactArcMidpoint(middle, long, endsOf(built));
    expect(middle.x).toBeCloseTo(5 * Math.cos((3 * Math.PI) / 4), 9);
    expect(middle.y).toBeCloseTo(5 * Math.sin((3 * Math.PI) / 4), 9);
  });

  it('reads a backwards arc the same as a forwards one', () => {
    const forwards = exactArc('f', { radius: 2, sweep: Math.PI / 2 });
    const backwards = exactArc('b', {
      radius: 2,
      startAngle: Math.PI / 2,
      sweep: -Math.PI / 2
    });
    expect(norm(sub(midpointOf([forwards]), midpointOf([backwards])))).toBeLessThan(
      2e-9
    );
  });

  it('does not care which way the unoriented axis is signed', () => {
    // `EdgeCurve.axis` is canonically signed and says nothing about winding,
    // so flipping it must not move the answer.
    const spec: ArcSpec = { radius: 6, sweep: Math.PI / 3, center: { x: 1, y: 2, z: 3 } };
    const built = exactArc('up', spec);
    const flipped = arc('down', spec);
    flipped.curve = {
      type: 'CIRCLE',
      circle: { center: spec.center!, axis: { x: 0, y: 0, z: -1 }, radius: 6 }
    };
    expect(norm(sub(midpointOf([built]), midpointOf([flipped])))).toBeLessThan(
      6e-9
    );
  });

  it('works on a circle whose plane is not a world plane', () => {
    const axis = {
      x: 1 / Math.sqrt(3),
      y: 1 / Math.sqrt(3),
      z: 1 / Math.sqrt(3)
    };
    const seed = { x: 1 / Math.sqrt(2), y: -1 / Math.sqrt(2), z: 0 };
    const tilted: ArcSpec = {
      center: { x: -3, y: 8, z: 2 },
      axis,
      seed,
      radius: 4,
      startAngle: 0.7,
      sweep: 1.9
    };
    const built = exactArc('tilted', tilted);
    expectExactArcMidpoint(midpointOf([built]), tilted, endsOf(built));
  });
});

describe('the same arc at three scales', () => {
  // The tessellation is size-relative, so nothing here may depend on an
  // absolute tolerance. 1x, 1000x and 0.001x of the same shape.
  for (const scale of [1, 1000, 0.001]) {
    it(`is exact at ${scale}x`, () => {
      const spec: ArcSpec = {
        center: { x: 4 * scale, y: -2 * scale, z: 7 * scale },
        radius: 3 * scale,
        sweep: Math.PI / 2
      };
      const built = exactArc('fillet', spec);
      const middle = midpointOf([built]);
      expectExactArcMidpoint(middle, spec, endsOf(built));

      const chordMiddle = midpointOf([arc('plain', spec)]);
      const error = norm(sub(chordMiddle, middle)) / spec.radius;
      // The same relative error at every scale — which is the point.
      expect(error).toBeCloseTo(1 - Math.cos(Math.PI / 2 / 27 / 2), 10);
    });

    it(`puts a rim's centre exactly at ${scale}x`, () => {
      const rim = closedRim(scale);
      const found = snapsFromEdges([rim]);
      expect(found).toHaveLength(1);
      expect(found[0]!.kind).toBe('center');
      expect(
        norm(sub(found[0]!.point, { x: 2 * scale, y: 5 * scale, z: -1 * scale }))
      ).toBeLessThan(10 * scale * 1e-9);
    });
  }
});

/**
 * A bore rim as the kernel publishes it: a full turn that begins a quarter
 * turn away from the edge's own vertex, closed by repeating its first sample,
 * and sampled unevenly enough that averaging the samples is not the centre.
 */
function closedRim(scale = 1): EdgeTopology {
  const center = { x: 2 * scale, y: 5 * scale, z: -1 * scale };
  const radius = 10 * scale;
  const points: number[][] = [];
  const segments = 112;
  for (let step = 0; step < segments; step += 1) {
    // Crowded on one side, as a sampler mixing angular and chordal criteria
    // across a face's UV grid leaves it.
    const t = step / segments;
    const angle = Math.PI / 2 + Math.PI * 2 * (t + 0.12 * Math.sin(Math.PI * 2 * t));
    points.push([
      center.x + Math.cos(angle) * radius,
      center.y + Math.sin(angle) * radius,
      center.z
    ]);
  }
  points.push([...points[0]!]);
  const rim = edge('rim', points);
  rim.curve = {
    type: 'CIRCLE',
    circle: { center, axis: { x: 0, y: 0, z: 1 }, radius }
  };
  return rim;
}

describe('a closed circular edge, the rim case', () => {
  it('still offers only its centre, and no endpoints', () => {
    // The skip is load-bearing: the polyline starts a quarter turn from the
    // vertex, so its first point is not a place anyone aimed at, and neither
    // is the point opposite it.
    expect(kinds([closedRim()])).toEqual(['center']);
  });

  it('takes the centre from the circle, not from the samples', () => {
    const rim = closedRim();
    const truth = { x: 2, y: 5, z: -1 };
    const exact = snapsFromEdges([rim])[0]!.point;

    const sampled = { ...rim };
    delete sampled.curve;
    const averaged = snapsFromEdges([sampled])[0]!.point;

    // Averaging an unevenly sampled ring misses by a measurable amount; the
    // published centre does not miss at all.
    expect(norm(sub(averaged, truth))).toBeGreaterThan(0.05);
    expect(norm(sub(exact, truth))).toBeLessThan(1e-12);
  });

  it('leaves an evenly sampled ring where averaging already had it', () => {
    // No regression for the case the old code got right.
    const even = circle('even', 4, -2, 7, 3);
    const withCurve = { ...even };
    withCurve.curve = {
      type: 'CIRCLE',
      circle: { center: { x: 4, y: -2, z: 7 }, axis: { x: 0, y: 0, z: 1 }, radius: 3 }
    };
    const before = snapsFromEdges([even])[0]!.point;
    const after = snapsFromEdges([withCurve])[0]!.point;
    expect(norm(sub(before, after))).toBeLessThan(3e-9);
  });
});

describe('an edge the kernel would not describe', () => {
  const spec: ArcSpec = { radius: 3, sweep: Math.PI / 2 };

  it('falls back to the polyline when there is no curve record', () => {
    const bare = arc('bare', spec);
    expect(bare.curve).toBeUndefined();
    const middle = midpointOf([bare]);
    // Exactly what this file did before: the polyline midpoint, inside the arc.
    expect(norm(sub(middle, ORIGIN))).toBeCloseTo(
      3 * Math.cos(Math.PI / 2 / 27 / 2),
      12
    );
    expect(kinds([bare]).sort()).toEqual(['endpoint', 'endpoint', 'midpoint']);
  });

  it('falls back when the record names a type with no analytic form', () => {
    const spline = arc('spline', spec);
    spline.curve = { type: 'BSPLINE_CURVE' };
    expect(midpointOf([spline])).toEqual(midpointOf([arc('bare', spec)]));
  });

  it('falls back when a CIRCLE record carries no circle', () => {
    // The kernel publishes the type even when it could not prove the circle.
    const unproven = arc('unproven', spec);
    unproven.curve = { type: 'CIRCLE' };
    expect(midpointOf([unproven])).toEqual(midpointOf([arc('bare', spec)]));
  });

  it('falls back rather than trusting a circle the edge is not on', () => {
    // A guard, not a second opinion: a record whose radius does not fit the
    // edge's own endpoints would otherwise put the snap nowhere near the edge.
    const wrong = arc('wrong', spec);
    wrong.curve = {
      type: 'CIRCLE',
      circle: { center: ORIGIN, axis: { x: 0, y: 0, z: 1 }, radius: 3e12 }
    };
    expect(midpointOf([wrong])).toEqual(midpointOf([arc('bare', spec)]));
  });

  it('falls back rather than emitting a point built from a bad number', () => {
    for (const record of [
      { center: ORIGIN, axis: { x: 0, y: 0, z: 0 }, radius: 3 },
      { center: ORIGIN, axis: { x: 0, y: 0, z: 1 }, radius: 0 },
      { center: ORIGIN, axis: { x: 0, y: 0, z: 1 }, radius: Number.NaN },
      { center: { x: Number.NaN, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, radius: 3 }
    ]) {
      const broken = arc('broken', spec);
      broken.curve = { type: 'CIRCLE', circle: record };
      const middle = midpointOf([broken]);
      expect(Number.isFinite(middle.x)).toBe(true);
      expect(middle).toEqual(midpointOf([arc('bare', spec)]));
    }
  });
});
