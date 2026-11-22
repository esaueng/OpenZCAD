import { describe, expect, it } from 'vitest';
import type {
  BodyId,
  BodyRepresentation,
  EdgeTopology,
  Vector3
} from '@openzcad/shared';
import { snapsFromEdges, type SnapCandidate } from '@openzcad/viewport';
import {
  createDistanceMeasurement,
  measurementTargetFromSelection,
  measurementTargetFromSnap,
  refreshMeasurements,
  type MeasurementTarget
} from '../apps/web/src/lib/measurements';

/**
 * QA15-2E-01: a Distance pick under the "Endpoint" snap glyph recorded the
 * picked edge's MIDPOINT, because the click handed only the snapped position
 * to a derivation that turns any straight-edge pick into its midpoint. 57.31
 * mm was measured where the two corners were 56 apart. The snap now carries
 * which edge point it stood for, and the pick records that point.
 */

const BODY_ID = 'body-block' as BodyId;

function line(
  topologyId: string,
  hash: number,
  from: Vector3,
  to: Vector3
): EdgeTopology {
  return {
    topologyId,
    hash,
    length: Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z),
    curve: { type: 'LINE' },
    points: [from.x, from.y, from.z, to.x, to.y, to.z],
    vertexIds: [from.x * 1000 + from.y, to.x * 1000 + to.y]
  };
}

/** A quarter arc of radius 4 about (10, 20, 5), sampled every 30 degrees. */
function arc(): EdgeTopology {
  const at = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return [10 + 4 * Math.cos(radians), 20 + 4 * Math.sin(radians), 5];
  };
  return {
    topologyId: 'edge:arc',
    hash: 31,
    length: 2 * Math.PI,
    curve: {
      type: 'CIRCLE',
      circle: {
        center: { x: 10, y: 20, z: 5 },
        axis: { x: 0, y: 0, z: 1 },
        radius: 4
      }
    },
    points: [0, 30, 60, 90].flatMap(at)
  };
}

/** A full rim of radius 2 about (0, 0, 10); the polyline closes on itself. */
function rim(): EdgeTopology {
  return {
    topologyId: 'edge:rim',
    hash: 32,
    length: 4 * Math.PI,
    curve: {
      type: 'CIRCLE',
      circle: {
        center: { x: 0, y: 0, z: 10 },
        axis: { x: 0, y: 0, z: 1 },
        radius: 2
      }
    },
    points: [2, 0, 10, 0, 2, 10, -2, 0, 10, 0, -2, 10, 2, 0, 10]
  };
}

/** The top edges of a 56 x 30 x 10 block, plus an arc and a rim. */
const front = line(
  'edge:front',
  11,
  { x: 0, y: 0, z: 10 },
  { x: 56, y: 0, z: 10 }
);
const left = line(
  'edge:left',
  12,
  { x: 0, y: 0, z: 10 },
  { x: 0, y: 30, z: 10 }
);
const back = line(
  'edge:back',
  13,
  { x: 0, y: 30, z: 10 },
  { x: 56, y: 30, z: 10 }
);

function block(
  edges: EdgeTopology[] = [front, left, back, arc(), rim()]
): BodyRepresentation {
  return {
    bodyId: BODY_ID,
    name: 'Block',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([]),
      indices: Uint32Array.from([])
    },
    faceCount: 0,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: 56 * 30 * 10,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 56, y: 30, z: 10 } },
    topology: { edges, faces: [] }
  };
}

/** The snap a pointer at `point` would resolve to among `edges`. */
function snapAt(
  edges: EdgeTopology[],
  kind: SnapCandidate['kind'],
  point: Vector3
): SnapCandidate {
  const found = snapsFromEdges(edges).find(
    (candidate) =>
      candidate.kind === kind &&
      Math.hypot(
        candidate.point.x - point.x,
        candidate.point.y - point.y,
        candidate.point.z - point.z
      ) < 1e-9
  );
  if (!found) {
    throw new Error(`no ${kind} snap at ${JSON.stringify(point)}`);
  }
  return found;
}

function snapTarget(
  body: BodyRepresentation,
  snap: SnapCandidate
): MeasurementTarget | null {
  return measurementTargetFromSnap(body, snap.source!, snap.point);
}

describe('QA15-2E-01: a snapped Distance pick records the snapped point', () => {
  it('measures corner to corner across two Endpoint snaps', () => {
    const body = block();
    // Pointer on the left edge near its start, then on the front edge near
    // its far end: both glyphs read "Endpoint".
    const first = snapAt([left, front], 'endpoint', { x: 0, y: 30, z: 10 });
    const second = snapAt([front, left], 'endpoint', { x: 56, y: 0, z: 10 });
    expect(first.source).toMatchObject({
      edgeTopologyId: 'edge:left',
      role: 'end'
    });
    expect(second.source).toMatchObject({
      edgeTopologyId: 'edge:front',
      role: 'end'
    });

    const a = snapTarget(body, first)!;
    const b = snapTarget(body, second)!;
    expect(a).toMatchObject({
      semantic: 'vertex-end',
      point: { x: 0, y: 30, z: 10 }
    });
    expect(b).toMatchObject({
      semantic: 'vertex-end',
      point: { x: 56, y: 0, z: 10 }
    });
    const measured = createDistanceMeasurement(a, b, 1, 'mm')!;
    expect(measured.result.value).toBeCloseTo(Math.hypot(56, 30), 12);
    expect(measured.quality).toBe('exact-analytic');

    // What the click used to record for the same two picks: each edge's
    // midpoint, whatever the glyph had said.
    const legacy = createDistanceMeasurement(
      measurementTargetFromSelection(
        body,
        { bodyId: BODY_ID, kind: 'edge', topologyId: 'edge:left', hash: 12 },
        first.point,
        'distance'
      )!,
      measurementTargetFromSelection(
        body,
        { bodyId: BODY_ID, kind: 'edge', topologyId: 'edge:front', hash: 11 },
        second.point,
        'distance'
      )!,
      1,
      'mm'
    )!;
    expect(legacy.result.value).not.toBeCloseTo(measured.result.value, 3);
  });

  it('records a snapped start vertex rather than the edge it was picked from', () => {
    const body = block();
    const start = snapAt([front], 'endpoint', { x: 0, y: 0, z: 10 });
    const end = snapAt([front], 'endpoint', { x: 56, y: 0, z: 10 });
    const measured = createDistanceMeasurement(
      snapTarget(body, start)!,
      snapTarget(body, end)!,
      1,
      'mm'
    )!;
    expect(measured.result.value).toBeCloseTo(56, 12);
    expect(measured.targets[0]).toMatchObject({ semantic: 'vertex-start' });
  });

  it("records a Midpoint snap on a neighbouring edge as that edge's midpoint", () => {
    const body = block();
    const middle = snapAt([front, left, back], 'midpoint', {
      x: 28,
      y: 30,
      z: 10
    });
    expect(snapTarget(body, middle)).toMatchObject({
      topologyId: 'edge:back',
      semantic: 'edge-midpoint',
      point: { x: 28, y: 30, z: 10 }
    });
  });

  it('agrees with the snap on an arc midpoint and a rim centre', () => {
    const body = block();
    const arcMiddle = snapAt(
      [arc()],
      'midpoint',
      snapsFromEdges([arc()]).find((c) => c.kind === 'midpoint')!.point
    );
    const target = snapTarget(body, arcMiddle)!;
    expect(target.semantic).toBe('edge-midpoint');
    expect(target.point!.x).toBeCloseTo(10 + 4 * Math.SQRT1_2, 9);
    expect(target.point!.y).toBeCloseTo(20 + 4 * Math.SQRT1_2, 9);

    const centre = snapAt([rim()], 'center', { x: 0, y: 0, z: 10 });
    expect(snapTarget(body, centre)).toMatchObject({
      semantic: 'circle-center',
      point: { x: 0, y: 0, z: 10 }
    });
  });

  it('refuses a source that no longer yields the point the glyph marked', () => {
    const snap = snapAt([front], 'endpoint', { x: 56, y: 0, z: 10 });
    // The same identity now answers with a shorter edge.
    const moved = line(
      'edge:front',
      11,
      { x: 0, y: 0, z: 10 },
      { x: 40, y: 0, z: 10 }
    );
    expect(snapTarget(block([moved, left, back]), snap)).toBeNull();
    // And an identity that resolves to nothing at all.
    expect(snapTarget(block([left, back]), snap)).toBeNull();
  });

  it('keeps the snapped vertex when a rebuild reverses its edge', () => {
    // The edge's fingerprint does not depend on its direction, so the same
    // identity can come back sampled the other way round; "start" must not
    // then quietly name the far vertex.
    const body = block();
    const measured = createDistanceMeasurement(
      snapTarget(body, snapAt([front], 'endpoint', { x: 0, y: 0, z: 10 }))!,
      snapTarget(body, snapAt([back], 'endpoint', { x: 0, y: 30, z: 10 }))!,
      1,
      'mm'
    )!;
    expect(measured.result.value).toBeCloseTo(30, 12);
    const reversed = line(
      'edge:front',
      11,
      { x: 56, y: 0, z: 10 },
      { x: 0, y: 0, z: 10 }
    );
    const [refreshed] = refreshMeasurements(
      [measured],
      [block([reversed, left, back])],
      2
    );
    expect(refreshed!.status).toBe('current');
    expect(refreshed!.result.value).toBeCloseTo(30, 12);
  });

  it('keeps the snapped vertex through a rebuild', () => {
    const body = block();
    const measured = createDistanceMeasurement(
      snapTarget(body, snapAt([left], 'endpoint', { x: 0, y: 30, z: 10 }))!,
      snapTarget(body, snapAt([front], 'endpoint', { x: 56, y: 0, z: 10 }))!,
      1,
      'mm'
    )!;
    const [refreshed] = refreshMeasurements([measured], [block()], 2);
    expect(refreshed!.status).toBe('current');
    expect(refreshed!.result.value).toBeCloseTo(Math.hypot(56, 30), 12);
  });
});
