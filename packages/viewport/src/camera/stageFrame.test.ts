import { describe, expect, it } from 'vitest';
import { clearStageFrame, STAGE_FRAME_GAP_PX } from './stageFrame';

const canvas = { left: 0, top: 0, right: 1024, bottom: 768 };
const ndcX = (px: number) => (px / 1024) * 2 - 1;

describe('clearStageFrame', () => {
  it('frames the whole canvas when nothing floats over it', () => {
    expect(clearStageFrame(canvas, [])).toBeUndefined();
  });

  it('stops short of an open drawer and the rail on the right', () => {
    const drawer = { left: 664, top: 60, right: 960, bottom: 660 };
    const rail = { left: 972, top: 60, right: 1012, bottom: 400 };
    const frame = clearStageFrame(canvas, [drawer, rail]);
    expect(frame).toEqual({
      minX: -1,
      maxX: ndcX(664 - STAGE_FRAME_GAP_PX),
      minY: -1,
      maxY: 1
    });
  });

  it('starts past the left column and the tool palette', () => {
    const column = { left: 12, top: 60, right: 272, bottom: 700 };
    const palette = { left: 284, top: 200, right: 324, bottom: 520 };
    const drawer = { left: 700, top: 60, right: 1000, bottom: 660 };
    const frame = clearStageFrame(canvas, [column, palette, drawer]);
    expect(frame?.minX).toBeCloseTo(ndcX(324 + STAGE_FRAME_GAP_PX), 12);
    expect(frame?.maxX).toBeCloseTo(ndcX(700 - STAGE_FRAME_GAP_PX), 12);
  });

  it('reads panels relative to a canvas that is not at the page origin', () => {
    const offset = { left: 100, top: 50, right: 1124, bottom: 818 };
    const drawer = { left: 764, top: 110, right: 1060, bottom: 710 };
    expect(clearStageFrame(offset, [drawer])?.maxX).toBeCloseTo(
      ndcX(664 - STAGE_FRAME_GAP_PX),
      12
    );
  });

  it('ignores empty, off-canvas and stage-spanning panels', () => {
    const closing = { left: 700, top: 60, right: 700, bottom: 60 };
    const offscreen = { left: 1100, top: 0, right: 1300, bottom: 768 };
    // A phone's lane spans the stage: a sheet, not a side panel.
    const sheet = { left: 12, top: 400, right: 1012, bottom: 760 };
    expect(clearStageFrame(canvas, [closing, offscreen, sheet])).toBe(
      undefined
    );
  });

  it('gives up on a band too narrow to be worth framing into', () => {
    const column = { left: 0, top: 0, right: 400, bottom: 768 };
    const drawer = { left: 620, top: 0, right: 1024, bottom: 768 };
    expect(clearStageFrame(canvas, [column, drawer])).toBeUndefined();
  });

  it('refuses a canvas with no area', () => {
    expect(
      clearStageFrame({ left: 0, top: 0, right: 0, bottom: 0 }, [])
    ).toBeUndefined();
  });
});
