import { useEffect, useId, useRef, useState } from 'react';
import { Camera, Grid3x3, Maximize2, Ruler } from 'lucide-react';
import { VIEW_LABELS } from '@openzcad/viewport';
import type {
  ProjectionMode,
  StandardView,
  ViewerSettings
} from '@openzcad/viewport';
import { AxisTriadIcon, DisplayModeIcon } from './ViewerRailIcons';
import { DISPLAY_MODE_LABELS } from '../lib/displayMode';

const VIEWS: { id: StandardView; shortcut?: string }[] = [
  { id: 'front', shortcut: '1' },
  { id: 'back' },
  { id: 'left' },
  { id: 'right', shortcut: '3' },
  { id: 'top', shortcut: '2' },
  { id: 'bottom' },
  { id: 'iso', shortcut: '4' }
];

interface ViewModeBarProps {
  settings: ViewerSettings;
  projection: ProjectionMode;
  /** True while picking is narrowed to edges for measurement. */
  measuring: boolean;
  onMeasure(measuring: boolean): void;
  onFit(): void;
  onToggleGrid(): void;
  onView(view: StandardView): void;
  onCycleDisplayMode(): void;
  onToggleProjection(): void;
}

/**
 * View mode's one piece of chrome: a bar of viewport controls floated at the
 * bottom of the viewport, where the modeling tool palette would otherwise be.
 *
 * It carries what someone reading a model needs — measure, fit, standard
 * views, grid, display mode, projection — and nothing that writes to the
 * document. Build mode keeps its own right-hand `ViewerToolbar`; the two never
 * render together.
 */
export function ViewModeBar({
  settings,
  projection,
  measuring,
  onMeasure,
  onFit,
  onToggleGrid,
  onView,
  onCycleDisplayMode,
  onToggleProjection
}: ViewModeBarProps) {
  const [viewsOpen, setViewsOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!viewsOpen) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (!anchorRef.current?.contains(event.target as Node)) {
        setViewsOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setViewsOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [viewsOpen]);

  return (
    <div className="view-mode-bar" role="toolbar" aria-label="View tools">
      <button
        type="button"
        className={`view-mode-button wide${measuring ? ' active' : ''}`}
        aria-pressed={measuring}
        title="Measure — click an edge for its length, Shift-click to total several"
        onClick={() => onMeasure(!measuring)}
      >
        <Ruler size={15} aria-hidden="true" />
        Measure
      </button>
      <span className="view-mode-divider" aria-hidden="true" />
      <button
        type="button"
        className="view-mode-button"
        onClick={onFit}
        title="Fit view (F)"
        aria-label="Fit view (F)"
      >
        <Maximize2 size={15} aria-hidden="true" />
      </button>
      <div className="view-mode-views-anchor" ref={anchorRef}>
        <button
          type="button"
          ref={triggerRef}
          className={`view-mode-button${viewsOpen ? ' open' : ''}`}
          onClick={() => setViewsOpen((open) => !open)}
          title="Standard views"
          aria-label="Standard views"
          aria-haspopup="true"
          aria-expanded={viewsOpen}
          aria-controls={viewsOpen ? panelId : undefined}
        >
          <AxisTriadIcon />
        </button>
        {viewsOpen && (
          <div
            className="view-mode-views-panel"
            id={panelId}
            role="group"
            aria-label="Standard views"
          >
            {VIEWS.map((view) => {
              const label = `${VIEW_LABELS[view.id]} view`;
              return (
                <button
                  key={view.id}
                  type="button"
                  className={
                    view.id === 'iso' ? 'view-mode-view-wide' : undefined
                  }
                  onClick={() => {
                    onView(view.id);
                    setViewsOpen(false);
                  }}
                  title={view.shortcut ? `${label} (${view.shortcut})` : label}
                  aria-label={
                    view.shortcut ? `${label} (${view.shortcut})` : label
                  }
                >
                  {VIEW_LABELS[view.id]}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <button
        type="button"
        className={`view-mode-button${settings.showGrid ? ' active' : ''}`}
        onClick={onToggleGrid}
        title="Toggle grid (G)"
        aria-label="Toggle grid (G)"
        aria-pressed={settings.showGrid}
      >
        <Grid3x3 size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="view-mode-button"
        onClick={onCycleDisplayMode}
        title={`Display mode (W) — now: ${DISPLAY_MODE_LABELS[settings.displayMode]}`}
        aria-label={`Display mode (W) — now: ${DISPLAY_MODE_LABELS[settings.displayMode]}`}
      >
        <DisplayModeIcon mode={settings.displayMode} />
      </button>
      <button
        type="button"
        className={`view-mode-button${projection === 'orthographic' ? ' active' : ''}`}
        onClick={onToggleProjection}
        title={`Projection (P) — now: ${projection}`}
        aria-label={`Orthographic projection (P) — now: ${projection}`}
        aria-pressed={projection === 'orthographic'}
      >
        <Camera size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
