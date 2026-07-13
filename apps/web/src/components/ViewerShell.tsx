import type { MutableRefObject } from 'react';
import {
  ModelViewer,
  type AxisProjection,
  type FaceResizeCommit,
  type ProjectionMode,
  type SketchOverlay,
  type StandardView,
  type ViewerSettings
} from './ModelViewer';
import { ViewerToolbar } from './ViewerToolbar';
import { OrientationWidget } from './OrientationWidget';
import type { BodyRepresentation, TopologySelection } from '@openzcad/shared';

interface ViewerShellProps {
  bodies: BodyRepresentation[];
  sketches: SketchOverlay[];
  selectedBodyIds: string[];
  selectedTopology: TopologySelection | null;
  settings: ViewerSettings;
  fitSignal: number;
  viewRequest: { view: StandardView; nonce: number } | null;
  units: string;
  editableBodyIds: string[];
  projection: ProjectionMode;
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  onSelectTopology(
    selection: TopologySelection | null,
    additive: boolean
  ): void;
  onResizePrimitiveFace(commit: FaceResizeCommit): void;
  onContextMenu(x: number, y: number, selection: TopologySelection | null): void;
  onToggleGrid(): void;
  onFit(): void;
  onView(view: StandardView): void;
  onCycleDisplayMode(): void;
  onToggleProjection(): void;
}

export function ViewerShell({
  bodies,
  sketches,
  selectedBodyIds,
  selectedTopology,
  settings,
  fitSignal,
  viewRequest,
  units,
  editableBodyIds,
  projection,
  orientationRef,
  onSelectTopology,
  onResizePrimitiveFace,
  onContextMenu,
  onToggleGrid,
  onFit,
  onView,
  onCycleDisplayMode,
  onToggleProjection
}: ViewerShellProps) {
  return (
    <section className="viewer-shell" aria-label="3D viewport">
      <ModelViewer
        bodies={bodies}
        sketches={sketches}
        selectedBodyIds={selectedBodyIds}
        selectedTopology={selectedTopology}
        settings={settings}
        fitSignal={fitSignal}
        viewRequest={viewRequest}
        units={units}
        editableBodyIds={editableBodyIds}
        projection={projection}
        orientationRef={orientationRef}
        onSelectTopology={onSelectTopology}
        onResizePrimitiveFace={onResizePrimitiveFace}
        onContextMenu={onContextMenu}
      />
      <ViewerToolbar
        settings={settings}
        projection={projection}
        onToggleGrid={onToggleGrid}
        onFit={onFit}
        onView={onView}
        onCycleDisplayMode={onCycleDisplayMode}
        onToggleProjection={onToggleProjection}
      />
      <OrientationWidget orientationRef={orientationRef} />
      {bodies.length === 0 && sketches.length === 0 && (
        <div className="viewer-notice">
          <div>
            <strong>No geometry yet</strong>
            <small>
              Pick a tool from the toolbar above — try <b>Box</b> (B) — or
              sketch a profile and extrude it.
            </small>
            <small className="viewer-notice-keys">
              <kbd>Ctrl</kbd>+<kbd>K</kbd> all commands · <kbd>?</kbd> shortcuts
            </small>
          </div>
        </div>
      )}
      <div className="viewer-watermark">openzcad kernel · exact b-rep</div>
    </section>
  );
}
