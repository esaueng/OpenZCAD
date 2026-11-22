import { describe, expect, it } from 'vitest';
import { blendDragStep, snapBlendValue } from './blendDragStep';

describe('blendDragStep', () => {
  it('steps whole millimetres at an ordinary zoom', () => {
    // A 50 mm part about 180 px across.
    expect(blendDragStep(3.6, 1)).toBe(1);
  });

  it('steps finer as the part comes closer, coarser as it goes away', () => {
    expect(blendDragStep(8, 1)).toBe(0.5);
    expect(blendDragStep(40, 1)).toBe(0.1);
    expect(blendDragStep(400, 1)).toBe(0.01);
    // Never coarser than a whole unit, however far away the part is.
    expect(blendDragStep(1, 1)).toBe(1);
    expect(blendDragStep(0.01, 1)).toBe(1);
  });

  it('picks the step in shown units', () => {
    // Inches shown on a millimetre document: 25.4 px per inch at 1 px/mm.
    expect(blendDragStep(1, 1 / 25.4)).toBe(0.5);
    expect(blendDragStep(0.2, 1 / 25.4)).toBe(1);
  });

  it('falls back to the coarsest step for a degenerate scale', () => {
    expect(blendDragStep(0, 1)).toBe(1);
    expect(blendDragStep(Number.NaN, 1)).toBe(1);
  });
});

describe('snapBlendValue', () => {
  it('rounds to the step without binary noise', () => {
    expect(snapBlendValue(7.4, 1, 1)).toBe(7);
    expect(snapBlendValue(0.29, 0.1, 1)).toBe(0.3);
    expect(snapBlendValue(2.6, 0.5, 1)).toBe(2.5);
  });

  it('snaps in shown units and returns document units', () => {
    // 0.5 in steps on a millimetre document.
    expect(snapBlendValue(14, 0.5, 1 / 25.4)).toBeCloseTo(12.7, 9);
  });

  it('never snaps a positive value to zero, which would remove a fillet', () => {
    // 6 mm on a half-inch step rounds to 0 in; it keeps hundredths instead.
    expect(snapBlendValue(6, 0.5, 1 / 25.4)).toBe(6);
    expect(snapBlendValue(0.4, 1, 1)).toBe(0.4);
    // Only a drag that reaches zero itself rounds to none.
    expect(snapBlendValue(0, 1, 1)).toBe(0);
    expect(snapBlendValue(0.004, 1, 1)).toBe(0);
  });
});
