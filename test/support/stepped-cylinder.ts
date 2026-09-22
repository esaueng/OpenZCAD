import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { transformMatrix } from '../../packages/kernel-adapter/src/exact-math';

/** Authored two-diameter part, with rounded caps and shoulder; no source model. */
export async function steppedCylinderDocument(tilted = false) {
  const kernel = new RemusKernel();
  try {
    const profile = [
      [0, -14],
      [5, -14],
      [5, 0],
      [9, 0],
      [9, 26],
      [0, 26]
    ];
    const edges = profile.map(([r, z], i) => {
      const next = profile[(i + 1) % profile.length]!;
      return kernel.makeLineEdge(r!, 0, z!, next[0]!, 0, next[1]!);
    });
    const face = kernel.makePlanarFaceFromWire(
      kernel.makeWire(Uint32Array.from(edges), true)
    );
    let solid = kernel.revolve(face, 0, 0, 0, 0, 0, 1, 360);
    const circles = Array.from(kernel.getSolidEdges(solid)).filter(
      (edge) => kernel.getEdgeCurveType(edge) === 'CIRCLE'
    );
    solid = kernel.fillet(solid, Uint32Array.from(circles), 1);
    if (tilted)
      solid = kernel.copyAndTransformSolid(
        solid,
        transformMatrix({ x: 40, y: -20, z: 10 }, { x: 0, y: 90, z: 0 })
      );
    const io = await loadRemusTranslators();
    const stepText = new TextDecoder().decode(
      io.exportStep(kernel.serializeSolids(new Uint32Array([solid])))
    );
    return importStepBody(
      createProjectDocument('Stepped cap preview', toUserId('user_test')),
      {
        name: 'Stepped cylinder',
        sourceName: 'stepped-cylinder.step',
        artifactId: 'artifact_stepped_cylinder',
        stepText
      }
    );
  } finally {
    kernel.free();
  }
}
