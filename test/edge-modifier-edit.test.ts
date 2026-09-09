import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { edgeModifierCommand } from '../apps/web/src/lib/edgeModifierEdit';

describe('edge modifier slider edits', () => {
  it.each(['fillet', 'chamfer'] as const)(
    'previews %s without history changes and applies one undoable edit',
    async (kind) => {
      const kernel = await createExactKernelAdapter();
      try {
        const manager = new CommandManager(
          createProjectDocument('Slider test', toUserId('user_test'))
        );
        manager.execute(
          commandFactories.addPrimitive({
            name: 'Cylinder',
            primitiveKind: 'cylinder',
            dimensions: { radius: 20, height: 30 }
          })
        );
        const source = Object.values(
          (await kernel.syncDocument(manager.document)).bodyRepresentations
        )[0]!;
        const edgeHashes = source
          .topology!.edges.filter((edge) =>
            edge.points.every(
              (coordinate, index) =>
                index % 3 !== 2 || Math.abs(coordinate - edge.points[2]!) < 1e-6
            )
          )
          .map((edge) => edge.hash);
        manager.execute(
          edgeModifierCommand(null, kind, {
            name: 'Rims',
            targetBodyId: source.bodyId,
            edgeHashes,
            size: 2
          })
        );
        const original = manager.document;
        const feature = listFeaturesInOrder(original).at(-1)!;
        const originalGeometry = await kernel.syncDocument(original);
        expect(originalGeometry.warnings).toEqual([]);
        const command = edgeModifierCommand(feature, kind, {
          name: 'Rims',
          targetBodyId: source.bodyId,
          edgeHashes,
          size: 4
        });
        const preview = command.apply(original);
        const rebuilt = await kernel.syncDocument(preview);
        expect(rebuilt.warnings).toEqual([]);
        expect(
          rebuilt.bodyRepresentations[feature.bodyId!]!.volume
        ).toBeLessThan(
          originalGeometry.bodyRepresentations[feature.bodyId!]!.volume
        );
        expect(manager.document).toBe(original);
        expect(listFeaturesInOrder(preview).at(-1)!.data).toEqual({
          ...feature.data,
          ...(kind === 'fillet' ? { radius: 4 } : { distance: 4 })
        });
        if (kind === 'chamfer') {
          const angled = edgeModifierCommand(feature, kind, {
            name: 'Rims',
            targetBodyId: source.bodyId,
            edgeHashes,
            size: 4,
            angleDeg: 30
          }).apply(original);
          expect(listFeaturesInOrder(angled).at(-1)!.data).toEqual({
            ...feature.data,
            distance: 4,
            angleDeg: 30
          });
        }
        manager.execute(command);
        expect(manager.document.featureOrder).toEqual(original.featureOrder);
        expect(manager.document.commandLog).toHaveLength(
          original.commandLog.length + 1
        );
        manager.undo();
        expect(listFeaturesInOrder(manager.document).at(-1)!.data).toEqual(
          feature.data
        );
        manager.redo();
        expect(listFeaturesInOrder(manager.document).at(-1)!.data).toEqual(
          listFeaturesInOrder(preview).at(-1)!.data
        );
      } finally {
        kernel.dispose();
      }
    }
  );
});
