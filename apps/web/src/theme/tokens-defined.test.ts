import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A `var(--x)` whose token nobody defines is not an error anywhere: the
 * property is simply dropped, or the fallback quietly becomes the value. That
 * is how the inspector's overflow menu shipped reading `--z-popover` and
 * `--shadow-popover` that had never existed. Every custom property a
 * stylesheet reads must be declared in a stylesheet, or set at runtime from a
 * component (the panel widths, the scale bar, the dimension label pose).
 */
const root = resolve(__dirname, '..');

function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path, keep));
    } else if (keep(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const stylesheets = walk(root, (name) => name.endsWith('.css'));
const sources = walk(
  root,
  (name) =>
    /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)
);

describe('custom properties', () => {
  it('are declared in a stylesheet or set at runtime before any stylesheet reads them', () => {
    const declared = new Set<string>();
    const used = new Map<string, string[]>();
    for (const sheet of stylesheets) {
      const css = readFileSync(sheet, 'utf8');
      for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) {
        declared.add(match[1]!);
      }
      for (const match of css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
        const list = used.get(match[1]!) ?? [];
        list.push(sheet.slice(root.length + 1));
        used.set(match[1]!, list);
      }
    }
    const runtime = new Set<string>();
    for (const source of sources) {
      const code = readFileSync(source, 'utf8');
      for (const match of code.matchAll(/['"`](--[a-z0-9-]+)['"`:]/g)) {
        runtime.add(match[1]!);
      }
    }
    const undefinedTokens = [...used]
      .filter(([name]) => !declared.has(name) && !runtime.has(name))
      .map(([name, sheets]) => `${name} (${[...new Set(sheets)].join(', ')})`);
    expect(undefinedTokens).toEqual([]);
  });
});
