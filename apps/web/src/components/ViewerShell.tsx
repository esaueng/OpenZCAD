import type { MutableRefObject } from 'react';
import {
  ModelViewer,
  type ExtrudePreview,
  type AxisProjection,
  type FaceResizeCommit,
  type ProjectionMode,
  type SketchOverlay,
  type StandardView,
  type ViewerSettings
} from './ModelViewer';
import type { ReactNode } from 'react';
import { ViewerToolbar } from './ViewerToolbar';
import { OrientationWidget } from './OrientationWidget';
import type { BodyRepresentation, TopologySelection } from '@openzcad/shared';
import type { ViewportCameraState } from '../lib/workspaceSession';

interface ViewerShellProps {
  projectId: string;
  bodies: BodyRepresentation[];
  sketches: SketchOverlay[];
  selectedBodyIds: string[];
  selectedTopology: TopologySelection | null;
  selectedEdges: TopologySelection[];
  settings: ViewerSettings;
  fitSignal: number;
  viewRequest: { view: StandardView; nonce: number } | null;
  units: string;
  editableBodyIds: string[];
  extrudePreview: ExtrudePreview | null;
  modeOverlay?: ReactNode;
  hideViewerToolbar?: boolean;
  /** Bottom-center summary of the current selection, with a measurement. */
  selectionChip: { label: string; detail?: string } | null;
  onClearSelection(): void;
  projection: ProjectionMode;
  initialView: ViewportCameraState | null;
  onViewChange(view: ViewportCameraState): void;
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  onSelectTopology(
    selection: TopologySelection | null,
    additive: boolean
  ): void;
  onSelectSketchProfile(sketchId: string): void;
  onResizePrimitiveFace(commit: FaceResizeCommit): void;
  onExtrudeDistanceChange(distance: number): void;
  onContextMenu(
    x: number,
    y: number,
    selection: TopologySelection | null
  ): void;
  onToggleGrid(): void;
  onFit(): void;
  onView(view: StandardView): void;
  onCycleDisplayMode(): void;
  onToggleProjection(): void;
}

export function ViewerShell({
  projectId,
  bodies,
  sketches,
  selectedBodyIds,
  selectedTopology,
  selectedEdges,
  settings,
  fitSignal,
  viewRequest,
  units,
  editableBodyIds,
  extrudePreview,
  modeOverlay,
  hideViewerToolbar = false,
  selectionChip,
  onClearSelection,
  projection,
  initialView,
  onViewChange,
  orientationRef,
  onSelectTopology,
  onSelectSketchProfile,
  onResizePrimitiveFace,
  onExtrudeDistanceChange,
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
        key={projectId}
        bodies={bodies}
        sketches={sketches}
        selectedBodyIds={selectedBodyIds}
        selectedTopology={selectedTopology}
        selectedEdges={selectedEdges}
        settings={settings}
        fitSignal={fitSignal}
        viewRequest={viewRequest}
        units={units}
        editableBodyIds={editableBodyIds}
        extrudePreview={extrudePreview}
        projection={projection}
        initialView={initialView}
        onViewChange={onViewChange}
        orientationRef={orientationRef}
        onSelectTopology={onSelectTopology}
        onSelectSketchProfile={onSelectSketchProfile}
        onResizePrimitiveFace={onResizePrimitiveFace}
        onExtrudeDistanceChange={onExtrudeDistanceChange}
        onContextMenu={onContextMenu}
      />
      {!hideViewerToolbar && (
        <div className="viewer-rail-stack">
          <OrientationWidget orientationRef={orientationRef} />
          <ViewerToolbar
            settings={settings}
            projection={projection}
            onToggleGrid={onToggleGrid}
            onFit={onFit}
            onView={onView}
            onCycleDisplayMode={onCycleDisplayMode}
            onToggleProjection={onToggleProjection}
          />
        </div>
      )}
      {bodies.length === 0 && sketches.length === 0 && (
        <div className="viewer-notice">
          <div>
            <strong>No geometry yet</strong>
            <small>
              Pick a tool from the palette on the left — try <b>Box</b> (B) —
              or sketch a profile and extrude it.
            </small>
            <small className="viewer-notice-keys">
              <kbd>Ctrl</kbd>+<kbd>K</kbd> all commands · <kbd>?</kbd> shortcuts
            </small>
          </div>
        </div>
      )}
      {selectionChip && (
        <div className="selection-chip" role="status">
          <span className="selection-chip-label">{selectionChip.label}</span>
          {selectionChip.detail && (
            <span className="selection-chip-detail">
              {selectionChip.detail}
            </span>
          )}
          <button
            type="button"
            className="selection-chip-clear"
            title="Deselect all (Esc)"
            aria-label="Deselect all"
            onClick={onClearSelection}
          >
            ×
          </button>
        </div>
      )}
      {modeOverlay}
      <div className="viewer-watermark">openzcad kernel · exact b-rep</div>
    </section>
  );
}
