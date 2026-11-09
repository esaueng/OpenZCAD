import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';

const TOP = 31.25;

const zRange = (edge: EdgeTopology) => {
  let low = Infinity;
  let high = -Infinity;
  for (let index = 2; index < edge.points.length; index += 3) {
    low = Math.min(low, edge.points[index]!);
    high = Math.max(high, edge.points[index]!);
  }
  return { low, high };
};

/**
 * A 30x18x24 box unioned with an r6, h31.25 cylinder whose axis stands on
 * the box's corner: the cylinder's top rim comes out of the union as four
 * quarter arcs, which the user selects as one closed edge.
 */
function cornerCylinderUnion(): { document: ProjectDocument; unionId: BodyId } {
  let document = createProjectDocument(
    'Corner cylinder rim',
    toUserId('user_corner_rim')
  );
  document = addPrimitiveFeature(document, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 30, height: 18, depth: 24 }
  });
  const boxId = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Cylinder',
    primitiveKind: 'cylinder',
    dimensions: { radius: 6, height: TOP }
  });
  const cylinderId = document.bodyOrder.at(-1)!;
  const manager = new CommandManager(document);
  document = manager.execute(
    commandFactories.booleanBodies({
      name: 'Union',
      operation: 'union',
      targetBodyIds: [boxId, cylinderId]
    })
  );
  return { document, unionId: document.bodyOrder.at(-1)! };
}

describe('corner-cylinder rim fillet', { timeout: 120_000 }, () => {
  it('never accepts a rim blend whose patches are bounded by straight chords', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const { document, unionId } = cornerCylinderUnion();
      const base = await adapter.syncDocument(document);
      expect(base.warnings).toEqual([]);
      const rim = base.bodyRepresentations[unionId]!.topology!.edges.filter(
        (edge) => zRange(edge).low > TOP - 1e-6
      );
      expect(rim.map((edge) => edge.curve?.type)).toEqual([
        'CIRCLE',
        'CIRCLE',
        'CIRCLE',
        'CIRCLE'
      ]);
      const fillet = (size: number) =>
        filletEdges(document, {
          name: `Rim ${size}`,
          targetBodyId: unionId,
          edgeHashes: rim.map((edge) => edge.hash),
          size
        });

      // Below R/2 the kernel builds the exact torus, and nothing changes.
      const small = fillet(2.9);
      const smallSync = await adapter.syncDocument(small.document);
      expect(smallSync.warnings).toEqual([]);
      const smallBody = smallSync.bodyRepresentations[small.bodyId]!;
      expect(
        smallBody.topology!.faces.some(
          (face) => face.geometry?.surfaceType === 'torus'
        )
      ).toBe(true);

      // At r3.8 the pinned kernel returns a four-patch approximate blend
      // whose seams and top-face sides are straight lines up to 1.1 off the
      // patches. Either the adapter refuses it with the size ladder's
      // advice, or (once the kernel builds the rim correctly) the blend
      // region carries no straight edge and the top face is round.
      const large = fillet(3.8);
      const largeSync = await adapter.syncDocument(large.document);
      const body = largeSync.bodyRepresentations[large.bodyId];
      const refusal = largeSync.warnings.find((warning) =>
        warning.includes('could not be created')
      );
      if (refusal) {
        expect(refusal).toMatch(
          /Fillet could not be created on the selected closed edge with radius 3\.8\. Try a smaller radius: radius (\d+(?:\.\d+)?) builds here\./
        );
        const quoted = Number(/radius ([\d.]+) builds here/.exec(refusal)![1]);
        expect(quoted).toBeGreaterThanOrEqual(2.5);
        expect(quoted).toBeLessThan(3.8);
        return;
      }
      expect(body).toBeDefined();
      const blendRegion = body!.topology!.edges.filter(
        (edge) => zRange(edge).low > TOP - 3.8 - 1e-6
      );
      expect(blendRegion.length).toBeGreaterThan(0);
      expect(blendRegion.filter((edge) => edge.curve?.type === 'LINE')).toEqual(
        []
      );
      const topEdges = blendRegion.filter(
        (edge) => zRange(edge).low > TOP - 1e-6
      );
      expect(topEdges.length).toBeGreaterThan(0);
      for (const edge of topEdges) {
        expect(edge.curve?.type).toBe('CIRCLE');
        expect(edge.curve?.circle?.radius).toBeCloseTo(6 - 3.8, 4);
      }
    } finally {
      adapter.dispose();
    }
  });
});
