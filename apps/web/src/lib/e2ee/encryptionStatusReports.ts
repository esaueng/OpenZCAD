/**
 * Reports what the encrypted-project store verifies to the editor's
 * encryption indicator (`encryptionStatus.ts`): every head the page opens
 * or writes — an account load or save, a new project or copy, a head the
 * live room relays or accepts, a migration's staged first version and the
 * head its journal is read from (slice 7-2) — and every verification
 * failure. Loaded with the store, never by the entry chunk.
 */
import type {
  EncryptedProjectStore,
  EncryptedRoomAccess
} from './encryptedProjectStore';
import {
  beginEncryptionStatusReport,
  reportEncryptedFailure,
  reportHeadVerified
} from './encryptionStatus';

/**
 * `current` says whether the key session that opened the store is still
 * the page's: a result finishing after it ended reports nothing.
 * A page may additionally fence operations/results with `assertActive`.
 */
export function reportingEncryptedProjectStore(
  store: EncryptedProjectStore,
  current: () => boolean,
  assertActive?: () => void
): EncryptedProjectStore {
  const active = async <R>(run: () => Promise<R>): Promise<R> => {
    assertActive?.();
    try {
      const result = await run();
      assertActive?.();
      return result;
    } catch (error) {
      assertActive?.();
      throw error;
    }
  };
  const verifiedHead = async <R>(
    run: () => Promise<R>,
    projectIdOf: (result: R) => string,
    projectId: string | null,
    retainedOnly = false
  ): Promise<R> => {
    assertActive?.();
    const report = beginEncryptionStatusReport(projectId, retainedOnly);
    try {
      const result = await run();
      assertActive?.();
      if (report() && current()) {
        const id = projectIdOf(result);
        reportHeadVerified(id, store.stateCode?.(id));
      }
      return result;
    } catch (error) {
      assertActive?.();
      if (report() && current()) reportEncryptedFailure(projectId, error);
      throw error;
    }
  };
  /** A read that checks a project without opening or writing its head. */
  const checked = async <R>(
    run: () => Promise<R>,
    projectId: string,
    retainedOnly = false
  ): Promise<R> => {
    assertActive?.();
    const report = beginEncryptionStatusReport(projectId, retainedOnly);
    try {
      const result = await run();
      assertActive?.();
      report();
      return result;
    } catch (error) {
      assertActive?.();
      if (report() && current()) reportEncryptedFailure(projectId, error);
      throw error;
    }
  };

  let room: EncryptedRoomAccess | null = null;
  const roomAccess = (): EncryptedRoomAccess => {
    assertActive?.();
    if (room) return room;
    const access = store.roomAccess();
    room = {
      currentHead: (projectId) => {
        assertActive?.();
        return access.currentHead(projectId);
      },
      seal: (projectId, document, base) =>
        checked(() => access.seal(projectId, document, base), projectId, true),
      openHead: (projectId, record, envelope) =>
        verifiedHead(
          () => access.openHead(projectId, record, envelope),
          () => projectId,
          projectId,
          true
        ),
      accepted: (projectId, sealed, base, record) =>
        verifiedHead(
          () => access.accepted(projectId, sealed, base, record),
          () => projectId,
          projectId,
          true
        ),
      catchUp: (projectId) =>
        checked(() => access.catchUp(projectId), projectId, true),
      restoreBlobs: (projectId, blobIds) =>
        checked(() => access.restoreBlobs(projectId, blobIds), projectId, true)
    };
    return room;
  };

  return {
    stateCode: store.stateCode
      ? (projectId) => {
          assertActive?.();
          return store.stateCode!(projectId);
        }
      : undefined,
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
    projectName: (record) => active(() => store.projectName(record)),
    info: assertActive
      ? {
          verify: (record) => active(() => store.info.verify(record)),
          read: (projectId) => active(() => store.info.read(projectId)),
          update: (projectId, change) =>
            active(() =>
              store.info.update(projectId, (value) => {
                assertActive();
                return change(value);
              })
            )
        }
      : store.info,
    replaced: assertActive
      ? {
          seal: (...args) => active(() => store.replaced.seal(...args)),
          open: (...args) => active(() => store.replaced.open(...args))
        }
      : store.replaced,
    roomAccess,
    // Share links (slice 5-10): both read the verified head, and a change
    // writes a version, so both report like a load or save.
    shareHead: (projectId) =>
      verifiedHead(
        () => store.shareHead(projectId),
        () => projectId,
        projectId
      ),
    writeShareLinks: (projectId, change) =>
      verifiedHead(
        () =>
          store.writeShareLinks(projectId, (...args) => {
            assertActive?.();
            return change(...args);
          }),
        () => projectId,
        projectId
      ),
    // A migration (slice 7-2): the staged first version is a head this
    // page wrote, and the journal is read from a head this page verified.
    stageMigratedProject: (request) =>
      verifiedHead(
        () => store.stageMigratedProject(request),
        (created) => created.project.projectId,
        request.document.projectId
      ),
    revisionMap: (projectId) =>
      verifiedHead(
        () => store.revisionMap(projectId),
        () => projectId,
        projectId
      ),
    // Forgetting a staging the account dropped verifies nothing.
    forgetStagedProject: (projectId) =>
      active(() => store.forgetStagedProject(projectId))
  };
}
