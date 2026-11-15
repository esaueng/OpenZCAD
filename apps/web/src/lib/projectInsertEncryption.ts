/**
 * File → Insert project… moves another project's content under the open
 * project's id. When this device keeps that other project encrypted, the
 * content keeps that requirement here too, settled before anything is
 * stored, archived or committed (PR #1418), the way a backup import or a
 * duplicate carries it (`carryEncryptionRequirement`). It is settled again
 * immediately before the commit, since another tab can pin the source
 * meanwhile, and every upload names the source to the send gate
 * (`projectRequest`'s `sources`), which refuses its plaintext then.
 */
import {
  carryEncryptionRequirement,
  encryptionRequired,
  isEncryptedProject
} from './api';

/** The open project the bodies are about to land in. */
export interface ProjectInsertDestination {
  projectId: string;
  /** The account holds a copy of it (its writes go to the account). */
  onAccount: boolean;
}

export const INSERT_DESTINATION_CHANGED =
  'The project changed while inserting; nothing was added.';

export const INSERT_INTO_PLAINTEXT_REFUSED =
  'This device keeps the project you picked end-to-end encrypted, and this project is not encrypted, so nothing was added. Encrypt this project first, or insert into an encrypted project.';

/**
 * Null when the insert may go ahead, or why it may not.
 *
 * - The source carries no requirement here: go ahead.
 * - The destination is an account project that is not encrypted: refused.
 * - Otherwise the requirement is carried to the destination durably first
 *   (`carryEncryptionRequirement`), or this throws and nothing is
 *   inserted: an encrypted account project's pin must be saved here, not
 *   only held in this tab (another tab may have reset it, which a reload
 *   would follow), and a device-only project records the requirement, so
 *   a later adoption is encrypted only.
 */
export function insertEncryptionRefusal(
  sourceProjectId: string,
  destination: ProjectInsertDestination
): string | null {
  if (!encryptionRequired(sourceProjectId)) return null;
  if (destination.onAccount && !isEncryptedProject(destination.projectId)) {
    return INSERT_INTO_PLAINTEXT_REFUSED;
  }
  carryEncryptionRequirement(sourceProjectId, destination.projectId, {
    account: destination.onAccount
  });
  return null;
}
