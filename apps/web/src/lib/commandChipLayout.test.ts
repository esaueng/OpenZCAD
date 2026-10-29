import { describe, expect, it } from 'vitest';
import {
  chipLeader,
  COMMAND_CHIP_GAP_PX,
  separateChips,
  type ChipBox
} from './commandChipLayout';

const STAGE = { left: 0, top: 0, right: 1000, bottom: 700 };

function boxes(
  chips: readonly ChipBox[],
  offsets: Map<string, { dx: number; dy: number }>
) {
  return chips.map((chip) => {
    const { dx, dy } = offsets.get(chip.id)!;
    return {
      left: chip.x + dx - chip.width / 2,
      right: chip.x + dx + chip.width / 2,
      top: chip.y + dy - chip.height / 2,
      bottom: chip.y + dy + chip.height / 2
    };
  });
}

function anyOverlap(rects: ReturnType<typeof boxes>): boolean {
  return rects.some((a, i) =>
    rects.some(
      (b, j) =>
        i < j &&
        a.left < b.right &&
        b.left < a.right &&
        a.top < b.bottom &&
        b.top < a.bottom
    )
  );
}

describe('separateChips', () => {
  it('pulls a hole step chip off the diameter chip it covered', () => {
    // F005, as 57-hole-fit-chip-overlap.png drew it: "⌀ 6" at (560, 395)
    // under "Countersink ⌀ 12 mm" at (638, 388), and "90°" above both.
    const chips: ChipBox[] = [
      { id: 'diameter', x: 560, y: 395, width: 52, height: 20 },
      { id: 'countersinkDiameter', x: 638, y: 388, width: 146, height: 20 },
      { id: 'countersinkAngleDeg', x: 578, y: 360, width: 40, height: 20 }
    ];
    const offsets = separateChips(chips, STAGE);
    // The bore's own chip, the command's first value, keeps its place.
    expect(offsets.get('diameter')).toEqual({ dx: 0, dy: 0 });
    expect(offsets.get('countersinkDiameter')).not.toEqual({ dx: 0, dy: 0 });
    const rects = boxes(chips, offsets);
    expect(anyOverlap(rects)).toBe(false);
    // Moved the least way: a step up past the diameter chip, not across.
    expect(offsets.get('countersinkDiameter')!.dy).toBeLessThan(0);
    expect(offsets.get('countersinkDiameter')!.dx).toBe(0);
  });

  it('leaves chips that already stand apart where they are', () => {
    const chips: ChipBox[] = [
      { id: 'a', x: 100, y: 100, width: 60, height: 20 },
      { id: 'b', x: 100, y: 130, width: 60, height: 20 },
      { id: 'c', x: 300, y: 100, width: 60, height: 20 }
    ];
    for (const offset of separateChips(chips, STAGE).values()) {
      expect(offset).toEqual({ dx: 0, dy: 0 });
    }
  });

  it('stacks chips that project onto one point, with the gap between', () => {
    const chips: ChipBox[] = ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      x: 400,
      y: 300,
      width: 80,
      height: 20
    }));
    const offsets = separateChips(chips, STAGE);
    const rects = boxes(chips, offsets);
    expect(anyOverlap(rects)).toBe(false);
    const tops = rects.map((rect) => rect.top).sort((a, b) => a - b);
    for (let index = 1; index < tops.length; index += 1) {
      expect(tops[index]! - tops[index - 1]!).toBeGreaterThanOrEqual(
        20 + COMMAND_CHIP_GAP_PX - 0.01
      );
    }
  });

  it('keeps a moved chip inside the stage', () => {
    // At the stage's top edge there is no room above: it goes below.
    const chips: ChipBox[] = [
      { id: 'a', x: 200, y: 10, width: 80, height: 20 },
      { id: 'b', x: 210, y: 12, width: 80, height: 20 }
    ];
    const offsets = separateChips(chips, STAGE);
    const [, moved] = boxes(chips, offsets);
    expect(moved!.top).toBeGreaterThanOrEqual(STAGE.top);
    expect(offsets.get('b')!.dy).toBeGreaterThan(0);
  });

  it('leaves a chip in place when nothing inside the stage clears it', () => {
    const tight = { left: 0, top: 0, right: 80, bottom: 20 };
    const chips: ChipBox[] = [
      { id: 'a', x: 40, y: 10, width: 80, height: 20 },
      { id: 'b', x: 40, y: 10, width: 80, height: 20 }
    ];
    expect(separateChips(chips, tight).get('b')).toEqual({ dx: 0, dy: 0 });
  });
});

describe('chipLeader', () => {
  it('runs from the moved box edge back to its handle', () => {
    // A 100 x 20 chip moved 40px below its handle.
    const leader = chipLeader({ x: 50, y: 60 }, { x: 50, y: 20 }, 100, 20)!;
    expect(leader.x).toBeCloseTo(50);
    expect(leader.y).toBeCloseTo(0);
    expect(leader.length).toBeCloseTo(30);
    expect(leader.angleDeg).toBeCloseTo(-90);
  });

  it('draws none for a handle under the chip or just at its edge', () => {
    expect(chipLeader({ x: 0, y: 0 }, { x: 10, y: 2 }, 100, 20)).toBeNull();
    expect(chipLeader({ x: 0, y: 0 }, { x: 0, y: 12 }, 100, 20)).toBeNull();
  });
});
