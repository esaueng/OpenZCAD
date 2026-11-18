/**
 * Which sketch entities a box sweep takes, by the same rule bodies use: a
 * left-to-right window takes only what lies wholly inside it, a
 * right-to-left crossing also takes whatever it touches.
 */
import {
  pointInRect,
  segmentIntersectsRect,
  type BoxSelectMode,
  type ScreenRect
} from '@openzcad/viewport';

export interface ScreenOutline {
  id: string;
  /** The entity's drawn runs in canvas pixels; a point is a one-point run. */
  runs: readonly (readonly { x: number; y: number }[])[];
}

export function sketchObjectsInBox(
  outlines: readonly ScreenOutline[],
  rect: ScreenRect,
  mode: BoxSelectMode
): string[] {
  const taken: string[] = [];
  for (const { id, runs } of outlines) {
    const points = runs.flat();
    if (points.length === 0) {
      continue;
    }
    const inside =
      mode === 'window'
        ? points.every((point) => pointInRect(point, rect))
        : runs.some((run) =>
            run.length === 1
              ? pointInRect(run[0]!, rect)
              : run.some(
                  (point, index) =>
                    index > 0 &&
                    segmentIntersectsRect(run[index - 1]!, point, rect)
                )
          );
    if (inside) {
      taken.push(id);
    }
  }
  return taken;
}
