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

describe('assistant kill switch', () => {
  it('keeps the master toggle outside the section it removes', () => {
    // The toggle has to live somewhere that survives being switched off, or
    // there is no way back to it.
    const general = SETTINGS_SECTIONS.find(
      (section) => section.id === 'general'
    );
    const assistant = SETTINGS_SECTIONS.find(
      (section) => section.id === 'assistant'
    );
    expect(general?.settings).toContain('AI assistant');
    expect(assistant?.settings ?? []).not.toContain('AI assistant');
  });

  it('removes the assistant section when the assistant is disabled', () => {
    const enabled = visibleSettingsSections({ assistantEnabled: true });
    const disabled = visibleSettingsSections({ assistantEnabled: false });

    expect(enabled.map((section) => section.id)).toContain('assistant');
    expect(disabled.map((section) => section.id)).not.toContain('assistant');
    expect(disabled).toHaveLength(enabled.length - 1);
  });

  it('hides the assistant section from search as well as the nav', () => {
    // Filtering must happen before the query, otherwise a search for a term
    // that only the AI section carries would walk straight past the switch.
    for (const query of ['token', 'provider', 'reasoning', 'AI']) {
      expect(
        visibleSettingsSections({ assistantEnabled: false, query }).map(
          (section) => section.id
        )
      ).not.toContain('assistant');
    }
    expect(
      visibleSettingsSections({ assistantEnabled: true, query: 'token' }).map(
        (section) => section.id
      )
    ).toContain('assistant');
  });

  it('still matches sections by label, detail, and setting title', () => {
    const byLabel = visibleSettingsSections({
      assistantEnabled: true,
      query: 'viewport'
    });
    const bySettingTitle = visibleSettingsSections({
      assistantEnabled: true,
      query: 'angular snap'
    });
    const byDetail = visibleSettingsSections({
      assistantEnabled: true,
      query: 'diagnostics'
    });

    expect(byLabel.map((section) => section.id)).toContain('viewport');
    expect(bySettingTitle.map((section) => section.id)).toEqual(['sketching']);
    expect(byDetail.map((section) => section.id)).toEqual(['advanced']);
    expect(
      visibleSettingsSections({ assistantEnabled: true, query: '   ' })
    ).toHaveLength(SETTINGS_SECTIONS.length);
  });
});

describe('offline mode', () => {
  it('keeps its master toggle in the always-visible General section', () => {
    expect(
      SETTINGS_SECTIONS.find((section) => section.id === 'general')?.settings
    ).toContain('Cloud features');
  });

  it('removes account and assistant surfaces while keeping local settings', () => {
    const offline = visibleSettingsSections({
      assistantEnabled: true,
      cloudFunctionsEnabled: false
    });

    expect(offline.map((section) => section.id)).not.toContain('account');
    expect(offline.map((section) => section.id)).not.toContain('assistant');
    expect(offline.map((section) => section.id)).toContain('files');
    expect(offline.map((section) => section.id)).toContain('general');
  });

  it('cannot surface cloud-only sections through search', () => {
    for (const query of ['cloud profile', 'personal token', 'provider']) {
      expect(
        visibleSettingsSections({
          assistantEnabled: true,
          cloudFunctionsEnabled: false,
          query
        }).map((section) => section.id)
      ).not.toContain('account');
      expect(
        visibleSettingsSections({
          assistantEnabled: true,
          cloudFunctionsEnabled: false,
          query
        }).map((section) => section.id)
      ).not.toContain('assistant');
    }
  });
});
