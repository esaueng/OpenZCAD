/**
 * Single-in-flight preview coalescing for direct-manipulation drags.
 *
 * A drag emits values far faster than the exact kernel can rebuild, so only
 * one rebuild is ever in flight and only the newest requested value survives
 * the wait. Progressive consumers can present completed work from the same
 * gesture while its next value is pending. Queued intermediate values are
 * dropped because they describe positions the pointer has already passed.
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
   * failures stay silent because they do not describe the current request.
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
  /** Advance within a gesture even when the pointer has requested a newer value. */
  publishIntermediate?: boolean;
  isCurrent?(document: TDocument): boolean;
  /** Minimum spacing between exact builds; zero preserves existing consumers. */
  minIntervalMs?: number;
  /** Last measured viewport installation cost, without a React state update. */
  presentationTimeMs?(): number;
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
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextStartAt = 0;
  private lastValue: number | null = null;
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
    if (
      this.options.publishIntermediate &&
      this.active &&
      this.lastValue === value
    ) {
      return;
    }
    this.lastValue = value;
    this.pending = { value, token: ++this.token };
    this.active = true;
    if (!this.inFlight) {
      this.schedule();
    }
  }

  private now() {
    return this.options.now?.() ?? performance.now();
  }

  private schedule() {
    if (this.inFlight || this.timer !== null || !this.pending) return;
    const delay = this.nextStartAt - this.now();
    if (delay > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.schedule();
      }, delay);
    } else {
      void this.run();
    }
  }

  private async run() {
    const request = this.pending;
    if (!request) return;
    this.pending = null;
    this.inFlight = true;
    const generation = this.generation;
    const started = this.now();
    let document: TDocument | null = null;
    const current = () =>
      this.active &&
      generation === this.generation &&
      (!document || (this.options.isCurrent?.(document) ?? true));
    try {
      document = this.options.build(request.value);
      if (!document) return;
      const derived = await this.options.derive(document);
      if (
        current() &&
        (this.options.publishIntermediate || request.token === this.token)
      ) {
        this.publishedToken = request.token;
        this.options.publish({ document, derived });
      }
    } catch (error) {
      // An older failure must not reject the value now under the pointer.
      if (current() && request.token === this.token) {
        this.options.onFailure?.({ error, value: request.value });
      }
    } finally {
      if (current()) {
        const elapsed = this.now() - started;
        const interval = this.options.minIntervalMs ?? 0;
        // Reserve idle time for input and drawing instead of saturating the
        // worker. Presentation is measured by the previous installed frame.
        this.nextStartAt =
          interval > 0
            ? started +
              Math.max(
                interval,
                2 * (elapsed + (this.options.presentationTimeMs?.() ?? 0))
              )
            : 0;
        if (elapsed > (this.options.slowFrameMs ?? DEFAULT_SLOW_FRAME_MS)) {
          if (!this.slow) this.options.onDegrade?.();
          this.slow = true;
          if (!this.options.continueAfterSlow) this.pending = null;
        }
      }
      this.inFlight = false;
      this.schedule();
    }
  }

  /** Invalidate work while retaining the displayed result during final validation. */
  stop() {
    this.generation += 1;
    this.token += 1;
    this.pending = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.nextStartAt = 0;
    this.lastValue = null;
    this.slow = false;
    this.publishedToken = this.token;
  }

  /**
   * Ends the gesture: invalidates anything in flight, clears the published
   * preview, and re-arms the slow-path guard for the next gesture.
   */
  clear() {
    this.stop();
    if (this.active) {
      this.active = false;
      this.options.publish(null);
    }
  }
}
