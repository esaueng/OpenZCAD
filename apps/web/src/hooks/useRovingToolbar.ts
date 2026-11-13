import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

type RovingItem = HTMLElement | SVGElement;

export interface RovingToolbarOptions {
  /** Which descendants are the toolbar's stops. */
  items: string;
  /**
   * Subtrees whose controls keep their own tab order: the flyouts and
   * popovers a rail mounts inside itself. Tab still walks those in full.
   */
  except?: string;
  /**
   * False leaves the tab order alone, for a toolbar that is drawn inside a
   * larger rail which already manages it.
   */
  enabled?: boolean;
  /**
   * The toolbars (the rail itself, or the ones inside it) whose
   * `aria-orientation` follows their live layout: a rail that is a column on
   * a desktop is a row on a phone, and the tooltips place themselves by the
   * attribute, so it must never claim a column that is not drawn.
   */
  orient?: string;
  /**
   * What the rail is about. When it changes (the Build tools give way to a
   * pick's verbs) the rail is entered at its head again rather than on
   * whichever stop of the old set happens to survive, unless the keyboard is
   * in the rail at the time.
   */
  resetOn?: unknown;
  /**
   * Watch the subtree for stops coming, going, hiding and greying. Off for a
   * host that knows when its own stops change and calls the returned `sync`
   * (the view cube rewrites its facets every camera frame; watching those
   * writes would run this once a frame).
   */
  observe?: boolean;
}

const NEXT_KEYS = new Set(['ArrowDown', 'ArrowRight']);
const PREVIOUS_KEYS = new Set(['ArrowUp', 'ArrowLeft']);

function isShown(element: RovingItem): boolean {
  if (typeof element.checkVisibility === 'function') {
    // Rendered at all: `display: none` on it or above it. Not `visibility`:
    // a workspace still covered while its project opens is hidden that way,
    // and its rails must have their stops by the time it shows.
    return element.checkVisibility();
  }
  // No layout to ask (a test DOM): an inline `display: none` is all that
  // can be read, which is how the view cube hides a facet turned away.
  return element.style.display !== 'none';
}

/**
 * The stops of a rail, in document order: what `items` matches, less what is
 * natively disabled (it cannot take focus), hidden, or inside an `except`
 * subtree. A control greyed with `aria-disabled` stays a stop, so the arrow
 * keys still reach it and its reason is still read out.
 */
export function rovingItems(
  root: Element,
  items: string,
  except?: string
): RovingItem[] {
  return Array.from(root.querySelectorAll<RovingItem>(items)).filter(
    (element) => {
      if (element.matches(':disabled')) return false;
      if (except) {
        const inside = element.closest(except);
        if (inside && root.contains(inside)) return false;
      }
      return isShown(element);
    }
  );
}

/**
 * One tab stop for a rail of buttons (a roving tabindex): Tab enters the
 * rail on the stop last used and leaves it in one press, the arrow keys move
 * between the stops, and Home and End go to the ends. Before this the Build
 * workspace cost a keyboard twenty-one presses (fourteen instruments, seven
 * cube facets) before it reached the first modeling tool.
 *
 * Driven from the DOM rather than a `tabIndex` on each button: a rail's
 * buttons come from several components (the viewer bar, the panel buttons,
 * the pick's verbs), and none of them has to know it shares a rail. All four
 * arrows move, whatever the rail's orientation: a rail that is a column on a
 * desktop is a two-column grid in a short window and a row on a phone.
 *
 * The root must be an HTML element: the hook listens for focus on it, and a
 * browser makes an SVG element with a focus listener a tab stop of its own
 * (the view cube's `<svg>` became an eighth stop that way), so the cube
 * passes the `<div>` around it.
 *
 * Returns `sync`, which re-reads the stops now.
 */
export function useRovingToolbar(
  ref: { readonly current: Element | null },
  {
    items,
    except,
    orient,
    resetOn,
    enabled = true,
    observe = true
  }: RovingToolbarOptions
): () => void {
  const current = useRef<RovingItem | null>(null);
  const lastReset = useRef(resetOn);

  const sync = useCallback(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    if (orient) {
      const toolbars = [
        ...(root.matches(orient) ? [root] : []),
        ...root.querySelectorAll(orient)
      ];
      for (const toolbar of toolbars) {
        const orientation = window
          .getComputedStyle(toolbar)
          .flexDirection.startsWith('column')
          ? 'vertical'
          : 'horizontal';
        if (toolbar.getAttribute('aria-orientation') !== orientation) {
          toolbar.setAttribute('aria-orientation', orientation);
        }
      }
    }
    const stops = rovingItems(root, items, except);
    if (stops.length === 0) {
      current.current = null;
      return;
    }
    const focused = document.activeElement;
    if (!Object.is(lastReset.current, resetOn)) {
      lastReset.current = resetOn;
      if (!root.contains(focused)) current.current = null;
    }
    const stop =
      stops.find((candidate) => candidate === focused) ??
      stops.find((candidate) => candidate === current.current) ??
      // A rail is entered on something that acts, never on a greyed stop.
      stops.find(
        (candidate) => candidate.getAttribute('aria-disabled') !== 'true'
      ) ??
      stops[0]!;
    current.current = stop;
    for (const candidate of stops) {
      const tabIndex = candidate === stop ? '0' : '-1';
      // Only a change is written, so the observer below settles at once.
      if (candidate.getAttribute('tabindex') !== tabIndex) {
        candidate.setAttribute('tabindex', tabIndex);
      }
    }
    // A stop that has since hidden or greyed out gives the tab stop up, so
    // it is not a second one the moment it comes back.
    for (const stale of root.querySelectorAll<RovingItem>(
      `:is(${items})[tabindex="0"]`
    )) {
      if (stale === stop || stops.includes(stale)) continue;
      const inside = except ? stale.closest(except) : null;
      if (inside && root.contains(inside)) continue;
      stale.setAttribute('tabindex', '-1');
    }
  }, [ref, items, except, orient, resetOn, enabled]);

  // After every render of the host: its buttons may have changed with it.
  // The host can render on every frame of a drag, so this pass reads only
  // what needs no style or layout (which stops exist, which are disabled or
  // hidden inline) and re-reads the stops in full only when that changed.
  // What it cannot see, a stop hidden by a class or a breakpoint, the
  // observer and the resize listener below report.
  const seen = useRef<unknown[]>([]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    const now: unknown[] = [sync];
    for (const item of root.querySelectorAll<RovingItem>(items)) {
      now.push(item, item.matches(':disabled'), item.style.display);
    }
    const before = seen.current;
    if (
      // A rail that found no stop yet (not rendered when it was read) is
      // read again until it has one.
      current.current?.isConnected &&
      before.length === now.length &&
      before.every((value, index) => Object.is(value, now[index]))
    ) {
      return;
    }
    seen.current = now;
    sync();
  });

  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return;

    const onFocusIn = (event: Event) => {
      const stops = rovingItems(root, items, except);
      const target = stops.find((candidate) => candidate === event.target);
      if (!target || target === current.current) return;
      current.current = target;
      sync();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Alt+arrow reorders a pin and a modified arrow is some other
      // command's; neither moves the focus.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const forward = NEXT_KEYS.has(event.key);
      const backward = PREVIOUS_KEYS.has(event.key);
      if (!forward && !backward && event.key !== 'Home' && event.key !== 'End')
        return;
      const stops = rovingItems(root, items, except);
      const index = stops.findIndex((candidate) => candidate === event.target);
      // A key pressed in a flyout's field or list is that control's.
      if (index < 0) return;
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? stops.length - 1
            : (index + (forward ? 1 : -1) + stops.length) % stops.length;
      event.preventDefault();
      // The workspace binds the arrows too (nudge, orbit); on a rail they
      // are the rail's.
      event.stopPropagation();
      const target = stops[next]!;
      current.current = target;
      sync();
      target.focus();
    };

    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('keydown', onKeyDown as EventListener);
    // A breakpoint shows and hides stops, and turns a rail on its side.
    window.addEventListener('resize', sync);
    // The rail's own box changing is it appearing (a column that mounts
    // undisplayed and is shown without a render of the host) or its stops
    // being laid out anew.
    const resize =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    resize?.observe(root);
    // Only what can add, remove, hide or grey a stop re-reads them: an
    // element coming or going, or one of those attributes on a stop itself.
    // A readout rewriting its text on every camera frame, or a slider
    // dragged in a flyout, is neither, and costs nothing here.
    const touchesStops = (record: MutationRecord) => {
      const target = record.target;
      if (!(target instanceof Element)) return false;
      const inside = except ? target.closest(except) : null;
      if (inside && root.contains(inside)) return false;
      if (record.type === 'attributes') {
        return record.attributeName === 'hidden' || target.matches(items);
      }
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) => node.nodeType === Node.ELEMENT_NODE
      );
    };
    const observer =
      observe && typeof MutationObserver !== 'undefined'
        ? new MutationObserver((records) => {
            if (records.some(touchesStops)) sync();
          })
        : null;
    observer?.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'style', 'class', 'tabindex']
    });
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('keydown', onKeyDown as EventListener);
      window.removeEventListener('resize', sync);
      resize?.disconnect();
      observer?.disconnect();
    };
  }, [ref, items, except, enabled, observe, sync]);

  return sync;
}
