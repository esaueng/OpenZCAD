import * as THREE from 'three';
import type { Vector3 } from '@openzcad/shared';

export interface OffsetBodyPreview {
  /** False when the requested offset would collapse or invert the body. */
  apply(offset: number): boolean;
  restore(): void;
  readonly span: number;
}

/**
 * Builds a disposable whole-body proxy for a planar push/pull.
 *
 * The installed body is stretched along the picked outward normal while the
 * opposite support plane stays fixed. This is intentionally a viewport-only
 * affine approximation: it gives the hand one coherent prospective solid
 * immediately, while the exact kernel remains authoritative on release.
 */
export function createOffsetBodyPreview(
  object: THREE.Object3D,
  positions: ArrayLike<number>,
  direction: Vector3
): OffsetBodyPreview | null {
  const normal = new THREE.Vector3(direction.x, direction.y, direction.z);
  const magnitude = normal.length();
  if (!Number.isFinite(magnitude) || magnitude <= 1e-9) return null;
  normal.divideScalar(magnitude);

  object.updateMatrix();
  const originalMatrix = object.matrix.clone();
  const originalMatrixAutoUpdate = object.matrixAutoUpdate;
  const point = new THREE.Vector3();
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index + 2 < positions.length; index += 3) {
    point
      .set(
        positions[index] ?? 0,
        positions[index + 1] ?? 0,
        positions[index + 2] ?? 0
      )
      .applyMatrix4(originalMatrix);
    const projected = point.dot(normal);
    minimum = Math.min(minimum, projected);
    maximum = Math.max(maximum, projected);
  }
  const span = maximum - minimum;
  if (!Number.isFinite(span) || span <= 1e-9) return null;

  const stretch = new THREE.Matrix4();
  function restore() {
    object.matrix.copy(originalMatrix);
    object.matrixAutoUpdate = originalMatrixAutoUpdate;
    object.matrixWorldNeedsUpdate = true;
    object.updateMatrixWorld(true);
  }

  return {
    span,
    apply(offset) {
      if (!Number.isFinite(offset) || offset <= -span + 1e-6) return false;
      const factor = offset / span;
      const nx = normal.x;
      const ny = normal.y;
      const nz = normal.z;
      // p' = p + n * factor * (dot(n, p) - minimum)
      stretch.set(
        1 + factor * nx * nx,
        factor * nx * ny,
        factor * nx * nz,
        -factor * minimum * nx,
        factor * ny * nx,
        1 + factor * ny * ny,
        factor * ny * nz,
        -factor * minimum * ny,
        factor * nz * nx,
        factor * nz * ny,
        1 + factor * nz * nz,
        -factor * minimum * nz,
        0,
        0,
        0,
        1
      );
      object.matrixAutoUpdate = false;
      object.matrix.copy(stretch).multiply(originalMatrix);
      object.matrixWorldNeedsUpdate = true;
      object.updateMatrixWorld(true);
      return true;
    },
    restore
  };
}
