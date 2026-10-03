export interface ExtrudeSketchState {
  name: string;
  /** Whether the sketch has at least one closed profile to extrude. */
  closed: boolean;
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The lane sentence for Extrude when no sketch could be chosen for it.
 *
 * "Click a shaded closed sketch profile to arm it" was the only answer, even
 * when no sketch had a closed profile to shade: an open outline read as a
 * dead tool. The sentence names the open sketch and what to do about it.
 */
export function extrudeSketchGuidance(
  sketches: readonly ExtrudeSketchState[]
): string {
  const open = sketches.filter((sketch) => !sketch.closed).map((s) => s.name);
  const closed = sketches.filter((sketch) => sketch.closed).map((s) => s.name);
  if (sketches.length === 0) {
    return 'Extrude: draw a sketch with a closed outline first.';
  }
  if (closed.length === 0) {
    return open.length === 1
      ? `Extrude: ${open[0]} is not closed — close its outline to extrude it.`
      : `Extrude: ${listNames(open)} are not closed — close an outline to extrude it.`;
  }
  if (open.length > 0) {
    return `Extrude: ${listNames(open)} ${open.length === 1 ? 'is' : 'are'} not closed — click a shaded profile in ${listNames(closed)}, or close the outline.`;
  }
  return 'Extrude: click a shaded profile in the sketch to extrude it.';
}
