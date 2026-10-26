import type { ExportScope } from './exportScope';

/**
 * Image export rules shared by the dialog and the viewer, kept free of
 * three.js so the dialog's chunk does not pull the renderer in.
 */

/** The larger side an image export may ask for, before the GPU's own limit. */
export const IMAGE_EXPORT_MAX_SIDE = 8192;
/** About 40 MP: the readback alone is four bytes a pixel. */
export const IMAGE_EXPORT_MAX_PIXELS = 40_000_000;
/**
 * The desktop shell refuses saves over 50 MiB. A PNG never exceeds its raw
 * RGBA size by more than a few hundred bytes a row, so 12 MP (48 MB raw)
 * always fits; 4K is 8.3 MP.
 */
export const DESKTOP_IMAGE_MAX_PIXELS = 12_000_000;
/** Smaller than this is an icon, not an export. */
export const IMAGE_EXPORT_MIN_SIDE = 16;

/** Why a requested size cannot be rendered, or null when it can. */
export function imageSizeProblem(
  width: number,
  height: number,
  maxSide: number = IMAGE_EXPORT_MAX_SIDE,
  maxPixels: number = IMAGE_EXPORT_MAX_PIXELS
): string | null {
  const side = Math.min(maxSide, IMAGE_EXPORT_MAX_SIDE);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < IMAGE_EXPORT_MIN_SIDE ||
    height < IMAGE_EXPORT_MIN_SIDE ||
    width > side ||
    height > side
  ) {
    return `Enter whole pixel sizes from ${IMAGE_EXPORT_MIN_SIDE} to ${side}.`;
  }
  const pixels = Math.min(maxPixels, IMAGE_EXPORT_MAX_PIXELS);
  if (width * height > pixels) {
    return `${width} × ${height} is over ${pixels / 1_000_000} megapixels; choose a smaller size.`;
  }
  return null;
}

/**
 * What a view image draws under the export scope rules. A selected body
 * draws alone, as it exports alone. Otherwise the image is the view, and the
 * view never draws a body hidden in it, so those are always left out — and
 * counted, as the mesh export counts them.
 */
export function viewImageScope(
  scope: ExportScope | null,
  selectedName: string | null
): { bodyIds?: string[]; label: string } {
  if (scope?.selection) {
    return {
      // A body whose history step failed is withheld from mesh files but
      // still drawn in the view, so the picture keeps it.
      bodyIds: [...scope.bodyIds, ...scope.withheldIds],
      label: selectedName ?? 'the selected body'
    };
  }
  if (!scope) return { label: 'the current view' };
  const hidden = scope.hiddenExcluded;
  // Bodies whose history step failed are withheld from mesh files, but the
  // view still draws the visible ones, so the picture counts them.
  const visible = scope.bodyIds.length + scope.withheldIds.length;
  if (visible === 0 && hidden === 0) return { label: 'the current view' };
  return {
    label:
      hidden > 0
        ? `visible bodies (${visible}, ${hidden} hidden left out)`
        : `visible bodies (${visible})`
  };
}

/**
 * The sketch an SVG export starts on: the one being edited, else the one
 * selected in History, else the sketch of a picked profile. Null leaves the
 * dialog on the first sketch, where the choice is visible.
 */
export function initialImageSketchId(context: {
  editing: string | null;
  selected: string | null;
  profiles: readonly string[];
}): string | null {
  return context.editing ?? context.selected ?? context.profiles[0] ?? null;
}
