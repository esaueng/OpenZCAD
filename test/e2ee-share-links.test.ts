/**
 * Share links of end-to-end encrypted projects (ADR-024 Phase 5, slice
 * 5-10; roadmap L11; migration 0040): Node devices of three accounts run
 * the real client modules (`shareLinks.ts`, `shareLinkSet.ts`,
 * `encryptedProjectStore.ts`, `projectGroups.ts`) with the in-process MLS
 * engine against the real Worker over SQLite, and a link visitor checks
 * what the anonymous route serves with `verifySharedSnapshot`
 * (`sharedSnapshot.ts`), as slice 5-11's page will.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock
} from 'vitest';
import worker from '../apps/web/worker/index';
import {
  ShareLinkError,
  decodeShareAuthority,
  epochBinding,
  fromBase64Url,
  fromHex,
  publicKeyHash,
  signProjectEnvelope,
  signShareAuthority,
  signShareDelegation,
  signShareKeyWrap,
  signShareLinkForget,
  signShareLinkRegistration,
  toBase64Url,
  toHex,
  wrapKey,
  type ShareLinkSet
} from '@openzcad/crypto';
import {
  D1R2PersistenceService,
  isE2eeShareLinkStorageReady
} from '@openzcad/cloudflare-adapters';
import {
  E2eeShareLinkApiError,
  createE2eeShareLinksApi,
  decodeE2eeFrame,
  toUserId,
  type E2eeSharedSnapshotMetadata,
  type E2eeShareLinkForgetRequest,
  type ProjectDocument
} from '@openzcad/shared';
import { shareLinkErasureStatements } from '../apps/web/worker/e2eeShareLinks';
import type {
  AccountView,
  E2eeContext
} from '../apps/web/src/lib/e2ee/accountKeys';
import { renewShareDelegationAfterRemoval } from '../apps/web/src/lib/e2ee/pageDeviceRemoval';
import { sealDocumentJob } from '../apps/web/src/lib/e2ee/decodeJobs';
import { EncryptedProjectIntegrityError } from '../apps/web/src/lib/e2ee/encryptedProjectStore';
import {
  catchUpProjectGroup,
  ensureProjectRotated,
  joinProjectGroup,
  removeMember,
  type MemberDevicesRemoved,
  type MembersRemoved
} from '../apps/web/src/lib/e2ee/projectGroups';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import { shareTokenFromHash } from '../apps/web/src/lib/projectShareLink';
import {
  formatShareFragment,
  parseShareFragment
} from '../apps/web/src/lib/e2ee/shareLinkFragment';
import { openSharedSnapshot } from '../apps/web/src/lib/e2ee/sharedSnapshot';
import {
  createShareLink,
  issueShareAuthorities,
  listShareLinks,
  maintainShareLinks,
  publishShareSnapshots,
  reissueShareLinks,
  renewShareDelegation,
  refreshOwnerShareAuthorities,
  revokeShareLink,
  ShareLinksError,
  shareDelegationState,
  shareLinksAfterDeviceRemoval,
  shareLinksAfterRemoval,
  type CreatedShareLink
} from '../apps/web/src/lib/e2ee/shareLinks';
import { sqliteD1 } from './support/sqlite-d1';
import {
  OTHER,
  OWNER,
  createEncrypted,
  device,
  edited,
  makeAccount,
  newServer,
  objectBucket,
  reload,
  rows,
  type Account,
  type Device,
  type DeviceOptions,
  type Server
} from './support/e2ee-documents';
import {
  addMember,
  head,
  serverKeyEpoch,
  sharedProject
} from './support/e2ee-members';
import {
  R2_PADDING,
  putRawSnapshot,
  sealRawSnapshot,
  snapshotObjects
} from './support/e2ee-share-snapshots';

const THIRD = 'user_third';
const DAY = 86_400_000;

let owner: Account;
let other: Account;
let third: Account;

beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  other = await makeAccount(OTHER, ['other_laptop', 'other_desktop']);
  third = await makeAccount(THIRD, ['third_laptop']);
});

afterEach(() => {
  forgetAllProjectKeys();
});

const accounts = () => [owner, other, third];
const othersOf = (account: Account) =>
  accounts().filter((candidate) => candidate !== account);

/** The page's save hook: every active link's snapshot follows the save. */
const republish: DeviceOptions['onVersionWritten'] = (d, projectId, head) =>
  publishShareSnapshots(d.shareLinks, projectId, head);

/** A page reloaded with the save hook (and, optionally, its own clock). */
const page = (srv: Server, d: Device, now?: () => number) =>
  reload(srv, d, {
    members: othersOf(d.account),
    onVersionWritten: republish,
    ...(now ? { now } : {})
  });

/** The owner's project shared with OTHER as an editor, both pages hooked. */
async function linkedProject(now?: () => number) {
  const shared = await sharedProject(accounts(), owner, other, 'editor');
  return {
    ...shared,
    laptop: page(shared.srv, shared.laptop, now),
    member: page(shared.srv, shared.member, now)
  };
}

/** The identity key signs a delegation, as a passkey touch would open it. */
const delegate = (d: Device) =>
  renewShareDelegation(d.shareLinks, (value) =>
    signShareDelegation(d.account.identityPrivateKey, value)
  );

async function served(srv: Server, token: string) {
  const response = await worker.fetch(
    new Request(`https://example.com/api/e2ee/share/${token}`),
    srv.env
  );
  if (response.status !== 200) {
    return { status: response.status, frame: null } as const;
  }
  const frame = decodeE2eeFrame(new Uint8Array(await response.arrayBuffer()));
  return {
    status: 200,
    frame: {
      metadata: frame.metadata as E2eeSharedSnapshotMetadata,
      envelope: frame.payload
    }
  } as const;
}

/** A visitor opens the link: the anonymous route, then the full check. */
async function visit(
  srv: Server,
  url: string,
  now = Date.now(),
  tamper?: (frame: {
    metadata: E2eeSharedSnapshotMetadata;
    envelope: Uint8Array;
  }) => { metadata: E2eeSharedSnapshotMetadata; envelope: Uint8Array }
) {
  const parts = parseShareFragment(new URL(url).hash)!;
  const answer = await served(srv, parts.token);
  if (!answer.frame) throw new Error(`The link answered ${answer.status}`);
  const frame = tamper ? tamper(answer.frame) : answer.frame;
  return openSharedSnapshot({ parts, ...frame, now });
}

async function refusedFor(promise: Promise<unknown>, reason: string) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof ShareLinkError && error.reason === reason
  );
}

async function integrity(promise: Promise<unknown>, reason: string) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof EncryptedProjectIntegrityError && error.reason === reason
  );
}

const linkRow = (srv: Server, projectId: string, shareId: string) =>
  rows<{
    revoked_at: string | null;
    authority: string | null;
    authority_sequence: number | null;
  }>(
    srv,
    `SELECT revoked_at, authority, authority_sequence FROM e2ee_share_links
     WHERE project_id = ? AND share_id = ?`,
    projectId,
    shareId
  )[0];

const countFor = (srv: Server, table: string, projectId: string) =>
  rows<{ n: number }>(
    srv,
    `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
    projectId
  )[0]!.n;

/**
 * The owner's share-link context whose `DELETE …/share-links/:shareId`
 * fails with a transient 503 the first `times` times, as a dropped
 * connection after the tombstone committed would. `calls` names every
 * forget it was asked for.
 */
function failingForget(ctx: Device['shareLinks'], times: number) {
  const calls: string[] = [];
  let left = times;
  return {
    calls,
    ctx: {
      ...ctx,
      api: {
        ...ctx.api,
        forget: async (
          projectId: string,
          shareId: string,
          request: E2eeShareLinkForgetRequest
        ) => {
          calls.push(shareId);
          if (left-- > 0) {
            throw new E2eeShareLinkApiError(503, 'Service unavailable');
          }
          return ctx.api.forget(projectId, shareId, request);
        }
      }
    }
  };
}

const keyHashesOf = (account: Account) =>
  account.list.devices.map((device) => toBase64Url(device.signingKeyHash));

/** The authors a link's stored statement names. */
function statedAuthors(srv: Server, projectId: string, shareId: string) {
  const [row] = rows<{ authority: string }>(
    srv,
    `SELECT authority FROM e2ee_share_links
     WHERE project_id = ? AND share_id = ?`,
    projectId,
    shareId
  );
  return decodeShareAuthority(fromBase64Url(row!.authority))
    .authorKeyHashes.map((hash) => toBase64Url(hash))
    .sort();
}

/**
 * A version written straight to the Worker by `d`'s device with its own
 * current keys and the given link set: what a hostile editor's client
 * could write past its own browser's checks.
 */
async function writeWithLinks(
  srv: Server,
  d: Device,
  projectId: string,
  base: ProjectDocument,
  shareLinks: ShareLinkSet
) {
  await catchUpProjectGroup(d.groups, projectId);
  const keys = await d.sessions.epochMaterial({
    userId: d.account.userId,
    deviceId: d.deviceId!,
    projectId
  });
  const current = head(srv, projectId);
  const keyEpoch = serverKeyEpoch(srv, projectId);
  const documentVersion = current.document_version + 1;
  const sealed = await sealDocumentJob({
    type: 'seal-document',
    header: {
      kind: 'document',
      projectId,
      documentVersion,
      previousVersionHash: fromHex(current.version_hash),
      epochBindingHash: await epochBinding(
        projectId,
        keyEpoch,
        keys.epochAuthenticator
      ),
      schemaVersion: 1,
      keyEpoch
    },
    document: { ...base, version: documentVersion },
    revisionVersionHashes: new Map(),
    shareLinks
  });
  const hash = toHex(sealed.versionHash);
  const signer = d.account.devices.get(d.deviceId!)!;
  return d.documents.saveDocument(
    projectId,
    {
      expectedVersion: current.document_version,
      signature: toBase64Url(
        await signProjectEnvelope(signer.signing.privateKey, sealed.envelope)
      ),
      wrappedVersionKey: toBase64Url(
        await wrapKey(keys.projectKey, sealed.versionKey, {
          purpose: 'version-key',
          projectId,
          keyEpoch,
          kind: 'document',
          versionId: hash
        })
      ),
      signerDeviceId: signer.deviceId
    },
    sealed.envelope
  );
}

describe('creating a link (slice 5-10)', { timeout: 120_000 }, () => {
  it('writes a grant, and the anonymous route serves a snapshot that verifies end to end', async () => {
    const { srv, laptop, member, projectId, document } = await linkedProject();
    await delegate(laptop);
    const before = head(srv, projectId).document_version;

    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    expect(created.pending).toEqual([]);
    expect(created.url).toMatch(
      /^https:\/\/app\.example\/#share=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/
    );
    // The fragment names the owner's identity and round-trips.
    expect(toBase64Url(created.fragment.ownerIdentityHash)).toBe(
      toBase64Url(owner.list.identityKeyHash)
    );
    expect(parseShareFragment(formatShareFragment(created.fragment))).toEqual(
      created.fragment
    );
    // The plaintext parser never mistakes it for a plaintext link.
    expect(shareTokenFromHash(new URL(created.url).hash)).toBe(null);

    // One version carries the grant (body version 2); the editor's browser
    // verifies it on its next read.
    expect(head(srv, projectId).document_version).toBe(before + 1);
    const seen = await member.store.shareHead(projectId);
    expect(seen.shareLinks?.links.map((l) => l.shareId)).toEqual([
      created.shareId
    ]);
    expect(seen.shareLinks?.links[0]?.mode).toBe('view');

    // The visitor's check, in the ADR's order, then the snapshot opens.
    const opened = await visit(srv, created.url);
    expect(opened.verified.shareId).toBe(created.shareId);
    expect(opened.verified.mode).toBe('view');
    expect(opened.document.name).toBe(document.name);
    expect(opened.document.ownerUserId).toBe('user_shared');
    expect(opened.document.commandLog).toEqual([]);
    expect(opened.body.shareLinks).toBeUndefined();
    // The statement names the owner's and the editor's devices.
    expect(
      opened.verified.authority.authorKeyHashes
        .map((hash) => toBase64Url(hash))
        .sort()
    ).toEqual([...keyHashesOf(owner), ...keyHashesOf(other)].sort());

    // The route serves ciphertext only, never a plaintext project.
    const answer = await served(srv, created.fragment.token);
    expect(Object.keys(answer.frame!.metadata).sort()).toEqual(
      [
        'authority',
        'authorKey',
        'delegation',
        'documentVersion',
        'keyEpoch',
        'mode',
        'ownerIdentityKey',
        'shareId',
        'snapshotSignature',
        'versionId',
        'wrappedVersionKey'
      ].sort()
    );
    expect(answer.frame!.metadata.versionId).toBe(
      String(answer.frame!.metadata.documentVersion)
    );
    expect(new TextDecoder().decode(answer.frame!.envelope)).not.toContain(
      document.name
    );
    // The plaintext route knows nothing of it, and still refuses to make
    // a plaintext link for an encrypted project.
    expect(
      (
        await worker.fetch(
          new Request(
            `https://example.com/api/share/${created.fragment.token}`
          ),
          srv.env
        )
      ).status
    ).toBe(404);
    const plaintext = await srv.call(
      'POST',
      `/api/projects/${projectId}/share-links`,
      { body: { mode: 'view' } }
    );
    expect(plaintext.status).toBeGreaterThanOrEqual(400);
    expect(countFor(srv, 'project_share_links', projectId)).toBe(0);
    // An unknown token is the same opaque 404.
    expect((await served(srv, 'A'.repeat(43))).status).toBe(404);
  });

  it('lets a page save that still names the head the link replaced land on top', async () => {
    const { srv, laptop, projectId } = await linkedProject();
    await delegate(laptop);
    const opened = await laptop.store.loadProject(projectId);
    await createShareLink(laptop.shareLinks, projectId, 'tweak');
    const saved = await laptop.store.saveProjectDocument({
      projectId,
      expectedVersion: opened.version,
      document: edited(opened, 'Saved after sharing')
    });
    expect(saved.version).toBe(opened.version + 2);
    // The save carried the set on: the link is still active.
    const reread = await reload(srv, laptop, {
      members: othersOf(owner)
    }).store.shareHead(projectId);
    expect(reread.document.name).toBe('Saved after sharing');
    expect(reread.shareLinks?.links).toHaveLength(1);
  });

  it('refuses links from anyone but the owner, and checks what is stored', async () => {
    const { srv, laptop, member, projectId } = await linkedProject();
    await expect(
      createShareLink(member.shareLinks, projectId, 'view')
    ).rejects.toMatchObject({ code: 'not-owner' });
    await delegate(laptop);
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    const base = `/api/e2ee/projects/${projectId}/share-links`;
    // Only the owner states a link.
    const editorStatement = await srv.call(
      'PUT',
      `${base}/${created.shareId}/authority`,
      { user: OTHER, body: { statement: 'AAAA', signature: 'A'.repeat(87) } }
    );
    expect(editorStatement.status).toBe(403);
    // A statement must raise the link's sequence.
    const [row] = rows<{ authority: string; authority_signature: string }>(
      srv,
      `SELECT authority, authority_signature FROM e2ee_share_links
       WHERE share_id = ?`,
      created.shareId
    );
    const replay = await srv.call(
      'PUT',
      `${base}/${created.shareId}/authority`,
      {
        body: { statement: row!.authority, signature: row!.authority_signature }
      }
    );
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as { code: string }).code).toBe(
      'E2EE_SHARE_AUTHORITY_STALE'
    );
    // A delegation must raise its sequence too.
    const [stored] = rows<{ statement: string; signature: string }>(
      srv,
      'SELECT statement, signature FROM e2ee_share_delegations WHERE user_id = ?',
      OWNER
    );
    const again = await srv.call('PUT', '/api/e2ee/share-delegation', {
      body: { statement: stored!.statement, signature: stored!.signature }
    });
    expect(again.status).toBe(409);
    // A key wrap for another epoch than the group's current one is stale.
    const key = await srv.call('POST', `${base}/${created.shareId}/keys`, {
      body: {
        keyEpoch: serverKeyEpoch(srv, projectId) + 5,
        wrapped: 'A'.repeat(55),
        deviceId: 'owner_laptop',
        signature: 'A'.repeat(87)
      }
    });
    expect(key.status).toBe(409);
    // A viewer cannot publish.
    const viewer = await addMember(
      srv,
      laptop,
      projectId,
      third,
      'viewer',
      'third_laptop',
      [owner, other]
    );
    expect(
      (
        await srv.call('PUT', `${base}/${created.shareId}/snapshot`, {
          user: THIRD,
          raw: new Uint8Array(8),
          contentType: 'application/vnd.openzcad.e2ee-frame'
        })
      ).status
    ).toBe(403);
    // ...and its page does not try.
    expect(await publishShareSnapshots(viewer.shareLinks, projectId)).toEqual({
      published: [],
      failed: []
    });
  });
});

describe('registering a link (slice 8-C1)', { timeout: 120_000 }, () => {
  /**
   * `POST …/share-links` as OWNER's session for a fresh link, naming
   * `deviceId` and signed by OWNER's `signer` over the body (`signed`
   * overrides what was signed, `body` what is sent).
   */
  async function registerAs(
    srv: Server,
    projectId: string,
    signer: string,
    deviceId: string,
    options: {
      signed?: Partial<{ tokenHash: string; mode: 'view' | 'tweak' }>;
      body?: Record<string, unknown>;
    } = {}
  ) {
    const shareId = `shr_${toBase64Url(randomBytes(16))}`;
    const tokenHash = toHex(randomBytes(32));
    const keyHash = randomBytes(32);
    const keyEpoch = serverKeyEpoch(srv, projectId);
    const wrapped = randomBytes(41);
    const signature = await signShareLinkRegistration(
      owner.devices.get(signer)!.signing.privateKey,
      {
        projectId,
        shareId,
        tokenHash: fromHex(options.signed?.tokenHash ?? tokenHash),
        mode: options.signed?.mode ?? 'view',
        shareKeyHash: keyHash,
        ownerIdentityKeyHash: owner.list.identityKeyHash,
        keyEpoch,
        wrapped
      }
    );
    const response = await srv.call(
      'POST',
      `/api/e2ee/projects/${projectId}/share-links`,
      {
        user: OWNER,
        body: {
          shareId,
          tokenHash,
          mode: 'view',
          shareKeyHash: toBase64Url(keyHash),
          ownerIdentityHash: toBase64Url(owner.list.identityKeyHash),
          key: { keyEpoch, wrapped: toBase64Url(wrapped) },
          deviceId,
          signature: toBase64Url(signature),
          ...options.body
        }
      }
    );
    return {
      shareId,
      status: response.status,
      code: ((await response.json()) as { code?: string }).code
    };
  }

  const randomBytes = (length: number) =>
    crypto.getRandomValues(new Uint8Array(length));

  it('refuses a removed owner device whose session stays signed in, and a signature over anything else', async () => {
    const { srv, laptop, projectId } = await linkedProject();
    await delegate(laptop);
    const links = () => countFor(srv, 'e2ee_share_links', projectId);
    await owner.revoke(srv.db, 'owner_desktop');
    try {
      // The removed device names itself...
      expect(
        await registerAs(srv, projectId, 'owner_desktop', 'owner_desktop')
      ).toMatchObject({ status: 403, code: 'E2EE_DEVICE_NOT_CERTIFIED' });
      // ...or a sibling it cannot sign for...
      expect(
        await registerAs(srv, projectId, 'owner_desktop', 'owner_laptop')
      ).toMatchObject({ status: 400, code: 'E2EE_SIGNATURE_INVALID' });
      // ...or registers as the owner account alone, as before.
      expect(
        await registerAs(srv, projectId, 'owner_laptop', 'owner_laptop', {
          body: { deviceId: undefined, signature: undefined }
        })
      ).toMatchObject({ status: 400 });
      // A certified device's signature over another token or mode.
      expect(
        await registerAs(srv, projectId, 'owner_laptop', 'owner_laptop', {
          signed: { tokenHash: toHex(randomBytes(32)) }
        })
      ).toMatchObject({ status: 400, code: 'E2EE_SIGNATURE_INVALID' });
      expect(
        await registerAs(srv, projectId, 'owner_laptop', 'owner_laptop', {
          signed: { mode: 'tweak' }
        })
      ).toMatchObject({ status: 400, code: 'E2EE_SIGNATURE_INVALID' });
      expect(links()).toBe(0);
      // The certified device's own registration lands, and the page's too.
      expect(
        await registerAs(srv, projectId, 'owner_laptop', 'owner_laptop')
      ).toMatchObject({ status: 201 });
      const created = await createShareLink(
        laptop.shareLinks,
        projectId,
        'view'
      );
      expect((await served(srv, created.fragment.token)).status).toBe(200);
      expect(links()).toBe(2);
    } finally {
      owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
    }
  });

  it('a device-list change between the device check and the insert registers nothing', async () => {
    const { srv, laptop, projectId } = await linkedProject();
    await delegate(laptop);
    const push = srv.statements.push.bind(srv.statements);
    srv.statements.push = (...sql: string[]) => {
      if (sql.some((s) => /^\s*INSERT INTO e2ee_share_links/.test(s))) {
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
    expect(
      await registerAs(srv, projectId, 'owner_laptop', 'owner_laptop')
    ).toMatchObject({ status: 409, code: 'E2EE_DEVICE_LIST_CHANGED' });
    expect(srv.statements.push).toBe(push);
    expect(countFor(srv, 'e2ee_share_links', projectId)).toBe(0);
    expect(countFor(srv, 'e2ee_share_keys', projectId)).toBe(0);
  });
});

describe('revoking a link (slice 5-10)', { timeout: 120_000 }, () => {
  it('tombstones it in a version, the server forgets it, and a dropped tombstone is refused', async () => {
    const { srv, laptop, member, projectId } = await linkedProject();
    await delegate(laptop);
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    const granted = await member.store.shareHead(projectId);
    const grantSet = granted.shareLinks!.set;

    await revokeShareLink(laptop.shareLinks, projectId, created.shareId);

    // The snapshot is gone: the visitor gets the opaque 404.
    expect((await served(srv, created.fragment.token)).status).toBe(404);
    expect(countFor(srv, 'e2ee_share_snapshots', projectId)).toBe(0);
    expect(countFor(srv, 'e2ee_share_keys', projectId)).toBe(0);
    expect(linkRow(srv, projectId, created.shareId)).toMatchObject({
      authority_sequence: null
    });
    expect(linkRow(srv, projectId, created.shareId)!.revoked_at).not.toBe(null);
    // The head lists no active link and keeps the tombstone; the editor's
    // browser remembers it.
    const after = await member.store.shareHead(projectId);
    expect(after.shareLinks?.links).toEqual([]);
    expect(after.shareLinks?.tombstones.map((t) => t.shareId)).toEqual([
      created.shareId
    ]);
    expect((await member.pins.read(OTHER, projectId))?.tombstones).toEqual([
      created.shareId
    ]);
    expect((await listShareLinks(laptop.shareLinks, projectId)).links).toEqual(
      []
    );

    // A hostile editor writes the old grant back and drops the tombstone.
    await writeWithLinks(srv, member, projectId, after.document, grantSet);
    // The owner's page refuses it against the head it held...
    await integrity(laptop.store.loadProject(projectId), 'share-links');
    // ...and so does a reloaded page, from the tombstone it remembers.
    await integrity(
      reload(srv, laptop, { members: othersOf(owner) }).store.loadProject(
        projectId
      ),
      'share-links'
    );
  });

  it('refuses an editor’s change of the set, even one that only drops a link', async () => {
    const { srv, laptop, member, projectId } = await linkedProject();
    await delegate(laptop);
    await createShareLink(laptop.shareLinks, projectId, 'view');
    const granted = await laptop.store.shareHead(projectId);
    await writeWithLinks(srv, member, projectId, granted.document, {
      grants: [],
      tombstones: []
    });
    await integrity(laptop.store.loadProject(projectId), 'share-links');
  });

  it('asks the server again when its forget fails after the tombstone, and a second revoke does not throw', async () => {
    const { srv, laptop, projectId } = await linkedProject();
    await delegate(laptop);
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    const flaky = failingForget(laptop.shareLinks, 1);

    await expect(
      revokeShareLink(flaky.ctx, projectId, created.shareId)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ShareLinksError && error.code === 'revocation-pending'
    );
    expect(flaky.calls).toEqual([created.shareId]);
    // The tombstone committed, but the anonymous route still serves it.
    const revokedHead = await laptop.store.shareHead(projectId);
    expect(revokedHead.shareLinks?.links).toEqual([]);
    expect(revokedHead.shareLinks?.tombstonedIds.has(created.shareId)).toBe(
      true
    );
    expect((await served(srv, created.fragment.token)).status).toBe(200);
    // The owner's dialog keeps it listed, as revocation pending.
    expect(
      (await listShareLinks(laptop.shareLinks, projectId)).links
    ).toMatchObject([
      { shareId: created.shareId, status: 'revocation-pending', url: null }
    ]);

    // Revoking it again writes nothing and only asks the server again.
    const version = head(srv, projectId).document_version;
    await revokeShareLink(flaky.ctx, projectId, created.shareId);
    expect(flaky.calls).toEqual([created.shareId, created.shareId]);
    expect(head(srv, projectId).document_version).toBe(version);
    expect((await served(srv, created.fragment.token)).status).toBe(404);
    expect(linkRow(srv, projectId, created.shareId)!.revoked_at).not.toBe(null);
    expect((await listShareLinks(laptop.shareLinks, projectId)).links).toEqual(
      []
    );
    // And once more: the server forgot it, nothing is left to ask.
    await revokeShareLink(flaky.ctx, projectId, created.shareId);
    expect(flaky.calls).toHaveLength(2);
  });

  it('the dialog’s upkeep and a later revoke ask again for a revocation whose forget failed', async () => {
    const { srv, laptop, projectId } = await linkedProject();
    await delegate(laptop);
    const first = await createShareLink(laptop.shareLinks, projectId, 'view');
    const second = await createShareLink(laptop.shareLinks, projectId, 'view');
    const third = await createShareLink(laptop.shareLinks, projectId, 'view');
    const down = failingForget(laptop.shareLinks, Infinity);
    await expect(
      revokeShareLink(down.ctx, projectId, first.shareId)
    ).rejects.toBeInstanceOf(ShareLinksError);

    // The dialog loads the links while the server still fails: no throw,
    // the failure is reported and the link stays pending.
    const failing = await maintainShareLinks(down.ctx, projectId);
    expect(failing.revocations.forgotten).toEqual([]);
    expect(failing.revocations.failed.map((f) => f.shareId)).toEqual([
      first.shareId
    ]);
    expect((await served(srv, first.fragment.token)).status).toBe(200);

    // The server recovers: the next load forgets it.
    const upkeep = await maintainShareLinks(laptop.shareLinks, projectId);
    expect(upkeep.revocations).toEqual({
      forgotten: [first.shareId],
      failed: []
    });
    expect((await served(srv, first.fragment.token)).status).toBe(404);
    expect((await served(srv, second.fragment.token)).status).toBe(200);

    // A failed forget is asked for again by the next revoke of another link.
    await expect(
      revokeShareLink(
        failingForget(laptop.shareLinks, 1).ctx,
        projectId,
        second.shareId
      )
    ).rejects.toBeInstanceOf(ShareLinksError);
    expect((await served(srv, second.fragment.token)).status).toBe(200);
    await revokeShareLink(laptop.shareLinks, projectId, third.shareId);
    expect((await served(srv, second.fragment.token)).status).toBe(404);
    expect((await served(srv, third.fragment.token)).status).toBe(404);
    expect((await listShareLinks(laptop.shareLinks, projectId)).links).toEqual(
      []
    );
  });
});

describe('forgetting a link (slice 5-10)', { timeout: 120_000 }, () => {
  /**
   * `DELETE …/share-links/:shareId` as OWNER's session, naming `deviceId`
   * and signed by OWNER's `signer` over `signed` (this link at the current
   * key epoch unless given).
   */
  async function forgetAs(
    srv: Server,
    projectId: string,
    shareId: string,
    signer: string,
    deviceId: string,
    signed: { shareId?: string; keyEpoch?: number } = {}
  ) {
    const keyEpoch = signed.keyEpoch ?? serverKeyEpoch(srv, projectId);
    const signature = await signShareLinkForget(
      owner.devices.get(signer)!.signing.privateKey,
      { projectId, shareId: signed.shareId ?? shareId, keyEpoch }
    );
    return answer(
      await srv.call(
        'DELETE',
        `/api/e2ee/projects/${projectId}/share-links/${shareId}`,
        {
          user: OWNER,
          body: { keyEpoch, deviceId, signature: toBase64Url(signature) }
        }
      )
    );
  }

  const answer = async (response: Response) => ({
    status: response.status,
    code: ((await response.json()) as { code?: string }).code
  });

  /** The link still serves its snapshot, with its key wraps and statement. */
  function stillServes(srv: Server, projectId: string, link: CreatedShareLink) {
    return (async () => {
      expect((await served(srv, link.fragment.token)).status).toBe(200);
      expect(linkRow(srv, projectId, link.shareId)!.revoked_at).toBe(null);
      expect(
        linkRow(srv, projectId, link.shareId)!.authority_sequence
      ).not.toBe(null);
    })();
  }

  it('refuses a removed owner device whose session stays signed in, and the owner’s certified device still revokes', async () => {
    const { srv, laptop, projectId } = await linkedProject();
    await delegate(laptop);
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    await owner.revoke(srv.db, 'owner_desktop');
    try {
      // The removed device names itself...
      expect(
        await forgetAs(
          srv,
          projectId,
          created.shareId,
          'owner_desktop',
          'owner_desktop'
        )
      ).toEqual({ status: 403, code: 'E2EE_DEVICE_NOT_CERTIFIED' });
      // ...or a sibling it cannot sign for...
      expect(
        await forgetAs(
          srv,
          projectId,
          created.shareId,
          'owner_desktop',
          'owner_laptop'
        )
      ).toEqual({ status: 400, code: 'E2EE_SIGNATURE_INVALID' });
      // ...or asks as the owner account alone, as before.
      expect(
        await answer(
          await srv.call(
            'DELETE',
            `/api/e2ee/projects/${projectId}/share-links/${created.shareId}`,
            { user: OWNER }
          )
        )
      ).toMatchObject({ status: 400 });
      await stillServes(srv, projectId, created);
      expect(countFor(srv, 'e2ee_share_keys', projectId)).toBeGreaterThan(0);

      // The owner's certified device revokes, and the server forgets it.
      await revokeShareLink(laptop.shareLinks, projectId, created.shareId);
      expect((await served(srv, created.fragment.token)).status).toBe(404);
      expect(linkRow(srv, projectId, created.shareId)!.revoked_at).not.toBe(
        null
      );
      expect(countFor(srv, 'e2ee_share_keys', projectId)).toBe(0);
      expect(countFor(srv, 'e2ee_share_snapshots', projectId)).toBe(0);
    } finally {
      owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
    }
  });

  it('refuses a signature for another link or another key epoch', async () => {
    const { srv, laptop, projectId } = await linkedProject();
    await delegate(laptop);
    const first = await createShareLink(laptop.shareLinks, projectId, 'view');
    const second = await createShareLink(laptop.shareLinks, projectId, 'view');
    const keyEpoch = serverKeyEpoch(srv, projectId);
    expect(keyEpoch).toBeGreaterThan(0);
    // A signature over the first link replayed against the second.
    expect(
      await forgetAs(
        srv,
        projectId,
        second.shareId,
        'owner_laptop',
        'owner_laptop',
        { shareId: first.shareId }
      )
    ).toEqual({ status: 400, code: 'E2EE_SIGNATURE_INVALID' });
    // A signature over an earlier key epoch, or a later one.
    for (const epoch of [keyEpoch - 1, keyEpoch + 1]) {
      expect(
        await forgetAs(
          srv,
          projectId,
          second.shareId,
          'owner_laptop',
          'owner_laptop',
          { keyEpoch: epoch }
        )
      ).toEqual({ status: 409, code: 'E2EE_EPOCH_STALE' });
    }
    // The current epoch's claimed but an earlier one's signed.
    const signature = await signShareLinkForget(
      owner.devices.get('owner_laptop')!.signing.privateKey,
      { projectId, shareId: second.shareId, keyEpoch: keyEpoch - 1 }
    );
    expect(
      await answer(
        await srv.call(
          'DELETE',
          `/api/e2ee/projects/${projectId}/share-links/${second.shareId}`,
          {
            body: {
              keyEpoch,
              deviceId: 'owner_laptop',
              signature: toBase64Url(signature)
            }
          }
        )
      )
    ).toEqual({ status: 400, code: 'E2EE_SIGNATURE_INVALID' });
    await stillServes(srv, projectId, first);
    await stillServes(srv, projectId, second);
    // The certified device's own signature over the link forgets it.
    expect(
      await forgetAs(
        srv,
        projectId,
        second.shareId,
        'owner_laptop',
        'owner_laptop'
      )
    ).toEqual({ status: 200, code: undefined });
    expect((await served(srv, second.fragment.token)).status).toBe(404);
    await stillServes(srv, projectId, first);
  });

  it('a device-list change between the device check and the forget changes nothing', async () => {
    const { srv, laptop, projectId } = await linkedProject();
    await delegate(laptop);
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    const keys = countFor(srv, 'e2ee_share_keys', projectId);
    // The owner's list moves on (a removal, say) after the signer was
    // checked and before the link is forgotten.
    const push = srv.statements.push.bind(srv.statements);
    srv.statements.push = (...sql: string[]) => {
      if (
        sql.some((s) => /^\s*UPDATE e2ee_share_links\s+SET revoked_at/.test(s))
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
          .run(OWNER);
      }
      return push(...sql);
    };
    expect(
      await forgetAs(
        srv,
        projectId,
        created.shareId,
        'owner_laptop',
        'owner_laptop'
      )
    ).toEqual({ status: 409, code: 'E2EE_DEVICE_LIST_CHANGED' });
    expect(srv.statements.push).toBe(push);
    await stillServes(srv, projectId, created);
    expect(countFor(srv, 'e2ee_share_keys', projectId)).toBe(keys);
    expect(countFor(srv, 'e2ee_share_snapshots', projectId)).toBe(1);
  });
});

describe('republishing on save (slice 5-10)', { timeout: 120_000 }, () => {
  it('an editor’s save republishes every active link’s snapshot under its own key', async () => {
    const { srv, laptop, member, projectId } = await linkedProject();
    await delegate(laptop);
    const first = await createShareLink(laptop.shareLinks, projectId, 'view');
    const second = await createShareLink(laptop.shareLinks, projectId, 'tweak');
    const opened = await member.store.loadProject(projectId);
    await member.store.saveProjectDocument({
      projectId,
      expectedVersion: opened.version,
      document: edited(opened, 'Edited by the editor')
    });
    await Promise.all(member.shareWork);
    for (const link of [first, second]) {
      const seen = await visit(srv, link.url);
      expect(seen.document.name).toBe('Edited by the editor');
      expect(toBase64Url(seen.verified.authorKeyHash)).toBe(
        toBase64Url(
          other.list.devices.find((d) => d.deviceId === 'other_laptop')!
            .signingKeyHash
        )
      );
    }
    // One envelope per link, each with its own version key.
    const snapshots = rows<{ snapshot_hash: string; signer_user_id: string }>(
      srv,
      `SELECT snapshot_hash, signer_user_id FROM e2ee_share_snapshots
       WHERE project_id = ?`,
      projectId
    );
    expect(snapshots.map((s) => s.signer_user_id)).toEqual([OTHER, OTHER]);
    expect(new Set(snapshots.map((s) => s.snapshot_hash)).size).toBe(2);
    // The editor carried the set on unchanged: the owner reads it.
    const ownerView = await laptop.store.shareHead(projectId);
    expect(ownerView.shareLinks?.links).toHaveLength(2);
  });
});

describe(
  'statements after a removal (slice 5-10)',
  { timeout: 120_000 },
  () => {
    it('removing an editor issues a new statement without its devices', async () => {
      const { srv, laptop, member, projectId } = await linkedProject();
      await delegate(laptop);
      const created = await createShareLink(
        laptop.shareLinks,
        projectId,
        'view'
      );
      const opened = await member.store.loadProject(projectId);
      await member.store.saveProjectDocument({
        projectId,
        expectedVersion: opened.version,
        document: edited(opened, 'Before removal')
      });
      await Promise.all(member.shareWork);
      expect(linkRow(srv, projectId, created.shareId)!.authority_sequence).toBe(
        0
      );
      // The 5-5 hook, as the page wires it.
      const work: Promise<unknown>[] = [];
      (
        laptop.groups as { onMembersRemoved?: (r: MembersRemoved) => void }
      ).onMembersRemoved = (removal) =>
        work.push(shareLinksAfterRemoval(laptop.shareLinks, removal));
      await removeMember(laptop.groups, projectId, OTHER);
      await Promise.all(work);
      expect(linkRow(srv, projectId, created.shareId)!.authority_sequence).toBe(
        1
      );
      expect(statedAuthors(srv, projectId, created.shareId)).toEqual(
        keyHashesOf(owner).sort()
      );
      // The removed editor's snapshot is no longer one visitors accept...
      await refusedFor(visit(srv, created.url), 'author-not-named');
      // ...until the owner's next save republishes it.
      const read = await laptop.store.loadProject(projectId);
      await laptop.store.saveProjectDocument({
        projectId,
        expectedVersion: read.version,
        document: edited(read, 'After removal')
      });
      await Promise.all(laptop.shareWork);
      expect((await visit(srv, created.url)).document.name).toBe(
        'After removal'
      );
      // Reissue gives a new link and key; the old one stops serving.
      const [reissued] = await reissueShareLinks(laptop.shareLinks, projectId, [
        { shareId: created.shareId, mode: 'view' }
      ]);
      expect(reissued!.shareId).not.toBe(created.shareId);
      expect((await served(srv, created.fragment.token)).status).toBe(404);
      expect((await visit(srv, reissued!.url)).document.name).toBe(
        'After removal'
      );
    });

    it('an editor’s revoked device drops out of the next statement', async () => {
      const { srv, laptop, projectId } = await linkedProject();
      await delegate(laptop);
      const created = await createShareLink(
        laptop.shareLinks,
        projectId,
        'view'
      );
      expect(statedAuthors(srv, projectId, created.shareId)).toContain(
        toBase64Url(
          other.list.devices.find((d) => d.deviceId === 'other_desktop')!
            .signingKeyHash
        )
      );
      const revoked = other.list.devices.find(
        (d) => d.deviceId === 'other_desktop'
      )!;
      await other.revoke(srv.db, 'other_desktop');
      try {
        const upkeep = await maintainShareLinks(laptop.shareLinks, projectId);
        expect(upkeep.authorities.issued).toEqual([created.shareId]);
        expect(statedAuthors(srv, projectId, created.shareId)).not.toContain(
          toBase64Url(revoked.signingKeyHash)
        );
        // Nothing changed since: the statement stays.
        const again = await maintainShareLinks(laptop.shareLinks, projectId);
        expect(again.authorities.current).toEqual([created.shareId]);
      } finally {
        other = await makeAccount(OTHER, ['other_laptop', 'other_desktop']);
      }
    });

    it('an editor’s device removal rotating the project issues a statement at once (5-7 with 5-10)', async () => {
      const { srv, laptop, member, projectId } = await linkedProject();
      // The editor's second device holds a leaf of its own.
      const desktop = device(srv, other, 'other_desktop', {
        members: othersOf(other)
      });
      await joinProjectGroup(desktop.groups, projectId);
      // Both pages process its join while the device is still listed.
      await catchUpProjectGroup(member.groups, projectId);
      await catchUpProjectGroup(laptop.groups, projectId);
      await delegate(laptop);
      const created = await createShareLink(
        laptop.shareLinks,
        projectId,
        'view'
      );
      const revoked = other.list.devices.find(
        (d) => d.deviceId === 'other_desktop'
      )!;
      expect(statedAuthors(srv, projectId, created.shareId)).toContain(
        toBase64Url(revoked.signingKeyHash)
      );
      const sequence = linkRow(
        srv,
        projectId,
        created.shareId
      )!.authority_sequence!;
      // The hook, as the page wires it.
      const heard: MemberDevicesRemoved[] = [];
      const work: Promise<unknown>[] = [];
      (
        laptop.groups as {
          onMemberDevicesRemoved?: (r: MemberDevicesRemoved) => void;
        }
      ).onMemberDevicesRemoved = (removal) => {
        heard.push(removal);
        work.push(shareLinksAfterDeviceRemoval(laptop.shareLinks, removal));
      };
      await other.revoke(srv.db, 'other_desktop');
      try {
        // The editor's other device rotates: a Remove of its revoked leaf.
        await ensureProjectRotated(member.groups, projectId);
        // The owner's page processes that Commit, with no save of its own.
        await catchUpProjectGroup(laptop.groups, projectId);
        await Promise.all(work);
        expect(heard).toEqual([
          {
            projectId,
            keyEpoch: serverKeyEpoch(srv, projectId),
            devices: [{ userId: OTHER, deviceId: 'other_desktop' }]
          }
        ]);
        expect(
          linkRow(srv, projectId, created.shareId)!.authority_sequence
        ).toBe(sequence + 1);
        const authors = statedAuthors(srv, projectId, created.shareId);
        expect(authors).not.toContain(toBase64Url(revoked.signingKeyHash));
        expect(authors).toContain(
          toBase64Url(
            other.list.devices.find((d) => d.deviceId === 'other_laptop')!
              .signingKeyHash
          )
        );
        // The editor's own page hears nothing to state: only the owner signs.
        expect(
          await shareLinksAfterDeviceRemoval(member.shareLinks, heard[0]!)
        ).toBeNull();
      } finally {
        other = await makeAccount(OTHER, ['other_laptop', 'other_desktop']);
      }
    });
  }
);

describe('share-key wraps (slice 5-10)', { timeout: 120_000 }, () => {
  /**
   * A link created at the owner's key epoch, then the editor's second
   * device revoked (OTHER stays an editor) and the project rotated past it:
   * the link has no wrap for the new epoch yet, so the first one stored
   * for it wins. Restores OTHER's account after `run`.
   */
  async function rotatedLink(
    run: (setup: {
      srv: Server;
      laptop: Device;
      member: Device;
      projectId: string;
      created: CreatedShareLink;
      keyEpoch: number;
      previous: number;
    }) => Promise<void>
  ) {
    const { srv, laptop, member, projectId } = await linkedProject();
    const desktop = device(srv, other, 'other_desktop', {
      members: othersOf(other)
    });
    await joinProjectGroup(desktop.groups, projectId);
    await catchUpProjectGroup(member.groups, projectId);
    await catchUpProjectGroup(laptop.groups, projectId);
    await delegate(laptop);
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    const before = serverKeyEpoch(srv, projectId);
    await other.revoke(srv.db, 'other_desktop');
    try {
      await ensureProjectRotated(member.groups, projectId);
      await catchUpProjectGroup(laptop.groups, projectId);
      const keyEpoch = serverKeyEpoch(srv, projectId);
      expect(keyEpoch).toBeGreaterThan(before);
      expect(wrapEpochs(srv, created.shareId)).toEqual([before]);
      await run({
        srv,
        laptop,
        member,
        projectId,
        created,
        keyEpoch,
        previous: before
      });
    } finally {
      other = await makeAccount(OTHER, ['other_laptop', 'other_desktop']);
    }
  }

  const wrapEpochs = (srv: Server, shareId: string) =>
    rows<{ key_epoch: number }>(
      srv,
      `SELECT key_epoch FROM e2ee_share_keys WHERE share_id = ?
       ORDER BY key_epoch`,
      shareId
    ).map((row) => row.key_epoch);

  /** A wrap of random bytes `signer` signs, posted as OTHER naming `deviceId`. */
  async function postWrap(
    srv: Server,
    projectId: string,
    shareId: string,
    keyEpoch: number,
    signer: string,
    deviceId: string
  ) {
    const wrapped = crypto.getRandomValues(new Uint8Array(41));
    const signature = await signShareKeyWrap(
      other.devices.get(signer)!.signing.privateKey,
      { projectId, shareId, keyEpoch, wrapped }
    );
    const response = await srv.call(
      'POST',
      `/api/e2ee/projects/${projectId}/share-links/${shareId}/keys`,
      {
        user: OTHER,
        body: {
          keyEpoch,
          wrapped: toBase64Url(wrapped),
          deviceId,
          signature: toBase64Url(signature)
        }
      }
    );
    return {
      status: response.status,
      code: ((await response.json()) as { code?: string }).code
    };
  }

  it('refuses a wrap from a revoked device of an account that stays an editor', async () => {
    await rotatedLink(
      async ({ srv, projectId, created, keyEpoch, previous }) => {
        // The revoked device's session names itself...
        expect(
          await postWrap(
            srv,
            projectId,
            created.shareId,
            keyEpoch,
            'other_desktop',
            'other_desktop'
          )
        ).toEqual({ status: 403, code: 'E2EE_DEVICE_NOT_CERTIFIED' });
        // ...or a sibling it cannot sign for.
        expect(
          await postWrap(
            srv,
            projectId,
            created.shareId,
            keyEpoch,
            'other_desktop',
            'other_laptop'
          )
        ).toEqual({ status: 400, code: 'E2EE_SIGNATURE_INVALID' });
        expect(wrapEpochs(srv, created.shareId)).toEqual([previous]);
      }
    );
  });

  it('a certified device’s wrap still lands after a revoked device tried first, and the link keeps publishing', async () => {
    await rotatedLink(
      async ({
        srv,
        laptop,
        member,
        projectId,
        created,
        keyEpoch,
        previous
      }) => {
        await postWrap(
          srv,
          projectId,
          created.shareId,
          keyEpoch,
          'other_desktop',
          'other_desktop'
        );
        // The editor's certified page republishes under the new epoch: it
        // wraps the share key for it, signed by its own device.
        const outcome = await publishShareSnapshots(
          member.shareLinks,
          projectId
        );
        expect(outcome.failed).toEqual([]);
        expect(outcome.published).toEqual([created.shareId]);
        expect(wrapEpochs(srv, created.shareId)).toEqual([previous, keyEpoch]);
        const [stored] = rows<{ created_by_user_id: string }>(
          srv,
          `SELECT created_by_user_id FROM e2ee_share_keys
         WHERE share_id = ? AND key_epoch = ?`,
          created.shareId,
          keyEpoch
        );
        expect(stored!.created_by_user_id).toBe(OTHER);
        // Every member opens the stored wrap, and visitors the snapshot.
        expect(
          (await listShareLinks(laptop.shareLinks, projectId)).links[0]!.url
        ).toBe(created.url);
        expect((await visit(srv, created.url)).verified.shareId).toBe(
          created.shareId
        );
      }
    );
  });

  it('a stored wrap that does not open does not hide an older one that does', async () => {
    await rotatedLink(async ({ srv, laptop, member, projectId, created }) => {
      // A wrap no member can open, stored first for the new epoch (as one
      // could before the server asked for a certified device's signature).
      const keyEpoch = serverKeyEpoch(srv, projectId);
      srv.db
        .prepare(
          `INSERT INTO e2ee_share_keys
             (project_id, share_id, key_epoch, wrapped, created_by_user_id,
              created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          projectId,
          created.shareId,
          keyEpoch,
          toBase64Url(crypto.getRandomValues(new Uint8Array(41))),
          OTHER,
          new Date().toISOString()
        );
      const outcome = await publishShareSnapshots(member.shareLinks, projectId);
      expect(outcome).toEqual({ published: [created.shareId], failed: [] });
      expect(
        (await listShareLinks(laptop.shareLinks, projectId)).links[0]!.url
      ).toBe(created.url);
      expect((await visit(srv, created.url)).verified.shareId).toBe(
        created.shareId
      );
    });
  });

  it('a device-list change between the device check and the insert stores nothing', async () => {
    await rotatedLink(
      async ({ srv, projectId, created, keyEpoch, previous }) => {
        // The list moves on (a removal, say) after the signer was checked
        // and before the wrap is inserted.
        const push = srv.statements.push.bind(srv.statements);
        srv.statements.push = (...sql: string[]) => {
          if (sql.some((s) => /^\s*INSERT INTO e2ee_share_keys/.test(s))) {
            srv.statements.push = push;
            srv.db
              .prepare(
                `INSERT INTO e2ee_device_list_entries
               SELECT user_id, generation, sequence + 1, entry, signature,
                      substr(entry_hash, 2) || '0', created_at
               FROM e2ee_device_list_entries WHERE user_id = ?
               ORDER BY sequence DESC LIMIT 1`
              )
              .run(OTHER);
          }
          return push(...sql);
        };
        expect(
          await postWrap(
            srv,
            projectId,
            created.shareId,
            keyEpoch,
            'other_laptop',
            'other_laptop'
          )
        ).toEqual({ status: 409, code: 'E2EE_DEVICE_LIST_CHANGED' });
        expect(srv.statements.push).toBe(push);
        expect(wrapEpochs(srv, created.shareId)).toEqual([previous]);
      }
    );
  });
});

describe('the delegation (slice 5-10)', { timeout: 120_000 }, () => {
  it('needs confirming without one, and visitors refuse links once it expires', async () => {
    let clock = Date.now();
    const { srv, laptop, projectId } = await linkedProject(() => clock);
    expect((await shareDelegationState(laptop.shareLinks)).status).toBe(
      'missing'
    );
    // Without a delegation the link exists but has no statement yet.
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    expect(created.pending).toEqual(['authority']);
    expect((await served(srv, created.fragment.token)).status).toBe(404);
    // The passkey touch when sharing opens.
    expect((await delegate(laptop)).status).toBe('valid');
    expect(
      (await issueShareAuthorities(laptop.shareLinks, projectId)).issued
    ).toEqual([created.shareId]);
    const now = clock;
    expect((await visit(srv, created.url, now)).document).toBeTruthy();
    const listed = await listShareLinks(laptop.shareLinks, projectId);
    expect(listed.links).toMatchObject([
      { shareId: created.shareId, status: 'active', url: created.url }
    ]);
    // A statement lasts seven days, the delegation 30.
    await refusedFor(
      visit(srv, created.url, now + 8 * DAY),
      'authority-expired'
    );
    await refusedFor(
      visit(srv, created.url, now + 31 * DAY),
      'delegation-expired'
    );
    // In its last week the owner's browser asks to renew it, and after it
    // the link needs confirming.
    clock = now + 24 * DAY;
    expect((await shareDelegationState(laptop.shareLinks)).status).toBe(
      'expiring'
    );
    clock = now + 31 * DAY;
    expect((await shareDelegationState(laptop.shareLinks)).status).toBe(
      'expired'
    );
    expect(
      (await listShareLinks(laptop.shareLinks, projectId)).links[0]?.status
    ).toBe('needs-confirming');
  });

  it('a new device makes it stale, and the server takes only certified devices', async () => {
    const { srv, laptop } = await linkedProject();
    await delegate(laptop);
    // Signed for another account's device: the server refuses it.
    const forged = await signShareDelegation(owner.identityPrivateKey, {
      identityKeyHash: owner.list.identityKeyHash,
      sequence: 9,
      issuedAt: Date.now(),
      expiresAt: Date.now() + DAY,
      deviceKeys: [other.list.devices[0]!.signingKey]
    });
    const refused = await srv.call('PUT', '/api/e2ee/share-delegation', {
      body: {
        statement: toBase64Url(forged.statement),
        signature: toBase64Url(forged.signature)
      }
    });
    expect(refused.status).toBe(400);
    // One naming fewer devices than the owner has is stale.
    const partial = await signShareDelegation(owner.identityPrivateKey, {
      identityKeyHash: owner.list.identityKeyHash,
      sequence: 10,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 20 * DAY,
      deviceKeys: [owner.list.devices[0]!.signingKey]
    });
    expect(
      (
        await srv.call('PUT', '/api/e2ee/share-delegation', {
          body: {
            statement: toBase64Url(partial.statement),
            signature: toBase64Url(partial.signature)
          }
        })
      ).status
    ).toBe(200);
    expect((await shareDelegationState(laptop.shareLinks)).status).toBe(
      'stale-devices'
    );
  });

  it('a device-list change between the device check and the write stores nothing (slice 8-C1)', async () => {
    const { srv, laptop } = await linkedProject();
    await delegate(laptop);
    const stored = () =>
      rows(
        srv,
        'SELECT * FROM e2ee_share_delegations WHERE user_id = ?',
        OWNER
      );
    const before = stored();
    // A delegation still naming the owner's desktop, whose removal lands
    // after the devices were checked and before the delegation is written.
    const stale = await signShareDelegation(owner.identityPrivateKey, {
      identityKeyHash: owner.list.identityKeyHash,
      sequence: 50,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 20 * DAY,
      deviceKeys: owner.list.devices.map((device) => device.signingKey)
    });
    const push = srv.statements.push.bind(srv.statements);
    srv.statements.push = (...sql: string[]) => {
      if (sql.some((s) => /^\s*INSERT INTO e2ee_share_delegations/.test(s))) {
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
    const response = await srv.call('PUT', '/api/e2ee/share-delegation', {
      body: {
        statement: toBase64Url(stale.statement),
        signature: toBase64Url(stale.signature)
      }
    });
    expect(srv.statements.push).toBe(push);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe(
      'E2EE_DEVICE_LIST_CHANGED'
    );
    expect(stored()).toEqual(before);
  });
});

describe('an owner device removal (slice 5-10)', { timeout: 120_000 }, () => {
  it('replaces statements signed by the removed owner device without another save or dialog open', async () => {
    const { srv, laptop, projectId } = await linkedProject();
    await delegate(laptop);
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    const recorded = (await laptop.shareLinks.api.list(projectId)).links[0]!
      .authority!;
    const value = decodeShareAuthority(fromBase64Url(recorded.statement));
    const removed = owner.list.devices.find(
      (device) => device.deviceId === 'owner_desktop'
    )!;
    const signed = await signShareAuthority(
      owner.devices.get('owner_desktop')!.signing.privateKey,
      {
        ...value,
        sequence: value.sequence + 1,
        signerKeyHash: removed.signingKeyHash
      }
    );
    await laptop.shareLinks.api.putAuthority(projectId, created.shareId, {
      statement: toBase64Url(signed.statement),
      signature: toBase64Url(signed.signature)
    });
    await owner.revoke(srv.db, 'owner_desktop');
    try {
      await delegate(laptop);
      await expect(visit(srv, created.url)).rejects.toBeInstanceOf(
        ShareLinkError
      );
      // One inaccessible project must not leave the remaining statements stale.
      const failed = await refreshOwnerShareAuthorities(laptop.shareLinks, [
        'proj_missing',
        projectId,
        projectId
      ]);
      expect(failed.map((entry) => entry.projectId)).toEqual(['proj_missing']);
      const next = decodeShareAuthority(
        fromBase64Url(
          (await laptop.shareLinks.api.list(projectId)).links[0]!.authority!
            .statement
        )
      );
      expect(toBase64Url(next.signerKeyHash)).not.toBe(
        toBase64Url(removed.signingKeyHash)
      );
      expect(next.sequence).toBe(value.sequence + 2);
      expect((await visit(srv, created.url)).verified.shareId).toBe(
        created.shareId
      );
    } finally {
      owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
    }
  });

  it('renews the delegation without the removed device, and statements follow', async () => {
    const { srv, laptop, projectId } = await linkedProject();
    await delegate(laptop);
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    const desktopKey = owner.list.devices.find(
      (d) => d.deviceId === 'owner_desktop'
    )!.signingKey;
    // Without a delegation nothing is signed on removal.
    const none = newServer([third]);
    expect(
      await renewShareDelegationAfterRemoval(
        {} as E2eeContext,
        {
          identityPrivateKey: third.identityPrivateKey,
          account: { userId: THIRD, list: third.list } as AccountView
        },
        createE2eeShareLinksApi((path, init) =>
          worker.fetch(
            new Request(`https://example.com${path}`, {
              ...init,
              headers: {
                ...(init?.headers as Record<string, string>),
                'x-openzcad-development-user': THIRD
              }
            }),
            none.env
          )
        )
      )
    ).toBe(false);
    await owner.revoke(srv.db, 'owner_desktop');
    try {
      expect((await shareDelegationState(laptop.shareLinks)).status).toBe(
        'stale-devices'
      );
      // The removal's participant step, with the identity key it opened.
      expect(
        await renewShareDelegationAfterRemoval(
          {} as E2eeContext,
          {
            identityPrivateKey: owner.identityPrivateKey,
            account: {
              userId: OWNER,
              list: owner.list,
              generation: 1,
              deviceStatus: 'certified',
              device: {
                deviceId: 'owner_laptop',
                signing: owner.devices.get('owner_laptop')!.signing
              }
            } as unknown as AccountView
          },
          laptop.shareLinks.api
        )
      ).toBe(true);
      const state = await shareDelegationState(laptop.shareLinks);
      expect(state.status).toBe('valid');
      expect(
        state.delegation!.deviceKeys.some(
          (key) => toBase64Url(key) === toBase64Url(desktopKey)
        )
      ).toBe(false);
      expect((await visit(srv, created.url)).verified.shareId).toBe(
        created.shareId
      );
    } finally {
      owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
    }
  });
});

describe(
  'who may store a link statement (#912 review)',
  { timeout: 120_000 },
  () => {
    /**
     * `PUT …/authority` as OWNER's session: the stored statement re-signed by
     * OWNER's `deviceId` at `sequence`.
     */
    // Taken while both devices are listed: a removed one drops out of it.
    const signerHashes = new Map<string, Uint8Array>();
    beforeEach(async () => {
      signerHashes.clear();
      for (const d of owner.list.devices) {
        signerHashes.set(d.deviceId, await publicKeyHash(d.signingKey));
      }
    });

    async function authorityAs(
      srv: Server,
      projectId: string,
      shareId: string,
      deviceId: string,
      sequence: number
    ) {
      const stored = decodeShareAuthority(
        fromBase64Url(linkRow(srv, projectId, shareId)!.authority!)
      );
      const signed = await signShareAuthority(
        owner.devices.get(deviceId)!.signing.privateKey,
        { ...stored, sequence, signerKeyHash: signerHashes.get(deviceId)! }
      );
      const response = await srv.call(
        'PUT',
        `/api/e2ee/projects/${projectId}/share-links/${shareId}/authority`,
        {
          user: OWNER,
          body: {
            statement: toBase64Url(signed.statement),
            signature: toBase64Url(signed.signature)
          }
        }
      );
      return {
        status: response.status,
        code: ((await response.json()) as { code?: string }).code
      };
    }

    it('refuses a removed owner device the old delegation still names, and the certified device renews', async () => {
      const { srv, laptop, projectId } = await linkedProject();
      await delegate(laptop);
      const created = await createShareLink(
        laptop.shareLinks,
        projectId,
        'view'
      );
      const before = linkRow(
        srv,
        projectId,
        created.shareId
      )!.authority_sequence;
      await owner.revoke(srv.db, 'owner_desktop');
      try {
        // The delegation still names the removed device, whose session stays
        // signed in: a statement at the top of the sequence range would leave
        // the link unrenewable for good.
        expect(
          await authorityAs(
            srv,
            projectId,
            created.shareId,
            'owner_desktop',
            0xffffffff
          )
        ).toEqual({ status: 403, code: 'E2EE_DEVICE_NOT_CERTIFIED' });
        expect(
          linkRow(srv, projectId, created.shareId)!.authority_sequence
        ).toBe(before);
        // The owner's certified device still states the link.
        expect(
          await authorityAs(
            srv,
            projectId,
            created.shareId,
            'owner_laptop',
            before! + 1
          )
        ).toEqual({ status: 200, code: undefined });
        expect((await visit(srv, created.url)).verified.shareId).toBe(
          created.shareId
        );
      } finally {
        owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
      }
    });

    it('a device-list change between the signer check and the write stores nothing', async () => {
      const { srv, laptop, projectId } = await linkedProject();
      await delegate(laptop);
      const created = await createShareLink(
        laptop.shareLinks,
        projectId,
        'view'
      );
      const before = linkRow(srv, projectId, created.shareId)!;
      const push = srv.statements.push.bind(srv.statements);
      srv.statements.push = (...sql: string[]) => {
        if (
          sql.some((s) =>
            /^\s*UPDATE e2ee_share_links\s+SET authority = \?/.test(s)
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
            .run(OWNER);
        }
        return push(...sql);
      };
      expect(
        await authorityAs(
          srv,
          projectId,
          created.shareId,
          'owner_laptop',
          before.authority_sequence! + 1
        )
      ).toEqual({ status: 409, code: 'E2EE_DEVICE_LIST_CHANGED' });
      expect(srv.statements.push).toBe(push);
      expect(linkRow(srv, projectId, created.shareId)!.authority).toBe(
        before.authority
      );
    });
  }
);

describe('what a visitor refuses (slice 5-10)', { timeout: 120_000 }, () => {
  it('refuses a stale or forged snapshot, statement, delegation or owner key', async () => {
    const { srv, laptop, projectId } = await linkedProject();
    await delegate(laptop);
    const created = await createShareLink(laptop.shareLinks, projectId, 'view');
    const other2 = await createShareLink(laptop.shareLinks, projectId, 'view');
    const elsewhere = await createEncrypted(laptop, 'Elsewhere');
    const foreign = await createShareLink(
      laptop.shareLinks,
      elsewhere.document.projectId,
      'view'
    );
    const otherLink = (await served(srv, other2.fragment.token)).frame!;
    const foreignLink = (await served(srv, foreign.fragment.token)).frame!;

    // A flipped byte in the envelope.
    await refusedFor(
      visit(srv, created.url, Date.now(), (frame) => {
        const envelope = frame.envelope.slice();
        envelope[envelope.length - 1]! ^= 1;
        return { ...frame, envelope };
      }),
      'snapshot-signature'
    );
    // Another link's snapshot and statement for this link's key.
    await refusedFor(
      visit(srv, created.url, Date.now(), () => otherLink),
      'link-mismatch'
    );
    // Another project's snapshot under this link's statement.
    await refusedFor(
      visit(srv, created.url, Date.now(), (frame) => ({
        metadata: {
          ...frame.metadata,
          snapshotSignature: foreignLink.metadata.snapshotSignature
        },
        envelope: foreignLink.envelope
      })),
      'snapshot-mismatch'
    );
    // A statement signed by a device the delegation does not name.
    const real = (await served(srv, created.fragment.token)).frame!;
    const decoded = decodeShareAuthority(
      fromBase64Url(real.metadata.authority.statement)
    );
    const intruder = other.devices.get('other_laptop')!;
    const intruderHash = await publicKeyHash(
      other.list.devices.find((d) => d.deviceId === 'other_laptop')!.signingKey
    );
    const forged = await signShareAuthority(intruder.signing.privateKey, {
      ...decoded,
      sequence: decoded.sequence + 1,
      signerKeyHash: intruderHash
    });
    await refusedFor(
      visit(srv, created.url, Date.now(), (frame) => ({
        ...frame,
        metadata: {
          ...frame.metadata,
          authority: {
            statement: toBase64Url(forged.statement),
            signature: toBase64Url(forged.signature)
          }
        }
      })),
      'signer-not-delegated'
    );
    // A tampered statement.
    await refusedFor(
      visit(srv, created.url, Date.now(), (frame) => {
        const statement = fromBase64Url(frame.metadata.authority.statement);
        statement[statement.length - 1]! ^= 1;
        return {
          ...frame,
          metadata: {
            ...frame.metadata,
            authority: {
              ...frame.metadata.authority,
              statement: toBase64Url(statement)
            }
          }
        };
      }),
      'authority-signature'
    );
    // Another identity key than the one the link names.
    await refusedFor(
      visit(srv, created.url, Date.now(), (frame) => ({
        ...frame,
        metadata: {
          ...frame.metadata,
          ownerIdentityKey: toBase64Url(other.list.identityKey)
        }
      })),
      'owner-mismatch'
    );
    // A stale statement: a week on, the one the server still serves.
    await refusedFor(
      visit(srv, created.url, Date.now() + 8 * DAY),
      'authority-expired'
    );
    // An older snapshot's visitor wrap does not open this snapshot's key.
    await expect(
      visit(srv, created.url, Date.now(), (frame) => ({
        ...frame,
        metadata: {
          ...frame.metadata,
          wrappedVersionKey: otherLink.metadata.wrappedVersionKey
        }
      }))
    ).rejects.toThrow();
  });
});

describe('an owner identity change (slice 5-10)', { timeout: 120_000 }, () => {
  it('tombstones every link that names an earlier identity and offers reissue', async () => {
    const { srv, laptop, projectId } = await linkedProject();
    await delegate(laptop);
    const created = await createShareLink(
      laptop.shareLinks,
      projectId,
      'tweak'
    );
    // As if the link were made under the owner's previous identity.
    srv.db.exec('DROP TRIGGER e2ee_share_link_immutable');
    srv.db
      .prepare(
        'UPDATE e2ee_share_links SET owner_identity_hash = ? WHERE share_id = ?'
      )
      .run(toBase64Url(other.list.identityKeyHash), created.shareId);
    const upkeep = await maintainShareLinks(laptop.shareLinks, projectId);
    expect(upkeep.retired).toEqual([
      { shareId: created.shareId, mode: 'tweak' }
    ]);
    const after = await laptop.store.shareHead(projectId);
    expect(after.shareLinks?.links).toEqual([]);
    expect(after.shareLinks?.tombstones.map((t) => t.shareId)).toEqual([
      created.shareId
    ]);
    const reissued: CreatedShareLink[] = await reissueShareLinks(
      laptop.shareLinks,
      projectId,
      upkeep.retired
    );
    expect(reissued).toHaveLength(1);
    expect((await visit(srv, reissued[0]!.url)).verified.mode).toBe('tweak');
  });
});

describe(
  'storage of share links (migration 0040)',
  { timeout: 120_000 },
  () => {
    /** Every migration but 0040, as a database not yet updated holds them. */
    function withoutShareLinks(): DatabaseSync {
      const dir = new URL('../apps/web/migrations/', import.meta.url);
      const db = new DatabaseSync(':memory:');
      for (const file of readdirSync(dir)
        .filter((name) => name.endsWith('.sql') && !name.startsWith('0040_'))
        .sort()) {
        db.exec(readFileSync(new URL(file, dir), 'utf8'));
      }
      return db;
    }

    it('keeps encrypted writes, plaintext links, erasure and purge working without it', async () => {
      const db = withoutShareLinks();
      expect(await isE2eeShareLinkStorageReady(sqliteD1(db))).toBe(false);
      const srv = newServer(accounts(), db);
      const laptop = device(srv, owner, 'owner_laptop', {
        members: othersOf(owner),
        onVersionWritten: republish
      });
      const { document } = await createEncrypted(laptop);
      const projectId = document.projectId;
      await laptop.store.saveProjectDocument({
        projectId,
        expectedVersion: document.version,
        document: edited(document, 'Without 0040')
      });
      await Promise.all(laptop.shareWork);
      expect(
        (await srv.call('GET', `/api/e2ee/projects/${projectId}/share-links`))
          .status
      ).toBe(503);
      expect((await srv.call('GET', '/api/e2ee/share-delegation')).status).toBe(
        503
      );
      expect((await served(srv, 'A'.repeat(43))).status).toBe(404);
      // A plaintext project's link works as before.
      const plain = await srv.call('POST', '/api/projects', {
        body: { name: 'Plain' }
      });
      expect(plain.status).toBeLessThan(300);
      const plainId = (
        (await plain.json()) as { project: { projectId: string } }
      ).project.projectId;
      const link = await srv.call(
        'POST',
        `/api/projects/${plainId}/share-links`,
        {
          body: { mode: 'tweak' }
        }
      );
      expect(link.status).toBe(201);
      const token = ((await link.json()) as { token: string }).token;
      expect(
        (
          await worker.fetch(
            new Request(`https://example.com/api/share/${token}`),
            srv.env
          )
        ).status
      ).toBe(200);
      expect(
        await shareLinkErasureStatements(srv.env.DB as D1Database, OWNER, 'all')
      ).toEqual([]);
      expect((await srv.call('POST', '/api/projects/purge')).status).toBe(200);
    });

    it('erases an account’s delegation and user ids, and goes with the project', async () => {
      const { srv, laptop, member, projectId } = await linkedProject();
      await delegate(laptop);
      const created = await createShareLink(
        laptop.shareLinks,
        projectId,
        'view'
      );
      const opened = await member.store.loadProject(projectId);
      await member.store.saveProjectDocument({
        projectId,
        expectedVersion: opened.version,
        document: edited(opened, 'Editor snapshot')
      });
      await Promise.all(member.shareWork);
      const db = srv.env.DB as D1Database;
      await db.batch(await shareLinkErasureStatements(db, OTHER, 'all'));
      expect(
        rows<{ signer_user_id: string | null }>(
          srv,
          'SELECT signer_user_id FROM e2ee_share_snapshots WHERE share_id = ?',
          created.shareId
        )
      ).toEqual([{ signer_user_id: null }]);
      await db.batch(await shareLinkErasureStatements(db, OWNER, 'profile'));
      expect(
        rows(
          srv,
          'SELECT 1 FROM e2ee_share_delegations WHERE user_id = ?',
          OWNER
        )
      ).toEqual([]);
      // Deleting the owner's projects purges every share-link row.
      expect(
        (
          await srv.call('POST', '/api/account/delete-data', {
            user: OWNER,
            body: { scope: 'projects', confirmation: 'DELETE CLOUD PROJECTS' }
          })
        ).status
      ).toBe(200);
      for (const table of [
        'e2ee_share_links',
        'e2ee_share_keys',
        'e2ee_share_snapshots'
      ]) {
        expect(countFor(srv, table, projectId)).toBe(0);
      }
    });
  }
);

describe('share snapshot objects (slice 8-C1)', { timeout: 120_000 }, () => {
  const envelopeKey = (srv: Server, projectId: string, shareId: string) =>
    rows<{ envelope_key: string | null }>(
      srv,
      `SELECT envelope_key FROM e2ee_share_snapshots
       WHERE project_id = ? AND share_id = ?`,
      projectId,
      shareId
    )[0]?.envelope_key ?? null;

  async function orphanedSnapshot() {
    const shared = await linkedProject();
    const { srv, laptop, projectId, document } = shared;
    await delegate(laptop);
    const link = await createShareLink(laptop.shareLinks, projectId, 'view');
    const publish = async () =>
      putRawSnapshot(
        srv,
        laptop,
        projectId,
        link.shareId,
        await sealRawSnapshot(srv, laptop, projectId, link.shareId, {
          document,
          padding: R2_PADDING
        })
      );
    expect((await publish()).status).toBe(200);
    const orphan = envelopeKey(srv, projectId, link.shareId)!;
    const bucketDelete = srv.bucket.delete as Mock<
      (key: string | string[]) => Promise<void>
    >;
    const del = bucketDelete.getMockImplementation()!;
    bucketDelete.mockImplementation(async (key) => {
      if (key === orphan) throw new Error('Replacement delete failed');
      await del(key);
    });
    expect((await publish()).status).toBe(200);
    bucketDelete.mockImplementation(del);
    expect(snapshotObjects(srv, projectId)).toHaveLength(2);
    return { ...shared, link, orphan };
  }

  it.each(['project', 'projects', 'all', 'retention'] as const)(
    'sweeps unreferenced snapshot objects on %s deletion without forgetting a link',
    async (scope) => {
      const { srv, projectId } = await orphanedSnapshot();
      if (scope === 'project') {
        await new D1R2PersistenceService(srv.env).deleteProject(
          toUserId(OWNER),
          projectId
        );
      } else if (scope === 'retention') {
        srv.db
          .prepare(
            "UPDATE projects SET status = 'deleted', deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
          )
          .run(projectId);
        expect((await srv.call('POST', '/api/projects/purge')).status).toBe(
          200
        );
      } else {
        expect(
          (
            await srv.call('POST', '/api/account/delete-data', {
              user: OWNER,
              body: {
                scope,
                confirmation:
                  scope === 'all'
                    ? 'DELETE ALL CLOUD DATA'
                    : 'DELETE CLOUD PROJECTS'
              }
            })
          ).status
        ).toBe(200);
      }
      expect(snapshotObjects(srv, projectId)).toEqual([]);
      expect(
        rows(srv, 'SELECT id FROM projects WHERE id = ?', projectId)
      ).toEqual([]);
    }
  );

  it.each(['separate', 'fallback'] as const)(
    'pages the project snapshot prefix in the %s bucket without touching other namespaces',
    async (storage) => {
      const { srv, projectId } = await orphanedSnapshot();
      const artifacts = storage === 'separate' ? objectBucket() : srv.bucket;
      srv.env.ARTIFACTS = artifacts;
      if (storage === 'fallback') srv.env.PROJECT_STORAGE = undefined;
      const prefix = `e2ee/${projectId}/s/`;
      for (let i = 0; i < 1005; i += 1)
        srv.bucket.objects.set(`${prefix}old-${i}`, new ArrayBuffer(1));
      const neighbors = [
        `e2ee/${projectId}-other/s/keep`,
        `e2ee/other-project/s/keep`,
        `e2ee/${projectId}/v/keep`
      ];
      for (const key of neighbors)
        srv.bucket.objects.set(key, new ArrayBuffer(1));
      const artifactSentinel = `${prefix}artifact-bucket-only`;
      if (storage === 'separate')
        artifacts.objects.set(artifactSentinel, new ArrayBuffer(1));
      await new D1R2PersistenceService(srv.env).deleteProject(
        toUserId(OWNER),
        projectId
      );
      expect(snapshotObjects(srv, projectId)).toEqual([]);
      for (const key of neighbors)
        expect(srv.bucket.objects.has(key)).toBe(true);
      if (storage === 'separate')
        expect(artifacts.objects.has(artifactSentinel)).toBe(true);
      const pages = srv.bucket.list.mock.calls.map(
        ([options]) => options as { prefix: string; cursor?: string }
      );
      expect(pages.filter((page) => page.prefix === prefix)).toHaveLength(2);
      expect(pages.every((page) => page.cursor === undefined)).toBe(true);
    }
  );

  it.each(['list', 'delete', 'incomplete', 'wrong-prefix'] as const)(
    'keeps project rows retryable when snapshot cleanup has a %s failure',
    async (failure) => {
      const { srv, projectId } = await orphanedSnapshot();
      const service = new D1R2PersistenceService(srv.env);
      const bucketList = srv.bucket.list as Mock<
        (options?: {
          prefix?: string;
          cursor?: string;
          limit?: number;
        }) => Promise<{
          objects: { key: string }[];
          truncated: boolean;
          cursor?: string;
        }>
      >;
      const bucketDelete = srv.bucket.delete as Mock<
        (keys: string | string[]) => Promise<void>
      >;
      const list = bucketList.getMockImplementation()!;
      const del = bucketDelete.getMockImplementation()!;
      if (failure === 'list')
        bucketList.mockRejectedValueOnce(new Error('list unavailable'));
      else if (failure === 'delete') {
        bucketDelete.mockImplementation(async (keys: string | string[]) => {
          if (Array.isArray(keys)) throw new Error('delete unavailable');
          await del(keys);
        });
      } else if (failure === 'incomplete') {
        bucketList.mockImplementation(async () => ({
          objects: [],
          truncated: true,
          cursor: 'stuck'
        }));
      } else {
        bucketList.mockImplementation(async () => ({
          objects: [{ key: 'e2ee/another-project/s/keep' }],
          truncated: false
        }));
      }
      await expect(
        service.deleteProject(toUserId(OWNER), projectId)
      ).rejects.toThrow();
      expect(
        rows(srv, 'SELECT id FROM projects WHERE id = ?', projectId)
      ).toHaveLength(1);
      expect(countFor(srv, 'e2ee_share_snapshots', projectId)).toBe(1);
      if (failure === 'incomplete')
        expect(srv.bucket.list).toHaveBeenCalledTimes(10);
      bucketList.mockImplementation(list);
      bucketDelete.mockImplementation(del);
      await service.deleteProject(toUserId(OWNER), projectId);
      expect(snapshotObjects(srv, projectId)).toEqual([]);
      expect(
        rows(srv, 'SELECT id FROM projects WHERE id = ?', projectId)
      ).toEqual([]);
    }
  );

  it('fences a publication that races the last snapshot prefix listing', async () => {
    const { srv, laptop, projectId, document, link } = await orphanedSnapshot();
    const replacement = await sealRawSnapshot(
      srv,
      laptop,
      projectId,
      link.shareId,
      { document, padding: R2_PADDING }
    );
    const bucketList = srv.bucket.list as Mock<
      (options?: {
        prefix?: string;
        limit?: number;
      }) => Promise<{ objects: { key: string }[]; truncated: boolean }>
    >;
    const list = bucketList.getMockImplementation()!;
    let published: number | null = null;
    bucketList.mockImplementationOnce(async (options) => {
      const page = await list(options);
      await expect(
        new D1R2PersistenceService(srv.env).updateProject(toUserId(OWNER), {
          projectId,
          status: 'active'
        })
      ).rejects.toThrow();
      published = (
        await putRawSnapshot(srv, laptop, projectId, link.shareId, replacement)
      ).status;
      return page;
    });
    await new D1R2PersistenceService(srv.env).deleteProject(
      toUserId(OWNER),
      projectId
    );
    expect(published).toBe(401);
    expect(snapshotObjects(srv, projectId)).toEqual([]);
  });

  it('preserves deletion of snapshots stored entirely inline without a bucket', async () => {
    const { srv, laptop, projectId, document } = await linkedProject();
    srv.env.PROJECT_STORAGE = undefined;
    srv.env.ARTIFACTS = undefined;
    await delegate(laptop);
    const link = await createShareLink(laptop.shareLinks, projectId, 'view');
    const inline = await sealRawSnapshot(srv, laptop, projectId, link.shareId, {
      document
    });
    expect(
      (await putRawSnapshot(srv, laptop, projectId, link.shareId, inline))
        .status
    ).toBe(200);
    expect(envelopeKey(srv, projectId, link.shareId)).toBe(null);
    expect(snapshotObjects(srv, projectId)).toHaveLength(0);
    await new D1R2PersistenceService(srv.env).deleteProject(
      toUserId(OWNER),
      projectId
    );
    expect(countFor(srv, 'e2ee_share_snapshots', projectId)).toBe(0);
  });

  it('keys each object by its link, so replacing or forgetting one link never deletes what another serves', async () => {
    const { srv, laptop, projectId, document } = await linkedProject();
    await delegate(laptop);
    const a = await createShareLink(laptop.shareLinks, projectId, 'view');
    const b = await createShareLink(laptop.shareLinks, projectId, 'view');
    // The same envelope bytes stored for both links, as a client may send.
    const same = await sealRawSnapshot(srv, laptop, projectId, a.shareId, {
      document,
      padding: R2_PADDING
    });
    for (const link of [a, b]) {
      expect(
        (await putRawSnapshot(srv, laptop, projectId, link.shareId, same))
          .status
      ).toBe(200);
    }
    const aKey = envelopeKey(srv, projectId, a.shareId)!;
    expect(aKey).not.toBe(envelopeKey(srv, projectId, b.shareId));
    expect(snapshotObjects(srv, projectId)).toHaveLength(2);
    // Replacing b's snapshot (the same version) leaves a's object alone...
    const replacement = await sealRawSnapshot(
      srv,
      laptop,
      projectId,
      b.shareId,
      { document, padding: R2_PADDING }
    );
    expect(
      (await putRawSnapshot(srv, laptop, projectId, b.shareId, replacement))
        .status
    ).toBe(200);
    expect((await served(srv, a.fragment.token)).status).toBe(200);
    expect(snapshotObjects(srv, projectId)).toEqual(
      [aKey, envelopeKey(srv, projectId, b.shareId)!].sort()
    );
    // ...and so does forgetting b.
    await revokeShareLink(laptop.shareLinks, projectId, b.shareId);
    expect((await served(srv, b.fragment.token)).status).toBe(404);
    expect((await served(srv, a.fragment.token)).status).toBe(200);
    expect(snapshotObjects(srv, projectId)).toEqual([aKey]);
  });

  it('deletes the object a concurrent write at the same version replaced', async () => {
    const { srv, laptop, member, projectId, document } = await linkedProject();
    await delegate(laptop);
    const link = await createShareLink(laptop.shareLinks, projectId, 'view');
    const first = await sealRawSnapshot(srv, laptop, projectId, link.shareId, {
      document,
      padding: R2_PADDING
    });
    const second = await sealRawSnapshot(srv, member, projectId, link.shareId, {
      document,
      padding: R2_PADDING
    });
    // The owner's write stores its object; the editor's write of the same
    // version then lands whole before the owner's row does.
    const bucketPut = srv.bucket.put as Mock<
      (key: string, body: Uint8Array) => Promise<void>
    >;
    const put = bucketPut.getMockImplementation()!;
    bucketPut.mockImplementationOnce(async (key: string, body: Uint8Array) => {
      await put(key, body);
      expect(
        (await putRawSnapshot(srv, member, projectId, link.shareId, second))
          .status
      ).toBe(200);
    });
    expect(
      (await putRawSnapshot(srv, laptop, projectId, link.shareId, first)).status
    ).toBe(200);
    // The owner's row won, and the editor's object it replaced is gone.
    const key = envelopeKey(srv, projectId, link.shareId)!;
    expect(snapshotObjects(srv, projectId)).toEqual([key]);
    expect((await served(srv, link.fragment.token)).status).toBe(200);
  });

  it('keeps a forgotten link’s row naming its object until R2 deletes it, and retries on the next forget', async () => {
    const { srv, laptop, projectId, document } = await linkedProject();
    await delegate(laptop);
    const a = await createShareLink(laptop.shareLinks, projectId, 'view');
    const b = await createShareLink(laptop.shareLinks, projectId, 'view');
    const big = () =>
      sealRawSnapshot(srv, laptop, projectId, a.shareId, {
        document,
        padding: R2_PADDING
      });
    expect(
      (await putRawSnapshot(srv, laptop, projectId, a.shareId, await big()))
        .status
    ).toBe(200);
    const bucketDelete = srv.bucket.delete as Mock<
      (key: string) => Promise<void>
    >;
    const del = bucketDelete.getMockImplementation()!;
    bucketDelete.mockImplementation(async () => {
      throw new Error('R2 is unavailable');
    });
    // A replacement whose delete fails leaves its old object under the
    // link's prefix...
    expect(
      (await putRawSnapshot(srv, laptop, projectId, a.shareId, await big()))
        .status
    ).toBe(200);
    const key = envelopeKey(srv, projectId, a.shareId)!;
    expect(snapshotObjects(srv, projectId)).toHaveLength(2);
    // ...and a forget whose delete fails keeps the row naming the object.
    await revokeShareLink(laptop.shareLinks, projectId, a.shareId);
    expect((await served(srv, a.fragment.token)).status).toBe(404);
    expect(linkRow(srv, projectId, a.shareId)!.revoked_at).not.toBe(null);
    expect(envelopeKey(srv, projectId, a.shareId)).toBe(key);
    expect(countFor(srv, 'e2ee_share_keys', projectId)).toBe(1);
    expect(snapshotObjects(srv, projectId)).toHaveLength(2);
    // The listing names only the live link.
    const listed = (await (
      await srv.call('GET', `/api/e2ee/projects/${projectId}/share-links`)
    ).json()) as { links: { shareId: string }[] };
    expect(listed.links.map((link) => link.shareId)).toEqual([b.shareId]);
    // R2 recovers: the next forget deletes both, then the row.
    bucketDelete.mockImplementation(del);
    await revokeShareLink(laptop.shareLinks, projectId, b.shareId);
    expect(snapshotObjects(srv, projectId)).toEqual([]);
    expect(countFor(srv, 'e2ee_share_snapshots', projectId)).toBe(0);
    expect(countFor(srv, 'e2ee_share_keys', projectId)).toBe(0);
  });

  it('a device-list change between the signer check and the snapshot write stores nothing', async () => {
    const { srv, laptop, projectId, document } = await linkedProject();
    await delegate(laptop);
    const link = await createShareLink(laptop.shareLinks, projectId, 'view');
    const before = rows(
      srv,
      'SELECT * FROM e2ee_share_snapshots WHERE share_id = ?',
      link.shareId
    );
    const sealed = await sealRawSnapshot(srv, laptop, projectId, link.shareId, {
      document,
      padding: R2_PADDING
    });
    // The owner's list moves on (a removal of the signer, say) after the
    // signer was checked and before the snapshot lands.
    const push = srv.statements.push.bind(srv.statements);
    srv.statements.push = (...sql: string[]) => {
      if (sql.some((s) => /^\s*INSERT INTO e2ee_share_snapshots/.test(s))) {
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
    const response = await putRawSnapshot(
      srv,
      laptop,
      projectId,
      link.shareId,
      sealed
    );
    expect(srv.statements.push).toBe(push);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe(
      'E2EE_DEVICE_LIST_CHANGED'
    );
    expect(
      rows(
        srv,
        'SELECT * FROM e2ee_share_snapshots WHERE share_id = ?',
        link.shareId
      )
    ).toEqual(before);
    expect(snapshotObjects(srv, projectId)).toEqual([]);
  });
});
