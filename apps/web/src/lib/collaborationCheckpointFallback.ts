import {
  createSavedRevision,
  withEchoedSavePoints
} from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import { saveLocalSaveStates } from './localProjectStore';
import { errorMessage } from './errors';
import { normalizeCheckpointReason } from './collaborationProtocol';

export interface CheckpointOptions {
  isCurrent(): boolean;
  readDocument(): ProjectDocument;
  applyDocument(document: ProjectDocument): void;
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
    localSaved = true;
    if (!confirmed && isCurrent() && options.isCurrent()) {
      const current = options.readDocument();
      options.applyDocument(withEchoedSavePoints(current, local));
    }
  } catch {
    // Preserve the primary failure while reporting device durability honestly.
  }
  const primary = errorMessage(error, 'The named save failed.');
  throw new Error(
    `${primary} ${confirmed ? 'The revision is stored in the room. ' : ''}${localSaved ? 'The named save is stored on this device.' : 'The named save could not be stored on this device.'}`,
    { cause: error }
  );
}
