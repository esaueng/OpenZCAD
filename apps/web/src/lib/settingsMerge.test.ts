import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@openzcad/shared';
import { mergeSettingsOntoAccount, sameSettings } from './settingsMerge';

describe('mergeSettingsOntoAccount', () => {
  it('keeps what this device changed and takes the account’s for the rest', () => {
    const base = structuredClone(DEFAULT_APP_SETTINGS);
    const ours = structuredClone(base);
    ours.general.defaultUnits = 'cm';
    ours.sketching.hiddenRelationGlyphs = ['coincident'];
    const theirs = structuredClone(base);
    theirs.appearance.theme = 'light';
    theirs.assistant.customInstructions = 'Use M3.';
    theirs.sketching.hiddenRelationGlyphs = ['parallel', 'tangent'];
    const merged = mergeSettingsOntoAccount(base, ours, theirs);
    expect(merged.general.defaultUnits).toBe('cm');
    expect(merged.appearance.theme).toBe('light');
    expect(merged.assistant.customInstructions).toBe('Use M3.');
    // A list is one value: this device's change wins whole.
    expect(merged.sketching.hiddenRelationGlyphs).toEqual(['coincident']);
  });

  it('gives exactly the account’s settings when nothing changed here', () => {
    const base = structuredClone(DEFAULT_APP_SETTINGS);
    const theirs = structuredClone(base);
    theirs.appearance.theme = 'dark';
    expect(
      sameSettings(mergeSettingsOntoAccount(base, base, theirs), theirs)
    ).toBe(true);
  });

  it('compares regardless of key order', () => {
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    const reordered = Object.fromEntries(
      Object.entries(settings).reverse()
    ) as typeof settings;
    expect(sameSettings(settings, reordered)).toBe(true);
  });
});
