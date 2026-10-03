import * as THREE from 'three';
import { SELECTION_SEMANTICS } from './semantics';

/**
 * The colours a selection is drawn in, worked out from the body's own colour.
 *
 * The rule (design review F8, option a): a selected face keeps its feature
 * colour, leans a little toward a light accent and gains the bright rim; the
 * rest of its body, and every other body, gives up some brightness while
 * anything is selected. Both are plain colour writes on materials that
 * already exist, so a selection change never recompiles a shader.
 *
 * The arithmetic is done on display (sRGB) values, which is what "30% dimmer"
 * and "a light tint" mean to the eye; three converts back to its linear
 * working space when the result is assigned.
 */

const SRGB = THREE.SRGBColorSpace;
const scratch = new THREE.Color();
const tint = new THREE.Color();

/** A selected face's fill: its own colour, lifted toward the light accent. */
export function selectedFaceColor(
  base: THREE.ColorRepresentation,
  target = new THREE.Color()
): THREE.Color {
  const { faceTint, faceTintAmount } = SELECTION_SEMANTICS.selected;
  scratch.set(base);
  tint.setHex(faceTint);
  const from = scratch.getRGB({ r: 0, g: 0, b: 0 }, SRGB);
  const to = tint.getRGB({ r: 0, g: 0, b: 0 }, SRGB);
  return target.setRGB(
    from.r + (to.r - from.r) * faceTintAmount,
    from.g + (to.g - from.g) * faceTintAmount,
    from.b + (to.b - from.b) * faceTintAmount,
    SRGB
  );
}

/**
 * A body's colour while it is context for a selection rather than the
 * selection itself; `emphasized` gives the body back its own colour.
 */
export function contextBodyColor(
  base: THREE.ColorRepresentation,
  emphasized: boolean,
  target = new THREE.Color()
): THREE.Color {
  target.set(base);
  if (emphasized) {
    return target;
  }
  const keep = 1 - SELECTION_SEMANTICS.selected.contextDim;
  const { r, g, b } = target.getRGB({ r: 0, g: 0, b: 0 }, SRGB);
  return target.setRGB(r * keep, g * keep, b * keep, SRGB);
}
