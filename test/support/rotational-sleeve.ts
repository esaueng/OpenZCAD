import { readFileSync } from 'node:fs';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';

/**
 * Public rotational fixture from Remus's walking-stick-foot STEP regression.
 * The STEP header is replaced with anonymous test metadata. The edit sequence
 * retains three cylindrical walls, two conical supports and five torus bands.
 */
export async function rotationalSleeveStep(): Promise<Uint8Array> {
  const kernel = new RemusKernel();
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const cylinder = (solid: number, radius: number) => {
    const face = [...kernel.getSolidFaces(solid)].find((face) => {
      const p = JSON.parse(kernel.getAnalyticSurfaceParams(face)) as {
        type: string;
        radius?: number;
      };
      return p.type === 'cylinder' && near(p.radius!, radius);
    });
    if (face === undefined) throw new Error(`Missing R${radius} cylinder.`);
    return face;
  };
  try {
    const io = await loadRemusTranslators();
    let [solid] = kernel.deserializeSolids(
      io.importStep(
        readFileSync(
          new URL('../fixtures/step/rotational-sleeve.step', import.meta.url)
        )
      )
    );
    if (solid === undefined) throw new Error('Missing rotational fixture.');
    for (const [height, from, to] of [
      [30.156854249, 4, 3],
      [5.656854249, 4, 8.6],
      [7.562236639, 8.6, 5],
      [23.343145751, 4, 5],
      [29.742640685, 3, 5]
    ] as const) {
      const face = [...kernel.getSolidFaces(solid)].find((face) => {
        const p = JSON.parse(kernel.getAnalyticSurfaceParams(face)) as {
          type: string;
          center?: number[];
          minorRadius?: number;
        };
        return (
          p.type === 'torus' &&
          near(p.center![2]!, height) &&
          near(p.minorRadius!, from)
        );
      });
      if (face === undefined) throw new Error('Missing source blend.');
      solid = kernel.resizeBlend(solid, face, from, to);
    }
    for (const radius of [16.5, 12.5]) {
      const edge = [...kernel.getSolidEdges(solid)].find((edge) => {
        if (kernel.getEdgeCurveType(edge) !== 'CIRCLE') return false;
        const [x, y, z] = kernel.getEdgeVertices(edge);
        return near(Math.hypot(x!, y!), radius) && near(z!, 50);
      });
      if (edge === undefined) throw new Error('Missing top rim.');
      solid = kernel.fillet(solid, Uint32Array.of(edge), 1);
    }
    solid = kernel.resizeCylindricalFace(solid, cylinder(solid, 12.5), 12);
    let height = 9;
    for (const offset of [13, -7.5, -7, 9]) {
      const floor = [...kernel.getSolidFaces(solid)].find(
        (face) =>
          kernel.getSurfaceType(face) === 'plane' &&
          kernel.getFaceNormal(face)[2]! > 0.99 &&
          [...kernel.getFaceVertices(face)].every((vertex) =>
            near(kernel.getVertexPosition(vertex)[2]!, height)
          )
      );
      if (floor === undefined) throw new Error('Missing bore floor.');
      solid = kernel.moveFaces(solid, Uint32Array.of(floor), offset);
      height += offset;
    }
    solid = kernel.resizeCylindricalFace(solid, cylinder(solid, 12), 11.5);
    if (
      kernel.validateSolid(solid) !== 0 ||
      kernel.getSolidFaces(solid).length !== 13
    )
      throw new Error('Rotational fixture must retain its 13 analytic faces.');
    return io.exportStep(kernel.serializeSolids(Uint32Array.of(solid)));
  } finally {
    kernel.free();
  }
}
