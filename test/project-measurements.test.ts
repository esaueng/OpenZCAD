import { describe, expect, it, vi } from 'vitest';
import {
  deleteProjectMeasurements,
  loadProjectMeasurements,
  MAX_PROJECT_MEASUREMENT_BYTES,
  parseSaveProjectMeasurementsRequest,
  ProjectMeasurementRequestError,
  ProjectMeasurementRevisionConflictError,
  saveProjectMeasurements
} from '../apps/web/worker/projectMeasurements';
import type { StoredMeasurementRecord } from '../apps/web/src/lib/measurementRecord';

function record(
  updatedAt = '2026-08-07T12:00:00.000Z'
): StoredMeasurementRecord {
  return {
    projectId: 'project_measurements',
    version: 1,
    updatedAt,
    display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' },
    measurements: [
      {
        id: 'body:one',
        kind: 'body',
        label: 'Part',
        targets: [],
        result: { value: 10, dimension: 'volume' },
        quality: 'tessellated',
        status: 'current',
        sourceRevision: 1,
        sourceUnit: 'mm',
        visible: true
      }
    ]
  };
}

function database() {
  let row: { payloadJson: string; revision: number } | null = null;
  const prepare = vi.fn((query: string) => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async first() {
        if (query.includes('SELECT payload_json')) {
          return row
            ? { payload_json: row.payloadJson, revision: row.revision }
            : null;
        }
        if (query.includes('SELECT revision')) {
          return row ? { revision: row.revision } : null;
        }
        return null;
      },
      async run() {
        if (query.includes('INSERT INTO project_measurements')) {
          if (row) return { meta: { changes: 0 } };
          row = { payloadJson: String(values[2]), revision: 1 };
          return { meta: { changes: 1 } };
        }
        if (query.includes('UPDATE project_measurements')) {
          const expected = Number(values[5]);
          if (!row || row.revision !== expected) {
            return { meta: { changes: 0 } };
          }
          row = {
            payloadJson: String(values[2]),
            revision: Number(values[1])
          };
          return { meta: { changes: 1 } };
        }
        if (query.includes('DELETE FROM project_measurements')) {
          const expected = Number(values[1]);
          if (!row || row.revision !== expected) {
            return { meta: { changes: 0 } };
          }
          row = null;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
    };
    return statement;
  });
  return {
    db: { prepare } as unknown as D1Database,
    revision: () => row?.revision ?? 0
  };
}

describe('project measurement D1 storage', () => {
  it('creates, reads, and conditionally updates one project snapshot', async () => {
    const { db } = database();
    await expect(
      loadProjectMeasurements(db, record().projectId)
    ).resolves.toEqual({ revision: 0, record: null });
    const created = await saveProjectMeasurements(db, record().projectId, {
      expectedRevision: 0,
      record: record()
    });
    expect(created.revision).toBe(1);
    const changed = record('2026-08-07T13:00:00.000Z');
    changed.measurements[0]!.label = 'Renamed';
    await expect(
      saveProjectMeasurements(db, changed.projectId, {
        expectedRevision: 1,
        record: changed
      })
    ).resolves.toMatchObject({
      revision: 2,
      record: { updatedAt: changed.updatedAt }
    });
    await expect(
      loadProjectMeasurements(db, changed.projectId)
    ).resolves.toEqual({
      revision: 2,
      record: changed
    });
  });

  it('returns the current revision instead of overwriting a stale write', async () => {
    const { db } = database();
    await saveProjectMeasurements(db, record().projectId, {
      expectedRevision: 0,
      record: record()
    });
    await expect(
      saveProjectMeasurements(db, record().projectId, {
        expectedRevision: 0,
        record: record('2026-08-07T14:00:00.000Z')
      })
    ).rejects.toEqual(new ProjectMeasurementRevisionConflictError(1));
  });

  it('deletes only the revision the caller read', async () => {
    const { db, revision } = database();
    await saveProjectMeasurements(db, record().projectId, {
      expectedRevision: 0,
      record: record()
    });
    await expect(
      deleteProjectMeasurements(db, record().projectId, 2)
    ).rejects.toEqual(new ProjectMeasurementRevisionConflictError(1));
    expect(revision()).toBe(1);
    await deleteProjectMeasurements(db, record().projectId, 1);
    expect(revision()).toBe(0);
  });

  it('validates project identity and the narrow row-size ceiling', () => {
    expect(() =>
      parseSaveProjectMeasurementsRequest(
        { expectedRevision: 0, record: record() },
        'another_project'
      )
    ).toThrow(ProjectMeasurementRequestError);

    const oversized = record();
    oversized.measurements[0]!.note = 'x'.repeat(MAX_PROJECT_MEASUREMENT_BYTES);
    expect(() =>
      parseSaveProjectMeasurementsRequest(
        { expectedRevision: 0, record: oversized },
        oversized.projectId
      )
    ).toThrow(/cloud limit/);
  });
});
