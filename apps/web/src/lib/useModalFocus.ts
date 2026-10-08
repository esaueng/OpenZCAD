import { useLayoutEffect, useRef, type RefObject } from 'react';

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
  /**
   * Let the workspace keymap keep handling keys while this dialog is on top.
   * Only for an overlay the map itself drives (the shortcut sheet).
   */
  workspaceKeys?: boolean;
  /**
   * Called for Escape pressed while focus has fallen out of the dialog. A
   * click on its text or backdrop, or a focused control that turns disabled,
   * leaves focus on the body: the dialog's own key handler never hears the
   * key there, and the workspace keymap stands down for the modal, so nothing
   * closed it. Escape from inside the dialog stays the dialog's to handle.
   */
  onEscape?: () => void;
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
  workspaceKeys: boolean;
  escapeRef: RefObject<(() => void) | undefined>;
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

function isGroupedRadio(element: Element | null): element is HTMLInputElement {
  return (
    element instanceof HTMLInputElement &&
    element.type === 'radio' &&
    element.name !== ''
  );
}

/** Whether two controls are one Tab stop: a radio group is a single stop. */
function sameTabStop(a: Element | null, b: HTMLElement): boolean {
  return (
    a === b ||
    (isGroupedRadio(a) &&
      isGroupedRadio(b) &&
      a.name === b.name &&
      a.form === b.form)
  );
}

/**
 * The dialog's Tab stops in order. Only the checked radio of a group takes
 * Tab, so its unchecked siblings are dropped: counting the unchecked first
 * radio as the first stop let Shift+Tab from the checked one leave the dialog.
 */
function tabStops(dialog: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    dialog.querySelectorAll<HTMLElement>(FOCUSABLE)
  );
  return candidates.filter(
    (element) =>
      !isGroupedRadio(element) ||
      element.checked ||
      !candidates.some(
        (other) =>
          isGroupedRadio(other) && other.checked && sameTabStop(element, other)
      )
  );
}

/** Focuses `target` when it is still a live control in `dialog`. */
function returnFocusInto(
  dialog: HTMLElement,
  target: HTMLElement | null
): boolean {
  if (!target?.isConnected || !dialog.contains(target)) {
    return false;
  }
  target.focus();
  return document.activeElement === target;
}

function activateModal(
  registration: ModalRegistration,
  returnFocus: HTMLElement | null = null
): void {
  const { dialog, autoFocus, initialFocusRef } = registration;
  registration.restoreBackground = inertBackground(dialog);

  // A modal opened from a control in here has closed: the keyboard goes back
  // to that control, not to this dialog's first one (Settings → Privacy →
  // Delete… → Escape landed on the top of Settings).
  const returned = returnFocusInto(dialog, returnFocus);
  if (!returned && autoFocus && !dialog.contains(document.activeElement)) {
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
    if (event.key === 'Escape') {
      const onEscape = registration.escapeRef.current;
      if (onEscape && !dialog.contains(document.activeElement)) {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = tabStops(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const current = document.activeElement;
    const outside = !dialog.contains(current);
    if (event.shiftKey && (sameTabStop(current, first) || outside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (sameTabStop(current, last) || outside)) {
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

/**
 * Re-picks the visually top registration. `returnFocus` is the opener of a
 * modal that just closed, handed to the one below when it was opened from it.
 */
function refreshActiveModal(returnFocus: HTMLElement | null = null): void {
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
    activateModal(next, returnFocus);
  } else if (stackOpener?.isConnected) {
    stackOpener.focus();
  }
  if (modalStack.length === 0) {
    stackOpener = null;
  }
}

/**
 * Whether the dialog on top keeps the keyboard from the workspace behind it.
 *
 * `inert` stops pointer and focus reaching the background, but the workspace
 * keymap listens on the window, so a key pressed on a dialog button — or with
 * focus dropped on the body — still reached it: Ctrl+Z rewound the model
 * behind an open export or named-save dialog.
 */
export function modalHoldsKeyboard(): boolean {
  return activeModal !== null && !activeModal.workspaceKeys;
}

/**
 * Gives a modal dialog the focus behaviour its `aria-modal` promises: focus
 * starts inside, Tab cannot escape to the workspace behind it, and whatever was
 * focused before the dialog opened gets focus back on close.
 */
export function useModalFocus(
  ref: RefObject<HTMLElement | null>,
  {
    enabled = true,
    autoFocus = false,
    initialFocusRef,
    workspaceKeys = false,
    onEscape
  }: ModalFocusOptions = {}
): void {
  // Read at key time, so a new callback each render neither re-registers the
  // modal nor runs a stale closure (a busy flag it checks, say).
  const escapeRef = useRef(onEscape);
  useLayoutEffect(() => {
    escapeRef.current = onEscape;
  });

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    // Each modal keeps its own opener as well as the stack's: one opened
    // from inside another hands focus back to that control when it closes.
    const opener = document.activeElement as HTMLElement | null;
    if (modalStack.length === 0) {
      stackOpener = opener;
    }
    const registration: ModalRegistration = {
      dialog,
      autoFocus,
      initialFocusRef,
      workspaceKeys,
      escapeRef
    };
    modalStack.push(registration);
    refreshActiveModal();

    return () => {
      const index = modalStack.indexOf(registration);
      if (index !== -1) {
        modalStack.splice(index, 1);
      }
      refreshActiveModal(opener);
    };
  }, [autoFocus, enabled, initialFocusRef, ref, workspaceKeys]);
}
