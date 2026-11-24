import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandFactories, CommandManager } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { LocalProjectAutosave } from './localProjectAutosave';
import {
  NAVIGATION_EDIT_PAUSE_REASON,
  NavigationEditPause,
  NavigationEditPausedError
} from './navigationEditPause';
import {
  claimProjectOwnership,
  writeLocalProjectUnderClaim,
  type ProjectStorageOwnership
} from './projectTabOwnership';
import { withLockManager } from '../test/fakeLockManager';
import { workspaceStorageClaim } from '../test/workspaceStorageClaim';

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER = toUserId('user_navigation_pause');

const project = (name: string) => createProjectDocument(name, USER);

function rename(manager: CommandManager, name: string): ProjectDocument {
  return manager.execute(
    commandFactories.renameNode({
      nodeId: manager.document.rootNodeId,
      name
    })
  );
}

/** A workspace: its manager, under the pause, autosaving each commit. */
function workspace(
  pause: NavigationEditPause,
  document: ProjectDocument,
  read: () => ProjectStorageOwnership | null,
  save: (document: ProjectDocument) => Promise<void>
) {
  const manager = new CommandManager(document, USER);
  pause.guard(manager);
  const opened = manager.document;
  const autosave = new LocalProjectAutosave({
    write: (document) =>
      writeLocalProjectUnderClaim(
        read,
        document.projectId,
        () => save(document),
        document === opened
      ),
    onSaved: () => undefined,
    onError: () => undefined,
    onDirtyChange: () => undefined
  });
  return {
    manager,
    autosave,
    /** An edit as App commits one: on the manager, then to autosave. */
    edit(newName: string) {
      const next = rename(manager, newName);
      autosave.enqueue(next);
      return next;
    }
  };
}

/** One key per project, last write wins; `hold` parks the next write. */
function deviceStore() {
  const stored = new Map<string, ProjectDocument>();
  let parked: (() => void) | null = null;
  let holdNext = false;
  return {
    stored,
    get waiting() {
      return parked !== null;
    },
    hold() {
      holdNext = true;
    },
    land() {
      parked?.();
      parked = null;
    },
    async save(document: ProjectDocument) {
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => (parked = resolve));
      }
      stored.set(document.projectId, document);
    }
  };
}

describe('NavigationEditPause', () => {
  it('refuses an edit while a navigation leaves the project, so nothing reaches autosave', () => {
    const pause = new NavigationEditPause();
    const tab = workspace(
      pause,
      project('A'),
      () => null,
      async () => undefined
    );
    const enqueue = vi.spyOn(tab.autosave, 'enqueue');
    const before = tab.manager.document;
    pause.begin(tab.manager);
    expect(pause.reasonFor(tab.manager)).toBe(NAVIGATION_EDIT_PAUSE_REASON);
    expect(() => tab.edit('During the navigation')).toThrow(
      NavigationEditPausedError
    );
    expect(() => tab.manager.undo()).toThrow(NavigationEditPausedError);
    expect(tab.manager.document).toBe(before);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('re-enables editing when the navigation ends, however it ends', () => {
    const pause = new NavigationEditPause();
    const onChange = vi.fn();
    const tab = workspace(
      pause,
      project('A'),
      () => null,
      async () => undefined
    );
    const tracked = new NavigationEditPause(onChange);
    tracked.guard(tab.manager);
    const end = tracked.begin(tab.manager);
    expect(onChange).toHaveBeenCalledTimes(1);
    // An aborted navigation (a failed flush, a refused open) ends it.
    end();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(tracked.reasonFor(tab.manager)).toBeNull();
    expect(tab.edit('After the abort').name).toBe('After the abort');
    // Ending again does nothing.
    end();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('keeps a newer navigation paused when an older one ends', () => {
    const pause = new NavigationEditPause();
    const tab = workspace(
      pause,
      project('A'),
      () => null,
      async () => undefined
    );
    const older = pause.begin(tab.manager);
    const newer = pause.begin(tab.manager);
    older();
    expect(pause.reasonFor(tab.manager)).toBe(NAVIGATION_EDIT_PAUSE_REASON);
    newer();
    expect(pause.reasonFor(tab.manager)).toBeNull();
  });

  it('leaves the project the navigation opened editable', () => {
    const pause = new NavigationEditPause();
    const a = workspace(
      pause,
      project('A'),
      () => null,
      async () => undefined
    );
    pause.begin(a.manager);
    const b = workspace(
      pause,
      project('B'),
      () => null,
      async () => undefined
    );
    expect(pause.reasonFor(b.manager)).toBeNull();
    expect(b.edit('Edited on arrival').name).toBe('Edited on arrival');
  });
});

describe('leaving a project under the pause', () => {
  it('switching A to B saves A’s pending edit and does not keep A’s lock for B’s write', async () => {
    withLockManager();
    const store = deviceStore();
    const pause = new NavigationEditPause();
    const documentA = project('A');
    const claimA = await workspaceStorageClaim(documentA.projectId);
    const tabA = workspace(pause, documentA, claimA.read, store.save);
    // A second tab waiting for A.
    const promoted = vi.fn();
    const other = await claimProjectOwnership(documentA.projectId, promoted);

    // A write in flight and a newer edit queued behind it.
    store.hold();
    tabA.edit('A first');
    void tabA.autosave.flush();
    await Promise.resolve();
    tabA.edit('A second');

    // Opening B: the navigation pauses A, then flushes A's edits.
    const end = pause.begin(tabA.manager);
    const flushed = tabA.autosave.flush();
    expect(() => tabA.edit('During the open')).toThrow(
      NavigationEditPausedError
    );
    await vi.waitFor(() => expect(store.waiting).toBe(true));
    store.land();
    await flushed;
    expect(tabA.autosave.dirty).toBe(false);
    expect(store.stored.get(documentA.projectId)?.name).toBe('A second');

    // B replaces A: A's claim is let go with nothing left to write.
    claimA.giveUp();
    const documentB = project('B');
    const claimB = await workspaceStorageClaim(documentB.projectId);
    const tabB = workspace(pause, documentB, claimB.read, store.save);
    end();
    // B's write parks, and A is handed on regardless: A's hold waits for
    // nothing of B's.
    store.hold();
    tabB.edit('B first');
    const writingB = tabB.autosave.flush();
    await vi.waitFor(() => expect(store.waiting).toBe(true));
    await vi.waitFor(() => expect(promoted).toHaveBeenCalledTimes(1));
    expect(store.stored.get(documentA.projectId)?.name).toBe('A second');
    store.land();
    await writingB;
    expect(store.stored.get(documentB.projectId)?.name).toBe('B first');
    claimB.giveUp();
    other.release();
  });

  it('a failed write before Home leaves the project open; nothing after Home blocks opening one', async () => {
    withLockManager();
    const pause = new NavigationEditPause();
    const documentA = project('A');
    const claimA = await workspaceStorageClaim(documentA.projectId);
    let fail = true;
    const store = deviceStore();
    const tabA = workspace(pause, documentA, claimA.read, async (document) => {
      if (fail) throw new Error('Device unavailable');
      await store.save(document);
    });
    // Home: pause, flush. The write fails, so Home aborts (App keeps the
    // project open with its retry guidance) and the pause ends.
    tabA.edit('A first');
    let end = pause.begin(tabA.manager);
    await expect(tabA.autosave.flush()).rejects.toThrow();
    end();
    expect(pause.reasonFor(tabA.manager)).toBeNull();
    // Still open and editable; the retry succeeds.
    fail = false;
    tabA.edit('A retried');
    await tabA.autosave.flush();
    expect(store.stored.get(documentA.projectId)?.name).toBe('A retried');

    // Home again: an edit while it awaits the account is refused, so the
    // workspace closes with nothing unsaved and nothing refused later.
    end = pause.begin(tabA.manager);
    await tabA.autosave.flush();
    expect(() => tabA.edit('While leaving')).toThrow(NavigationEditPausedError);
    claimA.giveUp();
    end();
    expect(tabA.autosave.dirty).toBe(false);
    // Opening another project: its departure barrier resolves.
    await expect(tabA.autosave.flush()).resolves.toBeUndefined();
    const documentB = project('B');
    const claimB = await workspaceStorageClaim(documentB.projectId);
    const tabB = workspace(pause, documentB, claimB.read, store.save);
    tabB.edit('B first');
    await tabB.autosave.flush();
    expect(store.stored.get(documentB.projectId)?.name).toBe('B first');
    claimB.giveUp();
  });
});
