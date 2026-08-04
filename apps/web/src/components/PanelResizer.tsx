import { useCallback, useEffect, useRef, useState } from 'react';

/** Arrow keys nudge; holding shift moves in the strides a drag does. */
const KEYBOARD_STEP = 8;
const KEYBOARD_STEP_COARSE = 32;

interface PanelResizerProps {
  /** Announced to assistive technology and shown as the pointer tooltip. */
  label: string;
  /**
   * Which side of the workspace the panel is docked to. A left-docked panel
   * grows as the pointer moves right; a right-docked one grows as it moves
   * left, so the handle stays under the cursor either way.
   */
  edge: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  /**
   * The width under the pointer, every frame of a drag. The workspace applies
   * it to the layout directly: routing a pointermove through React state would
   * re-render the whole editor — viewport included — sixty times a second.
   */
  onPreview(width: number): void;
  /** The width to keep, once a drag or a key press settles. */
  onCommit(width: number): void;
  /** Double-click restores the shipped width. */
  onReset(): void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
  width: number;
}

/**
 * The draggable seam between a docked panel and the viewport.
 *
 * It is a real splitter rather than a decorative hairline: focusable, movable
 * with the arrow keys, and resettable with a double-click, so the width is
 * reachable without a pointer.
 */
export function PanelResizer({
  label,
  edge,
  width,
  min,
  max,
  onPreview,
  onCommit,
  onReset
}: PanelResizerProps) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);

  const clamp = useCallback(
    (value: number) => Math.round(Math.min(max, Math.max(min, value))),
    [min, max]
  );

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    pendingRef.current = null;
  }, []);

  const schedulePreview = useCallback(
    (next: number) => {
      pendingRef.current = next;
      if (frameRef.current !== null) {
        return;
      }
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending !== null) {
          onPreview(pending);
        }
      });
    },
    [onPreview]
  );

  const finishDrag = useCallback(
    (keep: boolean) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      dragRef.current = null;
      cancelFrame();
      setDragging(false);
      delete globalThis.document.documentElement.dataset.panelResizing;
      // Either way the layout has to end up somewhere definite: the abandoned
      // drag rewinds to where it started, the finished one lands on its result.
      const settled = keep ? drag.width : drag.startWidth;
      onPreview(settled);
      if (keep) {
        onCommit(settled);
      }
    },
    [cancelFrame, onCommit, onPreview]
  );

  // A drag that outlives the handle — the assistant closing mid-drag, a route
  // change — must not leave the document stuck in its resizing cursor.
  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
      delete globalThis.document.documentElement.dataset.panelResizing;
    },
    []
  );

  useEffect(() => {
    if (!dragging) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finishDrag(false);
      }
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [dragging, finishDrag]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || dragRef.current) {
      return;
    }
    // Stops the press from selecting the panel text it starts on.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
      width
    };
    setDragging(true);
    globalThis.document.documentElement.dataset.panelResizing = 'true';
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const travel = event.clientX - drag.startX;
    drag.width = clamp(drag.startWidth + (edge === 'left' ? travel : -travel));
    schedulePreview(drag.width);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    finishDrag(true);
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    finishDrag(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? KEYBOARD_STEP_COARSE : KEYBOARD_STEP;
    const grow = edge === 'left' ? 1 : -1;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = width - step * grow;
        break;
      case 'ArrowRight':
        next = width + step * grow;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    const settled = clamp(next);
    if (settled !== width) {
      onCommit(settled);
    }
  }

  return (
    <div
      className={`panel-resizer ${edge === 'left' ? 'sidebar-resizer' : 'assistant-resizer'}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} — drag, or double-click to reset`}
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  );
}
