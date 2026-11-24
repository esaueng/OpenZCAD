import type { RemusKernel } from './remus-runtime';
import { AdapterRefusal } from './adapter-refusal';
import { KernelRefusal } from './kernel-refusal';
import { operationErrorCategory } from './remus-operation-refusal';
import {
  EXTRUDE_SIDES_CONFLICT_MESSAGE,
  extrudeSidesConflict,
  findSketch,
  listFeaturesInOrder,
  resolveDimensionedParam,
  resolveParamValue
} from '@openzcad/document-core';
import {
  computeSketchProfileAnalysis,
  csysPlaneFrame,
  edgeAngleDatumPlane,
  edgeDatumAxis,
  edgeMidpointDatumPoint,
  faceNormalDatumAxis,
  frameForPlaneRef,
  geometryTolerance,
  mergeAdjacentProfiles,
  normalToEdgeDatumPlane,
  requireRevolveAxisInPlane,
  resolveSplineGeometry,
  surfaceDatumAxis,
  type DatumAxis,
  type DatumCsys,
  type PlaneBasis,
  type RegionCurve,
  type SketchRegion,
  type Vec2Like,
  type Vec3
} from '@openzcad/geometry';
import {
  boundaryProvenanceEqual,
  FULL_REVOLVE_ANGLE_DEG,
  MAX_HELICAL_SWEEP_TURNS,
  parseSketchBoundaryToken,
  resolveSketchPromotionBoundaryTokens,
  resolveSketchShapePointTarget,
  type LoftConnectionVertex,
  type FaceWitnessV1,
  type FeatureNode,
  type ProjectDocument,
  type SketchId,
  type ParamValue,
  type SketchNode,
  type CsysPlaneSource,
  type DatumAxisEdgeSource,
  type FeatureId,
  type DatumAxisFaceSource,
  type DatumAxisRef,
  type DatumPointSource,
  type SketchObjectData,
  type SketchPlaneRef,
  type SketchPathReference,
  type SketchProfileReference,
  type SketchSectionReference,
  type UnitSystem
} from '@openzcad/shared';
import type { ExactBuildResult, ExactShape } from './exact-types';
import { edgeEndPoint } from './topology-fingerprint';
import {
  addFaceCarrierRole,
  buildExtrudeLineage,
  buildPrimitiveLineage,
  buildRevolveLineage,
  cylinderCarrier,
  planeCarrier,
  topologyCandidatesForSolid
} from './exact-lineage-builders';
import {
  edgeVertexCandidatesForShape,
  faceAttachmentCandidatesForShape,
  formatMeasuredVolume,
  resolveParametricPoint,
  validateGeneratedSolid
} from './exact-shape-utils';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';
import { fuseUniformSolid } from './exact-boolean-helpers';
import { requireValidSolid } from './kernel-validation';
import {
  GEOMETRY_EPSILON,
  cross,
  dot,
  errorText,
  normalized,
  pointOnPlane,
  profilePoints,
  scale,
  shiftBasisAlongNormal,
  subtract
} from './exact-math';
import {
  connectedRegionGroups,
  resolveRegionProfiles,
  resolveRegionProfilesInSketch
} from './region-profile';
import {
  ellipseRegionEdges,
  splinePathEdge,
  splineRegionEdges
} from './profile-curve-edges';
import {
  basisMatchesLiftedFrame,
  bezierFallbackWarning,
  bezierNurbsParams,
  bezierProfileEdgesEnabled,
  flattenBezierCurve,
  flattenedOutlineWarning,
  kernelSafeBezierPieces
} from './profile-bezier-edges';
import {
  remusHashOnlyLineage,
  createRemusSemanticLineage,
  mergeRemusLineageStates,
  type RemusLineageState,
  type RemusSemanticAssignment
} from './remus-lineage';
import {
  resolveDatumAxisEdge,
  resolveDatumAxisFace,
  resolveDatumAxisNormalFace,
  resolveDatumPlaneEdge,
  resolveDatumPointEdge,
  resolveEdgeVertex,
  resolveFaceAttachment,
  type DatumOwnerKind
} from './face-attachment';
import {
  DRAFTED_EXTRUDE_HASH_ONLY_REASON,
  draftExtrudedSolids,
  resolveExtrudeDraftDeg,
  resolveExtrudeStartOffset,
  straightRoundWallAsLoft
} from './extrude-options';

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
/**
 * A region revolve (U09) turns a face built from resolved region loops, not
 * one authored object, so the ADR-013 profile-vertex roles have no single
 * source to witness. Its references stay hash-only until region lineage
 * gains a revolve carrier the way region extrudes gained side roles.
 */
const REGION_REVOLVE_HASH_ONLY_REASON =
  'A revolve of a selected sketch region publishes hash-only references: region revolve lineage has no semantic carrier yet.';

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

/**
 * The effective span of an extrude feature. `symmetric` starts half the
 * distance behind the sketch plane; `backDistance` extends the solid behind
 * the plane (opposite the `distance` direction) by its own resolved amount,
 * so the span runs from `-back` to `distance` along the normal. The two are
 * mutually exclusive: creation rejects the combination, and a hand-written
 * document that carries both fails closed here rather than guessing which
 * side wins. The shifted basis carries the offset into the profile face and
 * every lineage carrier at once, exactly like the symmetric path always has.
 */
function resolveExtrudeSpan(
  data: { symmetric?: boolean; backDistance?: ParamValue },
  basis: PlaneBasis,
  distance: number,
  scope: Record<string, number>,
  documentUnits: UnitSystem
): { extrudeBasis: PlaneBasis; totalDistance: number } {
  const back =
    data.backDistance === undefined
      ? 0
      : resolveParamValue(
          data.backDistance,
          scope,
          'back distance',
          documentUnits
        );
  // The document's rule, on the resolved value: a zero back distance is the
  // one-sided default beside symmetric, anything else conflicts.
  if (extrudeSidesConflict({ symmetric: data.symmetric, backDistance: back })) {
    throw new Error(EXTRUDE_SIDES_CONFLICT_MESSAGE);
  }
  if (back < 0) {
    throw new Error(`Extrude back distance must be non-negative, got ${back}.`);
  }
  if (data.symmetric) {
    return {
      extrudeBasis: shiftBasisAlongNormal(basis, -distance / 2),
      totalDistance: distance
    };
  }
  const sign = distance < 0 ? -1 : 1;
  return {
    extrudeBasis: shiftBasisAlongNormal(basis, -sign * back),
    totalDistance: distance + sign * back
  };
}

/**
 * The kernel sweeps a face along the direction it is given, and a sweep that
 * runs against the face's own normal builds a shell whose faces are
 * consistently inside-out: it passes standalone validation and only fails at
 * the next boolean ("shared edges have inconsistent face orientations"), so
 * Union refused a flange pulled into a plate while Add kept an un-unified
 * 14-face fuse. Reversing the face or fixing orientations afterwards does not
 * help — the wire winding decides. A negative span is therefore built the
 * way the symmetric span always was: the profile face sits on the far plane
 * and the sweep runs forward by the absolute distance. The swept volume is
 * identical, so the lineage builders keep reading the signed span.
 */
function forwardSweep(
  extrudeBasis: PlaneBasis,
  totalDistance: number
): { faceBasis: PlaneBasis; sweepDistance: number } {
  if (totalDistance >= 0) {
    return { faceBasis: extrudeBasis, sweepDistance: totalDistance };
  }
  return {
    faceBasis: shiftBasisAlongNormal(extrudeBasis, totalDistance),
    sweepDistance: -totalDistance
  };
}

function revolveKeepsSemanticLineage(
  angleDeg: number,
  data: SketchObjectData
): boolean {
  return angleDeg >= FULL_REVOLVE_ANGLE_DEG || data.objectKind === 'circle';
}

export function resolveRevolveAngleDeg(
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

/** Lift a sketch-local 2D point into world space on the plane basis. */
function planePoint3(basis: PlaneBasis, point: Vec2Like): Vec3 {
  return {
    x: basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
    y: basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
    z: basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
  };
}

export function resolveSketchBasisAtHistory(
  kernel: RemusKernel,
  document: ProjectDocument,
  sketch: SketchNode,
  result: ExactBuildResult,
  scope: Record<string, number>
): PlaneBasis {
  return resolvePlaneRefAtHistory(
    kernel,
    document,
    sketch.planeRef,
    { kind: 'Sketch', name: sketch.name },
    result,
    scope
  );
}

/**
 * The world frame of a sketch plane or R01 datum source at the current
 * history position. A datum reads the frame its own feature resolved earlier
 * in this build; a lineage face re-derives from the evolved face. Neither
 * falls back to a stored frame: a missing source refuses by name.
 */
export function resolvePlaneRefAtHistory(
  kernel: RemusKernel,
  document: ProjectDocument,
  planeRef: SketchPlaneRef | CsysPlaneSource,
  ownerRef: {
    kind:
      | 'Sketch'
      | 'Datum plane'
      | 'Datum axis'
      | 'Datum point'
      | 'Coordinate system'
      | 'Mirror'
      | 'Split';
    name: string;
  },
  result: ExactBuildResult,
  scope: Record<string, number>
): PlaneBasis {
  const owner =
    ownerRef.kind === 'Mirror' || ownerRef.kind === 'Split'
      ? ownerRef.kind
      : `${ownerRef.kind} "${ownerRef.name}"`;
  if (planeRef.type === 'datum-csys') {
    return csysPlaneFrame(
      resolveDatumCsysRefAtHistory(document, planeRef, owner, result),
      planeRef.plane
    );
  }
  if (planeRef.type === 'datum') {
    const frame = result.datumFrames.get(planeRef.datumFeatureId);
    if (!frame) {
      const datum = listFeaturesInOrder(document).find(
        (candidate) => candidate.featureId === planeRef.datumFeatureId
      );
      throw new Error(
        `${owner} cannot use datum plane "${datum?.name ?? planeRef.datumFeatureId}" because it is unavailable at this point in history.`
      );
    }
    return frame;
  }
  if (planeRef.type !== 'face' || !planeRef.faceReference) {
    if (planeRef.type === 'face') {
      result.warnings.push(
        `${owner}: legacy face attachment has no schema-v5 lineage reference; using its stored migration frame.`
      );
    }
    return frameForPlaneRef(planeRef, (value) =>
      resolveParamValue(value, scope, 'sketch offset', document.units)
    );
  }

  const sourceShape = result.shapes.get(planeRef.bodyId);
  if (!sourceShape) {
    throw new Error(
      `${owner} cannot attach because source body ${planeRef.bodyId} is unavailable at the ${ownerRef.kind === 'Sketch' ? "sketch's" : "datum's"} history position.`
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
      ...(planeRef.sourceCentroid
        ? { sourceCentroid: planeRef.sourceCentroid }
        : {}),
      sourceNormal: planeRef.sourceNormal,
      frame: planeRef.frame
    },
    sketchName: ownerRef.name,
    ownerKind:
      ownerRef.kind === 'Sketch' || ownerRef.kind === 'Datum axis'
        ? ownerRef.kind
        : 'Datum plane',
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

/**
 * R01: the world position of a datum's point source at its history
 * position. Coordinates are lengths in document units; a vertex re-finds its
 * edge through verified lineage and refuses by name when it cannot.
 */
export function resolveDatumPointAtHistory(
  kernel: RemusKernel,
  document: ProjectDocument,
  point: DatumPointSource,
  datumName: string,
  result: ExactBuildResult,
  scope: Record<string, number>,
  ownerKind: DatumOwnerKind = 'Datum plane'
): Vec3 {
  if (point.type === 'datum-point') {
    const at = result.datumPoints?.get(point.datumFeatureId);
    if (!at) {
      const datum = listFeaturesInOrder(document).find(
        (candidate) => candidate.featureId === point.datumFeatureId
      );
      throw new Error(
        `${ownerKind} "${datumName}" cannot use datum point "${datum?.name ?? point.datumFeatureId}" because it is unavailable at this point in history.`
      );
    }
    return at;
  }
  if (point.type === 'point') {
    const axis = (value: ParamValue, name: string) =>
      resolveParamValue(value, scope, `datum point ${name}`, document.units);
    return {
      x: axis(point.point.x, 'X'),
      y: axis(point.point.y, 'Y'),
      z: axis(point.point.z, 'Z')
    };
  }
  const shape = result.shapes.get(point.bodyId);
  const sourceFeature = listFeaturesInOrder(document).find(
    (candidate) =>
      candidate.featureId === point.edgeReference.producingFeatureId
  );
  if (!shape) {
    throw new Error(
      `${ownerKind} "${datumName}" cannot use a vertex of body ${point.bodyId} because it is unavailable at the datum's history position.`
    );
  }
  return resolveEdgeVertex({
    reference: point.edgeReference,
    end: point.end,
    candidates: edgeVertexCandidatesForShape(kernel, shape),
    datumName,
    ownerKind,
    sourceFeatureName:
      sourceFeature?.name ?? String(point.edgeReference.producingFeatureId)
  });
}

/**
 * R01: the line a datum axis's edge or face source names at the axis's
 * history position: a straight edge from its end 0 to its end 1, or a
 * cylinder's or cone's exact axis in canonical sense. Both re-find their
 * topology through verified lineage and refuse by name when they cannot.
 */
export function resolveDatumAxisSourceAtHistory(
  kernel: RemusKernel,
  document: ProjectDocument,
  source: DatumAxisEdgeSource | DatumAxisFaceSource,
  datumName: string,
  result: ExactBuildResult,
  reverseDirection: boolean | undefined
): DatumAxis {
  const shape = result.shapes.get(source.bodyId);
  const reference =
    source.type === 'edge' ? source.edgeReference : source.faceReference;
  if (!shape) {
    throw new Error(
      `Datum axis "${datumName}" cannot use ${source.type === 'edge' ? 'an edge' : 'a face'} of body ${source.bodyId} because it is unavailable at the datum's history position.`
    );
  }
  const sourceFeatureName =
    listFeaturesInOrder(document).find(
      (candidate) => candidate.featureId === reference.producingFeatureId
    )?.name ?? String(reference.producingFeatureId);
  if (source.type === 'edge') {
    const [start, end] = resolveDatumAxisEdge({
      reference: source.edgeReference,
      candidates: edgeVertexCandidatesForShape(kernel, shape),
      datumName,
      sourceFeatureName
    });
    return edgeDatumAxis(start, end, reverseDirection);
  }
  const axis = resolveDatumAxisFace({
    reference: source.faceReference,
    candidates: faceAttachmentCandidatesForShape(kernel, shape),
    datumName,
    sourceFeatureName
  });
  return surfaceDatumAxis(axis.point, axis.direction, reverseDirection);
}

/**
 * R01 (schema v99): the coordinate system a reference resolved to earlier in
 * this build. One that failed, is suppressed or comes later is refused by
 * name; nothing stands in for it.
 */
export function resolveDatumCsysRefAtHistory(
  document: ProjectDocument,
  ref: { datumFeatureId: FeatureId },
  owner: string,
  result: ExactBuildResult
): DatumCsys {
  const csys = result.datumCsys?.get(ref.datumFeatureId);
  if (!csys) {
    const datum = listFeaturesInOrder(document).find(
      (candidate) => candidate.featureId === ref.datumFeatureId
    );
    throw new Error(
      `${owner} cannot use coordinate system "${datum?.name ?? ref.datumFeatureId}" because it is unavailable at this point in history.`
    );
  }
  return csys;
}

/**
 * R01 (schema v99): a datum point's edge source at the point's history
 * position, read exactly: the midpoint of a straight edge, or the centre of
 * a circular one (the circumcentre of three of its points, checked against
 * a fourth). Re-found through verified lineage; refused by name otherwise.
 */
export function resolveDatumPointEdgeAtHistory(
  kernel: RemusKernel,
  document: ProjectDocument,
  source: DatumAxisEdgeSource,
  kind: 'edge-midpoint' | 'arc-center',
  datumName: string,
  result: ExactBuildResult
): Vec3 {
  const shape = result.shapes.get(source.bodyId);
  if (!shape) {
    throw new Error(
      `Datum point "${datumName}" cannot use an edge of body ${source.bodyId} because it is unavailable at the point's history position.`
    );
  }
  const sourceFeatureName =
    listFeaturesInOrder(document).find(
      (candidate) =>
        candidate.featureId === source.edgeReference.producingFeatureId
    )?.name ?? String(source.edgeReference.producingFeatureId);
  if (kind === 'edge-midpoint') {
    const [start, end] = resolveDatumAxisEdge({
      reference: source.edgeReference,
      candidates: edgeVertexCandidatesForShape(kernel, shape),
      datumName,
      sourceFeatureName
    });
    return edgeMidpointDatumPoint(start, end);
  }
  const candidate = resolveDatumPointEdge({
    reference: source.edgeReference,
    candidates: edgeVertexCandidatesForShape(kernel, shape),
    datumName,
    sourceFeatureName
  });
  const fail = (detail: string) =>
    new Error(
      `Datum point "${datumName}" cannot take the centre of an edge of source feature "${sourceFeatureName}": ${detail}`
    );
  const edge = candidate.value;
  if (typeof edge !== 'number') throw fail('the edge has no exact data.');
  const type = kernel.getEdgeCurveType(edge).toLowerCase();
  if (type !== 'circle') {
    throw fail(`the edge is a ${type}, not a circular arc or circle.`);
  }
  return exactCircleCentre(kernel, edge, fail);
}

/**
 * The centre of a circular kernel edge, read exactly: the circumcentre of
 * three of its points, checked against a fourth.
 */
function exactCircleCentre(
  kernel: RemusKernel,
  edge: number,
  fail: (detail: string) => Error
): Vec3 {
  const [t0, t1] = kernel.getEdgeParamSpan(edge);
  const at = (f: number): Vec3 => {
    const p = kernel.evaluateEdgeCurve(edge, t0! + (t1! - t0!) * f);
    return { x: p[0]!, y: p[1]!, z: p[2]! };
  };
  const [a, b, c, d] = [at(0), at(1 / 3), at(2 / 3), at(0.5)];
  const center = circumcenter(a, b, c);
  if (!center) throw fail('its points do not define a circle.');
  const radius = distance3(center, a);
  if (
    Math.abs(distance3(center, d) - radius) >
    geometryTolerance(Math.max(radius, distance3(center, { x: 0, y: 0, z: 0 })))
  ) {
    throw fail('its points do not lie on one circle.');
  }
  return center;
}

function sourceFeatureNameOf(
  document: ProjectDocument,
  reference: { producingFeatureId: FeatureId }
): string {
  return (
    listFeaturesInOrder(document).find(
      (candidate) => candidate.featureId === reference.producingFeatureId
    )?.name ?? String(reference.producingFeatureId)
  );
}

function plainVector(v: { x: number; y: number; z: number }): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Schema v108: a datum plane square to an edge, read exactly from the edge
 * its lineage re-finds at the plane's history position. At a fraction, the
 * point and tangent are the kernel's own evaluation of the edge curve at
 * that fraction of its span from end 0 (of the length on a line or arc); an
 * arc also gives the plane's u, toward its centre. Through a point, the edge
 * must be straight.
 */
export function resolveNormalToEdgeDatumPlaneAtHistory(
  kernel: RemusKernel,
  document: ProjectDocument,
  source: DatumAxisEdgeSource,
  at: { fraction: number } | { point: Vec3 },
  datumName: string,
  result: ExactBuildResult,
  reverseNormal: boolean | undefined
): PlaneBasis {
  const shape = result.shapes.get(source.bodyId);
  if (!shape) {
    throw new Error(
      `Datum plane "${datumName}" cannot use an edge of body ${source.bodyId} because it is unavailable at the plane's history position.`
    );
  }
  const sourceFeatureName = sourceFeatureNameOf(document, source.edgeReference);
  const fail = (detail: string) =>
    new Error(
      `Datum plane "${datumName}" cannot stand square to an edge of source feature "${sourceFeatureName}": ${detail}`
    );
  const candidate = resolveDatumPlaneEdge({
    reference: source.edgeReference,
    candidates: edgeVertexCandidatesForShape(kernel, shape),
    datumName,
    sourceFeatureName
  });
  const start = plainVector(edgeEndPoint(candidate.endpoints!, 0));
  const end = plainVector(edgeEndPoint(candidate.endpoints!, 1));
  const type = candidate.witness.curveType.toLowerCase();
  if ('point' in at) {
    if (type !== 'line') {
      throw fail(
        `the edge is a ${type}; a plane through a point square to an edge needs a straight edge.`
      );
    }
    return normalToEdgeDatumPlane(
      at.point,
      subtract(end, start),
      undefined,
      reverseNormal
    );
  }
  if (!(at.fraction >= 0 && at.fraction <= 1)) {
    throw fail(`the fraction ${at.fraction} is not between 0 and 1.`);
  }
  const edge = candidate.value;
  if (typeof edge !== 'number') throw fail('the edge has no exact data.');
  const [t0, t1] = kernel.getEdgeParamSpan(edge);
  const first = kernel.evaluateEdgeCurve(edge, t0!);
  const p0 = { x: first[0]!, y: first[1]!, z: first[2]! };
  // The curve's own parameter may run from end 1 to end 0.
  const forward = distance3(p0, start) <= distance3(p0, end);
  const t = forward
    ? t0! + (t1! - t0!) * at.fraction
    : t1! - (t1! - t0!) * at.fraction;
  const d1 = kernel.evaluateEdgeCurveD1(edge, t);
  const point = { x: d1[0]!, y: d1[1]!, z: d1[2]! };
  const sense = forward ? 1 : -1;
  const tangent = { x: d1[3]! * sense, y: d1[4]! * sense, z: d1[5]! * sense };
  const centre =
    type === 'circle' ? exactCircleCentre(kernel, edge, fail) : undefined;
  try {
    return normalToEdgeDatumPlane(point, tangent, centre, reverseNormal);
  } catch (error) {
    throw fail(errorText(error));
  }
}

/**
 * Schema v108: the straight edge a plane at an angle turns about, end 0
 * first, re-found through verified lineage at the plane's history position.
 */
export function resolveEdgeAngleDatumPlaneAtHistory(
  kernel: RemusKernel,
  document: ProjectDocument,
  source: DatumAxisEdgeSource,
  reference: PlaneBasis,
  angleDeg: number,
  datumName: string,
  result: ExactBuildResult,
  reverseNormal: boolean | undefined
): PlaneBasis {
  const shape = result.shapes.get(source.bodyId);
  if (!shape) {
    throw new Error(
      `Datum plane "${datumName}" cannot use an edge of body ${source.bodyId} because it is unavailable at the plane's history position.`
    );
  }
  const sourceFeatureName = sourceFeatureNameOf(document, source.edgeReference);
  const candidate = resolveDatumPlaneEdge({
    reference: source.edgeReference,
    candidates: edgeVertexCandidatesForShape(kernel, shape),
    datumName,
    sourceFeatureName
  });
  const type = candidate.witness.curveType.toLowerCase();
  if (type !== 'line') {
    throw new Error(
      `Datum plane "${datumName}" cannot turn about an edge of source feature "${sourceFeatureName}": the edge is a ${type}, not a straight edge.`
    );
  }
  const start = plainVector(edgeEndPoint(candidate.endpoints!, 0));
  const end = plainVector(edgeEndPoint(candidate.endpoints!, 1));
  try {
    return edgeAngleDatumPlane(start, end, reference, angleDeg, reverseNormal);
  } catch (error) {
    throw new Error(
      `Datum plane "${datumName}" cannot turn about an edge of source feature "${sourceFeatureName}": ${errorText(error)}`,
      { cause: error }
    );
  }
}

/**
 * Schema v108: the axis square to a face where `point` drops onto it, read
 * exactly: the kernel carries the point to the nearest point of the face's
 * surface and evaluates the outward normal there. A foot that does not lie
 * on the body's boundary has fallen off the face and is refused.
 */
export function resolveFaceNormalDatumAxisAtHistory(
  kernel: RemusKernel,
  document: ProjectDocument,
  source: DatumAxisFaceSource,
  point: Vec3,
  datumName: string,
  result: ExactBuildResult,
  reverseDirection: boolean | undefined
): DatumAxis {
  const shape = result.shapes.get(source.bodyId);
  if (!shape) {
    throw new Error(
      `Datum axis "${datumName}" cannot use a face of body ${source.bodyId} because it is unavailable at the axis's history position.`
    );
  }
  const sourceFeatureName = sourceFeatureNameOf(document, source.faceReference);
  const fail = (detail: string) =>
    new Error(
      `Datum axis "${datumName}" cannot stand square to a face of source feature "${sourceFeatureName}": ${detail}`
    );
  const candidate = resolveDatumAxisNormalFace({
    reference: source.faceReference,
    candidates: faceAttachmentCandidatesForShape(kernel, shape),
    datumName,
    sourceFeatureName
  });
  const face = candidate.value;
  if (typeof face !== 'number') throw fail('the face has no exact data.');
  const owner = shape.solids.find((solid) =>
    Array.from(kernel.getSolidFaces(solid)).includes(face)
  );
  if (owner === undefined) throw fail('the face belongs to no solid.');
  const projected = kernel.projectPointOnSurface(
    face,
    point.x,
    point.y,
    point.z
  );
  const [u, v] = [projected[0]!, projected[1]!];
  const foot = { x: projected[2]!, y: projected[3]!, z: projected[4]! };
  if (![u, v, foot.x, foot.y, foot.z].every(Number.isFinite)) {
    throw fail('the point does not drop onto the face.');
  }
  const scaleOf = Math.max(1, Math.hypot(foot.x, foot.y, foot.z));
  const tolerance = geometryTolerance(scaleOf);
  let raw: Float64Array;
  try {
    raw = kernel.evaluateSurfaceNormal(face, u, v);
  } catch (error) {
    throw fail(`the face has no normal there (${errorText(error)}).`);
  }
  const normal = { x: raw[0]!, y: raw[1]!, z: raw[2]! };
  // Off a plane, (u, v) must give back the foot itself; a plane's normal is
  // the same everywhere, and the kernel evaluates a plane in its own frame.
  if (candidate.witness.surfaceType.toLowerCase() !== 'plane') {
    const back = kernel.evaluateSurface(face, u, v);
    if (
      distance3({ x: back[0]!, y: back[1]!, z: back[2]! }, foot) >
      10 * tolerance
    ) {
      throw fail('the face cannot be evaluated where the point drops onto it.');
    }
  }
  // On the face: the foot is on the body's boundary, or (where the kernel's
  // classifier reads a face's own edge or corner as outside) a point ten
  // tolerances from it, along the face, is.
  const length = Math.hypot(normal.x, normal.y, normal.z);
  if (!(length > 0)) throw fail('the face has no normal there.');
  const n = scale(normal, 1 / length);
  const seed =
    Math.abs(n.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const t1 = normalized(cross(n, seed));
  if (!t1) throw fail('the face has no normal there.');
  const t2 = cross(n, t1);
  const step = 10 * tolerance;
  const probes = [
    foot,
    ...(
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1]
      ] as const
    ).map(([a, b]) => ({
      x: foot.x + (t1.x * a + t2.x * b) * step,
      y: foot.y + (t1.y * a + t2.y * b) * step,
      z: foot.z + (t1.z * a + t2.z * b) * step
    }))
  ];
  if (
    !probes.some(
      (p) =>
        kernel.classifyPoint(owner, p.x, p.y, p.z, tolerance) === 'boundary'
    )
  ) {
    throw fail(
      "the point drops onto the face's surface beyond the face itself."
    );
  }
  try {
    return faceNormalDatumAxis(foot, normal, reverseDirection);
  } catch (error) {
    throw fail(errorText(error));
  }
}

function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** The centre of the circle through three points, or null when collinear. */
function circumcenter(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const n = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x
  };
  const nn = n.x * n.x + n.y * n.y + n.z * n.z;
  if (!(nn > 0)) return null;
  const ab2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const ac2 = ac.x * ac.x + ac.y * ac.y + ac.z * ac.z;
  // ((|ab|² ac − |ac|² ab) × n) / (2 |n|²)
  const w = {
    x: ab2 * ac.x - ac2 * ab.x,
    y: ab2 * ac.y - ac2 * ab.y,
    z: ab2 * ac.z - ac2 * ab.z
  };
  const cross = {
    x: w.y * n.z - w.z * n.y,
    y: w.z * n.x - w.x * n.z,
    z: w.x * n.y - w.y * n.x
  };
  return {
    x: a.x + cross.x / (2 * nn),
    y: a.y + cross.y / (2 * nn),
    z: a.z + cross.z / (2 * nn)
  };
}

/**
 * R01: the line a consumer's datum axis reference resolved to earlier in this
 * build. A datum axis that failed, is suppressed or comes later is refused by
 * name; no stored or sketch axis stands in for it.
 */
export function resolveDatumAxisRefAtHistory(
  document: ProjectDocument,
  ref: DatumAxisRef,
  owner: string,
  result: ExactBuildResult
): DatumAxis {
  const axis = result.datumAxes.get(ref.datumFeatureId);
  if (!axis) {
    const datum = listFeaturesInOrder(document).find(
      (candidate) => candidate.featureId === ref.datumFeatureId
    );
    throw new Error(
      `${owner} cannot use datum axis "${datum?.name ?? ref.datumFeatureId}" because it is unavailable at this point in history.`
    );
  }
  return axis;
}

export function makeProfileFace(
  kernel: RemusKernel,
  data: SketchObjectData,
  basis: PlaneBasis,
  offset: number,
  scope: Record<string, number>,
  documentUnits: UnitSystem
): number {
  if (data.objectKind === 'circle') {
    const center = pointOnPlane(
      basis,
      {
        x: resolveParamValue(data.centerX, scope, 'center X', documentUnits),
        y: resolveParamValue(data.centerY, scope, 'center Y', documentUnits)
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
      resolveParamValue(data.radius, scope, 'radius', documentUnits)
    );
    const wire = kernel.makeWire(Uint32Array.of(edge), true);
    return kernel.makePlanarFaceFromWire(wire);
  }

  const points = profilePoints(data, scope, documentUnits).map((point) =>
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

/**
 * Every primitive dimension is a length in the document's units, so a
 * suffixed size (`1 in + 25.4 mm`) builds what the form previewed. The form
 * refuses an angle or area typed into a size; this build does not repeat
 * that check, to keep the kernel worker chunk inside its size budget.
 */
export function buildPrimitive(
  kernel: RemusKernel,
  feature: FeatureNode,
  scope: Record<string, number>,
  documentUnits: UnitSystem
): ExactShape {
  if (feature.data.featureKind !== 'primitive') {
    throw new Error('Expected a primitive feature.');
  }
  const data = feature.data;
  const dimension = (key: string): number =>
    resolveParamValue(data.dimensions[key] ?? 0, scope, key, documentUnits);
  let solid: number;
  switch (data.primitiveKind) {
    case 'box':
      solid = kernel.makeBox(
        dimension('width'),
        dimension('height'),
        dimension('depth')
      );
      break;
    case 'cylinder': {
      const radius = dimension('radius');
      const height = dimension('height');
      if (radius <= 0 || height <= 0) {
        const size = radius <= 0 ? 'radius' : 'height';
        throw new AdapterRefusal(
          'cylinder_dimension_not_positive',
          `The ${size} must be greater than zero.`
        );
      }
      solid = kernel.makeCylinder(radius, height);
      break;
    }
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
    ...(data.primitiveKind === 'box' ? { rectangularStock: solid } : {}),
    lineage: buildPrimitiveLineage(kernel, solid, feature)
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
export function makeRegionFace(
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
        const a = planePoint3(basis, curve.a);
        const b = planePoint3(basis, curve.b);
        edges.push(kernel.makeLineEdge(a.x, a.y, a.z, b.x, b.y, b.z));
        continue;
      }
      if (curve.kind === 'bezier') {
        if (exactBeziers) {
          // Split where the kernel would misread the curve as a circle and
          // build a cylinder wall that misses its own cap edges (remus
          // extrude side-face recognition; see kernelSafeBezierPieces).
          for (const piece of kernelSafeBezierPieces(curve)) {
            edges.push(
              kernel.liftCurve2dToPlane(
                NURBS_CURVE_TYPE,
                bezierNurbsParams(piece),
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
          }
          continue;
        }
        // Feature-flagged fallback: the same line pipeline every polygon
        // uses. The endpoints are the curve's own point objects, so the
        // joints with the neighbouring edges stay bit-identical.
        flattened += 1;
        const points = flattenBezierCurve(curve);
        for (let index = 0; index + 1 < points.length; index += 1) {
          const a = planePoint3(basis, points[index]!);
          const b = planePoint3(basis, points[index + 1]!);
          edges.push(kernel.makeLineEdge(a.x, a.y, a.z, b.x, b.y, b.z));
        }
        continue;
      }
      if (curve.kind === 'ellipse' || curve.kind === 'spline') {
        if (!rightHanded) {
          throw new Error(
            `An exact ${curve.kind} profile needs a right-handed sketch plane frame.`
          );
        }
        edges.push(
          ...(curve.kind === 'ellipse'
            ? ellipseRegionEdges(kernel, basis, curve)
            : splineRegionEdges(kernel, basis, curve))
        );
        continue;
      }
      const span = Math.abs(curve.endAngle - curve.startAngle);
      const center = planePoint3(basis, curve.center);
      if (span >= Math.PI * 2 - 1e-9) {
        // A standalone circle traces as one full-turn piece; the arc
        // constructor degenerates at start == end, so use a circle edge.
        const counterClockwise = kernel.makeCircleEdge(
          center.x,
          center.y,
          center.z,
          basis.normal.x,
          basis.normal.y,
          basis.normal.z,
          curve.radius
        );
        if (curve.ccw) {
          edges.push(counterClockwise);
          continue;
        }
        // A hole loop traces clockwise, and the direction has to survive
        // into the edge: a circle's sense lives in its axis, not in a
        // separate flag. Extruding a face whose inner wire runs the same
        // way as its outer one still validates, but leaves the solid's
        // inner-loop edges mis-oriented, and the next boolean on that body
        // fails with inconsistent face orientations.
        //
        // Flipping the axis alone would also move the seam vertex to the
        // far side of the circle. That vertex is in the cap face's vertex
        // mean, which every persisted face reference — and every hole's
        // (u, v) origin — is measured against, so the seam is pinned to
        // where the counter-clockwise circle put it.
        const seam = kernel.evaluateEdgeCurve(counterClockwise, 0);
        edges.push(
          kernel.makeCircleEdgeWithRef(
            center.x,
            center.y,
            center.z,
            -basis.normal.x,
            -basis.normal.y,
            -basis.normal.z,
            curve.radius,
            seam[0]! - center.x,
            seam[1]! - center.y,
            seam[2]! - center.z
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
        const start = planePoint3(basis, {
          x: curve.center.x + Math.cos(angleA) * curve.radius,
          y: curve.center.y + Math.sin(angleA) * curve.radius
        });
        const end = planePoint3(basis, {
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

/**
 * Which segment of its source object a boundary line lies on. A side face
 * swept from that line is then named by the object's own structure — a
 * rectangle or polygon side keeps its index through a resize, the same rule
 * the whole-object sweep uses — instead of by its position in the traced
 * loop, which the arrangement is free to start anywhere. Null when the object
 * has no segment list or the line sits on none of its segments.
 */
function sourceSegmentIndex(
  curve: Extract<RegionCurve, { kind: 'line' }>,
  data: SketchObjectData | undefined,
  scope: Record<string, number>,
  documentUnits: UnitSystem
): number | null {
  if (
    !data ||
    (data.objectKind !== 'rectangle' && data.objectKind !== 'polygon')
  ) {
    return null;
  }
  let points: Vec2Like[];
  try {
    points = profilePoints(data, scope, documentUnits);
  } catch {
    return null;
  }
  const extent = Math.max(
    1,
    ...points.flatMap((point) => [Math.abs(point.x), Math.abs(point.y)])
  );
  const tolerance = geometryTolerance(extent);
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]!;
    const end = points[(index + 1) % points.length]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= tolerance) {
      continue;
    }
    const onSegment = (point: Vec2Like): boolean => {
      const offAxis =
        Math.abs(dx * (point.y - start.y) - dy * (point.x - start.x)) / length;
      if (offAxis > tolerance) {
        return false;
      }
      const along =
        ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        (length * length);
      const slack = tolerance / length;
      return along >= -slack && along <= 1 + slack;
    };
    if (onSegment(curve.a) && onSegment(curve.b)) {
      return index;
    }
  }
  return null;
}

/**
 * Names the side faces of a region sweep after the sketch entities that drew
 * them. Every boundary curve of a region carries the id of the object it came
 * from, and a side face is exactly that curve swept along the normal: a line
 * becomes a plane carrier, an arc a cylinder carrier. Without this every side
 * of a region-extruded body is hash-only, so nothing can be attached to it —
 * a sketch on the front of a drag-extruded plate was refused for that reason.
 *
 * Fails closed the way the rest of the lineage does: a curve that cannot be
 * placed on its object, a bezier (no analytic carrier), or one segment drawn
 * as two separate pieces of boundary all stay hash-only rather than guessed.
 */
function addRegionSideRoles(input: {
  candidates: ReturnType<typeof topologyCandidatesForSolid>;
  region: SketchRegion;
  token: string;
  basis: PlaneBasis;
  totalDistance: number;
  objectsById: ReadonlyMap<string, SketchObjectData>;
  scope: Record<string, number>;
  documentUnits: UnitSystem;
  assignments: RemusSemanticAssignment[];
  diagnostics: RemusLineageState[];
}) {
  const { basis } = input;
  const sweep = scale(basis.normal, input.totalDistance);
  const roles = new Map<string, Array<FaceWitnessV1['analytic'] | null>>();
  const propose = (name: string, carrier: FaceWitnessV1['analytic'] | null) => {
    roles.set(name, [...(roles.get(name) ?? []), carrier]);
  };
  for (const loop of [input.region.outer, ...input.region.holes]) {
    for (const curve of loop.curves) {
      const data = input.objectsById.get(curve.sourceObjectId);
      const boundary = parseSketchBoundaryToken(curve.boundaryToken);
      const sourceId = boundary?.objectId ?? curve.sourceObjectId;
      const prefix = `sweep.face.side.region.${input.token}.${sourceId}`;
      if (curve.kind === 'line') {
        const index =
          boundary?.kind === 'composite'
            ? boundary.edgeIndex
            : sourceSegmentIndex(curve, data, input.scope, input.documentUnits);
        const key =
          index !== null
            ? `${index}`
            : data?.objectKind === 'line'
              ? 'line'
              : null;
        if (key === null) {
          input.diagnostics.push(
            remusHashOnlyLineage(
              'sweep',
              `Selected-region side ${prefix} lies on no segment of its source object.`
            )
          );
          continue;
        }
        const start = planePoint3(basis, curve.a);
        const end = planePoint3(basis, curve.b);
        propose(
          `${prefix}.${key}`,
          planeCarrier(cross(subtract(end, start), sweep), start)
        );
        continue;
      }
      if (curve.kind === 'arc') {
        propose(
          `${prefix}.${data?.objectKind === 'circle' ? 'circle' : 'arc'}`,
          cylinderCarrier(
            planePoint3(basis, curve.center),
            basis.normal,
            curve.radius
          )
        );
        continue;
      }
      input.diagnostics.push(
        remusHashOnlyLineage(
          'sweep',
          `Selected-region side ${prefix} is a ${curve.kind} with no analytic carrier.`
        )
      );
    }
  }
  for (const [name, carriers] of roles) {
    if (carriers.length !== 1) {
      input.diagnostics.push(
        remusHashOnlyLineage(
          'sweep',
          `Semantic role ${name} is drawn by ${carriers.length} pieces of boundary.`
        )
      );
      continue;
    }
    addFaceCarrierRole(
      input.candidates,
      carriers[0]!,
      name,
      input.assignments,
      input.diagnostics
    );
  }
}

/** One boundary curve of a selected region and the name its side face takes. */
export type RegionSideSource =
  | { token: string; kind: 'line'; a: Vec2Like; b: Vec2Like }
  | { token: string; kind: 'arc'; center: Vec2Like; radius: number };

/**
 * The boundary curves of the one connected region a selection of sketch
 * cells merges into, in sketch coordinates, each with the
 * `<source object>.<segment>` suffix {@link addRegionSideRoles} names its
 * side face by. A curve with no analytic side (a spline) or no segment
 * identity is left out. Null when the selection is not one connected region.
 *
 * M16 sheet metal names its edge faces from these: unlike a carrier match,
 * each curve keeps its own extent, so two edges drawn on one line (either
 * side of a tab) are told apart.
 */
export function regionSideSources(
  document: ProjectDocument,
  sketch: SketchNode,
  data: Pick<
    Extract<FeatureNode['data'], { featureKind: 'extrude' }>,
    'profile' | 'profiles'
  >,
  scope: Record<string, number>
): RegionSideSource[] | null {
  const groups = connectedRegionGroups(
    resolveRegionProfiles(document, sketch, data, scope)
  );
  if (groups.length !== 1) return null;
  const merged = mergeAdjacentProfiles(groups[0]!);
  const objectsById = new Map<string, SketchObjectData>(
    sketch.objectIds.flatMap((objectId) => {
      const node = document.nodes[objectId];
      return node?.kind === 'sketch-object'
        ? [[objectId, node.data] as const]
        : [];
    })
  );
  const sources: RegionSideSource[] = [];
  for (const loop of [merged.outer, ...merged.holes]) {
    for (const curve of loop.curves) {
      const data = objectsById.get(curve.sourceObjectId);
      const boundary = parseSketchBoundaryToken(curve.boundaryToken);
      const sourceId = boundary?.objectId ?? curve.sourceObjectId;
      if (curve.kind === 'line') {
        const index =
          boundary?.kind === 'composite'
            ? boundary.edgeIndex
            : sourceSegmentIndex(curve, data, scope, document.units);
        const key =
          index !== null
            ? `${index}`
            : data?.objectKind === 'line'
              ? 'line'
              : null;
        if (key !== null) {
          sources.push({
            token: `${sourceId}.${key}`,
            kind: 'line',
            a: curve.a,
            b: curve.b
          });
        }
      } else if (curve.kind === 'arc') {
        sources.push({
          token: `${sourceId}.${data?.objectKind === 'circle' ? 'circle' : 'arc'}`,
          kind: 'arc',
          center: curve.center,
          radius: curve.radius
        });
      }
    }
  }
  return sources;
}

/**
 * Names the edges of a selected-region extrusion that its faces identify.
 *
 * The faces are named by what draws them: the two caps, and one side per
 * sketch entity (`addRegionSideRoles`). An edge that is the only boundary
 * between two of those faces has a construction role of its own, the pair,
 * and that role survives any edit that keeps both faces: a driving
 * dimension that moves the edge leaves it between the same cap and the same
 * entity's side. Without a name, an edge picked for a fillet or chamfer is
 * stored as a geometry hash, which stops matching as soon as the sketch is
 * resized (issue #1663). The single-profile path names its edges
 * (`buildExtrudeLineage`); this is its counterpart for regions.
 *
 * Fail closed, like every semantic role: an edge is named only when it lies
 * between exactly two faces, both named once and differently, and no other
 * edge lies between the same two. A seam, an edge on a side that stayed
 * unnamed, and a boundary a cap shares with one side in several pieces all
 * stay hash-only.
 *
 * Which cell an edge belongs to is part of its name. Two cells of one
 * sketch can be bounded by the same entities (the two ends of a bar another
 * rectangle crosses, the two halves of a circle cut by a diameter), and a
 * pick on one must never resolve on the other when the extrude's selection
 * changes. `cells` is the boundary provenance of every cell fused into this
 * solid, and it is null unless each of them is the only cell of the whole
 * sketch, selected or not, with that boundary (`cellIdentity`): then the
 * name says exactly which cells the solid is made of, and a different
 * selection cannot produce it. Otherwise no edge is named.
 */
function addRegionBoundaryEdgeRoles(
  kernel: RemusKernel,
  solid: number,
  candidates: ReturnType<typeof topologyCandidatesForSolid>,
  token: string,
  cells: string | null,
  assignments: RemusSemanticAssignment[]
) {
  if (cells === null) return;
  // The publisher keeps a face role only when the name and the face are
  // one-to-one, so only those faces can vouch for an edge.
  const nameUses = new Map<string, number>();
  const handleUses = new Map<number, number>();
  for (const assignment of assignments) {
    if (assignment.kind !== 'face') continue;
    nameUses.set(
      assignment.lineageName,
      (nameUses.get(assignment.lineageName) ?? 0) + 1
    );
    handleUses.set(
      assignment.handle,
      (handleUses.get(assignment.handle) ?? 0) + 1
    );
  }
  const faceRole = new Map<number, string>();
  const capPrefix = 'sweep.face.cap.';
  const sidePrefix = `sweep.face.side.region.${token}.`;
  for (const assignment of assignments) {
    if (
      assignment.kind !== 'face' ||
      nameUses.get(assignment.lineageName) !== 1 ||
      handleUses.get(assignment.handle) !== 1
    )
      continue;
    const name = assignment.lineageName;
    // `cap.start`, `cap.end`, or `side.<entity>.<piece>`: what tells this
    // region's faces apart, without the region token every one repeats.
    const role = name.startsWith(sidePrefix)
      ? `side.${name.slice(sidePrefix.length)}`
      : name.startsWith(`${capPrefix}start.`)
        ? 'cap.start'
        : name.startsWith(`${capPrefix}end.`)
          ? 'cap.end'
          : null;
    if (role !== null) faceRole.set(assignment.handle, role);
  }
  // The two caps never meet, so with no named side there is no edge to
  // name: a flattened text outline, whose sides stay unnamed, stops here
  // without reading its topology.
  if (![...faceRole.values()].some((role) => role.startsWith('side.'))) return;
  const facesByEdge = new Map<number, number[]>();
  for (const face of kernel.getSolidFaces(solid)) {
    for (const edge of new Set(kernel.getFaceEdges(face))) {
      const faces = facesByEdge.get(edge);
      if (faces) faces.push(face);
      else facesByEdge.set(edge, [face]);
    }
  }
  const byPair = new Map<string, (typeof candidates)[number][]>();
  for (const candidate of candidates) {
    if (candidate.kind !== 'edge') continue;
    const faces = facesByEdge.get(candidate.handle);
    if (faces?.length !== 2) continue;
    const first = faceRole.get(faces[0]!);
    const second = faceRole.get(faces[1]!);
    if (first === undefined || second === undefined || first === second)
      continue;
    const pair = [first, second].sort().join('|');
    const edges = byPair.get(pair);
    if (edges) edges.push(candidate);
    else byPair.set(pair, [candidate]);
  }
  for (const [pair, edges] of byPair) {
    if (edges.length !== 1) continue;
    assignments.push({
      ...edges[0]!,
      lineageName: `sweep.edge.region.${token}[${cells}].${pair}`
    });
  }
}

/**
 * A cell's boundary as one comparable string: for its outer loop and each
 * hole, the authored piece every curve was cut from (the sketch entity, and
 * the edge of it for a composite shape, or the kind of curve), every repeat
 * kept. It says what bounds the cell and never where the cell is, so it is
 * unchanged by an edit of the sketch's dimensions.
 */
function cellBoundaryKey(cell: SketchRegion): string {
  const loopKey = (loop: SketchRegion['outer']) =>
    loop.curves
      .map((curve) => {
        const token = parseSketchBoundaryToken(curve.boundaryToken);
        return token?.kind === 'composite'
          ? `${token.objectId}:${token.edgeIndex}`
          : `${token?.objectId ?? curve.sourceObjectId}:${curve.kind}`;
      })
      .sort()
      .join(',');
  return [loopKey(cell.outer), ...cell.holes.map(loopKey).sort()].join('|');
}

/**
 * The cells fused into one solid, as the identity an edge name carries, or
 * null when any of them shares its boundary with another cell of the sketch
 * (two halves of a circle cut by a diameter, two glyphs of one text):
 * then nothing but position distinguishes it from a cell the extrude could
 * be pointed at instead.
 */
function cellIdentity(
  group: readonly SketchRegion[],
  cellsByBoundary: ReadonlyMap<string, number>
): string | null {
  const keys: string[] = [];
  for (const cell of group) {
    const key = cellBoundaryKey(cell);
    if (cellsByBoundary.get(key) !== 1) return null;
    keys.push(key);
  }
  return keys.sort().join(';');
}

/** Extrude one or more explicitly selected bounded sketch cells. */
export function buildRegionExtrude(
  kernel: RemusKernel,
  document: ProjectDocument,
  sketch: SketchNode,
  feature: FeatureNode,
  data: Extract<FeatureNode['data'], { featureKind: 'extrude' }>,
  scope: Record<string, number>,
  basis: PlaneBasis,
  warn: (message: string) => void
): ExactShape {
  const { regions, cells } = resolveRegionProfilesInSketch(
    document,
    sketch,
    data,
    scope
  );
  // How many cells of the sketch, selected or not, have each boundary.
  const cellsByBoundary = new Map<string, number>();
  for (const cell of cells) {
    const key = cellBoundaryKey(cell);
    cellsByBoundary.set(key, (cellsByBoundary.get(key) ?? 0) + 1);
  }
  const distance = resolveParamValue(
    data.distance,
    scope,
    'distance',
    document.units
  );
  // Symmetric and two-sided region extrudes shift the basis behind the
  // sketch plane, exactly like the single-profile path.
  const { extrudeBasis, totalDistance } = resolveExtrudeSpan(
    data,
    basis,
    distance,
    scope,
    document.units
  );
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
  const built: {
    assignments: RemusSemanticAssignment[];
    diagnostics: RemusLineageState[];
  }[] = [];
  const objectsById = new Map(
    sketch.objectIds.flatMap((objectId) => {
      const node = document.nodes[objectId];
      return node?.kind === 'sketch-object'
        ? [[objectId, node.data] as const]
        : [];
    })
  );
  const solids = groups.map((group) => {
    const merged = mergeAdjacentProfiles(group);
    const sweep = forwardSweep(extrudeBasis, totalDistance);
    const face = makeRegionFace(kernel, merged, sweep.faceBasis, warn);
    const solid = kernel.extrude(
      face,
      extrudeBasis.normal.x,
      extrudeBasis.normal.y,
      extrudeBasis.normal.z,
      sweep.sweepDistance
    );
    const candidates = topologyCandidatesForSolid(kernel, solid);
    const assignments: RemusSemanticAssignment[] = [];
    const diagnostics: RemusLineageState[] = [];
    const sourceEntityIds = [
      ...new Set(
        group.flatMap((region) =>
          [region.outer, ...region.holes].flatMap((loop) =>
            loop.curves.map(
              (curve) =>
                parseSketchBoundaryToken(curve.boundaryToken)?.objectId ??
                curve.sourceObjectId
            )
          )
        )
      )
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
        x: extrudeBasis.origin.x + extrudeBasis.normal.x * totalDistance,
        y: extrudeBasis.origin.y + extrudeBasis.normal.y * totalDistance,
        z: extrudeBasis.origin.z + extrudeBasis.normal.z * totalDistance
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
      addRegionSideRoles({
        candidates,
        region: merged,
        token,
        basis: extrudeBasis,
        totalDistance,
        objectsById,
        scope,
        documentUnits: document.units,
        assignments,
        diagnostics
      });
      addRegionBoundaryEdgeRoles(
        kernel,
        solid,
        candidates,
        token,
        cellIdentity(group, cellsByBoundary),
        assignments
      );
    }
    built.push({ assignments, diagnostics });
    return solid;
  });
  // A name is one edge of the feature, not one edge of each solid: where two
  // disconnected cells would publish the same edge name, neither does.
  const edgeNameUses = new Map<string, number>();
  for (const { assignments } of built) {
    for (const assignment of assignments) {
      if (assignment.kind !== 'edge') continue;
      edgeNameUses.set(
        assignment.lineageName,
        (edgeNameUses.get(assignment.lineageName) ?? 0) + 1
      );
    }
  }
  return {
    solids,
    lineage: mergeRemusLineageStates(
      built.map(({ assignments, diagnostics }) =>
        mergeRemusLineageStates([
          createRemusSemanticLineage(
            feature.featureId,
            'sweep',
            assignments.filter(
              (assignment) =>
                assignment.kind !== 'edge' ||
                edgeNameUses.get(assignment.lineageName) === 1
            )
          ),
          ...diagnostics
        ])
      )
    )
  };
}

/**
 * U09: turns one selected sketch region about the revolve's axis. The face
 * is resolved exactly as a loft or sweep section is, so a region drawn as
 * separate edges revolves like any authored closed object.
 */
function buildRegionRevolve(
  kernel: RemusKernel,
  document: ProjectDocument,
  data: Extract<FeatureNode['data'], { featureKind: 'revolve' }>,
  profile: SketchProfileReference,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
  warn: (message: string) => void,
  revolveAxis?: DatumAxis
): ExactShape {
  const sketch = findSketch(document, data.sketchId);
  if (!sketch) {
    throw new Error('Referenced sketch no longer exists.');
  }
  const basis = sketchBases.get(sketch.sketchId);
  if (!basis) {
    throw new Error(
      `Sketch "${sketch.name}" plane did not resolve at its history position.`
    );
  }
  // Every region the reference names, joined into connected groups the way
  // a region extrude joins them: an entity-wide pick of multi-glyph text is
  // several closed profiles, each turned on its own.
  const regions = resolveRegionProfiles(document, sketch, { profile }, scope);
  if (regions.length === 0) {
    throw new Error('Revolve profile must resolve to a closed profile.');
  }
  const flattenedOutlines = regions.filter(
    (region) => region.outline?.fidelity === 'flattened'
  ).length;
  if (flattenedOutlines > 0) {
    warn(flattenedOutlineWarning(flattenedOutlines));
  }
  if (data.axisRef && !revolveAxis) {
    throw new Error('Revolve datum axis did not resolve.');
  }
  if (revolveAxis) requireRevolveAxisInPlane(revolveAxis, basis, sketch.name);
  const direction = revolveAxis
    ? revolveAxis.direction
    : data.axis === 'vertical'
      ? basis.v
      : basis.u;
  const point = revolveAxis
    ? revolveAxis.origin
    : pointOnPlane(basis, { x: 0, y: 0 }, 0);
  const angleDeg = resolveRevolveAngleDeg(data.angleDeg, scope);
  const solids = connectedRegionGroups(regions).map((group) =>
    kernel.revolve(
      makeRegionFace(kernel, mergeAdjacentProfiles(group), basis, warn),
      point.x,
      point.y,
      point.z,
      direction.x,
      direction.y,
      direction.z,
      angleDeg
    )
  );
  return {
    solids,
    lineage: remusHashOnlyLineage('sweep', REGION_REVOLVE_HASH_ONLY_REASON)
  };
}

export function sectionFace(
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
  return makeRegionFace(kernel, profiles[0]!, basis, warn);
}

/**
 * The plane a loft section was drawn on, resolved at the feature's history
 * position. {@link sectionFace} resolves the same basis to build the face;
 * an apex point needs it again to prove it stands off that plane.
 */
function sectionPlane(
  document: ProjectDocument,
  section: SketchSectionReference,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
  label: string
): PlaneBasis {
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
  return basis;
}

/**
 * How far off its section's plane a loft apex point has to stand. The kernel
 * takes an apex on the section plane without complaint and returns the
 * un-apexed loft, so the degenerate case is refused here instead.
 */
const LOFT_APEX_MIN_STANDOFF = 1e-6;

/**
 * The curved B-Rep faces of a solid, counted by surface type.
 *
 * `getSurfaceType` reports the analytic type a face's surface really carries —
 * `plane`, `cylinder`, `cone`, `sphere`, `torus` or `bspline` — and reports
 * the analytic type even for a NURBS patch that is exactly one. So anything
 * that is not `plane` is an exact curved surface the body would lose if the
 * kernel rebuilt it as facets, and a census of those is the whole measurement
 * {@link refuseLostExactSurfaces} needs.
 */
function curvedSurfaceCensus(
  kernel: RemusKernel,
  solid: number
): Map<string, number> {
  const census = new Map<string, number>();
  for (const face of kernel.getSolidFaces(solid)) {
    const surfaceType = kernel.getSurfaceType(face);
    if (surfaceType === 'plane') continue;
    census.set(surfaceType, (census.get(surfaceType) ?? 0) + 1);
  }
  return census;
}

/** The total across a {@link curvedSurfaceCensus}. */
function curvedFaceCount(census: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const count of census.values()) total += count;
  return total;
}

/** `2 cone and 1 cylinder faces` — a census, said out loud for a refusal. */
function describeCurvedSurfaces(census: ReadonlyMap<string, number>): string {
  const parts = [...census.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([surfaceType, count]) => `${count} ${surfaceType}`);
  if (parts.length === 0) return 'no curved';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}

/**
 * Refuse an optional modelling control that costs the body its exact curved
 * surfaces.
 *
 * Both of the kernel entry points behind these controls — `loftWithOptions`
 * with an apex point, and `guidedSweep` with a rail — rebuild the body on a
 * chordal approximation of whatever curved surfacing the plain call produced.
 * Measured on the pinned kernel: two circles r = 2 and r = 3 ten apart loft to
 * one exact cone plus two planes, and to 66 planes with an apex — 0.64% short
 * of the analytic volume; a circular profile swept along a line is one exact
 * cylinder plus two planes, and 74 planes once a rail is given — 2.02% short,
 * with the rail parallel to the path so the true answer is unchanged. Neither
 * raises anything: `validateSolid` passes, no warning is emitted, and the body
 * is still offered for STEP export.
 *
 * That is a silent downgrade of an exact result to an approximate one, so it
 * is refused by name instead — the same reasoning the smooth-mode guide rail
 * is already refused on, applied to the case that measures it.
 *
 * The test is the measurement, not a list of profile kinds: build the body
 * both ways and compare the two censuses. A plain build with no curved faces
 * has nothing to lose, so every planar case goes through untouched — measured,
 * a rectangular profile on a parallel rail still sweeps to exactly 160 mm³.
 * And if a later kernel holds the exact surfaces, the census matches and the
 * control is admitted with no change here.
 */
function refuseLostExactSurfaces(
  kernel: RemusKernel,
  plain: number,
  optioned: number,
  control: string,
  remedy: string
): void {
  const plainCensus = curvedSurfaceCensus(kernel, plain);
  const plainCurved = curvedFaceCount(plainCensus);
  if (plainCurved === 0) return;
  const optionedCensus = curvedSurfaceCensus(kernel, optioned);
  if (curvedFaceCount(optionedCensus) >= plainCurved) return;
  throw new Error(
    `${control} would drop this body's exact curved surfaces: the same build carries ${describeCurvedSurfaces(plainCensus)} ${plainCurved === 1 ? 'face' : 'faces'} without it and ${describeCurvedSurfaces(optionedCensus)} ${curvedFaceCount(optionedCensus) === 1 ? 'face' : 'faces'} with it, because the kernel rebuilds the whole body as flat facets for this option. A faceted body measures and exports as if it were exact, so it is refused rather than shipped. ${remedy}`
  );
}

/**
 * Resolve a loft apex point and prove it stands off the section it closes.
 *
 * The kernel takes an apex on the closing section's own plane without
 * complaint and hands back the unapexed loft, so that degenerate request is
 * refused here by name. Whether the apex *adds* material is not decided from
 * the geometry — it is measured. See {@link buildLoft}.
 */
function loftApexPoint(
  value: { x: ParamValue; y: ParamValue; z: ParamValue },
  basis: PlaneBasis,
  scope: Record<string, number>,
  label: string
): [number, number, number] {
  const point = resolveParametricPoint(value, scope, label);
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(point.z)
  ) {
    throw new Error(`${label} must resolve to finite coordinates.`);
  }
  const standoff = dot(subtract(point, basis.origin), basis.normal);
  if (Math.abs(standoff) < LOFT_APEX_MIN_STANDOFF) {
    throw new Error(
      `${label} lies on the plane of the section it closes, which would cap the loft with a flat point instead of an apex. Move it off that plane or clear it.`
    );
  }
  return [point.x, point.y, point.z];
}

/** Keep construction refusals in the same context as validation failures. */
function validatedLoft(
  kernel: RemusKernel,
  build: () => number,
  label: string
): number {
  let solid: number;
  try {
    solid = build();
  } catch (error) {
    throw new Error(
      `${label} did not produce a valid closed solid. ${errorText(error)}`,
      { cause: error }
    );
  }
  return validateGeneratedSolid(kernel, solid, label);
}

/**
 * The same section run lofted *without* the apex point, or null when that run
 * does not loft into a valid solid at all.
 *
 * It answers three questions with one build. Its volume is the baseline the
 * apexed loft has to beat, its solid is the exact-surface census the apexed
 * build has to match, and its absence says the section run itself is what the
 * kernel cannot take, so the refusal must not send the user after the apex.
 */
function unapexedLoft(
  kernel: RemusKernel,
  handles: Uint32Array
): { readonly solid: number; readonly volume: number } | null {
  try {
    const solid = validatedLoft(kernel, () => kernel.loft(handles), 'Loft');
    return { solid, volume: kernel.volume(solid, MEASUREMENT_DEFLECTION) };
  } catch {
    return null;
  }
}

/**
 * How much more material the apex has to add before it counts as added. Both
 * volumes are measurements of the same body under the same tessellation, so
 * the only slack a sound apex needs is the rounding of that measurement: the
 * model's own tolerance, read as a volume, is ~1e-6 mm³ — five orders above
 * double-precision rounding on a millimetre-scale body, and (on planar
 * sections, where the two builds surface the run the same way) an order below
 * the smallest apex {@link LOFT_APEX_MIN_STANDOFF} admits: a 2e-6 mm standoff
 * over a 64 mm² section adds 4.3e-5 mm³ and is accepted, measured. Its
 * relative term keeps both of those true for a large model.
 */
function apexVolumeSlack(unapexed: number, apexed: number): number {
  return geometryTolerance(Math.max(unapexed, apexed));
}

/**
 * Loft the feature's sections, optionally closing the run to an apex point.
 *
 * The kernel applies `endPoint` unconditionally. An apex on the wrong side of
 * the closing section folds the final ruled band back through the body: the
 * result intersects itself, the apex is buried out of sight so the viewport
 * looks unchanged, `validateSolid` reports nothing, and the volume that feeds
 * mass properties, downstream booleans and STEP export is silently *smaller*
 * than the same loft with no apex at all. Measured on the pinned kernel:
 *
 * | sections | apex | no apex | with apex |
 * | --- | --- | --- | --- |
 * | z = 0, 10 | z = 5 | 373.3333 | 266.6667 |
 * | z = 0, 10, 10 | z = 5 | 373.3333 | 313.3333 |
 * | z = 0, 20, 10 | z = 5 | 253.3333 | 193.3333 |
 * | XZ at y = -20, XY at z = 10 | (0, 25, 0) | 2000.0000 | 1666.6667 |
 *
 * Which side "the wrong side" is cannot be read off the sketch planes. Two
 * earlier guards tried, from the closing plane's normal and where the other
 * sections sit along it, and both were fail-open: that reasoning says nothing
 * at all about a section that is not parallel to the closing plane, and a
 * section that *straddles* it (the last row) satisfies any such test on both
 * sides at once.
 *
 * So the invariant is measured instead, and it is the one that actually
 * matters: **a closing apex may only add material.** The run is lofted again
 * without the apex and the two volumes are compared; anything that does not
 * gain more than {@link apexVolumeSlack} is refused by name. That costs one
 * extra loft, and only on a loft that asks for an apex.
 *
 * Two refusals stand in front of that comparison, and both are measured from
 * the same pair of builds. {@link refuseLostExactSurfaces} refuses an apex
 * over curved sections, because the kernel's apexed surfacing is chordal and
 * would turn one exact cone into 66 flat facets. And a run the kernel cannot
 * loft without the apex is refused outright rather than given a substitute
 * baseline, because the runs that reach that branch are degenerate: sections
 * lying wholly in the closing plane build a pyramid off the last section and
 * keep every earlier one as a zero-thickness web with no material in it.
 */
/** M04 (v133): a loft connection's vertex, in world coordinates. */
function loftConnectionPoint(
  document: ProjectDocument,
  section: SketchSectionReference,
  vertex: LoftConnectionVertex,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
  index: number
): Vec3 {
  const label = `Loft section ${index + 1}`;
  const basis = sectionPlane(document, section, sketchBases, label);
  const sketch = findSketch(document, section.sketchId)!;
  const resolve = (value: ParamValue) =>
    resolveParamValue(value, scope, 'loft connection', document.units);
  if (vertex.kind === 'shape-corner') {
    const objects = new Map<string, SketchObjectData>();
    for (const id of sketch.objectIds) {
      const node = document.nodes[id];
      if (node?.kind === 'sketch-object') objects.set(id, node.data);
    }
    const resolved = resolveSketchShapePointTarget(vertex, objects, resolve);
    if (resolved.status !== 'resolved') {
      throw new Error(`${label} connection: ${resolved.reason}`);
    }
    return planePoint3(basis, resolved.point);
  }
  const node = document.nodes[vertex.entityId];
  if (
    node?.kind !== 'sketch-object' ||
    !sketch.objectIds.includes(vertex.entityId)
  ) {
    throw new Error(
      `${label} connection names a curve that is not in the section's sketch.`
    );
  }
  const data = node.data;
  if (data.objectKind === 'line') {
    return planePoint3(
      basis,
      vertex.end === 'start'
        ? { x: resolve(data.x1), y: resolve(data.y1) }
        : { x: resolve(data.x2), y: resolve(data.y2) }
    );
  }
  if (data.objectKind === 'arc') {
    const angle =
      (resolve(vertex.end === 'start' ? data.startAngleDeg : data.endAngleDeg) *
        Math.PI) /
      180;
    const radius = resolve(data.radius);
    return planePoint3(basis, {
      x: resolve(data.centerX) + radius * Math.cos(angle),
      y: resolve(data.centerY) + radius * Math.sin(angle)
    });
  }
  throw new Error(
    `${label} connection names a ${data.objectKind}; a connection is the end of a line or arc, or a corner of a rectangle or polygon.`
  );
}

/**
 * M04 (v133): where one straight loft guide meets each section's plane. A
 * ruled loft's edge between those points is exactly the guide; the kernel
 * refuses a point that is not a vertex of its section.
 */
function loftGuidePoints(
  document: ProjectDocument,
  sections: readonly SketchSectionReference[],
  guide: SketchPathReference,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>
): Vec3[] {
  const sketch = findSketch(document, guide.sketchId);
  const basis = sketch ? sketchBases.get(sketch.sketchId) : undefined;
  if (!sketch || !basis) {
    throw new Error('The loft guide sketch no longer resolves.');
  }
  const [entityId, ...rest] = guide.entityIds;
  const node = entityId ? document.nodes[entityId] : undefined;
  if (
    rest.length > 0 ||
    !entityId ||
    node?.kind !== 'sketch-object' ||
    !sketch.objectIds.includes(entityId)
  ) {
    const message = 'A loft guide is one curve of its guide sketch.';
    throw new KernelRefusal({
      family: 'modeling',
      category: 'unsupported',
      kernelCode: 'loft-guide:not-one-curve',
      kernelMessage: message,
      reason: message,
      message: message
    });
  }
  if (node.data.objectKind !== 'line') {
    const message =
      'A loft guide must be a straight line: a curved guide has no exact construction yet. Draw the guide as a line, or clear it.';
    throw new KernelRefusal({
      family: 'modeling',
      category: 'unsupported',
      kernelCode: 'loft-guide:curved',
      kernelMessage: message,
      reason: message,
      message: message
    });
  }
  const data = node.data;
  const resolve = (value: ParamValue) =>
    resolveParamValue(value, scope, 'loft guide', document.units);
  const a = planePoint3(basis, { x: resolve(data.x1), y: resolve(data.y1) });
  const b = planePoint3(basis, { x: resolve(data.x2), y: resolve(data.y2) });
  const along = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  return sections.map((section, index) => {
    const plane = sectionPlane(
      document,
      section,
      sketchBases,
      `Loft section ${index + 1}`
    );
    const n = plane.normal;
    const rise = n.x * along.x + n.y * along.y + n.z * along.z;
    const t =
      (n.x * (plane.origin.x - a.x) +
        n.y * (plane.origin.y - a.y) +
        n.z * (plane.origin.z - a.z)) /
      rise;
    if (!Number.isFinite(t) || t < -1e-9 || t > 1 + 1e-9) {
      const message = `The loft guide does not reach section ${index + 1}: a guide runs from the first section to the last, through each.`;
      throw new KernelRefusal({
        family: 'modeling',
        category: 'unsupported',
        kernelCode: 'loft-guide:short',
        kernelMessage: message,
        reason: message,
        message: message
      });
    }
    return { x: a.x + along.x * t, y: a.y + along.y * t, z: a.z + along.z * t };
  });
}

/** M04: a guide that is one straight sketch line on a ruled loft. */
function straightGuideOnRuledLoft(
  document: ProjectDocument,
  guide: SketchPathReference,
  mode: string
): boolean {
  if (mode === 'smooth') return false;
  const [entityId] = guide.entityIds;
  const node = entityId ? document.nodes[entityId] : undefined;
  return (
    node?.kind === 'sketch-object' &&
    node.data.objectKind === 'line' &&
    node.data.construction !== true
  );
}

/**
 * M04: the loft guide as the kernel's exact NURBS, in world coordinates: one
 * curve of its guide sketch, a line, an arc or a spline taken whole.
 */
function loftGuideCurve(
  kernel: RemusKernel,
  document: ProjectDocument,
  guide: SketchPathReference,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>
): {
  degree: number;
  knots: number[];
  controlPoints: number[][];
  weights: number[];
} {
  const sketch = findSketch(document, guide.sketchId);
  const [entityId, ...rest] = guide.entityIds;
  const node = entityId ? document.nodes[entityId] : undefined;
  // What the picker offers is all a stored guide may name: a line, an arc
  // or an open spline that is not construction geometry. A guide turned
  // into construction (or a circle, a closed spline) after it was picked
  // is refused, not built.
  if (
    !sketch ||
    rest.length > 0 ||
    !entityId ||
    node?.kind !== 'sketch-object' ||
    !sketch.objectIds.includes(entityId)
  ) {
    const message = 'A loft guide is one curve of its guide sketch.';
    throw new KernelRefusal({
      family: 'modeling',
      category: 'unsupported',
      kernelCode: 'loft-guide:not-one-curve',
      kernelMessage: message,
      reason: message,
      message
    });
  }
  if (
    node.data.construction === true ||
    !(
      node.data.objectKind === 'line' ||
      node.data.objectKind === 'arc' ||
      (node.data.objectKind === 'spline' && node.data.closed !== true)
    )
  ) {
    const message =
      'A loft guide is one line, arc or open spline of its guide sketch, not construction geometry.';
    throw new KernelRefusal({
      family: 'modeling',
      category: 'unsupported',
      kernelCode: 'loft-guide:not-one-curve',
      kernelMessage: message,
      reason: message,
      message
    });
  }
  // The guide's own conversion refuses under the loft's code, so a guide
  // the sweep-path reader cannot take is never reported as a sweep path.
  let edges: number[];
  try {
    edges = sweepPathEdges(kernel, document, guide, scope, sketchBases, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new KernelRefusal({
      family: 'modeling',
      category: 'unsupported',
      kernelCode: 'loft_guide_refused',
      kernelMessage: message,
      reason: message,
      message,
      cause: error
    });
  }
  if (edges.length !== 1) {
    const message = 'A loft guide is one curve of its guide sketch.';
    throw new KernelRefusal({
      family: 'modeling',
      category: 'unsupported',
      kernelCode: 'loft-guide:not-one-curve',
      kernelMessage: message,
      reason: message,
      message
    });
  }
  const curve = nurbsCurveOfEdge(kernel, edges[0]!, 'The loft guide');
  const controlPoints: number[][] = [];
  for (let i = 0; i < curve.controlPoints.length; i += 3) {
    controlPoints.push([
      curve.controlPoints[i]!,
      curve.controlPoints[i + 1]!,
      curve.controlPoints[i + 2]!
    ]);
  }
  return {
    degree: curve.degree,
    knots: Array.from(curve.knots),
    controlPoints,
    weights: Array.from(curve.weights)
  };
}

export function buildLoft(
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
  const sections = feature.data.sections;
  const faces = sections.map((section, index) =>
    sectionFace(
      kernel,
      document,
      section,
      scope,
      sketchBases,
      warn,
      `Loft section ${index + 1}`
    )
  );
  const handles = Uint32Array.from(faces);
  const endPoint = feature.data.endPoint;
  const { connections, guides } = feature.data;
  const guide = guides?.[0];
  if (
    connections === undefined &&
    guide !== undefined &&
    !straightGuideOnRuledLoft(document, guide, feature.data.mode)
  ) {
    // M04: a curved guide (or any guide on a smooth loft) is followed
    // exactly by the kernel's guided loft: every section corner rides a rail
    // offset from the guide, so the guide lies on the solid. What it cannot
    // build exactly (curved section edges, unequal corner counts, a guide
    // that misses a corner, doubles back or crosses a section backwards) it
    // refuses by name, typed.
    const options = {
      ruled: feature.data.mode !== 'smooth',
      guide: loftGuideCurve(kernel, document, guide, scope, sketchBases)
    };
    const solid = validatedLoft(
      kernel,
      () =>
        typedModelingCall('loft_guide_refused', () =>
          kernel.loftWithOptions(handles, JSON.stringify(options))
        ),
      'Loft'
    );
    return {
      solids: [solid],
      lineage: remusHashOnlyLineage(
        'sweep',
        'Loft section topology has no verified output evolution relation.'
      )
    };
  }
  if (connections !== undefined || guides !== undefined) {
    // M04 (v133): the vertices each section's correspondence starts from,
    // named or where the one straight guide meets each section's plane; the
    // kernel refuses a point that is not a vertex of its section.
    const points =
      connections !== undefined
        ? connections.map((vertex, index) =>
            loftConnectionPoint(
              document,
              sections[index]!,
              vertex,
              scope,
              sketchBases,
              index
            )
          )
        : loftGuidePoints(document, sections, guides![0]!, scope, sketchBases);
    const options = {
      ruled: feature.data.mode !== 'smooth',
      connections: points.map((point) => [point.x, point.y, point.z])
    };
    const solid = validatedLoft(
      kernel,
      () =>
        typedModelingCall('loft_connections_refused', () =>
          kernel.loftWithOptions(handles, JSON.stringify(options))
        ),
      'Loft'
    );
    return {
      solids: [solid],
      lineage: remusHashOnlyLineage(
        'sweep',
        'Loft section topology has no verified output evolution relation.'
      )
    };
  }
  if (endPoint === undefined) {
    const mode = feature.data.mode;
    const solid = validatedLoft(
      kernel,
      () =>
        mode === 'smooth' ? kernel.loftSmooth(handles) : kernel.loft(handles),
      'Loft'
    );
    return {
      solids: [solid],
      lineage: remusHashOnlyLineage(
        'sweep',
        'Loft section topology has no verified output evolution relation.'
      )
    };
  }
  if (feature.data.mode === 'smooth') {
    throw new Error(
      'A loft apex point is available in Ruled mode only: the kernel\u2019s smooth section surfaces do not close against an apex and return an invalid solid. Switch the loft to Ruled, or clear its apex point.'
    );
  }
  const closingPlane = sectionPlane(
    document,
    sections[sections.length - 1]!,
    sketchBases,
    `Loft section ${sections.length}`
  );
  const options = {
    ruled: true,
    endPoint: loftApexPoint(
      endPoint,
      closingPlane,
      scope,
      'The loft apex point'
    )
  };
  let validated: number | null = null;
  let invalid: unknown = null;
  try {
    validated = validatedLoft(
      kernel,
      () => kernel.loftWithOptions(handles, JSON.stringify(options)),
      'Loft to an apex point'
    );
  } catch (error) {
    invalid = error;
  }
  const apexedVolume =
    validated === null
      ? null
      : kernel.volume(validated, MEASUREMENT_DEFLECTION);
  // The one measurement that settles it, and the same build the refusal
  // message needs: the run lofted without the apex.
  const plain = unapexedLoft(kernel, handles);
  if (validated === null || apexedVolume === null) {
    throw new Error(
      plain !== null
        ? `${errorText(invalid)} The same sections do loft into a valid solid without the apex point, so the apex is what this loft cannot take: move it, or clear it.`
        : `${errorText(invalid)} The loft apex point cannot be checked on this loft: the same sections do not loft into a valid solid without it, so the section run itself is what the kernel cannot take; the apex is not what to change. Change the section run so it lofts on its own.`,
      { cause: invalid }
    );
  }
  // There is exactly one honest baseline — the same run lofted without the
  // apex — and no substitute for it. An earlier version treated a run lying
  // wholly in the closing plane as a baseline of nought material, on the
  // reasoning that such a run encloses nothing for the apex to fold into.
  // That is true about folding and false about the result: measured, a
  // 100 x 100 section followed by a closing 4 x 4 on the same plane builds at
  // 53.3333 — exactly the 4 x 4 x 10 / 3 pyramid, with the 100 x 100 section
  // kept in the B-Rep as a zero-thickness web that contributes no material at
  // all, and with the apex sign making no difference either way. Disjoint
  // coplanar sections are worse: the centre of mass lands on the surviving
  // section and the other one is simply absent from the body's mass. So a run
  // with no measurable baseline is refused.
  if (plain === null) {
    throw new Error(
      'The loft apex point cannot be checked on this loft: the same sections do not loft into a valid solid without it, so there is no measurement of what the apex adds, and an apex that folds back through the body reports a smaller volume with no other sign. Clear the apex point, or change the section run so it lofts on its own.'
    );
  }
  refuseLostExactSurfaces(
    kernel,
    plain.solid,
    validated,
    'The loft apex point',
    'Clear the apex point and close the run with a small final section instead, or draw the sections as straight-edged profiles.'
  );
  const baseline = plain.volume;
  if (apexedVolume - baseline <= apexVolumeSlack(baseline, apexedVolume)) {
    throw new Error(
      `The loft apex point does not add material to this loft: the same sections loft to ${formatMeasuredVolume(baseline)} mm³ without the apex and to ${formatMeasuredVolume(apexedVolume)} mm³ with it. An apex that measures no larger has folded the closing band back through the body, which is a self-intersecting solid the validator cannot see. Move the apex to the other side of the closing section or further out, or clear it.`
    );
  }
  return {
    solids: [validated],
    lineage: remusHashOnlyLineage(
      'sweep',
      'Loft section topology has no verified output evolution relation.'
    )
  };
}

export function sweepPathEdges(
  kernel: RemusKernel,
  document: ProjectDocument,
  path: SketchPathReference,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
  /**
   * Split an arc wider than a quarter turn into quarter-turn pieces, as the
   * sampled sweeps always have. The exact sweep takes each arc whole: one
   * motion, one face per profile edge.
   */
  splitArcs = true
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
      const start = planePoint3(basis, {
        x: resolveParamValue(data.x1, scope, 'path start X', document.units),
        y: resolveParamValue(data.y1, scope, 'path start Y', document.units)
      });
      const end = planePoint3(basis, {
        x: resolveParamValue(data.x2, scope, 'path end X', document.units),
        y: resolveParamValue(data.y2, scope, 'path end Y', document.units)
      });
      return [
        kernel.makeLineEdge(start.x, start.y, start.z, end.x, end.y, end.z)
      ];
    }
    if (data.objectKind === 'spline' && !splitArcs) {
      // M04: an exact sweep takes a spline whole, as its exact NURBS; only a
      // sweep that keeps the profile's orientation can follow it exactly,
      // and the kernel refuses it by name otherwise.
      const spline = resolveSplineGeometry(data, (value) =>
        resolveParamValue(value, scope, 'path spline', document.units)
      );
      if (spline.closed) {
        const message =
          'A sweep path cannot be a closed spline: a sweep runs from one end of its path to the other.';
        throw new KernelRefusal({
          family: 'modeling',
          category: 'unsupported',
          kernelCode: 'sweep-path:closed-spline',
          kernelMessage: message,
          reason: message,
          message
        });
      }
      return [splinePathEdge(kernel, basis, spline)];
    }
    if (data.objectKind !== 'arc') {
      throw new Error(
        'Sweep paths support line and arc entities, and splines on an exact sweep.'
      );
    }
    const center2 = {
      x: resolveParamValue(
        data.centerX,
        scope,
        'path center X',
        document.units
      ),
      y: resolveParamValue(data.centerY, scope, 'path center Y', document.units)
    };
    const radius = resolveParamValue(
      data.radius,
      scope,
      'path radius',
      document.units
    );
    const start =
      (resolveParamValue(
        data.startAngleDeg,
        scope,
        'path start angle',
        document.units
      ) *
        Math.PI) /
      180;
    const end =
      (resolveParamValue(
        data.endAngleDeg,
        scope,
        'path end angle',
        document.units
      ) *
        Math.PI) /
      180;
    const wrap = Math.PI * 2;
    const sweep = (((end - start) % wrap) + wrap) % wrap;
    if (sweep <= GEOMETRY_EPSILON) {
      throw new Error('Sweep path arc must have a non-zero sweep.');
    }
    const center = planePoint3(basis, center2);
    const pieces = splitArcs
      ? Math.max(1, Math.ceil(sweep / (Math.PI / 2)))
      : 1;
    return Array.from({ length: pieces }, (_, index) => {
      const angleA = start + (sweep * index) / pieces;
      const angleB = start + (sweep * (index + 1)) / pieces;
      const pointA = planePoint3(basis, {
        x: center2.x + Math.cos(angleA) * radius,
        y: center2.y + Math.sin(angleA) * radius
      });
      const pointB = planePoint3(basis, {
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

/** The kernel's canonical NURBS form of an edge, unpacked for a guided sweep. */
interface NurbsCurve {
  degree: number;
  knots: Float64Array;
  controlPoints: Float64Array;
  weights: Float64Array;
}

function finiteNumbers(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
    numbers.push(entry);
  }
  return numbers;
}

function flattenedControlPoints(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const flat: number[] = [];
  for (const point of value) {
    const coordinates = finiteNumbers(point);
    if (coordinates === null || coordinates.length !== 3) return null;
    flat.push(...coordinates);
  }
  return flat;
}

/**
 * The kernel reports an edge's underlying curve as canonical NURBS JSON —
 * analytic lines and arcs converted to their exact rational form. `guidedSweep`
 * takes raw NURBS rather than edge handles, so a guided sweep reads its spine
 * and its rail back out through here.
 */
function nurbsCurveOfEdge(
  kernel: RemusKernel,
  edge: number,
  label: string
): NurbsCurve {
  const parsed: unknown = JSON.parse(kernel.getNurbsCurveData(edge));
  const data = (parsed ?? {}) as Record<string, unknown>;
  const degree = data.degree;
  const knots = finiteNumbers(data.knots);
  const controlPoints = flattenedControlPoints(data.controlPoints);
  const weights = finiteNumbers(data.weights);
  if (
    typeof degree !== 'number' ||
    !Number.isInteger(degree) ||
    degree < 1 ||
    knots === null ||
    controlPoints === null ||
    weights === null ||
    controlPoints.length !== weights.length * 3 ||
    weights.length === 0
  ) {
    throw new Error(`${label} did not resolve to a usable NURBS curve.`);
  }
  return {
    degree,
    knots: Float64Array.from(knots),
    controlPoints: Float64Array.from(controlPoints),
    weights: Float64Array.from(weights)
  };
}

function sameSketchPath(
  left: SketchPathReference,
  right: SketchPathReference
): boolean {
  if (left.sketchId !== right.sketchId) return false;
  const entities = new Set(left.entityIds);
  return (
    entities.size === new Set(right.entityIds).size &&
    right.entityIds.every((entityId) => entities.has(entityId))
  );
}

/** How finely the plain sweep entry point surfaces each mode. */
const SWEEP_SEGMENTS = { standard: 24, smooth: 64 } as const;

/**
 * The plain, unguided sweep of one profile along one path edge — the call an
 * unguided sweep has always taken, in one place so that the guided builder's
 * baseline is the same build the feature would otherwise have shipped.
 */
function plainSweepSolid(
  kernel: RemusKernel,
  face: number,
  edge: number,
  mode: 'standard' | 'smooth'
): number {
  return kernel.sweepWithOptions(
    face,
    edge,
    'rmf',
    new Float64Array(),
    SWEEP_SEGMENTS[mode],
    'smooth'
  );
}

/**
 * The same sweep with no rail, or null when it does not build. Its solid is
 * the exact-surface census the guided build has to match; its absence says
 * there is nothing to compare against, which is not a licence to skip the
 * comparison. See {@link refuseLostExactSurfaces}.
 */
function unguidedSweep(
  kernel: RemusKernel,
  face: number,
  edge: number
): number | null {
  try {
    return validateGeneratedSolid(
      kernel,
      plainSweepSolid(kernel, face, edge, 'standard'),
      'Sweep'
    );
  } catch {
    return null;
  }
}

/**
 * A guided sweep replaces the rotation-minimizing frame with one that tracks a
 * rail. The kernel takes exactly one spine curve and one rail curve, so both
 * references have to come down to a single edge — a path of several entities,
 * or an arc wider than a quarter turn (which the path builder splits), is
 * refused by name rather than quietly swept unguided.
 *
 * `guidedSweep` also has no exact curved surfacing: it rebuilds a curved
 * profile's swept walls as flat facets, so a curved profile on a rail is
 * refused by {@link refuseLostExactSurfaces} against the plain sweep's own
 * census. A straight-edged profile loses nothing and is unaffected.
 */
function guidedSweepSolid(
  kernel: RemusKernel,
  document: ProjectDocument,
  face: number,
  path: SketchPathReference,
  guide: SketchPathReference,
  mode: 'standard' | 'smooth',
  pathEdges: readonly number[],
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>
): number {
  if (mode === 'smooth') {
    // `guidedSweep` takes no segment count and no surfacing argument, so a
    // saved Smooth sweep would come back at the kernel's default surfacing
    // while the feature still says Smooth. Refuse the combination by name
    // rather than rebuild the body at a surfacing nobody asked for.
    throw new Error(
      'A sweep guide rail is available in Standard surface mode only: the kernel\u2019s guided sweep takes no surface-mode control, so a Smooth sweep would be rebuilt at a different surfacing than the one saved. Set Surface mode to Standard, or clear the guide rail.'
    );
  }
  if (sameSketchPath(path, guide)) {
    throw new Error(
      'A sweep guide rail must be a different path from the one being swept along; a rail lying on the path leaves the profile unrotated and the kernel reports no error.'
    );
  }
  if (pathEdges.length !== 1) {
    throw new Error(
      `A sweep guide rail needs a single-curve path, but this path resolves to ${pathEdges.length} curves (an arc wider than a quarter turn is split). Sweep along one line or one quarter-turn arc, or clear the guide rail.`
    );
  }
  const guideEdges = sweepPathEdges(
    kernel,
    document,
    guide,
    scope,
    sketchBases
  );
  if (guideEdges.length !== 1) {
    throw new Error(
      `A sweep guide rail must be a single curve, but this rail resolves to ${guideEdges.length} curves (an arc wider than a quarter turn is split). Choose one line or one quarter-turn arc as the rail.`
    );
  }
  const spine = nurbsCurveOfEdge(kernel, pathEdges[0]!, 'The sweep path');
  const rail = nurbsCurveOfEdge(kernel, guideEdges[0]!, 'The sweep guide rail');
  // The same sweep without the rail, taken through exactly the call the
  // unguided path takes so the two builds are comparable. It is the only
  // evidence that says whether the rail costs the body its exact surfaces,
  // and a rail that cannot be checked is refused rather than trusted.
  const plain = unguidedSweep(kernel, face, pathEdges[0]!);
  if (plain === null) {
    throw new Error(
      'A sweep guide rail cannot be checked on this sweep: the same profile and path do not sweep into a valid solid without the rail, so there is no measurement of what the rail costs, and the kernel’s guided sweep rebuilds a curved body as flat facets without reporting it. Clear the guide rail, or change the profile and path so they sweep on their own.'
    );
  }
  const guided = validateGeneratedSolid(
    kernel,
    kernel.guidedSweep(
      face,
      spine.degree,
      spine.knots,
      spine.controlPoints,
      spine.weights,
      rail.degree,
      rail.knots,
      rail.controlPoints,
      rail.weights
    ),
    'Sweep along a guide rail'
  );
  refuseLostExactSurfaces(
    kernel,
    plain,
    guided,
    'A sweep guide rail',
    'Clear the guide rail, or draw the profile as a straight-edged one.'
  );
  return guided;
}

type Point = { x: number; y: number; z: number };
const minus = (a: Point, b: Point): Point => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
});
const dot3 = (a: Point, b: Point) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a: Point, b: Point): Point => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});
const norm3 = (a: Point) => Math.hypot(a.x, a.y, a.z);

/** The two ends of a straight edge, or `null` for any other curve. */
function straightEnds(
  kernel: RemusKernel,
  edge: number,
  label: string
): [Point, Point] | null {
  const curve = nurbsCurveOfEdge(kernel, edge, label);
  const points = curve.controlPoints;
  const count = points.length / 3;
  const at = (i: number): Point => ({
    x: points[3 * i]!,
    y: points[3 * i + 1]!,
    z: points[3 * i + 2]!
  });
  const [first, last] = [at(0), at(count - 1)];
  const along = minus(last, first);
  const length = norm3(along);
  if (!(length > 0)) return null;
  // Straight when every control point lies on the chord.
  for (let i = 0; i < count; i += 1) {
    const off = cross3(minus(at(i), first), along);
    if (norm3(off) / length > 1e-9 * Math.max(1, length)) return null;
  }
  return [first, last];
}

/**
 * M04: the end scale a straight guide rail asks of an exact sweep along a
 * straight path. The rail lies in one plane with the path and runs from the
 * profile's plane to the far end of the path, on one side of it; its
 * distance from the path then changes linearly, which is exactly a sweep
 * scaling the profile about the path by the ratio of its far distance to its
 * near one, every point at the rail's distance staying on the rail. Any
 * other rail has no exact construction and is refused by name.
 */
const RAIL_ON_CURVED_PATH =
  'An exact sweep follows a guide rail only along a straight path: a rail on a curved path has no exact surface. Sweep along a straight line, or clear the guide rail.';
const RAIL_NOT_ONE_LINE =
  'An exact sweep follows a guide rail only when the rail is one straight line: a curved rail has no exact surface. Draw the rail as a straight line, or clear the guide rail.';

/**
 * The linear tolerance a rail is held to, in model units: absolute, so a
 * longer path or a model further from the origin never loosens it. The
 * second term is only the rounding of the coordinates themselves.
 */
const RAIL_TOLERANCE = 1e-7;

export function railEndScale(
  kernel: RemusKernel,
  pathEdges: readonly number[],
  railEdges: readonly number[],
  profilePlane: PlaneBasis
): number {
  // Every rail the exact route cannot follow is refused as unsupported, a
  // typed refusal callers branch on, never a plain build failure.
  const refuse = (code: string, message: string): never => {
    throw new KernelRefusal({
      family: 'modeling',
      category: 'unsupported',
      kernelCode: `sweep-rail:${code}`,
      kernelMessage: message,
      reason: message,
      message
    });
  };
  const pathEnds = pathEdges.map((edge) =>
    straightEnds(kernel, edge, 'The sweep path')
  );
  const railEnds = railEdges.map((edge) =>
    straightEnds(kernel, edge, 'The sweep guide rail')
  );
  if (pathEnds.some((ends) => ends === null)) {
    refuse('curved-path', RAIL_ON_CURVED_PATH);
  }
  if (railEnds.length !== 1 || railEnds[0] === null) {
    refuse('curved-rail', RAIL_NOT_ONE_LINE);
  }
  // The path's line, from all its pieces' ends.
  const points = pathEnds.flatMap((ends) => ends!);
  const plane = (p: Point) =>
    dot3(minus(p, profilePlane.origin), profilePlane.normal);
  const near = points.reduce((a, b) =>
    Math.abs(plane(a)) <= Math.abs(plane(b)) ? a : b
  );
  const far = points.reduce((a, b) =>
    Math.abs(plane(a)) >= Math.abs(plane(b)) ? a : b
  );
  const axis = minus(far, near);
  const length = norm3(axis);
  const unit = { x: axis.x / length, y: axis.y / length, z: axis.z / length };
  const [r0, r1] = railEnds[0]!;
  // Absolute, so neither the path's length nor the model's distance from
  // the origin changes a verdict beyond the rounding of the coordinates.
  const magnitude = Math.max(
    norm3(near),
    norm3(far),
    norm3(r0),
    norm3(r1),
    norm3(profilePlane.origin)
  );
  const tolerance = RAIL_TOLERANCE + 16 * Number.EPSILON * magnitude;
  const offAxis = (p: Point) => {
    const d = minus(p, near);
    const along = dot3(d, unit);
    return {
      along,
      across: minus(d, {
        x: unit.x * along,
        y: unit.y * along,
        z: unit.z * along
      })
    };
  };
  for (const p of points) {
    if (norm3(offAxis(p).across) > tolerance) {
      refuse(
        'turning-path',
        'An exact sweep follows a guide rail only along a straight path: this path turns. Sweep along a straight line, or clear the guide rail.'
      );
    }
  }
  // The sweep carries the profile from its own plane, so the path and the
  // rail must both start there: a rail that starts beside the path but off
  // the profile's plane would put the taper where the rail is not.
  const [startPoint, endPoint] =
    Math.abs(plane(r0)) <= Math.abs(plane(r1)) ? [r0, r1] : [r1, r0];
  if (
    Math.abs(plane(near)) > tolerance ||
    Math.abs(plane(startPoint)) > tolerance
  ) {
    refuse(
      'off-profile-plane',
      'A sweep guide rail and its path must both start on the profile’s plane. Move the path or the rail to start at the profile, or clear the guide rail.'
    );
  }
  const [start, end] = [offAxis(startPoint), offAxis(endPoint)];
  if (
    Math.abs(start.along) > tolerance ||
    Math.abs(end.along - length) > tolerance
  ) {
    refuse(
      'short-rail',
      'A sweep guide rail must run the length of the path, from the profile’s plane to the path’s far end. Redraw the rail end to end with the path, or clear it.'
    );
  }
  const [d0, d1] = [norm3(start.across), norm3(end.across)];
  // The rail's far end may sit no further from the plane through the path
  // and the rail's start than the tolerance: the scaled sweep keeps each
  // point's direction from the path, so any skew would leave the rail.
  const sameSide =
    d0 > tolerance &&
    d1 > tolerance &&
    norm3(cross3(start.across, end.across)) / d0 <= tolerance &&
    dot3(start.across, end.across) > 0;
  if (!sameSide) {
    refuse(
      'skew-rail',
      'An exact sweep follows a guide rail only when the rail lies beside the path in one plane with it, never crossing it: a rail that turns about the path has no exact surface. Draw the rail in a plane through the path, or clear the guide rail.'
    );
  }
  return d1 / d0;
}

/**
 * M04 (v132): a sweep's twist (radians) and end scale, resolved; `null`
 * when it has neither, so the plain `sweepExact` call is unchanged.
 */
export function resolveSweepOptions(
  data: {
    twistDeg?: ParamValue;
    endScale?: ParamValue;
    orientation?: 'parallel';
    cornerRadius?: ParamValue;
    profilePosition?:
      'auto' | 'intersection' | 'closest-point' | 'closest-endpoint';
  },
  scope: Record<string, number>,
  units?: ProjectDocument['units']
): Record<string, number | string> | null {
  const twistDeg =
    data.twistDeg === undefined
      ? 0
      : resolveDimensionedParam(data.twistDeg, scope, 'angle', 'twist');
  const endScale =
    data.endScale === undefined
      ? 1
      : resolveDimensionedParam(data.endScale, scope, 'number', 'end scale');
  if (!(endScale > 0)) {
    throw new Error('Sweep end scale must be greater than zero.');
  }
  const options: Record<string, number | string> = {};
  if (twistDeg !== 0) options.twist = (twistDeg * Math.PI) / 180;
  if (endScale !== 1) options.endScale = endScale;
  if (data.orientation === 'parallel') options.orientation = 'parallel';
  if (data.cornerRadius !== undefined) {
    const radius = resolveDimensionedParam(
      data.cornerRadius,
      scope,
      'length',
      'corner radius',
      units
    );
    if (!(radius > 0)) {
      throw new Error('A round sweep corner needs a radius greater than zero.');
    }
    options.corner = 'round';
    options.cornerRadius = radius;
  }
  if (data.profilePosition !== undefined) {
    options.position = {
      auto: 'auto',
      intersection: 'intersection',
      'closest-point': 'closestPoint',
      'closest-endpoint': 'closestEndpoint'
    }[data.profilePosition];
  }
  return Object.keys(options).length > 0 ? options : null;
}

/**
 * M04: the exact in-place sweep. The profile stays where it is and the
 * kernel carries it along the path's lines and whole arcs as exact surfaces
 * (`sweepExact`); a corner, a fold or a self-crossing is refused by name and
 * never sampled instead. A guide rail has no exact construction, so it is
 * refused rather than rebuilt as facets. A twist or end scale (v132) goes to
 * `sweepExactWithOptions`, which builds it along a straight path with the
 * profile square to it and refuses anything else by name.
 */
/**
 * The exact sweep's kernel call, its refusals typed: Remus refuses an exact
 * sweep it cannot build (a path that turns back, a spline on a turning
 * sweep) with a prose error, so each is carried as a typed modeling refusal
 * with the kernel's sentence, never a bare build failure.
 */
function typedExactSweep(run: () => number): number {
  return typedModelingCall('exact_sweep_refused', run);
}

/**
 * A kernel call whose refusals arrive as prose, carried as a typed modeling
 * refusal with the kernel's sentence under `kernelCode`.
 */
function typedModelingCall(kernelCode: string, run: () => number): number {
  try {
    return run();
  } catch (error) {
    if (error instanceof KernelRefusal) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const category = operationErrorCategory(message);
    throw new KernelRefusal({
      family: 'modeling',
      category: category === 'internal' ? 'unsupported' : category,
      kernelCode,
      kernelMessage: message,
      reason: message,
      message,
      cause: error
    });
  }
}

function exactSweepSolid(
  kernel: RemusKernel,
  document: ProjectDocument,
  face: number,
  path: SketchPathReference,
  guide: SketchPathReference | undefined,
  options: Record<string, number | string> | null,
  profilePlane: PlaneBasis,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>
): number {
  if (guide) {
    if (options) {
      throw new Error(
        'A guide rail sets the sweep’s end scale itself: clear the twist and end scale, or clear the guide rail.'
      );
    }
    const pathEdges = sweepPathEdges(
      kernel,
      document,
      path,
      scope,
      sketchBases,
      false
    );
    // Only one straight sketch line can be a rail; anything else (a circle,
    // a spline, several curves) is refused as typed before its edges are
    // built, so no plain error reaches the history.
    const lineOnly = (ids: readonly string[]) =>
      ids.every((id) => {
        const node = document.nodes[id];
        return (
          node?.kind === 'sketch-object' && node.data.objectKind === 'line'
        );
      });
    // The path is refused first: a rail on a curved path has no exact
    // surface whatever the rail is.
    if (!lineOnly(path.entityIds)) {
      throw new KernelRefusal({
        family: 'modeling',
        category: 'unsupported',
        kernelCode: 'sweep-rail:curved-path',
        kernelMessage: RAIL_ON_CURVED_PATH,
        reason: RAIL_ON_CURVED_PATH,
        message: RAIL_ON_CURVED_PATH
      });
    }
    const railObjects = guide.entityIds.map((id) => document.nodes[id]);
    if (
      railObjects.length !== 1 ||
      railObjects.some(
        (node) =>
          node?.kind !== 'sketch-object' || node.data.objectKind !== 'line'
      )
    ) {
      throw new KernelRefusal({
        family: 'modeling',
        category: 'unsupported',
        kernelCode: 'sweep-rail:curved-rail',
        kernelMessage: RAIL_NOT_ONE_LINE,
        reason: RAIL_NOT_ONE_LINE,
        message: RAIL_NOT_ONE_LINE
      });
    }
    const railEdges = sweepPathEdges(
      kernel,
      document,
      guide,
      scope,
      sketchBases,
      false
    );
    const endScale = railEndScale(kernel, pathEdges, railEdges, profilePlane);
    return typedExactSweep(() =>
      kernel.sweepExactWithOptions(
        face,
        Uint32Array.from(pathEdges),
        JSON.stringify({ endScale })
      )
    );
  }
  const edges = sweepPathEdges(
    kernel,
    document,
    path,
    scope,
    sketchBases,
    false
  );
  if (options) {
    return typedExactSweep(() =>
      kernel.sweepExactWithOptions(
        face,
        Uint32Array.from(edges),
        JSON.stringify(options)
      )
    );
  }
  return typedExactSweep(() =>
    kernel.sweepExact(face, Uint32Array.from(edges))
  );
}

function sketchBasisOf(
  sketchId: SketchId,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>
): PlaneBasis {
  const basis = sketchBases.get(sketchId);
  if (!basis)
    throw new Error('The sweep profile’s sketch plane is unavailable.');
  return basis;
}

export function buildProfileSweep(
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
  const face = sectionFace(
    kernel,
    document,
    feature.data.profile,
    scope,
    sketchBases,
    warn,
    'Sweep profile'
  );
  const guide = feature.data.guide;
  const guided = guide !== undefined;
  if (feature.data.construction === 'in-place') {
    return {
      solids: [
        validateGeneratedSolid(
          kernel,
          exactSweepSolid(
            kernel,
            document,
            face,
            feature.data.path,
            guide,
            resolveSweepOptions(feature.data, scope, document.units),
            sketchBasisOf(feature.data.profile.sketchId, sketchBases),
            scope,
            sketchBases
          ),
          'Sweep'
        )
      ],
      lineage: remusHashOnlyLineage(
        'sweep',
        'Profile sweep topology has no verified output evolution relation.'
      )
    };
  }
  if (resolveSweepOptions(feature.data, scope)) {
    // Validation keeps these to exact sweeps; a document edited by hand is
    // refused rather than swept plain.
    throw new Error(
      'Twist and scale along the path need the exact sweep; build it as Exact.'
    );
  }
  // The sampled sweep's path, arcs split into quarter turns as always.
  const edges = sweepPathEdges(
    kernel,
    document,
    feature.data.path,
    scope,
    sketchBases
  );
  const solid = guided
    ? guidedSweepSolid(
        kernel,
        document,
        face,
        feature.data.path,
        guide,
        feature.data.mode,
        edges,
        scope,
        sketchBases
      )
    : // Unchanged: a sweep authored without a guide rail takes exactly the
      // call it has always taken, so its geometry replays bit-identically.
      edges.length === 1
      ? plainSweepSolid(kernel, face, edges[0]!, feature.data.mode)
      : kernel.sweepAlongEdges(face, Uint32Array.from(edges));
  return {
    solids: [
      validateGeneratedSolid(
        kernel,
        solid,
        guided ? 'Sweep along a guide rail' : 'Sweep'
      )
    ],
    lineage: remusHashOnlyLineage(
      'sweep',
      'Profile sweep topology has no verified output evolution relation.'
    )
  };
}

export function buildHelicalSweep(
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
  const face = sectionFace(
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
  const radius = resolveParamValue(
    feature.data.radius,
    scope,
    'radius',
    document.units
  );
  const pitch = resolveParamValue(
    feature.data.pitch,
    scope,
    'pitch',
    document.units
  );
  const turns = resolveParamValue(
    feature.data.turns,
    scope,
    'turns',
    document.units
  );
  // In place, the radius is where the profile sits; the stored one is a
  // record, so it is not required to read as positive.
  const inPlace = feature.data.construction === 'in-place';
  if (
    (!inPlace && !(radius > 0)) ||
    pitch === 0 ||
    !(turns > 0) ||
    turns > MAX_HELICAL_SWEEP_TURNS
  ) {
    throw new Error(
      inPlace
        ? `Helical sweep requires no more than ${MAX_HELICAL_SWEEP_TURNS} turns and a non-zero pitch.`
        : `Helical sweep requires a positive radius, no more than ${MAX_HELICAL_SWEEP_TURNS} turns, and a non-zero pitch.`
    );
  }
  const solid = inPlace
    ? // Exact curved surfaces, wound about the axis from where the profile
      // sits; the kernel refuses a profile on or across the axis, and coils
      // that would overlap, by name.
      kernel.helicalSweepInPlace(
        face,
        origin.x,
        origin.y,
        origin.z,
        direction.x,
        direction.y,
        direction.z,
        pitch,
        turns
      )
    : // Unchanged: a helix authored without a construction takes exactly
      // the call it was built with, so it replays identically.
      kernel.helicalSweep(
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

export function buildSweep(
  kernel: RemusKernel,
  document: ProjectDocument,
  feature: FeatureNode,
  scope: Record<string, number>,
  storedBases: ReadonlyMap<SketchId, PlaneBasis>,
  warn: (message: string) => void,
  /** R01: the resolved datum axis a revolve with an `axisRef` turns about. */
  revolveAxis?: DatumAxis
): ExactShape {
  // F01 (v121): an extrude with a start offset is built on its start plane,
  // the sketch plane moved along its normal, so the span, the profile face,
  // every lineage carrier and the draft's neutral plane all start there.
  let sketchBases = storedBases;
  if (feature.data.featureKind === 'extrude') {
    const start = resolveExtrudeStartOffset(feature.data, scope, document);
    const basis = storedBases.get(feature.data.sketchId);
    if (start !== 0 && basis) {
      sketchBases = new Map(storedBases).set(
        feature.data.sketchId,
        shiftBasisAlongNormal(basis, start)
      );
    }
  }
  if (feature.data.featureKind === 'extrude') {
    const twoSided = twoSidedDraftedSweep(
      kernel,
      document,
      feature,
      scope,
      sketchBases,
      warn
    );
    if (twoSided) return twoSided;
  }
  const shape = buildStraightSweep(
    kernel,
    document,
    feature,
    scope,
    sketchBases,
    warn,
    revolveAxis
  );
  if (feature.data.featureKind !== 'extrude') return shape;
  // F01 (v29): the draft tapers the straight sweep about the sketch plane, so
  // every caller (the feature itself, a pierced twin, a preview) sees the
  // same drafted tool.
  const angle = resolveExtrudeDraftDeg(feature.data, scope, document);
  if (angle === 0) return shape;
  const basis = sketchBases.get(feature.data.sketchId)!;
  const sign =
    resolveParamValue(
      feature.data.distance,
      scope,
      'distance',
      document.units
    ) < 0
      ? -1
      : 1;
  return {
    solids: draftExtrudedSolids(
      kernel,
      shape.solids,
      basis,
      scale(basis.normal, sign),
      angle,
      `Extrude "${feature.name}"`
    ),
    lineage: remusHashOnlyLineage('sweep', DRAFTED_EXTRUDE_HASH_ONLY_REASON)
  };
}

/**
 * The transient nodes a coplanar-retry twin builds (see
 * `exact-pierce-tool.ts`): their back distance is pierce travel, so a
 * drafted tool keeps the one-sided taper carried across the start plane
 * rather than being built as a two-sided extrusion with a straight back.
 * Held by identity, in this build only: nothing a document stores can set it.
 */
const pierceTravelNodes = new WeakSet<FeatureNode>();

/** Marks `node` as a pierced twin whose back distance is travel. */
export function markPierceTravel(node: FeatureNode): FeatureNode {
  pierceTravelNodes.add(node);
  return node;
}

/**
 * F01 (v126): a symmetric or two-sided blind extrude with a draft on either
 * side, or null when it is not one (the one-sided path builds it). Each side
 * is swept one-sided from the start plane on its own, tapered by its own
 * angle (`draftAngleDeg` the side the distance runs to, `backDraftAngleDeg`
 * the other) with the start plane as the neutral plane, and the two halves,
 * which share the profile face there exactly, are fused into one solid per
 * profile cell. A side whose angle is zero keeps straight walls. Any half
 * the draft refuses, or a pair the exact fuse refuses, refuses the feature
 * by name; nothing is approximated.
 */
function twoSidedDraftedSweep(
  kernel: RemusKernel,
  document: ProjectDocument,
  feature: FeatureNode,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
  warn: (message: string) => void
): ExactShape | null {
  if (feature.data.featureKind !== 'extrude') return null;
  // A pierced twin's back distance is travel, not a side.
  if (pierceTravelNodes.has(feature)) return null;
  const data = feature.data;
  const front = resolveExtrudeDraftDeg(data, scope, document, 'front');
  const back = resolveExtrudeDraftDeg(data, scope, document, 'back');
  if (front === 0 && back === 0) return null;
  const distance = resolveParamValue(
    data.distance,
    scope,
    'distance',
    document.units
  );
  const backDistance =
    data.backDistance === undefined
      ? 0
      : resolveParamValue(
          data.backDistance,
          scope,
          'back distance',
          document.units
        );
  if (!data.symmetric && !(backDistance > 0)) {
    // One-sided: the ordinary draft path, which a back draft cannot reach
    // (the document refuses one without a back side; so does this).
    if (back !== 0) {
      throw new Error(
        `Extrude "${feature.name}" has a back draft but no back side to taper.`
      );
    }
    return null;
  }
  if (data.symmetric && backDistance !== 0) {
    throw new Error(EXTRUDE_SIDES_CONFLICT_MESSAGE);
  }
  const sign = distance < 0 ? -1 : 1;
  const ahead = data.symmetric ? distance / 2 : distance;
  const behind = data.symmetric ? Math.abs(distance) / 2 : backDistance;
  const basis = sketchBases.get(data.sketchId);
  if (!basis) throw new Error('Extrude sketch plane did not resolve.');
  const label = `Extrude "${feature.name}"`;
  const half = (span: number, angle: number, side: 1 | -1): number[] => {
    const {
      symmetric: _symmetric,
      backDistance: _backDistance,
      draftAngleDeg: _draftAngleDeg,
      backDraftAngleDeg: _backDraftAngleDeg,
      startOffset: _startOffset,
      ...rest
    } = data;
    const solids = buildStraightSweep(
      kernel,
      document,
      { ...feature, data: { ...rest, distance: span } },
      scope,
      sketchBases,
      warn
    ).solids;
    if (angle === 0) return solids;
    return draftExtrudedSolids(
      kernel,
      solids,
      basis,
      scale(basis.normal, side),
      angle,
      `${label} (${side === sign ? 'front' : 'back'} side)`
    );
  };
  const aheadSolids = half(ahead, front, sign);
  const behindSolids = half(-sign * behind, back, -sign as 1 | -1);
  if (aheadSolids.length !== behindSolids.length) {
    throw new Error(
      `${label} could not pair its two drafted sides: they swept ${aheadSolids.length} and ${behindSolids.length} solids.`
    );
  }
  // The halves meet only on the profile face, so their union holds exactly
  // the material of both: a fuse that does not is refused, never shipped.
  const fusePair = (a: number, b: number): number => {
    const fused = fuseUniformSolid(
      kernel,
      [a, b],
      [`${label} front side`, `${label} back side`]
    );
    requireValidSolid(
      kernel,
      fused,
      `${label} with a draft on each side is not a valid closed solid; reduce the angles or the distances.`
    );
    const expected =
      kernel.volume(a, MEASUREMENT_DEFLECTION) +
      kernel.volume(b, MEASUREMENT_DEFLECTION);
    const got = kernel.volume(fused, MEASUREMENT_DEFLECTION);
    if (!(Math.abs(got - expected) <= 1e-6 * Math.max(1, expected))) {
      throw new Error(
        `${label}: fusing its two drafted sides lost material (${Math.round(got * 1e3) / 1e3} of ${Math.round(expected * 1e3) / 1e3}).`
      );
    }
    return fused;
  };
  // A straight round side beside a drafted one: if the plain fuse is
  // refused or loses material, the straight side is rebuilt as the same
  // exact loft form as the drafted one and the fuse tried once more.
  const loftStraight = (solid: number, side: 1 | -1) =>
    straightRoundWallAsLoft(
      kernel,
      solid,
      basis,
      scale(basis.normal, side),
      label
    );
  const solids = aheadSolids.map((solid, index) => {
    const behind = behindSolids[index]!;
    try {
      return fusePair(solid, behind);
    } catch (error) {
      if (front !== 0 && back !== 0) throw error;
      try {
        return front === 0
          ? fusePair(loftStraight(solid, sign), behind)
          : fusePair(solid, loftStraight(behind, -sign as 1 | -1));
      } catch {
        throw error;
      }
    }
  });
  return {
    solids,
    lineage: remusHashOnlyLineage('sweep', DRAFTED_EXTRUDE_HASH_ONLY_REASON)
  };
}

/** Preserve the old first-object meaning using only its current owned edges. */
function promotedDefaultProfile(
  document: ProjectDocument,
  sketch: SketchNode,
  firstObjectId: string,
  scope: Record<string, number>
) {
  const promotion = sketch.promotions?.find(
    (p) => p.edgeIds[0] === firstObjectId
  );
  if (!promotion) return undefined;
  const allObjects = new Map(
    sketch.objectIds.flatMap((id) => {
      const node = document.nodes[id];
      return node?.kind === 'sketch-object' ? [[id, node.data] as const] : [];
    })
  );
  const aliases = resolveSketchPromotionBoundaryTokens([promotion], allObjects);
  const edges = promotion.edgeIds.map((id) => {
    const data = allObjects.get(id);
    if (data?.objectKind !== 'line')
      throw new Error('Converted default profile has a missing editable edge.');
    return { id, data: { ...data, construction: false } };
  });
  const resolve = (value: ParamValue) =>
    resolveParamValue(
      value,
      scope,
      'converted profile coordinate',
      document.units
    );
  const analysis = computeSketchProfileAnalysis(edges, resolve, undefined, {
    promotionBoundaryTokens: new Map(
      promotion.edgeIds.map((id) => [id, aliases.get(id)!])
    )
  });
  const expected = {
    outer: promotion.edgeIds.map((id) => aliases.get(id)!),
    holes: []
  };
  const region = analysis.profiles[0];
  if (
    analysis.profiles.length !== 1 ||
    !region?.sourceBoundaryLoops ||
    !boundaryProvenanceEqual(region.sourceBoundaryLoops, expected)
  )
    throw new Error(
      'Converted default profile no longer forms its complete authored closed boundary. Repair the editable edges.'
    );
  const vertices = edges.map(({ data }) => ({
    x: resolve(data.x1),
    y: resolve(data.y1)
  }));
  if (
    edges.some(({ data }, i) => {
      const next = vertices[(i + 1) % vertices.length]!;
      return (
        Math.hypot(resolve(data.x2) - next.x, resolve(data.y2) - next.y) >
        analysis.tolerance
      );
    })
  )
    throw new Error(
      'Converted default profile has disconnected or reversed authored edges. Repair the editable edges.'
    );
  return {
    region,
    vertices,
    objectId: promotion.sourceObjectId,
    data: promotion.sourceData
  };
}

function buildStraightSweep(
  kernel: RemusKernel,
  document: ProjectDocument,
  feature: FeatureNode,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
  warn: (message: string) => void,
  revolveAxis?: DatumAxis
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
    return buildRegionExtrude(
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
  if (feature.data.featureKind === 'revolve' && feature.data.profile) {
    return buildRegionRevolve(
      kernel,
      document,
      feature.data,
      feature.data.profile,
      scope,
      sketchBases,
      warn,
      revolveAxis
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
  const promoted = promotedDefaultProfile(document, sketch, object.id, scope);
  const sourceId = promoted?.objectId ?? String(object.id);
  const sourceData = promoted?.data ?? object.data;
  if (feature.data.featureKind === 'extrude') {
    const distance = resolveParamValue(
      feature.data.distance,
      scope,
      'distance',
      document.units
    );
    // Symmetric and two-sided extrudes start behind the sketch plane;
    // the shifted basis carries that offset into the profile face and
    // every lineage carrier at once.
    const { extrudeBasis, totalDistance } = resolveExtrudeSpan(
      feature.data,
      basis,
      distance,
      scope,
      document.units
    );
    const sweep = forwardSweep(extrudeBasis, totalDistance);
    const face = promoted
      ? makeRegionFace(kernel, promoted.region, sweep.faceBasis, warn)
      : makeProfileFace(
          kernel,
          object.data,
          sweep.faceBasis,
          0,
          scope,
          document.units
        );
    const solid = kernel.extrude(
      face,
      extrudeBasis.normal.x,
      extrudeBasis.normal.y,
      extrudeBasis.normal.z,
      sweep.sweepDistance
    );
    return {
      solids: [solid],
      lineage: buildExtrudeLineage(
        kernel,
        solid,
        feature,
        sourceId,
        sourceData,
        extrudeBasis,
        totalDistance,
        scope,
        document.units,
        promoted?.vertices
      )
    };
  }
  const face = promoted
    ? makeRegionFace(kernel, promoted.region, basis, warn)
    : makeProfileFace(kernel, object.data, basis, 0, scope, document.units);

  if (feature.data.axisRef && !revolveAxis) {
    throw new Error('Revolve datum axis did not resolve.');
  }
  if (revolveAxis) requireRevolveAxisInPlane(revolveAxis, basis, sketch.name);
  const direction = revolveAxis
    ? revolveAxis.direction
    : feature.data.axis === 'vertical'
      ? basis.v
      : basis.u;
  const point = revolveAxis
    ? revolveAxis.origin
    : pointOnPlane(basis, { x: 0, y: 0 }, 0);
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
    lineage: revolveKeepsSemanticLineage(angleDeg, sourceData)
      ? buildRevolveLineage(
          kernel,
          solid,
          feature,
          sourceId,
          sourceData,
          basis,
          direction,
          point,
          scope,
          document.units,
          promoted?.vertices
        )
      : remusHashOnlyLineage('sweep', PARTIAL_REVOLVE_HASH_ONLY_REASON)
  };
}
