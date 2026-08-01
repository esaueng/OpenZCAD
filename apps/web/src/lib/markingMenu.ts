/**
 * Radial layout for the viewport's action menu.
 *
 * A marking menu is worth having because direction is easier to remember
 * than position in a list: after a few uses the hand learns "up-left is
 * fillet" and stops reading. Holding that up asks the ring to read as one
 * instrument rather than a scatter of boxes, so the slots carry icons only
 * and the hub in the middle names whatever is being aimed at.
 *
 * That readout is also why every action can stay on the ring. Aiming one
 * slot wide used to be silent; now the hub says which action a release would
 * run, so an overshoot is caught before the button comes up and a list
 * hanging off the ring for the leftovers buys nothing. The ring is still
 * only as legible as it is small — callers should keep a selection's set to
 * roughly eight, not because the layout breaks past that but because
 * direction stops being memorable.
 */

/**
 * Pixels the pointer must travel before a direction is taken as meant.
 *
 * The menu opens under the pointer, so without this the tiny drift between
 * pressing and releasing would pick whichever sector the hand happened to
 * wobble toward. The hub is drawn at exactly this radius, which is what
 * makes the rule visible: while the pointer is still on the readout, nothing
 * is chosen.
 */
export const MARKING_DEAD_ZONE_PX = 40;

/**
 * Where a sector's label sits, in pixels from the menu's centre.
 *
 * Index 0 is straight up and the ring runs clockwise, matching how the
 * sectors are aimed at.
 */
export function sectorPosition(
  index: number,
  count: number,
  radius: number
): { x: number; y: number } {
  const angle = (index / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/**
 * The sector a drag is aiming at, or null while it is still in the dead zone.
 *
 * `dx`/`dy` are in screen pixels, so `dy` grows downward.
 */
export function sectorForVector(
  dx: number,
  dy: number,
  count: number,
  deadZonePx = MARKING_DEAD_ZONE_PX
): number | null {
  if (count <= 0 || Math.hypot(dx, dy) < deadZonePx) {
    return null;
  }
  // Rotate so straight up is 0 and the ring runs clockwise, then land on the
  // nearest sector centre rather than a boundary — aiming between two
  // choices should resolve to one, not to neither.
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  const step = 360 / count;
  const normalized = ((degrees % 360) + 360) % 360;
  return Math.round(normalized / step) % count;
}

/**
 * Nudges the menu's centre so the whole ring stays on screen.
 *
 * A sector that falls off the edge is worse than a menu that opens slightly
 * away from the pointer: the direction it stands for still exists, so the
 * flick would land on something the user cannot see. `reach` should cover
 * the ring plus the widest label it carries.
 */
export function clampMenuOrigin(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  reach: number
): { x: number; y: number } {
  const clamp = (value: number, extent: number) =>
    extent < reach * 2 ? extent / 2 : Math.min(Math.max(value, reach), extent - reach);
  return { x: clamp(x, viewportWidth), y: clamp(y, viewportHeight) };
}
