import type { MutableRefObject, ReactNode } from 'react';
import { Box, PenLine, Upload, X } from 'lucide-react';
import type { BodyRepresentation } from '@openzcad/shared';
import {
  ModelViewer,
  type AxisProjection,
  type ProjectionMode,
  type SketchOverlayView,
  type StandardView,
  type ViewerApi,
  type ViewerSettings
} from './ModelViewer';
import { ViewportNav } from './ViewportNav';
import type { ManipulatorSpec, PreviewSpec } from '../lib/session';

interface ViewerShellProps {
  bodies: BodyRepresentation[];
  sketches: SketchOverlayView[];
  totalFeatureCount: number;
  selectedBodyIds: string[];
  settings: ViewerSettings;
  preview: PreviewSpec | null;
  manipulator: ManipulatorSpec | null;
  projection: ProjectionMode;
  apiRef: MutableRefObject<ViewerApi | null>;
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  /** Floating command HUD rendered over the viewport during a session. */
  hud: ReactNode;
  showOrbitHint: boolean;
  onDismissOrbitHint(): void;
  onSelectBody(bodyId: string | null, additive: boolean): void;
  onSelectSketch(sketchId: string, additive: boolean): void;
  onContextMenu(x: number, y: number, bodyId: string | null): void;
  onManipulatorDrag(valueKey: string, value: number): void;
  onView(view: StandardView): void;
  onToggleProjection(): void;
  onToggleGrid(): void;
  onFit(target: 'all' | 'selection'): void;
  onStartSketch(): void;
  onStartBox(): void;
  onImportClick(): void;
}

/** Viewport region: 3D canvas, HUD, camera cluster, and empty-state actions. */
export function ViewerShell({
  bodies,
  sketches,
  totalFeatureCount,
  selectedBodyIds,
  settings,
  preview,
  manipulator,
  projection,
  apiRef,
  orientationRef,
  hud,
  showOrbitHint,
  onDismissOrbitHint,
  onSelectBody,
  onSelectSketch,
  onContextMenu,
  onManipulatorDrag,
  onView,
  onToggleProjection,
  onToggleGrid,
  onFit,
  onStartSketch,
  onStartBox,
  onImportClick
}: ViewerShellProps) {
  const empty = totalFeatureCount === 0 && !preview;

  return (
    <section className="viewer-shell" aria-label="3D viewport">
      <ModelViewer
        bodies={bodies}
        sketches={sketches}
        selectedBodyIds={selectedBodyIds}
        settings={settings}
        preview={preview}
        manipulator={manipulator}
        apiRef={apiRef}
        orientationRef={orientationRef}
        onSelectBody={onSelectBody}
        onSelectSketch={onSelectSketch}
        onContextMenu={onContextMenu}
        onManipulatorDrag={onManipulatorDrag}
      />
      {hud}
      <ViewportNav
        orientationRef={orientationRef}
        projection={projection}
        showGrid={settings.showGrid}
        hasSelection={selectedBodyIds.length > 0}
        onView={onView}
        onToggleProjection={onToggleProjection}
        onToggleGrid={onToggleGrid}
        onFit={onFit}
      />
      {empty && (
        <div className="viewer-empty-state">
          <h2>Start modeling</h2>
          <p>Sketch a profile and pull it into a solid, or drop in a primitive.</p>
          <div className="empty-actions">
            <button type="button" className="primary" onClick={onStartSketch}>
              <PenLine size={14} aria-hidden="true" />
              Create Sketch
              <kbd>K</kbd>
            </button>
            <button type="button" className="secondary" onClick={onStartBox}>
              <Box size={14} aria-hidden="true" />
              Add Box
              <kbd>B</kbd>
            </button>
            <button type="button" className="secondary" onClick={onImportClick}>
              <Upload size={14} aria-hidden="true" />
              Import STL
            </button>
          </div>
        </div>
      )}
      {showOrbitHint && !empty && (
        <div className="viewer-hint" role="note">
          <span>
            <b>Orbit</b> drag · <b>Pan</b> right-drag · <b>Zoom</b> scroll · <b>Select</b> click ·{' '}
            <b>Multi-select</b> shift-click
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss navigation hint"
            onClick={onDismissOrbitHint}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}
