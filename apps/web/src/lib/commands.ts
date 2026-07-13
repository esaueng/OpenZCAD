// ---------------------------------------------------------------------------
// Command registry
//
// Every user-facing command is declared once here — label, category, shortcut,
// availability, contextual relevance — and every surface (tool palette,
// command search, context menus, keyboard map, shortcut sheet) renders from
// this single source. Handlers stay in App; the registry is pure data so it
// can be unit-tested without React.
// ---------------------------------------------------------------------------

export type WorkspaceId = 'model' | 'visualize';

export type CommandCategory =
  | 'select'
  | 'sketch'
  | 'create'
  | 'modify'
  | 'combine'
  | 'view'
  | 'file';

export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  select: 'Select',
  sketch: 'Sketch',
  create: 'Create',
  modify: 'Modify',
  combine: 'Combine',
  view: 'View',
  file: 'File'
};

/**
 * Snapshot of everything availability and contextual ranking depend on.
 * Rebuilt by App on selection/document changes; cheap value object.
 */
export interface CommandContext {
  sketchCount: number;
  liveBodyCount: number;
  /** Bodies currently selected (viewport or tree), in pick order. */
  selectedBodyCount: number;
  /** True when the selected feature is a sketch. */
  sketchSelected: boolean;
  featureSelected: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canExport: boolean;
  workspace: WorkspaceId;
}

export interface CommandSpec {
  id: string;
  label: string;
  /** Icon name resolved by the UI layer (kept as a string so this stays pure). */
  icon: string;
  category: CommandCategory;
  /** Display shortcut, e.g. "E", "⌘Z". Registered keys live in the keymap. */
  shortcut?: string;
  hint: string;
  isEnabled(ctx: CommandContext): boolean;
  /** Why the command is unavailable right now (shown in tooltips/search). */
  disabledReason(ctx: CommandContext): string | null;
  /**
   * Relevance for the current selection; commands scoring > 0 surface in the
   * contextual palette group and at the top of context menus. Higher first.
   */
  contextScore(ctx: CommandContext): number;
}

const always = () => true;
const never = () => null;

function needsSketch(ctx: CommandContext): boolean {
  return ctx.sketchCount > 0;
}

const NEEDS_SKETCH_REASON = 'Create a sketch first.';

export const COMMANDS: CommandSpec[] = [
  {
    id: 'select',
    label: 'Select',
    icon: 'MousePointer2',
    category: 'select',
    shortcut: 'Esc',
    hint: 'Return to the selection tool. Esc also cancels the active command.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'sketch.create',
    label: 'Create Sketch',
    icon: 'PenLine',
    category: 'sketch',
    shortcut: 'K',
    hint: 'Draw a rectangle, circle, or polygon profile on a plane.',
    isEnabled: always,
    disabledReason: never,
    contextScore: (ctx) => (ctx.sketchCount === 0 && ctx.liveBodyCount === 0 ? 1 : 0)
  },
  {
    id: 'extrude',
    label: 'Extrude',
    icon: 'Layers',
    category: 'sketch',
    shortcut: 'E',
    hint: 'Pull a sketch profile into a solid. Drag the arrow or type a distance.',
    isEnabled: needsSketch,
    disabledReason: (ctx) => (needsSketch(ctx) ? null : NEEDS_SKETCH_REASON),
    contextScore: (ctx) => (ctx.sketchSelected ? 10 : 0)
  },
  {
    id: 'revolve',
    label: 'Revolve',
    icon: 'RotateCw',
    category: 'sketch',
    shortcut: 'R',
    hint: 'Sweep a sketch profile a full turn around an axis.',
    isEnabled: needsSketch,
    disabledReason: (ctx) => (needsSketch(ctx) ? null : NEEDS_SKETCH_REASON),
    contextScore: (ctx) => (ctx.sketchSelected ? 9 : 0)
  },
  {
    id: 'primitive.box',
    label: 'Box',
    icon: 'Box',
    category: 'create',
    shortcut: 'B',
    hint: 'Create a parametric box.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'primitive.cylinder',
    label: 'Cylinder',
    icon: 'Cylinder',
    category: 'create',
    shortcut: 'C',
    hint: 'Create a parametric cylinder.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'primitive.sphere',
    label: 'Sphere',
    icon: 'Globe',
    category: 'create',
    hint: 'Create a parametric sphere.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'primitive.cone',
    label: 'Cone',
    icon: 'Cone',
    category: 'create',
    hint: 'Create a parametric cone or frustum.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'primitive.torus',
    label: 'Torus',
    icon: 'Torus',
    category: 'create',
    hint: 'Create a parametric torus.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'move',
    label: 'Move / Rotate',
    icon: 'Move3d',
    category: 'modify',
    shortcut: 'M',
    hint: 'Translate and rotate a body with the triad or exact values.',
    isEnabled: (ctx) => ctx.liveBodyCount >= 1,
    disabledReason: (ctx) => (ctx.liveBodyCount >= 1 ? null : 'Create a body first.'),
    contextScore: (ctx) => (ctx.selectedBodyCount === 1 ? 10 : 0)
  },
  {
    id: 'boolean.union',
    label: 'Union',
    icon: 'Combine',
    category: 'combine',
    hint: 'Fuse two or more bodies into one.',
    isEnabled: (ctx) => ctx.liveBodyCount >= 2,
    disabledReason: (ctx) => (ctx.liveBodyCount >= 2 ? null : 'Needs at least two bodies.'),
    contextScore: (ctx) => (ctx.selectedBodyCount >= 2 ? 10 : 0)
  },
  {
    id: 'boolean.subtract',
    label: 'Subtract',
    icon: 'Scissors',
    category: 'combine',
    hint: 'Cut bodies out of the first-picked body.',
    isEnabled: (ctx) => ctx.liveBodyCount >= 2,
    disabledReason: (ctx) => (ctx.liveBodyCount >= 2 ? null : 'Needs at least two bodies.'),
    contextScore: (ctx) => (ctx.selectedBodyCount >= 2 ? 9 : 0)
  },
  {
    id: 'boolean.intersect',
    label: 'Intersect',
    icon: 'Shapes',
    category: 'combine',
    hint: 'Keep only the overlapping volume of the picked bodies.',
    isEnabled: (ctx) => ctx.liveBodyCount >= 2,
    disabledReason: (ctx) => (ctx.liveBodyCount >= 2 ? null : 'Needs at least two bodies.'),
    contextScore: (ctx) => (ctx.selectedBodyCount >= 2 ? 8 : 0)
  },
  {
    id: 'delete',
    label: 'Delete',
    icon: 'Trash2',
    category: 'modify',
    shortcut: 'Del',
    hint: 'Delete the selected feature. Dependents degrade to warnings.',
    isEnabled: (ctx) => ctx.featureSelected,
    disabledReason: (ctx) => (ctx.featureSelected ? null : 'Select a feature first.'),
    contextScore: (ctx) => (ctx.featureSelected ? 1 : 0)
  },
  {
    id: 'view.fit',
    label: 'Fit View',
    icon: 'Maximize2',
    category: 'view',
    shortcut: 'F',
    hint: 'Frame all visible geometry.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'view.fitSelection',
    label: 'Fit Selection',
    icon: 'Focus',
    category: 'view',
    shortcut: '⇧F',
    hint: 'Frame the selected bodies.',
    isEnabled: (ctx) => ctx.selectedBodyCount > 0,
    disabledReason: (ctx) => (ctx.selectedBodyCount > 0 ? null : 'Select a body first.'),
    contextScore: (ctx) => (ctx.selectedBodyCount > 0 ? 2 : 0)
  },
  {
    id: 'view.front',
    label: 'Front View',
    icon: 'Square',
    category: 'view',
    shortcut: '1',
    hint: 'Look along -Z at the front of the model.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'view.top',
    label: 'Top View',
    icon: 'Square',
    category: 'view',
    shortcut: '2',
    hint: 'Look straight down.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'view.right',
    label: 'Right View',
    icon: 'Square',
    category: 'view',
    shortcut: '3',
    hint: 'Look along -X at the right side.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'view.iso',
    label: 'Isometric View',
    icon: 'Axis3d',
    category: 'view',
    shortcut: '0',
    hint: 'Return to the home isometric view.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'view.projection',
    label: 'Toggle Perspective / Orthographic',
    icon: 'Camera',
    category: 'view',
    shortcut: 'P',
    hint: 'Switch the camera projection.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'view.grid',
    label: 'Toggle Grid',
    icon: 'Grid3x3',
    category: 'view',
    shortcut: 'G',
    hint: 'Show or hide the ground grid.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'view.showAll',
    label: 'Show All Bodies',
    icon: 'Eye',
    category: 'view',
    hint: 'Unhide every hidden body.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'undo',
    label: 'Undo',
    icon: 'Undo2',
    category: 'file',
    shortcut: '⌘Z',
    hint: 'Undo the last document change.',
    isEnabled: (ctx) => ctx.canUndo,
    disabledReason: (ctx) => (ctx.canUndo ? null : 'Nothing to undo.'),
    contextScore: () => 0
  },
  {
    id: 'redo',
    label: 'Redo',
    icon: 'Redo2',
    category: 'file',
    shortcut: '⇧⌘Z',
    hint: 'Redo the last undone change.',
    isEnabled: (ctx) => ctx.canRedo,
    disabledReason: (ctx) => (ctx.canRedo ? null : 'Nothing to redo.'),
    contextScore: () => 0
  },
  {
    id: 'save',
    label: 'Save Revision',
    icon: 'Save',
    category: 'file',
    shortcut: '⌘S',
    hint: 'Save a named revision of the project.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'export.step',
    label: 'Export STEP',
    icon: 'Download',
    category: 'file',
    hint: 'Export bodies as an ISO 10303-21 STEP file (AP214).',
    isEnabled: (ctx) => ctx.canExport,
    disabledReason: (ctx) => (ctx.canExport ? null : 'Create a body before exporting.'),
    contextScore: () => 0
  },
  {
    id: 'export.stl',
    label: 'Export STL',
    icon: 'Download',
    category: 'file',
    hint: 'Export bodies as an ASCII STL mesh.',
    isEnabled: (ctx) => ctx.canExport,
    disabledReason: (ctx) => (ctx.canExport ? null : 'Create a body before exporting.'),
    contextScore: () => 0
  },
  {
    id: 'import',
    label: 'Import File',
    icon: 'Upload',
    category: 'file',
    hint: 'Import an STL mesh (STEP metadata is read-only for now).',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'search',
    label: 'Search Commands',
    icon: 'Search',
    category: 'file',
    shortcut: 'S',
    hint: 'Find any command by name.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  },
  {
    id: 'help.shortcuts',
    label: 'Keyboard Shortcuts',
    icon: 'Keyboard',
    category: 'file',
    shortcut: '?',
    hint: 'Show the searchable shortcut reference.',
    isEnabled: always,
    disabledReason: never,
    contextScore: () => 0
  }
];

const COMMANDS_BY_ID = new Map(COMMANDS.map((command) => [command.id, command]));

export function getCommand(id: string): CommandSpec | undefined {
  return COMMANDS_BY_ID.get(id);
}

/** Tool palette layout: which command IDs belong to each visible group. */
export const PALETTE_GROUPS: { category: CommandCategory; commandIds: string[] }[] = [
  { category: 'sketch', commandIds: ['sketch.create', 'extrude', 'revolve'] },
  {
    category: 'create',
    commandIds: [
      'primitive.box',
      'primitive.cylinder',
      'primitive.sphere',
      'primitive.cone',
      'primitive.torus'
    ]
  },
  { category: 'modify', commandIds: ['move', 'delete'] },
  { category: 'combine', commandIds: ['boolean.union', 'boolean.subtract', 'boolean.intersect'] }
];

/**
 * Commands relevant to the current selection, best first. Drives the
 * contextual palette group and the top of context menus. Context improves
 * prioritization only — every command stays reachable through its group.
 */
export function contextualCommands(ctx: CommandContext, limit = 5): CommandSpec[] {
  return COMMANDS.map((command) => ({ command, score: command.contextScore(ctx) }))
    .filter((entry) => entry.score > 0 && entry.command.isEnabled(ctx))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.command);
}

export interface SearchResult {
  command: CommandSpec;
  enabled: boolean;
  reason: string | null;
}

/**
 * Ranked command search: word-prefix matches beat substring matches; enabled
 * commands beat disabled ones (which stay listed with their reason).
 */
export function searchCommands(query: string, ctx: CommandContext): SearchResult[] {
  const needle = query.trim().toLowerCase();
  const scored: { result: SearchResult; score: number }[] = [];
  for (const command of COMMANDS) {
    const haystack = `${command.label} ${CATEGORY_LABELS[command.category]}`.toLowerCase();
    let score = 0;
    if (needle.length === 0) {
      score = 1;
    } else if (haystack.startsWith(needle)) {
      score = 100;
    } else if (haystack.split(/\s+/).some((word) => word.startsWith(needle))) {
      score = 60;
    } else if (haystack.includes(needle)) {
      score = 30;
    }
    if (score === 0) {
      continue;
    }
    const enabled = command.isEnabled(ctx);
    scored.push({
      result: { command, enabled, reason: enabled ? null : command.disabledReason(ctx) },
      score: score + (enabled ? 5 : 0)
    });
  }
  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.result);
}

/**
 * Physical-key → command map used by the global keydown handler. Modifier
 * combos (undo/redo/save/search) are handled explicitly in the keymap logic;
 * these are the plain single-key tool shortcuts.
 */
export const PLAIN_KEY_COMMANDS: Record<string, string> = {
  k: 'sketch.create',
  e: 'extrude',
  r: 'revolve',
  b: 'primitive.box',
  c: 'primitive.cylinder',
  m: 'move',
  f: 'view.fit',
  g: 'view.grid',
  p: 'view.projection',
  s: 'search',
  '1': 'view.front',
  '2': 'view.top',
  '3': 'view.right',
  '0': 'view.iso',
  '?': 'help.shortcuts'
};
