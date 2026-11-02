import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';

/** A public 32 × 20 tab, R6 boss, R5 shoulder and R1.8 fixed cap. */
export async function shoulderCapStep(
  dimensions: { height: number; capHeight: number } = {
    height: 19.1,
    capHeight: 28.5
  },
  filletShoulder = true
): Promise<Uint8Array> {
  const kernel = new RemusKernel();
  try {
    const { height, capHeight } = dimensions;
    const bossRadius = 6;
    const box = kernel.makeBox(32, 20, height);
    const boss = kernel.makeCylinder(bossRadius, capHeight);
    let solid = kernel.fuse(boss, box);
    const cap = Array.from(kernel.getSolidFaces(solid)).find(
      (face) =>
        kernel.getSurfaceType(face) === 'plane' &&
        Array.from(kernel.getFaceVertices(face)).every(
          (vertex) =>
            Math.abs(kernel.getVertexPosition(vertex)[2]! - capHeight) < 1e-7
        )
    );
    if (cap === undefined) throw new Error('Synthetic cap plane is absent.');
    solid = kernel.fillet(solid, kernel.getFaceEdges(cap), 1.8);
    if (!filletShoulder) {
      const io = await loadRemusTranslators();
      return io.exportStep(kernel.serializeSolids(Uint32Array.of(solid)));
    }
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-7;
    const shoulderEdges = Array.from(kernel.getSolidEdges(solid)).filter(
      (edge) => {
        const [ax, ay, az, bx, by, bz] = kernel.getEdgeVertices(
          edge
        ) as unknown as [number, number, number, number, number, number];
        const top = near(az, height) && near(bz, height);
        const kind = kernel.getEdgeCurveType(edge);
        if (kind === 'CIRCLE') return top;
        return (
          kind === 'LINE' &&
          ((top &&
            ((near(ax, 0) && near(bx, 0)) || (near(ay, 0) && near(by, 0)))) ||
            (Math.abs(az - bz) > height - 0.01 &&
              ((near(ax, bossRadius) &&
                near(bx, bossRadius) &&
                near(ay, 0) &&
                near(by, 0)) ||
                (near(ay, bossRadius) &&
                  near(by, bossRadius) &&
                  near(ax, 0) &&
                  near(bx, 0)))))
        );
      }
    );
    if (shoulderEdges.length !== 5)
      throw new Error('Synthetic shoulder requires five construction edges.');
    solid = kernel.fillet(solid, Uint32Array.from(shoulderEdges), 5);
    if (
      kernel.getSolidFaces(solid).length !== 16 ||
      kernel.validateSolid(solid) !== 0
    )
      throw new Error(
        'Synthetic shoulder must retain its valid support-first corners.'
      );
    const io = await loadRemusTranslators();
    return io.exportStep(kernel.serializeSolids(Uint32Array.of(solid)));
  } finally {
    kernel.free();
  }
}
