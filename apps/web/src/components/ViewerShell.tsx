import type { ParameterPreviewBody } from '../lib/parameterVisualPreview';
import type {
  FeatureId,
  ProjectDocument,
  SketchDimensionIdentity,
  Vector3
} from '@openzcad/shared';
import type { CompositeShape } from '../lib/sketch/composites';
import type { ViewportImageSource } from './viewer/viewportImage';
import {
  NO_TOUCH_MODIFIERS,
  type TouchModifiers
} from './viewer/touchNavigation';
import {
  datumOffsetHandle,
  datumPlaneDisplays,
  shiftedDatumFrame
} from '../lib/datumPlaneDisplay';
import {
  datumAxisDisplays,
  datumMarkerDisplays
} from '../lib/datumAxisDisplay';
import { commentPinsOf } from '../lib/commentPins';
import type { ProjectComment } from '@openzcad/shared';
import { useAssemblyView } from '../lib/assembly/useAssemblyView';
import type { ReferenceImageDisplay } from '../lib/referenceImageDisplay';
import type { AutoFrameRequest } from '../lib/autoFrame';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MutableRefObject,
  type ReactNode
} from 'react';
import {
  ModelViewer,
  type BodyAppearancePreview,
  type FaceResizeCommit,
  type ModelViewerProps,
  type ViewportContextMenuOptions,
  type CylinderRadiusHandleTarget,
  type EdgeHandleTarget,
  type OrientationDragControls,
  type NormalToFaceRequest,
  type RegionHandleTarget,
  type SketchModeState,
  type SketchViewData,
  type OffsetHandleTarget,
  type ViewerBodyPickRole,
  type ViewerPmiLabel
} from './ModelViewer';
import type {
  DisplayMode,
  ExactSectionRegionDisplay,
  MovePreview,
  MoveSnap,
  PickDetail,
  PickSnap,
  ProjectionMode,
  SectionOverlapPair,
  SectionPlaneId,
  SelectionFilter,
  SketchOverlay,
  TangentEdgeStyle,
  ViewerSettings,
  ViewTarget,
  ViewRequestTarget,
  WheelDevice
} from '@openzcad/viewport';
import {
  VIEWER_RAIL_STOPS,
  VIEWER_RAIL_STOPS_EXCEPT,
  ViewerToolbar
} from './ViewerToolbar';
import { describeSectionOverlap } from './SectionToolbox';
import { useRovingToolbar } from '../hooks/useRovingToolbar';
import type { SavedViewsSectionProps } from './SavedViewsSection';
import {
  measurementAnnotationsOnScreen,
  sectionOutlineFor,
  type SectionOutlineState,
  type ViewportGeometry
} from '../lib/sectionOutline';
import { OrientationWidget } from './OrientationWidget';
import type { OrientationLink } from './viewer/orientationCube';
import {
  ViewportScaleIndicator,
  type ViewportScaleSink,
  ViewportGridReadout,
  type SketchGridReadoutSink
} from './ViewportScaleIndicator';
import { ViewportFrameStats } from './ViewportFrameStats';
import type { FrameStatsSink } from '../lib/frameStats';
import type {
  ArtifactId,
  BodyRepresentation,
  PlaneId,
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
import { createLazyPanel } from './LazyPanel';
import type { AnalysisPanel as AnalysisPanelComponent } from './AnalysisPanel';
import {
  analysisRuntime,
  useAnalysisRuntime
} from '../lib/analysis/analysisRuntime';
import {
  useSurfaceAnalysis,
  type RunSurfaceAnalysis
} from '../lib/analysis/useSurfaceAnalysis';

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
  document: ProjectDocument,
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
  /** U11: each picked body's role in the running command (Base, Tool). */
  bodyPickRoles?: Readonly<Record<string, ViewerBodyPickRole>> | null;
  selectedTopology: TopologySelection | null;
  previewFaceHighlights: TopologySelection[];
  selectedEdges: TopologySelection[];
  pickListEnabled: boolean;
  /** Settings → Advanced → Frame rate overlay, a movable floating panel. */
  frameRateOverlay?: boolean;
  /** The panel's close button: turns the overlay setting off. */
  onCloseFrameRateOverlay?: () => void;
  settings: ViewerSettings;
  fitSignal: number;
  autoFrame?: AutoFrameRequest | null;
  creationFrame?: AutoFrameRequest | null;
  /** Bumped to keep the model in the clear stage (ModelViewer). */
  clearStageRequest?: number;
  viewRequest: { view: ViewRequestTarget; nonce: number } | null;
  normalToFaceRequest: NormalToFaceRequest | null;
  units: string;
  editableBodyIds: string[];
  /** See `ModelViewerProps.dragsHeldByCommand`. */
  dragsHeldByCommand?: ModelViewerProps['dragsHeldByCommand'];
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
  /**
   * Whether the active tool chose the selection filter (or Q did). Nothing
   * on screen names the filter (the status line says what Q chose), so the
   * viewer carries both as data for tests and tooling.
   */
  selectionFilterAutomatic?: boolean;
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
  /** Whether the pick wears a label in the viewport (ModelViewer). */
  pickLabel?: boolean;
  /** Consumed bodies a History row brings into focus, drawn as ghosts. */
  focusGhostBodies?: readonly BodyRepresentation[];
  /** The surviving faces a History row brings into focus, lit as selected. */
  focusFaces?: readonly TopologySelection[];
  /** M13: a hovered measurement's edges and faces (see `ModelViewer`). */
  measureHighlights?: readonly TopologySelection[];
  canUndo: boolean;
  /** Undo is spent because older steps were dropped, not because none exist. */
  undoFloorTrimmed?: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  /** Two- and three-finger taps undo and redo (Settings › Viewport). */
  touchHistoryGestures?: boolean;
  /** After a Pencil is used, fingers only navigate a sketch. */
  pencilDrawsOnly?: boolean;
  projection: ProjectionMode;
  initialView: ViewportCameraState | null;
  onViewChange(view: ViewportCameraState): void;
  onViewSettled(view: ViewportCameraState): void;
  onGeometryPresented?(durationMs: number, visible: boolean): void;
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
  orientationRef: MutableRefObject<OrientationLink | null>;
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
  /** See `ModelViewerProps.offsetSetTicks`. */
  offsetSetTicks?: ModelViewerProps['offsetSetTicks'];
  offsetDragTarget: Pick<OffsetHandleTarget, 'bodyId' | 'topologyId'> | null;
  onOffsetPreview(offset: number, exactGeometry?: boolean): void;
  onOffsetCommit: ModelViewerProps['onOffsetCommit'];
  onOffsetCancel: ModelViewerProps['onOffsetCancel'];
  offsetPreviewInvalid: boolean;
  offsetPreviewLimit?: ModelViewerProps['offsetPreviewLimit'];
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
  onCylinderRadiusCancel: ModelViewerProps['onCylinderRadiusCancel'];
  /** See `ModelViewer` `onRetakeLockedHandle`. */
  onRetakeLockedHandle?(): boolean;
  onOpenCylinderRadiusKeypad(
    radius: number,
    dimensionMode: DimensionMode
  ): boolean;
  cancelDirectManipulationRef: MutableRefObject<(() => boolean) | null>;
  openExactEntryRef: MutableRefObject<(() => boolean) | null>;
  edgeHandle: EdgeHandleTarget | null;
  onEdgeRadiusPreview(size: number): void;
  onEdgeCommit(size: number): void;
  onEdgeCancel(): void;
  onOpenEdgeKeypad(currentSize: number): boolean;
  onToggleEdgeOp?(): void;
  onDirectManipulationChange(dragging: boolean, source?: 'move'): void;
  sketchMode: SketchModeState | null;
  sketchFillet?: ModelViewerProps['sketchFillet'];
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
  onSketchSlotEntry?: ModelViewerProps['onSketchSlotEntry'];
  onSketchSlotStage?: ModelViewerProps['onSketchSlotStage'];
  sketchMoveEnabled?: ModelViewerProps['sketchMoveEnabled'];
  onSketchMoveChange?: ModelViewerProps['onSketchMoveChange'];
  onSketchMoveCommit?: ModelViewerProps['onSketchMoveCommit'];
  onSketchSelectObject: ModelViewerProps['onSketchSelectObject'];
  onSketchBoxSelect?: ModelViewerProps['onSketchBoxSelect'];
  sketchViews: SketchViewData[];
  selectedProfileIds: string[];
  profileSelectionMode: boolean;
  onSelectRegion(
    region: RegionPickData,
    modifiers: { additive: boolean; toggle: boolean }
  ): void;
  onBoxSelectRegions?: ModelViewerProps['onBoxSelectRegions'];
  onHoverRegion(region: RegionPickData | null): void;
  planePickerArmed: boolean;
  planePickerOffset: number;
  /** U09: in-place command axis lines, handle and keypad wiring. */
  axisPicker?: ModelViewerProps['axisPicker'];
  onPickAxis?: ModelViewerProps['onPickAxis'];
  commandHandles?: ModelViewerProps['commandHandles'];
  curvePicker?: ModelViewerProps['curvePicker'];
  onPickCurve?: ModelViewerProps['onPickCurve'];
  onCommandHandlePreview?: ModelViewerProps['onCommandHandlePreview'];
  onCommandHandleRelease?: ModelViewerProps['onCommandHandleRelease'];
  onOpenCommandKeypad?: ModelViewerProps['onOpenCommandKeypad'];
  onToggleCommandInstance?: ModelViewerProps['onToggleCommandInstance'];
  commandSetterRef?: ModelViewerProps['commandSetterRef'];
  footprintPicker?: ModelViewerProps['footprintPicker'];
  onFootprint?: ModelViewerProps['onFootprint'];
  /** The document whose resolved R01 datum planes the viewport draws. */
  datumDocument?: ProjectDocument | null;
  /** Datum planes hidden by their eye toggle. */
  hiddenDatumIds?: ReadonlySet<string>;
  /** I05 reference images to draw; see `ModelViewer`. */
  referenceImages?: readonly ReferenceImageDisplay[];
  loadReferenceImage?: (checksumSha256: string) => Promise<Blob | null>;
  /** The selected or edited feature, drawn highlighted when it is a datum. */
  selectedFeatureId?: FeatureId | null;
  onPickPlane(plane: PlaneId, point?: Vector3): void;
  onPickDatum?(featureId: string, point?: Vector3): void;
  /** See `ModelViewer`: the plane an empty click lands on, and where. */
  placementPlane?: { origin: Vector3; normal: Vector3 } | null;
  onPlacementClick?(point: Vector3): void;
  /**
   * L08: the review comments shown, whose threads `ModelViewer` draws as
   * numbered pins (`commentPinsOf`), and the one open in the panel.
   */
  comments?: readonly ProjectComment[];
  activeCommentId?: string | null;
  onCommentPinClick?(id: string): void;
  commentPlacing?: boolean;
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
        point: { x: number; y: number; z: number },
        snap?: PickSnap
      ) => string | null)
    | null;
  regionHandle: RegionHandleTarget | null;
  modelPanelsHidden?: boolean;
  /** F01: a click picks only a body face (see `ModelViewer`). */
  facePickOnly?: boolean;
  /** The surfaces a running command takes, picked through others (see `ModelViewer`). */
  facePickSurfaces?: readonly string[] | null;
  /** Shift adds faces of this body to a held face set (see `ModelViewer`). */
  faceSetPickBodyId?: string | null;
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
    selection: TopologySelection | null,
    options?: ViewportContextMenuOptions
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
  onDisplayMode(mode: DisplayMode): void;
  onToggleXray(): void;
  onToggleProjection(): void;
  /** Flips orbiting between Free and Turntable; absent, no rail button. */
  onToggleOrbitMode?(): void;
  /** Perspective field of view, degrees (Settings › Viewport). */
  fieldOfView?: number;
  /** Face opacity in X-ray, 0–1 (Settings › Viewport). */
  xrayOpacity?: number;
  /** How fillet and blend rims draw at rest (Settings › Viewport). */
  tangentEdges?: TangentEdgeStyle;
  sectionRange: { min: number; max: number } | null;
  onToggleSection(): void;
  /** No body on screen to cut; Section is greyed. */
  nothingToSection?: boolean;
  /** Whether the section controls show while the cut is on (remembered). */
  sectionPanelOpen?: boolean;
  /**
   * M09: the overlap note for the cut on screen (null when there is none),
   * for the status line that stands in for the put-away section controls.
   */
  onSectionOverlapNote?(note: string | null): void;
  onSectionPanelOpenChange?(open: boolean): void;
  onSectionPlane(plane: SectionPlaneId): void;
  onSectionOffset(offset: number): void;
  onSectionCommit(offset?: number): void;
  onSectionFlip?(): void;
  onExportSectionDxf(): void;
  /**
   * What the section view is showing. The viewport's kernel geometry is
   * derived from it here rather than passed in beside it, so the drawn cut
   * and the rail's description of it can never disagree.
   */
  sectionOutline: SectionOutlineState;
  /**
   * M09: runs the exact surface analysis (the geometry worker's). Absent,
   * the Display menu's analyses draw nothing.
   */
  runSurfaceAnalysis?: RunSurfaceAnalysis;
}

/** M09's analysis panel, loaded with the first analysis switched on. */
const AnalysisPanel = createLazyPanel<
  ComponentProps<typeof AnalysisPanelComponent>
>('Analysis panel', () =>
  import('./AnalysisPanel').then((module) => ({
    default: module.AnalysisPanel
  }))
);

export function ViewerShell({
  projectId,
  view,
  sketches,
  measurementAnnotations,
  measurementCloudSync,
  projectThumbnailSync,
  selectedBodyIds,
  bodyPickRoles = null,
  selectedTopology,
  previewFaceHighlights,
  selectedEdges,
  pickListEnabled,
  frameRateOverlay = false,
  onCloseFrameRateOverlay,
  settings,
  fitSignal,
  autoFrame = null,
  creationFrame = null,
  clearStageRequest = 0,
  viewRequest,
  normalToFaceRequest,
  units,
  editableBodyIds,
  dragsHeldByCommand,
  movePreview,
  moveCommitHold,
  appearancePreview,
  modeOverlay,
  hideViewerToolbar = false,
  selectionFilterAutomatic = true,
  dockLayout = false,
  dockExtras = null,
  railExtras = null,
  viewMode = false,
  selectionCallout,
  pickLabel,
  focusGhostBodies,
  focusFaces,
  measureHighlights,
  canUndo,
  undoFloorTrimmed = false,
  canRedo,
  onUndo,
  onRedo,
  touchHistoryGestures = true,
  pencilDrawsOnly = true,
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
  offsetSetTicks,
  offsetDragTarget,
  onOffsetPreview,
  onOffsetCommit,
  onOffsetCancel,
  offsetPreviewInvalid,
  offsetPreviewLimit = null,
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
  onRetakeLockedHandle,
  onOpenCylinderRadiusKeypad,
  cancelDirectManipulationRef,
  openExactEntryRef,
  edgeHandle,
  onEdgeRadiusPreview,
  onEdgeCommit,
  onEdgeCancel,
  onOpenEdgeKeypad,
  onToggleEdgeOp,
  onDirectManipulationChange,
  sketchMode,
  sketchFillet,
  sketchTextAnchorRef,
  onSketchCommit,
  onSketchCommitComposite,
  onEditSketchDimension,
  onMoveSketchDimension,
  onSelectSketchConstraint,
  onSketchConstraintSelectionShown,
  onSketchDrawingChange,
  onSketchSlotEntry,
  onSketchSlotStage,
  sketchMoveEnabled,
  onSketchMoveChange,
  onSketchMoveCommit,
  onSketchSelectObject,
  onSketchBoxSelect,
  sketchViews,
  selectedProfileIds,
  profileSelectionMode,
  onSelectRegion,
  onBoxSelectRegions,
  onHoverRegion,
  planePickerArmed,
  planePickerOffset,
  axisPicker = null,
  onPickAxis,
  commandHandles,
  curvePicker = null,
  onPickCurve,
  onCommandHandlePreview,
  onCommandHandleRelease,
  onOpenCommandKeypad,
  onToggleCommandInstance,
  commandSetterRef,
  footprintPicker = null,
  onFootprint,
  datumDocument = null,
  hiddenDatumIds,
  referenceImages,
  loadReferenceImage,
  selectedFeatureId = null,
  onPickPlane,
  onPickDatum,
  placementPlane = null,
  onPlacementClick,
  comments,
  activeCommentId = null,
  onCommentPinClick,
  commentPlacing = false,
  onDatumOffsetDrag,
  datumOffsetDraft = null,
  onDatumOffsetEntry,
  onMeasurePreview,
  regionHandle,
  modelPanelsHidden,
  facePickOnly,
  facePickSurfaces,
  faceSetPickBodyId = null,
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
  onDisplayMode,
  onToggleXray,
  onToggleProjection,
  onToggleOrbitMode,
  fieldOfView,
  xrayOpacity,
  tangentEdges,
  sectionRange,
  onToggleSection,
  nothingToSection,
  sectionPanelOpen,
  onSectionOverlapNote,
  onSectionPanelOpenChange,
  onSectionPlane,
  onSectionOffset,
  onSectionCommit,
  onSectionFlip,
  onExportSectionDxf,
  sectionOutline,
  runSurfaceAnalysis
}: ViewerShellProps) {
  // L08: the shown threads' pins, built here rather than in the workspace.
  const commentPins = useMemo(
    () => (comments ? commentPinsOf(comments, activeCommentId) : undefined),
    [comments, activeCommentId]
  );
  const { bodies, standIns: parameterVisualPreview } = view;
  // M09 analysis overlays: the analysis the Display menu switched on, run on
  // the bodies drawn as built. A stand-in or a body drawn somewhere else
  // than the build put it withholds the overlay rather than paint the
  // build's colours over a shape that is not the build's.
  const analysisRequest = useAnalysisRuntime((s) => s.request);
  // Defaults stated in millimetres (thickness's minimum wall) follow the
  // document's units.
  useEffect(() => {
    analysisRuntime.setUnits(units);
  }, [units]);
  const analysisBodyIds = useMemo(
    () => bodies.map((body) => body.bodyId),
    [bodies]
  );
  const analysisPreviewing =
    (parameterVisualPreview?.length ?? 0) > 0 || view.drawnElsewhere.length > 0;
  const analysis = useSurfaceAnalysis({
    request: analysisRequest,
    document: view.document,
    bodyIds: analysisBodyIds,
    previewing: analysisPreviewing,
    run: runSurfaceAnalysis
  });
  const analysisNames = useMemo(
    () => new Map(bodies.map((body) => [body.bodyId as string, body.name])),
    [bodies]
  );
  // M09: bodies overlapping inside the cut, as the viewport's section pass
  // found them on the display meshes; named for the section toolbox.
  const [sectionOverlapIds, setSectionOverlapIds] = useState<
    SectionOverlapPair[]
  >([]);
  const sectionOverlap = useMemo(() => {
    const names = new Map(bodies.map((body) => [body.bodyId, body.name]));
    return sectionOverlapIds.map((pair) => ({
      a: names.get(pair.a as never) ?? 'A body',
      b: names.get(pair.b as never) ?? 'a body',
      area: pair.area
    }));
  }, [bodies, sectionOverlapIds]);
  const sectionOverlapText = settings.sectionView
    ? describeSectionOverlap(sectionOverlap, units)
    : null;
  // M09: the overlap note goes up to the status line, which says a cut is
  // on while its controls are put away (Assemble, View, Build after
  // Escape) and carries the note in their place.
  useEffect(() => {
    onSectionOverlapNote?.(sectionOverlapText);
    return () => onSectionOverlapNote?.(null);
  }, [onSectionOverlapNote, sectionOverlapText]);
  // Assemble's posed view of the same document; null outside Assemble.
  const assemblyView = useAssemblyView(view.document);
  // D07: the selected face, for Objects' PMI rows (a click keeps its point).
  // Loaded on demand: none of the PMI code is in an eagerly loaded chunk.
  useEffect(() => {
    const face =
      selectedTopology?.kind === 'face' && selectedTopology.hash !== undefined
        ? { bodyId: selectedTopology.bodyId, hash: selectedTopology.hash }
        : null;
    void import('../lib/pmi/pmiSelection').then((store) =>
      store.setPmiFace(face)
    );
  }, [selectedTopology]);
  // D07: the entry open in Objects, which its label shows selected.
  const [selectedPmiId, setSelectedPmiId] = useState<string | null>(null);
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void import('../lib/pmi/pmiSelection').then((store) => {
      if (cancelled) return;
      const read = () => setSelectedPmiId(store.pmiSelection().selectedPmiId);
      read();
      unsubscribe = store.subscribePmiSelection(read);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
  // D07: the model's PMI labels, drawn by an on-demand module.
  const modelPmi = view.document?.pmi;
  const pmiBodies = view.document?.derived.bodyRepresentations;
  const [pmiLabels, setPmiLabels] = useState<readonly ViewerPmiLabel[]>([]);
  useEffect(() => {
    if (!modelPmi || !pmiBodies) {
      setPmiLabels((current) => (current.length ? [] : current));
      return;
    }
    let cancelled = false;
    void Promise.all([
      import('../lib/pmi/modelPmi'),
      import('./DrawingWorkspace')
    ]).then(([module, layouts]) => {
      if (!cancelled)
        setPmiLabels(
          module.pmiViewportLabels(modelPmi, pmiBodies, selectedPmiId, layouts)
        );
    });
    return () => {
      cancelled = true;
    };
  }, [modelPmi, pmiBodies, selectedPmiId]);
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
  // Workspace-local, like a held key: a reload starts with neither on.
  const [touchModifiers, setTouchModifiers] =
    useState<TouchModifiers>(NO_TOUCH_MODIFIERS);
  // The instrument rail is one tab stop: the viewer bar, the relations
  // beside it while sketching, and the panel buttons, walked with the arrow
  // keys. Fourteen stops stood here between the top bar and the first
  // modeling tool.
  const instrumentRailRef = useRef<HTMLDivElement | null>(null);
  useRovingToolbar(instrumentRailRef, {
    items: VIEWER_RAIL_STOPS,
    except: VIEWER_RAIL_STOPS_EXCEPT,
    orient: '.viewer-rail'
  });
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
  const normalToSketchRef = useRef<(() => void) | null>(null);
  const scaleIndicatorRef = useRef<ViewportScaleSink | null>(null);
  const sketchGridReadoutRef = useRef<SketchGridReadoutSink | null>(null);
  const frameStatsRef = useRef<FrameStatsSink | null>(null);
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
      // Its panel can stay up on the last cut after the cut is switched off;
      // that cut belongs to this project, so another project starts clean.
      key={projectId ?? ''}
      settings={settings}
      projection={projection}
      canUndo={canUndo}
      undoFloorTrimmed={undoFloorTrimmed}
      canRedo={canRedo}
      onUndo={onUndo}
      onRedo={onRedo}
      touchModifiers={touchModifiers}
      onTouchModifiersChange={setTouchModifiers}
      onToggleGrid={onToggleGrid}
      onFit={onFit}
      onNormalToSketch={
        sketchMode ? () => normalToSketchRef.current?.() : undefined
      }
      measuring={measuring}
      {...(onMeasure ? { onMeasure } : {})}
      onView={onView}
      {...(savedViews ? { savedViews } : {})}
      onDisplayMode={onDisplayMode}
      onToggleXray={onToggleXray}
      onToggleProjection={onToggleProjection}
      {...(onToggleOrbitMode ? { onToggleOrbitMode } : {})}
      sectionRange={sectionRange}
      onToggleSection={onToggleSection}
      {...(nothingToSection ? { nothingToSection } : {})}
      {...(sectionPanelOpen !== undefined ? { sectionPanelOpen } : {})}
      {...(onSectionPanelOpenChange ? { onSectionPanelOpenChange } : {})}
      onSectionPlane={onSectionPlane}
      onSectionOffset={onSectionOffset}
      onSectionCommit={onSectionCommit}
      onSectionFlip={onSectionFlip}
      onExportSectionDxf={onExportSectionDxf}
      sectionOutline={drawnSection}
      sectionOverlap={sectionOverlap}
      units={units}
      roving={!dockLayout}
    />
  );
  return (
    <section
      className={`viewer-shell${viewMode ? ' view-mode' : ''}`}
      aria-label="3D viewport"
      tabIndex={-1}
      data-selection-filter={selectionFilter}
      data-selection-filter-source={
        selectionFilterAutomatic ? 'tool' : 'manual'
      }
    >
      {projectThumbnailSync ? (
        <ProjectThumbnailSyncAgent
          document={projectThumbnailSync[0]}
          publishToCloud={projectThumbnailSync[1]}
          transport={projectThumbnailSync[2]}
          loadThumbnail={projectThumbnailSync[3]}
          saveThumbnail={projectThumbnailSync[4]}
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
        pmiLabels={pmiLabels}
        selectedBodyIds={selectedBodyIds}
        bodyPickRoles={bodyPickRoles}
        selectedTopology={selectedTopology}
        previewFaceHighlights={previewFaceHighlights}
        selectionCallout={selectionCallout}
        pickLabel={pickLabel}
        {...(focusGhostBodies ? { focusGhostBodies } : {})}
        {...(focusFaces ? { focusFaces } : {})}
        {...(measureHighlights ? { measureHighlights } : {})}
        selectedEdges={selectedEdges}
        pickListEnabled={pickListEnabled}
        settings={settings}
        exactSection={exactSection}
        onSectionOverlap={setSectionOverlapIds}
        analysisOverlay={analysis.overlay}
        fitSignal={fitSignal}
        autoFrame={autoFrame}
        creationFrame={creationFrame}
        clearStageRequest={clearStageRequest}
        viewRequest={viewRequest}
        normalToFaceRequest={normalToFaceRequest}
        units={units}
        editableBodyIds={editableBodyIds}
        dragsHeldByCommand={dragsHeldByCommand}
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
        normalToSketchRef={normalToSketchRef}
        scaleIndicatorRef={scaleIndicatorRef}
        sketchGridReadoutRef={sketchGridReadoutRef}
        frameStatsRef={frameStatsRef}
        onSelectTopology={(selection, additive, detail) => {
          // D07: a new PMI entry's leader lands where its face was clicked.
          if (
            selection?.kind === 'face' &&
            selection.hash !== undefined &&
            detail?.point
          ) {
            const face = {
              bodyId: selection.bodyId,
              hash: selection.hash,
              point: {
                x: detail.point.x,
                y: detail.point.y,
                z: detail.point.z
              }
            };
            void import('../lib/pmi/pmiSelection').then((store) =>
              store.setPmiFace(face)
            );
          }
          onSelectTopology(selection, additive, detail);
        }}
        topologyPicksHeld={topologyPicksHeld}
        onSelectEdgeChain={onSelectEdgeChain}
        selectionFilter={selectionFilter}
        onBoxSelect={onBoxSelect}
        {...(onBoxSelectTopology ? { onBoxSelectTopology } : {})}
        {...(fieldOfView !== undefined ? { fieldOfView } : {})}
        {...(xrayOpacity !== undefined ? { xrayOpacity } : {})}
        {...(tangentEdges !== undefined ? { tangentEdges } : {})}
        offsetHandle={offsetHandle ?? datumOffsetTarget}
        // A datum's offset handle is never a face set's.
        offsetSetTicks={offsetHandle ? offsetSetTicks : null}
        offsetDragTarget={offsetDragTarget ?? datumOffsetTarget}
        onOffsetPreview={
          datumOffsetTarget && datumHandle
            ? (distance) =>
                setDatumDrag({
                  featureId: datumHandle.featureId,
                  distance
                })
            : onOffsetPreview
        }
        onOffsetCommit={(value, reading) => {
          if (!datumHandle || !onDatumOffsetDrag)
            return onOffsetCommit(value, reading);
          setDatumDrag(null);
          setDatumGesture((gesture) => gesture + 1);
          return onDatumOffsetDrag(value * datumHandle.sense)
            ? 'started'
            : 'blocked';
        }}
        onOffsetCancel={(atOriginal) => {
          setDatumDrag(null);
          setDatumGesture((gesture) => gesture + 1);
          return onOffsetCancel(atOriginal);
        }}
        offsetPreviewInvalid={offsetPreviewInvalid}
        offsetPreviewLimit={offsetPreviewLimit}
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
        {...(onRetakeLockedHandle ? { onRetakeLockedHandle } : {})}
        onOpenCylinderRadiusKeypad={onOpenCylinderRadiusKeypad}
        cancelDirectManipulationRef={cancelDirectManipulationRef}
        openExactEntryRef={openExactEntryRef}
        edgeHandle={edgeHandle}
        onEdgeRadiusPreview={onEdgeRadiusPreview}
        onEdgeCommit={onEdgeCommit}
        onEdgeCancel={onEdgeCancel}
        onOpenEdgeKeypad={onOpenEdgeKeypad}
        onToggleEdgeOp={onToggleEdgeOp}
        onDirectManipulationChange={onDirectManipulationChange}
        sketchMode={sketchMode}
        sketchFillet={sketchFillet}
        sketchTextAnchorRef={sketchTextAnchorRef}
        onSketchCommit={onSketchCommit}
        onSketchCommitComposite={onSketchCommitComposite}
        onEditSketchDimension={onEditSketchDimension}
        onMoveSketchDimension={onMoveSketchDimension}
        onSelectSketchConstraint={onSelectSketchConstraint}
        onSketchConstraintSelectionShown={onSketchConstraintSelectionShown}
        onSketchDrawingChange={onSketchDrawingChange}
        onSketchSlotEntry={onSketchSlotEntry}
        onSketchSlotStage={onSketchSlotStage}
        sketchMoveEnabled={sketchMoveEnabled}
        onSketchMoveChange={onSketchMoveChange}
        onSketchMoveCommit={onSketchMoveCommit}
        onSketchSelectObject={onSketchSelectObject}
        onSketchBoxSelect={onSketchBoxSelect}
        sketchViews={sketchViews}
        selectedProfileIds={selectedProfileIds}
        profileSelectionMode={profileSelectionMode}
        onSelectRegion={onSelectRegion}
        onBoxSelectRegions={onBoxSelectRegions}
        onHoverRegion={onHoverRegion}
        planePickerArmed={planePickerArmed}
        planePickerOffset={planePickerOffset}
        axisPicker={axisPicker}
        onPickAxis={onPickAxis}
        commandHandles={commandHandles}
        curvePicker={curvePicker}
        onPickCurve={onPickCurve}
        onCommandHandlePreview={onCommandHandlePreview}
        onCommandHandleRelease={onCommandHandleRelease}
        onOpenCommandKeypad={onOpenCommandKeypad}
        onToggleCommandInstance={onToggleCommandInstance}
        commandSetterRef={commandSetterRef}
        footprintPicker={footprintPicker}
        onFootprint={onFootprint}
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
        datumMarkers={
          datumDocument
            ? datumMarkerDisplays(
                datumDocument,
                hiddenDatumIds ?? new Set(),
                selectedFeatureId
              )
            : { points: [], systems: [] }
        }
        {...(referenceImages ? { referenceImages } : {})}
        {...(loadReferenceImage ? { loadReferenceImage } : {})}
        onPickPlane={onPickPlane}
        onPickDatum={onPickDatum}
        placementPlane={placementPlane}
        {...(onPlacementClick ? { onPlacementClick } : {})}
        {...(commentPins ? { commentPins } : {})}
        {...(onCommentPinClick ? { onCommentPinClick } : {})}
        commentPlacing={commentPlacing}
        onMeasurePreview={onMeasurePreview}
        regionHandle={regionHandle}
        modelPanelsHidden={modelPanelsHidden}
        {...(facePickOnly ? { facePickOnly } : {})}
        {...(facePickSurfaces ? { facePickSurfaces } : {})}
        faceSetPickBodyId={faceSetPickBodyId}
        onSelectSketchProfile={onSelectSketchProfile}
        onResizePrimitiveFace={onResizePrimitiveFace}
        onMovePreviewChange={onMovePreviewChange}
        onContextMenu={onContextMenu}
        onTouchHistory={(step) => {
          if (!touchHistoryGestures) return;
          if (step === 'undo' ? canUndo : canRedo) {
            if (step === 'undo') onUndo();
            else onRedo();
          }
        }}
        touchModifiers={touchModifiers}
        pencilDrawsOnly={pencilDrawsOnly}
        assemblyView={assemblyView}
      />
      {dockLayout && !hideViewerToolbar && (
        <>
          {/* How you look at the model: icon instruments down the right edge,
              under the top islands. They never change with the selection. */}
          {!viewMode && (
            <div className="instrument-rail" ref={instrumentRailRef}>
              {viewerToolbar}
              {railExtras}
              {/* The sketch snap and grid spacing: one quiet readout over
                  the head of the rails, which it hangs from. Last in the
                  rail so the rails' sibling selectors never see it. */}
              <div
                className="viewport-readout"
                role="group"
                aria-label="Viewport readout"
              >
                {dockExtras}
                <ViewportGridReadout sinkRef={sketchGridReadoutRef} />
              </div>
            </div>
          )}
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
            <OrientationWidget
              orientationRef={orientationRef}
              orbitMode={settings.orbitMode ?? 'free'}
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
      {/* M09: the analysis the Display menu switched on, with its legend,
          provenance and limits; its own island over the stage's foot. */}
      {!hideViewerToolbar && analysisRequest && analysis.state ? (
        <AnalysisPanel
          request={analysisRequest}
          run={analysis.state}
          previewing={analysisPreviewing}
          lengthUnit={units === 'inch' ? 'in' : units}
          nameOf={(bodyId) => analysisNames.get(bodyId) ?? 'A body'}
          onChange={analysisRuntime.update}
          onOff={analysisRuntime.off}
        />
      ) : null}
      {/* Upright in the stage's bottom-left corner at every window size. */}
      <ViewportScaleIndicator scaleSinkRef={scaleIndicatorRef} units={units} />
      {frameRateOverlay && (
        <ViewportFrameStats
          sinkRef={frameStatsRef}
          onClose={onCloseFrameRateOverlay}
        />
      )}
    </section>
  );
}
