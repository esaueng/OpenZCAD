import { X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useDelayedUnmount } from '../hooks/useDelayedUnmount';
import {
  TOAST_EXIT_MS,
  TOAST_LIFETIME_MS,
  type ToastModel
} from '../lib/toasts';

interface ToastHostProps {
  toast: ToastModel | null;
  onDismiss(id: number): void;
}

/**
 * One transient notice at the bottom of the viewport, above the selection
 * chip. It expires on its own, waits while the pointer or focus is on it, and
 * carries at most one action — the action a user reaches for right after the
 * thing the toast reports, which so far is always Undo.
 */
export function ToastHost({ toast, onDismiss }: ToastHostProps) {
  const { rendered, closing } = useDelayedUnmount(toast, TOAST_EXIT_MS);
  const [held, setHeld] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Where focus was before it entered the card, for when the card leaves.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // The toast whose action has run: the card stays mounted for its exit
  // fade, and a double-click's second press undid a second step.
  const actedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!toast || held) {
      return;
    }
    const timer = window.setTimeout(
      () => onDismiss(toast.id),
      TOAST_LIFETIME_MS
    );
    return () => window.clearTimeout(timer);
  }, [toast, held, onDismiss]);

  const id = rendered?.id;
  /**
   * `fromKeyboard`: focus goes back where it came from rather than down to
   * <body> with the card. A pointer press leaves it be: the element it came
   * from may be the command bar, which focus would reopen.
   */
  const dismiss = (fromKeyboard: boolean) => {
    if (id === undefined) {
      return;
    }
    // A card removed under the focus or the pointer sends React no blur or
    // mouseleave, so the hold it set would outlive it and keep every later
    // notice up for good.
    if (fromKeyboard && cardRef.current?.contains(document.activeElement)) {
      const back = returnFocusRef.current;
      if (back?.isConnected) {
        back.focus({ preventScroll: true });
      }
    }
    returnFocusRef.current = null;
    setHeld(false);
    onDismiss(id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      dismiss(true);
    }
  };

  return (
    <>
      {/* Mounted between notices so each message lands in a region that
          already exists: one inserted already holding its text goes
          unannounced by several screen readers. */}
      <div className="visually-hidden" role="status" aria-live="polite">
        {toast?.message ?? ''}
      </div>
      {rendered ? (
        <div
          ref={cardRef}
          className={`toast${closing ? ' closing' : ''}`}
          inert={closing}
          onMouseEnter={() => setHeld(true)}
          onMouseLeave={() => setHeld(false)}
          onFocus={(event) => {
            const from = event.relatedTarget;
            if (!(from instanceof Node && event.currentTarget.contains(from))) {
              returnFocusRef.current =
                from instanceof HTMLElement ? from : null;
            }
            setHeld(true);
          }}
          onBlur={() => setHeld(false)}
          onKeyDown={onKeyDown}
        >
          <span className="toast-message" title={rendered.message}>
            {rendered.message}
          </span>
          {rendered.action && (
            <button
              type="button"
              className="toast-action"
              onClick={(event) => {
                if (closing || actedRef.current === rendered.id) {
                  return;
                }
                actedRef.current = rendered.id;
                rendered.action?.run();
                // A keyboard press is a click with no pointer count.
                dismiss(event.detail === 0);
              }}
            >
              {rendered.action.label}
            </button>
          )}
          <button
            type="button"
            className="toast-dismiss"
            aria-label="Dismiss"
            onClick={(event) => dismiss(event.detail === 0)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );
}
