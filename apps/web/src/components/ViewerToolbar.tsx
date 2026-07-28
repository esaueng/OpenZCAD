import { Box, Camera, Eye, Grid3x3, Maximize2 } from 'lucide-react';
import { VIEW_LABELS } from '@openzcad/viewport';
import type {
  DisplayMode,
  ProjectionMode,
  StandardView,
  ViewerSettings
} from '@openzcad/viewport';

const VIEWS: { id: StandardView; label: string; shortcut: string }[] = [
  { id: 'front', label: 'F', shortcut: '1' },
  { id: 'top', label: 'T', shortcut: '2' },
  { id: 'right', label: 'R', shortcut: '3' },
  { id: 'iso', label: 'Iso', shortcut: '4' }
];

const VIEW_TITLES: Record<StandardView, string> = Object.fromEntries(
  Object.entries(VIEW_LABELS).map(([view, label]) => [view, `${label} view`])
) as Record<StandardView, string>;

export const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  'shaded-edges': 'Shaded + edges',
  shaded: 'Shaded',
  wireframe: 'Wireframe'
};

interface ViewerToolbarProps {
  settings: ViewerSettings;
  projection: ProjectionMode;
  onToggleGrid(): void;
  onFit(): void;
  onView(view: StandardView): void;
  onCycleDisplayMode(): void;
  onToggleProjection(): void;
}

/**
 * Right-hand utility rail under the orientation widget: standard views, fit,
 * grid, projection, and display mode. Labels sit beside the controls so the
 * rail reads at a glance without crowding the top of the viewport.
 */
export function ViewerToolbar({
  settings,
  projection,
  onToggleGrid,
  onFit,
  onView,
  onCycleDisplayMode,
  onToggleProjection
}: ViewerToolbarProps) {
  return (
    <div className="viewer-rail" role="toolbar" aria-label="Viewer controls">
      <div className="rail-views" role="group" aria-label="Standard views">
        {VIEWS.map((view) => (
          <button
            key={view.id}
            type="button"
            onClick={() => onView(view.id)}
            title={`${VIEW_TITLES[view.id]} (${view.shortcut})`}
            aria-label={`${VIEW_TITLES[view.id]} (${view.shortcut})`}
          >
            {view.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="rail-row"
        onClick={onFit}
        title="Fit view (F) — double-click the viewport also fits"
      >
        <span className="rail-label">Fit</span>
        <i className="rail-icon">
          <Maximize2 size={13} aria-hidden="true" />
        </i>
      </button>
      <button
        type="button"
        className={`rail-row ${settings.showGrid ? 'active' : ''}`}
        onClick={onToggleGrid}
        title="Toggle grid (G)"
        aria-pressed={settings.showGrid}
      >
        <span className="rail-label">Grid</span>
        <i className="rail-icon">
          <Grid3x3 size={13} aria-hidden="true" />
        </i>
      </button>
      <button
        type="button"
        className={`rail-row ${projection === 'orthographic' ? 'active' : ''}`}
        onClick={onToggleProjection}
        title={`Projection (P) — now: ${projection}`}
        aria-pressed={projection === 'orthographic'}
      >
        <span className="rail-label">Ortho</span>
        <i className="rail-icon">
          <Camera size={13} aria-hidden="true" />
        </i>
      </button>
      <button
        type="button"
        className="rail-row"
        onClick={onCycleDisplayMode}
        title={`Display mode (W) — now: ${DISPLAY_MODE_LABELS[settings.displayMode]}`}
      >
        <span className="rail-label rail-label-wide">
          {DISPLAY_MODE_LABELS[settings.displayMode]}
        </span>
        <i className="rail-icon">
          {settings.displayMode === 'wireframe' ? (
            <Box size={13} aria-hidden="true" />
          ) : (
            <Eye size={13} aria-hidden="true" />
          )}
        </i>
      </button>
    </div>
  );
}
