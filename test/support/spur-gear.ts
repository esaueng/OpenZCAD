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

/** A spur gear built as its own body: module 0.8, 20 teeth, 10 wide. */
export function standaloneSpurGearDocument() {
  return gearBody(
    createProjectDocument('Gear face width', toUserId('user_test')),
    {
      name: 'Gear',
      gearType: 'external',
      sizing: 'module',
      pitch: 0.8,
      teeth: 20,
      faceWidth: 10,
      origin: { x: 0, y: 0, z: 0 },
      axis: { x: 0, y: 0, z: 1 }
    }
  ).document;
}
