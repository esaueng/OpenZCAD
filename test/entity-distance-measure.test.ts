import { describe, expect, it } from 'vitest';
import type {
  BodyId,
  BodyRepresentation,
  EdgeTopology,
  TopologySelection
} from '@openzcad/shared';
import {
  centralDistance,
  maximumDistance,
  parallelDistance,
  type MeasureEntity
} from '../apps/web/src/lib/measureDistances';
import {
  createEntityDistanceMeasurement,
  formatMeasurement,
  measurementTargetFromSelection,
  refreshMeasurements,
  type Measurement
} from '../apps/web/src/lib/measurements';
import {
  buildMeasurementRecord,
  parseStoredMeasurements
} from '../apps/web/src/lib/measurementStore';

/**
 * M13: maximum, central and parallel distances, in closed form from exact
 * entity geometry, with the span each one measured. Pairs without a closed
 * form here are refused with a reason, never estimated.
 */
const p = (x: number, y: number, z: number) => ({ x, y, z });
const Z = p(0, 0, 1);
const point = (x: number, y: number, z: number): MeasureEntity => ({
  type: 'point',
  point: p(x, y, z)
});
const segment = (
  a: [number, number, number],
  b: [number, number, number]
): MeasureEntity => ({ type: 'segment', start: p(...a), end: p(...b) });
const circle = (
  center: [number, number, number],
  radius: number,
  closed = true
): MeasureEntity => ({
  type: 'circle',
  center: p(...center),
  axis: Z,
  radius,
  closed
});
const refusal = (answer: object): string =>
  'refused' in answer ? String(answer.refused) : 'not refused';
const value = (answer: ReturnType<typeof maximumDistance>) => {
  if ('refused' in answer) throw new Error(answer.refused);
  return answer.value;
};

describe('maximum distance (M13)', () => {
  it('is reached at segment ends', () => {
    const answer = maximumDistance(
      segment([0, 0, 0], [10, 0, 0]),
      segment([0, 5, 0], [0, 5, 3])
    );
    expect(value(answer)).toBeCloseTo(Math.hypot(10, 5, 3), 12);
    expect(answer).toMatchObject({ from: p(10, 0, 0), to: p(0, 5, 3) });
  });

  it('reaches the rim opposite a point: √(h² + (ρ + r)²)', () => {
    // ρ = 3 off the axis, h = 4 above the rim plane, r = 2.
    const answer = maximumDistance(point(3, 0, 4), circle([0, 0, 0], 2));
    expect(value(answer)).toBeCloseTo(Math.hypot(4, 5), 12);
    expect(answer).toMatchObject({ to: p(-2, 0, 0) });
    // On the axis every rim point is as far: √(h² + r²).
    expect(value(maximumDistance(point(0, 0, 4), circle([0, 0, 0], 3)))).toBe(
      5
    );
  });

  it('takes a segment against a circle at the farther end', () => {
    const answer = maximumDistance(
      circle([0, 0, 0], 1),
      segment([2, 0, 0], [5, 0, 0])
    );
    expect(value(answer)).toBeCloseTo(6, 12);
    expect(answer).toMatchObject({ from: p(-1, 0, 0), to: p(5, 0, 0) });
  });

  it('refuses arcs, faces and circle pairs rather than estimating them', () => {
    expect(
      refusal(maximumDistance(point(0, 0, 0), circle([0, 0, 0], 1, false)))
    ).toMatch(/arc needs the kernel/);
    expect(
      refusal(
        maximumDistance(point(0, 0, 0), {
          type: 'plane',
          point: p(0, 0, 0),
          normal: Z
        })
      )
    ).toMatch(/not faces/);
    expect(
      refusal(maximumDistance(circle([0, 0, 0], 1), circle([5, 0, 0], 1)))
    ).toMatch(/two circles needs the kernel/);
  });
});

describe('central distance (M13)', () => {
  it('measures from a circle centre to the other pick', () => {
    expect(
      value(
        centralDistance(
          circle([1, 1, 0], 2),
          p(1, 1, 0),
          point(4, 5, 0),
          p(4, 5, 0)
        )
      )
    ).toBe(5);
  });

  it('measures square from a cylinder axis, whichever pick it is', () => {
    const cylinder: MeasureEntity = {
      type: 'cylinder',
      origin: p(0, 0, 0),
      axis: Z,
      radius: 3
    };
    const answer = centralDistance(
      point(6, 8, 20),
      p(6, 8, 20),
      cylinder,
      p(0, 0, 10)
    );
    expect(value(answer)).toBe(10);
    expect(answer).toMatchObject({ from: p(0, 0, 20), note: 'from axis' });
  });

  it('refuses two picks with neither a centre nor an axis', () => {
    expect(
      refusal(
        centralDistance(point(0, 0, 0), p(0, 0, 0), point(1, 0, 0), p(1, 0, 0))
      )
    ).toMatch(/to measure from/);
  });
});

describe('parallel distance (M13)', () => {
  it('measures between parallel edges, faces and an edge on a face', () => {
    expect(
      value(
        parallelDistance(
          segment([0, 0, 0], [10, 0, 0]),
          segment([3, 4, 0], [-2, 4, 0]),
          10
        )
      )
    ).toBeCloseTo(4, 12);
    const top: MeasureEntity = { type: 'plane', point: p(5, 5, 10), normal: Z };
    const bottom: MeasureEntity = {
      type: 'plane',
      point: p(1, 2, 0),
      normal: p(0, 0, -1)
    };
    const between = parallelDistance(top, bottom, 10);
    expect(value(between)).toBe(10);
    expect(between).toMatchObject({ from: p(5, 5, 10), to: p(5, 5, 0) });
    expect(
      value(parallelDistance(segment([0, 0, 3], [4, 4, 3]), bottom, 10))
    ).toBe(3);
  });

  it('reads two concentric circles or cylinders as their radial difference', () => {
    const bore: MeasureEntity = {
      type: 'cylinder',
      origin: p(0, 0, -5),
      axis: Z,
      radius: 4
    };
    const answer = parallelDistance(circle([0, 0, 10], 6.5), bore, 20);
    expect(value(answer)).toBeCloseTo(2.5, 12);
    expect(answer).toMatchObject({ note: 'radial difference' });
    // Offset axes are parallel lines, not a radial difference.
    expect(
      parallelDistance(circle([3, 4, 0], 1), circle([0, 0, 0], 2), 20)
    ).toMatchObject({ value: 5 });
  });

  it('refuses pairs that are not parallel', () => {
    expect(
      parallelDistance(
        segment([0, 0, 0], [1, 0, 0]),
        segment([0, 0, 0], [1, 1, 0]),
        1
      )
    ).toEqual({ refused: 'Those edges or axes are not parallel.' });
    expect(
      parallelDistance(
        { type: 'plane', point: p(0, 0, 0), normal: Z },
        { type: 'plane', point: p(0, 0, 0), normal: p(1, 0, 0) },
        1
      )
    ).toEqual({ refused: 'Those faces are not parallel.' });
    expect(
      refusal(
        parallelDistance(
          segment([0, 0, 0], [0, 0, 1]),
          { type: 'plane', point: p(0, 0, 0), normal: Z },
          1
        )
      )
    ).toMatch(/not parallel to the face/);
  });
});

/** A ring: an outer rim (r 10) and a bore (r 4) about Z, plus a top face. */
const BODY_ID = 'body-ring' as BodyId;
function rim(
  id: string,
  hash: number,
  radius: number,
  z: number
): EdgeTopology {
  const points: number[] = [];
  for (let step = 0; step <= 4; step += 1) {
    const angle = (step / 4) * Math.PI * 2;
    points.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
  }
  return {
    topologyId: id,
    hash,
    length: 2 * Math.PI * radius,
    curve: {
      type: 'CIRCLE',
      circle: { center: p(0, 0, z), axis: Z, radius }
    },
    points
  };
}
function ring(boreRadius = 4): BodyRepresentation {
  return {
    bodyId: BODY_ID,
    name: 'Ring',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([]),
      indices: Uint32Array.from([])
    },
    faceCount: 2,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: 1000,
    bbox: { min: p(-10, -10, 0), max: p(10, 10, 5) },
    topology: {
      edges: [rim('edge:outer', 1, 10, 5)],
      faces: [
        {
          topologyId: 'face:bore',
          hash: 2,
          triangleStart: 0,
          triangleCount: 8,
          geometry: {
            surfaceType: 'cylinder',
            area: 2 * Math.PI * boreRadius * 5,
            center: p(0, 0, 2.5),
            radius: boreRadius,
            diameter: boreRadius * 2,
            axisStart: p(0, 0, 0),
            axisEnd: p(0, 0, 5)
          }
        }
      ]
    }
  };
}
const select = (
  kind: TopologySelection['kind'],
  topologyId: string,
  hash: number
): TopologySelection => ({ bodyId: BODY_ID, kind, topologyId, hash });

describe('entity distance measurements (M13)', () => {
  const display = {
    unit: 'mm' as const,
    precision: 2,
    radialDisplay: 'diameter' as const
  };

  function wall(body: BodyRepresentation) {
    const outer = measurementTargetFromSelection(
      body,
      select('edge', 'edge:outer', 1),
      undefined,
      'distance'
    )!;
    const bore = measurementTargetFromSelection(
      body,
      select('face', 'face:bore', 2),
      undefined,
      'distance'
    )!;
    return createEntityDistanceMeasurement(
      'parallel',
      [body],
      outer,
      bore,
      1,
      'mm'
    );
  }

  it('records a ring wall as the rim-to-bore radial difference, and says so', () => {
    const measured = wall(ring()) as Measurement;
    expect(measured.kind).toBe('parallel-distance');
    expect(measured.result.value).toBeCloseTo(6, 12);
    expect(measured.quality).toBe('exact-analytic');
    expect(measured.annotation?.segments).toHaveLength(1);
    expect(formatMeasurement(measured, display)).toMatchObject({
      value: '6.00 mm',
      detail: 'Parallel distance, radial difference'
    });
  });

  it('refreshes by identity when the bore changes, and survives the store', () => {
    const measured = wall(ring()) as Measurement;
    const [refreshed] = refreshMeasurements([measured], [ring(3)], 2);
    expect(refreshed!.status).toBe('current');
    expect(refreshed!.result.value).toBeCloseTo(7, 12);
    const stored = parseStoredMeasurements(
      JSON.parse(
        JSON.stringify(
          buildMeasurementRecord(
            'p',
            [measured],
            display,
            '2026-11-21T00:00:00.000Z'
          )
        )
      )
    );
    expect(stored?.measurements[0]?.kind).toBe('parallel-distance');
  });

  it('refuses a whole-body pick with the reason', () => {
    const body = ring();
    const whole = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'body' },
      undefined,
      'distance'
    )!;
    expect(
      refusal(
        createEntityDistanceMeasurement(
          'maximum',
          [body],
          whole,
          whole,
          1,
          'mm'
        )
      )
    ).toMatch(/whole body/);
  });
});

/** M13 review fixes: edge picks, roundoff, tiny arcs, resize, rim spans. */
describe('entity distances, review fixes', () => {
  function plate(edges: EdgeTopology[], faces: NonNullable<BodyRepresentation['topology']>['faces'] = []): BodyRepresentation {
    return {
      ...ring(),
      bbox: { min: p(0, 0, 0), max: p(10, 4, 10) },
      topology: { edges, faces }
    };
  }
  const lineEdge = (id: string, hash: number, a: number[], b: number[]) => ({
    topologyId: id,
    hash,
    length: Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!),
    curve: { type: 'LINE' },
    points: [...a, ...b]
  });

  it('measures a straight edge pick as the edge, not its midpoint', () => {
    const body = plate([
      lineEdge('edge:a', 1, [0, 0, 0], [10, 0, 0]),
      lineEdge('edge:b', 2, [0, 4, 0], [10, 4, 0])
    ]);
    const pick = (id: string, hash: number) =>
      measurementTargetFromSelection(
        body,
        select('edge', id, hash),
        undefined,
        'distance'
      )!;
    const a = pick('edge:a', 1);
    const b = pick('edge:b', 2);
    const most = createEntityDistanceMeasurement('maximum', [body], a, b, 1, 'mm') as Measurement;
    expect(most.result.value).toBeCloseTo(Math.hypot(10, 4), 12);
    const apart = createEntityDistanceMeasurement('parallel', [body], a, b, 1, 'mm') as Measurement;
    expect(apart.result.value).toBeCloseTo(4, 12);
  });

  it('keeps a far on-axis point on the axis despite roundoff', () => {
    const axis = p(Math.SQRT1_2, Math.SQRT1_2, 0);
    const answer = maximumDistance(point(10, 10, 0), {
      type: 'circle',
      center: p(0, 0, 0),
      axis,
      radius: 5,
      closed: true
    });
    expect(value(answer)).toBeCloseTo(15, 9);
  });

  it('refuses a tiny arc of a huge circle as an arc, not a full rim', () => {
    const r = 1_000_000;
    const sweep = 5e-10;
    const arc: EdgeTopology = {
      topologyId: 'edge:tiny',
      hash: 9,
      length: r * sweep,
      curve: {
        type: 'CIRCLE',
        circle: { center: p(0, 0, 0), axis: Z, radius: r }
      },
      points: [r, 0, 0, r * Math.cos(sweep), r * Math.sin(sweep), 0]
    };
    const body = plate([arc, lineEdge('edge:far', 3, [2 * r, 0, 0], [2 * r, 1, 0])]);
    const target = (id: string, hash: number) =>
      measurementTargetFromSelection(body, select('edge', id, hash), undefined, 'distance')!;
    const made = createEntityDistanceMeasurement(
      'maximum',
      [body],
      target('edge:tiny', 9),
      target('edge:far', 3),
      1,
      'mm'
    );
    expect(refusal(made)).toMatch(/arc needs the kernel/);
  });

  it('refreshes a parallel face pair after a resize moves one face', () => {
    const face = (id: string, hash: number, z: number) => ({
      topologyId: id,
      hash,
      triangleStart: 0,
      triangleCount: 2,
      geometry: {
        surfaceType: 'plane',
        area: 40,
        center: p(5, 2, z),
        centroid: p(5, 2, z),
        centroidProvenance: 'exact' as const,
        normal: z > 0 ? Z : p(0, 0, -1)
      }
    });
    const before = plate([], [face('face:top', 21, 10), face('face:bottom', 22, 0)]);
    const pick = (body: BodyRepresentation, id: string, hash: number, z: number) =>
      measurementTargetFromSelection(body, select('face', id, hash), p(3, 1, z), 'distance')!;
    const row = createEntityDistanceMeasurement(
      'parallel',
      [before],
      pick(before, 'face:top', 21, 10),
      pick(before, 'face:bottom', 22, 0),
      1,
      'mm'
    ) as Measurement;
    expect(row.result.value).toBeCloseTo(10, 12);
    // The top face moved up: same identity, new place.
    const after = plate([], [face('face:top', 21, 20), face('face:bottom', 22, 0)]);
    const [refreshed] = refreshMeasurements([row], [after], 2);
    expect(refreshed!.status).toBe('current');
    expect(refreshed!.result.value).toBeCloseTo(20, 12);
  });

  it('ends a radial difference on each picked rim', () => {
    const answer = parallelDistance(circle([0, 0, 0], 6), circle([0, 0, 10], 4), 20);
    expect(value(answer)).toBeCloseTo(2, 12);
    if ('refused' in answer) throw new Error(answer.refused);
    expect(answer.from.z).toBe(0);
    expect(answer.to.z).toBe(10);
  });
});
