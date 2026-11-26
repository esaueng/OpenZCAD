import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actionHandler } from './handlers';
import { actionEntry } from './registry';

describe('actionHandler', () => {
  it('finds a handler by its action id', () => {
    const fit = () => {};
    expect(actionHandler({ 'view-fit': fit }, 'view-fit')).toBe(fit);
  });

  it('finds nothing for an id the map does not own', () => {
    const handlers = { 'view-fit': () => {} };
    expect(actionHandler(handlers, 'view-grid')).toBeUndefined();
    expect(actionHandler(handlers, 'toString')).toBeUndefined();
    expect(actionHandler(handlers, '__proto__')).toBeUndefined();
    expect(actionHandler(handlers, undefined)).toBeUndefined();
    expect(actionHandler(handlers, null)).toBeUndefined();
  });
});

describe('the workspace’s handler map', () => {
  const app = readFileSync(resolve(__dirname, '..', '..', 'App.tsx'), 'utf8');
  const from = app.indexOf('const actionHandlers = {');
  const map = app.slice(from, app.indexOf('} satisfies ActionHandlers;', from));
  const ids = [...map.matchAll(/^ {4}'([^']+)':/gm)].map((match) => match[1]!);
  const keyboard = app.slice(
    app.indexOf('workspaceKeyDownRef.current = function onKeyDown('),
    app.indexOf('const listener = (event: KeyboardEvent) =>')
  );
  const palette = app.slice(
    app.indexOf('const paletteCommands = withDistinctLabels<PaletteCommand>(['),
    app.indexOf(
      '\n  ]);',
      app.indexOf('const paletteCommands = withDistinctLabels')
    )
  );

  it('is keyed by registered actions', () => {
    expect(from).toBeGreaterThan(0);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(actionEntry(id), id).toBeDefined();
  });

  it('is what the keyboard runs, with no second copy of a handled command', () => {
    expect(keyboard).toMatch(
      /const keyAction = actionHandler\(actionHandlers, modelCommand\?\.id\);\s*if \(keyAction\) \{\s*keyAction\(\);\s*return;/
    );
    // Settings' global key runs the same entry as its row.
    expect(keyboard).toMatch(
      /global === 'app-settings'\) \{\s*event\.preventDefault\(\);\s*actionHandlers\['app-settings'\]\(\);/
    );
    for (const id of ids) {
      expect(keyboard, id).not.toContain(`case '${id}':`);
    }
    // Its key turns only to a settled face pick, checked before the map.
    expect(ids).not.toContain('view-normal-to-face');
  });

  it('is what each command-bar row for a handled action runs', () => {
    for (const id of ids) {
      if (!actionEntry(id)?.sources.includes('command-bar')) continue;
      // The row's own entry: from its id to the next row's.
      const at = palette.indexOf(`id: '${id}'`);
      expect(at, id).toBeGreaterThanOrEqual(0);
      const next = palette.slice(at + 1).search(/\bid: ['`]/);
      const row = palette.slice(at, next < 0 ? undefined : at + 1 + next);
      expect(row, id).toContain(`run: actionHandlers['${id}']`);
    }
  });
});
