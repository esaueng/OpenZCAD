/**
 * Encrypted content blobs (ADR-024 Phase 4, slice 4-6): Node devices of one
 * owner run the real client modules (`encryptedContentBlobs.ts`,
 * `encryptedProjectStore.ts`, `projectGroups.ts`) with the in-process MLS
 * engine against the real Worker over SQLite: the blob routes, the ordinary
 * upload sessions they ride on, version writes that name blobs, garbage
 * collection, quotas, purge and erasure. Every migration is applied unless
 * a case says otherwise.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  E2eeError,
  EnvelopeKey,
  encryptContentBlob,
  fromBase64Url,
  parseEnvelope
} from '@openzcad/crypto';
import { UnstorableDocumentError } from '@openzcad/document-core';
import {
  E2EE_UNREFERENCED_BLOB_GRACE_MS,
  MAX_ACCOUNT_ARTIFACT_BYTES,
  type ProjectDocument
} from '@openzcad/shared';
import { ApiError } from '../apps/web/src/lib/api';
import type { ArchiveArtifactInput } from '../apps/web/src/lib/archiveArtifact';
import {
  KeySessionEndedError,
  createBlobReferenceRegistry,
  sessionBoundReferences
} from '../apps/web/src/lib/e2ee/blobReferences';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
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

/** Not compressible: what a picture looks like to gzip. */
function noise(length: number, seed = 1): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (state * 1103515245 + 12345) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function stepInput(bytes: Uint8Array<ArrayBuffer>): ArchiveArtifactInput {
  return {
    fileName: 'secret-bracket.step',
    contentType: 'model/step',
    kind: 'step-import',
    body: new Blob([bytes])
  };
}

function pictureInput(bytes: Uint8Array<ArrayBuffer>): ArchiveArtifactInput {
  return {
    fileName: 'secret-sketch.png',
    contentType: 'image/png',
    kind: 'reference-image',
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
      artifactId: artifactId,
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
  await d.store.saveProjectDocument({
    projectId: document.projectId,
    expectedVersion: expected,
    document
  });
  return document;
}

interface BlobRow {
  blob_id: string;
  kind: string;
  object_key: string;
  ciphertext_bytes: number;
  dedupe_tag: string | null;
  state: string;
}

const blobRows = (srv: Server, projectId: string) =>
  rows<BlobRow>(
    srv,
    `SELECT blob_id, kind, object_key, ciphertext_bytes, dedupe_tag, state
     FROM e2ee_content_blobs WHERE project_id = ? ORDER BY created_at, blob_id`,
    projectId
  );

function headEnvelope(srv: Server, projectId: string): Uint8Array {
  const [head] = rows<{
    envelope_inline: string | null;
    envelope_key: string | null;
  }>(
    srv,
    `SELECT envelope_inline, envelope_key FROM e2ee_project_versions
     WHERE project_id = ? ORDER BY document_version DESC LIMIT 1`,
    projectId
  );
  return head!.envelope_inline !== null
    ? fromBase64Url(head!.envelope_inline)
    : new Uint8Array(srv.bucket.objects.get(head!.envelope_key!)!);
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

/** An owner's encrypted project and the laptop that created it. */
async function encryptedProject(
  options: Parameters<typeof device>[3] = {}
) {
  const srv = server();
  const laptop = device(srv, owner, 'owner_laptop', options);
  const { document } = await createEncrypted(laptop);
  return { srv, laptop, projectId: document.projectId, document };
}

// --- Archive, write and read ------------------------------------------------

describe('content blobs', () => {
  it.each([4099, 100_000])('keeps encrypted upload transport and version writes available under the plaintext freeze (part bytes %i)', async (partBytes) => {
    const { srv, laptop, projectId, document } = await encryptedProject({ partBytes, chunkSize: 1000 });
    srv.env.E2EE_PLAINTEXT_FROZEN = 'true';
    const picture = noise(20_000, 17);
    const blobId = await laptop.blobs.archive(projectId, pictureInput(picture));
    const step = stepBytes('encrypted-after-freeze');
    const source = await laptop.blobs.archive(projectId, stepInput(step));
    await save(laptop, withImport(document, source, step), document.version);
    expect(await laptop.blobs.read(projectId, blobId)).toEqual(picture);
    expect(await laptop.blobs.read(projectId, source)).toEqual(step);
    expect(rows(srv, 'SELECT * FROM artifacts')).toEqual([]);
  });

  it('stores an imported STEP file encrypted and opens it on another device', async () => {
    const { srv, laptop, projectId, document } = await encryptedProject();
    const step = stepBytes('bracket');
    const blobId = await laptop.blobs.archive(projectId, stepInput(step));
    expect(blobId).toMatch(/^[0-9a-f]{32}$/);
    const [row] = blobRows(srv, projectId);
    expect(row).toMatchObject({
      blob_id: blobId,
      kind: 'import-source',
      object_key: `e2ee/${projectId}/${blobId}`,
      state: 'committed'
    });
    expect(row!.dedupe_tag).toMatch(/^[0-9a-f]{64}$/);
    // Nothing became an artifact, and the session is gone.
    expect(rows(srv, 'SELECT * FROM artifacts')).toEqual([]);
    expect(rows(srv, 'SELECT * FROM upload_sessions')).toEqual([]);

    const v2 = withImport(document, blobId, step);
    await save(laptop, v2, document.version);
    // The header names the blob, and the Worker recorded the reference.
    expect(parseEnvelope(headEnvelope(srv, projectId)).header).toMatchObject({
      class: 'project',
      blobIds: [blobId]
    });
    expect(
      rows(
        srv,
        'SELECT blob_id FROM e2ee_version_blobs WHERE project_id = ?',
        projectId
      )
    ).toEqual([{ blob_id: blobId }]);
    // The account holds ciphertext only: no file name, no STEP text.
    const stored = everythingStored(srv);
    expect(stored).not.toContain('secret-bracket');
    expect(stored).not.toContain('ISO-10303-21');
    expect(stored).not.toContain('FILE_NAME');

    // A fresh page on another device learns the key from the verified head.
    const desktop = device(srv, owner, 'owner_desktop');
    expect(desktop.references.get(projectId, blobId)).toBeNull();
    const loaded = await desktop.store.loadProject(projectId);
    expect(loaded.version).toBe(v2.version);
    expect(desktop.references.get(projectId, blobId)).toMatchObject({
      checksumSha256: sha256(step)
    });
    expect(await desktop.blobs.read(projectId, blobId)).toEqual(step);
    // And keeps naming the blob when it saves.
    await save(desktop, edited(loaded, 'Renamed'), loaded.version);
    expect(parseEnvelope(headEnvelope(srv, projectId)).header).toMatchObject({
      blobIds: [blobId]
    });
  });

  it('uploads through multipart parts that do not line up with chunks', async () => {
    const { srv, laptop, projectId } = await encryptedProject({
      partBytes: 4099,
      chunkSize: 1000
    });
    const picture = noise(20_000, 7);
    const blobId = await laptop.blobs.archive(projectId, pictureInput(picture));
    expect(srv.bucket.createMultipartUpload).toHaveBeenCalled();
    const object = new Uint8Array(
      srv.bucket.objects.get(`e2ee/${projectId}/${blobId}`)!
    );
    const shape = parseEnvelope(object);
    expect(shape.header).toMatchObject({
      compression: 'none',
      chunkSize: 1000
    });
    // Parts of 4,099 bytes against chunks of 1,016: no boundary agrees.
    expect(object.byteLength).toBeGreaterThan(4 * 4099);
    expect((shape.prefix.byteLength + 4099) % 1016).not.toBe(0);
    expect(
      rows(srv, 'SELECT ciphertext_bytes FROM e2ee_content_blobs')
    ).toEqual([{ ciphertext_bytes: object.byteLength }]);
    expect(await laptop.blobs.read(projectId, blobId)).toEqual(picture);
  });

  it('refuses a swapped or tampered blob against its reference', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    const a = await laptop.blobs.archive(projectId, stepInput(stepBytes('a')));
    const b = await laptop.blobs.archive(projectId, stepInput(stepBytes('b')));
    const keyA = `e2ee/${projectId}/${a}`;
    const original = srv.bucket.objects.get(keyA)!;
    // The account serves B's bytes for A: they are not A's blob.
    srv.bucket.objects.set(
      keyA,
      srv.bucket.objects.get(`e2ee/${projectId}/${b}`)!
    );
    await expect(laptop.blobs.read(projectId, a)).rejects.toBeInstanceOf(
      E2eeError
    );
    // One flipped ciphertext byte fails too.
    const flipped = new Uint8Array(original.slice(0));
    flipped[flipped.byteLength - 20]! ^= 1;
    srv.bucket.objects.set(keyA, flipped.buffer);
    await expect(laptop.blobs.read(projectId, a)).rejects.toBeInstanceOf(
      E2eeError
    );
    srv.bucket.objects.set(keyA, original);
    expect(await laptop.blobs.read(projectId, a)).toEqual(stepBytes('a'));
  });

  it('refuses a blob the account stores without its last chunks', async () => {
    const { srv, laptop, projectId } = await encryptedProject({
      chunkSize: 512
    });
    const picture = noise(5_000, 3);
    const blobId = await laptop.blobs.archive(projectId, pictureInput(picture));
    const key = `e2ee/${projectId}/${blobId}`;
    const object = new Uint8Array(srv.bucket.objects.get(key)!);
    const { prefix } = parseEnvelope(object);
    // Cut at a chunk boundary: every remaining chunk still authenticates.
    srv.bucket.objects.set(
      key,
      object.slice(0, prefix.byteLength + 3 * (512 + 16)).buffer
    );
    await expect(laptop.blobs.read(projectId, blobId)).rejects.toBeInstanceOf(
      E2eeError
    );
  });

  it('refuses to write a document naming a blob this page holds no key for', async () => {
    const { laptop, projectId, document } = await encryptedProject();
    const unknown = 'f'.repeat(32);
    await expect(
      save(
        laptop,
        withImport(document, unknown, stepBytes('x')),
        document.version
      )
    ).rejects.toBeInstanceOf(UnstorableDocumentError);
    // A device-only import needs no blob.
    await save(
      laptop,
      withImport(document, 'artifact_local_one', stepBytes('x')),
      document.version
    );
    expect(laptop.references.get(projectId, unknown)).toBeNull();
  });

  it('keeps original mesh files and snapshots on the device', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    // Thumbnails and exports are encrypted blobs since slice 4-7
    // (e2ee-project-info.test.ts).
    for (const kind of ['stl-import', 'mesh-import', 'snapshot'] as const) {
      await refusedWith(
        laptop.blobs.archive(projectId, {
          fileName: 'x',
          contentType: 'application/octet-stream',
          kind,
          body: new Blob([text('x')])
        }),
        409,
        'E2EE_LOCAL_ONLY'
      );
    }
    expect(blobRows(srv, projectId)).toEqual([]);
  });
});

// --- Dedupe -------------------------------------------------------------------

describe('dedupe', () => {
  it('keeps no key of an upload that finishes after the key session ended', async () => {
    const page = createBlobReferenceRegistry();
    let revision = 1;
    const references = sessionBoundReferences(page, {
      revision: () => revision,
      isCurrent: (seen) => seen === revision
    });
    const { srv, laptop, projectId } = await encryptedProject({ references });
    // Sign-out lands while the blob is being finalized.
    laptop.before = async (path) => {
      if (path.includes('/finalize')) revision += 1;
    };
    await expect(
      laptop.blobs.archive(projectId, stepInput(stepBytes('late')))
    ).rejects.toBeInstanceOf(KeySessionEndedError);
    const [row] = blobRows(srv, projectId);
    expect(row).toBeDefined();
    // The page registry the next session reads holds nothing of it.
    expect(page.projectOf(row!.blob_id)).toBeNull();
    expect(page.get(projectId, row!.blob_id)).toBeNull();
    expect(references.get(projectId, row!.blob_id)).toBeNull();
  });

  it('reuses a blob this page holds the key for, and uploads a new file', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    const step = stepBytes('same');
    const first = await laptop.blobs.archive(projectId, stepInput(step));
    const puts = srv.bucket.createMultipartUpload.mock.calls.length;
    expect(await laptop.blobs.archive(projectId, stepInput(step))).toBe(first);
    expect(srv.bucket.createMultipartUpload.mock.calls.length).toBe(puts);
    expect(blobRows(srv, projectId)).toHaveLength(1);
    // Another file: a miss, a new blob.
    const second = await laptop.blobs.archive(
      projectId,
      stepInput(stepBytes('other'))
    );
    expect(second).not.toBe(first);
    expect(blobRows(srv, projectId)).toHaveLength(2);
  });

  it('offers no unreferenced blob that collection may claim soon', async () => {
    const { srv, laptop, projectId, document } = await encryptedProject();
    const step = stepBytes('aging');
    const first = await laptop.blobs.archive(projectId, stepInput(step));
    vi.useFakeTimers({
      now: Date.now() + E2EE_UNREFERENCED_BLOB_GRACE_MS / 2 + 60_000,
      toFake: ['Date']
    });
    const second = await laptop.blobs.archive(projectId, stepInput(step));
    expect(second).not.toBe(first);
    // Once a retained version names it, a blob is offered at any age.
    await save(laptop, withImport(document, second, step), document.version);
    vi.useFakeTimers({
      now: Date.now() + E2EE_UNREFERENCED_BLOB_GRACE_MS * 3,
      toFake: ['Date']
    });
    expect(await laptop.blobs.archive(projectId, stepInput(step))).toBe(second);
    expect(srv.bucket.objects.has(`e2ee/${projectId}/${second}`)).toBe(true);
  });

  it('uploads again when the tag names a blob this page has no key for', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    const step = stepBytes('shared');
    const first = await laptop.blobs.archive(projectId, stepInput(step));
    const tag = blobRows(srv, projectId)[0]!.dedupe_tag;
    // A fresh page holds no references until it opens a document.
    const desktop = device(srv, owner, 'owner_desktop');
    const second = await desktop.blobs.archive(projectId, stepInput(step));
    expect(second).not.toBe(first);
    // Same dedupe secret, same tag: it moved to the newer blob.
    expect(blobRows(srv, projectId)).toEqual([
      expect.objectContaining({ blob_id: first, dedupe_tag: null }),
      expect.objectContaining({ blob_id: second, dedupe_tag: tag })
    ]);
    expect(await desktop.blobs.read(projectId, second)).toEqual(step);
  });

  it('does not trust a tag the account points at another file', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    const one = stepBytes('one');
    const two = stepBytes('two'); // the same length as `one`
    expect(two.byteLength).toBe(one.byteLength);
    const first = await laptop.blobs.archive(projectId, stepInput(one));
    const second = await laptop.blobs.archive(projectId, stepInput(two));
    const tagTwo = blobRows(srv, projectId)[1]!.dedupe_tag!;
    // The account answers file two's tag with file one's blob (a hostile
    // server is not held by its own triggers).
    srv.db.exec('DROP TRIGGER e2ee_content_blob_immutable');
    srv.db.prepare('UPDATE e2ee_content_blobs SET dedupe_tag = NULL').run();
    srv.db
      .prepare('UPDATE e2ee_content_blobs SET dedupe_tag = ? WHERE blob_id = ?')
      .run(tagTwo, first);
    const again = await laptop.blobs.archive(projectId, stepInput(two));
    expect([first, second]).not.toContain(again);
    expect(await laptop.blobs.read(projectId, again)).toEqual(two);
  });
});

// --- Worker checks ------------------------------------------------------------

/** A hand-built blob uploaded through the routes as a hostile client could. */
async function uploadRaw(
  srv: Server,
  projectId: string,
  blobId: string,
  envelope: Uint8Array<ArrayBuffer>,
  kind = 'import-source'
) {
  const started = await srv.call(
    'POST',
    `/api/e2ee/projects/${projectId}/blobs/uploads`,
    { body: { blobId, kind } }
  );
  expect(started.status).toBe(201);
  const { session } = (await started.json()) as {
    session: { uploadSessionId: string; uploadUrl: string };
  };
  expect(
    (await srv.call('PUT', session.uploadUrl, { raw: envelope })).status
  ).toBe(204);
  return srv.call(
    'POST',
    `/api/e2ee/projects/${projectId}/blobs/${blobId}/finalize`,
    {
      body: { uploadSessionId: session.uploadSessionId }
    }
  );
}

describe('the Worker', () => {
  it('commits only a whole content blob that names its session', async () => {
    const { srv, projectId } = await encryptedProject();
    const sealed = async (bytes: Uint8Array) =>
      encryptContentBlob(EnvelopeKey.generate(), 'import-source', bytes, {
        compression: 'none',
        chunkSize: 256
      });
    const good = await sealed(noise(2000));
    const other = await sealed(noise(2000, 9));
    const prefix = parseEnvelope(good.envelope).prefix.byteLength;
    const cases: [string, string, Uint8Array<ArrayBuffer>][] = [
      ['another blob than named', good.reference.blobId, other.envelope],
      [
        'cut at a chunk boundary',
        good.reference.blobId,
        good.envelope.slice(0, prefix + 2 * (256 + 16))
      ],
      [
        'cut inside a tag',
        good.reference.blobId,
        good.envelope.slice(0, prefix + 256 + 5)
      ],
      ['not an envelope', good.reference.blobId, noise(500)]
    ];
    for (const [label, blobId, envelope] of cases) {
      const response = await uploadRaw(srv, projectId, blobId, envelope);
      expect(response.status, label).toBe(400);
      expect(await response.json(), label).toMatchObject({
        code: 'E2EE_BLOB_INVALID'
      });
      // The refused object and its session are gone again.
      expect(blobRows(srv, projectId), label).toEqual([]);
      expect(rows(srv, 'SELECT * FROM upload_sessions'), label).toEqual([]);
      expect(srv.bucket.objects.has(`e2ee/${projectId}/${blobId}`), label).toBe(
        false
      );
    }
    // A blob of another kind than its session declares.
    const mesh = await encryptContentBlob(
      EnvelopeKey.generate(),
      'mesh-payload',
      noise(100)
    );
    const response = await uploadRaw(
      srv,
      projectId,
      mesh.reference.blobId,
      mesh.envelope
    );
    expect(response.status).toBe(400);
    // The whole blob commits; a retried finalize answers the same.
    const committed = await uploadRaw(
      srv,
      projectId,
      good.reference.blobId,
      good.envelope
    );
    expect(committed.status).toBe(200);
    expect(await committed.json()).toEqual({
      blobId: good.reference.blobId,
      kind: 'import-source',
      ciphertextBytes: good.envelope.byteLength
    });
    const retry = await srv.call(
      'POST',
      `/api/e2ee/projects/${projectId}/blobs/uploads`,
      { body: { blobId: good.reference.blobId, kind: 'import-source' } }
    );
    expect(await retry.json()).toMatchObject({ committed: true });
  });

  it('refuses unknown kinds, ids and tags, and other projects’ blobs', async () => {
    const { srv, laptop, projectId, document } = await encryptedProject();
    const call = (body: unknown) =>
      srv.call('POST', `/api/e2ee/projects/${projectId}/blobs/uploads`, {
        body
      });
    expect(
      (await call({ blobId: 'a'.repeat(32), kind: 'snapshot' })).status
    ).toBe(409);
    expect(
      (await call({ blobId: 'A'.repeat(32), kind: 'import-source' })).status
    ).toBe(400);
    expect(
      (await srv.call('GET', `/api/e2ee/projects/${projectId}/blobs?tag=nope`))
        .status
    ).toBe(400);
    // A blob of the owner's other encrypted project is not this project's.
    const { document: otherDocument } = await createEncrypted(laptop, 'Other');
    const step = stepBytes('elsewhere');
    const foreign = await laptop.blobs.archive(
      otherDocument.projectId,
      stepInput(step)
    );
    const held = laptop.references.get(otherDocument.projectId, foreign)!;
    laptop.references.remember(projectId, held.reference, held.checksumSha256);
    await refusedWith(
      save(laptop, withImport(document, foreign, step), document.version),
      409,
      'E2EE_BLOB_UNKNOWN'
    );
    expect(
      (
        await srv.call(
          'GET',
          `/api/e2ee/projects/${projectId}/blobs/${foreign}`
        )
      ).status
    ).toBe(404);
  });

  it('serves only the owner, only format 2 and only behind the flag', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    const blobId = await laptop.blobs.archive(
      projectId,
      stepInput(stepBytes('o'))
    );
    const path = `/api/e2ee/projects/${projectId}/blobs/${blobId}`;
    expect((await srv.call('GET', path)).status).toBe(200);
    expect((await srv.call('GET', path, { user: OTHER })).status).toBe(404);
    srv.env.E2EE_PROJECTS_ENABLED = 'false';
    expect((await srv.call('GET', path)).status).toBe(501);
    srv.env.E2EE_PROJECTS_ENABLED = 'true';
    // A plaintext project has no encrypted blobs.
    const created = await srv.call('POST', '/api/projects', {
      body: { name: 'Plain', initialDocument: initialDocument('Plain') }
    });
    const { document: plain } = (await created.json()) as {
      document: ProjectDocument;
    };
    const response = await srv.call(
      'POST',
      `/api/e2ee/projects/${plain.projectId}/blobs/uploads`,
      { body: { blobId: 'b'.repeat(32), kind: 'import-source' } }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'E2EE_PROJECT_NOT_ENCRYPTED'
    });
  });

  it('refuses plaintext uploads, finalize and downloads on an encrypted project', async () => {
    const { srv, projectId } = await encryptedProject();
    const created = await srv.call('POST', '/api/uploads', {
      body: {
        projectId,
        fileName: 'leak.step',
        contentType: 'model/step',
        kind: 'step-import'
      }
    });
    expect(created.status).toBe(409);
    expect(await created.json()).toMatchObject({
      code: 'PROJECT_FORMAT_UNSUPPORTED'
    });
    // A plaintext session left over on an encrypted project takes no bytes.
    srv.db
      .prepare(
        `INSERT INTO upload_sessions
           (id, artifact_id, project_id, object_key, file_name, content_type, kind,
            metadata_json, expires_at, owner_user_id, reserved_bytes,
            reservation_state, upload_protocol_version)
         VALUES ('upload_old', 'artifact_old', ?, 'old-key', 'leak.step',
                 'model/step', 'step-import', '{}', ?, ?, 0, 'open', 1)`
      )
      .run(projectId, new Date(Date.now() + 60_000).toISOString(), OWNER);
    const put = await srv.call('PUT', '/api/uploads/upload_old/content', {
      raw: text('ISO-10303-21;')
    });
    expect(put.status).toBe(409);
    expect(srv.bucket.objects.has('old-key')).toBe(false);
    const finalize = await srv.call('POST', '/api/artifacts/finalize', {
      body: {
        projectId,
        uploadSessionId: 'upload_old',
        artifactId: 'artifact_old'
      }
    });
    expect(finalize.status).toBe(409);
    // An artifact row that should not exist is not served either.
    srv.db
      .prepare(
        `INSERT INTO artifacts (id, project_id, kind, name, object_key,
           content_type, metadata_json, created_at, bytes)
         VALUES ('artifact_stray', ?, 'step-import', 'x.step', 'stray',
                 'model/step', '{}', 'now', 1)`
      )
      .run(projectId);
    srv.bucket.objects.set('stray', text('x').buffer);
    expect(
      (await srv.call('GET', '/api/artifacts/artifact_stray/download')).status
    ).toBe(409);
    expect(
      (await srv.call('GET', `/api/projects/${projectId}/artifacts`)).status
    ).toBe(409);
  });

  it('refuses an encrypted blob session on a plaintext project', async () => {
    const srv = server();
    const created = await srv.call('POST', '/api/projects', {
      body: { name: 'Plain', initialDocument: initialDocument('Plain') }
    });
    const { document: plain } = (await created.json()) as {
      document: ProjectDocument;
    };
    srv.db
      .prepare(
        `INSERT INTO upload_sessions
           (id, artifact_id, project_id, object_key, file_name, content_type, kind,
            metadata_json, expires_at, owner_user_id, reserved_bytes,
            reservation_state, upload_protocol_version, e2ee_blob_kind)
         VALUES ('upload_blob', ?, ?, 'blob-key', 'x', 'application/octet-stream',
                 'e2ee-blob', '{}', ?, ?, 0, 'open', 1, 'import-source')`
      )
      .run(
        'c'.repeat(32),
        plain.projectId,
        new Date(Date.now() + 60_000).toISOString(),
        OWNER
      );
    const put = await srv.call('PUT', '/api/uploads/upload_blob/content', {
      raw: text('bytes')
    });
    expect(put.status).toBe(503);
    expect(srv.bucket.objects.has('blob-key')).toBe(false);
    // And it never becomes an artifact, whichever Worker tries.
    expect(() =>
      srv.db
        .prepare(
          `INSERT INTO artifacts (id, project_id, kind, name, object_key,
             content_type, metadata_json, created_at, bytes)
           VALUES (?, ?, 'step-import', 'x', 'k', 'model/step', '{}', 'now', 1)`
        )
        .run('c'.repeat(32), plain.projectId)
    ).toThrow(/E2EE_BLOB_NOT_ARTIFACT/);
  });
});

// --- Garbage collection -------------------------------------------------------

describe('garbage collection', () => {
  /** Every blob so far is past its grace period from here on. */
  const age = (_srv: Server) =>
    vi.useFakeTimers({
      now: Date.now() + E2EE_UNREFERENCED_BLOB_GRACE_MS + 60_000,
      toFake: ['Date']
    });

  it('removes only old blobs no retained version names', async () => {
    const { srv, laptop, projectId, document } = await encryptedProject();
    const kept = stepBytes('kept');
    const keptId = await laptop.blobs.archive(projectId, stepInput(kept));
    const orphanId = await laptop.blobs.archive(
      projectId,
      stepInput(stepBytes('orphan'))
    );
    const v2 = withImport(document, keptId, kept);
    await save(laptop, v2, document.version);
    // Within the grace period, an unreferenced upload is left alone.
    await save(laptop, edited(v2), v2.version);
    expect(
      blobRows(srv, projectId)
        .map((row) => row.blob_id)
        .sort()
    ).toEqual([keptId, orphanId].sort());
    age(srv);
    const v3 = edited(edited(v2));
    await save(laptop, v3, v2.version + 1);
    expect(blobRows(srv, projectId).map((row) => row.blob_id)).toEqual([
      keptId
    ]);
    expect(srv.bucket.objects.has(`e2ee/${projectId}/${orphanId}`)).toBe(false);
    expect(srv.bucket.objects.has(`e2ee/${projectId}/${keptId}`)).toBe(true);
    // The account refuses a claim on a referenced blob outright.
    expect(() =>
      srv.db
        .prepare(
          "UPDATE e2ee_content_blobs SET state = 'deleting' WHERE blob_id = ?"
        )
        .run(keptId)
    ).toThrow(/E2EE_BLOB_REFERENCED/);
    expect(() =>
      srv.db
        .prepare('DELETE FROM e2ee_content_blobs WHERE blob_id = ?')
        .run(keptId)
    ).toThrow(/E2EE_BLOB_NOT_RELEASED/);
  });

  it('keeps a blob a named save still names after the head dropped it', async () => {
    const { srv, laptop, projectId, document } = await encryptedProject();
    const step = stepBytes('saved');
    const blobId = await laptop.blobs.archive(projectId, stepInput(step));
    const withStep = withImport(document, blobId, step);
    const saved = await laptop.store.saveRevision({
      projectId,
      expectedVersion: document.version,
      document: withStep,
      reason: 'With the bracket'
    });
    // The head drops the import entirely (no undo history either) and
    // keeps the named save.
    const dropped = edited(
      {
        ...document,
        version: saved.version,
        revisions: saved.revisions,
        checkpoints: saved.checkpoints
      },
      'Dropped'
    );
    await save(laptop, dropped, saved.version);
    age(srv);
    await save(laptop, edited(dropped), dropped.version);
    expect(blobRows(srv, projectId).map((row) => row.blob_id)).toEqual([
      blobId
    ]);
    // The saved version still opens with its file.
    const desktop = device(srv, owner, 'owner_desktop');
    const revision = await desktop.store.loadRevision(
      projectId,
      saved.revisions.at(-1)!.revisionId
    );
    expect(revision).not.toBeNull();
    expect(await desktop.blobs.read(projectId, blobId)).toEqual(step);
  });

  it('refuses a version naming a blob collected meanwhile', async () => {
    const { srv, laptop, projectId, document } = await encryptedProject();
    const step = stepBytes('late');
    const blobId = await laptop.blobs.archive(projectId, stepInput(step));
    age(srv);
    await save(laptop, edited(document), document.version);
    expect(blobRows(srv, projectId)).toEqual([]);
    await refusedWith(
      save(
        laptop,
        withImport(edited(document), blobId, step),
        document.version + 1
      ),
      409,
      'E2EE_BLOB_UNKNOWN'
    );
  });
});

// --- Quota, purge and erasure ---------------------------------------------------

describe('accounting', () => {
  it('counts ciphertext against the artifact quota and releases it on purge', async () => {
    const { srv, laptop, projectId } = await encryptedProject();
    const blobId = await laptop.blobs.archive(
      projectId,
      stepInput(stepBytes('q'))
    );
    const bytes = blobRows(srv, projectId)[0]!.ciphertext_bytes;
    const usage = () =>
      rows<{ finalized_bytes: number; reserved_bytes: number }>(
        srv,
        'SELECT finalized_bytes, reserved_bytes FROM artifact_account_usage WHERE owner_user_id = ?',
        OWNER
      )[0];
    expect(usage()).toEqual({ finalized_bytes: bytes, reserved_bytes: 0 });
    // The storage report reconciles blobs with the durable total.
    const storage = await srv.call('GET', '/api/account/storage');
    expect(storage.status).toBe(200);
    // Fill the account to just below its limit with a plaintext artifact.
    const created = await srv.call('POST', '/api/projects', {
      body: { name: 'Plain', initialDocument: initialDocument('Plain') }
    });
    const { document: plain } = (await created.json()) as {
      document: ProjectDocument;
    };
    srv.db
      .prepare(
        `INSERT INTO artifacts (id, project_id, kind, name, object_key,
           content_type, metadata_json, created_at, bytes)
         VALUES ('artifact_big', ?, 'step-import', 'big.step', 'big',
                 'model/step', '{}', 'now', ?)`
      )
      .run(plain.projectId, MAX_ACCOUNT_ARTIFACT_BYTES - bytes - 100);
    await refusedWith(
      laptop.blobs.archive(projectId, stepInput(stepBytes('over', 400))),
      413,
      'ARTIFACT_QUOTA_EXCEEDED'
    );
    expect(blobRows(srv, projectId).map((row) => row.blob_id)).toEqual([
      blobId
    ]);
    srv.db.prepare("DELETE FROM artifacts WHERE id = 'artifact_big'").run();
    // Purge: objects, rows and usage go with the project.
    srv.db
      .prepare(
        "UPDATE projects SET status = 'deleted', deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
      )
      .run(projectId);
    expect((await srv.call('POST', '/api/projects/purge')).status).toBe(200);
    expect(rows(srv, 'SELECT * FROM e2ee_content_blobs')).toEqual([]);
    expect(rows(srv, 'SELECT * FROM e2ee_version_blobs')).toEqual([]);
    expect(
      [...srv.bucket.objects.keys()].filter((key) => key.startsWith('e2ee/'))
    ).toEqual([]);
    expect(usage()).toEqual({ finalized_bytes: 0, reserved_bytes: 0 });
  });

  it('erases every blob with the account', async () => {
    const { srv, laptop, projectId, document } = await encryptedProject();
    const step = stepBytes('erase');
    const blobId = await laptop.blobs.archive(projectId, stepInput(step));
    await save(laptop, withImport(document, blobId, step), document.version);
    const response = await srv.call('POST', '/api/account/delete-data', {
      body: { scope: 'all', confirmation: 'DELETE ALL CLOUD DATA' }
    });
    expect(response.status).toBe(200);
    expect(rows(srv, 'SELECT * FROM e2ee_content_blobs')).toEqual([]);
    expect(rows(srv, 'SELECT * FROM e2ee_version_blobs')).toEqual([]);
    expect(
      [...srv.bucket.objects.keys()].filter((key) => key.startsWith('e2ee/'))
    ).toEqual([]);
  });
});

// --- Migration 0034 -----------------------------------------------------------

const BLOB_SCHEMA = /e2ee_content_blobs|e2ee_version_blobs|e2ee_blob_kind/;

/** The only statements allowed to name the new schema are the probes. */
function expectOnlyProbes(statements: string[]) {
  for (const sql of statements.filter((s) => BLOB_SCHEMA.test(s))) {
    expect(sql, sql).toMatch(/FROM sqlite_master/);
  }
}

/**
 * Merging deploys to the live beta, which applies migrations. If 0034 fails
 * or is delayed, ordinary uploads, imports, purge and erasure must not
 * notice; only the encrypted blob routes answer 503.
 */
describe('without migration 0034', () => {
  async function plaintextUpload(srv: Server, projectId: string, path: string) {
    const created = await srv.call('POST', '/api/uploads', {
      body: {
        projectId,
        fileName: 'part.step',
        contentType: 'model/step',
        kind: 'step-import'
      }
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as {
      session: {
        uploadSessionId: string;
        uploadUrl: string;
        artifactId: string;
      };
    };
    expect(
      (await srv.call('PUT', session.uploadUrl, { raw: stepBytes('plain') }))
        .status
    ).toBe(204);
    const finalized = await srv.call('POST', path, {
      body: {
        projectId,
        uploadSessionId: session.uploadSessionId,
        artifactId: session.artifactId
      }
    });
    expect(finalized.status).toBe(200);
    return session.artifactId;
  }

  it('keeps ordinary uploads, imports, downloads, purge and erasure working', async () => {
    const srv = newServer([owner, other], databaseBefore(34));
    const created = await srv.call('POST', '/api/projects', {
      body: { name: 'Plain', initialDocument: initialDocument('Plain') }
    });
    const { document } = (await created.json()) as {
      document: ProjectDocument;
    };
    const artifactId = await plaintextUpload(
      srv,
      document.projectId,
      '/api/artifacts/finalize'
    );
    await plaintextUpload(srv, document.projectId, '/api/imports/finalize');
    const download = await srv.call(
      'GET',
      `/api/artifacts/${artifactId}/download`
    );
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(
      stepBytes('plain')
    );
    expect(
      (await srv.call('GET', `/api/projects/${document.projectId}/artifacts`))
        .status
    ).toBe(200);
    expect((await srv.call('GET', '/api/account/storage')).status).toBe(200);
    srv.db
      .prepare(
        "UPDATE projects SET status = 'deleted', deleted_at = '2000-01-01T00:00:00.000Z'"
      )
      .run();
    expect((await srv.call('POST', '/api/projects/purge')).status).toBe(200);
    expect(rows(srv, 'SELECT * FROM artifacts')).toEqual([]);
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
    expectOnlyProbes(srv.statements);
  });

  it('answers 503 on the blob routes and keeps refusing blobs in versions', async () => {
    const srv = newServer([owner, other], databaseBefore(34));
    const laptop = device(srv, owner, 'owner_laptop');
    const { document } = await createEncrypted(laptop);
    const projectId = document.projectId;
    for (const [method, path] of [
      ['POST', `/api/e2ee/projects/${projectId}/blobs/uploads`],
      [
        'POST',
        `/api/e2ee/projects/${projectId}/blobs/${'a'.repeat(32)}/finalize`
      ],
      ['GET', `/api/e2ee/projects/${projectId}/blobs/${'a'.repeat(32)}`],
      ['GET', `/api/e2ee/projects/${projectId}/blobs?tag=${'a'.repeat(64)}`]
    ] as const) {
      const response = await srv.call(
        method,
        path,
        method === 'GET' ? {} : { body: {} }
      );
      expect(response.status, `${method} ${path}`).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'E2EE_UNAVAILABLE' });
    }
    // Documents without blobs still save; a version naming one is refused.
    const v2 = await save(
      laptop,
      edited(document, 'Still saving'),
      document.version
    );
    laptop.references.remember(
      projectId,
      {
        blobId: 'a'.repeat(32),
        kind: 'import-source',
        key: new Uint8Array(32),
        ciphertextHash: new Uint8Array(32),
        plaintextLength: 10
      },
      null
    );
    await refusedWith(
      save(
        laptop,
        withImport(edited(v2), 'a'.repeat(32), stepBytes('x')),
        v2.version
      ),
      409,
      'E2EE_CONTENT_BLOBS_UNAVAILABLE'
    );
    expectOnlyProbes(srv.statements);
  });

  it('notices the migration once it lands, without a redeploy', async () => {
    const db = databaseBefore(34);
    const srv = newServer([owner, other], db);
    const laptop = device(srv, owner, 'owner_laptop');
    const { document } = await createEncrypted(laptop);
    const path = `/api/e2ee/projects/${document.projectId}/blobs?tag=${'a'.repeat(64)}`;
    expect((await srv.call('GET', path)).status).toBe(503);
    db.exec(
      readFileSync(
        new URL(
          '../apps/web/migrations/0034_e2ee_content_blobs.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ['Date'] });
    expect((await srv.call('GET', path)).status).toBe(200);
  });
});

describe('migration 0034', () => {
  it('cascades blobs and references with their project', () => {
    const srv = server();
    const db = srv.db;
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at, storage_format)
       VALUES ('proj_m', ?, '', 'e2ee-v1', '2026-10-24T00:00:00.000Z', 2)`
    ).run(OWNER);
    db.prepare(
      `INSERT INTO e2ee_content_blobs
         (project_id, blob_id, kind, object_key, ciphertext_bytes, state, created_at)
       VALUES ('proj_m', ?, 'import-source', 'k', 10, 'committed', 'now')`
    ).run('d'.repeat(32));
    // A reference to a blob that is not committed is refused.
    expect(() =>
      db
        .prepare(
          `INSERT INTO e2ee_version_blobs (project_id, version_hash, blob_id)
           VALUES ('proj_m', ?, ?)`
        )
        .run('0'.repeat(64), 'e'.repeat(32))
    ).toThrow(/E2EE_BLOB_UNKNOWN/);
    db.prepare(
      `INSERT INTO e2ee_version_blobs (project_id, version_hash, blob_id)
       VALUES ('proj_m', ?, ?)`
    ).run('0'.repeat(64), 'd'.repeat(32));
    expect(() =>
      db.prepare('UPDATE e2ee_content_blobs SET ciphertext_bytes = 11').run()
    ).toThrow(/E2EE_BLOB_IMMUTABLE/);
    expect(
      db
        .prepare(
          'SELECT finalized_bytes FROM artifact_account_usage WHERE owner_user_id = ?'
        )
        .get(OWNER)
    ).toEqual({ finalized_bytes: 10 });
    db.prepare("DELETE FROM projects WHERE id = 'proj_m'").run();
    for (const table of ['e2ee_content_blobs', 'e2ee_version_blobs']) {
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(),
        table
      ).toEqual({ n: 0 });
    }
  });
});
