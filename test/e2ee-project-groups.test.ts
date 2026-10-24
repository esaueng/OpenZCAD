/**
 * Solo MLS groups for encrypted projects (ADR-024 Phase 4, slice 4-4): two
 * Node devices of one owner run the real client module
 * (`apps/web/src/lib/e2ee/projectGroups.ts`) and the in-process MLS engine
 * against the real Worker routes over SQLite with every migration applied.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import {
  accountKeyCommitment,
  deviceListEntryHash,
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  generateSymmetricKey,
  signDeviceListEntry,
  toBase64Url,
  toHex,
  verifyDeviceList,
  type DeviceListEntry,
  type ListedDevice,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { inProcessMls } from '../packages/mls/src/test-support';
import {
  catchUpProjectGroup,
  commitProjectGroup,
  createProjectGroup,
  createProjectGroupsApi,
  joinProjectGroup,
  projectKeyForEpoch,
  recoverProjectGroup,
  type ProjectGroupContext
} from '../apps/web/src/lib/e2ee/projectGroups';
import { MlsProjectSessions } from '../apps/web/src/lib/e2ee/mls/projectSessions';
import { createMlsLoader } from '../apps/web/src/lib/e2ee/mls/loader';
import {
  memoryMlsSessionStore,
  type MlsSessionStore
} from '../apps/web/src/lib/e2ee/mls/sessionStore';
import type { CertifyingDevice } from '../apps/web/src/lib/e2ee/mls/certify';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const OWNER = 'user_owner';
const OTHER = 'user_other';
const NOW = '2026-10-24T00:00:00.000Z';
const ADDED_AT = 1_700_000_000_000;

afterEach(() => {
  forgetAllProjectKeys();
  vi.useRealTimers();
});

// --- Accounts --------------------------------------------------------------

interface Account {
  userId: string;
  list: VerifiedDeviceList;
  devices: Map<string, CertifyingDevice>;
  accountKey: Uint8Array;
  /** Rows the Worker reads the device list from. */
  seed(db: DatabaseSync): void;
}

const ecdhPublic = async () =>
  exportPublicKey((await generateEncryptionKeyPair()).publicKey);

async function makeAccount(
  userId: string,
  certified: readonly string[],
  readOnly: readonly string[] = []
): Promise<Account> {
  const identity = await generateSigningKeyPair(false);
  const identityRaw = await exportPublicKey(identity.publicKey);
  const devices = new Map<string, CertifyingDevice>();
  const listed: ListedDevice[] = [];
  for (const deviceId of [...certified, ...readOnly]) {
    const signing = await generateSigningKeyPair(false);
    devices.set(deviceId, { userId, deviceId, signing });
    if (!certified.includes(deviceId)) continue;
    listed.push({
      deviceId,
      label: deviceId,
      signingKey: await exportPublicKey(signing.publicKey),
      unlockKey: await ecdhPublic(),
      addedAt: ADDED_AT
    });
  }
  const accountKey = generateSymmetricKey();
  const genesis: DeviceListEntry = {
    userId,
    sequence: 0,
    previousEntryHash: null,
    issuedAt: ADDED_AT,
    previousIdentityKeyHash: null,
    encryptionKey: await ecdhPublic(),
    accountKeyCommitment: await accountKeyCommitment(accountKey),
    devices: listed,
    unlockTargets: [
      {
        kind: 'recovery-key',
        targetId: 'rk_1',
        publicKey: await ecdhPublic(),
        addedAt: ADDED_AT
      }
    ],
    revoked: []
  };
  const signed = await signDeviceListEntry(identity.privateKey, genesis);
  const entryHash = toHex(await deviceListEntryHash(signed.entry));
  return {
    userId,
    list: await verifyDeviceList(identityRaw, [signed]),
    devices,
    accountKey,
    seed(db) {
      db.prepare(
        `INSERT INTO e2ee_identities (user_id, generation, identity_key, created_at)
         VALUES (?, 1, ?, ?)`
      ).run(userId, toBase64Url(identityRaw), NOW);
      db.prepare(
        `INSERT INTO e2ee_device_list_entries
           (user_id, generation, sequence, entry, signature, entry_hash, created_at)
         VALUES (?, 1, 0, ?, ?, ?, ?)`
      ).run(
        userId,
        toBase64Url(signed.entry),
        toBase64Url(signed.signature),
        entryHash,
        NOW
      );
    }
  };
}

let owner: Account;
let other: Account;

beforeAll(async () => {
  owner = await makeAccount(
    OWNER,
    ['owner_laptop', 'owner_desktop'],
    ['owner_tablet']
  );
  other = await makeAccount(OTHER, ['other_laptop']);
});

// --- Server ----------------------------------------------------------------

interface Server {
  db: DatabaseSync;
  env: Record<string, unknown>;
  statements: string[];
  call(
    method: string,
    path: string,
    options?: { user?: string; body?: unknown }
  ): Promise<Response>;
}

function objectBucket() {
  const objects = new Map<string, ArrayBuffer>();
  return {
    put: vi.fn(async (key: string, body: ArrayBuffer | Uint8Array) => {
      objects.set(key, new Uint8Array(body).slice().buffer);
    }),
    get: vi.fn(async (key: string) => {
      const body = objects.get(key);
      return body
        ? { arrayBuffer: async () => body.slice(0), size: body.byteLength }
        : null;
    }),
    head: vi.fn(async (key: string) => {
      const body = objects.get(key);
      return body ? { size: body.byteLength } : null;
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    })
  };
}

let projects = 0;

function newServer(
  db: DatabaseSync = migratedDatabase(),
  extraEnv: Record<string, unknown> = {}
): Server {
  for (const user of [OWNER, OTHER]) {
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, NULL, ?)'
    ).run(user, NOW);
  }
  owner.seed(db);
  other.seed(db);
  const statements: string[] = [];
  const bucket = objectBucket();
  const room = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  );
  const env: Record<string, unknown> = {
    ENVIRONMENT: 'development',
    AUTH_MODE: 'development',
    DB: sqliteD1(db, { onStatement: (sql) => statements.push(sql) }),
    PROJECT_STORAGE: bucket,
    ARTIFACTS: bucket,
    PROJECT_SHARING_ENABLED: 'true',
    PROJECT_PERSONAL_SYNC_ENABLED: 'true',
    PROJECT_ROOM: { getByName: vi.fn(() => ({ fetch: room })) },
    E2EE_KEYS_ENABLED: 'true',
    E2EE_PROJECTS_ENABLED: 'true',
    ...extraEnv
  };
  const call: Server['call'] = (method, path, options = {}) =>
    worker.fetch(
      new Request(`https://example.com${path}`, {
        method,
        headers: {
          'x-openzcad-development-user': options.user ?? OWNER,
          ...(options.body === undefined
            ? {}
            : { 'content-type': 'application/json' })
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) })
      }),
      env
    );
  return { db, env, statements, call };
}

/** No API path creates a format-2 project yet (slice 4-5): seed one. */
function seedProject(
  srv: Server,
  userId = OWNER,
  storageFormat: 1 | 2 = 2
): string {
  const id = `proj_groups_${++projects}`;
  srv.db
    .prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at, storage_format)
       VALUES (?, ?, 'Encrypted project', ?, ?, ?)`
    )
    .run(
      id,
      userId,
      storageFormat === 2 ? 'e2ee-v1:opaque' : '{}',
      NOW,
      storageFormat
    );
  return id;
}

type Hook = (path: string, init: RequestInit) => Promise<void>;

interface Device {
  ctx: ProjectGroupContext;
  sessions: MlsProjectSessions;
  store: MlsSessionStore;
  /** Runs before a request reaches the Worker. */
  before?: Hook;
  /** Runs after the Worker answered, before the device sees the answer. */
  after?: Hook;
}

/** One device: its own engine and session store over the shared server. */
function device(
  srv: Server,
  account: Account,
  deviceId: string | null,
  store: MlsSessionStore = memoryMlsSessionStore()
): Device {
  const sessions = new MlsProjectSessions(
    store,
    createMlsLoader(async () => inProcessMls())
  );
  const result = { store, sessions } as Device;
  const fetcher = async (path: string, init: RequestInit = {}) => {
    await result.before?.(path, init);
    const response = await worker.fetch(
      new Request(`https://example.com${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          'x-openzcad-development-user': account.userId
        }
      }),
      srv.env
    );
    await result.after?.(path, init);
    return response;
  };
  result.ctx = {
    api: createProjectGroupsApi(fetcher),
    sessions,
    account: {
      userId: account.userId,
      list: account.list,
      currentAccountKey: async () => ({
        key: new Uint8Array(account.accountKey),
        generation: 1,
        keySequence: 0
      }),
      openAccountKey: async () => {
        throw new Error('no older account key in this test');
      }
    },
    device: deviceId ? account.devices.get(deviceId)! : null
  };
  return result;
}

/** A device reloaded: a new page and engine over the same storage. */
const reload = (srv: Server, account: Account, deviceId: string, old: Device) =>
  device(srv, account, deviceId, old.store);

const hex = (bytes: Uint8Array) => toHex(bytes);
const isCommitPost = (path: string, init: RequestInit) =>
  init.method === 'POST' && path.endsWith('/mls/commits');

function ref(account: Account, deviceId: string, projectId: string) {
  return { userId: account.userId, deviceId, projectId };
}

async function currentKey(
  d: Device,
  account: Account,
  deviceId: string,
  projectId: string
) {
  return hex(await d.sessions.projectKey(ref(account, deviceId, projectId)));
}

function count(srv: Server, table: string, projectId: string): number {
  return (
    srv.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`)
      .get(projectId) as { n: number }
  ).n;
}

function groupEpoch(srv: Server, projectId: string): number {
  return (
    srv.db
      .prepare('SELECT epoch FROM e2ee_project_groups WHERE project_id = ?')
      .get(projectId) as { epoch: number }
  ).epoch;
}

// --- Scenarios -------------------------------------------------------------

describe('solo MLS groups', () => {
  it('create, join by external Commit while the first device is offline, then catch up', async () => {
    const srv = newServer();
    const projectId = seedProject(srv);
    const laptop = device(srv, owner, 'owner_laptop');
    const desktop = device(srv, owner, 'owner_desktop');

    expect(await createProjectGroup(laptop.ctx, projectId)).toEqual({
      epoch: 0,
      keyEpoch: 0
    });
    expect(count(srv, 'e2ee_project_groups', projectId)).toBe(1);
    expect(count(srv, 'e2ee_project_leaves', projectId)).toBe(1);
    expect(count(srv, 'e2ee_project_keys', projectId)).toBe(2);
    expect(count(srv, 'e2ee_key_archives', projectId)).toBe(1);
    const epoch0 = await currentKey(laptop, owner, 'owner_laptop', projectId);

    // The laptop is offline from here: the desktop joins on its own.
    expect(await joinProjectGroup(desktop.ctx, projectId)).toEqual({
      epoch: 1,
      keyEpoch: 1
    });
    expect(
      srv.db
        .prepare(
          'SELECT epoch, kind, sender_user_id, sender_device_id FROM e2ee_mls_commits WHERE project_id = ?'
        )
        .all(projectId)
    ).toEqual([
      {
        epoch: 0,
        kind: 'external',
        sender_user_id: OWNER,
        sender_device_id: 'owner_desktop'
      }
    ]);
    // The new leaf is certified from the epoch it joined at.
    const leaves = srv.db
      .prepare(
        'SELECT device_id, certification FROM e2ee_project_leaves WHERE project_id = ? ORDER BY device_id'
      )
      .all(projectId) as { device_id: string; certification: string }[];
    expect(leaves.map((leaf) => leaf.device_id)).toEqual([
      'owner_desktop',
      'owner_laptop'
    ]);

    // The desktop reads epoch 0 back through its account-key wrap.
    forgetAllProjectKeys();
    expect(hex(await projectKeyForEpoch(desktop.ctx, projectId, 0))).toBe(
      epoch0
    );

    // The laptop comes back and processes the external Commit.
    expect(await catchUpProjectGroup(laptop.ctx, projectId)).toEqual({
      epoch: 1,
      keyEpoch: 1
    });
    const epoch1 = await currentKey(laptop, owner, 'owner_laptop', projectId);
    expect(await currentKey(desktop, owner, 'owner_desktop', projectId)).toBe(
      epoch1
    );
    expect(epoch1).not.toBe(epoch0);
    expect(
      hex(
        await laptop.sessions
          .epochMaterial(ref(owner, 'owner_laptop', projectId))
          .then((m) => m.epochAuthenticator)
      )
    ).toBe(
      hex(
        await desktop.sessions
          .epochMaterial(ref(owner, 'owner_desktop', projectId))
          .then((m) => m.epochAuthenticator)
      )
    );

    // Either device moves the group on; the other follows.
    expect(await commitProjectGroup(laptop.ctx, projectId)).toEqual({
      epoch: 2,
      keyEpoch: 2
    });
    await catchUpProjectGroup(desktop.ctx, projectId);
    expect(await currentKey(desktop, owner, 'owner_desktop', projectId)).toBe(
      await currentKey(laptop, owner, 'owner_laptop', projectId)
    );
    // Every epoch's key opens from the wraps, on either device.
    forgetAllProjectKeys();
    for (const keyEpoch of [0, 1, 2]) {
      expect(
        hex(await projectKeyForEpoch(desktop.ctx, projectId, keyEpoch))
      ).toBe(hex(await projectKeyForEpoch(laptop.ctx, projectId, keyEpoch)));
    }
    // A second group for the project is refused, whoever builds it.
    const rival = device(srv, owner, 'owner_desktop');
    await expect(
      createProjectGroup(rival.ctx, projectId)
    ).rejects.toMatchObject({
      status: 409,
      code: 'E2EE_GROUP_EXISTS'
    });
    expect(count(srv, 'e2ee_project_leaves', projectId)).toBe(2);
    expect(count(srv, 'e2ee_key_archives', projectId)).toBe(3);
  });

  it('refuses a duplicate epoch, and the loser rebases onto the winner', async () => {
    const srv = newServer();
    const projectId = seedProject(srv);
    const laptop = device(srv, owner, 'owner_laptop');
    const desktop = device(srv, owner, 'owner_desktop');
    await createProjectGroup(laptop.ctx, projectId);
    await joinProjectGroup(desktop.ctx, projectId);
    await catchUpProjectGroup(laptop.ctx, projectId);

    // The laptop's Commit lands between the desktop's catch-up and its send.
    let raced = false;
    desktop.before = async (path, init) => {
      if (raced || !isCommitPost(path, init)) return;
      raced = true;
      expect(await commitProjectGroup(laptop.ctx, projectId)).toEqual({
        epoch: 2,
        keyEpoch: 2
      });
    };
    const posted: number[] = [];
    desktop.after = async (path, init) => {
      if (isCommitPost(path, init))
        posted.push(
          (JSON.parse(init.body as string) as { epoch: number }).epoch
        );
    };
    expect(await commitProjectGroup(desktop.ctx, projectId)).toEqual({
      epoch: 3,
      keyEpoch: 3
    });
    // First for epoch 1 (refused: taken by the laptop), then rebuilt on 2.
    expect(posted).toEqual([1, 2]);
    const senders = srv.db
      .prepare(
        'SELECT epoch, sender_device_id FROM e2ee_mls_commits WHERE project_id = ? ORDER BY epoch'
      )
      .all(projectId);
    expect(senders).toEqual([
      { epoch: 0, sender_device_id: 'owner_desktop' },
      { epoch: 1, sender_device_id: 'owner_laptop' },
      { epoch: 2, sender_device_id: 'owner_desktop' }
    ]);
    await catchUpProjectGroup(laptop.ctx, projectId);
    expect(await currentKey(laptop, owner, 'owner_laptop', projectId)).toBe(
      await currentKey(desktop, owner, 'owner_desktop', projectId)
    );

    // On the wire: a second Commit for a taken epoch gets the winner back.
    const winner = srv.db
      .prepare(
        'SELECT message FROM e2ee_mls_commits WHERE project_id = ? AND epoch = 1'
      )
      .get(projectId) as { message: string };
    const late = await srv.call(
      'POST',
      `/api/e2ee/projects/${projectId}/mls/commits`,
      {
        body: {
          epoch: 1,
          kind: 'commit',
          deviceId: 'owner_desktop',
          message: 'AAAA',
          groupInfo: 'AAAA',
          wraps: [],
          archive: {}
        }
      }
    );
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({
      code: 'EPOCH_TAKEN',
      winner: {
        epoch: 1,
        message: winner.message,
        senderDeviceId: 'owner_laptop'
      }
    });
    // Nothing moved.
    expect(groupEpoch(srv, projectId)).toBe(3);
  });

  it('confirms a Commit the server accepted before a crash, after reload', async () => {
    const srv = newServer();
    const projectId = seedProject(srv);
    const laptop = device(srv, owner, 'owner_laptop');
    await createProjectGroup(laptop.ctx, projectId);

    // The server stores the Commit; the answer never reaches the device.
    laptop.after = async (path, init) => {
      if (isCommitPost(path, init)) throw new TypeError('connection reset');
    };
    await expect(commitProjectGroup(laptop.ctx, projectId)).rejects.toThrow(
      'connection reset'
    );
    expect(groupEpoch(srv, projectId)).toBe(1);
    const stuck = ref(owner, 'owner_laptop', projectId);
    expect((await laptop.sessions.status(stuck)).pendingCommit).toBe(true);

    const restarted = reload(srv, owner, 'owner_laptop', laptop);
    expect(await recoverProjectGroup(restarted.ctx, projectId)).toBe(
      'confirmed'
    );
    const status = await restarted.sessions.status(stuck);
    expect(status).toMatchObject({ epoch: 1, pendingCommit: false });
    forgetAllProjectKeys();
    expect(hex(await projectKeyForEpoch(restarted.ctx, projectId, 1))).toBe(
      await currentKey(restarted, owner, 'owner_laptop', projectId)
    );
    expect(await recoverProjectGroup(restarted.ctx, projectId)).toBe('none');
  });

  it('discards a pending Commit another device beat, and processes the winner', async () => {
    const srv = newServer();
    const projectId = seedProject(srv);
    const laptop = device(srv, owner, 'owner_laptop');
    const desktop = device(srv, owner, 'owner_desktop');
    await createProjectGroup(laptop.ctx, projectId);
    await joinProjectGroup(desktop.ctx, projectId);
    await catchUpProjectGroup(laptop.ctx, projectId);

    // The laptop's Commit is built and stored, then the page dies before
    // sending it; the desktop takes the epoch meanwhile.
    laptop.before = async (path, init) => {
      if (isCommitPost(path, init)) throw new TypeError('page closed');
    };
    await expect(commitProjectGroup(laptop.ctx, projectId)).rejects.toThrow(
      'page closed'
    );
    await commitProjectGroup(desktop.ctx, projectId);

    const restarted = reload(srv, owner, 'owner_laptop', laptop);
    expect(await recoverProjectGroup(restarted.ctx, projectId)).toBe(
      'discarded'
    );
    expect(await catchUpProjectGroup(restarted.ctx, projectId)).toEqual({
      epoch: 2,
      keyEpoch: 2
    });
    expect(await currentKey(restarted, owner, 'owner_laptop', projectId)).toBe(
      await currentKey(desktop, owner, 'owner_desktop', projectId)
    );

    // A pending Commit nobody ruled on is sent again.
    restarted.before = async (path, init) => {
      if (isCommitPost(path, init)) {
        restarted.before = undefined;
        throw new TypeError('offline');
      }
    };
    await expect(commitProjectGroup(restarted.ctx, projectId)).rejects.toThrow(
      'offline'
    );
    const again = reload(srv, owner, 'owner_laptop', restarted);
    expect(await recoverProjectGroup(again.ctx, projectId)).toBe('resent');
    expect(groupEpoch(srv, projectId)).toBe(3);
    await catchUpProjectGroup(desktop.ctx, projectId);
    expect(await currentKey(desktop, owner, 'owner_desktop', projectId)).toBe(
      await currentKey(again, owner, 'owner_laptop', projectId)
    );
  });

  it('rebuilds a rejoin whose GroupInfo went stale, and refuses an inconsistent one', async () => {
    const srv = newServer();
    const projectId = seedProject(srv);
    const laptop = device(srv, owner, 'owner_laptop');
    const desktop = device(srv, owner, 'owner_desktop');
    await createProjectGroup(laptop.ctx, projectId);

    // The desktop read epoch 0's GroupInfo; the laptop commits before the
    // desktop's external Commit arrives.
    let raced = false;
    const attempts: number[] = [];
    desktop.before = async (path, init) => {
      if (!isCommitPost(path, init)) return;
      attempts.push(
        (JSON.parse(init.body as string) as { epoch: number }).epoch
      );
      if (raced) return;
      raced = true;
      await commitProjectGroup(laptop.ctx, projectId);
    };
    expect(await joinProjectGroup(desktop.ctx, projectId)).toEqual({
      epoch: 2,
      keyEpoch: 2
    });
    expect(attempts).toEqual([0, 1]);
    await catchUpProjectGroup(laptop.ctx, projectId);
    expect(await currentKey(laptop, owner, 'owner_laptop', projectId)).toBe(
      await currentKey(desktop, owner, 'owner_desktop', projectId)
    );

    // A server whose GroupInfo lags its epoch is refused before anything is
    // built, and one serving an old GroupInfo as current fails the join.
    const late = seedProject(srv);
    const creator = device(srv, owner, 'owner_laptop');
    await createProjectGroup(creator.ctx, late);
    await commitProjectGroup(creator.ctx, late);
    srv.db
      .prepare(
        'UPDATE e2ee_project_groups SET group_info_epoch = 0 WHERE project_id = ?'
      )
      .run(late);
    const joiner = device(srv, owner, 'owner_desktop');
    await expect(joinProjectGroup(joiner.ctx, late)).rejects.toMatchObject({
      code: 'server-mismatch'
    });
    srv.db
      .prepare(
        `UPDATE e2ee_project_groups
         SET group_info = initial_group_info, group_info_epoch = 1 WHERE project_id = ?`
      )
      .run(late);
    // The join archive ends at epoch 1; the old GroupInfo cannot match it.
    const refused = await joinProjectGroup(joiner.ctx, late).catch(
      (error: unknown) => error as Error
    );
    expect(refused).toMatchObject({ name: 'MlsError' });
    expect((refused as Error).message).toContain('joining epoch');
    expect(
      await joiner.sessions.leaf(ref(owner, 'owner_desktop', late))
    ).toBeNull();
    expect(groupEpoch(srv, late)).toBe(1);
    expect(count(srv, 'e2ee_mls_commits', late)).toBe(1);
  });

  it('lets a read-only approved device read keys but refuses its leaf', async () => {
    const srv = newServer();
    const projectId = seedProject(srv);
    const laptop = device(srv, owner, 'owner_laptop');
    await createProjectGroup(laptop.ctx, projectId);
    await commitProjectGroup(laptop.ctx, projectId);
    const keys = [
      hex(await projectKeyForEpoch(laptop.ctx, projectId, 0)),
      hex(await projectKeyForEpoch(laptop.ctx, projectId, 1))
    ];
    forgetAllProjectKeys();

    // Decision D4: account-key wraps only; it holds no leaf.
    const reader = device(srv, owner, null);
    expect(hex(await projectKeyForEpoch(reader.ctx, projectId, 0))).toBe(
      keys[0]
    );
    expect(hex(await projectKeyForEpoch(reader.ctx, projectId, 1))).toBe(
      keys[1]
    );

    const tablet = device(srv, owner, 'owner_tablet');
    const requests: string[] = [];
    tablet.before = async (path) => {
      requests.push(path);
    };
    await expect(joinProjectGroup(tablet.ctx, projectId)).rejects.toMatchObject(
      {
        code: 'device-not-certified'
      }
    );
    expect(requests).toEqual([]);

    // A client that skips that check is refused by the Worker as well.
    const leaf = {
      leafKey: toBase64Url(new Uint8Array(65).fill(4)),
      certification: toBase64Url(new Uint8Array(73).fill(2))
    };
    const forged = await srv.call(
      'POST',
      `/api/e2ee/projects/${projectId}/mls/commits`,
      {
        body: {
          epoch: 1,
          kind: 'external',
          deviceId: 'owner_tablet',
          message: 'AAAA',
          groupInfo: 'AAAA',
          leaf,
          wraps: [],
          archive: {}
        }
      }
    );
    expect(forged.status).toBe(403);
    expect(await forged.json()).toMatchObject({
      code: 'E2EE_DEVICE_NOT_CERTIFIED'
    });
    const fresh = seedProject(srv);
    const create = await srv.call(
      'POST',
      `/api/e2ee/projects/${fresh}/mls/group-info`,
      {
        body: {
          groupId: 'grp_x',
          deviceId: 'owner_tablet',
          groupInfo: 'AAAA',
          leaf,
          wraps: [],
          archive: {}
        }
      }
    );
    expect(create.status).toBe(403);
    expect(count(srv, 'e2ee_project_leaves', projectId)).toBe(1);
    expect(groupEpoch(srv, projectId)).toBe(1);
  });

  it('never serves wraps to anyone but their user', async () => {
    const srv = newServer();
    const projectId = seedProject(srv);
    const laptop = device(srv, owner, 'owner_laptop');
    await createProjectGroup(laptop.ctx, projectId);
    // A row for another user in this project, however it got there.
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_keys
           (user_id, project_id, key_epoch, purpose, account_key_generation,
            account_key_sequence, wrapped, created_at)
         VALUES (?, ?, 0, 'project-key', 1, 0, ?, ?)`
      )
      .run(OTHER, projectId, 'B'.repeat(55), NOW);
    const mine = (await (
      await srv.call('GET', `/api/e2ee/projects/${projectId}/keys`)
    ).json()) as { wraps: { purpose: string }[] };
    expect(mine.wraps.map((w) => w.purpose).sort()).toEqual([
      'project-key',
      'rejoin-psk'
    ]);
    const ownWrapped = srv.db
      .prepare('SELECT wrapped FROM e2ee_project_keys WHERE user_id = ?')
      .all(OWNER)
      .map((row) => (row as { wrapped: string }).wrapped);
    expect(JSON.stringify(mine)).not.toContain('B'.repeat(55));

    const routes = [
      'keys',
      'keys/archives',
      'mls/leaves',
      'mls/commits',
      'mls/group-info'
    ];
    for (const route of routes) {
      const outsider = await srv.call(
        'GET',
        `/api/e2ee/projects/${projectId}/${route}`,
        {
          user: OTHER
        }
      );
      expect(outsider.status, route).toBe(404);
      const text = await outsider.text();
      for (const wrapped of ownWrapped) expect(text).not.toContain(wrapped);
    }
    // A member learns only that it is owner-only, and still gets no wraps.
    srv.db
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, added_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'editor', ?, 1, 1)`
      )
      .run(projectId, OTHER, OWNER);
    const member = await srv.call(
      'GET',
      `/api/e2ee/projects/${projectId}/keys`,
      {
        user: OTHER
      }
    );
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({
      code: 'E2EE_PROJECT_OWNER_ONLY'
    });
    // The other user's own project lists only their own wraps.
    const theirs = seedProject(srv, OTHER);
    const otherLaptop = device(srv, other, 'other_laptop');
    await createProjectGroup(otherLaptop.ctx, theirs);
    const listed = (await (
      await srv.call('GET', `/api/e2ee/projects/${theirs}/keys`, {
        user: OTHER
      })
    ).json()) as { wraps: { wrapped: string }[] };
    expect(listed.wraps).toHaveLength(2);
    for (const wrap of listed.wraps)
      expect(ownWrapped).not.toContain(wrap.wrapped);
  });

  it('refuses non-owners, plaintext projects, and runs only behind the flag', async () => {
    const srv = newServer();
    const plaintext = seedProject(srv, OWNER, 1);
    for (const [method, route] of [
      ['GET', 'mls/group-info'],
      ['POST', 'mls/group-info'],
      ['GET', 'keys']
    ] as const) {
      const response = await srv.call(
        method,
        `/api/e2ee/projects/${plaintext}/${route}`,
        {
          ...(method === 'POST' ? { body: {} } : {})
        }
      );
      expect(response.status, route).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'E2EE_PROJECT_NOT_ENCRYPTED'
      });
    }
    const encrypted = seedProject(srv);
    expect(
      (await srv.call('GET', `/api/e2ee/projects/${encrypted}/mls/group-info`))
        .status
    ).toBe(404);
    expect(
      (await srv.call('GET', `/api/e2ee/projects/${encrypted}/mls/elsewhere`))
        .status
    ).toBe(404);
    expect(
      (await srv.call('GET', `/api/e2ee/projects/proj_missing/keys`)).status
    ).toBe(404);
    // A trashed project is not served.
    srv.db
      .prepare("UPDATE projects SET status = 'deleted' WHERE id = ?")
      .run(encrypted);
    expect(
      (await srv.call('GET', `/api/e2ee/projects/${encrypted}/keys`)).status
    ).toBe(404);

    // Without E2EE_PROJECTS_ENABLED (or the key routes) nothing opens.
    const closed = newServer(migratedDatabase(), {
      E2EE_PROJECTS_ENABLED: undefined
    });
    const closedProject = seedProject(closed);
    const off = await closed.call(
      'GET',
      `/api/e2ee/projects/${closedProject}/keys`
    );
    expect(off.status).toBe(501);
    expect(await (await closed.call('GET', '/api/e2ee/config')).json()).toEqual(
      {
        enabled: true,
        projectsEnabled: false
      }
    );
    const keysOff = newServer(migratedDatabase(), {
      E2EE_KEYS_ENABLED: undefined
    });
    expect(
      (
        await keysOff.call(
          'GET',
          `/api/e2ee/projects/${seedProject(keysOff)}/keys`
        )
      ).status
    ).toBe(501);
    expect(await (await srv.call('GET', '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: true
    });
  });

  it('refuses a tampered key archive before joining', async () => {
    const srv = newServer();
    const projectId = seedProject(srv);
    const laptop = device(srv, owner, 'owner_laptop');
    await createProjectGroup(laptop.ctx, projectId);
    await commitProjectGroup(laptop.ctx, projectId);
    // Swap epoch 1's signature for epoch 0's: valid bytes, wrong envelope.
    const signature = (
      srv.db
        .prepare(
          'SELECT signature FROM e2ee_key_archives WHERE project_id = ? AND key_epoch = 0'
        )
        .get(projectId) as { signature: string }
    ).signature;
    srv.db
      .prepare(
        'UPDATE e2ee_key_archives SET signature = ? WHERE project_id = ? AND key_epoch = 1'
      )
      .run(signature, projectId);
    forgetAllProjectKeys();
    const desktop = device(srv, owner, 'owner_desktop');
    await expect(
      joinProjectGroup(desktop.ctx, projectId)
    ).rejects.toMatchObject({
      code: 'archive-invalid'
    });
    expect(groupEpoch(srv, projectId)).toBe(1);
  });

  it('removes group rows with project purge and account erasure', async () => {
    const srv = newServer();
    const purged = seedProject(srv);
    const kept = seedProject(srv);
    const laptop = device(srv, owner, 'owner_laptop');
    await createProjectGroup(laptop.ctx, purged);
    await createProjectGroup(laptop.ctx, kept);
    srv.db
      .prepare(
        "UPDATE projects SET status = 'deleted', deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
      )
      .run(purged);
    expect((await srv.call('POST', '/api/projects/purge')).status).toBe(200);
    for (const table of [
      'e2ee_project_groups',
      'e2ee_mls_commits',
      'e2ee_project_leaves',
      'e2ee_project_keys',
      'e2ee_key_archives'
    ]) {
      expect(count(srv, table, purged), table).toBe(0);
    }
    expect(count(srv, 'e2ee_project_keys', kept)).toBe(2);

    // Erasure fences every late write, from any writer.
    srv.db
      .prepare(
        "INSERT INTO account_erasure_requests (user_id, scope, started_at, updated_at) VALUES (?, 'all', 1, 1)"
      )
      .run(OWNER);
    expect(() =>
      srv.db
        .prepare(
          `INSERT INTO e2ee_project_keys (user_id, project_id, key_epoch, purpose,
             account_key_generation, account_key_sequence, wrapped, created_at)
           VALUES (?, ?, 5, 'project-key', 1, 0, ?, ?)`
        )
        .run(OWNER, kept, 'C'.repeat(55), NOW)
    ).toThrow(/ACCOUNT_ERASURE_IN_PROGRESS/);
    expect(() =>
      srv.db
        .prepare(
          'UPDATE e2ee_project_groups SET epoch = epoch + 1 WHERE project_id = ?'
        )
        .run(kept)
    ).toThrow(/ACCOUNT_ERASURE_IN_PROGRESS/);
    srv.db
      .prepare('DELETE FROM account_erasure_requests WHERE user_id = ?')
      .run(OWNER);

    // A profile erasure takes the wraps and leaves, and keeps the project.
    const profile = await srv.call('POST', '/api/account/delete-data', {
      body: { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' }
    });
    expect(profile.status).toBe(200);
    expect(count(srv, 'e2ee_project_keys', kept)).toBe(0);
    expect(count(srv, 'e2ee_project_leaves', kept)).toBe(0);
    expect(count(srv, 'e2ee_project_groups', kept)).toBe(1);

    const all = await srv.call('POST', '/api/account/delete-data', {
      body: { scope: 'all', confirmation: 'DELETE ALL CLOUD DATA' }
    });
    expect(all.status).toBe(200);
    for (const table of [
      'e2ee_project_groups',
      'e2ee_mls_commits',
      'e2ee_key_archives'
    ]) {
      expect(count(srv, table, kept), table).toBe(0);
    }
  });

  it('clears the sender of Commits in projects the erased account does not own', async () => {
    const srv = newServer();
    const projectId = seedProject(srv, OTHER);
    const otherLaptop = device(srv, other, 'other_laptop');
    await createProjectGroup(otherLaptop.ctx, projectId);
    await commitProjectGroup(otherLaptop.ctx, projectId);
    // Phase 5 will let members commit; here a row stands in for one.
    srv.db
      .prepare(
        `UPDATE e2ee_mls_commits SET sender_user_id = NULL, sender_device_id = NULL WHERE project_id = ?`
      )
      .run(projectId);
    expect(() =>
      srv.db
        .prepare(
          `UPDATE e2ee_mls_commits SET message = 'x' WHERE project_id = ?`
        )
        .run(projectId)
    ).toThrow(/E2EE_COMMIT_IMMUTABLE/);
    srv.db.exec('DROP TRIGGER e2ee_mls_commit_immutable');
    srv.db
      .prepare(
        `UPDATE e2ee_mls_commits SET sender_user_id = ?, sender_device_id = 'owner_laptop' WHERE project_id = ?`
      )
      .run(OWNER, projectId);
    const erased = await srv.call('POST', '/api/account/delete-data', {
      body: { scope: 'all', confirmation: 'DELETE ALL CLOUD DATA' }
    });
    expect(erased.status).toBe(200);
    expect(
      srv.db
        .prepare(
          'SELECT sender_user_id, sender_device_id FROM e2ee_mls_commits WHERE project_id = ?'
        )
        .all(projectId)
    ).toEqual([{ sender_user_id: null, sender_device_id: null }]);
  });
});

// --- Migration 0032 --------------------------------------------------------

/** Every tracked migration before `number`, as `pnpm deploy:beta` may leave D1. */
function databaseBefore(number: number) {
  const dir = new URL('../apps/web/migrations/', import.meta.url);
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(dir)
    .filter(
      (name) =>
        name.endsWith('.sql') && Number.parseInt(name.slice(0, 4), 10) < number
    )
    .sort()) {
    db.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  return db;
}

const GROUP_TABLES =
  /e2ee_project_groups|e2ee_mls_commits|e2ee_project_leaves|e2ee_project_keys|e2ee_key_archives/;

/** The only statements allowed to name the new tables are the schema probes. */
function expectOnlyProbes(statements: string[]) {
  for (const sql of statements.filter((s) => GROUP_TABLES.test(s))) {
    expect(sql, sql).toMatch(/FROM sqlite_master/);
  }
}

/**
 * Merging deploys to the live beta, which applies migrations. If 0032 fails
 * or is delayed, ordinary traffic and erasure must not notice; only the new
 * encrypted-project routes answer 503.
 */
describe('without migration 0032', () => {
  it('keeps ordinary project traffic, purge and erasure working', async () => {
    const srv = newServer(databaseBefore(32));
    const created = await srv.call('POST', '/api/projects', {
      body: {
        name: 'Bracket',
        initialDocument: withoutDerivedProjection(
          createProjectDocument('Bracket', toUserId(OWNER))
        )
      }
    });
    expect(created.status).toBe(201);
    const { document } = (await created.json()) as {
      document: { projectId: string; version: number };
    };
    expect(
      (await srv.call('GET', `/api/projects/${document.projectId}`)).status
    ).toBe(200);
    expect(
      (
        await srv.call('PUT', `/api/projects/${document.projectId}/document`, {
          body: {
            projectId: document.projectId,
            expectedVersion: document.version,
            document: { ...document, version: document.version + 1 }
          }
        })
      ).status
    ).toBe(200);
    expect((await srv.call('GET', '/api/projects')).status).toBe(200);
    srv.db
      .prepare(
        "UPDATE projects SET status = 'deleted', deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
      )
      .run(document.projectId);
    expect((await srv.call('POST', '/api/projects/purge')).status).toBe(200);
    expect(
      srv.db
        .prepare('SELECT COUNT(*) AS n FROM projects WHERE id = ?')
        .get(document.projectId)
    ).toEqual({ n: 0 });
    seedProject(srv);
    const profile = await srv.call('POST', '/api/account/delete-data', {
      body: { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' }
    });
    expect(profile.status).toBe(200);
    const all = await srv.call('POST', '/api/account/delete-data', {
      body: { scope: 'all', confirmation: 'DELETE ALL CLOUD DATA' }
    });
    expect(all.status).toBe(200);
    expect(srv.db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({
      n: 0
    });
    expectOnlyProbes(srv.statements);
  });

  it('answers 503 on the encrypted-project routes and reports projects off', async () => {
    const srv = newServer(databaseBefore(32));
    const projectId = seedProject(srv);
    for (const [method, route] of [
      ['GET', 'mls/group-info'],
      ['POST', 'mls/group-info'],
      ['GET', 'mls/commits'],
      ['POST', 'mls/commits'],
      ['GET', 'mls/leaves'],
      ['GET', 'keys'],
      ['GET', 'keys/archives']
    ] as const) {
      const response = await srv.call(
        method,
        `/api/e2ee/projects/${projectId}/${route}`,
        {
          ...(method === 'POST' ? { body: {} } : {})
        }
      );
      expect(response.status, `${method} ${route}`).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'E2EE_UNAVAILABLE' });
    }
    expect(await (await srv.call('GET', '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: false
    });
    expectOnlyProbes(srv.statements);
  });

  it('notices the tables once the migration lands, without a redeploy', async () => {
    const db = databaseBefore(32);
    const srv = newServer(db);
    const projectId = seedProject(srv);
    expect(
      (await srv.call('GET', `/api/e2ee/projects/${projectId}/keys`)).status
    ).toBe(503);
    db.exec(
      readFileSync(
        new URL(
          '../apps/web/migrations/0032_e2ee_project_groups.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ['Date'] });
    expect(
      (await srv.call('GET', `/api/e2ee/projects/${projectId}/keys`)).status
    ).toBe(200);
  });
});

describe('migration 0032', () => {
  it('cascades with the project and never moves the sequencer backwards', () => {
    const db = migratedDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, NULL, ?)'
    ).run(OWNER, NOW);
    db.prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at, storage_format)
       VALUES ('proj_m', ?, 'n', 'x', ?, 2)`
    ).run(OWNER, NOW);
    db.prepare(
      `INSERT INTO e2ee_project_groups (project_id, group_id, generation, epoch,
         initial_group_info, group_info, group_info_epoch, updated_at)
       VALUES ('proj_m', 'grp', 0, 3, 'AA', 'AA', 3, ?)`
    ).run(NOW);
    db.prepare(
      `INSERT INTO e2ee_mls_commits (project_id, epoch, kind, sender_user_id, sender_device_id, message, created_at)
       VALUES ('proj_m', 2, 'commit', ?, 'd', 'AA', ?)`
    ).run(OWNER, NOW);
    expect(() =>
      db
        .prepare(
          `INSERT INTO e2ee_mls_commits (project_id, epoch, kind, message, created_at)
           VALUES ('proj_m', 2, 'commit', 'BB', ?)`
        )
        .run(NOW)
    ).toThrow(/UNIQUE|PRIMARY/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO e2ee_mls_commits (project_id, epoch, kind, message, created_at)
           VALUES ('proj_m', 3, 'welcome', 'BB', ?)`
        )
        .run(NOW)
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          "UPDATE e2ee_project_groups SET epoch = 2 WHERE project_id = 'proj_m'"
        )
        .run()
    ).toThrow(/E2EE_GROUP_EPOCH/);
    db.prepare("DELETE FROM projects WHERE id = 'proj_m'").run();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM e2ee_project_groups').get()
    ).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM e2ee_mls_commits').get()
    ).toEqual({ n: 0 });
  });
});
