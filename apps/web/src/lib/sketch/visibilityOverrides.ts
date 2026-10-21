/**
 * The per-sketch visibility overrides after one sketch is shown or hidden.
 * An override that matches the sketch's default is dropped, and so is one for
 * a sketch no longer in the document, so the persisted map (read back capped
 * at its newest entries) holds only choices that still mean something. The
 * changed sketch moves to the end, keeping the map ordered oldest first.
 */
export function toggledSketchVisibility(
  current: Readonly<Record<string, boolean>>,
  sketchId: string,
  visible: boolean,
  defaultVisible: boolean,
  liveSketchIds: ReadonlySet<string>
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(current)) {
    if (id !== sketchId && liveSketchIds.has(id)) next[id] = value;
  }
  if (visible !== defaultVisible) next[sketchId] = visible;
  return next;
}
