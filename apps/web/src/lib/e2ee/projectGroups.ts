/**
 * Solo MLS groups for end-to-end encrypted projects (ADR-024 Phase 4,
 * slice 4-4; roadmap L11): one group per project, every leaf a device of
 * the owner. The Worker's sequencer (`/api/e2ee/projects/:id/…`) accepts the
 * first Commit for each epoch; everything else here runs in the browser.
 *
 * - **Create.** The creating device makes the group (its leaf certified
 *   from epoch 0) and uploads, in one write: its leaf certification, the
 *   epoch-zero GroupInfo, the epoch's project key and rejoin PSK wrapped
 *   under the account key (decision D1), and the epoch's signed key archive.
 *   Creation is safe to retry: local state the server never accepted is
 *   discarded (when the upload fails, or on the next attempt after a
 *   crash), and a project another device already made a group for is
 *   joined instead.
 * - **Join an own device** (decision D3: no KeyPackages until Phase 5).
 *   The device fetches the leaf registry and builds the verified directory,
 *   the newest GroupInfo and account-wrapped rejoin PSK, and every key
 *   archive (whose epoch records form the join archive), then rejoins by
 *   external Commit. Its leaf is certified from the group's current epoch.
 * - **Commit.** A Commit travels with everything its new epoch needs: the
 *   new GroupInfo, project key and rejoin PSK under the account key, and
 *   the new key archive. Those come from a confirmed copy of the pending
 *   session (`MlsProjectSessions.previewPending`), so the server can store
 *   them atomically with the Commit. A Commit that lost its epoch is
 *   discarded, the winner processed, and the change rebuilt on top.
 * - **Catch up.** Commits after the local epoch are processed in order.
 * - **Crash recovery.** A stored pending Commit that equals the server's
 *   winner for its epoch is confirmed; otherwise it is discarded and the
 *   winner processed. A pending Commit nobody ruled on is sent again.
 * - **Keys.** The current epoch's key comes from the session; older epochs
 *   (and every epoch on a read-only approved device, which holds no leaf:
 *   decision D4) from the account-key wraps, opened through the account-key
 *   history when an older account key made them, or from a later epoch's
 *   key archive. Key epochs are a monotonic project-key generation
 *   (decision D10): key epoch = the group's key-epoch base + MLS epoch.
 *
 * Everything the server returns is checked before use: leaf certifications
 * against the device list (`buildDeviceDirectory`), archives against their
 * signer's certified device key, the epoch binding and the expected epoch,
 * wraps by AES-KW under their exact context.
 */
import {
  EnvelopeKey,
  accountKeySequences,
  decodeKeyArchiveBody,
  decryptProjectEnvelope,
  encodeKeyArchiveBody,
  encryptProjectEnvelope,
  epochBinding,
  fromBase64Url,
  generateAssetDedupeSecret,
  signProjectEnvelope,
  toBase64Url,
  unwrapKey,
  verifyProjectEnvelopeSignature,
  wrapKey,
  type ArchivedProjectKey,
  type KeyArchiveBody,
  type ProjectEnvelopeHeaderInit,
  type VerifiedDeviceList,
  type WrapContext
} from '@openzcad/crypto';
import type { CommitRequest, RejoinPsk } from '@openzcad/mls';
import type {
  E2eeCreateProjectGroupRequest,
  E2eeKeyArchiveRecord,
  E2eeKeyArchivesResponse,
  E2eeMlsCommitRecord,
  E2eeMlsCommitRequest,
  E2eeMlsCommitResponse,
  E2eeMlsCommitsResponse,
  E2eeProjectGroupRecord,
  E2eeProjectGroupResponse,
  E2eeProjectKeyPurpose,
  E2eeProjectKeyWrap,
  E2eeProjectKeysResponse,
  E2eeProjectLeavesResponse
} from '@openzcad/shared';
import { desktopFetch } from '../desktopBridge';
import {
  openAccountKeyChain,
  type AccountView,
  type E2eeContext
} from './accountKeys';
import { E2eeApiError } from './e2eeApi';
import type { CertifyingDevice } from './mls/certify';
import type { DirectoryInput, LeafCertification } from './mls/directory';
import type { MlsProjectRef, MlsProjectSessions } from './mls/projectSessions';
import type { StoredLeaf } from './mls/sessionStore';
import { rememberProjectKey, unlockedProjectKey } from './unlockedProjectKeys';

// --- API -------------------------------------------------------------------

/** A refusal from the encrypted-project routes, with its whole body. */
export class ProjectGroupApiError extends E2eeApiError {
  constructor(
    status: number,
    message: string,
    code: string | undefined,
    readonly body: Record<string, unknown>
  ) {
    super(status, message, code);
    this.name = 'ProjectGroupApiError';
  }
}

export interface KeyQuery {
  readonly purpose?: E2eeProjectKeyPurpose;
  readonly keyEpoch?: number;
  /** Only key epochs above this one. */
  readonly after?: number;
}

export interface ProjectGroupsApi {
  group(projectId: string): Promise<E2eeProjectGroupResponse>;
  createGroup(
    projectId: string,
    request: E2eeCreateProjectGroupRequest
  ): Promise<E2eeProjectGroupResponse>;
  /** Every Commit that moves a member on from epoch `after`. */
  commits(projectId: string, after: number): Promise<E2eeMlsCommitsResponse>;
  submitCommit(
    projectId: string,
    request: E2eeMlsCommitRequest
  ): Promise<E2eeMlsCommitResponse>;
  leaves(projectId: string): Promise<E2eeProjectLeavesResponse>;
  keys(projectId: string, query?: KeyQuery): Promise<E2eeProjectKeysResponse>;
  archives(
    projectId: string,
    query?: Omit<KeyQuery, 'purpose'>
  ): Promise<E2eeKeyArchivesResponse>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function createProjectGroupsApi(
  fetcher: Fetch = desktopFetch
): ProjectGroupsApi {
  const call = async <T>(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<T> => {
    const response = await fetcher(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // A static host answers unknown routes with HTML.
    }
    if (!response.ok || payload === null || typeof payload !== 'object') {
      const details = (payload ?? {}) as Record<string, unknown>;
      throw new ProjectGroupApiError(
        response.ok ? 502 : response.status,
        typeof details.error === 'string'
          ? details.error
          : `${response.status} ${response.statusText}`,
        typeof details.code === 'string' ? details.code : undefined,
        details
      );
    }
    return payload as T;
  };
  const base = (projectId: string) =>
    `/api/e2ee/projects/${encodeURIComponent(projectId)}`;
  const query = (values: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(values))
      if (value !== undefined) params.set(name, String(value));
    const text = params.toString();
    return text ? `?${text}` : '';
  };
  return {
    group: (projectId) => call(`${base(projectId)}/mls/group-info`),
    createGroup: (projectId, request) =>
      call(`${base(projectId)}/mls/group-info`, 'POST', request),
    commits: (projectId, after) =>
      call(`${base(projectId)}/mls/commits${query({ after })}`),
    submitCommit: (projectId, request) =>
      call(`${base(projectId)}/mls/commits`, 'POST', request),
    leaves: (projectId) => call(`${base(projectId)}/mls/leaves`),
    keys: (projectId, q = {}) =>
      call(
        `${base(projectId)}/keys${query({
          purpose: q.purpose,
          keyEpoch: q.keyEpoch,
          after: q.after
        })}`
      ),
    archives: (projectId, q = {}) =>
      call(
        `${base(projectId)}/keys/archives${query({
          keyEpoch: q.keyEpoch,
          after: q.after
        })}`
      )
  };
}

// --- Context ---------------------------------------------------------------

export interface AccountKeyRef {
  /** A copy; this module zeroes it after use. */
  readonly key: Uint8Array;
  readonly generation: number;
  readonly keySequence: number;
}

/** The unlocked account, as this module needs it. */
export interface ProjectGroupAccount {
  readonly userId: string;
  /** This account's verified, pinned device list. */
  readonly list: VerifiedDeviceList;
  /** The current account key and which one it is. */
  currentAccountKey(): Promise<AccountKeyRef>;
  /** An older account key, through the account-key history (a copy). */
  openAccountKey(generation: number, keySequence: number): Promise<Uint8Array>;
}

export interface ProjectGroupContext {
  readonly api: ProjectGroupsApi;
  readonly sessions: MlsProjectSessions;
  readonly account: ProjectGroupAccount;
  /**
   * This device, whose signing key certifies its leaves and signs key
   * archives; null on a read-only approved device, which only reads keys.
   */
  readonly device: CertifyingDevice | null;
  /** Bound on rebuilding a Commit or rejoin that lost its epoch. */
  readonly attempts?: number;
}

/** The account view's keys: the current one, and older ones by history. */
export function projectGroupAccount(
  ctx: E2eeContext,
  account: AccountView
): ProjectGroupAccount {
  return {
    userId: account.userId,
    list: account.list,
    async currentAccountKey() {
      const keySequence = accountKeySequences(account.list).at(-1)!;
      return {
        key: await openAccountKeyChain(ctx, account, keySequence),
        generation: account.generation,
        keySequence
      };
    },
    openAccountKey: (generation, keySequence) =>
      openAccountKeyChain(ctx, account, keySequence, generation)
  };
}

export type ProjectGroupErrorCode =
  | 'device-not-certified'
  | 'no-group'
  | 'no-session'
  | 'server-mismatch'
  | 'archive-invalid'
  | 'key-missing'
  | 'epoch-lost';

export class ProjectGroupError extends Error {
  override readonly name = 'ProjectGroupError';
  constructor(
    readonly code: ProjectGroupErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface ProjectGroupState {
  readonly epoch: number;
  readonly keyEpoch: number;
}

const DEFAULT_ATTEMPTS = 4;
const SCHEMA_VERSION = 1;

const b64 = toBase64Url;
const bytes = (text: string) => fromBase64Url(text);
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function requireDevice(ctx: ProjectGroupContext): CertifyingDevice {
  const device = ctx.device;
  if (
    !device ||
    device.userId !== ctx.account.userId ||
    !ctx.account.list.devices.some((d) => d.deviceId === device.deviceId)
  ) {
    throw new ProjectGroupError(
      'device-not-certified',
      'Only a device certified in your device list can hold a leaf in an encrypted project. This device can read the project’s keys.'
    );
  }
  return device;
}

function refOf(
  ctx: ProjectGroupContext,
  device: CertifyingDevice,
  projectId: string
): MlsProjectRef {
  return { userId: ctx.account.userId, deviceId: device.deviceId, projectId };
}

const isApiError = (error: unknown, code: string) =>
  error instanceof E2eeApiError && error.code === code;

async function fetchGroup(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<E2eeProjectGroupRecord> {
  try {
    return (await ctx.api.group(projectId)).group;
  } catch (error) {
    if (isApiError(error, 'E2EE_GROUP_NOT_FOUND')) {
      throw new ProjectGroupError(
        'no-group',
        'This encrypted project has no MLS group yet.'
      );
    }
    throw error;
  }
}

/** The project's group, or null when it has none yet. */
async function serverGroup(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<E2eeProjectGroupRecord | null> {
  try {
    return await fetchGroup(ctx, projectId);
  } catch (error) {
    if (error instanceof ProjectGroupError && error.code === 'no-group')
      return null;
    throw error;
  }
}

/**
 * This device's leaf when it holds in-group MLS state the server's group
 * never accepted: the leaf is missing from the project's leaf registry
 * although the project has a group. That is a group this device made whose
 * creation never landed (a crash or a closed page before the upload
 * settled) while another device's creation did. Such state must never be
 * caught up or committed from, since the server cannot tell its Commits
 * from the real group's. A provisional rejoin is left to recovery, and
 * with no group on the server nothing is decided here.
 */
async function foreignLocalState(
  ctx: ProjectGroupContext,
  ref: MlsProjectRef,
  projectId: string
): Promise<StoredLeaf | null> {
  const leaf = await ctx.sessions.leaf(ref);
  if (!leaf) return null;
  const status = await ctx.sessions.status(ref);
  if (!status.inGroup || status.pendingRejoin) return null;
  const key = b64(leaf.signatureKey);
  const { leaves } = await ctx.api.leaves(projectId);
  const registered = leaves.some(
    (l) =>
      l.userId === ref.userId &&
      l.deviceId === ref.deviceId &&
      l.leafKey === key
  );
  if (registered) return null;
  return (await serverGroup(ctx, projectId)) ? leaf : null;
}

/**
 * The verified directory input: this account's device list and every leaf
 * the registry holds. A solo group's leaves are all the owner's; a leaf of
 * anyone else is refused visibly, not dropped.
 */
async function directoryFor(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<DirectoryInput> {
  const { leaves } = await ctx.api.leaves(projectId);
  const certifications: LeafCertification[] = leaves.map((leaf) => {
    if (leaf.userId !== ctx.account.userId) {
      throw new ProjectGroupError(
        'server-mismatch',
        'The leaf registry of a solo project names another account.'
      );
    }
    return {
      userId: leaf.userId,
      deviceId: leaf.deviceId,
      leafKey: bytes(leaf.leafKey),
      certification: bytes(leaf.certification)
    };
  });
  return { lists: [ctx.account.list], certifications };
}

// --- Keys and wraps --------------------------------------------------------

const projectKeyContext = (
  userId: string,
  projectId: string,
  keyEpoch: number
): WrapContext => ({ purpose: 'project-key', userId, projectId, keyEpoch });

const rejoinPskContext = (
  userId: string,
  projectId: string,
  epoch: number
): WrapContext => ({ purpose: 'rejoin-psk', userId, projectId, epoch });

/** The project key and rejoin PSK of `keyEpoch` under the current account key. */
async function wrapEpochKeys(
  ctx: ProjectGroupContext,
  projectId: string,
  keyEpoch: number,
  projectKey: Uint8Array,
  psk: RejoinPsk
): Promise<E2eeProjectKeyWrap[]> {
  const account = await ctx.account.currentAccountKey();
  try {
    const userId = ctx.account.userId;
    const common = {
      keyEpoch,
      accountKeyGeneration: account.generation,
      accountKeySequence: account.keySequence
    };
    return [
      {
        ...common,
        purpose: 'project-key',
        wrapped: b64(
          await wrapKey(
            account.key,
            projectKey,
            projectKeyContext(userId, projectId, keyEpoch)
          )
        )
      },
      {
        ...common,
        purpose: 'rejoin-psk',
        wrapped: b64(
          await wrapKey(
            account.key,
            psk.secret,
            rejoinPskContext(userId, projectId, psk.epoch)
          )
        )
      }
    ];
  } finally {
    account.key.fill(0);
  }
}

/** Opens one of this account's wraps with whichever account key made it. */
async function openWrap(
  ctx: ProjectGroupContext,
  wrap: E2eeProjectKeyWrap,
  context: WrapContext
): Promise<Uint8Array> {
  const current = await ctx.account.currentAccountKey();
  let key = current.key;
  try {
    if (
      wrap.accountKeyGeneration !== current.generation ||
      wrap.accountKeySequence !== current.keySequence
    ) {
      key = await ctx.account.openAccountKey(
        wrap.accountKeyGeneration,
        wrap.accountKeySequence
      );
    }
    return await unwrapKey(key, bytes(wrap.wrapped), context);
  } finally {
    current.key.fill(0);
    key.fill(0);
  }
}

/**
 * The project key of `keyEpoch`: the page cache, the account-key wrap
 * (decision D1; the only source on a read-only approved device, D4), the
 * local session when it is at that epoch, or a later epoch's key archive.
 */
export async function projectKeyForEpoch(
  ctx: ProjectGroupContext,
  projectId: string,
  keyEpoch: number
): Promise<Uint8Array> {
  const userId = ctx.account.userId;
  const cached = unlockedProjectKey(userId, projectId, keyEpoch);
  if (cached) return cached;
  const remember = (key: Uint8Array) => {
    rememberProjectKey(userId, projectId, keyEpoch, key);
    return key;
  };
  const { wraps } = await ctx.api.keys(projectId, {
    keyEpoch,
    purpose: 'project-key'
  });
  const wrap = wraps.find(
    (w) => w.keyEpoch === keyEpoch && w.purpose === 'project-key'
  );
  if (wrap) {
    return remember(
      await openWrap(ctx, wrap, projectKeyContext(userId, projectId, keyEpoch))
    );
  }
  if (ctx.device) {
    const ref = refOf(ctx, ctx.device, projectId);
    if (await ctx.sessions.leaf(ref)) {
      const status = await ctx.sessions.status(ref);
      const group = await fetchGroup(ctx, projectId);
      if (
        status.inGroup &&
        status.epoch !== null &&
        group.keyEpochBase + status.epoch === keyEpoch
      ) {
        return remember(await ctx.sessions.projectKey(ref));
      }
    }
  }
  // A later epoch's archive carries every earlier key.
  const later = (
    await ctx.api.keys(projectId, { after: keyEpoch, purpose: 'project-key' })
  ).wraps.find((w) => w.purpose === 'project-key' && w.keyEpoch > keyEpoch);
  if (later) {
    const laterKey = await projectKeyForEpoch(ctx, projectId, later.keyEpoch);
    const body = await openArchive(
      ctx,
      projectId,
      later.keyEpoch,
      laterKey,
      await fetchArchive(ctx, projectId, later.keyEpoch)
    );
    const found = body.previousKeys.find((k) => k.keyEpoch === keyEpoch);
    if (found) return remember(new Uint8Array(found.key));
  }
  throw new ProjectGroupError(
    'key-missing',
    `No key for epoch ${keyEpoch} of this project is available to this account.`
  );
}

// --- Key archives ----------------------------------------------------------

const archiveVersionId = (keyEpoch: number) => `key-archive:${keyEpoch}`;

/** Seal, wrap and sign one epoch's key archive (ADR-024 amendment). */
async function sealArchive(
  device: CertifyingDevice,
  projectId: string,
  keyEpoch: number,
  projectKey: Uint8Array,
  body: KeyArchiveBody
): Promise<E2eeKeyArchiveRecord> {
  const init: ProjectEnvelopeHeaderInit = {
    kind: 'key-archive',
    projectId,
    documentVersion: keyEpoch,
    previousVersionHash: null,
    epochBindingHash: await epochBinding(
      projectId,
      keyEpoch,
      body.epochAuthenticator
    ),
    schemaVersion: SCHEMA_VERSION,
    keyEpoch
  };
  const versionKey = EnvelopeKey.generate();
  const envelope = await encryptProjectEnvelope(
    versionKey,
    init,
    encodeKeyArchiveBody(body, { kind: 'key-archive', keyEpoch })
  );
  const wrappedVersionKey = await wrapKey(projectKey, versionKey.bytes, {
    purpose: 'version-key',
    projectId,
    keyEpoch,
    kind: 'key-archive',
    versionId: archiveVersionId(keyEpoch)
  });
  return {
    keyEpoch,
    envelope: b64(envelope),
    wrappedVersionKey: b64(wrappedVersionKey),
    signature: b64(
      await signProjectEnvelope(device.signing.privateKey, envelope)
    ),
    signerDeviceId: device.deviceId
  };
}

/** The signing key of a device this account's list certifies or certified. */
function signerKey(
  list: VerifiedDeviceList,
  deviceId: string
): Uint8Array | null {
  const live = list.devices.find((d) => d.deviceId === deviceId);
  if (live) return live.signingKey;
  const revoked = list.revoked.find(
    (r) => r.kind === 'device' && r.id === deviceId
  );
  return revoked?.device?.signingKey ?? null;
}

async function fetchArchive(
  ctx: ProjectGroupContext,
  projectId: string,
  keyEpoch: number
): Promise<E2eeKeyArchiveRecord> {
  const { archives } = await ctx.api.archives(projectId, { keyEpoch });
  const archive = archives.find((a) => a.keyEpoch === keyEpoch);
  if (!archive) {
    throw new ProjectGroupError(
      'archive-invalid',
      `The key archive of epoch ${keyEpoch} is missing.`
    );
  }
  return archive;
}

/**
 * Verify and open one key archive: signed over exactly this envelope by a
 * device of this account, encrypted under `projectKey` for this project
 * and key epoch, and bound to the epoch authenticator it carries.
 */
async function openArchive(
  ctx: ProjectGroupContext,
  projectId: string,
  keyEpoch: number,
  projectKey: Uint8Array,
  archive: E2eeKeyArchiveRecord
): Promise<KeyArchiveBody> {
  const refuse = (why: string): never => {
    throw new ProjectGroupError(
      'archive-invalid',
      `The key archive of epoch ${keyEpoch} ${why}.`
    );
  };
  if (archive.keyEpoch !== keyEpoch) refuse('names another epoch');
  const envelope = bytes(archive.envelope);
  const signing = signerKey(ctx.account.list, archive.signerDeviceId);
  if (!signing) refuse('is signed by a device this account never certified');
  const signed = await verifyProjectEnvelopeSignature(
    signing!,
    envelope,
    bytes(archive.signature)
  ).catch(() => null);
  if (!signed) refuse('does not carry its signer’s signature');
  try {
    const versionKey = await unwrapKey(
      projectKey,
      bytes(archive.wrappedVersionKey),
      {
        purpose: 'version-key',
        projectId,
        keyEpoch,
        kind: 'key-archive',
        versionId: archiveVersionId(keyEpoch)
      }
    );
    const { header, plaintext } = await decryptProjectEnvelope(
      versionKey,
      envelope,
      { expect: { projectId, kind: 'key-archive', keyEpoch } }
    );
    versionKey.fill(0);
    const body = decodeKeyArchiveBody(plaintext, header);
    const binding = await epochBinding(
      projectId,
      keyEpoch,
      body.epochAuthenticator
    );
    if (!sameBytes(binding, header.epochBindingHash)) {
      refuse('is not bound to its epoch');
    }
    return body;
  } catch (error) {
    if (error instanceof ProjectGroupError) throw error;
    return refuse('does not open under its project key');
  }
}

/**
 * The MLS `epoch_authenticator` of `keyEpoch`, from that epoch's key
 * archive, verified (signed by a device of this account, bound to its
 * epoch). Encrypted documents check each version's epoch binding with it.
 */
export async function epochAuthenticatorForEpoch(
  ctx: ProjectGroupContext,
  projectId: string,
  keyEpoch: number
): Promise<Uint8Array> {
  const projectKey = await projectKeyForEpoch(ctx, projectId, keyEpoch);
  const body = await openArchive(
    ctx,
    projectId,
    keyEpoch,
    projectKey,
    await fetchArchive(ctx, projectId, keyEpoch)
  );
  return new Uint8Array(body.epochAuthenticator);
}

interface History {
  /** Every project key up to and including the target key epoch. */
  readonly keys: Map<number, Uint8Array>;
  /** The target epoch's archive. */
  readonly newest: KeyArchiveBody;
  /** Epoch records for MLS epochs 1..target, in order. */
  readonly records: Uint8Array[];
}

/**
 * The group's history through its current epoch: the newest project key
 * from the account wrap, every earlier one from the newest archive, and
 * every epoch's record from its archive (the join archive's records).
 */
async function loadHistory(
  ctx: ProjectGroupContext,
  projectId: string,
  group: E2eeProjectGroupRecord
): Promise<History> {
  const target = group.keyEpochBase + group.epoch;
  const newestKey = await projectKeyForEpoch(ctx, projectId, target);
  const newest = await openArchive(
    ctx,
    projectId,
    target,
    newestKey,
    await fetchArchive(ctx, projectId, target)
  );
  const keys = new Map<number, Uint8Array>(
    newest.previousKeys.map((k) => [k.keyEpoch, new Uint8Array(k.key)])
  );
  keys.set(target, newestKey);
  const records: Uint8Array[] = [];
  let after = group.keyEpochBase;
  while (records.length < group.epoch) {
    const page = await ctx.api.archives(projectId, { after });
    for (const archive of page.archives) {
      const expected = group.keyEpochBase + records.length + 1;
      if (archive.keyEpoch > target) break;
      if (archive.keyEpoch !== expected) {
        throw new ProjectGroupError(
          'archive-invalid',
          `The key archive of epoch ${expected} is missing.`
        );
      }
      const key = keys.get(expected);
      if (!key) {
        throw new ProjectGroupError(
          'archive-invalid',
          `The newest key archive does not carry the key of epoch ${expected}.`
        );
      }
      const body =
        expected === target
          ? newest
          : await openArchive(ctx, projectId, expected, key, archive);
      records.push(body.epochRecord);
      after = archive.keyEpoch;
      if (records.length === group.epoch) break;
    }
    if (records.length < group.epoch && !page.more) {
      throw new ProjectGroupError(
        'archive-invalid',
        'The project’s key archives end before its current epoch.'
      );
    }
  }
  return { keys, newest, records };
}

const previousKeysOf = (
  keys: ReadonlyMap<number, Uint8Array>,
  below: number
): ArchivedProjectKey[] =>
  [...keys]
    .filter(([epoch]) => epoch < below)
    .sort(([a], [b]) => a - b)
    .map(([keyEpoch, key]) => ({ keyEpoch, key }));

// --- Create ----------------------------------------------------------------

/**
 * Create the project's MLS group with this device as the owner's only
 * leaf, and store its epoch 0 on the server in one write.
 *
 * Safe to retry. The local group exists before the server's, so:
 * - a project that already has a group (another device of the owner made
 *   it, or this one did) is joined instead (`joinProjectGroup`);
 * - local state an earlier attempt left without reaching the server (a
 *   crash between building and uploading) is discarded first;
 * - when building or uploading fails, the server is asked what happened.
 *   If it holds this very group, only the answer was lost and creation
 *   succeeded. If another device's creation won, the local group is
 *   discarded and this device joins the winner's by external Commit.
 *   Otherwise (offline, the database not ready, a refusal) the local group
 *   is discarded and the error thrown, so a retry starts clean.
 */
export async function createProjectGroup(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<ProjectGroupState> {
  const device = requireDevice(ctx);
  const ref = refOf(ctx, device, projectId);
  if (await serverGroup(ctx, projectId)) {
    return joinProjectGroup(ctx, projectId);
  }
  // The server has no group, so nothing stored here belongs to one.
  const stale = await ctx.sessions.leaf(ref);
  if (stale) await ctx.sessions.discardSession(ref, stale.signatureKey);
  const change = await ctx.sessions.createGroup(ref, device, {
    lists: [ctx.account.list],
    certifications: []
  });
  const leaf = (await ctx.sessions.leaf(ref))!;
  let groupInfo: string | null = null;
  try {
    if (!change.epochRecord) {
      throw new Error('A new MLS group produced no epoch record.');
    }
    const material = await ctx.sessions.epochMaterial(ref);
    groupInfo = b64(material.groupInfo);
    const keyEpoch = 0;
    const archive = await sealArchive(
      device,
      projectId,
      keyEpoch,
      material.projectKey,
      {
        previousKeys: [],
        dedupeSecret: generateAssetDedupeSecret(),
        epochRecord: change.epochRecord,
        epochAuthenticator: material.epochAuthenticator
      }
    );
    const { group } = await ctx.api.createGroup(projectId, {
      groupId: `grp_${toHexId()}`,
      deviceId: device.deviceId,
      groupInfo,
      leaf: {
        leafKey: b64(leaf.signatureKey),
        certification: b64(leaf.certification)
      },
      wraps: await wrapEpochKeys(
        ctx,
        projectId,
        keyEpoch,
        material.projectKey,
        material.rejoinPsk
      ),
      archive
    });
    rememberProjectKey(
      ctx.account.userId,
      projectId,
      keyEpoch,
      material.projectKey
    );
    return { epoch: group.epoch, keyEpoch: group.keyEpochBase + group.epoch };
  } catch (error) {
    let group: E2eeProjectGroupRecord | null = null;
    try {
      group = await serverGroup(ctx, projectId);
    } catch {
      // Offline or refused: what the server holds stays unknown.
    }
    if (group && groupInfo !== null && group.initialGroupInfo === groupInfo) {
      // This device's creation landed; only its answer was lost.
      rememberProjectKey(
        ctx.account.userId,
        projectId,
        group.keyEpochBase,
        await ctx.sessions.projectKey(ref)
      );
      return { epoch: 0, keyEpoch: group.keyEpochBase };
    }
    // A discard that fails too leaves the state to the next attempt, which
    // discards it before building again.
    await ctx.sessions
      .discardSession(ref, leaf.signatureKey)
      .catch(() => undefined);
    if (group) return joinProjectGroup(ctx, projectId);
    throw error;
  }
}

function toHexId(): string {
  const random = new Uint8Array(12);
  crypto.getRandomValues(random);
  return [...random].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- Submitting ------------------------------------------------------------

type Submitted =
  | { readonly accepted: true; readonly group: E2eeProjectGroupRecord }
  | { readonly accepted: false; readonly winner: E2eeMlsCommitRecord | null };

/**
 * Send the stored pending Commit (or provisional rejoin) with everything
 * its new epoch needs, for the epoch it was built on: if the server moved
 * on meanwhile, it answers with the winner. `history` supplies the keys and
 * dedupe secret for a rejoin; a member's Commit reads them from the current
 * epoch's archive.
 */
async function submitPending(
  ctx: ProjectGroupContext,
  device: CertifyingDevice,
  projectId: string,
  keyEpochBase: number,
  directory: DirectoryInput,
  pending: {
    readonly commit: Uint8Array;
    /** A rejoin's epoch record, from its `RejoinResult`. */
    readonly rejoinRecord?: Uint8Array | null;
    readonly history?: History;
  }
): Promise<Submitted> {
  const ref = refOf(ctx, device, projectId);
  const next = await ctx.sessions.previewPending(ref, directory);
  const epochRecord = next.external ? pending.rejoinRecord : next.epochRecord;
  if (!epochRecord) throw new Error('The new epoch has no archive record.');
  const keyEpoch = keyEpochBase + next.epoch;
  let keys: ReadonlyMap<number, Uint8Array>;
  let dedupeSecret: Uint8Array;
  if (pending.history) {
    keys = pending.history.keys;
    dedupeSecret = pending.history.newest.dedupeSecret;
  } else {
    const current = keyEpoch - 1;
    const currentKey = await ctx.sessions.projectKey(ref);
    const body = await openArchive(
      ctx,
      projectId,
      current,
      currentKey,
      await fetchArchive(ctx, projectId, current)
    );
    keys = new Map([
      ...body.previousKeys.map((k): [number, Uint8Array] => [
        k.keyEpoch,
        k.key
      ]),
      [current, currentKey]
    ]);
    dedupeSecret = body.dedupeSecret;
  }
  const archive = await sealArchive(
    device,
    projectId,
    keyEpoch,
    next.projectKey,
    {
      previousKeys: previousKeysOf(keys, keyEpoch),
      dedupeSecret,
      epochRecord,
      epochAuthenticator: next.epochAuthenticator
    }
  );
  const leaf = next.external ? await ctx.sessions.leaf(ref) : null;
  try {
    const response = await ctx.api.submitCommit(projectId, {
      epoch: next.epoch - 1,
      kind: next.external ? 'external' : 'commit',
      deviceId: device.deviceId,
      message: b64(pending.commit),
      groupInfo: b64(next.groupInfo),
      ...(leaf
        ? {
            leaf: {
              leafKey: b64(leaf.signatureKey),
              certification: b64(leaf.certification)
            }
          }
        : {}),
      wraps: await wrapEpochKeys(
        ctx,
        projectId,
        keyEpoch,
        next.projectKey,
        next.rejoinPsk
      ),
      archive
    });
    if (!sameBytes(bytes(response.commit.message), pending.commit)) {
      throw new ProjectGroupError(
        'server-mismatch',
        'The server answered with a Commit this device did not send.'
      );
    }
    rememberProjectKey(
      ctx.account.userId,
      projectId,
      keyEpoch,
      next.projectKey
    );
    return { accepted: true, group: response.group };
  } catch (error) {
    if (isApiError(error, 'EPOCH_TAKEN')) {
      const winner = (error as ProjectGroupApiError).body.winner;
      return {
        accepted: false,
        winner: (winner as E2eeMlsCommitRecord | undefined) ?? null
      };
    }
    throw error;
  }
}

// --- Join ------------------------------------------------------------------

/**
 * Join this owner's device to the project's group by external Commit with
 * the newest account-wrapped rejoin PSK (decision D3). Works while every
 * other device is offline. A rejoin that loses its epoch is discarded and
 * rebuilt on the newer GroupInfo.
 */
export async function joinProjectGroup(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<ProjectGroupState> {
  const device = requireDevice(ctx);
  const ref = refOf(ctx, device, projectId);
  const foreign = await foreignLocalState(ctx, ref, projectId);
  if (foreign) {
    // A group of this device's own that the server never accepted: drop it
    // and join the server's.
    await ctx.sessions.discardSession(ref, foreign.signatureKey);
  } else if (await ctx.sessions.leaf(ref)) {
    // Resolve a rejoin a crash left pending before deciding anything.
    await recoverProjectGroup(ctx, projectId);
    const status = await ctx.sessions.status(ref);
    if (status.inGroup) return catchUpProjectGroup(ctx, projectId);
  }
  const attempts = ctx.attempts ?? DEFAULT_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const group = await fetchGroup(ctx, projectId);
    if (group.groupInfoEpoch !== group.epoch) {
      throw new ProjectGroupError(
        'server-mismatch',
        `The server's GroupInfo is from epoch ${group.groupInfoEpoch}, but the group is at ${group.epoch}.`
      );
    }
    const history = await loadHistory(ctx, projectId, group);
    const psk = await newestRejoinPsk(ctx, projectId, group);
    const directory = await directoryFor(ctx, projectId);
    const result = await ctx.sessions.rejoin(
      ref,
      device,
      directory,
      // The leaf counts from the group's current epoch.
      group.epoch,
      bytes(group.groupInfo),
      {
        archive: {
          initialGroupInfo: bytes(group.initialGroupInfo),
          epochRecords: history.records
        },
        psk
      }
    );
    if (result.change.epoch !== group.epoch + 1) {
      await ctx.sessions.discardRejoin(ref);
      throw new ProjectGroupError(
        'server-mismatch',
        `The server's GroupInfo is not from epoch ${group.epoch}.`
      );
    }
    const submitted = await submitPending(
      ctx,
      device,
      projectId,
      group.keyEpochBase,
      directory,
      {
        commit: result.commit,
        rejoinRecord: result.change.epochRecord,
        history
      }
    );
    if (submitted.accepted) {
      await ctx.sessions.confirmRejoin(ref, directory);
      return stateOf(submitted.group);
    }
    // Another Commit took the epoch: start over from the newer GroupInfo.
    await ctx.sessions.discardRejoin(ref);
  }
  throw new ProjectGroupError(
    'epoch-lost',
    'The project kept changing while this device joined. Try again.'
  );
}

const stateOf = (group: E2eeProjectGroupRecord): ProjectGroupState => ({
  epoch: group.epoch,
  keyEpoch: group.keyEpochBase + group.epoch
});

/** The newest rejoin PSK of the current group generation, unwrapped. */
async function newestRejoinPsk(
  ctx: ProjectGroupContext,
  projectId: string,
  group: E2eeProjectGroupRecord
): Promise<RejoinPsk> {
  let newest: E2eeProjectKeyWrap | undefined;
  let after = group.keyEpochBase - 1;
  for (;;) {
    const page = await ctx.api.keys(projectId, {
      purpose: 'rejoin-psk',
      ...(after >= 0 ? { after } : {})
    });
    for (const wrap of page.wraps) {
      if (wrap.purpose !== 'rejoin-psk' || wrap.keyEpoch < group.keyEpochBase)
        continue;
      if (wrap.keyEpoch > group.keyEpochBase + group.epoch) continue;
      if (!newest || wrap.keyEpoch > newest.keyEpoch) newest = wrap;
      after = Math.max(after, wrap.keyEpoch);
    }
    if (!page.more) break;
  }
  if (!newest) {
    throw new ProjectGroupError(
      'key-missing',
      'No rejoin key for this project is stored for this account.'
    );
  }
  const epoch = newest.keyEpoch - group.keyEpochBase;
  return {
    epoch,
    secret: await openWrap(
      ctx,
      newest,
      rejoinPskContext(ctx.account.userId, projectId, epoch)
    )
  };
}

// --- Commit, catch up, recover --------------------------------------------

/**
 * Commit a change (by default an empty Commit, which refreshes this leaf's
 * path secrets) after catching up. If another Commit takes the epoch first,
 * this one is discarded, the winner processed, and the change rebuilt on
 * the new epoch.
 */
export async function commitProjectGroup(
  ctx: ProjectGroupContext,
  projectId: string,
  request: CommitRequest = {}
): Promise<ProjectGroupState> {
  const device = requireDevice(ctx);
  const ref = refOf(ctx, device, projectId);
  const attempts = ctx.attempts ?? DEFAULT_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await catchUpProjectGroup(ctx, projectId);
    const group = await fetchGroup(ctx, projectId);
    const directory = await directoryFor(ctx, projectId);
    const pending = await ctx.sessions.commit(ref, directory, request);
    const submitted = await submitPending(
      ctx,
      device,
      projectId,
      group.keyEpochBase,
      directory,
      { commit: pending.commit }
    );
    if (submitted.accepted) {
      await ctx.sessions.confirmCommit(ref, directory);
      return stateOf(submitted.group);
    }
    // The loser rebases: drop this Commit; the next catch-up processes the
    // winner before the change is built again.
    await ctx.sessions.discardCommit(ref);
  }
  throw new ProjectGroupError(
    'epoch-lost',
    'The project kept changing while this device committed. Try again.'
  );
}

/**
 * Process every Commit the sequencer accepted after this device's epoch,
 * after resolving any Commit a crash left pending.
 */
export async function catchUpProjectGroup(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<ProjectGroupState> {
  const device = requireDevice(ctx);
  const ref = refOf(ctx, device, projectId);
  if (!(await ctx.sessions.leaf(ref))) {
    throw new ProjectGroupError(
      'no-session',
      'This device has not joined the project’s group yet.'
    );
  }
  const foreign = await foreignLocalState(ctx, ref, projectId);
  if (foreign) {
    await ctx.sessions.discardSession(ref, foreign.signatureKey);
    throw new ProjectGroupError(
      'no-session',
      'This device’s encryption state for the project was never part of its group and was discarded. Join the group again.'
    );
  }
  await recoverProjectGroup(ctx, projectId);
  let group = await fetchGroup(ctx, projectId);
  for (;;) {
    const status = await ctx.sessions.status(ref);
    if (!status.inGroup || status.epoch === null) {
      throw new ProjectGroupError(
        'no-session',
        'This device is no longer in the project’s group.'
      );
    }
    let epoch = status.epoch;
    const page = await ctx.api.commits(projectId, epoch);
    if (page.commits.length === 0) {
      if (group.epoch > epoch) {
        throw new ProjectGroupError(
          'server-mismatch',
          `The server's group is at epoch ${group.epoch} but holds no Commit after ${epoch}.`
        );
      }
      return { epoch, keyEpoch: group.keyEpochBase + epoch };
    }
    // Leaves are stored with the Commit that adds them, so reading them
    // after the Commits covers every leaf those Commits name.
    const directory = await directoryFor(ctx, projectId);
    for (const commit of page.commits) {
      if (commit.epoch !== epoch) {
        throw new ProjectGroupError(
          'server-mismatch',
          `The server skipped from epoch ${epoch} to ${commit.epoch}.`
        );
      }
      const processed = await ctx.sessions.process(
        ref,
        directory,
        bytes(commit.message)
      );
      if (processed.kind !== 'commit') {
        throw new ProjectGroupError(
          'server-mismatch',
          'The sequencer delivered a message that is not a Commit.'
        );
      }
      if (processed.change.removedSelf) {
        throw new ProjectGroupError(
          'no-session',
          'This device was removed from the project’s group.'
        );
      }
      epoch = processed.change.epoch;
    }
    if (!page.more) group = await fetchGroup(ctx, projectId);
  }
}

export type Recovery = 'none' | 'confirmed' | 'discarded' | 'resent';

/**
 * Resolve a Commit (or rejoin) that a crash, a reload or a lost response
 * left pending: confirm it when the server's winner for its epoch is this
 * very Commit; otherwise discard it (the next catch-up processes the
 * winner). A member's Commit nobody ruled on is sent again; a rejoin nobody
 * ruled on is discarded, since its epoch record lived only in memory, and
 * the next join builds a fresh one.
 */
export async function recoverProjectGroup(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<Recovery> {
  const device = requireDevice(ctx);
  const ref = refOf(ctx, device, projectId);
  const pending = await ctx.sessions.pendingCommit(ref);
  if (!pending) return 'none';
  const status = await ctx.sessions.status(ref);
  const external = status.pendingRejoin;
  if (status.epoch === null) throw new Error('A pending Commit has no epoch.');
  // A provisional rejoin already reports its new epoch.
  const epoch = external ? status.epoch - 1 : status.epoch;
  const winner = (await ctx.api.commits(projectId, epoch)).commits.find(
    (commit) => commit.epoch === epoch
  );
  if (winner && sameBytes(bytes(winner.message), pending.commit)) {
    const directory = await directoryFor(ctx, projectId);
    if (external) await ctx.sessions.confirmRejoin(ref, directory);
    else await ctx.sessions.confirmCommit(ref, directory);
    const group = await fetchGroup(ctx, projectId);
    rememberProjectKey(
      ctx.account.userId,
      projectId,
      group.keyEpochBase + epoch + 1,
      await ctx.sessions.projectKey(ref)
    );
    return 'confirmed';
  }
  if (winner || external) {
    if (external) await ctx.sessions.discardRejoin(ref);
    else await ctx.sessions.discardCommit(ref);
    return 'discarded';
  }
  const group = await fetchGroup(ctx, projectId);
  if (group.epoch !== epoch) {
    throw new ProjectGroupError(
      'server-mismatch',
      `The server's group is at epoch ${group.epoch} with no Commit for epoch ${epoch}.`
    );
  }
  const directory = await directoryFor(ctx, projectId);
  const submitted = await submitPending(
    ctx,
    device,
    projectId,
    group.keyEpochBase,
    directory,
    { commit: pending.commit }
  );
  if (submitted.accepted) {
    await ctx.sessions.confirmCommit(ref, directory);
    return 'resent';
  }
  await ctx.sessions.discardCommit(ref);
  return 'discarded';
}
