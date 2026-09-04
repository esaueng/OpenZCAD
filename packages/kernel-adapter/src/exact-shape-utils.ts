/**
 * Shape lifecycle odds and ends shared by the adapter's build, export, and
 * direct-edit paths: serialise/restore copies with verified lineage, solid
 * validation, mesh import, and small formatting/metadata readers.
 */
import type { RemusKernel } from './remus-runtime';
import { remusTranslators } from './remus-runtime';
import type { Vec3 } from '@openzcad/geometry';
import type {
  BodyId,
  ParamValue,
  ProjectDocument,
  TopologyLineageDiagnostic
} from '@openzcad/shared';
import type { FaceAttachmentCandidate } from './face-attachment';
import type { ExactBuildResult, ExactShape } from './exact-types';
import { listNodesByKind, resolveParamValue } from '@openzcad/document-core';
import {
  mergeRemusLineageStates,
  propagateRemusRigidTransformLineage,
  remusHashOnlyLineage,
  type RemusLineageState
} from './remus-lineage';
import { topologyHashOfWitness } from './topology-lineage';
import { topologyCandidatesForSolid } from './exact-lineage-builders';
import { measureFaceGeometry } from './exact-measure';
import { MEASUREMENT_DEFLECTION, faceWitnessOf } from './exact-witnesses';
import { GEOMETRY_EPSILON } from './exact-math';

export /** Sewing gap for imported meshes, relative to the mesh's largest extent. */
const MESH_SEW_TOLERANCE_RATIO = 1e-6;

export function formatMeasuredVolume(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 0.001 || magnitude >= 1_000_000)) {
    return value.toExponential(3);
  }
  return Number(value.toPrecision(7)).toString();
}

/**
 * Per-body display opacity rides body metadata through the derived projection.
 * Anything that is not a finite number (unset, legacy string, NaN) means
 * "fully opaque" and stays absent so opaque bodies keep the fast render path.
 */
export function bodyOpacityFromMetadata(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const clamped = Math.min(1, Math.max(0, value));
  return clamped >= 1 ? undefined : clamped;
}

export function resolveParametricPoint(
  value: { x: ParamValue; y: ParamValue; z: ParamValue },
  scope: Record<string, number>,
  label: string
): Vec3 {
  return {
    x: resolveParamValue(value.x, scope, `${label} X`),
    y: resolveParamValue(value.y, scope, `${label} Y`),
    z: resolveParamValue(value.z, scope, `${label} Z`)
  };
}

export function validateGeneratedSolid(
  kernel: RemusKernel,
  solid: number,
  label: string
): number {
  if (!Number.isSafeInteger(solid) || solid < 0) {
    throw new Error(`${label} produced no solid.`);
  }
  if (kernel.validateSolid(solid) !== 0) {
    throw new Error(`${label} did not produce a valid closed solid.`);
  }
  const volume = kernel.volume(solid, MEASUREMENT_DEFLECTION);
  if (!Number.isFinite(volume) || volume <= 0) {
    throw new Error(`${label} did not produce a finite positive volume.`);
  }
  return solid;
}

export function faceAttachmentCandidatesForShape(
  kernel: RemusKernel,
  shape: ExactShape
): FaceAttachmentCandidate[] {
  return shape.solids.flatMap((solid) =>
    Array.from(kernel.getSolidFaces(solid), (handle) => {
      const witness = faceWitnessOf(kernel, handle);
      const reference = shape.lineage?.faceReferences.get(handle);
      const geometry = measureFaceGeometry(kernel, handle);
      const plane =
        geometry?.surfaceType.toLowerCase() === 'plane' &&
        geometry.normal !== undefined
          ? {
              center: geometry.center,
              centroid: geometry.centroid ?? null,
              normal: geometry.normal
            }
          : null;
      return {
        kind: 'face' as const,
        currentHash: topologyHashOfWitness('face', witness),
        witnessVersion: 1 as const,
        witness,
        plane,
        ...(reference
          ? {
              lineage: {
                source: 'derived' as const,
                identity: {
                  producingFeatureId: reference.producingFeatureId,
                  lineageName: reference.lineageName
                }
              }
            }
          : {})
      };
    })
  );
}

export function copyShape(
  kernel: RemusKernel,
  shape: ExactShape,
  matrix: Float64Array
): ExactShape {
  return {
    solids: shape.solids.map((solid) =>
      kernel.copyAndTransformSolid(solid, matrix)
    )
  };
}

export function copyShapeWithVerifiedLineage(
  kernel: RemusKernel,
  shape: ExactShape,
  matrix: Float64Array
): ExactShape {
  const solids: number[] = [];
  if (!shape.lineage) {
    return {
      solids: shape.solids.map((solid) =>
        kernel.copyAndTransformSolid(solid, matrix)
      ),
      lineage: remusHashOnlyLineage(
        'rigid-transform',
        'The source body has no verified topology lineage.'
      )
    };
  }

  const lineages = shape.solids.map((sourceSolid, index) => {
    const resultSolid = kernel.copyAndTransformSolid(sourceSolid, matrix);
    solids.push(resultSolid);
    const sourceFaces = new Set(kernel.getSolidFaces(sourceSolid));
    const sourceEdges = new Set(kernel.getSolidEdges(sourceSolid));
    const source: RemusLineageState = {
      faceReferences: new Map(
        [...shape.lineage!.faceReferences].filter(([handle]) =>
          sourceFaces.has(handle)
        )
      ),
      edgeReferences: new Map(
        [...shape.lineage!.edgeReferences].filter(([handle]) =>
          sourceEdges.has(handle)
        )
      ),
      diagnostics: index === 0 ? [...shape.lineage!.diagnostics] : []
    };
    return propagateRemusRigidTransformLineage(
      source,
      topologyCandidatesForSolid(kernel, resultSolid),
      Array.from(matrix)
    );
  });
  return { solids, lineage: mergeRemusLineageStates(lineages) };
}

export function projectRemusLineageDiagnostic(
  diagnostic: RemusLineageState['diagnostics'][number]
): TopologyLineageDiagnostic {
  const status: TopologyLineageDiagnostic['status'] =
    diagnostic.code === 'hash-only'
      ? 'hash-only'
      : diagnostic.code === 'transform-deleted'
        ? 'deleted'
        : diagnostic.code === 'transform-split'
          ? 'split'
          : diagnostic.code === 'transform-merge'
            ? 'merged'
            : diagnostic.code === 'ambiguous-semantic-role'
              ? 'ambiguous'
              : 'unsupported';
  return {
    kind: diagnostic.topologyKind ?? 'body',
    status,
    topologyId: diagnostic.lineageName,
    message: diagnostic.message
  };
}

/**
 * Bring an imported mesh into the kernel as a body it can actually model with.
 *
 * Remus's STL importer emits one face per triangle and does not share edges
 * between them, so the result fails strict validation and every modeling
 * operation refuses it. Sewing restores the shared-edge topology, and unifying
 * same-domain faces recovers the planar faces a tessellator split up — an
 * imported cube comes back as six faces, not twelve triangles, so a user can
 * select, mirror, shell and offset it like any other body.
 *
 * The repair is topological only: the measured volume and bounds must survive
 * it unchanged. If they do not, or the mesh cannot be sewn at all, the import
 * fails by name instead of publishing a body whose geometry silently drifted.
 */
export function importMeshSolid(kernel: RemusKernel, stlText: string): number {
  const imported = kernel.deserializeSolid(
    remusTranslators().importStl(new TextEncoder().encode(stlText))
  );
  const faces = kernel.getSolidFaces(imported);
  if (faces.length < 2) {
    throw new Error(
      'An imported mesh needs at least two triangles to form a body.'
    );
  }
  const bounds = Array.from(kernel.boundingBox(imported));
  const volume = kernel.volume(imported, MEASUREMENT_DEFLECTION);
  const scale = Math.max(
    1,
    bounds[3]! - bounds[0]!,
    bounds[4]! - bounds[1]!,
    bounds[5]! - bounds[2]!
  );

  let repaired: number;
  try {
    const sewn = kernel.sewFaces(faces, scale * MESH_SEW_TOLERANCE_RATIO);
    const healed = kernel.runHealPipeline(sewn, ['unify_same_domain']) as
      string | { solid?: number };
    const parsed = (
      typeof healed === 'string' ? JSON.parse(healed) : healed
    ) as { solid?: number };
    repaired = typeof parsed.solid === 'number' ? parsed.solid : sewn;
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'unknown kernel error';
    throw new Error(
      `This mesh could not be sewn into a shell the kernel can model with: ${detail}`,
      { cause: error }
    );
  }

  const repairedBounds = Array.from(kernel.boundingBox(repaired));
  const repairedVolume = kernel.volume(repaired, MEASUREMENT_DEFLECTION);
  const linearTolerance = Math.max(GEOMETRY_EPSILON, scale * 1e-6);
  if (
    repairedBounds.length !== bounds.length ||
    repairedBounds.some(
      (coordinate, index) =>
        Math.abs(coordinate - bounds[index]!) > linearTolerance
    ) ||
    Math.abs(repairedVolume - volume) >
      Math.max(linearTolerance ** 3, Math.abs(volume) * 1e-6)
  ) {
    throw new Error(
      'Sewing this mesh changed its size, so the import was refused rather than publishing altered geometry.'
    );
  }
  return repaired;
}

export function bodyName(document: ProjectDocument, bodyId: BodyId): string {
  return (
    listNodesByKind(document, 'body').find(
      (candidate) => candidate.bodyId === bodyId
    )?.name ?? String(bodyId)
  );
}

/**
 * Carry the imported-mesh origin onto a body derived from one. Mirroring,
 * shelling or offsetting a mesh still leaves a facet shell, so the derived
 * body must refuse booleans for the same reason its source does.
 */
export function inheritMeshOrigin(
  result: ExactBuildResult,
  source: BodyId,
  derived: BodyId | undefined
): void {
  if (derived !== undefined && result.meshBodies.has(source)) {
    result.meshBodies.add(derived);
  }
  // A wedge stays a wedge through a transform, mirror, pattern or shell, so
  // the edge-modifier advice below has to travel with it.
  if (derived !== undefined && result.partialRevolveBodies.has(source)) {
    result.partialRevolveBodies.add(derived);
  }
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Keep Remus's hostile-input budgets for every source. A locally selected
 * file can later be shared or restored, so its origin does not make it trusted.
 *
 * The translator parses in its own scratch topology and hands back an arena
 * document; a file with no solids hands back no bytes, which is the empty
 * handle list rather than a document to restore.
 */
export function importStepWithOwnBudget(
  kernel: RemusKernel,
  bytes: Uint8Array
): Uint32Array {
  const solids = remusTranslators().importStep(
    bytes,
    128 * 1024 * 1024,
    2_000_000
  );
  return solids.length === 0
    ? new Uint32Array()
    : kernel.deserializeSolids(solids);
}

/**
 * Mesh export formats the adapter can produce. `stl` is ASCII for
 * compatibility with consumers that diff or parse the text; `stl-binary` is
 * the same facets at 5–10× smaller; `3mf` is the zipped package modern
 * slicers prefer; `obj` and `glb` serve DCC and web/AR consumers, each as
 * one merged mesh.
 */
export type MeshExportFormat =
  'stl-ascii' | 'stl-binary' | '3mf' | 'obj' | 'glb';

/** Per-body watertightness verdict from the kernel's welded-mesh counter. */
export interface BodyMeshQuality {
  bodyId: BodyId;
  /** Edges used by exactly one triangle after position welding. */
  boundaryEdges: number;
  /** Edges used by more than two triangles after position welding. */
  nonManifoldEdges: number;
  watertight: boolean;
}

export interface MeshQualityReport {
  /** True only when every exported body is individually watertight. */
  watertight: boolean;
  bodies: BodyMeshQuality[];
}

/**
 * The `meshQuality` binding is typed `any` and returns a JSON string. Parse
 * defensively so a malformed payload reads as a raised error rather than a
 * passing check — this result gates whether an export is called printable.
 */
export function readMeshQuality(raw: unknown): {
  boundaryEdges: number;
  nonManifoldEdges: number;
  isWatertight: boolean;
} {
  let payload: unknown = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('The kernel returned an unreadable mesh-quality result.');
  }
  const record = payload as Record<string, unknown>;
  const { boundaryEdges, nonManifoldEdges, isWatertight } = record;
  if (
    typeof boundaryEdges !== 'number' ||
    !Number.isFinite(boundaryEdges) ||
    typeof nonManifoldEdges !== 'number' ||
    !Number.isFinite(nonManifoldEdges) ||
    typeof isWatertight !== 'boolean'
  ) {
    throw new Error('The kernel returned an unreadable mesh-quality result.');
  }
  return { boundaryEdges, nonManifoldEdges, isWatertight };
}
