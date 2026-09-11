import { describe, expect, it } from 'vitest';
import {
  axisDimensionLabel,
  primitiveDimensionLabel
} from './primitiveDimensionLabel';

describe('primitive dimension vocabulary', () => {
  it('names the box sizes the way the form does, not the way the kernel keys them', () => {
    expect(primitiveDimensionLabel('box', 'width')).toBe('Width');
    expect(primitiveDimensionLabel('box', 'height')).toBe('Depth');
    expect(primitiveDimensionLabel('box', 'depth')).toBe('Height');
  });

  it('leaves the other primitives on their own key names', () => {
    expect(primitiveDimensionLabel('cylinder', 'height')).toBe('Height');
    expect(primitiveDimensionLabel('cone', 'radius')).toBe('Radius');
    expect(primitiveDimensionLabel(undefined, 'height')).toBe('Height');
  });

  it('maps a world-axis drag to the same words (Z is up)', () => {
    expect(axisDimensionLabel('x')).toBe('Width');
    expect(axisDimensionLabel('y')).toBe('Depth');
    expect(axisDimensionLabel('z')).toBe('Height');
  });
});
