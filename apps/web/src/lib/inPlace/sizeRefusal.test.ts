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
});
