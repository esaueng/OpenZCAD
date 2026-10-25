/**
 * Device removal across encrypted projects and the solo group reset (ADR-024
 * Phase 4, slice 4-10; decision D9). Node devices of one account run the
 * real account-key flows (`accountKeys.ts`: set-up, recovery-key
 * enrolment, `removeDevice` with its participant step), the real project
 * modules (`projectGroups.ts`, `encryptedProjectStore.ts`,
 * `deviceRemoval.ts`) and the in-process MLS engine against the real
 * Worker routes over SQLite.
 */
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import {
  EnvelopeKey,
  accountKeySequences,
  encodeEncryptedDocumentBody,
  encryptProjectEnvelope,
  epochBinding,
  fromBase64Url,
  generateRecoveryKey,
  parseEnvelope,
  signProjectEnvelope,
  signRevocationCutoffs,
  toBase64Url,
  toHex,
  unwrapKey,
  verifyRevocationCutoffs,
  versionHash,
  wrapKey,
  type ProjectEnvelopeHeaderInit,
  type RevocationCutoffs,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  toUserId,
  type E2eeProjectEnvelopeRecord,
  type E2eeRevocationCutoffsResponse,
  type ProjectDocument
} from '@openzcad/shared';
import { inProcessMls } from '../packages/mls/src/test-support';
import {
  enrollWithRecoveryKey,
  loadEncryption,
  removeDevice,
  revokeReadOnlyDevices,
  setUpEncryption,
  signGroupResetWithIdentity,
  type AccountView,
  type E2eeContext,
  type EncryptionState
} from '../apps/web/src/lib/e2ee/accountKeys';
import { createE2eeApi } from '../apps/web/src/lib/e2ee/e2eeApi';
import { memoryDeviceStore } from '../apps/web/src/lib/e2ee/deviceStore';
import { unlockedAccount } from '../apps/web/src/lib/e2ee/unlockedKeys';
import {
  GROUP_RESET_CONFIRMATION,
  ProjectGroupError,
  createProjectGroupsApi,
  dedupeSecretForProject,
  epochAuthenticatorForEpoch,
  joinProjectGroup,
  projectGroupAccount,
  projectKeyForEpoch,
  projectRevocationCutoffs,
  resetProjectGroup,
  type ProjectGroupContext
} from '../apps/web/src/lib/e2ee/projectGroups';
import {
  DeviceRemovalError,
  createRevocationCutoffsApi,
  cutoffHead,
  memoryPendingCutoffs,
  removalParticipant,
  revocationStatements,
  storePendingCutoffs,
  type PendingCutoffStore,
  type RemovalOutcome,
  type RemovalParticipant
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
import {
  createBlobReferenceRegistry,
  type BlobReferenceRegistry
} from '../apps/web/src/lib/e2ee/blobReferences';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import { databaseBefore } from './support/e2ee-documents';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const USER = 'user_alice';
const OTHER = 'user_bob';
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
    options?: { user?: string; body?: unknown }
  ): Promise<Response>;
}

function newServer(db: DatabaseSync = migratedDatabase()): Server {
  for (const user of [USER, OTHER]) {
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(user, `${user}@example.com`, NOW);
  }
  const bucket = {
    objects: new Map<string, ArrayBuffer>(),
    put: vi.fn(async (key: string, body: ArrayBuffer | Uint8Array) => {
      bucket.objects.set(key, new Uint8Array(body).slice().buffer);
    }),
    get: vi.fn(async (key: string) => {
      const body = bucket.objects.get(key);
      return body
        ? { arrayBuffer: async () => body.slice(0), size: body.byteLength }
        : null;
    }),
    head: vi.fn(async (key: string) => {
      const body = bucket.objects.get(key);
      return body ? { size: body.byteLength } : null;
    }),
    delete: vi.fn(async (key: string) => {
      bucket.objects.delete(key);
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
    call: (method, path, options = {}) =>
      worker.fetch(
        new Request(`https://example.com${path}`, {
          method,
          headers: {
            'x-openzcad-development-user': options.user ?? USER,
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

// --- Devices ---------------------------------------------------------------

interface Device {
  label: string;
  srv: Server;
  e2ee: E2eeContext;
  account: AccountView;
  sessions: MlsProjectSessions;
  mls: MlsSessionStore;
  pins: VersionPinStore;
  references: BlobReferenceRegistry;
  /** Requests fail while set: the browser went offline. */
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

function newDevice(srv: Server, label: string): Device {
  const mls = memoryMlsSessionStore();
  const d = {
    label,
    srv,
    mls,
    sessions: new MlsProjectSessions(
      mls,
      createMlsLoader(async () => inProcessMls())
    ),
    pins: memoryVersionPins(),
    references: createBlobReferenceRegistry(),
    offline: false
  } as Device;
  d.fetcher = async (path: string, init: RequestInit = {}) => {
    if (d.offline) throw new TypeError('Failed to fetch (offline)');
    const response = await worker.fetch(
      new Request(`https://example.com${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          'x-openzcad-development-user': USER
        }
      }),
      srv.env
    );
    d.after?.(path, init);
    return response;
  };
  d.e2ee = {
    userId: USER,
    api: createE2eeApi((path, init) => d.fetcher(path, init)),
    store: memoryDeviceStore(),
    now: () => 1_760_000_000_000
  };
  return d;
}

/** This device's project-groups context for an account view. */
function groupsFor(d: Device, account: AccountView): ProjectGroupContext {
  const fetcher = (path: string, init?: RequestInit) => d.fetcher(path, init);
  return {
    api: createProjectGroupsApi(fetcher),
    sessions: d.sessions,
    account: projectGroupAccount(d.e2ee, account),
    device:
      account.deviceStatus === 'certified' && account.device
        ? {
            userId: USER,
            deviceId: account.device.deviceId,
            signing: account.device.signing
          }
        : null,
    revocations: revocationStatements(createRevocationCutoffsApi(fetcher), {
      list: account.list,
      generation: account.generation
    })
  };
}

function use(d: Device, account: AccountView): Device {
  d.account = account;
  d.groups = groupsFor(d, account);
  d.store = createEncryptedProjectStore({
    groups: d.groups,
    api: createEncryptedDocumentsApi((path, init) => d.fetcher(path, init)),
    blobReferences: d.references,
    pins: d.pins
  });
  return d;
}

/** The device reads its keys again (another page load). */
async function refresh(d: Device): Promise<Device> {
  return use(d, ready(await loadEncryption(d.e2ee)));
}

async function setUp(srv: Server) {
  const recovery = await generateRecoveryKey();
  const laptop = newDevice(srv, 'Laptop');
  use(
    laptop,
    ready(
      await setUpEncryption(laptop.e2ee, {
        recoverySecret: recovery.secret,
        label: 'Laptop'
      })
    )
  );
  return { recovery, laptop };
}

async function enroll(
  srv: Server,
  recovery: Uint8Array,
  label: string
): Promise<Device> {
  const d = newDevice(srv, label);
  const fresh = ready(await loadEncryption(d.e2ee));
  return use(
    d,
    ready(await enrollWithRecoveryKey(d.e2ee, fresh, recovery, label))
  );
}

const deviceIdOf = (d: Device) => d.account.device!.deviceId;

function initialDocument(name: string): ProjectDocument {
  return withoutDerivedProjection(createProjectDocument(name, toUserId(USER)));
}

async function createEncrypted(d: Device, name: string) {
  const { document } = await d.store.createProject({
    name,
    initialDocument: initialDocument(name)
  });
  return document.projectId as string;
}

/** Load, edit and save: the device joins the project's group if needed. */
async function saveEdit(d: Device, projectId: string, name: string) {
  const current = await d.store.loadProject(projectId);
  await d.store.saveProjectDocument({
    projectId: current.projectId,
    expectedVersion: current.version,
    document: { ...current, name, version: current.version + 1 }
  });
}

function groupRow(srv: Server, projectId: string) {
  return srv.db
    .prepare(
      'SELECT generation, key_epoch_base, epoch FROM e2ee_project_groups WHERE project_id = ?'
    )
    .get(projectId) as {
    generation: number;
    key_epoch_base: number;
    epoch: number;
  };
}

const keyEpochOf = (srv: Server, projectId: string) => {
  const row = groupRow(srv, projectId);
  return row.key_epoch_base + row.epoch;
};

function headRow(srv: Server, projectId: string) {
  return srv.db
    .prepare(
      `SELECT document_version, version_hash, key_epoch, signer_device_id
       FROM e2ee_project_versions WHERE project_id = ?
       ORDER BY document_version DESC LIMIT 1`
    )
    .get(projectId) as {
    document_version: number;
    version_hash: string;
    key_epoch: number;
    signer_device_id: string;
  };
}

function wrapRow(srv: Server, projectId: string, keyEpoch: number) {
  return srv.db
    .prepare(
      `SELECT account_key_sequence, wrapped FROM e2ee_project_keys
       WHERE project_id = ? AND key_epoch = ? AND purpose = ?`
    )
    .all(projectId, keyEpoch, 'project-key') as {
    account_key_sequence: number;
    wrapped: string;
  }[];
}

/** The participant, keeping the identity key and the outcome for tests. */
function participantFor(d: Device, pending?: PendingCutoffStore) {
  const seen: {
    outcome: RemovalOutcome | null;
    identity: CryptoKey | null;
  } = { outcome: null, identity: null };
  const inner = removalParticipant({
    api: createRevocationCutoffsApi((path, init) => d.fetcher(path, init)),
    groups: (account) => groupsFor(d, account),
    pins: d.pins,
    pending: pending ?? memoryPendingCutoffs(),
    onOutcome: (outcome) => {
      seen.outcome = outcome;
    }
  });
  const participant: RemovalParticipant = {
    prepare: (account) => inner.prepare(account),
    written: (step) => inner.written!(step),
    complete: (step) => {
      seen.identity = step.identityPrivateKey;
      return inner.complete(step);
    }
  };
  return { participant, seen };
}

/**
 * What a stolen device holds: its view of the device list from before the
 * removal, and the account key of that time. It never sees a newer one.
 */
function stolenGroups(d: Device): ProjectGroupContext {
  const list: VerifiedDeviceList = d.account.list;
  const key = new Uint8Array(unlockedAccount(USER)!.accountKey);
  const keySequence = accountKeySequences(list).at(-1)!;
  return {
    api: createProjectGroupsApi((path, init) => d.fetcher(path, init)),
    sessions: d.sessions,
    account: {
      userId: USER,
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
    device: d.groups.device
  };
}

async function statementsOf(
  srv: Server
): Promise<E2eeRevocationCutoffsResponse> {
  const response = await srv.call('GET', '/api/e2ee/revocation-cutoffs');
  expect(response.status).toBe(200);
  return (await response.json()) as E2eeRevocationCutoffsResponse;
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

const isPolicy = (code: string) => (error: unknown) =>
  error instanceof Error &&
  error.name === 'MlsError' &&
  ((error as { reasons?: { code: string }[] }).reasons ?? []).some(
    (reason) => reason.code === code
  );

/** Three devices of one account, each certified, with `count` projects. */
async function threeDevices(count: number) {
  const srv = newServer();
  const { recovery, laptop } = await setUp(srv);
  const desktop = await enroll(srv, recovery.secret, 'Desktop');
  const phone = await enroll(srv, recovery.secret, 'Phone');
  await refresh(laptop);
  await refresh(desktop);
  await refresh(phone);
  const projects: string[] = [];
  for (let i = 0; i < count; i++) {
    projects.push(await createEncrypted(laptop, `Part ${i}`));
  }
  // The server lists (and a removal rotates) projects by id.
  projects.sort();
  return { srv, recovery, laptop, desktop, phone, projects };
}

// --- Removal ---------------------------------------------------------------

describe('device removal across encrypted projects', () => {
  it('rotates every project, signs its cutoffs and replaces the dedupe secret', async () => {
    const { srv, recovery, laptop, desktop, phone, projects } =
      await threeDevices(3);
    // The phone and the desktop each write to every project (joining it).
    for (const projectId of projects) {
      await saveEdit(phone, projectId, 'Phone edit');
      await saveEdit(desktop, projectId, 'Desktop edit');
      await saveEdit(phone, projectId, 'Phone again');
    }
    const before = new Map<string, Uint8Array>();
    for (const projectId of projects) {
      before.set(
        projectId,
        (await dedupeSecretForProject(laptop.groups, projectId)).secret
      );
    }
    const predicted = new Map(
      projects.map((id) => [id, keyEpochOf(srv, id) + 1])
    );
    const heads = new Map(projects.map((id) => [id, headRow(srv, id)]));
    const oldKeySequence = accountKeySequences(laptop.account.list).at(-1)!;
    const phoneId = deviceIdOf(phone);

    const { participant, seen } = participantFor(laptop);
    use(
      laptop,
      ready(
        await removeDevice(
          laptop.e2ee,
          laptop.account,
          phoneId,
          recovery.secret,
          participant
        )
      )
    );
    expect(seen.outcome).toEqual({
      rotated: projects,
      left: [],
      cutoffsStored: true
    });
    const newKeySequence = accountKeySequences(laptop.account.list).at(-1)!;
    expect(newKeySequence).toBeGreaterThan(oldKeySequence);
    // The revocation names the removing device as the phone's replacement.
    expect(
      laptop.account.list.revoked.find((r) => r.id === phoneId)?.replacedBy
    ).toBe(deviceIdOf(laptop));

    // One identity-signed statement, naming every project.
    const { statements } = await statementsOf(srv);
    expect(statements).toHaveLength(1);
    const statement = await verifyRevocationCutoffs(
      {
        statement: fromBase64Url(statements[0]!.statement),
        signature: fromBase64Url(statements[0]!.signature)
      },
      laptop.account.list,
      { generation: 1 }
    );
    expect(statement.entrySequence).toBe(
      laptop.account.list.entries.at(-1)!.entry.sequence
    );
    for (const projectId of projects) {
      const cutoff = statement.cutoffs.find((c) => c.projectId === projectId)!;
      expect(cutoff.cutoffEpoch).toBe(predicted.get(projectId));
      expect(cutoff.head?.documentVersion).toBe(
        heads.get(projectId)!.document_version
      );
      expect(toHex(cutoff.head!.versionHash)).toBe(
        heads.get(projectId)!.version_hash
      );
      // The rotation landed exactly at the cutoff, under the new account key.
      expect(keyEpochOf(srv, projectId)).toBe(predicted.get(projectId));
      expect(
        wrapRow(srv, projectId, predicted.get(projectId)!).map(
          (w) => w.account_key_sequence
        )
      ).toEqual([newKeySequence]);
      // The phone's leaf is gone from the group.
      const status = await laptop.sessions.status({
        userId: USER,
        deviceId: deviceIdOf(laptop),
        projectId
      });
      expect(status.members.map((m) => m.deviceId)).not.toContain(phoneId);
      // Decision D8: a new dedupe secret for the new epoch.
      const after = await dedupeSecretForProject(laptop.groups, projectId);
      expect(after.keyEpoch).toBe(predicted.get(projectId));
      expect(toHex(after.secret)).not.toBe(toHex(before.get(projectId)!));
    }

    // The desktop, on its next load, reads the phone's earlier versions
    // (inside the cutoff) and writes on.
    await refresh(desktop);
    for (const projectId of projects) {
      expect((await desktop.store.loadProject(projectId)).name).toBe(
        'Phone again'
      );
      await saveEdit(desktop, projectId, 'Desktop after removal');
    }
    // A fresh browser verifies the whole history from scratch.
    const fresh = await refresh(newDeviceLike(desktop));
    expect((await fresh.store.loadProject(projects[0]!)).name).toBe(
      'Desktop after removal'
    );

    // The Worker keeps cutoffs from moving backwards, and checks signatures.
    const identity = seen.identity!;
    const lowered: RevocationCutoffs = {
      ...statement,
      issuedAt: statement.issuedAt + 1,
      cutoffs: statement.cutoffs.map((c) => ({
        ...c,
        cutoffEpoch: c.cutoffEpoch - 1
      }))
    };
    const signedLow = await signRevocationCutoffs(identity, lowered);
    const regression = await srv.call('PUT', '/api/e2ee/revocation-cutoffs', {
      body: {
        generation: 1,
        entrySequence: statement.entrySequence,
        statement: toBase64Url(signedLow.statement),
        signature: toBase64Url(signedLow.signature)
      }
    });
    expect(regression.status).toBe(409);
    expect(((await regression.json()) as { code: string }).code).toBe(
      'E2EE_CUTOFF_REGRESSION'
    );
    const tampered = await srv.call('PUT', '/api/e2ee/revocation-cutoffs', {
      body: {
        generation: 1,
        entrySequence: statement.entrySequence,
        statement: statements[0]!.statement,
        signature: toBase64Url(signedLow.signature)
      }
    });
    expect(tampered.status).toBe(400);
    const wrongEntry = await srv.call('PUT', '/api/e2ee/revocation-cutoffs', {
      body: {
        generation: 1,
        entrySequence: statement.entrySequence - 1,
        statement: statements[0]!.statement,
        signature: statements[0]!.signature
      }
    });
    expect(wrongEntry.status).toBe(400);
    // Another account sees none of these.
    const others = await srv.call('GET', '/api/e2ee/revocation-cutoffs', {
      user: OTHER
    });
    expect(others.status).toBe(200);
    expect(await others.json()).toEqual({ statements: [], projects: [] });
  });

  it('signs the cutoff for the entry this removal appended, not a later one (#894 review)', async () => {
    const { srv, recovery, laptop, desktop, phone, projects } =
      await threeDevices(1);
    await saveEdit(phone, projects[0]!, 'Phone edit');
    const tablet = await enroll(srv, recovery.secret, 'Tablet');
    await refresh(laptop);
    await refresh(desktop);
    const phoneId = deviceIdOf(phone);
    const tabletId = deviceIdOf(tablet);
    // Right after the laptop's entry lands, the desktop appends its own
    // removal, before the laptop reloads the list.
    const real = laptop.fetcher;
    let raced = false;
    laptop.fetcher = async (path, init = {}) => {
      const response = await real(path, init);
      if (!raced && path === '/api/e2ee/device-list' && init.method === 'POST') {
        raced = true;
        await removeDevice(
          desktop.e2ee,
          ready(await loadEncryption(desktop.e2ee)),
          tabletId,
          recovery.secret
        );
      }
      return response;
    };
    const { participant, seen } = participantFor(laptop);
    use(
      laptop,
      ready(
        await removeDevice(
          laptop.e2ee,
          laptop.account,
          phoneId,
          recovery.secret,
          participant
        )
      )
    );
    expect(raced).toBe(true);
    expect(seen.outcome?.cutoffsStored).toBe(true);
    const { statements } = await statementsOf(srv);
    expect(statements).toHaveLength(1);
    const statement = await verifyRevocationCutoffs(
      {
        statement: fromBase64Url(statements[0]!.statement),
        signature: fromBase64Url(statements[0]!.signature)
      },
      laptop.account.list,
      { generation: 1 }
    );
    const named = laptop.account.list.entries.find(
      (e) => e.entry.sequence === statement.entrySequence
    )!;
    expect(named.entry.revoked.map((r) => r.id)).toContain(phoneId);
    expect(named.entry.revoked.map((r) => r.id)).not.toContain(tabletId);
    expect(statement.entrySequence).toBeLessThan(
      laptop.account.list.entries.at(-1)!.entry.sequence
    );
  });

  it('keeps a signed cutoff when the reload after the device-list write fails (#894 review)', async () => {
    const { srv, recovery, laptop, desktop, phone, projects } =
      await threeDevices(1);
    const projectId = projects[0]!;
    await saveEdit(phone, projectId, 'Phone edit');
    const phoneId = deviceIdOf(phone);
    // The device list lands; the connection drops before the account is
    // read again, so `complete` never runs.
    const real = laptop.fetcher;
    let appended = false;
    let dropped = false;
    laptop.fetcher = async (path, init = {}) => {
      if (appended && !dropped && path === '/api/e2ee/account') {
        dropped = true;
        throw new TypeError('Failed to fetch');
      }
      const response = await real(path, init);
      if (path === '/api/e2ee/device-list' && init.method === 'POST') {
        appended = true;
      }
      return response;
    };
    const pending = memoryPendingCutoffs();
    const { participant, seen } = participantFor(laptop, pending);
    await expect(
      removeDevice(
        laptop.e2ee,
        laptop.account,
        phoneId,
        recovery.secret,
        participant
      )
    ).rejects.toBeDefined();
    expect(dropped).toBe(true);
    expect(seen.outcome).toBeNull();
    expect((await statementsOf(srv)).statements).toEqual([]);
    expect(pending.read(USER)).toHaveLength(1);

    // The next removal or page open stores it; the phone's head opens.
    expect(
      await storePendingCutoffs(
        createRevocationCutoffsApi((path, init) => laptop.fetcher(path, init)),
        pending,
        USER
      )
    ).toBe(0);
    expect((await statementsOf(srv)).statements).toHaveLength(1);
    await expect(
      (await refresh(desktop)).store.loadProject(projectId)
    ).resolves.toMatchObject({ name: 'Phone edit' });
  });

  it('keeps a signed cutoff whose store failed and stores it later (#894 review)', async () => {
    const { srv, recovery, laptop, desktop, phone, projects } =
      await threeDevices(1);
    const projectId = projects[0]!;
    await saveEdit(phone, projectId, 'Phone edit');
    const phoneId = deviceIdOf(phone);
    // The device list lands; the connection drops before the cutoff does.
    const real = laptop.fetcher;
    let dropped = false;
    laptop.fetcher = async (path, init = {}) => {
      if (
        !dropped &&
        path === '/api/e2ee/revocation-cutoffs' &&
        init.method === 'PUT'
      ) {
        dropped = true;
        throw new TypeError('Failed to fetch');
      }
      return real(path, init);
    };
    const pending = memoryPendingCutoffs();
    const { participant, seen } = participantFor(laptop, pending);
    use(
      laptop,
      ready(
        await removeDevice(
          laptop.e2ee,
          laptop.account,
          phoneId,
          recovery.secret,
          participant
        )
      )
    );
    expect(seen.outcome?.cutoffsStored).toBe(false);
    expect((await statementsOf(srv)).statements).toEqual([]);
    expect(pending.read(USER)).toHaveLength(1);
    // Without the statement the phone's head reads as revoked.
    await integrityRefusal(
      (await refresh(desktop)).store.loadProject(projectId),
      'author'
    );

    // Sent again later (the next removal or page open does this).
    expect(
      await storePendingCutoffs(
        createRevocationCutoffsApi((path, init) => laptop.fetcher(path, init)),
        pending,
        USER
      )
    ).toBe(0);
    expect((await statementsOf(srv)).statements).toHaveLength(1);
    await expect(
      (await refresh(desktop)).store.loadProject(projectId)
    ).resolves.toMatchObject({ name: 'Phone edit' });
  });

  it('refuses a Commit whose device list moved while it was written (#894 review)', async () => {
    const { srv, desktop, projects } = await threeDevices(1);
    const projectId = projects[0]!;
    const before = groupRow(srv, projectId);
    // A removal lands between the Commit's certified-device check and its
    // batch.
    let moved = false;
    srv.env.DB = sqliteD1(srv.db, {
      onStatement: (sql) => {
        if (moved || !/^\s*INSERT INTO e2ee_mls_commits/.test(sql)) return;
        moved = true;
        srv.db
          .prepare(
            `INSERT INTO e2ee_device_list_entries
             SELECT user_id, generation, sequence + 1, entry, signature,
                    substr(entry_hash, 2) || '0', created_at
             FROM e2ee_device_list_entries WHERE user_id = ?
             ORDER BY sequence DESC LIMIT 1`
          )
          .run(USER);
      }
    });
    // The desktop joins by external Commit on its first save.
    await expect(
      saveEdit(desktop, projectId, 'Desktop edit')
    ).rejects.toMatchObject({ code: 'E2EE_DEVICE_LIST_CHANGED' });
    expect(moved).toBe(true);
    const after = groupRow(srv, projectId);
    expect(after.epoch).toBe(before.epoch);
    expect(after.generation).toBe(before.generation);
  });

  it('signs the pinned head, not a server fork at the same version (#894 review)', async () => {
    const pins = memoryVersionPins();
    const pinned = 'a'.repeat(64);
    await pins.advance(USER, 'proj_fork', null, {
      headHash: pinned,
      documentVersion: 7,
      keyEpoch: 2
    });
    const project = {
      projectId: 'proj_fork',
      keyEpochBase: 0,
      epoch: 2,
      generation: 0,
      trashed: false,
      head: { documentVersion: 7, versionHash: 'b'.repeat(64) }
    } as unknown as Parameters<typeof cutoffHead>[2];
    const head = await cutoffHead(pins, USER, project);
    expect(toHex(head!.versionHash)).toBe(pinned);
    // A newer server head still wins.
    const newer = await cutoffHead(pins, USER, {
      ...project,
      head: { documentVersion: 8, versionHash: 'c'.repeat(64) }
    });
    expect(toHex(newer!.versionHash)).toBe('c'.repeat(64));
  });

  it('lets another device finish a removal that went offline part-way', async () => {
    const { srv, recovery, laptop, desktop, phone, projects } =
      await threeDevices(3);
    for (const projectId of projects) {
      await saveEdit(phone, projectId, 'Phone edit');
      await saveEdit(desktop, projectId, 'Desktop edit');
    }
    const predicted = new Map(
      projects.map((id) => [id, keyEpochOf(srv, id) + 1])
    );
    const dedupe = new Map<string, string>();
    for (const projectId of projects) {
      dedupe.set(
        projectId,
        toHex((await dedupeSecretForProject(laptop.groups, projectId)).secret)
      );
    }
    // The laptop goes offline right after its first rotation lands.
    laptop.after = (path, init) => {
      if (init.method === 'POST' && path.endsWith('/mls/commits')) {
        laptop.offline = true;
      }
    };
    const { participant, seen } = participantFor(laptop);
    const state = await removeDevice(
      laptop.e2ee,
      laptop.account,
      deviceIdOf(phone),
      recovery.secret,
      participant
    );
    expect(state.kind).toBe('ready');
    expect(seen.outcome!.cutoffsStored).toBe(true);
    expect(seen.outcome!.rotated).toEqual([projects[0]]);
    expect(seen.outcome!.left.map((l) => l.projectId)).toEqual(
      projects.slice(1)
    );
    expect(keyEpochOf(srv, projects[1]!)).toBe(
      predicted.get(projects[1]!)! - 1
    );

    // The desktop's next write in each project finishes the rotation first.
    await refresh(desktop);
    const desktopKey = accountKeySequences(desktop.account.list).at(-1)!;
    for (const projectId of projects.slice(1)) {
      await saveEdit(desktop, projectId, 'Desktop finishes');
      const head = headRow(srv, projectId);
      expect(head.key_epoch).toBe(predicted.get(projectId));
      expect(
        wrapRow(srv, projectId, predicted.get(projectId)!).map(
          (w) => w.account_key_sequence
        )
      ).toEqual([desktopKey]);
      const status = await desktop.sessions.status({
        userId: USER,
        deviceId: deviceIdOf(desktop),
        projectId
      });
      expect(status.members.map((m) => m.deviceId)).not.toContain(
        deviceIdOf(phone)
      );
      expect(
        toHex((await dedupeSecretForProject(desktop.groups, projectId)).secret)
      ).not.toBe(dedupe.get(projectId));
    }
    // The laptop comes back and finds nothing left to do.
    laptop.offline = false;
    laptop.after = undefined;
    await refresh(laptop);
    for (const projectId of projects) {
      expect((await joinProjectGroup(laptop.groups, projectId)).keyEpoch).toBe(
        predicted.get(projectId)
      );
      expect(keyEpochOf(srv, projectId)).toBe(predicted.get(projectId));
    }
  });

  it('refuses a stolen device’s later Commits and versions, by directory and by authorship', async () => {
    const { srv, recovery, laptop, desktop, phone, projects } =
      await threeDevices(2);
    const [rotatedId, pendingId] = projects as [string, string];
    for (const projectId of projects) {
      await saveEdit(phone, projectId, 'Phone edit');
      await saveEdit(desktop, projectId, 'Desktop edit');
    }
    // The phone is stolen: what it holds is frozen here.
    await phone.store.loadProject(rotatedId);
    const stolen = stolenGroups(phone);
    const oldAccountKey = new Uint8Array(unlockedAccount(USER)!.accountKey);
    const phoneId = deviceIdOf(phone);
    const cutoffHead = headRow(srv, rotatedId);

    // The removal rotates only the first project before going offline.
    laptop.after = (path, init) => {
      if (init.method === 'POST' && path.endsWith('/mls/commits')) {
        laptop.offline = true;
      }
    };
    const { participant } = participantFor(laptop);
    await removeDevice(
      laptop.e2ee,
      laptop.account,
      phoneId,
      recovery.secret,
      participant
    );
    laptop.offline = false;
    await refresh(desktop);
    const cutoffs = await projectRevocationCutoffs(desktop.groups, rotatedId);
    const cutoff = cutoffs.get(phoneId)!;
    expect(cutoff.signed).toBe(true);
    expect(keyEpochOf(srv, rotatedId)).toBe(cutoff.keyEpoch);

    // Rule 1, the directory: the phone builds a Commit in the project that
    // has not rotated yet. The Worker refuses it outright...
    forgetAllProjectKeys();
    await expect(
      joinProjectGroup(stolen, pendingId).then(() =>
        stolen.sessions.commit(
          { userId: USER, deviceId: phoneId, projectId: pendingId },
          { lists: [stolen.account.list], certifications: [] }
        )
      )
    ).resolves.toBeDefined();
    const pending = (await phone.sessions.pendingCommit({
      userId: USER,
      deviceId: phoneId,
      projectId: pendingId
    }))!;
    const epoch = groupRow(srv, pendingId).epoch;
    const submitted = await srv.call(
      'POST',
      `/api/e2ee/projects/${pendingId}/mls/commits`,
      {
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
    // ...and when a compromised server serves it anyway, the desktop's
    // policy refuses a Commit signed by a removed device.
    srv.db
      .prepare(
        `INSERT INTO e2ee_mls_commits
           (project_id, epoch, kind, sender_user_id, sender_device_id, message, created_at)
         VALUES (?, ?, 'commit', ?, ?, ?, ?)`
      )
      .run(pendingId, epoch, USER, phoneId, toBase64Url(pending.commit), NOW);
    srv.db
      .prepare(
        'UPDATE e2ee_project_groups SET epoch = epoch + 1 WHERE project_id = ?'
      )
      .run(pendingId);
    await expect(joinProjectGroup(desktop.groups, pendingId)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProjectGroupError && error.code === 'removed-device'
    );

    // Rule 2, authorship: a version the phone signs after its removal, under
    // the last key it knew, chained onto the head it last saw.
    forgetAllProjectKeys();
    const keyEpoch = cutoff.keyEpoch - 1;
    const projectKey = await projectKeyForEpoch(stolen, rotatedId, keyEpoch);
    const authenticator = await epochAuthenticatorForEpoch(
      stolen,
      rotatedId,
      keyEpoch
    );
    forgetAllProjectKeys();
    const document = {
      ...(await desktop.store.loadProject(rotatedId)),
      name: 'Forged after removal'
    };
    const header: ProjectEnvelopeHeaderInit = {
      kind: 'document',
      projectId: rotatedId,
      documentVersion: cutoffHead.document_version + 1,
      previousVersionHash: fromHexString(cutoffHead.version_hash),
      epochBindingHash: await epochBinding(rotatedId, keyEpoch, authenticator),
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
            ...(document as unknown as Record<string, unknown>),
            version: header.documentVersion
          },
          blobs: [],
          revisionVersionHashes: new Map()
        },
        header
      )
    );
    const hash = toHex(await versionHash(envelope));
    const signature = await signProjectEnvelope(
      phone.account.device!.signing.privateKey,
      envelope
    );
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_versions
           (project_id, document_version, version_hash, key_epoch, prefix, signature,
            signer_user_id, signer_device_id, envelope_key, envelope_inline,
            envelope_bytes, wrapped_version_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
      )
      .run(
        rotatedId,
        header.documentVersion,
        hash,
        keyEpoch,
        toBase64Url(parseEnvelope(envelope).prefix),
        toBase64Url(signature),
        USER,
        phoneId,
        toBase64Url(envelope),
        envelope.byteLength,
        toBase64Url(
          await wrapKey(projectKey, versionKey.bytes, {
            purpose: 'version-key',
            projectId: rotatedId,
            keyEpoch,
            kind: 'document',
            versionId: hash
          })
        ),
        NOW
      );
    srv.db
      .prepare('UPDATE projects SET document_version = ? WHERE id = ?')
      .run(header.documentVersion, rotatedId);
    // The desktop, pinned before it, and a fresh browser both refuse it.
    await integrityRefusal(desktop.store.loadProject(rotatedId), 'author');
    const fresh = await refresh(newDeviceLike(desktop));
    await integrityRefusal(fresh.store.loadProject(rotatedId), 'author');

    // And the account-key rotation: no wrap made after the removal opens
    // under the account key the phone held.
    const rotatedWraps = srv.db
      .prepare(
        `SELECT key_epoch, purpose, wrapped FROM e2ee_project_keys
         WHERE project_id = ? AND key_epoch >= ?`
      )
      .all(rotatedId, cutoff.keyEpoch) as {
      key_epoch: number;
      purpose: 'project-key' | 'rejoin-psk';
      wrapped: string;
    }[];
    expect(rotatedWraps.length).toBeGreaterThan(0);
    expect(rotatedWraps.map((wrap) => wrap.purpose)).toContain('rejoin-psk');
    const currentAccountKey = new Uint8Array(unlockedAccount(USER)!.accountKey);
    for (const wrap of rotatedWraps) {
      // Both purposes bind the row's key epoch (a rejoin PSK's, not its MLS
      // epoch), so this is the context the browsers wrap and open under.
      const context = {
        purpose: wrap.purpose,
        userId: USER,
        projectId: rotatedId,
        keyEpoch: wrap.key_epoch
      };
      expect(
        await unwrapKey(currentAccountKey, fromBase64Url(wrap.wrapped), context)
      ).toHaveLength(32);
      await expect(
        unwrapKey(oldAccountKey, fromBase64Url(wrap.wrapped), context)
      ).rejects.toThrow();
    }
  });

  it('lets only the named replacement rejoin a group whose last leaf was removed', async () => {
    const srv = newServer();
    const { recovery, laptop } = await setUp(srv);
    const desktop = await enroll(srv, recovery.secret, 'Desktop');
    const phone = await enroll(srv, recovery.secret, 'Phone');
    await refresh(laptop);
    await refresh(desktop);
    await refresh(phone);
    // Only the phone ever held this project.
    const projectId = await createEncrypted(phone, 'Phone only');
    await saveEdit(phone, projectId, 'Phone edit');
    const phoneId = deviceIdOf(phone);
    const before = keyEpochOf(srv, projectId);

    // The laptop stores the cutoffs, then drops off before rotating.
    laptop.after = (path, init) => {
      if (init.method === 'PUT' && path.endsWith('/revocation-cutoffs')) {
        laptop.offline = true;
      }
    };
    const { participant, seen } = participantFor(laptop);
    const state = ready(
      await removeDevice(
        laptop.e2ee,
        laptop.account,
        phoneId,
        recovery.secret,
        participant
      )
    );
    expect(seen.outcome!.cutoffsStored).toBe(true);
    expect(seen.outcome!.rotated).toEqual([]);
    expect(state.list.revoked.find((r) => r.id === phoneId)?.replacedBy).toBe(
      deviceIdOf(laptop)
    );

    // The desktop is not the named replacement: its rejoin with the newest
    // PSK, from before the revocation, is refused by its own policy.
    await refresh(desktop);
    await expect(joinProjectGroup(desktop.groups, projectId)).rejects.toSatisfy(
      isPolicy('rejoin-psk-before-revocation')
    );
    expect(keyEpochOf(srv, projectId)).toBe(before);

    // The laptop, the replacement, rejoins and removes the phone's leaf in
    // the same external Commit.
    laptop.offline = false;
    laptop.after = undefined;
    use(laptop, state);
    const joined = await joinProjectGroup(laptop.groups, projectId);
    expect(joined.keyEpoch).toBe(before + 1);
    const status = await laptop.sessions.status({
      userId: USER,
      deviceId: deviceIdOf(laptop),
      projectId
    });
    expect(status.members.map((m) => m.deviceId)).toEqual([deviceIdOf(laptop)]);
    const cutoff = (
      await projectRevocationCutoffs(laptop.groups, projectId)
    ).get(phoneId)!;
    expect(cutoff.keyEpoch).toBe(joined.keyEpoch);
    // Then the desktop rejoins with a PSK from after the removal.
    await saveEdit(desktop, projectId, 'Desktop now');
    expect((await laptop.store.loadProject(projectId)).name).toBe(
      'Desktop now'
    );
  });

  it('rejoins a device that missed the removed device’s earlier Commits', async () => {
    const { srv, recovery, laptop, desktop, phone, projects } =
      await threeDevices(1);
    const projectId = projects[0]!;
    // The desktop joins first; the phone's join comes while it is away.
    await saveEdit(desktop, projectId, 'Desktop edit');
    await saveEdit(phone, projectId, 'Phone edit');
    const { participant } = participantFor(laptop);
    await removeDevice(
      laptop.e2ee,
      laptop.account,
      deviceIdOf(phone),
      recovery.secret,
      participant
    );
    const rotated = keyEpochOf(srv, projectId);
    // Its state cannot process the phone's join any more (a revoked
    // credential sent it), so it rejoins from the archives and writes on.
    await refresh(desktop);
    await saveEdit(desktop, projectId, 'Desktop after');
    expect(keyEpochOf(srv, projectId)).toBe(rotated + 1);
    expect(headRow(srv, projectId).key_epoch).toBe(rotated + 1);
    const status = await desktop.sessions.status({
      userId: USER,
      deviceId: deviceIdOf(desktop),
      projectId
    });
    expect(status.members.map((m) => m.deviceId).sort()).toEqual(
      [deviceIdOf(laptop), deviceIdOf(desktop)].sort()
    );
  });

  it('keeps reading versions under older account keys after the removal', async () => {
    const { srv, recovery, laptop, desktop, phone, projects } =
      await threeDevices(1);
    const projectId = projects[0]!;
    await saveEdit(desktop, projectId, 'Before removal');
    const { participant } = participantFor(laptop);
    await removeDevice(
      laptop.e2ee,
      laptop.account,
      deviceIdOf(phone),
      recovery.secret,
      participant
    );
    await refresh(desktop);
    forgetAllProjectKeys();
    // Key epoch 0 is wrapped only under the account key the removal replaced:
    // it opens through the account-key history.
    expect(
      wrapRow(srv, projectId, 0).map((w) => w.account_key_sequence)
    ).toEqual([0]);
    expect(await projectKeyForEpoch(desktop.groups, projectId, 0)).toHaveLength(
      32
    );
    const fresh = await refresh(newDeviceLike(desktop));
    expect((await fresh.store.loadProject(projectId)).name).toBe(
      'Before removal'
    );
    // A project made after the removal is named in no statement: the
    // removed device never held the key its group started under, so every
    // device gives it a cutoff at the group's start.
    await refresh(laptop);
    const later = await createEncrypted(laptop, 'After removal');
    await saveEdit(desktop, later, 'Desktop joins');
    const cutoff = (await projectRevocationCutoffs(desktop.groups, later)).get(
      deviceIdOf(phone)
    );
    expect(cutoff).toEqual({ keyEpoch: 0, head: null, signed: false });
  });

  it('rotates projects after revoking read-only devices, without a statement', async () => {
    const { srv, recovery, laptop, projects } = await threeDevices(1);
    const projectId = projects[0]!;
    const before = keyEpochOf(srv, projectId);
    const { participant, seen } = participantFor(laptop);
    use(
      laptop,
      ready(
        await revokeReadOnlyDevices(
          laptop.e2ee,
          laptop.account,
          recovery.secret,
          participant
        )
      )
    );
    expect(seen.outcome).toEqual({
      rotated: [projectId],
      left: [],
      cutoffsStored: false
    });
    expect(keyEpochOf(srv, projectId)).toBe(before + 1);
    expect(
      wrapRow(srv, projectId, before + 1).map((w) => w.account_key_sequence)
    ).toEqual([accountKeySequences(laptop.account.list).at(-1)]);
    expect((await statementsOf(srv)).statements).toEqual([]);
  });

  it('keeps a removed device’s project info readable inside its cutoff only', async () => {
    const { srv, recovery, laptop, desktop, phone, projects } =
      await threeDevices(1);
    const projectId = projects[0]!;
    // The phone renames it: the project info (slice 4-7) is the phone's.
    await saveEdit(phone, projectId, 'Phone name');
    const phoneId = deviceIdOf(phone);
    const info = await srv.call('GET', `/api/e2ee/projects/${projectId}/info`);
    const { info: record } = (await info.json()) as {
      info: E2eeProjectEnvelopeRecord;
    };
    expect(record.signerDeviceId).toBe(phoneId);

    const { participant } = participantFor(laptop);
    use(
      laptop,
      ready(
        await removeDevice(
          laptop.e2ee,
          laptop.account,
          phoneId,
          recovery.secret,
          participant
        )
      )
    );
    // Signed below the phone's cutoff epoch: still the project's name.
    await refresh(desktop);
    expect((await desktop.store.info.read(projectId)).body?.name).toBe(
      'Phone name'
    );
    expect(await desktop.store.projectName(record)).toBe('Phone name');
    // A cutoff at or below its epoch refuses it, as it refuses versions.
    const strict = createEncryptedProjectStore({
      groups: desktop.groups,
      api: createEncryptedDocumentsApi((path, init) =>
        desktop.fetcher(path, init)
      ),
      blobReferences: desktop.references,
      pins: memoryVersionPins(),
      cutoffs: async () =>
        new Map([[`${USER} ${phoneId}`, { keyEpoch: record.keyEpoch }]])
    });
    expect(await strict.projectName(record)).toBeNull();
  });

  it('names a project in the recycle bin, which reads and rotates once restored', async () => {
    const { srv, recovery, laptop, desktop, phone, projects } =
      await threeDevices(2);
    for (const projectId of projects) {
      await saveEdit(phone, projectId, 'Phone edit');
      await saveEdit(desktop, projectId, 'Desktop edit');
      await saveEdit(phone, projectId, 'Phone again');
    }
    const [binned, active] = projects as [string, string];
    const patch = (status: string) =>
      srv.call('PATCH', `/api/projects/${binned}`, { body: { status } });
    // Slice 4-8: the owner trashes it; nobody writes while it is there.
    expect((await patch('deleted')).status).toBe(200);
    const predicted = keyEpochOf(srv, binned) + 1;
    const head = headRow(srv, binned);
    const phoneId = deviceIdOf(phone);

    const { participant, seen } = participantFor(laptop);
    use(
      laptop,
      ready(
        await removeDevice(
          laptop.e2ee,
          laptop.account,
          phoneId,
          recovery.secret,
          participant
        )
      )
    );
    // Rotated where it can be; the binned project waits for its restore.
    expect(seen.outcome?.rotated).toEqual([active]);
    expect(seen.outcome?.left.map((item) => item.projectId)).toEqual([binned]);
    expect(seen.outcome?.cutoffsStored).toBe(true);
    expect(keyEpochOf(srv, binned)).toBe(predicted - 1);
    // The statement names it too, at its next epoch and its newest head.
    const { statements } = await statementsOf(srv);
    const statement = await verifyRevocationCutoffs(
      {
        statement: fromBase64Url(statements[0]!.statement),
        signature: fromBase64Url(statements[0]!.signature)
      },
      laptop.account.list,
      { generation: 1 }
    );
    const cutoff = statement.cutoffs.find((c) => c.projectId === binned);
    expect(cutoff?.cutoffEpoch).toBe(predicted);
    expect(toHex(cutoff!.head!.versionHash)).toBe(head.version_hash);

    // In the bin, the owner still reads the phone's versions.
    await refresh(desktop);
    expect((await desktop.store.loadProject(binned)).name).toBe('Phone again');
    // Restored, the next writer rotates the phone out before saving, at the
    // epoch the statement named.
    expect((await patch('active')).status).toBe(200);
    await saveEdit(desktop, binned, 'Desktop after restore');
    expect(keyEpochOf(srv, binned)).toBe(predicted);
    const status = await desktop.sessions.status({
      userId: USER,
      deviceId: deviceIdOf(desktop),
      projectId: binned
    });
    expect(status.members.map((m) => m.deviceId)).not.toContain(phoneId);
    // A fresh browser verifies the whole history, the phone's part included.
    const fresh = await refresh(newDeviceLike(desktop));
    expect((await fresh.store.loadProject(binned)).name).toBe(
      'Desktop after restore'
    );
  });
});

/** A new browser of the same device (fresh MLS state and pins). */
function newDeviceLike(d: Device): Device {
  const copy = newDevice(d.srv, `${d.label} (fresh)`);
  copy.e2ee = d.e2ee;
  return copy;
}

function fromHexString(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));
}

// --- Solo group reset (D9) ----------------------------------------------------

describe('solo group reset (decision D9)', () => {
  it('lets the owner reset a solo group and keeps the history readable', async () => {
    const srv = newServer();
    const { recovery, laptop } = await setUp(srv);
    const desktop = await enroll(srv, recovery.secret, 'Desktop');
    await refresh(laptop);
    const projectId = await createEncrypted(laptop, 'Bracket');
    await saveEdit(desktop, projectId, 'Desktop edit');
    await saveEdit(laptop, projectId, 'Laptop edit');
    const prior = groupRow(srv, projectId);
    const priorKeyEpoch = prior.key_epoch_base + prior.epoch;
    // The laptop loses its MLS state (a cleared browser).
    const wiped = newDeviceLike(laptop);
    use(wiped, laptop.account);
    const authority = {
      generation: 1,
      sign: (reset: Parameters<typeof signGroupResetWithIdentity>[3]) =>
        signGroupResetWithIdentity(
          wiped.e2ee,
          wiped.account,
          recovery.secret,
          reset
        )
    };

    // Not without the plain-words confirmation.
    await expect(
      resetProjectGroup(wiped.groups, projectId, authority, 'yes')
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProjectGroupError && error.code === 'reset-refused'
    );
    const state = await resetProjectGroup(
      wiped.groups,
      projectId,
      authority,
      GROUP_RESET_CONFIRMATION
    );
    expect(state).toEqual({ epoch: 0, keyEpoch: priorKeyEpoch + 1 });
    expect(groupRow(srv, projectId)).toEqual({
      generation: prior.generation + 1,
      key_epoch_base: priorKeyEpoch + 1,
      epoch: 0
    });
    expect(
      (
        srv.db
          .prepare(
            'SELECT COUNT(*) AS n FROM e2ee_mls_commits WHERE project_id = ?'
          )
          .get(projectId) as { n: number }
      ).n
    ).toBe(0);
    const resets = (await (
      await srv.call('GET', `/api/e2ee/projects/${projectId}/mls/resets`)
    ).json()) as { resets: { generation: number; keyEpochBase: number }[] };
    expect(resets.resets).toMatchObject([
      { generation: 1, keyEpochBase: priorKeyEpoch + 1 }
    ]);

    // The head written before the reset still opens, and writing continues
    // under the new group's key epochs (decision D10: still rising).
    forgetAllProjectKeys();
    expect((await wiped.store.loadProject(projectId)).name).toBe('Laptop edit');
    await saveEdit(wiped, projectId, 'After reset');
    expect(headRow(srv, projectId).key_epoch).toBe(priorKeyEpoch + 1);
    // The desktop's state is from the replaced group: it rejoins fresh.
    await refresh(desktop);
    await saveEdit(desktop, projectId, 'Desktop after reset');
    expect(headRow(srv, projectId).key_epoch).toBe(priorKeyEpoch + 2);
    expect((await wiped.store.loadProject(projectId)).name).toBe(
      'Desktop after reset'
    );
  });

  it('binds a rejoin PSK to its key epoch, not its MLS epoch, across a reset', async () => {
    const srv = newServer();
    const { recovery, laptop } = await setUp(srv);
    const desktop = await enroll(srv, recovery.secret, 'Desktop');
    await refresh(laptop);
    const projectId = await createEncrypted(laptop, 'Bracket');
    await saveEdit(desktop, projectId, 'Desktop edit');
    const prior = groupRow(srv, projectId);
    const priorKeyEpoch = prior.key_epoch_base + prior.epoch;
    const wiped = newDeviceLike(laptop);
    use(wiped, laptop.account);
    await resetProjectGroup(
      wiped.groups,
      projectId,
      {
        generation: 1,
        sign: (reset) =>
          signGroupResetWithIdentity(
            wiped.e2ee,
            wiped.account,
            recovery.secret,
            reset
          )
      },
      GROUP_RESET_CONFIRMATION
    );
    const rejoinRow = (keyEpoch: number) =>
      srv.db
        .prepare(
          `SELECT wrapped, account_key_generation, account_key_sequence
           FROM e2ee_project_keys
           WHERE project_id = ? AND key_epoch = ? AND purpose = 'rejoin-psk'`
        )
        .get(projectId, keyEpoch) as {
        wrapped: string;
        account_key_generation: number;
        account_key_sequence: number;
      };
    // MLS epoch 0 twice: key epoch 0 of the replaced group and the new
    // group's first key epoch, two different PSKs under the same account key.
    const before = rejoinRow(0);
    const after = rejoinRow(priorKeyEpoch + 1);
    expect(after.wrapped).not.toBe(before.wrapped);
    expect([after.account_key_generation, after.account_key_sequence]).toEqual([
      before.account_key_generation,
      before.account_key_sequence
    ]);
    const serve = (wrapped: string) =>
      srv.db
        .prepare(
          `UPDATE e2ee_project_keys SET wrapped = ?
           WHERE project_id = ? AND key_epoch = ? AND purpose = 'rejoin-psk'`
        )
        .run(wrapped, projectId, priorKeyEpoch + 1);

    // The server serves the replaced group's MLS-epoch-0 PSK as the new
    // group's: the wrap names key epoch 0, so it does not open.
    serve(before.wrapped);
    await refresh(desktop);
    await expect(
      joinProjectGroup(desktop.groups, projectId)
    ).rejects.toMatchObject({ code: 'authentication-failed' });
    expect(groupRow(srv, projectId).epoch).toBe(0);

    // The genuine wrap opens, and the desktop rejoins the new group.
    serve(after.wrapped);
    expect(await joinProjectGroup(desktop.groups, projectId)).toEqual({
      epoch: 1,
      keyEpoch: priorKeyEpoch + 2
    });
  });

  it('refuses a reset while anyone else is in the project, or by anyone else', async () => {
    const srv = newServer();
    const { recovery, laptop } = await setUp(srv);
    const projectId = await createEncrypted(laptop, 'Shared later');
    const authority = {
      generation: 1,
      sign: (reset: Parameters<typeof signGroupResetWithIdentity>[3]) =>
        signGroupResetWithIdentity(
          laptop.e2ee,
          laptop.account,
          recovery.secret,
          reset
        )
    };
    // A leaf of another account: the browser refuses before signing.
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_leaves
           (project_id, user_id, device_id, leaf_key, certification, created_at)
         VALUES (?, ?, 'bob_device', ?, ?, ?)`
      )
      .run(projectId, OTHER, 'B'.repeat(87), 'A'.repeat(98), NOW);
    await expect(
      resetProjectGroup(
        laptop.groups,
        projectId,
        authority,
        GROUP_RESET_CONFIRMATION
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProjectGroupError && error.code === 'reset-refused'
    );
    srv.db
      .prepare('DELETE FROM e2ee_project_leaves WHERE user_id = ?')
      .run(OTHER);
    // A member: the Worker refuses, whatever the browser decided.
    srv.db
      .prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, added_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'viewer', ?, 1, 1)`
      )
      .run(projectId, OTHER, USER);
    await expect(
      resetProjectGroup(
        laptop.groups,
        projectId,
        authority,
        GROUP_RESET_CONFIRMATION
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'E2EE_RESET_NOT_SOLO'
    );
    expect(groupRow(srv, projectId).generation).toBe(0);
    // Anyone else learns nothing (owner only).
    const foreign = await srv.call(
      'POST',
      `/api/e2ee/projects/${projectId}/mls/reset`,
      { user: OTHER, body: {} }
    );
    expect([403, 404, 409]).toContain(foreign.status);
    expect(groupRow(srv, projectId).generation).toBe(0);
  });
});

// --- Without migration 0036 -----------------------------------------------------

describe('before migration 0036', () => {
  it('refuses a removal it could not finish, and keeps everything else working', async () => {
    const srv = newServer(databaseBefore(35));
    const { recovery, laptop } = await setUp(srv);
    const phone = await enroll(srv, recovery.secret, 'Phone');
    await refresh(laptop);
    const projectId = await createEncrypted(laptop, 'Bracket');
    await saveEdit(phone, projectId, 'Phone edit');
    expect((await srv.call('GET', '/api/e2ee/revocation-cutoffs')).status).toBe(
      503
    );
    expect(
      (await srv.call('GET', `/api/e2ee/projects/${projectId}/mls/resets`))
        .status
    ).toBe(503);
    const { participant } = participantFor(laptop);
    await expect(
      removeDevice(
        laptop.e2ee,
        laptop.account,
        deviceIdOf(phone),
        recovery.secret,
        participant
      )
    ).rejects.toBeInstanceOf(DeviceRemovalError);
    // Nothing was signed: the phone is still listed and still writes.
    expect(
      ready(await loadEncryption(laptop.e2ee)).list.devices.map(
        (d) => d.deviceId
      )
    ).toContain(deviceIdOf(phone));
    await saveEdit(phone, projectId, 'Phone again');
    // Ordinary traffic, purge and erasure do not need the migration.
    expect((await srv.call('GET', '/api/projects')).status).toBe(200);
    expect((await srv.call('POST', '/api/projects/purge')).status).toBe(200);
    const erased = await srv.call('POST', '/api/account/delete-data', {
      user: OTHER,
      body: { scope: 'all', confirmation: 'DELETE ALL CLOUD DATA' }
    });
    expect(erased.status).toBe(200);
  });

  it('removes a device from an account without encrypted projects', async () => {
    const srv = newServer(databaseBefore(35));
    const { recovery, laptop } = await setUp(srv);
    const phone = await enroll(srv, recovery.secret, 'Phone');
    await refresh(laptop);
    const { participant } = participantFor(laptop);
    const state = ready(
      await removeDevice(
        laptop.e2ee,
        laptop.account,
        deviceIdOf(phone),
        recovery.secret,
        participant
      )
    );
    expect(state.list.devices.map((d) => d.deviceId)).not.toContain(
      deviceIdOf(phone)
    );
  });
});

describe('cutoffs and resets with their account and projects', () => {
  it('erases cutoffs with the account and resets with the project', async () => {
    const { srv, recovery, laptop, phone, projects } = await threeDevices(1);
    const projectId = projects[0]!;
    const { participant } = participantFor(laptop);
    use(
      laptop,
      ready(
        await removeDevice(
          laptop.e2ee,
          laptop.account,
          deviceIdOf(phone),
          recovery.secret,
          participant
        )
      )
    );
    await resetProjectGroup(
      laptop.groups,
      projectId,
      {
        generation: 1,
        sign: (reset) =>
          signGroupResetWithIdentity(
            laptop.e2ee,
            laptop.account,
            recovery.secret,
            reset
          )
      },
      GROUP_RESET_CONFIRMATION
    );
    const count = (table: string) =>
      (
        srv.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;
    expect(count('e2ee_revocation_cutoffs')).toBe(1);
    expect(count('e2ee_group_resets')).toBe(1);
    // Purge removes the reset with its project.
    srv.db
      .prepare(
        "UPDATE projects SET status = 'deleted', deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
      )
      .run(projectId);
    expect((await srv.call('POST', '/api/projects/purge')).status).toBe(200);
    expect(count('e2ee_group_resets')).toBe(0);
    // A profile erasure takes the cutoff statements with the keys.
    const erased = await srv.call('POST', '/api/account/delete-data', {
      body: { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' }
    });
    expect(erased.status).toBe(200);
    expect(count('e2ee_revocation_cutoffs')).toBe(0);
  });
});
