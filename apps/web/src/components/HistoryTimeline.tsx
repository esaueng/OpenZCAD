import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import type { LocalHistoryAppend } from '../lib/localHistoryAppend';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUpFromDot,
  Axis3d,
  Box,
  BrushCleaning,
  CirclePause,
  CirclePlay,
  Cog,
  Cone,
  Cylinder,
  Diameter,
  Drill,
  Eraser,
  EyeOff,
  FileBox,
  FlipHorizontal2,
  Globe,
  GripVertical,
  History,
  MoreHorizontal,
  Move3d,
  PenLine,
  Radius,
  Search,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  Torus,
  Trash2,
  X
} from 'lucide-react';
import {
  isFeatureManuallySuppressed,
  isFeatureRollbackSuppressed,
  isFeatureSuppressed,
  ownEntry
} from '@openzcad/shared';
import type {
  BodyRepresentation,
  FeatureId,
  FeatureNode,
  UnitSystem
} from '@openzcad/shared';
import { useArrivals } from '../hooks/useArrivals';
import {
  featureNeedsRepair,
  historyFailureTier,
  type HistoryFailureTier
} from '../lib/featureRepair';
import { featureValueSummary } from '../lib/featureSummary';
import { FEATURE_KIND_LABELS } from '../lib/model';
import {
  chamferGlyph,
  circularPatternGlyph,
  draftGlyph,
  extrudeGlyph,
  gridPatternGlyph,
  helicalSweepGlyph,
  linearPatternGlyph,
  loftGlyph,
  planeGlyph,
  revolveGlyph,
  shellGlyph,
  solidOffsetGlyph,
  splitGlyph,
  sweepGlyph,
  thickenGlyph,
  threadGlyph
} from '../lib/toolIcons';

// Row icons are constant elements: a commit re-renders every row of a long
// history, and React skips an element it has already reconciled only when it
// is the same object. Building them per row per render was a measurable part
// of each edit's main-thread time on a 200-feature history. Each step wears
// the glyph of the command that made it, as the tool and selection rails
// draw it, so a run of fillets and face offsets is told apart at a glance.
const PRIMITIVE_ICONS = {
  box: <Box size={14} aria-hidden="true" />,
  cylinder: <Cylinder size={14} aria-hidden="true" />,
  sphere: <Globe size={14} aria-hidden="true" />,
  cone: <Cone size={14} aria-hidden="true" />,
  torus: <Torus size={14} aria-hidden="true" />
} as const;
const FILLET_ICON = <Radius size={14} aria-hidden="true" />;
const KIND_ICONS: Partial<Record<FeatureNode['featureKind'], ReactNode>> = {
  sketch: <PenLine size={14} aria-hidden="true" />,
  extrude: extrudeGlyph,
  revolve: revolveGlyph,
  loft: loftGlyph,
  sweep: sweepGlyph,
  'helical-sweep': helicalSweepGlyph,
  transform: <Move3d size={14} aria-hidden="true" />,
  mirror: <FlipHorizontal2 size={14} aria-hidden="true" />,
  split: splitGlyph,
  hole: <Drill size={14} aria-hidden="true" />,
  gear: <Cog size={14} aria-hidden="true" />,
  thread: threadGlyph,
  shell: shellGlyph,
  'solid-offset': solidOffsetGlyph,
  draft: draftGlyph,
  thicken: thickenGlyph,
  fillet: FILLET_ICON,
  chamfer: chamferGlyph,
  'datum-plane': planeGlyph,
  'datum-axis': <Axis3d size={14} aria-hidden="true" />
};
const BOOLEAN_ICONS: Record<string, ReactNode> = {
  union: <SquaresUnite size={14} aria-hidden="true" />,
  subtract: <SquaresSubtract size={14} aria-hidden="true" />,
  intersect: <SquaresIntersect size={14} aria-hidden="true" />
};
const PATTERN_ICONS: Record<string, ReactNode> = {
  linear: linearPatternGlyph,
  circular: circularPatternGlyph,
  grid: gridPatternGlyph
};
const OFFSET_FACE_ICON = <ArrowUpFromDot size={14} aria-hidden="true" />;
const RESIZE_DIAMETER_ICON = <Diameter size={14} aria-hidden="true" />;
const DIRECT_EDIT_ICONS: Record<string, ReactNode> = {
  'offset-face': OFFSET_FACE_ICON,
  'set-face-distance': OFFSET_FACE_ICON,
  'resize-cylindrical-face': RESIZE_DIAMETER_ICON,
  'resize-through-hole': RESIZE_DIAMETER_ICON,
  'resize-imported-blind-hole': RESIZE_DIAMETER_ICON,
  'resize-imported-counterbore': RESIZE_DIAMETER_ICON,
  'resize-imported-countersink': RESIZE_DIAMETER_ICON,
  'resize-blend': FILLET_ICON,
  'remove-face-feature': <Eraser size={14} aria-hidden="true" />,
  'remove-blends': <BrushCleaning size={14} aria-hidden="true" />
};
const OTHER_FEATURE_ICON = <FileBox size={14} aria-hidden="true" />;
const GRIP_ICON = <GripVertical size={12} aria-hidden="true" />;
const ROW_ALERT_ICON = <AlertTriangle size={11} aria-hidden="true" />;
const ROOT_FAILURE_ICON = <AlertTriangle size={13} aria-hidden="true" />;
const DOWNSTREAM_FAILURE_ICON = <AlertTriangle size={12} aria-hidden="true" />;
const SUPPRESSED_STATUS_ICON = <CirclePause size={13} aria-hidden="true" />;
const RESUME_ICON = <CirclePlay size={12} aria-hidden="true" />;
const SUPPRESS_ICON = <CirclePause size={12} aria-hidden="true" />;
const ROLLBACK_ICON = <History size={12} aria-hidden="true" />;
const MORE_ICON = <MoreHorizontal size={12} aria-hidden="true" />;
const HIDDEN_ICON = <EyeOff size={12} aria-hidden="true" />;
const ROLLED_BACK_ICON = <CirclePause size={13} aria-hidden="true" />;
const LATEST_ICON = <ArrowDown size={12} aria-hidden="true" />;
const NO_LINEAGE: ReadonlyMap<FeatureId, FeatureNode> = new Map();

/** The glyph of the command that made `feature`, as the rails draw it. */
export function featureIcon(feature: FeatureNode): ReactNode {
  const data = feature.data;
  switch (data.featureKind) {
    case 'primitive':
      return (
        ownEntry(PRIMITIVE_ICONS, data.primitiveKind) ?? OTHER_FEATURE_ICON
      );
    case 'boolean':
      return ownEntry(BOOLEAN_ICONS, data.operation) ?? OTHER_FEATURE_ICON;
    case 'pattern':
      return ownEntry(PATTERN_ICONS, data.patternKind) ?? OTHER_FEATURE_ICON;
    case 'direct-edit':
      return (
        ownEntry(DIRECT_EDIT_ICONS, data.operation?.kind) ?? OTHER_FEATURE_ICON
      );
    default:
      return ownEntry(KIND_ICONS, feature.featureKind) ?? OTHER_FEATURE_ICON;
  }
}

/** How long a new row keeps `.is-arrival`: its accent wash drains in 900ms. */
const ARRIVAL_MS = 900;

/**
 * How long keyboard moves of the end-of-history handle wait before they
 * commit. Each commit is one undoable transaction and a rebuild, so holding
 * an arrow key through ten steps should cost one rebuild, not ten.
 */
const KEYBOARD_COMMIT_MS = 450;

/** Later rows dim one after another from the handle, capped so a long tail does not crawl. */
const CASCADE_STEP_MS = 14;
const CASCADE_MAX_STEPS = 12;

/**
 * The last feature still in the build when every later one is paused by
 * rollback. Scan from the end so both collapsed and expanded History views
 * find the boundary in at most one pass.
 */
export function findRollbackMarkerIndex(
  features: readonly FeatureNode[]
): number {
  for (let index = features.length - 1; index >= 0; index -= 1) {
    if (!isFeatureRollbackSuppressed(features[index]!)) {
      return index < features.length - 1 ? index : -1;
    }
  }
  return -1;
}

export interface HistoryTimelineProps {
  features: FeatureNode[];
  localAppend?: LocalHistoryAppend | null;
  representations: Record<string, BodyRepresentation>;
  /** Features the current rebuild reported as failed or refused. */
  failedFeatureIds?: ReadonlySet<FeatureId>;
  /**
   * Every feature with a failed step upstream, each with the earliest such
   * step (`failureLineage`). A failed row without an entry is a first
   * failure; one with an entry failed after it; a built row with an entry
   * stands on a failed step.
   */
  failureLineage?: ReadonlyMap<FeatureId, FeatureNode>;
  /**
   * Brings a row into view from outside the list (the header's repair
   * chip). A filter that hides the row is cleared first. A new `seq` asks
   * again for the same row.
   */
  revealRequest?: HistoryRevealRequest | null;
  /**
   * The steps related to the current selection, or null with nothing
   * selected. The find bar's Related toggle keeps only these rows.
   */
  relatedFeatureIds?: ReadonlySet<FeatureId> | null;
  geometryPending?: boolean;
  /** Whether a pending rebuild is announced; defaults to `geometryPending`. */
  geometryPendingShown?: boolean;
  selectedFeatureNodeId: string | null;
  hiddenBodyIds: ReadonlySet<string>;
  hiddenSketchIds: ReadonlySet<string>;
  /**
   * I01: sketches holding a linked projection the last build could not
   * re-find. Their rows say so; the repair (re-pick or unlink) is in the
   * sketch.
   */
  brokenProjectionSketchIds?: ReadonlySet<string>;
  parameterValues: Record<string, number>;
  units: UnitSystem;
  /** A refused operation, drawn after the last row until it re-arms. */
  pendingStep?: { title: string; message: string } | null;
  /**
   * The existing step a running command edits (Resize Body edits its Box).
   * Its row keeps its value in view while it is selected, and a refusal is
   * shown on it — the edit changes that step, so it never appears as a new
   * trailing step that was "not built".
   */
  editingFeatureId?: string | null;
  findOpen: boolean;
  onCloseFind(): void;
  onSelectFeature(nodeId: string): void;
  onToggleBodyVisibility(bodyId: string): void;
  onToggleSketchVisibility(sketchId: string): void;
  onFeatureContextMenu(
    at: { clientX: number; clientY: number },
    feature: FeatureNode,
    row?: HistoryRowActions
  ): void;
  onToggleFeatureSuppression(feature: FeatureNode): void;
  onRollbackAfterFeature(featureId: FeatureId, name: string): void;
  onResumeHistory(): void;
  onReorderFeature(featureId: FeatureId, toIndex: number): void;
  /**
   * An exact operation is still running. A reorder started now would be
   * refused as busy, and repeated arrow presses would leave an order nobody
   * chose, so the grips hold still until it finishes. Resume waits too: its
   * own check of the paused features is one of those operations.
   */
  reorderBusy?: boolean;
  /** Renames a feature in place. Without it the row offers no rename. */
  onRenameFeature?(featureId: FeatureId, name: string): void;
  /**
   * Deletes several steps as one undoable step. With it, Shift-click picks a
   * range of rows and Ctrl/⌘-click adds or drops one; without it a row
   * selects alone.
   */
  onDeleteFeatures?(featureIds: readonly FeatureId[]): void;
  /**
   * Opens a sketch step for editing in the viewport. A double-click on a
   * sketch row calls it; without it a double-click only selects.
   */
  onEditSketch?(feature: FeatureNode): void;
}

export interface HistoryRevealRequest {
  nodeId: string;
  seq: number;
}

/**
 * What a row's context menu can do that only the row knows how to do: the
 * end-of-history buttons drop a pending keyboard step first, and a rename
 * edits the name where it is shown.
 */
export interface HistoryRowActions {
  /**
   * Where the row stands against the end of history: `last` when it is the
   * final feature and nothing is rolled back (rolling back after it would
   * do nothing), `marker` when history is rolled back to just after it, and
   * null otherwise.
   */
  endOfHistory: 'last' | 'marker' | null;
  rollBack(): void;
  resume(): void;
  rename?(): void;
  /**
   * Present when the row is part of a multi-row History selection: its
   * menu's Delete removes every selected step, not this one alone.
   */
  deleteSelection?: { count: number; run(): void };
}

function sketchIdOf(feature: FeatureNode): string | null {
  return feature.data.featureKind === 'sketch' ? feature.data.sketchId : null;
}

/** The name with the find query marked, case-insensitively. */
function markedName(name: string, query: string): ReactNode {
  if (!query) {
    return name;
  }
  const at = name.toLowerCase().indexOf(query);
  if (at < 0) {
    return name;
  }
  return (
    <>
      {name.slice(0, at)}
      <mark className="history-match">{name.slice(at, at + query.length)}</mark>
      {name.slice(at + query.length)}
    </>
  );
}

/**
 * The row's name as a field, for Rename from the row's menu. Enter or leaving
 * the field keeps the new name; Escape keeps the old one. An empty or
 * unchanged name is no edit at all, so it adds nothing to history.
 */
function FeatureRenameField({
  feature,
  onCommit,
  onDone
}: {
  feature: FeatureNode;
  onCommit(name: string): void;
  onDone(refocus: boolean): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  function finish(keep: boolean, refocus: boolean) {
    // Enter unmounts the field, and the blur that follows must not commit a
    // second time.
    if (settled.current) return;
    settled.current = true;
    const name = inputRef.current?.value.trim() ?? '';
    if (keep && name && name !== feature.name) onCommit(name);
    onDone(refocus);
  }
  return (
    // The step's icon stays in the grip beside it.
    <span className="feature-row-rename">
      <input
        ref={inputRef}
        type="text"
        defaultValue={feature.name}
        aria-label={`Rename ${feature.name}`}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'Escape') {
            event.preventDefault();
            // Escape here cancels the rename, not the workspace's selection.
            event.stopPropagation();
            finish(event.key === 'Enter', true);
          }
        }}
        onBlur={() => finish(true, false)}
      />
    </span>
  );
}

/**
 * What a history row reads only when someone acts on it: the latest
 * callbacks and list state, kept in a ref so that a row whose rendered
 * props did not change can skip re-rendering. Handlers resolve the feature
 * node by id at event time, because every document edit replaces every
 * node object while a skipped row still holds the one it last rendered.
 */
interface HistoryRowContext {
  latest(feature: FeatureNode): FeatureNode;
  filtering: boolean;
  reorderBusy: boolean;
  dragFeatureId: string | null;
  last: number;
  batchCount: number;
  canDelete: boolean;
  batchAnchor: RefObject<FeatureId | null>;
  listRef: RefObject<HTMLDivElement | null>;
  setDragFeatureId(id: string | null): void;
  setDropFeatureId: Dispatch<SetStateAction<string | null>>;
  setRenamingId(id: FeatureId | null): void;
  cancelPendingCommit(): void;
  rowActions(feature: FeatureNode, index: number): HistoryRowActions;
  extendBatch(feature: FeatureNode, range: boolean): void;
  clearBatch(): void;
  selectHistoryFeature(id: string): void;
  activateRow(feature: FeatureNode, event: ReactMouseEvent<HTMLElement>): void;
  rollBackAfter(feature: FeatureNode): void;
  onFeatureContextMenu: HistoryTimelineProps['onFeatureContextMenu'];
  onReorderFeature: HistoryTimelineProps['onReorderFeature'];
  onRenameFeature: HistoryTimelineProps['onRenameFeature'];
  onEditSketch: HistoryTimelineProps['onEditSketch'];
  onToggleFeatureSuppression: HistoryTimelineProps['onToggleFeatureSuppression'];
  onToggleSketchVisibility: HistoryTimelineProps['onToggleSketchVisibility'];
  onToggleBodyVisibility: HistoryTimelineProps['onToggleBodyVisibility'];
}

/**
 * The one state a row's rail dot, status glyph and spoken status carry, in
 * precedence order. Interaction states (selected, batch, editing) layer on
 * top in CSS.
 */
type HistoryRowStatus =
  | 'suppressed'
  | 'paused'
  | 'preparing'
  | HistoryFailureTier
  | 'broken-projection'
  | null;

/** What a screen reader hears after the name, as the words the rows used to show. */
const STATUS_WORDS: Record<
  NonNullable<HistoryRowStatus>,
  { word: string; qualifier?: string }
> = {
  suppressed: { word: 'suppressed' },
  paused: { word: 'paused' },
  preparing: { word: 'preparing' },
  root: { word: 'needs repair', qualifier: 'first failure' },
  downstream: { word: 'needs repair', qualifier: 'after an earlier failure' },
  'built-on-failed': { word: 'built on a failed step' },
  'broken-projection': { word: 'broken projection' }
};

const STATUS_CLASSES: Record<NonNullable<HistoryRowStatus>, string> = {
  suppressed: '',
  paused: '',
  preparing: ' is-preparing',
  root: ' is-failure-root',
  downstream: ' is-failure-downstream',
  'built-on-failed': ' is-built-on-failed',
  'broken-projection': ''
};

/** The status as the row's tooltip says it, after the value. */
function statusNote(
  status: HistoryRowStatus,
  failureRoot: string | null
): string {
  switch (status) {
    case 'suppressed':
      return ', suppressed';
    case 'paused':
      return ', paused by rollback';
    case 'preparing':
      return ', preparing';
    case 'root':
      return ', needs repair: the first failure, fix this one first';
    case 'downstream':
      return `, needs repair after “${failureRoot}” failed`;
    case 'built-on-failed':
      return `, built on “${failureRoot}”, which failed: this step uses that step's input unchanged`;
    case 'broken-projection':
      return ', a linked projection lost its source edge';
    default:
      return '';
  }
}

interface HistoryRowProps {
  /** Rendered for its name, kind and ids; handlers act on the latest node. */
  feature: FeatureNode;
  icon: ReactNode;
  index: number;
  className: string;
  delay: number;
  /** The value summary. Never replaced by a status: that has its own slot. */
  value: string;
  status: HistoryRowStatus;
  /** The first failure this row's failure or build follows from, or null. */
  failureRoot: string | null;
  selected: boolean;
  inBatch: boolean;
  consumed: boolean;
  refusalTitle: string | null;
  refusalMessage: string | null;
  suppressed: boolean;
  rollbackActive: boolean;
  hidden: boolean;
  sketchId: string | null;
  renaming: boolean;
  needle: string;
  filtering: boolean;
  reorderBusy: boolean;
  context: RefObject<HistoryRowContext | null>;
}

/** Every rendered input of a row; a new node for the same step is not one. */
function sameHistoryRow(a: HistoryRowProps, b: HistoryRowProps): boolean {
  for (const key of Object.keys(a) as (keyof HistoryRowProps)[]) {
    if (key !== 'feature' && !Object.is(a[key], b[key])) return false;
  }
  const left = a.feature;
  const right = b.feature;
  return (
    left === right ||
    (left.id === right.id &&
      left.featureId === right.featureId &&
      left.name === right.name &&
      left.featureKind === right.featureKind &&
      left.bodyId === right.bodyId)
  );
}

/** The status glyph after the value, or null when the state has none. */
function statusGlyph(status: HistoryRowStatus): ReactNode {
  switch (status) {
    case 'root':
      return (
        <span
          className="feature-flag error history-row-status is-root"
          title="Feature failed to build"
        >
          {ROOT_FAILURE_ICON}
        </span>
      );
    case 'downstream':
      return (
        <span
          className="feature-flag error history-row-status is-downstream"
          title="Feature failed to build"
        >
          {DOWNSTREAM_FAILURE_ICON}
        </span>
      );
    case 'suppressed':
      return (
        <span className="history-row-status is-suppressed">
          {SUPPRESSED_STATUS_ICON}
        </span>
      );
    case 'preparing':
      return (
        <span className="history-row-status">
          <span className="history-row-spinner spin" />
        </span>
      );
    case 'broken-projection':
      return (
        <span
          className="feature-flag error history-row-status"
          title="A linked projection lost its source edge. Open the sketch to re-pick or unlink it."
        >
          {ROW_ALERT_ICON}
        </span>
      );
    default:
      return null;
  }
}

// One history step. Memoized: a long history re-rendered every row on each
// of the several commits an edit makes, which was most of the edit's
// main-thread time on a 200-step history.
const HistoryRow = memo(function HistoryRow({
  feature,
  icon,
  index,
  className,
  delay,
  value,
  status,
  failureRoot,
  selected,
  inBatch,
  consumed,
  refusalTitle,
  refusalMessage,
  suppressed,
  rollbackActive,
  hidden,
  sketchId,
  renaming,
  needle,
  filtering,
  reorderBusy,
  context
}: HistoryRowProps) {
  const spoken = status ? STATUS_WORDS[status] : null;
  return (
    <div
      key={feature.id}
      data-node-id={feature.id}
      data-history-index={index}
      style={{ '--history-delay': `${delay}ms` } as CSSProperties}
      className={`${className}${status ? STATUS_CLASSES[status] : ''}`}
      onContextMenu={(event) => {
        event.preventDefault();
        const ctx = context.current!;
        const latest = ctx.latest(feature);
        ctx.onFeatureContextMenu(event, latest, ctx.rowActions(latest, index));
      }}
      onDragOver={(event) => {
        const ctx = context.current!;
        if (
          ctx.filtering ||
          !ctx.dragFeatureId ||
          ctx.dragFeatureId === feature.featureId
        ) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        ctx.setDropFeatureId(feature.featureId);
      }}
      onDragLeave={() => {
        context.current!.setDropFeatureId((current) =>
          current === feature.featureId ? null : current
        );
      }}
      onDrop={(event) => {
        const ctx = context.current!;
        if (ctx.filtering || ctx.reorderBusy || !ctx.dragFeatureId) {
          return;
        }
        event.preventDefault();
        ctx.onReorderFeature(ctx.dragFeatureId as FeatureId, index);
        ctx.setDragFeatureId(null);
        ctx.setDropFeatureId(null);
      }}
    >
      <span className="history-dot" aria-hidden="true" />
      {/* The step's icon at rest, the grip under the pointer: one 24px slot
          that reorders on a drag and selects the row on a plain click. */}
      <button
        type="button"
        className="row-action feature-row-grip"
        aria-label={`Reorder ${feature.name}. Use the arrow keys to move it.`}
        // A filtered list hides the rows a move would pass, so a
        // step could jump past an invisible one: reorder only the
        // whole history.
        title={
          filtering
            ? 'Clear the filter to reorder'
            : reorderBusy
              ? 'Reorder once the current rebuild finishes'
              : 'Drag to reorder'
        }
        disabled={filtering}
        // Not `disabled`: that would drop keyboard focus mid-press.
        aria-disabled={reorderBusy || undefined}
        draggable={!filtering && !reorderBusy}
        onClick={(event) => {
          // A drag never clicks; a press that did not move selects the
          // row, as a click on its icon always has. Keyboard presses
          // (detail 0) keep to the grip: Enter is not a selection here.
          if (event.detail === 0) return;
          context.current!.activateRow(feature, event);
        }}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', feature.featureId);
          const row = event.currentTarget.closest('.feature-row');
          if (row instanceof HTMLElement) {
            // Without this the drag ghost is the grip alone, which
            // gives no clue which row is being moved.
            event.dataTransfer.setDragImage(row, 16, 16);
          }
          const ctx = context.current!;
          ctx.cancelPendingCommit();
          ctx.setDragFeatureId(feature.featureId);
        }}
        onDragEnd={() => {
          const ctx = context.current!;
          ctx.setDragFeatureId(null);
          ctx.setDropFeatureId(null);
        }}
        onKeyDown={(event) => {
          const offset =
            event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
          const ctx = context.current!;
          if (offset === 0 || ctx.filtering) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (ctx.reorderBusy) {
            return;
          }
          // Clamped so the ends of the list are a no-op rather than
          // a move to -1 or past the end. The command layer refuses
          // those too, but a keypress that cannot do anything should
          // not travel that far to find out.
          const target = index + offset;
          if (target < 0 || target > ctx.last) {
            return;
          }
          ctx.cancelPendingCommit();
          ctx.onReorderFeature(feature.featureId, target);
        }}
      >
        <span className="feature-icon">{icon}</span>
        <span className="feature-row-grip-glyph">{GRIP_ICON}</span>
      </button>
      {renaming ? (
        <FeatureRenameField
          feature={feature}
          onCommit={(name) =>
            context.current!.onRenameFeature?.(feature.featureId, name)
          }
          onDone={(refocus) => {
            const ctx = context.current!;
            ctx.setRenamingId(null);
            if (!refocus) return;
            // The field unmounts with focus in it; give it back to
            // the row it replaced rather than dropping it on the page.
            requestAnimationFrame(() =>
              ctx.listRef.current
                ?.querySelector<HTMLElement>(
                  `[data-node-id="${CSS.escape(feature.id)}"] .feature-row-main`
                )
                ?.focus()
            );
          }}
        />
      ) : (
        <button
          type="button"
          className="feature-row-main"
          aria-pressed={selected || inBatch}
          onMouseDown={(event) => {
            // Shift-click would otherwise also select page text.
            if (context.current!.canDelete && event.shiftKey)
              event.preventDefault();
          }}
          onClick={(event) => context.current!.activateRow(feature, event)}
          // A sketch opens for editing on double-click, as in the Objects
          // panel; the first click of the pair already selected the row.
          onDoubleClick={(event) => {
            if (
              feature.data.featureKind !== 'sketch' ||
              event.shiftKey ||
              event.metaKey ||
              event.ctrlKey
            )
              return;
            context.current!.onEditSketch?.(context.current!.latest(feature));
          }}
          // Every row used to announce the same generic kind label, so
          // a history read aloud was a list of identical items. The
          // feature's own name comes first, as on screen.
          // The value beside the name can be cut short in a narrow
          // panel, and fades for the row's actions on hover: the
          // tooltip carries it whole, and the status with its cause.
          title={`${feature.name} — ${FEATURE_KIND_LABELS[feature.featureKind]}${value ? ` (${value})` : ''}${consumed ? ', combined into a later feature' : ''}${statusNote(status, failureRoot)}, click to edit`}
        >
          <span className="feature-name">
            {markedName(feature.name, needle)}
          </span>
          {spoken && (
            // After the name, so the row's text and name still start
            // with it; the words the row used to show, spoken only.
            <span className="visually-hidden">
              {' '}
              <span>{spoken.word}</span>
              {spoken.qualifier ? `, ${spoken.qualifier}` : ''}
            </span>
          )}
          {refusalTitle !== null && (
            <span
              className="feature-flag error history-row-refused"
              role="status"
              title={`${refusalTitle} not applied: ${refusalMessage}`}
            >
              {ROW_ALERT_ICON}
              <span>edit not applied</span>
            </span>
          )}
        </button>
      )}
      <span className="history-row-tail">
        <span className="history-row-value mono">{value}</span>
        {statusGlyph(status)}
      </span>
      <span className="history-row-actions">
        <button
          type="button"
          className={`row-suppression${suppressed ? ' is-suppressed' : ''}`}
          title={
            suppressed ? `Resume ${feature.name}` : `Suppress ${feature.name}`
          }
          aria-label={
            suppressed ? `Resume ${feature.name}` : `Suppress ${feature.name}`
          }
          aria-pressed={suppressed}
          onClick={() => {
            const ctx = context.current!;
            ctx.onToggleFeatureSuppression(ctx.latest(feature));
          }}
        >
          {suppressed ? RESUME_ICON : SUPPRESS_ICON}
        </button>
        <button
          type="button"
          className={`row-rollback${rollbackActive ? ' is-active' : ''}`}
          title={`Roll back history after ${feature.name}`}
          aria-label={`Roll back history after ${feature.name}`}
          aria-pressed={rollbackActive}
          onClick={() => {
            const ctx = context.current!;
            ctx.rollBackAfter(ctx.latest(feature));
          }}
        >
          {ROLLBACK_ICON}
        </button>
        <button
          type="button"
          className="row-more"
          title="More actions"
          aria-label={`More actions for ${feature.name}`}
          aria-haspopup="menu"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const ctx = context.current!;
            const latest = ctx.latest(feature);
            ctx.onFeatureContextMenu(
              { clientX: box.left, clientY: box.bottom + 2 },
              latest,
              ctx.rowActions(latest, index)
            );
          }}
        >
          {MORE_ICON}
        </button>
      </span>
      {hidden && (
        <button
          type="button"
          className="row-visibility is-hidden"
          title={`Show ${feature.name}`}
          aria-label={`Show ${feature.name}`}
          aria-pressed={true}
          onClick={() => {
            const ctx = context.current!;
            if (sketchId) ctx.onToggleSketchVisibility(sketchId);
            else if (feature.bodyId) ctx.onToggleBodyVisibility(feature.bodyId);
          }}
        >
          {HIDDEN_ICON}
        </button>
      )}
    </div>
  );
}, sameHistoryRow);

/**
 * Places the line, its fill, the handle and the selection highlight against
 * the rows as laid out, through custom properties on the list. Reads the end
 * of history and the last index from the list's data attributes, so it needs
 * nothing from the render that scheduled it.
 *
 * Every row is measured before any property is written. A custom property
 * on the list restyles its rows, so a read after a write forced a second
 * style and layout pass, and interleaved they cost a commit several full
 * layouts (40–50 ms on a filleted union's face commit).
 */
export function placeTimeline(list: HTMLElement) {
  const end = Number(list.dataset.end);
  const last = Number(list.dataset.last);
  const rows = [...list.querySelectorAll<HTMLElement>(':scope > .feature-row')];
  const first = rows[0];
  const lastRow = rows[rows.length - 1];
  const center = (row: HTMLElement) => row.offsetTop + row.offsetHeight / 2;
  const properties = new Map<string, string>();
  if (!first || !lastRow) {
    properties.set('--spine-height', '0px');
    properties.set('--highlight-opacity', '0');
  } else {
    const firstCenter = center(first);
    properties.set('--spine-top', `${firstCenter}px`);
    properties.set('--spine-height', `${center(lastRow) - firstCenter}px`);
    const endRow = rows.find((row) => Number(row.dataset.historyIndex) === end);
    if (endRow) {
      const boundary = endRow.offsetTop + endRow.offsetHeight;
      properties.set('--handle-y', `${boundary}px`);
      properties.set(
        '--fill-height',
        `${(end === last ? center(endRow) : boundary) - firstCenter}px`
      );
    }
    const selected = rows.find((row) => row.classList.contains('selected'));
    if (selected) {
      properties.set('--highlight-y', `${selected.offsetTop}px`);
      properties.set('--highlight-height', `${selected.offsetHeight}px`);
      properties.set('--highlight-opacity', '1');
    } else {
      properties.set('--highlight-opacity', '0');
    }
  }
  const style = list.style;
  for (const [name, value] of properties)
    if (style.getPropertyValue(name) !== value) style.setProperty(name, value);
}

/**
 * Keeps the rest of a multi-click that started on `row` on that row.
 *
 * Selecting a row opens its edit card above the list, which pushes the row
 * down the lane and puts the card's controls where it was. The second press
 * of a double-click then landed on whatever moved under the pointer — the
 * Operation select, so the next letter typed silently turned New body into
 * Cut. Its presses, clicks and double-click anywhere but the row are
 * dropped; the next single press ends the hold.
 */
function holdMultiClickToRow(row: HTMLElement) {
  const doc = row.ownerDocument;
  const drop = (event: MouseEvent) => {
    if (
      event.detail > 1 &&
      !(event.target instanceof Node && row.contains(event.target))
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const press = (event: MouseEvent) => {
    if (event.detail > 1) {
      drop(event);
      return;
    }
    doc.removeEventListener('mousedown', press, true);
    doc.removeEventListener('click', drop, true);
    doc.removeEventListener('dblclick', drop, true);
  };
  doc.addEventListener('mousedown', press, true);
  doc.addEventListener('click', drop, true);
  doc.addEventListener('dblclick', drop, true);
}

/**
 * The History list: features on a vertical timeline, one short value per row,
 * and a single handle on the line that marks the end of history.
 *
 * The handle, the line's fill and the selection highlight are positioned from
 * the rendered rows rather than from a fixed row height, so a row that grows
 * (a long flag, a larger font) never puts them out of step with the list.
 */
export function HistoryTimeline({
  features,
  localAppend = null,
  representations,
  failedFeatureIds,
  failureLineage,
  revealRequest = null,
  relatedFeatureIds = null,
  geometryPending = false,
  geometryPendingShown = geometryPending,
  selectedFeatureNodeId,
  hiddenBodyIds,
  hiddenSketchIds,
  brokenProjectionSketchIds,
  parameterValues,
  units,
  pendingStep = null,
  editingFeatureId = null,
  findOpen,
  onCloseFind,
  onSelectFeature,
  onToggleBodyVisibility,
  onToggleSketchVisibility,
  onFeatureContextMenu,
  onToggleFeatureSuppression,
  onRollbackAfterFeature,
  onResumeHistory,
  onReorderFeature,
  reorderBusy = false,
  onRenameFeature,
  onDeleteFeatures,
  onEditSketch
}: HistoryTimelineProps) {
  const [dragFeatureId, setDragFeatureId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<FeatureId | null>(null);
  const [dropFeatureId, setDropFeatureId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [relatedOnly, setRelatedOnly] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  // The multi-row selection, kept here rather than in the workspace: the
  // viewport and the edit card follow one feature, and a batch only feeds
  // the batch actions. The anchor is where a Shift-click range starts.
  const [batch, setBatch] = useState<ReadonlySet<FeatureId>>(() => new Set());
  const batchAnchor = useRef<FeatureId | null>(null);
  // Where the handle sits while it is being dragged or stepped from the
  // keyboard, before that position is committed to the document.
  const [previewEnd, setPreviewEnd] = useState<number | null>(null);
  const [draggingHandle, setDraggingHandle] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const commitTimer = useRef<number | null>(null);
  const refocusFrame = useRef<number | null>(null);
  const selectionFrame = useRef<number | null>(null);
  const following = useRef(true);
  const programmaticScroll = useRef(false);
  const scrollResetFrame = useRef<number | null>(null);
  const handledAppend = useRef<string | null>(null);
  const latestAppendRef = useRef(localAppend);
  latestAppendRef.current = localAppend;
  const [pendingAppendId, setPendingAppendId] = useState<string | null>(null);
  const pendingAppendRef = useRef(pendingAppendId);
  pendingAppendRef.current = pendingAppendId;
  const pendingFeature = features.find(
    (feature) => feature.id === pendingAppendId
  );
  // The latest row is the list's last: it is out of view only while the
  // panel scrolls and is scrolled up from its foot, the one time a button
  // to reach it does anything.
  const [latestOutOfView, setLatestOutOfView] = useState(false);

  const markProgrammaticScroll = useCallback(() => {
    programmaticScroll.current = true;
    if (scrollResetFrame.current !== null)
      cancelAnimationFrame(scrollResetFrame.current);
    scrollResetFrame.current = requestAnimationFrame(() => {
      scrollResetFrame.current = null;
      programmaticScroll.current = false;
    });
  }, []);

  const revealOperation = useCallback(
    (id: string) => {
      if (refocusFrame.current !== null)
        cancelAnimationFrame(refocusFrame.current);
      refocusFrame.current = requestAnimationFrame(() => {
        refocusFrame.current = null;
        const row = listRef.current?.querySelector<HTMLElement>(
          `[data-node-id="${CSS.escape(id)}"]`
        );
        if (row) {
          following.current = true;
          markProgrammaticScroll();
          row.scrollIntoView?.({ block: 'nearest' });
        }
      });
    },
    [markProgrammaticScroll]
  );

  useLayoutEffect(() => {
    const list = listRef.current;
    const host = list?.closest<HTMLElement>('.model-panel-body') ?? list;
    if (!host) return;
    // How far the list's end lies below the visible part of the panel. The
    // History details can follow the list in the same scroller, so the
    // scroller's own end is not the history's: measured from the list, the
    // floating button never covers a last row already in view.
    const measure = () =>
      setLatestOutOfView(
        (list && list !== host
          ? list.getBoundingClientRect().bottom -
            host.getBoundingClientRect().top -
            host.clientHeight
          : host.scrollHeight - host.clientHeight - host.scrollTop) > 24
      );
    measure();
    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    resize?.observe(host);
    if (list && list !== host) resize?.observe(list);
    const onScroll = () => {
      measure();
      if (programmaticScroll.current) return;
      following.current =
        host.scrollHeight - host.clientHeight - host.scrollTop <= 24;
      if (following.current && pendingAppendRef.current)
        setPendingAppendId(null);
    };
    const userInput = () => {
      programmaticScroll.current = false;
    };
    const inputs = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
    host.addEventListener('scroll', onScroll, { passive: true });
    for (const input of inputs)
      host.addEventListener(input, userInput, { passive: true });
    return () => {
      resize?.disconnect();
      host.removeEventListener('scroll', onScroll);
      for (const input of inputs) host.removeEventListener(input, userInput);
    };
  }, []);
  function selectHistoryFeature(id: string) {
    following.current = id === features.at(-1)?.id;
    onSelectFeature(id);
  }

  /** A pointer press on a row's name or its icon. */
  function activateRow(
    feature: FeatureNode,
    event: ReactMouseEvent<HTMLElement>
  ) {
    // Ahead of the multi-click guard: quick Shift- or Ctrl-clicks down the
    // list count up `detail` too.
    if (
      onDeleteFeatures !== undefined &&
      (event.shiftKey || event.metaKey || event.ctrlKey)
    ) {
      extendBatch(featureById.get(feature.id) ?? feature, event.shiftKey);
      // Safari does not focus a clicked button, and Delete has to reach the
      // list rather than the workspace.
      event.currentTarget.focus();
      return;
    }
    if (batchIds.length > 0) clearBatch();
    batchAnchor.current = feature.featureId;
    // A pointer's first click: Enter and Space report 0.
    if (event.detail === 1) {
      const row = event.currentTarget.closest<HTMLElement>('.feature-row');
      holdMultiClickToRow(row ?? event.currentTarget);
    }
    // The rest of a double-click is the same gesture, not a second press:
    // selecting a selected row clears it, so the second click closed the
    // edit card the first had opened — whenever the row stayed under the
    // pointer, as it does now that the card stands in its own lane.
    if (event.detail > 1) return;
    selectHistoryFeature(feature.id);
  }

  const featureArrivals = useArrivals(
    features.map((feature) => feature.id),
    ARRIVAL_MS
  );

  // A feature deleted (or undone away) mid-rename takes the field with it.
  useEffect(() => {
    if (
      renamingId &&
      !features.some((feature) => feature.featureId === renamingId)
    ) {
      setRenamingId(null);
    }
  }, [features, renamingId]);

  // The last feature still in the build when every later one is paused by
  // rollback; otherwise the history runs to its end.
  const rollbackIndex = findRollbackMarkerIndex(features);
  const last = features.length - 1;
  const committedEnd = rollbackIndex >= 0 ? rollbackIndex : last;
  const end = Math.min(previewEnd ?? committedEnd, last);
  const pausedCount = features.filter(isFeatureRollbackSuppressed).length;

  const needle = findOpen ? query.trim().toLowerCase() : '';
  // Related narrows to the selection's lineage; it reads as off whenever
  // nothing is selected, so clearing the selection never empties the list.
  const related = findOpen && relatedOnly ? relatedFeatureIds : null;
  const summaries = features.map((feature) =>
    featureValueSummary(
      feature,
      parameterValues,
      units,
      (bodyId) => representations[bodyId]?.name
    )
  );
  // Each row's one status, decided before any filter so the Problems
  // filter keeps exactly the rows that show a problem.
  const statuses = features.map((feature, index): HistoryRowStatus => {
    if (isFeatureManuallySuppressed(feature)) return 'suppressed';
    // At rest a row is paused by its own metadata, not its position: a
    // paused feature reordered above the handle stays paused. While the
    // handle is moving, the preview decides.
    if (
      previewEnd === null ? isFeatureRollbackSuppressed(feature) : index > end
    )
      return 'paused';
    if (geometryPending) return geometryPendingShown ? 'preparing' : null;
    const tier = historyFailureTier(
      feature.featureId,
      featureNeedsRepair(feature, representations, failedFeatureIds),
      failureLineage ?? NO_LINEAGE
    );
    // A step suppressed by rollback alone is no failure of its own and
    // stands on nothing while it is out of the build.
    if (tier === 'built-on-failed' && isFeatureSuppressed(feature)) return null;
    if (tier) return tier;
    const sketchId = sketchIdOf(feature);
    return sketchId !== null && brokenProjectionSketchIds?.has(sketchId)
      ? 'broken-projection'
      : null;
  });
  const isProblem = (status: HistoryRowStatus) =>
    status === 'root' ||
    status === 'downstream' ||
    status === 'built-on-failed' ||
    status === 'broken-projection';
  const problemCount = statuses.filter(isProblem).length;
  const problems = findOpen && problemsOnly && problemCount > 0;
  const visible = features
    .map((feature, index) => ({ feature, index }))
    .filter(
      ({ feature, index }) =>
        (!related || related.has(feature.featureId)) &&
        (!problems || isProblem(statuses[index]!)) &&
        (!needle ||
          feature.name.toLowerCase().includes(needle) ||
          (summaries[index] ?? '').toLowerCase().includes(needle))
    );
  const filtering = needle.length > 0 || related !== null || problems;
  // Only rows on screen act: a step a filter hides is never deleted unseen.
  const batchIds = onDeleteFeatures
    ? visible
        .filter(({ feature }) => batch.has(feature.featureId))
        .map(({ feature }) => feature.featureId)
    : [];

  useEffect(() => {
    if (!findOpen) {
      setQuery('');
      setRelatedOnly(false);
      setProblemsOnly(false);
    }
  }, [findOpen]);

  // Once nothing is wrong, Problems turns off for good, as Related does when
  // the selection clears: the next failure does not silently re-filter.
  useEffect(() => {
    if (problemCount === 0) setProblemsOnly(false);
  }, [problemCount]);

  // A step deleted or undone away leaves the batch, so an undo that brings
  // it back does not bring it back selected.
  useEffect(() => {
    setBatch((current) => {
      if (current.size === 0) return current;
      const present = new Set(features.map((feature) => feature.featureId));
      const kept = [...current].filter((id) => present.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [features]);

  // A single selection made anywhere (a plain click, the viewport, the
  // arrow keys) replaces the batch.
  useEffect(() => {
    if (selectedFeatureNodeId)
      setBatch((current) => (current.size ? new Set() : current));
  }, [selectedFeatureNodeId]);

  // Clearing the selection turns Related off for good, so the next selection
  // does not silently re-filter behind a toggle that read as off.
  useEffect(() => {
    if (!relatedFeatureIds) setRelatedOnly(false);
  }, [relatedFeatureIds]);

  useEffect(
    () => () => {
      if (commitTimer.current !== null) {
        window.clearTimeout(commitTimer.current);
      }
      if (refocusFrame.current !== null) {
        cancelAnimationFrame(refocusFrame.current);
      }
      if (selectionFrame.current !== null)
        cancelAnimationFrame(selectionFrame.current);
      if (scrollResetFrame.current !== null)
        cancelAnimationFrame(scrollResetFrame.current);
    },
    []
  );

  // A keyboard step waiting to commit names a position in the history as it
  // stood when the key was pressed. Once the order or the rollback changes
  // (a reorder, a delete, an undo), that position means something else, so
  // the step is dropped rather than applied to the new history.
  const historyShape = features
    .map(
      (feature) =>
        `${feature.id}:${isFeatureRollbackSuppressed(feature) ? 1 : 0}`
    )
    .join('|');
  useEffect(() => {
    if (commitTimer.current !== null) {
      window.clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    setPreviewEnd(null);
  }, [historyShape]);

  // A selection made anywhere else (the viewport, the command palette) brings
  // its row into view.
  useEffect(() => {
    if (!selectedFeatureNodeId) {
      return;
    }
    const append = latestAppendRef.current;
    if (
      append &&
      handledAppend.current !==
        `${append.projectId}:${append.version}:${append.nodeId}`
    ) {
      // Commit-time selection inference must not race the local reveal or
      // pull a user away from older rows they are reading.
      return;
    }
    // Next frame, not here: a selection commit is followed by others (the
    // edit card, the viewport), and scrolling now forced a layout of the
    // whole workspace that the frame then had to repeat.
    if (selectionFrame.current !== null)
      cancelAnimationFrame(selectionFrame.current);
    const id = selectedFeatureNodeId;
    selectionFrame.current = requestAnimationFrame(() => {
      selectionFrame.current = null;
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-node-id="${CSS.escape(id)}"]`
      );
      if (row) {
        markProgrammaticScroll();
        row.scrollIntoView?.({ block: 'nearest' });
      }
    });
  }, [selectedFeatureNodeId, markProgrammaticScroll]);

  const revealSeq = revealRequest?.seq;
  // A request made before this list mounted (another project's) is old news.
  const handledReveal = useRef(revealSeq);
  useEffect(() => {
    if (!revealRequest || handledReveal.current === revealRequest.seq) return;
    handledReveal.current = revealRequest.seq;
    const id = revealRequest.nodeId;
    if (!features.some((feature) => feature.id === id)) return;
    const visibleNow = listRef.current?.querySelector(
      `[data-node-id="${CSS.escape(id)}"]`
    );
    if (!visibleNow) {
      // A filter hides the row: clear it, as Show latest does.
      onCloseFind();
      setQuery('');
      setRelatedOnly(false);
      setProblemsOnly(false);
    }
    if (refocusFrame.current !== null)
      cancelAnimationFrame(refocusFrame.current);
    refocusFrame.current = requestAnimationFrame(() => {
      refocusFrame.current = null;
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-node-id="${CSS.escape(id)}"]`
      );
      if (row) {
        markProgrammaticScroll();
        row.scrollIntoView?.({ block: 'nearest' });
      }
    });
    // Only a new request reveals; the callbacks it reads are the latest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSeq]);

  useEffect(() => {
    if (
      !localAppend ||
      (pendingAppendId &&
        !features.some((feature) => feature.id === pendingAppendId))
    )
      setPendingAppendId(null);
  }, [localAppend, features, pendingAppendId]);

  useEffect(() => {
    if (!localAppend) return;
    const key = `${localAppend.projectId}:${localAppend.version}:${localAppend.nodeId}`;
    if (
      handledAppend.current === key ||
      !features.some((feature) => feature.id === localAppend.nodeId)
    )
      return;
    handledAppend.current = key;
    if (
      following.current &&
      !filtering &&
      !findOpen &&
      renamingId === null &&
      !draggingHandle &&
      dragFeatureId === null
    ) {
      setPendingAppendId(null);
      revealOperation(localAppend.nodeId);
    } else {
      setPendingAppendId(localAppend.nodeId);
    }
  }, [
    localAppend,
    features,
    filtering,
    findOpen,
    renamingId,
    draggingHandle,
    dragFeatureId,
    revealOperation
  ]);

  // Place the line, its fill, the handle and the selection highlight against
  // the rows as laid out. One style write per render, no state round-trip.
  // What the line, handle and highlight are placed from. The browser
  // re-renders with the workspace (every pointer move of a drag), and each
  // placement reads row geometry, forcing a layout; so it runs only when
  // this changes, plus on a resize of the list (fonts, zoom).
  const layoutKey = [
    visible.map(({ feature }) => feature.id).join(','),
    end,
    last,
    selectedFeatureNodeId ?? ''
  ].join('|');
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    if (typeof ResizeObserver === 'undefined') {
      placeTimeline(list);
      return;
    }
    // A new observation reports the list's size after this frame's layout
    // and before its paint, so the placement reads settled geometry instead
    // of forcing a layout inside the commit (the whole workspace's, on an
    // edit that adds a feature).
    const observer = new ResizeObserver(() => placeTimeline(list));
    observer.observe(list);
    return () => observer.disconnect();
  }, [layoutKey]);

  function cancelPendingCommit() {
    if (commitTimer.current !== null) {
      window.clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
  }

  function commitEnd(index: number) {
    // A keyboard step still waiting to commit must not land after this one.
    cancelPendingCommit();
    setPreviewEnd(null);
    if (index === committedEnd) {
      return;
    }
    if (index >= last) {
      onResumeHistory();
      return;
    }
    const feature = features[index];
    if (feature) {
      onRollbackAfterFeature(feature.featureId, feature.name);
    }
  }

  /**
   * Buttons that set the end of history outright (Resume, a row's Roll back)
   * drop any keyboard step still waiting, so it cannot land after them.
   */
  function resumeNow() {
    cancelPendingCommit();
    setPreviewEnd(null);
    onResumeHistory();
  }

  function rollBackAfter(feature: FeatureNode) {
    cancelPendingCommit();
    setPreviewEnd(null);
    onRollbackAfterFeature(feature.featureId, feature.name);
  }

  function rowActions(feature: FeatureNode, index: number): HistoryRowActions {
    return {
      endOfHistory:
        index !== committedEnd ? null : committedEnd < last ? 'marker' : 'last',
      rollBack: () => rollBackAfter(feature),
      resume: resumeNow,
      ...(onRenameFeature
        ? { rename: () => setRenamingId(feature.featureId) }
        : {}),
      ...(batchIds.length > 1 && batchIds.includes(feature.featureId)
        ? { deleteSelection: { count: batchIds.length, run: deleteBatch } }
        : {})
    };
  }

  function clearBatch() {
    setBatch((current) => (current.size ? new Set() : current));
  }

  function deleteBatch() {
    if (batchIds.length > 0) onDeleteFeatures?.(batchIds);
  }

  /**
   * Shift-click selects the visible rows from the anchor to `feature`;
   * Ctrl/⌘-click adds or drops `feature` and moves the anchor to it. The
   * single selection, when there is one, seeds the batch and then steps
   * aside, so the edit card is not left editing one step of several.
   */
  function extendBatch(feature: FeatureNode, range: boolean) {
    const order = visible.map((row) => row.feature.featureId);
    const single = features.find(
      (candidate) => candidate.id === selectedFeatureNodeId
    );
    const next = new Set(batchIds);
    if (next.size === 0 && single && order.includes(single.featureId)) {
      next.add(single.featureId);
    }
    if (range) {
      const anchorId =
        [batchAnchor.current, single?.featureId].find(
          (id): id is FeatureId => !!id && order.includes(id)
        ) ?? feature.featureId;
      const from = order.indexOf(anchorId);
      const to = order.indexOf(feature.featureId);
      next.clear();
      for (const id of order.slice(Math.min(from, to), Math.max(from, to) + 1))
        next.add(id);
      batchAnchor.current = anchorId;
    } else {
      if (next.has(feature.featureId)) next.delete(feature.featureId);
      else next.add(feature.featureId);
      batchAnchor.current = feature.featureId;
    }
    setBatch(next);
    if (single) onSelectFeature(single.id);
  }

  function moveEndTo(target: number) {
    const next = Math.max(0, Math.min(last, target));
    setPreviewEnd(next);
    cancelPendingCommit();
    commitTimer.current = window.setTimeout(() => {
      commitTimer.current = null;
      commitEnd(next);
    }, KEYBOARD_COMMIT_MS);
  }

  /** The feature boundary nearest the pointer, as the index of the row above it. */
  function endAtPointer(clientY: number): number {
    const list = listRef.current;
    if (!list) {
      return end;
    }
    const top = list.getBoundingClientRect().top;
    let best = end;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const row of list.querySelectorAll<HTMLElement>(
      ':scope > .feature-row'
    )) {
      const boundary = top + row.offsetTop + row.offsetHeight;
      const distance = Math.abs(clientY - boundary);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = Number(row.dataset.historyIndex);
      }
    }
    return best;
  }

  function onHandlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    cancelPendingCommit();
    setDraggingHandle(true);
    setPreviewEnd(end);
  }

  function onHandlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingHandle) {
      return;
    }
    const next = endAtPointer(event.clientY);
    if (next !== previewEnd) {
      setPreviewEnd(next);
    }
  }

  function onHandlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingHandle) {
      return;
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDraggingHandle(false);
    commitEnd(previewEnd ?? end);
  }

  function onHandleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target =
      event.key === 'ArrowUp'
        ? end - 1
        : event.key === 'ArrowDown'
          ? end + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (target === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    moveEndTo(target);
  }

  // ↑/↓ walk the selection row by row; ⇧↑/⇧↓ move the end of history.
  // With rows batched, Delete removes them all and Escape lets them go;
  // Ctrl/⌘+A on a row batches every visible row.
  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const onRow = (event.target as HTMLElement).closest('.feature-row-main');
    if (onRow && onDeleteFeatures && !event.altKey) {
      if (
        (event.key === 'a' || event.key === 'A') &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        visible.length > 0
      ) {
        event.preventDefault();
        event.stopPropagation();
        const single = features.find(
          (candidate) => candidate.id === selectedFeatureNodeId
        );
        setBatch(new Set(visible.map(({ feature }) => feature.featureId)));
        if (single) onSelectFeature(single.id);
        return;
      }
      if (batchIds.length > 0 && !event.metaKey && !event.ctrlKey) {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          event.stopPropagation();
          deleteBatch();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          clearBatch();
          return;
        }
      }
    }
    if (
      (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey
    ) {
      return;
    }
    const target = event.target as HTMLElement;
    // The grip owns the arrow keys for reordering.
    if (!target.closest('.feature-row-main')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const delta = event.key === 'ArrowUp' ? -1 : 1;
    if (event.shiftKey) {
      if (!filtering) {
        moveEndTo(end + delta);
      }
      return;
    }
    const at = visible.findIndex(
      ({ feature }) => feature.id === selectedFeatureNodeId
    );
    const fromRow = target.closest<HTMLElement>('.feature-row');
    const from =
      at >= 0
        ? at
        : visible.findIndex(
            ({ feature }) => feature.id === fromRow?.dataset.nodeId
          );
    const next =
      visible[Math.max(0, Math.min(visible.length - 1, from + delta))];
    if (!next || next.feature.id === selectedFeatureNodeId) {
      return;
    }
    selectHistoryFeature(next.feature.id);
    const focusRow = () =>
      listRef.current
        ?.querySelector<HTMLElement>(
          `[data-node-id="${CSS.escape(next.feature.id)}"] .feature-row-main`
        )
        ?.focus();
    focusRow();
    // Selecting a row opens its edit card, and the inspector hands that card
    // the keyboard once the selection commits, after this handler has run.
    // Taking focus back a frame later keeps the walk going; otherwise the
    // next arrow key lands in the card and the walk stops after one row.
    if (refocusFrame.current !== null) {
      cancelAnimationFrame(refocusFrame.current);
    }
    refocusFrame.current = requestAnimationFrame(() => {
      refocusFrame.current = null;
      focusRow();
    });
  }

  const handleFeature = features[end];

  // Rows read this only from event handlers, after the commit that wrote it.
  const rowContext = useRef<HistoryRowContext | null>(null);
  const featureById = new Map(features.map((feature) => [feature.id, feature]));
  rowContext.current = {
    latest: (feature) => featureById.get(feature.id) ?? feature,
    filtering,
    reorderBusy,
    dragFeatureId,
    last,
    batchCount: batchIds.length,
    canDelete: onDeleteFeatures !== undefined,
    batchAnchor,
    listRef,
    setDragFeatureId,
    setDropFeatureId,
    setRenamingId,
    cancelPendingCommit,
    rowActions,
    extendBatch,
    clearBatch,
    selectHistoryFeature,
    activateRow,
    rollBackAfter,
    onFeatureContextMenu,
    onReorderFeature,
    onRenameFeature,
    onEditSketch,
    onToggleFeatureSuppression,
    onToggleSketchVisibility,
    onToggleBodyVisibility
  };

  return (
    <div className="history-timeline">
      <span className="visually-hidden" aria-live="polite" aria-atomic="true">
        {pendingFeature
          ? `New operation available: ${pendingFeature.name}`
          : ''}
      </span>
      {pausedCount > 0 && (
        <div className="history-rollback" role="status">
          {ROLLED_BACK_ICON}
          <span>
            Rolled back · {pausedCount} later{' '}
            {pausedCount === 1 ? 'feature' : 'features'} paused
          </span>
          <button
            type="button"
            className="history-resume"
            aria-label="Resume full history"
            title={
              reorderBusy
                ? 'Resume once the current check finishes'
                : 'Resume every feature paused by rollback. Features you suppressed stay suppressed.'
            }
            disabled={reorderBusy}
            onClick={resumeNow}
          >
            {/* Hidden from the status region, which would otherwise read
                every flip between the two words aloud. */}
            <span aria-hidden="true">
              {reorderBusy ? 'Checking…' : 'Resume'}
            </span>
          </button>
        </div>
      )}
      {findOpen && (
        // A div, not a label: the Related button sits inside, and a wrapping
        // label folds its own text into the button's name.
        <div className="history-find">
          <Search size={12} aria-hidden="true" />
          <input
            type="search"
            // The field appears on request, so it takes the keyboard with it.
            autoFocus
            value={query}
            placeholder="Find a step"
            aria-label="Find a step"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onCloseFind();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                listRef.current
                  ?.querySelector<HTMLElement>('.feature-row-main')
                  ?.focus();
              }
            }}
          />
          {filtering && (
            <small className="history-find-count mono">
              {visible.length} of {features.length}
            </small>
          )}
          <button
            type="button"
            className="history-find-related"
            aria-pressed={related !== null}
            disabled={!relatedFeatureIds}
            title={
              relatedFeatureIds
                ? 'Show only the steps the selection was built from and the steps built on it'
                : 'Select a step or a body to show its related steps'
            }
            onClick={() => setRelatedOnly((on) => !on)}
          >
            Related
          </button>
          <button
            type="button"
            className="history-find-problems"
            aria-pressed={problems}
            disabled={problemCount === 0}
            title={
              problemCount > 0
                ? 'Show only the steps that need repair, the steps built on them and broken projections'
                : 'No step needs repair'
            }
            onClick={() => setProblemsOnly((on) => !on)}
          >
            Problems
          </button>
        </div>
      )}
      {batchIds.length > 0 && (
        <div
          className="history-batch"
          role="toolbar"
          aria-label="Selected steps"
        >
          <span className="history-batch-count" aria-live="polite">
            {batchIds.length} selected
          </span>
          <button
            type="button"
            className="history-batch-delete"
            title={`Delete ${batchIds.length === 1 ? 'the selected step' : `all ${batchIds.length} selected steps`} (Del)`}
            onClick={deleteBatch}
          >
            <Trash2 size={12} aria-hidden="true" />
            Delete
          </button>
          <button
            type="button"
            className="history-batch-clear"
            title="Clear the selection (Esc)"
            aria-label="Clear the selection"
            onClick={clearBatch}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
      <div
        ref={listRef}
        data-end={end}
        data-last={last}
        className={`feature-list${filtering ? ' is-filtering' : ''}${draggingHandle ? ' is-scrubbing' : ''}`}
        onKeyDown={onListKeyDown}
      >
        {features.length === 0 && (
          <p className="muted sidebar-hint">
            No features yet. Pick a tool from the tool rail on the left to
            start.
          </p>
        )}
        {filtering && visible.length === 0 && (
          <p className="muted sidebar-hint">
            {needle
              ? `No ${related ? 'related ' : ''}steps match “${query.trim()}”.`
              : related
                ? 'No steps relate to the selection.'
                : 'No step has a problem.'}
          </p>
        )}
        {features.length > 0 && (
          <>
            <span className="history-spine" aria-hidden="true" />
            <span className="history-spine-fill" aria-hidden="true" />
            <span className="history-highlight" aria-hidden="true" />
          </>
        )}
        {visible.map(({ feature, index }) => {
          const manual = isFeatureManuallySuppressed(feature);
          const status = statuses[index]!;
          // At rest a row is paused by its own metadata, not its position:
          // a paused feature reordered above the handle stays paused. While
          // the handle is moving, the preview decides.
          const paused =
            previewEnd === null
              ? isFeatureRollbackSuppressed(feature)
              : index > end;
          const suppressed = isFeatureSuppressed(feature);
          const body = feature.bodyId
            ? representations[feature.bodyId]
            : undefined;
          const consumed = body?.consumed ?? false;
          const sketchId = sketchIdOf(feature);
          const hidden = sketchId
            ? hiddenSketchIds.has(sketchId)
            : feature.bodyId
              ? hiddenBodyIds.has(feature.bodyId)
              : false;
          const failed = status === 'root' || status === 'downstream';
          const failureRoot =
            status === 'downstream' || status === 'built-on-failed'
              ? (failureLineage?.get(feature.featureId)?.name ?? null)
              : null;
          const selected = selectedFeatureNodeId === feature.id;
          const editing = editingFeatureId === feature.featureId;
          const refusedEdit = editing && pendingStep !== null;
          const inBatch = batchIds.includes(feature.featureId);
          const delay =
            Math.min(Math.abs(index - end), CASCADE_MAX_STEPS) *
            CASCADE_STEP_MS;
          return (
            <HistoryRow
              key={feature.id}
              feature={feature}
              icon={featureIcon(feature)}
              index={index}
              className={`feature-row${sketchId ? ' is-sketch' : ''}${selected ? ' selected' : ''}${inBatch ? ' in-batch' : ''}${consumed ? ' consumed' : ''}${hidden ? ' hidden-body' : ''}${manual ? ' suppressed' : ''}${paused ? ' paused' : ''}${failed ? ' failed' : ''}${editing ? ' is-editing' : ''}${dragFeatureId === feature.featureId ? ' is-dragging' : ''}${dropFeatureId === feature.featureId ? ' is-drop-target' : ''}${featureArrivals.has(feature.id) ? ' is-arrival' : ''}`}
              delay={delay}
              value={summaries[index] ?? ''}
              status={status}
              failureRoot={failureRoot}
              selected={selected}
              inBatch={inBatch}
              consumed={consumed}
              refusalTitle={refusedEdit ? pendingStep.title : null}
              refusalMessage={refusedEdit ? pendingStep.message : null}
              suppressed={suppressed}
              rollbackActive={index === committedEnd && committedEnd < last}
              hidden={hidden}
              sketchId={sketchId}
              renaming={
                renamingId === feature.featureId &&
                onRenameFeature !== undefined
              }
              needle={needle}
              filtering={filtering}
              reorderBusy={reorderBusy}
              context={rowContext}
            />
          );
        })}
        {features.length > 0 && !filtering && end < last && (
          // The end of history as a rule across the list, drawn while it
          // falls before the last step. Not a target: the knob is.
          <span className="history-marker" aria-hidden="true" />
        )}
        {features.length > 0 && !filtering && handleFeature && (
          <div
            className={`history-handle${draggingHandle ? ' is-dragging' : ''}${reorderBusy ? ' is-busy' : ''}`}
            role="slider"
            tabIndex={0}
            aria-label="End of history"
            aria-orientation="vertical"
            aria-valuemin={1}
            aria-valuemax={features.length}
            aria-valuenow={end + 1}
            aria-valuetext={
              end === last ? 'Full history' : `After ${handleFeature.name}`
            }
            title="Drag to roll history back or forward"
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
            onPointerCancel={() => {
              setDraggingHandle(false);
              setPreviewEnd(null);
            }}
            onKeyDown={onHandleKeyDown}
          >
            <span className="history-handle-label">
              {end === last ? 'End' : `After ${handleFeature.name}`}
            </span>
          </div>
        )}
      </div>
      {pendingStep &&
        !filtering &&
        !features.some((feature) => feature.featureId === editingFeatureId) && (
          // Outside the list: the handle, spine and keyboard walk measure
          // `.feature-row`s, and this is not a step that can be selected,
          // rolled back to or reordered.
          <div
            className="history-pending-row"
            role="status"
            title={pendingStep.message}
          >
            <AlertTriangle size={13} aria-hidden="true" />
            <span className="history-pending-name">{pendingStep.title}</span>
            <span className="history-pending-state">not built</span>
          </div>
        )}
      {features.length > 0 && (pendingFeature || latestOutOfView) && (
        // Floats at the foot of the panel, where the end is, and reserves no
        // row of its own; only while the end is out of view.
        <button
          type="button"
          className="history-latest"
          data-pending={Boolean(pendingFeature)}
          aria-label={
            pendingFeature
              ? `Show new operation: ${pendingFeature.name}`
              : 'Show latest operation'
          }
          onKeyDown={(event) => {
            // Keep native button activation from also opening an armed
            // viewport command's exact-value entry.
            if (event.key === 'Enter') event.stopPropagation();
          }}
          onClick={() => {
            onCloseFind();
            setQuery('');
            setRelatedOnly(false);
            setProblemsOnly(false);
            following.current = true;
            setPendingAppendId(null);
            revealOperation(pendingFeature?.id ?? features.at(-1)!.id);
          }}
          title={pendingFeature?.name ?? features.at(-1)!.name}
        >
          {LATEST_ICON}
          <span className="history-latest-label">
            {pendingFeature ? `New: ${pendingFeature.name}` : 'Latest'}
          </span>
        </button>
      )}
    </div>
  );
}
