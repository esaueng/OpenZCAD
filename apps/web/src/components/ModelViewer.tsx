import type { ParameterVisualPreview } from '../lib/parameterVisualPreview';
import { ParameterPreviewController } from './viewer/parameterPreviewController';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject
} from 'react';
import { axisDimensionLabel } from '../lib/primitiveDimensionLabel';
import * as THREE from 'three';
import {
  framePlaneHit,
  meshNormal,
  placementFrame,
  principalFrameFor,
  type PlacementFrame
} from '../lib/inPlace/primitives';
import { currentRenderProfile } from './viewer/renderProfile';
import { createdBodiesToFrame, type AutoFrameRequest } from '../lib/autoFrame';
import {
  readDatumColor,
  readStagePalette,
  watchStageTheme
} from '../lib/stagePalette';
import { mark, measure, timed } from '../lib/perf';
import { recordEditPhase } from '../lib/editTrace';
import {
  avoidSketchDimensionOverlays,
  buildSketchDimensions
} from './viewer/sketchDimensions';
import { buildSketchRelationGlyphs } from './viewer/sketchRelations';
import type { SketchRelationGlyphChip } from '../lib/sketch/relationGlyphs';
import type { SketchDimensionAnnotation } from '../lib/sketch/dimensionAnnotations';
import type {
  BoundaryProvenance,
  SketchComposite,
  SketchDimensionIdentity
} from '@openzcad/shared';
import {
  disposeRetiringOverlays,
  disposeSettledOverlays,
  retireOverlay,
  type RetiringOverlay
} from '../lib/retiringOverlays';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import {
  CSS2DObject,
  CSS2DRenderer
} from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  HoverDwell,
  MOVE_AXIS_COLORS,
  MOVE_AXIS_VECTORS,
  RightClickGestureTracker,
  viewDirectionFor,
  applyDisplayMode,
  applySectionPlane,
  exactSectionSnapshot,
  sectionClippingPlane,
  CameraController,
  ANGLE_RIG_KIND,
  buildAngleHandle,
  buildLinearHandle,
  buildCylinderRadiusHandle,
  buildEdgeRadiusHandle,
  buildOffsetFaceHandle,
  faceSweepProfile,
  bodiesInBox,
  topologyInBox,
  boxSelectMode,
  cycleDepthPick,
  resolveSnap,
  translationToSnap,
  snapsFromEdges,
  SNAP_LABELS,
  SNAP_RADIUS_PX,
  isBoxSelectDrag,
  BOX_SELECT_MIN_PX,
  rectFromDrag,
  edgeRunSelections,
  edgeHandlePlacement,
  offsetHandlePlacement,
  screenDragAxis,
  screenDragValue,
  type ScreenDragAxis,
  GestureRouter,
  HudLayer,
  TopologyPickList,
  PickService,
  SelectionManager,
  animationStepSeconds,
  applyMoveGizmoFocus,
  buildMoveGizmoParts,
  chooseMoveSnapStep,
  chooseRotateSnapStep,
  chooseViewportScale,
  scaleBarAnchor,
  presentedBoundsCenter,
  clearGroup,
  closestAxisT,
  composeMoveTransform,
  boxFullyInView,
  computeFitPose,
  computeNormalToFacePose,
  cylinderRadiusPreviewMatrix,
  createCylinderProfilePreview,
  createLinearProfilePreview,
  createStepStretchPreview,
  createBodyGhost,
  type BodyGhost,
  type LinearPreviewProfile,
  type StepPreviewProfile,
  type CylinderPreviewProfile,
  type CylinderProfilePreview,
  faceTrianglesCentroid,
  createBodyEdgeOverlay,
  createAnalyticCylinderGhost,
  createFaceHighlightGeometry,
  createAxesGizmo,
  createDimensionGraphic,
  createFatLine,
  measureSnapEdges,
  createFatLineMaterial,
  applyStagePalette,
  createGradientBackdrop,
  createObjectForBody,
  updateObjectForBody,
  updateBodyMaterialOpacity,
  sameBodyProjection,
  sameBodyRenderGeometry,
  sameBodyPickingTopology,
  reuseRenderBodies,
  disposeObject,
  keepProgram,
  createShadowCatcher,
  createStudioEnvironment,
  createStudioGrid,
  createStudioHemisphereLight,
  dimensionLabelLayout,
  directEditDirectionFromNormal,
  fitCameraToObjects,
  forEachMesh,
  isViewerMesh,
  isSameMoveGizmoFocus,
  layoutMeasurementCallouts,
  makeLabel,
  moveCalloutAnchor,
  moveEuler,
  moveGizmoHandleLabel,
  moveGizmoWorldScale,
  normalForTriangle,
  projectToScreen,
  projectedWorldSizePx,
  shouldShowGroundShadow,
  snapTo,
  syncFatLineResolution,
  updateAxesGizmo,
  updateStudioGrid,
  tuneShadowFrustum,
  VIEWPORT_RENDER_ORDER,
  DrawnBodyReport,
  MoveCopyPreview,
  type AxisProjection,
  type CameraPose,
  type ExactSectionRegionDisplay,
  type DirectEditAxis,
  type MoveAxis,
  type MoveGizmoFocus,
  type MoveGizmoVisualData,
  type MoveHandleKind,
  type MovePreview,
  type DepthCycle,
  type DragRig,
  type MoveSnap,
  type ViewportScale,
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
  type ViewRequestTarget,
  type ViewerBodyMaterial,
  type ViewerSettings,
  type FatLineResolution,
  type BodyEdgeOverlay,
  type CalloutBounds,
  type CalloutLayoutItem,
  type DimensionGraphic,
  SELECTION_SEMANTICS,
  contextBodyColor,
  selectedFaceColor,
  SKETCH_GLIDE_MS,
  sketchGlideEase,
  viewJumpEase,
  type AngleRigParams,
  type CameraGlideStyle,
  type HandleVec3,
  type WheelDevice
} from '@openzcad/viewport';
import {
  UNIT_TO_MM,
  VIEWPORT_FIELD_OF_VIEW_BOUNDS,
  XRAY_OPACITY_BOUNDS,
  displayLengthName,
  type GeometryBodyRepresentation,
  type FaceGeometry,
  type TopologySelection,
  type UnitSystem
} from '@openzcad/shared';
import { formatNumber } from '../lib/model';
import { isBehindCamera } from '../lib/cameraDepth';
import {
  chipPanelDodge,
  edgeChipCenterX,
  faceOffsetChipState,
  offsetChipText,
  rearmedChipMode,
  regionChipState,
  type OffsetChipMode
} from '../lib/offsetChip';
import { faceDepthBehind, faceLift } from '../lib/faceDepthBehind';
import { setLiveDiameter } from '../lib/liveLabels';
import type { SelectionCalloutContent } from '../lib/selectionCallout';
import {
  placeSelectionCallouts,
  refreshSelectionCallout,
  renderSelectionCallout,
  MODEL_PANEL_OBSTACLES,
  RIGHT_LANE_MODEL_PANELS,
  SELECTION_CALLOUT_CHIP_CLASS
} from '../lib/selectionCalloutView';
import {
  measureFitFrame,
  measurePickFrame,
  shiftIntoFrame
} from '../lib/fitFrame';
import type { DimensionMode } from '../lib/keypad';
import type { ViewportCameraState } from '../lib/workspaceSession';
import type { MeasurementViewportAnnotation } from '../lib/measurements';
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
  curvePreviewPoints,
  ellipseObjectFromPoints,
  ellipticalArcObject,
  splineClickAction,
  splineObjectFromPoints,
  centerInferenceSegments,
  collectSketchSnapTargets,
  SketchSnapLimitError,
  angleForInProgress,
  dimensionForInProgress,
  lineObjectFromPoints,
  nearestCenterGuideTarget,
  placeSketchObjectGrabPoint,
  sketchObjectGrabbedAlongCurve,
  sketchObjectGrabPoint,
  sketchObjectMovable,
  sketchObjectRotatable,
  snapTargetsForObject,
  sketchMoveChanged,
  sketchHandleAtScreen,
  rebaseSketchMove,
  SketchMovePointerGate,
  sketchMovePointerRole,
  rotateTextObject,
  textRotationFromRingDrag,
  translateSketchObject,
  pointAtDistanceAlongDirection,
  resolveSketchSnap,
  screenRayToPlanePoint,
  SKETCH_SNAP_GLYPHS,
  SKETCH_SNAP_LABELS,
  sketchEntryPose,
  sketchEntryUp,
  sketchObjectFromDrag,
  snapSketchPoint,
  type SketchPoint,
  type SnapTarget,
  type SnapTargetKind,
  type UnreferencedSnap
} from '../lib/sketch/session';
import {
  canPlaceTextDraft,
  textDraftPlaceable,
  textObjectFromPoint
} from '../lib/sketch/textPlacement';
import {
  sketchCurveModeFor,
  type InteractionEvent,
  type SketchCircleMode,
  type SketchCurveMode,
  type SketchMoveHandle,
  type SketchRectangleMode,
  type SketchTextDraft,
  type SketchToolId
} from '../lib/interaction/machine';
import {
  compositeSizeLabel,
  dragCompositeShape,
  inscribedPolygonShape,
  isCompositeShape,
  threePointRectangleShape,
  typedRectangleShape,
  type CompositeShape
} from '../lib/sketch/composites';

/** The machine events a sketch object drag reports. */
type SketchMoveEvent = Extract<
  InteractionEvent,
  { type: 'sketch-move-start' | 'sketch-move-commit' | 'sketch-move-cancel' }
>;
import type { PlaneBasis } from '@openzcad/geometry';
import type { PlaneId, SketchObjectData, Vector3 } from '@openzcad/shared';
import { buildPlanePickerRig } from './viewer/planePickerRig';
import {
  buildAxisPickerRig,
  type AxisPickerCandidate
} from './viewer/axisPickerRig';
import {
  buildCurvePickerRig,
  type CurvePickerCandidate
} from './viewer/curvePickerRig';
import {
  buildDatumPlaneRig,
  type DatumPlaneRig,
  type DatumPlaneRigInput
} from './viewer/datumPlaneRig';
import {
  buildDatumAxisRig,
  type DatumAxisRig,
  type DatumAxisRigInput
} from './viewer/datumAxisRig';
import type { DatumPlaneDisplay } from '../lib/datumPlaneDisplay';
import type { ReferenceImageDisplay } from '../lib/referenceImageDisplay';
import {
  buildReferenceImageRig,
  ReferenceTextureCache,
  type ReferenceTextureRequest
} from './viewer/referenceImageRig';
import type { DatumAxisDisplay } from '../lib/datumAxisDisplay';
import {
  requiredValueResolver,
  sketchValueResolver
} from '../lib/sketch/valueResolver';
import { reducesMotion } from '../lib/reducedMotion';
import { traceFaceDrag } from '../lib/faceDragTrace';
import {
  IMAGE_UNSELECTED_STYLE,
  renderViewportImage,
  viewportImageMaxSide,
  type ViewportImageSource
} from './viewer/viewportImage';
import {
  readWheelDeviceMemory,
  writeWheelDeviceMemory
} from '../lib/wheelDeviceMemory';
import {
  textLabelSegments,
  topologySelectionLabel,
  topologySelectionLabelSegments,
  type LabelSegment
} from '../lib/topologyLabels';

/**
 * What makes two hover picks "the same target" for the dwell: the topology
 * or region under the pointer, never the hit point, so a pointer sliding
 * along one face keeps its highlight while a boundary flicker is absorbed.
 */
function hoverKeyOf(candidate: PickCandidate | null): string | null {
  if (!candidate) {
    return null;
  }
  const selection = candidate.selection;
  return [
    candidate.kind,
    selection?.bodyId ?? '',
    selection?.topologyId ?? '',
    candidate.sketchId ?? '',
    candidate.region?.profileId ?? '',
    candidate.region?.regionFingerprint ?? ''
  ].join(':');
}

export interface FaceResizeCommit {
  bodyId: TopologySelection['bodyId'];
  axis: DirectEditAxis;
  value: number;
}

/** An armed face-offset handle: where it sits and which face it edits. */
export interface OffsetHandleTarget {
  linearProfilePreview?: LinearPreviewProfile;
  stepProfilePreview?: StepPreviewProfile;
  profilePreview?: CylinderPreviewProfile;
  bodyId: string;
  topologyId: string;
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  /** Restored after a failed exact-kernel validation. */
  initialValue?: number;
  /** Primitive height when this offset is really an overall-height edit. */
  totalBaseline?: number;
  /** -1 when a drag along the handle subtracts from that total; default +1. */
  totalSense?: 1 | -1;
  /**
   * The released value is being validated: the handle stays where it was
   * let go, but cannot be grabbed until the edit commits or is refused.
   */
  locked?: boolean;
  /**
   * A value is being typed on the keypad. The typed value drives the handle,
   * its ghost and the drag preview; exact frames landing meanwhile re-derive
   * this target without replacing any of them.
   */
  entry?: boolean;
}

/**
 * The handle's value runs along its own normal, which a pick can report
 * facing either way; the step profile's runs along the face's outward normal.
 */
function orientedStepPreview(
  object: THREE.Object3D,
  profile: StepPreviewProfile,
  handleNormal: { x: number; y: number; z: number }
): CylinderProfilePreview | null {
  const preview = createStepStretchPreview(object, profile);
  if (!preview) return null;
  const sense =
    profile.normal.x * handleNormal.x +
      profile.normal.y * handleNormal.y +
      profile.normal.z * handleNormal.z >=
    0
      ? 1
      : -1;
  return {
    cachedBytes: preview.cachedBytes,
    apply: (offset) => preview.apply(sense * offset),
    restore: () => preview.restore()
  };
}

/** An explicit cylindrical-wall radius handle with an immutable world axis. */
export interface CylinderRadiusHandleTarget {
  profilePreview?: CylinderPreviewProfile;
  bodyId: string;
  topologyId: string;
  point: { x: number; y: number; z: number };
  radialDirection: { x: number; y: number; z: number };
  axisStart: { x: number; y: number; z: number };
  axisEnd: { x: number; y: number; z: number };
  originalRadius: number;
  /** True when a radial scene transform exactly represents this body. */
  smoothPreview: boolean;
  /**
   * The released radius is being validated: the handle stays where it was
   * let go, but cannot be grabbed until the edit commits or is refused.
   */
  locked?: boolean;
}

interface VisualProxyController {
  /** Restore the authoritative projection after cancellation or validation failure. */
  restore(): void;
  /** Forget a proxy whose object is about to be replaced by exact geometry. */
  discard(): void;
}

/** Active in-viewport sketch session, derived from the interaction machine. */
/**
 * What the sketch-entry camera glide should frame: the attached face's
 * display triangles, or the world-space bounds of the sketch's committed
 * content on re-entry. Null keeps the pre-framing behavior (orient head-on
 * at the current distance) — a fresh sketch on a canonical plane has nothing
 * to frame.
 */
export type SketchEntryFrame =
  | {
      kind: 'face';
      bodyId: string;
      faceHash: number;
      center: { x: number; y: number; z: number };
    }
  | { kind: 'content'; points: { x: number; y: number; z: number }[] };

export interface SketchModeState {
  basis: PlaneBasis;
  frame: SketchEntryFrame | null;
  tool: SketchToolId;
  circleMode: SketchCircleMode;
  /** The curve slot's type (I01), for the ellipse and spline tools. */
  curveMode?: SketchCurveMode;
  /** The Rectangle tool's type. */
  rectangleMode: SketchRectangleMode;
  /** The Polygon tool's side count. */
  polygonSides: number;
  snapStep: number | null;
  gridVisible: boolean;
  geometrySnapEnabled: boolean;
  inferenceEnabled: boolean;
  snapTolerancePx: number;
  /** True while a line chain (or drag) is in flight; cleared by Escape. */
  drawing: boolean;
  /** Committed objects of the session's sketch, rendered in blue. */
  objects: { id: string; data: SketchObjectData }[];
  /** Held-line shape identities qualify names without changing solver picks. */
  composites?: readonly SketchComposite[];
  profiles: { outer: SketchPoint[]; holes: SketchPoint[][] }[];
  selectedObjectId: string | null;
  parameterScope: Record<string, number>;
  units?: UnitSystem;
  /** Plane-local endpoints highlighted by Profile diagnostics on request. */
  diagnosticPoints: { x: number; y: number }[];
  /** Solver-named entities with a measured non-zero residual. */
  constraintDiagnosticObjectIds: string[];
  /**
   * Entities proved fully defined by a zero-DOF solve: every object id, or
   * empty. Sketch-wide by solver-evidence design (the kernel reports one
   * DOF scalar, no per-entity freedom).
   */
  definedObjectIds: string[];
  textOutlineBudgetError?: string | null;
  dimensions: SketchDimensionAnnotation[];
  /** Relation glyph chips, already filtered by the visibility setting. */
  relations?: SketchRelationGlyphChip[];
  /** The drawn curves as plane-local segments; glyphs keep clear of them. */
  relationStrokes?: Float64Array;
  /** Every pickable sketch point as plane-local pairs; glyphs keep off. */
  relationKeepOuts?: Float64Array;
  /**
   * The text card's draft while the text tool composes. Its outline follows
   * the pointer over the plane and a click places it; nothing is placed
   * while the string is empty.
   */
  textDraft?: SketchTextDraft | null;
  /**
   * Why the draft cannot be placed under the text budget, evaluated on the
   * document with the draft and undo history included — what the card
   * shows and the commit asserts. A refused draft draws no outline.
   */
  textDraftBudgetError?: string | null;
  /** A solve or rebuild owns the sketch: the card is disabled, so is a click. */
  textDraftBusy?: boolean;
}

/** A held drag of the selected sketch object (see `sketchMoveRef`). */
interface SketchMoveDrag {
  pointerId: number;
  objectId: string;
  handle: SketchMoveHandle;
  /** The stored data at press time; Escape and a refusal restore it. */
  original: SketchObjectData;
  /**
   * The sketch point that follows the pointer: the object's grab point, or
   * where a line or arc was pressed; for rotation, the press on the ring.
   */
  grab: SketchPoint;
  /** True when `grab` is the object's own grab point and lands exactly. */
  anchored: boolean;
  /** The text origin a rotation turns about. */
  origin: SketchPoint;
  startRotation: number;
  /** Snap candidates from every other object: an object never snaps to itself. */
  targets: SnapTarget[];
  /** The latest moved data, drawn in place of the stored object. */
  preview: SketchObjectData | null;
  /** False until the press travels past the click threshold. */
  active: boolean;
}

/** Evaluates a sketch value in the session's parameter scope. */
function sketchModeResolver(mode: SketchModeState) {
  return sketchValueResolver(mode.parameterScope, mode.units ?? 'mm');
}

/**
 * Draws the session's committed objects, with one object drawn somewhere
 * else while a drag previews it. The full rebuild runs only when the
 * session changes; per-frame drag updates go to `setPreviewObject` alone.
 */
function drawSketchModeObjects(
  rig: SketchModeRig,
  mode: SketchModeState,
  override: { objectId: string; data: SketchObjectData } | null
) {
  rig.setObjects(
    mode.objects,
    mode.selectedObjectId,
    sketchModeResolver(mode),
    mode.constraintDiagnosticObjectIds,
    mode.definedObjectIds,
    mode.textOutlineBudgetError
  );
  if (override) {
    rig.setPreviewObject(override.objectId, override.data);
  }
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

/**
 * One follower arrow of a multi-region extrude: the same pin and swept ghost
 * the armed region rig draws, standing on another selected region.
 */
function buildRegionFollowerRig(
  basis: PlaneBasis,
  region: SketchViewData['regions'][number],
  follower: { samplePoint: { x: number; y: number } }
): DragRig {
  const toWorld = (point: { x: number; y: number }) => ({
    x: basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
    y: basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
    z: basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
  });
  const { positions, indices } = triangulateRegionGeometry(
    region.outer,
    region.holes,
    basis
  );
  return buildOffsetFaceHandle({
    origin: toWorld(follower.samplePoint),
    direction: basis.normal,
    ghostGeometry: null,
    sweep: {
      cap: { positions, indices },
      loops: [region.outer, ...region.holes].map((loop) => loop.map(toWorld))
    }
  });
}

/** U09: one frame of a primitive's footprint drag, in world space. */
export interface FootprintGesture {
  phase: 'move' | 'end';
  /** The plane drawn on: a face's, or a principal plane's. */
  frame: PlacementFrame;
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  /** False for a press that never travelled: a click. */
  moved: boolean;
}

/** U09: one value's handle, as the in-place command hands it over. */
export type CommandHandleView = (
  | {
      kind: 'angle';
      params: Omit<AngleRigParams, 'angleDeg'>;
    }
  | {
      kind: 'linear';
      params: { origin: HandleVec3; direction: HandleVec3 };
    }
  | { kind: 'chip'; params: { anchor: HandleVec3 } }
) & {
  valueId: string;
  key: string;
  value: number;
  min?: number;
  max?: number;
  /** What the chip shows for a value: "R 12 mm", "270°", "3 turns". */
  format(value: number): string;
};

const EMPTY_COMMAND_HANDLES: readonly CommandHandleView[] = [];
/** How far inside the canvas edge a command chip is kept, in CSS pixels. */
const COMMAND_CHIP_MARGIN_PX = 12;

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
    sourceBoundaryLoops?: BoundaryProvenance;
    area: number;
    outer: { x: number; y: number }[];
    holes: { x: number; y: number }[][];
    /**
     * Shared by every region one entity-wide source supplies (the glyphs of
     * one text object). They are built together, so hovering one lights all.
     */
    buildGroup?: string;
  }[];
}

/** An armed region-extrude handle (drag a detected region into a solid). */
export interface RegionHandleTarget {
  sketchId: string;
  regionFingerprint: number;
  samplePoint: { x: number; y: number };
  area: number;
  initialValue?: number;
  /**
   * The other selected regions of the same sketch. Each draws its own arrow
   * that follows this one's value, and dragging any of them drives them all.
   */
  followers?: {
    regionFingerprint: number;
    samplePoint: { x: number; y: number };
  }[];
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
  /** Face-backed fillet edits already have an exact pick/radial frame. */
  placement?: {
    origin: { x: number; y: number; z: number };
    direction: { x: number; y: number; z: number };
  };
  label?: string;
  /** R0 means delete the producing Fillet feature. */
  allowRemoval?: boolean;
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

/** Transient per-body display patch, applied without touching the document. */
export interface BodyAppearancePreview {
  bodyId: string;
  color?: string;
  opacity?: number;
}

/** Runtime-only request to centre and face one exact planar face head-on. */
export interface NormalToFaceRequest {
  bodyId: string;
  topologyId: string;
  /** Makes pressing Space again replay the camera action for the same face. */
  nonce: number;
}

export interface ModelViewerProps {
  parameterVisualPreview?: ParameterVisualPreview | null;
  bodies: GeometryBodyRepresentation[];
  sketches: SketchOverlay[];
  /** Runtime-only View-mode measurements rendered above exact geometry. */
  measurementAnnotations: MeasurementViewportAnnotation[];
  /** Bodies highlighted in the viewport, in pick order. */
  selectedBodyIds: string[];
  selectedTopology: TopologySelection | null;
  /** Exact blend faces created only in the currently published preview. */
  previewFaceHighlights: TopologySelection[];
  /**
   * The faces a History row brings into focus. They are drawn as a selected
   * face is — their own colour, lifted, with the rest receding — where the
   * blend preview above keeps the accent fill of geometry not yet made.
   */
  focusFaces?: readonly TopologySelection[];
  /**
   * What the selection chip anchored to the pick carries besides its name:
   * measurement, verbs, clear. Null leaves the name-only label.
   */
  selectionCallout?: SelectionCalloutContent | null;
  /**
   * Whether the pick wears a label in the viewport at all. Off while the
   * workspace's Selection card names the pick and carries its verbs, so the
   * model shows only the handle and its value. Several picked bodies still
   * wear their pick numbers: those say which body is which, not what to do.
   */
  pickLabel?: boolean;
  /** Consumed bodies a History row brings into focus, drawn as ghosts. */
  focusGhostBodies?: readonly GeometryBodyRepresentation[];
  /** Exact edges highlighted for a single edge-modifier operation. */
  selectedEdges: TopologySelection[];
  /** Select-other popup follows the direct-manipulation experiment gate. */
  pickListEnabled: boolean;
  settings: ViewerSettings;
  /**
   * Kernel-computed section geometry for the plane at rest, drawn in place of
   * the clipped preview's display caps. Null while the plane is moving or
   * while the exact section is still being computed — the approximation owns
   * the drag, so the slider never waits on the kernel.
   */
  exactSection: ExactSectionRegionDisplay[] | null;
  /** Increment to re-fit the camera to the current geometry. */
  fitSignal: number;
  /**
   * A local commit and the exact bodies it published. An independently added
   * body outside the view may be framed; edits preserve the user's camera.
   */
  autoFrame?: AutoFrameRequest | null;
  /** Set to move the camera to a view target; nonce forces re-runs. */
  viewRequest: { view: ViewRequestTarget; nonce: number } | null;
  /** Set to centre and frame an exact planar face; nonce forces re-runs. */
  normalToFaceRequest: NormalToFaceRequest | null;
  units: string;
  /** Primitive box bodies whose planar faces can drive document dimensions. */
  editableBodyIds: string[];
  movePreview: MovePreview | null;
  /**
   * A committed Move whose rebuild is still in flight. The body stays posed
   * at this transform (no gizmo) until new meshes arrive and the hold clears
   * in the same commit.
   */
  moveCommitHold: MovePreview | null;
  /**
   * Drag-phase body appearance patch applied straight to the live material so
   * slider drags stay at pointer rate. The committed value arrives through
   * `bodies` on the next rebuild; null restores the committed look.
   */
  appearancePreview: BodyAppearancePreview | null;
  projection: ProjectionMode;
  /** Per-project camera pose restored before the first automatic fit. */
  initialView: ViewportCameraState | null;
  /** Live camera pose emitted synchronously as navigation changes it. */
  onViewChange(view: ViewportCameraState): void;
  /** Final camera pose emitted after navigation or a camera glide settles. */
  onViewSettled(view: ViewportCameraState): void;
  onGeometryPresented?(durationMs: number): void;
  geometryTrace?: {
    projectId: string;
    version: number;
    analysis: 'pending' | 'ready';
  };
  /**
   * Which bodies this viewer is drawing somewhere other than where the
   * document built them — moved, resized or hidden, by any mechanism.
   *
   * Reported from the frame itself rather than from whatever posed them (see
   * `DrawnBodyReport`), because posing a mesh needs no declaration and the
   * Move gizmo makes none — it writes `object.position` in a pointer handler
   * and no state outside this component knows. The workspace folds this into
   * `ViewportGeometry`, and the exact section refuses on it: a section of a
   * body that is no longer where the plane cuts is a drawing of nothing
   * anybody is looking at.
   */
  onBodiesDrawnElsewhere?(bodyIds: string[]): void;
  /** Scroll-wheel auto-detection just proved a different pointing device. */
  onWheelDeviceLearned?(device: WheelDevice): void;
  /** Imperative sink for per-frame axis projections (no React re-render). */
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  /** Imperative bridge from the SVG view cube into the live camera rig. */
  orientationDragRef: MutableRefObject<OrientationDragControls | null>;
  /** Imperative sink for the zoom-aware scale without React frame updates. */
  scaleIndicatorRef: MutableRefObject<
    ((scale: ViewportScale | null) => void) | null
  >;
  /**
   * Imperative sink for the sketch grid spacing ("5 mm"), or null when no
   * grid is shown. When a host renders one (the viewport dock), the readout
   * lives there and the floating HUD label stays hidden.
   */
  sketchGridReadoutRef?: MutableRefObject<
    ((label: string | null) => void) | null
  >;
  onSelectTopology(
    selection: TopologySelection | null,
    additive: boolean,
    detail?: PickDetail
  ): void;
  /**
   * True while `onSelectTopology` refuses picks: the bodies drawn are worker
   * meshes the document has not committed yet. The e2e select hooks then
   * report no selection instead of one the host dropped.
   */
  topologyPicksHeld?: boolean;
  /** What the pointer is allowed to select. */
  selectionFilter: SelectionFilter;
  /** Bodies swept by a drag rectangle; empty clears the selection. */
  onBoxSelect(bodyIds: string[]): void;
  /**
   * Faces or edges swept by a drag rectangle while the selection filter is
   * Face or Edge; empty clears the selection. Absent, those sweeps take
   * bodies, as every other filter's do.
   */
  onBoxSelectTopology?(
    selections: TopologySelection[],
    kind: 'face' | 'edge'
  ): void;
  /** Perspective field of view, in degrees; orthographic ignores it. */
  fieldOfView?: number;
  /** Face opacity in X-ray (`settings.xray`), 0–1. */
  xrayOpacity?: number;
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
  /** Streamed signed offset; App coalesces exact rebuilds. */
  onOffsetPreview(offset: number, exactGeometry?: boolean): void;
  /** Fired when an offset-handle drag releases with a non-zero offset. */
  onOffsetCommit(offset: number): boolean;
  /** Clears exact preview geometry and restores the original reference. */
  onOffsetCancel(): void;
  /** Current exact preview or release validation refused this offset. */
  offsetPreviewInvalid: boolean;
  /**
   * The live preview gave up on this gesture: the handle still moves, the
   * geometry no longer follows. Shown on the value chip so frozen geometry
   * reads as a decision rather than a hang.
   */
  previewDeferred: boolean;
  /** Value chip tapped: open exact entry prefilled with the current offset. */
  onOpenOffsetKeypad(
    currentOffset: number,
    totalBaseline?: number,
    totalSense?: 1 | -1
  ): boolean;
  /** Imperative sink receiving the chip anchor in host pixels each frame. */
  keypadAnchorRef: MutableRefObject<
    ((point: { x: number; y: number } | null) => void) | null
  >;
  /** Imperative setter letting exact entry drive the handle preview. */
  offsetSetterRef: MutableRefObject<((offset: number) => void) | null>;
  /** Dedicated cylindrical-wall handle; never reuses face translation. */
  cylinderRadiusHandle: CylinderRadiusHandleTarget | null;
  /** Whether the radial handle reads/accepts Ø or R; geometry remains radius. */
  cylinderDimensionMode: DimensionMode;
  onCylinderDimensionModeChange(mode: DimensionMode): void;
  /** Imperative bridge to the React-owned selection readout. */
  cylinderRadiusLabelSetterRef: MutableRefObject<
    ((radius: number | null) => void) | null
  >;
  /** Streamed absolute radius; exact geometry is optional for safe proxies. */
  onCylinderRadiusPreview(radius: number, exactGeometry: boolean): void;
  /** Fired once on release with the absolute radius. */
  onCylinderRadiusCommit(radius: number): boolean;
  /** Clears transient exact geometry without creating history. */
  onCylinderRadiusCancel(): void;
  /** Value chip tapped: open exact entry for the absolute radius. */
  onOpenCylinderRadiusKeypad(
    radius: number,
    dimensionMode: DimensionMode
  ): boolean;
  /** Escape reaches the active imperative pointer session through this ref. */
  cancelDirectManipulationRef: MutableRefObject<(() => boolean) | null>;
  /**
   * Opens exact entry for whichever handle is armed, and reports whether one
   * was. The chip's click does the same thing; this is how the keyboard
   * reaches it, so drag-or-type holds without a pointer.
   */
  openExactEntryRef: MutableRefObject<(() => boolean) | null>;
  /** Armed edge fillet/chamfer handle (selection-first direct manipulation). */
  edgeHandle: EdgeHandleTarget | null;
  /** Streamed while an edge-radius drag is in flight (throttled by App). */
  onEdgeRadiusPreview(size: number): void;
  /** Fired when the radius drag releases (or exact entry commits). */
  onEdgeCommit(size: number): void;
  /** Restores the base document after a canceled/no-op edge-radius gesture. */
  onEdgeCancel(): void;
  /** Edge value chip tapped: open exact entry for the radius/distance. */
  onOpenEdgeKeypad(currentSize: number): boolean;
  /** Semantic lifecycle signal for direct-manipulation drags. */
  onDirectManipulationChange(dragging: boolean, source?: 'move'): void;
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
  /**
   * The Sketch tool is armed and waiting for a plane: show the three ghost
   * quads at the origin so picking one is a click in the model.
   */
  planePickerArmed: boolean;
  /** Distance the ghost quads sit along their normals, as typed in the prompt. */
  planePickerOffset: number;
  /** A ghost plane was clicked, at `point` on it. */
  onPickPlane(plane: PlaneId, point?: Vector3): void;
  /**
   * U09: an in-place command waiting on (or showing) its axis: the lines
   * that can be picked, drawn long and clickable, and the picked one.
   */
  axisPicker?: {
    candidates: readonly AxisPickerCandidate[];
    selectedId: string | null;
  } | null;
  /** An axis line was clicked. */
  onPickAxis?(id: string): void;
  /**
   * U09: an in-place command's handles, one per value. A handle's `key`
   * changes when its rig must be rebuilt (a new profile or axis); its value
   * survives within one key. A `chip` handle has no drag, only its chip.
   */
  commandHandles?: readonly CommandHandleView[];
  /** A handle moved to a new value (drag frames). */
  onCommandHandlePreview?(valueId: string, value: number): void;
  /** A drag let go at this value. */
  onCommandHandleRelease?(valueId: string, value: number): void;
  /** A handle's chip was tapped; true when a keypad opened. */
  onOpenCommandKeypad?(valueId: string, value: number): boolean;
  /** Filled with a setter the keypad uses to move a command handle. */
  commandSetterRef?: MutableRefObject<
    ((valueId: string, value: number) => void) | null
  >;
  /** U09: sketch curves an in-place command can pick (a sweep's path). */
  curvePicker?: {
    candidates: readonly CurvePickerCandidate[];
    selectedIds: readonly string[];
  } | null;
  /** A curve was clicked; Shift asks to add rather than start over. */
  onPickCurve?(id: string, additive: boolean): void;
  /** A datum plane was clicked where nothing in the model was under it. */
  onPickDatum?(featureId: string, point?: Vector3): void;
  /**
   * U09: a plane a click that hits nothing pickable lands on (a picture
   * being placed): the click is reported at the point on it, not as an
   * empty selection.
   */
  placementPlane?: { origin: Vector3; normal: Vector3 } | null;
  onPlacementClick?(point: Vector3): void;
  /**
   * U09: a primitive placed by a press-drag. A press on a flat face of one of
   * `bodyIds` draws on that face's plane, anywhere else on the ground (or
   * the upright principal plane facing the view, when the ground is
   * edge-on). The drag's outline is drawn at once; the exact solid follows.
   */
  footprintPicker?: {
    shape: 'rectangle' | 'circle';
    bodyIds: readonly string[];
    /** The command it belongs to: a new one retires a drag in progress. */
    session: number;
  } | null;
  /** Each frame of a footprint drag, and its release. */
  onFootprint?(gesture: FootprintGesture): void;
  /**
   * Committed R01 datum planes, drawn on the frames the exact build resolved.
   * Hidden, suppressed and unresolved datums are simply absent.
   */
  datumPlanes?: readonly DatumPlaneDisplay[];
  /**
   * Committed R01 datum axes, drawn along the lines the exact build
   * resolved. Hidden, suppressed and unresolved axes are simply absent.
   */
  datumAxes?: readonly DatumAxisDisplay[];
  /**
   * I05 reference images, laid on their planes. Hidden images and images
   * whose plane has not resolved are simply absent.
   */
  referenceImages?: readonly ReferenceImageDisplay[];
  /**
   * The bytes behind a reference image, by checksum: from this device's
   * source store, else the image's archived artifact. Null when neither has
   * them; the image then draws as an empty frame.
   */
  loadReferenceImage?: (checksumSha256: string) => Promise<Blob | null>;
  /**
   * What measuring the hovered target would report, for the preview chip.
   * Null when measuring is off or the pick has nothing honest to say.
   */
  onMeasurePreview?:
    | ((
        selection: TopologySelection,
        point: { x: number; y: number; z: number }
      ) => string | null)
    | null;
  /** Armed region-extrude handle; shares the arrow-rig drag machinery. */
  regionHandle: RegionHandleTarget | null;
  /**
   * F01: a host waiting for a body face (an extrude's to-face target). A
   * click then resolves to the nearest face under the pointer only — never
   * a sketch region, ghost plane or datum drawn in front of it.
   */
  facePickOnly?: boolean;
  /** In-viewport sketch session; null when not sketching. */
  sketchMode: SketchModeState | null;
  /**
   * Where the text card's outline sits on the plane (the baseline origin a
   * click there would place), written as the pointer moves. The card's Place
   * button reads it, so it places exactly what the outline shows.
   */
  sketchTextAnchorRef?: MutableRefObject<SketchPoint | null>;
  /** A drawing gesture completed an entity. */
  onSketchCommit(object: SketchObjectData): void;
  /**
   * A rectangle or polygon gesture completed a composite: lines held by
   * relations and named as one object (S04).
   */
  onSketchCommitComposite(shape: CompositeShape): void;
  onEditSketchDimension(id: string, anchor: { x: number; y: number }): void;
  onMoveSketchDimension(
    identity: SketchDimensionIdentity,
    offset: { x: number; y: number }
  ): void;
  /** A relation glyph was clicked: select that relation. */
  onSelectSketchConstraint?(constraintId: string): void;
  /** The selected relation's glyph started or stopped being drawn. */
  onSketchConstraintSelectionShown?(constraintId: string, shown: boolean): void;
  /** Mirrors chain/drag liveness into the interaction machine. */
  onSketchDrawingChange(drawing: boolean): void;
  /**
   * Whether a press on the selected object's grab point may drag it: false
   * while a pick tool is armed or a solve or rebuild owns the sketch, so the
   * press keeps meaning what it meant before.
   */
  sketchMoveEnabled?: boolean;
  /** Mirrors a sketch object drag's lifecycle into the interaction machine. */
  onSketchMoveChange?(event: SketchMoveEvent): void;
  /**
   * A drag released: commit the dragged object's moved data through the
   * entity-edit path. The object is named rather than read from the
   * selection, so selecting something else before the edit answers does not
   * drop the move. Resolves false when the edit was refused, so the preview
   * can let go.
   */
  onSketchMoveCommit?(
    objectId: string,
    data: SketchObjectData,
    verb: 'Move' | 'Rotate'
  ): Promise<boolean> | boolean;
  /**
   * Selects a committed entity for exact-value editing. Returns true when an
   * armed constraint or modify tool took the click, which then must not also
   * select the region under it.
   */
  onSketchSelectObject(
    objectId: string | null,
    /**
     * The named point under the cursor at click time, when the active snap
     * was one with constraint-schema identity (line/arc endpoints, centers).
     * Constraint picking consumes it; plain selection ignores it.
     */
    snapPoint: {
      objectId: string;
      point: 'start' | 'end' | 'center';
    } | null,
    /** Client-space click used to place a driving-dimension editor. */
    clickPoint: { x: number; y: number },
    /**
     * The click on the sketch plane, unsnapped: where along a curve the
     * click fell, which Trim needs and a snap would move to an end.
     */
    planePoint: { x: number; y: number } | null,
    /**
     * The active snap when it had no constraint-schema identity (a
     * parametric rectangle corner, a midpoint…), so a point-taking tool can
     * say why it refused it.
     */
    unreferencedSnap: UnreferencedSnap | null
  ): boolean | void;
  onSelectSketchProfile(sketchId: string): void;
  onResizePrimitiveFace(commit: FaceResizeCommit): void;
  /**
   * Fired when a move-gizmo drag settles; values are already snapped. Not
   * fired per pointer move — the live stream goes through
   * `moveValuesSetterRef` so a drag does not re-render the workspace.
   */
  onMovePreviewChange(
    translation: MovePreview['translation'],
    rotationDeg: MovePreview['rotationDeg'],
    snap: MoveSnap
  ): void;
  /**
   * Live sink for the values a move drag is producing, owned by the panel
   * that displays them. The scene is already updated imperatively by
   * `applyMovePreview`; this is the same arrangement for the numeric fields,
   * and it is why a drag can run without React work.
   */
  moveValuesSetterRef?: MutableRefObject<
    | ((
        translation: MovePreview['translation'],
        rotationDeg: MovePreview['rotationDeg'],
        snap: MoveSnap
      ) => void)
    | null
  >;
  /**
   * Installed while the scene lives: draws the current view offscreen at a
   * chosen size for image export, without presenting a frame.
   */
  viewportImageRef?: MutableRefObject<ViewportImageSource | null>;
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
  /** Widens or narrows the perspective view, keeping the framing. */
  setFieldOfView(degrees: number): void;
  /** Mirrors the perspective pose onto the ortho camera and its frustum. */
  syncOrthographic(resetZoom: boolean): void;
  /** Re-applies navigation preferences onto the live orbit controls. */
  refreshNavigation(): void;
  /** Target-to-camera direction the view is settling on (a glide's end). */
  viewDirection(): THREE.Vector3;
  /** Starts a glide toward a new pose; user input cancels it. */
  startCameraTween(
    pose: CameraPose,
    onComplete?: () => void,
    glide?: CameraGlideStyle
  ): void;
  /** The durable pose to persist for this project. */
  captureView(): ViewportCameraState;
  /** Holds an exact durable pose, orthographic zoom included. */
  restoreView(state: ViewportCameraState, projection: ProjectionMode): void;
  /** Invalidates the viewport and schedules a render if it is idle. */
  requestRender(): void;
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  bodyGroup: THREE.Group;
  sketchGroup: THREE.Group;
  overlayGroup: THREE.Group;
  gizmoGroup: THREE.Group;
  moveGizmoGroup: THREE.Group;
  moveCopyPreview: MoveCopyPreview;
  /** Applies pending Move/Rotate values to the target body and the gizmo. */
  applyMovePreview(
    translation: MovePreview['translation'],
    rotationDeg: MovePreview['rotationDeg']
  ): void;
  /** Returns selection callouts to the pose their bodies rest at. */
  restSelectionCallouts(): void;
  /**
   * Marks the frozen shadow map dirty for exactly one frame. The map is
   * camera-independent, so orbiting must never call this — that freeze is
   * where most of the render win lives — but anything that moves a caster
   * must, or its shadow stays where the caster used to be.
   */
  refreshShadowMap(): void;
  grid: THREE.Object3D;
  shadowCatcher: THREE.Object3D;
  keyLight: THREE.DirectionalLight;
  raycaster: THREE.Raycaster;
  objectsByBodyId: Map<string, THREE.Object3D>;
  edgeOverlaysByBodyId: Map<string, BodyEdgeOverlay>;
  /**
   * The body projection currently installed in `bodyGroup`, used to skip the
   * mesh rebuild on selection-only renders. It belongs to the context rather
   * than the component because it describes what this scene holds: a context
   * that is torn down and rebuilt (React Strict Mode's double mount, a dev
   * hot update) starts empty and must rebuild even though the props never
   * changed.
   */
  renderedBodies: readonly GeometryBodyRepresentation[] | null;
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
  /** Visible film from the active one of SelectionManager's two hover slots. */
  readonly hoverFaceMesh: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshLambertMaterial
  >;
  /**
   * Overlay materials on their way to their target opacity: they cut there
   * on the next frame unless `selection.easeOpacity` opted them into a fade.
   */
  readonly fadeIns: Set<THREE.Material>;
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
 * How far above a body its name callout hangs: an eighth of its height, and
 * never less than 5 mm so a flat part's chip clears it. The floor is in
 * millimetres, not document units: as a bare 5 it lifted an inch part's
 * chip five inches, off the top of the window and under the top bar.
 */
function calloutLift(box: THREE.Box3, units: string): number {
  const millimetresPerUnit = UNIT_TO_MM[units as UnitSystem] ?? 1;
  return Math.max(
    box.getSize(new THREE.Vector3()).z * 0.12,
    5 / millimetresPerUnit
  );
}

/**
 * Keeps name callouts readable when their anchor sits at the viewport's
 * edge. CSS2DRenderer centres each label on its projected point and rewrites
 * the transform every frame, so the correction rides on the margins instead:
 * the label's unmargined box is recovered from the current margin, and a new
 * margin is computed from scratch — no feedback across frames. Dimension,
 * drag-value and measurement callouts are excluded; they have their own
 * placement schemes.
 */
function clampNameCallouts(container: HTMLElement) {
  const labels = container.querySelectorAll<HTMLElement>(
    `.selection-callout:not(.${SELECTION_CALLOUT_CHIP_CLASS}):not(.dimension-callout):not(.extrude-value-callout):not(.measurement-callout)`
  );
  if (labels.length === 0) {
    return;
  }
  const bounds = container.getBoundingClientRect();
  const pad = 4;
  // The top islands float over the viewport, so its top edge is not the
  // usable one: a chip clamped to it sat under the mode switch, and a click
  // on its Move landed on Tweak.
  const topbar = container.ownerDocument.querySelector('.app-shell > .topbar');
  const top = Math.max(
    bounds.top,
    topbar?.getBoundingClientRect().bottom ?? bounds.top
  );
  // Every rect is read before any margin is written. Interleaving them made
  // each write invalidate layout for the next read, so a frame with N
  // callouts forced N reflows instead of one.
  const measured = [...labels].map((label) => ({
    label,
    currentLeft: parseFloat(label.style.marginLeft) || 0,
    currentTop: parseFloat(label.style.marginTop) || 0,
    rect: label.getBoundingClientRect()
  }));
  for (const { label, currentLeft, currentTop, rect } of measured) {
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
    if (baseTop < top + pad) {
      marginTop = top + pad - baseTop;
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

interface MeasurementCalloutBinding {
  element: HTMLDivElement;
  leader: HTMLDivElement;
  anchor: THREE.Vector3;
  kind: 'anchor' | 'span' | 'arms';
  spanStart?: THREE.Vector3;
  spanEnd?: THREE.Vector3;
  /** Corners of the measured face's or body's world box, when known. */
  extent?: THREE.Vector3[];
}

interface MeasurementSceneBounds {
  center: THREE.Vector3;
  radius: number;
}

/**
 * Keeps measurement callouts off the geometry they describe. CSS2DRenderer
 * centres each pill on its projected anchor, which for a face-area or
 * diameter measurement is the middle of the model; the layout in
 * `layoutMeasurementCallouts` moves the pill just outside the measured
 * face's projected box (or, when that is unknown, outside the model's
 * projected silhouette) instead, and this applies the result as margins
 * (rewritten from scratch every frame, like `clampNameCallouts`) plus a
 * leader line pointing back at the anchor.
 */
function updateMeasurementCallouts(
  bindings: readonly MeasurementCalloutBinding[],
  bounds: MeasurementSceneBounds | null,
  camera: THREE.Camera,
  viewportWidth: number,
  viewportHeight: number
) {
  if (bindings.length === 0) {
    return;
  }
  const center = bounds
    ? projectToScreen(bounds.center, camera, viewportWidth, viewportHeight)
    : null;
  const radius = bounds
    ? projectedWorldSizePx(camera, bounds.center, bounds.radius, viewportHeight)
    : 0;
  // Every read happens before any write so a frame with N callouts costs
  // one reflow, not N.
  const visible: {
    binding: MeasurementCalloutBinding;
    item: CalloutLayoutItem;
  }[] = [];
  for (const binding of bindings) {
    const anchor = projectToScreen(
      binding.anchor,
      camera,
      viewportWidth,
      viewportHeight
    );
    if (!anchor) {
      binding.element.style.marginLeft = '';
      binding.element.style.marginTop = '';
      binding.leader.style.display = 'none';
      continue;
    }
    let spanDir: { x: number; y: number } | undefined;
    if (binding.kind === 'span' && binding.spanStart && binding.spanEnd) {
      const start = projectToScreen(
        binding.spanStart,
        camera,
        viewportWidth,
        viewportHeight
      );
      const end = projectToScreen(
        binding.spanEnd,
        camera,
        viewportWidth,
        viewportHeight
      );
      if (start && end) {
        spanDir = { x: end.x - start.x, y: end.y - start.y };
      }
    }
    // The measured face's own screen box, so its label stands just outside
    // that face. A corner behind the camera leaves the box unknown and the
    // layout falls back to the model's silhouette.
    let bounds: CalloutBounds | undefined;
    if (binding.extent) {
      const corners = binding.extent.map((corner) =>
        projectToScreen(corner, camera, viewportWidth, viewportHeight)
      );
      if (
        corners.every(
          (corner): corner is { x: number; y: number } => corner !== null
        )
      ) {
        bounds = {
          minX: Math.min(...corners.map((corner) => corner.x)),
          minY: Math.min(...corners.map((corner) => corner.y)),
          maxX: Math.max(...corners.map((corner) => corner.x)),
          maxY: Math.max(...corners.map((corner) => corner.y))
        };
      }
    }
    visible.push({
      binding,
      item: {
        anchor,
        width: binding.element.offsetWidth || 1,
        height: binding.element.offsetHeight || 1,
        kind: binding.kind,
        spanDir,
        bounds
      }
    });
  }
  const placements = layoutMeasurementCallouts(
    visible.map((entry) => entry.item),
    { width: viewportWidth, height: viewportHeight, center, radius }
  );
  for (let index = 0; index < visible.length; index += 1) {
    const entry = visible[index];
    const placement = placements[index];
    if (!entry || !placement) {
      continue;
    }
    const { binding, item } = entry;
    const offsetX = placement.x - item.anchor.x;
    const offsetY = placement.y - item.anchor.y;
    binding.element.style.marginLeft = offsetX ? `${offsetX}px` : '';
    binding.element.style.marginTop = offsetY ? `${offsetY}px` : '';
    // The leader runs from the pill's border back to the anchor point. It
    // lives inside the pill, so its geometry is relative to the pill centre.
    const backX = item.anchor.x - placement.x;
    const backY = item.anchor.y - placement.y;
    const distance = Math.hypot(backX, backY);
    if (!placement.leader || distance < 1e-3) {
      binding.leader.style.display = 'none';
      continue;
    }
    const unitX = backX / distance;
    const unitY = backY / distance;
    const edge = Math.min(
      Math.abs(unitX) > 1e-6 ? item.width / 2 / Math.abs(unitX) : Infinity,
      Math.abs(unitY) > 1e-6 ? item.height / 2 / Math.abs(unitY) : Infinity
    );
    const length = distance - edge - 3;
    if (length < 6) {
      binding.leader.style.display = 'none';
      continue;
    }
    binding.leader.style.display = '';
    binding.leader.style.width = `${length.toFixed(1)}px`;
    binding.leader.style.transform = `rotate(${THREE.MathUtils.radToDeg(
      Math.atan2(backY, backX)
    ).toFixed(2)}deg) translateX(${edge.toFixed(1)}px)`;
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
  /**
   * Newest values this drag produced. The workspace is told once, when the
   * drag settles, so the value it commits is this rather than whatever the
   * last render happened to see.
   */
  pendingValues: {
    translation: MovePreview['translation'];
    rotation: MovePreview['rotationDeg'];
  } | null;
}

// Selection colours live with hover's in the viewport's semantics table. They
// were declared here while hover was declared there, which is how one state's
// language drifted out of sight of the other's.
const SELECTION_EMISSIVE = SELECTION_SEMANTICS.selected.bodyEmissive;
const SELECTED_FACE_COLOR = SELECTION_SEMANTICS.selected.face;
const SELECTED_FACE_OPACITY = SELECTION_SEMANTICS.selected.faceOpacity;
const SELECTED_FACE_HIDDEN_OPACITY =
  SELECTION_SEMANTICS.selected.hiddenFaceOpacity;
/** Stable default, so an absent prop does not rerun the bodies pass. */
const NO_FOCUS_FACES: readonly TopologySelection[] = [];
/**
 * Scratch vector for the snap projectors. They run once per candidate — every
 * edge endpoint and face centre of every other body — on each frame of a move
 * drag, and each call used to allocate.
 */
const SNAP_PROJECT_SCRATCH = new THREE.Vector3();

/**
 * Disarms a rig by fading it out rather than deleting it mid-frame.
 *
 * Rigs whose gesture is still running, or which cannot ease, are disposed as
 * before — a rig being torn down because its body was replaced has nothing
 * left to fade against.
 */
/**
 * How far a body reaches behind a face along its normal, from the rendered
 * mesh: the far end of the dimension an offset handle draws. Exact for the
 * mesh as drawn; null when nothing lies behind the face.
 */
/**
 * A planar face's boundary loops in world space, recovered from the body's
 * display mesh: what the offset rig sweeps into the band of wall a push or
 * pull adds or removes. Null when the face is not in the mesh or its
 * triangles do not close into loops, and the rig then draws no band.
 */
function faceBoundaryLoops(
  body: THREE.Object3D,
  topologyId: string
): HandleVec3[][] | null {
  const indexed: THREE.Mesh<THREE.BufferGeometry>[] = [];
  body.traverse((child) => {
    if (
      child instanceof THREE.Mesh &&
      (child.geometry as THREE.BufferGeometry).getIndex()
    ) {
      indexed.push(child as THREE.Mesh<THREE.BufferGeometry>);
    }
  });
  const found = indexed[0];
  if (!found) {
    return null;
  }
  const topology = (
    found.userData as {
      topology?: {
        faces: {
          topologyId: string;
          triangleStart: number;
          triangleCount: number;
        }[];
      };
    }
  ).topology;
  const face = topology?.faces.find(
    (candidate) => candidate.topologyId === topologyId
  );
  const position = found.geometry.getAttribute('position');
  const index = found.geometry.getIndex();
  if (!face || !position || !index) {
    return null;
  }
  const profile = faceSweepProfile(
    position.array,
    index.array,
    face.triangleStart,
    face.triangleCount
  );
  if (!profile) {
    return null;
  }
  found.updateWorldMatrix(true, false);
  const world = new THREE.Vector3();
  return profile.loops.map((loop) =>
    loop.map((point) => {
      world.set(point.x, point.y, point.z).applyMatrix4(found.matrixWorld);
      return { x: world.x, y: world.y, z: world.z };
    })
  );
}

/**
 * Whether two offset handles arm the same face the same way. Preview profiles
 * are rebuilt with every derivation, so only which kind is present counts.
 */
function sameOffsetHandleTarget(
  a: OffsetHandleTarget,
  b: OffsetHandleTarget
): boolean {
  const sameVector = (
    u: { x: number; y: number; z: number },
    v: { x: number; y: number; z: number }
  ) => u.x === v.x && u.y === v.y && u.z === v.z;
  return (
    a.bodyId === b.bodyId &&
    a.topologyId === b.topologyId &&
    sameVector(a.point, b.point) &&
    sameVector(a.normal, b.normal) &&
    a.totalBaseline === b.totalBaseline &&
    a.totalSense === b.totalSense &&
    !a.linearProfilePreview === !b.linearProfilePreview &&
    !a.stepProfilePreview === !b.stepProfilePreview &&
    !a.profilePreview === !b.profilePreview
  );
}

/** Whether two cylinder handles resize the same wall from the same pick. */
function sameCylinderHandleTarget(
  a: CylinderRadiusHandleTarget,
  b: CylinderRadiusHandleTarget
): boolean {
  const same = (
    u: { x: number; y: number; z: number },
    v: { x: number; y: number; z: number }
  ) => u.x === v.x && u.y === v.y && u.z === v.z;
  return (
    a.bodyId === b.bodyId &&
    a.topologyId === b.topologyId &&
    a.originalRadius === b.originalRadius &&
    same(a.point, b.point) &&
    same(a.radialDirection, b.radialDirection) &&
    same(a.axisStart, b.axisStart) &&
    same(a.axisEnd, b.axisEnd)
  );
}

type EdgeRigPlacement = NonNullable<EdgeHandleTarget['placement']>;

/** Whether two edge handles round the same edge with the same tool. */
function sameEdgeHandleTarget(
  a: EdgeHandleTarget,
  b: EdgeHandleTarget
): boolean {
  return (
    a.bodyId === b.bodyId && a.topologyId === b.topologyId && a.op === b.op
  );
}

function sameEdgeRigPlacement(a: EdgeRigPlacement, b: EdgeRigPlacement) {
  const near = (
    u: { x: number; y: number; z: number },
    v: { x: number; y: number; z: number }
  ) =>
    Math.abs(u.x - v.x) < 1e-9 &&
    Math.abs(u.y - v.y) < 1e-9 &&
    Math.abs(u.z - v.z) < 1e-9;
  return near(a.origin, b.origin) && near(a.direction, b.direction);
}

function bodyExtentBehind(
  object: THREE.Object3D,
  origin: THREE.Vector3,
  direction: THREE.Vector3
): number | null {
  let least = Number.POSITIVE_INFINITY;
  const vertex = new THREE.Vector3();
  object.updateWorldMatrix(true, true);
  forEachMesh(object, (mesh) => {
    const position = mesh.geometry.getAttribute('position') as
      THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    if (!position) {
      return;
    }
    for (let index = 0; index < position.count; index += 1) {
      vertex
        .fromBufferAttribute(position, index)
        .applyMatrix4(mesh.matrixWorld);
      const along = vertex.sub(origin).dot(direction);
      if (along < least) {
        least = along;
      }
    }
  });
  return Number.isFinite(least) && least < -1e-6 ? -least : null;
}

function retireRig(rig: DragRig, retiring: DragRig[]): void {
  if (!rig.beginExit || !rig.isGone) {
    rig.dispose();
    return;
  }
  rig.beginExit();
  retiring.push(rig);
}

/** Disposes faded-out rigs, and reports whether any are still leaving. */
function stepRetiringRigs(retiring: DragRig[], dtMs: number): boolean {
  let animating = false;
  for (let index = retiring.length - 1; index >= 0; index -= 1) {
    const rig = retiring[index]!;
    const moved = rig.step?.(dtMs) ?? false;
    // A leaving rig that reports no motion will never report gone either;
    // holding it would pin the loop and leave a half-faded ghost on screen.
    if (rig.isGone?.() || !moved) {
      rig.dispose();
      retiring.splice(index, 1);
    } else {
      animating = true;
    }
  }
  return animating;
}

/** Screen gap between a pin's centre and its value chip. */
const PIN_CHIP_GAP_PX = 44;

/**
 * How far inside the right lane's edge a pin's value chip may start before
 * it swaps to the pin's other side: room for the chip itself.
 */
const CHIP_LANE_CLEARANCE_PX = 72;
/** A dimension line shorter than this on screen cannot carry its label. */
const LINE_LABEL_MIN_PX = 150;
/** Air between the mode tag and the value pill along the line. */
const LINE_LABEL_GAP_PX = 6;
/**
 * The cylinder chip rides its radius line, but leaves it for the pin's side
 * once the pill would reach the pin. This is the pin's half-extent plus a
 * little air, added to the pill's own width when deciding.
 */
const DIMENSION_CHIP_PIN_CLEARANCE_PX = 36;

/**
 * Splits a chip's text into prefix, number and units so the number can carry
 * the weight and the rest can recede. The concatenated text is unchanged:
 * "Total 25.59 mm" reads back exactly as written.
 */
function renderChipText(chip: HTMLElement, text: string): void {
  const match = /^(.*?)(-?\d[\d.,]*)(\s\S+)?$/.exec(text);
  if (!match) {
    chip.textContent = text;
    return;
  }
  const [, prefix = '', number = '', units = ''] = match;
  const parts: Node[] = [];
  if (prefix) {
    const span = document.createElement('span');
    span.className = 'chip-prefix';
    span.textContent = prefix;
    parts.push(span);
  }
  const value = document.createElement('span');
  value.className = 'chip-number';
  value.textContent = number;
  parts.push(value);
  if (units) {
    const span = document.createElement('span');
    span.className = 'chip-units';
    span.textContent = units;
    parts.push(span);
  }
  chip.replaceChildren(...parts);
}

const E2E_CANVAS_HOOKS_ENABLED =
  (
    import.meta.env as unknown as {
      VITE_E2E?: string;
    }
  ).VITE_E2E === '1';
/**
 * Counts the viewer's renders for an e2e probe that assigns an object to
 * `window.__ozRenderCounts` (a panel drag must not re-render it at all).
 * E2E builds only, and then a single property read per render.
 */
function noteE2ERender() {
  const counts = (window as { __ozRenderCounts?: Record<string, number> })
    .__ozRenderCounts;
  if (counts && typeof counts === 'object') {
    counts.ModelViewer = (counts.ModelViewer ?? 0) + 1;
  }
}
const SKETCH_COLOR = 0x6798ff;
/**
 * How far inside the canvas edge a new body must sit to count as on screen,
 * in normalized device units per side: a body touching the edge reads as
 * cut off.
 */
const AUTO_FRAME_MARGIN_NDC = 0.04;
const SKETCH_SELECTED_COLOR = 0x9eb8ff;
/**
 * Screen-space widths in CSS pixels for the non-body polylines. Native WebGL
 * lines were locked to one device pixel; a hair over one CSS pixel keeps the
 * previous visual weight while leaving the shader room to antialias.
 */
const SKETCH_CURVE_WIDTH = 1.4;
const RIGHT_PAN_TARGET_EPSILON = 1e-9;

/**
 * A control the keyboard is moving through (focus the browser would ring),
 * as opposed to a button that merely kept focus after a click. Tab belongs
 * to focus navigation there, not to the sketch's snap cycling.
 */
function keyboardFocusInUi(): boolean {
  const focused = document.activeElement;
  return (
    focused instanceof HTMLElement &&
    focused !== document.body &&
    focused.matches(':focus-visible')
  );
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.matches('input, textarea, select, [role="textbox"]'))
  );
}

type ViewRequest = NonNullable<ModelViewerProps['viewRequest']>;

function startRequestedView(
  context: SceneContext,
  request: ViewRequest,
  handled: MutableRefObject<{ context: SceneContext; nonce: number } | null>
) {
  if (
    handled.current?.context === context &&
    handled.current.nonce === request.nonce
  ) {
    return;
  }
  handled.current = { context, nonce: request.nonce };
  // An explicit view selection owns the camera even if it arrives before the
  // first body. Otherwise that body's automatic fit can cancel this glide.
  context.hasFitCamera = true;
  const { camera, controls } = context;
  const target = request.view;
  if (typeof target === 'object' && 'pose' in target) {
    // A saved view glides to its pose, then holds it exactly: the tween
    // moves position and target, and the restore lands the orthographic
    // zoom the glide does not carry.
    const [px, py, pz] = target.pose.position;
    const [tx, ty, tz] = target.pose.target;
    context.startCameraTween(
      {
        position: new THREE.Vector3(px, py, pz),
        target: new THREE.Vector3(tx, ty, tz),
        near: camera.near,
        far: camera.far
      },
      () => context.restoreView(target.pose, target.projection),
      { ease: viewJumpEase }
    );
    return;
  }
  const distance = Math.max(camera.position.distanceTo(controls.target), 1);
  const direction = viewDirectionFor(target);
  context.startCameraTween(
    {
      position: controls.target.clone().addScaledVector(direction, distance),
      target: controls.target.clone(),
      near: camera.near,
      far: camera.far
    },
    undefined,
    { ease: viewJumpEase }
  );
}

export function ModelViewer({
  bodies: suppliedBodies,
  parameterVisualPreview = null,
  sketches,
  measurementAnnotations,
  selectedBodyIds,
  selectedTopology,
  previewFaceHighlights,
  focusFaces = NO_FOCUS_FACES,
  selectionCallout = null,
  pickLabel = true,
  focusGhostBodies,
  selectedEdges,
  pickListEnabled,
  settings,
  exactSection,
  fitSignal,
  autoFrame = null,
  viewRequest,
  normalToFaceRequest,
  units,
  editableBodyIds,
  movePreview,
  moveCommitHold,
  appearancePreview,
  projection,
  initialView,
  onViewChange,
  onViewSettled,
  onGeometryPresented,
  geometryTrace,
  onBodiesDrawnElsewhere,
  onWheelDeviceLearned,
  orientationRef,
  orientationDragRef,
  scaleIndicatorRef,
  sketchGridReadoutRef,
  onSelectTopology,
  topologyPicksHeld = false,
  onSelectEdgeChain,
  selectionFilter,
  onBoxSelect,
  onBoxSelectTopology,
  fieldOfView = VIEWPORT_FIELD_OF_VIEW_BOUNDS.default,
  xrayOpacity = XRAY_OPACITY_BOUNDS.default / 100,
  offsetHandle,
  onOffsetPreview,
  onOffsetCommit,
  onOffsetCancel,
  offsetPreviewInvalid,
  previewDeferred,
  onOpenOffsetKeypad,
  keypadAnchorRef,
  offsetSetterRef,
  cylinderRadiusHandle,
  cylinderDimensionMode,
  onCylinderDimensionModeChange,
  cylinderRadiusLabelSetterRef,
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
  sketchViews,
  selectedProfileIds,
  profileSelectionMode,
  onSelectRegion,
  onHoverRegion,
  planePickerArmed,
  footprintPicker = null,
  onFootprint,
  datumPlanes,
  datumAxes,
  referenceImages,
  loadReferenceImage,
  planePickerOffset,
  onPickPlane,
  axisPicker = null,
  onPickAxis,
  commandHandles = EMPTY_COMMAND_HANDLES,
  onCommandHandlePreview,
  onCommandHandleRelease,
  onOpenCommandKeypad,
  commandSetterRef: commandSetterRefProp,
  curvePicker = null,
  onPickCurve,
  onPickDatum,
  placementPlane = null,
  onPlacementClick,
  onMeasurePreview,
  regionHandle,
  facePickOnly = false,
  sketchMode,
  sketchTextAnchorRef,
  onSketchCommit,
  onSketchCommitComposite,
  onEditSketchDimension,
  onMoveSketchDimension,
  onSelectSketchConstraint,
  onSketchConstraintSelectionShown,
  onSketchDrawingChange,
  sketchMoveEnabled = false,
  onSketchMoveChange,
  onSketchMoveCommit,
  onSketchSelectObject,
  onSelectSketchProfile,
  onResizePrimitiveFace,
  onMovePreviewChange,
  moveValuesSetterRef,
  viewportImageRef,
  onContextMenu
}: ModelViewerProps) {
  if (E2E_CANVAS_HOOKS_ENABLED) noteE2ERender();
  const drawingBodiesRef = useRef<
    readonly GeometryBodyRepresentation[] | undefined
  >(undefined);
  const bodies = useMemo(() => {
    const result = reuseRenderBodies(drawingBodiesRef.current, suppliedBodies);
    drawingBodiesRef.current = result;
    return result;
  }, [suppliedBodies]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contextRef = useRef<SceneContext | null>(null);
  const topologyPickListRef = useRef<TopologyPickList | null>(null);
  const onSelectTopologyRef = useRef(onSelectTopology);
  onSelectTopologyRef.current = onSelectTopology;
  const facePickOnlyRef = useRef(facePickOnly);
  facePickOnlyRef.current = facePickOnly;
  const topologyPicksHeldRef = useRef(topologyPicksHeld);
  topologyPicksHeldRef.current = topologyPicksHeld;
  const onSelectEdgeChainRef = useRef(onSelectEdgeChain);
  onSelectEdgeChainRef.current = onSelectEdgeChain;
  // Read per pick rather than rebuilding the scene: changing the filter must
  // not dispose the drag rigs mid-gesture.
  const selectionFilterRef = useRef(selectionFilter);
  selectionFilterRef.current = selectionFilter;
  const pickListEnabledRef = useRef(pickListEnabled);
  pickListEnabledRef.current = pickListEnabled;
  const onBoxSelectRef = useRef(onBoxSelect);
  onBoxSelectRef.current = onBoxSelect;
  const onBoxSelectTopologyRef = useRef(onBoxSelectTopology);
  onBoxSelectTopologyRef.current = onBoxSelectTopology;
  // X-ray is read per pick and per sweep, like the filter.
  const xrayRef = useRef(settings.xray === true);
  xrayRef.current = settings.xray === true;
  /** What every body's face opacity is multiplied by right now. */
  const xrayFactor = settings.xray === true ? xrayOpacity : 1;
  const xrayFactorRef = useRef(xrayFactor);
  xrayFactorRef.current = xrayFactor;
  // Read once, when the scene is built; the effect below follows changes.
  const fieldOfViewRef = useRef(fieldOfView);
  fieldOfViewRef.current = fieldOfView;
  const onResizePrimitiveFaceRef = useRef(onResizePrimitiveFace);
  onResizePrimitiveFaceRef.current = onResizePrimitiveFace;
  // Read by the bodies pass, which re-runs on every selection change. When
  // only the chip's content moves (a verb became available, the armed op
  // changed), the effect below refills the chip alone rather than rebuilding
  // every overlay and replaying their fades.
  const selectionCalloutRef = useRef(selectionCallout);
  selectionCalloutRef.current = selectionCallout;
  const pickLabelRef = useRef(pickLabel);
  pickLabelRef.current = pickLabel;
  const focusGhostBodiesRef = useRef(focusGhostBodies);
  focusGhostBodiesRef.current = focusGhostBodies;
  const selectionCalloutElementRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = selectionCalloutElementRef.current;
    if (element?.isConnected) {
      refreshSelectionCallout(element, selectionCallout);
      // A refilled chip changes size: one frame re-runs the clamp that
      // keeps it inside the viewport and out from under the panels.
      contextRef.current?.requestRender();
    }
  }, [selectionCallout]);
  /** Hover hysteresis; shared by the pointer frame and the body rebuild that clears hover. */
  const hoverDwellRef = useRef(new HoverDwell<PickCandidate>(hoverKeyOf));
  const onSelectSketchProfileRef = useRef(onSelectSketchProfile);
  onSelectSketchProfileRef.current = onSelectSketchProfile;
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
  const cylinderRadiusHandleRef = useRef(cylinderRadiusHandle);
  cylinderRadiusHandleRef.current = cylinderRadiusHandle;
  const offsetHandleRef = useRef(offsetHandle);
  offsetHandleRef.current = offsetHandle;
  /** The selection as rendered: an exact preview may renumber the face. */
  const selectedTopologyRef = useRef(selectedTopology);
  selectedTopologyRef.current = selectedTopology;
  const edgeHandleRef = useRef(edgeHandle);
  edgeHandleRef.current = edgeHandle;
  const cylinderDimensionModeRef = useRef(cylinderDimensionMode);
  cylinderDimensionModeRef.current = cylinderDimensionMode;
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;
  const editableBodyIdsRef = useRef(new Set(editableBodyIds));
  editableBodyIdsRef.current = new Set(editableBodyIds);
  const unitsRef = useRef(units);
  unitsRef.current = units;
  // What an overlay prints after a number: `inch` is the document's unit
  // name, `in` is what the dock and the Inspector call it on screen.
  const unitLabelRef = useRef(displayLengthName(units as UnitSystem));
  unitLabelRef.current = displayLengthName(units as UnitSystem);
  const displayModeRef = useRef(settings.displayMode);
  displayModeRef.current = settings.displayMode;
  const sectionViewRef = useRef(settings.sectionView ?? null);
  sectionViewRef.current = settings.sectionView ?? null;
  const exactSectionRef = useRef(exactSection);
  exactSectionRef.current = exactSection;
  const showGridRef = useRef(settings.showGrid);
  showGridRef.current = settings.showGrid;
  const reducedMotionRef = useRef(settings.reducedMotion);
  reducedMotionRef.current = settings.reducedMotion;
  const zoomToCursorRef = useRef(settings.zoomToCursor);
  zoomToCursorRef.current = settings.zoomToCursor;
  const middleDragRef = useRef(settings.middleDrag);
  middleDragRef.current = settings.middleDrag;
  const pointerNavigationRef = useRef(settings.pointerNavigation);
  pointerNavigationRef.current = settings.pointerNavigation;
  const initialViewRef = useRef(initialView);
  const viewRequestRef = useRef(viewRequest);
  viewRequestRef.current = viewRequest;
  const handledViewRequestRef = useRef<{
    context: SceneContext;
    nonce: number;
  } | null>(null);
  /**
   * The normal-to-face request whose glide has started. The request is never
   * cleared, so without this every later change of `bodies` (a selection, a
   * drag, a preview, a commit) glided the camera back to that face.
   */
  const handledNormalToFaceRef = useRef<{
    context: SceneContext;
    nonce: number;
  } | null>(null);
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const onGeometryPresentedRef = useRef(onGeometryPresented);
  onGeometryPresentedRef.current = onGeometryPresented;
  const geometryTraceRef = useRef(geometryTrace);
  geometryTraceRef.current = geometryTrace;
  const pendingEditFrameRef = useRef<typeof geometryTrace>(undefined);
  const pendingTracedFrameRef = useRef(false);
  const installedEditRevisionRef = useRef<typeof geometryTrace>(undefined);
  const onBodiesDrawnElsewhereRef = useRef(onBodiesDrawnElsewhere);
  onBodiesDrawnElsewhereRef.current = onBodiesDrawnElsewhere;
  const onViewSettledRef = useRef(onViewSettled);
  onViewSettledRef.current = onViewSettled;
  const onWheelDeviceLearnedRef = useRef(onWheelDeviceLearned);
  onWheelDeviceLearnedRef.current = onWheelDeviceLearned;
  const onOffsetCommitRef = useRef(onOffsetCommit);
  onOffsetCommitRef.current = onOffsetCommit;
  const onOffsetPreviewRef = useRef(onOffsetPreview);
  onOffsetPreviewRef.current = onOffsetPreview;
  const onOffsetCancelRef = useRef(onOffsetCancel);
  onOffsetCancelRef.current = onOffsetCancel;
  const offsetPreviewInvalidRef = useRef(offsetPreviewInvalid);
  offsetPreviewInvalidRef.current = offsetPreviewInvalid;
  const previewDeferredRef = useRef(previewDeferred);
  previewDeferredRef.current = previewDeferred;
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
  const onCylinderDimensionModeChangeRef = useRef(
    onCylinderDimensionModeChange
  );
  onCylinderDimensionModeChangeRef.current = onCylinderDimensionModeChange;
  const onEdgeRadiusPreviewRef = useRef(onEdgeRadiusPreview);
  onEdgeRadiusPreviewRef.current = onEdgeRadiusPreview;
  const onEdgeCommitRef = useRef(onEdgeCommit);
  onEdgeCommitRef.current = onEdgeCommit;
  const onEdgeCancelRef = useRef(onEdgeCancel);
  onEdgeCancelRef.current = onEdgeCancel;
  const onOpenEdgeKeypadRef = useRef(onOpenEdgeKeypad);
  onOpenEdgeKeypadRef.current = onOpenEdgeKeypad;
  const onDirectManipulationChangeRef = useRef(onDirectManipulationChange);
  onDirectManipulationChangeRef.current = onDirectManipulationChange;
  const edgeHandleOpRef = useRef<'fillet' | 'chamfer'>('fillet');
  /** The handle the live cylinder-radius rig was built for. */
  const cylinderRigBuiltRef = useRef<{
    handle: CylinderRadiusHandleTarget;
  } | null>(null);
  /** Live edge-radius rig; owned by the edgeHandle effect below. */
  const edgeRigRef = useRef<DragRig | null>(null);
  /** The handle and frame the live edge rig was built for. */
  const edgeRigBuiltRef = useRef<{
    handle: EdgeHandleTarget;
    placement: EdgeRigPlacement;
  } | null>(null);
  const edgeDragActiveRef = useRef(false);
  const sketchModeRef = useRef(sketchMode);
  sketchModeRef.current = sketchMode;
  const onSelectRegionRef = useRef(onSelectRegion);
  onSelectRegionRef.current = onSelectRegion;
  const onHoverRegionRef = useRef(onHoverRegion);
  onHoverRegionRef.current = onHoverRegion;
  const onMeasurePreviewRef = useRef(onMeasurePreview);
  onMeasurePreviewRef.current = onMeasurePreview;
  const onPickPlaneRef = useRef(onPickPlane);
  onPickPlaneRef.current = onPickPlane;
  const onPickDatumRef = useRef(onPickDatum);
  onPickDatumRef.current = onPickDatum;
  const placementPlaneRef = useRef(placementPlane);
  placementPlaneRef.current = placementPlane;
  const onPlacementClickRef = useRef(onPlacementClick);
  onPlacementClickRef.current = onPlacementClick;
  const planePickerOffsetRef = useRef(planePickerOffset);
  planePickerOffsetRef.current = planePickerOffset;
  const datumPlaneRigRef = useRef<DatumPlaneRig | null>(null);
  const datumAxisRigRef = useRef<DatumAxisRig | null>(null);
  const planePickerRigRef = useRef<ReturnType<
    typeof buildPlanePickerRig
  > | null>(null);
  const axisPickerRigRef = useRef<ReturnType<typeof buildAxisPickerRig> | null>(
    null
  );
  const onPickAxisRef = useRef(onPickAxis);
  onPickAxisRef.current = onPickAxis;
  /**
   * U09: the in-place command's handles by value id — a rig (none for a
   * chip-only value) and its chip — and the drag holding one of them.
   */
  const commandRigsRef = useRef(
    new Map<
      string,
      {
        key: string;
        rig: DragRig | null;
        anchor: THREE.Vector3 | null;
        chip: HTMLDivElement;
      }
    >()
  );
  const commandDragRef = useRef<{
    pointerId: number;
    valueId: string;
    startValue: number;
  } | null>(null);
  /**
   * Ends a held command drag as pointer-up would, without a value: the rig
   * effect calls it when the command goes away under the pointer.
   */
  const retireCommandDragRef = useRef<(() => void) | null>(null);
  const commandHandlesRef = useRef(commandHandles);
  commandHandlesRef.current = commandHandles;
  /** Lets the handle effect create chips on the viewer's HUD layer. */
  const commandChipFactoryRef = useRef<(() => HTMLDivElement) | null>(null);
  const curvePickerRigRef = useRef<ReturnType<
    typeof buildCurvePickerRig
  > | null>(null);
  const footprintPickerRef = useRef(footprintPicker);
  footprintPickerRef.current = footprintPicker;
  const onFootprintRef = useRef(onFootprint);
  onFootprintRef.current = onFootprint;
  /** Drops a footprint drag in progress, as when its command goes away. */
  const retireFootprintRef = useRef<(() => void) | null>(null);
  const onPickCurveRef = useRef(onPickCurve);
  onPickCurveRef.current = onPickCurve;
  const onCommandHandlePreviewRef = useRef(onCommandHandlePreview);
  onCommandHandlePreviewRef.current = onCommandHandlePreview;
  const onCommandHandleReleaseRef = useRef(onCommandHandleRelease);
  onCommandHandleReleaseRef.current = onCommandHandleRelease;
  const onOpenCommandKeypadRef = useRef(onOpenCommandKeypad);
  onOpenCommandKeypadRef.current = onOpenCommandKeypad;
  const ownCommandSetterRef = useRef<
    ((valueId: string, value: number) => void) | null
  >(null);
  /** Lets the keypad drive the command handle without a React render. */
  const commandSetterRef = commandSetterRefProp ?? ownCommandSetterRef;
  const profileSelectionModeRef = useRef(profileSelectionMode);
  profileSelectionModeRef.current = profileSelectionMode;
  const profilePickTargetsRef = useRef<ProfilePickTarget[]>([]);
  /** Group holding region-detected sketch rendering (curves + fills). */
  const regionGroupRef = useRef<THREE.Group | null>(null);
  const sketchDimensionsRef = useRef<ReturnType<
    typeof buildSketchDimensions
  > | null>(null);
  const editSketchDimensionRef = useRef(onEditSketchDimension);
  const focusedReferenceDimensionRef = useRef<string | null>(null);
  editSketchDimensionRef.current = onEditSketchDimension;
  const moveSketchDimensionRef = useRef(onMoveSketchDimension);
  moveSketchDimensionRef.current = onMoveSketchDimension;
  const selectSketchConstraintRef = useRef(onSelectSketchConstraint);
  selectSketchConstraintRef.current = onSelectSketchConstraint;
  const sketchConstraintSelectionShownRef = useRef(
    onSketchConstraintSelectionShown
  );
  sketchConstraintSelectionShownRef.current = onSketchConstraintSelectionShown;
  const sketchRelationsRef = useRef<ReturnType<
    typeof buildSketchRelationGlyphs
  > | null>(null);
  /** Separate from direct-edit overlays so body rebuilds do not erase it. */
  const measurementGroupRef = useRef<THREE.Group | null>(null);
  /**
   * Live dimension graphics with the world points they span.
   *
   * Held outside React because the animation loop resizes them every frame:
   * their arrowheads and witness ticks are pixel-sized, and the world size of
   * a pixel changes with a zoom that never touches the camera's orientation.
   */
  /**
   * Selection overlays that have been deselected and are fading out. They are
   * detached from the naming scheme first so a rebuild cannot find and reuse
   * them, then disposed once their materials reach zero.
   */
  const retiringOverlaysRef = useRef<RetiringOverlay[]>([]);
  /**
   * Rigs that have been disarmed and are fading out. They stay in the scene,
   * and stay stepped, until they report themselves gone.
   */
  const retiringRigsRef = useRef<DragRig[]>([]);
  /**
   * The region (extrude) rig, tracked apart from `offsetRigRef` so the effect
   * that owns it can find a leftover. Its cleanup is skipped while a drag is
   * running, and the live preview changes `sketchViews` on every drag frame,
   * so a rig installed before the drag has no cleanup left by the time the
   * handle goes away — the swept ghost then outlived cancel, undo and mode
   * switches until a reload.
   */
  const regionRigRef = useRef<DragRig | null>(null);
  /**
   * The arrows of the other selected regions in a multi-region extrude. They
   * only mirror `regionRigRef`'s value (once per frame); the drag, preview
   * and exact entry all run through that one rig.
   */
  const regionFollowerRigsRef = useRef<DragRig[]>([]);
  /** The follower arrow last grabbed: it carries the value chip. */
  const regionChipRigRef = useRef<DragRig | null>(null);
  const measurementDimensionsRef = useRef<
    {
      graphic: DimensionGraphic;
      start: THREE.Vector3;
      end: THREE.Vector3;
    }[]
  >([]);
  /**
   * Measurement pills plus their anchors, for the per-frame declutter pass.
   * Held outside React for the same reason as the dimension graphics: the
   * pass runs on every drawn frame because any camera change moves where the
   * model's silhouette projects.
   */
  const measurementCalloutsRef = useRef<MeasurementCalloutBinding[]>([]);
  /** World bounds of the rendered bodies, projected each frame to place callouts. */
  const measurementBoundsRef = useRef<MeasurementSceneBounds | null>(null);
  useEffect(() => {
    let box: THREE.Box3 | null = null;
    for (const body of bodies) {
      const bodyBox = new THREE.Box3(
        new THREE.Vector3(body.bbox.min.x, body.bbox.min.y, body.bbox.min.z),
        new THREE.Vector3(body.bbox.max.x, body.bbox.max.y, body.bbox.max.z)
      );
      if (box) {
        box.union(bodyBox);
      } else {
        box = bodyBox;
      }
    }
    measurementBoundsRef.current = box
      ? {
          center: box.getCenter(new THREE.Vector3()),
          radius: Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6)
        }
      : null;
  }, [bodies]);
  const onSketchCommitRef = useRef(onSketchCommit);
  onSketchCommitRef.current = onSketchCommit;
  const onSketchCommitCompositeRef = useRef(onSketchCommitComposite);
  onSketchCommitCompositeRef.current = onSketchCommitComposite;
  const onSketchDrawingChangeRef = useRef(onSketchDrawingChange);
  onSketchDrawingChangeRef.current = onSketchDrawingChange;
  const onSketchSelectObjectRef = useRef(onSketchSelectObject);
  onSketchSelectObjectRef.current = onSketchSelectObject;
  const sketchMoveEnabledRef = useRef(sketchMoveEnabled);
  sketchMoveEnabledRef.current = sketchMoveEnabled;
  const onSketchMoveChangeRef = useRef(onSketchMoveChange);
  onSketchMoveChangeRef.current = onSketchMoveChange;
  const onSketchMoveCommitRef = useRef(onSketchMoveCommit);
  onSketchMoveCommitRef.current = onSketchMoveCommit;
  /**
   * The selected object's drag-move while the pointer holds it, and the
   * moved data a released drag is waiting to see committed. Both live at
   * component scope so the committed-objects effect, which re-runs on every
   * machine change, draws the preview rather than snapping back to the
   * stored position mid-gesture.
   */
  const sketchMoveRef = useRef<SketchMoveDrag | null>(null);
  const sketchMoveCommitPendingRef = useRef<{
    objectId: string;
    data: SketchObjectData;
    /** The stored data the drag started from; a change means it landed. */
    original: SketchObjectData;
  } | null>(null);
  /** Drops a held sketch move, restoring the stored geometry. */
  const cancelSketchMoveRef = useRef<(() => boolean) | null>(null);
  /** Live sketch rig + local gesture state (imperative, no re-renders). */
  const sketchRigRef = useRef<SketchModeRig | null>(null);
  /** The text outline's origin; null until the pointer reaches the plane. */
  const textAnchorRef = useRef<SketchPoint | null>(null);
  const sketchTextAnchorSinkRef = useRef(sketchTextAnchorRef);
  sketchTextAnchorSinkRef.current = sketchTextAnchorRef;
  const sketchGestureRef = useRef<{
    chainAnchor: SketchPoint | null;
    dragStart: SketchPoint | null;
    arcCenter: SketchPoint | null;
    arcStart: SketchPoint | null;
    circleFirst: SketchPoint | null;
    circleSecond: SketchPoint | null;
    /**
     * The ellipse or spline tool's placed points (I01): an ellipse's centre,
     * axis end, second radius and arc ends in turn; a spline's points.
     */
    curvePoints: SketchPoint[];
    awaitingSecondPoint: boolean;
    pointerId: number | null;
    moved: boolean;
    /** Where a line-tool press landed, so a drag can draw press-to-release. */
    pressPoint: SketchPoint | null;
  }>({
    chainAnchor: null,
    dragStart: null,
    arcCenter: null,
    arcStart: null,
    circleFirst: null,
    circleSecond: null,
    curvePoints: [],
    awaitingSecondPoint: false,
    pointerId: null,
    moved: false,
    pressPoint: null
  });
  const sketchDimLabelRef = useRef<HTMLDivElement | null>(null);
  /** Entity-snap candidates from committed sketch objects + cursor marker. */
  const snapTargetsRef = useRef<SnapTarget[]>([]);
  const [sketchSnapRefusal, setSketchSnapRefusal] = useState<string | null>(
    null
  );
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
  /** The handle the live offset rig was built from. */
  const offsetRigBuiltRef = useRef<{ handle: OffsetHandleTarget } | null>(null);
  const offsetDragActiveRef = useRef(false);
  /** How far the body reaches behind the armed face, for the "Total" reading. */
  const offsetExtentRef = useRef<number | null>(null);
  /** Which number the offset chip shows: the drag delta, or the whole span. */
  const offsetChipModeRef = useRef<OffsetChipMode>('offset');
  /** Last frame's cylinder chip layout, for hysteresis at the threshold. */
  const dimensionChipBesidePinRef = useRef(false);
  /** Cylindrical radius has its own non-translating affordance and lifecycle. */
  const cylinderRadiusRigRef = useRef<DragRig | null>(null);
  const cylinderRadiusDragActiveRef = useRef(false);
  const cylinderRadiusProxyControllerRef = useRef<VisualProxyController | null>(
    null
  );
  const offsetGhostClearRef = useRef<(() => void) | null>(null);
  const offsetGhostClipRef = useRef<
    ((plane: THREE.Plane | null) => void) | null
  >(null);
  const offsetBodyProxyControllerRef = useRef<VisualProxyController | null>(
    null
  );
  const offsetChipRef = useRef<HTMLDivElement | null>(null);

  // Scene, renderers, controls, and the render loop live for the component's
  // lifetime; only the body/sketch/overlay groups rebuild on data changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const viewerHost = host;
    const e2eCanvasHooksEnabled = E2E_CANVAS_HOOKS_ENABLED;

    mark('viewer.init:begin');
    let firstFrame = true;
    /**
     * Per-frame record of which bodies this viewer is drawing away from
     * their document pose. Owned by the scene's own lifetime: a viewer that
     * has been torn down draws nothing, and a remembered pose would outlive
     * both it and the section it silenced.
     */
    const drawnBodyReport = new DrawnBodyReport();
    let lastPerfFrameAt: number | null = null;
    const scene = new THREE.Scene();
    // Solid clear colour stays behind the clip-space gradient as a safe first
    // frame/context-recovery fallback.
    scene.background = new THREE.Color('#0b0c0f');
    const gradientBackdrop = createGradientBackdrop();
    scene.add(gradientBackdrop);

    // E2E builds skip antialiasing, shadows and the environment map unless a
    // spec opts back in (viewer/renderProfile.ts).
    const profile = currentRenderProfile();
    const renderer = timed(
      'viewer.renderer',
      () =>
        new THREE.WebGLRenderer({
          antialias: profile.antialias,
          // Ground decorations use the opaque bodies' stencil coverage.
          stencil: true,
          powerPreference: 'high-performance'
        })
    );
    renderer.setSize(host.clientWidth, host.clientHeight);
    // The canvas fills the host and is sized only through `renderer.setSize`,
    // so its CSS size is the size last given there. Reading `clientWidth` in
    // a frame, after that frame's DOM writes, forced a synchronous layout of
    // the whole workspace each time it was asked.
    let canvasCssWidth = host.clientWidth;
    let canvasCssHeight = host.clientHeight;
    const canvasWidth = () => canvasCssWidth || renderer.domElement.clientWidth;
    const canvasHeight = () =>
      canvasCssHeight || renderer.domElement.clientHeight;
    const applyPixelRatio = () =>
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    applyPixelRatio();
    // Device pixel ratio is read once at construction, so dragging the window
    // to a display with a different ratio left the backing store at the old
    // one — permanently soft, or oversampled, with nothing to prompt a
    // resize. The media query re-arms itself because its own match changes.
    let pixelRatioQuery: MediaQueryList | null = null;
    const watchPixelRatio = () => {
      pixelRatioQuery?.removeEventListener('change', onPixelRatioChange);
      pixelRatioQuery = window.matchMedia(
        `(resolution: ${window.devicePixelRatio}dppx)`
      );
      pixelRatioQuery.addEventListener('change', onPixelRatioChange);
    };
    function onPixelRatioChange() {
      applyPixelRatio();
      resizePending = true;
      requestRender();
      watchPixelRatio();
    }
    watchPixelRatio();
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Material-level clipping for the section view; global clipping would
    // also cut the grid, backdrop, and gizmos.
    renderer.localClippingEnabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = profile.shadows;
    renderer.shadowMap.autoUpdate = false;
    /**
     * The single place that thaws the frozen shadow map, counting refreshes on
     * the canvas so a test can assert both halves of the contract: orbiting
     * must not refresh it, moving a body must. Declared here rather than
     * beside its callers because the light rig calls it during setup, and a
     * `let` read before its declaration is a dead-zone throw that takes the
     * whole viewer down.
     */
    let shadowRefreshes = 0;
    function refreshShadowMap() {
      renderer.shadowMap.needsUpdate = true;
      shadowRefreshes += 1;
      renderer.domElement.dataset.e2eShadowRefreshes = String(shadowRefreshes);
      // The freeze itself, not just the thaws: a refresh count alone cannot
      // tell that three.js has gone back to updating the map every frame,
      // which is the regression that would quietly undo the render win.
      renderer.domElement.dataset.e2eShadowAutoUpdate = String(
        renderer.shadowMap.autoUpdate
      );
    }
    // PCF is the soft one now: three r185 deprecated PCFSoftShadowMap and
    // silently substitutes this, warning on every renderer. Its sampler spreads
    // five Vogel-disk taps over `light.shadow.radius`, tuned in
    // tuneShadowFrustum — which is what PCFSoft used to be needed for.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    host.appendChild(renderer.domElement);

    // Studio environment rig: soft IBL reflections do the heavy lifting for
    // "real CAD" shading, so the analytic lights stay gentle.
    const environment = profile.environment
      ? timed('viewer.environment', () => createStudioEnvironment(renderer))
      : null;
    scene.environment = environment;
    scene.environmentIntensity = 0.4;

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(host.clientWidth, host.clientHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.inset = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    // Holds every label under the overlay cards (viewport-overlays.css).
    labelRenderer.domElement.classList.add('viewer-label-layer');
    host.appendChild(labelRenderer.domElement);

    // The camera rig owns both cameras, the orbit controls, the projection
    // mode, and view glides. `requestRender` is passed as a thunk because it
    // is a hoisted function declaration further down this effect.
    const cameraRig = new CameraController({
      host,
      domElement: renderer.domElement,
      // The viewer rail and orientation widget are siblings of this host.
      wheelElement: host.parentElement ?? host,
      requestRender: () => requestRender(),
      fieldOfView: fieldOfViewRef.current,
      onViewChange: (view) => onViewChangeRef.current(view),
      onViewSettled: (view) => onViewSettledRef.current(view),
      reducedMotion: () => reducesMotion(reducedMotionRef.current),
      // Defaults on: zooming toward the pointer is what every modern CAD
      // tool does, and a saved view from before the preference existed
      // should get the current behaviour rather than the old one.
      zoomToCursor: () => zoomToCursorRef.current !== false,
      // Panning is what every other CAD tool puts on the middle drag; the
      // OrbitControls default of zoom is the odd one out.
      middleDrag: () => middleDragRef.current ?? 'pan',
      pointerNavigation: () => pointerNavigationRef.current ?? 'auto',
      wheelDeviceMemory: {
        read: readWheelDeviceMemory,
        write: writeWheelDeviceMemory
      },
      onWheelDeviceLearned: (device) =>
        onWheelDeviceLearnedRef.current?.(device)
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
    // Through the helper like every other site, so the refresh count on the
    // canvas starts from a known value rather than being absent until the
    // first thaw.
    refreshShadowMap();
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
    // The stage takes the theme's colours, and repaints when the Appearance
    // setting or (under 'system') the OS appearance changes.
    // The first paint draws no frame itself: requestRender reads frame state
    // declared further down this effect, and init requests the first frame.
    const paintStage = () =>
      applyStagePalette(
        { scene, backdrop: gradientBackdrop, grid, shadowCatcher },
        readStagePalette(host)
      );
    paintStage();
    const stopWatchingTheme = watchStageTheme(() => {
      paintStage();
      // Datum planes and axes take the theme's datum colour too.
      const datumColor = readDatumColor(host);
      datumPlaneRigRef.current?.setColor(datumColor);
      datumAxisRigRef.current?.setColor(datumColor);
      requestRender();
    });

    // Stretched per frame by updateAxesGizmo so each axis runs past the
    // viewport edge — on screen they read as infinite. Fat lines keep a
    // constant screen-space width, so the triad stays one crisp stroke at
    // any zoom.
    const axes = createAxesGizmo({
      width: canvasWidth() || 1,
      height: canvasHeight() || 1
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

    const measurementGroup = new THREE.Group();
    measurementGroup.name = 'measurements';
    scene.add(measurementGroup);
    measurementGroupRef.current = measurementGroup;

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
      isEditableBody: (bodyId: string) => editableBodyIdsRef.current.has(bodyId)
    });

    // Pointer capture, orbit parking, drag cursor, and click-vs-drag for
    // every gesture below.
    const gestures = new GestureRouter({
      domElement: renderer.domElement,
      setControlsEnabled: (enabled) => {
        cameraRig.controls.enabled = enabled;
      }
    });
    retireCommandDragRef.current = () => {
      const drag = commandDragRef.current;
      if (!drag) return;
      commandDragRef.current = null;
      onDirectManipulationChangeRef.current(false);
      gestures.release(drag.pointerId, 'grab');
      requestRender();
    };

    const picker = new PickService({
      domElement: renderer.domElement,
      camera: () => cameraRig.activeCamera,
      regionGroup,
      sketchGroup,
      bodyGroup,
      filter: () => selectionFilterRef.current,
      selectThrough: () => xrayRef.current,
      clippingPlane: () =>
        sectionViewRef.current
          ? sectionClippingPlane(sectionViewRef.current)
          : null,
      profiles: () => profilePickTargetsRef.current,
      selectionContext: () =>
        profileSelectionModeRef.current
          ? 'profile-command'
          : sketchModeRef.current
            ? 'sketch-edit'
            : 'default'
    });

    /**
     * Poses the named body's selection callouts under the same rotate-then-
     * translate the mesh just took. A single selection has one name callout;
     * a multi-selection gives every body its own numbered one.
     */
    function poseSelectionCallout(
      bodyId: MovePreview['bodyId'],
      rotationDeg: MovePreview['rotationDeg'],
      final: { x: number; y: number; z: number }
    ) {
      for (const child of context.overlayGroup.children) {
        const resting = child.userData.calloutRestingPosition as
          THREE.Vector3 | undefined;
        if (child.userData.calloutBodyId !== bodyId || !resting) {
          continue;
        }
        const anchor = moveCalloutAnchor(resting, rotationDeg, final);
        child.position.set(anchor.x, anchor.y, anchor.z);
      }
    }

    /** Returns every selection callout to the pose its body rests at. */
    function restSelectionCallouts() {
      for (const child of context.overlayGroup.children) {
        const resting = child.userData.calloutRestingPosition as
          THREE.Vector3 | undefined;
        if (resting) {
          child.position.copy(resting);
        }
      }
    }

    const moveCopyPreview = new MoveCopyPreview();

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
          const body = context.renderedBodies?.find(
            (candidate) => candidate.bodyId === preview.bodyId
          );
          const target = moveCopyPreview.target(
            object,
            !!preview.copy && !!body,
            () => {
              const resolution = context.fatLineResolution();
              const copy = new THREE.Group();
              const mesh = createObjectForBody(body!, resolution);
              const edges = createBodyEdgeOverlay(body!, resolution);
              edges.setDisplayMode(displayModeRef.current);
              mesh.add(edges);
              copy.add(mesh);
              applyDisplayMode(copy, displayModeRef.current, xrayRef.current);
              return copy;
            }
          );
          moveCopyPreview.refreshAppearance(
            displayModeRef.current,
            xrayRef.current
          );
          const final = composeMoveTransform(center, translation, rotationDeg);
          target.rotation.copy(moveEuler(rotationDeg));
          target.position.set(final.x, final.y, final.z);
          // The mesh rotates about its own origin and then translates, so the
          // callout's anchor has to take the same two steps to stay over the
          // body — adding the translation alone would drift it off under any
          // rotation.
          if (preview.copy) restSelectionCallouts();
          else poseSelectionCallout(preview.bodyId, rotationDeg, final);
          // The shadow map is frozen (`autoUpdate = false`) so camera-only
          // frames reuse it — that is where most of the render win came from.
          // A body moving under the light is one of the few things that
          // genuinely invalidates it, and leaving it stale strands the body's
          // shadow on the ground where the body used to be. Bounded to the
          // drag: it re-freezes as soon as the preview ends.
          refreshShadowMap();
        }
      }
      moveGizmoGroup.position.set(
        center.x + translation.x,
        center.y + translation.y,
        center.z + translation.z
      );
      if (E2E_CANVAS_HOOKS_ENABLED) {
        renderer.domElement.dataset.e2eMoveCopyPreview = String(
          moveCopyPreview.active
        );
      }
    }

    let animationFrame: number | null = null;
    let pendingHoverEvent: PointerEvent | null = null;
    /**
     * Newest pointer event of an in-flight drag, applied once per frame.
     * A drag only ever needs the latest position — it is absolute, not
     * path-integrated — so processing every raw event just does the same
     * snap scans and HUD layout several times per painted frame.
     */
    let pendingDragEvent: PointerEvent | null = null;
    /**
     * Whether a drag move has already been applied since the last frame. The
     * first move after a frame runs immediately so a single move is never a
     * frame late; anything arriving before the frame that follows it is
     * collapsed into that frame. A burst therefore costs two applications
     * instead of one per event, and an unhurried hand sees no added latency.
     */
    let dragAppliedThisFrame = false;
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
      setFieldOfView: (degrees) => cameraRig.setFieldOfView(degrees),
      syncOrthographic: (resetZoom) => cameraRig.syncOrthographic(resetZoom),
      refreshNavigation: () => cameraRig.refreshNavigationPreferences(),
      viewDirection: () => cameraRig.viewDirection(),
      startCameraTween: (pose, onComplete, glide) =>
        cameraRig.startTween(pose, onComplete, glide),
      captureView: () => cameraRig.capture(),
      restoreView: (state, mode) => cameraRig.restore(state, mode),
      requestRender,
      renderer,
      labelRenderer,
      bodyGroup,
      sketchGroup,
      overlayGroup,
      gizmoGroup,
      moveGizmoGroup,
      moveCopyPreview,
      applyMovePreview,
      restSelectionCallouts,
      refreshShadowMap,
      grid,
      shadowCatcher,
      keyLight,
      raycaster: picker.raycaster,
      objectsByBodyId,
      edgeOverlaysByBodyId,
      renderedBodies: null,
      hasFitCamera: false,
      get hoveredBodyId() {
        return selection.hoveredBodyId;
      },
      get hoveredEdge() {
        return selection.hoveredEdge;
      },
      fatLineResolution: () => ({
        width: canvasWidth() || 1,
        height: canvasHeight() || 1
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
    const viewportImage: ViewportImageSource = {
      capture: (request) => {
        const image = renderViewportImage(
          {
            renderer,
            scene,
            camera: cameraRig.activeCamera,
            backdrop: gradientBackdrop,
            grid: [grid, axes],
            content: [
              skyLight,
              keyLight,
              keyLight.target,
              rimLight,
              shadowCatcher,
              bodyGroup,
              regionGroup,
              sketchGroup
            ],
            sketches: [regionGroup, sketchGroup],
            objectsByBodyId,
            refreshShadowMap,
            emphasizeBodyColors: () => {
              const restores: Array<() => void> = [];
              for (const body of context.renderedBodies ?? []) {
                const object = objectsByBodyId.get(body.bodyId);
                if (!object) continue;
                forEachMesh(object, (mesh) => {
                  const was = mesh.material.color.clone();
                  contextBodyColor(body.color, true, mesh.material.color);
                  restores.push(() => mesh.material.color.copy(was));
                });
              }
              return () => {
                for (const restore of restores) restore();
              };
            }
          },
          request
        );
        requestRender();
        return image;
      },
      viewSize: () => ({
        width: renderer.domElement.width,
        height: renderer.domElement.height
      }),
      // Read when asked, not at mount: the export is rare, and the renderer
      // need not be fully initialised for the viewer to start.
      get maxSide() {
        return viewportImageMaxSide(renderer);
      }
    };
    if (viewportImageRef) viewportImageRef.current = viewportImage;

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

    // A handle's value chip and the selection callouts are placed when the
    // scene draws, clear of the model panels over the stage; a panel moving
    // over them (a window dragged or resized, a column docked) draws again
    // so they move too. The dock's layer comes and goes with the mode, so
    // the area is watched for it and the layer for its panels' moves.
    const viewerArea = host.closest('.viewer-area');
    let watchedLayer: Element | null = null;
    const panelObserver = new MutationObserver(() => {
      if (
        (offsetChipRef.current && !offsetChipRef.current.hidden) ||
        host.querySelector(`.${SELECTION_CALLOUT_CHIP_CLASS}`)
      ) {
        requestRender();
      }
      // Relation glyphs keep out from under the panels: re-measure at once
      // rather than on the glyphs' timer, so a dragged panel pushes them
      // aside as it moves.
      if (
        sketchRelationsRef.current?.refreshObstacles(labelRenderer.domElement)
      ) {
        requestRender();
      }
    });
    const watchPanelLayer = () => {
      const layer =
        viewerArea?.querySelector(':scope > .panel-dock-layer') ?? null;
      if (layer === watchedLayer) return;
      panelObserver.disconnect();
      watchedLayer = layer;
      if (layer) {
        panelObserver.observe(layer, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['style', 'class']
        });
      }
    };
    const areaObserver = new MutationObserver(watchPanelLayer);
    if (viewerArea) areaObserver.observe(viewerArea, { childList: true });
    watchPanelLayer();

    const rightClickGesture = new RightClickGestureTracker();
    /** Where "select other" has reached, for repeated clicks on one spot. */
    let depthCycle: DepthCycle | null = null;
    /** Last canvas pointer, used by the Alt+Down keyboard trigger. */
    let lastPickListPointer: PointerEvent | null = null;
    let rightPanStartTarget: THREE.Vector3 | null = null;
    /** Unmodified drag rubber band for selecting several bodies. */
    let boxSelect: {
      pointerId: number;
      startX: number;
      startY: number;
      /** Pressed on the armed offset face: travel drags it instead. */
      faceGrab?: boolean;
    } | null = null;
    /**
     * A press on the offset handle while its release validates. Held to its
     * own release, which would otherwise fall through to a selection click
     * on the face beneath and re-arm the handle mid-validation.
     */
    let lockedHandlePointerId: number | null = null;
    /** Pointer whose Shift+left-drag is currently routed to camera orbit. */
    let shiftOrbitPointerId: number | null = null;
    let faceDrag: FaceDragState | null = null;
    let moveDrag: MoveDragState | null = null;

    /**
     * Hands the workspace the values a settled drag produced. During the drag
     * the panel is driven directly through `moveValuesSetterRef`, so this is
     * the one place the move becomes React state — and it must run on every
     * way a drag can end, or the committed value is the one from before it.
     */
    function publishMoveDragResult(drag: MoveDragState) {
      const values = drag.pendingValues;
      if (!values) {
        return;
      }
      onMovePreviewChangeRef.current(values.translation, values.rotation, {
        move: drag.snapMove,
        rotate: drag.snapRotate
      });
    }

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
    /**
     * Disposable visual-only projection for a recognized cylinder profile. Pointer
     * events only replace `pendingRadius`; the render loop applies the newest
     * value once per frame, so a fast drag cannot queue stale geometry work.
     */
    let cylinderRadiusProxy: {
      object: THREE.Object3D;
      originalMatrix: THREE.Matrix4;
      originalMatrixAutoUpdate: boolean;
      axisStart: THREE.Vector3;
      axisEnd: THREE.Vector3;
      originalRadius: number;
      profile?: CylinderProfilePreview;
      pendingRadius: number | null;
      requestedAt: number;
    } | null = null;

    /**
     * Shows the dragged value in the selection chip and the viewport callouts
     * while the document still holds the old one. Only the diameter node of a
     * segmented name is rewritten, so the wording around it — which branch of
     * `faceLabel` produced the name, and how that branch words it — cannot
     * affect whether the number keeps moving. `null` restores the document
     * value.
     */
    function updateCylinderRadiusLabels(radius: number | null) {
      cylinderRadiusLabelSetterRef.current?.(radius);
      setLiveDiameter(
        labelRenderer.domElement,
        radius === null ? null : radius * 2
      );
      // The workspace's Selection card names the pick outside the viewer.
      const card =
        labelRenderer.domElement.ownerDocument.querySelector('.selection-card');
      if (card) setLiveDiameter(card, radius === null ? null : radius * 2);
    }

    function restoreCylinderRadiusProxy() {
      const proxy = cylinderRadiusProxy;
      if (!proxy) {
        cylinderRadiusLabelSetterRef.current?.(null);
        delete renderer.domElement.dataset.e2eCylinderProxyRadius;
        return;
      }
      proxy.profile?.restore();
      profilePreviewBadge.hidden = true;
      proxy.object.matrix.copy(proxy.originalMatrix);
      proxy.object.matrixAutoUpdate = proxy.originalMatrixAutoUpdate;
      proxy.object.matrixWorldNeedsUpdate = true;
      proxy.object.updateMatrixWorld(true);
      updateCylinderRadiusLabels(proxy.originalRadius);
      cylinderRadiusLabelSetterRef.current?.(null);
      delete renderer.domElement.dataset.e2eCylinderProxyRadius;
      cylinderRadiusProxy = null;
      refreshShadowMap();
      requestRender();
    }

    function discardCylinderRadiusProxy() {
      // Unchanged bodies can retain their installed attributes after a rebuild.
      restoreCylinderRadiusProxy();
    }

    function beginCylinderRadiusProxy(target: CylinderRadiusHandleTarget) {
      restoreCylinderRadiusProxy();
      if (!target.smoothPreview && !target.profilePreview) {
        return;
      }
      const object = context.objectsByBodyId.get(target.bodyId);
      if (!object) {
        return;
      }
      const profile =
        !target.smoothPreview && target.profilePreview
          ? createCylinderProfilePreview(
              object,
              target.profilePreview,
              'radius'
            )
          : null;
      if (!target.smoothPreview && !profile) return;
      object.updateMatrix();
      cylinderRadiusProxy = {
        ...(profile ? { profile } : {}),
        object,
        originalMatrix: object.matrix.clone(),
        originalMatrixAutoUpdate: object.matrixAutoUpdate,
        axisStart: new THREE.Vector3(
          target.axisStart.x,
          target.axisStart.y,
          target.axisStart.z
        ),
        axisEnd: new THREE.Vector3(
          target.axisEnd.x,
          target.axisEnd.y,
          target.axisEnd.z
        ),
        originalRadius: target.originalRadius,
        pendingRadius: null,
        requestedAt: performance.now()
      };
    }

    function queueCylinderRadiusProxy(
      radius: number,
      requestedAt = performance.now()
    ): boolean {
      if (!cylinderRadiusProxy) {
        return false;
      }
      cylinderRadiusProxy.pendingRadius = radius;
      cylinderRadiusProxy.requestedAt = requestedAt;
      updateCylinderRadiusLabels(radius);
      requestRender();
      return true;
    }

    function flushCylinderRadiusProxy(): {
      radius: number;
      requestedAt: number;
    } | null {
      const proxy = cylinderRadiusProxy;
      const radius = proxy?.pendingRadius;
      if (!proxy || radius == null) {
        return null;
      }
      if (proxy.profile) {
        proxy.pendingRadius = null;
        if (!proxy.profile.apply(radius - proxy.originalRadius)) {
          restoreCylinderRadiusProxy();
          onCylinderRadiusPreviewRef.current(radius, true);
          return null;
        }
        profilePreviewBadge.hidden = false;
        renderer.domElement.dataset.e2eCylinderProxyRadius = String(radius);
        return { radius, requestedAt: proxy.requestedAt };
      }
      const previewMatrix = cylinderRadiusPreviewMatrix(
        proxy.axisStart,
        proxy.axisEnd,
        radius / proxy.originalRadius
      );
      proxy.pendingRadius = null;
      if (!previewMatrix) {
        return null;
      }
      proxy.object.matrixAutoUpdate = false;
      proxy.object.matrix.copy(previewMatrix).multiply(proxy.originalMatrix);
      proxy.object.matrixWorldNeedsUpdate = true;
      proxy.object.updateMatrixWorld(true);
      renderer.domElement.dataset.e2eCylinderProxyRadius = String(radius);
      return { radius, requestedAt: proxy.requestedAt };
    }

    cylinderRadiusProxyControllerRef.current = {
      restore: restoreCylinderRadiusProxy,
      discard: discardCylinderRadiusProxy
    };
    /** Screen-projected drag growing the edge blend radius. */
    let edgeDrag: {
      pointerId: number;
      startX: number;
      startY: number;
      directionX: number;
      directionY: number;
      pixelsPerUnit: number;
      initialValue: number;
    } | null = null;
    const hud = new HudLayer(host);
    const dragHud = hud.create('direct-edit-hud');
    const profilePreviewBadge = hud.create('direct-edit-hud');
    profilePreviewBadge.textContent = 'Preview · exact on release';
    profilePreviewBadge.style.left = '50%';
    profilePreviewBadge.style.top = '100px';
    profilePreviewBadge.style.transform = 'translateX(-50%)';
    let offsetBodyProxy: {
      preview: CylinderProfilePreview;
      pending: number | null;
      requestedAt: number;
      /** The last offset the proxy showed; null while it shows the part. */
      shown: number | null;
    } | null = null;
    // While a face offset is dragged and then validated, the body shows the
    // part as it will be — the viewport proxy or the exact preview — and a
    // ghost of the part as it was shows what a cut removes, with the dragged
    // face at its old place. The rig's hatched band would say it twice.
    let offsetGhost: BodyGhost | null = null;
    function beginOffsetGhost() {
      if (offsetGhost) return;
      const target = offsetHandleRef.current;
      const object = target && context.objectsByBodyId.get(target.bodyId);
      if (!target || !(object instanceof THREE.Mesh)) return;
      const face = context.renderedBodies
        ?.find((body) => body.bodyId === target.bodyId)
        ?.topology?.faces.find(
          (candidate) => candidate.topologyId === target.topologyId
        );
      offsetGhost = createBodyGhost(object as THREE.Mesh, {
        ...(face ? { faceRange: face } : {}),
        resolution: context.fatLineResolution(),
        // The ghost stands outside the body group the section clips.
        clippingPlane: sectionViewRef.current
          ? sectionClippingPlane(sectionViewRef.current)
          : null
      });
      context.scene.add(offsetGhost.object);
      offsetRigRef.current?.setChangeShownByBody?.(true);
      if (E2E_CANVAS_HOOKS_ENABLED)
        renderer.domElement.dataset.e2eOffsetGhost = '1';
    }
    function clearOffsetGhost() {
      if (!offsetGhost) return;
      offsetGhost.dispose();
      offsetGhost = null;
      offsetRigRef.current?.setChangeShownByBody?.(false);
      delete renderer.domElement.dataset.e2eOffsetGhost;
      requestRender();
    }
    offsetGhostClearRef.current = clearOffsetGhost;
    offsetGhostClipRef.current = (plane) => {
      offsetGhost?.setClippingPlane(plane);
    };
    function discardOffsetBodyProxy() {
      offsetBodyProxy?.preview.restore();
      offsetBodyProxy = null;
      profilePreviewBadge.hidden = true;
      delete renderer.domElement.dataset.e2eHeightProxyOffset;
    }
    function restoreOffsetBodyProxy() {
      discardOffsetBodyProxy();
      refreshShadowMap();
      requestRender();
    }
    function beginOffsetBodyProxy() {
      if (offsetBodyProxy) return true;
      const target = offsetHandleRef.current;
      const profile = target?.profilePreview;
      const object = target && context.objectsByBodyId.get(target.bodyId);
      if (!target || !object) return false;
      const linearProfile = target.linearProfilePreview;
      const preview = linearProfile
        ? createLinearProfilePreview(object, linearProfile)
        : profile
          ? (() => {
              const axis = new THREE.Vector3()
                .copy(profile.axisEnd)
                .sub(profile.axisStart);
              const oriented =
                axis.dot(target.normal) >= 0
                  ? profile
                  : {
                      ...profile,
                      axisStart: profile.axisEnd,
                      axisEnd: profile.axisStart
                    };
              return createCylinderProfilePreview(object, oriented, 'height');
            })()
          : target.stepProfilePreview
            ? orientedStepPreview(
                object,
                target.stepProfilePreview,
                target.normal
              )
            : null;
      // Generic offsets edit one face (or one constituent of an imported
      // compound), not the whole body's extent. An affine body stretch moves
      // unrelated geometry and snaps back as exact frames arrive. A step
      // profile moves only the face's own region, the way the exact move
      // does. Without any profile, keep the last exact body while the worker
      // streams the requested edit; the handle still follows the pointer.
      if (preview) {
        offsetBodyProxy = {
          preview,
          pending: null,
          requestedAt: performance.now(),
          shown: null
        };
        return true;
      }
      return false;
    }
    function queueOffsetBodyProxy(
      offset: number,
      requestedAt = performance.now()
    ) {
      if (!offsetBodyProxy && !beginOffsetBodyProxy()) return false;
      offsetBodyProxy!.pending = offset;
      offsetBodyProxy!.requestedAt = requestedAt;
      requestRender();
      return true;
    }
    function flushOffsetBodyProxy() {
      const proxy = offsetBodyProxy;
      if (!proxy || proxy.pending === null) return;
      const offset = proxy.pending;
      proxy.pending = null;
      if (!proxy.preview.apply(offset)) {
        // A declined value leaves the proxy showing the part as it was, which
        // flashed the unmoved body for a frame mid-drag. Hold the last value
        // it could show until the exact stream answers for this one, the
        // way a refused exact preview keeps the last accepted shape.
        if (proxy.shown === null || !proxy.preview.apply(proxy.shown)) {
          restoreOffsetBodyProxy();
        } else {
          refreshShadowMap();
        }
        onOffsetPreviewRef.current(offset, true);
        return;
      }
      proxy.shown = offset;
      profilePreviewBadge.hidden = false;
      renderer.domElement.dataset.e2eHeightProxyOffset = String(offset);
      refreshShadowMap();
      return { offset, requestedAt: proxy.requestedAt };
    }
    offsetBodyProxyControllerRef.current = {
      restore: restoreOffsetBodyProxy,
      discard: discardOffsetBodyProxy
    };

    const topologyPickList = new TopologyPickList({
      hud,
      onHover(candidate) {
        applyHover(candidate);
        if (!e2eCanvasHooksEnabled) {
          return;
        }
        const topologyId = candidate?.selection?.topologyId;
        if (topologyId) {
          renderer.domElement.dataset.e2ePickListHover = topologyId;
        } else {
          delete renderer.domElement.dataset.e2ePickListHover;
        }
      },
      onSelect(candidate) {
        const pickedSelection = candidate.selection;
        if (!pickedSelection) {
          return;
        }
        cameraRig.pivotOn(candidate.hit.point);
        onSelectTopologyRef.current(
          pickedSelection,
          false,
          pickDetail(candidate)
        );
      }
    });
    topologyPickListRef.current = topologyPickList;
    let activeSketchSnap: SnapTarget | null = null;
    /**
     * Pointers whose remaining events are ignored: those that pressed while
     * another pointer held a sketch drag, and those whose drag Escape or
     * Enter already ended (their release still arrives, and must not read
     * as a selection click). Each is retired only by its own release,
     * cancel or next press.
     */
    const sketchMovePointerGate = new SketchMovePointerGate();
    let sketchSnapCycle = 0;
    let latestSketchPointerEvent: PointerEvent | null = null;
    /**
     * Whether the pointer is over the canvas now. Tab cycles snaps only then:
     * once it had crossed the canvas, Tab was taken for good, and the
     * keyboard could not reach Finish or any rail control.
     */
    let sketchPointerOnCanvas = false;
    let latestSketchPoint: SketchPoint | null = null;
    let sketchNumericRaw: string | null = null;
    let sketchNumericKind:
      'radius' | 'diameter' | 'circumradius' | 'length' | 'width' | 'height' =
      'length';
    /**
     * The rectangle's other side while you type this one. A rectangle is the
     * only shape here with two independent numbers, so Tab parks the value you
     * finished and swaps which side you are editing; whichever side you never
     * type keeps whatever the drag was showing.
     */
    let sketchNumericOther: string | null = null;
    cancelDirectManipulationRef.current = () => {
      let cancelled = false;
      if (cylinderRadiusDrag) {
        const originalRadius = cylinderRadiusDrag.originalRadius;
        gestures.release(cylinderRadiusDrag.pointerId, 'grab');
        cylinderRadiusDrag = null;
        cylinderRadiusDragActiveRef.current = false;
        cylinderRadiusRigRef.current?.setValue(originalRadius);
        restoreCylinderRadiusProxy();
        onCylinderRadiusCancelRef.current();
        cancelled = true;
      }
      if (offsetDrag) {
        const initialOffset = offsetDrag.initialOffset;
        gestures.release(offsetDrag.pointerId, 'grab');
        offsetDrag = null;
        offsetDragActiveRef.current = false;
        offsetRigRef.current?.setValue(initialOffset);
        restoreOffsetBodyProxy();
        onOffsetCancelRef.current();
        cancelled = true;
      }
      if (edgeDrag) {
        const initialValue = edgeDrag.initialValue;
        gestures.release(edgeDrag.pointerId, 'grab');
        edgeDrag = null;
        edgeDragActiveRef.current = false;
        edgeRigRef.current?.setValue(initialValue);
        onEdgeCancelRef.current();
        cancelled = true;
      }
      if (faceDrag) {
        restoreFaceDrag();
        faceDrag = null;
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
      if (event.key === 'Escape' && topologyPickList.visible) {
        topologyPickList.hide();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (
        event.altKey &&
        event.key === 'ArrowDown' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !sketchModeRef.current &&
        !isTextEntryTarget(event.target)
      ) {
        const rect = renderer.domElement.getBoundingClientRect();
        const pointer =
          lastPickListPointer ??
          new PointerEvent('pointermove', {
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2
          });
        if (showTopologyPickList(pointer, false, true)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      if (
        sketchMoveRef.current &&
        (event.key === 'Escape' || event.key === 'Enter')
      ) {
        // A held object drag owns both keys, as a held handle does: Escape
        // drops the drag and keeps the selection, Enter places it here.
        // Neither reaches the workspace, whose Escape would climb the
        // sketch ladder a rung further than the one press asked for.
        if (event.key === 'Escape') {
          cancelSketchMove();
        } else if (!commitSketchMove()) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (
        event.key === 'Enter' &&
        sketchModeRef.current?.tool === 'spline' &&
        sketchGestureRef.current.curvePoints.length > 0 &&
        !isTextEntryTarget(event.target)
      ) {
        // Enter finishes the spline, open, through the points placed so far,
        // even with focus still on the curve tile that armed it.
        finishSketchSpline(false);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (handleSketchNumericKey(event)) {
        return;
      }
      if (
        event.key === 'Tab' &&
        sketchModeRef.current &&
        latestSketchPointerEvent &&
        sketchPointerOnCanvas &&
        !keyboardFocusInUi()
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
        // The viewport owns an active captured pointer. Retiring it is the
        // one Escape rung a held drag keeps outside a sketch: the cancel
        // callbacks put the command back to a clean armed state (preview,
        // handle value and any refusal dropped), and the workspace must not
        // also read this press as "return to nothing selected".
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

    /**
     * The snap point a measuring pointer is asking for, or null.
     *
     * Scoped by `measureSnapEdges` before anything is projected. A move drag
     * collects snaps body-wide, which it can afford because it does so once at
     * drag start; this runs on every hover frame, and handing `resolveSnap` a
     * whole imported assembly would be six figures of matrix work per frame.
     */
    function resolveMeasureSnap(
      event: PointerEvent,
      candidate: PickCandidate
    ): SnapResolution | null {
      const bodyId = candidate.selection?.bodyId;
      const body = bodiesRef.current.find(
        (entry) => entry.bodyId === bodyId && !entry.consumed
      );
      const edges = body?.topology?.edges;
      if (!edges) {
        return null;
      }
      const selection = candidate.selection;
      const hoveredEdge =
        selection?.kind === 'edge'
          ? (edges.find((entry) => entry.hash === selection.hash) ?? null)
          : null;
      const scoped = measureSnapEdges(edges, {
        edge: hoveredEdge,
        faceHash: selection?.kind === 'face' ? (selection.hash ?? null) : null
      });
      if (scoped.length === 0) {
        return null;
      }
      const local = hud.toLocal(event.clientX, event.clientY);
      if (!local) {
        return null;
      }
      return resolveSnap(
        snapsFromEdges(scoped, { label: body?.name }),
        local,
        (point) =>
          projectToScreen(
            SNAP_PROJECT_SCRATCH.set(point.x, point.y, point.z),
            context.activeCamera,
            canvasWidth(),
            canvasHeight()
          )
      );
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

    /**
     * Starts an offset drag on the armed rig, from the arrow (or a selected
     * region's follower arrow) or from the armed face itself. `press` is where
     * the gesture began; `event` is the pointer event that claims it.
     */
    function beginOffsetDrag(
      armedRig: DragRig,
      follower: DragRig | null,
      press: { pointerId: number; clientX: number; clientY: number },
      event: PointerEvent
    ) {
      regionChipRigRef.current = follower;
      const grabbed = follower ?? armedRig;
      const screen = screenDirectionFor(
        grabbed.origin
          .clone()
          .addScaledVector(grabbed.direction, grabbed.value()),
        grabbed.direction
      );
      offsetDrag = {
        pointerId: press.pointerId,
        startX: press.clientX,
        startY: press.clientY,
        directionX: screen.directionX,
        directionY: screen.directionY,
        pixelsPerUnit: screen.pixelsPerUnit,
        initialOffset: armedRig.value()
      };
      // The ghost copies the body before the proxy deforms it.
      beginOffsetGhost();
      beginOffsetBodyProxy();
      offsetDragActiveRef.current = true;
      onDirectManipulationChangeRef.current(true);
      gestures.capture(event);
    }

    // Value chip for the offset handle: tracks the arrow tip every frame.
    // Tapping it opens exact numeric entry, per the drag-or-type contract.
    /**
     * The value a click would record, shown while the pointer is still over
     * the target. Hidden from assistive technology: the dock's live region
     * already announces what was measured, and narrating every hover would
     * bury that under a stream of numbers nobody asked for.
     */
    const measurePreviewChip = hud.create('measure-preview-chip', {
      ariaHidden: true
    });
    const offsetChip = hud.create('handle-value-chip');
    offsetChip.dataset.testid = 'direct-manipulation-value';
    const dimensionPrefix = document.createElement('button');
    dimensionPrefix.type = 'button';
    dimensionPrefix.className = 'handle-dimension-prefix';
    const toggleCylinderDimensionMode = (event: Event) => {
      event.stopPropagation();
      const next =
        cylinderDimensionModeRef.current === 'diameter' ? 'radius' : 'diameter';
      cylinderDimensionModeRef.current = next;
      onCylinderDimensionModeChangeRef.current(next);
      requestRender();
    };
    dimensionPrefix.addEventListener('click', toggleCylinderDimensionMode);
    const openExactEntry = () => {
      const cylinderRig = cylinderRadiusRigRef.current;
      // A handle held through validation shows its value but takes no entry.
      if (cylinderRig && cylinderRadiusHandleRef.current?.locked) return true;
      if (
        cylinderRig &&
        onOpenCylinderRadiusKeypadRef.current(
          cylinderRig.value(),
          cylinderDimensionModeRef.current
        )
      ) {
        return true;
      }
      const offsetRig = offsetRigRef.current;
      // A handle held through validation shows its value but takes no entry.
      if (offsetRig && offsetHandleRef.current?.locked) return true;
      if (offsetRig) {
        // Exact entry edits whatever the chip is showing: the whole span
        // (a primitive's height, or the body's reach behind the face) in
        // Total mode, the plain offset otherwise.
        const span =
          offsetHandleRef.current?.totalBaseline ?? offsetExtentRef.current;
        const total =
          offsetChipModeRef.current === 'total' && span !== null
            ? span
            : undefined;
        if (
          onOpenOffsetKeypadRef.current(
            offsetRig.value(),
            total,
            total === undefined
              ? undefined
              : (offsetHandleRef.current?.totalSense ?? 1)
          )
        ) {
          return true;
        }
      }
      const edgeRig = edgeRigRef.current;
      if (edgeRig && onOpenEdgeKeypadRef.current(edgeRig.value())) {
        return true;
      }
      return false;
    };
    openExactEntryRef.current = openExactEntry;
    const handleChipClick = () => {
      openExactEntry();
    };
    offsetChip.addEventListener('click', handleChipClick);
    offsetChipRef.current = offsetChip;

    // U09: the in-place command's value chips. Tapping one opens the keypad,
    // exactly as the offset chip does for a face or region drag.
    commandChipFactoryRef.current = () => {
      const chip = hud.create('handle-value-chip');
      chip.hidden = true;
      return chip;
    };
    /** Places each command chip at its handle; hides any off screen. */
    function updateCommandChips() {
      const rigs = commandRigsRef.current;
      const activeId =
        commandDragRef.current?.valueId ??
        (rigs.size > 0 ? [...rigs.keys()][0]! : null);
      let anchored = false;
      const e2eHandles: Record<
        string,
        { x: number; y: number; value: number }
      > = {};
      // Reads before the writes below, as `updateOffsetChip` does: the chips
      // keep out from under the right lane (the docked panels, the viewer
      // bar), where a value cannot be tapped.
      const laneLeft = rigs.size > 0 ? rightLaneLeft(true) : null;
      // And above the bottom lane (the guidance and the search bar, where
      // the command's Done stands): a chip held on the canvas there sat
      // under the bar and could not be tapped.
      const footTop = rigs.size > 0 ? bottomLaneTop() : null;
      const chipWidths = new Map(
        [...rigs].map(([valueId, entry]) => [valueId, entry.chip.offsetWidth])
      );
      const chipHeights = new Map(
        [...rigs].map(([valueId, entry]) => [valueId, entry.chip.offsetHeight])
      );
      for (const [valueId, entry] of rigs) {
        const view = commandHandlesRef.current.find(
          (handle) => handle.valueId === valueId
        );
        if (!view) continue;
        const value = entry.rig ? entry.rig.value() : view.value;
        const scale =
          (entry.rig?.group.userData.gizmoScale as number | undefined) ?? 1;
        // A chip-only value's anchor is read live: it may follow another
        // value (a hole step's rim), which rebuilds no rig.
        const anchor = entry.rig
          ? entry.rig.chipAnchor(scale)
          : view.kind === 'chip'
            ? new THREE.Vector3(
                view.params.anchor.x,
                view.params.anchor.y,
                view.params.anchor.z
              )
            : (entry.anchor ?? new THREE.Vector3());
        // Hidden only behind the camera. A point past the far plane (a
        // value typed far beyond the model) still projects where it lies,
        // and its chip is kept on the canvas so it can be tapped to fix it.
        // A handle drawn out past the camera (a large value along a direction
        // that faces the viewer) puts its chip at the handle's base instead.
        // Behind is nearer than the near plane, in either projection: an
        // orthographic view draws nothing there either, whatever it projects.
        const camera = context.activeCamera;
        const behind = (point: THREE.Vector3) => isBehindCamera(point, camera);
        const placed =
          behind(anchor) && entry.rig ? entry.rig.group.position : anchor;
        if (behind(placed)) {
          entry.chip.hidden = true;
          continue;
        }
        const ndc = placed.clone().project(camera);
        // Kept on the canvas: a value typed far past the model (a radius
        // the kernel then refuses) must leave its chip where it can be
        // tapped again to fix it.
        const halfWidth = (chipWidths.get(valueId) ?? 0) / 2;
        const x = Math.min(
          Math.max(
            edgeChipCenterX(
              ((ndc.x + 1) / 2) * canvasCssWidth,
              laneLeft,
              chipWidths.get(valueId) ?? 0
            ),
            COMMAND_CHIP_MARGIN_PX + halfWidth
          ),
          Math.max(
            COMMAND_CHIP_MARGIN_PX + halfWidth,
            canvasCssWidth - COMMAND_CHIP_MARGIN_PX - halfWidth
          )
        );
        const halfHeight = (chipHeights.get(valueId) ?? 0) / 2;
        const top = COMMAND_CHIP_MARGIN_PX * 2;
        const y = Math.min(
          Math.max(((1 - ndc.y) / 2) * canvasCssHeight, top),
          Math.max(
            top,
            footTop === null
              ? canvasCssHeight - COMMAND_CHIP_MARGIN_PX * 2
              : Math.min(
                  canvasCssHeight - COMMAND_CHIP_MARGIN_PX * 2,
                  footTop - COMMAND_CHIP_MARGIN_PX - halfHeight
                )
          )
        );
        const text = view.format(value);
        if (entry.chip.textContent !== text) entry.chip.textContent = text;
        hud.showAt(entry.chip, x, y);
        // The keypad rides the chip it was opened from: the one dragged
        // last, else the first.
        if (valueId === activeId) {
          keypadAnchorRef.current?.({ x, y });
          anchored = true;
        }
        if (E2E_CANVAS_HOOKS_ENABLED) {
          // Each handle in page pixels, for specs that drag it the way a
          // hand would rather than reaching into the command.
          const grip = (entry.rig ? entry.rig.group.position : anchor)
            .clone()
            .project(context.activeCamera);
          const rect = renderer.domElement.getBoundingClientRect();
          e2eHandles[valueId] = {
            x: rect.left + ((grip.x + 1) / 2) * rect.width,
            y: rect.top + ((1 - grip.y) / 2) * rect.height,
            value
          };
        }
      }
      if (rigs.size > 0 && !anchored) keypadAnchorRef.current?.(null);
      if (E2E_CANVAS_HOOKS_ENABLED) {
        if (rigs.size > 0) {
          renderer.domElement.dataset.e2eCommandHandles =
            JSON.stringify(e2eHandles);
        } else {
          delete renderer.domElement.dataset.e2eCommandHandles;
        }
      }
    }

    // Companion "Radius" label pill for the cylinder dimension line, sitting
    // just ahead of the value chip like a drawing callout's name tag. Tapping
    // either pill opens the same exact-entry keypad.
    const radiusLabelChip = hud.create('handle-label-chip');
    radiusLabelChip.dataset.testid = 'direct-manipulation-mode';
    radiusLabelChip.textContent = 'Diameter';
    radiusLabelChip.addEventListener('click', (event) => {
      // On an offset line the tag is the Total/Offset switch; on a radius
      // line it names the dimension and opens exact entry like the value.
      const offsetRig = offsetRigRef.current;
      if (offsetRig && !cylinderRadiusRigRef.current) {
        event.stopPropagation();
        const span =
          offsetHandleRef.current?.totalBaseline ?? offsetExtentRef.current;
        if (span !== null && span !== undefined) {
          offsetChipModeRef.current =
            offsetChipModeRef.current === 'total' ? 'offset' : 'total';
          // Open exact entry edits what the chip shows, so it switches with
          // it: left alone it kept the other mode's label and prefill, and
          // its Apply read the number in that mode.
          if (keypadAnchorRef.current) openExactEntry();
          requestRender();
        }
        return;
      }
      handleChipClick();
    });
    // The Total/Offset switch decides what exact entry edits, so it has to
    // be reachable without a pointer: a button in all but element.
    radiusLabelChip.setAttribute('role', 'button');
    radiusLabelChip.tabIndex = 0;
    radiusLabelChip.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      // The workspace reads Space and Enter as shortcuts of its own.
      event.preventDefault();
      event.stopPropagation();
      radiusLabelChip.click();
    });

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

    // The selected object's drag handles: a grab dot on the point a press
    // moves it by, and for text a ring that turns it. Positioned from the
    // render loop, so they track the camera and the drag preview alike.
    const sketchGrabHandle = hud.create('sketch-grab-handle', {
      ariaHidden: true
    });
    const sketchRotateRing = hud.create('sketch-rotate-ring', {
      ariaHidden: true
    });
    // Where those handles are this frame, for the relation glyphs to keep
    // off; rewritten in place each frame.
    const sketchHandleSpot = { shown: false, x: 0, y: 0, ring: false };

    // Exact entry drives the same preview the drag does.
    offsetSetterRef.current = (value: number) => {
      if (cylinderRadiusRigRef.current) {
        cylinderRadiusRigRef.current.setValue(value);
      } else if (offsetRigRef.current) {
        // A typed value previews like a drag: solid over the old part's
        // ghost, taken before the proxy deforms the body.
        // Back at zero there is no change to show: drop the ghost (typed
        // entry keeps it across exact frames, so nothing else would), and
        // take it again for the next nonzero value.
        if (Math.abs(value) > 1e-9) beginOffsetGhost();
        else clearOffsetGhost();
        offsetRigRef.current.setValue(value);
        queueOffsetBodyProxy(value);
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
     * Nearest ghost plane under the pointer, or null. Distance-compared with
     * the solid pick by the callers, so a plane in front of the model wins
     * the click and a face in front of a plane still wins its own.
     */
    function pickGhostPlane(
      event: PointerEvent | MouseEvent
    ): { plane: PlaneId; distance: number; point: Vector3 } | null {
      const rig = planePickerRigRef.current;
      if (!rig) {
        return null;
      }
      picker.setRayFromEvent(event);
      const hit = picker.intersect(rig.targets(), false)[0];
      const plane = hit?.object.userData.pickPlane as PlaneId | undefined;
      return plane
        ? {
            plane,
            distance: hit!.distance,
            point: { x: hit!.point.x, y: hit!.point.y, z: hit!.point.z }
          }
        : null;
    }

    /**
     * Production builds contain no canvas-selection shortcut. The e2e build
     * can request a measured cylinder wall/cap selection so browser tests use
     * exact topology metadata instead of guessing a screen coordinate.
     */
    /**
     * Selects a planar face by its outward normal, the way a click on it
     * would. Face-attached sketch coverage needs this because which face is
     * under a given canvas pixel depends on the camera the test happens to
     * have, and the point of that coverage is the face's lineage, not where
     * it appears on screen.
     */
    const handleE2EPlanarFaceSelection = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          bodyId?: string;
          normal: { x: number; y: number; z: number };
          select?: boolean;
          /** Where on the face the click lands; the face's centroid if absent. */
          point?: { x: number; y: number; z: number };
          resolve?: (
            face: { hasReference: boolean; lineageName?: string } | null
          ) => void;
        }>
      ).detail;
      const wanted = detail?.normal
        ? new THREE.Vector3(detail.normal.x, detail.normal.y, detail.normal.z)
        : null;
      if (!wanted || wanted.lengthSq() < 1e-12) {
        detail?.resolve?.(null);
        return;
      }
      wanted.normalize();
      const body = bodiesRef.current.find(
        (candidate) =>
          !candidate.consumed &&
          (!detail?.bodyId || candidate.bodyId === detail.bodyId)
      );
      const face = body?.topology?.faces.find((candidate) => {
        const normal = candidate.geometry?.normal;
        return (
          candidate.geometry?.surfaceType === 'plane' &&
          normal !== undefined &&
          new THREE.Vector3(normal.x, normal.y, normal.z)
            .normalize()
            .distanceTo(wanted) < 1e-6
        );
      });
      if (!body || !face?.geometry?.normal) {
        detail?.resolve?.(null);
        return;
      }
      // A held pick still reaches the host, which refuses it ("The model is
      // still updating"); it reports no selection so the caller retries.
      const held = detail?.select !== false && topologyPicksHeldRef.current;
      if (detail?.select !== false) {
        const anchor =
          detail?.point ?? face.geometry.centroid ?? face.geometry.center;
        onSelectTopologyRef.current(
          {
            bodyId: body.bodyId,
            kind: 'face',
            topologyId: face.topologyId,
            hash: face.hash
          },
          false,
          {
            point: { x: anchor.x, y: anchor.y, z: anchor.z },
            normal: {
              x: face.geometry.normal.x,
              y: face.geometry.normal.y,
              z: face.geometry.normal.z
            }
          }
        );
      }
      if (held) {
        detail?.resolve?.(null);
        return;
      }
      detail?.resolve?.({
        hasReference:
          face.reference !== undefined &&
          face.reference.currentHash === face.hash,
        ...(face.reference ? { lineageName: face.reference.lineageName } : {})
      });
    };

    const handleE2ECylinderSelection = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          bodyId?: string;
          surface?: 'wall' | 'cap' | 'top-cap' | 'bottom-cap';
          select?: boolean;
          resolve?: (
            geometry: Pick<
              FaceGeometry,
              | 'radius'
              | 'diameter'
              | 'surfaceType'
              | 'featureType'
              | 'axisStart'
              | 'axisEnd'
            > | null
          ) => void;
        }>
      ).detail;
      const body = bodiesRef.current.find(
        (candidate) =>
          !candidate.consumed &&
          (!detail?.bodyId || candidate.bodyId === detail.bodyId)
      );
      const faces = body?.topology?.faces ?? [];
      const face =
        detail?.surface === 'top-cap' || detail?.surface === 'bottom-cap'
          ? faces.find((candidate) =>
              candidate.reference?.lineageName.endsWith(
                detail?.surface === 'bottom-cap'
                  ? '.face.cap.start'
                  : '.face.cap.end'
              )
            )
          : detail?.surface === 'cap'
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
        detail?.resolve?.(null);
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
        detail?.resolve?.(null);
        return;
      }
      // A held pick still reaches the host, which refuses it ("The model is
      // still updating"); it reports no selection so the caller retries.
      const held = detail?.select !== false && topologyPicksHeldRef.current;
      if (detail?.select !== false) {
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
      }
      if (held) {
        detail?.resolve?.(null);
        return;
      }
      detail?.resolve?.({
        surfaceType: geometry.surfaceType,
        ...(geometry.featureType ? { featureType: geometry.featureType } : {}),
        ...(geometry.radius !== undefined ? { radius: geometry.radius } : {}),
        ...(geometry.diameter !== undefined
          ? { diameter: geometry.diameter }
          : {}),
        ...(geometry.axisStart ? { axisStart: geometry.axisStart } : {}),
        ...(geometry.axisEnd ? { axisEnd: geometry.axisEnd } : {})
      });
    };
    const handleE2EEdgeSelection = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          curve?: 'circle' | 'any';
          role?: 'outer-circle' | 'topmost';
          select?: boolean;
          resolve?: (
            selection:
              | (TopologySelection & {
                  curveType?: string;
                  circleRadius?: number;
                  pointCount: number;
                  closureGap: number;
                  closed: boolean;
                })
              | null
          ) => void;
        }>
      ).detail;
      const candidate = bodiesRef.current
        .filter((body) => !body.consumed)
        .flatMap((body) =>
          (body.topology?.edges ?? [])
            .filter(
              (edge) =>
                edge.displayRole !== 'seam' &&
                (detail?.curve !== 'circle' || edge.curve?.type === 'CIRCLE')
            )
            .map((edge) => ({ body, edge }))
        )
        .sort((left, right) => {
          if (detail?.role === 'topmost') {
            const screenHeight = (points: readonly number[]) => {
              const center = new THREE.Vector3();
              for (let index = 0; index < points.length; index += 3) {
                center.x += points[index]!;
                center.y += points[index + 1]!;
                center.z += points[index + 2]!;
              }
              return center
                .multiplyScalar(3 / points.length)
                .project(context.activeCamera).y;
            };
            return (
              screenHeight(right.edge.points) - screenHeight(left.edge.points)
            );
          }
          if (detail?.role !== 'outer-circle') {
            return 0;
          }
          const radiusOrder =
            (right.edge.curve?.circle?.radius ?? -Infinity) -
            (left.edge.curve?.circle?.radius ?? -Infinity);
          return radiusOrder !== 0
            ? radiusOrder
            : (right.edge.curve?.circle?.center.z ?? -Infinity) -
                (left.edge.curve?.circle?.center.z ?? -Infinity);
        })[0];
      const body = candidate?.body;
      const edge = candidate?.edge;
      if (!body || !edge) {
        detail?.resolve?.(null);
        return;
      }
      const selection: TopologySelection = {
        bodyId: body.bodyId,
        kind: 'edge',
        topologyId: edge.topologyId,
        hash: edge.hash,
        ...(edge.reference ? { reference: edge.reference } : {})
      };
      // A held pick still reaches the host, which refuses it ("The model is
      // still updating"); it reports no selection so the caller retries.
      const held = detail?.select !== false && topologyPicksHeldRef.current;
      if (detail?.select !== false) {
        onSelectTopologyRef.current(selection, false);
      }
      if (held) {
        detail?.resolve?.(null);
        return;
      }
      const first = new THREE.Vector3().fromArray(edge.points, 0);
      const last = new THREE.Vector3().fromArray(
        edge.points,
        Math.max(edge.points.length - 3, 0)
      );
      detail?.resolve?.({
        ...selection,
        ...(edge.curve?.type ? { curveType: edge.curve.type } : {}),
        ...(edge.curve?.circle?.radius !== undefined
          ? { circleRadius: edge.curve.circle.radius }
          : {}),
        pointCount: edge.points.length / 3,
        closureGap: first.distanceTo(last),
        closed:
          edge.vertexIds?.[0] === edge.vertexIds?.[1] && edge.points.length >= 6
      });
    };
    const handleE2EBlendSelection = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          select?: boolean;
          inspectOnly?: boolean;
          blendRadius?: number;
          resolve?: (
            value: {
              topologyId: string;
              blendRadius: number;
              producingFeatureId?: string;
              lineageName?: string;
              point?: { x: number; y: number; z: number };
              x?: number;
              y?: number;
            } | null
          ) => void;
        }>
      ).detail;
      const candidate = bodiesRef.current
        .filter((body) => !body.consumed)
        .flatMap((body) =>
          (body.topology?.faces ?? [])
            .filter(
              (face) =>
                face.geometry?.featureType === 'blend' &&
                face.geometry.blendRadius !== undefined &&
                (detail?.blendRadius === undefined ||
                  Math.abs(face.geometry.blendRadius - detail.blendRadius) <=
                    1e-6)
            )
            .map((face) => ({ body, face }))
        )[0];
      const body = candidate?.body;
      const face = candidate?.face;
      if (!body || !face?.geometry || face.geometry.blendRadius === undefined) {
        detail?.resolve?.(null);
        return;
      }
      const metadata = {
        topologyId: face.topologyId,
        blendRadius: face.geometry.blendRadius,
        ...(face.reference?.producingFeatureId
          ? { producingFeatureId: String(face.reference.producingFeatureId) }
          : {}),
        ...(face.reference?.lineageName
          ? { lineageName: face.reference.lineageName }
          : {})
      };
      // Radius polling reads the displayed topology. Finding a clickable
      // pixel raycasts the whole body for each candidate triangle and is
      // reserved for selection and screenshot probes that need that pixel.
      if (detail?.inspectOnly) {
        detail.resolve?.(metadata);
        return;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      let point: THREE.Vector3 | null = null;
      let normal: THREE.Vector3 | null = null;
      let screen: { x: number; y: number } | null = null;
      for (let offset = 0; offset < face.triangleCount; offset += 1) {
        const triangle = face.triangleStart + offset;
        const first = triangle * 3;
        const points = Array.from(
          body.mesh.indices.subarray(first, first + 3),
          (index) =>
            new THREE.Vector3().fromArray(body.mesh.vertices, index * 3)
        );
        const candidateNormal = normalForTriangle(body, triangle);
        if (points.length !== 3 || !candidateNormal) {
          continue;
        }
        const candidatePoint = points
          .reduce((sum, current) => sum.add(current), new THREE.Vector3())
          .multiplyScalar(1 / 3);
        const candidateScreen = projectToScreen(
          candidatePoint,
          context.activeCamera,
          canvasWidth(),
          canvasHeight()
        );
        if (!candidateScreen) {
          continue;
        }
        const stack = picker.pickAll(
          new MouseEvent('mousemove', {
            clientX: rect.left + candidateScreen.x,
            clientY: rect.top + candidateScreen.y
          })
        );
        if (
          !stack.some(
            (entry) => entry.selection?.topologyId === face.topologyId
          )
        ) {
          continue;
        }
        point = candidatePoint;
        normal = candidateNormal;
        screen = candidateScreen;
        break;
      }
      if (!point || !normal) {
        detail?.resolve?.(null);
        return;
      }
      // A held pick still reaches the host, which refuses it ("The model is
      // still updating"); it reports no selection so the caller retries.
      const held = detail?.select !== false && topologyPicksHeldRef.current;
      if (detail?.select !== false) {
        onSelectTopologyRef.current(
          {
            bodyId: body.bodyId,
            kind: 'face',
            topologyId: face.topologyId,
            hash: face.hash,
            ...(face.reference ? { reference: face.reference } : {})
          },
          false,
          {
            point: { x: point.x, y: point.y, z: point.z },
            normal: { x: normal.x, y: normal.y, z: normal.z }
          }
        );
      }
      if (held) {
        detail?.resolve?.(null);
        return;
      }
      detail?.resolve?.({
        ...metadata,
        point: { x: point.x, y: point.y, z: point.z },
        ...(screen ? { x: screen.x, y: screen.y } : {})
      });
    };
    /** Exact boss/bore selection plus a pixel known to lie on the far wall. */
    const handleE2EVisualSelectionProbe = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          surface?: 'bore' | 'annulus' | 'outer-wall';
          interaction?: 'select' | 'hover' | 'inspect' | 'clear';
          includePickList?: boolean;
          resolve?: (
            value: {
              x: number;
              y: number;
              bodyId: string;
              topologyId: string;
              geometry: Pick<
                FaceGeometry,
                | 'surfaceType'
                | 'featureType'
                | 'radius'
                | 'diameter'
                | 'axisStart'
                | 'axisEnd'
              >;
              pickList?: {
                x: number;
                y: number;
                labels: string[];
                topologyIds: string[];
                kinds: ('face' | 'edge')[];
              };
            } | null
          ) => void;
        }>
      ).detail;
      if (!detail?.surface || !detail.resolve) {
        return;
      }
      const boreCandidate = bodiesRef.current
        .flatMap((body) =>
          (body.topology?.faces ?? [])
            .filter(
              (face) =>
                face.geometry?.featureType === 'through-hole' &&
                face.geometry.radius !== undefined
            )
            .map((face) => ({ body, face }))
        )
        .sort(
          (left, right) =>
            (right.face.geometry?.radius ?? 0) -
            (left.face.geometry?.radius ?? 0)
        )[0];
      const body = boreCandidate?.body;
      const bore = boreCandidate?.face;
      const boreGeometry = bore?.geometry;
      if (
        !body?.topology ||
        !bore ||
        !boreGeometry?.axisStart ||
        !boreGeometry.axisEnd ||
        boreGeometry.radius === undefined
      ) {
        detail.resolve(null);
        return;
      }
      const boreRadius = boreGeometry.radius;
      const adjacentPlaneHashes = new Set(
        body.topology.edges
          .filter((edge) => edge.adjacentFaceHashes?.includes(bore.hash))
          .flatMap((edge) => edge.adjacentFaceHashes ?? [])
          .filter((hash) => hash !== bore.hash)
      );
      const annulus = body.topology.faces.find(
        (face) =>
          adjacentPlaneHashes.has(face.hash) &&
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal !== undefined
      );
      const start = new THREE.Vector3(
        boreGeometry.axisStart.x,
        boreGeometry.axisStart.y,
        boreGeometry.axisStart.z
      );
      const end = new THREE.Vector3(
        boreGeometry.axisEnd.x,
        boreGeometry.axisEnd.y,
        boreGeometry.axisEnd.z
      );
      const axis = end.clone().sub(start).normalize();
      const center = start.clone().lerp(end, 0.5);
      const outerWallCandidate = body.topology.faces
        .filter((face) => {
          const geometry = face.geometry;
          if (
            geometry?.surfaceType !== 'cylinder' ||
            geometry.radius === undefined ||
            geometry.radius <= boreRadius ||
            !geometry.axisStart ||
            !geometry.axisEnd
          ) {
            return false;
          }
          const outerStart = new THREE.Vector3(
            geometry.axisStart.x,
            geometry.axisStart.y,
            geometry.axisStart.z
          );
          const outerEnd = new THREE.Vector3(
            geometry.axisEnd.x,
            geometry.axisEnd.y,
            geometry.axisEnd.z
          );
          const outerAxis = outerEnd.clone().sub(outerStart).normalize();
          const lineOffset = outerStart.clone().sub(start).cross(axis).length();
          return (
            Math.abs(outerAxis.dot(axis)) >= 1 - 1e-6 && lineOffset <= 1e-5
          );
        })
        .sort(
          (left, right) =>
            (left.geometry?.radius ?? Infinity) -
            (right.geometry?.radius ?? Infinity)
        )[0];
      const target =
        detail.surface === 'bore'
          ? bore
          : detail.surface === 'annulus'
            ? annulus
            : outerWallCandidate;
      if (!target?.geometry) {
        detail.resolve(null);
        return;
      }
      const reference =
        Math.abs(axis.z) < 0.9
          ? new THREE.Vector3(0, 0, 1)
          : new THREE.Vector3(1, 0, 0);
      const radialU = new THREE.Vector3()
        .crossVectors(axis, reference)
        .normalize();
      const radialV = new THREE.Vector3()
        .crossVectors(axis, radialU)
        .normalize();
      const object = context.objectsByBodyId.get(body.bodyId);
      let bodyMesh: THREE.Mesh | null = null;
      if (object) {
        forEachMesh(object, (mesh) => {
          bodyMesh ??= mesh;
        });
      }
      let farWall: THREE.Vector3 | null = null;
      let largestDepthGap = -Infinity;
      if (bodyMesh) {
        for (let step = 0; step < 48; step += 1) {
          const angle = (step / 48) * Math.PI * 2;
          const candidate = center
            .clone()
            .addScaledVector(radialU, Math.cos(angle) * boreRadius)
            .addScaledVector(radialV, Math.sin(angle) * boreRadius);
          const ndc = candidate.clone().project(context.activeCamera);
          context.raycaster.setFromCamera(
            new THREE.Vector2(ndc.x, ndc.y),
            context.activeCamera
          );
          const firstHit = context.raycaster.intersectObject(
            bodyMesh,
            false
          )[0];
          const firstFaceIndex = firstHit?.faceIndex;
          const visibleFace = body.topology.faces.find(
            (face) =>
              firstFaceIndex !== undefined &&
              firstFaceIndex !== null &&
              firstFaceIndex >= face.triangleStart &&
              firstFaceIndex < face.triangleStart + face.triangleCount
          );
          const depthGap = firstHit
            ? context.raycaster.ray.origin.distanceTo(candidate) -
              firstHit.distance
            : -Infinity;
          if (
            visibleFace?.geometry?.surfaceType === 'cylinder' &&
            (visibleFace.geometry.radius ?? 0) > boreRadius &&
            depthGap > largestDepthGap
          ) {
            farWall = candidate;
            largestDepthGap = depthGap;
          }
        }
      }
      const projectedCenter = center.clone().project(context.activeCamera);
      const centerRayHitsBody = bodyMesh
        ? (() => {
            context.raycaster.setFromCamera(
              new THREE.Vector2(projectedCenter.x, projectedCenter.y),
              context.activeCamera
            );
            return (
              context.raycaster.intersectObject(bodyMesh, false).length > 0
            );
          })()
        : false;
      const fallbackWall = center
        .clone()
        .addScaledVector(radialU, boreRadius * Math.cos(Math.PI / 4))
        .addScaledVector(radialV, boreRadius * Math.sin(Math.PI / 4));
      const probePoint = farWall ?? (centerRayHitsBody ? fallbackWall : null);
      if (!probePoint) {
        detail.resolve(null);
        return;
      }

      let pickList:
        | {
            x: number;
            y: number;
            labels: string[];
            topologyIds: string[];
            kinds: ('face' | 'edge')[];
          }
        | undefined;
      if (detail.includePickList && annulus) {
        const rect = renderer.domElement.getBoundingClientRect();
        const boreAndAnnulus = new Set([bore.topologyId, annulus.topologyId]);
        const projected = new THREE.Vector3();
        search: for (const mouthCenter of [start, end]) {
          for (let step = 0; step < 64; step += 1) {
            const angle = (step / 64) * Math.PI * 2;
            projected
              .copy(mouthCenter)
              .addScaledVector(radialU, Math.cos(angle) * boreRadius)
              .addScaledVector(radialV, Math.sin(angle) * boreRadius)
              .project(context.activeCamera);
            const projectedX = rect.left + ((projected.x + 1) / 2) * rect.width;
            const projectedY = rect.top + ((1 - projected.y) / 2) * rect.height;
            for (let dx = -3; dx <= 3; dx += 1) {
              for (let dy = -3; dy <= 3; dy += 1) {
                const clientX = Math.round(projectedX + dx);
                const clientY = Math.round(projectedY + dy);
                if (
                  clientX <= rect.left ||
                  clientX >= rect.right ||
                  clientY <= rect.top ||
                  clientY >= rect.bottom ||
                  document.elementFromPoint(clientX, clientY) !==
                    renderer.domElement
                ) {
                  continue;
                }
                const stack = picker
                  .pickAll(new MouseEvent('mousemove', { clientX, clientY }))
                  .filter(
                    (
                      candidate
                    ): candidate is PickCandidate & {
                      kind: 'face' | 'edge';
                      selection: TopologySelection;
                    } =>
                      (candidate.kind === 'face' ||
                        candidate.kind === 'edge') &&
                      candidate.selection !== null &&
                      Boolean(candidate.selection.topologyId)
                  );
                const stackIds = new Set(
                  stack.map((candidate) => candidate.selection.topologyId)
                );
                if (
                  [...boreAndAnnulus].some(
                    (topologyId) => !stackIds.has(topologyId)
                  )
                ) {
                  continue;
                }
                const labels = stack.flatMap((candidate) => {
                  const owner = bodiesRef.current.find(
                    (entry) => entry.bodyId === candidate.selection.bodyId
                  );
                  return owner
                    ? [topologySelectionLabel(owner, candidate.selection)]
                    : [];
                });
                if (labels.length !== stack.length) {
                  continue;
                }
                pickList = {
                  x: clientX,
                  y: clientY,
                  labels,
                  topologyIds: stack.map(
                    (candidate) => candidate.selection.topologyId ?? ''
                  ),
                  kinds: stack.map((candidate) => candidate.kind)
                };
                break search;
              }
            }
          }
        }
      }

      const outerRadial = context.activeCamera.position
        .clone()
        .sub(center)
        .addScaledVector(
          axis,
          -context.activeCamera.position.clone().sub(center).dot(axis)
        )
        .normalize();
      const point =
        detail.surface === 'bore'
          ? probePoint.clone()
          : detail.surface === 'outer-wall' &&
              target.geometry.radius !== undefined
            ? center
                .clone()
                .addScaledVector(outerRadial, target.geometry.radius)
            : new THREE.Vector3(
                target.geometry.center.x,
                target.geometry.center.y,
                target.geometry.center.z
              );
      const normal =
        detail.surface === 'bore'
          ? center.clone().sub(point).normalize()
          : detail.surface === 'outer-wall'
            ? outerRadial
            : new THREE.Vector3(
                target.geometry.normal!.x,
                target.geometry.normal!.y,
                target.geometry.normal!.z
              );
      const topologySelection: TopologySelection = {
        bodyId: body.bodyId,
        kind: 'face',
        topologyId: target.topologyId,
        hash: target.hash
      };
      if (detail.interaction === 'clear') {
        applyHover(null);
        delete renderer.domElement.dataset.e2eHoveredFace;
        onSelectTopologyRef.current(null, false);
      } else if (detail.interaction === 'hover') {
        applyHover({
          kind: 'face',
          distance: 0,
          hit: {
            distance: 0,
            point,
            object: bodyMesh ?? object ?? bodyGroup
          },
          selection: topologySelection,
          faceNormal: normal
        });
        renderer.domElement.dataset.e2eHoveredFace = target.topologyId;
      } else if (detail.interaction !== 'inspect') {
        delete renderer.domElement.dataset.e2eHoveredFace;
        onSelectTopologyRef.current(topologySelection, false, {
          point: { x: point.x, y: point.y, z: point.z },
          normal: { x: normal.x, y: normal.y, z: normal.z }
        });
      }

      const ndc = probePoint.clone().project(context.activeCamera);
      const rect = renderer.domElement.getBoundingClientRect();
      detail.resolve({
        x: ((ndc.x + 1) / 2) * rect.width,
        y: ((1 - ndc.y) / 2) * rect.height,
        bodyId: body.bodyId,
        topologyId: target.topologyId,
        ...(pickList ? { pickList } : {}),
        geometry: {
          surfaceType: target.geometry.surfaceType,
          ...(target.geometry.featureType
            ? { featureType: target.geometry.featureType }
            : {}),
          ...(target.geometry.radius !== undefined
            ? { radius: target.geometry.radius }
            : {}),
          ...(target.geometry.diameter !== undefined
            ? { diameter: target.geometry.diameter }
            : {}),
          ...(target.geometry.axisStart
            ? { axisStart: target.geometry.axisStart }
            : {}),
          ...(target.geometry.axisEnd
            ? { axisEnd: target.geometry.axisEnd }
            : {})
        }
      });
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
          /** Edges already taken, so a second call finds a different one. */
          excludeTopologyIds?: string[];
          /** Interior fraction; endpoint repair needs an intentional end choice. */
          fraction?: number;
          /**
           * Only a point a face stands in front of: an edge a click can take
           * through the face (X-ray select-through) and not otherwise.
           */
          occluded?: boolean;
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
        (edge) =>
          edge.displayRole !== 'seam' &&
          !detail.excludeTopologyIds?.includes(edge.topologyId)
      );
      const rect = renderer.domElement.getBoundingClientRect();
      const sample = new THREE.Vector3();
      const fraction = detail.fraction ?? 0.5;
      if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
        detail.resolve(null);
        return;
      }
      for (const edge of edges) {
        for (let index = 0; index + 5 < edge.points.length; index += 3) {
          // Interior points avoid a vertex's two-edge tie. Tests may choose
          // an interior point nearer an end to name that vertex explicitly.
          sample
            .set(
              edge.points[index]! +
                (edge.points[index + 3]! - edge.points[index]!) * fraction,
              edge.points[index + 1]! +
                (edge.points[index + 4]! - edge.points[index + 1]!) * fraction,
              edge.points[index + 2]! +
                (edge.points[index + 5]! - edge.points[index + 2]!) * fraction
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
            detail.occluded &&
            !(
              picked &&
              picker
                .intersect(context.bodyGroup.children)
                .some(
                  (hit) =>
                    isViewerMesh(hit.object) &&
                    hit.distance < picked.distance * (1 - 1e-3)
                )
            )
          ) {
            continue;
          }
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
          /** Counts `index` within this sketch's regions only. */
          sketchId?: string;
          additive?: boolean;
          toggle?: boolean;
        }>
      ).detail;
      const targets = detail?.sketchId
        ? profilePickTargetsRef.current.filter(
            (target) => target.pick.sketchId === detail.sketchId
          )
        : profilePickTargetsRef.current;
      const profile = targets[detail?.index ?? 0]?.pick ?? null;
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
            sectionCaps: {
              triangles: number;
              bounds: { min: number[]; max: number[] };
            }[];
            exactSections: {
              triangles: number;
              curves: number;
              bounds: { min: number[]; max: number[] };
            }[];
            bodyFaces: {
              visible: boolean;
              opacity: number;
              triangles: number;
              depthTest: boolean;
              depthWrite: boolean;
              polygonOffset: boolean;
              polygonOffsetFactor: number;
              polygonOffsetUnits: number;
              renderOrder: number;
              bounds?: { min: number[]; max: number[] };
              worldBounds?: { min: number[]; max: number[] };
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
        visible: boolean;
        opacity: number;
        triangles: number;
        bounds?: { min: number[]; max: number[] };
        worldBounds?: { min: number[]; max: number[] };
        depthTest: boolean;
        depthWrite: boolean;
        polygonOffset: boolean;
        polygonOffsetFactor: number;
        polygonOffsetUnits: number;
        renderOrder: number;
      }[] = [];
      forEachMesh(bodyGroup, (mesh) => {
        mesh.updateWorldMatrix(true, false);
        const worldBounds = mesh.geometry.boundingBox
          ?.clone()
          .applyMatrix4(mesh.matrixWorld);
        bodyFaces.push({
          visible: mesh.visible && mesh.material.visible,
          opacity: mesh.material.opacity,
          triangles: Math.floor(
            (mesh.geometry.index?.count ??
              mesh.geometry.getAttribute('position')?.count ??
              0) / 3
          ),
          depthTest: mesh.material.depthTest,
          depthWrite: mesh.material.depthWrite,
          polygonOffset: mesh.material.polygonOffset,
          polygonOffsetFactor: mesh.material.polygonOffsetFactor,
          polygonOffsetUnits: mesh.material.polygonOffsetUnits,
          ...(mesh.geometry.boundingBox
            ? {
                bounds: {
                  min: mesh.geometry.boundingBox.min.toArray(),
                  max: mesh.geometry.boundingBox.max.toArray()
                }
              }
            : {}),
          ...(worldBounds
            ? {
                worldBounds: {
                  min: worldBounds.min.toArray(),
                  max: worldBounds.max.toArray()
                }
              }
            : {}),
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
      const sectionCaps: {
        triangles: number;
        bounds: { min: number[]; max: number[] };
      }[] = [];
      bodyGroup.traverse((child) => {
        if (
          child.userData.sectionCap !== true ||
          !(child instanceof THREE.Mesh)
        )
          return;
        const geometry = child.geometry as THREE.BufferGeometry;
        geometry.computeBoundingBox();
        const bounds = geometry.boundingBox!;
        sectionCaps.push({
          triangles: geometry.getAttribute('position').count / 3,
          bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }
        });
      });
      // Kernel section geometry, which replaces the cap on a body it covers.
      // Counted per region by the viewport itself, so each entry reports its
      // own boundary curves rather than the group's total.
      const exactSections = exactSectionSnapshot(bodyGroup);
      detail.resolve({
        sectionCaps,
        exactSections,
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
     * Whether every drawn body is wholly on screen through the live camera,
     * and where that camera stands, so a spec can tell a reframe from none.
     */
    /**
     * The first live body's world box and where world points land in client
     * pixels, so a browser test can sweep a rectangle over known geometry
     * wherever the camera framed it.
     */
    const handleE2EProjectPoints = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          points?: [number, number, number][];
          resolve?: (value: {
            box: { min: number[]; max: number[] } | null;
            points: { x: number; y: number }[];
          }) => void;
        }>
      ).detail;
      if (!detail?.resolve) {
        return;
      }
      const object = bodiesRef.current
        .filter((body) => !body.consumed)
        .map((body) => context.objectsByBodyId.get(body.bodyId))
        .find((candidate) => candidate !== undefined);
      const box = object ? new THREE.Box3().setFromObject(object) : null;
      const rect = renderer.domElement.getBoundingClientRect();
      detail.resolve({
        box:
          box && !box.isEmpty()
            ? { min: box.min.toArray(), max: box.max.toArray() }
            : null,
        points: (detail.points ?? []).map((point) => {
          const projected = new THREE.Vector3(...point).project(
            context.activeCamera
          );
          return {
            x: rect.left + ((projected.x + 1) / 2) * rect.width,
            y: rect.top + ((1 - projected.y) / 2) * rect.height
          };
        })
      });
    };
    const handleE2EBodiesInView = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const box = new THREE.Box3();
      for (const object of context.bodyGroup.children) {
        if (object.visible) box.expandByObject(object);
      }
      (
        event as CustomEvent<{
          resolve?: (value: { inView: boolean; camera: number[] }) => void;
        }>
      ).detail?.resolve?.({
        inView: !box.isEmpty() && boxFullyInView(box, context.activeCamera),
        camera: context.activeCamera.position.toArray()
      });
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
    /** Locate a real canvas point with two or more deduplicated topology hits. */
    const handleE2ELocatePickStack = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          resolve?: (
            value: {
              x: number;
              y: number;
              labels: string[];
              topologyIds: string[];
              kinds: ('face' | 'edge')[];
            } | null
          ) => void;
        }>
      ).detail;
      if (!detail?.resolve) {
        return;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      for (let row = 2; row <= 10; row += 1) {
        for (let column = 2; column <= 14; column += 1) {
          const clientX = Math.round(rect.left + (rect.width * column) / 16);
          const clientY = Math.round(rect.top + (rect.height * row) / 12);
          if (
            document.elementFromPoint(clientX, clientY) !== renderer.domElement
          ) {
            continue;
          }
          const stack = picker
            .pickAll(new MouseEvent('mousemove', { clientX, clientY }))
            .filter(
              (
                candidate
              ): candidate is PickCandidate & {
                kind: 'face' | 'edge';
                selection: TopologySelection;
              } =>
                (candidate.kind === 'face' || candidate.kind === 'edge') &&
                candidate.selection !== null &&
                Boolean(candidate.selection.topologyId)
            );
          if (stack.length < 2) {
            continue;
          }
          const labels = stack.flatMap((candidate) => {
            const body = bodiesRef.current.find(
              (entry) => entry.bodyId === candidate.selection.bodyId
            );
            return body
              ? [topologySelectionLabel(body, candidate.selection)]
              : [];
          });
          if (labels.length !== stack.length) {
            continue;
          }
          detail.resolve({
            x: clientX,
            y: clientY,
            labels,
            topologyIds: stack.map(
              (candidate) => candidate.selection.topologyId ?? ''
            ),
            kinds: stack.map((candidate) => candidate.kind)
          });
          return;
        }
      }
      detail.resolve(null);
    };
    /** Read the hover films that are still attached to rendered bodies. */
    const handleE2EHoverFaceState = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          resolve?: (value: {
            settling: boolean;
            slots: {
              slot: number;
              topologyKey: string;
              visible: boolean;
              opacity: number;
              triangleCount: number;
            }[];
          }) => void;
        }>
      ).detail;
      if (!detail?.resolve) {
        return;
      }
      const slots: {
        slot: number;
        topologyKey: string;
        visible: boolean;
        opacity: number;
        triangleCount: number;
      }[] = [];
      bodyGroup.traverse((child) => {
        if (
          !(child instanceof THREE.Mesh) ||
          child.userData.hoverFaceLayer !== 'visible'
        ) {
          return;
        }
        const geometry = child.geometry as THREE.BufferGeometry;
        slots.push({
          slot: Number(child.userData.hoverFaceSlot),
          topologyKey: String(child.userData.hoverFaceKey ?? ''),
          visible: child.visible,
          opacity: (child.material as THREE.Material).opacity,
          triangleCount: (geometry.index?.count ?? 0) / 3
        });
      });
      slots.sort((left, right) => left.slot - right.slot);
      detail.resolve({ settling: selection.isSettling, slots });
    };
    /** Read the document-backed sketch objects currently owned by the rig. */
    const handleE2ESketchState = (event: Event) => {
      if (!e2eCanvasHooksEnabled) {
        return;
      }
      const detail = (
        event as CustomEvent<{
          /** Plane points to report in client pixels, for picking by hand. */
          project?: SketchPoint[];
          resolve?: (
            value: {
              objects: SketchModeState['objects'];
              textPreview: { loops: number; origin: SketchPoint } | null;
              screen: SketchPoint[];
            } | null
          ) => void;
        }>
      ).detail;
      const mode = sketchModeRef.current;
      const bounds = renderer.domElement.getBoundingClientRect();
      const screen = (detail?.project ?? []).map((point) => {
        const { basis } = mode ?? {};
        if (!basis) {
          return { x: Number.NaN, y: Number.NaN };
        }
        const ndc = new THREE.Vector3(
          basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
          basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
          basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
        ).project(context.activeCamera);
        return {
          x: bounds.left + ((ndc.x + 1) / 2) * bounds.width,
          y: bounds.top + ((1 - ndc.y) / 2) * bounds.height
        };
      });
      detail?.resolve?.(
        mode
          ? {
              objects: mode.objects,
              textPreview: sketchRigRef.current?.textPreviewState() ?? null,
              screen
            }
          : null
      );
    };
    if (E2E_CANVAS_HOOKS_ENABLED) {
      renderer.domElement.addEventListener(
        'openzcad:e2e-select-cylinder',
        handleE2ECylinderSelection
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-select-planar-face',
        handleE2EPlanarFaceSelection
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-select-edge',
        handleE2EEdgeSelection
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-select-blend',
        handleE2EBlendSelection
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-visual-selection-probe',
        handleE2EVisualSelectionProbe
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
        'openzcad:e2e-bodies-in-view',
        handleE2EBodiesInView
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-project-points',
        handleE2EProjectPoints
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-control-pointer',
        handleE2EControlPointer
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-locate-pick-stack',
        handleE2ELocatePickStack
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-hover-face-state',
        handleE2EHoverFaceState
      );
      renderer.domElement.addEventListener(
        'openzcad:e2e-sketch-state',
        handleE2ESketchState
      );
    }

    function selectAtPointer(event: PointerEvent) {
      const facesOnly = facePickOnlyRef.current;
      const stack = facesOnly
        ? picker
            .pickAll(event)
            .filter((candidate) => candidate.selection?.kind === 'face')
        : picker.pickAll(event);
      const stepped = cycleDepthPick(
        stack,
        depthCycle,
        event.clientX,
        event.clientY
      );
      depthCycle = stepped.cycle;
      const result = stepped.candidate;
      // A ghost plane in front of whatever the stack resolved starts the
      // sketch instead: it is armed precisely to be clicked.
      const ghost = facesOnly ? null : pickGhostPlane(event);
      if (ghost && (!result || ghost.distance < result.distance)) {
        planePickerRigRef.current?.setHover(null);
        onPickPlaneRef.current(ghost.plane, ghost.point);
        return;
      }
      // A picture being placed takes every click on its own plane, even
      // over the model: its quad is not pickable, so the face under it
      // would otherwise take a click meant for the picture.
      const placing = placementPlaneRef.current;
      if (placing && onPlacementClickRef.current) {
        picker.setRayFromEvent(event);
        const at = new THREE.Vector3();
        const hit = picker.raycaster.ray.intersectPlane(
          new THREE.Plane().setFromNormalAndCoplanarPoint(
            new THREE.Vector3(
              placing.normal.x,
              placing.normal.y,
              placing.normal.z
            ),
            new THREE.Vector3(
              placing.origin.x,
              placing.origin.y,
              placing.origin.z
            )
          ),
          at
        );
        if (hit) {
          onPlacementClickRef.current({ x: at.x, y: at.y, z: at.z });
          return;
        }
      }
      // A datum plane is chosen only where nothing in the model is under
      // the pointer: its quad is translucent and often passes through the
      // part, so it must never steal a click meant for a face behind it.
      if (!result && !facesOnly && onPickDatumRef.current) {
        const datum = datumPlaneRigRef.current;
        if (datum) {
          picker.setRayFromEvent(event);
          const hit = picker.intersect(datum.targets(), false)[0];
          const featureId = hit?.object.userData.datumFeatureId as
            string | undefined;
          if (featureId) {
            onPickDatumRef.current(featureId, {
              x: hit!.point.x,
              y: hit!.point.y,
              z: hit!.point.z
            });
            return;
          }
        }
      }
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
      // Recompute from THIS click's candidate and coordinates. Reusing the last
      // rAF-coalesced hover result can record a point from the previous pointer
      // position when a move and click arrive before the next animation frame.
      // Confined to measuring: a modelling pick still wants the point the
      // pointer was actually on.
      const snapped =
        result && onMeasurePreviewRef.current
          ? (resolveMeasureSnap(event, result)?.candidate.point ?? null)
          : null;
      const detail: PickDetail | undefined = result
        ? {
            point: snapped ?? {
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

    /** Six screen pixels at the orbit target, in world units. */
    function curvePickThreshold(): number {
      return worldPerPixelAt(cameraRig.controls.target) * 6;
    }

    function setRayFromEvent(event: PointerEvent | MouseEvent) {
      picker.setRayFromEvent(event);
    }

    const scaleBarForward = new THREE.Vector3();
    const scaleBarModelCenter = new THREE.Vector3();
    /** World units spanned by one screen pixel at the given point. */
    function worldPerPixelAt(point: THREE.Vector3): number {
      const height = Math.max(canvasHeight(), 1);
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

    const depthForward = new THREE.Vector3();
    const depthOffset = new THREE.Vector3();
    /**
     * World units per screen pixel at `point`, measured from its depth along
     * the camera's forward axis: what perspective projection actually scales
     * by. Euclidean distance overstates it off-axis, so a plane at the edge of
     * the view drew larger than one at its centre.
     */
    function worldPerPixelAtDepth(point: THREE.Vector3): number {
      if (context.projection === 'orthographic') return worldPerPixelAt(point);
      const height = Math.max(canvasHeight(), 1);
      camera.getWorldDirection(depthForward);
      const depth = Math.max(
        depthOffset.subVectors(point, camera.position).dot(depthForward),
        0.001
      );
      return (
        (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) /
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
            : ` · ${Math.round(value * 100) / 100} ${unitLabelRef.current}`;
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
    /** Applies a hover now and tells the dwell that is what is on screen. */
    function applyHover(result: PickCandidate | null) {
      hoverDwellRef.current.reset(result);
      selection.applyHover(result);
      const nextProfileId = result?.region?.profileId ?? null;
      if (nextProfileId !== hoveredProfileId) {
        hoveredProfileId = nextProfileId;
        onHoverRegionRef.current(result?.region ?? null);
      }
    }

    function pickDetail(candidate: PickCandidate): PickDetail {
      return {
        point: {
          x: candidate.hit.point.x,
          y: candidate.hit.point.y,
          z: candidate.hit.point.z
        },
        normal: candidate.faceNormal
          ? {
              x: candidate.faceNormal.x,
              y: candidate.faceNormal.y,
              z: candidate.faceNormal.z
            }
          : undefined
      };
    }

    /**
     * Opens from PickService's ordered stack without consulting or replacing
     * depthCycle. Repeated clicks therefore resume exactly where the last
     * canvas click left them.
     */
    function showTopologyPickList(
      event: PointerEvent | MouseEvent,
      requireDisambiguation: boolean,
      focusFirst = false
    ): boolean {
      if (!pickListEnabledRef.current) {
        return false;
      }
      const entries = picker.pickAll(event).flatMap((candidate) => {
        const pickedSelection = candidate.selection;
        if (!pickedSelection) {
          return [];
        }
        const body = bodiesRef.current.find(
          (entry) => entry.bodyId === pickedSelection.bodyId && !entry.consumed
        );
        if (!body) {
          return [];
        }
        return [
          {
            candidate,
            label: topologySelectionLabel(body, pickedSelection)
          }
        ];
      });
      if (
        entries.length === 0 ||
        (requireDisambiguation && entries.length < 2)
      ) {
        return false;
      }
      hud.hide(measurePreviewChip);
      hud.hide(snapGlyph);
      return topologyPickList.show(entries, event, focusFirst);
    }

    /**
     * Tells an armed drag rig whether the pointer is over its handle, so it
     * can say it is grabbable before anyone presses. Uses the same hit target
     * the press itself uses, or the two would disagree about where the handle
     * is.
     */
    function updateRigHover(event: PointerEvent): boolean {
      const rig =
        offsetRigRef.current ??
        cylinderRadiusRigRef.current ??
        edgeRigRef.current;
      if (!rig?.setHot) {
        return false;
      }
      setRayFromEvent(event);
      const hot = context.raycaster
        .intersectObjects(rig.group.children, true)
        .some((hit) => hit.object.userData.directHandle === true);
      rig.setHot(hot);
      const follower = hot ? null : regionFollowerUnderRay();
      for (const candidate of regionFollowerRigsRef.current) {
        candidate.setHot?.(candidate === follower);
      }
      return hot || follower !== null;
    }

    /**
     * The follower arrow of a multi-region extrude under the raycaster's
     * current ray, or null. Uses the same hit volume as the armed rig.
     */
    function regionFollowerUnderRay(): DragRig | null {
      if (offsetRigRef.current !== regionRigRef.current) {
        return null;
      }
      let nearest: { rig: DragRig; distance: number } | null = null;
      for (const rig of regionFollowerRigsRef.current) {
        const hit = context.raycaster
          .intersectObjects(rig.group.children, true)
          .find((candidate) => candidate.object.userData.directHandle === true);
        if (hit && (!nearest || hit.distance < nearest.distance)) {
          nearest = { rig, distance: hit.distance };
        }
      }
      return nearest?.rig ?? null;
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
      if (updateRigHover(event)) {
        // The handle owns the pointer: highlighting whatever face lies behind
        // it would say the click will select, when it will drag.
        //
        // Dropping the hover first, then claiming the cursor. `applyHover`
        // writes the cursor for whatever it is now hovering — nothing — so
        // claiming it first only to have that write land on top of it is how
        // the handle's own cursor used to come and go.
        applyHover(null);
        renderer.domElement.style.cursor = 'grab';
        updateMeasurePreview(event);
        return;
      }
      // A ghost plane nearer than the solid under the cursor owns the hover:
      // the click will start a sketch on it, not select the face behind.
      const ghost = pickGhostPlane(event);
      const solid = pick(event);
      if (ghost && (!solid || ghost.distance < solid.distance)) {
        planePickerRigRef.current?.setHover(ghost.plane);
        applyHover(null);
        renderer.domElement.style.cursor = 'pointer';
        updateMeasurePreview(event);
        requestRender();
        return;
      }
      planePickerRigRef.current?.setHover(null);
      // `applyHover` owns the cursor here, including clearing it over empty
      // space, now that it no longer skips a write on a stale cache. A change
      // of target waits out the dwell first; while it waits, the same event
      // is re-queued so a pointer that has stopped moving still settles.
      const verdict = hoverDwellRef.current.propose(solid, performance.now());
      if (verdict.commit) {
        applyHover(verdict.candidate);
      } else if (verdict.pending) {
        pendingHoverEvent = event;
        requestRender();
      }
      updateMeasurePreview(event);
    }

    /**
     * Shows what the next click would measure, beside the pointer.
     *
     * The candidate comes from the same `pickAll` + depth cycle the click uses,
     * so the preview cannot name one thing while the click takes another —
     * but the returned cycle is DISCARDED rather than stored. `cycleDepthPick`
     * treats a second call within a few pixels as a request for the next
     * candidate down, so remembering it here would make hovering and then
     * clicking the same spot select the second thing in the stack. Depth
     * cycling belongs to clicks.
     */
    function updateMeasurePreview(event: PointerEvent) {
      const preview = onMeasurePreviewRef.current;
      if (!preview) {
        hud.hide(measurePreviewChip);
        hud.hide(snapGlyph);
        return;
      }
      const stack = picker.pickAll(event);
      const wouldPick = cycleDepthPick(
        stack,
        depthCycle,
        event.clientX,
        event.clientY
      ).candidate;
      const selection = wouldPick?.selection;
      if (!selection) {
        hud.hide(measurePreviewChip);
        hud.hide(snapGlyph);
        return;
      }
      const snapped = resolveMeasureSnap(event, wouldPick);
      if (snapped) {
        showSnapGlyph(snapped);
      } else {
        hud.hide(snapGlyph);
      }
      const label = preview(
        selection,
        // The snapped position when there is one, so the preview reports the
        // number the click will actually record rather than the one under the
        // raw cursor.
        snapped?.candidate.point ?? {
          x: wouldPick.hit.point.x,
          y: wouldPick.hit.point.y,
          z: wouldPick.hit.point.z
        }
      );
      if (!label) {
        hud.hide(measurePreviewChip);
        return;
      }
      measurePreviewChip.textContent = label;
      hud.showAtPointer(measurePreviewChip, event, 16, -28);
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
    ): ScreenDragAxis {
      const rect = renderer.domElement.getBoundingClientRect();
      const distance = Math.max(camera.position.distanceTo(point), 1);
      const fallbackPixelsPerUnit =
        context.projection === 'orthographic'
          ? (rect.height * orthographic.zoom) /
            Math.max(orthographic.top - orthographic.bottom, 0.0001)
          : rect.height /
            (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance);
      return screenDragAxis(
        point,
        direction,
        context.activeCamera,
        rect,
        fallbackPixelsPerUnit
      );
    }

    /**
     * Brings every follower arrow of a multi-region extrude to the armed
     * region rig's value and warning, at its own screen-constant scale.
     * Returns true while one is still easing.
     */
    function stepRegionFollowers(dtMs: number): boolean {
      const followers = regionFollowerRigsRef.current;
      const leader =
        regionRigRef.current && regionRigRef.current === offsetRigRef.current
          ? regionRigRef.current
          : null;
      if (!leader && followers.length === 0) {
        if (E2E_CANVAS_HOOKS_ENABLED) {
          delete renderer.domElement.dataset.e2eRegionHandles;
        }
        return false;
      }
      const value = leader?.value() ?? 0;
      const warned = leader?.group.userData.previewWarning === true;
      let animating = false;
      for (const follower of followers) {
        const rigScale =
          moveGizmoWorldScale(worldPerPixelAt(follower.group.position)) * 0.55;
        if (follower.step?.(dtMs)) {
          animating = true;
        }
        follower.group.scale.setScalar(rigScale);
        follower.group.userData.gizmoScale = rigScale;
        follower.orient?.(context.activeCamera);
        if ((follower.group.userData.previewWarning === true) !== warned) {
          follower.setWarning?.(warned);
        }
        follower.setValue(value);
      }
      if (E2E_CANVAS_HOOKS_ENABLED) {
        // Every arrow's grab point, the armed rig's first, in the same
        // recipe the single-handle hook uses.
        const handles = (leader ? [leader, ...followers] : followers).flatMap(
          (rig) => {
            const scale =
              (rig.group.userData.gizmoScale as number | undefined) ?? 1;
            const hit = projectToScreen(
              rig.group.position
                .clone()
                .addScaledVector(rig.direction, -0.4 * scale),
              context.activeCamera,
              canvasWidth(),
              canvasHeight()
            );
            if (!hit) {
              return [];
            }
            const axis = screenDirectionFor(rig.group.position, rig.direction);
            return [
              {
                x: hit.x,
                y: hit.y,
                dx: axis.directionX,
                dy: axis.directionY,
                pixelsPerUnit: axis.pixelsPerUnit,
                value: rig.value()
              }
            ];
          }
        );
        renderer.domElement.dataset.e2eRegionHandles = JSON.stringify(handles);
      }
      return animating;
    }

    /** What the chip showed when last placed; see `updateOffsetChip`. */
    let chipLayoutKey: string | null = null;
    /** The move that keeps the chip out from under a floating or left panel. */
    let chipDodge = { dx: 0, dy: 0 };
    /**
     * The right lane's inner edge, in canvas pixels: the leftmost of the
     * command card, the inspector and every model panel drawn on the right
     * (not the left dock, nor a window floating over the model). Null when
     * nothing is drawn there. `withRail` counts the viewer's instrument rail
     * too, which is all that is left of the lane once a narrow window has
     * folded the panels away.
     */
    function rightLaneLeft(withRail = false): number | null {
      const laneEdges = [
        ...(renderer.domElement
          .closest('.viewer-area')
          ?.querySelectorAll<HTMLElement>(
            `.stage-right > *, ${RIGHT_LANE_MODEL_PANELS}${
              withRail ? ', .instrument-rail' : ''
            }`
          ) ?? [])
      ]
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0)
        .map((rect) => rect.left);
      return laneEdges.length > 0
        ? Math.min(...laneEdges) -
            renderer.domElement.getBoundingClientRect().left
        : null;
    }

    /**
     * The top of the stage's bottom lane (the guidance line and the search
     * bar, or a running command's bar), from the canvas's top. Null when
     * nothing is drawn there.
     */
    function bottomLaneTop(): number | null {
      const lane = renderer.domElement
        .closest('.workspace')
        ?.querySelector<HTMLElement>('.command-bar-lane');
      if (!lane) return null;
      const rect = lane.getBoundingClientRect();
      return rect.height > 0
        ? rect.top - renderer.domElement.getBoundingClientRect().top
        : null;
    }

    function updateOffsetChip() {
      const chip = offsetChipRef.current;
      if (!chip) {
        return;
      }
      // Layout reads come before this function's writes. A read after a
      // write forces a synchronous layout of the whole workspace, and a
      // dragged chip used to force several every frame. The pills' widths
      // are therefore the last frame's; a frame that changes what they show
      // renders once more, so the next one measures and places them again.
      const chipWidth = chip.offsetWidth;
      const labelWidth = radiusLabelChip.offsetWidth;
      const laneLeft = rightLaneLeft();
      // Every other panel over the stage — a floating window, the left dock —
      // the value chip and its tag come out from under as one, measured
      // where they showed last frame less the move made then.
      const stageRect = renderer.domElement.getBoundingClientRect();
      const otherPanels = [
        ...(renderer.domElement
          .closest('.viewer-area')
          ?.querySelectorAll<HTMLElement>(MODEL_PANEL_OBSTACLES) ?? [])
      ]
        .filter((element) => !element.matches(RIGHT_LANE_MODEL_PANELS))
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const pills = [chip, radiusLabelChip]
        .filter((element) => !element.hidden)
        .map((element) => element.getBoundingClientRect());
      chipDodge =
        pills.length > 0 && otherPanels.length > 0
          ? chipPanelDodge(
              {
                left:
                  Math.min(...pills.map((rect) => rect.left)) - chipDodge.dx,
                right:
                  Math.max(...pills.map((rect) => rect.right)) - chipDodge.dx,
                top: Math.min(...pills.map((rect) => rect.top)) - chipDodge.dy,
                bottom:
                  Math.max(...pills.map((rect) => rect.bottom)) - chipDodge.dy
              },
              otherPanels,
              stageRect,
              laneLeft === null ? null : laneLeft + stageRect.left,
              renderer.domElement.ownerDocument
                .querySelector('.app-shell > .topbar')
                ?.getBoundingClientRect().bottom ?? null
            )
          : { dx: 0, dy: 0 };
      const place = (element: HTMLElement, x: number, y: number) =>
        hud.showAt(element, x + chipDodge.dx, y + chipDodge.dy);
      // Either rig answers the same two questions; only the label differs.
      // In a multi-region extrude the chip rides the arrow last grabbed.
      const regionChipRig =
        offsetRigRef.current && offsetRigRef.current === regionRigRef.current
          ? regionChipRigRef.current
          : null;
      const rig =
        cylinderRadiusRigRef.current ??
        regionChipRig ??
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
          const mode = cylinderDimensionModeRef.current;
          const displayValue = mode === 'diameter' ? rawValue * 2 : rawValue;
          text = `${mode === 'diameter' ? 'Ø' : 'R'} ${formatNumber(displayValue)} ${unitLabelRef.current}`;
        } else if (rig.kind === 'edge-radius') {
          const prefix = edgeHandleOpRef.current === 'fillet' ? 'R' : 'C';
          const label = edgeHandleRef.current?.label;
          text = `${label ? `${label} · ` : ''}${prefix} ${value} ${unitLabelRef.current}`;
        } else {
          // "Total" reads the whole span this face sets: a primitive's own
          // height when it has one, else the body's reach behind the face.
          const totalBaseline = offsetHandleRef.current?.totalBaseline;
          const totalSense = offsetHandleRef.current?.totalSense ?? 1;
          text = offsetChipText({
            rawValue,
            mode: offsetChipModeRef.current,
            span: totalBaseline ?? offsetExtentRef.current,
            sense: totalSense,
            units: unitLabelRef.current
          });
          if (offsetPreviewInvalidRef.current) {
            text = `⚠ ${text}`;
          }
        }
      }
      if (!anchor) {
        chipLayoutKey = null;
        chip.hidden = true;
        radiusLabelChip.hidden = true;
        keypadAnchorRef.current?.(null);
        if (E2E_CANVAS_HOOKS_ENABLED) {
          delete renderer.domElement.dataset.e2eHandleX;
          delete renderer.domElement.dataset.e2eHandleY;
          delete renderer.domElement.dataset.e2eHandleDx;
          delete renderer.domElement.dataset.e2eHandleDy;
          delete renderer.domElement.dataset.e2eHandlePixelsPerUnit;
          delete renderer.domElement.dataset.e2eOffsetChangeVisible;
          delete renderer.domElement.dataset.e2eChipAnchorX;
          delete renderer.domElement.dataset.e2eChipAnchorY;
          delete renderer.domElement.dataset.e2eChipAnchorWorldX;
          delete renderer.domElement.dataset.e2eChipAnchorWorldY;
          delete renderer.domElement.dataset.e2eChipAnchorWorldZ;
          delete renderer.domElement.dataset.e2eChipAnchorRig;
        }
        return;
      }
      let screen = projectToScreen(
        anchor,
        context.activeCamera,
        canvasWidth(),
        canvasHeight()
      );
      if (!screen) {
        chipLayoutKey = null;
        chip.hidden = true;
        radiusLabelChip.hidden = true;
        keypadAnchorRef.current?.(null);
        if (E2E_CANVAS_HOOKS_ENABLED) {
          delete renderer.domElement.dataset.e2eChipAnchorX;
          delete renderer.domElement.dataset.e2eChipAnchorY;
          delete renderer.domElement.dataset.e2eChipAnchorWorldX;
          delete renderer.domElement.dataset.e2eChipAnchorWorldY;
          delete renderer.domElement.dataset.e2eChipAnchorWorldZ;
          delete renderer.domElement.dataset.e2eChipAnchorRig;
        }
        return;
      }
      // The cylinder chip rides its radius line, but a line seen nearly
      // end-on has no room on it: the chip would land on the pin. It then
      // hangs beside the pin like the offset chip does.
      let dimensionChipBesidePin = false;
      if (rig?.kind === 'cylinder-radius') {
        const pinScreen = projectToScreen(
          rig.group.position,
          context.activeCamera,
          canvasWidth(),
          canvasHeight()
        );
        // The pill starts at the anchor and runs toward the pin, so it
        // reaches the pin once the gap between them is shorter than the
        // pill itself (last frame's width) plus the pin's half-extent.
        const gapToPin = pinScreen
          ? Math.hypot(pinScreen.x - screen.x, pinScreen.y - screen.y)
          : 0;
        // Hysteresis: the pill is wider in one layout than the other, and
        // measuring last frame's width would otherwise flip the decision
        // every frame right at the threshold, so the chip never settles.
        const pillReach =
          chipWidth +
          DIMENSION_CHIP_PIN_CLEARANCE_PX +
          (dimensionChipBesidePinRef.current ? 24 : 0);
        // Zoomed in on the wall, the 45% point of the radius is off the
        // canvas while the pin is still in view: the value follows the pin.
        const anchorOffCanvas =
          screen.x < 0 ||
          screen.y < 0 ||
          screen.x > canvasWidth() ||
          screen.y > canvasHeight();
        if (pinScreen && (gapToPin < pillReach || anchorOffCanvas)) {
          dimensionChipBesidePin = true;
          screen = pinScreen;
        }
        dimensionChipBesidePinRef.current = dimensionChipBesidePin;
      }
      // A rig with a dimension line lays its label along the line, rotated
      // to read with it, once the line is long enough on screen to carry
      // the two pills. Otherwise the label hangs beside the pin.
      let lineAngle: number | null = null;
      const line =
        rig && !dimensionChipBesidePin && rig.kind !== 'edge-radius'
          ? (rig.chipLine?.() ?? null)
          : null;
      if (line) {
        const start = projectToScreen(
          line.start,
          context.activeCamera,
          canvasWidth(),
          canvasHeight()
        );
        const end = projectToScreen(
          line.end,
          context.activeCamera,
          canvasWidth(),
          canvasHeight()
        );
        if (start && end) {
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          if (Math.hypot(dx, dy) >= LINE_LABEL_MIN_PX) {
            lineAngle = Math.atan2(dy, dx);
            // Text reads left to right: flip a line that runs leftward.
            if (lineAngle > Math.PI / 2) {
              lineAngle -= Math.PI;
            } else if (lineAngle < -Math.PI / 2) {
              lineAngle += Math.PI;
            }
          }
        }
      }
      // Where the pin itself projects, when the label hangs beside it.
      let pinScreenAt: { x: number; y: number } | null = null;
      if (
        rig &&
        lineAngle === null &&
        (rig.kind === 'offset-face' || dimensionChipBesidePin)
      ) {
        // The chip hangs beside the pin, perpendicular to the drag axis on
        // screen and always to the right, at a fixed pixel gap: it stays
        // clear of both arrow heads however the face is foreshortened.
        const axis = screenDirectionFor(rig.group.position, rig.direction);
        let sideX = -axis.directionY;
        let sideY = axis.directionX;
        if (sideX < 0 || (sideX === 0 && sideY > 0)) {
          sideX = -sideX;
          sideY = -sideY;
        }
        const pinScreen = screen;
        pinScreenAt = pinScreen;
        screen = {
          ...screen,
          x: screen.x + sideX * PIN_CHIP_GAP_PX,
          y: screen.y + sideY * PIN_CHIP_GAP_PX
        };
        // The right lane's first panel (the command card, the inspector, or
        // the model drawer alone) shares the lane's left edge with whatever
        // is under it.
        if (laneLeft !== null) {
          const inspectorLeft = laneLeft;
          // A cap or region anchor can project underneath its floating
          // editor. Rather than clamp the chip back onto the pin, swap it to
          // the pin's other side; only if that is under the editor too does
          // it clamp, so exact entry remains reachable.
          if (screen.x > inspectorLeft - CHIP_LANE_CLEARANCE_PX) {
            screen = {
              x: pinScreen.x - sideX * PIN_CHIP_GAP_PX,
              y: pinScreen.y - sideY * PIN_CHIP_GAP_PX
            };
          }
          screen = {
            ...screen,
            x: Math.min(screen.x, inspectorLeft - CHIP_LANE_CLEARANCE_PX)
          };
        }
      }
      if (e2eCanvasHooksEnabled && rig) {
        renderer.domElement.dataset.e2eChipAnchorX = String(screen.x);
        renderer.domElement.dataset.e2eChipAnchorY = String(screen.y);
        renderer.domElement.dataset.e2eChipAnchorWorldX = String(anchor.x);
        renderer.domElement.dataset.e2eChipAnchorWorldY = String(anchor.y);
        renderer.domElement.dataset.e2eChipAnchorWorldZ = String(anchor.z);
        renderer.domElement.dataset.e2eChipAnchorRig = rig.kind;
      }
      if (e2eCanvasHooksEnabled && rig?.kind === 'cylinder-radius') {
        const scale =
          (rig.group.userData.gizmoScale as number | undefined) ?? 1;
        const hitCenter = rig.group.position
          .clone()
          .addScaledVector(rig.direction, 0.4 * scale);
        const hitScreen = projectToScreen(
          hitCenter,
          context.activeCamera,
          canvasWidth(),
          canvasHeight()
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
      } else if (e2eCanvasHooksEnabled && rig?.kind === 'offset-face') {
        const scale =
          (rig.group.userData.gizmoScale as number | undefined) ?? 1;
        // On the shaft just below the pin: the arrow is half a unit long
        // now, so anything further out misses its hit volume.
        const hitCenter = rig.group.position
          .clone()
          .addScaledVector(rig.direction, -0.4 * scale);
        const hitScreen = projectToScreen(
          hitCenter,
          context.activeCamera,
          canvasWidth(),
          canvasHeight()
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
        renderer.domElement.dataset.e2eOffsetChangeVisible = String(
          rig.worldGroup.getObjectByName('offset-change-arrow')?.visible ===
            true
        );
      }
      if (rig?.kind === 'cylinder-radius') {
        // Drawing-annotation typography: the units render small after the
        // number, so the chip reads "R 35ₘₘ" rather than uniform text.
        const units = document.createElement('small');
        units.textContent = unitLabelRef.current;
        const mode = cylinderDimensionModeRef.current;
        const displayValue =
          mode === 'diameter' ? rig.value() * 2 : rig.value();
        dimensionPrefix.textContent = mode === 'diameter' ? 'Ø' : 'R';
        dimensionPrefix.setAttribute(
          'aria-label',
          mode === 'diameter'
            ? 'Switch to radius entry'
            : 'Switch to diameter entry'
        );
        chip.replaceChildren(
          dimensionPrefix,
          ` ${formatNumber(displayValue)}\u00a0`,
          units
        );
      } else {
        renderChipText(chip, text);
      }
      chip.dataset.variant =
        lineAngle !== null
          ? 'line'
          : rig?.kind === 'cylinder-radius'
            ? dimensionChipBesidePin
              ? 'pin'
              : 'dimension'
            : rig?.kind === 'offset-face'
              ? 'pin'
              : 'default';
      // A chip at its starting value, with no hand on it, is a tap target
      // for exact entry and nothing more: it recedes until something moves.
      const engaged =
        offsetDragActiveRef.current ||
        cylinderRadiusDragActiveRef.current ||
        edgeDragActiveRef.current ||
        (rig !== null &&
          rig.kind !== 'cylinder-radius' &&
          Math.abs(rig.value()) > 1e-9);
      chip.dataset.engaged = String(engaged);
      // Any armed rig can hold a refused value: the flag is the operation's
      // failed phase, whichever handle is driving it.
      const offsetWarning = offsetPreviewInvalidRef.current;
      // A refused value outranks a deferred one: both are true while a slow
      // gesture drifts out of range, and the refusal is the actionable half.
      chip.dataset.state = offsetWarning
        ? 'warning'
        : previewDeferredRef.current
          ? 'deferred'
          : 'ready';
      chip.title = previewDeferredRef.current
        ? 'Preview is catching up — the shape follows as fast as the kernel can rebuild it.'
        : '';
      chip.setAttribute(
        'aria-busy',
        String(previewDeferredRef.current && !offsetWarning)
      );
      chip.setAttribute('aria-invalid', String(offsetWarning));
      // What the tag beside the value says, when there is a line to name:
      // the radius line's Diameter/Radius, or the offset line's Total/Offset
      // switch (only a switch when a span is known to switch to).
      let tagText: string | null = null;
      if (rig?.kind === 'cylinder-radius') {
        tagText =
          cylinderDimensionModeRef.current === 'diameter'
            ? 'Diameter'
            : 'Radius';
      } else if (rig?.kind === 'offset-face' && lineAngle !== null) {
        tagText =
          offsetChipModeRef.current === 'total' ? 'Total ▾' : 'Offset ▾';
      }
      if (lineAngle !== null) {
        // Both pills ride the line, rotated to read along it: the tag first,
        // then the value, each pushed half its own width out from the anchor
        // so they sit end to end with a little air between.
        const degrees = (lineAngle * 180) / Math.PI;
        chip.style.setProperty('--chip-rotate', `${degrees}deg`);
        radiusLabelChip.style.setProperty('--chip-rotate', `${degrees}deg`);
        radiusLabelChip.dataset.variant = 'line';
        const alongX = Math.cos(lineAngle);
        const alongY = Math.sin(lineAngle);
        const half = LINE_LABEL_GAP_PX / 2;
        const valueReach = chipWidth / 2 + half;
        place(
          chip,
          screen.x + alongX * valueReach,
          screen.y + alongY * valueReach
        );
        if (tagText !== null) {
          radiusLabelChip.textContent = tagText;
          const tagReach = labelWidth / 2 + half;
          place(
            radiusLabelChip,
            screen.x - alongX * tagReach,
            screen.y - alongY * tagReach
          );
        } else {
          radiusLabelChip.hidden = true;
        }
      } else {
        chip.style.removeProperty('--chip-rotate');
        radiusLabelChip.style.removeProperty('--chip-rotate');
        delete radiusLabelChip.dataset.variant;
        // An edge's chip stays clear of the right lane too (the pin variants
        // dodge it above): past the dock and the inspector the lane reaches
        // well into the stage, and a value under it cannot be tapped.
        place(
          chip,
          chip.dataset.variant === 'default'
            ? edgeChipCenterX(screen.x, laneLeft, chipWidth)
            : screen.x,
          screen.y
        );
        const offsetSpan =
          offsetHandleRef.current?.totalBaseline ?? offsetExtentRef.current;
        if (rig?.kind === 'cylinder-radius' && !dimensionChipBesidePin) {
          radiusLabelChip.textContent = tagText ?? '';
          // Same anchor; CSS shifts it to sit flush against the value pill.
          place(radiusLabelChip, screen.x, screen.y);
        } else if (
          rig?.kind === 'cylinder-radius' ||
          (rig?.kind === 'offset-face' &&
            offsetSpan !== null &&
            offsetSpan !== undefined)
        ) {
          // Beside the pin the tag stays reachable — the Total/Offset
          // switch, or the Diameter/Radius name that also opens exact
          // entry — flush against the value chip's left edge.
          radiusLabelChip.textContent =
            rig.kind === 'cylinder-radius'
              ? (tagText ?? '')
              : offsetChipModeRef.current === 'total'
                ? 'Total ▾'
                : 'Offset ▾';
          if (rig.kind === 'offset-face' && pinScreenAt) {
            // The pair reads tag then value and stays clear of the pin: on
            // the pin's right it starts just past the pin, on its left it
            // ends there. Centred on the anchor instead, the tag reached
            // back over the pin whenever the axis pointed at the camera.
            const clearance = PIN_CHIP_GAP_PX / 2;
            const tagWidth = labelWidth;
            const valueWidth = chipWidth;
            const width = tagWidth + 2 + valueWidth;
            // The whole pair keeps out from under the right lane (the anchor
            // dodge above only reserves a centred value's width): one that
            // would reach it goes to the pin's other side, and clamps only
            // when that side is under the lane too.
            const limit =
              laneLeft !== null ? laneLeft - 8 : Number.POSITIVE_INFINITY;
            let start =
              screen.x >= pinScreenAt.x
                ? screen.x - clearance
                : screen.x + clearance - width;
            if (start + width > limit) {
              start = Math.min(
                pinScreenAt.x - clearance - width,
                limit - width
              );
            }
            place(chip, start + tagWidth + 2 + valueWidth / 2, screen.y);
            place(radiusLabelChip, start + tagWidth, screen.y);
          } else {
            place(radiusLabelChip, screen.x - chipWidth / 2 - 2, screen.y);
          }
        } else {
          radiusLabelChip.hidden = true;
        }
      }
      const layoutKey = [
        chip.hidden,
        chip.textContent,
        chip.dataset.variant,
        radiusLabelChip.hidden,
        radiusLabelChip.textContent,
        // A new dodge places the chip again once it has moved.
        chipDodge.dx,
        chipDodge.dy
      ].join('|');
      if (layoutKey !== chipLayoutKey) requestRender();
      chipLayoutKey = layoutKey;
      keypadAnchorRef.current?.(screen);
    }

    function positionDragHud(
      event: PointerEvent,
      value: number,
      axis: DirectEditAxis
    ) {
      const label = axisDimensionLabel(axis);
      dragHud.textContent = `${label} ${Math.round(value * 100) / 100} ${unitLabelRef.current}`;
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

    /** Sketch-local point under the cursor: entity snap, then grid snap. */
    function sketchPointAt(
      event: PointerEvent,
      targets: readonly SnapTarget[] = snapTargetsRef.current
    ): SketchPoint | null {
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
      sketchPointerOnCanvas = true;
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
          targets,
          mode.snapTolerancePx * sketchWorldPerPixel(mode.basis.origin),
          {
            lockedId: activeSketchSnap?.id,
            cycle: sketchSnapCycle
          }
        );
        if (resolved) {
          activeSketchSnap = resolved.target;
          positionSketchSnapMarker(
            event,
            resolved.target.kind,
            resolved.target.label
          );
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
      kind: SnapTargetKind,
      label = SKETCH_SNAP_LABELS[kind]
    ) {
      sketchSnapMarker.dataset.kind = kind;
      if (kind === 'grid') {
        delete sketchSnapMarker.dataset.label;
      } else {
        sketchSnapMarker.dataset.label = label;
      }
      sketchSnapMarker.textContent = SKETCH_SNAP_GLYPHS[kind];
      sketchSnapMarker.title = label;
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
        canvasWidth(),
        canvasHeight()
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
        ? `${text} ${unitLabelRef.current}`
        : text;
      hud.showAtPointer(sketchDimLabel, event, 16, -28);
    }

    function hideSketchDimLabel() {
      const label = sketchDimLabelRef.current;
      if (label) {
        label.hidden = true;
      }
    }

    const SKETCH_NUMERIC_LABELS = {
      radius: 'Radius',
      diameter: 'Diameter',
      circumradius: 'Circumradius',
      length: 'Length',
      width: 'Width',
      height: 'Height'
    } as const;

    function renderSketchNumericHud(event: PointerEvent) {
      const label = SKETCH_NUMERIC_LABELS[sketchNumericKind];
      const units = unitLabelRef.current;
      // A rectangle shows both sides at once, so it is clear which one Tab is
      // about to take you to and what the other already holds.
      const text =
        sketchNumericKind === 'width' || sketchNumericKind === 'height'
          ? (() => {
              const other = sketchNumericKind === 'width' ? 'Height' : 'Width';
              return `${label}: ${sketchNumericRaw || '…'} ${units} · ${other}: ${
                sketchNumericOther || 'drag'
              } · Tab · Enter`;
            })()
          : `${label}: ${sketchNumericRaw || '…'} ${units} · Enter`;
      sketchDimLabel.textContent = text;
      sketchDimLabel.dataset.editing = 'true';
      hud.showAtPointer(sketchDimLabel, event, 16, -28);
    }

    function finishSketchNumericEntry() {
      sketchNumericRaw = null;
      sketchNumericOther = null;
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
      if (mode.tool === 'rectangle' && gesture.dragStart) {
        // Whichever side was not typed keeps the size the drag is showing, so
        // typing one number pins that side and leaves the other under the
        // pointer rather than refusing the whole entry.
        const live = latestSketchPoint ?? gesture.dragStart;
        const typedOther = Number(sketchNumericOther);
        const otherValue =
          sketchNumericOther !== null &&
          sketchNumericOther !== '' &&
          Number.isFinite(typedOther) &&
          typedOther > 0
            ? typedOther
            : null;
        const rectangle = typedRectangleShape(
          mode.rectangleMode === 'center' ? 'center' : 'corner',
          gesture.dragStart,
          live,
          {
            width: sketchNumericKind === 'width' ? value : otherValue,
            height: sketchNumericKind === 'height' ? value : otherValue
          }
        );
        if (!rectangle) {
          return false;
        }
        onSketchCommitCompositeRef.current(rectangle);
        gesture.dragStart = null;
        gesture.awaitingSecondPoint = false;
        sketchRigRef.current?.setInProgress(null, false);
        onSketchDrawingChangeRef.current(false);
        finishSketchNumericEntry();
        requestRender();
        return true;
      }
      if (mode.tool === 'polygon' && gesture.dragStart) {
        // The typed value is the circumradius; the pointer keeps the
        // rotation, as it does for a typed line length.
        const vertex = pointAtDistanceAlongDirection(
          gesture.dragStart,
          latestSketchPoint ?? {
            x: gesture.dragStart.x,
            y: gesture.dragStart.y + 1
          },
          value
        );
        const polygon = inscribedPolygonShape(
          gesture.dragStart,
          vertex,
          mode.polygonSides
        );
        if (!polygon) {
          return false;
        }
        onSketchCommitCompositeRef.current(polygon);
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

    /** Ends the curve tool's gesture after a commit or a refusal-free reset. */
    function resetSketchCurve() {
      sketchGestureRef.current.curvePoints = [];
      sketchRigRef.current?.setInProgress(null, false);
      sketchRigRef.current?.setInference(null);
      hideSketchDimLabel();
      onSketchDrawingChangeRef.current(false);
    }

    /**
     * Commits the spline through the placed points; false (with the reason
     * on the cursor label) when they cannot make one yet.
     */
    function finishSketchSpline(closed: boolean): boolean {
      const mode = sketchModeRef.current;
      if (!mode) {
        return false;
      }
      const method =
        sketchCurveModeFor('spline', mode.curveMode) === 'control-spline'
          ? 'control'
          : 'fit';
      const spline = splineObjectFromPoints(
        method,
        sketchGestureRef.current.curvePoints,
        closed
      );
      if (!spline) {
        if (latestSketchPointerEvent) {
          positionSketchDimLabel(
            latestSketchPointerEvent,
            'A spline needs at least three distinct points',
            false
          );
        }
        return false;
      }
      onSketchCommitRef.current(spline);
      resetSketchCurve();
      requestRender();
      return true;
    }

    /**
     * One click of the ellipse or spline tool (I01). An ellipse takes its
     * centre, an axis end and the other radius, then for an elliptical arc
     * its start and end. A spline takes points until Enter, a click on its
     * last point again, or a click on its first point, which closes it.
     */
    function placeSketchCurvePoint(event: PointerEvent, point: SketchPoint) {
      const mode = sketchModeRef.current;
      if (!mode) {
        return;
      }
      const points = sketchGestureRef.current.curvePoints;
      const curveMode = sketchCurveModeFor(
        mode.tool === 'spline' ? 'spline' : 'ellipse',
        mode.curveMode
      );
      if (points.length === 0) {
        finishSketchNumericEntry();
        points.push(point);
        onSketchDrawingChangeRef.current(true);
        return;
      }
      if (mode.tool === 'spline') {
        const reach = Math.max(
          0.5,
          sketchWorldPerPixel(mode.basis.origin) * mode.snapTolerancePx
        );
        const action = splineClickAction(points, point, reach);
        if (action === 'close') {
          finishSketchSpline(true);
        } else if (action === 'finish') {
          finishSketchSpline(false);
        } else {
          points.push(point);
          if (action === 'append-and-finish') {
            finishSketchSpline(false);
          }
        }
        return;
      }
      const [center, axisEnd, radiusPoint, arcStart] = points;
      if (!axisEnd) {
        if (Math.hypot(point.x - center!.x, point.y - center!.y) >= 0.5) {
          points.push(point);
        }
        return;
      }
      const ellipse = ellipseObjectFromPoints(
        center!,
        axisEnd,
        radiusPoint ?? point
      );
      if (!ellipse) {
        positionSketchDimLabel(
          event,
          'Move away from the axis to set the other radius',
          false
        );
        return;
      }
      if (!radiusPoint) {
        if (curveMode === 'ellipse') {
          onSketchCommitRef.current(ellipse);
          resetSketchCurve();
        } else {
          points.push(point);
        }
        return;
      }
      if (!arcStart) {
        points.push(point);
        return;
      }
      const arc = ellipticalArcObject(ellipse, arcStart, point);
      if (arc) {
        onSketchCommitRef.current(arc);
        resetSketchCurve();
      }
    }

    /** The in-progress curve under the pointer, with its measure. */
    function previewSketchCurve(event: PointerEvent, point: SketchPoint) {
      const mode = sketchModeRef.current;
      const rig = sketchRigRef.current;
      if (!mode || !rig) {
        return;
      }
      const points = sketchGestureRef.current.curvePoints;
      const round = (value: number) => Math.round(value * 1000) / 1000;
      if (mode.tool === 'spline') {
        const control =
          sketchCurveModeFor('spline', mode.curveMode) === 'control-spline';
        const candidate = [...points, point];
        const spline = splineObjectFromPoints(
          control ? 'control' : 'fit',
          candidate,
          false
        );
        rig.setInProgress(
          spline ? curvePreviewPoints(spline).points : candidate,
          false
        );
        // A control spline's polygon is the handle it is drawn with.
        rig.setInference(
          control
            ? candidate
                .slice(1)
                .map((next, index) => [candidate[index]!, next] as const)
            : null
        );
        positionSketchDimLabel(
          event,
          `${candidate.length} points · Enter finishes`,
          false
        );
        return;
      }
      const [center, axisEnd, radiusPoint, arcStart] = points;
      if (!axisEnd) {
        rig.setInProgress([center!, point], false);
        positionSketchDimLabel(
          event,
          `R ${round(Math.hypot(point.x - center!.x, point.y - center!.y))} ${unitLabelRef.current}`,
          false
        );
        return;
      }
      const ellipse = ellipseObjectFromPoints(
        center!,
        axisEnd,
        radiusPoint ?? point
      );
      if (!ellipse) {
        rig.setInProgress([center!, axisEnd], false);
        return;
      }
      if (!radiusPoint || !arcStart) {
        rig.setInProgress(curvePreviewPoints(ellipse).points, true);
        rig.setInference(radiusPoint ? [[center!, point]] : null);
        positionSketchDimLabel(
          event,
          radiusPoint
            ? 'Place the arc start'
            : `R ${round(Number(ellipse.radiusX))} × ${round(Number(ellipse.radiusY))} ${unitLabelRef.current}`,
          false
        );
        return;
      }
      const arc = ellipticalArcObject(ellipse, arcStart, point);
      if (arc) {
        rig.setInProgress(curvePreviewPoints(arc).points, false);
        positionSketchDimLabel(
          event,
          `${round(Number(arc.endParamDeg) - Number(arc.startParamDeg))}°`,
          false
        );
      }
    }

    function handleSketchNumericKey(event: KeyboardEvent): boolean {
      const mode = sketchModeRef.current;
      const gesture = sketchGestureRef.current;
      const supported =
        mode &&
        ((mode.tool === 'circle' &&
          mode.circleMode !== 'three-point' &&
          gesture.dragStart !== null) ||
          ((mode.tool === 'rectangle' || mode.tool === 'polygon') &&
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
        if (mode.tool === 'rectangle') {
          // Park this side and edit the other. Tab is a swap, not a
          // conversion: a rectangle's two sides are independent, unlike a
          // circle's radius and diameter.
          const parked = sketchNumericRaw;
          sketchNumericRaw = sketchNumericOther ?? '';
          sketchNumericOther = parked;
          sketchNumericKind =
            sketchNumericKind === 'width' ? 'height' : 'width';
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
              : mode.tool === 'rectangle'
                ? 'width'
                : mode.tool === 'polygon'
                  ? 'circumradius'
                  : 'length';
          sketchNumericRaw = '';
          sketchNumericOther = null;
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

    /**
     * Center discovery guides: the dashed axes through the nearest exact
     * centre and its beacon, shown before the snap engages. Shared by the
     * drawing tools and the object drag, so a moved centre finds its
     * destination the same way a new one does.
     */
    function showSketchCenterInference(
      point: SketchPoint,
      targets: readonly SnapTarget[]
    ) {
      const mode = sketchModeRef.current;
      const rig = sketchRigRef.current;
      if (!mode || !rig) {
        return;
      }
      const worldPerPixel = sketchWorldPerPixel(mode.basis.origin);
      const discoveryRadiusPx = Math.max(mode.snapTolerancePx * 6, 48);
      const centerTarget = nearestCenterGuideTarget(
        point,
        targets,
        discoveryRadiusPx * worldPerPixel
      );
      if (centerTarget) {
        const halfSpan =
          worldPerPixel * Math.max(canvasWidth(), canvasHeight()) * 0.65;
        rig.setInference(centerInferenceSegments(centerTarget, halfSpan));
        positionSketchCenterTarget(
          centerTarget,
          activeSketchSnap?.id === centerTarget.id
        );
      }
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
      if (
        mode.tool !== 'select' &&
        mode.tool !== 'project' &&
        mode.inferenceEnabled &&
        !event.shiftKey
      ) {
        showSketchCenterInference(point, snapTargetsRef.current);
      }
      if (
        mode.tool === 'rectangle' &&
        mode.rectangleMode === 'three-point' &&
        gesture.circleFirst
      ) {
        if (!gesture.circleSecond) {
          rig.setInProgress([gesture.circleFirst, point], false);
          positionSketchDimLabel(
            event,
            `${Math.round(Math.hypot(point.x - gesture.circleFirst.x, point.y - gesture.circleFirst.y) * 1000) / 1000} ${unitLabelRef.current} · point 2 of 3`,
            false
          );
        } else {
          const shape = threePointRectangleShape(
            gesture.circleFirst,
            gesture.circleSecond,
            point
          );
          if (isCompositeShape(shape)) {
            rig.setInProgress(shape.corners, true);
            positionSketchDimLabel(event, compositeSizeLabel(shape), false);
          } else {
            rig.setInProgress(
              [gesture.circleFirst, gesture.circleSecond],
              false
            );
            positionSketchDimLabel(event, shape.refusal, false);
          }
        }
        requestRender();
        return;
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
              `R ${Math.round(Number(circle.radius) * 1000) / 1000} ${unitLabelRef.current} · Ø ${Math.round(Number(circle.radius) * 2000) / 1000} ${unitLabelRef.current}`,
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
        (mode.tool === 'rectangle' || mode.tool === 'polygon')
      ) {
        const shape = dragCompositeShape(
          mode.tool,
          mode.rectangleMode,
          mode.polygonSides,
          gesture.dragStart,
          point
        );
        if (shape) {
          rig.setInProgress(shape.corners, true);
          positionSketchDimLabel(event, compositeSizeLabel(shape));
        } else {
          rig.setInProgress([gesture.dragStart, point], false);
        }
        requestRender();
        return;
      }
      if (gesture.dragStart && mode.tool === 'circle') {
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
            `R ${Math.round(radius * 1000) / 1000} ${unitLabelRef.current} · Ø ${Math.round(radius * 2000) / 1000} ${unitLabelRef.current}`,
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
          `${dimensionForInProgress('line', gesture.chainAnchor, locked.point)} ${unitLabelRef.current} · ${angleForInProgress(gesture.chainAnchor, locked.point)}°`,
          false
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
            `R ${Math.round(dimension.radius * 10) / 10} ${unitLabelRef.current} · ${Math.round(dimension.sweepDeg * 10) / 10}°`,
            false
          );
        }
        requestRender();
        return;
      }
      if (
        (mode.tool === 'ellipse' || mode.tool === 'spline') &&
        gesture.curvePoints.length > 0
      ) {
        previewSketchCurve(event, point);
        requestRender();
        return;
      }
      if (mode.tool === 'text') {
        // The outline follows the pointer: a pure slide in the plane, laid
        // out again only when the draft changes.
        textAnchorRef.current = point;
        const sink = sketchTextAnchorSinkRef.current;
        if (sink) {
          sink.current = point;
        }
        rig.moveTextPreview(point);
        requestRender();
      }
    }

    /** Plane point under the pointer with no snapping at all. */
    function rawSketchPointAt(event: PointerEvent): SketchPoint | null {
      const mode = sketchModeRef.current;
      if (!mode) {
        return null;
      }
      setRayFromEvent(event);
      return screenRayToPlanePoint(
        context.raycaster.ray.origin,
        context.raycaster.ray.direction,
        mode.basis
      );
    }

    /** The selected object, when a press on it may start a drag-move. */
    function movableSketchSelection(): {
      mode: SketchModeState;
      id: string;
      data: SketchObjectData;
    } | null {
      const mode = sketchModeRef.current;
      if (
        !mode ||
        !sketchMoveEnabledRef.current ||
        mode.tool !== 'select' ||
        mode.drawing ||
        !mode.selectedObjectId
      ) {
        return null;
      }
      const object = mode.objects.find(
        (candidate) => candidate.id === mode.selectedObjectId
      );
      if (!object || !sketchObjectMovable(object.data)) {
        return null;
      }
      return { mode, id: object.id, data: object.data };
    }

    /**
     * A press on the selected object's grab point (or its text ring, or
     * anywhere along a selected line or arc) arms a drag-move. The drag only
     * starts once the press travels: a press that stays put is still the
     * click it always was.
     */
    function beginSketchMove(event: PointerEvent): boolean {
      if (sketchMoveRef.current) {
        return false;
      }
      const selection = movableSketchSelection();
      const press = rawSketchPointAt(event);
      if (!selection || !press) {
        return false;
      }
      const { mode, id, data } = selection;
      const resolve = sketchModeResolver(mode);
      const perPixel = sketchWorldPerPixel(mode.basis.origin);
      const grabPoint = sketchObjectGrabPoint(data, resolve);
      let handle: SketchMoveHandle | null = null;
      let grab: SketchPoint | null = null;
      let anchored = false;
      if (grabPoint) {
        // Hit-test where the dot and ring are drawn, in screen pixels.
        const basis = mode.basis;
        const grabScreen = projectToScreen(
          new THREE.Vector3(
            basis.origin.x + basis.u.x * grabPoint.x + basis.v.x * grabPoint.y,
            basis.origin.y + basis.u.y * grabPoint.x + basis.v.y * grabPoint.y,
            basis.origin.z + basis.u.z * grabPoint.x + basis.v.z * grabPoint.y
          ),
          context.activeCamera,
          canvasWidth(),
          canvasHeight()
        );
        const pointer = hud.toLocal(event.clientX, event.clientY);
        const hit =
          grabScreen && pointer
            ? sketchHandleAtScreen(
                pointer,
                grabScreen,
                sketchObjectRotatable(data)
              )
            : null;
        if (hit === 'translate') {
          handle = 'translate';
          grab = grabPoint;
          anchored = true;
        } else if (hit === 'rotate') {
          handle = 'rotate';
          grab = press;
        }
      } else if (sketchObjectGrabbedAlongCurve(data)) {
        setRayFromEvent(event);
        const hitId = sketchRigRef.current?.pickObject(
          context.raycaster,
          worldPerPixelAt(
            new THREE.Vector3(
              mode.basis.origin.x,
              mode.basis.origin.y,
              mode.basis.origin.z
            )
          ) * 8
        );
        if (hitId === id) {
          // Grabbed along the curve. A press near one of its own points
          // takes that point exactly, so an endpoint dragged onto another
          // snap lands on it rather than a few pixels off.
          const own = resolveSketchSnap(
            press,
            snapTargetsForObject(data, resolve, id),
            mode.snapTolerancePx * perPixel
          );
          handle = 'translate';
          grab = own ? { x: own.target.x, y: own.target.y } : press;
        }
      }
      if (!handle || !grab) {
        return false;
      }
      let targets: SnapTarget[];
      try {
        targets = collectSketchSnapTargets(
          mode.objects.filter((object) => object.id !== id),
          resolve,
          mode.composites,
          requiredValueResolver(mode.parameterScope, mode.units ?? 'mm')
        );
      } catch {
        targets = [{ id: 'sketch-origin', x: 0, y: 0, kind: 'origin' }];
      }
      sketchMoveRef.current = {
        pointerId: event.pointerId,
        objectId: id,
        handle,
        original: data,
        grab,
        anchored,
        origin: grabPoint ?? grab,
        startRotation:
          data.objectKind === 'text' ? resolve(data.rotation ?? 0) : 0,
        targets,
        preview: null,
        active: false
      };
      gestures.capture(event, 'grabbing');
      event.preventDefault();
      return true;
    }

    function updateSketchMove(event: PointerEvent) {
      const drag = sketchMoveRef.current;
      const mode = sketchModeRef.current;
      const rig = sketchRigRef.current;
      if (!drag || !mode || !rig) {
        return;
      }
      if (!drag.active) {
        if (!gestures.hasMoved(event)) {
          return;
        }
        drag.active = true;
        rig.setProfiles([], false);
        onSketchMoveChangeRef.current?.({
          type: 'sketch-move-start',
          objectId: drag.objectId,
          handle: drag.handle
        });
      }
      const resolve = sketchModeResolver(mode);
      rig.setInference(null);
      sketchCenterTarget.hidden = true;
      if (drag.handle === 'rotate') {
        const to = rawSketchPointAt(event);
        if (!to) {
          return;
        }
        const rotation = textRotationFromRingDrag(
          drag.origin,
          drag.grab,
          to,
          drag.startRotation,
          event.shiftKey
        );
        drag.preview = rotateTextObject(drag.original, rotation);
        positionSketchDimLabel(event, `${formatNumber(rotation)}°`, false);
      } else {
        const snapped = sketchPointAt(event, drag.targets);
        if (!snapped) {
          return;
        }
        let point = snapped;
        const raw = rawSketchPointAt(event);
        if (
          !drag.anchored &&
          !activeSketchSnap &&
          mode.snapStep &&
          !event.shiftKey &&
          raw
        ) {
          // A curve grabbed between its points has no point of its own on
          // the grid, so the grid steps its travel instead: a line that was
          // on the grid stays on it.
          const step = mode.snapStep;
          point = {
            x: drag.grab.x + Math.round((raw.x - drag.grab.x) / step) * step,
            y: drag.grab.y + Math.round((raw.y - drag.grab.y) / step) * step
          };
        }
        if (mode.inferenceEnabled && !event.shiftKey) {
          // An exact snap wins; without one the move infers horizontal or
          // vertical travel from where the drag began, as a line does from
          // its anchor.
          if (!activeSketchSnap) {
            const locked = axisLockPoint(drag.grab, point);
            point = locked.point;
            if (locked.lockedAxis) {
              rig.setInference([[drag.grab, point]]);
              positionSketchSnapMarker(event, locked.lockedAxis);
            }
          }
          showSketchCenterInference(point, drag.targets);
        }
        drag.preview = drag.anchored
          ? placeSketchObjectGrabPoint(drag.original, point)
          : translateSketchObject(
              drag.original,
              point.x - drag.grab.x,
              point.y - drag.grab.y,
              resolve
            );
        const readout = drag.anchored
          ? `X ${formatNumber(point.x)} · Y ${formatNumber(point.y)}`
          : `ΔX ${formatNumber(point.x - drag.grab.x)} · ΔY ${formatNumber(point.y - drag.grab.y)}`;
        positionSketchDimLabel(
          event,
          `${readout} ${unitLabelRef.current}`,
          false
        );
      }
      // Only the dragged object is rebuilt; everything else keeps its lines.
      if (drag.preview) {
        rig.setPreviewObject(drag.objectId, drag.preview);
      }
      requestRender();
    }

    /**
     * Ends a sketch move. A commit hands the moved data to the entity-edit
     * path and keeps drawing it until that edit answers; a cancel, an
     * unchanged drop or a refused edit draws the stored geometry again.
     */
    function finishSketchMove(drag: SketchMoveDrag, commit: boolean) {
      if (sketchMoveRef.current === drag) {
        sketchMoveRef.current = null;
      }
      hideSketchDimLabel();
      hideSketchSnapMarker();
      sketchCenterTarget.hidden = true;
      sketchRigRef.current?.setInference(null);
      activeSketchSnap = null;
      const preview = drag.preview;
      const mode = sketchModeRef.current;
      const changed =
        preview !== null &&
        mode !== null &&
        sketchMoveChanged(drag.original, preview, sketchModeResolver(mode));
      if (drag.active) {
        onSketchMoveChangeRef.current?.({
          type: commit && changed ? 'sketch-move-commit' : 'sketch-move-cancel'
        });
      }
      const redraw = () => {
        const mode = sketchModeRef.current;
        const rig = sketchRigRef.current;
        if (mode && rig) {
          drawSketchModeObjects(rig, mode, null);
          rig.setProfiles(mode.profiles, true);
        }
        requestRender();
      };
      if (!commit || !changed || !drag.active || !preview) {
        redraw();
        return;
      }
      // Another tab or a collaborator may have edited the object while it
      // was held: replay the drag onto the object as it is now, so the move
      // lands without discarding their change.
      const current = sketchModeRef.current?.objects.find(
        (object) => object.id === drag.objectId
      )?.data;
      const rebased =
        current && mode
          ? rebaseSketchMove(
              drag.original,
              preview,
              current,
              sketchModeResolver(mode)
            )
          : null;
      if (!rebased || !current) {
        redraw();
        return;
      }
      const pending = {
        objectId: drag.objectId,
        data: rebased,
        original: current
      };
      sketchMoveCommitPendingRef.current = pending;
      const settle = (accepted: boolean) => {
        if (sketchMoveCommitPendingRef.current !== pending) {
          return;
        }
        sketchMoveCommitPendingRef.current = null;
        // An accepted edit changes the document, and the objects effect
        // draws the result when it lands; redrawing here would flash the
        // old position for a frame first.
        if (!accepted) {
          redraw();
        }
      };
      try {
        // The edit path writes the selected object; one that changed under
        // the drag is refused here rather than written to the wrong entity.
        const result =
          sketchModeRef.current?.selectedObjectId === drag.objectId
            ? onSketchMoveCommitRef.current?.(
                drag.objectId,
                rebased,
                drag.handle === 'rotate' ? 'Rotate' : 'Move'
              )
            : false;
        if (result instanceof Promise) {
          result.then(settle, () => settle(false));
        } else {
          settle(result === true);
        }
      } catch {
        settle(false);
      }
      requestRender();
    }

    /**
     * Retires a held sketch move without committing it. The release that
     * follows is swallowed, so it cannot read as a selection click.
     */
    function cancelSketchMove(): boolean {
      const drag = sketchMoveRef.current;
      if (!drag) {
        return false;
      }
      sketchMovePointerGate.suppress(drag.pointerId);
      gestures.release(drag.pointerId, '');
      finishSketchMove(drag, false);
      return true;
    }
    cancelSketchMoveRef.current = cancelSketchMove;

    /** Commits a held sketch move where it is now, as a release would. */
    function commitSketchMove(): boolean {
      const drag = sketchMoveRef.current;
      if (!drag?.active) {
        return false;
      }
      sketchMovePointerGate.suppress(drag.pointerId);
      gestures.release(drag.pointerId, '');
      finishSketchMove(drag, true);
      return true;
    }

    /** Places the grab dot and text ring on the selected object, per frame. */
    function positionSketchMoveHandles() {
      const selection = movableSketchSelection();
      const drag = sketchMoveRef.current;
      const pending = sketchMoveCommitPendingRef.current;
      const data = selection
        ? ((drag?.objectId === selection.id ? drag.preview : null) ??
          (pending?.objectId === selection.id ? pending.data : null) ??
          selection.data)
        : null;
      const grab =
        selection && data
          ? sketchObjectGrabPoint(data, sketchModeResolver(selection.mode))
          : null;
      sketchHandleSpot.shown = false;
      if (!selection || !grab) {
        sketchGrabHandle.hidden = true;
        sketchRotateRing.hidden = true;
        return;
      }
      const basis = selection.mode.basis;
      const screen = projectToScreen(
        new THREE.Vector3(
          basis.origin.x + basis.u.x * grab.x + basis.v.x * grab.y,
          basis.origin.y + basis.u.y * grab.x + basis.v.y * grab.y,
          basis.origin.z + basis.u.z * grab.x + basis.v.z * grab.y
        ),
        context.activeCamera,
        canvasWidth(),
        canvasHeight()
      );
      if (!screen) {
        sketchGrabHandle.hidden = true;
        sketchRotateRing.hidden = true;
        return;
      }
      sketchGrabHandle.dataset.active = String(
        drag?.active === true && drag.handle === 'translate'
      );
      hud.showAt(sketchGrabHandle, screen.x, screen.y);
      sketchHandleSpot.shown = true;
      sketchHandleSpot.x = screen.x;
      sketchHandleSpot.y = screen.y;
      sketchHandleSpot.ring = sketchObjectRotatable(selection.data);
      if (sketchObjectRotatable(selection.data)) {
        sketchRotateRing.dataset.active = String(
          drag?.active === true && drag.handle === 'rotate'
        );
        hud.showAt(sketchRotateRing, screen.x, screen.y);
      } else {
        sketchRotateRing.hidden = true;
      }
    }

    const applyPointerMove = (event: PointerEvent) => {
      if (import.meta.env.OZ_PERF === '1') {
        const scope = window as typeof window & { __ozDragApplies?: number };
        scope.__ozDragApplies = (scope.__ozDragApplies ?? 0) + 1;
      }
      if (boxSelect && event.pointerId === boxSelect.pointerId) {
        if (boxSelect.faceGrab) {
          const rig = offsetRigRef.current;
          const press = boxSelect;
          if (
            rig &&
            !offsetHandleRef.current?.locked &&
            Math.hypot(
              event.clientX - press.startX,
              event.clientY - press.startY
            ) >= BOX_SELECT_MIN_PX
          ) {
            boxSelect = null;
            beginOffsetDrag(
              rig,
              null,
              {
                pointerId: press.pointerId,
                clientX: press.startX,
                clientY: press.startY
              },
              event
            );
            applyPointerMove(event);
          }
          return;
        }
        drawSelectionBand(boxSelect.startX, boxSelect.startY, event);
        return;
      }
      if (sketchModeRef.current) {
        const role = sketchMovePointerRole(
          sketchMoveRef.current?.pointerId,
          event.pointerId
        );
        if (role === 'owner') {
          event.preventDefault();
          updateSketchMove(event);
          return;
        }
        if (
          role === 'other' ||
          sketchMovePointerGate.ignores(event.pointerId)
        ) {
          return;
        }
        if (event.buttons === 0 || event.buttons === 1) {
          updateSketchInProgress(event);
        }
        if (event.buttons !== 2 && event.buttons !== 4) {
          if (event.buttons !== 0 || sketchModeRef.current.tool !== 'select') {
            return;
          }
        }
      }
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
                      SNAP_PROJECT_SCRATCH.set(point.x, point.y, point.z),
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
        // Live values go straight to the panel that shows them. Routing them
        // through workspace state instead would re-render the editor on every
        // pointer event for numbers the scene has already drawn.
        drag.pendingValues = { translation, rotation };
        moveValuesSetterRef?.current?.(translation, rotation, {
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
            // Every applied value goes to the previewer. It keeps one rebuild
            // in flight and drops superseded values, so the geometry follows
            // the hand at whatever rate the kernel can rebuild — no fixed
            // cadence sits between the two.
            if (value > 0 || edgeHandleRef.current?.allowRemoval) {
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
            const usedProxy = queueCylinderRadiusProxy(value, event.timeStamp);
            onCylinderRadiusPreviewRef.current(value, !usedProxy);
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
          const raw =
            offsetDrag.initialOffset + screenDragValue(offsetDrag, dx, dy);
          // Zoom-adaptive snapping, matching the move gizmo; Shift = free.
          const snap = chooseMoveSnapStep(1 / offsetDrag.pixelsPerUnit);
          const value = event.shiftKey
            ? Math.round(raw * 100) / 100
            : Math.round(raw / snap) * snap;
          if (Math.abs(value - rig.value()) > 1e-9) {
            rig.setValue(value);
            traceFaceDrag('pointer', {
              value,
              ms: performance.now() - event.timeStamp
            });
            const exactOnRelease = queueOffsetBodyProxy(value, event.timeStamp);
            onOffsetPreviewRef.current(value, !exactOnRelease);
          }
          renderer.domElement.style.cursor = 'grabbing';
          requestRender();
        }
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
     * Which drag owns this pointer, if any. `band` is the selection rubber
     * band, which is the one drag that never suppressed the browser's default
     * handling; the rest always have.
     */
    function pointerDragKind(event: PointerEvent): 'band' | 'handle' | null {
      const pointerId = event.pointerId;
      if (boxSelect !== null && boxSelect.pointerId === pointerId) {
        return 'band';
      }
      return (moveDrag !== null && moveDrag.pointerId === pointerId) ||
        sketchMoveRef.current?.pointerId === pointerId ||
        (offsetDrag !== null && offsetDrag.pointerId === pointerId) ||
        (cylinderRadiusDrag !== null &&
          cylinderRadiusDrag.pointerId === pointerId) ||
        (faceDrag !== null && faceDrag.pointerId === pointerId)
        ? 'handle'
        : null;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (footprintDrag && event.pointerId === footprintDrag.pointerId) {
        event.preventDefault();
        moveFootprint(event);
        return;
      }
      const commandDrag = commandDragRef.current;
      const draggedRig = commandDrag
        ? commandRigsRef.current.get(commandDrag.valueId)?.rig
        : null;
      if (
        commandDrag &&
        draggedRig &&
        event.pointerId === commandDrag.pointerId
      ) {
        event.preventDefault();
        setRayFromEvent(event);
        const next = draggedRig.valueFromRay?.(
          context.raycaster.ray,
          draggedRig.value()
        );
        if (next !== null && next !== undefined) {
          // Angles in whole degrees and lengths in tenths, unless Shift asks
          // for the free value.
          const step = draggedRig.kind === ANGLE_RIG_KIND ? 1 : 0.1;
          const value = event.shiftKey ? next : Math.round(next / step) * step;
          if (value !== draggedRig.value()) {
            draggedRig.setValue(value);
            onCommandHandlePreviewRef.current?.(
              commandDrag.valueId,
              draggedRig.value()
            );
          }
        }
        requestRender();
        return;
      }
      if (event.buttons === 0) {
        const axisPickerRig = axisPickerRigRef.current;
        if (axisPickerRig) {
          axisPickerRig.group.updateMatrixWorld(true);
          setRayFromEvent(event);
          const axisHit = context.raycaster.intersectObjects(
            axisPickerRig.targets(),
            false
          )[0];
          const axisId =
            (axisHit?.object.userData.pickAxis as string | undefined) ?? null;
          axisPickerRig.setHover(axisId);
          if (axisId) {
            renderer.domElement.style.cursor = 'pointer';
            requestRender();
            return;
          }
        }
        const curvePickerRig = curvePickerRigRef.current;
        if (curvePickerRig) {
          setRayFromEvent(event);
          const curveId = curvePickerRig.pick(
            context.raycaster.ray,
            curvePickThreshold()
          );
          curvePickerRig.setHover(curveId);
          if (curveId) {
            renderer.domElement.style.cursor = 'pointer';
            requestRender();
            return;
          }
        }
        let overHandle = false;
        for (const { rig: commandRig } of commandRigsRef.current.values()) {
          if (!commandRig) continue;
          commandRig.group.updateMatrixWorld(true);
          setRayFromEvent(event);
          const over: boolean =
            !overHandle &&
            context.raycaster
              .intersectObjects(commandRig.group.children, true)
              .some((hit) => hit.object.userData.directHandle === true);
          commandRig.setHot?.(over);
          overHandle ||= over;
        }
        if (overHandle) {
          renderer.domElement.style.cursor = 'grab';
          requestRender();
          return;
        }
      }
      lastPickListPointer = event;
      // Threshold tracking sees every event on purpose: it decides whether a
      // right-drag was a click, and sampling that at frame rate can miss the
      // moment the pointer crossed the threshold and came back.
      rightClickGesture.move(event.pointerId, event.clientX, event.clientY);
      if (event.buttons !== 0) {
        pendingHoverEvent = null;
      }
      const dragKind = pointerDragKind(event);
      if (dragKind) {
        if (dragKind === 'handle') {
          // preventDefault has to happen while the event is being dispatched,
          // so it cannot wait for the frame that consumes the position. The
          // calls inside the handle branches are no-ops when the work is
          // deferred, and are kept because it often is not.
          event.preventDefault();
        }
        if (dragAppliedThisFrame) {
          pendingDragEvent = event;
        } else {
          dragAppliedThisFrame = true;
          applyPointerMove(event);
        }
        requestRender();
        return;
      }
      applyPointerMove(event);
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

    // U09 footprint drag: the plane it draws on, where it started, and the
    // outline drawn while the exact solid catches up.
    let footprintDrag: {
      pointerId: number;
      frame: PlacementFrame;
      start: THREE.Vector3;
      end: THREE.Vector3;
      startX: number;
      startY: number;
      moved: boolean;
    } | null = null;
    let footprintOutline: THREE.LineLoop | null = null;
    const drawFootprintOutline = () => {
      const drag = footprintDrag;
      const shape = footprintPickerRef.current?.shape;
      if (!drag || !shape) return;
      const u = new THREE.Vector3(
        drag.frame.u.x,
        drag.frame.u.y,
        drag.frame.u.z
      );
      const v = new THREE.Vector3(
        drag.frame.v.x,
        drag.frame.v.y,
        drag.frame.v.z
      );
      const delta = drag.end.clone().sub(drag.start);
      const along = delta.dot(u);
      const across = delta.dot(v);
      const points: THREE.Vector3[] = [];
      if (shape === 'rectangle') {
        points.push(
          drag.start.clone(),
          drag.start.clone().addScaledVector(u, along),
          drag.start
            .clone()
            .addScaledVector(u, along)
            .addScaledVector(v, across),
          drag.start.clone().addScaledVector(v, across)
        );
      } else {
        const radius = Math.hypot(along, across);
        for (let step = 0; step < 64; step += 1) {
          const angle = (step / 64) * Math.PI * 2;
          points.push(
            drag.start
              .clone()
              .addScaledVector(u, Math.cos(angle) * radius)
              .addScaledVector(v, Math.sin(angle) * radius)
          );
        }
      }
      if (!footprintOutline) {
        footprintOutline = new THREE.LineLoop(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({
            color: SKETCH_COLOR,
            depthTest: false,
            transparent: true
          })
        );
        footprintOutline.renderOrder = 999;
        context.scene.add(footprintOutline);
      }
      footprintOutline.geometry.dispose();
      footprintOutline.geometry = new THREE.BufferGeometry().setFromPoints(
        points
      );
      requestRender();
    };
    const clearFootprintOutline = () => {
      if (!footprintOutline) return;
      context.scene.remove(footprintOutline);
      footprintOutline.geometry.dispose();
      (footprintOutline.material as THREE.Material).dispose();
      footprintOutline = null;
      requestRender();
    };
    const footprintGesture = (
      drag: NonNullable<typeof footprintDrag>,
      phase: FootprintGesture['phase']
    ): FootprintGesture => ({
      phase,
      frame: drag.frame,
      start: { x: drag.start.x, y: drag.start.y, z: drag.start.z },
      end: { x: drag.end.x, y: drag.end.y, z: drag.end.z },
      moved: drag.moved
    });
    /**
     * Starts a footprint where the press lands: on a flat face of a body the
     * command may stand on, else on the principal plane facing the view.
     */
    const beginFootprint = (event: PointerEvent): boolean => {
      const footprint = footprintPickerRef.current;
      if (!footprint) return false;
      // Unfiltered: a Body or Edge filter must not hide the face pressed on.
      const candidate = picker.pickFace(event, (bodyId) =>
        footprint.bodyIds.includes(bodyId)
      );
      setRayFromEvent(event);
      const ray = context.raycaster.ray;
      let frame: PlacementFrame | null = null;
      let start: THREE.Vector3 | null = null;
      const selection = candidate?.selection ?? null;
      if (selection && footprint.bodyIds.includes(selection.bodyId)) {
        const face = bodiesRef.current
          .find((body) => body.bodyId === selection.bodyId)
          ?.topology?.faces.find(
            (entry) => entry.topologyId === selection.topologyId
          );
        const geometry = face?.geometry;
        if (geometry?.surfaceType === 'plane') {
          // An imported flat face measured from its NURBS carries no exact
          // normal: the mesh's, at the point pressed, stands in for it.
          const meshed = candidate?.faceNormal;
          const normal =
            geometry.normal ?? (meshed ? meshNormal(meshed) : undefined);
          const on =
            (geometry.normal && (geometry.centroid ?? geometry.center)) ||
            candidate?.hit.point;
          if (normal && on) {
            frame = placementFrame(normal);
            // On the face's own plane, not the mesh's triangle under it.
            const hit = framePlaneHit(frame, on, ray.origin, ray.direction);
            start = hit ? new THREE.Vector3(hit.x, hit.y, hit.z) : null;
          }
        }
      }
      if (!frame || !start) {
        frame = principalFrameFor(ray.direction);
        const hit = framePlaneHit(
          frame,
          { x: 0, y: 0, z: 0 },
          ray.origin,
          ray.direction
        );
        start = hit ? new THREE.Vector3(hit.x, hit.y, hit.z) : null;
      }
      if (!start) return false;
      footprintDrag = {
        pointerId: event.pointerId,
        frame,
        start,
        end: start.clone(),
        startX: event.clientX,
        startY: event.clientY,
        moved: false
      };
      return true;
    };
    const moveFootprint = (event: PointerEvent) => {
      const drag = footprintDrag;
      if (!drag) return;
      setRayFromEvent(event);
      const ray = context.raycaster.ray;
      const hit = framePlaneHit(
        drag.frame,
        drag.start,
        ray.origin,
        ray.direction
      );
      if (hit) drag.end.set(hit.x, hit.y, hit.z);
      if (
        !drag.moved &&
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4
      ) {
        drag.moved = true;
      }
      if (!drag.moved) return;
      drawFootprintOutline();
      onFootprintRef.current?.(footprintGesture(drag, 'move'));
    };
    const endFootprint = (event: PointerEvent, report: boolean) => {
      const drag = footprintDrag;
      if (!drag) return;
      footprintDrag = null;
      clearFootprintOutline();
      gestures.release(event, null);
      if (report) onFootprintRef.current?.(footprintGesture(drag, 'end'));
    };
    retireFootprintRef.current = () => {
      const drag = footprintDrag;
      if (!drag) return;
      footprintDrag = null;
      clearFootprintOutline();
      gestures.release(drag.pointerId, null);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (
        sketchMovePointerGate.press(
          sketchMoveRef.current?.pointerId,
          event.pointerId
        )
      ) {
        // A second pointer while one holds a sketch object: not a second
        // move, not a selection, not an orbit. Taking it would retarget the
        // gesture tracking out from under the drag, and it stays ignored
        // until its own release, even if the drag ends first.
        event.preventDefault();
        return;
      }
      lastPickListPointer = event;
      if (!topologyPickList.contains(event.target)) {
        topologyPickList.hide();
      }
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
        // Measured, not assumed: this walk is the pre-drag stall the feel
        // plan's row 2.2 exists for, so its cost is visible to the probe.
        timed('move.snapCollect', () => {
          moveSnaps = collectMoveSnaps(movingBodyId);
          moveCenterTargets = collectCenterAlignTargets(movingBodyId);
        });
        if (import.meta.env.OZ_PERF === '1') {
          const scope = window as typeof window & {
            __ozMoveSnapCandidates?: { snaps: number; centers: number };
          };
          scope.__ozMoveSnapCandidates = {
            snaps: moveSnaps.length,
            centers: moveCenterTargets.length
          };
        }
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
          snapRotate: chooseRotateSnapStep((ringRadiusPx * Math.PI) / 180),
          pendingValues: null
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
        onDirectManipulationChangeRef.current(true, 'move');
        const focus = { kind: data.kind, axis };
        updateMoveGizmoFocus(focus);
        positionMoveGizmoHud(event, focus, true);
        gestures.capture(event);
        event.preventDefault();
        return;
      }
      if (sketchModeRef.current && event.button === 0) {
        // A press on the selected object's grab point is a move, never an
        // orbit; anywhere else falls through to what a press always did.
        if (beginSketchMove(event)) {
          return;
        }
        const mode = sketchModeRef.current;
        const gesture = sketchGestureRef.current;
        const point = sketchPointAt(event);
        if (
          point &&
          ((mode.tool === 'rectangle' &&
            mode.rectangleMode !== 'three-point') ||
            mode.tool === 'polygon' ||
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
            mode.tool === 'ellipse' ||
            mode.tool === 'spline' ||
            (mode.tool === 'circle' && mode.circleMode === 'three-point') ||
            (mode.tool === 'rectangle' && mode.rectangleMode === 'three-point'))
        ) {
          gesture.pointerId = event.pointerId;
          gesture.moved = false;
          gesture.pressPoint = point;
          // Park the camera for the press: a drawing tool's drag is a stroke,
          // never an orbit. Rectangle and circle already claim the pointer
          // this way; the click-placed tools left it to the controls, so a
          // slightly moving press swung the view off the sketch plane.
          gestures.capture(event, null);
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
        if (handleHits.length > 0 && cylinderTarget.locked) {
          lockedHandlePointerId = event.pointerId;
          gestures.capture(event, null);
          event.preventDefault();
          return;
        }
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
          beginCylinderRadiusProxy(cylinderTarget);
          cylinderRadiusDragActiveRef.current = true;
          onDirectManipulationChangeRef.current(true);
          gestures.capture(event);
          event.preventDefault();
          return;
        }
      }
      // U09: the in-place command's handles, then its axis lines and sketch
      // curves. All are armed precisely to be grabbed, so they take the
      // press first.
      if (event.button === 0 && commandRigsRef.current.size > 0) {
        setRayFromEvent(event);
        for (const [valueId, { rig }] of commandRigsRef.current) {
          if (!rig) continue;
          // Its scale changes every frame; a press before the next render
          // must not test against last frame's matrices.
          rig.group.updateMatrixWorld(true);
          const grabbed = context.raycaster
            .intersectObjects(rig.group.children, true)
            .some((hit) => hit.object.userData.directHandle === true);
          if (!grabbed) continue;
          commandDragRef.current = {
            pointerId: event.pointerId,
            valueId,
            startValue: rig.value()
          };
          onDirectManipulationChangeRef.current(true);
          gestures.capture(event, 'grabbing');
          event.preventDefault();
          return;
        }
      }
      // U09: a primitive's footprint. Its arrows above take the press first,
      // so a press anywhere else draws a new footprint.
      if (event.button === 0 && beginFootprint(event)) {
        gestures.capture(event, null);
        event.preventDefault();
        return;
      }
      const axisPickerRig = axisPickerRigRef.current;
      if (axisPickerRig && event.button === 0) {
        // A rig armed since the last render has no world matrices yet.
        axisPickerRig.group.updateMatrixWorld(true);
        setRayFromEvent(event);
        const axisHit = context.raycaster.intersectObjects(
          axisPickerRig.targets(),
          false
        )[0];
        const axisId = axisHit?.object.userData.pickAxis as string | undefined;
        if (axisId) {
          event.preventDefault();
          onPickAxisRef.current?.(axisId);
          requestRender();
          return;
        }
      }
      const curvePickerRig = curvePickerRigRef.current;
      if (curvePickerRig && event.button === 0) {
        setRayFromEvent(event);
        const curveId = curvePickerRig.pick(
          context.raycaster.ray,
          curvePickThreshold()
        );
        if (curveId) {
          event.preventDefault();
          onPickCurveRef.current?.(curveId, event.shiftKey);
          requestRender();
          return;
        }
      }
      const armedRig = offsetRigRef.current;
      if (armedRig) {
        setRayFromEvent(event);
        const handleHits = context.raycaster
          .intersectObjects(armedRig.group.children, true)
          .filter((hit) => hit.object.userData.directHandle === true);
        // Another selected region's arrow drives the same value: the drag
        // still runs through the armed rig, only the chip moves to the arrow
        // in the hand.
        const follower =
          handleHits.length > 0 ? null : regionFollowerUnderRay();
        if (handleHits.length > 0 || follower) {
          if (offsetHandleRef.current?.locked) {
            lockedHandlePointerId = event.pointerId;
            gestures.capture(event, null);
            event.preventDefault();
            return;
          }
          beginOffsetDrag(armedRig, follower, event, event);
          event.preventDefault();
          return;
        }
        // The armed face itself is the thing being pushed or pulled: a press
        // on it that travels drags the face, as the arrow does. It used to
        // start a selection band, and a short sweep across the face took
        // the whole body instead. A press that stays put is still a click.
        const armedTarget = offsetHandleRef.current;
        if (armedTarget && !armedTarget.locked) {
          const hit = pick(event)?.selection;
          const shown = selectedTopologyRef.current;
          if (
            hit?.kind === 'face' &&
            hit.bodyId === armedTarget.bodyId &&
            (hit.topologyId === armedTarget.topologyId ||
              (shown?.kind === 'face' &&
                shown.bodyId === hit.bodyId &&
                shown.topologyId === hit.topologyId))
          ) {
            beginBoxSelect(event);
            boxSelect!.faceGrab = true;
            return;
          }
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
            initialValue: armedEdgeRig.value()
          };
          edgeDragActiveRef.current = true;
          onDirectManipulationChangeRef.current(true);
          gestures.capture(event);
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
      if (
        sketchMovePointerGate.release(event.pointerId) ||
        sketchMovePointerRole(
          sketchMoveRef.current?.pointerId,
          event.pointerId
        ) === 'other'
      ) {
        // Only the pointer holding the drag can end it, and a pointer the
        // viewport ignored stays ignored through its own release.
        return;
      }
      // The last pointer position may still be waiting for a frame. Apply it
      // before the release is handled, or the drag settles on the
      // second-to-last position and that is what gets committed.
      if (pendingDragEvent && pendingDragEvent.pointerId === event.pointerId) {
        const finalMove = pendingDragEvent;
        pendingDragEvent = null;
        applyPointerMove(finalMove);
      }
      const commandDrag = commandDragRef.current;
      if (commandDrag && event.pointerId === commandDrag.pointerId) {
        commandDragRef.current = null;
        onDirectManipulationChangeRef.current(false);
        gestures.release(event, 'grab');
        const rig = commandRigsRef.current.get(commandDrag.valueId)?.rig;
        if (rig && rig.value() !== commandDrag.startValue) {
          onCommandHandleReleaseRef.current?.(commandDrag.valueId, rig.value());
        }
        requestRender();
        return;
      }
      if (footprintDrag && event.pointerId === footprintDrag.pointerId) {
        moveFootprint(event);
        endFootprint(event, true);
        return;
      }
      if (event.pointerId === shiftOrbitPointerId) {
        shiftOrbitPointerId = null;
        cameraRig.setShiftOrbitActive(false);
      }
      if (event.pointerId === lockedHandlePointerId) {
        lockedHandlePointerId = null;
        gestures.release(event, null);
        return;
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
        const sweepMode = boxSelectMode(started.startX, event.clientX);
        const projectionOptions = {
          camera: cameraRig.activeCamera,
          width: host.clientWidth,
          height: host.clientHeight
        };
        const liveBodies = bodiesRef.current.filter((body) => !body.consumed);
        const filter = selectionFilterRef.current;
        const onTopology = onBoxSelectTopologyRef.current;
        // A Face or Edge filter says what the sweep is for; every other
        // filter keeps taking whole bodies.
        if ((filter === 'face' || filter === 'edge') && onTopology) {
          // Without X-ray, wireframe hides every face and shaded hides
          // every edge: a sweep takes nothing it cannot see.
          if (
            !xrayRef.current &&
            ((filter === 'face' && displayModeRef.current === 'wireframe') ||
              (filter === 'edge' && displayModeRef.current === 'shaded'))
          ) {
            onTopology([], filter);
            return;
          }
          onTopology(
            timed('viewer.boxSelectTopology', () =>
              topologyInBox(
                liveBodies.map((body) => ({
                  bodyId: body.bodyId,
                  positions: body.mesh.vertices,
                  indices: body.mesh.indices,
                  topology: body.topology,
                  // A translucent appearance draws without depth writes.
                  occludes: (body.opacity ?? 1) >= 1
                })),
                rect,
                sweepMode,
                {
                  ...projectionOptions,
                  kind: filter,
                  // Wireframe draws rear edges without face occlusion too.
                  selectThrough:
                    xrayRef.current ||
                    (filter === 'edge' &&
                      displayModeRef.current === 'wireframe'),
                  clippingPlane: sectionViewRef.current
                    ? sectionClippingPlane(sectionViewRef.current)
                    : null
                }
              )
            ),
            filter
          );
          return;
        }
        onBoxSelectRef.current(
          bodiesInBox(
            liveBodies.map((body) => ({
              bodyId: body.bodyId,
              // Kernel meshes are already world-space, so no placement is
              // applied here either — see createObjectForBody.
              positions: body.mesh.vertices,
              indices: body.mesh.indices
            })),
            rect,
            sweepMode,
            projectionOptions
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
          if (!event.shiftKey && showTopologyPickList(event, true, true)) {
            return;
          }
          onContextMenuRef.current(
            event.clientX,
            event.clientY,
            pick(event)?.selection ?? null
          );
        }
        return;
      }
      if (moveDrag && event.pointerId === moveDrag.pointerId) {
        publishMoveDragResult(moveDrag);
        moveDrag = null;
        moveSnaps = [];
        hud.hide(snapGlyph);
        moveDragActiveRef.current = false;
        onDirectManipulationChangeRef.current(false, 'move');
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
        const sketchMove = sketchMoveRef.current;
        if (sketchMove && sketchMove.pointerId === event.pointerId) {
          if (sketchMove.active) {
            gestures.release(event, null);
            finishSketchMove(sketchMove, true);
            return;
          }
          // The press never travelled: a click on the selected object's own
          // handle. The selection path below raycasts only drawn curves, and
          // a centre or text origin is not on one, so it would read as empty
          // canvas and deselect; the object stays selected instead.
          sketchMoveRef.current = null;
          gestures.release(event, null);
          requestRender();
          return;
        }
        const mode = sketchModeRef.current;
        const rig = sketchRigRef.current;
        const gesture = sketchGestureRef.current;
        const point = sketchPointAt(event);
        const moved = gestures.hasMoved(event);
        gestures.release(event, null);
        // I01: the Project tool picks model edges and faces through the
        // sketch plane; the host projects them into the sketch.
        if (mode.tool === 'project') {
          if (!moved) {
            const candidate = picker
              .pickAll(event)
              .find(
                (entry) =>
                  entry.selection?.kind === 'edge' ||
                  entry.selection?.kind === 'face'
              );
            onSelectTopologyRef.current(candidate?.selection ?? null, false);
          }
          requestRender();
          return;
        }
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
          // `sketchPointAt` above already resolved the snap under the cursor;
          // surface it when it names a constraint-schema point.
          const snapPoint =
            activeSketchSnap?.sourceId && activeSketchSnap.pointRef
              ? {
                  objectId: activeSketchSnap.sourceId,
                  point: activeSketchSnap.pointRef
                }
              : null;
          const planePoint = screenRayToPlanePoint(
            context.raycaster.ray.origin,
            context.raycaster.ray.direction,
            mode.basis
          );
          const consumed = onSketchSelectObjectRef.current(
            objectId,
            snapPoint,
            { x: event.clientX, y: event.clientY },
            planePoint ? { x: planePoint.x, y: planePoint.y } : null,
            activeSketchSnap && !snapPoint
              ? {
                  kind: activeSketchSnap.kind,
                  ...(activeSketchSnap.sourceId
                    ? { sourceId: activeSketchSnap.sourceId }
                    : {})
                }
              : null
          );
          if (!objectId && consumed !== true) {
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
          if (point && mode.tool === 'circle') {
            const object =
              mode.circleMode === 'two-point-diameter'
                ? circleObjectFromDiameter(gesture.dragStart, point)
                : sketchObjectFromDrag(mode.tool, gesture.dragStart, point);
            if (object) {
              onSketchCommitRef.current(object);
            }
          }
          if (point && (mode.tool === 'rectangle' || mode.tool === 'polygon')) {
            const shape = dragCompositeShape(
              mode.tool,
              mode.rectangleMode,
              mode.polygonSides,
              gesture.dragStart,
              point
            );
            if (shape) {
              onSketchCommitCompositeRef.current(shape);
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
          mode.tool === 'rectangle' &&
          mode.rectangleMode === 'three-point' &&
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
            const shape = threePointRectangleShape(
              gesture.circleFirst,
              gesture.circleSecond,
              point
            );
            if (isCompositeShape(shape)) {
              onSketchCommitCompositeRef.current(shape);
              gesture.circleFirst = null;
              gesture.circleSecond = null;
              rig?.setInProgress(null, false);
              hideSketchDimLabel();
              onSketchDrawingChangeRef.current(false);
            } else {
              positionSketchDimLabel(event, shape.refusal, false);
            }
          }
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
          // object is the card's draft, so there is no drag and no second
          // click. A draft the card cannot place (no string, a size that
          // does not resolve, over budget, a solve in flight) places nothing
          // here either: one rule decides for both.
          const draft = mode.textDraft;
          if (
            draft &&
            canPlaceTextDraft(
              draft,
              mode.parameterScope,
              {
                busy: mode.textDraftBusy,
                budgetError: mode.textDraftBudgetError
              },
              mode.units
            )
          ) {
            onSketchCommitRef.current(textObjectFromPoint(point, draft));
          }
          requestRender();
          return;
        }
        if (mode.tool === 'line' && point && moved && gesture.pressPoint) {
          // Press-and-drag draws one segment from the press to the release,
          // continuing a chain when one is open. Same locking as a click.
          const anchor = gesture.chainAnchor ?? gesture.pressPoint;
          const locked =
            mode.inferenceEnabled && !event.shiftKey
              ? axisLockPoint(anchor, point)
              : { point, lockedAxis: null };
          const object = lineObjectFromPoints(anchor, locked.point);
          if (object) {
            finishSketchNumericEntry();
            onSketchCommitRef.current(object);
            gesture.chainAnchor = locked.point;
            onSketchDrawingChangeRef.current(true);
          }
          gesture.pressPoint = null;
          requestRender();
        }
        if (mode.tool === 'line' && point && !moved) {
          gesture.pressPoint = null;
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
        if (
          (mode.tool === 'ellipse' || mode.tool === 'spline') &&
          point &&
          !moved
        ) {
          placeSketchCurvePoint(event, point);
          requestRender();
          return;
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
          onEdgeCancelRef.current();
          selectAtPointer(event);
          return;
        }
        depthCycle = null;
        if (
          rig &&
          (finalValue > 1e-9 || edgeHandleRef.current?.allowRemoval) &&
          Math.abs(finalValue - completed.initialValue) > 1e-9
        ) {
          onEdgeCommitRef.current(finalValue);
        } else {
          onEdgeCancelRef.current();
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
          restoreCylinderRadiusProxy();
          onCylinderRadiusCancelRef.current();
          selectAtPointer(event);
          return;
        }
        depthCycle = null;
        if (rig && Math.abs(finalRadius - completed.originalRadius) > 1e-9) {
          queueCylinderRadiusProxy(finalRadius);
          if (!onCylinderRadiusCommitRef.current(finalRadius)) {
            restoreCylinderRadiusProxy();
          }
        } else {
          restoreCylinderRadiusProxy();
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
          clearOffsetGhost();
          restoreOffsetBodyProxy();
          onOffsetCancelRef.current();
          selectAtPointer(event);
          return;
        }
        depthCycle = null;
        if (
          rig &&
          Math.abs(finalOffset - completed.initialOffset) > 1e-9 &&
          Math.abs(finalOffset) > 1e-9
        ) {
          queueOffsetBodyProxy(finalOffset);
          // A refused release can keep the last value that built on screen,
          // still uncommitted, so its ghost stays too; a restored body
          // clears the ghost when it is installed.
          if (!onOffsetCommitRef.current(finalOffset)) restoreOffsetBodyProxy();
        } else {
          clearOffsetGhost();
          restoreOffsetBodyProxy();
          onOffsetCancelRef.current();
        }
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
      if (
        sketchMovePointerGate.release(event.pointerId) ||
        sketchMovePointerRole(
          sketchMoveRef.current?.pointerId,
          event.pointerId
        ) === 'other'
      ) {
        // Cancelling a pointer the viewport ignored must not reset the
        // gesture state the held drag still owns.
        return;
      }
      pendingHoverEvent = null;
      // An abandoned footprint keeps what it drew, as a release would.
      if (footprintDrag && event.pointerId === footprintDrag.pointerId) {
        endFootprint(event, true);
      }
      if (event.pointerId === lockedHandlePointerId) {
        lockedHandlePointerId = null;
        gestures.release(event, null);
      }
      if (sketchMoveRef.current?.pointerId === event.pointerId) {
        const drag = sketchMoveRef.current;
        gestures.release(event, '');
        finishSketchMove(drag, false);
      }
      // An abandoned command drag lets go of the handle where it was: the
      // value it reached stays previewed, as a release would leave it.
      const commandDrag = commandDragRef.current;
      if (commandDrag && commandDrag.pointerId === event.pointerId) {
        commandDragRef.current = null;
        onDirectManipulationChangeRef.current(false);
        gestures.release(event, 'grab');
        const rig = commandRigsRef.current.get(commandDrag.valueId)?.rig;
        if (rig && rig.value() !== commandDrag.startValue) {
          onCommandHandleReleaseRef.current?.(commandDrag.valueId, rig.value());
        }
        requestRender();
      }
      // A cancelled gesture discards its pending position rather than
      // applying it: the drag is being abandoned, not completed.
      if (pendingDragEvent && pendingDragEvent.pointerId === event.pointerId) {
        pendingDragEvent = null;
      }
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
        onEdgeCancelRef.current();
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
        restoreCylinderRadiusProxy();
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
        restoreOffsetBodyProxy();
        onOffsetCancelRef.current();
        requestRender();
      }
      if (moveDrag && event.pointerId === moveDrag.pointerId) {
        publishMoveDragResult(moveDrag);
        moveDrag = null;
        moveSnaps = [];
        hud.hide(snapGlyph);
        moveDragActiveRef.current = false;
        onDirectManipulationChangeRef.current(false, 'move');
        gestures.release(event);
        clearMoveGizmoHover();
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
      sketchPointerOnCanvas = false;
      sketchRigRef.current?.setInference(null);
      sketchCenterTarget.hidden = true;
      if (moveDrag) {
        return;
      }
      clearMoveGizmoHover();
      applyHover(null);
      hud.hide(measurePreviewChip);
      hud.hide(snapGlyph);
    };
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (
        topologyPickList.visible &&
        !topologyPickList.contains(event.target) &&
        event.target !== renderer.domElement
      ) {
        topologyPickList.hide();
      }
    };
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
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
          const chain = edgeRunSelections(
            edges,
            picked.selection.topologyId,
            picked.selection.bodyId
          );
          if (chain.length > 1) {
            onSelectEdgeChainRef.current(chain);
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
      // Like F: keep the view direction, frame into the clear stage.
      const pose = computeFitPose(
        camera,
        bodyGroup.children,
        cameraRig.viewDirection(),
        0,
        measureFitFrame(renderer.domElement)
      );
      cameraRig.startTween(
        pose,
        () => {
          if (context.projection === 'orthographic') {
            cameraRig.syncOrthographic(true);
          }
        },
        { ease: viewJumpEase }
      );
    };

    const handleContextMenu = (event: MouseEvent) => {
      // Browsers may dispatch this before the right-button gesture finishes.
      // Suppress the native menu here; pointerup decides whether to open ours.
      event.preventDefault();
      const pointerType = (event as PointerEvent).pointerType;
      // Touch and pen long-presses arrive as contextmenu PointerEvents rather
      // than a secondary-button pointerup. Use that native gesture without
      // changing the mouse right-click path above.
      if (
        pointerType &&
        pointerType !== 'mouse' &&
        !sketchModeRef.current &&
        showTopologyPickList(event, true, true)
      ) {
        event.stopPropagation();
      }
    };
    // The canvas listener alone is not enough: HUD chips and the CSS2D label
    // layer sit above the canvas, and a right-click landing on them surfaces
    // the browser's own menu (Safari offers "Save Image As…" for the canvas
    // beneath). The host wrapper sees the event whichever layer was hit.
    host.addEventListener('contextmenu', handleContextMenu);

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

    const lastQuaternion = new THREE.Quaternion();
    /**
     * Frames drawn, for the one contract no other hook can express: that the
     * loop goes back to sleep. It is on-demand, so a still scene should stop
     * counting entirely — and a single condition stuck true (a retired
     * overlay that never finished fading, say) pins it at full rate for the
     * rest of the session with nothing on screen to show for it.
     */
    let framesDrawn = 0;
    /**
     * Whether the previous frame kept the loop awake. A frame that follows a
     * sleep sees the whole idle gap on the clock, which is not animation time.
     */
    let loopWasAnimating = false;
    function animate(now: number) {
      animationFrame = null;
      const frameStarted = performance.now();
      if (e2eCanvasHooksEnabled) {
        framesDrawn += 1;
        renderer.domElement.dataset.e2eFrames = String(framesDrawn);
      }
      if (resizePending) {
        resizePending = false;
        const width = viewerHost.clientWidth;
        const height = viewerHost.clientHeight;
        cameraRig.handleResize();
        renderer.setSize(width, height);
        canvasCssWidth = width;
        canvasCssHeight = height;
        labelRenderer.setSize(width, height);
        // Screen-space fat lines rasterize against the viewport size. Walking
        // the scene covers body edges, sketches, previews and handle rigs
        // alike, so no creation site has to remember to register its material.
        syncFatLineResolution(scene, width, height);
      }
      // Camera glide first so controls and the ortho mirror see the result.
      const tweening = cameraRig.stepTween(now);
      const zooming = cameraRig.stepZoom(now);
      const controlsChanged = cameraRig.stepOrbit(now);
      const dragEvent = pendingDragEvent;
      pendingDragEvent = null;
      dragAppliedThisFrame = false;
      if (dragEvent) {
        applyPointerMove(dragEvent);
      }
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

      // Ghost planes hold their screen size, so they stay a target rather
      // than a backdrop as the camera dollies.
      datumPlaneRigRef.current?.setScale(worldPerPixelAtDepth);
      datumAxisRigRef.current?.setScale(worldPerPixelAtDepth);
      const planePicker = planePickerRigRef.current;
      if (planePicker) {
        // Scale first: the offset is expressed in world units and has to be
        // divided back out of the group's screen-size scale.
        planePicker.setScale(worldPerPixelAt(new THREE.Vector3()));
        planePicker.setOffset(planePickerOffsetRef.current);
      }
      axisPickerRigRef.current?.setScale(worldPerPixelAtDepth);

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
        const gridSink = sketchGridReadoutRef?.current ?? null;
        if (activeSketchMode.gridVisible) {
          const gridSpacing = `${formatNumber(spacing)} ${unitLabelRef.current}`;
          if (gridSink) {
            gridSink(gridSpacing);
            sketchGridIndicator.hidden = true;
          } else {
            sketchGridIndicator.textContent = `Grid ${gridSpacing} · adaptive`;
            sketchGridIndicator.hidden = false;
          }
        } else {
          gridSink?.(null);
          sketchGridIndicator.hidden = true;
        }
        inferenceAnimating = activeSketchRig.advanceInference(
          now,
          reducesMotion(reducedMotionRef.current)
        );
        positionSketchMoveHandles();
      } else {
        sketchGridReadoutRef?.current?.(null);
        // Every frame passes here outside a sketch; rewriting an unchanged
        // attribute still dirties style before the frame's layout reads.
        if (!sketchGridIndicator.hidden) sketchGridIndicator.hidden = true;
        if (!sketchGrabHandle.hidden) sketchGrabHandle.hidden = true;
        if (!sketchRotateRing.hidden) sketchRotateRing.hidden = true;
        sketchHandleSpot.shown = false;
      }

      // Preselection and selection overlays cut to their targets; their
      // x-ray passes ease there.
      // Timer separates advancing time from reading it, so update once here.
      context.timer.update(now);
      const dt = animationStepSeconds(
        context.timer.getDelta(),
        loopWasAnimating
      );

      selection.step(dt);
      // Edge highlight tiers ease on the overlays themselves, so each body
      // steps its own; any still moving keeps the loop awake below.
      let edgesAnimating = false;
      for (const overlay of context.edgeOverlaysByBodyId.values()) {
        if (overlay.step(dt * 1000)) {
          edgesAnimating = true;
        }
      }
      // `selection.step` above already eased every material in this set —
      // `context.fadeIns` is that same set — so there is no second pass here.
      disposeSettledOverlays(retiringOverlaysRef.current);
      // Dimensions are resized on every drawn frame, not behind a guard keyed
      // on the camera's orientation: a wheel-zoom changes the world size of a
      // pixel without rotating anything, and a rotation guard would leave the
      // arrowheads frozen at their pre-zoom size. The loop is already
      // on-demand, so this costs nothing on a still frame.
      sketchDimensionsRef.current?.update(
        (point) => moveGizmoWorldScale(worldPerPixelAt(point)) * 0.55,
        context.activeCamera
      );
      for (const entry of measurementDimensionsRef.current) {
        entry.graphic.orient(context.activeCamera);
        entry.graphic.update(
          entry.start,
          entry.end,
          moveGizmoWorldScale(worldPerPixelAt(entry.start)) * 0.55
        );
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
      let rigsAnimating = stepRetiringRigs(retiringRigsRef.current, dt * 1000);
      const offsetRig = offsetRigRef.current;
      if (offsetRig) {
        // Screen-constant arrow, ~0.55× the move gizmo's reach.
        const rigScale =
          moveGizmoWorldScale(worldPerPixelAt(offsetRig.group.position)) * 0.55;
        if (offsetRig.step?.(dt * 1000)) {
          rigsAnimating = true;
        }
        offsetRig.group.scale.setScalar(rigScale);
        offsetRig.group.userData.gizmoScale = rigScale;
        offsetRig.orient?.(context.activeCamera);
        // Keep dimension arrowheads screen-sized across a pure wheel zoom.
        offsetRig.setValue(offsetRig.value());
      }
      if (stepRegionFollowers(dt * 1000)) {
        rigsAnimating = true;
      }
      const cylinderRig = cylinderRadiusRigRef.current;
      if (cylinderRig) {
        const rigScale =
          moveGizmoWorldScale(worldPerPixelAt(cylinderRig.group.position)) *
          0.55;
        if (cylinderRig.step?.(dt * 1000)) {
          rigsAnimating = true;
        }
        cylinderRig.group.scale.setScalar(rigScale);
        cylinderRig.group.userData.gizmoScale = rigScale;
        cylinderRig.orient?.(context.activeCamera);
        // Re-run the rig's layout so its dimension-line arrowheads track the
        // freshly stamped screen-constant scale.
        cylinderRig.setValue(cylinderRig.value());
      }
      const edgeRig = edgeRigRef.current;
      if (edgeRig) {
        const rigScale =
          moveGizmoWorldScale(worldPerPixelAt(edgeRig.group.position)) * 0.4;
        if (edgeRig.step?.(dt * 1000)) {
          rigsAnimating = true;
        }
        edgeRig.group.scale.setScalar(rigScale);
        edgeRig.group.userData.gizmoScale = rigScale;
      }
      for (const { rig: commandRig } of commandRigsRef.current.values()) {
        if (!commandRig) continue;
        const rigScale =
          moveGizmoWorldScale(worldPerPixelAt(commandRig.group.position)) * 0.4;
        commandRig.group.scale.setScalar(rigScale);
        commandRig.group.userData.gizmoScale = rigScale;
      }
      const cylinderRadiusProxyFrame = flushCylinderRadiusProxy();
      const offsetBodyProxyFrame = flushOffsetBodyProxy();
      updateOffsetChip();
      // After the offset chip, which clears the keypad anchor without a rig
      // of its own: the command's anchor has to be the frame's last word.
      updateCommandChips();
      scaleIndicatorRef.current?.(
        chooseViewportScale(
          worldPerPixelAt(
            scaleBarAnchor(
              cameraRig.activeCamera.position,
              cameraRig.activeCamera.getWorldDirection(scaleBarForward),
              // What is drawn this frame, previews included, so a Move or
              // parameter preview does not leave the bar to jump at commit.
              presentedBoundsCenter(
                [bodyGroup, parameterPreviewController.current?.group],
                scaleBarModelCenter
              ),
              cameraRig.controls.target
            )
          )
        )
      );
      updateStudioGrid(grid, context.activeCamera, cameraRig.controls.target);
      updateAxesGizmo(axes, context.activeCamera);
      shadowCatcher.visible = shouldShowGroundShadow(
        context.activeCamera,
        showGridRef.current
      );
      // WHAT IS ON SCREEN IS DECIDED HERE, not by whoever put it there.
      //
      // Anything that draws a body somewhere other than where the document
      // built it — the Move gizmo, a face drag, a stand-in hiding it, or
      // something nobody has written yet — has to have posed the object
      // before this line, because otherwise the frame about to be rendered
      // would not show it. So the frame is asked, and the answer goes to the
      // workspace, which feeds it back in as `ViewportGeometry.drawnElsewhere`
      // and refuses to call any section of those bodies exact.
      //
      // Sampling is a handful of float compares per body and speaks only when
      // the set changes, so a drag reports twice — once when it starts, once
      // when it ends — not sixty times a second.
      const drawnElsewhere = drawnBodyReport.sample(context.objectsByBodyId);
      if (drawnElsewhere) {
        onBodiesDrawnElsewhereRef.current?.(drawnElsewhere);
      }
      let renderStarted = performance.now();
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
        renderStarted = performance.now();
        renderer.render(scene, context.activeCamera);
      }
      traceFaceDrag('frame', {
        ms: performance.now() - frameStarted,
        detail: {
          presented: pendingTracedFrameRef.current ? 1 : 0,
          renderMs: performance.now() - renderStarted
        }
      });
      pendingTracedFrameRef.current = false;
      const presented = pendingEditFrameRef.current;
      if (presented) {
        pendingEditFrameRef.current = undefined;
        recordEditPhase(presented, 'frame', { analysis: presented.analysis });
      }
      if (e2eCanvasHooksEnabled) {
        const distance = context.activeCamera.position.distanceTo(
          context.controls.target
        );
        renderer.domElement.dataset.e2eCameraDistance = String(distance);
        renderer.domElement.dataset.e2eOrthographicZoom = String(
          orthographic.zoom
        );
        renderer.domElement.dataset.e2eZoomActive = String(zooming);
        renderer.domElement.dispatchEvent(
          new CustomEvent('openzcad:e2e-camera-frame', {
            detail: {
              at: now,
              distance,
              orthographicZoom: orthographic.zoom,
              zooming
            }
          })
        );
      }
      if (import.meta.env.OZ_PERF === '1') {
        mark('viewer.frame', {
          frameMs:
            lastPerfFrameAt === null
              ? null
              : Math.max(now - lastPerfFrameAt, 0),
          drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
          geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures
        });
        lastPerfFrameAt = now;
      }
      updateDimensionLabels(context, canvasWidth(), canvasHeight());
      labelRenderer.render(scene, context.activeCamera);
      // Dimension labels settle first: the glyph layout below keeps out of
      // their boxes, margins included, so it must read this frame's.
      avoidSketchDimensionOverlays(labelRenderer.domElement);
      // Relation glyphs stand off their geometry in screen space, so they
      // are laid out against this frame's camera; a still frame writes no
      // style and the layout allocates nothing.
      sketchRelationsRef.current?.layout(
        context.activeCamera,
        canvasWidth(),
        canvasHeight(),
        sketchDimensionsRef.current,
        sketchHandleSpot
      );
      if (cylinderRadiusProxyFrame && import.meta.env.OZ_PERF === '1') {
        mark('cylinder-radius.proxy-frame', {
          latencyMs: Math.max(
            performance.now() - cylinderRadiusProxyFrame.requestedAt,
            0
          ),
          radius: cylinderRadiusProxyFrame.radius
        });
      }
      if (offsetBodyProxyFrame && import.meta.env.OZ_PERF === '1') {
        mark('offset-face.proxy-frame', {
          latencyMs: performance.now() - offsetBodyProxyFrame.requestedAt,
          offset: offsetBodyProxyFrame.offset
        });
      }
      clampNameCallouts(labelRenderer.domElement);
      placeSelectionCallouts(labelRenderer.domElement);
      updateMeasurementCallouts(
        measurementCalloutsRef.current,
        measurementBoundsRef.current,
        context.activeCamera,
        canvasWidth(),
        canvasHeight()
      );

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
      loopWasAnimating =
        tweening ||
        zooming ||
        controlsChanged ||
        hoverAnimating ||
        edgesAnimating ||
        rigsAnimating ||
        retiringOverlaysRef.current.length > 0 ||
        inferenceAnimating ||
        context.fadeIns.size > 0;
      if (loopWasAnimating) {
        requestRender();
      }
    }
    // The React chrome can become actionable before this passive setup owns a
    // scene context. Replay a view chosen in that window instead of dropping
    // its one-shot nonce in the earlier request effect.
    if (viewRequestRef.current) {
      startRequestedView(
        context,
        viewRequestRef.current,
        handledViewRequestRef
      );
    }
    requestRender();
    performance.measure?.('oz:viewer.init', 'oz:viewer.init:begin');

    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      // This scene stops drawing here, so nothing of it is posed any more.
      onBodiesDrawnElsewhereRef.current?.(drawnBodyReport.reset());
      pixelRatioQuery?.removeEventListener('change', onPixelRatioChange);
      observer.disconnect();
      panelObserver.disconnect();
      retireCommandDragRef.current = null;
      areaObserver.disconnect();
      stopWatchingTheme();
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
        'openzcad:e2e-select-planar-face',
        handleE2EPlanarFaceSelection
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-select-edge',
        handleE2EEdgeSelection
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-select-blend',
        handleE2EBlendSelection
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-visual-selection-probe',
        handleE2EVisualSelectionProbe
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
        'openzcad:e2e-bodies-in-view',
        handleE2EBodiesInView
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-project-points',
        handleE2EProjectPoints
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-control-pointer',
        handleE2EControlPointer
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-locate-pick-stack',
        handleE2ELocatePickStack
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-hover-face-state',
        handleE2EHoverFaceState
      );
      renderer.domElement.removeEventListener(
        'openzcad:e2e-sketch-state',
        handleE2ESketchState
      );
      document.removeEventListener('keydown', handleCapturedEscape, true);
      document.removeEventListener(
        'pointerdown',
        handleDocumentPointerDown,
        true
      );
      renderer.domElement.removeEventListener('dblclick', handleDoubleClick);
      renderer.domElement.removeEventListener('contextmenu', handleContextMenu);
      host.removeEventListener('contextmenu', handleContextMenu);
      discardCylinderRadiusProxy();
      // Hover slots are children of body objects, but their buffers and
      // materials belong to SelectionManager. Detach them before the body
      // tree is disposed so ownership is not crossed or disposed twice.
      moveCopyPreview.clear();
      selection.dispose();
      clearGroup(bodyGroup);
      clearGroup(sketchGroup);
      clearGroup(overlayGroup);
      clearGroup(measurementGroup);
      clearGroup(gizmoGroup);
      clearGroup(moveGizmoGroup);
      for (const disposable of [
        gradientBackdrop,
        grid,
        shadowCatcher
      ] as THREE.Mesh[]) {
        disposable.geometry.dispose();
        (disposable.material as THREE.Material).dispose();
      }
      environment?.dispose();
      // The key light's shadow map is a render target of its own, which no
      // scene-graph clear reaches.
      keyLight.dispose();
      clearGroup(axes); // the triad is three fat lines now, not one helper
      cameraRig.dispose();
      // Rigs still fading out have no render loop left to finish them.
      for (const rig of retiringRigsRef.current) {
        rig.dispose();
      }
      retiringRigsRef.current = [];
      renderer.dispose();
      // dispose() frees three's own caches but leaves the context to the
      // garbage collector, and browsers cap live contexts by evicting the
      // oldest. Every project open builds a fresh viewer, so release now.
      renderer.forceContextLoss();
      host.removeChild(renderer.domElement);
      host.removeChild(labelRenderer.domElement);
      offsetChip.removeEventListener('click', handleChipClick);
      dimensionPrefix.removeEventListener('click', toggleCylinderDimensionMode);
      radiusLabelChip.removeEventListener('click', handleChipClick);
      hud.dispose();
      topologyPickListRef.current = null;
      // Dimension graphics own their own geometries and materials; clearing
      // the group they sit in would orphan those on the GPU.
      for (const entry of measurementDimensionsRef.current) {
        entry.graphic.dispose();
      }
      measurementDimensionsRef.current = [];
      offsetChipRef.current = null;
      sketchDimLabelRef.current = null;
      sketchSnapMarkerRef.current = null;
      sketchCenterTargetRef.current = null;
      sketchMoveRef.current = null;
      sketchMoveCommitPendingRef.current = null;
      cancelSketchMoveRef.current = null;
      offsetSetterRef.current = null;
      cancelDirectManipulationRef.current = null;
      openExactEntryRef.current = null;
      cylinderRadiusProxyControllerRef.current = null;
      offsetBodyProxyControllerRef.current = null;
      offsetGhostClearRef.current?.();
      offsetGhostClearRef.current = null;
      offsetGhostClipRef.current = null;
      moveGizmoHudRef.current = null;
      if (orientationDragRef.current === orientationDragControls) {
        orientationDragRef.current = null;
      }
      if (viewportImageRef?.current === viewportImage) {
        viewportImageRef.current = null;
      }
      contextRef.current = null;
    };
  }, []);

  // A stack belongs to one rendered topology/filter snapshot. Close it when
  // either changes instead of leaving rows that point at retired geometry.
  useEffect(() => {
    topologyPickListRef.current?.hide();
  }, [
    bodies,
    pickListEnabled,
    selectedEdges,
    selectedTopology,
    selectionFilter
  ]);

  // Measurements are session-owned overlays. They use their own group so an
  // exact body refresh cannot remove a pinned result between React commits.
  useEffect(() => {
    const context = contextRef.current;
    const group = measurementGroupRef.current;
    if (!context || !group) {
      return;
    }
    for (const entry of measurementDimensionsRef.current) {
      entry.graphic.dispose();
    }
    measurementDimensionsRef.current = [];
    measurementCalloutsRef.current = [];
    clearGroup(group);
    const resolution = context.fatLineResolution();
    for (const annotation of measurementAnnotations) {
      const stale = annotation.status !== 'current';
      const color = stale
        ? 0xf59e0b
        : annotation.selected
          ? 0x9eb8ff
          : 0x81a9ff;
      // A measured span is drawn as a drawing's dimension rather than as a
      // bare line: witness ticks stand it off the geometry, and the arrowheads
      // say which two points the number is between. Angle arms are not a span,
      // so they keep the plain line — an arrowhead on the far end of an arm
      // would claim the arm's length was the measurement.
      if (annotation.graphic === 'span') {
        for (const segment of annotation.segments) {
          const dimension = createDimensionGraphic({ witnessLines: true });
          const start = new THREE.Vector3(
            segment.start.x,
            segment.start.y,
            segment.start.z
          );
          const end = new THREE.Vector3(
            segment.end.x,
            segment.end.y,
            segment.end.z
          );
          dimension.object.renderOrder =
            VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH + 1;
          dimension.object.traverse((child) => {
            child.raycast = () => undefined;
          });
          group.add(dimension.object);
          measurementDimensionsRef.current.push({
            graphic: dimension,
            start,
            end
          });
        }
      }
      for (const segment of annotation.graphic === 'span'
        ? []
        : annotation.segments) {
        const line = createFatLine(
          [
            new THREE.Vector3(
              segment.start.x,
              segment.start.y,
              segment.start.z
            ),
            new THREE.Vector3(segment.end.x, segment.end.y, segment.end.z)
          ],
          {
            color,
            linewidth: annotation.selected ? 2.4 : 1.6,
            opacity: stale ? 0.55 : 0.92,
            depthTest: false,
            resolution
          }
        );
        line.name = 'measurement-witness';
        line.raycast = () => undefined;
        line.renderOrder = VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH + 1;
        group.add(line);
      }
      const label = makeLabel(
        `selection-callout direct-edit-callout measurement-callout${
          annotation.selected ? ' selected' : ''
        }${stale ? ' stale' : ''}`,
        annotation.label
      );
      label.name = 'measurement-label';
      label.position.set(
        annotation.anchor.x,
        annotation.anchor.y,
        annotation.anchor.z
      );
      label.element.setAttribute('role', 'status');
      // The declutter pass slides the pill off the geometry; the leader keeps
      // pointing at the anchor so the number still reads as belonging to it.
      const leader = document.createElement('div');
      leader.className = 'measurement-leader';
      leader.style.display = 'none';
      label.element.appendChild(leader);
      group.add(label);
      const firstSegment = annotation.segments[0];
      const extent = annotation.extent;
      measurementCalloutsRef.current.push({
        element: label.element as HTMLDivElement,
        leader,
        anchor: new THREE.Vector3(
          annotation.anchor.x,
          annotation.anchor.y,
          annotation.anchor.z
        ),
        kind: annotation.graphic,
        spanStart:
          annotation.graphic === 'span' && firstSegment
            ? new THREE.Vector3(
                firstSegment.start.x,
                firstSegment.start.y,
                firstSegment.start.z
              )
            : undefined,
        spanEnd:
          annotation.graphic === 'span' && firstSegment
            ? new THREE.Vector3(
                firstSegment.end.x,
                firstSegment.end.y,
                firstSegment.end.z
              )
            : undefined,
        extent: extent
          ? [0, 1, 2, 3, 4, 5, 6, 7].map(
              (corner) =>
                new THREE.Vector3(
                  corner & 1 ? extent.max.x : extent.min.x,
                  corner & 2 ? extent.max.y : extent.min.y,
                  corner & 4 ? extent.max.z : extent.min.z
                )
            )
          : undefined
      });
    }
    context.requestRender();
  }, [measurementAnnotations]);

  // Body geometry is rebuilt only when the derived body projection changes.
  // Selection-only renders reuse the installed meshes, materials, edge
  // batches, and frozen shadow map while refreshing lightweight overlays.
  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }

    const installationStarted = performance.now();
    const bodiesChanged = context.renderedBodies !== bodies;
    const previousBodies = new Map(
      context.renderedBodies?.map((body) => [body.bodyId, body])
    );
    const renderChanged =
      bodiesChanged &&
      (previousBodies.size !== bodies.length ||
        bodies.some((body) => {
          const previous = previousBodies.get(body.bodyId);
          return (
            !previous ||
            !sameBodyRenderGeometry(previous, body) ||
            !sameBodyPickingTopology(previous, body)
          );
        }));
    const xrayEnabled = sketchMode === null;
    context.selection.setXrayEnabled(xrayEnabled);
    // While anything is selected, whatever is not the selection recedes and
    // the selection keeps its own colour (design review F8). Not while
    // sketching: the solids already recede there, and the plane leads.
    const selectionRecedes =
      sketchMode === null &&
      (selectedBodyIds.length > 0 ||
        selectedTopology !== null ||
        selectedEdges.length > 0 ||
        focusFaces.length > 0 ||
        (focusGhostBodies?.length ?? 0) > 0);
    if (bodiesChanged) mark('viewer.bodies:begin');
    if (renderChanged) {
      context.moveCopyPreview.clear();
      // The exact worker result is authoritative. Forget the visual proxy
      // before its old Three object is disposed and replaced.
      cylinderRadiusProxyControllerRef.current?.discard();
      offsetBodyProxyControllerRef.current?.discard();
      // Exact frames replace bodies mid-drag; once the drag is over, the
      // next bodies are the committed or restored part.
      // Typed entry keeps its ghost the same way while exact frames land.
      if (!offsetDragActiveRef.current && !offsetHandleRef.current?.entry)
        offsetGhostClearRef.current?.();
      // The manager owns hover-slot geometry even while the slots are
      // parented under bodies, so it must detach them before body disposal.
      context.selection.resetForRebuild();
      hoverDwellRef.current.reset();
      // Same reasoning as the highlight dropped rather than retired below:
      // the bodies these were fading against are about to be disposed. Their
      // fade also died with the set `resetForRebuild` just cleared.
      disposeRetiringOverlays(retiringOverlaysRef.current);
      const liveIds = new Set(bodies.map((body) => body.bodyId));
      for (const [id, object] of context.objectsByBodyId) {
        if (!liveIds.has(id as GeometryBodyRepresentation['bodyId'])) {
          context.bodyGroup.remove(object);
          disposeObject(object);
          context.objectsByBodyId.delete(id);
          context.edgeOverlaysByBodyId.delete(id);
        }
      }
    }
    clearGroup(context.overlayGroup);
    context.dimensionLabels.clear();
    if (E2E_CANVAS_HOOKS_ENABLED) {
      delete context.renderer.domElement.dataset.e2eSelectedFace;
      if (selectedEdges.length > 0) {
        context.renderer.domElement.dataset.e2eSelectedEdges = selectedEdges
          .map((selection) => selection.topologyId ?? '')
          .join(',');
      } else {
        delete context.renderer.domElement.dataset.e2eSelectedEdges;
      }
      if (previewFaceHighlights.length > 0) {
        context.renderer.domElement.dataset.e2ePreviewBlendCount = String(
          previewFaceHighlights.length
        );
      } else {
        delete context.renderer.domElement.dataset.e2ePreviewBlendCount;
      }
      // What the viewport is actually drawing, preview documents included —
      // the only way a test can see an exact preview land mid-gesture.
      context.renderer.domElement.dataset.e2eRenderedBodies = String(
        bodies.length
      );
      if (xrayFactor < 1) {
        context.renderer.domElement.dataset.e2eXray = String(xrayFactor);
      } else {
        delete context.renderer.domElement.dataset.e2eXray;
      }
      // Pick order, as the boolean form numbers it.
      if (selectedBodyIds.length > 0) {
        context.renderer.domElement.dataset.e2eSelectedBodies =
          selectedBodyIds.join(',');
      } else {
        delete context.renderer.domElement.dataset.e2eSelectedBodies;
      }
    }
    const edgeResolution = context.fatLineResolution();

    for (const body of bodies) {
      let object = context.objectsByBodyId.get(body.bodyId);
      const previous = previousBodies.get(body.bodyId);
      const bodyChanged =
        bodiesChanged && (!previous || !sameBodyProjection(previous, body));
      const geometryChanged =
        bodiesChanged && (!previous || !sameBodyRenderGeometry(previous, body));
      const pickingChanged =
        bodyChanged && (!previous || !sameBodyPickingTopology(previous, body));
      if ((geometryChanged || pickingChanged) && object) {
        // Highlight attributes alias the installed mesh. Detach before changing
        // buffers so old face ranges can never pick or shade the new topology.
        for (const name of [
          'body-selection-overlay',
          'body-preview-face-overlay'
        ]) {
          const overlay = object.getObjectByName(name);
          if (overlay instanceof THREE.Group) {
            const group = overlay as unknown as THREE.Group;
            clearGroup(group);
            object.remove(group);
          }
        }
        const edges = context.edgeOverlaysByBodyId.get(body.bodyId);
        if (edges) {
          object.remove(edges);
          disposeObject(edges);
          context.edgeOverlaysByBodyId.delete(body.bodyId);
        }
        if (geometryChanged && !updateObjectForBody(object, body)) {
          context.bodyGroup.remove(object);
          disposeObject(object);
          object = undefined;
        }
      }
      if (!object) object = createObjectForBody(body, edgeResolution);
      object.userData.bodyId = body.bodyId;
      const previousSelectionOverlay = object.getObjectByName(
        'body-selection-overlay'
      );
      if (previousSelectionOverlay instanceof THREE.Group) {
        const selectionGroup =
          previousSelectionOverlay as unknown as THREE.Group;
        if (bodiesChanged) {
          // The body itself is being replaced, so there is nothing for the
          // old highlight to fade against.
          clearGroup(selectionGroup);
          object.remove(selectionGroup);
        } else {
          retireOverlay(context, retiringOverlaysRef.current, selectionGroup);
        }
      }
      const previousPreviewOverlay = object.getObjectByName(
        'body-preview-face-overlay'
      );
      if (previousPreviewOverlay instanceof THREE.Group) {
        const previewGroup = previousPreviewOverlay as unknown as THREE.Group;
        clearGroup(previewGroup);
        object.remove(previewGroup);
      }
      // A face, edges or a History row's faces on this body are the
      // selection; the body around them is only their context, so it takes
      // neither the whole-body tint nor the whole-body outline.
      const bodyFocusFaces = (body.topology?.faces ?? []).filter((face) =>
        focusFaces.some(
          (focus) =>
            focus.bodyId === body.bodyId && focus.topologyId === face.topologyId
        )
      );
      const partPicked =
        bodyFocusFaces.length > 0 ||
        (selectedTopology !== null &&
          selectedTopology.kind !== 'body' &&
          selectedTopology.bodyId === body.bodyId) ||
        selectedEdges.some((edge) => edge.bodyId === body.bodyId);
      const isSelected =
        selectedBodyIds.includes(body.bodyId) &&
        !(selectionRecedes && partPicked);

      // X-ray scales every body's own opacity, so a body already made
      // translucent by its appearance stays the fainter of the two.
      const faceOpacity = (body.opacity ?? 1) * xrayFactor;
      forEachMesh(object, (mesh) => {
        if (bodyChanged || mesh.userData.appliedOpacity !== faceOpacity) {
          updateBodyMaterialOpacity(mesh.material, faceOpacity);
          mesh.userData.appliedOpacity = faceOpacity;
        }
        const baseEmissive = isSelected ? SELECTION_EMISSIVE : 0x000000;
        mesh.material.emissive.setHex(baseEmissive);
        mesh.userData.baseEmissive = baseEmissive;
        // A colour write, not a new material: nothing recompiles when the
        // selection changes.
        contextBodyColor(
          body.color,
          !selectionRecedes || isSelected,
          mesh.material.color
        );
        if (bodiesChanged) {
          mesh.userData.bodyId = body.bodyId;
          mesh.userData.topology = body.topology;
          mesh.castShadow = true;
          mesh.receiveShadow = false;
        }
      });

      let edgeOverlay = context.edgeOverlaysByBodyId.get(body.bodyId);
      if (!edgeOverlay) {
        edgeOverlay = createBodyEdgeOverlay(body, edgeResolution);
        edgeOverlay.setDisplayMode(displayModeRef.current);
        object.add(edgeOverlay);
        context.edgeOverlaysByBodyId.set(body.bodyId, edgeOverlay);
      }
      edgeOverlay?.setSelected(selectedEdges);
      edgeOverlay?.setBodySelected(isSelected);
      edgeOverlay?.setXrayEnabled(xrayEnabled);
      edgeOverlay?.setXrayView(xrayFactor < 1);
      if (bodiesChanged) {
        context.bodyGroup.add(object);
        context.objectsByBodyId.set(body.bodyId, object);
      }

      const selectedFace =
        selectedTopology?.kind === 'face' &&
        selectedTopology.bodyId === body.bodyId
          ? body.topology?.faces.find(
              (face) => face.topologyId === selectedTopology.topologyId
            )
          : undefined;
      edgeOverlay?.setSelectedFaceBoundary(
        selectedFace
          ? selectedFace.hash
          : bodyFocusFaces.length > 0
            ? bodyFocusFaces.map((face) => face.hash)
            : null
      );
      /**
       * The visible fill of a selected face. While the rest recedes it is the
       * face's own colour lifted toward a light accent, drawn under the edges
       * so its rim and edges stay on top; it is what keeps the selection at
       * full brightness while the body around it dims. While sketching, the
       * old translucent accent film, since nothing recedes there.
       */
      const bodyMaterial =
        object instanceof THREE.Mesh &&
        object.material instanceof THREE.MeshPhongMaterial
          ? object.material
          : null;
      const selectedFill = (geometry: THREE.BufferGeometry) => {
        // Rebuilt for every body refresh and every new pick, usually after
        // the previous one was disposed: kept, so it never relinks.
        let material: THREE.Material;
        let ownColour = false;
        if (selectionRecedes && bodyMaterial) {
          // The body's own material, so the face shades exactly as it does
          // unselected (and shares its compiled program); only its colour
          // is lifted.
          const fill = keepProgram(bodyMaterial.clone());
          selectedFaceColor(body.color, fill.color);
          fill.emissive.setHex(0x000000);
          fill.transparent = true;
          fill.opacity = 0;
          fill.depthWrite = false;
          fill.stencilWrite = false;
          fill.polygonOffset = true;
          fill.polygonOffsetFactor = -3;
          fill.polygonOffsetUnits = 0;
          fill.userData.targetOpacity = faceOpacity;
          material = fill;
          ownColour = true;
        } else {
          material = keepProgram(
            new THREE.MeshLambertMaterial({
              color: SELECTED_FACE_COLOR,
              toneMapped: false,
              transparent: true,
              opacity: 0,
              side: THREE.DoubleSide,
              depthWrite: false,
              polygonOffset: true,
              polygonOffsetFactor: -3
            })
          );
          material.userData.targetOpacity = SELECTED_FACE_OPACITY;
        }
        const fill = new THREE.Mesh(geometry, material);
        fill.renderOrder = ownColour
          ? VIEWPORT_RENDER_ORDER.SELECTED_FACE_FILL
          : VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY;
        fill.userData.selectionOverlay = true;
        // The fill follows the body: ordinary wireframe uses its rim,
        // while X-ray displays translucent surfaces (see applyDisplayMode).
        fill.userData.ownColourFill = ownColour;
        fill.visible =
          !ownColour ||
          displayModeRef.current !== 'wireframe' ||
          xrayRef.current;
        fill.raycast = () => undefined;
        context.fadeIns.add(material);
        return fill;
      };
      if (bodyFocusFaces.length > 0 && !selectedFace) {
        const focusOverlay = new THREE.Group();
        focusOverlay.name = 'body-selection-overlay';
        for (const face of bodyFocusFaces) {
          const geometry = createFaceHighlightGeometry(object, face);
          if (geometry) {
            const fill = selectedFill(geometry);
            fill.name = 'body-face-focused';
            focusOverlay.add(fill);
          }
        }
        object.add(focusOverlay);
      }
      if (selectedFace) {
        const geometry = createFaceHighlightGeometry(object, selectedFace);
        const hiddenGeometry = createFaceHighlightGeometry(
          object,
          selectedFace
        );
        if (!geometry || !hiddenGeometry) {
          geometry?.dispose();
          hiddenGeometry?.dispose();
          continue;
        }
        const selectionOverlay = new THREE.Group();
        selectionOverlay.name = 'body-selection-overlay';
        object.add(selectionOverlay);
        if (E2E_CANVAS_HOOKS_ENABLED) {
          context.renderer.domElement.dataset.e2eSelectedFace =
            selectedFace.topologyId;
        }
        const highlight = selectedFill(geometry);
        highlight.name = 'body-face-selected';
        selectionOverlay.add(highlight);

        // Kept, like the visible fill, so it never relinks its shader.
        const hiddenMaterial = keepProgram(
          new THREE.MeshBasicMaterial({
            color: SELECTED_FACE_COLOR,
            toneMapped: false,
            transparent: true,
            // The one eased half of the highlight: the visible fill cuts in,
            // but a pass seen through the solid reads as a flicker when it
            // pops, so this one rises (and, retired, falls) over a few frames.
            opacity: 0,
            side: THREE.DoubleSide,
            depthWrite: false,
            depthFunc: THREE.GreaterDepth
          })
        );
        hiddenMaterial.userData.targetOpacity = SELECTED_FACE_HIDDEN_OPACITY;
        context.selection.easeOpacity(hiddenMaterial);
        context.fadeIns.add(hiddenMaterial);
        const hiddenHighlight = new THREE.Mesh(hiddenGeometry, hiddenMaterial);
        hiddenHighlight.name = 'body-face-selected-hidden';
        hiddenHighlight.visible = xrayEnabled;
        hiddenHighlight.renderOrder =
          VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY - 1;
        hiddenHighlight.userData.selectionOverlay = true;
        hiddenHighlight.raycast = () => undefined;
        selectionOverlay.add(hiddenHighlight);

        if (selectedFace.geometry) {
          const analyticGhost = createAnalyticCylinderGhost(
            selectedFace.geometry,
            edgeResolution
          );
          if (analyticGhost) {
            selectionOverlay.add(analyticGhost);
          }
        }

        if (editableBodyIds.includes(body.bodyId)) {
          const normal = normalForTriangle(body, selectedFace.triangleStart);
          if (normal) {
            const { axis } = directEditDirectionFromNormal(normal);
            const value = body.bbox.max[axis] - body.bbox.min[axis];
            geometry.computeBoundingBox();
            const center = geometry.boundingBox?.getCenter(new THREE.Vector3());
            if (center) {
              const dimension = axisDimensionLabel(axis);
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
                color: 0x81a9ff,
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
              valueButton.textContent = `${dimension} ${rounded} ${displayLengthName(
                units as UnitSystem
              )}`;
              pill.appendChild(valueButton);
              element.appendChild(pill);
              const bodyId = body.bodyId;
              valueButton.addEventListener('click', () => {
                const input = document.createElement('input');
                input.className = 'callout-input';
                // Same width as the value it replaces, so the pill does not
                // jump the instant it is clicked.
                input.style.width = `${Math.ceil(valueButton.getBoundingClientRect().width)}px`;
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
      const previewFaces = previewFaceHighlights.flatMap((selection) =>
        selection.bodyId === body.bodyId
          ? (body.topology?.faces ?? []).filter(
              (face) => face.topologyId === selection.topologyId
            )
          : []
      );
      if (previewFaces.length > 0) {
        const previewOverlay = new THREE.Group();
        previewOverlay.name = 'body-preview-face-overlay';
        for (const face of previewFaces) {
          const geometry = createFaceHighlightGeometry(object, face);
          if (!geometry) {
            continue;
          }
          const material = new THREE.MeshLambertMaterial({
            color: SELECTION_SEMANTICS.preview.added,
            toneMapped: false,
            transparent: true,
            // Same cut as a committed selection: which code path built the
            // highlight should not be visible in how it arrives.
            opacity: 0,
            side: THREE.DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -3
          });
          // Geometry that does not exist yet has to read against the body it
          // is being added to, so it keeps the stronger fill.
          material.userData.targetOpacity =
            SELECTION_SEMANTICS.preview.addedOpacity;
          context.fadeIns.add(material);
          const highlight = new THREE.Mesh(geometry, material);
          highlight.name = 'body-face-preview-created';
          highlight.renderOrder = VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY;
          highlight.userData.selectionOverlay = true;
          highlight.raycast = () => undefined;
          previewOverlay.add(highlight);
        }
        object.add(previewOverlay);
      }
    }

    if (bodiesChanged) {
      applyDisplayMode(
        context.bodyGroup,
        displayModeRef.current,
        xrayRef.current
      );
    }
    context.moveCopyPreview.refreshAppearance(
      displayModeRef.current,
      xrayRef.current
    );
    // Rebuilt bodies and freshly created highlight geometry arrive without
    // clip planes; reapply so an active section survives both.
    applySectionPlane(
      context.bodyGroup,
      sectionViewRef.current
        ? sectionClippingPlane(sectionViewRef.current)
        : null,
      exactSectionRef.current
        ? {
            regions: exactSectionRef.current,
            displayMode: displayModeRef.current,
            xray: xrayRef.current
          }
        : null
    );

    // Retune the key light's shadow frustum around the current model so the
    // grounding shadow stays crisp instead of being clipped or pixelated.
    if (renderChanged) {
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
      context.refreshShadowMap();
    }
    if (bodiesChanged) context.renderedBodies = bodies;

    // A History row whose feature a later one consumed: the faces it made
    // are lit above (as a selected face is), and when none survived its
    // consumed body is drawn as a ghost where it was. The selection chip
    // then hangs over whichever of the two is showing.
    const callout = selectionCalloutRef.current ?? null;
    const focusBox = new THREE.Box3();
    for (const ghost of focusGhostBodiesRef.current ?? []) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(ghost.mesh.vertices, 3)
      );
      geometry.setIndex(new THREE.BufferAttribute(ghost.mesh.indices, 1));
      geometry.computeBoundingBox();
      const material = keepProgram(
        new THREE.MeshBasicMaterial({
          color: SELECTION_SEMANTICS.preview.added,
          toneMapped: false,
          transparent: true,
          opacity: 0.2,
          side: THREE.DoubleSide,
          depthWrite: false,
          // Seen through the part: the consumed body sits inside or on the
          // surface of what replaced it, where a depth-tested ghost would
          // only z-fight.
          depthTest: false
        })
      );
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = 'history-focus-ghost';
      mesh.renderOrder = VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY;
      mesh.raycast = () => undefined;
      context.overlayGroup.add(mesh);
      if (geometry.boundingBox) {
        focusBox.union(geometry.boundingBox);
      }
    }
    if (callout?.anchor === 'focus') {
      for (const object of context.objectsByBodyId.values()) {
        // The focused faces' fill; a live blend preview never shares a
        // focus (it needs a running tool), so that is all this finds.
        const overlay = object.getObjectByName('body-selection-overlay');
        if (overlay) {
          overlay.updateMatrixWorld(true);
          focusBox.union(new THREE.Box3().setFromObject(overlay));
        }
      }
    }
    if (E2E_CANVAS_HOOKS_ENABLED) {
      const ghosts = focusGhostBodiesRef.current?.length ?? 0;
      if (ghosts > 0) {
        context.renderer.domElement.dataset.e2eFocusGhosts = String(ghosts);
      } else {
        delete context.renderer.domElement.dataset.e2eFocusGhosts;
      }
      if (focusFaces.length > 0) {
        context.renderer.domElement.dataset.e2eFocusFaces = String(
          focusFaces.length
        );
      } else {
        delete context.renderer.domElement.dataset.e2eFocusFaces;
      }
      // Whether the rest of the scene is receding behind a selection, which
      // a pixel probe would otherwise have to infer.
      if (selectionRecedes) {
        context.renderer.domElement.dataset.e2eSelectionRecedes = 'true';
      } else {
        delete context.renderer.domElement.dataset.e2eSelectionRecedes;
      }
    }
    /**
     * The selection chip: the name label of old, now also carrying the
     * pick's measurement, its verbs and the clear action when the caller
     * supplies them (lib/selectionCallout). It stays one CSS2D label so the
     * move preview, the edge clamp and the e2e readiness wait all still find
     * it where they always did.
     */
    const addSelectionCallout = (
      box: THREE.Box3,
      fallback: readonly LabelSegment[],
      bodyId: string | null,
      extraClass = ''
    ) => {
      if (!pickLabelRef.current) return;
      const top = box.getCenter(new THREE.Vector3());
      top.z = box.max.z + calloutLift(box, unitsRef.current);
      const label = makeLabel(`selection-callout${extraClass}`, '');
      // Segmented rather than one text run: a cylinder radius drag rewrites
      // the diameter node in place while the document still holds the old
      // value.
      renderSelectionCallout(label.element, fallback, callout);
      selectionCalloutElementRef.current = label.element;
      label.position.copy(top);
      if (bodyId) {
        // The callout lives in the overlay group, not under the body, so a
        // move preview would leave the name behind while its body slid out
        // from under it. Record which body it names and where it rests, and
        // `applyMovePreview` carries it along under the same transform.
        label.userData.calloutBodyId = bodyId;
        label.userData.calloutRestingPosition = top.clone();
      }
      context.overlayGroup.add(label);
    };
    selectionCalloutElementRef.current = null;

    // One body: a name callout. Several: every body wears its pick number,
    // the same number the boolean form's pick list shows, so "which of these
    // is body 1, the base a subtract cuts from" is answered in the viewport.
    // The name alone with a "+2" told the user how many were picked, but not
    // which ones. The chip for the whole pick hangs over all of them.
    // Faces lit together (a History row's, a box sweep's) are the pick even
    // when their bodies are selected, so their chip hangs over the faces.
    const focusCallout = callout?.anchor === 'focus' && !focusBox.isEmpty();
    if (selectedBodyIds.length > 1 && !focusCallout) {
      const pickBox = new THREE.Box3();
      selectedBodyIds.forEach((bodyId, index) => {
        const target = context.objectsByBodyId.get(bodyId);
        const body = bodies.find((candidate) => candidate.bodyId === bodyId);
        if (!target || !body) {
          return;
        }
        const box = new THREE.Box3().setFromObject(target);
        if (box.isEmpty()) {
          return;
        }
        pickBox.union(box);
        const top = box.getCenter(new THREE.Vector3());
        top.z = box.max.z + calloutLift(box, unitsRef.current);
        const label = makeLabel('selection-callout body-order-callout', '');
        const order = document.createElement('span');
        order.className = 'callout-order';
        order.textContent = String(index + 1);
        label.element.append(order, document.createTextNode(body.name));
        label.position.copy(top);
        label.userData.calloutBodyId = bodyId;
        label.userData.calloutRestingPosition = top.clone();
        context.overlayGroup.add(label);
      });
      if (callout && !pickBox.isEmpty()) {
        addSelectionCallout(
          pickBox,
          textLabelSegments(`${selectedBodyIds.length} bodies`),
          null,
          ' selection-callout-over-picks'
        );
      }
    }
    const primaryId =
      selectedBodyIds.length === 1 && !focusCallout
        ? selectedBodyIds[0]
        : undefined;
    if (primaryId) {
      const target = context.objectsByBodyId.get(primaryId);
      const body = bodies.find((candidate) => candidate.bodyId === primaryId);
      if (target && body) {
        const box = new THREE.Box3().setFromObject(target);
        if (!box.isEmpty()) {
          // Spelled as every other surface spells a pick.
          addSelectionCallout(
            box,
            selectedTopology?.bodyId === primaryId &&
              selectedTopology.topologyId
              ? topologySelectionLabelSegments(body, selectedTopology)
              : textLabelSegments(body.name),
            primaryId
          );
        }
      }
    } else if (focusCallout) {
      addSelectionCallout(focusBox, callout.label ?? [], null);
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
      const view = context.captureView();
      onViewChangeRef.current(view);
      onViewSettledRef.current(view);
    }
    context.requestRender();
    if (bodiesChanged) {
      const revision = geometryTraceRef.current;
      if (revision) {
        installedEditRevisionRef.current = revision;
        recordEditPhase(revision, 'installed', {
          analysis: revision.analysis,
          installationMs: performance.now() - installationStarted,
          renderChanged: renderChanged ? 1 : 0
        });
        pendingEditFrameRef.current = revision;
      }
      measure('viewer.bodies', 'viewer.bodies:begin');
      const installationMs = performance.now() - installationStarted;
      traceFaceDrag('install', {
        ms: installationMs,
        detail: { renderChanged: renderChanged ? 1 : 0 }
      });
      if (renderChanged) pendingTracedFrameRef.current = true;
      onGeometryPresentedRef.current?.(installationMs);
    }
  }, [
    bodies,
    editableBodyIds,
    selectedBodyIds,
    selectedEdges,
    selectedTopology,
    previewFaceHighlights,
    focusFaces,
    focusGhostBodies,
    sketchMode,
    units,
    xrayFactor,
    pickLabel
  ]);

  useEffect(() => {
    const context = contextRef.current;
    const installed = installedEditRevisionRef.current;
    if (
      !context ||
      !geometryTrace ||
      context.renderedBodies !== bodies ||
      (installed?.projectId === geometryTrace.projectId &&
        installed.version === geometryTrace.version &&
        installed.analysis === geometryTrace.analysis)
    )
      return;
    // A committed revision can reuse geometry already drawn by its preview,
    // and a revision drawn before its analysis keeps that mesh once analysis
    // is ready. Record its acceptance and a real frame without uploading that
    // mesh again.
    installedEditRevisionRef.current = geometryTrace;
    recordEditPhase(geometryTrace, 'installed', {
      analysis: geometryTrace.analysis,
      installationMs: 0,
      renderChanged: 0,
      reusedInstalledGeometry: 1
    });
    pendingEditFrameRef.current = geometryTrace;
    context.requestRender();
  }, [geometryTrace, bodies]);

  const parameterPreviewFramed = useRef(false);
  const parameterPreviewController = useRef<ParameterPreviewController | null>(
    null
  );
  useEffect(() => {
    const context = contextRef.current;
    if (!context) return;
    const controller = (parameterPreviewController.current ??=
      new ParameterPreviewController());
    context.scene.add(controller.group);
    controller.update(parameterVisualPreview);
    if (parameterVisualPreview) {
      measure('parameter.preview.install', 'parameter.preview.input');
      performance.clearMarks?.('oz:parameter.preview.input');
    }
    if (
      controller.group.children.length &&
      !bodies.length &&
      !parameterPreviewFramed.current &&
      !initialView
    ) {
      fitCameraToObjects(
        context.camera,
        context.controls.target,
        controller.group.children
      );
      if (context.projection === 'orthographic') context.syncOrthographic(true);
      context.controls.update();
      context.hasFitCamera = true;
      parameterPreviewFramed.current = true;
    }
    const hidden = new Set(
      parameterVisualPreview?.flatMap((body) => body.replaces)
    );
    for (const [id, object] of context.objectsByBodyId) {
      object.visible = !hidden.has(id as GeometryBodyRepresentation['bodyId']);
    }
    context.requestRender();
  }, [parameterVisualPreview, bodies, initialView]);
  useEffect(() => () => parameterPreviewController.current?.dispose(), []);

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
    if (E2E_CANVAS_HOOKS_ENABLED) {
      // Republished below only when a gizmo is built, so a probe never reads
      // the last Move's position as this one's.
      delete context.renderer.domElement.dataset.e2eMoveGizmoX;
      delete context.renderer.domElement.dataset.e2eMoveGizmoY;
    }
    if (!movePreview) {
      applyMoveGizmoFocus(context.moveGizmoGroup, null);
      if (moveGizmoHudRef.current) {
        moveGizmoHudRef.current.hidden = true;
      }
      if (moveCommitHold) {
        // Committed move, rebuild in flight: keep its mesh or temporary copy
        // at the applied transform until the exact result replaces it.
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
      context.moveCopyPreview.clear();
      if (E2E_CANVAS_HOOKS_ENABLED) {
        context.renderer.domElement.dataset.e2eMoveCopyPreview = 'false';
      }
      // Cancel without a document change must restore the resting pose.
      for (const object of context.objectsByBodyId.values()) {
        object.position.set(0, 0, 0);
        object.rotation.set(0, 0, 0);
      }
      context.restSelectionCallouts();
      // Nothing about the document changed, so no rebuild will refresh the
      // shadow map — without this the shadow stays where the cancelled move
      // had dragged it.
      context.refreshShadowMap();
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
      context.moveCopyPreview.clear();
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
    if (E2E_CANVAS_HOOKS_ENABLED) {
      // Where the centre handle sits on screen, so a probe can press it
      // instead of guessing at pixels — the same reason the offset rig
      // publishes its handle position.
      const host = context.renderer.domElement;
      const screen = projectToScreen(
        context.moveGizmoGroup.position,
        context.activeCamera,
        host.clientWidth,
        host.clientHeight
      );
      if (screen) {
        host.dataset.e2eMoveGizmoX = String(screen.x);
        host.dataset.e2eMoveGizmoY = String(screen.y);
      } else {
        delete host.dataset.e2eMoveGizmoX;
        delete host.dataset.e2eMoveGizmoY;
      }
    }
  }, [movePreview, moveCommitHold, bodies, sketchViews]);

  useEffect(() => {
    contextRef.current?.applyProjection(projection);
  }, [projection]);

  useEffect(() => {
    const context = contextRef.current;
    if (!context) return;
    context.setFieldOfView(fieldOfView);
    if (E2E_CANVAS_HOOKS_ENABLED) {
      context.renderer.domElement.dataset.e2eFieldOfView = String(
        context.camera.fov
      );
    }
  }, [fieldOfView]);

  // Navigation preferences are read per call, but the orbit controls cache
  // them, so a live toggle has to push the new value onto the instance.
  useEffect(() => {
    contextRef.current?.refreshNavigation();
    // pointerNavigation is read per wheel event rather than cached on the
    // controls, so it needs no refresh — it is listed to keep the set of
    // navigation preferences in one place.
  }, [settings.zoomToCursor, settings.middleDrag, settings.pointerNavigation]);

  // Cylindrical wall radius: the handle moves radially while exact preview
  // geometry rebuilds concentrically around the immutable axis snapshot.
  useEffect(() => {
    const context = contextRef.current;
    if (!context || cylinderRadiusDragActiveRef.current) {
      return;
    }
    const previous = cylinderRadiusRigRef.current;
    const built = cylinderRigBuiltRef.current;
    // Validating a released radius re-derives the same handle, locked: keep
    // the rig, its value and the proxy where the drag left them.
    if (
      previous &&
      built &&
      cylinderRadiusHandle?.locked &&
      sameCylinderHandleTarget(built.handle, cylinderRadiusHandle)
    ) {
      built.handle = cylinderRadiusHandle;
      return;
    }
    // A refused release re-arms the same wall: that handle takes over from
    // the held one at once instead of fading out and back in.
    const takesOver =
      previous !== null &&
      cylinderRadiusHandle !== null &&
      built?.handle.locked === true &&
      sameCylinderHandleTarget(built.handle, cylinderRadiusHandle);
    if (previous) {
      if (takesOver) previous.dispose();
      else retireRig(previous, retiringRigsRef.current);
    }
    cylinderRadiusRigRef.current = null;
    cylinderRigBuiltRef.current = null;
    if (offsetChipRef.current) {
      offsetChipRef.current.hidden = true;
    }
    if (!cylinderRadiusHandle) {
      context.requestRender();
      return;
    }
    // A failed exact release returns the same edit target. Its old mesh is
    // still installed, so restore the held proxy before re-arming the handle.
    cylinderRadiusProxyControllerRef.current?.restore();
    const rig = buildCylinderRadiusHandle({
      origin: cylinderRadiusHandle.point,
      direction: cylinderRadiusHandle.radialDirection,
      originalRadius: cylinderRadiusHandle.originalRadius
    });
    if (takesOver) rig.appear?.();
    context.scene.add(rig.group);
    context.scene.add(rig.worldGroup);
    cylinderRadiusRigRef.current = rig;
    cylinderRigBuiltRef.current = { handle: cylinderRadiusHandle };
    context.requestRender();
  }, [cylinderRadiusHandle]);

  // The cylinder rig effect retires its own rig when the handle changes; this
  // retires the last one when the viewer goes.
  useEffect(
    () => () => {
      const rig = cylinderRadiusRigRef.current;
      if (rig && !cylinderRadiusDragActiveRef.current) {
        retireRig(rig, retiringRigsRef.current);
        cylinderRadiusRigRef.current = null;
        cylinderRigBuiltRef.current = null;
      }
    },
    []
  );

  // Offset-face handle: built when a face is armed, torn down on deselect or
  // commit. Never rebuilt mid-drag (the drag holds offsetDragActiveRef).
  useEffect(() => {
    const context = contextRef.current;
    if (!context || offsetDragActiveRef.current) {
      return;
    }
    const previous = offsetRigRef.current;
    const built = offsetRigBuiltRef.current;
    // Validating a released drag re-derives the same handle, locked. Keep the
    // rig where it was let go — value, ghost and proxy included — instead of
    // fading it out and back in around the commit. Meshes that land meanwhile
    // wait for the commit's own rebuild, as they did while the handle was
    // simply withdrawn for validation.
    if (
      previous &&
      (offsetHandle?.locked || offsetHandle?.entry) &&
      built &&
      sameOffsetHandleTarget(built.handle, offsetHandle)
    ) {
      built.handle = offsetHandle;
      return;
    }
    // The handle validation held, re-armed on the face it just moved (or
    // restored after a refusal), takes over from the one on screen at once.
    const takesOver =
      previous !== null &&
      offsetHandle !== null &&
      (built?.handle.locked === true || built?.handle.entry === true) &&
      built.handle.bodyId === offsetHandle.bodyId;
    if (previous) {
      if (takesOver) previous.dispose();
      else retireRig(previous, retiringRigsRef.current);
    }
    offsetRigRef.current = null;
    offsetRigBuiltRef.current = null;
    if (offsetChipRef.current) {
      offsetChipRef.current.hidden = true;
    }
    if (!offsetHandle) {
      context.requestRender();
      return;
    }
    offsetGhostClearRef.current?.();
    offsetBodyProxyControllerRef.current?.restore();
    // Recognized primitive profiles have a disposable viewport preview.
    // Generic face edits stream exact worker geometry so unrelated faces and
    // compound siblings stay fixed. Neither path overlays a detached slab.
    const placement = offsetHandlePlacement(
      offsetHandle.point,
      offsetHandle.normal
    );
    const body = context.objectsByBodyId.get(offsetHandle.bodyId);
    const handleOrigin = new THREE.Vector3(
      placement.origin.x,
      placement.origin.y,
      placement.origin.z
    );
    const handleDirection = new THREE.Vector3(
      placement.direction.x,
      placement.direction.y,
      placement.direction.z
    );
    // Total reads the line from the picked point back through the part to
    // where it comes out, not the whole body's reach behind the face's plane
    // (which spanned to an unrelated lobe), so it follows where you click.
    const extentBehind = body
      ? (faceDepthBehind(
          body,
          handleOrigin,
          handleDirection,
          faceLift(body, offsetHandle.topologyId, handleOrigin, handleDirection)
        ) ?? bodyExtentBehind(body, handleOrigin, handleDirection))
      : null;
    const chipState = faceOffsetChipState(
      offsetHandle.totalBaseline,
      extentBehind
    );
    offsetExtentRef.current = chipState.extent;
    offsetChipModeRef.current = rearmedChipMode(
      chipState,
      offsetChipModeRef.current,
      previous !== null &&
        previous !== regionRigRef.current &&
        built !== null &&
        built.handle.bodyId === offsetHandle.bodyId &&
        built.handle.topologyId === offsetHandle.topologyId
    );
    // The band starts at the face's old level. A rig re-armed after a preview
    // landed reads the moved face from the rendered body, so the loops go
    // back onto the plane the gesture started from (the pick point stays on
    // the original face; the face only ever moves along its normal).
    const loops = body
      ? faceBoundaryLoops(body, offsetHandle.topologyId)?.map((loop) =>
          loop.map((point) => {
            const lift =
              (point.x - placement.origin.x) * placement.direction.x +
              (point.y - placement.origin.y) * placement.direction.y +
              (point.z - placement.origin.z) * placement.direction.z;
            return {
              x: point.x - placement.direction.x * lift,
              y: point.y - placement.direction.y * lift,
              z: point.z - placement.direction.z * lift
            };
          })
        )
      : null;
    const rig = buildOffsetFaceHandle({
      ...placement,
      ghostGeometry: null,
      pixelRatio: context.renderer.getPixelRatio(),
      ...(loops ? { band: { loops } } : {})
    });
    rig.setValue(offsetHandle.initialValue ?? 0);
    rig.setWarning?.(offsetPreviewInvalidRef.current);
    if (takesOver) rig.appear?.();
    // Fat-line materials need the viewport resolution for correct widths.
    const { width, height } = context.fatLineResolution();
    syncFatLineResolution(rig.worldGroup, width, height);
    context.scene.add(rig.group);
    context.scene.add(rig.worldGroup);
    offsetRigRef.current = rig;
    offsetRigBuiltRef.current = { handle: offsetHandle };
    context.requestRender();
  }, [offsetHandle, bodies]);

  // The rig effect above retires its own rig when the handle changes; this
  // retires the last one when the viewer goes.
  useEffect(
    () => () => {
      const rig = offsetRigRef.current;
      if (rig && !offsetDragActiveRef.current) {
        retireRig(rig, retiringRigsRef.current);
        offsetRigRef.current = null;
        offsetRigBuiltRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    offsetRigRef.current?.setWarning?.(offsetPreviewInvalid);
    edgeRigRef.current?.setWarning?.(offsetPreviewInvalid);
    contextRef.current?.requestRender();
  }, [offsetPreviewInvalid]);

  // Edge-radius handle: built when edges arm fillet/chamfer, torn down on
  // deselect or commit. Never rebuilt mid-drag.
  useEffect(() => {
    const context = contextRef.current;
    edgeHandleOpRef.current = edgeHandle?.op ?? 'fillet';
    if (!context || edgeDragActiveRef.current) {
      return;
    }
    const previous = edgeRigRef.current;
    const built = edgeRigBuiltRef.current;
    if (!edgeHandle) {
      if (previous) retireRig(previous, retiringRigsRef.current);
      edgeRigRef.current = null;
      edgeRigBuiltRef.current = null;
      context.requestRender();
      return;
    }
    // A hidden, consumed or deleted body takes its handle with it.
    const body = bodies.find(
      (candidate) => candidate.bodyId === edgeHandle.bodyId
    );
    let placement = edgeHandle.placement ?? null;
    if (!placement) {
      const edge = body?.topology?.edges.find(
        (candidate) => candidate.topologyId === edgeHandle.topologyId
      );
      if (body && edge) {
        const center = {
          x: (body.bbox.min.x + body.bbox.max.x) / 2,
          y: (body.bbox.min.y + body.bbox.max.y) / 2,
          z: (body.bbox.min.z + body.bbox.max.z) / 2
        };
        placement = edgeHandlePlacement(edge.points, center);
      }
    }
    // The same edge armed again — the keypad opening, a preview landing, a
    // value typed — keeps the rig on screen. Rebuilding it faded the handle
    // out and back in, and a preview body without the picked edge left no
    // handle at all until the preview went.
    const sameTarget =
      previous !== null &&
      built !== null &&
      sameEdgeHandleTarget(built.handle, edgeHandle);
    // A missing edge on a body still shown is a preview's topology: keep the
    // frame. A missing body is not.
    if (
      sameTarget &&
      body !== undefined &&
      (!placement || sameEdgeRigPlacement(built.placement, placement))
    ) {
      built.handle = edgeHandle;
      // The value a rebuild would have taken: the target's (restored after a
      // refusal or a cancelled entry).
      const value = edgeHandle.initialValue ?? 0;
      if (Math.abs(previous.value() - value) > 1e-9) {
        previous.setValue(value);
        context.requestRender();
      }
      return;
    }
    if (previous) {
      // A new frame for the same edge takes over at once; another edge or
      // tool fades the old handle out as before.
      if (sameTarget && body) previous.dispose();
      else retireRig(previous, retiringRigsRef.current);
    }
    edgeRigRef.current = null;
    edgeRigBuiltRef.current = null;
    if (!placement || !body) {
      context.requestRender();
      return;
    }
    const rig = buildEdgeRadiusHandle(placement);
    rig.setValue(edgeHandle.initialValue ?? 0);
    rig.setWarning?.(offsetPreviewInvalidRef.current);
    if (sameTarget) rig.appear?.();
    if (E2E_CANVAS_HOOKS_ENABLED) {
      const host = context.renderer.domElement;
      host.dataset.e2eEdgeRigBuilds = String(
        Number(host.dataset.e2eEdgeRigBuilds ?? 0) + 1
      );
    }
    context.scene.add(rig.group);
    edgeRigRef.current = rig;
    edgeRigBuiltRef.current = { handle: edgeHandle, placement };
    context.requestRender();
  }, [edgeHandle, bodies]);

  // The edge rig effect retires its own rig when the handle changes; this
  // retires the last one when the viewer goes.
  useEffect(
    () => () => {
      const rig = edgeRigRef.current;
      if (rig && !edgeDragActiveRef.current) {
        retireRig(rig, retiringRigsRef.current);
        edgeRigRef.current = null;
        edgeRigBuiltRef.current = null;
      }
    },
    []
  );

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
    const buildGroups = new Map<
      string,
      THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[]
    >();
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
        if (view.selected) {
          // What an image export draws instead: selection is a viewing state.
          line.userData[IMAGE_UNSELECTED_STYLE] = {
            color: curve.construction ? 0x7b8da3 : SKETCH_COLOR,
            linewidth: SKETCH_CURVE_WIDTH,
            opacity: curve.construction ? 0.72 : 0.9
          };
        }
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
          sourceBoundaryLoops: region.sourceBoundaryLoops,
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
            color: 0x7aa0ff,
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
        if (region.buildGroup !== undefined) {
          const key = `${view.sketchId}\u0000${region.buildGroup}`;
          const members = buildGroups.get(key) ?? [];
          members.push(mesh);
          buildGroups.set(key, members);
        }
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
    // A pick of one glyph selects its whole text object, so hovering one
    // lights them all (SelectionManager.setRegionHover).
    for (const members of buildGroups.values()) {
      if (members.length > 1) {
        for (const member of members) {
          member.userData.regionCompanions = members;
        }
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
    // Whatever the previous run left behind goes first, whether or not a
    // new handle follows; a cleanup skipped mid-drag is settled here.
    const leftover = regionRigRef.current;
    if (leftover) {
      leftover.dispose();
      regionRigRef.current = null;
      if (offsetRigRef.current === leftover) {
        offsetRigRef.current = null;
      }
      context.requestRender();
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
    const toWorld = (point: { x: number; y: number }) => ({
      x: basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
      y: basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
      z: basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
    });
    const origin = toWorld(regionHandle.samplePoint);
    // The ghost is the swept volume, not the flat region: it tracks the hand
    // every frame, and the exact solid replaces the scene underneath it at
    // whatever rate the kernel rebuilds.
    const rig = buildOffsetFaceHandle({
      origin,
      direction: basis.normal,
      ghostGeometry: null,
      sweep: {
        cap: { positions, indices },
        loops: [region.outer, ...region.holes].map((loop) => loop.map(toWorld))
      }
    });
    rig.setValue(regionHandle.initialValue ?? 0);
    // The chip machinery is shared with the face offset, so its mode and span
    // still describe the last face armed; a region starts from its own.
    const chipState = regionChipState();
    offsetExtentRef.current = chipState.extent;
    offsetChipModeRef.current = chipState.mode;
    context.scene.add(rig.group);
    context.scene.add(rig.worldGroup);
    offsetRigRef.current = rig;
    regionRigRef.current = rig;
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
        if (regionRigRef.current === rig) {
          regionRigRef.current = null;
        }
      }
      context.requestRender();
    };
  }, [regionHandle, sketchViews]);

  // The other selected regions of a multi-region extrude: one arrow and one
  // swept ghost each, mirroring the armed region rig's value every frame.
  // Kept apart from that rig so its arming stays a single-region concern; a
  // grab on any of these drives that rig (see the pointer-down handler).
  useEffect(() => {
    const context = contextRef.current;
    if (!context || offsetDragActiveRef.current) {
      return;
    }
    for (const leftover of regionFollowerRigsRef.current) {
      leftover.dispose();
    }
    regionFollowerRigsRef.current = [];
    regionChipRigRef.current = null;
    const followers = regionHandle?.followers ?? [];
    const view = regionHandle
      ? sketchViews.find(
          (candidate) => candidate.sketchId === regionHandle.sketchId
        )
      : undefined;
    if (!regionHandle || !view || followers.length === 0) {
      context.requestRender();
      return;
    }
    const rigs = followers.flatMap((follower) => {
      const region = view.regions.find(
        (candidate) =>
          candidate.regionFingerprint === follower.regionFingerprint
      );
      if (!region) {
        return [];
      }
      const rig = buildRegionFollowerRig(view.basis, region, follower);
      rig.setValue(regionHandle.initialValue ?? 0);
      context.scene.add(rig.group);
      context.scene.add(rig.worldGroup);
      return [rig];
    });
    regionFollowerRigsRef.current = rigs;
    context.requestRender();
    return () => {
      if (!offsetDragActiveRef.current) {
        for (const rig of rigs) {
          rig.dispose();
        }
        if (regionFollowerRigsRef.current === rigs) {
          regionFollowerRigsRef.current = [];
        }
        if (
          regionChipRigRef.current &&
          rigs.includes(regionChipRigRef.current)
        ) {
          regionChipRigRef.current = null;
        }
      }
      context.requestRender();
    };
  }, [regionHandle, sketchViews]);

  // The picked regions' Extrude card opens at the head of the right lane,
  // over the stage's right third, and a profile there — where Finish Sketch
  // tends to leave one — had its arrow and preview drawn under the card.
  // Once the card is laid out, glide the view sideways (no orbit, no zoom)
  // just far enough to put the regions and their arrows in the stage the
  // panels leave clear. Once per pick: a value change keeps the key, and
  // an orbit afterwards is the user's own.
  const regionClearanceKey = regionHandle
    ? [
        regionHandle.sketchId,
        regionHandle.regionFingerprint,
        ...(regionHandle.followers ?? []).map(
          (follower) => follower.regionFingerprint
        )
      ].join('|')
    : null;
  useEffect(() => {
    const context = contextRef.current;
    if (!context || !regionClearanceKey) {
      return;
    }
    const [sketchId, ...fingerprints] = regionClearanceKey.split('|');
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (offsetDragActiveRef.current) {
          return;
        }
        // The arrows (and, below, the value chip) must stay reachable; the
        // regions themselves too when they fit in the clear stage.
        const arrows = new THREE.Box3();
        for (const rig of [
          regionRigRef.current,
          ...regionFollowerRigsRef.current
        ]) {
          if (rig) {
            arrows.expandByObject(rig.group);
          }
        }
        const target = arrows.clone();
        for (const child of regionGroupRef.current?.children ?? []) {
          const pick = child.userData.region as RegionPickData | undefined;
          if (
            pick &&
            pick.sketchId === sketchId &&
            fingerprints.includes(String(pick.regionFingerprint))
          ) {
            target.expandByObject(child);
          }
        }
        if (target.isEmpty()) {
          return;
        }
        const canvas = context.renderer.domElement;
        const bounds = canvas.getBoundingClientRect();
        const camera = context.activeCamera;
        const span = (box: THREE.Box3) => {
          const rect = { left: Infinity, top: 0, right: -Infinity, bottom: 0 };
          if (box.isEmpty()) {
            return rect;
          }
          const corner = new THREE.Vector3();
          for (let index = 0; index < 8; index += 1) {
            corner
              .set(
                index & 1 ? box.max.x : box.min.x,
                index & 2 ? box.max.y : box.min.y,
                index & 4 ? box.max.z : box.min.z
              )
              .project(camera);
            const x = bounds.left + ((corner.x + 1) / 2) * bounds.width;
            rect.left = Math.min(rect.left, x);
            rect.right = Math.max(rect.right, x);
          }
          return rect;
        };
        const screen = span(target);
        const reach = span(arrows);
        // The value chip hangs right of the armed arrow's pin, and swaps to
        // its left only when the card would cover it; keep its own side
        // clear so it stays where it reads, not under the tool fold.
        const pin = regionRigRef.current?.group.position
          .clone()
          .project(camera);
        if (pin) {
          const chipEnd =
            bounds.left +
            ((pin.x + 1) / 2) * bounds.width +
            PIN_CHIP_GAP_PX +
            CHIP_LANE_CLEARANCE_PX;
          screen.right = Math.max(screen.right, chipEnd);
          reach.left = Math.min(reach.left, chipEnd);
          reach.right = Math.max(reach.right, chipEnd);
        }
        const shift = shiftIntoFrame(
          screen,
          bounds,
          measurePickFrame(canvas),
          reach.left <= reach.right ? reach : screen
        );
        // Only away from the card: a pick under the column or the tool fold
        // on the left was never under it, and stays where the user put it.
        if (shift > -1 || !(bounds.width > 0)) {
          return;
        }
        // Where the regions' centre must move to, at its own depth: the
        // camera travels the opposite way, parallel to the screen.
        const anchor = target.getCenter(new THREE.Vector3());
        const moved = anchor.clone().project(camera);
        moved.x += (shift / bounds.width) * 2;
        moved.unproject(camera);
        const travel = anchor.sub(moved);
        const perspective = context.camera;
        const heldUp = perspective.up.clone();
        context.startCameraTween(
          {
            position: perspective.position.clone().add(travel),
            target: context.controls.target.clone().add(travel),
            near: perspective.near,
            far: perspective.far,
            // A held roll (a face view) stays as it is.
            ...(heldUp.z === 1 ? {} : { up: heldUp })
          },
          () => {
            if (context.projection === 'orthographic') {
              context.syncOrthographic(false);
            }
          },
          { ease: viewJumpEase }
        );
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [regionClearanceKey]);

  // Ghost planes while the Sketch tool waits for one. Installed and torn
  // down with the armed state; the render loop keeps their screen size.
  useEffect(() => {
    const context = contextRef.current;
    if (!context || !planePickerArmed) {
      return;
    }
    const rig = buildPlanePickerRig();
    // The render loop sizes it against the live camera on the next frame;
    // this only keeps the first frame from drawing a unit-sized sliver.
    rig.setScale(0.05);
    rig.setOffset(planePickerOffsetRef.current);
    context.scene.add(rig.group);
    planePickerRigRef.current = rig;
    context.requestRender();
    return () => {
      context.scene.remove(rig.group);
      rig.dispose();
      if (planePickerRigRef.current === rig) {
        planePickerRigRef.current = null;
      }
      context.requestRender();
    };
  }, [planePickerArmed]);

  // U09 axis lines while an in-place command shows its axis slot. Keyed on
  // the candidates' identity, so a hover or value change does not rebuild.
  const axisPickerKey = axisPicker
    ? axisPicker.candidates
        .map(
          (c) =>
            `${c.id}:${c.origin.x},${c.origin.y},${c.origin.z}:${c.direction.x},${c.direction.y},${c.direction.z}`
        )
        .join('|')
    : null;
  const axisPickerCandidatesRef = useRef(axisPicker?.candidates ?? []);
  axisPickerCandidatesRef.current = axisPicker?.candidates ?? [];
  useEffect(() => {
    const context = contextRef.current;
    if (!context || axisPickerKey === null) {
      return;
    }
    const rig = buildAxisPickerRig(axisPickerCandidatesRef.current);
    rig.setScale(() => 0.05);
    context.scene.add(rig.group);
    axisPickerRigRef.current = rig;
    context.requestRender();
    return () => {
      context.scene.remove(rig.group);
      rig.dispose();
      if (axisPickerRigRef.current === rig) {
        axisPickerRigRef.current = null;
      }
      context.requestRender();
    };
  }, [axisPickerKey]);
  const selectedAxisId = axisPicker?.selectedId ?? null;
  useEffect(() => {
    axisPickerRigRef.current?.setSelected(selectedAxisId);
    contextRef.current?.requestRender();
  }, [selectedAxisId, axisPickerKey]);

  // U09 command handles: each built per key and disposed with it; a key
  // that survives keeps its rig, so a value change never rebuilds one. A
  // rig starts at the command's current value, so a rebuild never jumps.
  const commandHandlesKey = commandHandles
    .map((handle) => `${handle.valueId}=${handle.key}`)
    .join('|');
  useEffect(() => {
    const context = contextRef.current;
    const makeChip = commandChipFactoryRef.current;
    if (!context || !makeChip) return;
    const rigs = commandRigsRef.current;
    const wanted = commandHandlesRef.current;
    for (const [valueId, entry] of rigs) {
      if (wanted.some((h) => h.valueId === valueId && h.key === entry.key)) {
        continue;
      }
      entry.rig?.dispose();
      entry.chip.remove();
      rigs.delete(valueId);
    }
    for (const handle of wanted) {
      if (rigs.has(handle.valueId)) continue;
      const rig =
        handle.kind === 'angle'
          ? buildAngleHandle({
              ...handle.params,
              angleDeg: handle.value,
              // The rig shares the value's domain, so a sub-degree revolve
              // is drawn and labelled as the angle that is stored.
              ...(handle.min === undefined ? {} : { minDeg: handle.min }),
              ...(handle.max === undefined ? {} : { maxDeg: handle.max })
            })
          : handle.kind === 'linear'
            ? buildLinearHandle({
                ...handle.params,
                value: handle.value,
                ...(handle.min === undefined ? {} : { min: handle.min }),
                ...(handle.max === undefined ? {} : { max: handle.max })
              })
            : null;
      if (rig) {
        context.scene.add(rig.group);
        context.scene.add(rig.worldGroup);
      }
      const chip = makeChip();
      chip.dataset.testid = `command-handle-${handle.valueId}`;
      const valueId = handle.valueId;
      chip.addEventListener('click', () => {
        const entry = commandRigsRef.current.get(valueId);
        const view = commandHandlesRef.current.find(
          (candidate) => candidate.valueId === valueId
        );
        const value = entry?.rig ? entry.rig.value() : view?.value;
        if (value !== undefined)
          onOpenCommandKeypadRef.current?.(valueId, value);
      });
      rigs.set(handle.valueId, {
        key: handle.key,
        rig,
        anchor:
          handle.kind === 'chip'
            ? new THREE.Vector3(
                handle.params.anchor.x,
                handle.params.anchor.y,
                handle.params.anchor.z
              )
            : null,
        chip
      });
    }
    commandSetterRef.current =
      rigs.size > 0
        ? (valueId, value) => {
            commandRigsRef.current.get(valueId)?.rig?.setValue(value);
            context.requestRender();
          }
        : null;
    if (commandDragRef.current && !rigs.has(commandDragRef.current.valueId)) {
      // A command canceled mid-drag lets go of the pointer and the drag
      // phase, or the pointer-up that follows finds no drag to end.
      retireCommandDragRef.current?.();
    }
    context.requestRender();
  }, [commandHandlesKey, commandSetterRef]);
  // A value that changes from outside the rig (a default the picks suggest,
  // an undo) moves its rig too: the rigs are rebuilt only for a new key, and
  // a stale one would draw one value and drag from it while another builds.
  useEffect(() => {
    for (const handle of commandHandles) {
      if (commandDragRef.current?.valueId === handle.valueId) continue;
      const rig = commandRigsRef.current.get(handle.valueId)?.rig;
      if (rig && rig.value() !== handle.value) rig.setValue(handle.value);
    }
    contextRef.current?.requestRender();
  }, [commandHandles]);
  // Everything goes when the viewer does.
  useEffect(
    () => () => {
      for (const entry of commandRigsRef.current.values()) {
        entry.rig?.dispose();
        entry.chip.remove();
      }
      commandRigsRef.current.clear();
    },
    []
  );

  // U09 curve picker: sketch curves made clickable while a command wants
  // them (a sweep's path).
  const curvePickerKey = curvePicker
    ? curvePicker.candidates.map((candidate) => candidate.id).join('|')
    : null;
  const curvePickerCandidatesRef = useRef(curvePicker?.candidates ?? []);
  curvePickerCandidatesRef.current = curvePicker?.candidates ?? [];
  useEffect(() => {
    const context = contextRef.current;
    if (!context || curvePickerKey === null) return;
    const rig = buildCurvePickerRig(curvePickerCandidatesRef.current);
    context.scene.add(rig.group);
    curvePickerRigRef.current = rig;
    context.requestRender();
    return () => {
      context.scene.remove(rig.group);
      rig.dispose();
      if (curvePickerRigRef.current === rig) curvePickerRigRef.current = null;
      context.requestRender();
    };
  }, [curvePickerKey]);
  // JSON, not a joined string: a curve id is itself `sketchId|entityId`.
  const selectedCurveKey = JSON.stringify(curvePicker?.selectedIds ?? []);
  useEffect(() => {
    curvePickerRigRef.current?.setSelected(
      JSON.parse(selectedCurveKey) as string[]
    );
    contextRef.current?.requestRender();
  }, [selectedCurveKey, curvePickerKey]);

  // Committed datum planes (viewer/datumPlaneRig), rebuilt when the set,
  // a frame or the selection changes; the render loop keeps their size.
  const datumPlaneKey = JSON.stringify(
    (datumPlanes ?? []).map(({ featureId, frame, selected }) => ({
      featureId,
      frame,
      selected
    }))
  );
  useEffect(() => {
    const context = contextRef.current;
    const planes = JSON.parse(datumPlaneKey) as DatumPlaneRigInput[];
    if (!context || planes.length === 0) {
      return;
    }
    const canvas = context.renderer.domElement;
    const rig = buildDatumPlaneRig(planes, {
      color: readDatumColor(canvas),
      resolution: context.fatLineResolution()
    });
    rig.setScale(() => 0.05);
    context.scene.add(rig.group);
    datumPlaneRigRef.current = rig;
    if (E2E_CANVAS_HOOKS_ENABLED) {
      canvas.dataset.e2eDatumPlanes = JSON.stringify(
        planes.map(({ featureId, frame }) => ({
          featureId,
          origin: frame.origin,
          normal: frame.normal
        }))
      );
    }
    context.requestRender();
    return () => {
      context.scene.remove(rig.group);
      rig.dispose();
      if (datumPlaneRigRef.current === rig) datumPlaneRigRef.current = null;
      delete canvas.dataset.e2eDatumPlanes;
      context.requestRender();
    };
  }, [datumPlaneKey]);

  // I05 reference images (viewer/referenceImageRig). One texture per picture,
  // decoded once and kept while any shown image uses it; the rig is rebuilt
  // when the set, a placement, the selection or a finished decode changes.
  const referenceTexturesRef = useRef<ReferenceTextureCache | null>(null);
  referenceTexturesRef.current ??= new ReferenceTextureCache();
  const [referenceTextureVersion, setReferenceTextureVersion] = useState(0);
  const loadReferenceImageRef = useRef(loadReferenceImage);
  loadReferenceImageRef.current = loadReferenceImage;
  const referenceImageKey = JSON.stringify(referenceImages ?? []);
  // Where each picture can be read from, not just which: an archive rewrite
  // changes this and retries a picture that was not yet available.
  const referenceTextureKey = JSON.stringify(
    [
      ...new Map(
        (referenceImages ?? []).map(({ checksumSha256, artifactId }) => [
          `${checksumSha256}|${artifactId}`,
          { checksumSha256, artifactId }
        ])
      ).values()
    ].sort((a, b) =>
      `${a.checksumSha256}|${a.artifactId}`.localeCompare(
        `${b.checksumSha256}|${b.artifactId}`
      )
    )
  );
  useEffect(() => {
    const load = loadReferenceImageRef.current;
    referenceTexturesRef.current!.sync(
      JSON.parse(referenceTextureKey) as ReferenceTextureRequest[],
      (checksum) => (load ? load(checksum) : Promise.resolve(null)),
      () => setReferenceTextureVersion((version) => version + 1)
    );
  }, [referenceTextureKey]);
  useEffect(() => {
    const cache = referenceTexturesRef.current!;
    return () => cache.clear();
  }, []);
  useEffect(() => {
    const context = contextRef.current;
    const images = JSON.parse(referenceImageKey) as ReferenceImageDisplay[];
    if (!context || images.length === 0) {
      return;
    }
    const textures = referenceTexturesRef.current!.textures;
    const rig = buildReferenceImageRig(images, textures);
    context.scene.add(rig.group);
    const canvas = context.renderer.domElement;
    if (E2E_CANVAS_HOOKS_ENABLED) {
      canvas.dataset.e2eReferenceImages = JSON.stringify(
        images.map(({ imageId, frame, width, height, opacity }, index) => ({
          imageId,
          center: frame.center,
          xAxis: frame.xAxis,
          normal: frame.normal,
          width,
          height,
          opacity,
          textured: textures.has(images[index]!.checksumSha256)
        }))
      );
    }
    context.requestRender();
    return () => {
      context.scene.remove(rig.group);
      rig.dispose();
      delete canvas.dataset.e2eReferenceImages;
      context.requestRender();
    };
  }, [referenceImageKey, referenceTextureVersion]);

  // Committed datum axes (viewer/datumAxisRig), rebuilt when the set, a line
  // or the selection changes; the render loop keeps their length.
  const datumAxisKey = JSON.stringify(
    (datumAxes ?? []).map(({ featureId, axis, selected }) => ({
      featureId,
      axis,
      selected
    }))
  );
  useEffect(() => {
    const context = contextRef.current;
    const axes = JSON.parse(datumAxisKey) as DatumAxisRigInput[];
    if (!context || axes.length === 0) {
      return;
    }
    const canvas = context.renderer.domElement;
    const rig = buildDatumAxisRig(axes, {
      color: readDatumColor(canvas),
      resolution: context.fatLineResolution()
    });
    rig.setScale(() => 0.05);
    context.scene.add(rig.group);
    datumAxisRigRef.current = rig;
    if (E2E_CANVAS_HOOKS_ENABLED) {
      canvas.dataset.e2eDatumAxes = JSON.stringify(
        axes.map(({ featureId, axis }) => ({ featureId, ...axis }))
      );
    }
    context.requestRender();
    return () => {
      context.scene.remove(rig.group);
      rig.dispose();
      if (datumAxisRigRef.current === rig) datumAxisRigRef.current = null;
      delete canvas.dataset.e2eDatumAxes;
      context.requestRender();
    };
  }, [datumAxisKey]);

  // A footprint drag outlives no command: one canceled under the pointer,
  // or replaced by another (even of the same tool, in the same render),
  // lets go and draws nothing more.
  const footprintSession = footprintPicker?.session ?? null;
  useEffect(() => () => retireFootprintRef.current?.(), [footprintSession]);

  // The viewport renders on demand, so a typed offset has to ask for the
  // frame that shows it; without this the ghosts only move on the next
  // unrelated invalidation.
  useEffect(() => {
    const rig = planePickerRigRef.current;
    if (!rig) {
      return;
    }
    rig.setOffset(planePickerOffset);
    contextRef.current?.requestRender();
  }, [planePickerOffset]);

  // In-viewport sketch mode lifecycle: build the plane rig, glide the camera
  // head-on, and recede the solids; restore everything on exit. Keyed on the
  // basis object identity so drawing/object updates do not re-enter. The
  // frame rides a ref for the same reason: the entry glide wants the frame
  // as it was at entry, not a re-run per sketch edit.
  const sketchBasis = sketchMode?.basis ?? null;
  const sketchDimensions = sketchMode?.dimensions;
  useEffect(() => {
    const context = contextRef.current;
    if (!context || !sketchBasis || !sketchDimensions) return;
    const overlay = buildSketchDimensions(
      sketchDimensions,
      sketchBasis,
      context.fatLineResolution(),
      (id, anchor) => editSketchDimensionRef.current(id, anchor),
      (clientX, clientY) => {
        const rect = context.renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const ndc = new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1
        );
        context.raycaster.setFromCamera(ndc, context.activeCamera);
        const normal = new THREE.Vector3()
          .crossVectors(
            new THREE.Vector3(
              sketchBasis.u.x,
              sketchBasis.u.y,
              sketchBasis.u.z
            ),
            new THREE.Vector3(sketchBasis.v.x, sketchBasis.v.y, sketchBasis.v.z)
          )
          .normalize();
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          normal,
          new THREE.Vector3(
            sketchBasis.origin.x,
            sketchBasis.origin.y,
            sketchBasis.origin.z
          )
        );
        const hit = context.raycaster.ray.intersectPlane(
          plane,
          new THREE.Vector3()
        );
        if (!hit) return null;
        const delta = hit.sub(
          new THREE.Vector3(
            sketchBasis.origin.x,
            sketchBasis.origin.y,
            sketchBasis.origin.z
          )
        );
        return {
          x: delta.dot(
            new THREE.Vector3(sketchBasis.u.x, sketchBasis.u.y, sketchBasis.u.z)
          ),
          y: delta.dot(
            new THREE.Vector3(sketchBasis.v.x, sketchBasis.v.y, sketchBasis.v.z)
          )
        };
      },
      (id, offset) => moveSketchDimensionRef.current(id, offset)
    );
    context.scene.add(overlay.group);
    sketchDimensionsRef.current = overlay;
    // A label that changes size (its web font arriving) moves the relation
    // glyphs that keep clear of it; draw again so they do.
    overlay.onLabelResize(() => context.requestRender());
    context.requestRender();
    const focusedReference = focusedReferenceDimensionRef.current;
    focusedReferenceDimensionRef.current = null;
    const focusFrame = focusedReference
      ? requestAnimationFrame(() => {
          if (document.activeElement === document.body)
            overlay.focusReference(focusedReference);
        })
      : null;
    return () => {
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
      focusedReferenceDimensionRef.current =
        document.activeElement instanceof HTMLElement
          ? (document.activeElement.dataset.annotationId ?? null)
          : null;
      context.scene.remove(overlay.group);
      overlay.dispose();
      if (sketchDimensionsRef.current === overlay)
        sketchDimensionsRef.current = null;
      context.requestRender();
    };
  }, [sketchBasis, sketchDimensions]);
  const sketchRelations = sketchMode?.relations;
  const sketchRelationStrokes = sketchMode?.relationStrokes;
  const sketchRelationKeepOuts = sketchMode?.relationKeepOuts;
  useEffect(() => {
    const context = contextRef.current;
    if (!context || !sketchBasis || !sketchRelations?.length) return;
    const overlay = buildSketchRelationGlyphs(
      sketchRelations,
      sketchBasis,
      (constraintId) => selectSketchConstraintRef.current?.(constraintId),
      (constraintId, shown) =>
        sketchConstraintSelectionShownRef.current?.(constraintId, shown),
      sketchRelationStrokes,
      sketchRelationKeepOuts
    );
    context.scene.add(overlay.group);
    sketchRelationsRef.current = overlay;
    // The rails, flyouts and floating panels glyphs keep out from under are
    // measured on their own timer, so one that moves over an idle scene
    // still moves the glyphs (it draws a frame only on a change).
    overlay.watchObstacles(context.labelRenderer.domElement, () =>
      context.requestRender()
    );
    context.requestRender();
    return () => {
      context.scene.remove(overlay.group);
      overlay.dispose();
      if (sketchRelationsRef.current === overlay)
        sketchRelationsRef.current = null;
      context.requestRender();
    };
  }, [
    sketchBasis,
    sketchRelations,
    sketchRelationStrokes,
    sketchRelationKeepOuts
  ]);
  const sketchEntryFrameRef = useRef<SketchEntryFrame | null>(null);
  sketchEntryFrameRef.current = sketchMode?.frame ?? null;
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
      curvePoints: [],
      awaitingSecondPoint: false,
      pointerId: null,
      moved: false,
      pressPoint: null
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
    // A face sketch arrives rolled so its +u reads rightward and +v upward:
    // a top face's stored frame has u along world -Y, so under world up its
    // text ran down the screen. Canonical planes keep world up (null).
    const entryUp = sketchEntryUp(sketchBasis);
    const sketchUp = entryUp
      ? new THREE.Vector3(entryUp.x, entryUp.y, entryUp.z)
      : null;
    // Frame the glide's subject when there is one — the attached face, or
    // re-entered content — reusing the normal-to-face fit so a wide face
    // fills a portrait viewport too. Fall back to orient-only at the current
    // distance: a fresh canonical-plane sketch has nothing to frame, and a
    // frame that fails to resolve must not block entering the sketch.
    const framedPose = (() => {
      const frame = sketchEntryFrameRef.current;
      if (!frame) {
        return null;
      }
      const normal = new THREE.Vector3(
        sketchBasis.normal.x,
        sketchBasis.normal.y,
        sketchBasis.normal.z
      );
      if (frame.kind === 'face') {
        const body = bodiesRef.current.find(
          (candidate) => candidate.bodyId === frame.bodyId
        );
        const face = body?.topology?.faces.find(
          (candidate) => candidate.hash === frame.faceHash
        );
        if (!body || !face) {
          return null;
        }
        const points: THREE.Vector3[] = [];
        const firstIndex = face.triangleStart * 3;
        const endIndex = (face.triangleStart + face.triangleCount) * 3;
        for (let corner = firstIndex; corner < endIndex; corner += 1) {
          const vertexIndex = body.mesh.indices[corner];
          if (vertexIndex === undefined) {
            return null;
          }
          points.push(
            new THREE.Vector3().fromArray(body.mesh.vertices, vertexIndex * 3)
          );
        }
        // Target the triangles' area-weighted centroid. The display mesh is
        // already in hand here, so this costs nothing and needs no kernel
        // round trip — and it must not be used for anything persisted, since
        // tessellation quality is a user setting.
        const center =
          faceTrianglesCentroid(points) ??
          new THREE.Vector3(frame.center.x, frame.center.y, frame.center.z);
        return computeNormalToFacePose(
          context.camera,
          points,
          center,
          normal,
          sketchUp
        );
      }
      if (frame.points.length === 0) {
        return null;
      }
      const points = frame.points.map(
        (point) => new THREE.Vector3(point.x, point.y, point.z)
      );
      const center = points
        .reduce((sum, point) => sum.add(point), new THREE.Vector3())
        .divideScalar(points.length);
      return computeNormalToFacePose(
        context.camera,
        points,
        center,
        normal,
        sketchUp
      );
    })();
    const distance = Math.max(context.camera.position.distanceTo(origin), 40);
    const pose = sketchEntryPose(sketchBasis, distance);
    context.controls.enableRotate = false;
    context.startCameraTween(
      framedPose ?? {
        position: new THREE.Vector3(
          pose.position.x,
          pose.position.y,
          pose.position.z
        ),
        target: new THREE.Vector3(pose.target.x, pose.target.y, pose.target.z),
        near: context.camera.near,
        far: context.camera.far,
        ...(sketchUp ? { up: sketchUp } : {})
      },
      () => {
        context.applyProjection('orthographic');
        context.syncOrthographic(true);
      },
      { ease: sketchGlideEase, durationMs: SKETCH_GLIDE_MS }
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
        context.startCameraTween(
          {
            position: saved.position,
            target: saved.target,
            near: context.camera.near,
            far: context.camera.far
          },
          undefined,
          { ease: sketchGlideEase, durationMs: SKETCH_GLIDE_MS }
        );
      }
      context.requestRender();
    };
  }, [sketchBasis]);

  // Drag-phase appearance edits patch the live body material directly so
  // slider drags stay at pointer rate; no document write, no kernel rebuild.
  // The rebuild effect recreates materials from committed state, so this
  // re-applies on top after every bodies change, and its cleanup restores the
  // committed look when the preview clears or the drag ends without commit.
  useEffect(() => {
    const context = contextRef.current;
    if (!context || !appearancePreview) {
      return;
    }
    const object = context.objectsByBodyId.get(appearancePreview.bodyId);
    if (!object) {
      return;
    }
    const patched: {
      material: ViewerBodyMaterial;
      color: THREE.Color;
      opacity: number;
      transparent: boolean;
      depthWrite: boolean;
    }[] = [];
    forEachMesh(object, (mesh) => {
      const material = mesh.material;
      patched.push({
        material,
        color: material.color.clone(),
        opacity: material.opacity,
        transparent: material.transparent,
        depthWrite: material.depthWrite
      });
      if (appearancePreview.color !== undefined) {
        material.color.set(appearancePreview.color);
      }
      if (appearancePreview.opacity !== undefined) {
        const opacity = appearancePreview.opacity * xrayFactorRef.current;
        material.transparent = opacity < 1;
        material.opacity = opacity;
        material.depthWrite = opacity >= 1;
      }
    });
    if (patched.length === 0) {
      return;
    }
    context.requestRender();
    return () => {
      for (const entry of patched) {
        entry.material.color.copy(entry.color);
        entry.material.opacity = entry.opacity;
        entry.material.transparent = entry.transparent;
        entry.material.depthWrite = entry.depthWrite;
      }
      context.requestRender();
    };
  }, [appearancePreview, bodies, xrayFactor]);

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
      if (child.userData.selectionOverlay === true) {
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
        // Eased, not flipped: the recede rides the same fade set as the
        // overlays, subordinate to the entry camera glide, and opts into the
        // ease that set otherwise cuts. A body rebuilt mid-sketch re-enters
        // here at full opacity and fades again.
        context.selection.easeOpacity(material);
        material.transparent = true;
        delete material.userData.restoreOpaque;
        if (reducesMotion(reducedMotionRef.current)) {
          material.opacity = 0.35;
        } else {
          material.userData.targetOpacity = 0.35;
          context.fadeIns.add(material);
        }
      } else if (stored.sketchRecede) {
        // The opacity the bodies pass set last, when it set one: an X-ray
        // switched during the sketch changed it after the recede began.
        const applied = (child.userData as { appliedOpacity?: number })
          .appliedOpacity;
        const restore =
          applied === undefined
            ? stored.sketchRecede
            : { opacity: applied, transparent: applied < 1 };
        if (reducesMotion(reducedMotionRef.current)) {
          material.opacity = restore.opacity;
          material.transparent = restore.transparent;
        } else {
          context.selection.easeOpacity(material);
          material.userData.targetOpacity = restore.opacity;
          if (!restore.transparent) {
            material.userData.restoreOpaque = true;
          }
          context.fadeIns.add(material);
        }
        delete stored.sketchRecede;
      }
    });
    context.requestRender();
    // X-ray is listed so a switch mid-sketch, which the bodies pass applies
    // at full strength, recedes again here.
  }, [sketchMode, bodies, xrayFactor]);

  // The drag handles appear and go with this flag; draw a frame for it.
  useEffect(() => {
    contextRef.current?.requestRender();
  }, [sketchMoveEnabled]);

  // Committed sketch entities re-render after every entity commit.
  useEffect(() => {
    const context = contextRef.current;
    const rig = sketchRigRef.current;
    // A move outlives nothing that owned it: leaving the sketch, the Select
    // tool or the selection drops the drag where it started.
    const heldMove = sketchMoveRef.current;
    if (
      heldMove &&
      (!sketchMode ||
        sketchMode.tool !== 'select' ||
        sketchMode.selectedObjectId !== heldMove.objectId)
    ) {
      cancelSketchMoveRef.current?.();
    }
    if (!context || !rig || !sketchMode) {
      snapTargetsRef.current = [];
      setSketchSnapRefusal(null);
      return;
    }
    const resolve = sketchModeResolver(sketchMode);
    // The machine changes when a drag starts and when it is released, and
    // each change lands here; keep drawing the moved object rather than its
    // stored position until the edit it became has answered.
    const move = sketchMoveRef.current;
    let pendingMove = sketchMoveCommitPendingRef.current;
    if (
      pendingMove &&
      sketchMode.objects.find((object) => object.id === pendingMove?.objectId)
        ?.data !== pendingMove.original
    ) {
      // The edit has landed (or the object is gone): the document is the
      // truth again, solver adjustments and all.
      sketchMoveCommitPendingRef.current = null;
      pendingMove = null;
    }
    drawSketchModeObjects(
      rig,
      sketchMode,
      move?.preview
        ? { objectId: move.objectId, data: move.preview }
        : pendingMove
    );
    // The region fills are the stored profiles; while an object is dragged
    // (or its move is still being committed) they would mark where it was,
    // so they wait for the document to catch up.
    rig.setProfiles(sketchMode.profiles, !move?.active && !pendingMove);
    rig.setDiagnostics(sketchMode.diagnosticPoints);
    try {
      snapTargetsRef.current = collectSketchSnapTargets(
        sketchMode.objects,
        resolve,
        sketchMode.composites,
        requiredValueResolver(
          sketchMode.parameterScope,
          sketchMode.units ?? 'mm'
        )
      );
      setSketchSnapRefusal(null);
    } catch (error) {
      snapTargetsRef.current = [
        { id: 'sketch-origin', x: 0, y: 0, kind: 'origin' }
      ];
      setSketchSnapRefusal(
        error instanceof SketchSnapLimitError ? error.message : null
      );
    }
    context.requestRender();
  }, [sketchMode]);

  // The text card's live outline, laid out again whenever the draft or the
  // sketch it is budgeted against changes. It sits at the last pointer
  // position on the plane, or the sketch origin until the pointer gets there.
  useEffect(() => {
    const rig = sketchRigRef.current;
    if (!rig) {
      return;
    }
    const draft =
      sketchMode?.tool === 'text' ? (sketchMode.textDraft ?? null) : null;
    if (!sketchMode || !draft) {
      // A finished composition forgets where it was: the next one starts
      // under the pointer, not where the last text went.
      textAnchorRef.current = null;
      const sink = sketchTextAnchorSinkRef.current;
      if (sink) {
        sink.current = null;
      }
    }
    // No string, or a size that does not resolve in the current scope:
    // nothing could be placed, so nothing is drawn.
    if (
      !sketchMode ||
      !draft ||
      !textDraftPlaceable(draft, sketchMode.parameterScope, sketchMode.units)
    ) {
      rig.setTextPreview(null, [], () => 0);
    } else {
      const resolve = sketchModeResolver(sketchMode);
      rig.setTextPreview(
        textObjectFromPoint(textAnchorRef.current ?? { x: 0, y: 0 }, draft),
        sketchMode.objects,
        resolve,
        sketchMode.textDraftBudgetError ?? sketchMode.textOutlineBudgetError
      );
    }
    contextRef.current?.requestRender();
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
      gesture.curvePoints = [];
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
          color: sketch.selected ? 0x6798ff : 0x2f4fa8,
          transparent: true,
          opacity: sketch.selected ? 0.3 : 0.1,
          side: THREE.DoubleSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1
        })
      );
      profileFill.userData.sketchId = sketch.sketchId;
      if (sketch.selected) {
        profileFill.userData[IMAGE_UNSELECTED_STYLE] = {
          color: 0x2f4fa8,
          opacity: 0.1
        };
      }
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
      if (sketch.selected) {
        line.userData[IMAGE_UNSELECTED_STYLE] = {
          color: SKETCH_COLOR,
          opacity: 0.5
        };
      }
      line.renderOrder = sketch.selected
        ? VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY
        : VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
      // A selected sketch is named by its feature card, not by a chip over
      // the model.
      context.sketchGroup.add(line);
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
      const view = context.captureView();
      onViewChangeRef.current(view);
      onViewSettledRef.current(view);
    }
    context.requestRender();
  }, [bodies.length, sketches, sketchViews]);

  useEffect(() => {
    const context = contextRef.current;
    if (context) {
      context.grid.visible = settings.showGrid;
      context.shadowCatcher.visible = shouldShowGroundShadow(
        context.activeCamera,
        settings.showGrid
      );
      applyDisplayMode(
        context.bodyGroup,
        settings.displayMode,
        settings.xray === true
      );
      for (const edgeOverlay of context.edgeOverlaysByBodyId.values()) {
        edgeOverlay.setDisplayMode(settings.displayMode);
      }
      context.moveCopyPreview.refreshAppearance(
        settings.displayMode,
        xrayRef.current
      );
      context.requestRender();
    }
  }, [settings.showGrid, settings.displayMode, settings.xray]);

  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }
    const sectionPlane = settings.sectionView
      ? sectionClippingPlane(settings.sectionView)
      : null;
    // An offset ghost stands outside the body group: cut it the same way.
    offsetGhostClipRef.current?.(sectionPlane);
    applySectionPlane(
      context.bodyGroup,
      sectionPlane,
      // The mode is read from the ref, not the deps: the display-mode effect
      // owns a mode CHANGE, and re-running this one for it would rebuild the
      // section geometry to no purpose.
      exactSection
        ? {
            regions: exactSection,
            displayMode: displayModeRef.current,
            xray: xrayRef.current
          }
        : null
    );
    // The frozen ground shadow must follow the cut, not the uncut silhouette.
    context.refreshShadowMap();
    context.requestRender();
  }, [settings.sectionView, exactSection]);

  useEffect(() => {
    const context = contextRef.current;
    // Fit has to include the sketch layer, not just the solids. While a
    // profile pick is open the app asks the user to click a shaded region it
    // has not framed — the camera sits on the model, and a sketch drawn away
    // from it can be off-screen entirely — so fitting to bodies alone answers
    // the wrong question at the one moment fit is most needed.
    if (!context || fitSignal === 0) {
      return;
    }
    const fitTargets = [
      ...context.bodyGroup.children,
      ...(parameterPreviewController.current?.group.children ?? []),
      ...(regionGroupRef.current?.children ?? [])
    ].filter((child) => child.visible);
    if (fitTargets.length === 0) {
      return;
    }
    // Fit keeps the view the user chose (`4` and the view menu give home)
    // and frames into the stage the side panels leave clear.
    const pose = computeFitPose(
      context.camera,
      fitTargets,
      context.viewDirection(),
      0,
      measureFitFrame(context.renderer.domElement)
    );
    context.startCameraTween(
      pose,
      () => {
        if (context.projection === 'orthographic') {
          context.syncOrthographic(true);
        }
      },
      { ease: viewJumpEase }
    );
  }, [fitSignal]);

  // Bring an independently added body into view when needed. Changes to an
  // existing body must leave the camera alone, even if the result extends
  // outside the canvas. The user can explicitly Fit when they want to reframe.
  useEffect(() => {
    const context = contextRef.current;
    if (
      !context ||
      !autoFrame ||
      !context.hasFitCamera ||
      moveDragActiveRef.current ||
      edgeDragActiveRef.current ||
      offsetDragActiveRef.current ||
      cylinderRadiusDragActiveRef.current
    ) {
      return;
    }
    const reached = new THREE.Box3();
    for (const bodyId of createdBodiesToFrame(
      autoFrame.before,
      autoFrame.after,
      autoFrame.features
    )) {
      const object = context.objectsByBodyId.get(bodyId);
      if (object?.visible) reached.expandByObject(object);
    }
    if (
      reached.isEmpty() ||
      boxFullyInView(reached, context.activeCamera, AUTO_FRAME_MARGIN_NDC)
    ) {
      return;
    }
    const pose = computeFitPose(
      context.camera,
      context.bodyGroup.children.filter((child) => child.visible),
      context.camera.position.clone().sub(context.controls.target),
      // The whole canvas, like the trigger above: framing into the clear
      // stage here moved the camera on commits whose result was already in
      // view, because the clear stage changes with whatever card is open.
      AUTO_FRAME_MARGIN_NDC
    );
    context.startCameraTween(
      pose,
      () => {
        if (context.projection === 'orthographic') {
          context.syncOrthographic(true);
        }
      },
      { ease: viewJumpEase }
    );
  }, [autoFrame]);

  // View requests keep the current zoom and glide the camera to the axis —
  // named standard views and the cube's corner diagonals alike.
  useEffect(() => {
    const context = contextRef.current;
    if (!context || !viewRequest) {
      return;
    }
    startRequestedView(context, viewRequest, handledViewRequestRef);
  }, [viewRequest]);

  // A normal-to-face request uses the exact surface normal for orientation
  // and the selected face's display triangles for the target and framing.
  // The surface's own centre is only a fallback: it is the parametric
  // reference point, which on a cylinder-top disc sits on the rim. Body
  // vertices are already world-space projections.
  useEffect(() => {
    const context = contextRef.current;
    if (!context || !normalToFaceRequest) {
      return;
    }
    const handled = handledNormalToFaceRef.current;
    if (
      handled?.context === context &&
      handled.nonce === normalToFaceRequest.nonce
    ) {
      return;
    }
    const body = bodies.find(
      (candidate) => candidate.bodyId === normalToFaceRequest.bodyId
    );
    const face = body?.topology?.faces.find(
      (candidate) => candidate.topologyId === normalToFaceRequest.topologyId
    );
    const geometry = face?.geometry;
    if (
      !body ||
      !face ||
      geometry?.surfaceType !== 'plane' ||
      !geometry.normal
    ) {
      return;
    }

    const points: THREE.Vector3[] = [];
    const firstIndex = face.triangleStart * 3;
    const endIndex = (face.triangleStart + face.triangleCount) * 3;
    for (let corner = firstIndex; corner < endIndex; corner += 1) {
      const vertexIndex = body.mesh.indices[corner];
      if (vertexIndex === undefined) {
        return;
      }
      points.push(
        new THREE.Vector3().fromArray(body.mesh.vertices, vertexIndex * 3)
      );
    }
    const center =
      faceTrianglesCentroid(points) ??
      new THREE.Vector3(
        geometry.center.x,
        geometry.center.y,
        geometry.center.z
      );
    const pose = computeNormalToFacePose(
      context.camera,
      points,
      center,
      new THREE.Vector3(geometry.normal.x, geometry.normal.y, geometry.normal.z)
    );
    if (!pose) {
      return;
    }
    handledNormalToFaceRef.current = {
      context,
      nonce: normalToFaceRequest.nonce
    };
    context.startCameraTween(
      pose,
      () => {
        if (context.projection === 'orthographic') {
          context.syncOrthographic(true);
        }
      },
      { ease: viewJumpEase }
    );
  }, [bodies, normalToFaceRequest]);

  return (
    <div className="viewer-host" ref={hostRef}>
      {sketchSnapRefusal && (
        <div className="sketch-snap-refusal" role="status">
          {sketchSnapRefusal}
        </div>
      )}
    </div>
  );
}
