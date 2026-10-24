import type { ParameterPreviewBody } from '../lib/parameterVisualPreview';
import type {
  FeatureId,
  ProjectDocument,
  SketchDimensionIdentity
} from '@openzcad/shared';
import type { HoleGhost } from '../lib/holeGhost';
import type { CompositeShape } from '../lib/sketch/composites';
import type { ViewportImageSource } from './viewer/viewportImage';
import type { PrimitiveGhost } from '../lib/primitiveGhost';
import {
  datumOffsetHandle,
  datumPlaneDisplays,
  shiftedDatumFrame
} from '../lib/datumPlaneDisplay';
import { datumAxisDisplays } from '../lib/datumAxisDisplay';
import type { ReferenceImageDisplay } from '../lib/referenceImageDisplay';
import type { AutoFrameRequest } from '../lib/autoFrame';
import {
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode
} from 'react';
import {
  ModelViewer,
  type BodyAppearancePreview,
  type FaceResizeCommit,
  type ModelViewerProps,
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
  ExactSectionRegionDisplay,
  MovePreview,
  MoveSnap,
  PickDetail,
  ProjectionMode,
  SectionPlaneId,
  SelectionFilter,
  SketchOverlay,
  ViewerSettings,
  ViewTarget,
  ViewRequestTarget,
  WheelDevice
} from '@openzcad/viewport';
import { ViewerToolbar } from './ViewerToolbar';
import type { SavedViewsSectionProps } from './SavedViewsSection';
import {
  measurementAnnotationsOnScreen,
  sectionOutlineFor,
  type SectionOutlineState,
  type ViewportGeometry
} from '../lib/sectionOutline';
import { OrientationWidget } from './OrientationWidget';
import {
  ViewportScaleIndicator,
  type ViewportScaleSink,
  ViewportGridReadout,
  type SketchGridReadoutSink
} from './ViewportScaleIndicator';
import type {
  ArtifactId,
  BodyRepresentation,
  PlaneId,
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
import type { SelectionCalloutContent } from '../lib/selectionCallout';
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
  /**
   * What the viewport is drawing, as the one value the workspace built it
   * as: the document, its bodies on screen, and anything standing in front
   * of them. The bodies and the stand-ins arrive together, and the section
   * below is filtered through the same value, so what is drawn, what the
   * rail says about it and what the DXF button offers cannot describe
   * different models.
   */
  view: ViewportGeometry<ParameterPreviewBody>;
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
  autoFrame?: AutoFrameRequest | null;
  viewRequest: { view: ViewRequestTarget; nonce: number } | null;
  normalToFaceRequest: NormalToFaceRequest | null;
  units: string;
  editableBodyIds: string[];
  movePreview: MovePreview | null;
  /** Committed Move awaiting its rebuild; forwarded to the viewer's pose hold. */
  moveCommitHold: MovePreview | null;
  /** Drag-phase body appearance patch; forwarded to the viewer's material. */
  appearancePreview: BodyAppearancePreview | null;
  modeOverlay?: ReactNode;
  /**
   * The column layout's dock: one centred bar holding the viewer bar, the
   * caller's extras (selection filter, snap, activity log) and the scale.
   * Off, the bar and the scale keep their classic floating spots.
   */
  dockLayout?: boolean;
  dockExtras?: ReactNode;
  /**
   * More islands for the instrument rail, under the viewer bar: the model
   * drawer's Objects, History and Parameters buttons.
   */
  railExtras?: ReactNode;
  hideViewerToolbar?: boolean;
  /**
   * View mode drops the utility rail — its controls move to the floating view
   * bar, and undo/redo have nothing to act on — but keeps the orientation cube,
   * which is navigation rather than editing.
   */
  viewMode?: boolean;
  /**
   * The selection chip anchored to the pick in the viewport: its name,
   * measurement, verbs and clear action. The bottom-lane chip it replaced
   * said the same things away from the pick.
   */
  selectionCallout: SelectionCalloutContent | null;
  /** Consumed bodies a History row brings into focus, drawn as ghosts. */
  focusGhostBodies?: readonly BodyRepresentation[];
  /** The surviving faces a History row brings into focus, lit as selected. */
  focusFaces?: readonly TopologySelection[];
  canUndo: boolean;
  /** Undo is spent because older steps were dropped, not because none exist. */
  undoFloorTrimmed?: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  projection: ProjectionMode;
  initialView: ViewportCameraState | null;
  onViewChange(view: ViewportCameraState): void;
  onViewSettled(view: ViewportCameraState): void;
  onGeometryPresented?(durationMs: number): void;
  geometryTrace?: {
    projectId: string;
    version: number;
    analysis: 'pending' | 'ready';
  };
  /**
   * The viewer's own report of which bodies it drew away from their document
   * pose. It goes back to the workspace and returns as
   * `view.drawnElsewhere`, which is what stops a section describing a body
   * the viewport has moved out from under it.
   */
  onBodiesDrawnElsewhere?(bodyIds: string[]): void;
  onWheelDeviceLearned?(device: WheelDevice): void;
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  selectionFilter: SelectionFilter;
  onBoxSelect(bodyIds: string[]): void;
  /** See `ModelViewerProps.onBoxSelectTopology`. */
  onBoxSelectTopology?(
    selections: TopologySelection[],
    kind: 'face' | 'edge'
  ): void;
  onSelectEdgeChain(selections: TopologySelection[]): void;
  onSelectTopology(
    selection: TopologySelection | null,
    additive: boolean,
    detail?: PickDetail
  ): void;
  /** See `ModelViewerProps.topologyPicksHeld`. */
  topologyPicksHeld?: boolean;
  offsetHandle: OffsetHandleTarget | null;
  onOffsetPreview(offset: number, exactGeometry?: boolean): void;
  onOffsetCommit(offset: number): boolean;
  onOffsetCancel(): void;
  offsetPreviewInvalid: boolean;
  previewDeferred: boolean;
  onOpenOffsetKeypad(
    currentOffset: number,
    totalBaseline?: number,
    totalSense?: 1 | -1
  ): boolean;
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
  /** Filled by the viewer: offscreen capture of the current view. */
  viewportImageRef?: MutableRefObject<ViewportImageSource | null>;
  cylinderRadiusHandle: CylinderRadiusHandleTarget | null;
  cylinderDimensionMode: DimensionMode;
  onCylinderDimensionModeChange(mode: DimensionMode): void;
  onCylinderRadiusPreview(radius: number, exactGeometry: boolean): void;
  onCylinderRadiusCommit(radius: number): boolean;
  onCylinderRadiusCancel(): void;
  onOpenCylinderRadiusKeypad(
    radius: number,
    dimensionMode: DimensionMode
  ): boolean;
  cancelDirectManipulationRef: MutableRefObject<(() => boolean) | null>;
  openExactEntryRef: MutableRefObject<(() => boolean) | null>;
  edgeHandle: EdgeHandleTarget | null;
  edgeHandleValue?: number | null;
  onEdgeRadiusPreview(size: number): void;
  onEdgeCommit(size: number): void;
  onEdgeCancel(): void;
  onOpenEdgeKeypad(currentSize: number): boolean;
  onDirectManipulationChange(dragging: boolean, source?: 'move'): void;
  sketchMode: SketchModeState | null;
  /** Where the text card's live outline sits; the card's Place reads it. */
  sketchTextAnchorRef?: MutableRefObject<{ x: number; y: number } | null>;
  onSketchCommit(object: SketchObjectData): void;
  onSketchCommitComposite(shape: CompositeShape): void;
  onEditSketchDimension(id: string, anchor: { x: number; y: number }): void;
  onMoveSketchDimension(
    identity: SketchDimensionIdentity,
    offset: { x: number; y: number }
  ): void;
  onSelectSketchConstraint?: ModelViewerProps['onSelectSketchConstraint'];
  onSketchConstraintSelectionShown?: ModelViewerProps['onSketchConstraintSelectionShown'];
  onSketchDrawingChange(drawing: boolean): void;
  sketchMoveEnabled?: ModelViewerProps['sketchMoveEnabled'];
  onSketchMoveChange?: ModelViewerProps['onSketchMoveChange'];
  onSketchMoveCommit?: ModelViewerProps['onSketchMoveCommit'];
  onSketchSelectObject: ModelViewerProps['onSketchSelectObject'];
  sketchViews: SketchViewData[];
  selectedProfileIds: string[];
  profileSelectionMode: boolean;
  onSelectRegion(
    region: RegionPickData,
    modifiers: { additive: boolean; toggle: boolean }
  ): void;
  onHoverRegion(region: RegionPickData | null): void;
  planePickerArmed: boolean;
  planePickerOffset: number;
  /** The open Hole card's bore, drawn before it exists. */
  holeGhost?: HoleGhost | null;
  /** The open primitive card's solid, drawn before Create. */
  primitiveGhost?: PrimitiveGhost | null;
  /** The document whose resolved R01 datum planes the viewport draws. */
  datumDocument?: ProjectDocument | null;
  /** Datum planes hidden by their eye toggle. */
  hiddenDatumIds?: ReadonlySet<string>;
  /** I05 reference images to draw; see `ModelViewer`. */
  referenceImages?: readonly ReferenceImageDisplay[];
  loadReferenceImage?: (checksumSha256: string) => Promise<Blob | null>;
  /** The selected or edited feature, drawn highlighted when it is a datum. */
  selectedFeatureId?: FeatureId | null;
  onPickPlane(plane: PlaneId): void;
  onPickDatum?(featureId: string): void;
  /**
   * A drag of the selected datum's handle, as a change to its stored offset
   * (already signed for a reversed datum). The handle arms only when this is
   * set and no other offset handle is.
   */
  onDatumOffsetDrag?(delta: number): boolean;
  /**
   * How far the open Plane card's draft moves the selected datum, in its
   * stored offset (null when it is not a plain change of distance): the
   * plane and its pin are drawn there until Apply rebuilds the datum.
   */
  datumOffsetDraft?: number | null;
  /** Exact entry for the selected datum's handle: focuses the card's Offset. */
  onDatumOffsetEntry?(): boolean;
  /** What measuring the hovered target would report; null when measure is off. */
  onMeasurePreview?:
    | ((
        selection: TopologySelection,
        point: { x: number; y: number; z: number }
      ) => string | null)
    | null;
  regionHandle: RegionHandleTarget | null;
  /** F01: a click picks only a body face (see `ModelViewer`). */
  facePickOnly?: boolean;
  onSelectSketchProfile(sketchId: string): void;
  onResizePrimitiveFace(commit: FaceResizeCommit): void;
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
  /**
   * Build's Measure toggle on the instrument rail. View and Tweak carry their
   * own rail with Measure on it; absent, the button is not drawn.
   */
  measuring?: boolean;
  onMeasure?(next: boolean): void;
  onView(view: ViewTarget): void;
  /** The project's saved views, shown in the Standard views panel. */
  savedViews?: SavedViewsSectionProps;
  onCycleDisplayMode(): void;
  onToggleProjection(): void;
  /** Perspective field of view, degrees (Settings › Viewport). */
  fieldOfView?: number;
  /** Face opacity in X-ray, 0–1 (Settings › Viewport). */
  xrayOpacity?: number;
  sectionRange: { min: number; max: number } | null;
  onToggleSection(): void;
  onSectionPlane(plane: SectionPlaneId): void;
  onSectionOffset(offset: number): void;
  onSectionCommit(): void;
  onExportSectionDxf(): void;
  /**
   * What the section view is showing. The viewport's kernel geometry is
   * derived from it here rather than passed in beside it, so the drawn cut
   * and the rail's description of it can never disagree.
   */
  sectionOutline: SectionOutlineState;
}

export function ViewerShell({
  projectId,
  view,
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
  autoFrame = null,
  viewRequest,
  normalToFaceRequest,
  units,
  editableBodyIds,
  movePreview,
  moveCommitHold,
  appearancePreview,
  modeOverlay,
  hideViewerToolbar = false,
  dockLayout = false,
  dockExtras = null,
  railExtras = null,
  viewMode = false,
  selectionCallout,
  focusGhostBodies,
  focusFaces,
  canUndo,
  undoFloorTrimmed = false,
  canRedo,
  onUndo,
  onRedo,
  projection,
  initialView,
  onViewChange,
  onViewSettled,
  onGeometryPresented,
  geometryTrace,
  onBodiesDrawnElsewhere,
  onWheelDeviceLearned,
  orientationRef,
  onSelectTopology,
  topologyPicksHeld,
  onSelectEdgeChain,
  selectionFilter,
  onBoxSelect,
  onBoxSelectTopology,
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
  viewportImageRef,
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
  edgeHandleValue = null,
  onEdgeRadiusPreview,
  onEdgeCommit,
  onEdgeCancel,
  onOpenEdgeKeypad,
  onDirectManipulationChange,
  sketchMode,
  sketchTextAnchorRef,
  onSketchCommit,
  onSketchCommitComposite,
  onEditSketchDimension,
  onMoveSketchDimension,
  onSelectSketchConstraint,
  onSketchConstraintSelectionShown,
  onSketchDrawingChange,
  sketchMoveEnabled,
  onSketchMoveChange,
  onSketchMoveCommit,
  onSketchSelectObject,
  sketchViews,
  selectedProfileIds,
  profileSelectionMode,
  onSelectRegion,
  onHoverRegion,
  planePickerArmed,
  planePickerOffset,
  holeGhost = null,
  primitiveGhost = null,
  datumDocument = null,
  hiddenDatumIds,
  referenceImages,
  loadReferenceImage,
  selectedFeatureId = null,
  onPickPlane,
  onPickDatum,
  onDatumOffsetDrag,
  datumOffsetDraft = null,
  onDatumOffsetEntry,
  onMeasurePreview,
  regionHandle,
  facePickOnly,
  onSelectSketchProfile,
  onResizePrimitiveFace,
  onMovePreviewChange,
  onContextMenu,
  onToggleGrid,
  onFit,
  measuring = false,
  onMeasure,
  onView,
  savedViews,
  onCycleDisplayMode,
  onToggleProjection,
  fieldOfView,
  xrayOpacity,
  sectionRange,
  onToggleSection,
  onSectionPlane,
  onSectionOffset,
  onSectionCommit,
  onExportSectionDxf,
  sectionOutline
}: ViewerShellProps) {
  const { bodies, standIns: parameterVisualPreview } = view;
  /**
   * The section as this drawing may show it. An exact section describes the
   * document's own geometry, and while a stand-in is up the viewport is not
   * drawing that geometry — so the curves, the measured area on the rail and
   * the DXF button all come down together, from one reading of one value.
   */
  const drawnSection = sectionOutlineFor(view, sectionOutline);
  // Same reading for the measurement labels: one standing beside a face
  // keeps that face's box only while the face is drawn as built. Memoized
  // so the viewer reinstalls its labels only when the answer changes.
  const placedMeasurements = useMemo(
    () => measurementAnnotationsOnScreen(measurementAnnotations, view),
    [measurementAnnotations, view]
  );
  /** Kernel section geometry for the resting plane; null while dragging. */
  const exactSection: ExactSectionRegionDisplay[] | null =
    drawnSection.kind === 'exact' ? drawnSection.regions : null;
  // R01: a selected offset datum gets the same pin face offsets use. It
  // yields to any armed offset handle, and its target is memoized on the
  // values it shows so the rig is not rebuilt on every render.
  const datumHandle =
    // The pin arms only while the card's draft is this datum with nothing
    // but its distance changed: after a new source, a Midplane or an
    // expression, a drag could not show where Apply will put the plane.
    datumDocument &&
    onDatumOffsetDrag &&
    !offsetHandle &&
    datumOffsetDraft !== null
      ? datumOffsetHandle(
          datumDocument,
          selectedFeatureId,
          hiddenDatumIds ?? new Set()
        )
      : null;
  // The plane follows its edit: the card's draft Offset moves it (and the
  // pin) off the built frame, and a drag in progress moves it further, so
  // what is drawn is always where Apply would put it.
  const draftShift =
    datumHandle && datumOffsetDraft !== null
      ? datumOffsetDraft * datumHandle.sense
      : 0;
  const [datumDrag, setDatumDrag] = useState<{
    featureId: string;
    distance: number;
  } | null>(null);
  const dragShift =
    datumHandle && datumDrag?.featureId === datumHandle.featureId
      ? datumDrag.distance
      : 0;
  // Every datum gesture starts a fresh pin at zero: the gesture count is
  // part of the target, so a release (accepted, refused or back at zero)
  // rebuilds the rig and no gesture carries the last one's value.
  const [datumGesture, setDatumGesture] = useState(0);
  const datumHandleKey = datumHandle
    ? JSON.stringify({ ...datumHandle, draftShift, gesture: datumGesture })
    : '';
  const datumOffsetTarget = useMemo<OffsetHandleTarget | null>(() => {
    if (!datumHandleKey) return null;
    const handle = JSON.parse(datumHandleKey) as NonNullable<
      typeof datumHandle
    > & { draftShift: number };
    const { normal } = handle;
    return {
      bodyId: '',
      topologyId: '',
      point: {
        x: handle.point.x + normal.x * handle.draftShift,
        y: handle.point.y + normal.y * handle.draftShift,
        z: handle.point.z + normal.z * handle.draftShift
      },
      normal,
      initialValue: 0
    };
  }, [datumHandleKey]);
  const orientationDragRef = useRef<OrientationDragControls | null>(null);
  const scaleIndicatorRef = useRef<ViewportScaleSink | null>(null);
  const sketchGridReadoutRef = useRef<SketchGridReadoutSink | null>(null);
  // The selection chip is a viewport label now, and the viewer rewrites the
  // live diameter in its own labels; nothing React-rendered carries one.
  const cylinderRadiusLabelSetterRef = useRef<
    ((radius: number | null) => void) | null
  >(null);
  const cloudProjectId = measurementCloudSync?.[0];
  const cloudEnabled =
    cloudProjectId &&
    measurementCloudSync[1] &&
    measurementCloudSync[2].has(cloudProjectId) &&
    measurementCloudSync[3] === cloudProjectId;

  const viewerToolbar = (
    <ViewerToolbar
      settings={settings}
      projection={projection}
      canUndo={canUndo}
      undoFloorTrimmed={undoFloorTrimmed}
      canRedo={canRedo}
      onUndo={onUndo}
      onRedo={onRedo}
      onToggleGrid={onToggleGrid}
      onFit={onFit}
      measuring={measuring}
      {...(onMeasure ? { onMeasure } : {})}
      onView={onView}
      {...(savedViews ? { savedViews } : {})}
      onCycleDisplayMode={onCycleDisplayMode}
      onToggleProjection={onToggleProjection}
      sectionRange={sectionRange}
      onToggleSection={onToggleSection}
      onSectionPlane={onSectionPlane}
      onSectionOffset={onSectionOffset}
      onSectionCommit={onSectionCommit}
      onExportSectionDxf={onExportSectionDxf}
      sectionOutline={drawnSection}
      units={units}
    />
  );
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
        parameterVisualPreview={parameterVisualPreview}
        sketches={sketches}
        measurementAnnotations={placedMeasurements}
        selectedBodyIds={selectedBodyIds}
        selectedTopology={selectedTopology}
        previewFaceHighlights={previewFaceHighlights}
        selectionCallout={selectionCallout}
        {...(focusGhostBodies ? { focusGhostBodies } : {})}
        {...(focusFaces ? { focusFaces } : {})}
        selectedEdges={selectedEdges}
        pickListEnabled={pickListEnabled}
        settings={settings}
        exactSection={exactSection}
        fitSignal={fitSignal}
        autoFrame={autoFrame}
        viewRequest={viewRequest}
        normalToFaceRequest={normalToFaceRequest}
        units={units}
        editableBodyIds={editableBodyIds}
        movePreview={movePreview}
        moveCommitHold={moveCommitHold}
        appearancePreview={appearancePreview}
        projection={projection}
        initialView={initialView}
        onViewChange={onViewChange}
        onViewSettled={onViewSettled}
        onGeometryPresented={onGeometryPresented}
        geometryTrace={geometryTrace}
        onBodiesDrawnElsewhere={onBodiesDrawnElsewhere}
        onWheelDeviceLearned={onWheelDeviceLearned}
        orientationRef={orientationRef}
        orientationDragRef={orientationDragRef}
        scaleIndicatorRef={scaleIndicatorRef}
        sketchGridReadoutRef={sketchGridReadoutRef}
        onSelectTopology={onSelectTopology}
        topologyPicksHeld={topologyPicksHeld}
        onSelectEdgeChain={onSelectEdgeChain}
        selectionFilter={selectionFilter}
        onBoxSelect={onBoxSelect}
        {...(onBoxSelectTopology ? { onBoxSelectTopology } : {})}
        {...(fieldOfView !== undefined ? { fieldOfView } : {})}
        {...(xrayOpacity !== undefined ? { xrayOpacity } : {})}
        offsetHandle={offsetHandle ?? datumOffsetTarget}
        onOffsetPreview={
          datumOffsetTarget && datumHandle
            ? (distance) =>
                setDatumDrag({
                  featureId: datumHandle.featureId,
                  distance
                })
            : onOffsetPreview
        }
        onOffsetCommit={(value) => {
          if (!datumHandle || !onDatumOffsetDrag) return onOffsetCommit(value);
          setDatumDrag(null);
          setDatumGesture((gesture) => gesture + 1);
          return onDatumOffsetDrag(value * datumHandle.sense);
        }}
        onOffsetCancel={() => {
          setDatumDrag(null);
          setDatumGesture((gesture) => gesture + 1);
          onOffsetCancel();
        }}
        offsetPreviewInvalid={offsetPreviewInvalid}
        previewDeferred={previewDeferred}
        onOpenOffsetKeypad={
          datumOffsetTarget && !offsetHandle
            ? () => onDatumOffsetEntry?.() ?? false
            : onOpenOffsetKeypad
        }
        keypadAnchorRef={keypadAnchorRef}
        offsetSetterRef={offsetSetterRef}
        moveValuesSetterRef={moveValuesSetterRef}
        viewportImageRef={viewportImageRef}
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
        edgeHandleValue={edgeHandleValue}
        onEdgeRadiusPreview={onEdgeRadiusPreview}
        onEdgeCommit={onEdgeCommit}
        onEdgeCancel={onEdgeCancel}
        onOpenEdgeKeypad={onOpenEdgeKeypad}
        onDirectManipulationChange={onDirectManipulationChange}
        sketchMode={sketchMode}
        sketchTextAnchorRef={sketchTextAnchorRef}
        onSketchCommit={onSketchCommit}
        onSketchCommitComposite={onSketchCommitComposite}
        onEditSketchDimension={onEditSketchDimension}
        onMoveSketchDimension={onMoveSketchDimension}
        onSelectSketchConstraint={onSelectSketchConstraint}
        onSketchConstraintSelectionShown={onSketchConstraintSelectionShown}
        onSketchDrawingChange={onSketchDrawingChange}
        sketchMoveEnabled={sketchMoveEnabled}
        onSketchMoveChange={onSketchMoveChange}
        onSketchMoveCommit={onSketchMoveCommit}
        onSketchSelectObject={onSketchSelectObject}
        sketchViews={sketchViews}
        selectedProfileIds={selectedProfileIds}
        profileSelectionMode={profileSelectionMode}
        onSelectRegion={onSelectRegion}
        onHoverRegion={onHoverRegion}
        planePickerArmed={planePickerArmed}
        planePickerOffset={planePickerOffset}
        holeGhost={holeGhost}
        primitiveGhost={primitiveGhost}
        datumPlanes={
          datumDocument
            ? datumPlaneDisplays(
                datumDocument,
                hiddenDatumIds ?? new Set(),
                selectedFeatureId
              ).map((plane) =>
                plane.featureId === datumHandle?.featureId
                  ? {
                      ...plane,
                      frame: shiftedDatumFrame(
                        plane.frame,
                        draftShift + dragShift
                      )
                    }
                  : plane
              )
            : []
        }
        datumAxes={
          datumDocument
            ? datumAxisDisplays(
                datumDocument,
                hiddenDatumIds ?? new Set(),
                selectedFeatureId
              )
            : []
        }
        {...(referenceImages ? { referenceImages } : {})}
        {...(loadReferenceImage ? { loadReferenceImage } : {})}
        onPickPlane={onPickPlane}
        onPickDatum={onPickDatum}
        onMeasurePreview={onMeasurePreview}
        regionHandle={regionHandle}
        {...(facePickOnly ? { facePickOnly } : {})}
        onSelectSketchProfile={onSelectSketchProfile}
        onResizePrimitiveFace={onResizePrimitiveFace}
        onMovePreviewChange={onMovePreviewChange}
        onContextMenu={onContextMenu}
      />
      {dockLayout && !hideViewerToolbar && (
        <>
          {/* How you look at the model: icon instruments down the right edge,
              under the top islands. They never change with the selection. */}
          {!viewMode && (
            <div className="instrument-rail">
              {viewerToolbar}
              {railExtras}
            </div>
          )}
          {/* How picks and snaps behave, and the activity log: one quiet
              readout in the bottom-left corner, under the column. */}
          <div
            className="viewport-readout"
            role="group"
            aria-label="Viewport readout"
          >
            {dockExtras}
            {/* The sketch grid spacing reads beside the snap segment; the
                scale bar itself sits by the orientation cube. */}
            <ViewportGridReadout sinkRef={sketchGridReadoutRef} />
          </div>
        </>
      )}
      {/* After the rail and the readout in the document, though it is drawn
          in the bottom-right corner: Tab reaches the cube's eight facets
          after the instruments above it, not before them. Every island is
          placed absolutely with its own stacking, so the order moves
          nothing on screen. */}
      {!hideViewerToolbar && (
        <>
          <div className="viewer-rail-stack">
            {/* The scale stands on the cube, so the corner is one stack
                as narrow as the cube wherever the cube goes. */}
            <ViewportScaleIndicator
              scaleSinkRef={scaleIndicatorRef}
              units={units}
            />
            <OrientationWidget
              orientationRef={orientationRef}
              onSelectView={onView}
              onDragStart={() => orientationDragRef.current?.begin()}
              onDrag={(deltaX, deltaY) =>
                orientationDragRef.current?.move(deltaX, deltaY)
              }
              onDragEnd={() => orientationDragRef.current?.end()}
            />
          </div>
          {!viewMode && !dockLayout && viewerToolbar}
        </>
      )}
      {modeOverlay}
      {hideViewerToolbar && (
        <ViewportScaleIndicator
          scaleSinkRef={scaleIndicatorRef}
          units={units}
        />
      )}
    </section>
  );
}
