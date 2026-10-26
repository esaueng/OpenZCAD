/**
 * Moving existing plaintext projects to encrypted storage (ADR-024 Phase 7,
 * slice 7-1): the migration state, the lease, staging beside the
 * plaintext, the cutover, abandon and purge, over the real Worker and
 * SQLite with Node devices that run the real client modules and the
 * in-process MLS engine. The engine of slice 7-2 does not exist yet, so a
 * staging device creates its encrypted project through the ordinary
 * client store, whose single create request the test splits into the
 * staged group, first version and project info routes.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  E2EE_FRAME_CONTENT_TYPE,
  E2EE_MIGRATION_LEASE_HEADER,
  decodeE2eeFrame,
  encodeE2eeFrame,
  MAX_ACCOUNT_ARTIFACT_BYTES,
  toRevisionId,
  type E2eeMigrationLeaseResponse,
  type ProjectDocument
} from '@openzcad/shared';
import { ApiError } from '../apps/web/src/lib/api';
import type { ArchiveArtifactInput } from '../apps/web/src/lib/archiveArtifact';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  createProjectMigrationsApi,
  withMigrationLease,
  type ProjectMigrationsApi
} from '../apps/web/src/lib/e2ee/projectMigrationsApi';
import worker from '../apps/web/worker/index';
import { sweepProjectMigrations } from '../apps/web/worker/e2eeProjectMigrations';
import { ProjectCollaborationRoom } from '../apps/web/worker/e2eeRoom';
import { createRoomContext } from './collaboration-room-harness';
import {
  OTHER,
  OWNER,
  count,
  databaseBefore,
  device,
  initialDocument,
  makeAccount,
  newServer,
  rows,
  type Account,
  type Device,
  type Server
} from './support/e2ee-documents';

let owner: Account;
let other: Account;

beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  other = await makeAccount(OTHER, ['other_laptop']);
});

afterEach(() => {
  forgetAllProjectKeys();
  vi.useRealTimers();
});

const MIGRATION_ON = { E2EE_MIGRATION_ENABLED: 'true' };
const server = (extra: Record<string, unknown> = {}) =>
  newServer([owner, other], undefined, { ...MIGRATION_ON, ...extra });
const text = (value: string) => new TextEncoder().encode(value);

/** A pending encrypted invitation row (slice 5-3a), as stored. */
function insertEncryptedInvitation(srv: Server, projectId: string): void {
  srv.db
    .prepare(
      `INSERT INTO e2ee_invitations
         (invitation_id, project_id, invited_by_user_id, email_hash, role,
          token_hash, statement, signature, signer_device_id, created_at,
          expires_at)
       VALUES ('einv_1', ?, ?, ?, 'viewer', ?, 'statement', ?, 'owner_laptop',
               'now', ?)`
    )
    .run(
      projectId,
      OWNER,
      'e'.repeat(64),
      't'.repeat(64),
      's'.repeat(87),
      Date.now() + 3_600_000
    );
}

/** A live encrypted share link row (slice 5-10), as stored. */
function insertEncryptedShareLink(
  srv: Server,
  projectId: string,
  shareId = 'share_1'
): void {
  srv.db
    .prepare(
      `INSERT INTO e2ee_share_links
         (project_id, share_id, token_hash, mode, share_key_hash,
          owner_identity_hash, created_by_user_id, created_at)
       VALUES (?, ?, ?, 'view', ?, ?, ?, 'now')`
    )
    .run(
      projectId,
      shareId,
      createHash('sha256').update(shareId).digest('hex'),
      'k'.repeat(43),
      'o'.repeat(43),
      OWNER
    );
}

/** Revokes every encrypted share link of the project, as 5-10 does. */
function revokeEncryptedShareLinks(srv: Server, projectId: string): void {
  srv.db
    .prepare(
      "UPDATE e2ee_share_links SET revoked_at = 'now' WHERE project_id = ?"
    )
    .run(projectId);
}

// --- Plaintext side ------------------------------------------------------------

async function plaintextProject(
  srv: Server,
  name = 'Secret bracket'
): Promise<ProjectDocument> {
  const created = await srv.call('POST', '/api/projects', {
    body: { name, initialDocument: initialDocument(name) }
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { document: ProjectDocument }).document;
}

async function namedSave(
  srv: Server,
  document: ProjectDocument,
  reason: string
): Promise<ProjectDocument> {
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

function autosave(srv: Server, document: ProjectDocument) {
  return srv.call('PUT', `/api/projects/${document.projectId}/document`, {
    body: {
      projectId: document.projectId,
      expectedVersion: document.version,
      document: { ...document, version: document.version + 1 }
    }
  });
}

interface PlaintextUploadSession {
  uploadSessionId: string;
  uploadUrl: string;
  artifactId: string;
}

async function openPlaintextUpload(
  srv: Server,
  projectId: string
): Promise<PlaintextUploadSession> {
  const created = await srv.call('POST', '/api/uploads', {
    body: {
      projectId,
      fileName: 'secret-part.step',
      contentType: 'model/step',
      kind: 'step-import'
    }
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { session: PlaintextUploadSession })
    .session;
}

const putPlaintextUpload = (
  srv: Server,
  session: PlaintextUploadSession,
  marker: string
) => srv.call('PUT', session.uploadUrl, { raw: text(marker) });

const finalizePlaintextUpload = (
  srv: Server,
  projectId: string,
  session: PlaintextUploadSession
) =>
  srv.call('POST', '/api/artifacts/finalize', {
    body: {
      projectId,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId
    }
  });

async function plaintextUpload(
  srv: Server,
  projectId: string,
  marker: string
): Promise<string> {
  const session = await openPlaintextUpload(srv, projectId);
  expect((await putPlaintextUpload(srv, session, marker)).status).toBe(204);
  expect((await finalizePlaintextUpload(srv, projectId, session)).status).toBe(
    200
  );
  return session.artifactId;
}

/** Plaintext rows the account keeps besides documents and artifacts. */
function seedPlaintextExtras(srv: Server, projectId: string) {
  const now = '2026-10-24T00:00:00.000Z';
  srv.db
    .prepare(
      `INSERT INTO project_measurements
         (project_id, record_version, revision, payload_json, updated_at)
       VALUES (?, 1, 1, '{"label":"Secret gauge"}', ?)`
    )
    .run(projectId, now);
  srv.db
    .prepare(
      `INSERT INTO project_workspace_sessions
         (user_id, project_id, session_id, device_id, sequence, record_json, updated_at)
       VALUES (?, ?, 'ws_1', 'owner_laptop', 1, '{"camera":"Secret view"}', ?)`
    )
    .run(OWNER, projectId, now);
  srv.db
    .prepare(
      `INSERT INTO project_share_links
         (id, project_id, mode, token_hash, created_by_user_id, created_at)
       VALUES (?, ?, 'view', ?, ?, ?)`
    )
    .run(
      `link_${projectId}`,
      projectId,
      'a'.repeat(64),
      OWNER,
      Math.floor(Date.now() / 1000) - 10
    );
}

// --- Staging side ----------------------------------------------------------------

const originals = new WeakMap<Device, Device['fetcher']>();

/**
 * Every request of the device names the lease; the store's one create
 * request becomes the staged group, first version and project info.
 */
function useLease(d: Device, lease: string) {
  const base = originals.get(d) ?? d.fetcher;
  originals.set(d, base);
  const leased = withMigrationLease(base, lease);
  d.fetcher = (path, init = {}) =>
    path === '/api/e2ee/projects' && init.method === 'POST'
      ? stageCreate(leased, init)
      : leased(path, init);
}

async function stageCreate(
  fetcher: (path: string, init?: RequestInit) => Promise<Response>,
  init: RequestInit
): Promise<Response> {
  const { metadata, payload } = decodeE2eeFrame(
    new Uint8Array(init.body as Uint8Array)
  );
  const m = metadata as {
    projectId: string;
    group: unknown;
    version: unknown;
    info: unknown;
  };
  const base = `/api/e2ee/projects/${m.projectId}`;
  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const group = await fetcher(
    `${base}/mls/group-info`,
    jsonInit('POST', m.group)
  );
  if (!group.ok) return group;
  const version = await fetcher(`${base}/document`, {
    method: 'PUT',
    headers: { 'content-type': E2EE_FRAME_CONTENT_TYPE },
    body: encodeE2eeFrame({ version: m.version }, payload)
  });
  if (!version.ok) return version;
  const saved = (await version.json()) as {
    version: number;
    versionHash: string;
    updatedAt: string;
  };
  const info = await fetcher(`${base}/info`, jsonInit('PUT', m.info));
  if (!info.ok) return info;
  return new Response(
    JSON.stringify({
      projectId: m.projectId,
      version: saved.version,
      versionHash: saved.versionHash,
      updatedAt: saved.updatedAt,
      project: {
        projectId: m.projectId,
        documentVersion: saved.version,
        revisionCount: 0,
        lastRevisionId: null,
        updatedAt: saved.updatedAt,
        organization: { status: 'active', pinned: false, sortOrder: 0 }
      }
    }),
    { status: 201 }
  );
}

interface Staging {
  d: Device;
  api: ProjectMigrationsApi;
  lease: string;
  projectId: string;
}

async function startStaging(
  srv: Server,
  projectId: string,
  deviceId = 'owner_laptop',
  account = owner
): Promise<Staging> {
  const d = device(srv, account, deviceId);
  const api = createProjectMigrationsApi(d.fetcher);
  const started = await api.start(projectId, {
    direction: 'encrypt',
    deviceId
  });
  useLease(d, started.leaseId);
  return { d, api, lease: started.leaseId, projectId };
}

/** The plaintext head and each named save, staged as the engine will. */
async function stage(
  s: Staging,
  head: ProjectDocument,
  revisionIds: readonly string[] = head.revisions.map((r) => r.revisionId)
): Promise<ProjectDocument> {
  const created = await s.d.store.createProject({
    name: head.name,
    initialDocument: head
  });
  let document = created.document;
  for (const revisionId of revisionIds) {
    document = await s.d.store.saveRevision({
      projectId: head.projectId,
      reason: 'Staged save state',
      expectedVersion: document.version,
      document,
      savedRevisionId: toRevisionId(revisionId)
    });
  }
  const last = { ...document, version: document.version + 1 };
  await s.d.store.saveProjectDocument({
    projectId: head.projectId,
    expectedVersion: document.version,
    document: last
  });
  return last;
}

/** Not compressible, so its ciphertext is as large as it. */
function noiseInput(seed: number, length = 6000): ArchiveArtifactInput {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (state * 1103515245 + 12345) >>> 0;
    bytes[index] = state >>> 24;
  }
  return {
    fileName: 'secret-picture.png',
    contentType: 'image/png',
    kind: 'reference-image',
    body: new Blob([bytes])
  };
}

function stepInput(marker: string): ArchiveArtifactInput {
  return {
    fileName: 'secret-part.step',
    contentType: 'model/step',
    kind: 'step-import',
    body: new Blob([text(`ISO-10303-21;\n${marker}\n${'DATA;\n'.repeat(80)}`)])
  };
}

function migrationRow(srv: Server, projectId: string) {
  return srv.db
    .prepare('SELECT * FROM e2ee_project_migrations WHERE project_id = ?')
    .get(projectId) as Record<string, unknown> | undefined;
}

function formatOf(srv: Server, projectId: string) {
  return srv.db
    .prepare(
      'SELECT storage_format, document_version FROM projects WHERE id = ?'
    )
    .get(projectId) as { storage_format: number; document_version: number };
}

const STAGED_TABLES = [
  'e2ee_project_groups',
  'e2ee_project_keys',
  'e2ee_project_leaves',
  'e2ee_key_archives',
  'e2ee_mls_commits',
  'e2ee_project_versions',
  'e2ee_project_revisions',
  'e2ee_project_envelopes',
  'e2ee_content_blobs',
  'e2ee_version_blobs'
];

function stagedRows(srv: Server, projectId: string): Record<string, number> {
  return Object.fromEntries(
    STAGED_TABLES.map((table) => [table, count(srv, table, projectId)])
  );
}

const nothingStaged = Object.fromEntries(STAGED_TABLES.map((t) => [t, 0]));

async function errorOf(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

async function codeOf(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { code?: string }).code;
}

async function purgeAll(api: ProjectMigrationsApi, projectId: string) {
  for (let call = 0; call < 50; call++) {
    if ((await api.purge(projectId)).complete) return call + 1;
  }
  throw new Error('The purge never finished.');
}

async function abandonAll(
  api: ProjectMigrationsApi,
  projectId: string,
  lease?: string
) {
  for (let call = 0; call < 50; call++) {
    if ((await api.abandon(projectId, lease)).complete) return;
  }
  throw new Error('The abandon never finished.');
}

// --- The lease -------------------------------------------------------------------

describe('the migration lease', () => {
  it('refuses a second device while the lease is live and hands over once it lapsed', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    const laptop = await startStaging(srv, plain.projectId);
    expect(migrationRow(srv, plain.projectId)).toMatchObject({
      direction: 'encrypt',
      state: 'staging',
      owner_user_id: OWNER,
      device_id: 'owner_laptop',
      source_version: plain.version,
      staged_version: 0
    });

    const desktop = device(srv, owner, 'owner_desktop');
    const desktopApi = createProjectMigrationsApi(desktop.fetcher);
    const refused = await errorOf(
      desktopApi.start(plain.projectId, {
        direction: 'encrypt',
        deviceId: 'owner_desktop'
      })
    );
    expect(refused).toMatchObject({
      status: 409,
      code: 'E2EE_MIGRATION_LEASED'
    });
    expect(refused.details).toMatchObject({ deviceId: 'owner_laptop' });
    // Nor may it abandon the laptop's live staging.
    expect(await errorOf(desktopApi.abandon(plain.projectId))).toMatchObject({
      code: 'E2EE_MIGRATION_LEASED'
    });

    // The holder renews; its own lease resumes too.
    const renewed = await laptop.api.renew(plain.projectId, laptop.lease);
    expect(renewed.migration.leaseHeld).toBe(true);
    await laptop.d.store.createProject({
      name: plain.name,
      initialDocument: plain
    });

    // The lease lapses: the desktop takes over the staging as it stands.
    srv.db
      .prepare('UPDATE e2ee_project_migrations SET lease_expires_at = 1')
      .run();
    const taken = await desktopApi.start(plain.projectId, {
      direction: 'encrypt',
      deviceId: 'owner_desktop'
    });
    expect(taken.migration).toMatchObject({
      deviceId: 'owner_desktop',
      leaseHeld: true,
      stagedVersion: plain.version
    });
    expect(taken.leaseId).not.toBe(laptop.lease);
    // The laptop's next staged write and its renewal are refused.
    expect(
      await errorOf(
        laptop.d.store.saveProjectDocument({
          projectId: plain.projectId,
          expectedVersion: plain.version,
          document: { ...plain, version: plain.version + 1 }
        })
      )
    ).toMatchObject({ status: 409, code: 'E2EE_MIGRATION_LEASE_LOST' });
    expect(
      await errorOf(laptop.api.renew(plain.projectId, laptop.lease))
    ).toMatchObject({ status: 409, code: 'E2EE_MIGRATION_LEASE_LOST' });
    expect(
      await errorOf(laptop.api.cutover(plain.projectId, laptop.lease))
    ).toMatchObject({ status: 409, code: 'E2EE_MIGRATION_LEASE_LOST' });
  });

  it('hands out no lease unless the room confirmed its lock (#914 review)', async () => {
    let room: 'down' | 'throws' | 'up' = 'down';
    const locks: string[] = [];
    const srv = server({
      PROJECT_ROOM: {
        getByName: (name: string) => ({
          fetch: async (request: Request) => {
            if (room === 'throws') throw new Error('room unreachable');
            const { action } = (await request.json()) as { action: string };
            locks.push(`${name}:${action}:${room}`);
            return new Response(null, { status: room === 'up' ? 204 : 500 });
          }
        })
      }
    });
    const plain = await plaintextProject(srv);
    const api = createProjectMigrationsApi(
      device(srv, owner, 'owner_laptop').fetcher
    );
    const startEncrypt = () =>
      api.start(plain.projectId, {
        direction: 'encrypt',
        deviceId: 'owner_laptop'
      });

    // A fresh start whose lock fails, or cannot reach the room, issues
    // nothing and leaves the plaintext writable.
    for (const mode of ['down', 'throws'] as const) {
      room = mode;
      expect(await errorOf(startEncrypt())).toMatchObject({
        status: 503,
        code: 'PROJECT_ROOM_UNAVAILABLE'
      });
      expect(migrationRow(srv, plain.projectId)).toMatchObject({
        state: 'abandoned',
        lease_id: null,
        lease_expires_at: null,
        purge_cursor: null
      });
    }
    expect(locks).toEqual([`${plain.projectId}:lock:down`]);
    const saved = await autosave(srv, plain);
    expect(saved.status).toBe(200);
    const head = (await saved.json()) as ProjectDocument;

    // The room answers again: the retry stages from the new head.
    room = 'up';
    const started = await startEncrypt();
    expect(started.migration).toMatchObject({
      leaseHeld: true,
      sourceVersion: head.version
    });

    // A resumed staging whose lock fails keeps its rows, but no live lease.
    srv.db
      .prepare('UPDATE e2ee_project_migrations SET lease_expires_at = 1')
      .run();
    room = 'down';
    expect(await errorOf(startEncrypt())).toMatchObject({
      status: 503,
      code: 'PROJECT_ROOM_UNAVAILABLE'
    });
    const resumed = migrationRow(srv, plain.projectId)!;
    expect(resumed.state).toBe('staging');
    expect(resumed.lease_id).not.toBe(started.leaseId);
    expect(resumed.lease_expires_at as number).toBeLessThanOrEqual(Date.now());
    room = 'up';
    expect((await startEncrypt()).migration.leaseHeld).toBe(true);
  });

  it('starts only for the owner of a live, unshared plaintext project', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    const otherDevice = device(srv, other, 'other_laptop');
    expect(
      await errorOf(
        createProjectMigrationsApi(otherDevice.fetcher).start(plain.projectId, {
          direction: 'encrypt',
          deviceId: 'other_laptop'
        })
      )
    ).toMatchObject({ status: 404 });
    const laptop = device(srv, owner, 'owner_laptop');
    const api = createProjectMigrationsApi(laptop.fetcher);
    // An uncertified device is refused.
    expect(
      await errorOf(
        api.start(plain.projectId, { direction: 'encrypt', deviceId: 'stolen' })
      )
    ).toMatchObject({ status: 403, code: 'E2EE_DEVICE_NOT_CERTIFIED' });
    // The reverse path is slice 7-3's.
    expect(
      await errorOf(
        api.start(plain.projectId, {
          direction: 'decrypt',
          deviceId: 'owner_laptop'
        })
      )
    ).toMatchObject({ status: 501 });
    // Decision M7(a), since slice 7-4: a member who is not ready to be
    // re-added blocks it (a pending plaintext invitation no longer does:
    // the cutover revokes it, as it does plaintext links).
    srv.db
      .prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, added_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'editor', ?, 1, 1)`
      )
      .run(plain.projectId, OTHER, OWNER);
    expect(
      await errorOf(
        api.start(plain.projectId, {
          direction: 'encrypt',
          deviceId: 'owner_laptop'
        })
      )
    ).toMatchObject({
      status: 409,
      code: 'E2EE_MIGRATION_MEMBERS_NOT_READY',
      details: { members: [{ userId: OTHER, reason: 'not-invited' }] }
    });
    srv.db.prepare('DELETE FROM project_members').run();
    // So does a pending encrypted invitation (slice 5-3a), should one name
    // the project.
    insertEncryptedInvitation(srv, plain.projectId);
    expect(
      await errorOf(
        api.start(plain.projectId, {
          direction: 'encrypt',
          deviceId: 'owner_laptop'
        })
      )
    ).toMatchObject({ status: 409, code: 'E2EE_MIGRATION_SHARED' });
    srv.db.prepare('DELETE FROM e2ee_invitations').run();
    // Not from the recycle bin.
    srv.db
      .prepare("UPDATE projects SET status = 'deleted' WHERE id = ?")
      .run(plain.projectId);
    expect(
      await errorOf(
        api.start(plain.projectId, {
          direction: 'encrypt',
          deviceId: 'owner_laptop'
        })
      )
    ).toMatchObject({ status: 409, code: 'E2EE_MIGRATION_STATE' });
    expect(migrationRow(srv, plain.projectId)).toBeUndefined();
  });
});

// --- Staging -----------------------------------------------------------------------

describe('staging beside the plaintext', () => {
  it('takes ciphertext for a plaintext project from the lease holder only', async () => {
    const srv = server();
    const plain = await namedSave(srv, await plaintextProject(srv), 'Before');
    const s = await startStaging(srv, plain.projectId);
    // Without the lease the encrypted routes see a plaintext project; with
    // a lease that is not the live one, a lost lease; another account,
    // nothing at all.
    const bare = device(srv, owner, 'owner_desktop');
    const unleased = await bare.fetcher(
      `/api/e2ee/projects/${plain.projectId}/versions?since=1`
    );
    expect(unleased.status).toBe(409);
    expect(await codeOf(unleased)).toBe('E2EE_PROJECT_NOT_ENCRYPTED');
    const forged = device(srv, owner, 'owner_desktop');
    useLease(forged, 'F'.repeat(43));
    expect(
      await errorOf(
        forged.store.createProject({ name: plain.name, initialDocument: plain })
      )
    ).toMatchObject({ status: 409, code: 'E2EE_MIGRATION_LEASE_LOST' });
    const stranger = device(srv, other, 'other_laptop');
    useLease(stranger, s.lease);
    expect(
      (
        await stranger.fetcher(
          `/api/e2ee/projects/${plain.projectId}/versions?since=1`
        )
      ).status
    ).toBe(404);
    expect(stagedRows(srv, plain.projectId)).toEqual(nothingStaged);

    // The holder stages the group, versions, a named save, a file,
    // measurements and the project info, beside the untouched plaintext.
    const head = await stage(s, plain);
    await s.d.blobs.archive(plain.projectId, stepInput('Secret source'));
    await s.d.measurements.saveProjectMeasurements({
      projectId: plain.projectId,
      expectedRevision: 0,
      record: {
        projectId: plain.projectId,
        version: 1,
        updatedAt: '2026-10-24T00:00:00.000Z',
        display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' },
        measurements: []
      } as never
    });
    // The first version, one per save state and the head.
    expect(stagedRows(srv, plain.projectId)).toMatchObject({
      e2ee_project_groups: 1,
      e2ee_project_versions: plain.revisions.length + 2,
      e2ee_project_revisions: plain.revisions.length,
      e2ee_content_blobs: 1
    });
    expect(formatOf(srv, plain.projectId)).toEqual({
      storage_format: 1,
      document_version: plain.version
    });
    const status = await s.api.status(plain.projectId, s.lease);
    expect(status.migration).toMatchObject({
      state: 'staging',
      leaseHeld: true,
      stagedVersion: head.version,
      revisionCount: plain.revisions.length,
      blobCount: 1
    });
    expect(status.migration!.stagedHash).toMatch(/^[0-9a-f]{64}$/);
    // The plaintext still reads as before.
    const read = await srv.call('GET', `/api/projects/${plain.projectId}`);
    expect(read.status).toBe(200);
    // A fresh page of the holder reads the staged head back to resume.
    const resumed = device(srv, owner, 'owner_laptop', { mls: s.d.mls });
    useLease(resumed, s.lease);
    expect(await resumed.store.loadProject(plain.projectId)).toMatchObject({
      version: head.version
    });
  });

  it('lands nothing when the lease lapses between the check and the write', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    const s = await startStaging(srv, plain.projectId);
    await s.d.store.createProject({ name: plain.name, initialDocument: plain });
    const db = srv.env.DB as D1Database;
    const batch = db.batch.bind(db);
    let armed = true;
    db.batch = async (statements: D1PreparedStatement[]) => {
      // Only the staged version's own batch, after its checks passed.
      const staged = statements.some((statement) =>
        /UPDATE e2ee_project_migrations/.test(
          (statement as unknown as { sql?: string }).sql ?? ''
        )
      );
      if (armed && staged) {
        armed = false;
        srv.db
          .prepare('UPDATE e2ee_project_migrations SET lease_expires_at = 1')
          .run();
      }
      return batch(statements);
    };
    const before = count(srv, 'e2ee_project_versions', plain.projectId);
    expect(
      await errorOf(
        s.d.store.saveProjectDocument({
          projectId: plain.projectId,
          expectedVersion: plain.version,
          document: { ...plain, version: plain.version + 1 }
        })
      )
    ).toMatchObject({ status: 409, code: 'E2EE_MIGRATION_LEASE_LOST' });
    expect(armed).toBe(false);
    expect(count(srv, 'e2ee_project_versions', plain.projectId)).toBe(before);
    expect(migrationRow(srv, plain.projectId)).toMatchObject({
      staged_version: plain.version
    });
  });

  it('refuses a staged version whose signer’s device list changed while it was written', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    const s = await startStaging(srv, plain.projectId);
    await s.d.store.createProject({ name: plain.name, initialDocument: plain });
    // The device list moves on (a removal, say) after the signer was
    // checked and before the staged version lands, as for a format-2 save.
    const db = srv.env.DB as D1Database;
    const batch = db.batch.bind(db);
    let armed = true;
    db.batch = async (statements: D1PreparedStatement[]) => {
      const staged = statements.some((statement) =>
        /UPDATE e2ee_project_migrations/.test(
          (statement as unknown as { sql?: string }).sql ?? ''
        )
      );
      if (armed && staged) {
        armed = false;
        srv.db
          .prepare(
            `INSERT INTO e2ee_device_list_entries
             SELECT user_id, generation, sequence + 1, entry, signature,
                    substr(entry_hash, 2) || '0', created_at
             FROM e2ee_device_list_entries WHERE user_id = ?
             ORDER BY sequence DESC LIMIT 1`
          )
          .run(OWNER);
      }
      return batch(statements);
    };
    const before = count(srv, 'e2ee_project_versions', plain.projectId);
    expect(
      await errorOf(
        s.d.store.saveProjectDocument({
          projectId: plain.projectId,
          expectedVersion: plain.version,
          document: { ...plain, version: plain.version + 1 }
        })
      )
    ).toMatchObject({ status: 409, code: 'E2EE_DEVICE_LIST_CHANGED' });
    expect(armed).toBe(false);
    expect(count(srv, 'e2ee_project_versions', plain.projectId)).toBe(before);
    expect(migrationRow(srv, plain.projectId)).toMatchObject({
      staged_version: plain.version
    });
  });

  it('refuses plaintext writes, named saves, sharing and the room while staging, and keeps reads', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    await startStaging(srv, plain.projectId);
    const migrating = async (response: Promise<Response>) => {
      const answer = await response;
      expect(answer.status).toBe(409);
      expect(await codeOf(answer)).toBe('PROJECT_MIGRATING');
    };
    await migrating(autosave(srv, plain));
    await migrating(
      srv.call('POST', `/api/projects/${plain.projectId}/revisions`, {
        body: {
          projectId: plain.projectId,
          reason: 'Late',
          expectedVersion: plain.version,
          document: plain
        }
      })
    );
    await migrating(
      srv.call('POST', `/api/projects/${plain.projectId}/collaboration/ticket`)
    );
    await migrating(
      worker.fetch(
        new Request(
          `https://example.com/api/projects/${plain.projectId}/collaboration`,
          {
            headers: {
              upgrade: 'websocket',
              origin: 'https://example.com',
              'x-openzcad-development-user': OWNER
            }
          }
        ),
        srv.env
      )
    );
    await migrating(
      srv.call('POST', `/api/projects/${plain.projectId}/share-links`, {
        body: { mode: 'view' }
      })
    );
    await migrating(
      srv.call('POST', `/api/projects/${plain.projectId}/duplicate`, {
        body: {}
      })
    );
    await migrating(
      srv.call('PUT', `/api/projects/${plain.projectId}/measurements`, {
        body: {}
      })
    );
    await migrating(
      srv.call('POST', '/api/uploads', {
        body: {
          projectId: plain.projectId,
          fileName: 'late.step',
          contentType: 'model/step',
          kind: 'step-import'
        }
      })
    );
    // An outsider learns nothing.
    expect(
      (
        await srv.call('PUT', `/api/projects/${plain.projectId}/document`, {
          user: OTHER,
          body: {
            projectId: plain.projectId,
            expectedVersion: plain.version,
            document: { ...plain, version: plain.version + 1 }
          }
        })
      ).status
    ).toBe(404);
    // Reads and shelf organization keep working.
    expect(
      (await srv.call('GET', `/api/projects/${plain.projectId}`)).status
    ).toBe(200);
    expect(
      (await srv.call('GET', `/api/projects/${plain.projectId}/revisions`))
        .status
    ).toBe(200);
    expect(
      (
        await srv.call('PATCH', `/api/projects/${plain.projectId}`, {
          body: { pinned: true }
        })
      ).status
    ).toBe(200);
  });

  it('lets only the lease that opened a staged encrypted upload advance it (#914 review)', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    const laptop = await startStaging(srv, plain.projectId);
    const blobId = 'b'.repeat(32);
    const openUpload = async (s: Staging) => {
      const opened = await s.d.fetcher(
        `/api/e2ee/projects/${plain.projectId}/blobs/uploads`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ blobId, kind: 'import-source' })
        }
      );
      expect(opened.status).toBe(201);
      return ((await opened.json()) as { session: { uploadSessionId: string } })
        .session.uploadSessionId;
    };
    const startMultipart = async (s: Staging, session: string) => {
      const started = await s.d.fetcher(`/api/uploads/${session}/multipart`, {
        method: 'POST'
      });
      expect(started.status).toBe(201);
      return ((await started.json()) as { uploadId: string }).uploadId;
    };
    const putPart = (
      s: Staging,
      session: string,
      uploadId: string,
      part: number
    ) =>
      s.d.fetcher(
        `/api/uploads/${session}/parts/${part}?uploadId=${uploadId}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: text(`ciphertext part ${part}`)
        }
      );
    const parts = (session: string) =>
      srv.db
        .prepare(
          `SELECT part_number, etag FROM artifact_upload_parts
           WHERE upload_session_id = ? ORDER BY part_number`
        )
        .all(session) as { part_number: number; etag: string | null }[];
    const recorded = (session: string) =>
      parts(session).map((part) => [part.part_number, part.etag !== null]);

    const stale = await openUpload(laptop);
    const staleUpload = await startMultipart(laptop, stale);
    expect((await putPart(laptop, stale, staleUpload, 1)).status).toBe(200);

    // The desktop takes the lease over while the laptop's part is in R2:
    // the part's record lands nothing.
    let desktop: Staging | undefined;
    interface ResumedUpload {
      uploadPart(part: number, body: ArrayBuffer): Promise<unknown>;
    }
    const original = srv.bucket.resumeMultipartUpload;
    const resume = original as unknown as (
      key: string,
      id: string
    ) => ResumedUpload;
    srv.bucket.resumeMultipartUpload = vi.fn((key: string, id: string) => {
      const upload = resume(key, id);
      return {
        ...upload,
        uploadPart: async (part: number, body: ArrayBuffer) => {
          const uploaded = await upload.uploadPart(part, body);
          srv.db
            .prepare('UPDATE e2ee_project_migrations SET lease_expires_at = 1')
            .run();
          desktop = await startStaging(srv, plain.projectId, 'owner_desktop');
          return uploaded;
        }
      };
    });
    const raced = await putPart(laptop, stale, staleUpload, 2);
    srv.bucket.resumeMultipartUpload = original;
    expect(desktop).toBeDefined();
    expect(raced.status).toBe(409);
    expect(await codeOf(raced)).toBe('E2EE_MIGRATION_LEASE_LOST');
    expect(recorded(stale)).toEqual([
      [1, true],
      [2, false]
    ]);

    // After the takeover the laptop reserves, records and completes nothing.
    const late = await putPart(laptop, stale, staleUpload, 3);
    expect(late.status).toBe(409);
    expect(await codeOf(late)).toBe('E2EE_MIGRATION_LEASE_LOST');
    const completed = await laptop.d.fetcher(
      `/api/uploads/${stale}/multipart/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          uploadId: staleUpload,
          parts: [{ partNumber: 1, etag: parts(stale)[0]!.etag }]
        })
      }
    );
    expect(completed.status).toBe(409);
    expect(await codeOf(completed)).toBe('E2EE_MIGRATION_LEASE_LOST');
    expect(parts(stale)).toHaveLength(2);
    expect(
      srv.db
        .prepare('SELECT reservation_state FROM upload_sessions WHERE id = ?')
        .get(stale)
    ).toEqual({ reservation_state: 'uploading' });

    // The new holder opening the same blob drops the stale session and
    // uploads under a fresh one.
    const fresh = await openUpload(desktop!);
    expect(fresh).not.toBe(stale);
    expect(
      srv.db.prepare('SELECT id FROM upload_sessions WHERE id = ?').get(stale)
    ).toBeUndefined();
    expect(srv.bucket.multipart.has(staleUpload)).toBe(false);
    const freshUpload = await startMultipart(desktop!, fresh);
    expect((await putPart(desktop!, fresh, freshUpload, 1)).status).toBe(200);
    expect(recorded(fresh)).toEqual([[1, true]]);
  });

  it('completes nothing for the stale holder when the lease moves during R2’s own completion (#918 follow-up)', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    const laptop = await startStaging(srv, plain.projectId);
    const blobId = 'c'.repeat(32);
    const objectKey = `e2ee/${plain.projectId}/${blobId}`;
    const openUpload = async (s: Staging) => {
      const opened = await s.d.fetcher(
        `/api/e2ee/projects/${plain.projectId}/blobs/uploads`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ blobId, kind: 'import-source' })
        }
      );
      expect(opened.status).toBe(201);
      return ((await opened.json()) as { session: { uploadSessionId: string } })
        .session.uploadSessionId;
    };
    const stale = await openUpload(laptop);
    const started = await laptop.d.fetcher(`/api/uploads/${stale}/multipart`, {
      method: 'POST'
    });
    const staleUpload = ((await started.json()) as { uploadId: string })
      .uploadId;
    const part = await laptop.d.fetcher(
      `/api/uploads/${stale}/parts/1?uploadId=${staleUpload}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: text('ciphertext')
      }
    );
    expect(part.status).toBe(200);
    const { etag } = srv.db
      .prepare(
        'SELECT etag FROM artifact_upload_parts WHERE upload_session_id = ?'
      )
      .get(stale) as { etag: string };

    // The desktop takes the lease over while R2 completes the laptop's
    // object.
    let desktop: Staging | undefined;
    interface ResumedUpload {
      complete(parts: unknown[]): Promise<unknown>;
    }
    const original = srv.bucket.resumeMultipartUpload;
    const resume = original as unknown as (
      key: string,
      id: string
    ) => ResumedUpload;
    srv.bucket.resumeMultipartUpload = vi.fn((key: string, id: string) => {
      const upload = resume(key, id);
      return {
        ...upload,
        complete: async (parts: unknown[]) => {
          const completed = await upload.complete(parts);
          srv.db
            .prepare('UPDATE e2ee_project_migrations SET lease_expires_at = 1')
            .run();
          desktop = await startStaging(srv, plain.projectId, 'owner_desktop');
          return completed;
        }
      };
    });
    const raced = await laptop.d.fetcher(
      `/api/uploads/${stale}/multipart/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          uploadId: staleUpload,
          parts: [{ partNumber: 1, etag }]
        })
      }
    );
    srv.bucket.resumeMultipartUpload = original;
    expect(desktop).toBeDefined();
    expect(raced.status).toBe(409);
    expect(await codeOf(raced)).toBe('E2EE_MIGRATION_LEASE_LOST');
    // The stale session is released at once: no reservation, no object.
    expect(
      srv.db.prepare('SELECT id FROM upload_sessions WHERE id = ?').get(stale)
    ).toBeUndefined();
    expect(srv.bucket.objects.has(objectKey)).toBe(false);

    // The new holder uploads the same blob under a fresh session.
    const fresh = await openUpload(desktop!);
    expect(fresh).not.toBe(stale);
    const freshStarted = await desktop!.d.fetcher(
      `/api/uploads/${fresh}/multipart`,
      { method: 'POST' }
    );
    expect(freshStarted.status).toBe(201);
  });

  it('reconciles no completion for the stale holder once the lease moved (#918 follow-up)', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    const laptop = await startStaging(srv, plain.projectId);
    const blobId = 'd'.repeat(32);
    const objectKey = `e2ee/${plain.projectId}/${blobId}`;
    const opened = await laptop.d.fetcher(
      `/api/e2ee/projects/${plain.projectId}/blobs/uploads`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blobId, kind: 'import-source' })
      }
    );
    const stale = (
      (await opened.json()) as { session: { uploadSessionId: string } }
    ).session.uploadSessionId;
    const started = await laptop.d.fetcher(`/api/uploads/${stale}/multipart`, {
      method: 'POST'
    });
    const staleUpload = ((await started.json()) as { uploadId: string })
      .uploadId;
    expect(
      (
        await laptop.d.fetcher(
          `/api/uploads/${stale}/parts/1?uploadId=${staleUpload}`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: text('ciphertext')
          }
        )
      ).status
    ).toBe(200);
    const { etag } = srv.db
      .prepare(
        'SELECT etag FROM artifact_upload_parts WHERE upload_session_id = ?'
      )
      .get(stale) as { etag: string };
    // R2 completed the object, but the response that would have recorded
    // it was lost: the session is still completing.
    await (
      srv.bucket.resumeMultipartUpload as unknown as (
        key: string,
        id: string
      ) => { complete(parts: unknown[]): Promise<unknown> }
    )(objectKey, staleUpload).complete([{ partNumber: 1, etag }]);
    srv.db
      .prepare(
        `UPDATE upload_sessions
         SET reservation_state = 'completing', completion_started_at = ?
         WHERE id = ?`
      )
      .run(Date.now(), stale);
    // The laptop retries; the desktop takes the lease over while the
    // retry reads the object back.
    let desktop: Staging | undefined;
    const originalHead = srv.bucket.head;
    const head = originalHead as unknown as (key: string) => Promise<unknown>;
    srv.bucket.head = vi.fn(async (key: string) => {
      const stored = await head(key);
      if (key === objectKey && !desktop) {
        srv.db
          .prepare('UPDATE e2ee_project_migrations SET lease_expires_at = 1')
          .run();
        desktop = await startStaging(srv, plain.projectId, 'owner_desktop');
      }
      return stored;
    });
    const retried = await laptop.d.fetcher(
      `/api/uploads/${stale}/multipart/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          uploadId: staleUpload,
          parts: [{ partNumber: 1, etag }]
        })
      }
    );
    srv.bucket.head = originalHead;
    expect(desktop).toBeDefined();
    expect(retried.status).toBe(409);
    expect(await codeOf(retried)).toBe('E2EE_MIGRATION_LEASE_LOST');
    expect(
      srv.db.prepare('SELECT id FROM upload_sessions WHERE id = ?').get(stale)
    ).toBeUndefined();
    expect(srv.bucket.objects.has(objectKey)).toBe(false);
  });

  it('lands nothing from a plaintext upload session opened before staging began (#914 review)', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    // One session with its bytes uploaded, one still empty.
    const uploaded = await openPlaintextUpload(srv, plain.projectId);
    expect(
      (await putPlaintextUpload(srv, uploaded, 'Secret late part')).status
    ).toBe(204);
    const empty = await openPlaintextUpload(srv, plain.projectId);
    const s = await startStaging(srv, plain.projectId);
    const migrating = async (response: Promise<Response>) => {
      const answer = await response;
      expect(answer.status).toBe(409);
      expect(await codeOf(answer)).toBe('PROJECT_MIGRATING');
    };
    await migrating(finalizePlaintextUpload(srv, plain.projectId, uploaded));
    await migrating(putPlaintextUpload(srv, empty, 'Secret later part'));
    await migrating(
      srv.call('POST', `/api/uploads/${empty.uploadSessionId}/multipart`)
    );
    expect(count(srv, 'artifacts', plain.projectId)).toBe(0);
    // The sessions stay (an abandon gives them back; a cutover's purge
    // discards them), so abandoning lets the upload finish as plaintext.
    await abandonAll(s.api, plain.projectId, s.lease);
    expect(
      (await finalizePlaintextUpload(srv, plain.projectId, uploaded)).status
    ).toBe(200);
    expect(count(srv, 'artifacts', plain.projectId)).toBe(1);
  });

  it('lands no plaintext artifact when staging begins between the check and the write (#914 review)', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    const session = await openPlaintextUpload(srv, plain.projectId);
    expect(
      (await putPlaintextUpload(srv, session, 'Secret racing part')).status
    ).toBe(204);
    // The session passed every check; staging starts before its artifact
    // row lands, as if the owner's browser started it at that moment.
    const db = srv.env.DB as D1Database;
    const batch = db.batch.bind(db);
    let armed = true;
    db.batch = async (statements: D1PreparedStatement[]) => {
      const finalizing = statements.some((statement) =>
        /INSERT INTO artifacts/.test(
          (statement as unknown as { sql?: string }).sql ?? ''
        )
      );
      if (armed && finalizing) {
        armed = false;
        await startStaging(srv, plain.projectId);
      }
      return batch(statements);
    };
    const answer = await finalizePlaintextUpload(srv, plain.projectId, session);
    expect(armed).toBe(false);
    expect(answer.status).toBe(409);
    expect(await codeOf(answer)).toBe('PROJECT_MIGRATING');
    expect(count(srv, 'artifacts', plain.projectId)).toBe(0);
    expect(migrationRow(srv, plain.projectId)).toMatchObject({
      state: 'staging'
    });
  });
});

// --- Cutover ------------------------------------------------------------------------

describe('the cutover', () => {
  it('refuses until every retained save state is staged, and when the plaintext moved', async () => {
    const srv = server();
    const first = await namedSave(srv, await plaintextProject(srv), 'One');
    const plain = await namedSave(srv, first, 'Two');
    const ids = plain.revisions.map((r) => r.revisionId as string);
    const missing = ids.at(-1)!;
    const s = await startStaging(srv, plain.projectId);
    expect(
      await errorOf(s.api.cutover(plain.projectId, s.lease))
    ).toMatchObject({ status: 409, code: 'E2EE_MIGRATION_NOT_STAGED' });
    // Decision M9: one save state missing.
    await stage(s, plain, ids.slice(0, -1));
    const incomplete = await errorOf(s.api.cutover(plain.projectId, s.lease));
    expect(incomplete).toMatchObject({
      status: 409,
      code: 'E2EE_MIGRATION_REVISIONS_INCOMPLETE'
    });
    expect(incomplete.details).toMatchObject({ revisionIds: [missing] });
    expect(formatOf(srv, plain.projectId).storage_format).toBe(1);
    // A save state naming a version whose body is gone does not count
    // either: the first staged version's body was pruned by the next.
    const pruned = srv.db
      .prepare(
        `SELECT document_version, version_hash FROM e2ee_project_versions
         WHERE project_id = ? AND envelope_key IS NULL AND envelope_inline IS NULL
         ORDER BY document_version LIMIT 1`
      )
      .get(plain.projectId) as {
      document_version: number;
      version_hash: string;
    };
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_revisions
           (project_id, revision_id, document_version, version_hash, created_at)
         VALUES (?, ?, ?, ?, 'now')`
      )
      .run(
        plain.projectId,
        missing,
        pruned.document_version,
        pruned.version_hash
      );
    expect(
      await errorOf(s.api.cutover(plain.projectId, s.lease))
    ).toMatchObject({ code: 'E2EE_MIGRATION_REVISIONS_INCOMPLETE' });
    srv.db
      .prepare('DELETE FROM e2ee_project_revisions WHERE revision_id = ?')
      .run(missing);
    const head = migrationRow(srv, plain.projectId)!.staged_version as number;
    const named = await s.d.store.saveRevision({
      projectId: plain.projectId,
      reason: 'Two',
      expectedVersion: head,
      document: { ...plain, version: head },
      savedRevisionId: toRevisionId(missing)
    });
    await s.d.store.saveProjectDocument({
      projectId: plain.projectId,
      expectedVersion: named.version,
      document: { ...named, version: named.version + 1 }
    });
    // The plaintext measurements moved meanwhile (a write that raced the
    // start): stale.
    srv.db
      .prepare(
        `INSERT INTO project_measurements
           (project_id, record_version, revision, payload_json, updated_at)
         VALUES (?, 1, 1, '{}', 'now')`
      )
      .run(plain.projectId);
    expect(
      await errorOf(s.api.cutover(plain.projectId, s.lease))
    ).toMatchObject({ status: 409, code: 'E2EE_MIGRATION_STALE' });
    srv.db.prepare('DELETE FROM project_measurements').run();
    // So did the plaintext head.
    srv.db
      .prepare('UPDATE projects SET document_version = document_version + 1')
      .run();
    expect(
      await errorOf(s.api.cutover(plain.projectId, s.lease))
    ).toMatchObject({ status: 409, code: 'E2EE_MIGRATION_STALE' });
    srv.db
      .prepare('UPDATE projects SET document_version = document_version - 1')
      .run();
    // Decision M7(a) holds at the cutover too: a member who joined
    // meanwhile (a plaintext invitation accepted during the staging) was
    // never re-added.
    srv.db
      .prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, added_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'viewer', ?, 1, 1)`
      )
      .run(plain.projectId, OTHER, OWNER);
    expect(
      await errorOf(s.api.cutover(plain.projectId, s.lease))
    ).toMatchObject({
      status: 409,
      code: 'E2EE_MIGRATION_MEMBERS_NOT_READY',
      details: { members: [{ userId: OTHER, reason: 'not-readded' }] }
    });
    srv.db.prepare('DELETE FROM project_members').run();
    const cut = await s.api.cutover(plain.projectId, s.lease);
    expect(cut.migration).toMatchObject({
      state: 'cutover',
      revisionCount: ids.length
    });
  });

  it('refuses to start or cut over while a live encrypted share link names the project, and goes ahead once it is revoked', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    const d = device(srv, owner, 'owner_laptop');
    const api = createProjectMigrationsApi(d.fetcher);
    // A link left from an encrypted stint of the project (slice 5-10).
    insertEncryptedShareLink(srv, plain.projectId);
    expect(
      await errorOf(
        api.start(plain.projectId, {
          direction: 'encrypt',
          deviceId: 'owner_laptop'
        })
      )
    ).toMatchObject({ status: 409, code: 'E2EE_MIGRATION_SHARED' });
    expect(migrationRow(srv, plain.projectId)).toBeUndefined();
    revokeEncryptedShareLinks(srv, plain.projectId);
    const s = await startStaging(srv, plain.projectId);
    await stage(s, plain, []);
    // One goes live while staging: the cutover refuses, in its own batch.
    insertEncryptedShareLink(srv, plain.projectId, 'share_2');
    expect(
      await errorOf(s.api.cutover(plain.projectId, s.lease))
    ).toMatchObject({ status: 409, code: 'E2EE_MIGRATION_SHARED' });
    expect(formatOf(srv, plain.projectId).storage_format).toBe(1);
    revokeEncryptedShareLinks(srv, plain.projectId);
    expect(
      (await s.api.cutover(plain.projectId, s.lease)).migration
    ).toMatchObject({ state: 'cutover' });
  });

  it('refuses a staged head that is not newer than the plaintext head', async () => {
    const srv = server();
    let plain = await plaintextProject(srv);
    for (let edit = 0; edit < 4; edit++) {
      const saved = await autosave(srv, plain);
      expect(saved.status).toBe(200);
      plain = { ...plain, version: plain.version + 1 };
    }
    const s = await startStaging(srv, plain.projectId);
    // Staged from version 1: its head (2) trails the plaintext head (5).
    const head = await stage(s, { ...plain, version: 1 }, []);
    expect(head.version).toBeLessThanOrEqual(plain.version);
    const behind = await errorOf(s.api.cutover(plain.projectId, s.lease));
    expect(behind).toMatchObject({
      status: 409,
      code: 'E2EE_MIGRATION_HEAD_BEHIND'
    });
    expect(behind.details).toMatchObject({ sourceVersion: plain.version });
    // Moving the staged head past it is enough.
    await s.d.store.saveProjectDocument({
      projectId: plain.projectId,
      expectedVersion: head.version,
      document: { ...head, version: plain.version + 1 }
    });
    expect(
      (await s.api.cutover(plain.projectId, s.lease)).migration
    ).toMatchObject({
      state: 'cutover',
      stagedVersion: plain.version + 1
    });
    expect(formatOf(srv, plain.projectId).document_version).toBe(
      plain.version + 1
    );
  });

  it('flips the format and revokes links and invitations in one batch', async () => {
    const srv = server();
    const plain = await namedSave(srv, await plaintextProject(srv), 'Named');
    seedPlaintextExtras(srv, plain.projectId);
    srv.db.prepare('DELETE FROM project_measurements').run();
    const now = Math.floor(Date.now() / 1000);
    srv.db
      .prepare(
        `INSERT INTO project_invitations
           (id, project_id, email, role, token_hash, invited_by_user_id,
            created_at, expires_at)
         VALUES ('inv_old', ?, 'friend@example.com', 'viewer', ?, ?, ?, ?)`
      )
      .run(plain.projectId, 'd'.repeat(64), OWNER, now - 7200, now - 3600);
    const s = await startStaging(srv, plain.projectId);
    const head = await stage(s, plain);

    // A failure part-way through rolls the whole cutover back.
    srv.db
      .exec(`CREATE TRIGGER fail_link_revoke BEFORE UPDATE ON project_share_links
      BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    await expect(s.api.cutover(plain.projectId, s.lease)).rejects.toThrow();
    expect(formatOf(srv, plain.projectId).storage_format).toBe(1);
    expect(migrationRow(srv, plain.projectId)).toMatchObject({
      state: 'staging'
    });
    expect(rows(srv, 'SELECT revoked_at FROM project_share_links')).toEqual([
      { revoked_at: null }
    ]);
    srv.db.exec('DROP TRIGGER fail_link_revoke');

    const cut = await s.api.cutover(plain.projectId, s.lease);
    expect(cut).toMatchObject({
      revokedShareLinks: 1,
      revokedInvitations: 1,
      migration: { state: 'cutover', stagedVersion: head.version }
    });
    expect(formatOf(srv, plain.projectId)).toEqual({
      storage_format: 2,
      document_version: head.version
    });
    expect(
      rows<{ revoked_at: number | null }>(
        srv,
        'SELECT revoked_at FROM project_share_links'
      )[0]!.revoked_at
    ).not.toBeNull();
    expect(
      rows<{ revoked_at: number | null }>(
        srv,
        'SELECT revoked_at FROM project_invitations'
      )[0]!.revoked_at
    ).not.toBeNull();
    // The plaintext routes now meet an encrypted project; a fresh device
    // of the owner opens it and its save states.
    const plainRead = await srv.call('GET', `/api/projects/${plain.projectId}`);
    expect(plainRead.status).toBe(409);
    expect(await codeOf(plainRead)).toBe('PROJECT_FORMAT_UNSUPPORTED');
    const desktop = device(srv, owner, 'owner_desktop');
    expect(await desktop.store.loadProject(plain.projectId)).toMatchObject({
      version: head.version
    });
    expect(
      (await desktop.store.listRevisions(plain.projectId)).revisions
        .map((revision) => revision.revisionId)
        .sort()
    ).toEqual(plain.revisions.map((revision) => revision.revisionId).sort());
    // The lease is spent: staging writes now go through ordinary access.
    expect(migrationRow(srv, plain.projectId)).toMatchObject({
      lease_id: null,
      purge_cursor: 'room'
    });
  });
});

// --- Abandon --------------------------------------------------------------------------

describe('abandoning', () => {
  it('drops every staged row and object and unlocks the plaintext', async () => {
    const srv = server();
    const plain = await namedSave(srv, await plaintextProject(srv), 'Named');
    const s = await startStaging(srv, plain.projectId);
    await stage(s, plain);
    await s.d.blobs.archive(plain.projectId, stepInput('Secret source'));
    const stagedKeys = () =>
      [...srv.bucket.objects.keys()].filter((key) =>
        key.startsWith(`e2ee/${plain.projectId}/`)
      );
    expect(stagedKeys().length).toBeGreaterThan(0);
    // The first delete fails part-way; the next call carries on.
    srv.bucket.delete.mockRejectedValueOnce(new Error('R2 is down'));
    await expect(s.api.abandon(plain.projectId, s.lease)).rejects.toThrow();
    expect(migrationRow(srv, plain.projectId)).toMatchObject({
      state: 'abandoned',
      purge_cursor: 'cleanup'
    });
    // Unlocked at once, while the cleanup is still pending.
    expect((await autosave(srv, plain)).status).toBe(200);
    // A fresh start waits for the cleanup.
    const desktopApi = createProjectMigrationsApi(
      device(srv, owner, 'owner_desktop').fetcher
    );
    expect(
      await errorOf(
        desktopApi.start(plain.projectId, {
          direction: 'encrypt',
          deviceId: 'owner_desktop'
        })
      )
    ).toMatchObject({ status: 409, code: 'E2EE_MIGRATION_CLEANUP_PENDING' });
    await abandonAll(desktopApi, plain.projectId);
    expect(stagedRows(srv, plain.projectId)).toEqual(nothingStaged);
    expect(stagedKeys()).toEqual([]);
    expect(
      rows(
        srv,
        'SELECT * FROM upload_sessions WHERE project_id = ?',
        plain.projectId
      )
    ).toEqual([]);
    expect(migrationRow(srv, plain.projectId)).toMatchObject({
      state: 'abandoned',
      purge_cursor: null,
      staged_version: 0
    });
    // And it can start over cleanly, from the plaintext as it is now.
    const again = await desktopApi.start(plain.projectId, {
      direction: 'encrypt',
      deviceId: 'owner_desktop'
    });
    expect(again.migration).toMatchObject({
      state: 'staging',
      stagedVersion: 0,
      sourceVersion: plain.version + 1
    });
  });
});

// --- Purge ----------------------------------------------------------------------------

interface RoomServer extends Server {
  storage: Map<string, Map<string, unknown>>;
}

/** The real room class behind PROJECT_ROOM, its storage seeded per project. */
function roomServer(
  seed: (projectId: string) => Map<string, unknown>
): RoomServer {
  const rooms = new Map<string, ProjectCollaborationRoom>();
  const storage = new Map<string, Map<string, unknown>>();
  let env: Record<string, unknown> = {};
  const namespace = {
    getByName: (name: string) => {
      let room = rooms.get(name);
      if (!room) {
        const { context, values } = createRoomContext(seed(name));
        storage.set(name, values);
        room = new ProjectCollaborationRoom(context, env);
        context.activate(room);
        rooms.set(name, room);
      }
      return room;
    }
  };
  const srv = server({ PROJECT_ROOM: namespace });
  env = srv.env;
  return Object.assign(srv, { storage });
}

describe('purging the plaintext', () => {
  it('resumes after an interruption and leaves no plaintext in D1, R2 or the room', async () => {
    let plainDocument: ProjectDocument | null = null;
    const srv = roomServer((projectId): Map<string, unknown> =>
      plainDocument && projectId === plainDocument.projectId
        ? new Map<string, unknown>([
            [
              'room:meta',
              {
                schema: 1,
                projectId,
                latestVersion: plainDocument.version,
                historyVersions: [plainDocument.version - 1]
              }
            ],
            ['room:latest', plainDocument],
            [`room:history:${plainDocument.version - 1}`, plainDocument]
          ])
        : new Map<string, unknown>()
    );
    const first = await namedSave(
      srv,
      await plaintextProject(srv),
      'Secret one'
    );
    const plain = await namedSave(srv, first, 'Secret two');
    await plaintextUpload(srv, plain.projectId, 'Secret artifact');
    seedPlaintextExtras(srv, plain.projectId);
    srv.db
      .prepare(
        `INSERT INTO project_storage_assets
           (id, project_id, kind, object_key, checksum_sha256, logical_bytes,
            stored_bytes, content_encoding, created_at)
         VALUES ('asset_1', ?, 'step-source', ?, ?, 15, 15, 'identity', 'now')`
      )
      .run(plain.projectId, `assets/${plain.projectId}/secret`, 'e'.repeat(64));
    srv.bucket.objects.set(
      `assets/${plain.projectId}/secret`,
      text('Secret asset').buffer
    );
    plainDocument = plain;
    const s = await startStaging(srv, plain.projectId);
    // The start locked the room; its plaintext stays until the purge.
    expect(srv.storage.get(plain.projectId)!.has('room:latest')).toBe(true);
    const head = await stage(s, plain);
    await s.api.cutover(plain.projectId, s.lease);
    const plaintextKeys = () =>
      [...srv.bucket.objects.keys()].filter((key) => !key.startsWith('e2ee/'));
    expect(plaintextKeys().length).toBeGreaterThan(2);

    // Interrupted: an object delete fails once, part-way through.
    const remove = srv.bucket.delete;
    let failed = false;
    srv.bucket.delete = vi.fn(async (key: string) => {
      if (!failed && !key.startsWith('e2ee/')) {
        failed = true;
        throw new Error('R2 is down');
      }
      srv.bucket.objects.delete(key);
    });
    await expect(s.api.purge(plain.projectId)).rejects.toThrow();
    expect(failed).toBe(true);
    srv.bucket.delete = remove;
    expect(migrationRow(srv, plain.projectId)!.state).toBe('purging');
    // Another device of the owner resumes it, without the lease.
    const desktopApi = createProjectMigrationsApi(
      device(srv, owner, 'owner_desktop').fetcher
    );
    await purgeAll(desktopApi, plain.projectId);
    const finished = migrationRow(srv, plain.projectId)!;
    expect(finished).toMatchObject({ state: 'done', purge_cursor: null });
    expect(finished.purged_objects as number).toBeGreaterThan(2);
    expect((await desktopApi.purge(plain.projectId)).complete).toBe(true);

    // D1: the row keeps no name or document; nothing plaintext remains.
    expect(
      srv.db
        .prepare(
          'SELECT name, document_json, document_object_id, document_bytes FROM projects WHERE id = ?'
        )
        .get(plain.projectId)
    ).toEqual({
      name: '',
      document_json: 'e2ee-v1',
      document_object_id: null,
      document_bytes: 0
    });
    for (const table of [
      'revisions',
      'project_document_objects',
      'project_storage_assets',
      'artifacts',
      'project_measurements',
      'project_workspace_sessions'
    ]) {
      expect(count(srv, table, plain.projectId), table).toBe(0);
    }
    expect(
      rows(
        srv,
        'SELECT * FROM upload_sessions WHERE project_id = ?',
        plain.projectId
      )
    ).toEqual([]);
    const tables = rows<{ name: string }>(
      srv,
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).map((row) => row.name);
    const database = tables
      .map((table) => JSON.stringify(rows(srv, `SELECT * FROM "${table}"`)))
      .join('\n');
    for (const marker of [
      'Secret bracket',
      'Secret one',
      'Secret two',
      'Secret gauge',
      'Secret view'
    ]) {
      expect(database, marker).not.toContain(marker);
    }
    // R2: only ciphertext.
    expect(plaintextKeys()).toEqual([]);
    // The room: no plaintext key left.
    const room = srv.storage.get(plain.projectId)!;
    expect(
      [...room.keys()].filter(
        (key) =>
          key === 'room:latest' ||
          key === 'room:meta' ||
          key.startsWith('room:history:') ||
          key === 'room:source-archives'
      )
    ).toEqual([]);
    // And the encrypted project opens on a fresh device.
    const fresh = device(srv, owner, 'owner_desktop');
    expect(await fresh.store.loadProject(plain.projectId)).toMatchObject({
      version: head.version
    });
  });

  it('keeps an object another project still names, and a copy keeps working', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    const artifactId = await plaintextUpload(
      srv,
      plain.projectId,
      'Shared bytes'
    );
    const duplicated = await srv.call(
      'POST',
      `/api/projects/${plain.projectId}/duplicate`,
      { body: {} }
    );
    expect(duplicated.status).toBe(201);
    const copy = ((await duplicated.json()) as { document: ProjectDocument })
      .document;
    const copyArtifact = await plaintextUpload(
      srv,
      copy.projectId,
      'Copy bytes'
    );
    // A row of the copy names one of the source's objects (as a shared
    // reference would).
    const sourceKey = (
      srv.db
        .prepare('SELECT object_key FROM artifacts WHERE id = ?')
        .get(artifactId) as { object_key: string }
    ).object_key;
    srv.db
      .prepare(
        `INSERT INTO project_storage_assets
           (id, project_id, kind, object_key, checksum_sha256, logical_bytes,
            stored_bytes, content_encoding, created_at)
         VALUES ('asset_shared', ?, 'step-source', ?, ?, 12, 12, 'identity', 'now')`
      )
      .run(copy.projectId, sourceKey, 'f'.repeat(64));
    const sourceDocuments = rows<{ object_key: string }>(
      srv,
      'SELECT object_key FROM project_document_objects WHERE project_id = ?',
      plain.projectId
    ).map((row) => row.object_key);
    expect(sourceDocuments.length).toBeGreaterThan(0);

    const s = await startStaging(srv, plain.projectId);
    await stage(s, plain);
    await s.api.cutover(plain.projectId, s.lease);
    await purgeAll(s.api, plain.projectId);

    // The source's own objects are gone; the one the copy names stays.
    for (const key of sourceDocuments) {
      expect(srv.bucket.objects.has(key), key).toBe(false);
    }
    expect(srv.bucket.objects.has(sourceKey)).toBe(true);
    expect(count(srv, 'artifacts', plain.projectId)).toBe(0);
    // The copy is untouched: its document, revisions and files load.
    expect(
      (await srv.call('GET', `/api/projects/${copy.projectId}`)).status
    ).toBe(200);
    const download = await srv.call(
      'GET',
      `/api/artifacts/${copyArtifact}/download`
    );
    expect(download.status).toBe(200);
    expect(new TextDecoder().decode(await download.arrayBuffer())).toBe(
      'Copy bytes'
    );
  });
});

// --- Quota ------------------------------------------------------------------------------

describe('quota (decision M10)', () => {
  it('counts staged ciphertext toward nothing until the cutover', async () => {
    const srv = server();
    const plain = await namedSave(srv, await plaintextProject(srv), 'Named');
    await plaintextUpload(srv, plain.projectId, 'Plain artifact');
    const usage = () =>
      (
        srv.db
          .prepare(
            'SELECT finalized_bytes FROM artifact_account_usage WHERE owner_user_id = ?'
          )
          .get(OWNER) as { finalized_bytes: number }
      ).finalized_bytes;
    const reported = async () => {
      const storage = await srv.call('GET', '/api/account/storage');
      // The report reconciles the durable total with the rows.
      expect(storage.status).toBe(200);
      return ((await storage.json()) as { artifactBytes: number })
        .artifactBytes;
    };
    const plaintextArtifacts = usage();
    const documents = (
      srv.db
        .prepare(
          'SELECT COALESCE(SUM(stored_bytes), 0) AS bytes FROM project_document_objects'
        )
        .get() as { bytes: number }
    ).bytes;
    const s = await startStaging(srv, plain.projectId);
    // No project storage left beyond the plaintext: had staged versions
    // counted, none would fit.
    srv.db
      .prepare('UPDATE users SET project_storage_limit_bytes = ? WHERE id = ?')
      .run(documents + 100, OWNER);
    const head = await stage(s, plain);
    const first = await s.d.blobs.archive(plain.projectId, noiseInput(1));
    const blobBytes = (
      srv.db
        .prepare(
          'SELECT ciphertext_bytes AS bytes FROM e2ee_content_blobs WHERE blob_id = ?'
        )
        .get(first) as { bytes: number }
    ).bytes;
    expect(usage()).toBe(plaintextArtifacts);
    // Fill the artifact storage to leave room for one more blob only, had
    // the first counted: it does not, so the second fits too.
    srv.db
      .prepare(
        `INSERT INTO artifacts (id, project_id, kind, name, object_key,
           content_type, metadata_json, created_at, bytes)
         VALUES ('artifact_big', ?, 'step-import', 'big.step', 'big',
                 'model/step', '{}', 'now', ?)`
      )
      .run(
        (await plaintextProject(srv, 'Filler')).projectId,
        MAX_ACCOUNT_ARTIFACT_BYTES -
          plaintextArtifacts -
          Math.floor(blobBytes * 1.5)
      );
    const filled = usage();
    await s.d.blobs.archive(plain.projectId, noiseInput(2));
    expect(usage()).toBe(filled);
    expect(await reported()).toBe(filled);
    const stagedBlobBytes = (
      srv.db
        .prepare(
          'SELECT SUM(ciphertext_bytes) AS bytes FROM e2ee_content_blobs WHERE project_id = ?'
        )
        .get(plain.projectId) as { bytes: number }
    ).bytes;
    expect(stagedBlobBytes).toBeGreaterThan(Math.floor(blobBytes * 1.5));

    // From the cutover on they count (the account may sit over its limits
    // until the purge removes the plaintext): the next save is refused.
    await s.api.cutover(plain.projectId, s.lease);
    // (Every account write refreshes the limits from the tier; set it again.)
    srv.db
      .prepare('UPDATE users SET project_storage_limit_bytes = ? WHERE id = ?')
      .run(documents + 100, OWNER);
    expect(usage()).toBe(filled + stagedBlobBytes);
    expect(await reported()).toBe(filled + stagedBlobBytes);
    expect(
      await errorOf(
        s.d.store.saveProjectDocument({
          projectId: plain.projectId,
          expectedVersion: head.version,
          document: { ...head, version: head.version + 1 }
        })
      )
    ).toMatchObject({ status: 413, code: 'PROJECT_STORAGE_QUOTA' });
    await purgeAll(s.api, plain.projectId);
    expect(usage()).toBe(filled - plaintextArtifacts + stagedBlobBytes);
    expect(await reported()).toBe(
      filled - plaintextArtifacts + stagedBlobBytes
    );
  });
});

// --- Erasure, deletion and the sweep -----------------------------------------------------

describe('erasure, deletion and the sweep', () => {
  it('abandons a staging on profile erasure and drops the rows with the projects', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    const s = await startStaging(srv, plain.projectId);
    await stage(s, plain);
    expect(
      (
        await srv.call('POST', '/api/account/delete-data', {
          body: { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' }
        })
      ).status
    ).toBe(200);
    expect(migrationRow(srv, plain.projectId)).toMatchObject({
      state: 'abandoned',
      device_id: null,
      lease_id: null,
      purge_cursor: 'cleanup'
    });
    // The plaintext is the owner's again.
    expect((await autosave(srv, plain)).status).toBe(200);
    expect(
      (
        await srv.call('POST', '/api/account/delete-data', {
          body: { scope: 'all', confirmation: 'DELETE ALL CLOUD DATA' }
        })
      ).status
    ).toBe(200);
    expect(rows(srv, 'SELECT * FROM e2ee_project_migrations')).toEqual([]);
    expect(stagedRows(srv, plain.projectId)).toEqual(nothingStaged);
    expect(
      [...srv.bucket.objects.keys()].filter((key) =>
        key.includes(plain.projectId)
      )
    ).toEqual([]);
  });

  it('purges a staged project with its staged rows and objects from the recycle bin', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    const s = await startStaging(srv, plain.projectId);
    await stage(s, plain);
    await s.d.blobs.archive(plain.projectId, stepInput('Secret source'));
    srv.db
      .prepare(
        "UPDATE projects SET status = 'deleted', deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
      )
      .run(plain.projectId);
    expect((await srv.call('POST', '/api/projects/purge')).status).toBe(200);
    expect(migrationRow(srv, plain.projectId)).toBeUndefined();
    expect(stagedRows(srv, plain.projectId)).toEqual(nothingStaged);
    expect(
      [...srv.bucket.objects.keys()].filter((key) =>
        key.includes(plain.projectId)
      )
    ).toEqual([]);
  });

  it('finishes a purge the browser left behind on the scheduled sweep', async () => {
    const srv = server();
    const plain = await namedSave(srv, await plaintextProject(srv), 'Named');
    const s = await startStaging(srv, plain.projectId);
    await stage(s, plain);
    await s.api.cutover(plain.projectId, s.lease);
    // A fresh cutover is the browser's to purge.
    await worker.scheduled({}, srv.env);
    expect(migrationRow(srv, plain.projectId)!.state).toBe('cutover');
    srv.db
      .prepare(
        "UPDATE e2ee_project_migrations SET updated_at = '2000-01-01T00:00:00.000Z'"
      )
      .run();
    await worker.scheduled({}, srv.env);
    expect(migrationRow(srv, plain.projectId)!.state).toBe('done');
    expect(count(srv, 'revisions', plain.projectId)).toBe(0);
  });

  it('abandons a staging on the sweep once its owner may no longer migrate (#914 review)', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    const s = await startStaging(srv, plain.projectId);
    await stage(s, plain);
    // Another project of the owner's, already cut over: never abandoned.
    const done = await namedSave(
      srv,
      await plaintextProject(srv, 'Cut over'),
      'Named'
    );
    const c = await startStaging(srv, done.projectId);
    await stage(c, done);
    await c.api.cutover(done.projectId, c.lease);
    const migrating = async () => {
      const answer = await autosave(srv, plain);
      expect(answer.status).toBe(409);
      expect(await codeOf(answer)).toBe('PROJECT_MIGRATING');
    };
    const lapse = () =>
      srv.db
        .prepare(
          "UPDATE e2ee_project_migrations SET lease_expires_at = 1 WHERE state = 'staging'"
        )
        .run();
    // The account leaves the rollout (off the canary allowlist, say) while
    // the migration flag stays on: the plaintext gate still refuses, and
    // the migration routes no longer answer this account.
    srv.env.E2EE_KEYS_ENABLED = 'false';
    await migrating();
    expect(
      await errorOf(s.api.abandon(plain.projectId, s.lease))
    ).toMatchObject({ status: 501, code: 'FEATURE_DISABLED' });
    // A live lease is left alone.
    await worker.scheduled({}, srv.env);
    expect(migrationRow(srv, plain.projectId)!.state).toBe('staging');
    // So is a lapsed one while the owner may still migrate: it resumes.
    srv.env.E2EE_KEYS_ENABLED = 'true';
    lapse();
    await worker.scheduled({}, srv.env);
    expect(migrationRow(srv, plain.projectId)!.state).toBe('staging');
    // Lapsed, and the owner out: the sweep abandons it and drops what was
    // staged, and the plaintext is the owner's again.
    srv.env.E2EE_KEYS_ENABLED = 'false';
    await migrating();
    await worker.scheduled({}, srv.env);
    expect(migrationRow(srv, plain.projectId)).toMatchObject({
      state: 'abandoned',
      lease_id: null,
      purge_cursor: null
    });
    expect(stagedRows(srv, plain.projectId)).toEqual(nothingStaged);
    expect((await autosave(srv, plain)).status).toBe(200);
    expect(migrationRow(srv, done.projectId)!.state).toBe('cutover');
    expect(formatOf(srv, done.projectId).storage_format).toBe(2);
  });

  it('pages the sweep past lapsed stagings whose owners may still migrate (#914 follow-up)', async () => {
    const srv = server();
    const plain = await plaintextProject(srv);
    // Copies of the project row, so many staging rows can exist.
    const columns = (
      srv.db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]
    )
      .map(({ name }) => name)
      .filter((name) => name !== 'id');
    const copy = (id: string, ownerId: string) =>
      srv.db
        .prepare(
          `INSERT INTO projects (id, ${columns.join(', ')})
           SELECT ?, ${columns
             .map((name) => (name === 'owner_user_id' ? '?' : name))
             .join(', ')} FROM projects WHERE id = ?`
        )
        .run(
          id,
          ...(columns.includes('owner_user_id') ? [ownerId] : []),
          plain.projectId
        );
    const staging = (id: string, ownerId: string, updatedAt: string) =>
      srv.db
        .prepare(
          `INSERT INTO e2ee_project_migrations
             (project_id, direction, state, owner_user_id, source_version,
              started_at, updated_at)
           VALUES (?, 'encrypt', 'staging', ?, 0, ?, ?)`
        )
        .run(id, ownerId, updatedAt, updatedAt);
    // Sixty lapsed stagings, older than any other, whose owner may still
    // migrate: more than one page of candidates.
    for (let i = 0; i < 60; i++) {
      const id = `${plain.projectId}_eligible_${String(i).padStart(2, '0')}`;
      copy(id, OWNER);
      staging(id, OWNER, '2000-01-01T00:00:00.000Z');
    }
    // And one, newer, whose owner left the rollout.
    const withdrawn = `${plain.projectId}_withdrawn`;
    copy(withdrawn, OTHER);
    staging(withdrawn, OTHER, '2001-01-01T00:00:00.000Z');
    const otherEmail = 'withdrawn@example.com';
    srv.db
      .prepare('UPDATE users SET email = ? WHERE id = ?')
      .run(otherEmail, OTHER);
    await sweepProjectMigrations(
      srv.env,
      true,
      (email) => email !== otherEmail
    );
    expect(migrationRow(srv, withdrawn)!.state).toBe('abandoned');
    expect(
      rows(
        srv,
        "SELECT project_id FROM e2ee_project_migrations WHERE state = 'staging'"
      )
    ).toHaveLength(60);
  });
});

// --- Flag off, migration missing ------------------------------------------------------------

describe('with the flag off or migration 0042 missing', () => {
  it('serves nothing new and stages nothing while E2EE_MIGRATION_ENABLED is off', async () => {
    const srv = newServer([owner, other]);
    const plain = await plaintextProject(srv);
    const laptop = device(srv, owner, 'owner_laptop');
    expect(
      await errorOf(
        createProjectMigrationsApi(laptop.fetcher).start(plain.projectId, {
          direction: 'encrypt',
          deviceId: 'owner_laptop'
        })
      )
    ).toMatchObject({ status: 501, code: 'FEATURE_DISABLED' });
    // A staging row left from when it was on stages nothing and blocks
    // nothing.
    const lease = 'L'.repeat(43);
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_migrations
           (project_id, direction, state, owner_user_id, device_id, lease_id,
            lease_expires_at, source_version, started_at, updated_at)
         VALUES (?, 'encrypt', 'staging', ?, 'owner_laptop', ?, ?, ?, 'now', 'now')`
      )
      .run(plain.projectId, OWNER, lease, Date.now() + 60_000, plain.version);
    useLease(laptop, lease);
    expect(
      await errorOf(
        laptop.store.createProject({ name: plain.name, initialDocument: plain })
      )
    ).toMatchObject({ status: 409, code: 'E2EE_PROJECT_NOT_ENCRYPTED' });
    srv.statements.length = 0;
    expect((await autosave(srv, plain)).status).toBe(200);
    expect(
      (await srv.call('GET', `/api/projects/${plain.projectId}`)).status
    ).toBe(200);
    expect(
      srv.statements.filter((sql) => /e2ee_project_migrations/.test(sql))
    ).toEqual([]);
    expect(await (await srv.call('GET', '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: true
    });
  });

  it('keeps ordinary traffic working with migrations only through 0041', async () => {
    const srv = newServer([owner, other], databaseBefore(42), MIGRATION_ON);
    const plain = await namedSave(srv, await plaintextProject(srv), 'Named');
    expect((await autosave(srv, plain)).status).toBe(200);
    await plaintextUpload(srv, plain.projectId, 'bytes');
    expect(
      (
        await srv.call('POST', `/api/projects/${plain.projectId}/duplicate`, {
          body: {}
        })
      ).status
    ).toBe(201);
    expect((await srv.call('GET', '/api/account/storage')).status).toBe(200);
    // The encrypted projects of Phase 4 are unchanged.
    const laptop = device(srv, owner, 'owner_laptop');
    const created = await laptop.store.createProject({
      name: 'Encrypted',
      initialDocument: initialDocument('Encrypted')
    });
    await laptop.blobs.archive(created.document.projectId, stepInput('blob'));
    expect((await srv.call('GET', '/api/account/storage')).status).toBe(200);
    // The migration routes answer 503 and config reports them closed.
    const api = createProjectMigrationsApi(laptop.fetcher);
    expect(
      await errorOf(
        api.start(plain.projectId, {
          direction: 'encrypt',
          deviceId: 'owner_laptop'
        })
      )
    ).toMatchObject({ status: 503, code: 'E2EE_UNAVAILABLE' });
    expect(await (await srv.call('GET', '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: true
    });
    // A lease header changes nothing.
    useLease(laptop, 'L'.repeat(43));
    expect(
      (
        await laptop.fetcher(
          `/api/e2ee/projects/${created.document.projectId}/versions?since=1`
        )
      ).status
    ).toBe(200);
    srv.db
      .prepare(
        "UPDATE projects SET status = 'deleted', deleted_at = '2000-01-01T00:00:00.000Z'"
      )
      .run();
    expect((await srv.call('POST', '/api/projects/purge')).status).toBe(200);
    await worker.scheduled({}, srv.env);
    for (const [scope, confirmation] of [
      ['profile', 'DELETE CLOUD PROFILE'],
      ['all', 'DELETE ALL CLOUD DATA']
    ]) {
      expect(
        (
          await srv.call('POST', '/api/account/delete-data', {
            body: { scope, confirmation }
          })
        ).status
      ).toBe(200);
    }
    // No statement named the table it lacks, apart from the probe.
    for (const sql of srv.statements.filter((s) =>
      /e2ee_project_migrations/.test(s)
    )) {
      expect(sql, sql).toMatch(/FROM sqlite_master/);
    }
  });

  it('reports migration open in the config only with the flag and the table', async () => {
    const srv = server();
    expect(await (await srv.call('GET', '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: true,
      migrationEnabled: true
    });
    expect(E2EE_MIGRATION_LEASE_HEADER).toBe('x-e2ee-migration-lease');
    const started = (await (
      await srv.call(
        'GET',
        `/api/e2ee/projects/${(await plaintextProject(srv)).projectId}/migration`
      )
    ).json()) as { migration: E2eeMigrationLeaseResponse['migration'] | null };
    expect(started.migration).toBeNull();
  });
});
