/**
 * The beta-only reverse path (ADR-024 Phase 7, slice 7-3): an encrypted
 * project turned back into plaintext, over the real Worker, its room class
 * and SQLite, with Node devices that run the real client modules and the
 * in-process MLS engine. A plaintext project with a STEP import, several
 * save states, a thumbnail, an archived export, measurements and a view
 * state is first encrypted by the slice 7-2 engine, then decrypted by the
 * reverse engine; it reopens as plaintext with all of it, and no
 * ciphertext row, object or room key remains.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  DECRYPT_STAGED_BLOB_METADATA_KEY,
  E2EE_MIGRATION_CODES,
  PROJECT_MIGRATING_CODE,
  parseWorkspaceResumeState,
  type ArtifactRecord,
  type ProjectDocument,
  type ProjectSummary,
  type ProjectWorkspaceSession
} from '@openzcad/shared';
import { signShareDelegation } from '@openzcad/crypto';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  createShareLink,
  renewShareDelegation,
  revokeShareLink
} from '../apps/web/src/lib/e2ee/shareLinks';
import {
  createProjectMigrationsApi,
  withMigrationLease
} from '../apps/web/src/lib/e2ee/projectMigrationsApi';
import { createMigrationPlaintextSource } from '../apps/web/src/lib/e2ee/migrationPlaintextSource';
import { createMigrationPlaintextTarget } from '../apps/web/src/lib/e2ee/migrationPlaintextTarget';
import {
  createProjectMigrationEngine,
  memoryLeaseStore,
  type MigrationLeaseStore,
  type MigrationProgress
} from '../apps/web/src/lib/e2ee/projectMigrationEngine';
import {
  createProjectDecryptionEngine,
  decryptableProjects,
  decryptionErrorOf,
  documentBlobFiles
} from '../apps/web/src/lib/e2ee/projectDecryptionEngine';
import { ProjectCollaborationRoom } from '../apps/web/worker/e2eeRoom';
import worker from '../apps/web/worker/index';
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

const text = (value: string) => new TextEncoder().encode(value);
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

const REVERSE_ON = {
  E2EE_MIGRATION_ENABLED: 'true',
  E2EE_REVERSE_ENABLED: 'true'
};

/** Every encrypted table a project's purge empties. */
const ENCRYPTED_TABLES = [
  'e2ee_project_groups',
  'e2ee_project_leaves',
  'e2ee_mls_commits',
  'e2ee_project_keys',
  'e2ee_key_archives',
  'e2ee_project_versions',
  'e2ee_project_revisions',
  'e2ee_project_envelopes',
  'e2ee_content_blobs',
  'e2ee_version_blobs',
  'e2ee_group_resets',
  // Phase 5 and 6 rows kept beside the group (migrations 0038, 0039, 0041).
  'e2ee_assistant_consents',
  'e2ee_mls_proposals',
  'e2ee_welcomes',
  'e2ee_key_packages',
  'e2ee_invitations'
];

/**
 * What Phase 5 and 6 leave about an encrypted project that nobody else
 * holds any more: the owner's assistant consent (6-1), a settled
 * self-remove proposal (5-5) and a revoked encrypted invitation (5-3a).
 */
function insertSettledSharingRows(srv: Server, projectId: string): void {
  srv.db
    .prepare(
      `INSERT INTO e2ee_assistant_consents
         (user_id, project_id, allowed, copy_version, route, record,
          record_mac, sequence, updated_at)
       VALUES (?, ?, 1, 1, '/api/ai', 'record', ?, 1, 'now')`
    )
    .run(OWNER, projectId, 'm'.repeat(43));
  srv.db
    .prepare(
      `INSERT INTO e2ee_mls_proposals
         (project_id, key_epoch, proposal_hash, kind, sender_user_id,
          sender_device_id, message, created_at, outcome, settled_key_epoch)
       VALUES (?, 1, ?, 'self-remove', ?, 'other_laptop', 'message', 'now',
               'committed', 2)`
    )
    .run(projectId, 'p'.repeat(64), OTHER);
  srv.db
    .prepare(
      `INSERT INTO e2ee_invitations
         (invitation_id, project_id, invited_by_user_id, email_hash, role,
          token_hash, statement, signature, signer_device_id, created_at,
          expires_at, revoked_at)
       VALUES ('einv_revoked', ?, ?, ?, 'viewer', ?, 'statement', ?,
               'owner_laptop', 'now', ?, 'now')`
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

// --- Server --------------------------------------------------------------------

interface RoomServer extends Server {
  storage: Map<string, Map<string, unknown>>;
  /** What each project's room starts with. */
  roomSeed: Map<string, Map<string, unknown>>;
}

/** An encrypted room's state: its format, ledger index and one envelope. */
function encryptedRoomState(projectId: string): Map<string, unknown> {
  const hash = 'a'.repeat(64);
  return new Map<string, unknown>([
    [
      'room:meta',
      { schema: 1, projectId, latestVersion: null, historyVersions: [], format: 2 }
    ],
    ['room:e2ee:meta', { schema: 1, latest: hash, retained: [] }],
    [
      `room:e2ee:v:${hash}`,
      { record: { versionHash: hash }, envelope: text('Secret room ciphertext') }
    ]
  ]);
}

function roomServer(
  accounts: readonly Account[] = [owner, other],
  extraEnv: Record<string, unknown> = REVERSE_ON,
  db?: Parameters<typeof newServer>[1]
): RoomServer {
  const rooms = new Map<string, ProjectCollaborationRoom>();
  const storage = new Map<string, Map<string, unknown>>();
  const roomSeed = new Map<string, Map<string, unknown>>();
  let env: Record<string, unknown> = {};
  const namespace = {
    getByName: (name: string) => {
      let room = rooms.get(name);
      if (!room) {
        const { context, values } = createRoomContext(
          new Map(roomSeed.get(name) ?? [])
        );
        storage.set(name, values);
        room = new ProjectCollaborationRoom(context, env);
        context.activate(room);
        rooms.set(name, room);
      }
      return room;
    }
  };
  const srv = newServer(accounts, db, { ...extraEnv, PROJECT_ROOM: namespace });
  env = srv.env;
  return Object.assign(srv, { storage, roomSeed });
}

// --- The plaintext project, then encrypted -----------------------------------------

async function upload(
  srv: Server,
  projectId: string,
  file: { fileName: string; contentType: string; kind: string; bytes: Uint8Array }
): Promise<string> {
  const created = await srv.call('POST', '/api/uploads', {
    body: {
      projectId,
      fileName: file.fileName,
      contentType: file.contentType,
      kind: file.kind
    }
  });
  expect(created.status).toBe(201);
  const { session } = (await created.json()) as {
    session: { uploadSessionId: string; uploadUrl: string; artifactId: string };
  };
  expect(
    (
      await srv.call('PUT', session.uploadUrl, {
        raw: file.bytes as Uint8Array<ArrayBuffer>
      })
    ).status
  ).toBe(204);
  expect(
    (
      await srv.call('POST', '/api/artifacts/finalize', {
        body: {
          projectId,
          uploadSessionId: session.uploadSessionId,
          artifactId: session.artifactId
        }
      })
    ).status
  ).toBe(200);
  return session.artifactId;
}

async function autosave(
  srv: Server,
  document: ProjectDocument
): Promise<ProjectDocument> {
  const next = { ...document, version: document.version + 1 };
  const saved = await srv.call(
    'PUT',
    `/api/projects/${document.projectId}/document`,
    {
      body: {
        projectId: document.projectId,
        expectedVersion: document.version,
        document: next
      }
    }
  );
  if (saved.status !== 200) throw new Error(await saved.text());
  return next;
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

const STEP = text(
  `ISO-10303-21;\nHEADER;\nFILE_NAME('Secret STEP');\n${'DATA;\n'.repeat(120)}END-ISO-10303-21;\n`
);
const THUMBNAIL = 'RIFF Secret thumbnail WEBP';
const EXPORT = 'solid Secret export\nendsolid\n';

function withImport(document: ProjectDocument, artifactId: string) {
  const manager = new CommandManager(document);
  manager.execute(
    commandFactories.importStep({
      name: 'Secret import',
      sourceName: 'secret-part.step',
      artifactId,
      stepSourceRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: sha256(STEP),
        logicalBytes: STEP.byteLength
      }
    })
  );
  return manager.document;
}

function measurementRecord(projectId: string) {
  return {
    projectId,
    version: 1,
    updatedAt: '2026-10-24T00:00:00.000Z',
    display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' },
    measurements: [
      {
        id: 'measure_1',
        kind: 'edge-length',
        label: 'Secret gauge',
        result: { value: 12.5, dimension: 'length' },
        quality: 'exact-kernel',
        status: 'current',
        targets: [],
        sourceRevision: 1,
        sourceUnit: 'mm',
        visible: true
      }
    ]
  };
}

function workspaceSession(
  projectId: string,
  documentVersion: number
): Omit<ProjectWorkspaceSession, 'updatedAt'> {
  return {
    schemaVersion: 1,
    projectId,
    deviceId: 'workspace_laptop',
    sessionId: 'session_one',
    deviceLabel: 'Desktop',
    sequence: 1,
    documentVersion,
    state: parseWorkspaceResumeState({
      camera: { position: [11, 22, 33], target: [0, 0, 0], orthographicZoom: 1 },
      projection: 'perspective',
      settings: { showGrid: true, displayMode: 'shaded' },
      hiddenBodyIds: [],
      selectedBodyIds: ['body_secret_view'],
      workspaceMode: 'build',
      panels: {
        sidebarSections: { bodies: true },
        assistantCollapsed: true,
        viewModeRailOpen: false
      }
    })!
  };
}

interface Encrypted {
  projectId: string;
  revisionIds: string[];
  reasons: string[];
  encryptor: Device;
}

/**
 * A plaintext project with a STEP import, `revisions` save states, a
 * thumbnail, an archived export, measurements and a view state, encrypted
 * end to end by the slice 7-2 engine (cut over and purged).
 */
async function encryptedProject(
  srv: Server,
  { revisions = 3 }: { revisions?: number } = {}
): Promise<Encrypted> {
  const created = await srv.call('POST', '/api/projects', {
    body: {
      name: 'Secret bracket',
      initialDocument: initialDocument('Secret bracket')
    }
  });
  expect(created.status).toBe(201);
  let document = ((await created.json()) as { document: ProjectDocument })
    .document;
  const projectId = document.projectId;
  const stepArtifactId = await upload(srv, projectId, {
    fileName: 'secret-part.step',
    contentType: 'model/step',
    kind: 'step-import',
    bytes: STEP
  });
  document = await autosave(srv, {
    ...withImport(document, stepArtifactId),
    version: document.version
  });
  const reasons = ['Secret one', 'Secret two', 'Secret three'].slice(
    0,
    revisions
  );
  for (const [index, reason] of reasons.entries()) {
    document = await namedSave(srv, document, reason);
    if (index < reasons.length - 1) document = await autosave(srv, document);
  }
  document = await autosave(srv, document);
  await upload(srv, projectId, {
    fileName: `${projectId}-thumbnail.webp`,
    contentType: 'image/webp',
    kind: 'thumbnail',
    bytes: text(THUMBNAIL)
  });
  await upload(srv, projectId, {
    fileName: 'secret-export.stl',
    contentType: 'model/stl',
    kind: 'stl-export',
    bytes: text(EXPORT)
  });
  expect(
    (
      await srv.call('PUT', `/api/projects/${projectId}/measurements`, {
        body: { expectedRevision: 0, record: measurementRecord(projectId) }
      })
    ).status
  ).toBe(200);
  expect(
    (
      await srv.call('PUT', `/api/projects/${projectId}/workspace-sessions`, {
        body: workspaceSession(projectId, document.version)
      })
    ).status
  ).toBe(204);
  const listed = (await (
    await srv.call('GET', `/api/projects/${projectId}/revisions`)
  ).json()) as { revisions: { revisionId: string }[] };

  const encryptor = await encryptExisting(srv, projectId);
  return {
    projectId,
    revisionIds: listed.revisions.map((r) => r.revisionId),
    reasons,
    encryptor
  };
}

/** Encrypts a plaintext project end to end with the slice 7-2 engine. */
async function encryptExisting(srv: Server, projectId: string) {
  const encryptor = device(srv, owner, 'owner_laptop');
  const base = encryptor.fetcher;
  const plaintext = createMigrationPlaintextSource(base);
  const engine = createProjectMigrationEngine({
    deviceId: 'owner_laptop',
    fetcher: base,
    migrations: createProjectMigrationsApi(base),
    plaintext,
    createStaging: (leased) => {
      encryptor.fetcher = leased;
      return {
        store: encryptor.store,
        blobs: encryptor.blobs,
        references: encryptor.references,
        measurements: encryptor.measurements,
        viewStates: encryptor.viewStates,
        groups: encryptor.groups,
        documents: encryptor.documents
      };
    }
  });
  await engine.migrate(
    (await plaintext.listProjects()).find((p) => p.projectId === projectId)!
  );
  encryptor.fetcher = base;
  expect(formatOf(srv, projectId)).toBe(2);
  forgetAllProjectKeys();
  return encryptor;
}

// --- The reverse engine on a device ---------------------------------------------

interface ReverseDevice {
  d: Device;
  engine: ReturnType<typeof createProjectDecryptionEngine>;
  progress: MigrationProgress[];
  flushed: string[];
  cutover: string[];
  summary(projectId: string): Promise<ProjectSummary>;
}

function reverseOn(
  srv: Server,
  account: Account,
  deviceId: string,
  options: {
    from?: Device;
    leases?: MigrationLeaseStore;
    beforeStep?: (step: string, projectId: string) => void | Promise<void>;
  } = {}
): ReverseDevice {
  const d = device(
    srv,
    account,
    deviceId,
    options.from ? { mls: options.from.mls, pins: options.from.pins } : {}
  );
  const base = d.fetcher;
  const progress: MigrationProgress[] = [];
  const flushed: string[] = [];
  const cutover: string[] = [];
  const engine = createProjectDecryptionEngine({
    deviceId,
    fetcher: base,
    migrations: createProjectMigrationsApi(base),
    createReaders: () => ({
      store: d.store,
      blobs: d.blobs,
      references: d.references,
      measurements: d.measurements,
      viewStates: d.viewStates
    }),
    leases: options.leases ?? memoryLeaseStore(),
    flushProject: async (projectId) => void flushed.push(projectId),
    onCutover: (projectId) => void cutover.push(projectId),
    onProgress: (p) => progress.push(p),
    ...(options.beforeStep ? { beforeStep: options.beforeStep } : {})
  });
  return {
    d,
    engine,
    progress,
    flushed,
    cutover,
    summary: async (projectId) =>
      (await createMigrationPlaintextSource(base).listProjects()).find(
        (p) => p.projectId === projectId
      )!
  };
}

function migrationRow(srv: Server, projectId: string) {
  return srv.db
    .prepare('SELECT * FROM e2ee_project_migrations WHERE project_id = ?')
    .get(projectId) as Record<string, unknown> | undefined;
}

function formatOf(srv: Server, projectId: string) {
  return (
    srv.db
      .prepare('SELECT storage_format FROM projects WHERE id = ?')
      .get(projectId) as { storage_format: number }
  ).storage_format;
}

function usage(srv: Server): number {
  return (
    srv.db
      .prepare(
        'SELECT finalized_bytes FROM artifact_account_usage WHERE owner_user_id = ?'
      )
      .get(OWNER) as { finalized_bytes: number }
  ).finalized_bytes;
}

async function decryptFully(r: ReverseDevice, projectId: string) {
  await r.engine.decrypt(await r.summary(projectId));
}

async function errorOf(promise: Promise<unknown>) {
  return (await promise.catch((caught: unknown) => caught)) as {
    code?: string;
    status?: number;
  };
}

/** Nothing encrypted of the project is left: rows, R2 objects, room keys. */
function expectNoCiphertext(srv: RoomServer, projectId: string) {
  for (const table of ENCRYPTED_TABLES) {
    expect(count(srv, table, projectId), table).toBe(0);
  }
  const keys = [...srv.bucket.objects.keys()];
  expect(keys.filter((key) => key.startsWith(`e2ee/${projectId}/`))).toEqual(
    []
  );
  const room = srv.storage.get(projectId);
  expect(
    [...(room?.keys() ?? [])].filter((key) => key.startsWith('room:e2ee'))
  ).toEqual([]);
}

/** A fresh browser opens the project as plaintext with its whole history. */
async function expectOpensAsPlaintext(srv: Server, encrypted: Encrypted) {
  const { projectId } = encrypted;
  const opened = (await (
    await srv.call('GET', `/api/projects/${projectId}`)
  ).json()) as ProjectDocument;
  expect(opened.name).toBe('Secret bracket');
  const listed = (await (
    await srv.call('GET', `/api/projects/${projectId}/revisions`)
  ).json()) as { revisions: { revisionId: string; reason: string }[] };
  expect(listed.revisions.map((r) => r.revisionId).sort()).toEqual(
    [...encrypted.revisionIds].sort()
  );
  expect(listed.revisions.map((r) => r.reason).sort()).toEqual(
    [...encrypted.reasons].sort()
  );
  for (const revisionId of encrypted.revisionIds) {
    const revision = (await (
      await srv.call('GET', `/api/projects/${projectId}/revisions/${revisionId}`)
    ).json()) as ProjectDocument;
    expect(revision.revisions.at(-1)?.revisionId).toBe(revisionId);
  }
  // The STEP import names a plaintext artifact with the same bytes.
  const stepId = JSON.stringify(opened).match(/"artifactId":"([^"]+)"/)?.[1];
  expect(stepId).toMatch(/^artifact_/);
  const download = await srv.call('GET', `/api/artifacts/${stepId}/download`);
  expect(download.status).toBe(200);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(STEP);
  // The shelf picture and the archived export.
  const summary = (
    (await (await srv.call('GET', '/api/projects')).json()) as {
      projects: ProjectSummary[];
    }
  ).projects.find((p) => p.projectId === projectId)!;
  expect(summary.name).toBe('Secret bracket');
  expect(summary.storageFormat ?? 1).toBe(1);
  expect(summary.documentVersion).toBe(opened.version);
  const thumbnail = await srv.call(
    'GET',
    `/api/artifacts/${summary.thumbnailArtifactId}/download`
  );
  expect(await thumbnail.text()).toBe(THUMBNAIL);
  const artifacts = (
    (await (
      await srv.call('GET', `/api/projects/${projectId}/artifacts`)
    ).json()) as { artifacts: ArtifactRecord[] }
  ).artifacts;
  const exported = artifacts.find((a) => a.kind === 'stl-export')!;
  expect(exported.name).toBe('secret-export.stl');
  expect(
    await (await srv.call('GET', `/api/artifacts/${exported.artifactId}/download`)).text()
  ).toBe(EXPORT);
  // Measurements and the view state.
  const measured = (await (
    await srv.call('GET', `/api/projects/${projectId}/measurements`)
  ).json()) as { record: { measurements: { label: string }[] } };
  expect(measured.record.measurements[0]!.label).toBe('Secret gauge');
  const sessions = (await (
    await srv.call('GET', `/api/projects/${projectId}/workspace-sessions`)
  ).json()) as { sessions: ProjectWorkspaceSession[] };
  expect(sessions.sessions.map((s) => s.state.selectedBodyIds)).toEqual([
    ['body_secret_view']
  ]);
  // And it is an ordinary plaintext project again: it saves.
  await autosave(srv, opened);
  await namedSave(srv, { ...opened, version: opened.version + 1 }, 'After');
  expect((await srv.call('GET', '/api/account/storage')).status).toBe(200);
  return opened;
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

// --- Turning encryption off --------------------------------------------------------

describe('turning an encrypted project back into plaintext', () => {
  it('stages history, files and details, cuts over, purges every ciphertext, and reopens as plaintext', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv);
    const { projectId } = encrypted;
    const encryptedVersion = (
      srv.db
        .prepare('SELECT document_version FROM projects WHERE id = ?')
        .get(projectId) as { document_version: number }
    ).document_version;
    const blobBytes = rows<{ bytes: number }>(
      srv,
      'SELECT SUM(ciphertext_bytes) AS bytes FROM e2ee_content_blobs WHERE project_id = ?',
      projectId
    )[0]!.bytes;
    expect(usage(srv)).toBe(blobBytes);
    // Its sharing is settled: nothing of it blocks, and the purge drops it.
    insertSettledSharingRows(srv, projectId);
    // The project's room relayed ciphertext.
    srv.roomSeed.set(projectId, encryptedRoomState(projectId));
    const desktop = reverseOn(srv, owner, 'owner_desktop');
    await decryptFully(desktop, projectId);
    expect([...srv.storage.get(projectId)!.keys()]).toEqual([]);

    expect(desktop.flushed).toEqual([projectId]);
    expect(desktop.cutover).toEqual([projectId]);
    expect(migrationRow(srv, projectId)).toMatchObject({
      direction: 'decrypt',
      state: 'done',
      revision_count: 3,
      blob_count: 3,
      purge_cursor: null,
      lease_id: null
    });
    expect(formatOf(srv, projectId)).toBe(1);
    expect(desktop.progress.at(-1)).toMatchObject({
      phase: 'done',
      revisionsDone: 3,
      revisionsTotal: 3
    });
    // The STEP once (every save state names it), the thumbnail, the export.
    expect(
      rows<{ kind: string }>(
        srv,
        'SELECT kind FROM artifacts WHERE project_id = ? ORDER BY kind',
        projectId
      ).map((r) => r.kind)
    ).toEqual(['step-import', 'stl-export', 'thumbnail']);
    // Usage moved from the blobs' ciphertext to the files.
    const fileBytes = rows<{ bytes: number }>(
      srv,
      'SELECT SUM(bytes) AS bytes FROM artifacts WHERE project_id = ?',
      projectId
    )[0]!.bytes;
    expect(fileBytes).not.toBe(blobBytes);
    expect(usage(srv)).toBe(fileBytes);

    expectNoCiphertext(srv, projectId);
    const opened = await expectOpensAsPlaintext(srv, encrypted);
    expect(opened.version).toBe(encryptedVersion + 1);
  });

  it('reads save states whose bodies carry a share-link set (body v2, slice 5-10)', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv, { revisions: 1 });
    const { projectId } = encrypted;
    const laptop = device(srv, owner, 'owner_laptop', {
      mls: encrypted.encryptor.mls,
      pins: encrypted.encryptor.pins
    });
    await renewShareDelegation(laptop.shareLinks, (value) =>
      signShareDelegation(owner.identityPrivateKey, value)
    );
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    // A save state taken while the link is active, then the revocation:
    // both bodies are version 2, one with a grant, one with a tombstone.
    const linked = await laptop.store.shareHead(projectId);
    expect(linked.shareLinks?.links.map((l) => l.shareId)).toEqual([
      created.shareId
    ]);
    await laptop.store.saveRevision({
      projectId: linked.document.projectId,
      reason: 'Secret linked',
      expectedVersion: linked.version,
      document: linked.document
    });
    await revokeShareLink(laptop.shareLinks, projectId, created.shareId);
    // Only a revoked link remains, so the project may stop being encrypted.
    const desktop = reverseOn(srv, owner, 'owner_desktop', { from: laptop });
    await decryptFully(desktop, projectId);
    expect(migrationRow(srv, projectId)).toMatchObject({
      direction: 'decrypt',
      state: 'done',
      revision_count: 2
    });
    expect(formatOf(srv, projectId)).toBe(1);
    expectNoCiphertext(srv, projectId);
    const reasons = rows<{ reason: string }>(
      srv,
      'SELECT reason FROM revisions WHERE project_id = ? ORDER BY created_at',
      projectId
    ).map((r) => r.reason);
    expect(reasons).toEqual(['Secret one', 'Secret linked']);
  });

  it('refuses encrypted writes and the room while staging, and counts staged plaintext toward nothing', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv, { revisions: 1 });
    const { projectId } = encrypted;
    const before = usage(srv);
    let checked = false;
    const desktop = reverseOn(srv, owner, 'owner_desktop', {
      beforeStep: async (step) => {
        if (step !== 'cutover' || checked) return;
        checked = true;
        // Every file is staged, none of it counts yet.
        expect(count(srv, 'artifacts', projectId)).toBe(3);
        expect(usage(srv)).toBe(before);
        // Nor do the staged documents (migration 0043): at a one-byte
        // storage limit a staged object still lands, another project's not.
        const plain = (
          (await (
            await srv.call('POST', '/api/projects', {
              body: { name: 'Plain', initialDocument: initialDocument('Plain') }
            })
          ).json()) as { document: ProjectDocument }
        ).document.projectId;
        srv.db
          .prepare('UPDATE users SET project_storage_limit_bytes = 1 WHERE id = ?')
          .run(OWNER);
        const object = (id: string, project: string) =>
          srv.db
            .prepare(
              `INSERT INTO project_document_objects
                 (id, project_id, object_key, checksum_sha256, logical_bytes,
                  stored_bytes, content_encoding, state, created_at)
               VALUES (?, ?, ?, ?, 10, 10, 'gzip', 'committed', 'now')`
            )
            .run(id, project, `key-${id}`, 'c'.repeat(64));
        object('object_staged', projectId);
        expect(() => object('object_plain', plain)).toThrow(
          /project_account_storage_quota/
        );
        srv.db
          .prepare('DELETE FROM project_document_objects WHERE id = ?')
          .run('object_staged');
        srv.db
          .prepare(
            'UPDATE users SET project_storage_limit_bytes = 2147483648 WHERE id = ?'
          )
          .run(OWNER);
        expect((await srv.call('GET', '/api/account/storage')).status).toBe(
          200
        );
        // Encrypted content writes refuse; key management reads work.
        const laptop = device(srv, owner, 'owner_laptop', {
          mls: encrypted.encryptor.mls,
          pins: encrypted.encryptor.pins
        });
        const head = await laptop.store.loadProject(projectId);
        expect(
          await errorOf(
            laptop.store.saveProjectDocument({
              projectId: head.projectId,
              expectedVersion: head.version,
              document: { ...head, version: head.version + 1 }
            })
          )
        ).toMatchObject({ status: 409, code: PROJECT_MIGRATING_CODE });
        const info = await srv.call(
          'POST',
          `/api/e2ee/projects/${projectId}/blobs/uploads`,
          { body: {} }
        );
        expect(info.status).toBe(409);
        expect(
          ((await info.json()) as { code: string }).code
        ).toBe(PROJECT_MIGRATING_CODE);
        const ticket = await srv.call(
          'POST',
          `/api/projects/${projectId}/collaboration/ticket`
        );
        expect(ticket.status).toBe(409);
        expect(((await ticket.json()) as { code: string }).code).toBe(
          PROJECT_MIGRATING_CODE
        );
        // Nor may it be shared meanwhile: share links (5-10, gated ahead of
        // that slice), proposals (5-5), invitations and KeyPackages (5-3a).
        for (const [method, path] of [
          ['POST', 'share-links'],
          ['PUT', 'share-links/share_1/snapshot'],
          ['POST', 'mls/proposals'],
          ['POST', 'invitations'],
          ['POST', 'key-packages'],
          ['POST', 'key-packages/claim']
        ] as const) {
          const refused = await srv.call(
            method,
            `/api/e2ee/projects/${projectId}/${path}`,
            { body: {} }
          );
          expect(refused.status, path).toBe(409);
          expect(
            ((await refused.json()) as { code: string }).code,
            path
          ).toBe(PROJECT_MIGRATING_CODE);
        }
        // Without the lease, the plaintext routes still refuse it.
        expect(
          (await srv.call('GET', `/api/projects/${projectId}`)).status
        ).toBe(409);
        // The encrypted project still reads.
        expect(
          (
            await srv.call(
              'GET',
              `/api/e2ee/projects/${projectId}/versions?since=1`
            )
          ).status
        ).toBe(200);
      }
    });
    await decryptFully(desktop, projectId);
    expect(checked).toBe(true);
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'done' });
    expect((await srv.call('GET', '/api/account/storage')).status).toBe(200);
  });

  it('resumes after an interruption from the staged journal', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv);
    const { projectId } = encrypted;
    const leases = memoryLeaseStore();
    let revisionSteps = 0;
    const first = reverseOn(srv, owner, 'owner_desktop', {
      leases,
      beforeStep: (step) => {
        if (step === 'revision' && ++revisionSteps === 3) {
          throw new Error('The tab was closed.');
        }
      }
    });
    await expect(decryptFully(first, projectId)).rejects.toThrow(
      'The tab was closed.'
    );
    expect(migrationRow(srv, projectId)).toMatchObject({
      direction: 'decrypt',
      state: 'staging'
    });
    expect(count(srv, 'revisions', projectId)).toBe(2);
    expect(count(srv, 'artifacts', projectId)).toBe(1);
    expect(formatOf(srv, projectId)).toBe(2);

    // Reloaded: the same browser storage, a new page and engine.
    const steps: string[] = [];
    const second = reverseOn(srv, owner, 'owner_desktop', {
      from: first.d,
      leases,
      beforeStep: (step) => void steps.push(step)
    });
    await decryptFully(second, projectId);
    expect(steps.filter((step) => step === 'revision')).toHaveLength(1);
    expect(second.flushed).toEqual([]);
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'done' });
    // The STEP was found by its blob id, not stored again.
    expect(
      rows(
        srv,
        "SELECT id FROM artifacts WHERE project_id = ? AND kind = 'step-import'",
        projectId
      )
    ).toHaveLength(1);
    expectNoCiphertext(srv, projectId);
    await expectOpensAsPlaintext(srv, encrypted);
  });

  it('takes over a lapsed lease from another device', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv, { revisions: 2 });
    const { projectId } = encrypted;
    const laptop = reverseOn(srv, owner, 'owner_laptop', {
      beforeStep: (step) => {
        if (step === 'head') throw new Error('The laptop went offline.');
      }
    });
    await expect(decryptFully(laptop, projectId)).rejects.toThrow('offline');
    const blocked = reverseOn(srv, owner, 'owner_desktop');
    expect((await errorOf(decryptFully(blocked, projectId))).code).toBe(
      E2EE_MIGRATION_CODES.leased
    );
    srv.db
      .prepare('UPDATE e2ee_project_migrations SET lease_expires_at = 1')
      .run();
    const desktop = reverseOn(srv, owner, 'owner_desktop');
    await decryptFully(desktop, projectId);
    expect(migrationRow(srv, projectId)).toMatchObject({
      state: 'done',
      device_id: 'owner_desktop'
    });
    await expectOpensAsPlaintext(srv, encrypted);
  });

  it('stages and cuts over nothing once the lease holder’s device is no longer certified', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv, { revisions: 1 });
    const { projectId } = encrypted;
    // The device list moves on (a removal, say) after the lease holder's
    // device was checked and before the cutover's batch lands, as for a
    // staged encrypted version.
    const db = srv.env.DB as D1Database;
    const batch = db.batch.bind(db);
    let armed = true;
    db.batch = async (statements: D1PreparedStatement[]) => {
      const cut = statements.some((statement) =>
        /SET state = 'cutover'/.test(
          (statement as unknown as { sql?: string }).sql ?? ''
        )
      );
      if (armed && cut) {
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
    const desktop = reverseOn(srv, owner, 'owner_desktop');
    expect(await errorOf(decryptFully(desktop, projectId))).toMatchObject({
      status: 409,
      code: 'E2EE_DEVICE_LIST_CHANGED'
    });
    expect(armed).toBe(false);
    expect(formatOf(srv, projectId)).toBe(2);
    expect(migrationRow(srv, projectId)).toMatchObject({
      direction: 'decrypt',
      state: 'staging'
    });
    // A lease whose device the owner's newest list no longer names stages
    // nothing more and cannot cut the project over.
    srv.db
      .prepare(
        "UPDATE e2ee_project_migrations SET device_id = 'owner_removed' WHERE project_id = ?"
      )
      .run(projectId);
    const lease = migrationRow(srv, projectId)!.lease_id as string;
    const leased = withMigrationLease(desktop.d.fetcher, lease);
    const details = await leased(
      `/api/e2ee/projects/${projectId}/migration/plaintext/details`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ measurements: null, workspaceSessions: [] })
      }
    );
    expect(details.status).toBe(403);
    expect(((await details.json()) as { code: string }).code).toBe(
      'E2EE_DEVICE_NOT_CERTIFIED'
    );
    expect(
      await errorOf(
        createProjectMigrationsApi(desktop.d.fetcher).cutover(projectId, lease)
      )
    ).toMatchObject({ status: 403, code: 'E2EE_DEVICE_NOT_CERTIFIED' });
    expect(formatOf(srv, projectId)).toBe(2);
  });

  it('abandons: drops every staged plaintext row and object, and the project stays encrypted and writable', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv, { revisions: 2 });
    const { projectId } = encrypted;
    const objectsBefore = new Set(srv.bucket.objects.keys());
    const before = usage(srv);
    const leases = memoryLeaseStore();
    const desktop = reverseOn(srv, owner, 'owner_desktop', {
      leases,
      beforeStep: (step) => {
        if (step === 'cutover') throw new Error('Stop here.');
      }
    });
    await expect(decryptFully(desktop, projectId)).rejects.toThrow('Stop');
    expect(count(srv, 'revisions', projectId)).toBe(2);
    expect(count(srv, 'artifacts', projectId)).toBe(3);
    await desktop.engine.cancel(projectId);
    expect(migrationRow(srv, projectId)).toMatchObject({
      direction: 'decrypt',
      state: 'abandoned',
      purge_cursor: null
    });
    for (const table of [
      'revisions',
      'artifacts',
      'project_document_objects',
      'project_storage_assets',
      'project_measurements',
      'project_workspace_sessions',
      'upload_sessions'
    ]) {
      expect(count(srv, table, projectId), table).toBe(0);
    }
    // Every object the staging wrote is gone; the ciphertext's are kept.
    expect(new Set(srv.bucket.objects.keys())).toEqual(objectsBefore);
    expect(usage(srv)).toBe(before);
    expect((await srv.call('GET', '/api/account/storage')).status).toBe(200);
    expect(formatOf(srv, projectId)).toBe(2);
    // Encrypted writes work again.
    const laptop = device(srv, owner, 'owner_laptop', {
      mls: encrypted.encryptor.mls,
      pins: encrypted.encryptor.pins
    });
    const head = await laptop.store.loadProject(projectId);
    await laptop.store.saveProjectDocument({
      projectId: head.projectId,
      expectedVersion: head.version,
      document: { ...head, version: head.version + 1 }
    });
    // And it can be turned back into plaintext later, from the start.
    await decryptFully(reverseOn(srv, owner, 'owner_desktop'), projectId);
    expect(formatOf(srv, projectId)).toBe(1);
    expectNoCiphertext(srv, projectId);
  });

  it('can be encrypted again afterwards', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv, { revisions: 2 });
    const { projectId } = encrypted;
    await decryptFully(reverseOn(srv, owner, 'owner_desktop'), projectId);
    expect(formatOf(srv, projectId)).toBe(1);
    await encryptExisting(srv, projectId);
    expect(migrationRow(srv, projectId)).toMatchObject({
      direction: 'encrypt',
      state: 'done'
    });
    expect(count(srv, 'revisions', projectId)).toBe(0);
    expect(count(srv, 'artifacts', projectId)).toBe(0);
    expect(count(srv, 'e2ee_project_revisions', projectId)).toBe(2);
    expect((await srv.call('GET', '/api/account/storage')).status).toBe(200);
  });

  it('leaves a purge its browser dropped to the scheduled sweep', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv, { revisions: 1 });
    const { projectId } = encrypted;
    const desktop = reverseOn(srv, owner, 'owner_desktop', {
      beforeStep: (step) => {
        if (step === 'purge') throw new Error('The tab was closed.');
      }
    });
    await expect(decryptFully(desktop, projectId)).rejects.toThrow('closed');
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'cutover' });
    expect(formatOf(srv, projectId)).toBe(1);
    // The plaintext opens at once; the ciphertext is still there.
    expect((await srv.call('GET', `/api/projects/${projectId}`)).status).toBe(
      200
    );
    expect(count(srv, 'e2ee_project_versions', projectId)).toBeGreaterThan(0);
    srv.db
      .prepare(
        "UPDATE e2ee_project_migrations SET updated_at = '2000-01-01T00:00:00.000Z'"
      )
      .run();
    for (let run = 0; run < 3; run++) await worker.scheduled({}, srv.env);
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'done' });
    expectNoCiphertext(srv, projectId);
    await expectOpensAsPlaintext(srv, encrypted);
  });

  it('takes plaintext files once cut over, while its ciphertext is still purged (#914 fence)', async () => {
    const srv = roomServer();
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    const desktop = reverseOn(srv, owner, 'owner_desktop', {
      beforeStep: (step) => {
        if (step === 'purge') throw new Error('The tab was closed.');
      }
    });
    await expect(decryptFully(desktop, projectId)).rejects.toThrow('closed');
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'cutover' });
    // The project is plaintext again: an ordinary upload lands at once,
    // though its encrypted rows wait for the purge (they are not files).
    const before = count(srv, 'artifacts', projectId);
    await upload(srv, projectId, {
      fileName: 'after-cutover.stl',
      contentType: 'model/stl',
      kind: 'stl-export',
      bytes: text('After the cutover')
    });
    expect(count(srv, 'artifacts', projectId)).toBe(before + 1);
    expect(count(srv, 'e2ee_project_versions', projectId)).toBeGreaterThan(0);
  });

  it('deletes a project mid-staging without leaving its account usage behind', async () => {
    const srv = roomServer();
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    const desktop = reverseOn(srv, owner, 'owner_desktop', {
      beforeStep: (step) => {
        if (step === 'cutover') throw new Error('Stop here.');
      }
    });
    await expect(decryptFully(desktop, projectId)).rejects.toThrow('Stop');
    expect(count(srv, 'artifacts', projectId)).toBe(3);
    expect(
      (await srv.call('DELETE', `/api/projects/${projectId}`)).status
    ).toBe(204);
    // The blobs counted and are gone; the staged files never counted.
    expect(usage(srv)).toBe(0);
    expect((await srv.call('GET', '/api/account/storage')).status).toBe(200);
    expect(migrationRow(srv, projectId)).toBeUndefined();
  });

  it('drops what it staged when the encrypted head moved under it', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv, { revisions: 1 });
    const { projectId } = encrypted;
    let raced = false;
    const desktop = reverseOn(srv, owner, 'owner_desktop', {
      beforeStep: (step) => {
        if (step === 'cutover' && !raced) {
          raced = true;
          // An encrypted write that raced the start: stale at the cutover.
          srv.db
            .prepare(
              'UPDATE projects SET document_version = document_version + 1 WHERE id = ?'
            )
            .run(projectId);
        }
      }
    });
    // The cutover refuses it as stale; the engine abandons what it staged
    // and starts over, which stops at a head it cannot verify.
    const refused = await errorOf(decryptFully(desktop, projectId));
    expect(raced).toBe(true);
    expect(refused).toBeDefined();
    expect(formatOf(srv, projectId)).toBe(2);
    expect(count(srv, 'revisions', projectId)).toBe(0);
    expect(count(srv, 'artifacts', projectId)).toBe(0);
  });

  it('lands a staged file only while its decrypt staging lasts, and still refuses an ordinary upload (#914 fence)', async () => {
    const srv = roomServer();
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    const desktop = reverseOn(srv, owner, 'owner_desktop', {
      beforeStep: (step) => {
        if (step === 'cutover') throw new Error('Stop here.');
      }
    });
    await expect(decryptFully(desktop, projectId)).rejects.toThrow('Stop');
    const lease = migrationRow(srv, projectId)!.lease_id as string;
    const leased = withMigrationLease(desktop.d.fetcher, lease);
    const file = {
      projectId,
      fileName: 'late.stl',
      contentType: 'model/stl',
      kind: 'stl-export'
    };
    // An ordinary plaintext upload of the migrating project is refused.
    expect(
      (await srv.call('POST', '/api/uploads', { body: file })).status
    ).toBe(409);
    // The lease holder's own staging upload opens, under the decrypt lease.
    const created = await leased('/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(file)
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as {
      session: { uploadSessionId: string; uploadUrl: string };
    };
    // The staging is abandoned after the session was checked and before
    // its claim lands: the claim carries the decrypt staging fence, so it
    // lands nothing, and the lease holder hears that its lease is gone.
    const create = srv.bucket.createMultipartUpload as unknown as (
      key: string,
      options: unknown
    ) => Promise<unknown>;
    srv.bucket.createMultipartUpload = vi.fn(
      async (key: string, options: unknown) => {
        srv.db
          .prepare(
            `UPDATE e2ee_project_migrations
             SET state = 'abandoned', lease_id = NULL, lease_expires_at = NULL,
                 purge_cursor = 'cleanup'
             WHERE project_id = ?`
          )
          .run(projectId);
        return create(key, options);
      }
    );
    const put = await leased(session.uploadUrl, {
      method: 'PUT',
      body: text('Late staged file')
    });
    expect(put.status).toBe(409);
    expect(((await put.json()) as { code: string }).code).toBe(
      E2EE_MIGRATION_CODES.leaseLost
    );
    expect(
      srv.db
        .prepare('SELECT reservation_state FROM upload_sessions WHERE id = ?')
        .get(session.uploadSessionId)
    ).toMatchObject({ reservation_state: 'open' });
  });

  it('abandons a decrypt staging on the sweep once the reverse path is closed to its owner', async () => {
    const srv = roomServer();
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    const desktop = reverseOn(srv, owner, 'owner_desktop', {
      beforeStep: (step) => {
        if (step === 'cutover') throw new Error('Stop here.');
      }
    });
    await expect(decryptFully(desktop, projectId)).rejects.toThrow('Stop');
    expect(count(srv, 'artifacts', projectId)).toBe(3);
    srv.db
      .prepare(
        'UPDATE e2ee_project_migrations SET lease_expires_at = 1 WHERE project_id = ?'
      )
      .run(projectId);
    // Lapsed, while the owner may still use the reverse path: it resumes.
    await worker.scheduled({}, srv.env);
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'staging' });
    // Migration stays open, the reverse path does not: the reverse routes
    // no longer answer, so the sweep abandons it and drops what it staged.
    srv.env.E2EE_REVERSE_ENABLED = 'false';
    await worker.scheduled({}, srv.env);
    expect(migrationRow(srv, projectId)).toMatchObject({
      direction: 'decrypt',
      state: 'abandoned',
      lease_id: null,
      purge_cursor: null
    });
    expect(count(srv, 'artifacts', projectId)).toBe(0);
    expect(count(srv, 'revisions', projectId)).toBe(0);
    expect(formatOf(srv, projectId)).toBe(2);
  });
});

// --- The owner's limits at the cutover ----------------------------------------------

/** The ciphertext bytes of a project's encrypted blobs. */
function blobBytesOf(srv: Server, projectId: string): number {
  return (
    rows<{ bytes: number | null }>(
      srv,
      'SELECT SUM(ciphertext_bytes) AS bytes FROM e2ee_content_blobs WHERE project_id = ?',
      projectId
    )[0]!.bytes ?? 0
  );
}

/** The bytes of a project's (staged) files. */
function fileBytesOf(srv: Server, projectId: string): number {
  return (
    rows<{ bytes: number | null }>(
      srv,
      'SELECT SUM(bytes) AS bytes FROM artifacts WHERE project_id = ?',
      projectId
    )[0]!.bytes ?? 0
  );
}

/** The owner's document objects and storage assets, every project's. */
function storedBytesOf(srv: Server): number {
  const sum = (table: string) =>
    (
      srv.db
        .prepare(
          `SELECT COALESCE(SUM(t.stored_bytes), 0) AS bytes FROM ${table} t
           JOIN projects p ON p.id = t.project_id WHERE p.user_id = ?`
        )
        .get(OWNER) as { bytes: number }
    ).bytes;
  return sum('project_document_objects') + sum('project_storage_assets');
}

function setLimit(
  srv: Server,
  column: 'artifact_limit_bytes' | 'project_storage_limit_bytes',
  bytes: number
) {
  srv.db
    .prepare(`UPDATE users SET ${column} = ? WHERE id = ?`)
    .run(bytes, OWNER);
}

/** Stages a file no encrypted blob names, under the decrypt lease. */
async function stageExtraFile(
  r: ReverseDevice,
  srv: Server,
  projectId: string,
  name: string,
  bytes: Uint8Array
): Promise<string> {
  const lease = migrationRow(srv, projectId)!.lease_id as string;
  return createMigrationPlaintextTarget(
    withMigrationLease(r.d.fetcher, lease)
  ).stageFile(projectId, {
    fileName: name,
    contentType: 'model/stl',
    kind: 'stl-export',
    body: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'model/stl' })
  });
}

describe('the owner’s limits at the cutover', () => {
  it('refuses a cutover that would publish staged files over the artifact limit; the project stays encrypted and can be abandoned', async () => {
    const srv = roomServer();
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    const before = usage(srv);
    const blobBytes = blobBytesOf(srv, projectId);
    const objectsBefore = new Set(srv.bucket.objects.keys());
    // Each extra file alone outweighs every encrypted blob of the project.
    const extra = new Uint8Array(blobBytes + 4096).fill(7);
    let staged = false;
    const desktop: ReverseDevice = reverseOn(srv, owner, 'owner_desktop', {
      beforeStep: async (step) => {
        if (step !== 'cutover' || staged) return;
        staged = true;
        // The lease holder stages files no blob names: while staging they
        // count toward nothing (migration 0043).
        for (const index of [1, 2, 3]) {
          await stageExtraFile(
            desktop,
            srv,
            projectId,
            `extra-${index}.stl`,
            extra
          );
        }
        expect(count(srv, 'artifacts', projectId)).toBe(6);
        expect(usage(srv)).toBe(before);
        // Once the files staged so far would already leave the account at
        // its limit after the cutover, a further staged file is refused.
        const room =
          2147483648 - (before + fileBytesOf(srv, projectId) - blobBytes);
        const bump = (bytes: number) =>
          srv.db
            .prepare(
              'UPDATE artifact_account_usage SET finalized_bytes = finalized_bytes + ? WHERE owner_user_id = ?'
            )
            .run(bytes, OWNER);
        bump(room);
        expect(
          await errorOf(
            stageExtraFile(desktop, srv, projectId, 'extra-4.stl', extra)
          )
        ).toMatchObject({ status: 413, code: 'ARTIFACT_QUOTA_EXCEEDED' });
        bump(-room);
        expect(count(srv, 'artifacts', projectId)).toBe(6);
        // The owner has room for one more file of that size, not three.
        setLimit(srv, 'artifact_limit_bytes', before + extra.byteLength);
      }
    });
    expect(await errorOf(decryptFully(desktop, projectId))).toMatchObject({
      status: 413,
      code: 'ARTIFACT_QUOTA_EXCEEDED'
    });
    expect(staged).toBe(true);
    expect(desktop.progress.at(-1)).toMatchObject({
      phase: 'error',
      error: { code: 'ARTIFACT_QUOTA_EXCEEDED', retryable: false }
    });
    // Nothing moved: still encrypted, still staging, usage as before.
    expect(formatOf(srv, projectId)).toBe(2);
    expect(migrationRow(srv, projectId)).toMatchObject({
      direction: 'decrypt',
      state: 'staging'
    });
    expect(usage(srv)).toBe(before);
    expect(desktop.cutover).toEqual([]);
    // Abandoned: every staged file goes, and the usage stays as it was.
    await desktop.engine.cancel(projectId);
    expect(migrationRow(srv, projectId)).toMatchObject({
      state: 'abandoned',
      purge_cursor: null
    });
    expect(count(srv, 'artifacts', projectId)).toBe(0);
    expect(new Set(srv.bucket.objects.keys())).toEqual(objectsBefore);
    expect(usage(srv)).toBe(before);
    expect(formatOf(srv, projectId)).toBe(2);
  });

  it('completes a reverse whose staged files fit the artifact limit exactly', async () => {
    const srv = roomServer();
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    const before = usage(srv);
    const blobBytes = blobBytesOf(srv, projectId);
    let after = 0;
    const desktop: ReverseDevice = reverseOn(srv, owner, 'owner_desktop', {
      beforeStep: async (step) => {
        if (step !== 'cutover' || after) return;
        await stageExtraFile(
          desktop,
          srv,
          projectId,
          'extra.stl',
          new Uint8Array(blobBytes + 4096).fill(7)
        );
        after = before + fileBytesOf(srv, projectId) - blobBytes;
        expect(after).toBeGreaterThan(before);
        setLimit(srv, 'artifact_limit_bytes', after);
      }
    });
    await decryptFully(desktop, projectId);
    expect(formatOf(srv, projectId)).toBe(1);
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'done' });
    expect(usage(srv)).toBe(after);
    expectNoCiphertext(srv, projectId);
  });

  it('refuses a cutover over the project storage limit, in its own batch, then completes once there is room', async () => {
    const srv = roomServer();
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    // The staged documents count toward nothing yet; at the cutover they
    // all would. The limit drops to one byte short of them after the
    // cutover's checks and before its batch lands: the batch refuses.
    const db = srv.env.DB as D1Database;
    const batch = db.batch.bind(db);
    let armed = true;
    db.batch = async (statements: D1PreparedStatement[]) => {
      const cut = statements.some((statement) =>
        /SET state = 'cutover'/.test(
          (statement as unknown as { sql?: string }).sql ?? ''
        )
      );
      if (armed && cut) {
        armed = false;
        setLimit(srv, 'project_storage_limit_bytes', storedBytesOf(srv) - 1);
      }
      return batch(statements);
    };
    const desktop = reverseOn(srv, owner, 'owner_desktop');
    expect(await errorOf(decryptFully(desktop, projectId))).toMatchObject({
      status: 413,
      code: 'PROJECT_STORAGE_QUOTA'
    });
    expect(desktop.progress.at(-1)).toMatchObject({
      phase: 'error',
      error: { code: 'PROJECT_STORAGE_QUOTA', retryable: false }
    });
    expect(formatOf(srv, projectId)).toBe(2);
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'staging' });
    // With exactly enough room, a retry resumes (reusing the staged head,
    // so it needs no more) and cuts over.
    setLimit(srv, 'project_storage_limit_bytes', storedBytesOf(srv));
    await decryptFully(desktop, projectId);
    expect(formatOf(srv, projectId)).toBe(1);
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'done' });
    expectNoCiphertext(srv, projectId);
  });
});

// --- Staged heads ----------------------------------------------------------------------

/** The project's document objects: their ids, keys, and which rows name them. */
function documentObjectsOf(srv: Server, projectId: string) {
  return rows<{ id: string; object_key: string; named: number }>(
    srv,
    `SELECT o.id, o.object_key,
            (EXISTS (SELECT 1 FROM projects p WHERE p.document_object_id = o.id)
             OR EXISTS (SELECT 1 FROM revisions r
                        WHERE r.document_object_id = o.id)) AS named
     FROM project_document_objects o WHERE o.project_id = ? ORDER BY o.id`,
    projectId
  );
}

/** Every document object of the project is named, and R2 holds just those. */
function expectOnlyReferencedDocuments(
  srv: Server,
  projectId: string,
  revisions: number
) {
  const objects = documentObjectsOf(srv, projectId);
  expect(objects.filter((o) => !o.named)).toEqual([]);
  // One per save state, and the head.
  expect(objects).toHaveLength(revisions + 1);
  const prefix = `project-storage/${projectId}/documents/`;
  expect(
    [...srv.bucket.objects.keys()].filter((key) => key.startsWith(prefix)).sort()
  ).toEqual(objects.map((o) => o.object_key).sort());
}

describe('staged heads', () => {
  it('reuses the staged head on a resume, so the cutover leaves no second head behind', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv, { revisions: 2 });
    const { projectId } = encrypted;
    const leases = memoryLeaseStore();
    // The tab closes after the head is staged, before the cutover.
    const first = reverseOn(srv, owner, 'owner_desktop', {
      leases,
      beforeStep: (step) => {
        if (step === 'info') throw new Error('The tab was closed.');
      }
    });
    await expect(decryptFully(first, projectId)).rejects.toThrow('closed');
    const journaled = migrationRow(srv, projectId)!;
    expect(journaled).toMatchObject({ state: 'staging' });
    expect(journaled.staged_version).toBeGreaterThan(0);
    expect(documentObjectsOf(srv, projectId)).toHaveLength(3);

    // Reloaded: the resume stages the same head, which answers from the
    // journal instead of storing another object.
    let atCutover = -1;
    const second = reverseOn(srv, owner, 'owner_desktop', {
      from: first.d,
      leases,
      beforeStep: (step) => {
        if (step === 'cutover') {
          atCutover = documentObjectsOf(srv, projectId).length;
        }
      }
    });
    await decryptFully(second, projectId);
    expect(atCutover).toBe(3);
    expect(migrationRow(srv, projectId)).toMatchObject({
      state: 'done',
      staged_hash: journaled.staged_hash
    });
    expectOnlyReferencedDocuments(srv, projectId, 2);
    // What counts toward the owner's storage is what the project names.
    const named = rows<{ bytes: number }>(
      srv,
      `SELECT COALESCE(SUM(stored_bytes), 0) AS bytes
       FROM project_document_objects WHERE project_id = ?`,
      projectId
    )[0]!.bytes;
    const assets = rows<{ bytes: number }>(
      srv,
      `SELECT COALESCE(SUM(stored_bytes), 0) AS bytes
       FROM project_storage_assets WHERE project_id = ?`,
      projectId
    )[0]!.bytes;
    expect(storedBytesOf(srv)).toBe(named + assets);
    expectNoCiphertext(srv, projectId);
    await expectOpensAsPlaintext(srv, encrypted);
  });

  it('drops a superseded staged head in the purge', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv, { revisions: 1 });
    const { projectId } = encrypted;
    let decoyed = false;
    const desktop: ReverseDevice = reverseOn(srv, owner, 'owner_desktop', {
      beforeStep: async (step) => {
        if (step === 'head' && !decoyed) {
          decoyed = true;
          // Another head at the same version, then the engine's own: the
          // first is superseded, and nothing names it after the cutover.
          const row = migrationRow(srv, projectId)!;
          await createMigrationPlaintextTarget(
            withMigrationLease(desktop.d.fetcher, row.lease_id as string)
          ).stageHead(projectId, {
            ...initialDocument('Decoy head'),
            projectId: projectId as ProjectDocument['projectId'],
            version: (row.source_version as number) + 1
          });
        }
        if (step === 'purge') {
          // Cut over: the decoy is still there, unreferenced.
          expect(
            documentObjectsOf(srv, projectId).filter((o) => !o.named)
          ).toHaveLength(1);
        }
      }
    });
    await decryptFully(desktop, projectId);
    expect(decoyed).toBe(true);
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'done' });
    expectOnlyReferencedDocuments(srv, projectId, 1);
    const opened = await expectOpensAsPlaintext(srv, encrypted);
    expect(opened.name).toBe('Secret bracket');
  });
});

// --- Staged upload sessions ----------------------------------------------------------

/** Opens a staged file's upload session under the current decrypt lease. */
async function openStagedUpload(
  r: ReverseDevice,
  srv: Server,
  projectId: string,
  metadata: Record<string, string> = {}
) {
  const lease = migrationRow(srv, projectId)!.lease_id as string;
  const created = await withMigrationLease(r.d.fetcher, lease)('/api/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId,
      fileName: 'staged.stl',
      contentType: 'model/stl',
      kind: 'stl-export',
      metadata
    })
  });
  expect(created.status).toBe(201);
  return (
    (await created.json()) as {
      session: {
        uploadSessionId: string;
        uploadUrl: string;
        artifactId: string;
      };
    }
  ).session;
}

async function codeOf(response: Response) {
  return ((await response.json()) as { code?: string }).code;
}

describe('staged upload sessions', () => {
  it('advance only under the decrypt lease that opened them, not one that took over', async () => {
    const srv = roomServer();
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    const desktop = reverseOn(srv, owner, 'owner_desktop', {
      beforeStep: (step) => {
        if (step === 'cutover') throw new Error('Stop here.');
      }
    });
    await expect(decryptFully(desktop, projectId)).rejects.toThrow('Stop');
    const opener = migrationRow(srv, projectId)!.lease_id;
    const session = await openStagedUpload(desktop, srv, projectId);
    // The lease lapses and another start takes the staging over.
    srv.db
      .prepare(
        'UPDATE e2ee_project_migrations SET lease_expires_at = 1 WHERE project_id = ?'
      )
      .run(projectId);
    const taken = await createProjectMigrationsApi(desktop.d.fetcher).start(
      projectId,
      { direction: 'decrypt', deviceId: 'owner_laptop' },
      null
    );
    expect(migrationRow(srv, projectId)).toMatchObject({
      state: 'staging',
      lease_id: taken.leaseId
    });
    // The old session writes nothing, whichever lease the request names.
    for (const fetcher of [
      desktop.d.fetcher,
      withMigrationLease(desktop.d.fetcher, taken.leaseId)
    ]) {
      const put = await fetcher(session.uploadUrl, {
        method: 'PUT',
        body: text('Stale staged file')
      });
      expect(put.status).toBe(409);
      expect(await codeOf(put)).toBe(E2EE_MIGRATION_CODES.leaseLost);
    }
    expect(
      srv.db
        .prepare('SELECT reservation_state FROM upload_sessions WHERE id = ?')
        .get(session.uploadSessionId)
    ).toMatchObject({ reservation_state: 'open' });
    // A session the new lease opens works.
    const fresh = await openStagedUpload(desktop, srv, projectId);
    const put = await desktop.d.fetcher(fresh.uploadUrl, {
      method: 'PUT',
      body: text('Fresh staged file')
    });
    expect(put.status).toBe(204);
    // Each session records the lease that opened it.
    const leaseOf = (id: string) =>
      (
        JSON.parse(
          (
            srv.db
              .prepare('SELECT metadata_json FROM upload_sessions WHERE id = ?')
              .get(id) as { metadata_json: string }
          ).metadata_json
        ) as { decryptLease?: string }
      ).decryptLease;
    expect(leaseOf(session.uploadSessionId)).toBe(opener);
    expect(leaseOf(fresh.uploadSessionId)).toBe(taken.leaseId);
  });

  it('do not carry on as ordinary plaintext uploads after the cutover', async () => {
    const srv = roomServer();
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    const leases = memoryLeaseStore();
    const first = reverseOn(srv, owner, 'owner_desktop', {
      leases,
      beforeStep: (step) => {
        if (step === 'cutover') throw new Error('Stop here.');
      }
    });
    await expect(decryptFully(first, projectId)).rejects.toThrow('Stop');
    const pending = await openStagedUpload(first, srv, projectId);
    const written = await openStagedUpload(first, srv, projectId);
    expect(
      (
        await first.d.fetcher(written.uploadUrl, {
          method: 'PUT',
          body: text('Staged, not finalized')
        })
      ).status
    ).toBe(204);
    // The same browser resumes and cuts over: the project is plaintext.
    await decryptFully(
      reverseOn(srv, owner, 'owner_desktop', { from: first.d, leases }),
      projectId
    );
    expect(formatOf(srv, projectId)).toBe(1);
    const before = count(srv, 'artifacts', projectId);
    // Neither session opened under the decrypt lease lands anything now.
    const put = await first.d.fetcher(pending.uploadUrl, {
      method: 'PUT',
      body: text('Late staged file')
    });
    expect(put.status).toBe(409);
    expect(await codeOf(put)).toBe(E2EE_MIGRATION_CODES.leaseLost);
    const finalized = await first.d.fetcher('/api/artifacts/finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        uploadSessionId: written.uploadSessionId,
        artifactId: written.artifactId
      })
    });
    expect(finalized.status).toBe(409);
    expect(await codeOf(finalized)).toBe(E2EE_MIGRATION_CODES.leaseLost);
    expect(count(srv, 'artifacts', projectId)).toBe(before);
    // An ordinary upload cannot claim a decrypt lease: the key is dropped.
    const spoofed = await srv.call('POST', '/api/uploads', {
      body: {
        projectId,
        fileName: 'after.stl',
        contentType: 'model/stl',
        kind: 'stl-export',
        metadata: { decryptLease: 'spoofed', note: 'kept' }
      }
    });
    expect(spoofed.status).toBe(201);
    const { session } = (await spoofed.json()) as {
      session: { uploadSessionId: string; uploadUrl: string; artifactId: string };
    };
    expect(
      JSON.parse(
        (
          srv.db
            .prepare('SELECT metadata_json FROM upload_sessions WHERE id = ?')
            .get(session.uploadSessionId) as { metadata_json: string }
        ).metadata_json
      )
    ).toEqual({ note: 'kept' });
    expect(
      (
        await srv.call('PUT', session.uploadUrl, {
          raw: text('After the cutover')
        })
      ).status
    ).toBe(204);
    expect(
      (
        await srv.call('POST', '/api/artifacts/finalize', {
          body: {
            projectId,
            uploadSessionId: session.uploadSessionId,
            artifactId: session.artifactId
          }
        })
      ).status
    ).toBe(200);
    expect(count(srv, 'artifacts', projectId)).toBe(before + 1);
  });
});

// --- Save state authors -----------------------------------------------------------------

describe('save state authors', () => {
  it('keeps who saved each save state, as the encrypted history records them', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv);
    const { projectId } = encrypted;
    const [byOther, byGone, spoofed] = encrypted.revisionIds as [
      string,
      string,
      string
    ];
    // A former collaborator saved one, an account since deleted another
    // (the project is no longer shared); the owner saved the third.
    const recordAuthor = (revisionId: string, author: string) =>
      srv.db
        .prepare(
          'UPDATE e2ee_project_revisions SET author_user_id = ? WHERE project_id = ? AND revision_id = ?'
        )
        .run(author, projectId, revisionId);
    recordAuthor(byOther, OTHER);
    recordAuthor(byGone, 'user_deleted_since');
    recordAuthor(spoofed, OWNER);
    const desktop = reverseOn(srv, owner, 'owner_desktop');
    const sent: Record<string, unknown> = {};
    // The browser names each save state's author; one request names
    // another account than the encrypted history records.
    desktop.d.before = async (path, init) => {
      if (!path.endsWith('/revisions') || init.method !== 'POST') return;
      const body = JSON.parse(init.body as string) as {
        savedRevisionId: string;
        authorUserId?: string;
      };
      sent[body.savedRevisionId] = body.authorUserId;
      if (body.savedRevisionId === spoofed) {
        init.body = JSON.stringify({ ...body, authorUserId: OTHER });
      }
    };
    await decryptFully(desktop, projectId);
    expect(sent).toEqual({
      [byOther]: OTHER,
      [byGone]: 'user_deleted_since',
      [spoofed]: OWNER
    });
    const authors = Object.fromEntries(
      rows<{ id: string; author_user_id: string }>(
        srv,
        'SELECT id, author_user_id FROM revisions WHERE project_id = ?',
        projectId
      ).map((r) => [r.id, r.author_user_id])
    );
    expect(authors).toEqual({
      [byOther]: OTHER,
      // An account that no longer exists, or one the history does not
      // record for that save state: the owner who staged it.
      [byGone]: OWNER,
      [spoofed]: OWNER
    });
    // The history panel shows them.
    const listed = (await (
      await srv.call('GET', `/api/projects/${projectId}/revisions`)
    ).json()) as { revisions: { revisionId: string; authorUserId?: string }[] };
    expect(
      listed.revisions.find((r) => r.revisionId === byOther)?.authorUserId
    ).toBe(OTHER);
  });
});

// --- Refusals -----------------------------------------------------------------------

describe('who may turn encryption off', () => {
  async function start(srv: Server, d: Device, projectId: string) {
    return errorOf(
      createProjectMigrationsApi(d.fetcher).start(projectId, {
        direction: 'decrypt',
        deviceId: d.deviceId!
      })
    );
  }

  it('refuses a shared project: a member, a pending invitation or a share link', async () => {
    const srv = roomServer();
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    const laptop = device(srv, owner, 'owner_laptop');
    const shares = [
      () =>
        srv.db
          .prepare(
            `INSERT INTO project_members
               (project_id, user_id, role, added_by_user_id, created_at, updated_at)
             VALUES (?, ?, 'viewer', ?, 1, 1)`
          )
          .run(projectId, OTHER, OWNER),
      () =>
        srv.db
          .prepare(
            `INSERT INTO project_share_links
               (id, project_id, mode, token_hash, created_by_user_id, created_at)
             VALUES ('link_1', ?, 'view', ?, ?, 1)`
          )
          .run(projectId, 'h'.repeat(64), OWNER),
      // A pending encrypted invitation (slice 5-3a).
      () =>
        srv.db
          .prepare(
            `INSERT INTO e2ee_invitations
               (invitation_id, project_id, invited_by_user_id, email_hash,
                role, token_hash, statement, signature, signer_device_id,
                created_at, expires_at)
             VALUES ('einv_1', ?, ?, ?, 'viewer', ?, 'statement', ?,
                     'owner_laptop', 'now', ?)`
          )
          .run(
            projectId,
            OWNER,
            'e'.repeat(64),
            't'.repeat(64),
            's'.repeat(87),
            Date.now() + 3_600_000
          )
    ];
    for (const share of shares) {
      share();
      expect(await start(srv, laptop, projectId)).toMatchObject({
        status: 409,
        code: E2EE_MIGRATION_CODES.shared
      });
      srv.db
        .prepare('DELETE FROM project_members WHERE project_id = ?')
        .run(projectId);
      srv.db
        .prepare('DELETE FROM project_share_links WHERE project_id = ?')
        .run(projectId);
      srv.db
        .prepare('DELETE FROM e2ee_invitations WHERE project_id = ?')
        .run(projectId);
    }
    expect(migrationRow(srv, projectId)).toMatchObject({
      direction: 'encrypt',
      state: 'done'
    });
    expect(formatOf(srv, projectId)).toBe(2);
    expect(
      decryptionErrorOf({ code: E2EE_MIGRATION_CODES.shared })
    ).toMatchObject({ retryable: false });
  });

  it('refuses to start or cut over while a live encrypted share link names the project, and goes ahead once it is revoked', async () => {
    const srv = roomServer();
    const encrypted = await encryptedProject(srv, { revisions: 1 });
    const { projectId } = encrypted;
    insertEncryptedShareLink(srv, projectId);
    const laptop = device(srv, owner, 'owner_laptop');
    expect(await start(srv, laptop, projectId)).toMatchObject({
      status: 409,
      code: E2EE_MIGRATION_CODES.shared
    });
    expect(migrationRow(srv, projectId)).toMatchObject({
      direction: 'encrypt',
      state: 'done'
    });
    revokeEncryptedShareLinks(srv, projectId);
    // Started, then a link goes live before the cutover: it refuses.
    let linked = false;
    const desktop = reverseOn(srv, owner, 'owner_desktop', {
      beforeStep: (step) => {
        if (step !== 'cutover' || linked) return;
        linked = true;
        insertEncryptedShareLink(srv, projectId, 'share_2');
      }
    });
    expect(await errorOf(decryptFully(desktop, projectId))).toMatchObject({
      status: 409,
      code: E2EE_MIGRATION_CODES.shared
    });
    expect(formatOf(srv, projectId)).toBe(2);
    expect(migrationRow(srv, projectId)).toMatchObject({
      direction: 'decrypt',
      state: 'staging'
    });
    // Revoked, the same run resumes and cuts over.
    revokeEncryptedShareLinks(srv, projectId);
    await decryptFully(desktop, projectId);
    expect(formatOf(srv, projectId)).toBe(1);
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'done' });
  });

  it('refuses while the account encrypts new projects (decision D2)', async () => {
    const srv = roomServer();
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_preferences
           (user_id, encrypt_new_projects, record, record_mac, sequence, updated_at)
         VALUES (?, 1, 'r', ?, 1, 'now')`
      )
      .run(OWNER, 'm'.repeat(43));
    const desktop = reverseOn(srv, owner, 'owner_desktop');
    expect((await errorOf(decryptFully(desktop, projectId))).code).toBe(
      E2EE_MIGRATION_CODES.optedIn
    );
    expect(desktop.progress.at(-1)).toMatchObject({
      phase: 'error',
      error: { code: E2EE_MIGRATION_CODES.optedIn, retryable: false }
    });
    expect(formatOf(srv, projectId)).toBe(2);
    expect(count(srv, 'revisions', projectId)).toBe(0);
  });

  it('refuses anyone but the owner', async () => {
    const srv = roomServer();
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    const outsider = device(srv, other, 'other_laptop');
    expect(await start(srv, outsider, projectId)).toMatchObject({
      status: 404
    });
    // A plaintext write under someone else's lease is refused as before.
    const leased = withMigrationLease(outsider.fetcher, 'L'.repeat(43));
    expect(
      (
        await leased(`/api/projects/${projectId}/document`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId,
            expectedVersion: 1,
            document: initialDocument('x', OTHER)
          })
        })
      ).status
    ).not.toBe(200);
    expect(formatOf(srv, projectId)).toBe(2);
  });

  it('refuses a plaintext project and a project in the recycle bin', async () => {
    const srv = roomServer();
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    const laptop = device(srv, owner, 'owner_laptop');
    const created = await srv.call('POST', '/api/projects', {
      body: { name: 'Plain', initialDocument: initialDocument('Plain') }
    });
    const plain = ((await created.json()) as { document: ProjectDocument })
      .document.projectId;
    expect(await start(srv, laptop, plain)).toMatchObject({
      status: 409,
      code: E2EE_MIGRATION_CODES.state
    });
    srv.db
      .prepare("UPDATE projects SET status = 'deleted' WHERE id = ?")
      .run(projectId);
    expect(await start(srv, laptop, projectId)).toMatchObject({
      status: 409,
      code: E2EE_MIGRATION_CODES.state
    });
  });
});

// --- Flag off and migration missing -------------------------------------------------

describe('with the reverse path closed', () => {
  it('serves nothing new while E2EE_REVERSE_ENABLED is off', async () => {
    const srv = roomServer([owner, other], { E2EE_MIGRATION_ENABLED: 'true' });
    const { projectId } = await encryptedProject(srv, { revisions: 1 });
    const laptop = device(srv, owner, 'owner_laptop');
    const api = createProjectMigrationsApi(laptop.fetcher);
    expect(
      await errorOf(
        api.start(projectId, { direction: 'decrypt', deviceId: 'owner_laptop' })
      )
    ).toMatchObject({ status: 501, code: 'FEATURE_DISABLED' });
    expect(
      await errorOf(api.stagedPlaintext(projectId, 'L'.repeat(43)))
    ).toMatchObject({ status: 501 });
    expect(await (await srv.call('GET', '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: true,
      migrationEnabled: true
    });
    // A staging row left from when it was on changes nothing: no plaintext
    // write lands under its lease and encrypted writes are not refused.
    const lease = 'L'.repeat(43);
    srv.db
      .prepare(
        `UPDATE e2ee_project_migrations
         SET direction = 'decrypt', state = 'staging', lease_id = ?,
             lease_expires_at = ?, device_id = 'owner_laptop'
         WHERE project_id = ?`
      )
      .run(lease, Date.now() + 60_000, projectId);
    const leased = withMigrationLease(laptop.fetcher, lease);
    const head = await device(srv, owner, 'owner_desktop').store.loadProject(
      projectId
    );
    const write = await leased(`/api/projects/${projectId}/document`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        expectedVersion: head.version,
        document: { ...head, version: head.version + 1 }
      })
    });
    expect(write.status).toBe(409);
    expect(((await write.json()) as { code: string }).code).toBe(
      'PROJECT_FORMAT_UNSUPPORTED'
    );
    expect(count(srv, 'revisions', projectId)).toBe(0);
    expect(count(srv, 'project_document_objects', projectId)).toBe(0);
  });

  it('keeps the reverse path closed, and everything else working, without migration 0043', async () => {
    const srv = roomServer([owner, other], REVERSE_ON, databaseBefore(43));
    const laptop = device(srv, owner, 'owner_laptop');
    const created = await laptop.store.createProject({
      name: 'Encrypted',
      initialDocument: initialDocument('Encrypted')
    });
    const projectId = created.document.projectId;
    expect(
      await errorOf(
        createProjectMigrationsApi(laptop.fetcher).start(projectId, {
          direction: 'decrypt',
          deviceId: 'owner_laptop'
        })
      )
    ).toMatchObject({ status: 501, code: 'FEATURE_DISABLED' });
    expect(await (await srv.call('GET', '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: true,
      migrationEnabled: true
    });
    // Ordinary plaintext traffic and storage usage are unchanged.
    const plain = await srv.call('POST', '/api/projects', {
      body: { name: 'Plain', initialDocument: initialDocument('Plain') }
    });
    const document = ((await plain.json()) as { document: ProjectDocument })
      .document;
    await upload(srv, document.projectId, {
      fileName: 'a.step',
      contentType: 'model/step',
      kind: 'step-import',
      bytes: STEP
    });
    await namedSave(srv, await autosave(srv, document), 'Named');
    expect((await srv.call('GET', '/api/account/storage')).status).toBe(200);
    srv.statements.length = 0;
    expect((await srv.call('GET', '/api/account/storage')).status).toBe(200);
    for (const sql of srv.statements.filter((s) =>
      /e2ee_decrypt_staged_projects/.test(s)
    )) {
      expect(sql, sql).toMatch(/FROM sqlite_master/);
    }
  });

  it('reports the reverse path in the config only when open and installed', async () => {
    const srv = roomServer();
    expect(await (await srv.call('GET', '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: true,
      migrationEnabled: true,
      reverseEnabled: true
    });
    await worker.scheduled({}, srv.env);
  });
});

// --- Helpers ------------------------------------------------------------------------

describe('reverse engine helpers', () => {
  it('names each blob a document holds with what it is as a file', () => {
    const blob = 'b'.repeat(32);
    const document = withImport(initialDocument('Bracket'), blob);
    const files = documentBlobFiles(document, (id) =>
      id === blob ? 'import-source' : null
    );
    expect([...files.entries()]).toEqual([
      [
        blob,
        {
          kind: 'step-import',
          fileName: 'secret-part.step',
          contentType: 'model/step'
        }
      ]
    ]);
    // A device-local id (no blob reference) is left alone.
    expect(documentBlobFiles(document, () => null).size).toBe(0);
    expect(DECRYPT_STAGED_BLOB_METADATA_KEY).toBe('e2eeBlobId');
  });

  it('lists live encrypted projects, newest first', () => {
    const summary = (
      projectId: string,
      updatedAt: string,
      extra: Partial<ProjectSummary> = {}
    ) =>
      ({
        projectId,
        name: projectId,
        revisionCount: 0,
        updatedAt,
        storageFormat: 2,
        ...extra
      }) as ProjectSummary;
    expect(
      decryptableProjects([
        summary('proj_old', '2026-10-01T00:00:00.000Z'),
        summary('proj_new', '2026-10-03T00:00:00.000Z'),
        summary('proj_plain', '2026-10-04T00:00:00.000Z', { storageFormat: 1 }),
        summary('proj_trashed', '2026-10-05T00:00:00.000Z', {
          organization: { status: 'deleted', pinned: false, sortOrder: 0 }
        })
      ]).map((p) => p.projectId)
    ).toEqual(['proj_new', 'proj_old']);
  });
});
