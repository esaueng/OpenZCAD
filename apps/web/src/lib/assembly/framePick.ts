import {
  cross3,
  dot3,
  frameFromAxis,
  type AssemblyFrame,
  type AssemblyFrameSource,
  type BodyTopology,
  type EdgeTopology,
  type FaceTopology,
  type Vector3
} from '@openzcad/shared';

/**
 * Joint frames picked in the viewport (AS02). Pure: given what the pointer
 * landed on — a face, an edge, or a point near a vertex — and the body's
 * exact topology, the frame a joint end takes there, in the component's
 * modelled coordinates (the caller converts the hit out of the posed view
 * first). The same pick always yields the same frame: every axis goes
 * through the deterministic {@link frameFromAxis}.
 *
 * Exact kernel data is used wherever the projection publishes it: a circular
 * edge's `curve.circle`, a cylinder's `axisStart`/`axisEnd`, a cone's apex
 * and axis, a torus's centre and axis, a plane's `normal`/`planeOffset`, a
 * vertex's `point`. Where it is missing the frame is fitted from the edge's
 * display polyline or the hit triangle's normal; those fits are noted in the
 * source label as approximate so the user is never told a fit is exact.
 */

export interface FramePickHit {
  /** What the pointer resolved to. */
  kind: 'face' | 'edge' | 'body';
  /** The face or edge, for `face` and `edge` hits. */
  topologyId?: string;
  /** The hit point, modelled coordinates (mm). */
  point: Vector3;
  /** The hit triangle's normal, modelled coordinates; any length. */
  normal?: Vector3;
}

export interface FramePickOptions {
  /**
   * How close (mm, modelled) the hit must come to a vertex, a face centroid
   * or a cylinder axis end to snap onto it. Callers pass a few screen
   * pixels converted to world units at the hit. 0 disables those snaps.
   */
  snapTolerance?: number;
}

export interface FramePickResult {
  frame: AssemblyFrame;
  source: AssemblyFrameSource;
}

/** Below this an edge's samples count as one point and give no direction. */
const MIN_EXTENT = 1e-9;
/** A fitted circle must match every sample to this fraction of its radius. */
const CIRCLE_FIT_RELATIVE_TOLERANCE = 1e-3;
/** And this absolute floor, mm. */
const CIRCLE_FIT_ABSOLUTE_TOLERANCE = 1e-6;
/** Samples within this fraction of their extent of one line are a line. */
const COLLINEAR_RELATIVE_TOLERANCE = 1e-6;

function v(x: number, y: number, z: number): Vector3 {
  return { x, y, z };
}

function add(a: Vector3, b: Vector3): Vector3 {
  return v(a.x + b.x, a.y + b.y, a.z + b.z);
}

function sub(a: Vector3, b: Vector3): Vector3 {
  return v(a.x - b.x, a.y - b.y, a.z - b.z);
}

function scale(a: Vector3, s: number): Vector3 {
  return v(a.x * s, a.y * s, a.z * s);
}

function length(a: Vector3): number {
  return Math.hypot(a.x, a.y, a.z);
}

function distance(a: Vector3, b: Vector3): number {
  return length(sub(a, b));
}

function unit(a: Vector3): Vector3 | null {
  const l = length(a);
  return l > 1e-12 && Number.isFinite(l) ? scale(a, 1 / l) : null;
}

function finite(a: Vector3 | undefined): a is Vector3 {
  return (
    !!a && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)
  );
}

/** The closest point to `point` on the line through `origin` along unit `axis`. */
function projectOnAxis(
  point: Vector3,
  origin: Vector3,
  axis: Vector3
): { at: Vector3; t: number } {
  const t = dot3(sub(point, origin), axis);
  return { at: add(origin, scale(axis, t)), t };
}

function edgePoints(edge: EdgeTopology): Vector3[] {
  const points: Vector3[] = [];
  for (let index = 0; index + 2 < edge.points.length; index += 3) {
    const point = v(
      edge.points[index] as number,
      edge.points[index + 1] as number,
      edge.points[index + 2] as number
    );
    if (finite(point)) points.push(point);
  }
  return points;
}

function centroidOf(points: readonly Vector3[]): Vector3 {
  let sum = v(0, 0, 0);
  for (const point of points) sum = add(sum, point);
  return scale(sum, 1 / Math.max(points.length, 1));
}

/**
 * The best-fit circle through a polyline's samples, or null when they do
 * not lie on one. An approximation: the plane is Newell's normal of the
 * samples, the centre and radius a least-squares (Kåsa) fit in that plane,
 * accepted only when every sample sits within a thousandth of the radius.
 * Used only when the kernel published no exact circle for the edge.
 */
export function fitCircle(
  points: readonly Vector3[]
): { center: Vector3; axis: Vector3; radius: number } | null {
  // A closed polyline repeats its first point; drop it so it does not weigh twice.
  const samples =
    points.length > 3 &&
    distance(points[0] as Vector3, points[points.length - 1] as Vector3) <=
      MIN_EXTENT
      ? points.slice(0, -1)
      : [...points];
  if (samples.length < 3) return null;
  const mean = centroidOf(samples);
  let normal = v(0, 0, 0);
  for (let index = 0; index < samples.length; index += 1) {
    const a = sub(samples[index] as Vector3, mean);
    const b = sub(samples[(index + 1) % samples.length] as Vector3, mean);
    normal = add(normal, cross3(a, b));
  }
  const axis = unit(normal);
  if (!axis) return null;
  const frame = frameFromAxis(mean, axis);
  if (!frame) return null;
  const xAxis = frame.xAxis;
  const yAxis = cross3(axis, xAxis);
  // Kåsa: minimise Σ (x² + y² − 2ax − 2by − c)², solved by normal equations.
  let sxx = 0,
    sxy = 0,
    syy = 0,
    sx = 0,
    sy = 0,
    sxz = 0,
    syz = 0,
    sz = 0;
  const n = samples.length;
  const local = samples.map((point) => {
    const offset = sub(point, mean);
    return { x: dot3(offset, xAxis), y: dot3(offset, yAxis) };
  });
  for (const { x, y } of local) {
    const z = x * x + y * y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sx += x;
    sy += y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  // [2sxx 2sxy sx][a]   [sxz]
  // [2sxy 2syy sy][b] = [syz]
  // [2sx  2sy  n ][c]   [sz ]
  const m = [
    [2 * sxx, 2 * sxy, sx, sxz],
    [2 * sxy, 2 * syy, sy, syz],
    [2 * sx, 2 * sy, n, sz]
  ];
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1)
      if (
        Math.abs((m[row] as number[])[col] as number) >
        Math.abs((m[pivot] as number[])[col] as number)
      )
        pivot = row;
    [m[col], m[pivot]] = [m[pivot] as number[], m[col] as number[]];
    const p = (m[col] as number[])[col] as number;
    if (Math.abs(p) < 1e-18) return null;
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = ((m[row] as number[])[col] as number) / p;
      for (let k = col; k < 4; k += 1)
        (m[row] as number[])[k] =
          ((m[row] as number[])[k] as number) -
          factor * ((m[col] as number[])[k] as number);
    }
  }
  const a =
    ((m[0] as number[])[3] as number) / ((m[0] as number[])[0] as number);
  const b =
    ((m[1] as number[])[3] as number) / ((m[1] as number[])[1] as number);
  const c =
    ((m[2] as number[])[3] as number) / ((m[2] as number[])[2] as number);
  const radius = Math.sqrt(c + a * a + b * b);
  if (!(radius > MIN_EXTENT) || !Number.isFinite(radius)) return null;
  const tolerance = Math.max(
    radius * CIRCLE_FIT_RELATIVE_TOLERANCE,
    CIRCLE_FIT_ABSOLUTE_TOLERANCE
  );
  for (const { x, y } of local)
    if (Math.abs(Math.hypot(x - a, y - b) - radius) > tolerance) return null;
  // Out of plane too.
  for (const point of samples)
    if (Math.abs(dot3(sub(point, mean), axis)) > tolerance) return null;
  return {
    center: add(mean, add(scale(xAxis, a), scale(yAxis, b))),
    axis,
    radius
  };
}

/** The line a polyline runs along, or null when its samples are not collinear. */
function fitLine(
  points: readonly Vector3[]
): { start: Vector3; end: Vector3 } | null {
  const start = points[0];
  const end = points[points.length - 1];
  if (!start || !end) return null;
  const extent = distance(start, end);
  if (!(extent > MIN_EXTENT)) return null;
  const direction = scale(sub(end, start), 1 / extent);
  for (const point of points) {
    const offset = sub(point, start);
    const off = length(sub(offset, scale(direction, dot3(offset, direction))));
    if (off > extent * COLLINEAR_RELATIVE_TOLERANCE + MIN_EXTENT) return null;
  }
  return { start, end };
}

function faceByHash(
  topology: BodyTopology,
  hash: number
): FaceTopology | undefined {
  return topology.faces.find((face) => face.hash === hash);
}

/**
 * The outward normal of the first planar face (in the edge's own sorted
 * hash order) that an edge bounds and that is perpendicular to `axis` when
 * one is given. Used to point a circle's Z out of the face it rims.
 */
function adjacentPlaneNormal(
  topology: BodyTopology,
  edge: EdgeTopology,
  axis?: Vector3
): Vector3 | null {
  for (const hash of edge.adjacentFaceHashes ?? []) {
    const normal = faceByHash(topology, hash)?.geometry?.normal;
    const n = finite(normal) ? unit(normal) : null;
    if (!n) continue;
    if (axis && Math.abs(Math.abs(dot3(n, axis)) - 1) > 1e-6) continue;
    return n;
  }
  return null;
}

/** Orients an unoriented axis to agree with a preferred direction. */
function orient(axis: Vector3, preferred: Vector3 | null): Vector3 {
  return preferred && dot3(axis, preferred) < 0 ? scale(axis, -1) : axis;
}

function result(
  origin: Vector3,
  zAxis: Vector3,
  kind: AssemblyFrameSource['kind'],
  label: string,
  xHint?: Vector3
): FramePickResult | null {
  const frame = frameFromAxis(origin, zAxis, xHint);
  return frame ? { frame, source: { kind, label } } : null;
}

/**
 * The topology vertex within `tolerance` of `point`, nearest first (ties by
 * id), or null. Vertices are not pickable meshes, so the viewport snaps to
 * one when a face or edge hit lands this close to it.
 */
export function nearestVertex(
  topology: BodyTopology | undefined,
  point: Vector3,
  tolerance: number
): { id: number; point: Vector3 } | null {
  if (!topology?.vertices || !(tolerance > 0)) return null;
  let best: { id: number; point: Vector3; gap: number } | null = null;
  for (const vertex of topology.vertices) {
    if (!finite(vertex.point)) continue;
    const gap = distance(vertex.point, point);
    if (gap > tolerance) continue;
    if (
      !best ||
      gap < best.gap - 1e-12 ||
      (Math.abs(gap - best.gap) <= 1e-12 && vertex.id < best.id)
    )
      best = { id: vertex.id, point: vertex.point, gap };
  }
  return best ? { id: best.id, point: best.point } : null;
}

function vertexFrame(
  topology: BodyTopology,
  vertex: { id: number; point: Vector3 },
  hit: FramePickHit
): FramePickResult | null {
  // Z: the hit face's own normal when it is an exact plane through the
  // vertex, else the first exact planar face at the vertex, else the
  // triangle the pointer is over.
  let z: Vector3 | null = null;
  if (hit.kind === 'face') {
    const normal = topology.faces.find((f) => f.topologyId === hit.topologyId)
      ?.geometry?.normal;
    z = finite(normal) ? unit(normal) : null;
  }
  if (!z) {
    const hashes = new Set<number>();
    for (const edge of topology.edges)
      if (edge.vertexIds?.includes(vertex.id))
        for (const hash of edge.adjacentFaceHashes ?? []) hashes.add(hash);
    for (const hash of [...hashes].sort((a, b) => a - b)) {
      const normal = faceByHash(topology, hash)?.geometry?.normal;
      z = finite(normal) ? unit(normal) : null;
      if (z) break;
    }
  }
  if (!z && finite(hit.normal)) z = unit(hit.normal);
  if (!z) return null;
  return result(vertex.point, z, 'vertex', 'Vertex');
}

function edgeFrame(
  topology: BodyTopology,
  edge: EdgeTopology
): FramePickResult | null {
  const circle = edge.curve?.circle;
  if (circle && finite(circle.center) && finite(circle.axis)) {
    const axis = unit(circle.axis);
    if (axis) {
      const z = orient(axis, adjacentPlaneNormal(topology, edge, axis));
      const closed = new Set(edge.vertexIds ?? []).size === 1;
      return result(
        circle.center,
        z,
        'circle',
        closed ? 'Circular edge · centre' : 'Arc · centre'
      );
    }
  }
  const points = edgePoints(edge);
  const type = edge.curve?.type?.toUpperCase();
  if (type !== 'LINE') {
    // No exact circle published: fit one to the display samples.
    const fitted = type === 'CIRCLE' || !type ? fitCircle(points) : null;
    if (fitted) {
      const z = orient(
        fitted.axis,
        adjacentPlaneNormal(topology, edge, fitted.axis)
      );
      return result(
        fitted.center,
        z,
        'circle',
        'Circular edge · centre (fitted)'
      );
    }
  }
  const line = type === 'LINE' || !type ? fitLine(points) : null;
  if (line) {
    const direction = unit(sub(line.end, line.start));
    if (!direction) return null;
    const midpoint = scale(add(line.start, line.end), 0.5);
    return result(
      midpoint,
      direction,
      'line',
      'Edge · midpoint',
      adjacentPlaneNormal(topology, edge) ?? undefined
    );
  }
  return null;
}

function faceFrame(
  face: FaceTopology,
  hit: FramePickHit,
  snapTolerance: number
): FramePickResult | null {
  const g = face.geometry;
  const type = g?.surfaceType?.toUpperCase() ?? '';
  // Cylinder: the axis, at the point nearest the hit (or an end within reach).
  if (g && finite(g.axisStart) && finite(g.axisEnd)) {
    const span = sub(g.axisEnd, g.axisStart);
    const axis = unit(span);
    if (axis) {
      const { at, t } = projectOnAxis(hit.point, g.axisStart, axis);
      const spanLength = length(span);
      if (snapTolerance > 0 && Math.abs(t) <= snapTolerance)
        return result(g.axisStart, axis, 'cylinder', 'Cylinder axis · end');
      if (snapTolerance > 0 && Math.abs(t - spanLength) <= snapTolerance)
        return result(g.axisEnd, axis, 'cylinder', 'Cylinder axis · end');
      return result(at, axis, 'cylinder', 'Cylinder axis');
    }
  }
  // Cone: its axis through the apex, at the point nearest the hit.
  if (g && finite(g.apex) && finite(g.axis)) {
    const axis = unit(g.axis);
    if (axis) {
      const { at } = projectOnAxis(hit.point, g.apex, axis);
      return result(at, axis, 'cylinder', 'Cone axis');
    }
  }
  // Torus: its centre and axis.
  if (g && finite(g.torusCenter) && finite(g.axis)) {
    const axis = unit(g.axis);
    if (axis) return result(g.torusCenter, axis, 'circle', 'Torus · centre');
  }
  // Exact plane: the hit dropped onto it, or the area centroid within reach.
  if (g && finite(g.normal)) {
    const normal = unit(g.normal);
    if (normal) {
      if (
        snapTolerance > 0 &&
        finite(g.centroid) &&
        distance(g.centroid, hit.point) <= snapTolerance
      )
        return result(g.centroid, normal, 'plane', 'Face · centre');
      const offset =
        typeof g.planeOffset === 'number' && Number.isFinite(g.planeOffset)
          ? g.planeOffset
          : dot3(normal, finite(g.centroid) ? g.centroid : hit.point);
      const onPlane = sub(
        hit.point,
        scale(normal, dot3(normal, hit.point) - offset)
      );
      return result(onPlane, normal, 'plane', 'Face · point');
    }
  }
  // Anything else: the hit point on the triangle under the pointer.
  if (finite(hit.normal)) {
    const normal = unit(hit.normal);
    if (normal)
      return result(
        hit.point,
        normal,
        'plane',
        type === 'PLANE' ? 'Face · point (fitted)' : 'Surface · point (fitted)'
      );
  }
  return null;
}

/**
 * The joint frame a pick names, or null when the hit carries nothing a
 * frame can be built from. Precedence: a vertex within the snap tolerance,
 * then the picked edge (circle → its centre and axis; straight → its
 * midpoint and direction), then the picked face (cylinder or cone axis,
 * torus centre, plane), then the hit triangle.
 */
export function deriveJointFrame(
  topology: BodyTopology | undefined,
  hit: FramePickHit,
  options: FramePickOptions = {}
): FramePickResult | null {
  if (!finite(hit.point)) return null;
  const snapTolerance = Math.max(0, options.snapTolerance ?? 0);
  if (topology) {
    const vertex = nearestVertex(topology, hit.point, snapTolerance);
    if (vertex) {
      const frame = vertexFrame(topology, vertex, hit);
      if (frame) return frame;
    }
    if (hit.kind === 'edge') {
      const edge = topology.edges.find((e) => e.topologyId === hit.topologyId);
      const frame = edge ? edgeFrame(topology, edge) : null;
      if (frame) return frame;
    }
    if (hit.kind === 'face') {
      const face = topology.faces.find((f) => f.topologyId === hit.topologyId);
      const frame = face ? faceFrame(face, hit, snapTolerance) : null;
      if (frame) return frame;
    }
  }
  if (finite(hit.normal)) {
    const normal = unit(hit.normal);
    if (normal)
      return result(hit.point, normal, 'body', 'Body · point (fitted)');
  }
  return null;
}
