/**
 * Encrypted document versions (ADR-024 Phase 4, slice 4-5): Node devices of
 * one owner run the real client modules (`encryptedProjectStore.ts`,
 * `projectGroups.ts`) with the in-process MLS engine against the real
 * Worker routes over SQLite, with every migration applied unless a case
 * says otherwise.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EnvelopeKey,
  authorCutoffKey,
  encodeEncryptedDocumentBody,
  decodeKeyArchiveBody,
  encodeKeyArchiveBody,
  decryptProjectEnvelope,
  encryptProjectEnvelope,
  epochBinding,
  fromHex,
  fromBase64Url,
  parseEnvelope,
  signProjectEnvelope,
  signRevocationCutoffs,
  verifyRevocationCutoffs,
  shareLinkSetCommitment,
  toBase64Url,
  toHex,
  versionHash,
  wrapKey,
  unwrapKey,
  type ProjectEnvelopeHeaderInit,
  type ProjectEnvelopeHeader
} from '@openzcad/crypto';
import { encodeEnvelopePrefix } from '../packages/crypto/src/header';
import {
  E2EE_FRAME_CONTENT_TYPE,
  encodeE2eeFrame,
  MAX_PROJECT_REVISIONS,
  MAX_E2EE_FRAME_METADATA_BYTES,
  type E2eeVersionUpload,
  type ProjectDocument
} from '@openzcad/shared';
import { ApiError } from '../apps/web/src/lib/api';
import { EncryptedProjectIntegrityError } from '../apps/web/src/lib/e2ee/encryptedProjectStore';
import {
  epochAuthenticatorForEpoch,
  epochAuthority,
  commitProjectGroup,
  joinProjectGroup,
  projectKeyForEpoch
} from '../apps/web/src/lib/e2ee/projectGroups';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  OTHER,
  OWNER,
  count,
  createEncrypted,
  databaseBefore,
  device,
  edited,
  initialDocument,
  makeAccount,
  newServer,
  reload,
  rows,
  type Account,
  type Device,
  type Server
} from './support/e2ee-documents';

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

afterEach(() => {
  forgetAllProjectKeys();
  vi.useRealTimers();
});

const server = () => newServer([owner, other]);

async function integrityRefusal(
  promise: Promise<unknown>,
  reason: EncryptedProjectIntegrityError['reason']
) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof EncryptedProjectIntegrityError &&
      error.reason === reason &&
      error.status === 503
  );
}

async function apiRefusal(
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

describe('encrypted documents', () => {
  it('creates, reloads on another device, saves there and reads it back', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const created = await createEncrypted(laptop);
    const projectId = created.document.projectId;
    expect(created.project).toMatchObject({
      projectId,
      name: 'Bracket',
      storageFormat: 2
    });
    // The account holds ciphertext only: no name, a fixed marker.
    expect(
      rows(
        srv,
        'SELECT name, document_json, storage_format, document_version FROM projects WHERE id = ?',
        projectId
      )
    ).toEqual([
      {
        name: '',
        document_json: 'e2ee-v1',
        storage_format: 2,
        document_version: created.document.version
      }
    ]);
    expect(count(srv, 'e2ee_project_versions', projectId)).toBe(1);
    expect(count(srv, 'e2ee_project_envelopes', projectId)).toBe(1);
    expect(count(srv, 'e2ee_project_groups', projectId)).toBe(1);
    const stored = JSON.stringify(
      rows(srv, 'SELECT * FROM e2ee_project_versions')
    );
    expect(stored).not.toContain('Bracket');

    // A second device reads it through the account-key wrap.
    const desktop = device(srv, owner, 'owner_desktop');
    const loaded = await desktop.store.loadProject(projectId);
    expect(loaded.name).toBe('Bracket');
    expect(loaded.version).toBe(created.document.version);

    // It saves there: it joins the group first (epoch 1) and writes under it.
    const next = edited(loaded, 'Bracket v2');
    const saved = await desktop.store.saveProjectDocument({
      projectId,
      expectedVersion: loaded.version,
      document: next
    });
    expect(saved.version).toBe(next.version);
    expect(
      rows(
        srv,
        'SELECT key_epoch FROM e2ee_project_versions WHERE project_id = ? ORDER BY document_version',
        projectId
      )
    ).toEqual([{ key_epoch: 0 }, { key_epoch: 1 }]);

    // The laptop, reloaded, verifies the log from its pin and opens it.
    const again = reload(srv, laptop);
    const reread = await again.store.loadProject(projectId);
    expect(reread).toMatchObject({ name: 'Bracket v2', version: next.version });
    expect(await again.pins.read(OWNER, projectId)).toMatchObject({
      documentVersion: next.version,
      keyEpoch: 1
    });
    // The project info followed the name.
    const listing = (await (await srv.call('GET', '/api/projects')).json()) as {
      projects: { projectId: string; name: string; storageFormat?: number }[];
      encryptedProjectInfo: Parameters<Device['store']['projectName']>[0][];
    };
    expect(
      listing.projects.find((p) => p.projectId === projectId)
    ).toMatchObject({
      storageFormat: 2,
      name: 'Encrypted project'
    });
    const info = listing.encryptedProjectInfo.find(
      (i) => i.projectId === projectId
    )!;
    expect(info.sequence).toBe(2);
    expect(await again.store.projectName(info)).toBe('Bracket v2');
  });
});

// --- Helpers ---------------------------------------------------------------

const FRAME = E2EE_FRAME_CONTENT_TYPE;

interface Hand {
  envelope: Uint8Array;
  hash: string;
  upload: E2eeVersionUpload;
}

/**
 * A version built by hand, the way a device (or a hostile one) could:
 * any header over any plaintext, signed by `signer`.
 */
async function handVersion(
  d: Device,
  projectId: string,
  init: Partial<ProjectEnvelopeHeaderInit> & {
    documentVersion: number;
    keyEpoch: number;
    previousVersionHash: Uint8Array | null;
  },
  options: {
    expectedVersion: number;
    document?: ProjectDocument;
    plaintext?: Uint8Array;
    signer?: string;
  }
): Promise<Hand> {
  const projectKey = await projectKeyForEpoch(
    d.groups,
    projectId,
    init.keyEpoch
  );
  const authenticator = await epochAuthenticatorForEpoch(
    d.groups,
    projectId,
    init.keyEpoch
  );
  const header: ProjectEnvelopeHeaderInit = {
    kind: 'document',
    projectId,
    epochBindingHash: await epochBinding(
      projectId,
      init.keyEpoch,
      authenticator
    ),
    schemaVersion: 1,
    ...(!init.kind || init.kind === 'document'
      ? { shareLinkSetHash: await shareLinkSetCommitment() }
      : {}),
    ...init
  };
  const plaintext =
    options.plaintext ??
    encodeEncryptedDocumentBody(
      {
        document: {
          ...(options.document as unknown as Record<string, unknown>),
          version: init.documentVersion
        },
        blobs: [],
        revisionVersionHashes: new Map()
      },
      header
    );
  const key = EnvelopeKey.generate();
  const envelope = await encryptProjectEnvelope(key, header, plaintext);
  const hash = toHex(await versionHash(envelope));
  const signerId = options.signer ?? d.deviceId!;
  return {
    envelope,
    hash,
    upload: {
      expectedVersion: options.expectedVersion,
      signature: toBase64Url(
        await signProjectEnvelope(
          d.account.devices.get(signerId)!.signing.privateKey,
          envelope
        )
      ),
      wrappedVersionKey: toBase64Url(
        await wrapKey(projectKey, key.bytes, {
          purpose: 'version-key',
          projectId,
          keyEpoch: init.keyEpoch,
          kind: header.kind,
          versionId: hash
        })
      ),
      signerDeviceId: signerId
    }
  };
}

function putVersion(
  srv: Server,
  projectId: string,
  hand: Pick<Hand, 'envelope' | 'upload'>,
  user = OWNER
) {
  return srv.call('PUT', `/api/e2ee/projects/${projectId}/document`, {
    user,
    raw: encodeE2eeFrame({ version: hand.upload }, hand.envelope),
    contentType: FRAME
  });
}

/** The account's rows as they stand, to put back later (a rollback). */
function snapshot(srv: Server, projectId: string) {
  const project = srv.db
    .prepare('SELECT document_version FROM projects WHERE id = ?')
    .get(projectId) as { document_version: number };
  const versions = rows<Record<string, unknown>>(
    srv,
    'SELECT * FROM e2ee_project_versions WHERE project_id = ?',
    projectId
  );
  return () => {
    srv.db.exec('DROP TRIGGER IF EXISTS e2ee_project_version_immutable');
    srv.db
      .prepare('DELETE FROM e2ee_project_versions WHERE project_id = ?')
      .run(projectId);
    for (const row of versions) {
      const columns = Object.keys(row);
      srv.db
        .prepare(
          `INSERT INTO e2ee_project_versions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
        )
        .run(...(Object.values(row) as (string | number | null)[]));
    }
    srv.db
      .prepare('UPDATE projects SET document_version = ? WHERE id = ?')
      .run(project.document_version, projectId);
  };
}

function headOf(srv: Server, projectId: string) {
  return rows<{ document_version: number; version_hash: string }>(
    srv,
    'SELECT document_version, version_hash FROM e2ee_project_versions WHERE project_id = ? ORDER BY document_version DESC LIMIT 1',
    projectId
  )[0]!;
}

function hashAt(srv: Server, projectId: string, version: number): string {
  return rows<{ version_hash: string }>(
    srv,
    'SELECT version_hash FROM e2ee_project_versions WHERE project_id = ? AND document_version = ?',
    projectId,
    version
  )[0]!.version_hash;
}

async function save(
  d: Device,
  document: ProjectDocument,
  expectedVersion: number
) {
  await d.store.saveProjectDocument({
    projectId: document.projectId,
    expectedVersion,
    document
  });
  return document;
}

// --- Version integrity ------------------------------------------------------

it('paginates large signed prefixes below the document frame metadata ceiling', async () => {
  const srv = server();
  const laptop = device(srv, owner, 'owner_laptop');
  const { document } = await createEncrypted(laptop);
  const projectId = document.projectId;
  const initial = await laptop.documents.loadDocument(projectId);
  const originalHeader = parseEnvelope(initial.envelope)
    .header as ProjectEnvelopeHeader;
  const columns = (
    srv.db.prepare("PRAGMA table_info('e2ee_project_versions')").all() as {
      name: string;
    }[]
  ).map((column) => column.name);
  const selected = columns
    .map((name) =>
      ['document_version', 'version_hash', 'prefix', 'signer_user_id'].includes(
        name
      )
        ? '?'
        : name
    )
    .join(', ');
  const insert = srv.db
    .prepare(`INSERT INTO e2ee_project_versions (${columns.join(', ')})
    SELECT ${selected} FROM e2ee_project_versions WHERE project_id = ? AND document_version = ?`);
  const blobIds = Array.from(
    { length: 4096 },
    (_, index) => `blob_${String(index).padStart(4, '0')}_${'x'.repeat(112)}`
  );
  // Storage framing is independent of signature verification. These log-only
  // fixtures use maximal legal blob-reference lists to exercise its byte cap.
  for (let index = 1; index <= 20; index++)
    insert.run(
      document.version + index,
      index.toString(16).padStart(64, '0'),
      toBase64Url(
        encodeEnvelopePrefix({
          ...originalHeader,
          documentVersion: document.version + index,
          blobIds
        })
      ),
      OTHER,
      projectId,
      document.version
    );
  srv.db
    .prepare('UPDATE projects SET document_version = ? WHERE id = ?')
    .run(document.version + 20, projectId);
  const loaded = await laptop.documents.loadDocument(projectId);
  expect(loaded.metadata.more).toBe(true);
  expect(encodeE2eeFrame(loaded.metadata).length).toBeLessThan(
    MAX_E2EE_FRAME_METADATA_BYTES
  );
  const log = [...loaded.metadata.log];
  let more = loaded.metadata.more;
  while (more) {
    const page = await laptop.documents.versions(
      projectId,
      log.at(-1)!.documentVersion
    );
    expect(page.log[0]!.versionHash).toBe(log.at(-1)!.versionHash);
    expect(page.log.length).toBeGreaterThan(1);
    expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThan(
      MAX_E2EE_FRAME_METADATA_BYTES
    );
    log.push(...page.log.slice(1));
    more = page.more;
  }
  expect(log).toHaveLength(21);
  expect(() => encodeE2eeFrame({ ...loaded.metadata, log })).toThrow(
    /metadata is too large/
  );
});

it('bounds a fresh-read baseline to the captured head while an owner save races', async () => {
  const srv = server();
  const laptop = device(srv, owner, 'owner_laptop');
  const { document } = await createEncrypted(laptop);
  const projectId = document.projectId;
  const next = await handVersion(
    laptop,
    projectId,
    {
      documentVersion: document.version + 1,
      keyEpoch: 0,
      previousVersionHash: fromHex(headOf(srv, projectId).version_hash)
    },
    { expectedVersion: document.version, document }
  );
  const push = srv.statements.push.bind(srv.statements);
  let raced = false;
  srv.statements.push = (...sql: string[]) => {
    if (
      sql.some((statement) =>
        statement.includes('SELECT MAX(v.document_version) AS version')
      )
    ) {
      srv.statements.push = push;
      raced = true;
      srv.db
        .prepare(
          `INSERT INTO e2ee_project_versions
        (project_id, document_version, version_hash, key_epoch, prefix, signature,
         signer_user_id, signer_device_id, envelope_inline, envelope_bytes, wrapped_version_key, created_at)
        VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'now')`
        )
        .run(
          projectId,
          document.version + 1,
          next.hash,
          toBase64Url(parseEnvelope(next.envelope).prefix),
          next.upload.signature,
          OWNER,
          next.upload.signerDeviceId,
          toBase64Url(next.envelope),
          next.envelope.length,
          next.upload.wrappedVersionKey
        );
      srv.db
        .prepare('UPDATE projects SET document_version = ? WHERE id = ?')
        .run(document.version + 1, projectId);
    }
    return push(...sql);
  };
  const loaded = await laptop.documents.loadDocument(projectId);
  expect(raced).toBe(true);
  expect(loaded.metadata.head.documentVersion).toBe(document.version);
  expect(loaded.metadata.log.at(-1)?.versionHash).toBe(
    loaded.metadata.head.versionHash
  );
});

it('opens a pinned history whose signed prefixes exceed one verifier byte window', async () => {
  const srv = server();
  const laptop = device(srv, owner, 'owner_laptop');
  const { document } = await createEncrypted(laptop);
  const projectId = document.projectId;
  const blobIds = Array.from(
    { length: 4096 },
    (_, index) => `blob_${String(index).padStart(4, '0')}_${'x'.repeat(112)}`
  );
  let previous = headOf(srv, projectId).version_hash;
  let prefixBytes = 0;
  // These retained, authentically signed log records no longer need bodies.
  // Only the final head is decrypted; its document has no imported assets.
  for (let index = 1; index <= 141; index++) {
    const hand = await handVersion(
      laptop,
      projectId,
      {
        documentVersion: document.version + index,
        keyEpoch: 0,
        previousVersionHash: fromHex(previous),
        blobIds: index === 141 ? [] : blobIds
      },
      {
        expectedVersion: document.version + index - 1,
        document,
        ...(index === 141 ? {} : { plaintext: new Uint8Array() })
      }
    );
    const prefix = parseEnvelope(hand.envelope).prefix;
    prefixBytes += prefix.length;
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_versions
      (project_id, document_version, version_hash, key_epoch, prefix, signature,
       signer_user_id, signer_device_id, envelope_inline, envelope_bytes,
       wrapped_version_key, created_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, 'owner_laptop', ?, ?, ?, '2026-10-24T00:00:00.000Z')`
      )
      .run(
        projectId,
        document.version + index,
        hand.hash,
        toBase64Url(prefix),
        hand.upload.signature,
        OWNER,
        index === 141 ? toBase64Url(hand.envelope) : null,
        hand.envelope.length,
        hand.upload.wrappedVersionKey
      );
    previous = hand.hash;
  }
  expect(prefixBytes).toBeGreaterThan(64 * 1024 * 1024);
  srv.db
    .prepare('UPDATE projects SET document_version = ? WHERE id = ?')
    .run(document.version + 141, projectId);
  const page = reload(srv, laptop);
  const loaded = await page.store.loadProject(projectId);
  expect(loaded.version).toBe(document.version + 141);
  expect((await page.pins.read(OWNER, projectId))?.headHash).toBe(previous);
}, 120_000);

describe('version integrity', () => {
  it.each(['head', 'intermediate'] as const)(
    'refuses a certified never-joined device in the %s despite its valid registry certification',
    async (position) => {
      const srv = server();
      const laptop = device(srv, owner, 'owner_laptop');
      const { document } = await createEncrypted(laptop);
      const projectId = document.projectId;
      const coldReader = device(srv, owner, null);
      await coldReader.store.loadProject(projectId);
      const outsider = device(srv, owner, 'owner_desktop');
      const ref = { userId: OWNER, deviceId: 'owner_desktop', projectId };
      await outsider.sessions.keyPackage(
        ref,
        owner.devices.get('owner_desktop')!,
        0
      );
      const leaf = (await outsider.sessions.leaf(ref))!;
      srv.db
        .prepare(
          `INSERT INTO e2ee_project_leaves
      (project_id,user_id,device_id,leaf_key,certification,created_at) VALUES (?,?,?,?,?,?)`
        )
        .run(
          projectId,
          OWNER,
          'owner_desktop',
          toBase64Url(leaf.signatureKey),
          toBase64Url(leaf.certification),
          new Date().toISOString()
        );
      const forged = await handVersion(
        outsider,
        projectId,
        {
          documentVersion: 2,
          keyEpoch: 0,
          previousVersionHash: fromHex(headOf(srv, projectId).version_hash)
        },
        { expectedVersion: 1, document: edited(document, 'Never joined') }
      );
      expect((await putVersion(srv, projectId, forged)).status).toBe(200);
      if (position === 'intermediate') {
        const later = await handVersion(
          laptop,
          projectId,
          {
            documentVersion: 3,
            keyEpoch: 0,
            previousVersionHash: fromHex(forged.hash)
          },
          {
            expectedVersion: 2,
            document: edited(document, 'Valid signer after invalid author')
          }
        );
        expect((await putVersion(srv, projectId, later)).status).toBe(200);
      }
      expect(coldReader.sessions.cachedSessions).toBe(0);
      await integrityRefusal(
        coldReader.store.loadProject(projectId),
        'authority'
      );
      expect(coldReader.sessions.cachedSessions).toBe(0);
    }
  );

  it('refuses an active certified device after its MLS leaf was removed', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document } = await createEncrypted(laptop);
    const projectId = document.projectId;
    const desktop = device(srv, owner, 'owner_desktop');
    await joinProjectGroup(desktop.groups, projectId);
    const ref = { userId: OWNER, deviceId: 'owner_laptop', projectId };
    await joinProjectGroup(laptop.groups, projectId);
    const removed = (await laptop.sessions.status(ref)).members.find(
      (member) => member.deviceId === 'owner_desktop'
    )!;
    const state = await commitProjectGroup(laptop.groups, projectId, {
      remove: [removed.index]
    });
    expect(
      (
        await epochAuthority(laptop.groups, projectId, state.keyEpoch)
      ).members.some((member) => member.deviceId === 'owner_desktop')
    ).toBe(false);
    const forged = await handVersion(
      desktop,
      projectId,
      {
        documentVersion: 2,
        keyEpoch: state.keyEpoch,
        previousVersionHash: fromHex(headOf(srv, projectId).version_hash)
      },
      { expectedVersion: 1, document: edited(document, 'Removed leaf') }
    );
    expect((await putVersion(srv, projectId, forged)).status).toBe(200);
    await integrityRefusal(
      device(srv, owner, null).store.loadProject(projectId),
      'authority'
    );
  });

  it('refuses a correctly encrypted and signed archive with a substituted MLS tree', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document } = await createEncrypted(laptop);
    const projectId = document.projectId;
    const shadow = device(srv, owner, 'owner_desktop');
    const ref = { userId: OWNER, deviceId: 'owner_desktop', projectId };
    const fake = await shadow.sessions.createGroup(
      ref,
      owner.devices.get('owner_desktop')!,
      { lists: [owner.list], certifications: [] }
    );
    const archived = (
      await laptop.groups.api.archives(projectId, { keyEpoch: 0 })
    ).archives[0]!;
    const projectKey = await projectKeyForEpoch(laptop.groups, projectId, 0);
    const context = {
      purpose: 'version-key' as const,
      projectId,
      keyEpoch: 0,
      kind: 'key-archive' as const,
      versionId: 'key-archive:0'
    };
    const oldKey = await unwrapKey(
      projectKey,
      fromBase64Url(archived.wrappedVersionKey),
      context
    );
    const opened = await decryptProjectEnvelope(
      oldKey,
      fromBase64Url(archived.envelope)
    );
    const body = decodeKeyArchiveBody(opened.plaintext, opened.header);
    const header = { ...opened.header };
    const replacement = EnvelopeKey.generate();
    const envelope = await encryptProjectEnvelope(
      replacement,
      header,
      encodeKeyArchiveBody({ ...body, epochRecord: fake.epochRecord! }, header)
    );
    const signer = owner.devices.get('owner_desktop')!;
    srv.db
      .prepare(
        `UPDATE e2ee_key_archives SET envelope=?,wrapped_version_key=?,signature=?,signer_device_id=? WHERE project_id=? AND key_epoch=0`
      )
      .run(
        toBase64Url(envelope),
        toBase64Url(await wrapKey(projectKey, replacement.bytes, context)),
        toBase64Url(
          await signProjectEnvelope(signer.signing.privateKey, envelope)
        ),
        signer.deviceId,
        projectId
      );
    await expect(
      epochAuthority(device(srv, owner, null).groups, projectId, 0)
    ).rejects.toMatchObject({ code: 'archive-invalid' });
  });

  it('refuses a rolled-back head and keeps its pin', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    const projectId = v1.projectId;
    const v2 = await save(laptop, edited(v1, 'Two'), v1.version);
    const atV2 = snapshot(srv, projectId);
    const v3 = await save(laptop, edited(v2, 'Three'), v2.version);
    const pinned = await laptop.pins.read(OWNER, projectId);
    expect(pinned?.documentVersion).toBe(v3.version);

    // The account rolls back to version 2: a valid, signed, older head.
    atV2();
    const fresh = reload(srv, laptop);
    await integrityRefusal(fresh.store.loadProject(projectId), 'rollback');
    expect(await fresh.pins.read(OWNER, projectId)).toEqual(pinned);
    // A browser that never saw version 3 cannot tell (fork consistency).
    const stranger = device(srv, owner, 'owner_desktop');
    await expect(stranger.store.loadProject(projectId)).resolves.toMatchObject({
      name: 'Two'
    });
  });

  it('reports a forked log', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    const projectId = v1.projectId;
    const atV1 = snapshot(srv, projectId);
    await save(laptop, edited(v1, 'Laptop'), v1.version);

    // The account forks: it shows the desktop version 1 and accepts its own
    // version 2 there, a different branch at the laptop's pinned number.
    atV1();
    const desktop = device(srv, owner, 'owner_desktop');
    const fork = await desktop.store.loadProject(projectId);
    const forked = await save(desktop, edited(fork, 'Desktop'), fork.version);
    await integrityRefusal(
      reload(srv, laptop).store.loadProject(projectId),
      'fork'
    );
    // A forked history that runs past the pinned version is refused too.
    await save(desktop, edited(forked), forked.version);
    await integrityRefusal(
      reload(srv, laptop).store.loadProject(projectId),
      'fork'
    );
  });

  it('refuses a head under an old epoch at the server and in the browser', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    const projectId = v1.projectId;
    // The desktop joins (epoch 1) and saves under it.
    const desktop = device(srv, owner, 'owner_desktop');
    const loaded = await desktop.store.loadProject(projectId);
    const v2 = await save(desktop, edited(loaded, 'Epoch one'), loaded.version);
    const head = headOf(srv, projectId);

    // The laptop, offline meanwhile, signs version 3 under epoch 0.
    const stale = await handVersion(
      laptop,
      projectId,
      {
        documentVersion: v2.version + 1,
        keyEpoch: 0,
        previousVersionHash: fromHex(head.version_hash)
      },
      { expectedVersion: v2.version, document: v2 }
    );
    const refused = await putVersion(srv, projectId, stale);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: 'E2EE_EPOCH_STALE',
      keyEpoch: 1
    });
    expect(headOf(srv, projectId).version_hash).toBe(head.version_hash);

    // A server that stored it anyway: the browser that pinned epoch 1 refuses.
    await reload(srv, laptop).store.loadProject(projectId);
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_versions
           (project_id, document_version, version_hash, key_epoch, prefix, signature,
            signer_user_id, signer_device_id, envelope_inline, envelope_bytes,
            wrapped_version_key, created_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, 'owner_laptop', ?, ?, ?, '2026-10-24T00:00:00.000Z')`
      )
      .run(
        projectId,
        v2.version + 1,
        stale.hash,
        toBase64Url(parseEnvelope(stale.envelope).prefix),
        stale.upload.signature,
        OWNER,
        toBase64Url(stale.envelope),
        stale.envelope.byteLength,
        stale.upload.wrappedVersionKey
      );
    srv.db
      .prepare('UPDATE projects SET document_version = ? WHERE id = ?')
      .run(v2.version + 1, projectId);
    await integrityRefusal(
      reload(srv, laptop).store.loadProject(projectId),
      'epoch'
    );
  });

  it('reads a revision without moving the pin and refuses one outside the pinned history', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    const projectId = v1.projectId;
    const named = await laptop.store.saveRevision({
      projectId,
      reason: '  Before the fillet  ',
      expectedVersion: v1.version,
      document: edited(v1, 'Named')
    });
    const revisionId = named.revisions.at(-1)!.revisionId;
    const later = await save(laptop, edited(named, 'Later'), named.version);
    const pin = await laptop.pins.read(OWNER, projectId);
    expect(pin?.documentVersion).toBe(later.version);

    const listed = await laptop.store.listRevisions(projectId);
    expect(listed.revisions).toEqual([
      expect.objectContaining({ revisionId, reason: 'Before the fillet' })
    ]);
    // On a reloaded page too: the pinned head's body proves the revision.
    const page = reload(srv, laptop);
    const opened = await page.store.loadRevision(projectId, revisionId);
    expect(opened).toMatchObject({ name: 'Named', version: named.version });
    expect(await page.pins.read(OWNER, projectId)).toEqual(pin);
    // A save state the account no longer keeps reads as null.
    expect(await page.store.loadRevision(projectId, 'rev_missing')).toBeNull();

    // The account points the revision at version 1, whose body it fakes back.
    srv.db.exec('DROP TRIGGER e2ee_project_version_immutable');
    srv.db
      .prepare(
        `UPDATE e2ee_project_versions SET envelope_inline = (
           SELECT envelope_inline FROM e2ee_project_versions
           WHERE project_id = ? AND document_version = ?)
         WHERE project_id = ? AND document_version = ?`
      )
      .run(projectId, later.version, projectId, v1.version);
    srv.db
      .prepare(
        `UPDATE e2ee_project_revisions SET document_version = ?, version_hash = ?
         WHERE project_id = ? AND revision_id = ?`
      )
      .run(
        v1.version,
        hashAt(srv, projectId, v1.version),
        projectId,
        revisionId
      );
    await integrityRefusal(
      page.store.loadRevision(projectId, revisionId),
      'history'
    );
    expect(await page.pins.read(OWNER, projectId)).toEqual(pin);
  });

  it('keeps a named save loadable after a reload and the next autosave', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    const projectId = v1.projectId;
    const named = await laptop.store.saveRevision({
      projectId,
      reason: 'Before the change',
      expectedVersion: v1.version,
      document: v1
    });
    const revisionId = named.revisions.at(-1)!.revisionId;
    // Reloaded: the head is the named save, whose own body cannot name its
    // own hash in the signed revision map.
    const page = reload(srv, laptop);
    const head = await page.store.loadProject(projectId);
    expect(head.version).toBe(named.version);
    await save(page, edited(head, 'After the change'), head.version);
    // The autosave built on that head still names the save state.
    expect(
      (await page.store.loadRevision(projectId, revisionId))?.version
    ).toBe(named.version);
    // So does a browser that never saw the named save as the head.
    const desktop = device(srv, owner, 'owner_desktop');
    await desktop.store.loadProject(projectId);
    expect(
      (await desktop.store.loadRevision(projectId, revisionId))?.version
    ).toBe(named.version);
  });

  it('refuses a revoked author outside its cutoff', async () => {
    const account = await makeAccount('user_revoking', ['dev_a', 'dev_b']);
    const srv = newServer([account]);
    const a = device(srv, account, 'dev_a');
    const { document: v1 } = await createEncrypted(a);
    const projectId = v1.projectId;
    const b = device(srv, account, 'dev_b');
    const first = await b.store.loadProject(projectId);
    const v2 = await save(b, edited(first, 'B two'), first.version);
    const v2hash = headOf(srv, projectId).version_hash;
    const v3 = await save(b, edited(v2, 'B three'), v2.version);
    const v3hash = headOf(srv, projectId).version_hash;

    // A revocation cutoff attests the state the revoking browser accepted.
    await a.store.loadProject(projectId);

    await account.revoke(srv.db, 'dev_b');
    const entry = account.list.entries.at(-1)!;
    const revocation = await verifyRevocationCutoffs(
      await signRevocationCutoffs(account.identityPrivateKey, {
        userId: account.userId,
        generation: 1,
        entrySequence: entry.entry.sequence,
        entryHash: entry.hash,
        issuedAt: Date.now(),
        cutoffs: [
          {
            projectId,
            cutoffEpoch: 2,
            head: { documentVersion: v3.version, versionHash: fromHex(v3hash) }
          }
        ]
      }),
      account.list,
      { generation: 1 }
    );
    const cutoffAt = (version: number, hash: string) =>
      new Map([
        [
          authorCutoffKey(account.userId, 'dev_b'),
          { documentVersion: version, versionHash: fromHex(hash) }
        ]
      ]);
    // No cutoff recorded: refused.
    await integrityRefusal(
      device(srv, account, 'dev_a').store.loadProject(projectId),
      'author'
    );
    // A cutoff at version 2: the head, version 3, is outside it.
    await integrityRefusal(
      device(srv, account, 'dev_a', {
        cutoffs: cutoffAt(v2.version, v2hash)
      }).store.loadProject(projectId),
      'author'
    );
    // A cutoff at version 3 accepts it.
    const trusting = reload(srv, a, {
      cutoffs: cutoffAt(v3.version, v3hash),
      revocations: { verified: async () => [revocation] }
    });
    await expect(trusting.store.loadProject(projectId)).resolves.toMatchObject({
      name: 'B three'
    });
    // The revoked device can no longer write at all.
    const late = await handVersion(
      b,
      projectId,
      {
        documentVersion: v3.version + 1,
        keyEpoch: 1,
        previousVersionHash: fromHex(v3hash)
      },
      { expectedVersion: v3.version, document: v3 }
    );
    const refused = await putVersion(srv, projectId, late, account.userId);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      code: 'E2EE_DEVICE_NOT_CERTIFIED'
    });
  });

  it('refuses a version whose signer’s device list changed while it was written', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    // The device list moves on (a removal, say) after the signer was checked
    // and before the version lands.
    const push = srv.statements.push.bind(srv.statements);
    srv.statements.push = (...sql: string[]) => {
      if (sql.some((s) => /^\s*UPDATE projects SET document_version/.test(s))) {
        srv.statements.push = push;
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
      return push(...sql);
    };
    await expect(
      save(laptop, edited(v1, 'Two'), v1.version)
    ).rejects.toMatchObject({ code: 'E2EE_DEVICE_LIST_CHANGED' });
    expect(headOf(srv, v1.projectId).document_version).toBe(v1.version);
  });

  it('warns a fresh browser that the head trails the account activity', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop', {
      now: () => Date.parse('2026-10-24T00:00:00.000Z')
    });
    const { document } = await createEncrypted(laptop);
    srv.db
      .prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
      .run('2026-10-25T00:00:00.000Z', document.projectId);
    const fresh = device(srv, owner, 'owner_desktop');
    await fresh.store.loadProject(document.projectId);
    expect(fresh.warnings).toEqual([
      expect.objectContaining({
        kind: 'stale-head',
        projectId: document.projectId
      })
    ]);
    // A browser with a pin trusts its own history instead.
    const pinned = reload(srv, laptop);
    await pinned.store.loadProject(document.projectId);
    expect(pinned.warnings).toEqual([]);
  });
});

// --- Writes ----------------------------------------------------------------

describe('writes', () => {
  it('answers 409 to a stale autosave and keeps the newer head', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    const projectId = v1.projectId;
    const desktop = device(srv, owner, 'owner_desktop');
    const stale = await desktop.store.loadProject(projectId);
    await save(laptop, edited(v1, 'Laptop wins'), v1.version);
    const head = headOf(srv, projectId);

    await expect(
      desktop.store.saveProjectDocument({
        projectId,
        expectedVersion: stale.version,
        document: edited(stale, 'Desktop late')
      })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'REVISION_CONFLICT' &&
        error.details?.currentVersion === head.document_version
    );
    expect(headOf(srv, projectId)).toEqual(head);
    // A write that names the head's version but builds on another head.
    const sibling = await handVersion(
      laptop,
      projectId,
      {
        documentVersion: head.document_version + 1,
        keyEpoch: 0,
        previousVersionHash: fromHex(hashAt(srv, projectId, v1.version))
      },
      { expectedVersion: head.document_version, document: v1 }
    );
    const response = await putVersion(srv, projectId, sibling);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'E2EE_HEAD_MISMATCH' });
    expect(headOf(srv, projectId)).toEqual(head);
  });

  it('creates a project the Worker does not know yet, and retries a failed create cleanly', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const document = initialDocument('Retry');
    const projectId = document.projectId;
    const ref = { userId: OWNER, deviceId: 'owner_laptop', projectId };
    // The upload never reaches the Worker: the project, its group and its
    // first version are written together or not at all.
    laptop.before = async (path, init) => {
      if (path === '/api/e2ee/projects' && init.method === 'POST') {
        throw new TypeError('Failed to fetch');
      }
    };
    await expect(
      laptop.store.createProject({ name: 'Retry', initialDocument: document })
    ).rejects.toThrow();
    expect(count(srv, 'e2ee_project_groups', projectId)).toBe(0);
    // The group this device built for the failed create is gone, so the
    // retry builds a fresh one instead of tripping over the old state.
    expect(await laptop.sessions.leaf(ref)).toBeNull();

    laptop.before = undefined;
    const created = await laptop.store.createProject({
      name: 'Retry',
      initialDocument: document
    });
    expect(created.project).toMatchObject({ projectId, storageFormat: 2 });
    expect(count(srv, 'e2ee_project_groups', projectId)).toBe(1);
    const desktop = device(srv, owner, 'owner_desktop');
    expect((await desktop.store.loadProject(projectId)).name).toBe('Retry');
  });

  it('keeps the last good version through every refused write', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    const projectId = v1.projectId;
    const v2 = await save(laptop, edited(v1, 'Good'), v1.version);
    const head = headOf(srv, projectId);
    const previousVersionHash = fromHex(head.version_hash);
    const next = { expectedVersion: v2.version, document: v2 };
    const good = {
      documentVersion: v2.version + 1,
      keyEpoch: 0,
      previousVersionHash
    };
    const refusals: [string, Promise<Response>, number, string?][] = [];
    const attempt = async (
      label: string,
      hand: Promise<Pick<Hand, 'envelope' | 'upload'>>,
      status: number,
      code?: string
    ) =>
      refusals.push([
        label,
        putVersion(srv, projectId, await hand),
        status,
        code
      ]);

    await attempt(
      'not moving forward',
      handVersion(
        laptop,
        projectId,
        { ...good, documentVersion: v2.version },
        next
      ),
      400
    );
    await attempt(
      'another project',
      handVersion(
        laptop,
        projectId,
        { ...good, projectId: 'proj_other' },
        next
      ),
      400
    );
    await attempt(
      'another kind',
      handVersion(
        laptop,
        projectId,
        { ...good, kind: 'measurements' },
        { ...next, plaintext: new TextEncoder().encode('{}') }
      ),
      400
    );
    // Slice 4-6: a version may name only committed blobs of its project.
    await attempt(
      'an unknown content blob',
      handVersion(
        laptop,
        projectId,
        { ...good, blobIds: ['a'.repeat(32)] },
        { ...next, plaintext: new TextEncoder().encode('{}') }
      ),
      409,
      'E2EE_BLOB_UNKNOWN'
    );
    await attempt(
      'a malformed blob id',
      handVersion(
        laptop,
        projectId,
        { ...good, blobIds: ['blob_1'] },
        { ...next, plaintext: new TextEncoder().encode('{}') }
      ),
      400
    );
    await attempt(
      'no previous version',
      handVersion(
        laptop,
        projectId,
        { ...good, previousVersionHash: null },
        next
      ),
      400
    );
    await attempt(
      'signed by another device than named',
      handVersion(laptop, projectId, good, { ...next }).then((hand) => ({
        ...hand,
        upload: { ...hand.upload, signerDeviceId: 'owner_desktop' }
      })),
      400,
      'E2EE_SIGNATURE_INVALID'
    );
    await attempt(
      'a read-only device',
      handVersion(laptop, projectId, good, { ...next, signer: 'owner_tablet' }),
      403,
      'E2EE_DEVICE_NOT_CERTIFIED'
    );
    await attempt(
      'a valid version, last',
      handVersion(laptop, projectId, good, next),
      200
    );
    for (const [label, pending, status, code] of refusals.slice(0, -1)) {
      const response = await pending;
      expect(response.status, label).toBe(status);
      if (code) expect(await response.json(), label).toMatchObject({ code });
      expect(headOf(srv, projectId), label).toEqual(head);
    }
    // Garbage bodies.
    for (const raw of [
      new Uint8Array([0, 0]),
      encodeE2eeFrame(
        { version: { expectedVersion: v2.version } },
        new Uint8Array(10)
      ),
      encodeE2eeFrame('nope', new Uint8Array(0))
    ]) {
      const response = await srv.call(
        'PUT',
        `/api/e2ee/projects/${projectId}/document`,
        {
          raw,
          contentType: FRAME
        }
      );
      expect(response.status).toBe(400);
    }
    expect(headOf(srv, projectId)).toEqual(head);
    // The valid one at the end of the list lands, and the browser opens it.
    const last = await refusals.at(-1)![1];
    expect(last.status).toBe(200);
    await expect(
      reload(srv, laptop).store.loadProject(projectId)
    ).resolves.toMatchObject({
      name: 'Good',
      version: v2.version + 1
    });
  });

  it('refuses a save over the storage quota and keeps the head', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    const projectId = v1.projectId;
    const head = headOf(srv, projectId);
    srv.db
      .prepare(
        'UPDATE users SET project_storage_limit_bytes = 600 WHERE id = ?'
      )
      .run(OWNER);
    await apiRefusal(
      save(laptop, edited(v1, 'x'.repeat(150)), v1.version),
      413,
      'PROJECT_STORAGE_QUOTA'
    );
    expect(headOf(srv, projectId)).toEqual(head);
    srv.db
      .prepare(
        'UPDATE users SET project_storage_limit_bytes = 2147483648 WHERE id = ?'
      )
      .run(OWNER);
    await save(laptop, edited(v1, 'Fits'), v1.version);
  });

  it('refuses documents with imports, meshes or reference images before encrypting', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    const imported = {
      ...edited(v1),
      nodes: {
        ...v1.nodes,
        imported: { kind: 'feature', featureKind: 'imported-step' }
      }
    } as unknown as ProjectDocument;
    const withImage = {
      ...edited(v1),
      referenceImages: { images: [{ imageId: 'img_1' }] }
    } as unknown as ProjectDocument;
    const puts = srv.statements.length;
    for (const document of [imported, withImage]) {
      await expect(
        laptop.store.saveProjectDocument({
          projectId: v1.projectId,
          expectedVersion: v1.version,
          document
        })
      ).rejects.toMatchObject({ name: 'UnstorableDocumentError' });
    }
    expect(
      srv.statements
        .slice(puts)
        .some((sql) => /INSERT INTO e2ee_project_versions/.test(sql))
    ).toBe(false);
  });

  it('lets a read-only device read but not write (decision D4)', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    const tablet = device(srv, owner, null);
    const read = await tablet.store.loadProject(v1.projectId);
    expect(read.name).toBe('Bracket');
    await apiRefusal(
      save(tablet, edited(read), read.version),
      403,
      'E2EE_READ_ONLY_DEVICE'
    );
  });

  it('keeps bodies over the inline size in R2 and prunes replaced ones', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    const projectId = v1.projectId;
    // Random text does not compress: about 400 KiB of ciphertext.
    const noise = toBase64Url(crypto.getRandomValues(new Uint8Array(65_536)));
    const big = { ...edited(v1), name: 'Big' };
    (big as unknown as Record<string, unknown>).commandLog = Array.from(
      { length: 5 },
      (_, index) => ({
        kind: 'note',
        payload: { text: noise + index },
        replayVersion: 1,
        label: 'note'
      })
    );
    const saved = await save(laptop, big, v1.version);
    const keys = rows<{ envelope_key: string | null; envelope_bytes: number }>(
      srv,
      'SELECT envelope_key, envelope_bytes FROM e2ee_project_versions WHERE project_id = ? ORDER BY document_version',
      projectId
    );
    expect(keys.at(-1)!.envelope_key).toMatch(
      new RegExp(`^e2ee/${projectId}/v/[0-9a-f]{64}$`)
    );
    const key = keys.at(-1)!.envelope_key!;
    expect(srv.bucket.objects.has(key)).toBe(true);
    await expect(
      reload(srv, laptop).store.loadProject(projectId)
    ).resolves.toMatchObject({
      name: 'Big'
    });
    // The next autosave replaces it: the body leaves R2, the log row stays.
    await save(laptop, edited(v1, 'Small'), saved.version);
    expect(srv.bucket.objects.has(key)).toBe(false);
    expect(count(srv, 'e2ee_project_versions', projectId)).toBe(3);
  });

  it('never prunes a head another save committed while retention ran', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    const projectId = v1.projectId;
    const columns = (
      srv.db.prepare(`PRAGMA table_info('e2ee_project_versions')`).all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    const copied = columns
      .map((name) =>
        name === 'document_version'
          ? 'document_version + 1'
          : name === 'version_hash'
            ? `substr(version_hash, 2) || '0'`
            : name
      )
      .join(', ');
    // This save's retention reads its own head; another save commits the
    // next head before retention looks for bodies nothing retains.
    const push = srv.statements.push.bind(srv.statements);
    srv.statements.push = (...sql: string[]) => {
      if (
        sql.some((s) => s.includes('SELECT document_version, envelope_key'))
      ) {
        srv.statements.push = push;
        srv.db
          .prepare(
            `INSERT INTO e2ee_project_versions (${columns.join(', ')})
             SELECT ${copied} FROM e2ee_project_versions
             WHERE project_id = ? ORDER BY document_version DESC LIMIT 1`
          )
          .run(projectId);
        srv.db
          .prepare(
            'UPDATE projects SET document_version = document_version + 1 WHERE id = ?'
          )
          .run(projectId);
      }
      return push(...sql);
    };
    const v2 = await save(laptop, edited(v1, 'Two'), v1.version);
    const live = rows<{
      document_version: number;
      envelope_inline: string | null;
      envelope_key: string | null;
    }>(
      srv,
      `SELECT document_version, envelope_inline, envelope_key
       FROM e2ee_project_versions WHERE project_id = ?
       ORDER BY document_version DESC LIMIT 1`,
      projectId
    )[0]!;
    expect(live.document_version).toBe(v2.version + 1);
    expect(live.envelope_inline ?? live.envelope_key).not.toBeNull();
  });
});

// --- Access, retention, cleanup ---------------------------------------------

describe('access', () => {
  it('serves only the owner and members of a format-2 project with the flag on', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document } = await createEncrypted(laptop);
    const projectId = document.projectId;
    const paths = [
      ['GET', `/api/e2ee/projects/${projectId}/document`],
      ['GET', `/api/e2ee/projects/${projectId}/versions?since=1`],
      ['GET', `/api/e2ee/projects/${projectId}/revisions`],
      ['GET', `/api/e2ee/projects/${projectId}/revisions/rev_1`],
      ['GET', `/api/e2ee/projects/${projectId}/info`]
    ] as const;
    for (const [method, path] of paths) {
      const own = await srv.call(method, path);
      expect(await own.json().catch(() => ({})), path).not.toMatchObject({
        code: 'PROJECT_NOT_FOUND'
      });
      const stranger = await srv.call(method, path, { user: OTHER });
      expect(stranger.status, path).toBe(404);
      expect(await stranger.json(), path).toMatchObject({
        code: 'PROJECT_NOT_FOUND'
      });
    }
    // A member reads (slice 5-2); a viewer's write is refused.
    srv.db
      .prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, added_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'viewer', ?, 1, 1)`
      )
      .run(projectId, OTHER, OWNER);
    expect((await srv.call('GET', paths[0][1], { user: OTHER })).status).toBe(
      200
    );
    const viewerWrite = await srv.call(
      'PUT',
      `/api/e2ee/projects/${projectId}/document`,
      {
        user: OTHER,
        raw: new Uint8Array(8),
        contentType: 'application/octet-stream'
      }
    );
    expect(viewerWrite.status).toBe(403);
    expect(await viewerWrite.json()).toMatchObject({
      code: 'E2EE_PROJECT_READ_ONLY'
    });
    // Plaintext projects are not served here, and plaintext routes keep
    // refusing this one.
    const created = await srv.call('POST', '/api/projects', {
      body: { name: 'Plain', initialDocument: initialDocument('Plain') }
    });
    const plain = ((await created.json()) as { document: ProjectDocument })
      .document.projectId;
    expect(
      (await srv.call('GET', `/api/e2ee/projects/${plain}/document`)).status
    ).toBe(409);
    const refused = await srv.call('GET', `/api/projects/${projectId}`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: 'PROJECT_FORMAT_UNSUPPORTED'
    });
    // Plaintext writes keep refusing it too.
    expect(
      (
        await srv.call('PUT', `/api/projects/${projectId}/document`, {
          body: { projectId, expectedVersion: 1, document }
        })
      ).status
    ).toBe(409);
    // Unknown routes and methods.
    expect(
      (await srv.call('DELETE', `/api/e2ee/projects/${projectId}/document`))
        .status
    ).toBe(404);
    expect((await srv.call('GET', '/api/e2ee/projects')).status).toBe(404);
    // Flag off.
    const closed = newServer([owner, other], undefined, {
      E2EE_PROJECTS_ENABLED: 'false'
    });
    expect(
      (await closed.call('GET', `/api/e2ee/projects/${projectId}/document`))
        .status
    ).toBe(501);
    expect(
      (
        await closed.call('POST', '/api/e2ee/projects', {
          raw: encodeE2eeFrame({}),
          contentType: FRAME
        })
      ).status
    ).toBe(501);
  });

  it('creates through the encrypted route once the account opted in (D2)', async () => {
    const srv = server();
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_preferences
           (user_id, encrypt_new_projects, record, record_mac, sequence, updated_at)
         VALUES (?, 1, 'AA', ?, 1, ?)`
      )
      .run(OWNER, 'A'.repeat(43), '2026-10-24T00:00:00.000Z');
    const plain = await srv.call('POST', '/api/projects', {
      body: { name: 'Plain', initialDocument: initialDocument('Plain') }
    });
    expect(plain.status).toBe(409);
    expect(await plain.json()).toMatchObject({
      code: 'ENCRYPTED_PROJECTS_REQUIRED'
    });
    const laptop = device(srv, owner, 'owner_laptop');
    await expect(createEncrypted(laptop, 'Secret')).resolves.toMatchObject({
      project: { name: 'Secret', storageFormat: 2 }
    });
  });

  it('refuses an older project info than the browser saw', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop, 'First');
    const projectId = v1.projectId;
    const old = (await laptop.documents.info(projectId)).info!;
    await save(laptop, edited(v1, 'Second'), v1.version);
    const current = (await laptop.documents.info(projectId)).info!;
    expect(current.sequence).toBe(2);
    expect(await laptop.store.projectName(current)).toBe('Second');
    // The account replays the first one: refused once the second was seen.
    expect(await laptop.store.projectName(old)).toBeNull();
    // A tampered envelope or a foreign signer reads as no name.
    expect(
      await laptop.store.projectName({
        ...current,
        signerDeviceId: 'owner_tablet'
      })
    ).toBeNull();
    expect(
      await laptop.store.projectName({ ...current, projectId: 'proj_else' })
    ).toBeNull();
    // The server will not take an older sequence either.
    const replay = await srv.call(
      'PUT',
      `/api/e2ee/projects/${projectId}/info`,
      {
        body: {
          sequence: old.sequence,
          envelope: old.envelope,
          wrappedVersionKey: old.wrappedVersionKey,
          signature: old.signature,
          signerDeviceId: old.signerDeviceId
        }
      }
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      code: 'E2EE_SEQUENCE_CONFLICT'
    });
  });
});

describe('retention and cleanup', () => {
  it('keeps the newest revisions and their log rows, and prunes the rest', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    let { document } = await createEncrypted(laptop);
    const projectId = document.projectId;
    const total = MAX_PROJECT_REVISIONS + 2;
    for (let index = 0; index < total; index++) {
      document = await laptop.store.saveRevision({
        projectId,
        reason: `Save ${index}`,
        expectedVersion: document.version,
        document: edited(document)
      });
    }
    expect(count(srv, 'e2ee_project_revisions', projectId)).toBe(
      MAX_PROJECT_REVISIONS
    );
    expect(
      rows<{ revision_count: number }>(
        srv,
        'SELECT revision_count FROM projects WHERE id = ?',
        projectId
      )[0]!.revision_count
    ).toBe(MAX_PROJECT_REVISIONS);
    // Bodies: the retained revisions (the head is one of them) only.
    expect(
      rows<{ n: number }>(
        srv,
        `SELECT COUNT(*) AS n FROM e2ee_project_versions
         WHERE project_id = ? AND (envelope_key IS NOT NULL OR envelope_inline IS NOT NULL)`,
        projectId
      )[0]!.n
    ).toBe(MAX_PROJECT_REVISIONS);
    // The log keeps every head while it is under 2,000 entries.
    expect(count(srv, 'e2ee_project_versions', projectId)).toBe(total + 1);
    const listed = await reload(srv, laptop).store.listRevisions(projectId);
    expect(listed.revisions).toHaveLength(MAX_PROJECT_REVISIONS);
    expect(listed.revisions[0]!.reason).toBe(`Save ${total - 1}`);
  }, 60_000);

  it('purges versions, revisions, envelopes and R2 bodies with the project', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document } = await createEncrypted(laptop);
    const projectId = document.projectId;
    srv.bucket.objects.set(
      `e2ee/${projectId}/v/${'0'.repeat(64)}`,
      new ArrayBuffer(4)
    );
    srv.db.exec('DROP TRIGGER e2ee_project_version_immutable');
    srv.db
      .prepare(
        `UPDATE e2ee_project_versions SET envelope_inline = NULL, envelope_key = ?
         WHERE project_id = ?`
      )
      .run(`e2ee/${projectId}/v/${'0'.repeat(64)}`, projectId);
    srv.db
      .prepare(
        "UPDATE projects SET status = 'deleted', deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
      )
      .run(projectId);
    expect((await srv.call('POST', '/api/projects/purge')).status).toBe(200);
    for (const table of [
      'e2ee_project_versions',
      'e2ee_project_revisions',
      'e2ee_project_envelopes',
      'e2ee_project_groups'
    ]) {
      expect(count(srv, table, projectId), table).toBe(0);
    }
    expect(srv.bucket.objects.size).toBe(0);
  });

  it('erases with the account, profile and all', async () => {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    await createEncrypted(laptop);
    const profile = await srv.call('POST', '/api/account/delete-data', {
      body: { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' }
    });
    expect(profile.status).toBe(200);
    const all = await srv.call('POST', '/api/account/delete-data', {
      body: { scope: 'all', confirmation: 'DELETE ALL CLOUD DATA' }
    });
    expect(all.status).toBe(200);
    expect(
      rows<{ n: number }>(
        srv,
        'SELECT COUNT(*) AS n FROM e2ee_project_versions'
      )[0]!.n
    ).toBe(0);
  });
});

// --- Migration 0033 --------------------------------------------------------

const VERSION_TABLES =
  /e2ee_project_versions|e2ee_project_revisions|e2ee_project_envelopes/;

/** The only statements allowed to name the new tables are the schema probes. */
function expectOnlyProbes(statements: string[]) {
  for (const sql of statements.filter((s) => VERSION_TABLES.test(s))) {
    expect(sql, sql).toMatch(/FROM sqlite_master/);
  }
}

/**
 * Merging deploys to the live beta, which applies migrations. If 0033 fails
 * or is delayed, ordinary traffic and erasure must not notice; only the new
 * encrypted document routes answer 503.
 */
describe('without migration 0033', () => {
  function seedEncrypted(srv: Server): string {
    srv.db
      .prepare(
        `INSERT INTO projects (id, user_id, name, document_json, updated_at, storage_format)
         VALUES ('proj_seeded', ?, '', 'e2ee-v1', '2026-10-24T00:00:00.000Z', 2)`
      )
      .run(OWNER);
    return 'proj_seeded';
  }

  it('keeps ordinary project traffic, listing, purge and erasure working', async () => {
    const srv = newServer([owner, other], databaseBefore(33));
    const created = await srv.call('POST', '/api/projects', {
      body: { name: 'Bracket', initialDocument: initialDocument('Bracket') }
    });
    expect(created.status).toBe(201);
    const { document } = (await created.json()) as {
      document: ProjectDocument;
    };
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
    seedEncrypted(srv);
    const listing = await srv.call('GET', '/api/projects');
    expect(listing.status).toBe(200);
    const listed = (await listing.json()) as {
      projects: { projectId: string; storageFormat?: number }[];
      encryptedProjectInfo?: unknown;
    };
    expect(listed.projects.map((p) => p.storageFormat ?? 1).sort()).toEqual([
      1, 2
    ]);
    expect(listed.encryptedProjectInfo).toBeUndefined();
    srv.db
      .prepare(
        "UPDATE projects SET status = 'deleted', deleted_at = '2000-01-01T00:00:00.000Z'"
      )
      .run();
    expect((await srv.call('POST', '/api/projects/purge')).status).toBe(200);
    expect(
      rows<{ n: number }>(srv, 'SELECT COUNT(*) AS n FROM projects')[0]!.n
    ).toBe(0);
    seedEncrypted(srv);
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

  it('answers 503 on the encrypted document routes and reports projects off', async () => {
    const srv = newServer([owner, other], databaseBefore(33));
    const projectId = seedEncrypted(srv);
    for (const [method, path] of [
      ['POST', '/api/e2ee/projects'],
      ['GET', `/api/e2ee/projects/${projectId}/document`],
      ['PUT', `/api/e2ee/projects/${projectId}/document`],
      ['POST', `/api/e2ee/projects/${projectId}/revisions`],
      ['GET', `/api/e2ee/projects/${projectId}/revisions`],
      ['GET', `/api/e2ee/projects/${projectId}/versions`],
      ['GET', `/api/e2ee/projects/${projectId}/info`],
      ['PUT', `/api/e2ee/projects/${projectId}/info`]
    ] as const) {
      const response = await srv.call(
        method,
        path,
        method === 'GET' ? {} : { raw: encodeE2eeFrame({}), contentType: FRAME }
      );
      expect(response.status, `${method} ${path}`).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'E2EE_UNAVAILABLE' });
    }
    // The 4-4 routes still work: their migration is there.
    expect(
      (await srv.call('GET', `/api/e2ee/projects/${projectId}/keys`)).status
    ).toBe(200);
    expect(await (await srv.call('GET', '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: false
    });
    expectOnlyProbes(srv.statements);
  });

  it('notices the tables once the migration lands, without a redeploy', async () => {
    const db = databaseBefore(33);
    const srv = newServer([owner, other], db);
    const projectId = seedEncrypted(srv);
    expect(
      (await srv.call('GET', `/api/e2ee/projects/${projectId}/info`)).status
    ).toBe(503);
    db.exec(
      readFileSync(
        new URL(
          '../apps/web/migrations/0033_e2ee_project_versions.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ['Date'] });
    expect(
      (await srv.call('GET', `/api/e2ee/projects/${projectId}/info`)).status
    ).toBe(200);
  });
});

describe('migration 0033', () => {
  it('keeps the log immutable, sequences forward and cascades with the project', () => {
    const srv = server();
    const db = srv.db;
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at, storage_format)
       VALUES ('proj_m', ?, '', 'e2ee-v1', '2026-10-24T00:00:00.000Z', 2)`
    ).run(OWNER);
    const insert = (version: number, hash: string) =>
      db
        .prepare(
          `INSERT INTO e2ee_project_versions
             (project_id, document_version, version_hash, key_epoch, prefix, signature,
              signer_user_id, signer_device_id, envelope_inline, envelope_bytes,
              wrapped_version_key, created_at)
           VALUES ('proj_m', ?, ?, 0, ?, ?, ?, 'd', 'AA', 10, ?, 'now')`
        )
        .run(
          version,
          hash,
          'A'.repeat(20),
          'A'.repeat(98),
          OWNER,
          'A'.repeat(55)
        );
    insert(1, 'a'.repeat(64));
    expect(() => insert(1, 'b'.repeat(64))).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert(2, 'a'.repeat(64))).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare(
          "UPDATE e2ee_project_versions SET version_hash = ? WHERE project_id = 'proj_m'"
        )
        .run('c'.repeat(64))
    ).toThrow(/E2EE_VERSION_IMMUTABLE/);
    // Pruning a body and erasing the signer are allowed.
    db.prepare(
      "UPDATE e2ee_project_versions SET envelope_inline = NULL, signer_user_id = NULL WHERE project_id = 'proj_m'"
    ).run();
    expect(() =>
      db
        .prepare(
          "UPDATE e2ee_project_versions SET envelope_inline = 'BB' WHERE project_id = 'proj_m'"
        )
        .run()
    ).toThrow(/E2EE_VERSION_IMMUTABLE/);
    db.prepare(
      `INSERT INTO e2ee_project_envelopes
         (project_id, kind, scope, sequence, key_epoch, envelope, wrapped_version_key,
          signature, signer_device_id, updated_at)
       VALUES ('proj_m', 'project-info', '', 2, 0, 'AA', ?, ?, 'd', 'now')`
    ).run('A'.repeat(55), 'A'.repeat(98));
    expect(() =>
      db
        .prepare(
          "UPDATE e2ee_project_envelopes SET sequence = 2 WHERE project_id = 'proj_m'"
        )
        .run()
    ).toThrow(/E2EE_ENVELOPE_SEQUENCE/);
    db.prepare("DELETE FROM projects WHERE id = 'proj_m'").run();
    for (const table of ['e2ee_project_versions', 'e2ee_project_envelopes']) {
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(),
        table
      ).toEqual({ n: 0 });
    }
  });
});

describe('heads the Worker accepts but the browser does not trust', () => {
  async function setup() {
    const srv = server();
    const laptop = device(srv, owner, 'owner_laptop');
    const { document: v1 } = await createEncrypted(laptop);
    const projectId = v1.projectId;
    const head = headOf(srv, projectId);
    return {
      srv,
      laptop,
      v1,
      projectId,
      next: {
        documentVersion: v1.version + 1,
        keyEpoch: 0,
        previousVersionHash: fromHex(head.version_hash)
      },
      options: { expectedVersion: v1.version, document: v1 }
    };
  }

  it('refuses an author that held no leaf in the epoch', async () => {
    const { srv, laptop, projectId, next, options } = await setup();
    // The desktop is certified but never joined the project's group.
    const hand = await handVersion(laptop, projectId, next, {
      ...options,
      signer: 'owner_desktop'
    });
    expect((await putVersion(srv, projectId, hand)).status).toBe(200);
    await integrityRefusal(
      reload(srv, laptop).store.loadProject(projectId),
      'authority'
    );
  });

  it('refuses a version bound to another epoch authenticator', async () => {
    const { srv, laptop, projectId, next, options } = await setup();
    const hand = await handVersion(
      laptop,
      projectId,
      { ...next, epochBindingHash: new Uint8Array(32).fill(7) },
      options
    );
    expect((await putVersion(srv, projectId, hand)).status).toBe(200);
    await integrityRefusal(
      reload(srv, laptop).store.loadProject(projectId),
      'epoch'
    );
  });

  it('refuses a version whose document claims another project or version', async () => {
    const { srv, laptop, v1, projectId, next, options } = await setup();
    const header = {
      kind: 'document' as const,
      keyEpoch: 0,
      blobIds: []
    };
    const hand = await handVersion(laptop, projectId, next, {
      ...options,
      plaintext: encodeEncryptedDocumentBody(
        {
          document: {
            ...(v1 as unknown as Record<string, unknown>),
            projectId: 'proj_00000000-0000-4000-8000-000000000000',
            version: next.documentVersion
          },
          blobs: [],
          revisionVersionHashes: new Map()
        },
        header
      )
    });
    expect((await putVersion(srv, projectId, hand)).status).toBe(200);
    await integrityRefusal(
      reload(srv, laptop).store.loadProject(projectId),
      'content'
    );
  });

  it('refuses a version key wrapped for another version', async () => {
    const { srv, laptop, projectId, next, options } = await setup();
    const hand = await handVersion(laptop, projectId, next, options);
    const other = await handVersion(laptop, projectId, next, options);
    hand.upload = {
      ...hand.upload,
      wrappedVersionKey: other.upload.wrappedVersionKey
    };
    expect((await putVersion(srv, projectId, hand)).status).toBe(200);
    await integrityRefusal(
      reload(srv, laptop).store.loadProject(projectId),
      'content'
    );
  });
});
