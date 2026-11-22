import { describe, expect, it } from 'vitest';
import { filletEdges } from '@openzcad/document-core';
import { createExactKernelAdapter } from '../packages/kernel-adapter/src/exact';
import {
  roundedCornerBox,
  topOutlineRoundRemoval
} from './fixtures/rounded-corner-box';

/**
 * M03 tangent-edge chains: the top outline of a box with rounded corners is
 * one tangent chain of four lines and four arcs. A constant fillet along the
 * whole chain is exact (cylinders along the lines, tori around the arcs) and
 * measures its closed form. A variable radius along it is refused by type:
 * a variable section is exact only on a straight spine, and the chain's arcs
 * are curved spines.
 */
describe('fillets along a tangent chain (M03)', { timeout: 120_000 }, () => {
  it('rounds the whole chain exactly at constant radius and refuses a variable one by type', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const sync = (document: Parameters<typeof adapter.syncDocument>[0]) =>
        adapter.syncDocument(document);
      const { document, bodyId, volume, topOutline } =
        await roundedCornerBox(sync);
      expect(topOutline.map((edge) => edge.curve?.type).sort()).toEqual([
        'CIRCLE',
        'CIRCLE',
        'CIRCLE',
        'CIRCLE',
        'LINE',
        'LINE',
        'LINE',
        'LINE'
      ]);
      const pick = {
        name: 'Top',
        targetBodyId: bodyId,
        edgeHashes: topOutline.map((edge) => edge.hash),
        edgeReferences: topOutline.map((edge) => edge.reference!)
      };
      const straight = topOutline
        .filter((edge) => edge.curve?.type === 'LINE')
        .reduce((sum, edge) => sum + edge.length!, 0);
      expect(straight).toBeCloseTo(2 * 30 + 2 * 20, 9);

      const constant = filletEdges(document, { ...pick, size: 2 });
      const built = await adapter.syncDocument(constant.document);
      expect(built.warnings).toEqual([]);
      const body = built.bodyRepresentations[constant.bodyId]!;
      expect(volume - body.volume).toBeCloseTo(
        topOutlineRoundRemoval(2, straight),
        6
      );
      expect(body.exportableStep).toBe(true);

      const variable = filletEdges(document, {
        ...pick,
        size: 2,
        endRadius: 3,
        radiusLaw: 'linear'
      });
      const refused = await adapter.syncDocument(variable.document);
      const failure = refused.featureWarnings?.find(
        (warning) =>
          warning.kind === 'build-failed' || warning.kind === 'refusal'
      );
      expect(failure?.kernelRefusal?.family).toBe('blend');
    } finally {
      adapter.dispose();
    }
  });
});
