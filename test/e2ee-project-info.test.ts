/**
 * Names, thumbnails, archived exports, measurements and view state of
 * encrypted projects (ADR-024 Phase 4, slice 4-7): Node devices of one
 * owner run the real client modules (`encryptedProjectInfo.ts`,
 * `replacedEnvelopes.ts`, `encryptedProjectStore.ts`,
 * `encryptedContentBlobs.ts`) with the in-process MLS engine against the
 * real Worker over SQLite, with every migration applied unless a case says
 * otherwise. Also the re-upload of a blob the account lost (4-6's gap).
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  encodeMeasurementsBody,
  encodeProjectInfoBody,
  fromBase64Url,
  parseEnvelope,
  toHex,
  versionHash
} from '@openzcad/crypto';
import { UnstorableDocumentError } from '@openzcad/document-core';
import {
  E2EE_UNREFERENCED_BLOB_GRACE_MS,
  parseWorkspaceResumeState,
  type E2eeProjectEnvelopeRecord,
  type ProjectDocument,
  type ProjectWorkspaceSession
} from '@openzcad/shared';
import { ApiError } from '../apps/web/src/lib/api';
import type { StoredMeasurementRecord } from '../apps/web/src/lib/measurementRecord';
import { syncProjectMeasurements } from '../apps/web/src/lib/measurementCloudSync';
import {
  ProjectInfoRollbackError,
  archiveExport,
  exportArtifacts,
  publishThumbnail
} from '../apps/web/src/lib/e2ee/encryptedProjectInfo';
import { ReplacedEnvelopeRollbackError } from '../apps/web/src/lib/e2ee/replacedEnvelopes';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  collectContentBlobs,
  type E2eeBlobBucket
} from '../apps/web/worker/e2eeContentBlobs';
import {
  OTHER,
  OWNER,
  createEncrypted,
  databaseBefore,
  device,
  edited,
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

const server = () => newServer([owner, other]);
const text = (value: string) => new TextEncoder().encode(value);
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

async function encryptedProject(name = 'Bracket') {
  const srv = server();
  const laptop = device(srv, owner, 'owner_laptop');
  const { document } = await createEncrypted(laptop, name);
  return { srv, laptop, projectId: document.projectId, document };
}

async function save(d: Device, document: ProjectDocument, expected: number) {
  await d.store.saveProjectDocument({
    projectId: document.projectId,
    expectedVersion: expected,
    document
  });
  return document;
}

function infoRow(srv: Server, projectId: string) {
  return rows<{
    sequence: number;
    key_epoch: number;
    envelope: string;
    wrapped_version_key: string;
    signature: string;
    signer_device_id: string;
    updated_at: string;
  }>(
    srv,
    `SELECT sequence, key_epoch, envelope, wrapped_version_key, signature,
            signer_device_id, updated_at
     FROM e2ee_project_envelopes
     WHERE project_id = ? AND kind = 'project-info' AND scope = ''`,
    projectId
  )[0]!;
}

/** Puts back an envelope row as it was: what a replaying account does. */
function replaceEnvelopeRow(
  srv: Server,
  projectId: string,
  kind: string,
  row: ReturnType<typeof infoRow>,
  scope = ''
) {
  srv.db
    .prepare(
      'DELETE FROM e2ee_project_envelopes WHERE project_id = ? AND kind = ? AND scope = ?'
    )
    .run(projectId, kind, scope);
  srv.db
    .prepare(
      `INSERT INTO e2ee_project_envelopes
         (project_id, kind, scope, sequence, key_epoch, envelope,
          wrapped_version_key, signature, signer_device_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      projectId,
      kind,
      scope,
      row.sequence,
      row.key_epoch,
      row.envelope,
      row.wrapped_version_key,
      row.signature,
      row.signer_device_id,
      row.updated_at
    );
}

function recordOf(
  projectId: string,
  row: ReturnType<typeof infoRow>
): E2eeProjectEnvelopeRecord {
  return {
    projectId,
    kind: 'project-info',
    keyEpoch: row.key_epoch,
    sequence: row.sequence,
    envelope: row.envelope,
    wrappedVersionKey: row.wrapped_version_key,
    signature: row.signature,
    signerDeviceId: row.signer_device_id,
    updatedAt: row.updated_at
  };
}

const hashOf = async (envelope: string) =>
  toHex(await versionHash(fromBase64Url(envelope)));

async function refusedWith(
  promise: Promise<unknown>,
  status: number,
  code?: string
) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === status &&
      (code === undefined || error.code === code)
  );
}

function everythingStored(srv: Server): string {
  const tables = rows<{ name: string }>(
    srv,
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).map((row) => row.name);
  const database = tables
    .map((table) => JSON.stringify(rows(srv, `SELECT * FROM "${table}"`)))
    .join('\n');
  const objects = [...srv.bucket.objects.values()]
    .map((body) => Buffer.from(body).toString('latin1'))
    .join('\n');
  return `${database}\n${objects}`;
}

/** A WebP-looking picture with a marker the account must never see. */
function picture(marker: string): Uint8Array<ArrayBuffer> {
  return text(
    `RIFF\u0000\u0000\u0000\u0000WEBPVP8 ${marker}${'x'.repeat(200)}`
  );
}

// --- Project info ---------------------------------------------------------------

describe('project info', () => {
  it('chains each project info on the one it replaces and refuses a rollback', async () => {
    const { srv, laptop, projectId, document } =
      await encryptedProject('First');
    const first = infoRow(srv, projectId);
    expect(first.sequence).toBe(1);
    expect(parseEnvelope(fromBase64Url(first.envelope)).header).toMatchObject({
      documentVersion: 1,
      previousVersionHash: null
    });
    const v2 = await save(laptop, edited(document, 'Second'), document.version);
    const second = infoRow(srv, projectId);
    expect(second.sequence).toBe(2);
    const header = parseEnvelope(fromBase64Url(second.envelope)).header;
    if (header.class !== 'project') throw new Error('not a project envelope');
    expect(header.documentVersion).toBe(2);
    expect(toHex(header.previousVersionHash!)).toBe(
      await hashOf(first.envelope)
    );
    await save(laptop, edited(v2, 'Third'), v2.version);
    expect((await laptop.store.info.read(projectId)).body?.name).toBe('Third');
    expect(await laptop.pins.read(OWNER, projectId)).toMatchObject({
      infoSequence: 3,
      infoHash: await hashOf(infoRow(srv, projectId).envelope)
    });

    // The account replays the second one: refused, never shown or built on.
    replaceEnvelopeRow(srv, projectId, 'project-info', second);
    await expect(laptop.store.info.read(projectId)).rejects.toBeInstanceOf(
      ProjectInfoRollbackError
    );
    expect(
      await laptop.store.projectName(recordOf(projectId, second))
    ).toBeNull();
    await expect(
      laptop.store.info.update(projectId, (body) => body && { ...body })
    ).rejects.toBeInstanceOf(ProjectInfoRollbackError);
    // A fresh browser has no pin to hold it to (ADR-024's limit).
    const fresh = device(srv, owner, 'owner_desktop');
    expect((await fresh.store.info.read(projectId)).body?.name).toBe('Second');
  });

  it('refuses another project info at the sequence this browser pinned', async () => {
    const { srv, laptop, projectId } = await encryptedProject('Shared name');
    const base = infoRow(srv, projectId);
    await laptop.store.info.update(projectId, (body) => ({
      ...body!,
      name: 'Laptop name'
    }));
    expect((await laptop.pins.read(OWNER, projectId))?.infoSequence).toBe(2);
    // The account forks: it shows the desktop the first info, so the
    // desktop writes its own second one.
    replaceEnvelopeRow(srv, projectId, 'project-info', base);
    const desktop = device(srv, owner, 'owner_desktop');
    await desktop.store.info.update(projectId, (body) => ({
      ...body!,
      name: 'Desktop name'
    }));
    expect(infoRow(srv, projectId).sequence).toBe(2);
    await expect(laptop.store.info.read(projectId)).rejects.toBeInstanceOf(
      ProjectInfoRollbackError
    );
  });

  it('refuses a project info that does not name the stored one, or its own sequence', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    const put = (body: unknown) =>
      srv.call('PUT', `/api/e2ee/projects/${projectId}/info`, { body });
    const sealed = await laptop.store.replaced.seal(
      projectId,
      {
        kind: 'project-info',
        sequence: 2,
        previousHash: 'ab'.repeat(32),
        blobIds: []
      },
      (header) => encodeProjectInfoBody({ name: 'Forked', exports: [] }, header)
    );
    const upload = {
      sequence: 2,
      envelope: sealed.envelope,
      wrappedVersionKey: sealed.wrappedVersionKey,
      signature: sealed.signature,
      signerDeviceId: sealed.signerDeviceId
    };
    const mismatch = await put(upload);
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ code: 'E2EE_INFO_MISMATCH' });
    // The envelope's own version is the sequence.
    expect((await put({ ...upload, sequence: 3 })).status).toBe(400);
    expect(infoRow(srv, projectId).sequence).toBe(1);
  });

  it('keeps the thumbnail and exports when the name changes', async () => {
    const { laptop, projectId, document } = await encryptedProject();
    const thumbnail = await publishThumbnail(
      laptop.files,
      projectId,
      new Blob([picture('one')], { type: 'image/webp' })
    );
    const exported = await archiveExport(laptop.files, projectId, {
      fileName: 'bracket.step',
      contentType: 'model/step',
      kind: 'step-export',
      body: new Blob([text('ISO-10303-21; export')])
    });
    await save(laptop, edited(document, 'Renamed'), document.version);
    const { body } = await laptop.store.info.read(projectId);
    expect(body).toMatchObject({
      name: 'Renamed',
      thumbnail: { blobId: thumbnail },
      exports: [{ ref: { blobId: exported } }]
    });
  });
});

// --- Thumbnails -------------------------------------------------------------------

describe('thumbnails', () => {
  it('stores a thumbnail as an encrypted blob the project info names, never an artifact', async () => {
    const { srv, laptop, projectId } = await encryptedProject('Secret part');
    const image = picture('SECRET-THUMBNAIL');
    const blobId = await publishThumbnail(
      laptop.files,
      projectId,
      new Blob([image], { type: 'image/webp' })
    );
    expect(
      rows(
        srv,
        'SELECT blob_id, kind, state FROM e2ee_content_blobs WHERE project_id = ?',
        projectId
      )
    ).toEqual([{ blob_id: blobId, kind: 'thumbnail', state: 'committed' }]);
    expect(rows(srv, 'SELECT * FROM artifacts')).toEqual([]);
    expect(rows(srv, 'SELECT * FROM upload_sessions')).toEqual([]);
    const info = infoRow(srv, projectId);
    expect(parseEnvelope(fromBase64Url(info.envelope)).header).toMatchObject({
      documentVersion: 2,
      blobIds: [blobId]
    });
    // The plaintext upload route refuses the project outright.
    const plaintext = await srv.call('POST', '/api/uploads', {
      body: {
        projectId,
        fileName: 'thumb.webp',
        contentType: 'image/webp',
        kind: 'thumbnail'
      }
    });
    expect(plaintext.status).toBe(409);
    expect(rows(srv, 'SELECT * FROM artifacts')).toEqual([]);
    const stored = everythingStored(srv);
    expect(stored).not.toContain('SECRET-THUMBNAIL');
    expect(stored).not.toContain('Secret part');

    // The shelf of a fresh page names the project and shows its picture.
    const desktop = device(srv, owner, 'owner_desktop');
    const listed = (await (await srv.call('GET', '/api/projects')).json()) as {
      encryptedProjectInfo: E2eeProjectEnvelopeRecord[];
    };
    const record = listed.encryptedProjectInfo.find(
      (entry) => entry.projectId === projectId
    )!;
    const body = await desktop.store.info.verify(record);
    expect(body).toMatchObject({
      name: 'Secret part',
      thumbnail: { blobId, kind: 'thumbnail' }
    });
    expect(await desktop.blobs.read(projectId, blobId)).toEqual(image);
  });

  it('collects a replaced thumbnail and keeps what the project info names', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    const old = await publishThumbnail(
      laptop.files,
      projectId,
      new Blob([picture('old')], { type: 'image/webp' })
    );
    const exported = await archiveExport(laptop.files, projectId, {
      fileName: 'kept.stl',
      contentType: 'model/stl',
      kind: 'stl-export',
      body: new Blob([text('solid kept')])
    });
    const current = await publishThumbnail(
      laptop.files,
      projectId,
      new Blob([picture('new')], { type: 'image/webp' })
    );
    expect(
      parseEnvelope(fromBase64Url(infoRow(srv, projectId).envelope)).header
    ).toMatchObject({ blobIds: [current, exported] });
    await collectContentBlobs(
      srv.env.DB as D1Database,
      srv.bucket as unknown as E2eeBlobBucket,
      projectId,
      Date.now() + E2EE_UNREFERENCED_BLOB_GRACE_MS + 60_000
    );
    const left = rows<{ blob_id: string }>(
      srv,
      'SELECT blob_id FROM e2ee_content_blobs WHERE project_id = ? ORDER BY blob_id',
      projectId
    ).map((row) => row.blob_id);
    expect(left).toEqual([current, exported].sort());
    expect(left).not.toContain(old);
  });
});

// --- Archived exports ---------------------------------------------------------------

describe('archived exports', () => {
  it('round-trips an export through the project info to a fresh page', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    const step = text(
      `ISO-10303-21;\nFILE_NAME('secret-export');\n${'DATA;\n'.repeat(50)}`
    );
    const blobId = await archiveExport(laptop.files, projectId, {
      fileName: 'secret-export.step',
      contentType: 'model/step',
      kind: 'step-export',
      body: new Blob([step]),
      metadata: { bodyIds: 'body_1', documentVersion: 2, units: 'mm' }
    });
    expect(
      rows(srv, 'SELECT kind FROM e2ee_content_blobs WHERE blob_id = ?', blobId)
    ).toEqual([{ kind: 'export' }]);
    expect(rows(srv, 'SELECT * FROM artifacts')).toEqual([]);
    const stored = everythingStored(srv);
    expect(stored).not.toContain('secret-export');
    expect(stored).not.toContain('ISO-10303-21');

    const desktop = device(srv, owner, 'owner_desktop');
    const listed = exportArtifacts(
      projectId,
      (await desktop.store.info.read(projectId)).body
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      artifactId: blobId,
      projectId,
      kind: 'step-export',
      name: 'secret-export.step',
      contentType: 'model/step',
      bytes: step.byteLength,
      metadata: {
        bodyIds: 'body_1',
        documentVersion: 2,
        units: 'mm',
        artifactKind: 'step-export'
      }
    });
    expect(await desktop.blobs.read(projectId, blobId)).toEqual(step);

    // A second export lists first.
    const second = await archiveExport(laptop.files, projectId, {
      fileName: 'second.stl',
      contentType: 'model/stl',
      kind: 'stl-export',
      body: new Blob([text('solid second')])
    });
    expect(
      exportArtifacts(
        projectId,
        (await laptop.store.info.read(projectId)).body
      ).map((artifact) => artifact.artifactId)
    ).toEqual([second, blobId]);
  });

  it('refuses an export blob of another kind in the project info', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    const source = await laptop.blobs.archive(projectId, {
      fileName: 'source.step',
      contentType: 'model/step',
      kind: 'step-import',
      body: new Blob([text('ISO-10303-21; source')])
    });
    const held = laptop.references.get(projectId, source)!;
    // An import source passed off as an export: the body codec refuses it
    // in the browser, and the Worker refuses the header's blob kind.
    await expect(
      laptop.store.info.update(projectId, (body) => ({
        ...body!,
        exports: [
          {
            ref: { ...held.reference, kind: 'export' },
            fileName: 'x.step',
            contentType: 'model/step',
            metadata: {}
          }
        ]
      }))
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ApiError && error.status === 400
    );
    expect(infoRow(srv, projectId).sequence).toBe(1);
  });
});

// --- Measurements -------------------------------------------------------------------

function measurements(
  projectId: string,
  updatedAt: string,
  label: string
): StoredMeasurementRecord {
  return {
    projectId,
    version: 1,
    updatedAt,
    display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' },
    measurements: [
      {
        id: 'body:one',
        kind: 'body',
        label,
        targets: [
          {
            bodyId: 'body_one',
            bodyName: 'One',
            kind: 'body',
            label: 'One',
            semantic: 'body-center',
            quality: 'exact-kernel',
            point: { x: 0, y: 0, z: 0 }
          }
        ],
        result: { value: 10, dimension: 'volume' },
        quality: 'tessellated',
        status: 'current',
        sourceRevision: 1,
        sourceUnit: 'mm',
        visible: true
      }
    ]
  } as unknown as StoredMeasurementRecord;
}

describe('measurements', () => {
  it('saves measurements encrypted, fences on the plaintext revision and reconciles a conflict', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    const desktop = device(srv, owner, 'owner_desktop');
    const first = measurements(
      projectId,
      '2026-10-24T01:00:00.000Z',
      'Secret gauge'
    );
    expect(
      await laptop.measurements.saveProjectMeasurements({
        projectId,
        expectedRevision: 0,
        record: first
      })
    ).toEqual({ revision: 1, record: first });
    expect(
      await desktop.measurements.loadProjectMeasurements(projectId)
    ).toEqual({
      revision: 1,
      record: first
    });
    expect(everythingStored(srv)).not.toContain('Secret gauge');
    const laptopEdit = measurements(
      projectId,
      '2026-10-24T02:00:00.000Z',
      'Laptop gauge'
    );
    await laptop.measurements.saveProjectMeasurements({
      projectId,
      expectedRevision: 1,
      record: laptopEdit
    });
    // The desktop still builds on revision 1: a conflict, as in plaintext.
    const desktopEdit = measurements(
      projectId,
      '2026-10-24T03:00:00.000Z',
      'Desktop gauge'
    );
    await refusedWith(
      desktop.measurements.saveProjectMeasurements({
        projectId,
        expectedRevision: 1,
        record: desktopEdit
      }),
      409,
      'MEASUREMENT_REVISION_CONFLICT'
    );
    // The sync loop reads again and the newer edit wins.
    expect(
      await syncProjectMeasurements(
        desktop.measurements,
        projectId,
        desktopEdit
      )
    ).toEqual({ revision: 3, record: desktopEdit, source: 'local' });
    expect(
      await syncProjectMeasurements(laptop.measurements, projectId, laptopEdit)
    ).toEqual({ revision: 3, record: desktopEdit, source: 'cloud' });
    // The Worker fences on its own as well: a signed envelope on top of an
    // older revision, sent past the browser's own checks.
    const sealed = await laptop.store.replaced.seal(
      projectId,
      { kind: 'measurements', sequence: 2, previousHash: null, blobIds: [] },
      (header) => encodeMeasurementsBody({ record: { projectId } }, header)
    );
    const stale = await srv.call(
      'PUT',
      `/api/e2ee/projects/${projectId}/measurements`,
      {
        body: {
          expectedRevision: 1,
          envelope: sealed.envelope,
          wrappedVersionKey: sealed.wrappedVersionKey,
          signature: sealed.signature,
          signerDeviceId: sealed.signerDeviceId
        }
      }
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: 'MEASUREMENT_REVISION_CONFLICT',
      currentRevision: 3
    });
    // The plaintext route keeps refusing the project.
    expect(
      (await srv.call('GET', `/api/projects/${projectId}/measurements`)).status
    ).toBe(409);
  });

  it('refuses measurements whose signer’s device list changed while they were written', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    const push = srv.statements.push.bind(srv.statements);
    srv.statements.push = (...sql: string[]) => {
      if (
        sql.some(
          (s) =>
            s.includes('INSERT INTO e2ee_project_envelopes') &&
            s.includes('excluded.sequence')
        )
      ) {
        srv.statements.push = push;
        srv.db
          .prepare(
            `INSERT INTO e2ee_device_list_entries
             SELECT user_id, generation, sequence + 1, entry, signature,
                    substr(entry_hash, 2) || '0', created_at
             FROM e2ee_device_list_entries WHERE user_id = ?
             ORDER BY sequence DESC LIMIT 1`
          )
          .run(owner.userId);
      }
      return push(...sql);
    };
    await expect(
      laptop.measurements.saveProjectMeasurements({
        projectId,
        expectedRevision: 0,
        record: measurements(projectId, '2026-10-24T01:00:00.000Z', 'one')
      })
    ).rejects.toMatchObject({ code: 'E2EE_DEVICE_LIST_CHANGED' });
    expect(
      rows(
        srv,
        `SELECT 1 FROM e2ee_project_envelopes
         WHERE project_id = ? AND kind = 'measurements'`,
        projectId
      )
    ).toEqual([]);
  });

  it('refuses measurements the account rolled back', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    for (const [revision, label] of [
      [0, 'one'],
      [1, 'two']
    ] as const) {
      await laptop.measurements.saveProjectMeasurements({
        projectId,
        expectedRevision: revision,
        record: measurements(
          projectId,
          `2026-10-24T0${revision}:00:00.000Z`,
          label
        )
      });
    }
    const [two] = rows<ReturnType<typeof infoRow>>(
      srv,
      `SELECT sequence, key_epoch, envelope, wrapped_version_key, signature,
              signer_device_id, updated_at
       FROM e2ee_project_envelopes WHERE project_id = ? AND kind = 'measurements'`,
      projectId
    );
    await laptop.measurements.saveProjectMeasurements({
      projectId,
      expectedRevision: 2,
      record: measurements(projectId, '2026-10-24T05:00:00.000Z', 'three')
    });
    replaceEnvelopeRow(srv, projectId, 'measurements', two!);
    await expect(
      laptop.measurements.loadProjectMeasurements(projectId)
    ).rejects.toBeInstanceOf(ReplacedEnvelopeRollbackError);
  });
});

// --- View state -------------------------------------------------------------------

function session(
  projectId: string,
  sessionId: string,
  sequence: number,
  documentVersion: number
): Omit<ProjectWorkspaceSession, 'updatedAt'> {
  return {
    schemaVersion: 1,
    projectId,
    deviceId: 'workspace_laptop',
    sessionId,
    deviceLabel: 'Desktop',
    sequence,
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

describe('view state', () => {
  it('stores a workspace session encrypted and decrypts it on another device', async () => {
    const { srv, laptop, projectId, document } = await encryptedProject();
    const one = session(projectId, 'session_one', 1, document.version);
    await laptop.viewStates.save(one);
    await laptop.viewStates.save({ ...one, sequence: 2 });
    expect(everythingStored(srv)).not.toContain('body_secret_view');
    const desktop = device(srv, owner, 'owner_desktop');
    const loaded = await desktop.viewStates.load(projectId);
    expect(loaded).toEqual([
      { ...one, sequence: 2, updatedAt: expect.any(String) as string }
    ]);
    expect(
      rows(
        srv,
        "SELECT scope, sequence FROM e2ee_project_envelopes WHERE kind = 'view-state'"
      )
    ).toEqual([{ scope: `${OWNER}:session_one`, sequence: 2 }]);
    // A late or repeated save is not an error and changes nothing.
    await laptop.viewStates.save(one);
    // Another device does not continue this session.
    await refusedWith(
      desktop.viewStates.save({ ...one, sequence: 3 }),
      409,
      'E2EE_VIEW_STATE_DEVICE'
    );
    // A view of a version the account has not stored waits for it.
    await refusedWith(
      laptop.viewStates.save(
        session(projectId, 'session_two', 1, document.version + 5)
      ),
      409,
      'E2EE_VIEW_STATE_AHEAD'
    );
    // The plaintext route keeps refusing the project.
    expect(
      (await srv.call('GET', `/api/projects/${projectId}/workspace-sessions`))
        .status
    ).toBe(409);
  });

  it('leaves out a session whose envelope is another one, and keeps the newest 20', async () => {
    const { srv, laptop, projectId, document } = await encryptedProject();
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let index = 0; index < 22; index += 1) {
      vi.setSystemTime(Date.parse('2026-10-24T00:00:00.000Z') + index * 1000);
      await laptop.viewStates.save(
        session(projectId, `session_${index}`, 1, document.version)
      );
    }
    vi.useRealTimers();
    const scopes = rows<{ scope: string }>(
      srv,
      "SELECT scope FROM e2ee_project_envelopes WHERE kind = 'view-state' ORDER BY updated_at"
    ).map((row) => row.scope);
    expect(scopes).toHaveLength(20);
    expect(scopes[0]).toBe(`${OWNER}:session_2`);
    // The account serves session 21's envelope as session 20's.
    const [moved] = rows<ReturnType<typeof infoRow>>(
      srv,
      `SELECT sequence, key_epoch, envelope, wrapped_version_key, signature,
              signer_device_id, updated_at
       FROM e2ee_project_envelopes WHERE scope = ?`,
      `${OWNER}:session_21`
    );
    replaceEnvelopeRow(
      srv,
      projectId,
      'view-state',
      { ...moved!, updated_at: '2026-10-24T00:00:20.000Z' },
      `${OWNER}:session_20`
    );
    const desktop = device(srv, owner, 'owner_desktop');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-25T00:00:00.000Z'));
    const loaded = (await desktop.viewStates.load(projectId)).map(
      (entry) => entry.sessionId
    );
    vi.useRealTimers();
    expect(loaded).toHaveLength(19);
    expect(loaded).not.toContain('session_20');
    expect(loaded).toContain('session_21');
  });
});

// --- Lost blobs -------------------------------------------------------------------

function withImport(
  document: ProjectDocument,
  artifactId: string,
  bytes: Uint8Array
): ProjectDocument {
  const manager = new CommandManager(document);
  manager.execute(
    commandFactories.importStep({
      name: 'Bracket source',
      sourceName: 'secret-bracket.step',
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

/** What garbage collection does to an unreferenced blob after its grace day. */
function collect(srv: Server, projectId: string, blobId: string) {
  srv.db
    .prepare(
      "UPDATE e2ee_content_blobs SET state = 'deleting' WHERE project_id = ? AND blob_id = ?"
    )
    .run(projectId, blobId);
  srv.bucket.objects.delete(`e2ee/${projectId}/${blobId}`);
  srv.db
    .prepare(
      'DELETE FROM e2ee_content_blobs WHERE project_id = ? AND blob_id = ?'
    )
    .run(projectId, blobId);
}

describe('lost blobs', () => {
  const step = text(
    `ISO-10303-21;\nHEADER;\nFILE_NAME('lost');\n${'DATA;\n'.repeat(120)}END-ISO-10303-21;\n`
  );

  it('stores a lost blob again from this device and retries the save once', async () => {
    const srv = server();
    const localSources = new Map<string, Uint8Array>();
    const laptop = device(srv, owner, 'owner_laptop', { localSources });
    const { document } = await createEncrypted(laptop);
    const projectId = document.projectId;
    const blobId = await laptop.blobs.archive(projectId, {
      fileName: 'secret-bracket.step',
      contentType: 'model/step',
      kind: 'step-import',
      body: new Blob([step])
    });
    localSources.set(sha256(step), step);
    const before = laptop.references.get(projectId, blobId)!.reference;
    // The save that would name it was late: the account collected it.
    collect(srv, projectId, blobId);
    const saves: string[] = [];
    laptop.before = async (path, init) => {
      if (path.endsWith('/document') && init.method === 'PUT') saves.push(path);
    };
    const v2 = withImport(document, blobId, step);
    await save(laptop, v2, document.version);
    expect(saves).toHaveLength(2);
    // The same id under a fresh key, and the head names the new reference.
    const after = laptop.references.get(projectId, blobId)!.reference;
    expect(after.blobId).toBe(blobId);
    expect(toHex(after.key)).not.toBe(toHex(before.key));
    expect(rows(srv, 'SELECT blob_id, state FROM e2ee_content_blobs')).toEqual([
      { blob_id: blobId, state: 'committed' }
    ]);
    const desktop = device(srv, owner, 'owner_desktop');
    expect((await desktop.store.loadProject(projectId)).version).toBe(
      v2.version
    );
    expect(await desktop.blobs.read(projectId, blobId)).toEqual(step);
  });

  it('fails as before without the restore, and refuses one without a matching copy', async () => {
    const srv = server();
    const plain = device(srv, owner, 'owner_laptop');
    const { document } = await createEncrypted(plain);
    const projectId = document.projectId;
    const blobId = await plain.blobs.archive(projectId, {
      fileName: 'secret-bracket.step',
      contentType: 'model/step',
      kind: 'step-import',
      body: new Blob([step])
    });
    collect(srv, projectId, blobId);
    await refusedWith(
      save(plain, withImport(document, blobId, step), document.version),
      409,
      'E2EE_BLOB_UNKNOWN'
    );
    // A device whose own copy is gone, or differs, cannot store it again.
    const localSources = new Map<string, Uint8Array>([
      [sha256(step), text('not the same bytes')]
    ]);
    const laptop = device(srv, owner, 'owner_laptop', {
      localSources,
      mls: plain.mls,
      pins: plain.pins
    });
    laptop.references.remember(
      projectId,
      plain.references.get(projectId, blobId)!.reference,
      sha256(step)
    );
    await expect(
      save(laptop, withImport(document, blobId, step), document.version)
    ).rejects.toBeInstanceOf(UnstorableDocumentError);
    expect(rows(srv, 'SELECT * FROM e2ee_content_blobs')).toEqual([]);
  });
});

describe('the new routes', () => {
  it('stay closed behind the flag and before migration 0033', async () => {
    const closed = newServer([owner, other], undefined, {
      E2EE_PROJECTS_ENABLED: 'false'
    });
    expect(
      (await closed.call('GET', '/api/e2ee/projects/proj_x/measurements'))
        .status
    ).toBe(501);
    const early = newServer([owner, other], databaseBefore(33));
    for (const path of ['measurements', 'view-states']) {
      expect(
        (await early.call('GET', `/api/e2ee/projects/proj_x/${path}`)).status
      ).toBe(503);
    }
  });

  it('keep other accounts out', async () => {
    const { srv, projectId } = await encryptedProject();
    for (const path of ['measurements', 'view-states']) {
      expect(
        (
          await srv.call('GET', `/api/e2ee/projects/${projectId}/${path}`, {
            user: OTHER
          })
        ).status
      ).toBe(404);
    }
  });
});
