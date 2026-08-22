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

interface ModalRegistration {
  dialog: HTMLElement;
  autoFocus: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreBackground?: () => void;
  removeKeyListener?: () => void;
  stopWaitingForContent?: () => void;
}

// Async conflict detection can open a dialog while another modal is mounted.
// Only the visually top registration may inert siblings; otherwise one
// backdrop can make the dialog painted above it reject pointer and keyboard
// events. Registration order is not enough because an earlier DOM sibling may
// mount after a later one.
const modalStack: ModalRegistration[] = [];
let activeModal: ModalRegistration | null = null;
let stackOpener: HTMLElement | null = null;

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
 * Moves focus to the dialog's first control once its content mounts.
 *
 * Gives up as soon as focus has moved anywhere on its own — the arriving
 * content may autofocus a field of its own, and a viewer who has already
 * tabbed or clicked somewhere should not be yanked back.
 */
function waitForContent(registration: ModalRegistration): void {
  const { dialog, initialFocusRef } = registration;
  const observer = new MutationObserver(() => {
    if (document.activeElement !== dialog) {
      registration.stopWaitingForContent?.();
      return;
    }
    const target =
      initialFocusRef?.current ?? dialog.querySelector<HTMLElement>(FOCUSABLE);
    if (target) {
      registration.stopWaitingForContent?.();
      target.focus();
    }
  });
  observer.observe(dialog, { childList: true, subtree: true });
  registration.stopWaitingForContent = () => {
    observer.disconnect();
    registration.stopWaitingForContent = undefined;
  };
}

function activateModal(registration: ModalRegistration): void {
  const { dialog, autoFocus, initialFocusRef } = registration;
  registration.restoreBackground = inertBackground(dialog);

  if (autoFocus && !dialog.contains(document.activeElement)) {
    const first = dialog.querySelector<HTMLElement>(FOCUSABLE);
    const target = initialFocusRef?.current ?? first;
    (target ?? dialog).focus();
    if (!target) {
      // A dialog whose body is code-split mounts empty for as long as its
      // chunk takes to arrive, so there is nothing to focus yet. Parking focus
      // on the container keeps the keyboard inside the modal meanwhile; this
      // hands it to the first real control the moment one exists, which is
      // where an eagerly rendered dialog would have put it. Without this the
      // dialog opens and the keyboard has nowhere to go.
      waitForContent(registration);
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') {
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
  registration.removeKeyListener = () =>
    document.removeEventListener('keydown', onKeyDown, true);
}

function deactivateModal(registration: ModalRegistration): void {
  registration.stopWaitingForContent?.();
  registration.removeKeyListener?.();
  registration.removeKeyListener = undefined;
  registration.restoreBackground?.();
  registration.restoreBackground = undefined;
}

function refreshActiveModal(): void {
  let next: ModalRegistration | null = null;
  for (const candidate of modalStack) {
    if (!candidate.dialog.isConnected) {
      continue;
    }
    if (
      !next ||
      next.dialog.compareDocumentPosition(candidate.dialog) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ) {
      next = candidate;
    }
  }
  if (next === activeModal) {
    // A lower registration can mount or unmount without changing which dialog
    // is on top. Refresh its inert snapshot so the new sibling cannot keep
    // receiving input behind the active modal.
    if (next) {
      deactivateModal(next);
      activateModal(next);
    }
    return;
  }

  const previous = activeModal;
  if (previous) {
    deactivateModal(previous);
  }
  activeModal = next;

  if (next) {
    activateModal(next);
  } else if (stackOpener?.isConnected) {
    stackOpener.focus();
  }
  if (modalStack.length === 0) {
    stackOpener = null;
  }
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
    if (modalStack.length === 0) {
      stackOpener = document.activeElement as HTMLElement | null;
    }
    const registration: ModalRegistration = {
      dialog,
      autoFocus,
      initialFocusRef
    };
    modalStack.push(registration);
    refreshActiveModal();

    return () => {
      const index = modalStack.indexOf(registration);
      if (index !== -1) {
        modalStack.splice(index, 1);
      }
      refreshActiveModal();
    };
  }, [autoFocus, enabled, initialFocusRef, ref]);
}
