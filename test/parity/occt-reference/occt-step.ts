/**
 * The OpenCascade reference adapter — the parity corpus's second opinion.
 *
 * This is NOT a production path and has not been one since Z3, which routed
 * every document, imported STEP included, through BrepKit. Z5 deleted the
 * last of OpenCascade from `packages/kernel-adapter` and moved this cluster
 * here, next to the only thing that still runs it: `corpus.spec.ts` measures
 * every corpus file and every import-modeling scenario through BOTH this
 * adapter and BrepKit, and `corpus-pins.ts` is the record of where they
 * differ. `generate.spec.ts` also authors two corpus fixtures with it, which
 * is the only way to get a genuinely OCCT-written STEP file to import.
 *
 * It deliberately no longer implements `ExactKernelAdapter`. Structural
 * conformance to the production interface would say this is a kernel the app
 * could be pointed at; it is not, and the corpus consumes it through
 * `MeasurableAdapter` instead. `occt-wasm` is a root devDependency for the
 * same reason — available to tests, absent from anything shipped.
 *
 * If keeping this comparison ever costs more than it catches, retiring it is
 * its own small decision: delete this directory, the OCCT kernel column in
 * `corpus.spec.ts`, and the `occt:` side of each pin. The baselines and the
 * closed-form reference bar survive that on their own.
 */
import { OcctKernel, type ShapeHandle } from 'occt-wasm';
import occtWasmUrl from 'occt-wasm/dist/occt-wasm.wasm?url';
import {
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  listNodesByKind,
  resolveParamValue
} from '@openzcad/document-core';
import {
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
import {
  DEFAULT_BODY_COLOR,
  UNIT_TO_MM,
  featureColor,
  nowIso,
  type BodyId,
  type BodyRepresentation,
  type BodyTopology,
  type DirectEditOperation,
  type DerivedState,
  type FaceAnalyticWitnessV1,
  type FaceGeometry,
  type FaceWitnessV1,
  type FeatureNode,
  type ProjectDocument,
  type SketchId,
  type SketchNode,
  type SketchObjectData
} from '@openzcad/shared';
import { displayTessellationForExtents } from '../../../packages/kernel-adapter/src/display-tessellation';
import { importedMeshStl } from '../../../packages/kernel-adapter/src/imported-mesh';
import { connectedRegionGroups, resolveRegionProfiles } from '../../../packages/kernel-adapter/src/region-profile';
import {
  bezierProfileEdgesEnabled,
  flattenBezierCurve,
  flattenedOutlineWarning
} from '../../../packages/kernel-adapter/src/profile-bezier-edges';
import {
  analyzeUnionConnectivity,
  disconnectedUnionWarning
} from '../../../packages/kernel-adapter/src/union-connectivity';
import {
  ambiguousReferenceError,
  isClosedEdge,
  quantizeCoordinate,
  unresolvedReferenceError
} from '../../../packages/kernel-adapter/src/topology-fingerprint';
import {
  mirrorOcctSolid,
  offsetOcctSolid,
  resizeOcctAnalyticCylinder,
  shellOcctSolid
} from './occt-modeling-operations';
import {
  canonicalClosedEdgeWitness,
  canonicalCylinderWitness,
  canonicalOpenEdgeWitness,
  canonicalPlaneWitness,
  edgeCandidate as occtEdgeCandidate,
  faceCandidate as occtFaceCandidate,
  hashOnlyOcctLineage,
  importedStepLineage,
  occtSurfaceClosure,
  propagateRigidTransformLineage,
  quantizedTopologyPoint,
  referenceForOcctCandidate,
  resolveOcctTopologyReference,
  semanticPrimitiveLineage,
  semanticSweepLineage,
  type OcctLineageState,
  type OcctTopologyCandidate,
  type SweepSemanticDescriptor
} from './occt-lineage';
import {
  resolveFaceAttachment,
  type FaceAttachmentCandidate
} from '../../../packages/kernel-adapter/src/face-attachment';
import { importedStepValidationWarning } from '../../../packages/kernel-adapter/src/imported-step-validation';

const TESSELLATION_DEFLECTION = 0.08;
const GEOMETRY_EPSILON = 1e-9;
const DIRECT_EDIT_TOLERANCE = 1e-6;
const FULL_REVOLUTION = Math.PI * 2;
const TOPOLOGY_HASH_UPPER_BOUND = 2_147_483_647;
const PERIODIC_SURFACE_TYPES = new Set(['cylinder', 'cone', 'sphere', 'torus']);

function uniformScaleTransform(factor: number): number[] {
  return [factor, 0, 0, 0, 0, factor, 0, 0, 0, 0, factor, 0];
}

interface OcctBuildResult {
  shapes: Map<BodyId, ShapeHandle>;
  lineages: Map<BodyId, OcctLineageState>;
  sketchBases: Map<SketchId, PlaneBasis>;
  consumed: Set<BodyId>;
  warnings: string[];
}

interface ThroughHoleGeometry extends FaceGeometry {
  radius: number;
  diameter: number;
  axisStart: Vec3;
  axisEnd: Vec3;
  axialLength: number;
  featureType: 'through-hole';
  editableDimension: 'diameter';
}

function occtEdgeFaceAdjacency(
  kernel: OcctKernel,
  owner: ShapeHandle
): Map<number, Set<number>> {
  const flat = kernel.edgeToFaceMap(owner, TOPOLOGY_HASH_UPPER_BOUND);
  const adjacency = new Map<number, Set<number>>();
  for (let index = 0; index < flat.length;) {
    const edgeHash = flat[index++];
    const faceCount = flat[index++];
    if (
      edgeHash === undefined ||
      faceCount === undefined ||
      !Number.isInteger(faceCount) ||
      faceCount < 0 ||
      index + faceCount > flat.length
    ) {
      throw new Error('OCCT returned an invalid edge-to-face map.');
    }
    const owners = adjacency.get(edgeHash) ?? new Set<number>();
    for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
      owners.add(flat[index++]!);
    }
    adjacency.set(edgeHash, owners);
  }
  return adjacency;
}

function occtEdgeDisplayRole(
  kernel: OcctKernel,
  edge: ShapeHandle,
  edgeToFaces: Map<number, Set<number>>,
  faceTypesByHash: Map<number, Set<string>>
): 'feature' | 'seam' {
  const edgeHash = kernel.hashCode(edge, TOPOLOGY_HASH_UPPER_BOUND);
  const owners = edgeToFaces.get(edgeHash);
  if (!owners || owners.size !== 1) {
    return 'feature';
  }
  const ownerTypes = faceTypesByHash.get([...owners][0]!);
  return ownerTypes?.size === 1 &&
    PERIODIC_SURFACE_TYPES.has([...ownerTypes][0]!)
    ? 'seam'
    : 'feature';
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

function length(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalized(vector: Vec3): Vec3 | null {
  const magnitude = length(vector);
  return magnitude > GEOMETRY_EPSILON ? scale(vector, 1 / magnitude) : null;
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x
  };
}

function midpoint(left: Vec3, right: Vec3): Vec3 {
  return scale(add(left, right), 0.5);
}

function dot(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

/** OpenCascade's curve vocabulary mapped onto BrepKit's persisted names. */
const CURVE_TYPE_NAMES: Record<string, string> = {
  line: 'LINE',
  circle: 'CIRCLE',
  ellipse: 'ELLIPSE',
  bspline: 'BSPLINE_CURVE'
};

/** Exact ADR-011 edge witness from OpenCascade queries. */
function edgeTopologyCandidate(
  kernel: OcctKernel,
  edge: ShapeHandle
): Extract<OcctTopologyCandidate, { kind: 'edge' }> {
  const rawType = kernel.curveType(edge);
  const curveType = CURVE_TYPE_NAMES[rawType] ?? rawType.toUpperCase();
  const curveLength = kernel.curveLength(edge);
  const { first, last } = kernel.curveParameters(edge);
  const span = last - first;
  const vertices = kernel
    .getSubShapes(edge, 'vertex')
    .map((vertex) => kernel.vertexPosition(vertex));
  const start = vertices[0] ?? kernel.curvePointAtParam(edge, first);
  const end = vertices[1] ?? start;
  if (!isClosedEdge(start, end)) {
    return occtEdgeCandidate(
      canonicalOpenEdgeWitness({
        curveType,
        length: curveLength,
        endpoints: [start, end],
        midpoint: kernel.curvePointAtParam(edge, first + span / 2)
      })
    );
  }
  const center = { x: 0, y: 0, z: 0 };
  for (let sample = 0; sample < 4; sample += 1) {
    const point = kernel.curvePointAtParam(edge, first + (span * sample) / 4);
    center.x += point.x / 4;
    center.y += point.y / 4;
    center.z += point.z / 4;
  }
  const axis = normalized(
    cross(
      kernel.curveTangent(edge, first),
      kernel.curveTangent(edge, first + span / 4)
    )
  );
  return occtEdgeCandidate(
    canonicalClosedEdgeWitness({
      curveType,
      length: curveLength,
      center,
      axis
    })
  );
}

function edgeFingerprint(kernel: OcctKernel, edge: ShapeHandle): number {
  return edgeTopologyCandidate(kernel, edge).currentHash;
}

/** Exact ADR-011 face witness from OpenCascade queries. */
function faceTopologyCandidate(
  kernel: OcctKernel,
  face: ShapeHandle
): Extract<OcctTopologyCandidate, { kind: 'face' }> {
  const surfaceType = kernel.surfaceType(face);
  let perimeter = 0;
  for (const edge of kernel.getSubShapes(face, 'edge')) {
    perimeter += kernel.curveLength(edge);
  }
  const vertices = kernel.getSubShapes(face, 'vertex');
  let centroid: Vec3 | null = null;
  if (vertices.length > 0) {
    centroid = { x: 0, y: 0, z: 0 };
    for (const vertex of vertices) {
      const position = kernel.vertexPosition(vertex);
      centroid.x += position.x / vertices.length;
      centroid.y += position.y / vertices.length;
      centroid.z += position.z / vertices.length;
    }
  }
  let analytic: FaceAnalyticWitnessV1 = { kind: 'none' };
  if (surfaceType === 'plane') {
    const bounds = kernel.uvBounds(face);
    const u = (bounds.uMin + bounds.uMax) / 2;
    const v = (bounds.vMin + bounds.vMax) / 2;
    const normal = normalized(kernel.surfaceNormal(face, u, v));
    if (normal) {
      analytic = canonicalPlaneWitness(
        normal,
        dot(normal, kernel.pointOnSurface(face, u, v))
      );
    }
  } else if (surfaceType === 'cylinder') {
    const cylinder = kernel.getFaceCylinderData(face);
    const bounds = kernel.uvBounds(face);
    const base = kernel.pointOnSurface(face, bounds.uMin, bounds.vMin);
    const top = kernel.pointOnSurface(face, bounds.uMin, bounds.vMax);
    const axis = normalized(subtract(top, base));
    if (cylinder && axis) {
      // Opposite points on a cylindrical section average to an axis point,
      // independent of where the face's uv patch sits on the surface.
      const opposite = kernel.pointOnSurface(
        face,
        bounds.uMin + Math.PI,
        bounds.vMin
      );
      analytic = canonicalCylinderWitness(
        midpoint(base, opposite),
        axis,
        cylinder.radius
      );
    }
  }
  const witness: FaceWitnessV1 = {
    surfaceType,
    perimeter: quantizeCoordinate(perimeter),
    centroid: centroid ? quantizedTopologyPoint(centroid) : null,
    analytic,
    closure: occtSurfaceClosure(surfaceType)
  };
  return occtFaceCandidate(witness);
}

function faceFingerprint(kernel: OcctKernel, face: ShapeHandle): number {
  return faceTopologyCandidate(kernel, face).currentHash;
}

function topologyCandidatesForShape(
  kernel: OcctKernel,
  shape: ShapeHandle
): OcctTopologyCandidate[] {
  return [
    ...kernel
      .getSubShapes(shape, 'face')
      .map((face) => faceTopologyCandidate(kernel, face)),
    ...kernel
      .getSubShapes(shape, 'edge')
      .map((edge) => edgeTopologyCandidate(kernel, edge))
  ];
}

function edgeHandlesByFingerprint(
  kernel: OcctKernel,
  edges: ShapeHandle[]
): Map<number, ShapeHandle[]> {
  const result = new Map<number, ShapeHandle[]>();
  for (const edge of edges) {
    const hash = edgeFingerprint(kernel, edge);
    const handles = result.get(hash) ?? [];
    handles.push(edge);
    result.set(hash, handles);
  }
  return result;
}

function cylinderFrame(origin: Vec3, zAxis: Vec3): number[] {
  const reference =
    Math.abs(zAxis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const xAxis = normalized(cross(reference, zAxis));
  if (!xAxis) {
    throw new Error('Could not construct a cylindrical feature frame.');
  }
  const yAxis = cross(zAxis, xAxis);
  return [
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
    origin.z
  ];
}

/** Measure a face without inferring editable feature semantics from a mesh. */
function faceGeometry(
  kernel: OcctKernel,
  owner: ShapeHandle,
  face: ShapeHandle
): FaceGeometry {
  const surfaceType = kernel.surfaceType(face);
  const geometry: FaceGeometry = {
    surfaceType,
    area: kernel.getSurfaceArea(face),
    center: kernel.getSurfaceCenterOfMass(face)
  };
  if (surfaceType === 'plane') {
    const bounds = kernel.uvBounds(face);
    const normal = normalized(
      kernel.surfaceNormal(
        face,
        (bounds.uMin + bounds.uMax) / 2,
        (bounds.vMin + bounds.vMax) / 2
      )
    );
    if (normal) {
      geometry.normal = normal;
    }
    return geometry;
  }
  if (surfaceType !== 'cylinder') {
    return geometry;
  }

  const cylinder = kernel.getFaceCylinderData(face);
  if (!cylinder || cylinder.radius <= GEOMETRY_EPSILON) {
    return geometry;
  }
  geometry.radius = cylinder.radius;
  geometry.diameter = cylinder.radius * 2;

  const bounds = kernel.uvBounds(face);
  const uSpan = Math.abs(bounds.uMax - bounds.uMin);
  if (Math.abs(uSpan - FULL_REVOLUTION) > 1e-5) {
    return geometry;
  }

  // Opposite points on a complete cylindrical section average to its axis.
  // This is independent of the face orientation (inside hole vs outside boss).
  const oppositeU = bounds.uMin + Math.PI;
  const axisStart = midpoint(
    kernel.pointOnSurface(face, bounds.uMin, bounds.vMin),
    kernel.pointOnSurface(face, oppositeU, bounds.vMin)
  );
  const axisEnd = midpoint(
    kernel.pointOnSurface(face, bounds.uMin, bounds.vMax),
    kernel.pointOnSurface(face, oppositeU, bounds.vMax)
  );
  const axisVector = subtract(axisEnd, axisStart);
  const axis = normalized(axisVector);
  const axialLength = length(axisVector);
  if (!axis || axialLength <= GEOMETRY_EPSILON) {
    return geometry;
  }
  geometry.axisStart = axisStart;
  geometry.axisEnd = axisEnd;
  geometry.axialLength = axialLength;

  const center = midpoint(axisStart, axisEnd);
  const probe = Math.max(
    DIRECT_EDIT_TOLERANCE * 10,
    cylinder.radius * 0.02,
    axialLength * 0.01
  );
  const centerIsVoid = !kernel.containsPoint(
    owner,
    center,
    DIRECT_EDIT_TOLERANCE
  );
  const opensBefore = !kernel.containsPoint(
    owner,
    subtract(axisStart, scale(axis, probe)),
    DIRECT_EDIT_TOLERANCE
  );
  const opensAfter = !kernel.containsPoint(
    owner,
    add(axisEnd, scale(axis, probe)),
    DIRECT_EDIT_TOLERANCE
  );
  // A hollow body's outer cylinder shares the same void axis and open ends.
  // Face orientation distinguishes that exterior wall (forward) from the
  // material-facing wall of the actual bore (reversed).
  const facesMaterialIntoAxis = kernel.shapeOrientation(face) === 'reversed';
  if (facesMaterialIntoAxis && centerIsVoid && opensBefore && opensAfter) {
    geometry.featureType = 'through-hole';
    geometry.editableDimension = 'diameter';
  }
  return geometry;
}

function faceAttachmentCandidatesForShape(
  kernel: OcctKernel,
  shape: ShapeHandle,
  lineage: OcctLineageState | undefined
): FaceAttachmentCandidate[] {
  return kernel.getSubShapes(shape, 'face').map((face) => {
    const candidate = faceTopologyCandidate(kernel, face);
    const reference = referenceForOcctCandidate(lineage, candidate);
    const geometry = faceGeometry(kernel, shape, face);
    const plane =
      geometry.surfaceType.toLowerCase() === 'plane' && geometry.normal
        ? { center: geometry.center, normal: geometry.normal }
        : null;
    return {
      ...candidate,
      witnessVersion: 1 as const,
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
  });
}

function requireThroughHole(
  kernel: OcctKernel,
  owner: ShapeHandle,
  face: ShapeHandle,
  sourceDiameter?: number,
  sourceAxisStart?: Vec3,
  sourceAxisEnd?: Vec3
): ThroughHoleGeometry {
  const geometry = faceGeometry(kernel, owner, face);
  if (
    geometry.featureType !== 'through-hole' ||
    geometry.editableDimension !== 'diameter' ||
    geometry.radius === undefined ||
    geometry.diameter === undefined ||
    !geometry.axisStart ||
    !geometry.axisEnd ||
    geometry.axialLength === undefined
  ) {
    throw new Error('Selected face is not a complete through-hole cylinder.');
  }
  if (
    sourceDiameter !== undefined &&
    Math.abs(geometry.diameter - sourceDiameter) >
      Math.max(DIRECT_EDIT_TOLERANCE, sourceDiameter * 1e-6)
  ) {
    throw new Error(
      'Selected face no longer matches its recorded source diameter.'
    );
  }
  if (sourceAxisStart && sourceAxisEnd) {
    const axisTolerance = Math.max(
      DIRECT_EDIT_TOLERANCE,
      geometry.axialLength * 1e-6,
      geometry.radius * 1e-6
    );
    const sameDirection =
      length(subtract(geometry.axisStart, sourceAxisStart)) <= axisTolerance &&
      length(subtract(geometry.axisEnd, sourceAxisEnd)) <= axisTolerance;
    const reversedDirection =
      length(subtract(geometry.axisStart, sourceAxisEnd)) <= axisTolerance &&
      length(subtract(geometry.axisEnd, sourceAxisStart)) <= axisTolerance;
    if (!sameDirection && !reversedDirection) {
      throw new Error(
        'Selected face no longer matches its recorded hole axis.'
      );
    }
  }
  return geometry as ThroughHoleGeometry;
}

function cylinderAlongAxis(
  kernel: OcctKernel,
  start: Vec3,
  end: Vec3,
  radius: number,
  extension = 0
): ShapeHandle {
  const vector = subtract(end, start);
  const axis = normalized(vector);
  const axialLength = length(vector);
  if (!axis || axialLength <= GEOMETRY_EPSILON) {
    throw new Error('Cylindrical feature has a degenerate axis.');
  }
  const origin = subtract(start, scale(axis, extension));
  const local = kernel.makeCylinder(radius, axialLength + extension * 2);
  return kernel.transform(local, cylinderFrame(origin, axis));
}

/** Close exactly the selected through-hole span without changing outer faces. */
function fillThroughHole(
  kernel: OcctKernel,
  owner: ShapeHandle,
  geometry: ThroughHoleGeometry
): ShapeHandle {
  const filler = cylinderAlongAxis(
    kernel,
    geometry.axisStart,
    geometry.axisEnd,
    geometry.radius
  );
  return kernel.unifySameDomain(kernel.fuse(owner, filler));
}

/**
 * Push/pull a planar face prismatically: extrude the face along its recorded
 * outward normal, then fuse the prism in (grow) or cut it out (shrink). A
 * prismatic move is worth exactly `offset * area`, and the result is gated on
 * that, so a tool that reached material it should not have — an obstruction on
 * the way out, or the far wall on the way in — is rejected rather than
 * returned.
 */
function offsetPlanarFace(
  kernel: OcctKernel,
  owner: ShapeHandle,
  face: ShapeHandle,
  operation: Extract<DirectEditOperation, { kind: 'offset-face' }>,
  scope: Record<string, number>
): ShapeHandle {
  const geometry = faceGeometry(kernel, owner, face);
  if (geometry.surfaceType !== 'plane') {
    throw new Error('The selected face is no longer planar.');
  }
  const areaTolerance = Math.max(
    DIRECT_EDIT_TOLERANCE,
    operation.sourceArea * 1e-6
  );
  const centerTolerance = Math.max(
    DIRECT_EDIT_TOLERANCE,
    Math.sqrt(Math.max(operation.sourceArea, 1)) * 1e-6
  );
  if (
    Math.abs(geometry.area - operation.sourceArea) > areaTolerance ||
    length(subtract(geometry.center, operation.sourceCenter)) > centerTolerance
  ) {
    throw new Error(
      'The selected face no longer matches its recorded measurements.'
    );
  }
  const outward = normalized(operation.sourceNormal);
  if (!outward) {
    throw new Error('The recorded face normal is degenerate.');
  }
  // The stored normal came from the picked triangle and points out of the
  // material; the surface parameterization may disagree with it by sign, so
  // only alignment up to sign is checked and the stored direction is trusted.
  const bounds = kernel.uvBounds(face);
  const measured = normalized(
    kernel.surfaceNormal(
      face,
      (bounds.uMin + bounds.uMax) / 2,
      (bounds.vMin + bounds.vMax) / 2
    )
  );
  if (!measured) {
    throw new Error('The selected face has a degenerate normal.');
  }
  const alignment =
    measured.x * outward.x + measured.y * outward.y + measured.z * outward.z;
  if (Math.abs(alignment) < 1 - 1e-6) {
    throw new Error(
      'The selected face no longer matches its recorded orientation.'
    );
  }
  const offset = resolveParamValue(operation.offset, scope, 'offset');
  if (!Number.isFinite(offset) || Math.abs(offset) <= GEOMETRY_EPSILON) {
    throw new Error('Face offset must be a non-zero distance.');
  }
  const prism = kernel.extrude(
    face,
    outward.x * offset,
    outward.y * offset,
    outward.z * offset
  );
  const volumeBefore = kernel.getVolume(owner);
  const combined =
    offset > 0 ? kernel.fuse(owner, prism) : kernel.cut(owner, prism);
  // Unifying merges the prism's walls into adjacent coplanar faces so a clean
  // push/pull leaves no seam edges, but on dense imported bodies the merge of
  // tangent spline neighbours can itself break BRepCheck validity — keep the
  // seamed-but-valid boolean result in that case.
  const unified = kernel.unifySameDomain(combined);
  const output = kernel.isValid(unified) ? unified : combined;
  const expectedVolume = volumeBefore + offset * geometry.area;
  const volumeTolerance = Math.max(
    DIRECT_EDIT_TOLERANCE,
    Math.abs(offset) * geometry.area * 1e-5
  );
  if (Math.abs(kernel.getVolume(output) - expectedVolume) > volumeTolerance) {
    throw new Error(
      `Offsetting the face by ${offset} does not produce a valid solid.`
    );
  }
  return output;
}

function validateDirectEditResult(
  kernel: OcctKernel,
  shape: ShapeHandle
): void {
  if (kernel.subShapeCount(shape, 'solid') === 0 || !kernel.isValid(shape)) {
    throw new Error('Direct edit did not produce a valid solid.');
  }
}

function applyDirectEdit(
  kernel: OcctKernel,
  owner: ShapeHandle,
  operation: DirectEditOperation,
  scope: Record<string, number>,
  lineage: OcctLineageState | undefined
): ShapeHandle {
  const faces = kernel.getSubShapes(owner, 'face');
  let face: ShapeHandle;
  if (operation.faceReference) {
    const resolution = resolveOcctTopologyReference(
      operation.faceReference,
      lineage,
      faces.map((candidate) => faceTopologyCandidate(kernel, candidate)),
      'direct-edit'
    );
    if (
      resolution.status !== 'resolved' ||
      typeof resolution.candidate.value !== 'number' ||
      !faces[resolution.candidate.value]
    ) {
      throw new Error(
        resolution.status === 'failed'
          ? resolution.message
          : 'Resolved face lineage did not identify an OCCT face.'
      );
    }
    face = faces[resolution.candidate.value]!;
  } else {
    const matches = faces.filter(
      (candidate) => faceFingerprint(kernel, candidate) === operation.faceHash
    );
    if (matches.length === 0) {
      throw unresolvedReferenceError('face', operation.faceHash, faces.length);
    }
    if (matches.length > 1) {
      throw ambiguousReferenceError('face');
    }
    face = matches[0]!;
  }

  let output: ShapeHandle;
  if (operation.kind === 'resize-through-hole') {
    const geometry = requireThroughHole(
      kernel,
      owner,
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
    if (diameter <= DIRECT_EDIT_TOLERANCE) {
      throw new Error('Through-hole diameter must be greater than zero.');
    }
    const closed = fillThroughHole(kernel, owner, geometry);
    const extension = Math.max(
      DIRECT_EDIT_TOLERANCE * 10,
      geometry.axialLength * 0.02,
      diameter * 0.01
    );
    const cutter = cylinderAlongAxis(
      kernel,
      geometry.axisStart,
      geometry.axisEnd,
      diameter / 2,
      extension
    );
    output = kernel.unifySameDomain(kernel.cut(closed, cutter));
  } else if (operation.kind === 'resize-cylindrical-face') {
    const radius = resolveParamValue(
      operation.radius,
      scope,
      'cylindrical radius'
    );
    output = resizeOcctAnalyticCylinder(kernel, owner, face, {
      sourceRadius: operation.sourceRadius,
      sourceAxisStart: operation.sourceAxisStart,
      sourceAxisEnd: operation.sourceAxisEnd,
      concavity: operation.concavity,
      radius
    });
  } else if (operation.kind === 'offset-face') {
    output = offsetPlanarFace(kernel, owner, face, operation, scope);
  } else {
    const geometry = faceGeometry(kernel, owner, face);
    if (geometry.surfaceType !== operation.sourceSurfaceType) {
      throw new Error('Selected face no longer matches its recorded surface.');
    }
    const areaTolerance = Math.max(
      DIRECT_EDIT_TOLERANCE,
      operation.sourceArea * 1e-6
    );
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
    output =
      geometry.featureType === 'through-hole'
        ? fillThroughHole(
            kernel,
            owner,
            requireThroughHole(
              kernel,
              owner,
              face,
              operation.sourceDiameter,
              operation.sourceAxisStart,
              operation.sourceAxisEnd
            )
          )
        : kernel.defeature(owner, [face], DIRECT_EDIT_TOLERANCE);
    output = kernel.unifySameDomain(output);
  }

  validateDirectEditResult(kernel, output);
  return output;
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
    case 'text':
      // Text is many regions with holes; a single polygonal profile cannot
      // represent it. It builds through the region path instead.
      throw new Error(
        'Text must be extruded through its detected sketch regions, not as a single profile.'
      );
  }
}

function axisDirection(axis: 'x' | 'y' | 'z'): Vec3 {
  return {
    x: axis === 'x' ? 1 : 0,
    y: axis === 'y' ? 1 : 0,
    z: axis === 'z' ? 1 : 0
  };
}

/** Same world-origin ZYX Euler transform used by the viewport move gizmo. */
function transformMatrix(translation: Vec3, rotationDeg: Vec3): number[] {
  const rx = (rotationDeg.x * Math.PI) / 180;
  const ry = (rotationDeg.y * Math.PI) / 180;
  const rz = (rotationDeg.z * Math.PI) / 180;
  const ca = Math.cos(rx);
  const sa = Math.sin(rx);
  const cb = Math.cos(ry);
  const sb = Math.sin(ry);
  const cc = Math.cos(rz);
  const sc = Math.sin(rz);
  return [
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
    translation.z
  ];
}

function sweepSemanticDescriptor(
  document: ProjectDocument,
  feature: FeatureNode,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>
): SweepSemanticDescriptor {
  if (
    feature.data.featureKind !== 'extrude' &&
    feature.data.featureKind !== 'revolve'
  ) {
    throw new Error('Expected a sweep feature for semantic lineage.');
  }
  const sketch = findSketch(document, feature.data.sketchId);
  const objectId = sketch?.objectIds[0];
  const object = objectId ? document.nodes[objectId] : undefined;
  const sourceKey = objectId ? String(objectId) : String(feature.data.sketchId);
  const sourceKind =
    object?.kind === 'sketch-object' ? object.data.objectKind : undefined;
  if (feature.data.featureKind === 'revolve') {
    return { kind: 'revolve', sourceKey, sourceKind };
  }
  const basis = sketch ? (sketchBases.get(sketch.sketchId) ?? null) : null;
  const distance = resolveParamValue(feature.data.distance, scope, 'distance');
  const direction = basis
    ? {
        x: basis.normal.x * distance,
        y: basis.normal.y * distance,
        z: basis.normal.z * distance
      }
    : { x: 0, y: 0, z: distance };
  if (
    !basis ||
    !object ||
    object.kind !== 'sketch-object' ||
    object.data.objectKind === 'circle' ||
    feature.data.profile ||
    (feature.data.profiles && feature.data.profiles.length > 0)
  ) {
    return { kind: 'extrude', sourceKey, sourceKind, direction };
  }
  const points = profilePoints(object.data, scope);
  const sideAnchors = points.map((start, index) => {
    const end = points[(index + 1) % points.length]!;
    const profileMidpoint = pointOnPlane(
      basis,
      { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
      0
    );
    return {
      lineageName: `sweep.face.side.${sourceKey}.${index}`,
      midpoint: {
        x: profileMidpoint.x + direction.x / 2,
        y: profileMidpoint.y + direction.y / 2,
        z: profileMidpoint.z + direction.z / 2
      }
    };
  });
  return { kind: 'extrude', sourceKey, sourceKind, direction, sideAnchors };
}

/**
 * OpenCascade-backed document rebuild used whenever STEP geometry is present.
 * All bodies in that document are built in the same kernel, so imported solids
 * remain exact inputs to transforms, booleans, patterns, and edge modifiers.
 */
export class OcctStepKernelAdapter {
  readonly kind = 'occt' as const;

  private constructor(private readonly kernel: OcctKernel) {}

  static async create(): Promise<OcctStepKernelAdapter> {
    const browserWasmUrl =
      typeof globalThis.location === 'object' &&
      /^(?:https?:|blob:)$/.test(globalThis.location.protocol)
        ? occtWasmUrl
        : undefined;
    return new OcctStepKernelAdapter(
      await OcctKernel.init(
        browserWasmUrl ? { wasm: browserWasmUrl } : undefined
      )
    );
  }

  private resolveSketchBasisAtHistory(
    document: ProjectDocument,
    sketch: SketchNode,
    result: OcctBuildResult,
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
      candidates: faceAttachmentCandidatesForShape(
        this.kernel,
        sourceShape,
        result.lineages.get(planeRef.bodyId)
      ),
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
    data: SketchObjectData,
    basis: PlaneBasis,
    offset: number,
    scope: Record<string, number>
  ): ShapeHandle {
    if (data.objectKind === 'circle') {
      const center = pointOnPlane(
        basis,
        {
          x: resolveParamValue(data.centerX, scope, 'center X'),
          y: resolveParamValue(data.centerY, scope, 'center Y')
        },
        offset
      );
      const edge = this.kernel.makeCircleEdge(
        center,
        basis.normal,
        resolveParamValue(data.radius, scope, 'radius')
      );
      return this.kernel.makeFace(this.kernel.makeWire([edge]));
    }

    const points = profilePoints(data, scope).map((point) =>
      pointOnPlane(basis, point, offset)
    );
    const edges = points.map((start, index) =>
      this.kernel.makeLineEdge(start, points[(index + 1) % points.length]!)
    );
    return this.kernel.makeFace(this.kernel.makeWire(edges));
  }

  private buildPrimitive(
    data: Extract<FeatureNode['data'], { featureKind: 'primitive' }>,
    scope: Record<string, number>
  ): ShapeHandle {
    const dimension = (key: string): number =>
      resolveParamValue(data.dimensions[key] ?? 0, scope, key);
    switch (data.primitiveKind) {
      case 'box':
        return this.kernel.makeBox(
          dimension('width'),
          dimension('height'),
          dimension('depth')
        );
      case 'cylinder':
        return this.kernel.makeCylinder(
          dimension('radius'),
          dimension('height')
        );
      case 'sphere':
        return this.kernel.makeSphere(dimension('radius'));
      case 'cone':
        return this.kernel.makeCone(
          dimension('bottomRadius'),
          dimension('topRadius'),
          dimension('height')
        );
      case 'torus':
        return this.kernel.makeTorus(
          dimension('majorRadius'),
          dimension('minorRadius')
        );
    }
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
   * wires from the region's line/arc/bezier curves. Mirrors the BrepKit
   * adapter's construction — including the identical ≤ 90° arc subdivision —
   * so the resulting edges carry the same ADR-011 fingerprints on both
   * kernels.
   */
  private makeRegionFace(
    region: SketchRegion,
    basis: PlaneBasis
  ): ShapeHandle {
    const exactBeziers = bezierProfileEdgesEnabled();
    const wireFor = (loop: SketchRegion['outer']): ShapeHandle => {
      const edges: ShapeHandle[] = [];
      for (const curve of loop.curves) {
        if (curve.kind === 'line') {
          edges.push(
            this.kernel.makeLineEdge(
              OcctStepKernelAdapter.planePoint3(basis, curve.a),
              OcctStepKernelAdapter.planePoint3(basis, curve.b)
            )
          );
          continue;
        }
        if (curve.kind === 'bezier') {
          if (exactBeziers) {
            // OpenCascade takes 3D control points directly, so the plane's
            // own basis lifts them — no dependence on how the kernel derives
            // a second axis, unlike BrepKit's `liftCurve2dToPlane`.
            edges.push(
              this.kernel.makeBezierEdge(
                [curve.a, ...curve.controls, curve.b].map((point) =>
                  OcctStepKernelAdapter.planePoint3(basis, point)
                )
              )
            );
            continue;
          }
          const points = flattenBezierCurve(curve);
          for (let index = 0; index + 1 < points.length; index += 1) {
            edges.push(
              this.kernel.makeLineEdge(
                OcctStepKernelAdapter.planePoint3(basis, points[index]!),
                OcctStepKernelAdapter.planePoint3(basis, points[index + 1]!)
              )
            );
          }
          continue;
        }
        const span = Math.abs(curve.endAngle - curve.startAngle);
        const center = OcctStepKernelAdapter.planePoint3(basis, curve.center);
        if (span >= Math.PI * 2 - 1e-9) {
          // OpenCascade seams its circles a quarter turn from where BrepKit
          // does. Rotate the edge about its own axis so the seam vertex — and
          // the wall seam it extrudes into — lands on the same point in both
          // kernels; otherwise cross-kernel fingerprints of the seam edge and
          // wall face would diverge.
          const edge = this.kernel.makeCircleEdge(
            center,
            basis.normal,
            curve.radius
          );
          edges.push(
            this.kernel.rotate(
              edge,
              { point: center, direction: basis.normal },
              Math.PI / 2
            )
          );
          continue;
        }
        // Arc pieces are subdivided to ≤ 90°, exactly as the BrepKit adapter
        // subdivides them: quarter arcs are unambiguous and the piece
        // boundaries become shared vertices with identical coordinates.
        const wrap = Math.PI * 2;
        const forward =
          (((curve.endAngle - curve.startAngle) % wrap) + wrap) % wrap;
        const sweep = curve.ccw ? forward : forward - wrap;
        const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
        const pointAtAngle = (angle: number): Vec3 =>
          OcctStepKernelAdapter.planePoint3(basis, {
            x: curve.center.x + Math.cos(angle) * curve.radius,
            y: curve.center.y + Math.sin(angle) * curve.radius
          });
        for (let piece = 0; piece < pieces; piece += 1) {
          const angleA = curve.startAngle + (sweep * piece) / pieces;
          const angleB = curve.startAngle + (sweep * (piece + 1)) / pieces;
          edges.push(
            this.kernel.makeArcEdge(
              pointAtAngle(angleA),
              pointAtAngle((angleA + angleB) / 2),
              pointAtAngle(angleB)
            )
          );
        }
      }
      return this.kernel.makeWire(edges);
    };

    const outerWire = wireFor(region.outer);
    const holeWires = region.holes.map(wireFor);
    // No warning for `flattened` here. Flattening is the default (see
    // `profile-bezier-edges`), and unlike the BrepKit adapter this one has no
    // second way to reach the fallback — `exactBeziers` is the only gate, so a
    // warning would fire on every rebuild and say nothing.
    const face = this.kernel.makeFace(outerWire);
    if (holeWires.length === 0) {
      return face;
    }
    return this.kernel.addHolesInFace(face, holeWires);
  }

  /** Extrude one or more explicitly selected bounded sketch cells. */
  private buildRegionExtrude(
    document: ProjectDocument,
    sketch: SketchNode,
    data: Extract<FeatureNode['data'], { featureKind: 'extrude' }>,
    scope: Record<string, number>,
    basis: PlaneBasis,
    warn: (message: string) => void
  ): ShapeHandle {
    const regions = resolveRegionProfiles(document, sketch, data, scope);
    const distance = resolveParamValue(data.distance, scope, 'distance');
    const flattenedOutlines = regions.filter(
      (region) => region.outline?.fidelity === 'flattened'
    ).length;
    if (flattenedOutlines > 0) {
      warn(flattenedOutlineWarning(flattenedOutlines));
    }
    const solids = connectedRegionGroups(regions).map((group) => {
      return this.kernel.extrude(
        this.makeRegionFace(mergeAdjacentProfiles(group), basis),
        basis.normal.x * distance,
        basis.normal.y * distance,
        basis.normal.z * distance
      );
    });
    return solids.length === 1 ? solids[0]! : this.kernel.makeCompound(solids);
  }

  /**
   * OpenCascade booleans hand back a compound wrapping their solids, and the
   * fillet/chamfer builders reject compounds outright. Collapse to the single
   * contained solid, fusing first when a pattern produced several — the same
   * semantics as the BrepKit adapter's collapseShape.
   */
  private collapseToSolid(shape: ShapeHandle): ShapeHandle {
    if (this.kernel.isSolid(shape)) {
      return shape;
    }
    const solids = this.kernel.getSubShapes(shape, 'solid');
    if (solids.length === 0) {
      throw new Error('Exact body contains no solids.');
    }
    if (solids.length === 1) {
      return solids[0]!;
    }
    return this.kernel.unifySameDomain(this.kernel.fuseAll(solids));
  }

  private buildSweep(
    document: ProjectDocument,
    feature: FeatureNode,
    scope: Record<string, number>,
    sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
    warn: (message: string) => void
  ): ShapeHandle {
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
        document,
        sketchNode,
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
    const face = this.makeProfileFace(object.data, basis, 0, scope);

    if (feature.data.featureKind === 'extrude') {
      const distance = resolveParamValue(
        feature.data.distance,
        scope,
        'distance'
      );
      return this.kernel.extrude(
        face,
        basis.normal.x * distance,
        basis.normal.y * distance,
        basis.normal.z * distance
      );
    }

    const direction = feature.data.axis === 'vertical' ? basis.v : basis.u;
    return this.kernel.revolve(
      face,
      {
        point: pointOnPlane(basis, { x: 0, y: 0 }, 0),
        direction
      },
      Math.PI * 2
    );
  }

  private build(document: ProjectDocument): OcctBuildResult {
    const { scope, errors } = getParameterScope(document);
    const result: OcctBuildResult = {
      shapes: new Map(),
      lineages: new Map(),
      sketchBases: new Map(),
      consumed: new Set(),
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
              this.resolveSketchBasisAtHistory(document, sketch, result, scope)
            );
            break;
          }
          case 'primitive':
            if (feature.bodyId) {
              const shape = this.buildPrimitive(feature.data, scope);
              result.shapes.set(feature.bodyId, shape);
              result.lineages.set(
                feature.bodyId,
                semanticPrimitiveLineage(
                  feature.featureId,
                  feature.data.primitiveKind,
                  topologyCandidatesForShape(this.kernel, shape)
                )
              );
            }
            break;
          case 'extrude':
          case 'revolve':
            if (feature.bodyId) {
              const shape = this.buildSweep(
                document,
                feature,
                scope,
                result.sketchBases,
                (message) =>
                  result.warnings.push(`Feature "${feature.name}": ${message}`)
              );
              result.shapes.set(feature.bodyId, shape);
              result.lineages.set(
                feature.bodyId,
                semanticSweepLineage(
                  feature.featureId,
                  sweepSemanticDescriptor(
                    document,
                    feature,
                    scope,
                    result.sketchBases
                  ),
                  topologyCandidatesForShape(this.kernel, shape)
                )
              );
            }
            break;
          case 'imported-step':
            if (feature.bodyId) {
              if (feature.data.stepText === undefined) {
                throw new Error(
                  'Parity corpus documents embed STEP text; the OCCT reference does not resolve source references.'
                );
              }
              const imported = this.kernel.importStep(feature.data.stepText);
              // OCCT normalizes STEP length units to millimetres. The
              // canonical document stores coordinates in document units, so
              // convert once at the import boundary and reverse the conversion
              // only when an export is serialized.
              const scaleToDocumentUnits = 1 / UNIT_TO_MM[document.units];
              const shape =
                scaleToDocumentUnits === 1
                  ? imported
                  : this.kernel.transform(
                      imported,
                      uniformScaleTransform(scaleToDocumentUnits)
                    );
              if (this.kernel.getSubShapes(shape, 'solid').length === 0) {
                throw new Error('STEP file contains no solids.');
              }
              result.shapes.set(feature.bodyId, shape);
              result.lineages.set(
                feature.bodyId,
                importedStepLineage(
                  feature.featureId,
                  topologyCandidatesForShape(this.kernel, shape)
                )
              );
            }
            break;
          case 'imported-mesh':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.kernel.importStl(importedMeshStl(feature.data))
              );
              result.lineages.set(
                feature.bodyId,
                hashOnlyOcctLineage(
                  'Imported meshes do not expose exact B-rep lineage.'
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
            const matrix = transformMatrix(
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
            );
            const transformed = this.kernel.transform(target, matrix);
            result.shapes.set(feature.data.targetBodyId, transformed);
            result.lineages.set(
              feature.data.targetBodyId,
              propagateRigidTransformLineage(
                result.lineages.get(feature.data.targetBodyId) ??
                  hashOnlyOcctLineage('Transform source has no lineage.'),
                topologyCandidatesForShape(this.kernel, transformed),
                matrix
              )
            );
            break;
          }
          case 'mirror': {
            if (!feature.bodyId) {
              throw new Error('Mirror has no result body.');
            }
            const storedTarget = result.shapes.get(feature.data.targetBodyId);
            if (!storedTarget) {
              throw new Error('Mirror target is unavailable.');
            }
            const target = this.collapseToSolid(storedTarget);
            const plane = feature.data.plane;
            const mirrored = mirrorOcctSolid(this.kernel, target, {
              planePoint: {
                x: resolveParamValue(plane.origin.x, scope, 'plane origin X'),
                y: resolveParamValue(plane.origin.y, scope, 'plane origin Y'),
                z: resolveParamValue(plane.origin.z, scope, 'plane origin Z')
              },
              planeNormal: {
                x: resolveParamValue(plane.normal.x, scope, 'plane normal X'),
                y: resolveParamValue(plane.normal.y, scope, 'plane normal Y'),
                z: resolveParamValue(plane.normal.z, scope, 'plane normal Z')
              }
            });
            result.shapes.set(feature.bodyId, mirrored);
            result.lineages.set(
              feature.bodyId,
              hashOnlyOcctLineage(
                'Mirror reflection lineage is not published by this adapter yet; topology remains hash-only.'
              )
            );
            break;
          }
          case 'shell': {
            if (!feature.bodyId) {
              throw new Error('Shell has no result body.');
            }
            const storedTarget = result.shapes.get(feature.data.targetBodyId);
            if (!storedTarget) {
              throw new Error('Shell target is unavailable.');
            }
            const target = this.collapseToSolid(storedTarget);
            const targetFaces = this.kernel.getSubShapes(target, 'face');
            const targetCandidates = targetFaces.map((face) =>
              faceTopologyCandidate(this.kernel, face)
            );
            const selected: ShapeHandle[] = [];
            for (const hash of feature.data.openingFaceHashes) {
              const reference = feature.data.openingFaceReferences?.find(
                (candidate) => candidate.currentHash === hash
              );
              if (reference) {
                const resolution = resolveOcctTopologyReference(
                  reference,
                  result.lineages.get(feature.data.targetBodyId),
                  targetCandidates,
                  'direct-edit'
                );
                if (
                  resolution.status !== 'resolved' ||
                  typeof resolution.candidate.value !== 'number' ||
                  !targetFaces[resolution.candidate.value]
                ) {
                  throw new Error(
                    resolution.status === 'failed'
                      ? resolution.message
                      : 'Resolved shell lineage did not identify an OCCT face.'
                  );
                }
                selected.push(targetFaces[resolution.candidate.value]!);
                continue;
              }
              const matches = targetFaces.filter(
                (candidate) => faceFingerprint(this.kernel, candidate) === hash
              );
              if (matches.length === 0) {
                throw unresolvedReferenceError(
                  'face',
                  hash,
                  targetFaces.length
                );
              }
              if (matches.length > 1) {
                throw ambiguousReferenceError('face');
              }
              selected.push(matches[0]!);
            }
            const thickness = resolveParamValue(
              feature.data.thickness,
              scope,
              'shell thickness'
            );
            const shelled = shellOcctSolid(this.kernel, target, {
              openingFaces: selected,
              thickness
            });
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(feature.bodyId, shelled);
            result.lineages.set(
              feature.bodyId,
              hashOnlyOcctLineage(
                'Shell generated-face history is not published by this adapter yet; topology remains hash-only.'
              )
            );
            break;
          }
          case 'solid-offset': {
            if (!feature.bodyId) {
              throw new Error('Solid offset has no result body.');
            }
            const storedTarget = result.shapes.get(feature.data.targetBodyId);
            if (!storedTarget) {
              throw new Error('Solid-offset target is unavailable.');
            }
            const target = this.collapseToSolid(storedTarget);
            const distance = resolveParamValue(
              feature.data.distance,
              scope,
              'solid offset'
            );
            const offset = offsetOcctSolid(this.kernel, target, { distance });
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(feature.bodyId, offset);
            result.lineages.set(
              feature.bodyId,
              hashOnlyOcctLineage(
                'Solid-offset generated-face history is not published by this adapter yet; topology remains hash-only.'
              )
            );
            break;
          }
          case 'direct-edit': {
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Direct-edit target is unavailable.');
            }
            result.shapes.set(
              feature.data.targetBodyId,
              applyDirectEdit(
                this.kernel,
                target,
                feature.data.operation,
                scope,
                result.lineages.get(feature.data.targetBodyId)
              )
            );
            result.lineages.set(
              feature.data.targetBodyId,
              hashOnlyOcctLineage(
                'Direct-edit output history is incomplete; topology remains hash-only.'
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
            let output: ShapeHandle;
            if (feature.data.operation === 'union') {
              const unionSolids = operands.flatMap((operand) =>
                this.kernel.isSolid(operand)
                  ? [operand]
                  : this.kernel.getSubShapes(operand, 'solid')
              );
              const connectivity = analyzeUnionConnectivity(
                unionSolids.map((candidate) => {
                  const bounds = this.kernel.getBoundingBox(candidate, true);
                  return {
                    solid: candidate,
                    bounds: {
                      min: {
                        x: bounds.xmin,
                        y: bounds.ymin,
                        z: bounds.zmin
                      },
                      max: {
                        x: bounds.xmax,
                        y: bounds.ymax,
                        z: bounds.zmax
                      }
                    }
                  };
                }),
                (left, right) => this.kernel.distanceBetween(left, right),
                (left, right) => {
                  try {
                    return (
                      this.kernel.getVolume(this.kernel.common(left, right)) > 0
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
              output = this.kernel.fuseAll(operands);
            } else {
              output = operands[0]!;
              for (const operand of operands.slice(1)) {
                output =
                  feature.data.operation === 'subtract'
                    ? this.kernel.cut(output, operand)
                    : this.kernel.common(output, operand);
              }
            }
            output = this.kernel.unifySameDomain(output);
            feature.data.targetBodyIds.forEach((bodyId) =>
              result.consumed.add(bodyId)
            );
            result.shapes.set(feature.bodyId, output);
            result.lineages.set(
              feature.bodyId,
              hashOnlyOcctLineage(
                'Boolean history precedes production same-domain unification; topology remains hash-only.'
              )
            );
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
            const target = this.collapseToSolid(storedTarget);
            const requested = new Set(feature.data.edgeHashes);
            const targetEdges = this.kernel.getSubShapes(target, 'edge');
            const targetCandidates = targetEdges.map((edge) =>
              edgeTopologyCandidate(this.kernel, edge)
            );
            const edgesByHash = edgeHandlesByFingerprint(
              this.kernel,
              targetEdges
            );
            const selected: ShapeHandle[] = [];
            for (const hash of requested) {
              const reference = feature.data.edgeReferences?.find(
                (candidate) => candidate.currentHash === hash
              );
              if (reference) {
                const resolution = resolveOcctTopologyReference(
                  reference,
                  result.lineages.get(feature.data.targetBodyId),
                  targetCandidates,
                  feature.data.featureKind
                );
                if (
                  resolution.status !== 'resolved' ||
                  typeof resolution.candidate.value !== 'number' ||
                  !targetEdges[resolution.candidate.value]
                ) {
                  throw new Error(
                    resolution.status === 'failed'
                      ? resolution.message
                      : 'Resolved edge lineage did not identify an OCCT edge.'
                  );
                }
                selected.push(targetEdges[resolution.candidate.value]!);
                continue;
              }
              const matches = edgesByHash.get(hash) ?? [];
              if (matches.length === 0) {
                throw unresolvedReferenceError(
                  'edge',
                  hash,
                  targetEdges.length
                );
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
            const modified =
              feature.data.featureKind === 'fillet'
                ? this.kernel.fillet(target, selected, size)
                : this.kernel.chamfer(target, selected, size);
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(feature.bodyId, modified);
            result.lineages.set(
              feature.bodyId,
              hashOnlyOcctLineage(
                `${feature.data.featureKind} generated-face history is incomplete; topology remains hash-only.`
              )
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
            const axis = axisDirection(feature.data.axis);
            const instances: ShapeHandle[] = [target];
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
                instances.push(
                  this.kernel.translate(
                    target,
                    axis.x * spacing * index,
                    axis.y * spacing * index,
                    axis.z * spacing * index
                  )
                );
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
              const step =
                Math.abs(Math.abs(angle) - 360) <= GEOMETRY_EPSILON
                  ? angle / count
                  : angle / (count - 1);
              for (let index = 1; index < count; index += 1) {
                instances.push(
                  this.kernel.rotate(
                    target,
                    { point: { x: 0, y: 0, z: 0 }, direction: axis },
                    (step * index * Math.PI) / 180
                  )
                );
              }
            }
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(
              feature.bodyId,
              this.kernel.makeCompound(instances)
            );
            result.lineages.set(
              feature.bodyId,
              hashOnlyOcctLineage(
                'Pattern instance lineage is not published by this adapter yet; topology remains hash-only.'
              )
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

  private representation(
    document: ProjectDocument,
    bodyId: BodyId,
    shape: ShapeHandle,
    consumed: boolean,
    lineage: OcctLineageState | undefined
  ): BodyRepresentation | null {
    const body = listNodesByKind(document, 'body').find(
      (candidate) => candidate.bodyId === bodyId
    );
    if (!body) {
      return null;
    }
    const feature = listNodesByKind(document, 'feature').find(
      (candidate) => candidate.featureId === body.featureId
    );
    const bounds = this.kernel.getBoundingBox(shape, true);
    const displayTessellation = displayTessellationForExtents(
      bounds.xmax - bounds.xmin,
      bounds.ymax - bounds.ymin,
      bounds.zmax - bounds.zmin
    );
    const mesh = this.kernel.meshShape(shape, {
      linearDeflection: displayTessellation.linearDeflection,
      angularDeflection: displayTessellation.angularDeflection
    });
    const faces: BodyTopology['faces'] = [];
    const faceShapes = this.kernel.getSubShapes(shape, 'face');
    const edgeToFaces = occtEdgeFaceAdjacency(this.kernel, shape);
    const faceTypesByHash = new Map<number, Set<string>>();
    for (const face of faceShapes) {
      const hash = this.kernel.hashCode(face, TOPOLOGY_HASH_UPPER_BOUND);
      const types = faceTypesByHash.get(hash) ?? new Set<string>();
      types.add(this.kernel.surfaceType(face));
      faceTypesByHash.set(hash, types);
    }
    const faceGroups = mesh.faceGroups ?? new Int32Array();
    // Tessellation groups and getSubShapes iterate the same underlying shell,
    // so face handle i owns triangle range i. Guarded because the persisted
    // ADR-011 fingerprint below silently depends on it.
    if (faceShapes.length !== faceGroups.length / 3) {
      throw new Error(
        `Face handle count ${faceShapes.length} does not match tessellation groups ${faceGroups.length / 3}.`
      );
    }
    for (let index = 0; index + 2 < faceGroups.length; index += 3) {
      const indexStart = faceGroups[index]!;
      const indexCount = faceGroups[index + 1]!;
      const face = faceShapes[index / 3]!;
      const candidate = faceTopologyCandidate(this.kernel, face);
      const hash = candidate.currentHash;
      const reference = referenceForOcctCandidate(lineage, candidate);
      faces.push({
        topologyId: `face:${hash}`,
        hash,
        triangleStart: indexStart / 3,
        triangleCount: indexCount / 3,
        geometry: faceGeometry(this.kernel, shape, face),
        ...(reference?.kind === 'face' ? { reference } : {})
      });
    }

    const wireframe = this.kernel.wireframe(
      shape,
      displayTessellation.linearDeflection
    );
    const edgeShapes = this.kernel.getSubShapes(shape, 'edge');
    if (edgeShapes.length !== wireframe.edgeGroups.length / 3) {
      throw new Error(
        `Edge handle count ${edgeShapes.length} does not match wireframe groups ${wireframe.edgeGroups.length / 3}.`
      );
    }
    const edges: BodyTopology['edges'] = [];
    for (let index = 0; index + 2 < wireframe.edgeGroups.length; index += 3) {
      const pointStart = wireframe.edgeGroups[index]!;
      const pointCount = wireframe.edgeGroups[index + 1]!;
      const edgeShape = edgeShapes[index / 3]!;
      const candidate = edgeTopologyCandidate(this.kernel, edgeShape);
      const hash = candidate.currentHash;
      const reference = referenceForOcctCandidate(lineage, candidate);
      edges.push({
        topologyId: `edge:${hash}`,
        hash,
        displayRole: occtEdgeDisplayRole(
          this.kernel,
          edgeShape,
          edgeToFaces,
          faceTypesByHash
        ),
        points: Array.from(
          wireframe.points.slice(pointStart, pointStart + pointCount)
        ),
        ...(reference?.kind === 'edge' ? { reference } : {})
      });
    }

    const lineageDiagnostics: BodyTopology['lineageDiagnostics'] =
      lineage?.status === 'hash-only'
        ? [
            {
              kind: 'body',
              status: 'hash-only',
              message: lineage.reason
            }
          ]
        : lineage
          ? [...lineage.diagnostics]
          : undefined;

    return {
      bodyId,
      name: body.name,
      source: feature?.featureKind ?? 'primitive',
      mesh: {
        kind: 'mesh',
        vertices: Array.from(mesh.positions),
        indices: Array.from(mesh.indices)
      },
      faceCount: faces.length,
      color:
        String(
          body.metadata?.color ??
            featureColor(feature?.featureKind ?? 'primitive')
        ) || DEFAULT_BODY_COLOR,
      exportableStep: body.exportableStep,
      consumed,
      volume: this.kernel.getVolume(shape),
      bbox: {
        min: { x: bounds.xmin, y: bounds.ymin, z: bounds.zmin },
        max: { x: bounds.xmax, y: bounds.ymax, z: bounds.zmax }
      },
      topology: {
        faces,
        edges,
        ...(lineageDiagnostics && lineageDiagnostics.length > 0
          ? { lineageDiagnostics }
          : {})
      }
    };
  }

  async syncDocument(document: ProjectDocument): Promise<DerivedState> {
    try {
      const build = this.build(document);
      const bodyRepresentations: Record<BodyId, BodyRepresentation> = {};
      const exportableBodyIds: BodyId[] = [];
      const bodies = new Map(
        listNodesByKind(document, 'body').map((body) => [body.bodyId, body])
      );

      for (const bodyId of document.bodyOrder) {
        const body = bodies.get(bodyId);
        const shape = build.shapes.get(bodyId);
        if (!body || !shape) {
          continue;
        }
        const consumed = build.consumed.has(bodyId);
        if (
          body.representationSource !== 'mesh-import' &&
          !this.kernel.isValid(shape)
        ) {
          const invalidStepSolids =
            body.representationSource === 'step-import'
              ? this.kernel
                  .getSubShapes(shape, 'solid')
                  .filter((solid) => !this.kernel.isValid(solid))
              : [];
          build.warnings.push(
            invalidStepSolids.length > 0
              ? importedStepValidationWarning(
                  body.name,
                  invalidStepSolids.length,
                  this.kernel.subShapeCount(shape, 'solid'),
                  'OpenCascade'
                )
              : `Body "${body.name}" failed OpenCascade B-rep validation.`
          );
        }
        const representation = this.representation(
          document,
          bodyId,
          shape,
          consumed,
          build.lineages.get(bodyId)
        );
        if (representation) {
          bodyRepresentations[bodyId] = representation;
        }
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
      this.kernel.releaseAll();
    }
  }

  private exportShape(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): ShapeHandle {
    const build = this.build(document);
    const shapes = bodyIds.map((bodyId) => {
      const shape = build.shapes.get(bodyId);
      if (!shape) {
        throw new Error(`Body ${bodyId} has no exact geometry.`);
      }
      return shape;
    });
    if (shapes.length === 0) {
      throw new Error('Select at least one body to export.');
    }
    const combined =
      shapes.length === 1 ? shapes[0]! : this.kernel.makeCompound(shapes);
    const millimeterScale = UNIT_TO_MM[document.units];
    return millimeterScale === 1
      ? combined
      : this.kernel.transform(combined, uniformScaleTransform(millimeterScale));
  }

  async exportStep(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<string> {
    try {
      return this.kernel.exportStep(this.exportShape(document, bodyIds));
    } finally {
      this.kernel.releaseAll();
    }
  }

  async exportStl(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<string> {
    try {
      return this.kernel.exportStl(
        this.exportShape(document, bodyIds),
        TESSELLATION_DEFLECTION,
        true
      );
    } finally {
      this.kernel.releaseAll();
    }
  }

  async inspectStep(data: string | ArrayBuffer): Promise<{
    solid: boolean;
    valid: boolean;
    volume: number;
  }> {
    try {
      const shape = this.kernel.importStep(data);
      const solid = this.kernel.getSubShapes(shape, 'solid').length > 0;
      return {
        solid,
        valid: solid && this.kernel.isValid(shape),
        volume: solid ? this.kernel.getVolume(shape) : 0
      };
    } finally {
      this.kernel.releaseAll();
    }
  }

  dispose(): void {
    this.kernel[Symbol.dispose]();
  }
}
