import type * as THREE from 'three';
import { orbitPivotForPoint } from './views';

export interface ViewportScale {
  /** Distance represented by the bar, in the document's current units. */
  value: number;
  /** Screen width of that distance at the measured depth. */
  widthPx: number;
}

export const DEFAULT_SCALE_BAR_MAX_WIDTH_PX = 200;

/**
 * Chooses a conventional 1/2/5 x 10^n scale that never exceeds the requested
 * screen width. Adjacent steps differ by at most 2.5x, so a 200px ceiling
 * keeps the default bar at least 80px wide.
 */
export function chooseViewportScale(
  worldUnitsPerPixel: number,
  maxWidthPx = DEFAULT_SCALE_BAR_MAX_WIDTH_PX
): ViewportScale | null {
  if (
    !Number.isFinite(worldUnitsPerPixel) ||
    worldUnitsPerPixel <= 0 ||
    !Number.isFinite(maxWidthPx) ||
    maxWidthPx <= 0
  ) {
    return null;
  }

  const maximumWorldSpan = worldUnitsPerPixel * maxWidthPx;
  if (!Number.isFinite(maximumWorldSpan) || maximumWorldSpan <= 0) {
    return null;
  }

  const exponent = Math.floor(Math.log10(maximumWorldSpan));
  const magnitude = 10 ** exponent;
  const normalized = maximumWorldSpan / magnitude;
  const multiple = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  const value = multiple * magnitude;
  const widthPx = value / worldUnitsPerPixel;

  if (!Number.isFinite(value) || !Number.isFinite(widthPx)) {
    return null;
  }
  return { value, widthPx };
}

/**
 * Where the scale bar measures: on the view axis, at the depth of the
 * model's bounds centre. Measuring at the orbit pivot made the bar jump on
 * a click — a pick moves the pivot to the picked point's depth while the
 * camera stays still, so "50 mm" turned into "20 mm" with nothing on screen
 * moving. The model centre's depth only changes when the camera or the
 * model does. Without a model, or with its centre behind the camera, the
 * orbit pivot is the fallback.
 */
export function scaleBarAnchor(
  cameraPosition: THREE.Vector3,
  viewDirection: THREE.Vector3,
  modelCenter: THREE.Vector3 | null,
  orbitTarget: THREE.Vector3
): THREE.Vector3 {
  return (
    (modelCenter &&
      orbitPivotForPoint(cameraPosition, viewDirection, modelCenter)) ??
    orbitTarget
  );
}

/** Formats a nice scale value without adding noisy floating-point digits. */
export function formatViewportScale(value: number, units: string): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }

  const absolute = Math.abs(value);
  const unitLabel = units === 'inch' ? 'in' : units;
  let formatted: string;
  if (absolute >= 1_000_000 || absolute < 0.0001) {
    formatted = value.toExponential(0).replace('e+', 'e');
  } else {
    const exponent = Math.floor(Math.log10(absolute));
    const fractionDigits = Math.min(6, Math.max(0, -exponent));
    formatted = value.toFixed(fractionDigits);
  }
  return `${formatted} ${unitLabel}`;
}
