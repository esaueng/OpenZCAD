import type { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import { transformMatrix } from '../../packages/kernel-adapter/src/exact-math';

/** Authored overlapping components, exported together without a union. */
export function compoundOffsetSolids(kernel: RemusKernel): number[] {
  const place = (solid: number, x: number, y = 0, z = 0, rotateY = 0) =>
    kernel.copyAndTransformSolid(
      solid,
      transformMatrix({ x, y, z }, { x: 0, y: rotateY, z: 0 })
    );
  return [
    place(kernel.makeCylinder(8, 25), 30, 0, 0, 90),
    place(kernel.makeSphere(8, 32), -30),
    place(kernel.makeCylinder(15, 12), 51, 0, 0, 90),
    place(kernel.makeBox(35, 20, 20), 0, -10, -10)
  ];
}
