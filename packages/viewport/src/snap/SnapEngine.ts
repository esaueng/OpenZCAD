/**
 * Snapping in 3D.
 *
 * Sketch mode already snaps in 2D; this is the same idea where the geometry
 * is. What makes 3D harder is that "nearest" is the wrong question — the
 * pointer is a ray, not a point, so candidates are compared where the user is
 * actually looking at them, on screen.
 *
 * The other half is that closeness alone gives the wrong answer. Every point
 * along an edge is a candidate, so an edge running past a vertex will always
 * offer something marginally nearer than the vertex itself, and the one
 * position a user is most likely to want becomes the one they cannot hit.
 * Candidates are therefore ranked by how specific they are first and how near
 * they are second.
 */

export type SnapKind =
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'intersection'
  | 'on-edge'
  | 'on-face';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SnapCandidate {
  kind: SnapKind;
  /** World-space position to snap to. */
  point: Vec3;
  /** What it belongs to, for the readout. */
  label?: string;
}

/**
 * How much a kind is worth being asked for.
 *
 * A vertex is a place someone meant; a point on a face is wherever they
 * happened to be pointing. Ranking by specificity is what stops the vague
 * kinds burying the precise ones.
 */
export const SNAP_PRIORITY: Record<SnapKind, number> = {
  endpoint: 0,
  intersection: 1,
  center: 2,
  midpoint: 3,
  'on-edge': 4,
  'on-face': 5
};

export const SNAP_LABELS: Record<SnapKind, string> = {
  endpoint: 'Endpoint',
  intersection: 'Intersection',
  center: 'Center',
  midpoint: 'Midpoint',
  'on-edge': 'On edge',
  'on-face': 'On face'
};

/** Screen radius within which a candidate is close enough to be meant. */
export const SNAP_RADIUS_PX = 12;

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface SnapResolution {
  candidate: SnapCandidate;
  /** Where it landed on screen, for drawing the glyph. */
  screen: ScreenPoint;
  distancePx: number;
}

/**
 * The candidate a pointer is asking for, or null if none is close enough.
 *
 * `project` returns null for anything the camera cannot see, which keeps
 * geometry behind the viewer from snapping — it still projects to a finite
 * coordinate and would otherwise compete.
 *
 * A more specific kind wins outright while it is within range at all, rather
 * than only when it is also nearest. That is the whole point: a user aiming
 * near a corner wants the corner, not the edge that happens to pass a pixel
 * closer to their cursor.
 */
export function resolveSnap(
  candidates: readonly SnapCandidate[],
  pointer: ScreenPoint,
  project: (point: Vec3) => ScreenPoint | null,
  radiusPx = SNAP_RADIUS_PX
): SnapResolution | null {
  let best: SnapResolution | null = null;
  for (const candidate of candidates) {
    const screen = project(candidate.point);
    if (!screen) {
      continue;
    }
    const distancePx = Math.hypot(screen.x - pointer.x, screen.y - pointer.y);
    if (distancePx > radiusPx) {
      continue;
    }
    if (!best) {
      best = { candidate, screen, distancePx };
      continue;
    }
    const rank = SNAP_PRIORITY[candidate.kind] - SNAP_PRIORITY[best.candidate.kind];
    if (rank < 0 || (rank === 0 && distancePx < best.distancePx)) {
      best = { candidate, screen, distancePx };
    }
  }
  return best;
}

/**
 * The translation that puts a moving body's handle exactly on a snap point.
 *
 * Snapping a free move means moving the grab handle onto the point, not
 * nudging the body toward it: what the glyph marks has to be where the body
 * actually ends up, or the feedback is a decoration rather than a promise.
 *
 * `pivot` is where the handle sat when the drag began, in world space, and
 * `startTranslation` is the body's translation at that moment — so the two
 * together say where the handle is now.
 */
export function translationToSnap(
  startTranslation: Vec3,
  pivot: Vec3,
  point: Vec3
): Vec3 {
  return {
    x: startTranslation.x + point.x - pivot.x,
    y: startTranslation.y + point.y - pivot.y,
    z: startTranslation.z + point.z - pivot.z
  };
}
