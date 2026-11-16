import type { PlaneBasis } from '@openzcad/geometry';
import { ownEntry } from '@openzcad/shared';
import type {
  ProjectDocument,
  SketchId,
  SketchObjectData,
  Vector3
} from '@openzcad/shared';
import { objectPolylines } from '../objectPolyline';

/**
 * The sketch curves an in-place command can pick (a sweep's path), one per
 * authored entity, lifted onto their sketch planes. Construction geometry
 * is left out: it never bounds a profile or carries a path. Text is left
 * out too: a glyph outline is not a path anyone means to sweep along.
 */
export interface SketchCurveCandidate {
  /** `${sketchId}|${entityId}`, unique across sketches. */
  id: string;
  sketchId: SketchId;
  entityId: string;
  points: Vector3[];
}

export function curveCandidateId(sketchId: string, entityId: string): string {
  return `${sketchId}|${entityId}`;
}

export function parseCurveCandidateId(
  id: string
): { sketchId: SketchId; entityId: string } | null {
  const split = id.indexOf('|');
  if (split <= 0) return null;
  return {
    sketchId: id.slice(0, split) as SketchId,
    entityId: id.slice(split + 1)
  };
}

export function sketchCurveCandidates(
  document: ProjectDocument,
  views: readonly { sketchId: string; basis: PlaneBasis }[],
  resolve: (value: unknown) => number
): SketchCurveCandidate[] {
  const candidates: SketchCurveCandidate[] = [];
  for (const view of views) {
    const sketch = Object.values(document.nodes).find(
      (node) => node.kind === 'sketch' && node.sketchId === view.sketchId
    );
    if (sketch?.kind !== 'sketch') continue;
    for (const objectId of sketch.objectIds) {
      const node = ownEntry(document.nodes, objectId);
      if (node?.kind !== 'sketch-object') continue;
      const data: SketchObjectData = node.data;
      if (data.construction === true || data.objectKind === 'text') continue;
      let runs: ReturnType<typeof objectPolylines>;
      try {
        runs = objectPolylines(data, resolve);
      } catch {
        continue;
      }
      const { basis } = view;
      const points = runs.flatMap((run) => {
        const lifted = run.points.map((point) => ({
          x: basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
          y: basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
          z: basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
        }));
        return run.closed && lifted.length > 0
          ? [...lifted, lifted[0]!]
          : lifted;
      });
      if (points.length < 2) continue;
      candidates.push({
        id: curveCandidateId(view.sketchId, objectId),
        sketchId: view.sketchId as SketchId,
        entityId: objectId,
        points
      });
    }
  }
  return candidates;
}

/**
 * M02: a sketch's point entities and where each stands in the world, lifted
 * onto its plane, for a pattern on sketch points. A point whose position
 * does not resolve is left out.
 */
export function sketchPointSpots(
  document: ProjectDocument,
  views: readonly { sketchId: string; basis: PlaneBasis }[],
  sketchId: SketchId,
  resolve: (value: unknown) => number
): { id: string; at: Vector3 }[] {
  const view = views.find((candidate) => candidate.sketchId === sketchId);
  const sketch = Object.values(document.nodes).find(
    (node) => node.kind === 'sketch' && node.sketchId === sketchId
  );
  if (!view || sketch?.kind !== 'sketch') return [];
  const { basis } = view;
  return sketch.objectIds.flatMap((objectId) => {
    const node = ownEntry(document.nodes, objectId);
    if (node?.kind !== 'sketch-object' || node.data.objectKind !== 'point') {
      return [];
    }
    let x: number;
    let y: number;
    try {
      x = resolve(node.data.x);
      y = resolve(node.data.y);
    } catch {
      return [];
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    return [
      {
        id: String(objectId),
        at: {
          x: basis.origin.x + basis.u.x * x + basis.v.x * y,
          y: basis.origin.y + basis.u.y * x + basis.v.y * y,
          z: basis.origin.z + basis.u.z * x + basis.v.z * y
        }
      }
    ];
  });
}

/** Half the side of the square a point is picked by, in model units. */
const POINT_PICK_HALF = 1;

/**
 * M02: every sketch's point entities as pickable marks, a small crossed
 * square on the sketch plane about each, for a pattern on sketch points.
 */
export function sketchPointCandidates(
  document: ProjectDocument,
  views: readonly { sketchId: string; basis: PlaneBasis }[],
  resolve: (value: unknown) => number
): SketchCurveCandidate[] {
  return views.flatMap((view) =>
    sketchPointSpots(document, views, view.sketchId as SketchId, resolve).map(
      ({ id, at }) => {
        const { u, v } = view.basis;
        const corner = (su: number, sv: number): Vector3 => ({
          x: at.x + (u.x * su + v.x * sv) * POINT_PICK_HALF,
          y: at.y + (u.y * su + v.y * sv) * POINT_PICK_HALF,
          z: at.z + (u.z * su + v.z * sv) * POINT_PICK_HALF
        });
        return {
          id: curveCandidateId(view.sketchId, id),
          sketchId: view.sketchId as SketchId,
          entityId: id,
          // Both diagonals cross the point itself, so a click right on it
          // is on the mark, however far the camera stands.
          points: [
            corner(-1, -1),
            corner(1, 1),
            corner(1, -1),
            corner(-1, 1),
            corner(-1, -1)
          ]
        };
      }
    )
  );
}
