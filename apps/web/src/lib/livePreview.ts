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
 *
 * Release is where a slow rebuild costs most. The geometry worker serialises
 * kernel work and cannot abandon a rebuild it has started, so a commit queued
 * behind a preview waits for that preview first. Two things keep that to one
 * rebuild: `running` hands a commit at the same value the rebuild already in
 * flight, and on a body whose earlier rebuilds were slow, or that is
 * predictably slow before any (`expectedFrameMs`), `slowSettleMs` holds
 * rebuilds until the hand rests, so a release mid-motion finds no stale
 * rebuild ahead of it.
 */

/** A rebuild slower than this ends live preview for the current gesture. */
const DEFAULT_SLOW_FRAME_MS = 400;

export interface LivePreviewOptions<TDocument, TDerived> {
  /** Builds the document to preview, or null when the value cannot apply. */
  build(value: number): TDocument | null;
  /** Rebuilds derived geometry. Rejection just skips the frame. */
  derive(document: TDocument, signal: AbortSignal): Promise<TDerived>;
  /** Cancel obsolete worker frames instead of completing their analysis. */
  cancelSuperseded?: boolean;
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
  /**
   * While `expectedFrameMs` predicts a slow gesture, a rebuild starts only
   * after the newest value has been held this long. The first rebuild that
   * lands within `slowFrameMs` lifts the wait for the rest of the gesture.
   * A gesture that finds a slow frame on its own does not start waiting: one
   * slow frame is as often a cold kernel as a slow body.
   */
  slowSettleMs?: number;
  /**
   * Expected rebuild time for what the next request edits: measured in
   * earlier gestures, or estimated from the body before any was measured.
   * Above `slowFrameMs` the gesture degrades before its first rebuild
   * instead of learning it from a slow frame a release would then have to
   * wait behind.
   */
  expectedFrameMs?(): number | undefined;
  /** Injected so tests do not depend on wall-clock timing. */
  now?(): number;
}

/** A rebuild that has started and not yet settled. */
export interface RunningPreview<TDocument, TDerived> {
  value: number;
  document: TDocument;
  /** The consumer's own `derive` promise for `document`. */
  result: Promise<TDerived>;
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
  private pending: {
    value: number;
    token: number;
    requestedAt: number;
  } | null = null;
  private runningPreview: RunningPreview<TDocument, TDerived> | null = null;
  private abort: AbortController | null = null;
  private slow = false;
  /** Predicted slow: hold rebuilds until the hand rests (`slowSettleMs`). */
  private settle = false;
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

  /**
   * The rebuild in flight, until it settles — including one that `stop()` or
   * `clear()` already invalidated, which will never publish but whose result
   * still answers a commit of the same edit. A commit that awaits it pays for
   * one exact rebuild instead of queuing a second one behind it.
   */
  get running(): RunningPreview<TDocument, TDerived> | null {
    return this.runningPreview;
  }

  private get slowFrameMs(): number {
    return this.options.slowFrameMs ?? DEFAULT_SLOW_FRAME_MS;
  }

  private degrade() {
    if (!this.slow) this.options.onDegrade?.();
    this.slow = true;
  }

  /** Queues a scalar when it satisfies this previewer's value policy. */
  request(value: number) {
    const accepted = this.options.acceptValue?.(value) ?? value > 0;
    if (!accepted) {
      return;
    }
    if (!this.slow) {
      const expected = this.options.expectedFrameMs?.();
      if (expected !== undefined && expected > this.slowFrameMs) {
        this.degrade();
        this.settle = true;
      }
    }
    if (this.slow && !this.options.continueAfterSlow) {
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
    this.pending = { value, token: ++this.token, requestedAt: this.now() };
    if (this.options.cancelSuperseded) this.abort?.abort();
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
    const rest = this.settle ? (this.options.slowSettleMs ?? 0) : 0;
    // A newer request re-runs this when the timer fires, so the wait always
    // measures from the newest value: the hand has to rest, not just pause.
    const startAt =
      rest > 0
        ? Math.max(this.nextStartAt, this.pending.requestedAt + rest)
        : this.nextStartAt;
    const delay = startAt - this.now();
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
    // Only a completed rebuild measures the body; a null build does not.
    let rebuilt = false;
    const current = () =>
      this.active &&
      generation === this.generation &&
      (!document || (this.options.isCurrent?.(document) ?? true));
    try {
      document = this.options.build(request.value);
      if (!document) return;
      const abort = new AbortController();
      this.abort = abort;
      const result = this.options.derive(document, abort.signal);
      this.runningPreview = { value: request.value, document, result };
      const derived = await result;
      rebuilt = true;
      if (
        !abort.signal.aborted &&
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
      const aborted = this.abort?.signal.aborted ?? false;
      this.runningPreview = null;
      this.abort = null;
      if (current()) {
        const interval = this.options.minIntervalMs ?? 0;
        // Leave a bounded presentation/input yield, not another rebuild-sized
        // pause. Exact work runs in a worker: doubling its elapsed time made
        // a 150 ms edit with a 45 ms installation advance only every 390 ms.
        const presentationYield = Math.min(
          32,
          Math.max(8, this.options.presentationTimeMs?.() ?? 0)
        );
        this.nextStartAt =
          interval > 0
            ? Math.max(started + interval, this.now() + presentationYield)
            : 0;
        // An abort may reject before synchronous worker work finishes. Keep
        // the start interval so pointer events still coalesce, but do not
        // mistake cancellation latency for the cost of a completed frame.
        if (!aborted) {
          const elapsed = this.now() - started;
          if (elapsed > this.slowFrameMs) {
            this.degrade();
            if (!this.options.continueAfterSlow) this.pending = null;
          } else if (rebuilt) {
            // The prediction was stale (the body got faster, or the earlier
            // frames were cold): stop making the hand rest.
            this.settle = false;
          }
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
    this.abort?.abort();
    this.pending = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.nextStartAt = 0;
    this.lastValue = null;
    this.slow = false;
    this.settle = false;
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
