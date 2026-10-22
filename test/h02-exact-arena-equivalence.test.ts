import { expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import {
  captureExactArenas,
  compareExactArenas
} from './support/exact-arena-equivalence';

it('captures live cache-hit arenas and detects changed exact geometry without exporting', async () => {
  const adapter = await createExactKernelAdapter();
  try {
    const document = addPrimitiveFeature(
      createProjectDocument('Arena qualification', toUserId('test')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 8, depth: 6 }
      }
    );
    const initial = await captureExactArenas(adapter, document, () =>
      adapter.syncDocument(document)
    );
    const hit = await captureExactArenas(adapter, document, () =>
      adapter.syncDocument(document)
    );
    expect(compareExactArenas(hit.bodies, initial.bodies).equivalent).toBe(
      true
    );
    expect(initial.bodies[0]!.solids).toBe(1);
    expect(initial.bodies[0]!.bytes.byteLength).toBeGreaterThan(0);

    // No tolerance or numeric normalization may hide even one changed byte.
    const altered = initial.bodies.map((body) => ({
      ...body,
      bytes: body.bytes.slice()
    }));
    altered[0]!.bytes[0] = altered[0]!.bytes[0]! ^ 1;
    expect(compareExactArenas(altered, initial.bodies).equivalent).toBe(false);

    const changed = updateFeature(document, {
      featureId: listFeaturesInOrder(document)[0]!.featureId,
      data: { dimensions: { width: 12, height: 8, depth: 6 } }
    });
    const edited = await captureExactArenas(adapter, changed, () =>
      adapter.syncDocument(changed)
    );
    expect(compareExactArenas(edited.bodies, initial.bodies).equivalent).toBe(
      false
    );
  } finally {
    adapter.dispose();
  }
});
