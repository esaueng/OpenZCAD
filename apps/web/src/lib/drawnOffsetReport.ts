/**
 * Reports the displacement a viewer-drawn mesh proxy shows, only when it
 * changes: the drag value its deformed mesh is drawn at, or null once it
 * shows the part as it is (restored, discarded, or replaced by an exact
 * frame). A rejected deformation that keeps the last drawable mesh keeps
 * its value, since that mesh is still what is on screen.
 */
export function drawnOffsetReporter(
  report: (offset: number | null) => void
): (offset: number | null) => void {
  let last: number | null = null;
  return (offset) => {
    const next =
      offset !== null && Number.isFinite(offset) && Math.abs(offset) > 1e-9
        ? offset
        : null;
    if (next === last) return;
    last = next;
    report(next);
  };
}
