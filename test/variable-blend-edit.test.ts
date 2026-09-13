import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type FeatureData } from '@openzcad/shared';
import { edgeModifierCommand } from '../apps/web/src/lib/edgeModifierEdit';

const user = toUserId('user_variable_blend_edit');

async function plateWithVerticalEdges() {
  const kernel = await createExactKernelAdapter();
  const manager = new CommandManager(createProjectDocument('Plate', user));
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    })
  );
  const body = Object.values(
    (await kernel.syncDocument(manager.document)).bodyRepresentations
  )[0]!;
  return { kernel, manager, body };
}

/**
 * Turning a constant fillet into a variable one and back again.
 *
 * The round trip is the part that can quietly break: a patch cannot delete a
 * key, so without `clearData` the only way back from a variable blend would be
 * an end radius equal to the start radius — which is NOT the constant blend.
 * It runs the variable engine, and that engine measurably disagrees with the
 * constant one. The last assertion here is what makes that difference visible.
 */
describe('variable blend edits', { timeout: 120_000 }, () => {
  it('returns to the constant blend when the end radius is cleared', async () => {
    const { kernel, manager, body } = await plateWithVerticalEdges();
    try {
      const verticalEdges = body
        .topology!.edges.filter((edge) => Math.abs((edge.length ?? 0) - 10) < 1e-6)
        .map((edge) => edge.hash);
      expect(verticalEdges.length).toBe(4);
      const edgeHashes = [verticalEdges[0]!];

      manager.execute(
        edgeModifierCommand(null, 'fillet', {
          name: 'Round',
          targetBodyId: body.bodyId,
          edgeHashes,
          size: 2
        })
      );
      const feature = listFeaturesInOrder(manager.document).at(-1)!;
      const constantVolume = (await kernel.syncDocument(manager.document))
        .bodyRepresentations[feature.bodyId!]!.volume;

      manager.execute(
        edgeModifierCommand(feature, 'fillet', {
          name: 'Round',
          targetBodyId: body.bodyId,
          edgeHashes,
          size: 1,
          endRadius: 3,
          radiusLaw: 'scurve'
        })
      );
      const variableData = listFeaturesInOrder(manager.document).at(-1)!
        .data as Extract<FeatureData, { featureKind: 'fillet' }>;
      expect(variableData.endRadius).toBe(3);
      expect(variableData.radiusLaw).toBe('scurve');
      const variableGeometry = await kernel.syncDocument(manager.document);
      expect(variableGeometry.warnings).toEqual([]);
      const variableVolume =
        variableGeometry.bodyRepresentations[feature.bodyId!]!.volume;
      expect(variableVolume).not.toBeCloseTo(constantVolume, 6);

      manager.execute(
        edgeModifierCommand(
          listFeaturesInOrder(manager.document).at(-1)!,
          'fillet',
          {
            name: 'Round',
            targetBodyId: body.bodyId,
            edgeHashes,
            size: 2
          }
        )
      );
      const restored = listFeaturesInOrder(manager.document).at(-1)!
        .data as Extract<FeatureData, { featureKind: 'fillet' }>;
      expect('endRadius' in restored).toBe(false);
      expect('radiusLaw' in restored).toBe(false);
      const restoredGeometry = await kernel.syncDocument(manager.document);
      expect(restoredGeometry.warnings).toEqual([]);
      // Exactly the constant result, not a variable blend that resembles it.
      expect(
        restoredGeometry.bodyRepresentations[feature.bodyId!]!.volume
      ).toBeCloseTo(constantVolume, 9);
    } finally {
      kernel.dispose();
    }
  });

  it('drops an asymmetric chamfer back to the symmetric one', async () => {
    const { kernel, manager, body } = await plateWithVerticalEdges();
    try {
      const edgeHashes = [body.topology!.edges[0]!.hash];
      manager.execute(
        edgeModifierCommand(null, 'chamfer', {
          name: 'Bevel',
          targetBodyId: body.bodyId,
          edgeHashes,
          size: 2
        })
      );
      const feature = listFeaturesInOrder(manager.document).at(-1)!;
      const symmetricVolume = (await kernel.syncDocument(manager.document))
        .bodyRepresentations[feature.bodyId!]!.volume;

      manager.execute(
        edgeModifierCommand(feature, 'chamfer', {
          name: 'Bevel',
          targetBodyId: body.bodyId,
          edgeHashes,
          size: 1,
          distance2: 3
        })
      );
      const asymmetric = await kernel.syncDocument(manager.document);
      expect(asymmetric.warnings).toEqual([]);
      // 0.5·1·3 against 0.5·2·2: the asymmetric bevel leaves more material.
      expect(
        asymmetric.bodyRepresentations[feature.bodyId!]!.volume
      ).toBeGreaterThan(symmetricVolume);

      manager.execute(
        edgeModifierCommand(
          listFeaturesInOrder(manager.document).at(-1)!,
          'chamfer',
          {
            name: 'Bevel',
            targetBodyId: body.bodyId,
            edgeHashes,
            size: 2
          }
        )
      );
      const restored = listFeaturesInOrder(manager.document).at(-1)!
        .data as Extract<FeatureData, { featureKind: 'chamfer' }>;
      expect('distance2' in restored).toBe(false);
      const restoredGeometry = await kernel.syncDocument(manager.document);
      expect(restoredGeometry.warnings).toEqual([]);
      expect(
        restoredGeometry.bodyRepresentations[feature.bodyId!]!.volume
      ).toBeCloseTo(symmetricVolume, 9);
    } finally {
      kernel.dispose();
    }
  });

  it('refuses to clear a field a fillet cannot be built without', async () => {
    const { kernel, manager, body } = await plateWithVerticalEdges();
    try {
      manager.execute(
        edgeModifierCommand(null, 'fillet', {
          name: 'Round',
          targetBodyId: body.bodyId,
          edgeHashes: [body.topology!.edges[0]!.hash],
          size: 2
        })
      );
      const feature = listFeaturesInOrder(manager.document).at(-1)!;
      expect(() =>
        updateFeature(manager.document, {
          featureId: feature.featureId,
          clearData: ['radius']
        })
      ).toThrow(/cannot be cleared on a fillet feature/);
    } finally {
      kernel.dispose();
    }
  });

  it('refuses an unqualified radius law where the command is authored', async () => {
    const { kernel, manager, body } = await plateWithVerticalEdges();
    try {
      const command = commandFactories.filletEdges({
        name: 'Round',
        targetBodyId: body.bodyId,
        edgeHashes: [body.topology!.edges[0]!.hash],
        size: 1,
        endRadius: 3,
        // What an assistant or a hand-written payload can carry past the
        // schema's union. The rebuild refuses it too; this is the earlier of
        // the two gates, so the edit never reaches history.
        radiusLaw: 'cubic' as never
      });
      expect(() => command.validate(manager.document)).toThrow(
        /not one of the radius laws this kernel qualifies \(linear, scurve\)/
      );
    } finally {
      kernel.dispose();
    }
  });

  it('refuses a chamfer given both a second distance and an angle', async () => {
    const { kernel, manager, body } = await plateWithVerticalEdges();
    try {
      const command = commandFactories.chamferEdges({
        name: 'Bevel',
        targetBodyId: body.bodyId,
        edgeHashes: [body.topology!.edges[0]!.hash],
        size: 1,
        distance2: 3,
        angleDeg: 30
      });
      expect(() => command.validate(manager.document)).toThrow(
        /either a second distance or an angle, not both/
      );
    } finally {
      kernel.dispose();
    }
  });
});
