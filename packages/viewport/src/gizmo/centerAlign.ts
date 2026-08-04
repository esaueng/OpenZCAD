/**
 * Center-alignment snapping for the move gizmo.
 *
 * The existing snap lands the drag handle on a point someone meant — a
 * corner, a midpoint. This one answers a different question: "is the thing I
 * am moving centred on that face?" — which is about two *centers* lining up
 * along an axis, not about the pointer touching anything. Centering on one
 * axis and centering on both are the same rule applied per axis, so a drag
 * that passes near a face's X can latch X while Y keeps following the
 * pointer, and latching both is just both axes matching at once.
 */
import type { MoveAxis } from './move';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface CenterAlignTarget {
  /** World-space center to align with — a face center of another body. */
  point: Vec3Like;
  /** Whose center it is, for the readout. */
  label: string;
}

export interface CenterAlignMatch {
  axis: MoveAxis;
  target: CenterAlignTarget;
}

export interface CenterAlignResult {
  translation: Vec3Like;
  matches: CenterAlignMatch[];
}

/**
 * Snaps `translation` so the moving center aligns with the nearest target
 * center on each requested axis independently, within `threshold` world
 * units. Axes that have no target near enough keep the incoming translation,
 * so alignment never fights the axis the user is actually steering.
 */
export function alignTranslationToCenters(
  restingCenter: Vec3Like,
  translation: Vec3Like,
  targets: readonly CenterAlignTarget[],
  axes: readonly MoveAxis[],
  threshold: number
): CenterAlignResult {
  const next = { ...translation };
  const matches: CenterAlignMatch[] = [];
  if (!Number.isFinite(threshold) || threshold <= 0 || targets.length === 0) {
    return { translation: next, matches };
  }
  for (const axis of axes) {
    const moved = restingCenter[axis] + translation[axis];
    let best: CenterAlignTarget | null = null;
    let bestDistance = threshold;
    for (const target of targets) {
      const distance = Math.abs(target.point[axis] - moved);
      // `<` and not `<=`: with equidistant candidates the first in document
      // order wins, which keeps the latch stable frame to frame.
      if (distance < bestDistance) {
        best = target;
        bestDistance = distance;
      }
    }
    if (best) {
      next[axis] = best.point[axis] - restingCenter[axis];
      matches.push({ axis, target: best });
    }
  }
  return { translation: next, matches };
}

/** Readout for the snap glyph: "Box Body ⋅ centered X·Y". */
export function centerAlignLabel(matches: readonly CenterAlignMatch[]): string {
  if (matches.length === 0) {
    return '';
  }
  const axes = matches.map((match) => match.axis.toUpperCase()).join('·');
  const labels = [...new Set(matches.map((match) => match.target.label))];
  return `${labels.join(', ')} ⋅ centered ${axes}`;
}
