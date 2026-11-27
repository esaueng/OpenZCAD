import {
  useEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent
} from 'react';
import { OWN_ENTER_ATTRIBUTE } from './exactEntryShortcut';

/**
 * Enter on a focused row of a list whose rows are buttons, such as Objects.
 *
 * Space always pressed a focused row: the workspace leaves Space to any
 * focused button. Enter did not. The workspace's key handler read it first
 * and called `preventDefault`, which cancels the button's own activation:
 * during an in-place command (a Boolean's or Mirror's body picks) the press
 * ran Done, and over an armed pick it opened that pick's value entry, so the
 * focused row was never picked.
 *
 * The precedence, the same as Select other's rows (#2174):
 * - A row reached by keyboard (Tab, or focus handed back after a rename)
 *   owns a plain Enter. The press picks that row exactly as Space or a click
 *   does, and nothing else: no Done, no value entry, no viewport key. The
 *   row carries `data-own-enter` while it has that focus, so every other
 *   Enter handler (the workspace's, the viewport's capture listener) leaves
 *   the key to it.
 * - A row focused by a pointer press does not. Clicking a row is the pick;
 *   Enter afterwards still finishes the command or opens the pick's value
 *   entry, as it does after clicking a rail tool (U01).
 * - Only a fresh press acts. A held Enter's auto-repeat keydowns are
 *   swallowed until the key is released, so holding Enter cannot toggle the
 *   pick off again or reach Done once the row has acted.
 * - Enter with a modifier is left to whoever else reads it.
 */
export function useKeyboardRowEnter() {
  const pointerPending = useRef(false);
  const stopSwallowing = useRef<(() => void) | null>(null);
  useEffect(() => () => stopSwallowing.current?.(), []);

  function swallowRestOfPress() {
    stopSwallowing.current?.();
    const swallow = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      if (event.type === 'keydown' && event.repeat) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      // Released, or a fresh press: the held press is over.
      stop();
    };
    const stop = () => {
      window.removeEventListener('keydown', swallow, true);
      window.removeEventListener('keyup', swallow, true);
      window.removeEventListener('blur', stop);
      if (stopSwallowing.current === stop) stopSwallowing.current = null;
    };
    window.addEventListener('keydown', swallow, true);
    window.addEventListener('keyup', swallow, true);
    window.addEventListener('blur', stop);
    stopSwallowing.current = stop;
  }

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      pointerPending.current = true;
      rowOf(event.currentTarget, event.target)?.removeAttribute(
        OWN_ENTER_ATTRIBUTE
      );
    },
    onPointerUp() {
      pointerPending.current = false;
    },
    onPointerCancel() {
      pointerPending.current = false;
    },
    onFocus(event: FocusEvent<HTMLElement>) {
      const row = rowOf(event.currentTarget, event.target);
      const byPointer = pointerPending.current;
      pointerPending.current = false;
      if (!row) return;
      if (!byPointer && focusVisible(row)) {
        row.setAttribute(OWN_ENTER_ATTRIBUTE, '');
      } else {
        row.removeAttribute(OWN_ENTER_ATTRIBUTE);
      }
    },
    onBlur(event: FocusEvent<HTMLElement>) {
      rowOf(event.currentTarget, event.target)?.removeAttribute(
        OWN_ENTER_ATTRIBUTE
      );
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (
        event.key !== 'Enter' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.nativeEvent.isComposing
      )
        return;
      const row = rowOf(event.currentTarget, event.target);
      if (!row?.hasAttribute(OWN_ENTER_ATTRIBUTE)) return;
      // The row's own press, done here rather than by the button's native
      // activation so no other listener can cancel or repeat it.
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      row.click();
      swallowRestOfPress();
    }
  };
}

/** The list's button that `target` is, or is inside. */
function rowOf(list: HTMLElement, target: EventTarget): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest('button');
  return row instanceof HTMLElement && list.contains(row) ? row : null;
}

/** Whether the browser says focus reached `element` by keyboard. */
function focusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}
