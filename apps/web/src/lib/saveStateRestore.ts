import {
  appendRevision,
  createCheckpoint,
  recordDocumentEdit,
  restoreFromSaveState
} from '@openzcad/document-core';
import type { ProjectDocument, UserId } from '@openzcad/shared';
import { saveLocalProject, saveLocalSaveStates } from './localProjectStore';

/** Store the way back before the caller applies one undoable model edit. */
export async function prepareSaveStateRestore(
  current: ProjectDocument,
  snapshot: ProjectDocument,
  reason: string,
  deviceOnlyHistory = false,
  actorUserId: UserId = current.ownerUserId
): Promise<ProjectDocument> {
  const guarded = createCheckpoint(
    appendRevision(current, 'Before restore'),
    'Before restore'
  );
  if (deviceOnlyHistory) await saveLocalSaveStates([guarded]);
  else await saveLocalProject(guarded);

  const marked = createCheckpoint(
    restoreFromSaveState(guarded, snapshot, reason),
    reason
  );
  if (!deviceOnlyHistory) return marked;

  // Ordinary member room writes store the model, not revision bodies. Keep
  // both restore points on this device rather than advertise unrestorable
  // checkpoint IDs to collaborators. The live command manager records the
  // same undoable model edit while retaining only acknowledged save points.
  await saveLocalSaveStates([
    recordDocumentEdit(current, marked, reason, actorUserId)
  ]);
  return {
    ...marked,
    revisions: current.revisions,
    checkpoints: current.checkpoints
  };
}
