import { PointPatternMeshWorker } from './point-pattern-mesh-worker';
import type { PatternMesh } from './point-pattern-mesh-output';
import { solidDisplayTessellation } from './exact-display-refinement';

import type { RemusKernel } from './remus-runtime';
import type { BuildCancellationSignal } from './exact-cancellation';
import type { DisplayTessellation } from './display-tessellation';
const helpers = new WeakMap<RemusKernel, PointPatternMeshWorker>();

export type PatternMeshSink = (mesh: PatternMesh) => void;
const sinks = new WeakMap<RemusKernel, PatternMeshSink>();

/** Only a live sync with a display consumer may start the auxiliary kernel. */
export function beginPatternMeshBuild(
  kernel: RemusKernel,
  sink?: PatternMeshSink
) {
  resetPatternMesh(kernel);
  if (sink && typeof Worker !== 'undefined') sinks.set(kernel, sink);
}

export function warmMesh(kernel: RemusKernel) {
  if (!sinks.has(kernel)) return;
  let helper = helpers.get(kernel);
  if (!helper) {
    helper = new PointPatternMeshWorker((mesh) => sinks.get(kernel)?.(mesh));
    helpers.set(kernel, helper);
  }
  helper.warm();
}

export function startMesh(
  kernel: RemusKernel,
  solid: number,
  heldDeflection: number | undefined,
  signal?: BuildCancellationSignal
) {
  const helper = helpers.get(kernel);
  if (!sinks.has(kernel) || !helper?.available || signal?.isCancelled()) return;
  try {
    const quality = solidDisplayTessellation(
      kernel.boundingBox(solid),
      heldDeflection
    );
    helper.start(
      solid,
      kernel.serializeSolids(Uint32Array.of(solid)),
      quality,
      signal
    );
  } catch {
    helpers.get(kernel)?.reset();
  }
}

export function pendingMesh(kernel: RemusKernel, solids: readonly number[]) {
  return helpers.get(kernel)?.wait(solids);
}

export function takePatternMesh(
  kernel: RemusKernel,
  solid: number,
  quality: DisplayTessellation
) {
  const mesh = helpers.get(kernel)?.take(solid, quality);
  if (!mesh) return;
  return { ...mesh, free() {} };
}

export function resetPatternMesh(kernel: RemusKernel) {
  sinks.delete(kernel);
  helpers.get(kernel)?.reset();
}

export function releasePatternMesh(kernel: RemusKernel) {
  sinks.delete(kernel);
  helpers.get(kernel)?.dispose();
  helpers.delete(kernel);
}
