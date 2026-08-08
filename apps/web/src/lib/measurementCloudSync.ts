import type { StoredMeasurementRecord } from './measurementRecord';

export interface ProjectMeasurementSnapshot {
  revision: number;
  record: StoredMeasurementRecord | null;
}

export interface ProjectMeasurementCloudApi {
  loadProjectMeasurements(
    projectId: string
  ): Promise<ProjectMeasurementSnapshot>;
  saveProjectMeasurements(input: {
    projectId: string;
    expectedRevision: number;
    record: StoredMeasurementRecord;
  }): Promise<ProjectMeasurementSnapshot>;
}

export interface ProjectMeasurementSyncResult extends ProjectMeasurementSnapshot {
  source: 'local' | 'cloud' | 'none';
}

export interface ProjectMeasurementWatchOptions {
  api: ProjectMeasurementCloudApi;
  projectId: string;
  loadLocal(): Promise<StoredMeasurementRecord | null>;
  saveLocal(record: StoredMeasurementRecord): Promise<void>;
  onResult(result: ProjectMeasurementSyncResult): void;
}

export interface ProjectMeasurementWatcher {
  push(record: StoredMeasurementRecord): void;
  stop(): void;
}

const MAX_CONFLICT_RETRIES = 3;

function contentKey(record: StoredMeasurementRecord): string {
  return JSON.stringify({ ...record, updatedAt: '' });
}

/**
 * Reconciles one device snapshot with the account without involving CAD history.
 *
 * The server revision prevents a stale read from overwriting a newer write. If
 * two devices changed the annotation list independently, `updatedAt` is the
 * explicit whole-list last-writer decision; equal timestamps prefer the cloud
 * copy so an ambiguous device never overwrites account data.
 */
export async function syncProjectMeasurements(
  api: ProjectMeasurementCloudApi,
  projectId: string,
  local: StoredMeasurementRecord | null
): Promise<ProjectMeasurementSyncResult> {
  let remote = await api.loadProjectMeasurements(projectId);
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
    if (!local) {
      return {
        ...remote,
        source: remote.record ? 'cloud' : 'none'
      };
    }
    if (remote.record && contentKey(local) === contentKey(remote.record)) {
      return { ...remote, source: 'cloud' };
    }
    if (
      remote.record &&
      Date.parse(local.updatedAt) <= Date.parse(remote.record.updatedAt)
    ) {
      return { ...remote, source: 'cloud' };
    }
    try {
      const saved = await api.saveProjectMeasurements({
        projectId,
        expectedRevision: remote.revision,
        record: local
      });
      return { ...saved, source: 'local' };
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'MEASUREMENT_REVISION_CONFLICT'
      ) {
        throw error;
      }
      remote = await api.loadProjectMeasurements(projectId);
    }
  }
  return { ...remote, source: remote.record ? 'cloud' : 'none' };
}

/** Starts retryable cloud reconciliation while IndexedDB stays authoritative offline. */
export function watchProjectMeasurements({
  api,
  projectId,
  loadLocal,
  saveLocal,
  onResult
}: ProjectMeasurementWatchOptions): ProjectMeasurementWatcher {
  let cancelled = false;
  let syncing = false;
  let pending: StoredMeasurementRecord | undefined;
  const sync = async (localOverride?: StoredMeasurementRecord) => {
    if (cancelled) return;
    if (syncing) {
      pending = localOverride ?? pending;
      return;
    }
    syncing = true;
    try {
      const local = localOverride ?? (await loadLocal());
      const result = await syncProjectMeasurements(api, projectId, local);
      if (cancelled) return;
      if (result.source === 'cloud' && result.record) {
        await saveLocal(result.record);
      }
      if (!cancelled) onResult(result);
    } catch {
      // The device copy is usable; focus, online, and the poll retry cloud.
    } finally {
      syncing = false;
      if (pending) {
        const next = pending;
        pending = undefined;
        void sync(next);
      }
    }
  };
  const retry = () => void sync();
  void sync();
  const interval = window.setInterval(retry, 60_000);
  window.addEventListener('focus', retry);
  window.addEventListener('online', retry);
  return {
    push: (record) => void sync(record),
    stop: () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', retry);
      window.removeEventListener('online', retry);
    }
  };
}
