import { CommandManager, commandFactories } from '@openzcad/command-system';
import { withoutDerivedProjection } from '@openzcad/document-core';
import { projectNameProblem } from './projectNameHints';
import {
  type ProjectDocument,
  type SaveProjectDocumentRequest,
  type SaveProjectDocumentResponse,
  type UserId
} from '@openzcad/shared';

/** A rename the library cannot make without opening the project. */
export class LibraryRenameRefusal extends Error {}

export interface LibraryRenameHost {
  /** Who the rename is recorded for, as an edit made in the workspace is. */
  actorUserId: UserId;
  loadLocal(projectId: string): Promise<ProjectDocument | null>;
  saveLocal(document: ProjectDocument): Promise<void>;
  /**
   * Present for a project the account stores. The rename is then written
   * there first, fenced on the version just read, and kept on the device
   * only once the account has taken it.
   */
  account?: {
    load(projectId: string): Promise<ProjectDocument>;
    save(
      input: SaveProjectDocumentRequest
    ): Promise<SaveProjectDocumentResponse>;
    markSynced(projectId: string, version: number): Promise<void>;
  };
}

function renamed(
  document: ProjectDocument,
  name: string,
  actorUserId: UserId
): ProjectDocument {
  return new CommandManager(document, actorUserId).execute(
    commandFactories.renameNode({ nodeId: document.rootNodeId, name })
  );
}

/**
 * Renames a project from the library, without opening it: the same rename
 * command the workspace's title runs, so it lands in the project's undo
 * history like any other. Resolves to the document now stored on the device.
 *
 * A project this device has changed since its last account save is refused
 * rather than renamed: writing the account's copy would leave the two
 * diverged, and writing this device's would overwrite the account. Opening
 * the project is what reconciles them, so that is what the refusal asks for.
 */
export async function renameLibraryProject(
  projectId: string,
  name: string,
  host: LibraryRenameHost
): Promise<ProjectDocument> {
  const problem = projectNameProblem(name);
  if (problem) throw new LibraryRenameRefusal(problem);
  const trimmed = name.trim();
  const local = await host.loadLocal(projectId);
  if (!host.account) {
    if (!local) {
      throw new LibraryRenameRefusal(
        'This project is not stored on this device.'
      );
    }
    const next = renamed(local, trimmed, host.actorUserId);
    await host.saveLocal(next);
    return next;
  }
  const remote = await host.account.load(projectId);
  if (local && local.version > remote.version) {
    throw new LibraryRenameRefusal(
      'This device has changes your account has not saved yet. Open the project to rename it.'
    );
  }
  const next = renamed(remote, trimmed, host.actorUserId);
  const response = await host.account.save({
    projectId: remote.projectId,
    expectedVersion: remote.version,
    document: withoutDerivedProjection(next)
  });
  // The device copy keeps its meshes when they still describe the model,
  // which a rename never changes; the account copy travels without them.
  const stored: ProjectDocument = {
    ...next,
    version: response.version,
    ...(local && local.version === remote.version
      ? { derived: local.derived }
      : {})
  };
  await host.saveLocal(stored);
  await host.account.markSynced(projectId, response.version).catch(() => {
    // Only the next open's comparison baseline; the copies already agree.
  });
  return stored;
}
