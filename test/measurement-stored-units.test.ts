import { describe, expect, it } from 'vitest';
import type { BodyId, BodyRepresentation } from '@openzcad/shared';
import {
  MEASUREMENT_UNIT_FREE_FIELDS,
  createDistanceMeasurement,
  createSmartMeasurement,
  formatMeasurement,
  measurementInUnit,
  measurementTargetFromSelection,
  refreshMeasurements,
  type Measurement
} from '../apps/web/src/lib/measurements';

/**
 * I03 preview finding 1 (PR #1999): a kept measurement across a stored-unit
 * conversion. Kept measurements live beside the document (per-project
 * measurement store), not in it, so `convertDocumentUnits` never sees them;
 * each row carries the unit it was measured in (`sourceUnit`) and the
 * refresh rescales it to the bodies' unit before re-measuring.
 *
 * The bug: the refresh re-measured an 18 mm edge on the converted model
 * (0.7087 in model units) but kept `sourceUnit: 'mm'`, so the dock and the
 * canvas label read 0.7087 mm, shown as "0.03 in".
 */

const BODY_ID = 'body-1' as BodyId;
const INCH = 25.4;

function box(scale: number): BodyRepresentation {
  const [x, y, z] = [25.4 * scale, 18 * scale, 24 * scale];
  return {
    bodyId: BODY_ID,
    name: 'Box',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([]),
      indices: Uint32Array.from([])
    },
    faceCount: 1,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: x * y * z,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x, y, z } },
    topology: {
      faces: [
        {
          topologyId: 'face:21',
          hash: 21,
          triangleStart: 0,
          triangleCount: 2,
          geometry: {
            surfaceType: 'plane',
            area: x * y,
            center: { x: x / 2, y: y / 2, z },
            centroid: { x: x / 2, y: y / 2, z },
            centroidProvenance: 'exact' as const,
            normal: { x: 0, y: 0, z: 1 }
          }
        }
      ],
      edges: [
        {
          topologyId: 'edge:11',
          hash: 11,
          length: y,
          curve: { type: 'LINE' },
          points: [0, 0, 0, 0, y, 0]
        }
      ]
    }
  };
}

const display = (unit: 'mm' | 'inch') => ({
  unit,
  precision: 3,
  radialDisplay: 'diameter' as const
});

function keptEdge(): Measurement {
  return createSmartMeasurement(
    box(1),
    { bodyId: BODY_ID, kind: 'edge', hash: 11 },
    undefined,
    1,
    'mm'
  )!;
}

describe('a kept measurement across a stored-unit conversion', () => {
  it('reads 0.709 in after mm → in, not the converted number read as mm', () => {
    const kept = keptEdge();
    expect(formatMeasurement(kept, display('inch')).value).toBe('0.709 in');

    // The converted document: the same edge, now stored in inches.
    const converted = refreshMeasurements([kept], [box(1 / INCH)], 2, {
      force: true,
      unit: 'inch'
    });
    expect(converted[0]!.status).toBe('current');
    expect(converted[0]!.sourceUnit).toBe('inch');
    expect(converted[0]!.result.value).toBeCloseTo(18 / INCH, 12);
    expect(formatMeasurement(converted[0]!, display('inch')).value).toBe(
      '0.709 in'
    );
    // The canvas label's geometry is in the converted model's space too.
    const span = converted[0]!.annotation!.segments[0]!;
    expect(Math.hypot(span.end.y - span.start.y)).toBeCloseTo(18 / INCH, 9);

    // Undo: the document is back in millimetres.
    const undone = refreshMeasurements(converted, [box(1)], 3, {
      force: true,
      unit: 'mm'
    });
    expect(undone[0]!.sourceUnit).toBe('mm');
    expect(formatMeasurement(undone[0]!, display('mm')).value).toBe(
      '18.000 mm'
    );
  });

  it('rescales a row that cannot be re-measured, so it is stale, not wrong', () => {
    const kept = keptEdge();
    const refreshed = refreshMeasurements([kept], [], 2, {
      force: true,
      unit: 'inch'
    });
    expect(refreshed[0]!.status).toBe('unresolved');
    expect(formatMeasurement(refreshed[0]!, display('inch')).value).toBe(
      '0.709 in'
    );
  });

  it('rescales areas by k² and volumes by k³', () => {
    const face = createSmartMeasurement(
      box(1),
      { bodyId: BODY_ID, kind: 'face', hash: 21 },
      undefined,
      1,
      'mm'
    )!;
    const body = createSmartMeasurement(
      box(1),
      { bodyId: BODY_ID, kind: 'body' },
      undefined,
      1,
      'mm'
    )!;
    expect(measurementInUnit(face, 'inch').result.value).toBeCloseTo(
      (25.4 * 18) / INCH ** 2,
      12
    );
    const bodyIn = measurementInUnit(body, 'inch');
    expect(bodyIn.result.value).toBeCloseTo((25.4 * 18 * 24) / INCH ** 3, 12);
    expect(bodyIn.result.components!.y).toBeCloseTo(18 / INCH, 12);
  });

  it('classifies every number a measurement carries (audit)', () => {
    const body = box(1);
    const first = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 21 },
      { x: 2, y: 3, z: 24 },
      'distance'
    )!;
    const second = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'edge', hash: 11 },
      undefined,
      'distance'
    )!;
    const samples: Measurement[] = [
      keptEdge(),
      createDistanceMeasurement(first, second, 1, 'mm')!,
      createSmartMeasurement(
        body,
        { bodyId: BODY_ID, kind: 'body' },
        undefined,
        1,
        'mm'
      )!
    ];
    const unitFree = MEASUREMENT_UNIT_FREE_FIELDS.map(
      (pattern) =>
        new RegExp(
          `^${pattern.replace(/\./g, '\\.').replace(/\*/g, '\\d+')}(\\.|$)`
        )
    );
    const leaves = (value: unknown, path: string[] = []): [string, number][] =>
      typeof value === 'number'
        ? [[path.join('.'), value]]
        : typeof value === 'object' && value !== null
          ? Object.entries(value).flatMap(([key, child]) =>
              leaves(child, [...path, key])
            )
          : [];
    const unclassified: string[] = [];
    for (const sample of samples) {
      const before = new Map(leaves(sample));
      const after = new Map(leaves(measurementInUnit(sample, 'cm')));
      for (const [path, value] of before) {
        if (unitFree.some((pattern) => pattern.test(path))) {
          expect(after.get(path), path).toBe(value);
          continue;
        }
        // Every other number scales: a zero stays zero, the rest move.
        if (value !== 0 && after.get(path) === value)
          unclassified.push(`${sample.kind} ${path}`);
      }
    }
    expect(unclassified).toEqual([]);
  });
});
