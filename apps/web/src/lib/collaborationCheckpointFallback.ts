import {
  createSavedRevision,
  withEchoedSavePoints
} from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import {
  projectsHaveSameCanonicalContent,
  listLocalSaveStateIds,
  saveLocalSaveStates
} from './localProjectStore';
import { errorMessage } from './errors';
import { normalizeCheckpointReason } from './collaborationProtocol';
import type { WorkspaceSaveState } from './cloudProjectAutosave';

export interface CheckpointOptions {
  isCurrent(): boolean;
  readDocument(): ProjectDocument;
  applyDocument(document: ProjectDocument): void;
}

/** Durability of the clicked named snapshot, not of any buffered live edits. */
export class CheckpointSaveError extends Error {
  readonly roomStored: boolean;

  constructor(
    cause: unknown,
    readonly roomDocument: ProjectDocument | null,
    readonly deviceStored: boolean
  ) {
    const roomStored = roomDocument !== null;
    super(
      `${errorMessage(cause, 'The named save failed.')} ${roomStored ? 'The revision is stored in the room. ' : ''}${deviceStored ? 'The named save is stored on this device.' : 'The named save could not be stored on this device.'}`,
      { cause }
    );
    this.roomStored = roomStored;
  }
}

export function checkpointRoomCoversDocument(
  room: ProjectDocument | null,
  document: ProjectDocument | null
): boolean {
  return Boolean(
    room &&
    document &&
    room.projectId === document.projectId &&
    room.ownerUserId === document.ownerUserId &&
    room.version === document.version &&
    projectsHaveSameCanonicalContent(room, document)
  );
}

export function failedCheckpointSaveState(
  error: unknown,
  current: WorkspaceSaveState,
  deviceDirty: boolean,
  document: ProjectDocument | null = null
): WorkspaceSaveState {
  const roomCoversCurrent = checkpointRoomCoversDocument(
    error instanceof CheckpointSaveError ? error.roomDocument : null,
    document
  );
  // Keep the failed device queue, but do not describe this exact proven room
  // head as existing only in the tab. Newer graph/history still lacks proof.
  if (current === 'device-failed' && roomCoversCurrent) return 'room-only';
  // Only the head writer knows whether newer live edits are durable. A saved
  // named snapshot must never clear its pending or failed device write.
  if (deviceDirty || current === 'device-failed') return current;
  if (!(error instanceof CheckpointSaveError)) return 'checkpoint-failed';
  if (error.deviceStored) return roomCoversCurrent ? 'synced' : 'local';
  return error.roomStored ? 'room-only' : 'checkpoint-failed';
}

/** Keep the clicked named state even when the room action cannot load. */
export async function preserveFailedCheckpoint(
  error: unknown,
  snapshot: ProjectDocument,
  reason: string,
  options: CheckpointOptions,
  isCurrent: () => boolean,
  authoritative: ProjectDocument | null = null,
  confirmed = false
): Promise<never> {
  const local =
    authoritative ??
    createSavedRevision(snapshot, normalizeCheckpointReason(reason));
  let localSaved = false;
  try {
    // Save only the captured state, never an older project head.
    await saveLocalSaveStates([local]);
    const checkpoint = local.checkpoints.at(-1);
    localSaved =
      !!checkpoint &&
      (await listLocalSaveStateIds(local.projectId)).has(
        checkpoint.checkpointId
      );
    // Only server-backed points belong to the collaborative document. A local
    // fallback remains available through the device's saved-state projection.
    if (authoritative && !confirmed && isCurrent() && options.isCurrent()) {
      const current = options.readDocument();
      options.applyDocument(withEchoedSavePoints(current, local));
    }
  } catch {
    // Preserve the primary failure while reporting device durability honestly.
  }
  throw new CheckpointSaveError(error, authoritative, localSaved);
}
