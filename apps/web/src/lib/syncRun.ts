import { ApiError } from './api';
import { errorMessage } from './errors';

/**
 * One project's place in a save-to-account run. The run outlives the network
 * calls that drive it: entries stay on screen after the loop finishes so the
 * user can read why something failed and retry it, so an entry has to carry
 * its own explanation rather than leaning on a transient status line.
 */
export type SyncEntryState = 'pending' | 'syncing' | 'synced' | 'failed';

export interface SyncEntry {
  projectId: string;
  name: string;
  state: SyncEntryState;
  /** Why a failure failed, or a note on how a success resolved. */
  detail?: string;
}

export function syncRunTotals(entries: ReadonlyArray<SyncEntry>): {
  total: number;
  synced: number;
  failed: number;
  settled: number;
  active: boolean;
} {
  let synced = 0;
  let failed = 0;
  for (const entry of entries) {
    if (entry.state === 'synced') synced += 1;
    if (entry.state === 'failed') failed += 1;
  }
  const settled = synced + failed;
  return {
    total: entries.length,
    synced,
    failed,
    settled,
    active: settled < entries.length
  };
}

/**
 * Turns a thrown save failure into a sentence a user can act on. The `auth`
 * flag tells the bulk loop to stop: every later attempt would fail the same
 * way, and hammering an expired session with N more requests helps no one.
 */
export function describeSyncFailure(error: unknown): {
  detail: string;
  auth: boolean;
} {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return {
        detail: 'Your sign-in expired. Sign in again, then retry.',
        auth: true
      };
    }
    return { detail: error.message, auth: false };
  }
  if (error instanceof TypeError) {
    return {
      detail: 'Could not reach the server. Check your connection and retry.',
      auth: false
    };
  }
  return {
    detail: errorMessage(error, 'Something went wrong saving this project.'),
    auth: false
  };
}
