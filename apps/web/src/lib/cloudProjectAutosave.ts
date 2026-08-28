import type {
  ProjectDocument,
  SaveProjectDocumentResponse
} from '@openzcad/shared';
import { withoutDerivedProjection } from '@openzcad/document-core';
import { ApiError, isProjectDocumentUnavailableError } from './api';

/**
 * How long editing has to pause before the account is written. Much longer than
 * the 450 ms local autosave on purpose: the device copy is what protects the
 * work, and the account only has to be close behind.
 */
export const PROJECT_AUTOSAVE_IDLE_MS = 3_000;
/**
 * The longest a continuous edit can keep deferring the account write. Dragging
 * a face for two minutes never goes idle, and without a ceiling it would also
 * never sync.
 */
export const PROJECT_AUTOSAVE_MAX_WAIT_MS = 60_000;
export const PROJECT_AUTOSAVE_RETRY_DELAY_MS = 5_000;

/**
 * How long to wait between attempts once the quick retries are used up.
 *
 * The quick ones exist to ride out a blip; a failure that outlasts them is
 * usually a deployment having a bad few minutes, and the browser fires no
 * `online` event for that because the network never went away. Without a slow
 * heartbeat the edit simply stops being offered to the account for the rest of
 * the session, which reads as "offline" on a working connection.
 */
export const PROJECT_AUTOSAVE_IDLE_RETRY_MS = 60_000;

/**
 * What the account knows relative to this device.
 *
 * `local` is not a failure — it is a project the account does not have, which
 * is an ordinary state for a device that has never been signed in. The three
 * unhappy states are kept apart because the user's next move differs: `offline`
 * resolves itself, `conflict` needs a decision, `repair` needs the account
 * copy restored, and `refused` will never succeed no matter how long anyone
 * waits.
 */
export type CloudProjectSyncState =
  | 'local'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'conflict'
  | 'repair'
  | 'refused'
  /** Cloud autosave is switched off; only an explicit save writes now. */
  | 'paused';

/**
 * What the workspace shows. `saving` is the device write, which the controller
 * never sees — it is over in milliseconds and is the only one of these that
 * means "not yet safe anywhere". `local-source` is derived by the workspace,
 * never emitted here: the document itself synced, but it references an import
 * source that was never archived, so other devices cannot rebuild it and a
 * plain "Synced" would be a lie.
 */
/**
 * `device-failed` is the workspace's own state, never the controller's: it
 * means the IndexedDB write itself rejected, so the document exists only in
 * this tab. It is deliberately not `offline` — that one promises the work is
 * safe on the device, which is the one thing that is not true here.
 */
export type WorkspaceSaveState =
  | CloudProjectSyncState
  | 'saving'
  | 'local-source'
  | 'device-failed';

export interface CloudProjectAutosaveStatus {
  state: CloudProjectSyncState;
  projectId: string | null;
  /** Present on `refused`, and on a transient failure reported as `offline`. */
  error?: unknown;
}

export interface CloudProjectAutosaveConnectivity {
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export interface CloudProjectAutosaveOptions {
  api: {
    saveProjectDocument(
      input: {
        projectId: string;
        expectedVersion: number;
        document: ProjectDocument;
      },
      options?: { keepalive?: boolean }
    ): Promise<SaveProjectDocumentResponse>;
  };
  connectivity?: CloudProjectAutosaveConnectivity;
  idleDelayMs?: number;
  maxWaitMs?: number;
  retryDelayMs?: number;
  idleRetryDelayMs?: number;
  maxAutomaticRetries?: number;
  now?: () => number;
  onStatus?: (status: CloudProjectAutosaveStatus) => void;
  /**
   * The account moved underneath this device. The controller stops writing and
   * waits: choosing between the two documents is a decision only the person
   * editing can make, and guessing would discard one of them.
   */
  onConflict?: (input: {
    projectId: string;
    localDocument: ProjectDocument;
    accountVersion: number;
  }) => void;
  /** The account acknowledged a write, at the version it now holds. */
  onSynced?: (input: { projectId: string; version: number }) => void;
  onSessionExpired?: () => void;
}

interface ActiveProject {
  projectId: string;
  /** The version the account last acknowledged; what a write is fenced against. */
  version: number;
  epoch: number;
}

interface PendingSave {
  document: ProjectDocument;
  editEpoch: number;
  projectId: string;
}

type SaveResult =
  | { state: 'saved'; version: number }
  | { state: 'failed' }
  | { state: 'halted' }
  | { state: 'stale' };

function browserConnectivity(): CloudProjectAutosaveConnectivity {
  return {
    isOnline: () => globalThis.navigator?.onLine !== false,
    subscribe(listener) {
      if (typeof globalThis.addEventListener !== 'function') {
        return () => undefined;
      }
      const online = () => listener(true);
      const offline = () => listener(false);
      globalThis.addEventListener('online', online);
      globalThis.addEventListener('offline', offline);
      return () => {
        globalThis.removeEventListener('online', online);
        globalThis.removeEventListener('offline', offline);
      };
    }
  };
}

/**
 * Mirrors the open project to the account, continuously and out of the way.
 *
 * The device's IndexedDB write is the save; this is the copy. Nothing here
 * blocks an edit, gates the UI, or decides whether work is kept, so every
 * failure path ends in "still saved on this device" rather than in data loss.
 *
 * Writes go to the document endpoint rather than the revision endpoint, so a
 * long session costs a bounded number of row updates instead of one full
 * document snapshot per autosave. Explicit saves still write history.
 */
export class CloudProjectAutosave {
  readonly #options: CloudProjectAutosaveOptions;
  readonly #connectivity: CloudProjectAutosaveConnectivity;
  #idleDelayMs: number;
  #enabled = true;
  readonly #maxWaitMs: number;
  readonly #retryDelayMs: number;
  readonly #idleRetryDelayMs: number;
  readonly #maxAutomaticRetries: number;
  readonly #now: () => number;

  #project: ActiveProject | null = null;
  #projectEpoch = 0;
  #editEpoch = 0;
  #pending: PendingSave | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #queue: Promise<SaveResult> = Promise.resolve({ state: 'stale' });
  #automaticRetries = 0;
  /** When the oldest unsaved edit arrived, for the max-wait ceiling. */
  #pendingSince: number | null = null;
  /**
   * Set when the account refused in a way that repeating cannot fix — a
   * divergence or an oversize document. Cleared only by `openProject` or
   * `adoptAccountVersion`, both of which re-establish a baseline.
   */
  #halted: 'conflict' | 'repair' | 'refused' | null = null;
  /**
   * The project whose divergence was detected by the reconciler rather than by
   * a fenced 409. `openProject` runs from an effect that can fire *after* the
   * conflict was raised — and it used to clear the halt, so the losing local
   * copy went on to overwrite the account version the user was still being
   * asked about. Survives `openProject` for the same project; cleared only by
   * `adoptAccountVersion` (the resolution) or `closeProject`.
   */
  #conflictProjectId: string | null = null;
  #disposed = false;
  /**
   * Set while a page-teardown drain is running so `#persist` asks the fetch
   * layer for a keepalive request — a plain fetch started from `pagehide` is
   * aborted with the document, and the account write silently never lands.
   */
  #keepalive = false;
  readonly #unsubscribeConnectivity: () => void;

  constructor(options: CloudProjectAutosaveOptions) {
    this.#options = options;
    this.#connectivity = options.connectivity ?? browserConnectivity();
    this.#idleDelayMs = options.idleDelayMs ?? PROJECT_AUTOSAVE_IDLE_MS;
    this.#maxWaitMs = options.maxWaitMs ?? PROJECT_AUTOSAVE_MAX_WAIT_MS;
    this.#retryDelayMs =
      options.retryDelayMs ?? PROJECT_AUTOSAVE_RETRY_DELAY_MS;
    this.#idleRetryDelayMs =
      options.idleRetryDelayMs ?? PROJECT_AUTOSAVE_IDLE_RETRY_MS;
    this.#maxAutomaticRetries = options.maxAutomaticRetries ?? 3;
    this.#now = options.now ?? (() => Date.now());
    this.#unsubscribeConnectivity = this.#connectivity.subscribe((online) =>
      this.#handleConnectivityChange(online)
    );
  }

  get hasPendingChanges(): boolean {
    return this.#pending !== null;
  }

  /** The account version this device is currently writing against. */
  get syncedVersion(): number | null {
    return this.#project?.version ?? null;
  }

  get isHalted(): boolean {
    return this.#halted !== null;
  }

  /**
   * Whether the account is already known to hold exactly this document.
   *
   * Distinguishes adopting a document from editing one. Reopening a project,
   * pulling a newer copy, and receiving a collaboration frame all arrive as a
   * document this device did not author, and mirroring one straight back is a
   * write nobody asked for — fenced, on the collaboration path, against a
   * version the room may not have persisted yet.
   */
  holdsDocument(document: ProjectDocument): boolean {
    return (
      this.#project !== null &&
      this.#project.projectId === document.projectId &&
      this.#project.version === document.version
    );
  }

  /**
   * Applies the user's preferences. Turning autosave off does not discard the
   * queued edit — the device still has it, and an explicit save can still send
   * it — it only stops this controller writing without being asked.
   */
  configure({
    enabled,
    idleDelayMs
  }: {
    enabled?: boolean;
    idleDelayMs?: number;
  }): void {
    if (idleDelayMs !== undefined) {
      this.#idleDelayMs = idleDelayMs;
    }
    if (enabled === undefined || enabled === this.#enabled) {
      return;
    }
    this.#enabled = enabled;
    this.#clearTimer();
    if (!enabled) {
      if (this.#pending) {
        this.#emit('paused');
      }
      return;
    }
    if (this.#pending && this.#project && !this.#halted) {
      this.#emit('syncing');
      this.#armTimer(0);
    }
  }

  /**
   * Starts mirroring `projectId`, fencing writes against `accountVersion`.
   * Queued edits from another project are dropped: they belong to a document
   * this controller is no longer responsible for, and the device still holds
   * them.
   */
  openProject(projectId: string, accountVersion: number): void {
    this.#assertUsable();
    this.#clearTimer();
    if (this.#pending && this.#pending.projectId !== projectId) {
      this.#pending = null;
      this.#pendingSince = null;
    }
    this.#project = {
      projectId,
      version: accountVersion,
      epoch: ++this.#projectEpoch
    };
    this.#halted = this.#conflictProjectId === projectId ? 'conflict' : null;
    this.#automaticRetries = 0;
    if (this.#halted) {
      this.#emit(this.#halted);
    } else if (this.#pending && this.#connectivity.isOnline()) {
      this.#armTimer(0);
    } else {
      this.#emit(this.#pending ? 'offline' : 'synced');
    }
  }

  /**
   * Halts on a divergence the reconciler found, rather than one the account
   * refused. A fenced 409 halts the writer on its own; a divergence detected
   * while opening the project does not, so without this the conflict dialog is
   * still asking which copy to keep while the debounced writer is already
   * sending the local one — and the account's `document_version` regresses.
   *
   * Idempotent, and safe to call before `openProject`: the halt is remembered
   * against the project id and re-applied when that project opens.
   */
  haltForConflict(projectId: string): void {
    this.#assertUsable();
    this.#clearTimer();
    this.#conflictProjectId = projectId;
    if (!this.#project || this.#project.projectId === projectId) {
      this.#halted = 'conflict';
      this.#emit('conflict');
    }
  }

  /**
   * Stops mirroring. Any queued edit is discarded rather than carried, because
   * the next project to open is a different document and the device copy of
   * this one is already safe.
   */
  closeProject(): void {
    this.#clearTimer();
    this.#projectEpoch += 1;
    this.#project = null;
    this.#pending = null;
    this.#pendingSince = null;
    this.#halted = null;
    this.#conflictProjectId = null;
    this.#automaticRetries = 0;
  }

  /**
   * Re-baselines on a document the device and the account now agree on — after
   * a pull, or after a conflict was resolved. Clears the halt.
   */
  adoptAccountVersion(projectId: string, accountVersion: number): void {
    this.#assertUsable();
    // Same guard `haltForConflict` above has always applied, for the same
    // reason: the caller is usually async — a pull, a conflict resolution, a
    // freshness poll — and can land after the user has opened a different
    // project. Re-pointing the controller at the stale project would leave it
    // mirroring a document that is no longer on screen and fence the open
    // one's next push against a version it never held.
    if (this.#project && this.#project.projectId !== projectId) {
      return;
    }
    this.#clearTimer();
    this.#project = {
      projectId,
      version: accountVersion,
      epoch: ++this.#projectEpoch
    };
    this.#pending = null;
    this.#pendingSince = null;
    this.#halted = null;
    this.#conflictProjectId = null;
    this.#automaticRetries = 0;
    this.#emit('synced');
  }

  /** Records an edit. Cheap: the write itself is debounced. */
  schedule(document: ProjectDocument): void {
    this.#assertUsable();
    this.#editEpoch += 1;
    this.#pending = {
      document,
      editEpoch: this.#editEpoch,
      projectId: document.projectId
    };
    this.#automaticRetries = 0;
    this.#clearTimer();

    if (!this.#project || this.#project.projectId !== document.projectId) {
      // Not a project the account has. The device already saved it; offering
      // to adopt it is the start screen's job, not this controller's.
      this.#emit('local');
      return;
    }
    if (this.#halted) {
      this.#emit(this.#halted);
      return;
    }
    if (!this.#enabled) {
      this.#emit('paused');
      return;
    }
    if (!this.#connectivity.isOnline()) {
      this.#emit('offline');
      return;
    }
    this.#pendingSince ??= this.#now();
    this.#emit('syncing');
    this.#armTimer(this.#nextDelay());
  }

  /** Writes the queued edit now, if there is one and it can be written. */
  async flush(): Promise<number | null> {
    this.#assertUsable();
    this.#clearTimer();
    const next = this.#pending;
    if (!next) {
      const settled = await this.#queue;
      return settled.state === 'saved' ? settled.version : null;
    }
    if (
      !this.#project ||
      this.#project.projectId !== next.projectId ||
      this.#halted ||
      // Autosave off means "do not write without me asking", and a page-hide or
      // logout drain is still this controller asking rather than the user.
      !this.#enabled ||
      !this.#connectivity.isOnline()
    ) {
      return null;
    }

    const epoch = this.#project.epoch;
    this.#pending = null;
    const save = this.#queue.then(
      () => this.#persist(next, epoch),
      () => this.#persist(next, epoch)
    );
    this.#queue = save;
    const result = await save;
    this.#afterSave(result);
    return result.state === 'saved' ? result.version : null;
  }

  /**
   * Drains edits made before or during an in-flight request, then resolves.
   * Unlike the settings equivalent this never throws: a document that cannot
   * reach the account is not a lost document, and the callers — logout, page
   * hide — must not be blocked by one.
   */
  async flushPending(options?: { keepalive?: boolean }): Promise<void> {
    if (this.#disposed) {
      return;
    }
    if (options?.keepalive) {
      this.#keepalive = true;
    }
    try {
      while (this.#pending) {
        const before = this.#pending.editEpoch;
        await this.flush();
        await this.#queue;
        if (!this.#pending || this.#pending.editEpoch === before) {
          return;
        }
      }
      await this.#queue;
    } finally {
      if (options?.keepalive) {
        this.#keepalive = false;
      }
    }
  }

  async whenIdle(): Promise<void> {
    await this.#queue;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#clearTimer();
    this.#unsubscribeConnectivity();
    this.#projectEpoch += 1;
    this.#project = null;
  }

  async #persist(next: PendingSave, epoch: number): Promise<SaveResult> {
    if (!this.#isActive(epoch, next.projectId)) {
      return { state: 'stale' };
    }
    const expectedVersion = this.#project!.version;
    try {
      const response = await this.#options.api.saveProjectDocument(
        {
          projectId: next.projectId,
          expectedVersion,
          document: withoutDerivedProjection(next.document)
        },
        { keepalive: this.#keepalive }
      );
      if (!this.#isActive(epoch, next.projectId)) {
        return { state: 'stale' };
      }
      this.#project!.version = response.version;
      this.#options.onSynced?.({
        projectId: next.projectId,
        version: response.version
      });
      return { state: 'saved', version: response.version };
    } catch (error) {
      if (!this.#isActive(epoch, next.projectId)) {
        return { state: 'stale' };
      }
      return this.#handleFailure(next, error);
    }
  }

  #handleFailure(next: PendingSave, error: unknown): SaveResult {
    const status = error instanceof ApiError ? error.status : null;

    // Divergence. Hand the decision up and stop writing — a retry would either
    // fail identically or, worse, succeed against a version the user never saw.
    if (status === 409) {
      this.#requeue(next);
      this.#halted = 'conflict';
      const accountVersion =
        error instanceof ApiError ? currentVersionOf(error) : null;
      this.#emit('conflict');
      this.#options.onConflict?.({
        projectId: next.projectId,
        localDocument: next.document,
        accountVersion: accountVersion ?? this.#project?.version ?? 0
      });
      return { state: 'halted' };
    }

    // The account record exists but its document object cannot be read. A
    // retrying write would either loop on the same storage fault or race an
    // operator repair, so preserve the queued device copy and wait for an
    // explicit retry after the account copy is available again.
    if (isProjectDocumentUnavailableError(error)) {
      this.#requeue(next);
      this.#halted = 'repair';
      this.#emit('repair', error);
      return { state: 'halted' };
    }

    // Too large, or refused outright. Waiting changes nothing, so say so
    // instead of retrying until the user assumes it worked.
    if (status === 413 || status === 403) {
      this.#requeue(next);
      this.#halted = 'refused';
      this.#emit('refused', error);
      return { state: 'halted' };
    }

    if (status === 401) {
      this.#requeue(next);
      this.#project = null;
      this.#projectEpoch += 1;
      this.#emit('local');
      this.#options.onSessionExpired?.();
      return { state: 'halted' };
    }

    this.#requeue(next);
    this.#automaticRetries += 1;
    this.#emit('offline', error);
    return { state: 'failed' };
  }

  /**
   * Puts a failed write back at the head of the queue, but only when no newer
   * edit has arrived — a newer one already supersedes it, and restoring the
   * older document would undo work in the account.
   */
  #requeue(next: PendingSave): void {
    if (next.editEpoch === this.#editEpoch && !this.#pending) {
      this.#pending = next;
      this.#pendingSince ??= this.#now();
    }
  }

  #afterSave(result: SaveResult): void {
    if (result.state === 'saved') {
      this.#automaticRetries = 0;
      if (!this.#pending) {
        this.#pendingSince = null;
        this.#emit('synced');
        return;
      }
      // An edit landed while the write was in flight; keep going.
      this.#armTimer(this.#nextDelay());
      return;
    }
    if (
      result.state !== 'failed' ||
      !this.#pending ||
      !this.#connectivity.isOnline()
    ) {
      return;
    }
    // Quick retries first, then a slow heartbeat rather than silence. Giving
    // up entirely would leave the edit unoffered for the rest of the session
    // on a connection that never dropped, so no `online` event is coming to
    // restart it.
    this.#armTimer(
      this.#automaticRetries <= this.#maxAutomaticRetries
        ? this.#retryDelayMs
        : this.#idleRetryDelayMs
    );
  }

  /**
   * The idle delay, shortened so the oldest pending edit is never held past the
   * max-wait ceiling.
   */
  #nextDelay(): number {
    if (this.#pendingSince === null) {
      return this.#idleDelayMs;
    }
    const remaining = this.#pendingSince + this.#maxWaitMs - this.#now();
    return Math.max(0, Math.min(this.#idleDelayMs, remaining));
  }

  #handleConnectivityChange(online: boolean): void {
    if (this.#disposed) {
      return;
    }
    this.#clearTimer();
    if (!online) {
      if (this.#pending) {
        this.#emit('offline');
      }
      return;
    }
    this.#automaticRetries = 0;
    if (this.#pending && this.#project && !this.#halted && this.#enabled) {
      this.#emit('syncing');
      this.#armTimer(0);
    }
  }

  #isActive(epoch: number, projectId: string): boolean {
    return (
      this.#project !== null &&
      this.#project.epoch === epoch &&
      this.#project.projectId === projectId
    );
  }

  #emit(state: CloudProjectSyncState, error?: unknown): void {
    this.#options.onStatus?.({
      state,
      projectId: this.#project?.projectId ?? this.#pending?.projectId ?? null,
      ...(error === undefined ? {} : { error })
    });
  }

  #armTimer(delay: number): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new Error('Cloud project autosave has been disposed.');
    }
  }
}

/**
 * The account's version out of a conflict response. The server sends it so the
 * client can say how far behind it is without a second round trip.
 */
export function currentVersionOf(error: ApiError): number | null {
  const candidate = error.details?.currentVersion;
  return typeof candidate === 'number' ? candidate : null;
}
