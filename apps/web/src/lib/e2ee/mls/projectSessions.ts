/**
 * This device's MLS sessions, one per encrypted project (ADR-024 Phase 3,
 * "MLS client in the app"). Every operation:
 *
 * 1. takes the project's cross-tab lock (`MlsSessionStore.withProjectLock`);
 * 2. re-reads the stored revision and reopens the sealed session if another
 *    tab moved it on since this tab last held it;
 * 3. installs the verified device directory (`buildDeviceDirectory`) before
 *    any operation the policy checks;
 * 4. after a change, seals the session in the Worker and writes it with
 *    compare-and-swap on the revision, before anything is returned to send.
 *
 * A failed operation drops the in-memory session, which may be ahead of
 * what was stored, so the next one starts from storage. Key-session
 * teardown (sign-out, expiry, another account, a teardown in another tab)
 * frees every session, forgets the state keys and stops the Worker; an
 * operation in flight then fails instead of writing.
 *
 * Only types come from `@openzcad/mls` here: the package itself loads with
 * the Worker (`loader.ts`).
 */
import type {
  CommitRequest,
  DeviceDirectory,
  EpochChange,
  EpochRecord,
  GroupInfoSummary,
  Mls,
  MlsSession,
  PendingCommit,
  Processed,
  RejoinPsk,
  RejoinRequest,
  RejoinResult,
  SessionStatus
} from '@openzcad/mls';
import {
  getKeySessionRevision,
  isCurrentKeySession,
  subscribeKeySession
} from '../keySession';
import {
  certifyLeaf,
  verifyLeafCertification,
  type CertifyingDevice,
  type LeafCertificationClaim,
  type VerifiedLeafCertification
} from './certify';
import { buildDeviceDirectory, type DirectoryInput } from './directory';
import { mlsLoader, type MlsLoader } from './loader';
import {
  indexedDbMlsSessionStore,
  MlsSessionConflict,
  type MlsSessionStore,
  type StoredLeaf,
  type StoredMlsSession,
  type StoredPendingCommit
} from './sessionStore';

export interface RejoinOptions {
  /**
   * Revoked devices whose revocation named this device as replacement: when
   * this device has no stale leaf of its own, the external Commit removes a
   * leaf of one of them (the MLS last-leaf exception).
   */
  readonly replaceDevices?: readonly string[];
  /** Overwrite stored state that can no longer follow the group. */
  readonly fresh?: boolean;
}

/** Which device's state for which project. */
export interface MlsProjectRef {
  readonly userId: string;
  readonly deviceId: string;
  readonly projectId: string;
}

export class MlsSessionMissing extends Error {
  override readonly name = 'MlsSessionMissing';
  constructor() {
    super('This device has no encryption state for the project.');
  }
}

interface Entry {
  readonly session: MlsSession;
  revision: number;
  /**
   * The stored session's leaf. Revisions restart at 1 after a session is
   * discarded, so a new session (always a new leaf) at the revision this
   * page cached is told apart by its leaf.
   */
  readonly leafKey: Uint8Array;
}

interface LeafCreation {
  readonly device: CertifyingDevice;
  /** The group's current epoch, which the certification is signed from. */
  readonly certifiedEpoch: number;
}

interface Operation<T> {
  /** Policy input; required before anything the policy checks. */
  readonly directory?: DirectoryInput;
  /** Generate and certify a new leaf when no session is stored. */
  readonly create?: LeafCreation;
  /**
   * Generate and certify a new leaf even when a session is stored: the
   * stored one belongs to a group the project no longer uses (a reset, or
   * state that can no longer follow the group), and is overwritten.
   */
  readonly fresh?: LeafCreation;
  /** Seal and write the session afterwards. */
  readonly mutate: boolean;
  run(
    session: MlsSession,
    stored: StoredMlsSession | null,
    mls: Mls,
    /** The verified directory installed for this operation, if any. */
    directory: DeviceDirectory | null
  ): Promise<{
    value: T;
    /** Replaces the stored pending Commit; undefined keeps it. */
    pendingCommit?: StoredPendingCommit | null;
  }>;
}

const aborted = () =>
  new DOMException(
    'The encryption session ended. Sign in again.',
    'AbortError'
  );

const isWorkerFailure = (error: unknown) =>
  error instanceof Error &&
  error.name === 'MlsError' &&
  (error as { kind?: unknown }).kind === 'worker';

function generateStateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt'
  ]);
}

const copyPending = (pending: StoredPendingCommit): PendingCommit => ({
  commit: new Uint8Array(pending.commit),
  welcome: pending.welcome ? new Uint8Array(pending.welcome) : null
});

/** One epoch's exports, read from a session that is in the group. */
export interface EpochMaterial {
  readonly epoch: number;
  /** `MLS-Exporter("openzcad project key", project id, 32)`. */
  readonly projectKey: Uint8Array;
  readonly rejoinPsk: RejoinPsk;
  readonly epochAuthenticator: Uint8Array;
  readonly groupInfo: Uint8Array;
}

/** The new epoch a pending Commit or rejoin would start. */
export interface PendingEpoch extends EpochMaterial {
  /** True for a provisional rejoin (external Commit). */
  readonly external: boolean;
  /**
   * The new epoch's archive record. Null for a rejoin: the rejoin's own
   * `RejoinResult.change` carries it.
   */
  readonly epochRecord: Uint8Array | null;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

async function materialOf(session: MlsSession): Promise<EpochMaterial> {
  const status = await session.status();
  if (!status.inGroup || status.epoch === null)
    throw new Error('This device is not in the project’s group.');
  return {
    epoch: status.epoch,
    projectKey: await session.projectKey(),
    rejoinPsk: await session.rejoinPsk(),
    epochAuthenticator: await session.epochAuthenticator(),
    groupInfo: await session.groupInfo()
  };
}

const live = new Set<MlsProjectSessions>();

export class MlsProjectSessions {
  private readonly sessions = new Map<string, Entry>();
  private readonly stateKeys = new Map<string, CryptoKey>();
  private generation = 0;

  constructor(
    private readonly store: MlsSessionStore,
    private readonly loader: MlsLoader
  ) {
    live.add(this);
  }

  /** Create the project's group with this device as the owner's only leaf. */
  createGroup(
    ref: MlsProjectRef,
    device: CertifyingDevice,
    directory: DirectoryInput,
    options: {
      rejoinWindow?: number;
      /** Replace stored state (an identity-authorized group reset, D9). */
      replace?: boolean;
    } = {}
  ): Promise<EpochChange> {
    if (device.userId !== ref.userId || device.deviceId !== ref.deviceId) {
      return Promise.reject(
        new Error('The certifying device is not the one named.')
      );
    }
    // A new group starts at epoch 0: the creator's leaf counts from there.
    const leaf = { device, certifiedEpoch: 0 };
    return this.operate(ref, {
      directory,
      ...(options.replace ? { fresh: leaf } : { create: leaf }),
      mutate: true,
      run: async (session, stored) => {
        if (stored && !options.replace)
          throw new Error('This project already has MLS state.');
        const created = await session.createGroup(
          options.rejoinWindow === undefined
            ? {}
            : { rejoinWindow: options.rejoinWindow }
        );
        if (created.epoch !== 0)
          throw new Error('A new MLS group did not start at epoch 0.');
        return { value: created, pendingCommit: null };
      }
    });
  }

  /** This epoch's project key (`MLS-Exporter("openzcad project key", …)`). */
  projectKey(ref: MlsProjectRef): Promise<Uint8Array> {
    return this.operate(ref, {
      mutate: false,
      run: async (session) => ({ value: await session.projectKey() })
    });
  }

  status(ref: MlsProjectRef): Promise<SessionStatus> {
    return this.operate(ref, {
      mutate: false,
      run: async (session) => ({ value: await session.status() })
    });
  }

  /**
   * Build a Commit and persist it as pending before returning it, so a
   * reload can resend it (`pendingCommit`) until the room accepts it
   * (`confirmCommit`) or another Commit wins the epoch (`discardCommit`).
   */
  commit(
    ref: MlsProjectRef,
    directory: DirectoryInput,
    request: CommitRequest = {}
  ): Promise<PendingCommit> {
    return this.operate(ref, {
      directory,
      mutate: true,
      run: async (session) => {
        const pending = await session.commit(request);
        const stored = {
          commit: new Uint8Array(pending.commit),
          welcome: pending.welcome ? new Uint8Array(pending.welcome) : null
        };
        return { value: copyPending(stored), pendingCommit: stored };
      }
    });
  }

  confirmCommit(
    ref: MlsProjectRef,
    directory: DirectoryInput
  ): Promise<EpochChange> {
    return this.operate(ref, {
      directory,
      mutate: true,
      run: async (session) => ({
        value: await session.confirmCommit(),
        pendingCommit: null
      })
    });
  }

  discardCommit(ref: MlsProjectRef): Promise<void> {
    return this.operate(ref, {
      mutate: true,
      run: async (session) => {
        await session.discardCommit();
        return { value: undefined, pendingCommit: null };
      }
    });
  }

  /** The stored Commit the room has not ruled on, if any. */
  async pendingCommit(ref: MlsProjectRef): Promise<PendingCommit | null> {
    const { guard } = this.sessionGuard();
    guard();
    const stored = await this.store.loadSession(ref.userId, ref.projectId);
    // A teardown during the read must not hand back the ended session's
    // Commit for resending.
    guard();
    if (stored && stored.deviceId !== ref.deviceId) return null;
    return stored?.pendingCommit ? copyPending(stored.pendingCommit) : null;
  }

  /** Process a proposal or Commit the sequencer delivered, in order. */
  process(
    ref: MlsProjectRef,
    directory: DirectoryInput,
    message: Uint8Array
  ): Promise<Processed> {
    return this.operate(ref, {
      directory,
      mutate: true,
      run: async (session) => ({ value: await session.process(message) })
    });
  }

  /**
   * The current epoch's exports, for wrapping and archiving: the project
   * key, the rejoin PSK, the epoch authenticator and a GroupInfo.
   */
  epochMaterial(ref: MlsProjectRef): Promise<EpochMaterial> {
    return this.operate(ref, {
      mutate: false,
      run: async (session) => ({ value: await materialOf(session) })
    });
  }

  /**
   * What the new epoch of the stored pending Commit (or provisional
   * rejoin) holds, before the room rules on it, so its wraps and archive
   * can travel with it. A sealed copy of the session is opened beside it,
   * confirmed and freed; the session itself stays pending, so a refusal
   * can still discard it. The secrets of the new epoch are fixed when the
   * Commit is built, so the copy's exports are the ones the confirmed
   * session will have. Nothing is written.
   */
  previewPending(
    ref: MlsProjectRef,
    directory: DirectoryInput
  ): Promise<PendingEpoch> {
    return this.operate(ref, {
      directory,
      mutate: false,
      run: async (session, _stored, mls, verified) => {
        const status = await session.status();
        if (!status.pendingCommit && !status.pendingRejoin)
          throw new Error('No Commit is pending for this project.');
        const key = await this.stateKey(ref.userId, false);
        const copy = await mls.open(
          await session.seal(key),
          key,
          ref.projectId
        );
        try {
          await copy.setDirectory(verified!);
          let epochRecord: Uint8Array | null = null;
          if (status.pendingRejoin) await copy.confirmRejoin();
          else epochRecord = (await copy.confirmCommit()).epochRecord;
          return {
            value: {
              ...(await materialOf(copy)),
              external: status.pendingRejoin,
              epochRecord
            }
          };
        } finally {
          void copy.free().catch(() => undefined);
        }
      }
    });
  }

  /**
   * Rejoin by external Commit (ADR-024 amendment: an owner's device joins
   * its solo group with the account-wrapped rejoin PSK; decision D3). A new
   * leaf is generated and certified from `certifiedEpoch`, the group's
   * current epoch, unless this device already holds a groupless session
   * (an earlier attempt that lost its epoch), whose leaf is reused: an
   * older certified epoch can only refuse more. A leaf of this same device
   * left in the group by state it lost is replaced in the same Commit. The
   * provisional state and its Commit are stored before the Commit is
   * returned.
   */
  rejoin(
    ref: MlsProjectRef,
    device: CertifyingDevice,
    directory: DirectoryInput,
    certifiedEpoch: number,
    groupInfo: Uint8Array,
    request: Omit<RejoinRequest, 'replaceLeaf'>,
    options: RejoinOptions = {}
  ): Promise<RejoinResult> {
    if (device.userId !== ref.userId || device.deviceId !== ref.deviceId) {
      return Promise.reject(
        new Error('The certifying device is not the one named.')
      );
    }
    const leaf = { device, certifiedEpoch };
    return this.operate(ref, {
      directory,
      ...(options.fresh ? { fresh: leaf } : { create: leaf }),
      mutate: true,
      run: async (session) => {
        const status = await session.status();
        if (status.inGroup || status.pendingRejoin || status.pendingJoin)
          throw new Error('This device already holds the project’s group.');
        // Unverified until the external Commit checks the GroupInfo; it only
        // names a leaf to drop, and the policy lets a rejoin drop only a leaf
        // of the joiner's own identity.
        const own = await session.signatureKey();
        const { members } = await session.inspectGroupInfo(groupInfo);
        const stale =
          members.find(
            (member) =>
              member.userId === ref.userId &&
              member.deviceId === ref.deviceId &&
              !sameBytes(member.signatureKey, own)
          ) ??
          // The last-leaf exception: a leaf of a revoked device this one
          // replaces. The policy decides whether the exception applies.
          members.find(
            (member) =>
              member.userId === ref.userId &&
              (options.replaceDevices ?? []).includes(member.deviceId)
          );
        const result = await session.rejoin(
          groupInfo,
          stale ? { ...request, replaceLeaf: stale.index } : request
        );
        return {
          value: result,
          pendingCommit: {
            commit: new Uint8Array(result.commit),
            welcome: null
          }
        };
      }
    });
  }

  /**
   * What a GroupInfo claims (members, roles), read with a throwaway
   * session: unverified, a hint for deciding, never authority.
   */
  async inspectGroupInfo(
    ref: MlsProjectRef,
    groupInfo: Uint8Array
  ): Promise<GroupInfoSummary> {
    const { guard } = this.sessionGuard();
    guard();
    const mls = await this.loader.get();
    const session = await mls.generate({
      projectId: ref.projectId,
      userId: ref.userId,
      deviceId: ref.deviceId
    });
    try {
      guard();
      return await session.inspectGroupInfo(groupInfo);
    } finally {
      void session.free().catch(() => undefined);
    }
  }

  /** The room accepted the external Commit. */
  confirmRejoin(ref: MlsProjectRef, directory: DirectoryInput): Promise<void> {
    return this.operate(ref, {
      directory,
      mutate: true,
      run: async (session) => {
        await session.confirmRejoin();
        return { value: undefined, pendingCommit: null };
      }
    });
  }

  /** Another Commit won the epoch: restore the session as it was. */
  discardRejoin(ref: MlsProjectRef): Promise<void> {
    return this.operate(ref, {
      mutate: true,
      run: async (session) => {
        await session.discardRejoin();
        return { value: undefined, pendingCommit: null };
      }
    });
  }

  /**
   * Delete this device's MLS state for one project, so the project can be
   * created or joined afresh: a group whose creation never reached the
   * server, or state the server's group never accepted. With `leafKey`,
   * only the session holding that leaf is deleted, so state another tab
   * replaced it with meanwhile survives. Runs under the same account and
   * project locks as every other operation. Returns whether anything was
   * deleted.
   */
  discardSession(ref: MlsProjectRef, leafKey?: Uint8Array): Promise<boolean> {
    const { current, guard } = this.sessionGuard();
    guard();
    const id = JSON.stringify([ref.userId, ref.projectId]);
    return this.store.withAccountLock(ref.userId, 'shared', () =>
      this.store.withProjectLock(ref.userId, ref.projectId, async () => {
        guard();
        const stored = await this.store.loadSession(ref.userId, ref.projectId);
        guard();
        if (!stored) return false;
        if (stored.deviceId !== ref.deviceId)
          throw new Error(
            'This project’s encryption state belongs to another device.'
          );
        if (leafKey && !sameBytes(stored.leaf.signatureKey, leafKey))
          return false;
        this.drop(id);
        const deleted = await this.store.deleteSessionIfCurrent(
          ref.userId,
          ref.projectId,
          stored.revision,
          current
        );
        guard();
        return deleted;
      })
    );
  }

  /** This device's stored leaf for the project, or null without a session. */
  async leaf(ref: MlsProjectRef): Promise<StoredLeaf | null> {
    const { guard } = this.sessionGuard();
    guard();
    const stored = await this.store.loadSession(ref.userId, ref.projectId);
    guard();
    if (!stored || stored.deviceId !== ref.deviceId) return null;
    return {
      signatureKey: new Uint8Array(stored.leaf.signatureKey),
      certification: new Uint8Array(stored.leaf.certification)
    };
  }

  /**
   * Checks one leaf certification against the certifying device's signing
   * key, for a project (encrypted documents' authorship check: did the
   * author's device hold a leaf it certified in the version's epoch?).
   * Needs no session; null when it does not verify.
   */
  async verifyLeafCertification(
    claim: LeafCertificationClaim,
    deviceSigningKey: Uint8Array
  ): Promise<VerifiedLeafCertification | null> {
    return verifyLeafCertification(
      await this.loader.get(),
      claim,
      deviceSigningKey
    );
  }

  /**
   * Decodes an archived epoch record (its GroupContext, tree and Commit),
   * for reading the roles of a past epoch (slice 5-2). Needs no session.
   */
  async decodeEpochRecord(record: Uint8Array): Promise<EpochRecord> {
    return (await this.loader.get()).decodeEpochRecord(record);
  }

  /** Sessions held in this page's memory (tests and diagnostics). */
  get cachedSessions(): number {
    return this.sessions.size;
  }

  /** Free every session, forget the state keys and stop the Worker. */
  clear(): void {
    this.generation++;
    for (const entry of this.sessions.values())
      void entry.session.free().catch(() => undefined);
    this.sessions.clear();
    this.stateKeys.clear();
    this.loader.close();
  }

  private drop(id: string): void {
    const entry = this.sessions.get(id);
    this.sessions.delete(id);
    void entry?.session.free().catch(() => undefined);
  }

  private async stateKey(userId: string, create: boolean): Promise<CryptoKey> {
    const cached = this.stateKeys.get(userId);
    if (cached) return cached;
    let key = await this.store.loadStateKey(userId);
    if (!key && create) {
      key = await this.store.getOrCreateStateKey(
        userId,
        await generateStateKey()
      );
    }
    if (!key)
      throw new Error(
        'This device’s encryption state key is missing; the project must be rejoined.'
      );
    this.stateKeys.set(userId, key);
    return key;
  }

  /** Checks that this page's key session (and these sessions) still hold. */
  private sessionGuard(): { current: () => boolean; guard: () => void } {
    const generation = this.generation;
    const revision = getKeySessionRevision();
    const current = () =>
      this.generation === generation && isCurrentKeySession(revision);
    return {
      current,
      guard: () => {
        if (!current()) throw aborted();
      }
    };
  }

  private async operate<T>(ref: MlsProjectRef, op: Operation<T>): Promise<T> {
    const { current, guard } = this.sessionGuard();
    guard();
    // Shared with every other operation on the account; account deletion
    // (destructive sign-out, erasure) takes it exclusively.
    return this.store.withAccountLock(ref.userId, 'shared', () =>
      this.operateLocked(ref, op, current, guard)
    );
  }

  private operateLocked<T>(
    ref: MlsProjectRef,
    op: Operation<T>,
    current: () => boolean,
    guard: () => void
  ): Promise<T> {
    const id = JSON.stringify([ref.userId, ref.projectId]);
    return this.store.withProjectLock(ref.userId, ref.projectId, async () => {
      guard();
      try {
        const mls = await this.loader.get();
        const stored = await this.store.loadSession(ref.userId, ref.projectId);
        guard();
        if (stored && stored.deviceId !== ref.deviceId)
          throw new Error(
            'This project’s encryption state belongs to another device.'
          );
        let entry = this.sessions.get(id);
        if (op.fresh && entry) {
          this.drop(id);
          entry = undefined;
        }
        if (
          entry &&
          (entry.revision !== (stored?.revision ?? 0) ||
            (stored !== null &&
              !sameBytes(entry.leafKey, stored.leaf.signatureKey)))
        ) {
          // Another tab moved the state on, or replaced it: reopen from
          // storage.
          this.drop(id);
          entry = undefined;
        }
        let leaf = stored?.leaf;
        if (!entry) {
          const opened = op.fresh
            ? await this.openOrCreate(mls, ref, null, op.fresh)
            : await this.openOrCreate(mls, ref, stored, op.create);
          guard();
          leaf = opened.leaf;
          entry = {
            session: opened.session,
            revision: stored?.revision ?? 0,
            leafKey: new Uint8Array(opened.leaf.signatureKey)
          };
          this.sessions.set(id, entry);
        }
        let directory: DeviceDirectory | null = null;
        if (op.directory) {
          directory = await buildDeviceDirectory(
            mls,
            ref.projectId,
            withOwnLeaf(op.directory, ref, leaf!)
          );
          guard();
          await entry.session.setDirectory(directory);
        }
        const result = await op.run(entry.session, stored, mls, directory);
        guard();
        if (op.mutate) {
          const key = await this.stateKey(ref.userId, true);
          const sealed = await entry.session.seal(key);
          guard();
          const written = await this.store.writeSessionIfCurrent(
            entry.revision,
            {
              userId: ref.userId,
              projectId: ref.projectId,
              deviceId: ref.deviceId,
              sealed,
              leaf: leaf!,
              pendingCommit:
                result.pendingCommit === undefined
                  ? op.fresh
                    ? null
                    : (stored?.pendingCommit ?? null)
                  : result.pendingCommit
            },
            current
          );
          // A teardown after the write committed still fails the operation:
          // the caller must not act on (or send) its result.
          guard();
          if (!written) throw new MlsSessionConflict();
          entry.revision = written.revision;
        }
        return result.value;
      } catch (error) {
        // The in-memory session may be ahead of storage; start over from it.
        this.drop(id);
        if (isWorkerFailure(error)) this.clearWorker();
        if (!current()) throw aborted();
        throw error;
      }
    });
  }

  private async openOrCreate(
    mls: Mls,
    ref: MlsProjectRef,
    stored: StoredMlsSession | null,
    create: LeafCreation | undefined
  ): Promise<{ session: MlsSession; leaf: StoredLeaf }> {
    if (stored) {
      const key = await this.stateKey(ref.userId, false);
      return {
        session: await mls.open(stored.sealed, key, ref.projectId),
        leaf: stored.leaf
      };
    }
    if (!create) throw new MlsSessionMissing();
    const session = await mls.generate({
      projectId: ref.projectId,
      userId: ref.userId,
      deviceId: ref.deviceId
    });
    try {
      const certification = await certifyLeaf(
        session,
        create.device,
        create.certifiedEpoch
      );
      return {
        session,
        leaf: { signatureKey: await session.signatureKey(), certification }
      };
    } catch (error) {
      void session.free().catch(() => undefined);
      throw error;
    }
  }

  /** The Worker died: every session in it is gone. */
  private clearWorker(): void {
    this.sessions.clear();
    this.loader.close();
  }
}

/** The directory input plus this device's own leaf, verified like the rest. */
function withOwnLeaf(
  input: DirectoryInput,
  ref: MlsProjectRef,
  leaf: StoredLeaf
): DirectoryInput {
  const own = {
    userId: ref.userId,
    deviceId: ref.deviceId,
    leafKey: leaf.signatureKey,
    certification: leaf.certification
  };
  return { ...input, certifications: [...input.certifications, own] };
}

let pageSessions: MlsProjectSessions | null = null;

/** The page's MLS sessions over IndexedDB and the real Worker. */
export function mlsProjectSessions(): MlsProjectSessions {
  pageSessions ??= new MlsProjectSessions(
    indexedDbMlsSessionStore(),
    mlsLoader()
  );
  return pageSessions;
}

subscribeKeySession((event) => {
  if (event.phase !== 'ready') for (const sessions of live) sessions.clear();
});
