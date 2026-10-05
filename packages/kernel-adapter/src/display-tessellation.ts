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

/**
 * How far a body's nominal deflection may drift from the one its last display
 * mesh used before the mesh is re-derived at the new value.
 *
 * The nominal value follows the body's bounding box, so every edit that
 * changes the extent — a face pushed out, a hole widened — changes it a
 * little, and a mesh at a different deflection is a different mesh: the
 * kernel's per-face mesh reuse misses on every face, and the whole body is
 * re-tessellated for an edit that moved a dozen faces. Holding the previous
 * deflection while the nominal stays within this band keeps the mesh reusable
 * across an editing session at a chord error that stays within 25 % of the
 * 0.02 % target (still well under a pixel at the regression zoom), and
 * re-anchors as soon as the body has really changed size.
 */
export const DISPLAY_DEFLECTION_HOLD_RATIO = 1.25;

/**
 * The display tessellation to use for a body whose last display mesh used
 * `heldLinearDeflection`: the held value while the nominal stays within
 * {@link DISPLAY_DEFLECTION_HOLD_RATIO} of it, the nominal otherwise.
 */
export function heldDisplayTessellation(
  nominal: DisplayTessellation,
  heldLinearDeflection: number | undefined
): DisplayTessellation {
  if (
    heldLinearDeflection === undefined ||
    !Number.isFinite(heldLinearDeflection) ||
    heldLinearDeflection <= 0
  ) {
    return nominal;
  }
  const ratio = nominal.linearDeflection / heldLinearDeflection;
  if (
    ratio > DISPLAY_DEFLECTION_HOLD_RATIO ||
    ratio < 1 / DISPLAY_DEFLECTION_HOLD_RATIO
  ) {
    return nominal;
  }
  return { ...nominal, linearDeflection: heldLinearDeflection };
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
