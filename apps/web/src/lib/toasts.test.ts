import { describe, expect, it } from 'vitest';
import {
  countLabel,
  deleteFeatureToastMessage,
  suppressFeatureToastMessage
} from './toasts';

describe('deleteFeatureToastMessage', () => {
  it('names the feature and stays quiet when nothing depended on it', () => {
    expect(deleteFeatureToastMessage('Boss', 0)).toBe('Deleted Boss');
  });

  it('says how much rested on the feature, pluralised', () => {
    expect(deleteFeatureToastMessage('Boss', 1)).toBe(
      'Deleted Boss · 1 feature depended on it'
    );
    expect(deleteFeatureToastMessage('Boss', 5)).toBe(
      'Deleted Boss · 5 features depended on it'
    );
  });
});

describe('suppressFeatureToastMessage', () => {
  it('names the feature alone when nothing newly needs repair', () => {
    expect(suppressFeatureToastMessage('Boss', false, 0)).toBe(
      'Suppressed Boss'
    );
    expect(suppressFeatureToastMessage('Boss', true, 0)).toBe('Resumed Boss');
  });

  it('counts the later features the toggle broke, pluralised', () => {
    expect(suppressFeatureToastMessage('Boss', false, 6)).toBe(
      'Suppressed Boss · 6 later features now need repair'
    );
    expect(suppressFeatureToastMessage('Boss', true, 1)).toBe(
      'Resumed Boss · 1 later feature now needs repair'
    );
  });
});

describe('countLabel', () => {
  it('picks the singular only for exactly one', () => {
    expect(countLabel(0, 'body', 'bodies')).toBe('0 bodies');
    expect(countLabel(1, 'body', 'bodies')).toBe('1 body');
    expect(countLabel(2, 'body', 'bodies')).toBe('2 bodies');
  });
});
