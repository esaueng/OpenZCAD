/**
 * Keeps an in-place command's value chips apart on screen.
 *
 * Each chip stands over its own handle in the model, and several handles can
 * project onto nearly one point: a hole's diameter chip sits on the bore's
 * rim and its countersink chip on the step's, 3 mm apart on a face seen
 * small, so "Countersink ⌀ 12 mm" covered "⌀ 6" and neither Fit nor any
 * zoom the face allowed pulled them apart (F005, production QA 29 Oct
 * 2026). Placement here is per frame from the projected positions, so a
 * chip never drifts: the first chip keeps its place, and each later one
 * moves the least distance that clears every chip before it, staying in
 * the stage. The caller draws a leader from a moved chip to its handle.
 */

/** A chip's box, by its centre, in CSS pixels. */
export interface ChipBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChipBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ChipOffset {
  dx: number;
  dy: number;
}

/** The clear space kept between two chips. */
export const COMMAND_CHIP_GAP_PX = 4;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const EPSILON = 0.01;

function rectOf(x: number, y: number, width: number, height: number): Rect {
  return {
    left: x - width / 2,
    top: y - height / 2,
    right: x + width / 2,
    bottom: y + height / 2
  };
}

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.left < b.right + gap - EPSILON &&
    b.left < a.right + gap - EPSILON &&
    a.top < b.bottom + gap - EPSILON &&
    b.top < a.bottom + gap - EPSILON
  );
}

function inside(rect: Rect, bounds: ChipBounds): boolean {
  return (
    rect.left >= bounds.left - EPSILON &&
    rect.right <= bounds.right + EPSILON &&
    rect.top >= bounds.top - EPSILON &&
    rect.bottom <= bounds.bottom + EPSILON
  );
}

/**
 * How far each chip moves, by id, to clear the chips placed before it (in
 * the order given). A chip that overlaps nothing stays; one that no move
 * beside an earlier chip clears inside `bounds` stays too, rather than
 * leaving the stage.
 */
export function separateChips(
  chips: readonly ChipBox[],
  bounds: ChipBounds,
  gap = COMMAND_CHIP_GAP_PX
): Map<string, ChipOffset> {
  const offsets = new Map<string, ChipOffset>();
  const placed: Rect[] = [];
  for (const chip of chips) {
    const { width, height } = chip;
    const home = rectOf(chip.x, chip.y, width, height);
    const blocked = (rect: Rect) =>
      placed.some((other) => overlaps(rect, other, gap));
    if (width <= 0 || height <= 0 || !blocked(home)) {
      offsets.set(chip.id, { dx: 0, dy: 0 });
      placed.push(home);
      continue;
    }
    // Beside each earlier chip: above, below, left and right of it. The
    // nearest that clears them all wins; chips are wide and short, so that
    // is usually a step up or down.
    let best: { x: number; y: number; distance: number } | null = null;
    for (const other of placed) {
      const candidates = [
        { x: chip.x, y: other.top - gap - height / 2 },
        { x: chip.x, y: other.bottom + gap + height / 2 },
        { x: other.left - gap - width / 2, y: chip.y },
        { x: other.right + gap + width / 2, y: chip.y }
      ];
      for (const candidate of candidates) {
        const rect = rectOf(candidate.x, candidate.y, width, height);
        if (!inside(rect, bounds) || blocked(rect)) continue;
        const distance = Math.hypot(candidate.x - chip.x, candidate.y - chip.y);
        if (!best || distance < best.distance - EPSILON) {
          best = { ...candidate, distance };
        }
      }
    }
    if (!best) {
      offsets.set(chip.id, { dx: 0, dy: 0 });
      placed.push(home);
      continue;
    }
    offsets.set(chip.id, { dx: best.x - chip.x, dy: best.y - chip.y });
    placed.push(rectOf(best.x, best.y, width, height));
  }
  return offsets;
}

/** A leader from a moved chip's edge to the point it labels. */
export interface ChipLeader {
  /** Where it starts, from the chip box's top-left corner. */
  x: number;
  y: number;
  length: number;
  /** Clockwise from the +x axis, in degrees. */
  angleDeg: number;
}

/**
 * The leader for a chip whose box is centred at `moved`, pointing back at
 * `target` (its handle's screen point), both in the same pixels: it runs
 * from where the line to the target leaves the box. None when the target is
 * under the box or too close to need one.
 */
export function chipLeader(
  moved: { x: number; y: number },
  target: { x: number; y: number },
  width: number,
  height: number,
  minLength = 4
): ChipLeader | null {
  const vx = target.x - moved.x;
  const vy = target.y - moved.y;
  const tx = vx === 0 ? Infinity : width / 2 / Math.abs(vx);
  const ty = vy === 0 ? Infinity : height / 2 / Math.abs(vy);
  const t = Math.min(tx, ty);
  if (!(t < 1)) return null;
  const length = Math.hypot(vx, vy) * (1 - t);
  if (length < minLength) return null;
  return {
    x: width / 2 + vx * t,
    y: height / 2 + vy * t,
    length,
    angleDeg: (Math.atan2(vy, vx) * 180) / Math.PI
  };
}
