import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  importStepBody,
  setNodeMetadata
} from '@openzcad/document-core';
import { toUserId, type BodyId } from '@openzcad/shared';

import { createExactKernelAdapter } from './exact';

const user = toUserId('user_step_bodies');

/** Box A alone; box B united with a cylinder into one result body. */
function twoShownBodies() {
  let doc = addPrimitiveFeature(createProjectDocument('Source', user), {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 4, depth: 30 }
  });
  const plate = doc.bodyOrder[0] as BodyId;
  doc = addPrimitiveFeature(doc, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  const block = doc.bodyOrder[1] as BodyId;
  doc = addPrimitiveFeature(doc, {
    name: 'Peg',
    primitiveKind: 'cylinder',
    dimensions: { radius: 2, height: 20 }
  });
  const peg = doc.bodyOrder[2] as BodyId;
  const united = booleanBodies(doc, {
    name: 'Union',
    operation: 'union',
    targetBodyIds: [block, peg]
  });
  const plateNode = Object.values(united.document.nodes).find(
    (node) => node.kind === 'body' && node.bodyId === plate
  )!;
  doc = setNodeMetadata(united.document, {
    nodeId: plateNode.id,
    metadata: { color: '#e5534b', colorChosen: true }
  });
  return { document: doc, plate, block, peg, union: united.bodyId };
}

describe('exportStepBodies', { timeout: 60_000 }, () => {
  it('writes every shown body, maps its solids, and round-trips by index', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const { document, plate, union } = twoShownBodies();
      const source = await adapter.syncDocument(document);
      const exported = await adapter.exportStepBodies(document);

      // Consumed operands stay out; the two shown bodies keep their order.
      expect(exported.bodies).toEqual([
        { bodyId: plate, solidCount: 1 },
        { bodyId: union, solidCount: 1 }
      ]);
      expect(exported.skipped).toEqual([]);
      // Each solid is named after its body and drawn in its colour.
      const names = exported.text.match(/MANIFOLD_SOLID_BREP\('[^']*'/g);
      expect(names).toEqual([
        "MANIFOLD_SOLID_BREP('Plate Body'",
        "MANIFOLD_SOLID_BREP('Block Body'"
      ]);
      expect(exported.text).toContain(
        "COLOUR_RGB('', 0.8980392156862745,0.3254901960784314,0.29411764705882354)"
      );

      // Each declared index lands as its own body with its own volume.
      let target = createProjectDocument('Target', user);
      const ids: BodyId[] = [];
      for (const [index, name] of ['Plate', 'Union'].entries()) {
        const imported = importStepBody(target, {
          name,
          artifactId: 'artifact_local_step_bodies',
          sourceName: 'Source.step',
          stepText: exported.text,
          solidIndices: [index]
        });
        target = imported.document;
        ids.push(imported.bodyId);
      }
      const inserted = await adapter.syncDocument(target);
      expect(inserted.bodyRepresentations[ids[0]!]!.volume).toBeCloseTo(
        source.bodyRepresentations[plate]!.volume,
        3
      );
      expect(inserted.bodyRepresentations[ids[1]!]!.volume).toBeCloseTo(
        source.bodyRepresentations[union]!.volume,
        3
      );
    } finally {
      adapter.dispose();
    }
  });

  it('refuses a document with nothing to write', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      await expect(
        adapter.exportStepBodies(createProjectDocument('Empty', user))
      ).rejects.toThrow('no solid body');
    } finally {
      adapter.dispose();
    }
  });
});
