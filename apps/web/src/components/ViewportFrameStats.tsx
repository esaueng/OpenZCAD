import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { ChevronDown, ChevronUp, GripVertical, X } from 'lucide-react';
import {
  FPS_SERIES_SECONDS,
  FrameStatsMeter,
  HISTORY_LENGTH,
  HITCH_MS,
  formatCount,
  type FrameStatsRecent,
  type FrameStatsSink,
  type FrameStatsSummary
} from '../lib/frameStats';
import { watchStageTheme } from '../lib/stagePalette';

/** How often the readout repaints; the meter itself sees every frame. */
export const FRAME_STATS_REPAINT_MS = 250;
/**
 * Where the panel remembers its place and fold. A browser convenience, not
 * a preference: it stays out of the synced app settings.
 */
export const FRAME_STATS_PANEL_STORAGE_KEY = 'openzcad-frame-stats-panel:v1';
const GRAPH_WIDTH_PX = 260;
const FPS_GRAPH_HEIGHT_PX = 54;
/** The FPS graph's full height: room above a 120 Hz display's line. */
const FPS_GRAPH_CEILING = 140;
const FPS_GRAPH_LINES = [60, 120];
const FRAME_GRAPH_HEIGHT_PX = 44;
/** The frame time graph's full height, in frame milliseconds. */
const FRAME_GRAPH_CEILING_MS = 50;
const BUDGET_60HZ_MS = 1_000 / 60;

interface PanelPlace {
  x: number;
  y: number;
  collapsed: boolean;
}

function readPanelPlace(): Partial<PanelPlace> {
  try {
    const raw = window.localStorage.getItem(FRAME_STATS_PANEL_STORAGE_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as Partial<PanelPlace>;
    return {
      ...(Number.isFinite(value.x) && Number.isFinite(value.y)
        ? { x: value.x, y: value.y }
        : {}),
      collapsed: value.collapsed === true
    };
  } catch {
    return {};
  }
}

function writePanelPlace(place: Partial<PanelPlace>): void {
  try {
    window.localStorage.setItem(
      FRAME_STATS_PANEL_STORAGE_KEY,
      JSON.stringify({ ...readPanelPlace(), ...place })
    );
  } catch {
    // Private mode or a blocked store: the panel still moves for the visit.
  }
}

function fixed(value: number | null, digits: number): string {
  return value === null ? '–' : value.toFixed(digits);
}

function whole(value: number | null): string {
  return value === null ? '–' : String(Math.round(value));
}

/**
 * Every text field the panel shows, keyed by the `data-field` of the node
 * it fills. Pure, so tests read it without a canvas.
 */
export function frameStatsFields(
  summary: FrameStatsSummary,
  recent: FrameStatsRecent
): Record<string, string> {
  const live = !summary.idle && summary.fps !== null;
  return {
    rate: live ? String(Math.round(summary.fps!)) : 'idle',
    frame: live ? `${fixed(summary.frameMs, 1)} ms` : '– ms',
    average: whole(recent.averageFps),
    low1: whole(recent.low1Fps),
    low01: whole(recent.low01Fps),
    min: whole(recent.minFps),
    cpu: `${fixed(summary.renderMs, 2)} ms`,
    cpuFrame: `${fixed(summary.cpuMs, 2)} ms`,
    worst: `${fixed(recent.worstFrameMs, 1)} ms`,
    p99: `${fixed(recent.p99FrameMs, 1)} ms`,
    hitches: String(recent.hitches),
    load: `${summary.drawCalls === null ? '–' : summary.drawCalls} · ${
      summary.triangles === null ? '–' : formatCount(summary.triangles)
    }`,
    frames: String(recent.frames)
  };
}

interface GraphColors {
  ink: string;
  muted: string;
  accent: string;
  warning: string;
  danger: string;
}

function prepareCanvas(
  canvas: HTMLCanvasElement,
  height: number
): CanvasRenderingContext2D | null {
  const context = canvas.getContext('2d');
  if (!context) return null;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(GRAPH_WIDTH_PX * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, GRAPH_WIDTH_PX, height);
  return context;
}

function drawFpsGraph(
  canvas: HTMLCanvasElement,
  series: readonly (number | null)[],
  colors: GraphColors
) {
  const height = FPS_GRAPH_HEIGHT_PX;
  const context = prepareCanvas(canvas, height);
  if (!context) return;
  const toY = (fps: number) =>
    height - (Math.min(fps, FPS_GRAPH_CEILING) / FPS_GRAPH_CEILING) * height;
  context.font = '10px ui-monospace, monospace';
  for (const fps of FPS_GRAPH_LINES) {
    const y = Math.round(toY(fps));
    context.globalAlpha = 0.35;
    context.fillStyle = colors.muted;
    context.fillRect(0, y, GRAPH_WIDTH_PX, 1);
    context.globalAlpha = 0.8;
    context.fillText(String(fps), 3, y + 11);
  }
  context.globalAlpha = 1;
  // One point per second, newest on the right edge; a second without a
  // frame breaks the line, so rest never reads as a drop to zero.
  const step = GRAPH_WIDTH_PX / (FPS_SERIES_SECONDS - 1);
  context.strokeStyle = colors.accent;
  context.lineWidth = 1.5;
  context.lineJoin = 'round';
  context.beginPath();
  let drawing = false;
  series.forEach((fps, index) => {
    if (fps === null) {
      drawing = false;
      return;
    }
    const x = index * step;
    if (drawing) context.lineTo(x, toY(fps));
    else context.moveTo(x, toY(fps));
    drawing = true;
  });
  context.stroke();
}

function drawFrameGraph(
  canvas: HTMLCanvasElement,
  history: readonly (number | null)[],
  colors: GraphColors
) {
  const height = FRAME_GRAPH_HEIGHT_PX;
  const context = prepareCanvas(canvas, height);
  if (!context) return;
  // The 60 Hz budget: bars that cross it are frames that missed a vsync.
  const budgetY = height - (BUDGET_60HZ_MS / FRAME_GRAPH_CEILING_MS) * height;
  context.fillStyle = colors.muted;
  context.globalAlpha = 0.5;
  context.fillRect(0, Math.round(budgetY), GRAPH_WIDTH_PX, 1);
  context.globalAlpha = 1;
  const barWidth = GRAPH_WIDTH_PX / HISTORY_LENGTH;
  // Newest frame on the right edge.
  const offset = HISTORY_LENGTH - history.length;
  for (let index = 0; index < history.length; index += 1) {
    const interval = history[index];
    if (interval === null || interval === undefined) continue;
    const barHeight = Math.max(
      1,
      Math.min(1, interval / FRAME_GRAPH_CEILING_MS) * height
    );
    context.fillStyle =
      interval > HITCH_MS
        ? colors.danger
        : interval > BUDGET_60HZ_MS
          ? colors.warning
          : colors.ink;
    context.fillRect(
      (offset + index) * barWidth,
      height - barHeight,
      Math.max(barWidth - 0.2, 0.6),
      barHeight
    );
  }
}

function readGraphColors(element: Element): GraphColors {
  const styles = window.getComputedStyle(element);
  const read = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    ink: read('--color-stage-ink', '#ebedef'),
    muted: read('--color-stage-ink-muted', '#9ba2ab'),
    accent: read('--color-accent', '#8f9cf7'),
    warning: read('--color-warning', '#e0a84f'),
    danger: read('--color-error', '#e05f5f')
  };
}

/** Keeps the panel's top-left corner inside the viewer it floats over. */
function clampToParent(panel: HTMLElement, x: number, y: number) {
  const parent = panel.offsetParent as HTMLElement | null;
  if (!parent) return { x, y };
  const maxX = Math.max(0, parent.clientWidth - panel.offsetWidth);
  const maxY = Math.max(0, parent.clientHeight - panel.offsetHeight);
  return {
    x: Math.round(Math.min(Math.max(0, x), maxX)),
    y: Math.round(Math.min(Math.max(0, y), maxY))
  };
}

const SUMMARY_CELLS: [field: string, label: string][] = [
  ['average', 'avg'],
  ['low1', '1% low'],
  ['low01', '0.1% low'],
  ['min', 'min']
];

const DETAIL_ROWS: [field: string, label: string][] = [
  ['cpuFrame', 'cpu (frame)'],
  ['cpu', 'cpu (render)'],
  ['worst', 'worst frame'],
  ['p99', 'p99 frame'],
  ['hitches', `hitches >${HITCH_MS} ms`],
  ['load', 'draws · tris'],
  ['frames', 'active frames']
];

/**
 * The frame rate panel (Settings → Advanced → Frame rate overlay): a
 * translucent box that floats over the viewport and can be dragged by its
 * top row. The viewer hands every drawn frame to `sinkRef`; the panel
 * repaints a few times a second by writing text straight into its own
 * nodes, so leaving it on costs the workspace no React renders.
 */
export function ViewportFrameStats({
  sinkRef,
  onClose
}: {
  sinkRef: MutableRefObject<FrameStatsSink | null>;
  /** Turns the overlay off; the close button is hidden without it. */
  onClose?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fpsGraphRef = useRef<HTMLCanvasElement | null>(null);
  const frameGraphRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const [collapsed, setCollapsed] = useState(
    () => readPanelPlace().collapsed === true
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const { x, y } = readPanelPlace();
    if (x !== undefined && y !== undefined) {
      const place = clampToParent(root, x, y);
      root.style.left = `${place.x}px`;
      root.style.top = `${place.y}px`;
    }
    // A viewer that shrinks (a docked panel opening, the window narrowing)
    // must not strand the panel outside it.
    const parent = root.offsetParent;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!root.style.left) return;
      const place = clampToParent(root, root.offsetLeft, root.offsetTop);
      root.style.left = `${place.x}px`;
      root.style.top = `${place.y}px`;
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const meter = new FrameStatsMeter();
    const sink: FrameStatsSink = (sample) => meter.record(sample);
    sinkRef.current = sink;
    let colors: GraphColors | null = null;
    const stopWatchingTheme = watchStageTheme(() => {
      colors = null;
    });
    const repaint = () => {
      const root = rootRef.current;
      if (!root) return;
      // Read layout/style before changing text. Reading offsetParent after
      // those writes synchronously laid out the workspace every 250 ms, so
      // the diagnostic panel itself could introduce the hitches it reports.
      const fpsGraph = fpsGraphRef.current;
      const frameGraph = frameGraphRef.current;
      const drawFps = Boolean(fpsGraph?.offsetParent);
      const drawFrame = Boolean(frameGraph?.offsetParent);
      if (drawFps || drawFrame) colors ??= readGraphColors(root);
      const now = performance.now();
      const summary = meter.summarize(now);
      const fields = frameStatsFields(summary, meter.recentStats());
      // Canvas font assignment can resolve CSS and force layout too. Finish
      // both graphs while layout is clean, then write the text fields.
      if (colors) {
        if (drawFps && fpsGraph)
          drawFpsGraph(fpsGraph, meter.fpsSeries(now), colors);
        if (drawFrame && frameGraph)
          drawFrameGraph(frameGraph, meter.history, colors);
      }
      for (const node of root.querySelectorAll<HTMLElement>('[data-field]')) {
        const text = fields[node.dataset.field!];
        if (text !== undefined && node.textContent !== text) {
          // Changing character data keeps structural selectors clean. Replacing
          // the Text node with textContent invalidates ancestor :has() rules.
          if (node.childNodes.length === 1 && node.firstChild?.nodeType === 3) {
            node.firstChild.nodeValue = text;
          } else {
            node.textContent = text;
          }
        }
      }
      if (root.hasAttribute('data-idle') !== summary.idle) {
        root.toggleAttribute('data-idle', summary.idle);
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

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root || event.button !== 0) return;
    if ((event.target as Element).closest('button')) return;
    event.preventDefault();
    dragRef.current = {
      dx: event.clientX - root.offsetLeft,
      dy: event.clientY - root.offsetTop
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const drag = dragRef.current;
    if (!root || !drag) return;
    const place = clampToParent(
      root,
      event.clientX - drag.dx,
      event.clientY - drag.dy
    );
    root.style.left = `${place.x}px`;
    root.style.top = `${place.y}px`;
  };
  const endDrag = () => {
    const root = rootRef.current;
    if (!root || !dragRef.current) return;
    dragRef.current = null;
    writePanelPlace({ x: root.offsetLeft, y: root.offsetTop });
  };
  const toggleCollapsed = () => {
    setCollapsed((current) => {
      writePanelPlace({ collapsed: !current });
      return !current;
    });
  };

  return (
    <div
      ref={rootRef}
      className="viewport-frame-stats"
      role="status"
      aria-label="Frame rate"
      aria-live="off"
      data-idle=""
      data-collapsed={collapsed ? '' : undefined}
    >
      <div
        className="viewport-frame-stats-head"
        title="Drag to move"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <GripVertical
          className="viewport-frame-stats-grip"
          size={12}
          aria-hidden="true"
        />
        <span className="viewport-frame-stats-rate" data-field="rate" />
        <span className="viewport-frame-stats-unit">fps</span>
        <span className="viewport-frame-stats-dot" aria-hidden="true" />
        <span className="viewport-frame-stats-frame" data-field="frame" />
        <button
          type="button"
          className="viewport-frame-stats-button"
          aria-label={
            collapsed ? 'Expand frame rate panel' : 'Collapse frame rate panel'
          }
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
        >
          {collapsed ? (
            <ChevronDown size={12} aria-hidden="true" />
          ) : (
            <ChevronUp size={12} aria-hidden="true" />
          )}
        </button>
        {onClose && (
          <button
            type="button"
            className="viewport-frame-stats-button"
            aria-label="Close frame rate panel"
            onClick={onClose}
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      <div hidden={collapsed}>
        <div className="viewport-frame-stats-summary">
          {SUMMARY_CELLS.map(([field, label]) => (
            <div key={field} className="viewport-frame-stats-cell">
              <span>{label}</span>
              <span className="viewport-frame-stats-value" data-field={field} />
            </div>
          ))}
        </div>
        <div className="viewport-frame-stats-caption">
          <span>fps · {FPS_SERIES_SECONDS} s</span>
        </div>
        <canvas
          ref={fpsGraphRef}
          className="viewport-frame-stats-graph"
          style={{ height: FPS_GRAPH_HEIGHT_PX }}
          aria-hidden="true"
        />
        <div className="viewport-frame-stats-caption">
          <span>frame time · {HISTORY_LENGTH} frames</span>
          <span>16.7 ms</span>
        </div>
        <canvas
          ref={frameGraphRef}
          className="viewport-frame-stats-graph"
          style={{ height: FRAME_GRAPH_HEIGHT_PX }}
          aria-hidden="true"
        />
        <dl className="viewport-frame-stats-rows">
          {DETAIL_ROWS.map(([field, label]) => (
            <div key={field} className="viewport-frame-stats-row">
              <dt>{label}</dt>
              <dd data-field={field} />
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
