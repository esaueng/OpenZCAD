import type { WorkspaceSaveState } from './cloudProjectAutosave';
import type { CollaborationStatus } from './useCollaboration';

/** A room refusal is a completed failure, never an outstanding account save. */
export function collaborationSaveState(
  status: CollaborationStatus,
  hasConflict: boolean,
  roomVersion: number | null,
  documentVersion: number | undefined
): WorkspaceSaveState {
  if (hasConflict || status === 'conflict') return 'conflict';
  if (status === 'offline') return 'offline';
  // The sharing chip explains the room refusal or required update. The save
  // indicator promises only the durable device copy, without an account-size
  // diagnosis (the account and room have different limits).
  if (
    status === 'oversize' ||
    status === 'rejected' ||
    status === 'update-required'
  )
    return 'local';
  const acknowledged = roomVersion !== null && roomVersion === documentVersion;
  if (acknowledged) return 'synced';
  if (status === 'read-only' || status === 'lease-denied') return 'local';
  return 'syncing';
}
