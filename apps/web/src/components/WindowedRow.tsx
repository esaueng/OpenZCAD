import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode
} from 'react';

export const WINDOWED_ROW_THRESHOLD = 64;

interface RowObserver {
  observer: IntersectionObserver;
  listeners: Map<Element, (visible: boolean) => void>;
}
const viewport = {};
const observers = new WeakMap<object, RowObserver>();

function observeRow(element: HTMLElement, change: (visible: boolean) => void) {
  const root = element.closest('.model-panel-body');
  const key = root ?? viewport;
  let state = observers.get(key);
  if (!state) {
    const listeners = new Map<Element, (visible: boolean) => void>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          listeners.get(entry.target)?.(entry.isIntersecting);
      },
      { root, rootMargin: '120px 0px' }
    );
    state = { observer, listeners };
    observers.set(key, state);
  }
  state.listeners.set(element, change);
  state.observer.observe(element);
  return () => {
    state.listeners.delete(element);
    state.observer.unobserve(element);
    if (!state.listeners.size) {
      state.observer.disconnect();
      observers.delete(key);
    }
  };
}

/**
 * Long panels keep every row and its primary keyboard targets in the DOM.
 * Visual details mount near the scrollport, on focus, or while an editor or
 * selection owns the row. Action targets stay mounted for reverse tabbing and
 * assistive technology. The row's existing single-line sizing stays
 * intact, so history offsets, search reveal and native focus scrolling work.
 */
export function WindowedRow({
  enabled,
  pinned = false,
  children,
  onFocusCapture,
  onBlurCapture,
  onDragStartCapture,
  onDragEndCapture,
  draggable,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  enabled: boolean;
  pinned?: boolean;
  children(expanded: boolean): ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [inRange, setInRange] = useState(
    () => !enabled || typeof IntersectionObserver === 'undefined'
  );
  const [focused, setFocused] = useState(false);
  const [menuFocus, setMenuFocus] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const row = ref.current;
    if (!enabled || !row || typeof IntersectionObserver === 'undefined') return;
    return observeRow(row, setInRange);
  }, [enabled]);
  useEffect(() => {
    if (!menuFocus) return;
    const leaveMenu = (event: FocusEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[role="menu"]')
      )
        setMenuFocus(false);
    };
    document.addEventListener('focusin', leaveMenu);
    return () => document.removeEventListener('focusin', leaveMenu);
  }, [menuFocus]);
  const expanded =
    !enabled || inRange || pinned || focused || menuFocus || dragging;
  return (
    <div
      {...props}
      ref={ref}
      draggable={
        expanded ? draggable : draggable === undefined ? undefined : false
      }
      data-row-windowed={expanded ? undefined : ''}
      onFocusCapture={(event) => {
        setFocused(true);
        setMenuFocus(false);
        onFocusCapture?.(event);
      }}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setFocused(false);
          // A portaled context menu returns focus to its trigger when it
          // closes. Retain that trigger if the row scrolls out meanwhile.
          if (
            event.target instanceof Element &&
            event.target.getAttribute('aria-haspopup') === 'menu' &&
            event.relatedTarget instanceof Element &&
            event.relatedTarget.closest('[role="menu"]')
          )
            setMenuFocus(true);
        }
        onBlurCapture?.(event);
      }}
      onDragStartCapture={(event) => {
        setDragging(true);
        onDragStartCapture?.(event);
      }}
      onDragEndCapture={(event) => {
        setDragging(false);
        onDragEndCapture?.(event);
      }}
    >
      {children(expanded)}
    </div>
  );
}
