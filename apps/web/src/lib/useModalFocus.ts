import { useEffect, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

interface ModalFocusOptions {
  /** Move focus into the dialog on open. Skip when a child already autofocuses. */
  autoFocus?: boolean;
}

/**
 * Gives a modal dialog the focus behaviour its `aria-modal` promises: focus
 * starts inside, Tab cannot escape to the workspace behind it, and whatever was
 * focused before the dialog opened gets focus back on close.
 */
export function useModalFocus(
  ref: RefObject<HTMLElement | null>,
  { autoFocus = false }: ModalFocusOptions = {}
): void {
  useEffect(() => {
    const dialog = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    if (autoFocus && dialog && !dialog.contains(document.activeElement)) {
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? dialog).focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialog) {
        return;
      }
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE)
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const current = document.activeElement;
      const outside = !dialog.contains(current);
      if (event.shiftKey && (current === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };

    // Capture phase so the trap wins over the workspace's own key handling.
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [autoFocus, ref]);
}
