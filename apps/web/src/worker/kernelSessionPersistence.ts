/**
 * When the geometry worker reads and writes persisted kernel sessions (see
 * `lib/kernelSessionStore.ts` and the adapter's
 * `exact-session-snapshot.ts`).
 *
 * - **Only the user's own local projects.** The worker calls into this
 *   class only for syncs the app marks `persistSession`: a document this
 *   device keeps as the current user's own project. A shared link's model,
 *   someone else's project and one-off rebuilds never offer or capture, and
 *   such a sync (or a `session-policy` turning it off for the live
 *   project) {@link KernelSessionPersistence.forget}s whatever was
 *   scheduled, as closing the project does.
 * - **Offer**: the first sync of a project this worker's history kernel does
 *   not hold reads the stored session for that exact content and build, and
 *   hands it to the adapter, which restores it only if it matches and
 *   publishes it only once its projection does. A refused session is
 *   replaced by a rejection marker for that content and build, so the same
 *   state is neither offered nor written again.
 * - **Capture**: off the critical path. After a live, complete result
 *   (never a draft display or a transient one) the worker waits until it
 *   has been idle for {@link KERNEL_SESSION_IDLE_MS}, at most once per
 *   {@link KERNEL_SESSION_MIN_INTERVAL_MS} per project, then asks the
 *   adapter for its state. The adapter answers null unless the history
 *   kernel is still exactly that result. Content already stored is not
 *   written again.
 * - **Warm-up**: a restored kernel holds a single checkpoint, at the last
 *   feature. Once the worker has been idle for
 *   {@link KERNEL_SESSION_WARMUP_IDLE_MS}, the adapter replays the history in
 *   a second kernel and swaps it in when complete, so later edits of earlier
 *   features restore a nearby checkpoint. Any new work cancels it at the
 *   next feature boundary and it waits for the next idle moment. Every live
 *   result names the document it warms (a draft drops it until its
 *   refinement), so it never replays a superseded revision.
 */
import type {
  ExactKernelAdapter,
  PersistedHistorySession
} from '@openzcad/kernel-adapter/exact';
import type { BodyId, ProjectDocument } from '@openzcad/shared';

export const KERNEL_SESSION_IDLE_MS = 1_500;
export const KERNEL_SESSION_WARMUP_IDLE_MS = 2_000;
export const KERNEL_SESSION_MIN_INTERVAL_MS = 10_000;
/** A stalled read never holds a reopen back longer than this. */
export const KERNEL_SESSION_LOAD_BUDGET_MS = 1_500;

type SessionAdapter = Pick<
  ExactKernelAdapter,
  | 'hasHistoryFor'
  | 'captureHistorySession'
  | 'needsHistoryWarmup'
  | 'warmHistory'
>;

export interface KernelSessionPersistenceDeps {
  /** Null disables persistence (an unidentified build or no snapshots). */
  identity(): string | null;
  load(
    projectId: string,
    contentKey: string,
    identity: string
  ): Promise<PersistedHistorySession | null>;
  save(entry: {
    projectId: string;
    contentKey: string;
    identity: string;
    bytes: number;
    session: PersistedHistorySession;
  }): Promise<boolean>;
  /** That content and build failed to restore: never store it again. */
  reject(
    projectId: string,
    contentKey: string,
    identity: string
  ): Promise<void>;
  touch(projectId: string): Promise<void>;
  isSession(value: unknown): value is PersistedHistorySession;
  estimateBytes(session: PersistedHistorySession): number;
  /** Counts work requests; idle work stops when it changes. */
  workSerial(): number;
  /** Lets the worker receive messages between a warm-up's features. */
  yieldControl(): () => Promise<void> | void;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  /** Session-local diagnostics: identifiers and sizes, never contents. */
  report?(event: KernelSessionEvent): void;
}

export type KernelSessionEvent =
  | { kind: 'capture'; stored: boolean; bytes: number; ms: number }
  | { kind: 'warmup'; warmed: boolean; ms: number };

interface PendingCapture {
  adapter: SessionAdapter;
  document: ProjectDocument;
  contentKey: string;
}

export class KernelSessionPersistence {
  /** Content this worker knows the store holds, per project. */
  private readonly stored = new Map<string, string>();
  private readonly lastWriteAt = new Map<string, number>();
  private pending: PendingCapture | null = null;
  private timer: unknown;
  private capturing = false;
  private warmup: {
    adapter: SessionAdapter;
    document: ProjectDocument;
    lineageDemand: readonly BodyId[] | undefined;
  } | null = null;
  private warmupTimer: unknown;
  private warming = false;
  /** Bumped by {@link forget}: a capture in flight then stores nothing. */
  private generation = 0;

  constructor(private readonly deps: KernelSessionPersistenceDeps) {}

  /**
   * The stored session to offer this sync, if the adapter does not already
   * hold this project and one is stored for exactly this content and build.
   * Any failure is a miss: the sync replays.
   */
  async offer(
    adapter: SessionAdapter,
    document: ProjectDocument,
    contentKey: string
  ): Promise<PersistedHistorySession | undefined> {
    if (!adapter.hasHistoryFor || adapter.hasHistoryFor(document.projectId))
      return undefined;
    const identity = this.deps.identity();
    if (identity === null) return undefined;
    let timer: unknown;
    try {
      const session = await Promise.race([
        this.deps.load(document.projectId, contentKey, identity),
        new Promise<null>((resolve) => {
          timer = this.deps.setTimer(
            () => resolve(null),
            KERNEL_SESSION_LOAD_BUDGET_MS
          );
        })
      ]);
      if (!session || !this.deps.isSession(session)) return undefined;
      this.stored.set(document.projectId, contentKey);
      return session;
    } catch {
      return undefined;
    } finally {
      this.deps.clearTimer(timer);
    }
  }

  /** What the adapter made of the session offered for `contentKey`. */
  noteOutcome(
    projectId: string,
    contentKey: string,
    outcome: 'restored' | 'rejected' | undefined
  ): void {
    if (outcome === 'restored') {
      void this.deps.touch(projectId).catch(() => undefined);
    } else if (outcome === 'rejected') {
      // The same content would be captured, stored and rejected again on
      // every reopen: mark it instead, here and in the store.
      this.stored.set(projectId, contentKey);
      if (this.pending?.document.projectId === projectId) this.cancel();
      const identity = this.deps.identity();
      if (identity !== null)
        void this.deps
          .reject(projectId, contentKey, identity)
          .catch(() => undefined);
    }
  }

  /**
   * The project closed, or the live document is not one to persist (a
   * shared link's model, someone else's project): drops the scheduled
   * capture and warm-up, and a capture already running stores nothing.
   */
  forget(): void {
    this.generation += 1;
    this.cancel();
    this.dropWarmup();
  }

  /** A live, complete result of this content: capture it once idle. */
  schedule(
    adapter: SessionAdapter,
    document: ProjectDocument,
    contentKey: string
  ): void {
    if (!adapter.captureHistorySession) return;
    if (this.stored.get(document.projectId) === contentKey) {
      if (this.pending?.document.projectId === document.projectId)
        this.cancel();
      return;
    }
    this.pending = { adapter, document, contentKey };
    this.arm();
  }

  /**
   * After a live result whose history kernel came from a stored session:
   * rebuild its checkpoint table once idle. A newer result replaces it.
   */
  scheduleWarmup(
    adapter: SessionAdapter,
    document: ProjectDocument,
    lineageDemand: readonly BodyId[] | undefined
  ): void {
    if (
      !adapter.warmHistory ||
      !adapter.needsHistoryWarmup?.(document.projectId)
    ) {
      this.dropWarmup();
      return;
    }
    this.warmup = { adapter, document, lineageDemand };
    this.armWarmup();
  }

  /**
   * Forgets the warm-up target: a live result that is not the one to warm
   * (a draft, whose refinement schedules again; a transient result) must not
   * leave an older revision to be replayed and swapped in.
   */
  dropWarmup(): void {
    this.warmup = null;
    if (this.warmupTimer !== undefined) this.deps.clearTimer(this.warmupTimer);
    this.warmupTimer = undefined;
  }

  private armWarmup(): void {
    if (!this.warmup) return;
    if (this.warmupTimer !== undefined) this.deps.clearTimer(this.warmupTimer);
    const serial = this.deps.workSerial();
    this.warmupTimer = this.deps.setTimer(() => {
      this.warmupTimer = undefined;
      if (serial !== this.deps.workSerial() || this.capturing || this.warming) {
        this.armWarmup();
        return;
      }
      void this.warm(serial);
    }, KERNEL_SESSION_WARMUP_IDLE_MS);
  }

  private async warm(serial: number): Promise<void> {
    const warmup = this.warmup;
    if (!warmup) return;
    const { adapter, document, lineageDemand } = warmup;
    if (!adapter.needsHistoryWarmup?.(document.projectId)) {
      this.warmup = null;
      return;
    }
    this.warming = true;
    const started = this.deps.now();
    try {
      const warmed = await adapter.warmHistory!(document, {
        cancellation: { isCancelled: () => serial !== this.deps.workSerial() },
        yieldControl: this.deps.yieldControl(),
        ...(lineageDemand ? { lineageDemand } : {})
      });
      this.deps.report?.({
        kind: 'warmup',
        warmed,
        ms: Math.round(this.deps.now() - started)
      });
      // Done, or refused without new work (the kernel no longer holds this
      // document, a failure): nothing left to retry for this target.
      if (
        this.warmup === warmup &&
        (warmed || serial === this.deps.workSerial())
      )
        this.warmup = null;
    } catch {
      // Idle work: a failure leaves the restored kernel as it was.
      if (this.warmup === warmup) this.warmup = null;
    } finally {
      this.warming = false;
    }
    // Cancelled or superseded: try again at the next idle moment.
    if (this.warmup) this.armWarmup();
  }

  /** Drops a scheduled capture (another project, a disposed kernel). */
  cancel(): void {
    this.pending = null;
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    const pending = this.pending;
    if (!pending) return;
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    const lastWrite = this.lastWriteAt.get(pending.document.projectId);
    const delay = Math.max(
      KERNEL_SESSION_IDLE_MS,
      lastWrite === undefined
        ? 0
        : lastWrite + KERNEL_SESSION_MIN_INTERVAL_MS - this.deps.now()
    );
    const serial = this.deps.workSerial();
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      // Overtaken by new work: wait for the next idle moment. A newer
      // result replaces `pending` through `schedule`.
      if (serial !== this.deps.workSerial() || this.capturing) {
        this.arm();
        return;
      }
      void this.capture();
    }, delay);
  }

  private async capture(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    const identity = this.deps.identity();
    if (identity === null) return;
    const { adapter, document, contentKey } = pending;
    const generation = this.generation;
    this.capturing = true;
    try {
      const session = await adapter.captureHistorySession!(document);
      // Not the kernel's current state any more, or not snapshotable: the
      // next complete result schedules again. Forgotten meanwhile (closed,
      // or no longer a document to persist): nothing is stored.
      if (!session || generation !== this.generation) return;
      this.lastWriteAt.set(document.projectId, this.deps.now());
      const bytes = this.deps.estimateBytes(session);
      const started = this.deps.now();
      const saved = await this.deps.save({
        projectId: document.projectId,
        contentKey,
        identity,
        bytes,
        session
      });
      this.deps.report?.({
        kind: 'capture',
        stored: saved,
        bytes,
        ms: Math.round(this.deps.now() - started)
      });
      if (saved) this.stored.set(document.projectId, contentKey);
      else this.stored.delete(document.projectId);
    } catch {
      // Storage is best effort; a reopen without a session replays.
    } finally {
      this.capturing = false;
    }
  }
}
