import { useLayoutEffect, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

interface ModalFocusOptions {
  /** Keep the hook mounted in an owner component while the dialog is closed. */
  enabled?: boolean;
  /** Move focus into the dialog on open. Skip when a child already autofocuses. */
  autoFocus?: boolean;
  /** Preferred initial target. Falls back to the first focusable control. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

interface InertState {
  element: HTMLElement;
  hadInertAttribute: boolean;
  ariaHidden: string | null;
}

function inertBackground(dialog: HTMLElement): () => void {
  const changed: InertState[] = [];
  let branch: HTMLElement | null = dialog;
  while (branch?.parentElement && branch !== document.body) {
    const parent: HTMLElement = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) {
        continue;
      }
      changed.push({
        element: sibling,
        hadInertAttribute: sibling.hasAttribute('inert'),
        ariaHidden: sibling.getAttribute('aria-hidden')
      });
      sibling.setAttribute('inert', '');
      sibling.setAttribute('aria-hidden', 'true');
    }
    branch = parent;
  }
  return () => {
    for (const state of changed.reverse()) {
      if (!state.hadInertAttribute) {
        state.element.removeAttribute('inert');
      }
      if (state.ariaHidden === null) {
        state.element.removeAttribute('aria-hidden');
      } else {
        state.element.setAttribute('aria-hidden', state.ariaHidden);
      }
    }
  };
}

/**
 * Gives a modal dialog the focus behaviour its `aria-modal` promises: focus
 * starts inside, Tab cannot escape to the workspace behind it, and whatever was
 * focused before the dialog opened gets focus back on close.
 */
export function useModalFocus(
  ref: RefObject<HTMLElement | null>,
  { enabled = true, autoFocus = false, initialFocusRef }: ModalFocusOptions = {}
): void {
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const restoreBackground = inertBackground(dialog);

    if (autoFocus && !dialog.contains(document.activeElement)) {
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE);
      (initialFocusRef?.current ?? first ?? dialog).focus();
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
      restoreBackground();
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [autoFocus, enabled, initialFocusRef, ref]);
}
