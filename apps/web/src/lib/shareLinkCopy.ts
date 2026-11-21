import {
  duplicateProjectDocument,
  withoutSharedHistoryMark
} from '@openzcad/document-core';
import type { ProjectDocument, UserId } from '@openzcad/shared';
import { carryEncryptionRequirement } from './api';
import { saveLocalProject } from './localProjectStore';

/**
 * A shared link's document copied into a project of the visitor's own, under
 * a new id and saved on this device. When this device keeps the shared
 * project encrypted (a member who also opened its link, say), the copy keeps
 * that requirement, recorded before anything is written, or nothing is
 * copied. A source this device holds nothing for copies as any device
 * project does (PR #1418).
 *
 * The copy holds exactly what the link served. A link without history (L08)
 * served imported solids and nothing else, so its copy cannot carry the
 * owner's features, sketches, parameters or save states either.
 */
export async function saveShareLinkCopy(
  source: ProjectDocument,
  name: string,
  ownerUserId: UserId,
  save: (document: ProjectDocument) => Promise<void> = saveLocalProject
): Promise<ProjectDocument> {
  // L08: a model shared without history copies as what the link served,
  // imported solids only, and as an ordinary project (the mark stays behind).
  const copy = withoutSharedHistoryMark(
    duplicateProjectDocument(source, name, ownerUserId)
  );
  carryEncryptionRequirement(source.projectId, copy.projectId, {
    account: false
  });
  await save(copy);
  return copy;
}
