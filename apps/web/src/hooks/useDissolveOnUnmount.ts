import { useLayoutEffect, type RefObject } from 'react';

/**
 * Fades a screen out after React removes it, by leaving a static copy of its
 * last frame over whatever mounts in its place.
 *
 * The start screen unmounts on the same commit that mounts the workspace, and
 * that switch happens inside `hydrateDocument`, which eighteen callers expect
 * to have set the document synchronously; a View Transition would defer it. A
 * clone taken in the layout cleanup — which React runs while the node is
 * still attached — gives the same dissolve with no change to that timing.
 *
 * The copy is aria-hidden and inert, and it is only a picture: it keeps no
 * ids, no accessible names and none of the controls that never paint (the
 * header's hidden file input), so for its lifetime neither assistive tech nor
 * a lookup by label, title or id finds the outgoing screen's controls beside
 * the workspace's own. aria-hidden alone is not enough there — a label lookup
 * does not consult it. Skipped under reduced motion, where
 * the Web Animations API is missing, and for a node with no layout box.
 */
export function useDissolveOnUnmount(
  ref: RefObject<HTMLElement | null>,
  durationMs: number
) {
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      if (!node?.isConnected || typeof node.animate !== 'function') {
        return;
      }
      // Nothing on screen, nothing to dissolve: a hidden screen, or a DOM
      // with no layout at all, would otherwise leave an invisible copy
      // holding duplicate text for as long as its fade takes.
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
        return;
      }
      if (
        document.documentElement.dataset.reducedMotion === 'true' ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ) {
        return;
      }
      const ghost = node.cloneNode(true) as HTMLElement;
      ghost.classList.add('dissolving');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.inert = true;
      // A clone starts scrolled to the top; note where the user left each
      // scroller (by position, before anything is pruned) so the fading
      // frame is the one they were looking at.
      const scrolled: Array<[Element, number, number]> = [];
      const copies = ghost.querySelectorAll('*');
      node.querySelectorAll('*').forEach((source, index) => {
        const copy = copies[index];
        if (copy && (source.scrollTop > 0 || source.scrollLeft > 0)) {
          scrolled.push([copy, source.scrollTop, source.scrollLeft]);
        }
      });
      stripNames(ghost);
      document.body.append(ghost);
      for (const [copy, top, left] of scrolled) {
        copy.scrollTop = top;
        copy.scrollLeft = left;
      }
      const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: durationMs,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'forwards'
      });
      const remove = () => ghost.remove();
      fade.finished.then(remove, remove);
    };
  }, [ref, durationMs]);
}

/** Attributes that name, describe or address an element. */
const NAMING_ATTRIBUTES = [
  'id',
  'for',
  'name',
  'title',
  'alt',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-description',
  'aria-controls',
  'aria-owns',
  'data-testid'
];

/** Elements that paint nothing, so a picture of the screen can drop them. */
const UNPAINTED =
  'input[type="file"], input[type="hidden"], [hidden], template';

function stripNames(ghost: HTMLElement) {
  ghost.querySelectorAll(UNPAINTED).forEach((element) => element.remove());
  for (const element of [ghost, ...ghost.querySelectorAll('*')]) {
    for (const attribute of NAMING_ATTRIBUTES) {
      element.removeAttribute(attribute);
    }
  }
}
