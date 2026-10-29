import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react';

/** Travel, in CSS pixels, before a press on a tile becomes a drag. */
const DRAG_THRESHOLD_PX = 6;
/** Band at a scroller's top and bottom edge that scrolls while dragging. */
const AUTO_SCROLL_EDGE_PX = 56;
const AUTO_SCROLL_MAX_STEP_PX = 18;
const REFLOW_MS = 160;
const REFLOW_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const REFLOW_ANIMATION_ID = 'tile-reflow';
/** How long a dropped order waits for the saved one before it lets go. */
const SETTLE_TIMEOUT_MS = 2000;
/** Controls inside a tile keep their own press: they never start a drag. */
const NO_DRAG_SELECTOR =
  'button:not([data-tile-drag]), a, input, select, textarea, [role="menu"]';
const DRAGGING_ROOT_CLASS = 'is-tile-dragging';

interface DragSession {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** Where the pointer holds the tile, from its top-left corner. */
  grabX: number;
  grabY: number;
  /** The tile's current translation off its laid-out slot. */
  tx: number;
  ty: number;
  active: boolean;
  initial: string[];
  /** The dropped order still waiting on its save when this drag began. */
  seed: string[] | null;
  order: string[];
  scroller: HTMLElement | null;
  frame: number;
}

export interface TileReorderOptions {
  /** The tiles in their stored order; a drag rearranges this list. */
  ids: string[];
  enabled: boolean;
  tileRefs: RefObject<Map<string, HTMLElement>>;
  /** Whether a tile may take another's place (pinned tiles stay pinned). */
  canSwap(dragged: string, target: string): boolean;
  onCommit(ids: string[]): void;
}

/**
 * Reorders a grid of tiles by pressing anywhere on one and dragging it.
 *
 * Pointer events rather than HTML drag and drop: native drag cannot start
 * from a button in Firefox, and the whole tile is a button. The dragged tile
 * follows the pointer while the others reflow live into the order it would
 * drop into, each easing from where it was; nothing is saved until the
 * pointer lets go, and Escape puts everything back. A press that never
 * travels past the threshold is an ordinary click, and the click that ends a
 * drag is swallowed so the part does not open. Touch keeps its scroll: it
 * never starts a drag.
 */
export function useTileReorder({
  ids,
  enabled,
  tileRefs,
  canSwap,
  onCommit
}: TileReorderOptions) {
  const [order, setOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const session = useRef<DragSession | null>(null);
  const settleTimer = useRef<number | null>(null);
  // Positions before a reflow, so each moved tile can ease from there.
  const before = useRef<Map<string, DOMRect> | null>(null);
  const latest = useRef({ ids, enabled, canSwap, onCommit, order });
  latest.current = { ids, enabled, canSwap, onCommit, order };
  const stop = useRef<(() => void) | null>(null);

  const idsKey = ids.join('\n');
  // A dropped order stands in for the stored one until the save lands.
  useEffect(() => {
    if (!draggingId && order && order.join('\n') === idsKey) {
      clearTimer(settleTimer);
      setOrder(null);
    }
  }, [draggingId, idsKey, order]);

  useEffect(
    () => () => {
      stop.current?.();
      clearTimer(settleTimer);
    },
    []
  );

  useLayoutEffect(() => {
    const current = session.current;
    if (current?.active) {
      followPointer(tileRefs.current.get(current.id), current);
    }
    const previous = before.current;
    before.current = null;
    if (!previous || prefersReducedMotion()) {
      return;
    }
    for (const [id, element] of tileRefs.current) {
      if (id === current?.id || typeof element.animate !== 'function') {
        continue;
      }
      const from = previous.get(id);
      if (!from) {
        continue;
      }
      const to = element.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (dx !== 0 || dy !== 0) {
        element.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
          {
            id: REFLOW_ANIMATION_ID,
            duration: REFLOW_MS,
            easing: REFLOW_EASING
          }
        );
      }
    }
  }, [order, tileRefs]);

  function snapshot() {
    before.current = new Map(
      [...tileRefs.current].map(([id, element]) => [
        id,
        element.getBoundingClientRect()
      ])
    );
  }

  /** A save that never lands must not pin a dropped order forever. */
  function armSettleTimer() {
    clearTimer(settleTimer);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      setOrder(null);
    }, SETTLE_TIMEOUT_MS);
  }

  function follow(current: DragSession) {
    followPointer(tileRefs.current.get(current.id), current);
  }

  /** Moves the dragged tile into the slot of the tile under the pointer. */
  function retarget(current: DragSession) {
    // The dragged tile ignores the pointer while it moves, so this finds what
    // lies beneath it.
    const under = document
      .elementFromPoint(current.x, current.y)
      ?.closest<HTMLElement>('[data-tile-id]');
    const target = under?.dataset.tileId;
    // A tile still easing out of the slot it just gave up is hit where it
    // was, not where it is going; taking it would swap straight back.
    if (
      under
        ?.getAnimations?.()
        .some(
          (animation) =>
            animation.id === REFLOW_ANIMATION_ID &&
            animation.playState === 'running'
        )
    ) {
      return;
    }
    if (
      !target ||
      target === current.id ||
      !latest.current.canSwap(current.id, target)
    ) {
      return;
    }
    const from = current.order.indexOf(current.id);
    const to = current.order.indexOf(target);
    if (from < 0 || to < 0) {
      return;
    }
    const next = [...current.order];
    next.splice(from, 1);
    next.splice(to, 0, current.id);
    current.order = next;
    snapshot();
    setOrder(next);
  }

  function autoScroll(current: DragSession) {
    current.frame = window.requestAnimationFrame(() => autoScroll(current));
    const scroller = current.scroller;
    const top = scroller ? scroller.getBoundingClientRect().top : 0;
    const bottom = scroller
      ? scroller.getBoundingClientRect().bottom
      : window.innerHeight;
    const step =
      current.y < top + AUTO_SCROLL_EDGE_PX
        ? -scrollStep(top + AUTO_SCROLL_EDGE_PX - current.y)
        : current.y > bottom - AUTO_SCROLL_EDGE_PX
          ? scrollStep(current.y - (bottom - AUTO_SCROLL_EDGE_PX))
          : 0;
    if (step === 0) {
      return;
    }
    const target = scroller ?? document.scrollingElement;
    if (!target) {
      return;
    }
    const was = target.scrollTop;
    target.scrollTop += step;
    if (target.scrollTop !== was) {
      follow(current);
      retarget(current);
    }
  }

  function onPointerDown(id: string, event: ReactPointerEvent<HTMLElement>) {
    if (
      !latest.current.enabled ||
      session.current ||
      event.button !== 0 ||
      event.pointerType === 'touch' ||
      !(event.target instanceof Element) ||
      event.target.closest(NO_DRAG_SELECTOR)
    ) {
      return;
    }
    const tile = tileRefs.current.get(id);
    if (!tile) {
      return;
    }
    const box = tile.getBoundingClientRect();
    const current: DragSession = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      grabX: event.clientX - box.left,
      grabY: event.clientY - box.top,
      tx: 0,
      ty: 0,
      active: false,
      // A drop whose save has not landed is what the shelf shows, so the
      // next drag starts from it rather than snapping back to the stored
      // order (and undoing the first move when it commits).
      initial: latest.current.order ?? latest.current.ids,
      order: latest.current.order ?? latest.current.ids,
      seed: latest.current.order,
      scroller: scrollParent(tile),
      frame: 0
    };
    session.current = current;

    const finish = (commit: boolean) => {
      stop.current?.();
      if (!current.active) {
        return;
      }
      const tile = tileRefs.current.get(current.id);
      if (tile) {
        const from = tile.style.transform;
        tile.style.transform = '';
        if (
          from &&
          !prefersReducedMotion() &&
          typeof tile.animate === 'function'
        ) {
          tile.animate([{ transform: from }, { transform: 'none' }], {
            duration: REFLOW_MS,
            easing: REFLOW_EASING
          });
        }
      }
      // The click that ends a drag lands on whatever is under the pointer;
      // it must not open a part.
      const swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopPropagation();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(
        () => window.removeEventListener('click', swallow, { capture: true }),
        0
      );
      setDraggingId(null);
      const changed = current.order.join('\n') !== current.initial.join('\n');
      if (commit && changed) {
        latest.current.onCommit(current.order);
        armSettleTimer();
      } else {
        if (changed) {
          snapshot();
        }
        // Back to what the shelf showed before: the stored order, or a drop
        // still waiting on its save.
        setOrder(current.seed);
        if (current.seed) {
          armSettleTimer();
        }
      }
    };

    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== current.pointerId) {
        return;
      }
      current.x = pointer.clientX;
      current.y = pointer.clientY;
      if (!current.active) {
        if (
          Math.hypot(current.x - current.startX, current.y - current.startY) <
          DRAG_THRESHOLD_PX
        ) {
          return;
        }
        current.active = true;
        // A drop still waiting on its save must not let go of this drag's
        // preview when its fallback fires.
        clearTimer(settleTimer);
        // Captured at the root, so a release outside the window (over the
        // browser's chrome, or another app) still ends the drag. The root,
        // not the tile: the tile ignores the pointer and moves in the DOM.
        try {
          document.documentElement.setPointerCapture(current.pointerId);
        } catch {
          // A pointer already gone ends the drag through pointercancel.
        }
        document.getSelection()?.removeAllRanges();
        document.documentElement.classList.add(DRAGGING_ROOT_CLASS);
        setDraggingId(current.id);
        setOrder(current.order);
        autoScroll(current);
      }
      follow(current);
      retarget(current);
    };
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId === current.pointerId) {
        finish(true);
      }
    };
    const cancel = () => finish(false);
    const key = (keyboard: KeyboardEvent) => {
      if (keyboard.key === 'Escape' && current.active) {
        keyboard.preventDefault();
        keyboard.stopPropagation();
        finish(false);
      }
    };

    stop.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, { capture: true });
      window.removeEventListener('blur', cancel);
      window.cancelAnimationFrame(current.frame);
      if (document.documentElement.hasPointerCapture?.(current.pointerId)) {
        document.documentElement.releasePointerCapture(current.pointerId);
      }
      document.documentElement.classList.remove(DRAGGING_ROOT_CLASS);
      session.current = null;
      stop.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, { capture: true });
    window.addEventListener('blur', cancel);
  }

  return { order, draggingId, onPointerDown };
}

/** Keeps the dragged tile under the pointer, wherever its slot now is. */
function followPointer(tile: HTMLElement | undefined, current: DragSession) {
  if (!tile) {
    return;
  }
  const box = tile.getBoundingClientRect();
  const slotLeft = box.left - current.tx;
  const slotTop = box.top - current.ty;
  current.tx = current.x - current.grabX - slotLeft;
  current.ty = current.y - current.grabY - slotTop;
  tile.style.transform = `translate(${current.tx}px, ${current.ty}px)`;
}

/** Disarms a timeout held in a ref, such as a dropped order's fallback. */
function clearTimer(timer: { current: number | null }) {
  if (timer.current !== null) {
    window.clearTimeout(timer.current);
    timer.current = null;
  }
}

function scrollStep(depth: number): number {
  return Math.min(AUTO_SCROLL_MAX_STEP_PX, Math.max(2, Math.ceil(depth / 3)));
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (
    let node = element.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
  }
  return null;
}

function prefersReducedMotion(): boolean {
  return (
    document.documentElement.dataset.reducedMotion === 'true' ||
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}
