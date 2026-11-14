/**
 * Migrating a shared plaintext project (ADR-024 Phase 7, slice 7-4;
 * decisions M7(a) and M8; roadmap L11): over the real Worker, its room
 * class and SQLite, the owner's Node device runs the slice 7-2 engine with
 * slice 7-4's member handling, and the members' Node devices run slice
 * 5-3b's invitee flow (`publishInvitationKeyPackages`, then
 * `joinWelcomedProjects`). Who verified whom (slice 5-1's mutual
 * comparison, covered by its own tests) is the one input given directly.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import { addPrimitiveFeature } from '@openzcad/document-core';
import {
  E2EE_MIGRATION_CODES,
  createE2eeInvitationsApi,
  type CollaborationServerMessage,
  type ProjectDocument
} from '@openzcad/shared';
import worker from '../apps/web/worker/index';
import { createEncryptedRoomCodec } from '../apps/web/src/lib/e2ee/encryptedRoomCodec';
import { handleE2eeRequest } from '../apps/web/worker/e2ee';
import type { E2eeInvitationHost } from '../apps/web/worker/e2eeInvitations';
import {
  admitDevelopmentE2eeWrite,
  releaseDevelopmentE2eeWrite
} from '../apps/web/worker/e2eeWriteAuthorization';
import { ProjectCollaborationRoom } from '../apps/web/worker/e2eeRoom';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import { toHex } from '@openzcad/crypto';
import {
  InvitationError,
  acceptedInvitations,
  addInvitedMember,
  confirmEncryptedInvitation,
  contactCodeOf,
  joinWelcomedProjects,
  publishInvitationKeyPackages,
  type InvitationContext,
  type InvitationPerson
} from '../apps/web/src/lib/e2ee/invitations';
import { memoryInvitationStore } from '../apps/web/src/lib/e2ee/invitationStore';
import {
  createProjectMigrationsApi,
  type ProjectMigrationsApi
} from '../apps/web/src/lib/e2ee/projectMigrationsApi';
import { createMigrationPlaintextSource } from '../apps/web/src/lib/e2ee/migrationPlaintextSource';
import {
  createProjectMigrationEngine,
  memoryLeaseStore,
  migrationErrorOf,
  type MigrationAttempt,
  type MigrationLeaseStore,
  type MigrationProgress,
  type ProjectMigrationEngine
} from '../apps/web/src/lib/e2ee/projectMigrationEngine';
import {
  createMigrationController,
  type MigrationController,
  type MigrationLocks
} from '../apps/web/src/lib/e2ee/projectMigrations';
import {
  MIGRATION_APPROVAL_CODE,
  MigrationApprovalNeededError,
  MigrationMembersNotReadyError,
  approvalOf,
  memoryApprovalReceipts,
  migrationMemberAction,
  parseApprovalReceipt,
  prepareMigrationMembers,
  type MigrationApprovalReceipts,
  type MigrationMemberApproval,
  reinviteToEncryptedProject,
  reissuePlaintextShareLinks
} from '../apps/web/src/lib/e2ee/migrationMembers';
import {
  createRoomContext,
  installWorkerSocketGlobals,
  type FakeWebSocket
} from './collaboration-room-harness';
import {
  OTHER,
  OWNER,
  device,
  edited,
  initialDocument,
  makeAccount,
  newServer,
  rows,
  type Account,
  type Device,
  type Server
} from './support/e2ee-documents';

const THIRD = 'user_third';
const EMAILS: Record<string, string> = {
  [OWNER]: 'owner@example.com',
  [OTHER]: 'editor@example.com',
  [THIRD]: 'viewer@example.com'
};

let owner: Account;
let other: Account;
let third: Account;

beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  other = await makeAccount(OTHER, ['other_laptop']);
  third = await makeAccount(THIRD, ['third_laptop']);
});

afterEach(() => {
  forgetAllProjectKeys();
  vi.useRealTimers();
});

const ACCOUNTS = () => [owner, other, third];
const othersOf = (account: Account) =>
  ACCOUNTS().filter((candidate) => candidate !== account);

// --- Server ----------------------------------------------------------------------

interface World {
  srv: Server;
  /** Who each account verified (slice 5-1's signed contacts list). */
  verified: Map<string, Set<string>>;
  mail: { to: string; role: string }[];
}

function world(
  /** Each room's Durable Object storage before its first request. */
  seed: (name: string) => Map<string, unknown> = () => new Map()
): World {
  const rooms = new Map<string, ProjectCollaborationRoom>();
  let env: Record<string, unknown> = {};
  const namespace = {
    getByName: (name: string) => {
      let room = rooms.get(name);
      if (!room) {
        const { context } = createRoomContext(seed(name));
        room = new ProjectCollaborationRoom(context, env);
        context.activate(room);
        rooms.set(name, room);
      }
      return room;
    }
  };
  const srv = newServer(ACCOUNTS(), undefined, {
    E2EE_MIGRATION_ENABLED: 'true',
    PROJECT_ROOM: namespace
  });
  env = srv.env;
  for (const [userId, email] of Object.entries(EMAILS)) {
    srv.db
      .prepare('UPDATE users SET email = ? WHERE id = ?')
      .run(email, userId);
  }
  return { srv, verified: new Map(), mail: [] };
}

function verify(w: World, who: string, whom: string) {
  const set = w.verified.get(who) ?? new Set<string>();
  set.add(whom);
  w.verified.set(who, set);
}

function host(w: World, userId: string): E2eeInvitationHost {
  return {
    email: EMAILS[userId] ?? null,
    inviterLabel: EMAILS[userId] ?? userId,
    sharingEnabled: true,
    emailConfigured: true,
    sendInvitationEmail: async (details) => {
      w.mail.push({ to: details.recipientEmail, role: details.role });
    }
  };
}

/**
 * A device whose encrypted-project calls reach `handleE2eeRequest` as a
 * session with the account's email and migration open (the invitation
 * routes need the email); everything else goes through the whole Worker.
 */
function memberDevice(
  w: World,
  account: Account,
  deviceId: string,
  migration = true
): Device {
  const d = device(w.srv, account, deviceId, { members: othersOf(account) });
  const worker = d.fetcher;
  d.fetcher = async (path: string, init: RequestInit = {}) => {
    if (!path.startsWith('/api/e2ee/')) return worker(path, init);
    const session = { userId: account.userId };
    const db = w.srv.env.DB as D1Database;
    await admitDevelopmentE2eeWrite(db, session);
    try {
      return await handleE2eeRequest(
        new Request(`https://example.com${path}`, init),
        w.srv.env,
        session,
        true,
        true,
        host(w, account.userId),
        migration
      );
    } finally {
      await releaseDevelopmentE2eeWrite(session);
    }
  };
  return d;
}

/** Each device's invitation store, which its browser keeps across passes. */
const stores = new WeakMap<Device, ReturnType<typeof memoryInvitationStore>>();

function invitationsOf(w: World, d: Device): InvitationContext {
  let store = stores.get(d);
  if (!store) stores.set(d, (store = memoryInvitationStore()));
  return {
    groups: d.groups,
    api: createE2eeInvitationsApi((path, init) => d.fetcher(path, init)),
    store,
    email: EMAILS[d.account.userId] ?? null,
    people: {
      inspect: async (userId): Promise<InvitationPerson | null> => {
        const account = ACCOUNTS().find((a) => a.userId === userId);
        if (!account) return null;
        return {
          userId,
          email: EMAILS[userId] ?? null,
          status: w.verified.get(d.account.userId)?.has(userId)
            ? 'verified'
            : 'seen',
          list: account.list
        };
      }
    }
  };
}

// --- The owner's engine -------------------------------------------------------------

interface Owner {
  d: Device;
  invitations: InvitationContext;
  progress: MigrationProgress[];
  /** Runs the engine with the owner's approval of the members, if any. */
  migrate(projectId: string): Promise<void>;
  /**
   * The owner reviews the ready members the engine shows (contact code
   * and signed role of each) and approves exactly them.
   */
  approve(projectId: string): Promise<MigrationMemberApproval[]>;
  /** Sets the approval the next runs carry (null: none). */
  approved: MigrationMemberApproval[] | null;
  /** The migration attempt it was given for, as the engine showed it. */
  approvedFor: MigrationAttempt | undefined;
  /** What this browser recorded of the owner's approval, per staging. */
  receipts: MigrationApprovalReceipts;
  /** How often the engine said the approval it was given is spent. */
  spent: number;
  engine: ProjectMigrationEngine;
}

type MembersAnswer = Awaited<ReturnType<ProjectMigrationsApi['members']>>;

function ownerEngine(
  w: World,
  options: {
    beforeStep?: (step: string, projectId: string) => void | Promise<void>;
    /** What the server answers the owner's member listings instead. */
    tamper?: (projectId: string, answer: MembersAnswer) => MembersAnswer;
    /** Another tab of the same browser: its device and storage. */
    browser?: {
      d: Device;
      receipts: MigrationApprovalReceipts;
      leases: MigrationLeaseStore;
    };
    onProgress?: (progress: MigrationProgress) => void;
    /** The page's flush of a project before a start (`flushProject`). */
    flushProject?: (projectId: string) => Promise<void>;
  } = {}
): Owner {
  const d = options.browser?.d ?? memberDevice(w, owner, 'owner_laptop');
  const base = d.fetcher;
  const invitations = invitationsOf(w, d);
  const progress: MigrationProgress[] = [];
  const plaintext = createMigrationPlaintextSource(base);
  const api = createProjectMigrationsApi(base);
  const tamper = options.tamper;
  const receipts = options.browser?.receipts ?? memoryApprovalReceipts();
  const engine = createProjectMigrationEngine({
    deviceId: 'owner_laptop',
    fetcher: base,
    migrations: tamper
      ? {
          ...api,
          members: async (projectId, leaseId) =>
            tamper(projectId, await api.members(projectId, leaseId))
        }
      : api,
    plaintext,
    leases: options.browser?.leases ?? memoryLeaseStore(),
    approvalReceipts: receipts,
    createStaging: (leased) => {
      d.fetcher = leased;
      return {
        store: d.store,
        blobs: d.blobs,
        references: d.references,
        measurements: d.measurements,
        viewStates: d.viewStates,
        groups: d.groups,
        documents: d.documents,
        invitations: {
          ...invitations,
          api: createE2eeInvitationsApi(leased)
        }
      };
    },
    onProgress: (p) => {
      progress.push(p);
      options.onProgress?.(p);
    },
    ...(options.beforeStep ? { beforeStep: options.beforeStep } : {}),
    ...(options.flushProject ? { flushProject: options.flushProject } : {})
  });
  const side: Owner = {
    d,
    invitations,
    progress,
    approved: null,
    approvedFor: undefined,
    receipts,
    spent: 0,
    engine,
    async migrate(projectId) {
      const summary = (await plaintext.listProjects()).find(
        (p) => p.projectId === projectId
      )!;
      await engine.migrate(
        summary,
        undefined,
        side.approved
          ? {
              approvedMembers: side.approved,
              ...(side.approvedFor !== undefined
                ? { approvedFor: side.approvedFor }
                : {}),
              onApprovalSpent: () => void side.spent++
            }
          : {}
      );
    },
    async approve(projectId) {
      const asked = await failure(side.migrate(projectId));
      expect(asked).toBeInstanceOf(MigrationApprovalNeededError);
      side.approved = approvalOf(progress.at(-1)!.members!);
      side.approvedFor = progress.at(-1)!.attempt;
      return side.approved;
    }
  };
  return side;
}

/** One browser's Web Locks, as its tabs share them (`ifAvailable` only). */
function browserLocks(): MigrationLocks {
  const held = new Set<string>();
  return {
    async request(name, _options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({});
      } finally {
        held.delete(name);
      }
    }
  };
}

/**
 * A tab of the owner's browser: the page's migration controller over the
 * real engine, sharing the browser's device, storage and Web Locks.
 */
function ownerTab(
  w: World,
  browser: {
    d: Device;
    receipts: MigrationApprovalReceipts;
    leases: MigrationLeaseStore;
    locks: MigrationLocks;
  },
  beforeStep?: (step: string, projectId: string) => void | Promise<void>
): MigrationController {
  let forward: (progress: MigrationProgress) => void = () => undefined;
  // Built now, over the device's own fetcher (a staging later swaps it).
  const side = ownerEngine(w, {
    browser,
    onProgress: (progress) => forward(progress),
    ...(beforeStep ? { beforeStep } : {})
  });
  const base = browser.d.fetcher;
  return createMigrationController({
    userId: OWNER,
    fetcher: base,
    migrations: createProjectMigrationsApi(base),
    plaintext: createMigrationPlaintextSource(base),
    locks: browser.locks,
    leases: browser.leases,
    approvalReceipts: browser.receipts,
    openStaging: async () => {
      throw new Error('not used');
    },
    followUps: {
      shareLinks: async () => ({}) as never,
      invitations: async () => ({}) as never
    },
    createEngine: (onProgress) => {
      forward = onProgress;
      return side.engine;
    }
  });
}

// --- The shared plaintext project ----------------------------------------------------

async function namedSave(
  srv: Server,
  document: ProjectDocument,
  reason: string
) {
  const saved = await srv.call(
    'POST',
    `/api/projects/${document.projectId}/revisions`,
    {
      body: {
        projectId: document.projectId,
        reason,
        expectedVersion: document.version,
        document
      }
    }
  );
  expect(saved.status).toBe(200);
  return (await saved.json()) as ProjectDocument;
}

function memberRow(
  srv: Server,
  projectId: string,
  userId: string,
  role: string
) {
  srv.db
    .prepare(
      `INSERT INTO project_members
         (project_id, user_id, role, added_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1)`
    )
    .run(projectId, userId, role, OWNER);
}

/**
 * The owner's plaintext project with a save state, OTHER an editor and
 * THIRD a viewer, a live view link and a pending invitation.
 */
async function sharedPlaintext(w: World) {
  const { srv } = w;
  const created = await srv.call('POST', '/api/projects', {
    body: {
      name: 'Shared bracket',
      initialDocument: initialDocument('Shared bracket')
    }
  });
  expect(created.status).toBe(201);
  const document = ((await created.json()) as { document: ProjectDocument })
    .document;
  const projectId = document.projectId;
  const head = await namedSave(srv, document, 'First save');
  memberRow(srv, projectId, OTHER, 'editor');
  memberRow(srv, projectId, THIRD, 'viewer');
  const link = await srv.call(
    'POST',
    `/api/projects/${projectId}/share-links`,
    {
      body: { mode: 'view' }
    }
  );
  expect(link.status).toBe(201);
  const now = Math.floor(Date.now() / 1000);
  srv.db
    .prepare(
      `INSERT INTO project_invitations
         (id, project_id, email, role, token_hash, invited_by_user_id,
          created_at, expires_at)
       VALUES ('inv_pending', ?, 'friend@example.com', 'editor', ?, ?, ?, ?)`
    )
    .run(projectId, 'b'.repeat(64), OWNER, now - 10, now + 3600);
  return { projectId, head };
}

const formatOf = (srv: Server, projectId: string) =>
  rows<{ storage_format: number }>(
    srv,
    'SELECT storage_format FROM projects WHERE id = ?',
    projectId
  )[0]!.storage_format;

async function failure(promise: Promise<unknown>) {
  return (await promise.catch((caught: unknown) => caught)) as {
    code?: string;
    status?: number;
    members?: { state: string; email: string | null }[];
    details?: Record<string, unknown>;
  };
}

/**
 * The member's browser: confirms each invitation it lists (the member's
 * Join, inviter and role shown), then publishes keys for them.
 */
async function publishKeys(w: World, d: Device) {
  const ctx = invitationsOf(w, d);
  for (const invitation of await acceptedInvitations(ctx)) {
    if (invitation.state === 'confirm') {
      await confirmEncryptedInvitation(ctx, invitation);
    }
  }
  return publishInvitationKeyPackages(ctx);
}

// --- Tests -----------------------------------------------------------------------------

describe('migrating a shared plaintext project (slice 7-4)', () => {
  it('blocks until every member is ready, re-adds both with their roles, and both open it', async () => {
    const w = world();
    const { srv } = w;
    const { projectId, head } = await sharedPlaintext(w);
    const ownerSide = ownerEngine(w);
    const editor = memberDevice(w, other, 'other_laptop');
    const viewer = memberDevice(w, third, 'third_laptop');

    // First pass: the owner's browser invites both; nobody has keys out.
    const first = await failure(ownerSide.migrate(projectId));
    expect(first).toBeInstanceOf(MigrationMembersNotReadyError);
    expect(first.code).toBe(E2EE_MIGRATION_CODES.membersNotReady);
    expect(ownerSide.progress.at(-1)).toMatchObject({ phase: 'members' });
    expect(
      ownerSide.progress.at(-1)!.members!.map((m) => [m.email, m.role, m.state])
    ).toEqual([
      ['editor@example.com', 'editor', 'waiting-for-keys'],
      ['viewer@example.com', 'viewer', 'waiting-for-keys']
    ]);
    // Nothing was staged, so nothing is locked.
    expect(
      rows(
        srv,
        'SELECT * FROM e2ee_project_migrations WHERE project_id = ?',
        projectId
      )
    ).toEqual([]);
    expect(formatOf(srv, projectId)).toBe(1);
    // The Worker refuses the start too, member by member.
    const refused = await failure(
      createProjectMigrationsApi(ownerSide.d.fetcher).start(projectId, {
        direction: 'encrypt',
        deviceId: 'owner_laptop'
      })
    );
    expect(refused).toMatchObject({
      status: 409,
      code: E2EE_MIGRATION_CODES.membersNotReady
    });
    expect(refused.details?.members).toEqual([
      { userId: OTHER, reason: 'waiting-for-keys' },
      { userId: THIRD, reason: 'waiting-for-keys' }
    ]);

    // A member publishes only once they verified the owner (mutual).
    expect(await publishKeys(w, editor)).toEqual([]);
    verify(w, OTHER, OWNER);
    expect((await publishKeys(w, editor)).length).toBe(1);
    // The owner has not verified the editor; the viewer has no keys out.
    const second = await failure(ownerSide.migrate(projectId));
    expect(second).toBeInstanceOf(MigrationMembersNotReadyError);
    const listed = ownerSide.progress.at(-1)!.members!;
    expect(listed.map((m) => m.state)).toEqual(['verify', 'waiting-for-keys']);
    expect(migrationMemberAction(listed[0]!)).toMatch(
      /Compare codes with editor@example\.com/
    );
    expect(migrationMemberAction(listed[1]!)).toMatch(
      /viewer@example\.com needs to open OpenZCAD/
    );
    expect(migrationErrorOf(second).retryable).toBe(true);

    verify(w, OWNER, OTHER);
    verify(w, THIRD, OWNER);
    verify(w, OWNER, THIRD);
    expect((await publishKeys(w, viewer)).length).toBe(1);

    // Ready: the owner approves both by contact code and signed role
    // before anything is staged.
    const asked = await failure(ownerSide.migrate(projectId));
    expect(asked).toBeInstanceOf(MigrationApprovalNeededError);
    expect(migrationErrorOf(asked)).toMatchObject({
      code: MIGRATION_APPROVAL_CODE,
      retryable: false
    });
    const shown = ownerSide.progress.at(-1)!;
    expect(shown.phase).toBe('members');
    expect(
      shown.members!.map((m) => [
        m.userId,
        m.state,
        m.signedRole,
        m.acceptor?.code
      ])
    ).toEqual([
      [OTHER, 'ready', 'editor', await contactCodeOf(other.list)],
      [THIRD, 'ready', 'viewer', await contactCodeOf(third.list)]
    ]);
    expect(
      rows(
        srv,
        'SELECT * FROM e2ee_project_migrations WHERE project_id = ?',
        projectId
      )
    ).toEqual([]);
    expect(await ownerSide.approve(projectId)).toEqual([
      {
        userId: OTHER,
        role: 'editor',
        identityKeyHash: toHex(other.list.identityKeyHash)
      },
      {
        userId: THIRD,
        role: 'viewer',
        identityKeyHash: toHex(third.list.identityKeyHash)
      }
    ]);

    // Approved: staged, both re-added by Welcome, cut over, purged.
    await ownerSide.migrate(projectId);
    expect(formatOf(srv, projectId)).toBe(2);
    const done = ownerSide.progress.at(-1)!;
    expect(done.phase).toBe('done');
    expect(done.members!.map((m) => m.state)).toEqual(['readded', 'readded']);
    expect(ownerSide.progress.some((p) => p.phase === 'readding')).toBe(true);
    // The mirror kept their roles; the Add Commits carried them.
    expect(
      rows<{ user_id: string; role: string }>(
        srv,
        'SELECT user_id, role FROM project_members WHERE project_id = ? ORDER BY user_id',
        projectId
      )
    ).toEqual([
      { user_id: OTHER, role: 'editor' },
      { user_id: THIRD, role: 'viewer' }
    ]);
    expect(
      rows<{ n: number }>(
        srv,
        `SELECT COUNT(*) AS n FROM e2ee_invitations
         WHERE project_id = ? AND completed_at IS NOT NULL`,
        projectId
      )[0]!.n
    ).toBe(2);

    // Both members join by their Welcome and open it with their roles.
    expect(await joinWelcomedProjects(invitationsOf(w, editor))).toEqual([
      projectId
    ]);
    expect(await joinWelcomedProjects(invitationsOf(w, viewer))).toEqual([
      projectId
    ]);
    const opened = await editor.store.loadProject(projectId);
    expect(opened.name).toBe('Shared bracket');
    expect(opened.version).toBeGreaterThan(head.version);
    const history = await editor.store.listRevisions(projectId);
    expect(history.revisions.map((r) => r.reason)).toEqual(['First save']);
    const saved = await editor.store.saveProjectDocument({
      projectId,
      expectedVersion: opened.version,
      document: edited(opened, 'Edited by the editor')
    });
    expect(saved.version).toBe(opened.version + 1);
    const seen = await viewer.store.loadProject(projectId);
    expect(seen.version).toBe(saved.version);
    const viewerWrite = await failure(
      viewer.store.saveProjectDocument({
        projectId,
        expectedVersion: seen.version,
        document: edited(seen, 'Edited by the viewer')
      })
    );
    expect(viewerWrite.status).toBe(403);
  });

  it('revokes the plaintext link and the pending invitation, and offers encrypted ones', async () => {
    const w = world();
    const { srv } = w;
    const { projectId } = await sharedPlaintext(w);
    const ownerSide = ownerEngine(w);
    const editor = memberDevice(w, other, 'other_laptop');
    const viewer = memberDevice(w, third, 'third_laptop');
    for (const [a, b] of [
      [OWNER, OTHER],
      [OTHER, OWNER],
      [OWNER, THIRD],
      [THIRD, OWNER]
    ] as const) {
      verify(w, a, b);
    }
    await failure(ownerSide.migrate(projectId));
    await publishKeys(w, editor);
    await publishKeys(w, viewer);
    await ownerSide.approve(projectId);
    await ownerSide.migrate(projectId);

    expect(
      rows<{ revoked_at: number | null }>(
        srv,
        'SELECT revoked_at FROM project_share_links WHERE project_id = ?',
        projectId
      ).every((row) => row.revoked_at !== null)
    ).toBe(true);
    expect(
      rows<{ revoked_at: number | null }>(
        srv,
        'SELECT revoked_at FROM project_invitations WHERE id = ?',
        'inv_pending'
      )[0]!.revoked_at
    ).not.toBe(null);
    const done = ownerSide.progress.at(-1)!;
    expect(done.revoked).toEqual({
      shareLinks: [expect.objectContaining({ mode: 'view' })],
      invitations: [
        expect.objectContaining({ email: 'friend@example.com', role: 'editor' })
      ]
    });

    // The offers: a new encrypted link of the same mode, and an encrypted
    // invitation to the same address with the same role.
    const owned = memberDevice(w, owner, 'owner_laptop');
    const links = await reissuePlaintextShareLinks(
      owned.shareLinks,
      projectId,
      done.revoked!.shareLinks
    );
    expect(links.map((link) => link.mode)).toEqual(['view']);
    expect(
      rows(
        srv,
        'SELECT share_id FROM e2ee_share_links WHERE project_id = ? AND revoked_at IS NULL',
        projectId
      )
    ).toHaveLength(1);
    const reinvited = await reinviteToEncryptedProject(
      invitationsOf(w, owned),
      projectId,
      done.revoked!.invitations
    );
    expect(reinvited).toEqual({ invited: ['friend@example.com'], failed: [] });
    expect(w.mail).toEqual([{ to: 'friend@example.com', role: 'editor' }]);
  });

  it('refuses the cutover until every member is re-added, and an abandon drops the Adds', async () => {
    const w = world();
    const { srv } = w;
    const { projectId, head: plainHead } = await sharedPlaintext(w);
    for (const [a, b] of [
      [OWNER, OTHER],
      [OTHER, OWNER],
      [OWNER, THIRD],
      [THIRD, OWNER]
    ] as const) {
      verify(w, a, b);
    }
    let lease: string | null = null;
    let stop = true;
    const ownerSide = ownerEngine(w, {
      beforeStep: (step) => {
        if (step === 'readd' && stop) {
          lease =
            rows<{ lease_id: string }>(
              srv,
              'SELECT lease_id FROM e2ee_project_migrations WHERE project_id = ?',
              projectId
            )[0]?.lease_id ?? null;
          throw new Error('Interrupted before the re-add');
        }
      }
    });
    await failure(ownerSide.migrate(projectId));
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    await ownerSide.approve(projectId);
    await failure(ownerSide.migrate(projectId));
    expect(lease).not.toBe(null);
    // Staged: the members' plaintext copy is read-only too (main's 7-1
    // gate, which #922's editor lock answers in their open workspaces),
    // and their room stays closed; reads keep working.
    const opened = await srv.call('GET', `/api/projects/${projectId}`, {
      user: OTHER
    });
    expect(opened.status).toBe(200);
    for (const [method, path, body] of [
      [
        'PUT',
        `/api/projects/${projectId}/document`,
        {
          projectId,
          expectedVersion: plainHead.version,
          document: edited(plainHead, 'An editor edit while encrypting')
        }
      ],
      [
        'POST',
        `/api/projects/${projectId}/revisions`,
        {
          projectId,
          reason: 'An editor save while encrypting',
          expectedVersion: plainHead.version,
          document: plainHead
        }
      ],
      ['POST', `/api/projects/${projectId}/collaboration/ticket`, {}]
    ] as const) {
      const answer = await srv.call(method, path, { user: OTHER, body });
      expect(answer.status, path).toBe(409);
      expect(((await answer.json()) as { code?: string }).code, path).toBe(
        'PROJECT_MIGRATING'
      );
    }
    // Staged, nobody re-added: the cutover refuses, naming both.
    const api = createProjectMigrationsApi(ownerSide.d.fetcher);
    const refused = await failure(api.cutover(projectId, lease!));
    expect(refused).toMatchObject({
      status: 409,
      code: E2EE_MIGRATION_CODES.membersNotReady
    });
    expect(refused.details?.members).toEqual([
      { userId: OTHER, reason: 'not-readded' },
      { userId: THIRD, reason: 'not-readded' }
    ]);
    expect(formatOf(srv, projectId)).toBe(1);

    // Resumed: the members are re-added and the cutover lands.
    stop = false;
    await ownerSide.migrate(projectId);
    expect(formatOf(srv, projectId)).toBe(2);
  });

  it('adds back only the members the owner approved, and stops and asks again when the roster, an identity or a role changes', async () => {
    const w = world();
    const { srv } = w;
    const { projectId } = await sharedPlaintext(w);
    for (const [a, b] of [
      [OWNER, OTHER],
      [OTHER, OWNER],
      [OWNER, THIRD],
      [THIRD, OWNER]
    ] as const) {
      verify(w, a, b);
    }
    let substitute = false;
    const ownerSide = ownerEngine(w, {
      beforeStep: (step) => {
        // Staged: the server now drops the approved viewer from the
        // roster it lists, before the re-add.
        if (step === 'readd' && substitute) {
          substitute = false;
          srv.db
            .prepare(
              'DELETE FROM project_members WHERE project_id = ? AND user_id = ?'
            )
            .run(projectId, THIRD);
        }
      }
    });
    await failure(ownerSide.migrate(projectId));
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    const shown = await ownerSide.approve(projectId);
    const staged = () =>
      rows(
        srv,
        'SELECT * FROM e2ee_project_migrations WHERE project_id = ?',
        projectId
      );
    const noAdds = () =>
      expect(
        rows(srv, 'SELECT * FROM e2ee_welcomes WHERE project_id = ?', projectId)
      ).toEqual([]);

    // Approvals that differ from the roster shown stage nothing: another
    // identity for a member (the code of someone else), another role, a
    // member left out.
    for (const approval of [
      shown.map((entry) =>
        entry.userId === THIRD
          ? { ...entry, identityKeyHash: toHex(other.list.identityKeyHash) }
          : entry
      ),
      shown.map((entry) =>
        entry.userId === THIRD ? { ...entry, role: 'editor' as const } : entry
      ),
      shown.filter((entry) => entry.userId === OTHER)
    ]) {
      ownerSide.approved = approval;
      const changed = await failure(ownerSide.migrate(projectId));
      expect(changed).toBeInstanceOf(MigrationApprovalNeededError);
      expect(changed).toMatchObject({ changed: true });
      expect(ownerSide.progress.at(-1)).toMatchObject({
        phase: 'members',
        error: { code: MIGRATION_APPROVAL_CODE }
      });
      expect(staged()).toEqual([]);
      noAdds();
    }

    // Approved as shown, but the roster changes once staged: nobody is
    // added and nothing is switched over; the owner is asked again.
    ownerSide.approved = shown;
    substitute = true;
    const stopped = await failure(ownerSide.migrate(projectId));
    expect(stopped).toBeInstanceOf(MigrationApprovalNeededError);
    expect(stopped).toMatchObject({ changed: true });
    noAdds();
    expect(formatOf(srv, projectId)).toBe(1);
    expect(ownerSide.progress.at(-1)).toMatchObject({
      phase: 'members',
      error: { code: MIGRATION_APPROVAL_CODE }
    });
    // The roster as it is now, approved again, goes ahead.
    expect(await ownerSide.approve(projectId)).toEqual([
      shown.find((entry) => entry.userId === OTHER)
    ]);
    await ownerSide.migrate(projectId);
    expect(formatOf(srv, projectId)).toBe(2);
    expect(
      rows<{ user_id: string }>(
        srv,
        'SELECT user_id FROM e2ee_welcomes WHERE project_id = ?',
        projectId
      ).map((row) => row.user_id)
    ).toEqual([OTHER]);
  });

  it('drops the re-adds with an abandoned staging, so a new one adds the members again', async () => {
    const w = world();
    const { srv } = w;
    const { projectId } = await sharedPlaintext(w);
    for (const [a, b] of [
      [OWNER, OTHER],
      [OTHER, OWNER],
      [OWNER, THIRD],
      [THIRD, OWNER]
    ] as const) {
      verify(w, a, b);
    }
    let stop = true;
    const ownerSide = ownerEngine(w, {
      beforeStep: (step) => {
        if (step === 'cutover' && stop) throw new Error('Interrupted');
      }
    });
    await failure(ownerSide.migrate(projectId));
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    await ownerSide.approve(projectId);
    await failure(ownerSide.migrate(projectId));
    // Both were re-added in the staged group, then the owner abandons.
    expect(
      rows(srv, 'SELECT * FROM e2ee_welcomes WHERE project_id = ?', projectId)
    ).toHaveLength(2);
    const lease = rows<{ lease_id: string }>(
      srv,
      'SELECT lease_id FROM e2ee_project_migrations WHERE project_id = ?',
      projectId
    )[0]!.lease_id;
    const api = createProjectMigrationsApi(ownerSide.d.fetcher);
    for (;;) {
      if ((await api.abandon(projectId, lease)).complete) break;
    }
    for (const table of ['e2ee_welcomes', 'e2ee_project_leaves']) {
      expect(
        rows(srv, `SELECT * FROM ${table} WHERE project_id = ?`, projectId),
        table
      ).toEqual([]);
    }
    expect(
      rows(
        srv,
        `SELECT * FROM e2ee_invitations
         WHERE project_id = ? AND completed_at IS NOT NULL`,
        projectId
      )
    ).toEqual([]);
    // Members and roles stay as they were in plaintext.
    expect(
      rows(
        srv,
        'SELECT user_id FROM project_members WHERE project_id = ?',
        projectId
      )
    ).toHaveLength(2);

    // A fresh run invites them again; once they republish, it completes.
    stop = false;
    await ownerSide.d.store.forgetStagedProject(projectId);
    const again = await failure(ownerSide.migrate(projectId));
    expect(again).toBeInstanceOf(MigrationMembersNotReadyError);
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    // The approval given before belonged to the abandoned attempt: the
    // owner approves the members again.
    await ownerSide.approve(projectId);
    await ownerSide.migrate(projectId);
    expect(formatOf(srv, projectId)).toBe(2);
  });

  it('asks again in a tab whose approval waited for the run while another tab cancelled that attempt (#1465 review)', async () => {
    const w = world();
    const { srv } = w;
    const { projectId } = await sharedPlaintext(w);
    for (const [a, b] of [
      [OWNER, OTHER],
      [OTHER, OWNER],
      [OWNER, THIRD],
      [THIRD, OWNER]
    ] as const) {
      verify(w, a, b);
    }
    const browser = {
      d: memberDevice(w, owner, 'owner_laptop'),
      receipts: memoryApprovalReceipts(),
      leases: memoryLeaseStore(),
      locks: browserLocks()
    };
    let hold: Promise<void> | null = null;
    let reached!: () => void;
    const tabA = ownerTab(w, browser, async (step) => {
      if (step === 'read' && hold) {
        reached();
        await hold;
      }
    });
    const tabB = ownerTab(w, browser);
    const row = (tab: MigrationController) =>
      tab.getState().projects.find((p) => p.projectId === projectId)!;
    const migration = () =>
      rows<{ state: string; started_at: string }>(
        srv,
        'SELECT state, started_at FROM e2ee_project_migrations WHERE project_id = ?',
        projectId
      )[0];
    const asks = (tab: MigrationController) =>
      expect(row(tab)).toMatchObject({
        phase: 'members',
        error: { code: MIGRATION_APPROVAL_CODE }
      });

    // The members are invited and ready; both tabs show them for approval.
    await tabA.run([projectId]);
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    await tabA.run([projectId]);
    await tabB.run([projectId]);
    asks(tabA);
    asks(tabB);
    expect(migration()).toBeUndefined();

    // Tab A: approved, and staging, holding the run.
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const staged = new Promise<void>((resolve) => {
      reached = resolve;
    });
    tabA.approveMembers(
      projectId,
      approvalOf(row(tabA).members!),
      row(tabA).attempt
    );
    const running = tabA.run([projectId]);
    await staged;
    const first = migration()!;
    expect(first.state).toBe('staging');

    // Tab B: the owner approves there too, but tab A holds the run.
    tabB.approveMembers(
      projectId,
      approvalOf(row(tabB).members!),
      row(tabB).attempt
    );
    await tabB.run([projectId]);
    expect(tabB.getState().otherTab).toBe(true);

    // Tab A pauses, and the owner cancels that staging there.
    tabA.pause();
    release();
    hold = null;
    await running;
    expect(row(tabA).phase).toBe('paused');
    await tabA.cancel(projectId);
    expect(migration()).toMatchObject({
      state: 'abandoned',
      started_at: first.started_at
    });

    // Tab B checks again: the approval it holds was given before the
    // attempt tab A cancelled, so nothing is staged and it asks again.
    await tabB.run([projectId]);
    asks(tabB);
    expect(migration()).toMatchObject({
      state: 'abandoned',
      started_at: first.started_at
    });
    expect(formatOf(srv, projectId)).toBe(1);
    // Forgotten, not merely skipped: the next check asks again too.
    await tabB.run([projectId]);
    asks(tabB);
    expect(migration()!.state).toBe('abandoned');

    // Approved anew for the attempt as it stands, it goes ahead.
    tabB.approveMembers(
      projectId,
      approvalOf(row(tabB).members!),
      row(tabB).attempt
    );
    await tabB.run([projectId]);
    expect(row(tabB).phase).toBe('done');
    expect(formatOf(srv, projectId)).toBe(2);
  });

  it('asks again, and records nothing, when another device starts and cancels while this one flushes before its start (#1465 review)', async () => {
    const w = world();
    const { srv } = w;
    const { projectId } = await sharedPlaintext(w);
    for (const [a, b] of [
      [OWNER, OTHER],
      [OTHER, OWNER],
      [OWNER, THIRD],
      [THIRD, OWNER]
    ] as const) {
      verify(w, a, b);
    }
    let hold: Promise<void> | null = null;
    let reached!: () => void;
    const laptop = ownerEngine(w, {
      flushProject: async () => {
        if (!hold) return;
        reached();
        await hold;
      }
    });
    const migration = () =>
      rows<{ state: string; started_at: string; attempt: number }>(
        srv,
        `SELECT state, started_at, attempt FROM e2ee_project_migrations
         WHERE project_id = ?`,
        projectId
      )[0];

    // The members are invited and ready, and the owner approves them on
    // the laptop while the project has no migration yet.
    await failure(laptop.migrate(projectId));
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    await laptop.approve(projectId);
    expect(laptop.approvedFor).toBe('none');
    const spentBefore = laptop.spent;

    // The laptop read "none", checked the approval, and now flushes the
    // project's edits before its start.
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flushing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const running = failure(laptop.migrate(projectId));
    await flushing;
    expect(migration()).toBeUndefined();

    // Meanwhile the owner's desktop (another device: the laptop's Web Lock
    // does not reach it) starts a staging and cancels it.
    const desktop = createProjectMigrationsApi(
      memberDevice(w, owner, 'owner_desktop').fetcher
    );
    const started = await desktop.start(projectId, {
      direction: 'encrypt',
      deviceId: 'owner_desktop'
    });
    for (;;) {
      if ((await desktop.abandon(projectId, started.leaseId)).complete) break;
    }
    const cancelled = migration()!;
    expect(cancelled).toMatchObject({ state: 'abandoned', attempt: 1 });

    // The laptop's start names the attempt it read, which is gone: the
    // Worker starts nothing, the approval is forgotten, and the owner is
    // shown the members again. No receipt carries the old approval.
    hold = null;
    release();
    const asked = await running;
    expect(asked).toBeInstanceOf(MigrationApprovalNeededError);
    expect(laptop.spent).toBeGreaterThan(spentBefore);
    expect(laptop.receipts.get(projectId)).toBeNull();
    expect(migration()).toEqual(cancelled);
    expect(formatOf(srv, projectId)).toBe(1);
    expect(laptop.progress.at(-1)).toMatchObject({
      phase: 'members',
      attempt: `abandoned#1@${cancelled.started_at}`,
      error: { code: MIGRATION_APPROVAL_CODE }
    });

    // Approved again for the attempt as it stands, it goes ahead.
    await laptop.approve(projectId);
    expect(laptop.approvedFor).toBe(`abandoned#1@${cancelled.started_at}`);
    await laptop.migrate(projectId);
    expect(formatOf(srv, projectId)).toBe(2);
    expect(migration()!.attempt).toBe(2);
  });

  it('never adds a member by another project’s invitation the server lists for this one', async () => {
    const w = world();
    const { srv } = w;
    const { projectId } = await sharedPlaintext(w);
    // The owner's other project, which the editor is also a member of.
    const created = await srv.call('POST', '/api/projects', {
      body: {
        name: 'Other bracket',
        initialDocument: initialDocument('Other bracket')
      }
    });
    expect(created.status).toBe(201);
    const elsewhereId = (
      (await created.json()) as { document: ProjectDocument }
    ).document.projectId;
    memberRow(srv, elsewhereId, OTHER, 'editor');
    for (const [a, b] of [
      [OWNER, OTHER],
      [OTHER, OWNER],
      [OWNER, THIRD],
      [THIRD, OWNER]
    ] as const) {
      verify(w, a, b);
    }
    // The server answers this migration's listing with the editor's
    // genuine, accepted re-add invitation to the other project.
    let swap: 'always' | 'readd' | null = null;
    let elsewhere: MembersAnswer['members'][number]['invitation'] = null;
    let readding = false;
    const swapped = (answer: MembersAnswer): MembersAnswer => ({
      ...answer,
      members: answer.members.map((member) =>
        member.userId === OTHER ? { ...member, invitation: elsewhere } : member
      )
    });
    const ownerSide = ownerEngine(w, {
      beforeStep: (step) => {
        readding = step === 'readd';
      },
      tamper: (id, answer) =>
        id === projectId &&
        (swap === 'always' || (swap === 'readd' && readding))
          ? swapped(answer)
          : answer
    });
    await failure(ownerSide.migrate(projectId));
    const api = createProjectMigrationsApi(ownerSide.d.fetcher);
    await prepareMigrationMembers(ownerSide.invitations, api, elsewhereId);
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    elsewhere = (await api.members(elsewhereId)).members.find(
      (member) => member.userId === OTHER
    )!.invitation;
    expect(elsewhere).toMatchObject({
      projectId: elsewhereId,
      acceptedByUserId: OTHER,
      role: 'editor'
    });
    expect(elsewhere!.acceptance).toBeTruthy();
    const welcomes = (id: string) =>
      rows(srv, 'SELECT * FROM e2ee_welcomes WHERE project_id = ?', id);

    // Listed for this migration, it is not ready: nobody is shown for
    // approval with it.
    swap = 'always';
    const listed = await failure(ownerSide.migrate(projectId));
    expect(listed).toBeInstanceOf(MigrationMembersNotReadyError);
    expect(
      ownerSide.progress
        .at(-1)!
        .members!.map((member) => [member.userId, member.state])
    ).toEqual([
      [OTHER, 'needs-invitation'],
      [THIRD, 'ready']
    ]);
    expect(welcomes(projectId)).toEqual([]);
    expect(welcomes(elsewhereId)).toEqual([]);

    // Honest while the owner approves; swapped once staged, just before
    // the Adds: nobody is added to either project, nothing switched over.
    swap = null;
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    const shown = await ownerSide.approve(projectId);
    expect(shown.map((entry) => entry.userId)).toEqual([OTHER, THIRD]);
    swap = 'readd';
    const stopped = await failure(ownerSide.migrate(projectId));
    expect(stopped).toBeInstanceOf(MigrationMembersNotReadyError);
    expect(welcomes(projectId)).toEqual([]);
    expect(welcomes(elsewhereId)).toEqual([]);
    expect(formatOf(srv, projectId)).toBe(1);

    // The Add itself refuses an invitation that names another project.
    const refused = await failure(
      addInvitedMember(ownerSide.invitations, elsewhere!, {
        confirmedIdentity: toHex(other.list.identityKeyHash),
        projectId
      })
    );
    expect(refused).toBeInstanceOf(InvitationError);
    expect(refused.code).toBe('statement-invalid');
    expect(welcomes(elsewhereId)).toEqual([]);

    // Listed honestly, the approved roster goes ahead.
    swap = null;
    await ownerSide.migrate(projectId);
    expect(formatOf(srv, projectId)).toBe(2);
    expect(
      rows<{ user_id: string }>(
        srv,
        'SELECT user_id FROM e2ee_welcomes WHERE project_id = ?',
        projectId
      )
        .map((row) => row.user_id)
        .sort()
    ).toEqual([OTHER, THIRD].sort());
    expect(welcomes(elsewhereId)).toEqual([]);
  });

  it('resumes a staging whose members were already re-added only with the owner’s approval of all of them', async () => {
    const w = world();
    const { srv } = w;
    const { projectId } = await sharedPlaintext(w);
    for (const [a, b] of [
      [OWNER, OTHER],
      [OTHER, OWNER],
      [OWNER, THIRD],
      [THIRD, OWNER]
    ] as const) {
      verify(w, a, b);
    }
    let stop = true;
    const ownerSide = ownerEngine(w, {
      beforeStep: (step) => {
        if (step === 'cutover' && stop) throw new Error('Interrupted');
      }
    });
    await failure(ownerSide.migrate(projectId));
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    const shown = await ownerSide.approve(projectId);
    await failure(ownerSide.migrate(projectId));
    const welcomes = () =>
      rows(srv, 'SELECT * FROM e2ee_welcomes WHERE project_id = ?', projectId);
    expect(welcomes()).toHaveLength(2);
    // This browser recorded the approval for this staging, which spent
    // the approval given: a later staging asks again.
    const receipt = ownerSide.receipts.get(projectId)!;
    expect(receipt.members).toEqual(shown);
    expect(ownerSide.spent).toBe(1);

    // A staging this browser holds no approval of (an earlier app
    // version's, which re-added the members without asking): after a
    // reload, nothing is switched over until the owner approves every
    // member, the ones already re-added included.
    ownerSide.receipts.delete(projectId);
    ownerSide.approved = null;
    stop = false;
    const asked = await failure(ownerSide.migrate(projectId));
    expect(asked).toBeInstanceOf(MigrationApprovalNeededError);
    expect(asked).toMatchObject({ changed: false });
    expect(formatOf(srv, projectId)).toBe(1);
    expect(welcomes()).toHaveLength(2);
    expect(
      ownerSide.progress
        .at(-1)!
        .members!.map((m) => [
          m.userId,
          m.state,
          m.signedRole,
          m.acceptor?.code
        ])
    ).toEqual([
      [OTHER, 'readded', 'editor', await contactCodeOf(other.list)],
      [THIRD, 'readded', 'viewer', await contactCodeOf(third.list)]
    ]);
    // An approval of only one of them, or of another identity, is not one
    // (each given for this staging, as shown).
    ownerSide.approvedFor = ownerSide.progress.at(-1)!.attempt;
    expect(ownerSide.approvedFor).toMatch(/^staging#1@/);
    for (const approval of [
      shown.filter((entry) => entry.userId === OTHER),
      shown.map((entry) =>
        entry.userId === THIRD
          ? { ...entry, identityKeyHash: toHex(other.list.identityKeyHash) }
          : entry
      )
    ]) {
      ownerSide.approved = approval;
      expect(await failure(ownerSide.migrate(projectId))).toMatchObject({
        code: MIGRATION_APPROVAL_CODE,
        changed: true
      });
      expect(formatOf(srv, projectId)).toBe(1);
    }
    // A receipt for another staging is not this one's.
    ownerSide.approved = null;
    ownerSide.receipts.set({
      ...receipt,
      stagingStartedAt: '2000-01-01T00:00:00.000Z'
    });
    expect(await failure(ownerSide.migrate(projectId))).toMatchObject({
      code: MIGRATION_APPROVAL_CODE,
      changed: false
    });
    expect(formatOf(srv, projectId)).toBe(1);

    // This browser's own receipt for this staging resumes it after a
    // reload without asking again.
    ownerSide.receipts.set(receipt);
    await ownerSide.migrate(projectId);
    expect(formatOf(srv, projectId)).toBe(2);
    expect(welcomes()).toHaveLength(2);
    expect(ownerSide.receipts.get(projectId)).toBeNull();
  });

  it('counts a receipt only for the attempt it names, and forgets it once that attempt changed (#1465 review)', async () => {
    const w = world();
    const { srv } = w;
    const { projectId } = await sharedPlaintext(w);
    for (const [a, b] of [
      [OWNER, OTHER],
      [OTHER, OWNER],
      [OWNER, THIRD],
      [THIRD, OWNER]
    ] as const) {
      verify(w, a, b);
    }
    let between: (() => void) | null = null;
    const ownerSide = ownerEngine(w, {
      beforeStep: (step) => {
        if (step === 'members' && between) {
          const run = between;
          between = null;
          run();
        }
        if (step === 'cutover') throw new Error('Interrupted');
      }
    });
    await failure(ownerSide.migrate(projectId));
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    await ownerSide.approve(projectId);
    expect(await failure(ownerSide.migrate(projectId))).toMatchObject({
      message: 'Interrupted'
    });
    const row = () =>
      rows<{ attempt: number; started_at: string; state: string }>(
        srv,
        'SELECT * FROM e2ee_project_migrations WHERE project_id = ?',
        projectId
      )[0]!;
    const staged = row();
    expect(staged).toMatchObject({ state: 'staging', attempt: 1 });
    // Recorded with the staging's counter as well as its start.
    const receipt = ownerSide.receipts.get(projectId)!;
    expect(receipt).toMatchObject({
      stagingAttempt: 1,
      stagingStartedAt: staged.started_at
    });

    // Another attempt's receipt that began in the same millisecond, or one
    // kept without a counter (an older app's), is not this staging's.
    const { stagingAttempt: _attempt, ...legacy } = receipt;
    expect(parseApprovalReceipt(legacy, projectId)).toEqual({
      ...receipt,
      stagingAttempt: null
    });
    ownerSide.approved = null;
    for (const stored of [
      { ...receipt, stagingAttempt: 2 },
      parseApprovalReceipt(legacy, projectId)!
    ]) {
      ownerSide.receipts.set(stored);
      expect(await failure(ownerSide.migrate(projectId))).toMatchObject({
        code: MIGRATION_APPROVAL_CODE,
        changed: false
      });
      expect(row()).toEqual(staged);
    }

    // Its own receipt, but after this page read the staging another device
    // cancels it and starts again in the same millisecond: the start is
    // refused, the receipt forgotten, and the owner asked again.
    ownerSide.receipts.set(receipt);
    between = () => {
      srv.db
        .prepare(
          `UPDATE e2ee_project_migrations SET state = 'abandoned'
           WHERE project_id = ?`
        )
        .run(projectId);
      srv.db
        .prepare(
          `UPDATE e2ee_project_migrations
           SET state = 'staging', device_id = 'owner_desktop', lease_id = ?,
               lease_expires_at = ?
           WHERE project_id = ?`
        )
        .run('d'.repeat(43), Date.now() + 600_000, projectId);
    };
    expect(await failure(ownerSide.migrate(projectId))).toMatchObject({
      code: MIGRATION_APPROVAL_CODE,
      changed: false
    });
    expect(between).toBeNull();
    expect(row()).toMatchObject({
      state: 'staging',
      attempt: 2,
      started_at: staged.started_at
    });
    expect(ownerSide.receipts.get(projectId)).toBeNull();
    expect(formatOf(srv, projectId)).toBe(1);
  });

  it('drops a resumed staging whose re-added members have no acceptance to review, and adds them again once approved', async () => {
    const w = world();
    const { srv } = w;
    const { projectId } = await sharedPlaintext(w);
    for (const [a, b] of [
      [OWNER, OTHER],
      [OTHER, OWNER],
      [OWNER, THIRD],
      [THIRD, OWNER]
    ] as const) {
      verify(w, a, b);
    }
    let stop = true;
    const ownerSide = ownerEngine(w, {
      beforeStep: (step) => {
        if (step === 'cutover' && stop) throw new Error('Interrupted');
      }
    });
    await failure(ownerSide.migrate(projectId));
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    await ownerSide.approve(projectId);
    await failure(ownerSide.migrate(projectId));
    expect(
      rows(srv, 'SELECT * FROM e2ee_welcomes WHERE project_id = ?', projectId)
    ).toHaveLength(2);

    // As main's app left it: the members re-added with no signed
    // acceptance, and no approval recorded by this browser.
    srv.db
      .prepare(
        `UPDATE e2ee_invitations
           SET acceptance_statement = NULL, acceptance_signature = NULL
         WHERE project_id = ?`
      )
      .run(projectId);
    ownerSide.receipts.delete(projectId);
    ownerSide.approved = null;
    stop = false;
    const restarted = await failure(ownerSide.migrate(projectId));
    // The staging and its Adds are gone; the members are invited again.
    expect(restarted).toBeInstanceOf(MigrationMembersNotReadyError);
    expect(
      rows(srv, 'SELECT * FROM e2ee_welcomes WHERE project_id = ?', projectId)
    ).toEqual([]);
    expect(formatOf(srv, projectId)).toBe(1);
    expect(ownerSide.progress.at(-1)!.members!.map((m) => m.state)).toEqual([
      'waiting-for-keys',
      'waiting-for-keys'
    ]);

    // Once they publish again, the owner approves both and it completes.
    await ownerSide.d.store.forgetStagedProject(projectId);
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    await ownerSide.approve(projectId);
    await ownerSide.migrate(projectId);
    expect(formatOf(srv, projectId)).toBe(2);
  });

  it('drops a resumed staging whose group holds a re-added member the server leaves out of the listing', async () => {
    const w = world();
    const { srv } = w;
    const { projectId } = await sharedPlaintext(w);
    for (const [a, b] of [
      [OWNER, OTHER],
      [OTHER, OWNER],
      [OWNER, THIRD],
      [THIRD, OWNER]
    ] as const) {
      verify(w, a, b);
    }
    let stop = true;
    let omitted: string | null = null;
    const ownerSide = ownerEngine(w, {
      beforeStep: (step) => {
        if (step === 'cutover' && stop) throw new Error('Interrupted');
      },
      tamper: (_projectId, answer) =>
        omitted
          ? {
              ...answer,
              members: answer.members.filter((m) => m.userId !== omitted)
            }
          : answer
    });
    await failure(ownerSide.migrate(projectId));
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    await ownerSide.approve(projectId);
    await failure(ownerSide.migrate(projectId));
    const welcomes = () =>
      rows(srv, 'SELECT * FROM e2ee_welcomes WHERE project_id = ?', projectId);
    expect(welcomes()).toHaveLength(2);

    // As an older app version left it: THIRD re-added with no signed
    // acceptance, no approval recorded by this browser, and the server
    // now leaves THIRD out of the member listing.
    srv.db
      .prepare(
        `UPDATE e2ee_invitations
           SET acceptance_statement = NULL, acceptance_signature = NULL
         WHERE project_id = ? AND accepted_by_user_id = ?`
      )
      .run(projectId, THIRD);
    ownerSide.receipts.delete(projectId);
    ownerSide.approved = null;
    stop = false;
    omitted = THIRD;
    // The owner is shown, and approves, only the member listed.
    const shown = await ownerSide.approve(projectId);
    expect(shown.map((entry) => entry.userId)).toEqual([OTHER]);
    const spent = ownerSide.spent;

    // The staged group still holds THIRD, whom nobody approved: the
    // staging is dropped instead of resumed or switched over.
    const restarted = await failure(ownerSide.migrate(projectId));
    expect(restarted).toBeInstanceOf(MigrationMembersNotReadyError);
    expect(formatOf(srv, projectId)).toBe(1);
    expect(welcomes()).toEqual([]);
    // The approval went with the staging dropped, unrecorded.
    expect(ownerSide.spent).toBe(spent + 1);
    expect(ownerSide.receipts.get(projectId)).toBeNull();
    expect(
      rows(
        srv,
        'SELECT * FROM e2ee_project_leaves WHERE project_id = ? AND user_id = ?',
        projectId,
        THIRD
      )
    ).toEqual([]);
  });

  it('lands a re-add only while the member’s device list is the one it was checked against (#918)', async () => {
    const w = world();
    const { srv } = w;
    const { projectId } = await sharedPlaintext(w);
    for (const [a, b] of [
      [OWNER, OTHER],
      [OTHER, OWNER],
      [OWNER, THIRD],
      [THIRD, OWNER]
    ] as const) {
      verify(w, a, b);
    }
    // Each member's device list moves (a new head, as a removal on another
    // of their devices writes) after the Add was checked and before its
    // batch runs.
    let move = false;
    const moved = new Set<string>();
    const record = srv.statements.push.bind(srv.statements);
    srv.statements.push = (...sql: string[]) => {
      if (move && sql.some((s) => s.includes('INSERT INTO e2ee_mls_commits'))) {
        move = false;
        for (const userId of [OTHER, THIRD]) {
          moved.add(userId);
          srv.db
            .prepare(
              `INSERT INTO e2ee_device_list_entries
                 (user_id, generation, sequence, entry, signature, entry_hash,
                  created_at)
               SELECT user_id, generation, sequence + 1, entry, signature,
                      entry_hash, created_at
               FROM e2ee_device_list_entries WHERE user_id = ?
               ORDER BY generation DESC, sequence DESC LIMIT 1`
            )
            .run(userId);
        }
      }
      return record(...sql);
    };
    const ownerSide = ownerEngine(w, {
      beforeStep: (step) => {
        if (step === 'readd' && moved.size === 0) move = true;
      }
    });
    await failure(ownerSide.migrate(projectId));
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    await ownerSide.approve(projectId);
    const refused = await failure(ownerSide.migrate(projectId));
    expect(refused.code).toBe('E2EE_ADD_MISMATCH');
    expect(moved.size).toBe(2);
    // Nothing landed: no member leaf in the staged group, no Welcome, and
    // the project is still plaintext.
    for (const table of ['e2ee_welcomes', 'e2ee_project_leaves']) {
      expect(
        rows(
          srv,
          `SELECT * FROM ${table} WHERE project_id = ? AND user_id <> ?`,
          projectId,
          OWNER
        ),
        table
      ).toEqual([]);
    }
    expect(formatOf(srv, projectId)).toBe(1);

    // Once the members publish again against their current lists, the
    // resumed staging re-adds them and cuts over.
    await publishKeys(w, memberDevice(w, other, 'other_laptop'));
    await publishKeys(w, memberDevice(w, third, 'third_laptop'));
    await ownerSide.migrate(projectId);
    expect(formatOf(srv, projectId)).toBe(2);
  });
});

// --- The room after the cutover (slice 7-4 with slice 5-6) ----------------------------

/** One device's live encrypted room, as the collaboration hook drives it. */
interface LiveRoom {
  socket: FakeWebSocket;
  next<T extends CollaborationServerMessage['type']>(
    type: T
  ): Promise<Extract<CollaborationServerMessage, { type: T }>>;
  send(document: ProjectDocument, baseVersion: number): Promise<void>;
}

async function liveRoom(
  w: World,
  serverSockets: FakeWebSocket[],
  d: Device,
  projectId: string,
  clientId: string
): Promise<LiveRoom> {
  const response = await worker.fetch(
    new Request(`https://example.com/api/projects/${projectId}/collaboration`, {
      headers: {
        upgrade: 'websocket',
        origin: 'https://example.com',
        'x-openzcad-development-user': d.account.userId
      }
    }),
    w.srv.env
  );
  expect(response.status).toBe(101);
  const socket = serverSockets.at(-1)!;
  const codec = createEncryptedRoomCodec(d.store.roomAccess(), projectId);
  let seen = 0;
  const room: LiveRoom = {
    socket,
    async next(type) {
      const deadline = Date.now() + 15_000;
      for (;;) {
        while (seen < socket.sent.length) {
          const { message } = await codec.decode(socket.sent[seen++]!);
          if (message?.type === type) return message as never;
        }
        if (Date.now() > deadline) throw new Error(`No ${type} frame.`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async send(document, baseVersion) {
      const encoded = await codec.encode(document, baseVersion);
      if (encoded.kind !== 'sealed') throw new Error('nothing to send');
      await socket.receive(
        JSON.stringify({
          type: 'e2ee-document',
          clientId,
          version: encoded.submission
        })
      );
    }
  };
  await socket.receive(
    JSON.stringify({
      type: 'hello',
      clientId,
      displayName: clientId,
      baseVersion: null,
      document: null
    })
  );
  await socket.receive(JSON.stringify({ type: 'lease-acquire', clientId }));
  return room;
}

const featureNames = (document: ProjectDocument) =>
  Object.values(document.nodes)
    .filter((node) => node.kind === 'feature')
    .map((node) => node.name);

const withBox = (document: ProjectDocument, name: string) =>
  addPrimitiveFeature(document, {
    name,
    primitiveKind: 'box',
    dimensions: { width: 1, height: 2, depth: 3 }
  });

describe(
  'the room of a migrated shared project (slice 7-4 with slice 5-6)',
  { timeout: 60_000 },
  () => {
    let globals: ReturnType<typeof installWorkerSocketGlobals>;
    beforeAll(() => {
      globals = installWorkerSocketGlobals();
    });
    afterAll(() => {
      globals.restore();
    });

    it('lets the re-added editor write through the room and the viewer follow', async () => {
      // The members collaborated in the plaintext room before the migration.
      let plain: ProjectDocument | null = null;
      const w = world((name) =>
        plain && name === plain.projectId
          ? new Map<string, unknown>([
              [
                'room:meta',
                {
                  schema: 1,
                  projectId: name,
                  latestVersion: plain.version,
                  historyVersions: []
                }
              ],
              ['room:latest', plain]
            ])
          : new Map()
      );
      const { srv } = w;
      const { projectId, head } = await sharedPlaintext(w);
      plain = head;
      const ownerSide = ownerEngine(w);
      const editor = memberDevice(w, other, 'other_laptop');
      const viewer = memberDevice(w, third, 'third_laptop');
      for (const [a, b] of [
        [OWNER, OTHER],
        [OTHER, OWNER],
        [OWNER, THIRD],
        [THIRD, OWNER]
      ] as const) {
        verify(w, a, b);
      }
      await failure(ownerSide.migrate(projectId));
      await publishKeys(w, editor);
      await publishKeys(w, viewer);
      await ownerSide.approve(projectId);
      await ownerSide.migrate(projectId);
      expect(formatOf(srv, projectId)).toBe(2);
      await joinWelcomedProjects(invitationsOf(w, editor));
      await joinWelcomedProjects(invitationsOf(w, viewer));

      // The owner's browser after the migration: the same MLS state, its
      // ordinary (unleased) requests.
      const ownerPage = device(srv, owner, 'owner_laptop', {
        mls: ownerSide.d.mls,
        pins: ownerSide.d.pins,
        members: othersOf(owner)
      });
      const opened = await ownerPage.store.loadProject(projectId);
      await editor.store.loadProject(projectId);
      await viewer.store.loadProject(projectId);
      const sockets = globals.serverSockets;
      const o = await liveRoom(
        w,
        sockets,
        ownerPage,
        projectId,
        'client_owner'
      );
      const e = await liveRoom(w, sockets, editor, projectId, 'client_editor');
      const v = await liveRoom(w, sockets, viewer, projectId, 'client_viewer');
      // Each gets the encrypted head, with the role the cutover mirrored.
      expect(await o.next('state')).toMatchObject({
        role: 'owner',
        document: { version: opened.version }
      });
      expect(await e.next('state')).toMatchObject({
        role: 'editor',
        document: { version: opened.version }
      });
      expect((await v.next('state')).role).toBe('viewer');

      const next = withBox(opened, 'Editor box');
      await e.send(next, opened.version);
      expect(await e.next('ack')).toEqual({
        type: 'ack',
        version: next.version
      });
      for (const peer of [o, v]) {
        const relayed = await peer.next('document');
        expect(relayed.clientId).toBe('client_editor');
        expect(featureNames(relayed.document)).toContain('Editor box');
      }
      // The account holds the editor's version, signed by its device.
      expect(
        rows<{ signer_user_id: string }>(
          srv,
          `SELECT signer_user_id FROM e2ee_project_versions
           WHERE project_id = ? ORDER BY document_version DESC LIMIT 1`,
          projectId
        )[0]!.signer_user_id
      ).toBe(OTHER);
      // The viewer's browser seals nothing.
      await expect(
        createEncryptedRoomCodec(viewer.store.roomAccess(), projectId).encode(
          withBox(next, 'Viewer box'),
          next.version
        )
      ).rejects.toMatchObject({ readOnly: true });
    });
  }
);

describe('with migration closed', () => {
  it('serves no member routes and takes no KeyPackage for a plaintext project', async () => {
    const w = world();
    w.srv.env.E2EE_MIGRATION_ENABLED = 'false';
    const { projectId } = await sharedPlaintext(w);
    const members = await w.srv.call(
      'GET',
      `/api/e2ee/projects/${projectId}/migration/members`
    );
    expect(members.status).toBe(501);
    expect(
      (
        await w.srv.call(
          'POST',
          `/api/e2ee/projects/${projectId}/migration/invitations`,
          { body: {} }
        )
      ).status
    ).toBe(501);
  });

  it('takes no KeyPackage for a re-add invitation once migration closes', async () => {
    const w = world();
    const { srv } = w;
    const { projectId } = await sharedPlaintext(w);
    verify(w, OTHER, OWNER);
    // Opened: the owner's browser invites the members.
    await failure(ownerEngine(w).migrate(projectId));
    expect(
      rows(
        srv,
        'SELECT * FROM e2ee_invitations WHERE project_id = ?',
        projectId
      )
    ).toHaveLength(2);
    // Closed: the member's browser cannot publish for the plaintext project.
    const editor = memberDevice(w, other, 'other_laptop', false);
    expect(await failure(publishKeys(w, editor))).toMatchObject({
      status: 401
    });
    expect(
      rows(
        srv,
        'SELECT * FROM e2ee_key_packages WHERE project_id = ?',
        projectId
      )
    ).toEqual([]);
  });
});
