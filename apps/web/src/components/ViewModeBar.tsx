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
import { Tooltip } from './Tooltip';

const VIEWS: { id: StandardView; shortcut?: string }[] = [
  { id: 'front', shortcut: '1' },
  { id: 'back' },
  { id: 'left' },
  { id: 'right', shortcut: '3' },
  { id: 'top', shortcut: '2' },
  { id: 'bottom' },
  { id: 'iso', shortcut: '4' }
];

/** Cased like the display modes the bar's other "Now:" lines name. */
const PROJECTION_LABELS: Record<ProjectionMode, string> = {
  perspective: 'Perspective',
  orthographic: 'Orthographic'
};

interface ViewModeBarProps {
  settings: ViewerSettings;
  projection: ProjectionMode;
  /** True while the View-only measurement workbench owns measurement picks. */
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
  const displayModeLabel = DISPLAY_MODE_LABELS[settings.displayMode];
  const projectionLabel = PROJECTION_LABELS[projection];

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

  // The same styled help as Build's viewer bar, which carries the same
  // controls: switching modes used to swap it for the browser's own titles,
  // without the keys.
  return (
    <div className="view-mode-bar" role="toolbar" aria-label="View tools">
      <Tooltip
        label="Measure"
        shortcut="M"
        description="Inspect geometry, distance, and angle"
      >
        <button
          type="button"
          className={`view-mode-button wide${measuring ? ' active' : ''}`}
          aria-pressed={measuring}
          aria-label="Measure"
          onClick={() => onMeasure(!measuring)}
        >
          <Ruler size={16} aria-hidden="true" />
          <span className="view-mode-button-label">Measure</span>
        </button>
      </Tooltip>
      <span className="view-mode-divider" aria-hidden="true" />
      <Tooltip
        label="Fit view"
        shortcut="F"
        description="Double-click the viewport to fit"
      >
        <button
          type="button"
          className="view-mode-button"
          onClick={onFit}
          aria-label="Fit view (F)"
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <div className="view-mode-views-anchor" ref={anchorRef}>
        <Tooltip label="Standard views">
          <button
            type="button"
            ref={triggerRef}
            className={`view-mode-button${viewsOpen ? ' open' : ''}`}
            onClick={() => setViewsOpen((open) => !open)}
            aria-label="Standard views"
            aria-expanded={viewsOpen}
            aria-controls={viewsOpen ? panelId : undefined}
          >
            <AxisTriadIcon />
          </button>
        </Tooltip>
        {viewsOpen && (
          <div
            className="view-mode-views-panel"
            data-rail-flyout=""
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
                    // The chosen tile unmounts with the panel; the keyboard
                    // returns to the button that opened it, not to <body>.
                    triggerRef.current?.focus();
                  }}
                  aria-label={
                    view.shortcut ? `${label} (${view.shortcut})` : label
                  }
                >
                  {VIEW_LABELS[view.id]}
                  {view.shortcut ? (
                    <kbd aria-hidden="true">{view.shortcut}</kbd>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <Tooltip label="Toggle grid" shortcut="G">
        <button
          type="button"
          className={`view-mode-button${settings.showGrid ? ' active' : ''}`}
          onClick={onToggleGrid}
          aria-label="Toggle grid (G)"
          aria-pressed={settings.showGrid}
        >
          <Grid3x3 size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip
        label="Display mode"
        shortcut="W"
        description={`Now: ${displayModeLabel}`}
      >
        <button
          type="button"
          className="view-mode-button"
          onClick={onCycleDisplayMode}
          aria-label={`Display mode (W) — now: ${displayModeLabel}`}
        >
          <DisplayModeIcon mode={settings.displayMode} />
        </button>
      </Tooltip>
      <Tooltip
        label="Projection"
        shortcut="P"
        description={`Now: ${projectionLabel}`}
      >
        <button
          type="button"
          className={`view-mode-button${projection === 'orthographic' ? ' active' : ''}`}
          onClick={onToggleProjection}
          aria-label={`Orthographic projection (P) — now: ${projectionLabel}`}
          aria-pressed={projection === 'orthographic'}
        >
          <Camera size={16} aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}
