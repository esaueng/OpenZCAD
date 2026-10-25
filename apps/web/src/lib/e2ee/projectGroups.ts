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
 * - **Device removal** (slice 4-10). Revoked devices get their per-project
 *   cutoffs (identity-signed statements, `projectRevocationCutoffs`) and
 *   named replacements in the directory; writers rotate a group past a
 *   removal before anything else (`ensureProjectRotated`), with a new
 *   dedupe secret (D8); the named replacement may rejoin a group whose last
 *   leaf of the user was revoked. An owner alone in a project may replace
 *   its group under an identity-signed reset (`resetProjectGroup`, D9).
 * - **Members** (slice 5-2). With the co-members' verified device lists
 *   (`ProjectGroupContext.members`) the directory, archives and version
 *   authorship accept their devices, with their own revocation cutoffs;
 *   a device that processes someone else's Commit posts its account's own
 *   wraps of the new epoch (`postOwnEpochKeys`); and `epochRoles` reads
 *   the roles each epoch's record holds, for checking a version's author
 *   against the role held in its own epoch.
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
  verifyGroupReset,
  verifyProjectEnvelopeSignature,
  verifyRevocationCutoffs,
  wrapKey,
  type ArchivedProjectKey,
  type GroupReset,
  type KeyArchiveBody,
  type ProjectEnvelopeHeaderInit,
  type RevocationCutoffHead,
  type RevocationCutoffs,
  type SignedStatement,
  type VerifiedDeviceList,
  type WrapContext
} from '@openzcad/crypto';
import type {
  CommitRequest,
  ProjectRoles,
  RejoinPsk,
  SessionStatus
} from '@openzcad/mls';
import type {
  E2eeGroupResetRequest,
  E2eeGroupResetsResponse,
  E2eeCreateProjectGroupRequest,
  E2eeKeyArchiveRecord,
  E2eeKeyArchivesResponse,
  E2eeMlsCommitRecord,
  E2eeMlsCommitRequest,
  E2eeMlsCommitResponse,
  E2eeMlsCommitsResponse,
  E2eeProjectGroupRecord,
  E2eeProjectGroupResponse,
  E2eeMemberRevocationCutoffsResponse,
  E2eeProjectKeyPurpose,
  E2eeProjectKeyUploadRequest,
  E2eeProjectKeyUploadResponse,
  E2eeProjectKeyWrap,
  E2eeProjectKeysResponse,
  E2eeProjectLeavesResponse,
  E2eeMlsAddRequest,
  E2eeMlsRoleChange,
  E2eeWelcomeResponse
} from '@openzcad/shared';
import { desktopFetch } from '../desktopBridge';
import {
  openAccountKeyChain,
  type AccountView,
  type E2eeContext
} from './accountKeys';
import { E2eeApiError } from './e2eeApi';
import type { CertifyingDevice } from './mls/certify';
import {
  parseEpochContext,
  parseGroupInfoContext,
  projectGroupId,
  type EpochContext
} from './mls/epochRoles';
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
  /** The project's identity-authorized group resets (migration 0036). */
  resets?(projectId: string): Promise<E2eeGroupResetsResponse>;
  /**
   * Post this account's own wraps for an epoch it reached by processing
   * someone else's Commit (slice 5-2, decision D1).
   */
  postKeys?(
    projectId: string,
    request: E2eeProjectKeyUploadRequest
  ): Promise<E2eeProjectKeyUploadResponse>;
  /** The other members' revocation cutoff statements (slice 5-2). */
  memberCutoffs?(
    projectId: string
  ): Promise<E2eeMemberRevocationCutoffsResponse>;
  /** Replace a solo project's group (decision D9; migration 0036). */
  resetGroup?(
    projectId: string,
    request: E2eeGroupResetRequest
  ): Promise<E2eeProjectGroupResponse>;
  /**
   * The newest Welcome an owner's Add stored for this device (slice 5-3b,
   * migration 0038; 404 `E2EE_WELCOME_NOT_FOUND` when none).
   */
  welcome?(projectId: string, deviceId: string): Promise<E2eeWelcomeResponse>;
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
      ),
    resets: (projectId) => call(`${base(projectId)}/mls/resets`),
    postKeys: (projectId, request) =>
      call(`${base(projectId)}/keys`, 'POST', request),
    memberCutoffs: (projectId) => call(`${base(projectId)}/revocation-cutoffs`),
    resetGroup: (projectId, request) =>
      call(`${base(projectId)}/mls/reset`, 'POST', request),
    welcome: (projectId, deviceId) =>
      call(`${base(projectId)}/welcome${query({ deviceId })}`)
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
  /** The identity generation of `list`; 1 when absent. */
  readonly generation?: number;
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
  /**
   * This account's identity-signed revocation cutoff statements (slice
   * 4-10). Without them a revoked device has a cutoff only in groups made
   * after its revocation, and the directory refuses the rest.
   */
  readonly revocations?: RevocationStatements;
  /**
   * The project's other members' verified, pinned device lists (slice 5-2;
   * contacts and pins, slice 5-1, supply them). Without them a project is
   * solo: a leaf, archive or version of any other account is refused.
   */
  readonly members?: ProjectMemberLists;
}

/** Where co-members' verified device lists come from (slice 5-2). */
export interface ProjectMemberLists {
  /**
   * Verified, pinned device lists of the project's other members. A list
   * for this account's own user is ignored: its own list is the account's.
   */
  lists(projectId: string): Promise<readonly VerifiedDeviceList[]>;
}

/** Where verified revocation cutoff statements come from. */
export interface RevocationStatements {
  /**
   * Every statement of the account's current identity generation, each
   * verified against `ProjectGroupContext.account.list`.
   */
  verified(): Promise<readonly RevocationCutoffs[]>;
}

/** The account view's keys: the current one, and older ones by history. */
export function projectGroupAccount(
  ctx: E2eeContext,
  account: AccountView
): ProjectGroupAccount {
  return {
    userId: account.userId,
    list: account.list,
    generation: account.generation,
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
  | 'epoch-lost'
  /** A Commit signed by a removed device, after its removal (slice 4-10). */
  | 'removed-device'
  /** A reset refused: someone else is in the group, or no confirmation. */
  | 'reset-refused'
  /**
   * A membership change refused before it is sent (slice 5-4): not the
   * owner, not a member, or an ownership transfer.
   */
  | 'membership-refused';

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
 * This account's device list and the project's other members' (slice 5-2),
 * one per user. Without `ctx.members` the project is solo.
 */
export async function projectDeviceLists(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<VerifiedDeviceList[]> {
  const own = ctx.account.list;
  const lists = [own];
  if (!ctx.members) return lists;
  for (const list of await ctx.members.lists(projectId)) {
    if (list.userId === own.userId) continue;
    if (lists.some((known) => known.userId === list.userId)) {
      throw new ProjectGroupError(
        'server-mismatch',
        `Two device lists were given for ${list.userId}.`
      );
    }
    lists.push(list);
  }
  return lists;
}

/**
 * The verified directory input: every member's device list (slice 5-2;
 * a solo project's is the owner's alone) and every leaf the registry
 * holds. A leaf of an account whose list is not given is refused visibly,
 * not dropped.
 */
async function directoryFor(
  ctx: ProjectGroupContext,
  projectId: string,
  known?: E2eeProjectGroupRecord
): Promise<DirectoryInput> {
  const lists = await projectDeviceLists(ctx, projectId);
  const revocationCutoffs = await directoryCutoffs(
    ctx,
    projectId,
    lists,
    known
  );
  const { leaves } = await ctx.api.leaves(projectId);
  const certifications: LeafCertification[] = leaves.map((leaf) => {
    if (!lists.some((list) => list.userId === leaf.userId)) {
      throw new ProjectGroupError(
        'server-mismatch',
        lists.length === 1
          ? 'The leaf registry of a solo project names another account.'
          : 'The leaf registry names an account that is not a member of this project.'
      );
    }
    return {
      userId: leaf.userId,
      deviceId: leaf.deviceId,
      leafKey: bytes(leaf.leafKey),
      certification: bytes(leaf.certification)
    };
  });
  return { lists, certifications, revocationCutoffs };
}

// --- Revocation cutoffs (slice 4-10) ---------------------------------------

/**
 * A revoked device's cutoff in one project: the first key epoch it must not
 * know, and the newest head the revoking browser had accepted (its versions
 * are accepted only up to that head and below that key epoch).
 */
export interface ProjectCutoff {
  readonly keyEpoch: number;
  readonly head: RevocationCutoffHead | null;
  /** True when it comes from a signed statement naming this project. */
  readonly signed: boolean;
}

const revokedDevices = (list: VerifiedDeviceList) =>
  list.revoked.filter((r) => r.kind === 'device');

/** The account key (generation, sequence) that made a group's epoch-0 wrap. */
const baseWrapKeys = new Map<
  string,
  { generation: number; keySequence: number }
>();

async function baseWrapKey(
  ctx: ProjectGroupContext,
  projectId: string,
  group: E2eeProjectGroupRecord
): Promise<{ generation: number; keySequence: number } | null> {
  const id = JSON.stringify([ctx.account.userId, projectId, group.groupId]);
  const known = baseWrapKeys.get(id);
  if (known) return known;
  const found = await openedBaseWrapKey(ctx, projectId, group);
  if (found) baseWrapKeys.set(id, found);
  return found;
}

async function openedBaseWrapKey(
  ctx: ProjectGroupContext,
  projectId: string,
  group: E2eeProjectGroupRecord
): Promise<{ generation: number; keySequence: number } | null> {
  const keyEpoch = group.keyEpochBase;
  const { wraps } = await ctx.api.keys(projectId, {
    keyEpoch,
    purpose: 'project-key'
  });
  const wrap = wraps.find(
    (w) => w.keyEpoch === keyEpoch && w.purpose === 'project-key'
  );
  if (!wrap) return null;
  // It must open under the key it names: only a holder of that key made it.
  const key = await openWrap(
    ctx,
    wrap,
    projectKeyContext(ctx.account.userId, projectId, keyEpoch)
  ).catch(() => null);
  if (!key) return null;
  key.fill(0);
  return {
    generation: wrap.accountKeyGeneration,
    keySequence: wrap.accountKeySequence
  };
}

/**
 * Every revoked device's cutoff in this project, by device id:
 *
 * 1. the identity-signed statement of the entry that revoked it, when that
 *    statement names the project; otherwise
 * 2. the start of the current group, when that group's epoch-0 project key
 *    was wrapped under an account key from the revoking entry or later:
 *    the revoked device never held that key (the removal rotated it), so it
 *    knows nothing of this group.
 *
 * A revoked device with neither has no entry, and the directory (and
 * version authorship) refuse it rather than guess.
 */
export async function projectRevocationCutoffs(
  ctx: ProjectGroupContext,
  projectId: string,
  known?: E2eeProjectGroupRecord
): Promise<Map<string, ProjectCutoff>> {
  const out = new Map<string, ProjectCutoff>();
  const revoked = revokedDevices(ctx.account.list);
  if (revoked.length === 0) return out;
  const statements = ctx.revocations ? await ctx.revocations.verified() : [];
  let group = known;
  let base: { generation: number; keySequence: number } | null | undefined;
  const generation = currentGeneration(ctx);
  for (const device of revoked) {
    const named = statements
      .filter((s) => s.entrySequence === device.revokedAt)
      .flatMap((s) => s.cutoffs.filter((c) => c.projectId === projectId))
      .sort((a, b) => b.cutoffEpoch - a.cutoffEpoch)[0];
    if (named) {
      out.set(device.id, {
        keyEpoch: named.cutoffEpoch,
        head: named.head ?? null,
        signed: true
      });
      continue;
    }
    group ??= await fetchGroup(ctx, projectId).catch(() => undefined);
    if (!group) continue;
    if (base === undefined) base = await baseWrapKey(ctx, projectId, group);
    if (
      base &&
      base.generation === generation &&
      base.keySequence >= device.revokedAt
    ) {
      out.set(device.id, {
        keyEpoch: group.keyEpochBase,
        head: null,
        signed: false
      });
    }
  }
  return out;
}

/** The account's identity generation, as the account key names it. */
function currentGeneration(ctx: ProjectGroupContext): number {
  return ctx.account.generation ?? 1;
}

/** The directory's cutoffs: MLS epochs of the current group (never below 0). */
async function directoryCutoffs(
  ctx: ProjectGroupContext,
  projectId: string,
  lists: readonly VerifiedDeviceList[],
  known?: E2eeProjectGroupRecord
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  let group = known;
  const toEpochs = async (cutoffs: ReadonlyMap<string, ProjectCutoff>) => {
    group ??= await fetchGroup(ctx, projectId);
    const devices = new Map<string, number>();
    for (const [deviceId, cutoff] of cutoffs) {
      devices.set(deviceId, Math.max(0, cutoff.keyEpoch - group.keyEpochBase));
    }
    return devices;
  };
  let own = new Map<string, number>();
  if (revokedDevices(ctx.account.list).length) {
    group ??= await fetchGroup(ctx, projectId);
    own = await toEpochs(await projectRevocationCutoffs(ctx, projectId, group));
  }
  out.set(ctx.account.userId, own);
  const members = await memberRevocationCutoffs(ctx, projectId, lists);
  for (const [userId, cutoffs] of members) {
    out.set(userId, await toEpochs(cutoffs));
  }
  return out;
}

/**
 * The project's other members' revoked devices' cutoffs (slice 5-2), by
 * user and device: from each member's identity-signed statements naming
 * this project, verified against that member's list. A revoked device
 * without one has no entry, and the directory refuses it rather than
 * guess (slice 5-7 brings cutoffs for every shared project).
 */
export async function memberRevocationCutoffs(
  ctx: ProjectGroupContext,
  projectId: string,
  lists?: readonly VerifiedDeviceList[]
): Promise<Map<string, Map<string, ProjectCutoff>>> {
  const out = new Map<string, Map<string, ProjectCutoff>>();
  const others = (lists ?? (await projectDeviceLists(ctx, projectId))).filter(
    (list) =>
      list.userId !== ctx.account.userId && revokedDevices(list).length > 0
  );
  if (others.length === 0 || !ctx.api.memberCutoffs) return out;
  const { statements } = await ctx.api
    .memberCutoffs(projectId)
    .catch(() => ({ statements: [] }));
  for (const list of others) {
    const verified: RevocationCutoffs[] = [];
    for (const record of statements) {
      if (record.userId !== list.userId) continue;
      const value = await verifyRevocationCutoffs(
        {
          statement: bytes(record.statement),
          signature: bytes(record.signature)
        },
        list,
        { generation: record.generation }
      ).catch(() => null);
      if (value) verified.push(value);
    }
    const devices = new Map<string, ProjectCutoff>();
    for (const device of revokedDevices(list)) {
      const named = verified
        .filter((s) => s.entrySequence === device.revokedAt)
        .flatMap((s) => s.cutoffs.filter((c) => c.projectId === projectId))
        .sort((a, b) => b.cutoffEpoch - a.cutoffEpoch)[0];
      if (named) {
        devices.set(device.id, {
          keyEpoch: named.cutoffEpoch,
          head: named.head ?? null,
          signed: true
        });
      }
    }
    out.set(list.userId, devices);
  }
  return out;
}

/** A new group is made after every revocation its creator's list holds. */
function newGroupCutoffs(
  ctx: ProjectGroupContext
): Map<string, Map<string, number>> {
  return new Map([
    [
      ctx.account.userId,
      new Map(revokedDevices(ctx.account.list).map((r) => [r.id, 0]))
    ]
  ]);
}

// --- Keys and wraps --------------------------------------------------------

const projectKeyContext = (
  userId: string,
  projectId: string,
  keyEpoch: number
): WrapContext => ({ purpose: 'project-key', userId, projectId, keyEpoch });

/**
 * A rejoin PSK's wrap binds its key epoch, the row it is stored and looked
 * up by, not its MLS epoch: MLS epochs restart at 0 after a group reset
 * (slice 4-10), key epochs never do (decision D10).
 */
const rejoinPskContext = (
  userId: string,
  projectId: string,
  keyEpoch: number
): WrapContext => ({ purpose: 'rejoin-psk', userId, projectId, keyEpoch });

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
            rejoinPskContext(userId, projectId, keyEpoch)
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

/** Project and account pairs whose own session is being synchronized. */
const syncing = new Set<string>();

/**
 * Bring this device's own session up to `keyEpoch` before a read gives up
 * on it (slice 5-3b; the slice 5-2 gap). Wraps of an epoch exist for this
 * account only once one of its devices processed that epoch, and roles of
 * an epoch come from its key archive (under that epoch's key) or from this
 * device's own session at it. So a device whose session is behind a
 * member's Commit, an External Commit of their other device above all,
 * catches up here (processing posts the account's own wraps of the epoch),
 * and a device whose KeyPackage an owner's Add consumed joins by its
 * Welcome. True when the session moved; any failure leaves the read as it
 * was.
 */
async function syncOwnSession(
  ctx: ProjectGroupContext,
  projectId: string,
  keyEpoch: number
): Promise<boolean> {
  const device = ctx.device;
  if (!device) return false;
  const ref = refOf(ctx, device, projectId);
  const id = JSON.stringify([ref.userId, projectId]);
  if (syncing.has(id)) return false;
  syncing.add(id);
  try {
    if (!(await ctx.sessions.leaf(ref))) return false;
    const status = await ctx.sessions.status(ref);
    if (!status.inGroup) {
      if (status.removed || status.pendingRejoin) return false;
      return (await joinProjectByWelcome(ctx, projectId)) !== null;
    }
    if (status.epoch === null || status.pendingCommit) return false;
    const group = await fetchGroup(ctx, projectId);
    const own = group.keyEpochBase + status.epoch;
    if (keyEpoch <= own || keyEpoch > group.keyEpochBase + group.epoch) {
      return false;
    }
    const caught = await catchUpProjectGroup(ctx, projectId);
    return caught.keyEpoch > own;
  } catch {
    return false;
  } finally {
    syncing.delete(id);
  }
}

/**
 * The project key of `keyEpoch`: the page cache, the account-key wrap
 * (decision D1; the only source on a read-only approved device, D4), the
 * local session when it is at that epoch, or a later epoch's key archive.
 * Before the local session and the archives, a device whose own session is
 * behind `keyEpoch`, or holds a KeyPackage an Add consumed, synchronizes
 * (`syncOwnSession`) and looks again.
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
  const wrapped = async () => {
    const { wraps } = await ctx.api.keys(projectId, {
      keyEpoch,
      purpose: 'project-key'
    });
    const wrap = wraps.find(
      (w) => w.keyEpoch === keyEpoch && w.purpose === 'project-key'
    );
    return wrap
      ? openWrap(ctx, wrap, projectKeyContext(userId, projectId, keyEpoch))
      : null;
  };
  const first = await wrapped();
  if (first) return remember(first);
  if (await syncOwnSession(ctx, projectId, keyEpoch)) {
    const synced = unlockedProjectKey(userId, projectId, keyEpoch);
    if (synced) return synced;
    const again = await wrapped();
    if (again) return remember(again);
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
 * device of a member (this account, or since slice 5-2 a co-member whose
 * verified list `ctx.members` gives: any member may commit), encrypted
 * under `projectKey` for this project and key epoch, and bound to the
 * epoch authenticator it carries.
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
  const lists = await projectDeviceLists(ctx, projectId);
  // Device ids are not unique across accounts: any list's key may verify.
  const candidates = lists.flatMap((list) => {
    const key = signerKey(list, archive.signerDeviceId);
    return key ? [{ list, key }] : [];
  });
  if (candidates.length === 0) {
    refuse('is signed by a device no member’s list ever certified');
  }
  let signed = false;
  let removedLate = false;
  for (const { list, key } of candidates) {
    if (!list.devices.some((d) => d.deviceId === archive.signerDeviceId)) {
      // A removed device's archive counts only for epochs it could know.
      // Without a known cutoff it is left to the key: such a device holds
      // no project key of an epoch after its removal's rotation, so it
      // cannot have encrypted that epoch's archive.
      const cutoff = (
        list.userId === ctx.account.userId
          ? await projectRevocationCutoffs(ctx, projectId)
          : ((await memberRevocationCutoffs(ctx, projectId, lists)).get(
              list.userId
            ) ?? new Map<string, ProjectCutoff>())
      ).get(archive.signerDeviceId);
      if (cutoff && keyEpoch >= cutoff.keyEpoch) {
        removedLate = true;
        continue;
      }
    }
    if (
      await verifyProjectEnvelopeSignature(
        key,
        envelope,
        bytes(archive.signature)
      ).catch(() => null)
    ) {
      signed = true;
      break;
    }
  }
  if (!signed && removedLate) {
    refuse('is signed by a removed device after its removal');
  }
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

/**
 * The project's asset dedupe secret, from the current key epoch's verified
 * key archive (ADR-024: carried across epochs, replaced when someone loses
 * access, decision D8). Content blob dedupe tags are HMACs under it.
 */
export async function dedupeSecretForProject(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<{ keyEpoch: number; secret: Uint8Array }> {
  const group = await fetchGroup(ctx, projectId);
  const keyEpoch = group.keyEpochBase + group.epoch;
  const projectKey = await projectKeyForEpoch(ctx, projectId, keyEpoch);
  const body = await openArchive(
    ctx,
    projectId,
    keyEpoch,
    projectKey,
    await fetchArchive(ctx, projectId, keyEpoch)
  );
  return { keyEpoch, secret: new Uint8Array(body.dedupeSecret) };
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
 * every epoch's record from its archive (the join archive's records). A
 * Welcome join (slice 5-3b) reads it through the epoch it joins instead,
 * with that epoch's key from the provisional session.
 */
async function loadHistory(
  ctx: ProjectGroupContext,
  projectId: string,
  group: E2eeProjectGroupRecord,
  joined?: { readonly epoch: number; readonly key: Uint8Array }
): Promise<History> {
  const targetEpoch = joined?.epoch ?? group.epoch;
  const target = group.keyEpochBase + targetEpoch;
  const newestKey =
    joined?.key ?? (await projectKeyForEpoch(ctx, projectId, target));
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
  while (records.length < targetEpoch) {
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
      if (records.length === targetEpoch) break;
    }
    if (records.length < targetEpoch && !page.more) {
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
    certifications: [],
    revocationCutoffs: newGroupCutoffs(ctx)
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
    /**
     * A new dedupe secret for the new epoch (decision D8): someone lost
     * access, so blob tags under the old one must not continue.
     */
    readonly replaceDedupeSecret?: boolean;
    /** An owner's Add states its invitation, KeyPackages and Welcome. */
    readonly add?: E2eeMlsAddRequest;
    /** An owner's role changes of current members (slice 5-4). */
    readonly roles?: readonly E2eeMlsRoleChange[];
    /** The identities an owner's Commit drops from the roles. */
    readonly dropUsers?: readonly string[];
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
      dedupeSecret: pending.replaceDedupeSecret
        ? generateAssetDedupeSecret()
        : dedupeSecret,
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
      archive,
      ...(pending.add ? { add: pending.add } : {}),
      ...(pending.roles?.length ? { roles: [...pending.roles] } : {}),
      ...(pending.dropUsers?.length
        ? { dropUsers: [...pending.dropUsers] }
        : {})
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

/** Devices whose identity-signed revocation named this device as replacement. */
function replacedDevices(
  ctx: ProjectGroupContext,
  device: CertifyingDevice
): string[] {
  return revokedDevices(ctx.account.list)
    .filter((r) => r.replacedBy === device.deviceId)
    .map((r) => r.id);
}

/**
 * Join this owner's device to the project's group by external Commit with
 * the newest account-wrapped rejoin PSK (decision D3), then make sure the
 * group has rotated past every removal (writers enforce rotation). Works
 * while every other device is offline. A rejoin that loses its epoch is
 * discarded and rebuilt on the newer GroupInfo.
 *
 * - **Last-leaf exception.** When every leaf of this account left in the
 *   group belongs to a revoked device whose revocation named this device
 *   as its replacement, the external Commit removes one of those leaves,
 *   and the policy lets it use the newest PSK from before the revocation.
 * - **State that cannot follow.** Local state of a group the project no
 *   longer uses (an identity-authorized reset), or that cannot process a
 *   Commit a since-removed device sent before its removal, is replaced by
 *   a fresh leaf that rejoins from the key archives.
 */
export async function joinProjectGroup(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<ProjectGroupState> {
  const device = requireDevice(ctx);
  const ref = refOf(ctx, device, projectId);
  let fresh = false;
  const foreign = await foreignLocalState(ctx, ref, projectId);
  if (foreign) {
    // A group of this device's own that the server never accepted: drop it
    // and join the server's.
    await ctx.sessions.discardSession(ref, foreign.signatureKey);
  } else if (await ctx.sessions.leaf(ref)) {
    // Resolve a rejoin a crash left pending before deciding anything.
    await recoverProjectGroup(ctx, projectId);
    // A device an owner's Add brought in joins by its Welcome (slice 5-3b).
    const welcomed = await joinProjectByWelcome(ctx, projectId);
    if (welcomed) return await ensureProjectRotated(ctx, projectId, welcomed);
    const status = await ctx.sessions.status(ref);
    if (status.inGroup) {
      try {
        return await ensureProjectRotated(
          ctx,
          projectId,
          await catchUpProjectGroup(ctx, projectId)
        );
      } catch (error) {
        if (!(
          error instanceof ProjectGroupError && error.code === 'no-session'
        ))
          throw error;
        fresh = true;
      }
    } else if (status.removed) {
      fresh = true;
    }
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
    const directory = await directoryFor(ctx, projectId, group);
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
      },
      { replaceDevices: replacedDevices(ctx, device), fresh }
    );
    // Written: later attempts restore this state, not the stale one.
    fresh = false;
    if (result.change.epoch !== group.epoch + 1) {
      await ctx.sessions.discardRejoin(ref);
      throw new ProjectGroupError(
        'server-mismatch',
        `The server's GroupInfo is not from epoch ${group.epoch}.`
      );
    }
    const revoked = new Set(revokedDevices(ctx.account.list).map((r) => r.id));
    const submitted = await submitPending(
      ctx,
      device,
      projectId,
      group.keyEpochBase,
      directory,
      {
        commit: result.commit,
        rejoinRecord: result.change.epochRecord,
        history,
        replaceDedupeSecret:
          result.change.removed.some((leaf) => revoked.has(leaf.deviceId)) ||
          (await wrapIsStale(ctx, projectId, group.keyEpochBase + group.epoch))
      }
    );
    if (submitted.accepted) {
      await ctx.sessions.confirmRejoin(ref, directory);
      return await ensureProjectRotated(ctx, projectId);
    }
    // Another Commit took the epoch: start over from the newer GroupInfo.
    await ctx.sessions.discardRejoin(ref);
  }
  throw new ProjectGroupError(
    'epoch-lost',
    'The project kept changing while this device joined. Try again.'
  );
}

/**
 * Join by the Welcome an owner's Add stored for this device (slice 5-3b),
 * when this device published the KeyPackage it consumed. Null when no
 * Welcome waits (no KeyPackage from this device, or none was added).
 *
 * The Welcome opens provisionally (`beginJoin`); its exporter decrypts the
 * joined epoch's key archive, whose earlier keys open every earlier
 * archive; the epoch records of epochs 1 through the joined one, from the
 * signed initial GroupInfo, are the join archive `completeJoin` verifies
 * against the Welcome (#817): an inviter, or a server, that omits or
 * alters history is refused, and the KeyPackage session is restored, so a
 * complete history can still join with the same Welcome. Only then is the
 * joined epoch's key trusted: this account posts its own wraps of it (the
 * project key and rejoin PSK, decision D1), which its other devices read
 * and rejoin with, and the device catches up on later Commits.
 */
export async function joinProjectByWelcome(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<ProjectGroupState | null> {
  const device = requireDevice(ctx);
  const ref = refOf(ctx, device, projectId);
  if (!ctx.api.welcome || !(await ctx.sessions.leaf(ref))) return null;
  const status = await ctx.sessions.status(ref);
  if (status.inGroup || status.removed || status.pendingRejoin) return null;
  // A provisional join a reload interrupted starts again from the Welcome.
  if (status.pendingJoin || status.pendingArchive) {
    await ctx.sessions.discardJoin(ref);
  }
  let welcome: E2eeWelcomeResponse['welcome'];
  try {
    welcome = (await ctx.api.welcome(projectId, device.deviceId)).welcome;
  } catch (error) {
    if (isApiError(error, 'E2EE_WELCOME_NOT_FOUND')) return null;
    throw error;
  }
  const group = await fetchGroup(ctx, projectId);
  const epoch = welcome.epoch + 1;
  if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > group.epoch) {
    throw new ProjectGroupError(
      'server-mismatch',
      `The server's Welcome joins epoch ${epoch}, but the group is at ${group.epoch}.`
    );
  }
  const directory = await directoryFor(ctx, projectId, group);
  await ctx.sessions.beginJoin(ref, directory, bytes(welcome.welcome));
  let history: History;
  try {
    // Untrusted until completeJoin: it only opens the archives.
    const joinedKey = await ctx.sessions.archiveKey(ref);
    history = await loadHistory(ctx, projectId, group, {
      epoch,
      key: joinedKey
    });
    await ctx.sessions.completeJoin(ref, directory, {
      initialGroupInfo: bytes(group.initialGroupInfo),
      epochRecords: history.records
    });
  } catch (error) {
    await ctx.sessions.discardJoin(ref).catch(() => undefined);
    throw error;
  }
  const material = await ctx.sessions.epochMaterial(ref);
  const keyEpoch = group.keyEpochBase + epoch;
  if (
    material.epoch !== epoch ||
    !sameBytes(material.projectKey, history.keys.get(keyEpoch)!)
  ) {
    throw new ProjectGroupError(
      'server-mismatch',
      `The Welcome did not join epoch ${epoch}.`
    );
  }
  const joined = await ctx.sessions.status(ref);
  if (joined.roles) {
    knownRoles.set(rolesId(ctx, projectId, keyEpoch), joined.roles);
  }
  for (const [historic, key] of history.keys) {
    rememberProjectKey(ctx.account.userId, projectId, historic, key);
  }
  if (ctx.api.postKeys) {
    try {
      await postOwnEpochKeys(ctx, projectId, keyEpoch, material);
    } catch {
      // Best effort, as after processing a Commit: the next processed
      // Commit posts that epoch's wraps.
    }
  }
  return await catchUpProjectGroup(ctx, projectId);
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
  return {
    epoch: newest.keyEpoch - group.keyEpochBase,
    secret: await openWrap(
      ctx,
      newest,
      rejoinPskContext(ctx.account.userId, projectId, newest.keyEpoch)
    )
  };
}

// --- Rotation after a removal (slice 4-10) ---------------------------------

/** Wraps already proven to be under the current account key. */
const currentWraps = new Set<string>();

/**
 * Whether `keyEpoch`'s project key is still wrapped only under an account
 * key older than the current one. Account keys rotate when a device, a
 * passkey or the read-only devices are removed, and whatever held the old
 * key can open every wrap made under it, so such an epoch must be left.
 * A claim of the current key counts only once the wrap opens under it.
 */
async function wrapIsStale(
  ctx: ProjectGroupContext,
  projectId: string,
  keyEpoch: number
): Promise<boolean> {
  const current = await ctx.account.currentAccountKey();
  current.key.fill(0);
  const id = JSON.stringify([
    ctx.account.userId,
    projectId,
    keyEpoch,
    current.generation,
    current.keySequence
  ]);
  if (currentWraps.has(id)) return false;
  const { wraps } = await ctx.api.keys(projectId, {
    keyEpoch,
    purpose: 'project-key'
  });
  const wrap = wraps.find(
    (w) => w.keyEpoch === keyEpoch && w.purpose === 'project-key'
  );
  if (
    !wrap ||
    wrap.accountKeyGeneration !== current.generation ||
    wrap.accountKeySequence !== current.keySequence
  ) {
    return true;
  }
  const opened = await openWrap(
    ctx,
    wrap,
    projectKeyContext(ctx.account.userId, projectId, keyEpoch)
  ).catch(() => null);
  if (!opened) return true;
  opened.fill(0);
  currentWraps.add(id);
  return false;
}

/**
 * What a Commit must carry before anything else is written (ADR-024,
 * "Writers enforce the rotation"): a Remove of every leaf of a device the
 * newest device list revokes, or, when there is none but the current
 * epoch's key is wrapped only under a replaced account key, an empty
 * Commit for a new epoch. Null when no rotation is due.
 */
async function rotationRequest(
  ctx: ProjectGroupContext,
  projectId: string,
  status: SessionStatus,
  group: E2eeProjectGroupRecord
): Promise<CommitRequest | null> {
  const revoked = new Set(revokedDevices(ctx.account.list).map((r) => r.id));
  const remove = status.members
    .filter((m) => m.userId === ctx.account.userId && revoked.has(m.deviceId))
    .map((m) => m.index);
  if (remove.length) return { remove };
  if (status.epoch === null) return null;
  return (await wrapIsStale(ctx, projectId, group.keyEpochBase + status.epoch))
    ? {}
    : null;
}

/**
 * Finish any rotation a removal left due in this project: Remove the
 * revoked devices' leaves (or start a new epoch), with the new epoch's
 * keys under the current account key and a new dedupe secret (decision
 * D8). This is how another device finishes a removal that went offline
 * part-way. A no-op once the project has rotated.
 */
export async function ensureProjectRotated(
  ctx: ProjectGroupContext,
  projectId: string,
  /** The state a catch-up just reached: skips a second one when nothing is due. */
  caught?: ProjectGroupState
): Promise<ProjectGroupState> {
  if (caught) {
    const device = requireDevice(ctx);
    const status = await ctx.sessions.status(refOf(ctx, device, projectId));
    const group = await fetchGroup(ctx, projectId);
    if (
      status.epoch === caught.epoch &&
      group.epoch === caught.epoch &&
      !(await rotationRequest(ctx, projectId, status, group))
    ) {
      return caught;
    }
  }
  return commitLoop(ctx, projectId, async (status, group) => {
    const rotation = await rotationRequest(ctx, projectId, status, group);
    return rotation ? { request: rotation, rotation: true } : null;
  });
}

// --- Commit, catch up, recover --------------------------------------------

interface BuiltCommit {
  readonly request: CommitRequest;
  /** The Commit carries a due rotation: replace the dedupe secret. */
  readonly rotation: boolean;
  /** An owner's Add of an invitee (slice 5-3b). */
  readonly invitee?: InviteeAddition;
}

/**
 * Catch up, build the Commit for the current epoch, submit it with its new
 * epoch's material, and rebase onto a winner up to `attempts` times. A null
 * build means nothing needs committing.
 */
async function commitLoop(
  ctx: ProjectGroupContext,
  projectId: string,
  build: (
    status: SessionStatus,
    group: E2eeProjectGroupRecord
  ) => Promise<BuiltCommit | null>
): Promise<ProjectGroupState> {
  const device = requireDevice(ctx);
  const ref = refOf(ctx, device, projectId);
  const attempts = ctx.attempts ?? DEFAULT_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const caught = await catchUpProjectGroup(ctx, projectId);
    const group = await fetchGroup(ctx, projectId);
    const built = await build(await ctx.sessions.status(ref), group);
    if (!built) return caught;
    const directory = withInvitee(
      await directoryFor(ctx, projectId, group),
      built.invitee
    );
    // The Worker mirrors an owner's role changes and checks the new epoch's
    // roles against them (slice 5-4); an Add states its invitee instead.
    const roles = built.invitee ? [] : statedRoles(built.request);
    const pending = await ctx.sessions.commit(ref, directory, built.request);
    const submitted = await submitPending(
      ctx,
      device,
      projectId,
      group.keyEpochBase,
      directory,
      {
        commit: pending.commit,
        replaceDedupeSecret: built.rotation,
        ...(built.invitee
          ? { add: addRequest(built.invitee, pending.welcome) }
          : {}),
        roles,
        dropUsers: built.request.dropUsers ?? []
      }
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
 * Commit a change (by default an empty Commit, which refreshes this leaf's
 * path secrets) after catching up. A rotation a removal left due rides
 * along in the same Commit. If another Commit takes the epoch first, this
 * one is discarded, the winner processed, and the change rebuilt on the
 * new epoch.
 */
export function commitProjectGroup(
  ctx: ProjectGroupContext,
  projectId: string,
  request: CommitRequest = {}
): Promise<ProjectGroupState> {
  return commitLoop(ctx, projectId, async (status, group) => {
    const rotation = await rotationRequest(ctx, projectId, status, group);
    if (!rotation) return { request, rotation: false };
    const remove = [
      ...new Set([...(request.remove ?? []), ...(rotation.remove ?? [])])
    ];
    return {
      request: { ...request, ...(remove.length ? { remove } : {}) },
      rotation: true
    };
  });
}

/**
 * The role changes a Commit request's `setRoles` makes, as the Worker
 * reads them. An `owner` entry is passed on as it is, for the Worker to
 * refuse: `changeMemberRole` never builds one.
 */
function statedRoles(request: CommitRequest): E2eeMlsRoleChange[] {
  return (request.setRoles ?? []).map((change) => ({
    userId: change.userId,
    role: change.role as E2eeMlsRoleChange['role']
  }));
}

/**
 * Whether a stored pending Commit changes the roles (slice 5-4): it is
 * never resent bare, since the Worker refuses a role change it does not
 * state. The change it carried is made again by whoever asked for it.
 */
async function changesRoles(
  ctx: ProjectGroupContext,
  ref: MlsProjectRef,
  status: SessionStatus,
  directory: DirectoryInput
): Promise<boolean> {
  const next = await ctx.sessions.previewPending(ref, directory);
  let roles: ProjectRoles;
  try {
    roles = parseGroupInfoContext(next.groupInfo).roles;
  } catch {
    return true;
  }
  const before = new Map(
    (status.roles?.users ?? []).map((user) => [user.userId, user.role])
  );
  return (
    roles.users.length !== before.size ||
    roles.users.some((user) => before.get(user.userId) !== user.role)
  );
}

// --- Role changes (slice 5-4) -------------------------------------------------

/**
 * The owner changes a member's role (ADR-024, roles): one Commit whose
 * `setRoles` gives `userId` the new role from the next epoch on. Every
 * member's MLS policy accepts it only from the owner; the Worker mirrors
 * it into `project_members` in the same batch and refuses a Commit whose new
 * roles are not exactly that change. A demoted editor's earlier versions
 * keep verifying (each is checked against the roles of its own epoch); from
 * the new epoch on, its browser and the Worker refuse its writes, and every
 * browser refuses a version it signs. Ownership never moves on an
 * encrypted project. Resolves without a Commit when the role already holds.
 */
export function changeMemberRole(
  ctx: ProjectGroupContext,
  projectId: string,
  userId: string,
  role: 'editor' | 'viewer'
): Promise<ProjectGroupState> {
  if ((role as string) !== 'editor' && (role as string) !== 'viewer') {
    return Promise.reject(
      new ProjectGroupError(
        'membership-refused',
        'An encrypted project’s owner cannot be changed.'
      )
    );
  }
  return commitLoop(ctx, projectId, async (status, group) => {
    const owner = status.roles?.users.find((entry) => entry.role === 'owner');
    if (owner?.userId !== ctx.account.userId) {
      throw new ProjectGroupError(
        'membership-refused',
        'Only the owner can change roles in an encrypted project.'
      );
    }
    if (userId === owner.userId) {
      throw new ProjectGroupError(
        'membership-refused',
        'An encrypted project’s owner cannot be changed.'
      );
    }
    const entry = status.roles?.users.find((u) => u.userId === userId);
    if (!entry) {
      throw new ProjectGroupError(
        'membership-refused',
        'That person is not a member of this project.'
      );
    }
    if (entry.role === role) return null;
    const rotation = await rotationRequest(ctx, projectId, status, group);
    return {
      request: {
        setRoles: [{ userId, role }],
        ...(rotation?.remove?.length ? { remove: rotation.remove } : {})
      },
      rotation: rotation !== null
    };
  });
}

// --- Adding an invitee (slice 5-3b) -----------------------------------------

/** One KeyPackage of the invitee, as the owner's claim returned it. */
export interface InviteeKeyPackage {
  readonly deviceId: string;
  readonly keyPackage: Uint8Array;
  /** Hex SHA-256 of `keyPackage`, as the Add names it. */
  readonly keyPackageHash: string;
  /** The device's certified leaf for this project, which it carries. */
  readonly leafKey: Uint8Array;
  readonly certification: Uint8Array;
}

/** What the owner's Add brings in, all checked by the caller first. */
export interface InviteeAddition {
  readonly invitationId: string;
  readonly userId: string;
  /** The role the owner-signed invitation statement names. */
  readonly role: 'editor' | 'viewer';
  /**
   * The invitee's device list, which the owner verified (slice 5-1):
   * every KeyPackage's leaf is certified by one of its devices.
   */
  readonly list: VerifiedDeviceList;
  readonly keyPackages: readonly InviteeKeyPackage[];
}

/**
 * The directory an Add is built and confirmed with: the members' as usual,
 * plus the invitee's verified list and the leaves of the claimed
 * KeyPackages, which the registry holds only once the Add lands. The
 * invitee's revoked devices get cutoff 0 where nothing names one: they
 * were revoked before this group could give them a key, so none of its
 * rejoin PSKs is one they may know of.
 */
function withInvitee(
  directory: DirectoryInput,
  invitee: InviteeAddition | undefined
): DirectoryInput {
  if (!invitee) return directory;
  const listed = directory.lists.some((list) => list.userId === invitee.userId);
  const cutoffs = new Map(directory.revocationCutoffs ?? []);
  const devices = new Map(cutoffs.get(invitee.userId) ?? []);
  for (const revoked of revokedDevices(invitee.list)) {
    if (!devices.has(revoked.id)) devices.set(revoked.id, 0);
  }
  cutoffs.set(invitee.userId, devices);
  return {
    lists: listed ? directory.lists : [...directory.lists, invitee.list],
    certifications: [
      ...directory.certifications,
      ...invitee.keyPackages.map((entry): LeafCertification => ({
        userId: invitee.userId,
        deviceId: entry.deviceId,
        leafKey: entry.leafKey,
        certification: entry.certification
      }))
    ],
    revocationCutoffs: cutoffs
  };
}

function addRequest(
  invitee: InviteeAddition,
  welcome: Uint8Array | null
): E2eeMlsAddRequest {
  if (!welcome) throw new Error('An Add produced no Welcome.');
  return {
    invitationId: invitee.invitationId,
    keyPackages: invitee.keyPackages.map((entry) => ({
      userId: invitee.userId,
      deviceId: entry.deviceId,
      keyPackageHash: entry.keyPackageHash
    })),
    welcome: b64(welcome)
  };
}

/**
 * The owner's Add of an invitee (ADR-024, Sharing and collaboration; slice
 * 5-3b): one Commit adds every claimed KeyPackage (decision M3: each
 * invitee device that published one; the others rejoin from them) and
 * lists the identity in the roles with the invitation's role. It travels
 * with the Welcome, the invitation and the KeyPackages it consumes (the
 * Worker refuses any other set), the new epoch's GroupInfo, the owner's
 * own wraps of the new epoch and its key archive, whose records the
 * invitee's join verifies. The policy (only the owner adds identities) and
 * the directory (each new leaf certified by a device of the verified list)
 * run as for any Commit; a Commit that lost its epoch is rebuilt on the
 * winner with the same KeyPackages. A rotation a removal left due rides
 * along.
 */
export function addInvitee(
  ctx: ProjectGroupContext,
  projectId: string,
  invitee: InviteeAddition
): Promise<ProjectGroupState> {
  if (invitee.list.userId !== invitee.userId) {
    return Promise.reject(
      new ProjectGroupError(
        'server-mismatch',
        'The invitee’s device list is another account’s.'
      )
    );
  }
  if (invitee.keyPackages.length === 0) {
    return Promise.reject(
      new ProjectGroupError('key-missing', 'The invitee has no KeyPackage.')
    );
  }
  return commitLoop(ctx, projectId, async (status, group) => {
    const rotation = await rotationRequest(ctx, projectId, status, group);
    const request: CommitRequest = {
      add: invitee.keyPackages.map((entry) => entry.keyPackage),
      setRoles: [{ userId: invitee.userId, role: invitee.role }],
      ...(rotation?.remove?.length ? { remove: rotation.remove } : {})
    };
    return { request, rotation: rotation !== null, invitee };
  });
}

const isPolicyRefusal = (error: unknown, code: string) =>
  error instanceof Error &&
  error.name === 'MlsError' &&
  (error as { kind?: unknown }).kind === 'policy' &&
  ((error as { reasons?: { code?: unknown }[] }).reasons ?? []).some(
    (reason) => reason.code === code
  );

/** Sessions proven to belong to the server's current group generation. */
const currentGenerations = new Set<string>();

/**
 * After a reset (generation > 0) a session from an earlier group would read
 * the new group's epochs as its own: its epoch authenticator must match the
 * one the key archive of its key epoch records.
 */
async function requireCurrentGeneration(
  ctx: ProjectGroupContext,
  ref: MlsProjectRef,
  group: E2eeProjectGroupRecord,
  epoch: number
): Promise<void> {
  if (group.generation === 0) return;
  const stale = () =>
    new ProjectGroupError(
      'no-session',
      'This device’s encryption state is from before the project’s group was reset.'
    );
  if (epoch > group.epoch) throw stale();
  const keyEpoch = group.keyEpochBase + epoch;
  const id = JSON.stringify([
    ref.userId,
    ref.projectId,
    group.groupId,
    keyEpoch
  ]);
  if (currentGenerations.has(id)) return;
  const own = (await ctx.sessions.epochMaterial(ref)).epochAuthenticator;
  const recorded = await epochAuthenticatorForEpoch(
    ctx,
    ref.projectId,
    keyEpoch
  ).catch(() => null);
  if (!recorded || !sameBytes(own, recorded)) throw stale();
  currentGenerations.add(id);
}

/**
 * A Commit the policy refused because a revoked device signed it. One sent
 * before the epoch the removal's rotation was made in is history this state
 * can no longer process: the device rejoins from the key archives
 * (`no-session`). One sent in or after that epoch is a removed device's
 * later Commit, and is refused (`removed-device`).
 */
async function revokedCommitter(
  ctx: ProjectGroupContext,
  projectId: string,
  group: E2eeProjectGroupRecord,
  commit: E2eeMlsCommitRecord
): Promise<ProjectGroupError> {
  const cutoffs = await projectRevocationCutoffs(ctx, projectId, group);
  const cutoff = commit.senderDeviceId
    ? cutoffs.get(commit.senderDeviceId)
    : undefined;
  if (
    cutoff?.signed &&
    group.keyEpochBase + commit.epoch < cutoff.keyEpoch - 1
  ) {
    return new ProjectGroupError(
      'no-session',
      'This device must rejoin the project: it missed Commits from a device that has since been removed.'
    );
  }
  return new ProjectGroupError(
    'removed-device',
    `The server delivered a Commit for epoch ${commit.epoch} signed by a removed device. It was refused.`
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
    await requireCurrentGeneration(ctx, ref, group, epoch);
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
    const directory = await directoryFor(ctx, projectId, group);
    for (const commit of page.commits) {
      if (commit.epoch !== epoch) {
        throw new ProjectGroupError(
          'server-mismatch',
          `The server skipped from epoch ${epoch} to ${commit.epoch}.`
        );
      }
      let processed;
      try {
        processed = await ctx.sessions.process(
          ref,
          directory,
          bytes(commit.message)
        );
      } catch (error) {
        if (isPolicyRefusal(error, 'credential-revoked')) {
          throw await revokedCommitter(ctx, projectId, group, commit);
        }
        throw error;
      }
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
      await afterProcessed(ctx, ref, projectId, group.keyEpochBase, commit);
    }
    if (!page.more) group = await fetchGroup(ctx, projectId);
  }
}

/**
 * After a processed Commit: remember the new epoch's roles as this
 * device's own session holds them (what `epochRoles` then answers), and,
 * when someone else sent it, post this account's own wraps of the new
 * epoch's project key and rejoin PSK (slice 5-2, decision D1), so its other
 * devices can read and rejoin. The wraps are best effort: the Commit is
 * processed either way, and another device of the account that later
 * processes a Commit posts its own epoch's.
 */
async function afterProcessed(
  ctx: ProjectGroupContext,
  ref: MlsProjectRef,
  projectId: string,
  keyEpochBase: number,
  commit: E2eeMlsCommitRecord
): Promise<void> {
  const status = await ctx.sessions.status(ref);
  if (status.epoch === null) return;
  const keyEpoch = keyEpochBase + status.epoch;
  if (status.roles) {
    knownRoles.set(rolesId(ctx, projectId, keyEpoch), status.roles);
  }
  if (commit.senderUserId === ctx.account.userId || !ctx.api.postKeys) return;
  try {
    await postOwnEpochKeys(
      ctx,
      projectId,
      keyEpoch,
      await ctx.sessions.epochMaterial(ref)
    );
  } catch {
    // Best effort, as above.
  }
}

/**
 * Wraps `keyEpoch`'s project key and rejoin PSK under this account's
 * current account key and posts them as its own (`POST …/keys`, slice
 * 5-2). The server keeps a wrap already stored for that epoch.
 */
export async function postOwnEpochKeys(
  ctx: ProjectGroupContext,
  projectId: string,
  keyEpoch: number,
  material: { readonly projectKey: Uint8Array; readonly rejoinPsk: RejoinPsk }
): Promise<void> {
  const device = requireDevice(ctx);
  if (!ctx.api.postKeys) {
    throw new ProjectGroupError(
      'server-mismatch',
      'This server cannot store a member’s own keys.'
    );
  }
  const wraps = await wrapEpochKeys(
    ctx,
    projectId,
    keyEpoch,
    material.projectKey,
    material.rejoinPsk
  );
  rememberProjectKey(
    ctx.account.userId,
    projectId,
    keyEpoch,
    material.projectKey
  );
  await ctx.api.postKeys(projectId, {
    deviceId: device.deviceId,
    keyEpoch,
    wraps
  });
}

// --- Roles of an epoch (slice 5-2) ------------------------------------------

/** Roles this page verified, by account, project and key epoch. */
const knownRoles = new Map<string, ProjectRoles>();
const rolesId = (
  ctx: ProjectGroupContext,
  projectId: string,
  keyEpoch: number
) => JSON.stringify([ctx.account.userId, projectId, keyEpoch]);

/**
 * The MLS roles the project's group held in `keyEpoch` (slice 5-2): what
 * this device's own session held when it reached that epoch, or the
 * roles extension of the GroupContext in that epoch's key archive record,
 * verified (signed by a member's device, opened under the epoch's project
 * key and bound to its epoch authenticator) and checked to be this
 * project's group at that epoch. Versions are tied to MLS authority by
 * the role their author held in their own epoch.
 */
export async function epochRoles(
  ctx: ProjectGroupContext,
  projectId: string,
  keyEpoch: number
): Promise<ProjectRoles> {
  const id = rolesId(ctx, projectId, keyEpoch);
  const known = knownRoles.get(id);
  if (known) return known;
  const { keyEpochBase, current } = await groupBaseForKeyEpoch(
    ctx,
    projectId,
    keyEpoch
  );
  const epoch = keyEpoch - keyEpochBase;
  if (current && ctx.device) {
    const ref = refOf(ctx, ctx.device, projectId);
    const status = (await ctx.sessions.leaf(ref))
      ? await ctx.sessions.status(ref).catch(() => null)
      : null;
    if (status?.inGroup && status.epoch === epoch && status.roles) {
      knownRoles.set(id, status.roles);
      return status.roles;
    }
  }
  const invalid = (why: string): never => {
    throw new ProjectGroupError(
      'archive-invalid',
      `The key archive of epoch ${keyEpoch} ${why}.`
    );
  };
  const body = await openArchive(
    ctx,
    projectId,
    keyEpoch,
    await projectKeyForEpoch(ctx, projectId, keyEpoch),
    await fetchArchive(ctx, projectId, keyEpoch)
  );
  let parsed: EpochContext;
  try {
    parsed = parseEpochContext(
      (await ctx.sessions.decodeEpochRecord(body.epochRecord)).groupContext
    );
  } catch {
    return invalid('carries no readable roles');
  }
  if (
    parsed.epoch !== epoch ||
    !sameBytes(parsed.groupId, projectGroupId(projectId))
  ) {
    invalid('records another group or epoch');
  }
  knownRoles.set(id, parsed.roles);
  return parsed.roles;
}

export type Recovery = 'none' | 'confirmed' | 'discarded' | 'resent';

/**
 * Resolve a Commit (or rejoin) that a crash, a reload or a lost response
 * left pending: confirm it when the server's winner for its epoch is this
 * very Commit; otherwise discard it (the next catch-up processes the
 * winner). A member's Commit nobody ruled on is sent again, unless a
 * removal has made a rotation due since it was built: then it is dropped,
 * so the next Commit carries the rotation. A rejoin nobody ruled on is
 * discarded, since its epoch record lived only in memory, and the next
 * join builds a fresh one.
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
  // An Add (it carries a Welcome) is never sent again without the
  // invitation and KeyPackages it states (slice 5-3b): the owner's next
  // completion builds it afresh from the claim. Nor is a role change
  // without the change it states (slice 5-4).
  const directory = await directoryFor(ctx, projectId, group);
  if (
    pending.welcome ||
    (await rotationRequest(ctx, projectId, status, group)) ||
    (await changesRoles(ctx, ref, status, directory))
  ) {
    await ctx.sessions.discardCommit(ref);
    return 'discarded';
  }
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

// --- Solo group reset (decision D9) ----------------------------------------

/**
 * The plain words the owner confirms before a reset (ADR-024: the user must
 * confirm, in plain words, that the project has no collaborators).
 */
export const GROUP_RESET_CONFIRMATION =
  'Nobody else has access to this project. Reset its encryption group.';

export interface GroupResetAuthority {
  /** The identity generation of the account's device list. */
  readonly generation: number;
  /** Signs the reset with the identity key (`signGroupReset`). */
  sign(reset: GroupReset): Promise<SignedStatement>;
}

/** The roles the newest group state this device can find lists. */
async function newestRoles(
  ctx: ProjectGroupContext,
  ref: MlsProjectRef,
  group: E2eeProjectGroupRecord
): Promise<{ roles: ProjectRoles | null; others: boolean }> {
  const ownUser = ctx.account.userId;
  const summary = await ctx.sessions.inspectGroupInfo(
    ref,
    bytes(group.groupInfo)
  );
  let roles = summary.roles;
  let others = summary.members.some((member) => member.userId !== ownUser);
  // This device's own verified state, when it still holds the group.
  if (await ctx.sessions.leaf(ref)) {
    const status = await ctx.sessions.status(ref).catch(() => null);
    if (status?.roles) roles = status.roles;
    if (status?.members.some((member) => member.userId !== ownUser)) {
      others = true;
    }
  }
  return { roles, others };
}

/** Every project key up to `keyEpoch`, from the account wraps and archives. */
async function carriedKeys(
  ctx: ProjectGroupContext,
  projectId: string,
  keyEpoch: number
): Promise<Map<number, Uint8Array>> {
  const keys = new Map<number, Uint8Array>();
  const newest = await projectKeyForEpoch(ctx, projectId, keyEpoch);
  keys.set(keyEpoch, newest);
  try {
    const body = await openArchive(
      ctx,
      projectId,
      keyEpoch,
      newest,
      await fetchArchive(ctx, projectId, keyEpoch)
    );
    for (const k of body.previousKeys) keys.set(k.keyEpoch, k.key);
  } catch {
    // Fall back to each epoch's own wrap below.
  }
  for (let epoch = 0; epoch < keyEpoch; epoch++) {
    if (keys.has(epoch)) continue;
    keys.set(epoch, await projectKeyForEpoch(ctx, projectId, epoch));
  }
  return keys;
}

/**
 * Replace a solo project's MLS group (ADR-024, "The user is the only
 * member"; decision D9). Only the owner, only while the roles extension
 * and the group list nobody else, and only after the owner confirmed the
 * plain-words statement. The identity key signs the reset; the server
 * moves the group to the next generation with a key-epoch base right after
 * the old group's newest key epoch (decision D10), and this device creates
 * the new epoch 0. Every earlier project key, opened from the account-key
 * wraps, is carried into the new epoch's key archive, so old versions stay
 * readable; the version chain continues under the new group's epochs.
 *
 * A reset is a recovery tool: a compromised server could show an epoch
 * from before collaborators joined, and the reset would fork the project
 * away from them. It claims nothing stronger.
 */
export async function resetProjectGroup(
  ctx: ProjectGroupContext,
  projectId: string,
  authority: GroupResetAuthority,
  confirmation: string
): Promise<ProjectGroupState> {
  const refuse = (message: string): never => {
    throw new ProjectGroupError('reset-refused', message);
  };
  if (confirmation !== GROUP_RESET_CONFIRMATION) {
    refuse('Confirm that nobody else has access to this project first.');
  }
  const resetGroup = ctx.api.resetGroup;
  if (!resetGroup) refuse('This build cannot reset encryption groups.');
  const device = requireDevice(ctx);
  const ref = refOf(ctx, device, projectId);
  const group = await fetchGroup(ctx, projectId);
  const { leaves } = await ctx.api.leaves(projectId);
  if (leaves.some((leaf) => leaf.userId !== ctx.account.userId)) {
    refuse('Another account holds a key in this project.');
  }
  const { roles, others } = await newestRoles(ctx, ref, group);
  if (
    others ||
    !roles ||
    roles.users.length !== 1 ||
    roles.users[0]!.userId !== ctx.account.userId ||
    roles.users[0]!.role !== 'owner'
  ) {
    refuse('Only a project whose only member is you can be reset.');
  }
  const priorKeyEpoch = group.keyEpochBase + group.epoch;
  const keys = await carriedKeys(ctx, projectId, priorKeyEpoch);
  const head = ctx.account.list.entries.at(-1)!;
  const signed = await authority.sign({
    userId: ctx.account.userId,
    generation: authority.generation,
    entrySequence: head.entry.sequence,
    entryHash: head.hash,
    projectId,
    priorGroupGeneration: group.generation,
    priorKeyEpoch,
    issuedAt: Date.now()
  });
  const change = await ctx.sessions.createGroup(
    ref,
    device,
    {
      lists: [ctx.account.list],
      certifications: [],
      revocationCutoffs: newGroupCutoffs(ctx)
    },
    { replace: true }
  );
  if (!change.epochRecord) {
    throw new Error('A new MLS group produced no epoch record.');
  }
  const material = await ctx.sessions.epochMaterial(ref);
  const leaf = (await ctx.sessions.leaf(ref))!;
  const keyEpoch = priorKeyEpoch + 1;
  const archive = await sealArchive(
    device,
    projectId,
    keyEpoch,
    material.projectKey,
    {
      previousKeys: previousKeysOf(keys, keyEpoch),
      // Whoever lost access may know the old one (decision D8).
      dedupeSecret: generateAssetDedupeSecret(),
      epochRecord: change.epochRecord,
      epochAuthenticator: material.epochAuthenticator
    }
  );
  const { group: next } = await resetGroup!(projectId, {
    statement: b64(signed.statement),
    signature: b64(signed.signature),
    groupId: `grp_${toHexId()}`,
    deviceId: device.deviceId,
    groupInfo: b64(material.groupInfo),
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
  return stateOf(next);
}

/**
 * The key-epoch base of the group generation that wrote `keyEpoch`, and
 * whether that is the current group: versions written before a reset name
 * epochs of an earlier group. Earlier bases come from the recorded resets,
 * each checked against its signed statement (verified by the identity key
 * when it is of the current identity generation).
 */
export async function groupBaseForKeyEpoch(
  ctx: ProjectGroupContext,
  projectId: string,
  keyEpoch: number
): Promise<{ keyEpochBase: number; current: boolean }> {
  const group = await fetchGroup(ctx, projectId);
  if (keyEpoch >= group.keyEpochBase) {
    return { keyEpochBase: group.keyEpochBase, current: true };
  }
  const bases = [0];
  const { resets } = ctx.api.resets
    ? await ctx.api.resets(projectId)
    : { resets: [] };
  for (const reset of resets) {
    const signed = {
      statement: bytes(reset.statement),
      signature: bytes(reset.signature)
    };
    const value =
      reset.identityGeneration === currentGeneration(ctx)
        ? await verifyGroupReset(signed, ctx.account.list, {
            generation: reset.identityGeneration
          }).catch(() => null)
        : null;
    if (
      value &&
      value.projectId === projectId &&
      value.priorKeyEpoch + 1 === reset.keyEpochBase &&
      value.priorGroupGeneration + 1 === reset.generation
    ) {
      bases.push(reset.keyEpochBase);
    }
  }
  const keyEpochBase = Math.max(...bases.filter((base) => base <= keyEpoch));
  return { keyEpochBase, current: false };
}
