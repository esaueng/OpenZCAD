import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_SECTIONS,
  visibleSettingsSections
} from '../apps/web/src/lib/settingsSections';

function source(name: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../apps/web/src/components/${name}`, import.meta.url)
    ),
    'utf8'
  );
}

const SOURCE = source('SettingsPage.tsx');

/**
 * The "Find a setting" index lives in SETTINGS_SECTIONS while the settings
 * themselves are declared as JSX in SettingsPage, so the two can drift apart
 * silently and quietly stop matching. Parse the rendered side out of the source
 * and require it agrees with the index, in order.
 */
function rowTitles(text: string): Array<{ line: string; title?: string }> {
  let tag: string | null = null;
  return text.split('\n').map((line) => {
    // A group's or page's title is a heading, not a setting.
    const tagMatch = line.match(/<(Section|Group|SettingRow|Status)\b/);
    if (tagMatch) {
      tag = tagMatch[1]!;
    }
    // On its own line, or inline after `<SettingRow compact`.
    const titleMatch = line.match(
      /(?:^\s*|<SettingRow\b[^>]*\s)title="([^"]+)"/
    );
    // Only SettingRow titles are indexed; the Section title duplicates the
    // section label already covered by the nav.
    return titleMatch && tag === 'SettingRow'
      ? { line, title: titleMatch[1]! }
      : { line };
  });
}

/**
 * Rows a component in another file renders, by component name, so they are
 * counted where SettingsPage places the component.
 */
function componentTitles(name: string): Map<string, string[]> {
  const byComponent = new Map<string, string[]>();
  let component: string | null = null;
  for (const { line, title } of rowTitles(source(name))) {
    const declared = line.match(/^export function ([A-Z]\w*)/);
    if (declared) {
      component = declared[1]!;
      byComponent.set(component, []);
    }
    if (title && component) {
      byComponent.get(component)!.push(title);
    }
  }
  return byComponent;
}

const SPLICED = new Map([
  ...componentTitles('AnalyticsConsent.tsx'),
  ...componentTitles('EncryptionSettings.tsx')
]);

function renderedSettingsBySection(): Map<string, string[]> {
  const bySection = new Map<string, string[]>();
  let section: string | null = null;
  for (const { line, title } of rowTitles(SOURCE)) {
    const sectionMatch = line.match(/active === '([a-z]+)'/);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      bySection.set(section, bySection.get(section) ?? []);
    }
    if (!section) {
      continue;
    }
    const used = line.match(/<([A-Z]\w*)\b/)?.[1];
    if (used && SPLICED.has(used)) {
      bySection.get(section)!.push(...SPLICED.get(used)!);
    }
    if (title) {
      bySection.get(section)!.push(title);
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
    expect(rendered.size).toBe(11);
    expect(indexed.size).toBe(11);
    expect(Array.from(rendered.values()).flat().length).toBeGreaterThanOrEqual(
      30
    );

    // The consent rows come from AnalyticsConsent.tsx; a parser that lost
    // them would leave Privacy short without failing the comparison.
    expect(SPLICED.get('AnalyticsConsent')).toEqual([
      'Usage analytics',
      'Diagnostic report'
    ]);
    expect(SPLICED.get('CloudStatisticsConsent')).toEqual([
      'Cloud account statistics'
    ]);
    // The Encryption rows come from its lazy component.
    expect(SPLICED.get('EncryptionSettings')).toContain('Your fingerprint');

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
    const bySettingTitle = visibleSettingsSections({
      query: 'snap tolerance'
    });
    const byDetail = visibleSettingsSections({ query: 'diagnostics' });

    expect(byLabel.map((section) => section.id)).toContain('viewport');
    expect(bySettingTitle.map((section) => section.id)).toEqual(['sketching']);
    expect(byDetail.map((section) => section.id)).toEqual(['advanced']);
    expect(visibleSettingsSections({ query: '   ' })).toHaveLength(
      SETTINGS_SECTIONS.length - 1
    );
    expect(
      visibleSettingsSections({ query: '   ', encryptionAvailable: true })
    ).toHaveLength(SETTINGS_SECTIONS.length);
  });
});

describe('encryption settings', () => {
  it('appear only when the server opened them and cloud features are on', () => {
    const ids = (options: Parameters<typeof visibleSettingsSections>[0]) =>
      visibleSettingsSections(options).map((section) => section.id);
    expect(ids({})).not.toContain('encryption');
    expect(ids({ encryptionAvailable: true })).toContain('encryption');
    expect(
      ids({ encryptionAvailable: true, cloudFunctionsEnabled: false })
    ).not.toContain('encryption');
    expect(ids({ encryptionAvailable: true, query: 'recovery key' })).toEqual([
      'encryption'
    ]);
    expect(ids({ query: 'recovery key' })).toEqual([]);
  });
});

describe('privacy settings', () => {
  it('finds the data download by export and backup searches', () => {
    for (const query of [
      'download all data',
      'export account',
      'backup projects'
    ]) {
      expect(
        visibleSettingsSections({ query }).map((section) => section.id)
      ).toEqual(['privacy']);
    }
  });
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

describe('offline mode', () => {
  it('keeps its master toggle on Account, which stays visible offline', () => {
    expect(
      SETTINGS_SECTIONS.find((section) => section.id === 'account')?.settings
    ).toContain('Cloud features');
    const account = visibleSettingsSections({
      cloudFunctionsEnabled: false
    }).find((section) => section.id === 'account');
    expect(account?.settings).toEqual(['Cloud features']);
  });

  it('removes the assistant and cloud account surfaces while keeping local settings', () => {
    const offline = visibleSettingsSections({
      cloudFunctionsEnabled: false
    });

    expect(offline.map((section) => section.id)).not.toContain('assistant');
    expect(offline.map((section) => section.id)).toContain('saving');
    expect(offline.map((section) => section.id)).toContain('general');
  });

  it('cannot surface cloud-only sections through search', () => {
    for (const query of ['cloud profile', 'personal token', 'provider']) {
      expect(
        visibleSettingsSections({
          cloudFunctionsEnabled: false,
          query
        }).map((section) => section.id)
      ).not.toContain('account');
      expect(
        visibleSettingsSections({
          cloudFunctionsEnabled: false,
          query
        }).map((section) => section.id)
      ).not.toContain('assistant');
    }
  });
});
