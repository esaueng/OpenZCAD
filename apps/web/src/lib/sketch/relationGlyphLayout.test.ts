import { describe, expect, it } from 'vitest';
import {
  RELATION_CHIP_STANDOFF_PX,
  RELATION_GLYPH_PX,
  RelationGlyphLayout,
  relationChipWidth
} from './relationGlyphLayout';

type Chip = {
  ax: number;
  ay: number;
  nx: number;
  ny: number;
  glyphs: number;
  point: boolean;
  visible?: boolean;
};

function solve(chips: Chip[], width = 0, height = 0) {
  const layout = new RelationGlyphLayout(chips.length);
  chips.forEach((chip, index) =>
    layout.set(
      index,
      chip.ax,
      chip.ay,
      chip.nx,
      chip.ny,
      relationChipWidth(chip.glyphs),
      RELATION_GLYPH_PX,
      chip.point,
      chip.visible ?? true
    )
  );
  layout.solve(chips.length, width, height);
  return chips.map((chip, index) => {
    const cx = chip.ax + layout.offset[index * 2]!;
    const cy = chip.ay + layout.offset[index * 2 + 1]!;
    const halfW = relationChipWidth(chip.glyphs) / 2;
    const halfH = RELATION_GLYPH_PX / 2;
    return {
      shown: layout.shown[index] === 1,
      dx: layout.offset[index * 2]!,
      dy: layout.offset[index * 2 + 1]!,
      left: cx - halfW,
      right: cx + halfW,
      top: cy - halfH,
      bottom: cy + halfH
    };
  });
}

const overlaps = (
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number }
) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const covers = (
  box: { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number,
  pad = 0
) =>
  box.left - pad < x &&
  box.right + pad > x &&
  box.top - pad < y &&
  box.bottom + pad > y;

describe('relation glyph layout', () => {
  it('stands a curve chip off its stroke along the normal, edge clear of the line', () => {
    // A horizontal line through (200, 200); its normal points up the screen.
    const [chip] = solve([
      { ax: 200, ay: 200, nx: 0, ny: -1, glyphs: 2, point: false }
    ]);
    expect(chip!.dx).toBeCloseTo(0);
    expect(chip!.bottom).toBeCloseTo(200 - RELATION_CHIP_STANDOFF_PX);
  });

  it('keeps a point chip off its point, along the open side of a corner', () => {
    // A corner whose curves leave left and down: the gap bisector is up-right.
    const [chip] = solve([
      {
        ax: 100,
        ay: 100,
        nx: Math.SQRT1_2,
        ny: -Math.SQRT1_2,
        glyphs: 3,
        point: true
      }
    ]);
    expect(covers(chip!, 100, 100, 5)).toBe(false);
    // Up and to the right, its whole box above the leftward curve (y = 100),
    // so it crosses neither curve.
    expect((chip!.left + chip!.right) / 2).toBeGreaterThan(100);
    expect(chip!.bottom).toBeLessThan(100 - RELATION_CHIP_STANDOFF_PX);
  });

  it('claims space in anchor order: a later chip moves, never onto an earlier one', () => {
    // Two curves whose midpoints project to the same pixel, and a point there.
    const chips = solve([
      { ax: 50, ay: 50, nx: 0, ny: -1, glyphs: 1, point: true },
      { ax: 50, ay: 50, nx: 0, ny: -1, glyphs: 2, point: false },
      { ax: 50, ay: 50, nx: 0, ny: -1, glyphs: 2, point: false }
    ]);
    // The first keeps its preferred spot exactly.
    expect(chips[0]!.dx).toBeCloseTo(0);
    for (let a = 0; a < chips.length; a += 1) {
      for (let b = a + 1; b < chips.length; b += 1) {
        expect(overlaps(chips[a]!, chips[b]!)).toBe(false);
      }
      expect(covers(chips[a]!, 50, 50)).toBe(false);
    }
  });

  it('never commits an occupied spot when every ring candidate is taken', () => {
    // Forty-one overlapping curves and a point projecting onto one spot, each
    // with a wide chip: far more than the ring candidates can hold.
    const pile: Chip[] = [
      { ax: 300, ay: 300, nx: 0, ny: -1, glyphs: 2, point: true },
      ...Array.from({ length: 41 }, () => ({
        ax: 300,
        ay: 300,
        nx: 0.6,
        ny: -0.8,
        glyphs: 3,
        point: false
      }))
    ];
    const chips = solve(pile, 600, 600);
    const shown = chips.filter((chip) => chip.shown);
    // The rings and the straight-out steps place over half of them (24
    // here); the rest are hidden until zooming makes room, never overlapped.
    expect(shown.length).toBeGreaterThan(20);
    for (let a = 0; a < shown.length; a += 1) {
      expect(covers(shown[a]!, 300, 300), `chip ${a} covers the anchor`).toBe(
        false
      );
      for (let b = a + 1; b < shown.length; b += 1) {
        expect(overlaps(shown[a]!, shown[b]!), `chips ${a} and ${b}`).toBe(
          false
        );
      }
    }
  });

  it('turns a chip inward rather than off the viewport edge', () => {
    // A curve near the right edge whose outward side points off-screen.
    const [chip] = solve(
      [{ ax: 395, ay: 200, nx: 1, ny: 0, glyphs: 2, point: false }],
      400,
      400
    );
    expect(chip!.left).toBeGreaterThanOrEqual(0);
    expect(chip!.right).toBeLessThanOrEqual(400);
    expect(covers(chip!, 395, 200)).toBe(false);
  });

  it('hides what has no room in a crowded corner instead of overlapping or leaving the view', () => {
    const pile: Chip[] = Array.from({ length: 60 }, () => ({
      ax: 390,
      ay: 390,
      nx: 1,
      ny: 1,
      glyphs: 2,
      point: false
    }));
    const chips = solve(pile, 400, 400);
    const shown = chips.filter((chip) => chip.shown);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(60);
    for (const [a, chip] of shown.entries()) {
      expect(chip.left).toBeGreaterThanOrEqual(0);
      expect(chip.top).toBeGreaterThanOrEqual(0);
      expect(chip.right).toBeLessThanOrEqual(400);
      expect(chip.bottom).toBeLessThanOrEqual(400);
      for (const other of shown.slice(a + 1)) {
        expect(overlaps(chip, other)).toBe(false);
      }
    }
  });

  it('swings a point chip only within its gap', () => {
    // A six-way junction: 30° either side of the bisector (straight up).
    // Its first spot is taken, so it must swing, but no further than half
    // way to the curves either side, never onto one.
    const halfGap = Math.PI / 6;
    const layout = new RelationGlyphLayout(1);
    layout.setBlocked([192, 160, 208, 189], 1);
    layout.set(0, 200, 200, 0, -1, 16, 16, true, true, halfGap);
    layout.solve(1, 400, 400);
    expect(layout.shown[0]).toBe(1);
    const dx = layout.offset[0]!;
    const dy = layout.offset[1]!;
    const fromBisector = Math.abs(Math.atan2(dx, -dy));
    expect(fromBisector).toBeLessThanOrEqual(halfGap / 2 + 1e-9);
    expect(
      overlaps(
        {
          left: 200 + dx - 8,
          right: 200 + dx + 8,
          top: 200 + dy - 8,
          bottom: 200 + dy + 8
        },
        { left: 192, top: 160, right: 208, bottom: 189 }
      )
    ).toBe(false);
  });

  it('swings a point chip along the projected directions it is given', () => {
    // On an oblique view the gap's projection is skewed: the viewer passes
    // each swing already projected. With the first spot taken, the chip must
    // take one of those directions, not a screen rotation of the normal.
    const layout = new RelationGlyphLayout(1);
    // An open gap (over half a turn), so only the swings are in play.
    layout.set(0, 200, 200, 0, -1, 16, 16, true, true, Math.PI);
    // Bisector up; the swings lean far right only (a skewed projection),
    // then the gap's two projected edges.
    layout.setSwings(
      0,
      [0, -1, 0.6, -0.8, 0.8, -0.6, 0.6, -0.8, 0.8, -0.6, -1, 0.2, 1, 0.2],
      0
    );
    layout.setBlocked([192, 160, 208, 189], 1);
    layout.solve(1, 400, 400);
    const dx = layout.offset[0]!;
    const dy = layout.offset[1]!;
    const length = Math.hypot(dx, dy);
    const matches = [
      [0.6, -0.8],
      [0.8, -0.6]
    ].some(
      ([x, y]) => Math.abs(dx / length - x!) + Math.abs(dy / length - y!) < 1e-9
    );
    expect(matches).toBe(true);
  });

  it("keeps a point chip's whole box inside a narrow gap, not just its centre", () => {
    // A six-way junction: 30° either side of the bisector (straight up).
    // A 16 px box at the plain standoff would reach over both edge curves.
    const halfGap = Math.PI / 6;
    const layout = new RelationGlyphLayout(1);
    layout.set(0, 200, 200, 0, -1, 16, 16, true, true, halfGap);
    layout.solve(1, 400, 400);
    const cx = 200 + layout.offset[0]!;
    const cy = 200 + layout.offset[1]!;
    for (const sign of [1, -1]) {
      // The edge leaves the anchor 30° either side of straight up (screen y
      // down); its normal points back toward the bisector.
      const ex = sign * Math.sin(halfGap);
      const ey = -Math.cos(halfGap);
      let mx = -ey;
      let my = ex;
      if (mx * 0 + my * -1 < 0) {
        mx = -mx;
        my = -my;
      }
      for (const [x, y] of [
        [cx - 8, cy - 8],
        [cx + 8, cy - 8],
        [cx - 8, cy + 8],
        [cx + 8, cy + 8]
      ]) {
        expect(mx * (x! - 200) + my * (y! - 200)).toBeGreaterThanOrEqual(
          3 - 1e-9
        );
      }
    }
  });

  it("searches further for the selected relation's chip, still clear of controls", () => {
    // A panel over everything but a strip along the top: an ordinary chip
    // gives up nearby and hides, the selected one walks out to the strip.
    const layout = new RelationGlyphLayout(2);
    layout.setBlocked([0, 40, 400, 400], 1);
    layout.set(0, 200, 300, 0, -1, 16, 16, false, true);
    layout.pin(0);
    layout.set(1, 100, 300, 0, -1, 16, 16, false, true);
    layout.solve(2, 400, 400);
    expect(layout.shown[0]).toBe(1);
    expect(layout.shown[1]).toBe(0);
    const cy = 300 + layout.offset[1]!;
    expect(cy + 8).toBeLessThanOrEqual(40 - 2);
    expect(cy - 8).toBeGreaterThanOrEqual(0);
  });

  it("hides even the selected relation's chip when no spot on screen is clear", () => {
    const layout = new RelationGlyphLayout(1);
    layout.setBlocked([0, 0, 400, 400], 1);
    layout.set(0, 200, 200, 0, -1, 16, 16, false, true);
    layout.pin(0);
    layout.solve(1, 400, 400);
    expect(layout.shown[0]).toBe(0);
  });

  it('keeps a point chip clear of a straight run seen obliquely', () => {
    // A point on a straight line: a half-turn gap, its two edges one line.
    // Seen obliquely, the projected line leans 60° off square to the
    // projected bisector (straight up), so the plain standoff would cross it.
    const layout = new RelationGlyphLayout(1);
    layout.set(0, 200, 200, 0, -1, 16, 16, true, true, Math.PI / 2);
    const lean = Math.PI / 3;
    const ex = Math.cos(lean);
    const ey = Math.sin(lean);
    layout.setSwings(
      0,
      [0, -1, 0, -1, 0, -1, 0, -1, 0, -1, ex, ey, -ex, -ey],
      0
    );
    layout.solve(1, 400, 400);
    const cx = 200 + layout.offset[0]!;
    const cy = 200 + layout.offset[1]!;
    // The line's normal on the chip's side.
    let mx = -ey;
    let my = ex;
    if (my > 0) {
      mx = -mx;
      my = -my;
    }
    for (const [x, y] of [
      [cx - 8, cy - 8],
      [cx + 8, cy - 8],
      [cx - 8, cy + 8],
      [cx + 8, cy + 8]
    ]) {
      expect(mx * (x! - 200) + my * (y! - 200)).toBeGreaterThanOrEqual(
        3 - 1e-9
      );
    }
  });

  it('keeps chips out from under the viewport controls drawn above them', () => {
    const layout = new RelationGlyphLayout(1);
    // A rail covering the chip's preferred spot above the curve.
    layout.setBlocked([180, 150, 220, 195], 1);
    layout.set(0, 200, 200, 0, -1, 34, 16, false, true);
    layout.solve(1, 400, 400);
    const cx = 200 + layout.offset[0]!;
    const cy = 200 + layout.offset[1]!;
    const box = { left: cx - 17, right: cx + 17, top: cy - 8, bottom: cy + 8 };
    expect(layout.shown[0]).toBe(1);
    expect(
      overlaps(box, { left: 180, top: 150, right: 220, bottom: 195 })
    ).toBe(false);
    expect(covers(box, 200, 200)).toBe(false);
  });

  it('honours any number of blocked boxes', () => {
    // Forty boxes; the last covers the chip's preferred spot.
    const rects: number[] = [];
    for (let index = 0; index < 39; index += 1) {
      rects.push(index * 10, 380, index * 10 + 8, 390);
    }
    rects.push(180, 150, 220, 195);
    const layout = new RelationGlyphLayout(1);
    layout.setBlocked(rects, 40);
    layout.set(0, 200, 200, 0, -1, 34, 16, false, true);
    layout.solve(1, 400, 400);
    const cx = 200 + layout.offset[0]!;
    const cy = 200 + layout.offset[1]!;
    expect(
      overlaps(
        { left: cx - 17, right: cx + 17, top: cy - 8, bottom: cy + 8 },
        { left: 180, top: 150, right: 220, bottom: 195 }
      )
    ).toBe(false);
  });

  it('leaves a chip whose anchor is off the viewport alone', () => {
    const chips = solve(
      [
        { ax: -40, ay: 100, nx: 0, ny: -1, glyphs: 1, point: false },
        { ax: 100, ay: 100, nx: 0, ny: -1, glyphs: 1, point: false }
      ],
      400,
      400
    );
    expect(chips[0]!.dx).toBe(0);
    expect(chips[0]!.dy).toBe(0);
    expect(chips[1]!.dy).toBeLessThan(0);
  });

  it('lays out thousands of separate chips in about linear time', () => {
    // A 150 × 150 lattice of curve anchors 40 px apart (a chip and its
    // standoff need 30): every chip finds its first spot free, so the cost
    // is the neighbour search alone.
    const lattice: Chip[] = [];
    for (let row = 0; row < 150; row += 1) {
      for (let column = 0; column < 150; column += 1) {
        lattice.push({
          ax: 20 + column * 40,
          ay: 20 + row * 40,
          nx: 0,
          ny: -1,
          glyphs: 1,
          point: false
        });
      }
    }
    const layout = new RelationGlyphLayout(lattice.length);
    lattice.forEach((chip, index) =>
      layout.set(index, chip.ax, chip.ay, chip.nx, chip.ny, 16, 16, false, true)
    );
    layout.solve(lattice.length, 6000, 6000);
    // About 5.5 comparisons per chip; scanning every anchor per chip is
    // about 2.5e8 here.
    expect(layout.work).toBeLessThan(20 * lattice.length);
  });

  it('bounds the cost of a lattice too dense for its glyphs', () => {
    // Anchors 26 px apart: less than a chip and its standoff need, so most
    // chips search their whole bounded neighbourhood and some are hidden.
    const layout = new RelationGlyphLayout(150 * 150);
    for (let row = 0; row < 150; row += 1) {
      for (let column = 0; column < 150; column += 1) {
        layout.set(
          row * 150 + column,
          13 + column * 26,
          13 + row * 26,
          0,
          -1,
          16,
          16,
          row % 2 === 0,
          true
        );
      }
    }
    layout.solve(150 * 150, 3900, 3900);
    // About 160 comparisons per chip: every candidate of a bounded search,
    // each against its neighbours only. Some chips are hidden for want of
    // room rather than searched for further.
    expect(layout.work).toBeLessThan(400 * 150 * 150);
    expect(
      [...layout.shown].filter((shown) => shown === 0).length
    ).toBeGreaterThan(0);
  });

  it('keeps every chip off every anchor, not just its own', () => {
    // A short line: its middle chip would sit on the end point beside it.
    const chips = solve([
      { ax: 110, ay: 90, nx: 0, ny: -1, glyphs: 1, point: true },
      { ax: 100, ay: 100, nx: 0, ny: -1, glyphs: 4, point: false }
    ]);
    expect(covers(chips[1]!, 110, 90, 0)).toBe(false);
    expect(overlaps(chips[0]!, chips[1]!)).toBe(false);
  });

  it('leaves a chip whose anchor is off-camera alone and out of the way', () => {
    const chips = solve([
      {
        ax: 10,
        ay: 10,
        nx: 0,
        ny: -1,
        glyphs: 2,
        point: false,
        visible: false
      },
      { ax: 10, ay: 10, nx: 0, ny: -1, glyphs: 2, point: false }
    ]);
    expect(chips[0]!.dx).toBe(0);
    expect(chips[0]!.dy).toBe(0);
    // The visible chip takes the preferred spot the hidden one would have.
    expect(chips[1]!.dx).toBeCloseTo(0);
  });

  it('falls back to a fixed diagonal when the normal projects to nothing', () => {
    const [chip] = solve([
      { ax: 0, ay: 0, nx: 0, ny: 0, glyphs: 1, point: true }
    ]);
    expect(chip!.dx).toBeGreaterThan(0);
    expect(chip!.dy).toBeGreaterThan(0);
  });

  it('reuses its buffers from frame to frame', () => {
    const layout = new RelationGlyphLayout(2);
    const offset = layout.offset;
    layout.set(0, 0, 0, 0, -1, 16, 16, false, true);
    layout.set(1, 0, 0, 0, -1, 16, 16, false, true);
    layout.solve(2);
    const first = [...offset];
    layout.solve(2);
    expect(layout.offset).toBe(offset);
    expect([...layout.offset]).toEqual(first);
  });
});
