/** Bounded User Timing evidence for one project/revision from input to frame. */
type Revision = { projectId: string; version: number };
const intents = new Map<string, number>();
const MAX_TRACES = 64;
export type EditPhase =
  | 'packed'
  | 'received'
  | 'progress'
  | 'geometry-ready'
  | 'analysis-ready'
  | 'installed'
  | 'frame';

function key(revision: Revision): string {
  return `${revision.projectId}:${revision.version}`;
}

export function beginEditTrace(revision: Revision): void {
  const id = key(revision);
  if (intents.has(id)) return;
  if (intents.size >= MAX_TRACES) intents.delete(intents.keys().next().value!);
  intents.set(id, performance.now());
}

export function recordEditPhase(
  revision: Revision,
  phase: EditPhase,
  metrics: Record<string, number | string> = {}
): void {
  const start = intents.get(key(revision));
  if (start === undefined || typeof performance.measure !== 'function') return;
  const name = `oz:edit.${phase}`;
  if (performance.getEntriesByName(name).length >= MAX_TRACES)
    performance.clearMeasures(name);
  try {
    performance.measure(name, {
      start,
      end: performance.now(),
      detail: { ...revision, ...metrics }
    });
  } catch {
    // Instrumentation cannot change rendering in hosts without options support.
  }
}
