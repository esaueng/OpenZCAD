import { ChevronLeft, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import {
  CLOSED_SHEET,
  SHEET_DETENTS,
  SHEET_DETENT_NAMES,
  SHEET_PEEK_PX,
  nearestDetent,
  sheetEscape,
  sheetReducer,
  type SheetAction,
  type SheetDetent,
  type SheetState
} from './sheetState';
import { OWN_ENTER_ATTRIBUTE } from '../../lib/exactEntryShortcut';
import { SHEET_INERT_ATTRIBUTE, SHEET_OVERLAY_ATTRIBUTE } from './compactSlots';

/** What a press on the sheet's surface leaves to itself, not to a drag. */
const SURFACE_DRAG_EXCLUDED =
  'button, a, input, select, textarea, label, [role="slider"], [role="button"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** Room left around a field scrolled into view in the sheet, in CSS px. */
const REVEAL_MARGIN = 12;

/** Scrolls `scroller` just enough to show `element` whole, if it can. */
export function revealInside(scroller: HTMLElement, element: HTMLElement) {
  const box = scroller.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (rect.bottom > box.bottom - REVEAL_MARGIN) {
    scroller.scrollTop += Math.min(
      rect.bottom - box.bottom + REVEAL_MARGIN,
      rect.top - box.top - REVEAL_MARGIN
    );
  } else if (rect.top < box.top + REVEAL_MARGIN) {
    scroller.scrollTop -= box.top + REVEAL_MARGIN - rect.top;
  }
}

/** Holds the sheet's state; `hasRoot` is whether the workspace fills it. */
export function useSheet(hasRoot: boolean) {
  const hasRootRef = useRef(hasRoot);
  hasRootRef.current = hasRoot;
  const [state, dispatch] = useReducer(
    (current: SheetState, action: SheetAction) =>
      sheetReducer(current, action, hasRootRef.current),
    CLOSED_SHEET
  );
  return { state, dispatch };
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Whether a control inside `root` is drawn, so focus can land on it: not
 * under `hidden` or `inert`, not inside a closed `<details>` (other than its
 * own summary), and not under `display: none` or `visibility: hidden`. A
 * tool's Options left closed hold inputs the trap must not count: focus
 * sent to one of them stays where it was.
 */
function isDrawn(element: HTMLElement, root: HTMLElement): boolean {
  if (element.closest('[hidden], [inert]')) return false;
  for (
    let current: HTMLElement | null = element;
    current && current !== root;
    current = current.parentElement
  ) {
    const parent = current.parentElement;
    if (
      parent instanceof HTMLDetailsElement &&
      !parent.open &&
      current.tagName !== 'SUMMARY'
    ) {
      return false;
    }
    const style = getComputedStyle(current);
    if (style.display === 'none') return false;
    // Visibility inherits: the control's own value is the one in force.
    if (current === element && style.visibility === 'hidden') return false;
  }
  return true;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) =>
    isDrawn(element, root)
  );
}

export { SHEET_OVERLAY_ATTRIBUTE };

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'number',
  'password',
  'tel',
  'url'
]);

function isTextField(element: HTMLElement): boolean {
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement &&
      TEXT_INPUT_TYPES.has(element.type)) ||
    element.isContentEditable
  );
}

/** Whether focus is in a field on a sheet page, which the keyboard serves. */
function typingInActive(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    active.closest('.compact-sheet-body[data-page]') !== null &&
    isTextField(active) &&
    active.inputMode !== 'none'
  );
}

/** What opened a page, to give focus back to when the page goes. */
interface PageOpener {
  element: HTMLElement | null;
  /** The menu row it was, found again when its page was drawn anew. */
  rowId: string | null;
}

/** Whether focus can land on the element now. */
function canFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(
    element &&
    element.isConnected &&
    !element.closest('[hidden], [inert]') &&
    !(element as HTMLButtonElement).disabled
  );
}

interface BottomSheetProps {
  /** The sheet's accessible name. */
  label: string;
  state: SheetState;
  dispatch(action: SheetAction): void;
  /** Whether the workspace's own content (the root page) is in the sheet. */
  hasRoot: boolean;
  /** The root page: what the workspace puts in the sheet. */
  children?: ReactNode;
  /**
   * A pushed page's title and content, drawn from current state on every
   * render; null draws it empty.
   */
  renderPage(key: string): { title: string; content: ReactNode } | null;
  /** A cross-fade in place of the spring between heights. */
  reducedMotion?: boolean;
  /**
   * The elements made inert while the sheet stands at full height, so focus
   * and taps stay in the sheet: the stage, the header, the tabs.
   */
  background?(): readonly (Element | null | undefined)[];
  /**
   * Layers outside the sheet that belong to it at full height: the notice
   * over it (a toast's Undo, the status line's). Their controls join the
   * focus trap after the sheet's own, so the keyboard reaches them too.
   */
  companions?(): readonly (Element | null | undefined)[];
  /** The sheet's drawn height in CSS pixels, as it changes. */
  onHeight?(px: number): void;
  /**
   * The workspace's row raised from peek (dragged, or the slider's keys):
   * answering true, the workspace shows something there itself (Build's
   * All tools) and the sheet does not rise on its own into blank space.
   */
  onRowRaise?(detent: 'half' | 'full'): boolean;
  /**
   * What the row raised opens (`onRowRaise`'s page), drawn under the row
   * while it is dragged up: the page comes into view as the sheet follows
   * the finger, tile by tile, rather than only once the finger lets go.
   */
  rowRaisePreview?: { title: string; content: ReactNode };
  /**
   * The open page dragged, or stepped, down to peek: the workspace puts
   * its pages away, back to its row (a sheet that holds only a tray), so
   * a pull down undoes a pull up. While dragged down the row shows
   * through the page as it goes.
   */
  onPageLower?(): void;
  /**
   * A row with nothing under it holds at peek: raised, it would stand
   * over blank space (View's, Tweak's or Draw's tray alone). A drag up
   * stretches it a little and lets it spring back, and the slider's keys
   * leave it. A row whose content runs past peek still rises.
   */
  holdFittingRow?: boolean;
}

/** How far a held row stretches under a drag, at most, in CSS px. */
const HELD_ROW_STRETCH = 40;
/** How far a page swiped from its leading edge goes back, in CSS px. */
const SWIPE_BACK_PX = 80;
/** What runs a sideways swipe of its own, which the swipe back leaves. */
const OWN_SWIPE = '.compact-row, [role="slider"]';
/** How near the sheet's leading edge a swipe back starts, in CSS px. */
const SWIPE_EDGE_PX = 28;

/** How a page came to stand in the sheet, for its entrance. */
type SheetNav = 'push' | 'pop' | 'drag';

/**
 * The compact workspace's one bottom sheet (U12 slice 2). Peek, half and
 * full heights, reached by dragging the grabber or with its arrow keys; a
 * back stack for drill-in pages; at full a focus trap over an inert stage.
 * Escape steps back or down (`sheetEscape`); while a page is open it is
 * the page's wherever focus is. Opening a page moves focus into it, and
 * closing one gives focus back to what opened it. The height is announced
 * as it changes.
 */
export function BottomSheet({
  label,
  state,
  dispatch,
  hasRoot,
  children,
  renderPage,
  reducedMotion = false,
  background,
  companions,
  onHeight,
  onRowRaise,
  rowRaisePreview,
  onPageLower,
  holdFittingRow = false
}: BottomSheetProps) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const grabberRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    moved: boolean;
    /**
     * A tap (no drag) is nothing: started on the row's surface, or on the
     * grabber at peek, where a tap would raise a sheet that holds only its
     * row into blank space.
     */
    tapIsNothing?: boolean;
    /**
     * What the drag shows as it goes: the row's page coming up under it
     * (`raise`), or the row coming back through a page (`lower`).
     */
    morph: 'raise' | 'lower' | null;
    /** A row with nothing under it: the drag only stretches it. */
    hold?: boolean;
  } | null>(null);
  // A swipe from the page's leading edge, which goes back (as a navigation
  // stack's edge swipe does), the page following the finger.
  const swipeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const [swipeX, setSwipeX] = useState<number | null>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [dragMorph, setDragMorph] = useState<'raise' | 'lower' | null>(null);
  // How far the dragged sheet stands between its row (0) and half height
  // (1): the morph's progress, as `--sheet-raise`.
  const [dragRaise, setDragRaise] = useState(0);
  // A page the drag already showed comes in without its own entrance.
  const draggedInRef = useRef(false);
  // Alternates on every change of height, so the reduced-motion fade
  // replays each time.
  const [fadeTurn, setFadeTurn] = useState(false);
  const { detent, stack } = state;
  const page = stack.length > 0 ? stack[stack.length - 1]! : null;
  const drawn = page ? renderPage(page.key) : null;
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  const companionsRef = useRef(companions);
  companionsRef.current = companions;
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;

  const previousDetent = useRef(detent);
  useEffect(() => {
    if (previousDetent.current !== detent) {
      previousDetent.current = detent;
      setFadeTurn((turn) => !turn);
    }
  }, [detent]);

  // The stage beneath a full sheet takes no focus and no taps. A layout
  // effect, so leaving full clears `inert` (in the cleanup, which runs before
  // any layout effect's setup) before the focus return below looks for an
  // opener there, such as the header's More.
  useLayoutEffect(() => {
    if (detent !== 'full') return;
    const elements = (backgroundRef.current?.() ?? []).filter(
      (element): element is Element => Boolean(element)
    );
    const changed = elements.filter(
      (element) => !element.hasAttribute('inert')
    );
    for (const element of changed) {
      element.setAttribute('inert', '');
      element.setAttribute(SHEET_INERT_ATTRIBUTE, '');
    }
    const sheet = sheetRef.current;
    const active = document.activeElement;
    if (
      sheet &&
      !sheet.contains(active) &&
      !active?.closest(`[${SHEET_OVERLAY_ATTRIBUTE}]`)
    ) {
      grabberRef.current?.focus({ preventScroll: true });
    }
    return () => {
      for (const element of changed) {
        element.removeAttribute('inert');
        element.removeAttribute(SHEET_INERT_ATTRIBUTE);
      }
    };
  }, [detent]);

  // The field being typed into stays in view when the page shortens under
  // it. The iOS shell ends the page at the keyboard's top rather than let
  // WebKit scroll the whole page up (which slid the header and Undo under
  // the status bar), so the sheet shrinks as the keyboard rises and a field
  // low in it would go under the mode tabs. Checked after the resize and
  // again once the height's transition ends, when the sheet has its final
  // size. Scrolled by hand inside the sheet: `scrollIntoView` would also
  // scroll the page.
  const revealFocused = useCallback(() => {
    const sheet = sheetRef.current;
    const active = document.activeElement;
    if (!sheet || !(active instanceof HTMLElement)) return;
    if (!sheet.contains(active)) return;
    // A field being typed into, which the keyboard shortened the sheet
    // over: any other control is left where the page put it. Draw's
    // Properties, opened on its Paper control, scrolled its Name away.
    if (!isTextField(active)) return;
    const body = active.closest<HTMLElement>('.compact-sheet-body');
    if (body) revealInside(body, active);
  }, []);
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(revealFocused);
    };
    // The sheet's own size too: WKWebView resized for the keyboard did not
    // reliably report it as a window resize.
    const sheet = sheetRef.current;
    const observer =
      sheet && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(onResize)
        : null;
    if (sheet) observer?.observe(sheet);
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [revealFocused]);

  // Where focus last was, so a page knows what opened it even when that
  // control (a row on the page below) is gone by the time it is drawn.
  const lastFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) {
        lastFocusRef.current = event.target;
      }
    };
    document.addEventListener('focusin', remember);
    return () => document.removeEventListener('focusin', remember);
  }, []);

  // Opening a page moves focus to its first control; closing one gives
  // focus back to what opened it (the row it was drilled from, the header's
  // More), unless focus has already gone somewhere outside the sheet.
  const openersRef = useRef(new Map<string, PageOpener>());
  const previousStackRef = useRef<readonly string[]>([]);
  const stackKeys = stack.map((entry) => entry.key).join('\u0000');
  useLayoutEffect(() => {
    const previous = previousStackRef.current;
    const current = stackKeys === '' ? [] : stackKeys.split('\u0000');
    previousStackRef.current = current;
    const sheet = sheetRef.current;
    if (!sheet) return;
    // The entrance of what now shows: a page pushed slides in from the
    // trailing edge, one popped back to from the leading edge, and one a
    // drag already drew stays as it is.
    if (stackKeys !== previous.join('\u0000')) {
      const nav: SheetNav = draggedInRef.current
        ? 'drag'
        : current.length > previous.length ||
            (current.length === previous.length && current.length > 0)
          ? 'push'
          : 'pop';
      draggedInRef.current = false;
      sheet.dataset.nav = nav;
    }
    const top = current[current.length - 1];
    if (top !== undefined && !previous.includes(top)) {
      const opener = lastFocusRef.current;
      openersRef.current.set(top, {
        element: opener,
        rowId:
          opener?.closest<HTMLElement>('[data-sheet-row]')?.dataset.sheetRow ??
          null
      });
      // Opened from the height slider (Build's tray pulled up by its keys):
      // focus stays on it, so its keys keep moving the sheet, and a held
      // Enter's repeat never lands on the page's first tool (the review).
      if (opener !== null && opener === grabberRef.current) {
        grabberRef.current.focus({ preventScroll: true });
        return;
      }
      const body = sheet.querySelector<HTMLElement>(
        '.compact-sheet-body[data-page]'
      );
      // A page's first control, though never a text field: focus there
      // would raise the on-screen keyboard over a page opened only to look
      // (the All tools sheet's search; Draw's Properties, whose sheet name
      // took the keyboard and left the drawing a sliver beside it). The
      // field is one tap away; a page of fields alone starts on the grabber.
      const items = body ? focusables(body) : [];
      const target = items.find((item) => !isTextField(item));
      (target ?? grabberRef.current)?.focus({ preventScroll: true });
      return;
    }
    // Popped or closed: the lowest page that left is the one whose opener
    // still stands.
    const left = previous.filter((key) => !current.includes(key));
    if (left.length === 0) return;
    const lowest = previous.find((key) => left.includes(key))!;
    const opener = openersRef.current.get(lowest);
    for (const key of left) openersRef.current.delete(key);
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    if (!lost && !sheet.contains(active)) return;
    const visibleBody = sheet.querySelector<HTMLElement>(
      '.compact-sheet-body:not([hidden])'
    );
    const row = opener?.rowId
      ? ([
          ...(visibleBody?.querySelectorAll<HTMLElement>('[data-sheet-row]') ??
            [])
        ].find((element) => element.dataset.sheetRow === opener.rowId) ?? null)
      : null;
    const candidates = [
      opener?.element ?? null,
      row,
      visibleBody && !sheet.hidden
        ? (focusables(visibleBody)[0] ?? null)
        : null,
      sheet.hidden ? null : grabberRef.current
    ];
    candidates.find(canFocus)?.focus({ preventScroll: true });
  }, [stackKeys]);

  // While a page is open, Escape is the page's wherever focus is (the
  // header's More, the stage): it steps back rather than reaching the
  // workspace, where it would cancel the tool under the page. Inside the
  // sheet the sheet's own handler has it first and stops it there; what
  // still arrives from inside came from a control portalled in from
  // another React tree (Draw's tray, drawn by the stage), which that
  // handler never sees. A dialog or the command bar that takes Escape for
  // itself keeps it; the sheet, a dialog itself at full, does not count.
  const hasPages = stack.length > 0;
  useEffect(() => {
    if (!hasPages) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      const owner = target?.closest(
        `[role="dialog"], [role="alertdialog"], .command-bar, [${SHEET_OVERLAY_ATTRIBUTE}]`
      );
      if (owner && owner !== sheetRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: 'pop' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dispatch, hasPages]);

  // Publishes the drawn height for what floats above the sheet.
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const report = () =>
      onHeightRef.current?.(
        detent === 'closed'
          ? 0
          : Math.round(sheet.getBoundingClientRect().height)
      );
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(report);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [detent]);

  const canClose = !hasRoot && stack.length === 0;
  // The workspace's own content at peek is one row (a tray, or a running
  // tool's row): the sheet is that row and a grip. Its Close would do
  // nothing there (the content keeps it at peek) and its Back has no page,
  // so the head is only the grabber: a 44px band behind the row, drawn as
  // a grip above it. A press on the row that is not one of its controls
  // drags the sheet too (its surface).
  const asRow = detent === 'peek' && page === null && hasRoot;
  /** The row raised to `next`: the workspace's to answer, if it will. */
  const rowRaised = (next: SheetDetent, dragged = false) => {
    if (!asRow || (next !== 'half' && next !== 'full')) return false;
    if (onRowRaise?.(next) !== true) return false;
    draggedInRef.current = dragged && rowRaisePreview !== undefined;
    return true;
  };
  /** The page lowered to `next`: back to the row, if the workspace will. */
  const pageLowered = (next: SheetDetent, dragged = false) => {
    if (
      page === null ||
      !onPageLower ||
      (next !== 'peek' && next !== 'closed')
    ) {
      return false;
    }
    draggedInRef.current = dragged;
    onPageLower();
    return true;
  };
  const hostHeight = () =>
    sheetRef.current?.parentElement?.getBoundingClientRect().height ?? 0;
  // A phone held landscape draws the sheet at the stage's side
  // (compact-shell.css), which says so through this property.
  const isSideSheet = () =>
    sheetRef.current
      ? getComputedStyle(sheetRef.current)
          .getPropertyValue('--compact-side-sheet')
          .trim() === '1'
      : false;
  /** The row holds at peek: its content fits there, with nothing under it. */
  const rowHolds = () => {
    if (!asRow || !holdFittingRow || onRowRaise) return false;
    const body = sheetRef.current?.querySelector<HTMLElement>(
      ':scope > .compact-sheet-body:not([data-page])'
    );
    return Boolean(body && body.scrollHeight <= body.clientHeight + 2);
  };
  /** A drag's morph from where it starts: up from the row, down from a page. */
  const morphFrom = (): 'raise' | 'lower' | null =>
    asRow && onRowRaise && rowRaisePreview
      ? 'raise'
      : page !== null && onPageLower
        ? 'lower'
        : null;
  /** Where `height` stands between the row (0) and half height (1). */
  const raiseAt = (height: number) => {
    const host = hostHeight();
    const half = isSideSheet() ? host : host / 2;
    const span = Math.max(1, half - SHEET_PEEK_PX);
    return Math.max(0, Math.min(1, (height - SHEET_PEEK_PX) / span));
  };

  const onGrabberPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !sheetRef.current) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: sheetRef.current.getBoundingClientRect().height,
      moved: false,
      tapIsNothing: asRow,
      morph: morphFrom(),
      hold: rowHolds()
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onGrabberPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = drag.startY - event.clientY;
    if (!drag.moved && Math.abs(delta) < 4) return;
    drag.moved = true;
    // A held row gives a little, less the further it is pulled.
    const height = drag.hold
      ? drag.startHeight +
        HELD_ROW_STRETCH * (1 - 1 / (1 + Math.max(0, delta) / 120))
      : Math.max(0, Math.min(hostHeight(), drag.startHeight + delta));
    setDragHeight(height);
    if (drag.morph) {
      setDragMorph(drag.morph);
      setDragRaise(raiseAt(height));
    }
  };
  const onGrabberPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.moved) {
      const height = drag.startHeight + (drag.startY - event.clientY);
      setDragHeight(null);
      setDragMorph(null);
      if (drag.hold) return;
      const next = nearestDetent(height, hostHeight(), canClose, isSideSheet());
      if (rowRaised(next, true)) return;
      if (drag.morph === 'lower' && pageLowered(next, true)) return;
      dispatch({ type: 'set-detent', detent: next });
    } else if (!drag.tapIsNothing) {
      // A tap toggles between peek and half; from full it comes down.
      dispatch({
        type: 'set-detent',
        detent: detent === 'half' ? 'peek' : 'half'
      });
    }
  };
  const onGrabberPointerCancel = () => {
    dragRef.current = null;
    setDragHeight(null);
    setDragMorph(null);
  };
  // At peek the sheet is its one row (`asRow`): its grabber is a thin grip,
  // so the row's own surface drags it too, between and around its controls.
  // A tap there is nothing; only a drag moves the sheet.
  const onSurfacePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!asRow || event.button !== 0 || !sheetRef.current) return;
    const target = event.target as Element | null;
    if (target?.closest(SURFACE_DRAG_EXCLUDED)) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: sheetRef.current.getBoundingClientRect().height,
      moved: false,
      tapIsNothing: true,
      morph: morphFrom(),
      hold: rowHolds()
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  // A page swiped from its leading edge goes back. Only a swipe that
  // starts at the edge and runs sideways: one up or down is the page's
  // scroll, and the finger anywhere else is the page's own.
  const onPagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || page === null || !sheetRef.current) return;
    // A row with a swipe of its own (History's rollback and actions) keeps
    // it, even begun at the edge.
    if ((event.target as Element | null)?.closest(OWN_SWIPE)) return;
    const box = sheetRef.current.getBoundingClientRect();
    if (event.clientX - box.left > SWIPE_EDGE_PX) return;
    swipeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false
    };
  };
  const onPagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const swipe = swipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;
    if (!swipe.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
        swipeRef.current = null;
        return;
      }
      if (dx < 10 || dx <= Math.abs(dy)) return;
      swipe.active = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    setSwipeX(Math.max(0, dx));
  };
  const onPagePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const swipe = swipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    swipeRef.current = null;
    if (!swipe.active) return;
    setSwipeX(null);
    if (event.clientX - swipe.startX >= SWIPE_BACK_PX) {
      dispatch({ type: 'pop' });
    }
  };
  const onPagePointerCancel = () => {
    swipeRef.current = null;
    setSwipeX(null);
  };

  // A field on a page lowered to peek, tapped to type in: the sheet comes
  // up to half, so what the field finds (All tools' search) shows above
  // the keyboard rather than under the sheet's edge.
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || detent !== 'peek') return;
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !isTextField(target)) return;
      if (!target.closest('.compact-sheet-body[data-page]')) return;
      dispatch({ type: 'set-detent', detent: 'half' });
    };
    sheet.addEventListener('focusin', onFocus);
    return () => sheet.removeEventListener('focusin', onFocus);
  }, [detent, dispatch]);

  // Typing on a page (`is-typing`): the shell gives the tabs' row to the
  // keyboard while a field there has focus (compact-shell.css). It holds
  // through a tap on the sheet's own controls (a name's Save, Back) until
  // that tap is done: Chromium focuses the button as it is pressed, and
  // the tabs coming back then moved the sheet 58px under the finger, so
  // the tap missed it. iOS leaves focus in the field.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const onPage = (node: unknown): node is HTMLElement =>
      node instanceof HTMLElement &&
      sheet.contains(node) &&
      node.closest('.compact-sheet-body[data-page]') !== null;
    let frame = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTyping(typingInActive()));
    };
    const onIn = (event: FocusEvent) => {
      if (onPage(event.target) && typingInActive()) setTyping(true);
    };
    const onOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node && sheet.contains(next))) {
        setTyping(false);
        return;
      }
      document.addEventListener('click', settle, { once: true });
      document.addEventListener('keyup', settle, { once: true });
    };
    sheet.addEventListener('focusin', onIn);
    sheet.addEventListener('focusout', onOut);
    return () => {
      cancelAnimationFrame(frame);
      sheet.removeEventListener('focusin', onIn);
      sheet.removeEventListener('focusout', onOut);
      document.removeEventListener('click', settle);
      document.removeEventListener('keyup', settle);
    };
  }, []);
  // A page that goes takes its field with it.
  useEffect(() => {
    setTyping(typingInActive());
  }, [stackKeys]);

  const onGrabberKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = (next: SheetDetent) => {
      event.preventDefault();
      event.stopPropagation();
      if (rowRaised(next) || pageLowered(next)) return;
      if ((next === 'half' || next === 'full') && rowHolds()) return;
      dispatch({ type: 'set-detent', detent: next });
    };
    switch (event.key) {
      case 'ArrowUp':
      case 'PageUp':
        event.preventDefault();
        event.stopPropagation();
        if (rowRaised('half') || rowHolds()) return;
        dispatch({ type: 'step-up' });
        return;
      case 'ArrowDown':
      case 'PageDown':
        // The slider stops at peek; Escape or the close button go further.
        if (detent === 'peek') {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (detent === 'half' && pageLowered('peek')) return;
        dispatch({
          type: 'set-detent',
          detent: detent === 'full' ? 'half' : 'peek'
        });
        return;
      case 'Home':
        step('peek');
        return;
      case 'End':
        step('full');
        return;
      case 'Enter':
      case ' ':
        step(detent === 'half' ? 'peek' : 'half');
        return;
    }
  };

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        const next = sheetEscape(state, hasRoot);
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        if (state.stack.length > 0) dispatch({ type: 'pop' });
        else dispatch({ type: 'set-detent', detent: next.detent });
        return;
      }
    },
    [dispatch, hasRoot, state]
  );

  // The trap: at full, Tab wraps inside the sheet and its companion layers
  // (the notice over it). Those stand outside the sheet, beside an inert
  // stage, so a trap over the sheet alone left their Undo out of reach of
  // the keyboard. Listened for on the document, as a key pressed on a
  // companion never reaches the sheet's own handler.
  useEffect(() => {
    if (detent !== 'full') return;
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const layers = (companionsRef.current?.() ?? []).filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && !sheet.contains(element)
      );
      const within = (node: unknown) =>
        node instanceof Node &&
        [sheet, ...layers].some((layer) => layer.contains(node));
      if (!within(event.target)) return;
      const own = focusables(sheet);
      const extra = layers.flatMap((layer) => focusables(layer));
      const items = [...own, ...extra];
      if (items.length === 0) return;
      const active = document.activeElement;
      const at = items.indexOf(active as HTMLElement);
      let next: HTMLElement | undefined;
      if (event.shiftKey) {
        if (at === 0 || !within(active)) {
          next = items[items.length - 1];
        } else if (own.length > 0 && at === own.length) {
          // The first companion control steps back into the sheet.
          next = own[own.length - 1];
        }
      } else if (at === items.length - 1) {
        next = items[0];
      } else if (extra.length > 0 && at === own.length - 1) {
        // The sheet's last control steps on to the notice over it.
        next = extra[0];
      }
      if (next) {
        event.preventDefault();
        next.focus();
      }
    };
    document.addEventListener('keydown', onTab);
    return () => document.removeEventListener('keydown', onTab);
  }, [detent]);

  const level = SHEET_DETENTS.indexOf(detent as 'peek');
  const morph = dragHeight !== null ? dragMorph : null;
  const style =
    dragHeight !== null
      ? ({
          height: `${Math.round(dragHeight)}px`,
          ...(morph ? { '--sheet-raise': dragRaise.toFixed(3) } : {})
        } as CSSProperties)
      : undefined;
  return (
    <>
      <section
        ref={sheetRef}
        className={`compact-sheet${dragHeight !== null ? ' is-dragging' : ''}${
          reducedMotion ? ' is-reduced-motion' : ''
        }${fadeTurn ? ' fade-a' : ' fade-b'}${asRow ? ' is-row' : ''}${
          typing && page !== null ? ' is-typing' : ''
        }${
          morph === 'raise'
            ? ' is-raising'
            : morph === 'lower'
              ? ' is-lowering'
              : ''
        }`}
        data-detent={detent}
        aria-label={label}
        hidden={detent === 'closed'}
        style={style}
        onKeyDown={onKeyDown}
        onPointerDown={onSurfacePointerDown}
        onPointerMove={onGrabberPointerMove}
        onPointerUp={onGrabberPointerUp}
        onPointerCancel={onGrabberPointerCancel}
        onAnimationEnd={(event) => {
          // A pop's entrance plays once: a root left marked would slide in
          // again each time the sheet came back from closed.
          const sheet = event.currentTarget;
          if (
            sheet.dataset.nav === 'pop' &&
            event.target instanceof Element &&
            event.target.parentElement === sheet
          ) {
            delete sheet.dataset.nav;
          }
        }}
        onTransitionEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.propertyName === 'height'
          ) {
            revealFocused();
          }
        }}
        {...(detent === 'full' ? { role: 'dialog', 'aria-modal': true } : {})}
      >
        {/* The sheet's own controls and pages keep their Enter; the
          workspace's content under them keeps the workspace's keys. */}
        <div
          className="compact-sheet-head"
          {...{ [OWN_ENTER_ATTRIBUTE]: '' }}
          // The leading edge beside the title swipes back as the page's does.
          onPointerDown={page ? onPagePointerDown : undefined}
          onPointerMove={page ? onPagePointerMove : undefined}
          onPointerUp={page ? onPagePointerUp : undefined}
          onPointerCancel={page ? onPagePointerCancel : undefined}
        >
          {page ? (
            <button
              type="button"
              className="compact-icon-button"
              aria-label="Back"
              onClick={() => dispatch({ type: 'pop' })}
            >
              <ChevronLeft size={22} aria-hidden="true" />
            </button>
          ) : asRow ? null : (
            <span className="compact-sheet-head-spacer" aria-hidden="true" />
          )}
          <div
            ref={grabberRef}
            className="compact-sheet-grabber"
            role="slider"
            tabIndex={0}
            aria-label="Sheet height"
            aria-orientation="vertical"
            aria-valuemin={1}
            aria-valuemax={SHEET_DETENTS.length}
            aria-valuenow={Math.max(1, level + 1)}
            aria-valuetext={SHEET_DETENT_NAMES[detent]}
            onPointerDown={onGrabberPointerDown}
            onPointerMove={onGrabberPointerMove}
            onPointerUp={onGrabberPointerUp}
            onPointerCancel={onGrabberPointerCancel}
            onKeyDown={onGrabberKeyDown}
          >
            <span className="compact-sheet-grip" aria-hidden="true" />
            {page ? (
              <h2 className="compact-sheet-title">{drawn?.title ?? ''}</h2>
            ) : null}
          </div>
          {asRow ? null : (
            <button
              type="button"
              className="compact-icon-button"
              aria-label="Close sheet"
              onClick={() => dispatch({ type: 'close' })}
            >
              <X size={20} aria-hidden="true" />
            </button>
          )}
        </div>
        {/* The workspace's content stays mounted under a pushed page, so a
          form mid-edit keeps what was typed when the page is popped. */}
        {/* Under a page it is inert as well as hidden: drawn through the
          page while that is pulled down, it is a picture, and focus never
          lands on it there. */}
        <div
          className="compact-sheet-body"
          hidden={page !== null}
          inert={page !== null}
        >
          {children}
        </div>
        {page ? (
          <div
            key={page.key}
            data-page={page.key}
            className={`compact-sheet-body${swipeX !== null ? ' is-swiping' : ''}`}
            style={
              swipeX !== null
                ? {
                    transform: `translateX(${Math.round(swipeX)}px)`,
                    opacity: Math.max(0.4, 1 - swipeX / 320)
                  }
                : undefined
            }
            onPointerDown={onPagePointerDown}
            onPointerMove={onPagePointerMove}
            onPointerUp={onPagePointerUp}
            onPointerCancel={onPagePointerCancel}
            {...{ [OWN_ENTER_ATTRIBUTE]: '' }}
          >
            {drawn?.content}
          </div>
        ) : null}
        {/* The page the row opens when let go, drawn as it will stand
          (its head, then its body) and uncovered as the sheet is pulled
          up: a picture only, which the finger never reaches. */}
        {morph === 'raise' && rowRaisePreview ? (
          <div className="compact-sheet-raise" aria-hidden="true" inert>
            <div className="compact-sheet-raise-head">
              <span className="compact-sheet-raise-icon">
                <ChevronLeft size={22} />
              </span>
              <span className="compact-sheet-raise-title">
                <span className="compact-sheet-grip" />
                <span className="compact-sheet-title">
                  {rowRaisePreview.title}
                </span>
              </span>
              <span className="compact-sheet-raise-icon">
                <X size={20} />
              </span>
            </div>
            <div className="compact-sheet-raise-body">
              {rowRaisePreview.content}
            </div>
          </div>
        ) : null}
      </section>
      {/* The height, said once as it changes; outside the sheet so the
        region is in the page before the first announcement. */}
      <span className="visually-hidden" role="status" aria-live="polite">
        {detent === 'closed'
          ? 'Sheet closed'
          : `Sheet ${SHEET_DETENT_NAMES[detent].toLowerCase()}`}
      </span>
    </>
  );
}
