/**
 * The browser engine that encrypts an existing plaintext project (ADR-024
 * Phase 7, slice 7-2), over the real Worker, its room class and SQLite,
 * with Node devices that run the real client modules and the in-process
 * MLS engine. A plaintext project with a STEP import, several save
 * states, a thumbnail, an archived export, measurements and a view state
 * is staged, cut over and purged; then nothing plaintext remains and a
 * fresh browser opens it with its history.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  E2EE_MIGRATION_CODES,
  parseWorkspaceResumeState,
  type ProjectDocument,
  type ProjectSummary,
  type ProjectWorkspaceSession
} from '@openzcad/shared';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import { createProjectMigrationsApi } from '../apps/web/src/lib/e2ee/projectMigrationsApi';
import { createMigrationPlaintextSource } from '../apps/web/src/lib/e2ee/migrationPlaintextSource';
import {
  MigrationPausedError,
  createProjectMigrationEngine,
  memoryLeaseStore,
  migratableProjects,
  migrationErrorOf,
  withBlobIds,
  type MigrationLeaseStore,
  type MigrationProgress
} from '../apps/web/src/lib/e2ee/projectMigrationEngine';
import { ProjectCollaborationRoom } from '../apps/web/worker/e2eeRoom';
import { createRoomContext } from './collaboration-room-harness';
import {
  OTHER,
  OWNER,
  count,
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

/** Every secret the plaintext carries, which no stored byte may show after. */
const SECRETS = [
  'Secret bracket',
  'Secret import',
  'Secret one',
  'Secret two',
  'Secret STEP',
  'Secret thumbnail',
  'Secret export',
  'Secret gauge',
  'body_secret_view'
];

// --- Server --------------------------------------------------------------------

interface RoomServer extends Server {
  storage: Map<string, Map<string, unknown>>;
  /** What each project's room starts with: its plaintext latest, if any. */
  roomSeed: Map<string, ProjectDocument>;
  /** Answers the rooms' internal migration requests instead, while set. */
  roomFault:
    | ((request: Request, room: ProjectCollaborationRoom) => Promise<Response>)
    | null;
}

/** The real room class behind PROJECT_ROOM, seeded per project. */
function roomServer(accounts: readonly Account[] = [owner, other]): RoomServer {
  const rooms = new Map<string, ProjectCollaborationRoom>();
  const storage = new Map<string, Map<string, unknown>>();
  const roomSeed = new Map<string, ProjectDocument>();
  let env: Record<string, unknown> = {};
  const seed = (projectId: string) => {
    const latest = roomSeed.get(projectId);
    return latest
      ? new Map<string, unknown>([
          [
            'room:meta',
            {
              schema: 1,
              projectId,
              latestVersion: latest.version,
              historyVersions: [latest.version]
            }
          ],
          ['room:latest', latest],
          [`room:history:${latest.version}`, latest]
        ])
      : new Map<string, unknown>();
  };
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
      const fault = srv.roomFault;
      if (!fault) return room;
      const real = room;
      return {
        fetch: (request: Request) =>
          new URL(request.url).pathname === '/_internal/migration'
            ? fault(request, real)
            : real.fetch(request)
      };
    }
  };
  const srv: RoomServer = Object.assign(
    newServer(accounts, undefined, {
      E2EE_MIGRATION_ENABLED: 'true',
      PROJECT_ROOM: namespace
    }),
    { storage, roomSeed, roomFault: null }
  );
  env = srv.env;
  return srv;
}

// --- The plaintext project ------------------------------------------------------

async function upload(
  srv: Server,
  projectId: string,
  file: {
    fileName: string;
    contentType: string;
    kind: string;
    bytes: Uint8Array<ArrayBuffer>;
  }
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
    (await srv.call('PUT', session.uploadUrl, { raw: file.bytes })).status
  ).toBe(204);
  const finalized = await srv.call('POST', '/api/artifacts/finalize', {
    body: {
      projectId,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId
    }
  });
  expect(finalized.status).toBe(200);
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

function withImport(
  document: ProjectDocument,
  artifactId: string,
  bytes: Uint8Array
): ProjectDocument {
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
        checksumSha256: sha256(bytes),
        logicalBytes: bytes.byteLength
      }
    })
  );
  return manager.document;
}

function measurementRecord(projectId: string, label = 'Secret gauge') {
  return {
    projectId,
    version: 1,
    updatedAt: '2026-10-24T00:00:00.000Z',
    display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' },
    measurements: [
      {
        id: 'measure_1',
        kind: 'edge-length',
        label,
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
      camera: {
        position: [11, 22, 33],
        target: [0, 0, 0],
        orthographicZoom: 1
      },
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

const STEP = text(
  `ISO-10303-21;\nHEADER;\nFILE_NAME('Secret STEP');\n${'DATA;\n'.repeat(120)}END-ISO-10303-21;\n`
);

interface Plaintext {
  head: ProjectDocument;
  stepArtifactId: string;
  revisionIds: string[];
  reasons: string[];
}

/**
 * A plaintext project with a STEP import, three save states, a thumbnail,
 * an archived export, measurements and a view state.
 */
async function plaintextProject(
  srv: Server,
  { revisions = 3, room = true }: { revisions?: number; room?: boolean } = {}
): Promise<Plaintext> {
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
    ...withImport(document, stepArtifactId, STEP),
    version: document.version
  });
  const reasons = ['Secret one', 'Secret two', 'Secret three', 'Secret four'];
  for (let index = 0; index < revisions; index++) {
    document = await namedSave(srv, document, reasons[index]!);
    if (index < revisions - 1) document = await autosave(srv, document);
  }
  document = await autosave(srv, document);
  await upload(srv, projectId, {
    fileName: `${projectId}-thumbnail.webp`,
    contentType: 'image/webp',
    kind: 'thumbnail',
    bytes: text('RIFF Secret thumbnail WEBP')
  });
  await upload(srv, projectId, {
    fileName: 'secret-export.stl',
    contentType: 'model/stl',
    kind: 'stl-export',
    bytes: text('solid Secret export\nendsolid\n')
  });
  const measured = await srv.call(
    'PUT',
    `/api/projects/${projectId}/measurements`,
    { body: { expectedRevision: 0, record: measurementRecord(projectId) } }
  );
  expect(measured.status).toBe(200);
  const viewed = await srv.call(
    'PUT',
    `/api/projects/${projectId}/workspace-sessions`,
    { body: workspaceSession(projectId, document.version) }
  );
  expect(viewed.status).toBe(204);
  const head = (await (
    await srv.call('GET', `/api/projects/${projectId}`)
  ).json()) as ProjectDocument;
  if (room) (srv as RoomServer).roomSeed?.set(projectId, head);
  const listed = (await (
    await srv.call('GET', `/api/projects/${projectId}/revisions`)
  ).json()) as { revisions: { revisionId: string; reason: string }[] };
  expect(listed.revisions.map((r) => r.reason).sort()).toEqual(
    reasons.slice(0, revisions).sort()
  );
  return {
    head,
    stepArtifactId,
    revisionIds: listed.revisions.map((r) => r.revisionId),
    reasons: reasons.slice(0, revisions)
  };
}

// --- The engine on a device ----------------------------------------------------

interface EngineDevice {
  d: Device;
  engine: ReturnType<typeof createProjectMigrationEngine>;
  progress: MigrationProgress[];
  flushed: string[];
  summary(projectId: string): Promise<ProjectSummary>;
}

function engineOn(
  srv: Server,
  account: Account,
  deviceId: string,
  options: {
    from?: Device;
    leases?: MigrationLeaseStore;
    beforeStep?: (step: string, projectId: string) => void | Promise<void>;
  } = {}
): EngineDevice {
  const d = device(
    srv,
    account,
    deviceId,
    options.from ? { mls: options.from.mls, pins: options.from.pins } : {}
  );
  const base = d.fetcher;
  const progress: MigrationProgress[] = [];
  const flushed: string[] = [];
  const plaintext = createMigrationPlaintextSource(base);
  const engine = createProjectMigrationEngine({
    deviceId,
    fetcher: base,
    migrations: createProjectMigrationsApi(base),
    plaintext,
    leases: options.leases ?? memoryLeaseStore(),
    createStaging: (leased) => {
      d.fetcher = leased;
      return {
        store: d.store,
        blobs: d.blobs,
        references: d.references,
        measurements: d.measurements,
        viewStates: d.viewStates,
        groups: d.groups,
        documents: d.documents
      };
    },
    flushProject: async (projectId) => {
      flushed.push(projectId);
    },
    onProgress: (p) => progress.push(p),
    ...(options.beforeStep ? { beforeStep: options.beforeStep } : {})
  });
  return {
    d,
    engine,
    progress,
    flushed,
    summary: async (projectId) =>
      (await plaintext.listProjects()).find((p) => p.projectId === projectId)!
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

/** Everything the server stores, as text: D1 rows, R2 objects, room keys. */
function everythingStored(srv: RoomServer): string {
  const tables = rows<{ name: string }>(
    srv,
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).map((row) => row.name);
  const database = tables
    .map((table) => JSON.stringify(rows(srv, `SELECT * FROM "${table}"`)))
    .join('\n');
  const decoder = new TextDecoder();
  const objects = [...srv.bucket.objects.entries()]
    .map(([key, value]) => `${key}\n${decoder.decode(value)}`)
    .join('\n');
  const room = [...srv.storage.values()]
    .flatMap((values) => [...values.entries()])
    .map(([key, value]) => `${key} ${JSON.stringify(value)}`)
    .join('\n');
  return `${database}\n${objects}\n${room}`;
}

async function migrateFully(e: EngineDevice, projectId: string) {
  await e.engine.migrate(await e.summary(projectId));
}

async function codeOfCall(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  return (error as { code?: string }).code;
}

/** A fresh browser of the owner opens the project and its whole history. */
async function expectOpensWithHistory(
  srv: Server,
  plain: Plaintext,
  account = owner,
  deviceId = 'owner_desktop'
) {
  const fresh = device(srv, account, deviceId);
  const projectId = plain.head.projectId;
  const opened = await fresh.store.loadProject(projectId);
  expect(opened.name).toBe('Secret bracket');
  expect(opened.version).toBeGreaterThan(plain.head.version);
  const listed = await fresh.store.listRevisions(projectId);
  expect(listed.revisions.map((r) => r.revisionId).sort()).toEqual(
    [...plain.revisionIds].sort()
  );
  expect(listed.revisions.map((r) => r.reason).sort()).toEqual(
    [...plain.reasons].sort()
  );
  for (const revisionId of plain.revisionIds) {
    const revision = await fresh.store.loadRevision(projectId, revisionId);
    expect(revision?.revisions.at(-1)?.revisionId).toBe(revisionId);
  }
  // The STEP import names its blob, which decrypts to the same bytes.
  const blobIds = rows<{ blob_id: string; kind: string }>(
    srv,
    'SELECT blob_id, kind FROM e2ee_content_blobs WHERE project_id = ?',
    projectId
  );
  const stepBlob = JSON.stringify(opened).match(/"artifactId":"([^"]+)"/)?.[1];
  expect(blobIds.map((b) => b.blob_id)).toContain(stepBlob);
  expect(stepBlob).not.toBe(plain.stepArtifactId);
  expect(await fresh.blobs.read(projectId, stepBlob!)).toEqual(STEP);
  // Project info: name, thumbnail and the archived export.
  const info = (await fresh.store.info.read(projectId)).body!;
  expect(info.name).toBe('Secret bracket');
  expect(info.thumbnail).toBeDefined();
  expect(
    new TextDecoder().decode(
      await fresh.blobs.read(projectId, info.thumbnail!.blobId)
    )
  ).toBe('RIFF Secret thumbnail WEBP');
  expect(info.exports.map((entry) => entry.fileName)).toEqual([
    'secret-export.stl'
  ]);
  // Measurements and the view state.
  const measured = await fresh.measurements.loadProjectMeasurements(projectId);
  expect(measured.record?.measurements[0]?.label).toBe('Secret gauge');
  const sessions = await fresh.viewStates.load(projectId);
  expect(sessions.map((s) => s.state.selectedBodyIds)).toEqual([
    ['body_secret_view']
  ]);
  expect(sessions[0]!.documentVersion).toBeLessThan(opened.version);
  return fresh;
}

// --- Migration, cutover and purge -------------------------------------------------

describe('encrypting an existing project', () => {
  it('stages every save state, cuts over, purges, and leaves no plaintext anywhere', async () => {
    const srv = roomServer();
    const plain = await plaintextProject(srv);
    const projectId = plain.head.projectId;
    expect(plain.revisionIds).toHaveLength(3);
    const laptop = engineOn(srv, owner, 'owner_laptop');
    await migrateFully(laptop, projectId);

    // This page's edits were flushed before the start.
    expect(laptop.flushed).toEqual([projectId]);
    expect(migrationRow(srv, projectId)).toMatchObject({
      state: 'done',
      revision_count: 3,
      purge_cursor: null
    });
    expect(formatOf(srv, projectId)).toBe(2);
    const final = laptop.progress.at(-1)!;
    expect(final).toMatchObject({
      phase: 'done',
      revisionsDone: 3,
      revisionsTotal: 3
    });
    expect(final.bytesTotal).toBeGreaterThan(STEP.byteLength);
    expect(final.bytesDone).toBe(final.bytesTotal);
    // One blob per file: the STEP once (dedupe across save states), the
    // thumbnail and the export.
    expect(
      rows(
        srv,
        'SELECT kind FROM e2ee_content_blobs WHERE project_id = ? ORDER BY kind',
        projectId
      )
    ).toEqual([
      { kind: 'export' },
      { kind: 'import-source' },
      { kind: 'thumbnail' }
    ]);
    // A named save per save state, under its plaintext id.
    expect(
      rows<{ revision_id: string }>(
        srv,
        'SELECT revision_id FROM e2ee_project_revisions WHERE project_id = ?',
        projectId
      )
        .map((r) => r.revision_id)
        .sort()
    ).toEqual([...plain.revisionIds].sort());

    // The plaintext routes now answer 409.
    for (const path of [
      `/api/projects/${projectId}`,
      `/api/projects/${projectId}/revisions`,
      `/api/projects/${projectId}/measurements`
    ]) {
      const answer = await srv.call('GET', path);
      expect(answer.status, path).toBe(409);
    }
    const write = await srv.call('PUT', `/api/projects/${projectId}/document`, {
      body: {
        projectId,
        expectedVersion: plain.head.version,
        document: { ...plain.head, version: plain.head.version + 1 }
      }
    });
    expect(write.status).toBe(409);
    // The plaintext artifacts are gone.
    expect(
      (await srv.call('GET', `/api/artifacts/${plain.stepArtifactId}/download`))
        .status
    ).not.toBe(200);

    // D1, R2 and the room hold no plaintext.
    const stored = everythingStored(srv);
    for (const secret of SECRETS) expect(stored, secret).not.toContain(secret);
    const room = srv.storage.get(projectId)!;
    expect(
      [...room.keys()].filter(
        (key) => key === 'room:latest' || key.startsWith('room:history:')
      )
    ).toEqual([]);

    // A fresh browser opens it with its history intact.
    await expectOpensWithHistory(srv, plain);
  });

  it('marks a project cut over whose purge stopped, and resumes the purge after', async () => {
    const srv = roomServer();
    const plain = await plaintextProject(srv, { revisions: 1 });
    const projectId = plain.head.projectId;
    // The room cannot be cleared once: the purge stops after the cutover.
    let purgeFails = true;
    srv.roomFault = async (request, room) => {
      const { action } = (await request.clone().json()) as { action: string };
      if (action === 'purge' && purgeFails) {
        purgeFails = false;
        return new Response('Overloaded.', { status: 500 });
      }
      return room.fetch(request);
    };
    const laptop = engineOn(srv, owner, 'owner_laptop');
    expect(await codeOfCall(migrateFully(laptop, projectId))).toBe(
      'PROJECT_ROOM_UNAVAILABLE'
    );
    expect(formatOf(srv, projectId)).toBe(2);
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'purging' });
    expect(laptop.progress.at(-1)).toMatchObject({
      phase: 'error',
      cutOver: true,
      error: { code: 'PROJECT_ROOM_UNAVAILABLE', retryable: true }
    });
    // Retried with the listing's (now encrypted) summary: the purge
    // resumes and finishes.
    const summary = await laptop.summary(projectId);
    expect(summary.storageFormat).toBe(2);
    await laptop.engine.migrate(summary);
    expect(laptop.progress.at(-1)).toMatchObject({
      phase: 'done',
      cutOver: true
    });
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'done' });
  });

  it('refuses a shared project and leaves it as it was', async () => {
    const srv = roomServer();
    const plain = await plaintextProject(srv, { revisions: 1 });
    const projectId = plain.head.projectId;
    srv.db
      .prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, added_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'editor', ?, 1, 1)`
      )
      .run(projectId, OTHER, OWNER);
    const laptop = engineOn(srv, owner, 'owner_laptop');
    expect(await codeOfCall(migrateFully(laptop, projectId))).toBe(
      E2EE_MIGRATION_CODES.shared
    );
    expect(laptop.progress.at(-1)).toMatchObject({
      phase: 'error',
      error: { code: E2EE_MIGRATION_CODES.shared, retryable: false }
    });
    expect(migrationRow(srv, projectId)).toBeUndefined();
    expect(count(srv, 'e2ee_project_versions', projectId)).toBe(0);
    expect(formatOf(srv, projectId)).toBe(1);
    expect((await srv.call('GET', `/api/projects/${projectId}`)).status).toBe(
      200
    );
  });

  it('refuses while the room holds edits the account never saved', async () => {
    const srv = roomServer();
    const plain = await plaintextProject(srv, { revisions: 1 });
    const projectId = plain.head.projectId;
    srv.roomSeed.set(projectId, {
      ...plain.head,
      version: plain.head.version + 2
    });
    const laptop = engineOn(srv, owner, 'owner_laptop');
    expect(await codeOfCall(migrateFully(laptop, projectId))).toBe(
      E2EE_MIGRATION_CODES.roomAhead
    );
    expect(laptop.flushed).toEqual([projectId]);
    expect(laptop.progress.at(-1)?.error).toMatchObject({ retryable: true });
    // Nothing was staged, and the plaintext is writable again.
    expect(migrationRow(srv, projectId)).toMatchObject({
      state: 'abandoned',
      lease_id: null,
      staged_version: 0
    });
    expect(count(srv, 'e2ee_project_groups', projectId)).toBe(0);
    await autosave(srv, plain.head);
    // The room's edits are untouched.
    expect(
      (srv.storage.get(projectId)!.get('room:latest') as ProjectDocument)
        .version
    ).toBe(plain.head.version + 2);
  });

  it('fails closed, staging nothing, while the room cannot confirm what it holds', async () => {
    const faults: [string, (request: Request) => Promise<Response>][] = [
      [
        'unreachable',
        async () => {
          throw new Error('The room is unreachable.');
        }
      ],
      ['failing', async () => new Response('Overloaded.', { status: 500 })],
      ['unreadable', async () => new Response('not json', { status: 200 })]
    ];
    const srv = roomServer();
    const plain = await plaintextProject(srv, { revisions: 1 });
    const projectId = plain.head.projectId;
    // The room holds an edit the account never saved: had the start gone
    // on, the purge would have deleted it.
    srv.roomSeed.set(projectId, {
      ...plain.head,
      version: plain.head.version + 1
    });
    const laptop = engineOn(srv, owner, 'owner_laptop');
    for (const [label, fault] of faults) {
      srv.roomFault = fault;
      const error = await laptop.engine
        .migrate(await laptop.summary(projectId))
        .catch((caught: unknown) => caught);
      expect((error as { code?: string }).code, label).toBe(
        'PROJECT_ROOM_UNAVAILABLE'
      );
      expect(laptop.progress.at(-1), label).toMatchObject({
        phase: 'error',
        error: {
          code: 'PROJECT_ROOM_UNAVAILABLE',
          retryable: true
        }
      });
      expect(laptop.progress.at(-1)?.error?.message, label).toContain(
        'nothing changed'
      );
      // Nothing locked: the project stays editable.
      expect(laptop.progress.at(-1)?.plaintextLocked, label).toBeFalsy();
      // Nothing was staged, and the plaintext is not locked.
      expect(migrationRow(srv, projectId), label).toMatchObject({
        state: 'abandoned',
        lease_id: null,
        staged_version: 0
      });
      expect(count(srv, 'e2ee_project_groups', projectId), label).toBe(0);
      expect(formatOf(srv, projectId), label).toBe(1);
    }
    // Reachable again, it answers the edit it holds: still nothing staged.
    srv.roomFault = null;
    expect(await codeOfCall(migrateFully(laptop, projectId))).toBe(
      E2EE_MIGRATION_CODES.roomAhead
    );
    expect(
      (srv.storage.get(projectId)!.get('room:latest') as ProjectDocument)
        .version
    ).toBe(plain.head.version + 1);
  });
});

// --- Resuming --------------------------------------------------------------------

describe('resuming', () => {
  it('resumes after an interruption mid-staging from the staged journal', async () => {
    const srv = roomServer();
    const plain = await plaintextProject(srv);
    const projectId = plain.head.projectId;
    const leases = memoryLeaseStore();
    let revisionSteps = 0;
    const first = engineOn(srv, owner, 'owner_laptop', {
      leases,
      beforeStep: (step) => {
        // The tab dies before its third save state.
        if (step === 'revision' && ++revisionSteps === 3) {
          throw new Error('The tab was closed.');
        }
      }
    });
    await expect(migrateFully(first, projectId)).rejects.toThrow(
      'The tab was closed.'
    );
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'staging' });
    // Stopped mid-staging, its plaintext stays locked: still read-only.
    expect(first.progress.at(-1)).toMatchObject({
      phase: 'error',
      plaintextLocked: true
    });
    expect(count(srv, 'e2ee_project_revisions', projectId)).toBe(2);
    const blobsBefore = count(srv, 'e2ee_content_blobs', projectId);
    expect(blobsBefore).toBe(1);

    // Reloaded: the same browser storage, a new page and engine. It holds
    // the lease it left (so it resumes at once) and stages only the rest.
    const steps: string[] = [];
    const second = engineOn(srv, owner, 'owner_laptop', {
      from: first.d,
      leases,
      beforeStep: (step) => void steps.push(step)
    });
    await migrateFully(second, projectId);
    expect(steps.filter((step) => step === 'revision')).toHaveLength(1);
    expect(steps).toContain('journal');
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'done' });
    expect(count(srv, 'e2ee_project_revisions', projectId)).toBe(3);
    // The STEP was found by its dedupe tag, not stored again.
    expect(
      rows(
        srv,
        "SELECT blob_id FROM e2ee_content_blobs WHERE project_id = ? AND kind = 'import-source'",
        projectId
      )
    ).toHaveLength(1);
    expect(second.progress.at(-1)).toMatchObject({
      phase: 'done',
      revisionsDone: 3
    });
    await expectOpensWithHistory(srv, plain);
  });

  it('pauses after the step in flight and resumes later', async () => {
    const srv = roomServer();
    const plain = await plaintextProject(srv, { revisions: 2 });
    const projectId = plain.head.projectId;
    const pause = new AbortController();
    const laptop = engineOn(srv, owner, 'owner_laptop', {
      beforeStep: (step) => {
        if (step === 'head') pause.abort();
      }
    });
    await expect(
      laptop.engine.migrate(await laptop.summary(projectId), pause.signal)
    ).rejects.toBeInstanceOf(MigrationPausedError);
    expect(laptop.progress.at(-1)?.phase).toBe('paused');
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'staging' });
    // Paused, the plaintext stays locked and readable.
    expect((await srv.call('GET', `/api/projects/${projectId}`)).status).toBe(
      200
    );
    await migrateFully(laptop, projectId);
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'done' });
  });

  it('pauses while the first version stores its files, after its group landed', async () => {
    const srv = roomServer();
    const plain = await plaintextProject(srv, { revisions: 2 });
    const projectId = plain.head.projectId;
    const pause = new AbortController();
    const laptop = engineOn(srv, owner, 'owner_laptop', {
      beforeStep: (step) => {
        if (step === 'file' && !pause.signal.aborted) pause.abort();
      }
    });
    // The pause reaches the engine as itself, not as a failed creation:
    // the staged group is on the server, the version is not.
    await expect(
      laptop.engine.migrate(await laptop.summary(projectId), pause.signal)
    ).rejects.toBeInstanceOf(MigrationPausedError);
    expect(laptop.progress.at(-1)?.phase).toBe('paused');
    expect(count(srv, 'e2ee_project_groups', projectId)).toBe(1);
    expect(count(srv, 'e2ee_project_versions', projectId)).toBe(0);
    // Resumed, the group without a version is dropped and staged again.
    await migrateFully(laptop, projectId);
    expect(migrationRow(srv, projectId)).toMatchObject({ state: 'done' });
    await expectOpensWithHistory(srv, plain);
  });

  it('stops when another tab took the lease, which then finishes', async () => {
    const srv = roomServer();
    const plain = await plaintextProject(srv, { revisions: 2 });
    const projectId = plain.head.projectId;
    let desktop: EngineDevice | null = null;
    const takeover: { done?: Promise<void> } = {};
    const laptop = engineOn(srv, owner, 'owner_laptop', {
      beforeStep: async (step) => {
        if (step === 'head' && !desktop) {
          // The laptop's lease lapses (it slept); the desktop's tab
          // starts and takes the staging over as it stands.
          srv.db
            .prepare('UPDATE e2ee_project_migrations SET lease_expires_at = 1')
            .run();
          desktop = engineOn(srv, owner, 'owner_desktop', {
            beforeStep: (next) =>
              // The desktop holds on until the laptop has given up.
              next === 'cutover' ? laptopDone : undefined
          });
          takeover.done = migrateFully(desktop, projectId);
          // Let the desktop take the lease before the laptop writes on.
          await vi.waitFor(() =>
            expect(migrationRow(srv, projectId)).toMatchObject({
              device_id: 'owner_desktop'
            })
          );
        }
      }
    });
    let releaseLaptop!: () => void;
    const laptopDone = new Promise<void>((resolve) => {
      releaseLaptop = resolve;
    });
    const refused = await codeOfCall(migrateFully(laptop, projectId));
    releaseLaptop();
    // Its write met E2EE_MIGRATION_LEASE_LOST; starting again to resume
    // met the desktop's live lease.
    expect(refused).toBe(E2EE_MIGRATION_CODES.leased);
    expect(laptop.progress.at(-1)?.error).toMatchObject({
      code: E2EE_MIGRATION_CODES.leased,
      retryable: true
    });
    await takeover.done;
    expect(migrationRow(srv, projectId)).toMatchObject({
      state: 'done',
      device_id: 'owner_desktop'
    });
    await expectOpensWithHistory(srv, plain, owner, 'owner_laptop');
  });

  it('abandons and starts over when the plaintext moved under the staging', async () => {
    const srv = roomServer();
    const plain = await plaintextProject(srv, { revisions: 1 });
    const projectId = plain.head.projectId;
    let raced = false;
    const laptop = engineOn(srv, owner, 'owner_laptop', {
      beforeStep: (step) => {
        if (step === 'cutover' && !raced) {
          raced = true;
          // A measurements write that raced the start: the cutover
          // refuses it as stale.
          srv.db
            .prepare(
              `UPDATE project_measurements SET revision = revision + 1,
                 payload_json = ? WHERE project_id = ?`
            )
            .run(
              JSON.stringify(measurementRecord(projectId, 'Secret gauge')),
              projectId
            );
        }
      }
    });
    await migrateFully(laptop, projectId);
    expect(raced).toBe(true);
    // Started over: the migration began again from the moved plaintext.
    expect(migrationRow(srv, projectId)).toMatchObject({
      state: 'done',
      source_measurement_revision: 2
    });
    const phases = laptop.progress.map((p) => p.phase);
    expect(phases.filter((phase) => phase === 'cutover')).toHaveLength(2);
    expect(count(srv, 'e2ee_project_revisions', projectId)).toBe(1);
    await expectOpensWithHistory(srv, plain);
  });

  it('starts over when a device that staged part of it was removed', async () => {
    const account = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
    const srv = roomServer([account, other]);
    const plain = await plaintextProject(srv, { revisions: 2 });
    const projectId = plain.head.projectId;
    let steps = 0;
    const laptop = engineOn(srv, account, 'owner_laptop', {
      beforeStep: (step) => {
        if (step === 'revision' && ++steps === 2) {
          throw new Error('The laptop went offline.');
        }
      }
    });
    await expect(migrateFully(laptop, projectId)).rejects.toThrow('offline');
    expect(
      rows(
        srv,
        'SELECT DISTINCT signer_device_id FROM e2ee_project_versions WHERE project_id = ?',
        projectId
      )
    ).toEqual([{ signer_device_id: 'owner_laptop' }]);
    // The laptop is removed from the account; its lease lapses.
    await account.revoke(srv.db, 'owner_laptop');
    srv.db
      .prepare('UPDATE e2ee_project_migrations SET lease_expires_at = 1')
      .run();
    const desktop = engineOn(srv, account, 'owner_desktop');
    await migrateFully(desktop, projectId);
    expect(migrationRow(srv, projectId)).toMatchObject({
      state: 'done',
      device_id: 'owner_desktop'
    });
    // Nothing the removed laptop staged survived the restart.
    expect(
      rows(
        srv,
        'SELECT DISTINCT signer_device_id FROM e2ee_project_versions WHERE project_id = ?',
        projectId
      )
    ).toEqual([{ signer_device_id: 'owner_desktop' }]);
    await expectOpensWithHistory(srv, plain, account, 'owner_desktop');
  });
});

// --- Helpers ------------------------------------------------------------------------

describe('engine helpers', () => {
  it('moves every artifact a document names to its blob id, and nothing else', () => {
    const document = withImport(initialDocument('Bracket'), 'artifact_a', STEP);
    const derived = { ...document.derived, artifactId: 'artifact_a' };
    const moved = withBlobIds(
      { ...document, derived },
      new Map([['artifact_a', 'b'.repeat(32)]])
    );
    const { derived: kept, ...content } = moved;
    expect(JSON.stringify(content)).not.toContain('"artifactId":"artifact_a"');
    expect(JSON.stringify(content)).toContain(
      `"artifactId":"${'b'.repeat(32)}"`
    );
    // The derived projection is not rewritten (nor stored).
    expect(kept).toBe(derived);
    // The source document is untouched.
    expect(JSON.stringify(document)).toContain('"artifactId":"artifact_a"');
  });

  it('lists live plaintext projects, oldest first', () => {
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
        ...extra
      }) as ProjectSummary;
    expect(
      migratableProjects([
        summary('proj_new', '2026-10-03T00:00:00.000Z'),
        summary('proj_old', '2026-10-01T00:00:00.000Z'),
        summary('proj_encrypted', '2026-09-01T00:00:00.000Z', {
          storageFormat: 2
        }),
        summary('proj_trashed', '2026-09-01T00:00:00.000Z', {
          organization: { status: 'deleted', pinned: false, sortOrder: 0 }
        })
      ]).map((p) => p.projectId)
    ).toEqual(['proj_old', 'proj_new']);
  });

  it('says plainly what went wrong and whether a retry helps', () => {
    expect(
      migrationErrorOf({ code: E2EE_MIGRATION_CODES.leased, status: 409 })
    ).toMatchObject({ retryable: true });
    expect(
      migrationErrorOf({ code: E2EE_MIGRATION_CODES.shared, status: 409 })
    ).toMatchObject({ retryable: false });
    expect(migrationErrorOf(new Error('offline'))).toEqual({
      retryable: true,
      message: 'offline'
    });
  });
});

// --- The store: a named-save head read back --------------------------------------

describe('a named save read back as the head', () => {
  it('keeps the save state in the signed history of the next version', async () => {
    const srv = newServer([owner, other]);
    const laptop = device(srv, owner, 'owner_laptop');
    const created = await laptop.store.createProject({
      name: 'Bracket',
      initialDocument: initialDocument('Bracket')
    });
    const named = await laptop.store.saveRevision({
      projectId: created.document.projectId,
      reason: 'Before the change',
      expectedVersion: created.document.version,
      document: created.document
    });
    const revisionId = named.revisions.at(-1)!.revisionId as string;
    // Reloaded: the head is the named save, whose own body cannot map it.
    const reloaded = device(srv, owner, 'owner_laptop', {
      mls: laptop.mls,
      pins: laptop.pins
    });
    const head = await reloaded.store.loadProject(named.projectId);
    expect(
      (await reloaded.store.revisionMap(named.projectId)).has(revisionId)
    ).toBe(true);
    await reloaded.store.saveProjectDocument({
      projectId: named.projectId,
      expectedVersion: head.version,
      document: { ...head, version: head.version + 1 }
    });
    // A fresh browser still finds the save state in the signed history.
    const fresh = device(srv, owner, 'owner_desktop');
    await fresh.store.loadProject(named.projectId);
    expect(
      (await fresh.store.loadRevision(named.projectId, revisionId))?.version
    ).toBe(named.version);
  });
});
