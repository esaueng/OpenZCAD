import { describe, expect, it } from 'vitest';
import { countLabel, deleteFeatureToastMessage } from './toasts';

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

describe('countLabel', () => {
  it('picks the singular only for exactly one', () => {
    expect(countLabel(0, 'body', 'bodies')).toBe('0 bodies');
    expect(countLabel(1, 'body', 'bodies')).toBe('1 body');
    expect(countLabel(2, 'body', 'bodies')).toBe('2 bodies');
  });
});
