import { describe, expect, it } from 'vitest';
import {
  moveHasFiniteValues,
  moveHasUnappliedChange,
  movingSketchId,
  sketchViewShown
} from './moveCard';

const zero = { x: 0, y: 0, z: 0 };

describe('Move confirmation values', () => {
  it.each([NaN, Infinity, -Infinity])(
    'refuses %s in every consumed coordinate',
    (value) => {
      for (const axis of ['x', 'y', 'z'] as const) {
        const translation = { ...zero, [axis]: value };
        const rotationDeg = { ...zero, [axis]: value };
        expect(moveHasFiniteValues({ translation, rotationDeg: zero })).toBe(
          false
        );
        expect(
          moveHasFiniteValues({
            translation,
            rotationDeg: zero,
            target: 'sketch'
          })
        ).toBe(false);
        expect(moveHasFiniteValues({ translation: zero, rotationDeg })).toBe(
          false
        );
        expect(
          moveHasFiniteValues({
            translation: zero,
            rotationDeg,
            target: 'sketch'
          })
        ).toBe(true);
      }
    }
  );

  it('accepts zero and finite signed translations and rotations', () => {
    expect(moveHasFiniteValues({ translation: zero, rotationDeg: zero })).toBe(
      true
    );
    expect(
      moveHasFiniteValues({
        translation: { x: -5, y: 0.2, z: 7 },
        rotationDeg: { x: 30, y: -90, z: 180 }
      })
    ).toBe(true);
  });
});

describe('moveHasUnappliedChange', () => {
  it('is false with no Move card, or one still at zero', () => {
    expect(moveHasUnappliedChange(null)).toBe(false);
    expect(
      moveHasUnappliedChange({ translation: zero, rotationDeg: zero })
    ).toBe(false);
  });

  it('is true for any translation or rotation not yet applied', () => {
    expect(
      moveHasUnappliedChange({
        translation: { ...zero, x: 60 },
        rotationDeg: zero
      })
    ).toBe(true);
    expect(
      moveHasUnappliedChange({
        translation: zero,
        rotationDeg: { ...zero, z: -15 }
      })
    ).toBe(true);
  });
});

describe('movingSketchId / sketchViewShown', () => {
  const sketchMove = {
    bodyId: 'sketch_profile',
    target: 'sketch' as const
  };

  it('names the sketch only for a sketch Move', () => {
    expect(movingSketchId(null)).toBeNull();
    expect(movingSketchId({ bodyId: 'body_plate' })).toBeNull();
    expect(movingSketchId(sketchMove)).toBe('sketch_profile');
  });

  it('shows a hidden (consumed) sketch while a Move carries it', () => {
    const hidden = new Set(['sketch_profile', 'sketch_other']);
    const moving = movingSketchId(sketchMove);
    expect(sketchViewShown('sketch_profile', hidden, null)).toBe(false);
    expect(sketchViewShown('sketch_profile', hidden, moving)).toBe(true);
    expect(sketchViewShown('sketch_other', hidden, moving)).toBe(false);
    expect(sketchViewShown('sketch_visible', hidden, null)).toBe(true);
  });
});
