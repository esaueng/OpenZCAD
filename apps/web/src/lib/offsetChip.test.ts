import { describe, expect, it } from 'vitest';
import { formatDocumentHundredths } from './displayUnits';
import {
  chipPanelDodge,
  edgeChipCenterX,
  faceOffsetChipState,
  keptOffsetValue,
  laneLeavesRoom,
  offsetChipTag,
  offsetChipText,
  offsetFaceCommitMessage,
  offsetLimitChipText,
  offsetLimitInUnits,
  offsetRefusalInTotal,
  offsetTotalReading,
  pinChipPairStart,
  rearmedChipMode,
  regionChipState,
  continuesOffsetFace,
  valueInsideLimit,
  type OffsetChipState
} from './offsetChip';

describe('offset chip', () => {
  // Owner decision 2026-11-14, after QA finding #9: a face offset starts on
  // the signed move, so a typed 5 moves the face 5. Total stays one switch
  // away wherever there is a span to read.
  it('starts every face on the signed offset, offering Total where a span is known', () => {
    expect(faceOffsetChipState(20, 10)).toEqual({
      mode: 'offset',
      extent: 10,
      totalAvailable: true
    });
    // A face that is not a primitive's own still reads the span to the plane
    // opposite it, so Total is offered there too.
    expect(faceOffsetChipState(undefined, 10)).toEqual({
      mode: 'offset',
      extent: 10,
      totalAvailable: true
    });
    expect(faceOffsetChipState(20, null)).toEqual({
      mode: 'offset',
      extent: null,
      totalAvailable: true
    });
    expect(faceOffsetChipState(undefined, null)).toEqual({
      mode: 'offset',
      extent: null,
      totalAvailable: false
    });
  });

  it('reads a typed 5 on a 24 mm top face as a 5 mm move, not a 5 mm total', () => {
    // QA 2026-11-14 finding #9: the Total default turned 5 into a −19 move.
    const state = faceOffsetChipState(24, null);
    expect(
      offsetChipText({
        rawValue: 5,
        mode: state.mode,
        span: 24,
        sense: 1,
        units: 'mm'
      })
    ).toBe('+5 mm');
    expect(
      offsetTotalReading({ rawValue: 5, mode: state.mode, span: 24, sense: 1 })
    ).toBeNull();
  });

  it('reads the switch on the face it was made on, and the default elsewhere', () => {
    // The defect: opening exact entry re-derives the handle, and the re-armed
    // rig reset a switched mode back to the default under an open keypad.
    const fresh = faceOffsetChipState(undefined, 17);
    expect(rearmedChipMode(fresh, 'offset', true)).toBe('offset');
    expect(rearmedChipMode(fresh, 'total', true)).toBe('total');
    // Another face starts from its own default, whatever was chosen.
    expect(rearmedChipMode(fresh, 'total', false)).toBe('offset');
    // A primitive's own dimension is a span to keep Total for, too.
    expect(rearmedChipMode(faceOffsetChipState(24, null), 'total', true)).toBe(
      'total'
    );
    // Nothing to read Total from (the analysis catching up): the change. The
    // choice is not consumed, so the next re-arm with a span reads it again.
    expect(
      rearmedChipMode(faceOffsetChipState(undefined, null), 'total', true)
    ).toBe('offset');
  });

  describe('which face a Total switch belongs to', () => {
    const up = { x: 0, y: 0, z: 1 };
    // The shoulder fixture: a 26 mm shoulder and, above it, a 35 mm cap of
    // the same body, both facing up.
    const shoulder = {
      bodyId: 'body-1',
      topologyId: 'face:7',
      point: { x: 20, y: 14, z: 26 },
      normal: up
    };

    it('keeps it on the same face, wherever on it the pick lands', () => {
      expect(continuesOffsetFace(shoulder, shoulder)).toBe(true);
      expect(
        continuesOffsetFace(shoulder, {
          ...shoulder,
          point: { x: 3, y: -8, z: 26 }
        })
      ).toBe(true);
    });

    it('does not carry it to another face that faces the same way', () => {
      // Review of #1533: the 26 mm shoulder switched to Total, then the
      // separate 35 mm cap read "Total 35 mm", so a typed 5 moved it −30.
      expect(
        continuesOffsetFace(shoulder, {
          ...shoulder,
          topologyId: 'face:9',
          point: { x: 0, y: 0, z: 35 }
        })
      ).toBe(false);
      // Two coplanar, disconnected faces of one part (the tops of a U's arms).
      expect(
        continuesOffsetFace(shoulder, {
          ...shoulder,
          topologyId: 'face:11',
          point: { x: -20, y: 14, z: 26 }
        })
      ).toBe(false);
      // Facing another way, or on another body.
      expect(
        continuesOffsetFace(shoulder, {
          ...shoulder,
          normal: { x: 0, y: 0, z: -1 }
        })
      ).toBe(false);
      expect(
        continuesOffsetFace(shoulder, { ...shoulder, bodyId: 'body-2' })
      ).toBe(false);
    });

    it('does not trust a face id the topology handed to another face', () => {
      expect(
        continuesOffsetFace(shoulder, {
          ...shoulder,
          point: { x: 20, y: 14, z: 35 }
        })
      ).toBe(false);
    });

    it('follows the face only where the commit says it moved it', () => {
      const moved = {
        ...shoulder,
        topologyId: 'face:12',
        point: { x: 20, y: 14, z: 31 }
      };
      expect(
        continuesOffsetFace(shoulder, { ...moved, movedFrom: 'face:7' })
      ).toBe(true);
      // Without the commit's word, a renumbered face on a new plane is not it.
      expect(continuesOffsetFace(shoulder, moved)).toBe(false);
      // Another face the commit moved is not this one either.
      expect(
        continuesOffsetFace(shoulder, { ...moved, movedFrom: 'face:9' })
      ).toBe(false);
    });

    it('keeps it on the moved face once the switch has followed it there', () => {
      // Review of #1533: after the commit the switch belongs to the moved
      // face, whose target still names the face it came from; reopening
      // entry and cancelling re-armed it and the chip fell back to Offset.
      const moved = {
        ...shoulder,
        topologyId: 'face:12',
        point: { x: 20, y: 14, z: 27 }
      };
      expect(
        continuesOffsetFace(moved, { ...moved, movedFrom: 'face:7' })
      ).toBe(true);
      // Still not another face, nor the moved id on another plane.
      expect(
        continuesOffsetFace(moved, {
          ...moved,
          topologyId: 'face:9',
          point: { x: 0, y: 0, z: 35 },
          movedFrom: 'face:7'
        })
      ).toBe(false);
      expect(
        continuesOffsetFace(moved, {
          ...moved,
          point: { x: 20, y: 14, z: 35 },
          movedFrom: 'face:7'
        })
      ).toBe(false);
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
    const stale: OffsetChipState = {
      ...faceOffsetChipState(20, 10),
      mode: 'total'
    };
    const region = regionChipState();
    expect(region).toEqual({
      mode: 'offset',
      extent: null,
      totalAvailable: false
    });
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

  /** The canvas's rect as the viewer reads it: sides are getters. */
  class StageRect {
    constructor(
      private readonly x: number,
      private readonly y: number,
      private readonly w: number,
      private readonly h: number
    ) {}
    get left() {
      return this.x;
    }
    get top() {
      return this.y;
    }
    get right() {
      return this.x + this.w;
    }
    get bottom() {
      return this.y + this.h;
    }
  }

  it('keeps a phone pair on the stage given a DOMRect-like stage', () => {
    // The offset pair clamped to a phone's left edge, under Objects: a
    // spread of the canvas's DOMRect lost its left side, and the pair was
    // dodged off the stage (Offset ▾ at x −79).
    const phone = new StageRect(0, 0, 390, 844);
    const objects = { left: 60, top: 406, right: 330, bottom: 635 };
    const pair = { left: 4, top: 519, right: 135, bottom: 547 };
    const after = moved(pair, chipPanelDodge(pair, [objects], phone, 60));
    expect(after.left).toBeGreaterThanOrEqual(0);
    expect(after.right).toBeLessThanOrEqual(390);
    expect(covered(after, objects)).toBe(false);
  });

  it('never dodges below the foot a pill is clamped above', () => {
    // Below the folded guide is under the floor `place` holds the pills
    // above: clamped back, the next frame measured from the wrong start and
    // the pair swung above Objects and back every frame.
    const phone = new StageRect(0, 0, 390, 844);
    const panels = [
      { left: 10, top: 244, right: 50, bottom: 702 },
      { left: 60, top: 596, right: 330, bottom: 664 },
      { left: 60, top: 357, right: 330, bottom: 586 }
    ];
    const pair = { left: 4, top: 519, right: 135, bottom: 547 };
    const after = moved(
      pair,
      chipPanelDodge(pair, panels, phone, 60, null, 675)
    );
    expect(after.bottom).toBeLessThanOrEqual(675);
    expect(after.left).toBeGreaterThanOrEqual(0);
    for (const panel of panels) expect(covered(after, panel)).toBe(false);
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

  it('never offers to keep the value that was just refused (#1596)', () => {
    // The live preview built 16.5 but release validation refused it.
    expect(keptOffsetValue(undefined, 16.5, 16.5)).toBeNull();
    expect(keptOffsetValue(undefined, 16.5, 16.500000000000004)).toBeNull();
    // An earlier frame that built is still a way out.
    expect(keptOffsetValue(undefined, 15, 16.5)).toBe(15);
    // A limit-derived value that lands on the refused value is no way out.
    expect(keptOffsetValue(-6.4, null, -6.39)).toBeNull();
    expect(keptOffsetValue(-6.4, -5, -9)).toBe(-6.39);
    // The preview built −9 but release refused it at a −6.4 limit: the
    // limit still offers −6.39 rather than nothing.
    expect(keptOffsetValue(-6.4, -9, -9)).toBe(-6.39);
    // Nothing refused yet: unchanged.
    expect(keptOffsetValue(undefined, 16.5, null)).toBe(16.5);
  });
});

// U11: a Total typed into exact entry is refused in Totals, not in the
// offset the kernel measured: "smaller offset" beside a Total of 5 asked for
// the opposite of what builds.
describe('a refused face offset read as a Total', () => {
  const mmLength = (value: number) =>
    formatDocumentHundredths({ units: 'mm' }, value);
  const reading = { baseline: 24, sense: 1, formatLength: mmLength };
  const collapse = {
    message:
      'A neighbouring face would shrink to nothing past -19. Try a smaller offset.',
    limit: -19
  };

  it('states the limit, the remedy and Keep as Totals', () => {
    const read = offsetRefusalInTotal(collapse, -18.99, reading);
    expect(read.error.headline).toBe('Total can’t go below 5 mm here');
    expect(read.error.message).toBe(
      'A neighbouring face would shrink to nothing once the face moves 19 mm (a Total of 5 mm). Try a larger Total.'
    );
    expect(read.keepLabel).toBe('Keep Total 5.01 mm');
    expect(read.error.limit).toBe(-19);
  });

  it('reads the limit sentence once the workspace has given it its unit', () => {
    const shown = offsetLimitInUnits(collapse, mmLength);
    expect(shown.message).toBe(
      'A neighbouring face would shrink to nothing past -19 mm. Try a smaller offset.'
    );
    expect(offsetRefusalInTotal(shown, -18.99, reading).error.message).toBe(
      'A neighbouring face would shrink to nothing once the face moves 19 mm (a Total of 5 mm). Try a larger Total.'
    );
  });

  it('asks for a smaller Total when the face moves out, or the span shrinks as it grows', () => {
    const out = offsetRefusalInTotal(
      { ...collapse, message: collapse.message, limit: 6.4 },
      6.39,
      reading
    );
    expect(out.error.headline).toBe('Total can’t go past 30.4 mm here');
    expect(out.error.message).toMatch(/Try a smaller Total\.$/);
    // A face whose outward move shrinks the span (the bottom of a plate).
    const under = offsetRefusalInTotal(collapse, null, {
      ...reading,
      sense: -1
    });
    expect(under.error.headline).toBe('Total can’t go past 43 mm here');
    expect(under.keepLabel).toBeNull();
  });

  it('states Totals, the move and Keep in the display unit', () => {
    // Stored in millimetres, shown in inches: 5 mm is 0.1969 in.
    const inches = offsetRefusalInTotal(collapse, -18.99, {
      baseline: 24,
      sense: 1,
      formatLength: (value) =>
        formatDocumentHundredths({ units: 'mm', displayUnits: 'inch' }, value)
    });
    expect(inches.error.headline).toBe('Total can’t go below 0.1969 in here');
    expect(inches.error.message).toBe(
      'A neighbouring face would shrink to nothing once the face moves 0.748 in (a Total of 0.1969 in). Try a larger Total.'
    );
    expect(inches.keepLabel).toBe('Keep Total 0.1972 in');
  });

  it('has the chip state the limit as the keypad does, in inches', () => {
    // The collapse block's Front face, stored in millimetres and shown in
    // inches: the keypad says "below 0.6929 in" (17.6 mm), and the chip
    // beside it read "min 0.693 in" from three significant figures.
    const scale = 1 / 25.4;
    const limit = -6.400000000000002;
    const keypad = offsetRefusalInTotal(
      {
        message:
          'A neighbouring face would shrink to nothing past -6.4. Try a smaller offset.',
        limit
      },
      -6.39,
      {
        baseline: 24,
        sense: 1,
        formatLength: (value) =>
          formatDocumentHundredths({ units: 'mm', displayUnits: 'inch' }, value)
      }
    );
    expect(keypad.error.headline).toBe('Total can’t go below 0.6929 in here');
    const chip = {
      limit: limit * scale,
      sense: 1,
      units: 'in',
      precise: true,
      scale
    };
    expect(
      offsetLimitChipText({ ...chip, mode: 'total', span: 24 * scale })
    ).toBe('min 0.6929 in');
    // How far the face can move: 6.4 mm, as the keypad's "moves 0.252 in"
    // resolves it.
    expect(offsetLimitChipText({ ...chip, mode: 'offset', span: null })).toBe(
      `max ${formatDocumentHundredths({ units: 'mm', displayUnits: 'inch' }, 6.4)}`
    );
    // Shown in its own unit the chip keeps its hundredths.
    expect(
      offsetLimitChipText({
        limit,
        sense: 1,
        units: 'mm',
        mode: 'total',
        span: 24,
        scale: 1
      })
    ).toBe('min 17.6 mm');
  });

  it('keeps the bound and Keep apart in metres (the chip reads min 0.0176 m)', () => {
    const metres = offsetRefusalInTotal(
      {
        message:
          'A neighbouring face would shrink to nothing past -6.4. Try a smaller offset.',
        limit: -6.4
      },
      -6.39,
      {
        baseline: 24,
        sense: 1,
        formatLength: (value) =>
          formatDocumentHundredths({ units: 'mm', displayUnits: 'm' }, value)
      }
    );
    expect(metres.error.headline).toBe('Total can’t go below 0.0176 m here');
    expect(metres.keepLabel).toBe('Keep Total 0.01761 m');
    expect(metres.error.message).toBe(
      'A neighbouring face would shrink to nothing once the face moves 0.0064 m (a Total of 0.0176 m). Try a larger Total.'
    );
  });

  it('points a refusal with no named limit back toward the size before the edit', () => {
    const read = offsetRefusalInTotal(
      {
        message:
          'A neighbouring face would shrink to nothing at this distance. Try a smaller offset.'
      },
      null,
      reading
    );
    expect(read.error.headline).toBeUndefined();
    expect(read.error.message).toBe(
      'A neighbouring face would shrink to nothing at this distance. Try a Total nearer 24 mm.'
    );
  });
});

// Browser check (beta): offset-limit sentences named a bare, unsigned number
// ("past 6.4") beside a signed "Keep −6.39 mm". They state the limit signed
// like the offset, in the document's display unit.
describe('an offset-limit sentence in units', () => {
  const mm = (value: number) =>
    formatDocumentHundredths({ units: 'mm' }, value);

  it('states the typed limit, signed, with the unit', () => {
    expect(
      offsetLimitInUnits(
        {
          message:
            'A neighbouring face would shrink to nothing past -6.4. Try a smaller offset.',
          limit: -6.400000000000002,
          detail: 'kernel words'
        },
        mm
      )
    ).toEqual({
      message:
        'A neighbouring face would shrink to nothing past -6.4 mm. Try a smaller offset.',
      limit: -6.400000000000002,
      detail: 'kernel words'
    });
    expect(
      offsetLimitInUnits(
        {
          message:
            "This face's chamfered or drafted edge can't move with it past -0.5. Try a smaller offset.",
          limit: -0.5
        },
        mm
      ).message
    ).toBe(
      "This face's chamfered or drafted edge can't move with it past -0.5 mm. Try a smaller offset."
    );
  });

  it('rounds the limit once, in the unit it is shown in', () => {
    const sentence = (limit: number) => ({
      message: `A neighbouring face would shrink to nothing past ${limit}. Try a smaller offset.`,
      limit
    });
    const inToMm = (value: number) =>
      formatDocumentHundredths({ units: 'inch', displayUnits: 'mm' }, value);
    // -0.2519685 in is -6.4 mm; rounded to hundredths first it read -6.35.
    expect(offsetLimitInUnits(sentence(-0.2519685), inToMm).message).toBe(
      'A neighbouring face would shrink to nothing past -6.4 mm. Try a smaller offset.'
    );
    // A small limit keeps its direction rather than rounding to 0.
    expect(offsetLimitInUnits(sentence(-0.004), inToMm).message).toBe(
      'A neighbouring face would shrink to nothing past -0.1 mm. Try a smaller offset.'
    );
  });

  it('signs an older unsigned sentence from the typed limit, outward too', () => {
    expect(
      offsetLimitInUnits(
        {
          message:
            'A neighbouring face would shrink to nothing past 6.4. Try a smaller offset.',
          limit: -6.4
        },
        mm
      ).message
    ).toBe(
      'A neighbouring face would shrink to nothing past -6.4 mm. Try a smaller offset.'
    );
    expect(
      offsetLimitInUnits(
        {
          message:
            'A neighbouring face would shrink to nothing past 2.5. Try a smaller offset.',
          limit: 2.5
        },
        mm
      ).message
    ).toBe(
      'A neighbouring face would shrink to nothing past 2.5 mm. Try a smaller offset.'
    );
  });

  it('uses the display unit the formatter writes, and the sentence alone without a limit', () => {
    const inches = (value: number) =>
      `${Math.round((value / 25.4) * 1000) / 1000} in`;
    expect(
      offsetLimitInUnits(
        {
          message:
            'A neighbouring face would shrink to nothing past -6.4. Try a smaller offset.'
        },
        inches
      ).message
    ).toBe(
      'A neighbouring face would shrink to nothing past -0.252 in. Try a smaller offset.'
    );
  });

  it('leaves every other refusal, and a sentence with no limit, alone', () => {
    const plain = {
      message:
        'A neighbouring face would shrink to nothing at this distance. Try a smaller offset.',
      limit: -6.4
    };
    expect(offsetLimitInUnits(plain, mm)).toBe(plain);
    const other = {
      message: 'The blend does not fit here. Try a smaller size.'
    };
    expect(offsetLimitInUnits(other, mm)).toBe(other);
  });
});

// Browser check (beta): at 390 × 844 with the Objects panel open, the face
// offset's "Offset ▾" tag and value were placed off the stage's left edge:
// the lane rule clamped the pair to the lane's left edge, which on a phone
// is the stage's own left inset.
describe('a pin chip pair', () => {
  const pair = { width: 130, clearance: 22, stageWidth: 390 };

  it('keeps the lane rule only while the lane leaves room for the chip', () => {
    expect(laneLeavesRoom(null, 72)).toBe(false);
    expect(laneLeavesRoom(62, 72)).toBe(false);
    expect(laneLeavesRoom(88, 72)).toBe(true);
    expect(laneLeavesRoom(900, 130)).toBe(true);
  });

  it('stays on the stage when the lane spans a phone', () => {
    // Objects open at 390px: the lane starts 62 px in.
    const start = pinChipPairStart({
      ...pair,
      anchorX: 244,
      pinX: 200,
      laneLeft: 62
    });
    expect(start).toBeGreaterThanOrEqual(8);
    expect(start + pair.width).toBeLessThanOrEqual(390 - 8);
    // Beside the pin as on a wide stage: nothing pushed it.
    expect(start).toBe(222);
  });

  it('never starts off the left edge when neither side of the pin has room', () => {
    // The right rail at 340 leaves room, but not right of a pin at 100 or
    // left of it: the pair stands at the lane edge, over the pin, rather
    // than off the stage or under the tool column.
    const start = pinChipPairStart({
      ...pair,
      width: 229,
      anchorX: 144,
      pinX: 100,
      laneLeft: 340
    });
    expect(start).toBe(340 - 8 - 229);
  });

  it("still swaps to the pin's other side clear of a desktop lane", () => {
    const start = pinChipPairStart({
      anchorX: 944,
      pinX: 900,
      width: 130,
      clearance: 22,
      laneLeft: 960,
      stageWidth: 1280
    });
    expect(start).toBe(900 - 22 - 130);
    // Room right of the pin: it reads there.
    expect(
      pinChipPairStart({
        anchorX: 544,
        pinX: 500,
        width: 130,
        clearance: 22,
        laneLeft: 960,
        stageWidth: 1280
      })
    ).toBe(522);
  });
});

// Beta recording, 2026-11: one body's Front face read "Offset ▾ | +0 mm"
// while its Right face, which has no flat face opposite it, read a bare
// "+0 mm" in the same tool.
describe('the offset chip tag', () => {
  it('names Offset on a face with no span to read, without a switch', () => {
    const tag = offsetChipTag('offset', false);
    expect(tag.text).toBe('Offset');
    expect(tag.switchable).toBe(false);
    expect(tag.title).toMatch(
      /^Offset: a typed value is how far the face moves/
    );
    expect(tag.title).toMatch(/no Total/);
  });

  it('names the mode on every face, switchable only with a span', () => {
    for (const spanKnown of [true, false]) {
      expect(offsetChipTag('offset', spanKnown).text).toMatch(/^Offset/);
    }
    expect(offsetChipTag('offset', true)).toMatchObject({
      text: 'Offset ▾',
      switchable: true
    });
    expect(offsetChipTag('total', true)).toMatchObject({
      text: 'Total ▾',
      switchable: true
    });
  });

  it('never reads Total where there is no span', () => {
    // A re-armed face falls back to Offset when its span is gone
    // (`rearmedChipMode`); the tag cannot claim Total meanwhile.
    expect(offsetChipTag('total', false).text).toBe('Offset');
  });
});
