import {
  addPrimitiveFeature,
  createProjectDocument,
  gearBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

/** A cylinder with straight teeth cut along its wall, as in a cap-height edit. */
export async function spurGearDocument(helixAngleDeg = 0) {
  const adapter = await createExactKernelAdapter();
  try {
    const blank = addPrimitiveFeature(
      createProjectDocument('Gear height preview', toUserId('user_test')),
      {
        name: 'Blank',
        primitiveKind: 'cylinder',
        dimensions: { radius: 50, height: 26 }
      }
    );
    const targetBodyId = blank.bodyOrder[0]!;
    const body = (await adapter.syncDocument(blank)).bodyRepresentations[
      targetBodyId
    ]!;
    const wall = body.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    return gearBody(blank, {
      name: 'Teeth',
      gearType: 'external',
      sizing: 'module',
      teeth: 20,
      helixAngleDeg,
      targetBodyId,
      faceHash: wall.hash,
      ...(wall.reference ? { faceReference: wall.reference } : {})
    }).document;
  } finally {
    adapter.dispose();
  }
}
