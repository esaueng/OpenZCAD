import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANNOTATION_TOOL_KEYS, ANNOTATION_TOOLS } from '../drawing/toolKeys';
import { KEYMAP_COMMANDS, toolCommandId } from '../keymap';
import { TOOL_GROUPS } from '../tools';
import { LOOK_AT_FACE_ITEM_ID, SELECT_OTHER_ITEM_ID } from '../viewportMenu';
import {
  ACTIONS,
  type ActionMenu,
  COMPACT_ENTRIES,
  DISPLAY_UNIT_ROWS,
  REGULAR_TOUCH_GAPS,
  actionEntry,
  pendingCompactActions,
  selectionVerbAction
} from './registry';

const src = resolve(__dirname, '..', '..');
const read = (path: string) => readFileSync(resolve(src, path), 'utf8');
const app = read('App.tsx');

/** The source between a start marker and the first end marker after it. */
function block(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from);
  expect(to, `missing the end of ${start}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

const literalIds = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map((match) => match[1]!);

const withSource = (source: string) =>
  ACTIONS.filter((entry) => entry.sources.includes(source as never));

/** The action a menu's item runs, by the menu's own item id. */
const menuAction = (menu: ActionMenu, item: string) =>
  ACTIONS.find((entry) =>
    entry.menuItems.some((route) => route.menu === menu && route.item === item)
  )?.id;

describe('action registry', () => {
  it('names every action once, with a label and a source', () => {
    const ids = ACTIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of ACTIONS) {
      expect(entry.label.trim(), entry.id).not.toBe('');
      expect(entry.sources.length, entry.id).toBeGreaterThan(0);
    }
  });

  it('holds every keymap command under its own id', () => {
    for (const command of KEYMAP_COMMANDS) {
      expect(actionEntry(command.id)?.sources, command.id).toContain('keymap');
    }
    expect(withSource('keymap')).toHaveLength(KEYMAP_COMMANDS.length);
  });

  it('holds exactly the command bar’s fixed rows', () => {
    const palette = block(
      app,
      'const paletteCommands = withDistinctLabels<PaletteCommand>([',
      '\n  ]);'
    );
    // The two templated row families, read from the same block.
    expect(palette).toContain('id: `tool-${toolId}`');
    expect(palette).toContain('id: `file-display-units-${unit}`');
    const unitList = /\(\[([^\]]+)\] as const\)\.map\(\(unit\)/.exec(palette);
    expect(unitList, 'the unit rows’ list').not.toBeNull();
    const units = literalIds(unitList![1]!, /'([^']+)'/g);
    expect(DISPLAY_UNIT_ROWS.map(([unit]) => unit)).toEqual(units);

    const rows = new Set(literalIds(palette, /\bid: '([^']+)'/g));
    for (const group of TOOL_GROUPS) {
      for (const tool of group.tools) rows.add(toolCommandId(tool));
    }
    for (const unit of units) rows.add(`file-display-units-${unit}`);
    const registered = new Set(withSource('command-bar').map((e) => e.id));
    expect([...registered].sort()).toEqual([...rows].sort());
  });

  it('maps every App menu item to an action, menu by menu', () => {
    // Each menu is built in its own App function; its items are written
    // `item: { id: …`, and a templated id is recorded ending in `*`.
    const builders: Record<ActionMenu, string> = {
      viewport: 'function handleViewportContextMenu(',
      selection: 'function openViewportSelectionContextMenu(',
      'history-row': 'function handleFeatureContextMenu('
    };
    for (const [menu, start] of Object.entries(builders) as [
      ActionMenu,
      string
    ][]) {
      const items = new Set(
        [
          ...block(app, start, '\n  function ').matchAll(
            /item: \{\s*id: (?:'([^']+)'|`([^`$]+)\$\{)/g
          )
        ].map((match) => match[1] ?? `${match[2]}*`)
      );
      expect(items.size, menu).toBeGreaterThan(0);
      // Select other is built in the viewport handler, which hands it to
      // the selection menu too; Look at face comes from `withFaceVerbs`.
      expect(block(app, builders.viewport, '\n  function ')).toContain(
        'item: selectOtherMenuItem(selectOther.count)'
      );
      if (menu !== 'history-row') items.add(SELECT_OTHER_ITEM_ID);
      if (menu === 'selection') items.add(LOOK_AT_FACE_ITEM_ID);
      const registered = ACTIONS.flatMap((entry) =>
        entry.menuItems
          .filter((item) => item.menu === menu)
          .map((item) => item.item)
      );
      expect(new Set(registered).size, menu).toBe(registered.length);
      expect([...registered].sort(), menu).toEqual([...items].sort());
    }
    // Where an item id repeats across menus, each menu keeps its own action.
    expect(menuAction('selection', 'delete')).toBe('selection-delete');
    expect(menuAction('history-row', 'delete')).toBe('feature-delete');
    expect(menuAction('selection', 'edit')).toBe('feature-edit');
    expect(menuAction('history-row', 'edit')).toBe('feature-edit');
    expect(menuAction('selection', 'move')).toBe('tool-transform');
  });

  it('holds exactly the verb rail’s verbs', () => {
    expect(selectionVerbAction('tool:fillet')).toBe('tool-fillet');
    expect(selectionVerbAction('action:offset-face')).toBe(
      'selection-offset-face'
    );
    const capabilities = read('lib/interaction/capabilities.ts');
    const actions = literalIds(
      block(capabilities, 'export type SelectionActionId =', ';'),
      /\| '([^']+)'/g
    );
    const callout = read('lib/selectionCallout.ts');
    const others = literalIds(
      block(callout, 'export type SelectionCalloutVerbId =', ';'),
      /\| '([^']+)'/g
    );
    // The tools a pick offers: `tools(…)` lists, and an unarmed edge's
    // Fillet and Chamfer (`edgeVerb` falls back to the tool).
    const verbs = block(
      callout,
      'export function selectionCalloutVerbs(',
      '\n}\n'
    );
    const tools = new Set([
      ...[...verbs.matchAll(/\btools\(([^)]*)\)/g)].flatMap((match) =>
        literalIds(match[1]!, /'([^']+)'/g)
      ),
      ...literalIds(verbs, /\b(?:edgeVerb|toolVerb)\('([^']+)'/g)
    ]);
    expect(tools.size).toBeGreaterThan(0);
    const expected = new Set([
      ...actions.map((id) => `action:${id}`),
      ...others,
      ...[...tools].map((tool) => `tool:${tool}`)
    ]);
    const registered = withSource('selection-verb');
    expect(registered.map((entry) => entry.id).sort()).toEqual(
      [...expected].map(selectionVerbAction).sort()
    );
  });

  it('holds every Draw tool with the key Draw answers to', () => {
    for (const kind of ANNOTATION_TOOLS) {
      expect(actionEntry(`drawing-${kind}`)?.fixedKeys).toEqual([
        ANNOTATION_TOOL_KEYS[kind]
      ]);
    }
    expect(withSource('drawing')).toHaveLength(ANNOTATION_TOOLS.length + 3);
    // Draw reads its keys from the shared module, not a copy of its own.
    const drawing = read('components/DrawingWorkspace.tsx');
    expect(drawing).toContain("from '../lib/drawing/toolKeys'");
    expect(drawing).not.toMatch(/const (ANNOTATION_TOOL_KEYS|\w+_TOOL_KEY) =/);
  });

  it('holds the keys surfaces handle themselves, by the key each answers to', () => {
    const clipboard = block(
      app,
      "async function handleSketchClipboardKey(key: 'a' | 'c' | 'v')",
      '\n  }\n'
    );
    const timeline = block(
      read('components/assembly/MotionStudyTimeline.tsx'),
      'function onKeyDown(event: ReactKeyboardEvent<HTMLElement>)',
      '\n  }\n'
    );
    // Each fixed key, the handler that answers it, and what it runs there.
    const fixed: [
      id: string,
      key: string | string[],
      source: string,
      handled: string
    ][] = [
      ['sketch-select-all', 'Ctrl+A', clipboard, "if (key === 'a') {"],
      ['sketch-copy', 'Ctrl+C', clipboard, "if (key === 'c') {"],
      [
        'sketch-paste',
        'Ctrl+V',
        clipboard,
        'const copied = sketchClipboardRef.current;'
      ],
      ['motion-play-pause', 'Space', timeline, "if (event.key === ' ') {"],
      ['motion-key-pose', 'K', timeline, "event.key === 'K') keyAtPlayhead()"],
      ['motion-previous-key', '[', timeline, "event.key === '[') jumpKey(-1)"],
      ['motion-next-key', ']', timeline, "event.key === ']') jumpKey(1)"],
      [
        'motion-delete-key',
        ['Delete', 'Backspace'],
        timeline,
        "event.key === 'Delete' || event.key === 'Backspace'"
      ]
    ];
    for (const [id, key, source, handled] of fixed) {
      expect(source, id).toContain(handled);
      expect(actionEntry(id)?.sources, id).toEqual(['fixed-key']);
      expect(actionEntry(id)?.fixedKeys, id).toEqual([key].flat());
    }
    // Every key the timeline answers is accounted for. Escape only closes
    // its Add menu, as Escape closes any menu, so it is not an action.
    expect(literalIds(timeline, /event\.key === '([^']+)'/g).sort()).toEqual(
      [' ', 'Backspace', 'Delete', 'Escape', 'K', '[', ']', 'k'].sort()
    );
    expect(withSource('fixed-key')).toHaveLength(fixed.length);
  });

  it('gives Assemble’s sheet what slice 8 builds, and nothing it does not', () => {
    const assembleSheet = Object.entries(COMPACT_ENTRIES)
      .filter(([, surface]) => surface === 'assemble-sheet')
      .map(([id]) => id)
      .sort();
    expect(assembleSheet).toEqual(
      [
        'assembly-joint',
        'assembly-ground',
        'assembly-play',
        'motion-play-pause',
        'motion-key-pose',
        'motion-previous-key',
        'motion-next-key',
        'motion-delete-key'
      ].sort()
    );
    // Every Assemble command and every timeline key has its compact entry.
    expect(
      pendingCompactActions()
        .map((entry) => entry.id)
        .filter((id) => id.startsWith('assembly-') || id.startsWith('motion-'))
    ).toEqual([]);
  });

  it('gives View’s tray what slice 7 builds, and nothing it does not', () => {
    const viewTray = Object.entries(COMPACT_ENTRIES)
      .filter(([, surface]) => surface === 'view-tray')
      .map(([id]) => id)
      .sort();
    expect(viewTray).toEqual(
      [
        'view-measure',
        'view-section',
        'view-display',
        'view-xray',
        'view-grid',
        'view-projection',
        'view-orbit-mode',
        'view-fit',
        'view-front',
        'view-back',
        'view-left',
        'view-right',
        'view-top',
        'view-bottom',
        'view-iso',
        'body-visibility',
        'view-isolate-body',
        'view-show-all'
      ].sort()
    );
    // A face's Look at stays with the selection sheet (slice 4).
    expect(COMPACT_ENTRIES['view-normal-to-face']).toBeUndefined();
    // Tweak's exports were reached from the overflow menu already.
    expect(COMPACT_ENTRIES['file-export-step']).toBe('overflow-menu');
    expect(COMPACT_ENTRIES['file-export-mesh']).toBe('overflow-menu');
  });

  it('lists only registered actions as touch gaps and compact entries', () => {
    for (const id of REGULAR_TOUCH_GAPS) {
      expect(actionEntry(id), id).toBeDefined();
    }
    for (const id of Object.keys(COMPACT_ENTRIES)) {
      expect(actionEntry(id), id).toBeDefined();
    }
    expect(pendingCompactActions().length).toBe(
      ACTIONS.length - Object.keys(COMPACT_ENTRIES).length
    );
  });
});
