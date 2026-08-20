import { RemusKernel, type FaceEvolutionPayloadV1 } from './remus-runtime';
import {
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  listNodesByKind,
  resolveParamValue
} from '@openzcad/document-core';
import {
  frameForPlaneRef,
  geometryTolerance,
  mergeAdjacentProfiles,
  type PlaneBasis,
  type SketchRegion,
  type Vec2Like,
  type Vec3
} from '@openzcad/geometry';
import { writeAsciiStl } from '@openzcad/io-stl';
import {
  BODY_OPACITY_METADATA_KEY,
  DEFAULT_BODY_COLOR,
  FULL_REVOLVE_ANGLE_DEG,
  MAX_HELICAL_SWEEP_TURNS,
  UNIT_TO_MM,
  featureColor,
  isFeatureSuppressed,
  nowIso,
  type ArtifactId,
  type BodyId,
  type BodyRepresentation,
  type BodyTopology,
  type DerivedState,
  type DirectEditOperation,
  type FaceGeometry,
  type FeatureId,
  type FeatureNode,
  type ImportedSourceReference,
  type ProjectDocument,
  type SketchId,
  type ParamValue,
  type SketchNode,
  type SketchObjectData,
  type SketchPathReference,
  type SketchSectionReference
} from '@openzcad/shared';
import type {
  ExactBuildResult,
  ExactShape,
  ImportedStepDiagnostics,
  MeasuredShape
} from './exact-types';
import {
  addFaceCarrierRole,
  buildExtrudeLineage,
  buildPrimitiveLineage,
  buildRevolveLineage,
  diagnoseImportedSolid,
  modifierChainRootsAtCylinder,
  planeCarrier,
  rederiveCylinderModifierLineage,
  rederivePrimitiveDirectEditLineage,
  topologyCandidatesForSolid
} from './exact-lineage-builders';
import {
  blendCarrierSnapshot,
  classifyThroughHoleFace,
  measureFaceGeometry,
  measureOwnedFaceGeometry,
  requireThroughHole
} from './exact-measure';
import {
  coaxialCylinderRadii,
  cylinderAlongAxis,
  drillHole,
  fillThroughHole,
  tryExactAnalyticCylinderCapOffset,
  tryExactCoaxialCylinderCut
} from './exact-cylinder-ops';
import {
  applyEdgeModifier,
  edgeModifierFailureMessage
} from './exact-edge-modifiers';
import {
  collapseShape,
  exactUnionOffsetSuggestion,
  fuseUniformSolid,
  inferenceBodyForShape,
  isFaceConnectedSolid,
  sharedShapeVolume,
  sharedSolidVolume,
  solidMeshIsClosed,
  tessellatedFaceBounds,
  unifyBooleanFaces,
  type UnionFuseOperand
} from './exact-boolean-helpers';
import {
  resolveEdgeModifierEdges,
  resolveFeatureFaces
} from './exact-reference-resolution';
import {
  bodyName,
  bodyOpacityFromMetadata,
  copyShape,
  copyShapeWithVerifiedLineage,
  decodeText,
  faceAttachmentCandidatesForShape,
  formatMeasuredVolume,
  importMeshSolid,
  importStepWithOwnBudget,
  inheritMeshOrigin,
  projectRemusLineageDiagnostic,
  resolveParametricPoint,
  validateGeneratedSolid
} from './exact-shape-utils';
import { assertDirectEditOperation } from './exact-direct-edit-guards';
import {
  MEASUREMENT_DEFLECTION,
  edgeWitnessOf,
  faceHandlesByFingerprint,
  faceWitnessOf
} from './exact-witnesses';
import {
  brepAdjacentFaceHashes,
  brepEdgeCurve,
  brepEdgeDisplayRole,
  brepVertexIds,
  isBlendFace
} from './exact-brep';
export { brepEdgeCurve, edgeCircleMisfit } from './exact-brep';
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
import {
  DIRECT_EDIT_TOLERANCE,
  GEOMETRY_EPSILON,
  axisDirection,
  cross,
  dot,
  length,
  normalized,
  pointOnPlane,
  profilePoints,
  resolvePatternDirection,
  shiftBasisAlongNormal,
  subtract,
  transformMatrix,
  uniformScaleMatrix
} from './exact-math';
import { displayTessellationForExtents } from './display-tessellation';
import {
  MAX_HISTORY_CHECKPOINTS,
  cloneBuildState,
  historyFeatureDigest,
  historyScopeDigest,
  measuredShapeBytes,
  type HistoryCheckpointEntry,
  type MeasuredBodyCacheEntry,
  type RebuildCacheEvent
} from './exact-history-cache';
export type { RebuildCacheEvent };
import { readBodyMassProperties } from './body-properties';
import {
  booleanFacetFallbackWarning,
  censusOfSolids,
  directEditFacetFallbackWarning,
  droppedUnionOperandWarning,
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from './boolean-result-validation';
import { importedMeshStl, meshBooleanUnsupportedError } from './imported-mesh';
import { connectedRegionGroups, resolveRegionProfiles } from './region-profile';
import {
  extrudeVolumeTolerance,
  type ExtrudeInferenceBody
} from './extrude-inference';
import {
  basisMatchesLiftedFrame,
  bezierFallbackWarning,
  bezierNurbsParams,
  bezierProfileEdgesEnabled,
  flattenBezierCurve,
  flattenedOutlineWarning
} from './profile-bezier-edges';
import { createRemusModelingOperations } from './remus-modeling-operations';
import {
  analyzeUnionConnectivity,
  disconnectedUnionWarning
} from './union-connectivity';
import {
  ambiguousReferenceError,
  unresolvedReferenceError
} from './topology-fingerprint';
import {
  remusHashOnlyLineage,
  createRemusImportedStepLineage,
  createRemusModifierEvolutionLineage,
  createRemusSemanticLineage,
  mergeRemusLineageStates,
  type RemusLineageState,
  type RemusSemanticAssignment
} from './remus-lineage';
import {
  resolveTopologyReference,
  topologyHashOfWitness,
  topologyWitnessesEqual,
  type TopologyResolutionCandidate
} from './topology-lineage';
import {
  resolveFaceAttachment
} from './face-attachment';
import {
  solveSketchWithGcs,
  type ResolvedSketchObject,
  type SketchSolveOutcome
} from './gcs-sketch';

export type {
  SketchDofSummary,
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

const STL_EXPORT_DEFLECTION = 0.08;
/**
 * A confirmed subtract must remove a material share of the volume its tools
 * demonstrably overlap. The deliberately loose half-overlap floor preserves
 * sequential multi-tool cuts, where earlier tools can remove material a later
 * tool would otherwise share, while rejecting the near-no-op results this
 * guard exists to catch.
 */
const MINIMUM_SUBTRACT_REMOVAL_RATIO = 0.5;

const CURVE_SEGMENTS = 32;
/** `liftCurve2dToPlane` curve types: 0 line, 1 circle, 2 ellipse, 3 NURBS. */
const NURBS_CURVE_TYPE = 3;

/**
 * Resolve a revolve's sweep angle and enforce the kernel's `(0, 360]` domain
 * here rather than letting the WASM boundary throw. The kernel's own refusal
 * is a generic operation failure naming no parameter; a rebuild warning has
 * to say which field is out of range and what the range is.
 *
 * An absent field means a full turn, so a document written before partial
 * revolve existed resolves to exactly 360 and rebuilds unchanged.
 */
/**
 * Why a partial revolve of a non-circular profile publishes no ADR-013
 * semantic names, spelled out here so a reader finds a decision rather than an
 * unexplained empty reference set.
 *
 * Two independent breaks, both measured (docs/kernel-execution-plan.md, "Z7
 * Feature exposure"), neither of them a kernel defect — the solid itself is
 * one closed shell with `validateSolid` 0, correct caps, watertight
 * tessellation and an exact volume at every angle:
 *
 * 1. `buildRevolveLineage` names each profile vertex's swept edge with
 *    `expectedCircleWitness`, which is `closed: true` with `length: 2*pi*r`.
 *    Below a full turn those edges are ARCS — an `EdgeWitnessV1` variant that
 *    witness can never equal — so every profile-vertex edge role fails.
 * 2. Remus splits a swept face at each 90 degree boundary, and the pieces
 *    carry duplicate analytic parameters, so the exactly-one-match rule in
 *    `addUniqueSemanticAssignment` goes ambiguous above 90 degrees.
 *
 * Shipping the angle with ADR-011 hash-only references is the deliberate
 * call: hashes still resolve a wedge's faces and edges for selection and for
 * downstream features, they simply do not survive a topology-changing edit
 * the way a named role does. Reversing this needs an arc-capable edge witness
 * and a piece-aware face role, not a change here.
 */
const PARTIAL_REVOLVE_HASH_ONLY_REASON =
  'A revolve below 360 degrees publishes hash-only references by design: its swept edges are arcs rather than the closed circles ADR-013 profile-vertex roles witness, and Remus splits its swept faces at 90 degree boundaries into pieces with duplicate analytic parameters.';

/**
 * A revolve keeps ADR-013 semantic lineage for a full turn, and for a
 * circular profile at any angle.
 *
 * The circular exemption is not a special case bolted on. A circle's revolve
 * role is the single torus surface, named by surface type rather than by an
 * analytic carrier, and a torus does not quadrant-split: a partial revolve of
 * a circle measures three faces (torus plus two caps) at every angle below
 * 360 and one at 360, so the role stays unique. That branch also publishes no
 * profile-vertex edge roles, so neither break above applies to it.
 */
function revolveKeepsSemanticLineage(
  angleDeg: number,
  data: SketchObjectData
): boolean {
  return angleDeg >= FULL_REVOLVE_ANGLE_DEG || data.objectKind === 'circle';
}

function resolveRevolveAngleDeg(
  angleDeg: ParamValue | undefined,
  scope: Record<string, number>
): number {
  if (angleDeg === undefined) {
    return FULL_REVOLVE_ANGLE_DEG;
  }
  const resolved = resolveParamValue(angleDeg, scope, 'angle');
  if (!(resolved > 0) || resolved > FULL_REVOLVE_ANGLE_DEG) {
    throw new Error(
      `Revolve angle must be greater than 0 and at most ${FULL_REVOLVE_ANGLE_DEG} degrees.`
    );
  }
  return resolved;
}

export interface ExactKernelAdapter {
  readonly kind: 'remus';
  syncDocument(document: ProjectDocument): Promise<DerivedState>;
  exportStep(document: ProjectDocument, bodyIds: BodyId[]): Promise<string>;
  exportStl(
    document: ProjectDocument,
    bodyIds: BodyId[],
    deflection?: number
  ): Promise<string>;
  /**
   * Tessellated mesh export at a caller-chosen deflection (millimetres,
   * applied after unit scaling — the same space every slicer works in).
   */
  exportMesh(
    document: ProjectDocument,
    bodyIds: BodyId[],
    options: { format: MeshExportFormat; deflection: number }
  ): Promise<Uint8Array<ArrayBuffer>>;
  /**
   * Pre-export printability check: tessellates each body at the given
   * deflection and reports welded-mesh watertightness per body.
   */
  meshQuality(
    document: ProjectDocument,
    bodyIds: BodyId[],
    deflection: number
  ): Promise<MeshQualityReport>;
  /**
   * Solves one sketch's persisted constraints with the kernel's GCS and
   * returns the solved geometry plus classification, DOF, and per-constraint
   * residuals. Read-only: writing solved positions back into the document is
   * the caller's command to make.
   */
  solveSketch(
    document: ProjectDocument,
    sketchId: SketchId
  ): Promise<SketchSolveOutcome>;
  inspectStep(data: string | ArrayBuffer): Promise<{
    solid: boolean;
    valid: boolean;
    volume: number;
    /**
     * Why the probe answered as it did, when there is something to say. K0.6:
     * the probe never raises, so a parse error or a rejected open shell has to
     * come back through the value.
     */
    reason?: string;
  }>;
  dispose(): void;
}

/**
 * A parsed STEP import held for reuse: the kernel's serialised solids plus the
 * diagnostics the parse produced, so a cache hit reports exactly what the
 * original parse reported rather than a silently emptier set.
 */
interface CachedImportedStep {
  solids: Uint8Array[];
  diagnostics: ImportedStepDiagnostics;
}

/**
 * Ceiling on retained import geometry. Serialised solids run well under half
 * the STEP text they came from, so this holds a couple of very large imports —
 * enough for the documents that motivated the cache — while staying bounded,
 * unlike the WASM heap that repeated parsing grows and never returns.
 *
 * It is a ceiling on what is retained for documents that are NOT being rebuilt.
 * The imports the build in progress needs are pinned and exempt: dropping one
 * mid-sequence would re-read and re-parse a source the same build already
 * parsed, which is the cost the cache exists to remove.
 */
export const MAX_IMPORTED_STEP_CACHE_BYTES = 64 * 1024 * 1024;

export interface ExactKernelAdapterOptions {
  /**
   * Produces the raw source bytes for a reference-form import. Absent means
   * only legacy embedded imports can rebuild — a reference then fails with an
   * explicit error instead of silently dropping the body.
   */
  resolveSourceBytes?: (
    ref: ImportedSourceReference,
    context: { artifactId: ArtifactId; sourceName: string }
  ) => Promise<Uint8Array>;
  /**
   * Overrides {@link MAX_IMPORTED_STEP_CACHE_BYTES}. A test pins the parse-once
   * contract at a budget a corpus file can actually exceed; nothing in the app
   * sets it.
   */
  importedStepCacheBytes?: number;
  /**
   * Overrides {@link MAX_HISTORY_CHECKPOINTS}. Tests pin the over-limit
   * bypass without building a 33-feature document; nothing in the app sets
   * it.
   */
  historyCheckpointLimit?: number;
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
}

/**
 * Budget for retained per-body measurements. The cache holds at most one
 * entry per live body, so this only bites on huge documents; eviction drops
 * the oldest entries, which then simply re-measure on their next sync.
 */
const MAX_MEASURED_SHAPE_CACHE_BYTES = 128 * 1024 * 1024;

export class RemusKernelAdapter implements ExactKernelAdapter {
  readonly kind = 'remus' as const;

  constructor(private readonly options: ExactKernelAdapterOptions = {}) {}

  /**
   * Imported STEP results, keyed by the source checksum that fully determines
   * them. An import's geometry depends on nothing else in the document, so a
   * hit is exact by construction — the checksum names the bytes.
   *
   * Entries hold the kernel's own serialised solids, which restore without
   * re-derivation or tolerance normalisation. That matters twice over: a
   * rebuild skips parsing the STEP text, and skips reading the source at all,
   * so editing a document that carries a few-hundred-megabyte import no longer
   * re-reads and re-parses it on every keystroke.
   */
  private readonly importedStepCache = new Map<string, CachedImportedStep>();
  private importedStepCacheBytes = 0;

  private get maxImportedStepCacheBytes(): number {
    return this.options.importedStepCacheBytes ?? MAX_IMPORTED_STEP_CACHE_BYTES;
  }

  /**
   * The long-lived history kernel and its per-feature checkpoint table. Owned
   * exclusively by {@link syncDocument}; every other method keeps its own
   * throwaway kernel. Invariant: `historyCheckpoints[i].checkpointId === i`,
   * because checkpoints are taken in feature order and `restore(k)` truncates
   * the kernel's stack to `k + 1` while the table is sliced in lockstep.
   */
  private historyKernel: RemusKernel | null = null;
  private historyCheckpoints: HistoryCheckpointEntry[] = [];
  private historyScopeKey: string | null = null;

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

  private get maxHistoryCheckpoints(): number {
    return this.options.historyCheckpointLimit ?? MAX_HISTORY_CHECKPOINTS;
  }

  private get maxMeasuredShapeCacheBytes(): number {
    return (
      this.options.measuredShapeCacheBytes ?? MAX_MEASURED_SHAPE_CACHE_BYTES
    );
  }

  private invalidateHistoryCache(): void {
    this.historyCheckpoints = [];
    this.historyScopeKey = null;
    this.measuredShapeCache.clear();
    this.measuredShapeCacheBytes = 0;
    if (this.historyKernel) {
      this.historyKernel.free();
      this.historyKernel = null;
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
    if (entry.bytes > this.maxMeasuredShapeCacheBytes) {
      return;
    }
    this.measuredShapeCache.set(bodyId, entry);
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
   * scope changed, no prefix matches, the document is over the checkpoint
   * cap, or a kernel restore fails.
   */
  private buildWithHistoryCache(
    document: ProjectDocument,
    importSources: ReadonlyMap<string, Uint8Array>,
    pinnedImports: ReadonlySet<string>
  ): {
    kernel: RemusKernel;
    build: ExactBuildResult;
    replayed: number;
    restored: number;
  } {
    const features = listFeaturesInOrder(document);
    const cachingEnabled = features.length <= this.maxHistoryCheckpoints;
    const scopeKey = cachingEnabled ? historyScopeDigest(document) : null;
    const digests = cachingEnabled
      ? features.map((feature, index) =>
          historyFeatureDigest(document, feature, index)
        )
      : [];

    let kernel = this.historyKernel;
    let startIndex = 0;
    let initial: ExactBuildResult | null = null;

    if (
      kernel &&
      cachingEnabled &&
      this.historyScopeKey !== null &&
      this.historyScopeKey === scopeKey
    ) {
      let prefix = -1;
      const limit = Math.min(this.historyCheckpoints.length, digests.length);
      for (let index = 0; index < limit; index += 1) {
        if (this.historyCheckpoints[index]!.digest !== digests[index]) {
          break;
        }
        prefix = index;
      }
      if (prefix >= 0) {
        try {
          kernel.restore(this.historyCheckpoints[prefix]!.checkpointId);
          this.historyCheckpoints = this.historyCheckpoints.slice(
            0,
            prefix + 1
          );
          startIndex = prefix + 1;
          // Two copies deep: the snapshot must survive this replay's in-place
          // mutation, and the replay must not share containers with it.
          initial = cloneBuildState(this.historyCheckpoints[prefix]!.snapshot);
        } catch {
          this.invalidateHistoryCache();
          kernel = null;
        }
      } else {
        this.invalidateHistoryCache();
        kernel = null;
      }
    } else {
      this.invalidateHistoryCache();
      kernel = null;
    }

    if (!kernel) {
      kernel = new RemusKernel();
      this.historyKernel = kernel;
      this.historyScopeKey = scopeKey;
    }
    const activeKernel = kernel;

    const onFeature = cachingEnabled
      ? (index: number, result: ExactBuildResult) => {
          const checkpointId = activeKernel.checkpoint();
          this.historyCheckpoints.push({
            digest: digests[index]!,
            checkpointId,
            snapshot: cloneBuildState(result)
          });
        }
      : undefined;

    const build = this.build(
      activeKernel,
      document,
      importSources,
      pinnedImports,
      initial ? { startIndex, initial } : undefined,
      onFeature
    );
    // The cache event is emitted by syncDocument AFTER the measure pass, so
    // it can carry the measure-reuse counts alongside the replay counts.
    return {
      kernel: activeKernel,
      build,
      replayed: features.length - startIndex,
      restored: startIndex
    };
  }

  /**
   * Reference-form import sources, fetched before the synchronous rebuild
   * walks the history. Keyed by checksum; a missing key at rebuild time means
   * the local blob store and every fallback failed, which each import case
   * reports per-feature rather than failing the whole document.
   *
   * A checksum already in {@link importedStepCache} is skipped: its bytes
   * would only be parsed into a result the cache already holds, and reading
   * them is the single largest allocation a rebuild makes. That skip is only
   * sound because every checksum walked here is returned as `pinned` and
   * exempt from eviction for the whole build — otherwise a later import in the
   * same document could evict the entry whose bytes were never read.
   */
  private async prefetchImportSources(document: ProjectDocument): Promise<{
    sources: Map<string, Uint8Array>;
    pinned: Set<string>;
  }> {
    const sources = new Map<string, Uint8Array>();
    const pinned = new Set<string>();
    for (const feature of listFeaturesInOrder(document)) {
      if (
        feature.data.featureKind !== 'imported-step' ||
        feature.data.stepText !== undefined ||
        isFeatureSuppressed(feature)
      ) {
        continue;
      }
      const ref = feature.data.stepSourceRef;
      if (!ref || sources.has(ref.checksumSha256)) {
        continue;
      }
      pinned.add(ref.checksumSha256);
      if (this.importedStepCache.has(ref.checksumSha256)) {
        continue;
      }
      if (!this.options.resolveSourceBytes) {
        continue;
      }
      try {
        sources.set(
          ref.checksumSha256,
          await this.options.resolveSourceBytes(ref, {
            artifactId: feature.data.artifactId,
            sourceName: feature.data.sourceName
          })
        );
      } catch {
        // The imported-step case reports the miss with the feature's name.
      }
    }
    return { sources, pinned };
  }

  /**
   * Records a parsed import against its checksum, evicting older entries to
   * stay inside the byte budget. Serialisation failure is not fatal: the
   * rebuild already has its solids, and an uncached import merely costs what
   * it cost before.
   *
   * Two entries are never evicted: the one just stored, and any checksum
   * `pinned` for the build in progress. So an import larger than the whole
   * budget is still cached — refusing it, as this once did, re-parsed exactly
   * the largest files on every rebuild — and it survives until a build of some
   * OTHER document needs the room. Retention is therefore the budget plus what
   * the open document's own imports come to, which is what parsing each of
   * them once costs by definition.
   */
  private storeImportedStep(
    checksum: string,
    kernel: RemusKernel,
    solids: number[],
    diagnostics: ImportedStepDiagnostics,
    pinned: ReadonlySet<string>
  ): void {
    let serialized: Uint8Array[];
    try {
      serialized = solids.map((solid) => kernel.serializeSolid(solid));
    } catch {
      return;
    }
    const bytes = serialized.reduce((sum, blob) => sum + blob.byteLength, 0);
    this.importedStepCache.set(checksum, { solids: serialized, diagnostics });
    this.importedStepCacheBytes += bytes;
    for (const [key, entry] of this.importedStepCache) {
      if (this.importedStepCacheBytes <= this.maxImportedStepCacheBytes) {
        break;
      }
      if (key === checksum || pinned.has(key)) {
        continue;
      }
      this.importedStepCache.delete(key);
      this.importedStepCacheBytes -= entry.solids.reduce(
        (sum, blob) => sum + blob.byteLength,
        0
      );
    }
  }

  private resolveSketchBasisAtHistory(
    kernel: RemusKernel,
    document: ProjectDocument,
    sketch: SketchNode,
    result: ExactBuildResult,
    scope: Record<string, number>
  ): PlaneBasis {
    const planeRef = sketch.planeRef;
    if (planeRef.type !== 'face' || !planeRef.faceReference) {
      if (planeRef.type === 'face') {
        result.warnings.push(
          `Sketch "${sketch.name}": legacy face attachment has no schema-v5 lineage reference; using its stored migration frame.`
        );
      }
      return frameForPlaneRef(planeRef, (value) =>
        resolveParamValue(value, scope, 'sketch offset')
      );
    }

    const sourceShape = result.shapes.get(planeRef.bodyId);
    if (!sourceShape) {
      throw new Error(
        `Sketch "${sketch.name}" cannot attach because source body ${planeRef.bodyId} is unavailable at the sketch's history position.`
      );
    }
    const sourceFeature = listFeaturesInOrder(document).find(
      (candidate) =>
        candidate.featureId === planeRef.faceReference?.producingFeatureId
    );
    const frame = resolveFaceAttachment({
      reference: planeRef.faceReference,
      candidates: faceAttachmentCandidatesForShape(kernel, sourceShape),
      snapshot: {
        sourceArea: planeRef.sourceArea,
        sourceCenter: planeRef.sourceCenter,
        sourceNormal: planeRef.sourceNormal,
        frame: planeRef.frame
      },
      sketchName: sketch.name,
      sourceFeatureName:
        sourceFeature?.name ?? String(planeRef.faceReference.producingFeatureId)
    });
    return {
      origin: frame.origin,
      u: frame.xAxis,
      v: frame.yAxis,
      normal: frame.zAxis
    };
  }

  private makeProfileFace(
    kernel: RemusKernel,
    data: SketchObjectData,
    basis: PlaneBasis,
    offset: number,
    scope: Record<string, number>
  ): number {
    if (data.objectKind === 'circle') {
      const center = pointOnPlane(
        basis,
        {
          x: resolveParamValue(data.centerX, scope, 'center X'),
          y: resolveParamValue(data.centerY, scope, 'center Y')
        },
        offset
      );
      const edge = kernel.makeCircleEdge(
        center.x,
        center.y,
        center.z,
        basis.normal.x,
        basis.normal.y,
        basis.normal.z,
        resolveParamValue(data.radius, scope, 'radius')
      );
      const wire = kernel.makeWire(Uint32Array.of(edge), true);
      return kernel.makePlanarFaceFromWire(wire);
    }

    const points = profilePoints(data, scope).map((point) =>
      pointOnPlane(basis, point, offset)
    );
    const edges: number[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index]!;
      const end = points[(index + 1) % points.length]!;
      edges.push(
        kernel.makeLineEdge(start.x, start.y, start.z, end.x, end.y, end.z)
      );
    }
    const wire = kernel.makeWire(Uint32Array.from(edges), true);
    return kernel.makePlanarFaceFromWire(wire);
  }

  private buildPrimitive(
    kernel: RemusKernel,
    feature: FeatureNode,
    scope: Record<string, number>
  ): ExactShape {
    if (feature.data.featureKind !== 'primitive') {
      throw new Error('Expected a primitive feature.');
    }
    const data = feature.data;
    const dimension = (key: string): number =>
      resolveParamValue(data.dimensions[key] ?? 0, scope, key);
    let solid: number;
    switch (data.primitiveKind) {
      case 'box':
        solid = kernel.makeBox(
          dimension('width'),
          dimension('height'),
          dimension('depth')
        );
        break;
      case 'cylinder':
        solid = kernel.makeCylinder(dimension('radius'), dimension('height'));
        break;
      case 'sphere':
        solid = kernel.makeSphere(dimension('radius'), CURVE_SEGMENTS);
        break;
      case 'cone':
        solid = kernel.makeCone(
          dimension('bottomRadius'),
          dimension('topRadius'),
          dimension('height')
        );
        break;
      case 'torus':
        solid = kernel.makeTorus(
          dimension('majorRadius'),
          dimension('minorRadius'),
          CURVE_SEGMENTS
        );
        break;
      default:
        throw new Error('Primitive kind is not supported.');
    }
    return {
      solids: [solid],
      lineage: buildPrimitiveLineage(kernel, solid, feature)
    };
  }

  /** Lift a sketch-local 2D point into world space on the plane basis. */
  private static planePoint3(basis: PlaneBasis, point: Vec2Like): Vec3 {
    return {
      x: basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
      y: basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
      z: basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
    };
  }

  /**
   * Build an exact planar face for a detected region: outer wire plus hole
   * wires from the region's line/arc/bezier curves. No tessellation — arcs
   * become true circular edges and glyph beziers become NURBS edges, so STEP
   * export keeps analytic surfaces and smooth outlines.
   *
   * TODO(remus Phase 0.3): once `makeFaceFromWires(outer, inner[])` ships,
   * replace the `makePlanarFaceFromWire` + `addHolesToFace` pair below with
   * the single call. The pinned remus-wasm here does not have it, and this
   * must not depend on unreleased kernel work.
   *
   * `warn` is the document-level warning channel, not `console.warn`: the
   * geometry kernel runs in a Web Worker, so a console line is invisible to
   * the person looking at the faceted result.
   */
  private makeRegionFace(
    kernel: RemusKernel,
    region: SketchRegion,
    basis: PlaneBasis,
    warn: (message: string) => void
  ): number {
    // The exact path needs the kernel's lifted second axis to be this basis's
    // `v`; every basis the app builds is right-handed, so this only ever trips
    // on a corrupt face-attached frame.
    const rightHanded = basisMatchesLiftedFrame(basis);
    const exactBeziers = bezierProfileEdgesEnabled() && rightHanded;
    let flattened = 0;

    const wireFor = (loop: SketchRegion['outer']): number => {
      const edges: number[] = [];
      for (const curve of loop.curves) {
        if (curve.kind === 'line') {
          const a = RemusKernelAdapter.planePoint3(basis, curve.a);
          const b = RemusKernelAdapter.planePoint3(basis, curve.b);
          edges.push(kernel.makeLineEdge(a.x, a.y, a.z, b.x, b.y, b.z));
          continue;
        }
        if (curve.kind === 'bezier') {
          if (exactBeziers) {
            edges.push(
              kernel.liftCurve2dToPlane(
                NURBS_CURVE_TYPE,
                bezierNurbsParams(curve),
                basis.origin.x,
                basis.origin.y,
                basis.origin.z,
                basis.u.x,
                basis.u.y,
                basis.u.z,
                basis.normal.x,
                basis.normal.y,
                basis.normal.z,
                0,
                1
              )
            );
            continue;
          }
          // Feature-flagged fallback: the same line pipeline every polygon
          // uses. The endpoints are the curve's own point objects, so the
          // joints with the neighbouring edges stay bit-identical.
          flattened += 1;
          const points = flattenBezierCurve(curve);
          for (let index = 0; index + 1 < points.length; index += 1) {
            const a = RemusKernelAdapter.planePoint3(basis, points[index]!);
            const b = RemusKernelAdapter.planePoint3(basis, points[index + 1]!);
            edges.push(kernel.makeLineEdge(a.x, a.y, a.z, b.x, b.y, b.z));
          }
          continue;
        }
        const span = Math.abs(curve.endAngle - curve.startAngle);
        const center = RemusKernelAdapter.planePoint3(basis, curve.center);
        if (span >= Math.PI * 2 - 1e-9) {
          // A standalone circle traces as one full-turn piece; the arc
          // constructor degenerates at start == end, so use a circle edge.
          edges.push(
            kernel.makeCircleEdge(
              center.x,
              center.y,
              center.z,
              basis.normal.x,
              basis.normal.y,
              basis.normal.z,
              curve.radius
            )
          );
          continue;
        }
        // Arc pieces are subdivided to ≤ 90°: quarter arcs are unambiguous
        // regardless of whether the arc builder honors the axis sweep or
        // picks the minor arc, and they sidestep a kernel bug with arcs
        // whose end parameter crosses the 0/2π seam.
        const wrap = Math.PI * 2;
        const forward =
          (((curve.endAngle - curve.startAngle) % wrap) + wrap) % wrap;
        const sweep = curve.ccw ? forward : forward - wrap;
        const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
        const sign = curve.ccw ? 1 : -1;
        for (let piece = 0; piece < pieces; piece += 1) {
          const angleA = curve.startAngle + (sweep * piece) / pieces;
          const angleB = curve.startAngle + (sweep * (piece + 1)) / pieces;
          const start = RemusKernelAdapter.planePoint3(basis, {
            x: curve.center.x + Math.cos(angleA) * curve.radius,
            y: curve.center.y + Math.sin(angleA) * curve.radius
          });
          const end = RemusKernelAdapter.planePoint3(basis, {
            x: curve.center.x + Math.cos(angleB) * curve.radius,
            y: curve.center.y + Math.sin(angleB) * curve.radius
          });
          edges.push(
            kernel.makeCircleArc3d(
              start.x,
              start.y,
              start.z,
              end.x,
              end.y,
              end.z,
              center.x,
              center.y,
              center.z,
              basis.normal.x * sign,
              basis.normal.y * sign,
              basis.normal.z * sign
            )
          );
        }
      }
      return kernel.makeWire(Uint32Array.from(edges), true);
    };

    const outerWire = wireFor(region.outer);
    const holeWires = region.holes.map(wireFor);
    if (flattened > 0 && bezierProfileEdgesEnabled()) {
      // Flattening is the default and is not worth a warning; being asked for
      // exact edges and silently not producing them is.
      warn(
        bezierFallbackWarning(
          'the sketch plane frame is not right-handed',
          flattened
        )
      );
    }
    const face = kernel.makePlanarFaceFromWire(outerWire);
    if (holeWires.length === 0) {
      return face;
    }
    return kernel.addHolesToFace(face, Uint32Array.from(holeWires));
  }

  /** Extrude one or more explicitly selected bounded sketch cells. */
  private buildRegionExtrude(
    kernel: RemusKernel,
    document: ProjectDocument,
    sketch: SketchNode,
    feature: FeatureNode,
    data: Extract<FeatureNode['data'], { featureKind: 'extrude' }>,
    scope: Record<string, number>,
    basis: PlaneBasis,
    warn: (message: string) => void
  ): ExactShape {
    const regions = resolveRegionProfiles(document, sketch, data, scope);
    const distance = resolveParamValue(data.distance, scope, 'distance');
    // Symmetric region extrudes start half the distance behind the sketch
    // plane, exactly like the single-profile path.
    const extrudeBasis = data.symmetric
      ? shiftBasisAlongNormal(basis, -distance / 2)
      : basis;
    // A profile whose loops are a polyline approximation of curves the font
    // actually draws is a degradation the user can see in the result and in
    // the STEP export, and nothing downstream can tell it from an authored
    // polygon. Reported once per build rather than once per region.
    const flattenedOutlines = regions.filter(
      (region) => region.outline?.fidelity === 'flattened'
    ).length;
    if (flattenedOutlines > 0) {
      warn(flattenedOutlineWarning(flattenedOutlines));
    }
    const groups = connectedRegionGroups(regions);
    const lineages: RemusLineageState[] = [];
    const solids = groups.map((group) => {
      const face = this.makeRegionFace(
        kernel,
        mergeAdjacentProfiles(group),
        extrudeBasis,
        warn
      );
      const solid = kernel.extrude(
        face,
        extrudeBasis.normal.x,
        extrudeBasis.normal.y,
        extrudeBasis.normal.z,
        distance
      );
      const candidates = topologyCandidatesForSolid(kernel, solid);
      const assignments: RemusSemanticAssignment[] = [];
      const diagnostics: RemusLineageState[] = [];
      const sourceEntityIds = [
        ...new Set(group.flatMap((region) => region.sourceEntityIds))
      ].sort();
      const token = sourceEntityIds.join('+');
      if (token.length === 0) {
        diagnostics.push(
          remusHashOnlyLineage(
            'sweep',
            'Selected sketch region has no stable authored-entity identity.'
          )
        );
      } else {
        const endOrigin = {
          x: extrudeBasis.origin.x + extrudeBasis.normal.x * distance,
          y: extrudeBasis.origin.y + extrudeBasis.normal.y * distance,
          z: extrudeBasis.origin.z + extrudeBasis.normal.z * distance
        };
        addFaceCarrierRole(
          candidates,
          planeCarrier(extrudeBasis.normal, extrudeBasis.origin),
          `sweep.face.cap.start.region.${token}`,
          assignments,
          diagnostics
        );
        addFaceCarrierRole(
          candidates,
          planeCarrier(extrudeBasis.normal, endOrigin),
          `sweep.face.cap.end.region.${token}`,
          assignments,
          diagnostics
        );
        diagnostics.push(
          remusHashOnlyLineage(
            'sweep',
            `Selected-region side topology ${token} has no one-to-one semantic curve mapping.`
          )
        );
      }
      lineages.push(
        mergeRemusLineageStates([
          createRemusSemanticLineage(feature.featureId, 'sweep', assignments),
          ...diagnostics
        ])
      );
      return solid;
    });
    return {
      solids,
      lineage: mergeRemusLineageStates(lineages)
    };
  }

  private sectionFace(
    kernel: RemusKernel,
    document: ProjectDocument,
    section: SketchSectionReference,
    scope: Record<string, number>,
    sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
    warn: (message: string) => void,
    label: string
  ): number {
    const sketch = findSketch(document, section.sketchId);
    if (!sketch) {
      throw new Error(`${label} sketch no longer exists.`);
    }
    const basis = sketchBases.get(sketch.sketchId);
    if (!basis) {
      throw new Error(
        `${label} sketch plane did not resolve at its history position.`
      );
    }
    const profiles = resolveRegionProfiles(
      document,
      sketch,
      { profile: section.profile },
      scope
    );
    if (profiles.length !== 1) {
      throw new Error(`${label} must resolve to exactly one closed profile.`);
    }
    return this.makeRegionFace(kernel, profiles[0]!, basis, warn);
  }

  private buildLoft(
    kernel: RemusKernel,
    document: ProjectDocument,
    feature: FeatureNode,
    scope: Record<string, number>,
    sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
    warn: (message: string) => void
  ): ExactShape {
    if (feature.data.featureKind !== 'loft') {
      throw new Error('Expected a loft feature.');
    }
    if (feature.data.sections.length < 2) {
      throw new Error('Loft requires at least two profile sections.');
    }
    const faces = feature.data.sections.map((section, index) =>
      this.sectionFace(
        kernel,
        document,
        section,
        scope,
        sketchBases,
        warn,
        `Loft section ${index + 1}`
      )
    );
    const solid =
      feature.data.mode === 'smooth'
        ? kernel.loftSmooth(Uint32Array.from(faces))
        : kernel.loft(Uint32Array.from(faces));
    return {
      solids: [validateGeneratedSolid(kernel, solid, 'Loft')],
      lineage: remusHashOnlyLineage(
        'sweep',
        'Loft section topology has no verified output evolution relation.'
      )
    };
  }

  private sweepPathEdges(
    kernel: RemusKernel,
    document: ProjectDocument,
    path: SketchPathReference,
    scope: Record<string, number>,
    sketchBases: ReadonlyMap<SketchId, PlaneBasis>
  ): number[] {
    const sketch = findSketch(document, path.sketchId);
    if (!sketch) {
      throw new Error('Sweep path sketch no longer exists.');
    }
    const basis = sketchBases.get(sketch.sketchId);
    if (!basis) {
      throw new Error(
        'Sweep path sketch plane did not resolve at its history position.'
      );
    }
    const available = new Set(sketch.objectIds);
    if (
      path.entityIds.length === 0 ||
      path.entityIds.some((entityId) => !available.has(entityId))
    ) {
      throw new Error('Sweep path contains a missing sketch entity.');
    }
    return path.entityIds.flatMap((entityId) => {
      const node = document.nodes[entityId];
      if (node?.kind !== 'sketch-object') {
        throw new Error('Sweep path entity is not a sketch object.');
      }
      const data = node.data;
      if (data.objectKind === 'line') {
        const start = RemusKernelAdapter.planePoint3(basis, {
          x: resolveParamValue(data.x1, scope, 'path start X'),
          y: resolveParamValue(data.y1, scope, 'path start Y')
        });
        const end = RemusKernelAdapter.planePoint3(basis, {
          x: resolveParamValue(data.x2, scope, 'path end X'),
          y: resolveParamValue(data.y2, scope, 'path end Y')
        });
        return [
          kernel.makeLineEdge(start.x, start.y, start.z, end.x, end.y, end.z)
        ];
      }
      if (data.objectKind !== 'arc') {
        throw new Error('Sweep paths currently support line and arc entities.');
      }
      const center2 = {
        x: resolveParamValue(data.centerX, scope, 'path center X'),
        y: resolveParamValue(data.centerY, scope, 'path center Y')
      };
      const radius = resolveParamValue(data.radius, scope, 'path radius');
      const start =
        (resolveParamValue(data.startAngleDeg, scope, 'path start angle') *
          Math.PI) /
        180;
      const end =
        (resolveParamValue(data.endAngleDeg, scope, 'path end angle') *
          Math.PI) /
        180;
      const wrap = Math.PI * 2;
      const sweep = (((end - start) % wrap) + wrap) % wrap;
      if (sweep <= GEOMETRY_EPSILON) {
        throw new Error('Sweep path arc must have a non-zero sweep.');
      }
      const center = RemusKernelAdapter.planePoint3(basis, center2);
      const pieces = Math.max(1, Math.ceil(sweep / (Math.PI / 2)));
      return Array.from({ length: pieces }, (_, index) => {
        const angleA = start + (sweep * index) / pieces;
        const angleB = start + (sweep * (index + 1)) / pieces;
        const pointA = RemusKernelAdapter.planePoint3(basis, {
          x: center2.x + Math.cos(angleA) * radius,
          y: center2.y + Math.sin(angleA) * radius
        });
        const pointB = RemusKernelAdapter.planePoint3(basis, {
          x: center2.x + Math.cos(angleB) * radius,
          y: center2.y + Math.sin(angleB) * radius
        });
        return kernel.makeCircleArc3d(
          pointA.x,
          pointA.y,
          pointA.z,
          pointB.x,
          pointB.y,
          pointB.z,
          center.x,
          center.y,
          center.z,
          basis.normal.x,
          basis.normal.y,
          basis.normal.z
        );
      });
    });
  }

  private buildProfileSweep(
    kernel: RemusKernel,
    document: ProjectDocument,
    feature: FeatureNode,
    scope: Record<string, number>,
    sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
    warn: (message: string) => void
  ): ExactShape {
    if (feature.data.featureKind !== 'sweep') {
      throw new Error('Expected a sweep feature.');
    }
    const face = this.sectionFace(
      kernel,
      document,
      feature.data.profile,
      scope,
      sketchBases,
      warn,
      'Sweep profile'
    );
    const edges = this.sweepPathEdges(
      kernel,
      document,
      feature.data.path,
      scope,
      sketchBases
    );
    const solid =
      edges.length === 1
        ? kernel.sweepWithOptions(
            face,
            edges[0]!,
            'rmf',
            new Float64Array(),
            feature.data.mode === 'smooth' ? 64 : 24,
            'smooth'
          )
        : kernel.sweepAlongEdges(face, Uint32Array.from(edges));
    return {
      solids: [validateGeneratedSolid(kernel, solid, 'Sweep')],
      lineage: remusHashOnlyLineage(
        'sweep',
        'Profile sweep topology has no verified output evolution relation.'
      )
    };
  }

  private buildHelicalSweep(
    kernel: RemusKernel,
    document: ProjectDocument,
    feature: FeatureNode,
    scope: Record<string, number>,
    sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
    warn: (message: string) => void
  ): ExactShape {
    if (feature.data.featureKind !== 'helical-sweep') {
      throw new Error('Expected a helical sweep feature.');
    }
    const face = this.sectionFace(
      kernel,
      document,
      feature.data.profile,
      scope,
      sketchBases,
      warn,
      'Helical sweep profile'
    );
    const origin = resolveParametricPoint(
      feature.data.axisOrigin,
      scope,
      'helical axis origin'
    );
    const direction = normalized(
      resolveParametricPoint(
        feature.data.axisDirection,
        scope,
        'helical axis direction'
      )
    );
    if (!direction) {
      throw new Error('Helical sweep axis direction must be non-zero.');
    }
    const radius = resolveParamValue(feature.data.radius, scope, 'radius');
    const pitch = resolveParamValue(feature.data.pitch, scope, 'pitch');
    const turns = resolveParamValue(feature.data.turns, scope, 'turns');
    if (
      !(radius > 0) ||
      pitch === 0 ||
      !(turns > 0) ||
      turns > MAX_HELICAL_SWEEP_TURNS
    ) {
      throw new Error(
        `Helical sweep requires a positive radius, no more than ${MAX_HELICAL_SWEEP_TURNS} turns, and a non-zero pitch.`
      );
    }
    const solid = kernel.helicalSweep(
      face,
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      radius,
      pitch,
      turns
    );
    return {
      solids: [validateGeneratedSolid(kernel, solid, 'Helical sweep')],
      lineage: remusHashOnlyLineage(
        'sweep',
        'Helical sweep topology has no verified output evolution relation.'
      )
    };
  }

  private buildSweep(
    kernel: RemusKernel,
    document: ProjectDocument,
    feature: FeatureNode,
    scope: Record<string, number>,
    sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
    warn: (message: string) => void
  ): ExactShape {
    if (
      feature.data.featureKind !== 'extrude' &&
      feature.data.featureKind !== 'revolve'
    ) {
      throw new Error('Expected a sweep feature.');
    }
    if (
      feature.data.featureKind === 'extrude' &&
      (feature.data.profile ||
        (feature.data.profiles && feature.data.profiles.length > 0))
    ) {
      const sketchNode = findSketch(document, feature.data.sketchId);
      if (!sketchNode) {
        throw new Error('Referenced sketch no longer exists.');
      }
      const basis = sketchBases.get(sketchNode.sketchId);
      if (!basis) {
        throw new Error(
          `Sketch "${sketchNode.name}" plane did not resolve at its history position.`
        );
      }
      return this.buildRegionExtrude(
        kernel,
        document,
        sketchNode,
        feature,
        feature.data,
        scope,
        basis,
        warn
      );
    }
    const sketch = findSketch(document, feature.data.sketchId);
    const objectId = sketch?.objectIds[0];
    const object = objectId ? document.nodes[objectId] : undefined;
    if (!sketch || !object || object.kind !== 'sketch-object') {
      throw new Error('Referenced sketch has no profile.');
    }
    const basis = sketchBases.get(sketch.sketchId);
    if (!basis) {
      throw new Error(
        `Sketch "${sketch.name}" plane did not resolve at its history position.`
      );
    }
    if (feature.data.featureKind === 'extrude') {
      const distance = resolveParamValue(
        feature.data.distance,
        scope,
        'distance'
      );
      // A symmetric extrude starts half the distance behind the sketch
      // plane; the shifted basis carries that offset into the profile face
      // and every lineage carrier at once.
      const extrudeBasis = feature.data.symmetric
        ? shiftBasisAlongNormal(basis, -distance / 2)
        : basis;
      const face = this.makeProfileFace(
        kernel,
        object.data,
        extrudeBasis,
        0,
        scope
      );
      const solid = kernel.extrude(
        face,
        extrudeBasis.normal.x,
        extrudeBasis.normal.y,
        extrudeBasis.normal.z,
        distance
      );
      return {
        solids: [solid],
        lineage: buildExtrudeLineage(
          kernel,
          solid,
          feature,
          String(object.id),
          object.data,
          extrudeBasis,
          distance,
          scope
        )
      };
    }
    const face = this.makeProfileFace(kernel, object.data, basis, 0, scope);

    const direction = feature.data.axis === 'vertical' ? basis.v : basis.u;
    const point = pointOnPlane(basis, { x: 0, y: 0 }, 0);
    const angleDeg = resolveRevolveAngleDeg(feature.data.angleDeg, scope);
    const solid = kernel.revolve(
      face,
      point.x,
      point.y,
      point.z,
      direction.x,
      direction.y,
      direction.z,
      angleDeg
    );
    return {
      solids: [solid],
      // A partial revolve of a non-circular profile is a deliberate ADR-011
      // hash-only body, not a lineage builder that quietly matched nothing.
      lineage: revolveKeepsSemanticLineage(angleDeg, object.data)
        ? buildRevolveLineage(
            kernel,
            solid,
            feature,
            String(object.id),
            object.data,
            basis,
            direction,
            point,
            scope
          )
        : remusHashOnlyLineage('sweep', PARTIAL_REVOLVE_HASH_ONLY_REASON)
    };
  }

  private build(
    kernel: RemusKernel,
    document: ProjectDocument,
    importSources: ReadonlyMap<string, Uint8Array> = new Map(),
    /** Import checksums this build reads; see {@link storeImportedStep}. */
    pinnedImports: ReadonlySet<string> = new Set(importSources.keys()),
    /**
     * Prefix-restore continuation: the kernel already holds the state after
     * feature `startIndex - 1` and `initial` is that point's JS state, so
     * the loop replays only `startIndex..end`. The scope errors seeded into
     * fresh warnings below are already inside `initial`.
     */
    resume?: { startIndex: number; initial: ExactBuildResult },
    /** Runs after every feature index this call executed, failed included. */
    onFeature?: (index: number, result: ExactBuildResult) => void
  ): ExactBuildResult {
    const { scope, errors } = getParameterScope(document);
    const result: ExactBuildResult = resume?.initial ?? {
      shapes: new Map(),
      sketchBases: new Map(),
      consumed: new Set(),
      importedStepDiagnostics: new Map(),
      meshBodies: new Set(),
      partialRevolveBodies: new Set(),
      warnings: [...errors],
      referenceRepairs: []
    };
    const startIndex = resume?.startIndex ?? 0;
    const features = listFeaturesInOrder(document);

    for (let index = startIndex; index < features.length; index += 1) {
      const feature = features[index]!;
      if (isFeatureSuppressed(feature)) {
        result.warnings.push(
          `Feature "${feature.name}": Suppressed; skipped during exact rebuild.`
        );
        onFeature?.(index, result);
        continue;
      }
      try {
        switch (feature.data.featureKind) {
          case 'sketch': {
            const sketch = findSketch(document, feature.data.sketchId);
            if (!sketch) {
              throw new Error('Referenced sketch no longer exists.');
            }
            result.sketchBases.set(
              sketch.sketchId,
              this.resolveSketchBasisAtHistory(
                kernel,
                document,
                sketch,
                result,
                scope
              )
            );
            break;
          }
          case 'imported-mesh': {
            if (feature.bodyId) {
              // The kernel's own STL importer owns vertex welding and shell
              // orientation, so the document's triangle soup goes back through
              // it rather than being re-derived here.
              const solid = importMeshSolid(
                kernel,
                importedMeshStl(feature.data)
              );
              result.meshBodies.add(feature.bodyId);
              result.shapes.set(feature.bodyId, {
                solids: [solid],
                lineage: remusHashOnlyLineage(
                  'imported-mesh',
                  'Imported meshes carry no feature provenance; every facet is source-file data.'
                )
              });
            }
            break;
          }
          case 'direct-edit': {
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Direct-edit target is unavailable.');
            }
            const edited = this.applyDirectEdit(
              kernel,
              target,
              feature.data.operation,
              scope,
              feature.featureId
            );
            const targetBodyId = feature.data.targetBodyId;
            const producer = listFeaturesInOrder(document).find(
              (candidate) => candidate.bodyId === targetBodyId
            );
            edited.lineage ??=
              rederivePrimitiveDirectEditLineage(kernel, edited, producer) ??
              remusHashOnlyLineage(
                'direct-edit',
                'Remus does not expose a complete direct-edit output relation.'
              );
            result.shapes.set(feature.data.targetBodyId, edited);
            break;
          }
          case 'imported-step': {
            if (feature.bodyId) {
              const checksum =
                feature.data.stepText === undefined
                  ? feature.data.stepSourceRef?.checksumSha256
                  : undefined;
              const cached = checksum
                ? this.importedStepCache.get(checksum)
                : undefined;
              let solids: number[];
              let diagnostics: ImportedStepDiagnostics;
              if (cached) {
                // The checksum determines the result, so restoring is exact.
                // Only the handles are new — they belong to this kernel.
                solids = cached.solids.map((blob) =>
                  kernel.deserializeSolid(blob)
                );
                diagnostics = cached.diagnostics;
              } else {
                let sourceBytes: Uint8Array;
                if (feature.data.stepText !== undefined) {
                  sourceBytes = new TextEncoder().encode(feature.data.stepText);
                } else {
                  const ref = feature.data.stepSourceRef;
                  const resolved = ref
                    ? importSources.get(ref.checksumSha256)
                    : undefined;
                  if (!resolved) {
                    throw new Error(
                      `Import source for "${feature.data.sourceName}" is not available on this device.`
                    );
                  }
                  sourceBytes = resolved;
                }
                const declared = Array.from(
                  importStepWithOwnBudget(kernel, sourceBytes)
                );
                if (declared.length === 0) {
                  throw new Error('STEP file contains no solids.');
                }
                // K0.6. A shell that is not closed is not a solid, whatever
                // volume a divergence integral over its faces happens to
                // produce. Reject those before they become a body; keep the
                // rest and say which ones went, because an unreadable solid
                // that vanishes silently is the worst failure mode the parity
                // corpus records.
                const verdicts = declared.map((solid, index) =>
                  classifyImportedSolid(
                    diagnoseImportedSolid(kernel, solid, index + 1)
                  )
                );
                solids = declared.filter(
                  (_, index) => verdicts[index]!.kind !== 'not-a-solid'
                );
                const rejections = verdicts.flatMap((verdict) =>
                  verdict.kind === 'not-a-solid' ? [verdict.reason] : []
                );
                if (solids.length === 0) {
                  throw new Error(importedStepNoSolidError(rejections));
                }
                diagnostics = {
                  declaredSolidCount: declared.length,
                  rejections,
                  flagged: verdicts.flatMap((verdict) =>
                    verdict.kind === 'flagged' ? [verdict.reason] : []
                  )
                };
                if (checksum) {
                  this.storeImportedStep(
                    checksum,
                    kernel,
                    solids,
                    diagnostics,
                    pinnedImports
                  );
                }
              }
              // Remus's STEP reader normalizes every length to millimetres
              // using the file's declared unit, but the document speaks its
              // own unit everywhere downstream (exports multiply by
              // UNIT_TO_MM). A non-mm document must adopt the solids at
              // 1/UNIT_TO_MM — before lineage derivation, so the published
              // witnesses match the coordinates every later feature sees. The
              // checksum cache above stays in millimetre form, which keeps a
              // cached import correct across a document units change.
              const documentScale = 1 / UNIT_TO_MM[document.units];
              if (documentScale !== 1) {
                solids = solids.map((solid) =>
                  kernel.copyAndTransformSolid(
                    solid,
                    uniformScaleMatrix(documentScale)
                  )
                );
              }
              result.importedStepDiagnostics.set(feature.bodyId, diagnostics);
              result.shapes.set(feature.bodyId, {
                solids,
                lineage: createRemusImportedStepLineage(
                  feature.featureId,
                  solids.flatMap((solid) =>
                    topologyCandidatesForSolid(kernel, solid)
                  )
                )
              });
            }
            break;
          }
          case 'primitive':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.buildPrimitive(kernel, feature, scope)
              );
            }
            break;
          case 'extrude':
            if (feature.bodyId) {
              const extrusion = this.buildSweep(
                kernel,
                document,
                feature,
                scope,
                result.sketchBases,
                (message) =>
                  result.warnings.push(`Feature "${feature.name}": ${message}`)
              );
              const operation = feature.data.operation ?? 'new-body';
              if (operation === 'new-body') {
                result.shapes.set(feature.bodyId, extrusion);
                break;
              }
              const targetBodyId = feature.data.targetBodyId;
              if (!targetBodyId) {
                throw new Error(
                  `Stored ${operation} extrusion has no target body.`
                );
              }
              if (result.consumed.has(targetBodyId)) {
                throw new Error(
                  `Stored ${operation} target ${bodyName(document, targetBodyId)} was already consumed.`
                );
              }
              if (result.meshBodies.has(targetBodyId)) {
                throw meshBooleanUnsupportedError(
                  bodyName(document, targetBodyId)
                );
              }
              const target = result.shapes.get(targetBodyId);
              if (!target) {
                throw new Error(
                  `Stored ${operation} target ${bodyName(document, targetBodyId)} is unavailable.`
                );
              }
              const targetBody = inferenceBodyForShape(
                kernel,
                target,
                targetBodyId,
                bodyName(document, targetBodyId)
              );
              const extrusionBody = inferenceBodyForShape(
                kernel,
                extrusion,
                feature.bodyId,
                feature.name
              );
              if (
                sharedShapeVolume(
                  kernel,
                  target,
                  extrusion,
                  targetBody,
                  extrusionBody
                ) <= 0
              ) {
                throw new Error(
                  `Stored ${operation} extrusion no longer overlaps ${targetBody.name}; operation was not re-inferred.`
                );
              }
              const targetSolid = collapseShape(kernel, target);
              const extrusionSolid = collapseShape(kernel, extrusion);
              const solid =
                operation === 'add'
                  ? fuseUniformSolid(kernel, [
                      ...target.solids,
                      ...extrusion.solids
                    ])
                  : unifyBooleanFaces(
                      kernel,
                      tryExactCoaxialCylinderCut(
                        kernel,
                        targetSolid,
                        extrusionSolid
                      ) ?? kernel.cut(targetSolid, extrusionSolid)
                    );
              const resultBounds = kernel.boundingBox(solid);
              const resultBody: ExtrudeInferenceBody = {
                bodyId: feature.bodyId,
                name: feature.name,
                volume: kernel.volume(solid, MEASUREMENT_DEFLECTION),
                bbox: {
                  min: {
                    x: resultBounds[0]!,
                    y: resultBounds[1]!,
                    z: resultBounds[2]!
                  },
                  max: {
                    x: resultBounds[3]!,
                    y: resultBounds[4]!,
                    z: resultBounds[5]!
                  }
                }
              };
              if (
                operation === 'cut' &&
                resultBody.volume <=
                  extrudeVolumeTolerance(targetBody, extrusionBody)
              ) {
                throw new Error(
                  `Stored cut extrusion would remove all of ${targetBody.name}; operation was not changed.`
                );
              }
              result.consumed.add(targetBodyId);
              result.shapes.set(feature.bodyId, {
                solids: [solid],
                lineage: remusHashOnlyLineage(
                  'boolean',
                  `The stored extrusion ${operation} does not expose a verified output topology relation.`
                )
              });
            }
            break;
          case 'revolve':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.buildSweep(
                  kernel,
                  document,
                  feature,
                  scope,
                  result.sketchBases,
                  (message) =>
                    result.warnings.push(
                      `Feature "${feature.name}": ${message}`
                    )
                )
              );
              if (
                resolveRevolveAngleDeg(feature.data.angleDeg, scope) <
                FULL_REVOLVE_ANGLE_DEG
              ) {
                result.partialRevolveBodies.add(feature.bodyId);
              }
            }
            break;
          case 'loft':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.buildLoft(
                  kernel,
                  document,
                  feature,
                  scope,
                  result.sketchBases,
                  (message) =>
                    result.warnings.push(
                      `Feature "${feature.name}": ${message}`
                    )
                )
              );
            }
            break;
          case 'sweep':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.buildProfileSweep(
                  kernel,
                  document,
                  feature,
                  scope,
                  result.sketchBases,
                  (message) =>
                    result.warnings.push(
                      `Feature "${feature.name}": ${message}`
                    )
                )
              );
            }
            break;
          case 'helical-sweep':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.buildHelicalSweep(
                  kernel,
                  document,
                  feature,
                  scope,
                  result.sketchBases,
                  (message) =>
                    result.warnings.push(
                      `Feature "${feature.name}": ${message}`
                    )
                )
              );
            }
            break;
          case 'transform': {
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Transform target is unavailable.');
            }
            const translation = feature.data.transform.translation;
            const rotation = feature.data.transform.rotationDeg;
            const scaleFactor =
              feature.data.transform.scale !== undefined
                ? resolveParamValue(
                    feature.data.transform.scale,
                    scope,
                    'scale'
                  )
                : 1;
            if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
              throw new Error(
                'Transform scale must resolve to a positive number.'
              );
            }
            result.shapes.set(
              feature.data.targetBodyId,
              copyShapeWithVerifiedLineage(
                kernel,
                target,
                transformMatrix(
                  {
                    x: resolveParamValue(translation.x, scope, 'X'),
                    y: resolveParamValue(translation.y, scope, 'Y'),
                    z: resolveParamValue(translation.z, scope, 'Z')
                  },
                  {
                    x: resolveParamValue(rotation.x, scope, 'rotate X'),
                    y: resolveParamValue(rotation.y, scope, 'rotate Y'),
                    z: resolveParamValue(rotation.z, scope, 'rotate Z')
                  },
                  scaleFactor
                )
              )
            );
            break;
          }
          case 'mirror': {
            if (!feature.bodyId) {
              throw new Error('Mirror has no result body.');
            }
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Mirror target is unavailable.');
            }
            const origin = feature.data.plane.origin;
            const rawNormal = feature.data.plane.normal;
            const planePoint = {
              x: resolveParamValue(origin.x, scope, 'mirror origin X'),
              y: resolveParamValue(origin.y, scope, 'mirror origin Y'),
              z: resolveParamValue(origin.z, scope, 'mirror origin Z')
            };
            const planeNormal = normalized({
              x: resolveParamValue(rawNormal.x, scope, 'mirror normal X'),
              y: resolveParamValue(rawNormal.y, scope, 'mirror normal Y'),
              z: resolveParamValue(rawNormal.z, scope, 'mirror normal Z')
            });
            if (!planeNormal) {
              throw new Error(
                'Mirror plane normal must be finite and non-zero.'
              );
            }
            const operations = createRemusModelingOperations(kernel);
            result.shapes.set(feature.bodyId, {
              solids: target.solids.map((targetSolid) =>
                operations.mirror({ targetSolid, planePoint, planeNormal })
              ),
              lineage: remusHashOnlyLineage(
                'mirror',
                'The pinned bridge does not expose a complete reflected topology relation.'
              )
            });
            inheritMeshOrigin(
              result,
              feature.data.targetBodyId,
              feature.bodyId
            );
            break;
          }
          case 'hole': {
            if (!feature.bodyId) {
              throw new Error('Hole has no result body.');
            }
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Hole target is unavailable.');
            }
            // Face resolution works on a single solid; fuse a multi-solid
            // body first, exactly as an edge modifier would.
            const shape: ExactShape =
              target.solids.length === 1
                ? target
                : { solids: [collapseShape(kernel, target)] };
            const targetSolid = shape.solids[0]!;
            const faces = resolveFeatureFaces(
              kernel,
              shape,
              [feature.data.faceHash],
              feature.data.faceReference
                ? [feature.data.faceReference]
                : undefined,
              'Hole'
            );
            const geometry = measureFaceGeometry(kernel, faces[0]!);
            if (
              geometry?.surfaceType !== 'plane' ||
              geometry.normal === undefined
            ) {
              throw new Error(
                'A hole needs a planar entry face with an analytic normal.'
              );
            }
            // The same frame construction as `frameFromFace` and the
            // kernel's cylinder frames, so the stored (u, v) re-derives the
            // identical world position on every rebuild.
            const zAxis = normalized(geometry.normal);
            if (!zAxis) {
              throw new Error('Hole entry face normal is degenerate.');
            }
            const reference =
              Math.abs(zAxis.z) < 0.9
                ? { x: 0, y: 0, z: 1 }
                : { x: 1, y: 0, z: 0 };
            const xAxis = normalized(cross(reference, zAxis))!;
            const yAxis = cross(zAxis, xAxis);
            const u = resolveParamValue(
              feature.data.position.u,
              scope,
              'hole position U'
            );
            const v = resolveParamValue(
              feature.data.position.v,
              scope,
              'hole position V'
            );
            const surfacePoint = {
              x: geometry.center.x + xAxis.x * u + yAxis.x * v,
              y: geometry.center.y + xAxis.y * u + yAxis.y * v,
              z: geometry.center.z + xAxis.z * u + yAxis.z * v
            };
            const axis = {
              x: -zAxis.x,
              y: -zAxis.y,
              z: -zAxis.z
            };
            const diameter = resolveParamValue(
              feature.data.diameter,
              scope,
              'hole diameter'
            );
            if (!(diameter > 0)) {
              throw new Error('Hole diameter must be greater than zero.');
            }
            let depth: number;
            if (feature.data.depthMode === 'through') {
              // Far enough to clear the body from this entry point, however
              // the body sits relative to the face.
              const bounds = kernel.boundingBox(targetSolid);
              const corners = [0, 1].flatMap((cx) =>
                [0, 1].flatMap((cy) =>
                  [0, 1].map((cz) => ({
                    x: bounds[cx * 3]!,
                    y: bounds[cy * 3 + 1]!,
                    z: bounds[cz * 3 + 2]!
                  }))
                )
              );
              depth = corners.reduce(
                (maximum, corner) =>
                  Math.max(maximum, dot(subtract(corner, surfacePoint), axis)),
                0
              );
              if (!(depth > 0)) {
                throw new Error('The hole points away from the body.');
              }
            } else {
              if (feature.data.depth === undefined) {
                throw new Error('A blind hole needs a depth.');
              }
              depth = resolveParamValue(
                feature.data.depth,
                scope,
                'hole depth'
              );
              if (!(depth > 0)) {
                throw new Error('Hole depth must be greater than zero.');
              }
            }
            // The overshoot heuristic resizeThroughHole already uses, so a
            // bore through a slanted opening trims identically.
            const extension = Math.max(
              DIRECT_EDIT_TOLERANCE * 10,
              depth * 0.02,
              diameter * 0.01
            );
            const style = feature.data.style;
            const resolveOptional = (
              value: ParamValue | undefined,
              label: string
            ): number | undefined =>
              value === undefined
                ? undefined
                : resolveParamValue(value, scope, label);
            const countersinkAngleDeg = resolveOptional(
              feature.data.countersinkAngleDeg,
              'countersink angle'
            );
            const counterboreDiameter = resolveOptional(
              feature.data.counterboreDiameter,
              'counterbore diameter'
            );
            const drilled = drillHole(kernel, targetSolid, {
              surfacePoint,
              axis,
              radius: diameter / 2,
              depth,
              style,
              counterboreRadius:
                counterboreDiameter === undefined
                  ? undefined
                  : counterboreDiameter / 2,
              counterboreDepth: resolveOptional(
                feature.data.counterboreDepth,
                'counterbore depth'
              ),
              countersinkRadius: (() => {
                const value = resolveOptional(
                  feature.data.countersinkDiameter,
                  'countersink diameter'
                );
                return value === undefined ? undefined : value / 2;
              })(),
              countersinkAngle:
                countersinkAngleDeg === undefined
                  ? undefined
                  : (countersinkAngleDeg * Math.PI) / 180,
              entryExtension: extension,
              exitExtension:
                feature.data.depthMode === 'through' ? extension : 0
            });
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(feature.bodyId, {
              solids: [drilled],
              lineage: remusHashOnlyLineage(
                'hole',
                'The compound cut does not report face ancestry through the bore.'
              )
            });
            inheritMeshOrigin(
              result,
              feature.data.targetBodyId,
              feature.bodyId
            );
            break;
          }
          case 'split': {
            if (!feature.bodyId) {
              throw new Error('Split has no result body.');
            }
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Split target is unavailable.');
            }
            const origin = feature.data.plane.origin;
            const rawNormal = feature.data.plane.normal;
            const planePoint = {
              x: resolveParamValue(origin.x, scope, 'split origin X'),
              y: resolveParamValue(origin.y, scope, 'split origin Y'),
              z: resolveParamValue(origin.z, scope, 'split origin Z')
            };
            const planeNormal = normalized({
              x: resolveParamValue(rawNormal.x, scope, 'split normal X'),
              y: resolveParamValue(rawNormal.y, scope, 'split normal Y'),
              z: resolveParamValue(rawNormal.z, scope, 'split normal Z')
            });
            if (!planeNormal) {
              throw new Error(
                'Split plane normal must be finite and non-zero.'
              );
            }
            // A multi-solid target is fused first: the kernel splits one
            // solid, and each half must again be one body's worth of solids.
            const targetSolid = collapseShape(kernel, target);
            // The kernel refuses rather than approximates — a plane through
            // an edge, across a curved face, or missing the solid entirely
            // is a typed error that lands in the feature's warnings.
            const halves = kernel.split(
              targetSolid,
              planePoint.x,
              planePoint.y,
              planePoint.z,
              planeNormal.x,
              planeNormal.y,
              planeNormal.z
            );
            const positive = halves[0];
            const negative = halves[1];
            if (positive === undefined || negative === undefined) {
              throw new Error('Split did not return two halves.');
            }
            const lineageNote =
              'The kernel split does not report face ancestry across the cut.';
            result.shapes.set(feature.bodyId, {
              solids: [positive],
              lineage: remusHashOnlyLineage('split', lineageNote)
            });
            result.shapes.set(feature.data.secondBodyId, {
              solids: [negative],
              lineage: remusHashOnlyLineage('split', lineageNote)
            });
            result.consumed.add(feature.data.targetBodyId);
            inheritMeshOrigin(
              result,
              feature.data.targetBodyId,
              feature.bodyId
            );
            inheritMeshOrigin(
              result,
              feature.data.targetBodyId,
              feature.data.secondBodyId
            );
            break;
          }
          case 'shell': {
            if (!feature.bodyId) {
              throw new Error('Shell has no result body.');
            }
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Shell target is unavailable.');
            }
            const openingFaces = resolveFeatureFaces(
              kernel,
              target,
              feature.data.openingFaceHashes,
              feature.data.openingFaceReferences,
              'Shell opening'
            );
            const thickness = resolveParamValue(
              feature.data.thickness,
              scope,
              'shell thickness'
            );
            const solid = createRemusModelingOperations(kernel).shell({
              targetSolid: target.solids[0]!,
              thickness,
              openingFaces
            });
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(feature.bodyId, {
              solids: [solid],
              lineage: remusHashOnlyLineage(
                'shell',
                'The pinned bridge does not expose removed, offset, and generated face relations.'
              )
            });
            inheritMeshOrigin(
              result,
              feature.data.targetBodyId,
              feature.bodyId
            );
            break;
          }
          case 'solid-offset': {
            if (!feature.bodyId) {
              throw new Error('Solid offset has no result body.');
            }
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Solid-offset target is unavailable.');
            }
            const distance = resolveParamValue(
              feature.data.distance,
              scope,
              'solid offset distance'
            );
            const operations = createRemusModelingOperations(kernel);
            const solids = target.solids.map((targetSolid) =>
              operations.offsetSolid({ targetSolid, distance })
            );
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(feature.bodyId, {
              solids,
              lineage: remusHashOnlyLineage(
                'solid-offset',
                'The pinned bridge does not expose a complete offset topology relation.'
              )
            });
            inheritMeshOrigin(
              result,
              feature.data.targetBodyId,
              feature.bodyId
            );
            break;
          }
          case 'draft': {
            if (!feature.bodyId) {
              throw new Error('Draft has no result body.');
            }
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Draft target is unavailable.');
            }
            const faces = resolveFeatureFaces(
              kernel,
              target,
              feature.data.faceHashes,
              feature.data.faceReferences,
              'Draft'
            );
            const pullDirection = resolveParametricPoint(
              feature.data.pullDirection,
              scope,
              'draft pull direction'
            );
            const neutralPoint = resolveParametricPoint(
              feature.data.neutralPoint,
              scope,
              'draft neutral point'
            );
            const angleDegrees = resolveParamValue(
              feature.data.angleDeg,
              scope,
              'draft angle'
            );
            const solid = createRemusModelingOperations(kernel).draft({
              targetSolid: target.solids[0]!,
              faces,
              pullDirection,
              neutralPoint,
              angleDegrees
            });
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(feature.bodyId, {
              solids: [solid],
              lineage: remusHashOnlyLineage(
                'draft',
                'Draft topology has no verified output evolution relation.'
              )
            });
            inheritMeshOrigin(
              result,
              feature.data.targetBodyId,
              feature.bodyId
            );
            break;
          }
          case 'thicken': {
            if (!feature.bodyId) {
              throw new Error('Thicken has no result body.');
            }
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Thicken source body is unavailable.');
            }
            const [face] = resolveFeatureFaces(
              kernel,
              target,
              [feature.data.faceHash],
              feature.data.faceReference
                ? [feature.data.faceReference]
                : undefined,
              'Thicken'
            );
            const thickness = resolveParamValue(
              feature.data.thickness,
              scope,
              'thicken distance'
            );
            const solid = createRemusModelingOperations(kernel).thicken({
              sourceSolid: target.solids[0]!,
              face: face!,
              thickness
            });
            result.shapes.set(feature.bodyId, {
              solids: [solid],
              lineage: remusHashOnlyLineage(
                'thicken',
                'Thicken topology has no verified output evolution relation.'
              )
            });
            inheritMeshOrigin(
              result,
              feature.data.targetBodyId,
              feature.bodyId
            );
            break;
          }
          case 'boolean': {
            if (!feature.bodyId || feature.data.targetBodyIds.length < 2) {
              throw new Error('Boolean requires at least two bodies.');
            }
            const meshOperand = feature.data.targetBodyIds.find((bodyId) =>
              result.meshBodies.has(bodyId)
            );
            if (meshOperand !== undefined) {
              throw meshBooleanUnsupportedError(
                bodyName(document, meshOperand)
              );
            }
            const operands = feature.data.targetBodyIds.map((bodyId) => {
              const shape = result.shapes.get(bodyId);
              if (!shape) {
                throw new Error(`Boolean target ${bodyId} is unavailable.`);
              }
              return shape;
            });
            // Census the operands before the boolean consumes them. A faceted
            // fallback is only visible as a change in face count and surface
            // type, so both sides have to be measured.
            const operandCensus = censusOfSolids(
              kernel,
              operands.flatMap((shape) => shape.solids)
            );
            let solid: number;
            let unionFuseOperands: UnionFuseOperand[] | null = null;
            // A disconnected union is a different complaint with its own
            // remedy and its own warning; it must not also be reported as
            // non-manifold, nor be offered a move-to-overlap suggestion.
            let unionDisconnected = false;
            if (feature.data.operation === 'union') {
              const unionOperands = feature.data.targetBodyIds.flatMap(
                (bodyId, operandIndex) =>
                  operands[operandIndex]!.solids.map((candidate) => {
                    const bounds = kernel.boundingBox(candidate);
                    return {
                      solid: candidate,
                      name: bodyName(document, bodyId),
                      bounds: {
                        min: {
                          x: bounds[0]!,
                          y: bounds[1]!,
                          z: bounds[2]!
                        },
                        max: {
                          x: bounds[3]!,
                          y: bounds[4]!,
                          z: bounds[5]!
                        }
                      }
                    };
                  })
              );
              unionFuseOperands = unionOperands;
              const unionSolids = unionOperands.map((operand) => operand.solid);
              const connectivity = analyzeUnionConnectivity(
                unionOperands,
                (left, right) =>
                  kernel.solidToSolidDistance(left, right)[0] ?? NaN,
                (left, right) => {
                  try {
                    if (
                      kernel.volume(
                        kernel.intersect(left, right),
                        MEASUREMENT_DEFLECTION
                      ) > 0
                    ) {
                      return true;
                    }
                  } catch {
                    // Face contact has no shared volume, so fall through to
                    // the kernel's same-domain contact query.
                  }
                  try {
                    const contacts = JSON.parse(
                      kernel.detectCoincidentFaces(left, right)
                    ) as unknown;
                    return (
                      Array.isArray(contacts) &&
                      contacts.some(
                        (contact) =>
                          typeof contact === 'object' &&
                          contact !== null &&
                          (contact as { aabbOverlap?: unknown }).aabbOverlap ===
                            true
                      )
                    );
                  } catch {
                    return false;
                  }
                }
              );
              solid = fuseUniformSolid(kernel, unionSolids);
              const resultBounds = kernel.boundingBox(solid);
              const droppedOperand = droppedUnionOperandWarning({
                operands: unionOperands.map((operand) => {
                  const curvedExtents: {
                    min: Partial<Record<'x' | 'y' | 'z', boolean>>;
                    max: Partial<Record<'x' | 'y' | 'z', boolean>>;
                  } = { min: {}, max: {} };
                  const axes = ['x', 'y', 'z'] as const;
                  for (const face of kernel.getSolidFaces(operand.solid)) {
                    if (kernel.getSurfaceType(face) === 'plane') continue;
                    const faceBounds = tessellatedFaceBounds(kernel, face);
                    for (
                      let axisIndex = 0;
                      axisIndex < axes.length;
                      axisIndex++
                    ) {
                      const axis = axes[axisIndex]!;
                      const scale = Math.max(
                        1,
                        Math.abs(operand.bounds.min[axis]),
                        Math.abs(operand.bounds.max[axis])
                      );
                      const tolerance = geometryTolerance(scale);
                      if (
                        Math.abs(
                          faceBounds[axisIndex]! - operand.bounds.min[axis]
                        ) <= tolerance
                      ) {
                        curvedExtents.min[axis] = true;
                      }
                      if (
                        Math.abs(
                          faceBounds[axisIndex + 3]! - operand.bounds.max[axis]
                        ) <= tolerance
                      ) {
                        curvedExtents.max[axis] = true;
                      }
                    }
                  }
                  return {
                    name: operand.name,
                    bounds: operand.bounds,
                    curvedExtents
                  };
                }),
                result: {
                  min: {
                    x: resultBounds[0]!,
                    y: resultBounds[1]!,
                    z: resultBounds[2]!
                  },
                  max: {
                    x: resultBounds[3]!,
                    y: resultBounds[4]!,
                    z: resultBounds[5]!
                  }
                },
                units: document.units,
                approximationTolerance: MEASUREMENT_DEFLECTION
              });
              if (droppedOperand) {
                result.warnings.push(
                  `Feature "${feature.name}": ${droppedOperand}`
                );
              }
              if (
                !connectivity.connected &&
                !isFaceConnectedSolid(kernel, solid)
              ) {
                unionDisconnected = true;
                result.warnings.push(
                  `Feature "${feature.name}": ${disconnectedUnionWarning(
                    connectivity,
                    document.units
                  )}`
                );
              }
            } else {
              solid = collapseShape(kernel, operands[0]!);
              const subtracting = feature.data.operation === 'subtract';
              // Measured BEFORE any cutting, because afterwards there is
              // nothing left to compare against: a cut that silently does
              // nothing and a cut with nothing to do produce the same body.
              const volumeBeforeCut = subtracting
                ? kernel.volume(solid, MEASUREMENT_DEFLECTION)
                : 0;
              let sharedWithTools = 0;
              for (const operand of operands.slice(1)) {
                const tool = collapseShape(kernel, operand);
                if (subtracting) {
                  try {
                    sharedWithTools += kernel.volume(
                      kernel.intersect(
                        kernel.copySolid(solid),
                        kernel.copySolid(tool)
                      ),
                      MEASUREMENT_DEFLECTION
                    );
                  } catch {
                    // An intersect that refuses says nothing either way, and
                    // a guard is not the place to turn that into a claim.
                  }
                }
                solid = subtracting
                  ? (tryExactCoaxialCylinderCut(kernel, solid, tool) ??
                    kernel.cut(solid, tool))
                  : kernel.intersect(solid, tool);
              }
              solid = unifyBooleanFaces(kernel, solid);
              // A cut that removes too little of the material it demonstrably
              // overlaps. A cross-drilled shaft can come back closed, valid,
              // and nearly unchanged even though its bore has positive-volume
              // overlap. Every structural check passes; only these two
              // measurements disagree.
              //
              // Keep measuring against the target as it changes through the
              // existing sequential tool loop. That is normal multi-tool
              // subtract semantics: a later tool is only credited with the
              // material that remains after the earlier cuts.
              //
              // Publishing the result would confirm a subtract whose own
              // measurements say it did not take. Throw before consuming the
              // operands or recording the result body, so rebuild keeps the
              // target and tools visible and exportable instead.
              if (subtracting && sharedWithTools > GEOMETRY_EPSILON) {
                const removed =
                  volumeBeforeCut -
                  kernel.volume(solid, MEASUREMENT_DEFLECTION);
                const minimumRemoved =
                  sharedWithTools * MINIMUM_SUBTRACT_REMOVAL_RATIO;
                if (removed < minimumRemoved) {
                  const toolSubject =
                    operands.length === 2
                      ? 'the tool overlaps'
                      : 'the tools overlap';
                  throw new Error(
                    `Subtract refused: ${toolSubject} the target by ` +
                      `${formatMeasuredVolume(sharedWithTools)} ${document.units}³, ` +
                      `but the kernel removed ${formatMeasuredVolume(removed)} ${document.units}³; ` +
                      `the accepted minimum is ${formatMeasuredVolume(minimumRemoved)} ${document.units}³ ` +
                      `(${MINIMUM_SUBTRACT_REMOVAL_RATIO * 100}% of measured overlap). ` +
                      'The target and tools were left unchanged.'
                  );
                }
              }
            }
            // The face-count census. Mesh closure, validation and volume all
            // pass on a silently faceted boolean result; the faces do not.
            const facetFallback = booleanFacetFallbackWarning({
              operands: operandCensus,
              result: censusOfSolids(kernel, [solid])
            });
            // A tangency the fuse cannot resolve exactly does not always come
            // back faceted. Kernels differ on which way they fail it: one
            // drops to facets, another returns a body that is not a valid
            // solid at all. Both are the same complaint to the user, and both
            // are answered by the same move, so the refusal is classified on
            // either symptom rather than on faceting alone.
            const unionNotSolid =
              unionFuseOperands !== null &&
              !unionDisconnected &&
              (kernel.validateSolid(solid) !== 0 ||
                !solidMeshIsClosed(kernel, solid));
            // Which warning the proved move belongs to.
            //
            // This used to be the index of the feature's FIRST warning, on the
            // reasoning that a refused commit reports one reason and a remedy
            // filed behind it never gets read. That is true but it picked the
            // wrong warning: a dropped-operand or disconnected-union warning
            // can already sit there, and appending "moving X clears it" to one
            // of those attaches a remedy to a complaint it does not answer.
            // Track the refusal actually pushed here instead.
            let refusalIndex: number | null = null;
            if (facetFallback) {
              refusalIndex = result.warnings.length;
              result.warnings.push(
                `Feature "${feature.name}": ${facetFallback}`
              );
            } else if (unionNotSolid) {
              refusalIndex = result.warnings.length;
              // Deliberately the same sentence the strict validation pass
              // emits later. Saying it here instead means the proved move can
              // ride along with it — that pass runs far from the operands,
              // where they can no longer be probed. It also suppresses the
              // later copy, which declines once a feature-specific warning
              // exists.
              result.warnings.push(
                `Feature "${feature.name}": Union produced an open, ` +
                  'non-manifold, or inconsistently oriented result. Adjust ' +
                  'the overlap or placement and try again.'
              );
            }
            // Naming the move that works is only possible here, where the
            // operands are still addressable; by the time this reaches the
            // panel it is a sentence. Probing costs a fuse per candidate, so
            // it runs only for the failures it answers.
            // A disconnected union is a different complaint with its own
            // remedy, and closing that gap by sliding one body to the other's
            // centre is not advice anyone asked for.
            if (refusalIndex !== null && unionFuseOperands) {
              const suggestion = exactUnionOffsetSuggestion(
                kernel,
                unionFuseOperands,
                document.units
              );
              if (suggestion) {
                result.warnings[refusalIndex] =
                  `${result.warnings[refusalIndex]!} ${suggestion}`;
              }
            }
            feature.data.targetBodyIds.forEach((bodyId) =>
              result.consumed.add(bodyId)
            );
            result.shapes.set(feature.bodyId, {
              solids: [solid],
              lineage: remusHashOnlyLineage(
                'boolean',
                'The production boolean result may be face-unified after the kernel operation, so no unverified history payload is accepted.'
              )
            });
            break;
          }
          case 'fillet':
          case 'chamfer': {
            if (!feature.bodyId) {
              throw new Error('Edge modifier has no result body.');
            }
            const storedTarget = result.shapes.get(feature.data.targetBodyId);
            if (!storedTarget) {
              throw new Error('Edge modifier target is unavailable.');
            }
            const target = collapseShape(kernel, storedTarget);
            const { handles: selected, repairedReferences } =
              resolveEdgeModifierEdges(
                kernel,
                storedTarget,
                target,
                feature.data.edgeHashes,
                feature.data.edgeReferences
              );
            const size = resolveParamValue(
              feature.data.featureKind === 'fillet'
                ? feature.data.radius
                : feature.data.distance,
              scope,
              feature.data.featureKind === 'fillet' ? 'radius' : 'distance'
            );
            if (size <= GEOMETRY_EPSILON) {
              throw new Error('Edge modifier size must be greater than zero.');
            }
            let chamferAngleRadians: number | undefined;
            if (
              feature.data.featureKind === 'chamfer' &&
              feature.data.angleDeg !== undefined
            ) {
              const angleDeg = resolveParamValue(
                feature.data.angleDeg,
                scope,
                'angle'
              );
              // The kernel rejects angles at or past 90°; 45° exactly is the
              // symmetric chamfer, but an explicit 45 is honored as stored.
              if (!(angleDeg > 0 && angleDeg < 90)) {
                throw new Error(
                  'Chamfer angle must be strictly between 0 and 90 degrees.'
                );
              }
              chamferAngleRadians = (angleDeg * Math.PI) / 180;
            }
            let reportedRefusal: string | null = null;
            let evolution: FaceEvolutionPayloadV1 | null = null;
            const sourceCandidates = topologyCandidatesForSolid(kernel, target);
            const modified = applyEdgeModifier(
              kernel,
              target,
              selected,
              feature.data.featureKind,
              size,
              (message) => {
                reportedRefusal = message;
              },
              (payload) => {
                evolution = payload;
              },
              chamferAngleRadians
            );
            if (modified === null) {
              throw new Error(
                edgeModifierFailureMessage(
                  kernel,
                  target,
                  selected,
                  feature.data.featureKind,
                  size,
                  result.partialRevolveBodies.has(feature.data.targetBodyId),
                  reportedRefusal
                )
              );
            }
            const cylinderFallbackLineage = modifierChainRootsAtCylinder(
              document,
              feature.data.targetBodyId
            )
              ? rederiveCylinderModifierLineage(kernel, modified, feature)
              : null;
            const evolutionLineage = evolution
              ? createRemusModifierEvolutionLineage({
                  producingFeatureId: feature.featureId,
                  operation: feature.data.featureKind,
                  payload: evolution,
                  sourceSolid: target,
                  resultSolid: modified,
                  sourceCandidates,
                  resultCandidates: topologyCandidatesForSolid(
                    kernel,
                    modified
                  ),
                  sourceLineage: storedTarget.lineage,
                  generatedBlendFaces: new Set(
                    Array.from(kernel.getSolidFaces(modified)).filter((face) =>
                      isBlendFace(kernel, modified, face)
                    )
                  )
                })
              : null;
            const verifiedLineages = [
              cylinderFallbackLineage,
              evolutionLineage
            ].filter((lineage): lineage is RemusLineageState => !!lineage);
            const verifiedLineage = mergeRemusLineageStates(verifiedLineages);
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(feature.bodyId, {
              solids: [modified],
              lineage:
                verifiedLineage.faceReferences.size > 0 ||
                verifiedLineage.edgeReferences.size > 0 ||
                verifiedLineage.diagnostics.length > 0
                  ? verifiedLineage
                  : remusHashOnlyLineage(
                      feature.data.featureKind,
                      'No generated face passed the construction-history, exact support-witness, and uniqueness checks.'
                    )
            });
            inheritMeshOrigin(
              result,
              feature.data.targetBodyId,
              feature.bodyId
            );
            // Only a feature that actually rebuilt earns a repair: a thrown
            // modifier above skips this, and the legacy selection stays as it
            // was for the user to fix.
            if (repairedReferences) {
              result.referenceRepairs.push({
                featureId: feature.featureId,
                edgeReferences: repairedReferences
              });
            }
            break;
          }
          case 'pattern': {
            if (!feature.bodyId) {
              throw new Error('Pattern has no result body.');
            }
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Pattern target is unavailable.');
            }
            const count = Math.round(
              resolveParamValue(feature.data.count, scope, 'count')
            );
            if (count < 2 || count > 100) {
              throw new Error('Pattern count must be between 2 and 100.');
            }
            // Grid instance counts multiply, so the solid cap is enforced on
            // the total rather than per axis.
            const count2 =
              feature.data.patternKind === 'grid'
                ? Math.round(
                    resolveParamValue(
                      feature.data.count2 ?? feature.data.count,
                      scope,
                      'count 2'
                    )
                  )
                : 1;
            if (
              feature.data.patternKind === 'grid' &&
              (count2 < 2 || count2 > 100)
            ) {
              throw new Error('Pattern count must be between 2 and 100.');
            }
            const totalInstances = count * count2;
            if (target.solids.length * totalInstances > 100) {
              throw new Error('A pattern may produce at most 100 solids.');
            }
            const direction =
              feature.data.patternKind !== 'circular' && feature.data.direction
                ? resolvePatternDirection(feature.data.direction, scope)
                : axisDirection(feature.data.axis);
            const solids = [...target.solids];
            if (feature.data.patternKind === 'linear') {
              const spacing = resolveParamValue(
                feature.data.spacing,
                scope,
                'spacing'
              );
              if (Math.abs(spacing) <= GEOMETRY_EPSILON) {
                throw new Error('Pattern spacing cannot be zero.');
              }
              for (let index = 1; index < count; index += 1) {
                const instance = copyShape(
                  kernel,
                  target,
                  transformMatrix(
                    {
                      x: direction.x * spacing * index,
                      y: direction.y * spacing * index,
                      z: direction.z * spacing * index
                    },
                    { x: 0, y: 0, z: 0 }
                  )
                );
                solids.push(...instance.solids);
              }
            } else if (feature.data.patternKind === 'grid') {
              const spacing = resolveParamValue(
                feature.data.spacing,
                scope,
                'spacing'
              );
              const spacing2 = resolveParamValue(
                feature.data.spacing2 ?? feature.data.spacing,
                scope,
                'spacing 2'
              );
              if (
                Math.abs(spacing) <= GEOMETRY_EPSILON ||
                Math.abs(spacing2) <= GEOMETRY_EPSILON
              ) {
                throw new Error('Pattern spacing cannot be zero.');
              }
              const direction2 = axisDirection(feature.data.axis2 ?? 'y');
              const crossProduct = cross(direction, direction2);
              if (length(crossProduct) <= GEOMETRY_EPSILON) {
                throw new Error('Grid pattern directions cannot be parallel.');
              }
              for (let ix = 0; ix < count; ix += 1) {
                for (let iy = 0; iy < count2; iy += 1) {
                  if (ix === 0 && iy === 0) {
                    continue; // the original occupies (0, 0)
                  }
                  const instance = copyShape(
                    kernel,
                    target,
                    transformMatrix(
                      {
                        x:
                          direction.x * spacing * ix +
                          direction2.x * spacing2 * iy,
                        y:
                          direction.y * spacing * ix +
                          direction2.y * spacing2 * iy,
                        z:
                          direction.z * spacing * ix +
                          direction2.z * spacing2 * iy
                      },
                      { x: 0, y: 0, z: 0 }
                    )
                  );
                  solids.push(...instance.solids);
                }
              }
            } else {
              const angle = resolveParamValue(
                feature.data.angleDeg,
                scope,
                'pattern angle'
              );
              if (Math.abs(angle) <= GEOMETRY_EPSILON) {
                throw new Error('Pattern angle cannot be zero.');
              }
              const angleStep =
                Math.abs(Math.abs(angle) - 360) <= GEOMETRY_EPSILON
                  ? angle / count
                  : angle / (count - 1);
              for (let index = 1; index < count; index += 1) {
                const rotation = {
                  x: feature.data.axis === 'x' ? angleStep * index : 0,
                  y: feature.data.axis === 'y' ? angleStep * index : 0,
                  z: feature.data.axis === 'z' ? angleStep * index : 0
                };
                const instance = copyShape(
                  kernel,
                  target,
                  transformMatrix({ x: 0, y: 0, z: 0 }, rotation)
                );
                solids.push(...instance.solids);
              }
            }
            result.consumed.add(feature.data.targetBodyId);
            // Instances that interpenetrate have to become ONE solid before
            // anything measures them. Every consumer downstream — the volume
            // the Inspector prints, the STL writer, the mesh the viewport
            // draws — walks this list per solid and sums, so two overlapping
            // copies are counted twice and the interior walls are drawn. The
            // agreement between the reported volume and the enclosed mesh
            // volume is no defence: both sum the same list, so both are wrong
            // by exactly the same amount and neither can catch the other.
            //
            // Fusing is deliberately conditional. The disjoint case is the
            // overwhelmingly common one, it is already correct, and fusing it
            // would rebuild topology and re-key lineage for no change in any
            // number a user sees. So the fuse runs only where the sum is
            // actually wrong.
            const shared = sharedSolidVolume(kernel, solids);
            if (shared > 0) {
              const summed = solids.reduce(
                (total, instance) =>
                  total + kernel.volume(instance, MEASUREMENT_DEFLECTION),
                0
              );
              const fused = fuseUniformSolid(kernel, solids);
              const removed =
                summed - kernel.volume(fused, MEASUREMENT_DEFLECTION);
              // The fuse is NOT guaranteed to merge. On shallow overlaps it
              // returns the operands essentially untouched — measured on three
              // r5 h10 cylinders, by overlap depth (2r - d):
              //
              //   depth 1.0, 4.0  ->  9 faces, 0.6 of 58.8 shared removed
              //   depth 7.0, 9.5  -> 41 and 33 faces, merged
              //
              // Testing "did the volume stay equal to the sum" is too weak:
              // the fuse perturbs it by ~0.03% while merging nothing, which is
              // enough to clear any equality bar. So the test is whether it
              // removed a real share of the material the instances are KNOWN
              // to share, which was measured on the way in.
              //
              // Half is a deliberately loose bar. The pairwise total
              // overstates the true correction wherever three instances meet,
              // so a correct merge can legitimately remove less than all of
              // it; nothing near a working fuse removes under half.
              //
              // The body still stands either way — the instances are real and
              // the user asked for them. Silence is the only outcome ruled
              // out, because this defect survived precisely by being silent:
              // the reported volume and the enclosed mesh agreed, both summing
              // the same list.
              if (removed < shared * 0.5) {
                result.warnings.push(
                  `Feature "${feature.name}": instances overlap but the merge did not take, so the reported volume counts shared material more than once.`
                );
              }
              result.shapes.set(feature.bodyId, { solids: [fused] });
            } else {
              result.shapes.set(feature.bodyId, { solids });
            }
            inheritMeshOrigin(
              result,
              feature.data.targetBodyId,
              feature.bodyId
            );
            break;
          }
        }
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'exact geometry failed';
        result.warnings.push(`Feature "${feature.name}": ${reason}`);
      }
      onFeature?.(index, result);
    }
    return result;
  }

  /** Resolves a fingerprint to exactly one face handle, failing closed. */
  /**
   * Reference-first per ADR-013, exactly like fillet/chamfer edges: a stored
   * face hash embeds radius-dependent measurements (a cap's perimeter, a
   * wall's radius), so only the lineage identity survives an upstream
   * parametric edit. Operations saved without a v5 reference keep the hash
   * resolver and its diagnostics byte-for-byte; a v5 lineage failure is
   * terminal rather than falling back, so a stale reference can never land
   * silently on a neighbouring face.
   */
  private resolveDirectEditFace(
    kernel: RemusKernel,
    target: ExactShape,
    solid: number,
    operation: DirectEditOperation
  ): { face: number; viaLineage: boolean } {
    const reference = operation.faceReference;
    const lineage = target.solids.length === 1 ? target.lineage : undefined;
    if (!reference || !lineage) {
      return {
        face: this.resolveFaceByFingerprint(kernel, solid, operation.faceHash),
        viaLineage: false
      };
    }
    const candidates: TopologyResolutionCandidate[] = Array.from(
      kernel.getSolidFaces(solid),
      (handle) => {
        const witness = faceWitnessOf(kernel, handle);
        const lineageReference = lineage.faceReferences.get(handle);
        return {
          kind: 'face' as const,
          currentHash: topologyHashOfWitness('face', witness),
          witnessVersion: 1 as const,
          witness,
          ...(lineageReference
            ? {
                lineage: {
                  source: 'semantic' as const,
                  identity: {
                    producingFeatureId: lineageReference.producingFeatureId,
                    lineageName: lineageReference.lineageName
                  }
                }
              }
            : {}),
          value: handle
        };
      }
    );
    const resolution = resolveTopologyReference(reference, candidates);
    if (resolution.status === 'failed') {
      throw new Error(`Direct-edit face is stale: ${resolution.message}`);
    }
    if (typeof resolution.candidate.value !== 'number') {
      throw new Error('Direct-edit face resolved without a kernel handle.');
    }
    return { face: resolution.candidate.value, viaLineage: true };
  }

  private resolveFaceByFingerprint(
    kernel: RemusKernel,
    solid: number,
    faceHash: number
  ): number {
    const matches = faceHandlesByFingerprint(kernel, solid).get(faceHash) ?? [];
    if (matches.length === 0) {
      throw unresolvedReferenceError(
        'face',
        faceHash,
        Array.from(kernel.getSolidFaces(solid)).length
      );
    }
    if (matches.length > 1) {
      throw ambiguousReferenceError('face');
    }
    return matches[0]!;
  }

  /**
   * Replace a through-hole's bore with one at the requested diameter.
   *
   * OpenCascade plugs the bore and then cuts the new one through the closed
   * body. That is `(body ∪ bore) \ newBore`, and because the bore is void in
   * `body` and the extension past each end sits outside it, the same set is
   * reached with a single boolean: cutting the new bore straight through when
   * it is wider, or fusing the annulus between the two radii when it is
   * narrower. Both forms are exact and produce identical volumes — see the
   * cross-kernel agreement test — but the single boolean skips the plug fuse,
   * which Remus frequently declines to do analytically. The extension past
   * both ends is OpenCascade's, so a hole through a slanted opening is trimmed
   * identically on either kernel.
   */
  private resizeThroughHole(
    kernel: RemusKernel,
    solid: number,
    face: number,
    operation: Extract<DirectEditOperation, { kind: 'resize-through-hole' }>,
    scope: Record<string, number>
  ): number {
    const geometry = requireThroughHole(
      kernel,
      solid,
      face,
      operation.sourceDiameter,
      operation.sourceAxisStart,
      operation.sourceAxisEnd
    );
    const diameter = resolveParamValue(
      operation.diameter,
      scope,
      'through-hole diameter'
    );
    if (!Number.isFinite(diameter) || diameter <= DIRECT_EDIT_TOLERANCE) {
      throw new Error('Through-hole diameter must be greater than zero.');
    }
    const radius = diameter / 2;
    const radiusTolerance = Math.max(
      DIRECT_EDIT_TOLERANCE,
      geometry.radius * 1e-6
    );
    if (Math.abs(radius - geometry.radius) <= radiusTolerance) {
      if (operation.parameterBinding) {
        return solid;
      }
      throw new Error(
        'Through-hole diameter must differ from its current diameter.'
      );
    }
    const extension = Math.max(
      DIRECT_EDIT_TOLERANCE * 10,
      geometry.axialLength * 0.02,
      diameter * 0.01
    );
    const newBore = cylinderAlongAxis(
      kernel,
      geometry.axisStart,
      geometry.axisEnd,
      radius,
      extension
    );
    let output: number;
    try {
      output =
        radius > geometry.radius
          ? kernel.cut(solid, newBore)
          : kernel.fuse(
              solid,
              kernel.cut(
                cylinderAlongAxis(
                  kernel,
                  geometry.axisStart,
                  geometry.axisEnd,
                  geometry.radius
                ),
                newBore
              )
            );
    } catch (error) {
      throw new Error(
        `Through-hole diameter ${diameter} does not fit this body: ${
          error instanceof Error ? error.message : 'the kernel rejected the cut'
        }.`,
        { cause: error }
      );
    }
    kernel.unifyFaces(output);
    if (kernel.validateSolid(output) !== 0) {
      throw new Error(
        `Resizing the through-hole to diameter ${diameter} does not produce a valid solid.`
      );
    }
    // The kernel can clear its own gates and still hand back a degraded
    // result: a boolean that meets a coaxial cylindrical face may return the
    // untouched original, and the mesh fallback encloses the right space with
    // a wall of triangles instead of a cylinder. Read the bore back and insist
    // it is an analytic cylinder at the new radius, so either failure surfaces
    // as a failed feature rather than a gesture that looked like it worked.
    const axis = normalized(subtract(geometry.axisEnd, geometry.axisStart));
    if (!axis) {
      throw new Error('The selected face has a degenerate axis.');
    }
    const axisTolerance = Math.max(
      DIRECT_EDIT_TOLERANCE,
      geometry.axialLength * 1e-5,
      geometry.radius * 1e-5
    );
    const coaxialRadii = coaxialCylinderRadii(
      kernel,
      output,
      geometry.axisStart,
      axis,
      axisTolerance
    );
    const atRadius = (candidate: number): boolean =>
      coaxialRadii.some(
        (measured) => Math.abs(measured - candidate) <= radiusTolerance
      );
    if (!atRadius(radius)) {
      throw new Error(
        atRadius(geometry.radius)
          ? `The kernel left the hole at its original diameter instead of resizing it to ${diameter}.`
          : `The kernel returned no analytic bore at diameter ${diameter} — the wall came back as a mesh approximation.`
      );
    }
    return output;
  }

  /**
   * Remove the feature the selected face belongs to.
   *
   * A through-hole is closed by fusing a plug of its own radius, exactly as
   * OpenCascade does. Anything else goes to Remus's `defeature`, which
   * rebuilds the body from the planes of the faces it keeps and therefore
   * only accepts a body whose every remaining face is planar. That
   * precondition is checked before the call so an unsupported selection is
   * named rather than silently reassembled, and the reassembly itself is held
   * to strict solid validation because its failure mode is a closed-looking
   * body with the wrong walls.
   */
  private removeFaceFeature(
    kernel: RemusKernel,
    solid: number,
    face: number,
    geometry: FaceGeometry | undefined,
    operation: Extract<DirectEditOperation, { kind: 'remove-face-feature' }>
  ): number {
    if (geometry?.surfaceType !== operation.sourceSurfaceType) {
      throw new Error('Selected face no longer matches its recorded surface.');
    }
    // Face area comes from Remus's bounded-deflection integration rather
    // than an exact surface integral, so it is compared at the same relative
    // tolerance the planar offset uses. The centre is a vertex centroid and
    // is exact, so it keeps the direct-edit tolerance.
    const areaTolerance = Math.max(operation.sourceArea * 1e-5, 1e-9);
    const centerTolerance = Math.max(
      DIRECT_EDIT_TOLERANCE,
      Math.sqrt(Math.max(operation.sourceArea, 1)) * 1e-6
    );
    if (
      Math.abs(geometry.area - operation.sourceArea) > areaTolerance ||
      length(subtract(geometry.center, operation.sourceCenter)) >
        centerTolerance
    ) {
      throw new Error('Selected face no longer matches its recorded geometry.');
    }

    const isThroughHole =
      classifyThroughHoleFace(kernel, solid, face, geometry).status ===
      'through-hole';
    if (isThroughHole) {
      return fillThroughHole(
        kernel,
        solid,
        requireThroughHole(
          kernel,
          solid,
          face,
          operation.sourceDiameter,
          operation.sourceAxisStart,
          operation.sourceAxisEnd
        )
      );
    }

    const keptFaces = Array.from(kernel.getSolidFaces(solid)).filter(
      (handle) => handle !== face
    );
    const nonPlanar = new Set(
      keptFaces
        .map((handle) => kernel.getSurfaceType(handle))
        .filter((surfaceType) => surfaceType !== 'plane')
    );
    if (nonPlanar.size > 0) {
      throw new Error(
        `Removing a ${geometry.surfaceType} face needs Remus's defeature operation, which only supports bodies whose every remaining face is planar; this body still has ${[...nonPlanar].sort().join(', ')} faces.`
      );
    }
    if (keptFaces.length < 4) {
      throw new Error(
        'Removing the selected face would leave too few faces to bound a solid.'
      );
    }
    let output: number;
    try {
      output = kernel.defeature(solid, Uint32Array.from([face]));
    } catch (error) {
      throw new Error(
        `Removing the selected face failed: ${
          error instanceof Error
            ? error.message
            : 'the kernel rejected the defeature'
        }.`,
        { cause: error }
      );
    }
    kernel.unifyFaces(output);
    if (kernel.validateSolid(output) !== 0) {
      throw new Error(
        'Removing the selected face did not produce a valid solid.'
      );
    }
    return output;
  }

  /**
   * History-backed direct edits on the Remus path. Planar offsets and
   * cylindrical resizes are the kernel's own `pushPullFace` and
   * `resizeCylindricalFace`; through-hole resizes and feature removals build
   * their own tools from the selected face's analytic geometry. Each derives
   * its tool from the selected face, merges the seams the boolean leaves
   * behind, and refuses any result whose shell is not closed or whose surfaces
   * are not the ones the edit is defined to produce. Every source measurement
   * is re-validated against the rebuilt body first, so a drifted rebuild fails
   * closed instead of editing the wrong face.
   */
  private applyDirectEdit(
    kernel: RemusKernel,
    target: ExactShape,
    operation: DirectEditOperation,
    scope: Record<string, number>,
    producingFeatureId?: FeatureId
  ): ExactShape {
    assertDirectEditOperation(operation);
    const solid = collapseShape(kernel, target);
    const { face, viaLineage } = this.resolveDirectEditFace(
      kernel,
      target,
      solid,
      operation
    );
    if (operation.kind === 'resize-through-hole') {
      return {
        solids: [this.resizeThroughHole(kernel, solid, face, operation, scope)]
      };
    }

    const geometry = measureFaceGeometry(kernel, face);

    if (operation.kind === 'remove-face-feature') {
      return {
        solids: [
          this.removeFaceFeature(kernel, solid, face, geometry, operation)
        ]
      };
    }

    if (operation.kind === 'offset-face') {
      if (geometry?.surfaceType !== 'plane' || !geometry.normal) {
        throw new Error('The selected face is no longer planar.');
      }
      // The recorded-area pin proves a hash-resolved face is really the one
      // the user picked. A cap's area scales with the primitive radius, so
      // under a lineage-resolved face — where identity is already proven by
      // role — the pin would only forbid the parametric edits this operation
      // is defined to survive.
      const areaTolerance = Math.max(operation.sourceArea * 1e-5, 1e-9);
      if (
        !viaLineage &&
        Math.abs(geometry.area - operation.sourceArea) > areaTolerance
      ) {
        throw new Error(
          'The selected face no longer matches its recorded measurements.'
        );
      }
      const alignment =
        geometry.normal.x * operation.sourceNormal.x +
        geometry.normal.y * operation.sourceNormal.y +
        geometry.normal.z * operation.sourceNormal.z;
      if (Math.abs(alignment) < 1 - 1e-6) {
        throw new Error(
          'The selected face no longer matches its recorded orientation.'
        );
      }
      const offset = resolveParamValue(operation.offset, scope, 'offset');
      if (!Number.isFinite(offset) || Math.abs(offset) <= GEOMETRY_EPSILON) {
        throw new Error('Face offset must be a non-zero distance.');
      }
      // `pushPullFace` walks the face along the solid's own outward normal,
      // which is the direction the stored normal holds too — it came from the
      // picked triangle, not from the surface parameterization, so the sign
      // carries through unchanged even where the two disagree. A prismatic
      // move is worth exactly `offset * area`, and the kernel gates the result
      // on that, so a tool that reached material it should not have is
      // rejected rather than returned.
      const sourceCensus = censusOfSolids(kernel, [solid]);
      const output =
        tryExactAnalyticCylinderCapOffset(kernel, solid, face, offset) ??
        kernel.pushPullFace(solid, face, offset);
      if (kernel.validateSolidRelaxed(output) !== 0) {
        throw new Error(
          `Offsetting the face by ${offset} does not produce a valid solid.`
        );
      }
      // Closure and volume checks still accept Remus's triangulated fallback.
      // Preserve the last exact body instead of committing/exporting its facets.
      const facetFallback = directEditFacetFallbackWarning({
        operands: sourceCensus,
        result: censusOfSolids(kernel, [output])
      });
      if (facetFallback) {
        throw new Error(facetFallback);
      }
      return { solids: [output] };
    }

    if (operation.kind === 'resize-blend') {
      const snapshot = blendCarrierSnapshot(
        measureOwnedFaceGeometry(kernel, solid, face)
      );
      if (!snapshot || snapshot.surfaceClass !== operation.surfaceClass) {
        throw new Error(
          `The selected face is no longer an analytic ${operation.surfaceClass} blend.`
        );
      }
      const radiusTolerance = Math.max(operation.recordedRadius * 1e-5, 1e-9);
      if (
        Math.abs(snapshot.radius - operation.recordedRadius) > radiusTolerance
      ) {
        throw new Error(
          'The selected blend no longer matches its recorded radius.'
        );
      }
      const carrierTolerance = Math.max(operation.recordedRadius * 1e-5, 1e-6);
      if (
        length(subtract(snapshot.center, operation.recordedCenter)) >
        carrierTolerance
      ) {
        throw new Error(
          'The selected blend no longer matches its recorded carrier center.'
        );
      }
      const recordedAxis = normalized(operation.recordedAxis);
      if (
        !recordedAxis ||
        Math.abs(dot(snapshot.axis, recordedAxis)) < 1 - 1e-6
      ) {
        throw new Error(
          'The selected blend no longer matches its recorded carrier axis.'
        );
      }
      const newRadius = resolveParamValue(
        operation.newRadius,
        scope,
        'blend radius'
      );
      if (!Number.isFinite(newRadius) || newRadius < 0) {
        throw new Error('Blend radius must be zero or greater.');
      }
      if (Math.abs(newRadius - snapshot.radius) <= radiusTolerance) {
        throw new Error('Blend radius must differ from its current radius.');
      }
      const output = kernel.resizeBlend(
        solid,
        face,
        operation.recordedRadius,
        newRadius
      );
      if (kernel.validateSolid(output) !== 0) {
        throw new Error(
          `Resizing the blend to radius ${newRadius} does not produce a valid solid.`
        );
      }
      let lineage: RemusLineageState | undefined;
      if (newRadius > GEOMETRY_EPSILON) {
        const candidates = topologyCandidatesForSolid(kernel, output);
        const matching = candidates.filter((candidate) => {
          if (candidate.kind !== 'face') {
            return false;
          }
          const rebuilt = measureFaceGeometry(kernel, candidate.handle);
          const rebuiltRadius =
            rebuilt?.surfaceType === 'torus'
              ? rebuilt.minorRadius
              : rebuilt?.surfaceType === 'cylinder'
                ? rebuilt.radius
                : undefined;
          return (
            rebuilt?.surfaceType === operation.surfaceClass &&
            rebuiltRadius !== undefined &&
            Math.abs(rebuiltRadius - newRadius) <=
              Math.max(newRadius * 1e-5, 1e-9)
          );
        });
        if (matching.length === 0) {
          throw new Error(
            `The kernel returned no analytic blend at radius ${newRadius}.`
          );
        }
        if (matching.length === 1 && producingFeatureId) {
          lineage = createRemusSemanticLineage(
            producingFeatureId,
            'direct-edit',
            [
              {
                ...matching[0]!,
                lineageName: 'direct-edit.resize-blend.band'
              }
            ]
          );
        }
      }
      return { solids: [output], ...(lineage ? { lineage } : {}) };
    }

    // resize-cylindrical-face
    if (
      geometry?.surfaceType !== 'cylinder' ||
      geometry.radius === undefined ||
      !geometry.axisStart ||
      !geometry.axisEnd ||
      geometry.axialLength === undefined
    ) {
      throw new Error('The selected face is no longer cylindrical.');
    }
    const radiusTolerance = Math.max(operation.sourceRadius * 1e-5, 1e-9);
    if (Math.abs(geometry.radius - operation.sourceRadius) > radiusTolerance) {
      throw new Error(
        'The selected face no longer matches its recorded radius.'
      );
    }
    const axisTolerance = Math.max(
      geometry.axialLength * 1e-5,
      geometry.radius * 1e-5,
      1e-6
    );
    const nearlyEqual = (a: Vec3, b: Vec3): boolean =>
      Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= axisTolerance;
    const sameAxis =
      (nearlyEqual(geometry.axisStart, operation.sourceAxisStart) &&
        nearlyEqual(geometry.axisEnd, operation.sourceAxisEnd)) ||
      (nearlyEqual(geometry.axisStart, operation.sourceAxisEnd) &&
        nearlyEqual(geometry.axisEnd, operation.sourceAxisStart));
    if (!sameAxis) {
      throw new Error('The selected face no longer matches its recorded axis.');
    }
    const newRadius = resolveParamValue(operation.radius, scope, 'radius');
    if (!Number.isFinite(newRadius) || newRadius <= GEOMETRY_EPSILON) {
      throw new Error('Radius must be greater than zero.');
    }
    if (Math.abs(newRadius - geometry.radius) <= radiusTolerance) {
      throw new Error('Radius must differ from the current radius.');
    }
    const axisVector = {
      x: geometry.axisEnd.x - geometry.axisStart.x,
      y: geometry.axisEnd.y - geometry.axisStart.y,
      z: geometry.axisEnd.z - geometry.axisStart.z
    };
    const axisDir = normalized(axisVector);
    if (!axisDir) {
      throw new Error('The selected face has a degenerate axis.');
    }
    // `resizeCylindricalFace` reads the concavity off the face's own
    // orientation and builds the sleeve between the two radii itself — a
    // plain cylinder when the wall sweeps outward, an annular tube when it
    // sweeps back through material — so growing and shrinking are the same
    // call. The recorded `concavity` is now only a record of what the gesture
    // meant, and shrinking no longer has to fail closed.
    const output = kernel.resizeCylindricalFace(solid, face, newRadius);
    if (kernel.validateSolidRelaxed(output) !== 0) {
      throw new Error(
        `Resizing the face to radius ${newRadius} does not produce a valid solid.`
      );
    }
    // The kernel gates on a closed shell and on the volume the resize is
    // defined to produce, and a degraded result can still clear both: a
    // boolean that meets a coaxial cylindrical face may hand back the
    // untouched original, and a mesh-boolean fallback encloses the right
    // space with a wall of triangles instead of a cylinder. Read the wall
    // back and insist it is an analytic cylinder at the new radius, so either
    // failure surfaces as a failed feature rather than a gesture that looked
    // like it worked.
    const coaxialRadii = coaxialCylinderRadii(
      kernel,
      output,
      geometry.axisStart,
      axisDir,
      axisTolerance
    );
    const atRadius = (radius: number): boolean =>
      coaxialRadii.some(
        (candidate) => Math.abs(candidate - radius) <= radiusTolerance
      );
    if (!atRadius(newRadius)) {
      throw new Error(
        atRadius(geometry.radius)
          ? `The kernel left the face at its original size instead of resizing it to radius ${newRadius}.`
          : `The kernel returned no analytic cylinder at radius ${newRadius} — the wall came back as a mesh approximation.`
      );
    }
    return { solids: [output] };
  }

  /**
   * Total face handles across a body's solids — the measured-shape cache's
   * paranoia probe. One cheap kernel call per solid, against a stored count,
   * so an in-place mutation of a cached solid (which the handle-identity
   * invariant forbids) surfaces as a cache miss rather than a stale mesh.
   */
  private countFaceHandles(kernel: RemusKernel, solids: number[]): number {
    let count = 0;
    for (const solid of solids) {
      count += kernel.getSolidFaces(solid).length;
    }
    return count;
  }

  private measureShape(
    kernel: RemusKernel,
    shape: ExactShape,
    strictBooleanValidation = false
  ): MeasuredShape {
    if (shape.solids.length === 0) {
      throw new Error('Exact body contains no solids.');
    }
    const vertices: number[] = [];
    const indices: number[] = [];
    const lineageDiagnostics =
      shape.lineage?.diagnostics.map(projectRemusLineageDiagnostic) ?? [];
    const topology: BodyTopology = { faces: [], edges: [] };
    const bbox = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity }
    };
    let volume = 0;
    let valid = true;
    let strictValid = true;
    // Vertex ids are numbered across the whole body while the handle map below
    // is rebuilt per solid, so two solids that touch exactly — a linear pattern
    // whose spacing equals its extent — never share an id.
    let nextVertexId = 0;

    for (const solid of shape.solids) {
      const bounds = kernel.boundingBox(solid);
      const displayTessellation = displayTessellationForExtents(
        bounds[3]! - bounds[0]!,
        bounds[4]! - bounds[1]!,
        bounds[5]! - bounds[2]!
      );
      const faceHandles = Array.from(kernel.getSolidFaces(solid));
      const edgeToFaces = JSON.parse(kernel.edgeToFaceMap(solid)) as Record<
        string,
        number[]
      >;
      // Face handle -> ADR-011 hash, for translating the kernel's edge-to-face
      // map when the edge records are built below. Scoped to this solid:
      // `edgeToFaces` is per solid while `topology.faces` accumulates across
      // them, and face handles are only observed to be globally unique, not
      // contracted to be.
      const faceHashByHandle = new Map<number, number>();
      // Vertex handle -> body-scoped id, for the same reason and with the same
      // scoping: `getSolidVertices` is per solid, and vertex handles are only
      // observed to be globally unique, not contracted to be. Numbered from
      // the kernel's own vertex list rather than from the order edges happen
      // to name them, so the ids do not depend on the edge loop below.
      const vertexIdByHandle = new Map<number, number>();
      for (const vertex of kernel.getSolidVertices(solid)) {
        if (!vertexIdByHandle.has(vertex)) {
          vertexIdByHandle.set(vertex, nextVertexId);
          nextVertexId += 1;
        }
      }
      const mesh = kernel.tessellateSolidGroupedBinary(
        solid,
        displayTessellation.linearDeflection,
        displayTessellation.angularDeflection
      );
      try {
        const faceOffsets = Array.from(mesh.faceOffsets);
        const vertexOffset = vertices.length / 3;
        const indexOffset = indices.length;
        // Large curved bodies can cross V8's argument-count limit when copied
        // with `push(...typedArray)`. Iteration is bounded and avoids a second
        // full-sized mapped array while the WASM mesh is still alive.
        for (const position of mesh.positions) {
          vertices.push(position);
        }
        for (const index of mesh.indices) {
          indices.push(index + vertexOffset);
        }
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
          topology.faces.push({
            topologyId: `face:${hash}`,
            hash,
            reference: verifiedReference,
            triangleStart: (indexOffset + start) / 3,
            triangleCount: (end - start) / 3,
            geometry: measureOwnedFaceGeometry(kernel, solid, handle)
          });
        }
      } finally {
        mesh.free();
      }

      // Use the kernel's adaptive exact-curve sampler with the same chordal and
      // angular limits as the shaded mesh. This keeps circular outlines closed
      // and prevents a smooth edge from visibly drifting away from its surface.
      const edgeHandles = Array.from(kernel.getSolidEdges(solid));
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
            displayRole: brepEdgeDisplayRole(kernel, edge, edgeToFaces),
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

      bbox.min.x = Math.min(bbox.min.x, bounds[0]!);
      bbox.min.y = Math.min(bbox.min.y, bounds[1]!);
      bbox.min.z = Math.min(bbox.min.z, bounds[2]!);
      bbox.max.x = Math.max(bbox.max.x, bounds[3]!);
      bbox.max.y = Math.max(bbox.max.y, bounds[4]!);
      bbox.max.z = Math.max(bbox.max.z, bounds[5]!);
      volume += kernel.volume(solid, MEASUREMENT_DEFLECTION);
      valid = valid && kernel.validateSolidRelaxed(solid) === 0;
      if (strictBooleanValidation) {
        strictValid = kernel.validateSolid(solid) === 0 && strictValid;
      }
    }

    if (lineageDiagnostics.length > 0) {
      topology.lineageDiagnostics = lineageDiagnostics;
    }
    const meshClosure = strictBooleanValidation
      ? inspectTriangleMeshClosure(vertices, indices)
      : null;
    // Single-solid bodies only, and deliberately so. Combining moments across
    // solids means the parallel-axis theorem plus an eigendecomposition to
    // recover principal axes, and a body made of several solids that reported
    // the moments of one of them would be worse than reporting none. Absent
    // is a state consumers already have to render.
    const massProperties =
      shape.solids.length === 1
        ? readBodyMassProperties(kernel, shape.solids[0]!)
        : null;
    return {
      vertices,
      indices,
      topology,
      faceCount: topology.faces.length,
      volume,
      valid,
      strictValid,
      meshClosure,
      bbox,
      ...(massProperties ? { massProperties } : {})
    };
  }

  async syncDocument(document: ProjectDocument): Promise<DerivedState> {
    const { sources, pinned } = await this.prefetchImportSources(document);
    // The history kernel outlives this call on purpose — its checkpoints are
    // what the next sync restores. On ANY throw the whole cache is dropped:
    // a failed sync must never leave a table the next sync would trust.
    try {
      const { kernel, build, replayed, restored } =
        this.buildWithHistoryCache(document, sources, pinned);
      const bodies = listNodesByKind(document, 'body');
      const features = new Map(
        listNodesByKind(document, 'feature').map((feature) => [
          feature.featureId,
          feature
        ])
      );
      const bodyRepresentations: Record<BodyId, BodyRepresentation> = {};
      const exportableBodyIds: BodyId[] = [];
      // Entries for bodies this build no longer produces are dead weight —
      // and their handles may have been retired by a prefix restore.
      for (const bodyId of [...this.measuredShapeCache.keys()]) {
        if (!build.shapes.has(bodyId)) {
          this.evictMeasuredShape(bodyId);
        }
      }
      let remeasured = 0;
      let reusedMeasurements = 0;

      for (const bodyId of document.bodyOrder) {
        const body = bodies.find((candidate) => candidate.bodyId === bodyId);
        const shape = build.shapes.get(bodyId);
        if (!body || !shape) {
          continue;
        }
        const feature = features.get(body.featureId);
        const consumed = build.consumed.has(bodyId);
        const requiresStrictUnionValidation =
          !consumed &&
          feature?.data.featureKind === 'boolean' &&
          feature.data.operation === 'union';
        // Tessellation dominates a sync once the prefix cache removed the
        // replay cost, so an unchanged body serves its previous measurement.
        // Handle identity is the key (see MeasuredBodyCacheEntry); the
        // face-handle recount is a cheap probe that turns any violation of
        // that invariant into a re-measure instead of a stale mesh.
        const solidKey = shape.solids.join(',');
        const cached = this.measuredShapeCache.get(bodyId);
        let measured: MeasuredShape;
        if (
          cached &&
          cached.solidKey === solidKey &&
          cached.strict === requiresStrictUnionValidation &&
          this.countFaceHandles(kernel, shape.solids) ===
            cached.faceHandleCount
        ) {
          measured = cached.measured;
          reusedMeasurements += 1;
        } else {
          measured = this.measureShape(
            kernel,
            shape,
            requiresStrictUnionValidation
          );
          remeasured += 1;
          this.storeMeasuredShape(bodyId, {
            solidKey,
            strict: requiresStrictUnionValidation,
            faceHandleCount: this.countFaceHandles(kernel, shape.solids),
            bytes: measuredShapeBytes(measured),
            measured
          });
        }
        if (!measured.valid) {
          build.warnings.push(
            `Body "${body.name}" failed exact B-rep validation.`
          );
        }
        // K0.6 import taxonomy. Both warnings describe the imported FILE, so
        // they are driven by what the import measured rather than by the
        // body's state after later features edited it.
        const imported = build.importedStepDiagnostics.get(bodyId);
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
        if (
          requiresStrictUnionValidation &&
          feature !== undefined &&
          !build.warnings.some((warning) =>
            warning.startsWith(`Feature "${feature.name}":`)
          ) &&
          (!measured.strictValid ||
            measured.meshClosure === null ||
            !isClosedConsistentlyOrientedMesh(measured.meshClosure))
        ) {
          build.warnings.push(
            `Feature "${feature.name}": Union produced an open, non-manifold, or inconsistently oriented result. Adjust the overlap or placement and try again.`
          );
        }
        bodyRepresentations[bodyId] = {
          bodyId,
          name: body.name,
          source: feature?.featureKind ?? 'primitive',
          mesh: {
            kind: 'mesh',
            vertices: measured.vertices,
            indices: measured.indices
          },
          faceCount: measured.faceCount,
          color:
            String(
              body.metadata?.color ??
                featureColor(feature?.featureKind ?? 'primitive')
            ) || DEFAULT_BODY_COLOR,
          opacity: bodyOpacityFromMetadata(
            body.metadata?.[BODY_OPACITY_METADATA_KEY]
          ),
          exportableStep: body.exportableStep,
          consumed,
          volume: measured.volume,
          bbox: measured.bbox,
          // One kernel call per solid, inside the pass that already holds it.
          // Omitted rather than zeroed when it cannot be read, so a consumer
          // renders an absence instead of a massless part.
          ...(measured.massProperties
            ? { massProperties: measured.massProperties }
            : {}),
          topology: measured.topology
        };
        if (body.exportableStep && !consumed) {
          exportableBodyIds.push(bodyId);
        }
      }

      this.options.onRebuildCacheEvent?.({
        kind: restored > 0 ? 'prefix-restore' : 'full-rebuild',
        replayed,
        restored,
        remeasured,
        reusedMeasurements
      });
      return {
        bodyRepresentations,
        exportableBodyIds,
        warnings: build.warnings,
        updatedAt: nowIso(),
        ...(build.referenceRepairs.length > 0
          ? { referenceRepairs: build.referenceRepairs }
          : {})
      };
    } catch (error) {
      this.invalidateHistoryCache();
      throw error;
    }
  }

  async exportStep(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<string> {
    const { sources, pinned } = await this.prefetchImportSources(document);
    const kernel = new RemusKernel();
    try {
      const build = this.build(kernel, document, sources, pinned);
      const solids = bodyIds.flatMap((bodyId) => {
        const shape = build.shapes.get(bodyId);
        if (!shape) {
          throw new Error(`Body ${bodyId} has no exact geometry.`);
        }
        return shape.solids;
      });
      if (solids.length === 0) {
        throw new Error('Select at least one body to export.');
      }
      const millimeterScale = UNIT_TO_MM[document.units];
      const exportSolids =
        millimeterScale === 1
          ? solids
          : solids.map((solid) =>
              kernel.copyAndTransformSolid(
                solid,
                uniformScaleMatrix(millimeterScale)
              )
            );
      // Never fuse: a boolean union changes the geometry (overlaps merge,
      // coincident faces weld). The kernel writes each body as its own
      // MANIFOLD_SOLID_BREP inside one shape representation, so they stay
      // distinct through a round trip.
      return decodeText(kernel.exportStepMulti(new Uint32Array(exportSolids)));
    } finally {
      kernel.free();
    }
  }

  async exportStl(
    document: ProjectDocument,
    bodyIds: BodyId[],
    deflection: number = STL_EXPORT_DEFLECTION
  ): Promise<string> {
    const { sources, pinned } = await this.prefetchImportSources(document);
    const kernel = new RemusKernel();
    try {
      const build = this.build(kernel, document, sources, pinned);
      const solids = bodyIds.flatMap((bodyId) => {
        const shape = build.shapes.get(bodyId);
        if (!shape) {
          throw new Error(`Body ${bodyId} has no exact geometry.`);
        }
        return shape.solids;
      });
      if (solids.length === 0) {
        throw new Error('Select at least one body to export.');
      }
      const millimeterScale = UNIT_TO_MM[document.units];
      const exportSolids =
        millimeterScale === 1
          ? solids
          : solids.map((solid) =>
              kernel.copyAndTransformSolid(
                solid,
                uniformScaleMatrix(millimeterScale)
              )
            );
      if (exportSolids.length === 1) {
        return decodeText(kernel.exportStlAscii(exportSolids[0]!, deflection));
      }
      // Several consumers stop at the first `solid` block, so a multi-body
      // export must be one block containing every body's facets.
      const meshes = exportSolids.map((solid, index) => {
        const mesh = kernel.tessellateSolidGroupedBinary(solid, deflection);
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
    } finally {
      kernel.free();
    }
  }

  async exportMesh(
    document: ProjectDocument,
    bodyIds: BodyId[],
    options: { format: MeshExportFormat; deflection: number }
  ): Promise<Uint8Array<ArrayBuffer>> {
    const { format, deflection } = options;
    if (!Number.isFinite(deflection) || deflection <= 0) {
      throw new Error('Mesh export deflection must be a positive number.');
    }
    if (format === 'stl-ascii') {
      return new TextEncoder().encode(
        await this.exportStl(document, bodyIds, deflection)
      );
    }
    const { sources, pinned } = await this.prefetchImportSources(document);
    const kernel = new RemusKernel();
    try {
      const build = this.build(kernel, document, sources, pinned);
      const solids = bodyIds.flatMap((bodyId) => {
        const shape = build.shapes.get(bodyId);
        if (!shape) {
          throw new Error(`Body ${bodyId} has no exact geometry.`);
        }
        return shape.solids;
      });
      if (solids.length === 0) {
        throw new Error('Select at least one body to export.');
      }
      const millimeterScale = UNIT_TO_MM[document.units];
      const exportSolids =
        millimeterScale === 1
          ? solids
          : solids.map((solid) =>
              kernel.copyAndTransformSolid(
                solid,
                uniformScaleMatrix(millimeterScale)
              )
            );
      const handles = new Uint32Array(exportSolids);
      // Every writer takes the whole solid list: bodies stay distinct
      // objects in the 3MF package and merge into one facet stream for the
      // mesh formats — the shapes their consumers expect. wasm-bindgen
      // copies the Vec<u8> into a fresh, never-shared buffer, so the
      // narrowing holds.
      const bytes =
        format === '3mf'
          ? kernel.export3mfMulti(handles, deflection)
          : format === 'obj'
            ? kernel.exportObjMulti(handles, deflection)
            : format === 'glb'
              ? kernel.exportGlbMulti(handles, deflection)
              : kernel.exportStlMulti(handles, deflection);
      return bytes as Uint8Array<ArrayBuffer>;
    } finally {
      kernel.free();
    }
  }

  async meshQuality(
    document: ProjectDocument,
    bodyIds: BodyId[],
    deflection: number
  ): Promise<MeshQualityReport> {
    if (!Number.isFinite(deflection) || deflection <= 0) {
      throw new Error('Mesh quality deflection must be a positive number.');
    }
    const { sources, pinned } = await this.prefetchImportSources(document);
    const kernel = new RemusKernel();
    try {
      const build = this.build(kernel, document, sources, pinned);
      const millimeterScale = UNIT_TO_MM[document.units];
      const bodies: BodyMeshQuality[] = bodyIds.map((bodyId) => {
        const shape = build.shapes.get(bodyId);
        if (!shape) {
          throw new Error(`Body ${bodyId} has no exact geometry.`);
        }
        let boundaryEdges = 0;
        let nonManifoldEdges = 0;
        // A body with no solids has nothing to print, which is a failed
        // check, not a vacuous pass.
        let watertight = shape.solids.length > 0;
        for (const solid of shape.solids) {
          // Checked in the same millimetre space the export tessellates, so
          // the verdict describes the file the user is about to write.
          const measured =
            millimeterScale === 1
              ? solid
              : kernel.copyAndTransformSolid(
                  solid,
                  uniformScaleMatrix(millimeterScale)
                );
          const quality = readMeshQuality(
            kernel.meshQuality(measured, deflection)
          );
          boundaryEdges += quality.boundaryEdges;
          nonManifoldEdges += quality.nonManifoldEdges;
          watertight &&= quality.isWatertight;
        }
        return { bodyId, boundaryEdges, nonManifoldEdges, watertight };
      });
      return {
        watertight:
          bodies.length > 0 && bodies.every((body) => body.watertight),
        bodies
      };
    } finally {
      kernel.free();
    }
  }

  // Synchronous under the hood, but async like every adapter method so the
  // worker boundary and a future off-thread solver need no signature change.
  async solveSketch(
    document: ProjectDocument,
    sketchId: SketchId
  ): Promise<SketchSolveOutcome> {
    const sketch = findSketch(document, sketchId);
    if (!sketch) {
      throw new Error(`Sketch ${sketchId} not found.`);
    }
    const { scope, errors } = getParameterScope(document);
    if (errors.length > 0) {
      throw new Error(`Parameters failed to evaluate: ${errors.join('; ')}`);
    }
    const objects: ResolvedSketchObject[] = [];
    for (const objectId of sketch.objectIds) {
      const node = document.nodes[objectId];
      if (!node || node.kind !== 'sketch-object') {
        continue;
      }
      const data = node.data;
      // Rectangles, polygons, and text are not solvable geometry in v1;
      // document validation refuses constraints that reference them, so
      // skipping them here cannot orphan a constraint.
      if (data.objectKind === 'line') {
        objects.push({
          objectId,
          kind: 'line',
          x1: resolveParamValue(data.x1, scope, 'x1'),
          y1: resolveParamValue(data.y1, scope, 'y1'),
          x2: resolveParamValue(data.x2, scope, 'x2'),
          y2: resolveParamValue(data.y2, scope, 'y2')
        });
      } else if (data.objectKind === 'circle') {
        objects.push({
          objectId,
          kind: 'circle',
          centerX: resolveParamValue(data.centerX, scope, 'centerX'),
          centerY: resolveParamValue(data.centerY, scope, 'centerY'),
          radius: resolveParamValue(data.radius, scope, 'radius')
        });
      } else if (data.objectKind === 'arc') {
        objects.push({
          objectId,
          kind: 'arc',
          centerX: resolveParamValue(data.centerX, scope, 'centerX'),
          centerY: resolveParamValue(data.centerY, scope, 'centerY'),
          radius: resolveParamValue(data.radius, scope, 'radius'),
          startAngleDeg: resolveParamValue(
            data.startAngleDeg,
            scope,
            'startAngleDeg'
          ),
          endAngleDeg: resolveParamValue(data.endAngleDeg, scope, 'endAngleDeg')
        });
      }
    }
    const kernel = new RemusKernel();
    try {
      return solveSketchWithGcs(
        kernel,
        objects,
        sketch.constraints ?? [],
        (value, label) => resolveParamValue(value, scope, label)
      );
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
    reason?: string;
  }> {
    const kernel = new RemusKernel();
    try {
      const bytes =
        typeof data === 'string'
          ? new TextEncoder().encode(data)
          : new Uint8Array(data);
      let declared: number[];
      try {
        declared = Array.from(importStepWithOwnBudget(kernel, bytes));
      } catch (error) {
        return {
          solid: false,
          valid: false,
          volume: 0,
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
        valid:
          declared.length > 0 &&
          verdicts.every((verdict) => verdict.kind === 'solid'),
        volume: accepted.reduce(
          (total, solid) =>
            total + kernel.volume(solid, MEASUREMENT_DEFLECTION),
          0
        ),
        ...(declared.length === 0
          ? { reason: 'STEP file contains no solids.' }
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

  dispose(): void {
    // Export and solve methods own short-lived kernels, but the history
    // kernel and its checkpoints are adapter-scoped and must be released.
    this.invalidateHistoryCache();
  }
}

/**
 * Remus builds every document, imported STEP included.
 *
 * Until Z3 a document carrying an `imported-step` feature rerouted WHOLE to
 * OpenCascade, so an import and everything modelled on top of it were built by
 * a second kernel. That reroute is gone and Z5 removed the second kernel from
 * this package: there is one kernel, one code path, and `kind` is a constant.
 * The OpenCascade adapter survives only as the parity corpus's reference
 * implementation, in `test/parity/occt-reference/`, and nothing in the shipped
 * app can reach it.
 */
export async function createExactKernelAdapter(
  options: ExactKernelAdapterOptions = {}
): Promise<ExactKernelAdapter> {
  return new RemusKernelAdapter(options);
}
