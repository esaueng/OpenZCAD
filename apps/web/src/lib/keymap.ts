import { useSyncExternalStore } from 'react';
import {
  canonicalChord,
  KEYMAP_LIMITS,
  type KeymapOverrides
} from '@openzcad/shared';
import { platformShortcutLabel } from './platformShortcut';
import { TOOL_GROUPS, TOOL_META, type ToolId } from './tools';

/**
 * Where a binding is live, which is what decides whether two bindings clash.
 *
 * - `global`: everywhere a document is open, sketches included (Ctrl chords).
 * - `model`: the workspace outside a sketch, in every mode.
 * - `build`: outside a sketch while modeling is unlocked (the tools).
 * - `view`: outside a sketch while modeling is locked (Measure).
 * - `sketch`: inside a sketch session, which takes the single keys over.
 *
 * `build` and `view` never hold at once, so M can be Move in one and Measure
 * in the other; a sketch hands its keys back on exit, so C can be Cylinder
 * and Circle.
 */
export type KeymapContext = 'global' | 'model' | 'build' | 'view' | 'sketch';

export type KeymapGroupId =
  | 'workspace'
  | 'view-display'
  | 'selection-editing'
  | 'view-mode'
  | 'modeling-tools'
  | 'sketch-mode';

export interface KeymapCommand {
  /** Shared with the command bar's row for the same command, where it has one. */
  id: string;
  label: string;
  group: KeymapGroupId;
  context: KeymapContext;
  defaults: readonly string[];
}

export const KEYMAP_GROUPS: readonly { id: KeymapGroupId; title: string }[] = [
  { id: 'workspace', title: 'Workspace & history' },
  { id: 'view-display', title: 'View & display' },
  { id: 'selection-editing', title: 'Selection' },
  { id: 'view-mode', title: 'View mode' },
  { id: 'modeling-tools', title: 'Modeling tools' },
  { id: 'sketch-mode', title: 'Sketch mode' }
];

const command = (
  id: string,
  label: string,
  group: KeymapGroupId,
  context: KeymapContext,
  ...defaults: string[]
): KeymapCommand => ({ id, label, group, context, defaults });

/**
 * Every remappable shortcut, in the order Settings lists them. Escape, Enter,
 * Tab, Delete and the arrows are not here: they carry the step-back, confirm,
 * focus and list contracts every surface relies on (`RESERVED_KEYS`).
 */
export const KEYMAP_COMMANDS: readonly KeymapCommand[] = [
  command('app-settings', 'Open settings', 'workspace', 'global', 'Ctrl+,'),
  command(
    'command-palette',
    'Open the command bar',
    'workspace',
    'global',
    'Ctrl+K'
  ),
  command('command-slash', 'Type a command', 'workspace', 'model', '/'),
  command(
    'assistant-toggle',
    'Show or hide the assistant',
    'workspace',
    'global',
    'Ctrl+J'
  ),
  command('file-save', 'Save a revision', 'workspace', 'global', 'Ctrl+S'),
  command(
    'file-save-named',
    'Save a named revision',
    'workspace',
    'global',
    'Ctrl+Shift+S'
  ),
  command('edit-undo', 'Undo', 'workspace', 'global', 'Ctrl+Z'),
  command('edit-redo', 'Redo', 'workspace', 'global', 'Ctrl+Shift+Z', 'Ctrl+Y'),
  command(
    'shortcut-reference',
    'Open the shortcut reference',
    'workspace',
    'model',
    '?'
  ),
  command('view-front', 'Front view', 'view-display', 'model', '1'),
  command('view-top', 'Top view', 'view-display', 'model', '2'),
  command('view-right', 'Right view', 'view-display', 'model', '3'),
  command('view-iso', 'Isometric view', 'view-display', 'model', '4'),
  command('view-back', 'Back view', 'view-display', 'model', '5'),
  command('view-bottom', 'Bottom view', 'view-display', 'model', '6'),
  command('view-left', 'Left view', 'view-display', 'model', '7'),
  command('view-fit', 'Fit view', 'view-display', 'model', 'F'),
  command(
    'view-normal-to-face',
    'Normal to selected face',
    'view-display',
    'model',
    'Space'
  ),
  command('view-grid', 'Toggle the grid', 'view-display', 'model', 'G'),
  command('view-display', 'Cycle display mode', 'view-display', 'model', 'W'),
  command('view-projection', 'Toggle projection', 'view-display', 'model', 'P'),
  command('view-xray', 'Toggle X-ray', 'view-display', 'model', 'Shift+X'),
  // Not Tab, which moves focus: a Ctrl chord also works from a field.
  command(
    'panels-hide-all',
    'Hide or show the model panels',
    'view-display',
    'global',
    'Ctrl+\\'
  ),
  command(
    'selection-filter',
    'Cycle the selection filter',
    'selection-editing',
    'model',
    'Q'
  ),
  command(
    'workspace-mode-cycle',
    'Cycle View, Tweak and Build',
    'view-mode',
    'global',
    'Ctrl+Shift+M'
  ),
  command('view-measure', 'Measure', 'view-mode', 'view', 'M'),
  // Every tool, bound or not, so a user can give any of them a key.
  ...TOOL_GROUPS.flatMap((group) =>
    group.tools.map((tool) =>
      command(
        toolCommandId(tool),
        TOOL_META[tool].label,
        'modeling-tools',
        'build',
        ...[TOOL_META[tool].shortcut].filter((key) => key !== undefined)
      )
    )
  ),
  command('sketch-select', 'Select', 'sketch-mode', 'sketch', 'V'),
  command('sketch-line', 'Line', 'sketch-mode', 'sketch', 'L'),
  command('sketch-arc', 'Arc', 'sketch-mode', 'sketch', 'A'),
  // Pressed again on the circle tool, it steps the circle type.
  command('sketch-circle', 'Circle', 'sketch-mode', 'sketch', 'C'),
  // Pressed again on the rectangle tool, it steps the rectangle type.
  command('sketch-rectangle', 'Rectangle', 'sketch-mode', 'sketch', 'R'),
  command('sketch-polygon', 'Polygon', 'sketch-mode', 'sketch', 'P'),
  // Pressed again on its tool, each steps between that tool's two types.
  command('sketch-ellipse', 'Ellipse', 'sketch-mode', 'sketch', 'O'),
  command('sketch-spline', 'Spline', 'sketch-mode', 'sketch', 'S'),
  command('sketch-text', 'Text', 'sketch-mode', 'sketch', 'T'),
  // Pressed again on its tool, it steps between linked and unlinked.
  command('sketch-project', 'Project edges', 'sketch-mode', 'sketch', 'U'),
  command('sketch-extrude', 'Extrude the sketch', 'sketch-mode', 'sketch', 'E')
];

export function toolCommandId(tool: ToolId): string {
  return `tool-${tool}`;
}

/** The tool a `tool-…` command launches, or null for any other command. */
export function commandTool(id: string): ToolId | null {
  const tool = id.startsWith('tool-') ? id.slice(5) : '';
  return tool in TOOL_META ? (tool as ToolId) : null;
}

const COMMANDS_BY_ID = new Map(KEYMAP_COMMANDS.map((item) => [item.id, item]));

export function keymapCommand(id: string): KeymapCommand | undefined {
  return COMMANDS_BY_ID.get(id);
}

/** Whether a binding in one context can fire while one in the other is live. */
export function contextsOverlap(a: KeymapContext, b: KeymapContext): boolean {
  if (a === b || a === 'global' || b === 'global') return true;
  if (a === 'sketch' || b === 'sketch') return false;
  // model, build and view: only build and view exclude each other.
  return !((a === 'build' && b === 'view') || (a === 'view' && b === 'build'));
}

/** Keys that keep one meaning everywhere, with what they are kept for. */
const RESERVED_KEYS: Readonly<Record<string, string>> = {
  Escape: 'stepping back',
  Enter: 'confirming',
  Tab: 'moving focus',
  Delete: 'deleting the selection',
  Backspace: 'deleting the selection',
  ArrowUp: 'moving through lists',
  ArrowDown: 'moving through lists',
  ArrowLeft: 'moving through lists',
  ArrowRight: 'moving through lists'
};

/** Chords the browser acts on before a page sees them. */
const BROWSER_CHORDS = new Set([
  'Ctrl+N',
  'Ctrl+T',
  'Ctrl+W',
  'Ctrl+Q',
  'Ctrl+Shift+N',
  'Ctrl+Shift+T',
  'Ctrl+Shift+W'
]);

export interface Keymap {
  readonly overrides: KeymapOverrides;
  /** The command's live chords: its override, else unclaimed defaults. */
  bindings(id: string): readonly string[];
  /** The first live chord, for a tooltip or a palette row; none when unbound. */
  label(id: string): string | undefined;
  /**
   * The command a chord runs, searching the contexts in the order given and
   * the registry in its own order within each.
   */
  commandFor(
    chord: string | null,
    contexts: readonly KeymapContext[]
  ): KeymapCommand | null;
}

export function resolveKeymap(overrides: KeymapOverrides): Keymap {
  // A key that was free in an older release may already be someone's saved
  // shortcut. New defaults yield to that explicit choice across overlapping
  // contexts, even when the default's context is searched first (model before
  // build, for example). Every surface reads the same filtered bindings.
  const claimed = new Map<string, KeymapContext[]>();
  for (const item of KEYMAP_COMMANDS) {
    for (const chord of overrides[item.id] ?? []) {
      const contexts = claimed.get(chord) ?? [];
      contexts.push(item.context);
      claimed.set(chord, contexts);
    }
  }
  const defaults = new Map(
    KEYMAP_COMMANDS.map((item) => [
      item.id,
      item.defaults.filter(
        (chord) =>
          !claimed
            .get(chord)
            ?.some((context) => contextsOverlap(item.context, context))
      )
    ])
  );
  const byContext = new Map<KeymapContext, Map<string, KeymapCommand>>();
  const bindings = (id: string) => overrides[id] ?? defaults.get(id) ?? [];
  for (const item of KEYMAP_COMMANDS) {
    const table =
      byContext.get(item.context) ?? new Map<string, KeymapCommand>();
    byContext.set(item.context, table);
    for (const chord of bindings(item.id)) {
      // If stored explicit overrides clash, the first claim still wins
      // deterministically within a context.
      if (!table.has(chord)) table.set(chord, item);
    }
  }
  return {
    overrides,
    bindings,
    label: (id) => bindings(id)[0],
    commandFor(chord, contexts) {
      if (!chord) return null;
      for (const context of contexts) {
        const found = byContext.get(context)?.get(chord);
        if (found) return found;
      }
      return null;
    }
  };
}

/** The command already answering to a chord where `id` would be live. */
export function bindingConflict(
  keymap: Keymap,
  id: string,
  chord: string
): KeymapCommand | null {
  const target = keymapCommand(id);
  if (!target) return null;
  return (
    KEYMAP_COMMANDS.find(
      (other) =>
        other.id !== id &&
        contextsOverlap(target.context, other.context) &&
        keymap.bindings(other.id).includes(chord)
    ) ?? null
  );
}

/**
 * Why a chord cannot be given to a command, naming the command that already
 * has it when that is the reason; null when the binding can be made.
 */
export function bindingRefusal(
  keymap: Keymap,
  id: string,
  chord: string
): string | null {
  const shown = referenceKeyLabel(chord);
  const key = chord.slice(chord.lastIndexOf('+') + 1) || '+';
  const reserved = RESERVED_KEYS[key];
  if (reserved) return `${shown} is kept for ${reserved}.`;
  if (BROWSER_CHORDS.has(chord)) {
    return `${shown} belongs to the browser and never reaches the workspace.`;
  }
  if (keymap.bindings(id).includes(chord)) {
    return `${shown} is already a shortcut for ${keymapCommand(id)?.label ?? 'this command'}.`;
  }
  const clash = bindingConflict(keymap, id, chord);
  if (clash) {
    return `${shown} is already ${clash.label}. Remove it there first.`;
  }
  if (keymap.bindings(id).length >= KEYMAP_LIMITS.chordsPerCommand) {
    return `A command takes at most ${KEYMAP_LIMITS.chordsPerCommand} shortcuts.`;
  }
  return null;
}

/**
 * The overrides with a command's chords replaced. A list equal to the
 * defaults removes the override, so a reset leaves nothing stored behind.
 */
export function withBindings(
  overrides: KeymapOverrides,
  id: string,
  chords: readonly string[]
): KeymapOverrides {
  const defaults = keymapCommand(id)?.defaults ?? [];
  const next: Record<string, readonly string[]> = { ...overrides };
  if (
    chords.length === defaults.length &&
    chords.every((chord, index) => chord === defaults[index])
  ) {
    delete next[id];
  } else {
    next[id] = [...chords];
  }
  return next;
}

export function withoutOverride(
  overrides: KeymapOverrides,
  id: string
): KeymapOverrides {
  const next: Record<string, readonly string[]> = { ...overrides };
  delete next[id];
  return next;
}

const MODIFIER_KEYS = new Set([
  'Control',
  'Meta',
  'Shift',
  'Alt',
  'AltGraph',
  'CapsLock',
  'Fn',
  'OS',
  'Dead',
  'Process',
  'Unidentified'
]);
const KEY_ALIASES: Readonly<Record<string, string>> = {
  ' ': 'Space',
  Spacebar: 'Space',
  Esc: 'Escape',
  Del: 'Delete',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight'
};

/**
 * The chord a keydown spells, in the stored grammar, or null for a bare
 * modifier or a key the grammar has no name for. Ctrl and ⌘ are one modifier,
 * as they always were here. Under Alt the physical letter decides, since
 * Option on a Mac turns M into µ; under Ctrl the layout's letter does, so
 * AZERTY's Z (code KeyW) is still Ctrl+Z, and only a layout with no Latin
 * letter there (Cyrillic) falls back to the physical one.
 */
export function chordFromEvent(
  event: Pick<
    KeyboardEvent,
    'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
  > &
    Partial<Pick<KeyboardEvent, 'getModifierState'>>
): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  // AltGr types a character (German AltGr+Q is @) and some platforms report
  // it as Ctrl+Alt: the chord is the character typed, not a shortcut.
  if (event.getModifierState?.('AltGraph')) {
    return canonicalChord(KEY_ALIASES[event.key] ?? event.key);
  }
  const mod = event.ctrlKey || event.metaKey;
  let key: string;
  if (event.code === 'Space' || event.key === ' ') {
    key = 'Space';
  } else if (event.altKey && /^Key[A-Z]$/.test(event.code)) {
    key = event.code.slice(3);
  } else if (
    mod &&
    !/^[a-zA-Z]$/.test(event.key) &&
    /^Key[A-Z]$/.test(event.code)
  ) {
    key = event.code.slice(3);
  } else if (event.altKey && /^Digit[0-9]$/.test(event.code)) {
    key = event.code.slice(5);
  } else {
    key = KEY_ALIASES[event.key] ?? event.key;
  }
  return canonicalChord(
    [
      mod && 'Ctrl',
      event.altKey && 'Alt',
      event.shiftKey && 'Shift',
      key === '+' ? '' : key
    ]
      .filter((part) => part !== false)
      .join('+') + (key === '+' ? '+' : '')
  );
}

/**
 * Whether a chord leaves a text field's typing alone: it holds Ctrl or Alt,
 * or is a function key, which neither types nor moves the caret.
 */
export function chordLeavesTypingAlone(chord: string): boolean {
  return (
    chord.startsWith('Ctrl+') ||
    chord.startsWith('Alt+') ||
    /^(Shift\+)?F\d+$/.test(chord)
  );
}

const ARROWS: Readonly<Record<string, string>> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→'
};

/**
 * A chord as the control reference writes keys: platform-neutral, with
 * Ctrl/Cmd for the modifier that answers to either.
 */
export function referenceKeyLabel(chord: string): string {
  const key = chord.endsWith('++') || chord === '+' ? '+' : null;
  const parts = key
    ? [...chord.slice(0, -2).split('+'), '+']
    : chord.split('+');
  return parts
    .filter(Boolean)
    .map((part) => (part === 'Ctrl' ? 'Ctrl/Cmd' : (ARROWS[part] ?? part)))
    .join('+');
}

/**
 * An accessible name with its key the way the workspace has always written
 * it — "Fit view (F)" — or the bare name when the command is unbound.
 */
export function labelWithKey(label: string, chord: string | undefined): string {
  return chord ? `${label} (${platformShortcutLabel(chord)})` : label;
}

/**
 * Hint copy that names a command's live key — "E extrudes" — or null when the
 * command is unbound, so a lane line never points at a key that does nothing.
 */
export function keyHint(
  keymap: Keymap,
  id: string,
  action: string
): string | null {
  const chord = keymap.label(id);
  return chord ? `${platformShortcutLabel(chord)} ${action}` : null;
}

// The live keymap, set from the user's settings by the workspace and read by
// every surface that names a shortcut.
let active = resolveKeymap({});
const listeners = new Set<() => void>();

export function setActiveKeymapOverrides(overrides: KeymapOverrides): void {
  if (overrides === active.overrides) return;
  active = resolveKeymap(overrides);
  for (const listener of listeners) listener();
}

export function activeKeymap(): Keymap {
  return active;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The live keymap; re-renders when the user remaps a key. */
export function useKeymap(): Keymap {
  return useSyncExternalStore(subscribe, activeKeymap, activeKeymap);
}
