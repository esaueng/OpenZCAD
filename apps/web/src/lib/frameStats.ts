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
/** Frame intervals kept for the overlay's frame time graph. */
export const HISTORY_LENGTH = 240;
/**
 * Active frame intervals the recent statistics (average, 1% and 0.1% lows,
 * p99) are taken over: about half a minute of steady orbiting at 60 Hz.
 */
export const RECENT_INTERVALS = 2_000;
/** Seconds of frame rate the overlay's FPS graph spans. */
export const FPS_SERIES_SECONDS = 30;
/** A frame longer than this is a hitch: half again past a 60 Hz frame. */
export const HITCH_MS = 25;

/**
 * Statistics over the most recent active frames. Rest between gestures is
 * excluded, so a still scene neither lowers the average nor counts as a
 * low; every value is null until there is at least one interval.
 */
export interface FrameStatsRecent {
  /** Active intervals the statistics cover, up to `RECENT_INTERVALS`. */
  frames: number;
  /** Frames per second from the mean interval. */
  averageFps: number | null;
  /** Frame rate over the slowest 1% of intervals (their mean). */
  low1Fps: number | null;
  /** Frame rate over the slowest 0.1% of intervals (their mean). */
  low01Fps: number | null;
  /** Frame rate of the single slowest interval. */
  minFps: number | null;
  /** 99th percentile interval: 99% of frames were at least this fast. */
  p99FrameMs: number | null;
  worstFrameMs: number | null;
  /** Intervals longer than `HITCH_MS`. */
  hitches: number;
}

/**
 * Mean frame rate of the slowest `fraction` of `sorted` (ascending
 * intervals). At least one interval is always taken, so a short run's 0.1%
 * low is its worst frame rather than nothing.
 */
function lowFps(sorted: Float64Array, fraction: number): number {
  const take = Math.max(1, Math.floor(sorted.length * fraction));
  let sum = 0;
  for (let index = sorted.length - take; index < sorted.length; index += 1) {
    sum += sorted[index]!;
  }
  return 1_000 / (sum / take);
}

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
  /** Ring of the last `RECENT_INTERVALS` active intervals. */
  private readonly recent = new Float64Array(RECENT_INTERVALS);
  private recentCount = 0;
  private recentNext = 0;
  /**
   * Per wall-clock second: the second's index (`floor(at / 1000)`), its
   * interval sum and count. One slot per second of the FPS graph.
   */
  private readonly seconds = new Float64Array(FPS_SERIES_SECONDS * 3).fill(-1);

  record(sample: FrameSample): void {
    const interval = this.last === null ? null : sample.at - this.last.at;
    this.last = sample;
    this.samples.push(sample);
    const active = interval !== null && interval <= BURST_GAP_MS;
    this.history.push(active ? interval : null);
    if (this.history.length > HISTORY_LENGTH) this.history.shift();
    if (active) {
      this.recent[this.recentNext] = interval;
      this.recentNext = (this.recentNext + 1) % RECENT_INTERVALS;
      this.recentCount = Math.min(this.recentCount + 1, RECENT_INTERVALS);
      const second = Math.floor(sample.at / 1_000);
      const slot = (second % FPS_SERIES_SECONDS) * 3;
      if (this.seconds[slot] !== second) {
        this.seconds[slot] = second;
        this.seconds[slot + 1] = 0;
        this.seconds[slot + 2] = 0;
      }
      this.seconds[slot + 1] = this.seconds[slot + 1]! + interval;
      this.seconds[slot + 2] = this.seconds[slot + 2]! + 1;
    }
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

  /**
   * Statistics over the recent active intervals. Sorts a copy, so call it
   * at the overlay's repaint rate, not per frame.
   */
  recentStats(): FrameStatsRecent {
    const count = this.recentCount;
    if (count === 0) {
      return {
        frames: 0,
        averageFps: null,
        low1Fps: null,
        low01Fps: null,
        minFps: null,
        p99FrameMs: null,
        worstFrameMs: null,
        hitches: 0
      };
    }
    const sorted = this.recent.slice(0, count).sort();
    let sum = 0;
    let hitches = 0;
    for (let index = 0; index < count; index += 1) {
      const interval = sorted[index]!;
      sum += interval;
      if (interval > HITCH_MS) hitches += 1;
    }
    const worst = sorted[count - 1]!;
    return {
      frames: count,
      averageFps: 1_000 / (sum / count),
      low1Fps: lowFps(sorted, 0.01),
      low01Fps: lowFps(sorted, 0.001),
      minFps: 1_000 / worst,
      p99FrameMs: sorted[Math.min(count - 1, Math.floor(count * 0.99))]!,
      worstFrameMs: worst,
      hitches
    };
  }

  /**
   * Frames per second for each of the last `FPS_SERIES_SECONDS` wall-clock
   * seconds up to `now`, oldest first; null for a second with no active
   * frame, so the graph breaks over rest instead of dropping to zero.
   */
  fpsSeries(now: number): (number | null)[] {
    const current = Math.floor(now / 1_000);
    const series: (number | null)[] = [];
    for (
      let second = current - FPS_SERIES_SECONDS + 1;
      second <= current;
      second += 1
    ) {
      const slot =
        (((second % FPS_SERIES_SECONDS) + FPS_SERIES_SECONDS) %
          FPS_SERIES_SECONDS) *
        3;
      const sum = this.seconds[slot + 1]!;
      const frames = this.seconds[slot + 2]!;
      series.push(
        this.seconds[slot] === second && frames > 0 && sum > 0
          ? 1_000 / (sum / frames)
          : null
      );
    }
    return series;
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
