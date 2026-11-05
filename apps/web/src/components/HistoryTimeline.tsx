import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import type { LocalHistoryAppend } from '../lib/localHistoryAppend';
import {
  AlertTriangle,
  Axis3d,
  Box,
  CirclePause,
  CirclePlay,
  Combine,
  Cone,
  Cylinder,
  EyeOff,
  FileBox,
  Globe,
  GripVertical,
  History,
  Layers,
  MoreHorizontal,
  Move3d,
  PenLine,
  RotateCw,
  Search,
  SquareDashed,
  Torus,
  Trash2,
  X
} from 'lucide-react';
import {
  isFeatureManuallySuppressed,
  isFeatureRollbackSuppressed,
  isFeatureSuppressed
} from '@openzcad/shared';
import type {
  BodyRepresentation,
  FeatureId,
  FeatureNode,
  UnitSystem
} from '@openzcad/shared';
import { useArrivals } from '../hooks/useArrivals';
import { featureNeedsRepair } from '../lib/featureRepair';
import { featureValueSummary } from '../lib/featureSummary';
import { FEATURE_KIND_LABELS } from '../lib/model';

function featureIcon(feature: FeatureNode) {
  const size = 13;
  if (feature.data.featureKind === 'primitive') {
    switch (feature.data.primitiveKind) {
      case 'box':
        return <Box size={size} aria-hidden="true" />;
      case 'cylinder':
        return <Cylinder size={size} aria-hidden="true" />;
      case 'sphere':
        return <Globe size={size} aria-hidden="true" />;
      case 'cone':
        return <Cone size={size} aria-hidden="true" />;
      case 'torus':
        return <Torus size={size} aria-hidden="true" />;
    }
  }
  switch (feature.featureKind) {
    case 'sketch':
      return <PenLine size={size} aria-hidden="true" />;
    case 'extrude':
      return <Layers size={size} aria-hidden="true" />;
    case 'revolve':
      return <RotateCw size={size} aria-hidden="true" />;
    case 'boolean':
      return <Combine size={size} aria-hidden="true" />;
    case 'transform':
      return <Move3d size={size} aria-hidden="true" />;
    case 'datum-plane':
      return <SquareDashed size={size} aria-hidden="true" />;
    case 'datum-axis':
      return <Axis3d size={size} aria-hidden="true" />;
    default:
      return <FileBox size={size} aria-hidden="true" />;
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
   * chose, so the grips hold still until it finishes.
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
  icon,
  onCommit,
  onDone
}: {
  feature: FeatureNode;
  icon: ReactNode;
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
    <span className="feature-row-rename">
      <span className="feature-icon">{icon}</span>
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
 * Places the line, its fill, the handle and the selection highlight against
 * the rows as laid out, through custom properties on the list. Reads the end
 * of history and the last index from the list's data attributes, so it needs
 * nothing from the render that scheduled it.
 */
function placeTimeline(list: HTMLElement) {
  const end = Number(list.dataset.end);
  const last = Number(list.dataset.last);
  const rows = [...list.querySelectorAll<HTMLElement>(':scope > .feature-row')];
  const first = rows[0];
  const lastRow = rows[rows.length - 1];
  const center = (row: HTMLElement) => row.offsetTop + row.offsetHeight / 2;
  const style = list.style;
  if (!first || !lastRow) {
    style.setProperty('--spine-height', '0px');
    style.setProperty('--highlight-opacity', '0');
    return;
  }
  style.setProperty('--spine-top', `${center(first)}px`);
  style.setProperty('--spine-height', `${center(lastRow) - center(first)}px`);
  const endRow = rows.find((row) => Number(row.dataset.historyIndex) === end);
  if (endRow) {
    const boundary = endRow.offsetTop + endRow.offsetHeight;
    style.setProperty('--handle-y', `${boundary}px`);
    style.setProperty(
      '--fill-height',
      `${(end === last ? center(endRow) : boundary) - center(first)}px`
    );
  }
  const selected = rows.find((row) => row.classList.contains('selected'));
  if (selected) {
    style.setProperty('--highlight-y', `${selected.offsetTop}px`);
    style.setProperty('--highlight-height', `${selected.offsetHeight}px`);
    style.setProperty('--highlight-opacity', '1');
  } else {
    style.setProperty('--highlight-opacity', '0');
  }
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
  onDeleteFeatures
}: HistoryTimelineProps) {
  const [dragFeatureId, setDragFeatureId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<FeatureId | null>(null);
  const [dropFeatureId, setDropFeatureId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [relatedOnly, setRelatedOnly] = useState(false);
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
    const measure = () =>
      setLatestOutOfView(
        host.scrollHeight - host.clientHeight - host.scrollTop > 24
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
  const visible = features
    .map((feature, index) => ({ feature, index }))
    .filter(
      ({ feature, index }) =>
        (!related || related.has(feature.featureId)) &&
        (!needle ||
          feature.name.toLowerCase().includes(needle) ||
          (summaries[index] ?? '').toLowerCase().includes(needle))
    );
  const filtering = needle.length > 0 || related !== null;
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
    }
  }, [findOpen]);

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
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-node-id="${CSS.escape(selectedFeatureNodeId)}"]`
    );
    if (row) {
      markProgrammaticScroll();
      row.scrollIntoView?.({ block: 'nearest' });
    }
  }, [selectedFeatureNodeId, markProgrammaticScroll]);

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
    placeTimeline(list);
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
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

  return (
    <div className="history-timeline">
      <span className="visually-hidden" aria-live="polite" aria-atomic="true">
        {pendingFeature
          ? `New operation available: ${pendingFeature.name}`
          : ''}
      </span>
      {features.length > 0 && (pendingFeature || latestOutOfView) && (
        <button
          type="button"
          className="history-resume history-latest"
          data-pending={Boolean(pendingFeature)}
          aria-label={
            pendingFeature
              ? `Show new operation: ${pendingFeature.name}`
              : undefined
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
            following.current = true;
            setPendingAppendId(null);
            revealOperation(pendingFeature?.id ?? features.at(-1)!.id);
          }}
          title={pendingFeature?.name ?? features.at(-1)!.name}
        >
          {pendingFeature ? 'Show new operation' : 'Show latest operation'}
        </button>
      )}
      {pausedCount > 0 && (
        <div className="history-rollback" role="status">
          <span>
            Rolled back · {pausedCount} later{' '}
            {pausedCount === 1 ? 'feature' : 'features'} paused
          </span>
          <button
            type="button"
            className="history-resume"
            aria-label="Resume full history"
            title="Resume every feature paused by rollback. Features you suppressed stay suppressed."
            onClick={resumeNow}
          >
            Resume
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
              : 'No steps relate to the selection.'}
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
          const failed =
            !geometryPending &&
            featureNeedsRepair(feature, representations, failedFeatureIds);
          const projectionBroken =
            !geometryPending &&
            sketchId !== null &&
            brokenProjectionSketchIds?.has(sketchId) === true;
          const selected = selectedFeatureNodeId === feature.id;
          const inBatch = batchIds.includes(feature.featureId);
          const value = manual
            ? 'suppressed'
            : paused
              ? 'paused'
              : geometryPending && geometryPendingShown
                ? 'preparing'
                : failed
                  ? 'needs repair'
                  : projectionBroken
                    ? 'broken projection'
                    : (summaries[index] ?? '');
          const delay =
            Math.min(Math.abs(index - end), CASCADE_MAX_STEPS) *
            CASCADE_STEP_MS;
          return (
            <div
              key={feature.id}
              data-node-id={feature.id}
              data-history-index={index}
              style={{ '--history-delay': `${delay}ms` } as CSSProperties}
              className={`feature-row${sketchId ? ' is-sketch' : ''}${selected ? ' selected' : ''}${inBatch ? ' in-batch' : ''}${consumed ? ' consumed' : ''}${hidden ? ' hidden-body' : ''}${manual ? ' suppressed' : ''}${paused ? ' paused' : ''}${failed ? ' failed' : ''}${dragFeatureId === feature.featureId ? ' is-dragging' : ''}${dropFeatureId === feature.featureId ? ' is-drop-target' : ''}${featureArrivals.has(feature.id) ? ' is-arrival' : ''}`}
              onContextMenu={(event) => {
                event.preventDefault();
                onFeatureContextMenu(
                  event,
                  feature,
                  rowActions(feature, index)
                );
              }}
              onDragOver={(event) => {
                if (
                  filtering ||
                  !dragFeatureId ||
                  dragFeatureId === feature.featureId
                ) {
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropFeatureId(feature.featureId);
              }}
              onDragLeave={() => {
                setDropFeatureId((current) =>
                  current === feature.featureId ? null : current
                );
              }}
              onDrop={(event) => {
                if (filtering || reorderBusy || !dragFeatureId) {
                  return;
                }
                event.preventDefault();
                onReorderFeature(dragFeatureId as FeatureId, index);
                setDragFeatureId(null);
                setDropFeatureId(null);
              }}
            >
              <span className="history-dot" aria-hidden="true" />
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
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', feature.featureId);
                  const row = event.currentTarget.closest('.feature-row');
                  if (row instanceof HTMLElement) {
                    // Without this the drag ghost is the grip alone, which
                    // gives no clue which row is being moved.
                    event.dataTransfer.setDragImage(row, 16, 16);
                  }
                  cancelPendingCommit();
                  setDragFeatureId(feature.featureId);
                }}
                onDragEnd={() => {
                  setDragFeatureId(null);
                  setDropFeatureId(null);
                }}
                onKeyDown={(event) => {
                  const offset =
                    event.key === 'ArrowUp'
                      ? -1
                      : event.key === 'ArrowDown'
                        ? 1
                        : 0;
                  if (offset === 0 || filtering) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  if (reorderBusy) {
                    return;
                  }
                  // Clamped so the ends of the list are a no-op rather than
                  // a move to -1 or past the end. The command layer refuses
                  // those too, but a keypress that cannot do anything should
                  // not travel that far to find out.
                  const target = index + offset;
                  if (target < 0 || target > last) {
                    return;
                  }
                  cancelPendingCommit();
                  onReorderFeature(feature.featureId, target);
                }}
              >
                <GripVertical size={12} aria-hidden="true" />
              </button>
              {renamingId === feature.featureId && onRenameFeature ? (
                <FeatureRenameField
                  feature={feature}
                  icon={featureIcon(feature)}
                  onCommit={(name) => onRenameFeature(feature.featureId, name)}
                  onDone={(refocus) => {
                    setRenamingId(null);
                    if (!refocus) return;
                    // The field unmounts with focus in it; give it back to
                    // the row it replaced rather than dropping it on the page.
                    requestAnimationFrame(() =>
                      listRef.current
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
                    if (onDeleteFeatures && event.shiftKey)
                      event.preventDefault();
                  }}
                  onClick={(event) => {
                    // Ahead of the multi-click guard: quick Shift- or
                    // Ctrl-clicks down the list count up `detail` too.
                    if (
                      onDeleteFeatures &&
                      (event.shiftKey || event.metaKey || event.ctrlKey)
                    ) {
                      extendBatch(feature, event.shiftKey);
                      // Safari does not focus a clicked button, and Delete
                      // has to reach the list rather than the workspace.
                      event.currentTarget.focus();
                      return;
                    }
                    if (batchIds.length > 0) clearBatch();
                    batchAnchor.current = feature.featureId;
                    // A pointer's first click: Enter and Space report 0.
                    if (event.detail === 1) {
                      holdMultiClickToRow(event.currentTarget);
                    }
                    // The rest of a double-click is the same gesture, not a
                    // second press: selecting a selected row clears it, so
                    // the second click closed the edit card the first had
                    // opened — whenever the row stayed under the pointer, as
                    // it does now that the card stands in its own lane.
                    if (event.detail > 1) return;
                    selectHistoryFeature(feature.id);
                  }}
                  // Every row used to announce the same generic kind label, so
                  // a history read aloud was a list of identical items. The
                  // feature's own name comes first, as on screen.
                  // The value beside the name can be cut short in a narrow
                  // panel, and fades for the row's actions on hover: the
                  // tooltip carries it whole.
                  title={`${feature.name} — ${FEATURE_KIND_LABELS[feature.featureKind]}${value ? ` (${value})` : ''}${consumed ? ', combined into a later feature' : ''}, click to edit`}
                >
                  <span className="feature-icon">{featureIcon(feature)}</span>
                  <span className="feature-name">
                    {markedName(feature.name, needle)}
                  </span>
                  {failed && (
                    <span
                      className="feature-flag error"
                      title="Feature failed to build"
                    >
                      <AlertTriangle size={11} aria-hidden="true" />
                    </span>
                  )}
                  {projectionBroken && !failed && (
                    <span
                      className="feature-flag error"
                      title="A linked projection lost its source edge. Open the sketch to re-pick or unlink it."
                    >
                      <AlertTriangle size={11} aria-hidden="true" />
                    </span>
                  )}
                </button>
              )}
              <span className="history-row-tail">
                <span className="history-row-value mono">{value}</span>
                <span className="history-row-actions">
                  <button
                    type="button"
                    className={`row-suppression${suppressed ? ' is-suppressed' : ''}`}
                    title={
                      suppressed
                        ? `Resume ${feature.name}`
                        : `Suppress ${feature.name}`
                    }
                    aria-label={
                      suppressed
                        ? `Resume ${feature.name}`
                        : `Suppress ${feature.name}`
                    }
                    aria-pressed={suppressed}
                    onClick={() => onToggleFeatureSuppression(feature)}
                  >
                    {suppressed ? (
                      <CirclePlay size={12} aria-hidden="true" />
                    ) : (
                      <CirclePause size={12} aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    className={`row-rollback${index === committedEnd && committedEnd < last ? ' is-active' : ''}`}
                    title={`Roll back history after ${feature.name}`}
                    aria-label={`Roll back history after ${feature.name}`}
                    aria-pressed={index === committedEnd && committedEnd < last}
                    onClick={() => rollBackAfter(feature)}
                  >
                    <History size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="row-more"
                    title="More actions"
                    aria-label={`More actions for ${feature.name}`}
                    aria-haspopup="menu"
                    onClick={(event) => {
                      const box = event.currentTarget.getBoundingClientRect();
                      onFeatureContextMenu(
                        { clientX: box.left, clientY: box.bottom + 2 },
                        feature,
                        rowActions(feature, index)
                      );
                    }}
                  >
                    <MoreHorizontal size={12} aria-hidden="true" />
                  </button>
                </span>
              </span>
              {hidden && (
                <button
                  type="button"
                  className="row-visibility is-hidden"
                  title={`Show ${feature.name}`}
                  aria-label={`Show ${feature.name}`}
                  aria-pressed={true}
                  onClick={() =>
                    sketchId
                      ? onToggleSketchVisibility(sketchId)
                      : feature.bodyId && onToggleBodyVisibility(feature.bodyId)
                  }
                >
                  <EyeOff size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
        {features.length > 0 && !filtering && handleFeature && (
          <div
            className={`history-handle${draggingHandle ? ' is-dragging' : ''}`}
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
      {pendingStep && !filtering && (
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
    </div>
  );
}
