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
/**
 * The dock gap (`--dock-gap`): between panels stacked in one column or
 * window, between a dock's columns, and between a dock and its rail.
 */
export const PANEL_STACK_GAP = 4;
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
/**
 * A column's foot dragged within this of the dock's foot fills the dock
 * again: the stored height is dropped rather than kept a few pixels short.
 */
export const COLUMN_FILL_SNAP = 16;
/** Sets of panels whose column height is remembered, the latest kept. */
const COLUMN_HEIGHTS_MAX = 16;
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
  /**
   * Docked panels hug their content (View options › Fit panels to
   * content): one drawn shorter than its share leaves the rest to the
   * panels beside it, or to the model. Off, the default, every docked panel
   * fills its share, as a window's panels always do. Stored as `hug`: the
   * `fit` key it replaced defaulted on, and is ignored so every device
   * starts filling.
   */
  hug: boolean;
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
  /**
   * Docked columns the user shortened, keyed by the set of panels in them
   * (`columnKey`): such a column ends this many pixels below the dock's
   * top. A column without an entry fills the dock, so adding a panel to a
   * shortened column fills it again, and taking it back out returns the
   * height that set of panels was given.
   */
  columnHeights: Record<string, number>;
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
 * Essentials while only the right dock shipped: Objects over Parameters in
 * one right column. The default for `leftDock: false`, which the app no
 * longer asks for since the left dock shipped (U08 slice 4); not a menu
 * entry.
 */
export const ESSENTIALS_RIGHT_PRESET = 'essentials-right';
export type PanelPreset = PanelPresetId | typeof ESSENTIALS_RIGHT_PRESET;

export interface PanelInsets {
  /** The docks' top: under the top bar (`--stage-top`). Windows ignore it. */
  top: number;
  /** The docks' bottom margin (`--island-gap`). Windows ignore it. */
  bottom: number;
  /**
   * The island gap (`--island-gap`): from each side edge to its outermost
   * column, and from a rail with no dock to the edge.
   */
  gap: number;
  /**
   * The dock gap (`--dock-gap`): between a dock's columns, and between a
   * dock and its rail. Tighter than the island gap: a dock is one surface.
   */
  between: number;
  /** A rail's width (`--rail-w`). */
  rail: number;
}

/** The quiet stage's tokens: a 40px top bar between two 10px gaps. */
export const DEFAULT_PANEL_INSETS: Readonly<PanelInsets> = {
  top: 60,
  bottom: 10,
  gap: PANEL_COLUMN_GAP,
  between: PANEL_STACK_GAP,
  rail: PANEL_RAIL_WIDTH
};

/** The viewer area the panels sit over, in CSS pixels. */
export interface PanelStage {
  width: number;
  height: number;
  insets?: Partial<PanelInsets>;
  /**
   * Each drawn panel's natural height: its header, its content and its
   * frame, as tall as it would be with room to spare. A docked panel is
   * never drawn taller (it hugs its content and its column's other panels
   * take the rest); a panel without one fills its share.
   */
  naturals?: Partial<Record<PanelEntry, number>>;
}

const DEFAULT_OPTIONS: PanelLayoutOptions = {
  hidden: false,
  locked: false,
  compact: false,
  hug: false,
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
    columnHeights: { ...layout.columnHeights },
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

/**
 * The key a column's stored height goes under: its panels in panel order,
 * so reordering a column keeps its height. Null for a column holding a drop
 * preview's slot, or nothing.
 */
export function columnKey(entries: readonly PanelEntry[]): string | null {
  if (entries.length === 0 || entries.includes(PANEL_SLOT)) return null;
  return PANEL_IDS.filter((id) => entries.includes(id)).join('+');
}

function isColumnKey(key: string): boolean {
  const ids = key.split('+');
  return (
    ids.length > 0 &&
    ids.every(isPanelId) &&
    new Set(ids).size === ids.length &&
    columnKey(ids) === key
  );
}

/** The height the user gave a column of these panels, if any. */
function storedColumnHeight(
  layout: PanelLayout<PanelEntry>,
  entries: readonly PanelEntry[]
): number | null {
  const key = columnKey(entries);
  return key === null ? null : (layout.columnHeights[key] ?? null);
}

/** The least a column of `count` panels may be: each panel's minimum. */
export function columnMinimum(count: number): number {
  return count * PANEL_MIN_HEIGHT + Math.max(0, count - 1) * PANEL_STACK_GAP;
}

/**
 * Sets how tall a docked column of `panels` is drawn, given the dock's
 * height. Within `snap` of the dock's foot (or past it) the column fills
 * the dock again; it never goes under its panels' minimums. A drag snaps
 * by `COLUMN_FILL_SNAP`; a keyboard step passes 0, or a step up from a
 * full column would land inside the snap and never shorten it. Locked,
 * nothing changes.
 */
export function resizeColumn(
  layout: PanelLayout,
  panels: readonly PanelId[],
  height: number,
  dockHeight: number,
  snap = COLUMN_FILL_SNAP
): PanelLayout {
  const key = columnKey(panels);
  if (
    layout.options.locked ||
    key === null ||
    !Number.isFinite(height) ||
    !Number.isFinite(dockHeight)
  ) {
    return layout;
  }
  const fills = height >= dockHeight - Math.max(0, snap);
  const next = fills
    ? null
    : Math.round(clamp(height, columnMinimum(panels.length), dockHeight));
  const current = layout.columnHeights[key] ?? null;
  if (next === current) return layout;
  const copy = copyLayout(layout);
  delete copy.columnHeights[key];
  if (next !== null) {
    // The latest entry last, so the cap drops the oldest.
    copy.columnHeights[key] = next;
    const keys = Object.keys(copy.columnHeights);
    for (const old of keys.slice(0, keys.length - COLUMN_HEIGHTS_MAX)) {
      delete copy.columnHeights[old];
    }
  }
  return copy;
}

function insetsOf(stage: PanelStage): PanelInsets {
  return { ...DEFAULT_PANEL_INSETS, ...stage.insets };
}

export function columnWidthOf(options: PanelLayoutOptions): number {
  return PANEL_COLUMN_WIDTHS[options.width];
}

/**
 * The area floating windows are kept inside: the whole stage. A window may
 * go anywhere on screen, over the top islands and the rails too, as long as
 * all of it stays on screen; only the docks keep to the insets. A stacked
 * window (`stacked`) keeps its grip bar, which stands above its frame, on
 * screen too: the grip is the only handle that moves the whole stack.
 */
function floatBounds(
  stage: PanelStage,
  stacked = false
): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const top = stacked ? FLOAT_FRAME_GRIP : 0;
  return {
    left: 0,
    top,
    right: Math.max(0, stage.width),
    bottom: Math.max(top, stage.height)
  };
}

/** Whether a window stacks panels, and so draws the grip above its frame. */
function isStacked(rect: Rect | FloatGroup<PanelEntry>): boolean {
  return 'panels' in rect && rect.panels.length > 1;
}

/**
 * A rectangle moved and, if it must be, shrunk to lie inside the stage.
 * Pass a window's group to keep a stack's grip on screen as well.
 */
export function clampFloatRect(
  rect: Rect | FloatGroup<PanelEntry>,
  stage: PanelStage
): Rect {
  const bounds = floatBounds(stage, isStacked(rect));
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
  // Grown, it is a stack: its grip stays on screen.
  const bounds = floatBounds(stage, true);
  const h = Math.min(rect.h + FLOAT_GROWTH, bounds.bottom - bounds.top);
  const y =
    rect.y + h > bounds.bottom
      ? Math.max(bounds.top, bounds.bottom - h)
      : Math.max(bounds.top, rect.y);
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
 * overflows (the column scrolls as one). A panel with a cap (its natural
 * height) is never drawn taller: it is held there and the others share what
 * it leaves, and a stack whose panels all hug their content ends short of
 * `height` (`contentHeight` is then what it takes). A cap under 90px is that
 * panel's minimum too. Weights are never changed.
 */
function stackHeights(
  weights: readonly number[],
  height: number,
  caps?: readonly number[]
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
  const cap = (k: number): number => caps?.[k] ?? Number.POSITIVE_INFINITY;
  const minimum = (k: number): number => Math.min(PANEL_MIN_HEIGHT, cap(k));
  const gaps = PANEL_STACK_GAP * (n - 1);
  let needed = gaps;
  for (let k = 0; k < n; k++) needed += minimum(k);
  if (needed > height) {
    return {
      heights: weights.map((_, k) => minimum(k)),
      pxPerWeight: 0,
      overflowing: true,
      contentHeight: needed
    };
  }
  // Each panel is its weight times one scale, held between its minimum and
  // its cap: the scale is the one at which the stack fills `height`. The
  // total only grows with the scale, so a bisection finds it; the panels it
  // leaves free then fix it exactly. Holding a panel at its minimum before a
  // neighbour's cap freed room for it kept the column short.
  const lowest = (k: number): number => minimum(k);
  const shown = (k: number, scale: number): number =>
    Math.min(cap(k), Math.max(lowest(k), weights[k]! * scale));
  const total = (scale: number): number => {
    let sum = gaps;
    for (let k = 0; k < n; k++) sum += shown(k, scale);
    return sum;
  };
  const allCapped = weights.every((_, k) => Number.isFinite(cap(k)));
  if (allCapped && total(Number.MAX_VALUE) <= height) {
    // Every panel hugs its content and they all fit: the column ends short.
    const heights = weights.map((_, k) => cap(k));
    return {
      heights,
      pxPerWeight: 0,
      overflowing: false,
      contentHeight: heights.reduce((sum, h) => sum + h, gaps)
    };
  }
  let low = 0;
  let high = 1;
  while (total(high) < height && high < Number.MAX_VALUE / 4) high *= 2;
  for (let round = 0; round < 80; round++) {
    const middle = (low + high) / 2;
    if (total(middle) < height) {
      low = middle;
    } else {
      high = middle;
    }
  }
  // The panels the scale leaves between their bounds share what the held
  // ones leave, exactly.
  let free = height - gaps;
  let freeWeight = 0;
  const held = weights.map((weight, k) => {
    const at = shown(k, high);
    const isHeld = at === cap(k) || at === lowest(k);
    if (isHeld && weight * high !== at) {
      free -= at;
      return at;
    }
    freeWeight += weight;
    return null;
  });
  const pxPerWeight = freeWeight > 0 ? free / freeWeight : 0;
  const heights = weights.map((weight, k) => held[k] ?? weight * pxPerWeight);
  return {
    heights,
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
    columnHeights: {},
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

/** Each panel's share of its column's height, column by column. */
function columnShares(
  columns: readonly PanelId[][],
  weights: Readonly<Record<PanelId, number>>
): number[][] {
  return columns.map((column) => {
    const total = column.reduce((sum, id) => sum + weights[id], 0);
    return column.map((id) => weights[id] / total);
  });
}

/**
 * The menu preset the layout is arranged as, or null once it has been
 * rearranged: the same panels in the same columns, no window, and each
 * column split in the same proportions. The unpinned panel, the homes and
 * the settings are not part of an arrangement.
 */
export function matchingPreset(layout: PanelLayout): PanelPresetId | null {
  // A shortened column is a rearrangement too: every preset fills the dock.
  if (
    layout.floats.length > 0 ||
    [...layout.left, ...layout.right].some(
      (column) => storedColumnHeight(layout, column) !== null
    )
  ) {
    return null;
  }
  const same = (a: readonly PanelId[][], b: readonly PanelId[][]) =>
    a.length === b.length &&
    a.every(
      (column, k) =>
        column.length === b[k]!.length &&
        column.every((id, n) => id === b[k]![n])
    );
  return (
    PANEL_PRESET_IDS.find((name) => {
      const preset = presetLayout(name, layout.options);
      if (
        !same(layout.left, preset.left) ||
        !same(layout.right, preset.right)
      ) {
        return false;
      }
      const shares = columnShares(
        [...layout.left, ...layout.right],
        layout.weights
      ).flat();
      const expected = columnShares(
        [...preset.left, ...preset.right],
        preset.weights
      ).flat();
      return shares.every((share, k) => Math.abs(share - expected[k]!) < 1e-6);
    }) ?? null
  );
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
  insets: Pick<PanelInsets, 'gap' | 'between' | 'rail'> = DEFAULT_PANEL_INSETS
): number {
  const side = insets.gap + insets.rail + insets.gap;
  return (
    side * 2 + (columns.left + columns.right) * (columnWidth + insets.between)
  );
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
  return arrangedGeometry(placed, stage).parked[id] === true;
}

/**
 * A window beside the right rail's inner edge, where the unpinned panel
 * shows: where Pop out puts a panel that has no rectangle on screen.
 */
export function defaultFloatRect(
  layout: PanelLayout<PanelEntry>,
  stage: PanelStage
): Rect {
  const geometry = arrangedGeometry(layout, stage);
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
  const from = layout.floats.find((group) => group.panels.includes(id));
  const ownWindow = target.kind === 'group' && from?.id === target.groupId;
  let next: PanelLayout<PanelEntry>;
  if (ownWindow && from.panels.length === 1) {
    // A window of one closes on detach; dropping its panel back into it
    // restores the same window rather than opening a new one at the origin.
    next = copyLayout(detached);
    next.floats.push({ ...from, panels: [entry] });
  } else {
    next = insertAt(detached, entry, target, stage);
  }
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
  if (ownWindow && from.panels.length > 1) {
    // A reorder within one window keeps its rectangle: detaching shrank it
    // by the panel's share and inserting grew it by FLOAT_GROWTH, which differ.
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
  return arrangedGeometry(layout, stage).parked[id];
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
 * it stays docked throughout. On a phone-width stage, where the lane shows
 * only the most recently used open panel, a press on an open panel the lane
 * is not showing brings it into the lane rather than closing it unseen.
 * Wider, a press on a floating panel whose window another covers brings it
 * to the front. Every press counts as a use.
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
    arrangedGeometry(layout, stage).phonePanel !== id
  ) {
    return notePanelUsed(layout, id);
  }
  if (stage && isPanelParked(layout, id, stage)) {
    return notePanelUsed(revealPanel(layout, id), id);
  }
  // A window another one covers comes to the front instead: the press asks
  // for the panel, and closing one the person cannot fully see would lose it.
  // The phone lane draws no windows, so the panel it shows closes as usual.
  if (
    !(stage && stage.width <= PANEL_PHONE_MAX_WIDTH) &&
    isFloatCovered(layout, id, stage)
  ) {
    return notePanelUsed(layout, id);
  }
  return notePanelUsed(closePanel(layout, id), id);
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)
  );
}

/**
 * Whether a floating panel's window has another window over it, as they
 * show on `stage` (or as stored without one).
 */
export function isFloatCovered(
  layout: PanelLayout<PanelEntry>,
  id: PanelId,
  stage?: PanelStage
): boolean {
  const k = layout.floats.findIndex((group) => group.panels.includes(id));
  if (k < 0) {
    return false;
  }
  const shown = (rect: Rect): Rect =>
    stage ? clampFloatRect(rect, stage) : rect;
  const own = shown(layout.floats[k]!);
  return layout.floats
    .slice(k + 1)
    .some((group) => rectsOverlap(own, shown(group)));
}

/**
 * Makes a panel visible for a search result (⌘K): a closed panel opens
 * unpinned — not at its home, since the person asked for a row in it, not
 * for a layout — and an open one stays where it is. Either way it becomes the
 * most recent, so a phone-width lane shows it, a parked one shows in the
 * unpinned slot, and Hide all turns off.
 */
export function presentPanel(
  layout: PanelLayout,
  id: PanelId,
  stage?: PanelStage
): PanelLayout {
  let next: PanelLayout = layout;
  if (!isPanelOpen(layout, id)) {
    next = openUnpinned(layout, id);
  } else if (stage && isPanelParked(layout, id, stage)) {
    next = revealPanel(layout, id);
  }
  next = notePanelUsed(next, id);
  return next.options.hidden ? setOption(next, 'hidden', false) : next;
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

/**
 * Moves a docked or floating panel one place up (`-1`) or down (`1`) in its
 * column or window, the keyboard's way to reach any slot. At either end, or
 * for a panel in neither, the layout comes back unchanged.
 */
export function movePanelInStack(
  layout: PanelLayout,
  id: PanelId,
  step: -1 | 1,
  stage?: PanelStage
): PanelLayout {
  const location = findPanel(layout, id);
  if (!location || location.kind === 'unpinned') {
    return layout;
  }
  const stack =
    location.kind === 'column'
      ? sideColumns(layout, location.side)[location.column]!
      : layout.floats.find((group) => group.id === location.groupId)!.panels;
  const index = location.index + step;
  if (index < 0 || index >= stack.length) {
    return layout;
  }
  // Slots count without the panel itself: lifted out, the one it passes
  // takes its index.
  return placePanel(
    layout,
    id,
    location.kind === 'column'
      ? {
          kind: 'column',
          side: location.side,
          column: location.column,
          index
        }
      : { kind: 'group', groupId: location.groupId, index },
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
 * Where a gap's upper panel's lower edge may go: each panel keeps its
 * minimum (or its smaller drawn height) and grows no taller than its cap.
 */
export function gapRange(shown: GapShown): {
  lowest: number;
  highest: number;
} {
  const pair = shown.above + shown.below;
  return {
    lowest: Math.max(
      Math.min(PANEL_MIN_HEIGHT, shown.above),
      pair - shown.belowMax
    ),
    highest: Math.min(
      pair - Math.min(PANEL_MIN_HEIGHT, shown.below),
      shown.aboveMax
    )
  };
}

/**
 * Drags the gap between two neighbouring panels by `deltaPx` (down is
 * positive), given the stack's pixels per weight, keeping both at least 90px.
 * Measure the delta from the drag's start and pass the layout from then, so
 * a long drag does not accumulate rounding. Other panels keep their share.
 * Pass the gap's `shown` heights where the stack holds a panel at its
 * natural height: the drag starts from what is drawn, and neither panel
 * grows past its content.
 */
export function resizeGap(
  layout: PanelLayout,
  above: PanelId,
  below: PanelId,
  deltaPx: number,
  pxPerWeight: number,
  shown?: GapShown
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
  const shownAbove =
    shown?.above ??
    Math.max(PANEL_MIN_HEIGHT, layout.weights[above] * pxPerWeight);
  const shownBelow =
    shown?.below ??
    Math.max(PANEL_MIN_HEIGHT, layout.weights[below] * pxPerWeight);
  const pair = shownAbove + shownBelow;
  const { lowest, highest } = gapRange({
    above: shownAbove,
    below: shownBelow,
    aboveMax: shown?.aboveMax ?? Number.POSITIVE_INFINITY,
    belowMax: shown?.belowMax ?? Number.POSITIVE_INFINITY
  });
  if (lowest > highest) return layout;
  const heightAbove = clamp(shownAbove + deltaPx, lowest, highest);
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
  pxPerWeight?: number,
  shown?: GapShown
): PanelLayout {
  if (layout.options.locked || !neighbours(layout, above, below)) {
    return layout;
  }
  if (pxPerWeight !== undefined) {
    const shownAbove =
      shown?.above ??
      Math.max(PANEL_MIN_HEIGHT, layout.weights[above] * pxPerWeight);
    const shownBelow =
      shown?.below ??
      Math.max(PANEL_MIN_HEIGHT, layout.weights[below] * pxPerWeight);
    return resizeGap(
      layout,
      above,
      below,
      (shownBelow - shownAbove) / 2,
      pxPerWeight,
      shown
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
    const bounds = floatBounds(stage, isStacked(group));
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
    const bounds = floatBounds(stage, isStacked(group));
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
  // No window shows at phone width, so there is nothing to clamp; rewriting
  // them to phone bounds would lose where they go on a wider stage.
  if (layout.options.locked || stage.width <= PANEL_PHONE_MAX_WIDTH) {
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
  /** The column ends where the user put its foot, short of the dock's. */
  shortened: boolean;
}

export interface FloatGeometry extends Rect {
  id: string;
  panels: PanelEntry[];
  /** The window as it shows while a panel is being stacked into it. */
  grown: Rect;
  overflowing: boolean;
  contentHeight: number;
}

/** A gap's two panels as drawn, and the most each may be drawn. */
export interface GapShown {
  above: number;
  below: number;
  aboveMax: number;
  belowMax: number;
}

export interface GapGeometry extends Rect {
  above: PanelId;
  below: PanelId;
  pxPerWeight: number;
  /** The two panels as drawn, and the most each may be drawn (its cap). */
  shown?: GapShown;
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
  // Every column position counts, an emptied one included: a drag keeps the
  // column it emptied in place, and that must not bring a parked column into
  // view, widen the dock or move the rail.
  const fit = (counts: Record<DockSide, number>): Record<DockSide, number> => {
    const next = { ...counts };
    while (
      next.left + next.right > 0 &&
      overCap(dockFootprint(next, columnWidth, insets), stageWidth)
    ) {
      if (next.left > 0) {
        next.left -= 1;
      } else {
        next.right -= 1;
      }
    }
    return next;
  };
  const docked = fit({ left: layout.left.length, right: layout.right.length });
  // A drop preview's slot is the exception: the drop removes the emptied
  // column, so when the panels it would leave fit, the slot's column shows
  // even though the emptied position still holds its place until the drop.
  const live = (side: DockSide) =>
    sideColumns(layout, side).filter((column) => column.length > 0).length;
  const liveCounts = { left: live('left'), right: live('right') };
  const liveFit = fit(liveCounts);
  if (liveFit.left === liveCounts.left && liveFit.right === liveCounts.right) {
    for (const side of DOCK_SIDES) {
      const slot = sideColumns(layout, side).findIndex((column) =>
        column.includes(PANEL_SLOT)
      );
      if (slot >= docked[side]) {
        docked[side] = slot + 1;
      }
    }
  }
  return docked;
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
 * The geometry as arranged, ignoring Hide all: what parking, placement and
 * the phone lane are judged against, so hiding the panels cannot change
 * where they go.
 */
function arrangedGeometry(
  layout: PanelLayout<PanelEntry>,
  stage: PanelStage
): PanelGeometry {
  return computePanelGeometry(
    layout.options.hidden
      ? { ...layout, options: { ...layout.options, hidden: false } }
      : layout,
    stage
  );
}

/**
 * Whether the unpinned slot reserves its width, so the right lane (the
 * command card and the inspector) steps past it. It does while the lane
 * keeps `laneMin` beside it, between the slot and the left dock's columns
 * (`leftDockWidth`, `--left-dock-w`). On a narrower stage the slot covers
 * the lane instead, as a float would: like a float it is opened and closed
 * by one press and sits outside the 40% guarantee, and reserving it there
 * would squeeze a form in the lane to a sliver.
 */
export function unpinnedSlotReserves(
  stage: PanelStage,
  dockWidth: number,
  slotWidth: number,
  laneMin: number,
  leftDockWidth = 0
): boolean {
  const { rail, gap } = insetsOf(stage);
  const laneEnd = rail + gap * 2 + dockWidth + slotWidth;
  return stage.width - laneEnd - gap - leftDockWidth >= laneMin;
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
  // Hide all projects nothing: no rectangles, no reserved dock width, rails
  // at the screen edges. The stored arrangement is untouched.
  const hidden = layout.options.hidden;
  const docked = hidden
    ? { left: 0, right: 0 }
    : dockedCounts(layout, stage.width, columnWidth, insets);
  const dock = {
    top: insets.top,
    bottom: Math.max(insets.top, stage.height - insets.bottom)
  };
  const dockHeight = dock.bottom - dock.top;
  // Column by column: the column and the dock gap inside it, so the rail
  // stands a dock gap from the dock's inner edge (and the island gap from
  // the screen's edge with no dock).
  const step = columnWidth + insets.between;
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

  // A docked panel hugs its content with Fit panels to content on; a
  // window keeps the height it was given, so its panels fill it.
  // A drop preview's slot carries the dragged panel's natural height
  // (`naturals[PANEL_SLOT]`), so the preview is drawn as the drop will be.
  const capOf = (entry: PanelEntry): number =>
    (layout.options.hug ? stage.naturals?.[entry] : undefined) ??
    Number.POSITIVE_INFINITY;
  const stack = (
    entries: PanelEntry[],
    rect: Rect,
    mode: PanelRect['mode'],
    container: GapGeometry['container']
  ): { overflowing: boolean; contentHeight: number } => {
    const caps = mode === 'docked' ? entries.map(capOf) : undefined;
    const result = stackHeights(
      entries.map((entry) => weightOf(layout, entry)),
      rect.h,
      caps
    );
    let y = rect.y;
    entries.forEach((entry, k) => {
      const h = result.heights[k]!;
      geometry.panels[entry] = { id: entry, mode, x: rect.x, y, w: rect.w, h };
      const below = entries[k + 1];
      if (below && entry !== PANEL_SLOT && below !== PANEL_SLOT) {
        const shown: GapShown = {
          above: h,
          below: result.heights[k + 1]!,
          aboveMax: caps?.[k] ?? Number.POSITIVE_INFINITY,
          belowMax: caps?.[k + 1] ?? Number.POSITIVE_INFINITY
        };
        const range = gapRange(shown);
        geometry.gaps.push({
          above: entry,
          below,
          x: rect.x,
          y: y + h,
          w: rect.w,
          h: PANEL_STACK_GAP,
          pxPerWeight: result.pxPerWeight,
          shown,
          // Nothing to trade while the stack scrolls, or where neither
          // panel can move: both already hug their content, or both sit at
          // their minimum.
          enabled:
            !result.overflowing &&
            result.pxPerWeight > 0 &&
            range.highest - range.lowest >= 1,
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
        column * insets.between
      : insets.gap + column * step;

  if (hidden) {
    return geometry;
  }
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
      // A column the user shortened ends there; a shorter window ends it
      // at the dock's foot.
      const stored = storedColumnHeight(layout, entries);
      const h = stored === null ? dockHeight : Math.min(stored, dockHeight);
      const rect = {
        x: columnX(side, column),
        y: dock.top,
        w: columnWidth,
        h
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
        ...fit,
        shortened: h < dockHeight
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
 * What a drop at `point` should do: a rail drag still within its clearance
 * of the start, which a release ignores (the panel stays where it was).
 */
export const DROP_SUPPRESSED = 'suppressed';

/**
 * The drop target under `point`, or null to float the panel where it is
 * dropped, or `DROP_SUPPRESSED` while a rail drag has not yet cleared
 * `PANEL_RAIL_DRAG_CLEARANCE`. Pass the geometry of the layout without the preview (from
 * `beginDrag`), so the preview making room cannot move the target away from
 * the cursor. Windows win over docks, the topmost first; then the docked
 * columns (a parked column is not a target, nor the model under a shortened
 * one); then each side's new-column span, which covers the rail plus one
 * column so the rail sliding inward while it is hovered cannot flicker it.
 */
export function hitTest(
  geometry: PanelGeometry,
  point: Point,
  options: HitTestOptions = {}
): PanelTarget | typeof DROP_SUPPRESSED | null {
  if (
    options.fromRail &&
    options.startPoint &&
    distance(point, options.startPoint) < PANEL_RAIL_DRAG_CLEARANCE
  ) {
    return DROP_SUPPRESSED;
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
    // Under a shortened column is the model: a drop there floats.
    if (column.shortened && point.y > column.y + column.h + DOCK_HIT_SLACK) {
      continue;
    }
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

  // Heights for sets of panels, whichever columns exist now: a set comes
  // back to its height when it is a column again.
  const heights = root.columnHeights;
  if (heights && typeof heights === 'object' && !Array.isArray(heights)) {
    const kept = Object.entries(heights as Record<string, unknown>).filter(
      (entry): entry is [string, number] =>
        isColumnKey(entry[0]) &&
        typeof entry[1] === 'number' &&
        Number.isFinite(entry[1])
    );
    for (const [key, height] of kept.slice(-COLUMN_HEIGHTS_MAX)) {
      layout.columnHeights[key] = Math.round(
        clamp(height, columnMinimum(key.split('+').length), COORD_MAX)
      );
    }
  }

  const options = root.options;
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    const raw = options as Record<string, unknown>;
    for (const key of ['hidden', 'locked', 'compact', 'hug'] as const) {
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
