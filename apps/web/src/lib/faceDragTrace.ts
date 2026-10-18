/**
 * Opt-in stage trace for a face-offset drag, from pointer input to the frame
 * that shows the resulting geometry. A probe enables it by assigning an array
 * to `window.__ozFaceDragTrace` before the app loads; otherwise every call is
 * a single property read. Timestamps are `performance.now()` on the main
 * thread; worker stages carry durations measured inside the worker.
 *
 * Stages, in order for one presented value:
 * - `pointer`: the viewport applied a drag value (`value`, `ms` = input delay).
 * - `request`: the live preview started building `value` (`ms` = candidate
 *   construction on the main thread).
 * - `reply`: the worker answered (`ms` = round trip; `detail` holds the
 *   worker's queue, kernel and posting durations).
 * - `publish`: the result for `value` was handed to React. A preview shown
 *   again from the live preview's completed frame, when the drag returns to
 *   it, has no worker reply of its own and is marked `detail.cached` = 1.
 * - `install`: the viewer installed changed bodies (`ms` = installation).
 * - `frame`: a WebGL frame was rendered (`detail.presented` = 1 for the first
 *   frame after an installation).
 * - `refusal`: the preview for `value` was refused.
 */
export type FaceDragTraceKind =
  'pointer' | 'request' | 'reply' | 'publish' | 'install' | 'frame' | 'refusal';

export interface FaceDragTraceEvent {
  kind: FaceDragTraceKind;
  t: number;
  value?: number;
  ms?: number;
  detail?: Record<string, number>;
  /** A refusal's reason. */
  message?: string;
}

const MAX_EVENTS = 20_000;

function traceLog(): FaceDragTraceEvent[] | undefined {
  if (typeof window === 'undefined') return undefined;
  const log = (window as { __ozFaceDragTrace?: unknown }).__ozFaceDragTrace;
  return Array.isArray(log) ? (log as FaceDragTraceEvent[]) : undefined;
}

export function faceDragTraceEnabled(): boolean {
  return traceLog() !== undefined;
}

export function traceFaceDrag(
  kind: FaceDragTraceKind,
  fields: Omit<FaceDragTraceEvent, 'kind' | 't'> = {}
): void {
  const log = traceLog();
  if (!log || log.length >= MAX_EVENTS) return;
  log.push({ kind, t: performance.now(), ...fields });
}

const publishedPreviews = new WeakSet<object>();

/** Records a publish of `preview`, marking a repeat of an earlier one. */
export function traceFaceDragPublish(value: number, preview: object): void {
  if (!faceDragTraceEnabled()) return;
  const cached = publishedPreviews.has(preview);
  publishedPreviews.add(preview);
  traceFaceDrag('publish', { value, detail: { cached: cached ? 1 : 0 } });
}
