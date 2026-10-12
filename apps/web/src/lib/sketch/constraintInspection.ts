import { findSketch } from '@openzcad/document-core';
import type { ProjectDocument, SketchNode } from '@openzcad/shared';
import { constraintReferencesObject } from './constraints';

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
  const seen = new Set<string>();
  const targets = currentSketch.objectIds.flatMap((objectId, index) => {
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
      ? [{ objectId, label: node.name || node.data.objectKind, index }]
      : [];
  });
  const labelCounts = new Map<string, number>();
  for (const { label } of targets) {
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  return targets.map(({ objectId, label, index }) => ({
    objectId,
    label:
      (labelCounts.get(label) ?? 0) > 1
        ? `${label} (position ${index + 1})`
        : label
  }));
}
