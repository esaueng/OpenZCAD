/**
 * Single-in-flight preview coalescing for direct-manipulation drags.
 *
 * A drag emits values far faster than the exact kernel can rebuild, so only
 * one rebuild is ever in flight and only the newest requested value survives
 * the wait. Every intermediate value is dropped on purpose: they describe a
 * pointer position the user has already moved past.
 *
 * When a rebuild is slow enough to feel bad, the previewer degrades for the
 * rest of the gesture rather than queueing frames the user will never see.
 * Dragging still works; it just commits on release without a live preview.
 */

/** A rebuild slower than this ends live preview for the current gesture. */
const DEFAULT_SLOW_FRAME_MS = 400;

export interface LivePreviewOptions<TDocument, TDerived> {
  /** Builds the document to preview, or null when the value cannot apply. */
  build(value: number): TDocument | null;
  /** Rebuilds derived geometry. Rejection just skips the frame. */
  derive(document: TDocument): Promise<TDerived>;
  /** Publishes a rebuilt preview, or null to clear it. The pair travels
   * together because a document without its derived geometry is not a
   * preview anyone can render. */
  publish(preview: { document: TDocument; derived: TDerived } | null): void;
  slowFrameMs?: number;
  /**
   * Keep consuming the latest coalesced value after a slow frame. Appropriate
   * for simple primitive edits whose visible dimension must catch up to the
   * pointer; expensive topology edits can retain the default fail-soft stop.
   */
  continueAfterSlow?: boolean;
  /**
   * Determines whether a requested scalar can produce a preview. Direct
   * dimensions default to positive-only; signed operations such as Extrude
   * can opt into accepting either direction while still rejecting zero.
   */
  acceptValue?(value: number): boolean;
  /** Injected so tests do not depend on wall-clock timing. */
  now?(): number;
}

export class LivePreview<TDocument, TDerived> {
  private options: LivePreviewOptions<TDocument, TDerived>;
  /** Increments per request; a result from any older pointer value is stale. */
  private token = 0;
  private inFlight = false;
  private pending: { value: number; token: number } | null = null;
  private slow = false;
  /** True once something has been published and not yet cleared. */
  private active = false;

  constructor(options: LivePreviewOptions<TDocument, TDerived>) {
    this.options = options;
  }

  /** True once a rebuild was slow enough to give up previewing this gesture. */
  get degraded(): boolean {
    return this.slow;
  }

  /** Queues a scalar when it satisfies this previewer's value policy. */
  request(value: number) {
    const accepted = this.options.acceptValue?.(value) ?? value > 0;
    if ((this.slow && !this.options.continueAfterSlow) || !accepted) {
      return;
    }
    this.pending = { value, token: ++this.token };
    this.active = true;
    if (!this.inFlight) {
      void this.run();
    }
  }

  private async run() {
    this.inFlight = true;
    const now = this.options.now ?? (() => performance.now());
    const slowFrameMs = this.options.slowFrameMs ?? DEFAULT_SLOW_FRAME_MS;
    try {
      while (this.pending !== null) {
        const { value, token } = this.pending;
        this.pending = null;
        const document = this.options.build(value);
        if (!document) {
          break;
        }
        const started = now();
        try {
          const derived = await this.options.derive(document);
          // A newer pointer value arrived, or the gesture ended, while we
          // waited. Never flash this obsolete geometry before the next build.
          if (token !== this.token || !this.active) {
            continue;
          }
          this.options.publish({ document, derived });
        } catch {
          // An invalid value simply skips this frame.
        }
        if (now() - started > slowFrameMs) {
          this.slow = true;
          if (!this.options.continueAfterSlow) {
            break;
          }
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Ends the gesture: invalidates anything in flight, clears the published
   * preview, and re-arms the slow-path guard for the next gesture.
   */
  clear() {
    this.token += 1;
    this.pending = null;
    this.slow = false;
    if (this.active) {
      this.active = false;
      this.options.publish(null);
    }
  }
}
