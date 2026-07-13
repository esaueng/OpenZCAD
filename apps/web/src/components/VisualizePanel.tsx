import { Box, Camera, Grid3x3, Loader } from 'lucide-react';
import type { DisplayMode, ProjectionMode } from './ModelViewer';

interface VisualizePanelProps {
  displayMode: DisplayMode;
  showGrid: boolean;
  projection: ProjectionMode;
  onDisplayMode(mode: DisplayMode): void;
  onToggleGrid(): void;
  onToggleProjection(): void;
}

const MODES: { id: DisplayMode; label: string }[] = [
  { id: 'shaded', label: 'Shaded' },
  { id: 'shaded-edges', label: 'Shaded + Edges' },
  { id: 'wireframe', label: 'Wireframe' }
];

/**
 * Visualize workspace palette: display style and scene toggles. Body colors
 * are edited per body in the properties panel while this workspace is active.
 */
export function VisualizePanel({
  displayMode,
  showGrid,
  projection,
  onDisplayMode,
  onToggleGrid,
  onToggleProjection
}: VisualizePanelProps) {
  return (
    <nav className="tool-palette" aria-label="Visualization controls">
      <section className="palette-group">
        <h3 className="palette-group-title static">
          <Loader size={11} aria-hidden="true" />
          Display style
        </h3>
        <div className="palette-group-body">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`palette-tool ${displayMode === mode.id ? 'active' : ''}`}
              aria-label={mode.label}
              aria-pressed={displayMode === mode.id}
              title={mode.label}
              onClick={() => onDisplayMode(mode.id)}
            >
              <span className="palette-tool-icon">
                <Box size={14} aria-hidden="true" />
              </span>
              <span className="palette-tool-label">{mode.label}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="palette-group">
        <h3 className="palette-group-title static">Scene</h3>
        <div className="palette-group-body">
          <button
            type="button"
            className={`palette-tool ${showGrid ? 'active' : ''}`}
            aria-pressed={showGrid}
            onClick={onToggleGrid}
          >
            <span className="palette-tool-icon">
              <Grid3x3 size={14} aria-hidden="true" />
            </span>
            <span className="palette-tool-label">Grid</span>
            <kbd className="palette-kbd">G</kbd>
          </button>
          <button
            type="button"
            className={`palette-tool ${projection === 'orthographic' ? 'active' : ''}`}
            aria-pressed={projection === 'orthographic'}
            onClick={onToggleProjection}
          >
            <span className="palette-tool-icon">
              <Camera size={14} aria-hidden="true" />
            </span>
            <span className="palette-tool-label">Orthographic</span>
            <kbd className="palette-kbd">P</kbd>
          </button>
        </div>
      </section>
      <p className="muted palette-note">
        Select a body to change its color in the properties panel.
      </p>
    </nav>
  );
}
