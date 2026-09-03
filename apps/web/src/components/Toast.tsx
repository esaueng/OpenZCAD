import { X } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useDelayedUnmount } from '../hooks/useDelayedUnmount';
import {
  TOAST_EXIT_MS,
  TOAST_LIFETIME_MS,
  type ToastModel
} from '../lib/toasts';

interface ToastHostProps {
  toast: ToastModel | null;
  onDismiss(id: number): void;
  /** View mode docks a bar along the bottom edge; sit above it. */
  aboveViewBar?: boolean;
}

/**
 * One transient notice at the bottom of the viewport, above the selection
 * chip. It expires on its own, waits while the pointer or focus is on it, and
 * carries at most one action — the action a user reaches for right after the
 * thing the toast reports, which so far is always Undo.
 */
export function ToastHost({
  toast,
  onDismiss,
  aboveViewBar = false
}: ToastHostProps) {
  const { rendered, closing } = useDelayedUnmount(toast, TOAST_EXIT_MS);
  const [held, setHeld] = useState(false);

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

  if (!rendered) {
    return null;
  }
  const { id, message, action } = rendered;
  const dismiss = () => onDismiss(id);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      dismiss();
    }
  };

  return (
    <div
      className={`toast${closing ? ' closing' : ''}${aboveViewBar ? ' above-view-bar' : ''}`}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      onKeyDown={onKeyDown}
    >
      <span className="toast-message">{message}</span>
      {action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            action.run();
            dismiss();
          }}
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-dismiss"
        aria-label="Dismiss"
        onClick={dismiss}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
