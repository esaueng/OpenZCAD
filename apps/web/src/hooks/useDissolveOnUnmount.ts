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
 * The copy is aria-hidden, inert and carries no ids, so neither assistive tech
 * nor a label lookup can find it twice. Skipped under reduced motion, where
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
      for (const element of [ghost, ...ghost.querySelectorAll('[id]')]) {
        element.removeAttribute('id');
      }
      document.body.append(ghost);
      // A clone starts scrolled to the top; put each scroller back where the
      // user left it so the fading frame is the one they were looking at.
      const sources = node.querySelectorAll('*');
      const copies = ghost.querySelectorAll('*');
      sources.forEach((source, index) => {
        if (source.scrollTop > 0 || source.scrollLeft > 0) {
          const copy = copies[index];
          if (copy) {
            copy.scrollTop = source.scrollTop;
            copy.scrollLeft = source.scrollLeft;
          }
        }
      });
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
