import { drillHole } from '../../packages/kernel-adapter/src/exact-cylinder-ops';
import {
  remusTranslators,
  type RemusKernel
} from '../../packages/kernel-adapter/src/remus-runtime';

export function translation(x: number, y: number, z: number): Float64Array {
  return new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);
}

export function translated(
  kernel: RemusKernel,
  solid: number,
  x: number,
  y: number,
  z: number
): number {
  return kernel.copyAndTransformSolid(solid, translation(x, y, z));
}

/**
 * A 60 × 32 × 20 mm U-bracket: an 8 mm floor, two 8 mm arms (inner faces at
 * x = 8 and x = 52, a 44 mm opening), one Ø5 countersunk through hole per arm
 * at x = 4 and x = 56, and a one-sided boss on the left arm's inner face.
 * The boss stands in for embossed lettering: it breaks the mirror symmetry
 * without smuggling a proprietary glyph or a free-form surface into Git.
 * Requires the translators to be loaded (`loadRemusTranslators`).
 */
export interface SyntheticHolderOptions {
  /** Countersink the mounting bores (default). Plain bores otherwise. */
  countersink?: boolean;
  /** Drill the mounting bores at all (default). */
  holes?: boolean;
}

export function syntheticHolderSolid(
  kernel: RemusKernel,
  options: SyntheticHolderOptions = {}
): number {
  const countersink = options.countersink ?? true;
  const holes = options.holes ?? true;
  const sideProfile = kernel.makePolygon(
    new Float64Array([
      0, 0, 0, 60, 0, 0, 60, 32, 0, 52, 32, 0, 52, 8, 0, 8, 8, 0, 8, 32, 0, 0,
      32, 0
    ])
  );
  let holder = kernel.extrude(sideProfile, 0, 0, 1, 20);
  for (const x of holes ? [4, 56] : []) {
    holder = drillHole(kernel, holder, {
      surfacePoint: { x, y: 19, z: 20 },
      axis: { x: 0, y: 0, z: -1 },
      radius: 2.5,
      depth: 20,
      entryExtension: 0.2,
      exitExtension: 0.2,
      ...(countersink
        ? {
            style: 'countersink' as const,
            countersinkRadius: 4.5,
            countersinkAngle: Math.PI / 2
          }
        : { style: 'simple' as const })
    });
  }
  const emboss = translated(kernel, kernel.makeBox(0.4, 6, 4), 8, 14, 7);
  holder = kernel.fuse(holder, emboss);
  if (kernel.validateSolid(holder) !== 0)
    throw new Error('The synthetic holder must be a strictly valid solid.');
  return holder;
}

export function syntheticHolderStep(
  kernel: RemusKernel,
  options: SyntheticHolderOptions = {}
): Uint8Array {
  return remusTranslators().exportStep(
    kernel.serializeSolids(
      Uint32Array.of(syntheticHolderSolid(kernel, options))
    )
  );
}
