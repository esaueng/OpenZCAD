import {
  Fragment,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref
} from 'react';
import {
  beginDrag,
  clampFloatRect,
  closePanel,
  columnMinimum,
  computePanelGeometry,
  defaultFloatRect,
  DROP_SUPPRESSED,
  FLOAT_MAX_WIDTH,
  FLOAT_MIN_HEIGHT,
  FLOAT_MIN_WIDTH,
  findPanel,
  finishDrag,
  gapRange,
  hitTest,
  isDragStart,
  isPanelOpen,
  moveFloat,
  movePanelInStack,
  notePanelUsed,
  PANEL_MAX_COLUMNS,
  PANEL_PHONE_MAX_WIDTH,
  PANEL_SLOT,
  placePanel,
  popOutPanel,
  popOutRect,
  previewLayout,
  resizeColumn,
  resizeFloat,
  resizeGap,
  splitGapEvenly,
  unpinPanel,
  wouldExceedCap,
  type ColumnGeometry,
  type DockSide,
  type GapGeometry,
  type PanelEntry,
  type PanelGeometry,
  type PanelId,
  type PanelLayout,
  type PanelLayoutPreview,
  type PanelStage,
  type PanelTarget,
  type Point,
  type Rect,
  unpinnedSlotReserves
} from '../../lib/panelLayout';
import type { ContextMenuItem } from '../ContextMenu';
import type { PanelDockControls, PanelPlacement } from './PanelFrame';
import { PANEL_ICONS, PANEL_TITLES } from './panelMeta';

/** What the App asks of the dock outside it: a drag out of a rail button. */
export interface PanelDockHandle {
  /** A press on a panel's rail button; past 4px it drags the panel out. */
  pressRail(id: PanelId, event: ReactPointerEvent<HTMLElement>): void;
}

export interface PanelDockProps {
  layout: PanelLayout;
  /**
   * A sketch or a drag has the stage (and nothing released it): no panel
   * draws, and the dock gives its width back to the rails and the lanes.
   */
  hidden: boolean;
  /** The stage the dock measured, whenever it changes size. */
  onStage(stage: PanelStage): void;
  /**
   * A drop, a move, a gap or window resize, committed once at the end of the
   * gesture or on each key.
   */
  onLayout(next: PanelLayout): void;
  /** A move the layout refused, for the status line. */
  onRefuse(message: string): void;
  renderPanel(
    id: PanelId,
    placement: PanelPlacement,
    dock?: PanelDockControls
  ): ReactNode;
  handleRef?: Ref<PanelDockHandle>;
}

/** Equal sizes and insets are the same stage: no re-render for a no-op. */
function sameStage(a: PanelStage | null, b: PanelStage): boolean {
  return (
    a !== null &&
    a.width === b.width &&
    a.height === b.height &&
    a.insets?.top === b.insets?.top &&
    a.insets?.bottom === b.insets?.bottom &&
    a.insets?.gap === b.insets?.gap &&
    a.insets?.between === b.insets?.between &&
    a.insets?.rail === b.insets?.rail
  );
}

function pixels(value: string, fallback: number): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

const FULL_DOCKS = 'The docks are full at this width.';
const LOCKED = 'Unlock the layout to change it';
const LOCKED_STATUS =
  'The layout is locked. Unlock it in View options to move or resize panels.';
/** Keyboard steps for gaps and floating windows, in CSS pixels. */
const KEY_STEP = 10;
/** A float dropped from a column is at most this tall, as Pop out makes it. */
const DROP_FLOAT_MAX_HEIGHT = 440;
/** How far the drag chip sits from the cursor. */
const CHIP_OFFSET = 14;
/** Room the chip needs beside the cursor: the longest title, "Diagnostics". */
const CHIP_ROOM = 160;

const SIDE_NAMES: Readonly<Record<DockSide, string>> = {
  left: 'Left',
  right: 'Right'
};

/** A gap drag, or a floating window moved by its frame or resized. */
interface LocalDrag {
  pointerId: number;
  start: Point;
  last: Point;
  base: PanelLayout;
  apply(base: PanelLayout, dx: number, dy: number): PanelLayout;
  frame: number | null;
  /** Stops watching for the pointer's loss. */
  unwatch(): void;
}

/**
 * Calls `cancel` when a gesture's pointer is lost without a release, so no
 * release may ever come: capture taken from `holder`, the window losing
 * focus (its own blur; focus moving within the page does not reach a
 * non-capturing listener on the window), or the page hidden. Returns the
 * function that stops watching.
 */
function watchPointerLoss(
  holder: Element,
  pointerId: number,
  cancel: () => void
): () => void {
  const lost = (event: Event) => {
    if ((event as PointerEvent).pointerId === pointerId) cancel();
  };
  const hidden = () => {
    if (document.visibilityState === 'hidden') cancel();
  };
  holder.addEventListener('lostpointercapture', lost);
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', hidden);
  return () => {
    holder.removeEventListener('lostpointercapture', lost);
    window.removeEventListener('blur', cancel);
    document.removeEventListener('visibilitychange', hidden);
  };
}

/** A panel dragged from its header or out of its rail button. */
interface PanelDrag {
  id: PanelId;
  pointerId: number;
  fromRail: boolean;
  /** The layer's corner on screen: every point below is in its coordinates. */
  origin: Point;
  start: Point;
  last: Point;
  /** The window a drop on the model floats it in, and where it is held. */
  size: { w: number; h: number };
  grab: Point;
  /** Set once the press moves 4px: the layout then, and with it lifted. */
  base: PanelLayout | null;
  lifted: PanelLayout | null;
  liftedGeometry: PanelGeometry | null;
  target: PanelTarget | typeof DROP_SUPPRESSED | null;
  frame: number | null;
  stop(): void;
}

/** What a drag shows: the chip, and the layout with the landing slot. */
interface DragView {
  id: PanelId;
  point: Point;
  shown: PanelLayoutPreview;
  /** Over a target the layout refuses (past the cap). */
  refused: boolean;
}

function titlesOf(entries: readonly PanelEntry[]): string {
  return entries
    .filter((entry): entry is PanelId => entry !== PANEL_SLOT)
    .map((entry) => PANEL_TITLES[entry])
    .join(', ');
}

/**
 * Both docks: their columns against the screen edges, the panels stacked in
 * them and the gaps between, the floating windows, and the unpinned panel
 * beside the right rail's inner edge. The layer it draws in spans the whole
 * viewer area, which is the stage the layout is projected onto: a window
 * may stand anywhere on it, over the top islands too, while the docks keep
 * to the band its padding leaves (under the top islands, down to the
 * window's foot). The cube, the ruler and the readout sit at the docks'
 * inner edges (CSS), so none is ever under a docked panel.
 *
 * Every gesture runs here on local state and commits once — a drop, the end
 * of a gap or window resize — so neither the App nor the viewer re-renders
 * while a pointer moves. A dragged panel lifts out of the layout (its column
 * keeps its place), shrinks to a chip beside the cursor and previews its
 * landing slot; hit-testing reads the lifted layout, never the preview. The
 * rail sliding over for a new column is the dock widths changing, which are
 * custom properties on `.workspace` rather than App state. Panel elements
 * are reused while the App has not re-rendered, so a drag frame re-renders
 * no panel body. At a phone-width stage nothing draws here: the App shows
 * one panel in the phone lane instead.
 *
 * The docks' widths (`--left-dock-w`, `--right-dock-w`) and the unpinned
 * panel's (`--right-peek-w`) are published on `.workspace`, where the rails,
 * the lanes and the stage's other islands read them.
 */
export function PanelDock({
  layout,
  hidden,
  onStage,
  onLayout,
  onRefuse,
  renderPanel,
  handleRef
}: PanelDockProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [measured, setStage] = useState<PanelStage | null>(null);
  /** Each docked panel's natural height, which it hugs (PanelFrame). */
  const [naturals, setNaturals] = useState<Partial<Record<PanelId, number>>>(
    {}
  );
  const reportNatural = useRef((id: PanelId, height: number) => {
    setNaturals((current) =>
      current[id] === height ? current : { ...current, [id]: height }
    );
  }).current;
  // The stage every projection here reads; the App gets the measured one,
  // which a panel's content changing never touches.
  const stage = useMemo(
    () => (measured ? { ...measured, naturals } : null),
    [measured, naturals]
  );
  const [localLayout, setLocalLayout] = useState<PanelLayout | null>(null);
  const [dragView, setDragView] = useState<DragView | null>(null);
  /** The lane's card width (`--context-w`) the unpinned slot must leave. */
  const [laneMin, setLaneMin] = useState(330);
  const localRef = useRef<LocalDrag | null>(null);
  const dragRef = useRef<PanelDrag | null>(null);
  /** A panel whose grip takes focus once it is drawn in its new place. */
  const pendingFocusRef = useRef<PanelId | null>(null);
  // The handlers below outlive the render that made them: a drag reads the
  // layout and the stage as they are when it moves or ends.
  const latest = useRef({ layout, stage, hidden, onLayout, onRefuse });
  latest.current = { layout, stage, hidden, onLayout, onRefuse };
  const onStageRef = useRef(onStage);
  onStageRef.current = onStage;

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const measure = () => {
      const rect = layer.getBoundingClientRect();
      const style = getComputedStyle(layer);
      const next: PanelStage = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        // The layer spans the viewer area, where a window may go anywhere;
        // its padding is the band the docks stand in.
        insets: {
          top: pixels(style.paddingTop, 0),
          bottom: pixels(style.paddingBottom, 0),
          gap: pixels(style.getPropertyValue('--island-gap'), 10),
          between: pixels(style.getPropertyValue('--dock-gap'), 4),
          rail: pixels(style.getPropertyValue('--rail-w'), 40)
        }
      };
      setStage((current) => (sameStage(current, next) ? current : next));
      setLaneMin(pixels(style.getPropertyValue('--context-w'), 330));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (measured) onStageRef.current(measured);
  }, [measured]);

  const shown: PanelLayoutPreview = dragView?.shown ?? localLayout ?? layout;
  // A drag's landing slot hugs what the dragged panel will: the preview is
  // drawn as the drop will be, not taller.
  const shownStage =
    stage && dragView && stage.naturals?.[dragView.id] !== undefined
      ? {
          ...stage,
          naturals: {
            ...stage.naturals,
            [PANEL_SLOT]: stage.naturals[dragView.id]
          }
        }
      : stage;
  const geometry =
    shownStage && !hidden ? computePanelGeometry(shown, shownStage) : null;
  const docked = geometry && !geometry.phone ? geometry : null;
  // The unpinned panel's width stays what it was while a panel is dragged:
  // lifting the unpinned panel out must not slide the right lane over.
  const resting =
    stage && !hidden && dragView ? computePanelGeometry(layout, stage) : docked;
  const restingSlot = resting
    ? Object.values(resting.panels).find(
        (rect) => rect && (rect.mode === 'unpinned' || rect.mode === 'revealed')
      )
    : undefined;
  const slot = docked
    ? Object.values(docked.panels).find(
        (rect) => rect && (rect.mode === 'unpinned' || rect.mode === 'revealed')
      )
    : undefined;
  const leftWidth = docked ? docked.dockWidth.left : 0;
  const rightWidth = docked ? docked.dockWidth.right : 0;
  const slotWidth =
    resting && !resting.phone && restingSlot
      ? resting.columnWidth + resting.insets.gap
      : 0;
  // Judged against the resting docks, both of them: the lane keeps its card
  // width between the left dock and the slot, or the slot covers it.
  const peekWidth =
    stage &&
    resting &&
    slotWidth > 0 &&
    unpinnedSlotReserves(
      stage,
      resting.dockWidth.right,
      slotWidth,
      laneMin,
      resting.dockWidth.left
    )
      ? slotWidth
      : 0;

  useLayoutEffect(() => {
    const workspace = layerRef.current?.closest<HTMLElement>('.workspace');
    workspace?.style.setProperty('--left-dock-w', `${leftWidth}px`);
    workspace?.style.setProperty('--right-dock-w', `${rightWidth}px`);
    workspace?.style.setProperty('--right-peek-w', `${peekWidth}px`);
  }, [leftWidth, rightWidth, peekWidth]);

  useLayoutEffect(() => {
    const workspace = layerRef.current?.closest<HTMLElement>('.workspace');
    return () => {
      workspace?.style.removeProperty('--left-dock-w');
      workspace?.style.removeProperty('--right-dock-w');
      workspace?.style.removeProperty('--right-peek-w');
    };
  }, []);

  // A keyboard move redraws the panel elsewhere; its grip keeps the focus.
  useLayoutEffect(() => {
    const id = pendingFocusRef.current;
    if (!id) return;
    const grip = layerRef.current?.querySelector<HTMLElement>(
      `[data-panel="${id}"] .model-panel-grip`
    );
    if (grip) {
      pendingFocusRef.current = null;
      if (document.activeElement !== grip) grip.focus({ preventScroll: true });
    }
  });

  useEffect(
    () => () => {
      const local = localRef.current;
      if (local?.frame != null) cancelAnimationFrame(local.frame);
      local?.unwatch();
      dragRef.current?.stop();
    },
    []
  );

  /** Commits a keyboard or menu move, or says why it was refused. */
  const commit = (
    current: PanelLayout,
    next: PanelLayout,
    focus: PanelId | null,
    refusal: string | null = null
  ) => {
    if (next === current) {
      if (refusal) latest.current.onRefuse(refusal);
      return;
    }
    pendingFocusRef.current = focus;
    latest.current.onLayout(next);
  };

  // ── Gap and window gestures ───────────────────────────────

  const startLocal = (
    event: ReactPointerEvent<HTMLElement>,
    apply: LocalDrag['apply']
  ) => {
    if (event.button !== 0 || localRef.current || dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    const local: LocalDrag = {
      pointerId: event.pointerId,
      start: point,
      last: point,
      base: layout,
      apply,
      frame: null,
      unwatch: () => {}
    };
    // Lost without a release, the gesture is cancelled: left standing, it
    // refused every later gesture and a stray release committed it.
    local.unwatch = watchPointerLoss(event.currentTarget, event.pointerId, () =>
      stopLocal(local, null)
    );
    localRef.current = local;
  };

  const applied = (local: LocalDrag, point: Point) =>
    // Measured from the gesture's start against its starting layout, so a
    // long drag never accumulates rounding.
    local.apply(local.base, point.x - local.start.x, point.y - local.start.y);

  const moveLocal = (event: ReactPointerEvent<HTMLElement>) => {
    const local = localRef.current;
    if (!local || local.pointerId !== event.pointerId) return;
    local.last = { x: event.clientX, y: event.clientY };
    if (local.frame === null) {
      local.frame = requestAnimationFrame(() => {
        local.frame = null;
        if (localRef.current === local) {
          setLocalLayout(applied(local, local.last));
        }
      });
    }
  };

  /** Ends a gesture, committing it at `release` or, without one, not at all. */
  const stopLocal = (local: LocalDrag, release: Point | null) => {
    if (localRef.current !== local) return;
    if (local.frame !== null) cancelAnimationFrame(local.frame);
    local.unwatch();
    localRef.current = null;
    setLocalLayout(null);
    if (release) {
      const next = applied(local, release);
      if (next !== local.base) latest.current.onLayout(next);
    }
  };

  const endLocal = (event: ReactPointerEvent<HTMLElement>, keep: boolean) => {
    const local = localRef.current;
    if (!local || local.pointerId !== event.pointerId) return;
    stopLocal(local, keep ? { x: event.clientX, y: event.clientY } : null);
  };

  const localHandlers = {
    onPointerMove: moveLocal,
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) =>
      endLocal(event, true),
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) =>
      endLocal(event, false)
  };

  const gapKey = (event: ReactKeyboardEvent<HTMLElement>, gap: GapGeometry) => {
    if (!gap.enabled || layout.options.locked) return;
    let next: PanelLayout | null = null;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      next = resizeGap(
        layout,
        gap.above,
        gap.below,
        event.key === 'ArrowUp' ? -KEY_STEP : KEY_STEP,
        gap.pxPerWeight,
        gap.shown
      );
    } else if (event.key === 'Home') {
      next = splitGapEvenly(
        layout,
        gap.above,
        gap.below,
        gap.pxPerWeight,
        gap.shown
      );
    }
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (next !== layout) onLayout(next);
  };

  /**
   * A docked column's foot: where it is drawn, the dock's height, and the
   * panels whose column height it sets (none while a drop preview or the
   * lock leaves nothing to resize).
   */
  const columnFoot = (column: ColumnGeometry) => {
    const dockHeight = docked!.dock.bottom - docked!.dock.top;
    // A column whose panels all hug their content ends where they do.
    const drawn = column.overflowing
      ? column.h
      : Math.min(column.h, column.contentHeight);
    const panels = column.panels.filter(
      (entry): entry is PanelId => entry !== PANEL_SLOT
    );
    // Off while the stack scrolls: its minimums overflow the dock, so
    // there is nothing to shorten.
    const enabled =
      !layout.options.locked &&
      !column.overflowing &&
      panels.length > 0 &&
      panels.length === column.panels.length;
    return { dockHeight, drawn, panels, enabled };
  };

  const footKey = (
    event: ReactKeyboardEvent<HTMLElement>,
    column: ColumnGeometry
  ) => {
    const { dockHeight, drawn, panels, enabled } = columnFoot(column);
    if (!enabled) return;
    const height =
      event.key === 'ArrowUp'
        ? drawn - KEY_STEP
        : event.key === 'ArrowDown'
          ? drawn + KEY_STEP
          : event.key === 'End'
            ? dockHeight
            : null;
    if (height === null) return;
    event.preventDefault();
    event.stopPropagation();
    // A step is exact: no snap, so a step up from a full column shortens it.
    const next = resizeColumn(layout, panels, height, dockHeight, 0);
    if (next !== layout) onLayout(next);
  };

  /** Moves or resizes a floating window by a keyboard step. */
  const nudgeWindow = (
    groupId: string,
    dx: number,
    dy: number,
    resize: boolean
  ) => {
    const { layout: current, stage: on } = latest.current;
    const group = current.floats.find((candidate) => candidate.id === groupId);
    if (!on || !group) return;
    const rect = clampFloatRect(group, on);
    const next = resize
      ? resizeFloat(current, groupId, { w: rect.w + dx, h: rect.h + dy }, on)
      : moveFloat(current, groupId, { x: rect.x + dx, y: rect.y + dy }, on);
    commit(current, next, null);
  };

  const arrowStep = (key: string): Point | null =>
    key === 'ArrowLeft'
      ? { x: -KEY_STEP, y: 0 }
      : key === 'ArrowRight'
        ? { x: KEY_STEP, y: 0 }
        : key === 'ArrowUp'
          ? { x: 0, y: -KEY_STEP }
          : key === 'ArrowDown'
            ? { x: 0, y: KEY_STEP }
            : null;

  // ── Panel drags ───────────────────────────────────────────

  const press = (
    id: PanelId,
    event: ReactPointerEvent<HTMLElement>,
    fromRail: boolean
  ) => {
    const { layout: current, stage: on, hidden: off } = latest.current;
    const layer = layerRef.current;
    if (
      event.button !== 0 ||
      off ||
      !on ||
      !layer ||
      on.width <= PANEL_PHONE_MAX_WIDTH ||
      current.options.locked ||
      dragRef.current ||
      localRef.current
    ) {
      return;
    }
    const bounds = layer.getBoundingClientRect();
    const origin = { x: bounds.left, y: bounds.top };
    const start = { x: event.clientX - origin.x, y: event.clientY - origin.y };
    const resting = computePanelGeometry(current, on);
    const from = resting.panels[id];
    const own = current.floats.find((group) => group.panels.includes(id));
    let size: { w: number; h: number };
    if (own && own.panels.length === 1) {
      // Alone in a window: a drop on the model moves the window as it is.
      const rect = clampFloatRect(own, on);
      size = { w: rect.w, h: rect.h };
    } else if (from && !fromRail) {
      size = {
        w: clamp(from.w, FLOAT_MIN_WIDTH, FLOAT_MAX_WIDTH),
        h: clamp(from.h, FLOAT_MIN_HEIGHT, DROP_FLOAT_MAX_HEIGHT)
      };
    } else {
      const rect = defaultFloatRect(current, on);
      size = { w: rect.w, h: rect.h };
    }
    // Held where it was taken: a drop on the model leaves the grabbed point
    // of the header under the cursor.
    const grab =
      from && !fromRail
        ? {
            x: clamp(start.x - from.x, 0, size.w),
            y: clamp(start.y - from.y, 0, 32)
          }
        : { x: size.w / 2, y: 16 };
    if (!fromRail && !(event.target as Element).closest('button')) {
      // No text selection while the header is dragged.
      event.preventDefault();
    }

    const drag: PanelDrag = {
      id,
      pointerId: event.pointerId,
      fromRail,
      origin,
      start,
      last: start,
      size,
      grab,
      base: null,
      lifted: null,
      liftedGeometry: null,
      target: null,
      frame: null,
      stop: () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onCancel, true);
        window.removeEventListener('keydown', onKey, true);
        unwatch();
        if (layer.hasPointerCapture?.(drag.pointerId)) {
          layer.releasePointerCapture(drag.pointerId);
        }
        if (drag.frame !== null) cancelAnimationFrame(drag.frame);
        drag.frame = null;
      }
    };

    const targetAt = (point: Point) => {
      const raw = hitTest(drag.liftedGeometry!, point, {
        fromRail,
        startPoint: drag.start,
        current: typeof drag.target === 'object' ? drag.target : null
      });
      if (raw === DROP_SUPPRESSED) return raw;
      return (
        raw ?? {
          kind: 'float' as const,
          rect: {
            x: point.x - drag.grab.x,
            y: point.y - drag.grab.y,
            ...drag.size
          }
        }
      );
    };

    const show = () => {
      drag.frame = null;
      if (dragRef.current !== drag || !drag.base) return;
      const stageNow = latest.current.stage;
      if (!stageNow) return;
      drag.target = targetAt(drag.last);
      const preview =
        drag.target === DROP_SUPPRESSED
          ? null
          : previewLayout(drag.base, id, drag.target, stageNow);
      setDragView({
        id,
        point: drag.last,
        shown: preview ?? drag.lifted!,
        refused: drag.target !== DROP_SUPPRESSED && preview === null
      });
    };

    const onMove = (pointer: PointerEvent) => {
      if (pointer.pointerId !== drag.pointerId) return;
      drag.last = {
        x: pointer.clientX - drag.origin.x,
        y: pointer.clientY - drag.origin.y
      };
      if (!drag.base) {
        if (!isDragStart(drag.start, drag.last)) return;
        const stageNow = latest.current.stage;
        if (!stageNow) return;
        drag.base = latest.current.layout;
        drag.lifted = beginDrag(drag.base, id);
        drag.liftedGeometry = computePanelGeometry(drag.lifted, stageNow);
        // The layer outlives the header the press began on (lifting the
        // panel unmounts it), so it holds the pointer: a release outside
        // the window still arrives, and losing it cancels the drag.
        try {
          layer.setPointerCapture(drag.pointerId);
        } catch {
          // The pointer is already up: its release ends the drag anyway.
        }
      }
      pointer.preventDefault();
      if (drag.frame === null) drag.frame = requestAnimationFrame(show);
    };

    const end = (keep: boolean) => {
      drag.stop();
      dragRef.current = null;
      if (!drag.base) return;
      setDragView(null);
      // The release ends the drag, not a click: the rail button or the grip
      // under it must not act on it too.
      const swallow = (click: MouseEvent) => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(
        () => window.removeEventListener('click', swallow, true),
        0
      );
      if (!keep) return;
      const { layout: now, stage: stageNow } = latest.current;
      if (!stageNow) return;
      const target = targetAt(drag.last);
      if (target === DROP_SUPPRESSED) return;
      // Placed on the layout as it is now (a press may have made the panel
      // the most recent since), which `previewLayout` showed.
      let next = placePanel(now, id, target, stageNow);
      if (next === now) {
        if (wouldExceedCap(now, id, target, stageNow)) {
          latest.current.onRefuse(FULL_DOCKS);
        }
        // Out of the rail, a refused panel opens where a press would have.
        if (!fromRail || isPanelOpen(now, id)) return;
        next = unpinPanel(now, id);
      }
      latest.current.onLayout(notePanelUsed(next, id));
    };
    const onUp = (pointer: PointerEvent) => {
      if (pointer.pointerId === drag.pointerId) end(true);
    };
    const onCancel = (pointer: PointerEvent) => {
      if (pointer.pointerId === drag.pointerId) end(false);
    };
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== 'Escape' || !drag.base) return;
      key.preventDefault();
      key.stopPropagation();
      end(false);
    };
    // The layer holds the pointer once the drag lifts; losing it cancels.
    const unwatch = watchPointerLoss(layer, drag.pointerId, () => {
      if (dragRef.current === drag) end(false);
    });

    dragRef.current = drag;
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKey, true);
  };

  useImperativeHandle(handleRef, () => ({
    pressRail: (id, event) => press(id, event, true)
  }));

  // ── The Move menu, Pop out and the grip's keys ────────────

  const moveTargets = (
    id: PanelId
  ): Array<{ id: string; label: string; target: PanelTarget }> => {
    const { layout: current, stage: on } = latest.current;
    if (!on) return [];
    const geometry = computePanelGeometry(current, on);
    const location = findPanel(current, id);
    const targets: Array<{ id: string; label: string; target: PanelTarget }> = [
      {
        id: 'dock-left',
        label: 'Dock left',
        target: { kind: 'column', side: 'left', column: 0 }
      },
      {
        id: 'dock-right',
        label: 'Dock right',
        target: { kind: 'column', side: 'right', column: 0 }
      },
      {
        id: 'new-left',
        label: 'New column left',
        target: { kind: 'newColumn', side: 'left' }
      },
      {
        id: 'new-right',
        label: 'New column right',
        target: { kind: 'newColumn', side: 'right' }
      },
      {
        id: 'float',
        label: 'Float',
        target: { kind: 'float', rect: popOutRect(geometry, id) }
      }
    ];
    for (const side of ['right', 'left'] as const) {
      (side === 'right' ? current.right : current.left).forEach(
        (entries, column) => {
          if (
            location?.kind === 'column' &&
            location.side === side &&
            location.column === column
          ) {
            return;
          }
          targets.push({
            id: `to-${side}-${column}`,
            label: `Move to ${SIDE_NAMES[side]} ${column + 1}: ${titlesOf(entries)}`,
            target: { kind: 'column', side, column }
          });
        }
      );
    }
    for (const group of current.floats) {
      if (location?.kind === 'float' && location.groupId === group.id) continue;
      targets.push({
        id: `to-float-${group.id}`,
        label: `Move to Window: ${titlesOf(group.panels)}`,
        target: { kind: 'group', groupId: group.id }
      });
    }
    return targets;
  };

  const moveItems = (id: PanelId): ContextMenuItem[] => {
    const { layout: current, stage: on } = latest.current;
    if (!on) return [];
    const locked = current.options.locked;
    const location = findPanel(current, id);
    // The columns each side would have with the panel lifted out of its own.
    const lifted = finishDrag(beginDrag(current, id));
    const stack =
      location?.kind === 'column'
        ? (location.side === 'right' ? current.right : current.left)[
            location.column
          ]!
        : location?.kind === 'float'
          ? current.floats.find((group) => group.id === location.groupId)!
              .panels
          : null;
    const index = location && location.kind !== 'unpinned' ? location.index : 0;
    const items: ContextMenuItem[] = moveTargets(id).map((entry, k) => {
      const full =
        entry.target.kind === 'newColumn' &&
        (entry.target.side === 'right' ? lifted.right : lifted.left).length >=
          PANEL_MAX_COLUMNS[entry.target.side];
      const refused =
        !locked && !full && wouldExceedCap(current, id, entry.target, on);
      return {
        id: entry.id,
        label: entry.label,
        disabled: locked || full || refused,
        detail: locked
          ? LOCKED
          : full
            ? 'That dock has no room for another column'
            : refused
              ? FULL_DOCKS
              : undefined,
        // The placements, then the columns and windows to move to.
        section: k === 5
      };
    });
    items.push(
      {
        id: 'up',
        label: 'Move up',
        shortcut: 'Alt+↑',
        disabled: locked || !stack || index === 0,
        ...(locked ? { detail: LOCKED } : {}),
        section: true
      },
      {
        id: 'down',
        label: 'Move down',
        shortcut: 'Alt+↓',
        disabled: locked || !stack || index >= stack.length - 1,
        ...(locked ? { detail: LOCKED } : {})
      },
      { id: 'close', label: 'Close', section: true }
    );
    return items;
  };

  const move = (id: PanelId, itemId: string) => {
    const { layout: current, stage: on } = latest.current;
    if (!on) return;
    if (itemId === 'close') {
      latest.current.onLayout(closePanel(current, id));
      return;
    }
    if (itemId === 'up' || itemId === 'down') {
      commit(
        current,
        movePanelInStack(current, id, itemId === 'up' ? -1 : 1, on),
        id
      );
      return;
    }
    const entry = moveTargets(id).find((candidate) => candidate.id === itemId);
    if (!entry) return;
    const next = placePanel(current, id, entry.target, on);
    commit(
      current,
      next === current ? current : notePanelUsed(next, id),
      id,
      FULL_DOCKS
    );
  };

  const gripKey = (
    id: PanelId,
    event: ReactKeyboardEvent<HTMLElement>
  ): boolean => {
    const { layout: current, stage: on } = latest.current;
    if (!on) return false;
    const group = current.floats.find((candidate) =>
      candidate.panels.includes(id)
    );
    const step = arrowStep(event.key);
    const moves =
      (event.altKey &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown')) ||
      (group && step && !event.altKey && !event.ctrlKey && !event.metaKey);
    // The keys are taken, so a locked layout says why nothing moved rather
    // than letting an arrow scroll the panel.
    if (moves && current.options.locked) {
      latest.current.onRefuse(LOCKED_STATUS);
      return true;
    }
    if (
      event.altKey &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      commit(
        current,
        movePanelInStack(current, id, event.key === 'ArrowUp' ? -1 : 1, on),
        id
      );
      return true;
    }
    if (!group || !step || event.altKey || event.ctrlKey || event.metaKey) {
      return false;
    }
    nudgeWindow(group.id, step.x, step.y, event.shiftKey);
    return true;
  };

  const popOut = (id: PanelId) => {
    const { layout: current, stage: on } = latest.current;
    if (!on) return;
    const rect = popOutRect(computePanelGeometry(current, on), id);
    const next = popOutPanel(current, id, rect, on);
    commit(
      current,
      next === current ? current : notePanelUsed(next, id),
      id,
      FULL_DOCKS
    );
  };

  // Panel elements are made again only when the App re-renders with new
  // content (a new `renderPanel`); a drag frame reuses them as they are.
  const elementsRef = useRef(
    new Map<
      string,
      { render: PanelDockProps['renderPanel']; node: ReactNode }
    >()
  );
  const panelElement = (id: PanelId, placement: PanelPlacement) => {
    const key = `${id}:${placement}`;
    const cached = elementsRef.current.get(key);
    if (cached && cached.render === renderPanel) return cached.node;
    const alone = layout.floats.some(
      (group) => group.panels.length === 1 && group.panels[0] === id
    );
    const dock: PanelDockControls = {
      onHeaderPointerDown: (event) => {
        const target = event.target as Element;
        // The header's own buttons act on a press; only the grip and the
        // header's bare surface start a drag.
        if (
          target.closest('button, input, select, textarea, a') &&
          !target.closest('.model-panel-grip')
        ) {
          return;
        }
        press(id, event, false);
      },
      moveItems: () => moveItems(id),
      onMove: (itemId) => move(id, itemId),
      onGripKey: (event) => gripKey(id, event),
      ...(alone ? {} : { onPopOut: () => popOut(id) }),
      ...(placement === 'docked'
        ? { onNaturalHeight: (height: number) => reportNatural(id, height) }
        : {})
    };
    const node = renderPanel(id, placement, dock);
    elementsRef.current.set(key, { render: renderPanel, node });
    return node;
  };

  const renderStack = (
    entries: PanelEntry[],
    container: Rect,
    placement: PanelPlacement,
    isGap: (gap: GapGeometry) => boolean
  ) => (
    <>
      {entries.map((id) => {
        const rect = docked!.panels[id];
        if (!rect) return null;
        if (id === PANEL_SLOT) {
          return (
            <div
              key={PANEL_SLOT}
              className="panel-drop-slot"
              style={{ top: rect.y - container.y, height: rect.h }}
            />
          );
        }
        return (
          <div
            key={id}
            className="panel-slot"
            style={{ top: rect.y - container.y, height: rect.h }}
          >
            {panelElement(id, placement)}
          </div>
        );
      })}
      {docked!.gaps.filter(isGap).map((gap) => {
        // The divider's position as drawn: a panel hugging its content is
        // not where its stored weight would put it. Its range is where a
        // drag can take it (each panel's minimum, and neither past its cap).
        const pair =
          gap.shown !== undefined
            ? gap.shown.above + gap.shown.below
            : shown.weights[gap.above] + shown.weights[gap.below];
        const above = gap.shown?.above ?? shown.weights[gap.above];
        const range = gap.shown ? gapRange(gap.shown) : null;
        const percent = (value: number) =>
          pair > 0 ? Math.round((100 * value) / pair) : 50;
        // Off while the stack scrolls, and while the layout is locked.
        const enabled = gap.enabled && !layout.options.locked;
        return (
          <div
            key={`${gap.above}-${gap.below}`}
            className={`panel-gap${enabled ? '' : ' is-off'}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label={`Resize ${PANEL_TITLES[gap.above]} and ${PANEL_TITLES[gap.below]}`}
            aria-valuemin={range ? percent(Math.min(range.lowest, above)) : 0}
            aria-valuemax={
              range ? percent(Math.max(range.highest, above)) : 100
            }
            aria-valuenow={percent(above)}
            aria-disabled={enabled ? undefined : true}
            tabIndex={enabled ? 0 : -1}
            title={
              enabled
                ? 'Drag to resize · double-click to split evenly'
                : undefined
            }
            style={{ top: gap.y - container.y, height: gap.h }}
            onPointerDown={(event) => {
              if (!enabled) return;
              startLocal(event, (base, _dx, dy) =>
                resizeGap(
                  base,
                  gap.above,
                  gap.below,
                  dy,
                  gap.pxPerWeight,
                  gap.shown
                )
              );
            }}
            {...localHandlers}
            onKeyDown={(event) => gapKey(event, gap)}
            onDoubleClick={() => {
              if (!enabled) return;
              // At the scale the stack is drawn at, as a drag is: split by
              // weight alone, a neighbour held at its minimum redrew every
              // other panel in the stack.
              const next = splitGapEvenly(
                layout,
                gap.above,
                gap.below,
                gap.pxPerWeight,
                gap.shown
              );
              if (next !== layout) onLayout(next);
            }}
          >
            <span className="panel-gap-grip" aria-hidden="true" />
          </div>
        );
      })}
    </>
  );

  const renderColumn = (column: ColumnGeometry) => (
    <div
      className={`panel-column${column.overflowing ? ' is-scrolling' : ''}`}
      data-side={column.side}
      style={{
        left: column.x,
        top: column.y,
        width: column.w,
        height: column.h
      }}
    >
      <div
        className="panel-column-stack"
        style={{ height: column.contentHeight }}
      >
        {renderStack(
          column.panels,
          column,
          'docked',
          (gap) =>
            gap.container.kind === 'column' &&
            gap.container.side === column.side &&
            gap.container.column === column.column
        )}
      </div>
    </div>
  );

  /**
   * The handle under a docked column: drag it up to end the column short,
   * down to the dock's foot (or double-click it) to fill the dock again.
   */
  const renderColumnFoot = (column: ColumnGeometry) => {
    const { dockHeight, drawn, panels, enabled } = columnFoot(column);
    if (panels.length === 0) return null;
    const percent = (value: number) =>
      dockHeight > 0 ? Math.round((100 * value) / dockHeight) : 100;
    const minimum = columnMinimum(panels.length);
    return (
      <div
        className={`panel-column-foot${enabled ? '' : ' is-off'}${
          column.shortened ? ' is-shortened' : ''
        }`}
        role="separator"
        aria-orientation="horizontal"
        aria-label={`Resize the ${titlesOf(panels)} column`}
        aria-valuemin={percent(Math.min(minimum, drawn))}
        aria-valuemax={100}
        aria-valuenow={percent(drawn)}
        aria-disabled={enabled ? undefined : true}
        tabIndex={enabled ? 0 : -1}
        title={
          enabled
            ? column.shortened
              ? 'Drag to resize · double-click to fill the height'
              : 'Drag up to shorten the column'
            : undefined
        }
        style={{
          left: column.x,
          top: column.y + drawn,
          width: column.w
        }}
        onPointerDown={(event) => {
          if (!enabled) return;
          startLocal(event, (base, _dx, dy) =>
            resizeColumn(base, panels, drawn + dy, dockHeight)
          );
        }}
        {...localHandlers}
        onKeyDown={(event) => footKey(event, column)}
        onDoubleClick={() => {
          if (!enabled) return;
          const next = resizeColumn(layout, panels, dockHeight, dockHeight);
          if (next !== layout) onLayout(next);
        }}
      >
        <span className="panel-gap-grip" aria-hidden="true" />
      </div>
    );
  };

  // Windows keep one DOM order and take their stacking from the z-order,
  // so raising one never moves an element that has focus.
  const windows = docked
    ? docked.floats
        .map((group, z) => ({ group, z }))
        .sort((a, b) => (a.group.id < b.group.id ? -1 : 1))
    : [];

  return (
    <div
      className={`panel-dock-layer${dragView ? ' is-dragging' : ''}${
        layout.options.locked ? ' is-locked' : ''
      }${slot && slotWidth > 0 && peekWidth === 0 ? ' slot-over-lane' : ''}`}
      ref={layerRef}
    >
      {docked?.columns.map((column) => (
        <Fragment key={`${column.side}-${column.column}`}>
          {renderColumn(column)}
          {!dragView && renderColumnFoot(column)}
        </Fragment>
      ))}
      {slot && slot.id !== PANEL_SLOT && (
        <div
          className={`panel-unpinned${slot.mode === 'revealed' ? ' is-revealed' : ''}`}
          style={{ width: slot.w }}
        >
          {panelElement(
            slot.id,
            slot.mode === 'revealed' ? 'revealed' : 'unpinned'
          )}
        </div>
      )}
      {windows.map(({ group, z }) => {
        const panels = group.panels.filter((entry) => entry !== PANEL_SLOT);
        const names = panels.map((entry) => PANEL_TITLES[entry]).join(' and ');
        const slotOnly = panels.length === 0;
        return (
          <div
            key={group.id}
            className={`panel-float${slotOnly ? ' is-slot' : ''}`}
            data-float={group.id}
            style={{
              left: group.x,
              top: group.y,
              width: group.w,
              height: group.h,
              zIndex: `calc(var(--z-panel-float) + ${z})`
            }}
          >
            {group.panels.length > 1 && (
              <div
                className="panel-float-grip"
                aria-hidden="true"
                title="Drag to move the window"
                onPointerDown={(event) =>
                  startLocal(event, (base, dx, dy) =>
                    moveFloat(
                      base,
                      group.id,
                      { x: group.x + dx, y: group.y + dy },
                      stage!
                    )
                  )
                }
                {...localHandlers}
              >
                <span className="panel-float-grip-bar" />
              </div>
            )}
            <div
              className={`panel-float-body${group.overflowing ? ' is-scrolling' : ''}`}
            >
              <div
                className="panel-column-stack"
                style={{ height: group.contentHeight }}
              >
                {renderStack(
                  group.panels,
                  group,
                  'floating',
                  (gap) =>
                    gap.container.kind === 'float' &&
                    gap.container.groupId === group.id
                )}
              </div>
            </div>
            {!slotOnly && (
              <button
                type="button"
                className="panel-float-resize"
                aria-label={`Resize ${names} window`}
                // Locked, nothing resizes it: no drag, no keys.
                disabled={layout.options.locked}
                title={
                  layout.options.locked
                    ? LOCKED
                    : 'Drag to resize · arrow keys resize by 10px'
                }
                onPointerDown={(event) =>
                  startLocal(event, (base, dx, dy) =>
                    resizeFloat(
                      base,
                      group.id,
                      { w: group.w + dx, h: group.h + dy },
                      stage!
                    )
                  )
                }
                {...localHandlers}
                onKeyDown={(event) => {
                  const step = arrowStep(event.key);
                  if (!step) return;
                  event.preventDefault();
                  event.stopPropagation();
                  nudgeWindow(group.id, step.x, step.y, true);
                }}
              />
            )}
          </div>
        );
      })}
      {dragView && (
        <>
          {/* Over the model while dragging: the viewer sees no hover, and
              the cursor reads as a drag wherever it goes. */}
          <div className="panel-drag-shield" aria-hidden="true" />
          <DragChip view={dragView} stageWidth={stage?.width ?? 0} />
        </>
      )}
    </div>
  );
}

/** The dragged panel, shrunk to its title beside the cursor. */
function DragChip({
  view,
  stageWidth
}: {
  view: DragView;
  stageWidth: number;
}) {
  const Icon = PANEL_ICONS[view.id];
  // Beside the cursor, on its left where the right edge has no room.
  const right = view.point.x + CHIP_OFFSET + CHIP_ROOM > stageWidth;
  return (
    <div
      className={`panel-drag-chip${view.refused ? ' is-refused' : ''}`}
      aria-hidden="true"
      style={{
        ...(right
          ? { right: stageWidth - view.point.x + CHIP_OFFSET }
          : { left: view.point.x + CHIP_OFFSET }),
        top: view.point.y + CHIP_OFFSET
      }}
    >
      <Icon size={13} aria-hidden="true" />
      <span>{PANEL_TITLES[view.id]}</span>
    </div>
  );
}
