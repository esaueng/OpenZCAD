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

export interface LocalProjectAutosaveOptions {
  /** False means this tab is not allowed to persist the document. */
  write(document: ProjectDocument): Promise<boolean>;
  /** Emitted only when canonical work becomes durable; newerQueued excludes cache writes. */
  onSaved(document: ProjectDocument, newerQueued: boolean): void;
  onError(error: unknown): void;
  onDirtyChange(dirty: boolean): void;
}

/** One device writer: coalesce waiting snapshots, never overlap transactions,
 * and keep failed work dirty. A flush includes the active write and its tail. */
export class LocalProjectAutosave {
  private queued: { document: ProjectDocument; revision: number } | null = null;
  /** Internal canonical generations, independent of document version metadata. */
  private revision = 0;
  private savedRevision = 0;
  private scheduled: ProjectDocument | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: LocalProjectAutosaveOptions) {}

  get dirty(): boolean {
    return this.revision !== this.savedRevision;
  }

  /** Returns true for a canonical change, which must bypass the derived debounce. */
  enqueue(document: ProjectDocument): boolean {
    const canonicalChange = !sameLocalProjectContent(this.scheduled, document);
    const wasDirty = this.dirty;
    if (canonicalChange) this.revision += 1;
    this.scheduled = document;
    this.queued = { document, revision: this.revision };
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

  private async drain(): Promise<void> {
    try {
      while (this.queued) {
        const snapshot = this.queued;
        const { document, revision } = snapshot;
        this.queued = null;
        try {
          const saved = await this.options.write(document);
          const canonicalWrite = revision !== this.savedRevision;
          const wasDirty = this.dirty;
          this.savedRevision = revision;
          if (this.dirty !== wasDirty) this.options.onDirtyChange(this.dirty);
          // Cache refreshes are durable too, but they do not acknowledge a
          // new edit or change the workspace's storage status.
          if (saved && canonicalWrite)
            this.options.onSaved(document, this.dirty);
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
      }
    } finally {
      this.inFlight = null;
    }
  }
}
