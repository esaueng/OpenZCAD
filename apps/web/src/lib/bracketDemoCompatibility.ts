import {
  appendRevision,
  normalizeDocument,
  repairLegacyBracketRecipe,
  repairLegacyBracketModel
} from '@openzcad/document-core';
import type { ProjectDocument, UserId } from '@openzcad/shared';

/** Owned document upgrade: keep proven history, and record the model revision. */
export function repairLegacyBracketDemo(
  document: ProjectDocument
): ProjectDocument {
  const repaired = repairLegacyBracketRecipe(document);
  return repaired === document
    ? document
    : appendRevision(repaired, 'Repair bracket fillet clearance');
}

/** Restore discards source history, after validating the owner's identity. */
export function repairLegacyBracketSaveState(
  current: ProjectDocument,
  snapshot: ProjectDocument,
  owners: readonly UserId[]
): ProjectDocument {
  if (
    current.projectId !== snapshot.projectId ||
    current.ownerUserId !== snapshot.ownerUserId ||
    !owners.includes(current.ownerUserId)
  )
    return snapshot;
  return repairLegacyBracketModel(normalizeDocument(snapshot));
}
