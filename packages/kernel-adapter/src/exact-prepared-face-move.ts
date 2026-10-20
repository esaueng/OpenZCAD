import type { RemusKernel } from './remus-runtime';

/**
 * Remus's prepared face moves: a face drag restores the same checkpoint
 * every frame and moves the same face to a new source-relative distance, so
 * the kernel can read everything that does not depend on the distance once
 * (`prepareMoveFaces`) and each frame runs only the rest. The prepared call
 * returns exactly what `moveFacesJournaled` returns for the same source,
 * faces and distance, and refuses, editing nothing, once the source content
 * differs from the prepared one.
 *
 * Kernels built before the API shipped lack these methods; every caller then
 * keeps the unprepared move.
 */
interface PreparedMoveBindings {
  prepareMoveFaces(solid: number, faces: Uint32Array): number;
  moveFacesPreparedJournaled(prepared: number, distance: number): string;
  releasePreparedMove(prepared: number): boolean;
}

/** One prepared selection's moves; see {@link preparedFaceMove}. */
export interface PreparedFaceMove {
  /** `moveFacesJournaled` of the prepared selection. */
  moveJournaled(distance: number): string;
}

/**
 * The drag target a kernel last saw, prepared once it repeated. `handle` is
 * null until the same target is moved twice in a row: preparing costs about
 * one unprepared move, which a target whose handles change every frame would
 * pay again on each one.
 */
interface DragTarget {
  readonly solid: number;
  readonly faces: readonly number[];
  handle: number | null;
}

const dragTargets = new WeakMap<RemusKernel, DragTarget>();

function bindingsOf(kernel: RemusKernel): PreparedMoveBindings | null {
  const candidate = kernel as unknown as Partial<PreparedMoveBindings>;
  return typeof candidate.prepareMoveFaces === 'function' &&
    typeof candidate.moveFacesPreparedJournaled === 'function' &&
    typeof candidate.releasePreparedMove === 'function'
    ? (candidate as PreparedMoveBindings)
    : null;
}

function sameFaces(a: readonly number[], b: Uint32Array): boolean {
  return a.length === b.length && a.every((face, index) => face === b[index]);
}

/**
 * The prepared moves of `faces` of `solid` for a drag preview, or null when
 * the kernel has no prepared moves or this target is new; the caller then
 * runs the unprepared move. A kernel holds at most one preparation: a new
 * target releases the previous one.
 */
export function preparedFaceMove(
  kernel: RemusKernel,
  solid: number,
  faces: Uint32Array
): PreparedFaceMove | null {
  const bindings = bindingsOf(kernel);
  if (!bindings) return null;
  const target = dragTargets.get(kernel);
  if (!target || target.solid !== solid || !sameFaces(target.faces, faces)) {
    releasePreparedFaceMove(kernel);
    dragTargets.set(kernel, { solid, faces: Array.from(faces), handle: null });
    return null;
  }
  if (target.handle === null) {
    try {
      target.handle = bindings.prepareMoveFaces(solid, faces);
    } catch {
      return null;
    }
  }
  const handle = target.handle;
  return {
    moveJournaled: (distance) =>
      bindings.moveFacesPreparedJournaled(handle, distance)
  };
}

/** Releases the kernel's preparation, if any, and forgets its drag target. */
export function releasePreparedFaceMove(kernel: RemusKernel): void {
  const target = dragTargets.get(kernel);
  dragTargets.delete(kernel);
  if (target?.handle == null) return;
  try {
    bindingsOf(kernel)?.releasePreparedMove(target.handle);
  } catch {
    // A freed kernel owns nothing left to release.
  }
}
