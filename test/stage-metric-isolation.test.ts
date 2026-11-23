import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * W01: the stage publishes the heights of its lanes as custom properties on
 * `.viewer-area` while an edit lands (WorkspaceReadout, ActivityPill, the
 * motion timeline, the tour's foot claim). Custom properties inherit, so
 * every write restyled and re-laid out each History and Objects row under
 * the viewer area: tens of milliseconds of a 100-step edit's main-thread
 * frame. `.model-panel` redeclares each of them `initial`, so a panel's
 * style does not depend on them and the restyle stops at its frame.
 *
 * This keeps that list complete: every property written on the viewer area
 * at run time, and every property the stylesheets derive from one, must be
 * redeclared on `.model-panel`, and no panel rule may read one (it would
 * only ever see the unset value).
 */

const ROOT = join(import.meta.dirname, '..');
const SOURCE = join(ROOT, 'apps/web/src');
const PANEL_STYLESHEET = join(SOURCE, 'styles/components/quiet-stage.css');

function walk(directory: string, extensions: string[]): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return walk(path, extensions);
    return extensions.some((extension) => path.endsWith(extension))
      ? [path]
      : [];
  });
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** `selector { body }` pairs of the innermost blocks (at-rules unwrapped). */
function cssRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selector: match[1]!.trim(), body: match[2]! });
  }
  return rules;
}

const sources = walk(SOURCE, ['.ts', '.tsx']).filter(
  (path) => !/\.test\.tsx?$/.test(path)
);
const stylesheets = walk(SOURCE, ['.css']);
const rules = stylesheets.flatMap((path) =>
  cssRules(readFileSync(path, 'utf8')).map((rule) => ({ ...rule, path }))
);

/**
 * Custom properties a component writes on the element it found with
 * `closest('.viewer-area')`, as `<name>.style.setProperty('--x', …)`, plus
 * the members of a string union a hook writes through a parameter (the
 * `StageFootClaim` claims).
 */
function stageWrites(): {
  writes: Map<string, string[]>;
  unresolved: string[];
} {
  const writes = new Map<string, string[]>();
  const unresolved: string[] = [];
  const add = (property: string, path: string) =>
    writes.set(property, [
      ...(writes.get(property) ?? []),
      relative(ROOT, path)
    ]);
  for (const path of sources) {
    const text = readFileSync(path, 'utf8');
    const holders = [
      ...text.matchAll(
        /(?:const|let)\s+(\w+)\s*=[^;]*?closest(?:<\w+>)?\(\s*'\.viewer-area'\s*\)/g
      )
    ].map((match) => match[1]!);
    for (const holder of new Set(holders)) {
      for (const match of text.matchAll(
        new RegExp(
          `\\b${holder}\\??\\.style\\.setProperty\\(\\s*'(--[\\w-]+)'`,
          'g'
        )
      )) {
        add(match[1]!, path);
      }
      // A property passed in rather than spelled out at the call: it must
      // come from a string union of property names declared in the file,
      // or the scan cannot know what it writes and says so.
      if (
        new RegExp(
          `\\b${holder}\\??\\.style\\.setProperty\\(\\s*\\w+\\s*,`
        ).test(text)
      ) {
        const unions = [
          ...text.matchAll(
            /export type \w+\s*=\s*((?:\s*\|?\s*'--[\w-]+')+)\s*;/g
          )
        ];
        if (unions.length === 0) unresolved.push(relative(ROOT, path));
        for (const union of unions) {
          for (const member of union[1]!.matchAll(/'(--[\w-]+)'/g)) {
            add(member[1]!, path);
          }
        }
      }
    }
  }
  return { writes, unresolved };
}

/** The written properties and every custom property declared from one. */
function derivedClosure(roots: Iterable<string>): Set<string> {
  const closure = new Set(roots);
  const declarations = rules.flatMap((rule) =>
    [...rule.body.matchAll(/(--[\w-]+)\s*:([^;]*)/g)].map((match) => ({
      name: match[1]!,
      value: match[2]!
    }))
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const { name, value } of declarations) {
      if (closure.has(name)) continue;
      if (
        [...closure].some((property) =>
          new RegExp(`var\\(\\s*${property}\\s*[,)]`).test(value)
        )
      ) {
        closure.add(name);
        grew = true;
      }
    }
  }
  return closure;
}

function panelFirewall(): Map<string, string> {
  const frame = cssRules(readFileSync(PANEL_STYLESHEET, 'utf8')).filter(
    (rule) => rule.selector.split('\n').at(-1)!.trim() === '.model-panel'
  );
  expect(frame).toHaveLength(1);
  return new Map(
    [...frame[0]!.body.matchAll(/(--[\w-]+)\s*:\s*([^;]*);/g)].map((match) => [
      match[1]!,
      match[2]!.trim()
    ])
  );
}

describe('stage metrics stay out of the model panels (W01)', () => {
  const { writes, unresolved } = stageWrites();
  const closure = derivedClosure(writes.keys());

  it('finds the stage writers it guards', () => {
    // If a rename hides one of these from the scan, the list below would
    // pass while guarding nothing.
    expect([...writes.keys()].sort()).toEqual(
      expect.arrayContaining([
        '--activity-pill-live-h',
        '--in-place-command-h',
        '--motion-timeline-claim',
        '--motion-timeline-h',
        '--workspace-guidance-h',
        '--workspace-tour-claim'
      ])
    );
    expect(closure).toContain('--lane-base');
    // A write through a constant or a computed name would escape the list.
    expect(unresolved).toEqual([]);
  });

  it('redeclares every stage metric initial on the panel frame', () => {
    const firewall = panelFirewall();
    const missing = [...closure].filter(
      (property) => firewall.get(property) !== 'initial'
    );
    expect(
      missing,
      `Add to .model-panel in ${relative(ROOT, PANEL_STYLESHEET)}: ${missing
        .map((property) => `${property}: initial;`)
        .join(' ')}`
    ).toEqual([]);
  });

  it('has no panel rule that reads a stage metric', () => {
    const panelSelector =
      /\.(model-panel|feature-list|feature-row|history-|body-row|panel-frame)/;
    const readers = rules.filter(
      (rule) =>
        panelSelector.test(rule.selector) &&
        [...closure].some((property) =>
          new RegExp(`var\\(\\s*${property}\\s*[,)]`).test(rule.body)
        )
    );
    expect(
      readers.map((rule) => `${relative(ROOT, rule.path)}: ${rule.selector}`)
    ).toEqual([]);
  });
});
