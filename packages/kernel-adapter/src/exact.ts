import { BrepKernel } from 'brepkit-wasm';
import {
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  listNodesByKind,
  resolveParamValue
} from '@openzcad/document-core';
import {
  PLANE_BASES,
  circleProfile,
  polygonProfile,
  rectangleProfile,
  type PlaneBasis,
  type Vec2,
  type Vec3
} from '@openzcad/geometry';
import {
  DEFAULT_BODY_COLOR,
  featureColor,
  nowIso,
  type BodyId,
  type BodyRepresentation,
  type BodyTopology,
  type DerivedState,
  type FeatureNode,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import { OpenZCADKernel } from './index';
import { normalizeStepPlaneAnglesForKernel } from './step-import';

const TESSELLATION_DEFLECTION = 0.08;
const TESSELLATION_ANGLE = 0.35;
const CURVE_SEGMENTS = 32;
const GEOMETRY_EPSILON = 1e-9;
const ANALYTIC_MATCH_EPSILON = 1e-7;

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
  readonly kind: 'brepkit';
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

export class BrepKitKernelAdapter implements ExactKernelAdapter {
  readonly kind = 'brepkit' as const;
  private readonly legacy = new OpenZCADKernel();

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
    const sketch = findSketch(document, feature.data.sketchId);
    const objectId = sketch?.objectIds[0];
    const object = objectId ? document.nodes[objectId] : undefined;
    if (!sketch || !object || object.kind !== 'sketch-object') {
      throw new Error('Referenced sketch has no profile.');
    }
    const basis = PLANE_BASES[sketch.plane];
    const offset = resolveParamValue(sketch.offset, scope, 'sketch offset');
    const face = this.makeProfileFace(
      kernel,
      object.data,
      basis,
      offset,
      scope
    );

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
    const point = pointOnPlane(basis, { x: 0, y: 0 }, offset);
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
              solid = fuseUniformSolid(
                kernel,
                operands.flatMap((shape) => shape.solids)
              );
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
            const edges = Array.from(kernel.getSolidEdges(target));
            const selected = edges.filter((_, index) =>
              requested.has(index + 1)
            );
            if (selected.length !== requested.size) {
              throw new Error(
                `${requested.size - selected.length} selected edge(s) no longer exist.`
              );
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
              // BrepKit's fillet fallback can otherwise accept a radius larger
              // than the selected edge and return a severely distorted blend.
              if (
                feature.data.featureKind === 'fillet' &&
                selected.some(
                  (edge) =>
                    size > kernel.edgeLength(edge) / 2 + GEOMETRY_EPSILON
                )
              ) {
                throw new Error('Fillet radius exceeds the selected edge.');
              }
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
      const mesh = kernel.tessellateSolidGroupedBinary(
        solid,
        TESSELLATION_DEFLECTION,
        TESSELLATION_ANGLE
      );
      try {
        const localPositions = Array.from(mesh.positions);
        const localIndices = Array.from(mesh.indices);
        const faceOffsets = Array.from(mesh.faceOffsets);
        const vertexOffset = vertices.length / 3;
        const indexOffset = indices.length;
        vertices.push(...localPositions);
        indices.push(...localIndices.map((index) => index + vertexOffset));
        for (let index = 0; index < faceOffsets.length - 1; index += 1) {
          const start = faceOffsets[index]!;
          const end = faceOffsets[index + 1]!;
          const hash = topology.faces.length + 1;
          topology.faces.push({
            topologyId: `face:${hash}`,
            hash,
            triangleStart: (indexOffset + start) / 3,
            triangleCount: (end - start) / 3
          });
        }
      } finally {
        mesh.free();
      }

      const edgeLines = kernel.meshEdgesAll(
        solid,
        TESSELLATION_DEFLECTION,
        TESSELLATION_ANGLE
      );
      try {
        const points = Array.from(edgeLines.positions);
        const offsets = Array.from(edgeLines.offsets);
        for (let index = 0; index < offsets.length; index += 1) {
          const start = offsets[index]!;
          const end = offsets[index + 1] ?? points.length;
          const hash = topology.edges.length + 1;
          topology.edges.push({
            topologyId: `edge:${hash}`,
            hash,
            points: points.slice(start, end)
          });
        }
      } finally {
        edgeLines.free();
      }

      const bounds = kernel.boundingBox(solid);
      bbox.min.x = Math.min(bbox.min.x, bounds[0]!);
      bbox.min.y = Math.min(bbox.min.y, bounds[1]!);
      bbox.min.z = Math.min(bbox.min.z, bounds[2]!);
      bbox.max.x = Math.max(bbox.max.x, bounds[3]!);
      bbox.max.y = Math.max(bbox.max.y, bounds[4]!);
      bbox.max.z = Math.max(bbox.max.z, bounds[5]!);
      volume += kernel.volume(solid, TESSELLATION_DEFLECTION);
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
    if (
      listFeaturesInOrder(document).some(
        (feature) => feature.data.featureKind === 'imported-mesh'
      )
    ) {
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
      const exportSolid =
        solids.length === 1
          ? solids[0]!
          : kernel.fuseAll(Uint32Array.from(solids));
      return decodeText(kernel.exportStep(exportSolid));
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
      return solids
        .map((solid) =>
          decodeText(kernel.exportStlAscii(solid, TESSELLATION_DEFLECTION))
        )
        .join('\n');
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
            total + kernel.volume(solid, TESSELLATION_DEFLECTION),
          0
        )
      };
    } finally {
      kernel.free();
    }
  }

  dispose(): void {
    // Each operation owns and releases a short-lived BrepKernel instance.
  }
}

export async function createExactKernelAdapter(): Promise<ExactKernelAdapter> {
  return new BrepKitKernelAdapter();
}
