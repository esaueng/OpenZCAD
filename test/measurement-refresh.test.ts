import { describe, expect, it } from 'vitest';
import type { BodyId, BodyRepresentation } from '@openzcad/shared';
import {
  createDistanceMeasurement,
  createSmartMeasurement,
  measurementTargetFromSelection,
  refreshMeasurements,
  type Measurement
} from '../apps/web/src/lib/measurements';

/**
 * What happens to a measurement when the model underneath it changes.
 *
 * These are the cases that matter once measurements outlive the pick that made
 * them — which is the whole direction of the overhaul — and each one was
 * previously wrong in a way that only shows up on the second rebuild.
 */

const BODY_ID = 'body-1' as BodyId;

function bodyWith(
  faces: NonNullable<BodyRepresentation['topology']>['faces'],
  edges: NonNullable<BodyRepresentation['topology']>['edges'] = []
): BodyRepresentation {
  return {
    bodyId: BODY_ID,
    name: 'Plate',
    source: 'primitive',
    mesh: { kind: 'mesh', vertices: Float32Array.from([]), indices: Uint32Array.from([]) },
    faceCount: faces.length,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: 1000,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
    topology: { faces, edges }
  };
}

function planarFace(hash: number, z: number) {
  return {
    topologyId: `face:${hash}`,
    hash,
    triangleStart: 0,
    triangleCount: 2,
    geometry: {
      surfaceType: 'plane',
      area: 100,
      center: { x: 5, y: 5, z },
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
  it('advances sourceRevision on the failing branch too', () => {
    // The bug this pins: the failing branch returned the row with its ORIGINAL
    // sourceRevision, so it never matched the equality check at the top of the
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
    expect(broken[0]!.sourceRevision).toBe(2);

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
});
