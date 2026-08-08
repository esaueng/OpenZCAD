import { useRef, type MutableRefObject, type ReactNode } from 'react';
import {
  ModelViewer,
  type BodyAppearancePreview,
  type ExtrudePreview,
  type FaceResizeCommit,
  type CylinderRadiusHandleTarget,
  type EdgeHandleTarget,
  type OrientationDragControls,
  type NormalToFaceRequest,
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
import { ViewerToolbar } from './ViewerToolbar';
import { OrientationWidget } from './OrientationWidget';
import type {
  BodyRepresentation,
  SketchObjectData,
  TopologySelection
} from '@openzcad/shared';
import type { ViewportCameraState } from '../lib/workspaceSession';
import type { MeasurementViewportAnnotation } from '../lib/measurements';
import type { RegionPickData } from './viewer/regionOverlay';
import { formatNumber } from '../lib/model';

interface ViewerShellProps {
  projectId: string;
  bodies: BodyRepresentation[];
  sketches: SketchOverlay[];
  measurementAnnotations: MeasurementViewportAnnotation[];
  selectedBodyIds: string[];
  selectedTopology: TopologySelection | null;
  selectedEdges: TopologySelection[];
  settings: ViewerSettings;
  fitSignal: number;
  viewRequest: { view: ViewTarget; nonce: number } | null;
  normalToFaceRequest: NormalToFaceRequest | null;
  rotateRequest: { direction: 'cw' | 'ccw'; nonce: number } | null;
  units: string;
  editableBodyIds: string[];
  extrudePreview: ExtrudePreview | null;
  movePreview: MovePreview | null;
  /** Committed Move awaiting its rebuild; forwarded to the viewer's pose hold. */
  moveCommitHold: MovePreview | null;
  /** Drag-phase body appearance patch; forwarded to the viewer's material. */
  appearancePreview: BodyAppearancePreview | null;
  modeOverlay?: ReactNode;
  hideViewerToolbar?: boolean;
  /**
   * View mode drops the utility rail — its controls move to the floating view
   * bar, and undo/redo have nothing to act on — but keeps the orientation cube,
   * which is navigation rather than editing.
   */
  viewMode?: boolean;
  /** Bottom-center summary of the current selection, with a measurement. */
  selectionChip: { label: string; detail?: string } | null;
  onClearSelection(): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
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
  onCylinderRadiusPreview(radius: number, exactGeometry: boolean): void;
  onCylinderRadiusCommit(radius: number): boolean;
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
  /** What measuring the hovered target would report; null when measure is off. */
  onMeasurePreview?:
    | ((
        selection: TopologySelection,
        point: { x: number; y: number; z: number }
      ) => string | null)
    | null;
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
  measurementAnnotations,
  selectedBodyIds,
  selectedTopology,
  selectedEdges,
  settings,
  fitSignal,
  viewRequest,
  normalToFaceRequest,
  rotateRequest,
  units,
  editableBodyIds,
  extrudePreview,
  movePreview,
  moveCommitHold,
  appearancePreview,
  modeOverlay,
  hideViewerToolbar = false,
  viewMode = false,
  selectionChip,
  onClearSelection,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
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
  onMeasurePreview,
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
  const selectionChipLabelRef = useRef<HTMLSpanElement | null>(null);
  const cylinderRadiusLabelSetterRef = useRef<
    ((radius: number | null) => void) | null
  >(null);
  cylinderRadiusLabelSetterRef.current = (radius) => {
    const label = selectionChipLabelRef.current;
    if (!label || !selectionChip) {
      return;
    }
    label.textContent =
      radius === null
        ? selectionChip.label
        : selectionChip.label.replace(
            /(Cylindrical face Ø)[^ ·]+/,
            `$1${formatNumber(radius * 2)}`
          );
  };

  return (
    <section
      className={`viewer-shell${viewMode ? ' view-mode' : ''}`}
      aria-label="3D viewport"
    >
      <ModelViewer
        key={projectId}
        bodies={bodies}
        sketches={sketches}
        measurementAnnotations={measurementAnnotations}
        selectedBodyIds={selectedBodyIds}
        selectedTopology={selectedTopology}
        selectedEdges={selectedEdges}
        settings={settings}
        fitSignal={fitSignal}
        viewRequest={viewRequest}
        normalToFaceRequest={normalToFaceRequest}
        rotateRequest={rotateRequest}
        units={units}
        editableBodyIds={editableBodyIds}
        extrudePreview={extrudePreview}
        movePreview={movePreview}
        moveCommitHold={moveCommitHold}
        appearancePreview={appearancePreview}
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
        cylinderRadiusLabelSetterRef={cylinderRadiusLabelSetterRef}
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
        onMeasurePreview={onMeasurePreview}
        regionHandle={regionHandle}
        onSelectSketchProfile={onSelectSketchProfile}
        onResizePrimitiveFace={onResizePrimitiveFace}
        onExtrudeDistanceChange={onExtrudeDistanceChange}
        onMovePreviewChange={onMovePreviewChange}
        onContextMenu={onContextMenu}
      />
      {!hideViewerToolbar && (
        <>
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
          </div>
          {!viewMode && (
            <ViewerToolbar
              settings={settings}
              projection={projection}
              canUndo={canUndo}
              canRedo={canRedo}
              onUndo={onUndo}
              onRedo={onRedo}
              onToggleGrid={onToggleGrid}
              onFit={onFit}
              onView={onView}
              onCycleDisplayMode={onCycleDisplayMode}
              onToggleProjection={onToggleProjection}
            />
          )}
        </>
      )}
      {selectionChip && (
        <div className="selection-chip" role="status">
          <span ref={selectionChipLabelRef} className="selection-chip-label">
            {selectionChip.label}
          </span>
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
    </section>
  );
}
