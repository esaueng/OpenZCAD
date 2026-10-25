import type { PlaneBasis } from '@openzcad/geometry';
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
      const node = document.nodes[objectId];
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
