import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  FrameStatsMeter,
  HISTORY_LENGTH,
  formatCount,
  type FrameStatsSink,
  type FrameStatsSummary
} from '../lib/frameStats';
import { watchStageTheme } from '../lib/stagePalette';

/** How often the readout repaints; the meter itself sees every frame. */
export const FRAME_STATS_REPAINT_MS = 250;
const GRAPH_WIDTH_PX = HISTORY_LENGTH;
const GRAPH_HEIGHT_PX = 24;
/** The graph's full height, in frame milliseconds: two 60 Hz frames. */
const GRAPH_CEILING_MS = 1_000 / 30;
const BUDGET_60HZ_MS = 1_000 / 60;

function fixed(value: number | null, digits: number): string {
  return value === null ? '–' : value.toFixed(digits);
}

/** The readout's lines, in order. Pure, so tests read it without a canvas. */
export function frameStatsLines(summary: FrameStatsSummary): string[] {
  const rate =
    summary.idle || summary.fps === null
      ? 'idle'
      : `${Math.round(summary.fps)} fps`;
  return [
    rate,
    `frame ${fixed(summary.frameMs, 1)} ms · worst ${fixed(summary.worstFrameMs, 1)}`,
    `cpu ${fixed(summary.renderMs, 2)} ms`,
    `${summary.drawCalls === null ? '–' : summary.drawCalls} draws · ${
      summary.triangles === null ? '–' : formatCount(summary.triangles)
    } tris`
  ];
}

function drawGraph(
  canvas: HTMLCanvasElement,
  history: readonly (number | null)[],
  colors: { ink: string; muted: string; warning: string }
) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(GRAPH_WIDTH_PX * ratio);
  const height = Math.round(GRAPH_HEIGHT_PX * ratio);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, GRAPH_WIDTH_PX, GRAPH_HEIGHT_PX);
  // The 60 Hz budget: bars that cross it are frames that missed a vsync.
  const budgetY =
    GRAPH_HEIGHT_PX - (BUDGET_60HZ_MS / GRAPH_CEILING_MS) * GRAPH_HEIGHT_PX;
  context.fillStyle = colors.muted;
  context.globalAlpha = 0.5;
  context.fillRect(0, Math.round(budgetY), GRAPH_WIDTH_PX, 1);
  context.globalAlpha = 1;
  // Newest frame on the right edge.
  const offset = GRAPH_WIDTH_PX - history.length;
  for (let index = 0; index < history.length; index += 1) {
    const interval = history[index];
    if (interval === null || interval === undefined) continue;
    const barHeight = Math.max(
      1,
      Math.min(1, interval / GRAPH_CEILING_MS) * GRAPH_HEIGHT_PX
    );
    context.fillStyle =
      interval > BUDGET_60HZ_MS * 1.5 ? colors.warning : colors.ink;
    context.fillRect(offset + index, GRAPH_HEIGHT_PX - barHeight, 1, barHeight);
  }
}

function readGraphColors(canvas: HTMLCanvasElement) {
  const styles = window.getComputedStyle(canvas);
  const read = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    ink: read('--color-stage-ink', '#ebedef'),
    muted: read('--color-stage-ink-muted', '#9ba2ab'),
    warning: read('--color-warning', '#e0a84f')
  };
}

/**
 * The frame rate overlay (Settings → Advanced → Frame rate overlay). The
 * viewer hands every drawn frame to `sinkRef`; the readout repaints a few
 * times a second by writing text straight into its own nodes, so leaving it
 * on costs the workspace no React renders.
 */
export function ViewportFrameStats({
  sinkRef
}: {
  sinkRef: MutableRefObject<FrameStatsSink | null>;
}) {
  const lineRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const graphRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const meter = new FrameStatsMeter();
    const sink: FrameStatsSink = (sample) => meter.record(sample);
    sinkRef.current = sink;
    let colors: ReturnType<typeof readGraphColors> | null = null;
    const stopWatchingTheme = watchStageTheme(() => {
      colors = null;
    });
    const repaint = () => {
      const summary = meter.summarize(performance.now());
      const lines = frameStatsLines(summary);
      lines.forEach((text, index) => {
        const node = lineRefs.current[index];
        if (node && node.textContent !== text) node.textContent = text;
      });
      rootRef.current?.toggleAttribute('data-idle', summary.idle);
      const canvas = graphRef.current;
      if (canvas) {
        colors ??= readGraphColors(canvas);
        drawGraph(canvas, meter.history, colors);
      }
    };
    repaint();
    const timer = window.setInterval(repaint, FRAME_STATS_REPAINT_MS);
    return () => {
      window.clearInterval(timer);
      stopWatchingTheme();
      if (sinkRef.current === sink) sinkRef.current = null;
    };
  }, [sinkRef]);

  return (
    <div
      ref={rootRef}
      className="viewport-frame-stats"
      role="status"
      aria-label="Frame rate"
      aria-live="off"
      data-idle=""
    >
      {[0, 1, 2, 3].map((index) => (
        <span
          key={index}
          ref={(node) => {
            lineRefs.current[index] = node;
          }}
          className={
            index === 0
              ? 'viewport-frame-stats-rate'
              : 'viewport-frame-stats-line'
          }
        />
      ))}
      <canvas
        ref={graphRef}
        className="viewport-frame-stats-graph"
        aria-hidden="true"
      />
    </div>
  );
}
