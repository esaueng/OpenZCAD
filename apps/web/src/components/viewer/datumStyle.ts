/**
 * The "solid frame" look shared by committed datum planes and axes: a heavy
 * steel frame and line, and the selection hue when selected. No name chip:
 * text pinned to the model clutters the viewport, and the History panel
 * already names each datum. The idle colour is the theme's `--color-datum`
 * (read by the viewer, see lib/stagePalette); this is its dark-theme value
 * and the fallback until it is read.
 */
export const DATUM_IDLE_COLOR = '#b3bed0';
/** Matches `--color-select`, which neither theme overrides. */
export const DATUM_SELECTED_COLOR = '#6798ff';

/**
 * The part of a datum behind the model, drawn without a depth test: a thin
 * dashed continuation, so a plane or axis passing through the part still
 * reads as one object instead of a fragment.
 */
export const DATUM_HIDDEN_WIDTH_PX = 1.5;
export const DATUM_HIDDEN_DASHED = {
  dashed: true,
  dashSize: 0.04,
  gapSize: 0.03
};
