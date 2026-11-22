import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';

export const COLLAPSE_BLOCK = { x: 27, y: 24, z: 16, round: 8.8 } as const;

/**
 * An imported 27 × 24 × 16 mm block whose two +X vertical edges are rounded
 * at R8.8, so its Right face keeps a flat only 24 − 2 × 8.8 = 6.4 mm wide.
 * Pushing the Front face (y = 0) in shortens that flat, and the kernel
 * refuses a move past 6.4 because the flat would shrink to nothing: the
 * neighbour-collapse refusal, with a limit. The same body as
 * `test/parity/offset-face-fillet-limit.spec.ts`, without its extra rounds.
 */
export async function collapseLimitBlockDocument() {
  const { x, y, z, round } = COLLAPSE_BLOCK;
  const kernel = new RemusKernel();
  try {
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    const box = kernel.makeBox(x, y, z);
    const rightVertical = Array.from(kernel.getSolidEdges(box)).filter(
      (edge) => {
        const [ax, ay, , bx, by] = Array.from(kernel.getEdgeVertices(edge));
        return (
          near(ax!, x) &&
          near(bx!, x) &&
          ((near(ay!, 0) && near(by!, 0)) || (near(ay!, y) && near(by!, y)))
        );
      }
    );
    if (rightVertical.length !== 2) {
      throw new Error('The block’s two +X vertical edges were not found.');
    }
    const solid = kernel.fillet(box, Uint32Array.from(rightVertical), round);
    const io = await loadRemusTranslators();
    const stepText = new TextDecoder().decode(
      io.exportStep(kernel.serializeSolids(Uint32Array.of(solid)))
    );
    return importStepBody(
      createProjectDocument('Collapse limit block', toUserId('user_test')),
      {
        name: 'Block',
        sourceName: 'collapse-limit-block.step',
        artifactId: 'artifact_collapse_limit_block',
        stepText
      }
    );
  } finally {
    kernel.free();
  }
}
