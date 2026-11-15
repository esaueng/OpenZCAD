import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LayoutPanelLeft } from 'lucide-react';
import type {
  PanelLayoutOptions,
  PanelPresetId,
  PanelWidth
} from '../../lib/panelLayout';
import { preloadableLazy } from '../../lib/staleChunk';
import { ErrorBoundary } from '../ErrorBoundary';
import { Tooltip } from '../Tooltip';
import type * as ViewOptionsListModule from './ViewOptionsList';

export type ViewOptionsToggle = 'hidden' | 'locked' | 'compact' | 'hug';

export interface ViewOptionsMenuProps {
  options: PanelLayoutOptions;
  /** The preset the layout is arranged as, if it still is one. */
  preset: PanelPresetId | null;
  /** Hide all's live chord, in the stored grammar; none when unbound. */
  hideShortcut?: string | undefined;
  onPreset(id: PanelPresetId): void;
  onToggle(key: ViewOptionsToggle): void;
  onWidth(width: PanelWidth): void;
}

/** In place of a menu whose code could not load: close, so the button is not left "open" over nothing. */
function CloseFailedMenu({ onClose }: { onClose(): void }) {
  useEffect(onClose, [onClose]);
  return null;
}

/**
 * The panel rail's Panel layout button and its menu: the presets, Hide all,
 * Lock, Compact rows and the column width. (Once "View options", though it
 * holds no view option: those are the rail's own buttons.) Picking an item keeps the menu
 * open, so a setting reads back at once; Escape, a press outside, the button
 * again, Tab or focus moving elsewhere close it. A locked layout disables the
 * presets and the width, which would rearrange or resize every panel, and
 * says why.
 *
 * The menu itself (`ViewOptionsList`, from `load`) loads on the button's
 * first press, or as the pointer or focus reaches the button, so it usually
 * opens in the same frame. The button closes it here rather than in the list,
 * so a menu dismissed while its code is still loading stays dismissed, and
 * one whose code cannot load closes again behind its own boundary (the
 * workspace offers Reload for the missing chunk).
 */
export function createViewOptionsMenu(
  load: () => Promise<typeof ViewOptionsListModule> = () =>
    import('./ViewOptionsList')
) {
  const ViewOptionsList = preloadableLazy(() =>
    load().then((module) => ({ default: module.ViewOptionsList }))
  );
  /** A failed warm-up is left to the press, which reports a stale chunk. */
  const warm = () => {
    ViewOptionsList.preload().catch(() => undefined);
  };
  return function ViewOptionsMenu(props: ViewOptionsMenuProps) {
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const close = useCallback(() => setOpen(false), []);
    useEffect(() => {
      if (!open) return;
      const inside = (target: EventTarget | null) =>
        target instanceof Node &&
        (menuRef.current?.contains(target) === true ||
          buttonRef.current?.contains(target) === true);
      // The button toggles the menu itself.
      const onPointerDown = (event: PointerEvent) => {
        if (!inside(event.target)) close();
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        close();
      };
      const onFocusIn = (event: FocusEvent) => {
        if (!inside(event.target)) close();
      };
      window.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('focusin', onFocusIn, true);
      return () => {
        window.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('focusin', onFocusIn, true);
      };
    }, [open, close]);
    return (
      <>
        <Tooltip
          label="Panel layout"
          description="Presets, Hide all, Lock, Compact and Width"
        >
          <button
            ref={buttonRef}
            type="button"
            className={`rail-button${open ? ' active' : ''}`}
            aria-label="Panel layout"
            aria-haspopup="menu"
            aria-expanded={open}
            onPointerEnter={warm}
            onFocus={warm}
            onClick={() => setOpen((current) => !current)}
          >
            <LayoutPanelLeft size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        {open &&
          createPortal(
            <ErrorBoundary
              label="Panel layout menu"
              fallback={<CloseFailedMenu onClose={close} />}
            >
              <Suspense fallback={null}>
                <ViewOptionsList
                  {...props}
                  anchorRef={buttonRef}
                  menuRef={menuRef}
                  onClose={close}
                />
              </Suspense>
            </ErrorBoundary>,
            document.body
          )}
      </>
    );
  };
}

export const ViewOptionsMenu = createViewOptionsMenu();

/**
 * While Hide all is on, what says so and brings the panels back. The
 * layout is kept, so Show returns every panel where it was.
 */
export function PanelsHiddenPill({ onShow }: { onShow(): void }) {
  return (
    <div className="panels-hidden-pill">
      <span role="status">Panels hidden</span>
      <span aria-hidden="true">·</span>
      <button type="button" aria-label="Show panels" onClick={onShow}>
        Show
      </button>
    </div>
  );
}
