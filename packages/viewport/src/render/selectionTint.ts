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
  return recededBodyColor(base, emphasized ? 0 : 1, target);
}

/**
 * A body's colour part of the way into the recede: `level` 0 is its own
 * colour, 1 the full context dim of {@link contextBodyColor}. In between is
 * what the recede shows while it eases on or off, so the whole scene never
 * changes brightness in one frame.
 */
export function recededBodyColor(
  base: THREE.ColorRepresentation,
  level: number,
  target = new THREE.Color()
): THREE.Color {
  target.set(base);
  const amount = Math.min(Math.max(level, 0), 1);
  if (amount === 0) {
    return target;
  }
  const keep = 1 - SELECTION_SEMANTICS.selected.contextDim * amount;
  const { r, g, b } = target.getRGB({ r: 0, g: 0, b: 0 }, SRGB);
  return target.setRGB(r * keep, g * keep, b * keep, SRGB);
}

/**
 * The recede level a drawn colour shows for a body of colour `base`: the
 * inverse of {@link recededBodyColor}. Null when `color` is not that body's
 * colour at any level (another body's colour, a preview tint), so a check on
 * what the renderer draws can tell a wrong write from an unfinished ease.
 */
export function recedeLevelOf(
  base: THREE.ColorRepresentation,
  color: THREE.Color,
  tolerance = 1e-3
): number | null {
  const from = new THREE.Color(base).getRGB({ r: 0, g: 0, b: 0 }, SRGB);
  const drawn = color.getRGB({ r: 0, g: 0, b: 0 }, SRGB);
  const channels = (['r', 'g', 'b'] as const).filter(
    (channel) => from[channel] > tolerance
  );
  if (channels.length === 0) return null;
  const keeps = channels.map((channel) => drawn[channel] / from[channel]);
  const keep = keeps.reduce((sum, value) => sum + value, 0) / keeps.length;
  if (keeps.some((value) => Math.abs(value - keep) > tolerance)) return null;
  // A dark channel the ratio skipped must still be (near) dark.
  for (const channel of ['r', 'g', 'b'] as const) {
    if (
      !channels.includes(channel) &&
      Math.abs(drawn[channel] - from[channel] * keep) > tolerance
    )
      return null;
  }
  const level = (1 - keep) / SELECTION_SEMANTICS.selected.contextDim;
  if (level < -tolerance || level > 1 + tolerance) return null;
  return Math.min(Math.max(level, 0), 1);
}
