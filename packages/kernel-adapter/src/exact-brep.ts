/**
 * Read-only B-rep inspection helpers over live Remus handles: analytic
 * surface records, published edge curves, blend-face detection, and the
 * simple-cylinder reader. These functions inspect kernel state but never
 * create or mutate shapes, and they hold no document or adapter state.
 */
import type { RemusKernel } from './remus-runtime';
import { canonicalDirection } from './topology-fingerprint';
import type { Vec3 } from '@openzcad/geometry';
import type { EdgeCurve } from '@openzcad/shared';
import {
  GEOMETRY_EPSILON,
  add,
  cross,
  dot,
  finiteVec3,
  length,
  normalized,
  positiveFinite,
  scale,
  subtract
} from './exact-math';

/** Relative bar for proving a plane runs tangent to a cylindrical band. */
export const BLEND_TANGENCY_TOLERANCE = 1e-6;

export const PERIODIC_SURFACE_TYPES = new Set(['cylinder', 'cone', 'sphere', 'torus']);


export interface AnalyticCylinder {
  origin: Vec3;
  axis: Vec3;
  radius: number;
  axialMin: number;
  axialMax: number;
}

export function analyticSurfaceRecord(
  kernel: RemusKernel,
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

export function sameSphereSurface(kernel: RemusKernel, faces: number[]): boolean {
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
 * Bar for accepting a candidate circle as the edge's own geometry, as a
 * fraction of how far the edge itself reaches.
 *
 * The sampled polyline is taken off the exact curve, so a true circle's
 * residue is a few multiples of double-precision rounding and anything that
 * clears this bar is a fit rather than a near miss.
 */
export const EDGE_CIRCLE_MISFIT_TOLERANCE = 1e-6;

/**
 * How badly a candidate circle misses the edge's own sampled polyline: the
 * larger of the radial and the out-of-plane error over every sample, divided by
 * the extent of the polyline.
 *
 * Divided by the EDGE's size, never the circle's, and that is the whole point.
 * Scaling the residue by the candidate radius hands a wrong answer a tolerance
 * budget proportional to how wrong it is: the kernel's elliptical misreading is
 * a radius of 7.5e11 for a curve six units across, so against its own radius a
 * miss of several whole units scores about 4e-12 and sails through. Against the
 * edge's own six units the same miss scores 1 and is thrown out. Every
 * mismeasurement worth catching is one where the two scales disagree, which is
 * exactly the case a self-relative test cannot see.
 *
 * This is the only thing standing between a wrong analytic radius and the
 * published payload, so it fails closed: fewer than two samples, or samples
 * with no extent, is unverifiable rather than acceptable and returns infinity.
 * Exported because no fixture in the corpus is an ellipse or a spline, so
 * nothing in CI otherwise exercises the rejection path this exists for.
 */
export function edgeCircleMisfit(
  circle: { center: Vec3; axis: Vec3; radius: number },
  points: readonly number[]
): number {
  const { center, axis, radius } = circle;
  if (!Number.isFinite(radius) || radius <= GEOMETRY_EPSILON) {
    return Number.POSITIVE_INFINITY;
  }
  const samples: Vec3[] = [];
  for (let offset = 0; offset + 2 < points.length; offset += 3) {
    samples.push({
      x: points[offset] ?? 0,
      y: points[offset + 1] ?? 0,
      z: points[offset + 2] ?? 0
    });
  }
  const first = samples[0];
  if (samples.length < 2 || !first) {
    return Number.POSITIVE_INFINITY;
  }
  const extent = samples.reduce(
    (widest, sample) => Math.max(widest, length(subtract(sample, first))),
    0
  );
  if (extent <= GEOMETRY_EPSILON) {
    return Number.POSITIVE_INFINITY;
  }
  let worst = 0;
  for (const sample of samples) {
    const toSample = subtract(sample, center);
    const axial = dot(toSample, axis);
    const radial = length(subtract(toSample, scale(axis, axial)));
    worst = Math.max(
      worst,
      Math.abs(radial - radius) / extent,
      Math.abs(axial) / extent
    );
  }
  return worst;
}

/**
 * Read the circle a circular edge lies on, or `undefined` when it cannot be
 * proven.
 *
 * Curvature rather than the curve's parameters, deliberately. The obvious
 * source — `getEdgeCurveParameters` plus `evaluateEdgeCurve` across that range
 * — reports the UNDERLYING curve's domain rather than the edge's trim of it, so
 * a quarter fillet arc reads as a full turn. Curvature is constant along a
 * circle, so an untrimmed parameter cannot contaminate it: the radius is right
 * whichever point on the circle is asked, and so is the centre, because every
 * point of the underlying circle is the same distance from it.
 *
 * The caller has already gated on the kernel calling this edge a CIRCLE. That
 * gate matters — the same curvature call is silently wrong for ellipses by
 * about 1e12 — but it is not trusted on its own: the candidate is accepted only
 * once it has been checked against the edge's own sampled polyline, which no
 * mismeasured radius can fit.
 */
export function brepEdgeCircle(
  kernel: RemusKernel,
  edge: number,
  points: readonly number[]
): { center: Vec3; axis: Vec3; radius: number } | undefined {
  let curvature: number[];
  let position: number[];
  try {
    // Any parameter on the underlying circle gives the same circle. The domain
    // start is simply one the kernel is certain to accept; nothing about the
    // range itself is used, and nothing about it is published.
    const parameter = Array.from(kernel.getEdgeCurveParameters(edge))[0] ?? 0;
    curvature = Array.from(kernel.measureCurvatureAtEdge(edge, parameter));
    position = Array.from(kernel.evaluateEdgeCurve(edge, parameter));
  } catch {
    // Matching `analyticSurfaceRecord`: an invalid handle throws out of the
    // WASM boundary, and an edge the kernel will not describe is an edge with
    // no published curve rather than a failed rebuild.
    return undefined;
  }
  const curvatureValue = curvature[0];
  const measuredTangent = finiteVec3(curvature.slice(1, 4));
  // Points at the centre of curvature, which is what turns a point on the
  // circle into the circle's centre.
  const measuredInward = finiteVec3(curvature.slice(4, 7));
  const anchor = finiteVec3(position.slice(0, 3));
  if (
    typeof curvatureValue !== 'number' ||
    !Number.isFinite(curvatureValue) ||
    curvatureValue <= GEOMETRY_EPSILON ||
    !measuredTangent ||
    !measuredInward ||
    !anchor
  ) {
    return undefined;
  }
  const tangent = normalized(measuredTangent);
  const inward = normalized(measuredInward);
  if (!tangent || !inward) {
    return undefined;
  }
  const axis = normalized(cross(tangent, inward));
  if (!axis) {
    return undefined;
  }
  const radius = 1 / curvatureValue;
  const circle = {
    center: add(anchor, scale(inward, radius)),
    // The Frenet frame's sign follows the parameterization phase, which is not
    // stable across rebuilds; the published axis is the plane's unoriented
    // normal, so it is canonicalized like every other direction in a payload.
    axis: canonicalDirection(axis),
    radius
  };
  return edgeCircleMisfit(circle, points) <= EDGE_CIRCLE_MISFIT_TOLERANCE
    ? circle
    : undefined;
}

/**
 * Describe the exact curve under an edge: always its type, plus analytic data
 * for circles.
 *
 * Circles only because they are what the viewport needs and what the kernel
 * can be held to. The type alone is still worth publishing for the rest — it
 * is how a consumer tells a straight edge from a curved one without measuring
 * chords.
 *
 * Exported for the same reason `edgeCircleMisfit` is: no document primitive
 * produces an elliptical edge, so the only way to hold the CIRCLE gate against
 * a real ellipse is to build one on a bare kernel and hand it to this.
 */
export function brepEdgeCurve(
  kernel: RemusKernel,
  edge: number,
  points: readonly number[]
): EdgeCurve | undefined {
  let type: string;
  try {
    type = kernel.getEdgeCurveType(edge);
  } catch {
    return undefined;
  }
  if (typeof type !== 'string' || type.length === 0) {
    return undefined;
  }
  if (type !== 'CIRCLE') {
    return { type };
  }
  const circle = brepEdgeCircle(kernel, edge, points);
  // A circle that could not be proven still publishes its type. The field
  // narrows; it never lies.
  return circle ? { type, circle } : { type };
}

/**
 * Translate the kernel's edge-to-face map into the face hashes the topology
 * payload publishes, sorted ascending.
 *
 * Sorted because `edgeToFaceMap`'s order is kernel-determined: the parity
 * corpus digests hashes only after sorting, so an unsorted array would pass
 * every existing test while making rebuild output non-reproducible.
 *
 * Multiplicity is preserved — a seam edge lists its one face twice. Returns
 * `undefined` rather than an empty array when the kernel reports no owners, so
 * the field is simply absent instead of asserting an edge bounds nothing.
 */
export function brepAdjacentFaceHashes(
  edge: number,
  edgeToFaces: Record<string, number[]>,
  faceHashByHandle: ReadonlyMap<number, number>
): number[] | undefined {
  const owners = edgeToFaces[String(edge)];
  if (!Array.isArray(owners) || owners.length === 0) {
    return undefined;
  }
  const hashes = owners.map((handle) => {
    const hash = faceHashByHandle.get(handle);
    if (hash === undefined) {
      // Guarded like the face/tessellation coupling above: an owner outside
      // this solid's own face set means the two kernel calls disagree about
      // what the solid contains, and publishing a partial array would hide it.
      throw new Error(
        `Edge ${edge} names face handle ${handle}, which is not among this solid's faces.`
      );
    }
    return hash;
  });
  return hashes.sort((left, right) => left - right);
}

/**
 * The two vertices an edge runs between, renumbered into the body-scoped ids
 * `EdgeTopology.vertexIds` publishes.
 *
 * Read straight from the kernel rather than derived from positions. Quantizing
 * endpoints at the ADR-011 quantum was measured against these handles and does
 * not work — `test/vertex-identity.test.ts` carries the numbers, the decisive
 * one being that a closed edge's display polyline begins a quarter turn away
 * from its own vertex.
 *
 * NOT sorted, unlike the face hashes above. The order is the edge's own
 * start-then-end, which is the direction `points` is sampled in and is
 * reproducible for that reason; sorting would discard which end is which. A
 * closed edge names one vertex twice and keeps both entries.
 */
export function brepVertexIds(
  edge: number,
  handles: Uint32Array,
  vertexIdByHandle: ReadonlyMap<number, number>
): [number, number] | undefined {
  if (handles.length !== 2) {
    return undefined;
  }
  const ids = Array.from(handles, (handle) => {
    const id = vertexIdByHandle.get(handle);
    if (id === undefined) {
      // Same guard as the face owners above: a vertex outside this solid's own
      // vertex set means two kernel calls disagree about what the solid
      // contains, and publishing a half-resolved pair would hide it.
      throw new Error(
        `Edge ${edge} names vertex handle ${handle}, which is not among this solid's vertices.`
      );
    }
    return id;
  });
  return [ids[0]!, ids[1]!];
}

/**
 * A periodic face references its UV-closing seam twice. Remus's sphere is
 * currently built from two same-surface hemispheres, so their smooth equator
 * fragments are display seams too. Neither case is a physical feature edge.
 */
export function brepEdgeDisplayRole(
  kernel: RemusKernel,
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
 * More complex solids deliberately fall through to Remus's general boolean.
 */
export function readAnalyticCylinder(
  kernel: RemusKernel,
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

/**
 * True when `face` is a rolling-ball blend band rather than a modelled wall.
 *
 * Surface type alone used to answer this: every fillet Remus produced was
 * fitted as a `bspline`, so a free-form face WAS a blend. The kernel now
 * returns an exact `cylinder` for a fillet along a straight edge between two
 * planes, which makes a blend band and a drilled bore wall the same surface
 * type. They are still distinguishable by tangency, which is what a blend
 * IS: a band runs tangent into the face it meets along their shared edge,
 * where a bore wall meets its caps at a right angle. So a cylinder counts as
 * a blend only when some adjacent planar face is parallel to its axis and
 * stands exactly one radius off it.
 */
export function isBlendFace(
  kernel: RemusKernel,
  solid: number,
  face: number
): boolean {
  const surfaceType = kernel.getSurfaceType(face);
  if (surfaceType === 'bspline') {
    return true;
  }
  if (surfaceType === 'torus') {
    return true;
  }
  if (surfaceType !== 'cylinder') {
    return false;
  }
  let parameters: unknown;
  try {
    parameters = JSON.parse(kernel.getAnalyticSurfaceParams(face));
  } catch {
    return false;
  }
  const record = (parameters ?? {}) as Record<string, unknown>;
  const origin = finiteVec3(record.origin);
  const rawAxis = finiteVec3(record.axis);
  const axis = rawAxis ? normalized(rawAxis) : null;
  const radius = positiveFinite(record.radius);
  if (!origin || !axis || radius === null) {
    return false;
  }
  const bandEdges = new Set(kernel.getFaceEdges(face));
  const tolerance = Math.max(
    BLEND_TANGENCY_TOLERANCE * radius,
    GEOMETRY_EPSILON
  );
  for (const neighbour of kernel.getSolidFaces(solid)) {
    if (
      neighbour === face ||
      kernel.getSurfaceType(neighbour) !== 'plane' ||
      !Array.from(kernel.getFaceEdges(neighbour)).some((edge) =>
        bandEdges.has(edge)
      )
    ) {
      continue;
    }
    const onPlane = faceVertexCentroid(kernel, neighbour);
    let normal: Vec3 | null;
    try {
      const raw = kernel.getFaceNormal(neighbour);
      normal = normalized({ x: raw[0]!, y: raw[1]!, z: raw[2]! });
    } catch {
      // NURBS-backed planes have no analytic normal; they cannot be proven
      // tangent, so they do not make their neighbour a blend.
      normal = null;
    }
    if (!onPlane || !normal) {
      continue;
    }
    if (Math.abs(dot(normal, axis)) > BLEND_TANGENCY_TOLERANCE) {
      continue;
    }
    if (
      Math.abs(Math.abs(dot(subtract(origin, onPlane), normal)) - radius) <=
      tolerance
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when a selected edge touches a blend face of the target — either
 * bordering it directly or ending on one of its boundary vertices.
 */
export function selectionTouchesBlendFace(
  kernel: RemusKernel,
  solid: number,
  selectedEdges: number[]
): boolean {
  const blendVertices = new Set<number>();
  for (const face of kernel.getSolidFaces(solid)) {
    if (!isBlendFace(kernel, solid, face)) {
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
export function faceVertexCentroid(kernel: RemusKernel, face: number): Vec3 | null {
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
