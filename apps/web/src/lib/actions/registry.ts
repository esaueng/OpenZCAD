import { ANNOTATION_TOOL_LABELS } from '../drawing/annotationPicking';
import {
  ANNOTATION_TOOL_KEYS,
  ANNOTATION_TOOLS,
  AUXILIARY_TOOL_KEY,
  DETAIL_TOOL_KEY,
  SECTION_TOOL_KEY
} from '../drawing/toolKeys';
import type { SelectionActionId } from '../interaction/capabilities';
import { KEYMAP_COMMANDS, toolCommandId } from '../keymap';
import { TOOL_GROUPS } from '../tools';
import { LOOK_AT_FACE_ITEM_ID, SELECT_OTHER_ITEM_ID } from '../viewportMenu';

/**
 * Every user-reachable action, once (U12 slice 1; plan in
 * `docs/plans/compact-mobile-workspace-plan-2026-11-26.md`).
 *
 * Today an action is named in up to five places that do not know about one
 * another: the remappable keymap, the command bar's rows, the right-click
 * menus, the selection verbs, and keys a surface handles itself (Draw's
 * letters, the sketch clipboard, the motion timeline). This list joins them
 * under one id per action, so the compact workspace can prove it reaches
 * every one of them. `registry.test.ts` reads each source and fails when an
 * action is added there without an entry here, or an entry outlives its
 * source.
 *
 * Ids: a keymap command and its command-bar row already share one id
 * (`keymap.ts`), and a tool's id is `tool-<tool>`. Menu items, whose own ids
 * are local to their menu (two menus have a `delete`), name the action they
 * run. The registry holds no behaviour yet: dispatch still lives where it
 * does today, and moves here surface by surface.
 *
 * Not yet covered, each joining with the slice that rebuilds its surface:
 * component-local menus (panel headers, sheet tabs, assembly rows), and the
 * per-document command-bar rows (one per feature and parameter), which are
 * data rather than actions.
 */

/** Where an action can be started from today. */
export type ActionSource =
  | 'keymap'
  | 'command-bar'
  | 'menu'
  | 'selection-verb'
  | 'drawing'
  | 'fixed-key'
  | 'pointer-gesture';

/** The App menus whose items the registry covers. */
export type ActionMenu = 'viewport' | 'selection' | 'history-row';

export interface ActionEntry {
  readonly id: string;
  /** A plain name for lists, reviews and the parity report. */
  readonly label: string;
  readonly sources: readonly ActionSource[];
  /** The menu items that run it, by their menu-local ids. */
  readonly menuItems: readonly { menu: ActionMenu; item: string }[];
  /** Keys outside the remappable keymap, or the pointer gesture. */
  readonly fixedKeys: readonly string[];
}

/**
 * The compact workspace's homes for an action (the plan's information
 * architecture). Later slices fill `COMPACT_ENTRIES` as they build each one.
 */
export type CompactSurface =
  | 'header'
  | 'project-sheet'
  | 'mode-tabs'
  | 'floating-controls'
  | 'context-tray'
  | 'all-tools'
  | 'tool-tray'
  | 'selection-sheet'
  | 'panel-sheet'
  | 'action-sheet'
  | 'view-tray'
  | 'tweak-sheet'
  | 'sketch-tray'
  | 'sketch-sheet'
  | 'assemble-sheet'
  | 'draw-tray'
  | 'command-search'
  | 'settings'
  | 'overflow-menu';

/** Each action's compact entry point; an action not listed is pending. */
export const COMPACT_ENTRIES: Readonly<
  Partial<Record<string, CompactSurface>>
> = {};

// ── Sources ────────────────────────────────────────────────────────────

/**
 * The command bar's fixed rows that have no keymap command, by their row id
 * in `App.tsx` (`paletteCommands`). Rows that share a keymap id take its
 * label; tool rows come from `TOOL_GROUPS`, and the unit rows from
 * `DISPLAY_UNIT_ROWS`.
 */
const COMMAND_BAR_ONLY: readonly (readonly [id: string, label: string])[] = [
  ['view-show-all', 'Show all bodies'],
  ['view-isolate-body', 'Isolate selected body'],
  ['view-section', 'Section view'],
  ['file-export-project', 'Export project'],
  ['file-import-project', 'Import project'],
  ['file-insert-project', 'Insert project'],
  ['file-export-face-dxf', 'Export face outline as DXF'],
  ['file-export-cnc-layout', 'Export CNC cut layout (DXF)'],
  ['file-export-flat-pattern', 'Flat pattern'],
  ['file-export-step', 'Export STEP'],
  ['file-export-mesh', 'Export mesh'],
  ['file-export-image', 'Export image'],
  ['file-export-diagnostics', 'Export diagnostics'],
  ['file-export-interaction-log', 'Export interaction log'],
  ['file-import', 'Import CAD files'],
  ['file-home', 'Back to projects'],
  ['workspace-mode-view', 'Switch to View mode'],
  ['workspace-mode-tweak', 'Switch to Tweak mode'],
  ['workspace-mode-build', 'Switch to Build mode'],
  ['workspace-mode-assemble', 'Switch to Assemble mode'],
  ['workspace-mode-drawing', 'Switch to Draw mode'],
  ['app-help', 'Help & keyboard shortcuts'],
  ['project-rename', 'Rename project'],
  ['project-duplicate', 'Duplicate project']
];

/** Keymap commands that also have a command-bar row of the same id. */
const KEYMAP_ROWS_IN_COMMAND_BAR: ReadonlySet<string> = new Set([
  'view-measure',
  'view-front',
  'view-top',
  'view-right',
  'view-iso',
  'view-back',
  'view-bottom',
  'view-left',
  'view-fit',
  'view-normal-to-face',
  'view-grid',
  'view-display',
  'view-projection',
  'view-xray',
  'view-orbit-mode',
  'edit-undo',
  'edit-redo',
  'file-save',
  'file-save-named',
  'app-settings'
]);

/** The command bar's per-unit rows (I03), `file-display-units-<unit>`. */
export const DISPLAY_UNIT_ROWS: readonly (readonly [
  unit: string,
  label: string
])[] = [
  ['mm', 'Show lengths in millimetres'],
  ['cm', 'Show lengths in centimetres'],
  ['m', 'Show lengths in metres'],
  ['inch', 'Show lengths in inches']
];

/**
 * The App menus' items and the action each runs. A `*` stands for the
 * numbered tail of a templated id (`repair-datum-vertex-0`, `-1`, …).
 */
const MENU_ITEMS: readonly (readonly [
  menu: ActionMenu,
  item: string,
  action: string,
  label?: string
])[] = [
  // The empty viewport's menu.
  ['viewport', 'fit', 'view-fit'],
  ['viewport', 'grid', 'view-grid'],
  ['viewport', 'projection', 'view-projection'],
  ['viewport', 'xray', 'view-xray'],
  ['viewport', 'showAll', 'view-show-all'],
  // A selection's menu (`viewportMenu.ts` adds the face verbs and these two).
  ['selection', SELECT_OTHER_ITEM_ID, 'selection-select-other', 'Select other'],
  ['selection', LOOK_AT_FACE_ITEM_ID, 'view-normal-to-face'],
  ['selection', 'fillet', toolCommandId('fillet')],
  ['selection', 'chamfer', toolCommandId('chamfer')],
  ['selection', 'move', toolCommandId('transform')],
  ['selection', 'union', toolCommandId('union')],
  ['selection', 'subtract', toolCommandId('subtract')],
  ['selection', 'hide', 'body-visibility', 'Show or hide body'],
  ['selection', 'isolate', 'view-isolate-body'],
  ['selection', 'fit', 'view-fit'],
  ['selection', 'flat-pattern', 'file-export-flat-pattern'],
  ['selection', 'edit', 'feature-edit', 'Edit feature'],
  ['selection', 'delete', 'selection-delete', 'Delete selection'],
  // A History row's menu (also its ⋯ button).
  ['history-row', 'measurements', 'feature-measurements', 'Measurements'],
  ['history-row', 'rename', 'feature-rename', 'Rename step'],
  ['history-row', 'repair-face', 'feature-repick', 'Re-pick a reference'],
  ['history-row', 'repick-to-face', 'feature-repick'],
  ['history-row', 'repair-datum-face*', 'feature-repick'],
  ['history-row', 'repair-datum-faces-both', 'feature-repick'],
  ['history-row', 'repair-datum-vertex-*', 'feature-repick'],
  ['history-row', 'repair-datum-vertices-all', 'feature-repick'],
  ['history-row', 'repair-datum-plane-edge', 'feature-repick'],
  ['history-row', 'repair-datum-axis-source', 'feature-repick'],
  ['history-row', 'visibility', 'body-visibility'],
  [
    'history-row',
    'sketch-visibility',
    'sketch-visibility',
    'Show or hide sketch'
  ],
  [
    'history-row',
    'sketch-export-dxf',
    'sketch-export-dxf',
    'Export sketch DXF'
  ],
  ['history-row', 'suppression', 'feature-suppress', 'Suppress or resume'],
  [
    'history-row',
    'rollback',
    'history-rollback',
    'Roll back or resume history'
  ],
  ['history-row', 'duplicate', 'feature-duplicate', 'Duplicate step'],
  ['history-row', 'delete', 'feature-delete', 'Delete step']
];

/**
 * Every selection action (`capabilities.ts`), which the verb rail and the
 * tool cards offer for a pick. The type check below fails when the union
 * gains a member this list does not name.
 */
const SELECTION_ACTIONS = [
  ['resize-body', 'Resize body'],
  ['offset-face', 'Push/pull face'],
  ['resize-radial-face', 'Resize diameter or radius'],
  ['edit-fillet', 'Edit fillet'],
  ['remove-fillet', 'Remove fillet'],
  ['remove-all-fillets', 'Remove all fillets'],
  ['remove-face-feature', 'Remove face feature'],
  ['sketch-on-face', 'Sketch on face'],
  ['fillet', 'Fillet edges'],
  ['chamfer', 'Chamfer edges'],
  ['chamfer-chain', 'Chamfer whole outline'],
  ['fillet-face-edges', 'Fillet face edges'],
  ['chamfer-face-edges', 'Chamfer face edges'],
  ['extrude-region', 'Extrude region']
] as const satisfies readonly (readonly [SelectionActionId, string])[];

type UnlistedSelectionAction = Exclude<
  SelectionActionId,
  (typeof SELECTION_ACTIONS)[number][0]
>;
const selectionActionsComplete: [UnlistedSelectionAction] extends [never]
  ? true
  : UnlistedSelectionAction = true;
void selectionActionsComplete;

/** The verb rail's verbs that are neither a selection action nor a tool. */
const OTHER_SELECTION_VERBS: readonly (readonly [id: string, label: string])[] =
  [
    ['text-on-face', 'Text on face'],
    ['edit-face', 'Edit face'],
    ['offset-faces', 'Offset faces']
  ];

/** The registry id of a verb-rail verb (`SelectionCalloutVerbId`). */
export function selectionVerbAction(verbId: string): string {
  return verbId.startsWith('tool:')
    ? toolCommandId(verbId.slice(5) as Parameters<typeof toolCommandId>[0])
    : `selection-${verbId.replace(/^action:/, '')}`;
}

/** Draw's view tools, beside its annotation tools. */
const DRAWING_VIEW_TOOLS: readonly (readonly [
  id: string,
  label: string,
  key: string
])[] = [
  ['drawing-section-view', 'Section view', SECTION_TOOL_KEY],
  ['drawing-detail-view', 'Detail view', DETAIL_TOOL_KEY],
  ['drawing-auxiliary-view', 'Auxiliary view', AUXILIARY_TOOL_KEY]
];

/** Keys a surface handles itself, and gestures with no other route. */
const FIXED_INPUTS: readonly (readonly [
  id: string,
  label: string,
  source: 'fixed-key' | 'pointer-gesture',
  input: string
])[] = [
  ['sketch-select-all', 'Select all sketch entities', 'fixed-key', 'Ctrl+A'],
  ['sketch-copy', 'Copy sketch entities', 'fixed-key', 'Ctrl+C'],
  ['sketch-paste', 'Paste sketch entities', 'fixed-key', 'Ctrl+V'],
  ['motion-previous-key', 'Previous animation key', 'fixed-key', '['],
  ['motion-next-key', 'Next animation key', 'fixed-key', ']'],
  [
    'selection-connected-edges',
    'Select connected edges',
    'pointer-gesture',
    'Double-click an edge'
  ],
  [
    'selection-whole-body',
    'Select the whole body',
    'pointer-gesture',
    'Double-click a face or edge'
  ]
];

// ── The registry ───────────────────────────────────────────────────────

interface Draft {
  id: string;
  label: string;
  sources: ActionSource[];
  menuItems: { menu: ActionMenu; item: string }[];
  fixedKeys: string[];
}

function buildActions(): ActionEntry[] {
  const byId = new Map<string, Draft>();
  const add = (id: string, label: string | undefined, source: ActionSource) => {
    let draft = byId.get(id);
    if (!draft) {
      if (label === undefined) {
        throw new Error(`Action ${id} is used before it has a name`);
      }
      draft = { id, label, sources: [], menuItems: [], fixedKeys: [] };
      byId.set(id, draft);
    }
    if (!draft.sources.includes(source)) draft.sources.push(source);
    return draft;
  };

  for (const command of KEYMAP_COMMANDS) {
    add(command.id, command.label, 'keymap');
    if (
      KEYMAP_ROWS_IN_COMMAND_BAR.has(command.id) ||
      command.id.startsWith('tool-')
    ) {
      add(command.id, undefined, 'command-bar');
    }
  }
  for (const group of TOOL_GROUPS) {
    for (const tool of group.tools)
      add(toolCommandId(tool), undefined, 'command-bar');
  }
  for (const [id, label] of COMMAND_BAR_ONLY) add(id, label, 'command-bar');
  for (const [unit, label] of DISPLAY_UNIT_ROWS) {
    add(`file-display-units-${unit}`, label, 'command-bar');
  }
  for (const [menu, item, action, label] of MENU_ITEMS) {
    add(action, label, 'menu').menuItems.push({ menu, item });
  }
  for (const [id, label] of SELECTION_ACTIONS) {
    add(selectionVerbAction(`action:${id}`), label, 'selection-verb');
  }
  for (const [id, label] of OTHER_SELECTION_VERBS) {
    add(selectionVerbAction(id), label, 'selection-verb');
  }
  for (const kind of ANNOTATION_TOOLS) {
    add(
      `drawing-${kind}`,
      ANNOTATION_TOOL_LABELS[kind],
      'drawing'
    ).fixedKeys.push(ANNOTATION_TOOL_KEYS[kind]);
  }
  for (const [id, label, key] of DRAWING_VIEW_TOOLS) {
    add(id, label, 'drawing').fixedKeys.push(key);
  }
  for (const [id, label, source, input] of FIXED_INPUTS) {
    add(id, label, source).fixedKeys.push(input);
  }
  return [...byId.values()];
}

export const ACTIONS: readonly ActionEntry[] = buildActions();

const ACTIONS_BY_ID = new Map(ACTIONS.map((entry) => [entry.id, entry]));

export function actionEntry(id: string): ActionEntry | undefined {
  return ACTIONS_BY_ID.get(id);
}

/** Actions with no compact entry point yet, in registry order. */
export function pendingCompactActions(): ActionEntry[] {
  return ACTIONS.filter((entry) => COMPACT_ENTRIES[entry.id] === undefined);
}

/**
 * Actions the regular workspace offers no touch path to today: a keyboard
 * key, a right-click menu with no button, or a double-click (the plan's
 * "Touch paths" table). The compact workspace must give each one.
 */
export const REGULAR_TOUCH_GAPS: readonly string[] = [
  'selection-filter',
  'sketch-select-all',
  'sketch-copy',
  'sketch-paste',
  'motion-previous-key',
  'motion-next-key',
  'file-export-face-dxf',
  'project-duplicate',
  'feature-duplicate',
  'feature-repick',
  'view-normal-to-face',
  'view-show-all',
  'selection-connected-edges',
  'selection-whole-body'
];
