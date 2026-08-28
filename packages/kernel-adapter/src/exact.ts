import { RemusKernel } from './remus-runtime';
import {
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  listNodesByKind,
  resolveParamValue
} from '@openzcad/document-core';
import { writeDxf } from '@openzcad/io-dxf';
import { writeAsciiStl } from '@openzcad/io-stl';
import { faceDxfEntities } from './exact-dxf';
import {
  BODY_OPACITY_METADATA_KEY,
  DEFAULT_BODY_COLOR,
  UNIT_TO_MM,
  featureColor,
  isFeatureSuppressed,
  nowIso,
  type ArtifactId,
  type BodyId,
  type BodyRepresentation,
  type BodyTopology,
  type DerivedState,
  type FaceDistanceMoveMode,
  type FaceGeometry,
  type FaceTopology,
  type ImportedSourceReference,
  type OpposingPlanarFacePair,
  type ProjectDocument,
  type SketchId,
  type Vector3
} from '@openzcad/shared';
import type {
  DxfFaceSelector,
  ExactBuildResult,
  ExactShape,
  ImportedStepDiagnostics,
  MeasuredShape
} from './exact-types';
export type { DxfFaceSelector } from './exact-types';
import { diagnoseImportedSolid } from './exact-lineage-builders';
import { measureOwnedFaceGeometry } from './exact-measure';
import {
  collectRecognizedImportedFeatures,
  type ImportedRecognitionFaceIdentity
} from './imported-feature-query';
import { collapseShape } from './exact-boolean-helpers';
import {
  bodyOpacityFromMetadata,
  decodeText,
  importStepWithOwnBudget,
  projectRemusLineageDiagnostic
} from './exact-shape-utils';
import {
  buildDocumentHistory,
  type CachedImportedStep,
  type ImportedStepStore
} from './exact-build-loop';
import {
  countFaceHandles,
  resolveDirectEditFace
} from './exact-direct-edit-ops';
import {
  MEASUREMENT_DEFLECTION,
  edgeWitnessOf,
  faceWitnessOf
} from './exact-witnesses';
import {
  brepAdjacentFaceHashes,
  brepEdgeCurve,
  brepEdgeDisplayRole,
  brepVertexIds
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
import { dot, length, subtract, uniformScaleMatrix } from './exact-math';
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
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from './boolean-result-validation';
import {
  topologyHashOfWitness,
  topologyWitnessesEqual
} from './topology-lineage';
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
import {
  faceDistancePairScore,
  pairNormalVector,
  proveChangedFaceDistance,
  queryOpposingPlanarFacePairs,
  type RemusOpposingPlanarFacePair
} from './exact-face-distance';

const STL_EXPORT_DEFLECTION = 0.08;
const MAX_PLANAR_FACE_PAIR_QUERY_FACES = 512;
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
  claimedFaceHashes: ReadonlySet<number>
): OpposingPlanarFacePair[] {
  if (faces.size > MAX_PLANAR_FACE_PAIR_QUERY_FACES) {
    return [];
  }
  const ranked = queryOpposingPlanarFacePairs(kernel, solid).sort(
    (left, right) =>
      faceDistancePairScore(right) - faceDistancePairScore(left) ||
      right.distance - left.distance ||
      left.faceA - right.faceA ||
      left.faceB - right.faceB
  );
  const seenPlanes = new Set<string>();
  const published: OpposingPlanarFacePair[] = [];
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
  syncDocument(document: ProjectDocument): Promise<DerivedState>;
  exportStep(document: ProjectDocument, bodyIds: BodyId[]): Promise<string>;
  /**
   * DXF R12 outline of one PLANAR face, in millimetres — the laser-cutting
   * export. Fails closed on non-planar faces and stale face references.
   */
  exportFaceDxf(
    document: ProjectDocument,
    face: DxfFaceSelector
  ): Promise<string>;
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

/** Bodies whose exact geometry descends from an imported STEP feature. */
function importedExactBodyIds(document: ProjectDocument): Set<BodyId> {
  const imported = new Set<BodyId>();
  for (const feature of listFeaturesInOrder(document)) {
    if (isFeatureSuppressed(feature)) {
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

  /** The build loop's read/write seam onto {@link importedStepCache}. */
  private readonly importedSteps: ImportedStepStore = {
    lookup: (checksum) => this.importedStepCache.get(checksum),
    store: (
      checksum,
      kernel,
      solids,
      acceptedDeclaredIndices,
      diagnostics,
      pinned
    ) =>
      this.storeImportedStep(
        checksum,
        kernel,
        solids,
        acceptedDeclaredIndices,
        diagnostics,
        pinned
      )
  };
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

    const build = buildDocumentHistory(
      activeKernel,
      document,
      importSources,
      pinnedImports,
      initial ? { startIndex, initial } : undefined,
      this.importedSteps,
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
    acceptedDeclaredIndices: number[],
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
    this.importedStepCache.set(checksum, {
      solids: serialized,
      acceptedDeclaredIndices,
      diagnostics
    });
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

  private measureShape(
    kernel: RemusKernel,
    shape: ExactShape,
    strictBooleanValidation = false,
    recognizeImportedFeatures = false
  ): MeasuredShape {
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
      const faceTopologyByHandle = new Map<number, FaceTopology>();
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
        const vertexOffset = vertexFloatCount / 3;
        const indexOffset = indexCount;
        // `slice` copies out of the WASM heap while the mesh is still alive;
        // the shifted index copy applies the body-scoped vertex offset in the
        // same pass.
        const positions = mesh.positions.slice();
        const meshIndices = mesh.indices;
        const shifted = new Uint32Array(meshIndices.length);
        for (let i = 0; i < meshIndices.length; i += 1) {
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
            geometry: measureOwnedFaceGeometry(kernel, solid, handle)
          };
          faceTopologyByHandle.set(handle, publishedFace);
          topology.faces.push(publishedFace);
        }
      } finally {
        mesh.free();
      }
      let claimedFaceHashes = new Set<number>();
      if (recognizeImportedFeatures) {
        const recognized = collectRecognizedImportedFeatures(
          kernel,
          solid,
          recognitionIdentities
        );
        if (recognized.length > 0) {
          topology.recognizedImportedFeatures ??= [];
          topology.recognizedImportedFeatures.push(...recognized);
          claimedFaceHashes = new Set(
            recognized.flatMap((feature) => feature.participatingFaceHashes)
          );
        }
        // Replay collapses a body before direct edit, so a proof against only
        // one member of a multi-solid body would authorize different topology.
        const pairs =
          shape.solids.length === 1
            ? provenOpposingPlanarFacePairs(
                kernel,
                solid,
                faceTopologyByHandle,
                bounds,
                claimedFaceHashes
              )
            : [];
        if (pairs.length > 0) {
          topology.opposingPlanarFacePairs ??= [];
          topology.opposingPlanarFacePairs.push(...pairs);
        }
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
    const vertices = new Float32Array(vertexFloatCount);
    const indices = new Uint32Array(indexCount);
    {
      let offset = 0;
      for (const chunk of vertexChunks) {
        vertices.set(chunk, offset);
        offset += chunk.length;
      }
      offset = 0;
      for (const chunk of indexChunks) {
        indices.set(chunk, offset);
        offset += chunk.length;
      }
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
      const { kernel, build, replayed, restored } = this.buildWithHistoryCache(
        document,
        sources,
        pinned
      );
      const bodies = listNodesByKind(document, 'body');
      const features = new Map(
        listNodesByKind(document, 'feature').map((feature) => [
          feature.featureId,
          feature
        ])
      );
      const importedBodyIds = importedExactBodyIds(document);
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
        const recognizeImportedFeatures = importedBodyIds.has(bodyId);
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
          cached.recognizedImportedFeatures === recognizeImportedFeatures &&
          countFaceHandles(kernel, shape.solids) === cached.faceHandleCount
        ) {
          measured = cached.measured;
          reusedMeasurements += 1;
        } else {
          measured = this.measureShape(
            kernel,
            shape,
            requiresStrictUnionValidation,
            recognizeImportedFeatures
          );
          remeasured += 1;
          this.storeMeasuredShape(bodyId, {
            solidKey,
            strict: requiresStrictUnionValidation,
            recognizedImportedFeatures: recognizeImportedFeatures,
            faceHandleCount: countFaceHandles(kernel, shape.solids),
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
          ...(imported
            ? { importedStepDeclaredSolidCount: imported.declaredSolidCount }
            : {}),
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
          : {}),
        ...(build.featureWarnings?.length
          ? { featureWarnings: build.featureWarnings }
          : {})
      };
    } catch (error) {
      this.invalidateHistoryCache();
      throw error;
    }
  }

  /**
   * Runs `operate` against a build of `document` on the long-lived history
   * kernel instead of a throwaway one. Right after a sync this is a full
   * prefix restore — zero features replayed — which is what makes "export
   * doesn't rebuild the model" true.
   *
   * The kernel is restored to the last feature checkpoint afterwards, so
   * anything the operation allocated (unit-scaling solid copies, tessellation
   * scratch) vanishes and the checkpoint table stays sound for the next sync.
   * With checkpointing disabled (over-cap histories) there is nothing to
   * restore to, so the cache is invalidated exactly as a thrown sync would —
   * the next sync rebuilds from scratch either way.
   */
  private async withExportBuild<T>(
    document: ProjectDocument,
    operate: (kernel: RemusKernel, build: ExactBuildResult) => T
  ): Promise<T> {
    const { sources, pinned } = await this.prefetchImportSources(document);
    const { kernel, build } = this.buildWithHistoryCache(
      document,
      sources,
      pinned
    );
    try {
      return operate(kernel, build);
    } finally {
      const last = this.historyCheckpoints.length - 1;
      if (last >= 0) {
        try {
          kernel.restore(this.historyCheckpoints[last]!.checkpointId);
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
    bodyIds: BodyId[]
  ): number[] {
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
    return millimeterScale === 1
      ? solids
      : solids.map((solid) =>
          kernel.copyAndTransformSolid(
            solid,
            uniformScaleMatrix(millimeterScale)
          )
        );
  }

  async exportStep(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<string> {
    return this.withExportBuild(document, (kernel, build) => {
      const exportSolids = this.exportSolidsFor(
        kernel,
        build,
        document,
        bodyIds
      );
      // Never fuse: a boolean union changes the geometry (overlaps merge,
      // coincident faces weld). The kernel writes each body as its own
      // MANIFOLD_SOLID_BREP inside one shape representation, so they stay
      // distinct through a round trip.
      return decodeText(kernel.exportStepMulti(new Uint32Array(exportSolids)));
    });
  }

  async exportFaceDxf(
    document: ProjectDocument,
    face: DxfFaceSelector
  ): Promise<string> {
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
        UNIT_TO_MM[document.units]
      );
      return writeDxf(entities);
    });
  }

  async exportStl(
    document: ProjectDocument,
    bodyIds: BodyId[],
    deflection: number = STL_EXPORT_DEFLECTION
  ): Promise<string> {
    return this.withExportBuild(document, (kernel, build) => {
      const exportSolids = this.exportSolidsFor(
        kernel,
        build,
        document,
        bodyIds
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
    });
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
    return this.withExportBuild(document, (kernel, build) => {
      const exportSolids = this.exportSolidsFor(
        kernel,
        build,
        document,
        bodyIds
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
    });
  }

  async meshQuality(
    document: ProjectDocument,
    bodyIds: BodyId[],
    deflection: number
  ): Promise<MeshQualityReport> {
    if (!Number.isFinite(deflection) || deflection <= 0) {
      throw new Error('Mesh quality deflection must be a positive number.');
    }
    return this.withExportBuild(document, (kernel, build) => {
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
    });
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
