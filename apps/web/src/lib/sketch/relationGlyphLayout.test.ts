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

function solve(chips: Chip[]) {
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
  layout.solve(chips.length);
  return chips.map((chip, index) => {
    const cx = chip.ax + layout.offset[index * 2]!;
    const cy = chip.ay + layout.offset[index * 2 + 1]!;
    const halfW = relationChipWidth(chip.glyphs) / 2;
    const halfH = RELATION_GLYPH_PX / 2;
    return {
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

  it('still finds free space when every ring candidate is taken', () => {
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
    const chips = solve(pile);
    for (let a = 0; a < chips.length; a += 1) {
      expect(covers(chips[a]!, 300, 300), `chip ${a} covers the anchor`).toBe(
        false
      );
      for (let b = a + 1; b < chips.length; b += 1) {
        expect(overlaps(chips[a]!, chips[b]!), `chips ${a} and ${b}`).toBe(
          false
        );
      }
    }
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
