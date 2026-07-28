/**
 * Viewport tessellation is a disposable projection of exact geometry. Keep its
 * chord error relative to each solid rather than using one world-unit value:
 * the same cylinder then has the same silhouette quality in mm, inches, or a
 * large assembly.
 *
 * At the close-zoom regression scale (a 1,200 px projected radius), the 0.02%
 * size-relative chord target stays below half a pixel. The angular limit also
 * prevents broad facets on low-curvature surfaces where chordal deflection
 * alone would allow long triangles.
 */
export const DISPLAY_LINEAR_DEFLECTION_RATIO = 2e-4;
export const DISPLAY_MIN_LINEAR_DEFLECTION = 1e-5;
export const DISPLAY_ANGULAR_DEFLECTION = 0.06;

export interface DisplayTessellation {
  linearDeflection: number;
  angularDeflection: number;
}

export function displayTessellationForExtents(
  x: number,
  y: number,
  z: number
): DisplayTessellation {
  const finiteExtents = [x, y, z]
    .filter(Number.isFinite)
    .map((extent) => Math.abs(extent));
  const scale = Math.max(...finiteExtents, 0);
  return {
    linearDeflection: Math.max(
      DISPLAY_MIN_LINEAR_DEFLECTION,
      scale * DISPLAY_LINEAR_DEFLECTION_RATIO
    ),
    angularDeflection: DISPLAY_ANGULAR_DEFLECTION
  };
}
