import {
  AlertTriangle,
  History,
  Layers,
  ListOrdered,
  MessageSquare,
  SlidersHorizontal,
  type LucideIcon
} from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { CompactPanels } from './compactSlots';
import { COMPACT_PANEL_TITLES, type CompactPanelId } from './panelSheet';

/** The regular panels' rail glyphs, and Comments' own. */
const ICONS: Readonly<Record<CompactPanelId, LucideIcon>> = {
  history: ListOrdered,
  bodies: Layers,
  parameters: SlidersHorizontal,
  revisions: History,
  diagnostics: AlertTriangle,
  comments: MessageSquare
};

/**
 * The panel sheet's page (U12 slice 5): a segmented control over the open
 * panel's body. Each segment is an icon with the panel's name as its
 * accessible name; the active one also shows that word. Arrow keys move
 * between segments, as in a tab list.
 */
export function CompactPanelSheet({ panels }: { panels: CompactPanels }) {
  const { open, available, content, onOpen } = panels;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0 || open === null) return;
    event.preventDefault();
    const list = event.currentTarget;
    const at = available.indexOf(open);
    const next =
      available[(at + step + available.length) % available.length] ?? open;
    onOpen(next);
    requestAnimationFrame(() =>
      list.querySelector<HTMLElement>(`[data-panel-segment="${next}"]`)?.focus()
    );
  };
  return (
    <div className="compact-panel-sheet">
      {/* Opaque from edge to edge, so the rows scrolled under the tabs do
          not show around them. */}
      <div className="compact-segments-bar">
        <div
          className="compact-segments"
          role="tablist"
          aria-label="Panels"
          onKeyDown={onKeyDown}
        >
          {available.map((id) => {
            const Icon = ICONS[id];
            const active = id === open;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                className={`compact-segment${active ? ' active' : ''}`}
                aria-label={COMPACT_PANEL_TITLES[id]}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                data-panel-segment={id}
                onClick={() => {
                  if (!active) onOpen(id);
                }}
              >
                <Icon size={20} aria-hidden="true" />
                {active ? (
                  <span className="compact-segment-label" aria-hidden="true">
                    {COMPACT_PANEL_TITLES[id]}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      <div
        className="compact-panel-body"
        role="tabpanel"
        aria-label={open ? COMPACT_PANEL_TITLES[open] : undefined}
      >
        {content}
      </div>
    </div>
  );
}
