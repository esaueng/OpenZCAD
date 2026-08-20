/**
 * B-Rep face → 2D DXF entities.
 *
 * Projects a PLANAR face's boundary wires into the face plane and emits
 * exact LINE/CIRCLE/ARC entities where the kernel's curves are exact, and
 * span-true polylines everywhere else. Arc identity comes from the kernel's
 * `getEdgeParamSpan` — an edge's endpoints subtend two arcs, and only the
 * kernel knows which one the edge is; reconstructing the choice from
 * endpoints alone flips intentional major arcs, which is not an acceptable
 * failure mode in a file someone laser-cuts. The `sampleEdge` fallback is
 * span-true for the same reason.
 *
 * Coordinates are scaled by `millimeterScale` after projection, so entities
 * land in millimetres regardless of document units (matching every other
 * exporter). Uniform scaling commutes with projection, which lets the
 * extraction read the UNSCALED build solid directly instead of resolving
 * the face again on a scaled copy.
 */

import type { DxfEntity } from '@openzcad/io-dxf';

/** The query surface this extraction needs from the kernel. */
export interface DxfFaceKernel {
  getSurfaceType(face: number): string;
  getFaceNormal(face: number): Float64Array | number[];
  getFaceWires(face: number): Uint32Array | number[];
  getWireEdges(wire: number): Uint32Array | number[];
  getEdgeCurveType(edge: number): string;
  getEdgeVertices(edge: number): Float64Array | number[];
  getEdgeParamSpan(edge: number): Float64Array | number[];
  evaluateEdgeCurve(edge: number, t: number): Float64Array | number[];
  measureCurvatureAtEdge(edge: number, t: number): Float64Array | number[];
  sampleEdge(edge: number, deflection: number): Float64Array | number[];
}

type Vec3 = readonly [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

function unit(a: Vec3, what: string): Vec3 {
  const n = norm(a);
  if (!(n > 1e-12)) {
    throw new Error(`DXF export: degenerate ${what}.`);
  }
  return mul(a, 1 / n);
}

const vec3At = (flat: ArrayLike<number>, index: number): Vec3 => [
  flat[index * 3]!,
  flat[index * 3 + 1]!,
  flat[index * 3 + 2]!
];

/** Chord deviation for spline/ellipse polylines, in output millimetres. */
const POLYLINE_DEFLECTION_MM = 0.02;

/** Below this, an edge's endpoints coincide and its curve is a closed loop. */
const CLOSED_EDGE_TOLERANCE = 1e-9;

interface PlaneFrame {
  readonly origin: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly scale: number;
}

function project(frame: PlaneFrame, p: Vec3): readonly [number, number] {
  const d = sub(p, frame.origin);
  return [dot(d, frame.u) * frame.scale, dot(d, frame.v) * frame.scale];
}

/**
 * Extract a planar face's boundary as 2D DXF entities in millimetres.
 *
 * Throws for non-planar faces: a cylinder wall has no faithful flat outline,
 * and silently unrolling or projecting one would put wrong geometry in a cut
 * file. The 2D frame is deterministic (derived from the face normal), so
 * repeat exports of an unchanged face are byte-identical.
 */
export function faceDxfEntities(
  kernel: DxfFaceKernel,
  face: number,
  millimeterScale: number
): DxfEntity[] {
  const surfaceType = kernel.getSurfaceType(face);
  if (surfaceType !== 'plane') {
    throw new Error(
      `DXF export needs a planar face; the selected face is ${surfaceType}.`
    );
  }
  if (!(millimeterScale > 0) || !Number.isFinite(millimeterScale)) {
    throw new Error(`DXF export: invalid unit scale ${millimeterScale}.`);
  }

  const wires = Array.from(kernel.getFaceWires(face));
  const firstEdges = Array.from(kernel.getWireEdges(wires[0]!));
  if (firstEdges.length === 0) {
    throw new Error('DXF export: the face has no boundary edges.');
  }

  const normalRaw = kernel.getFaceNormal(face);
  const n = unit([normalRaw[0]!, normalRaw[1]!, normalRaw[2]!], 'face normal');
  // Deterministic in-plane axes: pick the world axis least aligned with the
  // normal, so the frame never degenerates and never depends on wire order.
  const pick: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = unit(cross(pick, n), 'plane axis');
  const v = cross(n, u);
  const originFlat = kernel.getEdgeVertices(firstEdges[0]!);
  const frame: PlaneFrame = {
    origin: vec3At(originFlat, 0),
    u,
    v,
    scale: millimeterScale
  };

  const entities: DxfEntity[] = [];
  for (const wire of wires) {
    for (const edge of Array.from(kernel.getWireEdges(wire))) {
      entities.push(...edgeEntities(kernel, edge, frame));
    }
  }
  if (entities.length === 0) {
    throw new Error('DXF export: the face produced no drawable entities.');
  }
  return entities;
}

function edgeEntities(
  kernel: DxfFaceKernel,
  edge: number,
  frame: PlaneFrame
): DxfEntity[] {
  const kind = kernel.getEdgeCurveType(edge);
  const verts = kernel.getEdgeVertices(edge);
  const start = vec3At(verts, 0);
  const end = vec3At(verts, 1);

  if (kind === 'LINE') {
    if (norm(sub(end, start)) < CLOSED_EDGE_TOLERANCE) {
      return [];
    }
    return [{ kind: 'line', start: project(frame, start), end: project(frame, end) }];
  }

  if (kind === 'CIRCLE') {
    return circleEntities(kernel, edge, frame, start, end);
  }

  // Ellipses, free-form splines, and open conics: span-true polyline. The
  // deflection is requested in model units so the written file's deviation
  // is POLYLINE_DEFLECTION_MM after scaling.
  const flat = kernel.sampleEdge(edge, POLYLINE_DEFLECTION_MM / frame.scale);
  const points: Array<readonly [number, number]> = [];
  for (let i = 0; i * 3 < flat.length; i += 1) {
    points.push(project(frame, vec3At(flat, i)));
  }
  if (points.length < 2) {
    return [];
  }
  const closed = norm(sub(end, start)) < CLOSED_EDGE_TOLERANCE;
  return [{ kind: 'polyline', points, closed }];
}

function circleEntities(
  kernel: DxfFaceKernel,
  edge: number,
  frame: PlaneFrame,
  start: Vec3,
  end: Vec3
): DxfEntity[] {
  const span = kernel.getEdgeParamSpan(edge);
  const t0 = span[0]!;
  const t1 = span[1]!;
  const p0 = vec3At(kernel.evaluateEdgeCurve(edge, t0), 0);

  // Center from the curvature frame at the span start: the principal normal
  // points at the center, curvature is 1/r. Exact for circles, and equally
  // valid for NURBS edges the kernel recognizes as circular.
  const curvature = kernel.measureCurvatureAtEdge(edge, t0);
  const k = curvature[0]!;
  if (!(k > 1e-12)) {
    throw new Error('DXF export: circular edge reported zero curvature.');
  }
  const radius3 = 1 / k;
  const principal: Vec3 = [curvature[4]!, curvature[5]!, curvature[6]!];
  const center3 = add(p0, mul(unit(principal, 'curvature normal'), radius3));
  const center = project(frame, center3);
  const radius = radius3 * frame.scale;

  if (norm(sub(end, start)) < CLOSED_EDGE_TOLERANCE) {
    return [{ kind: 'circle', center, radius }];
  }

  // Three points fix the arc: start and end give the two candidate sweeps,
  // the span midpoint says which one the edge actually covers. DXF arcs are
  // always CCW from startAngle to endAngle.
  const angleOf = (p: readonly [number, number]): number =>
    (Math.atan2(p[1] - center[1], p[0] - center[0]) * 180) / Math.PI;
  const aStart = angleOf(project(frame, p0));
  const aEnd = angleOf(project(frame, vec3At(kernel.evaluateEdgeCurve(edge, t1), 0)));
  const aMid = angleOf(
    project(frame, vec3At(kernel.evaluateEdgeCurve(edge, (t0 + t1) / 2), 0))
  );
  const ccwContains = (from: number, to: number, probe: number): boolean => {
    const sweep = (((to - from) % 360) + 360) % 360;
    const offset = (((probe - from) % 360) + 360) % 360;
    return offset <= sweep + 1e-9;
  };
  return ccwContains(aStart, aEnd, aMid)
    ? [{ kind: 'arc', center, radius, startAngleDeg: aStart, endAngleDeg: aEnd }]
    : [{ kind: 'arc', center, radius, startAngleDeg: aEnd, endAngleDeg: aStart }];
}
