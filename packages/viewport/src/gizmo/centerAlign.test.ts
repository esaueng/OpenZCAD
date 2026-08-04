import { describe, expect, it } from 'vitest';
import { alignTranslationToCenters, centerAlignLabel } from './centerAlign';

const CENTER = { x: 0, y: 0, z: 0 };
const face = (x: number, y: number, z: number, label = 'Box Body') => ({
  point: { x, y, z },
  label
});

describe('alignTranslationToCenters', () => {
  it('latches one axis while the others keep following the drag', () => {
    const result = alignTranslationToCenters(
      CENTER,
      { x: 9.7, y: 4.2, z: 0 },
      [face(10, 30, 0)],
      ['x', 'y'],
      0.5
    );
    // X is within threshold of the face center and snaps exactly; Y is 25.8
    // away and must not be dragged toward it.
    expect(result.translation).toEqual({ x: 10, y: 4.2, z: 0 });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ axis: 'x' });
  });

  it('centers on both axes when the drag is near both', () => {
    const result = alignTranslationToCenters(
      CENTER,
      { x: 9.8, y: 30.3, z: 0 },
      [face(10, 30, 0)],
      ['x', 'y'],
      0.5
    );
    expect(result.translation).toEqual({ x: 10, y: 30, z: 0 });
    expect(result.matches.map((match) => match.axis)).toEqual(['x', 'y']);
  });

  it('accounts for the moving body not starting at the origin', () => {
    // Resting center 5: to align with a face at 10 the translation is 5,
    // not 10 — the snap is about where the body ends up, not the delta.
    const result = alignTranslationToCenters(
      { x: 5, y: 0, z: 0 },
      { x: 4.8, y: 0, z: 0 },
      [face(10, 0, 0)],
      ['x'],
      0.5
    );
    expect(result.translation.x).toBe(5);
  });

  it('picks the nearest target per axis, and they may differ', () => {
    const result = alignTranslationToCenters(
      CENTER,
      { x: 10.1, y: 20.2, z: 0 },
      [face(10, 90, 0, 'A'), face(70, 20, 0, 'B')],
      ['x', 'y'],
      0.5
    );
    expect(result.translation).toEqual({ x: 10, y: 20, z: 0 });
    expect(result.matches.map((match) => match.target.label)).toEqual([
      'A',
      'B'
    ]);
  });

  it('does nothing outside the threshold or with no targets', () => {
    const untouched = { x: 3, y: 4, z: 5 };
    expect(
      alignTranslationToCenters(CENTER, untouched, [face(10, 10, 10)], ['x'], 0.5)
        .translation
    ).toEqual(untouched);
    expect(
      alignTranslationToCenters(CENTER, untouched, [], ['x', 'y', 'z'], 0.5)
        .matches
    ).toEqual([]);
  });
});

describe('centerAlignLabel', () => {
  it('names the target and the latched axes', () => {
    expect(
      centerAlignLabel([
        { axis: 'x', target: face(0, 0, 0) },
        { axis: 'y', target: face(0, 0, 0) }
      ])
    ).toBe('Box Body ⋅ centered X·Y');
  });
});
