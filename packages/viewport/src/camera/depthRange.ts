import * as THREE from 'three';

/**
 * Fit depth planes to the geometry being drawn, without changing its framing.
 * Recomputed after navigation and previews: saved poses carry no depth range,
 * and a fixed far plane can slice a full-size assembly even when it fits in XY.
 * `focusDistance` is the camera-to-orbit-target distance in model units. It
 * retains Fit's relative depth precision when a coarse moving AABB straddles
 * the camera, without imposing a fixed minimum inspection scale.
 */
export function updateCameraClipping(
  camera: THREE.Camera,
  bounds: THREE.Box3,
  focusDistance = 0
) {
  if (
    !(camera instanceof THREE.PerspectiveCamera) &&
    !(camera instanceof THREE.OrthographicCamera)
  ) {
    return;
  }
  if (bounds.isEmpty()) return;

  camera.updateWorldMatrix(true, false);
  const e = camera.matrixWorldInverse.elements;
  // Depth is linear in world coordinates. The support of the world AABB
  // along the view axis gives the same extrema as projecting its eight corners.
  const centerDepth = -(
    e[2] * ((bounds.min.x + bounds.max.x) / 2) +
    e[6] * ((bounds.min.y + bounds.max.y) / 2) +
    e[10] * ((bounds.min.z + bounds.max.z) / 2) +
    e[14]
  );
  const halfDepth =
    (Math.abs(e[2]) * (bounds.max.x - bounds.min.x) +
      Math.abs(e[6]) * (bounds.max.y - bounds.min.y) +
      Math.abs(e[10]) * (bounds.max.z - bounds.min.z)) /
    2;
  const closest = centerDepth - halfDepth;
  const furthest = centerDepth + halfDepth;
  if (!Number.isFinite(closest) || !Number.isFinite(furthest)) return;
  if (camera instanceof THREE.PerspectiveCamera && furthest <= 0) return;

  // Leave breathing room at both ends, including for a zero-thickness sketch
  // and the screen-sized handles drawn in front of the model.
  // Restore the same relative precision as Fit, rather than leaving the
  // constructor's 0.1 plane behind when a large saved assembly reopens.
  const padding = Math.max(halfDepth * 0.1, Math.abs(centerDepth) * 0.1, 1e-6);
  const near =
    camera instanceof THREE.PerspectiveCamera
      ? Math.max(
          // A bounding-box corner behind the camera is not nearby visible
          // geometry. Falling back to 1e-6 there destroys depth ordering even
          // between separated opaque faces. Use the same relative floor as
          // Fit while allowing genuinely microscopic focus distances.
          Math.max(1e-6, focusDistance / 1000),
          Math.min(closest - padding, Math.abs(centerDepth) / 1000)
        )
      : closest - padding;
  // Keep the receding grid/axes outside the model's bounds visible as well,
  // matching Fit's generous far margin and its existing face-depth policy.
  const maxDimension = Math.max(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z
  );
  const far = Math.max(
    near + 1e-6,
    furthest + padding,
    Math.abs(centerDepth) * 12 + maxDimension * 4
  );
  if (camera.near !== near || camera.far !== far) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}
