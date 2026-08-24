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
  ArtifactId,
  BodyRepresentation,
  ProjectId,
  SketchObjectData,
  TopologySelection
} from '@openzcad/shared';
import type { ViewportCameraState } from '../lib/workspaceSession';
import type {
  Measurement,
  MeasurementDisplayOptions,
  MeasurementViewportAnnotation
} from '../lib/measurements';
import type { RegionPickData } from './viewer/regionOverlay';
import { formatNumber } from '../lib/model';
import {
  MeasurementCloudSyncAgent,
  type MeasurementCloudSyncAgentProps
} from './MeasurementCloudSyncAgent';
import { ProjectThumbnailSyncAgent } from './ProjectThumbnailSyncAgent';
import type { ProjectThumbnailRecord } from '../lib/localProjectStore';
import type { ThumbnailCloudTransport } from '../lib/cloudThumbnail';
import type { DimensionMode } from '../lib/keypad';

type MeasurementCloudSyncState = readonly [
  projectId: string | undefined,
  enabled: boolean | undefined,
  cloudProjectIds: ReadonlySet<string>,
  hydratedProjectId: string | null,
  measurements: readonly Measurement[],
  display: MeasurementDisplayOptions,
  setMeasurements: MeasurementCloudSyncAgentProps['setMeasurements'],
  setUnit: MeasurementCloudSyncAgentProps['setUnit'],
  setPrecision: MeasurementCloudSyncAgentProps['setPrecision'],
  setRadialDisplay: MeasurementCloudSyncAgentProps['setRadialDisplay'],
  loadLocal: MeasurementCloudSyncAgentProps['loadLocal'],
  saveLocal: MeasurementCloudSyncAgentProps['saveLocal']
];

type ProjectThumbnailSyncState = readonly [
  projectId: ProjectId,
  version: number,
  updatedAt: string,
  bodyRepresentations: Record<string, BodyRepresentation>,
  publishToCloud: boolean,
  transport: ThumbnailCloudTransport,
  loadThumbnail: (projectId: string) => Promise<ProjectThumbnailRecord | null>,
  saveThumbnail: (
    projectId: string,
    thumbnail: {
      source: string | null;
      artifactId?: ArtifactId;
      version: number;
      updatedAt: string;
    }
  ) => Promise<void>
];

interface ViewerShellProps {
  projectId: string;
  bodies: BodyRepresentation[];
  sketches: SketchOverlay[];
  measurementAnnotations: MeasurementViewportAnnotation[];
  measurementCloudSync?: MeasurementCloudSyncState;
  projectThumbnailSync?: ProjectThumbnailSyncState;
  selectedBodyIds: string[];
  selectedTopology: TopologySelection | null;
  previewFaceHighlights: TopologySelection[];
  selectedEdges: TopologySelection[];
  pickListEnabled: boolean;
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
  onViewSettled(view: ViewportCameraState): void;
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
  onOffsetPreview(offset: number): void;
  onOffsetCommit(offset: number): boolean;
  onOffsetCancel(): void;
  offsetPreviewInvalid: boolean;
  previewDeferred: boolean;
  onOpenOffsetKeypad(currentOffset: number, totalBaseline?: number): void;
  keypadAnchorRef: MutableRefObject<
    ((point: { x: number; y: number } | null) => void) | null
  >;
  offsetSetterRef: MutableRefObject<((offset: number) => void) | null>;
  moveValuesSetterRef: MutableRefObject<
    | ((
        translation: MovePreview['translation'],
        rotationDeg: MovePreview['rotationDeg'],
        snap: MoveSnap
      ) => void)
    | null
  >;
  cylinderRadiusHandle: CylinderRadiusHandleTarget | null;
  cylinderDimensionMode: DimensionMode;
  onCylinderDimensionModeChange(mode: DimensionMode): void;
  onCylinderRadiusPreview(radius: number, exactGeometry: boolean): void;
  onCylinderRadiusCommit(radius: number): boolean;
  onCylinderRadiusCancel(): void;
  onOpenCylinderRadiusKeypad(
    radius: number,
    dimensionMode: DimensionMode
  ): void;
  cancelDirectManipulationRef: MutableRefObject<(() => boolean) | null>;
  openExactEntryRef: MutableRefObject<(() => boolean) | null>;
  edgeHandle: EdgeHandleTarget | null;
  onEdgeRadiusPreview(size: number): void;
  onEdgeCommit(size: number): void;
  onEdgeCancel(): void;
  onOpenEdgeKeypad(currentSize: number): void;
  onDirectManipulationChange(dragging: boolean): void;
  sketchMode: SketchModeState | null;
  onSketchCommit(object: SketchObjectData): void;
  onSketchDrawingChange(drawing: boolean): void;
  onSketchSelectObject(
    objectId: string | null,
    snapPoint?: {
      objectId: string;
      point: 'start' | 'end' | 'center';
    } | null
  ): void;
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
  sectionRange: { min: number; max: number } | null;
  onCycleSection(): void;
  onSectionOffset(offset: number): void;
}

export function ViewerShell({
  projectId,
  bodies,
  sketches,
  measurementAnnotations,
  measurementCloudSync,
  projectThumbnailSync,
  selectedBodyIds,
  selectedTopology,
  previewFaceHighlights,
  selectedEdges,
  pickListEnabled,
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
  onViewSettled,
  orientationRef,
  onSelectTopology,
  onSelectEdgeChain,
  selectionFilter,
  onBoxSelect,
  offsetHandle,
  onOffsetPreview,
  onOffsetCommit,
  onOffsetCancel,
  offsetPreviewInvalid,
  previewDeferred,
  onOpenOffsetKeypad,
  keypadAnchorRef,
  offsetSetterRef,
  moveValuesSetterRef,
  cylinderRadiusHandle,
  cylinderDimensionMode,
  onCylinderDimensionModeChange,
  onCylinderRadiusPreview,
  onCylinderRadiusCommit,
  onCylinderRadiusCancel,
  onOpenCylinderRadiusKeypad,
  cancelDirectManipulationRef,
  openExactEntryRef,
  edgeHandle,
  onEdgeRadiusPreview,
  onEdgeCommit,
  onEdgeCancel,
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
  onToggleProjection,
  sectionRange,
  onCycleSection,
  onSectionOffset
}: ViewerShellProps) {
  const orientationDragRef = useRef<OrientationDragControls | null>(null);
  const selectionChipLabelRef = useRef<HTMLSpanElement | null>(null);
  const cylinderRadiusLabelSetterRef = useRef<
    ((radius: number | null) => void) | null
  >(null);
  const cloudProjectId = measurementCloudSync?.[0];
  const cloudEnabled =
    cloudProjectId &&
    measurementCloudSync[1] &&
    measurementCloudSync[2].has(cloudProjectId) &&
    measurementCloudSync[3] === cloudProjectId;
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
      {projectThumbnailSync ? (
        <ProjectThumbnailSyncAgent
          projectId={projectThumbnailSync[0]}
          version={projectThumbnailSync[1]}
          updatedAt={projectThumbnailSync[2]}
          bodyRepresentations={projectThumbnailSync[3]}
          publishToCloud={projectThumbnailSync[4]}
          transport={projectThumbnailSync[5]}
          loadThumbnail={projectThumbnailSync[6]}
          saveThumbnail={projectThumbnailSync[7]}
        />
      ) : null}
      {cloudEnabled ? (
        <MeasurementCloudSyncAgent
          projectId={cloudProjectId}
          measurements={measurementCloudSync[4]}
          display={measurementCloudSync[5]}
          setMeasurements={measurementCloudSync[6]}
          setUnit={measurementCloudSync[7]}
          setPrecision={measurementCloudSync[8]}
          setRadialDisplay={measurementCloudSync[9]}
          loadLocal={measurementCloudSync[10]}
          saveLocal={measurementCloudSync[11]}
        />
      ) : null}
      <ModelViewer
        key={projectId}
        bodies={bodies}
        sketches={sketches}
        measurementAnnotations={measurementAnnotations}
        selectedBodyIds={selectedBodyIds}
        selectedTopology={selectedTopology}
        previewFaceHighlights={previewFaceHighlights}
        selectedEdges={selectedEdges}
        pickListEnabled={pickListEnabled}
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
        onViewSettled={onViewSettled}
        orientationRef={orientationRef}
        orientationDragRef={orientationDragRef}
        onSelectTopology={onSelectTopology}
        onSelectEdgeChain={onSelectEdgeChain}
        selectionFilter={selectionFilter}
        onBoxSelect={onBoxSelect}
        offsetHandle={offsetHandle}
        onOffsetPreview={onOffsetPreview}
        onOffsetCommit={onOffsetCommit}
        onOffsetCancel={onOffsetCancel}
        offsetPreviewInvalid={offsetPreviewInvalid}
        previewDeferred={previewDeferred}
        onOpenOffsetKeypad={onOpenOffsetKeypad}
        keypadAnchorRef={keypadAnchorRef}
        offsetSetterRef={offsetSetterRef}
        moveValuesSetterRef={moveValuesSetterRef}
        cylinderRadiusHandle={cylinderRadiusHandle}
        cylinderDimensionMode={cylinderDimensionMode}
        onCylinderDimensionModeChange={onCylinderDimensionModeChange}
        cylinderRadiusLabelSetterRef={cylinderRadiusLabelSetterRef}
        onCylinderRadiusPreview={onCylinderRadiusPreview}
        onCylinderRadiusCommit={onCylinderRadiusCommit}
        onCylinderRadiusCancel={onCylinderRadiusCancel}
        onOpenCylinderRadiusKeypad={onOpenCylinderRadiusKeypad}
        cancelDirectManipulationRef={cancelDirectManipulationRef}
        openExactEntryRef={openExactEntryRef}
        edgeHandle={edgeHandle}
        onEdgeRadiusPreview={onEdgeRadiusPreview}
        onEdgeCommit={onEdgeCommit}
        onEdgeCancel={onEdgeCancel}
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
              sectionRange={sectionRange}
              onCycleSection={onCycleSection}
              onSectionOffset={onSectionOffset}
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
