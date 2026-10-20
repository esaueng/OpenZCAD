import type { ReactNode } from 'react';
import { GripVertical, Pin, X } from 'lucide-react';
import type { PanelId, PanelStatus } from '../../lib/panelLayout';
import { PANEL_ICONS, PANEL_TITLES } from './panelMeta';

/**
 * Where a panel is drawn: in a docked column, in the unpinned slot beside the
 * rail (`revealed` is a parked docked panel shown there), or alone in the
 * phone lane.
 */
export type PanelPlacement = 'docked' | 'unpinned' | 'revealed' | 'phone';

/** What a panel's frame needs from the layout, and what it can ask of it. */
export interface PanelControls {
  placement: PanelPlacement;
  /** The panel's state in the stored layout, whatever the placement. */
  status: PanelStatus;
  onPin(): void;
  onUnpin(): void;
  onClose(): void;
  /** Pressed or focused: the panel becomes the most recently used. */
  onUse(): void;
}

/**
 * Every panel's frame: a header with the grip, the icon, the title and count
 * as a heading, any panel controls, Pin and Close; the body, which scrolls;
 * and, while the panel is unpinned, a footer saying so. There is no fold: an
 * open panel is fully open.
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
  return (
    <section
      className={`model-panel model-panel-${id} is-${controls.placement}`}
      aria-label={title}
      data-panel={id}
      onPointerDownCapture={controls.onUse}
      onFocusCapture={controls.onUse}
    >
      <header className="model-panel-header">
        {/* Moving a panel by its header arrives with the drag-and-drop slice;
            the grip already marks the handle. */}
        <span className="model-panel-grip" aria-hidden="true">
          <GripVertical size={14} />
        </span>
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
        <button
          type="button"
          className={`model-panel-action model-panel-pin${pinned ? ' is-pinned' : ''}`}
          aria-label={`Pin ${title}`}
          aria-pressed={pinned}
          title={
            pinned ? `Pinned · unpin ${title}` : `Pin ${title} · keep it open`
          }
          onClick={pinned ? controls.onUnpin : controls.onPin}
        >
          <Pin
            size={14}
            fill={pinned ? 'currentColor' : 'none'}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          className="model-panel-action"
          aria-label={`Close ${title}`}
          title={`Close ${title}`}
          onClick={controls.onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="model-panel-body">{children}</div>
      {controls.status === 'unpinned' && (
        <footer className="model-panel-footer">
          <span>Unpinned — the next panel you open replaces it</span>
          <button
            type="button"
            className="model-panel-footer-pin"
            onClick={controls.onPin}
          >
            Pin
          </button>
        </footer>
      )}
    </section>
  );
}
