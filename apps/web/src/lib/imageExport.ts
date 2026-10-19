import type { ExportScope } from './exportScope';

/**
 * Image export rules shared by the dialog and the viewer, kept free of
 * three.js so the dialog's chunk does not pull the renderer in.
 */

/** The larger side an image export may ask for, before the GPU's own limit. */
export const IMAGE_EXPORT_MAX_SIDE = 8192;
/** About 40 MP: the readback alone is four bytes a pixel. */
export const IMAGE_EXPORT_MAX_PIXELS = 40_000_000;
/** Smaller than this is an icon, not an export. */
export const IMAGE_EXPORT_MIN_SIDE = 16;

/** Why a requested size cannot be rendered, or null when it can. */
export function imageSizeProblem(
  width: number,
  height: number,
  maxSide: number = IMAGE_EXPORT_MAX_SIDE
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
  if (width * height > IMAGE_EXPORT_MAX_PIXELS) {
    return `${width} × ${height} is over ${IMAGE_EXPORT_MAX_PIXELS / 1_000_000} megapixels; choose a smaller size.`;
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
      bodyIds: scope.bodyIds,
      label: selectedName ?? 'the selected body'
    };
  }
  if (!scope) return { label: 'the current view' };
  const hidden = scope.hiddenIncluded + scope.hiddenExcluded;
  const visible = scope.bodyIds.length - scope.hiddenIncluded;
  if (visible === 0 && hidden === 0) return { label: 'the current view' };
  return {
    label:
      hidden > 0
        ? `visible bodies (${visible}, ${hidden} hidden left out)`
        : `visible bodies (${visible})`
  };
}
