export interface ViewportScale {
  /** Distance represented by the bar, in the document's current units. */
  value: number;
  /** Screen width of that distance at the camera target plane. */
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
