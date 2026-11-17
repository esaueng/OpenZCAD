import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROJECT_SHELF_STATE_SEALED_CODE,
  toProjectId,
  type ProjectOrganization,
  type ProjectSummary,
  type ReorderProjectsRequest,
  type UpdateProjectRequest,
  type UpdateProjectResponse
} from '@openzcad/shared';
import {
  canonicalFolderJson,
  decodePlaintextFolders,
  plaintextFolderCodec,
  syncLibraryFolders,
  type FolderRecordCodec,
  type FolderSyncHost,
  type LibraryFolderSnapshot,
  type SaveLibraryFolderRequest
} from './libraryFolderCloudSync';
import {
  mergeFolderSets,
  parseFolderSet,
  pruneFolderSet,
  recordShelfEdits,
  type FolderSet,
  type ShelfEdit
} from './libraryFolderSync';
import {
  accountRowsKey,
  askShelfSealed,
  beginShelfEdit,
  confirmShelfSealed,
  consumeShelfEdits,
  journalShelfEdit,
  MAX_REMEMBERED_ACCOUNT_ROWS,
  mirrorShelfToAccount,
  noteLegacyShelfRows,
  legacyShelfRows,
  overlaySealedShelf,
  readShelfEdits,
  rememberAccountRows,
  reorderShelfOnAccount,
  resetLegacyShelfRows,
  resetShelfStateMemory,
  sealedListingOrganizations,
  ShelfStateUnverifiedError,
  shelfEditsKey,
  shelfSealedOrSafe,
  type ShelfApi
} from './sealedShelfState';

/**
 * Pins, manual order and archive of an account whose library is encrypted
 * (ADR-024 amendment 2026-11-14) travel in the sealed library record, never
 * on the account's project rows; the rows keep only the trash.
 */

const T0 = Date.parse('2026-11-14T12:00:00.000Z');
const ACTIVE: ProjectOrganization = {
  status: 'active',
  pinned: false,
  sortOrder: 0
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetShelfStateMemory();
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

/** Format 2 without the crypto: the folder set as JSON, tagged sealed. */
const sealedCodec: FolderRecordCodec = {
  format: 2,
  decode: (snapshot) =>
    Promise.resolve(
      snapshot.format === 2 || snapshot.format === 1
        ? decodePlaintextFolders(snapshot.record)
        : { kind: 'unsupported' }
    ),
  encode: (set) =>
    Promise.resolve({ record: canonicalFolderJson(set), commit: () => {} })
};

function server() {
  let snapshot: LibraryFolderSnapshot = {
    revision: 0,
    format: null,
    record: null,
    updatedAt: null
  };
  return {
    get snapshot() {
      return snapshot;
    },
    get set(): FolderSet | null {
      return snapshot.record
        ? parseFolderSet(JSON.parse(snapshot.record))
        : null;
    },
    load: () => Promise.resolve(snapshot),
    save(request: SaveLibraryFolderRequest) {
      if (request.expectedRevision !== snapshot.revision)
        return Promise.resolve({ conflict: snapshot });
      snapshot = {
        revision: snapshot.revision + 1,
        format: request.format,
        record: request.record,
        updatedAt: null
      };
      return Promise.resolve({ saved: snapshot });
    }
  };
}

/**
 * One browser signed in to the account: its edit journal and the record it
 * agreed with the account. Its project organization rows are not part of
 * the sync (every account signed in on the device shares them); the
 * listing lays the agreed record over the account's rows instead.
 */
function device(
  remote: ReturnType<typeof server>,
  options: {
    codec?: FolderRecordCodec | null;
    seeds?: Map<string, ProjectOrganization>;
  } = {}
) {
  const shelves = new Map<string, ProjectOrganization>();
  const edits = new Map<string, ShelfEdit>();
  let record: ReturnType<FolderSyncHost['readRecord']> = null;
  let clock = T0;
  const codec = options.codec === undefined ? sealedCodec : options.codec;
  const host: FolderSyncHost = {
    readDevice: () => ({ folders: [] }),
    writeDevice: () => {},
    readRecord: () => record,
    writeRecord: (next) => {
      record = next;
    },
    load: () => remote.load(),
    save: (request) => remote.save(request),
    codec: () => Promise.resolve(codec),
    now: () => clock,
    readShelfEdits: () => new Map(edits),
    consumeShelfEdits: (recorded) => {
      for (const [id, edit] of recorded)
        if (JSON.stringify(edits.get(id)) === JSON.stringify(edit))
          edits.delete(id);
    },
    readShelfSeeds: () =>
      new Map(
        [...(options.seeds ?? [])].map(([id, organization]) => [
          id,
          {
            pinned: organization.pinned,
            sortOrder: organization.sortOrder,
            archived: organization.status === 'archived'
          }
        ])
      )
  };
  return {
    /** A shelf edit, as `saveShelfRows` journals it. */
    edit(projectId: string, change: Partial<ProjectOrganization>) {
      clock += 1000;
      const before = shelves.get(projectId) ?? ACTIVE;
      const after = { ...before, ...change };
      shelves.set(projectId, after);
      const shelfOf = (organization: ProjectOrganization) => ({
        pinned: organization.pinned,
        sortOrder: organization.sortOrder,
        archived: organization.status === 'archived',
        ...(organization.archivedAt
          ? { archivedAt: organization.archivedAt }
          : {})
      });
      edits.set(projectId, {
        before: edits.get(projectId)?.before ?? shelfOf(before),
        after: shelfOf(after)
      });
    },
    sync: () => syncLibraryFolders(host),
    /** What the listing lays over the account's row for the project. */
    agreed: (projectId: string) => record?.set.projects?.[projectId],
    get edits() {
      return edits;
    },
    get record() {
      return record;
    }
  };
}

describe('the sealed shelf record', () => {
  it('carries pins, order and archive from one device to another', async () => {
    const remote = server();
    const laptop = device(remote);
    laptop.edit('p1', { pinned: true });
    laptop.edit('p2', { sortOrder: 4 });
    laptop.edit('p3', {
      status: 'archived',
      archivedAt: '2026-11-14T00:00:00Z'
    });
    expect(await laptop.sync()).toBe('synced');
    expect(remote.snapshot.format).toBe(2);
    expect(remote.set?.projects).toMatchObject({
      p1: { pinned: true, sortOrder: 0, archived: false },
      p2: { pinned: false, sortOrder: 4, archived: false },
      p3: { archived: true, archivedAt: '2026-11-14T00:00:00Z' }
    });
    // The journal is spent once the account holds the edits.
    expect(laptop.edits.size).toBe(0);

    // Another device agrees on them, for its listing to lay over the rows.
    const desktop = device(remote);
    expect(await desktop.sync()).toBe('synced');
    expect(desktop.agreed('p1')?.pinned).toBe(true);
    expect(desktop.agreed('p2')?.sortOrder).toBe(4);
    expect(desktop.agreed('p3')).toMatchObject({
      archived: true,
      archivedAt: '2026-11-14T00:00:00Z'
    });
  });

  it('keeps a pin on one device and a reorder on another', async () => {
    const remote = server();
    const a = device(remote);
    const b = device(remote);
    await a.sync();
    await b.sync();
    a.edit('p1', { pinned: true });
    b.edit('p1', { sortOrder: 7 });
    await a.sync();
    await b.sync();
    await a.sync();
    expect(remote.set?.projects?.p1).toMatchObject({
      pinned: true,
      sortOrder: 7
    });
    expect(a.agreed('p1')).toMatchObject({ pinned: true, sortOrder: 7 });
  });

  it('gives a fresh device the account state without overruling it', async () => {
    const remote = server();
    const a = device(remote);
    a.edit('p1', { pinned: true });
    await a.sync();
    const fresh = device(remote);
    await fresh.sync();
    await fresh.sync();
    expect(remote.set?.projects?.p1?.pinned).toBe(true);
    expect(fresh.agreed('p1')?.pinned).toBe(true);
  });

  it('waits with locked keys and keeps every edit for later', async () => {
    const remote = server();
    const locked = device(remote, { codec: null });
    locked.edit('p1', { pinned: true });
    expect(await locked.sync()).toBe('waiting');
    expect(remote.snapshot.revision).toBe(0);
    expect(locked.edits.get('p1')?.after.pinned).toBe(true);
  });

  it('seeds readable rows only where the sealed record holds nothing', async () => {
    const remote = server();
    const a = device(remote);
    a.edit('p1', { sortOrder: 2 });
    await a.sync();
    const b = device(remote, {
      seeds: new Map([
        ['p1', { ...ACTIVE, pinned: true, sortOrder: 5 }],
        ['p2', { status: 'archived', pinned: false, sortOrder: 0 }]
      ])
    });
    await b.sync();
    expect(remote.set?.projects?.p1).toMatchObject({
      pinned: false,
      sortOrder: 2
    });
    expect(remote.set?.projects?.p2?.archived).toBe(true);
  });

  it('sends no shelf state for a plaintext library', async () => {
    const remote = server();
    const plain = device(remote, { codec: plaintextFolderCodec });
    plain.edit('p1', { pinned: true });
    plain.edit('p2', { sortOrder: 1 });
    expect(await plain.sync()).toBe('synced');
    // No folders and no shelf state to store: the record is never written.
    expect(remote.snapshot.record).toBeNull();
    // Its project rows carry the edits; the journal is not kept for it.
    expect(plain.edits.size).toBe(0);
    expect(plain.record?.set.projects).toBeUndefined();
  });

  it('reads version 2 sets and writes version 3 once sealed', async () => {
    const remote = server();
    await remote.save({
      expectedRevision: 0,
      format: 2,
      record: JSON.stringify({ version: 2, folders: {}, members: {} })
    });
    const a = device(remote);
    expect(await a.sync()).toBe('synced');
    expect(
      (JSON.parse(remote.snapshot.record!) as { version: number }).version
    ).toBe(3);
  });
});

describe('shelf set merging', () => {
  const base = (): FolderSet => ({
    version: 3,
    folders: {},
    members: {},
    projects: {}
  });
  const edit = (
    before: Partial<ShelfEdit['before']>,
    after: Partial<ShelfEdit['after']>
  ): ShelfEdit => {
    const shelf = { pinned: false, sortOrder: 0, archived: false };
    return { before: { ...shelf, ...before }, after: { ...shelf, ...after } };
  };

  it('is commutative and stamps only the fields an edit changed', () => {
    const a = recordShelfEdits(
      base(),
      new Map([['p', edit({}, { pinned: true })]]),
      T0
    );
    const b = recordShelfEdits(
      base(),
      new Map([['p', edit({}, { sortOrder: 3 })]]),
      T0 + 5
    );
    expect(mergeFolderSets(a, b)).toEqual(mergeFolderSets(b, a));
    expect(mergeFolderSets(a, b).projects?.p).toMatchObject({
      pinned: true,
      sortOrder: 3
    });
  });

  it('forgets a project back at the defaults after the tombstone window', () => {
    const set = recordShelfEdits(
      base(),
      new Map([
        ['old', edit({ pinned: true }, {})],
        ['kept', edit({}, { pinned: true })]
      ]),
      T0
    );
    const later = pruneFolderSet(set, T0 + 31 * 24 * 60 * 60 * 1000);
    expect(Object.keys(later.projects ?? {})).toEqual(['kept']);
  });
});

describe('listings of a sealed library', () => {
  const summary = (
    projectId: string,
    organization: ProjectOrganization
  ): ProjectSummary =>
    ({
      projectId,
      name: projectId,
      revisionCount: 0,
      updatedAt: '2026-11-14T00:00:00Z',
      organization
    }) as ProjectSummary;
  it('takes the trash from the account and everything else from its own sources', () => {
    const { projects, legacy } = overlaySealedShelf(
      [
        summary('edited', ACTIVE),
        summary('agreed', ACTIVE),
        summary('row', ACTIVE),
        summary('trashed', {
          ...ACTIVE,
          status: 'deleted',
          deletedAt: '2026-11-10T00:00:00Z'
        }),
        summary('legacy', { status: 'archived', pinned: true, sortOrder: 3 })
      ],
      {
        agreed: { pinned: true, sortOrder: 2, archived: false },
        trashed: { pinned: true, sortOrder: 0, archived: false }
      },
      new Map([
        [
          'edited',
          {
            before: { pinned: false, sortOrder: 0, archived: false },
            after: { pinned: false, sortOrder: 1, archived: true }
          }
        ]
      ])
    );
    const byId = Object.fromEntries(
      projects.map((project) => [project.projectId, project.organization])
    );
    // An unsynced edit leads; then the agreed record; then the defaults.
    // This device's organization rows (shared by every account signed in
    // here) are not a source.
    expect(byId.edited).toEqual({
      status: 'archived',
      pinned: false,
      sortOrder: 1
    });
    expect(byId.agreed).toEqual({
      status: 'active',
      pinned: true,
      sortOrder: 2
    });
    expect(byId.row).toEqual(ACTIVE);
    expect(byId.trashed).toEqual({
      status: 'deleted',
      pinned: true,
      sortOrder: 0,
      deletedAt: '2026-11-10T00:00:00Z'
    });
    // A row still holding readable state shows it once, for migration.
    expect(byId.legacy).toEqual({
      status: 'archived',
      pinned: true,
      sortOrder: 3
    });
    expect([...legacy.keys()]).toEqual(['legacy']);
  });

  it('takes only an unmirrored trash move from this device’s rows', () => {
    const account = [
      summary('shelved', { ...ACTIVE, pinned: true, sortOrder: 2 }),
      summary('trashed-here', ACTIVE),
      summary('restored-here', {
        ...ACTIVE,
        status: 'deleted',
        pinned: true,
        deletedAt: '2026-11-10T00:00:00Z'
      })
    ];
    const organizations = sealedListingOrganizations(
      new Map<string, ProjectOrganization>([
        // Pin, order and archive another account signed in here left.
        ['shelved', { status: 'archived', pinned: false, sortOrder: 7 }],
        [
          'trashed-here',
          {
            status: 'deleted',
            pinned: true,
            sortOrder: 9,
            deletedAt: '2026-11-12T00:00:00Z'
          }
        ],
        ['restored-here', { status: 'archived', pinned: false, sortOrder: 4 }],
        // A project only this device holds keeps its row.
        ['device-only', { status: 'archived', pinned: true, sortOrder: 5 }]
      ]),
      account
    );
    expect(Object.fromEntries(organizations)).toEqual({
      shelved: { ...ACTIVE, pinned: true, sortOrder: 2 },
      'trashed-here': {
        status: 'deleted',
        pinned: false,
        sortOrder: 0,
        deletedAt: '2026-11-12T00:00:00Z'
      },
      'restored-here': { status: 'active', pinned: true, sortOrder: 0 },
      'device-only': { status: 'archived', pinned: true, sortOrder: 5 }
    });
  });
});

describe('the shelf edit journal', () => {
  it('keeps the first starting point and only forgets what a round took', () => {
    journalShelfEdit('acct', 'p', ACTIVE, { ...ACTIVE, pinned: true });
    journalShelfEdit(
      'acct',
      'p',
      { ...ACTIVE, pinned: true },
      { ...ACTIVE, pinned: true, sortOrder: 2 }
    );
    const taken = readShelfEdits('acct');
    expect(taken.get('p')).toEqual({
      before: { pinned: false, sortOrder: 0, archived: false },
      after: { pinned: true, sortOrder: 2, archived: false }
    });
    // Edited again while the round ran: that edit stays.
    journalShelfEdit(
      'acct',
      'p',
      { ...ACTIVE, pinned: true, sortOrder: 2 },
      ACTIVE
    );
    journalShelfEdit('acct', 'q', ACTIVE, { ...ACTIVE, pinned: true });
    consumeShelfEdits('acct', taken);
    expect([...readShelfEdits('acct').keys()]).toEqual(['p', 'q']);
    consumeShelfEdits('acct', readShelfEdits('acct'));
    expect(readShelfEdits('acct').size).toBe(0);
  });

  it('keeps an edit storage refused for the visit, and stores it once storage takes it', async () => {
    // Stored while there was room.
    journalShelfEdit('acct', 'q', ACTIVE, { ...ACTIVE, sortOrder: 3 });
    journalShelfEdit('acct', 'r', ACTIVE, { ...ACTIVE, sortOrder: 4 });
    const restore = stubStorage({ refuse: () => true });
    const stored = await beginShelfEdit(() => 'acct').persist(
      new Map([['p', ACTIVE]]),
      new Map([['p', { ...ACTIVE, pinned: true }]]),
      async () => {}
    );
    expect(stored).toBe(false);
    expect([...readShelfEdits('acct').keys()]).toEqual(['q', 'r', 'p']);

    // A round takes `q` and `p` while storage is still full: neither comes
    // back, although storage still holds `q`.
    const taken = readShelfEdits('acct');
    taken.delete('r');
    consumeShelfEdits('acct', taken);
    expect([...readShelfEdits('acct').keys()]).toEqual(['r']);
    expect(localStorage.getItem(shelfEditsKey('acct'))).toContain('"q"');

    // Edited again, still refused; then storage frees up and the next
    // write stores the journal as this visit holds it.
    expect(
      journalShelfEdit('acct', 's', ACTIVE, { ...ACTIVE, pinned: true })
    ).toBe(false);
    restore();
    expect(
      journalShelfEdit('acct', 't', ACTIVE, { ...ACTIVE, pinned: true })
    ).toBe(true);
    expect(
      Object.keys(
        JSON.parse(localStorage.getItem(shelfEditsKey('acct'))!) as object
      )
    ).toEqual(['r', 's', 't']);
    resetShelfStateMemory();
    expect([...readShelfEdits('acct').keys()]).toEqual(['r', 's', 't']);
  });

  it('keeps an edit for the visit when storage is blocked', async () => {
    stubStorage({ blocked: true });
    const stored = await beginShelfEdit(() => 'acct').persist(
      new Map([['p', ACTIVE]]),
      new Map([['p', { ...ACTIVE, status: 'archived' }]]),
      async () => {}
    );
    expect(stored).toBe(false);
    expect(readShelfEdits('acct').get('p')?.after.archived).toBe(true);
  });
});

describe('the account rows kept on this device', () => {
  const summary = (
    projectId: string,
    organization: ProjectOrganization
  ): ProjectSummary =>
    ({
      projectId: toProjectId(projectId),
      name: projectId,
      updatedAt: '',
      organization
    }) as ProjectSummary;

  it('keeps only what differs from the defaults, rows with shelf state first, up to the cap', () => {
    const rows = [
      ...Array.from({ length: MAX_REMEMBERED_ACCOUNT_ROWS + 50 }, (_, i) =>
        summary(`plain_${i}`, ACTIVE)
      ),
      summary('archived', {
        status: 'archived',
        pinned: false,
        sortOrder: 7,
        archivedAt: '2026-11-01T00:00:00.000Z'
      }),
      summary('trashed', {
        status: 'deleted',
        pinned: true,
        sortOrder: 0,
        deletedAt: '2026-11-02T00:00:00.000Z'
      })
    ];
    rememberAccountRows('acct', rows);
    const kept = JSON.parse(
      localStorage.getItem(accountRowsKey('acct'))!
    ) as Record<string, unknown>;
    expect(Object.keys(kept)).toHaveLength(MAX_REMEMBERED_ACCOUNT_ROWS);
    expect(kept.archived).toEqual({
      s: 'a',
      o: 7,
      t: '2026-11-01T00:00:00.000Z'
    });
    expect(kept.trashed).toEqual({
      s: 'd',
      p: 1,
      t: '2026-11-02T00:00:00.000Z'
    });
    expect(kept.plain_0).toEqual({});
    expect(kept[`plain_${MAX_REMEMBERED_ACCOUNT_ROWS}`]).toBeUndefined();
  });

  it('drops a stale copy that storage refuses to replace', () => {
    rememberAccountRows('acct', [
      summary('p', { status: 'active', pinned: true, sortOrder: 0 })
    ]);
    stubStorage({ refuse: () => true });
    rememberAccountRows('acct', [summary('p', ACTIVE)]);
    expect(localStorage.getItem(accountRowsKey('acct'))).toBeNull();
  });
});

function fakeApi(options: { refuse?: boolean; status?: number } = {}) {
  const updates: unknown[] = [];
  const reorders: unknown[] = [];
  const resets: string[] = [];
  const summary = (
    projectId: string,
    organization: ProjectOrganization
  ): UpdateProjectResponse => ({
    project: {
      projectId: toProjectId(projectId),
      name: 'x',
      revisionCount: 0,
      updatedAt: '',
      organization
    }
  });
  const api: ShelfApi = {
    updateProject: vi.fn(async (payload: UpdateProjectRequest) => {
      updates.push(payload);
      if (options.status)
        throw Object.assign(new Error('refused'), { status: options.status });
      if (
        options.refuse &&
        (payload.pinned === true ||
          (payload.sortOrder ?? 0) !== 0 ||
          payload.status === 'archived')
      )
        throw Object.assign(new Error('sealed'), {
          status: 409,
          code: PROJECT_SHELF_STATE_SEALED_CODE
        });
      return summary(payload.projectId, {
        status: payload.status ?? 'active',
        pinned: payload.pinned ?? false,
        sortOrder: payload.sortOrder ?? 0
      });
    }),
    reorderProjects: vi.fn(async (payload: ReorderProjectsRequest) => {
      reorders.push(payload);
      if (options.refuse)
        throw Object.assign(new Error('sealed'), {
          status: 409,
          code: PROJECT_SHELF_STATE_SEALED_CODE
        });
      return { projects: [] };
    }),
    resetProjectShelf: vi.fn(async (projectId: string) => {
      resets.push(projectId);
      if (options.status)
        throw Object.assign(new Error('refused'), { status: options.status });
      return summary(projectId, ACTIVE);
    })
  };
  return { api, updates, reorders, resets };
}

/** The library rule's answers (`encryptsAccountLibrary`). */
const encrypted = async () => true;
const plaintext = async () => false;
const unanswerable = async (): Promise<boolean> => {
  throw Object.assign(new Error('unverified'), {
    code: 'E2EE_PREFERENCE_UNVERIFIED'
  });
};

/** Whether any write carried a pin, a manual position or the archive. */
function disclosed(updates: readonly unknown[]): boolean {
  return updates.some((update) => {
    const { pinned, sortOrder, status } = update as UpdateProjectRequest;
    return (
      pinned !== undefined || sortOrder !== undefined || status === 'archived'
    );
  });
}

describe('account writes of a sealed library', () => {
  it('sends only moves into and out of the trash', async () => {
    const { api, updates } = fakeApi();
    confirmShelfSealed('acct');
    rememberAccountRows('acct', [
      { projectId: 'p', organization: ACTIVE } as ProjectSummary
    ]);
    await mirrorShelfToAccount(
      api,
      'acct',
      'p',
      { ...ACTIVE, pinned: true, sortOrder: 5 },
      encrypted
    );
    await mirrorShelfToAccount(
      api,
      'acct',
      'p',
      { ...ACTIVE, status: 'archived' },
      encrypted
    );
    expect(updates).toEqual([]);
    await mirrorShelfToAccount(
      api,
      'acct',
      'p',
      { ...ACTIVE, status: 'deleted', pinned: true },
      encrypted
    );
    await mirrorShelfToAccount(
      api,
      'acct',
      'p',
      { ...ACTIVE, status: 'archived', pinned: true },
      encrypted
    );
    expect(updates).toEqual([
      { projectId: 'p', status: 'deleted' },
      { projectId: 'p', status: 'active' }
    ]);
  });

  it('checks the library rule before a pin, an order or an archive leaves the page', async () => {
    // Another tab encrypted a project (or accepted an encrypted invitation)
    // and this tab has not listed since: it never assumed plaintext.
    const { api, updates, reorders } = fakeApi({ refuse: true });
    rememberAccountRows('acct', [
      { projectId: 'p', organization: ACTIVE } as ProjectSummary
    ]);
    await mirrorShelfToAccount(
      api,
      'acct',
      'p',
      { ...ACTIVE, status: 'archived', pinned: true, sortOrder: 3 },
      encrypted
    );
    await mirrorShelfToAccount(
      api,
      'acct',
      'p',
      { ...ACTIVE, status: 'deleted', pinned: true },
      encrypted
    );
    expect(
      await reorderShelfOnAccount(api, 'acct', ['p', 'q'], encrypted)
    ).toEqual([]);
    expect(disclosed(updates)).toBe(false);
    expect(updates).toEqual([{ projectId: 'p', status: 'deleted' }]);
    expect(reorders).toEqual([]);
  });

  it('keeps shelf edits on the device while the library rule cannot answer', async () => {
    const { api, updates, reorders } = fakeApi();
    rememberAccountRows('acct', [
      { projectId: 'p', organization: ACTIVE } as ProjectSummary
    ]);
    // The pin waits (the row stays pending); the trash move still goes.
    await expect(
      mirrorShelfToAccount(
        api,
        'acct',
        'p',
        { ...ACTIVE, status: 'deleted', pinned: true },
        unanswerable
      )
    ).rejects.toBeInstanceOf(ShelfStateUnverifiedError);
    await expect(
      reorderShelfOnAccount(api, 'acct', ['p', 'q'], unanswerable)
    ).rejects.toBeInstanceOf(ShelfStateUnverifiedError);
    expect(updates).toEqual([{ projectId: 'p', status: 'deleted' }]);
    expect(reorders).toEqual([]);
    // A trash move alone has nothing left to wait for.
    await mirrorShelfToAccount(
      api,
      'acct',
      'p',
      { ...ACTIVE, status: 'deleted' },
      unanswerable
    );
    // No account to check against: nothing is sent.
    await expect(
      mirrorShelfToAccount(
        api,
        null,
        'p',
        { ...ACTIVE, pinned: true },
        plaintext
      )
    ).rejects.toBeInstanceOf(ShelfStateUnverifiedError);
    expect(disclosed(updates)).toBe(false);
    // Once the account answers plaintext, the retry sends it as before.
    await mirrorShelfToAccount(
      api,
      'acct',
      'p',
      { ...ACTIVE, status: 'deleted', pinned: true },
      plaintext
    );
    expect(updates.at(-1)).toEqual({
      projectId: 'p',
      status: 'deleted',
      pinned: true,
      sortOrder: 0
    });
  });

  it('turns sealed on a Worker refusal that beats the answer', async () => {
    // The account changed between the answer and the write.
    const { api, updates } = fakeApi({ refuse: true });
    await mirrorShelfToAccount(
      api,
      'acct',
      'p',
      { ...ACTIVE, status: 'deleted', pinned: true },
      plaintext
    );
    expect(updates).toEqual([
      { projectId: 'p', status: 'deleted', pinned: true, sortOrder: 0 },
      { projectId: 'p', status: 'deleted' }
    ]);
    const { api: reorderApi, reorders } = fakeApi();
    expect(
      await reorderShelfOnAccount(reorderApi, 'acct', ['p', 'q'], plaintext)
    ).toEqual([]);
    expect(reorders).toEqual([]);
  });

  it('writes a plaintext library as before', async () => {
    const { api, updates, reorders } = fakeApi();
    await mirrorShelfToAccount(
      api,
      'plain',
      'p',
      { ...ACTIVE, pinned: true },
      plaintext
    );
    await reorderShelfOnAccount(api, 'plain', ['p', 'q'], plaintext);
    expect(updates).toEqual([
      { projectId: 'p', status: 'active', pinned: true, sortOrder: 0 }
    ]);
    expect(reorders).toEqual([{ projectIds: ['p', 'q'] }]);
  });

  it('keeps a yes for the visit and asks a no again', async () => {
    const ask = vi.fn(async () => false);
    expect(await askShelfSealed('later', ask)).toBe(false);
    expect(await askShelfSealed('later', ask)).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
    // The account encrypted a project during this visit.
    ask.mockResolvedValue(true);
    expect(await askShelfSealed('later', ask)).toBe(true);
    expect(await askShelfSealed('later', ask)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('resets readable rows only for an account known to be sealed, through the Worker', async () => {
    const legacy = new Map<string, ProjectOrganization>([
      ['p', { status: 'archived', pinned: true, sortOrder: 3 }],
      ['t', { status: 'deleted', pinned: true, sortOrder: 0 }]
    ]);
    const { api, updates, resets } = fakeApi();
    // An unanswerable check counts as sealed for reading, never for a reset.
    expect(await shelfSealedOrSafe('acct', unanswerable)).toBe(true);
    await resetLegacyShelfRows(api, 'acct', legacy);
    expect(resets).toEqual([]);

    confirmShelfSealed('acct');
    noteLegacyShelfRows('acct', legacy);
    await resetLegacyShelfRows(api, 'acct', legacyShelfRows('acct'));
    // The Worker resets each row as it stands, so no status chosen from
    // this listing is sent: a project trashed since stays in the trash.
    expect(resets).toEqual(['p', 't']);
    expect(updates).toEqual([]);
    expect(legacyShelfRows('acct').size).toBe(0);
  });

  it("leaves another owner's rows alone after one refusal", async () => {
    const { api, resets } = fakeApi({ status: 404 });
    confirmShelfSealed('member');
    const shared = new Map<string, ProjectOrganization>([
      ['shared', { ...ACTIVE, pinned: true }]
    ]);
    noteLegacyShelfRows('member', shared);
    await resetLegacyShelfRows(api, 'member', legacyShelfRows('member'));
    noteLegacyShelfRows('member', shared);
    expect(legacyShelfRows('member').size).toBe(0);
    expect(resets).toHaveLength(1);
  });
});
