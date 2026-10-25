/**
 * Device removal across shared encrypted projects (ADR-024 Phase 5, slice
 * 5-7; roadmap L11). Node devices of three accounts run the real
 * account-key flows (`accountKeys.ts`: set-up, recovery-key enrolment,
 * `removeDevice` with its participant step), the real project modules
 * (`projectGroups.ts`, `encryptedProjectStore.ts`, `deviceRemoval.ts`) and
 * the in-process MLS engine against the real Worker routes over SQLite.
 *
 * Alice owns the shared projects; Bob is a member with three devices; Carol
 * is a viewer. Members are seeded through MLS as in slice 5-2's tests: the
 * owner's `setRoles` Commit, the member's own wraps of that epoch handed
 * over in process (standing in for the Welcome), and an External Commit.
 * Co-members' device lists are read from the server's identity-signed
 * chains and verified, as contacts and pins (slice 5-1) supply them.
 */
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import { memberRotationFence } from '../apps/web/worker/e2eeDeviceRemoval';
import {
  EnvelopeKey,
  accountKeySequences,
  encodeEncryptedDocumentBody,
  encryptProjectEnvelope,
  epochBinding,
  fromBase64Url,
  fromHex,
  generateRecoveryKey,
  parseEnvelope,
  signProjectEnvelope,
  toBase64Url,
  toHex,
  verifyDeviceList,
  verifyRevocationCutoffs,
  versionHash,
  wrapKey,
  type ProjectEnvelopeHeaderInit,
  type SignedDeviceListEntry,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  toUserId,
  type E2eeMemberRevocationCutoffsResponse,
  type E2eeRevocationCutoffsResponse,
  type ProjectDocument
} from '@openzcad/shared';
import { inProcessMls } from '../packages/mls/src/test-support';
import {
  enrollWithRecoveryKey,
  loadEncryption,
  removeDevice,
  setUpEncryption,
  type AccountView,
  type E2eeContext,
  type EncryptionState
} from '../apps/web/src/lib/e2ee/accountKeys';
import { createE2eeApi, E2eeApiError } from '../apps/web/src/lib/e2ee/e2eeApi';
import { memoryDeviceStore } from '../apps/web/src/lib/e2ee/deviceStore';
import { unlockedAccount } from '../apps/web/src/lib/e2ee/unlockedKeys';
import {
  ProjectGroupError,
  catchUpProjectGroup,
  commitProjectGroup,
  createProjectGroupsApi,
  dedupeSecretForProject,
  epochAuthenticatorForEpoch,
  joinProjectGroup,
  memberRevocationCutoffs,
  postOwnEpochKeys,
  projectGroupAccount,
  projectKeyForEpoch,
  removeMember,
  type ProjectGroupContext
} from '../apps/web/src/lib/e2ee/projectGroups';
import {
  createRevocationCutoffsApi,
  removalParticipant,
  revocationStatements,
  type RemovalOutcome
} from '../apps/web/src/lib/e2ee/deviceRemoval';
import { MlsProjectSessions } from '../apps/web/src/lib/e2ee/mls/projectSessions';
import { createMlsLoader } from '../apps/web/src/lib/e2ee/mls/loader';
import {
  memoryMlsSessionStore,
  type MlsSessionStore
} from '../apps/web/src/lib/e2ee/mls/sessionStore';
import {
  createEncryptedProjectStore,
  EncryptedProjectIntegrityError,
  type EncryptedProjectStore
} from '../apps/web/src/lib/e2ee/encryptedProjectStore';
import { createEncryptedDocumentsApi } from '../apps/web/src/lib/e2ee/encryptedDocumentsApi';
import {
  memoryVersionPins,
  type VersionPinStore
} from '../apps/web/src/lib/e2ee/versionPins';
import { createBlobReferenceRegistry } from '../apps/web/src/lib/e2ee/blobReferences';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const ALICE = 'user_alice';
const BOB = 'user_bob';
const CAROL = 'user_carol';
const NOW = '2026-10-24T00:00:00.000Z';

afterEach(() => {
  forgetAllProjectKeys();
});

// --- Server ----------------------------------------------------------------

interface Server {
  db: DatabaseSync;
  env: Record<string, unknown>;
  call(
    method: string,
    path: string,
    options: { user: string; body?: unknown }
  ): Promise<Response>;
}

function newServer(): Server {
  const db = migratedDatabase();
  for (const user of [ALICE, BOB, CAROL]) {
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(user, `${user}@example.com`, NOW);
  }
  const objects = new Map<string, ArrayBuffer>();
  const bucket = {
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
  const env: Record<string, unknown> = {
    ENVIRONMENT: 'development',
    AUTH_MODE: 'development',
    DB: sqliteD1(db),
    PROJECT_STORAGE: bucket,
    ARTIFACTS: bucket,
    PROJECT_SHARING_ENABLED: 'true',
    PROJECT_PERSONAL_SYNC_ENABLED: 'true',
    PROJECT_ROOM: {
      getByName: vi.fn(() => ({
        fetch: async () => new Response('{"ok":true}', { status: 200 })
      }))
    },
    E2EE_KEYS_ENABLED: 'true',
    E2EE_PROJECTS_ENABLED: 'true'
  };
  return {
    db,
    env,
    call: (method, path, options) =>
      worker.fetch(
        new Request(`https://example.com${path}`, {
          method,
          headers: {
            'x-openzcad-development-user': options.user,
            ...(options.body === undefined
              ? {}
              : { 'content-type': 'application/json' })
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) })
        }),
        env
      )
  };
}

/**
 * The co-members' device lists, as contacts and pins supply them: every
 * other account with a leaf in the project, its identity-signed chain read
 * from the server and verified.
 */
async function coMemberLists(
  srv: Server,
  own: string,
  projectId: string
): Promise<VerifiedDeviceList[]> {
  const users = srv.db
    .prepare(
      `SELECT DISTINCT user_id FROM e2ee_project_leaves
       WHERE project_id = ? AND user_id <> ? ORDER BY user_id`
    )
    .all(projectId, own) as { user_id: string }[];
  const lists: VerifiedDeviceList[] = [];
  for (const { user_id: userId } of users) {
    const identity = srv.db
      .prepare(
        `SELECT generation, identity_key FROM e2ee_identities
         WHERE user_id = ? ORDER BY generation DESC LIMIT 1`
      )
      .get(userId) as { generation: number; identity_key: string };
    const chain = (
      srv.db
        .prepare(
          `SELECT entry, signature FROM e2ee_device_list_entries
           WHERE user_id = ? AND generation = ? ORDER BY sequence`
        )
        .all(userId, identity.generation) as {
        entry: string;
        signature: string;
      }[]
    ).map((row): SignedDeviceListEntry => ({
      entry: fromBase64Url(row.entry),
      signature: fromBase64Url(row.signature)
    }));
    lists.push(
      await verifyDeviceList(fromBase64Url(identity.identity_key), chain)
    );
  }
  return lists;
}

// --- Devices ---------------------------------------------------------------

interface Device {
  userId: string;
  label: string;
  srv: Server;
  e2ee: E2eeContext;
  account: AccountView;
  sessions: MlsProjectSessions;
  mls: MlsSessionStore;
  pins: VersionPinStore;
  offline: boolean;
  /** Runs after each answered request. */
  after?: (path: string, init: RequestInit) => void;
  fetcher(path: string, init?: RequestInit): Promise<Response>;
  groups: ProjectGroupContext;
  store: EncryptedProjectStore;
}

function ready(state: EncryptionState): AccountView {
  if (state.kind !== 'ready')
    throw new Error(`Expected ready, got ${state.kind}`);
  return state.account;
}

function newDevice(srv: Server, userId: string, label: string): Device {
  const mls = memoryMlsSessionStore();
  const d = {
    userId,
    label,
    srv,
    mls,
    sessions: new MlsProjectSessions(
      mls,
      createMlsLoader(async () => inProcessMls())
    ),
    pins: memoryVersionPins(),
    offline: false
  } as Device;
  d.fetcher = async (path: string, init: RequestInit = {}) => {
    if (d.offline) throw new TypeError('Failed to fetch (offline)');
    const response = await worker.fetch(
      new Request(`https://example.com${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          'x-openzcad-development-user': userId
        }
      }),
      srv.env
    );
    d.after?.(path, init);
    return response;
  };
  d.e2ee = {
    userId,
    api: createE2eeApi((path, init) => d.fetcher(path, init)),
    store: memoryDeviceStore(),
    now: () => 1_760_000_000_000
  };
  return d;
}

function groupsFor(d: Device, account: AccountView): ProjectGroupContext {
  const fetcher = (path: string, init?: RequestInit) => d.fetcher(path, init);
  return {
    api: createProjectGroupsApi(fetcher),
    sessions: d.sessions,
    account: projectGroupAccount(d.e2ee, account),
    device:
      account.deviceStatus === 'certified' && account.device
        ? {
            userId: account.userId,
            deviceId: account.device.deviceId,
            signing: account.device.signing
          }
        : null,
    revocations: revocationStatements(createRevocationCutoffsApi(fetcher), {
      list: account.list,
      generation: account.generation
    }),
    members: {
      lists: (projectId) => coMemberLists(d.srv, account.userId, projectId)
    }
  };
}

function use(d: Device, account: AccountView): Device {
  d.account = account;
  d.groups = groupsFor(d, account);
  d.store = createEncryptedProjectStore({
    groups: d.groups,
    api: createEncryptedDocumentsApi((path, init) => d.fetcher(path, init)),
    blobReferences: createBlobReferenceRegistry(),
    pins: d.pins
  });
  return d;
}

async function refresh(d: Device): Promise<Device> {
  return use(d, ready(await loadEncryption(d.e2ee)));
}

/** A new browser of the same device (fresh MLS state and pins). */
function freshBrowser(d: Device): Promise<Device> {
  const copy = newDevice(d.srv, d.userId, `${d.label} (fresh)`);
  copy.e2ee = { ...d.e2ee, api: copy.e2ee.api };
  return refresh(copy);
}

async function setUp(srv: Server, userId: string) {
  const recovery = await generateRecoveryKey();
  const laptop = newDevice(srv, userId, 'Laptop');
  use(
    laptop,
    ready(
      await setUpEncryption(laptop.e2ee, {
        recoverySecret: recovery.secret,
        label: 'Laptop'
      })
    )
  );
  return { recovery: recovery.secret, laptop };
}

async function enroll(
  srv: Server,
  userId: string,
  recovery: Uint8Array,
  label: string
): Promise<Device> {
  const d = newDevice(srv, userId, label);
  const fresh = ready(await loadEncryption(d.e2ee));
  return use(
    d,
    ready(await enrollWithRecoveryKey(d.e2ee, fresh, recovery, label))
  );
}

const deviceIdOf = (d: Device) => d.account.device!.deviceId;
const refOf = (d: Device, projectId: string) => ({
  userId: d.userId,
  deviceId: deviceIdOf(d),
  projectId
});

async function createEncrypted(d: Device, name: string): Promise<string> {
  const { document } = await d.store.createProject({
    name,
    initialDocument: withoutDerivedProjection(
      createProjectDocument(name, toUserId(d.userId))
    )
  });
  return document.projectId;
}

async function saveEdit(d: Device, projectId: string, name: string) {
  const current = await d.store.loadProject(projectId);
  await d.store.saveProjectDocument({
    projectId: current.projectId,
    expectedVersion: current.version,
    document: { ...current, name, version: current.version + 1 }
  });
}

type Role = 'editor' | 'viewer';

/**
 * The owner shares a project with `member` in `role`: the server's row, the
 * owner's `setRoles` Commit, the member's own wraps of that epoch (the
 * Welcome's stand-in) and the member's External Commit.
 */
async function share(
  owner: Device,
  projectId: string,
  member: Device,
  role: Role
) {
  owner.srv.db
    .prepare(
      `INSERT INTO project_members
         (project_id, user_id, role, added_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1)`
    )
    .run(projectId, member.userId, role, owner.userId);
  const state = await commitProjectGroup(owner.groups, projectId, {
    setRoles: [{ userId: member.userId, role }]
  });
  await postOwnEpochKeys(
    member.groups,
    projectId,
    state.keyEpoch,
    await owner.sessions.epochMaterial(refOf(owner, projectId))
  );
  forgetAllProjectKeys();
  await joinProjectGroup(member.groups, projectId);
}

function groupRow(srv: Server, projectId: string) {
  return srv.db
    .prepare(
      'SELECT key_epoch_base, epoch FROM e2ee_project_groups WHERE project_id = ?'
    )
    .get(projectId) as { key_epoch_base: number; epoch: number };
}

const keyEpochOf = (srv: Server, projectId: string) => {
  const row = groupRow(srv, projectId);
  return row.key_epoch_base + row.epoch;
};

function headRow(srv: Server, projectId: string) {
  return srv.db
    .prepare(
      `SELECT document_version, version_hash, signer_user_id, signer_device_id
       FROM e2ee_project_versions WHERE project_id = ?
       ORDER BY document_version DESC LIMIT 1`
    )
    .get(projectId) as {
    document_version: number;
    version_hash: string;
    signer_user_id: string;
    signer_device_id: string;
  };
}

function wrapSequences(
  srv: Server,
  projectId: string,
  userId: string,
  keyEpoch: number
): number[] {
  return (
    srv.db
      .prepare(
        `SELECT account_key_sequence FROM e2ee_project_keys
         WHERE project_id = ? AND user_id = ? AND key_epoch = ?
         ORDER BY purpose`
      )
      .all(projectId, userId, keyEpoch) as { account_key_sequence: number }[]
  ).map((row) => row.account_key_sequence);
}

/** The participant, keeping the outcome for tests. */
function participantFor(d: Device) {
  const seen: { outcome: RemovalOutcome | null } = { outcome: null };
  const participant = removalParticipant({
    api: createRevocationCutoffsApi((path, init) => d.fetcher(path, init)),
    groups: (account) => groupsFor(d, account),
    pins: d.pins,
    onOutcome: (outcome) => {
      seen.outcome = outcome;
    }
  });
  return { participant, seen };
}

/** Offline right after the first Commit this device sends lands. */
function offlineAfterFirstCommit(d: Device) {
  d.after = (path, init) => {
    if (init.method === 'POST' && path.endsWith('/mls/commits')) {
      d.offline = true;
    }
  };
}

function online(d: Device) {
  d.offline = false;
  d.after = undefined;
}

/**
 * What a stolen device holds: its view of its own device list from before
 * the removal and the account key of that time, never a newer one.
 */
function stolenGroups(d: Device): ProjectGroupContext {
  const list = d.account.list;
  const key = new Uint8Array(unlockedAccount(d.userId)!.accountKey);
  const keySequence = accountKeySequences(list).at(-1)!;
  return {
    api: createProjectGroupsApi((path, init) => d.fetcher(path, init)),
    sessions: d.sessions,
    account: {
      userId: d.userId,
      list,
      generation: 1,
      currentAccountKey: async () => ({
        key: new Uint8Array(key),
        generation: 1,
        keySequence
      }),
      openAccountKey: async () => {
        throw new Error('A stolen device has no newer account key.');
      }
    },
    device: d.groups.device,
    members: d.groups.members
  };
}

async function integrityRefusal(
  promise: Promise<unknown>,
  reason: EncryptedProjectIntegrityError['reason']
) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof EncryptedProjectIntegrityError && error.reason === reason
  );
}

const groupRefusal = (code: ProjectGroupError['code']) => (error: unknown) =>
  error instanceof ProjectGroupError && error.code === code;

/**
 * A version the stolen device signs after its removal, under the last key
 * epoch it knew, chained onto `head`, which a compromised server stores.
 */
async function forgeVersion(
  srv: Server,
  stolen: ProjectGroupContext,
  phone: Device,
  projectId: string,
  keyEpoch: number,
  base: ProjectDocument
) {
  const head = headRow(srv, projectId);
  forgetAllProjectKeys();
  const projectKey = await projectKeyForEpoch(stolen, projectId, keyEpoch);
  const authenticator = await epochAuthenticatorForEpoch(
    stolen,
    projectId,
    keyEpoch
  );
  forgetAllProjectKeys();
  const header: ProjectEnvelopeHeaderInit = {
    kind: 'document',
    projectId,
    documentVersion: head.document_version + 1,
    previousVersionHash: fromHex(head.version_hash),
    epochBindingHash: await epochBinding(projectId, keyEpoch, authenticator),
    schemaVersion: 1,
    keyEpoch
  };
  const versionKey = EnvelopeKey.generate();
  const envelope = await encryptProjectEnvelope(
    versionKey,
    header,
    encodeEncryptedDocumentBody(
      {
        document: {
          ...(base as unknown as Record<string, unknown>),
          name: 'Forged after removal',
          version: header.documentVersion
        },
        blobs: [],
        revisionVersionHashes: new Map()
      },
      header
    )
  );
  const hash = toHex(await versionHash(envelope));
  srv.db
    .prepare(
      `INSERT INTO e2ee_project_versions
         (project_id, document_version, version_hash, key_epoch, prefix, signature,
          signer_user_id, signer_device_id, envelope_key, envelope_inline,
          envelope_bytes, wrapped_version_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
    )
    .run(
      projectId,
      header.documentVersion,
      hash,
      keyEpoch,
      toBase64Url(parseEnvelope(envelope).prefix),
      toBase64Url(
        await signProjectEnvelope(
          phone.account.device!.signing.privateKey,
          envelope
        )
      ),
      phone.userId,
      deviceIdOf(phone),
      toBase64Url(envelope),
      envelope.byteLength,
      toBase64Url(
        await wrapKey(projectKey, versionKey.bytes, {
          purpose: 'version-key',
          projectId,
          keyEpoch,
          kind: 'document',
          versionId: hash
        })
      ),
      NOW
    );
  srv.db
    .prepare('UPDATE projects SET document_version = ? WHERE id = ?')
    .run(header.documentVersion, projectId);
}

/** Alice; Bob with a laptop, a desktop and a phone; Carol. */
async function people() {
  const srv = newServer();
  const alice = await setUp(srv, ALICE);
  const bob = await setUp(srv, BOB);
  const bobDesktop = await enroll(srv, BOB, bob.recovery, 'Desktop');
  const bobPhone = await enroll(srv, BOB, bob.recovery, 'Phone');
  await refresh(bob.laptop);
  await refresh(bobDesktop);
  await refresh(bobPhone);
  const carol = await setUp(srv, CAROL);
  return {
    srv,
    alice: alice.laptop,
    bob: bob.laptop,
    bobRecovery: bob.recovery,
    bobDesktop,
    bobPhone,
    carol: carol.laptop
  };
}

// --- Removal from shared projects ---------------------------------------------

describe('device removal across shared encrypted projects (slice 5-7)', () => {
  it('carries a removal’s rotation in every Commit, a member removal included (#908 review)', async () => {
    const { alice, bob, bobRecovery, bobPhone } = await people();
    // Bob's project, shared with Alice; his phone holds a leaf in it.
    const projectId = await createEncrypted(bob, 'Owned and shared');
    await share(bob, projectId, alice, 'viewer');
    await joinProjectGroup(alice.groups, projectId);
    // Bob's laptop posts his keys of the epoch Alice's join made.
    await catchUpProjectGroup(bob.groups, projectId);
    await joinProjectGroup(bobPhone.groups, projectId);
    await catchUpProjectGroup(bob.groups, projectId);
    await catchUpProjectGroup(alice.groups, projectId);
    const phoneId = deviceIdOf(bobPhone);
    // The removal goes offline right after the device list is written,
    // before it rotates anything.
    bob.after = (path, init) => {
      if (init.method === 'POST' && path.endsWith('/device-list')) {
        bob.offline = true;
      }
    };
    await removeDevice(bob.e2ee, bob.account, phoneId, bobRecovery).catch(
      () => undefined
    );
    online(bob);
    await refresh(bob);
    const membersOf = async () =>
      (await bob.sessions.status(refOf(bob, projectId))).members;
    await catchUpProjectGroup(bob.groups, projectId);
    expect((await membersOf()).map((m) => m.deviceId)).toContain(phoneId);

    // The owner's next Commit is a member removal: it removes the phone's
    // leaf too, so the Worker may count it as the rotation.
    await removeMember(bob.groups, projectId, ALICE);
    const after = await membersOf();
    expect(after.map((m) => m.deviceId)).not.toContain(phoneId);
    expect(after.some((m) => m.userId === ALICE)).toBe(false);
  });

  it('refuses a Commit built from a device list read before a removal on another device, so it cannot stand in for the rotation (#908 review)', async () => {
    const { srv, alice, bob, bobRecovery, bobDesktop, bobPhone } =
      await people();
    // Alice's project, shared with Bob as an editor; his desktop and phone
    // hold leaves in it.
    const projectId = await createEncrypted(alice, 'Shared');
    await share(alice, projectId, bob, 'editor');
    await joinProjectGroup(bobDesktop.groups, projectId);
    await joinProjectGroup(bobPhone.groups, projectId);
    await catchUpProjectGroup(alice.groups, projectId);
    await catchUpProjectGroup(bob.groups, projectId);
    await catchUpProjectGroup(bobDesktop.groups, projectId);
    const phoneId = deviceIdOf(bobPhone);
    const cutoffEpoch = keyEpochOf(srv, projectId) + 1;
    const staleHead = bobDesktop.account.list.head.sequence;
    const head = () =>
      (
        srv.db
          .prepare(
            `SELECT MAX(sequence) AS head FROM e2ee_device_list_entries
             WHERE user_id = ? AND generation = 1`
          )
          .get(BOB) as { head: number }
      ).head;
    expect(head()).toBe(staleHead);
    const staleKey = new Uint8Array(unlockedAccount(BOB)!.accountKey);
    const staleKeySequence = accountKeySequences(bobDesktop.account.list).at(
      -1
    )!;

    // The laptop removes the phone and stores its cutoff, then goes
    // offline before rotating anything. The desktop's page still holds the
    // account view it loaded before, which lists the phone.
    bob.after = (path, init) => {
      if (init.method === 'PUT' && path.endsWith('/revocation-cutoffs')) {
        bob.offline = true;
      }
    };
    const { participant } = participantFor(bob);
    await removeDevice(
      bob.e2ee,
      bob.account,
      phoneId,
      bobRecovery,
      participant
    ).catch(() => undefined);
    online(bob);
    expect(head()).toBe(staleHead + 1);
    const fence = () =>
      memberRotationFence(srv.env.DB as D1Database, projectId, cutoffEpoch);
    await expect(fence()).rejects.toMatchObject({
      code: 'E2EE_MEMBER_ROTATION_PENDING'
    });

    // The desktop's Commit from that view removes nothing: its list revokes
    // no device. Landing in the cutoff's epoch, it would count as Bob's
    // rotation while the phone's leaf learns the new key. The Worker
    // refuses it: the device list it states is not the account's any more.
    // (Its page keeps the account key it unlocked; this process shares
    // one unlocked copy per account, which the laptop's removal replaced.)
    // The page hears the refusal, to reload its account view.
    const reload = vi.fn();
    const stale: ProjectGroupContext = {
      ...bobDesktop.groups,
      account: {
        ...bobDesktop.groups.account,
        currentAccountKey: async () => ({
          key: new Uint8Array(staleKey),
          generation: 1,
          keySequence: staleKeySequence
        })
      },
      onDeviceListChanged: reload
    };
    const submit = vi.spyOn(stale.api, 'submitCommit');
    await expect(commitProjectGroup(stale, projectId)).rejects.toMatchObject({
      status: 409,
      code: 'E2EE_DEVICE_LIST_CHANGED'
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls.at(-1)![1].deviceList).toEqual({
      generation: 1,
      headSequence: staleHead
    });
    expect(keyEpochOf(srv, projectId)).toBe(cutoffEpoch - 1);
    await expect(fence()).rejects.toMatchObject({
      code: 'E2EE_MEMBER_ROTATION_PENDING'
    });
    // The refused Commit was dropped, not left to be sent again: the stale
    // view still catches up and reads.
    expect(
      await bobDesktop.sessions.pendingCommit(refOf(bobDesktop, projectId))
    ).toBeNull();
    await catchUpProjectGroup(stale, projectId);
    // On the wire, whatever the rest of the request holds.
    const wire = await srv.call(
      'POST',
      `/api/e2ee/projects/${projectId}/mls/commits`,
      {
        user: BOB,
        body: {
          epoch: groupRow(srv, projectId).epoch,
          kind: 'commit',
          deviceId: deviceIdOf(bobDesktop),
          message: 'AAAA',
          groupInfo: 'AAAA',
          wraps: [],
          archive: {},
          deviceList: { generation: 1, headSequence: staleHead }
        }
      }
    );
    expect(wire.status).toBe(409);
    expect(await wire.json()).toMatchObject({
      code: 'E2EE_DEVICE_LIST_CHANGED'
    });

    // Reloaded, the desktop's next Commit removes the phone's leaf and
    // states the current head, which the Worker accepts as the rotation.
    await refresh(bobDesktop);
    const accepted = vi.spyOn(bobDesktop.groups.api, 'submitCommit');
    await commitProjectGroup(bobDesktop.groups, projectId);
    expect(accepted.mock.calls.at(-1)![1].deviceList).toEqual({
      generation: 1,
      headSequence: head()
    });
    expect(keyEpochOf(srv, projectId)).toBe(cutoffEpoch);
    await expect(fence()).resolves.toBeTruthy();
    const members = (
      await bobDesktop.sessions.status(refOf(bobDesktop, projectId))
    ).members.map((m) => m.deviceId);
    expect(members).not.toContain(phoneId);
    expect(members).toContain(deviceIdOf(bobDesktop));
  });

  it('lets a member remove a stolen device: co-members refuse its later Commits and versions and still read its earlier ones', async () => {
    const { srv, alice, bob, bobRecovery, bobDesktop, bobPhone, carol } =
      await people();
    const projects = [
      await createEncrypted(alice, 'Bracket'),
      await createEncrypted(alice, 'Hinge')
    ].sort();
    const [rotatedId, pendingId] = projects as [string, string];
    for (const projectId of projects) {
      await share(alice, projectId, bob, 'editor');
      await share(alice, projectId, carol, 'viewer');
      // Carol's browser is not seen again until after the removal. Bob's
      // laptop processes her Commits, posting Bob's wraps of their epochs.
      await catchUpProjectGroup(bob.groups, projectId);
      await saveEdit(bobDesktop, projectId, 'Desktop edit');
      await saveEdit(bobPhone, projectId, 'Phone edit');
      // The owner is up to date and has accepted the phone's version.
      expect((await alice.store.loadProject(projectId)).name).toBe(
        'Phone edit'
      );
    }
    const phoneId = deviceIdOf(bobPhone);
    const predicted = new Map(
      projects.map((id) => [id, keyEpochOf(srv, id) + 1])
    );
    const cutoffHead = headRow(srv, rotatedId);
    expect(cutoffHead.signer_device_id).toBe(phoneId);

    // The phone is stolen: what it holds is frozen here.
    await catchUpProjectGroup(bobPhone.groups, pendingId);
    const stolen = stolenGroups(bobPhone);
    const oldKeySequence = accountKeySequences(bob.account.list).at(-1)!;

    // Bob's laptop removes it. The listing names both shared projects.
    const listed = (await (
      await srv.call('GET', '/api/e2ee/revocation-cutoffs', { user: BOB })
    ).json()) as E2eeRevocationCutoffsResponse;
    expect(listed.projects.map((p) => [p.projectId, p.member])).toEqual(
      projects.map((id) => [id, true])
    );
    // The removal rotates the first project, then goes offline.
    offlineAfterFirstCommit(bob);
    const { participant, seen } = participantFor(bob);
    use(
      bob,
      ready(
        await removeDevice(
          bob.e2ee,
          bob.account,
          phoneId,
          bobRecovery,
          participant
        )
      )
    );
    online(bob);
    expect(seen.outcome).toMatchObject({
      rotated: [rotatedId],
      cutoffsStored: true
    });
    expect(seen.outcome!.left.map((l) => l.projectId)).toEqual([pendingId]);
    const newKeySequence = accountKeySequences(bob.account.list).at(-1)!;
    expect(newKeySequence).toBeGreaterThan(oldKeySequence);

    // One identity-signed statement naming both shared projects, which the
    // other members (the owner included) read from the project's route.
    for (const reader of [ALICE, CAROL]) {
      const response = await srv.call(
        'GET',
        `/api/e2ee/projects/${rotatedId}/revocation-cutoffs`,
        { user: reader }
      );
      expect(response.status).toBe(200);
      const { statements } =
        (await response.json()) as E2eeMemberRevocationCutoffsResponse;
      expect(statements.map((s) => s.userId)).toEqual([BOB]);
      const statement = await verifyRevocationCutoffs(
        {
          statement: fromBase64Url(statements[0]!.statement),
          signature: fromBase64Url(statements[0]!.signature)
        },
        bob.account.list,
        { generation: 1 }
      );
      for (const projectId of projects) {
        const cutoff = statement.cutoffs.find(
          (c) => c.projectId === projectId
        )!;
        expect(cutoff.cutoffEpoch).toBe(predicted.get(projectId));
        expect(cutoff.head?.documentVersion).toBe(
          headRow(srv, projectId).document_version
        );
      }
    }

    // The rotation: a Remove of the phone's leaf, which Bob (a member, not
    // the owner) may commit for his own identity, with Bob's new-epoch
    // wraps under his new account key.
    expect(keyEpochOf(srv, rotatedId)).toBe(predicted.get(rotatedId));
    expect(
      wrapSequences(srv, rotatedId, BOB, predicted.get(rotatedId)!)
    ).toEqual([newKeySequence, newKeySequence]);
    // The owner's browser processes it, with Bob's signed cutoff, and posts
    // its own wraps of the new epoch.
    await catchUpProjectGroup(alice.groups, rotatedId);
    const aliceStatus = await alice.sessions.status(refOf(alice, rotatedId));
    expect(aliceStatus.members.map((m) => m.deviceId)).not.toContain(phoneId);
    expect(
      wrapSequences(srv, rotatedId, ALICE, predicted.get(rotatedId)!)
    ).toHaveLength(2);
    const aliceCutoff = (await memberRevocationCutoffs(alice.groups, rotatedId))
      .get(BOB)!
      .get(phoneId)!;
    expect(aliceCutoff).toMatchObject({
      keyEpoch: predicted.get(rotatedId),
      signed: true
    });

    // The phone's earlier version, the head, stays readable: for the owner's
    // browser, a fresh one, and Carol's, which was behind the phone's own
    // Commits and rejoins from the key archives rather than stopping.
    expect((await alice.store.loadProject(rotatedId)).name).toBe('Phone edit');
    forgetAllProjectKeys();
    const aliceFresh = await freshBrowser(alice);
    expect((await aliceFresh.store.loadProject(rotatedId)).name).toBe(
      'Phone edit'
    );
    forgetAllProjectKeys();
    await joinProjectGroup(carol.groups, rotatedId);
    expect((await carol.store.loadProject(rotatedId)).name).toBe('Phone edit');

    // A write never takes "Bob's cutoffs could not be read" for "Bob has
    // none" (#906 review): a cutoff it cannot see may name a later epoch.
    // The head is read first; only the write's own check meets the failure.
    const current = await alice.store.loadProject(rotatedId);
    const unreadable = vi
      .spyOn(alice.groups.api, 'memberCutoffs')
      .mockRejectedValue(new E2eeApiError(503, 'Try again.'));
    const refused = await alice.store
      .saveProjectDocument({
        projectId: current.projectId,
        expectedVersion: current.version,
        document: {
          ...current,
          name: 'Owner edit',
          version: current.version + 1
        }
      })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(refused).toMatchObject({ status: 503 });
    unreadable.mockRestore();
    expect(headRow(srv, rotatedId).signer_device_id).toBe(phoneId);

    // In the project the removal has not rotated yet, the phone's leaf still
    // learns every epoch: the owner reads but writes nothing until one of
    // Bob's devices rotates it.
    await expect(
      saveEdit(alice, pendingId, 'Owner edit')
    ).rejects.toMatchObject({ code: 'E2EE_MEMBER_ROTATION_PENDING' });

    // The Worker refuses it on its own (#906 review): a browser whose check
    // ran before Bob's cutoff was stored, here one that sees neither the
    // phone's leaf nor the cutoff, still cannot land a version under the
    // key the phone holds.
    const headBefore = headRow(srv, pendingId).version_hash;
    const loaded = await alice.store.loadProject(pendingId);
    const realStatus = alice.sessions.status.bind(alice.sessions);
    const blindStatus = vi
      .spyOn(alice.sessions, 'status')
      .mockImplementation(async (ref) => {
        const status = await realStatus(ref);
        return {
          ...status,
          members: status.members.filter((m) => m.deviceId !== phoneId)
        };
      });
    const blindCutoffs = vi
      .spyOn(alice.groups.api, 'memberCutoffs')
      .mockResolvedValue({ statements: [] });
    await expect(
      alice.store.saveProjectDocument({
        projectId: loaded.projectId,
        expectedVersion: loaded.version,
        document: { ...loaded, name: 'Owner edit', version: loaded.version + 1 }
      })
    ).rejects.toMatchObject({
      status: 409,
      code: 'E2EE_MEMBER_ROTATION_PENDING'
    });
    expect(blindCutoffs).toHaveBeenCalled();
    blindStatus.mockRestore();
    blindCutoffs.mockRestore();
    expect(headRow(srv, pendingId).version_hash).toBe(headBefore);

    // Reaching the cutoff's epoch is not the rotation (#906 review): if an
    // unrelated Commit by someone else takes that epoch, the phone's leaf
    // is still in the group and learns its key, so the Worker refuses a
    // write there until a Commit of Bob's lands.
    await expect(
      memberRotationFence(
        srv.env.DB as D1Database,
        pendingId,
        predicted.get(pendingId)!
      )
    ).rejects.toMatchObject({ code: 'E2EE_MEMBER_ROTATION_PENDING' });

    // Nor is an External Commit of Bob's by a device the revocation does not
    // name as replacement: a rejoin removes its own stale leaf, not the
    // phone's (#908 review). A member Commit of Bob's is the rotation.
    const nextEpoch = groupRow(srv, pendingId).epoch;
    const bobCommit = (kind: 'commit' | 'external', deviceId: string) =>
      srv.db
        .prepare(
          `INSERT INTO e2ee_mls_commits
             (project_id, epoch, kind, sender_user_id, sender_device_id,
              message, created_at)
           VALUES (?, ?, ?, ?, ?, 'AA', '2026-10-25')`
        )
        .run(pendingId, nextEpoch, kind, BOB, deviceId);
    const clearBobCommit = () =>
      srv.db
        .prepare(
          'DELETE FROM e2ee_mls_commits WHERE project_id = ? AND epoch = ?'
        )
        .run(pendingId, nextEpoch);
    // Not even by the device the revocation names as replacement: the
    // Worker cannot see which leaf an External Commit removed.
    bobCommit('external', deviceIdOf(bob));
    await expect(
      memberRotationFence(
        srv.env.DB as D1Database,
        pendingId,
        predicted.get(pendingId)!
      )
    ).rejects.toMatchObject({ code: 'E2EE_MEMBER_ROTATION_PENDING' });
    clearBobCommit();
    bobCommit('external', 'bob_tablet');
    await expect(
      memberRotationFence(
        srv.env.DB as D1Database,
        pendingId,
        predicted.get(pendingId)!
      )
    ).rejects.toMatchObject({ code: 'E2EE_MEMBER_ROTATION_PENDING' });
    clearBobCommit();
    bobCommit('commit', 'bob_tablet');
    await expect(
      memberRotationFence(
        srv.env.DB as D1Database,
        pendingId,
        predicted.get(pendingId)!
      )
    ).resolves.toBeTruthy();
    clearBobCommit();

    // The fence the Worker puts in the write's batch holds only while the
    // cutoffs it read are the ones stored: one stored between its read and
    // the batch makes the batch change nothing.
    const fence = await memberRotationFence(
      srv.env.DB as D1Database,
      rotatedId,
      keyEpochOf(srv, rotatedId)
    );
    const holds = () =>
      (
        srv.db
          .prepare(`SELECT ${fence.sql} AS ok`)
          .get(...(fence.binds as never[])) as { ok: number }
      ).ok;
    expect(holds()).toBe(1);
    // A replacement within the same millisecond keeps updated_at but not the
    // signature (#906 review).
    const signatures = srv.db
      .prepare(
        `SELECT entry_sequence, signature FROM e2ee_revocation_cutoffs
         WHERE user_id = ?`
      )
      .all(BOB) as { entry_sequence: number; signature: string }[];
    const setSignature = srv.db.prepare(
      `UPDATE e2ee_revocation_cutoffs SET signature = ?
       WHERE user_id = ? AND entry_sequence = ?`
    );
    for (const row of signatures) {
      setSignature.run('A'.repeat(87), BOB, row.entry_sequence);
    }
    expect(holds()).toBe(0);
    for (const row of signatures) {
      setSignature.run(row.signature, BOB, row.entry_sequence);
    }
    expect(holds()).toBe(1);

    // Its later Commit there: the Worker refuses it outright...
    const pending = await stolen.sessions.commit(refOf(bobPhone, pendingId), {
      lists: [
        stolen.account.list,
        ...(await coMemberLists(srv, BOB, pendingId))
      ],
      certifications: (await stolen.api.leaves(pendingId)).leaves.map(
        (leaf) => ({
          userId: leaf.userId,
          deviceId: leaf.deviceId,
          leafKey: fromBase64Url(leaf.leafKey),
          certification: fromBase64Url(leaf.certification)
        })
      )
    });
    const epoch = groupRow(srv, pendingId).epoch;
    const submitted = await srv.call(
      'POST',
      `/api/e2ee/projects/${pendingId}/mls/commits`,
      {
        user: BOB,
        body: {
          epoch,
          kind: 'commit',
          deviceId: phoneId,
          message: toBase64Url(pending.commit),
          groupInfo: toBase64Url(pending.commit),
          wraps: [],
          archive: {}
        }
      }
    );
    expect(submitted.status).toBe(403);
    // ...and served anyway by a compromised server, the owner's directory
    // refuses a Commit Bob's removed device signed after its removal.
    srv.db
      .prepare(
        `INSERT INTO e2ee_mls_commits
           (project_id, epoch, kind, sender_user_id, sender_device_id, message, created_at)
         VALUES (?, ?, 'commit', ?, ?, ?, ?)`
      )
      .run(pendingId, epoch, BOB, phoneId, toBase64Url(pending.commit), NOW);
    srv.db
      .prepare(
        'UPDATE e2ee_project_groups SET epoch = epoch + 1 WHERE project_id = ?'
      )
      .run(pendingId);
    await expect(joinProjectGroup(alice.groups, pendingId)).rejects.toSatisfy(
      groupRefusal('removed-device')
    );

    // Its later version in the rotated project, under the last key epoch it
    // knew and chained onto the head it last saw: the owner's pinned and
    // fresh browsers and Carol's all refuse it.
    await forgeVersion(
      srv,
      stolen,
      bobPhone,
      rotatedId,
      predicted.get(rotatedId)! - 1,
      await alice.store.loadProject(rotatedId)
    );
    expect(headRow(srv, rotatedId).signer_device_id).toBe(phoneId);
    await integrityRefusal(alice.store.loadProject(rotatedId), 'author');
    forgetAllProjectKeys();
    await integrityRefusal(
      (await freshBrowser(alice)).store.loadProject(rotatedId),
      'author'
    );
    forgetAllProjectKeys();
    await integrityRefusal(carol.store.loadProject(rotatedId), 'author');
  });

  it('lets another of the member’s devices finish a removal that went offline part-way, in owned and shared projects', async () => {
    const { srv, alice, bob, bobRecovery, bobDesktop, bobPhone } =
      await people();
    // Alice's project, shared with Bob as a viewer; Bob's own project.
    const sharedId = await createEncrypted(alice, 'Shared');
    await share(alice, sharedId, bob, 'viewer');
    const ownedId = await createEncrypted(bob, 'Owned');
    for (const d of [bobDesktop, bobPhone]) {
      await joinProjectGroup(d.groups, sharedId);
      await saveEdit(d, ownedId, `${d.label} edit`);
    }
    // Everyone has processed the phone's Commits: a device behind a removed
    // device's Commit can only rejoin, with a rejoin PSK from after the
    // rotation (slice 4-10).
    await catchUpProjectGroup(alice.groups, sharedId);
    for (const projectId of [sharedId, ownedId]) {
      await catchUpProjectGroup(bob.groups, projectId);
      await catchUpProjectGroup(bobDesktop.groups, projectId);
    }
    const projects = [sharedId, ownedId].sort();
    const predicted = new Map(
      projects.map((id) => [id, keyEpochOf(srv, id) + 1])
    );
    const dedupe = new Map<string, string>();
    for (const projectId of projects) {
      dedupe.set(
        projectId,
        toHex((await dedupeSecretForProject(bob.groups, projectId)).secret)
      );
    }
    const phoneId = deviceIdOf(bobPhone);

    offlineAfterFirstCommit(bob);
    const { participant, seen } = participantFor(bob);
    await removeDevice(
      bob.e2ee,
      bob.account,
      phoneId,
      bobRecovery,
      participant
    );
    online(bob);
    expect(seen.outcome!.cutoffsStored).toBe(true);
    expect(seen.outcome!.rotated).toEqual([projects[0]]);
    const leftId = projects[1]!;
    expect(seen.outcome!.left.map((l) => l.projectId)).toEqual([leftId]);
    expect(keyEpochOf(srv, leftId)).toBe(predicted.get(leftId)! - 1);
    // The statement names the owned and the shared project alike.
    const { statements } = (await (
      await srv.call('GET', '/api/e2ee/revocation-cutoffs', { user: BOB })
    ).json()) as E2eeRevocationCutoffsResponse;
    await refresh(bob);
    const statement = await verifyRevocationCutoffs(
      {
        statement: fromBase64Url(statements[0]!.statement),
        signature: fromBase64Url(statements[0]!.signature)
      },
      bob.account.list,
      { generation: 1 }
    );
    expect(statement.cutoffs.map((c) => [c.projectId, c.cutoffEpoch])).toEqual(
      projects.map((id) => [id, predicted.get(id)])
    );

    // Until then the owner of the shared project does not write under a
    // key the phone may hold.
    if (leftId === sharedId) {
      await expect(
        saveEdit(alice, sharedId, 'Owner too early')
      ).rejects.toMatchObject({ code: 'E2EE_MEMBER_ROTATION_PENDING' });
    }
    // The desktop's next save (owned) or catch-up (shared, as a viewer)
    // finishes the rotation before anything else.
    await refresh(bobDesktop);
    const desktopKey = accountKeySequences(bobDesktop.account.list).at(-1)!;
    if (leftId === ownedId) {
      await saveEdit(bobDesktop, ownedId, 'Desktop finishes');
    } else {
      await joinProjectGroup(bobDesktop.groups, sharedId);
    }
    expect(keyEpochOf(srv, leftId)).toBe(predicted.get(leftId));
    expect(wrapSequences(srv, leftId, BOB, predicted.get(leftId)!)).toEqual([
      desktopKey,
      desktopKey
    ]);
    const status = await bobDesktop.sessions.status(refOf(bobDesktop, leftId));
    expect(status.members.map((m) => m.deviceId)).not.toContain(phoneId);
    expect(
      toHex((await dedupeSecretForProject(bobDesktop.groups, leftId)).secret)
    ).not.toBe(dedupe.get(leftId));

    // The owner of the shared project follows the rotation and writes on.
    await saveEdit(alice, sharedId, 'Owner after removal');
    expect(headRow(srv, sharedId).signer_user_id).toBe(ALICE);
    expect(keyEpochOf(srv, sharedId)).toBe(predicted.get(sharedId));
    forgetAllProjectKeys();
    expect((await bobDesktop.store.loadProject(sharedId)).name).toBe(
      'Owner after removal'
    );
    // The laptop comes back and finds nothing left to do.
    for (const projectId of projects) {
      await joinProjectGroup(bob.groups, projectId);
    }
    expect(keyEpochOf(srv, ownedId)).toBe(predicted.get(ownedId));

    // Decision D9 stays owner-only: the member cannot reset the shared
    // project (and the owner cannot while a member is in it, which slice
    // 4-10's tests cover).
    const byMember = await srv.call(
      'POST',
      `/api/e2ee/projects/${sharedId}/mls/reset`,
      { user: BOB, body: {} }
    );
    expect([403, 404]).toContain(byMember.status);
  });
});
