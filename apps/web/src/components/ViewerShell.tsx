import type { MutableRefObject } from 'react';
import {
  ModelViewer,
  type ExtrudePreview,
  type FaceResizeCommit,
  type CylinderRadiusHandleTarget,
  type EdgeHandleTarget,
  type OrientationDragControls,
  type RegionHandleTarget,
  type SketchModeState,
  type SketchViewData,
  type OffsetHandleTarget
} from './ModelViewer';
import type {
  AxisProjection,
  MovePreview,
  MoveSnap,
  PickDetail,
  ProjectionMode,
  SelectionFilter,
  SketchOverlay,
  ViewerSettings,
  ViewTarget
} from '@openzcad/viewport';
import { useRef, type ReactNode } from 'react';
import { ViewerToolbar } from './ViewerToolbar';
import { OrientationWidget } from './OrientationWidget';
import type {
  BodyRepresentation,
  SketchObjectData,
  TopologySelection
} from '@openzcad/shared';
import type { ViewportCameraState } from '../lib/workspaceSession';
import type { RegionPickData } from './viewer/regionOverlay';

interface ViewerShellProps {
  projectId: string;
  bodies: BodyRepresentation[];
  sketches: SketchOverlay[];
  selectedBodyIds: string[];
  selectedTopology: TopologySelection | null;
  selectedEdges: TopologySelection[];
  settings: ViewerSettings;
  fitSignal: number;
  viewRequest: { view: ViewTarget; nonce: number } | null;
  rotateRequest: { direction: 'cw' | 'ccw'; nonce: number } | null;
  units: string;
  editableBodyIds: string[];
  extrudePreview: ExtrudePreview | null;
  movePreview: MovePreview | null;
  modeOverlay?: ReactNode;
  hideViewerToolbar?: boolean;
  /** Bottom-center summary of the current selection, with a measurement. */
  selectionChip: { label: string; detail?: string } | null;
  onClearSelection(): void;
  projection: ProjectionMode;
  initialView: ViewportCameraState | null;
  onViewChange(view: ViewportCameraState): void;
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  selectionFilter: SelectionFilter;
  onBoxSelect(bodyIds: string[]): void;
  onSelectEdgeChain(selections: TopologySelection[]): void;
  onSelectTopology(
    selection: TopologySelection | null,
    additive: boolean,
    detail?: PickDetail
  ): void;
  offsetHandle: OffsetHandleTarget | null;
  onOffsetCommit(offset: number): void;
  onOpenOffsetKeypad(currentOffset: number): void;
  keypadAnchorRef: MutableRefObject<
    ((point: { x: number; y: number } | null) => void) | null
  >;
  offsetSetterRef: MutableRefObject<((offset: number) => void) | null>;
  cylinderRadiusHandle: CylinderRadiusHandleTarget | null;
  onCylinderRadiusPreview(radius: number): void;
  onCylinderRadiusCommit(radius: number): void;
  onCylinderRadiusCancel(): void;
  onOpenCylinderRadiusKeypad(radius: number): void;
  cancelDirectManipulationRef: MutableRefObject<(() => boolean) | null>;
  edgeHandle: EdgeHandleTarget | null;
  onEdgeRadiusPreview(size: number): void;
  onEdgeCommit(size: number): void;
  onOpenEdgeKeypad(currentSize: number): void;
  onDirectManipulationChange(dragging: boolean): void;
  sketchMode: SketchModeState | null;
  onSketchCommit(object: SketchObjectData): void;
  onSketchDrawingChange(drawing: boolean): void;
  onSketchSelectObject(objectId: string | null): void;
  sketchViews: SketchViewData[];
  selectedProfileIds: string[];
  profileSelectionMode: boolean;
  onSelectRegion(
    region: RegionPickData,
    modifiers: { additive: boolean; toggle: boolean }
  ): void;
  onHoverRegion(region: RegionPickData | null): void;
  regionHandle: RegionHandleTarget | null;
  onSelectSketchProfile(sketchId: string): void;
  onResizePrimitiveFace(commit: FaceResizeCommit): void;
  onExtrudeDistanceChange(distance: number): void;
  onMovePreviewChange(
    translation: MovePreview['translation'],
    rotationDeg: MovePreview['rotationDeg'],
    snap: MoveSnap
  ): void;
  onContextMenu(
    x: number,
    y: number,
    selection: TopologySelection | null
  ): void;
  onToggleGrid(): void;
  onFit(): void;
  onView(view: ViewTarget): void;
  onRotateView(direction: 'cw' | 'ccw'): void;
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
  rotateRequest,
  units,
  editableBodyIds,
  extrudePreview,
  movePreview,
  modeOverlay,
  hideViewerToolbar = false,
  selectionChip,
  onClearSelection,
  projection,
  initialView,
  onViewChange,
  orientationRef,
  onSelectTopology,
  onSelectEdgeChain,
  selectionFilter,
  onBoxSelect,
  offsetHandle,
  onOffsetCommit,
  onOpenOffsetKeypad,
  keypadAnchorRef,
  offsetSetterRef,
  cylinderRadiusHandle,
  onCylinderRadiusPreview,
  onCylinderRadiusCommit,
  onCylinderRadiusCancel,
  onOpenCylinderRadiusKeypad,
  cancelDirectManipulationRef,
  edgeHandle,
  onEdgeRadiusPreview,
  onEdgeCommit,
  onOpenEdgeKeypad,
  onDirectManipulationChange,
  sketchMode,
  onSketchCommit,
  onSketchDrawingChange,
  onSketchSelectObject,
  sketchViews,
  selectedProfileIds,
  profileSelectionMode,
  onSelectRegion,
  onHoverRegion,
  regionHandle,
  onSelectSketchProfile,
  onResizePrimitiveFace,
  onExtrudeDistanceChange,
  onMovePreviewChange,
  onContextMenu,
  onToggleGrid,
  onFit,
  onView,
  onRotateView,
  onCycleDisplayMode,
  onToggleProjection
}: ViewerShellProps) {
  const orientationDragRef = useRef<OrientationDragControls | null>(null);

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
        rotateRequest={rotateRequest}
        units={units}
        editableBodyIds={editableBodyIds}
        extrudePreview={extrudePreview}
        movePreview={movePreview}
        projection={projection}
        initialView={initialView}
        onViewChange={onViewChange}
        orientationRef={orientationRef}
        orientationDragRef={orientationDragRef}
        onSelectTopology={onSelectTopology}
        onSelectEdgeChain={onSelectEdgeChain}
        selectionFilter={selectionFilter}
        onBoxSelect={onBoxSelect}
        offsetHandle={offsetHandle}
        onOffsetCommit={onOffsetCommit}
        onOpenOffsetKeypad={onOpenOffsetKeypad}
        keypadAnchorRef={keypadAnchorRef}
        offsetSetterRef={offsetSetterRef}
        cylinderRadiusHandle={cylinderRadiusHandle}
        onCylinderRadiusPreview={onCylinderRadiusPreview}
        onCylinderRadiusCommit={onCylinderRadiusCommit}
        onCylinderRadiusCancel={onCylinderRadiusCancel}
        onOpenCylinderRadiusKeypad={onOpenCylinderRadiusKeypad}
        cancelDirectManipulationRef={cancelDirectManipulationRef}
        edgeHandle={edgeHandle}
        onEdgeRadiusPreview={onEdgeRadiusPreview}
        onEdgeCommit={onEdgeCommit}
        onOpenEdgeKeypad={onOpenEdgeKeypad}
        onDirectManipulationChange={onDirectManipulationChange}
        sketchMode={sketchMode}
        onSketchCommit={onSketchCommit}
        onSketchDrawingChange={onSketchDrawingChange}
        onSketchSelectObject={onSketchSelectObject}
        sketchViews={sketchViews}
        selectedProfileIds={selectedProfileIds}
        profileSelectionMode={profileSelectionMode}
        onSelectRegion={onSelectRegion}
        onHoverRegion={onHoverRegion}
        regionHandle={regionHandle}
        onSelectSketchProfile={onSelectSketchProfile}
        onResizePrimitiveFace={onResizePrimitiveFace}
        onExtrudeDistanceChange={onExtrudeDistanceChange}
        onMovePreviewChange={onMovePreviewChange}
        onContextMenu={onContextMenu}
      />
      {!hideViewerToolbar && (
        <div className="viewer-rail-stack">
          <OrientationWidget
            orientationRef={orientationRef}
            onSelectView={onView}
            onRotateView={onRotateView}
            onDragStart={() => orientationDragRef.current?.begin()}
            onDrag={(deltaX, deltaY) =>
              orientationDragRef.current?.move(deltaX, deltaY)
            }
            onDragEnd={() => orientationDragRef.current?.end()}
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
      <div className="viewport-frame" aria-hidden="true">
        <div className="frame-corner tl" />
        <div className="frame-corner tr" />
        <div className="frame-corner bl" />
        <div className="frame-corner br" />
      </div>
      <div className="vp-hud vp-hud-bl" aria-hidden="true">
        <span className="vp-chip">{units}</span>
        <span className="vp-chip">
          {bodies.length} {bodies.length === 1 ? 'body' : 'bodies'}
        </span>
        {sketches.length > 0 && (
          <span className="vp-chip">
            {sketches.length} {sketches.length === 1 ? 'sketch' : 'sketches'}
          </span>
        )}
      </div>
    </section>
  );
}
