import type { ParamValue, SketchObjectData } from '@openzcad/shared';
import { GEOMETRY_LINEAR_TOLERANCE } from './tolerance';

/**
 * Planar region detection for sketches.
 *
 * Sketch objects are resolved to primitive curves (segments and arcs), split
 * at their mutual intersections, and stitched into a half-edge planar
 * arrangement. Tracing the arrangement yields every closed region the curves
 * bound — including regions with holes (the ring between concentric circles)
 * and regions created by open curves cutting through closed ones (the two
 * pieces of a circle split by a chord). The viewport uses the sampled
 * polylines for hover fills and picking; the kernel adapters rebuild the same
 * loops as exact wires.
 */

export interface Vec2Like {
  x: number;
  y: number;
}

export type RegionCurve =
  | { kind: 'line'; a: Vec2Like; b: Vec2Like; sourceObjectId: string }
  | {
      kind: 'arc';
      center: Vec2Like;
      radius: number;
      /** Radians. The loop travels from startAngle to endAngle; ccw says in which direction. */
      startAngle: number;
      endAngle: number;
      ccw: boolean;
      sourceObjectId: string;
    };

export interface RegionLoop {
  curves: RegionCurve[];
  /** Sampled closed boundary (first point is not repeated at the end). */
  polyline: Vec2Like[];
}

export interface SketchRegion {
  /**
   * FNV-1a hash of the region's quantized boundary geometry, independent of
   * object order and loop traversal direction. Stable across rebuilds while
   * the boundary geometry is unchanged; any curve edit changes it, and
   * consumers fall back to samplePoint + area matching.
   */
  regionFingerprint: number;
  outer: RegionLoop;
  holes: RegionLoop[];
  area: number;
  /** A point strictly inside the region (outside all holes). */
  samplePoint: Vec2Like;
}

export interface SketchRegionObject {
  id: string;
  data: SketchObjectData;
}

// ---------------------------------------------------------------------------
// Primitive curves
// ---------------------------------------------------------------------------

interface SegCurve {
  kind: 'seg';
  ax: number;
  ay: number;
  bx: number;
  by: number;
  sourceObjectId: string;
}

interface ArcCurve {
  kind: 'arc';
  cx: number;
  cy: number;
  r: number;
  /** Start angle in radians. */
  a0: number;
  /** CCW sweep in radians; 2π for a full circle. */
  sweep: number;
  sourceObjectId: string;
}

type Curve = SegCurve | ArcCurve;

const TWO_PI = Math.PI * 2;
/** Samples for a full circle when producing polylines. */
const CIRCLE_POLYLINE_SEGMENTS = 64;
/** Quantization used by the fingerprint (coarser than the merge tolerance). */
const FINGERPRINT_QUANTUM = 1e-4;

function normalizeAngle(angle: number): number {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

function closedPolyCurves(
  points: Vec2Like[],
  sourceObjectId: string
): Curve[] {
  const curves: Curve[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    curves.push({
      kind: 'seg',
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      sourceObjectId
    });
  }
  return curves;
}

function curvesForObject(
  object: SketchRegionObject,
  resolve: (value: ParamValue) => number
): Curve[] {
  const data = object.data;
  switch (data.objectKind) {
    case 'line': {
      return [
        {
          kind: 'seg',
          ax: resolve(data.x1),
          ay: resolve(data.y1),
          bx: resolve(data.x2),
          by: resolve(data.y2),
          sourceObjectId: object.id
        }
      ];
    }
    case 'rectangle': {
      const width = resolve(data.width);
      const height = resolve(data.height);
      const cx = resolve(data.centerX);
      const cy = resolve(data.centerY);
      const x = width / 2;
      const y = height / 2;
      return closedPolyCurves(
        [
          { x: cx - x, y: cy - y },
          { x: cx + x, y: cy - y },
          { x: cx + x, y: cy + y },
          { x: cx - x, y: cy + y }
        ],
        object.id
      );
    }
    case 'polygon': {
      const sides = Math.max(3, Math.round(resolve(data.sides)));
      const radius = resolve(data.radius);
      const cx = resolve(data.centerX);
      const cy = resolve(data.centerY);
      const points: Vec2Like[] = [];
      for (let i = 0; i < sides; i += 1) {
        // Same top-first orientation as polygonProfile.
        const angle = (i / sides) * TWO_PI + Math.PI / 2;
        points.push({
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius
        });
      }
      return closedPolyCurves(points, object.id);
    }
    case 'circle': {
      return [
        {
          kind: 'arc',
          cx: resolve(data.centerX),
          cy: resolve(data.centerY),
          r: resolve(data.radius),
          a0: 0,
          sweep: TWO_PI,
          sourceObjectId: object.id
        }
      ];
    }
    case 'arc': {
      const start = (resolve(data.startAngleDeg) * Math.PI) / 180;
      const end = (resolve(data.endAngleDeg) * Math.PI) / 180;
      let sweep = end - start;
      if (sweep <= 0) {
        sweep += TWO_PI;
      }
      return [
        {
          kind: 'arc',
          cx: resolve(data.centerX),
          cy: resolve(data.centerY),
          r: resolve(data.radius),
          a0: normalizeAngle(start),
          sweep,
          sourceObjectId: object.id
        }
      ];
    }
  }
}

// ---------------------------------------------------------------------------
// Intersections
// ---------------------------------------------------------------------------

/** Split positions along a curve: segment parameter t in (0,1) or arc angle offset in (0,sweep). */
function segPoint(seg: SegCurve, t: number): Vec2Like {
  return {
    x: seg.ax + (seg.bx - seg.ax) * t,
    y: seg.ay + (seg.by - seg.ay) * t
  };
}

function arcPoint(arc: ArcCurve, offset: number): Vec2Like {
  const angle = arc.a0 + offset;
  return {
    x: arc.cx + Math.cos(angle) * arc.r,
    y: arc.cy + Math.sin(angle) * arc.r
  };
}

function segSegIntersections(
  a: SegCurve,
  b: SegCurve,
  tolerance: number
): { ta: number; tb: number }[] {
  const rx = a.bx - a.ax;
  const ry = a.by - a.ay;
  const sx = b.bx - b.ax;
  const sy = b.by - b.ay;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < tolerance * tolerance) {
    // Parallel (collinear overlap is not resolved in v1).
    return [];
  }
  const qpx = b.ax - a.ax;
  const qpy = b.ay - a.ay;
  const ta = (qpx * sy - qpy * sx) / denominator;
  const tb = (qpx * ry - qpy * rx) / denominator;
  const slack = tolerance;
  const lenA = Math.hypot(rx, ry) || 1;
  const lenB = Math.hypot(sx, sy) || 1;
  if (
    ta < -slack / lenA ||
    ta > 1 + slack / lenA ||
    tb < -slack / lenB ||
    tb > 1 + slack / lenB
  ) {
    return [];
  }
  return [{ ta: Math.min(Math.max(ta, 0), 1), tb: Math.min(Math.max(tb, 0), 1) }];
}

/** Angle offsets (relative to arc.a0, within [0, sweep]) where the arc meets the full line through the segment. */
function arcOffsetsOnArc(arc: ArcCurve, angle: number): number | null {
  const offset = normalizeAngle(angle - arc.a0);
  if (offset <= arc.sweep + 1e-9) {
    return Math.min(offset, arc.sweep);
  }
  // Endpoints may re-wrap on to the arc within tolerance.
  if (offset - TWO_PI >= -1e-9) {
    return 0;
  }
  return null;
}

function segArcIntersections(
  seg: SegCurve,
  arc: ArcCurve,
  tolerance: number
): { tSeg: number; arcOffset: number }[] {
  const dx = seg.bx - seg.ax;
  const dy = seg.by - seg.ay;
  const fx = seg.ax - arc.cx;
  const fy = seg.ay - arc.cy;
  const a = dx * dx + dy * dy;
  if (a < tolerance * tolerance) {
    return [];
  }
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - arc.r * arc.r;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return [];
  }
  const root = Math.sqrt(Math.max(discriminant, 0));
  const results: { tSeg: number; arcOffset: number }[] = [];
  const length = Math.sqrt(a);
  for (const t of discriminant === 0
    ? [-b / (2 * a)]
    : [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
    if (t < -tolerance / length || t > 1 + tolerance / length) {
      continue;
    }
    const clamped = Math.min(Math.max(t, 0), 1);
    const point = segPoint(seg, clamped);
    const angle = Math.atan2(point.y - arc.cy, point.x - arc.cx);
    const offset = arcOffsetsOnArc(arc, angle);
    if (offset !== null) {
      results.push({ tSeg: clamped, arcOffset: offset });
    }
  }
  return results;
}

function arcArcIntersections(
  a: ArcCurve,
  b: ArcCurve,
  tolerance: number
): { offsetA: number; offsetB: number }[] {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const distance = Math.hypot(dx, dy);
  if (distance < tolerance) {
    // Concentric: either disjoint or identical radius (overlap unsupported).
    return [];
  }
  if (
    distance > a.r + b.r + tolerance ||
    distance < Math.abs(a.r - b.r) - tolerance
  ) {
    return [];
  }
  const along = (distance * distance + a.r * a.r - b.r * b.r) / (2 * distance);
  const perpSquared = a.r * a.r - along * along;
  const perp = Math.sqrt(Math.max(perpSquared, 0));
  const baseX = a.cx + (dx / distance) * along;
  const baseY = a.cy + (dy / distance) * along;
  const offsets: { offsetA: number; offsetB: number }[] = [];
  const candidates =
    perp < tolerance
      ? [{ x: baseX, y: baseY }]
      : [
          { x: baseX + (-dy / distance) * perp, y: baseY + (dx / distance) * perp },
          { x: baseX - (-dy / distance) * perp, y: baseY - (dx / distance) * perp }
        ];
  for (const point of candidates) {
    const offsetA = arcOffsetsOnArc(
      a,
      Math.atan2(point.y - a.cy, point.x - a.cx)
    );
    const offsetB = arcOffsetsOnArc(
      b,
      Math.atan2(point.y - b.cy, point.x - b.cx)
    );
    if (offsetA !== null && offsetB !== null) {
      offsets.push({ offsetA, offsetB });
    }
  }
  return offsets;
}

// ---------------------------------------------------------------------------
// Arrangement
// ---------------------------------------------------------------------------

interface SubCurve {
  curve: Curve;
  /** Segment t range or arc offset range of the piece. */
  from: number;
  to: number;
  start: Vec2Like;
  end: Vec2Like;
}

interface HalfEdge {
  id: number;
  twin: number;
  origin: number;
  target: number;
  sub: SubCurve;
  /** True when the half-edge travels the sub-curve from `from` to `to`. */
  forward: boolean;
  departAngle: number;
  departCurvature: number;
  next: number;
  visited: boolean;
}

interface NodeRecord {
  x: number;
  y: number;
  outgoing: number[];
}

function splitPositions(curve: Curve, cuts: number[]): SubCurve[] {
  const isArc = curve.kind === 'arc';
  const end = isArc ? curve.sweep : 1;
  const closed = isArc && Math.abs(curve.sweep - TWO_PI) < 1e-9;
  const sorted = [...new Set(cuts.map((cut) => Math.min(Math.max(cut, 0), end)))]
    .filter((cut) => (closed ? true : cut > 1e-9 && cut < end - 1e-9))
    .sort((left, right) => left - right);
  const bounds: number[] = closed
    ? sorted.length > 0
      ? [...sorted, sorted[0]! + end]
      : [0, end]
    : [0, ...sorted, end];
  const pieces: SubCurve[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const from = bounds[i]!;
    const to = bounds[i + 1]!;
    if (to - from < 1e-9) {
      continue;
    }
    const evaluate = (position: number): Vec2Like =>
      curve.kind === 'seg'
        ? segPoint(curve, Math.min(position, 1))
        : arcPoint(curve, position);
    pieces.push({
      curve,
      from,
      to,
      start: evaluate(from),
      end: evaluate(to)
    });
  }
  return pieces;
}

function buildSubCurves(curves: Curve[], tolerance: number): SubCurve[] {
  const cuts: number[][] = curves.map(() => []);
  for (let i = 0; i < curves.length; i += 1) {
    for (let j = i + 1; j < curves.length; j += 1) {
      const a = curves[i]!;
      const b = curves[j]!;
      if (a.kind === 'seg' && b.kind === 'seg') {
        for (const hit of segSegIntersections(a, b, tolerance)) {
          cuts[i]!.push(hit.ta);
          cuts[j]!.push(hit.tb);
        }
      } else if (a.kind === 'seg' && b.kind === 'arc') {
        for (const hit of segArcIntersections(a, b, tolerance)) {
          cuts[i]!.push(hit.tSeg);
          cuts[j]!.push(hit.arcOffset);
        }
      } else if (a.kind === 'arc' && b.kind === 'seg') {
        for (const hit of segArcIntersections(b, a, tolerance)) {
          cuts[i]!.push(hit.arcOffset);
          cuts[j]!.push(hit.tSeg);
        }
      } else if (a.kind === 'arc' && b.kind === 'arc') {
        for (const hit of arcArcIntersections(a, b, tolerance)) {
          cuts[i]!.push(hit.offsetA);
          cuts[j]!.push(hit.offsetB);
        }
      }
    }
  }
  return curves.flatMap((curve, index) => splitPositions(curve, cuts[index]!));
}

function departure(
  sub: SubCurve,
  forward: boolean
): { angle: number; curvature: number } {
  if (sub.curve.kind === 'seg') {
    const dx = forward ? sub.curve.bx - sub.curve.ax : sub.curve.ax - sub.curve.bx;
    const dy = forward ? sub.curve.by - sub.curve.ay : sub.curve.ay - sub.curve.by;
    return { angle: Math.atan2(dy, dx), curvature: 0 };
  }
  const arc = sub.curve;
  if (forward) {
    // Traveling CCW: tangent leads the radius by 90°, curving left.
    const angle = arc.a0 + sub.from + Math.PI / 2;
    return { angle: Math.atan2(Math.sin(angle), Math.cos(angle)), curvature: 1 / arc.r };
  }
  const angle = arc.a0 + sub.to - Math.PI / 2;
  return {
    angle: Math.atan2(Math.sin(angle), Math.cos(angle)),
    curvature: -1 / arc.r
  };
}

function sampleSub(sub: SubCurve): Vec2Like[] {
  if (sub.curve.kind === 'seg') {
    return [sub.start, sub.end];
  }
  const arc = sub.curve;
  const span = sub.to - sub.from;
  const steps = Math.max(
    2,
    Math.ceil((span / TWO_PI) * CIRCLE_POLYLINE_SEGMENTS)
  );
  const points: Vec2Like[] = [];
  for (let i = 0; i <= steps; i += 1) {
    points.push(arcPoint(arc, sub.from + (span * i) / steps));
  }
  return points;
}

function pointInPolyline(point: Vec2Like, polyline: Vec2Like[]): boolean {
  let inside = false;
  for (let i = 0, j = polyline.length - 1; i < polyline.length; j = i, i += 1) {
    const a = polyline[i]!;
    const b = polyline[j]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToPolyline(point: Vec2Like, polyline: Vec2Like[]): number {
  let best = Infinity;
  for (let i = 0; i < polyline.length; i += 1) {
    const a = polyline[i]!;
    const b = polyline[(i + 1) % polyline.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 0
        ? Math.min(
            Math.max(
              ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared,
              0
            ),
            1
          )
        : 0;
    best = Math.min(
      best,
      Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t))
    );
  }
  return best;
}

interface TracedLoop {
  halfEdges: HalfEdge[];
  polyline: Vec2Like[];
  area: number;
}

/**
 * Exact signed loop area: shoelace over the sub-curve chords plus the
 * circular-segment correction for each arc piece. Polyline areas drift by
 * ~(2π/n)²/6 per circle, which is enough to break the ±1% area matching used
 * for extrude re-resolution; this stays exact regardless of sampling.
 */
function loopExactArea(loopEdges: HalfEdge[]): number {
  let area = 0;
  for (const edge of loopEdges) {
    const start = edge.forward ? edge.sub.start : edge.sub.end;
    const end = edge.forward ? edge.sub.end : edge.sub.start;
    area += (start.x * end.y - end.x * start.y) / 2;
    if (edge.sub.curve.kind === 'arc') {
      const sweep = edge.sub.to - edge.sub.from;
      const signedSweep = edge.forward ? sweep : -sweep;
      area +=
        ((edge.sub.curve.r * edge.sub.curve.r) / 2) *
        (signedSweep - Math.sin(signedSweep));
    }
  }
  return area;
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

function quantize(value: number): number {
  const quantized = Math.round(value / FINGERPRINT_QUANTUM) * FINGERPRINT_QUANTUM;
  // Avoid -0 producing a different string than 0.
  return Object.is(quantized, -0) ? 0 : Number(quantized.toFixed(6));
}

function curveSignature(curve: RegionCurve): string {
  if (curve.kind === 'line') {
    const forward = [
      quantize(curve.a.x),
      quantize(curve.a.y),
      quantize(curve.b.x),
      quantize(curve.b.y)
    ];
    const backward = [forward[2], forward[3], forward[0], forward[1]];
    const canonical =
      forward.join(',') <= backward.join(',') ? forward : backward;
    return `L${canonical.join(',')}`;
  }
  const span = Math.abs(curve.endAngle - curve.startAngle);
  const isFullCircle = Math.abs(span - TWO_PI) < 1e-9;
  const base = `${quantize(curve.center.x)},${quantize(curve.center.y)},${quantize(curve.radius)}`;
  if (isFullCircle) {
    return `C${base}`;
  }
  const angles = [
    quantize(normalizeAngle(curve.startAngle)),
    quantize(normalizeAngle(curve.endAngle))
  ].sort((a, b) => a - b);
  return `A${base},${angles.join(',')}`;
}

function loopSignature(loop: RegionLoop): string {
  return loop.curves.map(curveSignature).sort().join('|');
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const result = hash >>> 0;
  return result === 0 ? 1 : result;
}

export function regionFingerprintOf(
  outer: RegionLoop,
  holes: RegionLoop[]
): number {
  const holeSignatures = holes.map(loopSignature).sort();
  return fnv1a([loopSignature(outer), ...holeSignatures].join('#'));
}

// ---------------------------------------------------------------------------
// Sample point
// ---------------------------------------------------------------------------

function samplePointFor(
  outer: Vec2Like[],
  holes: Vec2Like[][]
): Vec2Like | null {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of outer) {
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minY) || maxY - minY <= 0) {
    return null;
  }
  const boundaries = [outer, ...holes];
  let best: { width: number; point: Vec2Like } | null = null;
  const rows = 12;
  for (let row = 1; row < rows; row += 1) {
    // Irrational-ish spacing dodges vertices sitting exactly on the scanline.
    const y = minY + ((maxY - minY) * (row + 0.377)) / rows;
    const crossings: number[] = [];
    for (const polyline of boundaries) {
      for (let i = 0, j = polyline.length - 1; i < polyline.length; j = i, i += 1) {
        const a = polyline[i]!;
        const b = polyline[j]!;
        if (a.y > y !== b.y > y) {
          crossings.push(a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y));
        }
      }
    }
    crossings.sort((left, right) => left - right);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const width = crossings[i + 1]! - crossings[i]!;
      if (width > (best?.width ?? 0)) {
        best = {
          width,
          point: { x: (crossings[i]! + crossings[i + 1]!) / 2, y }
        };
      }
    }
  }
  return best?.point ?? null;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function computeSketchRegions(
  objects: SketchRegionObject[],
  resolve: (value: ParamValue) => number,
  tolerance = GEOMETRY_LINEAR_TOLERANCE
): SketchRegion[] {
  const curves: Curve[] = [];
  for (const object of objects) {
    try {
      curves.push(...curvesForObject(object, resolve));
    } catch {
      // Unresolvable parameters exclude the object rather than the sketch.
    }
  }
  if (curves.length === 0) {
    return [];
  }

  const subCurves = buildSubCurves(curves, tolerance);

  // Merge endpoints on a tolerance grid into shared nodes.
  const mergeTolerance = Math.max(tolerance, 1e-7);
  const nodes: NodeRecord[] = [];
  const nodeIndex = new Map<string, number>();
  const nodeFor = (point: Vec2Like): number => {
    const key = `${Math.round(point.x / mergeTolerance)},${Math.round(point.y / mergeTolerance)}`;
    const existing = nodeIndex.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const id = nodes.length;
    nodes.push({ x: point.x, y: point.y, outgoing: [] });
    nodeIndex.set(key, id);
    return id;
  };

  const halfEdges: HalfEdge[] = [];
  for (const sub of subCurves) {
    const startNode = nodeFor(sub.start);
    const endNode = nodeFor(sub.end);
    const isClosedCircle =
      sub.curve.kind === 'arc' &&
      startNode === endNode &&
      Math.abs(sub.to - sub.from - TWO_PI) < 1e-9;
    if (startNode === endNode && !isClosedCircle && sub.curve.kind === 'seg') {
      // Degenerate sliver.
      continue;
    }
    const forwardDeparture = departure(sub, true);
    const backwardDeparture = departure(sub, false);
    const forwardId = halfEdges.length;
    const backwardId = forwardId + 1;
    halfEdges.push({
      id: forwardId,
      twin: backwardId,
      origin: startNode,
      target: endNode,
      sub,
      forward: true,
      departAngle: forwardDeparture.angle,
      departCurvature: forwardDeparture.curvature,
      next: -1,
      visited: false
    });
    halfEdges.push({
      id: backwardId,
      twin: forwardId,
      origin: endNode,
      target: startNode,
      sub,
      forward: false,
      departAngle: backwardDeparture.angle,
      departCurvature: backwardDeparture.curvature,
      next: -1,
      visited: false
    });
    nodes[startNode]!.outgoing.push(forwardId);
    nodes[endNode]!.outgoing.push(backwardId);
  }

  // Angular order (CCW) with curvature breaking ties between tangent curves.
  for (const node of nodes) {
    node.outgoing.sort((left, right) => {
      const a = halfEdges[left]!;
      const b = halfEdges[right]!;
      if (Math.abs(a.departAngle - b.departAngle) > 1e-9) {
        return a.departAngle - b.departAngle;
      }
      return a.departCurvature - b.departCurvature;
    });
  }

  // next(h): at h's target, step clockwise from h's reversed direction — the
  // classic face-with-interior-on-the-left traversal.
  for (const halfEdge of halfEdges) {
    const twin = halfEdges[halfEdge.twin]!;
    const outgoing = nodes[halfEdge.target]!.outgoing;
    const position = outgoing.indexOf(twin.id);
    const next =
      outgoing[(position - 1 + outgoing.length) % outgoing.length]!;
    halfEdge.next = next;
  }

  // Trace loops.
  const loops: TracedLoop[] = [];
  for (const seed of halfEdges) {
    if (seed.visited) {
      continue;
    }
    const loopEdges: HalfEdge[] = [];
    let cursor = seed;
    let guard = 0;
    while (!cursor.visited && guard <= halfEdges.length) {
      cursor.visited = true;
      loopEdges.push(cursor);
      cursor = halfEdges[cursor.next]!;
      guard += 1;
    }
    if (loopEdges.length === 0) {
      continue;
    }
    const polyline: Vec2Like[] = [];
    for (const edge of loopEdges) {
      const samples = sampleSub(edge.sub);
      const ordered = edge.forward ? samples : [...samples].reverse();
      for (let i = 0; i < ordered.length - 1; i += 1) {
        polyline.push(ordered[i]!);
      }
    }
    if (polyline.length < 3) {
      continue;
    }
    loops.push({
      halfEdges: loopEdges,
      polyline,
      area: loopExactArea(loopEdges)
    });
  }

  const minimumArea = Math.max(mergeTolerance * mergeTolerance * 16, 1e-10);
  const faces = loops.filter((loop) => loop.area > minimumArea);
  const holeLoops = loops.filter((loop) => loop.area < -minimumArea);

  const loopCurves = (loop: TracedLoop): RegionCurve[] =>
    loop.halfEdges.map((edge) => {
      const sub = edge.sub;
      if (sub.curve.kind === 'seg') {
        return {
          kind: 'line',
          a: edge.forward ? sub.start : sub.end,
          b: edge.forward ? sub.end : sub.start,
          sourceObjectId: sub.curve.sourceObjectId
        } satisfies RegionCurve;
      }
      const startAngle = sub.curve.a0 + (edge.forward ? sub.from : sub.to);
      const endAngle = sub.curve.a0 + (edge.forward ? sub.to : sub.from);
      return {
        kind: 'arc',
        center: { x: sub.curve.cx, y: sub.curve.cy },
        radius: sub.curve.r,
        startAngle,
        endAngle,
        ccw: edge.forward,
        sourceObjectId: sub.curve.sourceObjectId
      } satisfies RegionCurve;
    });

  // Assign each hole loop to the smallest face strictly containing it.
  const holesByFace = new Map<TracedLoop, TracedLoop[]>();
  for (const hole of holeLoops) {
    const probe = hole.polyline[0]!;
    let bestFace: TracedLoop | null = null;
    for (const face of faces) {
      if (distanceToPolyline(probe, face.polyline) <= mergeTolerance * 4) {
        // The candidate shares this boundary; the hole is not inside it.
        continue;
      }
      if (!pointInPolyline(probe, face.polyline)) {
        continue;
      }
      if (!bestFace || face.area < bestFace.area) {
        bestFace = face;
      }
    }
    if (bestFace) {
      const existing = holesByFace.get(bestFace) ?? [];
      existing.push(hole);
      holesByFace.set(bestFace, existing);
    }
  }

  const regions: SketchRegion[] = [];
  for (const face of faces) {
    const holes = holesByFace.get(face) ?? [];
    const outerLoop: RegionLoop = {
      curves: loopCurves(face),
      polyline: face.polyline
    };
    const holeRegionLoops: RegionLoop[] = holes.map((hole) => ({
      curves: loopCurves(hole),
      polyline: hole.polyline
    }));
    const area =
      face.area + holes.reduce((total, hole) => total + hole.area, 0);
    if (area <= minimumArea) {
      continue;
    }
    const samplePoint = samplePointFor(
      face.polyline,
      holes.map((hole) => hole.polyline)
    );
    if (!samplePoint) {
      continue;
    }
    regions.push({
      regionFingerprint: regionFingerprintOf(outerLoop, holeRegionLoops),
      outer: outerLoop,
      holes: holeRegionLoops,
      area,
      samplePoint
    });
  }

  // Deterministic order: largest first, fingerprint as tie-break.
  regions.sort(
    (left, right) =>
      right.area - left.area || left.regionFingerprint - right.regionFingerprint
  );
  return regions;
}

/** Finds the region a point lies in (smallest containing region wins). */
export function regionAtPoint(
  regions: SketchRegion[],
  point: Vec2Like
): SketchRegion | null {
  let best: SketchRegion | null = null;
  for (const region of regions) {
    if (!pointInPolyline(point, region.outer.polyline)) {
      continue;
    }
    if (
      region.holes.some((hole) => pointInPolyline(point, hole.polyline))
    ) {
      continue;
    }
    if (!best || region.area < best.area) {
      best = region;
    }
  }
  return best;
}
