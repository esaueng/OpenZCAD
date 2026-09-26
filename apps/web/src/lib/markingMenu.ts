/**
 * Radial layout for the viewport's action menu.
 *
 * A marking menu is worth having because direction is easier to remember
 * than position in a list: after a few uses the hand learns "up is fillet"
 * and stops reading. The actions are labelled pills around the click point,
 * one per sector, so the name is read where the hand is headed rather than
 * looked up somewhere else. Within the dead zone around the click point
 * nothing is chosen; past it, the aim's sector is what a release takes.
 *
 * Sectors are evenly spaced, index 0 straight up and running clockwise.
 * Callers should keep a selection's set to roughly eight: the layout holds
 * past that, but direction stops being memorable.
 */

/**
 * Pixels the pointer must travel before a direction is taken as meant.
 *
 * The menu opens under the pointer, so without this the tiny drift between
 * pressing and releasing would pick whichever sector the hand happened to
 * wobble toward.
 */
export const MARKING_DEAD_ZONE_PX = 40;

/**
 * How much wider than tall a ring with diagonal pills is.
 *
 * Pills are wide and short, so a round ring crowds them vertically at the
 * diagonals while leaving the sides empty. Stretching the anchors sideways
 * gives the diagonal pills a row of their own; the flick still commits by
 * angle alone, so the stretch never changes what a gesture picks. A ring of
 * four or fewer has no diagonals and stays round, so its side pills sit as
 * close to the centre as the top and bottom ones.
 */
export const RING_ASPECT = 1.3;

/** The sideways stretch a ring of `count` pills is laid out with. */
export function ringAspect(count: number): number {
  return count > 4 ? RING_ASPECT : 1;
}

/** A sector's direction in degrees clockwise from straight up. */
export function sectorAngle(index: number, count: number): number {
  return (index / Math.max(count, 1)) * 360;
}

/**
 * Where a sector's pill is anchored, in pixels from the menu's centre, and
 * which edge of the pill sits on that anchor.
 *
 * Pills near the vertical are centred on their anchor. Every other pill
 * hangs outward from it — left edge on the anchor to the right of centre,
 * right edge to the left — so the space between the anchor and the centre
 * stays clear whatever the label's length, and neighbouring pills never
 * grow toward each other.
 */
export function sectorAnchor(
  index: number,
  count: number,
  radius: number
): { x: number; y: number; align: 'center' | 'start' | 'end' } {
  const angle = (sectorAngle(index, count) * Math.PI) / 180;
  const sin = Math.sin(angle);
  const x = sin * radius * ringAspect(count);
  const y = -Math.cos(angle) * radius;
  // sin() leaves ±1e-16 noise on the vertical; anything sub-pixel is
  // "straight up or down" so mirrored rings lay out identically.
  const align = Math.abs(sin) < 0.35 ? 'center' : sin > 0 ? 'start' : 'end';
  return { x: Math.abs(x) < 1 ? 0 : x, y: Math.abs(y) < 1 ? 0 : y, align };
}

/**
 * The sector a drag is aiming at, or null while it is still in the dead zone.
 *
 * `dx`/`dy` are in screen pixels, so `dy` grows downward. An aim exactly on
 * a boundary resolves to the earlier sector; picking neither would read as
 * a dead spot in the ring.
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
  // the nearest sector's direction.
  const degrees =
    ((((Math.atan2(dy, dx) * 180) / Math.PI + 90) % 360) + 360) % 360;
  const step = 360 / count;
  return Math.floor((degrees + step / 2 - 1e-9) / step) % count;
}

/** How far the menu extends from its centre on each side, in pixels. */
export interface MenuExtents {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Nudges the menu's centre so the whole ring stays on screen.
 *
 * A sector that falls off the edge is worse than a menu that opens slightly
 * away from the pointer: the direction it stands for still exists, so the
 * flick would land on something the user cannot see. A single `reach`
 * keeps that much clear on every side; extents keep a different amount on
 * each, which is what a ring of pills hanging outward needs.
 */
export function clampMenuOrigin(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  reach: number | MenuExtents
): { x: number; y: number } {
  const extents =
    typeof reach === 'number'
      ? { left: reach, right: reach, top: reach, bottom: reach }
      : reach;
  const clamp = (value: number, extent: number, before: number, after: number) =>
    extent < before + after
      ? extent / 2
      : Math.min(Math.max(value, before), extent - after);
  return {
    x: clamp(x, viewportWidth, extents.left, extents.right),
    y: clamp(y, viewportHeight, extents.top, extents.bottom)
  };
}
