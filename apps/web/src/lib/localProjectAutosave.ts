import type { ProjectDocument } from '@openzcad/shared';
import { localAutosaveFailedStatus } from './localAutosaveFailure';

/** A failed durability barrier keeps its recovery guidance through any
 * operation's catch block; the original storage diagnostic remains available. */
export class LocalProjectSaveError extends Error {
  constructor(cause: unknown) {
    super(localAutosaveFailedStatus(cause), { cause });
    this.name = 'LocalProjectSaveError';
  }
}

/**
 * A device write this tab refused because it no longer holds the project
 * (`write` answered `'refused'`). The work stays queued and dirty: it is
 * not on this device, so an awaited flush must not be taken as durable.
 */
export class LocalProjectSaveRefusedError extends Error {
  constructor(
    /** The refused snapshot, exactly as queued: the work still unsaved. */
    readonly document: ProjectDocument,
    /** Stable across cache-only rebuilds of the same pending edit. */
    readonly key: object
  ) {
    super(
      'This tab no longer holds the project, so its latest edits were not saved on this device.'
    );
    this.name = 'LocalProjectSaveRefusedError';
  }
}

/** Derived rebuilds retain the canonical fields' references. Include history,
 * checkpoints, ownership and version here, even when geometry is unchanged. */
export function sameLocalProjectContent(
  previous: ProjectDocument | null,
  next: ProjectDocument
): boolean {
  if (!previous) return false;
  const keys = Object.keys(next).filter((key) => key !== 'derived');
  return (
    keys.length ===
      Object.keys(previous).filter((key) => key !== 'derived').length &&
    keys.every((key) =>
      Object.is(
        previous[key as keyof ProjectDocument],
        next[key as keyof ProjectDocument]
      )
    )
  );
}

/**
 * True: written. False: not this tab's to write (a read-only tab, a shared
 * link), so there is nothing of its own to keep. `'refused'`: this tab
 * meant to save it but no longer holds the project, so the work is kept.
 */
export type LocalProjectWriteResult = boolean | 'refused';

export interface LocalProjectAutosaveOptions {
  write(document: ProjectDocument): Promise<LocalProjectWriteResult>;
  /** Emitted only when canonical work becomes durable; newerQueued excludes cache writes. */
  onSaved(document: ProjectDocument, newerQueued: boolean): void;
  onError(error: unknown): void;
  onDirtyChange(dirty: boolean): void;
}

/** One device writer: coalesce waiting snapshots, never overlap transactions,
 * and keep failed work dirty. A flush includes the active write and its tail. */
export class LocalProjectAutosave {
  private queued: {
    document: ProjectDocument;
    revision: number;
    key: object;
  } | null = null;
  /** Internal canonical generations, independent of document version metadata. */
  private revision = 0;
  private revisionKey = {};
  private savedRevision = 0;
  private scheduled: ProjectDocument | null = null;
  private inFlight: Promise<void> | null = null;
  /** Refused snapshots kept durably elsewhere ({@link keptElsewhere}). */
  private readonly kept = new WeakSet<object>();

  constructor(private readonly options: LocalProjectAutosaveOptions) {}

  get dirty(): boolean {
    return this.revision !== this.savedRevision;
  }

  /** Returns true for a canonical change, which must bypass the derived debounce. */
  enqueue(document: ProjectDocument): boolean {
    const canonicalChange = !sameLocalProjectContent(this.scheduled, document);
    const wasDirty = this.dirty;
    if (canonicalChange) {
      this.revision += 1;
      this.revisionKey = {};
    }
    this.scheduled = document;
    this.queued = {
      document,
      revision: this.revision,
      key: this.revisionKey
    };
    if (this.dirty !== wasDirty) this.options.onDirtyChange(this.dirty);
    return canonicalChange;
  }

  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.queued) return Promise.resolve();
    // Start on a microtask so even a synchronously throwing writer has its
    // in-flight promise registered before the failure/finally path runs.
    this.inFlight = Promise.resolve().then(() => this.drain());
    return this.inFlight;
  }

  /**
   * Settles a refused snapshot (`LocalProjectSaveRefusedError.document`)
   * that has been written durably elsewhere — a recovery copy under a new
   * project id — so it no longer holds the workspace dirty. Only that exact
   * snapshot is settled: newer queued work stays queued and dirty. A refusal
   * of it still in flight settles when it lands.
   */
  keptElsewhere(refused: LocalProjectSaveRefusedError): void {
    this.kept.add(refused.key);
    const queued = this.queued;
    if (queued?.key !== refused.key) return;
    this.queued = null;
    this.settle(queued.revision);
  }

  private settle(revision: number): void {
    const wasDirty = this.dirty;
    this.savedRevision = Math.max(this.savedRevision, revision);
    if (this.dirty !== wasDirty) this.options.onDirtyChange(this.dirty);
  }

  private async drain(): Promise<void> {
    try {
      while (this.queued) {
        const snapshot = this.queued;
        const { document, revision } = snapshot;
        this.queued = null;
        let refused = false;
        try {
          const saved = await this.options.write(document);
          if (saved === 'refused') {
            refused = true;
          } else {
            const canonicalWrite = revision !== this.savedRevision;
            const wasDirty = this.dirty;
            this.savedRevision = revision;
            if (this.dirty !== wasDirty) this.options.onDirtyChange(this.dirty);
            // Cache refreshes are durable too, but they do not acknowledge a
            // new edit or change the workspace's storage status.
            if (saved && canonicalWrite)
              this.options.onSaved(document, this.dirty);
          }
        } catch (error) {
          // A later snapshot already includes this edit. Never repark the old
          // one over it, and never drop the only copy on a failed device write.
          this.queued ??= snapshot;
          // The canonical document is already safe. A cache-only failure can
          // retry later without claiming that the user's edits were lost.
          if (!this.dirty) return;
          this.options.onError(error);
          // An awaited flush is a durability barrier for in-app departure and
          // identity transfer too. It must not release ownership after failure.
          throw new LocalProjectSaveError(error);
        }
        if (refused && this.kept.has(snapshot.key)) {
          // Refused here, but already kept as a recovery copy meanwhile.
          this.settle(revision);
          continue;
        }
        if (refused) {
          // Not written, and no longer this tab's to write: kept (never over
          // a newer snapshot) and dirty, so departure sees unsaved work and
          // a write that holds the project again can still save it.
          this.queued ??= snapshot;
          if (!this.dirty) return;
          // A later edit can reach the queue while the ownership answer is
          // pending. Recover that edit, which contains this earlier one.
          const pending =
            this.queued.document.projectId === document.projectId
              ? this.queued
              : snapshot;
          throw new LocalProjectSaveRefusedError(pending.document, pending.key);
        }
      }
    } finally {
      this.inFlight = null;
    }
  }
}

/**
 * A departure barrier over `flush`: rejects for a failed device write, as
 * `flush` does, but lets a refused one through after `onRefused`. A refused
 * snapshot can never be written by this tab (another tab holds the project,
 * or this one gave it up), so holding every later navigation on it would
 * strand the workspace; it stays dirty, so closing the page still warns.
 */
export async function departureFlush(
  flush: Promise<void>,
  onRefused: (error: LocalProjectSaveRefusedError) => void | Promise<void>
): Promise<void> {
  try {
    await flush;
  } catch (error) {
    if (!(error instanceof LocalProjectSaveRefusedError)) throw error;
    // Awaited: a departure that keeps the refused work as a recovery copy
    // continues only once that copy is durable, and stays if it fails.
    await onRefused(error);
  }
}
