import { describe, expect, it } from 'vitest';
import type {
  BodyId,
  BodyRepresentation,
  FaceTopologyReferenceV5,
  FeatureId
} from '@openzcad/shared';
import {
  createAngleMeasurement,
  createDistanceMeasurement,
  createEdgeTotalMeasurement,
  createSmartMeasurement,
  formatMeasurement,
  measurementsToCsv,
  measurementTargetFromSelection,
  measurementToViewportAnnotation,
  refreshMeasurements,
  type Measurement,
  type MeasurementDisplayOptions,
  type MeasurementTarget
} from '../apps/web/src/lib/measurements';
import {
  buildMeasurementRecord,
  parseStoredMeasurements
} from '../apps/web/src/lib/measurementStore';

/**
 * What happens to a measurement when the model underneath it changes.
 *
 * These are the cases that matter once measurements outlive the pick that made
 * them — which is the whole direction of the overhaul — and each one was
 * previously wrong in a way that only shows up on the second rebuild.
 */

const BODY_ID = 'body-1' as BodyId;
const DISPLAY: MeasurementDisplayOptions = {
  unit: 'mm',
  precision: 2,
  radialDisplay: 'diameter'
};

function bodyWith(
  faces: NonNullable<BodyRepresentation['topology']>['faces'],
  edges: NonNullable<BodyRepresentation['topology']>['edges'] = []
): BodyRepresentation {
  return {
    bodyId: BODY_ID,
    name: 'Plate',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([]),
      indices: Uint32Array.from([])
    },
    faceCount: faces.length,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: 1000,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
    topology: { faces, edges }
  };
}

function faceLineage(
  lineageName: string,
  currentHash: number
): FaceTopologyReferenceV5 {
  return {
    kind: 'face',
    producingFeatureId: 'feature-1' as FeatureId,
    lineageName,
    currentHash,
    witnessVersion: 1,
    witness: {
      surfaceType: 'plane',
      perimeter: 40,
      centroid: [5, 5, 0],
      analytic: { kind: 'none' },
      closure: { u: 'open', v: 'open' }
    }
  };
}

function planarFace(
  hash: number,
  z: number,
  reference?: FaceTopologyReferenceV5
) {
  return {
    topologyId: `face:${hash}`,
    hash,
    ...(reference ? { reference } : {}),
    triangleStart: 0,
    triangleCount: 2,
    geometry: {
      surfaceType: 'plane',
      area: 100,
      center: { x: 5, y: 5, z },
      centroid: { x: 5, y: 5, z },
      centroidProvenance: 'exact' as const,
      normal: { x: 0, y: 0, z: 1 }
    }
  };
}

function straightEdge(hash: number, length: number) {
  return {
    topologyId: `edge:${hash}`,
    hash,
    length,
    curve: { type: 'LINE' },
    points: [0, 0, 0, length, 0, 0]
  };
}

describe('a raw surface pick across a rebuild', () => {
  it('survives when the hash still resolves, and stays honest about it', () => {
    // A distance measured from an arbitrary point on a face used to be
    // discarded on every rebuild, because `resolvedTarget` refused any target
    // whose semantic was `pick` outside smart mode. It is recoverable: the
    // ADR-011 hash is a fingerprint of quantized geometry, so its resolving is
    // proof the surface has not moved and the stored point is still on it.
    const body = bodyWith([planarFace(21, 10), planarFace(22, 0)]);
    const first = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 21 },
      { x: 2, y: 3, z: 10 },
      'distance'
    )!;
    const second = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 22 },
      { x: 2, y: 3, z: 0 },
      'distance'
    )!;
    expect(first.semantic).toBe('pick');

    const measured = createDistanceMeasurement(first, second, 1, 'mm')!;
    expect(measured.result.value).toBeCloseTo(10, 9);

    const refreshed = refreshMeasurements([measured], [body], 2);
    expect(refreshed[0]!.status).toBe('current');
    expect(refreshed[0]!.result.value).toBeCloseTo(10, 9);
    // The figure is still only as good as the pick that made it.
    expect(refreshed[0]!.quality).toBe('sampled');
  });

  it('is dropped rather than carried onto geometry that moved', () => {
    // The other half of the rule. If the hash no longer resolves, the surface
    // is not where it was, and re-anchoring the old point would be inventing a
    // position — which ADR-011 forbids outright.
    const body = bodyWith([planarFace(21, 10), planarFace(22, 0)]);
    const first = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 21 },
      { x: 2, y: 3, z: 10 },
      'distance'
    )!;
    const second = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 22 },
      { x: 2, y: 3, z: 0 },
      'distance'
    )!;
    const measured = createDistanceMeasurement(first, second, 1, 'mm')!;

    // The top face moves, so it re-fingerprints. Nothing carries hash 21.
    const moved = bodyWith([planarFace(31, 25), planarFace(22, 0)]);
    const refreshed = refreshMeasurements([measured], [moved], 2);
    expect(refreshed[0]!.status).toBe('unresolved');
    expect(refreshed[0]!.reason).toBe('not-found');
    // The last known value is kept so a reader can still see what it WAS.
    expect(refreshed[0]!.result.value).toBeCloseTo(10, 9);
  });

  it('clears an obsolete resolution reason when only lineage still resolves', () => {
    const topLineage = faceLineage('top', 21);
    const body = bodyWith([planarFace(21, 10, topLineage), planarFace(22, 0)]);
    const first = measurementTargetFromSelection(
      body,
      {
        bodyId: BODY_ID,
        kind: 'face',
        hash: 21,
        reference: topLineage
      },
      { x: 2, y: 3, z: 10 },
      'distance'
    )!;
    const second = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 22 },
      { x: 2, y: 3, z: 0 },
      'distance'
    )!;
    const measured = createDistanceMeasurement(first, second, 1, 'mm')!;
    const receipt: Measurement = {
      ...measured,
      status: 'unresolved',
      reason: 'body-missing',
      annotation: undefined
    };
    const moved = bodyWith([
      planarFace(31, 25, faceLineage('top', 31)),
      planarFace(22, 0)
    ]);

    const stale = refreshMeasurements([receipt], [moved], 1, { force: true });
    expect(stale[0]!.status).toBe('stale');
    expect(stale[0]!.reason).toBeUndefined();

    const again = refreshMeasurements(stale, [moved], 1, { force: true });
    expect(again).toBe(stale);
    expect(again[0]).toBe(stale[0]);
  });
});

describe('an identity that stops being unique', () => {
  it('goes unresolved with an ambiguous reason rather than rebinding', () => {
    // Two faces carrying one hash is not hypothetical — a sphere primitive
    // publishes exactly that. Before failing closed, this silently rebound to
    // whichever came first and went on reporting a confident number.
    const body = bodyWith([planarFace(21, 10)]);
    const measured = createSmartMeasurement(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 21 },
      undefined,
      1,
      'mm'
    )!;
    expect(measured.status).toBe('current');

    const twinned = bodyWith([planarFace(21, 10), planarFace(21, 0)]);
    const refreshed = refreshMeasurements([measured], [twinned], 2);
    expect(refreshed[0]!.status).toBe('unresolved');
    expect(refreshed[0]!.reason).toBe('ambiguous');
  });

  it('names a vanished body distinctly from vanished topology', () => {
    const body = bodyWith([planarFace(21, 10)]);
    const measured = createSmartMeasurement(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 21 },
      undefined,
      1,
      'mm'
    )!;
    const refreshed = refreshMeasurements([measured], [], 2);
    expect(refreshed[0]!.status).toBe('unresolved');
    expect(refreshed[0]!.reason).toBe('body-missing');
  });

  it('sheds the reason when the row starts resolving again', () => {
    // Undo exists. A row that recovers must not keep an explanation beside a
    // fresh number.
    const body = bodyWith([planarFace(21, 10)]);
    const measured = createSmartMeasurement(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 21 },
      undefined,
      1,
      'mm'
    )!;
    const broken = refreshMeasurements([measured], [], 2);
    expect(broken[0]!.reason).toBe('body-missing');

    const recovered = refreshMeasurements(broken, [body], 3);
    expect(recovered[0]!.status).toBe('current');
    expect(recovered[0]!.reason).toBeUndefined();
  });
});

describe('the refresh short-circuit', () => {
  it('advances checkedRevision on the failing branch too', () => {
    // The bug this pins: the failing branch returned the row with its ORIGINAL
    // revision, so it never matched the equality check at the top of the
    // loop and re-evaluated on every single refresh thereafter — including the
    // ones triggered by merely hiding a body, which is how a row could go on
    // demoting itself against a body list it was never meant to be judged by.
    const body = bodyWith([planarFace(21, 10)]);
    const measured = createSmartMeasurement(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 21 },
      undefined,
      1,
      'mm'
    )!;

    const broken = refreshMeasurements([measured], [], 2);
    expect(broken[0]!.checkedRevision).toBe(2);
    // #2360: the retained number still names the revision that produced it.
    expect(broken[0]!.sourceRevision).toBe(1);

    // Same revision, so the row is returned untouched by identity — proof the
    // short-circuit now covers failed rows rather than only successful ones.
    const again = refreshMeasurements(broken, [], 2);
    expect(again).toBe(broken);
    expect(again[0]).toBe(broken[0]);
  });

  it('leaves a resolving row alone when the revision has not moved', () => {
    const body = bodyWith([], [straightEdge(11, 10)]);
    const measured = createSmartMeasurement(
      body,
      { bodyId: BODY_ID, kind: 'edge', hash: 11 },
      undefined,
      1,
      'mm'
    )!;
    const list: Measurement[] = [measured];
    expect(refreshMeasurements(list, [body], 1)).toBe(list);
  });

  it('can recover a persisted transient failure at the same revision', () => {
    const body = bodyWith([], [straightEdge(11, 10)]);
    const measured = createSmartMeasurement(
      body,
      { bodyId: BODY_ID, kind: 'edge', hash: 11 },
      undefined,
      1,
      'mm'
    )!;
    const receipt: Measurement = {
      ...measured,
      status: 'unresolved',
      reason: 'body-missing',
      annotation: undefined
    };
    const list = [receipt];

    // Ordinary same-revision refreshes retain their identity fast path.
    expect(refreshMeasurements(list, [body], 1)).toBe(list);

    // Applying persisted state is an authoritative arrival and may follow an
    // earlier refresh against bodies that were not ready yet.
    const recovered = refreshMeasurements(list, [body], 1, { force: true });
    expect(recovered[0]!.status).toBe('current');
    expect(recovered[0]!.reason).toBeUndefined();
    expect(recovered[0]!.annotation).toBeDefined();
  });
});

describe('malformed persisted target counts', () => {
  it('fails an empty body row closed during a forced same-revision refresh', () => {
    const body = bodyWith([]);
    const measured = createSmartMeasurement(
      body,
      { bodyId: BODY_ID, kind: 'body' },
      undefined,
      1,
      'mm'
    )!;
    const malformed: Measurement = { ...measured, targets: [] };

    const refreshed = refreshMeasurements([malformed], [body], 1, {
      force: true
    });

    expect(refreshed[0]).toMatchObject({
      status: 'unresolved',
      reason: 'not-found',
      sourceRevision: 1,
      targets: []
    });
    expect(refreshed[0]!.result).toEqual(malformed.result);
  });

  it('fails a sparse single-target row closed instead of dereferencing a hole', () => {
    const body = bodyWith([]);
    const measured = createSmartMeasurement(
      body,
      { bodyId: BODY_ID, kind: 'body' },
      undefined,
      1,
      'mm'
    )!;
    const malformed: Measurement = {
      ...measured,
      targets: Array<MeasurementTarget>(1)
    };

    const refreshed = refreshMeasurements([malformed], [body], 1, {
      force: true
    });

    expect(refreshed[0]).toMatchObject({
      status: 'unresolved',
      reason: 'not-found',
      sourceRevision: 1
    });
  });

  it.each(['distance', 'angle'] as const)(
    'fails an incomplete %s row closed during a forced same-revision refresh',
    (kind) => {
      const body = bodyWith([planarFace(21, 10), planarFace(22, 0)]);
      const first = measurementTargetFromSelection(
        body,
        { bodyId: BODY_ID, kind: 'face', hash: 21 },
        kind === 'distance' ? { x: 2, y: 3, z: 10 } : undefined,
        kind
      )!;
      const second = measurementTargetFromSelection(
        body,
        { bodyId: BODY_ID, kind: 'face', hash: 22 },
        kind === 'distance' ? { x: 2, y: 3, z: 0 } : undefined,
        kind
      )!;
      const measured =
        kind === 'distance'
          ? createDistanceMeasurement(first, second, 1, 'mm')!
          : createAngleMeasurement(first, second, 1, 'mm')!;
      const malformed: Measurement = {
        ...measured,
        targets: [measured.targets[0]!]
      };

      const refreshed = refreshMeasurements([malformed], [body], 1, {
        force: true
      });

      expect(refreshed[0]).toMatchObject({
        status: 'unresolved',
        reason: 'not-found',
        sourceRevision: 1
      });
      expect(refreshed[0]!.targets).toHaveLength(1);
      expect(refreshed[0]!.result).toEqual(malformed.result);
    }
  );

  it('requires at least two targets for an edge total and preserves its failure identity', () => {
    const body = bodyWith([], [straightEdge(11, 10), straightEdge(12, 20)]);
    const measured = createEdgeTotalMeasurement(
      [body],
      [
        { bodyId: BODY_ID, kind: 'edge', hash: 11 },
        { bodyId: BODY_ID, kind: 'edge', hash: 12 }
      ],
      1,
      'mm'
    )!;
    const valid = refreshMeasurements([measured], [body], 1, { force: true });
    expect(valid[0]).toMatchObject({
      status: 'current',
      result: { value: 30 }
    });
    expect(valid[0]!.targets).toHaveLength(2);

    const malformed: Measurement = {
      ...measured,
      targets: [measured.targets[0]!]
    };
    const unresolved = refreshMeasurements([malformed], [body], 1, {
      force: true
    });
    expect(unresolved[0]).toMatchObject({
      status: 'unresolved',
      reason: 'not-found',
      sourceRevision: 1
    });

    const again = refreshMeasurements(unresolved, [body], 1, { force: true });
    expect(again).toBe(unresolved);
    expect(again[0]).toBe(unresolved[0]);
  });
});

describe('topology that no longer supports its measurement kind', () => {
  it('becomes stale without claiming that the topology is missing', () => {
    const body = bodyWith([], [straightEdge(11, 10)]);
    const measured = createSmartMeasurement(
      body,
      { bodyId: BODY_ID, kind: 'edge', hash: 11 },
      undefined,
      1,
      'mm'
    )!;
    const receipt: Measurement = {
      ...measured,
      status: 'unresolved',
      reason: 'body-missing',
      annotation: undefined
    };
    const collapsed = bodyWith([], [straightEdge(11, 0)]);

    const stale = refreshMeasurements([receipt], [collapsed], 1, {
      force: true
    });
    expect(stale[0]).toMatchObject({ status: 'stale', sourceRevision: 1 });
    expect(stale[0]!.reason).toBeUndefined();
    expect(stale[0]!.result).toEqual(receipt.result);

    const again = refreshMeasurements(stale, [collapsed], 1, { force: true });
    expect(again).toBe(stale);
    expect(again[0]).toBe(stale[0]);
  });
});

describe('a kept row whose target goes away', () => {
  function keptFace(): Measurement {
    const measured = createSmartMeasurement(
      bodyWith([planarFace(21, 10)]),
      { bodyId: BODY_ID, kind: 'face', hash: 21 },
      { x: 5, y: 5, z: 10 },
      1,
      'mm'
    )!;
    expect(measured.annotation).toBeDefined();
    return measured;
  }

  it('keeps the revision that produced its number (#2360)', () => {
    const kept = keptFace();
    // A model edit removes the face; a later unrelated edit advances the
    // document again.
    const removed = refreshMeasurements([kept], [], 2, { force: true });
    const later = refreshMeasurements(removed, [], 3, { force: true });
    for (const [row, checked] of [
      [removed[0]!, 2],
      [later[0]!, 3]
    ] as const) {
      expect(row.status).toBe('unresolved');
      expect(row.result).toEqual(kept.result);
      expect(row.sourceRevision).toBe(1);
      expect(row.checkedRevision).toBe(checked);
    }
    const csv = measurementsToCsv(later, DISPLAY).split('\n');
    const header = csv[0]!.split(',');
    const cells = csv[1]!.split(',');
    expect(cells[header.indexOf('status')]).toBe('unresolved');
    expect(cells[header.indexOf('source_revision')]).toBe('1');
    expect(cells[header.indexOf('checked_revision')]).toBe('3');
    // Both survive the store.
    const stored = parseStoredMeasurements(
      JSON.parse(
        JSON.stringify(
          buildMeasurementRecord(
            'p',
            later,
            DISPLAY,
            '2026-11-28T00:00:00.000Z'
          )
        )
      )
    );
    expect(stored?.measurements[0]).toMatchObject({
      sourceRevision: 1,
      checkedRevision: 3
    });
    // The face comes back: re-measured, so both name the same revision again.
    const back = refreshMeasurements(
      later,
      [bodyWith([planarFace(21, 10)])],
      4,
      {
        force: true
      }
    );
    expect(back[0]).toMatchObject({ status: 'current', sourceRevision: 4 });
    expect(back[0]!.checkedRevision).toBeUndefined();
  });

  it('stops drawing its callout as soon as it cannot resolve (#2359)', () => {
    const kept = keptFace();
    expect(
      measurementToViewportAnnotation(kept, DISPLAY, false)
    ).not.toBeNull();
    // The body is suppressed: the row keeps its last value for the dock, but
    // nothing of the old geometry is left to draw over the empty space.
    const [suppressed] = refreshMeasurements([kept], [], 2, { force: true });
    expect(suppressed!.status).toBe('unresolved');
    expect(formatMeasurement(suppressed!, DISPLAY).value).toBe(
      formatMeasurement(kept, DISPLAY).value
    );
    expect(suppressed!.annotation).toBeUndefined();
    expect(
      measurementToViewportAnnotation(suppressed!, DISPLAY, true)
    ).toBeNull();
    // As after a reopen, which never stored the annotation either.
    const reopened = parseStoredMeasurements(
      JSON.parse(
        JSON.stringify(
          buildMeasurementRecord(
            'p',
            [suppressed!],
            DISPLAY,
            '2026-11-28T00:00:00.000Z'
          )
        )
      )
    )!.measurements[0]!;
    expect(reopened).toEqual(suppressed);
    // An unresolved row never draws, whatever it carries.
    expect(
      measurementToViewportAnnotation(
        { ...kept, status: 'unresolved' },
        DISPLAY,
        false
      )
    ).toBeNull();
    // Undo restores the body: the callout comes back with a live reading.
    const [restored] = refreshMeasurements(
      [suppressed!],
      [bodyWith([planarFace(21, 10)])],
      3,
      { force: true }
    );
    expect(restored!.status).toBe('current');
    expect(
      measurementToViewportAnnotation(restored!, DISPLAY, false)
    ).not.toBeNull();
  });
});
