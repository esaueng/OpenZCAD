import { useEffect, useId, useRef, useState } from 'react';
import { Camera, Grid3x3, Maximize2, Ruler } from 'lucide-react';
import {
  SavedViewsSection,
  type SavedViewsSectionProps
} from './SavedViewsSection';
import { VIEW_LABELS } from '@openzcad/viewport';
import type {
  ProjectionMode,
  StandardView,
  ViewerSettings
} from '@openzcad/viewport';
import { AxisTriadIcon, DisplayModeIcon } from './ViewerRailIcons';
import { DISPLAY_MODE_LABELS } from '../lib/displayMode';
import { Tooltip } from './Tooltip';
import { labelWithKey, useKeymap } from '../lib/keymap';
import { platformShortcutLabel } from '../lib/platformShortcut';

const VIEWS: { id: StandardView; command?: string }[] = [
  { id: 'front', command: 'view-front' },
  { id: 'back', command: 'view-back' },
  { id: 'left', command: 'view-left' },
  { id: 'right', command: 'view-right' },
  { id: 'top', command: 'view-top' },
  { id: 'bottom', command: 'view-bottom' },
  { id: 'iso', command: 'view-iso' }
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
  /** The project's saved views, listed under the standard view tiles. */
  savedViews?: SavedViewsSectionProps;
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
  savedViews,
  onCycleDisplayMode,
  onToggleProjection
}: ViewModeBarProps) {
  const keymap = useKeymap();
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
        shortcut={keymap.label('view-measure')}
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
        shortcut={keymap.label('view-fit')}
        description="Double-click the viewport to fit"
      >
        <button
          type="button"
          className="view-mode-button"
          onClick={onFit}
          aria-label={labelWithKey('Fit view', keymap.label('view-fit'))}
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
                  aria-label={labelWithKey(
                    label,
                    view.command && keymap.label(view.command)
                  )}
                >
                  {VIEW_LABELS[view.id]}
                  {view.command && keymap.label(view.command) ? (
                    <kbd aria-hidden="true">
                      {platformShortcutLabel(keymap.label(view.command)!)}
                    </kbd>
                  ) : null}
                </button>
              );
            })}
            {savedViews && (
              <SavedViewsSection
                {...savedViews}
                onApply={(viewId) => {
                  savedViews.onApply(viewId);
                  setViewsOpen(false);
                  triggerRef.current?.focus();
                }}
              />
            )}
          </div>
        )}
      </div>
      <Tooltip label="Toggle grid" shortcut={keymap.label('view-grid')}>
        <button
          type="button"
          className={`view-mode-button${settings.showGrid ? ' active' : ''}`}
          onClick={onToggleGrid}
          aria-label={labelWithKey('Toggle grid', keymap.label('view-grid'))}
          aria-pressed={settings.showGrid}
        >
          <Grid3x3 size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip
        label="Display mode"
        shortcut={keymap.label('view-display')}
        description={`Now: ${displayModeLabel}`}
      >
        <button
          type="button"
          className="view-mode-button"
          onClick={onCycleDisplayMode}
          aria-label={`${labelWithKey('Display mode', keymap.label('view-display'))} — now: ${displayModeLabel}`}
        >
          <DisplayModeIcon mode={settings.displayMode} />
        </button>
      </Tooltip>
      <Tooltip
        label="Projection"
        shortcut={keymap.label('view-projection')}
        description={`Now: ${projectionLabel}`}
      >
        <button
          type="button"
          className={`view-mode-button${projection === 'orthographic' ? ' active' : ''}`}
          onClick={onToggleProjection}
          aria-label={`${labelWithKey('Orthographic projection', keymap.label('view-projection'))} — now: ${projectionLabel}`}
          aria-pressed={projection === 'orthographic'}
        >
          <Camera size={16} aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}
