import {
  addPrimitiveFeature,
  createProjectDocument,
  gearBody,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

/** Synthetic reproduction of a live hash saved beside the blank's older reference. */
export async function staleGearReferenceDocument() {
  const adapter = await createExactKernelAdapter();
  try {
    const blank = addPrimitiveFeature(
      createProjectDocument('Gear reference regression', toUserId('user_test')),
      {
        name: 'Blank',
        primitiveKind: 'cylinder',
        dimensions: { radius: 50, height: 18 }
      }
    );
    const primitive = listFeaturesInOrder(blank)[0]!;
    const targetBodyId = primitive.bodyId!;
    const original = (await adapter.syncDocument(blank)).bodyRepresentations[
      targetBodyId
    ]!;
    const wall = original.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    const cut = gearBody(blank, {
      name: 'Teeth',
      gearType: 'external',
      sizing: 'module',
      teeth: 20,
      targetBodyId,
      faceHash: wall.hash,
      faceReference: wall.reference!
    });
    const taller = updateFeature(cut.document, {
      featureId: primitive.featureId,
      data: { dimensions: { height: 81 } }
    });
    const live = (await adapter.syncDocument(taller)).bodyRepresentations[
      targetBodyId
    ]!.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    const gear = listFeaturesInOrder(taller).at(-1)!;
    return updateFeature(taller, {
      featureId: gear.featureId,
      // The old edit seed changed just this half of the saved identity.
      data: { faceHash: live.hash }
    });
  } finally {
    adapter.dispose();
  }
}
