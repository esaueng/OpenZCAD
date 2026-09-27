import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import {
  AlertTriangle,
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
  Torus
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

export interface HistoryTimelineProps {
  features: FeatureNode[];
  representations: Record<string, BodyRepresentation>;
  selectedFeatureNodeId: string | null;
  hiddenBodyIds: ReadonlySet<string>;
  hiddenSketchIds: ReadonlySet<string>;
  parameterValues: Record<string, number>;
  units: UnitSystem;
  findOpen: boolean;
  onCloseFind(): void;
  onSelectFeature(nodeId: string): void;
  onToggleBodyVisibility(bodyId: string): void;
  onToggleSketchVisibility(sketchId: string): void;
  onFeatureContextMenu(
    at: { clientX: number; clientY: number },
    feature: FeatureNode
  ): void;
  onToggleFeatureSuppression(feature: FeatureNode): void;
  onRollbackAfterFeature(featureId: FeatureId, name: string): void;
  onResumeHistory(): void;
  onReorderFeature(featureId: FeatureId, toIndex: number): void;
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
 * The History list: features on a vertical timeline, one short value per row,
 * and a single handle on the line that marks the end of history.
 *
 * The handle, the line's fill and the selection highlight are positioned from
 * the rendered rows rather than from a fixed row height, so a row that grows
 * (a long flag, a larger font) never puts them out of step with the list.
 */
export function HistoryTimeline({
  features,
  representations,
  selectedFeatureNodeId,
  hiddenBodyIds,
  hiddenSketchIds,
  parameterValues,
  units,
  findOpen,
  onCloseFind,
  onSelectFeature,
  onToggleBodyVisibility,
  onToggleSketchVisibility,
  onFeatureContextMenu,
  onToggleFeatureSuppression,
  onRollbackAfterFeature,
  onResumeHistory,
  onReorderFeature
}: HistoryTimelineProps) {
  const [dragFeatureId, setDragFeatureId] = useState<string | null>(null);
  const [dropFeatureId, setDropFeatureId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Where the handle sits while it is being dragged or stepped from the
  // keyboard, before that position is committed to the document.
  const [previewEnd, setPreviewEnd] = useState<number | null>(null);
  const [draggingHandle, setDraggingHandle] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const commitTimer = useRef<number | null>(null);
  const featureArrivals = useArrivals(
    features.map((feature) => feature.id),
    ARRIVAL_MS
  );

  const last = features.length - 1;
  // The last feature still in the build when every later one is paused by
  // rollback; otherwise the history runs to its end.
  const rollbackIndex = features.findIndex(
    (feature, index) =>
      index < last &&
      !isFeatureRollbackSuppressed(feature) &&
      features
        .slice(index + 1)
        .every((candidate) => isFeatureRollbackSuppressed(candidate))
  );
  const committedEnd = rollbackIndex >= 0 ? rollbackIndex : last;
  const end = Math.min(previewEnd ?? committedEnd, last);
  const pausedCount = features.filter(isFeatureRollbackSuppressed).length;

  const needle = findOpen ? query.trim().toLowerCase() : '';
  const summaries = features.map((feature) =>
    featureValueSummary(feature, parameterValues, units)
  );
  const visible = features
    .map((feature, index) => ({ feature, index }))
    .filter(
      ({ feature, index }) =>
        !needle ||
        feature.name.toLowerCase().includes(needle) ||
        (summaries[index] ?? '').toLowerCase().includes(needle)
    );
  const filtering = needle.length > 0;

  useEffect(() => {
    if (!findOpen) {
      setQuery('');
    }
  }, [findOpen]);

  useEffect(
    () => () => {
      if (commitTimer.current !== null) {
        window.clearTimeout(commitTimer.current);
      }
    },
    []
  );

  // A selection made anywhere else (the viewport, the command palette) brings
  // its row into view.
  useEffect(() => {
    if (!selectedFeatureNodeId) {
      return;
    }
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-node-id="${CSS.escape(selectedFeatureNodeId)}"]`
    );
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedFeatureNodeId]);

  // Place the line, its fill, the handle and the selection highlight against
  // the rows as laid out. One style write per render, no state round-trip.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const rows = [
      ...list.querySelectorAll<HTMLElement>(':scope > .feature-row')
    ];
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
  });

  function commitEnd(index: number) {
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

  function moveEndTo(target: number) {
    const next = Math.max(0, Math.min(last, target));
    setPreviewEnd(next);
    if (commitTimer.current !== null) {
      window.clearTimeout(commitTimer.current);
    }
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
  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
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
    onSelectFeature(next.feature.id);
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-node-id="${CSS.escape(next.feature.id)}"] .feature-row-main`
      )
      ?.focus();
  }

  const handleFeature = features[end];

  return (
    <div className="history-timeline">
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
            onClick={onResumeHistory}
          >
            Resume
          </button>
        </div>
      )}
      {findOpen && (
        <label className="history-find">
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
        </label>
      )}
      <div
        ref={listRef}
        className={`feature-list${filtering ? ' is-filtering' : ''}${draggingHandle ? ' is-scrubbing' : ''}`}
        onKeyDown={onListKeyDown}
      >
        {features.length === 0 && (
          <p className="muted sidebar-hint">
            No features yet. Pick a tool from the command card to start.
          </p>
        )}
        {filtering && visible.length === 0 && (
          <p className="muted sidebar-hint">No steps match “{query.trim()}”.</p>
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
          const paused = index > end;
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
            !suppressed &&
            feature.bodyId !== undefined &&
            feature.featureKind !== 'sketch' &&
            body === undefined;
          const selected = selectedFeatureNodeId === feature.id;
          const value = manual
            ? 'suppressed'
            : paused
              ? 'paused'
              : failed
                ? 'needs repair'
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
              className={`feature-row${sketchId ? ' is-sketch' : ''}${selected ? ' selected' : ''}${consumed ? ' consumed' : ''}${hidden ? ' hidden-body' : ''}${manual ? ' suppressed' : ''}${paused ? ' paused' : ''}${failed ? ' failed' : ''}${dragFeatureId === feature.featureId ? ' is-dragging' : ''}${dropFeatureId === feature.featureId ? ' is-drop-target' : ''}${featureArrivals.has(feature.id) ? ' is-arrival' : ''}`}
              onContextMenu={(event) => {
                event.preventDefault();
                onFeatureContextMenu(event, feature);
              }}
              onDragOver={(event) => {
                if (!dragFeatureId || dragFeatureId === feature.featureId) {
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
                if (!dragFeatureId) {
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
                title="Drag to reorder"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', feature.featureId);
                  const row = event.currentTarget.closest('.feature-row');
                  if (row instanceof HTMLElement) {
                    // Without this the drag ghost is the grip alone, which
                    // gives no clue which row is being moved.
                    event.dataTransfer.setDragImage(row, 16, 16);
                  }
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
                  if (offset === 0) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  // Clamped so the ends of the list are a no-op rather than
                  // a move to -1 or past the end. The command layer refuses
                  // those too, but a keypress that cannot do anything should
                  // not travel that far to find out.
                  const target = index + offset;
                  if (target < 0 || target > last) {
                    return;
                  }
                  onReorderFeature(feature.featureId, target);
                }}
              >
                <GripVertical size={12} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="feature-row-main"
                aria-pressed={selected}
                onClick={() => onSelectFeature(feature.id)}
                // Every row used to announce the same generic kind label, so
                // a history read aloud was a list of identical items. The
                // feature's own name comes first, as on screen.
                title={`${feature.name} — ${FEATURE_KIND_LABELS[feature.featureKind]}${consumed ? ', combined into a later feature' : ''}, click to edit`}
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
              </button>
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
                    onClick={() =>
                      onRollbackAfterFeature(feature.featureId, feature.name)
                    }
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
                        feature
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
    </div>
  );
}
