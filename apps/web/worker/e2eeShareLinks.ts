/**
 * Share links of end-to-end encrypted projects (ADR-024 Phase 5, slice
 * 5-10; roadmap L11; migration 0040), under `/api/e2ee/projects/:id/
 * share-links…`, `/api/e2ee/share-delegation` and the anonymous
 * `GET /api/e2ee/share/:token`.
 *
 * Which links are active is project state, inside the encrypted, signed
 * document (owner-signed grants and permanent tombstones): the Worker keeps
 * what serving a link needs and cannot add one back. It stores, per link,
 * the hash of its capability token, the share key wrapped under each key
 * epoch's project key, the newest share-authority statement and the newest
 * snapshot; per account, the newest identity-signed share delegation.
 *
 * It still checks what it can, as defense in depth: the owner registers
 * links and forgets them (signed by a device the owner's newest device list
 * certifies over the link and the current key epoch, fenced on that list's
 * head; a registration's signature covers every field stored) and states
 * them; the owner and editors post key wraps (for the
 * group's current key epoch only, signed by a device the caller's newest
 * device list certifies and fenced on that list's head; the first stored
 * wins) and snapshots (a
 * share-snapshot envelope of this project under the current key epoch,
 * signed by a device the caller's newest device list certifies and fenced
 * on that list's head, never older than the link's stored snapshot nor
 * newer than the project's head); a delegation verifies under the
 * account's current identity key, is valid now and names only devices that
 * list certifies, fenced on its head; a statement
 * verifies against the owner's stored delegation, names the link, its key
 * hash and owner fingerprint, is valid now and raises the link's sequence.
 * Browsers and visitors verify all of it themselves.
 *
 * The anonymous route serves a link's snapshot envelope with everything a
 * visitor checks it with (`verifySharedSnapshot`): the statement, the
 * owner's delegation, the author's signing key and the owner's identity
 * key. It reads only these tables and format-2 projects, so it can never
 * serve a plaintext project, and answers every other case (unknown or
 * revoked token, nothing published yet, a trashed project, the owner's
 * sharing switched off, the flags or the migration missing) with one
 * opaque 404. The plaintext `/api/share/:token` route is untouched and
 * keeps refusing format 2.
 *
 * The anonymous blob route (slice 5-11), `GET /api/e2ee/share/:token/
 * blobs/:blobId`, serves the owner's ciphertext of a content blob that the
 * link's current snapshot names in its header, behind the same gates.
 *
 * Served by `handleE2eeRequest` after the key rollout gate and, for writes,
 * the session/erasure write authorization; here: E2EE_PROJECTS_ENABLED,
 * migrations 0031, 0032 and 0040 (503 without them), format-2 projects
 * only. Creating a link also needs the sharing rollout.
 */
import {
  MAX_SHARE_AUTHORITY_BYTES,
  MAX_SHARE_DELEGATION_BYTES,
  ShareLinkError,
  decodeShareDelegation,
  decodeDeviceListEntry,
  fromBase64Url,
  fromHex,
  parseEnvelope,
  publicKeyHash,
  toBase64Url,
  toHex,
  verifyProjectEnvelopeSignature,
  verifyShareAuthority,
  verifyShareDelegation,
  verifyShareKeyWrap,
  verifyShareLinkForget,
  verifyShareLinkRegistration,
  versionHash,
  type ShareDelegation
} from '@openzcad/crypto';
import {
  E2EE_BLOB_ID_PATTERN,
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES,
  decodeE2eeFrame,
  encodeE2eeFrame,
  E2EE_FRAME_CONTENT_TYPE,
  shareSnapshotVersionId,
  type E2eeShareAuthorityRecord,
  type E2eeShareDelegationRecord,
  type E2eeShareDelegationResponse,
  type E2eeShareKeyResponse,
  type E2eeShareLinkMode,
  type E2eeShareLinkRecord,
  type E2eeShareLinkResponse,
  type E2eeShareLinksResponse,
  type E2eeSharedSnapshotMetadata
} from '@openzcad/shared';
import {
  isE2eeContentBlobStorageReady,
  isE2eeProjectGroupStorageReady,
  isE2eeShareLinkStorageReady,
  isProjectStorageFormatReady
} from '@openzcad/cloudflare-adapters';
import {
  PROJECT_FENCE,
  RouteError,
  WRITER_FENCE,
  bytesField,
  deviceListMoved,
  deviceListUnchanged,
  fenceBinds,
  idField,
  invalid,
  json,
  record,
  refuse,
  refuseDeviceListMoved,
  requireCertifiedDevice,
  requireCertifiedSigner,
  requireEncryptedProjectAccess,
  requireOwnedEncryptedProject,
  runBatch,
  uintField,
  type Authorization
} from './e2eeProjects';

const LINKS_ROUTE =
  /^\/api\/e2ee\/projects\/([^/]+)\/share-links(?:\/([^/]+)(?:\/(keys|authority|snapshot))?)?$/;
const DELEGATION_ROUTE = '/api/e2ee/share-delegation';
const SHARED_ROUTE = /^\/api\/e2ee\/share\/([^/]+)$/;
const SHARED_BLOB_ROUTE = /^\/api\/e2ee\/share\/([^/]+)\/blobs\/([^/]+)$/;

/** The owner-side share-link routes and the delegation route. */
export function isE2eeShareLinkPath(pathname: string): boolean {
  return pathname === DELEGATION_ROUTE || LINKS_ROUTE.test(pathname);
}

/** The anonymous encrypted share route. */
export function isEncryptedSharedSnapshotPath(pathname: string): boolean {
  return SHARED_ROUTE.test(pathname);
}

/** The anonymous route for a shared snapshot's content blobs (slice 5-11). */
export function isEncryptedSharedBlobPath(pathname: string): boolean {
  return SHARED_BLOB_ROUTE.test(pathname);
}

const WRAP_BYTES = 41;
const HASH_BYTES = 32;
const STATEMENT_SIGNATURE_BYTES = 65;
const VERSION_SIGNATURE_BYTES = 73;
const MAX_JSON_BODY_CHARS = 200_000;
const MAX_FRAME_METADATA_BYTES = 64 * 1024;
/** A snapshot envelope: the document ceiling plus framing (judgment). */
const MAX_SNAPSHOT_ENVELOPE_BYTES =
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES + 512 * 1024;
/** Bodies up to this size stay inline in D1, as versions do. */
const INLINE_SNAPSHOT_BYTES = 256 * 1024;
/** Without an R2 bucket, the most a snapshot may be inline. */
const INLINE_SNAPSHOT_LIMIT = 1024 * 1024;
/** Live links per project (judgment; each holds one snapshot). */
export const MAX_LIVE_SHARE_LINKS = 50;
const TOKEN_HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** What `handleE2eeShareLinkRequest` needs of the R2 project bucket. */
export interface ShareSnapshotBucket {
  put(key: string, body: ArrayBuffer | Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
  /** R2's listing; a forgotten link's prefix is swept with it. */
  list?(options: { prefix: string }): Promise<{
    objects: readonly { key: string }[];
    truncated: boolean;
  }>;
}

interface Context {
  db: D1Database;
  bucket: ShareSnapshotBucket | null;
  userId: string;
  authorization: Authorization;
}

// --- Input -----------------------------------------------------------------

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (
    Number(request.headers.get('content-length') ?? '0') > MAX_JSON_BODY_CHARS
  ) {
    refuse(413, 'E2EE_REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  const text = await request.text();
  if (text.length > MAX_JSON_BODY_CHARS) {
    refuse(413, 'E2EE_REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  try {
    return record(JSON.parse(text), 'Body');
  } catch (error) {
    if (error instanceof RouteError) throw error;
    invalid('Body must be JSON');
  }
}

async function readFrame(
  request: Request
): Promise<{ metadata: Record<string, unknown>; payload: Uint8Array }> {
  const max = 4 + MAX_FRAME_METADATA_BYTES + MAX_SNAPSHOT_ENVELOPE_BYTES;
  const tooLarge = (): never =>
    refuse(413, 'DOCUMENT_TOO_LARGE', 'This snapshot is too large to store.', {
      limitBytes: MAX_CLOUD_PROJECT_DOCUMENT_BYTES
    });
  if (Number(request.headers.get('content-length') ?? '0') > max) tooLarge();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > max) tooLarge();
  let frame: ReturnType<typeof decodeE2eeFrame>;
  try {
    frame = decodeE2eeFrame(bytes, MAX_FRAME_METADATA_BYTES);
  } catch {
    invalid('Body must be an encrypted-project frame');
  }
  if (frame.payload.byteLength > MAX_SNAPSHOT_ENVELOPE_BYTES) tooLarge();
  if (frame.payload.byteLength === 0) invalid('The frame carries no envelope');
  return {
    metadata: record(frame.metadata, 'Frame metadata'),
    payload: frame.payload
  };
}

function modeField(value: unknown): E2eeShareLinkMode {
  if (value !== 'view' && value !== 'tweak')
    invalid('mode must be view or tweak');
  return value;
}

function signedField(
  body: Record<string, unknown>,
  max: number
): {
  statement: Uint8Array;
  signature: Uint8Array;
  text: { statement: string; signature: string };
} {
  const statement = bytesField(body.statement, 'statement', { max });
  const signature = bytesField(body.signature, 'signature', {
    exact: STATEMENT_SIGNATURE_BYTES
  });
  return {
    statement: statement.bytes,
    signature: signature.bytes,
    text: { statement: statement.text, signature: signature.text }
  };
}

const b64 = toBase64Url;

// --- Rows ------------------------------------------------------------------

interface LinkRow {
  share_id: string;
  mode: E2eeShareLinkMode;
  share_key_hash: string;
  owner_identity_hash: string;
  created_at: string;
  revoked_at: string | null;
  authority: string | null;
  authority_signature: string | null;
  authority_sequence: number | null;
  authority_expires_at: number | null;
}

interface SnapshotRow {
  share_id: string;
  document_version: number;
  key_epoch: number;
  snapshot_hash: string;
  envelope_inline: string | null;
  envelope_key: string | null;
  signature: string;
  wrapped_for_link_visitors: string;
  author_key: string;
  signer_device_id: string;
  updated_at: string;
}

interface DelegationRow {
  generation: number;
  sequence: number;
  statement: string;
  signature: string;
  expires_at: number;
}

const LINK_COLUMNS = `share_id, mode, share_key_hash, owner_identity_hash,
  created_at, revoked_at, authority, authority_signature, authority_sequence,
  authority_expires_at`;

const authorityOf = (row: LinkRow): E2eeShareAuthorityRecord | null =>
  row.authority === null
    ? null
    : {
        statement: row.authority,
        signature: row.authority_signature!,
        sequence: row.authority_sequence!,
        expiresAt: row.authority_expires_at!
      };

const delegationOf = (
  row: DelegationRow | null
): E2eeShareDelegationRecord | null =>
  row
    ? {
        statement: row.statement,
        signature: row.signature,
        sequence: row.sequence,
        expiresAt: row.expires_at,
        generation: row.generation
      }
    : null;

async function linkRow(
  db: D1Database,
  projectId: string,
  shareId: string
): Promise<LinkRow | null> {
  return db
    .prepare(
      `SELECT ${LINK_COLUMNS} FROM e2ee_share_links
       WHERE project_id = ? AND share_id = ?`
    )
    .bind(projectId, shareId)
    .first<LinkRow>();
}

async function liveLink(
  db: D1Database,
  projectId: string,
  shareId: string
): Promise<LinkRow> {
  const row = await linkRow(db, projectId, shareId);
  if (!row || row.revoked_at !== null) {
    refuse(404, 'E2EE_SHARE_LINK_NOT_FOUND', 'This share link does not exist.');
  }
  return row;
}

async function linkRecords(
  db: D1Database,
  projectId: string,
  only?: string
): Promise<E2eeShareLinkRecord[]> {
  const filter = only === undefined ? '' : ' AND share_id = ?';
  const binds = only === undefined ? [projectId] : [projectId, only];
  const links = await db
    .prepare(
      `SELECT ${LINK_COLUMNS} FROM e2ee_share_links
       WHERE project_id = ? AND revoked_at IS NULL${filter}
       ORDER BY created_at, share_id`
    )
    .bind(...binds)
    .all<LinkRow>();
  const keys = await db
    .prepare(
      `SELECT share_id, key_epoch, wrapped FROM e2ee_share_keys
       WHERE project_id = ?${filter} ORDER BY share_id, key_epoch`
    )
    .bind(...binds)
    .all<{ share_id: string; key_epoch: number; wrapped: string }>();
  const snapshots = await db
    .prepare(
      `SELECT share_id, document_version, key_epoch, snapshot_hash,
              signer_device_id, updated_at
       FROM e2ee_share_snapshots WHERE project_id = ?${filter}`
    )
    .bind(...binds)
    .all<SnapshotRow>();
  return (links.results ?? []).map((row) => {
    const snapshot = (snapshots.results ?? []).find(
      (s) => s.share_id === row.share_id
    );
    return {
      shareId: row.share_id,
      mode: row.mode,
      shareKeyHash: row.share_key_hash,
      ownerIdentityHash: row.owner_identity_hash,
      createdAt: row.created_at,
      keys: (keys.results ?? [])
        .filter((k) => k.share_id === row.share_id)
        .map((k) => ({ keyEpoch: k.key_epoch, wrapped: k.wrapped })),
      authority: authorityOf(row),
      snapshot: snapshot
        ? {
            documentVersion: snapshot.document_version,
            keyEpoch: snapshot.key_epoch,
            snapshotHash: snapshot.snapshot_hash,
            signerDeviceId: snapshot.signer_device_id,
            updatedAt: snapshot.updated_at
          }
        : null
    };
  });
}

async function oneLink(
  db: D1Database,
  projectId: string,
  shareId: string
): Promise<E2eeShareLinkResponse> {
  const [link] = await linkRecords(db, projectId, shareId);
  if (!link) {
    refuse(404, 'E2EE_SHARE_LINK_NOT_FOUND', 'This share link does not exist.');
  }
  return { link };
}

async function delegationRow(
  db: D1Database,
  userId: string
): Promise<DelegationRow | null> {
  return db
    .prepare(
      `SELECT generation, sequence, statement, signature, expires_at
       FROM e2ee_share_delegations WHERE user_id = ?`
    )
    .bind(userId)
    .first<DelegationRow>();
}

async function currentIdentity(
  db: D1Database,
  userId: string
): Promise<{ generation: number; key: Uint8Array; hash: string } | null> {
  const row = await db
    .prepare(
      `SELECT generation, identity_key FROM e2ee_identities
       WHERE user_id = ? ORDER BY generation DESC LIMIT 1`
    )
    .bind(userId)
    .first<{ generation: number; identity_key: string }>();
  if (!row) return null;
  const key = fromBase64Url(row.identity_key);
  return {
    generation: row.generation,
    key,
    hash: b64(await publicKeyHash(key))
  };
}

async function currentKeyEpoch(
  db: D1Database,
  projectId: string
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT key_epoch_base + epoch AS key_epoch FROM e2ee_project_groups
       WHERE project_id = ?`
    )
    .bind(projectId)
    .first<{ key_epoch: number }>();
  if (!row) {
    refuse(
      404,
      'E2EE_GROUP_NOT_FOUND',
      'This encrypted project has no MLS group yet.'
    );
  }
  return row.key_epoch;
}

const stale: (keyEpoch: number) => never = (keyEpoch) =>
  refuse(
    409,
    'E2EE_EPOCH_STALE',
    `The project is at key epoch ${keyEpoch}; catch up and try again.`,
    { keyEpoch }
  );

const sessionRequired: () => never = () =>
  refuse(
    401,
    'E2EE_SESSION_REQUIRED',
    'Sign in again before changing encryption keys.'
  );

const changed = (result: { meta?: { changes?: number } } | undefined) =>
  (result?.meta?.changes ?? 0) > 0;

// --- Delegation --------------------------------------------------------------

async function putDelegation(
  ctx: Context,
  body: Record<string, unknown>
): Promise<Response> {
  const signed = signedField(body, MAX_SHARE_DELEGATION_BYTES);
  const identity = await currentIdentity(ctx.db, ctx.userId);
  if (!identity) {
    refuse(409, 'E2EE_IDENTITY_REQUIRED', 'Set up encryption first.');
  }
  let delegation: ShareDelegation;
  try {
    delegation = await verifyShareDelegation(
      { statement: signed.statement, signature: signed.signature },
      identity.key,
      { now: Date.now() }
    );
  } catch (error) {
    invalid(
      error instanceof ShareLinkError
        ? `The delegation does not verify (${error.reason})`
        : 'The delegation is not a share delegation'
    );
  }
  // Only devices the newest device list certifies may be delegated.
  const head = await ctx.db
    .prepare(
      `SELECT sequence, entry FROM e2ee_device_list_entries
       WHERE user_id = ? AND generation = ? ORDER BY sequence DESC LIMIT 1`
    )
    .bind(ctx.userId, identity.generation)
    .first<{ sequence: number; entry: string }>();
  let certified: Set<string>;
  try {
    certified = new Set(
      head
        ? decodeDeviceListEntry(fromBase64Url(head.entry)).devices.map(
            (device) => b64(device.signingKey)
          )
        : []
    );
  } catch {
    certified = new Set();
  }
  if (!head || !delegation.deviceKeys.every((key) => certified.has(b64(key)))) {
    invalid('A delegation names only devices your device list certifies');
  }
  // ...and only while that list is still the head (#912 review): a stale
  // delegation naming a device whose removal lands first cannot win the
  // race with the renewal that drops it.
  const list = { generation: identity.generation, headSequence: head.sequence };
  const fence = deviceListUnchanged(ctx.userId, list);
  const now = new Date().toISOString();
  try {
    const results = await runBatch(ctx.db, [
      ctx.db
        .prepare(
          `INSERT INTO e2ee_share_delegations
             (user_id, generation, sequence, statement, signature, expires_at,
              updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE ${ctx.authorization.sql} AND ${fence.sql}
           ON CONFLICT (user_id) DO UPDATE SET
             generation = excluded.generation, sequence = excluded.sequence,
             statement = excluded.statement, signature = excluded.signature,
             expires_at = excluded.expires_at, updated_at = excluded.updated_at`
        )
        .bind(
          ctx.userId,
          identity.generation,
          delegation.sequence,
          signed.text.statement,
          signed.text.signature,
          delegation.expiresAt,
          now,
          ...ctx.authorization.binds,
          ...fence.binds
        )
    ]);
    if (!changed(results[0])) {
      if (await deviceListMoved(ctx.db, ctx.userId, list)) {
        refuseDeviceListMoved();
      }
      sessionRequired();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('E2EE_SHARE_DELEGATION_STALE')
    ) {
      refuse(
        409,
        'E2EE_SHARE_DELEGATION_STALE',
        'A newer share delegation is already stored. Reload and try again.'
      );
    }
    throw error;
  }
  return json({
    delegation: delegationOf(await delegationRow(ctx.db, ctx.userId))
  } satisfies E2eeShareDelegationResponse);
}

// --- Links -------------------------------------------------------------------

async function createLink(
  ctx: Context,
  projectId: string,
  body: Record<string, unknown>
): Promise<Response> {
  const shareId = idField(body.shareId, 'shareId');
  if (typeof body.tokenHash !== 'string' || !TOKEN_HASH.test(body.tokenHash)) {
    invalid('tokenHash must be a lowercase hex SHA-256');
  }
  const tokenHash = body.tokenHash;
  const mode = modeField(body.mode);
  const keyHash = bytesField(body.shareKeyHash, 'shareKeyHash', {
    exact: HASH_BYTES
  });
  const shareKeyHash = keyHash.text;
  const ownerHash = bytesField(body.ownerIdentityHash, 'ownerIdentityHash', {
    exact: HASH_BYTES
  });
  const ownerIdentityHash = ownerHash.text;
  const key = record(body.key, 'key');
  const keyEpoch = uintField(key.keyEpoch, 'key.keyEpoch');
  const wrap = bytesField(key.wrapped, 'key.wrapped', { exact: WRAP_BYTES });
  const wrapped = wrap.text;
  const deviceId = idField(body.deviceId, 'deviceId');
  const signature = bytesField(body.signature, 'signature', {
    exact: STATEMENT_SIGNATURE_BYTES
  }).bytes;
  const identity = await currentIdentity(ctx.db, ctx.userId);
  if (identity?.hash !== ownerIdentityHash) {
    refuse(
      409,
      'E2EE_SHARE_OWNER_MISMATCH',
      'The link names another identity than your current one. Reload and try again.'
    );
  }
  const current = await currentKeyEpoch(ctx.db, projectId);
  if (keyEpoch !== current) stale(current);
  // A link serves for as long as it lives, so the owner account is not
  // enough (#912 review): only a device the owner's newest device list
  // certifies may register one, proven by its signature over everything
  // stored here. An owner device removed while its session stays signed in
  // cannot register links, nor fill the project's live-link limit...
  const device = await requireCertifiedDevice(ctx.db, ctx.userId, deviceId);
  let verified: boolean;
  try {
    verified = await verifyShareLinkRegistration(
      device.signingKey,
      {
        projectId,
        shareId,
        tokenHash: fromHex(tokenHash),
        mode,
        shareKeyHash: keyHash.bytes,
        ownerIdentityKeyHash: ownerHash.bytes,
        keyEpoch,
        wrapped: wrap.bytes
      },
      signature
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    refuse(
      400,
      'E2EE_SIGNATURE_INVALID',
      'The link registration is not signed by the device it names.'
    );
  }
  // ...and a removal of that device landing first makes the insert refuse.
  const signerList = deviceListUnchanged(ctx.userId, device);
  const linkLimit: () => never = () =>
    refuse(
      409,
      'E2EE_SHARE_LINK_LIMIT',
      `A project keeps at most ${MAX_LIVE_SHARE_LINKS} share links. Revoke one first.`
    );
  const liveLinks = async () =>
    (
      await ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM e2ee_share_links
           WHERE project_id = ? AND revoked_at IS NULL`
        )
        .bind(projectId)
        .first<{ n: number }>()
    )?.n ?? 0;
  if ((await liveLinks()) >= MAX_LIVE_SHARE_LINKS) linkLimit();
  const now = new Date().toISOString();
  const results = await runBatch(ctx.db, [
    ctx.db
      .prepare(
        `INSERT INTO e2ee_share_links
           (project_id, share_id, token_hash, mode, share_key_hash,
            owner_identity_hash, created_by_user_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${ctx.authorization.sql} AND ${PROJECT_FENCE}
           AND EXISTS (SELECT 1 FROM e2ee_project_groups
             WHERE project_id = ? AND key_epoch_base + epoch = ?)
           AND (SELECT COUNT(*) FROM e2ee_share_links
             WHERE project_id = ? AND revoked_at IS NULL) < ?
           AND ${signerList.sql}`
      )
      .bind(
        projectId,
        shareId,
        tokenHash,
        mode,
        shareKeyHash,
        ownerIdentityHash,
        ctx.userId,
        now,
        ...ctx.authorization.binds,
        projectId,
        ctx.userId,
        projectId,
        keyEpoch,
        projectId,
        MAX_LIVE_SHARE_LINKS,
        ...signerList.binds
      ),
    ctx.db
      .prepare(
        `INSERT INTO e2ee_share_keys
           (project_id, share_id, key_epoch, wrapped, created_by_user_id,
            created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`
      )
      .bind(projectId, shareId, keyEpoch, wrapped, ctx.userId, now)
  ]);
  if (!changed(results[0]) || !changed(results[1])) {
    if (await deviceListMoved(ctx.db, ctx.userId, device)) {
      refuseDeviceListMoved();
    }
    const after = await currentKeyEpoch(ctx.db, projectId);
    if (after !== keyEpoch) stale(after);
    if ((await liveLinks()) >= MAX_LIVE_SHARE_LINKS) linkLimit();
    sessionRequired();
  }
  return json(await oneLink(ctx.db, projectId, shareId), 201);
}

async function forgetLink(
  ctx: Context,
  projectId: string,
  shareId: string,
  body: Record<string, unknown>
): Promise<Response> {
  const keyEpoch = uintField(body.keyEpoch, 'keyEpoch');
  const deviceId = idField(body.deviceId, 'deviceId');
  const signature = bytesField(body.signature, 'signature', {
    exact: STATEMENT_SIGNATURE_BYTES
  }).bytes;
  const row = await linkRow(ctx.db, projectId, shareId);
  if (!row) {
    refuse(404, 'E2EE_SHARE_LINK_NOT_FOUND', 'This share link does not exist.');
  }
  if (row.revoked_at !== null) {
    // Asked again: what a failed delete left behind is retried.
    await reclaimForgottenSnapshots(ctx, projectId, shareId);
    return json({ ok: true });
  }
  const current = await currentKeyEpoch(ctx.db, projectId);
  if (keyEpoch !== current) stale(current);
  // Forgetting is permanent and breaks every URL of the link, so the owner
  // account is not enough: only a device the owner's newest device list
  // certifies may ask, proven by its signature over this link and the
  // current key epoch. An owner device removed while its session stays
  // signed in cannot forget the links.
  const device = await requireCertifiedDevice(ctx.db, ctx.userId, deviceId);
  let verified: boolean;
  try {
    verified = await verifyShareLinkForget(
      device.signingKey,
      { projectId, shareId, keyEpoch },
      signature
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    refuse(
      400,
      'E2EE_SIGNATURE_INVALID',
      'The forget request is not signed by the device it names.'
    );
  }
  // ...and a removal of that device landing first makes the batch refuse.
  const signerList = deviceListUnchanged(ctx.userId, device);
  const now = new Date().toISOString();
  const results = await runBatch(ctx.db, [
    ctx.db
      .prepare(
        `UPDATE e2ee_share_links
         SET revoked_at = ?, authority = NULL, authority_signature = NULL,
             authority_sequence = NULL, authority_expires_at = NULL
         WHERE project_id = ? AND share_id = ? AND revoked_at IS NULL
           AND ${ctx.authorization.sql} AND ${PROJECT_FENCE}
           AND EXISTS (SELECT 1 FROM e2ee_project_groups
             WHERE project_id = ? AND key_epoch_base + epoch = ?)
           AND ${signerList.sql}`
      )
      .bind(
        now,
        projectId,
        shareId,
        ...ctx.authorization.binds,
        projectId,
        ctx.userId,
        projectId,
        keyEpoch,
        ...signerList.binds
      ),
    // The snapshot row stays until its object is deleted (below).
    ctx.db
      .prepare(
        `DELETE FROM e2ee_share_keys
         WHERE project_id = ? AND share_id = ? AND EXISTS (
           SELECT 1 FROM e2ee_share_links WHERE project_id = ? AND share_id = ?
             AND revoked_at = ?)`
      )
      .bind(projectId, shareId, projectId, shareId, now)
  ]);
  if (!changed(results[0])) {
    const after = await linkRow(ctx.db, projectId, shareId);
    if (after?.revoked_at) {
      await reclaimForgottenSnapshots(ctx, projectId, shareId);
      return json({ ok: true });
    }
    if (await deviceListMoved(ctx.db, ctx.userId, device)) {
      refuseDeviceListMoved();
    }
    const epoch = await currentKeyEpoch(ctx.db, projectId);
    if (epoch !== keyEpoch) stale(epoch);
    sessionRequired();
  }
  await reclaimForgottenSnapshots(ctx, projectId, shareId);
  return json({ ok: true });
}

async function postKey(
  ctx: Context,
  projectId: string,
  shareId: string,
  body: Record<string, unknown>
): Promise<Response> {
  const keyEpoch = uintField(body.keyEpoch, 'keyEpoch');
  const wrap = bytesField(body.wrapped, 'wrapped', { exact: WRAP_BYTES });
  const wrapped = wrap.text;
  const deviceId = idField(body.deviceId, 'deviceId');
  const signature = bytesField(body.signature, 'signature', {
    exact: STATEMENT_SIGNATURE_BYTES
  }).bytes;
  await liveLink(ctx.db, projectId, shareId);
  const current = await currentKeyEpoch(ctx.db, projectId);
  if (keyEpoch !== current) stale(current);
  // The first wrap per epoch wins, so only a device the caller's newest
  // device list certifies may store one, proven by its signature: a revoked
  // device of an account that stays an editor cannot plant a wrap no member
  // can open and so break publication for the link.
  const device = await requireCertifiedDevice(ctx.db, ctx.userId, deviceId);
  let verified: boolean;
  try {
    verified = await verifyShareKeyWrap(
      device.signingKey,
      { projectId, shareId, keyEpoch, wrapped: wrap.bytes },
      signature
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    refuse(
      400,
      'E2EE_SIGNATURE_INVALID',
      'The key wrap is not signed by the device it names.'
    );
  }
  // ...and a removal of that device landing first makes the insert refuse.
  const signerList = deviceListUnchanged(ctx.userId, device);
  const results = await runBatch(ctx.db, [
    ctx.db
      .prepare(
        `INSERT INTO e2ee_share_keys
           (project_id, share_id, key_epoch, wrapped, created_by_user_id,
            created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE ${ctx.authorization.sql} AND ${WRITER_FENCE}
           AND EXISTS (SELECT 1 FROM e2ee_share_links
             WHERE project_id = ? AND share_id = ? AND revoked_at IS NULL)
           AND EXISTS (SELECT 1 FROM e2ee_project_groups
             WHERE project_id = ? AND key_epoch_base + epoch = ?)
           AND ${signerList.sql}
         ON CONFLICT (project_id, share_id, key_epoch) DO NOTHING`
      )
      .bind(
        projectId,
        shareId,
        keyEpoch,
        wrapped,
        ctx.userId,
        new Date().toISOString(),
        ...ctx.authorization.binds,
        ...fenceBinds(projectId, ctx.userId),
        projectId,
        shareId,
        projectId,
        keyEpoch,
        ...signerList.binds
      )
  ]);
  if (
    !changed(results[0]) &&
    (await deviceListMoved(ctx.db, ctx.userId, device))
  ) {
    refuseDeviceListMoved();
  }
  const stored = await ctx.db
    .prepare(
      `SELECT key_epoch, wrapped FROM e2ee_share_keys
       WHERE project_id = ? AND share_id = ? AND key_epoch = ?`
    )
    .bind(projectId, shareId, keyEpoch)
    .first<{ key_epoch: number; wrapped: string }>();
  if (!stored) {
    const after = await currentKeyEpoch(ctx.db, projectId);
    if (after !== keyEpoch) stale(after);
    sessionRequired();
  }
  return json({
    key: { keyEpoch: stored.key_epoch, wrapped: stored.wrapped }
  } satisfies E2eeShareKeyResponse);
}

async function putAuthority(
  ctx: Context,
  projectId: string,
  shareId: string,
  body: Record<string, unknown>
): Promise<Response> {
  const signed = signedField(body, MAX_SHARE_AUTHORITY_BYTES);
  const link = await liveLink(ctx.db, projectId, shareId);
  const stored = await delegationRow(ctx.db, ctx.userId);
  if (!stored) {
    refuse(
      409,
      'E2EE_SHARE_DELEGATION_REQUIRED',
      'Confirm sharing with your passkey or recovery key first.'
    );
  }
  let delegation: ShareDelegation;
  try {
    delegation = decodeShareDelegation(fromBase64Url(stored.statement));
  } catch {
    refuse(
      409,
      'E2EE_SHARE_DELEGATION_REQUIRED',
      'Confirm sharing with your passkey or recovery key first.'
    );
  }
  let statement;
  try {
    statement = await verifyShareAuthority(
      { statement: signed.statement, signature: signed.signature },
      delegation,
      {
        now: Date.now(),
        expected: {
          projectId,
          shareId,
          shareKeyHash: fromBase64Url(link.share_key_hash)
        }
      }
    );
  } catch (error) {
    if (
      error instanceof ShareLinkError &&
      error.reason === 'signer-not-delegated'
    ) {
      refuse(
        409,
        'E2EE_SHARE_DELEGATION_REQUIRED',
        'This device is not in your current share delegation. Confirm sharing again.'
      );
    }
    invalid(
      error instanceof ShareLinkError
        ? `The statement does not verify (${error.reason})`
        : 'The statement is not a share-authority statement'
    );
  }
  if (b64(statement.ownerIdentityKeyHash) !== link.owner_identity_hash) {
    invalid('The statement names another owner than the link');
  }
  if (
    link.authority_sequence !== null &&
    statement.sequence <= link.authority_sequence
  ) {
    refuse(
      409,
      'E2EE_SHARE_AUTHORITY_STALE',
      'A newer statement is already stored for this link.',
      { sequence: link.authority_sequence }
    );
  }
  // The delegation the statement verified against may still name a device
  // the owner since removed, until it is renewed. Each stored sequence only
  // climbs, so a removed device's statement at the top of the range would
  // leave the link unusable for good: only a device the owner's newest
  // device list certifies may sign one (#912 review)...
  const signer = await requireCertifiedSigner(
    ctx.db,
    ctx.userId,
    statement.signerKeyHash
  );
  // ...and a removal of that device landing first makes the write refuse.
  const signerList = deviceListUnchanged(ctx.userId, signer);
  let results;
  try {
    results = await runBatch(ctx.db, [
      ctx.db
        .prepare(
          `UPDATE e2ee_share_links
           SET authority = ?, authority_signature = ?, authority_sequence = ?,
               authority_expires_at = ?
           WHERE project_id = ? AND share_id = ? AND revoked_at IS NULL
             AND (authority_sequence IS NULL OR authority_sequence < ?)
             AND ${ctx.authorization.sql} AND ${PROJECT_FENCE}
             AND ${signerList.sql}`
        )
        .bind(
          signed.text.statement,
          signed.text.signature,
          statement.sequence,
          statement.expiresAt,
          projectId,
          shareId,
          statement.sequence,
          ...ctx.authorization.binds,
          projectId,
          ctx.userId,
          ...signerList.binds
        )
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('E2EE_SHARE_LINK_IMMUTABLE')
    ) {
      refuse(
        409,
        'E2EE_SHARE_AUTHORITY_STALE',
        'A newer statement is already stored for this link.'
      );
    }
    throw error;
  }
  if (!changed(results[0])) {
    const after = await linkRow(ctx.db, projectId, shareId);
    if (!after || after.revoked_at !== null) {
      refuse(
        404,
        'E2EE_SHARE_LINK_NOT_FOUND',
        'This share link does not exist.'
      );
    }
    if ((after.authority_sequence ?? -1) >= statement.sequence) {
      refuse(
        409,
        'E2EE_SHARE_AUTHORITY_STALE',
        'A newer statement is already stored for this link.',
        { sequence: after.authority_sequence }
      );
    }
    if (await deviceListMoved(ctx.db, ctx.userId, signer)) {
      refuseDeviceListMoved();
    }
    sessionRequired();
  }
  return json(await oneLink(ctx.db, projectId, shareId));
}

async function putSnapshot(
  ctx: Context,
  projectId: string,
  shareId: string,
  request: Request
): Promise<Response> {
  const { metadata, payload } = await readFrame(request);
  const signature = bytesField(metadata.signature, 'signature', {
    exact: VERSION_SIGNATURE_BYTES
  });
  const signerDeviceId = idField(metadata.signerDeviceId, 'signerDeviceId');
  const forVisitors = bytesField(
    metadata.wrappedForLinkVisitors,
    'wrappedForLinkVisitors',
    { exact: WRAP_BYTES }
  ).text;
  const forMembers = bytesField(
    metadata.wrappedForMembers,
    'wrappedForMembers',
    { exact: WRAP_BYTES }
  ).text;
  let header;
  try {
    header = parseEnvelope(payload).header;
  } catch {
    invalid('The body is not an envelope');
  }
  if (
    header.class !== 'project' ||
    header.kind !== 'share-snapshot' ||
    header.projectId !== projectId ||
    header.documentVersion < 1
  ) {
    invalid('The body must be a share snapshot of this project');
  }
  const device = await requireCertifiedDevice(
    ctx.db,
    ctx.userId,
    signerDeviceId
  );
  let verified: boolean;
  try {
    verified =
      (await verifyProjectEnvelopeSignature(
        device.signingKey,
        payload,
        signature.bytes
      )) !== null;
  } catch {
    verified = false;
  }
  if (!verified) {
    refuse(
      400,
      'E2EE_SIGNATURE_INVALID',
      'The envelope is not signed by the device it names.'
    );
  }
  // ...and a removal of that device landing first makes the write refuse,
  // as for encrypted document writes (#912 review): a removed device's
  // snapshot cannot replace what certified devices published.
  const signerList = deviceListUnchanged(ctx.userId, device);
  await liveLink(ctx.db, projectId, shareId);
  const current = await currentKeyEpoch(ctx.db, projectId);
  if (header.keyEpoch !== current) stale(current);
  const project = await ctx.db
    .prepare('SELECT document_version FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ document_version: number }>();
  if (!project || header.documentVersion > project.document_version) {
    invalid('A snapshot names no version the project has');
  }
  const previous = await ctx.db
    .prepare(
      `SELECT document_version FROM e2ee_share_snapshots
       WHERE project_id = ? AND share_id = ?`
    )
    .bind(projectId, shareId)
    .first<{ document_version: number }>();
  const snapshotStale: () => never = () =>
    refuse(
      409,
      'E2EE_SHARE_SNAPSHOT_STALE',
      'A snapshot of a newer version is already published for this link.'
    );
  if (previous && previous.document_version > header.documentVersion) {
    snapshotStale();
  }
  const hash = toHex(await versionHash(payload));
  let inline: string | null = null;
  let objectKey: string | null = null;
  if (payload.byteLength <= INLINE_SNAPSHOT_BYTES || !ctx.bucket) {
    if (payload.byteLength > INLINE_SNAPSHOT_LIMIT) {
      refuse(
        413,
        'DOCUMENT_TOO_LARGE',
        'This snapshot is too large to store without project storage.',
        { limitBytes: INLINE_SNAPSHOT_LIMIT }
      );
    }
    inline = b64(payload);
  } else {
    // Under this link and this write alone (#912 review): no other link's
    // row, and no other write of this link, ever names the object, so
    // replacing or forgetting one link cannot delete what another serves.
    objectKey = await snapshotObjectKey(projectId, shareId, hash);
    await ctx.bucket.put(objectKey, payload);
  }
  const now = new Date().toISOString();
  // Only this request's own object, which no row names unless the write
  // below committed.
  const discard = async () => {
    if (objectKey && ctx.bucket) {
      await ctx.bucket.delete(objectKey).catch(() => undefined);
    }
  };
  let results;
  try {
    results = await runBatch(ctx.db, [
      // The object the write replaces, read in the same transaction: a
      // concurrent write at the same (or another) version that landed after
      // `previous` was read is what this one replaces, and is deleted.
      ctx.db
        .prepare(
          `SELECT envelope_key FROM e2ee_share_snapshots
           WHERE project_id = ? AND share_id = ?`
        )
        .bind(projectId, shareId),
      ctx.db
        .prepare(
          `INSERT INTO e2ee_share_snapshots
             (project_id, share_id, document_version, key_epoch, snapshot_hash,
              envelope_inline, envelope_key, envelope_bytes, signature,
              wrapped_for_link_visitors, wrapped_for_members, author_key,
              signer_user_id, signer_device_id, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE ${ctx.authorization.sql} AND ${WRITER_FENCE}
             AND EXISTS (SELECT 1 FROM e2ee_share_links
               WHERE project_id = ? AND share_id = ? AND revoked_at IS NULL)
             AND EXISTS (SELECT 1 FROM e2ee_project_groups
               WHERE project_id = ? AND key_epoch_base + epoch = ?)
             AND ${signerList.sql}
           ON CONFLICT (project_id, share_id) DO UPDATE SET
             document_version = excluded.document_version,
             key_epoch = excluded.key_epoch,
             snapshot_hash = excluded.snapshot_hash,
             envelope_inline = excluded.envelope_inline,
             envelope_key = excluded.envelope_key,
             envelope_bytes = excluded.envelope_bytes,
             signature = excluded.signature,
             wrapped_for_link_visitors = excluded.wrapped_for_link_visitors,
             wrapped_for_members = excluded.wrapped_for_members,
             author_key = excluded.author_key,
             signer_user_id = excluded.signer_user_id,
             signer_device_id = excluded.signer_device_id,
             updated_at = excluded.updated_at
           WHERE excluded.document_version >= e2ee_share_snapshots.document_version`
        )
        .bind(
          projectId,
          shareId,
          header.documentVersion,
          header.keyEpoch,
          hash,
          inline,
          objectKey,
          payload.byteLength,
          signature.text,
          forVisitors,
          forMembers,
          b64(device.signingKey),
          ctx.userId,
          signerDeviceId,
          now,
          ...ctx.authorization.binds,
          ...fenceBinds(projectId, ctx.userId),
          projectId,
          shareId,
          projectId,
          header.keyEpoch,
          ...signerList.binds
        )
    ]);
  } catch (error) {
    await discard();
    throw error;
  }
  if (!changed(results[1])) {
    await discard();
    if (await deviceListMoved(ctx.db, ctx.userId, device)) {
      refuseDeviceListMoved();
    }
    await liveLink(ctx.db, projectId, shareId);
    const after = await currentKeyEpoch(ctx.db, projectId);
    if (after !== header.keyEpoch) stale(after);
    const now2 = await ctx.db
      .prepare(
        `SELECT document_version FROM e2ee_share_snapshots
         WHERE project_id = ? AND share_id = ?`
      )
      .bind(projectId, shareId)
      .first<{ document_version: number }>();
    if (now2 && now2.document_version > header.documentVersion) snapshotStale();
    sessionRequired();
  }
  const replaced =
    (results[0]?.results?.[0] as { envelope_key: string | null } | undefined)
      ?.envelope_key ?? null;
  if (replaced && replaced !== objectKey) {
    await deleteSnapshotObject(ctx, projectId, shareId, replaced);
  }
  return json(await oneLink(ctx.db, projectId, shareId));
}

// --- Snapshot objects ----------------------------------------------------------

/**
 * Where a snapshot body above the inline size lives in R2:
 * `e2ee/<project>/s/<link>/<envelope hash>-<nonce>`. `<link>` is the first
 * 128 bits of SHA-256 of the link id, so the key stays opaque and every
 * object of one link shares a prefix; the nonce makes each write's object
 * its own. Rows written before #912's review name `e2ee/<project>/s/<hash>`,
 * which two links could share.
 */
async function snapshotObjectKey(
  projectId: string,
  shareId: string,
  hash: string
): Promise<string> {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return `${await snapshotObjectPrefix(projectId, shareId)}${hash}-${nonce}`;
}

async function snapshotObjectPrefix(
  projectId: string,
  shareId: string
): Promise<string> {
  const link = (await sha256Hex(new TextEncoder().encode(shareId))).slice(
    0,
    32
  );
  return `e2ee/${projectId}/s/${link}/`;
}

/**
 * Deletes a snapshot object no row names any more, once retried. Never one
 * another link's row still names (an object stored before #912's review,
 * keyed by envelope hash alone). Whether it is gone.
 */
async function deleteSnapshotObject(
  ctx: Context,
  projectId: string,
  shareId: string,
  key: string
): Promise<boolean> {
  if (!ctx.bucket) return false;
  const shared = await ctx.db
    .prepare(
      `SELECT 1 AS named FROM e2ee_share_snapshots
       WHERE project_id = ? AND share_id <> ? AND envelope_key = ? LIMIT 1`
    )
    .bind(projectId, shareId, key)
    .first<{ named: number }>();
  if (shared) return true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await ctx.bucket.delete(key);
      return true;
    } catch {
      // Retried once; a later forget of the link sweeps its prefix.
    }
  }
  return false;
}

/** Forgotten links whose leftovers one request also retries. */
const RECLAIM_OTHERS = 5;
/** Listing pages one sweep of a link's prefix reads at most. */
const SWEEP_PAGES = 10;

/**
 * Deletes what forgotten links still hold in R2, then their snapshot rows
 * (#912 review): `shareId`'s, and a few other forgotten links' of the
 * project that a failed delete left behind. A forgotten link's row keeps
 * naming its object until the delete succeeded (and its prefix was swept
 * of objects a failed replacement left), so a failed delete never drops
 * the only reference to an object: it is retried here on the next forget,
 * and the project's purge deletes every object a row names.
 */
async function reclaimForgottenSnapshots(
  ctx: Context,
  projectId: string,
  shareId: string
): Promise<void> {
  const others = await ctx.db
    .prepare(
      `SELECT s.share_id FROM e2ee_share_snapshots s
       JOIN e2ee_share_links l
         ON l.project_id = s.project_id AND l.share_id = s.share_id
       WHERE s.project_id = ? AND s.share_id <> ?
         AND l.revoked_at IS NOT NULL
       ORDER BY l.revoked_at LIMIT ?`
    )
    .bind(projectId, shareId, RECLAIM_OTHERS)
    .all<{ share_id: string }>();
  for (const id of [
    shareId,
    ...(others.results ?? []).map((row) => row.share_id)
  ]) {
    await reclaimForgottenSnapshot(ctx, projectId, id);
  }
}

async function reclaimForgottenSnapshot(
  ctx: Context,
  projectId: string,
  shareId: string
): Promise<void> {
  const row = await ctx.db
    .prepare(
      `SELECT s.envelope_key FROM e2ee_share_snapshots s
       JOIN e2ee_share_links l
         ON l.project_id = s.project_id AND l.share_id = s.share_id
       WHERE s.project_id = ? AND s.share_id = ?
         AND l.revoked_at IS NOT NULL`
    )
    .bind(projectId, shareId)
    .first<{ envelope_key: string | null }>();
  let gone = row?.envelope_key
    ? await deleteSnapshotObject(ctx, projectId, shareId, row.envelope_key)
    : true;
  if (ctx.bucket && !(await sweepLinkObjects(ctx.bucket, projectId, shareId))) {
    gone = false;
  }
  if (!row || !gone) return;
  await ctx.db
    .prepare(
      `DELETE FROM e2ee_share_snapshots
       WHERE project_id = ? AND share_id = ? AND envelope_key IS ?
         AND EXISTS (SELECT 1 FROM e2ee_share_links
           WHERE project_id = ? AND share_id = ? AND revoked_at IS NOT NULL)`
    )
    .bind(projectId, shareId, row.envelope_key, projectId, shareId)
    .run();
}

/**
 * Deletes every object under a forgotten link's prefix: replaced objects a
 * failed delete left there. A write racing the forget cannot land (its
 * link is revoked) and deletes its own object. Whether the prefix is
 * empty; a bucket that cannot list has nothing found here.
 */
async function sweepLinkObjects(
  bucket: ShareSnapshotBucket,
  projectId: string,
  shareId: string
): Promise<boolean> {
  if (typeof bucket.list !== 'function') return true;
  const prefix = await snapshotObjectPrefix(projectId, shareId);
  try {
    // Listed again from the start each time: everything listed is deleted.
    for (let page = 0; page < SWEEP_PAGES; page += 1) {
      const listed = await bucket.list({ prefix });
      await Promise.all(listed.objects.map((o) => bucket.delete(o.key)));
      if (!listed.truncated) return true;
    }
  } catch {
    // Kept for the next forget.
  }
  return false;
}

// --- Dispatch ----------------------------------------------------------------

/**
 * Handles the owner-side routes. `projectsEnabled` is the account's
 * E2EE_PROJECTS_ENABLED decision, `sharingEnabled` its sharing rollout;
 * `authorization` is the session/erasure write predicate (an always-false
 * one for reads).
 */
export async function handleE2eeShareLinkRequest(
  request: Request,
  db: D1Database,
  bucket: ShareSnapshotBucket | null,
  userId: string,
  projectsEnabled: boolean,
  sharingEnabled: boolean,
  authorization: Authorization
): Promise<Response> {
  try {
    if (!projectsEnabled) {
      refuse(
        501,
        'FEATURE_DISABLED',
        'Encrypted projects are not available for this account yet.'
      );
    }
    if (
      !(await isProjectStorageFormatReady(db)) ||
      !(await isE2eeProjectGroupStorageReady(db)) ||
      !(await isE2eeShareLinkStorageReady(db))
    ) {
      refuse(
        503,
        'E2EE_UNAVAILABLE',
        'Share links of encrypted projects are unavailable until the database is updated.'
      );
    }
    const ctx: Context = { db, bucket, userId, authorization };
    const url = new URL(request.url);
    const method = request.method;
    if (url.pathname === DELEGATION_ROUTE) {
      if (method === 'GET') {
        return json({
          delegation: delegationOf(await delegationRow(db, userId))
        } satisfies E2eeShareDelegationResponse);
      }
      if (method === 'PUT')
        return await putDelegation(ctx, await readJson(request));
      refuse(404, 'NOT_FOUND', 'Not found.');
    }
    const match = LINKS_ROUTE.exec(url.pathname)!;
    let projectId: string;
    let shareId: string | null;
    try {
      projectId = decodeURIComponent(match[1]!);
      shareId = match[2] === undefined ? null : decodeURIComponent(match[2]);
    } catch {
      refuse(404, 'NOT_FOUND', 'Not found.');
    }
    const action = match[3] ?? null;
    if (shareId === null) {
      if (method === 'GET') {
        const access = await requireEncryptedProjectAccess(
          db,
          userId,
          projectId,
          'read'
        );
        return json({
          links: await linkRecords(db, projectId),
          delegation: delegationOf(await delegationRow(db, access.ownerUserId))
        } satisfies E2eeShareLinksResponse);
      }
      if (method === 'POST') {
        await requireOwnedEncryptedProject(db, userId, projectId);
        if (!sharingEnabled) {
          refuse(
            403,
            'FEATURE_DISABLED',
            'Project sharing is not available for this account yet.'
          );
        }
        return await createLink(ctx, projectId, await readJson(request));
      }
      refuse(404, 'NOT_FOUND', 'Not found.');
    }
    idField(shareId, 'shareId');
    if (action === null && method === 'DELETE') {
      await requireOwnedEncryptedProject(db, userId, projectId);
      return await forgetLink(ctx, projectId, shareId, await readJson(request));
    }
    if (action === 'keys' && method === 'POST') {
      await requireEncryptedProjectAccess(db, userId, projectId, 'write');
      return await postKey(ctx, projectId, shareId, await readJson(request));
    }
    if (action === 'authority' && method === 'PUT') {
      await requireOwnedEncryptedProject(db, userId, projectId);
      return await putAuthority(
        ctx,
        projectId,
        shareId,
        await readJson(request)
      );
    }
    if (action === 'snapshot' && method === 'PUT') {
      await requireEncryptedProjectAccess(db, userId, projectId, 'write');
      return await putSnapshot(ctx, projectId, shareId, request);
    }
    refuse(404, 'NOT_FOUND', 'Not found.');
  } catch (error) {
    if (error instanceof RouteError) {
      return json(
        { error: error.message, code: error.code, ...error.extra },
        error.status
      );
    }
    throw error;
  }
}

// --- The anonymous route -----------------------------------------------------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
    )
  );
}

/** The token hash the server stores: SHA-256 of the token's 32 bytes. */
export async function shareLinkTokenHash(token: string): Promise<string> {
  return sha256Hex(fromBase64Url(token));
}

/** One link as the anonymous routes serve it, after every gate below. */
interface ServedLink {
  project_id: string;
  share_id: string;
  mode: E2eeShareLinkMode;
  authority: string;
  authority_signature: string;
  owner_user_id: string;
  document_version: number;
  key_epoch: number;
  envelope_inline: string | null;
  envelope_key: string | null;
  signature: string;
  wrapped_for_link_visitors: string;
  author_key: string;
}

/**
 * The link a token names, or null: format-2 projects only, never trashed,
 * a live (not revoked) link with a statement and a published snapshot, and
 * only while the owner's own sharing switch is on (re-evaluated per read,
 * as for plaintext links), with the tables of migrations 0031, 0032 and
 * 0040 present. Both anonymous routes go through it, so the blob route
 * serves nothing the snapshot route would not.
 */
async function servedLink(
  db: D1Database,
  rawToken: string
): Promise<ServedLink | null> {
  let token: string;
  try {
    token = decodeURIComponent(rawToken);
  } catch {
    return null;
  }
  if (!TOKEN.test(token)) return null;
  if (
    !(await isProjectStorageFormatReady(db)) ||
    !(await isE2eeProjectGroupStorageReady(db)) ||
    !(await isE2eeShareLinkStorageReady(db))
  ) {
    return null;
  }
  return db
    .prepare(
      `SELECT l.project_id, l.share_id, l.mode, l.authority,
              l.authority_signature, p.user_id AS owner_user_id,
              s.document_version, s.key_epoch, s.envelope_inline,
              s.envelope_key, s.signature, s.wrapped_for_link_visitors,
              s.author_key
       FROM e2ee_share_links l
       JOIN projects p ON p.id = l.project_id
       JOIN e2ee_share_snapshots s
         ON s.project_id = l.project_id AND s.share_id = l.share_id
       LEFT JOIN user_settings owner_settings
         ON owner_settings.user_id = p.user_id
       WHERE l.token_hash = ? AND l.revoked_at IS NULL
         AND l.authority IS NOT NULL
         AND p.storage_format = 2 AND p.status <> 'deleted'
         AND COALESCE(
           CASE WHEN json_valid(owner_settings.settings_json)
             THEN json_extract(
               owner_settings.settings_json,
               '$.collaboration.enabled'
             )
           END,
           1
         ) = 1`
    )
    .bind(await shareLinkTokenHash(token))
    .first<ServedLink>();
}

/** The link's stored snapshot envelope, inline or from the object store. */
async function servedEnvelope(
  row: ServedLink,
  bucket: ShareSnapshotBucket | null
): Promise<Uint8Array | null> {
  if (row.envelope_inline !== null) return fromBase64Url(row.envelope_inline);
  if (row.envelope_key !== null && bucket) {
    const stored = await bucket.get(row.envelope_key);
    if (stored) return new Uint8Array(await stored.arrayBuffer());
  }
  return null;
}

function anonymousNotFound(): Response {
  return new Response(JSON.stringify({ error: 'Share link not found.' }), {
    status: 404,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  });
}

/**
 * `GET /api/e2ee/share/:token`, anonymous: the capability token in the path
 * is the whole authorization. `open` is the deployment's decision (the
 * E2EE_PROJECTS_ENABLED flag and the global sharing rollout); anything that
 * cannot be served is one opaque 404, as on the plaintext route.
 */
export async function handleEncryptedSharedSnapshot(
  pathname: string,
  db: D1Database | undefined,
  bucket: ShareSnapshotBucket | null,
  open: boolean
): Promise<Response> {
  if (!open || !db) return anonymousNotFound();
  const match = SHARED_ROUTE.exec(pathname);
  if (!match) return anonymousNotFound();
  const row = await servedLink(db, match[1] ?? '');
  if (!row) return anonymousNotFound();
  const [delegation, identity] = await Promise.all([
    delegationRow(db, row.owner_user_id),
    currentIdentity(db, row.owner_user_id)
  ]);
  if (!delegation || !identity) return anonymousNotFound();
  const envelope = await servedEnvelope(row, bucket);
  if (!envelope) return anonymousNotFound();
  const metadata: E2eeSharedSnapshotMetadata = {
    shareId: row.share_id,
    mode: row.mode,
    documentVersion: row.document_version,
    keyEpoch: row.key_epoch,
    versionId: shareSnapshotVersionId(row.document_version),
    snapshotSignature: row.signature,
    wrappedVersionKey: row.wrapped_for_link_visitors,
    authorKey: row.author_key,
    authority: { statement: row.authority, signature: row.authority_signature },
    delegation: {
      statement: delegation.statement,
      signature: delegation.signature
    },
    ownerIdentityKey: b64(identity.key)
  };
  return new Response(encodeE2eeFrame(metadata, envelope), {
    status: 200,
    headers: {
      'content-type': E2EE_FRAME_CONTENT_TYPE,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    }
  });
}

/**
 * The anonymous blob route's rate limit (`worker/index.ts`). Each may
 * throw the limiter's 429.
 */
export interface SharedBlobGuard {
  /** A request that names no link the route serves. */
  unbudgeted(): Promise<void>;
  /** A request within a load of the link `linkKey` names, of `blobs` blobs. */
  load(linkKey: string, blobs: number): Promise<void>;
}

/** Where the owner's encrypted content blobs live (the artifact bucket). */
export interface SharedBlobBucket {
  get(key: string): Promise<{
    body?: ReadableStream<Uint8Array>;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
}

/**
 * `GET /api/e2ee/share/:token/blobs/:blobId`, anonymous (slice 5-11): the
 * ciphertext of one content blob the link's current snapshot names, the
 * owner's own bytes for that project, unchanged. The token goes through
 * every gate of the snapshot route (`servedLink`); the blob id must be one
 * the stored snapshot envelope's header lists in `blobIds` and a committed
 * blob of the link's project. The server never holds a blob's key: a
 * visitor decrypts it with the reference in the snapshot body, which also
 * authenticates its ciphertext hash and length. Everything else is the
 * same opaque 404; a blob row whose object is missing is 503, as for
 * members.
 *
 * `guard` is the deployment's rate limit (#923 review): a request that
 * names no servable link counts against the address's own budget
 * (`unbudgeted`); one that does counts as part of a load of that link
 * (`load`), whose budget is sized to the blobs its snapshot names, so a
 * model with more imports than the address budget still loads at once.
 */
export async function handleEncryptedSharedBlob(
  pathname: string,
  db: D1Database | undefined,
  snapshots: ShareSnapshotBucket | null,
  blobs: SharedBlobBucket | null,
  open: boolean,
  guard: SharedBlobGuard | null = null
): Promise<Response> {
  if (!open || !db || !blobs) return anonymousNotFound();
  const notServed = async () => {
    await guard?.unbudgeted();
    return anonymousNotFound();
  };
  const match = SHARED_BLOB_ROUTE.exec(pathname);
  const blobId = match?.[2] ?? '';
  if (!match || !E2EE_BLOB_ID_PATTERN.test(blobId)) return notServed();
  const row = await servedLink(db, match[1] ?? '');
  if (!row || !(await isE2eeContentBlobStorageReady(db))) return notServed();
  const envelope = await servedEnvelope(row, snapshots);
  if (!envelope) return notServed();
  let named: readonly string[];
  try {
    const { header } = parseEnvelope(envelope);
    if (header.class !== 'project' || header.kind !== 'share-snapshot') {
      return notServed();
    }
    named = header.blobIds;
  } catch {
    return notServed();
  }
  // Opaque: neither the project nor the link id reaches the limiter.
  await guard?.load(
    (
      await sha256Hex(
        new TextEncoder().encode(`${row.project_id}
${row.share_id}`)
      )
    ).slice(0, 32),
    named.length
  );
  if (!named.includes(blobId)) return anonymousNotFound();
  const blob = await db
    .prepare(
      `SELECT object_key, ciphertext_bytes FROM e2ee_content_blobs
       WHERE project_id = ? AND blob_id = ? AND state = 'committed'`
    )
    .bind(row.project_id, blobId)
    .first<{ object_key: string; ciphertext_bytes: number }>();
  if (!blob) return anonymousNotFound();
  const stored = await blobs.get(blob.object_key);
  if (!stored) {
    return new Response(
      JSON.stringify({
        error: 'This encrypted file cannot be read right now.',
        code: 'E2EE_BLOB_UNAVAILABLE'
      }),
      {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store'
        }
      }
    );
  }
  // Streamed: a blob can be far larger than a Worker may buffer.
  return new Response(stored.body ?? (await stored.arrayBuffer()), {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.ciphertext_bytes),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    }
  });
}

// --- Erasure -----------------------------------------------------------------

/**
 * Account erasure (migration 0040): the account's share delegation is
 * profile data (its identity goes too). With `all`, the account's owned
 * projects and their links are already gone, and rows it wrote in other
 * owners' projects keep their bytes but lose its user id. Empty until the
 * tables exist.
 */
export async function shareLinkErasureStatements(
  db: D1Database,
  userId: string,
  scope: 'profile' | 'all'
): Promise<D1PreparedStatement[]> {
  if (!(await isE2eeShareLinkStorageReady(db))) return [];
  return [
    db
      .prepare('DELETE FROM e2ee_share_delegations WHERE user_id = ?')
      .bind(userId),
    ...(scope === 'all'
      ? [
          db
            .prepare(
              'UPDATE e2ee_share_links SET created_by_user_id = NULL WHERE created_by_user_id = ?'
            )
            .bind(userId),
          db
            .prepare(
              'UPDATE e2ee_share_keys SET created_by_user_id = NULL WHERE created_by_user_id = ?'
            )
            .bind(userId),
          db
            .prepare(
              'UPDATE e2ee_share_snapshots SET signer_user_id = NULL WHERE signer_user_id = ?'
            )
            .bind(userId)
        ]
      : [])
  ];
}
