/**
 * The visitor page of end-to-end encrypted share links (ADR-024 Phase 5,
 * slice 5-11; roadmap L11): a link visitor's browser runs the real loader
 * (`sharedSnapshotLoader.ts`: the fragment, the anonymous route, the ADR's
 * check order, the share-version key, decryption, and every content blob
 * the snapshot names through the new anonymous blob route) against the
 * real Worker over SQLite, with the owner's and an editor's Node devices
 * of slice 5-10 behind the link. Make a copy is checked both ways: into an
 * account that encrypts new projects (slice 4-8's adoption) and into one
 * that does not (an ordinary project).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi
} from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  fromBase64Url,
  signShareDelegation,
  toBase64Url,
  type ContentBlobReference
} from '@openzcad/crypto';
import {
  adoptProjectDocument,
  duplicateProjectDocument,
  reidentifyProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  createId,
  toProjectId,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import worker from '../apps/web/worker/index';
import { forgetSnapshotBlobIds } from '../apps/web/worker/e2eeShareLinks';
import { rememberProjectFormats } from '../apps/web/src/lib/api';
import type { ArchiveArtifactInput } from '../apps/web/src/lib/archiveArtifact';
import { archiveAccountImportSources } from '../apps/web/src/lib/accountImportSources';
import {
  decodeContentBlobJob,
  decodeProjectEnvelopeJob
} from '../apps/web/src/lib/e2ee/decodeJobs';
import { parseShareFragment } from '../apps/web/src/lib/e2ee/shareLinkFragment';
import {
  SHARED_LINK_MESSAGES,
  SharedLinkRefusal,
  loadEncryptedSharedProject,
  sharedBlobUrl,
  sharedLinkRefusalMessage,
  type SharedLinkRefusalReason,
  type SharedSnapshotLoaderDeps
} from '../apps/web/src/lib/e2ee/sharedSnapshotLoader';
import {
  createShareLink,
  publishShareSnapshots,
  renewShareDelegation,
  revokeShareLink
} from '../apps/web/src/lib/e2ee/shareLinks';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  isEncryptedShareLink,
  shareLinkFromHash,
  shareTokenFromHash
} from '../apps/web/src/lib/projectShareLink';
import {
  OTHER,
  OWNER,
  device,
  makeAccount,
  reload,
  rows,
  type Account,
  type Device,
  type DeviceOptions,
  type Server
} from './support/e2ee-documents';
import { sharedProject } from './support/e2ee-members';
import {
  putRawSnapshot,
  R2_PADDING,
  sealRawSnapshot
} from './support/e2ee-share-snapshots';

const THIRD = 'user_third';
const DAY = 86_400_000;

let owner: Account;
let other: Account;
let third: Account;

beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop']);
  other = await makeAccount(OTHER, ['other_laptop']);
  third = await makeAccount(THIRD, ['third_laptop']);
});

afterEach(() => {
  forgetAllProjectKeys();
});

const accounts = () => [owner, other, third];
const othersOf = (account: Account) =>
  accounts().filter((candidate) => candidate !== account);
const text = (value: string) => new TextEncoder().encode(value);
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

const republish: DeviceOptions['onVersionWritten'] = (d, projectId, head) =>
  publishShareSnapshots(d.shareLinks, projectId, head);

const page = (srv: Server, d: Device) =>
  reload(srv, d, { members: othersOf(d.account), onVersionWritten: republish });

function stepBytes(label: string): Uint8Array<ArrayBuffer> {
  return text(
    `ISO-10303-21;\nHEADER;\nFILE_NAME('${label}');\n${'DATA;\n'.repeat(200)}END-ISO-10303-21;\n`
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

/**
 * The owner's project, shared with OTHER as an editor, holding one STEP
 * import as a content blob, with a confirmed delegation.
 */
async function sharedWithImport() {
  const shared = await sharedProject(accounts(), owner, other, 'editor');
  const laptop = page(shared.srv, shared.laptop);
  const step = stepBytes('shared-source');
  const blobId = await laptop.blobs.archive(shared.projectId, stepInput(step));
  const head = withImport(shared.document, blobId, step);
  await laptop.store.saveProjectDocument({
    projectId: shared.projectId,
    expectedVersion: shared.document.version,
    document: head
  });
  await renewShareDelegation(laptop.shareLinks, (value) =>
    signShareDelegation(owner.identityPrivateKey, value)
  );
  return { ...shared, laptop, step, blobId, name: shared.document.name };
}

/** The visitor's network: anonymous requests to the Worker, nothing else. */
function visitorFetch(
  srv: Server,
  answer?: (path: string, response: Response) => Promise<Response>,
  env: Record<string, unknown> = srv.env
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.pathname
          : input.url;
    expect(path.startsWith('/api/e2ee/share/')).toBe(true);
    expect(init?.credentials).toBe('omit');
    const response = await worker.fetch(
      new Request(`https://example.com${path}`, init),
      env
    );
    return answer ? answer(path, response) : response;
  };
}

/** A visitor's browser: inline decode jobs, an in-memory source store. */
function visitor(
  srv: Server,
  options: Partial<SharedSnapshotLoaderDeps> & {
    answer?: (path: string, response: Response) => Promise<Response>;
  } = {}
) {
  const sources = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const fetcher = visitorFetch(srv, async (path, response) => {
    requests.push(path);
    return options.answer ? options.answer(path, response) : response;
  });
  const deps: SharedSnapshotLoaderDeps = {
    fetch: fetcher,
    decodeProjectEnvelope: (job) =>
      decodeProjectEnvelopeJob({ type: 'project-envelope', ...job }),
    decodeContentBlob: (job) =>
      decodeContentBlobJob({ type: 'content-blob', ...job }),
    loadSourceBlob: async (checksum) => sources.get(checksum) ?? null,
    putSourceBlob: async (bytes) => {
      sources.set(sha256(bytes), bytes);
    },
    idleMs: 5_000,
    ...options
  };
  return {
    sources,
    requests,
    open: (url: string) =>
      loadEncryptedSharedProject(
        shareLinkFromHash(new URL(url).hash)!,
        () => true,
        deps
      )
  };
}

async function refused(
  promise: Promise<unknown>,
  reason: SharedLinkRefusalReason
) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(SharedLinkRefusal);
  expect((error as SharedLinkRefusal).reason).toBe(reason);
  expect(sharedLinkRefusalMessage(error)).toBe(SHARED_LINK_MESSAGES[reason]);
}

async function anonymous(
  srv: Server,
  path: string,
  env: Record<string, unknown> = srv.env,
  headers: Record<string, string> = {}
) {
  return worker.fetch(
    new Request(`https://example.com${path}`, { headers }),
    env
  );
}

describe('the fragment (slice 5-11)', () => {
  const part = (fill: string) => fill.repeat(43);
  const encrypted = `${part('t')}.${part('k')}.${part('o')}`;

  it('tells an encrypted link from a plaintext one, and keeps the plaintext reader unchanged', () => {
    expect(shareLinkFromHash(`#share=${encrypted}`)).toBe(encrypted);
    expect(isEncryptedShareLink(encrypted)).toBe(true);
    expect(shareTokenFromHash(`#share=${encrypted}`)).toBe(null);
    // A plaintext link reads exactly as before.
    expect(shareLinkFromHash(`#share=${part('a')}`)).toBe(part('a'));
    expect(shareTokenFromHash(`#share=${part('a')}`)).toBe(part('a'));
    expect(isEncryptedShareLink(part('a'))).toBe(false);
    // Neither form accepts anything else.
    for (const hash of [
      `#share=${part('t')}.${part('k')}`,
      `#share=${part('t')}.${part('k')}.${part('o')}.${part('x')}`,
      `#share=${part('t')}.${'k'.repeat(42)}.${part('o')}`,
      `#share=${part('t')}.${part('k')}.${part('o')}=`,
      `#invite=${encrypted}`,
      '#share='
    ]) {
      expect(shareLinkFromHash(hash)).toBe(null);
    }
  });
});

describe('opening a link (slice 5-11)', { timeout: 120_000 }, () => {
  it('opens a valid view-only and tweak link, with the statement’s mode and the owner’s file', async () => {
    const { srv, laptop, projectId, step, blobId, name } =
      await sharedWithImport();
    const view = await createShareLink(laptop.shareLinks, projectId, 'view');
    const tweak = await createShareLink(laptop.shareLinks, projectId, 'tweak');

    const browser = visitor(srv);
    const viewed = await browser.open(view.url);
    expect(viewed).toMatchObject({
      projectId,
      shareId: view.shareId,
      name,
      mode: 'view'
    });
    expect(viewed!.document.projectId).toBe(projectId);
    expect(JSON.stringify(viewed!.document)).toContain(blobId);
    // The import's file arrived through the blob route, decrypted and
    // checked, and sits in this browser's source store.
    expect(browser.sources.get(sha256(step))).toEqual(step);
    expect(browser.requests).toEqual([
      `/api/e2ee/share/${view.fragment.token}`,
      sharedBlobUrl(view.fragment.token, blobId)
    ]);

    // A second visit finds the file in the source store already.
    const tweaked = await browser.open(tweak.url);
    expect(tweaked).toMatchObject({ shareId: tweak.shareId, mode: 'tweak' });
    expect(browser.requests.at(-1)).toBe(
      `/api/e2ee/share/${tweak.fragment.token}`
    );

    // The mode is the verified statement's, not the server's word.
    const lying = visitor(srv, {
      answer: async (path, response) => {
        if (path.includes('/blobs/')) return response;
        const frame = (await import('@openzcad/shared')).decodeE2eeFrame(
          new Uint8Array(await response.arrayBuffer())
        );
        return new Response(
          (await import('@openzcad/shared')).encodeE2eeFrame(
            { ...(frame.metadata as object), mode: 'tweak' },
            frame.payload
          )
        );
      }
    });
    expect((await lying.open(view.url))!.mode).toBe('view');
  });

  it('answers null for a revoked link, and the blob route serves nothing for it', async () => {
    const { srv, laptop, projectId, blobId } = await sharedWithImport();
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    const blobPath = sharedBlobUrl(created.fragment.token, blobId);
    expect((await anonymous(srv, blobPath)).status).toBe(200);

    await revokeShareLink(laptop.shareLinks, projectId, created.shareId);
    expect(await visitor(srv).open(created.url)).toBe(null);
    expect((await anonymous(srv, blobPath)).status).toBe(404);
  });

  it('refuses an expired statement or delegation as not recently confirmed', async () => {
    const { srv, laptop, projectId } = await sharedWithImport();
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    await refused(
      visitor(srv, { now: () => Date.now() + 8 * DAY }).open(created.url),
      'not-confirmed'
    );
    await refused(
      visitor(srv, { now: () => Date.now() + 31 * DAY }).open(created.url),
      'not-confirmed'
    );
    expect(SHARED_LINK_MESSAGES['not-confirmed']).toMatch(
      /^The owner hasn't recently confirmed this link/
    );
    // A statement from the future is this device's clock.
    await refused(
      visitor(srv, { now: () => Date.now() - 2 * DAY }).open(created.url),
      'not-yet-valid'
    );
  });

  it('refuses a forged snapshot and a wrong key or owner in the fragment', async () => {
    const { srv, laptop, projectId } = await sharedWithImport();
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    const parts = parseShareFragment(new URL(created.url).hash)!;
    const link = (key: Uint8Array, owner: Uint8Array) =>
      `https://app.example/#share=${parts.token}.${toBase64Url(key)}.${toBase64Url(owner)}`;

    // A key that is not the link's: the token still finds the link.
    await refused(
      visitor(srv).open(link(randomBytes(32), parts.ownerIdentityHash)),
      'wrong-link'
    );
    // An owner fingerprint that is not the owner's.
    await refused(
      visitor(srv).open(link(parts.shareKey, randomBytes(32))),
      'wrong-link'
    );

    // The server swaps a byte of the stored snapshot.
    const [row] = rows<{ envelope_inline: string }>(
      srv,
      'SELECT envelope_inline FROM e2ee_share_snapshots WHERE share_id = ?',
      created.shareId
    );
    const forged = fromBase64Url(row!.envelope_inline);
    forged[forged.length - 1]! ^= 1;
    srv.db
      .prepare(
        'UPDATE e2ee_share_snapshots SET envelope_inline = ? WHERE share_id = ?'
      )
      .run(toBase64Url(forged), created.shareId);
    await refused(visitor(srv).open(created.url), 'not-verified');
  });

  it('refuses a blob that does not match the snapshot, and nothing reaches the source store', async () => {
    const { srv, laptop, projectId, blobId } = await sharedWithImport();
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');

    // Ciphertext altered on the way.
    const altered = visitor(srv, {
      answer: async (path, response) => {
        if (!path.includes('/blobs/')) return response;
        const bytes = new Uint8Array(await response.arrayBuffer());
        bytes[bytes.length - 1]! ^= 1;
        return new Response(bytes);
      }
    });
    await refused(altered.open(created.url), 'file-mismatch');
    expect(altered.sources.size).toBe(0);

    // The server swaps in another blob of the same project.
    const decoy = await laptop.blobs.archive(
      projectId,
      stepInput(stepBytes('decoy'))
    );
    const objectOf = (id: string) =>
      rows<{ object_key: string }>(
        srv,
        'SELECT object_key FROM e2ee_content_blobs WHERE blob_id = ?',
        id
      )[0]!.object_key;
    const original = srv.bucket.objects.get(objectOf(blobId))!;
    srv.bucket.objects.set(
      objectOf(blobId),
      srv.bucket.objects.get(objectOf(decoy))!
    );
    const swapped = visitor(srv);
    await refused(swapped.open(created.url), 'file-mismatch');
    expect(swapped.sources.size).toBe(0);
    srv.bucket.objects.set(objectOf(blobId), original);
    expect(await visitor(srv).open(created.url)).not.toBe(null);
  });
});

describe('the anonymous blob route (slice 5-11)', { timeout: 120_000 }, () => {
  it('serves only blobs the link’s snapshot names, of its project, while the deployment serves links', async () => {
    const { srv, laptop, projectId, blobId } = await sharedWithImport();
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    const token = created.fragment.token;

    const served = await anonymous(srv, sharedBlobUrl(token, blobId));
    expect(served.status).toBe(200);
    expect(served.headers.get('cache-control')).toBe('no-store');
    const [stored] = rows<{ object_key: string }>(
      srv,
      'SELECT object_key FROM e2ee_content_blobs WHERE blob_id = ?',
      blobId
    );
    // The owner's ciphertext, unchanged; never the plaintext.
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(
      new Uint8Array(srv.bucket.objects.get(stored!.object_key)!)
    );

    // A committed blob of the project the snapshot does not name.
    const unnamed = await laptop.blobs.archive(
      projectId,
      stepInput(stepBytes('unnamed'))
    );
    expect((await anonymous(srv, sharedBlobUrl(token, unnamed))).status).toBe(
      404
    );
    // A blob the snapshot names, asked for with another link's token.
    const elsewhere = await laptop.store.createProject({
      name: 'Elsewhere',
      initialDocument: withoutDerivedProjection(
        duplicateProjectDocument(
          await laptop.store.loadProject(projectId),
          'Elsewhere',
          toUserId(OWNER)
        )
      )
    });
    const foreign = await createShareLink(
      laptop.shareLinks,
      elsewhere.document.projectId,
      'view'
    );
    expect(
      (await anonymous(srv, sharedBlobUrl(foreign.fragment.token, blobId)))
        .status
    ).toBe(404);
    // Malformed ids and tokens.
    for (const path of [
      sharedBlobUrl(token, 'not-a-blob'),
      sharedBlobUrl('x'.repeat(43), blobId),
      `/api/e2ee/share/${token}/blobs/`
    ]) {
      expect((await anonymous(srv, path)).status).toBe(404);
    }
    // Flags off: the same opaque 404, as for the snapshot.
    for (const flags of [
      { E2EE_PROJECTS_ENABLED: 'false' },
      { PROJECT_SHARING_ENABLED: 'false' }
    ]) {
      const env = { ...srv.env, ...flags };
      expect(
        (await anonymous(srv, sharedBlobUrl(token, blobId), env)).status
      ).toBe(404);
      expect(
        (await anonymous(srv, `/api/e2ee/share/${token}`, env)).status
      ).toBe(404);
    }
    // The owner's sharing switch off.
    srv.db
      .prepare(
        `INSERT INTO user_settings (user_id, settings_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json`
      )
      .run(
        OWNER,
        JSON.stringify({ collaboration: { enabled: false } }),
        new Date().toISOString()
      );
    expect((await anonymous(srv, sharedBlobUrl(token, blobId))).status).toBe(
      404
    );
  });

  it('rate limits the anonymous encrypted routes per address, and leaves plaintext links alone', async () => {
    const { srv, laptop, projectId, blobId } = await sharedWithImport();
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    const token = created.fragment.token;
    const env = {
      ...srv.env,
      ENVIRONMENT: 'beta',
      AUTH_MODE: 'email-code',
      AUTH_OTP_PEPPER: 'pepper-for-tests'
    };
    // One fixed-window minute for every request below.
    const minute = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    onTestFinished(() => minute.mockRestore());
    const from = { 'cf-connecting-ip': '203.0.113.7' };
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) {
      statuses.push(
        (await anonymous(srv, `/api/e2ee/share/${token}`, env, from)).status
      );
    }
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    // Blobs count in their own bucket; another address is unaffected.
    expect(
      (await anonymous(srv, sharedBlobUrl(token, blobId), env, from)).status
    ).toBe(200);
    expect(
      (
        await anonymous(srv, `/api/e2ee/share/${token}`, env, {
          'cf-connecting-ip': '203.0.113.8'
        })
      ).status
    ).toBe(200);
    // Plaintext share links are not limited (unchanged).
    for (let i = 0; i < 70; i += 1) {
      expect(
        (await anonymous(srv, `/api/share/${'p'.repeat(43)}`, env, from)).status
      ).toBe(404);
    }
    // With the flags off nothing is counted: still the opaque 404.
    const off = { ...env, E2EE_PROJECTS_ENABLED: 'false' };
    expect(
      (await anonymous(srv, `/api/e2ee/share/${token}`, off, from)).status
    ).toBe(404);
  });

  it('counts blobs per link load: a model with more imports than the address budget loads at once, and nothing else gains (slice 8-C1)', async () => {
    const { srv, laptop, projectId, document, blobId } =
      await sharedWithImport();
    const large = await createShareLink(laptop.shareLinks, projectId, 'view');
    const small = await createShareLink(laptop.shareLinks, projectId, 'view');
    // A snapshot of the large link naming 400 committed blobs.
    const many = 400;
    const references: ContentBlobReference[] = [];
    const insert = srv.db.prepare(
      `INSERT INTO e2ee_content_blobs
         (project_id, blob_id, kind, object_key, ciphertext_bytes, created_at)
       VALUES (?, ?, 'import-source', ?, 16, ?)`
    );
    for (let i = 0; i < many; i += 1) {
      const id = randomBytes(16).toString('hex');
      const key = `e2ee/${projectId}/${id}`;
      srv.bucket.objects.set(key, new Uint8Array(16).buffer);
      insert.run(projectId, id, key, new Date().toISOString());
      references.push({
        blobId: id,
        kind: 'import-source',
        key: new Uint8Array(randomBytes(32)),
        ciphertextHash: new Uint8Array(randomBytes(32)),
        plaintextLength: 1
      });
    }
    const sealed = await sealRawSnapshot(
      srv,
      laptop,
      projectId,
      large.shareId,
      {
        document,
        blobs: references
      }
    );
    expect(
      (await putRawSnapshot(srv, laptop, projectId, large.shareId, sealed))
        .status
    ).toBe(200);
    const env = {
      ...srv.env,
      ENVIRONMENT: 'beta',
      AUTH_MODE: 'email-code',
      AUTH_OTP_PEPPER: 'pepper-for-tests'
    };
    const minute = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    onTestFinished(() => minute.mockRestore());
    const from = { 'cf-connecting-ip': '203.0.113.9' };
    const fetchBlob = async (token: string, id: string) =>
      (await anonymous(srv, sharedBlobUrl(token, id), env, from)).status;
    // One load of the large link: every blob, within one minute.
    for (const reference of references) {
      expect(await fetchBlob(large.fragment.token, reference.blobId)).toBe(200);
    }
    // The small link's load budget (one blob: 2 + 32), then the address's
    // own 300, then nothing. Use distinct, unnamed ids so the independent
    // per-blob repetition cap does not mask this aggregate boundary.
    const statuses: number[] = [];
    for (let i = 0; i < 335; i += 1) {
      statuses.push(
        await fetchBlob(small.fragment.token, randomBytes(16).toString('hex'))
      );
    }
    expect(statuses.slice(0, 334).every((status) => status === 404)).toBe(true);
    expect(statuses[334]).toBe(429);
    // Requests naming no servable link spend the address's budget: spent.
    expect(await fetchBlob('x'.repeat(43), blobId)).toBe(429);
    // Another address still gets its own.
    expect(
      (
        await anonymous(srv, sharedBlobUrl('x'.repeat(43), blobId), env, {
          'cf-connecting-ip': '203.0.113.10'
        })
      ).status
    ).toBe(404);
  });

  /**
   * An R2-backed snapshot of a new link naming `references` (#935 review),
   * with counters of the R2 reads of its object: whole-body reads and
   * ranged ones, and a limited deployment's anonymous blob fetch.
   */
  async function r2Snapshot(
    shared: Awaited<ReturnType<typeof sharedWithImport>>,
    references: ContentBlobReference[],
    address: string
  ) {
    const { srv, laptop, projectId, document } = shared;
    forgetSnapshotBlobIds();
    const link = await createShareLink(laptop.shareLinks, projectId, 'view');
    const sealed = await sealRawSnapshot(srv, laptop, projectId, link.shareId, {
      document,
      padding: R2_PADDING,
      blobs: references
    });
    expect(
      (await putRawSnapshot(srv, laptop, projectId, link.shareId, sealed))
        .status
    ).toBe(200);
    const { envelope_key: envelopeKey } = srv.db
      .prepare(
        `SELECT envelope_key FROM e2ee_share_snapshots
         WHERE project_id = ? AND share_id = ?`
      )
      .get(projectId, link.shareId) as { envelope_key: string | null };
    expect(envelopeKey).not.toBe(null);
    const reads = (ranged: boolean) =>
      srv.bucket.get.mock.calls.filter(
        ([key, options]) =>
          key === envelopeKey &&
          ((options as { range?: unknown } | undefined)?.range !==
            undefined) ===
            ranged
      ).length;
    const env = {
      ...srv.env,
      ENVIRONMENT: 'beta',
      AUTH_MODE: 'email-code',
      AUTH_OTP_PEPPER: 'pepper-for-tests'
    };
    const now = Date.now();
    const minute = vi.spyOn(Date, 'now').mockReturnValue(now);
    onTestFinished(() => minute.mockRestore());
    const fetchBlob = async (id: string, from = address) =>
      (
        await anonymous(srv, sharedBlobUrl(link.fragment.token, id), env, {
          'cf-connecting-ip': from
        })
      ).status;
    return {
      bodyReads: () => reads(false),
      rangedReads: () => reads(true),
      fetchBlob,
      nextMinute: () => minute.mockReturnValue(now + 60_000)
    };
  }

  function committedBlobs(
    srv: Server,
    projectId: string,
    count: number
  ): ContentBlobReference[] {
    const insert = srv.db.prepare(
      `INSERT INTO e2ee_content_blobs
         (project_id, blob_id, kind, object_key, ciphertext_bytes, created_at)
       VALUES (?, ?, 'import-source', ?, 16, ?)`
    );
    return Array.from({ length: count }, () => {
      const id = randomBytes(16).toString('hex');
      const key = `e2ee/${projectId}/${id}`;
      srv.bucket.objects.set(key, new Uint8Array(16).buffer);
      insert.run(projectId, id, key, new Date().toISOString());
      return {
        blobId: id,
        kind: 'import-source' as const,
        key: new Uint8Array(randomBytes(32)),
        ciphertextHash: new Uint8Array(randomBytes(32)),
        plaintextLength: 1
      };
    });
  }

  it('loads a 400-blob model without downloading its snapshot per blob: only its prefix, once (#935 review)', async () => {
    const shared = await sharedWithImport();
    const references = committedBlobs(shared.srv, shared.projectId, 400);
    const snapshot = await r2Snapshot(shared, references, '203.0.113.12');
    for (const reference of references) {
      expect(await snapshot.fetchBlob(reference.blobId)).toBe(200);
    }
    expect(snapshot.bodyReads()).toBe(0);
    expect(snapshot.rangedReads()).toBeLessThanOrEqual(2);
    expect(snapshot.rangedReads()).toBeGreaterThan(0);
  });

  it('caps snapshot prefix reads per address across links, before any read (#935 review)', async () => {
    const shared = await sharedWithImport();
    const references = committedBlobs(shared.srv, shared.projectId, 61);
    const snapshot = await r2Snapshot(shared, references, '203.0.113.13');
    // Every request in a fresh isolate (nothing cached): 60 prefix reads,
    // then refused before a 61st.
    for (let i = 0; i < 60; i += 1) {
      forgetSnapshotBlobIds();
      expect(await snapshot.fetchBlob(references[i]!.blobId)).toBe(200);
    }
    const read = snapshot.rangedReads();
    expect(read).toBeGreaterThanOrEqual(60);
    forgetSnapshotBlobIds();
    expect(await snapshot.fetchBlob(references[60]!.blobId)).toBe(429);
    expect(snapshot.rangedReads()).toBe(read);
    expect(snapshot.bodyReads()).toBe(0);
  });

  it('refuses a request past both budgets before reading the snapshot from R2 (#935 review)', async () => {
    const shared = await sharedWithImport();
    // An R2-backed snapshot naming the one import: a load budget of 34.
    const snapshot = await r2Snapshot(
      shared,
      [
        {
          blobId: shared.blobId,
          kind: 'import-source',
          key: new Uint8Array(randomBytes(32)),
          ciphertextHash: new Uint8Array(randomBytes(32)),
          plaintextLength: 1
        }
      ],
      '203.0.113.11'
    );
    const reads = () => snapshot.bodyReads() + snapshot.rangedReads();
    // The load's 34, then the address's own 300. Distinct, unnamed ids
    // exercise these budgets independently of the per-blob cap.
    for (let i = 0; i < 334; i += 1) {
      expect(await snapshot.fetchBlob(randomBytes(16).toString('hex'))).toBe(
        404
      );
    }
    // Past both, even in an isolate that has not cached the snapshot:
    // refused, and nothing more is read from R2.
    const spent = reads();
    const counters = () =>
      (
        shared.srv.db
          .prepare('SELECT COUNT(*) AS count FROM auth_rate_limits')
          .get() as {
          count: number;
        }
      ).count;
    const spentCounters = counters();
    for (let i = 0; i < 20; i += 1) {
      forgetSnapshotBlobIds();
      expect(await snapshot.fetchBlob(randomBytes(16).toString('hex'))).toBe(
        429
      );
    }
    expect(reads()).toBe(spent);
    expect(counters()).toBe(spentCounters);
    // The next minute the link loads again.
    snapshot.nextMinute();
    expect(await snapshot.fetchBlob(shared.blobId)).toBe(200);
    expect(reads()).toBe(spent + 1);
  });

  it('caps repeats across links before any R2 read even with a 4096-blob allowance (#935 review)', async () => {
    const shared = await sharedWithImport();
    const references = committedBlobs(shared.srv, shared.projectId, 4096);
    const id = references[0]!.blobId;
    const snapshot = await r2Snapshot(shared, references, '203.0.113.14');
    for (let i = 0; i < 4; i += 1) {
      expect(await snapshot.fetchBlob(id)).toBe(200);
    }
    const before = shared.srv.bucket.get.mock.calls.length;
    for (let i = 0; i < 20; i += 1) {
      forgetSnapshotBlobIds();
      expect(await snapshot.fetchBlob(id)).toBe(429);
    }
    expect(shared.srv.bucket.get.mock.calls.length).toBe(before);
    expect(await snapshot.fetchBlob(references[1]!.blobId)).toBe(200);
    expect(await snapshot.fetchBlob(id, '203.0.113.15')).toBe(200);
    snapshot.nextMinute();
    expect(await snapshot.fetchBlob(id)).toBe(200);
    for (let i = 0; i < 3; i += 1) {
      expect(await snapshot.fetchBlob(id)).toBe(200);
    }
    // A different token to the same project cannot multiply the cap.
    const sibling = await r2Snapshot(shared, references, '203.0.113.14');
    const siblingBefore = shared.srv.bucket.get.mock.calls.length;
    expect(await sibling.fetchBlob(id)).toBe(429);
    expect(shared.srv.bucket.get.mock.calls.length).toBe(siblingBefore);
  });

  async function inlineSnapshot(address: string) {
    const { srv, laptop, projectId, blobId } = await sharedWithImport();
    const link = await createShareLink(laptop.shareLinks, projectId, 'view');
    expect(
      srv.db
        .prepare(
          'SELECT envelope_inline IS NOT NULL AS inline FROM e2ee_share_snapshots WHERE share_id = ?'
        )
        .get(link.shareId)
    ).toEqual({ inline: 1 });
    const env = {
      ...srv.env,
      ENVIRONMENT: 'beta',
      AUTH_MODE: 'email-code',
      AUTH_OTP_PEPPER: 'pepper-for-tests'
    };
    const now = Date.now();
    const minute = vi.spyOn(Date, 'now').mockReturnValue(now);
    onTestFinished(() => minute.mockRestore());
    const fetchBlob = (id = blobId) =>
      anonymous(srv, sharedBlobUrl(link.fragment.token, id), env, {
        'cf-connecting-ip': address
      });
    const bodyReads = () =>
      srv.statements.filter(
        (sql) =>
          /\b(?:FROM|JOIN)\s+e2ee_share_snapshots\b/i.test(sql) &&
          /\benvelope_inline\b|\*/.test(
            /^\s*SELECT\s+([\s\S]*?)\bFROM\b/i.exec(sql)?.[1] ?? ''
          )
      ).length;
    srv.statements.length = 0;
    forgetSnapshotBlobIds();
    return {
      srv,
      link,
      fetchBlob,
      bodyReads,
      nextMinute: () => minute.mockReturnValue(now + 60_000)
    };
  }

  it('refuses repeated inline downloads before selecting the snapshot body from D1 (#935 review)', async () => {
    const { srv, fetchBlob, bodyReads } = await inlineSnapshot('203.0.113.17');
    for (let i = 0; i < 4; i += 1) {
      expect((await fetchBlob()).status).toBe(200);
    }
    const before = bodyReads();
    for (let i = 0; i < 20; i += 1) {
      forgetSnapshotBlobIds();
      expect((await fetchBlob()).status).toBe(429);
    }
    expect(bodyReads()).toBe(before);
    // An allowed load needs the inline body only once, even with warm reads.
    expect(before).toBe(1);
    const lookup = srv.statements.find((sql) =>
      /FROM e2ee_share_links l/.test(sql)
    );
    expect(lookup).toBeDefined();
    // The pre-limit lookup must omit both large fields, including the
    // authority's potentially 2,048 authors, even though it gates on one.
    const projection = /^\s*SELECT\s+([\s\S]*?)\bFROM\b/i.exec(lookup!)?.[1];
    expect(projection).not.toMatch(/\benvelope_inline\b|\bauthority\b|\*/);
    // Four valid requests already used the load budget. Thirty more plus
    // the address's 300 exhaust it using ids not masked by the repeat cap.
    for (let i = 0; i < 330; i += 1) {
      expect((await fetchBlob(randomBytes(16).toString('hex'))).status).toBe(
        404
      );
    }
    const spent = bodyReads();
    for (let i = 0; i < 20; i += 1) {
      forgetSnapshotBlobIds();
      expect((await fetchBlob(randomBytes(16).toString('hex'))).status).toBe(
        429
      );
    }
    expect(bodyReads()).toBe(spent);
  });

  it('caps cold inline snapshot reads before the 61st D1 body selection (#935 review)', async () => {
    const { fetchBlob, bodyReads, nextMinute } =
      await inlineSnapshot('203.0.113.18');
    for (let i = 0; i < 60; i += 1) {
      forgetSnapshotBlobIds();
      expect((await fetchBlob(randomBytes(16).toString('hex'))).status).toBe(
        404
      );
    }
    expect(bodyReads()).toBe(60);
    forgetSnapshotBlobIds();
    expect((await fetchBlob()).status).toBe(429);
    expect(bodyReads()).toBe(60);
    nextMinute();
    expect((await fetchBlob()).status).toBe(200);
    expect(bodyReads()).toBe(61);
  });

  it('fences a lazy inline body to the metadata hash and does not cache a missing read (#935 review)', async () => {
    const { srv, link, fetchBlob, bodyReads } =
      await inlineSnapshot('203.0.113.19');
    const stored = srv.db
      .prepare(
        'SELECT snapshot_hash FROM e2ee_share_snapshots WHERE share_id = ?'
      )
      .get(link.shareId) as { snapshot_hash: string };
    const push = srv.statements.push.bind(srv.statements);
    srv.statements.push = (...sql: string[]) => {
      if (
        sql.some((text) =>
          /SELECT envelope_inline FROM e2ee_share_snapshots/.test(text)
        )
      ) {
        srv.statements.push = push;
        // A publication replaces the row after authorization metadata was
        // read but before the lazy body selection executes.
        srv.db
          .prepare(
            'UPDATE e2ee_share_snapshots SET snapshot_hash = ? WHERE share_id = ?'
          )
          .run('f'.repeat(64), link.shareId);
      }
      return push(...sql);
    };
    onTestFinished(() => {
      srv.statements.push = push;
    });
    expect((await fetchBlob()).status).toBe(404);
    expect(srv.statements.push).toBe(push);
    expect(bodyReads()).toBe(1);
    srv.db
      .prepare(
        'UPDATE e2ee_share_snapshots SET snapshot_hash = ? WHERE share_id = ?'
      )
      .run(stored.snapshot_hash, link.shareId);
    expect((await fetchBlob()).status).toBe(200);
    expect(bodyReads()).toBe(2);
  });

  it('keeps the repetition cap when a spent link falls back to the address budget (#935 review)', async () => {
    const shared = await sharedWithImport();
    const references = committedBlobs(shared.srv, shared.projectId, 1);
    const snapshot = await r2Snapshot(shared, references, '203.0.113.16');
    for (let i = 0; i < 35; i += 1) {
      expect(await snapshot.fetchBlob(randomBytes(16).toString('hex'))).toBe(
        404
      );
    }
    for (let i = 0; i < 4; i += 1) {
      expect(await snapshot.fetchBlob(references[0]!.blobId)).toBe(200);
    }
    forgetSnapshotBlobIds();
    const before = shared.srv.bucket.get.mock.calls.length;
    expect(await snapshot.fetchBlob(references[0]!.blobId)).toBe(429);
    expect(shared.srv.bucket.get.mock.calls.length).toBe(before);
  });
});

describe('Make a copy (slice 5-11)', { timeout: 120_000 }, () => {
  async function openedCopy() {
    const shared = await sharedWithImport();
    const created = await createShareLink(
      shared.laptop.shareLinks,
      shared.projectId,
      'tweak'
    );
    const browser = visitor(shared.srv);
    const opened = (await browser.open(created.url))!;
    // What the page's Make a copy builds: a project of the visitor's own,
    // its files device-local until saved to an account.
    const copy = duplicateProjectDocument(
      opened.document,
      `${opened.name} (copy)`,
      toUserId(THIRD)
    );
    const adopted = withoutDerivedProjection(
      adoptProjectDocument(
        reidentifyProjectDocument(copy, toProjectId(createId('proj'))),
        toUserId(THIRD),
        copy.name
      )
    );
    expect(JSON.stringify(copy)).not.toContain(shared.blobId);
    return { ...shared, browser, copy, adopted };
  }

  it('into an account that encrypts new projects: encrypted under the visitor’s keys, its file a blob of its own', async () => {
    const { srv, browser, copy, adopted, step, blobId, projectId } =
      await openedCopy();
    const visitorLaptop = device(srv, third, 'third_laptop');
    const { project, document } = await visitorLaptop.store.createProject({
      name: copy.name,
      adoptionProtocolVersion: 2,
      localProjectId: copy.projectId,
      document: adopted
    });
    const copyId = document.projectId;
    expect(project).toMatchObject({ projectId: copyId, storageFormat: 2 });
    expect(copyId).not.toBe(projectId);
    expect(
      rows<{ user_id: string; document_json: string; name: string }>(
        srv,
        'SELECT user_id, document_json, name FROM projects WHERE id = ?',
        copyId
      )
    ).toEqual([{ user_id: THIRD, document_json: 'e2ee-v1', name: '' }]);
    // The file the visit put in the source store follows as a blob of the
    // copy, encrypted afresh: not the owner's blob or ciphertext.
    rememberProjectFormats([
      { projectId: toProjectId(copyId), storageFormat: 2 }
    ]);
    const prepared = await archiveAccountImportSources(document, {
      loadSourceBytes: async (checksum) =>
        (browser.sources.get(checksum) as Uint8Array<ArrayBuffer>) ?? null,
      archive: (input) => visitorLaptop.blobs.archive(copyId, input)
    });
    expect(prepared.result.archived).toHaveLength(1);
    await visitorLaptop.store.saveProjectDocument({
      projectId: copyId,
      expectedVersion: document.version,
      document: prepared.document
    });
    const copied = rows<{ blob_id: string }>(
      srv,
      'SELECT blob_id FROM e2ee_content_blobs WHERE project_id = ?',
      copyId
    );
    expect(copied).toHaveLength(1);
    expect(copied[0]!.blob_id).not.toBe(blobId);
    const reopened = reload(srv, visitorLaptop);
    await reopened.store.loadProject(copyId);
    expect(await reopened.blobs.read(copyId, copied[0]!.blob_id)).toEqual(step);
  });

  it('into an account that does not: an ordinary project, nothing encrypted named', async () => {
    const { srv, copy, adopted, blobId } = await openedCopy();
    const created = await srv.call('POST', '/api/projects', {
      user: THIRD,
      body: {
        name: copy.name,
        adoptionProtocolVersion: 2,
        localProjectId: copy.projectId,
        document: adopted
      }
    });
    expect(created.status).toBe(201);
    const { project } = (await created.json()) as {
      project: { projectId: string };
    };
    const [row] = rows<{
      user_id: string;
      storage_format: number;
      name: string;
    }>(
      srv,
      'SELECT user_id, storage_format, name FROM projects WHERE id = ?',
      project.projectId
    );
    expect(row).toEqual({
      user_id: THIRD,
      storage_format: 1,
      name: copy.name
    });
    expect(
      rows(
        srv,
        'SELECT blob_id FROM e2ee_content_blobs WHERE project_id = ?',
        project.projectId
      )
    ).toEqual([]);
    expect(JSON.stringify(adopted)).not.toContain(blobId);
  });
});
