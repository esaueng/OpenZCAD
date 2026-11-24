import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { LocalProjectAutosave } from './localProjectAutosave';
import {
  claimProjectOwnership,
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
    writeOwnedProjectStorage(read, document.projectId, () => save(document))
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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

  it('refuses, writing nothing, an autosave after the claim is given up', async () => {
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
    // late autosave from this one must not land on top of it.
    await tab.save(documentAt(4));
    expect(tab.write).toHaveBeenCalledTimes(2);
    await expect(tab.write.mock.results[1]!.value).resolves.toBe(false);
    expect(store.started).toHaveLength(1);
    expect(store.stored.get(baseDocument.projectId)?.version).toBe(2);
    expect(tab.onSaved).toHaveBeenCalledTimes(1);
    expect(tab.onError).not.toHaveBeenCalled();
    other.release();
  });

  it('refuses while another tab holds the project, and for another project', async () => {
    withLockManager();
    const store = deviceStore();
    const owner = await workspaceStorageClaim(baseDocument.projectId);
    const reader = await workspaceStorageClaim(baseDocument.projectId);
    expect(reader.ownership.owned).toBe(false);

    await tabAutosave(reader.read, store.save).save(documentAt(2));
    await tabAutosave(owner.read, store.save).save({
      ...documentAt(2),
      projectId: 'project_elsewhere' as ProjectDocument['projectId']
    });
    expect(store.started).toEqual([]);
    reader.giveUp();
    owner.giveUp();
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
