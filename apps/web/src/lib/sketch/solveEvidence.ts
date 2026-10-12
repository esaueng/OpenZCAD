import {
  assertNoReferenceDimensionDependents,
  findSketch,
  getParameterScope
} from '@openzcad/document-core';
import type { EntityId, ProjectDocument, SketchId } from '@openzcad/shared';

export function sketchGeometryDeleteRefusal(
  document: ProjectDocument | undefined,
  sketchId: string,
  objectId: string
): string | null {
  const sketch = document
    ? findSketch(document, sketchId as SketchId)
    : undefined;
  if (!sketch) return null;
  try {
    assertNoReferenceDimensionDependents(sketch, objectId as EntityId);
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'Remove the reference dimension before deleting its geometry.';
  }
}

/** Presentation-only annotation edits do not invalidate an existing solver result. */
export function sketchSolveEvidenceKey(
  document: ProjectDocument | null | undefined,
  sketchId: string | null
): string | null {
  if (!document || !sketchId) return null;
  const sketch = findSketch(document, sketchId as SketchId);
  if (!sketch) return null;
  return JSON.stringify({
    units: document.units,
    scope: getParameterScope(document),
    plane: sketch.planeRef,
    objects: sketch.objectIds.map((id) =>
      document.nodes[id]?.kind === 'sketch-object'
        ? [id, document.nodes[id].data]
        : null
    ),
    constraints: sketch.constraints ?? []
  });
}
