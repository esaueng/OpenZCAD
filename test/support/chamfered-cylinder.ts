import type { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';

/** A 240 mm rod, diameter 20 mm, with an 8 mm-radius end disc. */
export function chamferedCylinderSolid(
  kernel: RemusKernel,
  options: { topChamfer?: boolean; mirrored?: boolean } = {}
): number {
  const cylinder = kernel.makeCylinder(10, 240);
  const rims = [...kernel.getSolidEdges(cylinder)].filter(
    (edge) =>
      kernel.getEdgeCurveType(edge) === 'CIRCLE' &&
      (options.topChamfer !== false || kernel.getEdgeVertices(edge)[2] === 0)
  );
  const chamfered = kernel.chamfer(cylinder, Uint32Array.from(rims), 2);
  return options.mirrored
    ? kernel.mirror(chamfered, 0, 0, 0, 0, 0, 1)
    : chamfered;
}
