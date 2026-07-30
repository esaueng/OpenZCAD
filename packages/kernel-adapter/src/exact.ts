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
  type FaceGeometry,
  type FeatureNode,
  type ProjectDocument,
  type SketchNode,
  type SketchObjectData
} from '@openzcad/shared';
import { displayTessellationForExtents } from './display-tessellation';
import { OpenZCADKernel } from './index';
import { connectedRegionGroups, resolveRegionProfiles } from './region-profile';
import { normalizeStepPlaneAnglesForKernel } from './step-import';
import {
  analyzeUnionConnectivity,
  disconnectedUnionWarning
} from './union-connectivity';
import {
  ambiguousReferenceError,
  canonicalDirection,
  cylinderAnalyticSignature,
  edgeFingerprintOf,
  faceFingerprintOf,
  isClosedEdge,
  planeAnalyticSignature,
  unresolvedReferenceError,
  type EdgeSample
} from './topology-fingerprint';

const MEASUREMENT_DEFLECTION = 0.08;
const STL_EXPORT_DEFLECTION = 0.08;
const CURVE_SEGMENTS = 32;
const GEOMETRY_EPSILON = 1e-9;
const ANALYTIC_MATCH_EPSILON = 1e-7;
const PERIODIC_SURFACE_TYPES = new Set(['cylinder', 'cone', 'sphere', 'torus']);

interface ExactShape {
  /** A body can contain several independent solids, as with a pattern. */
  solids: number[];
}

interface ExactBuildResult {
  shapes: Map<BodyId, ExactShape>;
  consumed: Set<BodyId>;
  warnings: string[];
}

interface MeasuredShape {
  vertices: number[];
  indices: number[];
  topology: BodyTopology;
  faceCount: number;
  volume: number;
  valid: boolean;
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
 * Build the same ZYX Euler transform used by the compatibility kernel and the
 * viewport gizmo. BrepKit accepts row-major matrices and column vectors.
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
      const flip =
        unit.x < 0 ||
        (unit.x === 0 && (unit.y < 0 || (unit.y === 0 && unit.z < 0)));
      const canonical = flip ? { x: -unit.x, y: -unit.y, z: -unit.z } : unit;
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

function fuseUniformSolid(kernel: BrepKernel, solids: number[]): number {
  const fused = kernel.fuseAll(Uint32Array.from(solids));
  return unifyBooleanFaces(kernel, fused);
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function containsImportedMesh(document: ProjectDocument): boolean {
  return listFeaturesInOrder(document).some(
    (feature) => feature.data.featureKind === 'imported-mesh'
  );
}

export class BrepKitKernelAdapter implements ExactKernelAdapter {
  readonly kind = 'brepkit' as const;
  private readonly legacy = new OpenZCADKernel();
  private stepCombiner: Promise<{
    combineStepSolids(parts: string[]): string;
    dispose(): void;
  }> | null = null;

  /**
   * BrepKit's STEP writer serializes exactly one solid, so multi-body exports
   * are assembled into a compound document by OpenCascade — loaded lazily,
   * only when a multi-body export happens.
   */
  private getStepCombiner(): NonNullable<typeof this.stepCombiner> {
    this.stepCombiner ??= import('./occt-step').then(
      ({ OcctStepKernelAdapter }) => OcctStepKernelAdapter.create()
    );
    return this.stepCombiner;
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
    data: Extract<FeatureNode['data'], { featureKind: 'primitive' }>,
    scope: Record<string, number>
  ): ExactShape {
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
    return { solids: [solid] };
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
    data: Extract<FeatureNode['data'], { featureKind: 'extrude' }>,
    scope: Record<string, number>
  ): ExactShape {
    const regions = resolveRegionProfiles(document, sketch, data, scope);
    const basis = frameForPlaneRef(sketch.planeRef, (value) =>
      resolveParamValue(value, scope, 'sketch offset')
    );
    const distance = resolveParamValue(data.distance, scope, 'distance');
    const solids = connectedRegionGroups(regions).map((group) => {
      const face = this.makeRegionFace(
        kernel,
        mergeAdjacentProfiles(group),
        basis
      );
      return kernel.extrude(
        face,
        basis.normal.x,
        basis.normal.y,
        basis.normal.z,
        distance
      );
    });
    return {
      solids
    };
  }

  private buildSweep(
    kernel: BrepKernel,
    document: ProjectDocument,
    feature: FeatureNode,
    scope: Record<string, number>
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
      return this.buildRegionExtrude(
        kernel,
        document,
        sketchNode,
        feature.data,
        scope
      );
    }
    const sketch = findSketch(document, feature.data.sketchId);
    const objectId = sketch?.objectIds[0];
    const object = objectId ? document.nodes[objectId] : undefined;
    if (!sketch || !object || object.kind !== 'sketch-object') {
      throw new Error('Referenced sketch has no profile.');
    }
    const basis = frameForPlaneRef(sketch.planeRef, (value) =>
      resolveParamValue(value, scope, 'sketch offset')
    );
    const face = this.makeProfileFace(kernel, object.data, basis, 0, scope);

    if (feature.data.featureKind === 'extrude') {
      const distance = resolveParamValue(
        feature.data.distance,
        scope,
        'distance'
      );
      return {
        solids: [
          kernel.extrude(
            face,
            basis.normal.x,
            basis.normal.y,
            basis.normal.z,
            distance
          )
        ]
      };
    }

    const direction = feature.data.axis === 'vertical' ? basis.v : basis.u;
    const point = pointOnPlane(basis, { x: 0, y: 0 }, 0);
    return {
      solids: [
        kernel.revolve(
          face,
          point.x,
          point.y,
          point.z,
          direction.x,
          direction.y,
          direction.z,
          360
        )
      ]
    };
  }

  private build(
    kernel: BrepKernel,
    document: ProjectDocument
  ): ExactBuildResult {
    const { scope, errors } = getParameterScope(document);
    const result: ExactBuildResult = {
      shapes: new Map(),
      consumed: new Set(),
      warnings: [...errors]
    };

    for (const feature of listFeaturesInOrder(document)) {
      try {
        switch (feature.data.featureKind) {
          case 'sketch':
            break;
          case 'imported-mesh':
            throw new Error('Legacy mesh bodies use the compatibility kernel.');
          case 'direct-edit': {
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Direct-edit target is unavailable.');
            }
            result.shapes.set(
              feature.data.targetBodyId,
              this.applyDirectEdit(
                kernel,
                target,
                feature.data.operation,
                scope
              )
            );
            break;
          }
          case 'imported-step': {
            if (feature.bodyId) {
              const solids = Array.from(
                kernel.importStep(
                  new TextEncoder().encode(
                    normalizeStepPlaneAnglesForKernel(feature.data.stepText)
                  )
                )
              );
              if (solids.length === 0) {
                throw new Error('STEP file contains no solids.');
              }
              result.shapes.set(feature.bodyId, { solids });
            }
            break;
          }
          case 'primitive':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.buildPrimitive(kernel, feature.data, scope)
              );
            }
            break;
          case 'extrude':
          case 'revolve':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.buildSweep(kernel, document, feature, scope)
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
              copyShape(
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
          case 'boolean': {
            if (!feature.bodyId || feature.data.targetBodyIds.length < 2) {
              throw new Error('Boolean requires at least two bodies.');
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
              if (!connectivity.connected) {
                result.warnings.push(
                  `Feature "${feature.name}": ${disconnectedUnionWarning(
                    connectivity,
                    document.units
                  )}`
                );
              }
              solid = fuseUniformSolid(kernel, unionSolids);
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
            result.shapes.set(feature.bodyId, { solids: [solid] });
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
            const label =
              feature.data.featureKind === 'fillet' ? 'Fillet' : 'Chamfer';
            const dimension =
              feature.data.featureKind === 'fillet' ? 'radius' : 'distance';
            const failureMessage = `${label} could not be created on ${selected.length} selected edge${selected.length === 1 ? '' : 's'} with ${dimension} ${size}. Try a smaller ${dimension}. Edges that end on an existing fillet or chamfer usually cannot be rounded afterwards — edit that earlier feature and add this edge to it instead.`;
            let modified: number;
            try {
              const targetBounds = kernel.boundingBox(target);
              modified =
                feature.data.featureKind === 'fillet'
                  ? kernel.fillet(target, Uint32Array.from(selected), size)
                  : kernel.chamfer(target, Uint32Array.from(selected), size);
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
              throw new Error(failureMessage);
            }
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(feature.bodyId, { solids: [modified] });
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
   * History-backed direct edits on the BrepKit path. Planar offsets and
   * cylindrical resizes are the kernel's own `pushPullFace` and
   * `resizeCylindricalFace`: each derives its tool from the selected face's
   * geometry, merges the seams the boolean leaves behind, and refuses any
   * result whose shell is not closed or whose volume is not the one the edit
   * is defined to produce. Every source measurement is re-validated against
   * the rebuilt body first, so a drifted rebuild fails closed instead of
   * editing the wrong face.
   */
  private applyDirectEdit(
    kernel: BrepKernel,
    target: ExactShape,
    operation: DirectEditOperation,
    scope: Record<string, number>
  ): ExactShape {
    if (
      operation.kind !== 'offset-face' &&
      operation.kind !== 'resize-cylindrical-face'
    ) {
      // resize-through-hole / remove-face-feature remain OCCT-only.
      throw new Error('Direct B-rep edits require the OpenCascade kernel.');
    }
    const solid = collapseShape(kernel, target);
    const face = this.resolveFaceByFingerprint(
      kernel,
      solid,
      operation.faceHash
    );
    const geometry = measureFaceGeometry(kernel, face);

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
    const coaxialRadii = Array.from(kernel.getSolidFaces(output)).flatMap(
      (handle) => {
        const measured = measureFaceGeometry(kernel, handle);
        if (
          measured?.surfaceType !== 'cylinder' ||
          measured.radius === undefined ||
          !measured.axisStart
        ) {
          return [];
        }
        const toAxis = subtract(measured.axisStart, geometry.axisStart!);
        const along = dot(toAxis, axisDir);
        return length(subtract(toAxis, scale(axisDir, along))) <= axisTolerance
          ? [measured.radius]
          : [];
      }
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

  private measureShape(kernel: BrepKernel, shape: ExactShape): MeasuredShape {
    if (shape.solids.length === 0) {
      throw new Error('Exact body contains no solids.');
    }
    const vertices: number[] = [];
    const indices: number[] = [];
    const topology: BodyTopology = { faces: [], edges: [] };
    const bbox = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity }
    };
    let volume = 0;
    let valid = true;

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
          const hash = faceFingerprint(kernel, handle);
          topology.faces.push({
            topologyId: `face:${hash}`,
            hash,
            triangleStart: (indexOffset + start) / 3,
            triangleCount: (end - start) / 3,
            geometry: measureFaceGeometry(kernel, handle)
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
          const hash = edgeFingerprint(kernel, edge);
          topology.edges.push({
            topologyId: `edge:${hash}`,
            hash,
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
    }

    return {
      vertices,
      indices,
      topology,
      faceCount: topology.faces.length,
      volume,
      valid,
      bbox
    };
  }

  async syncDocument(document: ProjectDocument): Promise<DerivedState> {
    if (containsImportedMesh(document)) {
      return this.legacy.syncDocument(document);
    }

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
        const measured = this.measureShape(kernel, shape);
        const consumed = build.consumed.has(bodyId);
        if (!measured.valid) {
          build.warnings.push(
            `Body "${body.name}" failed exact B-rep validation.`
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
      if (exportSolids.length === 1) {
        return decodeText(kernel.exportStep(exportSolids[0]!));
      }
      // Never fuse: a boolean union changes the geometry (overlaps merge,
      // coincident faces weld). Export each solid and compound them.
      const parts = exportSolids.map((solid) =>
        decodeText(kernel.exportStep(solid))
      );
      return (await this.getStepCombiner()).combineStepSolids(parts);
    } finally {
      kernel.free();
    }
  }

  async exportStl(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<string> {
    if (containsImportedMesh(document)) {
      return this.legacy.exportStl(document, bodyIds);
    }
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

  async inspectStep(data: string | ArrayBuffer): Promise<{
    solid: boolean;
    valid: boolean;
    volume: number;
  }> {
    const kernel = new BrepKernel();
    try {
      const sourceText =
        typeof data === 'string' ? data : decodeText(new Uint8Array(data));
      const bytes = new TextEncoder().encode(
        normalizeStepPlaneAnglesForKernel(sourceText)
      );
      const solids = Array.from(kernel.importStep(bytes));
      return {
        solid: solids.length > 0,
        valid:
          solids.length > 0 &&
          solids.every((solid) => kernel.validateSolidRelaxed(solid) === 0),
        volume: solids.reduce(
          (total, solid) =>
            total + kernel.volume(solid, MEASUREMENT_DEFLECTION),
          0
        )
      };
    } finally {
      kernel.free();
    }
  }

  dispose(): void {
    // Each operation owns and releases a short-lived BrepKernel instance.
    void this.stepCombiner?.then((combiner) => combiner.dispose());
    this.stepCombiner = null;
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
    return (await this.getOcct()).inspectStep(data);
  }

  dispose(): void {
    this.brepkit.dispose();
    void this.occt?.then((adapter) => adapter.dispose());
  }
}
