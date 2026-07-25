import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  fileURLToPath(
    new URL('../apps/web/src/components/SettingsPage.tsx', import.meta.url)
  ),
  'utf8'
);

/**
 * The "Find a setting" index lives in SECTIONS while the settings themselves are
 * declared as JSX further down, so the two can drift apart silently and quietly
 * stop matching. Parse both out of the source and require they agree.
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
  const bySection = new Map<string, string[]>();
  const sections = SOURCE.slice(
    SOURCE.indexOf('const SECTIONS'),
    SOURCE.indexOf('const SHORTCUTS')
  );
  const entry =
    /id: '([a-z]+)',[\s\S]*?settings: \[([\s\S]*?)\]\s*\n\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = entry.exec(sections)) !== null) {
    const titles = Array.from(match[2]!.matchAll(/'((?:[^'\\]|\\')*)'/g)).map(
      (found) => found[1]!.replace(/\\'/g, "'")
    );
    bySection.set(match[1]!, titles);
  }
  return bySection;
}

describe('settings search index', () => {
  it('indexes every rendered setting title', () => {
    const rendered = renderedSettingsBySection();
    const indexed = indexedSettingsBySection();

    // Guard the parsers themselves: a regex that silently stops matching would
    // otherwise make this test pass by comparing two empty maps.
    expect(rendered.size).toBe(10);
    expect(indexed.size).toBe(10);
    expect(
      Array.from(rendered.values()).flat().length
    ).toBeGreaterThanOrEqual(30);

    for (const [section, titles] of rendered) {
      expect({ section, titles: indexed.get(section) }).toEqual({
        section,
        titles
      });
    }
  });
});
