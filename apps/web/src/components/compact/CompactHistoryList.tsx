import {
  AlertTriangle,
  CirclePause,
  CirclePlay,
  FileCode2,
  GripVertical,
  History,
  MoreHorizontal,
  Trash2
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';
import {
  isFeatureManuallySuppressed,
  isFeatureRollbackSuppressed,
  type FeatureId,
  type FeatureNode
} from '@openzcad/shared';
import { useDisplayUnits } from '../../lib/displayUnits';
import { featureNeedsRepair } from '../../lib/featureRepair';
import { featureValueSummary } from '../../lib/featureSummary';
import {
  featureIcon,
  findRollbackMarkerIndex,
  type HistoryRowActions
} from '../HistoryTimeline';
import type {
  ModelPanelSource,
  PendingHistoryStep
} from '../modelPanels/modelPanelProps';
import {
  isSwipe,
  reorderTarget,
  restOffset,
  swipeOffset,
  swipeRest,
  type SwipeSide
} from './rowGestures';

export type CompactHistoryListProps = Pick<
  ModelPanelSource,
  | 'features'
  | 'representations'
  | 'failedFeatureIds'
  | 'geometryPending'
  | 'selectedFeatureNodeId'
  | 'parameterValues'
  | 'units'
  | 'historyDetails'
  | 'onFeatureContextMenu'
  | 'onToggleFeatureSuppression'
  | 'onRollbackAfterFeature'
  | 'onResumeHistory'
  | 'onReorderFeature'
  | 'reorderBusy'
  | 'onRenameFeature'
  | 'onDeleteFeatures'
  | 'pendingHistoryStep'
  | 'editingHistoryFeatureId'
> & {
  /** A tap on a row: opens the step's edit (a sketch opens to edit it). */
  onEditStep(feature: FeatureNode): void;
  /** History as text (L15), where the workspace can show it. */
  historyText?: { open: boolean; toggle(): void } | null;
};

type RowStatus = 'suppressed' | 'paused' | 'failed' | null;

/** Keeps the pointer's moves on the row while it swipes or drags. */
function capture(event: ReactPointerEvent<HTMLElement>) {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // A pointer the browser no longer tracks: its moves still arrive here.
  }
}

const STATUS_WORDS: Record<Exclude<RowStatus, null>, string> = {
  suppressed: 'suppressed',
  paused: 'rolled back',
  failed: 'needs repair'
};

interface Gesture {
  pointerId: number;
  x: number;
  y: number;
  base: number;
  swiping: boolean;
}

interface GripDrag {
  pointerId: number;
  y: number;
  midpoints: number[];
}

/**
 * History as a touch list (U12 slice 5): full-width rows with the step's
 * icon, its name (wrapping to two lines rather than cut mid-word) and its
 * value. A tap opens the step's edit, a swipe left offers Suppress and
 * Delete, a swipe right Roll back to here, and a long press the row's whole
 * menu, which is also behind each row's More button: every swipe action is
 * reachable without swiping. The grip reorders, by drag or arrow keys.
 */
export function CompactHistoryList({
  features,
  representations,
  failedFeatureIds,
  geometryPending = false,
  selectedFeatureNodeId,
  parameterValues,
  units,
  historyDetails,
  onFeatureContextMenu,
  onToggleFeatureSuppression,
  onRollbackAfterFeature,
  onResumeHistory,
  onReorderFeature,
  reorderBusy = false,
  onRenameFeature,
  onDeleteFeatures,
  onEditStep,
  historyText,
  pendingHistoryStep = null,
  editingHistoryFeatureId = null
}: CompactHistoryListProps) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const shownUnits = useDisplayUnits(units);
  // One row open at a time, as a list of swipeable rows does.
  const [open, setOpen] = useState<{ id: string; side: SwipeSide } | null>(
    null
  );
  const [renamingId, setRenamingId] = useState<FeatureId | null>(null);
  const [drag, setDrag] = useState<{ id: string; dy: number } | null>(null);

  // A row deleted or undone away takes its open actions and its rename.
  useEffect(() => {
    if (open && !features.some((feature) => feature.id === open.id)) {
      setOpen(null);
    }
    if (
      renamingId &&
      !features.some((feature) => feature.featureId === renamingId)
    ) {
      setRenamingId(null);
    }
  }, [features, open, renamingId]);

  const rollbackIndex = findRollbackMarkerIndex(features);
  const last = features.length - 1;

  const rowActions = (
    feature: FeatureNode,
    index: number
  ): HistoryRowActions => ({
    endOfHistory:
      rollbackIndex === index
        ? 'marker'
        : rollbackIndex < 0 && index === last
          ? 'last'
          : null,
    rollBack: () => onRollbackAfterFeature(feature.featureId, feature.name),
    resume: onResumeHistory,
    ...(onRenameFeature
      ? { rename: () => setRenamingId(feature.featureId) }
      : {})
  });

  const midpoints = () =>
    [
      ...(listRef.current?.querySelectorAll<HTMLElement>(
        '[data-history-row]'
      ) ?? [])
    ].map((row) => {
      const box = row.getBoundingClientRect();
      return box.top + box.height / 2;
    });

  // A refused edit of a step: that step's row brings it back. A new step
  // that was not built (or one still being made) has no row of its own: it
  // trails the list, as in the regular History panel.
  const pendingOnRow =
    pendingHistoryStep !== null &&
    features.some((feature) => feature.featureId === editingHistoryFeatureId);
  const pendingRow =
    pendingHistoryStep && !pendingOnRow ? (
      <PendingStepRow step={pendingHistoryStep} />
    ) : null;

  if (features.length === 0) {
    return (
      <div className="compact-panel-list">
        {pendingRow ? (
          <ol className="compact-rows" aria-label="History steps">
            {pendingRow}
          </ol>
        ) : (
          <p className="compact-panel-empty">No steps yet</p>
        )}
      </div>
    );
  }

  return (
    <div className="compact-panel-list">
      {historyText ? (
        <div className="compact-panel-tools">
          <button
            type="button"
            className="compact-icon-button"
            aria-label="History as text"
            aria-haspopup="dialog"
            aria-pressed={historyText.open}
            data-history-text-toggle=""
            onClick={historyText.toggle}
          >
            <FileCode2 size={20} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <ol ref={listRef} className="compact-rows" aria-label="History steps">
        {features.map((feature, index) => {
          const actions = rowActions(feature, index);
          const status: RowStatus = isFeatureManuallySuppressed(feature)
            ? 'suppressed'
            : isFeatureRollbackSuppressed(feature)
              ? 'paused'
              : !geometryPending &&
                  featureNeedsRepair(feature, representations, failedFeatureIds)
                ? 'failed'
                : null;
          const value = featureValueSummary(
            feature,
            parameterValues,
            units,
            (bodyId) => representations[bodyId]?.name,
            shownUnits
          );
          return [
            <CompactHistoryRow
              key={feature.id}
              feature={feature}
              index={index}
              value={value ?? ''}
              status={status}
              selected={feature.id === selectedFeatureNodeId}
              actions={actions}
              refusal={
                pendingOnRow && feature.featureId === editingHistoryFeatureId
                  ? pendingHistoryStep
                  : null
              }
              open={open?.id === feature.id ? open.side : null}
              renaming={renamingId === feature.featureId}
              reorderBusy={reorderBusy}
              lastIndex={last}
              dragDy={drag?.id === feature.id ? drag.dy : null}
              midpoints={midpoints}
              canDelete={Boolean(onDeleteFeatures)}
              onOpen={(side) => setOpen(side ? { id: feature.id, side } : null)}
              anyOpen={open !== null}
              closeOpen={() => setOpen(null)}
              onDrag={(dy) =>
                setDrag(dy === null ? null : { id: feature.id, dy })
              }
              onEdit={() => onEditStep(feature)}
              onMenu={(at) => onFeatureContextMenu(at, feature, actions)}
              onSuppress={() => {
                setOpen(null);
                onToggleFeatureSuppression(feature);
              }}
              onDelete={() => {
                setOpen(null);
                onDeleteFeatures?.([feature.featureId]);
              }}
              onRollBack={() => {
                setOpen(null);
                if (actions.endOfHistory === 'marker') actions.resume();
                else actions.rollBack();
              }}
              onReorder={(target) =>
                onReorderFeature(feature.featureId, target)
              }
              onRename={(name) => onRenameFeature?.(feature.featureId, name)}
              onRenameDone={() => setRenamingId(null)}
            />,
            rollbackIndex === index ? (
              <li key="rollback-marker" className="compact-row-marker">
                <button
                  type="button"
                  className="compact-menu-row"
                  onClick={onResumeHistory}
                >
                  <span className="compact-menu-icon" aria-hidden="true">
                    <History size={20} />
                  </span>
                  <span className="compact-menu-label">
                    Resume full history
                  </span>
                </button>
              </li>
            ) : null
          ];
        })}
        {pendingRow}
      </ol>
      {historyDetails}
    </div>
  );
}

interface CompactHistoryRowProps {
  feature: FeatureNode;
  index: number;
  value: string;
  status: RowStatus;
  selected: boolean;
  actions: HistoryRowActions;
  /** The refused edit of this step, while one is set aside. */
  refusal: PendingHistoryStep | null;
  open: SwipeSide | null;
  anyOpen: boolean;
  renaming: boolean;
  reorderBusy: boolean;
  lastIndex: number;
  dragDy: number | null;
  midpoints(): number[];
  canDelete: boolean;
  onOpen(side: SwipeSide | null): void;
  closeOpen(): void;
  onDrag(dy: number | null): void;
  onEdit(): void;
  onMenu(at: { clientX: number; clientY: number }): void;
  onSuppress(): void;
  onDelete(): void;
  onRollBack(): void;
  onReorder(target: number): void;
  onRename(name: string): void;
  onRenameDone(): void;
}

function CompactHistoryRow({
  feature,
  index,
  value,
  status,
  selected,
  actions,
  refusal,
  open,
  anyOpen,
  renaming,
  reorderBusy,
  lastIndex,
  dragDy,
  midpoints,
  canDelete,
  onOpen,
  closeOpen,
  onDrag,
  onEdit,
  onMenu,
  onSuppress,
  onDelete,
  onRollBack,
  onReorder,
  onRename,
  onRenameDone
}: CompactHistoryRowProps) {
  const gesture = useRef<Gesture | null>(null);
  const grip = useRef<GripDrag | null>(null);
  // A press that swiped or closed an open row is not also a tap.
  const swallowClick = useRef(false);
  const [offset, setOffset] = useState<number | null>(null);
  const suppressed = status === 'suppressed';
  // Rolling back after the last step does nothing: that side has no action.
  const startCount = actions.endOfHistory === 'last' ? 0 : 1;
  const counts = { start: startCount, end: canDelete ? 2 : 1 };
  const shown = offset ?? restOffset(open, counts);
  const rollbackLabel =
    actions.endOfHistory === 'marker'
      ? 'Resume full history'
      : `Roll back to ${feature.name}`;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || renaming) return;
    if ((event.target as Element).closest('.compact-row-grip')) return;
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      base: restOffset(open, counts),
      swiping: false
    };
    swallowClick.current = false;
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = gesture.current;
    if (!press || press.pointerId !== event.pointerId) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (!press.swiping) {
      if (!isSwipe(dx, dy)) return;
      press.swiping = true;
      swallowClick.current = true;
      capture(event);
    }
    setOffset(swipeOffset(press.base, dx, counts));
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = gesture.current;
    if (!press || press.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (!press.swiping) return;
    const rest =
      event.type === 'pointercancel'
        ? open
        : swipeRest(swipeOffset(press.base, event.clientX - press.x, counts));
    setOffset(null);
    onOpen(rest);
  };

  const onGripDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || reorderBusy) return;
    grip.current = {
      pointerId: event.pointerId,
      y: event.clientY,
      midpoints: midpoints()
    };
    capture(event);
  };
  const onGripMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const press = grip.current;
    if (!press || press.pointerId !== event.pointerId) return;
    onDrag(event.clientY - press.y);
  };
  const onGripUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const press = grip.current;
    if (!press || press.pointerId !== event.pointerId) return;
    grip.current = null;
    onDrag(null);
    if (event.type === 'pointercancel') return;
    const target = reorderTarget(
      press.midpoints,
      index,
      event.clientY - press.y
    );
    if (target !== index) onReorder(target);
  };
  const onGripKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step =
      event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (step === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = index + step;
    if (reorderBusy || target < 0 || target > lastIndex) return;
    onReorder(target);
  };

  const revealed = (side: SwipeSide) => open === side || (offset ?? 0) !== 0;

  return (
    <li
      className={`compact-row${selected ? ' is-selected' : ''}${
        status ? ` is-${status}` : ''
      }${dragDy !== null ? ' is-dragging' : ''}`}
      data-history-row=""
      data-node-id={feature.id}
      style={
        dragDy !== null ? { transform: `translateY(${dragDy}px)` } : undefined
      }
      onContextMenu={(event) => {
        event.preventDefault();
        closeOpen();
        onMenu(event);
      }}
    >
      {startCount > 0 ? (
        <div
          className="compact-row-actions is-start"
          aria-hidden={!revealed('start') || undefined}
        >
          <button
            type="button"
            className="compact-row-action is-rollback"
            aria-label={rollbackLabel}
            tabIndex={open === 'start' ? 0 : -1}
            onClick={onRollBack}
          >
            <History size={20} aria-hidden="true" />
            <span className="compact-row-action-label">
              {actions.endOfHistory === 'marker' ? 'Resume' : 'Roll back'}
            </span>
          </button>
        </div>
      ) : null}
      <div
        className="compact-row-actions is-end"
        aria-hidden={!revealed('end') || undefined}
      >
        <button
          type="button"
          className="compact-row-action is-suppress"
          aria-label={`${suppressed ? 'Resume' : 'Suppress'} ${feature.name}`}
          tabIndex={open === 'end' ? 0 : -1}
          onClick={onSuppress}
        >
          {suppressed ? (
            <CirclePlay size={20} aria-hidden="true" />
          ) : (
            <CirclePause size={20} aria-hidden="true" />
          )}
          <span className="compact-row-action-label">
            {suppressed ? 'Resume' : 'Suppress'}
          </span>
        </button>
        {canDelete ? (
          <button
            type="button"
            className="compact-row-action is-delete"
            aria-label={`Delete ${feature.name}`}
            tabIndex={open === 'end' ? 0 : -1}
            onClick={onDelete}
          >
            <Trash2 size={20} aria-hidden="true" />
            <span className="compact-row-action-label">Delete</span>
          </button>
        ) : null}
      </div>
      <div
        className={`compact-row-face${offset !== null ? ' is-swiping' : ''}`}
        style={
          shown !== 0 ? { transform: `translateX(${shown}px)` } : undefined
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <button
          type="button"
          className="compact-row-grip"
          aria-label={`Reorder ${feature.name}. Use the arrow keys to move it.`}
          aria-disabled={reorderBusy || undefined}
          title={
            reorderBusy
              ? 'Reorder once the current rebuild finishes'
              : 'Drag to reorder'
          }
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
          onKeyDown={onGripKey}
        >
          <GripVertical size={18} aria-hidden="true" />
        </button>
        {renaming ? (
          <RenameField
            name={feature.name}
            onCommit={onRename}
            onDone={onRenameDone}
          />
        ) : (
          <button
            type="button"
            className="compact-row-main"
            aria-current={selected || undefined}
            onClick={() => {
              if (swallowClick.current) {
                swallowClick.current = false;
                return;
              }
              // A tap elsewhere puts an open row's actions away first.
              if (anyOpen) {
                closeOpen();
                return;
              }
              onEdit();
            }}
          >
            <span className="compact-row-icon" aria-hidden="true">
              {featureIcon(feature)}
            </span>
            <span className="compact-row-text">
              <span className="compact-row-name">{feature.name}</span>
              {status ? (
                <span className="visually-hidden">
                  , {STATUS_WORDS[status]}
                </span>
              ) : null}
            </span>
            {value ? (
              <span className="compact-row-value mono">{value}</span>
            ) : null}
            {status === 'failed' ? (
              <AlertTriangle
                className="compact-row-alert"
                size={18}
                aria-hidden="true"
              />
            ) : null}
            {refusal && !refusal.onReopen ? (
              <span
                className="compact-row-refused"
                role="status"
                title={`${refusal.title} not applied: ${refusal.message}`}
              >
                <AlertTriangle size={16} aria-hidden="true" />
                <span>edit not applied</span>
              </span>
            ) : null}
          </button>
        )}
        {refusal?.onReopen && !renaming ? (
          // Beside the row's button, as in the regular History: the row
          // still opens the step, and this brings back the refused edit.
          <button
            type="button"
            className="compact-row-refused is-reopen"
            data-own-enter=""
            title={`${refusal.title} not applied: ${refusal.message} Reopen the edit to see why and choose what to do.`}
            aria-label={`${refusal.title}, edit not applied. Reopen it`}
            onClick={refusal.onReopen}
          >
            <AlertTriangle size={16} aria-hidden="true" />
            <span>edit not applied</span>
          </button>
        ) : null}
        <button
          type="button"
          className="compact-icon-button compact-row-more"
          aria-label={`More actions for ${feature.name}`}
          aria-haspopup="menu"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            closeOpen();
            onMenu({ clientX: box.left, clientY: box.bottom });
          }}
        >
          <MoreHorizontal size={20} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

/**
 * A step that is not in History: a new one refused (a tap reopens it, with
 * the value tried and why it was refused) or one still being made.
 */
function PendingStepRow({ step }: { step: PendingHistoryStep }) {
  return (
    <li className="compact-row-marker is-pending">
      {step.onReopen ? (
        <button
          type="button"
          className="compact-menu-row"
          data-own-enter=""
          title={`${step.message} Reopen the edit to see why and choose what to do.`}
          aria-label={`${step.title}, not built. Reopen it`}
          onClick={step.onReopen}
        >
          <span className="compact-menu-icon" aria-hidden="true">
            <AlertTriangle size={20} />
          </span>
          <span className="compact-menu-label">{step.title}</span>
          <span className="compact-row-pending-state">not built</span>
        </button>
      ) : (
        <div className="compact-menu-row" role="status" title={step.message}>
          <span className="compact-menu-icon" aria-hidden="true">
            <AlertTriangle size={20} />
          </span>
          <span className="compact-menu-label">{step.title}</span>
          <span className="compact-row-pending-state">not built</span>
        </div>
      )}
    </li>
  );
}

/** The row's name as a field, for Rename from its menu. */
function RenameField({
  name,
  onCommit,
  onDone
}: {
  name: string;
  onCommit(name: string): void;
  onDone(): void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settled = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const finish = (keep: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = inputRef.current?.value.trim() ?? '';
    if (keep && next && next !== name) onCommit(next);
    onDone();
  };
  return (
    <input
      ref={inputRef}
      type="text"
      className="compact-row-rename"
      defaultValue={name}
      aria-label={`Rename ${name}`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(event.key === 'Enter');
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}
