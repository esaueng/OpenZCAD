import type { EdgeTopology, FaceTopology, Vector3 } from '@openzcad/shared';

/**
 * D06 slice B: where two faces' underlying surfaces meet, from the exact
 * surface data the kernel publishes for each face — a chamfer's virtual
 * sharp with the body it chamfers, though a blend rounds the corner away.
 *
 * Planes, cylinders and cones are read; two coaxial surfaces of revolution,
 * or one and a plane square to their axis, meet in a circle, and two planes
 * in a line. Anything else (a torus, a sloped plane across a cylinder, a
 * spline) has no sharp this reads, and says so rather than guessing.
 */

export type SharpCurve =
  | { kind: 'circle'; center: Vector3; axis: Vector3; radius: number }
  | { kind: 'line'; point: Vector3; direction: Vector3 };

export type SharpFailure = 'unsupported-surface' | 'parallel' | 'no-sharp';

export type SharpResult =
  { ok: true; curve: SharpCurve } | { ok: false; reason: SharpFailure };

type Surface =
  | { kind: 'plane'; normal: Vector3; offset: number }
  | { kind: 'cylinder'; point: Vector3; axis: Vector3; radius: number }
  | {
      kind: 'cone';
      apex: Vector3;
      axis: Vector3;
      /** Tangent of the half-angle. */
      slope: number;
      halfAngle: number;
      /** +1 when the face lies along `axis` from the apex, −1 behind it. */
      sense: 1 | -1;
    };

export const dot = (a: Vector3, b: Vector3) =>
  a.x * b.x + a.y * b.y + a.z * b.z;
export const sub = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
});
export const add = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z
});
export const scale = (a: Vector3, k: number): Vector3 => ({
  x: a.x * k,
  y: a.y * k,
  z: a.z * k
});
export const cross = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});
export const norm = (a: Vector3) => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vector3): Vector3 | null => {
  const n = norm(a);
  return n < 1e-12 ? null : scale(a, 1 / n);
};

/** Directions this close to parallel (|cos| from 1) count as parallel. */
const PARALLEL = 1e-9;

function tolerance(...values: number[]): number {
  return 1e-6 * Math.max(1, ...values.map(Math.abs));
}

function surfaceOf(face: FaceTopology): Surface | null {
  const g = face.geometry;
  if (!g) return null;
  const type = g.surfaceType.toLowerCase();
  if (type.includes('plane')) {
    return g.normal && g.planeOffset !== undefined
      ? { kind: 'plane', normal: g.normal, offset: g.planeOffset }
      : null;
  }
  if (type.includes('cylind')) {
    if (g.radius === undefined || !g.axisStart || !g.axisEnd) return null;
    const axis = unit(sub(g.axisEnd, g.axisStart));
    return axis
      ? { kind: 'cylinder', point: g.axisStart, axis, radius: g.radius }
      : null;
  }
  if (type.includes('cone')) {
    if (!g.apex || !g.axis || g.halfAngle === undefined) return null;
    const axis = unit(g.axis);
    if (!axis || !(g.halfAngle > 0 && g.halfAngle < Math.PI / 2)) return null;
    // Which nappe the face is on: its vertex mean lies on the face.
    const along = dot(sub(g.center, g.apex), axis);
    return {
      kind: 'cone',
      apex: g.apex,
      axis,
      slope: Math.tan(g.halfAngle),
      halfAngle: g.halfAngle,
      sense: along >= 0 ? 1 : -1
    };
  }
  return null;
}

/** A surface of revolution about a line, as radius against axial position. */
interface Revolution {
  /** Radius = constant + rate · t, for t along the shared axis. */
  constant: number;
  rate: number;
}

function sharpOfSurfaces(a: Surface, b: Surface): SharpResult {
  if (a.kind === 'plane' && b.kind === 'plane') {
    const direction = cross(a.normal, b.normal);
    const length = norm(direction);
    if (length < 1e-9) return { ok: false, reason: 'parallel' };
    const n1 = a.normal;
    const n2 = b.normal;
    const n12 = dot(n1, n2);
    const point = scale(
      add(
        scale(n1, a.offset * dot(n2, n2) - b.offset * n12),
        scale(n2, b.offset * dot(n1, n1) - a.offset * n12)
      ),
      1 / (length * length)
    );
    return {
      ok: true,
      curve: { kind: 'line', point, direction: scale(direction, 1 / length) }
    };
  }
  // At least one surface of revolution: its axis is the shared one.
  const lead = a.kind !== 'plane' ? a : (b as Exclude<Surface, { kind: 'plane' }>);
  const origin = lead.kind === 'cylinder' ? lead.point : lead.apex;
  const axis = lead.axis;
  const extent = (surface: Surface) =>
    surface.kind === 'cylinder'
      ? surface.radius
      : surface.kind === 'plane'
        ? surface.offset
        : norm(surface.apex);
  const tol = tolerance(norm(origin), extent(a), extent(b));

  const revolutions: Revolution[] = [];
  let planeAt: number | null = null;
  for (const surface of [a, b]) {
    if (surface.kind === 'plane') {
      const facing = dot(surface.normal, axis);
      // Only a plane square to the axis meets it in a circle.
      if (Math.abs(Math.abs(facing) - 1) > 1e-6)
        return { ok: false, reason: 'unsupported-surface' };
      planeAt = (surface.offset - dot(surface.normal, origin)) / facing;
      continue;
    }
    if (Math.abs(Math.abs(dot(surface.axis, axis)) - 1) > PARALLEL * 1e3)
      return { ok: false, reason: 'unsupported-surface' };
    const point = surface.kind === 'cylinder' ? surface.point : surface.apex;
    const between = sub(point, origin);
    const along = dot(between, axis);
    const off = Math.sqrt(Math.max(0, dot(between, between) - along * along));
    if (off > tol) return { ok: false, reason: 'unsupported-surface' };
    if (surface.kind === 'cylinder') {
      revolutions.push({ constant: surface.radius, rate: 0 });
    } else {
      // r = sense · (t − tApex) · slope, with t along the shared axis.
      const sense = surface.sense * Math.sign(dot(surface.axis, axis));
      const rate = sense * surface.slope;
      revolutions.push({ constant: -rate * along, rate });
    }
  }

  let t: number;
  if (planeAt !== null) {
    t = planeAt;
  } else {
    const [p, q] = revolutions as [Revolution, Revolution];
    const rate = p.rate - q.rate;
    if (Math.abs(rate) < 1e-12) return { ok: false, reason: 'parallel' };
    t = (q.constant - p.constant) / rate;
  }
  const on = revolutions[0]!;
  const radius = on.constant + on.rate * t;
  if (radius < -tol) return { ok: false, reason: 'no-sharp' };
  return {
    ok: true,
    curve: {
      kind: 'circle',
      center: add(origin, scale(axis, t)),
      axis,
      radius: Math.max(0, radius)
    }
  };
}

/** Where the surfaces under two faces meet, or why that is not read. */
export function virtualSharp(a: FaceTopology, b: FaceTopology): SharpResult {
  const first = surfaceOf(a);
  const second = surfaceOf(b);
  if (!first || !second) return { ok: false, reason: 'unsupported-surface' };
  return sharpOfSurfaces(first, second);
}

/** A face that only rounds a corner: what a chamfer's end looks through. */
function isBlend(face: FaceTopology): boolean {
  const g = face.geometry;
  if (!g) return false;
  const type = g.surfaceType.toLowerCase();
  return (
    g.featureType === 'blend' ||
    type.includes('tor') ||
    type.includes('sphere')
  );
}

/** The faces sharing an edge with `face`, by the kernel's adjacency. */
export function neighbourFaces(
  face: FaceTopology,
  faces: readonly FaceTopology[],
  edges: readonly EdgeTopology[]
): FaceTopology[] {
  const hashes = new Set<number>();
  for (const edge of edges) {
    const adjacent = edge.adjacentFaceHashes ?? [];
    if (!adjacent.includes(face.hash)) continue;
    for (const hash of adjacent) if (hash !== face.hash) hashes.add(hash);
  }
  return faces.filter((other) => other !== face && hashes.has(other.hash));
}

export type ChamferReading =
  | {
      ok: true;
      kind: 'cone';
      /** The two end circles, nearer the axis's start first. */
      ends: [SharpCurve & { kind: 'circle' }, SharpCurve & { kind: 'circle' }];
      axis: Vector3;
      size: number;
      angleDeg: number;
    }
  | {
      ok: true;
      kind: 'plane';
      ends: [SharpCurve & { kind: 'line' }, SharpCurve & { kind: 'line' }];
      size: number;
      angleDeg: number;
    }
  | { ok: false; reason: 'not-a-chamfer' };

/**
 * A chamfer face's size and angle, measured between its virtual sharps with
 * the faces either side of it — through a blend to the face beyond, so a
 * blended chamfer reads as the sharp one it was drawn from.
 */
export function readChamfer(
  face: FaceTopology,
  faces: readonly FaceTopology[],
  edges: readonly EdgeTopology[],
  /**
   * The direction a planar chamfer is seen along: its ends are the two
   * neighbours it meets in lines running that way, not the caps across it.
   */
  look?: Vector3
): ChamferReading {
  const surface = surfaceOf(face);
  if (!surface || surface.kind === 'cylinder')
    return { ok: false, reason: 'not-a-chamfer' };
  const ends: FaceTopology[] = [];
  const seen = new Set<FaceTopology>([face]);
  for (const neighbour of neighbourFaces(face, faces, edges)) {
    if (seen.has(neighbour)) continue;
    seen.add(neighbour);
    if (!isBlend(neighbour)) {
      ends.push(neighbour);
      continue;
    }
    for (const beyond of neighbourFaces(neighbour, faces, edges)) {
      if (seen.has(beyond) || isBlend(beyond)) continue;
      seen.add(beyond);
      ends.push(beyond);
    }
  }
  if (surface.kind === 'cone') {
    const circles: { t: number; curve: SharpCurve & { kind: 'circle' } }[] = [];
    for (const end of ends) {
      const sharp = virtualSharp(face, end);
      if (!sharp.ok || sharp.curve.kind !== 'circle') continue;
      const curve = sharp.curve;
      const t = dot(sub(curve.center, surface.apex), surface.axis);
      if (
        !circles.some(
          (known) => Math.abs(known.t - t) <= tolerance(known.t, t, curve.radius)
        )
      )
        circles.push({ t, curve });
    }
    if (circles.length < 2) return { ok: false, reason: 'not-a-chamfer' };
    circles.sort((p, q) => p.t - q.t);
    const low = circles[0]!;
    const high = circles[circles.length - 1]!;
    return {
      ok: true,
      kind: 'cone',
      ends: [low.curve, high.curve],
      axis: surface.axis,
      size: high.t - low.t,
      angleDeg: (surface.halfAngle * 180) / Math.PI
    };
  }
  // A planar chamfer between two planes.
  const planes = ends
    .map((end) => ({ end, surface: surfaceOf(end) }))
    .filter(
      (entry): entry is { end: FaceTopology; surface: Surface & { kind: 'plane' } } =>
        entry.surface?.kind === 'plane'
    );
  const sides = planes
    .map((entry) => ({ ...entry, sharp: sharpOfSurfaces(surface, entry.surface) }))
    .filter(
      ({ sharp }) =>
        sharp.ok &&
        sharp.curve.kind === 'line' &&
        (!look ||
          Math.abs(Math.abs(dot(sharp.curve.direction, look)) - 1) <= 1e-6)
    );
  if (sides.length !== 2) return { ok: false, reason: 'not-a-chamfer' };
  planes.splice(0, planes.length, ...sides);
  const lines = sides.map(({ sharp }) => sharp);
  const corner = sharpOfSurfaces(planes[0]!.surface, planes[1]!.surface);
  if (
    !lines.every((line) => line.ok && line.curve.kind === 'line') ||
    !corner.ok ||
    corner.curve.kind !== 'line'
  )
    return { ok: false, reason: 'not-a-chamfer' };
  const [l0, l1] = lines.map(
    (line) => (line as { curve: SharpCurve & { kind: 'line' } }).curve
  ) as [SharpCurve & { kind: 'line' }, SharpCurve & { kind: 'line' }];
  const angles = planes.map(
    ({ surface: plane }) =>
      (Math.acos(Math.min(1, Math.abs(dot(plane.normal, surface.normal)))) *
        180) /
      Math.PI
  ) as [number, number];
  // The size is the leg on the neighbour the chamfer makes the smaller angle
  // with, and the angle is that one; a tie takes the first in hash order.
  const order = [0, 1].sort(
    (p, q) =>
      angles[p]! - angles[q]! ||
      planes[p]!.end.hash - planes[q]!.end.hash
  );
  const along = order[0]!;
  const line = along === 0 ? l0 : l1;
  const between = sub(line.point, corner.curve.point);
  const size = norm(cross(between, corner.curve.direction));
  return {
    ok: true,
    kind: 'plane',
    ends: [l0, l1],
    size,
    angleDeg: angles[along]!
  };
}
