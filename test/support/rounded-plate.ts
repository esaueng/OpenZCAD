import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { toUserId, type UnitSystem } from '@openzcad/shared';
import { drillHole } from '../../packages/kernel-adapter/src/exact-cylinder-ops';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';

export interface RoundedPlateOptions {
  units?: UnitSystem;
  /** x of an extra Ø2 through hole; 76 sits inside the +X corner rounds. */
  edgeHoleX?: number;
}

/**
 * An imported 80 × 40 × 6 mm plate with R5 vertical corner rounds and a Ø10
 * through hole in the middle: the shape of a bracket's base, whose side faces
 * meet curved neighbours and whose top carries a feature. No source model.
 */
export async function roundedPlateDocument(options: RoundedPlateOptions = {}) {
  const kernel = new RemusKernel();
  try {
    const box = kernel.makeBox(80, 40, 6);
    const vertical = Array.from(kernel.getSolidEdges(box)).filter((edge) => {
      const ends = Array.from(kernel.getEdgeVertices(edge));
      return Math.abs(ends[2]! - ends[5]!) > 1e-12;
    });
    let solid = kernel.fillet(box, Uint32Array.from(vertical), 5);
    const holes: [number, number, number][] = [[40, 20, 5]];
    if (options.edgeHoleX !== undefined) holes.push([options.edgeHoleX, 20, 1]);
    for (const [x, y, radius] of holes) {
      solid = drillHole(kernel, solid, {
        surfacePoint: { x, y, z: 6 },
        axis: { x: 0, y: 0, z: -1 },
        radius,
        depth: 6,
        style: 'simple',
        entryExtension: 0.2,
        exitExtension: 0.2
      });
    }
    const io = await loadRemusTranslators();
    const stepText = new TextDecoder().decode(
      io.exportStep(kernel.serializeSolids(new Uint32Array([solid])))
    );
    return importStepBody(
      createProjectDocument(
        'Rounded plate preview',
        toUserId('user_test'),
        options.units
      ),
      {
        name: 'Rounded plate',
        sourceName: 'rounded-plate.step',
        artifactId: 'artifact_rounded_plate',
        stepText
      }
    );
  } finally {
    kernel.free();
  }
}
