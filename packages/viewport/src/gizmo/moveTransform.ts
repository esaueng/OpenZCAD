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

/** The transpose (inverse) of `rotateZyx`: each axis's image dotted with `v`. */
function unrotateZyx(v: Vec3, rotationDeg: Vec3): Vec3 {
  const dot = (axis: Vec3) => {
    const image = rotateZyx(axis, rotationDeg);
    return image.x * v.x + image.y * v.y + image.z * v.z;
  };
  return {
    x: dot({ x: 1, y: 0, z: 0 }),
    y: dot({ x: 0, y: 1, z: 0 }),
    z: dot({ x: 0, y: 0, z: 1 })
  };
}

/**
 * M10: the translation that keeps a moved body where it is when its pivot
 * moves from `pivot` to `next`. The Move places a point x at
 * R(x − p) + p + t, so the same place under p′ needs t′ = t + (R − I)(p′ − p).
 * With no rotation the translation is unchanged: a pivot only matters to a
 * turn.
 */
export function relocateMovePivot(
  pivot: Vec3,
  translation: Vec3,
  rotationDeg: Vec3,
  next: Vec3
): Vec3 {
  const d = { x: next.x - pivot.x, y: next.y - pivot.y, z: next.z - pivot.z };
  const turned = rotateZyx(d, rotationDeg);
  return {
    x: translation.x + turned.x - d.x,
    y: translation.y + turned.y - d.y,
    z: translation.z + turned.z - d.z
  };
}

/**
 * M10: a pivot-handle drag carried the gizmo by `delta` (it stands at
 * p + t). Splits that into the pivot's own move d = Rᵀ·delta and the
 * translation t + delta − d that leaves the body still, so the gizmo lands
 * where it was dragged and the body does not follow.
 */
export function pivotDragStep(
  translation: Vec3,
  rotationDeg: Vec3,
  delta: Vec3
): { pivotDelta: Vec3; translation: Vec3 } {
  const pivotDelta = unrotateZyx(delta, rotationDeg);
  return {
    pivotDelta,
    translation: {
      x: translation.x + delta.x - pivotDelta.x,
      y: translation.y + delta.y - pivotDelta.y,
      z: translation.z + delta.z - pivotDelta.z
    }
  };
}

/**
 * M10: the translation that keeps a Move's placement when its turn and
 * pivot are replaced by stored (rounded) values. The preview places a point
 * x at R·x + c, with c = t + p − R·p; under the stored R′ and p′ the same c
 * needs t′ = c − p′ + R′·p′. Only the turn's own rounding is left, which
 * moves a point by its distance from the stored pivot times that angle.
 */
export function translationForRoundedMove(
  pivot: Vec3,
  translation: Vec3,
  rotationDeg: Vec3,
  storedPivot: Vec3,
  storedRotationDeg: Vec3
): Vec3 {
  const placed = composeMoveTransform(pivot, translation, rotationDeg);
  const stored = composeMoveTransform(
    storedPivot,
    { x: 0, y: 0, z: 0 },
    storedRotationDeg
  );
  return {
    x: placed.x - stored.x,
    y: placed.y - stored.y,
    z: placed.z - stored.z
  };
}
