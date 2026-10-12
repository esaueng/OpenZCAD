import { expect, it } from 'vitest';
import {
  addSketchFeature,
  addSketchReferenceDimension,
  createProjectDocument,
  findSketch,
  setSketchReferenceLabelPosition,
  updateSketchObject
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  sketchGeometryDeleteRefusal,
  sketchSolveEvidenceKey
} from './solveEvidence';

it('preserves solver evidence for annotation edits and invalidates it for geometry changes', () => {
  const f = addSketchFeature(
    createProjectDocument('Evidence', toUserId('user_test')),
    {
      name: 'Sketch',
      plane: 'XY',
      objects: [{ objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }]
    }
  );
  const objectId = findSketch(f.document, f.sketchId)!.objectIds[0]!;
  const baseline = sketchSolveEvidenceKey(f.document, f.sketchId);
  const ref = addSketchReferenceDimension(f.document, {
    sketchId: f.sketchId,
    data: { dimensionKind: 'radius', objectId }
  });
  expect(
    sketchGeometryDeleteRefusal(ref.document, f.sketchId, objectId)
  ).toMatch(/Delete the reference dimensions first/);
  expect(
    sketchGeometryDeleteRefusal(f.document, f.sketchId, objectId)
  ).toBeNull();
  const moved = setSketchReferenceLabelPosition(ref.document, {
    sketchId: f.sketchId,
    annotationId: ref.annotationId,
    position: { x: 5, y: 5 }
  });
  expect(sketchSolveEvidenceKey(moved, f.sketchId)).toBe(baseline);
  const edited = updateSketchObject(moved, {
    sketchId: f.sketchId,
    objectId,
    data: { objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }
  });
  expect(sketchSolveEvidenceKey(edited, f.sketchId)).not.toBe(baseline);
});
