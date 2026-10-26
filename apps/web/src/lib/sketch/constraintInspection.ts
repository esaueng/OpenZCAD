import { findSketch } from '@openzcad/document-core';
import type { ProjectDocument, SketchNode } from '@openzcad/shared';
import { constraintReferencesObject } from './constraints';
import { sketchObjectLabels } from './objectLabels';

export interface ConstraintInspectionTarget {
  objectId: string;
  label: string;
}

/**
 * Navigation targets for a currently stored constraint. References establish
 * membership only; they do not identify a solver culprit or remaining DOF.
 */
export function constraintInspectionTargets(
  document: ProjectDocument,
  sketch: SketchNode | undefined,
  constraintId: string
): ConstraintInspectionTarget[] {
  if (!sketch) return [];
  const currentSketch = findSketch(document, sketch.sketchId);
  const constraint = currentSketch?.constraints?.find(
    (entry) => String(entry.constraintId) === constraintId
  );
  if (!currentSketch || !constraint) return [];

  const suppliedObjectIds = new Set(sketch.objectIds);
  const labels = sketchObjectLabels(document, currentSketch);
  const seen = new Set<string>();
  return currentSketch.objectIds.flatMap((objectId) => {
    if (
      seen.has(objectId) ||
      !suppliedObjectIds.has(objectId) ||
      !constraintReferencesObject(constraint.data, objectId)
    ) {
      return [];
    }
    seen.add(objectId);
    const node = document.nodes[objectId];
    return node?.kind === 'sketch-object'
      ? [
          {
            objectId,
            label: labels.get(objectId) ?? (node.name || node.data.objectKind)
          }
        ]
      : [];
  });
}
