import { describe, expect, it } from 'vitest';
import type { BodyId } from '@openzcad/shared';
import type { Measurement } from '../apps/web/src/lib/measurements';
import {
  buildMeasurementRecord,
  MEASUREMENT_RECORD_MAX_ITEMS,
  MEASUREMENT_RECORD_VERSION,
  parseStoredMeasurements,
  persistableMeasurement
} from '../apps/web/src/lib/measurementStore';

/**
 * What survives being written down.
 *
 * Measurements live in their own per-project store rather than in the
 * document, so this parser is the boundary between whatever is on disk — which
 * may have been written by a different build — and what the app will render.
 */

function measurement(index: number): Measurement {
  return {
    id: `edge:body/${index}`,
    kind: 'edge-length',
    label: `Edge ${index}`,
    targets: [
      {
        bodyId: 'body-1' as BodyId,
        bodyName: 'Part',
        kind: 'edge',
        topologyId: `edge:${index}`,
        hash: index,
        label: `Edge ${index}`,
        semantic: 'edge-midpoint',
        quality: 'exact-analytic'
      }
    ],
    result: { value: index * 10, dimension: 'length' },
    quality: 'exact-kernel',
    status: 'current',
    sourceRevision: 1,
    sourceUnit: 'mm',
    visible: true,
    annotation: {
      anchor: { x: 0, y: 0, z: 0 },
      segments: [{ start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } }]
    }
  };
}

const DISPLAY = {
  unit: 'mm',
  precision: 2,
  radialDisplay: 'diameter'
} as const;

function record(measurements: Measurement[]) {
  return buildMeasurementRecord(
    'p1',
    measurements,
    DISPLAY,
    '2026-08-07T00:00:00Z'
  );
}

describe('what gets written', () => {
  it('drops the annotation and keeps the value', () => {
    // The annotation is world-space line geometry rebuilt from the targets on
    // the next refresh, and it is most of the bytes. The value is kept whole
    // so a row whose geometry has since vanished can still show what it last
    // read — the difference between a record and a receipt.
    const stored = persistableMeasurement(measurement(1));
    expect(stored.annotation).toBeUndefined();
    expect(stored.result.value).toBe(10);
    expect(stored.targets).toHaveLength(1);
  });

  it('caps the list rather than writing an unbounded one', () => {
    const many = Array.from(
      { length: MEASUREMENT_RECORD_MAX_ITEMS + 25 },
      (_, i) => measurement(i)
    );
    expect(record(many).measurements).toHaveLength(
      MEASUREMENT_RECORD_MAX_ITEMS
    );
  });

  it('stamps the version it was written by', () => {
    expect(record([measurement(1)]).version).toBe(MEASUREMENT_RECORD_VERSION);
  });
});

describe('what gets read back', () => {
  it('round-trips a record it wrote', () => {
    const parsed = parseStoredMeasurements(
      record([measurement(1), measurement(2)])
    );
    expect(parsed?.measurements).toHaveLength(2);
    expect(parsed?.display).toEqual(DISPLAY);
    expect(parsed?.measurements[0]?.result.value).toBe(10);
  });

  it('sanitizes stored rows instead of casting them into the renderer', () => {
    const unsafe = {
      ...record([measurement(1)]),
      measurements: [
        {
          ...measurement(1),
          annotation: measurement(1).annotation,
          unknownFutureField: 'do not retain'
        },
        {
          ...persistableMeasurement(measurement(2)),
          targets: [
            {
              ...measurement(2).targets[0],
              point: { x: 'not a number', y: 0, z: 0 }
            }
          ]
        }
      ]
    };

    const parsed = parseStoredMeasurements(unsafe);
    expect(parsed?.measurements).toHaveLength(1);
    expect(parsed?.measurements[0]?.annotation).toBeUndefined();
    expect(parsed?.measurements[0]).not.toHaveProperty('unknownFutureField');
  });

  it('refuses a record from a newer build outright', () => {
    // Reading it partially would be worse than not reading it: this build
    // would drop the fields it did not understand and then write the
    // truncated version back, turning a forward-compatible format into data
    // loss on the device that had the complete copy.
    const future = {
      ...record([measurement(1)]),
      version: MEASUREMENT_RECORD_VERSION + 1
    };
    expect(parseStoredMeasurements(future)).toBeNull();
  });

  it('refuses nonsensical record versions', () => {
    for (const version of [Number.NaN, -1, 0, 1.5]) {
      expect(
        parseStoredMeasurements({ ...record([measurement(1)]), version })
      ).toBeNull();
    }
  });

  it('drops one malformed row without losing the rest', () => {
    const mixed = {
      ...record([measurement(1), measurement(2)]),
      measurements: [
        persistableMeasurement(measurement(1)),
        { id: 'broken', kind: 'edge-length' },
        persistableMeasurement(measurement(2))
      ]
    };
    const parsed = parseStoredMeasurements(mixed);
    // The bad row is gone either way; discarding the good ones alongside it is
    // the worse of the two losses.
    expect(parsed?.measurements).toHaveLength(2);
    expect(parsed?.measurements.map((entry) => entry.id)).toEqual([
      'edge:body/1',
      'edge:body/2'
    ]);
  });

  it('refuses anything that is not a record at all', () => {
    for (const value of [null, undefined, 42, 'text', [], {}]) {
      expect(parseStoredMeasurements(value)).toBeNull();
    }
  });

  it('refuses a malformed display block rather than defaulting it', () => {
    // Silently substituting millimetres would show someone an inch part in the
    // wrong unit with no indication anything was lost.
    for (const display of [
      undefined,
      { unit: 'furlong', precision: 2, radialDisplay: 'diameter' },
      { unit: 'mm', precision: -1, radialDisplay: 'diameter' },
      { unit: 'mm', precision: 2.5, radialDisplay: 'diameter' },
      { unit: 'mm', precision: 2, radialDisplay: 'circumference' }
    ]) {
      expect(
        parseStoredMeasurements({ ...record([measurement(1)]), display })
      ).toBeNull();
    }
  });

  it('truncates an over-long stored list on read', () => {
    // A record that arrives too long — from another device, or a future build
    // with a higher cap — is bounded here rather than trusted, so a malformed
    // record cannot wedge the app open at a project it cannot load.
    const overlong = {
      ...record([measurement(1)]),
      measurements: Array.from(
        { length: MEASUREMENT_RECORD_MAX_ITEMS + 50 },
        (_, i) => persistableMeasurement(measurement(i))
      )
    };
    expect(parseStoredMeasurements(overlong)?.measurements).toHaveLength(
      MEASUREMENT_RECORD_MAX_ITEMS
    );
  });

  it('keeps a row whose targets no longer resolve', () => {
    // A measurement pointing at geometry that is gone is a state the app
    // already shows honestly. Discarding it on load would delete the evidence
    // instead of reporting it.
    const stale = {
      ...record([measurement(1)]),
      measurements: [
        {
          ...persistableMeasurement(measurement(1)),
          status: 'unresolved',
          reason: 'not-found'
        }
      ]
    };
    const parsed = parseStoredMeasurements(stale);
    expect(parsed?.measurements).toHaveLength(1);
    expect(parsed?.measurements[0]?.status).toBe('unresolved');
  });
});
