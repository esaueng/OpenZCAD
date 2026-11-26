import { ChevronLeft, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import {
  CLOSED_SHEET,
  SHEET_DETENTS,
  SHEET_DETENT_NAMES,
  nearestDetent,
  sheetEscape,
  sheetReducer,
  type SheetAction,
  type SheetDetent,
  type SheetState
} from './sheetState';

/** Holds the sheet's state; `hasRoot` is whether the workspace fills it. */
export function useSheet(hasRoot: boolean) {
  const hasRootRef = useRef(hasRoot);
  hasRootRef.current = hasRoot;
  const [state, dispatch] = useReducer(
    (current: SheetState, action: SheetAction) =>
      sheetReducer(current, action, hasRootRef.current),
    CLOSED_SHEET
  );
  return { state, dispatch };
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest('[hidden], [inert]')
  );
}

interface BottomSheetProps {
  /** The sheet's accessible name. */
  label: string;
  state: SheetState;
  dispatch(action: SheetAction): void;
  /** Whether the workspace's own content (the root page) is in the sheet. */
  hasRoot: boolean;
  /** The root page: what the workspace puts in the sheet. */
  children?: ReactNode;
  /** A cross-fade in place of the spring between heights. */
  reducedMotion?: boolean;
  /**
   * The elements made inert while the sheet stands at full height, so focus
   * and taps stay in the sheet: the stage, the header, the tabs.
   */
  background?(): readonly (Element | null | undefined)[];
  /** The sheet's drawn height in CSS pixels, as it changes. */
  onHeight?(px: number): void;
}

/**
 * The compact workspace's one bottom sheet (U12 slice 2). Peek, half and
 * full heights, reached by dragging the grabber or with its arrow keys; a
 * back stack for drill-in pages; at full a focus trap over an inert stage.
 * Escape steps back or down (`sheetEscape`). The height is announced as it
 * changes.
 */
export function BottomSheet({
  label,
  state,
  dispatch,
  hasRoot,
  children,
  reducedMotion = false,
  background,
  onHeight
}: BottomSheetProps) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const grabberRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    moved: boolean;
  } | null>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  // Alternates on every change of height, so the reduced-motion fade
  // replays each time.
  const [fadeTurn, setFadeTurn] = useState(false);
  const { detent, stack } = state;
  const page = stack.length > 0 ? stack[stack.length - 1]! : null;
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;

  const previousDetent = useRef(detent);
  useEffect(() => {
    if (previousDetent.current !== detent) {
      previousDetent.current = detent;
      setFadeTurn((turn) => !turn);
    }
  }, [detent]);

  // The stage beneath a full sheet takes no focus and no taps.
  useEffect(() => {
    if (detent !== 'full') return;
    const elements = (backgroundRef.current?.() ?? []).filter(
      (element): element is Element => Boolean(element)
    );
    const changed = elements.filter(
      (element) => !element.hasAttribute('inert')
    );
    for (const element of changed) element.setAttribute('inert', '');
    const sheet = sheetRef.current;
    if (sheet && !sheet.contains(document.activeElement)) {
      grabberRef.current?.focus({ preventScroll: true });
    }
    return () => {
      for (const element of changed) element.removeAttribute('inert');
    };
  }, [detent]);

  // Publishes the drawn height for what floats above the sheet.
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const report = () =>
      onHeightRef.current?.(
        detent === 'closed'
          ? 0
          : Math.round(sheet.getBoundingClientRect().height)
      );
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(report);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [detent]);

  const canClose = !hasRoot && stack.length === 0;
  const hostHeight = () =>
    sheetRef.current?.parentElement?.getBoundingClientRect().height ?? 0;

  const onGrabberPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !sheetRef.current) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: sheetRef.current.getBoundingClientRect().height,
      moved: false
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onGrabberPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = drag.startY - event.clientY;
    if (!drag.moved && Math.abs(delta) < 4) return;
    drag.moved = true;
    setDragHeight(
      Math.max(0, Math.min(hostHeight(), drag.startHeight + delta))
    );
  };
  const onGrabberPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.moved) {
      const height = drag.startHeight + (drag.startY - event.clientY);
      setDragHeight(null);
      dispatch({
        type: 'set-detent',
        detent: nearestDetent(height, hostHeight(), canClose)
      });
    } else {
      // A tap toggles between peek and half; from full it comes down.
      dispatch({
        type: 'set-detent',
        detent: detent === 'half' ? 'peek' : 'half'
      });
    }
  };
  const onGrabberPointerCancel = () => {
    dragRef.current = null;
    setDragHeight(null);
  };

  const onGrabberKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = (next: SheetDetent) => {
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: 'set-detent', detent: next });
    };
    switch (event.key) {
      case 'ArrowUp':
      case 'PageUp':
        event.preventDefault();
        event.stopPropagation();
        dispatch({ type: 'step-up' });
        return;
      case 'ArrowDown':
      case 'PageDown':
        // The slider stops at peek; Escape or the close button go further.
        if (detent === 'peek') {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        dispatch({
          type: 'set-detent',
          detent: detent === 'full' ? 'half' : 'peek'
        });
        return;
      case 'Home':
        step('peek');
        return;
      case 'End':
        step('full');
        return;
      case 'Enter':
      case ' ':
        step(detent === 'half' ? 'peek' : 'half');
        return;
    }
  };

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        const next = sheetEscape(state, hasRoot);
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        if (state.stack.length > 0) dispatch({ type: 'pop' });
        else dispatch({ type: 'set-detent', detent: next.detent });
        return;
      }
      // The trap: at full, Tab wraps inside the sheet.
      if (event.key === 'Tab' && detent === 'full' && sheetRef.current) {
        const items = focusables(sheetRef.current);
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = document.activeElement;
        if (
          event.shiftKey &&
          (active === first || !sheetRef.current.contains(active))
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    },
    [detent, dispatch, hasRoot, state]
  );

  const level = SHEET_DETENTS.indexOf(detent as 'peek');
  const style =
    dragHeight !== null ? { height: `${Math.round(dragHeight)}px` } : undefined;
  return (
    <>
      <section
        ref={sheetRef}
        className={`compact-sheet${dragHeight !== null ? ' is-dragging' : ''}${
          reducedMotion ? ' is-reduced-motion' : ''
        }${fadeTurn ? ' fade-a' : ' fade-b'}`}
        data-detent={detent}
        aria-label={label}
        hidden={detent === 'closed'}
        style={style}
        onKeyDown={onKeyDown}
        {...(detent === 'full' ? { role: 'dialog', 'aria-modal': true } : {})}
      >
        <div className="compact-sheet-head">
          {page ? (
            <button
              type="button"
              className="compact-icon-button"
              aria-label="Back"
              onClick={() => dispatch({ type: 'pop' })}
            >
              <ChevronLeft size={22} aria-hidden="true" />
            </button>
          ) : (
            <span className="compact-sheet-head-spacer" aria-hidden="true" />
          )}
          <div
            ref={grabberRef}
            className="compact-sheet-grabber"
            role="slider"
            tabIndex={0}
            aria-label="Sheet height"
            aria-orientation="vertical"
            aria-valuemin={1}
            aria-valuemax={SHEET_DETENTS.length}
            aria-valuenow={Math.max(1, level + 1)}
            aria-valuetext={SHEET_DETENT_NAMES[detent]}
            onPointerDown={onGrabberPointerDown}
            onPointerMove={onGrabberPointerMove}
            onPointerUp={onGrabberPointerUp}
            onPointerCancel={onGrabberPointerCancel}
            onKeyDown={onGrabberKeyDown}
          >
            <span className="compact-sheet-grip" aria-hidden="true" />
            {page ? (
              <h2 className="compact-sheet-title">{page.title}</h2>
            ) : null}
          </div>
          <button
            type="button"
            className="compact-icon-button"
            aria-label="Close sheet"
            onClick={() => dispatch({ type: 'close' })}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {/* The workspace's content stays mounted under a pushed page, so a
          form mid-edit keeps what was typed when the page is popped. */}
        <div className="compact-sheet-body" hidden={page !== null}>
          {children}
        </div>
        {page ? (
          <div className="compact-sheet-body" key={page.key}>
            {page.content}
          </div>
        ) : null}
      </section>
      {/* The height, said once as it changes; outside the sheet so the
        region is in the page before the first announcement. */}
      <span className="visually-hidden" role="status" aria-live="polite">
        {detent === 'closed'
          ? 'Sheet closed'
          : `Sheet ${SHEET_DETENT_NAMES[detent].toLowerCase()}`}
      </span>
    </>
  );
}
