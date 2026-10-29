import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

interface StoredScroll {
  view: string;
  /** Scroll offsets by selector; `''` is the root element itself. */
  tops: Record<string, number>;
}

/** What a reader or a person's first move does to a pending restore. */
const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'];

/**
 * Keeps a screen's scroll position across a reload of the tab.
 *
 * The offsets of the root and of each selected scroller inside it go to
 * session storage as they change, labelled with `view` (which shelf and
 * filter is showing). On mount, a stored position for the same view is put
 * back as soon as the content is tall enough to hold it, retrying each render
 * until `ready`; the first wheel, touch, key or click cancels it, so a
 * restore never fights someone already scrolling. Positions are not saved
 * while one is pending, so a half-loaded page cannot overwrite the stored
 * offset with a clamped one. Session storage scopes it to the tab, and any
 * storage failure (a private window, blocked site data) simply forgets.
 */
export function useScrollMemory(
  rootRef: RefObject<HTMLElement | null>,
  key: string,
  selectors: readonly string[],
  view: string,
  ready: boolean
) {
  const pending = useRef<StoredScroll | null>(readStored(key, view));
  const currentView = useRef(view);
  currentView.current = view;

  useLayoutEffect(() => {
    const stored = pending.current;
    const root = rootRef.current;
    if (!stored || !root) {
      return;
    }
    if (stored.view !== view) {
      pending.current = null;
      return;
    }
    let reached = true;
    for (const selector of ['', ...selectors]) {
      const element = scroller(root, selector);
      const top = stored.tops[selector];
      if (!element || top === undefined) {
        continue;
      }
      element.scrollTop = top;
      reached &&= Math.abs(element.scrollTop - top) <= 1;
    }
    if (reached || ready) {
      pending.current = null;
    }
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    let frame = 0;
    const save = () => {
      frame = 0;
      if (pending.current) {
        return;
      }
      const tops: Record<string, number> = {};
      for (const selector of ['', ...selectors]) {
        const element = scroller(root, selector);
        if (element) {
          tops[selector] = element.scrollTop;
        }
      }
      writeStored(key, { view: currentView.current, tops });
    };
    const onScroll = () => {
      frame ||= window.requestAnimationFrame(save);
    };
    const cancel = () => {
      pending.current = null;
    };
    // Scroll does not bubble; capturing at the root hears every scroller.
    root.addEventListener('scroll', onScroll, { capture: true, passive: true });
    for (const type of USER_SCROLL_EVENTS) {
      root.addEventListener(type, cancel, { capture: true, passive: true });
    }
    return () => {
      window.cancelAnimationFrame(frame);
      root.removeEventListener('scroll', onScroll, { capture: true });
      for (const type of USER_SCROLL_EVENTS) {
        root.removeEventListener(type, cancel, { capture: true });
      }
    };
    // The selectors are a fixed list per screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rootRef]);
}

function scroller(root: HTMLElement, selector: string): HTMLElement | null {
  return selector ? root.querySelector<HTMLElement>(selector) : root;
}

function readStored(key: string, view: string): StoredScroll | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredScroll>;
    if (
      parsed.view !== view ||
      typeof parsed.tops !== 'object' ||
      parsed.tops === null
    ) {
      return null;
    }
    const tops = Object.fromEntries(
      Object.entries(parsed.tops).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1])
      )
    );
    return { view, tops };
  } catch {
    return null;
  }
}

function writeStored(key: string, value: StoredScroll) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Forgetting the position is the whole failure mode.
  }
}
