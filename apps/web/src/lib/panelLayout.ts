/**
 * Where the model panels live, remembered per device (U08).
 *
 * Parameters, Objects, History, Revisions and Diagnostics are independent
 * panels. Each is closed, unpinned (one at a time, beside the right rail),
 * docked in a column of the left or right dock, or floating in a window over
 * the model. This module is the whole model: the layout, every operation on
 * it, the geometry that turns it into rectangles for a stage, hit-testing on
 * those rectangles, and persistence with the migration from the v1 drawer.
 * It is pure — no React, no DOM — so a drag can run on a local copy and
 * commit once, and every rule here is unit tested.
 *
 * No operation mutates its input. One that changes nothing — a refused
 * placement, say — returns its input as is, so `===` tells a caller it was
 * refused. Nothing here makes a floating window the person did not ask for.
 *
 * Columns are numbered from the screen edge inward: column 0 sits against the
 * edge and each new column is added on the rail side. "Outermost" below means
 * the last column, the one farthest from the edge and nearest the rail —
 * where a new column would go and the first to give way.
 */
import {
  PANEL_STATE_STORAGE_KEY,
  SIDEBAR_SECTION_IDS,
  normalizePanelState,
  type PanelState,
  type SidebarSectionId
} from './panelState';

export const PANEL_LAYOUT_STORAGE_KEY = 'openzcad-panel-layout:v1';

/** `bodies` is the Objects panel; the ids are the v1 drawer's section ids. */
export type PanelId = SidebarSectionId;

/** Every panel, in the order the v1 drawer stacked its sections. */
export const PANEL_IDS: readonly PanelId[] = SIDEBAR_SECTION_IDS;

/** Stands in for the dragged panel in a preview, where it will land. */
export const PANEL_SLOT = '__slot';
export type PanelEntry = PanelId | typeof PANEL_SLOT;

export type DockSide = 'left' | 'right';
export const DOCK_SIDES: readonly DockSide[] = ['right', 'left'];

export type PanelWidth = 'narrow' | 'regular' | 'wide';

export const PANEL_COLUMN_WIDTHS: Readonly<Record<PanelWidth, number>> = {
  narrow: 256,
  regular: 296,
  wide: 360
};

/** Columns per dock. */
export const PANEL_MAX_COLUMNS: Readonly<Record<DockSide, number>> = {
  right: 3,
  left: 2
};

/** The default island gap: between columns, and around rails (`--island-gap`). */
export const PANEL_COLUMN_GAP = 10;
/** A rail's width (`--rail-w`). */
export const PANEL_RAIL_WIDTH = 40;
/** Between panels stacked in one column or window. */
export const PANEL_STACK_GAP = 8;
export const PANEL_MIN_HEIGHT = 90;
export const FLOAT_MIN_WIDTH = 260;
export const FLOAT_MAX_WIDTH = 600;
export const FLOAT_MIN_HEIGHT = 160;
const FLOAT_DEFAULT_HEIGHT = 420;
/** How much a floating window grows when a panel is stacked into it. */
export const FLOAT_GROWTH = 240;
/** The grip bar above a stacked window's frame, which also takes drops. */
const FLOAT_FRAME_GRIP = 20;
/** Columns take drops a little past their ends. */
const DOCK_HIT_SLACK = 8;
/** A pop-out lands this far across from where the panel was. */
const POP_OUT_OFFSET = 330;

/** A press that moves less than this is a click, not a drag. */
export const PANEL_DRAG_THRESHOLD = 4;
/**
 * A drag out of a rail ignores every target until it is this far from where
 * it started; otherwise the rail's own new-column target takes it at once.
 */
export const PANEL_RAIL_DRAG_CLEARANCE = 60;

/**
 * The docks' whole footprint — both sides' columns, both rails and every gap
 * — may take at most this share of the stage width, so the model keeps 40%.
 */
export const PANEL_DOCK_CAP = 0.6;
/** At or below this stage width nothing docks: the phone lane takes over. */
export const PANEL_PHONE_MAX_WIDTH = 720;

const WEIGHT_MIN = 0.01;
const WEIGHT_MAX = 100;
/** Stored float coordinates are clamped to this before any stage is known. */
const COORD_MAX = 16384;
const FLOAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloatGroup<T extends PanelEntry = PanelId> extends Rect {
  id: string;
  panels: T[];
}

/** Where a closed panel last lived; its rail button reopens it there. */
export type PanelHome =
  | {
      kind: 'column';
      side: DockSide;
      column: number;
      index: number;
      /** Legacy marker for a removed singleton column. */
      alone?: boolean;
      /** Original stack order, including peers closed before this panel. */
      peers?: PanelId[];
      /** Other columns' panels, so removed columns return in order. */
      preceding?: PanelId[];
      following?: PanelId[];
    }
  | { kind: 'float'; rect: Rect };

export interface PanelLayoutOptions {
  /** Every panel hidden, layout kept. */
  hidden: boolean;
  /**
   * No drags, moves or resizes: placing, dragging, gap and window resizing,
   * presets and the panel width return the layout unchanged. Pin, unpin,
   * pop-out, open, close and the other settings still work.
   */
  locked: boolean;
  compact: boolean;
  width: PanelWidth;
}

export interface PanelLayout<T extends PanelEntry = PanelId> {
  /** Column 0 sits against the screen edge. */
  left: T[][];
  right: T[][];
  /** In z-order: the last is on top. */
  floats: FloatGroup<T>[];
  /** Relative heights within a column or window. */
  weights: Record<PanelId, number> & {
    /** Transient slot height in a drag preview; never persisted. */
    [PANEL_SLOT]?: number;
  };
  unpinned: PanelId | null;
  /**
   * Panels by last use, most recent first: opened, pressed on the rail or
   * focused. The phone lane shows the most recent open one.
   */
  recent: PanelId[];
  /**
   * A docked panel the rail pressed while its column is parked, shown in the
   * unpinned slot — but only while it is parked: once its column fits again
   * it is drawn docked and the slot closes, so a panel is never drawn twice.
   * Transient: never stored.
   */
  revealed: PanelId | null;
  homes: Partial<Record<PanelId, PanelHome>>;
  options: PanelLayoutOptions;
}

/** A layout with the dragged panel shown as `PANEL_SLOT` where it would land. */
export type PanelLayoutPreview = PanelLayout<PanelEntry>;

export type PanelStatus = 'closed' | 'unpinned' | 'docked' | 'floating';

export type PanelLocation =
  | { kind: 'column'; side: DockSide; column: number; index: number }
  | { kind: 'float'; groupId: string; index: number }
  | { kind: 'unpinned' };

export type PanelTarget =
  /** Stack in an existing column at `index`. */
  | { kind: 'column'; side: DockSide; column: number; index?: number }
  /**
   * A new column: at `column`, counted from the screen edge, or next to that
   * side's rail without one.
   */
  | { kind: 'newColumn'; side: DockSide; column?: number }
  /** A new floating window. */
  | { kind: 'float'; rect: Rect }
  /** Stack in an existing floating window at `index`. */
  | { kind: 'group'; groupId: string; index?: number };

/** User-facing presets, in menu order. */
export type PanelPresetId =
  'essentials' | 'full' | 'modeling' | 'review' | 'model-only';
export const PANEL_PRESET_IDS: readonly PanelPresetId[] = [
  'essentials',
  'full',
  'modeling',
  'review',
  'model-only'
];
/**
 * Essentials while only the right dock ships: Objects over Parameters in one
 * right column. A new device's default until the left dock exists; not a menu
 * entry.
 */
export const ESSENTIALS_RIGHT_PRESET = 'essentials-right';
export type PanelPreset = PanelPresetId | typeof ESSENTIALS_RIGHT_PRESET;

export interface PanelInsets {
  /** The docks' top: under the top bar (`--stage-top`). */
  top: number;
  /** The docks' bottom margin (`--island-gap`). */
  bottom: number;
  /**
   * The island gap (`--island-gap`): from each side edge to its outermost
   * column, between columns, and on both sides of each rail.
   */
  gap: number;
  /** A rail's width (`--rail-w`). */
  rail: number;
}

/** The quiet stage's tokens: a 40px top bar between two 10px gaps. */
export const DEFAULT_PANEL_INSETS: Readonly<PanelInsets> = {
  top: 60,
  bottom: 10,
  gap: PANEL_COLUMN_GAP,
  rail: PANEL_RAIL_WIDTH
};

/** The viewer area the panels sit over, in CSS pixels. */
export interface PanelStage {
  width: number;
  height: number;
  insets?: Partial<PanelInsets>;
}

const DEFAULT_OPTIONS: PanelLayoutOptions = {
  hidden: false,
  locked: false,
  compact: false,
  width: 'regular'
};

// ── Small helpers ──────────────────────────────────────────

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi < lo ? lo : hi, value));
}

function defaultWeights(): Record<PanelId, number> {
  return {
    parameters: 1,
    bodies: 1,
    history: 1,
    revisions: 1,
    diagnostics: 1
  };
}

function isPanelId(value: unknown): value is PanelId {
  return (
    typeof value === 'string' &&
    (PANEL_IDS as readonly string[]).includes(value)
  );
}

function copyLayout<T extends PanelEntry>(
  layout: PanelLayout<T>
): PanelLayout<T> {
  return {
    left: layout.left.map((column) => column.slice()),
    right: layout.right.map((column) => column.slice()),
    floats: layout.floats.map((group) => ({
      ...group,
      panels: group.panels.slice()
    })),
    weights: { ...layout.weights },
    unpinned: layout.unpinned,
    recent: layout.recent.slice(),
    revealed: layout.revealed,
    homes: { ...layout.homes },
    options: { ...layout.options }
  };
}

function sideColumns<T extends PanelEntry>(
  layout: PanelLayout<T>,
  side: DockSide
): T[][] {
  return side === 'left' ? layout.left : layout.right;
}

function weightOf(layout: PanelLayout<PanelEntry>, id: PanelEntry): number {
  return id === PANEL_SLOT
    ? (layout.weights[PANEL_SLOT] ?? 1)
    : layout.weights[id];
}

function insetsOf(stage: PanelStage): PanelInsets {
  return { ...DEFAULT_PANEL_INSETS, ...stage.insets };
}

export function columnWidthOf(options: PanelLayoutOptions): number {
  return PANEL_COLUMN_WIDTHS[options.width];
}

/** The area floating windows are kept inside. */
function floatBounds(stage: PanelStage): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const insets = insetsOf(stage);
  return {
    left: insets.gap,
    top: insets.top,
    right: Math.max(insets.gap, stage.width - insets.gap),
    bottom: Math.max(insets.top, stage.height - insets.bottom)
  };
}

/** A rectangle moved and, if it must be, shrunk to lie inside the stage. */
export function clampFloatRect(rect: Rect, stage: PanelStage): Rect {
  const bounds = floatBounds(stage);
  const w = Math.min(rect.w, bounds.right - bounds.left);
  const h = Math.min(rect.h, bounds.bottom - bounds.top);
  return {
    x: clamp(rect.x, bounds.left, bounds.right - w),
    y: clamp(rect.y, bounds.top, bounds.bottom - h),
    w,
    h
  };
}

/** A floating window as it shows while a panel is stacked into it. */
export function grownFloatRect(rect: Rect, stage?: PanelStage): Rect {
  if (!stage) {
    return { ...rect, h: rect.h + FLOAT_GROWTH };
  }
  const bounds = floatBounds(stage);
  const h = Math.min(rect.h + FLOAT_GROWTH, bounds.bottom - bounds.top);
  const y =
    rect.y + h > bounds.bottom
      ? Math.max(bounds.top, bounds.bottom - h)
      : rect.y;
  return { ...rect, y, h };
}

function nextFloatId(layout: PanelLayout<PanelEntry>): string {
  const used = new Set(layout.floats.map((group) => group.id));
  // At most one id per known panel: a free small integer always exists.
  // Parsing a stored suffix could round max + 1 back to the same id.
  let candidate = 1;
  while (used.has(`float-${candidate}`)) candidate += 1;
  return `float-${candidate}`;
}

/**
 * The heights a stack of panels gets in `height`, split by weight. Below
 * their minimum, panels are held at 90px and the rest share what is left;
 * when even that cannot fit, every panel holds its minimum and the stack
 * overflows (the column scrolls as one). Weights are never changed.
 */
function stackHeights(
  weights: readonly number[],
  height: number
): {
  heights: number[];
  pxPerWeight: number;
  overflowing: boolean;
  contentHeight: number;
} {
  const n = weights.length;
  if (n === 0) {
    return {
      heights: [],
      pxPerWeight: 0,
      overflowing: false,
      contentHeight: height
    };
  }
  const gaps = PANEL_STACK_GAP * (n - 1);
  const needed = PANEL_MIN_HEIGHT * n + gaps;
  if (needed > height) {
    return {
      heights: weights.map(() => PANEL_MIN_HEIGHT),
      pxPerWeight: 0,
      overflowing: true,
      contentHeight: needed
    };
  }
  const held = new Array<boolean>(n).fill(false);
  let pxPerWeight = 0;
  for (;;) {
    let free = height - gaps;
    let freeWeight = 0;
    weights.forEach((weight, k) => {
      if (held[k]) {
        free -= PANEL_MIN_HEIGHT;
      } else {
        freeWeight += weight;
      }
    });
    pxPerWeight = freeWeight > 0 ? free / freeWeight : 0;
    let changed = false;
    weights.forEach((weight, k) => {
      if (!held[k] && weight * pxPerWeight < PANEL_MIN_HEIGHT) {
        held[k] = true;
        changed = true;
      }
    });
    if (!changed) {
      break;
    }
  }
  return {
    heights: weights.map((weight, k) =>
      held[k] ? PANEL_MIN_HEIGHT : weight * pxPerWeight
    ),
    pxPerWeight,
    overflowing: false,
    contentHeight: height
  };
}

// ── State ──────────────────────────────────────────────────

export function findPanel(
  layout: PanelLayout<PanelEntry>,
  id: PanelEntry
): PanelLocation | null {
  if (id !== PANEL_SLOT && layout.unpinned === id) {
    return { kind: 'unpinned' };
  }
  for (const side of DOCK_SIDES) {
    const columns = sideColumns(layout, side);
    for (let column = 0; column < columns.length; column++) {
      const index = columns[column]!.indexOf(id);
      if (index >= 0) {
        return { kind: 'column', side, column, index };
      }
    }
  }
  for (const group of layout.floats) {
    const index = group.panels.indexOf(id);
    if (index >= 0) {
      return { kind: 'float', groupId: group.id, index };
    }
  }
  return null;
}

export function panelStatus(
  layout: PanelLayout<PanelEntry>,
  id: PanelId
): PanelStatus {
  const location = findPanel(layout, id);
  if (!location) {
    return 'closed';
  }
  return location.kind === 'unpinned'
    ? 'unpinned'
    : location.kind === 'column'
      ? 'docked'
      : 'floating';
}

export function panelStatuses(
  layout: PanelLayout<PanelEntry>
): Record<PanelId, PanelStatus> {
  const statuses = {} as Record<PanelId, PanelStatus>;
  for (const id of PANEL_IDS) {
    statuses[id] = panelStatus(layout, id);
  }
  return statuses;
}

export function isPanelOpen(
  layout: PanelLayout<PanelEntry>,
  id: PanelId
): boolean {
  return findPanel(layout, id) !== null;
}

// ── Presets ────────────────────────────────────────────────

function emptyLayout(
  options: PanelLayoutOptions = DEFAULT_OPTIONS
): PanelLayout {
  return {
    left: [],
    right: [],
    floats: [],
    weights: defaultWeights(),
    unpinned: null,
    recent: [],
    revealed: null,
    homes: {},
    options: { ...options }
  };
}

function presetLayout(
  name: PanelPreset,
  options: PanelLayoutOptions
): PanelLayout {
  const layout = emptyLayout(options);
  switch (name) {
    case 'essentials':
      layout.left = [['bodies']];
      layout.right = [['parameters']];
      break;
    case ESSENTIALS_RIGHT_PRESET:
      layout.right = [['bodies', 'parameters']];
      break;
    case 'full':
      layout.left = [['bodies', 'history']];
      layout.right = [['parameters', 'revisions']];
      // Revisions about a quarter of the column.
      layout.weights.revisions = 0.32;
      break;
    case 'modeling':
      layout.left = [['bodies', 'history']];
      layout.right = [['parameters']];
      layout.weights.bodies = 0.7;
      layout.weights.history = 1.3;
      break;
    case 'review':
      layout.right = [['history', 'revisions']];
      layout.weights.history = 1.6;
      break;
    case 'model-only':
      break;
  }
  return layout;
}

/**
 * A preset replaces the arrangement, homes and weights, keeps the settings
 * and the recency list, and turns Hide off so the picked layout is what
 * shows.
 */
export function applyPreset(
  layout: PanelLayout,
  name: PanelPreset
): PanelLayout {
  if (layout.options.locked) {
    return layout;
  }
  const next = presetLayout(name, { ...layout.options, hidden: false });
  next.recent = layout.recent.slice();
  return next;
}

/**
 * Marks a panel as the one used last: opened, pressed or focused. A floating
 * panel's window comes to the front with it.
 */
export function notePanelUsed(layout: PanelLayout, id: PanelId): PanelLayout {
  const group = layout.floats.find((candidate) =>
    candidate.panels.includes(id)
  );
  const raised = group ? raiseFloat(layout, group.id) : layout;
  if (raised.recent[0] === id) {
    return raised;
  }
  const next = copyLayout(raised);
  next.recent = [id, ...raised.recent.filter((entry) => entry !== id)];
  return next;
}

/**
 * A new device's layout. Essentials docks Objects on the left; until the left
 * dock ships (`leftDock: false`) it is the right-only form instead.
 */
export function defaultPanelLayout({
  leftDock = false
}: { leftDock?: boolean } = {}): PanelLayout {
  return presetLayout(
    leftDock ? 'essentials' : ESSENTIALS_RIGHT_PRESET,
    DEFAULT_OPTIONS
  );
}

export function setOption<K extends keyof PanelLayoutOptions>(
  layout: PanelLayout,
  key: K,
  value: PanelLayoutOptions[K]
): PanelLayout {
  // A width change resizes every column, which the lock refuses.
  if (key === 'width' && layout.options.locked) {
    return layout;
  }
  const next = copyLayout(layout);
  next.options[key] = value;
  return next;
}

// ── Detach, place, preview ─────────────────────────────────

/** A panel's height in a floating window, from the window's stored height. */
function heightInGroup(
  layout: PanelLayout<PanelEntry>,
  group: FloatGroup<PanelEntry>,
  id: PanelEntry
): number {
  const index = group.panels.indexOf(id);
  const stack = stackHeights(
    group.panels.map((entry) => weightOf(layout, entry)),
    group.h
  );
  return stack.heights[index] ?? group.h;
}

/**
 * Takes a panel out of wherever it lives. `keepColumns` leaves an emptied
 * column in place — a drag does this so nothing beside it slides over until
 * the drop. A window that loses a panel shrinks by that panel's height.
 */
function detach<T extends PanelEntry>(
  layout: PanelLayout<T>,
  id: PanelEntry,
  keepColumns: boolean
): PanelLayout<T> {
  const next = copyLayout(layout);
  const strip = (columns: T[][]): T[][] => {
    const stripped = columns.map((column) =>
      column.filter((entry) => entry !== id)
    );
    return keepColumns
      ? stripped
      : stripped.filter((column) => column.length > 0);
  };
  next.left = strip(next.left);
  next.right = strip(next.right);
  next.floats = layout.floats
    .map((group) => {
      if (!group.panels.includes(id as T)) {
        return { ...group, panels: group.panels.slice() };
      }
      const panels = group.panels.filter((entry) => entry !== id);
      const h =
        panels.length > 0
          ? Math.max(
              FLOAT_MIN_HEIGHT,
              group.h - heightInGroup(layout, group, id) - PANEL_STACK_GAP
            )
          : group.h;
      return { ...group, panels, h };
    })
    .filter((group) => group.panels.length > 0);
  if (next.unpinned === id) {
    next.unpinned = null;
  }
  if (next.revealed === id) {
    next.revealed = null;
  }
  return next;
}

/** Drops the empty columns and windows a drag left behind. */
export function finishDrag<T extends PanelEntry>(
  layout: PanelLayout<T>
): PanelLayout<T> {
  const next = copyLayout(layout);
  next.left = next.left.filter((column) => column.length > 0);
  next.right = next.right.filter((column) => column.length > 0);
  next.floats = next.floats.filter((group) => group.panels.length > 0);
  return next;
}

/**
 * The layout while `id` is being dragged: the panel lifted out, an emptied
 * column kept in its place. Geometry and hit-testing run on this.
 */
export function beginDrag(layout: PanelLayout, id: PanelId): PanelLayout {
  return layout.options.locked ? layout : detach(layout, id, true);
}

/**
 * Everything between the screen edges and the model: each side's
 * `gap + rail + gap`, whether or not it has columns, and `columnWidth + gap`
 * for each column.
 */
export function dockFootprint(
  columns: Record<DockSide, number>,
  columnWidth: number,
  insets: Pick<PanelInsets, 'gap' | 'rail'> = DEFAULT_PANEL_INSETS
): number {
  const side = insets.gap + insets.rail + insets.gap;
  return side * 2 + (columns.left + columns.right) * (columnWidth + insets.gap);
}

/**
 * Whether a footprint leaves the model less than its share of the stage,
 * with a tolerance so a footprint exactly at the cap is not lost to the
 * rounding of `width * 0.6`.
 */
function overCap(footprint: number, stageWidth: number): boolean {
  return footprint - stageWidth * PANEL_DOCK_CAP > 1e-6;
}

/**
 * Whether placing `id` at `target` would take the docks' footprint past the
 * cap on this stage, or land it in a column that is parked there. Only a new
 * column adds to the footprint; an existing column can already be parked
 * after the stage shrank, and a panel put there would not be drawn. On a
 * phone-width stage every target is refused, windows included.
 */
export function wouldExceedCap(
  layout: PanelLayout,
  id: PanelId,
  target: PanelTarget,
  stage: PanelStage
): boolean {
  // At phone width nothing docks or floats: the phone lane shows the panel,
  // and the phone geometry parks nothing.
  if (stage.width <= PANEL_PHONE_MAX_WIDTH) {
    return true;
  }
  if (target.kind !== 'column' && target.kind !== 'newColumn') {
    return false;
  }
  // Judge the layout the drop would actually leave: target indices refer to
  // the columns before the panel is lifted, and lifting a panel can empty a
  // column, so counting from a detached layout misreads which column it is.
  const placed = finishDrag(placeEntry(layout, id, id, target, stage));
  const count = (l: PanelLayout<PanelEntry>) => ({
    left: l.left.length,
    right: l.right.length
  });
  const before = count(layout);
  const after = count(placed);
  // Only a drop that adds a column can take the footprint past the cap; a
  // layout already past it (columns parked) may still be consolidated.
  if (after.left + after.right > before.left + before.right) {
    if (
      overCap(
        dockFootprint(after, columnWidthOf(layout.options), insetsOf(stage)),
        stage.width
      )
    ) {
      return true;
    }
  }
  // An existing column, or a full dock's outermost one, may be parked.
  return computePanelGeometry(placed, stage).parked[id] === true;
}

/**
 * A window beside the right rail's inner edge, where the unpinned panel
 * shows: where Pop out puts a panel that has no rectangle on screen.
 */
export function defaultFloatRect(
  layout: PanelLayout<PanelEntry>,
  stage: PanelStage
): Rect {
  const geometry = computePanelGeometry(layout, stage);
  const w = clamp(geometry.columnWidth, FLOAT_MIN_WIDTH, FLOAT_MAX_WIDTH);
  return clampFloatRect(
    {
      x: geometry.rails.right.x - geometry.insets.gap - w,
      y: geometry.dock.top,
      w,
      h: FLOAT_DEFAULT_HEIGHT
    },
    stage
  );
}

/**
 * Inserts `entry` at `target` into a layout the panel is already detached
 * from. Shared by placement and preview so the two cannot disagree.
 */
function insertAt(
  layout: PanelLayout<PanelEntry>,
  entry: PanelEntry,
  target: PanelTarget,
  stage: PanelStage | undefined
): PanelLayout<PanelEntry> {
  const next = copyLayout(layout);
  const at = (length: number, index: number | undefined): number =>
    index === undefined ? length : clamp(Math.trunc(index), 0, length);
  if (target.kind === 'column' || target.kind === 'newColumn') {
    const columns = sideColumns(next, target.side);
    if (
      target.kind === 'column' &&
      target.column >= 0 &&
      target.column < columns.length
    ) {
      const column = columns[target.column]!;
      column.splice(at(column.length, target.index), 0, entry);
      return next;
    }
    // Past the dock's column limit the panel stacks in its outermost column.
    const live = columns.filter((column) => column.length > 0);
    if (live.length >= PANEL_MAX_COLUMNS[target.side]) {
      live[live.length - 1]!.push(entry);
    } else if (target.kind === 'newColumn') {
      columns.splice(at(columns.length, target.column), 0, [entry]);
    } else {
      columns.push([entry]);
    }
    return next;
  }
  if (target.kind === 'group') {
    const k = next.floats.findIndex((group) => group.id === target.groupId);
    if (k >= 0) {
      const group = next.floats[k]!;
      const panels = group.panels.slice();
      panels.splice(at(panels.length, target.index), 0, entry);
      next.floats.splice(k, 1);
      // The window it was dropped on comes to the front.
      next.floats.push({ ...group, ...grownFloatRect(group, stage), panels });
      return next;
    }
  }
  const rect =
    target.kind === 'float' ? target.rect : { x: 0, y: 0, w: 0, h: 0 };
  const sized = {
    x: clamp(rect.x, 0, COORD_MAX),
    y: clamp(rect.y, 0, COORD_MAX),
    w: clamp(
      rect.w || columnWidthOf(next.options),
      FLOAT_MIN_WIDTH,
      FLOAT_MAX_WIDTH
    ),
    h: Math.max(FLOAT_MIN_HEIGHT, rect.h || FLOAT_DEFAULT_HEIGHT)
  };
  next.floats.push({
    id: nextFloatId(next),
    ...(stage ? clampFloatRect(sized, stage) : sized),
    panels: [entry]
  });
  return next;
}

function placeEntry(
  layout: PanelLayout<PanelEntry>,
  id: PanelId,
  entry: PanelEntry,
  target: PanelTarget,
  stage: PanelStage | undefined
): PanelLayout<PanelEntry> {
  const detached = detach(layout, id, true);
  const next = insertAt(detached, entry, target, stage);
  const source = findPanel(layout, id);
  // Only a move to another stack starts the panel at an even share; a
  // reorder within its own column or window keeps the height it was given.
  const sameStack =
    (source?.kind === 'column' &&
      target.kind === 'column' &&
      source.side === target.side &&
      source.column === target.column) ||
    (source?.kind === 'float' &&
      target.kind === 'group' &&
      source.groupId === target.groupId);
  const from = layout.floats.find((group) => group.panels.includes(id));
  if (
    target.kind === 'group' &&
    from?.id === target.groupId &&
    from.panels.length > 1
  ) {
    // A reorder within one window keeps its rectangle: detaching shrank it
    // by the panel's share and inserting grew it by FLOAT_GROWTH, which differ.
    // A window of one closed on detach, so the drop made a new one instead.
    const group = next.floats.find((candidate) => candidate.id === from.id);
    if (group) {
      Object.assign(group, { x: from.x, y: from.y, w: from.w, h: from.h });
    }
  }
  delete next.homes[id];
  if (!sameStack) {
    next.weights[id] = 1;
  }
  if (entry === PANEL_SLOT) next.weights[PANEL_SLOT] = next.weights[id];
  return next;
}

/**
 * Puts a panel at a target, from wherever it was (closed, unpinned, docked or
 * floating). With a stage, a target that would add a column past the
 * footprint cap is refused: the layout comes back unchanged (the same
 * object) and the panel stays where it was. Check `wouldExceedCap` first to
 * tell the person why. A locked layout refuses every placement.
 */
export function placePanel(
  layout: PanelLayout,
  id: PanelId,
  target: PanelTarget,
  stage?: PanelStage
): PanelLayout {
  return layout.options.locked ? layout : placeAt(layout, id, target, stage);
}

/** `placePanel` without the lock: pin, pop-out and reopening still work. */
function placeAt(
  layout: PanelLayout,
  id: PanelId,
  target: PanelTarget,
  stage: PanelStage | undefined
): PanelLayout {
  if (stage && wouldExceedCap(layout, id, target, stage)) {
    return layout;
  }
  return finishDrag(placeEntry(layout, id, id, target, stage)) as PanelLayout;
}

/**
 * The layout a drop at `target` would give, with `PANEL_SLOT` where the panel
 * lands and emptied columns still in place, for rendering the slot preview;
 * null when the drop would be refused (past the cap, or the layout locked). `commitPreview` of it is exactly
 * `placePanel` with the same arguments. Pass the layout from before the drag:
 * from `beginDrag`'s, a reorder within the panel's own window cannot be told
 * apart from a drop into another window and would grow it.
 */
export function previewLayout(
  layout: PanelLayout,
  id: PanelId,
  target: PanelTarget,
  stage?: PanelStage
): PanelLayoutPreview | null {
  if (
    layout.options.locked ||
    (stage && wouldExceedCap(layout, id, target, stage))
  ) {
    return null;
  }
  return placeEntry(layout, id, PANEL_SLOT, target, stage);
}

/** The preview's slot filled with the dragged panel, and the drag cleaned up. */
export function commitPreview(
  preview: PanelLayoutPreview,
  id: PanelId
): PanelLayout {
  const fill = (entries: PanelEntry[]): PanelId[] =>
    entries.map((entry) => (entry === PANEL_SLOT ? id : entry));
  const next = {
    ...copyLayout(preview),
    left: preview.left.map(fill),
    right: preview.right.map(fill),
    floats: preview.floats.map((group) => ({
      ...group,
      panels: fill(group.panels)
    }))
  };
  delete next.weights[PANEL_SLOT];
  return finishDrag(next);
}

// ── Rail and header actions ────────────────────────────────

/** The insertion slot among the remembered peers that are still present. */
function rememberedIndex(
  entries: readonly PanelId[],
  id: PanelId,
  order: readonly PanelId[],
  fallback: number
): number {
  const position = order.indexOf(id);
  if (position >= 0) {
    const following = order
      .slice(position + 1)
      .find((peer) => entries.includes(peer));
    if (following) return entries.indexOf(following);
    const preceding = order
      .slice(0, position)
      .reverse()
      .find((peer) => entries.includes(peer));
    if (preceding) return entries.indexOf(preceding) + 1;
  }
  return clamp(fallback, 0, entries.length);
}

/** Preserve the column's identity and order while its panels are closed. */
function columnHome(
  layout: PanelLayout,
  id: PanelId,
  location: Extract<PanelLocation, { kind: 'column' }>
): Extract<PanelHome, { kind: 'column' }> {
  const columns = sideColumns(layout, location.side);
  const peers = columns[location.column]!.slice();
  const homes = Object.entries(layout.homes).flatMap(([panel, home]) =>
    home.kind === 'column' && home.side === location.side
      ? [{ panel: panel as PanelId, home }]
      : []
  );
  // A previously closed peer remembers the original order even after the
  // last live peer leaves and the column itself disappears.
  for (const { home } of homes) {
    if (!home.peers?.some((peer) => peers.includes(peer))) continue;
    for (const peer of home.peers) {
      if (!peers.includes(peer) && !isPanelOpen(layout, peer)) {
        peers.splice(
          rememberedIndex(peers, peer, home.peers, peers.length),
          0,
          peer
        );
      }
    }
  }
  const preceding = new Set(columns.slice(0, location.column).flat());
  const following = new Set(columns.slice(location.column + 1).flat());
  // Include closed columns as anchors too. The graph has only five panel
  // identities, so five passes cover every remembered ordering relation.
  for (let pass = 0; pass < PANEL_IDS.length; pass++) {
    for (const { panel, home } of homes) {
      if (home.peers?.some((peer) => peers.includes(peer))) {
        home.preceding?.forEach((peer) => preceding.add(peer));
        home.following?.forEach((peer) => following.add(peer));
      } else {
        if (
          home.following?.some(
            (peer) => peers.includes(peer) || preceding.has(peer)
          )
        ) {
          preceding.add(panel);
          home.peers?.forEach((peer) => preceding.add(peer));
        }
        if (
          home.preceding?.some(
            (peer) => peers.includes(peer) || following.has(peer)
          )
        ) {
          following.add(panel);
          home.peers?.forEach((peer) => following.add(peer));
        }
      }
    }
  }
  peers.forEach((peer) => {
    preceding.delete(peer);
    following.delete(peer);
  });
  return {
    kind: 'column',
    side: location.side,
    column: location.column,
    index: peers.indexOf(id),
    ...(columns[location.column]!.length === 1 ? { alone: true } : {}),
    peers,
    ...(preceding.size ? { preceding: [...preceding] } : {}),
    ...(following.size ? { following: [...following] } : {})
  };
}

/** Restore an existing stack, or recreate its removed column in place. */
function reopenColumn(
  layout: PanelLayout,
  id: PanelId,
  home: Extract<PanelHome, { kind: 'column' }>,
  stage: PanelStage | undefined
): PanelLayout {
  // Older stored homes only recorded numeric positions.
  if (!home.peers) {
    return placeAt(
      layout,
      id,
      home.alone
        ? { kind: 'newColumn', side: home.side, column: home.column }
        : home,
      stage
    );
  }
  const columns = sideColumns(layout, home.side);
  const column = columns.findIndex((entries) =>
    entries.some((peer) => home.peers!.includes(peer))
  );
  if (column >= 0) {
    return placeAt(
      layout,
      id,
      {
        kind: 'column',
        side: home.side,
        column,
        index: rememberedIndex(columns[column]!, id, home.peers, home.index)
      },
      stage
    );
  }
  if (columns.length >= PANEL_MAX_COLUMNS[home.side]) return layout;
  const counts = { left: layout.left.length, right: layout.right.length };
  counts[home.side] += 1;
  if (
    stage &&
    overCap(
      dockFootprint(counts, columnWidthOf(layout.options), insetsOf(stage)),
      stage.width
    )
  )
    return layout;
  const before = columns.findIndex((entries) =>
    entries.some((peer) => home.following?.includes(peer))
  );
  let at = before;
  if (at < 0) {
    const after = columns.reduce(
      (last, entries, index) =>
        entries.some((peer) => home.preceding?.includes(peer)) ? index : last,
      -1
    );
    at = after < 0 ? clamp(home.column, 0, columns.length) : after + 1;
  }
  const next = copyLayout(layout);
  sideColumns(next, home.side).splice(at, 0, []);
  return placeAt(
    next,
    id,
    { kind: 'column', side: home.side, column: at, index: 0 },
    stage
  );
}

function homeOf(layout: PanelLayout, id: PanelId): PanelHome | null {
  const location = findPanel(layout, id);
  if (!location || location.kind === 'unpinned') {
    return null;
  }
  if (location.kind === 'column') {
    return columnHome(layout, id, location);
  }
  const group = layout.floats.find(
    (candidate) => candidate.id === location.groupId
  )!;
  const solo = group.panels.length === 1;
  return {
    kind: 'float',
    rect: {
      x: group.x,
      y: group.y,
      w: group.w,
      h: solo
        ? group.h
        : Math.max(FLOAT_GROWTH, heightInGroup(layout, group, id))
    }
  };
}

/** Closes a panel and remembers where it was, so reopening returns it there. */
export function closePanel(layout: PanelLayout, id: PanelId): PanelLayout {
  // Closing a closed panel again must not forget where it lives.
  if (!isPanelOpen(layout, id)) {
    return layout;
  }
  const home = homeOf(layout, id);
  const next = detach(layout, id, false);
  if (home) {
    next.homes[id] = home;
  } else {
    delete next.homes[id];
  }
  return next;
}

/** Opens `id` unpinned, closing the panel that was unpinned before it. */
function openUnpinned(layout: PanelLayout, id: PanelId): PanelLayout {
  const next = detach(layout, id, false);
  delete next.homes[id];
  next.unpinned = id;
  next.revealed = null;
  return next;
}

/**
 * Opens a panel from the rail: where it last lived if it has a home, else
 * unpinned. A home past the footprint cap is refused like any placement, so
 * the panel opens unpinned instead. An open panel stays where it is. Either
 * way the panel becomes the most recent and the panels show: opening one is
 * never left hidden.
 */
export function openPanel(
  layout: PanelLayout,
  id: PanelId,
  stage?: PanelStage
): PanelLayout {
  let next: PanelLayout = layout;
  if (stage && isPanelParked(layout, id, stage)) {
    next = revealPanel(layout, id);
  } else if (!isPanelOpen(layout, id)) {
    const home = layout.homes[id];
    if (home) {
      // The phone lane shows an open panel wherever it lives, so a phone
      // stage reopens it at home and a wider stage finds it there again.
      const phone = stage !== undefined && stage.width <= PANEL_PHONE_MAX_WIDTH;
      next =
        home.kind === 'float'
          ? placeAt(
              layout,
              id,
              { kind: 'float', rect: home.rect },
              phone ? undefined : stage
            )
          : reopenColumn(layout, id, home, phone ? undefined : stage);
      if (next !== layout) {
        // Back where it was, at the height it was given there.
        next.weights[id] = layout.weights[id];
      }
    }
    if (next === layout) {
      next = openUnpinned(layout, id);
    }
  }
  next = notePanelUsed(next, id);
  return next.options.hidden ? setOption(next, 'hidden', false) : next;
}

/**
 * Whether a docked panel's column is parked on this stage: past the
 * footprint cap, so it is not drawn.
 */
export function isPanelParked(
  layout: PanelLayout<PanelEntry>,
  id: PanelId,
  stage: PanelStage
): boolean {
  return computePanelGeometry(layout, stage).parked[id];
}

/**
 * Shows a parked panel in the unpinned slot, which it takes over: the panel
 * unpinned there before closes, as opening another panel would close it.
 */
function revealPanel(layout: PanelLayout, id: PanelId): PanelLayout {
  if (layout.revealed === id) {
    return layout;
  }
  const next = copyLayout(layout);
  next.unpinned = null;
  next.revealed = id;
  return next;
}

/**
 * A rail click: open a closed panel, close an open one. While the panels are
 * hidden it only shows them (opening the panel if it was closed), so a press
 * never closes something nobody can see. With a stage, a press on a parked
 * panel shows it in the unpinned slot, and a second press hides it again;
 * it stays docked throughout. Every press counts as a use.
 */
export function togglePanel(
  layout: PanelLayout,
  id: PanelId,
  stage?: PanelStage
): PanelLayout {
  if (
    stage &&
    !layout.options.hidden &&
    layout.revealed === id &&
    isPanelParked(layout, id, stage)
  ) {
    return notePanelUsed({ ...copyLayout(layout), revealed: null }, id);
  }
  if (layout.options.hidden || !isPanelOpen(layout, id)) {
    return openPanel(layout, id, stage);
  }
  // The phone lane shows one open panel; a press on another open one brings
  // it there rather than closing what nobody can see.
  if (
    stage &&
    stage.width <= PANEL_PHONE_MAX_WIDTH &&
    computePanelGeometry(layout, stage).phonePanel !== id
  ) {
    return notePanelUsed(layout, id);
  }
  if (stage && isPanelParked(layout, id, stage)) {
    return notePanelUsed(revealPanel(layout, id), id);
  }
  return notePanelUsed(closePanel(layout, id), id);
}

/**
 * Pins an unpinned, floating or closed panel at the end of the first right
 * column. A docked panel is already pinned and stays where it is. Past the
 * footprint cap the pin is refused and the layout comes back unchanged.
 */
export function pinPanel(
  layout: PanelLayout,
  id: PanelId,
  stage?: PanelStage
): PanelLayout {
  if (panelStatus(layout, id) === 'docked') {
    return layout;
  }
  return placeAt(
    layout,
    id,
    { kind: 'column', side: 'right', column: 0 },
    stage
  );
}

/** Takes a panel out of its dock or window to be the one unpinned panel. */
export function unpinPanel(layout: PanelLayout, id: PanelId): PanelLayout {
  return layout.unpinned === id ? layout : openUnpinned(layout, id);
}

export function popOutPanel(
  layout: PanelLayout,
  id: PanelId,
  rect: Rect,
  stage?: PanelStage
): PanelLayout {
  return placeAt(layout, id, { kind: 'float', rect }, stage);
}

/**
 * Where Pop out puts a panel: across from where it shows, toward the middle
 * of the stage, a little lower so both are visible during the move.
 */
export function popOutRect(geometry: PanelGeometry, id: PanelId): Rect {
  const rect = geometry.panels[id];
  const w = clamp(geometry.columnWidth, FLOAT_MIN_WIDTH, FLOAT_MAX_WIDTH);
  if (!rect) {
    return defaultFloatRect(geometry.layout, geometry.stage);
  }
  const x =
    rect.x < geometry.stage.width / 2
      ? rect.x + POP_OUT_OFFSET
      : rect.x - POP_OUT_OFFSET;
  return clampFloatRect(
    {
      x,
      y: rect.y + 24,
      w,
      h: Math.max(FLOAT_MIN_HEIGHT, Math.min(rect.h, 440))
    },
    geometry.stage
  );
}

// ── Gaps and floating windows ──────────────────────────────

/** The stack `above` and `below` are neighbours in, in that order. */
function neighbours(
  layout: PanelLayout,
  above: PanelId,
  below: PanelId
): boolean {
  const stacks = [
    ...layout.left,
    ...layout.right,
    ...layout.floats.map((group) => group.panels)
  ];
  return stacks.some((stack) => {
    const index = stack.indexOf(above);
    return index >= 0 && stack[index + 1] === below;
  });
}

/**
 * Drags the gap between two neighbouring panels by `deltaPx` (down is
 * positive), given the stack's pixels per weight, keeping both at least 90px.
 * Measure the delta from the drag's start and pass the layout from then, so
 * a long drag does not accumulate rounding. Other panels keep their share.
 */
export function resizeGap(
  layout: PanelLayout,
  above: PanelId,
  below: PanelId,
  deltaPx: number,
  pxPerWeight: number
): PanelLayout {
  if (
    layout.options.locked ||
    !neighbours(layout, above, below) ||
    !Number.isFinite(deltaPx) ||
    !Number.isFinite(pxPerWeight) ||
    pxPerWeight <= 0
  ) {
    return layout;
  }
  if (Math.abs(deltaPx) < 1e-9) {
    return layout;
  }
  // Work in rendered pixels: a panel whose share is under the minimum shows
  // at the minimum, so adding delta / pxPerWeight to its weight would not
  // move its edge. Setting both weights to their new heights over
  // pxPerWeight leaves the stack's pxPerWeight unchanged, so the gap tracks
  // the pointer exactly.
  const shownAbove = Math.max(
    PANEL_MIN_HEIGHT,
    layout.weights[above] * pxPerWeight
  );
  const shownBelow = Math.max(
    PANEL_MIN_HEIGHT,
    layout.weights[below] * pxPerWeight
  );
  const pair = shownAbove + shownBelow;
  const heightAbove = clamp(
    shownAbove + deltaPx,
    PANEL_MIN_HEIGHT,
    pair - PANEL_MIN_HEIGHT
  );
  if (heightAbove === shownAbove) return layout;
  const next = copyLayout(layout);
  next.weights[above] = heightAbove / pxPerWeight;
  next.weights[below] = (pair - heightAbove) / pxPerWeight;
  return next;
}

/**
 * A double-click on a gap: its two neighbours split evenly. Pass the shown
 * gap's scale to preserve the other panels' heights when minimums are held;
 * without a scale this retains the original stored-weight split behavior.
 */
export function splitGapEvenly(
  layout: PanelLayout,
  above: PanelId,
  below: PanelId,
  pxPerWeight?: number
): PanelLayout {
  if (layout.options.locked || !neighbours(layout, above, below)) {
    return layout;
  }
  if (pxPerWeight !== undefined) {
    const shownAbove = Math.max(
      PANEL_MIN_HEIGHT,
      layout.weights[above] * pxPerWeight
    );
    const shownBelow = Math.max(
      PANEL_MIN_HEIGHT,
      layout.weights[below] * pxPerWeight
    );
    return resizeGap(
      layout,
      above,
      below,
      (shownBelow - shownAbove) / 2,
      pxPerWeight
    );
  }
  const next = copyLayout(layout);
  const half = (layout.weights[above] + layout.weights[below]) / 2;
  next.weights[above] = half;
  next.weights[below] = half;
  return next;
}

/** Brings a floating window to the front. */
export function raiseFloat(layout: PanelLayout, groupId: string): PanelLayout {
  const k = layout.floats.findIndex((group) => group.id === groupId);
  if (k < 0 || k === layout.floats.length - 1) {
    return layout;
  }
  const next = copyLayout(layout);
  const [group] = next.floats.splice(k, 1);
  next.floats.push(group!);
  return next;
}

function updateFloat(
  layout: PanelLayout,
  groupId: string,
  update: (group: FloatGroup) => Rect
): PanelLayout {
  if (
    layout.options.locked ||
    !layout.floats.some((group) => group.id === groupId)
  ) {
    return layout;
  }
  const next = raiseFloat(copyLayout(layout), groupId);
  next.floats = next.floats.map((group) =>
    group.id === groupId ? { ...group, ...update(group) } : group
  );
  return next;
}

/** Moves a floating window, kept inside the stage, and brings it forward. */
export function moveFloat(
  layout: PanelLayout,
  groupId: string,
  position: Point,
  stage: PanelStage
): PanelLayout {
  return updateFloat(layout, groupId, (group) => {
    const bounds = floatBounds(stage);
    const shown = clampFloatRect(group, stage);
    return {
      x: clamp(position.x, bounds.left, bounds.right - shown.w),
      y: clamp(position.y, bounds.top, bounds.bottom - shown.h),
      w: group.w,
      h: group.h
    };
  });
}

/**
 * Resizes a floating window from its bottom-right corner: 260–600px wide and
 * at least 160px tall, and no further than the stage's edges where those
 * allow it.
 */
export function resizeFloat(
  layout: PanelLayout,
  groupId: string,
  size: { w: number; h: number },
  stage: PanelStage
): PanelLayout {
  return updateFloat(layout, groupId, (group) => {
    const bounds = floatBounds(stage);
    // From where the window shows: a stored position a smaller stage clamps
    // would otherwise pin the width to its minimum and make the window jump.
    const shown = clampFloatRect(group, stage);
    return {
      x: shown.x,
      y: shown.y,
      w: Math.max(
        FLOAT_MIN_WIDTH,
        Math.min(FLOAT_MAX_WIDTH, size.w, bounds.right - shown.x)
      ),
      h: Math.max(FLOAT_MIN_HEIGHT, Math.min(size.h, bounds.bottom - shown.y))
    };
  });
}

/** Stores every floating window as it shows on this stage. */
export function clampFloatsToStage(
  layout: PanelLayout,
  stage: PanelStage
): PanelLayout {
  if (layout.options.locked) {
    return layout;
  }
  const next = copyLayout(layout);
  next.floats = next.floats.map((group) => ({
    ...group,
    ...clampFloatRect(group, stage)
  }));
  return next;
}

// ── Geometry ───────────────────────────────────────────────

export interface PanelRect extends Rect {
  id: PanelEntry;
  /** `revealed`: a parked panel shown in the unpinned slot. */
  mode: 'docked' | 'floating' | 'unpinned' | 'revealed';
}

export interface ColumnGeometry extends Rect {
  side: DockSide;
  column: number;
  panels: PanelEntry[];
  /** The panels cannot all have 90px: each holds 90px and the column scrolls. */
  overflowing: boolean;
  /** The scrolling content's height; the column's height when it fits. */
  contentHeight: number;
}

export interface FloatGeometry extends Rect {
  id: string;
  panels: PanelEntry[];
  /** The window as it shows while a panel is being stacked into it. */
  grown: Rect;
  overflowing: boolean;
  contentHeight: number;
}

export interface GapGeometry extends Rect {
  above: PanelId;
  below: PanelId;
  pxPerWeight: number;
  /** Off while the stack overflows: the column scrolls instead. */
  enabled: boolean;
  container:
    | { kind: 'column'; side: DockSide; column: number }
    | { kind: 'float'; groupId: string };
}

export interface RailGeometry {
  side: DockSide;
  x: number;
  w: number;
}

export interface PanelGeometry {
  layout: PanelLayout<PanelEntry>;
  stage: PanelStage;
  insets: PanelInsets;
  columnWidth: number;
  /**
   * At or below 720px nothing docks and no window shows: the phone lane
   * shows one panel, `phonePanel`, and no panel has a rectangle.
   */
  phone: boolean;
  /** The most recently used open panel, which the phone lane shows. */
  phonePanel: PanelId | null;
  /** Every open panel, most recently used first. */
  phonePanels: PanelId[];
  dock: { top: number; bottom: number };
  /** Stored columns per side, including any parked. */
  columnCount: Record<DockSide, number>;
  /**
   * Docked columns past the footprint cap are parked: not drawn and not
   * drop targets, though the stored layout keeps them docked, so a wider
   * stage gets them back.
   */
  parkedColumns: Array<{ side: DockSide; column: number }>;
  /** The panels in parked columns, in column order. */
  parkedPanels: PanelId[];
  parked: Record<PanelId, boolean>;
  /** Each dock's docked columns with their gaps, for `--left-dock-w` and `--right-dock-w`. */
  dockWidth: Record<DockSide, number>;
  panels: Partial<Record<PanelEntry, PanelRect>>;
  /** Docked columns only. */
  columns: ColumnGeometry[];
  /** In z-order; none on a phone-width stage. */
  floats: FloatGeometry[];
  rails: Record<DockSide, RailGeometry>;
  gaps: GapGeometry[];
}

/**
 * Which stored columns dock on this stage: the docks' footprint stays within
 * the cap. Past it, every left column gives way before any right one — the
 * right dock, where pins land and the instrument rail lives, is primary —
 * and within a side the outermost goes first.
 */
function dockedCounts(
  layout: PanelLayout<PanelEntry>,
  stageWidth: number,
  columnWidth: number,
  insets: PanelInsets
): Record<DockSide, number> {
  if (stageWidth <= PANEL_PHONE_MAX_WIDTH) {
    return { left: 0, right: 0 };
  }
  const counts = { left: layout.left.length, right: layout.right.length };
  while (
    counts.left + counts.right > 0 &&
    overCap(dockFootprint(counts, columnWidth, insets), stageWidth)
  ) {
    if (counts.left > 0) {
      counts.left -= 1;
    } else {
      counts.right -= 1;
    }
  }
  return counts;
}

/** Open panels, most recently used first, then the rest in panel order. */
function openByRecency(layout: PanelLayout<PanelEntry>): PanelId[] {
  const open = PANEL_IDS.filter((id) => findPanel(layout, id) !== null);
  return [
    ...layout.recent.filter((id) => open.includes(id)),
    ...open.filter((id) => !layout.recent.includes(id))
  ];
}

/**
 * The rectangles a layout takes on a stage. A projection only: columns past
 * the cap are parked, a phone-width stage shows one panel and no docks or
 * windows, short columns scroll and windows stay inside the stage, all
 * without touching the layout.
 */
export function computePanelGeometry(
  layout: PanelLayout<PanelEntry>,
  stage: PanelStage
): PanelGeometry {
  const insets = insetsOf(stage);
  const columnWidth = columnWidthOf(layout.options);
  const phone = stage.width <= PANEL_PHONE_MAX_WIDTH;
  const docked = dockedCounts(layout, stage.width, columnWidth, insets);
  const dock = {
    top: insets.top,
    bottom: Math.max(insets.top, stage.height - insets.bottom)
  };
  const dockHeight = dock.bottom - dock.top;
  const step = columnWidth + insets.gap;
  const dockWidth = { left: docked.left * step, right: docked.right * step };
  const rails: Record<DockSide, RailGeometry> = {
    right: {
      side: 'right',
      x: stage.width - insets.gap - dockWidth.right - insets.rail,
      w: insets.rail
    },
    left: { side: 'left', x: insets.gap + dockWidth.left, w: insets.rail }
  };
  const geometry: PanelGeometry = {
    layout,
    stage,
    insets,
    columnWidth,
    phone,
    phonePanel: null,
    phonePanels: [],
    dock,
    columnCount: { left: layout.left.length, right: layout.right.length },
    parkedColumns: [],
    parkedPanels: [],
    parked: {
      parameters: false,
      bodies: false,
      history: false,
      revisions: false,
      diagnostics: false
    },
    dockWidth,
    panels: {},
    columns: [],
    floats: [],
    rails,
    gaps: []
  };

  const stack = (
    entries: PanelEntry[],
    rect: Rect,
    mode: PanelRect['mode'],
    container: GapGeometry['container']
  ): { overflowing: boolean; contentHeight: number } => {
    const result = stackHeights(
      entries.map((entry) => weightOf(layout, entry)),
      rect.h
    );
    let y = rect.y;
    entries.forEach((entry, k) => {
      const h = result.heights[k]!;
      geometry.panels[entry] = { id: entry, mode, x: rect.x, y, w: rect.w, h };
      const below = entries[k + 1];
      if (below && entry !== PANEL_SLOT && below !== PANEL_SLOT) {
        geometry.gaps.push({
          above: entry,
          below,
          x: rect.x,
          y: y + h,
          w: rect.w,
          h: PANEL_STACK_GAP,
          pxPerWeight: result.pxPerWeight,
          enabled: !result.overflowing,
          container
        });
      }
      y += h + PANEL_STACK_GAP;
    });
    return {
      overflowing: result.overflowing,
      contentHeight: result.contentHeight
    };
  };

  const columnX = (side: DockSide, column: number): number =>
    side === 'right'
      ? stage.width -
        insets.gap -
        (column + 1) * columnWidth -
        column * insets.gap
      : insets.gap + column * step;

  if (phone) {
    geometry.phonePanels = openByRecency(layout);
    geometry.phonePanel = geometry.phonePanels[0] ?? null;
    return geometry;
  }

  for (const side of DOCK_SIDES) {
    sideColumns(layout, side).forEach((entries, column) => {
      if (column >= docked[side]) {
        geometry.parkedColumns.push({ side, column });
        for (const entry of entries) {
          if (entry !== PANEL_SLOT) {
            geometry.parkedPanels.push(entry);
            geometry.parked[entry] = true;
          }
        }
        return;
      }
      const rect = {
        x: columnX(side, column),
        y: dock.top,
        w: columnWidth,
        h: dockHeight
      };
      const fit = stack(entries, rect, 'docked', {
        kind: 'column',
        side,
        column
      });
      geometry.columns.push({
        ...rect,
        side,
        column,
        panels: entries.slice(),
        ...fit
      });
    });
  }

  for (const group of layout.floats) {
    const rect = clampFloatRect(group, stage);
    const fit = stack(group.panels, rect, 'floating', {
      kind: 'float',
      groupId: group.id
    });
    geometry.floats.push({
      ...rect,
      id: group.id,
      panels: group.panels.slice(),
      grown: grownFloatRect(rect, stage),
      ...fit
    });
  }

  // One slot: a parked panel revealed in it, or else the unpinned panel. A
  // revealed panel that is no longer parked is already drawn docked.
  const revealed =
    layout.revealed && geometry.parked[layout.revealed]
      ? layout.revealed
      : null;
  const slot = revealed ?? layout.unpinned;
  if (slot) {
    geometry.panels[slot] = {
      id: slot,
      mode: revealed ? 'revealed' : 'unpinned',
      x: Math.max(insets.gap, rails.right.x - insets.gap - columnWidth),
      y: dock.top,
      w: columnWidth,
      h: dockHeight
    };
  }
  return geometry;
}

// ── Hit-testing ────────────────────────────────────────────

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Whether a press has moved far enough to be a drag. */
export function isDragStart(start: Point, point: Point): boolean {
  return distance(start, point) >= PANEL_DRAG_THRESHOLD;
}

export interface HitTestOptions {
  /** The drag came out of a rail button. */
  fromRail?: boolean;
  startPoint?: Point;
  /** The target hovered last; a window it names is tested at its grown size. */
  current?: PanelTarget | null;
}

function within(
  point: Point,
  x0: number,
  x1: number,
  y0: number,
  y1: number
): boolean {
  return point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1;
}

/** The slot a drop at `y` takes, from the panels as they are without a preview. */
function slotIndex(
  geometry: PanelGeometry,
  entries: readonly PanelEntry[],
  y: number
): number {
  for (let k = 0; k < entries.length; k++) {
    const rect = geometry.panels[entries[k]!];
    if (rect && y < rect.y + rect.h / 2) {
      return k;
    }
  }
  return entries.length;
}

/**
 * The drop target under `point`, or null to float the panel where it is
 * dropped. Pass the geometry of the layout without the preview (from
 * `beginDrag`), so the preview making room cannot move the target away from
 * the cursor. Windows win over docks, the topmost first; then the docked
 * columns (a parked column is not a target); then each side's new-column span, which covers the rail plus one
 * column so the rail sliding inward while it is hovered cannot flicker it.
 */
export function hitTest(
  geometry: PanelGeometry,
  point: Point,
  options: HitTestOptions = {}
): PanelTarget | null {
  if (
    options.fromRail &&
    options.startPoint &&
    distance(point, options.startPoint) < PANEL_RAIL_DRAG_CLEARANCE
  ) {
    return null;
  }
  const current = options.current;
  for (let k = geometry.floats.length - 1; k >= 0; k--) {
    const group = geometry.floats[k]!;
    const hovered = current?.kind === 'group' && current.groupId === group.id;
    const rect = hovered ? group.grown : group;
    if (
      !within(
        point,
        rect.x,
        rect.x + rect.w,
        rect.y - FLOAT_FRAME_GRIP,
        rect.y + rect.h
      )
    ) {
      continue;
    }
    return {
      kind: 'group',
      groupId: group.id,
      index: slotIndex(geometry, group.panels, point.y)
    };
  }
  if (
    geometry.phone ||
    point.y < geometry.dock.top - DOCK_HIT_SLACK ||
    point.y > geometry.dock.bottom + DOCK_HIT_SLACK
  ) {
    return null;
  }
  for (const column of geometry.columns) {
    if (point.x >= column.x && point.x <= column.x + column.w) {
      return {
        kind: 'column',
        side: column.side,
        column: column.column,
        index: slotIndex(geometry, column.panels, point.y)
      };
    }
  }
  const span =
    geometry.insets.rail +
    geometry.insets.gap +
    geometry.columnWidth +
    geometry.insets.gap;
  // A drag keeps the column it emptied until the drop, so count only the
  // columns with something in them, as placement does.
  const live = (side: DockSide): number =>
    sideColumns(geometry.layout, side).filter((column) => column.length > 0)
      .length;
  const right = geometry.rails.right;
  if (live('right') < PANEL_MAX_COLUMNS.right) {
    const outer = right.x + right.w;
    if (point.x >= outer - span && point.x <= outer) {
      return { kind: 'newColumn', side: 'right' };
    }
  }
  const left = geometry.rails.left;
  if (live('left') < PANEL_MAX_COLUMNS.left) {
    if (point.x >= left.x && point.x <= left.x + span) {
      return { kind: 'newColumn', side: 'left' };
    }
  }
  return null;
}

// ── Persistence ────────────────────────────────────────────

/** The subset of `Storage` this module needs. */
export interface PanelLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeRect(value: unknown): Rect | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  return {
    x: clamp(finiteOr(raw.x, 0), 0, COORD_MAX),
    y: clamp(finiteOr(raw.y, 0), 0, COORD_MAX),
    w: clamp(
      finiteOr(raw.w, FLOAT_MIN_WIDTH),
      FLOAT_MIN_WIDTH,
      FLOAT_MAX_WIDTH
    ),
    h: clamp(finiteOr(raw.h, FLOAT_DEFAULT_HEIGHT), FLOAT_MIN_HEIGHT, COORD_MAX)
  };
}

function normalizeHome(value: unknown): PanelHome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'column' && (raw.side === 'left' || raw.side === 'right')) {
    const side: DockSide = raw.side;
    const panelIds = (value: unknown): PanelId[] =>
      Array.isArray(value) ? [...new Set(value.filter(isPanelId))] : [];
    const peers = panelIds(raw.peers);
    const preceding = panelIds(raw.preceding).filter(
      (id) => !peers.includes(id)
    );
    const following = panelIds(raw.following).filter(
      (id) => !peers.includes(id) && !preceding.includes(id)
    );
    return {
      kind: 'column',
      side,
      column: clamp(
        Math.trunc(finiteOr(raw.column, 0)),
        0,
        PANEL_MAX_COLUMNS[side] - 1
      ),
      index: clamp(Math.trunc(finiteOr(raw.index, 0)), 0, PANEL_IDS.length),
      ...(raw.alone === true ? { alone: true } : {}),
      ...(peers.length ? { peers } : {}),
      ...(preceding.length ? { preceding } : {}),
      ...(following.length ? { following } : {})
    };
  }
  if (raw.kind === 'float') {
    const rect = normalizeRect(raw.rect);
    return rect ? { kind: 'float', rect } : null;
  }
  return null;
}

/**
 * A stored layout made safe: unknown ids and repeats dropped (the first
 * place a panel appears wins: right, left, windows, unpinned; the recency
 * list keeps each panel's first entry), empty columns
 * and windows dropped, columns past a dock's limit stacked into its last
 * column, numbers clamped and weights defaulted. Anything that is not an
 * object is the default layout.
 */
export function normalizePanelLayout(
  value: unknown,
  { leftDock = false }: { leftDock?: boolean } = {}
): PanelLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultPanelLayout({ leftDock });
  }
  const root = value as Record<string, unknown>;
  const layout = emptyLayout();
  const seen = new Set<PanelId>();
  const take = (entries: unknown): PanelId[] => {
    if (!Array.isArray(entries)) {
      return [];
    }
    const kept: PanelId[] = [];
    for (const entry of entries as unknown[]) {
      if (isPanelId(entry) && !seen.has(entry)) {
        seen.add(entry);
        kept.push(entry);
      }
    }
    return kept;
  };
  const columnsOf = (raw: unknown, side: DockSide): PanelId[][] => {
    if (!Array.isArray(raw)) {
      return [];
    }
    const columns = (raw as unknown[])
      .map(take)
      .filter((column) => column.length > 0);
    const max = PANEL_MAX_COLUMNS[side];
    if (columns.length > max) {
      const kept = columns.slice(0, max);
      kept[max - 1] = [...kept[max - 1]!, ...columns.slice(max).flat()];
      return kept;
    }
    return columns;
  };
  layout.right = columnsOf(root.right, 'right');
  layout.left = columnsOf(root.left, 'left');

  const ids = new Set<string>();
  if (Array.isArray(root.floats)) {
    for (const raw of root.floats as unknown[]) {
      const rect = normalizeRect(raw);
      if (!rect) {
        continue;
      }
      const panels = take((raw as Record<string, unknown>).panels);
      if (panels.length === 0) {
        continue;
      }
      const rawId = (raw as Record<string, unknown>).id;
      let id =
        typeof rawId === 'string' &&
        FLOAT_ID_PATTERN.test(rawId) &&
        !ids.has(rawId)
          ? rawId
          : '';
      if (!id) {
        id = nextFloatId(layout);
        while (ids.has(id)) {
          id = `${id}-x`;
        }
      }
      ids.add(id);
      layout.floats.push({ id, ...rect, panels });
    }
  }

  if (isPanelId(root.unpinned) && !seen.has(root.unpinned)) {
    layout.unpinned = root.unpinned;
    seen.add(root.unpinned);
  }

  if (Array.isArray(root.recent)) {
    layout.recent = [...new Set((root.recent as unknown[]).filter(isPanelId))];
  }

  const weights = root.weights;
  if (weights && typeof weights === 'object' && !Array.isArray(weights)) {
    for (const id of PANEL_IDS) {
      const weight = (weights as Record<string, unknown>)[id];
      if (typeof weight === 'number' && Number.isFinite(weight)) {
        layout.weights[id] = clamp(weight, WEIGHT_MIN, WEIGHT_MAX);
      }
    }
  }

  // Only a closed panel has a home.
  const homes = root.homes;
  if (homes && typeof homes === 'object' && !Array.isArray(homes)) {
    for (const id of PANEL_IDS) {
      const home = seen.has(id)
        ? null
        : normalizeHome((homes as Record<string, unknown>)[id]);
      if (home) {
        layout.homes[id] = home;
      }
    }
  }

  const options = root.options;
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    const raw = options as Record<string, unknown>;
    for (const key of ['hidden', 'locked', 'compact'] as const) {
      if (typeof raw[key] === 'boolean') {
        layout.options[key] = raw[key];
      }
    }
    if (
      raw.width === 'narrow' ||
      raw.width === 'regular' ||
      raw.width === 'wide'
    ) {
      layout.options.width = raw.width;
    }
  }
  return layout;
}

/**
 * The first layout for a device that has the v1 drawer state: an open drawer
 * becomes one right column of the sections it had open, in the drawer's
 * order; a closed drawer is Model only.
 */
export function migratePanelState(state: PanelState): PanelLayout {
  const layout = emptyLayout();
  if (state.drawerOpen) {
    const open = PANEL_IDS.filter((id) => state.sidebarSections[id]);
    if (open.length > 0) {
      layout.right = [open];
    }
  }
  return layout;
}

function defaultStorage(): PanelLayoutStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readLegacy(storage: PanelLayoutStorage): PanelState | null {
  try {
    const raw = storage.getItem(PANEL_STATE_STORAGE_KEY);
    return raw ? normalizePanelState(JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

export interface LoadPanelLayoutOptions {
  /**
   * Whether the left dock ships. It decides only a new device's default —
   * two-sided Essentials, or the right-only form until then — and never
   * rewrites a layout already stored.
   */
  leftDock?: boolean;
}

/**
 * The device's layout. Without the new key it migrates from the v1 drawer
 * state (read from the same storage unless `legacy` is given; `null` means
 * none), and a device with neither gets the default. Loading never writes:
 * the new key's absence is the signal to migrate, so nothing may store a
 * default before the migration has run.
 */
export function loadPanelLayout(
  storage: PanelLayoutStorage | null = defaultStorage(),
  legacy?: PanelState | null,
  { leftDock = false }: LoadPanelLayoutOptions = {}
): PanelLayout {
  if (!storage) {
    return defaultPanelLayout({ leftDock });
  }
  let raw: string | null;
  try {
    raw = storage.getItem(PANEL_LAYOUT_STORAGE_KEY);
  } catch {
    return defaultPanelLayout({ leftDock });
  }
  if (raw !== null) {
    try {
      return normalizePanelLayout(JSON.parse(raw) as unknown, { leftDock });
    } catch {
      return defaultPanelLayout({ leftDock });
    }
  }
  const state = legacy === undefined ? readLegacy(storage) : legacy;
  return state ? migratePanelState(state) : defaultPanelLayout({ leftDock });
}

export function savePanelLayout(
  layout: PanelLayout,
  storage: PanelLayoutStorage | null = defaultStorage()
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(
      PANEL_LAYOUT_STORAGE_KEY,
      JSON.stringify(normalizePanelLayout(layout))
    );
    return true;
  } catch {
    return false;
  }
}
