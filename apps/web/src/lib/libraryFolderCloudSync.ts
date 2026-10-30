import { useEffect, useRef } from 'react';
import {
  folderStorageKey,
  readLibraryFolders,
  writeLibraryFolders,
  type LibraryFolders
} from './libraryFolders';
import {
  deviceFoldersFromSet,
  folderSetFromDevice,
  mergeFolderSets,
  parseFolderSet,
  pruneFolderSet,
  recordFolderChanges,
  type FolderSet
} from './libraryFolderSync';
import { watchLibraryFreshness } from './libraryRefresh';

/**
 * Keeps the library's folders in step with the account copy
 * (`/api/library-folders`), so every device signed in to the account shows
 * the same folders.
 *
 * The device copy (`libraryFolders.ts`) stays what the shelf reads and
 * edits, instantly and offline. Beside it this device keeps the stamped
 * folder set it last agreed with the account and that copy's revision. A
 * sync turns whatever changed on the shelf since then into stamped changes,
 * merges them with the account copy (`mergeFolderSets`), writes the result
 * back against the revision it read, and shows the merged folders. A write
 * another device beat is merged again and retried.
 *
 * Only the plaintext record (format 1) is exchanged. An account whose
 * projects are encrypted keeps its folders on each device until the sealed
 * format exists; this module never sends their names.
 */
export interface LibraryFolderSnapshot {
  /** 0 while the account has never stored folders. */
  revision: number;
  format: 1 | 2 | null;
  record: string | null;
  updatedAt: string | null;
}

export interface SaveLibraryFolderRequest {
  expectedRevision: number;
  format: 1;
  record: string;
}

/** What this device last agreed with the account. */
interface SyncRecord {
  revision: number;
  set: FolderSet;
}

export type FolderSaveResult =
  { saved: LibraryFolderSnapshot } | { conflict: LibraryFolderSnapshot };

export interface FolderSyncHost {
  readDevice(): LibraryFolders;
  writeDevice(state: LibraryFolders): void;
  readRecord(): SyncRecord | null;
  writeRecord(record: SyncRecord): void;
  load(): Promise<LibraryFolderSnapshot>;
  save(request: SaveLibraryFolderRequest): Promise<FolderSaveResult>;
  now(): number;
}

/**
 * - `synced`: the device and the account now hold the same folders.
 * - `unsupported`: the account copy is one this device cannot read (sealed,
 *   or from a newer client); nothing was written.
 * - `contended`: other devices kept writing first; the next sync retries.
 */
export type FolderSyncOutcome = 'synced' | 'unsupported' | 'contended';

const MAX_ATTEMPTS = 3;

/** JSON with sorted keys, so equal sets compare equal however they were built. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          )
        )
      : entry
  );
}

function isEmpty(set: FolderSet): boolean {
  return (
    Object.keys(set.folders).length === 0 &&
    Object.keys(set.members).length === 0
  );
}

/** One sync round. Throws what `load` and `save` throw. */
export async function syncLibraryFolders(
  host: FolderSyncHost
): Promise<FolderSyncOutcome> {
  const device = host.readDevice();
  const stored = host.readRecord();
  // A device syncing for the first time offers its folders stamped with
  // their creation times, so anything the account has changed since wins.
  let local = stored?.set ?? folderSetFromDevice(device);
  if (stored) {
    const agreed = deviceFoldersFromSet(stored.set);
    if (canonical(agreed) !== canonical(device)) {
      local = recordFolderChanges(local, agreed, device, host.now());
    }
  }

  let remote = await host.load();
  for (let attempt = 1; ; attempt += 1) {
    let remoteSet: FolderSet | null = null;
    if (remote.revision > 0) {
      if (remote.format !== 1 || remote.record === null) return 'unsupported';
      try {
        remoteSet = parseFolderSet(JSON.parse(remote.record));
      } catch {
        remoteSet = null;
      }
      // Never overwrite a copy this client cannot read.
      if (!remoteSet) return 'unsupported';
    }
    const merged = pruneFolderSet(
      remoteSet ? mergeFolderSets(local, remoteSet) : local,
      host.now()
    );
    let revision = remote.revision;
    const unchanged = remoteSet
      ? canonical(merged) === canonical(remoteSet)
      : isEmpty(merged);
    if (!unchanged) {
      const result = await host.save({
        expectedRevision: remote.revision,
        format: 1,
        record: canonical(merged)
      });
      if ('conflict' in result) {
        if (attempt >= MAX_ATTEMPTS) return 'contended';
        remote = result.conflict;
        continue;
      }
      revision = result.saved.revision;
    }
    finish(host, device, merged, revision);
    return 'synced';
  }
}

function finish(
  host: FolderSyncHost,
  device: LibraryFolders,
  merged: FolderSet,
  revision: number
) {
  // An edit made on the shelf while the account answered is kept: it is
  // recorded on top of the merged set rather than overwritten by it, and
  // goes to the account with the next sync.
  const current = host.readDevice();
  const set =
    canonical(current) === canonical(device)
      ? merged
      : recordFolderChanges(merged, device, current, host.now());
  host.writeRecord({ revision, set });
  const next = deviceFoldersFromSet(set);
  if (canonical(next) !== canonical(current)) host.writeDevice(next);
}

// ── Browser wiring ─────────────────────────────────────────────────────────

const RECORD_PREFIX = 'openzcad.library.folders.sync.v2';
/** Lets a burst of shelf edits (a drag, a rename) go up as one write. */
const PUSH_DELAY_MS = 2_000;

export function folderSyncRecordKey(accountId: string): string {
  return `${RECORD_PREFIX}:${accountId}`;
}

function readSyncRecord(key: string): SyncRecord | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as { revision?: unknown; set?: unknown };
    const set = parseFolderSet(value.set);
    return set &&
      typeof value.revision === 'number' &&
      Number.isInteger(value.revision) &&
      value.revision >= 0
      ? { revision: value.revision, set }
      : null;
  } catch {
    return null;
  }
}

function writeSyncRecord(key: string, record: SyncRecord) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(record));
  } catch {
    // Without the record the next sync starts over from the device copy,
    // which merges back to the same folders.
  }
}

/** A refusal that means this account should not sync folders for now. */
const STOP_CODES = new Set([
  'LIBRARY_FOLDERS_DISABLED',
  'LIBRARY_FOLDERS_UNAVAILABLE',
  'LIBRARY_FOLDERS_ENCRYPTION_REQUIRED',
  'LIBRARY_FOLDERS_TOO_LARGE'
]);

interface FolderApi {
  getLibraryFolders(): Promise<LibraryFolderSnapshot>;
  saveLibraryFolders(
    request: SaveLibraryFolderRequest
  ): Promise<LibraryFolderSnapshot>;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function browserFolderSyncHost(
  accountId: string,
  api: FolderApi
): FolderSyncHost {
  const deviceKey = folderStorageKey(accountId);
  const recordKey = folderSyncRecordKey(accountId);
  return {
    readDevice: () => readLibraryFolders(deviceKey),
    writeDevice: (state) => writeLibraryFolders(deviceKey, state),
    readRecord: () => readSyncRecord(recordKey),
    writeRecord: (record) => writeSyncRecord(recordKey, record),
    load: () => api.getLibraryFolders(),
    save: async (request) => {
      try {
        return { saved: await api.saveLibraryFolders(request) };
      } catch (error) {
        const current = (error as { details?: { current?: unknown } } | null)
          ?.details?.current as LibraryFolderSnapshot | undefined;
        if (errorCode(error) === 'LIBRARY_FOLDERS_REVISION_CONFLICT' && current)
          return { conflict: current };
        throw error;
      }
    },
    now: () => Date.now()
  };
}

/** Accounts that stopped syncing folders during this visit. */
const stoppedAccounts = new Set<string>();
/**
 * Whether this account may send plaintext folder names, asked once per visit
 * and only before the first write: reading the account copy reveals nothing.
 */
const writeAllowed = new Map<string, Promise<boolean>>();

class FolderSyncStopped extends Error {}

/**
 * Syncs the signed-in account's folders while the library is shown: on
 * arrival, shortly after each shelf edit, and whenever the library refreshes
 * from the account. Signed out, it does nothing.
 */
export function useLibraryFolderCloudSync(
  accountId: string | null | undefined,
  folders: LibraryFolders
) {
  const request = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!accountId || stoppedAccounts.has(accountId)) return;
    let cancelled = false;
    let running: Promise<void> | null = null;
    let again = false;
    const stop = () => {
      stoppedAccounts.add(accountId);
      cancelled = true;
    };
    const run = async (): Promise<void> => {
      if (cancelled) return;
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          const { api, encryptsNewProjects } = await import('./api');
          const host = browserFolderSyncHost(accountId, api);
          const save = host.save;
          host.save = async (request) => {
            // Plaintext names must not leave a device whose account
            // encrypts its projects; an unanswerable check counts as yes.
            let allowed = writeAllowed.get(accountId);
            if (!allowed) {
              allowed = encryptsNewProjects().then(
                (encrypts) => !encrypts,
                () => false
              );
              writeAllowed.set(accountId, allowed);
            }
            if (!(await allowed) || cancelled) throw new FolderSyncStopped();
            return save(request);
          };
          const outcome = await syncLibraryFolders(host);
          if (outcome === 'unsupported') stop();
        } catch (error) {
          if (
            error instanceof FolderSyncStopped ||
            STOP_CODES.has(errorCode(error) ?? '')
          )
            stop();
          // Anything else (offline, a server error) waits for the next try.
        }
      })();
      try {
        await running;
      } finally {
        running = null;
        if (again && !cancelled) {
          again = false;
          void run();
        }
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    request.current = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), PUSH_DELAY_MS);
    };
    void run();
    const stopWatching = watchLibraryFreshness(run);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      request.current = null;
      stopWatching();
    };
  }, [accountId]);

  // A shelf edit (or another tab's) goes up shortly after it lands. The
  // sync's own write also arrives here and costs one cheap no-op round.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    request.current?.();
  }, [folders]);
}
