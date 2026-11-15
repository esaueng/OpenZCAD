import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyOrganizationUpdate,
  projectOrganization,
  type ProjectOrganization,
  type ProjectSummary
} from '@openzcad/shared';
import type {
  LibraryFolderSnapshot,
  SaveLibraryFolderRequest
} from './libraryFolderCloudSync';
import { parseFolderSet, type FolderSet } from './libraryFolderSync';

/**
 * Two accounts signed in one after the other on the same device (ADR-024
 * amendment 2026-11-14). This device's project organization rows are shared
 * by both, so neither account's sealed shelf sync may read them into its
 * record or write its own state over them: B's first round must not seal
 * A's private project ids or A's pins and archive, and A must find its
 * rows and its record as it left them.
 */
const server = vi.hoisted(() => ({
  signedIn: 'A',
  records: new Map<string, LibraryFolderSnapshot>()
}));

function snapshotOf(accountId: string): LibraryFolderSnapshot {
  return (
    server.records.get(accountId) ?? {
      revision: 0,
      format: null,
      record: null,
      updatedAt: null
    }
  );
}

vi.mock('./api', () => ({
  api: {
    getLibraryFolders: vi.fn(async () => snapshotOf(server.signedIn)),
    saveLibraryFolders: vi.fn(async (request: SaveLibraryFolderRequest) => {
      const current = snapshotOf(server.signedIn);
      if (request.expectedRevision !== current.revision)
        throw Object.assign(new Error('conflict'), {
          code: 'LIBRARY_FOLDERS_REVISION_CONFLICT',
          details: { current }
        });
      const saved: LibraryFolderSnapshot = {
        revision: current.revision + 1,
        format: request.format,
        record: request.record,
        updatedAt: null
      };
      server.records.set(server.signedIn, saved);
      return saved;
    }),
    resetProjectShelf: vi.fn()
  },
  // Both accounts' libraries are encrypted.
  encryptsAccountLibrary: vi.fn(async () => true)
}));

vi.mock('./e2ee/unlockedKeys', () => ({
  unlockedAccount: (userId: string) => ({ accountKey: `key-${userId}` })
}));

// The sealed format without the crypto: the set as JSON, tagged format 2.
vi.mock('./e2ee/sealedLibraryFolders', async () => {
  const { canonicalFolderJson, decodePlaintextFolders } =
    await import('./libraryFolderCloudSync');
  return {
    sealedFolderCodec: () => ({
      format: 2,
      decode: (snapshot: LibraryFolderSnapshot) =>
        Promise.resolve(decodePlaintextFolders(snapshot.record)),
      encode: (set: FolderSet) =>
        Promise.resolve({ record: canonicalFolderJson(set), commit: () => {} })
    })
  };
});

const ACTIVE: ProjectOrganization = {
  status: 'active',
  pinned: false,
  sortOrder: 0
};
/** A's private project, and a project both accounts can open. */
const PRIVATE = 'proj_a_private';
const SHARED = 'proj_shared';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const { resetShelfStateMemory } = await import('./sealedShelfState');
  resetShelfStateMemory();
  server.records.clear();
  server.signedIn = 'A';
  localStorage.clear();
});

/**
 * This page's localStorage with `setItem` refused for the keys `refuse`
 * names (a full quota), or every read refused (`blocked`). happy-dom's
 * Storage ignores prototype spies once it holds an item, so the global is
 * replaced instead. Returns the restore.
 */
function stubStorage(options: {
  refuse?: (key: string) => boolean;
  blocked?: boolean;
}): () => void {
  const real = globalThis.localStorage;
  const stub = {
    get length() {
      return real.length;
    },
    key: (index: number) => real.key(index),
    getItem: (key: string) => {
      if (options.blocked) throw new DOMException('blocked', 'SecurityError');
      return real.getItem(key);
    },
    setItem: (key: string, value: string) => {
      if (options.blocked || options.refuse?.(key))
        throw new DOMException('full', 'QuotaExceededError');
      real.setItem(key, value);
    },
    removeItem: (key: string) => real.removeItem(key),
    clear: () => real.clear()
  } as Storage;
  vi.stubGlobal('localStorage', stub);
  return () => vi.unstubAllGlobals();
}

function sealedSet(accountId: string): FolderSet | null {
  const record = server.records.get(accountId)?.record;
  return record ? parseFolderSet(JSON.parse(record)) : null;
}

/** The shared project as the account lists it: its row holds the defaults. */
function sharedRow(): ProjectSummary {
  return {
    projectId: SHARED,
    name: 'Shared bracket',
    updatedAt: '2026-11-14T00:00:00.000Z',
    organization: ACTIVE
  } as ProjectSummary;
}

/**
 * The shelf's listing of a sealed library for `accountId`, composed as
 * `loadProjectSummaries` in App.tsx composes it: the account's rows with
 * its own shelf state laid over them, the reconcile with this device's
 * rows (a pending one is left alone), then this device's rows as a sealed
 * listing may apply them.
 */
async function listSealed(
  accountId: string,
  remote: ProjectSummary[] = [sharedRow()]
): Promise<ProjectSummary[]> {
  const store = await import('./localProjectStore');
  const shelf = await import('./sealedShelfState');
  const { prepareOrganizationMirrors } =
    await import('./projectOrganizationBackground');
  const { applyLocalProjectOrganizations, mergeProjectSummaries } =
    await import('./projectShelf');
  shelf.rememberAccountRows(accountId, remote);
  const overlaid = shelf.overlaySealedShelf(
    remote,
    shelf.agreedShelfState(accountId),
    shelf.readShelfEdits(accountId)
  );
  await prepareOrganizationMirrors(
    await store.listLocalProjectOrganizationSnapshots(),
    overlaid.projects,
    {
      readLocal: store.loadLocalProjectOrganizationSnapshot,
      saveLocal: store.saveLocalProjectOrganizationIfCurrent,
      updateRemote: vi.fn()
    }
  );
  return applyLocalProjectOrganizations(
    mergeProjectSummaries([], overlaid.projects),
    shelf.sealedListingOrganizations(
      await store.listLocalProjectOrganizations(),
      overlaid.projects
    )
  );
}

/**
 * The shelf's listing for `accountId` when the account could not be
 * reached, composed as `loadProjectSummaries` composes it for a library
 * that is (or may be) encrypted: the projects this device holds, with this
 * device's rows as `accountListingOrganizations` lets them apply.
 */
async function listUnreached(accountId: string): Promise<ProjectSummary[]> {
  const store = await import('./localProjectStore');
  const shelf = await import('./sealedShelfState');
  const { applyLocalProjectOrganizations, mergeProjectSummaries } =
    await import('./projectShelf');
  return applyLocalProjectOrganizations(
    mergeProjectSummaries([sharedRow()], []),
    shelf.accountListingOrganizations(
      accountId,
      await store.listLocalProjectOrganizations(),
      null
    )
  );
}

/** A shelf edit as `saveShelfRows` makes it: the device row, then the journal. */
async function editShelf(
  accountId: string,
  listed: ProjectSummary,
  update: Parameters<typeof applyOrganizationUpdate>[1]
) {
  const { saveLocalProjectOrganization } = await import('./localProjectStore');
  const { journalShelfEdit } = await import('./sealedShelfState');
  const before = projectOrganization(listed);
  const after = applyOrganizationUpdate(before, update);
  await saveLocalProjectOrganization(listed.projectId, after, {
    mirrorPending: true
  });
  journalShelfEdit(accountId, listed.projectId, before, after);
}

async function deviceRow(projectId: string) {
  const { loadLocalProjectOrganizationSnapshot } =
    await import('./localProjectStore');
  return (await loadLocalProjectOrganizationSnapshot(projectId))?.organization;
}

describe('sealed shelf state of accounts sharing a device', () => {
  it('never seals one account’s device rows under another account, nor writes over them', async () => {
    const { saveLocalProjectOrganization } =
      await import('./localProjectStore');
    const { journalShelfEdit } = await import('./sealedShelfState');
    const { syncAccountLibraryFolders } =
      await import('./libraryFolderCloudSync');

    // A pins its private project and archives the shared one, as the
    // shelf does it: the device rows and A's journal.
    const pinned = { ...ACTIVE, pinned: true, sortOrder: 2 };
    const archived: ProjectOrganization = {
      status: 'archived',
      pinned: false,
      sortOrder: 0,
      archivedAt: '2026-11-14T00:00:00.000Z'
    };
    await saveLocalProjectOrganization(PRIVATE, pinned);
    await saveLocalProjectOrganization(SHARED, archived);
    journalShelfEdit('A', PRIVATE, ACTIVE, pinned);
    journalShelfEdit('A', SHARED, ACTIVE, archived);
    expect(await syncAccountLibraryFolders('A', () => false)).toBe(false);
    expect(sealedSet('A')?.projects).toMatchObject({
      [PRIVATE]: { pinned: true, sortOrder: 2 },
      [SHARED]: { archived: true }
    });

    // A signs out; B signs in on the same device and pins the shared
    // project on its own shelf.
    server.signedIn = 'B';
    journalShelfEdit('B', SHARED, ACTIVE, { ...ACTIVE, pinned: true });
    expect(await syncAccountLibraryFolders('B', () => false)).toBe(false);
    const b = sealedSet('B');
    // B's record holds B's choice only: neither A's private project id nor
    // A's archive of the shared project.
    expect(Object.keys(b?.projects ?? {})).toEqual([SHARED]);
    expect(b?.projects?.[SHARED]).toMatchObject({
      pinned: true,
      archived: false
    });
    // And B's sync left the device rows as A left them.
    expect(await deviceRow(PRIVATE)).toEqual(pinned);
    expect(await deviceRow(SHARED)).toEqual(archived);

    // A signs back in: its record and rows are as it left them, without
    // B's pin.
    server.signedIn = 'A';
    expect(await syncAccountLibraryFolders('A', () => false)).toBe(false);
    expect(sealedSet('A')?.projects).toMatchObject({
      [PRIVATE]: { pinned: true, sortOrder: 2, archived: false },
      [SHARED]: { pinned: false, archived: true }
    });
    expect(await deviceRow(SHARED)).toEqual(archived);
  });

  it('does not seal device rows the account never edited on its first round', async () => {
    const { saveLocalProjectOrganization } =
      await import('./localProjectStore');
    const { syncAccountLibraryFolders } =
      await import('./libraryFolderCloudSync');
    // Rows another account left on this device.
    await saveLocalProjectOrganization(PRIVATE, { ...ACTIVE, pinned: true });
    await saveLocalProjectOrganization(SHARED, {
      status: 'archived',
      pinned: false,
      sortOrder: 0
    });
    server.signedIn = 'B';
    expect(await syncAccountLibraryFolders('B', () => false)).toBe(false);
    expect(sealedSet('B')?.projects ?? {}).toEqual({});
  });

  it('keeps another account’s pending row out of the listing and out of the next edit', async () => {
    const { syncAccountLibraryFolders } =
      await import('./libraryFolderCloudSync');

    // A archives the shared project and moves it to place 7, then signs out
    // before either reaches the account: the device row stays pending.
    const [aListed] = await listSealed('A');
    await editShelf('A', aListed!, { status: 'archived' });
    const [aArchived] = await listSealed('A');
    await editShelf('A', aArchived!, { sortOrder: 7 });
    expect((await deviceRow(SHARED))?.status).toBe('archived');

    // B signs in on the same device. Its listing shows B's own shelf, not
    // A's pending archive and order.
    server.signedIn = 'B';
    const [bListed] = await listSealed('B');
    expect(projectOrganization(bListed!)).toEqual(ACTIVE);

    // B pins the project from that listing. B's sealed record holds B's pin
    // and nothing of A's.
    await editShelf('B', bListed!, { pinned: true });
    expect(await syncAccountLibraryFolders('B', () => false)).toBe(false);
    expect(sealedSet('B')?.projects?.[SHARED]).toMatchObject({
      pinned: true,
      sortOrder: 0,
      archived: false
    });
    expect(sealedSet('B')?.projects?.[SHARED]?.archivedAt).toBeUndefined();
    const [bPinned] = await listSealed('B');
    expect(projectOrganization(bPinned!)).toEqual({ ...ACTIVE, pinned: true });

    // A signs back in: its pending archive and order are still its own,
    // without B's pin, and its first sync seals them.
    server.signedIn = 'A';
    const [aBack] = await listSealed('A');
    expect(projectOrganization(aBack!)).toMatchObject({
      status: 'archived',
      pinned: false,
      sortOrder: 7
    });
    expect(await syncAccountLibraryFolders('A', () => false)).toBe(false);
    expect(sealedSet('A')?.projects?.[SHARED]).toMatchObject({
      pinned: false,
      sortOrder: 7,
      archived: true
    });
  });

  it('keeps another account’s pending row out of a listing that could not reach the account', async () => {
    const { resetShelfStateMemory } = await import('./sealedShelfState');
    const { syncAccountLibraryFolders } =
      await import('./libraryFolderCloudSync');

    // B listed its library on this device in an earlier visit.
    server.signedIn = 'B';
    await listSealed('B');
    resetShelfStateMemory();

    // A archives the shared project at place 7 and signs out before either
    // reaches the account: the device row stays pending.
    server.signedIn = 'A';
    const [aListed] = await listSealed('A');
    await editShelf('A', aListed!, { status: 'archived' });
    const [aArchived] = await listSealed('A');
    await editShelf('A', aArchived!, { sortOrder: 7 });
    resetShelfStateMemory();

    // B signs in, but its listing fails. The project is still B's, so B
    // sees its own shelf for it, not A's archive and order.
    server.signedIn = 'B';
    const [bListed] = await listUnreached('B');
    expect(projectOrganization(bListed!)).toEqual(ACTIVE);

    // B pins it there; B's record holds B's pin and nothing of A's.
    await editShelf('B', bListed!, { pinned: true });
    const [bPinned] = await listUnreached('B');
    expect(projectOrganization(bPinned!)).toEqual({ ...ACTIVE, pinned: true });
    expect(await syncAccountLibraryFolders('B', () => false)).toBe(false);
    expect(sealedSet('B')?.projects?.[SHARED]).toMatchObject({
      pinned: true,
      sortOrder: 0,
      archived: false
    });

    // A finds its archive and order as it left them.
    server.signedIn = 'A';
    const [aBack] = await listSealed('A');
    expect(projectOrganization(aBack!)).toMatchObject({
      status: 'archived',
      pinned: false,
      sortOrder: 7
    });
  });

  it('seals only its own edit when an account that knows nothing of a project edits it from a failed listing', async () => {
    const { syncAccountLibraryFolders } =
      await import('./libraryFolderCloudSync');
    const { readShelfEdits } = await import('./sealedShelfState');

    // A leaves the shared project archived at place 7, unsent.
    const [aListed] = await listSealed('A');
    await editShelf('A', aListed!, { status: 'archived' });
    const [aArchived] = await listSealed('A');
    await editShelf('A', aArchived!, { sortOrder: 7 });

    // B has no record, no edit and no listed rows here, and cannot reach
    // its account: the project looks like this device's own, so the shelf
    // shows the device row. Pinning it still journals only B's pin.
    server.signedIn = 'B';
    const [bListed] = await listUnreached('B');
    expect(projectOrganization(bListed!)).toMatchObject({
      status: 'archived',
      sortOrder: 7
    });
    await editShelf('B', bListed!, { pinned: true });
    expect(readShelfEdits('B').get(SHARED)).toEqual({
      before: { pinned: false, sortOrder: 0, archived: false },
      after: { pinned: true, sortOrder: 0, archived: false }
    });
    expect(await syncAccountLibraryFolders('B', () => false)).toBe(false);
    const sealed = sealedSet('B')?.projects?.[SHARED];
    expect(sealed).toMatchObject({
      pinned: true,
      sortOrder: 0,
      archived: false
    });
    expect(sealed?.archivedAt).toBeUndefined();
  });

  it('journals an edit under the account that made it when the session ends mid-write', async () => {
    const { beginShelfEdit, readShelfEdits } =
      await import('./sealedShelfState');
    let session: string | null = 'A';
    const edit = beginShelfEdit(() => session);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persisted = edit.persist(
      new Map([[SHARED, ACTIVE]]),
      new Map([[SHARED, { ...ACTIVE, pinned: true }]]),
      () => held
    );
    // Cloud is turned off while this device's write is still in flight.
    session = null;
    release();
    await persisted;
    expect(readShelfEdits('A').get(SHARED)?.after).toEqual({
      pinned: true,
      sortOrder: 0,
      archived: false
    });
  });

  it('journals an edit under the account that made it when another account signs in mid-write', async () => {
    const { beginShelfEdit, readShelfEdits } =
      await import('./sealedShelfState');
    let session: string | null = 'A';
    const edit = beginShelfEdit(() => session);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persisted = edit.persist(
      new Map([[SHARED, ACTIVE]]),
      new Map([[SHARED, { ...ACTIVE, status: 'archived' }]]),
      () => held
    );
    session = 'B';
    release();
    await persisted;
    expect(readShelfEdits('A').get(SHARED)?.after).toMatchObject({
      archived: true
    });
    expect(readShelfEdits('B').size).toBe(0);
  });

  it('journals nothing when this device’s write fails', async () => {
    const { beginShelfEdit, readShelfEdits } =
      await import('./sealedShelfState');
    const edit = beginShelfEdit(() => 'A');
    await expect(
      edit.persist(
        new Map([[SHARED, ACTIVE]]),
        new Map([[SHARED, { ...ACTIVE, pinned: true }]]),
        () => Promise.reject(new Error('quota'))
      )
    ).rejects.toThrow('quota');
    expect(readShelfEdits('A').size).toBe(0);
  });

  it('journals only the fields an edit changed over the account’s own state', async () => {
    const { journalShelfEdit, readShelfEdits, rememberAccountRows } =
      await import('./sealedShelfState');
    // The shelf showed the project archived at place 7 (another account's
    // pending row); B's own row holds the defaults.
    rememberAccountRows('B', [sharedRow()]);
    const shown: ProjectOrganization = {
      status: 'archived',
      pinned: false,
      sortOrder: 7,
      archivedAt: '2026-11-14T00:00:00.000Z'
    };
    journalShelfEdit('B', SHARED, shown, { ...shown, pinned: true });
    expect(readShelfEdits('B').get(SHARED)).toEqual({
      before: { pinned: false, sortOrder: 0, archived: false },
      after: { pinned: true, sortOrder: 0, archived: false }
    });
  });

  it('starts an edit after a reload from the row an earlier listing showed', async () => {
    const { resetShelfStateMemory } = await import('./sealedShelfState');
    const { syncAccountLibraryFolders } =
      await import('./libraryFolderCloudSync');
    // A's row still holds readable shelf state from before its library was
    // encrypted: archived at place 7. A lists it, and the page reloads
    // before a sync migrates it.
    const legacy = {
      ...sharedRow(),
      organization: {
        status: 'archived',
        pinned: false,
        sortOrder: 7,
        archivedAt: '2026-11-01T00:00:00.000Z'
      }
    } as ProjectSummary;
    await listSealed('A', [legacy]);
    resetShelfStateMemory();

    // The next listing fails; the row kept from the last one still shows
    // the archive and the order.
    const [shown] = await listUnreached('A');
    expect(projectOrganization(shown!)).toMatchObject({
      status: 'archived',
      sortOrder: 7
    });

    // A pins it there. The sealed record keeps the archive and the order
    // with the pin, not the defaults, which no later migration could
    // replace.
    await editShelf('A', shown!, { pinned: true });
    expect(await syncAccountLibraryFolders('A', () => false)).toBe(false);
    expect(sealedSet('A')?.projects?.[SHARED]).toMatchObject({
      pinned: true,
      sortOrder: 7,
      archived: true,
      archivedAt: '2026-11-01T00:00:00.000Z'
    });
  });

  it('seals an edit this visit when storage refuses the journal, and says so', async () => {
    const { beginShelfEdit, shelfEditsKey } =
      await import('./sealedShelfState');
    const { syncAccountLibraryFolders } =
      await import('./libraryFolderCloudSync');
    const [listed] = await listSealed('A');
    // localStorage is full for the journal; IndexedDB still takes the row.
    const restore = stubStorage({
      refuse: (key) => key === shelfEditsKey('A')
    });
    const { saveLocalProjectOrganization } =
      await import('./localProjectStore');
    const before = projectOrganization(listed!);
    const after = { ...before, pinned: true };
    const stored = await beginShelfEdit(() => 'A').persist(
      new Map([[SHARED, before]]),
      new Map([[SHARED, after]]),
      () => saveLocalProjectOrganization(SHARED, after, { mirrorPending: true })
    );
    // The shelf is told the edit lasts for this visit only…
    expect(stored).toBe(false);
    expect(localStorage.getItem(shelfEditsKey('A'))).toBeNull();
    // …but the listing keeps it, and the next sealed sync takes it.
    const [pinned] = await listSealed('A');
    expect(projectOrganization(pinned!)).toEqual({ ...ACTIVE, pinned: true });
    expect(await syncAccountLibraryFolders('A', () => false)).toBe(false);
    expect(sealedSet('A')?.projects?.[SHARED]).toMatchObject({
      pinned: true
    });
    restore();
  });
});
