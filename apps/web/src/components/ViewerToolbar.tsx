import { Grid3x3, Maximize2, MoveDiagonal } from 'lucide-react';
import type { ViewerSettings } from './GenerativeDesignViewer';

interface ViewerToolbarProps {
  settings: ViewerSettings;
  onToggleGrid(): void;
  onToggleLoads(): void;
  onFit(): void;
}

export function ViewerToolbar({ settings, onToggleGrid, onToggleLoads, onFit }: ViewerToolbarProps) {
  return (
    <div className="viewer-toolbar" role="toolbar" aria-label="Viewer controls">
      <button type="button" onClick={onFit} title="Fit view">
        <Maximize2 size={13} aria-hidden="true" />
        Fit
      </button>
      <button
        type="button"
        className={settings.showGrid ? 'active' : ''}
        onClick={onToggleGrid}
        title="Toggle grid"
        aria-pressed={settings.showGrid}
      >
        <Grid3x3 size={13} aria-hidden="true" />
        Grid
      </button>
      <button
        type="button"
        className={settings.showLoads ? 'active' : ''}
        onClick={onToggleLoads}
        title="Toggle load overlays"
        aria-pressed={settings.showLoads}
      >
        <MoveDiagonal size={13} aria-hidden="true" />
        Loads
      </button>
    </div>
  );
}
