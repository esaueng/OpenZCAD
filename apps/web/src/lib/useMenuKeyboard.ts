import { useEffect, useRef, type RefObject } from 'react';

/** Each open menu's opener: the control focus returns to when it closes. */
const menuOpeners = new WeakMap<Element, HTMLElement>();
/** The opener of the menu open most recently, until that menu unmounts. */
let openMenuOpener: { menu: Element; opener: HTMLElement } | null = null;

/**
 * The control that opened the menu `element` sits in, for a dialog opened
 * from one of its items.
 *
 * Such a dialog mounts while the menu is fading out, so the control it saw
 * focused is a menu item that is gone by the time the dialog closes, and
 * focus fell to the body: Cancel on History's Delete prompt sent the next
 * Tab to the top of the app (UX-005). The menu's own opener — the row's
 * More actions button — is the place to come back to. A menu that unmounts
 * on the same commit leaves the focus on the body before the dialog sees
 * it, so the menu still registered is the opener's source then.
 */
export function menuOpenerFor(element: Element | null): HTMLElement | null {
  const menu = element?.closest?.('[role="menu"]');
  const opener =
    (menu ? menuOpeners.get(menu) : undefined) ??
    (!element || element === document.body ? openMenuOpener?.opener : null);
  return opener?.isConnected ? opener : null;
}

/**
 * The keyboard half of `role="menu"`.
 *
 * Both menus in this app declared the role and implemented none of what it
 * promises. Opening one left focus on whatever was behind it, no key moved
 * between the items, and closing one dropped focus on the floor: the element
 * holding it had just been unmounted, so a keyboard user who pressed the Menu
 * key on a feature row and then pressed Escape was returned to the top of the
 * document with their place in the tree gone.
 *
 * Focus goes to the menu container rather than to its first item. These menus
 * are summoned by pointer far more often than by key, and pre-arming an item
 * nobody aimed at would be an outright lie in the marking menu, whose hub
 * reads out whatever a release would run. From the container one arrow key
 * reaches the items, which is what a native context menu charges too.
 */
export function useMenuKeyboard(ref: RefObject<HTMLElement | null>): void {
  // Where focus was before the menu took it. Kept across effect runs: a
  // re-run (StrictMode mounts twice) finds focus already inside the menu,
  // and recording that would leave nothing to return to on close.
  const previousRef = useRef<Element | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    if (!element.contains(document.activeElement)) {
      previousRef.current = document.activeElement;
    }
    const previous = previousRef.current;
    const registration =
      previous instanceof HTMLElement && previous !== document.body
        ? { menu: element, opener: previous }
        : null;
    if (registration) {
      menuOpeners.set(element, registration.opener);
      openMenuOpener = registration;
    }
    element.focus({ preventScroll: true });

    // Disabled items are skipped rather than focused-and-inert: focusing one
    // is a no-op, so leaving them in the ring would strand the arrow keys on
    // whichever item precedes a disabled run.
    const itemsOf = (): HTMLElement[] =>
      Array.from(
        element.querySelectorAll<HTMLElement>(
          ':is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]):not([disabled])'
        )
      );

    const onKeyDown = (event: KeyboardEvent) => {
      const items = itemsOf();
      if (items.length === 0) {
        return;
      }
      const current = items.indexOf(document.activeElement as HTMLElement);
      let next: number | null = null;
      // Both axes move, in both menus. Left and right are reserved for
      // submenus in a vertical menu and neither of these has any, and the
      // marking menu is a ring, where no single axis is the one that goes
      // round.
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        next = current < 0 ? 0 : (current + 1) % items.length;
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        next = current <= 0 ? items.length - 1 : current - 1;
      } else if (event.key === 'Home') {
        next = 0;
      } else if (event.key === 'End') {
        next = items.length - 1;
      }
      if (next === null) {
        return;
      }
      items[next]?.focus({ preventScroll: true });
      event.preventDefault();
      event.stopPropagation();
    };

    element.addEventListener('keydown', onKeyDown);
    return () => {
      element.removeEventListener('keydown', onKeyDown);
      if (registration && openMenuOpener === registration) {
        openMenuOpener = null;
      }
      const active = document.activeElement as HTMLElement | null;
      // Put focus back only if the closing menu left it nowhere. Several of
      // these items open a dialog, which takes focus on the same commit that
      // unmounts the menu; snatching it back would be worse than never having
      // moved it at all.
      const adrift = !active || active === document.body || !active.isConnected;
      if (adrift && previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [ref]);
}
