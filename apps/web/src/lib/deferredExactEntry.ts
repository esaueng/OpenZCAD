interface DeferredExactEntryOptions<Owner> {
  isCurrent(owner: Owner): boolean;
  sameOwner(left: Owner, right: Owner): boolean;
  open(): boolean;
  seed(initial: string): void;
  schedule(retry: () => void): () => void;
}

/** Holds typed input across the frame that installs a command's viewport rig. */
export class DeferredExactEntry<Owner> {
  private pending: { owner: Owner; initial?: string } | null = null;
  private cancelRetry: (() => void) | null = null;

  constructor(private readonly options: DeferredExactEntryOptions<Owner>) {}

  push(owner: Owner, initial?: string): void {
    if (this.pending && this.options.sameOwner(this.pending.owner, owner)) {
      if (initial !== undefined)
        this.pending.initial = (this.pending.initial ?? '') + initial;
    } else {
      this.cancel();
      this.pending = { owner, initial };
    }
    this.retry();
  }

  cancel(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.pending = null;
  }

  private retry(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
    const pending = this.pending;
    if (!pending) return;
    if (!this.options.isCurrent(pending.owner)) {
      this.cancel();
      return;
    }
    if (this.options.open()) {
      this.pending = null;
      if (pending.initial !== undefined) this.options.seed(pending.initial);
      return;
    }
    this.cancelRetry = this.options.schedule(() => {
      this.cancelRetry = null;
      this.retry();
    });
  }
}
