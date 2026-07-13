import { describe, expect, it } from 'vitest';
import { sketchObjectFromDrag, snapSketchPoint } from './SketchWorkspace';

describe('direct sketch drafting', () => {
  it('snaps pointer coordinates to the active millimeter grid', () => {
    expect(snapSketchPoint({ x: 4.49, y: -2.51 })).toEqual({ x: 4, y: -3 });
    expect(snapSketchPoint({ x: 4.49, y: -2.51 }, 0.5)).toEqual({
      x: 4.5,
      y: -2.5
    });
  });

  it('creates a canonical centered rectangle from a diagonal drag', () => {
    expect(
      sketchObjectFromDrag('rectangle', { x: -12, y: -6 }, { x: 12, y: 6 })
    ).toEqual({
      objectKind: 'rectangle',
      width: 24,
      height: 12,
      centerX: 0,
      centerY: 0
    });
  });

  it('uses center-to-edge gestures for circle and polygon profiles', () => {
    expect(
      sketchObjectFromDrag('circle', { x: 2, y: 3 }, { x: 5, y: 7 })
    ).toEqual({
      objectKind: 'circle',
      radius: 5,
      centerX: 2,
      centerY: 3
    });
    expect(
      sketchObjectFromDrag('polygon', { x: 0, y: 0 }, { x: 0, y: 9 })
    ).toEqual({
      objectKind: 'polygon',
      sides: 6,
      radius: 9,
      centerX: 0,
      centerY: 0
    });
  });

  it('rejects zero-size drags instead of creating invalid profiles', () => {
    expect(
      sketchObjectFromDrag('rectangle', { x: 0, y: 0 }, { x: 0, y: 20 })
    ).toBeNull();
    expect(
      sketchObjectFromDrag('circle', { x: 0, y: 0 }, { x: 0.2, y: 0.2 })
    ).toBeNull();
  });
});
