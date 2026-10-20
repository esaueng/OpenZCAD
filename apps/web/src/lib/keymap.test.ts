import { afterEach, describe, expect, it } from 'vitest';
import {
  activeKeymap,
  bindingConflict,
  bindingRefusal,
  chordFromEvent,
  chordLeavesTypingAlone,
  commandTool,
  contextsOverlap,
  KEYMAP_COMMANDS,
  KEYMAP_GROUPS,
  keymapCommand,
  keyHint,
  labelWithKey,
  resolveKeymap,
  setActiveKeymapOverrides,
  toolCommandId,
  withBindings,
  withoutOverride
} from './keymap';
import { liveControlKeys, liveKeyboardGroups } from './controlReference';
import { TOOL_META, type ToolId } from './tools';

const DEFAULTS = resolveKeymap({});

function key(
  key: string,
  modifiers: Partial<
    Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>
  > = {},
  code = ''
) {
  return {
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers
  };
}

afterEach(() => setActiveKeymapOverrides({}));

describe('keymap registry', () => {
  it('ships the documented default table', () => {
    // The keymap table: every default binding the workspace ships, by
    // command. A change here is a change to what users' fingers know.
    expect(
      Object.fromEntries(
        KEYMAP_COMMANDS.filter((command) => command.defaults.length > 0).map(
          (command) => [command.id, command.defaults.join(' ')]
        )
      )
    ).toEqual({
      'app-settings': 'Ctrl+,',
      'command-palette': 'Ctrl+K',
      'command-slash': '/',
      'assistant-toggle': 'Ctrl+J',
      'file-save': 'Ctrl+S',
      'file-save-named': 'Ctrl+Shift+S',
      'edit-undo': 'Ctrl+Z',
      'edit-redo': 'Ctrl+Shift+Z Ctrl+Y',
      'shortcut-reference': '?',
      'view-front': '1',
      'view-top': '2',
      'view-right': '3',
      'view-iso': '4',
      'view-fit': 'F',
      'view-normal-to-face': 'Space',
      'view-grid': 'G',
      'view-display': 'W',
      'view-projection': 'P',
      'selection-filter': 'Q',
      'workspace-mode-cycle': 'Ctrl+Shift+M',
      'view-measure': 'M',
      'tool-sketch': 'S',
      'tool-box': 'B',
      'tool-cylinder': 'C',
      'tool-extrude': 'E',
      'tool-revolve': 'R',
      'tool-transform': 'M',
      'tool-union': 'U',
      'tool-subtract': 'X',
      'tool-intersect': 'I',
      'sketch-select': 'V',
      'sketch-line': 'L',
      'sketch-arc': 'A',
      'sketch-circle': 'C',
      'sketch-rectangle': 'R',
      'sketch-polygon': 'P',
      'sketch-ellipse': 'O',
      'sketch-spline': 'S',
      'sketch-text': 'T',
      'sketch-project': 'U',
      'sketch-extrude': 'E'
    });
  });

  it('lists every tool, so any of them can be given a key', () => {
    for (const tool of Object.keys(TOOL_META) as ToolId[]) {
      const command = keymapCommand(toolCommandId(tool));
      expect(command?.context, tool).toBe('build');
      expect(commandTool(toolCommandId(tool))).toBe(tool);
    }
    expect(commandTool('view-fit')).toBeNull();
  });

  it('ships no clashing defaults', () => {
    for (const command of KEYMAP_COMMANDS) {
      for (const chord of command.defaults) {
        expect(
          bindingConflict(DEFAULTS, command.id, chord)?.id,
          `${command.id} ${chord}`
        ).toBeUndefined();
      }
    }
  });

  it('keeps ids unique and names unique within a group', () => {
    const ids = KEYMAP_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of KEYMAP_GROUPS) {
      const labels = KEYMAP_COMMANDS.filter(
        (command) => command.group === group.id
      ).map((command) => command.label);
      expect(new Set(labels).size, group.id).toBe(labels.length);
    }
  });

  it('lets one key mean one thing per context', () => {
    // M is Move while modeling and Measure while reading; C is Cylinder in
    // the workspace and Circle in a sketch.
    expect(DEFAULTS.commandFor('M', ['model', 'build'])?.id).toBe(
      'tool-transform'
    );
    expect(DEFAULTS.commandFor('M', ['model', 'view'])?.id).toBe(
      'view-measure'
    );
    expect(DEFAULTS.commandFor('C', ['model', 'build'])?.id).toBe(
      'tool-cylinder'
    );
    expect(DEFAULTS.commandFor('C', ['sketch'])?.id).toBe('sketch-circle');
    expect(DEFAULTS.commandFor('Ctrl+Z', ['global'])?.id).toBe('edit-undo');
    expect(DEFAULTS.commandFor('Shift+B', ['model', 'build'])).toBeNull();
    expect(DEFAULTS.commandFor(null, ['global'])).toBeNull();
    expect(contextsOverlap('global', 'sketch')).toBe(true);
    expect(contextsOverlap('model', 'sketch')).toBe(false);
    expect(contextsOverlap('build', 'view')).toBe(false);
    expect(contextsOverlap('model', 'view')).toBe(true);
  });
});

describe('chordFromEvent', () => {
  it('spells keydowns in the stored grammar', () => {
    expect(chordFromEvent(key('b'))).toBe('B');
    expect(chordFromEvent(key('B', { shiftKey: true }))).toBe('Shift+B');
    // Caps Lock is not Shift.
    expect(chordFromEvent(key('B'))).toBe('B');
    expect(chordFromEvent(key('?', { shiftKey: true }))).toBe('?');
    expect(chordFromEvent(key(' ', {}, 'Space'))).toBe('Space');
    expect(chordFromEvent(key(',', { metaKey: true }))).toBe('Ctrl+,');
    expect(
      chordFromEvent(key('Z', { ctrlKey: true, shiftKey: true }, 'KeyZ'))
    ).toBe('Ctrl+Shift+Z');
    // Ctrl keeps the layout's letter: AZERTY's Z sits where QWERTY has W.
    expect(chordFromEvent(key('z', { ctrlKey: true }, 'KeyW'))).toBe('Ctrl+Z');
    // A layout with no Latin letter there falls back to the physical key.
    expect(chordFromEvent(key('я', { ctrlKey: true }, 'KeyZ'))).toBe('Ctrl+Z');
    // Option on a Mac turns M into µ; the physical key decides.
    expect(chordFromEvent(key('µ', { altKey: true }, 'KeyM'))).toBe('Alt+M');
    expect(chordFromEvent(key('Escape'))).toBe('Escape');
    expect(chordFromEvent(key('+', { ctrlKey: true }))).toBe('Ctrl++');
  });

  it('reads AltGr as the character it types, not a Ctrl+Alt chord', () => {
    const altGr = (code: string, produced: string) => ({
      ...key(produced, { ctrlKey: true, altKey: true }, code),
      getModifierState: (state: string) => state === 'AltGraph'
    });
    // German AltGr+Q types @; it must not become Ctrl+Alt+Q.
    expect(chordFromEvent(altGr('KeyQ', '@'))).toBe('@');
    expect(chordFromEvent(altGr('KeyL', 'ł'))).toBe('ł');
    // Without AltGraph, the same modifiers are a real chord.
    expect(
      chordFromEvent(key('q', { ctrlKey: true, altKey: true }, 'KeyQ'))
    ).toBe('Ctrl+Alt+Q');
  });

  it('ignores a bare modifier', () => {
    expect(chordFromEvent(key('Shift', { shiftKey: true }))).toBeNull();
    expect(chordFromEvent(key('Meta', { metaKey: true }))).toBeNull();
  });
});

describe('remapping', () => {
  it('moves a command to a free key', () => {
    const overrides = withBindings({}, 'view-grid', ['H']);
    const keymap = resolveKeymap(overrides);
    expect(keymap.bindings('view-grid')).toEqual(['H']);
    expect(keymap.commandFor('H', ['model'])?.id).toBe('view-grid');
    expect(keymap.commandFor('G', ['model'])).toBeNull();
    expect(keymap.label('view-grid')).toBe('H');
  });

  it('refuses a taken key and names the command that has it', () => {
    expect(bindingRefusal(DEFAULTS, 'view-grid', 'F')).toBe(
      'F is already Fit view. Remove it there first.'
    );
    // A global chord clashes with every context, sketches included.
    expect(bindingRefusal(DEFAULTS, 'sketch-line', 'Ctrl+S')).toBe(
      'Ctrl/Cmd+S is already Save a revision. Remove it there first.'
    );
    expect(bindingRefusal(DEFAULTS, 'app-settings', 'L')).toBe(
      'L is already Line. Remove it there first.'
    );
    // Contexts that never hold at once do not clash.
    expect(bindingRefusal(DEFAULTS, 'view-measure', 'B')).toBeNull();
    expect(bindingRefusal(DEFAULTS, 'sketch-line', 'B')).toBeNull();
  });

  it('refuses a key the command already has, rather than listing it twice', () => {
    expect(bindingRefusal(DEFAULTS, 'view-fit', 'F')).toBe(
      'F is already a shortcut for Fit view.'
    );
  });

  it('frees a key once it is removed from its owner', () => {
    const freed = resolveKeymap(withBindings({}, 'view-fit', []));
    expect(freed.bindings('view-fit')).toEqual([]);
    expect(freed.label('view-fit')).toBeUndefined();
    expect(bindingRefusal(freed, 'view-grid', 'F')).toBeNull();
  });

  it('keeps the fixed keys and the browser chords out of the keymap', () => {
    expect(bindingRefusal(DEFAULTS, 'view-fit', 'Escape')).toBe(
      'Escape is kept for stepping back.'
    );
    expect(bindingRefusal(DEFAULTS, 'view-fit', 'Delete')).toBe(
      'Delete is kept for deleting the selection.'
    );
    expect(bindingRefusal(DEFAULTS, 'view-fit', 'Alt+ArrowDown')).toBe(
      'Alt+↓ is kept for moving through lists.'
    );
    expect(bindingRefusal(DEFAULTS, 'view-fit', 'Ctrl+W')).toBe(
      'Ctrl/Cmd+W belongs to the browser and never reaches the workspace.'
    );
  });

  it('stores nothing for a command put back to its defaults', () => {
    const changed = withBindings({}, 'edit-redo', ['Ctrl+Shift+Z']);
    expect(changed).toEqual({ 'edit-redo': ['Ctrl+Shift+Z'] });
    expect(
      withBindings(changed, 'edit-redo', ['Ctrl+Shift+Z', 'Ctrl+Y'])
    ).toEqual({});
    expect(withoutOverride(changed, 'edit-redo')).toEqual({});
  });

  it('resets one command without touching the others', () => {
    const overrides = withBindings(
      withBindings({}, 'view-grid', ['H']),
      'view-fit',
      ['J']
    );
    const reset = resolveKeymap(withoutOverride(overrides, 'view-grid'));
    expect(reset.bindings('view-grid')).toEqual(['G']);
    expect(reset.bindings('view-fit')).toEqual(['J']);
  });

  it('publishes the live keymap to every surface', () => {
    const overrides = withBindings({}, 'view-grid', ['H']);
    setActiveKeymapOverrides(overrides);
    expect(activeKeymap().label('view-grid')).toBe('H');
    expect(labelWithKey('Toggle grid', activeKeymap().label('view-grid'))).toBe(
      'Toggle grid (H)'
    );
    expect(labelWithKey('Toggle grid', undefined)).toBe('Toggle grid');
  });
});

describe('typing and hints', () => {
  it('lets only modifier chords and function keys through a text field', () => {
    expect(chordLeavesTypingAlone('Ctrl+,')).toBe(true);
    expect(chordLeavesTypingAlone('Alt+M')).toBe(true);
    expect(chordLeavesTypingAlone('F2')).toBe(true);
    expect(chordLeavesTypingAlone('Shift+F2')).toBe(true);
    // These type, or move the caret.
    for (const chord of ['K', 'Shift+K', '?', 'Space', 'Home', 'PageDown']) {
      expect(chordLeavesTypingAlone(chord), chord).toBe(false);
    }
  });

  it('names the live key in hint copy, or nothing when unbound', () => {
    expect(keyHint(DEFAULTS, 'tool-union', 'union')).toBe('U union');
    const unbound = resolveKeymap(withBindings({}, 'tool-union', []));
    expect(keyHint(unbound, 'tool-union', 'union')).toBeNull();
    const moved = resolveKeymap(withBindings({}, 'tool-union', ['J']));
    expect(keyHint(moved, 'tool-union', 'union')).toBe('J union');
  });
});

describe('the control reference draws live keys', () => {
  it('shows a remap in place of the default', () => {
    const keymap = resolveKeymap(withBindings({}, 'view-grid', ['H']));
    const view = liveKeyboardGroups(keymap).find(
      (group) => group.id === 'view-display'
    );
    const grid = view?.items.find((item) => item.id === 'toggle-grid');
    expect(grid && liveControlKeys(grid, keymap)).toEqual(['H']);
    expect(grid?.keys).toEqual(['H']);
  });

  it('lists a tool the user gave a key', () => {
    const keymap = resolveKeymap(withBindings({}, 'tool-fillet', ['J']));
    const tools = liveKeyboardGroups(keymap).find(
      (group) => group.id === 'modeling-tools'
    );
    expect(
      tools?.items.find((item) => item.id === 'tool-fillet')
    ).toMatchObject({ keys: ['J'], action: TOOL_META.fillet.label });
    expect(
      liveKeyboardGroups(DEFAULTS)
        .find((group) => group.id === 'modeling-tools')
        ?.items.some((item) => item.id === 'tool-fillet')
    ).toBe(false);
  });
});
