import type { ProjectId } from '@openzcad/shared';
import { drillHole } from './exact-cylinder-ops';
import type { HoleBore } from './exact-feature-builders';
import type { RemusKernel } from './remus-runtime';

interface CheckedBores {
  projectId: ProjectId;
  stock: Uint8Array;
  parameters: Float64Array;
  solid: Uint8Array;
  count: number;
}

const checkedBores = new WeakMap<RemusKernel, CheckedBores>();
const MAX_BYTES = 128 * 1024;

export function clearCheckedHoleCuts(kernel: RemusKernel): void {
  checkedBores.delete(kernel);
}

// These are the complete inputs to a simple cylindrical cutter and its bore
// proof. Object.is also distinguishes signed zero when matching a prefix.
function simpleParameters(bores: readonly HoleBore[]): Float64Array {
  return Float64Array.from(
    bores.flatMap(({ spec }) => [
      spec.surfacePoint.x,
      spec.surfacePoint.y,
      spec.surfacePoint.z,
      spec.axis.x,
      spec.axis.y,
      spec.axis.z,
      spec.radius,
      spec.depth,
      spec.entryExtension,
      spec.exitExtension
    ])
  );
}

function captureSolid(
  kernel: RemusKernel,
  solid: number
): Uint8Array | undefined {
  try {
    return kernel.serializeSolids(Uint32Array.of(solid));
  } catch {
    return undefined;
  }
}

/** Reuse only checked cuts that start from identical stock with identical tools.
 * Only the cut solid is restored. The caller names its faces for this revision. */
export function drillFeatureBores(
  kernel: RemusKernel,
  projectId: ProjectId,
  targetSolid: number,
  bores: readonly HoleBore[],
  simplePointHolesOnBox: boolean
): number {
  let solid = targetSolid;
  let start = 0;
  let stock: Uint8Array | undefined;
  let parameters: Float64Array | undefined;
  let prefix: Uint8Array | undefined;
  if (
    simplePointHolesOnBox &&
    bores.length >= 8 &&
    bores.length <= 32 &&
    kernel.getSolidFaces(targetSolid).length === 6
  ) {
    stock = captureSolid(kernel, targetSolid);
    const current = simpleParameters(bores);
    parameters = current;
    const old = checkedBores.get(kernel);
    if (
      stock &&
      old?.projectId === projectId &&
      old.count <= bores.length &&
      old.stock.length === stock.length &&
      stock.every((byte, i) => byte === old.stock[i]) &&
      old.parameters.every((number, i) => Object.is(number, current[i]))
    ) {
      try {
        const restored = kernel.deserializeSolids(old.solid);
        if (restored.length === 1) {
          solid = restored[0]!;
          start = old.count;
        } else {
          for (const handle of restored) kernel.deleteSolid(handle);
        }
      } catch {
        // An unavailable snapshot costs a replay of the ordinary checked cuts.
      }
    }
  }
  for (let i = start; i < bores.length; i++) {
    const { spec, pointId } = bores[i]!;
    try {
      solid = drillHole(kernel, solid, spec);
    } catch (error) {
      if (pointId === null || !(error instanceof Error)) throw error;
      throw new Error(`At sketch point ${pointId}: ${error.message}`, {
        cause: error
      });
    }
    if (
      stock &&
      parameters &&
      i === bores.length - 2 &&
      stock.byteLength + parameters.byteLength < MAX_BYTES
    )
      prefix = captureSolid(kernel, solid);
  }
  if (
    stock &&
    parameters &&
    prefix &&
    stock.byteLength + parameters.byteLength + prefix.byteLength <= MAX_BYTES
  ) {
    const count = bores.length - 1;
    checkedBores.set(kernel, {
      projectId,
      stock,
      count,
      solid: prefix,
      parameters: parameters.slice(
        0,
        (parameters.length / bores.length) * count
      )
    });
  }
  return solid;
}
