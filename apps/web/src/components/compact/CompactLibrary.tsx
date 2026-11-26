import { LayoutGrid, List, Search, Settings, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject
} from 'react';
import { createPortal } from 'react-dom';

/** The compact library's shelves: the three stores, and Shared beside them. */
export type CompactShelf = 'active' | 'archived' | 'deleted' | 'shared';

/** One action a swiped row offers; each is also in the tile's ⋯ sheet. */
export interface CompactSwipeAction {
  key: string;
  /** The button's one word. */
  text: string;
  /** Its full accessible name, which says which project. */
  label: string;
  tone?: 'danger';
  disabled?: boolean;
  run(): void;
}

export interface CompactLibraryProps {
  /** The start screen's root, where rows are swiped and held. */
  rootRef: RefObject<HTMLElement | null>;
  shelf: CompactShelf;
  /** Each shelf's count; null while the library loads. */
  counts: Record<CompactShelf, number> | null;
  onShelf(shelf: CompactShelf): void;
  query: string;
  onQuery(query: string): void;
  layout: 'grid' | 'list';
  onLayout(layout: 'grid' | 'list'): void;
  onOpenSettings(): void;
  /** What a project's row offers when swiped; empty offers nothing. */
  swipeActions(projectId: string): readonly CompactSwipeAction[];
  /** A press held on a row: picks it, as the hover checkbox does. */
  onHold(projectId: string): void;
}

const SHELVES: readonly { shelf: CompactShelf; label: string }[] = [
  { shelf: 'active', label: 'Projects' },
  { shelf: 'shared', label: 'Shared' },
  { shelf: 'archived', label: 'Archive' },
  { shelf: 'deleted', label: 'Trash' }
];

/** How far a finger moves before a press becomes a swipe or a scroll. */
const SLOP_PX = 10;
/** How long a still press is held before it picks the row. */
const HOLD_MS = 500;
/** Each revealed action's width. */
const ACTION_PX = 84;

/** What a row's own controls keep for themselves. */
const NOT_A_SWIPE =
  '.start-tile-actions, .start-tile-menu, .start-tile-select, .start-tile-footer, .start-tile-copies, input, textarea, select, .compact-swipe-actions';

interface Press {
  pointerId: number;
  tile: HTMLElement;
  projectId: string;
  startX: number;
  startY: number;
  /** The row's offset when the press began: open rows start revealed. */
  base: number;
  mode: 'pending' | 'swipe' | 'scroll';
  hold: number | null;
}

/** A finger or pen on a revealed action, which runs when it lifts. */
interface ActionPress {
  pointerId: number;
  projectId: string;
  key: string;
  startX: number;
  startY: number;
}

/**
 * Swipe and hold on the library's rows (U12 slice 10). A finger dragged
 * left across a project reveals its shelf actions (Archive and Trash on
 * Projects); a still press held on it picks it for the selection bar.
 * Touch and pen only: a mouse keeps the regular drag to reorder.
 */
function SwipeLayer({
  rootRef,
  swipeActions,
  onHold
}: Pick<CompactLibraryProps, 'rootRef' | 'swipeActions' | 'onHold'>) {
  const [open, setOpen] = useState<{
    tile: HTMLElement;
    projectId: string;
  } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const actionsRef = useRef(swipeActions);
  actionsRef.current = swipeActions;
  const holdRef = useRef(onHold);
  holdRef.current = onHold;

  const setOffset = useCallback((tile: HTMLElement, px: number | null) => {
    if (px === null) {
      tile.style.removeProperty('--swipe-x');
      tile.classList.remove('is-swiping');
      return;
    }
    tile.style.setProperty('--swipe-x', `${Math.round(px)}px`);
  }, []);

  const close = useCallback(() => {
    const current = openRef.current;
    if (current) setOffset(current.tile, null);
    setOpen(null);
  }, [setOffset]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let press: Press | null = null;
    let actionPress: ActionPress | null = null;
    // The click a swipe or a hold ends with is not a tap on the row, and the
    // one after an action already run on release is not a second tap on
    // anything. Each press starts clear: a click the browser never sent must
    // not eat the next tap.
    let swallowClick: 'none' | 'row' | 'all' = 'none';

    const width = (projectId: string) =>
      actionsRef.current(projectId).length * ACTION_PX;

    const end = () => {
      if (press?.hold) window.clearTimeout(press.hold);
      press = null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary) return;
      swallowClick = 'none';
      actionPress = null;
      if (event.pointerType === 'mouse') return;
      const target = event.target instanceof Element ? event.target : null;
      const current = openRef.current;
      // A revealed action answers its finger when it lifts, not on the
      // click the browser may make of it: Chromium on Linux and ChromeOS
      // drops the tap that stops a fling, and the swipe's release flings.
      const action = target?.closest<HTMLElement>(
        '.compact-swipe-action[data-action]'
      );
      if (current && action && current.tile.contains(action)) {
        actionPress = {
          pointerId: event.pointerId,
          projectId: current.projectId,
          key: action.dataset.action!,
          startX: event.clientX,
          startY: event.clientY
        };
        return;
      }
      // A press anywhere but on the open row's actions puts it back, and
      // only that: its click opens nothing.
      if (current && !target?.closest('.compact-swipe-actions')) {
        close();
        swallowClick = 'row';
        if (current.tile.contains(target)) return;
      }
      if (!target || target.closest(NOT_A_SWIPE)) return;
      const tile = target.closest<HTMLElement>(
        '.start-tile-project[data-tile-id]'
      );
      const projectId = tile?.dataset.tileId;
      if (!tile || !projectId) return;
      press = {
        pointerId: event.pointerId,
        tile,
        projectId,
        startX: event.clientX,
        startY: event.clientY,
        base: 0,
        mode: 'pending',
        hold: window.setTimeout(() => {
          if (!press || press.mode !== 'pending') return;
          press.hold = null;
          swallowClick = 'row';
          holdRef.current(projectId);
          press.mode = 'scroll';
        }, HOLD_MS)
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.pointerId) return;
      const dx = event.clientX - press.startX;
      const dy = event.clientY - press.startY;
      if (press.mode === 'pending') {
        if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
        if (press.hold) {
          window.clearTimeout(press.hold);
          press.hold = null;
        }
        const room = width(press.projectId);
        if (Math.abs(dx) > Math.abs(dy) && dx < 0 && room > 0) {
          press.mode = 'swipe';
          press.tile.classList.add('is-swiping');
        } else {
          press.mode = 'scroll';
          return;
        }
      }
      if (press.mode !== 'swipe') return;
      const room = width(press.projectId);
      setOffset(
        press.tile,
        Math.max(-room * 1.15, Math.min(0, press.base + dx))
      );
    };

    const onPointerUp = (event: PointerEvent) => {
      if (actionPress && event.pointerId === actionPress.pointerId) {
        const { projectId, key, startX, startY } = actionPress;
        actionPress = null;
        const still =
          Math.abs(event.clientX - startX) < SLOP_PX &&
          Math.abs(event.clientY - startY) < SLOP_PX;
        const action = actionsRef
          .current(projectId)
          .find((entry) => entry.key === key);
        if (!still || openRef.current?.projectId !== projectId) return;
        if (!action || action.disabled) return;
        swallowClick = 'all';
        close();
        action.run();
        return;
      }
      if (!press || event.pointerId !== press.pointerId) return;
      const { tile, projectId, mode, startX } = press;
      end();
      if (mode !== 'swipe') return;
      swallowClick = 'row';
      tile.classList.remove('is-swiping');
      const room = width(projectId);
      if (event.clientX - startX < -room / 2) {
        setOffset(tile, -room);
        setOpen({ tile, projectId });
      } else {
        setOffset(tile, null);
      }
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (actionPress?.pointerId === event.pointerId) actionPress = null;
      if (!press || event.pointerId !== press.pointerId) return;
      const { tile, mode } = press;
      end();
      if (mode === 'swipe') setOffset(tile, null);
    };

    const onClick = (event: MouseEvent) => {
      if (swallowClick === 'none') return;
      const all = swallowClick === 'all';
      swallowClick = 'none';
      const target = event.target instanceof Element ? event.target : null;
      if (!all && target?.closest('.compact-swipe-actions')) return;
      event.preventDefault();
      event.stopPropagation();
    };

    // A held press is this layer's, not the browser's text menu.
    const onContextMenu = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.start-tile-project')) event.preventDefault();
    };

    root.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    root.addEventListener('click', onClick, true);
    root.addEventListener('contextmenu', onContextMenu);
    return () => {
      end();
      root.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      root.removeEventListener('click', onClick, true);
      root.removeEventListener('contextmenu', onContextMenu);
    };
  }, [close, rootRef, setOffset]);

  // A row that left (archived, moved, filtered away) leaves nothing open;
  // the next press clears what is held.
  if (!open || !open.tile.isConnected) return null;
  const actions = swipeActions(open.projectId);
  return createPortal(
    <div
      className="compact-swipe-actions"
      role="group"
      aria-label="Row actions"
    >
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          className={`compact-swipe-action${
            action.tone === 'danger' ? ' is-danger' : ''
          }`}
          aria-label={action.label}
          data-action={action.key}
          disabled={action.disabled}
          // A mouse or the keyboard; a finger's lift has already run it.
          onClick={() => {
            close();
            action.run();
          }}
        >
          <span aria-hidden="true">{action.text}</span>
        </button>
      ))}
    </div>,
    open.tile
  );
}

/**
 * The compact library's head (U12 slice 10): the page's name and Settings,
 * search on top, the shelves as a segmented control and the grid or list.
 * Loaded only where the compact layout is in force; the rest of the library
 * is the regular start screen's, drawn for a phone by `compact-library.css`.
 */
export default function CompactLibrary({
  rootRef,
  shelf,
  counts,
  onShelf,
  query,
  onQuery,
  layout,
  onLayout,
  onOpenSettings,
  swipeActions,
  onHold
}: CompactLibraryProps) {
  return (
    <div className="compact-library-head">
      <div className="compact-library-top">
        <h1 className="compact-library-title">Projects</h1>
        <div
          className="compact-library-layout"
          role="group"
          aria-label="Layout"
        >
          <button
            type="button"
            className="compact-icon-button"
            aria-label="Grid"
            aria-pressed={layout === 'grid'}
            onClick={() => onLayout('grid')}
          >
            <LayoutGrid size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="compact-icon-button"
            aria-label="List"
            aria-pressed={layout === 'list'}
            onClick={() => onLayout('list')}
          >
            <List size={20} aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          className="compact-icon-button"
          aria-label="Open settings"
          onClick={onOpenSettings}
        >
          <Settings size={22} aria-hidden="true" />
        </button>
      </div>
      <label className="compact-library-search">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          value={query}
          aria-label="Search projects"
          placeholder="Search"
          enterKeyHint="search"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.stopPropagation();
              onQuery('');
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="compact-library-clear"
            aria-label="Clear search"
            onClick={() => onQuery('')}
          >
            <X size={16} aria-hidden="true" />
          </button>
        ) : null}
      </label>
      <div className="compact-segmented" role="group" aria-label="Shelves">
        {SHELVES.map((entry) => (
          <button
            key={entry.shelf}
            type="button"
            className="compact-segment"
            aria-pressed={shelf === entry.shelf}
            aria-label={entry.label}
            onClick={() => onShelf(entry.shelf)}
          >
            <span className="compact-segment-label" aria-hidden="true">
              {entry.label}
            </span>
            {counts && counts[entry.shelf] > 0 ? (
              <span className="compact-segment-count" aria-hidden="true">
                {counts[entry.shelf]}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <SwipeLayer
        rootRef={rootRef}
        swipeActions={swipeActions}
        onHold={onHold}
      />
    </div>
  );
}
