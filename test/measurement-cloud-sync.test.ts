// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BodyId } from '@openzcad/shared';
import type { StoredMeasurementRecord } from '../apps/web/src/lib/measurementRecord';
import { parseStoredMeasurements } from '../apps/web/src/lib/measurementStore';
import {
  MEASUREMENT_POLL_INTERVAL_MS,
  copyMeasurementsToAccountCopy,
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
  it('keeps a newer device edit when an older pull finishes and the follow-up push fails', async () => {
    const initial = record('2026-08-07T10:00:00.000Z', 'Initial');
    const remote = record('2026-08-07T11:00:00.000Z', 'Remote');
    const newer = record('2026-08-07T12:00:00.000Z', 'Newer local');
    let device = initial;
    let release!: (snapshot: ProjectMeasurementSnapshot) => void;
    const read = new Promise<ProjectMeasurementSnapshot>((resolve) => {
      release = resolve;
    });
    const load = vi
      .fn()
      .mockReturnValueOnce(read)
      .mockResolvedValue({ revision: 1, record: remote });
    const save = vi.fn().mockRejectedValue(new Error('Network lost'));
    const saveLocal = vi.fn(async (value: StoredMeasurementRecord) => {
      device = value;
    });
    const onResult = vi.fn();
    const watcher = watchProjectMeasurements({
      api: { loadProjectMeasurements: load, saveProjectMeasurements: save },
      projectId: initial.projectId,
      loadLocal: async () => device,
      saveLocal,
      onResult
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    device = newer;
    watcher.push(newer);
    release({ revision: 1, record: remote });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(device).toEqual(newer);
    expect(saveLocal).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('restores edits that arrive while a cloud record is being stored locally', async () => {
    const initial = record('2026-08-07T10:00:00.000Z', 'Initial');
    const remote = record('2026-08-07T11:00:00.000Z', 'Remote');
    const newer = record('2026-08-07T12:00:00.000Z', 'Newer local');
    let device = initial;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saveLocal = vi.fn(async (value: StoredMeasurementRecord) => {
      if (value === remote) await held;
      device = value;
    });
    const save = vi.fn().mockRejectedValue(new Error('Offline'));
    const onResult = vi.fn();
    const watcher = watchProjectMeasurements({
      api: {
        loadProjectMeasurements: async () => ({ revision: 1, record: remote }),
        saveProjectMeasurements: save
      },
      projectId: initial.projectId,
      loadLocal: async () => device,
      saveLocal,
      onResult
    });
    await vi.waitFor(() => expect(saveLocal).toHaveBeenCalledWith(remote));
    device = newer;
    watcher.push(newer);
    release();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(device).toBe(newer);
    expect(saveLocal).toHaveBeenLastCalledWith(newer);
    expect(onResult).not.toHaveBeenCalled();
    watcher.stop();
  });

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

  it('keeps a stale hydrated local list from winning on a watcher retry', async () => {
    const local = record('2026-08-07T13:00:00.000Z', 'Old local');
    const remote = record('2026-08-07T14:00:00.000Z', 'New cloud');
    const harness = api({ revision: 2, record: remote });
    const saveLocal = vi.fn(async () => undefined);
    const results: string[] = [];
    const watcher = watchProjectMeasurements({
      api: harness.api,
      projectId: local.projectId,
      loadLocal: async () => local,
      saveLocal,
      onResult: (result) => results.push(result.source)
    });

    await vi.waitFor(() => expect(results).toHaveLength(1));
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(results).toHaveLength(2));
    watcher.stop();

    expect(results).toEqual(['cloud', 'cloud']);
    expect(saveLocal).toHaveBeenCalledTimes(2);
    expect(saveLocal).toHaveBeenCalledWith(remote);
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

// Cost regression: every open workspace re-read its measurements from the
// account once a minute even in a background tab.
describe('measurement polling and page visibility', () => {
  let visibility: DocumentVisibilityState = 'visible';
  const setVisibility = (state: DocumentVisibilityState) => {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  async function started() {
    const device = {
      current: record('2026-08-07T10:00:00.000Z', 'Local')
    };
    const harness = api({ revision: 1, record: device.current });
    const watcher = watchProjectMeasurements({
      api: harness.api,
      projectId: device.current.projectId,
      loadLocal: async () => device.current,
      saveLocal: async (value) => {
        device.current = value;
      },
      onResult: () => undefined
    });
    const load = vi.mocked(harness.api.loadProjectMeasurements);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await settle();
    return { device, harness, watcher, load };
  }

  it('re-reads the account on the interval while visible', async () => {
    const { watcher, load } = await started();
    vi.advanceTimersByTime(MEASUREMENT_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    watcher.stop();
  });

  it('issues no read on interval ticks while hidden', async () => {
    const { watcher, load } = await started();
    setVisibility('hidden');
    vi.advanceTimersByTime(MEASUREMENT_POLL_INTERVAL_MS * 10);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('reads once when the tab becomes visible again', async () => {
    const { watcher, load } = await started();
    setVisibility('hidden');
    vi.advanceTimersByTime(MEASUREMENT_POLL_INTERVAL_MS);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it('still retries on focus and online while visible', async () => {
    const { watcher, load } = await started();
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    watcher.stop();
  });

  it('writes a newer device edit from a hidden tab and retries it until accepted', async () => {
    const { device, harness, watcher, load } = await started();
    setVisibility('hidden');
    const edit = record('2026-08-07T12:00:00.000Z', 'Edited while hidden');
    harness.save.mockRejectedValueOnce(new Error('Offline'));
    device.current = edit;
    watcher.push(edit);
    await vi.waitFor(() => expect(harness.save).toHaveBeenCalledTimes(1));
    await settle();
    expect(harness.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ record: edit })
    );

    // The account has not accepted the edit, so a hidden tick retries it.
    vi.advanceTimersByTime(MEASUREMENT_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(harness.save).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.snapshot().record).toEqual(edit));
    await settle();

    // Once the account holds the edit, hidden ticks stop reading again.
    const reads = load.mock.calls.length;
    vi.advanceTimersByTime(MEASUREMENT_POLL_INTERVAL_MS * 5);
    await settle();
    expect(load).toHaveBeenCalledTimes(reads);
    watcher.stop();
  });
  it('keeps retrying a restored device edit from a hidden tab when its first write fails', async () => {
    // A device edit that survived a reload is never pushed; the first
    // reconciliation finds it and its write fails.
    const restored = record(
      '2026-08-07T12:00:00.000Z',
      'Restored offline edit'
    );
    const harness = api({
      revision: 1,
      record: record('2026-08-07T10:00:00.000Z', 'Account')
    });
    harness.save.mockRejectedValueOnce(new Error('Offline'));
    const device = { current: restored };
    const watcher = watchProjectMeasurements({
      api: harness.api,
      projectId: restored.projectId,
      loadLocal: async () => device.current,
      saveLocal: async (value) => {
        device.current = value;
      },
      onResult: () => undefined
    });
    await vi.waitFor(() => expect(harness.save).toHaveBeenCalledTimes(1));
    await settle();
    setVisibility('hidden');
    vi.advanceTimersByTime(MEASUREMENT_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(harness.save).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.snapshot().record).toEqual(restored));
    watcher.stop();
  });

  it('reads again after an in-flight read when the tab becomes visible', async () => {
    const { watcher, load } = await started();
    setVisibility('hidden');
    let release: () => void = () => undefined;
    const original = load.getMockImplementation();
    load.mockImplementationOnce(
      (...args) =>
        new Promise((resolve, reject) => {
          release = () => {
            void Promise.resolve(original!(...args)).then(resolve, reject);
          };
        })
    );
    // A focus while hidden is skipped, so start the slow read from the
    // visible-again path, then ask again while it is still running.
    setVisibility('visible');
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    release();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    watcher.stop();
  });
});

describe('an account copy of a measured project (#2433)', () => {
  /** A per-project account store with the route's revision rule. */
  function accountOf(records: Record<string, StoredMeasurementRecord>) {
    const store = new Map<string, ProjectMeasurementSnapshot>(
      Object.entries(records).map(([id, value]) => [
        id,
        { revision: 1, record: structuredClone(value) }
      ])
    );
    const read = (id: string): ProjectMeasurementSnapshot =>
      structuredClone(store.get(id) ?? { revision: 0, record: null });
    const cloud: ProjectMeasurementCloudApi = {
      loadProjectMeasurements: vi.fn(async (id: string) => read(id)),
      saveProjectMeasurements: vi.fn(async (input: SaveInput) => {
        if (input.expectedRevision !== read(input.projectId).revision)
          throw revisionConflict();
        store.set(input.projectId, {
          revision: input.expectedRevision + 1,
          record: structuredClone(input.record)
        });
        return read(input.projectId);
      })
    };
    return { cloud, read };
  }

  function deviceOf(records: Record<string, StoredMeasurementRecord>) {
    const store = new Map(Object.entries(structuredClone(records)));
    return {
      store,
      copyLocal: vi.fn(async (from: string, to: string) => {
        const found = store.get(from);
        if (!found) return false;
        store.set(to, {
          ...structuredClone(found),
          projectId: to,
          updatedAt: '2026-11-28T10:00:00.000Z'
        });
        return true;
      }),
      loadLocal: vi.fn(async (id: string) =>
        structuredClone(store.get(id) ?? null)
      ),
      saveLocal: vi.fn(async (value: StoredMeasurementRecord) => {
        store.set(value.projectId, structuredClone(value));
      })
    };
  }

  const kept = record('2026-11-27T09:00:00.000Z', 'Kept volume');

  it('seeds the account copy, so another device opening it reads the list', async () => {
    const account = accountOf({});
    const device = deviceOf({ project_sync: kept });
    await expect(
      copyMeasurementsToAccountCopy({
        api: account.cloud,
        sourceProjectId: 'project_sync',
        copyProjectId: 'project_copy',
        ...device
      })
    ).resolves.toBe('account');
    const seeded = account.read('project_copy').record;
    expect(seeded?.projectId).toBe('project_copy');
    expect(seeded?.measurements.map((row) => row.label)).toEqual([
      'Kept volume'
    ]);
    // This device's copy and the account's agree, so opening it here
    // neither pushes nor pulls.
    expect(measurementRecordContentKey(seeded!)).toBe(
      measurementRecordContentKey(device.store.get('project_copy')!)
    );
    // Another device opens the copy with nothing of its own: it takes the
    // copied list rather than starting an empty one that would win later.
    const second = await syncProjectMeasurements(
      account.cloud,
      'project_copy',
      null
    );
    expect(second.source).toBe('cloud');
    expect(second.record?.measurements.map((row) => row.label)).toEqual([
      'Kept volume'
    ]);
  });

  it('copies the account record when this device has none, and seeds it', async () => {
    const account = accountOf({ project_sync: kept });
    const device = deviceOf({});
    await expect(
      copyMeasurementsToAccountCopy({
        api: account.cloud,
        sourceProjectId: 'project_sync',
        copyProjectId: 'project_copy',
        ...device,
        now: () => '2026-11-28T11:00:00.000Z'
      })
    ).resolves.toBe('account');
    expect(device.store.get('project_copy')?.updatedAt).toBe(
      '2026-11-28T11:00:00.000Z'
    );
    expect(account.read('project_copy').record?.measurements).toHaveLength(1);
  });

  it('reports a copy only this device holds when the account refuses it', async () => {
    const account = accountOf({});
    vi.mocked(account.cloud.saveProjectMeasurements).mockRejectedValue(
      new Error('offline')
    );
    const device = deviceOf({ project_sync: kept });
    await expect(
      copyMeasurementsToAccountCopy({
        api: account.cloud,
        sourceProjectId: 'project_sync',
        copyProjectId: 'project_copy',
        ...device
      })
    ).resolves.toBe('device');
    expect(device.store.get('project_copy')?.measurements).toHaveLength(1);
  });

  it('has nothing to seed when neither holds a record', async () => {
    const account = accountOf({});
    const device = deviceOf({});
    await expect(
      copyMeasurementsToAccountCopy({
        api: account.cloud,
        sourceProjectId: 'project_sync',
        copyProjectId: 'project_copy',
        ...device
      })
    ).resolves.toBe('none');
    expect(account.cloud.saveProjectMeasurements).not.toHaveBeenCalled();
  });
});
