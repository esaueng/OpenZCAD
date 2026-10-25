/**
 * Reports what the encrypted-project store verifies to the editor's
 * encryption indicator (`encryptionStatus.ts`): every head the page opens
 * or writes — an account load or save, a new project or copy, a head the
 * live room relays or accepts — and every verification failure. Loaded
 * with the store, never by the entry chunk.
 */
import type {
  EncryptedProjectStore,
  EncryptedRoomAccess
} from './encryptedProjectStore';
import { reportEncryptedFailure, reportHeadVerified } from './encryptionStatus';

/**
 * `current` says whether the key session that opened the store is still
 * the page's: a result finishing after it ended reports nothing.
 */
export function reportingEncryptedProjectStore(
  store: EncryptedProjectStore,
  current: () => boolean
): EncryptedProjectStore {
  const verifiedHead = <R>(
    run: () => Promise<R>,
    projectIdOf: (result: R) => string,
    projectId: string | null
  ): Promise<R> =>
    run().then(
      (result) => {
        if (current()) reportHeadVerified(projectIdOf(result));
        return result;
      },
      (error: unknown) => {
        if (current()) reportEncryptedFailure(projectId, error);
        throw error;
      }
    );
  /** A read that checks a project without opening or writing its head. */
  const checked = <R>(run: () => Promise<R>, projectId: string): Promise<R> =>
    run().catch((error: unknown) => {
      if (current()) reportEncryptedFailure(projectId, error);
      throw error;
    });

  let room: EncryptedRoomAccess | null = null;
  const roomAccess = (): EncryptedRoomAccess => {
    if (room) return room;
    const access = store.roomAccess();
    room = {
      currentHead: (projectId) => access.currentHead(projectId),
      seal: (projectId, document, base) =>
        checked(() => access.seal(projectId, document, base), projectId),
      openHead: (projectId, record, envelope) =>
        verifiedHead(
          () => access.openHead(projectId, record, envelope),
          () => projectId,
          projectId
        ),
      accepted: (projectId, sealed, base, record) =>
        verifiedHead(
          () => access.accepted(projectId, sealed, base, record),
          () => projectId,
          projectId
        ),
      catchUp: (projectId) =>
        checked(() => access.catchUp(projectId), projectId),
      restoreBlobs: (projectId, blobIds) =>
        checked(() => access.restoreBlobs(projectId, blobIds), projectId)
    };
    return room;
  };

  return {
    createProject: (request) =>
      verifiedHead(
        () => store.createProject(request),
        (created) => created.project.projectId,
        null
      ),
    copyProject: (request) =>
      verifiedHead(
        () => store.copyProject(request),
        (created) => created.project.projectId,
        null
      ),
    saveProjectDocument: (payload) =>
      verifiedHead(
        () => store.saveProjectDocument(payload),
        () => payload.projectId,
        payload.projectId
      ),
    saveRevision: (payload) =>
      verifiedHead(
        () => store.saveRevision(payload),
        () => payload.projectId,
        payload.projectId
      ),
    loadProject: (projectId) =>
      verifiedHead(
        () => store.loadProject(projectId),
        () => projectId,
        projectId
      ),
    loadRevision: (projectId, revisionId) =>
      checked(() => store.loadRevision(projectId, revisionId), projectId),
    listRevisions: (projectId) =>
      checked(() => store.listRevisions(projectId), projectId),
    projectName: (record) => store.projectName(record),
    info: store.info,
    replaced: store.replaced,
    roomAccess
  };
}
