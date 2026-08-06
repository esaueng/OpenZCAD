import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_SECTIONS,
  visibleSettingsSections
} from '../apps/web/src/lib/settingsSections';

const SOURCE = readFileSync(
  fileURLToPath(
    new URL('../apps/web/src/components/SettingsPage.tsx', import.meta.url)
  ),
  'utf8'
);

/**
 * The "Find a setting" index lives in SETTINGS_SECTIONS while the settings
 * themselves are declared as JSX in SettingsPage, so the two can drift apart
 * silently and quietly stop matching. Parse the rendered side out of the source
 * and require it agrees with the index.
 */
function renderedSettingsBySection(): Map<string, string[]> {
  const bySection = new Map<string, string[]>();
  let section: string | null = null;
  let tag: string | null = null;
  for (const line of SOURCE.split('\n')) {
    const sectionMatch = line.match(/active === '([a-z]+)'/);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      bySection.set(section, bySection.get(section) ?? []);
    }
    const tagMatch = line.match(/<(Section|SettingRow)\b/);
    if (tagMatch) {
      tag = tagMatch[1]!;
    }
    const titleMatch = line.match(/^\s*title="([^"]+)"/);
    // Only SettingRow titles are indexed; the Section title duplicates the
    // section label already covered by the nav.
    if (titleMatch && section && tag === 'SettingRow') {
      bySection.get(section)!.push(titleMatch[1]!);
    }
  }
  return bySection;
}

function indexedSettingsBySection(): Map<string, string[]> {
  return new Map(
    SETTINGS_SECTIONS.map((section) => [section.id, section.settings])
  );
}

describe('settings search index', () => {
  it('indexes every rendered setting title', () => {
    const rendered = renderedSettingsBySection();
    const indexed = indexedSettingsBySection();

    // Guard the parser itself: a regex that silently stopped matching would
    // otherwise make this test pass by comparing two empty maps.
    expect(rendered.size).toBe(10);
    expect(indexed.size).toBe(10);
    expect(Array.from(rendered.values()).flat().length).toBeGreaterThanOrEqual(
      30
    );

    for (const [section, titles] of rendered) {
      expect({ section, titles: indexed.get(section) }).toEqual({
        section,
        titles
      });
    }
  });
});

describe('assistant settings', () => {
  it('indexes the master toggle on the AI Assistant page', () => {
    const general = SETTINGS_SECTIONS.find(
      (section) => section.id === 'general'
    );
    const assistant = SETTINGS_SECTIONS.find(
      (section) => section.id === 'assistant'
    );
    expect(general?.settings).not.toContain('AI assistant');
    expect(assistant?.settings).toContain('AI assistant');
  });

  it('keeps the assistant section available so the toggle can be changed', () => {
    expect(visibleSettingsSections({}).map((section) => section.id)).toContain(
      'assistant'
    );
  });

  it('finds the assistant section by its toggle and provider settings', () => {
    for (const query of ['AI assistant', 'token', 'provider', 'reasoning']) {
      expect(
        visibleSettingsSections({ query }).map((section) => section.id)
      ).toContain('assistant');
    }
  });

  it('still matches sections by label, detail, and setting title', () => {
    const byLabel = visibleSettingsSections({ query: 'viewport' });
    const bySettingTitle = visibleSettingsSections({ query: 'angular snap' });
    const byDetail = visibleSettingsSections({ query: 'diagnostics' });

    expect(byLabel.map((section) => section.id)).toContain('viewport');
    expect(bySettingTitle.map((section) => section.id)).toEqual(['sketching']);
    expect(byDetail.map((section) => section.id)).toEqual(['advanced']);
    expect(visibleSettingsSections({ query: '   ' })).toHaveLength(
      SETTINGS_SECTIONS.length
    );
  });
});

describe('privacy settings', () => {
  it('routes account and project deletion searches to Privacy & data', () => {
    for (const query of [
      'delete account',
      'delete projects',
      'permanent deletion'
    ]) {
      expect(
        visibleSettingsSections({ query }).map((section) => section.id)
      ).toEqual(['privacy']);
    }
  });
});
