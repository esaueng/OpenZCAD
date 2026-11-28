/**
 * #2321: the analytic surface a B-spline face lies on. An imported STEP
 * often carries a cylinder or a plane as a B-spline; the kernel names the
 * exact non-rational plane patches itself (`getSurfaceType`), but a
 * rational cylinder side stays 'bspline'. What a form tolerance controls
 * depends on that support, so it is established here, read-only:
 *
 * 1. The kernel's own elementary recognition (`convertToElementary`) runs on
 *    a throwaway copy of the solid, whose faces list in the source's order.
 * 2. Its answer is trusted only when samples of the SOURCE face, across its
 *    surface's parameter domain, all lie on the recognised surface within
 *    linear model tolerance. A face whose copy is not recognised, or whose
 *    samples miss, has no established support.
 */
import { GEOMETRY_LINEAR_TOLERANCE } from '@openzcad/geometry';
import type { Vec3 } from '@openzcad/geometry';
import type { RemusKernel } from './remus-runtime';
import { surfaceTypeOf } from './exact-sync-memo';
import {
  dot,
  finiteVec3,
  length,
  normalized,
  positiveFinite,
  scale,
  subtract
} from './exact-math';

const ANALYTIC = new Set(['plane', 'cylinder', 'cone', 'sphere', 'torus']);

/** Samples per parameter direction; 7 × 7 points per face. */
const SAMPLES = 7;

type Distance = (point: Vec3) => number;

/** Distance from a point to the recognised surface, or null if unreadable. */
function surfaceDistance(
  kernel: RemusKernel,
  face: number,
  type: string
): Distance | null {
  let record: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(kernel.getAnalyticSurfaceParams(face));
    if (!value || typeof value !== 'object') return null;
    record = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const axisOf = (key: string) => {
    const raw = finiteVec3(record[key]);
    return raw ? normalized(raw) : null;
  };
  // Radial and axial components of `point` about a line.
  const about = (origin: Vec3, axis: Vec3, point: Vec3) => {
    const offset = subtract(point, origin);
    const axial = dot(offset, axis);
    return { axial, radial: length(subtract(offset, scale(axis, axial))) };
  };
  if (type === 'plane') {
    const normal = axisOf('normal');
    const d = record.d;
    if (!normal || typeof d !== 'number' || !Number.isFinite(d)) return null;
    return (point) => Math.abs(dot(normal, point) - d);
  }
  if (type === 'cylinder') {
    const origin = finiteVec3(record.origin);
    const axis = axisOf('axis');
    const radius = positiveFinite(record.radius);
    if (!origin || !axis || radius === null) return null;
    return (point) => Math.abs(about(origin, axis, point).radial - radius);
  }
  if (type === 'sphere') {
    const center = finiteVec3(record.center);
    const radius = positiveFinite(record.radius);
    if (!center || radius === null) return null;
    return (point) => Math.abs(length(subtract(point, center)) - radius);
  }
  if (type === 'cone') {
    const apex = finiteVec3(record.apex);
    const axis = axisOf('axis');
    const half = positiveFinite(
      record.halfAngle ?? record.half_angle ?? record.semiAngle
    );
    if (!apex || !axis || half === null || half >= Math.PI / 2) return null;
    const [c, s] = [Math.cos(half), Math.sin(half)];
    // Distance to the nearer generator line in the point's axial plane.
    return (point) => {
      const { axial, radial } = about(apex, axis, point);
      return Math.min(
        Math.abs(radial * c - axial * s),
        Math.abs(radial * c + axial * s)
      );
    };
  }
  if (type === 'torus') {
    const center = finiteVec3(record.center);
    const axis = axisOf('axis');
    const major = positiveFinite(record.majorRadius ?? record.major_radius);
    const minor = positiveFinite(record.minorRadius ?? record.minor_radius);
    // The pinned build may leave the axis out; then the torus is unproven.
    if (!center || !axis || major === null || minor === null) return null;
    return (point) => {
      const { axial, radial } = about(center, axis, point);
      return Math.abs(Math.hypot(radial - major, axial) - minor);
    };
  }
  return null;
}

/** Points across the face's surface domain, or null if it cannot be read. */
function surfaceSamples(kernel: RemusKernel, face: number): Vec3[] | null {
  try {
    const [uMin, uMax, vMin, vMax] = Array.from(kernel.getSurfaceDomain(face));
    if (![uMin, uMax, vMin, vMax].every(Number.isFinite)) return null;
    const points: Vec3[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      for (let j = 0; j < SAMPLES; j += 1) {
        const u = uMin! + ((uMax! - uMin!) * i) / (SAMPLES - 1);
        const v = vMin! + ((vMax! - vMin!) * j) / (SAMPLES - 1);
        const p = kernel.evaluateSurface(face, u, v);
        const point = { x: p[0]!, y: p[1]!, z: p[2]! };
        if (![point.x, point.y, point.z].every(Number.isFinite)) return null;
        points.push(point);
      }
    }
    return points;
  } catch {
    return null;
  }
}

/**
 * Each B-spline face of `solid` (among `only`, when given) whose support
 * was established, mapped to that analytic surface type. Faces already
 * analytic are not listed; nothing about the solid changes.
 */
export function bsplineSupportSurfaces(
  kernel: RemusKernel,
  solid: number,
  only?: ReadonlySet<number>
): Map<number, string> {
  const out = new Map<number, string>();
  const faces = Array.from(kernel.getSolidFaces(solid));
  const wanted = faces.flatMap((face, index) =>
    (!only || only.has(face)) && surfaceTypeOf(kernel, face) === 'bspline'
      ? [index]
      : []
  );
  if (wanted.length === 0) return out;
  let copy: number;
  try {
    copy = kernel.copySolid(solid);
  } catch {
    return out;
  }
  try {
    kernel.convertToElementary(copy);
    const copied = Array.from(kernel.getSolidFaces(copy));
    if (copied.length !== faces.length) return out;
    for (const index of wanted) {
      const source = faces[index]!;
      const recognised = copied[index]!;
      const type = kernel.getSurfaceType(recognised);
      if (!ANALYTIC.has(type)) continue;
      const distance = surfaceDistance(kernel, recognised, type);
      const samples = surfaceSamples(kernel, source);
      if (!distance || !samples) continue;
      const size = Math.max(
        1,
        ...samples.map((p) =>
          Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z))
        )
      );
      // Linear model tolerance, relative to the part's coordinates.
      const tolerance = GEOMETRY_LINEAR_TOLERANCE * size;
      if (samples.every((point) => distance(point) <= tolerance))
        out.set(source, type);
    }
  } catch {
    // Recognition or a read failed: no support is established.
  } finally {
    try {
      kernel.deleteSolid(copy);
    } catch {
      // The copy is the kernel's to reclaim with its arena.
    }
  }
  return out;
}
