import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANNOTATION_TOOL_KEYS, ANNOTATION_TOOLS } from '../drawing/toolKeys';
import { KEYMAP_COMMANDS, toolCommandId } from '../keymap';
import { TOOL_GROUPS } from '../tools';
import { LOOK_AT_FACE_ITEM_ID, SELECT_OTHER_ITEM_ID } from '../viewportMenu';
import {
  ACTIONS,
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
    expect(palette).toContain("(['mm', 'cm', 'm', 'inch'] as const)");

    const rows = new Set(literalIds(palette, /\bid: '([^']+)'/g));
    for (const group of TOOL_GROUPS) {
      for (const tool of group.tools) rows.add(toolCommandId(tool));
    }
    for (const [unit] of DISPLAY_UNIT_ROWS) {
      rows.add(`file-display-units-${unit}`);
    }
    const registered = new Set(withSource('command-bar').map((e) => e.id));
    expect([...registered].sort()).toEqual([...rows].sort());
  });

  it('maps every App menu item to an action', () => {
    // Menu items are written `item: { id: …`; templated ids end in `*`.
    const items = new Set(
      [...app.matchAll(/item: \{\s*id: (?:'([^']+)'|`([^`$]+)\$\{)/g)].map(
        (match) => match[1] ?? `${match[2]}*`
      )
    );
    items.add(SELECT_OTHER_ITEM_ID);
    items.add(LOOK_AT_FACE_ITEM_ID);
    const registered = new Set(
      ACTIONS.flatMap((entry) => entry.menuItems.map((item) => item.item))
    );
    expect([...registered].sort()).toEqual([...items].sort());
  });

  it('maps every verb-rail verb to an action', () => {
    expect(selectionVerbAction('tool:fillet')).toBe('tool-fillet');
    expect(selectionVerbAction('action:offset-face')).toBe(
      'selection-offset-face'
    );
    // `SELECTION_ACTIONS` is exhaustive by type; the other verb ids are
    // the union's literal members.
    const callout = read('lib/selectionCallout.ts');
    const union = block(callout, 'export type SelectionCalloutVerbId =', ';');
    for (const verb of literalIds(union, /\| '([^']+)'/g)) {
      expect(actionEntry(selectionVerbAction(verb)), verb).toBeDefined();
    }
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

  it('holds the keys surfaces handle themselves', () => {
    expect(app).toContain(
      "async function handleSketchClipboardKey(key: 'a' | 'c' | 'v')"
    );
    const timeline = read('components/assembly/MotionStudyTimeline.tsx');
    expect(timeline).toContain("event.key === '[') jumpKey(-1)");
    expect(timeline).toContain("event.key === ']') jumpKey(1)");
    for (const id of [
      'sketch-select-all',
      'sketch-copy',
      'sketch-paste',
      'motion-previous-key',
      'motion-next-key'
    ]) {
      expect(actionEntry(id)?.sources, id).toEqual(['fixed-key']);
    }
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
