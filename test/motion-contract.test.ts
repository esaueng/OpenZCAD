import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The web app's looping animations follow two rules, both learned from
 * defects no type or unit test could see:
 *
 * - One loading-ring rotation. Five surfaces each carried their own spin
 *   keyframes at 800 or 900ms, so a save in the top bar and an import in the
 *   activity pill turned visibly out of step; and a tool card spun its own
 *   fillet glyph into a pinwheel.
 * - Every infinite animation states its reduced-motion resting look, for the
 *   in-app toggle and the OS setting alike. The global collapse in tokens.css
 *   plays each animation once and stops on its last frame, which for the
 *   assistant launcher's pulse was fully transparent: the "working" signal
 *   vanished while a reply streamed.
 */

const STYLE_ROOT = fileURLToPath(new URL('../apps/web/src/', import.meta.url));
const TOGGLE_PREFIX = "[data-reduced-motion='true'] ";
const OS_MEDIA = '(prefers-reduced-motion: reduce)';

interface CssRule {
  file: string;
  media: string | null;
  selectors: string[];
  body: string;
}

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(full);
    return entry.name.endsWith('.css') ? [full] : [];
  });
}

/** Leaf rules with the @media they sit in; @keyframes are returned apart. */
function parse(file: string) {
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const keyframes: { name: string; body: string }[] = [];

  function walk(text: string, media: string | null) {
    let cursor = 0;
    while (cursor < text.length) {
      const open = text.indexOf('{', cursor);
      if (open === -1) return;
      const prelude = text.slice(cursor, open).trim();
      let depth = 1;
      let close = open + 1;
      while (depth > 0 && close < text.length) {
        if (text[close] === '{') depth += 1;
        if (text[close] === '}') depth -= 1;
        close += 1;
      }
      const body = text.slice(open + 1, close - 1);
      if (prelude.startsWith('@keyframes')) {
        keyframes.push({ name: prelude.split(/\s+/)[1] ?? '', body });
      } else if (prelude.startsWith('@media')) {
        walk(body, prelude.slice('@media'.length).trim());
      } else if (!prelude.startsWith('@')) {
        rules.push({
          file: path.relative(STYLE_ROOT, file),
          media,
          selectors: prelude
            .split(',')
            .map((s) => s.trim().replace(/\s+/g, ' ')),
          body
        });
      }
      cursor = close;
    }
  }

  walk(source, null);
  return { rules, keyframes };
}

const parsed = stylesheets(STYLE_ROOT).map(parse);
const rules = parsed.flatMap((sheet) => sheet.rules);
const keyframes = parsed.flatMap((sheet) => sheet.keyframes);

const stopsAnimation = (rule: CssRule) =>
  /(^|;)\s*animation:\s*none\s*(;|$)/.test(rule.body);

/**
 * A rule for `.axis` covers `.axis.horizontal`, as it does in the cascade,
 * but not a pseudo-element or descendant: `.assistant-launcher { animation:
 * none }` never reached the pulse on `.assistant-launcher.working::before`.
 */
const covers = (restSelector: string, selector: string) => {
  if (restSelector.length === 0 || !selector.startsWith(restSelector)) {
    return false;
  }
  const remainder = selector.slice(restSelector.length);
  // The remainder may only narrow the same element: more classes, attributes
  // or pseudo-classes, never a pseudo-element or a combinator.
  return (
    remainder === '' ||
    (/^[.[:]/.test(remainder) &&
      !remainder.includes('::') &&
      !/[\s>+~]/.test(remainder))
  );
};

describe('motion contract', () => {
  it('keeps a single loading-ring rotation', () => {
    const rotations = keyframes
      .filter((frame) => /rotate\(\s*360deg\s*\)/.test(frame.body))
      .map((frame) => frame.name);
    expect(rotations).toEqual(['oz-spin']);
  });

  it('gives every infinite animation a resting state under both reduced-motion paths', () => {
    const looping = rules.filter(
      (rule) =>
        rule.media === null &&
        /animation(-iteration-count)?:[^;]*\binfinite\b/.test(rule.body)
    );
    expect(looping.length).toBeGreaterThan(0);

    const missing = looping.flatMap((rule) =>
      rule.selectors.flatMap((selector) => {
        const toggle = rules.some(
          (rest) =>
            rest.media === null &&
            stopsAnimation(rest) &&
            rest.selectors.some(
              (candidate) =>
                candidate.startsWith(TOGGLE_PREFIX) &&
                covers(candidate.slice(TOGGLE_PREFIX.length), selector)
            )
        );
        const os = rules.some(
          (rest) =>
            rest.media === OS_MEDIA &&
            stopsAnimation(rest) &&
            rest.selectors.some((candidate) => covers(candidate, selector))
        );
        return [
          ...(toggle ? [] : [`${rule.file}: ${selector} (in-app toggle)`]),
          ...(os ? [] : [`${rule.file}: ${selector} (OS setting)`])
        ];
      })
    );
    expect(missing).toEqual([]);
  });
});
