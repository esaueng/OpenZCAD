/**
 * Single-in-flight preview coalescing for direct-manipulation drags.
 *
 * A drag emits values far faster than the exact kernel can rebuild, so only
 * one rebuild is ever in flight and only the newest requested value survives
 * the wait. Every intermediate value is dropped on purpose: they describe a
 * pointer position the user has already moved past.
 *
 * When a rebuild is slow enough to feel bad, the previewer reports it once.
 * A consumer that opts out of `continueAfterSlow` then stops previewing for
 * the rest of the gesture; one that opts in keeps rebuilding at whatever rate
 * the kernel allows, and `lagging` says whether the geometry is behind the
 * hand. Dragging works either way; release commits the final value.
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
  /**
   * Reports a current build/derive failure to interaction UI. Superseded
   * failures are intentionally silent for the same reason superseded geometry
   * is: neither describes the value the user is holding now.
   */
  onFailure?(failure: { error: unknown; value: number }): void;
  /**
   * Fired once when a gesture's rebuilds turn out too slow to keep previewing.
   * The geometry stops following the handle at that point, so whoever is
   * showing the value gets a chance to say so rather than leaving it looking
   * stuck.
   */
  onDegrade?(): void;
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
  /** Token of the newest value that has reached publish(). */
  private publishedToken = 0;

  constructor(options: LivePreviewOptions<TDocument, TDerived>) {
    this.options = options;
  }

  /** True once a rebuild was slow enough to give up previewing this gesture. */
  get degraded(): boolean {
    return this.slow;
  }

  /**
   * True while the newest requested value has not been published yet — the
   * hand is ahead of the geometry. Whoever shows the value can say so, and
   * stop saying so the moment the kernel catches up.
   */
  get lagging(): boolean {
    return this.active && this.token !== this.publishedToken;
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
        let document: TDocument | null;
        try {
          document = this.options.build(value);
        } catch (error) {
          if (token === this.token && this.active) {
            this.options.onFailure?.({ error, value });
          }
          continue;
        }
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
          this.publishedToken = token;
          this.options.publish({ document, derived });
        } catch (error) {
          // An invalid value skips this frame, but an interested interaction
          // may still render why it failed and prevent that value committing.
          if (token === this.token && this.active) {
            this.options.onFailure?.({ error, value });
          }
        }
        if (now() - started > slowFrameMs) {
          if (!this.slow) {
            this.options.onDegrade?.();
          }
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
    this.publishedToken = this.token;
    if (this.active) {
      this.active = false;
      this.options.publish(null);
    }
  }
}
