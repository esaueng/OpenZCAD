import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, GripVertical, Pin, X } from 'lucide-react';
import type { PanelId, PanelStatus } from '../../lib/panelLayout';
import {
  ContextMenu,
  type ContextMenuItem,
  type ContextMenuState
} from '../ContextMenu';
import { Tooltip } from '../Tooltip';
import { PANEL_ICONS, PANEL_TITLES } from './panelMeta';

/**
 * Where a panel is drawn: in a docked column, in a floating window, in the
 * temporary slot (`unpinned`; `revealed` is a parked docked panel shown
 * there), which stands beside the rail or under a docked column's own
 * panels, or alone in the phone lane.
 */
export type PanelPlacement =
  'docked' | 'floating' | 'unpinned' | 'revealed' | 'phone';

/**
 * What the dock adds to a panel it draws: moving it by its header, by the
 * Move menu and by keys. The phone lane draws without a dock, so a panel
 * there has none of it.
 */
export interface PanelDockControls {
  /** A press on the header, which becomes a drag once it moves 4px. */
  onHeaderPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  /** The Move menu's items as the layout stands when it opens. */
  moveItems(): ContextMenuItem[];
  onMove(itemId: string): void;
  /**
   * Keys on the grip: Alt+↑/↓ move the panel in its stack; a floating
   * window moves with the arrows and resizes with Shift. True when used.
   */
  onGripKey(event: ReactKeyboardEvent<HTMLElement>): boolean;
  /** Absent where Pop out would not move the panel (alone in a window). */
  onPopOut?: () => void;
  /**
   * Where the panel hugs its content (a docked column): its natural height
   * whenever that changes, header, content and frame together.
   */
  onNaturalHeight?: (height: number) => void;
}

/** The header menu's own items, kept apart from the Move menu's targets. */
const HEADER_PIN = 'panel-header:pin';
const HEADER_POP_OUT = 'panel-header:pop-out';
const HEADER_CLOSE = 'panel-header:close';

/** What the Pin button's tooltip says of a panel in each state. */
export const TEMPORARY_HINT = 'Temporary: the next panel you open replaces it';
export const PINNED_HINT = 'Pinned: it stays open beside your other panels';
export const FLOATING_HINT = 'Dock it in the right column';

/** What a panel's frame needs from the layout, and what it can ask of it. */
export interface PanelControls {
  placement: PanelPlacement;
  /** The panel's state in the stored layout, whatever the placement. */
  status: PanelStatus;
  /** Panel layout' Compact rows: tighter rows, the same controls. */
  compact?: boolean;
  /** The workspace command handles Escape before a temporary panel closes. */
  commandActive?: boolean;
  onPin(): void;
  onUnpin(): void;
  onClose(): void;
  /** Phone panels share one lane; clear it without rearranging saved docks. */
  onHidePanels?(): void;
  /** Pressed or focused: the panel becomes the most recently used. */
  onUse(): void;
  dock?: PanelDockControls;
}

/**
 * Every panel's frame: a header with the grip (the Move menu), the icon, the
 * title and count as a heading, any panel controls, Pin, Pop out and Close;
 * and the body, which scrolls. An unpinned panel says it is temporary once,
 * on its Pin button: a footer repeating that, with a second Pin, stood
 * taller than a one-row History. The phone lane, where nothing pins, keeps
 * a footer for Hide panels. There is no fold: an open panel is fully open.
 */
export function PanelFrame({
  id,
  count,
  actions,
  controls,
  children
}: {
  id: PanelId;
  /** Shown beside the title, and part of the heading's name, when above 0. */
  count: number;
  /** Panel controls in the header, before Pin. */
  actions?: ReactNode;
  controls: PanelControls;
  children: ReactNode;
}) {
  const title = PANEL_TITLES[id];
  const Icon = PANEL_ICONS[id];
  // In the phone lane nothing docks, whatever the saved layout says: the
  // button reads unpinned and a press is refused, never an unpin that would
  // drop the panel from its dock for when the window widens again.
  const pinned = controls.status === 'docked' && controls.placement !== 'phone';
  const dock = controls.dock;
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const onNaturalHeight = dock?.onNaturalHeight;
  const reportNaturalHeight = useRef(onNaturalHeight);
  reportNaturalHeight.current = onNaturalHeight;
  const measuresNaturalHeight = Boolean(onNaturalHeight);
  // Without ResizeObserver retain the render-driven fallback. In browsers
  // with it, a fresh callback alone must not force synchronous layout again.
  const fallbackMeasure =
    typeof ResizeObserver === 'undefined' ? onNaturalHeight : null;
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!measuresNaturalHeight || !section || !body || !content) return;
    const measure = () => {
      // The frame as drawn, less the body's box, plus the body's padding and
      // its content at its own height: what the panel takes with room to
      // spare, whatever height it is drawn at now.
      const style = getComputedStyle(body);
      const padding =
        (parseFloat(style.paddingTop) || 0) +
        (parseFloat(style.paddingBottom) || 0);
      const natural =
        section.getBoundingClientRect().height -
        body.getBoundingClientRect().height +
        padding +
        content.getBoundingClientRect().height;
      if (natural > 0) reportNaturalHeight.current?.(Math.ceil(natural));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    // The header and the footer change the frame without the content.
    for (const child of Array.from(section.children)) {
      if (child !== body) observer.observe(child);
    }
    return () => observer.disconnect();
  }, [
    id,
    controls.placement,
    controls.compact,
    measuresNaturalHeight,
    fallbackMeasure
  ]);
  useLayoutEffect(() => {
    if (
      controls.placement === 'unpinned' ||
      controls.placement === 'revealed' ||
      controls.placement === 'phone'
    ) {
      const active = document.activeElement;
      const fromRail = active?.matches(`[data-model-panel-rail="${id}"]`);
      const lostFocus =
        active === document.body &&
        !document.querySelector('.in-place-command');
      if (fromRail || lostFocus)
        sectionRef.current?.focus({ preventScroll: true });
    }
  }, [id, controls.placement]);
  return (
    <section
      ref={sectionRef}
      className={`model-panel model-panel-${id} is-${controls.placement}${controls.compact ? ' is-compact' : ''}`}
      aria-label={title}
      data-panel={id}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          !['unpinned', 'revealed', 'phone'].includes(controls.placement)
        )
          return;
        // An active command owns Escape before a temporary inspection does.
        if (
          controls.commandActive ||
          document.querySelector('.in-place-command')
        )
          return;
        if (
          (event.target as HTMLElement).closest(
            'input, textarea, select, [contenteditable="true"]'
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        controls.onClose();
      }}
      onPointerDownCapture={controls.onUse}
      onFocusCapture={controls.onUse}
    >
      <header
        className={`model-panel-header${dock ? ' is-draggable' : ''}`}
        onPointerDown={dock?.onHeaderPointerDown}
        // A right-click on the header reaches the panel's own actions, as
        // its buttons and Move menu offer them, instead of the browser's
        // menu (design review I19).
        onContextMenu={(event) => {
          event.preventDefault();
          const moveItems = dock?.moveItems() ?? [];
          setMenu({
            x: event.clientX,
            y: event.clientY,
            heading: title,
            items: [
              ...(controls.placement !== 'phone'
                ? [
                    {
                      id: HEADER_PIN,
                      label: pinned ? `Unpin ${title}` : `Pin ${title}`
                    }
                  ]
                : []),
              ...(dock?.onPopOut
                ? [{ id: HEADER_POP_OUT, label: `Pop out ${title}` }]
                : []),
              ...moveItems.map((item, index) =>
                index === 0 ? { ...item, section: true } : item
              ),
              { id: HEADER_CLOSE, label: `Close ${title}`, section: true }
            ]
          });
        }}
      >
        {dock ? (
          <button
            type="button"
            className="model-panel-grip"
            aria-label={`Move ${title}`}
            aria-haspopup="menu"
            // Only while open: a closed panel header carries no
            // `aria-expanded` at all, since nothing in it folds.
            aria-expanded={menu?.heading === `Move ${title}` ? true : undefined}
            title={`Drag to move ${title} · press for the Move menu`}
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              setMenu({
                x: bounds.left,
                y: bounds.bottom + 4,
                heading: `Move ${title}`,
                items: dock.moveItems()
              });
            }}
            onKeyDown={(event) => {
              if (dock.onGripKey(event)) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            <GripVertical size={14} aria-hidden="true" />
          </button>
        ) : (
          <span className="model-panel-grip" aria-hidden="true">
            <GripVertical size={14} />
          </span>
        )}
        <Icon size={13} className="model-panel-icon" aria-hidden="true" />
        <h2 className="model-panel-title">
          <span className="model-panel-name">{title}</span>
          {count > 0 && (
            <>
              {/* A space, so the heading's name reads "History 2". */}{' '}
              <span className="model-panel-count">{count}</span>
            </>
          )}
        </h2>
        {actions}
        {controls.placement !== 'phone' && (
          // The one place a temporary panel says so, and the one Pin: the
          // tooltip opens on hover and on keyboard focus, and describes the
          // button while it shows.
          <Tooltip
            label={pinned ? `Unpin ${title}` : `Pin ${title}`}
            description={
              pinned
                ? PINNED_HINT
                : controls.status === 'unpinned'
                  ? TEMPORARY_HINT
                  : FLOATING_HINT
            }
            multiline
          >
            <button
              type="button"
              className={`model-panel-action model-panel-pin${pinned ? ' is-pinned' : ''}`}
              aria-label={`Pin ${title}`}
              aria-pressed={pinned}
              onClick={pinned ? controls.onUnpin : controls.onPin}
            >
              <Pin
                size={14}
                fill={pinned ? 'currentColor' : 'none'}
                aria-hidden="true"
              />
            </button>
          </Tooltip>
        )}
        {dock?.onPopOut && (
          <Tooltip
            label={`Pop out ${title}`}
            description="Float it over the model"
          >
            <button
              type="button"
              className="model-panel-action"
              aria-label={`Pop out ${title}`}
              onClick={dock.onPopOut}
            >
              <ExternalLink size={14} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
        <Tooltip label={`Close ${title}`}>
          <button
            type="button"
            className="model-panel-action"
            aria-label={`Close ${title}`}
            onClick={controls.onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      </header>
      <div className="model-panel-body" ref={bodyRef}>
        {/* Its own height, never the body's: what the panel hugs. */}
        <div className="model-panel-content" ref={contentRef}>
          {children}
        </div>
      </div>
      {controls.placement === 'phone' && (
        <footer className="model-panel-footer">
          <span>Panels share this space.</span>
          {controls.onHidePanels && (
            <button
              type="button"
              className="model-panel-footer-pin"
              onClick={controls.onHidePanels}
            >
              Hide panels
            </button>
          )}
        </footer>
      )}
      {/* In the body, so the menu stands over every island rather than
          inside the dock's layer. */}
      {menu &&
        createPortal(
          <ContextMenu
            menu={menu}
            onSelect={(itemId) => {
              if (itemId === HEADER_PIN) {
                if (pinned) controls.onUnpin();
                else controls.onPin();
              } else if (itemId === HEADER_POP_OUT) {
                dock?.onPopOut?.();
              } else if (itemId === HEADER_CLOSE) {
                controls.onClose();
              } else {
                dock?.onMove(itemId);
              }
            }}
            onClose={() => setMenu(null)}
          />,
          document.body
        )}
    </section>
  );
}
