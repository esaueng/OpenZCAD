import type { RemusKernel } from './remus-runtime';

/**
 * A trimmed spline's control hull can cross the source box although the
 * fillet stays inside it. Certify only those loose faces at a finer chord
 * tolerance; keep the original envelope tolerance and all other guards.
 * Missing bindings or a tessellation work limit fail closed.
 */
export function certifyFilletEnvelope(
  kernel: RemusKernel,
  solid: number,
  bounds: ArrayLike<number>,
  tolerance: number
): boolean {
  if (
    typeof kernel.makeSheetBody !== 'function' ||
    typeof kernel.sheetBoundingBox !== 'function' ||
    typeof kernel.tessellateFace !== 'function' ||
    typeof kernel.checkpoint !== 'function' ||
    typeof kernel.restore !== 'function' ||
    typeof kernel.discardCheckpoint !== 'function'
  )
    return false;
  const checkpoint = kernel.checkpoint();
  const deflection = tolerance / 4;
  try {
    const faces = kernel.getSolidFaces(solid);
    if (faces.length === 0) return false;
    for (const face of faces) {
      const box = kernel.sheetBoundingBox(
        kernel.makeSheetBody(Uint32Array.of(face))
      );
      if (box.length !== 6 || [...box].some((value) => !Number.isFinite(value)))
        return false;
      const sides = Array.from({ length: 6 }, (_, side) => side).filter(
        (side) =>
          side < 3
            ? box[side]! < bounds[side]! - tolerance
            : box[side]! > bounds[side]! + tolerance
      );
      if (sides.length === 0) continue;
      const mesh = kernel.tessellateFace(face, deflection, 0.06);
      try {
        const positions = mesh.positions;
        if (positions.length < 3 || positions.length % 3 !== 0) return false;
        const extremes = [
          Infinity,
          Infinity,
          Infinity,
          -Infinity,
          -Infinity,
          -Infinity
        ];
        for (let at = 0; at < positions.length; at += 3) {
          for (let axis = 0; axis < 3; axis++) {
            const value = positions[at + axis]!;
            if (!Number.isFinite(value)) return false;
            extremes[axis] = Math.min(extremes[axis]!, value);
            extremes[axis + 3] = Math.max(extremes[axis + 3]!, value);
          }
        }
        for (const side of sides) {
          // Include the chord error and the same conservative Float32
          // rounding allowance used by exact-bounds, even for Float64 data.
          const slack = deflection + 4 * Math.abs(extremes[side]!) * 2 ** -23;
          if (
            side < 3
              ? extremes[side]! - slack < bounds[side]! - tolerance
              : extremes[side]! + slack > bounds[side]! + tolerance
          )
            return false;
        }
      } finally {
        mesh.free();
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    // The candidate predates this checkpoint; only temporary sheets go away.
    kernel.restore(checkpoint);
    kernel.discardCheckpoint(checkpoint);
  }
}
