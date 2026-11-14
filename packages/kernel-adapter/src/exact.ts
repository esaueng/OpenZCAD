import {
  AxialExtentTracker,
  MIN_AXIAL_HISTORY_FEATURES,
  axialRootKey,
  axialCertificateBytes,
  resizeAxialPrefix,
  type AxialExtentCertificate
} from './exact-axial-extent';
import { CooperativeWork } from './cooperative-work';
import {
  cloneIdleLineageView,
  currentIdleLineageView,
  idleLineageViewBytes,
  supportsIdleLineageView,
  type IdleLineageView
} from './exact-idle-lineage-view';
import type { EditAnalysisRequest } from '@openzcad/shared';
import { projectShapeMesh } from './exact-display-projection';
import {
  beginDirectEditProfile,
  profileDirectEditStage
} from './direct-edit-profile';
export type { DirectEditProfile } from './direct-edit-profile';

/** Capture actual WASM calls and adapter stages for a worker performance probe. */
export function profileDirectEdits() {
  return beginDirectEditProfile(RemusKernel.prototype);
}
import { projectReferenceMesh } from './mesh-reference';
import {
  drawingTessellationOfShape,
  MAX_DRAWING_TESSELLATION_BYTES,
  type DrawingBodyTessellation
} from './exact-drawing-tessellation';
export type { DrawingBodyTessellation } from './exact-drawing-tessellation';
import {
  drawingSectionOfShape,
  DrawingSectionError,
  type DrawingSectionBody,
  type DrawingSectionPlane
} from './exact-drawing-section';
export type {
  DrawingSectionBody,
  DrawingSectionPlane
} from './exact-drawing-section';
import { recognizePlanarEmboss } from './planar-emboss';
import {
  rebuildReporter,
  type RebuildProgressListener
} from './rebuild-progress';
export type {
  RebuildProgress,
  RebuildProgressListener
} from './rebuild-progress';
import {
  RemusKernel,
  loadRemusTranslators,
  type RemusIo
} from './remus-runtime';
import {
  runSketchPlanarOperation,
  type SketchPlanarOperation,
  type SketchPlanarResult
} from './sketch-2d-ops';
export type {
  Sketch2dPoint,
  SketchChamferGeometry,
  SketchCorner,
  SketchFilletGeometry,
  SketchOffsetCurve,
  SketchOffsetJoin,
  SketchPlanarOperation,
  SketchPlanarResult
} from './sketch-2d-ops';
import {
  findSketch,
  getParameterScope,
  resolveParamValue,
  getParameterHiddenBodyIds,
  listFeaturesInOrder,
  listNodesByKind,
  rigidImportedSource
} from '@openzcad/document-core';
import { writeDxf, type DxfEntity } from '@openzcad/io-dxf';
import {
  writeAsciiStl,
  writeBinaryStl,
  type StlExportMesh
} from '@openzcad/io-stl';
import { faceDxfEntities } from './exact-dxf';
import { sketchDxfEntities, SketchDxfExportError } from './exact-sketch-dxf';
import { assertSketchProjectionsValid } from './exact-sketch-projection-failures';
export { SketchDxfExportError } from './exact-sketch-dxf';
import { writeSketchSvg } from './exact-sketch-svg';
export type {
  SketchDxfInput,
  SketchDxfInputObject,
  SketchDxfOutcome,
  SketchDxfRefusal,
  SketchDxfRefusalReason,
  SketchDxfSuccess
} from './exact-sketch-dxf';
import {
  exactSolidSection,
  sectionDxfEntities,
  type ExactSectionPlane,
  type SectionOutlineRefusal,
  type SectionOutlineRegion,
  type SectionOutlineReport
} from './exact-section';
export type {
  ExactSectionLoop,
  ExactSectionPlane,
  ExactSectionRefusalReason,
  SectionOutlineRefusal,
  SectionOutlineRegion,
  SectionOutlineReport
} from './exact-section';
import {
  BODY_OPACITY_METADATA_KEY,
  MAX_MESH_SOLID_CONVERSION_TRIANGLES,
  millimetresPerUnit,
  bodyDisplayColor,
  importedSourceReferenceOf,
  isFeatureSuppressed,
  isReadOnlyRecognizedImportedFeature,
  nowIso,
  type ArtifactId,
  type BodyId,
  type BodyMassProperties,
  type BodyRepresentation,
  type GeometryBodyRepresentation,
  type GeometryReadyState,
  type BodyTopology,
  type DerivedState,
  type FaceDistanceMoveMode,
  type FaceGeometry,
  type FaceRecognitionSummary,
  type FaceTopology,
  type FaceTopologyReferenceV5,
  type ImportedSourceReference,
  type OpposingPlanarFacePair,
  type ProjectDocument,
  type SketchId,
  type UnitSystem,
  type Vector3
} from '@openzcad/shared';
import type {
  DxfFaceSelector,
  ExactBuildResult,
  ExactShape,
  ImportedStepDiagnostics,
  MeasuredShape,
  MeasurementWitness,
  PreparedShapeMeasurement
} from './exact-types';
export type { DxfFaceSelector } from './exact-types';
import { diagnoseImportedSolid } from './exact-lineage-builders';
import { releasePreparedFaceMove } from './exact-prepared-face-move';
import {
  hasPreparedGroupEdit,
  releasePreparedGroupEdit
} from './exact-prepared-group-edit';
import {
  blendRegionKeyOfHashes,
  measureOwnedFaceGeometry,
  withFaceGeometryMemo
} from './exact-measure';
import {
  PreviewFaceGeometryCache,
  faceContentDigestsOf
} from './preview-face-geometry-cache';
import {
  hasRefusingFeatureWarning,
  displayMeshGapsAdvisory,
  raiseFeatureWarning
} from './exact-feature-warnings';
import { adapterRefusalRecord } from './adapter-refusal';
import {
  collectRecognizedImportedFeatures,
  importedProofDisplayDimensions,
  recognizeImportedFeatureOnSolid,
  type ImportedRecognitionFaceIdentity
} from './imported-feature-query';
import { recognitionRefusalMessage } from './imported-feature-recognition';
import { recognizeOpening } from './opening-recognition';
import {
  collapseShape,
  takeUnionDisplayMeshForMeasurement,
  UnionVerdictsWithMeshBudget
} from './exact-boolean-helpers';
import {
  bodyOpacityFromMetadata,
  decodeText,
  projectRemusLineageDiagnostic
} from './exact-shape-utils';
import {
  importStepWithOwnBudget,
  stepImportEmptyReason,
  type StepImportReport
} from './kernel-step-import';
import {
  buildDocumentHistoryCooperatively,
  type StrictUnionVerdict,
  type StrictUnionVerdicts
} from './exact-build-loop';
import { EdgeSelectionMemory } from './exact-edge-selection-transport';
import { suppressedPassThroughBody } from './exact-suppression';
import { ImportedStepCache } from './exact-imported-step-cache';
import { ImportedMeshCache } from './exact-imported-mesh-cache';
import {
  isBuildCancelled,
  raceBuildCancellation,
  throwIfBuildCancelled,
  type BuildCancellationSignal
} from './exact-cancellation';
export type { BuildCancellationSignal } from './exact-cancellation';
import {
  countFaceHandles,
  resolveDirectEditFace
} from './exact-direct-edit-ops';
import {
  MEASUREMENT_DEFLECTION,
  edgeWitnessOf,
  faceWitnessOf,
  registerSolidWitnesses
} from './exact-witnesses';
import {
  nativeVertexEvidence,
  nativeVertexPoint
} from './remus-native-vertices';
import {
  SyncReadMemo,
  TopologyWitnessStore,
  edgeToFaceMapOf,
  surfaceTypeOf,
  withSyncReadMemo
} from './exact-sync-memo';
import {
  brepAdjacentFaceHashes,
  brepEdgeCurve,
  brepEdgeDisplayRole,
  brepSmoothEdges,
  brepVertexIds
} from './exact-brep';
export { brepEdgeCurve, edgeCircleMisfit } from './exact-brep';
export { importMeshFile, type ImportedMeshTriangles } from './mesh-file-import';
import {
  sanitizeBinaryPly,
  sanitizeBinaryStl,
  countExportedTriangles,
  sanitizeThreeMf,
  sanitizeThreeMfModel
} from './mesh-export-sanitize';
import { orientGlbForGltf } from './glb-scene';
import {
  declareStepLengthUnit,
  declareThreeMfUnit,
  explicitAngularTolerance,
  exportLengthScale,
  measureMeshDeviation,
  type ExportUnitOptions,
  type MeshExportTolerances
} from './export-units';
import {
  finishStepExport,
  stepTimestamp,
  stepWriterOptions,
  type StepExportMetadata,
  type StepExportOptions
} from './step-export-metadata';
export { type StepExportOptions } from './step-export-metadata';
export {
  DEFAULT_MESH_ANGULAR_TOLERANCE,
  type ExportUnitOptions,
  type MeshExportTolerances
} from './export-units';
import {
  readMeshQuality,
  type BodyMeshQuality,
  type MeshExportFormat,
  type MeshQualityReport
} from './exact-shape-utils';
export {
  readMeshQuality,
  type BodyMeshQuality,
  type MeshExportFormat,
  type MeshQualityReport
};
import { dot, length, subtract, uniformScaleMatrix } from './exact-math';
import { previewDisplayTessellation } from './display-tessellation';
import {
  publishedSolidBounds,
  refineDraftDisplay,
  solidDisplayTessellation
} from './exact-display-refinement';
import {
  displayOnlyBlendSalt,
  displayOnlyBlendsSupported,
  withDisplayOnlyBlends
} from './display-only-blends';
import {
  MAX_HISTORY_CHECKPOINTS,
  MAX_HISTORY_CHECKPOINT_ESTIMATED_BYTES,
  MAX_HISTORY_REPLAY_WORK,
  cloneBuildState,
  featureAwaitsEnvironment,
  historyCheckpointIndices,
  historyFeatureDigest,
  historyScopeDigest,
  measuredShapeBytes,
  measurementWitness,
  measurementProvenanceKey,
  tailCheckpointIndices,
  withTerminalResultCheckpoint,
  type HistoryCheckpointEntry,
  type MeasuredBodyCacheEntry,
  type PreviewDisplay,
  type PreviewDisplayCacheEntry,
  type CheckpointMemoryStats,
  type RebuildCacheEvent
} from './exact-history-cache';
import {
  kernelSnapshotSupport,
  projectionMatches,
  projectionSignature,
  restoreKernelSnapshot,
  snapshotKernel,
  PERSISTED_HISTORY_SESSION_FORMAT,
  type PersistedHistorySession
} from './exact-session-snapshot';
export {
  estimateStructuredBytes,
  isPersistedHistorySession,
  kernelSnapshotBuildId,
  type PersistedHistorySession
} from './exact-session-snapshot';
import {
  ownedMeshPositions,
  ownedMeshIndices,
  ownedMeshFaceOffsets
} from './owned-mesh-output';
import { PrimitiveBuildCache } from './exact-primitive-cache';
import {
  booleanEvolutionProbeNeeded,
  isBooleanEvolutionProbeEligible
} from './exact-boolean-evolution';
export type { RebuildCacheEvent };
export {
  booleanEvolutionProbeNeeded,
  booleanLineageDemandKey,
  normalizeBooleanLineageDemand,
  type BooleanLineageDemand
} from './exact-boolean-evolution';
import { readBodyMassProperties } from './body-properties';
import {
  inspectDisplayMeshClosure,
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from './boolean-result-validation';
import {
  topologyHashOfWitness,
  topologyWitnessesEqual
} from './topology-lineage';
// Public solver types; the runtime mapping is shared with history projection solves.
import type { SketchSolveAnchor, SketchSolveOutcome } from './gcs-sketch';

export type {
  SketchDofSummary,
  SketchSolveAnchor,
  SketchSolveOutcome,
  SolvedSketchObject
} from './gcs-sketch';
import {
  classifyImportedSolid,
  importedStepDroppedSolidWarning,
  importedStepNoSolidError,
  importedStepRejectedSolidSummary,
  importedStepValidationWarning
} from './imported-step-validation';
import {
  faceDistancePairScore,
  pairNormalVector,
  proveChangedFaceDistance,
  queryOpposingPlanarFacePairs,
  type RemusOpposingPlanarFacePair
} from './exact-face-distance';

const STL_EXPORT_DEFLECTION = 0.08;
// Background discovery runs real trial edits before the first render. Keep
// it bounded to small solids; complex imports retain measured geometry and
// hole recognition, but do not advertise unproven planar-distance edits.
const MAX_PLANAR_FACE_PAIR_QUERY_FACES = 64;
const MAX_FOREGROUND_ANALYSIS_FACES = 2048;
const MAX_FOREGROUND_PAIR_ATTEMPTS = 6;
// Optional moments can take minutes on freeform imported faces. Refuse large
// shapes on demand rather than substituting approximate data.
const MAX_MASS_PROPERTY_QUERY_FACES = 64;
const MAX_PROVEN_FACE_DISTANCE_PAIRS = 30;

function reflectPoint(
  point: Vector3,
  normal: Vector3,
  offset: number
): Vector3 {
  const distance = dot(normal, point) - offset;
  return {
    x: point.x - 2 * distance * normal.x,
    y: point.y - 2 * distance * normal.y,
    z: point.z - 2 * distance * normal.z
  };
}

function reflectDirection(direction: Vector3, normal: Vector3): Vector3 {
  const projection = dot(normal, direction);
  return {
    x: direction.x - 2 * projection * normal.x,
    y: direction.y - 2 * projection * normal.y,
    z: direction.z - 2 * projection * normal.z
  };
}

function mirroredFaceGeometry(
  source: FaceGeometry,
  candidate: FaceGeometry,
  normal: Vector3,
  offset: number,
  linearTolerance: number
): boolean {
  if (source.surfaceType !== candidate.surfaceType) {
    return false;
  }
  const areaTolerance = Math.max(1e-9, source.area * 1e-5);
  if (Math.abs(source.area - candidate.area) > areaTolerance) {
    return false;
  }
  if (
    length(
      subtract(reflectPoint(source.center, normal, offset), candidate.center)
    ) > linearTolerance
  ) {
    return false;
  }
  if (source.normal && candidate.normal) {
    if (
      dot(reflectDirection(source.normal, normal), candidate.normal) <
      1 - 1e-6
    ) {
      return false;
    }
  } else if (source.normal || candidate.normal) {
    return false;
  }
  if (source.axis && candidate.axis) {
    if (
      Math.abs(dot(reflectDirection(source.axis, normal), candidate.axis)) <
      1 - 1e-6
    ) {
      return false;
    }
  } else if (source.axis || candidate.axis) {
    return false;
  }
  return true;
}

function pairBisectsSolidSymmetry(
  faces: ReadonlyMap<number, FaceTopology>,
  pair: RemusOpposingPlanarFacePair,
  bounds: Float64Array | number[]
): boolean {
  const faceA = faces.get(pair.faceA);
  const faceB = faces.get(pair.faceB);
  if (!faceA?.geometry || !faceB?.geometry || faces.size === 0) {
    return false;
  }
  const normal = pairNormalVector(pair);
  const normalLength = length(normal);
  if (!Number.isFinite(normalLength) || normalLength <= Number.EPSILON) {
    return false;
  }
  const unit = {
    x: normal.x / normalLength,
    y: normal.y / normalLength,
    z: normal.z / normalLength
  };
  const offset =
    (dot(unit, faceA.geometry.center) + dot(unit, faceB.geometry.center)) / 2;
  const bboxCenter = {
    x: (bounds[0]! + bounds[3]!) / 2,
    y: (bounds[1]! + bounds[4]!) / 2,
    z: (bounds[2]! + bounds[5]!) / 2
  };
  const diagonal = Math.hypot(
    bounds[3]! - bounds[0]!,
    bounds[4]! - bounds[1]!,
    bounds[5]! - bounds[2]!
  );
  const linearTolerance = Math.max(1e-7, diagonal * 1e-6);
  if (Math.abs(dot(unit, bboxCenter) - offset) > linearTolerance) {
    return false;
  }

  const list = [...faces.values()];
  const unmatched = new Set(list.map((_, index) => index));
  for (const source of list) {
    if (!source.geometry) {
      return false;
    }
    const match = [...unmatched].find((index) => {
      const candidate = list[index]?.geometry;
      return (
        candidate !== undefined &&
        mirroredFaceGeometry(
          source.geometry!,
          candidate,
          unit,
          offset,
          linearTolerance
        )
      );
    });
    if (match === undefined) {
      return false;
    }
    unmatched.delete(match);
  }
  return unmatched.size === 0;
}

function oneSidedFaceDistanceModes(
  faces: ReadonlyMap<number, FaceTopology>,
  pair: RemusOpposingPlanarFacePair,
  bounds: Float64Array | number[]
): [FaceDistanceMoveMode, FaceDistanceMoveMode] {
  const areaTolerance = Math.max(
    1e-9,
    Math.max(pair.faceAreaA, pair.faceAreaB) * 1e-6
  );
  let preferred: FaceDistanceMoveMode;
  if (Math.abs(pair.faceAreaA - pair.faceAreaB) > areaTolerance) {
    preferred =
      pair.faceAreaA < pair.faceAreaB ? 'one-sided-first' : 'one-sided-second';
  } else {
    const center = {
      x: (bounds[0]! + bounds[3]!) / 2,
      y: (bounds[1]! + bounds[4]!) / 2,
      z: (bounds[2]! + bounds[5]!) / 2
    };
    const faceA = faces.get(pair.faceA);
    const faceB = faces.get(pair.faceB);
    const distanceA = faceA?.geometry
      ? length(subtract(faceA.geometry.center, center))
      : 0;
    const distanceB = faceB?.geometry
      ? length(subtract(faceB.geometry.center, center))
      : 0;
    preferred =
      Math.abs(distanceA - distanceB) > 1e-9
        ? distanceA > distanceB
          ? 'one-sided-first'
          : 'one-sided-second'
        : (faceA?.hash ?? Number.MAX_SAFE_INTEGER) <=
            (faceB?.hash ?? Number.MAX_SAFE_INTEGER)
          ? 'one-sided-first'
          : 'one-sided-second';
  }
  return preferred === 'one-sided-first'
    ? [preferred, 'one-sided-second']
    : [preferred, 'one-sided-first'];
}

function planarPairKey(
  faces: ReadonlyMap<number, FaceTopology>,
  pair: RemusOpposingPlanarFacePair
): string {
  const faceA = faces.get(pair.faceA)?.geometry;
  const faceB = faces.get(pair.faceB)?.geometry;
  if (
    faceA?.surfaceType !== 'plane' ||
    faceB?.surfaceType !== 'plane' ||
    faceA.planeOffset === undefined ||
    faceB.planeOffset === undefined
  ) {
    throw new Error('Planar face-pair proof resolved non-planar endpoints.');
  }
  const normal = pair.normal.map((value) => value.toPrecision(12)).join(',');
  return `${normal}:${faceA.planeOffset.toPrecision(12)}:${faceB.planeOffset.toPrecision(12)}`;
}

function provenOpposingPlanarFacePairs(
  kernel: RemusKernel,
  solid: number,
  faces: ReadonlyMap<number, FaceTopology>,
  bounds: Float64Array | number[],
  claimedFaceHashes: ReadonlySet<number>,
  selectedHashes?: readonly number[]
): OpposingPlanarFacePair[] {
  if (
    faces.size >
    (selectedHashes
      ? MAX_FOREGROUND_ANALYSIS_FACES
      : MAX_PLANAR_FACE_PAIR_QUERY_FACES)
  ) {
    return [];
  }
  const ranked = queryOpposingPlanarFacePairs(kernel, solid)
    .filter(
      (pair) =>
        !selectedHashes ||
        selectedHashes.every(
          (hash) =>
            faces.get(pair.faceA)?.hash === hash ||
            faces.get(pair.faceB)?.hash === hash
        )
    )
    .sort(
      (left, right) =>
        faceDistancePairScore(right) - faceDistancePairScore(left) ||
        right.distance - left.distance ||
        left.faceA - right.faceA ||
        left.faceB - right.faceB
    );
  const seenPlanes = new Set<string>();
  const published: OpposingPlanarFacePair[] = [];
  let attempted = 0;
  for (const pair of ranked) {
    const faceA = faces.get(pair.faceA);
    const faceB = faces.get(pair.faceB);
    if (
      !faceA?.reference ||
      !faceB?.reference ||
      claimedFaceHashes.has(faceA.hash) ||
      claimedFaceHashes.has(faceB.hash)
    ) {
      continue;
    }
    const key = planarPairKey(faces, pair);
    if (seenPlanes.has(key)) {
      continue;
    }
    seenPlanes.add(key);
    if (selectedHashes && attempted++ >= MAX_FOREGROUND_PAIR_ATTEMPTS) break;
    const modes: FaceDistanceMoveMode[] = pairBisectsSolidSymmetry(
      faces,
      pair,
      bounds
    )
      ? ['symmetric']
      : oneSidedFaceDistanceModes(faces, pair, bounds);
    let proof: { mode: FaceDistanceMoveMode; distance: number } | null = null;
    for (const mode of modes) {
      const distance = proveChangedFaceDistance(kernel, solid, pair, mode);
      if (distance !== null) {
        proof = { mode, distance };
        break;
      }
    }
    if (!proof) {
      continue;
    }
    published.push({
      faceAHash: faceA.hash,
      faceAReference: faceA.reference,
      faceBHash: faceB.hash,
      faceBReference: faceB.reference,
      distance: pair.distance,
      overlapArea: pair.overlapArea,
      faceAreaA: pair.faceAreaA,
      faceAreaB: pair.faceAreaB,
      normal: pairNormalVector(pair),
      faceABordersBlend: pair.faceABordersBlend,
      faceBBordersBlend: pair.faceBBordersBlend,
      moveMode: proof.mode,
      provenChangedDistance: proof.distance
    });
    if (published.length >= MAX_PROVEN_FACE_DISTANCE_PAIRS) {
      break;
    }
  }
  return published;
}
export interface ExactKernelAdapter {
  readonly kind: 'remus';
  /**
   * Disposable exact drag geometry with the normal validation gates. Defers
   * completion-stage volume and recognition; syncDocument produces commits.
   */
  previewGeometry(
    document: ProjectDocument,
    options?: {
      cancellation?: BuildCancellationSignal;
      yieldControl?: () => Promise<void> | void;
      deferTopology?: boolean;
      fullDisplayQuality?: boolean;
      /** As for `syncDocument`: an edit's preview may propose a carry. */
      proposeCarry?: boolean;
    }
  ): Promise<GeometryReadyState>;
  /** Warm only the disposable full-quality mesh; never commit a feature. */
  refineEditPreview?(document: ProjectDocument): Promise<boolean>;
  syncDocument(
    document: ProjectDocument,
    onProgress?: RebuildProgressListener,
    onProjection?: (derived: DerivedState) => void,
    analysis?: EditAnalysisRequest,
    /**
     * Per-sync options. `cancellation` is a cooperative cancel for a
     * superseded rebuild: checked after the pre-build awaits and at each
     * feature boundary; a fired signal rejects with the typed `cancelled`
     * refusal and commits nothing. `lineageDemand` is the transient set of
     * bodies whose producing booleans must run the evolution probe; it keys
     * the history digest and never reaches the document.
     */
    options?: {
      cancellation?: BuildCancellationSignal;
      lineageDemand?: readonly BodyId[] | ReadonlySet<BodyId>;
      onGeometryReady?: (geometry: GeometryReadyState) => void;
      /** Deliver incoming worker messages between indivisible kernel operations. */
      yieldControl?: () => Promise<void> | void;
      /**
       * An edit's validation: a hash-only fillet/chamfer selection the edit
       * stranded may be carried, and the carry is reported in
       * `edgeHashRepairs` for the caller to store with the edit. Without it a
       * build depends on the document alone.
       */
      proposeCarry?: boolean;
      /**
       * The idle refinement of a draft display (see
       * `exact-display-refinement.ts`): a drag that is still under way
       * keeps what its frames recorded, so its release is drafted as if
       * this sync had never run.
       */
      displayRefinement?: boolean;
      /**
       * A reopened project's persisted session: restored instead of
       * replaying when it matches this document exactly, and published only
       * once its projection matches the one it was captured with. Any
       * mismatch or refusal replays as without it.
       */
      persistedSession?: PersistedHistorySession;
    }
  ): Promise<DerivedState>;
  /** Whether the history kernel holds this project's state. */
  hasHistoryFor?(projectId: ProjectDocument['projectId']): boolean;
  /**
   * The history kernel's state as a persisted session, when it is exactly
   * the complete build of `document` the last sync published; otherwise null.
   */
  captureHistorySession?(
    document: ProjectDocument
  ): Promise<PersistedHistorySession | null>;
  /** Whether a restored session still awaits {@link warmHistory}. */
  needsHistoryWarmup?(projectId: ProjectDocument['projectId']): boolean;
  /**
   * Idle: rebuilds a restored session's checkpoint table in a second kernel
   * and swaps it in once complete; cancellation keeps the restored kernel.
   */
  warmHistory?(
    document: ProjectDocument,
    options?: {
      cancellation?: BuildCancellationSignal;
      yieldControl?: () => Promise<void> | void;
      lineageDemand?: readonly BodyId[] | ReadonlySet<BodyId>;
    }
  ): Promise<boolean>;
  /**
   * Whether a sync result carries a failure of this device's moment — a
   * font face or import source that had not arrived — rather than of the
   * document. Such a result must not be cached by content.
   */
  hasTransientFailures(result: object): boolean;
  /** Epoch of the most recent live sync, or null after its handles were retired. */
  currentMassPropertiesEpoch(): number | null;
  /** Reads one live body's optional properties without replaying document history. */
  readCurrentMassProperties(input: {
    projectId: ProjectDocument['projectId'];
    version: number;
    bodyId: BodyId;
    epoch: number;
  }): MassPropertiesRead;
  /** Restores exact history for an older derived-cache hit without measuring meshes. */
  prepareMassPropertiesForDocument(document: ProjectDocument): Promise<number>;
  /**
   * STEP (AP214) of the given bodies, in millimetres unless `options.units`
   * names another unit — then the geometry is scaled to it and the file's
   * length unit says so. The product is the document, each solid carries its
   * body's name and display colour, and the header names `options.fileName`
   * (the document name otherwise) and `options.timestamp` (now otherwise).
   */
  exportStep(
    document: ProjectDocument,
    bodyIds: BodyId[],
    options?: StepExportOptions
  ): Promise<string>;
  /**
   * DXF R12 outline of one PLANAR face, in millimetres (or `options.units`)
   * — the laser-cutting export. Fails closed on non-planar faces and stale
   * face references.
   */
  exportFaceDxf(
    document: ProjectDocument,
    face: DxfFaceSelector,
    options?: ExportUnitOptions
  ): Promise<string>;
  exportStl(
    document: ProjectDocument,
    bodyIds: BodyId[],
    deflection?: number,
    options?: MeshExportTolerances
  ): Promise<string>;
  /**
   * Tessellated mesh export at a caller-chosen deflection (millimetres,
   * applied after unit scaling — the same space every slicer works in) and
   * optional angular tolerance (radians). `units` scales the written numbers
   * (STL, OBJ, PLY) and the 3MF unit attribute; GLB is always metres.
   */
  exportMesh(
    document: ProjectDocument,
    bodyIds: BodyId[],
    options: {
      format: MeshExportFormat;
      deflection: number;
    } & MeshExportTolerances
  ): Promise<Uint8Array<ArrayBuffer>>;
  /**
   * Pre-export check of the mesh the export would write: welded-mesh
   * watertightness, triangle count and the measured deviation from the
   * exact faces, per body, at the given deflection (mm) and angular
   * tolerance. `units` is the space the writer tessellates in — the export
   * unit, or millimetres for GLB — so the float32 mesh measured is the one
   * saved; deviations are still reported in millimetres.
   */
  meshQuality(
    document: ProjectDocument,
    bodyIds: BodyId[],
    deflection: number,
    tolerances?: MeshExportTolerances
  ): Promise<MeshQualityReport>;
  /**
   * D01 drawing projection input: each body meshed at its nominal display
   * deflection and put in canonical order (see
   * `exact-drawing-tessellation.ts`), so the same exact model always draws
   * the same lines whether it was edited in this session or rebuilt cold.
   * Refuses by name a body that is unknown, consumed or parameter-hidden,
   * and a request whose tessellation would exceed
   * `MAX_DRAWING_TESSELLATION_BYTES` across all its bodies.
   */
  drawingTessellation(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<Record<BodyId, DrawingBodyTessellation>>;
  /**
   * D03 section view input: each body cut exactly by the half-space behind
   * `plane` (see `exact-drawing-section.ts`), then meshed like
   * `drawingTessellation`, with its cut faces and edge topology. A body wholly
   * in front of the plane comes back empty. Refuses, like
   * `drawingTessellation`, a body that is unknown, consumed or hidden, and a
   * plane that cuts none of the bodies.
   */
  drawingSection(
    document: ProjectDocument,
    bodyIds: BodyId[],
    plane: DrawingSectionPlane
  ): Promise<Record<BodyId, DrawingSectionBody>>;
  /**
   * Solves one sketch's persisted constraints with the kernel's GCS and
   * returns the solved geometry plus classification, DOF, and per-constraint
   * residuals. Read-only: writing solved positions back into the document is
   * the caller's command to make. An `anchor` holds that geometry in place
   * for this solve only; its DOF figures then count the held points as fixed.
   */
  solveSketch(
    document: ProjectDocument,
    sketchId: SketchId,
    options?: { anchor?: SketchSolveAnchor }
  ): Promise<SketchSolveOutcome>;
  /**
   * The exact, kernel-computed cross-section at one plane — section CURVES,
   * not the viewport's display caps. Refusals are reported per body rather
   * than thrown: a plane that cuts one body and misses another is an
   * ordinary section, not a failure.
   *
   * `bodyIds` names exactly what to section. Omitting it falls back to the
   * document's own visibility, which is NOT what a viewport is showing —
   * hiding or isolating a body is device-local view state the adapter
   * cannot see. A caller that has that state must pass its own list.
   */
  sectionOutline(
    document: ProjectDocument,
    plane: ExactSectionPlane,
    bodyIds?: BodyId[]
  ): Promise<SectionOutlineReport>;
  /**
   * The same exact section written as a DXF R12 drawing in millimetres (or
   * `options.units`, which the header then declares).
   * Fails closed: a body the plane cuts but the kernel cannot section
   * refuses the whole export rather than quietly dropping a region.
   *
   * `bodyIds` carries the same meaning as on `sectionOutline`, and callers
   * that draw a section on screen should pass the same list to both — a
   * drawing of a different set of bodies from the one on screen is a
   * drawing of something the user never saw.
   */
  exportSectionDxf(
    document: ProjectDocument,
    plane: ExactSectionPlane,
    bodyIds?: BodyId[],
    options?: ExportUnitOptions
  ): Promise<string>;
  /**
   * One saved sketch's own 2D geometry as a DXF R12 drawing in millimetres
   * (or `options.units`) —
   * the manufacturing export. Exact local-plane LINE/CIRCLE/ARC output, with
   * rectangles and polygons lowered to their authored edge lines, construction
   * geometry excluded, and every other case refused by name rather than
   * silently dropped. See `docs/plans/sketch-dxf-export-plan.md`.
   */
  exportSketchDxf(
    document: ProjectDocument,
    sketchId: SketchId,
    options?: ExportUnitOptions
  ): Promise<string>;
  /**
   * The same sketch geometry as `exportSketchDxf`, as an SVG drawing in the
   * DOCUMENT's units: one user unit per document unit, a viewBox over the
   * exact curve extent, and a physical width/height so it opens at 1:1. Lines,
   * arcs and circles stay exact SVG elements; the refusals are the DXF ones.
   */
  exportSketchSvg(
    document: ProjectDocument,
    sketchId: SketchId,
    options?: { transparent?: boolean }
  ): Promise<string>;
  /**
   * One planar sketch edit on the kernel's 2D operations: a corner fillet, a
   * corner chamfer, or a closed-loop offset. Purely geometric — the caller
   * owns which entities the answer replaces and what constrains them.
   */
  sketchPlanarOperation(
    operation: SketchPlanarOperation
  ): Promise<SketchPlanarResult>;
  inspectStep(data: string | ArrayBuffer): Promise<{
    solid: boolean;
    valid: boolean;
    volume: number;
    /** Accepted indices in the original kernel import order, before rejection filtering. */
    solidIndices: number[];
    /**
     * Why the probe answered as it did, when there is something to say. K0.6:
     * the probe never raises, so a parse error or a rejected open shell has to
     * come back through the value.
     */
    reason?: string;
  }>;
  /**
   * On-demand per-face recognition of one imported STEP face (Phase D of the
   * imported STEP edit plan). Rebuilds the document's exact geometry on the
   * long-lived history kernel — a prefix restore, not a throwaway rebuild —
   * then runs the existing `recognizeImportedFeature` module against the
   * resolved face and returns a typed result.
   *
   * Display-only: the sole edit committed through recognition remains the
   * existing through-hole diameter resize. The returned dimensions are in
   * document units; refusals carry the module's typed reason. Read-only over
   * the kernel: resolved handles are never mutated, and a miss resolves as
   * `seed-face-missing` rather than throwing.
   */
  recognizeImportedFace(input: {
    document: ProjectDocument;
    bodyId: BodyId;
    /** ADR-011 face hash plus optional v5 lineage reference. */
    faceHash: number;
    faceReference?: FaceTopologyReferenceV5;
  }): Promise<FaceRecognitionSummary>;
  dispose(): void;
  /** End disposable drag work on the serialized worker owner. */
  releaseEditPreview?(): void;
}

export type MassPropertiesRead =
  | { status: 'ready'; properties: BodyMassProperties; epoch: number }
  | {
      status: 'unavailable';
      code: 'stale' | 'unsupported' | 'integration-failed';
      reason: string;
      epoch: number | null;
    };

/**
 * Ceiling on retained exact import arena bytes, including the active document.
 * Oversized imports still build exactly but do not enter this optional cache.
 */
export const MAX_IMPORTED_STEP_CACHE_BYTES = 64 * 1024 * 1024;
/** Budget for converted imported-mesh payloads; see `ImportedMeshCache`. */
export const MAX_IMPORTED_MESH_CACHE_BYTES = 64 * 1024 * 1024;

export interface ExactKernelAdapterOptions {
  /**
   * Produces the raw source bytes for a reference-form import. Absent means
   * only legacy embedded imports can rebuild — a reference then fails with an
   * explicit error instead of silently dropping the body. A rejection is a
   * miss this device may recover from (retried by the next sync, never
   * checkpointed) unless the error carries `permanent: true`. `signal`
   * aborts when the build that asked is superseded.
   */
  resolveSourceBytes?: (
    ref: ImportedSourceReference,
    context: {
      artifactId: ArtifactId;
      sourceName: string;
      signal?: AbortSignal;
    }
  ) => Promise<Uint8Array>;
  /**
   * Overrides {@link MAX_IMPORTED_STEP_CACHE_BYTES}. Zero disables import
   * caching; nothing in the app sets it.
   */
  importedStepCacheBytes?: number;
  /**
   * Overrides {@link MAX_IMPORTED_MESH_CACHE_BYTES}. Zero disables mesh
   * conversion caching; nothing in the app sets it.
   */
  importedMeshCacheBytes?: number;
  /**
   * Overrides {@link MAX_HISTORY_CHECKPOINTS}, the maximum number of retained
   * feature prefixes (not a byte budget). Zero disables history caching.
   */
  historyCheckpointLimit?: number;
  /** Admission budget for accounted checkpoint topology bytes, not total RSS. */
  historyCheckpointEstimatedBytes?: number;
  /**
   * Overrides {@link MAX_MEASURED_SHAPE_CACHE_BYTES}. Tests pin the byte
   * budget without building a document large enough to exceed the real one;
   * nothing in the app sets it.
   */
  measuredShapeCacheBytes?: number;
  /**
   * Observes each sync's cache outcome. Tests assert restores actually
   * happen — correctness alone cannot distinguish a hit from a rebuild.
   */
  onRebuildCacheEvent?: (event: RebuildCacheEvent) => void;
  /** Session-local H02 benchmark counters; disabled for ordinary workers. */
  measurementCacheDiagnostics?: boolean;
  /**
   * Publish an unchanged body's retained measurement as is instead of a
   * fresh copy: its mesh buffers, `bbox` and `topology` are then the same
   * objects in every sync that reuses it, and in a sync's geometry-ready
   * publication and its final state. Such a caller must treat body meshes
   * and topology as immutable and copy them before transferring or editing
   * them. Diffing callers then see unchanged bodies by identity instead of
   * comparing every buffer, and each sync skips one copy per body. Off by
   * default: results are otherwise caller-owned, as documented on
   * `storeMeasuredShape`.
   */
  shareRetainedMeasurements?: boolean;
}

/** Bodies whose exact geometry descends from an imported STEP feature. */
function importedExactBodyIds(document: ProjectDocument): Set<BodyId> {
  const imported = new Set<BodyId>();
  for (const feature of listFeaturesInOrder(document)) {
    if (isFeatureSuppressed(feature)) {
      // A suppressed feature that passes its input through hands on the
      // input's imported geometry under its own result id.
      const source = suppressedPassThroughBody(feature);
      if (source !== null && imported.has(source) && feature.bodyId) {
        imported.add(feature.bodyId);
      }
      continue;
    }
    const data = feature.data;
    if (data.featureKind === 'imported-step' && feature.bodyId) {
      imported.add(feature.bodyId);
      continue;
    }
    const targetIsImported =
      'targetBodyId' in data &&
      data.targetBodyId !== undefined &&
      imported.has(data.targetBodyId);
    const booleanUsesImported =
      data.featureKind === 'boolean' &&
      data.targetBodyIds.some((bodyId) => imported.has(bodyId));
    if ((targetIsImported || booleanUsesImported) && feature.bodyId) {
      imported.add(feature.bodyId);
    }
    if (targetIsImported && data.featureKind === 'split') {
      imported.add(data.secondBodyId);
    }
  }
  return imported;
}

/**
 * Published instead of measuring the opening of an imported body that is no
 * longer the import under fixed moves or rotations.
 */
const OPENING_NEEDS_RIGID_IMPORT =
  'Only an imported STEP body with at most fixed moves or rotations after import can be grown. This body has other history since import (a shape edit, scaling, parameter-driven placement or a boolean), so its opening is not measured.';

/**
 * Budget for retained per-body measurements. The cache holds at most one
 * entry per live body, so this only bites on huge documents; eviction drops
 * the oldest entries, which then simply re-measure on their next sync.
 */
const MAX_MEASURED_SHAPE_CACHE_BYTES = 128 * 1024 * 1024;

/** A cache proof failed; retry once in an empty kernel, never publish the hit. */
class HistoryCacheIntegrityError extends Error {}

function isCheckpointHandle(handle: number): boolean {
  return Number.isSafeInteger(handle) && handle >= 0 && handle <= 0xffff_ffff;
}

function checkpointMemoryStats(
  kernel: RemusKernel
): CheckpointMemoryStats | undefined {
  const diagnostic = kernel as RemusKernel & {
    checkpointMemoryStats?: () => string;
  };
  return diagnostic.checkpointMemoryStats
    ? (JSON.parse(diagnostic.checkpointMemoryStats()) as CheckpointMemoryStats)
    : undefined;
}

/**
 * Keeps a build that may propose carrying a hash-only selection apart from
 * a plain build in the history cache: only a hash-only fillet or chamfer can
 * resolve differently between the two, and salting its digest invalidates
 * every checkpoint from it on.
 *
 * The salt is only needed once the two builds actually diverge, which they
 * do only where a stored hash fails to resolve (a carry proposes, a plain
 * build refuses). A checkpoint whose whole prefix resolved every hash-only
 * pick as stored is stored under its plain digests and marked
 * `carryNeutral`, so either kind of build may restore it; see
 * `buildWithHistoryCache`.
 */
function carryProposalSalt(
  feature: { data: { featureKind: string; edgeReferences?: unknown } },
  proposeCarry: boolean
): string {
  return proposeCarry &&
    (feature.data.featureKind === 'fillet' ||
      feature.data.featureKind === 'chamfer') &&
    feature.data.edgeReferences === undefined
    ? '|carry-proposal'
    : '';
}

export class RemusKernelAdapter implements ExactKernelAdapter {
  readonly kind = 'remus' as const;
  constructor(private readonly options: ExactKernelAdapterOptions = {}) {
    this.importedSteps = new ImportedStepCache(
      options.importedStepCacheBytes ?? MAX_IMPORTED_STEP_CACHE_BYTES,
      new ImportedMeshCache(
        options.importedMeshCacheBytes ?? MAX_IMPORTED_MESH_CACHE_BYTES
      )
    );
  }

  /**
   * The mesh payloads the last document referenced, by checksum. References
   * are fetched before every rebuild, whether or not a checkpoint then
   * restores past the mesh; without these a referenced mesh was re-read from
   * the blob store on every edit. Content-addressed bytes never change, so a
   * hit is exact, and keeping only the current document's working set bounds
   * it by what that document's rebuild holds anyway.
   */
  private meshPayloads = new Map<string, Uint8Array>();

  /**
   * Imported STEP results, keyed by the source checksum that fully determines
   * them. An import's geometry depends on nothing else in the document, so a
   * hit is exact by construction — the checksum names the bytes.
   *
   * Entries hold the translator's original exact arena bytes, which restore
   * without re-derivation or tolerance normalisation. Admitted entries skip
   * both STEP parsing and source reads on later rebuilds; refused entries
   * recover their source bytes normally.
   */
  private readonly importedSteps: ImportedStepCache;
  /**
   * Hash-only fillet/chamfer selections this adapter has resolved, so an
   * upstream resize can carry them (`exact-edge-selection-transport.ts`).
   * Adapter-scoped: a new adapter, like a reload, starts empty.
   */
  private readonly edgeSelections = new EdgeSelectionMemory();

  /**
   * Checksums the preceding prefetch failed to resolve for a reason this
   * device may recover from. Read by the build of the same history job.
   */
  private unresolvedSources = new Set<string>();
  private readonly transientResults = new WeakSet<object>();

  hasTransientFailures(result: object): boolean {
    return this.transientResults.has(result);
  }

  /**
   * The adapter-owned history kernel and its retained prefix table, shared by
   * sync, export, mesh-quality and imported-face recognition. Operations that
   * allocate scratch restore the last retained prefix before returning.
   * Checkpoint handles are opaque. Each entry retains the handle returned by
   * its kernel and digests for every feature since the preceding checkpoint,
   * so a changed feature between sparse checkpoints cannot leave a later
   * snapshot valid. Restore truncates the kernel stack and table in lockstep.
   */
  private historyKernel: RemusKernel | null = null;
  private historyCheckpoints: HistoryCheckpointEntry[] = [];
  private readonly historyCheckpointOwners = new Map<
    number,
    HistoryCheckpointEntry
  >();
  private historyScopeKey: string | null = null;
  private historyProjectId: ProjectDocument['projectId'] | null = null;
  private historyReplayWork = 0;
  private readonly primitiveBuildCache = new PrimitiveBuildCache();

  /**
   * A persisted session (`exact-session-snapshot.ts`) offered to the build
   * of the sync that carries it; the build consumes it either way.
   */
  private offeredSession: PersistedHistorySession | null = null;
  /** The outcome of the last offered session, for the next cache event. */
  private sessionRestoreOutcome: 'restored' | 'rejected' | null = null;
  /**
   * The history kernel came from a persisted session: it holds one
   * checkpoint, at the last feature, so an edit of an earlier feature would
   * replay the whole history. {@link warmHistory} rebuilds the ordinary
   * checkpoint table in the background.
   */
  private sparseRestoredHistory = false;
  /**
   * A persisted session seeded the history kernel and its projection has
   * not been matched yet. Nothing may build on or publish from it until it
   * is: a cancelled or failed sync drops it, and so does any later build
   * that finds it still unmatched.
   */
  private unvalidatedSeed = false;
  /**
   * What the last complete build left in the history kernel, recorded by
   * `buildWithHistoryCache` when nothing about it depended on this device's
   * moment or on an edit's proposal; `syncDocument` promotes it to
   * {@link liveSession} with the projection it published.
   */
  private lastBuildRecord: {
    kernel: RemusKernel;
    projectId: string;
    scopeKey: string;
    digests: string[];
    lineageProbeKey: string;
    carryNeutral: boolean;
    demand: ReadonlySet<BodyId> | undefined;
    build: ExactBuildResult;
  } | null = null;
  /**
   * The history kernel's current state, as a complete sync left it, and the
   * projection that sync published: what {@link captureHistorySession} may
   * snapshot. Every other history job, and any restore, clears it first.
   */
  private liveSession:
    | (NonNullable<RemusKernelAdapter['lastBuildRecord']> & {
        derived: DerivedState;
      })
    | null = null;

  /** Task yields must not let another caller restore the owned live arena. */
  private historyJobs: Promise<void> = Promise.resolve();
  private historyGeneration = 0;
  private historyCancellation: BuildCancellationSignal | undefined;

  private runHistoryJob<T>(
    work: () => Promise<T>,
    keepLiveSession = false
  ): Promise<T> {
    const generation = this.historyGeneration;
    const job = this.historyJobs.then(async () => {
      // Any job may move the history kernel away from the state the last
      // complete sync published; only a capture reads it as it is.
      if (!keepLiveSession) this.liveSession = null;
      const lifetime = {
        isCancelled: () => generation !== this.historyGeneration
      };
      throwIfBuildCancelled(lifetime);
      this.historyCancellation = lifetime;
      try {
        const result = await work();
        throwIfBuildCancelled(lifetime);
        return result;
      } finally {
        this.historyCancellation = undefined;
        if (lifetime.isCancelled()) this.clearRetainedState();
      }
    });
    // Rejection releases ownership too; retain neither results nor errors.
    this.historyJobs = job.then(
      () => undefined,
      () => undefined
    );
    return job;
  }

  private historySignal(
    signal?: BuildCancellationSignal
  ): BuildCancellationSignal | undefined {
    const lifetime = this.historyCancellation;
    if (!signal) return lifetime;
    return {
      isCancelled: () =>
        Boolean(lifetime?.isCancelled() || signal.isCancelled())
    };
  }

  private massPropertiesEpoch = 0;
  private currentMassSnapshot: {
    projectId: ProjectDocument['projectId'];
    version: number;
    epoch: number;
    bodies: Map<
      BodyId,
      { solid: number; properties?: BodyMassProperties | null }
    >;
  } | null = null;

  /** A restore or replay retires the exact handles the previous sync published. */
  private clearCurrentMassSnapshot(): void {
    this.massPropertiesEpoch += 1;
    this.currentMassSnapshot = null;
  }

  currentMassPropertiesEpoch(): number | null {
    return this.currentMassSnapshot?.epoch ?? null;
  }

  readCurrentMassProperties(input: {
    projectId: ProjectDocument['projectId'];
    version: number;
    bodyId: BodyId;
    epoch: number;
  }): MassPropertiesRead {
    const snapshot = this.currentMassSnapshot;
    if (
      !snapshot ||
      snapshot.epoch !== input.epoch ||
      snapshot.projectId !== input.projectId ||
      snapshot.version !== input.version ||
      !this.historyKernel
    ) {
      return {
        status: 'unavailable',
        code: 'stale',
        reason:
          'The body geometry changed before its mass properties could be read.',
        epoch: snapshot?.epoch ?? null
      };
    }
    const body = snapshot.bodies.get(input.bodyId);
    if (!body) {
      return {
        status: 'unavailable',
        code: 'unsupported',
        reason: 'Mass properties are unavailable for this body.',
        epoch: snapshot.epoch
      };
    }
    if (body.properties === undefined) {
      body.properties = readBodyMassProperties(this.historyKernel, body.solid);
    }
    return body.properties
      ? { status: 'ready', properties: body.properties, epoch: snapshot.epoch }
      : {
          status: 'unavailable',
          code: 'integration-failed',
          reason: 'The exact kernel could not integrate this body.',
          epoch: snapshot.epoch
        };
  }

  async prepareMassPropertiesForDocument(
    document: ProjectDocument
  ): Promise<number> {
    return this.runHistoryJob(() =>
      this.prepareMassPropertiesInHistory(document)
    );
  }

  private async prepareMassPropertiesInHistory(
    document: ProjectDocument
  ): Promise<number> {
    const { sources, pinned } = await this.prefetchImportSources(document);
    if (documentNeedsTranslators(document)) {
      await loadRemusTranslators();
    }
    try {
      const { kernel, build } = await this.buildWithHistoryCache(
        document,
        sources,
        pinned
      );
      const bodies = new Map<
        BodyId,
        { solid: number; properties?: BodyMassProperties | null }
      >();
      const hiddenBodies = getParameterHiddenBodyIds(document);
      for (const bodyId of document.bodyOrder) {
        if (build.consumed.has(bodyId) || hiddenBodies.has(bodyId)) continue;
        const shape = build.shapes.get(bodyId);
        if (
          shape?.solids.length === 1 &&
          countFaceHandles(kernel, shape.solids) <=
            MAX_MASS_PROPERTY_QUERY_FACES
        ) {
          bodies.set(bodyId, { solid: shape.solids[0]! });
        }
      }
      this.currentMassSnapshot = {
        projectId: document.projectId,
        version: document.version,
        epoch: this.massPropertiesEpoch,
        bodies
      };
      return this.massPropertiesEpoch;
    } catch (error) {
      this.invalidateHistoryCache();
      throw error;
    }
  }

  /**
   * Per-body measure-pass cache; see {@link MeasuredBodyCacheEntry} for the
   * handle-identity soundness argument. Lives and dies with the history
   * kernel: the handles it is keyed by only mean anything inside that
   * kernel's arena, so the two caches share exactly one lifetime and one
   * failure mode.
   */
  private readonly measuredShapeCache = new Map<
    BodyId,
    MeasuredBodyCacheEntry
  >();
  private measuredShapeCacheBytes = 0;
  /**
   * Drag previews' own display projections, for bodies whose last complete
   * measurement no longer matches: a body a drag rebuilt with new handles is
   * otherwise meshed again on every tick. Same lifetime, key and witness check
   * as {@link measuredShapeCache}, under its own byte budget of the same size.
   */
  private readonly previewDisplayCache = new Map<
    BodyId,
    PreviewDisplayCacheEntry
  >();
  private previewDisplayCacheBytes = 0;
  /**
   * The last preview showed a face drag's coarse frame, so the at-rest
   * refinement has a full-quality mesh to warm. A complete sync, a refined
   * preview and a released drag clear it.
   */
  private coarseFaceMoveFrame = false;
  /**
   * The edit whose last preview frame was meshed at the drag tessellation:
   * the source history before it and the body it moves. The complete sync
   * that follows it for the same edit — its release — draws that body with
   * a draft display mesh (see `exact-display-refinement.ts`). Every gating
   * check still runs on the commit; only the display-gap advisory, which
   * describes the full-quality mesh, waits for the refinement. Any complete sync consumes it; a full-quality preview frame,
   * a released preview and a dropped history cache clear it.
   */
  private draftDisplaySource: {
    projectId: ProjectDocument['projectId'];
    source: string;
    bodyId: BodyId;
  } | null = null;
  /**
   * Per body, the linear display deflection each of its solids was last
   * meshed at (see `heldDisplayTessellation`). A display policy, not a
   * geometry cache: it survives history-cache invalidation (a sync whose
   * history cannot be reused still edits the same bodies). Entries for
   * bodies a build no longer produces are pruned with the measured-shape
   * cache, the map is cleared when the project changes, and on dispose.
   */
  private readonly heldDisplayDeflections = new Map<
    BodyId,
    readonly number[]
  >();
  /** The project the held display deflections belong to. */
  private heldDisplayProjectId: ProjectDocument['projectId'] | null = null;
  /** Unchanged faces' measurements, shared by successive drag previews. */
  private readonly previewFaceGeometry = new PreviewFaceGeometryCache();
  /**
   * ADR-011 witnesses per solid handle in the history kernel, so the next
   * edit of a body starts from the witnesses its measurement recorded. Same
   * lifetime and handle-identity argument as {@link measuredShapeCache};
   * every record is revalidated against the solid's live face and edge lists
   * before use (see `exact-sync-memo.ts`).
   */
  private readonly topologyWitnessStore = new TopologyWitnessStore();

  private get maxHistoryCheckpoints(): number {
    return this.options.historyCheckpointLimit ?? MAX_HISTORY_CHECKPOINTS;
  }

  /** Retained JS lineage metadata; kernel topology telemetry excludes it. */
  private get historyLineageMetadataBytes(): number {
    return this.historyCheckpoints.reduce(
      (bytes, entry) => bytes + (entry.lineageMetadataBytes ?? 0),
      0
    );
  }

  private get maxMeasuredShapeCacheBytes(): number {
    return (
      this.options.measuredShapeCacheBytes ?? MAX_MEASURED_SHAPE_CACHE_BYTES
    );
  }

  private invalidateHistoryCache(): void {
    this.sparseRestoredHistory = false;
    this.unvalidatedSeed = false;
    this.liveSession = null;
    this.lastBuildRecord = null;
    this.draftDisplaySource = null;
    if (this.historyKernel) releasePreparedGroupEdit(this.historyKernel);
    this.clearCurrentMassSnapshot();
    this.historyCheckpoints = [];
    this.historyCheckpointOwners.clear();
    this.historyScopeKey = null;
    this.historyProjectId = null;
    this.historyReplayWork = 0;
    this.primitiveBuildCache.clear();
    this.measuredShapeCache.clear();
    this.measuredShapeCacheBytes = 0;
    this.previewDisplayCache.clear();
    this.previewDisplayCacheBytes = 0;
    this.topologyWitnessStore.clear();
    if (this.historyKernel) {
      this.historyKernel.free();
      this.historyKernel = null;
    }
  }

  /**
   * What a drag preview can publish for a body without meshing it: its last
   * complete measurement, else the display a previous preview projected,
   * when the body is the same entity it was then. That means the same solid
   * handles (handles are never reused, see {@link MeasuredBodyCacheEntry}),
   * lineage and import diagnostics, and a recounted handle/validation
   * witness that matches. Any disagreement returns null and the preview
   * meshes the body as before. The result shares the cached buffers: the
   * preview's final `structuredClone` detaches everything it publishes, so
   * callers never alias the cache.
   */
  private reusedPreviewDisplay(
    kernel: RemusKernel,
    bodyId: BodyId,
    shape: ExactShape,
    strict: boolean,
    imported: ImportedStepDiagnostics | undefined,
    /** A drag frame, which may show a cached drag-quality mesh. */
    allowCoarse: boolean
  ): PreviewDisplay | null {
    const solidKey = shape.solids.join(',');
    const provenanceKey = measurementProvenanceKey(shape, imported);
    const keyed = (entry: {
      strict: boolean;
      solidKey: string;
      provenanceKey: string;
    }) =>
      entry.strict === strict &&
      entry.solidKey === solidKey &&
      entry.provenanceKey === provenanceKey;
    const complete = this.measuredShapeCache.get(bodyId);
    const completeKeyed =
      complete !== undefined &&
      complete.analysisKey === undefined &&
      keyed(complete);
    const cached = this.previewDisplayCache.get(bodyId);
    const previewed =
      cached && (allowCoarse || cached.coarse !== true) ? cached : undefined;
    if (!completeKeyed && !(previewed && keyed(previewed))) return null;
    let witness: string;
    try {
      witness = JSON.stringify(measurementWitness(kernel, shape, strict));
    } catch {
      return null;
    }
    if (completeKeyed && witness === JSON.stringify(complete.witness)) {
      const measured = complete.measured;
      return {
        vertices: measured.vertices,
        indices: measured.indices,
        bbox: measured.bbox,
        faceCount: measured.faceCount,
        faces: measured.topology.faces.map((face) => ({
          topologyId: face.topologyId,
          hash: face.hash,
          triangleStart: face.triangleStart,
          triangleCount: face.triangleCount,
          geometry:
            face.geometry?.surfaceType === 'bspline' ? undefined : face.geometry
        }))
      };
    }
    if (
      previewed &&
      keyed(previewed) &&
      witness === JSON.stringify(previewed.witness)
    ) {
      return previewed.display;
    }
    return null;
  }

  /**
   * Keeps a preview's display projection of a body for later previews. The
   * witness is the one a matching body recounts: the gate above admitted the
   * body only with zero relaxed (and, when strict, strict) errors, so a body
   * whose live verdict differs simply misses.
   */
  private storePreviewDisplay(
    kernel: RemusKernel,
    bodyId: BodyId,
    shape: ExactShape,
    strict: boolean,
    imported: ImportedStepDiagnostics | undefined,
    display: PreviewDisplay,
    coarse: boolean
  ): void {
    this.evictPreviewDisplay(bodyId);
    const handles = (values: Uint32Array) =>
      Array.from(values).sort((a, b) => a - b);
    let witness: MeasurementWitness;
    try {
      witness = {
        solids: shape.solids.map((solid) => ({
          solid,
          faces: handles(kernel.getSolidFaces(solid)),
          edges: handles(kernel.getSolidEdges(solid)),
          vertices: handles(kernel.getSolidVertices(solid)),
          relaxedErrors: 0,
          strictErrors: strict ? 0 : null
        }))
      };
    } catch {
      return;
    }
    const solidKey = shape.solids.join(',');
    const provenanceKey = measurementProvenanceKey(shape, imported);
    const bytes =
      display.vertices.byteLength +
      display.indices.byteLength +
      new TextEncoder().encode(
        JSON.stringify(display.faces) +
          JSON.stringify(witness) +
          provenanceKey +
          solidKey
      ).byteLength;
    if (bytes > this.maxMeasuredShapeCacheBytes) return;
    this.previewDisplayCache.set(bodyId, {
      provenanceKey,
      witness,
      solidKey,
      strict,
      bytes,
      display,
      ...(coarse ? { coarse: true } : {})
    });
    this.previewDisplayCacheBytes += bytes;
    for (const [key, existing] of this.previewDisplayCache) {
      if (this.previewDisplayCacheBytes <= this.maxMeasuredShapeCacheBytes) {
        break;
      }
      if (key === bodyId) continue;
      this.previewDisplayCache.delete(key);
      this.previewDisplayCacheBytes -= existing.bytes;
    }
  }

  private evictPreviewDisplay(bodyId: BodyId): void {
    const entry = this.previewDisplayCache.get(bodyId);
    if (entry) {
      this.previewDisplayCache.delete(bodyId);
      this.previewDisplayCacheBytes -= entry.bytes;
    }
  }

  private evictMeasuredShape(bodyId: BodyId): void {
    const entry = this.measuredShapeCache.get(bodyId);
    if (entry) {
      this.measuredShapeCache.delete(bodyId);
      this.measuredShapeCacheBytes -= entry.bytes;
    }
  }

  private storeMeasuredShape(
    bodyId: BodyId,
    entry: MeasuredBodyCacheEntry
  ): void {
    this.evictMeasuredShape(bodyId);
    // A complete measurement supersedes any preview display of the body.
    this.evictPreviewDisplay(bodyId);
    if (
      entry.bytes > this.maxMeasuredShapeCacheBytes ||
      !entry.measured.valid ||
      (entry.strict &&
        (!entry.measured.strictValid ||
          entry.measured.meshClosure === null ||
          !isClosedConsistentlyOrientedMesh(entry.measured.meshClosure)))
    ) {
      return;
    }
    // Derived states are caller-owned and may be mutated or transferred.
    // Retention must never alias their mesh buffers or topology/provenance.
    this.measuredShapeCache.set(bodyId, {
      ...entry,
      measured: structuredClone(entry.measured)
    });
    this.measuredShapeCacheBytes += entry.bytes;
    for (const [key, existing] of this.measuredShapeCache) {
      if (this.measuredShapeCacheBytes <= this.maxMeasuredShapeCacheBytes) {
        break;
      }
      if (key === bodyId) {
        continue;
      }
      this.measuredShapeCache.delete(key);
      this.measuredShapeCacheBytes -= existing.bytes;
    }
  }

  /**
   * Restores the longest cached prefix whose digests still match and replays
   * only the remaining features; falls back to a from-scratch build when the
   * scope or project changed, no prefix matches, caching is disabled, or a
   * kernel restore fails. Audited mixed suffixes retain matching primitive
   * handles while dependent builders replay against this run's operands.
   */
  private async buildWithHistoryCache(
    document: ProjectDocument,
    importSources: ReadonlyMap<string, Uint8Array>,
    pinnedImports: ReadonlySet<string>,
    onProgress?: RebuildProgressListener,
    onProjection?: (derived: DerivedState) => void,
    lineageDemand?: readonly BodyId[] | ReadonlySet<BodyId>,
    cancellation?: BuildCancellationSignal,
    yieldControl?: () => Promise<void> | void,
    deferTerminalFaceLineage = false,
    displayOnlyBlends = false,
    /**
     * An edit's preview or validation, which may propose carrying a
     * hash-only edge selection. Its hash-only modifiers' digests are salted,
     * so no checkpoint a carry built is ever restored by a plain build and
     * no plain refusal is restored by a carry build.
     */
    proposeCarry = false
  ): Promise<{
    kernel: RemusKernel;
    build: ExactBuildResult;
    replayed: number;
    restored: number;
    reusedPrimitives: number;
    reusedPreparedFeatures: number;
    reusedAxialFeatures: number;
    /** Strict verdicts the union gate established, keyed by kernel handle. */
    strictVerdicts: StrictUnionVerdicts;
    /** The replay's kernel reads, for the measurement pass of this sync. */
    readMemo: SyncReadMemo;
    recycleReason?: 'replay-budget';
    cacheResetReason?: 'checkpoint-ownership' | 'checkpoint-restore';
    /** A feature this sync rebuilt waited on a font or source; see below. */
    transient: boolean;
    /**
     * The persisted session this build restored instead of replaying; the
     * sync must match its projection before publishing anything.
     */
    seededSession?: PersistedHistorySession;
  }> {
    cancellation = this.historySignal(cancellation);
    throwIfBuildCancelled(cancellation);
    this.clearCurrentMassSnapshot();
    const offered = this.offeredSession;
    this.offeredSession = null;
    this.lastBuildRecord = null;
    if (this.unvalidatedSeed) this.invalidateHistoryCache();
    const features = listFeaturesInOrder(document);
    const terminal = features.at(-1);
    const deferredDirectEditFeatureId =
      deferTerminalFaceLineage &&
      terminal?.data.featureKind === 'direct-edit' &&
      ['offset-face', 'resize-blend', 'resize-cylindrical-face'].includes(
        terminal.data.operation.kind
      )
        ? terminal.featureId
        : undefined;
    // A drag preview builds display-only from the edit it drags on. A
    // feature before that edit which the preview has to replay (its source
    // was not checkpointed) is built checked, so its checkpoint is one the
    // release's checked sync restores, together with the edit the preview
    // prepared on it, instead of replaying that prefix and the edit afresh.
    const displayOnlyFrom = !displayOnlyBlends
      ? features.length
      : deferredDirectEditFeatureId
        ? features.length - 1
        : 0;
    const displayOnlyAt = (index: number) => index >= displayOnlyFrom;
    // Only a drag preview keeps a prepared face move; any other sync ends it.
    if (!deferredDirectEditFeatureId && this.historyKernel) {
      releasePreparedFaceMove(this.historyKernel);
    }

    // The first feature whose failure would describe this device's moment
    // rather than the document. Nothing at or after it is checkpointed, so
    // the next sync rebuilds it once the font face or source bytes arrive.
    const hasText = Object.values(document.nodes).some(
      (node) => node.kind === 'sketch-object' && node.data.objectKind === 'text'
    );
    const transientFrom = features.findIndex(
      (feature) =>
        !isFeatureSuppressed(feature) &&
        featureAwaitsEnvironment(
          document,
          feature,
          this.unresolvedSources,
          hasText
        )
    );
    const recycled =
      this.historyKernel !== null &&
      this.historyReplayWork >= MAX_HISTORY_REPLAY_WORK;
    if (recycled) this.invalidateHistoryCache();
    // An offset's checked source must survive Apply too. Replacing its sparse
    // checkpoint with the result makes the next preview replay unchanged
    // blends display-only, then replay them checked again on release.
    const terminalOffset =
      terminal?.data.featureKind === 'direct-edit' &&
      ['offset-face', 'resize-blend', 'resize-cylindrical-face'].includes(
        terminal.data.operation.kind
      );
    const sourceCheckpointIndices = tailCheckpointIndices(
      historyCheckpointIndices(features.length, this.maxHistoryCheckpoints),
      features.length - (terminalOffset ? 2 : 1),
      this.maxHistoryCheckpoints
    );
    // The tail the byte budget protects: the source, never the result.
    const sourceTail = sourceCheckpointIndices.at(-1);
    // A checked build of the edit also keeps its result, so neither the
    // next drag's first frame nor the follow-up sync replays it. A display
    // build's result is never restored by a checked one, so it is skipped.
    const checkpointIndices =
      terminalOffset && !displayOnlyBlends && !deferredDirectEditFeatureId
        ? withTerminalResultCheckpoint(
            sourceCheckpointIndices,
            features.length - 1,
            this.maxHistoryCheckpoints
          )
        : sourceCheckpointIndices;
    const checkpointIndexSet = new Set(checkpointIndices);
    const cachingEnabled = checkpointIndices.length > 0;
    const scopeKey = cachingEnabled ? historyScopeDigest(document) : null;
    const scope = cachingEnabled
      ? getParameterScope(document).scope
      : undefined;
    const normalizedDemand =
      lineageDemand === undefined
        ? undefined
        : lineageDemand instanceof Set
          ? lineageDemand
          : new Set(lineageDemand);
    const salted = (bases: readonly string[], carry: boolean) =>
      bases.map(
        (base, index) =>
          base +
          (features[index]!.featureId === deferredDirectEditFeatureId
            ? '|display-output'
            : '') +
          carryProposalSalt(features[index]!, carry) +
          displayOnlyBlendSalt(features[index]!, displayOnlyAt(index))
      );
    const demandBases = cachingEnabled
      ? features.map((feature, index) =>
          historyFeatureDigest(
            document,
            feature,
            index,
            scope,
            normalizedDemand
          )
        )
      : [];
    const digests = salted(demandBases, proposeCarry);
    // What a plain build of this document stores. A carry-proposing build
    // may restore a checkpoint under these only when it is `carryNeutral`
    // (no hash-only pick missed up to it), and stores under them while it
    // has not missed one either: until then both builds ran the same calls.
    const plainDigests = proposeCarry ? salted(demandBases, false) : digests;
    // A display-only build salts its blending features' digests so that a
    // checked build never restores what it stores, but it may restore what a
    // checked build stored: checked geometry is good for display too.
    const unsaltDisplayOnly = (spellings: readonly string[]) =>
      displayOnlyBlends
        ? spellings.map((digest, index) => {
            const salt = displayOnlyBlendSalt(
              features[index]!,
              displayOnlyAt(index)
            );
            return salt ? digest.slice(0, -salt.length) : digest;
          })
        : [...spellings];
    const checkedDigests = unsaltDisplayOnly(digests);
    const plainCheckedDigests = proposeCarry
      ? unsaltDisplayOnly(plainDigests)
      : checkedDigests;
    // A request that may skip a boolean's probe can still restore a
    // checkpoint where the probe ran: it adds lineage to the same geometry.
    // Previews and exports pass no demand, so without this every switch back
    // to the idle sync replayed everything after the first boolean.
    const probedDigests = normalizedDemand
      ? features.map((feature, index) =>
          cachingEnabled && isBooleanEvolutionProbeEligible(feature)
            ? historyFeatureDigest(document, feature, index, scope)
            : undefined
        )
      : [];
    const idleBases =
      normalizedDemand?.size === 0
        ? demandBases
        : cachingEnabled
          ? features.map((feature, index) =>
              historyFeatureDigest(document, feature, index, scope, [])
            )
          : [];
    const idleDigests = salted(idleBases, proposeCarry);
    const plainIdleDigests = proposeCarry
      ? salted(idleBases, false)
      : idleDigests;
    // One stored digest against this request's spellings. A carry-neutral
    // entry was stored under plain digests, which a carry build accepts too.
    const digestMatches = (
      digest: string,
      index: number,
      carryNeutral: boolean
    ) =>
      digest === digests[index] ||
      digest === probedDigests[index] ||
      digest === checkedDigests[index] ||
      (carryNeutral &&
        (digest === plainDigests[index] ||
          digest === plainCheckedDigests[index]));
    // Whether a hash-only pick has failed to resolve as stored in this build
    // or the prefix it restores. From then on a carry build's state may
    // differ from a plain build's, so its checkpoints keep the salt.
    let unresolvedEdgeHash = false;
    const probePrefix: [string, boolean][] = [];
    const probeKeys = cachingEnabled
      ? features.map((feature) => {
          if (isBooleanEvolutionProbeEligible(feature))
            probePrefix.push([
              feature.featureId,
              normalizedDemand === undefined ||
                booleanEvolutionProbeNeeded(document, feature, normalizedDemand)
            ]);
          return JSON.stringify(probePrefix);
        })
      : [];

    let kernel = this.historyKernel;
    let startIndex = 0;
    let initial: ExactBuildResult | null = null;
    let initialAxialExtent: AxialExtentCertificate | undefined;
    let initialIdleLineageView: IdleLineageView | undefined;
    let initialLineageIsIdle = false;
    let reusePrimitiveTail = false;
    let reusedPrimitives = 0;
    let reusedPreparedFeatures = 0;
    let reusedAxialFeatures = 0;
    let cacheResetReason:
      'checkpoint-ownership' | 'checkpoint-restore' | undefined;
    this.primitiveBuildCache.prune(features);

    // Counts alone cannot prove ownership. Retain the exact association of
    // each opaque handle with its adapter-created entry in this kernel's
    // lifetime; actual restore/discard still verifies kernel membership.
    if (kernel) {
      try {
        if (
          kernel.checkpointCount() !== this.historyCheckpoints.length ||
          this.historyCheckpointOwners.size !==
            this.historyCheckpoints.length ||
          new Set(this.historyCheckpoints.map((entry) => entry.checkpointId))
            .size !== this.historyCheckpoints.length ||
          this.historyCheckpoints.some(
            (entry) =>
              !isCheckpointHandle(entry.checkpointId) ||
              this.historyCheckpointOwners.get(entry.checkpointId) !== entry
          )
        ) {
          throw new HistoryCacheIntegrityError(
            'History checkpoint ownership disagrees.'
          );
        }
      } catch {
        cacheResetReason = 'checkpoint-ownership';
        this.invalidateHistoryCache();
        kernel = null;
      }
    }

    // A reopened project's persisted session (`exact-session-snapshot.ts`),
    // seeded as one checkpoint at the last feature, and only when everything
    // the prefix loop below checks already agrees: that loop then restores
    // it and replays nothing. Anything else, including any refusal of the
    // bytes, leaves the ordinary replay.
    let seeded: PersistedHistorySession | undefined;
    if (
      offered &&
      cachingEnabled &&
      transientFrom < 0 &&
      (!kernel || this.historyProjectId !== document.projectId) &&
      offered.projectId === document.projectId &&
      offered.scopeKey === scopeKey &&
      offered.digests.length === features.length &&
      offered.lineageProbeKey === probeKeys[features.length - 1] &&
      offered.digests.every((digest, index) =>
        digestMatches(digest, index, offered.carryNeutral)
      )
    ) {
      let restored: RemusKernel | null = null;
      try {
        restored = restoreKernelSnapshot(offered);
        const checkpointId = restored.checkpoint();
        if (
          !isCheckpointHandle(checkpointId) ||
          restored.checkpointCount() !== 1
        )
          throw new HistoryCacheIntegrityError(
            'Session checkpoint allocation disagrees.'
          );
        this.invalidateHistoryCache();
        const entry: HistoryCheckpointEntry = {
          featureIndex: features.length - 1,
          digests: [...offered.digests],
          checkpointId,
          snapshot: offered.build,
          ...(offered.carryNeutral ? { carryNeutral: true } : {}),
          lineageProbeKey: offered.lineageProbeKey,
          lineageMetadataBytes: new TextEncoder().encode(
            offered.lineageProbeKey
          ).byteLength
        };
        this.historyKernel = restored;
        this.historyCheckpoints = [entry];
        this.historyCheckpointOwners.set(checkpointId, entry);
        this.historyScopeKey = scopeKey;
        this.historyProjectId = document.projectId;
        // The restored arena still holds what the captured kernel's replays
        // retired: its budget continues where that kernel's stopped.
        this.historyReplayWork = offered.replayWork;
        kernel = restored;
        restored = null;
        seeded = offered;
        this.unvalidatedSeed = true;
      } catch {
        restored?.free();
      }
    }

    // A changed literal box width can reuse a checked prefix only through
    // its common clear prism. No other changed feature is skipped. Native
    // moves, complete construction maps and the normal measurement pass still
    // establish every result. Any missing proof restores ordinary replay.
    if (
      kernel &&
      cachingEnabled &&
      this.historyProjectId === document.projectId &&
      this.historyScopeKey === scopeKey
    ) {
      const entry = this.historyCheckpoints.at(-1);
      const certificate = entry?.axialExtent;
      const root = features[0];
      const width =
        root?.data.featureKind === 'primitive'
          ? root.data.dimensions.width
          : undefined;
      const oldDigests = this.historyCheckpoints.flatMap(
        (checkpoint) => checkpoint.digests
      );
      if (
        entry &&
        entry.featureIndex + 1 >= MIN_AXIAL_HISTORY_FEATURES &&
        (!deferredDirectEditFeatureId ||
          features.findIndex(
            (feature) => feature.featureId === deferredDirectEditFeatureId
          ) > entry.featureIndex) &&
        certificate &&
        root &&
        typeof width === 'number' &&
        width !== certificate.width &&
        axialRootKey(document, root) === certificate.rootKey &&
        entry.lineageProbeKey === probeKeys[entry.featureIndex] &&
        oldDigests.length === entry.featureIndex + 1 &&
        oldDigests.slice(1).every((digest, offset) => {
          const index = offset + 1;
          return (
            digest === digests[index] ||
            digest === probedDigests[index] ||
            digest === checkedDigests[index]
          );
        })
      ) {
        try {
          kernel.restore(entry.checkpointId);
          throwIfBuildCancelled(cancellation);
          // Failed/cancelled attempts allocate too; conservatively charge
          // every possible source move before entering the native calls.
          this.historyReplayWork += certificate.influenced.length;
          const axialReads = new SyncReadMemo(
            kernel,
            this.topologyWitnessStore
          );
          const sourceKernel = kernel;
          const updated = withSyncReadMemo(axialReads, () =>
            resizeAxialPrefix(
              sourceKernel,
              entry.snapshot,
              certificate,
              width,
              entry.idleLineageView?.state
            )
          );
          throwIfBuildCancelled(cancellation);
          if (!updated) throw new Error('The axial prefix was not qualified.');
          const probeKey = probeKeys[entry.featureIndex]!;
          const probeBytes = new TextEncoder().encode(probeKey).byteLength;
          const certificateBytes = axialCertificateBytes(updated.certificate);
          // The source and all native transports are checked even when a
          // resting display preview requested this update. Its deferred tail
          // is outside this prefix, so retain checked digests for release.
          const viewDigests = idleDigests
            .slice(0, entry.featureIndex + 1)
            .map((digest, index) => {
              const salt = displayOnlyBlendSalt(
                features[index]!,
                displayOnlyAt(index)
              );
              return salt ? digest.slice(0, -salt.length) : digest;
            });
          const viewBytes = updated.idle
            ? idleLineageViewBytes(updated.idle, viewDigests)
            : 0;
          const memory = checkpointMemoryStats(kernel);
          const budget =
            this.options.historyCheckpointEstimatedBytes ??
            MAX_HISTORY_CHECKPOINT_ESTIMATED_BYTES;
          if (
            !memory ||
            memory.nextMutationEstimatedBytes +
              probeBytes +
              certificateBytes +
              viewBytes >
              budget
          )
            throw new Error('The axial prefix exceeds checkpoint retention.');
          kernel.discardCheckpoint(this.historyCheckpoints[0]!.checkpointId);
          this.historyCheckpoints = [];
          this.historyCheckpointOwners.clear();
          const checkpointId = kernel.checkpoint();
          if (
            !isCheckpointHandle(checkpointId) ||
            kernel.checkpointCount() !== 1
          )
            throw new HistoryCacheIntegrityError(
              'Axial checkpoint allocation disagrees.'
            );
          const replacement: HistoryCheckpointEntry = {
            featureIndex: entry.featureIndex,
            checkpointId,
            digests: checkedDigests.slice(0, entry.featureIndex + 1),
            snapshot: updated.snapshot,
            lineageProbeKey: probeKey,
            lineageMetadataBytes: probeBytes + certificateBytes + viewBytes,
            axialExtent: updated.certificate,
            ...(updated.idle
              ? {
                  idleLineageView: {
                    digests: viewDigests,
                    state: updated.idle,
                    estimatedBytes: viewBytes
                  }
                }
              : {})
          };
          this.historyCheckpoints.push(replacement);
          this.historyCheckpointOwners.set(checkpointId, replacement);
          this.primitiveBuildCache.clear();
          reusedAxialFeatures = entry.featureIndex + 1;
        } catch (error) {
          try {
            kernel.restore(entry.checkpointId);
          } catch {
            this.invalidateHistoryCache();
            kernel = null;
          }
          if (isBuildCancelled(error)) throw error;
        }
      }
    }

    if (
      kernel &&
      cachingEnabled &&
      this.historyProjectId === document.projectId &&
      this.historyScopeKey !== null &&
      this.historyScopeKey === scopeKey
    ) {
      let prefix = -1;
      let prefixUsesIdleView = false;
      let unavailableModeView = false;
      // Inspect the whole retained history, including entries beyond an
      // unrelated geometry edit. Missing provenance is an unknown mode.
      const lineageModeChanged = this.historyCheckpoints.some(
        (entry) =>
          entry.lineageProbeKey === undefined ||
          entry.lineageProbeKey !== probeKeys[entry.featureIndex]
      );
      // A previous sync's tail that this one no longer schedules. It is the
      // last retained checkpoint; it is restored and then discarded, so the
      // checkpoints this replay takes stay aligned with the schedule.
      let staleTail = false;
      for (let index = 0; index < this.historyCheckpoints.length; index += 1) {
        const entry = this.historyCheckpoints[index]!;
        const from =
          index === 0
            ? 0
            : this.historyCheckpoints[index - 1]!.featureIndex + 1;
        const carryNeutral = entry.carryNeutral === true;
        if (
          entry.digests.length !== entry.featureIndex - from + 1 ||
          entry.digests.some(
            (digest, offset) =>
              !digestMatches(digest, from + offset, carryNeutral)
          )
        ) {
          break;
        }
        // Older entries in the table may carry eager digests even when a
        // later snapshot was assembled from their idle views. Name the JS
        // snapshot's own full probe signature, not its ancestors' modes.
        const primaryMatches =
          entry.lineageProbeKey !== undefined
            ? entry.lineageProbeKey === probeKeys[entry.featureIndex]
            : this.historyCheckpoints
                .slice(0, index + 1)
                .flatMap((prior) => prior.digests)
                .every(
                  (digest, featureIndex) =>
                    digest === digests[featureIndex] ||
                    (carryNeutral && digest === plainDigests[featureIndex])
                );
        const needsIdleView = !primaryMatches;
        if (needsIdleView) {
          const view = entry.idleLineageView;
          // Geometry-compatible eager snapshots cannot publish their eager
          // metadata to an idle request. Select only a finalized view whose
          // complete effective probe signature matches this request.
          if (
            !view ||
            view.digests.length !== entry.featureIndex + 1 ||
            view.digests.some(
              (digest, index) =>
                digest !== digests[index] &&
                !(carryNeutral && digest === plainDigests[index])
            )
          ) {
            unavailableModeView = true;
            break;
          }
        }
        if (!checkpointIndexSet.has(entry.featureIndex)) {
          if (index === this.historyCheckpoints.length - 1) {
            prefix = index;
            prefixUsesIdleView = needsIdleView;
            staleTail = true;
          }
          break;
        }
        prefix = index;
        prefixUsesIdleView = needsIdleView;
      }
      // An unaudited suffix must run in a genuinely fresh arena after a
      // mode change. Retaining eager probe scratch topology can otherwise
      // influence that suffix's serialized construction metadata.
      const forceFreshLineageReplay =
        lineageModeChanged &&
        (unavailableModeView ||
          features
            .slice(
              prefix < 0 ? 0 : this.historyCheckpoints[prefix]!.featureIndex + 1
            )
            .some((feature) => !supportsIdleLineageView(feature, document)));
      if (forceFreshLineageReplay) {
        prefix = -1;
        prefixUsesIdleView = false;
        staleTail = false;
      }
      const restoredFeatures =
        prefix >= 0 ? this.historyCheckpoints[prefix]!.featureIndex + 1 : 0;
      reusePrimitiveTail =
        !forceFreshLineageReplay &&
        this.primitiveBuildCache.canReuseTail(
          features,
          digests,
          restoredFeatures
        );
      if (prefix >= 0 || reusePrimitiveTail) {
        try {
          const restoredEntry =
            prefix >= 0 ? this.historyCheckpoints[prefix]! : undefined;
          // Checkpoints from here on are dropped; a stale tail drops itself.
          const kept = staleTail ? prefix : prefix + 1;
          if (reusePrimitiveTail) {
            // Preserve independent tail handles. Dropping checkpoints frees
            // snapshots without rolling the current topology back.
            if (this.historyCheckpoints.length > kept) {
              kernel.discardCheckpoint(
                this.historyCheckpoints[kept]!.checkpointId
              );
            }
          } else {
            kernel.restore(restoredEntry!.checkpointId);
            if (staleTail)
              kernel.discardCheckpoint(restoredEntry!.checkpointId);
            this.primitiveBuildCache.restoredThrough(restoredFeatures - 1);
          }
          for (const entry of this.historyCheckpoints.slice(kept)) {
            this.historyCheckpointOwners.delete(entry.checkpointId);
          }
          this.historyCheckpoints = this.historyCheckpoints.slice(0, kept);
          if (kernel.checkpointCount() !== this.historyCheckpoints.length) {
            throw new HistoryCacheIntegrityError(
              'History restore did not truncate checkpoints.'
            );
          }
          startIndex = restoredFeatures;
          // Two copies deep: the snapshot must survive this replay's in-place
          // mutation, and the replay must not share containers with it.
          initial = restoredEntry
            ? cloneBuildState(restoredEntry.snapshot)
            : null;
          initialAxialExtent = restoredEntry?.axialExtent;
          // An entry not proven carry-neutral may hold a miss (a plain
          // refusal or a carry); everything built on it inherits that.
          unresolvedEdgeHash =
            restoredEntry !== undefined && restoredEntry.carryNeutral !== true;
          if (restoredEntry && initial) {
            const view = restoredEntry.idleLineageView;
            if (view) {
              initialIdleLineageView = cloneIdleLineageView(
                view.state,
                restoredEntry.snapshot,
                initial
              );
            }
            if (prefixUsesIdleView) {
              if (
                !initialIdleLineageView ||
                initialIdleLineageView.lineages.size !== initial.shapes.size
              )
                throw new HistoryCacheIntegrityError(
                  'Idle lineage view ownership disagrees.'
                );
              for (const [id, shape] of initial.shapes) {
                if (!initialIdleLineageView.lineages.has(id))
                  throw new HistoryCacheIntegrityError(
                    'Idle lineage view body is missing.'
                  );
                const lineage = initialIdleLineageView.lineages.get(id);
                if (lineage) shape.lineage = lineage;
                else delete shape.lineage;
              }
              initialIdleLineageView = currentIdleLineageView(initial);
            }
            initialLineageIsIdle = digests
              .slice(0, restoredFeatures)
              .every((digest, index) => digest === idleDigests[index]);
          }
          // Restore may succeed even when an entity was retired before the
          // checkpoint barrier. Never replay builders from stale JS handles.
          for (const shape of initial?.shapes.values() ?? []) {
            for (const solid of shape.solids) kernel.boundingBox(solid);
          }
        } catch {
          cacheResetReason = 'checkpoint-restore';
          this.invalidateHistoryCache();
          kernel = null;
          reusePrimitiveTail = false;
          startIndex = 0;
          initial = null;
          initialIdleLineageView = undefined;
          initialLineageIsIdle = false;
          initialAxialExtent = undefined;
          unresolvedEdgeHash = false;
        }
      } else {
        this.invalidateHistoryCache();
        kernel = null;
      }
    } else {
      this.invalidateHistoryCache();
      kernel = null;
    }

    // Restored in full, with nothing replayed on it, or not at all.
    const seededSession =
      seeded && kernel && startIndex === features.length ? seeded : undefined;
    if (!kernel) {
      kernel = new RemusKernel();
      this.historyKernel = kernel;
      this.historyScopeKey = scopeKey;
      this.historyProjectId = document.projectId;
    }
    const activeKernel = kernel;
    const axialExtent = new AxialExtentTracker(
      activeKernel,
      document,
      features,
      startIndex,
      initial,
      initialAxialExtent,
      cachingEnabled && !displayOnlyBlends && !deferredDirectEditFeatureId
    );

    const report = rebuildReporter(onProgress);
    let featureDone: (() => void) | undefined;
    let executedFeatures = 0;
    // The feature the next build step runs: each step builds one.
    let nextBuildIndex = startIndex;
    const onFeatureStart = (index: number) => {
      executedFeatures += 1;
      featureDone = report(
        'feature',
        features[index]!.name,
        index + 1,
        features.length
      );
    };
    const onFeature = (
      index: number,
      result: ExactBuildResult,
      idleView?: IdleLineageView
    ) => {
      featureDone?.();
      nextBuildIndex = index + 1;
      if (index <= checkpointIndices.at(-1)!)
        axialExtent.observe(index, result);
      // Publish only a disposable mesh projection before an expensive pattern.
      // It is never cached as an exact result, nor used by export/validation.
      const nextFeature = features[index + 1];
      if (
        onProjection &&
        result.shapes.size <= 16 &&
        nextFeature?.data.featureKind === 'pattern' &&
        !isFeatureSuppressed(nextFeature)
      ) {
        const bodyRepresentations: DerivedState['bodyRepresentations'] = {};
        let remainingBytes = 32 * 1024 * 1024;
        for (const body of listNodesByKind(document, 'body')) {
          const shape = result.shapes.get(body.bodyId);
          if (!shape) continue;
          try {
            const projection = projectShapeMesh(
              activeKernel,
              shape,
              remainingBytes
            );
            remainingBytes -=
              projection.mesh.vertices.byteLength +
              projection.mesh.indices.byteLength;
            bodyRepresentations[body.bodyId] = {
              bodyId: body.bodyId,
              name: body.name,
              source: 'boolean',
              // A disposable projection: with no feature kind only a chosen
              // colour shows, and the full build that follows decides.
              color: bodyDisplayColor(body.metadata),
              consumed: result.consumed.has(body.bodyId),
              exportableStep: false,
              faceCount: 0,
              volume: 0,
              ...projection
            };
          } catch {
            /* Missing projection pieces make the preview fail closed. */
          }
        }
        try {
          onProjection({
            bodyRepresentations,
            exportableBodyIds: [],
            warnings: [...result.warnings],
            featureWarnings: [...result.featureWarnings],
            updatedAt: nowIso()
          });
        } catch {
          /* Display observers cannot change exact acceptance. */
        }
      }
      if (
        !checkpointIndexSet.has(index) ||
        (transientFrom >= 0 && index >= transientFrom)
      )
        return;
      // Qualified axial reuse resizes from the last checkpoint and expects
      // it to be the edit's source; a result checkpoint after a certified
      // source would turn that reuse off, so such a history keeps only the
      // source, as before.
      if (
        index !== sourceTail &&
        index > (sourceTail ?? -1) &&
        this.historyCheckpoints.at(-1)?.axialExtent !== undefined
      )
        return;
      // A checkpoint is cheap to create but makes the next mutation copy the
      // arena. Admit against that projected cost, including retired slots.
      let memory = checkpointMemoryStats(activeKernel);
      let retainedLineageBytes = this.historyLineageMetadataBytes;
      const probeKey = probeKeys[index]!;
      const axialCertificate = axialExtent.snapshot();
      const axialBytes = axialCertificate
        ? axialCertificateBytes(axialCertificate)
        : 0;
      const probeKeyBytes = memory
        ? new TextEncoder().encode(probeKey).byteLength + axialBytes
        : 0;
      const byteBudget =
        this.options.historyCheckpointEstimatedBytes ??
        MAX_HISTORY_CHECKPOINT_ESTIMATED_BYTES;
      // Prefer the checked tail/source to earlier prefixes when the existing
      // byte ceiling cannot hold both. Discarding checkpoints does not restore
      // topology or retire current handles. The tail records the whole digest
      // span and its own finalized lineage view, so the next sync can restore
      // it through the ordinary provenance/ownership checks.
      if (
        memory &&
        index === sourceTail &&
        this.historyCheckpoints.length > 0 &&
        memory.nextMutationEstimatedBytes +
          retainedLineageBytes +
          probeKeyBytes >
          byteBudget
      ) {
        activeKernel.discardCheckpoint(
          this.historyCheckpoints[0]!.checkpointId
        );
        this.historyCheckpoints = [];
        this.historyCheckpointOwners.clear();
        memory = checkpointMemoryStats(activeKernel);
        retainedLineageBytes = 0;
      }
      if (memory) {
        if (
          memory.nextMutationEstimatedBytes +
            retainedLineageBytes +
            probeKeyBytes >
          byteBudget
        )
          return;
      }
      const done = report(
        'checkpoint',
        features[index]!.name,
        index + 1,
        features.length
      );
      const checkpointId = activeKernel.checkpoint();
      if (
        !isCheckpointHandle(checkpointId) ||
        this.historyCheckpointOwners.has(checkpointId) ||
        activeKernel.checkpointCount() !== this.historyCheckpoints.length + 1
      ) {
        throw new HistoryCacheIntegrityError(
          'History checkpoint allocation disagrees.'
        );
      }
      const previous = this.historyCheckpoints.at(-1);
      // Until a hash-only pick misses, this build ran exactly what a plain
      // build of the document runs: store the plain spelling so either kind
      // of build restores it. After a miss a carry build keeps its salt.
      const carryNeutral = !unresolvedEdgeHash;
      const entry: HistoryCheckpointEntry = {
        featureIndex: index,
        digests: (carryNeutral ? plainDigests : digests).slice(
          (previous?.featureIndex ?? -1) + 1,
          index + 1
        ),
        checkpointId,
        snapshot: cloneBuildState(result),
        ...(carryNeutral ? { carryNeutral: true } : {}),
        ...(axialCertificate ? { axialExtent: axialCertificate } : {}),
        ...(memory
          ? { lineageProbeKey: probeKey, lineageMetadataBytes: probeKeyBytes }
          : {})
      };
      // Different probe signatures also need a finalized proof when an
      // unavailable probe left the metadata identical. Charge the complete
      // view/signature against the existing checkpoint byte ceiling;
      // unavailable telemetry or oversized views keep exact replay.
      if (
        idleView &&
        memory &&
        (idleView.diverged ||
          idleDigests
            .slice(0, index + 1)
            .some((digest, featureIndex) => digest !== digests[featureIndex]))
      ) {
        try {
          const viewDigests = (
            carryNeutral ? plainIdleDigests : idleDigests
          ).slice(0, index + 1);
          const bytes = idleLineageViewBytes(idleView, viewDigests);
          if (
            memory.nextMutationEstimatedBytes +
              retainedLineageBytes +
              probeKeyBytes +
              bytes <=
            byteBudget
          ) {
            entry.idleLineageView = {
              digests: viewDigests,
              state: cloneIdleLineageView(idleView, result, entry.snapshot),
              estimatedBytes: bytes
            };
            entry.lineageMetadataBytes = probeKeyBytes + bytes;
          }
        } catch {
          // Alternate metadata cannot change checkpoint or geometry acceptance.
        }
      }
      this.historyCheckpoints.push(entry);
      this.historyCheckpointOwners.set(checkpointId, entry);
      done();
    };

    let build: ExactBuildResult;
    // Strict verdicts the union gate established on the solids it produced,
    // keyed by kernel handle, for the measurement pass of the same sync.
    // Scoped to one sync: handles are never mutated in place after their
    // feature ran, and the map is dropped before the next sync builds
    // anything.
    const strictVerdicts: StrictUnionVerdicts =
      new UnionVerdictsWithMeshBudget();
    // Another project's bodies are a different set: start their held display
    // deflections fresh before the build (the union gate reads them).
    if (this.heldDisplayProjectId !== document.projectId) {
      this.heldDisplayDeflections.clear();
      this.previewFaceGeometry.clear();
      this.heldDisplayProjectId = document.projectId;
    }
    // Kernel reads the replay shares with the measurement pass of the same
    // sync: surface classes, edge-to-face maps and topology witnesses.
    const readMemo = new SyncReadMemo(activeKernel, this.topologyWitnessStore);
    const scheduling = new CooperativeWork(
      8,
      yieldControl
        ? async () => {
            await yieldControl();
          }
        : undefined
    );
    try {
      build = await buildDocumentHistoryCooperatively(
        {
          run: (work) =>
            withDisplayOnlyBlends(
              activeKernel,
              displayOnlyAt(nextBuildIndex),
              () => withSyncReadMemo(readMemo, work)
            ),
          checkpoint: () =>
            yieldControl
              ? Promise.resolve(yieldControl())
              : scheduling.checkpoint()
        },
        activeKernel,
        document,
        importSources,
        pinnedImports,
        initial
          ? {
              startIndex,
              initial,
              idleLineageView: initialIdleLineageView,
              idleLineageIsCurrent: initialLineageIsIdle
            }
          : undefined,
        this.importedSteps,
        onFeature,
        onFeatureStart,
        strictVerdicts,
        cachingEnabled
          ? {
              restore: (index, feature, result) => {
                const reused = this.primitiveBuildCache.restore(
                  feature,
                  digests[index]!,
                  result,
                  reusePrimitiveTail
                );
                if (reused) {
                  if (feature.data.featureKind === 'primitive')
                    reusedPrimitives += 1;
                  else reusedPreparedFeatures += 1;
                }
                return reused;
              },
              store: (index, feature, result) =>
                this.primitiveBuildCache.store(
                  index,
                  feature,
                  digests[index]!,
                  result
                )
            }
          : undefined,
        cancellation,
        normalizedDemand,
        (bodyId) => this.heldDisplayDeflections.get(bodyId)?.[0],
        deferredDirectEditFeatureId,
        cachingEnabled &&
          (this.options.historyCheckpointEstimatedBytes ??
            MAX_HISTORY_CHECKPOINT_ESTIMATED_BYTES) > 0,
        this.edgeSelections,
        proposeCarry,
        () => {
          unresolvedEdgeHash = true;
        }
      );
    } catch (error) {
      // A cancelled build keeps the retained prefix: the checkpoints pushed
      // before the throw are a consistent longer prefix for the next sync,
      // and the partial result is discarded with the throw. All callers
      // (including export and recognition) must abandon both halves of a
      // partially built cache if checkpointing or replay throws otherwise.
      if (isBuildCancelled(error)) {
        throw error;
      }
      this.invalidateHistoryCache();
      throw error;
    } finally {
      if (!deferTerminalFaceLineage) releasePreparedGroupEdit(activeKernel);
      // Cancelled jobs also allocated geometry. Charge completed replay work
      // before yielding ownership, otherwise an edit storm evades recycling.
      if (
        this.historyKernel === activeKernel &&
        (startIndex > 0 || reusePrimitiveTail)
      ) {
        this.historyReplayWork +=
          executedFeatures - reusedPrimitives - reusedPreparedFeatures;
      }
    }
    // What a persisted session of this state needs. Nothing this device's
    // moment decided (a font or source still to come), no drag or display
    // build, no edit's proposal: only a build any later replay reproduces.
    this.lastBuildRecord =
      cachingEnabled &&
      scopeKey !== null &&
      features.length > 0 &&
      transientFrom < 0 &&
      !displayOnlyBlends &&
      !deferredDirectEditFeatureId &&
      !proposeCarry
        ? {
            kernel: activeKernel,
            projectId: document.projectId,
            scopeKey,
            digests: [...plainDigests],
            lineageProbeKey: probeKeys.at(-1)!,
            carryNeutral: !unresolvedEdgeHash,
            demand: normalizedDemand,
            build
          }
        : null;
    // The cache event is emitted by syncDocument AFTER the measure pass, so
    // it can carry the measure-reuse counts alongside the replay counts.
    return {
      ...(seededSession ? { seededSession } : {}),
      kernel: activeKernel,
      build,
      replayed:
        features.length -
        startIndex -
        reusedPrimitives -
        reusedPreparedFeatures,
      restored: startIndex,
      reusedPrimitives,
      reusedPreparedFeatures,
      reusedAxialFeatures,
      ...(cacheResetReason ? { cacheResetReason } : {}),
      ...(recycled ? { recycleReason: 'replay-budget' as const } : {}),
      strictVerdicts,
      readMemo,
      transient: transientFrom >= startIndex
    };
  }

  /**
   * Reference-form import sources, fetched before the synchronous rebuild
   * walks the history. Keyed by checksum; a missing key at rebuild time means
   * the local blob store and every fallback failed, which each import case
   * reports per-feature rather than failing the whole document.
   *
   * A checksum already in {@link importedSteps} is skipped: its bytes
   * would only be parsed into a result the cache already holds, and reading
   * them is the single largest allocation a rebuild makes. That skip is only
   * sound because every checksum walked here is returned as `pinned` and
   * protected from eviction for the whole build — otherwise a later import in the
   * same document could evict the entry whose bytes were never read.
   */
  private async prefetchImportSources(
    document: ProjectDocument,
    cancellation?: BuildCancellationSignal
  ): Promise<{
    sources: Map<string, Uint8Array>;
    pinned: Set<string>;
  }> {
    const sources = new Map<string, Uint8Array>();
    const pinned = new Set<string>();
    const meshPayloads = new Map<string, Uint8Array>();
    this.unresolvedSources = new Set();
    for (const feature of listFeaturesInOrder(document)) {
      // STEP sources and mesh payloads: both rebuild from bytes held by
      // checksum outside the document. An import that also embeds its data
      // rebuilds from that and reads nothing.
      const ref = importedSourceReferenceOf(feature.data);
      const data = feature.data as {
        artifactId: ArtifactId;
        sourceName: string;
        stepText?: string;
        vertices?: number[];
      };
      if (
        !ref ||
        data.stepText !== undefined ||
        data.vertices !== undefined ||
        isFeatureSuppressed(feature) ||
        sources.has(ref.checksumSha256)
      ) {
        continue;
      }
      const mesh = feature.data.featureKind === 'imported-mesh';
      const kept = mesh ? this.meshPayloads.get(ref.checksumSha256) : undefined;
      if (kept) {
        sources.set(ref.checksumSha256, kept);
        meshPayloads.set(ref.checksumSha256, kept);
        continue;
      }
      if (!mesh) {
        pinned.add(ref.checksumSha256);
        if (this.importedSteps.lookup(ref.checksumSha256)) {
          continue;
        }
      }
      const resolveSourceBytes = this.options.resolveSourceBytes;
      if (!resolveSourceBytes) {
        continue;
      }
      const { artifactId, sourceName } = data;
      try {
        // Superseded builds release the transfer, while the next rebuild
        // can take it over without downloading the same payload again.
        const bytes = await raceBuildCancellation(
          (signal) =>
            resolveSourceBytes(ref, { artifactId, sourceName, signal }),
          cancellation
        );
        sources.set(ref.checksumSha256, bytes);
        if (mesh) meshPayloads.set(ref.checksumSha256, bytes);
      } catch (error) {
        if (isBuildCancelled(error)) throw error;
        // Each import case reports the miss with the feature's name.
        if (!(error as { permanent?: unknown } | null)?.permanent) {
          this.unresolvedSources.add(ref.checksumSha256);
        }
      }
    }
    this.meshPayloads = meshPayloads;
    return { sources, pinned };
  }

  private prepareShapeMeasurement(
    kernel: RemusKernel,
    shape: ExactShape,
    strictBooleanValidation = false,
    recognizeImportedFeatures = false,
    onStage?: (name: string) => () => void,
    analysisHashes?: readonly number[],
    /** One millimetre in document units, for the recognizer's margins. */
    millimetre = 1,
    /**
     * Strict verdicts the union gate established earlier in this sync, keyed
     * by handle; a hit replaces the strict `validateSolid` call.
     */
    strictVerdicts?: ReadonlyMap<number, StrictUnionVerdict>,
    /**
     * Whether the opening is measured, or published as unsupported without
     * running the recognizer; see the decision in `syncMeasuredDocument`.
     */
    measureOpening = recognizeImportedFeatures,
    /**
     * The linear display deflection each solid of this body was meshed at
     * last time, in solid order; held while the body's size stays close.
     */
    heldDisplayDeflections?: readonly number[],
    provePlanarPairs = true,
    /**
     * Mesh the faces at the drag tessellation (see
     * `exact-display-refinement.ts`). Validation, measurement, edges and
     * volume are unchanged; edges keep the full display deflection.
     */
    draftDisplay = false
  ): PreparedShapeMeasurement {
    if (shape.solids.length === 0) {
      throw new Error('Exact body contains no solids.');
    }
    // Per-solid mesh chunks, concatenated once at the end. Typed throughout:
    // the old number[] accumulation boxed every float and every index on its
    // way to a structured clone across the worker boundary.
    const vertexChunks: Float32Array[] = [];
    const indexChunks: Uint32Array[] = [];
    let vertexFloatCount = 0;
    let indexCount = 0;
    const lineageDiagnostics =
      shape.lineage?.diagnostics.map(projectRemusLineageDiagnostic) ?? [];
    const topology: BodyTopology = {
      faces: [],
      edges: [],
      ...(shape.nativeVertices ? { vertices: [] } : {})
    };
    const witness: MeasuredShape['witness'] = { solids: [] };
    const bbox = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity }
    };
    let volume = 0;
    const analysisJobs: (() => void)[] = [];
    let analysisRemaining = 0;
    let valid = true;
    let strictValid = true;
    // Vertex ids are numbered across the whole body while the handle map below
    // is rebuilt per solid, so two solids that touch exactly — a linear pattern
    // whose spacing equals its extent — never share an id.
    let nextVertexId = 0;
    const displayLinearDeflections: number[] = [];

    for (const solid of shape.solids) {
      const bounds = kernel.boundingBox(solid);
      // What the body publishes: the kernel's box, tightened to its display
      // mesh where that proves it loose (see exact-bounds.ts).
      let publishedBounds: readonly number[];
      // Hold the previous deflection while the body's size stays close: a
      // nudged bounding box must not re-mesh every face (the kernel reuses
      // per-face meshes only at the same deflection).
      const displayTessellation = solidDisplayTessellation(
        bounds,
        heldDisplayDeflections?.[displayLinearDeflections.length]
      );
      // The held value stays the full display quality a draft refines to.
      displayLinearDeflections.push(displayTessellation.linearDeflection);
      const meshTessellation = draftDisplay
        ? previewDisplayTessellation(displayTessellation)
        : displayTessellation;
      const faceHandles = Array.from(kernel.getSolidFaces(solid));
      const edgeToFaces = edgeToFaceMapOf(kernel, solid);
      // The edit that produced this solid usually measured its witnesses
      // already; inside the sync memo they are shared rather than measured
      // again, and kept for the next edit of this body.
      registerSolidWitnesses(kernel, solid);
      // Face handle -> ADR-011 hash, for translating the kernel's edge-to-face
      // map when the edge records are built below. Scoped to this solid:
      // `edgeToFaces` is per solid while `topology.faces` accumulates across
      // them, and face handles are only observed to be globally unique, not
      // contracted to be.
      const faceHashByHandle = new Map<number, number>();
      const faceTopologyByHandle = new Map<number, FaceTopology>();
      // Blend-region member handles per face, for the stable-key pass below.
      const blendRegionMembersByHandle = new Map<number, readonly number[]>();
      const recognitionIdentities = new Map<
        number,
        ImportedRecognitionFaceIdentity
      >();
      // Vertex handle -> body-scoped id, for the same reason and with the same
      // scoping: `getSolidVertices` is per solid, and vertex handles are only
      // observed to be globally unique, not contracted to be. Numbered from
      // the kernel's own vertex list rather than from the order edges happen
      // to name them, so the ids do not depend on the edge loop below.
      const vertexIdByHandle = new Map<number, number>();
      const vertexHandles = Array.from(kernel.getSolidVertices(solid));
      for (const vertex of vertexHandles) {
        if (!vertexIdByHandle.has(vertex)) {
          vertexIdByHandle.set(vertex, nextVertexId);
          nextVertexId += 1;
        }
      }
      // Native handles remain private. This projection uses the same existing
      // body/solid numbering the edge incidence records publish.
      if (topology.vertices) {
        const members = new Set(vertexHandles);
        for (const vertex of vertexHandles) {
          const actual = nativeVertexPoint(kernel, vertex);
          if (!actual) {
            // A partial point array must not pretend to cover native topology.
            delete topology.vertices;
            break;
          }
          const evidence = nativeVertexEvidence(
            kernel,
            shape.nativeVertices,
            solid,
            vertex,
            members
          );
          const reference =
            evidence?.status === 'qualified' ? evidence.reference : undefined;
          topology.vertices.push({
            id: vertexIdByHandle.get(vertex)!,
            point: actual.point,
            ...(reference
              ? {
                  reference: {
                    ...reference,
                    witness: { position: [...reference.witness.position] }
                  }
                }
              : {}),
            ...(!reference
              ? {
                  unavailableReason:
                    evidence?.status === 'unavailable'
                      ? evidence.reason
                      : (shape.nativeVertices?.withheldBySolid
                          .get(solid)
                          ?.get(vertex) ?? 'unsupported-source')
                }
              : {})
          });
        }
      }
      const meshDone = onStage?.('Display mesh and face topology');
      const mesh =
        takeUnionDisplayMeshForMeasurement(
          strictVerdicts?.get(solid),
          kernel,
          solid,
          meshTessellation.linearDeflection,
          meshTessellation.angularDeflection
        ) ??
        kernel.tessellateSolidGroupedBinary(
          solid,
          meshTessellation.linearDeflection,
          meshTessellation.angularDeflection
        );
      try {
        const faceOffsets = Array.from(ownedMeshFaceOffsets(mesh));
        const vertexOffset = vertexFloatCount / 3;
        const indexOffset = indexCount;
        // wasm-bindgen returns caller-owned arrays, independent of mesh.free().
        // Only nonzero body offsets require another index allocation.
        const positions = ownedMeshPositions(mesh);
        const meshIndices = ownedMeshIndices(mesh);
        const shifted =
          vertexOffset === 0
            ? meshIndices
            : new Uint32Array(meshIndices.length);
        if (vertexOffset !== 0) {
          for (let i = 0; i < meshIndices.length; i += 1)
            shifted[i] = meshIndices[i]! + vertexOffset;
        }
        vertexChunks.push(positions);
        vertexFloatCount += positions.length;
        indexChunks.push(shifted);
        indexCount += shifted.length;
        // Both the tessellation groups and getSolidFaces iterate the same
        // underlying shell, so face handle i owns triangle range i. Guarded
        // because the fingerprint hash below silently depends on it.
        if (faceHandles.length !== faceOffsets.length - 1) {
          throw new Error(
            `Face handle count ${faceHandles.length} does not match tessellation groups ${faceOffsets.length - 1}.`
          );
        }
        for (let index = 0; index < faceOffsets.length - 1; index += 1) {
          const start = faceOffsets[index]!;
          const end = faceOffsets[index + 1]!;
          const handle = faceHandles[index]!;
          const witness = faceWitnessOf(kernel, handle);
          const hash = topologyHashOfWitness('face', witness);
          const reference = shape.lineage?.faceReferences.get(handle);
          const verifiedReference =
            reference &&
            reference.currentHash === hash &&
            topologyWitnessesEqual('face', reference.witness, witness)
              ? reference
              : undefined;
          if (reference && !verifiedReference) {
            lineageDiagnostics.push({
              kind: 'face',
              status: 'unsupported',
              topologyId: reference.lineageName,
              featureId: reference.producingFeatureId,
              message: `Remus face lineage ${reference.lineageName} no longer matches its exact measured witness.`
            });
          }
          faceHashByHandle.set(handle, hash);
          recognitionIdentities.set(handle, {
            hash,
            ...(verifiedReference ? { reference: verifiedReference } : {})
          });
          const publishedFace: FaceTopology = {
            topologyId: `face:${hash}`,
            hash,
            reference: verifiedReference,
            triangleStart: (indexOffset + start) / 3,
            triangleCount: (end - start) / 3,
            geometry: measureOwnedFaceGeometry(
              kernel,
              solid,
              handle,
              (region) => blendRegionMembersByHandle.set(handle, region.faces)
            )
          };
          faceTopologyByHandle.set(handle, publishedFace);
          topology.faces.push(publishedFace);
        }
        publishedBounds = publishedSolidBounds(
          kernel,
          solid,
          bounds,
          { positions, indices: meshIndices, faceOffsets },
          faceHandles.map(
            (handle) =>
              faceTopologyByHandle.get(handle)?.geometry?.surfaceType ?? ''
          ),
          meshTessellation,
          !draftDisplay
        );
      } finally {
        mesh.free();
      }
      // Publish each blend region under its stable hash-derived key. Every
      // member is a face of this same solid and was measured by the loop
      // above; a member without a hash withdraws the editable-blend proof
      // rather than publishing an under-proved key (fail closed).
      for (const [handle, members] of blendRegionMembersByHandle) {
        const geometry = faceTopologyByHandle.get(handle)?.geometry;
        if (!geometry) {
          continue;
        }
        const hashes: number[] = [];
        for (const member of members) {
          const hash = faceHashByHandle.get(member);
          if (hash === undefined) {
            hashes.length = 0;
            break;
          }
          hashes.push(hash);
        }
        if (hashes.length !== members.length) {
          delete geometry.editableDimension;
          delete geometry.blendRegionFaceCount;
          continue;
        }
        geometry.blendRegionKey = blendRegionKeyOfHashes(hashes);
      }
      meshDone?.();
      analysisJobs.push(() => {
        const recognitionDone = onStage?.('Imported feature recognition');
        let claimedFaceHashes = new Set<number>();
        if (recognizeImportedFeatures) {
          if (analysisHashes && shape.solids.length === 1) {
            const emboss = recognizePlanarEmboss(kernel, solid);
            if (emboss) topology.recognizedPlanarEmboss = emboss;
          }
          const recognized = collectRecognizedImportedFeatures(
            kernel,
            solid,
            recognitionIdentities
          );
          if (recognized.length > 0) {
            topology.recognizedImportedFeatures ??= [];
            topology.recognizedImportedFeatures.push(...recognized);
            // A face is claimed only by a proof that backs a coordinated
            // direct-edit replay (the hole family today). Pocket, boss and
            // taper proofs — exact or kernel-recognized — publish knowledge
            // with no replay behind them, so they must not cost those faces
            // the planar-distance proof they would otherwise carry. Revisit
            // this filter when a pocket/boss/taper edit command lands.
            claimedFaceHashes = new Set(
              recognized
                .filter(
                  (feature) =>
                    !isReadOnlyRecognizedImportedFeature(feature) &&
                    (feature.kind === 'blind-cylindrical-hole' ||
                      feature.kind === 'counterbore' ||
                      feature.kind === 'countersink')
                )
                .flatMap((feature) => feature.participatingFaceHashes)
            );
          }
          recognitionDone?.();
          // The opening measurement is one bounded pass over the inventory plus
          // one exact slab intersection; a refusal is published with its reason
          // so the assistant can say why the body cannot be grown. Only a live
          // imported body can be offered for growing, so the consumed source
          // references a holder carves its pieces from are not measured: on the
          // hammer that was four recognitions per rebuild, most of its latency.
          if (
            recognizeImportedFeatures &&
            shape.solids.length === 1 &&
            !measureOpening
          ) {
            topology.recognizedOpening = {
              status: 'unsupported',
              reason: OPENING_NEEDS_RIGID_IMPORT
            };
          } else if (recognizeImportedFeatures && shape.solids.length === 1) {
            const openingDone = onStage?.('Opening recognition');
            try {
              topology.recognizedOpening = recognizeOpening(kernel, solid, {
                millimetre
              });
            } catch (error) {
              topology.recognizedOpening = {
                status: 'unsupported',
                reason: `Opening recognition failed: ${(error as Error).message}`
              };
            }
            openingDone?.();
          }
          const pairsDone = onStage?.('Planar distance edit proofs');
          // Replay collapses a body before direct edit, so a proof against only
          // one member of a multi-solid body would authorize different topology.
          const pairs =
            provePlanarPairs && shape.solids.length === 1
              ? provenOpposingPlanarFacePairs(
                  kernel,
                  solid,
                  faceTopologyByHandle,
                  bounds,
                  claimedFaceHashes,
                  analysisHashes
                )
              : [];
          if (pairs.length > 0) {
            topology.opposingPlanarFacePairs ??= [];
            topology.opposingPlanarFacePairs.push(...pairs);
          }
          pairsDone?.();
        } else {
          recognitionDone?.();
        }

        analysisRemaining -= 1;
      });
      analysisRemaining += 1;

      const edgesDone = onStage?.('Edge topology');
      // Use the kernel's adaptive exact-curve sampler with the same chordal and
      // angular limits as the shaded mesh. This keeps circular outlines closed
      // and prevents a smooth edge from visibly drifting away from its surface.
      const edgeHandles = Array.from(kernel.getSolidEdges(solid));
      const smoothEdges = brepSmoothEdges(kernel, solid);
      const edgeLines = kernel.meshEdgesAll(
        solid,
        displayTessellation.linearDeflection,
        displayTessellation.angularDeflection
      );
      try {
        const edgePositions = Array.from(edgeLines.positions);
        const edgeOffsets = [
          ...Array.from(edgeLines.offsets),
          edgePositions.length
        ];
        if (
          edgeHandles.length !== edgeLines.edgeCount ||
          edgeOffsets.length !== edgeHandles.length + 1
        ) {
          throw new Error(
            `Edge tessellation layout mismatch: ${edgeHandles.length} handles, ${edgeLines.edgeCount} sampled edges, ${edgeOffsets.length} offsets.`
          );
        }
        for (let index = 0; index < edgeHandles.length; index += 1) {
          const edge = edgeHandles[index]!;
          const witness = edgeWitnessOf(kernel, edge);
          const hash = topologyHashOfWitness('edge', witness);
          const reference = shape.lineage?.edgeReferences.get(edge);
          const verifiedReference =
            reference &&
            reference.currentHash === hash &&
            topologyWitnessesEqual('edge', reference.witness, witness)
              ? reference
              : undefined;
          if (reference && !verifiedReference) {
            lineageDiagnostics.push({
              kind: 'edge',
              status: 'unsupported',
              topologyId: reference.lineageName,
              featureId: reference.producingFeatureId,
              message: `Remus edge lineage ${reference.lineageName} no longer matches its exact measured witness.`
            });
          }
          const points = edgePositions.slice(
            edgeOffsets[index],
            edgeOffsets[index + 1]
          );
          topology.edges.push({
            topologyId: `edge:${hash}`,
            hash,
            reference: verifiedReference,
            length: kernel.edgeLength(edge),
            displayRole: brepEdgeDisplayRole(
              kernel,
              edge,
              edgeToFaces,
              smoothEdges?.has(edge)
            ),
            isSmooth: smoothEdges?.has(edge),
            adjacentFaceHashes: brepAdjacentFaceHashes(
              edge,
              edgeToFaces,
              faceHashByHandle
            ),
            // Given the sampled polyline so a candidate circle is checked
            // against the edge's own geometry before it is published.
            curve: brepEdgeCurve(kernel, edge, points),
            vertexIds: brepVertexIds(
              edge,
              kernel.getEdgeVertexHandles(edge),
              vertexIdByHandle
            ),
            points
          });
        }
      } finally {
        edgeLines.free();
      }

      edgesDone?.();
      const validationDone = onStage?.('Geometry validation');
      bbox.min.x = Math.min(bbox.min.x, publishedBounds[0]!);
      bbox.min.y = Math.min(bbox.min.y, publishedBounds[1]!);
      bbox.min.z = Math.min(bbox.min.z, publishedBounds[2]!);
      bbox.max.x = Math.max(bbox.max.x, publishedBounds[3]!);
      bbox.max.y = Math.max(bbox.max.y, publishedBounds[4]!);
      bbox.max.z = Math.max(bbox.max.z, publishedBounds[5]!);
      analysisJobs.push(() => {
        const done = onStage?.('Volume');
        volume += kernel.volume(solid, MEASUREMENT_DEFLECTION);
        done?.();
        analysisRemaining -= 1;
      });
      analysisRemaining += 1;
      const relaxedErrors = kernel.validateSolidRelaxed(solid);
      valid = relaxedErrors === 0 && valid;
      let strictErrors: number | null = null;
      if (strictBooleanValidation) {
        // The union gate validated this very handle moments ago; nothing
        // mutates a handle in place after its feature ran, so its verdict is
        // the verdict. Anything without one is validated here as before.
        const verdict = strictVerdicts?.get(solid);
        strictErrors =
          verdict !== undefined
            ? verdict.strictErrors
            : kernel.validateSolid(solid);
        strictValid = strictErrors === 0 && strictValid;
      }
      // Preserve the completed gates instead of repeating expensive validation
      // just to write the cache. Hits independently recount and revalidate.
      witness.solids.push({
        solid,
        faces: [...faceHandles].sort((a, b) => a - b),
        edges: [...edgeHandles].sort((a, b) => a - b),
        vertices: [...vertexHandles].sort((a, b) => a - b),
        relaxedErrors,
        strictErrors
      });
      validationDone?.();
    }

    if (lineageDiagnostics.length > 0) {
      topology.lineageDiagnostics = lineageDiagnostics;
    }
    const vertices =
      vertexChunks.length === 1
        ? vertexChunks[0]!
        : new Float32Array(vertexFloatCount);
    const indices =
      indexChunks.length === 1 ? indexChunks[0]! : new Uint32Array(indexCount);
    if (vertexChunks.length !== 1) {
      let offset = 0;
      for (const chunk of vertexChunks) {
        vertices.set(chunk, offset);
        offset += chunk.length;
      }
    }
    if (indexChunks.length !== 1) {
      let offset = 0;
      for (const chunk of indexChunks) {
        indices.set(chunk, offset);
        offset += chunk.length;
      }
    }
    const meshClosure = strictBooleanValidation
      ? inspectTriangleMeshClosure(vertices, indices)
      : null;
    const geometry = {
      witness,
      vertices,
      indices,
      topology,
      faceCount: topology.faces.length,
      valid,
      strictValid,
      meshClosure,
      bbox,
      displayLinearDeflections,
      ...(draftDisplay ? { draftDisplay: true as const } : {})
    };
    return {
      geometry,
      analysis: analysisJobs,
      complete: () => {
        if (analysisRemaining !== 0)
          throw new Error('Body analysis is pending.');
        return { ...geometry, volume };
      }
    };
  }

  async syncDocument(
    document: ProjectDocument,
    onProgress?: RebuildProgressListener,
    onProjection?: (derived: DerivedState) => void,
    analysis?: EditAnalysisRequest,
    options?: {
      cancellation?: BuildCancellationSignal;
      lineageDemand?: readonly BodyId[] | ReadonlySet<BodyId>;
      onGeometryReady?: (geometry: GeometryReadyState) => void;
      yieldControl?: () => Promise<void> | void;
      proposeCarry?: boolean;
      displayRefinement?: boolean;
      persistedSession?: PersistedHistorySession;
    }
  ): Promise<DerivedState> {
    return this.runHistoryJob(async () => {
      this.offeredSession = options?.persistedSession ?? null;
      // A complete sync ends a drag's draft and coarse-frame state. An idle
      // refinement that slipped into a paused drag hands it back unless the
      // history kernel itself was dropped (a fresh kernel holds no warm drag
      // meshes, and nothing the drag recorded applies to it).
      const kernel = this.historyKernel;
      const drag = options?.displayRefinement
        ? {
            draftDisplaySource: this.draftDisplaySource,
            coarseFaceMoveFrame: this.coarseFaceMoveFrame
          }
        : null;
      try {
        const result = await this.syncMeasuredDocument(
          document,
          onProgress,
          onProjection,
          analysis,
          true,
          options?.lineageDemand,
          options?.cancellation,
          options?.onGeometryReady,
          options?.yieldControl,
          false,
          false,
          false,
          options?.proposeCarry === true
        );
        if ('analysis' in result)
          throw new Error('Document analysis is pending.');
        const record = this.lastBuildRecord;
        this.liveSession =
          record &&
          record.kernel === this.historyKernel &&
          !analysis &&
          options?.proposeCarry !== true &&
          !this.transientResults.has(result)
            ? { ...record, derived: result }
            : null;
        return result;
      } finally {
        this.offeredSession = null;
        if (drag && kernel && this.historyKernel === kernel) {
          this.draftDisplaySource = drag.draftDisplaySource;
          this.coarseFaceMoveFrame = drag.coarseFaceMoveFrame;
        }
      }
    });
  }

  hasHistoryFor(projectId: ProjectDocument['projectId']): boolean {
    return this.historyKernel !== null && this.historyProjectId === projectId;
  }

  /**
   * The history kernel's state as a persisted session, when it is exactly
   * the complete build of `document` that the last sync published and the
   * pinned kernel can snapshot it; otherwise null. Idle work: it reads the
   * kernel and copies the build, and changes nothing.
   */
  captureHistorySession(
    document: ProjectDocument
  ): Promise<PersistedHistorySession | null> {
    return this.runHistoryJob(async () => {
      const live = this.liveSessionFor(document);
      const kernel = this.historyKernel;
      const support = kernelSnapshotSupport();
      // A kernel past half its replay budget is not persisted: a restore
      // would carry that arena into every later session and recycle (a full
      // replay) a few edits after reopening. Its reopen replays into a fresh
      // kernel instead, and that kernel is captured.
      if (
        !live ||
        !kernel ||
        !support ||
        this.historyReplayWork * 2 >= MAX_HISTORY_REPLAY_WORK
      )
        return null;
      try {
        const kernelBytes = snapshotKernel(kernel);
        return {
          format: PERSISTED_HISTORY_SESSION_FORMAT,
          kernelBuildId: support.snapshotBuildId(),
          projectId: document.projectId,
          scopeKey: live.scopeKey,
          digests: [...live.digests],
          lineageProbeKey: live.lineageProbeKey,
          carryNeutral: live.carryNeutral,
          build: cloneBuildState(live.build),
          edgeSelections: this.edgeSelections.exportProject(document.projectId),
          kernelBytes,
          kernelDigest: support.snapshotDigest(kernelBytes),
          projectionSignature: projectionSignature(live.derived),
          replayWork: this.historyReplayWork
        };
      } catch {
        // A refusal (`snapshot:poisoned`, `transient_state`, a limit) only
        // means this state is not persisted; the next reopen replays.
        return null;
      }
    }, true);
  }

  /**
   * {@link liveSession} when the history kernel still holds exactly the
   * complete build of `document` the last sync published; otherwise null.
   */
  private liveSessionFor(
    document: ProjectDocument
  ): NonNullable<RemusKernelAdapter['liveSession']> | null {
    const live = this.liveSession;
    if (
      !live ||
      live.kernel !== this.historyKernel ||
      live.projectId !== document.projectId
    )
      return null;
    const features = listFeaturesInOrder(document);
    if (
      features.length !== live.digests.length ||
      historyScopeDigest(document) !== live.scopeKey
    )
      return null;
    const scope = getParameterScope(document).scope;
    for (let index = 0; index < features.length; index += 1) {
      const feature = features[index]!;
      if (
        historyFeatureDigest(document, feature, index, scope, live.demand) +
          carryProposalSalt(feature, false) +
          displayOnlyBlendSalt(feature, false) !==
        live.digests[index]
      )
        return null;
    }
    return live;
  }

  needsHistoryWarmup(projectId: ProjectDocument['projectId']): boolean {
    return this.sparseRestoredHistory && this.historyProjectId === projectId;
  }

  /**
   * Idle work after a persisted session was restored: replays `document` in
   * a second kernel with the ordinary checkpoint schedule, and swaps it in
   * only once complete, so a later edit of any feature restores a nearby
   * checkpoint instead of replaying the whole history. Cancellation (any new
   * work) keeps the restored kernel and its checkpoint as they were; only
   * the per-body measurements, which a later sync takes again, are dropped.
   * Resolves whether the checkpoint table was rebuilt.
   */
  warmHistory(
    document: ProjectDocument,
    options?: {
      cancellation?: BuildCancellationSignal;
      yieldControl?: () => Promise<void> | void;
      lineageDemand?: readonly BodyId[] | ReadonlySet<BodyId>;
    }
  ): Promise<boolean> {
    return this.runHistoryJob(async () => {
      if (!this.needsHistoryWarmup(document.projectId)) return false;
      // Only the state the last sync published: a stale document (an older
      // revision than the kernel now holds) would replay superseded work and
      // swap it in over the current kernel.
      const live = this.liveSessionFor(document);
      if (!live) return false;
      this.liveSession = null;
      const restored = {
        kernel: this.historyKernel!,
        checkpoints: this.historyCheckpoints,
        owners: new Map(this.historyCheckpointOwners),
        scopeKey: this.historyScopeKey,
        projectId: this.historyProjectId,
        replayWork: this.historyReplayWork
      };
      // Detached, so the warm build starts in a fresh kernel and nothing it
      // invalidates on the way frees the restored one.
      this.historyKernel = null;
      this.historyCheckpoints = [];
      this.historyCheckpointOwners.clear();
      this.historyScopeKey = null;
      this.historyProjectId = null;
      try {
        const cancellation = this.historySignal(options?.cancellation);
        const { sources, pinned } = await this.prefetchImportSources(
          document,
          cancellation
        );
        if (documentNeedsTranslators(document)) await loadRemusTranslators();
        await this.buildWithHistoryCache(
          document,
          sources,
          pinned,
          undefined,
          undefined,
          options?.lineageDemand,
          cancellation,
          options?.yieldControl
        );
        restored.kernel.free();
        // The same state the live session published, in the new kernel.
        const record = this.lastBuildRecord;
        if (
          live &&
          record &&
          record.digests.length === live.digests.length &&
          record.digests.every(
            (digest, index) => digest === live.digests[index]
          )
        )
          this.liveSession = { ...record, derived: live.derived };
        return true;
      } catch (error) {
        // Whatever the warm build made goes; the restored kernel returns.
        this.invalidateHistoryCache();
        this.historyKernel = restored.kernel;
        this.historyCheckpoints = restored.checkpoints;
        for (const [id, entry] of restored.owners)
          this.historyCheckpointOwners.set(id, entry);
        this.historyScopeKey = restored.scopeKey;
        this.historyProjectId = restored.projectId;
        this.historyReplayWork = restored.replayWork;
        // Still exactly what the last sync published: a retry may warm it,
        // and a capture may persist it.
        this.liveSession = live;
        // Only new work stops a warm-up; anything else would fail again.
        this.sparseRestoredHistory = isBuildCancelled(error);
        return false;
      }
    }, true);
  }

  async previewGeometry(
    document: ProjectDocument,
    options?: {
      cancellation?: BuildCancellationSignal;
      yieldControl?: () => Promise<void> | void;
      /** Publish meshes and display faces; picks await complete topology. */
      deferTopology?: boolean;
      fullDisplayQuality?: boolean;
      proposeCarry?: boolean;
    }
  ): Promise<GeometryReadyState> {
    return this.runHistoryJob(async () => {
      const result = await this.syncMeasuredDocument(
        document,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        options?.cancellation,
        undefined,
        options?.yieldControl,
        true,
        options?.deferTopology ?? false,
        options?.fullDisplayQuality ?? false,
        options?.proposeCarry === true
      );
      if (!('analysis' in result))
        throw new Error('Expected preview geometry.');
      return result;
    });
  }

  async refineEditPreview(document: ProjectDocument): Promise<boolean> {
    if (
      !this.historyKernel ||
      !(hasPreparedGroupEdit(this.historyKernel) || this.coarseFaceMoveFrame) ||
      // A release of this frame commits a draft display and refines it
      // after acceptance; warming full-quality meshes now would only hold
      // that commit behind a tessellation it no longer needs.
      this.draftDisplaySource
    )
      return false;
    await this.previewGeometry(document, {
      deferTopology: true,
      fullDisplayQuality: true
    });
    return true;
  }

  private async syncMeasuredDocument(
    document: ProjectDocument,
    onProgress?: RebuildProgressListener,
    onProjection?: (derived: DerivedState) => void,
    analysis?: EditAnalysisRequest,
    allowRecovery = true,
    lineageDemand?: readonly BodyId[] | ReadonlySet<BodyId>,
    cancellation?: BuildCancellationSignal,
    onGeometryReady?: (geometry: GeometryReadyState) => void,
    yieldControl?: () => Promise<void> | void,
    geometryOnly = false,
    deferTopology = false,
    fullDisplayQuality = false,
    proposeCarry = false
  ): Promise<DerivedState | GeometryReadyState> {
    cancellation = this.historySignal(cancellation);
    if (
      analysis &&
      (!document.bodyOrder.some((id) => id === analysis.bodyId) ||
        analysis.faceHashes.length > 2 ||
        analysis.faceHashes.some(
          (hash) => !Number.isSafeInteger(hash) || hash <= 0
        ))
    )
      throw new Error(
        'Select one body and at most two valid faces to analyze.'
      );
    const report = rebuildReporter(onProgress);
    const sourcesDone = report('sources', 'Loading imported sources');
    const { sources, pinned } = await this.prefetchImportSources(
      document,
      cancellation
    );
    // Feature builders run synchronously inside the build loop, so a document
    // with file-backed features needs the translator module resident first.
    if (documentNeedsTranslators(document)) {
      await loadRemusTranslators();
    }
    sourcesDone();
    // A newer edit may have arrived while the awaits above yielded: stop a
    // superseded rebuild before it burns worker time, with the typed cancel.
    throwIfBuildCancelled(cancellation);
    // The history kernel outlives this call on purpose — its checkpoints are
    // what the next sync restores. On ANY throw the whole cache is dropped:
    // a failed sync must never leave a table the next sync would trust.
    try {
      const historyDone = report('history', 'Building history');
      const {
        kernel,
        build,
        replayed,
        restored,
        reusedPrimitives,
        reusedPreparedFeatures,
        reusedAxialFeatures,
        strictVerdicts,
        readMemo,
        recycleReason,
        cacheResetReason,
        transient,
        seededSession
      } = await this.buildWithHistoryCache(
        document,
        sources,
        pinned,
        onProgress,
        onProjection,
        lineageDemand,
        cancellation,
        yieldControl,
        geometryOnly && deferTopology,
        geometryOnly && displayOnlyBlendsSupported(RemusKernel),
        proposeCarry
      );
      historyDone();
      // A face drag's frames are as disposable as a prepared group edit's:
      // they mesh at the drag tessellation, and the worker's at-rest
      // refinement (`refineEditPreview`) meshes the resting frame at full
      // quality, except where the release commits a draft display (below).
      // Every other complete sync meshes at full quality.
      const terminalEdit = listFeaturesInOrder(document).at(-1)?.data;
      const faceMoveFrame =
        geometryOnly &&
        deferTopology &&
        !fullDisplayQuality &&
        terminalEdit?.featureKind === 'direct-edit' &&
        terminalEdit.operation.kind === 'offset-face';
      this.coarseFaceMoveFrame = faceMoveFrame;
      const dragMesh =
        faceMoveFrame || (hasPreparedGroupEdit(kernel) && !fullDisplayQuality);
      // A release commits what its last drag frame showed. When that frame
      // was a drag mesh, the commit draws the moved body with the same drag
      // tessellation (the kernel's per-face meshes of it are warm) and a
      // later complete sync refines it; see `exact-display-refinement.ts`.
      const draftCandidate = draftDisplayCandidate(document);
      let draftBodyId: BodyId | undefined;
      if (geometryOnly) {
        this.draftDisplaySource =
          dragMesh && draftCandidate
            ? { projectId: document.projectId, ...draftCandidate }
            : null;
      } else {
        const source = this.draftDisplaySource;
        this.draftDisplaySource = null;
        // A refused or failed release is never accepted: nothing to draw.
        if (
          source &&
          draftCandidate &&
          !analysis &&
          !build.featureWarnings.some(
            (warning) =>
              warning.kind === 'build-failed' || warning.kind === 'refusal'
          ) &&
          source.projectId === document.projectId &&
          source.source === draftCandidate.source &&
          source.bodyId === draftCandidate.bodyId
        )
          draftBodyId = draftCandidate.bodyId;
      }
      const bodies = listNodesByKind(document, 'body');
      const features = new Map(
        listNodesByKind(document, 'feature').map((feature) => [
          feature.featureId,
          feature
        ])
      );
      const importedBodyIds = importedExactBodyIds(document);
      const bodyRepresentations: Record<BodyId, BodyRepresentation> = {};
      const geometryRepresentations: Record<
        BodyId,
        GeometryBodyRepresentation
      > = {};
      const finishBodies: (() => Promise<void>)[] = [];
      /** Bodies published from a retained measurement this sync. */
      const sharedBodies = new Set<BodyId>();
      const scheduling = new CooperativeWork(
        8,
        yieldControl
          ? async () => {
              await yieldControl();
            }
          : undefined
      );
      let geometryValid = true;
      const exportableBodyIds: BodyId[] = [];
      const massBodies = new Map<
        BodyId,
        { solid: number; properties?: BodyMassProperties | null }
      >();
      const hiddenBodies = getParameterHiddenBodyIds(document);
      // Entries for bodies this build no longer produces are dead weight —
      // and their handles may have been retired by a prefix restore.
      for (const bodyId of [...this.measuredShapeCache.keys()]) {
        if (!build.shapes.has(bodyId)) {
          this.evictMeasuredShape(bodyId);
        }
      }
      for (const bodyId of [...this.previewDisplayCache.keys()]) {
        if (!build.shapes.has(bodyId)) {
          this.evictPreviewDisplay(bodyId);
        }
      }
      // Same for the held display deflections: a body this build no longer
      // produces will never be measured again under that id.
      for (const bodyId of [...this.heldDisplayDeflections.keys()]) {
        if (!build.shapes.has(bodyId)) {
          this.heldDisplayDeflections.delete(bodyId);
        }
      }
      let remeasured = 0;
      let reusedMeasurements = 0;
      const measurementMisses: Record<string, number> = {};

      for (const bodyId of document.bodyOrder) {
        const pending = yieldControl?.();
        if (pending) await pending;
        throwIfBuildCancelled(cancellation);
        const body = bodies.find((candidate) => candidate.bodyId === bodyId);
        const shape = build.shapes.get(bodyId);
        if (!body || !shape) {
          continue;
        }
        const measurementDone = report(
          'measurement',
          body.name,
          document.bodyOrder.indexOf(bodyId) + 1,
          document.bodyOrder.length
        );
        const feature = features.get(body.featureId);
        const consumed = build.consumed.has(bodyId);
        if (shape.referenceMesh) {
          const display = projectReferenceMesh(shape.referenceMesh);
          const representation: BodyRepresentation = {
            bodyId,
            name: body.name,
            source: feature?.featureKind ?? 'imported-mesh',
            ...display,
            faceCount: 0,
            color: bodyDisplayColor(body.metadata, feature?.featureKind),
            opacity: bodyOpacityFromMetadata(
              body.metadata?.[BODY_OPACITY_METADATA_KEY]
            ),
            exportableStep: false,
            volume: 0,
            meshReference: true,
            consumed,
            topology: { faces: [], edges: [] }
          };
          geometryRepresentations[bodyId] = representation;
          finishBodies.push(async () => {
            bodyRepresentations[bodyId] = representation;
          });
          measurementDone();
          await scheduling.checkpoint();
          continue;
        }
        // K0.6 import taxonomy. Both warnings describe the imported FILE, so
        // they are driven by what the import measured rather than by the
        // body's state after later features edited it.
        const imported = build.importedStepDiagnostics.get(bodyId);
        const publishImportDiagnostics = () => {
          if (imported && imported.rejections.length > 0) {
            build.warnings.push(
              importedStepDroppedSolidWarning(
                body.name,
                imported.rejections,
                imported.declaredSolidCount
              )
            );
          }
          if (imported && imported.flagged.length > 0) {
            build.warnings.push(
              importedStepValidationWarning(
                body.name,
                imported.flagged.length,
                imported.declaredSolidCount,
                'Remus'
              )
            );
          }
        };
        // An unqualified fast projection falls through to normal measurement,
        // preserving its warning/refusal attribution and affected-feature scope.
        deferredTopology: if (geometryOnly && deferTopology) {
          // Construction scaffolding is neither picked nor rendered by an
          // active drag. Its complete metadata remains in the committed base.
          const strict =
            !consumed &&
            feature?.data.featureKind === 'boolean' &&
            feature.data.operation === 'union' &&
            !isFeatureSuppressed(feature);
          // Hidden unions still need the normal display-closure gate.
          if (strict && hiddenBodies.has(bodyId)) break deferredTopology;
          if (!consumed && !hiddenBodies.has(bodyId)) {
            const reused = this.reusedPreviewDisplay(
              kernel,
              bodyId,
              shape,
              strict,
              imported,
              dragMesh
            );
            if (reused) {
              publishImportDiagnostics();
              geometryRepresentations[bodyId] = {
                bodyId,
                name: body.name,
                source: feature?.featureKind ?? 'primitive',
                faceCount: reused.faceCount,
                color: bodyDisplayColor(body.metadata, feature?.featureKind),
                opacity: bodyOpacityFromMetadata(
                  body.metadata?.[BODY_OPACITY_METADATA_KEY]
                ),
                exportableStep: body.exportableStep,
                consumed,
                mesh: {
                  kind: 'mesh',
                  vertices: reused.vertices,
                  indices: reused.indices
                },
                bbox: reused.bbox,
                // The same shape as a meshed preview body: display faces
                // only, NURBS geometry and edge topology left pending.
                topology: { faces: reused.faces, edges: [] }
              };
              reusedMeasurements += 1;
              measurementDone();
              continue;
            }
          }
          for (const solid of shape.solids) {
            const verdict = strictVerdicts.get(solid);
            const relaxedErrors = kernel.validateSolidRelaxed(solid);
            const strictErrors = strict
              ? (verdict?.strictErrors ?? kernel.validateSolid(solid))
              : 0;
            if (relaxedErrors !== 0 || strictErrors !== 0)
              break deferredTopology;
          }
          const metadata = {
            bodyId,
            name: body.name,
            source: feature?.featureKind ?? 'primitive',
            faceCount: shape.solids.reduce(
              (count, solid) => count + kernel.getSolidFaces(solid).length,
              0
            ),
            color: bodyDisplayColor(body.metadata, feature?.featureKind),
            opacity: bodyOpacityFromMetadata(
              body.metadata?.[BODY_OPACITY_METADATA_KEY]
            ),
            exportableStep: body.exportableStep,
            consumed
          };
          if (consumed || hiddenBodies.has(bodyId)) {
            publishImportDiagnostics();
            // Validation targets include consumed construction bodies. Preserve
            // their presence and verdict without projecting invisible meshes.
            const bounds = shape.solids.map((solid) =>
              kernel.boundingBox(solid)
            );
            const min = { x: 0, y: 0, z: 0 },
              max = { x: 0, y: 0, z: 0 };
            (['x', 'y', 'z'] as const).forEach((axis, i) => {
              min[axis] = Math.min(...bounds.map((b) => b[i]!));
              max[axis] = Math.max(...bounds.map((b) => b[i + 3]!));
            });
            geometryRepresentations[bodyId] = {
              ...metadata,
              bbox: { min, max },
              mesh: {
                kind: 'mesh',
                vertices: new Float32Array(),
                indices: new Uint32Array()
              }
            };
            measurementDone();
            continue;
          }
          let projection: ReturnType<typeof projectShapeMesh>;
          try {
            projection = withSyncReadMemo(readMemo, () =>
              profileDirectEditStage('projection', () =>
                projectShapeMesh(
                  kernel,
                  shape,
                  32 * 1024 * 1024,
                  this.heldDisplayDeflections.get(bodyId),
                  strict ? strictVerdicts : undefined,
                  true,
                  dragMesh
                )
              )
            );
          } catch {
            // Display admission is an optimization, not a new refusal gate.
            break deferredTopology;
          }
          // A disposable drag mesh must never lower the completed display's
          // held quality, including when the next sync restores this source.
          if (!dragMesh && !hasPreparedGroupEdit(kernel))
            this.heldDisplayDeflections.set(
              bodyId,
              projection.linearDeflections
            );
          if (
            strict &&
            !projection.closureValidated &&
            !profileDirectEditStage('meshClosure', () =>
              isClosedConsistentlyOrientedMesh(
                inspectTriangleMeshClosure(
                  projection.mesh.vertices,
                  projection.mesh.indices
                )
              )
            )
          )
            break deferredTopology;
          publishImportDiagnostics();
          // Display face ranges keep the dragged highlight and analytic
          // dimensions current. Edge topology, recognition and persistent
          // output references remain pending; picks are held in the UI.
          const digests = faceContentDigestsOf(
            kernel,
            Uint32Array.from(projection.faceGroups, (group) => group.handle)
          );
          const previewEdit = listFeaturesInOrder(document).at(-1);
          const groupOperation =
            hasPreparedGroupEdit(kernel) &&
            previewEdit?.data.featureKind === 'direct-edit'
              ? previewEdit.data.operation
              : undefined;
          const dimensionRadius =
            groupOperation?.kind === 'resize-blend'
              ? resolveParamValue(
                  groupOperation.newRadius,
                  getParameterScope(document).scope,
                  'radius'
                )
              : groupOperation?.kind === 'resize-cylindrical-face'
                ? resolveParamValue(
                    groupOperation.radius,
                    getParameterScope(document).scope,
                    'radius'
                  )
                : undefined;
          const dimensionSurface =
            groupOperation?.kind === 'resize-blend'
              ? groupOperation.surfaceClass
              : 'cylinder';
          const faces = withSyncReadMemo(readMemo, () =>
            projection.faceGroups.map((group, index) => {
              let measureGeometry = dimensionRadius === undefined;
              if (
                !measureGeometry &&
                surfaceTypeOf(kernel, group.handle) === dimensionSurface
              ) {
                try {
                  const p = JSON.parse(
                    kernel.getAnalyticSurfaceParams(group.handle)
                  ) as Record<string, unknown>;
                  const radius =
                    dimensionSurface === 'torus'
                      ? (p.minorRadius ?? p.minor_radius)
                      : p.radius;
                  measureGeometry =
                    typeof radius === 'number' &&
                    Math.abs(radius - dimensionRadius!) < 1e-6;
                } catch {
                  measureGeometry = true;
                }
              }
              // NURBS area integration is completion metadata, not a display
              // requirement, so B-spline faces carry no geometry. Picks are
              // held for this snapshot.
              const { witness, geometry } = this.previewFaceGeometry.describe(
                kernel,
                group.handle,
                digests?.[index],
                faceWitnessOf,
                measureGeometry
              );
              const hash = topologyHashOfWitness('face', witness);
              return {
                topologyId: `face:${hash}`,
                hash,
                triangleStart: group.triangleStart,
                triangleCount: group.triangleCount,
                geometry
              };
            })
          );
          // A resize names its band explicitly. Preserve that display role
          // on a unique measured result without running whole-body recognition
          // or publishing a persistent topology reference for a drag frame.
          if (
            !consumed &&
            previewEdit?.data.featureKind === 'direct-edit' &&
            previewEdit.data.targetBodyId === bodyId &&
            previewEdit.data.operation.kind === 'resize-blend'
          ) {
            const operation = previewEdit.data.operation;
            const radius = resolveParamValue(
              operation.newRadius,
              getParameterScope(document).scope,
              'radius'
            );
            const matching = faces.filter(
              (f) =>
                f.geometry?.surfaceType === operation.surfaceClass &&
                Math.abs(
                  ((operation.surfaceClass === 'torus'
                    ? f.geometry.minorRadius
                    : f.geometry.radius) ?? Infinity) - radius
                ) < 1e-6
            );
            if (matching.length === 1 && matching[0]!.geometry) {
              matching[0]!.geometry = {
                ...matching[0]!.geometry,
                featureType: 'blend',
                blendRadius: radius,
                editableDimension: 'blendRadius',
                blendRegionFaceCount: 1,
                blendRegionKey: `blend:${matching[0]!.hash}`
              };
            }
          }
          geometryRepresentations[bodyId] = {
            ...metadata,
            mesh: projection.mesh,
            bbox: projection.bbox,
            topology: { faces, edges: [] }
          };
          this.storePreviewDisplay(
            kernel,
            bodyId,
            shape,
            strict,
            imported,
            {
              vertices: projection.mesh.vertices,
              indices: projection.mesh.indices,
              bbox: projection.bbox,
              faceCount: metadata.faceCount,
              faces
            },
            dragMesh
          );
          measurementDone();
          await scheduling.checkpoint();
          throwIfBuildCancelled(cancellation);
          continue;
        }
        // A suppressed union never ran: a body under its id is the first
        // operand passed through, which is not a union result to vouch for.
        const requiresStrictUnionValidation =
          !consumed &&
          feature !== undefined &&
          !isFeatureSuppressed(feature) &&
          feature.data.featureKind === 'boolean' &&
          feature.data.operation === 'union';
        // A strict union's closure verdict is read from its display mesh, so
        // that body is never drafted: the check keeps its full-quality input.
        const draftThisBody =
          bodyId === draftBodyId &&
          !requiresStrictUnionValidation &&
          !consumed &&
          !shape.referenceMesh;
        const recognizeImportedFeatures =
          !consumed && importedBodyIds.has(bodyId);
        // The opening is measured only where it can be grown. Its one
        // consumer, the growing-holder recipe, compiles only against an
        // import under fixed moves or rotations (`rigidImportedSource`, the
        // same test as here), so after a direct edit, fillet, hole or boolean
        // the measurement could only be refused at compile time. On the
        // 160-face hammer it was 3.0 s of a 15.2 s offset-face rebuild (two
        // strict validations inside the lettering proof, three slab
        // intersections, a full face inventory). The body publishes an
        // unsupported opening with that reason instead, which the assistant
        // explains rather than proposing a recipe that cannot compile.
        //
        // Imported-feature recognition is deliberately NOT skipped or carried
        // across such edits: hole edits, face-distance proofs and the edit
        // catalog bind to it on edited bodies, and an edit changes it — an
        // offset face re-limits the fillet bands along its edges and can make
        // a blend recognizable that was not before — so a carried result
        // would publish stale proofs.
        const measureOpening =
          recognizeImportedFeatures &&
          rigidImportedSource(document, bodyId) !== null;
        // Tessellation dominates a sync once the prefix cache removed the
        // replay cost, so an unchanged body serves its previous measurement.
        // Handle identity is the key (see MeasuredBodyCacheEntry); the
        // live handle/validation recount turns a violated lifetime proof into
        // an empty-kernel rebuild before any cached payload is published.
        const solidKey = shape.solids.join(',');
        const analysisHashes =
          analysis?.bodyId === bodyId ? analysis.faceHashes : undefined;
        const terminalDimension = listFeaturesInOrder(document).at(-1);
        // Re-proving unrelated planar moves is capability discovery, not
        // acceptance of a certified radius/diameter edit. Explicit foreground
        // analysis can still request fresh proofs on the resulting body.
        const deferPlanarProofs =
          analysisHashes === undefined &&
          terminalDimension?.data.featureKind === 'direct-edit' &&
          terminalDimension.data.targetBodyId === bodyId &&
          ['resize-blend', 'resize-cylindrical-face'].includes(
            terminalDimension.data.operation.kind
          );
        const analysisKey = analysisHashes
          ? JSON.stringify(analysisHashes)
          : deferPlanarProofs
            ? 'dimension-edit:planar-proofs-on-demand'
            : undefined;
        const cached = this.measuredShapeCache.get(bodyId);
        const provenanceKey = measurementProvenanceKey(
          shape,
          build.importedStepDiagnostics.get(bodyId)
        );
        let measured: Omit<MeasuredShape, 'volume'>;
        let completeMeasurement: () => Promise<MeasuredShape>;
        let displayMeshClosed = () =>
          isClosedConsistentlyOrientedMesh(
            inspectDisplayMeshClosure(measured.vertices, measured.indices)
          );
        if (
          cached &&
          cached.analysisKey === analysisKey &&
          cached.provenanceKey === provenanceKey &&
          cached.solidKey === solidKey &&
          cached.strict === requiresStrictUnionValidation &&
          cached.recognizedImportedFeatures === recognizeImportedFeatures &&
          cached.measuredOpening === measureOpening
        ) {
          // A matching key is only a candidate. A stale handle, changed face/
          // edge/vertex set or validation verdict abandons the entire arena.
          try {
            const witness = measurementWitness(
              kernel,
              shape,
              requiresStrictUnionValidation
            );
            if (
              witness.solids.reduce(
                (count, solid) => count + solid.faces.length,
                0
              ) !== cached.faceHandleCount ||
              JSON.stringify(witness) !== JSON.stringify(cached.witness)
            ) {
              throw new HistoryCacheIntegrityError(
                'Measurement witness disagrees.'
              );
            }
          } catch {
            throw new HistoryCacheIntegrityError(
              'Measurement handle or validation probe failed.'
            );
          }
          let complete = this.options.shareRetainedMeasurements
            ? cached.measured
            : structuredClone(cached.measured);
          sharedBodies.add(bodyId);
          // A complete sync of a drafted release keeps every exact part of
          // its measurement and swaps in the full-quality display mesh. A
          // preview frame only draws it, so it never pays for that here.
          if (complete.draftDisplay && !draftThisBody && !geometryOnly) {
            const draft = complete;
            try {
              complete = withSyncReadMemo(readMemo, () =>
                profileDirectEditStage('draftRefinement', () =>
                  refineDraftDisplay(kernel, shape, draft)
                )
              );
            } catch {
              throw new HistoryCacheIntegrityError(
                'Draft display refinement failed.'
              );
            }
            this.storeMeasuredShape(bodyId, {
              ...cached,
              bytes:
                cached.bytes -
                measuredShapeBytes(cached.measured) +
                measuredShapeBytes(complete),
              measured: complete
            });
          } else {
            // The published mesh is the retained one: its closure verdict
            // is remembered with it.
            const entry = cached;
            displayMeshClosed = () =>
              (entry.displayMeshClosed ??= isClosedConsistentlyOrientedMesh(
                inspectDisplayMeshClosure(
                  entry.measured.vertices,
                  entry.measured.indices
                )
              ));
          }
          const reused = complete;
          measured = reused;
          completeMeasurement = async () => reused;
          reusedMeasurements += 1;
        } else {
          const reason = !cached
            ? 'no-entry'
            : cached.solidKey !== solidKey
              ? 'solid-handles'
              : cached.analysisKey !== analysisKey
                ? 'analysis'
                : cached.strict !== requiresStrictUnionValidation
                  ? 'strictness'
                  : cached.recognizedImportedFeatures !==
                        recognizeImportedFeatures ||
                      cached.measuredOpening !== measureOpening
                    ? 'recognition'
                    : 'provenance';
          measurementMisses[reason] = (measurementMisses[reason] ?? 0) + 1;
          // Inside the replay's read memo: a solid the replay just built (or
          // the last sync measured) is not witnessed or classified again.
          // Each face of the body is read once for the whole measurement —
          // published geometry, recognition and the opening inventory share
          // it — instead of up to three times (see withFaceGeometryMemo).
          const faceGeometry = new Map<number, FaceGeometry | undefined>();
          const faces = shape.solids.flatMap((solid) =>
            Array.from(kernel.getSolidFaces(solid))
          );
          const inMeasurementScope = <T>(work: () => T): T =>
            withSyncReadMemo(readMemo, () =>
              withFaceGeometryMemo(kernel, faces, work, faceGeometry)
            );
          const prepared = inMeasurementScope(() =>
            this.prepareShapeMeasurement(
              kernel,
              shape,
              requiresStrictUnionValidation,
              recognizeImportedFeatures,
              (part) =>
                report(
                  'measurement',
                  `${body.name}: ${part}`,
                  document.bodyOrder.indexOf(bodyId) + 1,
                  document.bodyOrder.length
                ),
              analysisHashes,
              1 / millimetresPerUnit(document.units),
              strictVerdicts,
              measureOpening,
              this.heldDisplayDeflections.get(bodyId),
              !deferPlanarProofs,
              draftThisBody
            )
          );
          measured = prepared.geometry;
          completeMeasurement = async () => {
            for (const job of prepared.analysis) {
              await scheduling.checkpoint();
              throwIfBuildCancelled(cancellation);
              inMeasurementScope(job);
            }
            return prepared.complete();
          };
          remeasured += 1;
          if (measured.displayLinearDeflections) {
            this.heldDisplayDeflections.set(
              bodyId,
              measured.displayLinearDeflections
            );
          }
          const analyze = completeMeasurement;
          completeMeasurement = async () => {
            const measured = await analyze();
            const witness = measured.witness;
            this.storeMeasuredShape(bodyId, {
              ...(analysisKey ? { analysisKey } : {}),
              solidKey,
              provenanceKey,
              witness,
              strict: requiresStrictUnionValidation,
              recognizedImportedFeatures: recognizeImportedFeatures,
              measuredOpening: measureOpening,
              faceHandleCount: witness.solids.reduce(
                (count, solid) => count + solid.faces.length,
                0
              ),
              bytes:
                measuredShapeBytes(measured) +
                new TextEncoder().encode(
                  JSON.stringify(witness) +
                    provenanceKey +
                    solidKey +
                    (analysisKey ?? '')
                ).byteLength,
              measured
            });
            // Measurement may publish lineage leaves read from a retained
            // build snapshot. The mesh buffers and bounds are already owned;
            // detach topology too so a caller cannot mutate that snapshot.
            return {
              ...measured,
              topology: structuredClone(measured.topology)
            };
          };
        }
        if (
          !consumed &&
          !hiddenBodies.has(bodyId) &&
          shape.solids.length === 1 &&
          measured.faceCount <= MAX_MASS_PROPERTY_QUERY_FACES
        ) {
          massBodies.set(bodyId, { solid: shape.solids[0]! });
        }
        if (!measured.valid) {
          build.warnings.push(
            `Body "${body.name}" failed exact B-rep validation.`
          );
        }
        publishImportDiagnostics();
        if (
          requiresStrictUnionValidation &&
          feature !== undefined &&
          !hasRefusingFeatureWarning(build, feature.featureId) &&
          (!measured.strictValid ||
            measured.meshClosure === null ||
            !isClosedConsistentlyOrientedMesh(measured.meshClosure))
        ) {
          raiseFeatureWarning(
            build,
            feature,
            'Union produced an open, non-manifold, or inconsistently oriented result. Adjust the overlap or placement and try again.',
            'refusal',
            adapterRefusalRecord('union_not_solid')
          );
        } else if (
          !requiresStrictUnionValidation &&
          !geometryOnly &&
          !consumed &&
          !hiddenBodies.has(bodyId) &&
          measured.valid &&
          // A draft mesh is not the display this advisory describes: the
          // refinement that swaps in the full-quality mesh (about 0.3 s
          // later) raises it, so it never flips with the draft.
          !measured.draftDisplay &&
          feature !== undefined &&
          // Imports report their own source-file diagnostics, and an imported
          // sheet or single facet is legitimately open.
          feature.featureKind !== 'imported-step' &&
          feature.featureKind !== 'imported-mesh' &&
          !hasRefusingFeatureWarning(build, feature.featureId) &&
          !displayMeshClosed()
        ) {
          // The B-rep passed validation, so the solid is kept; only its
          // display tessellation has gaps. Say so instead of letting the
          // viewport show holes that look like missing geometry. Only a body
          // with no NURBS face may be called exact here: a NURBS face can be
          // an approximate blend fit, which its feature discloses on its own.
          const hasNurbsFace = shape.solids.some((solid) =>
            Array.from(kernel.getSolidFaces(solid)).some(
              (face) => surfaceTypeOf(kernel, face) === 'bspline'
            )
          );
          raiseFeatureWarning(
            build,
            feature,
            displayMeshGapsAdvisory(hasNurbsFace),
            'advisory'
          );
        }
        geometryRepresentations[bodyId] = {
          bodyId,
          name: body.name,
          source: feature?.featureKind ?? 'primitive',
          mesh: {
            kind: 'mesh',
            vertices: measured.vertices,
            indices: measured.indices
          },
          faceCount: measured.faceCount,
          // G2: one neutral colour unless someone chose one; the stamp the
          // feature wrote is its legend colour, not the body's.
          color: bodyDisplayColor(body.metadata, feature?.featureKind),
          opacity: bodyOpacityFromMetadata(
            body.metadata?.[BODY_OPACITY_METADATA_KEY]
          ),
          exportableStep: body.exportableStep,
          consumed,
          ...(imported
            ? { importedStepDeclaredSolidCount: imported.declaredSolidCount }
            : {}),
          bbox: measured.bbox,
          topology: measured.topology,
          ...(measured.draftDisplay ? { displayQuality: 'draft' as const } : {})
        };
        geometryValid =
          geometryValid &&
          measured.valid &&
          (!requiresStrictUnionValidation ||
            (measured.strictValid &&
              measured.meshClosure !== null &&
              isClosedConsistentlyOrientedMesh(measured.meshClosure)));
        finishBodies.push(async () => {
          const complete = await completeMeasurement();
          measurementDone();
          bodyRepresentations[bodyId] = {
            ...geometryRepresentations[bodyId]!,
            topology: complete.topology,
            volume: complete.volume
          };
        });
        await scheduling.checkpoint();
        throwIfBuildCancelled(cancellation);
        if (body.exportableStep && !consumed) {
          exportableBodyIds.push(bodyId);
        }
      }

      if (geometryOnly) {
        // This is deliberately not a measured-shape cache entry or a mass
        // snapshot (only the preview display cache keeps its meshes). A
        // release must complete current-revision analysis before committing;
        // a preview never creates quantities or analysis proofs.
        const pending = yieldControl?.();
        if (pending) await pending;
        throwIfBuildCancelled(cancellation);
        return profileDirectEditStage('publicationClone', () =>
          structuredClone({
            bodyRepresentations: geometryRepresentations,
            warnings: build.warnings,
            featureWarnings: build.featureWarnings,
            updatedAt: nowIso(),
            analysis: 'pending' as const,
            ...(deferTopology ? { topology: 'pending' as const } : {})
          })
        );
      }
      if (
        onGeometryReady &&
        // A restored session publishes nothing before its projection is
        // matched below; it is complete moments later anyway.
        !seededSession &&
        geometryValid &&
        !build.featureWarnings.some(
          (warning) =>
            warning.kind === 'build-failed' || warning.kind === 'refusal'
        )
      ) {
        // Publications own buffers/topology; later analysis cannot mutate
        // them. A shared retained measurement is immutable and no analysis
        // runs on it, so in sharing mode it is published as is.
        const share = this.options.shareRetainedMeasurements === true;
        const owned = structuredClone({
          bodyRepresentations: share
            ? Object.fromEntries(
                Object.entries(geometryRepresentations).filter(
                  ([bodyId]) => !sharedBodies.has(bodyId as BodyId)
                )
              )
            : geometryRepresentations,
          warnings: build.warnings,
          featureWarnings: build.featureWarnings,
          updatedAt: nowIso(),
          analysis: 'pending' as const
        });
        const publication: GeometryReadyState = share
          ? {
              ...owned,
              // Body order as built, shared and owned bodies interleaved.
              bodyRepresentations: Object.fromEntries(
                Object.entries(geometryRepresentations).map(
                  ([bodyId, body]) => [
                    bodyId,
                    owned.bodyRepresentations[bodyId as BodyId] ?? {
                      ...body,
                      mesh: { ...body.mesh }
                    }
                  ]
                )
              )
            }
          : owned;
        onGeometryReady(publication);
        await scheduling.checkpoint(true);
        throwIfBuildCancelled(cancellation);
      }
      for (const finish of finishBodies) await finish();
      throwIfBuildCancelled(cancellation);

      // The last body may itself exhaust the worker budget. Deliver pending
      // edits before publishing any final derived state or live query epoch.
      const pending = yieldControl?.();
      if (pending) await pending;
      throwIfBuildCancelled(cancellation);
      if (seededSession) {
        // Never publish or build on a restored state that differs from what
        // the session showed when it was captured; recovery replays it.
        if (
          !projectionMatches(
            seededSession.projectionSignature,
            projectionSignature({
              bodyRepresentations,
              warnings: build.warnings,
              featureWarnings: build.featureWarnings
            })
          )
        ) {
          this.sessionRestoreOutcome = 'rejected';
          throw new HistoryCacheIntegrityError(
            'The restored session disagrees with its captured projection.'
          );
        }
        this.sessionRestoreOutcome = 'restored';
        this.sparseRestoredHistory = true;
        this.unvalidatedSeed = false;
        // A replay would have resolved these again; a restore carries them.
        this.edgeSelections.importProject(
          document.projectId,
          seededSession.edgeSelections
        );
      }
      const sessionRestore = this.sessionRestoreOutcome;
      this.sessionRestoreOutcome = null;
      this.options.onRebuildCacheEvent?.({
        ...(sessionRestore ? { sessionRestore } : {}),
        kind:
          reusedPrimitives + reusedPreparedFeatures > 0
            ? 'independent-reuse'
            : restored > 0
              ? 'prefix-restore'
              : 'full-rebuild',
        ...(reusedPrimitives > 0 ? { reusedPrimitives } : {}),
        ...(reusedPreparedFeatures > 0 ? { reusedPreparedFeatures } : {}),
        ...(reusedAxialFeatures > 0 ? { reusedAxialFeatures } : {}),
        ...(recycleReason ? { recycleReason } : {}),
        replayed,
        restored,
        remeasured,
        reusedMeasurements,
        ...(this.options.measurementCacheDiagnostics
          ? {
              checkpointMemory: checkpointMemoryStats(kernel),
              measurementCache: {
                hits: reusedMeasurements,
                misses: measurementMisses,
                retainedBytes: this.measuredShapeCacheBytes,
                resetReason: !allowRecovery
                  ? 'measurement-proof'
                  : (cacheResetReason ?? null)
              }
            }
          : {})
      });
      this.currentMassSnapshot = {
        projectId: document.projectId,
        version: document.version,
        epoch: this.massPropertiesEpoch,
        bodies: massBodies
      };
      const derived: DerivedState = {
        bodyRepresentations,
        ...(analysis ? { editAnalysis: structuredClone(analysis) } : {}),
        exportableBodyIds: exportableBodyIds.filter(
          (id) => !hiddenBodies.has(id)
        ),
        warnings: build.warnings,
        updatedAt: nowIso(),
        ...(build.datumFrames.size > 0
          ? { datumFrames: Object.fromEntries(build.datumFrames) }
          : {}),
        ...(build.datumAxes.size > 0
          ? { datumAxes: Object.fromEntries(build.datumAxes) }
          : {}),
        ...(build.sketchProjections?.size
          ? { sketchProjections: Object.fromEntries(build.sketchProjections) }
          : {}),
        ...(build.sketchObjectOverrides?.size
          ? {
              sketchGeometry: {
                projectId: document.projectId,
                documentVersion: document.version,
                objects: Object.fromEntries(build.sketchObjectOverrides)
              }
            }
          : {}),
        ...(build.faceReferenceRepairs?.length
          ? { faceReferenceRepairs: build.faceReferenceRepairs }
          : {}),
        ...(build.referenceRepairs.length > 0
          ? { referenceRepairs: build.referenceRepairs }
          : {}),
        ...(build.edgeHashRepairs?.length
          ? { edgeHashRepairs: build.edgeHashRepairs }
          : {}),
        featureWarnings: build.featureWarnings
      };
      if (transient) this.transientResults.add(derived);
      return derived;
    } catch (error) {
      // Cancellation is not a failure to recover from: it commits nothing —
      // no measured shapes, no mass snapshot, no cache event — and rethrows
      // typed, so the last valid model stays and a stale result can never
      // overwrite a newer one. A seeded session it interrupted before its
      // projection was matched is dropped with it.
      if (isBuildCancelled(error)) {
        if (this.unvalidatedSeed) this.invalidateHistoryCache();
        throw error;
      }
      this.invalidateHistoryCache();
      if (allowRecovery && error instanceof HistoryCacheIntegrityError) {
        return this.syncMeasuredDocument(
          document,
          onProgress,
          onProjection,
          analysis,
          false,
          lineageDemand,
          cancellation,
          onGeometryReady,
          yieldControl,
          geometryOnly,
          deferTopology,
          false,
          proposeCarry
        );
      }
      throw error;
    }
  }

  /**
   * Runs `operate` against a build of `document` on the long-lived history
   * kernel instead of a throwaway one. It restores the retained prefix and
   * replays any uncached suffix, just like syncDocument.
   *
   * Afterwards the kernel is restored to the last retained checkpoint, so
   * the uncached suffix and operation scratch (unit-scaling solid copies,
   * tessellation) vanish. The table stays sound for the next sync.
   * With checkpointing disabled there is nothing to
   * restore to, so the cache is invalidated exactly as a thrown sync would —
   * the next sync rebuilds from scratch either way.
   */
  private withExportBuild<T>(
    document: ProjectDocument,
    operate: (kernel: RemusKernel, build: ExactBuildResult) => T,
    lineageDemand?: readonly BodyId[]
  ): Promise<T> {
    return this.runHistoryJob(() =>
      this.withOwnedExportBuild(document, operate, lineageDemand)
    );
  }

  private async withOwnedExportBuild<T>(
    document: ProjectDocument,
    operate: (kernel: RemusKernel, build: ExactBuildResult) => T,
    lineageDemand?: readonly BodyId[]
  ): Promise<T> {
    const { sources, pinned } = await this.prefetchImportSources(document);
    const { kernel, build } = await this.buildWithHistoryCache(
      document,
      sources,
      pinned,
      undefined,
      undefined,
      lineageDemand
    );
    try {
      return operate(kernel, build);
    } finally {
      const last = this.historyCheckpoints.length - 1;
      if (last >= 0) {
        try {
          this.clearCurrentMassSnapshot();
          kernel.restore(this.historyCheckpoints[last]!.checkpointId);
          this.primitiveBuildCache.restoredThrough(
            this.historyCheckpoints[last]!.featureIndex
          );
        } catch {
          this.invalidateHistoryCache();
        }
      } else {
        this.invalidateHistoryCache();
      }
    }
  }

  private exportSolidsFor(
    kernel: RemusKernel,
    build: ExactBuildResult,
    document: ProjectDocument,
    bodyIds: BodyId[],
    exportUnits: UnitSystem = 'mm'
  ): number[] {
    return this.exportBodySolidsFor(
      kernel,
      build,
      document,
      bodyIds,
      exportUnits
    ).flatMap(({ solids }) => solids);
  }

  /** The export solids grouped by the body they belong to, in body order. */
  private exportBodySolidsFor(
    kernel: RemusKernel,
    build: ExactBuildResult,
    document: ProjectDocument,
    bodyIds: BodyId[],
    exportUnits: UnitSystem = 'mm'
  ): { bodyId: BodyId; solids: number[] }[] {
    const hidden = getParameterHiddenBodyIds(document);
    // Consumed operands keep their retained shapes in the build, but they are
    // superseded bodies — exporting one would ship a dead body as if it were
    // the model. Skip them exactly like parameter-hidden bodies, so a stale
    // caller list degrades to "nothing left to export" instead of a silent
    // wrong file.
    const bodies = bodyIds
      .filter((id) => !hidden.has(id) && !build.consumed.has(id))
      .map((bodyId) => {
        const shape = build.shapes.get(bodyId);
        if (!shape) {
          throw new Error(`Body ${bodyId} has no exact geometry.`);
        }
        if (shape.referenceMesh) {
          throw new Error(
            'A mesh reference has no exact solid to export. Export it as STL instead.'
          );
        }
        return { bodyId, solids: shape.solids };
      })
      .filter(({ solids }) => solids.length > 0);
    if (bodies.length === 0) {
      throw new Error('Select at least one body to export.');
    }
    const scale = exportLengthScale(document.units, exportUnits);
    return scale === 1
      ? bodies
      : bodies.map(({ bodyId, solids }) => ({
          bodyId,
          solids: solids.map((solid) =>
            kernel.copyAndTransformSolid(solid, uniformScaleMatrix(scale))
          )
        }));
  }

  /**
   * The export solids re-made from their tessellation at an explicit angular
   * tolerance. The paired writers tessellate at the kernel's default angle
   * and take no other, so a tighter angle is applied here: each solid is
   * meshed with it and rebuilt as a mesh-backed solid, which every writer
   * then passes through triangle for triangle.
   */
  private angularExportSolids(
    kernel: RemusKernel,
    io: RemusIo,
    solids: number[],
    deflection: number,
    angularTolerance: number
  ): number[] {
    return solids.flatMap((solid) => {
      const mesh = kernel.tessellateSolid(solid, deflection, angularTolerance);
      try {
        return [
          ...kernel.deserializeSolids(
            io.importIndexedMesh(mesh.positions, mesh.indices)
          )
        ];
      } finally {
        mesh.free();
      }
    });
  }

  async exportStep(
    document: ProjectDocument,
    bodyIds: BodyId[],
    options: StepExportOptions = {}
  ): Promise<string> {
    const units = options.units ?? 'mm';
    const io = await loadRemusTranslators();
    return this.withExportBuild(document, (kernel, build) => {
      const bodies = this.exportBodySolidsFor(
        kernel,
        build,
        document,
        bodyIds,
        units
      );
      const bodyNodes = new Map(
        listNodesByKind(document, 'body').map((body) => [body.bodyId, body])
      );
      const featureKinds = new Map(
        listNodesByKind(document, 'feature').map((feature) => [
          feature.featureId,
          feature.featureKind
        ])
      );
      const metadata: StepExportMetadata = {
        productName: document.name,
        fileName: options.fileName ?? `${document.name}.step`,
        timestamp: options.timestamp ?? stepTimestamp(new Date()),
        solids: bodies.flatMap(({ bodyId, solids }) => {
          const body = bodyNodes.get(bodyId);
          const label = {
            name: body?.name ?? '',
            color: bodyDisplayColor(
              body?.metadata,
              body ? featureKinds.get(body.featureId) : undefined
            )
          };
          return solids.map(() => label);
        })
      };
      // Never fuse: a boolean union changes the geometry (overlaps merge,
      // coincident faces weld). Every root of the arena document becomes its
      // own MANIFOLD_SOLID_BREP inside one shape representation, so the
      // bodies stay distinct through a round trip.
      return finishStepExport(
        declareStepLengthUnit(
          decodeText(
            io.exportStepWithOptions(
              kernel.serializeSolids(
                new Uint32Array(bodies.flatMap(({ solids }) => solids))
              ),
              stepWriterOptions(metadata)
            )
          ),
          units
        ),
        metadata
      );
    });
  }

  async exportFaceDxf(
    document: ProjectDocument,
    face: DxfFaceSelector,
    options: ExportUnitOptions = {}
  ): Promise<string> {
    const units = options.units ?? 'mm';
    return this.withExportBuild(document, (kernel, build) => {
      const shape = build.shapes.get(face.bodyId);
      if (!shape) {
        throw new Error(`Body ${face.bodyId} has no exact geometry.`);
      }
      const solid = collapseShape(kernel, shape);
      const { face: faceHandle } = resolveDirectEditFace(
        kernel,
        shape,
        solid,
        face
      );
      // The face resolves on the UNSCALED solid; uniform unit scaling
      // commutes with plane projection, so the extraction scales its 2D
      // output instead of copying the solid.
      const entities = faceDxfEntities(
        kernel,
        faceHandle,
        exportLengthScale(document.units, units),
        millimetresPerUnit(document.units)
      );
      return writeDxf(entities, { units });
    });
  }

  /**
   * The bodies a section applies to when the caller names none: every body
   * the build produced, minus the ones a parameter hides and the ones a
   * later boolean consumed. A body consumed by a later boolean still has a
   * shape in the build — sectioning those too would draw the pre-boolean
   * blank straight through the part that replaced it.
   *
   * This is the DOCUMENT's visibility, not a viewport's. `Hide Body` and
   * `Isolate` write device-local view state that never reaches the
   * document, so a caller with a viewport must name its own bodies.
   */
  private sectionableBodyIds(
    build: ExactBuildResult,
    hidden: ReadonlySet<BodyId>
  ): BodyId[] {
    return [...build.shapes.keys()].filter(
      (bodyId) => !hidden.has(bodyId) && !build.consumed.has(bodyId)
    );
  }

  /**
   * Section every named body at one plane, per body, on the build's own
   * solids. Bodies are sectioned separately rather than fused first: a union
   * would change the geometry being measured, and the kernel refuses a
   * cross-section that falls into disjoint regions anyway.
   */
  private sectionBuild(
    kernel: RemusKernel,
    build: ExactBuildResult,
    document: ProjectDocument,
    plane: ExactSectionPlane,
    bodyIds: BodyId[] | undefined
  ): { regions: SectionOutlineRegion[]; refusals: SectionOutlineRefusal[] } {
    const hidden = getParameterHiddenBodyIds(document);
    const regions: SectionOutlineRegion[] = [];
    const refusals: SectionOutlineRefusal[] = [];
    const requested = bodyIds ?? this.sectionableBodyIds(build, hidden);
    for (const bodyId of requested) {
      if (hidden.has(bodyId) || build.consumed.has(bodyId)) {
        continue;
      }
      const shape = build.shapes.get(bodyId);
      if (!shape) {
        // A body the caller named that this document never built. Refused by
        // name rather than thrown: a section that loses every body it COULD
        // cut because one id was stale reports an internal diagnostic where
        // a drawing should be. It is not `plane-misses-body`, so it still
        // shuts the export.
        refusals.push({
          bodyId,
          reason: 'unknown-body',
          message: `Body ${bodyId} has no exact geometry in this model.`
        });
        continue;
      }
      for (const solid of shape.solids) {
        const outcome = exactSolidSection(kernel, solid, plane);
        if (outcome.status === 'refused') {
          refusals.push({
            bodyId,
            reason: outcome.reason,
            message: outcome.message
          });
          continue;
        }
        regions.push({
          bodyId,
          area: outcome.area,
          loops: outcome.loops,
          positions: outcome.positions,
          indices: outcome.indices
        });
      }
    }
    return { regions, refusals };
  }

  async sectionOutline(
    document: ProjectDocument,
    plane: ExactSectionPlane,
    bodyIds?: BodyId[]
  ): Promise<SectionOutlineReport> {
    return this.withExportBuild(document, (kernel, build) => {
      const { regions, refusals } = this.sectionBuild(
        kernel,
        build,
        document,
        plane,
        bodyIds
      );
      return { plane, regions, refusals };
    });
  }

  async exportSectionDxf(
    document: ProjectDocument,
    plane: ExactSectionPlane,
    bodyIds?: BodyId[],
    options: ExportUnitOptions = {}
  ): Promise<string> {
    const units = options.units ?? 'mm';
    return this.withExportBuild(document, (kernel, build) => {
      const hidden = getParameterHiddenBodyIds(document);
      const requested = bodyIds ?? this.sectionableBodyIds(build, hidden);
      const faces: number[] = [];
      let cut = 0;
      for (const bodyId of requested) {
        if (hidden.has(bodyId) || build.consumed.has(bodyId)) {
          continue;
        }
        const shape = build.shapes.get(bodyId);
        if (!shape) {
          // `sectionOutline` reports this as an `unknown-body` refusal and
          // draws the rest; a DRAWING may not quietly lose a named body, so
          // the export fails closed exactly as it does for any other refusal
          // that is not the plane simply missing. The rail's export gate is
          // shut in this state, so reaching here means a caller bypassed it.
          throw new Error(
            `Body ${bodyId} has no exact geometry in this model.`
          );
        }
        for (const solid of shape.solids) {
          const outcome = exactSolidSection(kernel, solid, plane);
          if (outcome.status === 'ok') {
            faces.push(...outcome.faces);
            cut += 1;
            continue;
          }
          // A plane that simply misses one body of several is not an error;
          // any other refusal would silently drop material from the drawing.
          if (outcome.reason !== 'plane-misses-body') {
            throw new Error(outcome.message);
          }
        }
      }
      if (cut === 0) {
        throw new Error('The section plane does not cut any body.');
      }
      // The section reads the UNSCALED build solids; uniform unit scaling
      // commutes with plane projection, so the 2D output is scaled instead.
      return writeDxf(
        sectionDxfEntities(
          kernel,
          faces,
          plane,
          exportLengthScale(document.units, units),
          millimetresPerUnit(document.units)
        ),
        { units }
      );
    });
  }

  async exportSketchDxf(
    document: ProjectDocument,
    sketchId: SketchId,
    options: ExportUnitOptions = {}
  ): Promise<string> {
    const units = options.units ?? 'mm';
    return this.exportSketchEntities(
      document,
      sketchId,
      exportLengthScale(document.units, units),
      (entities) => writeDxf(entities, { units }),
      'The DXF writer could not assemble the document.'
    );
  }

  async exportSketchSvg(
    document: ProjectDocument,
    sketchId: SketchId,
    options: { transparent?: boolean } = {}
  ): Promise<string> {
    const name = findSketch(document, sketchId)?.name;
    // Scale 1: SVG keeps the document's own units, stated by its width/height.
    return this.exportSketchEntities(
      document,
      sketchId,
      1,
      (entities) =>
        writeSketchSvg(entities, {
          units: document.units,
          ...(name ? { title: name } : {}),
          ...(options.transparent === false ? { transparent: false } : {})
        }),
      'The SVG writer could not assemble the document.'
    );
  }

  /**
   * One saved sketch lowered to exact 2D entities at `scale` per document
   * unit, then handed to a format writer. Shared by the DXF and SVG exports
   * so both refuse the same sketches by the same names.
   */
  private async exportSketchEntities(
    document: ProjectDocument,
    sketchId: SketchId,
    scale: number,
    write: (entities: DxfEntity[]) => string,
    writerFailure: string
  ): Promise<string> {
    const sketch = findSketch(document, sketchId);
    if (!sketch) {
      throw new SketchDxfExportError(
        'sketch-not-found',
        `Sketch ${sketchId} is not in this document.`
      );
    }
    const { scope, errors } = getParameterScope(document);
    if (errors.length > 0) {
      throw new SketchDxfExportError(
        'parameters-invalid',
        `Parameters failed to evaluate: ${errors.join('; ')}`
      );
    }
    try {
      return await this.withExportBuild(document, (_kernel, build) => {
        assertSketchProjectionsValid(build, sketchId);
        // The sketch feature resolves this same basis at its history position
        // during the build — canonical offsets, arbitrary frames, and
        // face-attached lineage alike — so reading it here is exact without a
        // second resolution pass. It is still validated before anything emits.
        const basis = build.sketchBases.get(sketchId);
        if (!basis) {
          throw new SketchDxfExportError(
            'stale-plane-attachment',
            `Sketch "${sketch.name}" has no plane resolved at its history position; its attachment cannot be placed exactly.`
          );
        }
        const outcome = sketchDxfEntities({
          objects: sketch.objectIds.map((id) => {
            const node = document.nodes[id];
            return {
              id,
              data:
                build.sketchObjectOverrides?.get(id) ??
                (node?.kind === 'sketch-object' ? node.data : undefined)
            };
          }),
          scope,
          basis,
          documentUnits: document.units,
          millimeterScale: scale
        });
        if (outcome.status === 'refused') {
          throw new SketchDxfExportError(outcome.reason, outcome.message);
        }
        try {
          return write(outcome.entities);
        } catch (error) {
          throw new SketchDxfExportError(
            'writer-refused',
            error instanceof Error ? error.message : writerFailure
          );
        }
      });
    } catch (error) {
      if (error instanceof SketchDxfExportError) {
        throw error;
      }
      // A face-attached sketch resolves its plane through history-position
      // face lineage inside the build, so a build failure on such a sketch is
      // dominated by attachment resolution: missing, deleted, ambiguous, or
      // non-planar. The original text is kept, so nothing is hidden by the
      // stable reason.
      if (sketch.planeRef.type === 'face') {
        throw new SketchDxfExportError(
          'stale-plane-attachment',
          `Sketch "${sketch.name}" cannot attach to its face exactly (${error instanceof Error ? error.message : 'face lineage failed'}).`
        );
      }
      throw error;
    }
  }

  /** Keep reference facets out of B-rep writers, including mixed selections. */
  private referenceExportMeshes(
    kernel: RemusKernel,
    build: ExactBuildResult,
    document: ProjectDocument,
    bodyIds: BodyId[],
    units: UnitSystem,
    deflection: number,
    angular: number | null = null
  ): StlExportMesh[] | null {
    const hidden = getParameterHiddenBodyIds(document);
    const selected = bodyIds.filter(
      (id) => !hidden.has(id) && !build.consumed.has(id)
    );
    if (!selected.some((id) => build.shapes.get(id)?.referenceMesh))
      return null;
    const scale = exportLengthScale(document.units, units);
    return selected.flatMap((id) => {
      const shape = build.shapes.get(id);
      if (!shape) throw new Error(`Body ${id} has no geometry to export.`);
      if (shape.referenceMesh) {
        return [
          {
            name: id,
            vertices: shape.referenceMesh.vertices.map(
              (value) => value * scale
            ),
            indices: shape.referenceMesh.indices
          }
        ];
      }
      return shape.solids.map((solid) => {
        const mesh = kernel.tessellateSolidGroupedBinary(
          solid,
          deflection / scale,
          angular ?? undefined
        );
        try {
          return {
            name: id,
            vertices: Float64Array.from(
              mesh.positions,
              (value) => value * scale
            ),
            indices: mesh.indices.slice()
          };
        } finally {
          mesh.free();
        }
      });
    });
  }

  async exportStl(
    document: ProjectDocument,
    bodyIds: BodyId[],
    deflection: number = STL_EXPORT_DEFLECTION,
    options: MeshExportTolerances = {}
  ): Promise<string> {
    const units = options.units ?? 'mm';
    const angular = explicitAngularTolerance(options.angularTolerance);
    // The deflection is physical millimetres; the solids are in `units`.
    const unitDeflection = deflection / millimetresPerUnit(units);
    const io = await loadRemusTranslators();
    return this.withExportBuild(document, (kernel, build) => {
      const referenceMeshes = this.referenceExportMeshes(
        kernel,
        build,
        document,
        bodyIds,
        units,
        unitDeflection,
        angular
      );
      if (referenceMeshes)
        return writeAsciiStl(document.name, referenceMeshes, {
          preserveDegenerate: true
        });
      const scaled = this.exportSolidsFor(
        kernel,
        build,
        document,
        bodyIds,
        units
      );
      const exportSolids =
        angular === null
          ? scaled
          : this.angularExportSolids(
              kernel,
              io,
              scaled,
              unitDeflection,
              angular
            );
      if (exportSolids.length === 1) {
        return decodeText(
          io.exportStlAscii(
            kernel.serializeSolids(new Uint32Array(exportSolids)),
            unitDeflection
          )
        );
      }
      // Several consumers stop at the first `solid` block, so a multi-body
      // export must be one block containing every body's facets.
      const meshes = exportSolids.map((solid, index) => {
        const mesh = kernel.tessellateSolidGroupedBinary(solid, unitDeflection);
        try {
          return {
            name: `body_${index + 1}`,
            vertices: Array.from(mesh.positions),
            indices: Array.from(mesh.indices)
          };
        } finally {
          mesh.free();
        }
      });
      return writeAsciiStl(document.name, meshes);
    });
  }

  async exportMesh(
    document: ProjectDocument,
    bodyIds: BodyId[],
    options: {
      format: MeshExportFormat;
      deflection: number;
    } & MeshExportTolerances
  ): Promise<Uint8Array<ArrayBuffer>> {
    const { format, deflection } = options;
    if (!Number.isFinite(deflection) || deflection <= 0) {
      throw new Error('Mesh export deflection must be a positive number.');
    }
    // glTF defines metres, which the root node states over a millimetre
    // tessellation (glb-scene.ts); no other unit can be written into it.
    const units = format === 'glb' ? 'mm' : (options.units ?? 'mm');
    const angular = explicitAngularTolerance(options.angularTolerance);
    if (format === 'stl-ascii') {
      return new TextEncoder().encode(
        await this.exportStl(document, bodyIds, deflection, {
          units,
          ...(angular === null ? {} : { angularTolerance: angular })
        })
      );
    }
    const unitDeflection = deflection / millimetresPerUnit(units);
    const io = await loadRemusTranslators();
    return this.withExportBuild(document, (kernel, build) => {
      const meshes =
        format === 'stl-binary'
          ? this.referenceExportMeshes(
              kernel,
              build,
              document,
              bodyIds,
              units,
              unitDeflection,
              angular
            )
          : null;
      if (meshes && format === 'stl-binary') return writeBinaryStl(meshes);
      const scaled = this.exportSolidsFor(
        kernel,
        build,
        document,
        bodyIds,
        units
      );
      const exportSolids =
        angular === null
          ? scaled
          : this.angularExportSolids(
              kernel,
              io,
              scaled,
              unitDeflection,
              angular
            );
      const bodies = kernel.serializeSolids(new Uint32Array(exportSolids));
      // Every writer takes the whole arena document: bodies stay distinct
      // objects in the 3MF package and merge into one facet stream for the
      // mesh formats — the shapes their consumers expect. wasm-bindgen
      // copies the Vec<u8> into a fresh, never-shared buffer, so the
      // narrowing holds.
      const bytes =
        format === '3mf'
          ? io.export3mf(bodies, unitDeflection)
          : format === 'obj'
            ? io.exportObj(bodies, unitDeflection)
            : format === 'glb'
              ? io.exportGlb(bodies, unitDeflection)
              : format === 'ply'
                ? io.exportPly(bodies, unitDeflection)
                : io.exportStl(bodies, unitDeflection);
      // glTF is metres and +Y up; the tessellation is model millimetres,
      // +Z up, which the GLB states through its root node (glb-scene.ts).
      return format === '3mf'
        ? sanitizeThreeMf(bytes, (model) =>
            declareThreeMfUnit(sanitizeThreeMfModel(model), units)
          )
        : format === 'stl-binary'
          ? sanitizeBinaryStl(bytes)
          : format === 'ply'
            ? sanitizeBinaryPly(bytes)
            : format === 'glb'
              ? orientGlbForGltf(bytes)
              : (bytes as Uint8Array<ArrayBuffer>);
    });
  }

  drawingTessellation(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<Record<BodyId, DrawingBodyTessellation>> {
    // Projection reads geometry, not boolean evolution metadata. Match the
    // idle viewport's demand so opening Draw does not upgrade its build to
    // eager probes (and replay an expensive imported model).
    return this.withExportBuild(
      document,
      (kernel, build) => {
        const hidden = getParameterHiddenBodyIds(document);
        const result: Record<BodyId, DrawingBodyTessellation> = {};
        // One budget for the whole request: many modest bodies add up too.
        const budget = { remainingBytes: MAX_DRAWING_TESSELLATION_BYTES };
        for (const bodyId of bodyIds) {
          const shape = build.shapes.get(bodyId);
          if (!shape || hidden.has(bodyId) || build.consumed.has(bodyId))
            throw new Error(`Body ${bodyId} has no exact geometry to draw.`);
          result[bodyId] = drawingTessellationOfShape(kernel, shape, budget);
        }
        return result;
      },
      []
    );
  }

  drawingSection(
    document: ProjectDocument,
    bodyIds: BodyId[],
    plane: DrawingSectionPlane
  ): Promise<Record<BodyId, DrawingSectionBody>> {
    return this.withExportBuild(
      document,
      (kernel, build) => {
        const hidden = getParameterHiddenBodyIds(document);
        const result: Record<BodyId, DrawingSectionBody> = {};
        const budget = { remainingBytes: MAX_DRAWING_TESSELLATION_BYTES };
        let cut = false;
        for (const bodyId of bodyIds) {
          const shape = build.shapes.get(bodyId);
          if (!shape || hidden.has(bodyId) || build.consumed.has(bodyId))
            throw new Error(`Body ${bodyId} has no exact geometry to draw.`);
          const body = drawingSectionOfShape(kernel, shape, plane, budget);
          if (body?.cut) cut = true;
          result[bodyId] = body
            ? {
                vertices: body.vertices,
                indices: body.indices,
                faces: body.faces,
                edges: body.edges,
                cutFaces: body.cutFaces,
                edgeTopology: body.edgeTopology,
                ...(body.approximate ? { approximate: body.approximate } : {})
              }
            : {
                vertices: new Float32Array(),
                indices: new Uint32Array(),
                faces: [],
                edges: [],
                cutFaces: [],
                edgeTopology: []
              };
        }
        if (!cut)
          throw new DrawingSectionError(
            'The section line does not cut any body in this view.'
          );
        return result;
      },
      []
    );
  }

  async meshQuality(
    document: ProjectDocument,
    bodyIds: BodyId[],
    deflection: number,
    tolerances: MeshExportTolerances = {}
  ): Promise<MeshQualityReport> {
    if (!Number.isFinite(deflection) || deflection <= 0) {
      throw new Error('Mesh quality deflection must be a positive number.');
    }
    const angular = explicitAngularTolerance(tolerances.angularTolerance);
    const units = tolerances.units ?? 'mm';
    // The writers' space: the export unit, at the deflection that is
    // `deflection` millimetres there.
    const unitMm = millimetresPerUnit(units);
    const unitDeflection = deflection / unitMm;
    return this.withExportBuild(document, (kernel, build) => {
      const exportScale = exportLengthScale(document.units, units);
      const bodies: BodyMeshQuality[] = bodyIds.map((bodyId) => {
        const shape = build.shapes.get(bodyId);
        if (!shape) {
          throw new Error(`Body ${bodyId} has no exact geometry.`);
        }
        let boundaryEdges = 0;
        let nonManifoldEdges = 0;
        let triangleCount = 0;
        let maxDeviation = 0;
        let sampledTriangles = 0;
        let totalTriangles = 0;
        // A body with no solids has nothing to print, which is a failed
        // check, not a vacuous pass.
        let watertight = shape.solids.length > 0;
        for (const solid of shape.solids) {
          // Checked in the same space the export tessellates (scaled into
          // the export unit before the float32 quantization the file
          // stores), so the verdict describes the file about to be written.
          const measured =
            exportScale === 1
              ? solid
              : kernel.copyAndTransformSolid(
                  solid,
                  uniformScaleMatrix(exportScale)
                );
          const quality = readMeshQuality(
            kernel.meshQuality(measured, unitDeflection, angular)
          );
          boundaryEdges += quality.boundaryEdges;
          nonManifoldEdges += quality.nonManifoldEdges;
          watertight &&= quality.isWatertight;
          // The same tessellation, grouped by face, measured against the
          // exact faces: what the tolerance promises, checked rather than
          // assumed.
          const grouped = kernel.tessellateSolidGroupedBinary(
            measured,
            unitDeflection,
            angular
          );
          try {
            const deviation = measureMeshDeviation({
              positions: grouped.positions,
              indices: grouped.indices,
              faceOffsets: grouped.faceOffsets,
              faces: kernel.getSolidFaces(measured),
              isPlanar: (face) => kernel.getSurfaceType(face) === 'plane',
              distance: (x, y, z, face) =>
                kernel.pointToFaceDistance(x, y, z, face)[0] ?? 0
            });
            // Counted the way the sanitizers filter the written file (zero
            // area at float32, the precision STL and PLY store), not the
            // kernel's welded count, which drops a different set.
            triangleCount += countExportedTriangles(
              grouped.positions,
              grouped.indices
            );
            maxDeviation = Math.max(
              maxDeviation,
              deviation.maxDeviation * unitMm
            );
            sampledTriangles += deviation.sampledTriangles;
            totalTriangles += deviation.totalTriangles;
          } finally {
            grouped.free();
          }
        }
        return {
          bodyId,
          boundaryEdges,
          nonManifoldEdges,
          watertight,
          triangleCount,
          maxDeviation,
          sampledTriangles,
          totalTriangles
        };
      });
      return {
        watertight:
          bodies.length > 0 && bodies.every((body) => body.watertight),
        bodies,
        triangleCount: bodies.reduce(
          (sum, body) => sum + body.triangleCount,
          0
        ),
        maxDeviation: Math.max(0, ...bodies.map((body) => body.maxDeviation)),
        sampled: bodies.some(
          (body) => body.sampledTriangles < body.totalTriangles
        )
      };
    });
  }

  // Synchronous under the hood, but async like every adapter method so the
  // worker boundary and a future off-thread solver need no signature change.
  async solveSketch(
    document: ProjectDocument,
    sketchId: SketchId,
    options: { anchor?: SketchSolveAnchor } = {}
  ): Promise<SketchSolveOutcome> {
    const sketch = findSketch(document, sketchId);
    if (!sketch) {
      throw new Error(`Sketch ${sketchId} not found.`);
    }
    const { solveDocumentSketchWithGcs } =
      await import('./gcs-sketch-document');
    const kernel = new RemusKernel();
    try {
      return solveDocumentSketchWithGcs(kernel, document, sketch, options);
    } finally {
      kernel.free();
    }
  }

  /**
   * One planar sketch edit. Synchronous under the hood like `solveSketch`,
   * and async for the same reason: the worker boundary.
   */
  async sketchPlanarOperation(
    operation: SketchPlanarOperation
  ): Promise<SketchPlanarResult> {
    const kernel = new RemusKernel();
    try {
      return runSketchPlanarOperation(kernel, operation);
    } finally {
      kernel.free();
    }
  }

  /**
   * The pre-import probe the app shows before a user commits to an import.
   *
   * K0.6 makes it answer in every case rather than raising in some of them:
   * the caller is asking "should I offer this import at all", and a thrown
   * parse error is a worse SHAPE of answer than `{solid: false}` even when its
   * text is better. The text is not lost — it comes back as `reason`.
   *
   * `solid` and `volume` count only shells the importer would actually accept,
   * so a file whose only shell is open reports no solid and no volume instead
   * of the divergence integral over the faces it happens to have.
   */
  async inspectStep(data: string | ArrayBuffer): Promise<{
    solid: boolean;
    valid: boolean;
    volume: number;
    /** Accepted indices in the original kernel import order, before rejection filtering. */
    solidIndices: number[];
    reason?: string;
  }> {
    await loadRemusTranslators();
    const kernel = new RemusKernel();
    try {
      const bytes =
        typeof data === 'string'
          ? new TextEncoder().encode(data)
          : new Uint8Array(data);
      let declared: number[];
      let report: StepImportReport;
      try {
        const imported = importStepWithOwnBudget(kernel, bytes);
        declared = Array.from(imported.solids);
        report = imported.report;
      } catch (error) {
        return {
          solid: false,
          valid: false,
          volume: 0,
          solidIndices: [],
          reason: error instanceof Error ? error.message : String(error)
        };
      }
      const verdicts = declared.map((solid, index) =>
        classifyImportedSolid(diagnoseImportedSolid(kernel, solid, index + 1))
      );
      const accepted = declared.filter(
        (_, index) => verdicts[index]!.kind !== 'not-a-solid'
      );
      const rejections = verdicts.flatMap((verdict) =>
        verdict.kind === 'not-a-solid' ? [verdict.reason] : []
      );
      return {
        solid: accepted.length > 0,
        solidIndices: declared.flatMap((_, index) =>
          verdicts[index]!.kind !== 'not-a-solid' ? [index] : []
        ),
        valid:
          declared.length > 0 &&
          verdicts.every((verdict) => verdict.kind === 'solid'),
        volume: accepted.reduce(
          (total, solid) =>
            total + kernel.volume(solid, MEASUREMENT_DEFLECTION),
          0
        ),
        ...(declared.length === 0
          ? { reason: stepImportEmptyReason(report) }
          : accepted.length === 0
            ? { reason: importedStepNoSolidError(rejections) }
            : rejections.length > 0
              ? {
                  reason: importedStepRejectedSolidSummary(
                    rejections,
                    declared.length
                  )
                }
              : {})
      };
    } finally {
      kernel.free();
    }
  }

  releaseEditPreview(): void {
    this.liveSession = null;
    this.coarseFaceMoveFrame = false;
    this.draftDisplaySource = null;
    const kernel = this.historyKernel;
    if (!kernel) return;
    if (hasPreparedGroupEdit(kernel)) {
      const source = this.historyCheckpoints.at(-1);
      try {
        if (source) kernel.restore(source.checkpointId);
      } catch {
        this.invalidateHistoryCache();
        return;
      }
    }
    releasePreparedGroupEdit(kernel);
    releasePreparedFaceMove(kernel);
  }

  dispose(): void {
    this.historyGeneration += 1;
    this.clearCurrentMassSnapshot();
    // An active generator still owns its kernel and cancellation token.
    // Cancel it now and release retained state in its ownership finally;
    // queued work from this lifetime must never recreate that state.
    if (!this.historyCancellation) this.clearRetainedState();
  }

  private clearRetainedState(): void {
    // Export and solve methods own short-lived kernels, but the history
    // kernel and its checkpoints are adapter-scoped and must be released.
    this.invalidateHistoryCache();
    this.importedSteps.clear();
    this.edgeSelections.clear();
    this.meshPayloads.clear();
    this.heldDisplayDeflections.clear();
  }

  /**
   * On-demand per-face recognition over the long-lived history kernel.
   *
   * The document is rebuilt through the same history-cache path as a sync —
   * a prefix restore after the first call, not a throwaway parse — so the
   * query resolves against the exact geometry the Inspector is showing. The
   * seed face resolves by hash plus optional v5 reference, exactly like a
   * direct-edit commit; any resolution miss answers `seed-face-missing`
   * rather than throwing, because a stale pick is a display state, not a
   * build failure. Dimensions are published as measured: the rebuilt solid
   * is already in document units, exactly as the measure pass publishes its
   * `recognizedImportedFeatures`. The refusal reason travels verbatim.
   */
  async recognizeImportedFace(
    input: Parameters<ExactKernelAdapter['recognizeImportedFace']>[0]
  ): Promise<FaceRecognitionSummary> {
    return this.runHistoryJob(() => this.recognizeImportedFaceInHistory(input));
  }

  private async recognizeImportedFaceInHistory(
    input: Parameters<ExactKernelAdapter['recognizeImportedFace']>[0]
  ): Promise<FaceRecognitionSummary> {
    const missing = (message: string): FaceRecognitionSummary => ({
      kind: 'unsupported',
      refusalReason: 'seed-face-missing',
      message
    });
    const { sources, pinned } = await this.prefetchImportSources(
      input.document
    );
    if (documentNeedsTranslators(input.document)) {
      await loadRemusTranslators();
    }
    let kernel: RemusKernel;
    let build: ExactBuildResult;
    try {
      ({ kernel, build } = await this.buildWithHistoryCache(
        input.document,
        sources,
        pinned
      ));
    } catch (error) {
      return missing(
        error instanceof Error
          ? error.message
          : 'The imported body could not be rebuilt for recognition.'
      );
    }
    try {
      const shape = build.shapes.get(input.bodyId);
      if (!shape) {
        return missing('The selected body has no exact geometry.');
      }
      const solid = collapseShape(kernel, shape);
      let face: number;
      try {
        face = resolveDirectEditFace(kernel, shape, solid, {
          faceHash: input.faceHash,
          faceReference: input.faceReference
        }).face;
      } catch {
        return missing('The selected face is no longer on the rebuilt body.');
      }
      const outcome = recognizeImportedFeatureOnSolid(kernel, solid, face);
      if (outcome.status !== 'recognized') {
        return {
          kind: 'unsupported',
          refusalReason: outcome.reason,
          message: recognitionRefusalMessage(outcome.reason)
        };
      }
      // Already document units: the import adopted the solid at
      // 1/UNIT_TO_MM, so scaling again shrank an inch document's 5 mm bore
      // to 0.0078 in, disagreeing with the measure pass by 25.4×.
      const dimensions = importedProofDisplayDimensions(outcome.proof);
      const proofKind = outcome.proof.kind;
      const kindLabel =
        proofKind === 'blind-cylindrical-hole'
          ? 'Blind hole'
          : proofKind === 'counterbore'
            ? 'Counterbore'
            : proofKind === 'countersink'
              ? 'Countersink'
              : proofKind === 'cylindrical-boss'
                ? 'Boss'
                : proofKind === 'prismatic-pocket'
                  ? 'Pocket'
                  : 'Taper';
      return {
        kind: 'recognized',
        featureKind: proofKind,
        message: `${kindLabel} recognized from the imported STEP body.`,
        dimensions
      };
    } finally {
      const last = this.historyCheckpoints.length - 1;
      if (last >= 0) {
        try {
          this.clearCurrentMassSnapshot();
          kernel!.restore(this.historyCheckpoints[last]!.checkpointId);
          this.primitiveBuildCache.restoredThrough(
            this.historyCheckpoints[last]!.featureIndex
          );
        } catch {
          this.invalidateHistoryCache();
        }
      } else {
        this.invalidateHistoryCache();
      }
    }
  }
}

/** Features whose builders parse a file through the translator module. */
function documentNeedsTranslators(document: ProjectDocument): boolean {
  return listNodesByKind(document, 'feature').some(
    (feature) =>
      feature.featureKind === 'imported-step' ||
      (feature.data.featureKind === 'imported-mesh' &&
        feature.data.triangleCount <= MAX_MESH_SOLID_CONVERSION_TRIANGLES)
  );
}

export async function createExactKernelAdapter(
  options: ExactKernelAdapterOptions = {}
): Promise<ExactKernelAdapter> {
  return new RemusKernelAdapter(options);
}

/**
 * The released edit a complete sync may draw with a draft display mesh: a
 * face move or cylinder resize, identified by the history before it (feature
 * ids of a candidate edit are regenerated per pointer frame) and its body.
 * A body a union produced is excluded: its strict closure check reads the
 * display mesh, so it is always meshed at full quality.
 */
function draftDisplayCandidate(
  document: ProjectDocument
): { source: string; bodyId: BodyId } | null {
  const terminal = listFeaturesInOrder(document).at(-1);
  const data = terminal?.data;
  if (
    !terminal ||
    isFeatureSuppressed(terminal) ||
    data?.featureKind !== 'direct-edit' ||
    (data.operation.kind !== 'offset-face' &&
      data.operation.kind !== 'resize-cylindrical-face')
  )
    return null;
  const body = listNodesByKind(document, 'body').find(
    (candidate) => candidate.bodyId === data.targetBodyId
  );
  const producer = body
    ? listNodesByKind(document, 'feature').find(
        (feature) => feature.featureId === body.featureId
      )
    : undefined;
  if (
    !body ||
    (producer?.data.featureKind === 'boolean' &&
      producer.data.operation === 'union' &&
      !isFeatureSuppressed(producer))
  )
    return null;
  return {
    source: document.featureOrder.slice(0, -1).join(','),
    bodyId: data.targetBodyId
  };
}
