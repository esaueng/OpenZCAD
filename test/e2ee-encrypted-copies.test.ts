/**
 * Copies, branches, adoption, trash and deletion of encrypted projects
 * (ADR-024 Phase 4, slice 4-8): Node devices of one owner run the real
 * client modules (`cloudProjectCopy.ts`, `encryptedProjectStore.ts`,
 * `encryptedContentBlobs.ts`, `encryptedProjectInfo.ts`) with the
 * in-process MLS engine against the real Worker over SQLite, with every
 * migration applied unless a case says otherwise.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { fromBase64Url, parseEnvelope, toHex } from '@openzcad/crypto';
import {
  adoptProjectDocument,
  reidentifyProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  createId,
  toProjectId,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import { ApiError, rememberProjectFormats } from '../apps/web/src/lib/api';
import type { ArchiveArtifactInput } from '../apps/web/src/lib/archiveArtifact';
import { archiveAccountImportSources } from '../apps/web/src/lib/accountImportSources';
import {
  buildCloudProjectCopy,
  withSourceBlobIds
} from '../apps/web/src/lib/cloudProjectCopy';
import {
  archiveExport,
  publishThumbnail
} from '../apps/web/src/lib/e2ee/encryptedProjectInfo';
import { EncryptedProjectIntegrityError } from '../apps/web/src/lib/e2ee/encryptedProjectStore';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  copyBlobObjects,
  discardCopiedObjects
} from '../apps/web/worker/e2eeProjectCopies';
import {
  OTHER,
  OWNER,
  createEncrypted,
  databaseBefore,
  device,
  edited,
  initialDocument,
  makeAccount,
  newServer,
  objectBucket,
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

function stepBytes(label: string, lines = 200): Uint8Array<ArrayBuffer> {
  return text(
    `ISO-10303-21;\nHEADER;\nFILE_NAME('${label}');\n${'DATA;\n'.repeat(lines)}END-ISO-10303-21;\n`
  );
}

function stepInput(bytes: Uint8Array<ArrayBuffer>): ArchiveArtifactInput {
  return {
    fileName: 'secret-bracket.step',
    contentType: 'model/step',
    kind: 'step-import',
    body: new Blob([bytes])
  };
}

/** The document with one more STEP import naming `artifactId`. */
function withImport(
  document: ProjectDocument,
  artifactId: string,
  bytes: Uint8Array,
  name = 'Bracket source'
): ProjectDocument {
  const manager = new CommandManager(document);
  manager.execute(
    commandFactories.importStep({
      name,
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

async function save(d: Device, document: ProjectDocument, expected: number) {
  const saved = await d.store.saveProjectDocument({
    projectId: document.projectId,
    expectedVersion: expected,
    document
  });
  return { ...document, version: saved.version };
}

/** An encrypted project holding one STEP import as a content blob. */
async function projectWithImport(srv: Server, d: Device, name = 'Bracket') {
  const { document } = await createEncrypted(d, name);
  const projectId = document.projectId;
  const step = stepBytes(`${name}-source`);
  const blobId = await d.blobs.archive(projectId, stepInput(step));
  const head = await save(
    d,
    withImport(document, blobId, step),
    document.version
  );
  rememberProjectFormats([
    { projectId: toProjectId(projectId), storageFormat: 2 }
  ]);
  return { projectId, head, step, blobId };
}

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

/** Every request the device sends, by method and path. */
function recordRequests(d: Device): string[] {
  const sent: string[] = [];
  d.before = async (path, init) => {
    sent.push(`${init.method ?? 'GET'} ${path.split('?')[0]}`);
  };
  return sent;
}

const objectKeys = (srv: Server, projectId: string) =>
  [...srv.bucket.objects.keys()]
    .filter((key) => key.startsWith(`e2ee/${projectId}/`))
    .sort();

const objectBytes = (srv: Server, key: string) =>
  new Uint8Array(srv.bucket.objects.get(key)!);

function blobRows(srv: Server, projectId: string) {
  return rows<{
    blob_id: string;
    kind: string;
    object_key: string;
    ciphertext_bytes: number;
    dedupe_tag: string | null;
  }>(
    srv,
    `SELECT blob_id, kind, object_key, ciphertext_bytes, dedupe_tag
     FROM e2ee_content_blobs WHERE project_id = ? ORDER BY blob_id`,
    projectId
  );
}

const projectIds = (srv: Server) =>
  rows<{ id: string }>(srv, 'SELECT id FROM projects ORDER BY id').map(
    (row) => row.id
  );

const E2EE_TABLES = [
  'e2ee_project_groups',
  'e2ee_mls_commits',
  'e2ee_project_leaves',
  'e2ee_project_keys',
  'e2ee_key_archives',
  'e2ee_project_versions',
  'e2ee_project_revisions',
  'e2ee_project_envelopes',
  'e2ee_content_blobs',
  'e2ee_version_blobs'
] as const;

function e2eeRowsOf(srv: Server, projectId: string): Record<string, number> {
  return Object.fromEntries(
    E2EE_TABLES.map((table) => [
      table,
      (
        srv.db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`)
          .get(projectId) as { n: number }
      ).n
    ])
  );
}

const nothingLeft = Object.fromEntries(E2EE_TABLES.map((t) => [t, 0]));

/** The copy a page builds of `projectId`, as Duplicate builds it. */
async function buildCopy(
  d: Device,
  projectId: string,
  projectName: string,
  saveState?: { revisionId: string; reason: string }
) {
  const request = await buildCloudProjectCopy(
    { projectId, projectName, ...(saveState ? { saveState } : {}) },
    toUserId(OWNER),
    [projectName],
    d.store
  );
  if (!request?.document) throw new Error('No copy was built.');
  return request;
}

// --- Copies --------------------------------------------------------------------

describe('copies', () => {
  it('copies a project’s files byte for byte under the same ids, encrypting nothing again', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { projectId, head, step, blobId } = await projectWithImport(
      srv,
      laptop,
      'Secret bracket'
    );
    const thumbnail = await publishThumbnail(
      laptop.files,
      projectId,
      new Blob(
        [text(`RIFF\u0000\u0000\u0000\u0000WEBPVP8 ${'x'.repeat(200)}`)],
        {
          type: 'image/webp'
        }
      )
    );
    const exported = await archiveExport(laptop.files, projectId, {
      fileName: 'bracket.step',
      contentType: 'model/step',
      kind: 'step-export',
      body: new Blob([text('ISO-10303-21; export')])
    });
    const before = new Map(
      objectKeys(srv, projectId).map((key) => [key, objectBytes(srv, key)])
    );
    const sent = recordRequests(laptop);
    srv.db
      .prepare('UPDATE projects SET sort_order = 7 WHERE id = ?')
      .run(projectId);

    const request = await buildCopy(laptop, projectId, 'Secret bracket');
    // The copy names the source's blob, not a device-local id.
    expect(
      JSON.stringify(withoutDerivedProjection(request.document!))
    ).toContain(blobId);
    const { project, document } = await laptop.store.copyProject({
      sourceProjectId: projectId,
      document: request.document!
    });
    const copyId = document.projectId;
    expect(copyId).not.toBe(projectId);
    expect(project).toMatchObject({
      projectId: copyId,
      name: 'Secret bracket (copy)',
      storageFormat: 2,
      // Next to its source on the shelf, as a plaintext copy lands.
      organization: { status: 'active', sortOrder: 7 }
    });
    // Nothing was encrypted or uploaded again: no upload session, no blob
    // upload, only the create.
    expect(
      sent.filter(
        (line) => /uploads|\/blobs/.test(line) && !line.startsWith('GET')
      )
    ).toEqual([]);
    expect(
      sent.filter((line) => line === 'POST /api/e2ee/projects')
    ).toHaveLength(1);
    expect(rows(srv, 'SELECT * FROM upload_sessions')).toEqual([]);

    // The same ids, kinds and ciphertext; the copy's own keys; no dedupe tag.
    const sourceRows = blobRows(srv, projectId);
    const copyRows = blobRows(srv, copyId);
    expect(copyRows.map((row) => row.blob_id)).toEqual(
      [blobId, thumbnail, exported].sort()
    );
    expect(
      copyRows.map(({ kind, ciphertext_bytes }) => ({ kind, ciphertext_bytes }))
    ).toEqual(
      sourceRows.map(({ kind, ciphertext_bytes }) => ({
        kind,
        ciphertext_bytes
      }))
    );
    for (const row of copyRows) {
      expect(row.object_key).toBe(`e2ee/${copyId}/${row.blob_id}`);
      expect(row.dedupe_tag).toBeNull();
      // Byte for byte the source's object.
      expect(objectBytes(srv, row.object_key)).toEqual(
        before.get(`e2ee/${projectId}/${row.blob_id}`)
      );
    }
    // The source is untouched.
    for (const [key, bytes] of before) {
      expect(objectBytes(srv, key)).toEqual(bytes);
    }
    // The version names the copied import; the info its thumbnail and export.
    expect(
      rows(
        srv,
        'SELECT blob_id FROM e2ee_version_blobs WHERE project_id = ?',
        copyId
      )
    ).toEqual([{ blob_id: blobId }]);
    const info = rows<{ envelope: string }>(
      srv,
      `SELECT envelope FROM e2ee_project_envelopes
       WHERE project_id = ? AND kind = 'project-info'`,
      copyId
    )[0]!;
    const infoHeader = parseEnvelope(fromBase64Url(info.envelope)).header;
    expect(
      infoHeader.class === 'project' && [...infoHeader.blobIds].sort()
    ).toEqual([thumbnail, exported].sort());

    // A fresh browser of another device opens the copy and its file.
    const desktop = device(srv, owner, 'owner_desktop');
    const opened = await desktop.store.loadProject(copyId);
    expect(opened.name).toBe('Secret bracket (copy)');
    expect(JSON.stringify(withoutDerivedProjection(opened))).toContain(blobId);
    expect(await desktop.blobs.read(copyId, blobId)).toEqual(step);
    const { body } = await desktop.store.info.read(copyId);
    expect(body).toMatchObject({
      name: 'Secret bracket (copy)',
      thumbnail: { blobId: thumbnail },
      exports: [{ ref: { blobId: exported } }]
    });
    // It saves on top of its own chain.
    await save(desktop, edited(opened, 'Renamed copy'), opened.version);
    expect(head.version).toBeGreaterThan(0);

    // Purging the source leaves the copy whole.
    expect(
      (await srv.call('DELETE', `/api/projects/${projectId}`)).status
    ).toBe(204);
    expect(objectKeys(srv, projectId)).toEqual([]);
    expect(e2eeRowsOf(srv, projectId)).toEqual(nothingLeft);
    const later = device(srv, owner, 'owner_laptop');
    const reopened = await later.store.loadProject(copyId);
    expect(reopened.name).toBe('Renamed copy');
    expect(await later.blobs.read(copyId, blobId)).toEqual(step);
  });

  it('refuses a copy that lists a file its source does not hold', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const source = await projectWithImport(srv, laptop, 'Source');
    const elsewhere = await projectWithImport(srv, laptop, 'Elsewhere');
    // The page is made to believe the other project's blob is the source's.
    const held = laptop.references.get(elsewhere.projectId, elsewhere.blobId)!;
    laptop.references.remember(
      source.projectId,
      held.reference,
      sha256(elsewhere.step)
    );
    const request = await buildCopy(laptop, source.projectId, 'Source');
    const forged = withImport(
      request.document!,
      elsewhere.blobId,
      elsewhere.step,
      'Foreign source'
    );
    const before = projectIds(srv);
    const keys = [...srv.bucket.objects.keys()].sort();
    await refusedWith(
      laptop.store.copyProject({
        sourceProjectId: source.projectId,
        document: forged
      }),
      409,
      'E2EE_COPY_BLOB_UNKNOWN'
    );
    // Nothing was created or copied.
    expect(projectIds(srv)).toEqual(before);
    expect([...srv.bucket.objects.keys()].sort()).toEqual(keys);

    // Another account's project is no source at all.
    const stranger = device(srv, other, 'other_laptop');
    const { document: theirs } = await createEncrypted(stranger, 'Theirs');
    await refusedWith(
      laptop.store.copyProject({
        sourceProjectId: theirs.projectId,
        document: {
          ...initialDocument('Theirs (copy)'),
          projectId: toProjectId(createId('proj'))
        }
      }),
      404,
      'PROJECT_NOT_FOUND'
    );
    expect(projectIds(srv)).toEqual([...before, theirs.projectId].sort());
  });

  it('removes the copied files when the account refuses the copy (rollback)', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { projectId } = await projectWithImport(srv, laptop);
    const request = await buildCopy(laptop, projectId, 'Bracket');
    // The copy's ciphertext does not fit the owner's artifact storage.
    const used = rows<{ finalized_bytes: number }>(
      srv,
      'SELECT finalized_bytes FROM artifact_account_usage WHERE owner_user_id = ?',
      OWNER
    )[0]!.finalized_bytes;
    srv.db
      .prepare('UPDATE users SET artifact_limit_bytes = ? WHERE id = ?')
      .run(used + 1, OWNER);
    const before = projectIds(srv);
    await refusedWith(
      laptop.store.copyProject({
        sourceProjectId: projectId,
        document: request.document!
      }),
      413,
      'ARTIFACT_QUOTA_EXCEEDED'
    );
    expect(projectIds(srv)).toEqual(before);
    expect(objectKeys(srv, request.document!.projectId)).toEqual([]);
    expect(e2eeRowsOf(srv, request.document!.projectId)).toEqual(nothingLeft);
  });

  it('answers a create whose acknowledgement was lost as created, by its envelope hash', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { projectId, blobId, step } = await projectWithImport(srv, laptop);
    const request = await buildCopy(laptop, projectId, 'Bracket');
    let dropped = 0;
    laptop.answer = async (path, init, response) => {
      if (
        path === '/api/e2ee/projects' &&
        init.method === 'POST' &&
        !dropped++
      ) {
        expect(response.status).toBe(201);
        throw new TypeError('Failed to fetch');
      }
      return response;
    };
    const { document } = await laptop.store.copyProject({
      sourceProjectId: projectId,
      document: request.document!
    });
    expect(dropped).toBe(2);
    expect(
      rows(srv, 'SELECT id FROM projects WHERE id = ?', document.projectId)
    ).toHaveLength(1);
    // The retry kept the files the first request copied.
    expect(objectKeys(srv, document.projectId)).toEqual([
      `e2ee/${document.projectId}/${blobId}`
    ]);
    laptop.answer = undefined;
    const desktop = device(srv, owner, 'owner_desktop');
    await desktop.store.loadProject(document.projectId);
    expect(await desktop.blobs.read(document.projectId, blobId)).toEqual(step);
  });

  it('copies files of any size part by part', async () => {
    const srv = server();
    const bucket = objectBucket();
    const ciphertext = new Uint8Array(2500).map((_, i) => (i * 7) % 251);
    bucket.objects.set('e2ee/proj_a/x', ciphertext.slice().buffer);
    const written: string[] = [];
    await copyBlobObjects(
      bucket as never,
      'proj_b',
      [
        {
          blob_id: 'x',
          kind: 'import-source',
          object_key: 'e2ee/proj_a/x',
          ciphertext_bytes: ciphertext.byteLength
        }
      ],
      written,
      1000
    );
    expect(written).toEqual(['e2ee/proj_b/x']);
    expect(bucket.createMultipartUpload).toHaveBeenCalledOnce();
    expect(new Uint8Array(bucket.objects.get('e2ee/proj_b/x')!)).toEqual(
      ciphertext
    );
    // A short source object fails the copy, and the rollback leaves
    // nothing behind that no row names.
    bucket.objects.set('e2ee/proj_a/y', ciphertext.slice(0, 10).buffer);
    const partial: string[] = [];
    await expect(
      copyBlobObjects(
        bucket as never,
        'proj_c',
        [
          {
            blob_id: 'x',
            kind: 'import-source',
            object_key: 'e2ee/proj_a/x',
            ciphertext_bytes: ciphertext.byteLength
          },
          {
            blob_id: 'y',
            kind: 'import-source',
            object_key: 'e2ee/proj_a/y',
            ciphertext_bytes: 20
          }
        ],
        partial,
        1000
      )
    ).rejects.toMatchObject({ code: 'E2EE_COPY_SOURCE_UNAVAILABLE' });
    expect(partial).toEqual(['e2ee/proj_c/x', 'e2ee/proj_c/y']);
    await discardCopiedObjects(
      srv.env.DB as D1Database,
      bucket as never,
      partial
    );
    expect(
      [...bucket.objects.keys()].filter((key) => key.startsWith('e2ee/proj_c/'))
    ).toEqual([]);
  });

  it('puts the source’s blob ids back where a duplicate made them device-local', () => {
    const bytes = stepBytes('ids');
    const source = withImport(initialDocument('Ids'), 'a'.repeat(32), bytes);
    const local = withImport(
      source,
      `artifact_local_${sha256(text('x'))}`,
      text('x'),
      'Local'
    );
    const copy = JSON.parse(
      JSON.stringify(local).replaceAll(
        'a'.repeat(32),
        `artifact_local_${sha256(bytes)}`
      )
    ) as ProjectDocument;
    const restored = withSourceBlobIds(local, copy);
    expect(JSON.stringify(restored)).toContain('a'.repeat(32));
    // A device-local file stays device-local.
    expect(JSON.stringify(restored)).toContain(
      `artifact_local_${sha256(text('x'))}`
    );
  });
});

// --- Branches ------------------------------------------------------------------

describe('branches', () => {
  it('branches from a save state the current head proves, never moving the pin back', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { projectId, head } = await projectWithImport(srv, laptop, 'Lineage');
    const named = await laptop.store.saveRevision({
      projectId,
      expectedVersion: head.version,
      document: edited(head, 'Lineage'),
      reason: 'Before the change'
    });
    const revisionId = named.revisions.at(-1)!.revisionId;
    const v3 = await save(laptop, edited(named, 'Lineage'), named.version);
    // Another device moves the head on; this page's cached head is older.
    const desktop = device(srv, owner, 'owner_desktop');
    const current = await desktop.store.loadProject(projectId);
    const moved = await save(
      desktop,
      edited(current, 'Lineage'),
      current.version
    );
    expect(moved.version).toBeGreaterThan(v3.version);
    const movedHash = rows<{ version_hash: string }>(
      srv,
      'SELECT version_hash FROM e2ee_project_versions WHERE project_id = ? AND document_version = ?',
      projectId,
      moved.version
    )[0]!.version_hash;

    const request = await buildCopy(laptop, projectId, 'Lineage', {
      revisionId,
      reason: 'Before the change'
    });
    // The branch read the current head first: the pin is the newest head.
    expect(await laptop.pins.read(OWNER, projectId)).toMatchObject({
      headHash: movedHash,
      documentVersion: moved.version
    });
    expect(request.document!.branchedFrom).toMatchObject({
      projectId,
      revisionId
    });
    const { document: branch } = await laptop.store.copyProject({
      sourceProjectId: projectId,
      document: request.document!,
      revisionId
    });
    // A historical read never moved it back.
    expect((await laptop.pins.read(OWNER, projectId))?.headHash).toBe(
      movedHash
    );
    // The source's next version descends from the current head.
    const next = await save(laptop, edited(moved, 'Lineage'), moved.version);
    const header = parseEnvelope(
      fromBase64Url(
        rows<{ envelope_inline: string }>(
          srv,
          'SELECT envelope_inline FROM e2ee_project_versions WHERE project_id = ? AND document_version = ?',
          projectId,
          next.version
        )[0]!.envelope_inline
      )
    ).header;
    expect(
      header.class === 'project' && toHex(header.previousVersionHash!)
    ).toBe(movedHash);
    // The branch opens elsewhere with the save state's model.
    const fresh = device(srv, owner, 'owner_desktop');
    const opened = await fresh.store.loadProject(branch.projectId);
    expect(opened.branchedFrom?.revisionId).toBe(revisionId);
    // A branch carries no shelf picture or exports of the newer head.
    expect((await fresh.store.info.read(branch.projectId)).body).toMatchObject({
      exports: []
    });
  });

  it('refuses a save state the current head no longer names, even when an older head did', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document } = await createEncrypted(laptop, 'Pruned');
    const projectId = document.projectId;
    rememberProjectFormats([
      { projectId: toProjectId(projectId), storageFormat: 2 }
    ]);
    const named = await laptop.store.saveRevision({
      projectId,
      expectedVersion: document.version,
      document: edited(document),
      reason: 'Old save'
    });
    const revisionId = named.revisions.at(-1)!.revisionId;
    // Another device writes a head whose document no longer records it.
    const desktop = device(srv, owner, 'owner_desktop');
    const current = await desktop.store.loadProject(projectId);
    await save(
      desktop,
      {
        ...edited(current),
        revisions: current.revisions.filter((r) => r.revisionId !== revisionId),
        checkpoints: current.checkpoints.filter(
          (c) => c.revisionId !== revisionId
        )
      },
      current.version
    );
    // This page's cached head still names it; the current one does not.
    await expect(
      buildCopy(laptop, projectId, 'Pruned', {
        revisionId,
        reason: 'Old save'
      })
    ).rejects.toBeInstanceOf(EncryptedProjectIntegrityError);
  });

  it('refuses a branch from a save state its source does not store', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { projectId } = await projectWithImport(srv, laptop);
    const request = await buildCopy(laptop, projectId, 'Bracket');
    await refusedWith(
      laptop.store.copyProject({
        sourceProjectId: projectId,
        document: request.document!,
        revisionId: 'rev_missing'
      }),
      404,
      'REVISION_NOT_FOUND'
    );
  });
});

// --- Adoption ------------------------------------------------------------------

describe('adoption', () => {
  it('saves a device project encrypted, its device-only files following as blobs', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const step = stepBytes('device-only');
    const local = `artifact_local_${sha256(step)}`;
    const onDevice = withImport(
      {
        ...initialDocument('Device part'),
        projectId: toProjectId('proj_device_1')
      },
      local,
      step
    );
    const adopt = () =>
      laptop.store.createProject({
        name: 'Device part',
        adoptionProtocolVersion: 2,
        localProjectId: 'proj_device_1',
        document: withoutDerivedProjection(
          adoptProjectDocument(
            reidentifyProjectDocument(onDevice, toProjectId(createId('proj'))),
            toUserId(OWNER),
            'Device part'
          )
        )
      });
    const { project, document } = await adopt();
    const projectId = document.projectId;
    expect(project).toMatchObject({ projectId, storageFormat: 2 });
    expect(rows(srv, 'SELECT * FROM project_adoptions')).toEqual([
      {
        user_id: OWNER,
        local_project_id: 'proj_device_1',
        cloud_project_id: projectId
      }
    ]);
    // Nothing of the document reached the account in plaintext.
    expect(
      rows<{ document_json: string; name: string }>(
        srv,
        'SELECT document_json, name FROM projects WHERE id = ?',
        projectId
      )
    ).toEqual([{ document_json: 'e2ee-v1', name: '' }]);
    // A retry learns where it went, as a plaintext adoption does.
    await expect(adopt()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === 'ALREADY_ADOPTED' &&
        error.details?.projectId === projectId
    );
    // The device-only source follows as an encrypted blob.
    rememberProjectFormats([
      { projectId: toProjectId(projectId), storageFormat: 2 }
    ]);
    const prepared = await archiveAccountImportSources(document, {
      loadSourceBytes: async (checksum) =>
        checksum === sha256(step) ? step : null,
      archive: (input) => laptop.blobs.archive(projectId, input)
    });
    expect(prepared.result.archived).toHaveLength(1);
    await save(laptop, prepared.document, document.version);
    const [blob] = blobRows(srv, projectId);
    expect(blob?.kind).toBe('import-source');
    const desktop = device(srv, owner, 'owner_desktop');
    const opened = await desktop.store.loadProject(projectId);
    expect(JSON.stringify(withoutDerivedProjection(opened))).toContain(
      blob!.blob_id
    );
    expect(await desktop.blobs.read(projectId, blob!.blob_id)).toEqual(step);
  });

  it('keeps refusing plaintext adoption once the account encrypts new projects (D2)', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    // The account opts in through its stored preference.
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_preferences
           (user_id, encrypt_new_projects, record, record_mac, sequence, updated_at)
         VALUES (?, 1, 'r', ?, 1, '2026-10-24T00:00:00.000Z')`
      )
      .run(OWNER, 'm'.repeat(43));
    const refused = await srv.call('POST', '/api/projects', {
      body: {
        name: 'Device part',
        adoptionProtocolVersion: 2,
        localProjectId: 'proj_device_2',
        document: initialDocument('Device part')
      }
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: 'ENCRYPTED_PROJECTS_REQUIRED'
    });
    expect(rows(srv, 'SELECT * FROM project_adoptions')).toEqual([]);
    expect(laptop.deviceId).toBe('owner_laptop');
  });
});

// --- Trash, restore, purge and erasure ----------------------------------------

describe('trash and deletion', () => {
  it('restores a trashed project, which then opens and saves; its owner reads it while trashed', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { projectId, head, blobId, step } = await projectWithImport(
      srv,
      laptop,
      'Binned'
    );
    const patch = (status: string) =>
      srv.call('PATCH', `/api/projects/${projectId}`, { body: { status } });
    expect((await patch('deleted')).status).toBe(200);
    // The owner reads it in the bin, as plaintext owners do; nobody writes.
    const reader = device(srv, owner, 'owner_desktop');
    expect((await reader.store.loadProject(projectId)).version).toBe(
      head.version
    );
    expect(await reader.blobs.read(projectId, blobId)).toEqual(step);
    expect((await reader.store.info.read(projectId)).body?.name).toBe('Binned');
    await refusedWith(
      save(reader, edited(head), head.version),
      404,
      'PROJECT_NOT_FOUND'
    );
    expect(
      (
        await srv.call('GET', `/api/e2ee/projects/${projectId}/document`, {
          user: OTHER
        })
      ).status
    ).toBe(404);
    // The listing still carries its name for the bin.
    const listed = (await (await srv.call('GET', '/api/projects')).json()) as {
      projects: { projectId: string; organization?: { status: string } }[];
      encryptedProjectInfo?: { projectId: string }[];
    };
    expect(
      listed.projects.find((p) => p.projectId === projectId)?.organization
        ?.status
    ).toBe('deleted');
    expect(listed.encryptedProjectInfo?.map((i) => i.projectId)).toContain(
      projectId
    );

    expect((await patch('active')).status).toBe(200);
    const fresh = device(srv, owner, 'owner_desktop');
    const opened = await fresh.store.loadProject(projectId);
    expect(await fresh.blobs.read(projectId, blobId)).toEqual(step);
    await save(fresh, edited(opened, 'Restored'), opened.version);
    expect((await laptop.store.loadProject(projectId)).name).toBe('Restored');
  });

  it('purges an expired project with its objects, keeping its copy', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { projectId } = await projectWithImport(srv, laptop, 'Expiring');
    await laptop.store.saveRevision({
      projectId,
      expectedVersion: (await laptop.store.loadProject(projectId)).version,
      document: edited(await laptop.store.loadProject(projectId)),
      reason: 'Named'
    });
    const request = await buildCopy(laptop, projectId, 'Expiring');
    const { document: copy } = await laptop.store.copyProject({
      sourceProjectId: projectId,
      document: request.document!
    });
    expect(objectKeys(srv, projectId).length).toBeGreaterThan(0);
    srv.db
      .prepare(
        "UPDATE projects SET status = 'deleted', deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
      )
      .run(projectId);
    const purged = await srv.call('POST', '/api/projects/purge');
    expect(await purged.json()).toEqual({ purgedProjectIds: [projectId] });
    expect(objectKeys(srv, projectId)).toEqual([]);
    expect(e2eeRowsOf(srv, projectId)).toEqual(nothingLeft);
    expect(objectKeys(srv, copy.projectId)).toHaveLength(1);
    expect(e2eeRowsOf(srv, copy.projectId).e2ee_content_blobs).toBe(1);
  });

  it('counts encrypted projects in the erasure preview and erases every table and object', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { projectId } = await projectWithImport(srv, laptop, 'Erased');
    const head = await laptop.store.loadProject(projectId);
    await laptop.store.saveRevision({
      projectId,
      expectedVersion: head.version,
      document: edited(head),
      reason: 'Kept'
    });
    const request = await buildCopy(laptop, projectId, 'Erased');
    const { document: copy } = await laptop.store.copyProject({
      sourceProjectId: projectId,
      document: request.document!
    });
    const preview = await srv.call(
      'GET',
      '/api/account/deletion-preview?scope=projects'
    );
    expect(preview.status).toBe(200);
    const counts = (await preview.json()) as {
      projectCount: number;
      documentBytes: number;
      revisionBytes: number;
      revisionCount: number;
    };
    const heads = rows<{ n: number }>(
      srv,
      `SELECT SUM(v.envelope_bytes) AS n FROM e2ee_project_versions v
       JOIN projects p ON p.id = v.project_id AND v.document_version = p.document_version`
    )[0]!.n;
    expect(counts).toMatchObject({
      projectCount: 2,
      documentBytes: heads,
      revisionCount: 1
    });
    expect(counts.revisionBytes).toBeGreaterThan(0);

    const erased = await srv.call('POST', '/api/account/delete-data', {
      body: { scope: 'projects', confirmation: 'DELETE CLOUD PROJECTS' }
    });
    expect(erased.status).toBe(200);
    for (const id of [projectId, copy.projectId]) {
      expect(e2eeRowsOf(srv, id)).toEqual(nothingLeft);
      expect(objectKeys(srv, id)).toEqual([]);
    }
    expect(
      [...srv.bucket.objects.keys()].filter((key) => key.startsWith('e2ee/'))
    ).toEqual([]);
    expect(rows(srv, 'SELECT * FROM project_adoptions')).toEqual([]);
  });
});

// --- Plaintext ---------------------------------------------------------------------

describe('plaintext projects', () => {
  it('duplicates, adopts, trashes and purges as before, naming no encrypted table', async () => {
    const srv = server();
    const created = await srv.call('POST', '/api/projects', {
      body: { name: 'Plain', initialDocument: initialDocument('Plain') }
    });
    expect(created.status).toBe(201);
    const { document } = (await created.json()) as {
      document: ProjectDocument;
    };
    srv.statements.length = 0;
    const duplicated = await srv.call(
      'POST',
      `/api/projects/${document.projectId}/duplicate`,
      { body: {} }
    );
    expect(duplicated.status).toBe(201);
    const adopted = await srv.call('POST', '/api/projects', {
      body: {
        name: 'Device',
        adoptionProtocolVersion: 2,
        localProjectId: 'proj_device_plain',
        document: withoutDerivedProjection(
          adoptProjectDocument(
            reidentifyProjectDocument(
              initialDocument('Device'),
              toProjectId(createId('proj'))
            ),
            toUserId(OWNER),
            'Device'
          )
        )
      }
    });
    expect(adopted.status).toBe(201);
    expect(
      (
        await srv.call('PATCH', `/api/projects/${document.projectId}`, {
          body: { status: 'deleted' }
        })
      ).status
    ).toBe(200);
    expect(
      (
        await srv.call('PATCH', `/api/projects/${document.projectId}`, {
          body: { status: 'active' }
        })
      ).status
    ).toBe(200);
    expect(
      srv.statements.filter(
        (sql) =>
          /e2ee_/.test(sql) &&
          !/sqlite_master|pragma_table_info/.test(sql) &&
          // Decision D2's check of the opt-in, as before this slice.
          !/FROM e2ee_project_preferences/.test(sql)
      )
    ).toEqual([]);
    expect(rows(srv, 'SELECT * FROM e2ee_content_blobs')).toEqual([]);
    srv.db
      .prepare(
        "UPDATE projects SET status = 'deleted', deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
      )
      .run(document.projectId);
    const purged = await srv.call('POST', '/api/projects/purge');
    expect(await purged.json()).toEqual({
      purgedProjectIds: [document.projectId]
    });
  });

  it('keeps plaintext copies and adoption working without migrations 0032–0034', async () => {
    const srv = newServer([owner, other], databaseBefore(32));
    const created = await srv.call('POST', '/api/projects', {
      body: { name: 'Plain', initialDocument: initialDocument('Plain') }
    });
    const { document } = (await created.json()) as {
      document: ProjectDocument;
    };
    expect(
      (
        await srv.call(
          'POST',
          `/api/projects/${document.projectId}/duplicate`,
          {
            body: {}
          }
        )
      ).status
    ).toBe(201);
    const preview = await srv.call(
      'GET',
      '/api/account/deletion-preview?scope=all'
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      projectCount: 2,
      revisionCount: 0
    });
    expect(
      (
        await srv.call('POST', '/api/account/delete-data', {
          body: { scope: 'projects', confirmation: 'DELETE CLOUD PROJECTS' }
        })
      ).status
    ).toBe(200);
    for (const sql of srv.statements.filter((s) =>
      /e2ee_project_versions|e2ee_content_blobs|e2ee_project_groups/.test(s)
    )) {
      expect(sql, sql).toMatch(/FROM sqlite_master/);
    }
  });
});
