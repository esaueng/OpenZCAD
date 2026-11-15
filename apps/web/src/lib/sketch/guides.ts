import type { PlaneBasis } from '@openzcad/geometry';
import type { SketchObjectData, Vector3 } from '@openzcad/shared';
import type {
  SketchInferenceSegment,
  SketchPoint,
  SnapTarget
} from './session';

/**
 * S08 guidelines and guidepoints. Everything here is a snap the pointer can
 * land on, computed from geometry that already exists:
 *
 * - **Guideline extensions**: a line's extension past either end, so a point
 *   placed there can be held on the line (where coincidence is reachable).
 * - **Tangent guidelines**: from the end of the line being drawn, the two
 *   points where a line would touch a circle (where tangency is reachable
 *   and can be held).
 * - **Model guidepoints**: vertices, edge midpoints, circle centres (hole
 *   and boss centres) and planar face centres of the model, lifted into the
 *   sketch plane. Those on the plane are always offered; those off it only
 *   while the view looks straight down the sketch normal, where what is
 *   behind the plane reads as lying on it.
 *
 * Each target says which guideline to draw while it is engaged, and none of
 * them carries a constraint-schema point: a model point is not sketch
 * geometry, and an extension or tangent point is where a relation is
 * inferred from (`inference.ts`), not a stored point.
 */

type Resolve = (value: unknown) => number;

export interface SketchGuideTarget extends SnapTarget {
  /** The guideline drawn while this target is engaged. */
  guide?: SketchInferenceSegment;
}

/** A model point in world space, as the viewport's topology snaps give it. */
export interface ModelGuidepoint {
  kind: 'endpoint' | 'midpoint' | 'center';
  point: Vector3;
  label?: string;
  /** Face centres say so; the rest are named by `kind`. */
  role?: 'face-center';
}

const MODEL_LABELS = {
  endpoint: 'Model vertex',
  midpoint: 'Model edge midpoint',
  center: 'Hole or arc center',
  'face-center': 'Face center'
} as const;

/** The view looks along the sketch normal within this angle. */
const ORTHOGONAL_COS = Math.cos((1 * Math.PI) / 180);

/** Whether a view direction looks straight at the sketch plane. */
export function viewIsOrthogonal(
  viewDirection: Vector3,
  normal: Vector3
): boolean {
  const length = Math.hypot(viewDirection.x, viewDirection.y, viewDirection.z);
  if (!(length > 0)) return false;
  const along =
    (viewDirection.x * normal.x +
      viewDirection.y * normal.y +
      viewDirection.z * normal.z) /
    length;
  return Math.abs(along) >= ORTHOGONAL_COS;
}

/**
 * Model guidepoints in sketch coordinates. A point within `planeTolerance`
 * of the plane is always offered; any other only when `orthogonal`.
 */
export function modelGuideTargets(
  points: readonly ModelGuidepoint[],
  basis: PlaneBasis,
  options: { orthogonal: boolean; planeTolerance: number; limit?: number }
): SketchGuideTarget[] {
  const targets: SketchGuideTarget[] = [];
  const seen = new Set<string>();
  const limit = options.limit ?? 4096;
  for (const entry of points) {
    const dx = entry.point.x - basis.origin.x;
    const dy = entry.point.y - basis.origin.y;
    const dz = entry.point.z - basis.origin.z;
    const off = dx * basis.normal.x + dy * basis.normal.y + dz * basis.normal.z;
    if (!Number.isFinite(off)) continue;
    if (Math.abs(off) > options.planeTolerance && !options.orthogonal) continue;
    const x = dx * basis.u.x + dy * basis.u.y + dz * basis.u.z;
    const y = dx * basis.v.x + dy * basis.v.y + dz * basis.v.z;
    const key = `${entry.role ?? entry.kind}:${x.toFixed(6)},${y.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = MODEL_LABELS[entry.role ?? entry.kind];
    targets.push({
      id: `model:${key}`,
      x,
      y,
      kind: entry.kind,
      label:
        Math.abs(off) > options.planeTolerance ? `${name} (projected)` : name
    });
    if (targets.length >= limit) break;
  }
  return targets;
}

/** A line object's evaluated ends, or null. */
function lineEnds(
  data: SketchObjectData,
  resolve: Resolve
): [SketchPoint, SketchPoint] | null {
  if (data.objectKind !== 'line') return null;
  const a = { x: resolve(data.x1), y: resolve(data.y1) };
  const b = { x: resolve(data.x2), y: resolve(data.y2) };
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return null;
  return Math.hypot(b.x - a.x, b.y - a.y) > 0 ? [a, b] : null;
}

/**
 * The extension snaps near `point`: for each line whose extension past an
 * end passes within `tolerance`, the foot of the perpendicular on it. The
 * segment itself is left to the ordinary snaps; past its ends is where a
 * guideline shows something new. `reach` bounds how far past an end a
 * guideline is offered.
 */
export function extensionTargets(
  point: SketchPoint,
  objects: readonly { id: string; data: SketchObjectData }[],
  resolve: Resolve,
  tolerance: number,
  reach = Infinity
): SketchGuideTarget[] {
  const targets: SketchGuideTarget[] = [];
  for (const object of objects) {
    const ends = lineEnds(object.data, resolve);
    if (!ends) continue;
    const [a, b] = ends;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    const along = (point.x - a.x) * u.x + (point.y - a.y) * u.y;
    const across = (point.x - a.x) * u.y - (point.y - a.y) * u.x;
    if (Math.abs(across) > tolerance) continue;
    const past = along < 0 ? -along : along > length ? along - length : 0;
    // Only beyond an end, by more than the snap radius: near the end the
    // endpoint snap is what is meant.
    if (past <= tolerance || past > reach) continue;
    const foot = { x: a.x + u.x * along, y: a.y + u.y * along };
    const from = along < 0 ? a : b;
    targets.push({
      id: `extension:${object.id}:${along < 0 ? 'start' : 'end'}`,
      x: foot.x,
      y: foot.y,
      kind: 'extension',
      sourceId: object.id,
      label: 'Extension',
      guide: [from, foot]
    });
  }
  return targets;
}

/**
 * Where a line from `anchor` touches each circle: its two tangent points.
 * An anchor on or inside the circle has none.
 *
 * Only circles: the guide promises a held tangent, and the schema can hold
 * a line tangent to a circle anywhere but to an arc only at the arc's own
 * start or end (`tangent.at`). A line touching an arc's interior could be
 * held on the arc but not tangent to it, so no arc guide is offered rather
 * than one that keeps less than it shows (review #1567).
 */
export function tangentTargets(
  anchor: SketchPoint,
  objects: readonly { id: string; data: SketchObjectData }[],
  resolve: Resolve
): SketchGuideTarget[] {
  const targets: SketchGuideTarget[] = [];
  for (const object of objects) {
    const data = object.data;
    if (data.objectKind !== 'circle') continue;
    const c = { x: resolve(data.centerX), y: resolve(data.centerY) };
    const r = resolve(data.radius);
    if (![c.x, c.y, r].every(Number.isFinite) || !(r > 0)) continue;
    const dx = anchor.x - c.x;
    const dy = anchor.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d <= r * (1 + 1e-9)) continue;
    // The tangent points sit at ±acos(r/d) from the centre-to-anchor ray.
    const base = Math.atan2(dy, dx);
    const spread = Math.acos(r / d);
    for (const [index, angle] of [base + spread, base - spread].entries()) {
      const at = { x: c.x + r * Math.cos(angle), y: c.y + r * Math.sin(angle) };
      targets.push({
        id: `tangent:${object.id}:${index}`,
        x: at.x,
        y: at.y,
        kind: 'tangent',
        sourceId: object.id,
        label: 'Tangent',
        guide: [anchor, at]
      });
    }
  }
  return targets;
}
