import { RemusKernel, type FaceEvolutionPayloadV1 } from './remus-runtime';
import {
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  listNodesByKind,
  resolveParamValue
} from '@openzcad/document-core';
import {
  GEOMETRY_LINEAR_TOLERANCE,
  circleProfile,
  frameForPlaneRef,
  geometryTolerance,
  mergeAdjacentProfiles,
  polygonProfile,
  rectangleProfile,
  type PlaneBasis,
  type SketchRegion,
  type Vec2,
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
  type EdgeCurve,
  type EdgeReferenceRepair,
  type EdgeTopologyReferenceV5,
  type EdgeWitnessV1,
  type BodyMassProperties,
  type FaceAreaProvenance,
  type FaceGeometry,
  type FaceTopologyReferenceV5,
  type FaceWitnessV1,
  type FeatureId,
  type FeatureNode,
  type ImportedSourceReference,
  type ProjectDocument,
  type SketchId,
  type QuantizedTopologyPoint,
  type ParamValue,
  type SketchNode,
  type SketchObjectData,
  type SketchPathReference,
  type SketchSectionReference,
  type TopologyLineageDiagnostic
} from '@openzcad/shared';
import type {
  ExactBuildResult,
  ExactShape,
  ImportedStepDiagnostics,
  MeasuredShape
} from './exact-types';
import {
  addEdgeWitnessRole,
  addFaceCarrierRole,
  addUniqueSemanticAssignment,
  buildExtrudeLineage,
  buildPrimitiveLineage,
  buildRevolveLineage,
  cylinderCarrier,
  diagnoseImportedSolid,
  expectedCircleWitness,
  expectedLineWitness,
  modifierChainRootsAtCylinder,
  planeCarrier,
  rederiveCylinderModifierLineage,
  rederivePrimitiveDirectEditLineage,
  sameAnalyticCarrier,
  samePoint,
  topologyCandidatesForSolid
} from './exact-lineage-builders';
import {
  MEASUREMENT_DEFLECTION,
  analyticParamsSignature,
  edgeFingerprint,
  edgeHandlesByFingerprint,
  edgeSampleOf,
  edgeWitnessOf,
  faceFingerprint,
  faceHandlesByFingerprint,
  faceWitnessOf,
  legacyEdgeFingerprint,
  legacyFaceFingerprint,
  quantizedDirectionOf,
  quantizedPoint,
  registerHandle,
  remusFaceClosure
} from './exact-witnesses';
import {
  BLEND_TANGENCY_TOLERANCE,
  brepAdjacentFaceHashes,
  brepEdgeCurve,
  brepEdgeDisplayRole,
  brepVertexIds,
  edgeCircleMisfit,
  faceVertexCentroid,
  isBlendFace,
  readAnalyticCylinder,
  sameSphereSurface,
  selectionTouchesBlendFace,
  type AnalyticCylinder
} from './exact-brep';
export { brepEdgeCurve, edgeCircleMisfit } from './exact-brep';
import {
  GEOMETRY_EPSILON,
  add,
  axisDirection,
  coordinateFrameMatrix,
  cross,
  dot,
  errorText,
  finiteVec3,
  length,
  normalized,
  pointAt,
  pointOnPlane,
  positiveFinite,
  profilePoints,
  quantizeEdgeCoordinate,
  scale,
  subtract,
  transformMatrix,
  uniformScaleMatrix
} from './exact-math';
import { displayTessellationForExtents } from './display-tessellation';
import { readBodyMassProperties } from './body-properties';
import {
  booleanFacetFallbackWarning,
  censusOfSolids,
  countFaceConnectedComponents,
  directEditFacetFallbackWarning,
  droppedUnionOperandWarning,
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh,
  selectSafelyUnifiedSolid,
  type TriangleMeshClosure
} from './boolean-result-validation';
import { importedMeshStl, meshBooleanUnsupportedError } from './imported-mesh';
import { connectedRegionGroups, resolveRegionProfiles } from './region-profile';
import {
  extrudeBoundsCanShareVolume,
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
  disconnectedUnionWarning,
  type UnionBounds
} from './union-connectivity';
import {
  ambiguousReferenceError,
  canonicalDirection,
  canonicalizeDirection,
  cylinderAnalyticSignature,
  edgeFingerprintOf,
  faceFingerprintOf,
  isClosedEdge,
  planeAnalyticSignature,
  quantizeCoordinate,
  unresolvedReferenceError,
  type EdgeSample
} from './topology-fingerprint';
import {
  remusHashOnlyLineage,
  createRemusImportedStepLineage,
  createRemusModifierEvolutionLineage,
  createRemusSemanticLineage,
  mergeRemusLineageStates,
  propagateRemusRigidTransformLineage,
  type RemusLineageState,
  type RemusSemanticAssignment,
  type RemusTopologyCandidate
} from './remus-lineage';
import {
  resolveTopologyReference,
  topologyHashOfWitness,
  topologyWitnessesEqual,
  type TopologyResolutionCandidate
} from './topology-lineage';
import {
  resolveFaceAttachment,
  type FaceAttachmentCandidate
} from './face-attachment';
import {
  classifyImportedSolid,
  importedStepDroppedSolidWarning,
  importedStepNoSolidError,
  importedStepRejectedSolidSummary,
  importedStepValidationWarning,
  type ImportedSolidDiagnosis
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

function formatMeasuredVolume(value: number): string {
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
function bodyOpacityFromMetadata(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const clamped = Math.min(1, Math.max(0, value));
  return clamped >= 1 ? undefined : clamped;
}
/** Sewing gap for imported meshes, relative to the mesh's largest extent. */
const MESH_SEW_TOLERANCE_RATIO = 1e-6;
const CURVE_SEGMENTS = 32;
/** `liftCurve2dToPlane` curve types: 0 line, 1 circle, 2 ellipse, 3 NURBS. */
const NURBS_CURVE_TYPE = 3;
const ANALYTIC_MATCH_EPSILON = 1e-7;
/**
 * Fractions of a refused fillet/chamfer size retried to tell a size-bound
 * failure from a structural one. A ladder rather than one probe because the
 * kernel has a small-feature floor as well as a large-feature limit, so a
 * single deep probe can fail on a selection that a halved size would carry.
 */
const EDGE_MODIFIER_PROBE_RATIOS = [1 / 2, 1 / 8, 1 / 64] as const;
const DIRECT_EDIT_TOLERANCE = 1e-6;
const FULL_REVOLUTION = Math.PI * 2;

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

function resolveParametricPoint(
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

function validateGeneratedSolid(
  kernel: RemusKernel,
  solid: number,
  label: string
): number {
  if (!Number.isSafeInteger(solid) || solid < 0) {
    throw new Error(`${label} did not return a solid handle.`);
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

/** Revolve a radial/axial section around local +Z, then place it in world space. */
function revolveRadialProfile(
  kernel: RemusKernel,
  profile: Vec2[],
  cylinder: AnalyticCylinder
): number {
  const edges = profile.map((point, index) => {
    const next = profile[(index + 1) % profile.length]!;
    return kernel.makeLineEdge(point.x, 0, point.y, next.x, 0, next.y);
  });
  const wire = kernel.makeWire(Uint32Array.from(edges), true);
  const face = kernel.makePlanarFaceFromWire(wire);
  const local = kernel.revolve(face, 0, 0, 0, 0, 0, 1, 360);
  return kernel.copyAndTransformSolid(
    local,
    coordinateFrameMatrix(cylinder.origin, cylinder.axis)
  );
}

interface UnionFuseOperand {
  solid: number;
  name: string;
  bounds: UnionBounds;
}

/**
 * A move that turns a faceted union into an exact one, or nothing.
 *
 * The fuse facets where the operands meet tangentially, which for the shapes
 * this workspace makes is almost always an axis or a face sitting exactly in
 * one of the other operand's face planes. That is where a new primitive
 * lands: a box is corner-origin and a cylinder is axis-origin, so creating
 * one of each puts the cylinder's axis on the box's corner edge, and the
 * repair a user reaches for first — slide it along X — keeps the axis in the
 * y = 0 plane and fails again.
 *
 * So the remedy is worth naming exactly rather than describing. Each
 * candidate is TRIED, on copies, and only offered once the fuse it produces
 * is measured exact: a suggestion that does not work is worse than the
 * general advice it replaces, and this is the same reason
 * `edgeModifierSucceedsSmaller` probes instead of inferring.
 */
/**
 * Whether one solid tessellates to a closed, consistently oriented mesh —
 * the same question the strict union validation asks later, asked early.
 *
 * It has to be the same question. The refusal copy is emitted once: here if a
 * union is unacceptable, and by the strict pass otherwise. If these two
 * disagree, either a union is refused twice or the proved move never reaches
 * the sentence it belongs to. Both go through `inspectTriangleMeshClosure`
 * with the deflection the display pass picks for the body's own extents.
 */
function solidMeshIsClosed(kernel: RemusKernel, solid: number): boolean {
  try {
    const bounds = kernel.boundingBox(solid);
    const tessellation = displayTessellationForExtents(
      bounds[3]! - bounds[0]!,
      bounds[4]! - bounds[1]!,
      bounds[5]! - bounds[2]!
    );
    const mesh = kernel.tessellateSolidGroupedBinary(
      solid,
      tessellation.linearDeflection,
      tessellation.angularDeflection
    );
    try {
      return isClosedConsistentlyOrientedMesh(
        inspectTriangleMeshClosure(mesh.positions, mesh.indices)
      );
    } finally {
      mesh.free();
    }
  } catch {
    // A body that cannot even be tessellated is not one to offer a move for.
    return false;
  }
}

function exactUnionOffsetSuggestion(
  kernel: RemusKernel,
  operands: readonly UnionFuseOperand[],
  units: string
): string | null {
  if (operands.length !== 2) {
    return null;
  }
  const [anchor, mover] = operands as [UnionFuseOperand, UnionFuseOperand];
  const centre = (bounds: UnionBounds, axis: 'x' | 'y' | 'z') =>
    (bounds.min[axis] + bounds.max[axis]) / 2;
  const axes = ['x', 'y', 'z'] as const;
  const toCentre = {
    x: centre(anchor.bounds, 'x') - centre(mover.bounds, 'x'),
    y: centre(anchor.bounds, 'y') - centre(mover.bounds, 'y'),
    z: centre(anchor.bounds, 'z') - centre(mover.bounds, 'z')
  };
  // One axis first, because a single number is the easiest move to carry out.
  // A ball or a ring created against the box's corner needs all three before
  // it sits anywhere clean, so the combined move is tried after them.
  const candidates: { x: number; y: number; z: number }[] = [
    ...axes.map((axis) => ({
      x: axis === 'x' ? toCentre.x : 0,
      y: axis === 'y' ? toCentre.y : 0,
      z: axis === 'z' ? toCentre.z : 0
    })),
    toCentre
  ];
  const operandCensus = censusOfSolids(kernel, [anchor.solid, mover.solid]);
  const format = (value: number) => {
    const rounded = Number(
      Math.abs(value) < 1 ? value.toFixed(3) : value.toFixed(2)
    );
    return `${rounded > 0 ? '+' : ''}${rounded}`;
  };
  for (const offset of candidates) {
    const moves = axes.filter(
      (axis) => Math.abs(offset[axis]) > GEOMETRY_EPSILON
    );
    if (moves.length === 0) {
      continue;
    }
    let candidate: number;
    try {
      const moved = kernel.copySolid(mover.solid);
      kernel.transformSolid(
        moved,
        transformMatrix(offset, { x: 0, y: 0, z: 0 })
      );
      // Through `fuseUniformSolid`, the same call the real union makes, not a
      // bare `fuseAll`. The unification step it adds is not cosmetic: without
      // it a candidate can fail the solid check below that the actual edit
      // would have accepted, and the probe then reports no move exists when
      // one plainly does.
      candidate = fuseUniformSolid(kernel, [
        kernel.copySolid(anchor.solid),
        moved
      ]);
    } catch {
      continue;
    }
    // A candidate that swallows the mover inside the anchor also loses every
    // curved face, so it fails this same check rather than being offered as a
    // move that makes the user's new body disappear.
    if (
      booleanFacetFallbackWarning({
        operands: operandCensus,
        result: censusOfSolids(kernel, [candidate])
      }) !== null
    ) {
      continue;
    }
    // And it has to be a solid. Faceting is not the only way a tangency
    // fails, so clearing the facet check alone would let this offer a move
    // that trades one refusal for the other — worse than the general advice
    // it replaces, which is the one thing this must never be.
    try {
      if (
        kernel.validateSolid(candidate) !== 0 ||
        !solidMeshIsClosed(kernel, candidate)
      ) {
        continue;
      }
    } catch {
      continue;
    }
    const described = moves
      .map(
        (axis) => `${format(offset[axis])} ${units} in ${axis.toUpperCase()}`
      )
      .join(', ');
    return `Moving ${mover.name} ${described} clears it.`;
  }
  return null;
}

/**
 * Run one edge modifier and apply every acceptance rule the adapter ships a
 * result under, returning `null` when the kernel refused or produced a body
 * this adapter will not accept.
 *
 * This is the single definition of "the edit worked". The failure classifier
 * probes through it too, so a probe can never accept a result the real edit
 * would have rejected — which is exactly how a truthful "try a smaller size"
 * turns into a lie.
 */
function applyEdgeModifier(
  kernel: RemusKernel,
  target: number,
  selected: number[],
  featureKind: 'fillet' | 'chamfer',
  size: number,
  /** Receives the kernel's own refusal text, when it threw one. */
  reportRefusal?: (message: string) => void,
  /** Receives construction history only after the same result is accepted. */
  reportEvolution?: (payload: FaceEvolutionPayloadV1) => void
): number | null {
  const targetBounds = kernel.boundingBox(target);
  const handles = Uint32Array.from(selected);
  let modified: number;
  let evolution: FaceEvolutionPayloadV1 | undefined;
  if (featureKind === 'fillet') {
    try {
      if (reportEvolution) {
        try {
          evolution = kernel.filletWithEvolution(target, handles, size);
          modified = evolution.result.solid;
        } catch {
          modified = kernel.fillet(target, handles, size);
        }
      } else {
        modified = kernel.fillet(target, handles, size);
      }
    } catch (error) {
      // Keep what the kernel said. It names the edges it could not blend, the
      // vertex the blend engines gave up on, and how many of the selection
      // would round on their own — none of which can be recovered by
      // inspecting the inputs afterwards.
      reportRefusal?.(errorText(error));
      modified = target;
    }
  } else {
    try {
      if (reportEvolution) {
        try {
          evolution = kernel.chamferWithEvolution(target, handles, size);
          modified = evolution.result.solid;
        } catch {
          modified = kernel.chamfer(target, handles, size);
        }
      } else {
        modified = kernel.chamfer(target, handles, size);
      }
    } catch (error) {
      reportRefusal?.(errorText(error));
      return null;
    }
  }
  // When a blend cannot be attached at all, Remus falls back to returning
  // the input handle. That is a failed feature, not a successful no-op.
  if (modified === target || kernel.validateSolidRelaxed(modified) !== 0) {
    return null;
  }
  if (featureKind === 'fillet') {
    // A fillet rounds material inside the target envelope. Remus can return
    // a closed but severely distorted fallback for an oversized radius,
    // expanding the body to the requested size. Reject that result rather
    // than guessing a radius limit from the selected edge's length: the valid
    // limit is set by its adjacent faces, and can be larger than half the
    // edge length.
    const modifiedBounds = kernel.boundingBox(modified);
    const boundsScale = [0, 1, 2].reduce(
      (maximum, axis) =>
        Math.max(maximum, targetBounds[axis + 3]! - targetBounds[axis]!),
      1
    );
    const tolerance = Math.max(
      GEOMETRY_EPSILON,
      boundsScale * GEOMETRY_LINEAR_TOLERANCE
    );
    if (
      modifiedBounds[0]! < targetBounds[0]! - tolerance ||
      modifiedBounds[1]! < targetBounds[1]! - tolerance ||
      modifiedBounds[2]! < targetBounds[2]! - tolerance ||
      modifiedBounds[3]! > targetBounds[3]! + tolerance ||
      modifiedBounds[4]! > targetBounds[4]! + tolerance ||
      modifiedBounds[5]! > targetBounds[5]! + tolerance
    ) {
      return null;
    }

    // A valid fillet changes material only inside a neighbourhood of its
    // selected edges. A closed, in-bounds fallback can still be corrupt: the
    // partial-revolve blender has returned an internally doubled solid with
    // twice the source volume. Bound the possible change by a deliberately
    // generous radius-2r tube plus one radius-2r ball per selected edge. This
    // scales as volume, allows concave as well as convex blends, and rejects
    // topology duplication that bounds and relaxed validation cannot see.
    const neighbourhoodRadius = size * 2;
    const selectedLength = selected.reduce(
      (total, edge) => total + kernel.edgeLength(edge),
      0
    );
    const volumeEnvelope =
      Math.PI * neighbourhoodRadius ** 2 * selectedLength +
      selected.length * ((4 / 3) * Math.PI * neighbourhoodRadius ** 3);
    const targetVolume = kernel.volume(target, MEASUREMENT_DEFLECTION);
    const modifiedVolume = kernel.volume(modified, MEASUREMENT_DEFLECTION);
    const volumeTolerance = Math.max(1, Math.abs(targetVolume)) * 1e-6;
    if (
      Math.abs(modifiedVolume - targetVolume) >
      volumeEnvelope + volumeTolerance
    ) {
      return null;
    }
  }
  if (evolution) {
    reportEvolution?.(evolution);
  }
  return modified;
}

/**
 * True when the same selection is ACCEPTED at some size below the one that
 * failed, which is the only sound evidence that a failure is size-bound
 * rather than structural. Runs on the failure path only.
 */
function edgeModifierSucceedsSmaller(
  kernel: RemusKernel,
  target: number,
  selected: number[],
  featureKind: 'fillet' | 'chamfer',
  size: number
): boolean {
  return EDGE_MODIFIER_PROBE_RATIOS.some((ratio) => {
    const probe = size * ratio;
    if (!Number.isFinite(probe) || probe <= GEOMETRY_EPSILON) {
      return false;
    }
    try {
      return (
        applyEdgeModifier(kernel, target, selected, featureKind, probe) !== null
      );
    } catch {
      return false;
    }
  });
}

/**
 * Cause-aware failure message for an edge modifier the kernel refused.
 *
 * The kernel reports why its blender stopped, but not whether the selection
 * could ever work, so that question is answered the only way that is sound:
 * by retrying the same selection at a ladder of smaller sizes. A probe that
 * is accepted means the failure is size-bound and the actionable advice is a
 * smaller size. A ladder that fails everywhere means the cause is structural,
 * and it is named from the selection's topology — a closed rim, a corner
 * chain, or an edge ending on an existing blend.
 *
 * The probe is what keeps those structural messages true. They used to be
 * unconditional because corner chains and closed rims on a boolean-result
 * body failed at EVERY size (docs/qa/2026-08-01). The kernel's blend phases
 * changed that: on the plate from that investigation the hole rim now rounds
 * up to r2.24 and the corner chain up to r2, so an unconditional "cannot be
 * rounded at any radius" would now be false, and would bury the advice that
 * actually works.
 *
 * `partialRevolveTarget` is the one cause the selection's own topology cannot
 * reveal, because a wedge's edges look ordinary — plain lines and arcs, no
 * closed rim, no blend face. It is passed in from the build, where the
 * feature that produced the body is known. It is still reported only after
 * the size ladder has failed, so it never buries a working smaller size.
 */
/**
 * Turns the kernel's own blend refusal into the sentence a user can act on.
 *
 * The kernel reports how many of the named edges it could not blend and how
 * many would round on their own. That count is the whole remedy — deselect
 * the ones it named — and no amount of inspecting the selection afterwards
 * recovers it, so it is relayed rather than re-derived.
 */
function blendSubsetRemedy(
  reported: string | null,
  featureKind: 'fillet' | 'chamfer'
): string | null {
  if (!reported) {
    return null;
  }
  const refused = /(\d+) of the edges named were not blended/.exec(reported);
  const roundable = /the (\d+) edge\(s\)[^,]*would round on their own/.exec(
    reported
  );
  if (!refused || !roundable) {
    return null;
  }
  const verb = featureKind === 'fillet' ? 'round' : 'chamfer';
  return (
    `${refused[1]} of them cannot be blended where two rounds would meet at a corner, ` +
    `and the kernel will not quietly drop them. The other ${roundable[1]} ${verb} on their own — ` +
    `deselect those ${refused[1]} and try again.`
  );
}

function edgeModifierFailureMessage(
  kernel: RemusKernel,
  target: number,
  selected: number[],
  featureKind: 'fillet' | 'chamfer',
  size: number,
  partialRevolveTarget: boolean,
  /** What the kernel said when it refused, if it threw. */
  reported: string | null = null
): string {
  const label = featureKind === 'fillet' ? 'Fillet' : 'Chamfer';
  const dimension = featureKind === 'fillet' ? 'radius' : 'distance';
  const verb = featureKind === 'fillet' ? 'rounded' : 'chamfered';
  const prefix = `${label} could not be created on ${selected.length} selected edge${selected.length === 1 ? '' : 's'} with ${dimension} ${size}.`;
  try {
    if (
      edgeModifierSucceedsSmaller(kernel, target, selected, featureKind, size)
    ) {
      return `${prefix} Try a smaller ${dimension}.`;
    }
    // Named before the topology causes because it explains the whole body
    // rather than one selection: measured on an r=2..3, h=1 annulus, a 90
    // degree wedge refuses all 12 of its edges at every radius from 0.4 down
    // to 0.002, while the same profile at 360 rounds 4 of its 6.
    if (partialRevolveTarget) {
      return `${prefix} This body is a partial revolve, and the kernel cannot blend the edges of a revolved wedge at any ${dimension} yet — revolve a full turn and ${featureKind} the result, or apply the ${label.toLowerCase()} before the body is cut back to a wedge.`;
    }
    if (selected.some((edge) => edgeSampleOf(kernel, edge).closed)) {
      return `${prefix} Closed rim edges (such as hole rims) cannot be ${verb} on this body at any ${dimension} — deselect the rim edge and try again.`;
    }
    // Sharing a corner is NOT itself a refusal: all twelve edges of a plain
    // box meet at corners and round together at every radius tried. Only the
    // kernel knows which vertices its blend engines gave up on, so this cause
    // is claimed only when the kernel actually reported it.
    const subsetRemedy = blendSubsetRemedy(reported, featureKind);
    if (subsetRemedy) {
      return `${prefix} ${subsetRemedy}`;
    }
    if (reported?.includes('unsupported vertex blend')) {
      return `${prefix} Two of these rounds would run into each other at a shared corner, which the kernel cannot blend yet — ${featureKind} the edges in smaller groups that do not meet.`;
    }
    if (selectionTouchesBlendFace(kernel, target, selected)) {
      return `${prefix} Edges that end on an existing fillet or chamfer usually cannot be ${verb} afterwards — edit that earlier feature and add this edge to it instead. If that also fails, the kernel cannot blend this edge on this body yet.`;
    }
  } catch {
    // Diagnosis is best-effort; fall through to the generic message.
  }
  return `${prefix} Try a smaller ${dimension}.`;
}

/**
 * Move either cap of a simple analytic cylinder by rebuilding the equivalent
 * primitive in the cylinder's world-space frame. Repeated cylindrical
 * resizes leave a valid analytic solid, but Remus's generic cap boolean can
 * accumulate a mismatched circular boundary and fail its exact volume gate.
 * This path is deliberately limited to the three-face cylinder case; every
 * more complex prismatic face still uses the general push/pull operation.
 */
function tryExactAnalyticCylinderCapOffset(
  kernel: RemusKernel,
  solid: number,
  face: number,
  offset: number
): number | null {
  const cylinder = readAnalyticCylinder(kernel, solid);
  const cap = measureFaceGeometry(kernel, face);
  if (
    !cylinder ||
    cap?.surfaceType !== 'plane' ||
    !cap.normal ||
    !Number.isFinite(offset)
  ) {
    return null;
  }

  const normal = normalized(cap.normal);
  if (!normal) {
    return null;
  }
  const alignment = dot(normal, cylinder.axis);
  const span = Math.max(
    1,
    cylinder.radius,
    cylinder.axialMax - cylinder.axialMin
  );
  const linearTolerance = ANALYTIC_MATCH_EPSILON * span;
  const areaTolerance = Math.max(
    // Face area is measured through Remus's bounded-deflection integration,
    // so a circular cap is not bit-exact even though its surface is analytic.
    Math.PI * cylinder.radius * cylinder.radius * 5e-4,
    1e-7
  );
  const expectedCapArea = Math.PI * cylinder.radius * cylinder.radius;
  if (
    Math.abs(Math.abs(alignment) - 1) > ANALYTIC_MATCH_EPSILON ||
    Math.abs(cap.area - expectedCapArea) > areaTolerance
  ) {
    return null;
  }

  const capAxialPosition = dot(
    subtract(cap.center, cylinder.origin),
    cylinder.axis
  );
  const isBottom =
    Math.abs(capAxialPosition - cylinder.axialMin) <= linearTolerance;
  const isTop =
    Math.abs(capAxialPosition - cylinder.axialMax) <= linearTolerance;
  if (isBottom === isTop) {
    return null;
  }

  let axialMin = cylinder.axialMin;
  let axialMax = cylinder.axialMax;
  if (isBottom) {
    axialMin -= offset;
  } else {
    axialMax += offset;
  }
  const height = axialMax - axialMin;
  if (height <= GEOMETRY_EPSILON) {
    return null;
  }

  const base = {
    x: cylinder.origin.x + cylinder.axis.x * axialMin,
    y: cylinder.origin.y + cylinder.axis.y * axialMin,
    z: cylinder.origin.z + cylinder.axis.z * axialMin
  };
  const local = kernel.makeCylinder(cylinder.radius, height);
  return kernel.copyAndTransformSolid(
    local,
    coordinateFrameMatrix(base, cylinder.axis)
  );
}

/**
 * Preserve analytic cylinder walls for the common hollow-part operation.
 * Remus's generic boolean currently falls back to a triangular B-rep when a
 * smaller coaxial cylinder opens exactly onto either cap. Revolving the exact
 * radial section is the equivalent CSG result, but keeps true cylindrical
 * surfaces in the document and exported STEP file.
 */
function tryExactCoaxialCylinderCut(
  kernel: RemusKernel,
  targetSolid: number,
  toolSolid: number
): number | null {
  const target = readAnalyticCylinder(kernel, targetSolid);
  const tool = readAnalyticCylinder(kernel, toolSolid);
  if (!target || !tool) {
    return null;
  }

  const alignment = dot(target.axis, tool.axis);
  if (Math.abs(Math.abs(alignment) - 1) > ANALYTIC_MATCH_EPSILON) {
    return null;
  }

  const offset = subtract(tool.origin, target.origin);
  const axialOffset = dot(offset, target.axis);
  const perpendicularOffset = subtract(offset, scale(target.axis, axialOffset));
  const span = Math.max(
    1,
    target.radius,
    tool.radius,
    target.axialMax - target.axialMin,
    tool.axialMax - tool.axialMin
  );
  const tolerance = ANALYTIC_MATCH_EPSILON * span;
  if (
    length(perpendicularOffset) > tolerance ||
    tool.radius >= target.radius - tolerance
  ) {
    return null;
  }

  const toolA = axialOffset + alignment * tool.axialMin;
  const toolB = axialOffset + alignment * tool.axialMax;
  const toolMin = Math.min(toolA, toolB);
  const toolMax = Math.max(toolA, toolB);
  const cutMin = Math.max(target.axialMin, toolMin);
  const cutMax = Math.min(target.axialMax, toolMax);
  if (cutMax - cutMin <= tolerance) {
    return null;
  }

  const opensBottom = toolMin <= target.axialMin + tolerance;
  const opensTop = toolMax >= target.axialMax - tolerance;
  if (!opensBottom && !opensTop) {
    // A fully enclosed tool is already handled analytically by Remus as an
    // inner shell. Only the cap-opening cases need this construction.
    return null;
  }

  const inner = tool.radius;
  const outer = target.radius;
  let profile: Vec2[];
  if (opensBottom && opensTop) {
    profile = [
      { x: inner, y: target.axialMin },
      { x: outer, y: target.axialMin },
      { x: outer, y: target.axialMax },
      { x: inner, y: target.axialMax }
    ];
  } else if (opensTop) {
    profile = [
      { x: 0, y: target.axialMin },
      { x: outer, y: target.axialMin },
      { x: outer, y: target.axialMax },
      { x: inner, y: target.axialMax },
      { x: inner, y: cutMin },
      { x: 0, y: cutMin }
    ];
  } else {
    profile = [
      { x: inner, y: target.axialMin },
      { x: outer, y: target.axialMin },
      { x: outer, y: target.axialMax },
      { x: 0, y: target.axialMax },
      { x: 0, y: cutMax },
      { x: inner, y: cutMax }
    ];
  }

  return revolveRadialProfile(kernel, profile, target);
}

export interface ExactKernelAdapter {
  readonly kind: 'remus';
  syncDocument(document: ProjectDocument): Promise<DerivedState>;
  exportStep(document: ProjectDocument, bodyIds: BodyId[]): Promise<string>;
  exportStl(document: ProjectDocument, bodyIds: BodyId[]): Promise<string>;
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

function resolveFeatureFaces(
  kernel: RemusKernel,
  shape: ExactShape,
  hashes: readonly number[],
  references: readonly FaceTopologyReferenceV5[] | undefined,
  label: string
): number[] {
  if (shape.solids.length !== 1) {
    throw new Error(`${label} requires a body containing exactly one solid.`);
  }
  const solid = shape.solids[0]!;
  const handles = Array.from(kernel.getSolidFaces(solid));
  const candidates: TopologyResolutionCandidate[] = handles.map((handle) => {
    const witness = faceWitnessOf(kernel, handle);
    const lineageReference = shape.lineage?.faceReferences.get(handle);
    return {
      kind: 'face',
      currentHash: topologyHashOfWitness('face', witness),
      witnessVersion: 1,
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
  });
  const referenceByHash = new Map(
    references?.map((reference) => [reference.currentHash, reference]) ?? []
  );
  const legacyHandles = faceHandlesByFingerprint(kernel, solid);
  const resolved = hashes.map((hash) => {
    const reference = referenceByHash.get(hash);
    if (reference) {
      const resolution = resolveTopologyReference(reference, candidates);
      if (resolution.status === 'failed') {
        throw new Error(`${label} face is stale: ${resolution.message}`);
      }
      if (typeof resolution.candidate.value !== 'number') {
        throw new Error(`${label} face resolved without a kernel handle.`);
      }
      return resolution.candidate.value;
    }
    const matches = legacyHandles.get(hash) ?? [];
    if (matches.length === 0) {
      throw unresolvedReferenceError('face', hash, handles.length);
    }
    if (matches.length > 1) {
      throw ambiguousReferenceError('face');
    }
    return matches[0]!;
  });
  if (new Set(resolved).size !== resolved.length) {
    throw new Error(`${label} faces do not resolve to a unique set.`);
  }
  return resolved;
}

/**
 * A verified v5 reference for one legacy-resolved edge, or null when the
 * body's lineage cannot vouch for it. `currentHash` must equal the stored
 * hash: the repair leaves `edgeHashes` untouched, and the resolver requires
 * every persisted reference to match a stored hash exactly.
 */
function edgeReferenceRepairCandidate(
  kernel: RemusKernel,
  shape: ExactShape,
  handle: number,
  storedHash: number
): EdgeTopologyReferenceV5 | null {
  const reference = shape.lineage?.edgeReferences.get(handle);
  if (!reference || reference.currentHash !== storedHash) {
    return null;
  }
  const witness = edgeWitnessOf(kernel, handle);
  return topologyHashOfWitness('edge', witness) === storedHash &&
    topologyWitnessesEqual('edge', reference.witness, witness)
    ? reference
    : null;
}

function resolveEdgeModifierEdges(
  kernel: RemusKernel,
  shape: ExactShape,
  solid: number,
  hashes: readonly number[],
  references: readonly EdgeTopologyReferenceV5[] | undefined
): {
  handles: number[];
  /**
   * Set only when a hash-only (legacy) selection resolved AND the body's
   * lineage proves a v5 reference for every selected edge — the one moment a
   * legacy edge modifier can be upgraded in place. Null otherwise.
   */
  repairedReferences: EdgeTopologyReferenceV5[] | null;
} {
  const handles = Array.from(kernel.getSolidEdges(solid));
  const legacyHandles = edgeHandlesByFingerprint(kernel, solid);
  const requested = [...new Set(hashes)];

  // Collapsing a multi-solid body can fuse and post-process its topology. The
  // source handles and semantic references no longer describe that result, so
  // preserve the existing unique-hash resolver for this deliberately
  // unsupported lineage boundary.
  if (shape.solids.length !== 1) {
    return {
      handles: requested.map((hash) => {
        const matches = legacyHandles.get(hash) ?? [];
        if (matches.length === 0) {
          throw unresolvedReferenceError('edge', hash, handles.length);
        }
        if (matches.length > 1) {
          throw ambiguousReferenceError('edge');
        }
        return matches[0]!;
      }),
      repairedReferences: null
    };
  }

  const candidates: TopologyResolutionCandidate[] = handles.map((handle) => {
    const witness = edgeWitnessOf(kernel, handle);
    const lineageReference = shape.lineage?.edgeReferences.get(handle);
    return {
      kind: 'edge',
      currentHash: topologyHashOfWitness('edge', witness),
      witnessVersion: 1,
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
  });
  const requestedSet = new Set(requested);
  const referencesByHash = new Map<number, EdgeTopologyReferenceV5[]>();
  for (const reference of references ?? []) {
    if (!requestedSet.has(reference.currentHash)) {
      throw new Error(
        'Edge modifier references do not match the selected edge hashes.'
      );
    }
    const matches = referencesByHash.get(reference.currentHash) ?? [];
    matches.push(reference);
    referencesByHash.set(reference.currentHash, matches);
  }

  const repairCandidates: (EdgeTopologyReferenceV5 | null)[] = [];
  const resolved = requested.map((hash) => {
    const storedReferences = referencesByHash.get(hash) ?? [];
    if (storedReferences.length > 1) {
      throw new Error(
        'Edge modifier lineage contains duplicate references for one selected edge.'
      );
    }
    const reference = storedReferences[0];
    if (reference) {
      const resolution = resolveTopologyReference(reference, candidates);
      if (resolution.status === 'failed') {
        throw new Error(`Edge modifier edge is stale: ${resolution.message}`);
      }
      if (typeof resolution.candidate.value !== 'number') {
        throw new Error('Edge modifier edge resolved without a kernel handle.');
      }
      return resolution.candidate.value;
    }

    if (references !== undefined) {
      throw new Error(
        'Edge modifier lineage is missing a reference for one selected edge.'
      );
    }

    // A selected hash without a v5 reference is a legacy document edge. Keep
    // its old resolver and diagnostics; a v5 failure above is terminal and
    // never reaches this fallback.
    const matches = legacyHandles.get(hash) ?? [];
    if (matches.length === 0) {
      throw unresolvedReferenceError('edge', hash, handles.length);
    }
    if (matches.length > 1) {
      throw ambiguousReferenceError('edge');
    }
    const handle = matches[0]!;
    repairCandidates.push(
      edgeReferenceRepairCandidate(kernel, shape, handle, hash)
    );
    return handle;
  });
  if (new Set(resolved).size !== resolved.length) {
    throw new Error('Edge modifier edges do not resolve to a unique set.');
  }
  // All-or-nothing, and only for a fully hash-only selection: a partial
  // reference list would violate the persisted contract that every stored
  // reference matches a stored hash. Distinct lineage identities guard
  // against a publisher ever vouching for two edges with one role.
  const verified = repairCandidates.filter(
    (candidate): candidate is EdgeTopologyReferenceV5 => candidate !== null
  );
  const repairedReferences =
    references === undefined &&
    verified.length === requested.length &&
    new Set(
      verified.map(
        (candidate) =>
          `${candidate.producingFeatureId}:${candidate.lineageName}`
      )
    ).size === verified.length
      ? verified
      : null;
  return { handles: resolved, repairedReferences };
}

/** Best-effort analytic measurements surfaced to the UI as FaceGeometry. */
/**
 * Analytic surface classes whose area comes back as a closed form.
 *
 * Measured against closed forms on the pinned build rather than assumed from
 * the presence of a deflection parameter: cylinder, sphere, cone and torus all
 * return at machine precision (rel ~1e-16). Anything not listed here is left
 * unclassified rather than guessed at, because a surface class this build has
 * not been measured on must not be advertised as exact.
 */
const CLOSED_FORM_SURFACES = new Set(['cylinder', 'sphere', 'cone', 'torus']);

/**
 * Whether the face's area is exact.
 *
 * For a plane the answer is decided by its boundary: straight edges give an
 * exact polygon, convex or not, while ANY curve is inscribed with a fixed
 * 256-point polygon that no deflection improves. The check therefore stops at
 * the first curved edge, and only planes pay for it at all.
 */
function measureAreaProvenance(
  kernel: RemusKernel,
  face: number,
  surfaceType: string
): FaceAreaProvenance | undefined {
  if (CLOSED_FORM_SURFACES.has(surfaceType)) {
    return 'exact';
  }
  if (surfaceType !== 'plane') {
    return undefined;
  }
  try {
    for (const edge of kernel.getFaceEdges(face)) {
      if (kernel.getEdgeCurveType(edge) !== 'LINE') {
        return 'sampled';
      }
    }
  } catch {
    // A face whose boundary cannot be walked is not one to make claims about.
    return undefined;
  }
  return 'exact';
}

function measureFaceGeometry(
  kernel: RemusKernel,
  face: number
): FaceGeometry | undefined {
  const surfaceType = kernel.getSurfaceType(face);
  const centroid = faceVertexCentroid(kernel, face);
  const areaProvenance = measureAreaProvenance(kernel, face, surfaceType);
  const geometry: FaceGeometry = {
    surfaceType,
    area: kernel.faceArea(face, MEASUREMENT_DEFLECTION),
    ...(areaProvenance ? { areaProvenance } : {}),
    center: centroid ?? { x: 0, y: 0, z: 0 }
  };
  if (surfaceType === 'plane') {
    try {
      const normal = kernel.getFaceNormal(face);
      geometry.normal = {
        x: normal[0]!,
        y: normal[1]!,
        z: normal[2]!
      };
      // The plane's own equation, n·x = d, completed here because it is
      // arithmetic on two values already in hand rather than a kernel call.
      // `center` is the mean of the face's vertices and every one of them lies
      // on the plane, so any affine combination of them does too — which makes
      // this exact, and makes an exact point-to-plane distance computable
      // without a kernel round trip.
      geometry.planeOffset =
        geometry.normal.x * geometry.center.x +
        geometry.normal.y * geometry.center.y +
        geometry.normal.z * geometry.center.z;
    } catch {
      // NURBS-backed planes have no analytic normal; leave both unset. These
      // are exactly the imported-STEP faces a raw pick tends to land on, so
      // the absence is load-bearing rather than incidental.
    }
    return geometry;
  }
  if (
    surfaceType !== 'cylinder' &&
    surfaceType !== 'sphere' &&
    surfaceType !== 'torus' &&
    surfaceType !== 'cone'
  ) {
    return geometry;
  }
  let parameters: unknown;
  try {
    parameters = JSON.parse(kernel.getAnalyticSurfaceParams(face));
  } catch {
    return geometry;
  }
  const record = (parameters ?? {}) as Record<string, unknown>;
  if (surfaceType === 'torus') {
    const center = finiteVec3(record.center);
    const rawAxis = finiteVec3(record.axis);
    const axis = rawAxis ? normalized(rawAxis) : null;
    const majorRadius = positiveFinite(
      record.majorRadius ?? record.major_radius
    );
    const minorRadius = positiveFinite(
      record.minorRadius ?? record.minor_radius
    );
    if (center && majorRadius !== null && minorRadius !== null) {
      geometry.torusCenter = center;
      geometry.majorRadius = majorRadius;
      geometry.minorRadius = minorRadius;
      if (axis) {
        geometry.axis = axis;
      }
    }
    return geometry;
  }
  if (surfaceType === 'cone') {
    const apex = finiteVec3(record.apex);
    const rawAxis = finiteVec3(record.axis);
    const axis = rawAxis ? normalized(rawAxis) : null;
    const halfAngle = positiveFinite(
      record.halfAngle ?? record.half_angle ?? record.semiAngle
    );
    if (apex && axis && halfAngle !== null && halfAngle < Math.PI / 2) {
      geometry.apex = apex;
      geometry.axis = axis;
      geometry.halfAngle = halfAngle;
    }
    return geometry;
  }
  const radius = positiveFinite(record.radius);
  if (surfaceType === 'sphere') {
    // The corner patch a vertex blend leaves behind is a sphere of the blend
    // radius. It has no axis, so the radius is all that carries over.
    if (radius !== null) {
      geometry.radius = radius;
      geometry.diameter = radius * 2;
    }
    return geometry;
  }
  const origin = finiteVec3(record.origin);
  const rawAxis = finiteVec3(record.axis);
  const axis = rawAxis ? normalized(rawAxis) : null;
  if (!origin || !axis || radius === null) {
    return geometry;
  }
  geometry.radius = radius;
  geometry.diameter = radius * 2;
  const domain = Array.from(kernel.getSurfaceDomain(face));
  if (domain.length === 4 && domain.every(Number.isFinite)) {
    const axialMin = Math.min(domain[2]!, domain[3]!);
    const axialMax = Math.max(domain[2]!, domain[3]!);
    geometry.axisStart = {
      x: origin.x + axis.x * axialMin,
      y: origin.y + axis.y * axialMin,
      z: origin.z + axis.z * axialMin
    };
    geometry.axisEnd = {
      x: origin.x + axis.x * axialMax,
      y: origin.y + axis.y * axialMax,
      z: origin.z + axis.z * axialMax
    };
    geometry.axialLength = axialMax - axialMin;
  }
  return geometry;
}

/** A cylindrical face the kernel has proven to be an open internal bore. */
interface ThroughHoleGeometry extends FaceGeometry {
  radius: number;
  diameter: number;
  axisStart: Vec3;
  axisEnd: Vec3;
  axialLength: number;
  featureType: 'through-hole';
  editableDimension: 'diameter';
}

type ThroughHoleClassification =
  { status: 'through-hole' } | { status: 'refused'; message: string };

function refuseThroughHole(message: string): ThroughHoleClassification {
  return { status: 'refused', message };
}

/** Point-in-solid classification, treating any kernel failure as unknown. */
function classifySolidPoint(
  kernel: RemusKernel,
  solid: number,
  point: Vec3
): 'inside' | 'outside' | 'boundary' | 'unknown' {
  let classification: string;
  try {
    classification = kernel.classifyPoint(
      solid,
      point.x,
      point.y,
      point.z,
      DIRECT_EDIT_TOLERANCE
    );
  } catch {
    return 'unknown';
  }
  return classification === 'inside' ||
    classification === 'outside' ||
    classification === 'boundary'
    ? classification
    : 'unknown';
}

/**
 * Decide whether a cylindrical face is a through-hole: an internal bore that
 * opens at both ends, as opposed to a blind pocket or an external wall.
 *
 * OpenCascade answers the bore/wall half of that question from the face's
 * orientation flag — a hollow tube's outer wall and its bore share the same
 * void axis and the same two open ends, and only the orientation separates
 * them. Remus has no such flag (`getShapeOrientation` documents that every
 * face reports `forward`, and a cylinder's parametric normal points away from
 * the axis whether it walls a bore or a boss), so the same distinction is
 * taken from the material itself: just outside a bore's wall is solid, just
 * outside an outer wall is air. Everything else — full revolution, void
 * along the axis, both ends open — mirrors the OpenCascade classifier.
 *
 * A case that cannot be settled is refused by name rather than guessed at.
 */
function classifyThroughHoleFace(
  kernel: RemusKernel,
  solid: number,
  face: number,
  geometry: FaceGeometry | undefined
): ThroughHoleClassification {
  if (!geometry) {
    return refuseThroughHole('The selected face could not be measured.');
  }
  if (geometry.surfaceType !== 'cylinder') {
    return refuseThroughHole(
      `The selected face is a ${geometry.surfaceType} surface, not a cylindrical through-hole.`
    );
  }
  if (
    geometry.radius === undefined ||
    geometry.diameter === undefined ||
    !geometry.axisStart ||
    !geometry.axisEnd ||
    geometry.axialLength === undefined
  ) {
    return refuseThroughHole(
      'The selected cylindrical face has no analytic axis, so it cannot be measured as a through-hole.'
    );
  }
  const domain = Array.from(kernel.getSurfaceDomain(face));
  if (
    domain.length !== 4 ||
    !domain.every(Number.isFinite) ||
    Math.abs(Math.abs(domain[1]! - domain[0]!) - FULL_REVOLUTION) > 1e-5
  ) {
    return refuseThroughHole(
      'The selected face covers only part of its cylinder, so it is not a complete through-hole bore.'
    );
  }
  const axis = normalized(subtract(geometry.axisEnd, geometry.axisStart));
  if (!axis || geometry.axialLength <= GEOMETRY_EPSILON) {
    return refuseThroughHole(
      'The selected cylindrical face has a degenerate axis.'
    );
  }

  // The same probe distance OpenCascade uses to step off each end of the bore.
  const axialProbe = Math.max(
    DIRECT_EDIT_TOLERANCE * 10,
    geometry.radius * 0.02,
    geometry.axialLength * 0.01
  );
  const center = scale(add(geometry.axisStart, geometry.axisEnd), 0.5);
  if (classifySolidPoint(kernel, solid, center) !== 'outside') {
    return refuseThroughHole(
      'The selected cylindrical face encloses material along its axis, so it is a boss rather than a hole.'
    );
  }
  if (
    classifySolidPoint(
      kernel,
      solid,
      subtract(geometry.axisStart, scale(axis, axialProbe))
    ) !== 'outside' ||
    classifySolidPoint(
      kernel,
      solid,
      add(geometry.axisEnd, scale(axis, axialProbe))
    ) !== 'outside'
  ) {
    return refuseThroughHole(
      'The selected cylindrical face does not open at both ends, so it is a blind pocket rather than a through-hole.'
    );
  }

  // Radial probe: far enough off the wall for the kernel to resolve which side
  // of it the point sits on, and small enough that any real wall still
  // contains it. Sampling four bearings rather than one keeps a single
  // intersecting feature from deciding the answer on its own.
  const radialProbe = Math.max(
    DIRECT_EDIT_TOLERANCE * 100,
    geometry.radius * 1e-3
  );
  const reference =
    Math.abs(axis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const bearingU = normalized(cross(reference, axis));
  if (!bearingU) {
    return refuseThroughHole(
      'The selected cylindrical face has no measurable radial direction.'
    );
  }
  const bearingV = cross(axis, bearingU);
  const outsideWall = [0, 0.25, 0.5, 0.75].map((turn) => {
    const angle = turn * FULL_REVOLUTION;
    const offset = geometry.radius! + radialProbe;
    return classifySolidPoint(
      kernel,
      solid,
      add(
        center,
        add(
          scale(bearingU, Math.cos(angle) * offset),
          scale(bearingV, Math.sin(angle) * offset)
        )
      )
    );
  });
  if (outsideWall.every((classification) => classification === 'inside')) {
    return { status: 'through-hole' };
  }
  if (outsideWall.every((classification) => classification === 'outside')) {
    return refuseThroughHole(
      'The selected cylindrical face has material only on its inside, so it is an external wall rather than a bore.'
    );
  }
  return refuseThroughHole(
    'The selected cylindrical face is not surrounded by material around its whole circumference, so it cannot be classified as a through-hole.'
  );
}

/** Face measurements plus the editable feature semantics the UI offers. */
function measureOwnedFaceGeometry(
  kernel: RemusKernel,
  solid: number,
  face: number
): FaceGeometry | undefined {
  const geometry = measureFaceGeometry(kernel, face);
  if (!geometry) {
    return undefined;
  }
  if (isBlendFace(kernel, solid, face)) {
    geometry.featureType = 'blend';
    const blendRadius =
      geometry.surfaceType === 'torus'
        ? geometry.minorRadius
        : geometry.surfaceType === 'cylinder'
          ? geometry.radius
          : undefined;
    if (blendRadius !== undefined) {
      geometry.blendRadius = blendRadius;
    }
  } else if (
    geometry.surfaceType === 'cylinder' &&
    classifyThroughHoleFace(kernel, solid, face, geometry).status ===
      'through-hole'
  ) {
    geometry.featureType = 'through-hole';
    geometry.editableDimension = 'diameter';
  }
  return geometry;
}

interface BlendCarrierSnapshot {
  surfaceClass: 'torus' | 'cylinder';
  radius: number;
  center: Vec3;
  axis: Vec3;
}

/** Exact analytic identity used to authorize and re-check a blend edit. */
function blendCarrierSnapshot(
  geometry: FaceGeometry | undefined
): BlendCarrierSnapshot | null {
  if (geometry?.featureType !== 'blend' || geometry.blendRadius === undefined) {
    return null;
  }
  if (
    geometry.surfaceType === 'torus' &&
    geometry.torusCenter &&
    geometry.axis
  ) {
    return {
      surfaceClass: 'torus',
      radius: geometry.blendRadius,
      center: geometry.torusCenter,
      axis: geometry.axis
    };
  }
  if (
    geometry.surfaceType === 'cylinder' &&
    geometry.axisStart &&
    geometry.axisEnd
  ) {
    const axis = normalized(subtract(geometry.axisEnd, geometry.axisStart));
    if (!axis) {
      return null;
    }
    return {
      surfaceClass: 'cylinder',
      radius: geometry.blendRadius,
      center: scale(add(geometry.axisStart, geometry.axisEnd), 0.5),
      axis
    };
  }
  return null;
}

/**
 * Re-validate that the resolved face is still the through-hole the operation
 * was recorded against. A rebuild that drifted must fail here rather than
 * resize whichever face happened to inherit the fingerprint.
 */
function requireThroughHole(
  kernel: RemusKernel,
  solid: number,
  face: number,
  sourceDiameter?: number,
  sourceAxisStart?: Vec3,
  sourceAxisEnd?: Vec3
): ThroughHoleGeometry {
  const geometry = measureFaceGeometry(kernel, face);
  const classification = classifyThroughHoleFace(kernel, solid, face, geometry);
  if (classification.status !== 'through-hole' || !geometry) {
    throw new Error(
      classification.status === 'refused'
        ? classification.message
        : 'Selected face is not a complete through-hole cylinder.'
    );
  }
  geometry.featureType = 'through-hole';
  geometry.editableDimension = 'diameter';
  const hole = geometry as ThroughHoleGeometry;
  if (
    sourceDiameter !== undefined &&
    Math.abs(hole.diameter - sourceDiameter) >
      Math.max(DIRECT_EDIT_TOLERANCE, sourceDiameter * 1e-6)
  ) {
    throw new Error(
      'Selected face no longer matches its recorded source diameter.'
    );
  }
  if (sourceAxisStart && sourceAxisEnd) {
    const axisTolerance = Math.max(
      DIRECT_EDIT_TOLERANCE,
      hole.axialLength * 1e-6,
      hole.radius * 1e-6
    );
    const sameDirection =
      length(subtract(hole.axisStart, sourceAxisStart)) <= axisTolerance &&
      length(subtract(hole.axisEnd, sourceAxisEnd)) <= axisTolerance;
    const reversedDirection =
      length(subtract(hole.axisStart, sourceAxisEnd)) <= axisTolerance &&
      length(subtract(hole.axisEnd, sourceAxisStart)) <= axisTolerance;
    if (!sameDirection && !reversedDirection) {
      throw new Error(
        'Selected face no longer matches its recorded hole axis.'
      );
    }
  }
  return hole;
}

/** Solid cylinder between two world points, optionally extended past both. */
function cylinderAlongAxis(
  kernel: RemusKernel,
  start: Vec3,
  end: Vec3,
  radius: number,
  extension = 0
): number {
  const vector = subtract(end, start);
  const axis = normalized(vector);
  const axialLength = length(vector);
  if (!axis || axialLength <= GEOMETRY_EPSILON) {
    throw new Error('Cylindrical feature has a degenerate axis.');
  }
  const origin = subtract(start, scale(axis, extension));
  const local = kernel.makeCylinder(radius, axialLength + extension * 2);
  return kernel.copyAndTransformSolid(
    local,
    coordinateFrameMatrix(origin, axis)
  );
}

/**
 * Close exactly the selected through-hole span by fusing a plug of the bore's
 * own radius and merging the seams the fuse leaves behind.
 *
 * Remus's boolean drops to a co-refined mesh when its general face assembly
 * will not accept the result, and closing a hole — collapsing a handle in the
 * body — is a configuration it declines often enough to matter. A mesh result
 * still encloses roughly the right space, so it is caught by counting faces
 * instead of measuring volume: a real fill deletes the bore and merges its two
 * openings back into their host faces, while the mesh fallback replaces every
 * analytic surface with a fan of triangles and multiplies the face count.
 */
function fillThroughHole(
  kernel: RemusKernel,
  solid: number,
  geometry: ThroughHoleGeometry
): number {
  const facesBefore = kernel.getSolidFaces(solid).length;
  const filler = cylinderAlongAxis(
    kernel,
    geometry.axisStart,
    geometry.axisEnd,
    geometry.radius
  );
  let filled: number;
  try {
    filled = kernel.fuse(solid, filler);
  } catch (error) {
    throw new Error(
      `Filling the through-hole failed: ${
        error instanceof Error ? error.message : 'the kernel rejected the fuse'
      }.`,
      { cause: error }
    );
  }
  kernel.unifyFaces(filled);
  if (kernel.validateSolid(filled) !== 0) {
    throw new Error('Filling the through-hole did not produce a valid solid.');
  }
  if (kernel.getSolidFaces(filled).length >= facesBefore) {
    throw new Error(
      "Filling the through-hole fell back to a faceted mesh boolean, which would replace the body's exact surfaces with triangles."
    );
  }
  return filled;
}

/** Radii of every analytic cylinder in `solid` sharing the given axis line. */
function coaxialCylinderRadii(
  kernel: RemusKernel,
  solid: number,
  axisPoint: Vec3,
  axisDirection: Vec3,
  tolerance: number
): number[] {
  return Array.from(kernel.getSolidFaces(solid)).flatMap((handle) => {
    const measured = measureFaceGeometry(kernel, handle);
    if (
      measured?.surfaceType !== 'cylinder' ||
      measured.radius === undefined ||
      !measured.axisStart
    ) {
      return [];
    }
    const toAxis = subtract(measured.axisStart, axisPoint);
    const along = dot(toAxis, axisDirection);
    return length(subtract(toAxis, scale(axisDirection, along))) <= tolerance
      ? [measured.radius]
      : [];
  });
}

function faceAttachmentCandidatesForShape(
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
          ? { center: geometry.center, normal: geometry.normal }
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

function copyShape(
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

function copyShapeWithVerifiedLineage(
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

function projectRemusLineageDiagnostic(
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
function importMeshSolid(kernel: RemusKernel, stlText: string): number {
  const imported = kernel.importStl(new TextEncoder().encode(stlText));
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

function bodyName(document: ProjectDocument, bodyId: BodyId): string {
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
function inheritMeshOrigin(
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

function collapseShape(kernel: RemusKernel, shape: ExactShape): number {
  if (shape.solids.length === 0) {
    throw new Error('Exact body contains no solids.');
  }
  return shape.solids.length === 1
    ? shape.solids[0]!
    : fuseUniformSolid(kernel, shape.solids);
}

/**
 * Boolean union can leave adjacent coplanar faces split along the source-solid
 * boundary. The result is one valid solid, but those fragments render as false
 * seams and make a manufactured part look assembled from separate plates.
 * Remus unifies only faces on the same underlying surface, so real part
 * boundaries, holes, blends, and sharp corners remain intact.
 */
function unifyBooleanFaces(kernel: RemusKernel, solid: number): number {
  kernel.unifyFaces(solid);
  return solid;
}

function unifyUnionFaces(kernel: RemusKernel, solid: number): number {
  return selectSafelyUnifiedSolid(kernel, solid, (candidate) =>
    isStrictBooleanSolid(kernel, candidate)
  );
}

function fuseUniformSolid(kernel: RemusKernel, solids: number[]): number {
  const fused = kernel.fuseAll(Uint32Array.from(solids));
  return unifyUnionFaces(kernel, fused);
}

/**
 * Bounds of one face's disposable display projection.
 *
 * Remus's numeric handles are entity-local: a face handle is not a solid
 * handle, even when the two happen to share the same integer. Passing a face
 * to `boundingBox` used to work accidentally while that integer also named a
 * live solid. Tessellating the face is the supported face-level query, and
 * its deflection matches the approximation allowance used by the caller.
 */
function tessellatedFaceBounds(
  kernel: RemusKernel,
  face: number
): Float64Array {
  const mesh = kernel.tessellateFace(face, MEASUREMENT_DEFLECTION);
  try {
    const bounds = new Float64Array([
      Infinity,
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
      -Infinity
    ]);
    for (let index = 0; index + 2 < mesh.positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const coordinate = mesh.positions[index + axis]!;
        bounds[axis] = Math.min(bounds[axis]!, coordinate);
        bounds[axis + 3] = Math.max(bounds[axis + 3]!, coordinate);
      }
    }
    if (!Array.from(bounds).every(Number.isFinite)) {
      throw new Error('The exact kernel returned an empty face projection.');
    }
    return bounds;
  } finally {
    mesh.free();
  }
}

/**
 * How much interior volume these solids share, summed over every pair.
 *
 * Zero means they can be summed safely. A positive figure means summing
 * double-counts, and its SIZE is what tells a caller afterwards whether a
 * fuse actually merged anything — which is why this returns a quantity
 * rather than the boolean the first cut of it returned. By inclusion-
 * exclusion the pairwise total is the exact correction where no three solids
 * share a region and an overestimate where they do, so it is a lower bound on
 * what a successful merge must remove, never an upper one.
 *
 * TOUCHING IS NOT OVERLAPPING, and the distinction is the whole point. Two
 * boxes meeting exactly on a face sum to their true union, so fusing them
 * would change topology and lineage while moving no number; two boxes that
 * interpenetrate are counted twice by any caller that sums per-solid volumes.
 * Only the second case is a defect, so only the second case is reported here.
 *
 * Bounding boxes filter first, so the exact intersect — much the more
 * expensive call, and the one that can throw — runs only on pairs that could
 * possibly share volume. A patterned row's boxes overlap only between
 * neighbours, so the kernel work stays near-linear in the instance count even
 * though the box scan is quadratic.
 *
 * The floor is a fraction of the pair's own bounding diagonal CUBED, not an
 * absolute figure. A volume is L^3: an absolute floor would call a
 * millimetre-scale overlap empty and a kilometre-scale rounding error real.
 * This is the same dimensional mistake this project has now found in the
 * kernel five times, and it is not worth making again here.
 */
function sharedSolidVolume(kernel: RemusKernel, solids: number[]): number {
  if (solids.length < 2) {
    return 0;
  }
  let total = 0;
  const boxes = solids.map((solid) => kernel.boundingBox(solid));
  for (let left = 0; left < solids.length; left += 1) {
    for (let right = left + 1; right < solids.length; right += 1) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      const spans = [0, 1, 2].map(
        (axis) =>
          Math.min(a[axis + 3]!, b[axis + 3]!) - Math.max(a[axis]!, b[axis]!)
      );
      if (spans.some((span) => span <= 0)) {
        continue;
      }
      const diagonal = Math.hypot(
        Math.max(a[3]! - a[0]!, b[3]! - b[0]!),
        Math.max(a[4]! - a[1]!, b[4]! - b[1]!),
        Math.max(a[5]! - a[2]!, b[5]! - b[2]!)
      );
      const floor = diagonal ** 3 * 1e-9;
      // The box overlap is an upper bound on the shared volume, so a pair
      // whose boxes barely graze cannot clear the floor and need not be
      // intersected at all.
      if (spans[0]! * spans[1]! * spans[2]! <= floor) {
        continue;
      }
      let shared: number;
      try {
        shared = kernel.volume(
          kernel.intersect(solids[left]!, solids[right]!),
          MEASUREMENT_DEFLECTION
        );
      } catch {
        // A refused intersection is not evidence of disjointness. The boxes
        // already say these two could share volume, so fail toward fusing: a
        // needless fuse costs time, a missed one reports a wrong volume. The
        // box overlap stands in for a figure the kernel would not give.
        total += spans[0]! * spans[1]! * spans[2]!;
        continue;
      }
      if (shared > floor) {
        total += shared;
      }
    }
  }
  return total;
}

function inferenceBodyForShape(
  kernel: RemusKernel,
  shape: ExactShape,
  bodyId: BodyId,
  name: string
): ExtrudeInferenceBody {
  if (shape.solids.length === 0) {
    throw new Error(`Body "${name}" contains no exact solids.`);
  }
  const boxes = shape.solids.map((solid) => kernel.boundingBox(solid));
  return {
    bodyId,
    name,
    volume: shape.solids.reduce(
      (total, solid) => total + kernel.volume(solid, MEASUREMENT_DEFLECTION),
      0
    ),
    bbox: {
      min: {
        x: Math.min(...boxes.map((box) => box[0]!)),
        y: Math.min(...boxes.map((box) => box[1]!)),
        z: Math.min(...boxes.map((box) => box[2]!))
      },
      max: {
        x: Math.max(...boxes.map((box) => box[3]!)),
        y: Math.max(...boxes.map((box) => box[4]!)),
        z: Math.max(...boxes.map((box) => box[5]!))
      }
    }
  };
}

/** Exact common material between two body shapes; tangency returns zero. */
function sharedShapeVolume(
  kernel: RemusKernel,
  left: ExactShape,
  right: ExactShape,
  leftBody: ExtrudeInferenceBody,
  rightBody: ExtrudeInferenceBody
): number {
  if (!extrudeBoundsCanShareVolume(leftBody.bbox, rightBody.bbox)) {
    return 0;
  }
  let total = 0;
  for (const leftSolid of left.solids) {
    const leftBox = kernel.boundingBox(leftSolid);
    for (const rightSolid of right.solids) {
      const rightBox = kernel.boundingBox(rightSolid);
      const pairBounds = (box: Float64Array): ExtrudeInferenceBody['bbox'] => ({
        min: { x: box[0]!, y: box[1]!, z: box[2]! },
        max: { x: box[3]!, y: box[4]!, z: box[5]! }
      });
      if (
        !extrudeBoundsCanShareVolume(pairBounds(leftBox), pairBounds(rightBox))
      ) {
        continue;
      }
      try {
        total += Math.max(
          0,
          kernel.volume(
            kernel.intersect(leftSolid, rightSolid),
            MEASUREMENT_DEFLECTION
          )
        );
      } catch (error) {
        throw new Error(
          'The exact kernel could not measure extrusion overlap; the stored operation was not changed.',
          { cause: error }
        );
      }
    }
  }
  return total > extrudeVolumeTolerance(leftBody, rightBody) ? total : 0;
}

/**
 * Face unification is allowed to replace the raw Union only when the copied
 * result remains a strict topological solid. The final Union acceptance gate
 * below separately checks its disposable viewport projection.
 */
function isStrictBooleanSolid(kernel: RemusKernel, solid: number): boolean {
  try {
    return kernel.validateSolid(solid) === 0;
  } catch {
    return false;
  }
}

function isFaceConnectedSolid(kernel: RemusKernel, solid: number): boolean {
  try {
    return (
      countFaceConnectedComponents(
        kernel.getSolidFaces(solid),
        JSON.parse(kernel.edgeToFaceMap(solid)) as Record<string, number[]>
      ) === 1
    );
  } catch {
    return false;
  }
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Keep Remus's hostile-input budgets for every source. A locally selected
 * file can later be shared or restored, so its origin does not make it trusted.
 */
function importStepWithOwnBudget(
  kernel: RemusKernel,
  bytes: Uint8Array
): Uint32Array {
  return kernel.importStep(bytes, 128 * 1024 * 1024, 2_000_000);
}

function assertFiniteDirectEditNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Direct-edit ${label} must be finite.`);
  }
  return value;
}

function assertDirectEditVector(value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Direct-edit ${label} must be a vector.`);
  }
  const vector = value as Record<string, unknown>;
  assertFiniteDirectEditNumber(vector.x, `${label}.x`);
  assertFiniteDirectEditNumber(vector.y, `${label}.y`);
  assertFiniteDirectEditNumber(vector.z, `${label}.z`);
}

function assertDirectEditParam(value: unknown, label: string): void {
  if (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= 500)
  ) {
    return;
  }
  throw new Error(`Direct-edit ${label} must be a finite value or expression.`);
}

function assertDirectEditOperation(operation: DirectEditOperation): void {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new Error('Direct-edit operation must be an object.');
  }
  const value = operation as unknown as Record<string, unknown>;
  if (
    typeof value.faceHash !== 'number' ||
    !Number.isSafeInteger(value.faceHash)
  ) {
    throw new Error('Direct-edit face hash must be a safe integer.');
  }
  switch (value.kind) {
    case 'resize-through-hole':
      if (
        assertFiniteDirectEditNumber(value.sourceDiameter, 'source diameter') <=
        0
      ) {
        throw new Error(
          'Direct-edit source diameter must be greater than zero.'
        );
      }
      assertDirectEditVector(value.sourceAxisStart, 'source axis start');
      assertDirectEditVector(value.sourceAxisEnd, 'source axis end');
      assertDirectEditParam(value.diameter, 'diameter');
      if (
        value.parameterBinding !== undefined &&
        value.parameterBinding !== true
      ) {
        throw new Error('Direct-edit parameter binding is invalid.');
      }
      return;
    case 'remove-face-feature': {
      if (
        typeof value.sourceSurfaceType !== 'string' ||
        !value.sourceSurfaceType
      ) {
        throw new Error('Direct-edit source surface type is invalid.');
      }
      if (assertFiniteDirectEditNumber(value.sourceArea, 'source area') <= 0) {
        throw new Error('Direct-edit source area must be greater than zero.');
      }
      assertDirectEditVector(value.sourceCenter, 'source center');
      const throughHoleSnapshot = [
        value.sourceDiameter,
        value.sourceAxisStart,
        value.sourceAxisEnd
      ];
      if (throughHoleSnapshot.some((entry) => entry !== undefined)) {
        if (throughHoleSnapshot.some((entry) => entry === undefined)) {
          throw new Error('Direct-edit through-hole snapshot is incomplete.');
        }
        if (
          assertFiniteDirectEditNumber(
            value.sourceDiameter,
            'source diameter'
          ) <= 0
        ) {
          throw new Error(
            'Direct-edit source diameter must be greater than zero.'
          );
        }
        assertDirectEditVector(value.sourceAxisStart, 'source axis start');
        assertDirectEditVector(value.sourceAxisEnd, 'source axis end');
      }
      return;
    }
    case 'offset-face':
      if (value.sourceSurfaceType !== 'plane') {
        throw new Error('Direct-edit offset source must be planar.');
      }
      if (assertFiniteDirectEditNumber(value.sourceArea, 'source area') <= 0) {
        throw new Error('Direct-edit source area must be greater than zero.');
      }
      assertDirectEditVector(value.sourceCenter, 'source center');
      assertDirectEditVector(value.sourceNormal, 'source normal');
      assertDirectEditParam(value.offset, 'offset');
      return;
    case 'resize-cylindrical-face':
      if (
        assertFiniteDirectEditNumber(value.sourceRadius, 'source radius') <= 0
      ) {
        throw new Error('Direct-edit source radius must be greater than zero.');
      }
      assertDirectEditVector(value.sourceAxisStart, 'source axis start');
      assertDirectEditVector(value.sourceAxisEnd, 'source axis end');
      if (value.concavity !== 'hole' && value.concavity !== 'boss') {
        throw new Error('Direct-edit cylinder concavity is invalid.');
      }
      assertDirectEditParam(value.radius, 'radius');
      return;
    case 'resize-blend':
      if (value.surfaceClass !== 'torus' && value.surfaceClass !== 'cylinder') {
        throw new Error('Direct-edit blend surface class is invalid.');
      }
      if (
        assertFiniteDirectEditNumber(value.recordedRadius, 'recorded radius') <=
        0
      ) {
        throw new Error(
          'Direct-edit recorded radius must be greater than zero.'
        );
      }
      assertDirectEditVector(value.recordedCenter, 'recorded center');
      assertDirectEditVector(value.recordedAxis, 'recorded axis');
      assertDirectEditParam(value.newRadius, 'new radius');
      return;
    default:
      throw new Error('Direct-edit operation kind is not supported.');
  }
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
}

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
        basis,
        warn
      );
      const solid = kernel.extrude(
        face,
        basis.normal.x,
        basis.normal.y,
        basis.normal.z,
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
          x: basis.origin.x + basis.normal.x * distance,
          y: basis.origin.y + basis.normal.y * distance,
          z: basis.origin.z + basis.normal.z * distance
        };
        addFaceCarrierRole(
          candidates,
          planeCarrier(basis.normal, basis.origin),
          `sweep.face.cap.start.region.${token}`,
          assignments,
          diagnostics
        );
        addFaceCarrierRole(
          candidates,
          planeCarrier(basis.normal, endOrigin),
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
    const face = this.makeProfileFace(kernel, object.data, basis, 0, scope);

    if (feature.data.featureKind === 'extrude') {
      const distance = resolveParamValue(
        feature.data.distance,
        scope,
        'distance'
      );
      const solid = kernel.extrude(
        face,
        basis.normal.x,
        basis.normal.y,
        basis.normal.z,
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
          basis,
          distance,
          scope
        )
      };
    }

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
    pinnedImports: ReadonlySet<string> = new Set(importSources.keys())
  ): ExactBuildResult {
    const { scope, errors } = getParameterScope(document);
    const result: ExactBuildResult = {
      shapes: new Map(),
      sketchBases: new Map(),
      consumed: new Set(),
      importedStepDiagnostics: new Map(),
      meshBodies: new Set(),
      partialRevolveBodies: new Set(),
      warnings: [...errors],
      referenceRepairs: []
    };

    for (const feature of listFeaturesInOrder(document)) {
      if (isFeatureSuppressed(feature)) {
        result.warnings.push(
          `Feature "${feature.name}": Suppressed; skipped during exact rebuild.`
        );
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
                  }
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
              }
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
            if (target.solids.length * count > 100) {
              throw new Error('A pattern may produce at most 100 solids.');
            }
            const direction = axisDirection(feature.data.axis);
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
    const kernel = new RemusKernel();
    try {
      const build = this.build(kernel, document, sources, pinned);
      const bodies = listNodesByKind(document, 'body');
      const features = new Map(
        listNodesByKind(document, 'feature').map((feature) => [
          feature.featureId,
          feature
        ])
      );
      const bodyRepresentations: Record<BodyId, BodyRepresentation> = {};
      const exportableBodyIds: BodyId[] = [];

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
        const measured = this.measureShape(
          kernel,
          shape,
          requiresStrictUnionValidation
        );
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

      return {
        bodyRepresentations,
        exportableBodyIds,
        warnings: build.warnings,
        updatedAt: nowIso(),
        ...(build.referenceRepairs.length > 0
          ? { referenceRepairs: build.referenceRepairs }
          : {})
      };
    } finally {
      kernel.free();
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
      if (exportSolids.length === 1) {
        return decodeText(
          kernel.exportStlAscii(exportSolids[0]!, STL_EXPORT_DEFLECTION)
        );
      }
      // Several consumers stop at the first `solid` block, so a multi-body
      // export must be one block containing every body's facets.
      const meshes = exportSolids.map((solid, index) => {
        const mesh = kernel.tessellateSolidGroupedBinary(
          solid,
          STL_EXPORT_DEFLECTION
        );
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
    // Each operation owns and releases a short-lived RemusKernel instance, so
    // there is nothing adapter-scoped left to release.
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
