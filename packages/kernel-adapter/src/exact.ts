import { BrepKernel } from 'brepkit-wasm';
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
  DEFAULT_BODY_COLOR,
  UNIT_TO_MM,
  featureColor,
  nowIso,
  type BodyId,
  type BodyRepresentation,
  type BodyTopology,
  type DerivedState,
  type DirectEditOperation,
  type EdgeWitnessV1,
  type FaceGeometry,
  type FaceTopologyReferenceV5,
  type FaceWitnessV1,
  type FeatureNode,
  type ProjectDocument,
  type SketchId,
  type QuantizedTopologyPoint,
  type SketchNode,
  type SketchObjectData,
  type TopologyLineageDiagnostic
} from '@openzcad/shared';
import { displayTessellationForExtents } from './display-tessellation';
import {
  countFaceConnectedComponents,
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh,
  selectSafelyUnifiedSolid,
  type TriangleMeshClosure
} from './boolean-result-validation';
import {
  importedMeshStl,
  meshBooleanUnsupportedError
} from './imported-mesh';
import { connectedRegionGroups, resolveRegionProfiles } from './region-profile';
import { createBrepKitModelingOperations } from './brepkit-modeling-operations';
import { normalizeStepPlaneAnglesForKernel } from './step-import';
import {
  analyzeUnionConnectivity,
  disconnectedUnionWarning
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
  brepKitHashOnlyLineage,
  createBrepKitImportedStepLineage,
  createBrepKitSemanticLineage,
  mergeBrepKitLineageStates,
  propagateBrepKitRigidTransformLineage,
  type BrepKitLineageState,
  type BrepKitSemanticAssignment,
  type BrepKitTopologyCandidate
} from './brepkit-lineage';
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

const MEASUREMENT_DEFLECTION = 0.08;
const STL_EXPORT_DEFLECTION = 0.08;
/** Sewing gap for imported meshes, relative to the mesh's largest extent. */
const MESH_SEW_TOLERANCE_RATIO = 1e-6;
const CURVE_SEGMENTS = 32;
const GEOMETRY_EPSILON = 1e-9;
const ANALYTIC_MATCH_EPSILON = 1e-7;
const DIRECT_EDIT_TOLERANCE = 1e-6;
const FULL_REVOLUTION = Math.PI * 2;
const PERIODIC_SURFACE_TYPES = new Set(['cylinder', 'cone', 'sphere', 'torus']);

interface ExactShape {
  /** A body can contain several independent solids, as with a pattern. */
  solids: number[];
  /** Exact, handle-bound schema-v5 references plus fail-closed diagnostics. */
  lineage?: BrepKitLineageState;
}

/** What the K0.6 import validator found on one `imported-step` feature. */
interface ImportedStepDiagnostics {
  /** Solids the file declared, before any were rejected. */
  declaredSolidCount: number;
  /** Reasons for each solid dropped as not being a closed manifold shell. */
  rejections: string[];
  /** Reasons for each solid kept but failing strict validation. */
  flagged: string[];
}

interface ExactBuildResult {
  shapes: Map<BodyId, ExactShape>;
  sketchBases: Map<SketchId, PlaneBasis>;
  consumed: Set<BodyId>;
  /**
   * Per-body import validation, recorded where the import happens rather than
   * re-derived later: it describes the file the user opened, not whatever the
   * body became after the features layered on top of it.
   */
  importedStepDiagnostics: Map<BodyId, ImportedStepDiagnostics>;
  /**
   * Bodies whose geometry originates in an imported mesh, directly or through
   * a derived feature. Their shells are source-file facets rather than
   * analytic surfaces, which is what makes booleans against them a typed
   * refusal instead of a silently poor result.
   */
  meshBodies: Set<BodyId>;
  warnings: string[];
}

interface MeasuredShape {
  vertices: number[];
  indices: number[];
  topology: BodyTopology;
  faceCount: number;
  volume: number;
  valid: boolean;
  strictValid: boolean;
  meshClosure: TriangleMeshClosure | null;
  bbox: {
    min: Vec3;
    max: Vec3;
  };
}

interface AnalyticCylinder {
  origin: Vec3;
  axis: Vec3;
  radius: number;
  axialMin: number;
  axialMax: number;
}

function dot(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z
  };
}

function add(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z
  };
}

function scale(vector: Vec3, factor: number): Vec3 {
  return {
    x: vector.x * factor,
    y: vector.y * factor,
    z: vector.z * factor
  };
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x
  };
}

function length(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalized(vector: Vec3): Vec3 | null {
  const magnitude = length(vector);
  return magnitude > GEOMETRY_EPSILON ? scale(vector, 1 / magnitude) : null;
}

function finiteVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3) {
    return null;
  }
  const [x, y, z] = value as unknown[];
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof z !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  ) {
    return null;
  }
  return { x, y, z };
}

function analyticSurfaceRecord(
  kernel: BrepKernel,
  face: number
): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(kernel.getAnalyticSurfaceParams(face));
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sameSphereSurface(kernel: BrepKernel, faces: number[]): boolean {
  if (
    faces.length !== 2 ||
    faces.some((face) => kernel.getSurfaceType(face) !== 'sphere')
  ) {
    return false;
  }
  const records = faces.map((face) => analyticSurfaceRecord(kernel, face));
  const centers = records.map((record) => finiteVec3(record?.center));
  const radii = records.map((record) => record?.radius);
  if (
    !centers[0] ||
    !centers[1] ||
    typeof radii[0] !== 'number' ||
    typeof radii[1] !== 'number'
  ) {
    return false;
  }
  const scale = Math.max(
    1,
    Math.abs(centers[0].x),
    Math.abs(centers[0].y),
    Math.abs(centers[0].z),
    Math.abs(centers[1].x),
    Math.abs(centers[1].y),
    Math.abs(centers[1].z),
    Math.abs(radii[0]),
    Math.abs(radii[1])
  );
  const tolerance = scale * GEOMETRY_EPSILON;
  return (
    Math.abs(radii[0] - radii[1]) <= tolerance &&
    Math.hypot(
      centers[0].x - centers[1].x,
      centers[0].y - centers[1].y,
      centers[0].z - centers[1].z
    ) <= tolerance
  );
}

/**
 * A periodic face references its UV-closing seam twice. BrepKit's sphere is
 * currently built from two same-surface hemispheres, so their smooth equator
 * fragments are display seams too. Neither case is a physical feature edge.
 */
function brepEdgeDisplayRole(
  kernel: BrepKernel,
  edge: number,
  edgeToFaces: Record<string, number[]>
): 'feature' | 'seam' {
  const owners = edgeToFaces[String(edge)];
  if (!Array.isArray(owners) || owners.length < 2) {
    return 'feature';
  }
  const uniqueOwners = [...new Set(owners)];
  if (
    uniqueOwners.length === 1 &&
    PERIODIC_SURFACE_TYPES.has(kernel.getSurfaceType(uniqueOwners[0]!))
  ) {
    return 'seam';
  }
  return sameSphereSurface(kernel, uniqueOwners) ? 'seam' : 'feature';
}

/**
 * Read a simple analytic cylinder (one cylindrical wall and two planar caps).
 * More complex solids deliberately fall through to BrepKit's general boolean.
 */
function readAnalyticCylinder(
  kernel: BrepKernel,
  solid: number
): AnalyticCylinder | null {
  const faces = Array.from(kernel.getSolidFaces(solid));
  const cylinderFaces = faces.filter(
    (face) => kernel.getSurfaceType(face) === 'cylinder'
  );
  if (
    faces.length !== 3 ||
    cylinderFaces.length !== 1 ||
    faces.filter((face) => kernel.getSurfaceType(face) === 'plane').length !== 2
  ) {
    return null;
  }

  const face = cylinderFaces[0]!;
  let parameters: unknown;
  try {
    parameters = JSON.parse(kernel.getAnalyticSurfaceParams(face));
  } catch {
    return null;
  }
  if (!parameters || typeof parameters !== 'object') {
    return null;
  }
  const record = parameters as Record<string, unknown>;
  const origin = finiteVec3(record.origin);
  const rawAxis = finiteVec3(record.axis);
  const axis = rawAxis ? normalized(rawAxis) : null;
  const radius = record.radius;
  const domain = Array.from(kernel.getSurfaceDomain(face));
  if (
    !origin ||
    !axis ||
    typeof radius !== 'number' ||
    !Number.isFinite(radius) ||
    radius <= GEOMETRY_EPSILON ||
    domain.length !== 4 ||
    !domain.every(Number.isFinite)
  ) {
    return null;
  }

  return {
    origin,
    axis,
    radius,
    axialMin: Math.min(domain[2]!, domain[3]!),
    axialMax: Math.max(domain[2]!, domain[3]!)
  };
}

function coordinateFrameMatrix(origin: Vec3, zAxis: Vec3): Float64Array {
  const reference =
    Math.abs(zAxis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const xAxis = normalized(cross(reference, zAxis));
  if (!xAxis) {
    throw new Error('Could not construct a cylinder coordinate frame.');
  }
  const yAxis = cross(zAxis, xAxis);
  return new Float64Array([
    xAxis.x,
    yAxis.x,
    zAxis.x,
    origin.x,
    xAxis.y,
    yAxis.y,
    zAxis.y,
    origin.y,
    xAxis.z,
    yAxis.z,
    zAxis.z,
    origin.z,
    0,
    0,
    0,
    1
  ]);
}

/** Revolve a radial/axial section around local +Z, then place it in world space. */
function revolveRadialProfile(
  kernel: BrepKernel,
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

/**
 * Rebuild selected rims on a simple cylinder from a bounded radial profile.
 *
 * BrepKit's general fillet can return the input handle unchanged when the
 * blend is exactly half the cylinder diameter, even though the rounded radial
 * profile is valid. The profile uses a fixed, fine-grained quarter-circle
 * approximation so the result remains a valid revolved solid. Keep this
 * fallback deliberately narrow: every selected edge must be one of the two
 * full circular cap rims on a three-face analytic cylinder.
 */
function tryExactAnalyticCylinderRimFillet(
  kernel: BrepKernel,
  solid: number,
  selectedEdges: number[],
  radius: number
): number | null {
  const cylinder = readAnalyticCylinder(kernel, solid);
  if (!cylinder || selectedEdges.length === 0 || !Number.isFinite(radius)) {
    return null;
  }

  const height = cylinder.axialMax - cylinder.axialMin;
  const span = Math.max(1, cylinder.radius, height);
  const linearTolerance = ANALYTIC_MATCH_EPSILON * span;
  const lengthTolerance = Math.max(
    linearTolerance,
    2 * Math.PI * cylinder.radius * 1e-5
  );
  const selectedRims = new Set<'bottom' | 'top'>();

  for (const edge of selectedEdges) {
    const sample = edgeSampleOf(kernel, edge);
    if (
      !sample.closed ||
      sample.curveType.toUpperCase() !== 'CIRCLE' ||
      Math.abs(sample.length - 2 * Math.PI * cylinder.radius) > lengthTolerance
    ) {
      return null;
    }
    const centerOffset = subtract(sample.center, cylinder.origin);
    const axialPosition = dot(centerOffset, cylinder.axis);
    const radialOffset = subtract(
      centerOffset,
      scale(cylinder.axis, axialPosition)
    );
    if (length(radialOffset) > linearTolerance) {
      return null;
    }
    if (
      Math.abs(axialPosition - cylinder.axialMin) <= linearTolerance &&
      !selectedRims.has('bottom')
    ) {
      selectedRims.add('bottom');
    } else if (
      Math.abs(axialPosition - cylinder.axialMax) <= linearTolerance &&
      !selectedRims.has('top')
    ) {
      selectedRims.add('top');
    } else {
      return null;
    }
  }

  if (
    radius <= GEOMETRY_EPSILON ||
    radius >= cylinder.radius - linearTolerance ||
    (selectedRims.size === 2 && radius * 2 >= height - linearTolerance) ||
    (selectedRims.size === 1 && radius >= height - linearTolerance)
  ) {
    return null;
  }

  const profile: Vec2[] = [];
  const appendQuarter = (
    center: Vec2,
    startAngle: number,
    endAngle: number
  ) => {
    const segments = 64;
    for (let index = 0; index <= segments; index += 1) {
      if (profile.length > 0 && index === 0) {
        continue;
      }
      const angle = startAngle + ((endAngle - startAngle) * index) / segments;
      profile.push({
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle)
      });
    }
  };
  const bottomAxis = { x: 0, y: cylinder.axialMin };
  const bottomOuter = selectedRims.has('bottom')
    ? { x: cylinder.radius - radius, y: cylinder.axialMin }
    : { x: cylinder.radius, y: cylinder.axialMin };
  profile.push(bottomAxis, bottomOuter);

  if (selectedRims.has('bottom')) {
    appendQuarter(
      { x: cylinder.radius - radius, y: cylinder.axialMin + radius },
      -Math.PI / 2,
      0
    );
  }

  const wallTop = selectedRims.has('top')
    ? { x: cylinder.radius, y: cylinder.axialMax - radius }
    : { x: cylinder.radius, y: cylinder.axialMax };
  profile.push(wallTop);

  if (selectedRims.has('top')) {
    appendQuarter(
      { x: cylinder.radius - radius, y: cylinder.axialMax - radius },
      0,
      Math.PI / 2
    );
  }

  const topAxis = { x: 0, y: cylinder.axialMax };
  profile.push(topAxis);
  return revolveRadialProfile(kernel, profile, cylinder);
}

/** True when two of the selected edges meet at a shared model vertex. */
function selectedEdgesShareVertex(
  kernel: BrepKernel,
  selectedEdges: number[]
): boolean {
  if (selectedEdges.length < 2) {
    return false;
  }
  const seen = new Set<number>();
  for (const edge of selectedEdges) {
    // Deduplicate per edge: a closed edge reports the same vertex handle at
    // both ends, which is not a corner between two selected edges.
    for (const vertex of new Set(kernel.getEdgeVertexHandles(edge))) {
      if (seen.has(vertex)) {
        return true;
      }
      seen.add(vertex);
    }
  }
  return false;
}

/**
 * True when a selected edge touches a freeform (blend) face of the target —
 * either bordering it directly or ending on one of its boundary vertices.
 */
function selectionTouchesBlendFace(
  kernel: BrepKernel,
  solid: number,
  selectedEdges: number[]
): boolean {
  const blendVertices = new Set<number>();
  for (const face of kernel.getSolidFaces(solid)) {
    if (kernel.getSurfaceType(face) !== 'bspline') {
      continue;
    }
    for (const edge of kernel.getFaceEdges(face)) {
      for (const vertex of kernel.getEdgeVertexHandles(edge)) {
        blendVertices.add(vertex);
      }
    }
  }
  if (blendVertices.size === 0) {
    return false;
  }
  return selectedEdges.some((edge) =>
    Array.from(kernel.getEdgeVertexHandles(edge)).some((vertex) =>
      blendVertices.has(vertex)
    )
  );
}

/**
 * Cause-aware failure message for an edge modifier that every kernel engine
 * refused. BrepKit's `try_fillet` collapses all-engine failure into a silent
 * input-handle return, discarding the typed engine errors
 * (docs/qa/2026-08-01/plate-second-fillet-investigation.md), so the cause is
 * inferred from the selection's topology instead. Closed rims and corner
 * chains on boolean-result bodies fail at every size — steering the user
 * toward a smaller radius for those is a dead end.
 */
function edgeModifierFailureMessage(
  kernel: BrepKernel,
  target: number,
  selected: number[],
  featureKind: 'fillet' | 'chamfer',
  size: number
): string {
  const label = featureKind === 'fillet' ? 'Fillet' : 'Chamfer';
  const dimension = featureKind === 'fillet' ? 'radius' : 'distance';
  const verb = featureKind === 'fillet' ? 'rounded' : 'chamfered';
  const prefix = `${label} could not be created on ${selected.length} selected edge${selected.length === 1 ? '' : 's'} with ${dimension} ${size}.`;
  try {
    if (selected.some((edge) => edgeSampleOf(kernel, edge).closed)) {
      return `${prefix} Closed rim edges (such as hole rims) cannot be ${verb} on this body yet at any ${dimension} — deselect the rim edge and try again.`;
    }
    if (selectedEdgesShareVertex(kernel, selected)) {
      return `${prefix} Edges that meet at a shared corner cannot be ${verb} together on this body yet at any ${dimension} — select edges that do not touch, or apply one edge per feature.`;
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
 * resizes leave a valid analytic solid, but BrepKit's generic cap boolean can
 * accumulate a mismatched circular boundary and fail its exact volume gate.
 * This path is deliberately limited to the three-face cylinder case; every
 * more complex prismatic face still uses the general push/pull operation.
 */
function tryExactAnalyticCylinderCapOffset(
  kernel: BrepKernel,
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
    // Face area is measured through BrepKit's bounded-deflection integration,
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
 * BrepKit's generic boolean currently falls back to a triangular B-rep when a
 * smaller coaxial cylinder opens exactly onto either cap. Revolving the exact
 * radial section is the equivalent CSG result, but keeps true cylindrical
 * surfaces in the document and exported STEP file.
 */
function tryExactCoaxialCylinderCut(
  kernel: BrepKernel,
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
    // A fully enclosed tool is already handled analytically by BrepKit as an
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

function axisDirection(axis: 'x' | 'y' | 'z'): Vec3 {
  return {
    x: axis === 'x' ? 1 : 0,
    y: axis === 'y' ? 1 : 0,
    z: axis === 'z' ? 1 : 0
  };
}

export interface ExactKernelAdapter {
  readonly kind: 'brepkit' | 'occt' | 'hybrid';
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

function pointOnPlane(basis: PlaneBasis, point: Vec2, offset: number): Vec3 {
  return {
    x:
      basis.origin.x +
      basis.u.x * point.x +
      basis.v.x * point.y +
      basis.normal.x * offset,
    y:
      basis.origin.y +
      basis.u.y * point.x +
      basis.v.y * point.y +
      basis.normal.y * offset,
    z:
      basis.origin.z +
      basis.u.z * point.x +
      basis.v.z * point.y +
      basis.normal.z * offset
  };
}

function profilePoints(
  data: SketchObjectData,
  scope: Record<string, number>
): Vec2[] {
  switch (data.objectKind) {
    case 'rectangle':
      return rectangleProfile(
        resolveParamValue(data.width, scope, 'width'),
        resolveParamValue(data.height, scope, 'height'),
        resolveParamValue(data.centerX, scope, 'center X'),
        resolveParamValue(data.centerY, scope, 'center Y')
      );
    case 'circle':
      return circleProfile(
        resolveParamValue(data.radius, scope, 'radius'),
        resolveParamValue(data.centerX, scope, 'center X'),
        resolveParamValue(data.centerY, scope, 'center Y')
      );
    case 'polygon':
      return polygonProfile(
        resolveParamValue(data.sides, scope, 'sides'),
        resolveParamValue(data.radius, scope, 'radius'),
        resolveParamValue(data.centerX, scope, 'center X'),
        resolveParamValue(data.centerY, scope, 'center Y')
      );
    case 'line':
    case 'arc':
      // Open curves cannot be swept directly; they participate in sketches
      // through detected closed regions instead.
      throw new Error(
        `A ${data.objectKind} is not a closed profile and cannot be extruded on its own.`
      );
  }
}

/**
 * Build the same ZYX Euler transform the viewport's Move gizmo composes, so a
 * dragged placement and the rebuilt body agree once more than one axis is
 * non-zero. BrepKit accepts row-major matrices and column vectors.
 */
function transformMatrix(translation: Vec3, rotationDeg: Vec3): Float64Array {
  const rx = (rotationDeg.x * Math.PI) / 180;
  const ry = (rotationDeg.y * Math.PI) / 180;
  const rz = (rotationDeg.z * Math.PI) / 180;
  const ca = Math.cos(rx);
  const sa = Math.sin(rx);
  const cb = Math.cos(ry);
  const sb = Math.sin(ry);
  const cc = Math.cos(rz);
  const sc = Math.sin(rz);
  return new Float64Array([
    cc * cb,
    cc * sb * sa - sc * ca,
    cc * sb * ca + sc * sa,
    translation.x,
    sc * cb,
    sc * sb * sa + cc * ca,
    sc * sb * ca - cc * sa,
    translation.y,
    -sb,
    cb * sa,
    cb * ca,
    translation.z,
    0,
    0,
    0,
    1
  ]);
}

function uniformScaleMatrix(factor: number): Float64Array {
  return new Float64Array([
    factor,
    0,
    0,
    0,
    0,
    factor,
    0,
    0,
    0,
    0,
    factor,
    0,
    0,
    0,
    0,
    1
  ]);
}

function quantizeEdgeCoordinate(value: number): number {
  return Math.round(value / GEOMETRY_LINEAR_TOLERANCE);
}

function pointAt(values: number[], offset: number): Vec3 {
  return {
    x: values[offset] ?? 0,
    y: values[offset + 1] ?? 0,
    z: values[offset + 2] ?? 0
  };
}

/** Sample the ADR-011 edge identity quantities from a BrepKit edge. */
function edgeSampleOf(kernel: BrepKernel, edge: number): EdgeSample {
  const vertices = Array.from(kernel.getEdgeVertices(edge));
  const start = pointAt(vertices, 0);
  const end = pointAt(vertices, 3);
  const curveType = kernel.getEdgeCurveType(edge);
  const length = kernel.edgeLength(edge);
  const domain = Array.from(kernel.getEdgeCurveParameters(edge));
  const first = domain[0] ?? 0;
  const span = (domain[1] ?? 1) - first;
  if (!isClosedEdge(start, end)) {
    return {
      closed: false,
      curveType,
      length,
      endpoints: [start, end],
      midpoint: pointAt(
        Array.from(kernel.evaluateEdgeCurve(edge, first + span / 2)),
        0
      )
    };
  }
  const center = { x: 0, y: 0, z: 0 };
  for (let sample = 0; sample < 4; sample += 1) {
    const point = Array.from(
      kernel.evaluateEdgeCurve(edge, first + (span * sample) / 4)
    );
    center.x += (point[0] ?? 0) / 4;
    center.y += (point[1] ?? 0) / 4;
    center.z += (point[2] ?? 0) / 4;
  }
  const tangentA = pointAt(
    Array.from(kernel.evaluateEdgeCurveD1(edge, first)),
    3
  );
  const tangentB = pointAt(
    Array.from(kernel.evaluateEdgeCurveD1(edge, first + span / 4)),
    3
  );
  const axis = normalized(cross(tangentA, tangentB));
  return {
    closed: true,
    curveType,
    length,
    center,
    axis: axis ? canonicalDirection(axis) : null
  };
}

function edgeFingerprint(kernel: BrepKernel, edge: number): number {
  return edgeFingerprintOf(edgeSampleOf(kernel, edge));
}

/**
 * The pre-ADR-011 BrepKit scheme: closed curves hashed their seam vertex and
 * mid-parameter point, both of which depend on BrepKit's parameterization
 * phase. Persisted documents still hold these values, so resolution maps
 * register them alongside the kernel-neutral fingerprint. (For open edges the
 * two schemes produce identical signatures.)
 */
function legacyEdgeFingerprint(kernel: BrepKernel, edge: number): number {
  const vertices = Array.from(kernel.getEdgeVertices(edge));
  const endpoints = [vertices.slice(0, 3), vertices.slice(3, 6)].sort(
    (a, b) => {
      for (let index = 0; index < 3; index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) {
          return difference;
        }
      }
      return 0;
    }
  );
  const domain = Array.from(kernel.getEdgeCurveParameters(edge));
  const midpoint = Array.from(
    kernel.evaluateEdgeCurve(edge, ((domain[0] ?? 0) + (domain[1] ?? 1)) / 2)
  );
  const signature = [
    kernel.getEdgeCurveType(edge),
    quantizeEdgeCoordinate(kernel.edgeLength(edge)),
    ...endpoints.flat().map(quantizeEdgeCoordinate),
    ...midpoint.map(quantizeEdgeCoordinate)
  ].join(':');
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  return unsigned === 0 ? 1 : unsigned;
}

function registerHandle(
  map: Map<number, number[]>,
  hash: number,
  handle: number
): void {
  const handles = map.get(hash) ?? [];
  handles.push(handle);
  map.set(hash, handles);
}

function edgeHandlesByFingerprint(
  kernel: BrepKernel,
  solid: number
): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (const edge of kernel.getSolidEdges(solid)) {
    const hash = edgeFingerprint(kernel, edge);
    registerHandle(result, hash, edge);
    const legacy = legacyEdgeFingerprint(kernel, edge);
    if (legacy !== hash) {
      registerHandle(result, legacy, edge);
    }
  }
  return result;
}

function faceVertexCentroid(kernel: BrepKernel, face: number): Vec3 | null {
  const vertices = Array.from(kernel.getFaceVertices(face));
  if (vertices.length === 0) {
    return null;
  }
  const centroid = { x: 0, y: 0, z: 0 };
  for (const vertex of vertices) {
    const position = kernel.getVertexPosition(vertex);
    centroid.x += position[0]!;
    centroid.y += position[1]!;
    centroid.z += position[2]!;
  }
  return {
    x: centroid.x / vertices.length,
    y: centroid.y / vertices.length,
    z: centroid.z / vertices.length
  };
}

function analyticParamsSignature(kernel: BrepKernel, face: number): string {
  let parameters: unknown;
  try {
    parameters = JSON.parse(kernel.getAnalyticSurfaceParams(face));
  } catch {
    return '';
  }
  if (!parameters || typeof parameters !== 'object') {
    return '';
  }
  const record = parameters as Record<string, unknown>;
  const parts: string[] = [];
  const origin = finiteVec3(record.origin);
  const axis = finiteVec3(record.axis);
  if (axis) {
    const unit = normalized(axis);
    if (unit) {
      // Canonical sign: a surface's axis may flip between rebuilds.
      const canonical = canonicalDirection(unit);
      parts.push(
        `ax${quantizeEdgeCoordinate(canonical.x * 1000)}` +
          `,${quantizeEdgeCoordinate(canonical.y * 1000)}` +
          `,${quantizeEdgeCoordinate(canonical.z * 1000)}`
      );
      if (origin) {
        // The axis foot (origin projected onto the axis-orthogonal plane
        // through zero) is stable even when the parametric origin slides
        // along the axis between rebuilds.
        const along =
          origin.x * canonical.x +
          origin.y * canonical.y +
          origin.z * canonical.z;
        parts.push(
          `ft${quantizeEdgeCoordinate(origin.x - along * canonical.x)}` +
            `,${quantizeEdgeCoordinate(origin.y - along * canonical.y)}` +
            `,${quantizeEdgeCoordinate(origin.z - along * canonical.z)}`
        );
      }
    }
  }
  for (const key of ['radius', 'majorRadius', 'minorRadius', 'semiAngle']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      parts.push(`${key[0]}${quantizeEdgeCoordinate(value)}`);
    }
  }
  return parts.join(':');
}

/**
 * Geometric fingerprint of a face (ADR-011): surface class, quantized
 * boundary perimeter, canonical analytic parameters for planes and cylinders,
 * and the boundary vertex centroid — all exact quantities both kernels agree
 * on, unlike the tessellated area the previous scheme used. Stable across
 * identical rebuilds; any real geometry change moves it, so face-referencing
 * features fail closed instead of editing the wrong face (the same contract
 * ADR-008/ADR-010 establish for edges).
 */
function faceFingerprint(kernel: BrepKernel, face: number): number {
  const surfaceType = kernel.getSurfaceType(face);
  let perimeter = 0;
  for (const edge of kernel.getFaceEdges(face)) {
    perimeter += kernel.edgeLength(edge);
  }
  let analytic = '';
  let parameters: unknown;
  try {
    parameters = JSON.parse(kernel.getAnalyticSurfaceParams(face));
  } catch {
    parameters = null;
  }
  const record = (parameters ?? {}) as Record<string, unknown>;
  if (surfaceType === 'plane') {
    const rawNormal = finiteVec3(record.normal);
    const normal = rawNormal ? normalized(rawNormal) : null;
    const offset = record.d;
    if (normal && typeof offset === 'number' && Number.isFinite(offset)) {
      analytic = planeAnalyticSignature(normal, offset);
    }
  } else if (surfaceType === 'cylinder') {
    const origin = finiteVec3(record.origin);
    const rawAxis = finiteVec3(record.axis);
    const axis = rawAxis ? normalized(rawAxis) : null;
    const radius = record.radius;
    if (
      origin &&
      axis &&
      typeof radius === 'number' &&
      Number.isFinite(radius)
    ) {
      analytic = cylinderAnalyticSignature(origin, axis, radius);
    }
  }
  return faceFingerprintOf({
    surfaceType,
    perimeter,
    analytic,
    centroid: faceVertexCentroid(kernel, face)
  });
}

function quantizedPoint(point: Vec3): QuantizedTopologyPoint {
  return [
    quantizeCoordinate(point.x),
    quantizeCoordinate(point.y),
    quantizeCoordinate(point.z)
  ];
}

function quantizedDirectionOf(direction: Vec3): QuantizedTopologyPoint | null {
  const unit = normalized(direction);
  if (!unit) {
    return null;
  }
  const canonical = canonicalDirection(unit);
  return [
    quantizeCoordinate(canonical.x * 1000),
    quantizeCoordinate(canonical.y * 1000),
    quantizeCoordinate(canonical.z * 1000)
  ];
}

function edgeWitnessOf(kernel: BrepKernel, edge: number): EdgeWitnessV1 {
  const sample = edgeSampleOf(kernel, edge);
  if (sample.closed) {
    return {
      curveType: sample.curveType,
      length: quantizeCoordinate(sample.length),
      closed: true,
      center: quantizedPoint(sample.center),
      axis: sample.axis ? quantizedDirectionOf(sample.axis) : null
    };
  }
  const endpoints = sample.endpoints.map(quantizedPoint).sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      const difference = left[index]! - right[index]!;
      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  }) as [QuantizedTopologyPoint, QuantizedTopologyPoint];
  return {
    curveType: sample.curveType,
    length: quantizeCoordinate(sample.length),
    closed: false,
    endpoints,
    midpoint: quantizedPoint(sample.midpoint)
  };
}

function brepKitFaceClosure(
  kernel: BrepKernel,
  face: number,
  surfaceType: string
): FaceWitnessV1['closure'] {
  switch (surfaceType) {
    case 'plane':
      return { u: 'open', v: 'open' };
    case 'cylinder':
    case 'cone':
    case 'sphere':
      return { u: 'closed', v: 'open' };
    case 'torus':
      return { u: 'closed', v: 'closed' };
    case 'bspline':
    case 'nurbs': {
      try {
        const decoded: unknown = JSON.parse(
          kernel.getNurbsSurfaceDataParity(face)
        );
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
          return { u: 'unknown', v: 'unknown' };
        }
        const record = decoded as Record<string, unknown>;
        return {
          u:
            typeof record.isPeriodicU === 'boolean'
              ? record.isPeriodicU
                ? 'closed'
                : 'open'
              : 'unknown',
          v:
            typeof record.isPeriodicV === 'boolean'
              ? record.isPeriodicV
                ? 'closed'
                : 'open'
              : 'unknown'
        };
      } catch {
        return { u: 'unknown', v: 'unknown' };
      }
    }
    default:
      return { u: 'unknown', v: 'unknown' };
  }
}

function faceWitnessOf(kernel: BrepKernel, face: number): FaceWitnessV1 {
  const surfaceType = kernel.getSurfaceType(face);
  let perimeter = 0;
  for (const edge of kernel.getFaceEdges(face)) {
    perimeter += kernel.edgeLength(edge);
  }
  let analytic: FaceWitnessV1['analytic'] = { kind: 'none' };
  let parameters: unknown;
  try {
    parameters = JSON.parse(kernel.getAnalyticSurfaceParams(face));
  } catch {
    parameters = null;
  }
  const record = (parameters ?? {}) as Record<string, unknown>;
  if (surfaceType === 'plane') {
    const rawNormal = finiteVec3(record.normal);
    const unit = rawNormal ? normalized(rawNormal) : null;
    const rawOffset = record.d;
    if (unit && typeof rawOffset === 'number' && Number.isFinite(rawOffset)) {
      const { direction: normal, flipped } = canonicalizeDirection(unit);
      analytic = {
        kind: 'plane',
        normal: quantizedDirectionOf(normal)!,
        offset: quantizeCoordinate(flipped ? -rawOffset : rawOffset)
      };
    }
  } else if (surfaceType === 'cylinder') {
    const origin = finiteVec3(record.origin);
    const rawAxis = finiteVec3(record.axis);
    const unit = rawAxis ? normalized(rawAxis) : null;
    const radius = record.radius;
    if (
      origin &&
      unit &&
      typeof radius === 'number' &&
      Number.isFinite(radius)
    ) {
      const axis = canonicalDirection(unit);
      const along = dot(origin, axis);
      analytic = {
        kind: 'cylinder',
        axis: quantizedDirectionOf(axis)!,
        axisFoot: quantizedPoint(subtract(origin, scale(axis, along))),
        radius: quantizeCoordinate(radius)
      };
    }
  }
  const centroid = faceVertexCentroid(kernel, face);
  return {
    surfaceType,
    perimeter: quantizeCoordinate(perimeter),
    centroid: centroid ? quantizedPoint(centroid) : null,
    analytic,
    closure: brepKitFaceClosure(kernel, face, surfaceType)
  };
}

/**
 * Measure one imported solid for the K0.6 validator.
 *
 * Closure and manifoldness are read from the EXACT B-rep — `edgeToFaceMap`
 * lists one entry per face use of an edge, so a closed manifold shell uses
 * every edge exactly twice. This is deliberately not `meshQuality`, which
 * reports `isWatertight: false` for a valid analytic cone because the apex
 * does not weld; see `imported-step-validation.ts` for that measurement.
 *
 * The strict validator is used rather than the relaxed one because the
 * relaxation exists for booleans and blends, and an import has not been
 * through either — it is what the file declares.
 */
function diagnoseImportedSolid(
  kernel: BrepKernel,
  solid: number,
  index: number
): ImportedSolidDiagnosis {
  const edgeToFaces = JSON.parse(kernel.edgeToFaceMap(solid)) as Record<
    string,
    number[]
  >;
  let openEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  let edgeCount = 0;
  for (const uses of Object.values(edgeToFaces)) {
    edgeCount += 1;
    const count = Array.isArray(uses) ? uses.length : 0;
    if (count < 2) {
      openEdgeCount += 1;
    } else if (count > 2) {
      nonManifoldEdgeCount += 1;
    }
  }
  return {
    index,
    faceCount: Array.from(kernel.getSolidFaces(solid)).length,
    edgeCount,
    openEdgeCount,
    nonManifoldEdgeCount,
    shellCount: Array.from(kernel.getSolidShells(solid)).length,
    strictErrorCount: kernel.validateSolid(solid),
    relaxedErrorCount: kernel.validateSolidRelaxed(solid)
  };
}

function topologyCandidatesForSolid(
  kernel: BrepKernel,
  solid: number
): BrepKitTopologyCandidate[] {
  return [
    ...Array.from(kernel.getSolidFaces(solid), (handle) => ({
      handle,
      kind: 'face' as const,
      witness: faceWitnessOf(kernel, handle)
    })),
    ...Array.from(kernel.getSolidEdges(solid), (handle) => ({
      handle,
      kind: 'edge' as const,
      witness: edgeWitnessOf(kernel, handle)
    }))
  ];
}

function samePoint(
  left: QuantizedTopologyPoint,
  right: QuantizedTopologyPoint
): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

function sameAnalyticCarrier(
  left: FaceWitnessV1['analytic'],
  right: FaceWitnessV1['analytic']
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'none' || right.kind === 'none') {
    return left.kind === right.kind;
  }
  if (left.kind === 'plane' && right.kind === 'plane') {
    return samePoint(left.normal, right.normal) && left.offset === right.offset;
  }
  if (left.kind === 'cylinder' && right.kind === 'cylinder') {
    return (
      samePoint(left.axis, right.axis) &&
      samePoint(left.axisFoot, right.axisFoot) &&
      left.radius === right.radius
    );
  }
  return false;
}

function addUniqueSemanticAssignment(
  candidates: readonly BrepKitTopologyCandidate[],
  kind: 'edge' | 'face',
  lineageName: string,
  predicate: (candidate: BrepKitTopologyCandidate) => boolean,
  assignments: BrepKitSemanticAssignment[],
  diagnostics: BrepKitLineageState[],
  operation: 'primitive' | 'sweep'
) {
  const matches = candidates.filter(
    (candidate) => candidate.kind === kind && predicate(candidate)
  );
  if (matches.length !== 1) {
    diagnostics.push(
      brepKitHashOnlyLineage(
        operation,
        `Semantic role ${lineageName} matched ${matches.length} exact candidates.`
      )
    );
    return;
  }
  assignments.push({ ...matches[0]!, lineageName });
}

function primitiveBoxEdgeRole(
  witness: EdgeWitnessV1,
  bounds: {
    min: QuantizedTopologyPoint;
    max: QuantizedTopologyPoint;
  }
): string | null {
  if (witness.closed) {
    return null;
  }
  const deltas = witness.endpoints[0].map(
    (value, axis) => witness.endpoints[1][axis]! - value
  );
  const varyingAxes = deltas
    .map((delta, axis) => ({ delta, axis }))
    .filter(({ delta }) => delta !== 0);
  if (varyingAxes.length !== 1) {
    return null;
  }
  const axis = varyingAxes[0]!.axis;
  const labels = ['x', 'y', 'z'] as const;
  const fixed: string[] = [];
  for (let fixedAxis = 0; fixedAxis < 3; fixedAxis += 1) {
    if (fixedAxis === axis) {
      continue;
    }
    const coordinate = witness.endpoints[0][fixedAxis]!;
    const bound =
      coordinate === bounds.min[fixedAxis]
        ? 'min'
        : coordinate === bounds.max[fixedAxis]
          ? 'max'
          : null;
    if (!bound || witness.endpoints[1][fixedAxis] !== coordinate) {
      return null;
    }
    fixed.push(`${labels[fixedAxis]}-${bound}`);
  }
  return `primitive.box.edge.${labels[axis]}.${fixed.join('.')}`;
}

function buildPrimitiveLineage(
  kernel: BrepKernel,
  solid: number,
  feature: FeatureNode
): BrepKitLineageState {
  if (feature.data.featureKind !== 'primitive') {
    return brepKitHashOnlyLineage(
      'primitive',
      'Feature is not a primitive construction.'
    );
  }
  const candidates = topologyCandidatesForSolid(kernel, solid);
  const assignments: BrepKitSemanticAssignment[] = [];
  const diagnostics: BrepKitLineageState[] = [];
  const faces = candidates.filter((candidate) => candidate.kind === 'face');
  const edges = candidates.filter((candidate) => candidate.kind === 'edge');
  const boundsValues = Array.from(kernel.boundingBox(solid));
  const bounds = {
    min: quantizedPoint({
      x: boundsValues[0]!,
      y: boundsValues[1]!,
      z: boundsValues[2]!
    }),
    max: quantizedPoint({
      x: boundsValues[3]!,
      y: boundsValues[4]!,
      z: boundsValues[5]!
    })
  };

  switch (feature.data.primitiveKind) {
    case 'box': {
      const faceRoles = new Map<number, string>();
      for (const candidate of faces) {
        const normal = Array.from(kernel.getFaceNormal(candidate.handle));
        const unit = normalized(pointAt(normal, 0));
        if (!unit) {
          continue;
        }
        const direction = [
          Math.round(unit.x),
          Math.round(unit.y),
          Math.round(unit.z)
        ];
        const role =
          direction[0] === -1
            ? 'x-min'
            : direction[0] === 1
              ? 'x-max'
              : direction[1] === -1
                ? 'y-min'
                : direction[1] === 1
                  ? 'y-max'
                  : direction[2] === -1
                    ? 'z-min'
                    : direction[2] === 1
                      ? 'z-max'
                      : null;
        if (role) {
          faceRoles.set(candidate.handle, role);
        }
      }
      for (const role of [
        'x-min',
        'x-max',
        'y-min',
        'y-max',
        'z-min',
        'z-max'
      ]) {
        addUniqueSemanticAssignment(
          faces,
          'face',
          `primitive.box.face.${role}`,
          (candidate) => faceRoles.get(candidate.handle) === role,
          assignments,
          diagnostics,
          'primitive'
        );
      }
      const edgeRoles = new Map<number, string>();
      for (const candidate of edges) {
        const role = primitiveBoxEdgeRole(
          candidate.witness as EdgeWitnessV1,
          bounds
        );
        if (role) {
          edgeRoles.set(candidate.handle, role);
        }
      }
      const expectedEdgeRoles = ['x', 'y', 'z'].flatMap((varyingAxis) => {
        const fixedAxes = ['x', 'y', 'z'].filter(
          (axis) => axis !== varyingAxis
        );
        return ['min', 'max'].flatMap((firstBound) =>
          ['min', 'max'].map(
            (secondBound) =>
              `primitive.box.edge.${varyingAxis}.${fixedAxes[0]}-${firstBound}.${fixedAxes[1]}-${secondBound}`
          )
        );
      });
      for (const role of expectedEdgeRoles) {
        addUniqueSemanticAssignment(
          edges,
          'edge',
          role,
          (candidate) => edgeRoles.get(candidate.handle) === role,
          assignments,
          diagnostics,
          'primitive'
        );
      }
      break;
    }
    case 'cylinder':
    case 'cone': {
      const kind = feature.data.primitiveKind;
      addUniqueSemanticAssignment(
        faces,
        'face',
        `primitive.${kind}.face.wall`,
        (candidate) =>
          (candidate.witness as FaceWitnessV1).surfaceType === kind,
        assignments,
        diagnostics,
        'primitive'
      );
      for (const [role, coordinate] of [
        ['start', bounds.min[2]],
        ['end', bounds.max[2]]
      ] as const) {
        addUniqueSemanticAssignment(
          faces,
          'face',
          `primitive.${kind}.face.cap.${role}`,
          (candidate) => {
            const witness = candidate.witness as FaceWitnessV1;
            return (
              witness.surfaceType === 'plane' &&
              witness.centroid?.[2] === coordinate
            );
          },
          assignments,
          diagnostics,
          'primitive'
        );
        addUniqueSemanticAssignment(
          edges,
          'edge',
          `primitive.${kind}.edge.rim.${role}`,
          (candidate) => {
            const witness = candidate.witness as EdgeWitnessV1;
            return witness.closed && witness.center[2] === coordinate;
          },
          assignments,
          diagnostics,
          'primitive'
        );
      }
      break;
    }
    case 'torus':
      addUniqueSemanticAssignment(
        faces,
        'face',
        'primitive.torus.face.shell',
        (candidate) =>
          (candidate.witness as FaceWitnessV1).surfaceType === 'torus',
        assignments,
        diagnostics,
        'primitive'
      );
      diagnostics.push(
        brepKitHashOnlyLineage(
          'primitive',
          'Torus seam edges are parameterization artifacts.'
        )
      );
      break;
    case 'sphere':
      diagnostics.push(
        brepKitHashOnlyLineage(
          'primitive',
          'BrepKit sphere hemispheres share the same exact witness and cannot be named one-to-one.'
        )
      );
      break;
  }

  return mergeBrepKitLineageStates([
    createBrepKitSemanticLineage(feature.featureId, 'primitive', assignments),
    ...diagnostics
  ]);
}

function planeCarrier(
  normal: Vec3,
  point: Vec3
): Extract<FaceWitnessV1['analytic'], { kind: 'plane' }> | null {
  const unit = normalized(normal);
  if (!unit) {
    return null;
  }
  const canonical = canonicalDirection(unit);
  return {
    kind: 'plane',
    normal: quantizedDirectionOf(canonical)!,
    offset: quantizeCoordinate(dot(canonical, point))
  };
}

function cylinderCarrier(
  axisPoint: Vec3,
  axisDirection: Vec3,
  radius: number
): Extract<FaceWitnessV1['analytic'], { kind: 'cylinder' }> | null {
  const unit = normalized(axisDirection);
  if (!unit) {
    return null;
  }
  const axis = canonicalDirection(unit);
  const along = dot(axisPoint, axis);
  return {
    kind: 'cylinder',
    axis: quantizedDirectionOf(axis)!,
    axisFoot: quantizedPoint(subtract(axisPoint, scale(axis, along))),
    radius: quantizeCoordinate(radius)
  };
}

function expectedLineWitness(start: Vec3, end: Vec3): EdgeWitnessV1 {
  const endpoints = [quantizedPoint(start), quantizedPoint(end)].sort(
    (left, right) => {
      for (let index = 0; index < 3; index += 1) {
        const difference = left[index]! - right[index]!;
        if (difference !== 0) {
          return difference;
        }
      }
      return 0;
    }
  ) as [QuantizedTopologyPoint, QuantizedTopologyPoint];
  return {
    curveType: 'LINE',
    length: quantizeCoordinate(
      Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z)
    ),
    closed: false,
    endpoints,
    midpoint: quantizedPoint({
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
      z: (start.z + end.z) / 2
    })
  };
}

function expectedCircleWitness(
  center: Vec3,
  axis: Vec3,
  radius: number
): EdgeWitnessV1 {
  return {
    curveType: 'CIRCLE',
    length: quantizeCoordinate(Math.PI * 2 * radius),
    closed: true,
    center: quantizedPoint(center),
    axis: quantizedDirectionOf(axis)
  };
}

function addFaceCarrierRole(
  candidates: readonly BrepKitTopologyCandidate[],
  carrier: FaceWitnessV1['analytic'] | null,
  lineageName: string,
  assignments: BrepKitSemanticAssignment[],
  diagnostics: BrepKitLineageState[]
) {
  if (!carrier) {
    diagnostics.push(
      brepKitHashOnlyLineage(
        'sweep',
        `Semantic role ${lineageName} has no exact analytic carrier.`
      )
    );
    return;
  }
  addUniqueSemanticAssignment(
    candidates,
    'face',
    lineageName,
    (candidate) =>
      sameAnalyticCarrier(
        (candidate.witness as FaceWitnessV1).analytic,
        carrier
      ),
    assignments,
    diagnostics,
    'sweep'
  );
}

function addEdgeWitnessRole(
  candidates: readonly BrepKitTopologyCandidate[],
  witness: EdgeWitnessV1,
  lineageName: string,
  assignments: BrepKitSemanticAssignment[],
  diagnostics: BrepKitLineageState[]
) {
  addUniqueSemanticAssignment(
    candidates,
    'edge',
    lineageName,
    (candidate) => topologyWitnessesEqual('edge', candidate.witness, witness),
    assignments,
    diagnostics,
    'sweep'
  );
}

function buildExtrudeLineage(
  kernel: BrepKernel,
  solid: number,
  feature: FeatureNode,
  objectId: string,
  data: SketchObjectData,
  basis: PlaneBasis,
  distance: number,
  scope: Record<string, number>
): BrepKitLineageState {
  const candidates = topologyCandidatesForSolid(kernel, solid);
  const assignments: BrepKitSemanticAssignment[] = [];
  const diagnostics: BrepKitLineageState[] = [];
  const startOrigin = basis.origin;
  const endOrigin = {
    x: basis.origin.x + basis.normal.x * distance,
    y: basis.origin.y + basis.normal.y * distance,
    z: basis.origin.z + basis.normal.z * distance
  };
  addFaceCarrierRole(
    candidates,
    planeCarrier(basis.normal, startOrigin),
    `sweep.face.cap.start.${objectId}`,
    assignments,
    diagnostics
  );
  addFaceCarrierRole(
    candidates,
    planeCarrier(basis.normal, endOrigin),
    `sweep.face.cap.end.${objectId}`,
    assignments,
    diagnostics
  );

  if (data.objectKind === 'circle') {
    const center = pointOnPlane(
      basis,
      {
        x: resolveParamValue(data.centerX, scope, 'center X'),
        y: resolveParamValue(data.centerY, scope, 'center Y')
      },
      0
    );
    const radius = resolveParamValue(data.radius, scope, 'radius');
    addFaceCarrierRole(
      candidates,
      cylinderCarrier(center, basis.normal, radius),
      `sweep.face.side.${objectId}.circle`,
      assignments,
      diagnostics
    );
    const endCenter = {
      x: center.x + basis.normal.x * distance,
      y: center.y + basis.normal.y * distance,
      z: center.z + basis.normal.z * distance
    };
    addEdgeWitnessRole(
      candidates,
      expectedCircleWitness(center, basis.normal, radius),
      `sweep.edge.cap.start.${objectId}.circle`,
      assignments,
      diagnostics
    );
    addEdgeWitnessRole(
      candidates,
      expectedCircleWitness(endCenter, basis.normal, radius),
      `sweep.edge.cap.end.${objectId}.circle`,
      assignments,
      diagnostics
    );
  } else {
    const localPoints = profilePoints(data, scope);
    const startPoints = localPoints.map((point) =>
      pointOnPlane(basis, point, 0)
    );
    const endPoints = startPoints.map((point) => ({
      x: point.x + basis.normal.x * distance,
      y: point.y + basis.normal.y * distance,
      z: point.z + basis.normal.z * distance
    }));
    const sweepDirection = scale(basis.normal, distance);
    for (let index = 0; index < startPoints.length; index += 1) {
      const next = (index + 1) % startPoints.length;
      const start = startPoints[index]!;
      const startNext = startPoints[next]!;
      const end = endPoints[index]!;
      const endNext = endPoints[next]!;
      const edgeDirection = subtract(startNext, start);
      addFaceCarrierRole(
        candidates,
        planeCarrier(cross(edgeDirection, sweepDirection), start),
        `sweep.face.side.${objectId}.${index}`,
        assignments,
        diagnostics
      );
      addEdgeWitnessRole(
        candidates,
        expectedLineWitness(start, startNext),
        `sweep.edge.cap.start.${objectId}.${index}`,
        assignments,
        diagnostics
      );
      addEdgeWitnessRole(
        candidates,
        expectedLineWitness(end, endNext),
        `sweep.edge.cap.end.${objectId}.${index}`,
        assignments,
        diagnostics
      );
      addEdgeWitnessRole(
        candidates,
        expectedLineWitness(start, end),
        `sweep.edge.side.${objectId}.vertex.${index}`,
        assignments,
        diagnostics
      );
    }
  }

  return mergeBrepKitLineageStates([
    createBrepKitSemanticLineage(feature.featureId, 'sweep', assignments),
    ...diagnostics
  ]);
}

function buildRevolveLineage(
  kernel: BrepKernel,
  solid: number,
  feature: FeatureNode,
  objectId: string,
  data: SketchObjectData,
  basis: PlaneBasis,
  axisDirection: Vec3,
  axisPoint: Vec3,
  scope: Record<string, number>
): BrepKitLineageState {
  const candidates = topologyCandidatesForSolid(kernel, solid);
  const assignments: BrepKitSemanticAssignment[] = [];
  const diagnostics: BrepKitLineageState[] = [];
  if (data.objectKind === 'circle') {
    addUniqueSemanticAssignment(
      candidates,
      'face',
      `sweep.face.side.${objectId}.circle`,
      (candidate) =>
        (candidate.witness as FaceWitnessV1).surfaceType === 'torus',
      assignments,
      diagnostics,
      'sweep'
    );
  } else {
    const points = profilePoints(data, scope).map((point) =>
      pointOnPlane(basis, point, 0)
    );
    const axis = normalized(axisDirection)!;
    const axisFoot = subtract(axisPoint, scale(axis, dot(axisPoint, axis)));
    const decomposition = (point: Vec3) => {
      const fromAxisPoint = subtract(point, axisPoint);
      const along = dot(fromAxisPoint, axis);
      const center = {
        x: axisPoint.x + axis.x * along,
        y: axisPoint.y + axis.y * along,
        z: axisPoint.z + axis.z * along
      };
      const radial = subtract(point, center);
      return {
        along,
        center,
        radial,
        radius: Math.hypot(radial.x, radial.y, radial.z)
      };
    };
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index]!;
      const next = points[(index + 1) % points.length]!;
      const a = decomposition(current);
      const b = decomposition(next);
      const sameRadial =
        samePoint(quantizedPoint(a.radial), quantizedPoint(b.radial)) &&
        quantizeCoordinate(a.radius) > 0;
      const sameAlong =
        quantizeCoordinate(a.along) === quantizeCoordinate(b.along);
      const carrier = sameRadial
        ? cylinderCarrier(axisFoot, axis, a.radius)
        : sameAlong
          ? planeCarrier(axis, a.center)
          : null;
      addFaceCarrierRole(
        candidates,
        carrier,
        `sweep.face.side.${objectId}.${index}`,
        assignments,
        diagnostics
      );
      if (quantizeCoordinate(a.radius) > 0) {
        addEdgeWitnessRole(
          candidates,
          expectedCircleWitness(a.center, axis, a.radius),
          `sweep.edge.profile.${objectId}.vertex.${index}`,
          assignments,
          diagnostics
        );
      }
    }
  }
  return mergeBrepKitLineageStates([
    createBrepKitSemanticLineage(feature.featureId, 'sweep', assignments),
    ...diagnostics
  ]);
}

/** The pre-ADR-011 BrepKit face scheme, kept only for persisted references. */
function legacyFaceFingerprint(kernel: BrepKernel, face: number): number {
  const centroid = faceVertexCentroid(kernel, face);
  const signature = [
    kernel.getSurfaceType(face),
    quantizeEdgeCoordinate(
      Math.sqrt(Math.max(kernel.faceArea(face, MEASUREMENT_DEFLECTION), 0))
    ),
    analyticParamsSignature(kernel, face),
    centroid
      ? [centroid.x, centroid.y, centroid.z]
          .map(quantizeEdgeCoordinate)
          .join(',')
      : 'nc'
  ].join(':');
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  return unsigned === 0 ? 1 : unsigned;
}

function faceHandlesByFingerprint(
  kernel: BrepKernel,
  solid: number
): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (const face of kernel.getSolidFaces(solid)) {
    const hash = faceFingerprint(kernel, face);
    registerHandle(result, hash, face);
    const legacy = legacyFaceFingerprint(kernel, face);
    if (legacy !== hash) {
      registerHandle(result, legacy, face);
    }
  }
  return result;
}

function resolveShellOpeningFaces(
  kernel: BrepKernel,
  shape: ExactShape,
  hashes: readonly number[],
  references: readonly FaceTopologyReferenceV5[] | undefined
): number[] {
  if (shape.solids.length !== 1) {
    throw new Error('Shell requires a body containing exactly one solid.');
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
        throw new Error(`Shell opening face is stale: ${resolution.message}`);
      }
      if (typeof resolution.candidate.value !== 'number') {
        throw new Error('Shell opening face resolved without a kernel handle.');
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
    throw new Error('Shell opening faces do not resolve to a unique set.');
  }
  return resolved;
}

/** Best-effort analytic measurements surfaced to the UI as FaceGeometry. */
function measureFaceGeometry(
  kernel: BrepKernel,
  face: number
): FaceGeometry | undefined {
  const surfaceType = kernel.getSurfaceType(face);
  const centroid = faceVertexCentroid(kernel, face);
  const geometry: FaceGeometry = {
    surfaceType,
    area: kernel.faceArea(face, MEASUREMENT_DEFLECTION),
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
    } catch {
      // NURBS-backed planes have no analytic normal; leave it unset.
    }
    return geometry;
  }
  if (surfaceType !== 'cylinder') {
    return geometry;
  }
  let parameters: unknown;
  try {
    parameters = JSON.parse(kernel.getAnalyticSurfaceParams(face));
  } catch {
    return geometry;
  }
  const record = (parameters ?? {}) as Record<string, unknown>;
  const origin = finiteVec3(record.origin);
  const rawAxis = finiteVec3(record.axis);
  const axis = rawAxis ? normalized(rawAxis) : null;
  const radius = record.radius;
  if (
    !origin ||
    !axis ||
    typeof radius !== 'number' ||
    !Number.isFinite(radius) ||
    radius <= GEOMETRY_EPSILON
  ) {
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
  kernel: BrepKernel,
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
 * them. BrepKit has no such flag (`getShapeOrientation` documents that every
 * face reports `forward`, and a cylinder's parametric normal points away from
 * the axis whether it walls a bore or a boss), so the same distinction is
 * taken from the material itself: just outside a bore's wall is solid, just
 * outside an outer wall is air. Everything else — full revolution, void
 * along the axis, both ends open — mirrors the OpenCascade classifier.
 *
 * A case that cannot be settled is refused by name rather than guessed at.
 */
function classifyThroughHoleFace(
  kernel: BrepKernel,
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
  kernel: BrepKernel,
  solid: number,
  face: number
): FaceGeometry | undefined {
  const geometry = measureFaceGeometry(kernel, face);
  if (
    geometry?.surfaceType === 'cylinder' &&
    classifyThroughHoleFace(kernel, solid, face, geometry).status ===
      'through-hole'
  ) {
    geometry.featureType = 'through-hole';
    geometry.editableDimension = 'diameter';
  }
  return geometry;
}

/**
 * Re-validate that the resolved face is still the through-hole the operation
 * was recorded against. A rebuild that drifted must fail here rather than
 * resize whichever face happened to inherit the fingerprint.
 */
function requireThroughHole(
  kernel: BrepKernel,
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
  kernel: BrepKernel,
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
 * BrepKit's boolean drops to a co-refined mesh when its general face assembly
 * will not accept the result, and closing a hole — collapsing a handle in the
 * body — is a configuration it declines often enough to matter. A mesh result
 * still encloses roughly the right space, so it is caught by counting faces
 * instead of measuring volume: a real fill deletes the bore and merges its two
 * openings back into their host faces, while the mesh fallback replaces every
 * analytic surface with a fan of triangles and multiplies the face count.
 */
function fillThroughHole(
  kernel: BrepKernel,
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
  kernel: BrepKernel,
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
  kernel: BrepKernel,
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
  kernel: BrepKernel,
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
  kernel: BrepKernel,
  shape: ExactShape,
  matrix: Float64Array
): ExactShape {
  const solids: number[] = [];
  if (!shape.lineage) {
    return {
      solids: shape.solids.map((solid) =>
        kernel.copyAndTransformSolid(solid, matrix)
      ),
      lineage: brepKitHashOnlyLineage(
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
    const source: BrepKitLineageState = {
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
    return propagateBrepKitRigidTransformLineage(
      source,
      topologyCandidatesForSolid(kernel, resultSolid),
      Array.from(matrix)
    );
  });
  return { solids, lineage: mergeBrepKitLineageStates(lineages) };
}

function projectBrepKitLineageDiagnostic(
  diagnostic: BrepKitLineageState['diagnostics'][number]
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
 * BrepKit's STL importer emits one face per triangle and does not share edges
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
function importMeshSolid(kernel: BrepKernel, stlText: string): number {
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
      | string
      | { solid?: number };
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
}

function collapseShape(kernel: BrepKernel, shape: ExactShape): number {
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
 * BrepKit unifies only faces on the same underlying surface, so real part
 * boundaries, holes, blends, and sharp corners remain intact.
 */
function unifyBooleanFaces(kernel: BrepKernel, solid: number): number {
  kernel.unifyFaces(solid);
  return solid;
}

function unifyUnionFaces(kernel: BrepKernel, solid: number): number {
  return selectSafelyUnifiedSolid(kernel, solid, (candidate) =>
    isStrictBooleanSolid(kernel, candidate)
  );
}

function fuseUniformSolid(kernel: BrepKernel, solids: number[]): number {
  const fused = kernel.fuseAll(Uint32Array.from(solids));
  return unifyUnionFaces(kernel, fused);
}

/**
 * Face unification is allowed to replace the raw Union only when the copied
 * result remains a strict topological solid. The final Union acceptance gate
 * below separately checks its disposable viewport projection.
 */
function isStrictBooleanSolid(kernel: BrepKernel, solid: number): boolean {
  try {
    return kernel.validateSolid(solid) === 0;
  } catch {
    return false;
  }
}

function isFaceConnectedSolid(kernel: BrepKernel, solid: number): boolean {
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

export class BrepKitKernelAdapter implements ExactKernelAdapter {
  readonly kind = 'brepkit' as const;

  private resolveSketchBasisAtHistory(
    kernel: BrepKernel,
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
    kernel: BrepKernel,
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
    kernel: BrepKernel,
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
   * wires from the region's line/arc curves. No tessellation — arcs become
   * true circular edges, so STEP export keeps analytic surfaces.
   */
  private makeRegionFace(
    kernel: BrepKernel,
    region: SketchRegion,
    basis: PlaneBasis
  ): number {
    const wireFor = (loop: SketchRegion['outer']): number => {
      const edges: number[] = [];
      for (const curve of loop.curves) {
        if (curve.kind === 'line') {
          const a = BrepKitKernelAdapter.planePoint3(basis, curve.a);
          const b = BrepKitKernelAdapter.planePoint3(basis, curve.b);
          edges.push(kernel.makeLineEdge(a.x, a.y, a.z, b.x, b.y, b.z));
          continue;
        }
        const span = Math.abs(curve.endAngle - curve.startAngle);
        const center = BrepKitKernelAdapter.planePoint3(basis, curve.center);
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
          const start = BrepKitKernelAdapter.planePoint3(basis, {
            x: curve.center.x + Math.cos(angleA) * curve.radius,
            y: curve.center.y + Math.sin(angleA) * curve.radius
          });
          const end = BrepKitKernelAdapter.planePoint3(basis, {
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

    const face = kernel.makePlanarFaceFromWire(wireFor(region.outer));
    if (region.holes.length === 0) {
      return face;
    }
    return kernel.addHolesToFace(
      face,
      Uint32Array.from(region.holes.map(wireFor))
    );
  }

  /** Extrude one or more explicitly selected bounded sketch cells. */
  private buildRegionExtrude(
    kernel: BrepKernel,
    document: ProjectDocument,
    sketch: SketchNode,
    feature: FeatureNode,
    data: Extract<FeatureNode['data'], { featureKind: 'extrude' }>,
    scope: Record<string, number>,
    basis: PlaneBasis
  ): ExactShape {
    const regions = resolveRegionProfiles(document, sketch, data, scope);
    const distance = resolveParamValue(data.distance, scope, 'distance');
    const groups = connectedRegionGroups(regions);
    const lineages: BrepKitLineageState[] = [];
    const solids = groups.map((group) => {
      const face = this.makeRegionFace(
        kernel,
        mergeAdjacentProfiles(group),
        basis
      );
      const solid = kernel.extrude(
        face,
        basis.normal.x,
        basis.normal.y,
        basis.normal.z,
        distance
      );
      const candidates = topologyCandidatesForSolid(kernel, solid);
      const assignments: BrepKitSemanticAssignment[] = [];
      const diagnostics: BrepKitLineageState[] = [];
      const sourceEntityIds = [
        ...new Set(group.flatMap((region) => region.sourceEntityIds))
      ].sort();
      const token = sourceEntityIds.join('+');
      if (token.length === 0) {
        diagnostics.push(
          brepKitHashOnlyLineage(
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
          brepKitHashOnlyLineage(
            'sweep',
            `Selected-region side topology ${token} has no one-to-one semantic curve mapping.`
          )
        );
      }
      lineages.push(
        mergeBrepKitLineageStates([
          createBrepKitSemanticLineage(feature.featureId, 'sweep', assignments),
          ...diagnostics
        ])
      );
      return solid;
    });
    return {
      solids,
      lineage: mergeBrepKitLineageStates(lineages)
    };
  }

  private buildSweep(
    kernel: BrepKernel,
    document: ProjectDocument,
    feature: FeatureNode,
    scope: Record<string, number>,
    sketchBases: ReadonlyMap<SketchId, PlaneBasis>
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
        basis
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
    const solid = kernel.revolve(
      face,
      point.x,
      point.y,
      point.z,
      direction.x,
      direction.y,
      direction.z,
      360
    );
    return {
      solids: [solid],
      lineage: buildRevolveLineage(
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
    };
  }

  private build(
    kernel: BrepKernel,
    document: ProjectDocument
  ): ExactBuildResult {
    const { scope, errors } = getParameterScope(document);
    const result: ExactBuildResult = {
      shapes: new Map(),
      sketchBases: new Map(),
      consumed: new Set(),
      importedStepDiagnostics: new Map(),
      meshBodies: new Set(),
      warnings: [...errors]
    };

    for (const feature of listFeaturesInOrder(document)) {
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
                lineage: brepKitHashOnlyLineage(
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
              scope
            );
            edited.lineage = brepKitHashOnlyLineage(
              'direct-edit',
              'BrepKit does not expose a complete direct-edit output relation.'
            );
            result.shapes.set(feature.data.targetBodyId, edited);
            break;
          }
          case 'imported-step': {
            if (feature.bodyId) {
              const declared = Array.from(
                kernel.importStep(
                  new TextEncoder().encode(
                    normalizeStepPlaneAnglesForKernel(feature.data.stepText)
                  )
                )
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
              const solids = declared.filter(
                (_, index) => verdicts[index]!.kind !== 'not-a-solid'
              );
              const rejections = verdicts.flatMap((verdict) =>
                verdict.kind === 'not-a-solid' ? [verdict.reason] : []
              );
              if (solids.length === 0) {
                throw new Error(importedStepNoSolidError(rejections));
              }
              result.importedStepDiagnostics.set(feature.bodyId, {
                declaredSolidCount: declared.length,
                rejections,
                flagged: verdicts.flatMap((verdict) =>
                  verdict.kind === 'flagged' ? [verdict.reason] : []
                )
              });
              result.shapes.set(feature.bodyId, {
                solids,
                lineage: createBrepKitImportedStepLineage(
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
          case 'revolve':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.buildSweep(
                  kernel,
                  document,
                  feature,
                  scope,
                  result.sketchBases
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
            const operations = createBrepKitModelingOperations(kernel);
            result.shapes.set(feature.bodyId, {
              solids: target.solids.map((targetSolid) =>
                operations.mirror({ targetSolid, planePoint, planeNormal })
              ),
              lineage: brepKitHashOnlyLineage(
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
            const openingFaces = resolveShellOpeningFaces(
              kernel,
              target,
              feature.data.openingFaceHashes,
              feature.data.openingFaceReferences
            );
            const thickness = resolveParamValue(
              feature.data.thickness,
              scope,
              'shell thickness'
            );
            const solid = createBrepKitModelingOperations(kernel).shell({
              targetSolid: target.solids[0]!,
              thickness,
              openingFaces
            });
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(feature.bodyId, {
              solids: [solid],
              lineage: brepKitHashOnlyLineage(
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
            const operations = createBrepKitModelingOperations(kernel);
            const solids = target.solids.map((targetSolid) =>
              operations.offsetSolid({ targetSolid, distance })
            );
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(feature.bodyId, {
              solids,
              lineage: brepKitHashOnlyLineage(
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
            let solid: number;
            if (feature.data.operation === 'union') {
              const unionSolids = operands.flatMap((shape) => shape.solids);
              const connectivity = analyzeUnionConnectivity(
                unionSolids.map((candidate) => {
                  const bounds = kernel.boundingBox(candidate);
                  return {
                    solid: candidate,
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
                }),
                (left, right) =>
                  kernel.solidToSolidDistance(left, right)[0] ?? NaN,
                (left, right) => {
                  try {
                    return (
                      kernel.volume(
                        kernel.intersect(left, right),
                        MEASUREMENT_DEFLECTION
                      ) > 0
                    );
                  } catch {
                    return false;
                  }
                }
              );
              solid = fuseUniformSolid(kernel, unionSolids);
              if (
                !connectivity.connected &&
                !isFaceConnectedSolid(kernel, solid)
              ) {
                result.warnings.push(
                  `Feature "${feature.name}": ${disconnectedUnionWarning(
                    connectivity,
                    document.units
                  )}`
                );
              }
            } else {
              solid = collapseShape(kernel, operands[0]!);
              for (const operand of operands.slice(1)) {
                const tool = collapseShape(kernel, operand);
                solid =
                  feature.data.operation === 'subtract'
                    ? (tryExactCoaxialCylinderCut(kernel, solid, tool) ??
                      kernel.cut(solid, tool))
                    : kernel.intersect(solid, tool);
              }
              solid = unifyBooleanFaces(kernel, solid);
            }
            feature.data.targetBodyIds.forEach((bodyId) =>
              result.consumed.add(bodyId)
            );
            result.shapes.set(feature.bodyId, {
              solids: [solid],
              lineage: brepKitHashOnlyLineage(
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
            const requested = new Set(feature.data.edgeHashes);
            const edgeCount = kernel.getSolidEdges(target).length;
            const edgesByHash = edgeHandlesByFingerprint(kernel, target);
            const selected: number[] = [];
            for (const hash of requested) {
              const matches = edgesByHash.get(hash) ?? [];
              if (matches.length === 0) {
                throw unresolvedReferenceError('edge', hash, edgeCount);
              }
              if (matches.length > 1) {
                throw ambiguousReferenceError('edge');
              }
              selected.push(matches[0]!);
            }
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
            let modified: number;
            try {
              const targetBounds = kernel.boundingBox(target);
              if (feature.data.featureKind === 'fillet') {
                try {
                  modified = kernel.fillet(
                    target,
                    Uint32Array.from(selected),
                    size
                  );
                } catch {
                  modified = target;
                }
                if (modified === target) {
                  modified =
                    tryExactAnalyticCylinderRimFillet(
                      kernel,
                      target,
                      selected,
                      size
                    ) ?? target;
                }
              } else {
                modified = kernel.chamfer(
                  target,
                  Uint32Array.from(selected),
                  size
                );
              }
              // When a second blend cannot be attached to an existing NURBS
              // blend, BrepKit intentionally falls back to the input handle.
              // Treat that as a failed feature instead of reporting success.
              if (modified === target) {
                throw new Error('Edge modifier produced no geometric change.');
              }
              if (kernel.validateSolidRelaxed(modified) !== 0) {
                throw new Error('Edge modifier produced an invalid solid.');
              }
              if (feature.data.featureKind === 'fillet') {
                // A fillet rounds material inside the target envelope. BrepKit
                // can return a closed but severely distorted fallback for an
                // oversized radius, expanding the body to the requested size.
                // Reject that result rather than guessing a radius limit from
                // the selected edge's length: the valid limit is set by its
                // adjacent faces, and can be larger than half the edge length.
                const modifiedBounds = kernel.boundingBox(modified);
                const boundsScale = [0, 1, 2].reduce(
                  (maximum, axis) =>
                    Math.max(
                      maximum,
                      targetBounds[axis + 3]! - targetBounds[axis]!
                    ),
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
                  throw new Error(
                    'Fillet expanded beyond the target body bounds.'
                  );
                }
              }
            } catch {
              throw new Error(
                edgeModifierFailureMessage(
                  kernel,
                  target,
                  selected,
                  feature.data.featureKind,
                  size
                )
              );
            }
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(feature.bodyId, {
              solids: [modified],
              lineage: brepKitHashOnlyLineage(
                feature.data.featureKind,
                feature.data.featureKind === 'fillet'
                  ? 'The final production fillet, including analytic fallback results, has no reverified complete output relation.'
                  : 'BrepKit chamfer does not expose a complete generated-face provenance channel.'
              )
            });
            inheritMeshOrigin(
              result,
              feature.data.targetBodyId,
              feature.bodyId
            );
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
            result.shapes.set(feature.bodyId, { solids });
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
  private resolveFaceByFingerprint(
    kernel: BrepKernel,
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
   * which BrepKit frequently declines to do analytically. The extension past
   * both ends is OpenCascade's, so a hole through a slanted opening is trimmed
   * identically on either kernel.
   */
  private resizeThroughHole(
    kernel: BrepKernel,
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
   * OpenCascade does. Anything else goes to BrepKit's `defeature`, which
   * rebuilds the body from the planes of the faces it keeps and therefore
   * only accepts a body whose every remaining face is planar. That
   * precondition is checked before the call so an unsupported selection is
   * named rather than silently reassembled, and the reassembly itself is held
   * to strict solid validation because its failure mode is a closed-looking
   * body with the wrong walls.
   */
  private removeFaceFeature(
    kernel: BrepKernel,
    solid: number,
    face: number,
    geometry: FaceGeometry | undefined,
    operation: Extract<DirectEditOperation, { kind: 'remove-face-feature' }>
  ): number {
    if (geometry?.surfaceType !== operation.sourceSurfaceType) {
      throw new Error('Selected face no longer matches its recorded surface.');
    }
    // Face area comes from BrepKit's bounded-deflection integration rather
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
        `Removing a ${geometry.surfaceType} face needs BrepKit's defeature operation, which only supports bodies whose every remaining face is planar; this body still has ${[...nonPlanar].sort().join(', ')} faces.`
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
   * History-backed direct edits on the BrepKit path. Planar offsets and
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
    kernel: BrepKernel,
    target: ExactShape,
    operation: DirectEditOperation,
    scope: Record<string, number>
  ): ExactShape {
    const solid = collapseShape(kernel, target);
    const face = this.resolveFaceByFingerprint(
      kernel,
      solid,
      operation.faceHash
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
      const areaTolerance = Math.max(operation.sourceArea * 1e-5, 1e-9);
      if (Math.abs(geometry.area - operation.sourceArea) > areaTolerance) {
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
      const output =
        tryExactAnalyticCylinderCapOffset(kernel, solid, face, offset) ??
        kernel.pushPullFace(solid, face, offset);
      if (kernel.validateSolidRelaxed(output) !== 0) {
        throw new Error(
          `Offsetting the face by ${offset} does not produce a valid solid.`
        );
      }
      return { solids: [output] };
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
    kernel: BrepKernel,
    shape: ExactShape,
    strictBooleanValidation = false
  ): MeasuredShape {
    if (shape.solids.length === 0) {
      throw new Error('Exact body contains no solids.');
    }
    const vertices: number[] = [];
    const indices: number[] = [];
    const lineageDiagnostics =
      shape.lineage?.diagnostics.map(projectBrepKitLineageDiagnostic) ?? [];
    const topology: BodyTopology = { faces: [], edges: [] };
    const bbox = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity }
    };
    let volume = 0;
    let valid = true;
    let strictValid = true;

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
              message: `BrepKit face lineage ${reference.lineageName} no longer matches its exact measured witness.`
            });
          }
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
              message: `BrepKit edge lineage ${reference.lineageName} no longer matches its exact measured witness.`
            });
          }
          topology.edges.push({
            topologyId: `edge:${hash}`,
            hash,
            reference: verifiedReference,
            displayRole: brepEdgeDisplayRole(kernel, edge, edgeToFaces),
            points: edgePositions.slice(
              edgeOffsets[index],
              edgeOffsets[index + 1]
            )
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
    return {
      vertices,
      indices,
      topology,
      faceCount: topology.faces.length,
      volume,
      valid,
      strictValid,
      meshClosure,
      bbox
    };
  }

  async syncDocument(document: ProjectDocument): Promise<DerivedState> {
    const kernel = new BrepKernel();
    try {
      const build = this.build(kernel, document);
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
              'BrepKit'
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
          exportableStep: body.exportableStep,
          consumed,
          volume: measured.volume,
          bbox: measured.bbox,
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
        updatedAt: nowIso()
      };
    } finally {
      kernel.free();
    }
  }

  async exportStep(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<string> {
    const kernel = new BrepKernel();
    try {
      const build = this.build(kernel, document);
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
      return decodeText(
        kernel.exportStepMulti(new Uint32Array(exportSolids))
      );
    } finally {
      kernel.free();
    }
  }

  async exportStl(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<string> {
    const kernel = new BrepKernel();
    try {
      const build = this.build(kernel, document);
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
    const kernel = new BrepKernel();
    try {
      const sourceText =
        typeof data === 'string' ? data : decodeText(new Uint8Array(data));
      const bytes = new TextEncoder().encode(
        normalizeStepPlaneAnglesForKernel(sourceText)
      );
      let declared: number[];
      try {
        declared = Array.from(kernel.importStep(bytes));
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
    // Each operation owns and releases a short-lived BrepKernel instance, so
    // there is nothing adapter-scoped left to release.
  }
}

export async function createExactKernelAdapter(): Promise<ExactKernelAdapter> {
  return new HybridExactKernelAdapter();
}

function containsImportedStep(document: ProjectDocument): boolean {
  return listFeaturesInOrder(document).some(
    (feature) => feature.data.featureKind === 'imported-step'
  );
}

/**
 * BrepKit remains the fast native modeling kernel. Documents containing STEP
 * sources switch as a whole to OpenCascade so every downstream operation uses
 * the same faithful imported B-rep instead of mixing exact and reconstructed
 * geometry.
 */
class HybridExactKernelAdapter implements ExactKernelAdapter {
  readonly kind = 'hybrid' as const;
  private readonly brepkit = new BrepKitKernelAdapter();
  private occt: Promise<ExactKernelAdapter> | null = null;

  private getOcct(): Promise<ExactKernelAdapter> {
    this.occt ??= import('./occt-step').then(({ OcctStepKernelAdapter }) =>
      OcctStepKernelAdapter.create()
    );
    return this.occt;
  }

  async syncDocument(document: ProjectDocument): Promise<DerivedState> {
    return containsImportedStep(document)
      ? (await this.getOcct()).syncDocument(document)
      : this.brepkit.syncDocument(document);
  }

  async exportStep(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<string> {
    return containsImportedStep(document)
      ? (await this.getOcct()).exportStep(document, bodyIds)
      : this.brepkit.exportStep(document, bodyIds);
  }

  async exportStl(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<string> {
    return containsImportedStep(document)
      ? (await this.getOcct()).exportStl(document, bodyIds)
      : this.brepkit.exportStl(document, bodyIds);
  }

  async inspectStep(data: string | ArrayBuffer): Promise<{
    solid: boolean;
    valid: boolean;
    volume: number;
  }> {
    // Inspection reads a STEP payload in isolation, so it never needs the
    // document-wide OCCT reroute that `syncDocument` applies.
    return this.brepkit.inspectStep(data);
  }

  dispose(): void {
    this.brepkit.dispose();
    void this.occt?.then((adapter) => adapter.dispose());
  }
}
