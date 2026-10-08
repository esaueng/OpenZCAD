import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTION_IDS } from './settingsSectionIds';
import { SETTINGS_SECTIONS, visibleSettingsSections } from './settingsSections';

function matches(query: string): string[] {
  return visibleSettingsSections({ query }).map((section) => section.id);
}

describe('find a setting', () => {
  /**
   * Each of these came back "No settings match" although the page has the
   * setting: the start screen's own Sign in button opens Account, and the
   * assistant's preferences field is labelled "CAD assistant preferences".
   */
  it('finds sign-in by the words people search for', () => {
    for (const query of ['sign in', 'login', 'log in', 'password']) {
      expect(matches(query)).toContain('account');
    }
  });

  it('finds the theme by dark and light', () => {
    for (const query of ['dark', 'light mode']) {
      expect(matches(query)).toContain('appearance');
    }
  });

  it('finds the assistant credential and preferences', () => {
    expect(matches('api key')).toContain('assistant');
    expect(matches('preferences')).toEqual(
      expect.arrayContaining(['assistant', 'account'])
    );
  });

  it('still finds exports by format after the row was renamed', () => {
    for (const query of ['STEP', 'stl', 'exports']) {
      expect(matches(query)).toContain('files');
    }
  });

  it('keeps cloud-only sections out of offline searches', () => {
    for (const query of ['sign in', 'api key']) {
      const ids = visibleSettingsSections({
        cloudFunctionsEnabled: false,
        query
      }).map((section) => section.id);
      expect(ids).not.toContain('account');
      expect(ids).not.toContain('assistant');
    }
  });
});

describe('section ids', () => {
  it('lists exactly the sections the index renders', () => {
    // The startup id list stands apart so the entry chunk does not carry the
    // search index; a section added to one and not the other would make a
    // restored Settings view fall back to General, or restore a dead id.
    expect([...SETTINGS_SECTION_IDS].sort()).toEqual(
      SETTINGS_SECTIONS.map((section) => section.id).sort()
    );
  });
});
