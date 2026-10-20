import { describe, expect, it } from 'vitest';
import {
  chipPanelDodge,
  edgeChipCenterX,
  faceOffsetChipState,
  offsetChipText,
  regionChipState
} from './offsetChip';

describe('offset chip', () => {
  it('reads a primitive resize as its total and any other face as the change', () => {
    expect(faceOffsetChipState(20, 10)).toEqual({ mode: 'total', extent: 10 });
    expect(faceOffsetChipState(undefined, 10)).toEqual({
      mode: 'offset',
      extent: 10
    });
  });

  it('reads Total as the span plus the signed offset', () => {
    expect(
      offsetChipText({
        rawValue: -5,
        mode: 'total',
        span: 10,
        sense: 1,
        units: 'mm'
      })
    ).toBe('5 mm');
    expect(
      offsetChipText({
        rawValue: 2.004,
        mode: 'offset',
        span: 10,
        sense: 1,
        units: 'mm'
      })
    ).toBe('+2 mm');
  });

  it('starts a region drag from its own state, not the last face offset', () => {
    // The defect: a region rig reused the face rig's chip refs, so after a
    // face offset left Total mode and a 10 mm span behind, a −5 mm region
    // drag read "5 mm" under a Total tag.
    const stale = faceOffsetChipState(20, 10);
    const region = regionChipState();
    expect(region).toEqual({ mode: 'offset', extent: null });
    const reading = (state: typeof stale) =>
      offsetChipText({
        rawValue: -5,
        mode: state.mode,
        span: state.extent,
        sense: 1,
        units: 'mm'
      });
    expect(reading(stale)).toBe('5 mm');
    expect(reading(region)).toBe('-5 mm');
  });

  it('reads Total and Offset at the same precision', () => {
    const reading = (mode: 'offset' | 'total') =>
      offsetChipText({
        rawValue: 2.004,
        mode,
        span: 10,
        sense: 1,
        units: 'in'
      });
    expect(reading('offset')).toBe('+2 in');
    expect(reading('total')).toBe('12 in');
  });

  it('never reads Total without a span to add to', () => {
    expect(
      offsetChipText({
        rawValue: -5,
        mode: 'total',
        span: null,
        sense: 1,
        units: 'mm'
      })
    ).toBe('-5 mm');
  });

  it('keeps an edge chip clear of the right lane only when it fits beside it', () => {
    expect(edgeChipCenterX(300, null, 60)).toBe(300);
    // A desktop lane at 900: the chip is left alone short of it and pulled
    // back to 8px clear of it otherwise.
    expect(edgeChipCenterX(300, 900, 60)).toBe(300);
    expect(edgeChipCenterX(880, 900, 60)).toBe(862);
    // A phone lane starting at the 10px inset leaves no room: dodging it
    // would put the chip off-screen, so it stays on its anchor.
    expect(edgeChipCenterX(200, 10, 60)).toBe(200);
    // The boundary: exactly room for the chip and both margins.
    expect(edgeChipCenterX(200, 76, 60)).toBe(38);
    expect(edgeChipCenterX(200, 75, 60)).toBe(200);
  });
});

describe('a handle chip under a model panel', () => {
  const stage = { left: 0, top: 0, right: 1440, bottom: 840 };
  const chip = (left: number, top: number) => ({
    left,
    top,
    right: left + 80,
    bottom: top + 22
  });
  const covered = (
    rect: ReturnType<typeof chip>,
    panel: { left: number; top: number; right: number; bottom: number }
  ) =>
    Math.min(rect.right, panel.right) > Math.max(rect.left, panel.left) &&
    Math.min(rect.bottom, panel.bottom) > Math.max(rect.top, panel.top);
  const moved = (
    rect: ReturnType<typeof chip>,
    { dx, dy }: { dx: number; dy: number }
  ) => ({
    left: rect.left + dx,
    top: rect.top + dy,
    right: rect.right + dx,
    bottom: rect.bottom + dy
  });

  it('stays put when nothing covers it', () => {
    expect(chipPanelDodge(chip(500, 300), [], stage, 1100)).toEqual({
      dx: 0,
      dy: 0
    });
    const window = { left: 700, top: 100, right: 1000, bottom: 500 };
    expect(chipPanelDodge(chip(500, 300), [window], stage, 1100)).toEqual({
      dx: 0,
      dy: 0
    });
  });

  it('comes out from under a floating window by the shortest way', () => {
    const window = { left: 480, top: 100, right: 780, bottom: 500 };
    const start = chip(500, 300);
    const dodge = chipPanelDodge(start, [window], stage, 1100);
    const after = moved(start, dodge);
    expect(covered(after, window)).toBe(false);
    // Off the window's near (left) edge, 8px clear.
    expect(after.right).toBe(472);
    expect(dodge.dy).toBe(0);
  });

  it('comes out from beside the left dock rather than under it', () => {
    const left = { left: 10, top: 60, right: 306, bottom: 734 };
    const start = chip(260, 400);
    const after = moved(start, chipPanelDodge(start, [left], stage, 1100));
    expect(covered(after, left)).toBe(false);
    expect(after.left).toBe(314);
  });

  it('never moves into the right lane while the stage has room left of it', () => {
    // A window the stage's height reaching close to the lane: past its
    // right edge the chip would sit under the lane, so it goes left.
    const window = { left: 800, top: 0, right: 1080, bottom: 840 };
    const start = chip(990, 300);
    const after = moved(start, chipPanelDodge(start, [window], stage, 1100));
    expect(covered(after, window)).toBe(false);
    expect(after.right).toBeLessThanOrEqual(1092);
    expect(after.right).toBe(792);
  });

  it('keeps a chip the lane rule left over a phone lane where it is, unless a panel covers it', () => {
    const phone = { left: 0, top: 0, right: 390, bottom: 800 };
    // The lane spans the stage: no room left of it, so the lane is no limit.
    expect(chipPanelDodge(chip(200, 300), [], phone, 10)).toEqual({
      dx: 0,
      dy: 0
    });
  });
});
