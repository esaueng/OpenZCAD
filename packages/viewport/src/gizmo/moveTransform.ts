interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Applies the kernel's X-then-Y-then-Z rotation without loading Three.js. */
function rotateZyx(point: Vec3, rotationDeg: Vec3): Vec3 {
  const x = (rotationDeg.x * Math.PI) / 180;
  const y = (rotationDeg.y * Math.PI) / 180;
  const z = (rotationDeg.z * Math.PI) / 180;
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cz = Math.cos(z);
  const sz = Math.sin(z);

  return {
    x:
      cy * cz * point.x +
      (sx * sy * cz - cx * sz) * point.y +
      (cx * sy * cz + sx * sz) * point.z,
    y:
      cy * sz * point.x +
      (sx * sy * sz + cx * cz) * point.y +
      (cx * sy * sz - sx * cz) * point.z,
    z: -sy * point.x + sx * cy * point.y + cx * cy * point.z
  };
}

/** Folds a body-center rotation into the Move feature's translation. */
export function composeMoveTransform(
  center: Vec3,
  translation: Vec3,
  rotationDeg: Vec3
): Vec3 {
  const rotated = rotateZyx(center, rotationDeg);
  return {
    x: translation.x + center.x - rotated.x,
    y: translation.y + center.y - rotated.y,
    z: translation.z + center.z - rotated.z
  };
}

/**
 * Where a label anchored at `resting` in world space ends up under the move
 * `composeMoveTransform` produced, so an overlay that is not parented to the
 * body still tracks it.
 *
 * The body mesh rotates about its own origin and then translates by `final`,
 * so an anchor has to take both steps. Skipping the rotation still moves the
 * label — `final` already carries the centre compensation — which is why this
 * lives here with exact expectations rather than being asserted through screen
 * pixels, where "it moved" passes either way.
 */
export function moveCalloutAnchor(
  resting: Vec3,
  rotationDeg: Vec3,
  final: Vec3
): Vec3 {
  const rotated = rotateZyx(resting, rotationDeg);
  return {
    x: rotated.x + final.x,
    y: rotated.y + final.y,
    z: rotated.z + final.z
  };
}
