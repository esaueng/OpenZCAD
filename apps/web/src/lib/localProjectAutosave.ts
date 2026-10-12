import type { ProjectDocument } from '@openzcad/shared';

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
  onSaved(document: ProjectDocument, newerQueued: boolean): void;
  onError(error: unknown): void;
  onDirtyChange(dirty: boolean): void;
}

/** One device writer: coalesce waiting snapshots, never overlap transactions,
 * and keep failed work dirty. A flush includes the active write and its tail. */
export class LocalProjectAutosave {
  private queued: ProjectDocument | null = null;
  private scheduled: ProjectDocument | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: LocalProjectAutosaveOptions) {}

  get dirty(): boolean {
    return this.queued !== null || this.inFlight !== null;
  }

  /** Returns true for a canonical change, which must bypass the derived debounce. */
  enqueue(document: ProjectDocument): boolean {
    const canonicalChange = !sameLocalProjectContent(this.scheduled, document);
    this.scheduled = document;
    this.queued = document;
    this.options.onDirtyChange(true);
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
        const document = this.queued;
        this.queued = null;
        try {
          const saved = await this.options.write(document);
          if (saved) this.options.onSaved(document, this.queued !== null);
        } catch (error) {
          // A later snapshot already includes this edit. Never repark the old
          // one over it, and never drop the only copy on a failed device write.
          this.queued ??= document;
          this.options.onError(error);
          // An awaited flush is a durability barrier for in-app departure and
          // identity transfer too. It must not release ownership after failure.
          throw error;
        }
      }
    } finally {
      this.inFlight = null;
      this.options.onDirtyChange(this.dirty);
    }
  }
}
