import { duplicateProjectDocument } from '@openzcad/document-core';
import type { ProjectDocument, UserId } from '@openzcad/shared';
import {
  duplicateProjectName,
  MAX_PROJECT_NAME_LENGTH
} from '@openzcad/shared';
import { carryEncryptionRequirement } from './api';
import { saveLocalProject } from './localProjectStore';

/**
 * What a share link's copy is called: the shared model's own name, as the
 * owner wrote it. Only when the visitor already has a project of that name
 * (case-insensitively, as the shelf compares) does it take the usual
 * "(copy)" suffix, so the two stay told apart.
 */
export function shareLinkCopyName(
  sharedName: string,
  existingNames: Iterable<string>
): string {
  const names = [...existingNames];
  const wanted = sharedName.trim().toLowerCase();
  const taken = names.some(
    (existing) => existing.trim().toLowerCase() === wanted
  );
  // Kept exactly as stored, never cut: slicing could split a surrogate pair.
  if (!wanted || taken || sharedName.length > MAX_PROJECT_NAME_LENGTH) {
    return duplicateProjectName(sharedName, names);
  }
  return sharedName;
}

/**
 * A shared link's document copied into a project of the visitor's own, under
 * a new id and saved on this device. When this device keeps the shared
 * project encrypted (a member who also opened its link, say), the copy keeps
 * that requirement, recorded before anything is written, or nothing is
 * copied. A source this device holds nothing for copies as any device
 * project does (PR #1418).
 */
export async function saveShareLinkCopy(
  source: ProjectDocument,
  name: string,
  ownerUserId: UserId,
  save: (document: ProjectDocument) => Promise<void> = saveLocalProject
): Promise<ProjectDocument> {
  const copy = duplicateProjectDocument(source, name, ownerUserId);
  carryEncryptionRequirement(source.projectId, copy.projectId, {
    account: false
  });
  await save(copy);
  return copy;
}
