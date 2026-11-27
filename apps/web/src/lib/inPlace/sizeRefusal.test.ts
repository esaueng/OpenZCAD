import { describe, expect, it } from 'vitest';
import { blendRefusalText, smallerSizeIn } from './sizeRefusal';

const REFUSAL =
  'Feature "Chamfer": Chamfer could not be created on 1 selected edge with distance 8. Try a smaller distance: distance 2.5 builds here.';

describe('a blend refusal as its command bar reads it', () => {
  it('finds the size that builds, and nothing where none is named', () => {
    expect(smallerSizeIn(REFUSAL)).toEqual({
      dimension: 'distance',
      size: 2.5
    });
    expect(
      smallerSizeIn('Fillet could not be created. Try a smaller radius.')
    ).toBeNull();
  });

  it('drops the feature name and puts the unit after each size', () => {
    expect(blendRefusalText(REFUSAL, 'in')).toBe(
      'Chamfer could not be created on 1 selected edge with distance 8 in. Try a smaller distance: distance 2.5 in builds here.'
    );
    expect(blendRefusalText('Feature "Box": Box failed.', null)).toBe(
      'Box failed.'
    );
  });

  // The adapter quotes a size as JavaScript prints it, so a very small or
  // very large one is in exponent notation; the unit goes after the whole
  // number (preview check of f4c7f13 read "1 mm.5e-9").
  it.each([
    ['1.5e-9', 'distance'],
    ['2e-7', 'radius'],
    ['1e+21', 'distance'],
    ['-3.25e+2', 'radius']
  ] as const)('puts the unit after %s whole', (size, dimension) => {
    const refusal = `Feature "Blend": Blend could not be created on 1 selected edge with ${dimension} ${size}. The kernel could not build this edge with its current neighboring faces.`;
    expect(blendRefusalText(refusal, 'mm')).toBe(
      `Blend could not be created on 1 selected edge with ${dimension} ${size} mm. The kernel could not build this edge with its current neighboring faces.`
    );
  });

  it('reads and quotes an exponent size that builds', () => {
    const refusal =
      'Fillet could not be created on 1 selected edge with radius 1e+21. Try a smaller radius: radius 2.5e+20 builds here.';
    expect(smallerSizeIn(refusal)).toEqual({
      dimension: 'radius',
      size: 2.5e20
    });
    expect(blendRefusalText(refusal, 'mm')).toBe(
      'Fillet could not be created on 1 selected edge with radius 1e+21 mm. Try a smaller radius: radius 2.5e+20 mm builds here.'
    );
  });
});
