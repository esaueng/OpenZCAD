import { expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  getLatestBodyId
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { parseProjectBackup } from '../apps/web/src/lib/projectBackup';

it.each(['radius', 'horizontal', 'vertical'] as const)(
  'preserves real GCS evidence and exact extruded geometry through %s annotation-only edits and backup import',
  async (mode) => {
    const f = addSketchFeature(
      createProjectDocument('Exact reference', toUserId('user_test')),
      {
        name: 'Circle',
        plane: 'XY',
        objects: [
          { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 },
          {
            objectKind: 'circle',
            centerX: 3,
            centerY: 4,
            radius: 1,
            construction: true
          }
        ]
      }
    );
    const document = extrudeSketch(f.document, {
      name: 'Extrude',
      sketchId: f.sketchId,
      distance: 10
    }).document;
    const objectId = findSketch(document, f.sketchId)!.objectIds[0]!;
    const adapter = await createExactKernelAdapter();
    try {
      const solveBefore = await adapter.solveSketch(document, f.sketchId);
      const before = await adapter.syncDocument(document);
      const manager = new CommandManager(document);
      const command = commandFactories.addSketchReferenceDimension({
        sketchId: f.sketchId,
        data:
          mode === 'radius'
            ? { dimensionKind: 'radius', objectId }
            : {
                dimensionKind: 'distance',
                distanceMode: mode,
                a: { objectId, point: 'center' },
                b: {
                  objectId: findSketch(document, f.sketchId)!.objectIds[1]!,
                  point: 'center'
                }
              }
      });
      manager.execute(command);
      manager.execute(
        commandFactories.setSketchReferenceLabelPosition({
          sketchId: f.sketchId,
          annotationId: command.payload.ids!.annotationId,
          position: { x: 7, y: 3 }
        })
      );
      const backup = await parseProjectBackup(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document: manager.document,
          files: [],
          sources: [],
          saveStates: []
        })
      );
      expect(
        findSketch(backup.document, f.sketchId)!.referenceDimensions
      ).toEqual(findSketch(manager.document, f.sketchId)!.referenceDimensions);
      const solveAfter = await adapter.solveSketch(backup.document, f.sketchId);
      expect(solveAfter).toEqual(solveBefore);
      const after = await adapter.syncDocument(backup.document);
      const bodyId = getLatestBodyId(document)!;
      expect(after.warnings).toEqual([]);
      expect(after.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
        Math.PI * 250,
        8
      );
      expect(after.bodyRepresentations[bodyId]!.bbox).toEqual(
        before.bodyRepresentations[bodyId]!.bbox
      );
      expect(after.bodyRepresentations[bodyId]!.volume).toBe(
        before.bodyRepresentations[bodyId]!.volume
      );
    } finally {
      adapter.dispose();
    }
  }
);
