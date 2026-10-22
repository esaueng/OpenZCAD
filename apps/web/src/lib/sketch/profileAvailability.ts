import {
  listNodesByKind,
  resolvedSketchDocument
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import type { ProjectDocument } from '@openzcad/shared';
import { sketchValueResolver } from './valueResolver';

/** Modeling tool availability uses the same units as the visible sketch. */
export function countClosedProfileSketches(
  document: ProjectDocument | null,
  scope: Record<string, number>
): number {
  if (!document) return 0;
  const view = resolvedSketchDocument(document);
  const resolve = sketchValueResolver(scope, document.units);
  return listNodesByKind(document, 'sketch').filter((sketch) => {
    const objects = sketch.objectIds.flatMap((objectId) => {
      const node = view.nodes[objectId];
      return node?.kind === 'sketch-object'
        ? [{ id: objectId, data: node.data }]
        : [];
    });
    if (objects.length === 0) return false;
    try {
      return computeSketchRegions(objects, resolve).length > 0;
    } catch {
      return false;
    }
  }).length;
}
