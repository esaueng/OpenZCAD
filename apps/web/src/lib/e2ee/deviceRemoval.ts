/**
 * Device removal across encrypted projects (ADR-024 Phase 4, slice 4-10,
 * and Phase 5, slice 5-7, for shared ones; roadmap L11), the browser's part:
 *
 * - **Statements.** `revocationStatements` fetches this account's
 *   identity-signed revocation cutoff statements and verifies each against
 *   the account's pinned device list before `projectGroups.ts` uses it, for
 *   the MLS directory (rejoin PSK freshness, the last-leaf exception) and
 *   for version authorship (a revoked device's versions only up to its
 *   cutoff head and below its cutoff key epoch).
 * - **The removal's participant step.** `removalParticipant` plugs into
 *   `removeDevice`, `revokeReadOnlyDevices` and `removePasskey`. Before the
 *   identity key signs anything it catches every project up and refuses a
 *   removal it could not finish (encrypted projects but no cutoff storage,
 *   migration 0036). Once the new device list is accepted it signs, with
 *   the identity key the removal already opened, a cutoff for every
 *   encrypted project the account belongs to, owned or (slice 5-7) shared
 *   with it as an editor or a viewer (the next key epoch, and the newest
 *   head), stores it, and rotates each project: a Remove of the revoked
 *   device's leaves (the policy lets any member remove its own identity's
 *   leaves) or an empty Commit, the new epoch's project key and rejoin PSK
 *   under the new account key, and a key archive with a new dedupe secret
 *   (D8). A shared project's other members post their own wraps of the new
 *   epoch when they process the Commit, and read the account's statement
 *   (`GET /api/e2ee/projects/:id/revocation-cutoffs`) to refuse the removed
 *   device's later Commits and versions while still reading its earlier
 *   ones. A rotation that landed later than predicted is re-signed.
 *   Projects it cannot rotate (this device holds no leaf and is not the
 *   named replacement) are left to the other devices, whose writers rotate
 *   before their next write.
 */
import {
  fromBase64Url,
  fromHex,
  signRevocationCutoffs,
  toBase64Url,
  toHex,
  verifyRevocationCutoffs,
  type ProjectRevocationCutoff,
  type RevocationCutoffs,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import type {
  E2eeRemovalProjectRecord,
  E2eeRevocationCutoffRequest,
  E2eeRevocationCutoffResponse,
  E2eeRevocationCutoffsResponse,
  ListProjectsResponse
} from '@openzcad/shared';
import { desktopFetch } from '../desktopBridge';
import type { AccountView } from './accountKeys';
import { E2eeApiError } from './e2eeApi';
import {
  catchUpProjectGroup,
  joinProjectGroup,
  ProjectGroupApiError,
  type ProjectGroupContext,
  type RevocationStatements
} from './projectGroups';
import type { VersionPinStore } from './versionPins';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// --- API -------------------------------------------------------------------

export interface RevocationCutoffsApi {
  list(): Promise<E2eeRevocationCutoffsResponse>;
  store(
    request: E2eeRevocationCutoffRequest
  ): Promise<E2eeRevocationCutoffResponse>;
  /** Whether the account has any encrypted (format 2) project, owned or shared. */
  ownsEncryptedProjects(): Promise<boolean>;
}

// --- Statements not stored yet ----------------------------------------------

/**
 * Signed cutoff statements this browser could not store yet, per account.
 * Only the identity key the removal opened can sign one, and the device
 * list already revokes the device, so a statement whose store failed is
 * kept here and sent again rather than lost: without it the removed
 * device's earlier versions stay refused (revoked without a cutoff).
 */
export interface PendingCutoffStore {
  read(userId: string): E2eeRevocationCutoffRequest[];
  /** Keeps `request`, replacing an older one for the same entry. */
  save(userId: string, request: E2eeRevocationCutoffRequest): void;
  forget(userId: string, request: E2eeRevocationCutoffRequest): void;
}

const PENDING_KEY = (userId: string) =>
  `openzcad:e2ee-pending-cutoffs:v1:${userId}`;

const sameEntry = (
  a: E2eeRevocationCutoffRequest,
  b: E2eeRevocationCutoffRequest
) => a.generation === b.generation && a.entrySequence === b.entrySequence;

/** In localStorage: the statements name projects and hashes, no secrets. */
export function localPendingCutoffs(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null =
    typeof window === 'undefined' ? null : window.localStorage
): PendingCutoffStore {
  const read = (userId: string): E2eeRevocationCutoffRequest[] => {
    try {
      const parsed: unknown = JSON.parse(
        storage?.getItem(PENDING_KEY(userId)) ?? '[]'
      );
      return Array.isArray(parsed)
        ? (parsed as E2eeRevocationCutoffRequest[])
        : [];
    } catch {
      return [];
    }
  };
  const write = (userId: string, requests: E2eeRevocationCutoffRequest[]) => {
    try {
      if (requests.length === 0) storage?.removeItem(PENDING_KEY(userId));
      else storage?.setItem(PENDING_KEY(userId), JSON.stringify(requests));
    } catch {
      // Blocked storage keeps nothing; the removal reports the failure.
    }
  };
  return {
    read,
    save(userId, request) {
      write(userId, [
        ...read(userId).filter((r) => !sameEntry(r, request)),
        request
      ]);
    },
    forget(userId, request) {
      write(
        userId,
        read(userId).filter(
          (r) => !(sameEntry(r, request) && r.statement === request.statement)
        )
      );
    }
  };
}

export function memoryPendingCutoffs(): PendingCutoffStore {
  const kept = new Map<string, E2eeRevocationCutoffRequest[]>();
  return {
    read: (userId) => [...(kept.get(userId) ?? [])],
    save(userId, request) {
      kept.set(userId, [
        ...(kept.get(userId) ?? []).filter((r) => !sameEntry(r, request)),
        request
      ]);
    },
    forget(userId, request) {
      kept.set(
        userId,
        (kept.get(userId) ?? []).filter(
          (r) => !(sameEntry(r, request) && r.statement === request.statement)
        )
      );
    }
  };
}

/**
 * Sends every statement this browser kept for the account. A stored one,
 * or one the account already holds a newer statement for, is forgotten;
 * anything else stays for the next try. Resolves to how many remain.
 */
export async function storePendingCutoffs(
  api: RevocationCutoffsApi,
  pending: PendingCutoffStore,
  userId: string
): Promise<number> {
  for (const request of pending.read(userId)) {
    try {
      await api.store(request);
      pending.forget(userId, request);
    } catch (error) {
      if (
        error instanceof ProjectGroupApiError &&
        error.code === 'E2EE_CUTOFF_REGRESSION'
      ) {
        pending.forget(userId, request);
      }
    }
  }
  return pending.read(userId).length;
}

export function createRevocationCutoffsApi(
  fetcher: Fetch = desktopFetch
): RevocationCutoffsApi {
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
  return {
    list: () => call('/api/e2ee/revocation-cutoffs'),
    store: (request) => call('/api/e2ee/revocation-cutoffs', 'PUT', request),
    async ownsEncryptedProjects() {
      const { projects } = await call<ListProjectsResponse>('/api/projects');
      return projects.some((project) => project.storageFormat === 2);
    }
  };
}

// --- Verified statements ---------------------------------------------------

const unavailable = (error: unknown) =>
  error instanceof E2eeApiError &&
  (error.status === 501 || error.status === 503 || error.status === 404);

/** Encrypted projects are off for this account (or this server has none). */
const projectsOff = (error: unknown) =>
  error instanceof E2eeApiError &&
  (error.status === 501 || error.status === 404);

/**
 * This account's cutoff statements of the current identity generation,
 * each verified against `list`. One that does not verify is left out, so
 * its devices have no cutoff and are refused, never trusted. Without the
 * routes (flag off, migration 0036 missing) there are none. Cached per
 * device-list head; `forget()` drops the cache after a write.
 */
export function revocationStatements(
  api: RevocationCutoffsApi,
  account: {
    readonly list: VerifiedDeviceList;
    readonly generation?: number;
  }
): RevocationStatements & { forget(): void } {
  let cached: Promise<readonly RevocationCutoffs[]> | null = null;
  const load = async (): Promise<readonly RevocationCutoffs[]> => {
    const generation = account.generation ?? 1;
    let records: E2eeRevocationCutoffsResponse['statements'];
    try {
      records = (await api.list()).statements;
    } catch (error) {
      if (unavailable(error)) return [];
      throw error;
    }
    const verified: RevocationCutoffs[] = [];
    for (const record of records) {
      if (record.generation !== generation) continue;
      const value = await verifyRevocationCutoffs(
        {
          statement: fromBase64Url(record.statement),
          signature: fromBase64Url(record.signature)
        },
        account.list,
        { generation }
      ).catch(() => null);
      if (value) verified.push(value);
    }
    return verified;
  };
  return {
    verified() {
      cached ??= load().catch((error: unknown) => {
        cached = null;
        throw error;
      });
      return cached;
    },
    forget() {
      cached = null;
    }
  };
}

// --- The participant step ----------------------------------------------------

export type RemovalKind = 'device' | 'passkey' | 'read-only';

/** What a removal knows once its device-list entry is written. */
export interface WrittenRemovalStep {
  readonly kind: RemovalKind;
  readonly identityPrivateKey: CryptoKey;
  readonly userId: string;
  readonly generation: number;
  readonly written: { readonly sequence: number; readonly hash: Uint8Array };
}

export interface RemovalStep {
  readonly kind: RemovalKind;
  /** The identity key the removal opened, for signing the cutoffs. */
  readonly identityPrivateKey: CryptoKey;
  /** The account after the removal: the new device list and account key. */
  readonly account: AccountView;
  /**
   * The device-list entry this removal appended. Its cutoffs name it, not
   * the reloaded head, which another device may have moved on since.
   */
  readonly written: { readonly sequence: number; readonly hash: Uint8Array };
}

export interface RemovalOutcome {
  /** Projects this device rotated past the removal (or found rotated). */
  readonly rotated: readonly string[];
  /** Projects left to the other devices, with why. */
  readonly left: readonly { projectId: string; reason: string }[];
  /** True once the identity-signed cutoffs are stored (device removals). */
  readonly cutoffsStored: boolean;
}

export interface RemovalParticipant {
  /**
   * Before anything is signed: refuse a removal that could not be finished
   * and bring every project this device holds up to date.
   */
  prepare(account: AccountView): Promise<void>;
  /**
   * Right after the device list is written, before the account is read
   * again: signs the cutoffs from what `prepare` listed and keeps them
   * (`PendingCutoffStore`), with no request, so a removal whose reload
   * fails still leaves a statement to store. Never throws.
   */
  written?(step: WrittenRemovalStep): Promise<void>;
  /** After the new device list is accepted; never throws. */
  complete(step: RemovalStep): Promise<RemovalOutcome>;
}

export class DeviceRemovalError extends Error {
  override readonly name = 'DeviceRemovalError';
  constructor(
    readonly code: 'storage-unavailable',
    message: string
  ) {
    super(message);
  }
}

export interface RemovalParticipantOptions {
  readonly api?: RevocationCutoffsApi;
  /** The project-groups context for an account view. */
  groups(account: AccountView): ProjectGroupContext;
  /** This browser's accepted heads, if it keeps any. */
  readonly pins?: VersionPinStore;
  /** Statements whose store failed, sent again later; localStorage by default. */
  readonly pending?: PendingCutoffStore;
  readonly now?: () => number;
  /** Told the outcome of every completed removal. */
  readonly onOutcome?: (outcome: RemovalOutcome) => void;
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The newest head the removing browser knows for a project: its pin, or
 * the server's head when that is newer (the revocation is stored by now,
 * so the server accepts nothing more from the removed device, and its
 * earlier versions stay readable). At the same version the pin wins: a
 * server head that differs there is a fork this browser never accepted,
 * and the cutoff must not sign it in.
 */
export async function cutoffHead(
  pins: VersionPinStore | undefined,
  userId: string,
  project: E2eeRemovalProjectRecord
): Promise<ProjectRevocationCutoff['head']> {
  const pin = await pins?.read(userId, project.projectId).catch(() => null);
  const server = project.head;
  if (
    pin?.headHash &&
    (!server || pin.documentVersion >= server.documentVersion)
  ) {
    return {
      documentVersion: pin.documentVersion,
      versionHash: fromHex(pin.headHash)
    };
  }
  return server
    ? {
        documentVersion: server.documentVersion,
        versionHash: fromHex(server.versionHash)
      }
    : undefined;
}

export function removalParticipant(
  options: RemovalParticipantOptions
): RemovalParticipant {
  const api = options.api ?? createRevocationCutoffsApi();
  const pending = options.pending ?? localPendingCutoffs();
  // What `prepare` listed, for `written` to sign without a request.
  let listed: E2eeRemovalProjectRecord[] | null = null;
  const now = options.now ?? Date.now;
  return {
    async prepare(account) {
      // A statement an earlier removal could not store goes first.
      await storePendingCutoffs(api, pending, account.userId).catch(
        () => undefined
      );
      listed = null;
      let projects: E2eeRemovalProjectRecord[];
      try {
        projects = (await api.list()).projects;
      } catch (error) {
        if (projectsOff(error)) return;
        if (!unavailable(error)) throw error;
        // The routes exist but their storage does not (migration 0036):
        // a removal could not rotate any encrypted project.
        if (await api.ownsEncryptedProjects().catch(() => true)) {
          throw new DeviceRemovalError(
            'storage-unavailable',
            'Removing a device from an account with encrypted projects needs a server update that is not available yet. Nothing was changed.'
          );
        }
        return;
      }
      listed = projects;
      // Up to date before the revocation, while the removed device's
      // Commits still process: afterwards the policy refuses them.
      const groups: ProjectGroupContext = {
        ...options.groups(account),
        revocations: revocationStatements(api, account)
      };
      if (!groups.device) return;
      for (const project of projects) {
        await catchUpProjectGroup(groups, project.projectId).catch(
          () => undefined
        );
      }
    },

    async written(step) {
      if (step.kind !== 'device' || !listed?.length) return;
      try {
        // Listed again now: the device list already revokes the device, so
        // its Commits are fenced off and these epochs are past anything it
        // committed. Only when that request fails does the listing from
        // before the identity key was opened stand in.
        const current = await api
          .list()
          .then((answer) => answer.projects)
          .catch(() => listed!);
        const cutoffs: ProjectRevocationCutoff[] = [];
        for (const project of current) {
          const head = await cutoffHead(options.pins, step.userId, project);
          cutoffs.push({
            projectId: project.projectId,
            cutoffEpoch: project.keyEpochBase + project.epoch + 1,
            ...(head ? { head } : {})
          });
        }
        const signed = await signRevocationCutoffs(step.identityPrivateKey, {
          userId: step.userId,
          generation: step.generation,
          entrySequence: step.written.sequence,
          entryHash: step.written.hash,
          issuedAt: now(),
          cutoffs
        });
        // Kept, not sent: `complete` signs again from a fresh listing and
        // replaces it; if it never runs, the next removal or page open
        // stores this one.
        pending.save(step.userId, {
          generation: step.generation,
          entrySequence: step.written.sequence,
          statement: toBase64Url(signed.statement),
          signature: toBase64Url(signed.signature)
        });
      } catch {
        // Nothing kept; `complete` signs from its own listing.
      }
    },

    async complete(step) {
      const rotated: string[] = [];
      const left: { projectId: string; reason: string }[] = [];
      let cutoffsStored = false;
      const outcome = () => {
        const result = { rotated, left, cutoffsStored };
        options.onOutcome?.(result);
        return result;
      };
      const statements = revocationStatements(api, step.account);
      const groups: ProjectGroupContext = {
        ...options.groups(step.account),
        revocations: statements
      };
      let projects: E2eeRemovalProjectRecord[];
      try {
        projects = (await api.list()).projects;
      } catch (error) {
        if (!projectsOff(error)) {
          left.push({ projectId: '*', reason: describe(error) });
        }
        return outcome();
      }
      const list = step.account.list;
      const revoking = list.entries.find(
        (e) =>
          e.entry.sequence === step.written.sequence &&
          toHex(e.hash) === toHex(step.written.hash)
      );
      if (!revoking) {
        // The list no longer holds the entry (the identity was replaced
        // meanwhile): nothing here can name it.
        left.push({
          projectId: '*',
          reason: 'The device list moved on before this removal finished.'
        });
        return outcome();
      }
      const signs =
        step.kind === 'device' &&
        revoking.entry.revoked.some((r) => r.kind === 'device');
      const predicted = new Map<string, ProjectRevocationCutoff>();
      const store = async (cutoffs: ProjectRevocationCutoff[]) => {
        const signed = await signRevocationCutoffs(step.identityPrivateKey, {
          userId: step.account.userId,
          generation: step.account.generation,
          entrySequence: revoking.entry.sequence,
          entryHash: revoking.hash,
          issuedAt: now(),
          cutoffs
        });
        const request = {
          generation: step.account.generation,
          entrySequence: revoking.entry.sequence,
          statement: toBase64Url(signed.statement),
          signature: toBase64Url(signed.signature)
        };
        // Kept before it is sent: the device list already revokes the
        // device, and only this identity key can sign the statement.
        pending.save(step.account.userId, request);
        await api.store(request);
        pending.forget(step.account.userId, request);
        statements.forget();
        cutoffsStored = true;
      };
      if (signs) {
        for (const project of projects) {
          const head = await cutoffHead(
            options.pins,
            step.account.userId,
            project
          );
          predicted.set(project.projectId, {
            projectId: project.projectId,
            // The next epoch: the rotation's, which the revoked device
            // never learns.
            cutoffEpoch: project.keyEpochBase + project.epoch + 1,
            ...(head ? { head } : {})
          });
        }
        try {
          await store([...predicted.values()]);
        } catch (error) {
          // Without cutoffs nobody can rotate: every device refuses the
          // revoked device's directory entry. The signed statement is kept
          // on this device and sent again (`storePendingCutoffs`) before the
          // next removal and whenever this page opens encrypted projects.
          left.push(
            ...projects.map((p) => ({
              projectId: p.projectId,
              reason: describe(error)
            }))
          );
          return outcome();
        }
      }
      const corrected = new Map(predicted);
      for (const project of projects) {
        try {
          if (!groups.device) {
            left.push({
              projectId: project.projectId,
              reason: 'This device holds no leaf in encrypted projects.'
            });
            continue;
          }
          if (project.trashed) {
            // Nobody commits to a trashed project; its cutoff is signed,
            // and the next writer rotates it once it is restored.
            left.push({
              projectId: project.projectId,
              reason: 'In the recycle bin: rotated once it is restored.'
            });
            continue;
          }
          const state = await joinProjectGroup(groups, project.projectId);
          rotated.push(project.projectId);
          const named = predicted.get(project.projectId);
          if (named && state.keyEpoch > named.cutoffEpoch) {
            // Another Commit came first: the rotation landed later.
            corrected.set(project.projectId, {
              ...named,
              cutoffEpoch: state.keyEpoch
            });
          }
        } catch (error) {
          left.push({ projectId: project.projectId, reason: describe(error) });
        }
      }
      if (
        signs &&
        [...corrected].some(
          ([id, c]) => c.cutoffEpoch !== predicted.get(id)!.cutoffEpoch
        )
      ) {
        await store([...corrected.values()]).catch((error: unknown) =>
          left.push({ projectId: '*', reason: describe(error) })
        );
      }
      return outcome();
    }
  };
}
