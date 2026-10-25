/**
 * Share links of end-to-end encrypted projects in the browser (ADR-024
 * Phase 5, slice 5-10; roadmap L11): the owner creates and revokes links,
 * keeps their share-authority statements and the share delegation current,
 * and every editor republishes each active link's snapshot when it saves.
 *
 * - **Create** (owner). A fresh share key and link id; the owner device
 *   signs a grant ("OZL") at the current key epoch and the store writes a
 *   version whose body carries the new set (body version 2). The server
 *   then stores the token's hash and the share key wrapped under that
 *   epoch's project key (`share-key`), the statement, and the first
 *   snapshot. The link is `#share=<token>.<key>.<owner>`
 *   (`shareLinkFragment.ts`).
 * - **Revoke** (owner). A signed permanent tombstone ("OZY") replaces the
 *   grant in a new version; the server is then asked to forget the link
 *   (its snapshot, key wraps and statement go at once). The tombstone, not
 *   that one request, is what counts: while the server still lists a link
 *   the head tombstones, its revocation is pending and the owner's browser
 *   asks again (`forgetRevokedShareLinks`) on the next revoke, whenever the
 *   sharing dialog loads the links, and after a removal. Revoking a link
 *   already tombstoned only asks the server again.
 * - **Statements** ("OZA", owner devices the delegation names): at most
 *   seven days, a sequence that rises per link, naming the signing keys of
 *   the owner's and every current editor's devices as this browser pinned
 *   their device lists. The owner's browser issues a new one when a
 *   statement is missing, has two days or less left, names another author
 *   set (an editor removed, a device revoked or added) or was signed by a
 *   device the delegation no longer names, at once after a removal
 *   (`onMembersRemoved`), and when a co-member's device removal rotates
 *   the project (`onMemberDevicesRemoved`, slice 5-7).
 * - **Delegation** ("OZS", the identity key): at most 30 days, naming the
 *   owner's certified devices. Renewing it needs the identity key, so a
 *   passkey touch or the recovery key: the sharing dialog asks when sharing
 *   opens without a valid one and again in its last week, and removing an
 *   owner device renews it at once (`pageDeviceRemoval.ts`).
 * - **Snapshots** (owner and editors, `publishShareSnapshots`). After a
 *   save, one share-snapshot envelope per active link of the head's set:
 *   the shared projection of the document (`sharedProjectSnapshotDocument`)
 *   in a version 1 body, a fresh version key wrapped under the project key
 *   and the share key (`wrapShareSnapshotKey`, `versionId` the document
 *   version in decimal), signed by this device, under the current key
 *   epoch, where the share key is wrapped again first if needed.
 * - **Owner identity change.** A link names the owner's identity
 *   fingerprint, which visitors cannot see change hands: when a link the
 *   server lists names another fingerprint than the owner's current one,
 *   every link is tombstoned and the dialog offers to reissue them.
 *
 * Every head the store accepts has its set verified (`shareLinkSet.ts`).
 */
import {
  EnvelopeKey,
  decodeShareAuthority,
  decodeShareDelegation,
  encodeEncryptedDocumentBody,
  encryptProjectEnvelope,
  epochBinding,
  fromBase64Url,
  fromHex,
  openShareKey,
  shareKeyHash,
  signProjectEnvelope,
  signShareAuthority,
  signShareDelegation,
  signShareLinkGrant,
  signShareLinkTombstone,
  toBase64Url,
  verifyShareDelegation,
  wrapKey,
  wrapShareSnapshotKey,
  type ContentBlobReference,
  type ProjectEnvelopeHeaderInit,
  type ShareDelegation,
  type ShareLinkMode,
  type ShareLinkSet,
  type SignedStatement,
  type VerifiedShareLinkSet
} from '@openzcad/crypto';
import { sharedProjectSnapshotDocument } from '@openzcad/document-core';
import {
  shareSnapshotVersionId,
  type E2eeShareDelegationRecord,
  type E2eeShareLinkRecord,
  type E2eeShareLinksApi,
  type E2eeShareLinksResponse,
  type ProjectDocument
} from '@openzcad/shared';
import type { BlobReferenceRegistry } from './blobReferences';
import { documentBlobReferences } from './encryptedContentBlobs';
import type { EncryptedShareHead } from './encryptedProjectStore';
import {
  epochAuthenticatorForEpoch,
  epochRoles,
  joinProjectGroup,
  projectDeviceLists,
  projectKeyForEpoch,
  type MemberDevicesRemoved,
  type MembersRemoved,
  type ProjectGroupContext
} from './projectGroups';
import { ownerDeviceList, projectOwnerOf } from './shareLinkSet';
import {
  shareLinkToken,
  shareLinkTokenHash,
  shareLinkUrl,
  type ShareFragmentParts
} from './shareLinkFragment';

const DAY_MS = 86_400_000;
/** A statement's lifetime: the ADR's seven days. */
export const SHARE_AUTHORITY_LIFETIME_MS = 7 * DAY_MS;
/** A delegation's lifetime: the ADR's maximum, 30 days. */
export const SHARE_DELEGATION_LIFETIME_MS = 30 * DAY_MS;
/** The owner's browser asks to renew the delegation in its last week. */
export const SHARE_DELEGATION_RENEWAL_MS = 7 * DAY_MS;
/** A statement is renewed while online with two days or less left (judgment). */
export const SHARE_AUTHORITY_RENEWAL_MS = 2 * DAY_MS;
const SCHEMA_VERSION = 1;

export type ShareLinksErrorCode =
  | 'not-owner'
  | 'read-only-device'
  | 'link-not-found'
  | 'key-unavailable'
  /** Tombstoned in the project; the server did not confirm forgetting it. */
  | 'revocation-pending';

export class ShareLinksError extends Error {
  override readonly name = 'ShareLinksError';
  constructor(
    readonly code: ShareLinksErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** What the share-link flows need of the page. */
export interface ShareLinksContext {
  readonly groups: ProjectGroupContext;
  readonly store: {
    shareHead(projectId: string): Promise<EncryptedShareHead>;
    writeShareLinks(
      projectId: string,
      change: (
        current: VerifiedShareLinkSet | null,
        keyEpoch: number
      ) => Promise<ShareLinkSet>
    ): Promise<EncryptedShareHead>;
  };
  readonly api: E2eeShareLinksApi;
  /** Content blob references, for snapshots of documents with imports. */
  readonly blobReferences?: BlobReferenceRegistry;
  /** The app origin links are built on. */
  readonly origin?: string;
  readonly now?: () => number;
  readonly random?: (length: number) => Uint8Array;
}

const b64 = toBase64Url;
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function randomBytes(ctx: ShareLinksContext, length: number): Uint8Array {
  if (ctx.random) return ctx.random(length);
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

const nowOf = (ctx: { readonly now?: () => number }) => (ctx.now ?? Date.now)();

/** What the delegation flows need: no store, so a removal can renew it. */
export type ShareDelegationContext = Pick<
  ShareLinksContext,
  'groups' | 'api' | 'now'
>;

function requireDevice(ctx: ShareLinksContext) {
  const device = ctx.groups.device;
  const record = device
    ? ctx.groups.account.list.devices.find(
        (d) => d.deviceId === device.deviceId
      )
    : undefined;
  if (!device || !record) {
    throw new ShareLinksError(
      'read-only-device',
      'Share links are managed from a device listed in Settings › Encryption.'
    );
  }
  return { device, record };
}

async function requireOwner(
  ctx: ShareLinksContext,
  projectId: string,
  keyEpoch: number
): Promise<void> {
  const owner = await projectOwnerOf(ctx.groups, projectId, keyEpoch);
  if (owner !== ctx.groups.account.userId) {
    throw new ShareLinksError(
      'not-owner',
      'Only the project owner can create or revoke share links.'
    );
  }
}

/** A set's lists sorted by link id, as every link set must be. */
function sortedSet(
  grants: { id: string; signed: SignedStatement }[],
  tombstones: { id: string; signed: SignedStatement }[]
): ShareLinkSet {
  return {
    grants: [...grants].sort((a, b) => byId(a.id, b.id)).map((g) => g.signed),
    tombstones: [...tombstones]
      .sort((a, b) => byId(a.id, b.id))
      .map((t) => t.signed)
  };
}

function entriesOf(current: VerifiedShareLinkSet | null) {
  return {
    grants: (current?.links ?? []).map((link, index) => ({
      id: link.shareId,
      signed: current!.set.grants[index]!
    })),
    tombstones: (current?.tombstones ?? []).map((tombstone, index) => ({
      id: tombstone.shareId,
      signed: current!.set.tombstones[index]!
    }))
  };
}

// --- Delegation ----------------------------------------------------------------

export type DelegationStatus =
  /** None stored, or not one this browser can verify. */
  | 'missing'
  | 'expired'
  /** In its last week: renew. */
  | 'expiring'
  /** It names other devices than the owner's certified ones now. */
  | 'stale-devices'
  | 'valid';

export interface ShareDelegationState {
  readonly status: DelegationStatus;
  readonly delegation: ShareDelegation | null;
  readonly record: E2eeShareDelegationRecord | null;
  /** Whether it names this device, which may then sign statements. */
  readonly namesThisDevice: boolean;
}

/** Whether a delegation needs the identity key again. */
export const delegationNeedsRenewal = (state: ShareDelegationState) =>
  state.status !== 'valid';

/** Checks a delegation record against this account's identity and devices. */
export async function readDelegation(
  ctx: Pick<ShareLinksContext, 'groups' | 'now'>,
  record: E2eeShareDelegationRecord | null
): Promise<ShareDelegationState> {
  const list = ctx.groups.account.list;
  const thisDevice = ctx.groups.device
    ? list.devices.find((d) => d.deviceId === ctx.groups.device!.deviceId)
    : undefined;
  if (!record) {
    return {
      status: 'missing',
      delegation: null,
      record,
      namesThisDevice: false
    };
  }
  let delegation: ShareDelegation;
  try {
    delegation = decodeShareDelegation(fromBase64Url(record.statement));
    // Verified as a visitor would, at its issue time, so expiry is ours to
    // report rather than a refusal.
    await verifyShareDelegation(
      {
        statement: fromBase64Url(record.statement),
        signature: fromBase64Url(record.signature)
      },
      list.identityKey,
      { now: delegation.issuedAt, ownerIdentityKeyHash: list.identityKeyHash }
    );
  } catch {
    return {
      status: 'missing',
      delegation: null,
      record,
      namesThisDevice: false
    };
  }
  const named = (key: Uint8Array) =>
    delegation.deviceKeys.some((k) => sameBytes(k, key));
  const namesThisDevice = !!thisDevice && named(thisDevice.signingKey);
  const now = nowOf(ctx);
  const sameDevices =
    delegation.deviceKeys.length === list.devices.length &&
    list.devices.every((d) => named(d.signingKey));
  const status: DelegationStatus =
    now >= delegation.expiresAt
      ? 'expired'
      : !sameDevices
        ? 'stale-devices'
        : delegation.expiresAt - now <= SHARE_DELEGATION_RENEWAL_MS
          ? 'expiring'
          : 'valid';
  return { status, delegation, record, namesThisDevice };
}

/** This account's delegation, as stored and checked. */
export async function shareDelegationState(
  ctx: ShareDelegationContext
): Promise<ShareDelegationState> {
  return readDelegation(ctx, (await ctx.api.delegation()).delegation);
}

/**
 * Signs a new delegation with the identity key (`sign`: a passkey touch or
 * the recovery key opens it for this one signature) naming every certified
 * device of this account, for 30 days, and stores it.
 */
export async function renewShareDelegation(
  ctx: ShareDelegationContext,
  sign: (value: ShareDelegation) => Promise<SignedStatement>
): Promise<ShareDelegationState> {
  const list = ctx.groups.account.list;
  const generation = ctx.groups.account.generation ?? 1;
  const { delegation: stored } = await ctx.api.delegation();
  const now = nowOf(ctx);
  const value: ShareDelegation = {
    identityKeyHash: list.identityKeyHash,
    sequence:
      stored && stored.generation === generation ? stored.sequence + 1 : 0,
    issuedAt: now,
    expiresAt: now + SHARE_DELEGATION_LIFETIME_MS,
    deviceKeys: list.devices.map((device) => device.signingKey)
  };
  const signed = await sign(value);
  const { delegation } = await ctx.api.putDelegation({
    statement: b64(signed.statement),
    signature: b64(signed.signature)
  });
  return readDelegation(ctx, delegation);
}

/** A `sign` for `renewShareDelegation` from an open identity key. */
export const signWithIdentityKey =
  (identityPrivateKey: CryptoKey) => (value: ShareDelegation) =>
    signShareDelegation(identityPrivateKey, value);

// --- Share keys -----------------------------------------------------------------

/**
 * A link's share key: its newest wrap at or below `keyEpoch`, opened under
 * that epoch's project key and checked against the grant's hash. Without a
 * wrap at `keyEpoch` itself, the key is wrapped again under its project key
 * and stored; a wrap someone stored first must open to the same key.
 */
async function shareKeyFor(
  ctx: ShareLinksContext,
  projectId: string,
  shareId: string,
  expectedHash: Uint8Array,
  record: E2eeShareLinkRecord,
  keyEpoch: number
): Promise<Uint8Array> {
  const wrap = [...record.keys]
    .filter((key) => key.keyEpoch <= keyEpoch)
    .sort((a, b) => b.keyEpoch - a.keyEpoch)[0];
  if (!wrap) {
    throw new ShareLinksError(
      'key-unavailable',
      'This link’s key is not stored for the project’s keys this device holds.'
    );
  }
  const open = async (keyEpochOf: number, wrapped: string) =>
    openShareKey(
      await projectKeyForEpoch(ctx.groups, projectId, keyEpochOf),
      fromBase64Url(wrapped),
      { projectId, keyEpoch: keyEpochOf, shareId },
      expectedHash
    );
  const key = await open(wrap.keyEpoch, wrap.wrapped);
  if (wrap.keyEpoch === keyEpoch) return key;
  const wrapped = await wrapKey(
    await projectKeyForEpoch(ctx.groups, projectId, keyEpoch),
    key,
    { purpose: 'share-key', projectId, keyEpoch, shareId }
  );
  const stored = await ctx.api.postKey(projectId, shareId, {
    keyEpoch,
    wrapped: b64(wrapped)
  });
  if (stored.key.wrapped !== b64(wrapped)) {
    const theirs = await open(keyEpoch, stored.key.wrapped);
    if (!sameBytes(theirs, key)) {
      throw new ShareLinksError(
        'key-unavailable',
        'Another member stored a different key for this link.'
      );
    }
  }
  return key;
}

// --- Statements -------------------------------------------------------------------

/**
 * The author credentials a statement names: the signing-key hashes of the
 * owner's and every current editor's certified devices, from the device
 * lists this browser pinned (an editor without one cannot publish).
 */
export async function shareAuthorKeyHashes(
  ctx: ShareLinksContext,
  projectId: string,
  keyEpoch: number
): Promise<Uint8Array[]> {
  const roles = await epochRoles(ctx.groups, projectId, keyEpoch);
  const writers = new Set(
    roles.users
      .filter((entry) => entry.role === 'owner' || entry.role === 'editor')
      .map((entry) => entry.userId)
  );
  const hashes = new Map<string, Uint8Array>();
  for (const list of await projectDeviceLists(ctx.groups, projectId)) {
    if (!writers.has(list.userId)) continue;
    for (const device of list.devices) {
      hashes.set(b64(device.signingKeyHash), device.signingKeyHash);
    }
  }
  return [...hashes.values()];
}

const sameHashes = (a: readonly Uint8Array[], b: readonly Uint8Array[]) =>
  a.length === b.length && a.every((hash) => b.some((h) => sameBytes(h, hash)));

export interface AuthorityOutcome {
  /** Links that got a new statement. */
  readonly issued: readonly string[];
  /** Links left as they were, their statement still current. */
  readonly current: readonly string[];
  /** Links this device could not state: the delegation needs renewing. */
  readonly needsConfirmation: readonly string[];
  readonly failed: readonly { shareId: string; reason: string }[];
}

/**
 * Issues share-authority statements for the head's active links where one
 * is due (missing, two days or less left, another author set, a signer the
 * delegation no longer names), or for every link with `force`. Owner only;
 * a device the delegation does not name states nothing.
 */
export async function issueShareAuthorities(
  ctx: ShareLinksContext,
  projectId: string,
  options: {
    readonly force?: boolean;
    readonly only?: readonly string[];
    readonly head?: EncryptedShareHead;
  } = {}
): Promise<AuthorityOutcome> {
  const issued: string[] = [];
  const current: string[] = [];
  const needsConfirmation: string[] = [];
  const failed: { shareId: string; reason: string }[] = [];
  const head = options.head ?? (await ctx.store.shareHead(projectId));
  const links = (head.shareLinks?.links ?? []).filter(
    (link) => !options.only || options.only.includes(link.shareId)
  );
  const outcome = () => ({ issued, current, needsConfirmation, failed });
  if (!links.length) return outcome();
  const { device, record: own } = requireDevice(ctx);
  // The owner by the head's roles first: an editor's page stops here.
  await requireOwner(ctx, projectId, head.keyEpoch);
  const { keyEpoch } = await joinProjectGroup(ctx.groups, projectId);
  await requireOwner(ctx, projectId, keyEpoch);
  const listed = await ctx.api.list(projectId);
  const delegation = await readDelegation(ctx, listed.delegation);
  const usable =
    delegation.delegation !== null &&
    delegation.status !== 'expired' &&
    delegation.status !== 'missing' &&
    delegation.namesThisDevice;
  const authors = await shareAuthorKeyHashes(ctx, projectId, keyEpoch);
  const list = ctx.groups.account.list;
  const now = nowOf(ctx);
  for (const link of links) {
    const record = listed.links.find((l) => l.shareId === link.shareId);
    if (!record) continue;
    try {
      const stored = record.authority
        ? decodeShareAuthority(fromBase64Url(record.authority.statement))
        : null;
      const signerDelegated =
        !!stored &&
        !!delegation.delegation?.deviceKeys.some((key) =>
          list.devices.some(
            (d) =>
              sameBytes(d.signingKey, key) &&
              sameBytes(d.signingKeyHash, stored.signerKeyHash)
          )
        );
      const due =
        options.force === true ||
        !stored ||
        stored.expiresAt - now <= SHARE_AUTHORITY_RENEWAL_MS ||
        !signerDelegated ||
        !sameHashes(stored.authorKeyHashes, authors);
      if (!due) {
        current.push(link.shareId);
        continue;
      }
      if (!usable || !authors.length) {
        needsConfirmation.push(link.shareId);
        continue;
      }
      const signed = await signShareAuthority(device.signing.privateKey, {
        projectId,
        shareId: link.shareId,
        shareKeyHash: link.shareKeyHash,
        mode: link.mode,
        ownerIdentityKeyHash: list.identityKeyHash,
        sequence: (record.authority?.sequence ?? -1) + 1,
        issuedAt: now,
        expiresAt: Math.min(
          now + SHARE_AUTHORITY_LIFETIME_MS,
          // Never past the delegation that makes it trustworthy.
          Math.max(now + 1, delegation.delegation.expiresAt)
        ),
        signerKeyHash: own.signingKeyHash,
        authorKeyHashes: authors
      });
      await ctx.api.putAuthority(projectId, link.shareId, {
        statement: b64(signed.statement),
        signature: b64(signed.signature)
      });
      issued.push(link.shareId);
    } catch (error) {
      failed.push({ shareId: link.shareId, reason: describe(error) });
    }
  }
  return outcome();
}

// --- Snapshots ---------------------------------------------------------------------

export interface PublishOutcome {
  readonly published: readonly string[];
  readonly failed: readonly { shareId: string; reason: string }[];
}

/**
 * Republishes the snapshot of every active link of the head's set (an
 * editor or the owner, after a save): one share-snapshot envelope each,
 * under the current key epoch. Links whose stored snapshot is already this
 * version at this epoch, or a newer one, are left alone.
 */
export async function publishShareSnapshots(
  ctx: ShareLinksContext,
  projectId: string,
  head?: EncryptedShareHead,
  options: { readonly only?: readonly string[] } = {}
): Promise<PublishOutcome> {
  const published: string[] = [];
  const failed: { shareId: string; reason: string }[] = [];
  const outcome = () => ({ published, failed });
  const current = head ?? (await ctx.store.shareHead(projectId));
  const links = (current.shareLinks?.links ?? []).filter(
    (link) => !options.only || options.only.includes(link.shareId)
  );
  if (!links.length || !ctx.groups.device) return outcome();
  const { device } = requireDevice(ctx);
  const { keyEpoch } = await joinProjectGroup(ctx.groups, projectId);
  const roles = await epochRoles(ctx.groups, projectId, keyEpoch);
  const role = roles.users.find(
    (entry) => entry.userId === ctx.groups.account.userId
  )?.role;
  if (role !== 'owner' && role !== 'editor') return outcome();
  const listed = await ctx.api.list(projectId);
  const projectKey = await projectKeyForEpoch(ctx.groups, projectId, keyEpoch);
  const authenticator = await epochAuthenticatorForEpoch(
    ctx.groups,
    projectId,
    keyEpoch
  );
  const document = sharedProjectSnapshotDocument(current.document);
  const blobs: ContentBlobReference[] = ctx.blobReferences
    ? documentBlobReferences(ctx.blobReferences, projectId, document)
    : [];
  for (const link of links) {
    const record = listed.links.find((l) => l.shareId === link.shareId);
    if (!record) continue;
    const stored = record.snapshot;
    if (
      stored &&
      (stored.documentVersion > current.version ||
        (stored.documentVersion === current.version &&
          stored.keyEpoch === keyEpoch))
    ) {
      continue;
    }
    try {
      const shareKey = await shareKeyFor(
        ctx,
        projectId,
        link.shareId,
        link.shareKeyHash,
        record,
        keyEpoch
      );
      const sealed = await sealSnapshot({
        projectId,
        shareId: link.shareId,
        keyEpoch,
        projectKey,
        authenticator,
        shareKey,
        head: current,
        document,
        blobs,
        sign: (envelope) =>
          signProjectEnvelope(device.signing.privateKey, envelope, nowOf(ctx))
      });
      await ctx.api.putSnapshot(
        projectId,
        link.shareId,
        {
          signature: b64(sealed.signature),
          signerDeviceId: device.deviceId,
          wrappedForLinkVisitors: b64(sealed.forLinkVisitors),
          wrappedForMembers: b64(sealed.forMembers)
        },
        sealed.envelope
      );
      published.push(link.shareId);
    } catch (error) {
      failed.push({ shareId: link.shareId, reason: describe(error) });
    }
  }
  return outcome();
}

/** One link's share snapshot: a fresh version key, wrapped twice, signed. */
export async function sealSnapshot(input: {
  readonly projectId: string;
  readonly shareId: string;
  readonly keyEpoch: number;
  readonly projectKey: Uint8Array;
  readonly authenticator: Uint8Array;
  readonly shareKey: Uint8Array;
  readonly head: { readonly version: number; readonly hash: string };
  readonly document: ProjectDocument;
  readonly blobs: readonly ContentBlobReference[];
  readonly sign: (envelope: Uint8Array) => Promise<Uint8Array>;
}): Promise<{
  envelope: Uint8Array;
  signature: Uint8Array;
  forLinkVisitors: Uint8Array;
  forMembers: Uint8Array;
}> {
  const init: ProjectEnvelopeHeaderInit = {
    kind: 'share-snapshot',
    projectId: input.projectId,
    documentVersion: input.head.version,
    // The version the snapshot was made from.
    previousVersionHash: fromHex(input.head.hash),
    epochBindingHash: await epochBinding(
      input.projectId,
      input.keyEpoch,
      input.authenticator
    ),
    schemaVersion: SCHEMA_VERSION,
    keyEpoch: input.keyEpoch,
    blobIds: input.blobs.map((reference) => reference.blobId)
  };
  const plaintext = encodeEncryptedDocumentBody(
    {
      document: input.document as unknown as Record<string, unknown>,
      blobs: [...input.blobs],
      revisionVersionHashes: new Map()
    },
    init
  );
  const key = EnvelopeKey.generate();
  const versionKey = key.bytes;
  try {
    const envelope = await encryptProjectEnvelope(key, init, plaintext);
    const wraps = await wrapShareSnapshotKey(
      input.projectKey,
      input.shareKey,
      versionKey,
      {
        projectId: input.projectId,
        keyEpoch: input.keyEpoch,
        shareId: input.shareId,
        versionId: shareSnapshotVersionId(input.head.version)
      }
    );
    return {
      envelope,
      signature: await input.sign(envelope),
      forLinkVisitors: wraps.forLinkVisitors,
      forMembers: wraps.forMembers
    };
  } finally {
    versionKey.fill(0);
  }
}

// --- Create, revoke, list -------------------------------------------------------------

export interface CreatedShareLink {
  readonly shareId: string;
  readonly mode: ShareLinkMode;
  readonly url: string;
  readonly fragment: ShareFragmentParts;
  /** What the follow-up steps could not do yet (statement, snapshot). */
  readonly pending: readonly string[];
}

/**
 * The owner creates a link: a grant in a new version, the server's record
 * with the share key wrapped under the version's key epoch, a statement
 * (when the delegation names this device) and the first snapshot.
 */
export async function createShareLink(
  ctx: ShareLinksContext,
  projectId: string,
  mode: ShareLinkMode
): Promise<CreatedShareLink> {
  const { device, record: own } = requireDevice(ctx);
  const before = await ctx.store.shareHead(projectId);
  await requireOwner(ctx, projectId, before.keyEpoch);
  const shareKey = randomBytes(ctx, 32);
  const shareId = `shr_${b64(randomBytes(ctx, 16))}`;
  const keyHash = await shareKeyHash(shareKey);
  const token = await shareLinkToken(shareKey);
  const head = await ctx.store.writeShareLinks(
    projectId,
    async (current, keyEpoch) => {
      const grant = await signShareLinkGrant(device.signing.privateKey, {
        projectId,
        shareId,
        shareKeyHash: keyHash,
        mode,
        keyEpoch,
        issuedAt: nowOf(ctx),
        signerKeyHash: own.signingKeyHash
      });
      const entries = entriesOf(current);
      return sortedSet(
        [...entries.grants, { id: shareId, signed: grant }],
        entries.tombstones
      );
    }
  );
  const list = ctx.groups.account.list;
  const register = async (keyEpoch: number) =>
    ctx.api.create(projectId, {
      shareId,
      tokenHash: await shareLinkTokenHash(token),
      mode,
      shareKeyHash: b64(keyHash),
      ownerIdentityHash: b64(list.identityKeyHash),
      key: {
        keyEpoch,
        wrapped: b64(
          await wrapKey(
            await projectKeyForEpoch(ctx.groups, projectId, keyEpoch),
            shareKey,
            { purpose: 'share-key', projectId, keyEpoch, shareId }
          )
        )
      }
    });
  try {
    await register(head.keyEpoch);
  } catch (error) {
    // The group moved on after the version: wrap under the new epoch.
    if ((error as { code?: string }).code !== 'E2EE_EPOCH_STALE') throw error;
    await register((await joinProjectGroup(ctx.groups, projectId)).keyEpoch);
  }
  const pending: string[] = [];
  const stated = await issueShareAuthorities(ctx, projectId, {
    only: [shareId],
    head
  }).catch((error: unknown): AuthorityOutcome => ({
    issued: [],
    current: [],
    needsConfirmation: [],
    failed: [{ shareId, reason: describe(error) }]
  }));
  if (!stated.issued.includes(shareId)) pending.push('authority');
  const shown = await publishShareSnapshots(ctx, projectId, head, {
    only: [shareId]
  }).catch((error: unknown): PublishOutcome => ({
    published: [],
    failed: [{ shareId, reason: describe(error) }]
  }));
  if (!shown.published.includes(shareId)) pending.push('snapshot');
  const fragment: ShareFragmentParts = {
    token,
    shareKey,
    ownerIdentityHash: list.identityKeyHash
  };
  return {
    shareId,
    mode,
    url: shareLinkUrl(
      ctx.origin ?? globalThis.location?.origin ?? '',
      fragment
    ),
    fragment,
    pending
  };
}

export interface ForgetOutcome {
  /** Revoked links the server stopped serving now. */
  readonly forgotten: readonly string[];
  /** Revoked links it still serves: their revocation is pending. */
  readonly failed: readonly { shareId: string; reason: string }[];
}

/**
 * The server forgets every link it still lists that the head tombstones (a
 * revoke whose request failed after its tombstone was written): the request
 * again, until the listing no longer names the link. Owner only; anyone
 * else, and a head without tombstones, gets an empty result without a
 * request. `listed` is a listing just read, to skip reading it again.
 */
export async function forgetRevokedShareLinks(
  ctx: ShareLinksContext,
  projectId: string,
  options: {
    readonly head?: EncryptedShareHead;
    readonly listed?: E2eeShareLinksResponse;
  } = {}
): Promise<ForgetOutcome> {
  const forgotten: string[] = [];
  const failed: { shareId: string; reason: string }[] = [];
  const outcome = () => ({ forgotten, failed });
  const head = options.head ?? (await ctx.store.shareHead(projectId));
  const revoked = head.shareLinks?.tombstonedIds;
  if (!revoked?.size || !ctx.groups.device) return outcome();
  const owner = await projectOwnerOf(ctx.groups, projectId, head.keyEpoch);
  if (owner !== ctx.groups.account.userId) return outcome();
  const listed = options.listed ?? (await ctx.api.list(projectId));
  for (const record of listed.links) {
    if (!revoked.has(record.shareId)) continue;
    try {
      await ctx.api
        .forget(projectId, record.shareId)
        .catch((error: unknown) => {
          if ((error as { status?: number }).status !== 404) throw error;
        });
      forgotten.push(record.shareId);
    } catch (error) {
      failed.push({ shareId: record.shareId, reason: describe(error) });
    }
  }
  return outcome();
}

/** A revoke of links the head already tombstones: nothing to write. */
class AlreadyRevoked extends Error {}

/**
 * The owner revokes links: signed permanent tombstones replace their grants
 * in one new version, then the server forgets them and every other revoked
 * link it still lists (`forgetRevokedShareLinks`). Links the head already
 * tombstones write nothing: the server is only asked again. Rejects with
 * `revocation-pending` while the server still serves one of `shareIds`; the
 * tombstone stands and the next attempt asks again.
 */
export async function revokeShareLinks(
  ctx: ShareLinksContext,
  projectId: string,
  shareIds: readonly string[]
): Promise<EncryptedShareHead> {
  const { device, record: own } = requireDevice(ctx);
  const before = await ctx.store.shareHead(projectId);
  await requireOwner(ctx, projectId, before.keyEpoch);
  const tombstoned = (set: VerifiedShareLinkSet | null) =>
    shareIds.length > 0 &&
    shareIds.every((id) => set?.tombstonedIds.has(id) === true);
  let head = before;
  if (!tombstoned(before.shareLinks)) {
    try {
      head = await ctx.store.writeShareLinks(
        projectId,
        async (current, keyEpoch) => {
          const entries = entriesOf(current);
          const revoking = shareIds.filter((id) =>
            entries.grants.some((g) => g.id === id)
          );
          if (!revoking.length) {
            // Revoked meanwhile (another tab): only the server is left.
            if (tombstoned(current)) throw new AlreadyRevoked();
            throw new ShareLinksError(
              'link-not-found',
              'This share link is not active any more.'
            );
          }
          const tombstones = [...entries.tombstones];
          for (const id of revoking) {
            tombstones.push({
              id,
              signed: await signShareLinkTombstone(device.signing.privateKey, {
                projectId,
                shareId: id,
                keyEpoch,
                issuedAt: nowOf(ctx),
                signerKeyHash: own.signingKeyHash
              })
            });
          }
          return sortedSet(
            entries.grants.filter((g) => !revoking.includes(g.id)),
            tombstones
          );
        }
      );
    } catch (error) {
      if (!(error instanceof AlreadyRevoked)) throw error;
      head = await ctx.store.shareHead(projectId);
    }
  }
  const { failed } = await forgetRevokedShareLinks(ctx, projectId, { head });
  const pending = failed.find((entry) => shareIds.includes(entry.shareId));
  if (pending) {
    throw new ShareLinksError(
      'revocation-pending',
      `The link is revoked in the project, but the server did not confirm it stopped serving it (${pending.reason}). Revoke it again to retry.`
    );
  }
  return head;
}

export const revokeShareLink = (
  ctx: ShareLinksContext,
  projectId: string,
  shareId: string
) => revokeShareLinks(ctx, projectId, [shareId]);

export type ShareLinkStatus =
  /** Visitors see the latest snapshot until `expiresAt`. */
  | 'active'
  /** No statement, an expired one, or a delegation that does not cover it. */
  | 'needs-confirming'
  /** Nothing published yet. */
  | 'not-published'
  /**
   * Tombstoned in the project, but the server still lists it, so visitors
   * may still open its snapshot: revoking it again asks the server again.
   */
  | 'revocation-pending';

export interface ShareLinkView {
  readonly shareId: string;
  readonly mode: ShareLinkMode;
  /** Null when this device cannot open the link's key. */
  readonly url: string | null;
  readonly status: ShareLinkStatus;
  /** When visitors stop accepting it without a renewal (Unix ms). */
  readonly expiresAt: number | null;
  readonly snapshotVersion: number | null;
}

export interface ShareLinksView {
  readonly isOwner: boolean;
  readonly links: readonly ShareLinkView[];
  readonly delegation: ShareDelegationState;
}

/** The head's active links with what visitors see of each. */
export async function listShareLinks(
  ctx: ShareLinksContext,
  projectId: string,
  /** A head just read (by `maintainShareLinks`), to skip reading it again. */
  known?: EncryptedShareHead
): Promise<ShareLinksView> {
  const head = known ?? (await ctx.store.shareHead(projectId));
  const owner = await projectOwnerOf(ctx.groups, projectId, head.keyEpoch);
  const isOwner = owner === ctx.groups.account.userId;
  const listed = await ctx.api.list(projectId);
  const delegation = await readDelegation(
    ctx,
    isOwner ? listed.delegation : null
  );
  const ownerList = owner
    ? await ownerDeviceList(ctx.groups, projectId, owner)
    : null;
  const ownerDelegation =
    isOwner || !listed.delegation
      ? delegation.delegation
      : decodeOr(listed.delegation.statement);
  const now = nowOf(ctx);
  const links: ShareLinkView[] = [];
  for (const link of head.shareLinks?.links ?? []) {
    const record = listed.links.find((l) => l.shareId === link.shareId);
    let url: string | null = null;
    if (record && ownerList) {
      try {
        const key = await shareKeyFor(
          ctx,
          projectId,
          link.shareId,
          link.shareKeyHash,
          record,
          Math.max(...record.keys.map((k) => k.keyEpoch))
        );
        url = shareLinkUrl(ctx.origin ?? globalThis.location?.origin ?? '', {
          token: await shareLinkToken(key),
          shareKey: key,
          ownerIdentityHash: ownerList.identityKeyHash
        });
      } catch {
        url = null;
      }
    }
    const authority = record?.authority ?? null;
    const expiresAt =
      authority && ownerDelegation
        ? Math.min(authority.expiresAt, ownerDelegation.expiresAt)
        : null;
    const status: ShareLinkStatus = !record?.snapshot
      ? 'not-published'
      : expiresAt === null || expiresAt <= now
        ? 'needs-confirming'
        : 'active';
    links.push({
      shareId: link.shareId,
      mode: link.mode,
      url,
      status,
      expiresAt,
      snapshotVersion: record?.snapshot?.documentVersion ?? null
    });
  }
  // Revoked links the server still serves stay listed until it forgets them.
  const revoked = head.shareLinks?.tombstonedIds;
  for (const record of listed.links) {
    if (!revoked?.has(record.shareId)) continue;
    links.push({
      shareId: record.shareId,
      mode: record.mode,
      url: null,
      status: 'revocation-pending',
      expiresAt: null,
      snapshotVersion: record.snapshot?.documentVersion ?? null
    });
  }
  return { isOwner, links, delegation };
}

function decodeOr(statement: string): ShareDelegation | null {
  try {
    return decodeShareDelegation(fromBase64Url(statement));
  } catch {
    return null;
  }
}

// --- Owner upkeep ---------------------------------------------------------------------

export interface ShareLinkUpkeep {
  readonly authorities: AuthorityOutcome;
  /**
   * Links tombstoned because they name an earlier owner identity: offer to
   * reissue them (their modes).
   */
  readonly retired: readonly { shareId: string; mode: ShareLinkMode }[];
  /** Revoked links the server was asked again to forget. */
  readonly revocations: ForgetOutcome;
  /** The head after the upkeep; null on a read-only device. */
  readonly head: EncryptedShareHead | null;
}

/**
 * The owner's routine: revoked links the server still serves are
 * forgotten again (`forgetRevokedShareLinks`), links that name an earlier
 * identity of the owner are tombstoned (visitors cannot follow an identity
 * change), and the other links' statements are renewed where due. Owner
 * only; anyone else gets an empty result.
 */
export async function maintainShareLinks(
  ctx: ShareLinksContext,
  projectId: string,
  options: { readonly force?: boolean } = {}
): Promise<ShareLinkUpkeep> {
  const empty: ShareLinkUpkeep = {
    authorities: { issued: [], current: [], needsConfirmation: [], failed: [] },
    retired: [],
    revocations: { forgotten: [], failed: [] },
    head: null
  };
  if (!ctx.groups.device) return empty;
  let head = await ctx.store.shareHead(projectId);
  const links = head.shareLinks?.links ?? [];
  if (!links.length && !head.shareLinks?.tombstonedIds.size) {
    return { ...empty, head };
  }
  const owner = await projectOwnerOf(ctx.groups, projectId, head.keyEpoch);
  if (owner !== ctx.groups.account.userId) return { ...empty, head };
  const listed = await ctx.api.list(projectId);
  const revocations = await forgetRevokedShareLinks(ctx, projectId, {
    head,
    listed
  });
  if (!links.length) return { ...empty, revocations, head };
  const identity = b64(ctx.groups.account.list.identityKeyHash);
  const stale = listed.links.some(
    (record) =>
      record.ownerIdentityHash !== identity &&
      links.some((link) => link.shareId === record.shareId)
  );
  let retired: { shareId: string; mode: ShareLinkMode }[] = [];
  if (stale) {
    retired = links.map((link) => ({ shareId: link.shareId, mode: link.mode }));
    head = await revokeShareLinks(
      ctx,
      projectId,
      retired.map((link) => link.shareId)
    );
  }
  const authorities = await issueShareAuthorities(ctx, projectId, {
    head,
    ...(options.force ? { force: true } : {})
  });
  return { authorities, retired, revocations, head };
}

/**
 * Reissues links with new keys and ids (after a removal, or an identity
 * change): each is revoked if still active, and a new link of the same mode
 * is created. Resolves to the new links.
 */
export async function reissueShareLinks(
  ctx: ShareLinksContext,
  projectId: string,
  links: readonly { shareId: string; mode: ShareLinkMode }[]
): Promise<CreatedShareLink[]> {
  const head = await ctx.store.shareHead(projectId);
  const active = links.filter((link) =>
    head.shareLinks?.links.some((l) => l.shareId === link.shareId)
  );
  if (active.length) {
    await revokeShareLinks(
      ctx,
      projectId,
      active.map((link) => link.shareId)
    );
  }
  const created: CreatedShareLink[] = [];
  for (const link of links) {
    created.push(await createShareLink(ctx, projectId, link.mode));
  }
  return created;
}

/**
 * A removal took other members' last leaf (slice 5-5's hook): the owner's
 * browser issues new statements for the project's links at once, so the
 * removed editor's devices drop out of what visitors accept. Revoked links
 * the server still serves are forgotten again first.
 */
export async function shareLinksAfterRemoval(
  ctx: ShareLinksContext,
  removal: MembersRemoved
): Promise<AuthorityOutcome | null> {
  if (!ctx.groups.device) return null;
  const head = await ctx.store.shareHead(removal.projectId);
  // No request unless the head tombstones links; never fails the hook.
  await forgetRevokedShareLinks(ctx, removal.projectId, { head }).catch(
    () => undefined
  );
  if (!head.shareLinks?.links.length) return null;
  const owner = await projectOwnerOf(
    ctx.groups,
    removal.projectId,
    head.keyEpoch
  );
  if (owner !== ctx.groups.account.userId) return null;
  return issueShareAuthorities(ctx, removal.projectId, { head, force: true });
}

/**
 * A co-member removed one of its devices and the project rotated (slice
 * 5-7's Remove of its own revoked leaves, `onMemberDevicesRemoved`): the
 * owner's browser states the project's links again, so a revoked editor
 * device drops out of the authors visitors accept without waiting for the
 * owner's next save. The member's new device list is what shows the
 * device revoked; a statement whose authors already match stays. Revoked
 * links the server still serves are forgotten again first.
 */
export async function shareLinksAfterDeviceRemoval(
  ctx: ShareLinksContext,
  removal: MemberDevicesRemoved
): Promise<AuthorityOutcome | null> {
  if (!ctx.groups.device) return null;
  const head = await ctx.store.shareHead(removal.projectId);
  // No request unless the head tombstones links; never fails the hook.
  await forgetRevokedShareLinks(ctx, removal.projectId, { head }).catch(
    () => undefined
  );
  if (!head.shareLinks?.links.length) return null;
  const owner = await projectOwnerOf(
    ctx.groups,
    removal.projectId,
    head.keyEpoch
  );
  if (owner !== ctx.groups.account.userId) return null;
  return issueShareAuthorities(ctx, removal.projectId, { head });
}
