// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import type { BodyId } from '@openzcad/shared';
import type { StoredMeasurementRecord } from '../apps/web/src/lib/measurementRecord';
import { parseStoredMeasurements } from '../apps/web/src/lib/measurementStore';
import {
  measurementRecordContentKey,
  syncProjectMeasurements,
  watchProjectMeasurements,
  type ProjectMeasurementCloudApi,
  type ProjectMeasurementSnapshot
} from '../apps/web/src/lib/measurementCloudSync';

type SaveInput = Parameters<
  ProjectMeasurementCloudApi['saveProjectMeasurements']
>[0];

function revisionConflict(): Error & { code: string } {
  return Object.assign(new Error('The account has newer measurements.'), {
    code: 'MEASUREMENT_REVISION_CONFLICT'
  });
}

function record(updatedAt: string, label: string): StoredMeasurementRecord {
  return {
    projectId: 'project_sync',
    version: 1,
    updatedAt,
    display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' },
    measurements: [
      {
        id: 'body:one',
        kind: 'body',
        label,
        targets: [
          {
            bodyId: 'body_one' as BodyId,
            bodyName: 'One',
            kind: 'body',
            label: 'One',
            semantic: 'body-center',
            quality: 'exact-kernel',
            point: { x: 0, y: 0, z: 0 }
          }
        ],
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

/** The property order produced by createSmartMeasurement before persistence. */
function runtimeOrderedRecord(
  updatedAt: string,
  label: string
): StoredMeasurementRecord {
  const stored = record(updatedAt, label);
  const {
    id,
    kind,
    label: measurementLabel,
    targets,
    result,
    quality,
    status,
    sourceRevision,
    sourceUnit,
    visible
  } = stored.measurements[0]!;
  return {
    ...stored,
    measurements: [
      {
        targets,
        status,
        sourceRevision,
        sourceUnit,
        visible,
        id,
        kind,
        label: measurementLabel,
        result,
        quality
      }
    ]
  };
}

function api(initial: ProjectMeasurementSnapshot): {
  api: ProjectMeasurementCloudApi;
  snapshot: () => ProjectMeasurementSnapshot;
  save: ReturnType<typeof vi.fn>;
} {
  let snapshot = structuredClone(initial);
  const save = vi.fn(async (input: SaveInput) => {
    if (input.expectedRevision !== snapshot.revision) {
      throw revisionConflict();
    }
    snapshot = {
      revision: snapshot.revision + 1,
      record: structuredClone(input.record)
    };
    return structuredClone(snapshot);
  });
  return {
    api: {
      loadProjectMeasurements: vi.fn(async () => structuredClone(snapshot)),
      saveProjectMeasurements: save
    },
    snapshot: () => snapshot,
    save
  };
}

describe('measurement cloud reconciliation', () => {
  it('pushes a newer local list with the revision it just read', async () => {
    const remote = record('2026-08-07T12:00:00.000Z', 'Remote');
    const local = record('2026-08-07T13:00:00.000Z', 'Local');
    const harness = api({ revision: 4, record: remote });
    await expect(
      syncProjectMeasurements(harness.api, local.projectId, local)
    ).resolves.toMatchObject({ revision: 5, source: 'local' });
    expect(harness.save).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 4, record: local })
    );
  });

  it('pulls a newer cloud list and does not overwrite it', async () => {
    const remote = record('2026-08-07T14:00:00.000Z', 'Remote');
    const local = record('2026-08-07T13:00:00.000Z', 'Local');
    const harness = api({ revision: 2, record: remote });
    await expect(
      syncProjectMeasurements(harness.api, local.projectId, local)
    ).resolves.toEqual({ revision: 2, record: remote, source: 'cloud' });
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('retries after another device wins the optimistic write', async () => {
    const local = record('2026-08-07T15:00:00.000Z', 'Local');
    let snapshot: ProjectMeasurementSnapshot = {
      revision: 1,
      record: record('2026-08-07T12:00:00.000Z', 'Old')
    };
    let first = true;
    const save = vi.fn(async (input: SaveInput) => {
      if (first) {
        first = false;
        snapshot = {
          revision: 2,
          record: record('2026-08-07T14:00:00.000Z', 'Other device')
        };
        throw revisionConflict();
      }
      snapshot = { revision: 3, record: input.record };
      return snapshot;
    });
    const cloud: ProjectMeasurementCloudApi = {
      loadProjectMeasurements: vi.fn(async () => structuredClone(snapshot)),
      saveProjectMeasurements: save
    };
    await expect(
      syncProjectMeasurements(cloud, local.projectId, local)
    ).resolves.toMatchObject({ revision: 3, source: 'local' });
    expect(save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedRevision: 2 })
    );
  });

  it('prefers cloud on an ambiguous equal timestamp', async () => {
    const local = record('2026-08-07T12:00:00.000Z', 'Local');
    const remote = record('2026-08-07T12:00:00.000Z', 'Remote');
    const harness = api({ revision: 7, record: remote });
    await expect(
      syncProjectMeasurements(harness.api, local.projectId, local)
    ).resolves.toEqual({ revision: 7, record: remote, source: 'cloud' });
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('does not push a production-canonicalized echo again', async () => {
    let snapshot: ProjectMeasurementSnapshot = {
      revision: 0,
      record: null
    };
    const save = vi.fn(async (input: SaveInput) => {
      const canonical = parseStoredMeasurements(input.record);
      if (!canonical) throw new Error('Fixture record did not parse.');
      snapshot = {
        revision: snapshot.revision + 1,
        record: canonical
      };
      return structuredClone(snapshot);
    });
    const cloud: ProjectMeasurementCloudApi = {
      loadProjectMeasurements: vi.fn(async () => structuredClone(snapshot)),
      saveProjectMeasurements: save
    };
    const first = runtimeOrderedRecord(
      '2026-08-07T12:00:00.000Z',
      'Same measurement'
    );

    await expect(
      syncProjectMeasurements(cloud, first.projectId, first)
    ).resolves.toMatchObject({ revision: 1, source: 'local' });
    const canonical = snapshot.record!;
    expect(JSON.stringify(first.measurements)).not.toBe(
      JSON.stringify(canonical.measurements)
    );
    expect(measurementRecordContentKey(first)).toBe(
      measurementRecordContentKey(canonical)
    );

    const refreshed = runtimeOrderedRecord(
      '2026-08-07T13:00:00.000Z',
      'Same measurement'
    );
    await expect(
      syncProjectMeasurements(cloud, refreshed.projectId, refreshed)
    ).resolves.toMatchObject({ revision: 1, source: 'cloud' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('hydrates once and forwards later device changes through one watcher', async () => {
    const first = record('2026-08-07T12:00:00.000Z', 'First local');
    const second = record('2026-08-07T13:00:00.000Z', 'Second local');
    const harness = api({ revision: 0, record: null });
    const results: ProjectMeasurementSnapshot[] = [];
    let notify!: () => void;
    const nextResult = () =>
      new Promise<void>((resolve) => {
        notify = resolve;
      });
    const initialResult = nextResult();
    const watcher = watchProjectMeasurements({
      api: harness.api,
      projectId: first.projectId,
      loadLocal: vi.fn(async () => first),
      saveLocal: vi.fn(async () => undefined),
      onResult: (result) => {
        results.push(result);
        notify();
      }
    });
    await initialResult;

    const pushedResult = nextResult();
    watcher.push(second);
    await pushedResult;
    watcher.stop();

    expect(results).toMatchObject([
      { revision: 1, source: 'local' },
      { revision: 2, source: 'local' }
    ]);
  });
});
