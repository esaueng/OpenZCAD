import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import { toUserId, type BodyId } from '@openzcad/shared';
import { createExactKernelAdapter } from './exact';

const user = toUserId('user_blend');

/**
 * A blend refusal has to name a cause the user can act on, and the causes are
 * not guessable from the selection: every edge of a plain box meets another at
 * a corner and they all round together, so "these edges touch" cannot be what
 * makes a selection refuse. Only the kernel knows which vertex its blend
 * engines gave up on, so these tests pin that its account survives to the
 * message instead of being replaced by an inference.
 */
describe('edge modifier failure diagnosis', { timeout: 60_000 }, () => {
  it('rounds every edge of a plain box, corners and all', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      let doc = addPrimitiveFeature(createProjectDocument('Box', user), {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      });
      const bodyId = doc.bodyOrder[0] as BodyId;
      const built = await adapter.syncDocument(doc);
      const edges = built.bodyRepresentations[bodyId]?.topology?.edges ?? [];
      expect(edges.length).toBe(12);

      doc = filletEdges(doc, {
        name: 'Round all',
        targetBodyId: bodyId,
        edgeHashes: edges.map((edge) => edge.hash),
        size: 2
      }).document;
      const derived = await adapter.syncDocument(doc);
      expect(derived.warnings).toEqual([]);
    } finally {
      adapter.dispose();
    }
  });

  it('names the blendable subset when a corner defeats the whole selection', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      let doc = addPrimitiveFeature(createProjectDocument('Notched', user), {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      });
      const boxId = doc.bodyOrder[0] as BodyId;
      doc = addPrimitiveFeature(doc, {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 14, height: 28 }
      });
      const cylId = doc.bodyOrder[1] as BodyId;
      const cut = booleanBodies(doc, {
        name: 'Notch',
        operation: 'subtract',
        targetBodyIds: [boxId, cylId]
      });
      doc = cut.document;
      const built = await adapter.syncDocument(doc);
      const edges =
        built.bodyRepresentations[cut.bodyId]?.topology?.edges ?? [];
      expect(edges.length).toBeGreaterThan(12);

      doc = filletEdges(doc, {
        name: 'Round all',
        targetBodyId: cut.bodyId,
        edgeHashes: edges.map((edge) => edge.hash),
        size: 2
      }).document;
      const derived = await adapter.syncDocument(doc);
      const failure = derived.warnings.join(' ');

      // The remedy is a count the kernel measured, not a property of the
      // selection: deselect the few it refused and the rest still round.
      expect(failure).toMatch(/cannot be blended where two rounds would meet/);
      expect(failure).toMatch(/round on their own/);
      expect(failure).toMatch(/deselect those \d+/);

      // The claim a plain box disproves must not come back.
      expect(failure).not.toMatch(/Edges that meet at a shared corner cannot be/);
      expect(failure).not.toMatch(/at any radius/);
    } finally {
      adapter.dispose();
    }
  });
});
