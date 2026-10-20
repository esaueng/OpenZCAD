/**
 * Screen-space placement of relation glyph chips, run on every drawn frame.
 *
 * Each chip stands off its anchor along the projected normal its plane layout
 * chose (a curve's outward side, a point's widest gap), far enough that its
 * box clears the stroke or point, then claims space in anchor order: a chip
 * that would cover an earlier chip, or any anchor, tries the next candidate —
 * slid along its curve or swung round its point, then one ring further out.
 *
 * Everything lives in typed arrays sized once per overlay, so a frame
 * allocates nothing however many chips the sketch has.
 */

/** One glyph's box edge, in CSS pixels; matches `.sketch-relation-glyph`. */
export const RELATION_GLYPH_PX = 16;
/** Space between glyphs in a chip; matches `.sketch-relation-chip`'s gap. */
export const RELATION_GLYPH_GAP_PX = 2;
/** Clear space between a chip and its anchor's stroke or point. */
export const RELATION_CHIP_STANDOFF_PX = 6;
/** Half the square kept clear round every anchor point. */
const KEEP_OUT_PX = 5;
/** Clear space between two chips. */
const CHIP_GAP_PX = 2;
const RINGS = 4;

/** A chip's box for `glyphs` glyphs in one row. */
export function relationChipWidth(glyphs: number): number {
  return (
    glyphs * RELATION_GLYPH_PX + Math.max(0, glyphs - 1) * RELATION_GLYPH_GAP_PX
  );
}

// Inputs per chip: anchor x/y, normal x/y (screen, y down), width, height,
// flags (bit 0 visible, bit 1 point placement).
const IN = 7;
const POINT = 2;
const VISIBLE = 1;

// Candidate moves for a curve chip: along its curve, in chip widths, on the
// preferred side and then the other.
const SLIDES = [0, 1, -1, 2, -2] as const;
// Candidate swings for a point chip, round the bisector of its gap.
const SWINGS = [0, 0.5, -0.5, 1, -1].map((angle) => ({
  cos: Math.cos(angle),
  sin: Math.sin(angle)
}));

export class RelationGlyphLayout {
  readonly capacity: number;
  /** Per chip: [ax, ay, nx, ny, width, height, flags]. */
  readonly input: Float64Array;
  /** Per chip: the solved [dx, dy] from the anchor to the chip's centre. */
  readonly offset: Float64Array;
  // Placed boxes as [left, top, right, bottom], in anchor order.
  private readonly placed: Float64Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.input = new Float64Array(capacity * IN);
    this.offset = new Float64Array(capacity * 2);
    this.placed = new Float64Array(capacity * 4);
  }

  /** Writes chip `index`'s projected inputs; call before `solve`. */
  set(
    index: number,
    ax: number,
    ay: number,
    nx: number,
    ny: number,
    width: number,
    height: number,
    point: boolean,
    visible: boolean
  ) {
    const at = index * IN;
    const length = Math.hypot(nx, ny);
    const input = this.input;
    input[at] = ax;
    input[at + 1] = ay;
    // A normal seen end-on (a plane edge-on to the camera) has no screen
    // direction: stand off down and to the right, like the old fixed margin.
    input[at + 2] = length > 1e-9 ? nx / length : Math.SQRT1_2;
    input[at + 3] = length > 1e-9 ? ny / length : Math.SQRT1_2;
    input[at + 4] = width;
    input[at + 5] = height;
    input[at + 6] = (visible ? VISIBLE : 0) | (point ? POINT : 0);
  }

  /** Places chips 0…count−1 in index order (the anchor order). */
  solve(count: number) {
    const input = this.input;
    const offset = this.offset;
    const placed = this.placed;
    let placedCount = 0;
    for (let index = 0; index < count; index += 1) {
      const at = index * IN;
      const flags = input[at + 6]!;
      offset[index * 2] = 0;
      offset[index * 2 + 1] = 0;
      if (!(flags & VISIBLE)) continue;
      const ax = input[at]!;
      const ay = input[at + 1]!;
      const nx = input[at + 2]!;
      const ny = input[at + 3]!;
      const halfW = input[at + 4]! / 2;
      const halfH = input[at + 5]! / 2;
      const point = (flags & POINT) !== 0;
      let chosenX = Number.NaN;
      let chosenY = 0;
      let found = false;
      search: for (let ring = 0; ring < RINGS; ring += 1) {
        const reach =
          RELATION_CHIP_STANDOFF_PX +
          (point ? KEEP_OUT_PX : 0) +
          ring * (2 * halfH + CHIP_GAP_PX);
        for (let side = 0; side < (point ? 1 : 2); side += 1) {
          const sign = side === 0 ? 1 : -1;
          const candidates = point ? SWINGS.length : SLIDES.length;
          for (let candidate = 0; candidate < candidates; candidate += 1) {
            let dx: number;
            let dy: number;
            if (point) {
              const swing = SWINGS[candidate]!;
              dx = nx * swing.cos - ny * swing.sin;
              dy = nx * swing.sin + ny * swing.cos;
            } else {
              dx = nx * sign;
              dy = ny * sign;
            }
            // The box's support along the standoff direction, so its nearest
            // edge (not its centre) sits `reach` from the anchor.
            const support = Math.abs(dx) * halfW + Math.abs(dy) * halfH;
            let cx = ax + dx * (reach + support);
            let cy = ay + dy * (reach + support);
            if (!point) {
              // Slide along the curve (the normal turned a quarter).
              const slide = SLIDES[candidate]! * (2 * halfW + CHIP_GAP_PX);
              cx += -dy * slide;
              cy += dx * slide;
            }
            if (
              this.free(
                cx - halfW,
                cy - halfH,
                cx + halfW,
                cy + halfH,
                count,
                placedCount
              )
            ) {
              chosenX = cx;
              chosenY = cy;
              found = true;
              break search;
            }
          }
        }
      }
      if (!found) {
        // Every candidate is taken (a pile of curves projecting onto one
        // spot): stand off along the preferred direction past every placed
        // chip and anchor. Beyond all of them along that axis, the box can
        // overlap none of them, so the fallback is always free.
        const support = Math.abs(nx) * halfW + Math.abs(ny) * halfH;
        let reach =
          RELATION_CHIP_STANDOFF_PX + (point ? KEEP_OUT_PX : 0) + support;
        for (let other = 0; other < placedCount; other += 1) {
          const p = other * 4;
          const far =
            Math.max((placed[p]! - ax) * nx, (placed[p + 2]! - ax) * nx) +
            Math.max((placed[p + 1]! - ay) * ny, (placed[p + 3]! - ay) * ny);
          reach = Math.max(reach, far + CHIP_GAP_PX + support + 1);
        }
        for (let other = 0; other < count; other += 1) {
          const o = other * IN;
          if (!(input[o + 6]! & VISIBLE)) continue;
          const far =
            (input[o]! - ax) * nx +
            (input[o + 1]! - ay) * ny +
            KEEP_OUT_PX * (Math.abs(nx) + Math.abs(ny));
          reach = Math.max(reach, far + support + 1);
        }
        chosenX = ax + nx * reach;
        chosenY = ay + ny * reach;
      }
      offset[index * 2] = chosenX - ax;
      offset[index * 2 + 1] = chosenY - ay;
      const p = placedCount * 4;
      placed[p] = chosenX - halfW;
      placed[p + 1] = chosenY - halfH;
      placed[p + 2] = chosenX + halfW;
      placed[p + 3] = chosenY + halfH;
      placedCount += 1;
    }
  }

  private free(
    left: number,
    top: number,
    right: number,
    bottom: number,
    chips: number,
    placedCount: number
  ): boolean {
    const placed = this.placed;
    for (let index = 0; index < placedCount; index += 1) {
      const p = index * 4;
      if (
        left < placed[p + 2]! + CHIP_GAP_PX &&
        right > placed[p]! - CHIP_GAP_PX &&
        top < placed[p + 3]! + CHIP_GAP_PX &&
        bottom > placed[p + 1]! - CHIP_GAP_PX
      ) {
        return false;
      }
    }
    // Every visible anchor keeps a small square clear: no chip sits on a
    // point, its own or another chip's.
    const input = this.input;
    for (let index = 0; index < chips; index += 1) {
      const at = index * IN;
      if (!(input[at + 6]! & VISIBLE)) continue;
      const ax = input[at]!;
      const ay = input[at + 1]!;
      if (
        left < ax + KEEP_OUT_PX &&
        right > ax - KEEP_OUT_PX &&
        top < ay + KEEP_OUT_PX &&
        bottom > ay - KEEP_OUT_PX
      ) {
        return false;
      }
    }
    return true;
  }
}
