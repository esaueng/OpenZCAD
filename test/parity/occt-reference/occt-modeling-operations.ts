import type { BoundingBox, OcctKernel, ShapeHandle } from 'occt-wasm';
import type { Vec3 } from '@openzcad/geometry';

const MIN_TOLERANCE = 1e-9;
const MAX_TOLERANCE = 1e-6;
const RELATIVE_TOLERANCE = 1e-7;
const FULL_REVOLUTION = Math.PI * 2;

export interface OcctMirrorInput {
  readonly planePoint: Vec3;
  readonly planeNormal: Vec3;
}

export interface OcctShellInput {
  readonly openingFaces: readonly ShapeHandle[];
  readonly thickness: number;
}

export interface OcctSolidOffsetInput {
  /** Positive distance is outward. */
  readonly distance: number;
}

export interface OcctCylinderResizeInput {
  readonly sourceRadius: number;
  readonly sourceAxisStart: Vec3;
  readonly sourceAxisEnd: Vec3;
  readonly concavity: 'hole' | 'boss';
  readonly radius: number;
}

export interface OcctValidatedSolid {
  readonly shape: ShapeHandle;
  readonly bounds: BoundingBox;
  readonly volume: number;
  readonly scale: number;
}

interface CylinderSpan {
  readonly radius: number;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly axis: Vec3;
  readonly length: number;
}

function isFiniteVector(vector: Vec3): boolean {
  return (
    Number.isFinite(vector.x) &&
    Number.isFinite(vector.y) &&
    Number.isFinite(vector.z)
  );
}

function add(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z
  };
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z
  };
}

function scale(vector: Vec3, factor: number): Vec3 {
  return { x: vector.x * factor, y: vector.y * factor, z: vector.z * factor };
}

function length(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector: Vec3): Vec3 | null {
  const magnitude = length(vector);
  if (!Number.isFinite(magnitude) || magnitude <= MIN_TOLERANCE) {
    return null;
  }
  return scale(vector, 1 / magnitude);
}

function midpoint(left: Vec3, right: Vec3): Vec3 {
  return scale(add(left, right), 0.5);
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x
  };
}

function boundsExtents(bounds: BoundingBox): [number, number, number] {
  return [
    bounds.xmax - bounds.xmin,
    bounds.ymax - bounds.ymin,
    bounds.zmax - bounds.zmin
  ];
}

function finiteBounds(bounds: BoundingBox): boolean {
  return (
    Object.values(bounds).every(Number.isFinite) &&
    bounds.xmax >= bounds.xmin &&
    bounds.ymax >= bounds.ymin &&
    bounds.zmax >= bounds.zmin
  );
}

function operationTolerance(scaleValue: number): number {
  return Math.max(
    MIN_TOLERANCE,
    Math.min(MAX_TOLERANCE, scaleValue * RELATIVE_TOLERANCE)
  );
}

function volumeTolerance(scaleValue: number, expected: number): number {
  return Math.max(
    operationTolerance(scaleValue) ** 3,
    Math.abs(expected) * 1e-5,
    Number.EPSILON * Math.max(1, scaleValue ** 3) * 128
  );
}

/**
 * Require a single valid, closed OCCT solid with finite exact measurements.
 * BRepCheck validity on a TopAbs_SOLID includes the closed-shell requirement.
 */
export function validateOcctSolid(
  kernel: OcctKernel,
  shape: ShapeHandle,
  operation: string
): OcctValidatedSolid {
  if (!kernel.isSolid(shape) || !kernel.isValid(shape)) {
    throw new Error(`${operation} did not produce one valid closed solid.`);
  }
  if (
    kernel.subShapeCount(shape, 'shell') === 0 ||
    kernel.subShapeCount(shape, 'face') === 0
  ) {
    throw new Error(`${operation} produced an empty solid.`);
  }
  const bounds = kernel.getBoundingBox(shape, false);
  if (!finiteBounds(bounds)) {
    throw new Error(`${operation} produced non-finite bounds.`);
  }
  const extents = boundsExtents(bounds);
  const scaleValue = Math.max(...extents);
  if (!Number.isFinite(scaleValue) || scaleValue <= MIN_TOLERANCE) {
    throw new Error(`${operation} produced degenerate bounds.`);
  }
  const volume = kernel.getVolume(shape);
  if (!Number.isFinite(volume) || volume <= volumeTolerance(scaleValue, 0)) {
    throw new Error(`${operation} produced non-finite or empty volume.`);
  }
  return { shape, bounds, volume, scale: scaleValue };
}

function localFeatureSize(validated: OcctValidatedSolid): number {
  const extents = boundsExtents(validated.bounds).filter(
    (extent) => extent > operationTolerance(validated.scale)
  );
  return extents.length > 0 ? Math.min(...extents) : 0;
}

function collapseSingleSolid(
  kernel: OcctKernel,
  shape: ShapeHandle,
  operation: string
): ShapeHandle {
  if (kernel.isSolid(shape)) {
    return shape;
  }
  const solids = kernel.getSubShapes(shape, 'solid');
  if (solids.length !== 1) {
    throw new Error(`${operation} did not produce exactly one solid.`);
  }
  return solids[0]!;
}

function intersectConvexPlaneHalfSpaces(
  kernel: OcctKernel,
  source: ShapeHandle,
  before: OcctValidatedSolid,
  distance: number
): ShapeHandle {
  const faces = kernel.getSubShapes(source, 'face');
  if (
    faces.length === 0 ||
    faces.some((face) => kernel.surfaceType(face) !== 'plane')
  ) {
    throw new Error(
      'The pinned OCCT bridge exposes rounded solid offsets for curved topology; sharp intersection-join parity is currently limited to proven convex planar solids.'
    );
  }
  const center = kernel.getCenterOfMass(source);
  if (!isFiniteVector(center)) {
    throw new Error('Solid-offset source has a non-finite center of mass.');
  }
  const planes = faces.map((face) => {
    const bounds = kernel.uvBounds(face);
    const point = kernel.getSurfaceCenterOfMass(face);
    const measured = normalize(
      kernel.surfaceNormal(
        face,
        (bounds.uMin + bounds.uMax) / 2,
        (bounds.vMin + bounds.vMax) / 2
      )
    );
    if (!measured || !isFiniteVector(point)) {
      throw new Error('Solid-offset source has a degenerate planar carrier.');
    }
    const fromCenter = subtract(point, center);
    const alignment =
      fromCenter.x * measured.x +
      fromCenter.y * measured.y +
      fromCenter.z * measured.z;
    if (Math.abs(alignment) <= operationTolerance(before.scale)) {
      throw new Error(
        'Solid-offset source face orientation cannot be proven from its interior.'
      );
    }
    return {
      point,
      outward: alignment > 0 ? measured : scale(measured, -1)
    };
  });

  const buildIntersection = (planeDistance: number): ShapeHandle => {
    const margin = Math.max(before.scale, planeDistance) * 4;
    let output = kernel.makeBoxFromCorners(
      {
        x: before.bounds.xmin - margin,
        y: before.bounds.ymin - margin,
        z: before.bounds.zmin - margin
      },
      {
        x: before.bounds.xmax + margin,
        y: before.bounds.ymax + margin,
        z: before.bounds.zmax + margin
      }
    );
    for (const plane of planes) {
      const shiftedPoint = add(
        plane.point,
        scale(plane.outward, planeDistance)
      );
      const interior = kernel.halfSpace(shiftedPoint, scale(plane.outward, -1));
      output = kernel.common(output, interior);
      output = collapseSingleSolid(kernel, output, 'Solid offset');
    }
    return output;
  };

  // A convex planar solid is exactly the intersection of its inward
  // half-spaces. Prove that property at distance zero before using the same
  // construction with shifted planes; concave inputs fail closed.
  const reconstructed = validateOcctSolid(
    kernel,
    buildIntersection(0),
    'Solid-offset convexity proof'
  );
  if (
    Math.abs(reconstructed.volume - before.volume) >
    volumeTolerance(before.scale, before.volume)
  ) {
    throw new Error(
      'Sharp solid offset currently requires a proven convex planar source.'
    );
  }
  return buildIntersection(distance);
}

export function mirrorOcctSolid(
  kernel: OcctKernel,
  source: ShapeHandle,
  input: OcctMirrorInput
): ShapeHandle {
  const before = validateOcctSolid(kernel, source, 'Mirror source');
  if (!isFiniteVector(input.planePoint) || !isFiniteVector(input.planeNormal)) {
    throw new Error('Mirror plane point and normal must be finite.');
  }
  const normal = normalize(input.planeNormal);
  if (!normal) {
    throw new Error('Mirror plane normal must be non-zero.');
  }
  const output = kernel.mirror(source, input.planePoint, normal);
  const after = validateOcctSolid(kernel, output, 'Mirror');
  if (
    Math.abs(after.volume - before.volume) >
    volumeTolerance(Math.max(before.scale, after.scale), before.volume)
  ) {
    throw new Error('Mirror changed the source solid volume.');
  }
  return output;
}

export function shellOcctSolid(
  kernel: OcctKernel,
  source: ShapeHandle,
  input: OcctShellInput
): ShapeHandle {
  const before = validateOcctSolid(kernel, source, 'Shell source');
  if (!Number.isFinite(input.thickness) || input.thickness <= 0) {
    throw new Error('Shell thickness must be finite and greater than zero.');
  }
  if (input.openingFaces.length === 0) {
    throw new Error('Shell requires at least one opening face.');
  }
  if (
    input.openingFaces.some((face, index) =>
      input.openingFaces
        .slice(index + 1)
        .some((candidate) => kernel.isSame(face, candidate))
    )
  ) {
    throw new Error('Shell opening faces must resolve uniquely.');
  }
  const sourceFaces = kernel.getSubShapes(source, 'face');
  if (
    input.openingFaces.some(
      (face) => !sourceFaces.some((candidate) => kernel.isSame(face, candidate))
    )
  ) {
    throw new Error('Shell opening face does not belong to the source solid.');
  }
  const featureSize = localFeatureSize(before);
  if (
    featureSize <= 0 ||
    input.thickness >= featureSize / 2 - operationTolerance(before.scale)
  ) {
    throw new Error('Shell thickness is at or beyond the local feature size.');
  }
  let output: ShapeHandle;
  try {
    output = kernel.shell(
      source,
      [...input.openingFaces],
      input.thickness,
      operationTolerance(before.scale)
    );
  } catch {
    throw new Error(
      'Shell failed because the requested thickness self-intersects or cannot be constructed.'
    );
  }
  const after = validateOcctSolid(kernel, output, 'Shell');
  if (
    after.volume >=
    before.volume - volumeTolerance(before.scale, before.volume)
  ) {
    throw new Error('Positive shell thickness did not remove interior volume.');
  }
  return output;
}

export function offsetOcctSolid(
  kernel: OcctKernel,
  source: ShapeHandle,
  input: OcctSolidOffsetInput
): ShapeHandle {
  const before = validateOcctSolid(kernel, source, 'Solid-offset source');
  if (!Number.isFinite(input.distance) || input.distance <= 0) {
    throw new Error('Solid offset must be finite and greater than zero.');
  }
  const featureSize = localFeatureSize(before);
  if (
    featureSize <= 0 ||
    input.distance >= featureSize - operationTolerance(before.scale)
  ) {
    throw new Error('Solid offset is at or beyond the local feature size.');
  }
  const output = intersectConvexPlaneHalfSpaces(
    kernel,
    source,
    before,
    input.distance
  );
  const after = validateOcctSolid(kernel, output, 'Solid offset');
  if (
    after.volume <=
    before.volume + volumeTolerance(before.scale, before.volume)
  ) {
    throw new Error('Positive solid offset did not grow outward.');
  }
  return output;
}

function cylinderFrame(origin: Vec3, zAxis: Vec3): number[] {
  const reference =
    Math.abs(zAxis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const xAxis = normalize(cross(reference, zAxis));
  if (!xAxis) {
    throw new Error('Could not construct the cylinder coordinate frame.');
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

function cylinderAlongSpan(
  kernel: OcctKernel,
  start: Vec3,
  end: Vec3,
  radius: number,
  extendStart = 0,
  extendEnd = 0
): ShapeHandle {
  const vector = subtract(end, start);
  const axis = normalize(vector);
  const axialLength = length(vector);
  if (!axis || axialLength <= MIN_TOLERANCE) {
    throw new Error('Cylinder axis span is degenerate.');
  }
  const origin = subtract(start, scale(axis, extendStart));
  const local = kernel.makeCylinder(
    radius,
    axialLength + extendStart + extendEnd
  );
  return kernel.transform(local, cylinderFrame(origin, axis));
}

function readCylinderSpan(
  kernel: OcctKernel,
  face: ShapeHandle
): CylinderSpan | null {
  if (kernel.surfaceType(face) !== 'cylinder') {
    return null;
  }
  const cylinder = kernel.getFaceCylinderData(face);
  const bounds = kernel.uvBounds(face);
  if (
    !cylinder ||
    !Number.isFinite(cylinder.radius) ||
    cylinder.radius <= MIN_TOLERANCE ||
    Math.abs(Math.abs(bounds.uMax - bounds.uMin) - FULL_REVOLUTION) > 1e-5
  ) {
    return null;
  }
  const oppositeU = bounds.uMin + Math.PI;
  const start = midpoint(
    kernel.pointOnSurface(face, bounds.uMin, bounds.vMin),
    kernel.pointOnSurface(face, oppositeU, bounds.vMin)
  );
  const end = midpoint(
    kernel.pointOnSurface(face, bounds.uMin, bounds.vMax),
    kernel.pointOnSurface(face, oppositeU, bounds.vMax)
  );
  const vector = subtract(end, start);
  const axis = normalize(vector);
  const axialLength = length(vector);
  if (!axis || axialLength <= MIN_TOLERANCE) {
    return null;
  }
  return { radius: cylinder.radius, start, end, axis, length: axialLength };
}

function spansMatch(
  leftStart: Vec3,
  leftEnd: Vec3,
  rightStart: Vec3,
  rightEnd: Vec3,
  tolerance: number
): boolean {
  const aligned = Math.max(
    length(subtract(leftStart, rightStart)),
    length(subtract(leftEnd, rightEnd))
  );
  const reversed = Math.max(
    length(subtract(leftStart, rightEnd)),
    length(subtract(leftEnd, rightStart))
  );
  return Math.min(aligned, reversed) <= tolerance;
}

function matchingCylinderFaces(
  kernel: OcctKernel,
  owner: ShapeHandle,
  radius: number,
  source: CylinderSpan,
  tolerance: number
): ShapeHandle[] {
  return kernel.getSubShapes(owner, 'face').filter((face) => {
    const candidate = readCylinderSpan(kernel, face);
    return (
      candidate !== null &&
      Math.abs(candidate.radius - radius) <= tolerance &&
      spansMatch(
        candidate.start,
        candidate.end,
        source.start,
        source.end,
        tolerance
      )
    );
  });
}

/**
 * Resize one proven complete cylindrical carrier over its recorded bounded
 * axial span. The replacement boolean is volume-gated and the returned wall
 * must still be one exact analytic cylinder at the requested radius.
 */
export function resizeOcctAnalyticCylinder(
  kernel: OcctKernel,
  owner: ShapeHandle,
  face: ShapeHandle,
  input: OcctCylinderResizeInput
): ShapeHandle {
  const sourceOwner = collapseSingleSolid(
    kernel,
    owner,
    'Cylindrical-resize source'
  );
  const before = validateOcctSolid(
    kernel,
    sourceOwner,
    'Cylindrical-resize source'
  );
  const source = readCylinderSpan(kernel, face);
  if (!source) {
    throw new Error('Selected face is not one complete bounded cylinder.');
  }
  if (
    !Number.isFinite(input.sourceRadius) ||
    !Number.isFinite(input.radius) ||
    !isFiniteVector(input.sourceAxisStart) ||
    !isFiniteVector(input.sourceAxisEnd)
  ) {
    throw new Error('Cylindrical resize measurements must be finite.');
  }
  const tolerance = Math.max(
    operationTolerance(before.scale),
    source.radius * 1e-6,
    source.length * 1e-6
  );
  if (
    Math.abs(source.radius - input.sourceRadius) > tolerance ||
    !spansMatch(
      source.start,
      source.end,
      input.sourceAxisStart,
      input.sourceAxisEnd,
      tolerance
    )
  ) {
    throw new Error(
      'Selected cylinder no longer matches its recorded radius and axial span.'
    );
  }
  if (input.radius <= tolerance) {
    throw new Error('Cylinder radius must be greater than zero.');
  }
  if (Math.abs(input.radius - source.radius) <= tolerance) {
    throw new Error('Radius must differ from the current radius.');
  }
  if (input.radius >= before.scale) {
    throw new Error('Cylinder radius is at or beyond the source body scale.');
  }

  const reversed = kernel.shapeOrientation(face) === 'reversed';
  if ((input.concavity === 'hole') !== reversed) {
    throw new Error(
      'Selected cylinder no longer matches its recorded hole or boss concavity.'
    );
  }

  const probe = Math.max(
    tolerance * 10,
    source.radius * 0.02,
    source.length * 0.01
  );
  const beforeStart = subtract(source.start, scale(source.axis, probe));
  const afterEnd = add(source.end, scale(source.axis, probe));
  const opensBefore = !kernel.containsPoint(
    sourceOwner,
    beforeStart,
    tolerance
  );
  const opensAfter = !kernel.containsPoint(sourceOwner, afterEnd, tolerance);
  if (input.concavity === 'hole') {
    const center = midpoint(source.start, source.end);
    if (
      kernel.containsPoint(sourceOwner, center, tolerance) ||
      (!opensBefore && !opensAfter)
    ) {
      throw new Error(
        'Selected hole is not proven open over a through or blind bounded span.'
      );
    }
  }

  const extension = Math.max(
    tolerance * 10,
    source.length * 0.02,
    input.radius * 0.01
  );
  const exactOld = cylinderAlongSpan(
    kernel,
    source.start,
    source.end,
    source.radius
  );
  const exactNew = cylinderAlongSpan(
    kernel,
    source.start,
    source.end,
    input.radius,
    input.concavity === 'hole' && opensBefore ? extension : 0,
    input.concavity === 'hole' && opensAfter ? extension : 0
  );
  let output: ShapeHandle;
  if (input.concavity === 'hole') {
    if (input.radius > source.radius) {
      output = kernel.cut(sourceOwner, exactNew);
    } else {
      const exactNewBounded = cylinderAlongSpan(
        kernel,
        source.start,
        source.end,
        input.radius
      );
      const annulus = kernel.cut(exactOld, exactNewBounded);
      output = kernel.fuse(sourceOwner, annulus);
    }
  } else if (input.radius > source.radius) {
    output = kernel.fuse(sourceOwner, exactNew);
  } else {
    const annulus = kernel.cut(exactOld, exactNew);
    output = kernel.cut(sourceOwner, annulus);
  }
  output = kernel.unifySameDomain(output);
  output = collapseSingleSolid(kernel, output, 'Cylindrical resize');
  const after = validateOcctSolid(kernel, output, 'Cylindrical resize');
  const sign = input.concavity === 'hole' ? -1 : 1;
  const expectedVolume =
    before.volume +
    sign * Math.PI * (input.radius ** 2 - source.radius ** 2) * source.length;
  if (
    expectedVolume <= 0 ||
    Math.abs(after.volume - expectedVolume) >
      volumeTolerance(Math.max(before.scale, after.scale), expectedVolume)
  ) {
    throw new Error(
      'Cylindrical resize intersected other topology or changed the wrong bounded span.'
    );
  }
  const analyticMatches = matchingCylinderFaces(
    kernel,
    output,
    input.radius,
    source,
    tolerance
  );
  if (analyticMatches.length !== 1) {
    throw new Error(
      `Cylindrical resize expected one analytic cylinder at radius ${input.radius} and found ${analyticMatches.length}.`
    );
  }
  return output;
}
