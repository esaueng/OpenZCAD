import type * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

/**
 * The "solid frame" look shared by committed datum planes and axes: a heavy
 * steel frame and line, a name chip beside each, and the selection hue when
 * selected. The idle colour is the theme's `--color-datum` (read by the
 * viewer, see lib/stagePalette); this is its dark-theme value and the
 * fallback until it is read.
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

/**
 * The datum's name, boxed beside it. Styled by `.viewport-datum-label` in
 * viewport-overlays.css; the label layer passes pointer events through, so
 * the chip never takes a click meant for the model.
 */
export function buildDatumLabel(name: string, selected: boolean): CSS2DObject {
  const element = document.createElement('div');
  element.className = 'viewport-datum-label';
  element.textContent = name;
  if (selected) element.dataset.selected = 'true';
  const label = new CSS2DObject(element);
  label.raycast = () => undefined;
  return label;
}

/** Removes every label element under `root` from the label layer. */
export function removeDatumLabels(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (node instanceof CSS2DObject) node.element.remove();
  });
}
