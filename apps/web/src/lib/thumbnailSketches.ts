import * as THREE from 'three';
import {
  getParameterScope,
  listNodesByKind,
  resolvedSketchDocument
} from '@openzcad/document-core';
import type { PlaneBasis } from '@openzcad/geometry';
import {
  documentTextBudgetError,
  type ProjectDocument
} from '@openzcad/shared';
import {
  displayObjectsWithTextBudget,
  objectPolylines
} from './objectPolyline';
import { resolvedSketchPlaneBasis } from './sketch/planeBasis';
import { sketchValueResolver } from './sketch/valueResolver';

interface ThumbnailSketch {
  basis: PlaneBasis;
  curves: { points: THREE.Vector3[]; closed: boolean; construction: boolean }[];
  points: THREE.Vector3[];
}

/** Reuses the viewport's plane resolution and display sampling. */
export function thumbnailSketches(
  document: ProjectDocument
): ThumbnailSketch[] {
  const sketches = listNodesByKind(document, 'sketch');
  if (sketches.length === 0) return [];

  const readDocument = resolvedSketchDocument(document);
  const resolve = sketchValueResolver(
    getParameterScope(document).scope,
    document.units
  );
  const textBudgetError = documentTextBudgetError(document);
  return sketches.flatMap((sketch) => {
    const objects = sketch.objectIds.flatMap((id) => {
      const node = readDocument.nodes[id];
      return node?.kind === 'sketch-object' ? [node] : [];
    });
    if (objects.length === 0) return [];

    let basis: PlaneBasis;
    try {
      basis = resolvedSketchPlaneBasis(
        document,
        sketch.planeRef,
        resolve,
        sketch.name
      );
    } catch {
      return [];
    }
    const lift = ({ x, y }: { x: number; y: number }) =>
      new THREE.Vector3(
        basis.origin.x + basis.u.x * x + basis.v.x * y,
        basis.origin.y + basis.u.y * x + basis.v.y * y,
        basis.origin.z + basis.u.z * x + basis.v.z * y
      );
    const curves: ThumbnailSketch['curves'] = [];
    const points: ThumbnailSketch['points'] = [];
    for (const { data } of displayObjectsWithTextBudget(
      objects,
      textBudgetError
    )) {
      try {
        if (data.objectKind === 'point') {
          points.push(lift({ x: resolve(data.x), y: resolve(data.y) }));
          continue;
        }
        for (const polyline of objectPolylines(data, resolve)) {
          if (polyline.points.length < 2) continue;
          curves.push({
            points: polyline.points.map(lift),
            closed: polyline.closed,
            construction: data.construction === true
          });
        }
      } catch {
        // One unresolved object should not hide the rest of its sketch.
      }
    }
    return curves.length || points.length ? [{ basis, curves, points }] : [];
  });
}
