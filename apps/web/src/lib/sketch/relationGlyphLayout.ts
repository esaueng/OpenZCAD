/**
 * Screen-space placement of relation glyph chips, run on every drawn frame.
 *
 * Each chip stands off its anchor along the projected normal its plane layout
 * chose (a curve's outward side, a point's widest gap), far enough that its
 * box clears the stroke or point, then claims space in anchor order: a chip
 * that would cover an earlier chip, or any anchor, tries the next candidate —
 * slid along its curve or swung round its point, then one ring further out.
 *
 * Only spots inside the viewport and clear of the viewport controls drawn
 * above the glyphs (the orientation cube, the rails, floating panels, which
 * would take a glyph's click) count, so a chip near an edge or a control turns
 * aside. A chip whose anchor is off-screen is left alone, and one with no
 * room within a bounded search is hidden for the frame rather than drawn over
 * another (see `shown`). Anchors and placed chips sit in a uniform screen
 * grid, so a candidate is checked against its neighbours only and a frame
 * costs about linear time in the chips.
 *
 * Everything lives in typed arrays sized once per overlay (grown, rarely,
 * when the viewport or a pile outgrows them), so a steady frame allocates
 * nothing however many chips the sketch has.
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
/** Further straight-out steps tried after the rings, before giving up. */
const EXTRA_RINGS = 8;
/** Grid cell edge for the neighbour search. */
const CELL_PX = 48;
/** The grid's extent when no viewport is given (tests); queries stay exact. */
const UNBOUNDED_PX = 4096;

/** A chip's box for `glyphs` glyphs in one row. */
export function relationChipWidth(glyphs: number): number {
  return (
    glyphs * RELATION_GLYPH_PX + Math.max(0, glyphs - 1) * RELATION_GLYPH_GAP_PX
  );
}

// Inputs per chip: anchor x/y, normal x/y (screen, y down), width, height,
// flags, a point chip's half gap, then its swing directions as projected
// from the sketch plane (x/y per entry of SWINGS) when the viewer gives them.
const SWING_AT = 8;
// Then, for a point chip in a gap under half a turn, the inward normals of
// the gap's two edge lines (x/y each), in screen space.
const WEDGE_AT = SWING_AT + 10;
const IN = WEDGE_AT + 4;
const VISIBLE = 1;
const POINT = 2;
/** The point chip's swing directions were projected, not rotated. */
const SWUNG = 4;
/** A chip holding the selected relation: placed even without free room. */
const PINNED = 8;
/** A point chip in a gap under half a turn: its box keeps inside the gap. */
const WEDGE = 16;
/** Clear space between a point chip's box and the curves edging its gap. */
const STROKE_CLEAR_PX = 3;

// Candidate moves for a curve chip: along its curve, in chip widths, on the
// preferred side and then the other.
const SLIDES = [0, 1, -1, 2, -2] as const;
// Candidate swings for a point chip, round the bisector of its gap, as
// fractions of its swing step (see `solve`).
export const RELATION_CHIP_SWINGS = [0, 0.5, -0.5, 1, -1] as const;
const SWINGS = RELATION_CHIP_SWINGS;
/** A point chip's widest swing, in radians, however open its gap. */
export const RELATION_CHIP_MAX_SWING = 1;
const MAX_SWING = RELATION_CHIP_MAX_SWING;

export class RelationGlyphLayout {
  readonly capacity: number;
  /** Per chip: [ax, ay, nx, ny, width, height, flags]. */
  readonly input: Float64Array;
  /** Per chip: the solved [dx, dy] from the anchor to the chip's centre. */
  readonly offset: Float64Array;
  /**
   * Per chip: 1 when it was placed, 0 when it has no room near its geometry
   * this frame and must not be drawn. An off-viewport or off-camera chip is
   * left where it is and counts as placed (it is clipped anyway).
   */
  readonly shown: Uint8Array;
  /**
   * The box and anchor comparisons the last `solve` made: what a test checks
   * to prove a frame's work grows linearly (a wall clock is too noisy to).
   */
  work = 0;
  // Placed boxes as [left, top, right, bottom], in anchor order.
  private readonly placed: Float64Array;
  // The grid: anchors bucketed per cell by a counting sort each frame, and
  // placed boxes as per-cell linked lists (a box joins every cell it spans).
  private cols = 1;
  private rows = 1;
  private width = 0;
  private height = 0;
  private anchorStart = new Int32Array(2);
  private anchorCursor = new Int32Array(1);
  private readonly anchorItems: Int32Array;
  private placedHead = new Int32Array(1);
  private placedNext: Int32Array;
  private placedItem: Int32Array;
  private placedEntries = 0;
  // Space glyphs keep out of, as [left, top, right, bottom] in viewport
  // pixels: viewport controls drawn above the label layer and the sketch's
  // dimension labels, either of which would take a glyph's click. They join
  // the grid as placed items numbered −1, −2, …
  private blocked = new Float64Array(64);
  private blockedCount = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.input = new Float64Array(capacity * IN);
    this.offset = new Float64Array(capacity * 2);
    this.shown = new Uint8Array(capacity);
    this.placed = new Float64Array(capacity * 4);
    this.anchorItems = new Int32Array(capacity);
    this.placedNext = new Int32Array(Math.max(4, capacity * 4));
    this.placedItem = new Int32Array(Math.max(4, capacity * 4));
  }

  /**
   * Space the glyphs keep out of (viewport controls above them, dimension
   * labels beside them), as `count` boxes of [left, top, right, bottom] in
   * viewport pixels. They hold until replaced.
   */
  setBlocked(rects: ArrayLike<number>, count: number) {
    if (this.blocked.length < count * 4) {
      // A rare growth step, never a steady-frame allocation.
      this.blocked = new Float64Array(
        Math.max(count * 4, this.blocked.length * 2)
      );
    }
    for (let index = 0; index < count * 4; index += 1) {
      this.blocked[index] = rects[index]!;
    }
    this.blockedCount = count;
  }

  /**
   * Marks chip `index` as holding the selected relation: it is laid out even
   * when no free spot is found (at its preferred one, kept on screen), so a
   * selection is never left without a visible glyph. Call after `set`.
   */
  pin(index: number) {
    const at = index * IN + 6;
    this.input[at] = this.input[at]! | PINNED;
  }

  /**
   * Point chip `index`'s swing directions as projected from the sketch plane,
   * one screen vector per entry of the swing table, as [x, y] pairs from
   * `at` in `directions`. Rotating a projected normal by a plane angle is
   * wrong on an oblique view; these keep each swing inside the projected gap.
   * Call after `set`.
   */
  setSwings(index: number, directions: ArrayLike<number>, at: number) {
    const base = index * IN;
    for (let entry = 0; entry < SWINGS.length; entry += 1) {
      const x = directions[at + entry * 2]!;
      const y = directions[at + entry * 2 + 1]!;
      const length = Math.hypot(x, y);
      const slot = base + SWING_AT + entry * 2;
      this.input[slot] = length > 1e-9 ? x / length : this.input[base + 2]!;
      this.input[slot + 1] = length > 1e-9 ? y / length : this.input[base + 3]!;
    }
    this.input[base + 6] = this.input[base + 6]! | SWUNG;
    // The gap's two edges follow the swings, projected the same way.
    const edges = at + SWINGS.length * 2;
    this.setWedge(
      index,
      directions[edges]!,
      directions[edges + 1]!,
      directions[edges + 2]!,
      directions[edges + 3]!
    );
  }

  /**
   * A point chip's gap edges as screen directions from its anchor. When the
   * gap is under half a turn, its box is kept inside both edge lines, so the
   * whole button (not only its centre) stays off the curves edging the gap.
   */
  private setWedge(
    index: number,
    e1x: number,
    e1y: number,
    e2x: number,
    e2y: number
  ) {
    const base = index * IN;
    const input = this.input;
    input[base + 6] = input[base + 6]! & ~WEDGE;
    // Up to and including half a turn (a point on a straight run, whose
    // edges are one line): the projected bisector need not be square to the
    // projected line, so even then the box must clear it.
    if (!(input[base + 7]! <= Math.PI / 2 + 1e-6)) return;
    const bx = input[base + 2]!;
    const by = input[base + 3]!;
    const inward = (ex: number, ey: number, slot: number): boolean => {
      const length = Math.hypot(ex, ey);
      if (!(length > 1e-9)) return false;
      // The edge turned a quarter, toward the bisector.
      let mx = -ey / length;
      let my = ex / length;
      if (mx * bx + my * by < 0) {
        mx = -mx;
        my = -my;
      }
      input[slot] = mx;
      input[slot + 1] = my;
      return true;
    };
    if (
      inward(e1x, e1y, base + WEDGE_AT) &&
      inward(e2x, e2y, base + WEDGE_AT + 2)
    ) {
      input[base + 6] = input[base + 6]! | WEDGE;
    }
  }

  /**
   * How far along `d` a point chip's centre must stand so its box clears
   * both edges of its gap by STROKE_CLEAR_PX, at least `reach`.
   */
  private wedgeReach(
    at: number,
    dx: number,
    dy: number,
    halfW: number,
    halfH: number,
    reach: number
  ): number {
    const input = this.input;
    if (!(input[at + 6]! & WEDGE)) return reach;
    let needed = reach;
    for (let edge = 0; edge < 2; edge += 1) {
      const mx = input[at + WEDGE_AT + edge * 2]!;
      const my = input[at + WEDGE_AT + edge * 2 + 1]!;
      const along = mx * dx + my * dy;
      if (along <= 1e-6) continue;
      needed = Math.max(
        needed,
        (Math.abs(mx) * halfW + Math.abs(my) * halfH + STROKE_CLEAR_PX) / along
      );
    }
    return needed;
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
    visible: boolean,
    /**
     * A point chip's room either side of its normal, in radians: half the
     * gap between the curves meeting there. Its swings stay within half of
     * it, so a candidate never lands on a curve.
     */
    halfGap = Math.PI
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
    input[at + 7] = halfGap;
    if (point) {
      // Edges by screen rotation until `setSwings` gives projected ones.
      const cos = Math.cos(halfGap);
      const sin = Math.sin(halfGap);
      const bx = input[at + 2]!;
      const by = input[at + 3]!;
      this.setWedge(
        index,
        bx * cos + by * sin,
        -bx * sin + by * cos,
        bx * cos - by * sin,
        bx * sin + by * cos
      );
    }
  }

  /**
   * Places chips 0…count−1 in index order (the anchor order), inside a
   * `width` × `height` viewport when one is given.
   */
  solve(count: number, width = 0, height = 0) {
    const input = this.input;
    const offset = this.offset;
    const shown = this.shown;
    const placed = this.placed;
    const bounded = width > 0 && height > 0;
    this.width = bounded ? width : 0;
    this.height = bounded ? height : 0;
    // An anchor off the viewport has nowhere on screen to stand off to: its
    // chip is left alone (clipped with it) and takes no part in the layout.
    for (let index = 0; index < count; index += 1) {
      const at = index * IN;
      if (
        bounded &&
        input[at + 6]! & VISIBLE &&
        !(
          input[at]! >= 0 &&
          input[at]! <= width &&
          input[at + 1]! >= 0 &&
          input[at + 1]! <= height
        )
      ) {
        input[at + 6] = input[at + 6]! & ~VISIBLE;
      }
    }
    this.index(
      count,
      bounded ? width : UNBOUNDED_PX,
      bounded ? height : UNBOUNDED_PX
    );
    for (let index = 0; index < this.blockedCount; index += 1) {
      this.insertRect(-1 - index, this.blocked, index * 4);
    }
    this.work = 0;
    let placedCount = 0;
    for (let index = 0; index < count; index += 1) {
      const at = index * IN;
      const flags = input[at + 6]!;
      offset[index * 2] = 0;
      offset[index * 2 + 1] = 0;
      shown[index] = 1;
      if (!(flags & VISIBLE)) continue;
      const ax = input[at]!;
      const ay = input[at + 1]!;
      const nx = input[at + 2]!;
      const ny = input[at + 3]!;
      const halfW = input[at + 4]! / 2;
      const halfH = input[at + 5]! / 2;
      const point = (flags & POINT) !== 0;
      // Swing at most half way to the gap's edge (and never past MAX_SWING),
      // so in a tight junction a chip keeps to the middle of its gap and
      // steps outward instead of onto a curve.
      const swingStep = Math.min(MAX_SWING, 0.5 * input[at + 7]!);
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
            if (point && flags & SWUNG) {
              dx = input[at + SWING_AT + candidate * 2]!;
              dy = input[at + SWING_AT + candidate * 2 + 1]!;
            } else if (point) {
              const angle = SWINGS[candidate]! * swingStep;
              const cos = Math.cos(angle);
              const sin = Math.sin(angle);
              dx = nx * cos - ny * sin;
              dy = nx * sin + ny * cos;
            } else {
              dx = nx * sign;
              dy = ny * sign;
            }
            // The box's support along the standoff direction, so its nearest
            // edge (not its centre) sits `reach` from the anchor.
            const support = Math.abs(dx) * halfW + Math.abs(dy) * halfH;
            const distance = point
              ? this.wedgeReach(at, dx, dy, halfW, halfH, reach + support)
              : reach + support;
            let cx = ax + dx * distance;
            let cy = ay + dy * distance;
            if (!point) {
              // Slide along the curve (the normal turned a quarter).
              const slide = SLIDES[candidate]! * (2 * halfW + CHIP_GAP_PX);
              cx += -dy * slide;
              cy += dx * slide;
            }
            if (this.free(cx - halfW, cy - halfH, cx + halfW, cy + halfH)) {
              chosenX = cx;
              chosenY = cy;
              found = true;
              break search;
            }
          }
        }
      }
      if (!found) {
        // Keep stepping out along the preferred direction, a few rings more,
        // through the grid: a dense patch is usually only a few rings deep,
        // and each step looks at its neighbours only.
        const standoff = Math.abs(nx) * halfW + Math.abs(ny) * halfH;
        const base = RELATION_CHIP_STANDOFF_PX + (point ? KEEP_OUT_PX : 0);
        for (let ring = RINGS; ring < RINGS + EXTRA_RINGS; ring += 1) {
          let reach = base + ring * (2 * halfH + CHIP_GAP_PX) + standoff;
          if (point) {
            reach = this.wedgeReach(at, nx, ny, halfW, halfH, reach);
          }
          const cx = ax + nx * reach;
          const cy = ay + ny * reach;
          if (this.free(cx - halfW, cy - halfH, cx + halfW, cy + halfH)) {
            chosenX = cx;
            chosenY = cy;
            found = true;
            break;
          }
        }
      }
      if (!found && flags & PINNED) {
        // The selected relation's chip keeps looking, straight out on either
        // side, as far as the viewport reaches: it is one chip, so the
        // longer search is cheap, and it still keeps clear of controls,
        // labels and anchors. Laid out first, no other glyph is in its way.
        const support = Math.abs(nx) * halfW + Math.abs(ny) * halfH;
        const base = RELATION_CHIP_STANDOFF_PX + (point ? KEEP_OUT_PX : 0);
        const limit = bounded ? Math.hypot(width, height) : UNBOUNDED_PX;
        const step = 2 * halfH + CHIP_GAP_PX;
        pinned: for (let reach = base; reach < limit; reach += step) {
          for (let side = 0; side < (point ? 1 : 2); side += 1) {
            const sx = side === 0 ? nx : -nx;
            const sy = side === 0 ? ny : -ny;
            let distance = reach + support;
            if (point) {
              distance = this.wedgeReach(at, sx, sy, halfW, halfH, distance);
            }
            const cx = ax + sx * distance;
            const cy = ay + sy * distance;
            if (this.free(cx - halfW, cy - halfH, cx + halfW, cy + halfH)) {
              chosenX = cx;
              chosenY = cy;
              found = true;
              break pinned;
            }
          }
        }
        // Still nothing: everything near it is under a control. It is hidden
        // like any other chip, and the viewer reports that so the selection
        // is dropped rather than left active with no glyph to show it.
      }
      if (!found) {
        // No room near its geometry (more relations than the view has space
        // for, such as a dense sketch zoomed far out): the chip is hidden
        // until zooming in makes room, rather than drawn over another glyph
        // or far from what it describes. The search is bounded, so a crowded
        // frame costs no more than a sparse one per chip.
        shown[index] = 0;
        continue;
      }
      shown[index] = 1;
      offset[index * 2] = chosenX - ax;
      offset[index * 2 + 1] = chosenY - ay;
      const p = placedCount * 4;
      placed[p] = chosenX - halfW;
      placed[p + 1] = chosenY - halfH;
      placed[p + 2] = chosenX + halfW;
      placed[p + 3] = chosenY + halfH;
      this.insertPlaced(placedCount);
      placedCount += 1;
    }
  }

  private column(x: number): number {
    const cell = Math.floor(x / CELL_PX);
    return cell < 0 ? 0 : cell >= this.cols ? this.cols - 1 : cell;
  }

  private row(y: number): number {
    const cell = Math.floor(y / CELL_PX);
    return cell < 0 ? 0 : cell >= this.rows ? this.rows - 1 : cell;
  }

  /**
   * Sizes the grid to the viewport and buckets this frame's visible anchors.
   * Anything off the grid clamps into its border cells, and queries clamp the
   * same way, so the search stays exact; the grid only decides how much of it
   * a query has to look at.
   */
  private index(count: number, width: number, height: number) {
    this.cols = Math.max(1, Math.ceil(width / CELL_PX));
    this.rows = Math.max(1, Math.ceil(height / CELL_PX));
    const cells = this.cols * this.rows;
    if (this.anchorStart.length < cells + 1) {
      this.anchorStart = new Int32Array(cells + 1);
      this.anchorCursor = new Int32Array(cells);
      this.placedHead = new Int32Array(cells);
    }
    const start = this.anchorStart;
    const input = this.input;
    start.fill(0, 0, cells + 1);
    for (let index = 0; index < count; index += 1) {
      const at = index * IN;
      if (!(input[at + 6]! & VISIBLE)) continue;
      start[
        this.row(input[at + 1]!) * this.cols + this.column(input[at]!) + 1
      ]! += 1;
    }
    for (let cell = 0; cell < cells; cell += 1) {
      start[cell + 1]! += start[cell]!;
    }
    // Copied by hand: `subarray` would allocate a view every frame.
    for (let cell = 0; cell < cells; cell += 1) {
      this.anchorCursor[cell] = start[cell]!;
    }
    for (let index = 0; index < count; index += 1) {
      const at = index * IN;
      if (!(input[at + 6]! & VISIBLE)) continue;
      const cell =
        this.row(input[at + 1]!) * this.cols + this.column(input[at]!);
      this.anchorItems[this.anchorCursor[cell]!] = index;
      this.anchorCursor[cell]! += 1;
    }
    this.placedHead.fill(-1, 0, cells);
    this.placedEntries = 0;
  }

  /** Links placed box `index` into every cell it spans. */
  private insertPlaced(index: number) {
    this.insertRect(index, this.placed, index * 4);
  }

  /**
   * Links a box into every cell it spans, as `item`: a placed chip's index,
   * or −1 − n for blocked box n.
   */
  private insertRect(item: number, boxes: Float64Array, at: number) {
    const c0 = this.column(boxes[at]!);
    const c1 = this.column(boxes[at + 2]!);
    const r0 = this.row(boxes[at + 1]!);
    const r1 = this.row(boxes[at + 3]!);
    for (let row = r0; row <= r1; row += 1) {
      for (let column = c0; column <= c1; column += 1) {
        if (this.placedEntries === this.placedItem.length) {
          // A rare growth step, never a steady-frame allocation.
          const grownNext = new Int32Array(this.placedItem.length * 2);
          const grownItem = new Int32Array(this.placedItem.length * 2);
          grownNext.set(this.placedNext);
          grownItem.set(this.placedItem);
          this.placedNext = grownNext;
          this.placedItem = grownItem;
        }
        const cell = row * this.cols + column;
        const entry = this.placedEntries;
        this.placedItem[entry] = item;
        this.placedNext[entry] = this.placedHead[cell]!;
        this.placedHead[cell] = entry;
        this.placedEntries += 1;
      }
    }
  }

  private free(
    left: number,
    top: number,
    right: number,
    bottom: number
  ): boolean {
    if (
      this.width > 0 &&
      (left < 0 || top < 0 || right > this.width || bottom > this.height)
    ) {
      return false;
    }
    const placed = this.placed;
    const blocked = this.blocked;
    const c0 = this.column(left - CHIP_GAP_PX);
    const c1 = this.column(right + CHIP_GAP_PX);
    const r0 = this.row(top - CHIP_GAP_PX);
    const r1 = this.row(bottom + CHIP_GAP_PX);
    for (let row = r0; row <= r1; row += 1) {
      for (let column = c0; column <= c1; column += 1) {
        for (
          let entry = this.placedHead[row * this.cols + column]!;
          entry >= 0;
          entry = this.placedNext[entry]!
        ) {
          this.work += 1;
          const item = this.placedItem[entry]!;
          const boxes = item >= 0 ? placed : blocked;
          const p = (item >= 0 ? item : -1 - item) * 4;
          if (
            left < boxes[p + 2]! + CHIP_GAP_PX &&
            right > boxes[p]! - CHIP_GAP_PX &&
            top < boxes[p + 3]! + CHIP_GAP_PX &&
            bottom > boxes[p + 1]! - CHIP_GAP_PX
          ) {
            return false;
          }
        }
      }
    }
    // Every visible anchor keeps a small square clear: no chip sits on a
    // point, its own or another chip's.
    const input = this.input;
    const start = this.anchorStart;
    const a0 = this.column(left - KEEP_OUT_PX);
    const a1 = this.column(right + KEEP_OUT_PX);
    const b0 = this.row(top - KEEP_OUT_PX);
    const b1 = this.row(bottom + KEEP_OUT_PX);
    for (let row = b0; row <= b1; row += 1) {
      for (let column = a0; column <= a1; column += 1) {
        const cell = row * this.cols + column;
        for (let item = start[cell]!; item < start[cell + 1]!; item += 1) {
          this.work += 1;
          const at = this.anchorItems[item]! * IN;
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
      }
    }
    return true;
  }
}
