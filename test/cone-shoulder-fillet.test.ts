import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  importStepBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';
import { inspectDisplayMeshClosure } from '../packages/kernel-adapter/src/boolean-result-validation';

function circularRim(body: BodyRepresentation, height: number) {
  const edges = body.topology!.edges.filter(
    (edge) =>
      edge.curve?.type === 'CIRCLE' &&
      edge.points.every(
        (coordinate, index) =>
          index % 3 !== 2 || Math.abs(coordinate - height) < 1e-5
      )
  );
  expect(edges).toHaveLength(1);
  const edge = edges[0]!;
  return {
    edgeHashes: [edge.hash],
    ...(edge.reference ? { edgeReferences: [edge.reference] } : {})
  };
}

const APPROXIMATION_WARNING =
  'Feature "Shoulder fillet": This fillet is approximate: its blend surface is a NURBS fit within modeling tolerance, not an exact fillet surface. Volume, measurements and STEP export use that approximate surface.';

function expectOrientedClosedMesh(
  body: Pick<BodyRepresentation, 'mesh' | 'faceCount'>,
  faces = 5
) {
  expect(body.faceCount).toBe(faces);
  const closure = inspectDisplayMeshClosure(
    body.mesh.vertices,
    body.mesh.indices
  );
  expect(closure.triangles).toBeGreaterThan(0);
  expect(closure.boundaryEdges).toBe(0);
  expect(closure.nonManifoldEdges).toBe(0);
  expect(closure.inconsistentWindingEdges).toBe(0);
}

describe('chamfered cone shoulder fillet (#1258)', { timeout: 60_000 }, () => {
  it('keeps its blend band oriented through preview, commit, undo, cold replay and STEP', async () => {
    const adapter = await createExactKernelAdapter();
    const cold = await createExactKernelAdapter();
    try {
      const profile = addSketchFeature(
        createProjectDocument('Cone shoulder', toUserId('user_cone_shoulder')),
        {
          name: 'Circle',
          plane: 'XY',
          object: {
            objectKind: 'circle',
            centerX: 0,
            centerY: 0,
            radius: Math.sqrt(29)
          }
        }
      );
      const extruded = extrudeSketch(profile.document, {
        name: 'Drafted frustum',
        sketchId: profile.sketchId,
        distance: 23,
        draftAngleDeg: -33
      });
      const source = await adapter.syncDocument(extruded.document);
      expect(source.warnings).toEqual([]);
      const manager = new CommandManager(extruded.document);
      manager.execute(
        commandFactories.chamferEdges({
          name: 'Upper rim chamfer',
          targetBodyId: extruded.bodyId,
          ...circularRim(source.bodyRepresentations[extruded.bodyId]!, 23),
          size: 6.1
        })
      );
      const chamferId = manager.document.bodyOrder.at(-1)!;
      const chamfered = await adapter.syncDocument(manager.document);
      expect(chamfered.warnings).toEqual([]);
      const before = chamfered.bodyRepresentations[chamferId]!;
      expectOrientedClosedMesh(before, 4);
      const fillet = commandFactories.filletEdges({
        name: 'Shoulder fillet',
        targetBodyId: chamferId,
        ...circularRim(before, 17.88410953553291),
        size: 1
      });
      const candidate = fillet.apply(manager.document);
      const resultId = candidate.bodyOrder.at(-1)!;
      const preview = await adapter.previewGeometry(candidate);
      expect(preview.warnings).toEqual([APPROXIMATION_WARNING]);
      expectOrientedClosedMesh(preview.bodyRepresentations[resultId]!);
      manager.execute(fillet);
      const committed = await adapter.syncDocument(manager.document);
      expect(committed.warnings).toEqual([APPROXIMATION_WARNING]);
      expectOrientedClosedMesh(committed.bodyRepresentations[resultId]!);
      manager.undo();
      const undone = await adapter.syncDocument(manager.document);
      expect(undone.warnings).toEqual([]);
      expect(undone.bodyRepresentations[chamferId]!.mesh).toEqual(before.mesh);
      manager.redo();
      const reopened = JSON.parse(
        JSON.stringify(manager.document)
      ) as ProjectDocument;
      const replay = await cold.syncDocument(reopened);
      expect(replay.warnings).toEqual([APPROXIMATION_WARNING]);
      expectOrientedClosedMesh(replay.bodyRepresentations[resultId]!);
      const step = await cold.exportStep(reopened, [resultId]);
      const imported = importStepBody(
        createProjectDocument('Round trip', toUserId('user_cone_shoulder')),
        {
          name: 'Filleted cone',
          artifactId: 'cone-step',
          sourceName: 'cone.step',
          stepText: step
        }
      );
      const roundTrip = await cold.syncDocument(imported.document);
      expect(roundTrip.warnings).toEqual([]);
      expectOrientedClosedMesh(roundTrip.bodyRepresentations[imported.bodyId]!);
    } finally {
      adapter.dispose();
      cold.dispose();
    }
  });
});
