import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandFactories, CommandManager } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  DepartureRecoveryCopies,
  DepartureRecoveryCopyError,
  departureBarrier,
  departureRecoveryHost,
  type DepartureRecoveryHost
} from './departureRecoveryCopy';
import {
  LocalProjectAutosave,
  LocalProjectSaveRefusedError,
  sameLocalProjectContent
} from './localProjectAutosave';
import { loadLocalProject, saveLocalProject } from './localProjectStore';
import { NavigationEditPause } from './navigationEditPause';
import { mergeProjectSummaries, summarizeLocalDocument } from './projectShelf';
import {
  trackProjectStorage,
  writeLocalProjectUnderClaim,
  type ProjectStorageOwnership
} from './projectTabOwnership';
import { withLockManager } from '../test/fakeLockManager';
import { workspaceStorageClaim } from '../test/workspaceStorageClaim';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const USER = toUserId('user_departure_recovery');

/** The modeling content an edit adds: its features, in order. */
const featuresOf = (document: ProjectDocument | null | undefined) =>
  document?.featureOrder.map((id) => document.nodes[id]);

/**
 * A tab's workspace as App wires it: the manager under the navigation
 * pause, autosave writing under the storage claim, and the departure
 * barrier keeping a refused edit to the departing project as a copy.
 */
function workspace(
  document: ProjectDocument,
  read: () => ProjectStorageOwnership | null,
  options: {
    pause?: NavigationEditPause;
    copies?: DepartureRecoveryCopies;
    host?: DepartureRecoveryHost;
    shelf?: () => string[];
  } = {}
) {
  const pause = options.pause ?? new NavigationEditPause();
  const copies = options.copies ?? new DepartureRecoveryCopies();
  const manager = new CommandManager(document, USER);
  pause.guard(manager);
  const opened = manager.document;
  const write = vi.fn((pending: ProjectDocument) =>
    writeLocalProjectUnderClaim(
      read,
      pending.projectId,
      () => saveLocalProject(pending),
      sameLocalProjectContent(opened, pending)
    )
  );
  const autosave = new LocalProjectAutosave({
    write,
    onSaved: () => undefined,
    onError: () => undefined,
    onDirtyChange: () => undefined
  });
  const host =
    options.host ??
    departureRecoveryHost({
      existingNames: options.shelf ?? (() => [document.name]),
      ownerUserId: () => USER,
      carryEncryption: () => undefined,
      save: saveLocalProject
    });
  const kept =
    vi.fn<(copy: ProjectDocument, source: ProjectDocument) => void>();
  const reported = vi.fn();
  const copyFailed = vi.fn();
  return {
    pause,
    manager,
    autosave,
    write,
    kept,
    reported,
    copyFailed,
    /** A modeling edit, committed and handed to autosave as App does. */
    edit(name: string) {
      const next = manager.execute(
        commandFactories.addPrimitive({
          name,
          primitiveKind: 'box',
          dimensions: { width: 10, height: 20, depth: 30 }
        })
      );
      autosave.enqueue(next);
      return next;
    },
    /** App's `flushPendingLocalSave`, as every departure awaits it. */
    depart() {
      return departureBarrier(autosave, {
        departing: () => pause.departing()?.document.projectId ?? null,
        copies,
        host,
        onRefused: reported,
        onKept: kept,
        onCopyFailed: copyFailed
      });
    }
  };
}

/** A project another tab holds, with its own copy on this device. */
async function heldElsewhere(name: string) {
  const document = createProjectDocument(name, USER);
  await saveLocalProject(document);
  const owner = await workspaceStorageClaim(document.projectId);
  expect(owner.ownership.owned).toBe(true);
  return { document, owner };
}

/** This tab opens `document`; the claim's answer has not arrived yet. */
function openBeforeTheAnswer(document: ProjectDocument) {
  return trackProjectStorage(document.projectId, {
    onAnswered: () => undefined,
    onPromoted: () => undefined
  });
}

describe('a departure that cannot write its project keeps a recovery copy', () => {
  it('keeps the newer edit queued behind a refused write before leaving', async () => {
    withLockManager();
    const { document, owner } = await heldElsewhere('Bracket');
    const tracker = openBeforeTheAnswer(document);
    const tab = workspace(document, () => tracker.ownership);
    let refuse: (result: 'refused') => void = () => undefined;
    tab.write.mockImplementationOnce(
      () => new Promise((resolve) => (refuse = resolve))
    );

    tab.edit('First edit');
    const firstFlush = tab.autosave.flush().catch(() => undefined);
    await vi.waitFor(() => expect(tab.write).toHaveBeenCalledOnce());
    const latest = tab.edit('Second edit');
    const end = tab.pause.begin(tab.manager);
    const departure = tab.depart();
    refuse('refused');
    await Promise.all([firstFlush, departure]);
    end();

    expect(tab.kept).toHaveBeenCalledTimes(1);
    const [copy, source] = tab.kept.mock.calls[0]!;
    expect(source).toBe(latest);
    expect(featuresOf(await loadLocalProject(copy.projectId))).toEqual(
      featuresOf(latest)
    );
    expect(copy.featureOrder).toHaveLength(2);
    expect(tab.autosave.dirty).toBe(false);
    tracker.giveUp();
    owner.giveUp();
  });

  it('keeps an edit refused by a delayed ownership denial as a separate project before opening B', async () => {
    withLockManager();
    const { document: a, owner } = await heldElsewhere('Bracket');
    const b = createProjectDocument('Housing', USER);
    await saveLocalProject(b);
    const tracker = openBeforeTheAnswer(a);
    const tab = workspace(a, () => tracker.ownership, {
      shelf: () => ['Bracket', 'Housing']
    });

    // Still editable while the answer is pending: the user edits, and the
    // answer then says another tab holds the project.
    const edited = tab.edit('Edited before the answer');
    await expect(tab.autosave.flush()).rejects.toBeInstanceOf(
      LocalProjectSaveRefusedError
    );
    expect(tracker.ownership.owned).toBe(false);
    expect(tab.autosave.dirty).toBe(true);

    // Navigate to B: the departure barrier is the last word on A's edit.
    const end = tab.pause.begin(tab.manager);
    await tab.depart();
    expect(tab.kept).toHaveBeenCalledTimes(1);
    const [copy, source] = tab.kept.mock.calls[0]!;
    // The exact refused snapshot, under a fresh project identity.
    expect(source).toBe(edited);
    expect(copy.projectId).not.toBe(a.projectId);
    expect(copy.projectId).not.toBe(b.projectId);
    expect(copy.ownerUserId).toBe(USER);
    expect(copy.name).toBe('Bracket (copy)');
    expect(copy.featureOrder).toEqual(edited.featureOrder);
    expect(edited.featureOrder).toHaveLength(1);
    expect(featuresOf(copy)).toEqual(featuresOf(edited));
    // Durable before the navigation goes on, and the edit is no longer
    // only in this tab's queue.
    const stored = await loadLocalProject(copy.projectId);
    expect(featuresOf(stored)).toEqual(featuresOf(edited));
    expect(tab.autosave.dirty).toBe(false);
    expect(tab.reported).not.toHaveBeenCalled();
    // The owning tab's copy of A was never written over.
    expect((await loadLocalProject(a.projectId))?.featureOrder).toEqual([]);

    // B opens and saves as usual; A's refused edit does not follow it.
    const bClaim = await workspaceStorageClaim(b.projectId);
    tracker.giveUp();
    const bTab = workspace(b, bClaim.read);
    end();
    bTab.edit('B edit');
    await bTab.depart();
    expect(bTab.kept).not.toHaveBeenCalled();
    expect((await loadLocalProject(b.projectId))?.featureOrder).toHaveLength(1);
    bClaim.giveUp();
    owner.giveUp();
  });

  it('lists the copy on the shelf under its own id beside the departing project', async () => {
    withLockManager();
    const { document: a, owner } = await heldElsewhere('Bracket');
    const tracker = openBeforeTheAnswer(a);
    const tab = workspace(a, () => tracker.ownership);
    tab.edit('Kept edit');
    await tab.autosave.flush().catch(() => undefined);
    const end = tab.pause.begin(tab.manager);
    await tab.depart();
    end();
    const [copy] = tab.kept.mock.calls[0]!;
    const shelf = mergeProjectSummaries(
      [summarizeLocalDocument(copy)],
      [summarizeLocalDocument(a)]
    );
    expect(shelf.map((summary) => summary.projectId).sort()).toEqual(
      [a.projectId, copy.projectId].sort()
    );
    expect(shelf.find((s) => s.projectId === copy.projectId)?.name).toBe(
      'Bracket (copy)'
    );
    // Born savable: its own save point, as Keep both's copy is.
    expect(copy.revisions).toHaveLength(1);
    tracker.giveUp();
    owner.giveUp();
  });

  it('records the encryption requirement before the copy is written', async () => {
    withLockManager();
    const { document: a, owner } = await heldElsewhere('Secret');
    const tracker = openBeforeTheAnswer(a);
    const order: string[] = [];
    const carry = vi.fn((from: string, to: string) => {
      order.push(`carry ${from}->${to}`);
    });
    const tab = workspace(a, () => tracker.ownership, {
      host: departureRecoveryHost({
        existingNames: () => [],
        ownerUserId: () => USER,
        carryEncryption: carry,
        save: async (copy) => {
          order.push(`save ${copy.projectId}`);
          await saveLocalProject(copy);
        }
      })
    });
    tab.edit('Confidential edit');
    await tab.autosave.flush().catch(() => undefined);
    const end = tab.pause.begin(tab.manager);
    await tab.depart();
    end();
    const [copy] = tab.kept.mock.calls[0]!;
    expect(order).toEqual([
      `carry ${a.projectId}->${copy.projectId}`,
      `save ${copy.projectId}`
    ]);
    tracker.giveUp();
    owner.giveUp();
  });

  it('makes one copy when a second navigation (a share link) starts while the first is writing it', async () => {
    withLockManager();
    const { document: a, owner } = await heldElsewhere('Bracket');
    const tracker = openBeforeTheAnswer(a);
    let release: () => void = () => undefined;
    const parked = new Promise<void>((resolve) => (release = resolve));
    const saves: string[] = [];
    const copies = new DepartureRecoveryCopies();
    const tab = workspace(a, () => tracker.ownership, {
      copies,
      host: departureRecoveryHost({
        existingNames: () => [],
        ownerUserId: () => USER,
        carryEncryption: () => undefined,
        save: async (copy) => {
          saves.push(copy.projectId);
          await parked;
          await saveLocalProject(copy);
        }
      })
    });
    const edited = tab.edit('Kept once');
    await tab.autosave.flush().catch(() => undefined);

    // Navigate to B; while its copy is being written, a share link opens.
    const endB = tab.pause.begin(tab.manager);
    const toB = tab.depart();
    await vi.waitFor(() => expect(saves).toHaveLength(1));
    // A derived cache rebuild is another object for the same edit.
    tab.autosave.enqueue({ ...edited, derived: { ...edited.derived } });
    const endShare = tab.pause.begin(tab.manager);
    endB(); // superseded: a no-op for the share link's pause
    expect(tab.pause.departing()).toBe(tab.manager);
    const toShare = tab.depart();
    release();
    await Promise.all([toB, toShare]);
    endShare();

    expect(saves).toHaveLength(1);
    // Listed and announced once, though both departures waited on it.
    expect(tab.kept).toHaveBeenCalledTimes(1);
    expect(tab.autosave.dirty).toBe(false);
    // Nothing is left to recover: a later departure writes no other copy.
    const later = tab.pause.begin(tab.manager);
    await tab.depart();
    later();
    expect(saves).toHaveLength(1);
    tracker.giveUp();
    owner.giveUp();
  });

  it('settles a refusal still in flight when the other departure has kept the copy', async () => {
    const document = createProjectDocument('In flight', USER);
    let refuse: (result: 'refused') => void = () => undefined;
    const autosave = new LocalProjectAutosave({
      write: vi
        .fn(
          () =>
            new Promise<'refused'>((resolve) => {
              refuse = resolve;
            })
        )
        .mockResolvedValueOnce('refused'),
      onSaved: () => undefined,
      onError: () => undefined,
      onDirtyChange: () => undefined
    });
    autosave.enqueue(document);
    const pending = await autosave.flush().catch((error: unknown) => error);
    if (!(pending instanceof LocalProjectSaveRefusedError)) throw pending;
    const flushing = autosave.flush();
    await Promise.resolve();
    // Kept as a copy by another departure while this write is in flight.
    autosave.keptElsewhere(pending);
    refuse('refused');
    await expect(flushing).resolves.toBeUndefined();
    expect(autosave.dirty).toBe(false);
  });

  it('stays on the project, edit kept, when the copy cannot be written, and retries the same copy', async () => {
    withLockManager();
    const { document: a, owner } = await heldElsewhere('Bracket');
    const tracker = openBeforeTheAnswer(a);
    let failNext = true;
    const saves: string[] = [];
    const encryptedCopies = new Set<string>();
    let encryptionRequired = false;
    const tab = workspace(a, () => tracker.ownership, {
      host: departureRecoveryHost({
        existingNames: () => [],
        ownerUserId: () => USER,
        carryEncryption: (sourceId, copyId) => {
          expect(sourceId).toBe(a.projectId);
          if (encryptionRequired) encryptedCopies.add(copyId);
        },
        save: async (copy) => {
          expect(encryptedCopies.has(copy.projectId)).toBe(encryptionRequired);
          saves.push(copy.projectId);
          if (failNext) {
            failNext = false;
            throw new Error('QuotaExceededError');
          }
          await saveLocalProject(copy);
        }
      })
    });
    const edited = tab.edit('Not lost');
    await tab.autosave.flush().catch(() => undefined);

    const end = tab.pause.begin(tab.manager);
    const failure = await tab.depart().then(
      () => null,
      (error: unknown) => error
    );
    end();
    // The navigation stops: the workspace keeps A and its edit.
    expect(failure).toBeInstanceOf(DepartureRecoveryCopyError);
    expect((failure as Error).message).toContain('Bracket');
    expect(tab.copyFailed).toHaveBeenCalledTimes(1);
    expect(tab.kept).not.toHaveBeenCalled();
    expect(tab.autosave.dirty).toBe(true);
    expect(tab.manager.document).toBe(edited);
    expect(await loadLocalProject(saves[0]!)).toBeNull();
    expect(encryptedCopies.size).toBe(0);
    // Editing resumes once the navigation has ended.
    expect(tab.pause.reasonFor(tab.manager)).toBeNull();

    // The owner enables encryption before the second attempt. Keep the same
    // copy ID and record the new policy before retrying the device write.
    encryptionRequired = true;
    const again = tab.pause.begin(tab.manager);
    await tab.depart();
    again();
    expect(saves).toEqual([saves[0], saves[0]]);
    const [copy, source] = tab.kept.mock.calls[0]!;
    expect(source).toBe(edited);
    expect(copy.projectId).toBe(saves[0]);
    expect(encryptedCopies).toEqual(new Set([copy.projectId]));
    expect(featuresOf(await loadLocalProject(copy.projectId))).toEqual(
      featuresOf(edited)
    );
    expect(tab.autosave.dirty).toBe(false);
    tracker.giveUp();
    owner.giveUp();
  });

  it('makes no copy outside a departure, or for a project other than the departing one', async () => {
    withLockManager();
    const { document: a, owner } = await heldElsewhere('Bracket');
    const tracker = openBeforeTheAnswer(a);
    const tab = workspace(a, () => tracker.ownership);
    tab.edit('Pending');
    // An autosave (or a same-project flush) with no navigation: reported.
    await tab.depart();
    expect(tab.reported).toHaveBeenCalledTimes(1);
    expect(tab.kept).not.toHaveBeenCalled();
    expect(tab.autosave.dirty).toBe(true);

    // A navigation leaving another project does not copy this one's edit.
    const other = new CommandManager(
      createProjectDocument('Other', USER),
      USER
    );
    const end = tab.pause.begin(other);
    await tab.depart();
    end();
    expect(tab.reported).toHaveBeenCalledTimes(2);
    expect(tab.kept).not.toHaveBeenCalled();
    expect(tab.autosave.dirty).toBe(true);
    tracker.giveUp();
    owner.giveUp();
  });

  it('still writes an owned project, and drops an untouched read-only open, without a copy', async () => {
    withLockManager();
    const owned = createProjectDocument('Owned', USER);
    const claim = await workspaceStorageClaim(owned.projectId);
    const tab = workspace(owned, claim.read);
    tab.edit('Owned edit');
    const end = tab.pause.begin(tab.manager);
    await tab.depart();
    end();
    expect(tab.kept).not.toHaveBeenCalled();
    expect(
      (await loadLocalProject(owned.projectId))?.featureOrder
    ).toHaveLength(1);

    const { document: held, owner } = await heldElsewhere('Held');
    const reader = await workspaceStorageClaim(held.projectId);
    expect(reader.ownership.owned).toBe(false);
    const readOnly = workspace(held, reader.read);
    readOnly.autosave.enqueue(held);
    const leaving = readOnly.pause.begin(readOnly.manager);
    await readOnly.depart();
    leaving();
    expect(readOnly.kept).not.toHaveBeenCalled();
    expect(readOnly.reported).not.toHaveBeenCalled();
    expect(readOnly.autosave.dirty).toBe(false);
    reader.giveUp();
    owner.giveUp();
    claim.giveUp();
  });
});
