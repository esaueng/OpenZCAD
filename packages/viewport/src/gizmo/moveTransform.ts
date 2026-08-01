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
