import { Box, Camera, Eye, Grid3x3, Maximize2 } from 'lucide-react';
import type {
  DisplayMode,
  ProjectionMode,
  StandardView,
  ViewerSettings
} from './ModelViewer';

const VIEWS: { id: StandardView; label: string; shortcut: string }[] = [
  { id: 'front', label: 'Front', shortcut: '1' },
  { id: 'top', label: 'Top', shortcut: '2' },
  { id: 'right', label: 'Right', shortcut: '3' },
  { id: 'iso', label: 'Iso', shortcut: '4' }
];

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
    <div className="viewer-toolbar" role="toolbar" aria-label="Viewer controls">
      {VIEWS.map((view) => (
        <button
          key={view.id}
          type="button"
          onClick={() => onView(view.id)}
          title={`${view.label} view (${view.shortcut})`}
        >
          {view.label}
        </button>
      ))}
      <span className="viewer-toolbar-sep" />
      <button type="button" onClick={onFit} title="Fit view (F) — double-click also fits">
        <Maximize2 size={13} aria-hidden="true" />
        Fit
      </button>
      <span className="viewer-toolbar-sep" />
      <button
        type="button"
        className={settings.showGrid ? 'active' : ''}
        onClick={onToggleGrid}
        title="Toggle grid (G)"
        aria-pressed={settings.showGrid}
      >
        <Grid3x3 size={13} aria-hidden="true" />
        Grid
      </button>
      <button
        type="button"
        className={projection === 'orthographic' ? 'active' : ''}
        onClick={onToggleProjection}
        title={`Projection (P) — now: ${projection}`}
        aria-pressed={projection === 'orthographic'}
      >
        <Camera size={13} aria-hidden="true" />
        Ortho
      </button>
      <button
        type="button"
        onClick={onCycleDisplayMode}
        title={`Display mode (W) — now: ${DISPLAY_MODE_LABELS[settings.displayMode]}`}
      >
        {settings.displayMode === 'wireframe' ? (
          <Box size={13} aria-hidden="true" />
        ) : (
          <Eye size={13} aria-hidden="true" />
        )}
        {DISPLAY_MODE_LABELS[settings.displayMode]}
      </button>
    </div>
  );
}
