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
  EpochChange,
  Mls,
  MlsSession,
  PendingCommit,
  SessionStatus
} from '@openzcad/mls';
import {
  getKeySessionRevision,
  isCurrentKeySession,
  subscribeKeySession
} from '../keySession';
import { certifyLeaf, type CertifyingDevice } from './certify';
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
}

interface Operation<T> {
  /** Policy input; required before anything the policy checks. */
  readonly directory?: DirectoryInput;
  /** Generate and certify a new leaf when no session is stored. */
  readonly create?: CertifyingDevice;
  /** Seal and write the session afterwards. */
  readonly mutate: boolean;
  run(
    session: MlsSession,
    stored: StoredMlsSession | null
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
    options: { rejoinWindow?: number } = {}
  ): Promise<EpochChange> {
    if (device.userId !== ref.userId || device.deviceId !== ref.deviceId) {
      return Promise.reject(
        new Error('The certifying device is not the one named.')
      );
    }
    return this.operate(ref, {
      directory,
      create: device,
      mutate: true,
      run: async (session, stored) => {
        if (stored) throw new Error('This project already has MLS state.');
        return {
          value: await session.createGroup(options),
          pendingCommit: null
        };
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
    const stored = await this.store.loadSession(ref.userId, ref.projectId);
    if (stored && stored.deviceId !== ref.deviceId) return null;
    return stored?.pendingCommit ? copyPending(stored.pendingCommit) : null;
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

  private async operate<T>(ref: MlsProjectRef, op: Operation<T>): Promise<T> {
    const generation = this.generation;
    const revision = getKeySessionRevision();
    const current = () =>
      this.generation === generation && isCurrentKeySession(revision);
    const guard = () => {
      if (!current()) throw aborted();
    };
    guard();
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
        if (entry && entry.revision !== (stored?.revision ?? 0)) {
          // Another tab moved the state on: reopen from storage.
          this.drop(id);
          entry = undefined;
        }
        let leaf = stored?.leaf;
        if (!entry) {
          const opened = await this.openOrCreate(mls, ref, stored, op.create);
          guard();
          leaf = opened.leaf;
          entry = { session: opened.session, revision: stored?.revision ?? 0 };
          this.sessions.set(id, entry);
        }
        if (op.directory) {
          const directory = await buildDeviceDirectory(
            mls,
            ref.projectId,
            withOwnLeaf(op.directory, ref, leaf!)
          );
          guard();
          await entry.session.setDirectory(directory);
        }
        const result = await op.run(entry.session, stored);
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
                  ? (stored?.pendingCommit ?? null)
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
    create: CertifyingDevice | undefined
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
      const certification = await certifyLeaf(session, create);
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
