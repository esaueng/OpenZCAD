/**
 * Radial layout for the viewport's action menu.
 *
 * A marking menu is worth having because direction is easier to remember
 * than position in a list: after a few uses the hand learns "up-left is
 * fillet" and stops reading. That only holds while the ring is small — eight
 * directions is about the limit before the sectors stop being distinct
 * enough to flick at blind. The viewport's menu can carry more actions than
 * that, so anything past the ring goes to a plain list underneath rather
 * than being crammed into a sector nobody could aim for.
 */

/** Directions a hand can aim at without looking. */
export const RADIAL_SLOTS = 8;

/**
 * Pixels the pointer must travel before a direction is taken as meant.
 *
 * The menu opens under the pointer, so without this the tiny drift between
 * pressing and releasing would pick whichever sector the hand happened to
 * wobble toward.
 */
export const MARKING_DEAD_ZONE_PX = 18;

export interface RadialSplit<T> {
  /** Items placed around the ring, in clockwise order from the top. */
  radial: T[];
  /** Items that did not fit, listed rather than crammed into a sector. */
  overflow: T[];
}

/**
 * Splits actions between the ring and the list.
 *
 * One item alone in the overflow is the worst of both — a list holding a
 * single row, and a ring that gave up a slot for nothing — so a set that
 * only just overflows keeps a sector free and sends two items down instead.
 */
export function splitRadial<T>(items: T[]): RadialSplit<T> {
  if (items.length <= RADIAL_SLOTS) {
    return { radial: items, overflow: [] };
  }
  return {
    radial: items.slice(0, RADIAL_SLOTS - 1),
    overflow: items.slice(RADIAL_SLOTS - 1)
  };
}

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
