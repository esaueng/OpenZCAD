import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { mark, measure, timed } from '../lib/perf';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import {
  CSS2DObject,
  CSS2DRenderer
} from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  MOVE_AXIS_COLORS,
  MOVE_AXIS_VECTORS,
  RightClickGestureTracker,
  viewDirectionFor,
  applyDisplayMode,
  CameraController,
  buildCylinderRadiusHandle,
  buildEdgeRadiusHandle,
  buildOffsetFaceHandle,
  bodiesInBox,
  boxSelectMode,
  cycleDepthPick,
  resolveSnap,
  translationToSnap,
  snapsFromEdges,
  SNAP_LABELS,
  SNAP_RADIUS_PX,
  isBoxSelectDrag,
  rectFromDrag,
  edgeRunFrom,
  edgeHandlePlacement,
  offsetHandlePlacement,
  GestureRouter,
  HudLayer,
  PickService,
  SelectionManager,
  applyMoveGizmoFocus,
  buildMoveGizmoParts,
  chooseMoveSnapStep,
  chooseRotateSnapStep,
  clearGroup,
  closestAxisT,
  composeMoveTransform,
  computeFitPose,
  createBodyEdgeOverlay,
  createAxesGizmo,
  createExtrudePreviewGeometry,
  createFatLine,
  createFatLineMaterial,
  createFatLineSegments,
  createGradientBackground,
  createObjectForBody,
  createShadowCatcher,
  createStudioEnvironment,
  createStudioGrid,
  createStudioHemisphereLight,
  dimensionLabelLayout,
  directEditDirectionFromNormal,
  fitCameraToObjects,
  forEachMesh,
  isSameMoveGizmoFocus,
  makeLabel,
  markExtrudeGizmo,
  moveEuler,
  moveGizmoHandleLabel,
  moveGizmoWorldScale,
  normalForTriangle,
  projectToScreen,
  projectedWorldSizePx,
  shouldShowGroundShadow,
  sketchCentroid,
  snapTo,
  syncFatLineResolution,
  updateAxesGizmo,
  updateStudioGrid,
  tuneShadowFrustum,
  VIEWPORT_RENDER_ORDER,
  type AxisProjection,
  type CameraPose,
  type DirectEditAxis,
  type MoveAxis,
  type MoveGizmoFocus,
  type MoveGizmoVisualData,
  type MoveHandleKind,
  type MovePreview,
  type DepthCycle,
  type DragRig,
  type MoveSnap,
  type PickCandidate,
  type PickDetail,
  type ProfilePickTarget,
  type SelectionFilter,
  type SnapCandidate,
  alignTranslationToCenters,
  centerAlignLabel,
  type CenterAlignMatch,
  type CenterAlignTarget,
  type SnapResolution,
  type ProjectionMode,
  type SketchOverlay,
  type ViewTarget,
  type ViewerSettings,
  type FatLineResolution,
  type BodyEdgeOverlay
} from '@openzcad/viewport';
import type { BodyRepresentation, TopologySelection } from '@openzcad/shared';
import { formatNumber } from '../lib/model';
import type { ViewportCameraState } from '../lib/workspaceSession';
import {
  buildSketchModeRig,
  type SketchModeRig
} from './viewer/sketchModeController';
import {
  REGION_COMMAND_OPACITY,
  REGION_IDLE_OPACITY,
  REGION_SELECTED_OPACITY,
  buildRegionMesh,
  triangulateRegionGeometry,
  type RegionPickData
} from './viewer/regionOverlay';
import {
  cylinderRadiusSnapStep,
  radiusFromRadialDelta
} from '../lib/interaction/cylinderRadius';
import {
  arcDimension,
  arcObjectFromPoints,
  arcPreviewPoints,
  axisLockPoint,
  circleObjectFromDiameter,
  circleObjectFromThreePoints,
  circlePreviewPoints,
  centerInferenceSegments,
  collectSketchSnapTargets,
  dimensionForInProgress,
  lineObjectFromPoints,
  nearestCenterGuideTarget,
  pointAtDistanceAlongDirection,
  resolveSketchSnap,
  screenRayToPlanePoint,
  SKETCH_SNAP_GLYPHS,
  SKETCH_SNAP_LABELS,
  sketchEntryPose,
  sketchObjectFromDrag,
  snapSketchPoint,
  textObjectFromPoint,
  type SketchPoint,
  type SnapTarget,
  type SnapTargetKind
} from '../lib/sketch/session';
import type { SketchCircleMode } from '../lib/interaction/machine';
import type { PlaneBasis } from '@openzcad/geometry';
import type { ParamValue, SketchObjectData } from '@openzcad/shared';
import { evalParamValue } from '../lib/model';
import { edgeLabel, faceLabel } from '../lib/topologyLabels';

export interface FaceResizeCommit {
  bodyId: TopologySelection['bodyId'];
  axis: DirectEditAxis;
  value: number;
}

/** An armed face-offset handle: where it sits and which face it edits. */
export interface OffsetHandleTarget {
  bodyId: string;
  topologyId: string;
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  /** Restored after a failed exact-kernel validation. */
  initialValue?: number;
}

/** An explicit cylindrical-wall radius handle with an immutable world axis. */
export interface CylinderRadiusHandleTarget {
  bodyId: string;
  topologyId: string;
  point: { x: number; y: number; z: number };
  radialDirection: { x: number; y: number; z: number };
  axisStart: { x: number; y: number; z: number };
  axisEnd: { x: number; y: number; z: number };
  originalRadius: number;
}

/** Active in-viewport sketch session, derived from the interaction machine. */
export interface SketchModeState {
  basis: PlaneBasis;
  tool: 'select' | 'line' | 'arc' | 'circle' | 'rectangle' | 'text';
  circleMode: SketchCircleMode;
  snapStep: number | null;
  gridVisible: boolean;
  geometrySnapEnabled: boolean;
  inferenceEnabled: boolean;
  snapTolerancePx: number;
  /** True while a line chain (or drag) is in flight; cleared by Escape. */
  drawing: boolean;
  /** Committed objects of the session's sketch, rendered in blue. */
  objects: { id: string; data: SketchObjectData }[];
  profiles: { outer: SketchPoint[]; holes: SketchPoint[][] }[];
  selectedObjectId: string | null;
  parameterScope: Record<string, number>;
  /** Plane-local endpoints highlighted by Profile diagnostics on request. */
  diagnosticPoints: { x: number; y: number }[];
}

/** Sketch curves + detected regions, rendered when direct manipulation is on. */
/**
 * In-plane bounding-box center of a sketch's curves, lifted to world space.
 * This is where the move gizmo sits when a sketch is the target. Null when
 * the sketch has nothing drawable yet (e.g. its font has not loaded).
 */
function sketchViewCenter(view: SketchViewData): THREE.Vector3 | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const curve of view.curves) {
    for (const point of curve.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return null;
  }
  const x = (minX + maxX) / 2;
  const y = (minY + maxY) / 2;
  const basis = view.basis;
  return new THREE.Vector3(
    basis.origin.x + basis.u.x * x + basis.v.x * y,
    basis.origin.y + basis.u.y * x + basis.v.y * y,
    basis.origin.z + basis.u.z * x + basis.v.z * y
  );
}

export interface SketchViewData {
  sketchId: string;
  basis: PlaneBasis;
  active: boolean;
  selected: boolean;
  curves: {
    points: { x: number; y: number }[];
    closed: boolean;
    construction: boolean;
  }[];
  regions: {
    profileId: string;
    regionFingerprint: number;
    samplePoint: { x: number; y: number };
    centroid: { x: number; y: number };
    boundingBox: {
      min: { x: number; y: number };
      max: { x: number; y: number };
    };
    sourceEntityIds: string[];
    area: number;
    outer: { x: number; y: number }[];
    holes: { x: number; y: number }[][];
  }[];
}

/** An armed region-extrude handle (drag a detected region into a solid). */
export interface RegionHandleTarget {
  sketchId: string;
  regionFingerprint: number;
  samplePoint: { x: number; y: number };
  area: number;
  initialValue?: number;
}

/** An armed edge fillet/chamfer handle over the current edge selection. */
export interface EdgeHandleTarget {
  bodyId: string;
  /** The last-picked edge anchors the handle; all edges round together. */
  topologyId: string;
  op: 'fillet' | 'chamfer';
  edgeCount: number;
  /** Restored after a failed exact-kernel validation. */
  initialValue?: number;
}

export interface OrientationDragControls {
  begin(): void;
  move(deltaX: number, deltaY: number): void;
  end(): void;
}

export interface ExtrudePreview {
  sketchId: string;
  distance: number;
}

interface ModelViewerProps {
  bodies: BodyRepresentation[];
  sketches: SketchOverlay[];
  /** Bodies highlighted in the viewport, in pick order. */
  selectedBodyIds: string[];
  selectedTopology: TopologySelection | null;
  /** Exact edges highlighted for a single edge-modifier operation. */
  selectedEdges: TopologySelection[];
  settings: ViewerSettings;
  /** Increment to re-fit the camera to the current geometry. */
  fitSignal: number;
  /** Set to move the camera to a view target; nonce forces re-runs. */
  viewRequest: { view: ViewTarget; nonce: number } | null;
  /**
   * Set to spin the view a quarter turn about the world up axis; direction is
   * how the model appears to turn on screen. Nonce forces re-runs.
   */
  rotateRequest: { direction: 'cw' | 'ccw'; nonce: number } | null;
  units: string;
  /** Primitive box bodies whose planar faces can drive document dimensions. */
  editableBodyIds: string[];
  extrudePreview: ExtrudePreview | null;
  movePreview: MovePreview | null;
  /**
   * A committed Move whose rebuild is still in flight. The body stays posed
   * at this transform (no gizmo) until new meshes arrive and the hold clears
   * in the same commit.
   */
  moveCommitHold: MovePreview | null;
  projection: ProjectionMode;
  /** Per-project camera pose restored before the first automatic fit. */
  initialView: ViewportCameraState | null;
  /** Durable camera pose emitted after navigation or programmatic view changes. */
  onViewChange(view: ViewportCameraState): void;
  /** Imperative sink for per-frame axis projections (no React re-render). */
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  /** Imperative bridge from the SVG view cube into the live camera rig. */
  orientationDragRef: MutableRefObject<OrientationDragControls | null>;
  onSelectTopology(
    selection: TopologySelection | null,
    additive: boolean,
    detail?: PickDetail
  ): void;
  /** What the pointer is allowed to select. */
  selectionFilter: SelectionFilter;
  /** Bodies swept by a drag rectangle; empty clears the selection. */
  onBoxSelect(bodyIds: string[]): void;
  /**
   * A whole smooth run of edges at once, from double-clicking one of them.
   *
   * Separate from `onSelectTopology` because the edges have to land in one
   * update: replaying them additively would read the same stale selection
   * each time and keep only the last.
   */
  onSelectEdgeChain(selections: TopologySelection[]): void;
  /** Armed face-offset handle (selection-first direct manipulation). */
  offsetHandle: OffsetHandleTarget | null;
  /** Fired when an offset-handle drag releases with a non-zero offset. */
  onOffsetCommit(offset: number): void;
  /** Value chip tapped: open exact entry prefilled with the current offset. */
  onOpenOffsetKeypad(currentOffset: number): void;
  /** Imperative sink receiving the chip anchor in host pixels each frame. */
  keypadAnchorRef: MutableRefObject<
    ((point: { x: number; y: number } | null) => void) | null
  >;
  /** Imperative setter letting exact entry drive the handle preview. */
  offsetSetterRef: MutableRefObject<((offset: number) => void) | null>;
  /** Dedicated cylindrical-wall handle; never reuses face translation. */
  cylinderRadiusHandle: CylinderRadiusHandleTarget | null;
  /** Streamed absolute radius during a drag. */
  onCylinderRadiusPreview(radius: number): void;
  /** Fired once on release with the absolute radius. */
  onCylinderRadiusCommit(radius: number): void;
  /** Clears transient exact geometry without creating history. */
  onCylinderRadiusCancel(): void;
  /** Value chip tapped: open exact entry for the absolute radius. */
  onOpenCylinderRadiusKeypad(radius: number): void;
  /** Escape reaches the active imperative pointer session through this ref. */
  cancelDirectManipulationRef: MutableRefObject<(() => boolean) | null>;
  /** Armed edge fillet/chamfer handle (selection-first direct manipulation). */
  edgeHandle: EdgeHandleTarget | null;
  /** Streamed while an edge-radius drag is in flight (throttled by App). */
  onEdgeRadiusPreview(size: number): void;
  /** Fired when the radius drag releases (or exact entry commits). */
  onEdgeCommit(size: number): void;
  /** Edge value chip tapped: open exact entry for the radius/distance. */
  onOpenEdgeKeypad(currentSize: number): void;
  /** Semantic lifecycle signal for direct-manipulation drags. */
  onDirectManipulationChange(dragging: boolean): void;
  /** Region-detected sketch rendering (curves + orange hover fills). */
  sketchViews: SketchViewData[];
  /** Stable ids of persistently selected bounded cells. */
  selectedProfileIds: string[];
  /** Extrude is actively requesting one or more profiles. */
  profileSelectionMode: boolean;
  /** A detected region was clicked: arm the extrude handle. */
  onSelectRegion(
    region: RegionPickData,
    modifiers: { additive: boolean; toggle: boolean }
  ): void;
  onHoverRegion(region: RegionPickData | null): void;
  /** Armed region-extrude handle; shares the arrow-rig drag machinery. */
  regionHandle: RegionHandleTarget | null;
  /** In-viewport sketch session; null when not sketching. */
  sketchMode: SketchModeState | null;
  /** A drawing gesture completed an entity. */
  onSketchCommit(object: SketchObjectData): void;
  /** Mirrors chain/drag liveness into the interaction machine. */
  onSketchDrawingChange(drawing: boolean): void;
  /** Selects a committed entity for exact-value editing. */
  onSketchSelectObject(objectId: string | null): void;
  onSelectSketchProfile(sketchId: string): void;
  onResizePrimitiveFace(commit: FaceResizeCommit): void;
  onExtrudeDistanceChange(distance: number): void;
  /** Fired while a move-gizmo handle drags; values are already snapped. */
  onMovePreviewChange(
    translation: MovePreview['translation'],
    rotationDeg: MovePreview['rotationDeg'],
    snap: MoveSnap
  ): void;
  /** Stationary right-click; right-drag stays a pan. */
  onContextMenu(
    x: number,
    y: number,
    selection: TopologySelection | null
  ): void;
}

/**
 * The imperative state bag shared by the viewport's interaction code. New
 * handle/gizmo modules receive this rather than reaching into React state.
 */
export interface SceneContext {
  scene: THREE.Scene;
  /*
   * Camera state is owned by the `CameraController` and read through here.
   * These are getters, not copies: the orbit controls are rebuilt on every
   * projection change, so a captured reference goes stale.
   */
  readonly camera: THREE.PerspectiveCamera;
  readonly orthographic: THREE.OrthographicCamera;
  readonly activeCamera: THREE.Camera;
  readonly projection: ProjectionMode;
  readonly controls: OrbitControls<THREE.Camera>;
  /** Switches projection, rebinding controls and syncing camera poses. */
  applyProjection(mode: ProjectionMode): void;
  /** Mirrors the perspective pose onto the ortho camera and its frustum. */
  syncOrthographic(resetZoom: boolean): void;
  /** Re-applies navigation preferences onto the live orbit controls. */
  refreshNavigation(): void;
  /** Starts a glide toward a new pose; user input cancels it. */
  startCameraTween(pose: CameraPose, onComplete?: () => void): void;
  /** The durable pose to persist for this project. */
  captureView(): ViewportCameraState;
  /** Invalidates the viewport and schedules a render if it is idle. */
  requestRender(): void;
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  bodyGroup: THREE.Group;
  sketchGroup: THREE.Group;
  overlayGroup: THREE.Group;
  gizmoGroup: THREE.Group;
  moveGizmoGroup: THREE.Group;
  /** Applies pending Move/Rotate values to the target body and the gizmo. */
  applyMovePreview(
    translation: MovePreview['translation'],
    rotationDeg: MovePreview['rotationDeg']
  ): void;
  grid: THREE.Object3D;
  shadowCatcher: THREE.Object3D;
  keyLight: THREE.DirectionalLight;
  raycaster: THREE.Raycaster;
  objectsByBodyId: Map<string, THREE.Object3D>;
  edgeOverlaysByBodyId: Map<string, BodyEdgeOverlay>;
  hasFitCamera: boolean;
  /** Viewport size in CSS pixels, the unit fat-line widths are given in. */
  fatLineResolution(): FatLineResolution;
  dimensionLabels: Set<DimensionLabelBinding>;
  /*
   * Hover and preselection are owned by the SelectionManager. The fields
   * below read through to it so existing call sites keep working.
   */
  readonly selection: SelectionManager;
  readonly hoveredBodyId: string | null;
  readonly hoveredEdge: Line2 | null;
  /** Single reusable preselection overlay for the face under the pointer. */
  readonly hoverFaceMesh: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshBasicMaterial
  >;
  /** Selection overlays fading in toward their resting opacity. */
  readonly fadeIns: Set<THREE.MeshBasicMaterial>;
  /** Frame timing for the overlay eases; `update()` once per frame, then read. */
  timer: THREE.Timer;
}

interface DimensionLabelBinding {
  pill: HTMLDivElement;
  start: THREE.Vector3;
  end: THREE.Vector3;
  modelCenter: THREE.Vector3;
  modelWorldSize: number;
  angleDeg?: number;
}

/**
 * Keeps name callouts readable when their anchor sits at the viewport's
 * edge. CSS2DRenderer centres each label on its projected point and rewrites
 * the transform every frame, so the correction rides on the margins instead:
 * the label's unmargined box is recovered from the current margin, and a new
 * margin is computed from scratch — no feedback across frames. Dimension and
 * drag-value callouts are excluded; they have their own placement scheme.
 */
function clampNameCallouts(container: HTMLElement) {
  const labels = container.querySelectorAll<HTMLElement>(
    '.selection-callout:not(.dimension-callout):not(.extrude-value-callout)'
  );
  if (labels.length === 0) {
    return;
  }
  const bounds = container.getBoundingClientRect();
  const pad = 4;
  for (const label of labels) {
    const currentLeft = parseFloat(label.style.marginLeft) || 0;
    const currentTop = parseFloat(label.style.marginTop) || 0;
    const rect = label.getBoundingClientRect();
    const baseLeft = rect.left - currentLeft;
    const baseRight = rect.right - currentLeft;
    const baseTop = rect.top - currentTop;
    const baseBottom = rect.bottom - currentTop;
    let marginLeft = 0;
    if (baseLeft < bounds.left + pad) {
      marginLeft = bounds.left + pad - baseLeft;
    } else if (baseRight > bounds.right - pad) {
      marginLeft = bounds.right - pad - baseRight;
    }
    let marginTop = 0;
    if (baseTop < bounds.top + pad) {
      marginTop = bounds.top + pad - baseTop;
    } else if (baseBottom > bounds.bottom - pad) {
      marginTop = bounds.bottom - pad - baseBottom;
    }
    if (marginLeft !== currentLeft) {
      label.style.marginLeft = marginLeft ? `${marginLeft}px` : '';
    }
    if (marginTop !== currentTop) {
      label.style.marginTop = marginTop ? `${marginTop}px` : '';
    }
  }
}

function updateDimensionLabels(
  context: SceneContext,
  viewportWidth: number,
  viewportHeight: number
) {
  for (const binding of context.dimensionLabels) {
    const start = binding.start.clone().project(context.activeCamera);
    const end = binding.end.clone().project(context.activeCamera);
    const layout = dimensionLabelLayout(
      {
        x: (start.x * 0.5 + 0.5) * viewportWidth,
        y: (-start.y * 0.5 + 0.5) * viewportHeight
      },
      {
        x: (end.x * 0.5 + 0.5) * viewportWidth,
        y: (-end.y * 0.5 + 0.5) * viewportHeight
      },
      projectedWorldSizePx(
        context.activeCamera,
        binding.modelCenter,
        binding.modelWorldSize,
        viewportHeight
      ),
      binding.angleDeg
    );
    binding.angleDeg = layout.angleDeg;
    binding.pill.style.setProperty(
      '--dimension-label-angle',
      `${layout.angleDeg.toFixed(1)}deg`
    );
    binding.pill.style.setProperty(
      '--dimension-label-scale',
      layout.scale.toFixed(3)
    );
  }
}

interface FaceDragState {
  pointerId: number;
  selection: TopologySelection;
  /** Pick detail captured at drag start, forwarded on click-through. */
  detail: PickDetail;
  object: THREE.Object3D;
  axis: DirectEditAxis;
  side: -1 | 1;
  initialValue: number;
  latestValue: number;
  startX: number;
  startY: number;
  directionX: number;
  directionY: number;
  pixelsPerUnit: number;
  initialPosition: THREE.Vector3;
  initialScale: THREE.Vector3;
}

interface ExtrudeDragState {
  pointerId: number;
  startX: number;
  startY: number;
  initialDistance: number;
  directionX: number;
  directionY: number;
  pixelsPerUnit: number;
}

interface MoveDragState {
  pointerId: number;
  kind: 'axis' | 'ring' | 'center';
  axis: MoveAxis;
  /** Gizmo center at drag start (base center + translation). */
  pivot: THREE.Vector3;
  axisDirection: THREE.Vector3;
  startT: number;
  ringU: THREE.Vector3;
  ringV: THREE.Vector3;
  startAngle: number;
  startX: number;
  startY: number;
  cameraRight: THREE.Vector3;
  cameraUp: THREE.Vector3;
  worldPerPixel: number;
  startTranslation: MovePreview['translation'];
  startRotation: MovePreview['rotationDeg'];
  /** Moving thing's center with zero translation; snap math needs where it rests. */
  restingCenter: THREE.Vector3;
  snapMove: number;
  snapRotate: number;
}

const SELECTION_EMISSIVE = 0x173a5e;
const SELECTED_FACE_COLOR = 0x4da3ff;
const SELECTED_FACE_OPACITY = 0.5;
const SKETCH_COLOR = 0x4da3ff;
const SKETCH_SELECTED_COLOR = 0x9ecbff;
/**
 * Screen-space widths in CSS pixels for the non-body polylines. Native WebGL
 * lines were locked to one device pixel; a hair over one CSS pixel keeps the
 * previous visual weight while leaving the shader room to antialias.
 */
const SKETCH_CURVE_WIDTH = 1.4;
const PREVIEW_EDGE_WIDTH = 1.4;
const RIGHT_PAN_TARGET_EPSILON = 1e-9;

export function ModelViewer({
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
  moveCommitHold,
  projection,
  initialView,
  onViewChange,
  orientationRef,
  orientationDragRef,
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
  sketchViews,
  selectedProfileIds,
  profileSelectionMode,
  onSelectRegion,
  onHoverRegion,
  regionHandle,
  sketchMode,
  onSketchCommit,
  onSketchDrawingChange,
  onSketchSelectObject,
  onSelectSketchProfile,
  onResizePrimitiveFace,
  onExtrudeDistanceChange,
  onMovePreviewChange,
  onContextMenu
}: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contextRef = useRef<SceneContext | null>(null);
  const onSelectTopologyRef = useRef(onSelectTopology);
  onSelectTopologyRef.current = onSelectTopology;
  const onSelectEdgeChainRef = useRef(onSelectEdgeChain);
  onSelectEdgeChainRef.current = onSelectEdgeChain;
  // Read per pick rather than rebuilding the scene: changing the filter must
  // not dispose the drag rigs mid-gesture.
  const selectionFilterRef = useRef(selectionFilter);
  selectionFilterRef.current = selectionFilter;
  const onBoxSelectRef = useRef(onBoxSelect);
  onBoxSelectRef.current = onBoxSelect;
  const onResizePrimitiveFaceRef = useRef(onResizePrimitiveFace);
  onResizePrimitiveFaceRef.current = onResizePrimitiveFace;
  const onSelectSketchProfileRef = useRef(onSelectSketchProfile);
  onSelectSketchProfileRef.current = onSelectSketchProfile;
  const onExtrudeDistanceChangeRef = useRef(onExtrudeDistanceChange);
  onExtrudeDistanceChangeRef.current = onExtrudeDistanceChange;
  const extrudePreviewRef = useRef(extrudePreview);
  extrudePreviewRef.current = extrudePreview;
  const movePreviewRef = useRef(movePreview);
  movePreviewRef.current = movePreview;
  const moveCommitHoldRef = useRef(moveCommitHold);
  moveCommitHoldRef.current = moveCommitHold;
  const onMovePreviewChangeRef = useRef(onMovePreviewChange);
  onMovePreviewChangeRef.current = onMovePreviewChange;
  /** Base (untranslated) gizmo pivot: the target body's bbox center. */
  const moveCenterRef = useRef(new THREE.Vector3());
  const moveDragActiveRef = useRef(false);
  const moveGizmoHudRef = useRef<HTMLDivElement | null>(null);
  const sketchesRef = useRef(sketches);
  sketchesRef.current = sketches;
  const bodiesRef = useRef(bodies);
  bodiesRef.current = bodies;
  /** Last body projection installed in Three.js; selection-only renders reuse it. */
  const renderedBodiesRef = useRef<readonly BodyRepresentation[] | null>(null);
  const cylinderRadiusHandleRef = useRef(cylinderRadiusHandle);
  cylinderRadiusHandleRef.current = cylinderRadiusHandle;
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;
  const editableBodyIdsRef = useRef(new Set(editableBodyIds));
  editableBodyIdsRef.current = new Set(editableBodyIds);
  const unitsRef = useRef(units);
  unitsRef.current = units;
  const displayModeRef = useRef(settings.displayMode);
  displayModeRef.current = settings.displayMode;
  const showGridRef = useRef(settings.showGrid);
  showGridRef.current = settings.showGrid;
  const reducedMotionRef = useRef(settings.reducedMotion);
  reducedMotionRef.current = settings.reducedMotion;
  const zoomToCursorRef = useRef(settings.zoomToCursor);
  zoomToCursorRef.current = settings.zoomToCursor;
  const middleDragRef = useRef(settings.middleDrag);
  middleDragRef.current = settings.middleDrag;
  const initialViewRef = useRef(initialView);
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const onOffsetCommitRef = useRef(onOffsetCommit);
  onOffsetCommitRef.current = onOffsetCommit;
  const onOpenOffsetKeypadRef = useRef(onOpenOffsetKeypad);
  onOpenOffsetKeypadRef.current = onOpenOffsetKeypad;
  const onCylinderRadiusPreviewRef = useRef(onCylinderRadiusPreview);
  onCylinderRadiusPreviewRef.current = onCylinderRadiusPreview;
  const onCylinderRadiusCommitRef = useRef(onCylinderRadiusCommit);
  onCylinderRadiusCommitRef.current = onCylinderRadiusCommit;
  const onCylinderRadiusCancelRef = useRef(onCylinderRadiusCancel);
  onCylinderRadiusCancelRef.current = onCylinderRadiusCancel;
  const onOpenCylinderRadiusKeypadRef = useRef(onOpenCylinderRadiusKeypad);
  onOpenCylinderRadiusKeypadRef.current = onOpenCylinderRadiusKeypad;
  const onEdgeRadiusPreviewRef = useRef(onEdgeRadiusPreview);
  onEdgeRadiusPreviewRef.current = onEdgeRadiusPreview;
  const onEdgeCommitRef = useRef(onEdgeCommit);
  onEdgeCommitRef.current = onEdgeCommit;
  const onOpenEdgeKeypadRef = useRef(onOpenEdgeKeypad);
  onOpenEdgeKeypadRef.current = onOpenEdgeKeypad;
  const onDirectManipulationChangeRef = useRef(onDirectManipulationChange);
  onDirectManipulationChangeRef.current = onDirectManipulationChange;
  const edgeHandleOpRef = useRef<'fillet' | 'chamfer'>('fillet');
  /** Live edge-radius rig; owned by the edgeHandle effect below. */
  const edgeRigRef = useRef<DragRig | null>(null);
  const edgeDragActiveRef = useRef(false);
  const sketchModeRef = useRef(sketchMode);
  sketchModeRef.current = sketchMode;
  const onSelectRegionRef = useRef(onSelectRegion);
  onSelectRegionRef.current = onSelectRegion;
  const onHoverRegionRef = useRef(onHoverRegion);
  onHoverRegionRef.current = onHoverRegion;
  const profileSelectionModeRef = useRef(profileSelectionMode);
  profileSelectionModeRef.current = profileSelectionMode;
  const profilePickTargetsRef = useRef<ProfilePickTarget[]>([]);
  /** Group holding region-detected sketch rendering (curves + fills). */
  const regionGroupRef = useRef<THREE.Group | null>(null);
  const onSketchCommitRef = useRef(onSketchCommit);
  onSketchCommitRef.current = onSketchCommit;
  const onSketchDrawingChangeRef = useRef(onSketchDrawingChange);
  onSketchDrawingChangeRef.current = onSketchDrawingChange;
  const onSketchSelectObjectRef = useRef(onSketchSelectObject);
  onSketchSelectObjectRef.current = onSketchSelectObject;
  /** Live sketch rig + local gesture state (imperative, no re-renders). */
  const sketchRigRef = useRef<SketchModeRig | null>(null);
  const sketchGestureRef = useRef<{
    chainAnchor: SketchPoint | null;
    dragStart: SketchPoint | null;
    arcCenter: SketchPoint | null;
    arcStart: SketchPoint | null;
    circleFirst: SketchPoint | null;
    circleSecond: SketchPoint | null;
    awaitingSecondPoint: boolean;
    pointerId: number | null;
    moved: boolean;
  }>({
    chainAnchor: null,
    dragStart: null,
    arcCenter: null,
    arcStart: null,
    circleFirst: null,
    circleSecond: null,
    awaitingSecondPoint: false,
    pointerId: null,
    moved: false
  });
  const sketchDimLabelRef = useRef<HTMLDivElement | null>(null);
  /** Entity-snap candidates from committed sketch objects + cursor marker. */
  const snapTargetsRef = useRef<SnapTarget[]>([]);
  const sketchSnapMarkerRef = useRef<HTMLDivElement | null>(null);
  const sketchCenterTargetRef = useRef<HTMLDivElement | null>(null);
  /** Camera pose + projection to restore when leaving sketch mode. */
  const sketchReturnRef = useRef<{
    position: THREE.Vector3;
    target: THREE.Vector3;
    projection: ProjectionMode;
  } | null>(null);
  /** Live offset-handle rig; owned by the offsetHandle effect below. */
  const offsetRigRef = useRef<DragRig | null>(null);
  const offsetDragActiveRef = useRef(false);
  /** Cylindrical radius has its own non-translating affordance and lifecycle. */
  const cylinderRadiusRigRef = useRef<DragRig | null>(null);
  const cylinderRadiusDragActiveRef = useRef(false);
  const offsetChipRef = useRef<HTMLDivElement | null>(null);

  // Scene, renderers, controls, and the render loop live for the component's
  // lifetime; only the body/sketch/overlay groups rebuild on data changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const viewerHost = host;
    const e2eCanvasHooksEnabled =
      (
        import.meta.env as unknown as {
          VITE_E2E?: string;
        }
      ).VITE_E2E === '1';

    mark('viewer.init:begin');
    let firstFrame = true;
    let lastPerfFrameAt: number | null = null;
    const scene = new THREE.Scene();
    const gradientBackground = createGradientBackground();
    scene.background = gradientBackground;

    const renderer = timed(
      'viewer.renderer',
      () =>
        new THREE.WebGLRenderer({
          antialias: true,
          powerPreference: 'high-performance'
        })
    );
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.autoUpdate = false;
    // PCF is the soft one now: three r185 deprecated PCFSoftShadowMap and
    // silently substitutes this, warning on every renderer. Its sampler spreads
    // five Vogel-disk taps over `light.shadow.radius`, tuned in
    // tuneShadowFrustum — which is what PCFSoft used to be needed for.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    host.appendChild(renderer.domElement);

    // Studio environment rig: soft IBL reflections do the heavy lifting for
    // "real CAD" shading, so the analytic lights stay gentle.
    const environment = timed('viewer.environment', () =>
      createStudioEnvironment(renderer)
    );
    scene.environment = environment;
    scene.environmentIntensity = 0.4;

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(host.clientWidth, host.clientHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.inset = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    host.appendChild(labelRenderer.domElement);

    // The camera rig owns both cameras, the orbit controls, the projection
    // mode, and view glides. `requestRender` is passed as a thunk because it
    // is a hoisted function declaration further down this effect.
    const cameraRig = new CameraController({
      host,
      domElement: renderer.domElement,
      requestRender: () => requestRender(),
      onViewChange: (view) => onViewChangeRef.current(view),
      reducedMotion: () => reducedMotionRef.current === true,
      // Defaults on: zooming toward the pointer is what every modern CAD
      // tool does, and a saved view from before the preference existed
      // should get the current behaviour rather than the old one.
      zoomToCursor: () => zoomToCursorRef.current !== false,
      // Panning is what every other CAD tool puts on the middle drag; the
      // OrbitControls default of zoom is the odd one out.
      middleDrag: () => middleDragRef.current ?? 'pan'
    });
    const camera = cameraRig.perspective;
    const orthographic = cameraRig.orthographic;
    const orientationDragControls: OrientationDragControls = {
      begin: () => cameraRig.beginOrbitDrag(),
      move: (deltaX, deltaY) => cameraRig.orbitByPixels(deltaX, deltaY),
      end: () => cameraRig.endOrbitDrag()
    };
    orientationDragRef.current = orientationDragControls;

    // Z-up sky plus cool floor bounce keeps undersides readable without
    // weakening the directional key that defines face orientation.
    const skyLight = createStudioHemisphereLight();
    scene.add(skyLight);
    // Right, front, above — the studio key that casts the grounding shadow.
    const keyLight = new THREE.DirectionalLight('#ffffff', 1.35);
    keyLight.position.set(90, -100, 140);
    keyLight.castShadow = true;
    tuneShadowFrustum(keyLight, 120);
    renderer.shadowMap.needsUpdate = true;
    scene.add(keyLight);
    scene.add(keyLight.target);
    // Left, behind, slightly above — cool rim for edge separation.
    const rimLight = new THREE.DirectionalLight('#7aa3d0', 0.5);
    rimLight.position.set(-80, 90, 40);
    scene.add(rimLight);

    // Shader construction plane with distance fade, plus an invisible floor
    // that only receives the key light's soft shadow.
    const grid = createStudioGrid();
    scene.add(grid);
    const shadowCatcher = createShadowCatcher();
    scene.add(shadowCatcher);

    // Stretched per frame by updateAxesGizmo so each axis runs past the
    // viewport edge — on screen they read as infinite. Fat lines keep a
    // constant screen-space width, so the triad stays one crisp stroke at
    // any zoom.
    const axes = createAxesGizmo({
      width: renderer.domElement.clientWidth || 1,
      height: renderer.domElement.clientHeight || 1
    });
    scene.add(axes);

    const bodyGroup = new THREE.Group();
    bodyGroup.name = 'bodies';
    scene.add(bodyGroup);

    const sketchGroup = new THREE.Group();
    sketchGroup.name = 'sketches';
    const regionGroup = new THREE.Group();
    regionGroup.name = 'sketch-views';
    scene.add(regionGroup);
    regionGroupRef.current = regionGroup;
    scene.add(sketchGroup);

    const overlayGroup = new THREE.Group();
    overlayGroup.name = 'overlays';
    scene.add(overlayGroup);

    const gizmoGroup = new THREE.Group();
    gizmoGroup.name = 'direct-modeling-gizmo';
    scene.add(gizmoGroup);

    const moveGizmoGroup = new THREE.Group();
    moveGizmoGroup.name = 'move-rotate-gizmo';
    scene.add(moveGizmoGroup);

    // Raycasting and topology resolution. The active camera is read per call
    // because the projection toggle swaps it.
    const objectsByBodyId = new Map<string, THREE.Object3D>();
    const edgeOverlaysByBodyId = new Map<string, BodyEdgeOverlay>();

    const selection = new SelectionManager({
      bodyGroup,
      objectsByBodyId,
      domElement: renderer.domElement,
      requestRender: () => requestRender(),
      bodies: () => bodiesRef.current,
      isEditableBody: (bodyId: string) =>
        editableBodyIdsRef.current.has(bodyId),
      extrudeArmed: () => extrudePreviewRef.current !== null
    });

    // Pointer capture, orbit parking, drag cursor, and click-vs-drag for
    // every gesture below.
    const gestures = new GestureRouter({
      domElement: renderer.domElement,
      setControlsEnabled: (enabled) => {
        cameraRig.controls.enabled = enabled;
      }
    });

    const picker = new PickService({
      domElement: renderer.domElement,
      camera: () => cameraRig.activeCamera,
      regionGroup,
      sketchGroup,
      bodyGroup,
      filter: () => selectionFilterRef.current,
      profiles: () => profilePickTargetsRef.current,
      selectionContext: () =>
        profileSelectionModeRef.current
          ? 'profile-command'
          : sketchModeRef.current
            ? 'sketch-edit'
            : 'default'
    });

    function applyMovePreview(
      translation: MovePreview['translation'],
      rotationDeg: MovePreview['rotationDeg']
    ) {
      const preview = movePreviewRef.current ?? moveCommitHoldRef.current;
      if (!preview) {
        return;
      }
      const center = moveCenterRef.current;
      if (preview.target === 'sketch') {
        // A sketch preview shifts its overlay children — curves, region
        // fills, boundaries, markers — as a rigid translation. No rotation:
        // the document cannot store one for most sketch object kinds.
        const overlay = regionGroupRef.current;
        if (overlay) {
          for (const child of overlay.children) {
            if (child.userData.sketchViewId === preview.bodyId) {
              child.position.set(translation.x, translation.y, translation.z);
            }
          }
        }
      } else {
        const object = context.objectsByBodyId.get(preview.bodyId);
        if (object) {
          const final = composeMoveTransform(center, translation, rotationDeg);
          object.rotation.copy(moveEuler(rotationDeg));
          object.position.set(final.x, final.y, final.z);
        }
      }
      moveGizmoGroup.position.set(
        center.x + translation.x,
        center.y + translation.y,
        center.z + translation.z
      );
    }

    let animationFrame: number | null = null;
    let pendingHoverEvent: PointerEvent | null = null;
    let resizePending = false;

    function requestRender() {
      if (animationFrame === null) {
        animationFrame = window.requestAnimationFrame(animate);
      }
    }

    // The camera fields delegate to the rig rather than mirroring it: the
    // orbit controls are replaced outright on every projection change, so a
    // copied reference would go stale the first time the user presses P.
    const context: SceneContext = {
      scene,
      get camera() {
        return cameraRig.perspective;
      },
      get orthographic() {
        return cameraRig.orthographic;
      },
      get activeCamera() {
        return cameraRig.activeCamera;
      },
      get projection() {
        return cameraRig.projection;
      },
      get controls() {
        return cameraRig.controls;
      },
      applyProjection: (mode) => cameraRig.applyProjection(mode),
      syncOrthographic: (resetZoom) => cameraRig.syncOrthographic(resetZoom),
      refreshNavigation: () => cameraRig.refreshNavigationPreferences(),
      startCameraTween: (pose, onComplete) =>
        cameraRig.startTween(pose, onComplete),
      captureView: () => cameraRig.capture(),
      requestRender,
      renderer,
      labelRenderer,
      bodyGroup,
      sketchGroup,
      overlayGroup,
      gizmoGroup,
      moveGizmoGroup,
      applyMovePreview,
      grid,
      shadowCatcher,
      keyLight,
      raycaster: picker.raycaster,
      objectsByBodyId,
      edgeOverlaysByBodyId,
      hasFitCamera: false,
      get hoveredBodyId() {
        return selection.hoveredBodyId;
      },
      get hoveredEdge() {
        return selection.hoveredEdge;
      },
      fatLineResolution: () => ({
        width: renderer.domElement.clientWidth || 1,
        height: renderer.domElement.clientHeight || 1
      }),
      dimensionLabels: new Set(),
      get hoverFaceMesh() {
        return selection.hoverFaceMesh;
      },
      get fadeIns() {
        return selection.fadeIns;
      },
      selection,
      timer: new THREE.Timer()
    };
    contextRef.current = context;

    const restoredView = initialViewRef.current;
    if (restoredView) {
      cameraRig.restore(restoredView, projection);
      context.hasFitCamera = true;
    }

    const observer = new ResizeObserver(() => {
      // setSize clears the WebGL drawing buffer. Keep that clear in the same
      // animation frame as the next scene draw so continuous panel resizing
      // cannot present an empty buffer between two frames.
      resizePending = true;
      requestRender();
    });
    observer.observe(host);

    const rightClickGesture = new RightClickGestureTracker();
    /** Where "select other" has reached, for repeated clicks on one spot. */
    let depthCycle: DepthCycle | null = null;
    let rightPanStartTarget: THREE.Vector3 | null = null;
    /** Unmodified drag rubber band for selecting several bodies. */
    let boxSelect: {
      pointerId: number;
      startX: number;
      startY: number;
    } | null = null;
    /** Pointer whose Shift+left-drag is currently routed to camera orbit. */
    let shiftOrbitPointerId: number | null = null;
    let faceDrag: FaceDragState | null = null;
    let extrudeDrag: ExtrudeDragState | null = null;
    let moveDrag: MoveDragState | null = null;
    /**
     * Snap candidates for the body being moved, gathered once when the drag
     * starts. Only other bodies contribute — a body cannot be positioned
     * against its own corners — and rebuilding them per frame would walk
     * every edge of the model on every pointer move.
     */
    let moveSnaps: SnapCandidate[] = [];
    /** Face centers of the other bodies, for center-alignment snapping. */
    let moveCenterTargets: CenterAlignTarget[] = [];
    /** Screen-projected drag along the offset handle's normal. */
    let offsetDrag: {
      pointerId: number;
      startX: number;
      startY: number;
      directionX: number;
      directionY: number;
      pixelsPerUnit: number;
      initialOffset: number;
    } | null = null;
    /** Immutable radius-edit snapshot captured when the handle engages. */
    let cylinderRadiusDrag: {
      pointerId: number;
      startX: number;
      startY: number;
      directionX: number;
      directionY: number;
      pixelsPerUnit: number;
      bodyId: string;
      topologyId: string;
      axisStart: THREE.Vector3;
      axisEnd: THREE.Vector3;
      initialHitPoint: THREE.Vector3;
      radialDirection: THREE.Vector3;
      originalRadius: number;
      initialRadius: number;
    } | null = null;
    /** Screen-projected drag growing the edge blend radius. */
    let edgeDrag: {
      pointerId: number;
      startX: number;
      startY: number;
      directionX: number;
      directionY: number;
      pixelsPerUnit: number;
      initialValue: number;
      lastPreviewAt: number;
    } | null = null;
    const hud = new HudLayer(host);
    const dragHud = hud.create('direct-edit-hud');
    let activeSketchSnap: SnapTarget | null = null;
    let sketchSnapCycle = 0;
    let latestSketchPointerEvent: PointerEvent | null = null;
    let latestSketchPoint: SketchPoint | null = null;
    let sketchNumericRaw: string | null = null;
    let sketchNumericKind: 'radius' | 'diameter' | 'length' = 'length';
    cancelDirectManipulationRef.current = () => {
      let cancelled = false;
      if (cylinderRadiusDrag) {
        const originalRadius = cylinderRadiusDrag.originalRadius;
        gestures.release(cylinderRadiusDrag.pointerId, 'grab');
        cylinderRadiusDrag = null;
        cylinderRadiusDragActiveRef.current = false;
        cylinderRadiusRigRef.current?.setValue(originalRadius);
        onCylinderRadiusCancelRef.current();
        cancelled = true;
      }
      if (offsetDrag) {
        const initialOffset = offsetDrag.initialOffset;
        gestures.release(offsetDrag.pointerId, 'grab');
        offsetDrag = null;
        offsetDragActiveRef.current = false;
        offsetRigRef.current?.setValue(initialOffset);
        cancelled = true;
      }
      if (edgeDrag) {
        const initialValue = edgeDrag.initialValue;
        gestures.release(edgeDrag.pointerId, 'grab');
        edgeDrag = null;
        edgeDragActiveRef.current = false;
        edgeRigRef.current?.setValue(initialValue);
        cancelled = true;
      }
      if (cancelled) {
        onDirectManipulationChangeRef.current(false);
      }
      dragHud.hidden = true;
      renderer.domElement.style.cursor = 'default';
      requestRender();
      return cancelled;
    };
    const handleCapturedEscape = (event: KeyboardEvent) => {
      if (handleSketchNumericKey(event)) {
        return;
      }
      if (
        event.key === 'Tab' &&
        sketchModeRef.current &&
        latestSketchPointerEvent
      ) {
        activeSketchSnap = null;
        sketchSnapCycle += 1;
        updateSketchInProgress(latestSketchPointerEvent);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (
        event.key === 'Escape' &&
        cancelDirectManipulationRef.current?.() === true
      ) {
        // The viewport owns an active captured pointer. Retire it before the
        // workspace's normal Esc ladder can interpret the same key as
        // "clear the armed selection".
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('keydown', handleCapturedEscape, true);
    const selectionBand = hud.create('selection-band', { ariaHidden: true });
    const snapGlyph = hud.create('snap-glyph', { ariaHidden: true });

    /**
     * Marks the point a drag has locked onto, and names the kind.
     *
     * Naming it matters more than marking it: a glyph alone says something
     * happened, and "Endpoint" says the position is now exact rather than
     * merely close.
     */
    function showSnapGlyph(resolved: SnapResolution) {
      snapGlyph.textContent = SNAP_LABELS[resolved.candidate.kind];
      snapGlyph.dataset.kind = resolved.candidate.kind;
      // `resolved.screen` is already host-local: it was projected against the
      // canvas size, which is what the overlay is positioned within.
      hud.showAt(snapGlyph, resolved.screen.x, resolved.screen.y);
    }

    /** Snap candidates from every body except the one being moved. */
    function collectMoveSnaps(movingBodyId: string | null): SnapCandidate[] {
      return bodiesRef.current
        .filter((body) => !body.consumed && body.bodyId !== movingBodyId)
        .flatMap((body) =>
          body.topology
            ? snapsFromEdges(body.topology.edges, { label: body.name })
            : []
        );
    }

    /**
     * Centers to align the moving thing with: every face center of every
     * other body. Point snapping answers "is the handle on that corner";
     * these answer "is what I am moving centred on that face" — per axis,
     * so latching one axis or both are the same rule.
     */
    function collectCenterAlignTargets(
      movingBodyId: string | null
    ): CenterAlignTarget[] {
      return bodiesRef.current
        .filter((body) => !body.consumed && body.bodyId !== movingBodyId)
        .flatMap((body) =>
          (body.topology?.faces ?? []).flatMap((face) =>
            face.geometry?.center
              ? [{ point: face.geometry.center, label: body.name }]
              : []
          )
        );
    }

    /** Glyph + readout for a latched center alignment. */
    function showCenterAlignGlyph(matches: CenterAlignMatch[]): void {
      const target = matches[0]?.target;
      if (!target) {
        hud.hide(snapGlyph);
        return;
      }
      const host = renderer.domElement;
      const screen = projectToScreen(
        new THREE.Vector3(target.point.x, target.point.y, target.point.z),
        context.activeCamera,
        host.clientWidth,
        host.clientHeight
      );
      if (!screen) {
        hud.hide(snapGlyph);
        return;
      }
      snapGlyph.textContent = `◎ ${centerAlignLabel(matches)}`;
      snapGlyph.dataset.kind = 'center';
      hud.showAt(snapGlyph, screen.x, screen.y);
    }

    /**
     * Draws the rubber band, and dresses it by drag direction so the rule in
     * force is visible while it is still being chosen rather than explained
     * afterwards by what got selected.
     */
    function drawSelectionBand(
      startX: number,
      startY: number,
      event: PointerEvent
    ) {
      const from = hud.toLocal(startX, startY);
      const to = hud.toLocal(event.clientX, event.clientY);
      if (!from || !to) {
        return;
      }
      const rect = rectFromDrag(from.x, from.y, to.x, to.y);
      selectionBand.classList.toggle(
        'crossing',
        boxSelectMode(startX, event.clientX) === 'crossing'
      );
      selectionBand.style.width = `${rect.right - rect.left}px`;
      selectionBand.style.height = `${rect.bottom - rect.top}px`;
      hud.showAt(selectionBand, rect.left, rect.top);
    }

    function beginBoxSelect(event: PointerEvent) {
      boxSelect = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY
      };
      gestures.capture(event, 'crosshair');
    }

    // Value chip for the offset handle: tracks the arrow tip every frame.
    // Tapping it opens exact numeric entry, per the drag-or-type contract.
    const offsetChip = hud.create('handle-value-chip');
    offsetChip.dataset.testid = 'direct-manipulation-value';
    const handleChipClick = () => {
      const cylinderRig = cylinderRadiusRigRef.current;
      if (cylinderRig) {
        onOpenCylinderRadiusKeypadRef.current(cylinderRig.value());
        return;
      }
      const offsetRig = offsetRigRef.current;
      if (offsetRig) {
        onOpenOffsetKeypadRef.current(offsetRig.value());
        return;
      }
      const edgeRig = edgeRigRef.current;
      if (edgeRig) {
        onOpenEdgeKeypadRef.current(edgeRig.value());
      }
    };
    offsetChip.addEventListener('click', handleChipClick);
    offsetChipRef.current = offsetChip;

    // Companion "Radius" label pill for the cylinder dimension line, sitting
    // just ahead of the value chip like a drawing callout's name tag. Tapping
    // either pill opens the same exact-entry keypad.
    const radiusLabelChip = hud.create('handle-label-chip');
    radiusLabelChip.textContent = 'Radius';
    radiusLabelChip.addEventListener('click', handleChipClick);

    // Cursor-following dimension readout for in-viewport sketching.
    const sketchDimLabel = hud.create('sketch-dim-label');
    sketchDimLabelRef.current = sketchDimLabel;

    const sketchGridIndicator = hud.create('sketch-grid-indicator', {
      ariaHidden: true
    });

    // Entity-snap glyph pinned to the cursor: endpoint □, midpoint △, center ◎.
    const sketchSnapMarker = hud.create('sketch-snap-marker', {
      ariaHidden: true
    });
    sketchSnapMarkerRef.current = sketchSnapMarker;

    // Exact center beacon: appears before the snap engages so the cursor has
    // a visible destination instead of asking users to discover it by chance.
    const sketchCenterTarget = hud.create('sketch-center-target', {
      ariaHidden: true
    });
    for (const axis of ['horizontal', 'vertical'] as const) {
      const line = document.createElement('span');
      line.className = `sketch-center-axis ${axis}`;
      sketchCenterTarget.appendChild(line);
    }
    sketchCenterTargetRef.current = sketchCenterTarget;

    // Exact entry drives the same preview the drag does.
    offsetSetterRef.current = (value: number) => {
      if (cylinderRadiusRigRef.current) {
        cylinderRadiusRigRef.current.setValue(value);
      } else if (offsetRigRef.current) {
        offsetRigRef.current.setValue(value);
      } else {
        edgeRigRef.current?.setValue(value);
      }
      requestRender();
    };
    const moveGizmoHud = hud.create('move-gizmo-hud', { ariaHidden: true });
    moveGizmoHudRef.current = moveGizmoHud;

    function pick(event: PointerEvent | MouseEvent) {
      return picker.pick(event);
    }

    /**
     * Production builds contain no canvas-selection shortcut. The e2e build
     * can request a measured cylinder wall/cap selection so browser tests use
     * exact topology metadata instead of guessing a screen coordinate.
     */
    const handleE2ECylinderSelection = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          bodyId?: string;
          surface?: 'wall' | 'cap';
        }>
      ).detail;
      const body = bodiesRef.current.find(
        (candidate) =>
          !candidate.consumed &&
          (!detail?.bodyId || candidate.bodyId === detail.bodyId)
      );
      const faces = body?.topology?.faces ?? [];
      const face =
        detail?.surface === 'cap'
          ? faces.find(
              (candidate) =>
                candidate.geometry?.surfaceType === 'plane' &&
                candidate.geometry.normal !== undefined
            )
          : faces.find(
              (candidate) =>
                candidate.geometry?.surfaceType === 'cylinder' &&
                candidate.geometry.axisStart !== undefined &&
                candidate.geometry.axisEnd !== undefined &&
                candidate.geometry.radius !== undefined
            );
      if (!body || !face?.geometry) {
        return;
      }
      const geometry = face.geometry;
      let point = new THREE.Vector3(
        geometry.center.x,
        geometry.center.y,
        geometry.center.z
      );
      let normal = geometry.normal
        ? new THREE.Vector3(
            geometry.normal.x,
            geometry.normal.y,
            geometry.normal.z
          ).normalize()
        : null;
      if (
        geometry.surfaceType === 'cylinder' &&
        geometry.axisStart &&
        geometry.axisEnd &&
        geometry.radius !== undefined
      ) {
        const start = new THREE.Vector3(
          geometry.axisStart.x,
          geometry.axisStart.y,
          geometry.axisStart.z
        );
        const end = new THREE.Vector3(
          geometry.axisEnd.x,
          geometry.axisEnd.y,
          geometry.axisEnd.z
        );
        const axis = end.clone().sub(start).normalize();
        // Anchor on the screen-left silhouette. That keeps the real WebGL
        // handle outside the inspector/tool overlays at every tested size.
        const radial = new THREE.Vector3(1, 0, 0)
          .applyQuaternion(context.activeCamera.quaternion)
          .addScaledVector(
            axis,
            -new THREE.Vector3(1, 0, 0)
              .applyQuaternion(context.activeCamera.quaternion)
              .dot(axis)
          )
          .normalize()
          .negate();
        if (radial.lengthSq() < 1e-9) {
          const basis =
            Math.abs(axis.z) < 0.9
              ? new THREE.Vector3(0, 0, 1)
              : new THREE.Vector3(1, 0, 0);
          radial.crossVectors(axis, basis).normalize();
        }
        point = start
          .clone()
          .lerp(end, 0.5)
          .addScaledVector(radial, geometry.radius);
        normal =
          geometry.featureType === 'through-hole'
            ? radial.clone().negate()
            : radial;
      }
      if (!normal) {
        return;
      }
      onSelectTopologyRef.current(
        {
          bodyId: body.bodyId,
          kind: 'face',
          topologyId: face.topologyId,
          hash: face.hash
        },
        false,
        {
          point: { x: point.x, y: point.y, z: point.z },
          normal: { x: normal.x, y: normal.y, z: normal.z }
        }
      );
    };
    /**
     * Where on screen a pickable exact edge currently is.
     *
     * Browser regressions that click an edge have to aim at a line a couple of
     * pixels wide, and scanning a lattice of screen points hoping to land on
     * one is both slow and dependent on the fit pose. This projects the exact
     * display polyline through the active camera and then confirms the
     * candidate with the real PickService, so the reported point is one the
     * application itself resolves to that edge. Occluded samples fail that
     * confirmation, so only a visible edge is ever reported.
     */
    const handleE2ELocateEdge = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          bodyId?: string;
          resolve?: (
            value: { x: number; y: number; topologyId: string } | null
          ) => void;
        }>
      ).detail;
      if (!detail?.resolve) {
        return;
      }
      const body = bodiesRef.current.find(
        (candidate) =>
          !candidate.consumed &&
          (!detail.bodyId || candidate.bodyId === detail.bodyId)
      );
      const edges = (body?.topology?.edges ?? []).filter(
        (edge) => edge.displayRole !== 'seam'
      );
      const rect = renderer.domElement.getBoundingClientRect();
      const sample = new THREE.Vector3();
      for (const edge of edges) {
        for (let index = 0; index + 5 < edge.points.length; index += 3) {
          // Segment midpoints, not vertices: a vertex sits on two edges at
          // once, so which one a click there takes is an arbitrary tie-break.
          sample
            .set(
              (edge.points[index]! + edge.points[index + 3]!) / 2,
              (edge.points[index + 1]! + edge.points[index + 4]!) / 2,
              (edge.points[index + 2]! + edge.points[index + 5]!) / 2
            )
            .project(context.activeCamera);
          // Client coordinates are integers, so round before confirming: the
          // caller must click the exact point that was proven pickable.
          const clientX = Math.round(
            rect.left + ((sample.x + 1) / 2) * rect.width
          );
          const clientY = Math.round(
            rect.top + ((1 - sample.y) / 2) * rect.height
          );
          if (
            sample.z > 1 ||
            clientX <= rect.left ||
            clientX >= rect.right ||
            clientY <= rect.top ||
            clientY >= rect.bottom
          ) {
            continue;
          }
          // Selection chips, callouts, and the floating inspector are DOM
          // overlays on top of the canvas. A point one of them covers is
          // pickable in the scene but unreachable by a pointer, so it is not
          // an answer to "where can this edge be clicked".
          if (
            document.elementFromPoint(clientX, clientY) !== renderer.domElement
          ) {
            continue;
          }
          const picked = picker.pick(
            new MouseEvent('mousemove', { clientX, clientY })
          );
          if (
            picked?.selection?.kind === 'edge' &&
            picked.selection.topologyId === edge.topologyId
          ) {
            detail.resolve({
              x: clientX,
              y: clientY,
              topologyId: edge.topologyId
            });
            return;
          }
        }
      }
      detail.resolve(null);
    };
    /**
     * Select a detected profile by stable index in browser regressions. The
     * picker itself has focused unit coverage; this avoids racing the camera
     * tween while exercising the full application selection lifecycle.
     */
    const handleE2EProfileSelection = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          index?: number;
          additive?: boolean;
          toggle?: boolean;
        }>
      ).detail;
      const profile =
        profilePickTargetsRef.current[detail?.index ?? 0]?.pick ?? null;
      if (!profile) {
        return;
      }
      onSelectRegionRef.current(profile, {
        additive: detail?.additive ?? false,
        toggle: detail?.toggle ?? false
      });
    };
    /**
     * The regression suite builds real overlapping sketch/body geometry, then
     * reads this compact scene snapshot to prove the live renderer is using
     * the same depth-aware hierarchy covered by unit tests.
     */
    const handleE2ERenderPolicy = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          resolve?: (value: {
            bodyFaces: {
              depthTest: boolean;
              depthWrite: boolean;
              polygonOffset: boolean;
              polygonOffsetFactor: number;
              polygonOffsetUnits: number;
              renderOrder: number;
            }[];
            bodyEdges: {
              depthTest: boolean;
              depthWrite: boolean;
              name: string;
              renderOrder: number;
              visible: boolean;
            }[];
            sketchLines: {
              depthTest: boolean;
              depthWrite: boolean;
              name: string;
              renderOrder: number;
              visible: boolean;
            }[];
          }) => void;
        }>
      ).detail;
      if (!detail?.resolve) {
        return;
      }
      const bodyFaces: {
        depthTest: boolean;
        depthWrite: boolean;
        polygonOffset: boolean;
        polygonOffsetFactor: number;
        polygonOffsetUnits: number;
        renderOrder: number;
      }[] = [];
      forEachMesh(bodyGroup, (mesh) => {
        bodyFaces.push({
          depthTest: mesh.material.depthTest,
          depthWrite: mesh.material.depthWrite,
          polygonOffset: mesh.material.polygonOffset,
          polygonOffsetFactor: mesh.material.polygonOffsetFactor,
          polygonOffsetUnits: mesh.material.polygonOffsetUnits,
          renderOrder: mesh.renderOrder
        });
      });
      const lineStates = (root: THREE.Object3D) => {
        const states: {
          depthTest: boolean;
          depthWrite: boolean;
          name: string;
          renderOrder: number;
          visible: boolean;
        }[] = [];
        root.traverse((child) => {
          if (child instanceof LineSegments2) {
            states.push({
              depthTest: child.material.depthTest,
              depthWrite: child.material.depthWrite,
              name: child.name,
              renderOrder: child.renderOrder,
              visible: child.visible
            });
          }
        });
        return states;
      };
      detail.resolve({
        bodyFaces,
        bodyEdges: lineStates(bodyGroup),
        sketchLines: lineStates(regionGroup)
      });
    };
    /** Live camera state for bundled-WKWebView input smoke tests. */
    const handleE2EInputState = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          resolve?: (value: {
            camera: ViewportCameraState;
            controlsEnabled: boolean;
            controlState: number | null;
            mouseButtons: OrbitControls<THREE.Camera>['mouseButtons'];
          }) => void;
        }>
      ).detail;
      if (!detail?.resolve) {
        return;
      }
      const controls = cameraRig.controls as OrbitControls<THREE.Camera> & {
        state?: number;
      };
      detail.resolve({
        camera: cameraRig.capture(),
        controlsEnabled: controls.enabled,
        controlState: controls.state ?? null,
        mouseButtons: { ...controls.mouseButtons }
      });
    };
    /** Force a high-DPI backing store when a hosted Mac exposes a 1x display. */
    const handleE2EPixelRatio = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const value = (event as CustomEvent<{ value?: number }>).detail?.value;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return;
      }
      renderer.setPixelRatio(Math.min(value, 2));
      requestRender();
    };
    /**
     * Route a synthetic macOS pointer packet through OrbitControls itself.
     * The embedded WebDriver's W3C action endpoint emits MouseEvents, so it
     * cannot reach Three's PointerEvent-only control listener on WKWebView.
     */
    const handleE2EControlPointer = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          type?: 'pointerdown' | 'pointermove' | 'pointerup';
          init?: PointerEventInit;
          resolve?: (value: {
            camera: ViewportCameraState;
            controlsEnabled: boolean;
            controlState: number | null;
            mouseButtons: OrbitControls<THREE.Camera>['mouseButtons'];
            pointer: {
              button: number;
              clientX: number;
              clientY: number;
              shiftKey: boolean;
            };
          }) => void;
        }>
      ).detail;
      if (!detail?.type || !detail.resolve) {
        return;
      }
      const pointerEvent = new PointerEvent(detail.type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        isPrimary: true,
        ...detail.init
      });
      const controls = cameraRig.controls as OrbitControls<THREE.Camera> & {
        _onMouseDown(event: PointerEvent): void;
        _onMouseMove(event: PointerEvent): void;
        _onPointerUp(event: PointerEvent): void;
      };
      if (detail.type === 'pointerdown') {
        // Match the production viewport pointerdown path so a startup/fit
        // tween cannot overwrite the synthetic gesture on fast cached builds.
        cameraRig.cancelTween();
        if (pointerEvent.shiftKey) {
          cameraRig.setShiftOrbitActive(true);
        }
      }
      if (detail.type === 'pointerdown') {
        controls._onMouseDown(pointerEvent);
      } else if (detail.type === 'pointermove') {
        controls._onMouseMove(pointerEvent);
      } else {
        // No native pointer owns capture for this synthetic packet. Suppress
        // only that release call so OrbitControls can run its normal end/state
        // cleanup; the real canvas method is restored immediately afterward.
        const releasePointerCapture = renderer.domElement.releasePointerCapture;
        renderer.domElement.releasePointerCapture = () => undefined;
        try {
          controls._onPointerUp(pointerEvent);
        } finally {
          renderer.domElement.releasePointerCapture = releasePointerCapture;
          cameraRig.setShiftOrbitActive(false);
        }
      }
      detail.resolve({
        camera: cameraRig.capture(),
        controlsEnabled: controls.enabled,
        controlState:
          (controls as OrbitControls<THREE.Camera> & { state?: number })
            .state ?? null,
        mouseButtons: { ...controls.mouseButtons },
        pointer: {
          button: pointerEvent.button,
          clientX: pointerEvent.clientX,
          clientY: pointerEvent.clientY,
          shiftKey: pointerEvent.shiftKey
        }
      });
    };
    if (e2eCanvasHooksEnabled) {
      renderer.domElement.addEventListener(
        'openzcad:e2e-select-cylinder',
        handleE2ECylinderSelection
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-render-policy',
        handleE2ERenderPolicy
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-select-profile',
        handleE2EProfileSelection
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-locate-edge',
        handleE2ELocateEdge
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-input-state',
        handleE2EInputState
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-pixel-ratio',
        handleE2EPixelRatio
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-control-pointer',
        handleE2EControlPointer
      );
    }

    function selectAtPointer(event: PointerEvent) {
      const stack = picker.pickAll(event);
      const stepped = cycleDepthPick(
        stack,
        depthCycle,
        event.clientX,
        event.clientY
      );
      depthCycle = stepped.cycle;
      const result = stepped.candidate;
      if (result?.region) {
        onSelectRegionRef.current(result.region, {
          additive: event.shiftKey,
          toggle: event.ctrlKey || event.metaKey
        });
        return;
      }
      if (result?.sketchId) {
        onSelectSketchProfileRef.current(result.sketchId);
        return;
      }
      const detail: PickDetail | undefined = result
        ? {
            point: {
              x: result.hit.point.x,
              y: result.hit.point.y,
              z: result.hit.point.z
            },
            normal: result.faceNormal
              ? {
                  x: result.faceNormal.x,
                  y: result.faceNormal.y,
                  z: result.faceNormal.z
                }
              : undefined
          }
        : undefined;
      // Orbiting should turn about whatever was just clicked, not the model
      // origin — otherwise a detail you have zoomed into leaves the frame.
      if (result) {
        cameraRig.pivotOn(result.hit.point);
      }
      onSelectTopologyRef.current(
        result?.selection ?? null,
        event.shiftKey,
        detail
      );
    }

    function setRayFromEvent(event: PointerEvent | MouseEvent) {
      picker.setRayFromEvent(event);
    }

    function pickExtrudeGizmo(event: PointerEvent) {
      if (!extrudePreviewRef.current) {
        return null;
      }
      setRayFromEvent(event);
      return (
        picker
          .intersect(gizmoGroup.children)
          .find((hit) => hit.object.userData.extrudeGizmo) ?? null
      );
    }

    /** World units spanned by one screen pixel at the given point. */
    function worldPerPixelAt(point: THREE.Vector3): number {
      const height = Math.max(renderer.domElement.clientHeight, 1);
      if (context.projection === 'orthographic') {
        return (
          (orthographic.top - orthographic.bottom) /
          Math.max(orthographic.zoom, 0.0001) /
          height
        );
      }
      const distance = Math.max(camera.position.distanceTo(point), 0.001);
      return (
        (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) /
        height
      );
    }

    function pickMoveGizmo(event: PointerEvent) {
      if (!movePreviewRef.current) {
        return null;
      }
      setRayFromEvent(event);
      return (
        context.raycaster
          .intersectObjects(moveGizmoGroup.children, true)
          .find((hit) => hit.object.userData.moveHandle) ?? null
      );
    }

    function moveGizmoFocusFromHit(
      hit: THREE.Intersection<THREE.Object3D> | null
    ): MoveGizmoFocus | null {
      if (!hit) {
        return null;
      }
      const data = hit.object.userData as {
        kind?: MoveHandleKind;
        axis?: MoveAxis;
      };
      if (!data.kind) {
        return null;
      }
      return { kind: data.kind, axis: data.axis ?? 'x' };
    }

    function updateMoveGizmoFocus(focus: MoveGizmoFocus | null) {
      const previous =
        (moveGizmoGroup.userData.focus as MoveGizmoFocus | undefined) ?? null;
      if (!isSameMoveGizmoFocus(previous, focus)) {
        applyMoveGizmoFocus(moveGizmoGroup, focus);
      }
    }

    function positionMoveGizmoHud(
      event: PointerEvent,
      focus: MoveGizmoFocus,
      active = false,
      value?: number
    ) {
      const axisColor =
        focus.kind === 'center' ? 0xe8f3ff : MOVE_AXIS_COLORS[focus.axis];
      const baseLabel = moveGizmoHandleLabel(focus.kind, focus.axis);
      const suffix =
        value === undefined
          ? ''
          : focus.kind === 'ring'
            ? ` · ${Math.round(value * 10) / 10}°`
            : ` · ${Math.round(value * 100) / 100} ${unitsRef.current}`;
      moveGizmoHud.textContent = `${baseLabel}${suffix}`;
      moveGizmoHud.dataset.kind = focus.kind;
      moveGizmoHud.dataset.axis = focus.kind === 'center' ? 'free' : focus.axis;
      moveGizmoHud.style.setProperty(
        '--gizmo-axis-color',
        `#${axisColor.toString(16).padStart(6, '0')}`
      );
      moveGizmoHud.classList.toggle('is-active', active);
      hud.showAtPointer(moveGizmoHud, event, 16, -16);
    }

    function clearMoveGizmoHover() {
      updateMoveGizmoFocus(null);
      moveGizmoHud.hidden = true;
      moveGizmoHud.classList.remove('is-active');
    }

    /** In-plane basis for a rotation ring about `axis`. */
    function ringBasis(axis: MoveAxis): { u: THREE.Vector3; v: THREE.Vector3 } {
      const normal = MOVE_AXIS_VECTORS[axis];
      const seed =
        axis === 'x' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const u = seed
        .clone()
        .sub(normal.clone().multiplyScalar(seed.dot(normal)))
        .normalize();
      const v = new THREE.Vector3().crossVectors(normal, u);
      return { u, v };
    }

    function ringAngleAt(
      pivot: THREE.Vector3,
      axis: MoveAxis,
      u: THREE.Vector3,
      v: THREE.Vector3
    ): number | null {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        MOVE_AXIS_VECTORS[axis],
        pivot
      );
      const point = new THREE.Vector3();
      if (!context.raycaster.ray.intersectPlane(plane, point)) {
        return null;
      }
      const offset = point.sub(pivot);
      return Math.atan2(offset.dot(v), offset.dot(u));
    }

    let hoveredProfileId: string | null = null;
    function applyHover(result: PickCandidate | null) {
      selection.applyHover(result);
      const nextProfileId = result?.region?.profileId ?? null;
      if (nextProfileId !== hoveredProfileId) {
        hoveredProfileId = nextProfileId;
        onHoverRegionRef.current(result?.region ?? null);
      }
    }

    function applyHoverAt(event: PointerEvent) {
      const moveFocus = moveGizmoFocusFromHit(pickMoveGizmo(event));
      if (movePreviewRef.current && moveFocus) {
        updateMoveGizmoFocus(moveFocus);
        positionMoveGizmoHud(event, moveFocus);
        renderer.domElement.style.cursor = 'grab';
        return;
      }
      clearMoveGizmoHover();
      applyHover(pick(event));
    }

    /**
     * Projects a world direction at a world point into screen space: the unit
     * screen direction a drag should follow and how many pixels one world
     * unit spans. Falls back to screen-vertical when the direction is nearly
     * head-on (same recipe as the box face drag).
     */
    function screenDirectionFor(
      point: THREE.Vector3,
      direction: THREE.Vector3
    ): {
      directionX: number;
      directionY: number;
      pixelsPerUnit: number;
      fallbackPixelsPerUnit: number;
    } {
      const rect = renderer.domElement.getBoundingClientRect();
      const projectedStart = point.clone().project(context.activeCamera);
      const projectedEnd = point
        .clone()
        .add(direction)
        .project(context.activeCamera);
      const projectedX = ((projectedEnd.x - projectedStart.x) * rect.width) / 2;
      const projectedY =
        (-(projectedEnd.y - projectedStart.y) * rect.height) / 2;
      const projectedLength = Math.hypot(projectedX, projectedY);
      const distance = Math.max(camera.position.distanceTo(point), 1);
      const fallbackPixelsPerUnit =
        context.projection === 'orthographic'
          ? (rect.height * orthographic.zoom) /
            Math.max(orthographic.top - orthographic.bottom, 0.0001)
          : rect.height /
            (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance);
      const usable = projectedLength >= fallbackPixelsPerUnit * 0.15;
      return {
        directionX: usable ? projectedX / projectedLength : 0,
        directionY: usable ? projectedY / projectedLength : -1,
        // A foreshortened direction must not make tiny pixel motions huge
        // values: never drop below 60% of the head-on scale.
        pixelsPerUnit: Math.max(
          usable ? projectedLength : fallbackPixelsPerUnit,
          fallbackPixelsPerUnit * 0.6,
          0.1
        ),
        fallbackPixelsPerUnit
      };
    }

    function updateOffsetChip() {
      const chip = offsetChipRef.current;
      if (!chip) {
        return;
      }
      // Either rig answers the same two questions; only the label differs.
      const rig =
        cylinderRadiusRigRef.current ??
        offsetRigRef.current ??
        edgeRigRef.current;
      let anchor: THREE.Vector3 | null = null;
      let text = '';
      if (rig) {
        const scale =
          (rig.group.userData.gizmoScale as number | undefined) ?? 1;
        anchor = rig.chipAnchor(scale);
        const rawValue = rig.value();
        const value = Math.round(rawValue * 100) / 100;
        if (rig.kind === 'cylinder-radius') {
          text = `R ${formatNumber(rawValue)} ${unitsRef.current}`;
        } else if (rig.kind === 'edge-radius') {
          const prefix = edgeHandleOpRef.current === 'fillet' ? 'R' : 'C';
          text = `${prefix} ${value} ${unitsRef.current}`;
        } else {
          text = `${value >= 0 ? '+' : ''}${value} ${unitsRef.current}`;
        }
      }
      if (!anchor) {
        chip.hidden = true;
        radiusLabelChip.hidden = true;
        keypadAnchorRef.current?.(null);
        if (e2eCanvasHooksEnabled) {
          delete renderer.domElement.dataset.e2eHandleX;
          delete renderer.domElement.dataset.e2eHandleY;
          delete renderer.domElement.dataset.e2eHandleDx;
          delete renderer.domElement.dataset.e2eHandleDy;
          delete renderer.domElement.dataset.e2eHandlePixelsPerUnit;
        }
        return;
      }
      const screen = projectToScreen(
        anchor,
        context.activeCamera,
        renderer.domElement.clientWidth,
        renderer.domElement.clientHeight
      );
      if (!screen) {
        chip.hidden = true;
        radiusLabelChip.hidden = true;
        keypadAnchorRef.current?.(null);
        return;
      }
      if (e2eCanvasHooksEnabled && rig?.kind === 'cylinder-radius') {
        const scale =
          (rig.group.userData.gizmoScale as number | undefined) ?? 1;
        const hitCenter = rig.group.position
          .clone()
          .addScaledVector(rig.direction, 0.7 * scale);
        const hitScreen = projectToScreen(
          hitCenter,
          context.activeCamera,
          renderer.domElement.clientWidth,
          renderer.domElement.clientHeight
        );
        const dragDirection = screenDirectionFor(
          rig.group.position,
          rig.direction
        );
        if (hitScreen) {
          renderer.domElement.dataset.e2eHandleX = String(hitScreen.x);
          renderer.domElement.dataset.e2eHandleY = String(hitScreen.y);
          renderer.domElement.dataset.e2eHandleDx = String(
            dragDirection.directionX
          );
          renderer.domElement.dataset.e2eHandleDy = String(
            dragDirection.directionY
          );
          renderer.domElement.dataset.e2eHandlePixelsPerUnit = String(
            dragDirection.pixelsPerUnit
          );
        }
      }
      if (rig?.kind === 'cylinder-radius') {
        // Drawing-annotation typography: the units render small after the
        // number, so the chip reads "R 35ₘₘ" rather than uniform text.
        const units = document.createElement('small');
        units.textContent = unitsRef.current;
        chip.replaceChildren(`R ${formatNumber(rig.value())}\u00a0`, units);
      } else {
        chip.textContent = text;
      }
      chip.dataset.variant =
        rig?.kind === 'cylinder-radius' ? 'dimension' : 'default';
      hud.showAt(chip, screen.x, screen.y);
      if (rig?.kind === 'cylinder-radius') {
        // Same anchor; CSS shifts it to sit flush against the value pill.
        hud.showAt(radiusLabelChip, screen.x, screen.y);
      } else {
        radiusLabelChip.hidden = true;
      }
      keypadAnchorRef.current?.(screen);
    }

    function positionDragHud(
      event: PointerEvent,
      value: number,
      axis: DirectEditAxis
    ) {
      const label = axis === 'x' ? 'Width' : axis === 'y' ? 'Height' : 'Depth';
      dragHud.textContent = `${label} ${Math.round(value * 100) / 100} ${unitsRef.current}`;
      hud.showAtPointer(dragHud, event, 14, -36);
    }

    function restoreFaceDrag() {
      if (!faceDrag) {
        return;
      }
      faceDrag.object.position.copy(faceDrag.initialPosition);
      faceDrag.object.scale.copy(faceDrag.initialScale);
      gestures.release(faceDrag.pointerId, 'grab');
      dragHud.hidden = true;
    }

    function positionExtrudeHud(event: PointerEvent, distance: number) {
      const side = distance < 0 ? 'opposite side' : 'positive side';
      dragHud.textContent = `Extrude ${distance > 0 ? '+' : ''}${Math.round(distance * 10) / 10} ${unitsRef.current} · ${side}`;
      hud.showAtPointer(dragHud, event, 14, -36);
    }

    function restoreExtrudeDrag() {
      if (!extrudeDrag) {
        return;
      }
      gestures.release(extrudeDrag.pointerId, 'grab');
      dragHud.hidden = true;
    }

    /** Sketch-local point under the cursor: entity snap, then grid snap. */
    function sketchPointAt(event: PointerEvent): SketchPoint | null {
      const mode = sketchModeRef.current;
      if (!mode) {
        return null;
      }
      setRayFromEvent(event);
      const point = screenRayToPlanePoint(
        context.raycaster.ray.origin,
        context.raycaster.ray.direction,
        mode.basis
      );
      if (!point) {
        return null;
      }
      latestSketchPointerEvent = event;
      if (event.shiftKey) {
        activeSketchSnap = null;
        sketchSnapCycle = 0;
        hideSketchSnapMarker();
        latestSketchPoint = point;
        return point;
      }
      if (mode.geometrySnapEnabled) {
        const resolved = resolveSketchSnap(
          point,
          snapTargetsRef.current,
          mode.snapTolerancePx * sketchWorldPerPixel(mode.basis.origin),
          {
            lockedId: activeSketchSnap?.id,
            cycle: sketchSnapCycle
          }
        );
        if (resolved) {
          activeSketchSnap = resolved.target;
          positionSketchSnapMarker(event, resolved.target.kind);
          latestSketchPoint = {
            x: resolved.target.x,
            y: resolved.target.y
          };
          return latestSketchPoint;
        }
      }
      activeSketchSnap = null;
      sketchSnapCycle = 0;
      hideSketchSnapMarker();
      if (mode.snapStep) {
        const snapped = snapSketchPoint(point, mode.snapStep);
        positionSketchSnapMarker(event, 'grid');
        latestSketchPoint = snapped;
        return snapped;
      }
      latestSketchPoint = point;
      return point;
    }

    /** Approximate world units per CSS pixel at the sketch plane. */
    function sketchWorldPerPixel(origin: {
      x: number;
      y: number;
      z: number;
    }): number {
      const rect = renderer.domElement.getBoundingClientRect();
      const height = Math.max(rect.height, 1);
      const camera = context.activeCamera;
      if (camera instanceof THREE.OrthographicCamera) {
        return Math.max(
          (camera.top - camera.bottom) / camera.zoom / height,
          1e-6
        );
      }
      const perspective = camera as THREE.PerspectiveCamera;
      const distance = context.camera.position.distanceTo(
        new THREE.Vector3(origin.x, origin.y, origin.z)
      );
      return (
        (2 *
          distance *
          Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2))) /
        height
      );
    }

    function positionSketchSnapMarker(
      event: PointerEvent,
      kind: SnapTargetKind
    ) {
      sketchSnapMarker.dataset.kind = kind;
      if (kind === 'grid') {
        delete sketchSnapMarker.dataset.label;
      } else {
        sketchSnapMarker.dataset.label = SKETCH_SNAP_LABELS[kind];
      }
      sketchSnapMarker.textContent = SKETCH_SNAP_GLYPHS[kind];
      sketchSnapMarker.title = SKETCH_SNAP_LABELS[kind];
      hud.showAtPointer(sketchSnapMarker, event);
    }

    function hideSketchSnapMarker() {
      const marker = sketchSnapMarkerRef.current;
      if (marker) {
        marker.hidden = true;
      }
    }

    function positionSketchCenterTarget(target: SnapTarget, engaged: boolean) {
      const mode = sketchModeRef.current;
      if (!mode) {
        sketchCenterTarget.hidden = true;
        return;
      }
      const basis = mode.basis;
      const world = new THREE.Vector3(
        basis.origin.x + basis.u.x * target.x + basis.v.x * target.y,
        basis.origin.y + basis.u.y * target.x + basis.v.y * target.y,
        basis.origin.z + basis.u.z * target.x + basis.v.z * target.y
      );
      const screen = projectToScreen(
        world,
        context.activeCamera,
        renderer.domElement.clientWidth,
        renderer.domElement.clientHeight
      );
      if (!screen) {
        sketchCenterTarget.hidden = true;
        return;
      }
      sketchCenterTarget.dataset.engaged = String(engaged);
      hud.showAt(sketchCenterTarget, screen.x, screen.y);
    }

    function positionSketchDimLabel(
      event: PointerEvent,
      text: string,
      appendUnits = true
    ) {
      if (sketchNumericRaw !== null) {
        renderSketchNumericHud(event);
        return;
      }
      sketchDimLabel.textContent = appendUnits
        ? `${text} ${unitsRef.current}`
        : text;
      hud.showAtPointer(sketchDimLabel, event, 16, -28);
    }

    function hideSketchDimLabel() {
      const label = sketchDimLabelRef.current;
      if (label) {
        label.hidden = true;
      }
    }

    function renderSketchNumericHud(event: PointerEvent) {
      const label =
        sketchNumericKind === 'radius'
          ? 'Radius'
          : sketchNumericKind === 'diameter'
            ? 'Diameter'
            : 'Length';
      sketchDimLabel.textContent = `${label}: ${sketchNumericRaw || '…'} ${unitsRef.current} · Enter`;
      sketchDimLabel.dataset.editing = 'true';
      hud.showAtPointer(sketchDimLabel, event, 16, -28);
    }

    function finishSketchNumericEntry() {
      sketchNumericRaw = null;
      sketchDimLabel.dataset.editing = 'false';
      hideSketchDimLabel();
    }

    function commitSketchNumericEntry(): boolean {
      const mode = sketchModeRef.current;
      const gesture = sketchGestureRef.current;
      const value = Number(sketchNumericRaw);
      if (!mode || !Number.isFinite(value) || value <= 0) {
        return false;
      }
      if (
        mode.tool === 'circle' &&
        mode.circleMode !== 'three-point' &&
        gesture.dragStart
      ) {
        const radius = sketchNumericKind === 'diameter' ? value / 2 : value;
        const circle: SketchObjectData | null =
          mode.circleMode === 'center-radius'
            ? {
                objectKind: 'circle',
                centerX: gesture.dragStart.x,
                centerY: gesture.dragStart.y,
                radius
              }
            : (() => {
                const direction = latestSketchPoint ?? {
                  x: gesture.dragStart.x + 1,
                  y: gesture.dragStart.y
                };
                const diameter = radius * 2;
                const second = pointAtDistanceAlongDirection(
                  gesture.dragStart,
                  direction,
                  diameter
                );
                return {
                  objectKind: 'circle',
                  centerX: (gesture.dragStart.x + second.x) / 2,
                  centerY: (gesture.dragStart.y + second.y) / 2,
                  radius
                };
              })();
        if (!circle) {
          return false;
        }
        onSketchCommitRef.current(circle);
        gesture.dragStart = null;
        gesture.awaitingSecondPoint = false;
        sketchRigRef.current?.setInProgress(null, false);
        onSketchDrawingChangeRef.current(false);
        finishSketchNumericEntry();
        requestRender();
        return true;
      }
      if (mode.tool === 'line' && gesture.chainAnchor) {
        const end = pointAtDistanceAlongDirection(
          gesture.chainAnchor,
          latestSketchPoint ?? gesture.chainAnchor,
          value
        );
        const line = lineObjectFromPoints(gesture.chainAnchor, end);
        if (!line) {
          return false;
        }
        onSketchCommitRef.current(line);
        gesture.chainAnchor = end;
        finishSketchNumericEntry();
        requestRender();
        return true;
      }
      return false;
    }

    function handleSketchNumericKey(event: KeyboardEvent): boolean {
      const mode = sketchModeRef.current;
      const gesture = sketchGestureRef.current;
      const supported =
        mode &&
        ((mode.tool === 'circle' &&
          mode.circleMode !== 'three-point' &&
          gesture.dragStart !== null) ||
          (mode.tool === 'line' && gesture.chainAnchor !== null));
      if (!supported) {
        return false;
      }
      if (event.key === 'Escape' && sketchNumericRaw !== null) {
        finishSketchNumericEntry();
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      if (event.key === 'Tab' && sketchNumericRaw !== null) {
        if (mode.tool === 'circle') {
          const numeric = Number(sketchNumericRaw);
          sketchNumericKind =
            sketchNumericKind === 'radius' ? 'diameter' : 'radius';
          if (Number.isFinite(numeric)) {
            sketchNumericRaw = String(
              sketchNumericKind === 'diameter' ? numeric * 2 : numeric / 2
            );
          }
          if (latestSketchPointerEvent) {
            renderSketchNumericHud(latestSketchPointerEvent);
          }
        }
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      if (event.key === 'Enter' && sketchNumericRaw !== null) {
        if (!commitSketchNumericEntry() && latestSketchPointerEvent) {
          sketchDimLabel.textContent = 'Enter a positive exact value';
          hud.showAtPointer(sketchDimLabel, latestSketchPointerEvent, 16, -28);
        }
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      if (event.key === 'Backspace' && sketchNumericRaw !== null) {
        sketchNumericRaw = sketchNumericRaw.slice(0, -1);
      } else if (/^[0-9.]$/.test(event.key)) {
        if (sketchNumericRaw === null) {
          sketchNumericKind =
            mode.tool === 'circle'
              ? mode.circleMode === 'two-point-diameter'
                ? 'diameter'
                : 'radius'
              : 'length';
          sketchNumericRaw = '';
        }
        if (event.key !== '.' || !sketchNumericRaw.includes('.')) {
          sketchNumericRaw += event.key;
        }
      } else {
        return false;
      }
      if (latestSketchPointerEvent) {
        renderSketchNumericHud(latestSketchPointerEvent);
      }
      event.preventDefault();
      event.stopPropagation();
      return true;
    }

    function updateSketchInProgress(event: PointerEvent) {
      const mode = sketchModeRef.current;
      const rig = sketchRigRef.current;
      const gesture = sketchGestureRef.current;
      if (!mode || !rig) {
        return;
      }
      const point = sketchPointAt(event);
      if (!point) {
        return;
      }
      rig.setInference(null);
      sketchCenterTarget.hidden = true;
      if (mode.tool !== 'select' && mode.inferenceEnabled && !event.shiftKey) {
        const worldPerPixel = sketchWorldPerPixel(mode.basis.origin);
        const discoveryRadiusPx = Math.max(mode.snapTolerancePx * 6, 48);
        const centerTarget = nearestCenterGuideTarget(
          point,
          snapTargetsRef.current,
          discoveryRadiusPx * worldPerPixel
        );
        if (centerTarget) {
          const halfSpan =
            worldPerPixel *
            Math.max(
              renderer.domElement.clientWidth,
              renderer.domElement.clientHeight
            ) *
            0.65;
          rig.setInference(centerInferenceSegments(centerTarget, halfSpan));
          positionSketchCenterTarget(
            centerTarget,
            activeSketchSnap?.id === centerTarget.id
          );
        }
      }
      if (
        mode.tool === 'circle' &&
        mode.circleMode === 'three-point' &&
        gesture.circleFirst
      ) {
        if (!gesture.circleSecond) {
          rig.setInProgress([gesture.circleFirst, point], false);
          positionSketchDimLabel(event, 'Point 2 of 3', false);
        } else {
          const circle = circleObjectFromThreePoints(
            gesture.circleFirst,
            gesture.circleSecond,
            point
          );
          if (circle && circle.objectKind === 'circle') {
            rig.setInProgress(circlePreviewPoints(circle), true);
            positionSketchDimLabel(
              event,
              `R ${Math.round(Number(circle.radius) * 1000) / 1000} ${unitsRef.current} · ⌀ ${Math.round(Number(circle.radius) * 2000) / 1000} ${unitsRef.current}`,
              false
            );
          } else {
            rig.setInProgress(
              [gesture.circleFirst, gesture.circleSecond, point],
              false
            );
            positionSketchDimLabel(
              event,
              'Points cannot define a stable circle',
              false
            );
          }
        }
        requestRender();
        return;
      }
      if (
        gesture.dragStart &&
        (mode.tool === 'circle' || mode.tool === 'rectangle')
      ) {
        if (mode.tool === 'circle') {
          const circle =
            mode.circleMode === 'two-point-diameter'
              ? circleObjectFromDiameter(gesture.dragStart, point)
              : sketchObjectFromDrag('circle', gesture.dragStart, point);
          if (circle && circle.objectKind === 'circle') {
            rig.setInProgress(circlePreviewPoints(circle), true);
          }
        } else {
          rig.setInProgress(
            [
              gesture.dragStart,
              { x: point.x, y: gesture.dragStart.y },
              point,
              { x: gesture.dragStart.x, y: point.y }
            ],
            true
          );
        }
        if (mode.tool === 'circle') {
          const distance = Math.hypot(
            point.x - gesture.dragStart.x,
            point.y - gesture.dragStart.y
          );
          const radius =
            mode.circleMode === 'two-point-diameter' ? distance / 2 : distance;
          positionSketchDimLabel(
            event,
            `R ${Math.round(radius * 1000) / 1000} ${unitsRef.current} · ⌀ ${Math.round(radius * 2000) / 1000} ${unitsRef.current}`,
            false
          );
        } else {
          positionSketchDimLabel(
            event,
            dimensionForInProgress(mode.tool, gesture.dragStart, point)
          );
        }
        requestRender();
        return;
      }
      if (mode.tool === 'line' && gesture.chainAnchor) {
        const locked =
          mode.inferenceEnabled && !event.shiftKey
            ? axisLockPoint(gesture.chainAnchor, point)
            : { point, lockedAxis: null };
        rig.setInProgress([gesture.chainAnchor, locked.point], false);
        if (locked.lockedAxis) {
          rig.setInference([[gesture.chainAnchor, locked.point]]);
          if (!activeSketchSnap) {
            positionSketchSnapMarker(event, locked.lockedAxis);
          }
        }
        positionSketchDimLabel(
          event,
          dimensionForInProgress('line', gesture.chainAnchor, locked.point)
        );
        requestRender();
        return;
      }
      if (mode.tool === 'arc' && gesture.arcCenter) {
        if (!gesture.arcStart) {
          rig.setInProgress([gesture.arcCenter, point], false);
          positionSketchDimLabel(
            event,
            `R ${
              Math.round(
                Math.hypot(
                  point.x - gesture.arcCenter.x,
                  point.y - gesture.arcCenter.y
                ) * 10
              ) / 10
            }`
          );
        } else {
          rig.setInProgress(
            arcPreviewPoints(gesture.arcCenter, gesture.arcStart, point),
            false
          );
          const dimension = arcDimension(
            gesture.arcCenter,
            gesture.arcStart,
            point
          );
          positionSketchDimLabel(
            event,
            `R ${Math.round(dimension.radius * 10) / 10} ${unitsRef.current} · ${Math.round(dimension.sweepDeg * 10) / 10}°`,
            false
          );
        }
        requestRender();
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (event.buttons !== 0) {
        pendingHoverEvent = null;
      }
      if (boxSelect && event.pointerId === boxSelect.pointerId) {
        drawSelectionBand(boxSelect.startX, boxSelect.startY, event);
        return;
      }
      if (sketchModeRef.current) {
        if (event.buttons === 0 || event.buttons === 1) {
          updateSketchInProgress(event);
        }
        if (event.buttons !== 2 && event.buttons !== 4) {
          if (event.buttons !== 0 || sketchModeRef.current.tool !== 'select') {
            return;
          }
        }
      }
      rightClickGesture.move(event.pointerId, event.clientX, event.clientY);
      if (moveDrag && event.pointerId === moveDrag.pointerId) {
        event.preventDefault();
        const drag = moveDrag;
        const fine = event.shiftKey;
        const translation = { ...drag.startTranslation };
        const rotation = { ...drag.startRotation };
        setRayFromEvent(event);
        if (drag.kind === 'axis') {
          const t = closestAxisT(
            context.raycaster.ray,
            drag.pivot,
            drag.axisDirection
          );
          if (t !== null) {
            translation[drag.axis] = snapTo(
              drag.startTranslation[drag.axis] + (t - drag.startT),
              drag.snapMove,
              fine
            );
            // Center alignment outranks the step grid on the driven axis: a
            // face's center is a place someone meant, a grid line is not.
            // Shift frees both together, as it already means.
            const aligned = fine
              ? null
              : alignTranslationToCenters(
                  drag.restingCenter,
                  {
                    ...translation,
                    [drag.axis]:
                      drag.startTranslation[drag.axis] + (t - drag.startT)
                  },
                  moveCenterTargets,
                  [drag.axis],
                  drag.worldPerPixel * SNAP_RADIUS_PX
                );
            if (aligned && aligned.matches.length > 0) {
              translation[drag.axis] = aligned.translation[drag.axis];
              showCenterAlignGlyph(aligned.matches);
            } else {
              hud.hide(snapGlyph);
            }
          }
        } else if (drag.kind === 'ring') {
          const angle = ringAngleAt(
            drag.pivot,
            drag.axis,
            drag.ringU,
            drag.ringV
          );
          if (angle !== null) {
            let deltaDeg = THREE.MathUtils.radToDeg(angle - drag.startAngle);
            deltaDeg = ((deltaDeg + 540) % 360) - 180;
            rotation[drag.axis] = snapTo(
              drag.startRotation[drag.axis] + deltaDeg,
              drag.snapRotate,
              fine
            );
          }
        } else {
          const dx = event.clientX - drag.startX;
          const dy = event.clientY - drag.startY;
          const world = drag.cameraRight
            .clone()
            .multiplyScalar(dx * drag.worldPerPixel)
            .addScaledVector(drag.cameraUp, -dy * drag.worldPerPixel);
          // Geometry outranks the grid: a corner is a place someone meant,
          // and rounding it to the nearest whole step would land beside it.
          // Shift turns both off together, which is what it already means.
          const host = renderer.domElement;
          // Candidate projections are host-local pixels. Pointer events are
          // window-relative, so convert them before comparing distances; the
          // viewport normally sits below the top bar and beside the model tree.
          const pointer = hud.toLocal(event.clientX, event.clientY);
          const snapped =
            fine || !pointer
              ? null
              : resolveSnap(
                  moveSnaps,
                  pointer,
                  (point) =>
                    projectToScreen(
                      new THREE.Vector3(point.x, point.y, point.z),
                      context.activeCamera,
                      host.clientWidth,
                      host.clientHeight
                    ),
                  SNAP_RADIUS_PX
                );
          if (snapped) {
            // Land the handle itself on the point, so what the glyph marks is
            // exactly where the body ends up.
            const landed = translationToSnap(
              drag.startTranslation,
              drag.pivot,
              snapped.candidate.point
            );
            translation.x = landed.x;
            translation.y = landed.y;
            translation.z = landed.z;
            showSnapGlyph(snapped);
          } else {
            translation.x = snapTo(
              drag.startTranslation.x + world.x,
              drag.snapMove,
              fine
            );
            translation.y = snapTo(
              drag.startTranslation.y + world.y,
              drag.snapMove,
              fine
            );
            translation.z = snapTo(
              drag.startTranslation.z + world.z,
              drag.snapMove,
              fine
            );
            // No corner under the pointer: try lining centers up instead.
            // Raw (pre-grid) deltas feed the test so the grid cannot round
            // the drag out of the alignment window; each axis latches
            // independently, so centering on one axis or both just falls out.
            const aligned = fine
              ? null
              : alignTranslationToCenters(
                  drag.restingCenter,
                  {
                    x: drag.startTranslation.x + world.x,
                    y: drag.startTranslation.y + world.y,
                    z: drag.startTranslation.z + world.z
                  },
                  moveCenterTargets,
                  ['x', 'y', 'z'],
                  drag.worldPerPixel * SNAP_RADIUS_PX
                );
            if (aligned && aligned.matches.length > 0) {
              for (const match of aligned.matches) {
                translation[match.axis] = aligned.translation[match.axis];
              }
              showCenterAlignGlyph(aligned.matches);
            } else {
              hud.hide(snapGlyph);
            }
          }
        }
        context.applyMovePreview(translation, rotation);
        onMovePreviewChangeRef.current(translation, rotation, {
          move: drag.snapMove,
          rotate: drag.snapRotate
        });
        const focus = { kind: drag.kind, axis: drag.axis };
        const value =
          drag.kind === 'ring'
            ? rotation[drag.axis]
            : drag.kind === 'axis'
              ? translation[drag.axis]
              : undefined;
        updateMoveGizmoFocus(focus);
        positionMoveGizmoHud(event, focus, true, value);
        renderer.domElement.style.cursor = 'grabbing';
        requestRender();
        return;
      }
      if (edgeDrag && event.pointerId === edgeDrag.pointerId) {
        event.preventDefault();
        const rig = edgeRigRef.current;
        if (rig) {
          const dx = event.clientX - edgeDrag.startX;
          const dy = event.clientY - edgeDrag.startY;
          const projected = dx * edgeDrag.directionX + dy * edgeDrag.directionY;
          const raw = Math.max(
            0,
            edgeDrag.initialValue + projected / edgeDrag.pixelsPerUnit
          );
          // Blends want finer steps than moves; tenths feel right.
          const value = event.shiftKey
            ? Math.round(raw * 100) / 100
            : Math.round(raw * 10) / 10;
          if (value !== rig.value()) {
            rig.setValue(value);
            // Kernel previews are expensive; stream at a bounded cadence and
            // let App coalesce.
            const now = performance.now();
            if (now - edgeDrag.lastPreviewAt > 150 && value > 0) {
              edgeDrag.lastPreviewAt = now;
              onEdgeRadiusPreviewRef.current(value);
            }
            requestRender();
          }
          renderer.domElement.style.cursor = 'grabbing';
        }
        return;
      }
      if (
        cylinderRadiusDrag &&
        event.pointerId === cylinderRadiusDrag.pointerId
      ) {
        event.preventDefault();
        const rig = cylinderRadiusRigRef.current;
        if (rig) {
          const dx = event.clientX - cylinderRadiusDrag.startX;
          const dy = event.clientY - cylinderRadiusDrag.startY;
          const projected =
            dx * cylinderRadiusDrag.directionX +
            dy * cylinderRadiusDrag.directionY;
          const accumulatedDelta =
            cylinderRadiusDrag.initialRadius -
            cylinderRadiusDrag.originalRadius +
            projected / cylinderRadiusDrag.pixelsPerUnit;
          const raw = radiusFromRadialDelta(
            cylinderRadiusDrag.originalRadius,
            accumulatedDelta
          );
          if (raw === null) {
            renderer.domElement.style.cursor = 'grabbing';
            return;
          }
          const snap = cylinderRadiusSnapStep(
            1 / cylinderRadiusDrag.pixelsPerUnit
          );
          const snapped = event.shiftKey ? raw : Math.round(raw / snap) * snap;
          const value = radiusFromRadialDelta(
            cylinderRadiusDrag.originalRadius,
            snapped - cylinderRadiusDrag.originalRadius
          );
          if (value !== null && Math.abs(value - rig.value()) > 1e-9) {
            rig.setValue(value);
            onCylinderRadiusPreviewRef.current(value);
            requestRender();
          }
          renderer.domElement.style.cursor = 'grabbing';
        }
        return;
      }
      if (offsetDrag && event.pointerId === offsetDrag.pointerId) {
        event.preventDefault();
        const rig = offsetRigRef.current;
        if (rig) {
          const dx = event.clientX - offsetDrag.startX;
          const dy = event.clientY - offsetDrag.startY;
          const projected =
            dx * offsetDrag.directionX + dy * offsetDrag.directionY;
          const raw =
            offsetDrag.initialOffset + projected / offsetDrag.pixelsPerUnit;
          // Zoom-adaptive snapping, matching the move gizmo; Shift = free.
          const snap = chooseMoveSnapStep(1 / offsetDrag.pixelsPerUnit);
          const value = event.shiftKey
            ? Math.round(raw * 100) / 100
            : Math.round(raw / snap) * snap;
          rig.setValue(value);
          renderer.domElement.style.cursor = 'grabbing';
          requestRender();
        }
        return;
      }
      if (extrudeDrag && event.pointerId === extrudeDrag.pointerId) {
        event.preventDefault();
        const dx = event.clientX - extrudeDrag.startX;
        const dy = event.clientY - extrudeDrag.startY;
        const projected =
          dx * extrudeDrag.directionX + dy * extrudeDrag.directionY;
        const distance =
          Math.round(
            (extrudeDrag.initialDistance +
              projected / extrudeDrag.pixelsPerUnit) *
              2
          ) / 2;
        onExtrudeDistanceChangeRef.current(distance);
        renderer.domElement.style.cursor = 'grabbing';
        positionExtrudeHud(event, distance);
        return;
      }
      if (faceDrag && event.pointerId === faceDrag.pointerId) {
        event.preventDefault();
        const dx = event.clientX - faceDrag.startX;
        const dy = event.clientY - faceDrag.startY;
        const projected = dx * faceDrag.directionX + dy * faceDrag.directionY;
        const value =
          Math.round(
            Math.max(
              0.1,
              faceDrag.initialValue + projected / faceDrag.pixelsPerUnit
            ) * 10
          ) / 10;
        faceDrag.latestValue = value;
        const scale = value / faceDrag.initialValue;
        faceDrag.object.scale[faceDrag.axis] =
          faceDrag.initialScale[faceDrag.axis] * scale;
        faceDrag.object.position[faceDrag.axis] =
          faceDrag.initialPosition[faceDrag.axis] +
          (faceDrag.side * (value - faceDrag.initialValue)) / 2;
        renderer.domElement.style.cursor = 'grabbing';
        positionDragHud(event, value, faceDrag.axis);
        requestRender();
        return;
      }
      if (event.buttons !== 0) {
        return;
      }
      pendingHoverEvent = event;
      requestRender();
    };
    /**
     * Orbit turns about the geometry under the cursor at gesture start, so a
     * detail being pointed at stays put while the view swings around it.
     * `pivotOn` keeps the camera still, so nothing shifts on screen; over
     * empty space the current pivot is kept.
     */
    function pivotOrbitOnCursor(event: PointerEvent) {
      const result = pick(event);
      if (result) {
        cameraRig.pivotOn(result.hit.point);
      }
    }

    const handlePointerDown = (event: PointerEvent) => {
      pendingHoverEvent = null;
      cameraRig.cancelTween();
      if (event.button === 2) {
        rightClickGesture.begin(event.pointerId, event.clientX, event.clientY);
        if (event.ctrlKey || event.metaKey) {
          pivotOrbitOnCursor(event);
        }
        rightPanStartTarget = cameraRig.controls.target.clone();
        return;
      }
      if (event.button === 1 && middleDragRef.current === 'orbit') {
        pivotOrbitOnCursor(event);
        return;
      }
      if (event.button !== 0) {
        return;
      }
      gestures.begin(event);
      // The viewport owns unmodified drag for box selection. Shift hands the
      // same left-button gesture to OrbitControls, whose modifier swap is
      // armed so it rotates rather than pans. A stationary Shift+click still
      // falls through to additive selection on release.
      if (event.shiftKey && !sketchModeRef.current) {
        shiftOrbitPointerId = event.pointerId;
        cameraRig.setShiftOrbitActive(true);
        pivotOrbitOnCursor(event);
        return;
      }
      const moveHit = pickMoveGizmo(event);
      if (moveHit && movePreviewRef.current) {
        const activeMove = movePreviewRef.current;
        const data = moveHit.object.userData as {
          kind: MoveHandleKind;
          axis?: MoveAxis;
        };
        const axis = data.axis ?? 'x';
        // A sketch is not a body, so every body contributes snap points and
        // alignment centers when one is being moved.
        const movingBodyId =
          activeMove.target === 'sketch' ? null : activeMove.bodyId;
        moveSnaps = collectMoveSnaps(movingBodyId);
        moveCenterTargets = collectCenterAlignTargets(movingBodyId);
        const pivot = moveGizmoGroup.position.clone();
        const worldPerPixel = worldPerPixelAt(pivot);
        const gizmoScale =
          (moveGizmoGroup.userData.gizmoScale as number | undefined) ?? 10;
        const ringRadiusPx =
          (gizmoScale * 0.85) / Math.max(worldPerPixel, 1e-9);
        const drag: MoveDragState = {
          pointerId: event.pointerId,
          kind: data.kind,
          axis,
          pivot,
          axisDirection: MOVE_AXIS_VECTORS[axis],
          startT: 0,
          ringU: new THREE.Vector3(1, 0, 0),
          ringV: new THREE.Vector3(0, 1, 0),
          startAngle: 0,
          startX: event.clientX,
          startY: event.clientY,
          cameraRight: new THREE.Vector3()
            .setFromMatrixColumn(context.activeCamera.matrixWorld, 0)
            .normalize(),
          cameraUp: new THREE.Vector3()
            .setFromMatrixColumn(context.activeCamera.matrixWorld, 1)
            .normalize(),
          worldPerPixel,
          startTranslation: { ...activeMove.translation },
          startRotation: { ...activeMove.rotationDeg },
          restingCenter: moveCenterRef.current.clone(),
          snapMove: chooseMoveSnapStep(worldPerPixel),
          snapRotate: chooseRotateSnapStep((ringRadiusPx * Math.PI) / 180)
        };
        setRayFromEvent(event);
        if (data.kind === 'axis') {
          const t = closestAxisT(
            context.raycaster.ray,
            pivot,
            drag.axisDirection
          );
          if (t === null) {
            beginBoxSelect(event);
            return;
          }
          drag.startT = t;
        } else if (data.kind === 'ring') {
          const basis = ringBasis(axis);
          drag.ringU = basis.u;
          drag.ringV = basis.v;
          const angle = ringAngleAt(pivot, axis, basis.u, basis.v);
          if (angle === null) {
            beginBoxSelect(event);
            return;
          }
          drag.startAngle = angle;
        }
        moveDrag = drag;
        moveDragActiveRef.current = true;
        const focus = { kind: data.kind, axis };
        updateMoveGizmoFocus(focus);
        positionMoveGizmoHud(event, focus, true);
        gestures.capture(event);
        event.preventDefault();
        return;
      }
      if (sketchModeRef.current && event.button === 0) {
        const mode = sketchModeRef.current;
        const gesture = sketchGestureRef.current;
        const point = sketchPointAt(event);
        if (
          point &&
          (mode.tool === 'rectangle' ||
            (mode.tool === 'circle' && mode.circleMode !== 'three-point'))
        ) {
          if (!gesture.dragStart) {
            finishSketchNumericEntry();
            gesture.dragStart = point;
            gesture.awaitingSecondPoint = false;
          }
          gesture.pointerId = event.pointerId;
          gesture.moved = false;
          gestures.capture(event, null);
          onSketchDrawingChangeRef.current(true);
          event.preventDefault();
        } else if (
          point &&
          (mode.tool === 'line' ||
            mode.tool === 'arc' ||
            (mode.tool === 'circle' && mode.circleMode === 'three-point'))
        ) {
          gesture.pointerId = event.pointerId;
          gesture.moved = false;
          event.preventDefault();
        }
        gestures.begin(event);
        return;
      }
      const armedCylinderRig = cylinderRadiusRigRef.current;
      const cylinderTarget = cylinderRadiusHandleRef.current;
      if (armedCylinderRig && cylinderTarget) {
        setRayFromEvent(event);
        const handleHits = context.raycaster
          .intersectObjects(armedCylinderRig.group.children, true)
          .filter((hit) => hit.object.userData.directHandle === true);
        if (handleHits.length > 0) {
          const screen = screenDirectionFor(
            armedCylinderRig.group.position,
            armedCylinderRig.direction
          );
          cylinderRadiusDrag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            directionX: screen.directionX,
            directionY: screen.directionY,
            pixelsPerUnit: screen.pixelsPerUnit,
            bodyId: cylinderTarget.bodyId,
            topologyId: cylinderTarget.topologyId,
            axisStart: new THREE.Vector3(
              cylinderTarget.axisStart.x,
              cylinderTarget.axisStart.y,
              cylinderTarget.axisStart.z
            ),
            axisEnd: new THREE.Vector3(
              cylinderTarget.axisEnd.x,
              cylinderTarget.axisEnd.y,
              cylinderTarget.axisEnd.z
            ),
            initialHitPoint: new THREE.Vector3(
              cylinderTarget.point.x,
              cylinderTarget.point.y,
              cylinderTarget.point.z
            ),
            radialDirection: new THREE.Vector3(
              cylinderTarget.radialDirection.x,
              cylinderTarget.radialDirection.y,
              cylinderTarget.radialDirection.z
            ),
            originalRadius: cylinderTarget.originalRadius,
            initialRadius: armedCylinderRig.value()
          };
          cylinderRadiusDragActiveRef.current = true;
          onDirectManipulationChangeRef.current(true);
          gestures.capture(event);
          event.preventDefault();
          return;
        }
      }
      const armedRig = offsetRigRef.current;
      if (armedRig) {
        setRayFromEvent(event);
        const handleHits = context.raycaster
          .intersectObjects(armedRig.group.children, true)
          .filter((hit) => hit.object.userData.directHandle === true);
        if (handleHits.length > 0) {
          const screen = screenDirectionFor(
            armedRig.origin
              .clone()
              .addScaledVector(armedRig.direction, armedRig.value()),
            armedRig.direction
          );
          offsetDrag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            directionX: screen.directionX,
            directionY: screen.directionY,
            pixelsPerUnit: screen.pixelsPerUnit,
            initialOffset: armedRig.value()
          };
          offsetDragActiveRef.current = true;
          onDirectManipulationChangeRef.current(true);
          gestures.capture(event);
          event.preventDefault();
          return;
        }
      }
      const armedEdgeRig = edgeRigRef.current;
      if (armedEdgeRig) {
        setRayFromEvent(event);
        const edgeHits = context.raycaster
          .intersectObjects(armedEdgeRig.group.children, true)
          .filter((hit) => hit.object.userData.directHandle === true);
        if (edgeHits.length > 0) {
          const screen = screenDirectionFor(
            armedEdgeRig.origin,
            armedEdgeRig.direction
          );
          edgeDrag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            directionX: screen.directionX,
            directionY: screen.directionY,
            // The radial direction only signs the drag; the head-on scale
            // keeps radius sensitivity predictable at every view angle.
            pixelsPerUnit: screen.fallbackPixelsPerUnit,
            initialValue: armedEdgeRig.value(),
            lastPreviewAt: 0
          };
          edgeDragActiveRef.current = true;
          onDirectManipulationChangeRef.current(true);
          gestures.capture(event);
          event.preventDefault();
          return;
        }
      }
      const activeExtrude = extrudePreviewRef.current;
      const extrudeGizmoHit = activeExtrude ? pickExtrudeGizmo(event) : null;
      if (activeExtrude && extrudeGizmoHit) {
        const sketch = sketchesRef.current.find(
          (candidate) => candidate.sketchId === activeExtrude.sketchId
        );
        const storedOrigin = extrudeGizmoHit.object.userData.extrudeOrigin as
          number[] | undefined;
        const storedNormal = extrudeGizmoHit.object.userData.extrudeNormal as
          number[] | undefined;
        if (
          sketch ||
          (storedOrigin?.length === 3 && storedNormal?.length === 3)
        ) {
          const rect = renderer.domElement.getBoundingClientRect();
          const centroid =
            storedOrigin?.length === 3
              ? new THREE.Vector3(
                  storedOrigin[0],
                  storedOrigin[1],
                  storedOrigin[2]
                )
              : sketchCentroid(sketch!);
          const normal =
            storedNormal?.length === 3
              ? new THREE.Vector3(
                  storedNormal[0],
                  storedNormal[1],
                  storedNormal[2]
                ).normalize()
              : new THREE.Vector3(
                  sketch!.normal.x,
                  sketch!.normal.y,
                  sketch!.normal.z
                ).normalize();
          const projectedStart = centroid.clone().project(camera);
          const projectedEnd = centroid.clone().add(normal).project(camera);
          const projectedX =
            ((projectedEnd.x - projectedStart.x) * rect.width) / 2;
          const projectedY =
            (-(projectedEnd.y - projectedStart.y) * rect.height) / 2;
          const projectedLength = Math.hypot(projectedX, projectedY);
          const fallback = Math.max(rect.height / 120, 1);
          extrudeDrag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            initialDistance: activeExtrude.distance,
            directionX:
              projectedLength > 0.1 ? projectedX / projectedLength : 0,
            directionY:
              projectedLength > 0.1 ? projectedY / projectedLength : -1,
            pixelsPerUnit: Math.max(projectedLength, fallback)
          };
          gestures.capture(event);
          positionExtrudeHud(event, activeExtrude.distance);
          event.preventDefault();
          return;
        }
      }
      // While any direct-manipulation handle is armed, the handles own
      // dragging — the legacy box resize would fight the gesture.
      if (
        cylinderRadiusRigRef.current ||
        offsetRigRef.current ||
        edgeRigRef.current
      ) {
        beginBoxSelect(event);
        return;
      }
      const result = pick(event);
      if (
        !result?.faceNormal ||
        result.selection?.kind !== 'face' ||
        !editableBodyIdsRef.current.has(result.selection.bodyId)
      ) {
        beginBoxSelect(event);
        return;
      }
      const object = context.objectsByBodyId.get(result.selection.bodyId);
      if (!object) {
        beginBoxSelect(event);
        return;
      }
      const direction = directEditDirectionFromNormal(result.faceNormal);
      const size = new THREE.Box3()
        .setFromObject(object)
        .getSize(new THREE.Vector3());
      const initialValue = size[direction.axis];
      if (!Number.isFinite(initialValue) || initialValue <= 0) {
        beginBoxSelect(event);
        return;
      }

      const rect = renderer.domElement.getBoundingClientRect();
      const projectedStart = result.hit.point
        .clone()
        .project(context.activeCamera);
      const projectedEnd = result.hit.point
        .clone()
        .add(result.faceNormal)
        .project(context.activeCamera);
      const projectedX = ((projectedEnd.x - projectedStart.x) * rect.width) / 2;
      const projectedY =
        (-(projectedEnd.y - projectedStart.y) * rect.height) / 2;
      const projectedLength = Math.hypot(projectedX, projectedY);
      const distance = Math.max(
        camera.position.distanceTo(result.hit.point),
        1
      );
      const fallbackPixelsPerUnit =
        context.projection === 'orthographic'
          ? (rect.height * orthographic.zoom) /
            Math.max(orthographic.top - orthographic.bottom, 0.0001)
          : rect.height /
            (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance);
      const useProjectedDirection =
        projectedLength >= fallbackPixelsPerUnit * 0.15;

      faceDrag = {
        pointerId: event.pointerId,
        selection: result.selection,
        detail: {
          point: {
            x: result.hit.point.x,
            y: result.hit.point.y,
            z: result.hit.point.z
          },
          normal: result.faceNormal
            ? {
                x: result.faceNormal.x,
                y: result.faceNormal.y,
                z: result.faceNormal.z
              }
            : undefined
        },
        object,
        axis: direction.axis,
        side: direction.side,
        initialValue,
        latestValue: initialValue,
        startX: event.clientX,
        startY: event.clientY,
        directionX: useProjectedDirection ? projectedX / projectedLength : 0,
        directionY: useProjectedDirection ? projectedY / projectedLength : -1,
        pixelsPerUnit: Math.max(
          useProjectedDirection ? projectedLength : fallbackPixelsPerUnit,
          0.1
        ),
        initialPosition: object.position.clone(),
        initialScale: object.scale.clone()
      };
      gestures.capture(event, null);
      positionDragHud(event, initialValue, direction.axis);
      event.preventDefault();
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId === shiftOrbitPointerId) {
        shiftOrbitPointerId = null;
        cameraRig.setShiftOrbitActive(false);
      }
      if (boxSelect && event.pointerId === boxSelect.pointerId) {
        const started = boxSelect;
        boxSelect = null;
        hud.hide(selectionBand);
        gestures.release(event, null);
        const from = hud.toLocal(started.startX, started.startY);
        const to = hud.toLocal(event.clientX, event.clientY);
        const rect =
          from && to ? rectFromDrag(from.x, from.y, to.x, to.y) : null;
        if (!rect || !isBoxSelectDrag(rect)) {
          // A press that never travelled is still an ordinary selection click.
          selectAtPointer(event);
          return;
        }
        depthCycle = null;
        const host = renderer.domElement;
        onBoxSelectRef.current(
          bodiesInBox(
            bodiesRef.current
              .filter((body) => !body.consumed)
              .map((body) => ({
                bodyId: body.bodyId,
                // Kernel meshes are already world-space, so no placement is
                // applied here either — see createObjectForBody.
                positions: body.mesh.vertices,
                indices: body.mesh.indices
              })),
            rect,
            boxSelectMode(started.startX, event.clientX),
            {
              camera: cameraRig.activeCamera,
              width: host.clientWidth,
              height: host.clientHeight
            }
          )
        );
        return;
      }
      if (event.button === 2) {
        const panStartTarget = rightPanStartTarget;
        rightPanStartTarget = null;
        if (
          panStartTarget &&
          cameraRig.controls.target.distanceToSquared(panStartTarget) >
            RIGHT_PAN_TARGET_EPSILON * RIGHT_PAN_TARGET_EPSILON
        ) {
          // OrbitControls changed the camera target, so this gesture panned
          // even if this element missed or coalesced its pointermove events.
          rightClickGesture.markDragged(event.pointerId);
        }
        if (
          rightClickGesture.end(event.pointerId, event.clientX, event.clientY)
        ) {
          onContextMenuRef.current(
            event.clientX,
            event.clientY,
            pick(event)?.selection ?? null
          );
        }
        return;
      }
      if (moveDrag && event.pointerId === moveDrag.pointerId) {
        moveDrag = null;
        moveSnaps = [];
        hud.hide(snapGlyph);
        moveDragActiveRef.current = false;
        gestures.release(event, null);
        const moveFocus = moveGizmoFocusFromHit(pickMoveGizmo(event));
        updateMoveGizmoFocus(moveFocus);
        if (moveFocus) {
          positionMoveGizmoHud(event, moveFocus);
          renderer.domElement.style.cursor = 'grab';
        } else {
          moveGizmoHud.hidden = true;
          renderer.domElement.style.cursor = '';
        }
        return;
      }
      if (sketchModeRef.current && event.button === 0) {
        const mode = sketchModeRef.current;
        const rig = sketchRigRef.current;
        const gesture = sketchGestureRef.current;
        const point = sketchPointAt(event);
        const moved = gestures.hasMoved(event);
        gestures.release(event, null);
        if (mode.tool === 'select' && !moved) {
          setRayFromEvent(event);
          const pickThreshold =
            worldPerPixelAt(
              new THREE.Vector3(
                mode.basis.origin.x,
                mode.basis.origin.y,
                mode.basis.origin.z
              )
            ) * 8;
          const objectId =
            rig?.pickObject(context.raycaster, pickThreshold) ?? null;
          onSketchSelectObjectRef.current(objectId);
          if (!objectId) {
            const profile = picker.pick(event)?.region;
            if (profile) {
              onSelectRegionRef.current(profile, {
                additive: event.shiftKey,
                toggle: event.ctrlKey || event.metaKey
              });
            }
          }
          requestRender();
          return;
        }
        if (gesture.dragStart) {
          gestures.release(event, null);
          if (!moved && !gesture.awaitingSecondPoint) {
            gesture.awaitingSecondPoint = true;
            onSketchDrawingChangeRef.current(true);
            requestRender();
            return;
          }
          if (point && (mode.tool === 'circle' || mode.tool === 'rectangle')) {
            const object =
              mode.tool === 'circle' && mode.circleMode === 'two-point-diameter'
                ? circleObjectFromDiameter(gesture.dragStart, point)
                : sketchObjectFromDrag(mode.tool, gesture.dragStart, point);
            if (object) {
              onSketchCommitRef.current(object);
            }
          }
          gesture.dragStart = null;
          gesture.awaitingSecondPoint = false;
          rig?.setInProgress(null, false);
          finishSketchNumericEntry();
          onSketchDrawingChangeRef.current(false);
          requestRender();
          return;
        }
        if (
          mode.tool === 'circle' &&
          mode.circleMode === 'three-point' &&
          point &&
          !moved
        ) {
          if (!gesture.circleFirst) {
            gesture.circleFirst = point;
            onSketchDrawingChangeRef.current(true);
          } else if (!gesture.circleSecond) {
            if (
              Math.hypot(
                point.x - gesture.circleFirst.x,
                point.y - gesture.circleFirst.y
              ) >= 0.5
            ) {
              gesture.circleSecond = point;
            }
          } else {
            const circle = circleObjectFromThreePoints(
              gesture.circleFirst,
              gesture.circleSecond,
              point
            );
            if (circle) {
              onSketchCommitRef.current(circle);
              gesture.circleFirst = null;
              gesture.circleSecond = null;
              rig?.setInProgress(null, false);
              hideSketchDimLabel();
              onSketchDrawingChangeRef.current(false);
            } else {
              positionSketchDimLabel(
                event,
                'Points cannot define a stable circle',
                false
              );
            }
          }
          requestRender();
          return;
        }
        if (mode.tool === 'text' && point && !moved) {
          // One click places the baseline origin; everything else about a text
          // object is a parameter, so there is no drag and no second click.
          onSketchCommitRef.current(textObjectFromPoint(point));
          requestRender();
          return;
        }
        if (mode.tool === 'line' && point && !moved) {
          if (!gesture.chainAnchor) {
            finishSketchNumericEntry();
            gesture.chainAnchor = point;
            onSketchDrawingChangeRef.current(true);
          } else {
            const locked =
              mode.inferenceEnabled && !event.shiftKey
                ? axisLockPoint(gesture.chainAnchor, point)
                : { point, lockedAxis: null };
            const object = lineObjectFromPoints(
              gesture.chainAnchor,
              locked.point
            );
            if (object) {
              onSketchCommitRef.current(object);
              gesture.chainAnchor = locked.point;
            }
          }
          requestRender();
        }
        if (mode.tool === 'arc' && point && !moved) {
          if (!gesture.arcCenter) {
            gesture.arcCenter = point;
            onSketchDrawingChangeRef.current(true);
          } else if (!gesture.arcStart) {
            if (
              Math.hypot(
                point.x - gesture.arcCenter.x,
                point.y - gesture.arcCenter.y
              ) >= 0.5
            ) {
              gesture.arcStart = point;
            }
          } else {
            const object = arcObjectFromPoints(
              gesture.arcCenter,
              gesture.arcStart,
              point
            );
            if (object) {
              onSketchCommitRef.current(object);
              gesture.arcCenter = null;
              gesture.arcStart = null;
              rig?.setInProgress(null, false);
              hideSketchDimLabel();
              onSketchDrawingChangeRef.current(false);
            }
          }
          requestRender();
        }
        return;
      }
      if (edgeDrag && event.pointerId === edgeDrag.pointerId) {
        const completed = edgeDrag;
        edgeDrag = null;
        edgeDragActiveRef.current = false;
        onDirectManipulationChangeRef.current(false);
        gestures.release(event, 'grab');
        const rig = edgeRigRef.current;
        const finalValue = rig?.value() ?? 0;
        const moved = Math.hypot(
          event.clientX - completed.startX,
          event.clientY - completed.startY
        );
        if (moved < 4) {
          rig?.setValue(completed.initialValue);
          selectAtPointer(event);
          return;
        }
        depthCycle = null;
        if (
          rig &&
          finalValue > 1e-9 &&
          Math.abs(finalValue - completed.initialValue) > 1e-9
        ) {
          onEdgeCommitRef.current(finalValue);
        }
        return;
      }
      if (
        cylinderRadiusDrag &&
        event.pointerId === cylinderRadiusDrag.pointerId
      ) {
        const completed = cylinderRadiusDrag;
        cylinderRadiusDrag = null;
        cylinderRadiusDragActiveRef.current = false;
        onDirectManipulationChangeRef.current(false);
        gestures.release(event, 'grab');
        const rig = cylinderRadiusRigRef.current;
        const finalRadius = rig?.value() ?? completed.originalRadius;
        const moved = Math.hypot(
          event.clientX - completed.startX,
          event.clientY - completed.startY
        );
        if (moved < 4) {
          rig?.setValue(completed.originalRadius);
          onCylinderRadiusCancelRef.current();
          selectAtPointer(event);
          return;
        }
        depthCycle = null;
        if (rig && Math.abs(finalRadius - completed.originalRadius) > 1e-9) {
          onCylinderRadiusCommitRef.current(finalRadius);
        } else {
          onCylinderRadiusCancelRef.current();
        }
        return;
      }
      if (offsetDrag && event.pointerId === offsetDrag.pointerId) {
        const completed = offsetDrag;
        offsetDrag = null;
        offsetDragActiveRef.current = false;
        onDirectManipulationChangeRef.current(false);
        gestures.release(event, 'grab');
        const rig = offsetRigRef.current;
        const finalOffset = rig?.value() ?? 0;
        const moved = Math.hypot(
          event.clientX - completed.startX,
          event.clientY - completed.startY
        );
        if (moved < 4) {
          rig?.setValue(completed.initialOffset);
          selectAtPointer(event);
          return;
        }
        depthCycle = null;
        if (
          rig &&
          Math.abs(finalOffset - completed.initialOffset) > 1e-9 &&
          Math.abs(finalOffset) > 1e-9
        ) {
          onOffsetCommitRef.current(finalOffset);
        }
        return;
      }
      if (extrudeDrag && event.pointerId === extrudeDrag.pointerId) {
        restoreExtrudeDrag();
        extrudeDrag = null;
        return;
      }
      if (faceDrag && event.pointerId === faceDrag.pointerId) {
        const completed = faceDrag;
        const moved = Math.hypot(
          event.clientX - completed.startX,
          event.clientY - completed.startY
        );
        restoreFaceDrag();
        faceDrag = null;
        if (moved < 4) {
          selectAtPointer(event);
          return;
        }
        depthCycle = null;
        // Primitive faces complete through this path rather than the generic
        // click below, so a completed resize keeps its original selection.
        cameraRig.pivotOn(
          new THREE.Vector3(
            completed.detail.point.x,
            completed.detail.point.y,
            completed.detail.point.z
          )
        );
        onSelectTopologyRef.current(
          completed.selection,
          false,
          completed.detail
        );
        if (moved >= 4 && completed.latestValue !== completed.initialValue) {
          onResizePrimitiveFaceRef.current({
            bodyId: completed.selection.bodyId,
            axis: completed.axis,
            value: completed.latestValue
          });
        }
        return;
      }
      if (event.button !== 0) {
        return;
      }
      const press = gestures.track(event);
      if (!press) {
        return;
      }
      const stayedPut = !press.moved;
      gestures.release(event, null);
      if (stayedPut) {
        selectAtPointer(event);
      } else {
        depthCycle = null;
      }
    };
    const handlePointerCancel = (event: PointerEvent) => {
      pendingHoverEvent = null;
      if (event.pointerId === shiftOrbitPointerId) {
        shiftOrbitPointerId = null;
        cameraRig.setShiftOrbitActive(false);
      }
      if (boxSelect && event.pointerId === boxSelect.pointerId) {
        boxSelect = null;
        hud.hide(selectionBand);
        gestures.release(event, null);
      }
      if (edgeDrag && event.pointerId === edgeDrag.pointerId) {
        const initialValue = edgeDrag.initialValue;
        edgeDrag = null;
        edgeDragActiveRef.current = false;
        onDirectManipulationChangeRef.current(false);
        gestures.release(event);
        edgeRigRef.current?.setValue(initialValue);
        requestRender();
      }
      if (
        cylinderRadiusDrag &&
        event.pointerId === cylinderRadiusDrag.pointerId
      ) {
        const originalRadius = cylinderRadiusDrag.originalRadius;
        cylinderRadiusDrag = null;
        cylinderRadiusDragActiveRef.current = false;
        onDirectManipulationChangeRef.current(false);
        gestures.release(event);
        cylinderRadiusRigRef.current?.setValue(originalRadius);
        onCylinderRadiusCancelRef.current();
        requestRender();
      }
      if (offsetDrag && event.pointerId === offsetDrag.pointerId) {
        const initialOffset = offsetDrag.initialOffset;
        offsetDrag = null;
        offsetDragActiveRef.current = false;
        onDirectManipulationChangeRef.current(false);
        gestures.release(event);
        offsetRigRef.current?.setValue(initialOffset);
        requestRender();
      }
      if (moveDrag && event.pointerId === moveDrag.pointerId) {
        moveDrag = null;
        moveSnaps = [];
        hud.hide(snapGlyph);
        moveDragActiveRef.current = false;
        gestures.release(event);
        clearMoveGizmoHover();
      }
      if (extrudeDrag && event.pointerId === extrudeDrag.pointerId) {
        restoreExtrudeDrag();
        extrudeDrag = null;
      }
      if (faceDrag && event.pointerId === faceDrag.pointerId) {
        restoreFaceDrag();
        faceDrag = null;
      }
      rightClickGesture.cancel(event.pointerId);
      rightPanStartTarget = null;
      gestures.reset();
    };
    const handlePointerLeave = () => {
      pendingHoverEvent = null;
      sketchRigRef.current?.setInference(null);
      sketchCenterTarget.hidden = true;
      if (moveDrag) {
        return;
      }
      clearMoveGizmoHover();
      applyHover(null);
    };
    const handleDoubleClick = (event: MouseEvent) => {
      depthCycle = null;
      // Double-clicking an edge takes the whole smooth run it belongs to.
      // Rounding a lip means selecting every edge around it, and a filleted
      // rim is a run of lines and arcs rather than one edge.
      const picked = picker.pick(event);
      if (picked?.selection?.kind === 'edge' && picked.selection.topologyId) {
        const body = bodiesRef.current.find(
          (candidate) => candidate.bodyId === picked.selection?.bodyId
        );
        const edges = body?.topology?.edges;
        if (edges) {
          const chain = edgeRunFrom(edges, picked.selection.topologyId);
          if (chain.length > 1) {
            const byId = new Map(
              edges.map((edgeTopology) => [
                edgeTopology.topologyId,
                edgeTopology
              ])
            );
            onSelectEdgeChainRef.current(
              chain.map((topologyId) => ({
                bodyId: picked.selection!.bodyId,
                kind: 'edge' as const,
                topologyId,
                hash: byId.get(topologyId)?.hash
              }))
            );
            return;
          }
        }
      }
      // A face or isolated edge is still an address on its owning body.
      // Promote that hit after the edge-run shortcut so double-clicking the
      // solid selects the whole body without changing the active filter.
      if (picked?.selection) {
        onSelectTopologyRef.current(
          { bodyId: picked.selection.bodyId, kind: 'body' },
          event.shiftKey
        );
        return;
      }
      if (bodyGroup.children.length === 0) {
        return;
      }
      const pose = computeFitPose(camera, bodyGroup.children);
      cameraRig.startTween(pose, () => {
        if (context.projection === 'orthographic') {
          cameraRig.syncOrthographic(true);
        }
      });
    };

    const handleContextMenu = (event: MouseEvent) => {
      // Browsers may dispatch this before the right-button gesture finishes.
      // Suppress the native menu here; pointerup decides whether to open ours.
      event.preventDefault();
    };
    // The canvas listener alone is not enough: HUD chips and the CSS2D label
    // layer sit above the canvas, and a right-click landing on them surfaces
    // the browser's own menu (Safari offers "Save Image As…" for the canvas
    // beneath). The host wrapper sees the event whichever layer was hit.
    host.addEventListener('contextmenu', handleContextMenu);

    const handleWheel = () => {
      cameraRig.cancelTween();
    };

    renderer.domElement.addEventListener(
      'pointermove',
      handlePointerMove,
      true
    );
    renderer.domElement.addEventListener(
      'pointerdown',
      handlePointerDown,
      true
    );
    renderer.domElement.addEventListener('pointerup', handlePointerUp, true);
    renderer.domElement.addEventListener(
      'pointercancel',
      handlePointerCancel,
      true
    );
    renderer.domElement.addEventListener('pointerleave', handlePointerLeave);
    renderer.domElement.addEventListener('dblclick', handleDoubleClick);
    renderer.domElement.addEventListener('contextmenu', handleContextMenu);
    renderer.domElement.addEventListener('wheel', handleWheel, {
      passive: true
    });

    const lastQuaternion = new THREE.Quaternion();
    function animate(now: number) {
      animationFrame = null;
      if (resizePending) {
        resizePending = false;
        const width = viewerHost.clientWidth;
        const height = viewerHost.clientHeight;
        cameraRig.handleResize();
        renderer.setSize(width, height);
        labelRenderer.setSize(width, height);
        // Screen-space fat lines rasterize against the viewport size. Walking
        // the scene covers body edges, sketches, previews and handle rigs
        // alike, so no creation site has to remember to register its material.
        syncFatLineResolution(scene, width, height);
      }
      // Camera glide first so controls and the ortho mirror see the result.
      const tweening = cameraRig.stepTween(now);
      const controlsChanged = cameraRig.stepOrbit(now);
      const hoverEvent = pendingHoverEvent;
      pendingHoverEvent = null;
      if (hoverEvent) {
        applyHoverAt(hoverEvent);
      }
      // The perspective camera stays the pose master; mirror it while the
      // ortho camera drives so switches and fits never jump.
      if (context.projection === 'orthographic' && !tweening) {
        camera.position.copy(orthographic.position);
        camera.quaternion.copy(orthographic.quaternion);
      }

      const activeSketchMode = sketchModeRef.current;
      const activeSketchRig = sketchRigRef.current;
      let inferenceAnimating = false;
      if (activeSketchMode && activeSketchRig) {
        const sketchOrigin = new THREE.Vector3(
          activeSketchMode.basis.origin.x,
          activeSketchMode.basis.origin.y,
          activeSketchMode.basis.origin.z
        );
        const spacing = activeSketchRig.setGrid(
          worldPerPixelAt(sketchOrigin),
          activeSketchMode.gridVisible
        );
        if (activeSketchMode.gridVisible) {
          sketchGridIndicator.textContent = `Grid ${formatNumber(spacing)} ${unitsRef.current} · adaptive`;
          sketchGridIndicator.hidden = false;
        } else {
          sketchGridIndicator.hidden = true;
        }
        inferenceAnimating = activeSketchRig.advanceInference(
          now,
          reducedMotionRef.current === true
        );
      } else {
        sketchGridIndicator.hidden = true;
      }

      // Preselection and selection overlays ease toward their targets.
      // Timer separates advancing time from reading it, so update once here.
      context.timer.update(now);
      const dt = Math.min(context.timer.getDelta(), 0.05);
      const ease = 1 - Math.exp(-dt * 16);
      selection.step(dt);
      for (const material of context.fadeIns) {
        const target =
          (material.userData.targetOpacity as number | undefined) ?? 0.34;
        const next = material.opacity + (target - material.opacity) * ease;
        material.opacity = next;
        if (Math.abs(target - next) < 0.004) {
          material.opacity = target;
          context.fadeIns.delete(material);
        }
      }
      if (moveGizmoGroup.children.length > 0) {
        const baseScale = Math.max(
          (moveGizmoGroup.userData.baseGizmoScale as number | undefined) ?? 1,
          1e-9
        );
        const gizmoScale = moveGizmoWorldScale(
          worldPerPixelAt(moveGizmoGroup.position)
        );
        moveGizmoGroup.scale.setScalar(gizmoScale / baseScale);
        moveGizmoGroup.userData.gizmoScale = gizmoScale;
      }
      const offsetRig = offsetRigRef.current;
      if (offsetRig) {
        // Screen-constant arrow, ~0.55× the move gizmo's reach.
        const rigScale =
          moveGizmoWorldScale(worldPerPixelAt(offsetRig.group.position)) * 0.55;
        offsetRig.group.scale.setScalar(rigScale);
        offsetRig.group.userData.gizmoScale = rigScale;
      }
      const cylinderRig = cylinderRadiusRigRef.current;
      if (cylinderRig) {
        const rigScale =
          moveGizmoWorldScale(worldPerPixelAt(cylinderRig.group.position)) *
          0.55;
        cylinderRig.group.scale.setScalar(rigScale);
        cylinderRig.group.userData.gizmoScale = rigScale;
        // Re-run the rig's layout so its dimension-line arrowheads track the
        // freshly stamped screen-constant scale.
        cylinderRig.setValue(cylinderRig.value());
      }
      const edgeRig = edgeRigRef.current;
      if (edgeRig) {
        const rigScale =
          moveGizmoWorldScale(worldPerPixelAt(edgeRig.group.position)) * 0.4;
        edgeRig.group.scale.setScalar(rigScale);
        edgeRig.group.userData.gizmoScale = rigScale;
      }
      updateOffsetChip();
      updateStudioGrid(grid, context.activeCamera, cameraRig.controls.target);
      updateAxesGizmo(axes, context.activeCamera);
      shadowCatcher.visible = shouldShowGroundShadow(
        context.activeCamera,
        showGridRef.current
      );
      // The first draw compiles every material's shaders and uploads the
      // environment map, so it costs far more than steady-state frames.
      if (firstFrame) {
        firstFrame = false;
        timed('viewer.firstFrame', () =>
          renderer.render(scene, context.activeCamera)
        );
        mark('viewer.firstFrame.ready');
        measure(
          'viewer.interactive',
          'viewer.init:begin',
          'viewer.firstFrame.ready'
        );
      } else {
        renderer.render(scene, context.activeCamera);
      }
      if (import.meta.env.OZ_PERF === '1') {
        mark('viewer.frame', {
          frameMs:
            lastPerfFrameAt === null
              ? null
              : Math.max(now - lastPerfFrameAt, 0),
          drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles
        });
        lastPerfFrameAt = now;
      }
      updateDimensionLabels(
        context,
        renderer.domElement.clientWidth,
        renderer.domElement.clientHeight
      );
      labelRenderer.render(scene, context.activeCamera);
      clampNameCallouts(labelRenderer.domElement);

      // Push camera orientation to the view widget only when it changes.
      const orientationCamera = context.activeCamera;
      if (!orientationCamera.quaternion.equals(lastQuaternion)) {
        lastQuaternion.copy(orientationCamera.quaternion);
        const sink = orientationRef.current;
        if (sink) {
          const inverse = orientationCamera.quaternion.clone().invert();
          const project = (axis: THREE.Vector3) => {
            const view = axis.clone().applyQuaternion(inverse);
            return { x: view.x, y: -view.y, z: view.z };
          };
          sink({
            x: project(new THREE.Vector3(1, 0, 0)),
            y: project(new THREE.Vector3(0, 1, 0)),
            z: project(new THREE.Vector3(0, 0, 1))
          });
        }
      }
      const hoverAnimating = selection.isSettling;
      if (
        tweening ||
        controlsChanged ||
        hoverAnimating ||
        inferenceAnimating ||
        context.fadeIns.size > 0
      ) {
        requestRender();
      }
    }
    requestRender();
    performance.measure?.('oz:viewer.init', 'oz:viewer.init:begin');

    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      observer.disconnect();
      renderer.domElement.removeEventListener(
        'pointermove',
        handlePointerMove,
        true
      );
      renderer.domElement.removeEventListener(
        'pointerdown',
        handlePointerDown,
        true
      );
      renderer.domElement.removeEventListener(
        'pointerup',
        handlePointerUp,
        true
      );
      renderer.domElement.removeEventListener(
        'pointercancel',
        handlePointerCancel,
        true
      );
      renderer.domElement.removeEventListener(
        'pointerleave',
        handlePointerLeave
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-select-cylinder',
        handleE2ECylinderSelection
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-render-policy',
        handleE2ERenderPolicy
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-select-profile',
        handleE2EProfileSelection
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-locate-edge',
        handleE2ELocateEdge
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-input-state',
        handleE2EInputState
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-pixel-ratio',
        handleE2EPixelRatio
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-control-pointer',
        handleE2EControlPointer
      );
      document.removeEventListener('keydown', handleCapturedEscape, true);
      renderer.domElement.removeEventListener('dblclick', handleDoubleClick);
      renderer.domElement.removeEventListener('contextmenu', handleContextMenu);
      host.removeEventListener('contextmenu', handleContextMenu);
      renderer.domElement.removeEventListener('wheel', handleWheel);
      clearGroup(bodyGroup);
      clearGroup(sketchGroup);
      clearGroup(overlayGroup);
      clearGroup(gizmoGroup);
      clearGroup(moveGizmoGroup);
      for (const disposable of [grid, shadowCatcher] as THREE.Mesh[]) {
        disposable.geometry.dispose();
        (disposable.material as THREE.Material).dispose();
      }
      selection.dispose();
      environment.dispose();
      gradientBackground.dispose();
      clearGroup(axes); // the triad is three fat lines now, not one helper
      cameraRig.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      host.removeChild(labelRenderer.domElement);
      offsetChip.removeEventListener('click', handleChipClick);
      radiusLabelChip.removeEventListener('click', handleChipClick);
      hud.dispose();
      offsetChipRef.current = null;
      sketchDimLabelRef.current = null;
      sketchSnapMarkerRef.current = null;
      sketchCenterTargetRef.current = null;
      offsetSetterRef.current = null;
      cancelDirectManipulationRef.current = null;
      moveGizmoHudRef.current = null;
      if (orientationDragRef.current === orientationDragControls) {
        orientationDragRef.current = null;
      }
      contextRef.current = null;
    };
  }, []);

  // Body geometry is rebuilt only when the derived body projection changes.
  // Selection-only renders reuse the installed meshes, materials, edge
  // batches, and frozen shadow map while refreshing lightweight overlays.
  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }

    const bodiesChanged = renderedBodiesRef.current !== bodies;
    if (bodiesChanged) {
      mark('viewer.bodies:begin');
      clearGroup(context.bodyGroup);
      context.selection.resetForRebuild();
      context.objectsByBodyId.clear();
      context.edgeOverlaysByBodyId.clear();
    }
    clearGroup(context.overlayGroup);
    context.dimensionLabels.clear();
    const edgeResolution = context.fatLineResolution();

    for (const body of bodies) {
      const object = bodiesChanged
        ? createObjectForBody(body, edgeResolution)
        : context.objectsByBodyId.get(body.bodyId);
      if (!object) {
        continue;
      }
      if (bodiesChanged) {
        object.userData.bodyId = body.bodyId;
      }
      const previousSelectionOverlay = object.getObjectByName(
        'body-selection-overlay'
      );
      if (previousSelectionOverlay instanceof THREE.Group) {
        const selectionGroup =
          previousSelectionOverlay as unknown as THREE.Group;
        clearGroup(selectionGroup);
        object.remove(selectionGroup);
      }
      const isSelected = selectedBodyIds.includes(body.bodyId);

      forEachMesh(object, (mesh) => {
        const baseEmissive = isSelected ? SELECTION_EMISSIVE : 0x000000;
        mesh.material.emissive.setHex(baseEmissive);
        mesh.userData.baseEmissive = baseEmissive;
        if (bodiesChanged) {
          mesh.userData.bodyId = body.bodyId;
          mesh.userData.topology = body.topology;
          mesh.castShadow = true;
          mesh.receiveShadow = false;
        }
      });

      let edgeOverlay = context.edgeOverlaysByBodyId.get(body.bodyId);
      if (bodiesChanged) {
        edgeOverlay = createBodyEdgeOverlay(body, edgeResolution);
        edgeOverlay.setDisplayMode(displayModeRef.current);
        object.add(edgeOverlay);
        context.edgeOverlaysByBodyId.set(body.bodyId, edgeOverlay);
      }
      edgeOverlay?.setSelected(selectedEdges);

      const selectedFace =
        selectedTopology?.kind === 'face' &&
        selectedTopology.bodyId === body.bodyId
          ? body.topology?.faces.find(
              (face) => face.topologyId === selectedTopology.topologyId
            )
          : undefined;
      if (selectedFace) {
        const selectionOverlay = new THREE.Group();
        selectionOverlay.name = 'body-selection-overlay';
        object.add(selectionOverlay);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(body.mesh.vertices, 3)
        );
        geometry.setIndex(
          body.mesh.indices.slice(
            selectedFace.triangleStart * 3,
            (selectedFace.triangleStart + selectedFace.triangleCount) * 3
          )
        );
        geometry.computeVertexNormals();
        const highlightMaterial = new THREE.MeshBasicMaterial({
          color: SELECTED_FACE_COLOR,
          toneMapped: false,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -3
        });
        highlightMaterial.userData.targetOpacity = SELECTED_FACE_OPACITY;
        const highlight = new THREE.Mesh(geometry, highlightMaterial);
        highlight.renderOrder = VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY;
        highlight.raycast = () => undefined;
        selectionOverlay.add(highlight);
        context.fadeIns.add(highlightMaterial);

        if (editableBodyIds.includes(body.bodyId)) {
          const normal = normalForTriangle(body, selectedFace.triangleStart);
          if (normal) {
            const { axis } = directEditDirectionFromNormal(normal);
            const value = body.bbox.max[axis] - body.bbox.min[axis];
            geometry.computeBoundingBox();
            const center = geometry.boundingBox?.getCenter(new THREE.Vector3());
            if (center) {
              const dimension =
                axis === 'x' ? 'Width' : axis === 'y' ? 'Height' : 'Depth';
              const rounded = Math.round(value * 100) / 100;
              // Editable dimension pill: drag the face for a rough size, or
              // click the value and type an exact one.
              const bboxSize = new THREE.Vector3(
                body.bbox.max.x - body.bbox.min.x,
                body.bbox.max.y - body.bbox.min.y,
                body.bbox.max.z - body.bbox.min.z
              );
              const modelCenter = new THREE.Vector3(
                (body.bbox.min.x + body.bbox.max.x) / 2,
                (body.bbox.min.y + body.bbox.max.y) / 2,
                (body.bbox.min.z + body.bbox.max.z) / 2
              );
              const modelWorldSize = Math.max(
                bboxSize.x,
                bboxSize.y,
                bboxSize.z,
                1e-6
              );
              const lineStart = modelCenter.clone();
              const lineEnd = modelCenter.clone();
              lineStart[axis] = body.bbox.min[axis];
              lineEnd[axis] = body.bbox.max[axis];
              const offsetAxis: DirectEditAxis =
                axis === 'x' ? 'y' : axis === 'y' ? 'z' : 'x';
              const lineOffset =
                body.bbox.max[offsetAxis] +
                Math.max(modelWorldSize * 0.08, 0.5);
              lineStart[offsetAxis] = lineOffset;
              lineEnd[offsetAxis] = lineOffset;

              const dimensionGeometry = new LineGeometry();
              dimensionGeometry.setPositions([
                lineStart.x,
                lineStart.y,
                lineStart.z,
                lineEnd.x,
                lineEnd.y,
                lineEnd.z
              ]);
              const dimensionMaterial = createFatLineMaterial({
                color: 0x7cc0ff,
                linewidth: 1.5,
                opacity: 0.48,
                depthTest: false,
                resolution: edgeResolution
              });
              dimensionMaterial.depthWrite = false;
              const dimensionLine = new Line2(
                dimensionGeometry,
                dimensionMaterial
              );
              dimensionLine.computeLineDistances();
              dimensionLine.raycast = () => undefined;
              dimensionLine.renderOrder = 18;
              context.overlayGroup.add(dimensionLine);

              const element = document.createElement('div');
              element.className = 'dimension-callout-anchor';
              element.style.pointerEvents = 'auto';
              const pill = document.createElement('div');
              pill.className =
                'selection-callout direct-edit-callout editable dimension-callout';
              const valueButton = document.createElement('button');
              valueButton.type = 'button';
              valueButton.className = 'callout-value';
              valueButton.title = `Click to type an exact ${dimension.toLowerCase()}`;
              valueButton.textContent = `${dimension} ${rounded} ${units}`;
              pill.appendChild(valueButton);
              element.appendChild(pill);
              const bodyId = body.bodyId;
              valueButton.addEventListener('click', () => {
                const input = document.createElement('input');
                input.className = 'callout-input';
                input.value = String(rounded);
                input.inputMode = 'decimal';
                input.setAttribute(
                  'aria-label',
                  `${dimension} in ${unitsRef.current}`
                );
                pill.replaceChildren(input);
                input.focus();
                input.select();
                let done = false;
                const finish = (commit: boolean) => {
                  if (done) {
                    return;
                  }
                  done = true;
                  pill.replaceChildren(valueButton);
                  const next = Number.parseFloat(input.value);
                  if (
                    commit &&
                    Number.isFinite(next) &&
                    next > 0 &&
                    Math.abs(next - rounded) > 1e-9
                  ) {
                    onResizePrimitiveFaceRef.current({
                      bodyId,
                      axis,
                      value: next
                    });
                  }
                };
                input.addEventListener('keydown', (keyEvent) => {
                  keyEvent.stopPropagation();
                  if (keyEvent.key === 'Enter') {
                    finish(true);
                  } else if (keyEvent.key === 'Escape') {
                    finish(false);
                  }
                });
                input.addEventListener('blur', () => finish(true));
              });
              const label = new CSS2DObject(element);
              label.position.copy(lineStart).lerp(lineEnd, 0.5);
              context.overlayGroup.add(label);
              context.dimensionLabels.add({
                pill,
                start: lineStart,
                end: lineEnd,
                modelCenter,
                modelWorldSize
              });
            }
          }
        }
      }

      if (bodiesChanged) {
        context.bodyGroup.add(object);
        context.objectsByBodyId.set(body.bodyId, object);
      }
    }

    if (bodiesChanged) {
      applyDisplayMode(context.bodyGroup, displayModeRef.current);
    }

    // Retune the key light's shadow frustum around the current model so the
    // grounding shadow stays crisp instead of being clipped or pixelated.
    if (bodiesChanged) {
      const sceneBox = new THREE.Box3();
      for (const child of context.bodyGroup.children) {
        sceneBox.expandByObject(child);
      }
      if (!sceneBox.isEmpty()) {
        const sceneSize = sceneBox.getSize(new THREE.Vector3());
        const sceneCenter = sceneBox.getCenter(new THREE.Vector3());
        tuneShadowFrustum(
          context.keyLight,
          Math.max(sceneSize.x, sceneSize.y, sceneSize.z) / 2
        );
        context.keyLight.position.set(
          sceneCenter.x + 90,
          sceneCenter.y - 100,
          sceneCenter.z + 140
        );
        context.keyLight.target.position.copy(sceneCenter);
        context.keyLight.target.updateMatrixWorld();
      }
      // Bodies are the only dynamic shadow casters; camera and selection-only
      // frames reuse this map until geometry or the light rig changes again.
      context.renderer.shadowMap.needsUpdate = true;
      renderedBodiesRef.current = bodies;
    }

    // Name callout on the primary (last picked) selected body.
    const primaryId = selectedBodyIds.at(-1);
    if (primaryId) {
      const target = context.objectsByBodyId.get(primaryId);
      const body = bodies.find((candidate) => candidate.bodyId === primaryId);
      if (target && body) {
        const box = new THREE.Box3().setFromObject(target);
        if (!box.isEmpty()) {
          const top = box.getCenter(new THREE.Vector3());
          top.z =
            box.max.z + Math.max(box.getSize(new THREE.Vector3()).z * 0.12, 5);
          const suffix =
            selectedTopology?.bodyId === primaryId &&
            selectedTopology.topologyId
              ? ` · ${
                  selectedTopology.kind === 'edge'
                    ? edgeLabel(
                        body,
                        selectedTopology.hash,
                        selectedTopology.topologyId
                      )
                    : faceLabel(
                        body,
                        selectedTopology.hash,
                        selectedTopology.topologyId
                      )
                }`
              : '';
          const count =
            selectedBodyIds.length > 1 ? ` +${selectedBodyIds.length - 1}` : '';
          const label = makeLabel(
            'selection-callout',
            `${body.name}${suffix}${count}`
          );
          label.position.copy(top);
          context.overlayGroup.add(label);
        }
      }
    }

    if (!context.hasFitCamera && context.bodyGroup.children.length > 0) {
      fitCameraToObjects(
        context.camera,
        context.controls.target,
        context.bodyGroup.children
      );
      if (context.projection === 'orthographic') {
        context.syncOrthographic(true);
      }
      context.controls.update();
      context.hasFitCamera = true;
      onViewChangeRef.current(context.captureView());
    }
    context.requestRender();
    if (bodiesChanged) {
      performance.measure?.('oz:viewer.bodies', 'oz:viewer.bodies:begin');
    }
  }, [
    bodies,
    editableBodyIds,
    selectedBodyIds,
    selectedEdges,
    selectedTopology,
    units
  ]);

  // Move/Rotate gizmo: translation arrows, rotation rings, and a free-move
  // center handle at the target body's center. The active drag owns the
  // gizmo imperatively, so prop-driven rebuilds pause until release.
  useEffect(() => {
    const context = contextRef.current;
    if (!context || moveDragActiveRef.current) {
      return;
    }
    clearGroup(context.moveGizmoGroup);
    context.requestRender();
    if (!movePreview) {
      applyMoveGizmoFocus(context.moveGizmoGroup, null);
      if (moveGizmoHudRef.current) {
        moveGizmoHudRef.current.hidden = true;
      }
      if (moveCommitHold) {
        // Committed move, rebuild in flight: keep the (still old) mesh posed
        // at the applied transform so it never flashes at the resting pose.
        const held = bodies.find(
          (candidate) => candidate.bodyId === moveCommitHold.bodyId
        );
        if (held) {
          moveCenterRef.current.set(
            (held.bbox.min.x + held.bbox.max.x) / 2,
            (held.bbox.min.y + held.bbox.max.y) / 2,
            (held.bbox.min.z + held.bbox.max.z) / 2
          );
          context.applyMovePreview(
            moveCommitHold.translation,
            moveCommitHold.rotationDeg
          );
        }
        return;
      }
      // Cancel without a document change must restore the resting pose.
      for (const object of context.objectsByBodyId.values()) {
        object.position.set(0, 0, 0);
        object.rotation.set(0, 0, 0);
      }
      const overlay = regionGroupRef.current;
      if (overlay) {
        for (const child of overlay.children) {
          if (child.userData.sketchViewId) {
            child.position.set(0, 0, 0);
          }
        }
      }
      return;
    }
    let center: THREE.Vector3;
    if (movePreview.target === 'sketch') {
      const view = sketchViews.find(
        (candidate) => candidate.sketchId === movePreview.bodyId
      );
      const lifted = view ? sketchViewCenter(view) : null;
      if (!lifted) {
        return;
      }
      center = lifted;
    } else {
      const body = bodies.find(
        (candidate) => candidate.bodyId === movePreview.bodyId
      );
      if (!body) {
        return;
      }
      center = new THREE.Vector3(
        (body.bbox.min.x + body.bbox.max.x) / 2,
        (body.bbox.min.y + body.bbox.max.y) / 2,
        (body.bbox.min.z + body.bbox.max.z) / 2
      );
    }
    moveCenterRef.current.copy(center);
    const projectedUnitSizePx = projectedWorldSizePx(
      context.activeCamera,
      center,
      1,
      Math.max(context.renderer.domElement.clientHeight, 1)
    );
    const scale = moveGizmoWorldScale(1 / Math.max(projectedUnitSizePx, 1e-9));
    context.moveGizmoGroup.scale.setScalar(1);
    context.moveGizmoGroup.userData.baseGizmoScale = scale;
    context.moveGizmoGroup.userData.gizmoScale = scale;

    for (const part of buildMoveGizmoParts(scale)) {
      // A sketch translates only — a rectangle has no angle to store — so the
      // rotation rings are omitted rather than offered and ignored.
      if (
        movePreview.target === 'sketch' &&
        (part.userData as MoveGizmoVisualData).kind === 'ring'
      ) {
        continue;
      }
      context.moveGizmoGroup.add(part);
    }

    context.applyMovePreview(movePreview.translation, movePreview.rotationDeg);
    applyMoveGizmoFocus(
      context.moveGizmoGroup,
      (context.moveGizmoGroup.userData.focus as MoveGizmoFocus | undefined) ??
        null
    );
  }, [movePreview, moveCommitHold, bodies, sketchViews]);

  useEffect(() => {
    contextRef.current?.applyProjection(projection);
  }, [projection]);

  // Navigation preferences are read per call, but the orbit controls cache
  // them, so a live toggle has to push the new value onto the instance.
  useEffect(() => {
    contextRef.current?.refreshNavigation();
  }, [settings.zoomToCursor, settings.middleDrag]);

  // Cylindrical wall radius: the handle moves radially while exact preview
  // geometry rebuilds concentrically around the immutable axis snapshot.
  useEffect(() => {
    const context = contextRef.current;
    if (!context || cylinderRadiusDragActiveRef.current) {
      return;
    }
    cylinderRadiusRigRef.current?.dispose();
    cylinderRadiusRigRef.current = null;
    if (offsetChipRef.current) {
      offsetChipRef.current.hidden = true;
    }
    if (!cylinderRadiusHandle) {
      context.requestRender();
      return;
    }
    const rig = buildCylinderRadiusHandle({
      origin: cylinderRadiusHandle.point,
      direction: cylinderRadiusHandle.radialDirection,
      originalRadius: cylinderRadiusHandle.originalRadius
    });
    context.scene.add(rig.group);
    context.scene.add(rig.worldGroup);
    cylinderRadiusRigRef.current = rig;
    context.requestRender();
    return () => {
      if (!cylinderRadiusDragActiveRef.current) {
        rig.dispose();
        if (cylinderRadiusRigRef.current === rig) {
          cylinderRadiusRigRef.current = null;
        }
      }
    };
  }, [cylinderRadiusHandle]);

  // Offset-face handle: built when a face is armed, torn down on deselect or
  // commit. Never rebuilt mid-drag (the drag holds offsetDragActiveRef).
  useEffect(() => {
    const context = contextRef.current;
    if (!context || offsetDragActiveRef.current) {
      return;
    }
    offsetRigRef.current?.dispose();
    offsetRigRef.current = null;
    if (offsetChipRef.current) {
      offsetChipRef.current.hidden = true;
    }
    if (!offsetHandle) {
      context.requestRender();
      return;
    }
    // Ghost geometry: the face's world-space triangle range.
    const body = bodies.find(
      (candidate) => candidate.bodyId === offsetHandle.bodyId
    );
    const face = body?.topology?.faces.find(
      (candidate) => candidate.topologyId === offsetHandle.topologyId
    );
    let ghostGeometry: THREE.BufferGeometry | null = null;
    if (body && face) {
      ghostGeometry = new THREE.BufferGeometry();
      ghostGeometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(body.mesh.vertices, 3)
      );
      ghostGeometry.setIndex(
        body.mesh.indices.slice(
          face.triangleStart * 3,
          (face.triangleStart + face.triangleCount) * 3
        )
      );
    }
    const rig = buildOffsetFaceHandle({
      ...offsetHandlePlacement(offsetHandle.point, offsetHandle.normal),
      ghostGeometry
    });
    rig.setValue(offsetHandle.initialValue ?? 0);
    // Fat-line materials need the viewport resolution for correct widths.
    const { width, height } = context.fatLineResolution();
    syncFatLineResolution(rig.worldGroup, width, height);
    context.scene.add(rig.group);
    context.scene.add(rig.worldGroup);
    offsetRigRef.current = rig;
    context.requestRender();
    return () => {
      if (!offsetDragActiveRef.current) {
        rig.dispose();
        if (offsetRigRef.current === rig) {
          offsetRigRef.current = null;
        }
      }
    };
  }, [offsetHandle, bodies]);

  // Edge-radius handle: built when edges arm fillet/chamfer, torn down on
  // deselect or commit. Never rebuilt mid-drag.
  useEffect(() => {
    const context = contextRef.current;
    edgeHandleOpRef.current = edgeHandle?.op ?? 'fillet';
    if (!context || edgeDragActiveRef.current) {
      return;
    }
    edgeRigRef.current?.dispose();
    edgeRigRef.current = null;
    if (!edgeHandle) {
      context.requestRender();
      return;
    }
    const body = bodies.find(
      (candidate) => candidate.bodyId === edgeHandle.bodyId
    );
    const edge = body?.topology?.edges.find(
      (candidate) => candidate.topologyId === edgeHandle.topologyId
    );
    if (!body || !edge) {
      return;
    }
    const center = {
      x: (body.bbox.min.x + body.bbox.max.x) / 2,
      y: (body.bbox.min.y + body.bbox.max.y) / 2,
      z: (body.bbox.min.z + body.bbox.max.z) / 2
    };
    const placement = edgeHandlePlacement(edge.points, center);
    if (!placement) {
      return;
    }
    const rig = buildEdgeRadiusHandle(placement);
    rig.setValue(edgeHandle.initialValue ?? 0);
    context.scene.add(rig.group);
    edgeRigRef.current = rig;
    context.requestRender();
    return () => {
      if (!edgeDragActiveRef.current) {
        rig.dispose();
        if (edgeRigRef.current === rig) {
          edgeRigRef.current = null;
        }
      }
    };
  }, [edgeHandle, bodies]);

  // Region-detected sketch rendering: curves stay readable while bounded
  // cells get cached fill, boundary, marker, and plane-local pick targets.
  useEffect(() => {
    const context = contextRef.current;
    const group = regionGroupRef.current;
    if (!context || !group) {
      return;
    }
    context.selection.setRegionHover(null);
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((node) => {
        if (
          node instanceof THREE.Mesh ||
          node instanceof THREE.Line ||
          node instanceof THREE.Points
        ) {
          (node.geometry as THREE.BufferGeometry).dispose();
          (node.material as THREE.Material).dispose();
        }
      });
    }
    profilePickTargetsRef.current = [];
    for (const view of sketchViews) {
      const basis = view.basis;
      for (const curve of view.curves) {
        if (curve.points.length < 2) {
          continue;
        }
        const vertices = curve.points.map(
          (point) =>
            new THREE.Vector3(
              basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
              basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
              basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
            )
        );
        const line = createFatLine(vertices, {
          color: view.selected
            ? SKETCH_SELECTED_COLOR
            : curve.construction
              ? 0x7b8da3
              : SKETCH_COLOR,
          linewidth: view.selected ? 1.8 : SKETCH_CURVE_WIDTH,
          opacity: view.selected ? 1 : curve.construction ? 0.72 : 0.9,
          closed: curve.closed,
          resolution: context.fatLineResolution()
        });
        line.name = 'sketch-curve';
        line.userData.sketchViewId = view.sketchId;
        if (curve.construction) {
          line.material.dashed = true;
          line.material.dashSize = 1.4;
          line.material.gapSize = 1;
        }
        line.renderOrder = view.selected
          ? VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY
          : VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
        group.add(line);
      }
      for (const region of view.regions) {
        const pick: RegionPickData = {
          sketchId: view.sketchId,
          profileId: region.profileId,
          regionFingerprint: region.regionFingerprint,
          samplePoint: region.samplePoint,
          centroid: region.centroid,
          boundingBox: region.boundingBox,
          sourceEntityIds: region.sourceEntityIds,
          area: region.area
        };
        const baseOpacity = view.active ? REGION_IDLE_OPACITY : 0;
        const mesh = buildRegionMesh(region.outer, region.holes, basis, pick, {
          baseOpacity,
          selected: false
        });
        const boundaries = [region.outer, ...region.holes].map((loop) => {
          const points = loop.map(
            (point) =>
              new THREE.Vector3(
                basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
                basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
                basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
              )
          );
          const boundary = createFatLine(points, {
            color: 0x79b8ff,
            linewidth: 1.6,
            opacity: 0.72,
            closed: true,
            resolution: context.fatLineResolution()
          });
          boundary.name = 'sketch-region-boundary';
          // The base curve already renders the sketch. Keep region boundaries
          // dormant until hover/selection needs an intentional highlight;
          // drawing both continuously creates a second coincident sketch pass.
          boundary.visible = false;
          boundary.renderOrder = VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT;
          boundary.raycast = () => undefined;
          boundary.userData.sketchViewId = view.sketchId;
          group.add(boundary);
          return boundary;
        });
        const markerPosition = new THREE.Vector3(
          basis.origin.x +
            basis.u.x * region.centroid.x +
            basis.v.x * region.centroid.y,
          basis.origin.y +
            basis.u.y * region.centroid.x +
            basis.v.y * region.centroid.y,
          basis.origin.z +
            basis.u.z * region.centroid.x +
            basis.v.z * region.centroid.y
        );
        const marker = new THREE.Points(
          new THREE.BufferGeometry().setFromPoints([markerPosition]),
          new THREE.PointsMaterial({
            color: 0xffffff,
            size: 7,
            sizeAttenuation: false,
            depthWrite: false
          })
        );
        marker.renderOrder = 12;
        marker.visible = false;
        marker.raycast = () => undefined;
        group.add(mesh, marker);
        mesh.userData.regionBoundaries = boundaries;
        mesh.userData.regionMarker = marker;
        mesh.userData.sketchViewId = view.sketchId;
        marker.userData.sketchViewId = view.sketchId;
        profilePickTargetsRef.current.push({
          pick,
          object: mesh,
          basis,
          outer: region.outer,
          holes: region.holes
        });
      }
    }
    context.requestRender();
  }, [sketchViews]);

  // Selection and command mode only alter materials/markers. The profile
  // triangulation above remains cached until sketchViews changes.
  useEffect(() => {
    const context = contextRef.current;
    const group = regionGroupRef.current;
    if (!context || !group) {
      return;
    }
    const selected = new Set(selectedProfileIds);
    const activeBySketch = new Map(
      sketchViews.map((view) => [view.sketchId, view.active] as const)
    );
    for (const child of group.children) {
      if (!(child instanceof THREE.Mesh) || !child.userData.region) {
        continue;
      }
      const pick = child.userData.region as RegionPickData;
      const baseOpacity = profileSelectionMode
        ? REGION_COMMAND_OPACITY
        : activeBySketch.get(pick.sketchId)
          ? REGION_IDLE_OPACITY
          : 0;
      context.selection.updateRegionState(
        child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>,
        selected.has(pick.profileId),
        baseOpacity
      );
    }
  }, [profileSelectionMode, selectedProfileIds, sketchViews]);

  // Armed region: keep its fill lit and share the offset arrow rig for the
  // extrude drag (the drag/chip/keypad machinery is rig-agnostic).
  useEffect(() => {
    const context = contextRef.current;
    const group = regionGroupRef.current;
    if (!context || !group || offsetDragActiveRef.current) {
      return;
    }
    if (!regionHandle) {
      return;
    }
    const view = sketchViews.find(
      (candidate) => candidate.sketchId === regionHandle.sketchId
    );
    const region = view?.regions.find(
      (candidate) =>
        candidate.regionFingerprint === regionHandle.regionFingerprint
    );
    if (!view || !region) {
      return;
    }
    const basis = view.basis;
    const mesh = group.children.find(
      (child) =>
        (child.userData.region as RegionPickData | undefined)
          ?.regionFingerprint === regionHandle.regionFingerprint
    ) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | undefined;
    if (mesh) {
      mesh.userData.regionSelected = true;
      mesh.material.userData.targetOpacity = REGION_SELECTED_OPACITY;
      context.fadeIns.add(mesh.material);
    }
    const { positions, indices } = triangulateRegionGeometry(
      region.outer,
      region.holes,
      basis
    );
    const ghostGeometry = new THREE.BufferGeometry();
    ghostGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3)
    );
    ghostGeometry.setIndex(indices);
    const origin = {
      x:
        basis.origin.x +
        basis.u.x * regionHandle.samplePoint.x +
        basis.v.x * regionHandle.samplePoint.y,
      y:
        basis.origin.y +
        basis.u.y * regionHandle.samplePoint.x +
        basis.v.y * regionHandle.samplePoint.y,
      z:
        basis.origin.z +
        basis.u.z * regionHandle.samplePoint.x +
        basis.v.z * regionHandle.samplePoint.y
    };
    const rig = buildOffsetFaceHandle({
      origin,
      direction: basis.normal,
      ghostGeometry
    });
    rig.setValue(regionHandle.initialValue ?? 0);
    context.scene.add(rig.group);
    context.scene.add(rig.worldGroup);
    offsetRigRef.current = rig;
    context.requestRender();
    return () => {
      if (mesh) {
        mesh.userData.regionSelected = false;
        mesh.material.userData.targetOpacity = 0;
        context.fadeIns.add(mesh.material);
      }
      if (!offsetDragActiveRef.current) {
        rig.dispose();
        if (offsetRigRef.current === rig) {
          offsetRigRef.current = null;
        }
      }
      context.requestRender();
    };
  }, [regionHandle, sketchViews]);

  // In-viewport sketch mode lifecycle: build the plane rig, glide the camera
  // head-on, and recede the solids; restore everything on exit. Keyed on the
  // basis object identity so drawing/object updates do not re-enter.
  const sketchBasis = sketchMode?.basis ?? null;
  useEffect(() => {
    const context = contextRef.current;
    if (!context || !sketchBasis) {
      return;
    }
    const rig = buildSketchModeRig(sketchBasis, context.fatLineResolution);
    context.scene.add(rig.group);
    sketchRigRef.current = rig;
    sketchGestureRef.current = {
      chainAnchor: null,
      dragStart: null,
      arcCenter: null,
      arcStart: null,
      circleFirst: null,
      circleSecond: null,
      awaitingSecondPoint: false,
      pointerId: null,
      moved: false
    };
    // Save the pose to restore, then glide head-on to the plane.
    const returnPose = {
      position: context.camera.position.clone(),
      target: context.controls.target.clone(),
      projection: context.projection
    };
    sketchReturnRef.current = returnPose;
    const origin = new THREE.Vector3(
      sketchBasis.origin.x,
      sketchBasis.origin.y,
      sketchBasis.origin.z
    );
    const distance = Math.max(context.camera.position.distanceTo(origin), 40);
    const pose = sketchEntryPose(sketchBasis, distance);
    context.controls.enableRotate = false;
    context.startCameraTween(
      {
        position: new THREE.Vector3(
          pose.position.x,
          pose.position.y,
          pose.position.z
        ),
        target: new THREE.Vector3(pose.target.x, pose.target.y, pose.target.z),
        near: context.camera.near,
        far: context.camera.far
      },
      () => {
        context.applyProjection('orthographic');
        context.syncOrthographic(true);
      }
    );
    context.requestRender();
    return () => {
      rig.dispose();
      if (sketchRigRef.current === rig) {
        sketchRigRef.current = null;
      }
      const label = sketchDimLabelRef.current;
      if (label) {
        label.hidden = true;
      }
      const marker = sketchSnapMarkerRef.current;
      if (marker) {
        marker.hidden = true;
      }
      const centerTarget = sketchCenterTargetRef.current;
      if (centerTarget) {
        centerTarget.hidden = true;
      }
      context.controls.enableRotate = true;
      const saved = sketchReturnRef.current;
      sketchReturnRef.current = null;
      if (saved) {
        context.applyProjection(saved.projection);
        context.startCameraTween({
          position: saved.position,
          target: saved.target,
          near: context.camera.near,
          far: context.camera.far
        });
      }
      context.requestRender();
    };
  }, [sketchBasis]);

  // Solids recede while sketching so the plane reads as the work surface.
  // Re-applied after every body rebuild (each entity commit resyncs).
  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }
    const active = sketchMode !== null;
    context.bodyGroup.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) {
        return;
      }
      const material = child.material as THREE.MeshStandardMaterial;
      const stored = child.userData as {
        sketchRecede?: { opacity: number; transparent: boolean };
      };
      if (active) {
        if (!stored.sketchRecede) {
          stored.sketchRecede = {
            opacity: material.opacity,
            transparent: material.transparent
          };
        }
        material.transparent = true;
        material.opacity = 0.35;
      } else if (stored.sketchRecede) {
        material.opacity = stored.sketchRecede.opacity;
        material.transparent = stored.sketchRecede.transparent;
        delete stored.sketchRecede;
      }
    });
    context.requestRender();
  }, [sketchMode, bodies]);

  // Committed sketch entities re-render after every entity commit.
  useEffect(() => {
    const context = contextRef.current;
    const rig = sketchRigRef.current;
    if (!context || !rig || !sketchMode) {
      snapTargetsRef.current = [];
      return;
    }
    const resolve = (value: unknown) =>
      evalParamValue(value as ParamValue, sketchMode.parameterScope) ?? 0;
    rig.setObjects(sketchMode.objects, sketchMode.selectedObjectId, resolve);
    rig.setProfiles(sketchMode.profiles, true);
    rig.setDiagnostics(sketchMode.diagnosticPoints);
    try {
      snapTargetsRef.current = collectSketchSnapTargets(
        sketchMode.objects,
        resolve
      );
    } catch {
      snapTargetsRef.current = [
        { id: 'sketch-origin', x: 0, y: 0, kind: 'origin' }
      ];
    }
    context.requestRender();
  }, [sketchMode]);

  // Escape ends the line chain: clear the local anchor when the machine says
  // drawing stopped.
  useEffect(() => {
    if (sketchMode && !sketchMode.drawing) {
      const gesture = sketchGestureRef.current;
      gesture.chainAnchor = null;
      gesture.dragStart = null;
      gesture.arcCenter = null;
      gesture.arcStart = null;
      gesture.circleFirst = null;
      gesture.circleSecond = null;
      gesture.awaitingSecondPoint = false;
      sketchRigRef.current?.setInProgress(null, false);
      sketchRigRef.current?.setInference(null);
      const label = sketchDimLabelRef.current;
      if (label) {
        label.hidden = true;
      }
      const marker = sketchSnapMarkerRef.current;
      if (marker) {
        marker.hidden = true;
      }
      const centerTarget = sketchCenterTargetRef.current;
      if (centerTarget) {
        centerTarget.hidden = true;
      }
      contextRef.current?.requestRender();
    }
  }, [sketchMode]);

  // Sketch profiles render as line loops on their planes so upcoming
  // extrudes/revolves are visible before they exist.
  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }
    clearGroup(context.sketchGroup);
    const firstClassSketchIds = new Set(
      sketchViews.map((view) => view.sketchId)
    );
    for (const sketch of sketches) {
      if (firstClassSketchIds.has(sketch.sketchId)) {
        continue;
      }
      if (sketch.points.length < 2) {
        continue;
      }
      const profileGeometry = new THREE.BufferGeometry();
      profileGeometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
          sketch.points.flatMap((point) => [point.x, point.y, point.z]),
          3
        )
      );
      profileGeometry.setIndex(
        THREE.ShapeUtils.triangulateShape(
          sketch.profile.map((point) => new THREE.Vector2(point.x, point.y)),
          []
        ).flat()
      );
      const profileFill = new THREE.Mesh(
        profileGeometry,
        new THREE.MeshBasicMaterial({
          color: sketch.selected ? 0x4da3ff : 0x2f6ea8,
          transparent: true,
          opacity: sketch.selected ? 0.3 : 0.1,
          side: THREE.DoubleSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1
        })
      );
      profileFill.userData.sketchId = sketch.sketchId;
      profileFill.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_FILL;
      context.sketchGroup.add(profileFill);

      const line = createFatLine(
        sketch.points.map(
          (point) => new THREE.Vector3(point.x, point.y, point.z)
        ),
        {
          color: sketch.selected ? SKETCH_SELECTED_COLOR : SKETCH_COLOR,
          linewidth: SKETCH_CURVE_WIDTH,
          opacity: sketch.selected ? 1 : 0.5,
          closed: true,
          resolution: context.fatLineResolution()
        }
      );
      line.name = 'sketch-curve';
      line.raycast = () => undefined;
      line.renderOrder = sketch.selected
        ? VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY
        : VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
      context.sketchGroup.add(line);

      if (sketch.selected) {
        const centroid = new THREE.Vector3();
        for (const point of sketch.points) {
          centroid.add(new THREE.Vector3(point.x, point.y, point.z));
        }
        centroid.divideScalar(sketch.points.length);
        const label = makeLabel(
          'selection-callout sketch-callout',
          sketch.name
        );
        label.position.copy(centroid);
        context.sketchGroup.add(label);
      }
    }

    if (
      bodies.length === 0 &&
      !context.hasFitCamera &&
      context.sketchGroup.children.length > 0
    ) {
      fitCameraToObjects(
        context.camera,
        context.controls.target,
        context.sketchGroup.children
      );
      context.controls.update();
      context.hasFitCamera = true;
      onViewChangeRef.current(context.captureView());
    }
    context.requestRender();
  }, [bodies.length, sketches, sketchViews]);

  // Direct extrusion stays an ephemeral viewport preview until the user
  // confirms, keeping document history as the only durable modeling truth.
  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }
    clearGroup(context.gizmoGroup);
    context.requestRender();
    if (!extrudePreview) {
      return;
    }
    const view = sketchViews.find(
      (candidate) => candidate.sketchId === extrudePreview.sketchId
    );
    const selectedRegions =
      view?.regions.filter((region) =>
        selectedProfileIds.includes(region.profileId)
      ) ?? [];
    const sketch = sketches.find(
      (candidate) => candidate.sketchId === extrudePreview.sketchId
    );
    if (selectedRegions.length === 0 && (!sketch || sketch.points.length < 3)) {
      return;
    }

    const normal = view
      ? new THREE.Vector3(
          view.basis.normal.x,
          view.basis.normal.y,
          view.basis.normal.z
        ).normalize()
      : new THREE.Vector3(
          sketch!.normal.x,
          sketch!.normal.y,
          sketch!.normal.z
        ).normalize();
    const totalArea = selectedRegions.reduce(
      (total, region) => total + region.area,
      0
    );
    const localCentroid =
      selectedRegions.length > 0 && totalArea > 0
        ? selectedRegions.reduce(
            (total, region) => ({
              x: total.x + region.centroid.x * region.area,
              y: total.y + region.centroid.y * region.area
            }),
            { x: 0, y: 0 }
          )
        : null;
    if (localCentroid && totalArea > 0) {
      localCentroid.x /= totalArea;
      localCentroid.y /= totalArea;
    }
    const centroid =
      view && localCentroid
        ? new THREE.Vector3(
            view.basis.origin.x +
              view.basis.u.x * localCentroid.x +
              view.basis.v.x * localCentroid.y,
            view.basis.origin.y +
              view.basis.u.y * localCentroid.x +
              view.basis.v.y * localCentroid.y,
            view.basis.origin.z +
              view.basis.u.z * localCentroid.x +
              view.basis.v.z * localCentroid.y
          )
        : sketchCentroid(sketch!);
    const distance = extrudePreview.distance;

    // First-class profiles are previewed by the exact worker-backed body.
    // Retain the compatibility mesh only for legacy one-object sketches.
    if (selectedRegions.length === 0 && sketch && Math.abs(distance) >= 0.01) {
      const previewGeometry = createExtrudePreviewGeometry(sketch, distance);
      const previewMesh = new THREE.Mesh(
        previewGeometry,
        new THREE.MeshStandardMaterial({
          color: 0x4da3ff,
          emissive: 0x102f54,
          transparent: true,
          opacity: 0.36,
          roughness: 0.5,
          metalness: 0.05,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      );
      previewMesh.raycast = () => undefined;
      context.gizmoGroup.add(previewMesh);
      const previewFeatureEdges = new THREE.EdgesGeometry(previewGeometry, 25);
      const previewEdges = createFatLineSegments(
        previewFeatureEdges.getAttribute('position').array,
        {
          color: 0x8fc8ff,
          linewidth: PREVIEW_EDGE_WIDTH,
          opacity: 0.9,
          resolution: context.fatLineResolution()
        }
      );
      previewFeatureEdges.dispose();
      previewEdges.raycast = () => undefined;
      context.gizmoGroup.add(previewEdges);
    }

    const activeDirection = distance < 0 ? normal.clone().negate() : normal;
    // Keep the handle head outside the translucent preview so it remains an
    // obvious drag target even after the solid grows past the sketch plane.
    const activeLength = Math.max(Math.abs(distance) + 7, 13);
    const activeArrow = new THREE.ArrowHelper(
      activeDirection,
      centroid,
      activeLength,
      0x4da3ff,
      Math.min(4, activeLength * 0.32),
      2.2
    );
    markExtrudeGizmo(activeArrow);
    context.gizmoGroup.add(activeArrow);

    const oppositeArrow = new THREE.ArrowHelper(
      activeDirection.clone().negate(),
      centroid,
      distance === 0 ? activeLength : 8,
      distance === 0 ? 0x4da3ff : 0x365779,
      3,
      1.8
    );
    markExtrudeGizmo(oppositeArrow);
    context.gizmoGroup.add(oppositeArrow);

    const hitLength = Math.max(activeLength * 2.4, 52);
    const hitTarget = new THREE.Mesh(
      new THREE.CylinderGeometry(2.8, 2.8, hitLength, 10),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false
      })
    );
    hitTarget.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    hitTarget.position.copy(centroid);
    hitTarget.userData.extrudeGizmo = true;
    hitTarget.userData.extrudeOrigin = centroid.toArray();
    hitTarget.userData.extrudeNormal = normal.toArray();
    context.gizmoGroup.add(hitTarget);

    const valuePosition = centroid
      .clone()
      .addScaledVector(activeDirection, activeLength + 3);
    const valueLabel = makeLabel(
      'selection-callout extrude-value-callout',
      distance === 0
        ? 'Drag either direction'
        : `${distance > 0 ? '+' : ''}${Math.round(distance * 10) / 10} ${units}`
    );
    valueLabel.position.copy(valuePosition);
    context.gizmoGroup.add(valueLabel);
  }, [extrudePreview, selectedProfileIds, sketches, sketchViews, units]);

  useEffect(() => {
    const context = contextRef.current;
    if (context) {
      context.grid.visible = settings.showGrid;
      context.shadowCatcher.visible = shouldShowGroundShadow(
        context.activeCamera,
        settings.showGrid
      );
      applyDisplayMode(context.bodyGroup, settings.displayMode);
      for (const edgeOverlay of context.edgeOverlaysByBodyId.values()) {
        edgeOverlay.setDisplayMode(settings.displayMode);
      }
      context.requestRender();
    }
  }, [settings.showGrid, settings.displayMode]);

  useEffect(() => {
    const context = contextRef.current;
    if (
      !context ||
      fitSignal === 0 ||
      context.bodyGroup.children.length === 0
    ) {
      return;
    }
    const pose = computeFitPose(context.camera, context.bodyGroup.children);
    context.startCameraTween(pose, () => {
      if (context.projection === 'orthographic') {
        context.syncOrthographic(true);
      }
    });
  }, [fitSignal]);

  // View requests keep the current zoom and glide the camera to the axis —
  // named standard views and the cube's corner diagonals alike.
  useEffect(() => {
    const context = contextRef.current;
    if (!context || !viewRequest) {
      return;
    }
    const { camera, controls } = context;
    const distance = Math.max(camera.position.distanceTo(controls.target), 1);
    const direction = viewDirectionFor(viewRequest.view);
    context.startCameraTween({
      position: controls.target.clone().addScaledVector(direction, distance),
      target: controls.target.clone(),
      near: camera.near,
      far: camera.far
    });
  }, [viewRequest]);

  // The view-cube arrows swing the camera a quarter turn around the world up
  // axis. In a head-on top or bottom view the orbit offset is only the tiny
  // nudge VIEW_DIRECTIONS keeps off the pole, so the same quarter turn reads
  // as the drawing spinning in place — which is what the arrows should do
  // there.
  useEffect(() => {
    const context = contextRef.current;
    if (!context || !rotateRequest) {
      return;
    }
    const { camera, controls } = context;
    // `direction` names the way the model appears to turn on screen, so the
    // camera swings the opposite way: model clockwise = camera counterclockwise.
    const angle = rotateRequest.direction === 'cw' ? Math.PI / 2 : -Math.PI / 2;
    const offset = camera.position
      .clone()
      .sub(controls.target)
      .applyAxisAngle(new THREE.Vector3(0, 0, 1), angle);
    context.startCameraTween({
      position: controls.target.clone().add(offset),
      target: controls.target.clone(),
      near: camera.near,
      far: camera.far
    });
  }, [rotateRequest]);

  return <div className="viewer-host" ref={hostRef} />;
}
