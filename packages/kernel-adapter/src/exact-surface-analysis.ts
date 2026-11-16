/**
 * M09 analysis overlays: per-face values the exact kernel evaluates on a
 * body's own surfaces, sampled for the viewport to colour. It runs on the
 * same worker path and build as the M09 clash query (`exact-body-clash.ts`):
 * the adapter hands it the solids of the document it already built, and it
 * asks the kernel only read-only questions. Nothing here reads the display
 * mesh, and no value is ever invented for a sample the kernel refused.
 *
 * Sampling. Each face is tessellated on its own (so colours break cleanly at
 * edges), and every vertex is projected back onto the face's exact surface.
 * The kernel evaluates the analysis at that surface parameter; the overlay
 * vertex is the projected point and its normal the exact outward normal
 * there. A projection that lands farther from the tessellation than the
 * chord tolerance allows is not trusted: the sample is left unevaluated
 * (NaN, drawn neutral) rather than coloured from a point on the wrong part
 * of the surface.
 *
 * Exactness. A value at a sample is the kernel's exact evaluation. A face's
 * range is the range over its samples, which is exact only where the value
 * cannot vary across the face (a plane's draft); elsewhere the true extreme
 * may lie between samples, and the face says so (`exact: false`).
 *
 * Draft: `getFaceDraftAngle` at each sample, against the pull direction,
 * in degrees. Positive opens toward the pull. The minimum draft is not the
 * kernel's concern: the bands (`draftBand` in `@openzcad/shared`) are read
 * from these values by whoever colours them.
 *
 * Curvature: `getFaceCurvature` at each sample (principal curvatures, signed
 * convex-positive against the outward normal), reduced to the requested
 * measure. A face's range is exact where the measure is constant on its
 * surface type (plane, cylinder, sphere); cones and tori vary along the
 * face and NURBS anywhere, so theirs is sampled. Each face also carries its
 * smallest radius from `getFaceMinRadius`, which the kernel computes in
 * closed form on analytic surfaces and approximates on NURBS.
 *
 * Zebra: the exact outward normal at each sample (`evaluateSurfaceNormal`),
 * sampled four times as densely, for the viewport to reflect into stripes.
 * There is no value to range over; continuity is read from the stripes by
 * eye and is not certified here.
 *
 * Thickness: the ray method, sampled at the centre of each triangle of a
 * subdivided per-face mesh (so samples stand away from the face's edges).
 * From the centre, projected onto the exact surface, a ray runs inward along
 * the exact normal, stepped by the kernel's exact distance from the point to
 * the solid's boundary (a sphere that size holds no boundary, so a step can
 * never cross a wall) until that distance falls below the body's resolution:
 * the far wall. The figure is approximate twice over (between samples, and to
 * the resolution); the one exact case is a plane whose every sample lands on
 * a parallel opposing plane (`getOpposingPlanarFacePairs`), which reads as
 * that exact separation. A sample whose ray cannot start inside the solid (a
 * knife edge) or does not reach a wall is left unevaluated.
 */
import type {
  SurfaceAnalysisBody,
  SurfaceAnalysisFace,
  SurfaceAnalysisRequest,
  SurfaceAnalysisUnsupported
} from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';

/**
 * Sampling density, relative to the body's size: ten times the display
 * chord ratio. The overlay interpolates between exact samples, so it needs
 * enough of them to show a gradient, not a silhouette-quality mesh.
 */
export const ANALYSIS_LINEAR_DEFLECTION_RATIO = 2e-3;
export const ANALYSIS_ANGULAR_DEFLECTION = 0.12;
/** Samples one body may take before it is refused rather than sampled. */
export const ANALYSIS_MAX_SAMPLES_PER_BODY = 150_000;
/**
 * A projected sample may lie this many chord tolerances from its
 * tessellation vertex; farther, the projection is not trusted.
 */
const PROJECTION_TRUST = 4;
type Box = readonly [number, number, number, number, number, number];

function boxOf(kernel: RemusKernel, solids: readonly number[]): Box {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const solid of solids) {
    const raw = kernel.boundingBox(solid);
    for (let axis = 0; axis < 3; axis += 1) {
      box[axis] = Math.min(box[axis]!, raw[axis]!);
      box[axis + 3] = Math.max(box[axis + 3]!, raw[axis + 3]!);
    }
  }
  return box as unknown as Box;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'The geometry kernel refused the evaluation.';
}

/** The analysis value at one exact surface sample, and its outward normal. */
interface SampleValue {
  value: number;
  normal: readonly [number, number, number];
}

interface Evaluator {
  /** Throws when the kernel cannot evaluate at (u, v). */
  evaluate(face: number, u: number, v: number): SampleValue;
  /** Whether the face's sampled range is its exact range. */
  exactRange(surface: string): boolean;
  /** Sampling density: chord relative to the body's size, and angle. */
  deflectionRatio: number;
  angularDeflection: number;
  /** Extra per-face facts, added to its summary. */
  describeFace?(face: number, surface: string): Partial<SurfaceAnalysisFace>;
}

/** Surfaces whose curvature is the same at every point. */
const CONSTANT_CURVATURE = new Set(['plane', 'cylinder', 'sphere']);
/** Surfaces on which `getFaceMinRadius` is closed-form. */
const ANALYTIC_SURFACES = new Set([
  'plane',
  'cylinder',
  'cone',
  'sphere',
  'torus'
]);

function finiteNormal(raw: ArrayLike<number>): [number, number, number] {
  const normal: [number, number, number] = [raw[0]!, raw[1]!, raw[2]!];
  if (raw.length < 3 || !normal.every(Number.isFinite)) {
    throw new Error('The kernel returned no normal at this point.');
  }
  return normal;
}

function unit(v: {
  x: number;
  y: number;
  z: number;
}): [number, number, number] {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!(length > 0) || !Number.isFinite(length)) {
    throw new Error('The pull direction must be a non-zero vector.');
  }
  return [v.x / length, v.y / length, v.z / length];
}

function draftEvaluator(
  kernel: RemusKernel,
  pullDirection: { x: number; y: number; z: number }
): Evaluator {
  const pull = unit(pullDirection);
  return {
    evaluate(face, u, v) {
      const raw = kernel.getFaceDraftAngle(
        face,
        u,
        v,
        pull[0],
        pull[1],
        pull[2]
      );
      const parsed = JSON.parse(raw) as {
        angleRadians: number;
        outwardNormal: [number, number, number];
      };
      const value = (parsed.angleRadians * 180) / Math.PI;
      if (!Number.isFinite(value) || !Array.isArray(parsed.outwardNormal)) {
        throw new Error('The kernel returned no draft at this point.');
      }
      return { value, normal: finiteNormal(parsed.outwardNormal) };
    },
    // A plane has one normal, so one draft: its range is exact.
    exactRange: (surface) => surface === 'plane',
    deflectionRatio: ANALYSIS_LINEAR_DEFLECTION_RATIO,
    angularDeflection: ANALYSIS_ANGULAR_DEFLECTION
  };
}

interface FaceCurvature {
  k1: number;
  k2: number;
  gaussian: number;
  mean: number;
}

function curvatureEvaluator(
  kernel: RemusKernel,
  measure: 'gaussian' | 'mean' | 'maximum'
): Evaluator {
  return {
    evaluate(face, u, v) {
      const raw: unknown = kernel.getFaceCurvature(face, u, v);
      const parsed = (
        typeof raw === 'string' ? JSON.parse(raw) : raw
      ) as FaceCurvature;
      const value =
        measure === 'gaussian'
          ? parsed.gaussian
          : measure === 'mean'
            ? parsed.mean
            : Math.max(Math.abs(parsed.k1), Math.abs(parsed.k2));
      if (!Number.isFinite(value)) {
        throw new Error('The kernel returned no curvature at this point.');
      }
      return {
        value,
        normal: finiteNormal(kernel.evaluateSurfaceNormal(face, u, v))
      };
    },
    exactRange: (surface) => CONSTANT_CURVATURE.has(surface),
    deflectionRatio: ANALYSIS_LINEAR_DEFLECTION_RATIO,
    angularDeflection: ANALYSIS_ANGULAR_DEFLECTION,
    describeFace(face, surface) {
      if (surface === 'plane') return { minRadius: null, minRadiusExact: true };
      try {
        const radius = kernel.getFaceMinRadius(face);
        return Number.isFinite(radius) && radius >= 0
          ? {
              minRadius: radius,
              minRadiusExact: ANALYTIC_SURFACES.has(surface)
            }
          : { minRadius: null, minRadiusExact: radius === Infinity };
      } catch {
        // No smallest radius is not a zero radius: leave it unstated.
        return {};
      }
    }
  };
}

function zebraEvaluator(kernel: RemusKernel): Evaluator {
  return {
    evaluate(face, u, v) {
      return {
        value: 0,
        normal: finiteNormal(kernel.evaluateSurfaceNormal(face, u, v))
      };
    },
    exactRange: () => true,
    // Stripes bend between samples: sample four times as densely.
    deflectionRatio: ANALYSIS_LINEAR_DEFLECTION_RATIO / 4,
    angularDeflection: ANALYSIS_ANGULAR_DEFLECTION / 4
  };
}

function evaluatorFor(
  kernel: RemusKernel,
  request: SurfaceAnalysisRequest
): Evaluator {
  switch (request.kind) {
    case 'draft':
      return draftEvaluator(kernel, request.pull);
    case 'curvature':
      return curvatureEvaluator(kernel, request.measure);
    case 'zebra':
      return zebraEvaluator(kernel);
    case 'thickness':
      throw new Error('Thickness is sampled per triangle, not per vertex.');
  }
}

interface FaceSamples {
  positions: number[];
  normals: number[];
  values: number[];
  indices: number[];
}

/**
 * Samples every face of one body's solids. Returns null with an unsupported
 * entry when the body needs more samples than it may take.
 */
export function analyzeBodySurfaces(
  kernel: RemusKernel,
  bodyId: string,
  solids: readonly number[],
  request: SurfaceAnalysisRequest,
  unsupported: SurfaceAnalysisUnsupported[]
): SurfaceAnalysisBody | null {
  if (request.kind === 'thickness') {
    return analyzeBodyThickness(kernel, bodyId, solids, unsupported);
  }
  const evaluator = evaluatorFor(kernel, request);
  const box = boxOf(kernel, solids);
  const scale = Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
  const deflection = Math.max(1e-5, scale * evaluator.deflectionRatio);
  const trust = deflection * PROJECTION_TRUST;

  const out: FaceSamples = {
    positions: [],
    normals: [],
    values: [],
    indices: []
  };
  const faces: SurfaceAnalysisFace[] = [];
  let faceIndex = 0;
  let sampleCount = 0;

  for (const solid of solids) {
    for (const face of Array.from(kernel.getSolidFaces(solid))) {
      const index = faceIndex;
      faceIndex += 1;
      let surface = 'unknown';
      try {
        surface = kernel.getSurfaceType(face);
      } catch {
        // Named only for the summary; the samples decide the rest.
      }
      let mesh;
      try {
        mesh = kernel.tessellateFace(
          face,
          deflection,
          evaluator.angularDeflection
        );
      } catch (error) {
        // No mesh at all: the overlay has a hole here, so the viewport keeps
        // the body's own surface drawn under it.
        unsupported.push({
          bodyId,
          face: index,
          reason: 'not-tessellated',
          message: messageOf(error)
        });
        continue;
      }
      try {
        const positions = mesh.positions;
        const meshNormals = mesh.normals;
        const indices = mesh.indices;
        const vertexCount = positions.length / 3;
        sampleCount += vertexCount;
        if (sampleCount > ANALYSIS_MAX_SAMPLES_PER_BODY) {
          unsupported.push({
            bodyId,
            face: null,
            reason: 'too-many-samples',
            message: `This body needs more than ${ANALYSIS_MAX_SAMPLES_PER_BODY.toLocaleString('en-US')} samples to analyse.`
          });
          return null;
        }
        const base = out.positions.length / 3;
        let min = Infinity;
        let max = -Infinity;
        let evaluated = 0;
        let firstError: string | null = null;
        for (let vertex = 0; vertex < vertexCount; vertex += 1) {
          const x = positions[vertex * 3]!;
          const y = positions[vertex * 3 + 1]!;
          const z = positions[vertex * 3 + 2]!;
          let point: [number, number, number] = [x, y, z];
          let normal: readonly number[] = [
            meshNormals[vertex * 3] ?? 0,
            meshNormals[vertex * 3 + 1] ?? 0,
            meshNormals[vertex * 3 + 2] ?? 1
          ];
          let value = Number.NaN;
          try {
            const projected = kernel.projectPointOnSurface(face, x, y, z);
            const distance = projected[5]!;
            if (
              projected.length < 6 ||
              !Array.from(projected).every(Number.isFinite) ||
              distance > trust
            ) {
              throw new Error(
                'The sample could not be placed on the exact surface.'
              );
            }
            const sample = evaluator.evaluate(
              face,
              projected[0]!,
              projected[1]!
            );
            point = [projected[2]!, projected[3]!, projected[4]!];
            normal = sample.normal;
            value = sample.value;
          } catch (error) {
            firstError ??= messageOf(error);
          }
          out.positions.push(point[0], point[1], point[2]);
          out.normals.push(normal[0]!, normal[1]!, normal[2]!);
          out.values.push(value);
          if (Number.isFinite(value)) {
            evaluated += 1;
            if (value < min) min = value;
            if (value > max) max = value;
          }
        }
        for (const vertex of indices) out.indices.push(base + vertex);
        if (evaluated === 0) {
          unsupported.push({
            bodyId,
            face: index,
            reason: 'kernel-refused',
            message: firstError ?? 'The face has no samples to evaluate.'
          });
          continue;
        }
        if (evaluated < vertexCount) {
          unsupported.push({
            bodyId,
            face: index,
            reason: 'partly-evaluated',
            message: `${vertexCount - evaluated} of ${vertexCount} samples could not be evaluated: ${firstError ?? 'no reason given'}`
          });
        }
        const summary: SurfaceAnalysisFace = {
          face: index,
          surface,
          min,
          max,
          samples: evaluated,
          exact: evaluated === vertexCount && evaluator.exactRange(surface),
          ...evaluator.describeFace?.(face, surface)
        };
        faces.push(summary);
      } finally {
        mesh.free();
      }
    }
  }

  return {
    bodyId,
    positions: Float32Array.from(out.positions),
    normals: Float32Array.from(out.normals),
    indices: Uint32Array.from(out.indices),
    values: Float32Array.from(out.values),
    faces
  };
}

/** Thickness samples one body may take before it is refused. */
export const THICKNESS_MAX_SAMPLES_PER_BODY = 40_000;
/** A triangle longer than this share of the body's size is split. */
const THICKNESS_EDGE_RATIO = 1 / 24;
/** The ray stops this close to a wall, as a share of the body's size. */
const THICKNESS_RESOLUTION_RATIO = 1e-4;
/** Steps a ray may take before it is given up as not converging. */
const THICKNESS_MAX_STEPS = 400;

type Point = [number, number, number];

/**
 * Splits each triangle's longest edge at its midpoint until no edge exceeds
 * `limit`. Bisecting the longest edge (rather than cutting into four
 * similar triangles) turns slivers into well-shaped triangles, so their
 * centres stand away from the face's edges, where a ray would graze the
 * neighbouring wall. Null when more than `budget` triangles would result.
 */
export function subdivideTriangles(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  limit: number,
  budget: number
): [Point, Point, Point][] | null {
  const point = (index: number): Point => [
    positions[index * 3]!,
    positions[index * 3 + 1]!,
    positions[index * 3 + 2]!
  ];
  const length = (a: Point, b: Point) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const out: [Point, Point, Point][] = [];
  const stack: [Point, Point, Point][] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    stack.push([
      point(indices[i]!),
      point(indices[i + 1]!),
      point(indices[i + 2]!)
    ]);
  }
  while (stack.length > 0) {
    const [a, b, c] = stack.pop()!;
    const ab = length(a, b);
    const bc = length(b, c);
    const ca = length(c, a);
    const longest = Math.max(ab, bc, ca);
    if (longest <= limit) {
      out.push([a, b, c]);
      if (out.length > budget) return null;
      continue;
    }
    // Rotate so the longest edge is (p, q), opposite r.
    const [p, q, r] =
      longest === ab ? [a, b, c] : longest === bc ? [b, c, a] : [c, a, b];
    const m: Point = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    stack.push([p, m, r], [m, q, r]);
    if (stack.length + out.length > budget * 2) return null;
  }
  return out;
}

/**
 * A face of the solid as the ray method reads it: a plane, cylinder or
 * sphere is crossed in closed form; anything else is traced.
 */
export type RayFace =
  | { handle: number; kind: 'plane'; normal: Point; offset: number }
  | {
      handle: number;
      kind: 'cylinder';
      origin: Point;
      axis: Point;
      radius: number;
    }
  | { handle: number; kind: 'sphere'; center: Point; radius: number }
  | { handle: number; kind: 'traced' };

function vec(raw: unknown): Point | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const v = raw.map(Number) as Point;
  return v.every(Number.isFinite) ? v : null;
}

function unitPoint(v: Point): Point | null {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : null;
}

/** The solid's faces, each with its closed form where it has one. */
export function rayFaces(kernel: RemusKernel, solid: number): RayFace[] {
  return Array.from(kernel.getSolidFaces(solid)).map((handle): RayFace => {
    try {
      const params = JSON.parse(kernel.getAnalyticSurfaceParams(handle)) as {
        type?: string;
        normal?: unknown;
        d?: unknown;
        origin?: unknown;
        axis?: unknown;
        center?: unknown;
        radius?: unknown;
      };
      const radius = Number(params.radius);
      if (params.type === 'plane') {
        const normal = vec(params.normal);
        const offset = Number(params.d);
        const n = normal && unitPoint(normal);
        if (n && normal && Number.isFinite(offset)) {
          const length = Math.hypot(normal[0], normal[1], normal[2]);
          return { handle, kind: 'plane', normal: n, offset: offset / length };
        }
      } else if (params.type === 'cylinder') {
        const origin = vec(params.origin);
        const axis = vec(params.axis);
        const a = axis && unitPoint(axis);
        if (origin && a && radius > 0) {
          return { handle, kind: 'cylinder', origin, axis: a, radius };
        }
      } else if (params.type === 'sphere') {
        const center = vec(params.center);
        if (center && radius > 0)
          return { handle, kind: 'sphere', center, radius };
      }
    } catch {
      // No closed form (cone, torus, NURBS) or no report: traced.
    }
    return { handle, kind: 'traced' };
  });
}

const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Point, b: Point): Point => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2]
];

/** Ray parameters at which `start + t·direction` meets a face's surface. */
export function surfaceCrossings(
  face: RayFace,
  start: Point,
  direction: Point
): number[] {
  const quadratic = (a: number, b: number, c: number): number[] => {
    if (Math.abs(a) < 1e-15) return [];
    const disc = b * b - 4 * a * c;
    if (disc < 0) return [];
    const root = Math.sqrt(disc);
    return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
  };
  switch (face.kind) {
    case 'plane': {
      const along = dot(face.normal, direction);
      if (Math.abs(along) < 1e-12) return [];
      return [(face.offset - dot(face.normal, start)) / along];
    }
    case 'cylinder': {
      const w = sub(start, face.origin);
      const wa = dot(w, face.axis);
      const da = dot(direction, face.axis);
      const wp: Point = [
        w[0] - wa * face.axis[0],
        w[1] - wa * face.axis[1],
        w[2] - wa * face.axis[2]
      ];
      const dp: Point = [
        direction[0] - da * face.axis[0],
        direction[1] - da * face.axis[1],
        direction[2] - da * face.axis[2]
      ];
      return quadratic(
        dot(dp, dp),
        2 * dot(wp, dp),
        dot(wp, wp) - face.radius * face.radius
      );
    }
    case 'sphere': {
      const w = sub(start, face.center);
      return quadratic(
        dot(direction, direction),
        2 * dot(w, direction),
        dot(w, w) - face.radius * face.radius
      );
    }
    case 'traced':
      return [];
  }
}

/**
 * The ray method from `start` (on the surface) inward along `-normal`: the
 * distance to the first wall the ray reaches, and where. Planes, cylinders
 * and spheres are crossed in closed form, each crossing confirmed to lie on
 * the trimmed face by the kernel's exact face distance. Other faces are
 * found by sphere tracing on the kernel's exact point-to-face distance (a
 * step that size can never cross such a face), up to the nearest closed-form
 * crossing, so a ray running alongside a flat or cylindrical wall is never
 * slowed by it. Throws when the ray cannot start inside the solid, reaches
 * no wall, or a trace cannot rule out a wall before the crossing it found.
 */
export function rayThickness(
  kernel: RemusKernel,
  solid: number,
  faces: readonly RayFace[],
  startFace: number,
  start: Point,
  normal: readonly number[],
  resolution: number,
  reach: number
): { thickness: number; hit: Point } {
  const direction: Point = [-normal[0]!, -normal[1]!, -normal[2]!];
  const at = (t: number): Point => [
    start[0] + direction[0] * t,
    start[1] + direction[1] * t,
    start[2] + direction[2] * t
  ];
  const tooThin = () =>
    new Error('The wall is thinner here than the resolution can measure.');
  const first = resolution * 2;
  // The start itself sits on the surface: crossings this close are it.
  const own = resolution * 1e-3;
  const probe = at(first);
  if (
    kernel.classifyPoint(
      solid,
      probe[0],
      probe[1],
      probe[2],
      resolution / 10
    ) !== 'inside'
  ) {
    throw tooThin();
  }
  // Closed-form crossings, confirmed on the trimmed face, in ray order. One
  // inside the opening segment (start to probe) is a wall the probe stepped
  // over: the sample is refused rather than measured past it.
  const crossings: { t: number; face: number }[] = [];
  for (const face of faces) {
    for (const t of surfaceCrossings(face, start, direction)) {
      if (t > own && t <= reach) crossings.push({ t, face: face.handle });
    }
  }
  crossings.sort((a, b) => a.t - b.t);
  let bound = Infinity;
  for (const { t, face } of crossings) {
    const hit = at(t);
    if (
      kernel.pointToFaceDistance(hit[0], hit[1], hit[2], face)[0]! <= resolution
    ) {
      if (t <= first) throw tooThin();
      bound = t;
      break;
    }
  }
  const traced = faces.filter((face) => face.kind === 'traced');
  if (traced.length > 0) {
    // A traced face, other than the one the ray starts on, within the
    // opening segment's length of the probe could cross that segment.
    for (const { handle } of traced) {
      if (handle === startFace) continue;
      const d = kernel.pointToFaceDistance(
        probe[0],
        probe[1],
        probe[2],
        handle
      )[0]!;
      if (!(d >= first)) throw tooThin();
    }
    let t = first;
    let cleared = false;
    for (let step = 0; step < THICKNESS_MAX_STEPS; step += 1) {
      if (t >= bound) {
        cleared = true;
        break;
      }
      const q = at(t);
      let distance = Infinity;
      for (const { handle } of traced) {
        const d = kernel.pointToFaceDistance(q[0], q[1], q[2], handle)[0]!;
        if (d < distance) distance = d;
      }
      if (!Number.isFinite(distance)) {
        throw new Error('The kernel returned no distance inside the wall.');
      }
      if (distance < resolution) {
        // Near a traced face is not through it: the ray crosses a wall
        // only if a point two resolutions on lies outside the solid, and
        // the crossing is then within a resolution of t + resolution.
        const beyond = at(t + 2 * resolution);
        const side = kernel.classifyPoint(
          solid,
          beyond[0],
          beyond[1],
          beyond[2],
          resolution / 10
        );
        if (side === 'inside') {
          throw new Error(
            'The ray runs alongside a curved wall and cannot be measured past it.'
          );
        }
        const thickness = Math.min(t + resolution, bound);
        return { thickness, hit: at(thickness) };
      }
      t += distance;
      if (t > reach) break;
    }
    if (!cleared && !(t > reach && !Number.isFinite(bound))) {
      throw new Error(
        'The ray could not be traced past a curved wall it runs alongside.'
      );
    }
  }
  if (Number.isFinite(bound)) return { thickness: bound, hit: at(bound) };
  throw new Error('The ray did not reach a far wall.');
}

/** Opposing parallel planar faces per face handle, with their separation. */
function opposingPlanes(
  kernel: RemusKernel,
  solid: number
): Map<number, { partner: number; distance: number }[]> {
  const partners = new Map<number, { partner: number; distance: number }[]>();
  try {
    const pairs = JSON.parse(kernel.getOpposingPlanarFacePairs(solid)) as {
      faceA: number;
      faceB: number;
      distance: number;
    }[];
    for (const { faceA, faceB, distance } of pairs) {
      if (!Number.isFinite(distance)) continue;
      for (const [face, partner] of [
        [faceA, faceB],
        [faceB, faceA]
      ] as const) {
        const list = partners.get(face) ?? [];
        list.push({ partner, distance });
        partners.set(face, list);
      }
    }
  } catch {
    // A solid with curved faces may refuse the report; its planes are then
    // read as sampled, never as exact.
  }
  return partners;
}

function analyzeBodyThickness(
  kernel: RemusKernel,
  bodyId: string,
  solids: readonly number[],
  unsupported: SurfaceAnalysisUnsupported[]
): SurfaceAnalysisBody | null {
  const box = boxOf(kernel, solids);
  const scale = Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
  const deflection = Math.max(1e-5, scale * ANALYSIS_LINEAR_DEFLECTION_RATIO);
  const trust = deflection * PROJECTION_TRUST;
  const resolution = Math.max(1e-6, scale * THICKNESS_RESOLUTION_RATIO);
  const reach = scale * 2;
  const edgeLimit = scale * THICKNESS_EDGE_RATIO;

  const positions: number[] = [];
  const normals: number[] = [];
  const values: number[] = [];
  const faces: SurfaceAnalysisFace[] = [];
  let faceIndex = 0;
  let sampleCount = 0;

  const refuseBody = () => {
    unsupported.push({
      bodyId,
      face: null,
      reason: 'too-many-samples',
      message: `This body needs more than ${THICKNESS_MAX_SAMPLES_PER_BODY.toLocaleString('en-US')} thickness samples to analyse.`
    });
    return null;
  };

  for (const solid of solids) {
    const planes = opposingPlanes(kernel, solid);
    const walls = rayFaces(kernel, solid);
    for (const face of Array.from(kernel.getSolidFaces(solid))) {
      const index = faceIndex;
      faceIndex += 1;
      let surface = 'unknown';
      try {
        surface = kernel.getSurfaceType(face);
      } catch {
        // Named only for the summary.
      }
      let mesh;
      try {
        mesh = kernel.tessellateFace(
          face,
          deflection,
          ANALYSIS_ANGULAR_DEFLECTION
        );
      } catch (error) {
        unsupported.push({
          bodyId,
          face: index,
          reason: 'not-tessellated',
          message: messageOf(error)
        });
        continue;
      }
      let triangles: [Point, Point, Point][];
      try {
        const split = subdivideTriangles(
          mesh.positions,
          mesh.indices,
          edgeLimit,
          THICKNESS_MAX_SAMPLES_PER_BODY - sampleCount
        );
        if (!split) return refuseBody();
        triangles = split;
      } finally {
        mesh.free();
      }
      sampleCount += triangles.length;
      if (sampleCount > THICKNESS_MAX_SAMPLES_PER_BODY) return refuseBody();

      // Each triangle's corners placed on the exact surface with their
      // exact normals; a corner that cannot be placed keeps its mesh place.
      const place = (p: Point): { point: Point; normal: Point | null } => {
        try {
          const projected = kernel.projectPointOnSurface(
            face,
            p[0],
            p[1],
            p[2]
          );
          if (
            projected.length < 6 ||
            !Array.from(projected).every(Number.isFinite) ||
            projected[5]! > trust
          ) {
            return { point: p, normal: null };
          }
          return {
            point: [projected[2]!, projected[3]!, projected[4]!],
            normal: finiteNormal(
              kernel.evaluateSurfaceNormal(face, projected[0]!, projected[1]!)
            )
          };
        } catch {
          return { point: p, normal: null };
        }
      };

      const partners = surface === 'plane' ? (planes.get(face) ?? []) : [];
      // Every sample landing on one opposing plane, at its separation.
      let onPartner: { partner: number; distance: number } | null | undefined =
        undefined;
      let min = Infinity;
      let max = -Infinity;
      let thinnestAt: Point | null = null;
      let evaluated = 0;
      let firstError: string | null = null;
      const faceValueStart = values.length;
      for (const [a, b, c] of triangles) {
        const corners = [place(a), place(b), place(c)];
        const centre: Point = [
          (a[0] + b[0] + c[0]) / 3,
          (a[1] + b[1] + c[1]) / 3,
          (a[2] + b[2] + c[2]) / 3
        ];
        let value = Number.NaN;
        let centreNormal: Point | null = null;
        try {
          const placed = place(centre);
          if (!placed.normal) {
            throw new Error(
              'The sample could not be placed on the exact surface.'
            );
          }
          centreNormal = placed.normal;
          const ray = rayThickness(
            kernel,
            solid,
            walls,
            face,
            placed.point,
            placed.normal,
            resolution,
            reach
          );
          value = ray.thickness;
          if (value < min) {
            min = value;
            thinnestAt = placed.point;
          }
          if (value > max) max = value;
          evaluated += 1;
          if (onPartner !== null) {
            const landed = partners.find(
              ({ partner, distance }) =>
                Math.abs(distance - value) <= resolution * 2 &&
                kernel.pointToFaceDistance(
                  ray.hit[0],
                  ray.hit[1],
                  ray.hit[2],
                  partner
                )[0]! <=
                  resolution * 2
            );
            onPartner =
              landed &&
              (onPartner === undefined || onPartner.partner === landed.partner)
                ? landed
                : null;
          }
        } catch (error) {
          firstError ??= messageOf(error);
          onPartner = null;
        }
        for (const corner of corners) {
          positions.push(corner.point[0], corner.point[1], corner.point[2]);
          const n = corner.normal ?? centreNormal ?? [0, 0, 1];
          normals.push(n[0], n[1], n[2]);
          values.push(value);
        }
      }
      const total = triangles.length;
      if (evaluated === 0) {
        unsupported.push({
          bodyId,
          face: index,
          reason: 'kernel-refused',
          message: firstError ?? 'The face has no samples to measure.'
        });
        continue;
      }
      if (evaluated < total) {
        unsupported.push({
          bodyId,
          face: index,
          reason: 'partly-evaluated',
          message: `${total - evaluated} of ${total} samples could not be measured: ${firstError ?? 'no reason given'}`
        });
      }
      const exact = evaluated === total && onPartner != null;
      if (exact) {
        // Parallel planes: the ray along the normal crosses exactly their
        // separation, so the figure is the kernel's exact distance.
        for (let i = faceValueStart; i < values.length; i += 1) {
          values[i] = onPartner!.distance;
        }
        min = onPartner!.distance;
        max = onPartner!.distance;
      }
      faces.push({
        face: index,
        surface,
        min,
        max,
        samples: evaluated,
        exact,
        ...(thinnestAt
          ? {
              thinnestAt: {
                x: thinnestAt[0],
                y: thinnestAt[1],
                z: thinnestAt[2]
              }
            }
          : {})
      });
    }
  }

  const vertexCount = positions.length / 3;
  return {
    bodyId,
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from({ length: vertexCount }, (_, i) => i),
    values: Float32Array.from(values),
    faces,
    resolution
  };
}
