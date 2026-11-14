import { describe, expect, it } from 'vitest';
import {
  chipPanelDodge,
  edgeChipCenterX,
  faceOffsetChipState,
  keptOffsetValue,
  offsetChipText,
  offsetFaceCommitMessage,
  offsetLimitChipText,
  offsetTotalReading,
  rearmedChipMode,
  regionChipState,
  valueInsideLimit
} from './offsetChip';

describe('offset chip', () => {
  it('reads any face with a span as its total, and only a spanless one as the change', () => {
    expect(faceOffsetChipState(20, 10)).toEqual({ mode: 'total', extent: 10 });
    // A face that is not a primitive's own still reads the span to the plane
    // opposite it: Total is the default, not just a primitive resize's.
    expect(faceOffsetChipState(undefined, 10)).toEqual({
      mode: 'total',
      extent: 10
    });
    expect(faceOffsetChipState(20, null)).toEqual({
      mode: 'total',
      extent: null
    });
    expect(faceOffsetChipState(undefined, null)).toEqual({
      mode: 'offset',
      extent: null
    });
  });

  it('keeps the chosen reading while the same face re-arms', () => {
    // The defect: opening exact entry re-derives the handle, and the re-armed
    // rig reset a switched-to Offset back to Total under an Offset keypad.
    const fresh = faceOffsetChipState(undefined, 17);
    expect(rearmedChipMode(fresh, 'offset', true)).toBe('offset');
    expect(rearmedChipMode(fresh, 'total', true)).toBe('total');
    // Another face starts from its own default.
    expect(rearmedChipMode(fresh, 'offset', false)).toBe('total');
    // Nothing to read Total from: the change, whatever was chosen.
    expect(
      rearmedChipMode(faceOffsetChipState(undefined, null), 'total', true)
    ).toBe('offset');
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

  it('names the Total read at release beside the change history records', () => {
    // The defect: the chip read "Total 15.65 mm" through the drag, and the
    // history row then said "+10.25 mm" with nothing tying the two together.
    const total = offsetTotalReading({
      rawValue: 10.25,
      mode: 'total',
      span: 5.4,
      sense: 1
    });
    expect(total).toBe(15.65);
    expect(offsetFaceCommitMessage(10.25, 'mm', total)).toBe(
      'Offset face by +10.25 mm · Total 15.65 mm.'
    );
    // Released from the Offset reading, or with no span, only the change.
    expect(
      offsetTotalReading({
        rawValue: 10.25,
        mode: 'offset',
        span: 5.4,
        sense: 1
      })
    ).toBeNull();
    expect(
      offsetTotalReading({
        rawValue: 10.25,
        mode: 'total',
        span: undefined,
        sense: 1
      })
    ).toBeNull();
    expect(offsetFaceCommitMessage(-2.004, 'in')).toBe('Offset face by -2 in.');
    // A shrinking sense subtracts: the Total the chip shows, not span + 2.
    expect(
      offsetTotalReading({ rawValue: 2, mode: 'total', span: 10, sense: -1 })
    ).toBe(8);
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

  it('never moves up under the top bar', () => {
    // A wide window just below the top bar, the chip near its top edge:
    // the shortest way out is up, into the bar's band.
    const window = { left: 300, top: 70, right: 1000, bottom: 600 };
    const start = chip(600, 74);
    expect(chipPanelDodge(start, [window], stage, 1100).dy).toBeLessThan(0);
    const after = moved(
      start,
      chipPanelDodge(start, [window], stage, 1100, 56)
    );
    expect(covered(after, window)).toBe(false);
    expect(after.top).toBeGreaterThanOrEqual(56);
  });

  it('keeps a chip the lane rule left over a phone lane where it is, unless a panel covers it', () => {
    const phone = { left: 0, top: 0, right: 390, bottom: 800 };
    // The lane spans the stage: no room left of it, so the lane is no limit.
    expect(chipPanelDodge(chip(200, 300), [], phone, 10)).toEqual({
      dx: 0,
      dy: 0
    });
  });

  it('lifts an active value above a lower phone sheet', () => {
    const phone = { left: 0, top: 0, right: 390, bottom: 844 };
    const sheet = { left: 10, top: 410, right: 380, bottom: 750 };
    const start = chip(200, 500);
    const after = moved(start, chipPanelDodge(start, [sheet], phone, 10, 102));
    expect(covered(after, sheet)).toBe(false);
    expect(after.bottom).toBeLessThanOrEqual(402);
    expect(after.top).toBeGreaterThanOrEqual(102);
  });
});

describe('a refused offset that names its limit', () => {
  // The Front face of a block whose Right face keeps a 6.4 flat between two
  // r8.8 rounds: pushing it in past 6.4 collapses that flat.
  it('reads how far the face can move, or the span it cannot pass', () => {
    const base = { limit: -6.400000000000002, sense: 1, units: 'mm' };
    expect(offsetLimitChipText({ ...base, mode: 'offset', span: 24 })).toBe(
      'max 6.4 mm'
    );
    expect(offsetLimitChipText({ ...base, mode: 'total', span: 24 })).toBe(
      'min 17.6 mm'
    );
    // A total with no span to read falls back to the distance.
    expect(offsetLimitChipText({ ...base, mode: 'total', span: null })).toBe(
      'max 6.4 mm'
    );
    // A pull that grows the span is capped from above.
    expect(
      offsetLimitChipText({ ...base, limit: 3, mode: 'total', span: 10 })
    ).toBe('max 13 mm');
  });

  it('offers the nearest hundredth inside the limit, on its side of zero', () => {
    expect(valueInsideLimit(-6.400000000000002)).toBe(-6.39);
    expect(valueInsideLimit(6.4)).toBe(6.39);
    expect(valueInsideLimit(6.405)).toBe(6.39);
    expect(valueInsideLimit(0.01)).toBeNull();
    expect(valueInsideLimit(Number.NaN)).toBeNull();
  });

  it('keeps the value inside the limit rather than an earlier frame', () => {
    // Released at −9 after the last built frame at −5: Keep offers −6.39.
    expect(keptOffsetValue(-6.400000000000002, -5)).toBe(-6.39);
    // Nothing built during the drag: the limit still offers a way out.
    expect(keptOffsetValue(-6.4, null)).toBe(-6.39);
    // A built frame at least as far on the same side is proven: keep it.
    expect(keptOffsetValue(-6.4, -6.395)).toBe(-6.395);
    // No limit: the last frame that built, as before.
    expect(keptOffsetValue(undefined, -5)).toBe(-5);
    expect(keptOffsetValue(undefined, null)).toBeNull();
  });
});
