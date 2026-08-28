/**
 * Test-only STEP investigation probes for guided reconstruction. The helper
 * keeps live kernel handles out of product code and reports measurements only;
 * it does not infer feature intent or mutate an imported solid.
 */
import { queryOpposingPlanarFacePairs } from '../../packages/kernel-adapter/src/exact-face-distance';
import { measureFaceGeometry } from '../../packages/kernel-adapter/src/exact-measure';
import { importStepWithOwnBudget } from '../../packages/kernel-adapter/src/exact-shape-utils';
import type { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';

const ANALYTIC_SURFACE_TYPES = new Set([
  'plane',
  'cylinder',
  'cone',
  'sphere',
  'torus'
]);
const DEFAULT_LINEAR_TOLERANCE = 1e-5;
const DEFAULT_RELATIVE_TOLERANCE = 1e-6;
const MAX_SYMMETRY_CANDIDATES = 256;

export interface MeasurementPoint {
  x: number;
  y: number;
  z: number;
}

export interface AnalyticFaceMeasurement {
  face: number;
  surfaceType: string;
  analytic: boolean;
  area: number;
  center: MeasurementPoint;
  vertices: readonly MeasurementPoint[];
  parameters?: Readonly<Record<string, unknown>>;
  normal?: MeasurementPoint;
  planeOffset?: number;
  radius?: number;
  axisStart?: MeasurementPoint;
  axisEnd?: MeasurementPoint;
  apex?: MeasurementPoint;
  axis?: MeasurementPoint;
  halfAngle?: number;
  torusCenter?: MeasurementPoint;
  majorRadius?: number;
  minorRadius?: number;
}

export interface AnalyticInventory {
  totalFaces: number;
  analyticFaces: number;
  bySurfaceType: Readonly<Record<string, number>>;
  faces: readonly AnalyticFaceMeasurement[];
}

export interface ReflectionSymmetryMeasurement {
  planeNormal: MeasurementPoint;
  planeOffset: number;
  matchedAnalyticFaces: number;
  unmatchedAnalyticFaces: number;
  analyticCoverage: number;
  facePairs: readonly (readonly [number, number])[];
}

export interface ParallelPlaneSpacingMeasurement {
  faceA: number;
  faceB: number;
  distance: number;
  faceAreaA: number;
  faceAreaB: number;
  normal: readonly [number, number, number];
  opposing: boolean;
  overlapArea?: number;
  bordersBlend?: boolean;
}

export interface ImportedStepMeasurement {
  solid: number;
  faceCount: number;
  edgeCount: number;
  volume: number;
  validationErrors: number;
  bounds: {
    min: MeasurementPoint;
    max: MeasurementPoint;
  };
  inventory: AnalyticInventory;
  reflectionSymmetries: readonly ReflectionSymmetryMeasurement[];
  parallelPlaneSpacings: readonly ParallelPlaneSpacingMeasurement[];
}

export interface DirectionalDeviationMeasurement {
  samples: number;
  maximum: number;
  rms: number;
}

export interface RuledEdgeSweepDeviationMeasurement {
  railEdges: readonly [number, number];
  candidateToWitness: DirectionalDeviationMeasurement;
  witnessToCandidate: DirectionalDeviationMeasurement;
  maximum: number;
  rms: number;
}

export interface ReconstructionMeasurementOptions {
  linearTolerance?: number;
  relativeTolerance?: number;
  maxSymmetries?: number;
}

export interface RuledEdgeSweepDeviationOptions {
  edgeDeflection?: number;
  faceDeflection?: number;
  samplesPerRail?: number;
}

interface ReflectionPlane {
  normal: MeasurementPoint;
  offset: number;
}

function point(values: ArrayLike<number>, offset = 0): MeasurementPoint {
  return {
    x: Number(values[offset]),
    y: Number(values[offset + 1]),
    z: Number(values[offset + 2])
  };
}

function add(
  left: MeasurementPoint,
  right: MeasurementPoint
): MeasurementPoint {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(
  left: MeasurementPoint,
  right: MeasurementPoint
): MeasurementPoint {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scale(value: MeasurementPoint, factor: number): MeasurementPoint {
  return { x: value.x * factor, y: value.y * factor, z: value.z * factor };
}

function dot(left: MeasurementPoint, right: MeasurementPoint): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function magnitude(value: MeasurementPoint): number {
  return Math.hypot(value.x, value.y, value.z);
}

function normalize(value: MeasurementPoint): MeasurementPoint | null {
  const length = magnitude(value);
  return length > Number.EPSILON ? scale(value, 1 / length) : null;
}

function canonicalDirection(value: MeasurementPoint): MeasurementPoint {
  for (const component of [value.x, value.y, value.z]) {
    if (Math.abs(component) <= Number.EPSILON) continue;
    return component < 0 ? scale(value, -1) : value;
  }
  return value;
}

function distance(left: MeasurementPoint, right: MeasurementPoint): number {
  return magnitude(subtract(left, right));
}

function lerp(
  start: MeasurementPoint,
  end: MeasurementPoint,
  fraction: number
): MeasurementPoint {
  return add(start, scale(subtract(end, start), fraction));
}

function reflectPoint(
  value: MeasurementPoint,
  plane: ReflectionPlane
): MeasurementPoint {
  return subtract(
    value,
    scale(plane.normal, 2 * (dot(plane.normal, value) - plane.offset))
  );
}

function reflectVector(
  value: MeasurementPoint,
  plane: ReflectionPlane
): MeasurementPoint {
  return subtract(value, scale(plane.normal, 2 * dot(plane.normal, value)));
}

function closeNumber(
  left: number,
  right: number,
  linearTolerance: number,
  relativeTolerance: number
): boolean {
  return (
    Math.abs(left - right) <=
    Math.max(
      linearTolerance,
      Math.max(Math.abs(left), Math.abs(right)) * relativeTolerance
    )
  );
}

function readAnalyticParameters(
  kernel: RemusKernel,
  face: number
): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(kernel.getAnalyticSurfaceParams(face));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function faceVertices(
  kernel: RemusKernel,
  face: number
): readonly MeasurementPoint[] {
  const seen = new Set<number>();
  const vertices: MeasurementPoint[] = [];
  for (const edge of kernel.getFaceEdges(face)) {
    for (const vertex of kernel.getEdgeVertexHandles(edge)) {
      if (seen.has(vertex)) continue;
      seen.add(vertex);
      vertices.push(point(kernel.getVertexPosition(vertex)));
    }
  }
  return vertices.sort((left, right) =>
    left.x !== right.x
      ? left.x - right.x
      : left.y !== right.y
        ? left.y - right.y
        : left.z - right.z
  );
}

export function measureAnalyticInventory(
  kernel: RemusKernel,
  solid: number
): AnalyticInventory {
  const bySurfaceType: Record<string, number> = {};
  const faces = Array.from(kernel.getSolidFaces(solid), (face) => {
    const geometry = measureFaceGeometry(kernel, face);
    if (!geometry) {
      throw new Error(`Face ${face} could not be measured.`);
    }
    bySurfaceType[geometry.surfaceType] =
      (bySurfaceType[geometry.surfaceType] ?? 0) + 1;
    const parameters = readAnalyticParameters(kernel, face);
    return {
      face,
      surfaceType: geometry.surfaceType,
      analytic: ANALYTIC_SURFACE_TYPES.has(geometry.surfaceType),
      area: geometry.area,
      center: geometry.center,
      vertices: faceVertices(kernel, face),
      ...(parameters ? { parameters } : {}),
      ...(geometry.normal ? { normal: geometry.normal } : {}),
      ...(geometry.planeOffset === undefined
        ? {}
        : { planeOffset: geometry.planeOffset }),
      ...(geometry.radius === undefined ? {} : { radius: geometry.radius }),
      ...(geometry.axisStart ? { axisStart: geometry.axisStart } : {}),
      ...(geometry.axisEnd ? { axisEnd: geometry.axisEnd } : {}),
      ...(geometry.apex ? { apex: geometry.apex } : {}),
      ...(geometry.axis ? { axis: geometry.axis } : {}),
      ...(geometry.halfAngle === undefined
        ? {}
        : { halfAngle: geometry.halfAngle }),
      ...(geometry.torusCenter ? { torusCenter: geometry.torusCenter } : {}),
      ...(geometry.majorRadius === undefined
        ? {}
        : { majorRadius: geometry.majorRadius }),
      ...(geometry.minorRadius === undefined
        ? {}
        : { minorRadius: geometry.minorRadius })
    } satisfies AnalyticFaceMeasurement;
  });
  return {
    totalFaces: faces.length,
    analyticFaces: faces.filter((face) => face.analytic).length,
    bySurfaceType: Object.fromEntries(
      Object.entries(bySurfaceType).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ),
    faces
  };
}

function pointsMatch(
  reflected: readonly MeasurementPoint[],
  candidates: readonly MeasurementPoint[],
  tolerance: number
): boolean {
  if (reflected.length !== candidates.length) return false;
  const unused = new Set(candidates.map((_, index) => index));
  for (const source of reflected) {
    const match = [...unused].find(
      (index) => distance(source, candidates[index]!) <= tolerance
    );
    if (match === undefined) return false;
    unused.delete(match);
  }
  return true;
}

function unorientedVectorsMatch(
  reflected: MeasurementPoint,
  candidate: MeasurementPoint,
  angularTolerance: number
): boolean {
  const left = normalize(reflected);
  const right = normalize(candidate);
  return Boolean(
    left && right && Math.abs(dot(left, right)) >= 1 - angularTolerance
  );
}

function optionalPointsMatch(
  reflected: MeasurementPoint | undefined,
  candidate: MeasurementPoint | undefined,
  tolerance: number
): boolean {
  return reflected === undefined && candidate === undefined
    ? true
    : Boolean(
        reflected && candidate && distance(reflected, candidate) <= tolerance
      );
}

function reflectedFaceMatches(
  source: AnalyticFaceMeasurement,
  candidate: AnalyticFaceMeasurement,
  plane: ReflectionPlane,
  linearTolerance: number,
  relativeTolerance: number
): boolean {
  if (
    source.surfaceType !== candidate.surfaceType ||
    !closeNumber(
      source.area,
      candidate.area,
      linearTolerance * linearTolerance,
      relativeTolerance
    ) ||
    distance(reflectPoint(source.center, plane), candidate.center) >
      linearTolerance ||
    !pointsMatch(
      source.vertices.map((vertex) => reflectPoint(vertex, plane)),
      candidate.vertices,
      linearTolerance
    )
  ) {
    return false;
  }
  const angularTolerance = Math.max(relativeTolerance * 10, 1e-8);
  if (
    source.normal &&
    candidate.normal &&
    !unorientedVectorsMatch(
      reflectVector(source.normal, plane),
      candidate.normal,
      angularTolerance
    )
  ) {
    return false;
  }
  if (
    source.radius !== undefined &&
    candidate.radius !== undefined &&
    !closeNumber(
      source.radius,
      candidate.radius,
      linearTolerance,
      relativeTolerance
    )
  ) {
    return false;
  }
  const sourceAxisStart = source.axisStart
    ? reflectPoint(source.axisStart, plane)
    : undefined;
  const sourceAxisEnd = source.axisEnd
    ? reflectPoint(source.axisEnd, plane)
    : undefined;
  if (
    sourceAxisStart ||
    sourceAxisEnd ||
    candidate.axisStart ||
    candidate.axisEnd
  ) {
    const direct =
      optionalPointsMatch(
        sourceAxisStart,
        candidate.axisStart,
        linearTolerance
      ) &&
      optionalPointsMatch(sourceAxisEnd, candidate.axisEnd, linearTolerance);
    const reversed =
      optionalPointsMatch(
        sourceAxisStart,
        candidate.axisEnd,
        linearTolerance
      ) &&
      optionalPointsMatch(sourceAxisEnd, candidate.axisStart, linearTolerance);
    if (!direct && !reversed) return false;
  }
  for (const [sourcePoint, candidatePoint] of [
    [source.apex, candidate.apex],
    [source.torusCenter, candidate.torusCenter]
  ] as const) {
    if (
      !optionalPointsMatch(
        sourcePoint ? reflectPoint(sourcePoint, plane) : undefined,
        candidatePoint,
        linearTolerance
      )
    ) {
      return false;
    }
  }
  if (
    source.axis &&
    candidate.axis &&
    !unorientedVectorsMatch(
      reflectVector(source.axis, plane),
      candidate.axis,
      angularTolerance
    )
  ) {
    return false;
  }
  for (const [left, right] of [
    [source.halfAngle, candidate.halfAngle],
    [source.majorRadius, candidate.majorRadius],
    [source.minorRadius, candidate.minorRadius]
  ] as const) {
    if (
      left !== undefined &&
      right !== undefined &&
      !closeNumber(left, right, linearTolerance, relativeTolerance)
    ) {
      return false;
    }
  }
  return true;
}

function addCandidate(
  candidates: ReflectionPlane[],
  normalValue: MeasurementPoint,
  offsetValue: number,
  tolerance: number
): void {
  const normalized = normalize(normalValue);
  if (!normalized || !Number.isFinite(offsetValue)) return;
  const normal = canonicalDirection(normalized);
  const offset = dot(normal, normalized) < 0 ? -offsetValue : offsetValue;
  if (
    candidates.some(
      (candidate) =>
        Math.abs(dot(candidate.normal, normal) - 1) <= 1e-8 &&
        Math.abs(candidate.offset - offset) <= tolerance
    )
  ) {
    return;
  }
  if (candidates.length < MAX_SYMMETRY_CANDIDATES) {
    candidates.push({ normal, offset });
  }
}

function reflectionCandidates(
  inventory: AnalyticInventory,
  bounds: ImportedStepMeasurement['bounds'],
  linearTolerance: number,
  relativeTolerance: number
): ReflectionPlane[] {
  const candidates: ReflectionPlane[] = [];
  const midpoint = scale(add(bounds.min, bounds.max), 0.5);
  for (const normal of [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 }
  ]) {
    addCandidate(candidates, normal, dot(normal, midpoint), linearTolerance);
  }
  const faces = inventory.faces.filter((face) => face.analytic);
  for (let first = 0; first < faces.length; first += 1) {
    for (let second = first + 1; second < faces.length; second += 1) {
      const left = faces[first]!;
      const right = faces[second]!;
      if (
        left.surfaceType !== right.surfaceType ||
        !closeNumber(
          left.area,
          right.area,
          linearTolerance * linearTolerance,
          relativeTolerance
        )
      ) {
        continue;
      }
      const normal = normalize(subtract(right.center, left.center));
      if (!normal) continue;
      const pairMidpoint = scale(add(left.center, right.center), 0.5);
      addCandidate(
        candidates,
        normal,
        dot(normal, pairMidpoint),
        linearTolerance
      );
    }
  }
  return candidates;
}

export function detectReflectionSymmetries(
  inventory: AnalyticInventory,
  bounds: ImportedStepMeasurement['bounds'],
  options: ReconstructionMeasurementOptions = {}
): readonly ReflectionSymmetryMeasurement[] {
  const linearTolerance = options.linearTolerance ?? DEFAULT_LINEAR_TOLERANCE;
  const relativeTolerance =
    options.relativeTolerance ?? DEFAULT_RELATIVE_TOLERANCE;
  const maxSymmetries = options.maxSymmetries ?? 8;
  const faces = inventory.faces.filter((face) => face.analytic);
  if (faces.length === 0) return [];
  const measurements = reflectionCandidates(
    inventory,
    bounds,
    linearTolerance,
    relativeTolerance
  ).map((plane) => {
    const unmatched = new Set(faces.map((_, index) => index));
    const facePairs: Array<readonly [number, number]> = [];
    for (let sourceIndex = 0; sourceIndex < faces.length; sourceIndex += 1) {
      if (!unmatched.has(sourceIndex)) continue;
      const source = faces[sourceIndex]!;
      const candidateIndex = [...unmatched].find((index) =>
        reflectedFaceMatches(
          source,
          faces[index]!,
          plane,
          linearTolerance,
          relativeTolerance
        )
      );
      if (candidateIndex === undefined) continue;
      unmatched.delete(sourceIndex);
      unmatched.delete(candidateIndex);
      facePairs.push([source.face, faces[candidateIndex]!.face]);
    }
    const matchedAnalyticFaces = faces.length - unmatched.size;
    return {
      planeNormal: plane.normal,
      planeOffset: plane.offset,
      matchedAnalyticFaces,
      unmatchedAnalyticFaces: unmatched.size,
      analyticCoverage: matchedAnalyticFaces / faces.length,
      facePairs
    } satisfies ReflectionSymmetryMeasurement;
  });
  return measurements
    .filter((measurement) => measurement.matchedAnalyticFaces >= 2)
    .sort(
      (left, right) =>
        right.matchedAnalyticFaces - left.matchedAnalyticFaces ||
        left.unmatchedAnalyticFaces - right.unmatchedAnalyticFaces ||
        left.planeNormal.x - right.planeNormal.x ||
        left.planeNormal.y - right.planeNormal.y ||
        left.planeNormal.z - right.planeNormal.z ||
        left.planeOffset - right.planeOffset
    )
    .slice(0, maxSymmetries);
}

function canonicalPlane(
  face: AnalyticFaceMeasurement
): { normal: MeasurementPoint; offset: number } | null {
  if (!face.normal || face.planeOffset === undefined) return null;
  const normalized = normalize(face.normal);
  if (!normalized) return null;
  const normal = canonicalDirection(normalized);
  const offset =
    (dot(normal, normalized) < 0 ? -face.planeOffset : face.planeOffset) /
    magnitude(face.normal);
  return { normal, offset };
}

function pairKey(faceA: number, faceB: number): string {
  return faceA < faceB ? `${faceA}:${faceB}` : `${faceB}:${faceA}`;
}

export function measureParallelPlaneSpacings(
  kernel: RemusKernel,
  solid: number,
  inventory: AnalyticInventory,
  linearTolerance = DEFAULT_LINEAR_TOLERANCE
): readonly ParallelPlaneSpacingMeasurement[] {
  const measurements = new Map<string, ParallelPlaneSpacingMeasurement>();
  for (const pair of queryOpposingPlanarFacePairs(kernel, solid)) {
    measurements.set(pairKey(pair.faceA, pair.faceB), {
      faceA: pair.faceA,
      faceB: pair.faceB,
      distance: pair.distance,
      overlapArea: pair.overlapArea,
      faceAreaA: pair.faceAreaA,
      faceAreaB: pair.faceAreaB,
      normal: pair.normal,
      opposing: true,
      bordersBlend: pair.faceABordersBlend || pair.faceBBordersBlend
    });
  }
  const planes = inventory.faces.filter(
    (face) => face.surfaceType === 'plane' && canonicalPlane(face)
  );
  for (let first = 0; first < planes.length; first += 1) {
    for (let second = first + 1; second < planes.length; second += 1) {
      const left = planes[first]!;
      const right = planes[second]!;
      const key = pairKey(left.face, right.face);
      if (measurements.has(key)) continue;
      const leftPlane = canonicalPlane(left)!;
      const rightPlane = canonicalPlane(right)!;
      if (Math.abs(dot(leftPlane.normal, rightPlane.normal) - 1) > 1e-8) {
        continue;
      }
      const spacing = Math.abs(leftPlane.offset - rightPlane.offset);
      if (spacing <= linearTolerance) continue;
      measurements.set(key, {
        faceA: left.face,
        faceB: right.face,
        distance: spacing,
        faceAreaA: left.area,
        faceAreaB: right.area,
        normal: [leftPlane.normal.x, leftPlane.normal.y, leftPlane.normal.z],
        opposing: false
      });
    }
  }
  return [...measurements.values()].sort(
    (left, right) =>
      Number(right.opposing) - Number(left.opposing) ||
      (right.overlapArea ?? Math.min(right.faceAreaA, right.faceAreaB)) *
        Math.max(right.faceAreaA, right.faceAreaB) -
        (left.overlapArea ?? Math.min(left.faceAreaA, left.faceAreaB)) *
          Math.max(left.faceAreaA, left.faceAreaB) ||
      left.distance - right.distance ||
      left.faceA - right.faceA ||
      left.faceB - right.faceB
  );
}

function resamplePolyline(
  polyline: readonly MeasurementPoint[],
  sampleCount: number
): readonly MeasurementPoint[] {
  if (polyline.length < 2) {
    throw new Error('Edge sweep rail has fewer than two sampled points.');
  }
  const cumulative = [0];
  for (let index = 1; index < polyline.length; index += 1) {
    cumulative.push(
      cumulative[index - 1]! + distance(polyline[index - 1]!, polyline[index]!)
    );
  }
  const total = cumulative.at(-1)!;
  if (total <= Number.EPSILON) {
    throw new Error('Edge sweep rail has zero sampled length.');
  }
  return Array.from({ length: sampleCount }, (_, sampleIndex) => {
    const target = (total * sampleIndex) / (sampleCount - 1);
    let segment = 1;
    while (segment < cumulative.length - 1 && cumulative[segment]! < target) {
      segment += 1;
    }
    const startDistance = cumulative[segment - 1]!;
    const endDistance = cumulative[segment]!;
    const fraction =
      endDistance === startDistance
        ? 0
        : (target - startDistance) / (endDistance - startDistance);
    return lerp(polyline[segment - 1]!, polyline[segment]!, fraction);
  });
}

function orientedEdgeSamples(
  kernel: RemusKernel,
  wire: number,
  edge: number,
  deflection: number,
  sampleCount: number
): readonly MeasurementPoint[] {
  const flat = kernel.sampleEdge(edge, deflection);
  const samples = Array.from(
    { length: Math.floor(flat.length / 3) },
    (_, index) => point(flat, index * 3)
  );
  if (!kernel.isEdgeForwardInWire(edge, wire)) samples.reverse();
  return resamplePolyline(samples, sampleCount);
}

type MeasurementTriangle = readonly [
  MeasurementPoint,
  MeasurementPoint,
  MeasurementPoint
];

function pointSegmentDistanceSquared(
  value: MeasurementPoint,
  start: MeasurementPoint,
  end: MeasurementPoint
): number {
  const segment = subtract(end, start);
  const lengthSquared = dot(segment, segment);
  if (lengthSquared <= Number.EPSILON) {
    const delta = subtract(value, start);
    return dot(delta, delta);
  }
  const fraction = Math.max(
    0,
    Math.min(1, dot(subtract(value, start), segment) / lengthSquared)
  );
  const delta = subtract(value, lerp(start, end, fraction));
  return dot(delta, delta);
}

function pointTriangleDistanceSquared(
  value: MeasurementPoint,
  [first, second, third]: MeasurementTriangle
): number {
  const ab = subtract(second, first);
  const ac = subtract(third, first);
  const ap = subtract(value, first);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dot(ap, ap);

  const bp = subtract(value, second);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dot(bp, bp);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const fraction = d1 / (d1 - d3);
    const delta = subtract(value, lerp(first, second, fraction));
    return dot(delta, delta);
  }

  const cp = subtract(value, third);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dot(cp, cp);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const fraction = d2 / (d2 - d6);
    const delta = subtract(value, lerp(first, third, fraction));
    return dot(delta, delta);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const fraction = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const delta = subtract(value, lerp(second, third, fraction));
    return dot(delta, delta);
  }

  const denominator = va + vb + vc;
  if (Math.abs(denominator) <= Number.EPSILON) {
    return Math.min(
      pointSegmentDistanceSquared(value, first, second),
      pointSegmentDistanceSquared(value, second, third),
      pointSegmentDistanceSquared(value, third, first)
    );
  }
  const inverse = 1 / denominator;
  const projection = add(
    first,
    add(scale(ab, vb * inverse), scale(ac, vc * inverse))
  );
  const delta = subtract(value, projection);
  return dot(delta, delta);
}

function directionalDeviation(
  samples: readonly MeasurementPoint[],
  triangles: readonly MeasurementTriangle[]
): DirectionalDeviationMeasurement {
  if (samples.length === 0 || triangles.length === 0) {
    throw new Error('Deviation measurement requires non-empty surface meshes.');
  }
  let maximumSquared = 0;
  let sumSquared = 0;
  for (const sample of samples) {
    let minimumSquared = Number.POSITIVE_INFINITY;
    for (const triangle of triangles) {
      minimumSquared = Math.min(
        minimumSquared,
        pointTriangleDistanceSquared(sample, triangle)
      );
    }
    maximumSquared = Math.max(maximumSquared, minimumSquared);
    sumSquared += minimumSquared;
  }
  return {
    samples: samples.length,
    maximum: Math.sqrt(maximumSquared),
    rms: Math.sqrt(sumSquared / samples.length)
  };
}

function trianglesFromIndexedMesh(
  positions: Float64Array,
  indices: Uint32Array
): {
  points: readonly MeasurementPoint[];
  triangles: readonly MeasurementTriangle[];
} {
  const points = Array.from(
    { length: Math.floor(positions.length / 3) },
    (_, index) => point(positions, index * 3)
  );
  const triangles: MeasurementTriangle[] = [];
  for (let index = 0; index < indices.length; index += 3) {
    triangles.push([
      points[indices[index]!]!,
      points[indices[index + 1]!]!,
      points[indices[index + 2]!]!
    ]);
  }
  return { points, triangles };
}

function ruledSweepMesh(
  firstRail: readonly MeasurementPoint[],
  secondRail: readonly MeasurementPoint[]
): {
  points: readonly MeasurementPoint[];
  triangles: readonly MeasurementTriangle[];
} {
  if (firstRail.length !== secondRail.length) {
    throw new Error('Edge sweep rails must use the same sampling count.');
  }
  const sampleCount = firstRail.length;
  const points: MeasurementPoint[] = [];
  for (let railIndex = 0; railIndex < sampleCount; railIndex += 1) {
    for (let sweepIndex = 0; sweepIndex < sampleCount; sweepIndex += 1) {
      points.push(
        lerp(
          firstRail[railIndex]!,
          secondRail[railIndex]!,
          sweepIndex / (sampleCount - 1)
        )
      );
    }
  }
  const triangles: MeasurementTriangle[] = [];
  for (let railIndex = 0; railIndex < sampleCount - 1; railIndex += 1) {
    for (let sweepIndex = 0; sweepIndex < sampleCount - 1; sweepIndex += 1) {
      const lowerLeft = railIndex * sampleCount + sweepIndex;
      const lowerRight = lowerLeft + 1;
      const upperLeft = lowerLeft + sampleCount;
      const upperRight = upperLeft + 1;
      triangles.push(
        [points[lowerLeft]!, points[upperLeft]!, points[upperRight]!],
        [points[lowerLeft]!, points[upperRight]!, points[lowerRight]!]
      );
    }
  }
  return { points, triangles };
}

/**
 * Rebuild a four-sided witness patch as the better of its two ruled,
 * opposite-boundary edge sweeps and report tessellation-sampled bidirectional
 * deviation. This is an investigation probe, not an equivalence proof.
 */
export function measureRuledEdgeSweepDeviation(
  kernel: RemusKernel,
  witnessFace: number,
  options: RuledEdgeSweepDeviationOptions = {}
): RuledEdgeSweepDeviationMeasurement {
  const edgeDeflection = options.edgeDeflection ?? 0.01;
  const faceDeflection = options.faceDeflection ?? 0.01;
  const samplesPerRail = options.samplesPerRail ?? 33;
  if (edgeDeflection <= 0 || faceDeflection <= 0 || samplesPerRail < 3) {
    throw new Error('Edge sweep deviation options are outside their bounds.');
  }
  const wire = kernel.getFaceOuterWire(witnessFace);
  const edges = Array.from(kernel.getWireEdges(wire));
  if (edges.length !== 4) {
    throw new Error(
      `Ruled edge sweep requires a four-sided witness face; found ${edges.length} edges.`
    );
  }
  const rails = edges.map((edge) =>
    orientedEdgeSamples(kernel, wire, edge, edgeDeflection, samplesPerRail)
  );
  const witnessMesh = kernel.tessellateFace(witnessFace, faceDeflection);
  try {
    const witness = trianglesFromIndexedMesh(
      witnessMesh.positions,
      witnessMesh.indices
    );
    const railPairs: ReadonlyArray<readonly [number, number]> = [
      [0, 2],
      [1, 3]
    ];
    const candidates = railPairs.map(([firstIndex, secondIndex]) => {
      const secondRail = [...rails[secondIndex]!].reverse();
      const candidate = ruledSweepMesh(rails[firstIndex]!, secondRail);
      const candidateToWitness = directionalDeviation(
        candidate.points,
        witness.triangles
      );
      const witnessToCandidate = directionalDeviation(
        witness.points,
        candidate.triangles
      );
      const sumSquared =
        candidateToWitness.rms ** 2 * candidateToWitness.samples +
        witnessToCandidate.rms ** 2 * witnessToCandidate.samples;
      const sampleCount =
        candidateToWitness.samples + witnessToCandidate.samples;
      return {
        railEdges: [edges[firstIndex]!, edges[secondIndex]!] as const,
        candidateToWitness,
        witnessToCandidate,
        maximum: Math.max(
          candidateToWitness.maximum,
          witnessToCandidate.maximum
        ),
        rms: Math.sqrt(sumSquared / sampleCount)
      } satisfies RuledEdgeSweepDeviationMeasurement;
    });
    return candidates.sort(
      (left, right) => left.maximum - right.maximum || left.rms - right.rms
    )[0]!;
  } finally {
    witnessMesh.free();
  }
}

export function measureImportedStep(
  kernel: RemusKernel,
  step: Uint8Array,
  options: ReconstructionMeasurementOptions = {}
): ImportedStepMeasurement {
  const solids = Array.from(importStepWithOwnBudget(kernel, step));
  if (solids.length !== 1) {
    throw new Error(
      `Reconstruction measurement requires exactly one STEP solid; found ${solids.length}.`
    );
  }
  const solid = solids[0]!;
  const rawBounds = Array.from(kernel.boundingBox(solid));
  if (rawBounds.length !== 6 || !rawBounds.every(Number.isFinite)) {
    throw new Error('Imported STEP returned invalid solid bounds.');
  }
  const bounds = { min: point(rawBounds), max: point(rawBounds, 3) };
  const inventory = measureAnalyticInventory(kernel, solid);
  const reflectionSymmetries = detectReflectionSymmetries(
    inventory,
    bounds,
    options
  );
  const parallelPlaneSpacings = measureParallelPlaneSpacings(
    kernel,
    solid,
    inventory,
    options.linearTolerance
  );
  return {
    solid,
    faceCount: inventory.totalFaces,
    edgeCount: kernel.getSolidEdges(solid).length,
    volume: kernel.volume(solid, 0.01),
    validationErrors: kernel.validateSolid(solid),
    bounds,
    inventory,
    reflectionSymmetries,
    parallelPlaneSpacings
  };
}
