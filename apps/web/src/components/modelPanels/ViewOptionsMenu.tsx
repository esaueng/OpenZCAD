import { Suspense, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LayoutPanelLeft } from 'lucide-react';
import type {
  PanelLayoutOptions,
  PanelPresetId,
  PanelWidth
} from '../../lib/panelLayout';
import { preloadableLazy } from '../../lib/staleChunk';
import { Tooltip } from '../Tooltip';

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

/**
 * The menu loads on the button's first press, or as the pointer reaches the
 * button, so it opens in the same frame: an open menu stays out of the
 * entry chunk until someone asks for it.
 */
const ViewOptionsList = preloadableLazy(() =>
  import('./ViewOptionsList').then((module) => ({
    default: module.ViewOptionsList
  }))
);
/** A failed warm-up is left to the press, which reports a stale chunk. */
function warmViewOptionsList() {
  ViewOptionsList.preload().catch(() => undefined);
}

/**
 * The panel rail's Panel layout button and its menu: the presets, Hide all,
 * Lock, Compact rows and the column width. (Once "View options", though it
 * holds no view option: those are the rail's own buttons.) Picking an item keeps the menu
 * open, so a setting reads back at once; Escape, a press outside, the button
 * again or Tab close it. A locked layout disables the presets and the width,
 * which would rearrange or resize every panel, and says why.
 */
export function ViewOptionsMenu(props: ViewOptionsMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
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
          onPointerEnter={warmViewOptionsList}
          onFocus={warmViewOptionsList}
          onClick={() => setOpen((current) => !current)}
        >
          <LayoutPanelLeft size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      {open &&
        createPortal(
          <Suspense fallback={null}>
            <ViewOptionsList
              {...props}
              anchorRef={buttonRef}
              onClose={() => setOpen(false)}
            />
          </Suspense>,
          document.body
        )}
    </>
  );
}

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
