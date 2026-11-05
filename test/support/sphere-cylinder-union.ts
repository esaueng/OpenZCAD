import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

/** Synthetic five-feature history for an off-axis boss on a sphere. */
export function sphereCylinderUnionInputs() {
  let document = addPrimitiveFeature(
    createProjectDocument('Sphere cylinder union', toUserId('user_union_test')),
    {
      name: 'Sphere',
      bodyName: 'Sphere 1',
      primitiveKind: 'sphere',
      dimensions: { radius: 73.5 }
    }
  );
  const sphere = document.bodyOrder[0]!;
  document = transformBody(document, {
    name: 'Place sphere',
    targetBodyId: sphere,
    translation: { x: 25.5, y: -1.5, z: 0 }
  }).document;
  document = addPrimitiveFeature(document, {
    name: 'Cylinder',
    bodyName: 'Cylinder 1',
    primitiveKind: 'cylinder',
    dimensions: { radius: 6, height: 64.10000000000001 }
  });
  const cylinder = document.bodyOrder[1]!;
  for (const [name, z] of [
    ['Move', 46],
    ['Move 2', 12]
  ] as const) {
    document = transformBody(document, {
      name,
      targetBodyId: cylinder,
      translation: { x: 0, y: 0, z }
    }).document;
  }
  return { document, sphere, cylinder };
}
