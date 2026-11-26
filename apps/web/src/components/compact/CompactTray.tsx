import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useCompactTray } from './compactSlots';

/** One verb in a mode's tray: a 44 px icon with its name for assistive tech. */
export interface TrayItem {
  /** The page it opens, or its own id for a verb that opens none. */
  key: string;
  label: string;
  icon: ReactNode;
  /** A switch's state (Measure); absent for a verb that opens a page. */
  pressed?: boolean;
  /** A dot on the icon: the page's subject is on (a section cut). */
  on?: boolean;
  disabledReason?: string | null;
  onPress(): void;
}

/**
 * A mode's tray (U12 slice 7): the sheet's row at peek, icons only. Each
 * verb opens its page over the tray, where the sheet's Back returns.
 */
export function TrayRow({
  label,
  items,
  page
}: {
  label: string;
  items: readonly TrayItem[];
  page: string | null;
}) {
  return (
    <div className="compact-tray is-mode" role="toolbar" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`compact-tray-button${item.on ? ' is-on' : ''}`}
          aria-label={item.label}
          title={item.disabledReason ?? item.label}
          disabled={Boolean(item.disabledReason)}
          {...(item.pressed === undefined
            ? { 'aria-expanded': page === item.key }
            : { 'aria-pressed': item.pressed })}
          data-tray-item={item.key}
          onClick={item.onPress}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}

/** How long a sheet's change of height takes at most (its spring). */
const SHEET_SETTLE_MS = 420;

/**
 * Runs `run` once the sheet around `from` has stopped moving: its height
 * transition ended, or the longest one has had time to. Returns a cancel.
 */
export function whenSheetSettles(
  from: Element | null,
  run: () => void
): () => void {
  const sheet = from?.closest('.compact-sheet') ?? null;
  let done = false;
  const onEnd = (event: Event) => {
    if (
      event.target === sheet &&
      (event as TransitionEvent).propertyName === 'height'
    ) {
      finish();
    }
  };
  const timer = window.setTimeout(() => finish(), SHEET_SETTLE_MS);
  sheet?.addEventListener('transitionend', onEnd);
  function stop() {
    done = true;
    window.clearTimeout(timer);
    sheet?.removeEventListener('transitionend', onEnd);
  }
  function finish() {
    if (done) return;
    stop();
    run();
  }
  return stop;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The open page's content, drawn into the sheet's page (a portal), so it
 * keeps the tray's state and the workspace's handlers. Focus follows the
 * page in: the sheet moves it into a page as it opens, but this content
 * arrives a render later, after the sheet has settled for its grabber.
 * Opening a page also asks for the model to be kept in view above the
 * sheet (I47), once the sheet has risen.
 */
export function TrayPage({
  page,
  children,
  onStageCovered
}: {
  page: string;
  children: ReactNode;
  onStageCovered?(): void;
}) {
  const tray = useCompactTray();
  const host = tray?.page === page ? tray.pageHost : null;
  const focused = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!host || focused.current === host) return;
    focused.current = host;
    const active = document.activeElement;
    const sheet = host.closest('.compact-sheet');
    const onSheetChrome =
      active === document.body ||
      active === null ||
      Boolean(active.closest('.compact-sheet-head')) ||
      !active.isConnected;
    if (sheet && onSheetChrome) {
      host
        .querySelector<HTMLElement>(FOCUSABLE)
        ?.focus({ preventScroll: true });
    }
  }, [host]);
  const coveredRef = useRef(onStageCovered);
  coveredRef.current = onStageCovered;
  useEffect(() => {
    if (!host) return;
    return whenSheetSettles(host, () => coveredRef.current?.());
  }, [host]);
  return host ? createPortal(children, host) : null;
}

/**
 * A tray leaving (another mode's tray takes its place, or a mode without
 * one) takes its open page with it: the sheet would otherwise keep a page
 * whose content no tray draws any more.
 */
export function useTrayPagesLeaveWithTray() {
  const tray = useCompactTray();
  const trayRef = useRef(tray);
  trayRef.current = tray;
  useEffect(
    () => () => {
      if (trayRef.current?.page) trayRef.current.closePage();
    },
    []
  );
}
