import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  LocalProjectAutosave,
  LocalProjectSaveRefusedError
} from './localProjectAutosave';
import {
  claimProjectOwnership,
  writeLocalProjectUnderClaim,
  writeOwnedProjectStorage,
  type ProjectStorageOwnership
} from './projectTabOwnership';
import { withLockManager } from '../test/fakeLockManager';
import { workspaceStorageClaim } from '../test/workspaceStorageClaim';

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseDocument = createProjectDocument(
  'Owned autosave',
  toUserId('user_owned_autosave')
);

function documentAt(version: number): ProjectDocument {
  return { ...baseDocument, version };
}

/**
 * The device store both tabs write: one key per project, last write wins,
 * which is the overwrite the claim exists to prevent. `hold` parks the next
 * write until `land` is called.
 */
function deviceStore() {
  const stored = new Map<string, ProjectDocument>();
  const started: ProjectDocument[] = [];
  let parked: (() => void) | null = null;
  let holdNext = false;
  return {
    stored,
    started,
    hold() {
      holdNext = true;
    },
    land() {
      parked?.();
      parked = null;
    },
    async save(document: ProjectDocument) {
      started.push(document);
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => (parked = resolve));
      }
      stored.set(document.projectId, document);
    }
  };
}

/** A tab's autosave, writing as App's `writePendingLocalDocument` does. */
function tabAutosave(
  read: () => ProjectStorageOwnership | null,
  save: (document: ProjectDocument) => Promise<void>
) {
  const onSaved = vi.fn();
  const onError = vi.fn();
  const write = vi.fn((document: ProjectDocument) =>
    writeLocalProjectUnderClaim(read, document.projectId, () => save(document))
  );
  const autosave = new LocalProjectAutosave({
    write,
    onSaved,
    onError,
    onDirtyChange: () => undefined
  });
  return {
    autosave,
    write,
    onSaved,
    onError,
    save(document: ProjectDocument) {
      autosave.enqueue(document);
      return autosave.flush();
    }
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('autosave under the project storage claim', () => {
  it('hands the project on only once the in-flight autosave lands', async () => {
    withLockManager();
    const store = deviceStore();
    const first = await workspaceStorageClaim(baseDocument.projectId);
    expect(first.ownership.owned).toBe(true);
    // A second tab opened beside it, read-only until the first lets go.
    const second = await workspaceStorageClaim(baseDocument.projectId);
    expect(second.ownership.owned).toBe(false);

    const tab = tabAutosave(first.read, store.save);
    store.hold();
    const saving = tab.save(documentAt(2));
    await vi.waitFor(() => expect(store.started).toHaveLength(1));

    // The first tab leaves the project while its write is in flight. The
    // second tab must not be let in (and save) before that write lands.
    first.giveUp();
    await tick();
    expect(second.ownership.owned).toBe(false);

    store.land();
    await saving;
    expect(tab.onSaved).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(second.ownership.owned).toBe(true));

    // The second tab's newer save is the one that stays.
    const other = tabAutosave(second.read, store.save);
    await other.save(documentAt(3));
    expect(store.stored.get(baseDocument.projectId)?.version).toBe(3);
    second.giveUp();
  });

  it('keeps an edit queued behind the in-flight write when the workspace leaves', async () => {
    // Home flushes, then awaits the account while the workspace stays open:
    // two edits land, and the first is still being written when Home
    // closes the project. The second must be saved, not dropped, and only
    // then is the project handed on.
    withLockManager();
    const store = deviceStore();
    const first = await workspaceStorageClaim(baseDocument.projectId);
    const promoted = vi.fn();
    const other = await claimProjectOwnership(baseDocument.projectId, promoted);

    const tab = tabAutosave(first.read, store.save);
    store.hold();
    void tab.save(documentAt(2));
    await vi.waitFor(() => expect(store.started).toHaveLength(1));
    tab.autosave.enqueue(documentAt(3));
    expect(tab.autosave.dirty).toBe(true);

    // App's cleanup: autosave is dirty, so the claim is held for its drain.
    first.giveUp(() => tab.autosave.flush());
    await tick();
    expect(promoted).not.toHaveBeenCalled();

    store.land();
    await vi.waitFor(() => expect(promoted).toHaveBeenCalledTimes(1));
    expect(store.started.map((document) => document.version)).toEqual([2, 3]);
    expect(store.stored.get(baseDocument.projectId)?.version).toBe(3);
    expect(tab.autosave.dirty).toBe(false);
    expect(tab.onError).not.toHaveBeenCalled();
    other.release();
  });

  it('refuses an autosave after the claim is given up, keeping the work unsaved', async () => {
    withLockManager();
    const store = deviceStore();
    const first = await workspaceStorageClaim(baseDocument.projectId);
    const promoted = vi.fn();
    const other = await claimProjectOwnership(baseDocument.projectId, promoted);

    const tab = tabAutosave(first.read, store.save);
    await tab.save(documentAt(2));
    expect(store.stored.get(baseDocument.projectId)?.version).toBe(2);

    first.giveUp();
    await vi.waitFor(() => expect(promoted).toHaveBeenCalledTimes(1));
    // Another tab owns the project now (and may have saved newer work); a
    // late autosave from this one must not land on top of it, and must not
    // be reported as saved either: a departure barrier rejects.
    await expect(tab.save(documentAt(4))).rejects.toBeInstanceOf(
      LocalProjectSaveRefusedError
    );
    await expect(tab.write.mock.results[1]!.value).resolves.toBe('refused');
    expect(store.started).toHaveLength(1);
    expect(store.stored.get(baseDocument.projectId)?.version).toBe(2);
    expect(tab.onSaved).toHaveBeenCalledTimes(1);
    expect(tab.onError).not.toHaveBeenCalled();
    expect(tab.autosave.dirty).toBe(true);
    other.release();
  });

  it('drops the opening write of a read-only tab, and refuses another project', async () => {
    withLockManager();
    const store = deviceStore();
    const owner = await workspaceStorageClaim(baseDocument.projectId);
    const reader = await workspaceStorageClaim(baseDocument.projectId);
    expect(reader.ownership.owned).toBe(false);

    // The read-only tab has nothing of its own to save: not kept dirty.
    const readOnly = tabAutosave(reader.read, store.save);
    await readOnly.save(documentAt(2));
    await expect(readOnly.write.mock.results[0]!.value).resolves.toBe(false);
    expect(readOnly.autosave.dirty).toBe(false);

    const elsewhere = tabAutosave(owner.read, store.save);
    await expect(
      elsewhere.save({
        ...documentAt(2),
        projectId: 'project_elsewhere' as ProjectDocument['projectId']
      })
    ).rejects.toBeInstanceOf(LocalProjectSaveRefusedError);
    expect(store.started).toEqual([]);
    reader.giveUp();
    owner.giveUp();
  });

  it('does not start a write when the claim is let go between the grant and the write', async () => {
    let current: ProjectStorageOwnership | null = null;
    const ownership: ProjectStorageOwnership = {
      projectId: baseDocument.projectId,
      owned: true,
      settled: Promise.resolve(),
      retain() {
        // App's cleanup runs in the microtask after the grant.
        queueMicrotask(() => {
          ownership.owned = false;
          current = null;
        });
        return () => undefined;
      }
    };
    current = ownership;
    const write = vi.fn(async () => undefined);
    await expect(
      writeOwnedProjectStorage(() => current, baseDocument.projectId, write)
    ).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('lets go of the claim when the write fails, keeping the work for retry', async () => {
    withLockManager();
    const first = await workspaceStorageClaim(baseDocument.projectId);
    const promoted = vi.fn();
    const other = await claimProjectOwnership(baseDocument.projectId, promoted);
    const tab = tabAutosave(first.read, async () => {
      throw new Error('quota');
    });
    await expect(tab.save(documentAt(2))).rejects.toThrow();
    expect(tab.onError).toHaveBeenCalledTimes(1);
    expect(tab.autosave.dirty).toBe(true);
    // Nothing still retains the lock: giving the project up hands it on.
    first.giveUp();
    await vi.waitFor(() => expect(promoted).toHaveBeenCalledTimes(1));
    other.release();
  });
});
