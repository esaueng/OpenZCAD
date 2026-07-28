import * as THREE from 'three';

export interface DimensionLabelLayout {
  angleDeg: number;
  scale: number;
  lineLengthPx: number;
}

/**
 * Keeps a dimension label aligned to its projected line without 180-degree
 * flips. Model-relative scaling is intentionally bounded at 1 so labels can
 * shrink with the view but never grow beyond their base UI font size.
 */
export function dimensionLabelLayout(
  start: { x: number; y: number },
  end: { x: number; y: number },
  modelSizePx: number,
  previousAngleDeg?: number
): DimensionLabelLayout {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lineLengthPx = Math.hypot(deltaX, deltaY);
  let angleDeg = THREE.MathUtils.radToDeg(Math.atan2(deltaY, deltaX));

  if (Number.isFinite(previousAngleDeg)) {
    angleDeg += 180 * Math.round((previousAngleDeg! - angleDeg) / 180);
  } else {
    if (angleDeg > 90) {
      angleDeg -= 180;
    } else if (angleDeg < -90) {
      angleDeg += 180;
    }
  }

  // A dimension axis aimed nearly at the camera has no reliable screen
  // angle. Hold the previous orientation instead of allowing it to jitter.
  if (lineLengthPx < 6 && Number.isFinite(previousAngleDeg)) {
    angleDeg = previousAngleDeg!;
  }

  const scale = THREE.MathUtils.clamp(
    Math.sqrt(Math.max(modelSizePx, 1) / 520),
    0.72,
    1
  );
  return { angleDeg, scale, lineLengthPx };
}
