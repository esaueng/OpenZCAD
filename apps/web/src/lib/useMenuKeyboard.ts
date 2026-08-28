import { useEffect, type RefObject } from 'react';

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
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const previous = document.activeElement;
    element.focus({ preventScroll: true });

    // Disabled items are skipped rather than focused-and-inert: focusing one
    // is a no-op, so leaving them in the ring would strand the arrow keys on
    // whichever item precedes a disabled run.
    const itemsOf = (): HTMLElement[] =>
      Array.from(
        element.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not([disabled])'
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
