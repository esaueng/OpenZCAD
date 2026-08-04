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
 * Degrees around the horizontal that the ring keeps empty on each side.
 *
 * The hub pill grows sideways with its label, so the ring's equator is the
 * one place a slot can always be collided with. Excluding a band around it
 * gathers the slots into a crown above and a cradle below the pill — the
 * ring reads as two symmetric arcs — while every slot keeps a direction
 * close to its evenly-spaced one.
 */
export const HORIZONTAL_EXCLUSION_DEG = 30;

/**
 * A sector's home direction in degrees clockwise from straight up, with the
 * horizontal band squeezed out.
 *
 * Each quadrant compresses linearly toward its pole, so ordering is kept
 * and no two sectors collapse together. The two dead-horizontal sectors of
 * an even ring both resolve upward, framing the pill symmetrically rather
 * than one hanging on each side.
 */
export function clusteredAngle(
  index: number,
  count: number,
  exclusionDeg = HORIZONTAL_EXCLUSION_DEG
): number {
  const angle = (index / Math.max(count, 1)) * 360;
  const squeeze = (90 - exclusionDeg) / 90;
  if (angle <= 90) {
    return angle * squeeze;
  }
  if (angle <= 180) {
    return 180 - (180 - angle) * squeeze;
  }
  if (angle < 270) {
    return 180 + (angle - 180) * squeeze;
  }
  return 360 - (360 - angle) * squeeze;
}

/**
 * Where a sector's label sits, in pixels from the menu's centre.
 *
 * Index 0 is straight up and the ring runs clockwise. Positions follow the
 * clustered angles, so the label sits exactly where the aim for that
 * sector points.
 */
export function sectorPosition(
  index: number,
  count: number,
  radius: number
): { x: number; y: number } {
  const angle = ((clusteredAngle(index, count) - 90) * Math.PI) / 180;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/**
 * Moves a slot out of the hub pill's horizontal band.
 *
 * The pill grows sideways with its label, so a slot sharing its horizontal
 * line is always one long name away from being collided with or crowded.
 * Rather than racing the pill outward, any slot whose disc would enter the
 * band (`halfHeight` already includes the slot's radius and a margin) keeps
 * its x and settles just above or below the band, on whichever side it was
 * already leaning. Slots dead on the horizontal all go above, so the pair
 * of them frames the pill symmetrically instead of one dangling on each
 * side. The flick never reads these positions; it commits by direction
 * alone, so the sector under a practised gesture is unchanged.
 */
export function slotPositionClearOfHub(
  at: { x: number; y: number },
  halfHeight: number
): { x: number; y: number } {
  if (Math.abs(at.y) >= halfHeight) {
    return at;
  }
  // sectorPosition's sin() leaves ±1e-16 noise on horizontal slots; treat
  // anything sub-pixel as "no lean" so mirrored slots resolve identically.
  const lean = Math.abs(at.y) < 1 ? 0 : Math.sign(at.y);
  return { x: at.x, y: (lean !== 0 ? lean : -1) * halfHeight };
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
  // Rotate so straight up is 0 and the ring runs clockwise, then land on
  // the nearest sector's clustered direction — the same angles the slots
  // are drawn at, or the menu would show one thing and pick another. An
  // aim equidistant between two sectors resolves to the earlier one;
  // picking neither would read as a dead spot in the ring.
  const degrees =
    ((((Math.atan2(dy, dx) * 180) / Math.PI + 90) % 360) + 360) % 360;
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < count; index += 1) {
    const offset = Math.abs(degrees - clusteredAngle(index, count));
    const distance = Math.min(offset, 360 - offset);
    if (distance < bestDistance - 1e-9) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
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
    extent < reach * 2
      ? extent / 2
      : Math.min(Math.max(value, reach), extent - reach);
  return { x: clamp(x, viewportWidth), y: clamp(y, viewportHeight) };
}
