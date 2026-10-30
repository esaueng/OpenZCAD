/**
 * One drawn viewport frame, as the viewer's render loop reports it to the
 * frame rate overlay. `at` is the loop's `performance.now()` for the frame.
 */
export interface FrameSample {
  at: number;
  /** CPU time spent inside `renderer.render` for this frame. */
  renderMs: number;
  drawCalls: number;
  triangles: number;
}

export type FrameStatsSink = (sample: FrameSample) => void;

export interface FrameStatsSummary {
  /**
   * True when no frame has been drawn for `IDLE_AFTER_MS`. The viewer only
   * renders on demand, so a still scene draws nothing at all, and a frame
   * rate of zero would read as a hang rather than as rest.
   */
  idle: boolean;
  /** Frames per second over the window, or null with no interval yet. */
  fps: number | null;
  /** Mean time between consecutive frames in the window. */
  frameMs: number | null;
  /** The longest gap between consecutive frames in the window: the hitch. */
  worstFrameMs: number | null;
  /** Mean CPU time inside `renderer.render` over the window. */
  renderMs: number | null;
  drawCalls: number | null;
  triangles: number | null;
}

/** How far back the summary looks. */
export const FRAME_WINDOW_MS = 1_000;
/** No frame for this long and the overlay reports the viewer at rest. */
export const IDLE_AFTER_MS = 500;
/**
 * A gap longer than this between two frames is the viewer resting between
 * gestures, not a slow frame: an on-demand loop that sat still for three
 * seconds did not draw a three-second frame.
 */
export const BURST_GAP_MS = 250;
/** Frame intervals kept for the overlay's sparkline. */
export const HISTORY_LENGTH = 90;

/**
 * Rolling frame statistics for the viewport's frame rate overlay. Recording
 * is an array push per frame and reads no clock of its own; summaries are
 * computed only when the overlay repaints, a few times a second.
 */
export class FrameStatsMeter {
  private readonly samples: FrameSample[] = [];
  /**
   * Interval before each sample (null when it began a new burst), kept for
   * the sparkline. Oldest first.
   */
  readonly history: (number | null)[] = [];
  private last: FrameSample | null = null;

  record(sample: FrameSample): void {
    const interval = this.last === null ? null : sample.at - this.last.at;
    this.last = sample;
    this.samples.push(sample);
    this.history.push(
      interval !== null && interval <= BURST_GAP_MS ? interval : null
    );
    if (this.history.length > HISTORY_LENGTH) this.history.shift();
    this.prune(sample.at);
  }

  summarize(now: number): FrameStatsSummary {
    this.prune(now);
    const idle = this.last === null || now - this.last.at > IDLE_AFTER_MS;
    const samples = this.samples;
    let intervalSum = 0;
    let intervals = 0;
    let worst = 0;
    let renderSum = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]!;
      renderSum += sample.renderMs;
      if (index === 0) continue;
      const interval = sample.at - samples[index - 1]!.at;
      if (interval > BURST_GAP_MS) continue;
      intervalSum += interval;
      intervals += 1;
      worst = Math.max(worst, interval);
    }
    const frameMs = intervals > 0 ? intervalSum / intervals : null;
    return {
      idle,
      fps: frameMs !== null && frameMs > 0 ? 1_000 / frameMs : null,
      frameMs,
      worstFrameMs: intervals > 0 ? worst : null,
      renderMs: samples.length > 0 ? renderSum / samples.length : null,
      // The last frame drawn, however long ago: a still scene still has
      // a load, and it is the one the next frame will pay.
      drawCalls: this.last?.drawCalls ?? null,
      triangles: this.last?.triangles ?? null
    };
  }

  private prune(now: number): void {
    const oldest = now - FRAME_WINDOW_MS;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop]!.at < oldest) {
      drop += 1;
    }
    if (drop > 0) this.samples.splice(0, drop);
  }
}

/** "1.2M", "48.3k", "512" — triangle counts at a glance. */
export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}
