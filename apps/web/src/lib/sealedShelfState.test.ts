import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROJECT_SHELF_STATE_SEALED_CODE,
  type ProjectOrganization,
  type ProjectSummary,
  type ReorderProjectsRequest,
  type UpdateProjectRequest
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
  seedShelf,
  type FolderSet,
  type ShelfEdit
} from './libraryFolderSync';
import type { LocalProjectOrganizationSnapshot } from './localProjectStore';
import {
  askShelfSealed,
  confirmShelfSealed,
  consumeShelfEdits,
  journalShelfEdit,
  mirrorShelfToAccount,
  noteLegacyShelfRows,
  legacyShelfRows,
  overlaySealedShelf,
  readShelfEdits,
  rememberAccountRows,
  reorderShelfOnAccount,
  resetLegacyShelfRows,
  resetShelfStateMemory,
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
  resetShelfStateMemory();
  localStorage.clear();
});

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

/** One browser: its organization rows, its edit journal and its record. */
function device(
  remote: ReturnType<typeof server>,
  options: {
    codec?: FolderRecordCodec | null;
    rows?: Record<string, ProjectOrganization>;
    seeds?: Map<string, ProjectOrganization>;
  } = {}
) {
  const rows = new Map<string, LocalProjectOrganizationSnapshot>(
    Object.entries(options.rows ?? {}).map(([id, organization], index) => [
      id,
      { organization, revision: `r${index}`, mirrorPending: false }
    ])
  );
  let edits = new Map<string, ShelfEdit>();
  let record: ReturnType<FolderSyncHost['readRecord']> = null;
  let clock = T0;
  let revisions = 0;
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
    readShelf: () => Promise.resolve(new Map(rows)),
    writeShelf: (projectId, organization, revision) => {
      const row = rows.get(projectId);
      if ((row?.revision ?? null) !== revision) return Promise.resolve(false);
      rows.set(projectId, {
        organization,
        revision: `w${(revisions += 1)}`,
        mirrorPending: row?.mirrorPending ?? false
      });
      return Promise.resolve(true);
    },
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
    /** A shelf edit, as `saveShelfRows` makes it: the row and the journal. */
    edit(projectId: string, change: Partial<ProjectOrganization>) {
      clock += 1000;
      const before = rows.get(projectId)?.organization ?? ACTIVE;
      const after = { ...before, ...change };
      rows.set(projectId, {
        organization: after,
        revision: `e${(revisions += 1)}`,
        mirrorPending: true
      });
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
    /** A row the listing wrote (an acknowledgement, not an edit). */
    adopt(projectId: string, organization: ProjectOrganization) {
      rows.set(projectId, {
        organization,
        revision: `a${(revisions += 1)}`,
        mirrorPending: false
      });
    },
    sync: () => syncLibraryFolders(host),
    row: (projectId: string) => rows.get(projectId),
    get edits() {
      return edits;
    },
    set edits(next: Map<string, ShelfEdit>) {
      edits = next;
    },
    get record() {
      return record;
    }
  };
}

describe('the sealed shelf record', () => {
  it('carries pins, order and archive from one device to another', async () => {
    const remote = server();
    const laptop = device(remote, {
      rows: { p1: ACTIVE, p2: ACTIVE, p3: ACTIVE }
    });
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

    // Another device lays them over the rows it holds.
    const desktop = device(remote, {
      rows: { p1: ACTIVE, p2: ACTIVE, p3: ACTIVE }
    });
    expect(await desktop.sync()).toBe('synced');
    expect(desktop.row('p1')?.organization.pinned).toBe(true);
    expect(desktop.row('p2')?.organization.sortOrder).toBe(4);
    expect(desktop.row('p3')?.organization).toMatchObject({
      status: 'archived',
      archivedAt: '2026-11-14T00:00:00Z'
    });
  });

  it('keeps a pin on one device and a reorder on another', async () => {
    const remote = server();
    const a = device(remote, { rows: { p1: ACTIVE } });
    const b = device(remote, { rows: { p1: ACTIVE } });
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
    expect(a.row('p1')?.organization).toMatchObject({
      pinned: true,
      sortOrder: 7
    });
  });

  it('never reads a row the listing wrote as an edit (fresh device)', async () => {
    // Regression guard: a fresh device's listing writes default rows from
    // a record older than the sync's; diffing rows would unpin everything.
    const remote = server();
    const a = device(remote, { rows: { p1: ACTIVE } });
    a.edit('p1', { pinned: true });
    await a.sync();
    const fresh = device(remote);
    await fresh.sync();
    fresh.adopt('p1', ACTIVE);
    await fresh.sync();
    expect(remote.set?.projects?.p1?.pinned).toBe(true);
    expect(fresh.row('p1')?.organization.pinned).toBe(true);
  });

  it('waits with locked keys and keeps every edit for later', async () => {
    const remote = server();
    const locked = device(remote, { codec: null, rows: { p1: ACTIVE } });
    locked.edit('p1', { pinned: true });
    expect(await locked.sync()).toBe('waiting');
    expect(remote.snapshot.revision).toBe(0);
    expect(locked.edits.get('p1')?.after.pinned).toBe(true);
    expect(locked.row('p1')?.organization.pinned).toBe(true);
  });

  it('lets the account win over a first round of untimed device rows', async () => {
    const remote = server();
    const a = device(remote, { rows: { p1: ACTIVE } });
    a.edit('p1', { pinned: true });
    await a.sync();
    // A device that synced folders before shelf state joined them, holding
    // a stale row from before: its rows are seeded at stamp 0.
    const stale = device(remote, {
      rows: { p1: { ...ACTIVE, sortOrder: 9 }, p2: { ...ACTIVE, pinned: true } }
    });
    await stale.sync();
    expect(remote.set?.projects?.p1).toMatchObject({
      pinned: true,
      sortOrder: 0
    });
    // What the account did not hold arrives.
    expect(remote.set?.projects?.p2?.pinned).toBe(true);
    expect(stale.row('p1')?.organization).toMatchObject({
      pinned: true,
      sortOrder: 0
    });
  });

  it('seeds readable rows only where the sealed record holds nothing', async () => {
    const remote = server();
    const a = device(remote, { rows: { p1: ACTIVE } });
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

  it('keeps a row in the trash there while laying pins over it', async () => {
    const remote = server();
    const a = device(remote, { rows: { p1: ACTIVE } });
    a.edit('p1', { pinned: true });
    await a.sync();
    const b = device(remote, {
      rows: {
        p1: { ...ACTIVE, status: 'deleted', deletedAt: '2026-11-13T00:00:00Z' }
      }
    });
    await b.sync();
    expect(b.row('p1')?.organization).toEqual({
      status: 'deleted',
      deletedAt: '2026-11-13T00:00:00Z',
      pinned: true,
      sortOrder: 0
    });
  });

  it('sends no shelf state for a plaintext library', async () => {
    const remote = server();
    const plain = device(remote, {
      codec: plaintextFolderCodec,
      rows: { p1: ACTIVE }
    });
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
    const a = device(remote, { rows: { p1: ACTIVE } });
    expect(await a.sync()).toBe('synced');
    expect(
      (JSON.parse(remote.snapshot.record!) as { version: number }).version
    ).toBe(3);
  });
});

describe('shelf set merging', () => {
  const base = (): FolderSet =>
    seedShelf({ version: 3, folders: {}, members: {} }, new Map());
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
  const snapshot = (
    organization: ProjectOrganization
  ): LocalProjectOrganizationSnapshot => ({
    organization,
    revision: 'r',
    mirrorPending: false
  });

  it('takes the trash from the account and everything else from the device', () => {
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
      new Map([
        ['edited', snapshot({ ...ACTIVE, pinned: true })],
        ['agreed', snapshot(ACTIVE)],
        ['row', snapshot({ ...ACTIVE, sortOrder: 6 })],
        ['trashed', snapshot({ ...ACTIVE, pinned: true })]
      ]),
      {
        agreed: { pinned: true, sortOrder: 2, archived: false }
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
    // An unsynced edit leads; then the agreed record; then this device's row.
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
    expect(byId.row).toEqual({ status: 'active', pinned: false, sortOrder: 6 });
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

  it('never turns a device pin into the account default', () => {
    // Post-migration rows hold defaults; locked keys hold no agreed record.
    const { projects } = overlaySealedShelf(
      [summary('p', ACTIVE)],
      new Map([['p', snapshot({ ...ACTIVE, pinned: true, sortOrder: 4 })]]),
      null
    );
    expect(projects[0]!.organization).toEqual({
      status: 'active',
      pinned: true,
      sortOrder: 4
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
});

function fakeApi(options: { refuse?: boolean; status?: number } = {}) {
  const updates: unknown[] = [];
  const reorders: unknown[] = [];
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
      return {
        project: {
          projectId: payload.projectId,
          name: 'x',
          revisionCount: 0,
          updatedAt: '',
          organization: {
            status: payload.status ?? 'active',
            pinned: payload.pinned ?? false,
            sortOrder: payload.sortOrder ?? 0
          }
        }
      };
    }),
    reorderProjects: vi.fn(async (payload: ReorderProjectsRequest) => {
      reorders.push(payload);
      if (options.refuse)
        throw Object.assign(new Error('sealed'), {
          status: 409,
          code: PROJECT_SHELF_STATE_SEALED_CODE
        });
      return { projects: [] };
    })
  };
  return { api, updates, reorders };
}

describe('account writes of a sealed library', () => {
  it('sends only moves into and out of the trash', async () => {
    const { api, updates } = fakeApi();
    confirmShelfSealed('acct');
    rememberAccountRows('acct', [
      { projectId: 'p', organization: ACTIVE } as ProjectSummary
    ]);
    await mirrorShelfToAccount(api, 'acct', 'p', {
      ...ACTIVE,
      pinned: true,
      sortOrder: 5
    });
    await mirrorShelfToAccount(api, 'acct', 'p', {
      ...ACTIVE,
      status: 'archived'
    });
    expect(updates).toEqual([]);
    await mirrorShelfToAccount(api, 'acct', 'p', {
      ...ACTIVE,
      status: 'deleted',
      pinned: true
    });
    await mirrorShelfToAccount(api, 'acct', 'p', {
      ...ACTIVE,
      status: 'archived',
      pinned: true
    });
    expect(updates).toEqual([
      { projectId: 'p', status: 'deleted' },
      { projectId: 'p', status: 'active' }
    ]);
  });

  it('turns sealed on the Worker refusal and still moves the trash', async () => {
    const { api, updates } = fakeApi({ refuse: true });
    await mirrorShelfToAccount(api, 'acct', 'p', {
      ...ACTIVE,
      status: 'deleted',
      pinned: true
    });
    expect(updates).toEqual([
      { projectId: 'p', status: 'deleted', pinned: true, sortOrder: 0 },
      { projectId: 'p', status: 'deleted' }
    ]);
    const { api: reorderApi, reorders } = fakeApi();
    expect(await reorderShelfOnAccount(reorderApi, 'acct', ['p', 'q'])).toEqual(
      []
    );
    expect(reorders).toEqual([]);
  });

  it('writes a plaintext library as before', async () => {
    const { api, updates, reorders } = fakeApi();
    await askShelfSealed('plain', async () => false);
    await mirrorShelfToAccount(api, 'plain', 'p', { ...ACTIVE, pinned: true });
    await reorderShelfOnAccount(api, 'plain', ['p', 'q']);
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

  it('resets readable rows only for an account known to be sealed', async () => {
    const legacy = new Map<string, ProjectOrganization>([
      ['p', { status: 'archived', pinned: true, sortOrder: 3 }],
      ['t', { status: 'deleted', pinned: true, sortOrder: 0 }]
    ]);
    const { api, updates } = fakeApi();
    // An unanswerable check counts as sealed for reading, never for a reset.
    expect(
      await shelfSealedOrSafe('acct', async () => {
        throw new Error('offline');
      })
    ).toBe(true);
    await resetLegacyShelfRows(api, 'acct', legacy);
    expect(updates).toEqual([]);

    confirmShelfSealed('acct');
    noteLegacyShelfRows('acct', legacy);
    await resetLegacyShelfRows(api, 'acct', legacyShelfRows('acct'));
    // The archived row returns to active; the trashed one stays trashed.
    expect(updates).toEqual([
      { projectId: 'p', pinned: false, sortOrder: 0, status: 'active' },
      { projectId: 't', pinned: false, sortOrder: 0 }
    ]);
    expect(legacyShelfRows('acct').size).toBe(0);
  });

  it("leaves another owner's rows alone after one refusal", async () => {
    const { api, updates } = fakeApi({ status: 404 });
    confirmShelfSealed('member');
    const shared = new Map<string, ProjectOrganization>([
      ['shared', { ...ACTIVE, pinned: true }]
    ]);
    noteLegacyShelfRows('member', shared);
    await resetLegacyShelfRows(api, 'member', legacyShelfRows('member'));
    noteLegacyShelfRows('member', shared);
    expect(legacyShelfRows('member').size).toBe(0);
    expect(updates).toHaveLength(1);
  });
});
