import type { ParamValue, SketchObjectData } from '@openzcad/shared';
import { geometryTolerance } from './tolerance';

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
    }
  | {
      /**
       * A non-rational bezier. Glyph outlines are quadratic (TrueType) or
       * cubic (PostScript) beziers and are kept exact all the way to the
       * kernel — see `docs/plans/text-feature-plan.md`, design decision 4.
       * Nothing in the half-edge arrangement produces one; they only reach
       * here through the text fast path.
       */
      kind: 'bezier';
      a: Vec2Like;
      b: Vec2Like;
      /** Interior control points: one for a quadratic, two for a cubic. */
      controls: Vec2Like[];
      sourceObjectId: string;
    };

export type BezierRegionCurve = Extract<RegionCurve, { kind: 'bezier' }>;

export interface RegionLoop {
  curves: RegionCurve[];
  /** Sampled closed boundary (first point is not repeated at the end). */
  polyline: Vec2Like[];
}

export interface SketchProfileDiagnostic {
  code:
    | 'construction-excluded'
    | 'duplicate-entity'
    | 'overlapping-segments'
    | 'self-intersection'
    | 'degenerate-entity'
    | 'open-endpoint'
    | 'gap-within-tolerance'
    | 'unresolved-parameter';
  severity: 'info' | 'warning' | 'error';
  message: string;
  sourceEntityIds: string[];
  points: Vec2Like[];
}

export interface SketchProfile {
  /**
   * Stable identity for an unchanged bounded cell. It is derived from the
   * canonical source entities, loop topology, and exact boundary signature;
   * it never depends on array order, tessellation indices, or render objects.
   */
  profileId: string;
  /**
   * FNV-1a hash of the region's quantized boundary geometry, independent of
   * object order and loop traversal direction. Stable across rebuilds while
   * the boundary geometry is unchanged; any curve edit changes it, and
   * consumers fall back to samplePoint + area matching.
   */
  regionFingerprint: number;
  /** Canonical ids of every sketch entity contributing boundary geometry. */
  sourceEntityIds: string[];
  outer: RegionLoop;
  holes: RegionLoop[];
  /** Positive signed area of the bounded cell after subtracting holes. */
  signedArea: number;
  area: number;
  centroid: Vec2Like;
  boundingBox: { min: Vec2Like; max: Vec2Like };
  validity: 'valid';
  diagnostics: SketchProfileDiagnostic[];
  /** A point strictly inside the region (outside all holes). */
  samplePoint: Vec2Like;
}

/** Backward-compatible name retained for kernel and command consumers. */
export type SketchRegion = SketchProfile;

export interface SketchProfileAnalysis {
  profiles: SketchProfile[];
  diagnostics: SketchProfileDiagnostic[];
  /** Model-unit tolerance used for this regeneration. */
  tolerance: number;
  /** Largest resolved local-coordinate span or radius. */
  modelScale: number;
}

export interface SketchRegionObject {
  id: string;
  data: SketchObjectData;
}

/**
 * Supplies profiles for sketch objects the planar arrangement cannot derive.
 *
 * Today that is text, and only text. Glyph outlines need parsed font data,
 * which is fetched asynchronously; this analyzer is synchronous and pure, so
 * the font-backed expansion is injected by the caller rather than reached from
 * in here. Returning `null` (or omitting the source) means the object
 * contributes no profiles — it never falls back to the arrangement, which
 * would be the O(n²) path the text plan exists to avoid.
 */
export type SketchProfileSource = (
  object: SketchRegionObject,
  resolve: (value: ParamValue) => number
) => SketchProfile[] | null;

export interface SketchProfileAnalysisOptions {
  profileSource?: SketchProfileSource;
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
/** Chord deviation a sampled bezier may keep, as a fraction of its extent. */
const BEZIER_SAMPLE_RATIO = 1 / 400;
/** Ceiling on the sampled-polyline cost of a single bezier. */
const MAX_BEZIER_POLYLINE_SEGMENTS = 32;
/** Fingerprints are identity hints, not geometric comparisons. */
const FINGERPRINT_QUANTUM = 1e-6;

function normalizeAngle(angle: number): number {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

function closedPolyCurves(points: Vec2Like[], sourceObjectId: string): Curve[] {
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
    case 'text': {
      // Text never enters the half-edge arrangement. A word is thousands of
      // curves and this pipeline is quadratic in curve count in several
      // places; fonts also already encode which contour is an outer boundary
      // and which is a counter, so the arrangement has nothing to discover.
      // Text profiles arrive fully formed through `profileSource` instead
      // (`docs/plans/text-feature-plan.md`, design decision 4).
      return [];
    }
  }
}

function curveEndpoints(curve: Curve): Vec2Like[] {
  if (curve.kind === 'seg') {
    return [
      { x: curve.ax, y: curve.ay },
      { x: curve.bx, y: curve.by }
    ];
  }
  if (Math.abs(curve.sweep - TWO_PI) <= 1e-9) {
    return [];
  }
  return [arcPoint(curve, 0), arcPoint(curve, curve.sweep)];
}

function modelScaleFor(curves: Curve[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let largestRadius = 0;
  for (const curve of curves) {
    if (curve.kind === 'seg') {
      minX = Math.min(minX, curve.ax, curve.bx);
      minY = Math.min(minY, curve.ay, curve.by);
      maxX = Math.max(maxX, curve.ax, curve.bx);
      maxY = Math.max(maxY, curve.ay, curve.by);
    } else {
      minX = Math.min(minX, curve.cx - curve.r);
      minY = Math.min(minY, curve.cy - curve.r);
      maxX = Math.max(maxX, curve.cx + curve.r);
      maxY = Math.max(maxY, curve.cy + curve.r);
      largestRadius = Math.max(largestRadius, Math.abs(curve.r));
    }
  }
  const span =
    Number.isFinite(minX) && Number.isFinite(minY)
      ? Math.max(maxX - minX, maxY - minY)
      : 0;
  return Math.max(span, largestRadius, 1);
}

function toleranceKey(point: Vec2Like, tolerance: number): string {
  return `${Math.round(point.x / tolerance)},${Math.round(point.y / tolerance)}`;
}

function undirectedSegmentKey(curve: SegCurve, tolerance: number): string {
  const a = toleranceKey({ x: curve.ax, y: curve.ay }, tolerance);
  const b = toleranceKey({ x: curve.bx, y: curve.by }, tolerance);
  return a <= b ? `L:${a}:${b}` : `L:${b}:${a}`;
}

function primitiveCurveKey(curve: Curve, tolerance: number): string {
  if (curve.kind === 'seg') {
    return undirectedSegmentKey(curve, tolerance);
  }
  const start = toleranceKey(arcPoint(curve, 0), tolerance);
  const end = toleranceKey(arcPoint(curve, curve.sweep), tolerance);
  const ends = start <= end ? `${start}:${end}` : `${end}:${start}`;
  const midpoint = toleranceKey(arcPoint(curve, curve.sweep / 2), tolerance);
  return [
    'A',
    toleranceKey({ x: curve.cx, y: curve.cy }, tolerance),
    Math.round(curve.r / tolerance),
    Math.round(curve.sweep / 1e-9),
    ends,
    midpoint
  ].join(':');
}

function collinearOverlap(
  a: SegCurve,
  b: SegCurve,
  tolerance: number
): boolean {
  const adx = a.bx - a.ax;
  const ady = a.by - a.ay;
  const bdx = b.bx - b.ax;
  const bdy = b.by - b.ay;
  const lengthA = Math.hypot(adx, ady);
  const lengthB = Math.hypot(bdx, bdy);
  if (lengthA <= tolerance || lengthB <= tolerance) {
    return false;
  }
  const parallel = Math.abs(adx * bdy - ady * bdx);
  const offset = Math.abs((b.ax - a.ax) * ady - (b.ay - a.ay) * adx);
  if (
    parallel > tolerance * Math.max(lengthA, lengthB) ||
    offset > tolerance * lengthA
  ) {
    return false;
  }
  const useX = Math.abs(adx) >= Math.abs(ady);
  const project = (point: Vec2Like): number => (useX ? point.x : point.y);
  const aMin = Math.min(
    project({ x: a.ax, y: a.ay }),
    project({ x: a.bx, y: a.by })
  );
  const aMax = Math.max(
    project({ x: a.ax, y: a.ay }),
    project({ x: a.bx, y: a.by })
  );
  const bMin = Math.min(
    project({ x: b.ax, y: b.ay }),
    project({ x: b.bx, y: b.by })
  );
  const bMax = Math.max(
    project({ x: b.ax, y: b.ay }),
    project({ x: b.bx, y: b.by })
  );
  return Math.min(aMax, bMax) - Math.max(aMin, bMin) > tolerance;
}

interface ResolvedSketchCurves {
  curves: Curve[];
  diagnostics: SketchProfileDiagnostic[];
  invalidEntityIds: Set<string>;
  tolerance: number;
  modelScale: number;
}

function resolveSketchCurves(
  objects: SketchRegionObject[],
  resolve: (value: ParamValue) => number,
  requestedTolerance?: number
): ResolvedSketchCurves {
  const rawCurves: Curve[] = [];
  const diagnostics: SketchProfileDiagnostic[] = [];
  const invalidEntityIds = new Set<string>();
  for (const object of objects) {
    if (object.data.construction === true) {
      diagnostics.push({
        code: 'construction-excluded',
        severity: 'info',
        message: 'Construction geometry is excluded from profile boundaries.',
        sourceEntityIds: [object.id],
        points: []
      });
      continue;
    }
    try {
      rawCurves.push(...curvesForObject(object, resolve));
    } catch {
      invalidEntityIds.add(object.id);
      diagnostics.push({
        code: 'unresolved-parameter',
        severity: 'error',
        message: 'A sketch entity has an unresolved dimension.',
        sourceEntityIds: [object.id],
        points: []
      });
    }
  }

  const modelScale = modelScaleFor(rawCurves);
  const tolerance = Math.max(
    requestedTolerance ?? geometryTolerance(modelScale),
    Number.EPSILON * modelScale * 16
  );
  const curves: Curve[] = [];
  const byGeometry = new Map<string, Curve>();
  for (const curve of rawCurves) {
    const endpoints = curveEndpoints(curve);
    const degenerate =
      curve.kind === 'seg'
        ? Math.hypot(curve.bx - curve.ax, curve.by - curve.ay) <= tolerance
        : !Number.isFinite(curve.r) ||
          curve.r <= tolerance ||
          curve.sweep <= 1e-9;
    if (degenerate) {
      invalidEntityIds.add(curve.sourceObjectId);
      diagnostics.push({
        code: 'degenerate-entity',
        severity: 'error',
        message: 'A zero-length or zero-radius entity cannot bound a profile.',
        sourceEntityIds: [curve.sourceObjectId],
        points: endpoints
      });
      continue;
    }
    const key = primitiveCurveKey(curve, tolerance);
    const existing = byGeometry.get(key);
    if (existing) {
      invalidEntityIds.add(existing.sourceObjectId);
      invalidEntityIds.add(curve.sourceObjectId);
      diagnostics.push({
        code: 'duplicate-entity',
        severity: 'error',
        message: 'Duplicate sketch entities overlap exactly.',
        sourceEntityIds: [existing.sourceObjectId, curve.sourceObjectId].sort(),
        points: endpoints
      });
      continue;
    }
    byGeometry.set(key, curve);
    curves.push(curve);
  }

  for (let left = 0; left < curves.length; left += 1) {
    const a = curves[left]!;
    if (a.kind !== 'seg') {
      continue;
    }
    for (let right = left + 1; right < curves.length; right += 1) {
      const b = curves[right]!;
      if (
        b.kind !== 'seg' ||
        a.sourceObjectId === b.sourceObjectId ||
        !collinearOverlap(a, b, tolerance)
      ) {
        continue;
      }
      invalidEntityIds.add(a.sourceObjectId);
      invalidEntityIds.add(b.sourceObjectId);
      diagnostics.push({
        code: 'overlapping-segments',
        severity: 'error',
        message: 'Overlapping collinear segments make the profile ambiguous.',
        sourceEntityIds: [a.sourceObjectId, b.sourceObjectId].sort(),
        points: curveEndpoints(a)
      });
    }
  }

  for (let left = 0; left < curves.length; left += 1) {
    const a = curves[left]!;
    if (a.kind !== 'seg') {
      continue;
    }
    for (let right = left + 1; right < curves.length; right += 1) {
      const b = curves[right]!;
      if (b.kind !== 'seg' || a.sourceObjectId !== b.sourceObjectId) {
        continue;
      }
      const hit = segSegIntersections(a, b, tolerance)[0];
      const lengthA = Math.hypot(a.bx - a.ax, a.by - a.ay);
      const lengthB = Math.hypot(b.bx - b.ax, b.by - b.ay);
      const interior =
        hit &&
        hit.ta > tolerance / lengthA &&
        hit.ta < 1 - tolerance / lengthA &&
        hit.tb > tolerance / lengthB &&
        hit.tb < 1 - tolerance / lengthB;
      if (!interior) {
        continue;
      }
      const point = segPoint(a, hit.ta);
      invalidEntityIds.add(a.sourceObjectId);
      diagnostics.push({
        code: 'self-intersection',
        severity: 'error',
        message: 'A self-intersecting sketch entity cannot bound a profile.',
        sourceEntityIds: [a.sourceObjectId],
        points: [point]
      });
    }
  }

  const endpoints = curves.flatMap((curve) =>
    curveEndpoints(curve).map((point) => ({
      point,
      sourceObjectId: curve.sourceObjectId
    }))
  );
  const endpointDegrees = endpoints.map(
    (endpoint, index) =>
      endpoints.filter(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          Math.hypot(
            candidate.point.x - endpoint.point.x,
            candidate.point.y - endpoint.point.y
          ) <= tolerance
      ).length
  );
  endpoints.forEach((endpoint, index) => {
    if ((endpointDegrees[index] ?? 0) > 0) {
      return;
    }
    const near = endpoints.find((candidate, candidateIndex) => {
      if (candidateIndex === index) {
        return false;
      }
      const distance = Math.hypot(
        candidate.point.x - endpoint.point.x,
        candidate.point.y - endpoint.point.y
      );
      return distance > tolerance && distance <= tolerance * 4;
    });
    diagnostics.push({
      code: near ? 'gap-within-tolerance' : 'open-endpoint',
      severity: near ? 'warning' : 'info',
      message: near
        ? 'A small endpoint gap is close to, but outside, the healing tolerance.'
        : 'Open endpoint — close the boundary or use Thin Extrude.',
      sourceEntityIds: near
        ? [endpoint.sourceObjectId, near.sourceObjectId].sort()
        : [endpoint.sourceObjectId],
      points: near ? [endpoint.point, near.point] : [endpoint.point]
    });
  });

  return { curves, diagnostics, invalidEntityIds, tolerance, modelScale };
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
  return [
    { ta: Math.min(Math.max(ta, 0), 1), tb: Math.min(Math.max(tb, 0), 1) }
  ];
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
          {
            x: baseX + (-dy / distance) * perp,
            y: baseY + (dx / distance) * perp
          },
          {
            x: baseX - (-dy / distance) * perp,
            y: baseY - (dx / distance) * perp
          }
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
  const sorted = [
    ...new Set(cuts.map((cut) => Math.min(Math.max(cut, 0), end)))
  ]
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
    const dx = forward
      ? sub.curve.bx - sub.curve.ax
      : sub.curve.ax - sub.curve.bx;
    const dy = forward
      ? sub.curve.by - sub.curve.ay
      : sub.curve.ay - sub.curve.by;
    return { angle: Math.atan2(dy, dx), curvature: 0 };
  }
  const arc = sub.curve;
  if (forward) {
    // Traveling CCW: tangent leads the radius by 90°, curving left.
    const angle = arc.a0 + sub.from + Math.PI / 2;
    return {
      angle: Math.atan2(Math.sin(angle), Math.cos(angle)),
      curvature: 1 / arc.r
    };
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
  const quantized =
    Math.round(value / FINGERPRINT_QUANTUM) * FINGERPRINT_QUANTUM;
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
  if (curve.kind === 'bezier') {
    // Direction-canonical like the line case: the same bezier traced either
    // way must sign identically, or `mergeAdjacentProfiles` would fail to
    // cancel a shared boundary piece.
    const points = [curve.a, ...curve.controls, curve.b];
    const forward = points.flatMap((point) => [
      quantize(point.x),
      quantize(point.y)
    ]);
    const backward = [...points]
      .reverse()
      .flatMap((point) => [quantize(point.x), quantize(point.y)]);
    const canonical =
      forward.join(',') <= backward.join(',') ? forward : backward;
    return `B${curve.controls.length + 1},${canonical.join(',')}`;
  }
  const forwardSweep = normalizeAngle(curve.endAngle - curve.startAngle);
  const span = curve.ccw
    ? forwardSweep || TWO_PI
    : TWO_PI - forwardSweep || TWO_PI;
  const isFullCircle = Math.abs(span - TWO_PI) < 1e-9;
  const base = `${quantize(curve.center.x)},${quantize(curve.center.y)},${quantize(curve.radius)}`;
  if (isFullCircle) {
    return `C${base}`;
  }
  const angles = [
    quantize(normalizeAngle(curve.startAngle)),
    quantize(normalizeAngle(curve.endAngle))
  ].sort((a, b) => a - b);
  const signedSpan = curve.ccw ? span : -span;
  const midpoint = quantize(normalizeAngle(curve.startAngle + signedSpan / 2));
  return `A${base},${angles.join(',')},${quantize(span)},${midpoint}`;
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

function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function regionFingerprintOf(
  outer: RegionLoop,
  holes: RegionLoop[]
): number {
  const holeSignatures = holes.map(loopSignature).sort();
  return fnv1a([loopSignature(outer), ...holeSignatures].join('#'));
}

function profileIdOf(
  outer: RegionLoop,
  holes: RegionLoop[],
  fingerprint: number
): string {
  const topologyOf = (loop: RegionLoop): string =>
    loop.curves
      .map(
        (curve) =>
          `${curve.sourceObjectId}:${curve.kind}:${curveSignature(curve)}`
      )
      .sort()
      .join('|');
  const topology = [
    topologyOf(outer),
    ...holes.map(topologyOf).sort(),
    String(fingerprint)
  ].join('#');
  return `profile_${fnv1a64(topology)}`;
}

/** True when two bounded cells share an exact arrangement boundary piece. */
export function profilesShareBoundary(
  left: SketchProfile,
  right: SketchProfile
): boolean {
  const signatures = new Set(
    [left.outer, ...left.holes].flatMap((loop) =>
      loop.curves.map(curveSignature)
    )
  );
  return [right.outer, ...right.holes].some((loop) =>
    loop.curves.some((curve) => signatures.has(curveSignature(curve)))
  );
}

function regionCurveStart(curve: RegionCurve): Vec2Like {
  // Endpoints are returned by reference, never recomputed: the whole text
  // pipeline depends on adjacent segments sharing one point object so the
  // doubles `makeWire` welds are bit-identical on both sides of a joint.
  if (curve.kind === 'line' || curve.kind === 'bezier') {
    return curve.a;
  }
  return {
    x: curve.center.x + Math.cos(curve.startAngle) * curve.radius,
    y: curve.center.y + Math.sin(curve.startAngle) * curve.radius
  };
}

function regionCurveEnd(curve: RegionCurve): Vec2Like {
  if (curve.kind === 'line' || curve.kind === 'bezier') {
    return curve.b;
  }
  return {
    x: curve.center.x + Math.cos(curve.endAngle) * curve.radius,
    y: curve.center.y + Math.sin(curve.endAngle) * curve.radius
  };
}

function reverseRegionCurve(curve: RegionCurve): RegionCurve {
  if (curve.kind === 'line') {
    return { ...curve, a: curve.b, b: curve.a };
  }
  if (curve.kind === 'bezier') {
    return {
      ...curve,
      a: curve.b,
      b: curve.a,
      controls: [...curve.controls].reverse()
    };
  }
  return {
    ...curve,
    startAngle: curve.endAngle,
    endAngle: curve.startAngle,
    ccw: !curve.ccw
  };
}

function regionCurveSweep(
  curve: Extract<RegionCurve, { kind: 'arc' }>
): number {
  const forward = normalizeAngle(curve.endAngle - curve.startAngle);
  return curve.ccw ? forward || TWO_PI : forward - TWO_PI || -TWO_PI;
}

/**
 * Bernstein evaluation of a non-rational bezier of degree 1–3. Kept explicit
 * rather than de Casteljau so the endpoint values at t = 0 and t = 1 are the
 * control points themselves, bit for bit.
 */
function bezierPointAt(curve: BezierRegionCurve, t: number): Vec2Like {
  const points = [curve.a, ...curve.controls, curve.b];
  const u = 1 - t;
  if (points.length === 3) {
    const [p0, p1, p2] = points as [Vec2Like, Vec2Like, Vec2Like];
    return {
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y
    };
  }
  const [p0, p1, p2, p3] = points as [Vec2Like, Vec2Like, Vec2Like, Vec2Like];
  return {
    x:
      u * u * u * p0.x +
      3 * u * u * t * p1.x +
      3 * u * t * t * p2.x +
      t * t * t * p3.x,
    y:
      u * u * u * p0.y +
      3 * u * u * t * p1.y +
      3 * u * t * t * p2.y +
      t * t * t * p3.y
  };
}

/**
 * Samples needed to keep a bezier's chord deviation under
 * `BEZIER_SAMPLE_RATIO` of its own control-polygon extent. Scale-relative so
 * a 3 mm glyph and a 300 mm one sample alike, and deterministic — the count
 * is a pure function of the control points.
 */
function bezierSampleCount(curve: BezierRegionCurve): number {
  const points = [curve.a, ...curve.controls, curve.b];
  let deviation = 0;
  const dx = curve.b.x - curve.a.x;
  const dy = curve.b.y - curve.a.y;
  const chord = Math.hypot(dx, dy);
  for (const control of curve.controls) {
    deviation = Math.max(
      deviation,
      chord > 0
        ? Math.abs(
            (control.x - curve.a.x) * dy - (control.y - curve.a.y) * dx
          ) / chord
        : Math.hypot(control.x - curve.a.x, control.y - curve.a.y)
    );
  }
  let extent = 0;
  for (const point of points) {
    extent = Math.max(
      extent,
      Math.hypot(point.x - curve.a.x, point.y - curve.a.y)
    );
  }
  if (extent === 0) {
    return 1;
  }
  // Chord error of an n-segment subdivision falls off as 1/n²; solving
  // deviation / n² ≤ ratio · extent gives the count below.
  const target = Math.sqrt(deviation / (BEZIER_SAMPLE_RATIO * extent));
  return Math.min(
    MAX_BEZIER_POLYLINE_SEGMENTS,
    Math.max(2, Math.ceil(Number.isFinite(target) ? target : 2))
  );
}

function sampleRegionCurve(curve: RegionCurve): Vec2Like[] {
  if (curve.kind === 'line') {
    return [curve.a, curve.b];
  }
  if (curve.kind === 'bezier') {
    const steps = bezierSampleCount(curve);
    const samples: Vec2Like[] = [curve.a];
    for (let index = 1; index < steps; index += 1) {
      samples.push(bezierPointAt(curve, index / steps));
    }
    // The shared endpoint object, not a re-evaluation at t = 1.
    samples.push(curve.b);
    return samples;
  }
  const sweep = regionCurveSweep(curve);
  const steps = Math.max(
    2,
    Math.ceil((Math.abs(sweep) / TWO_PI) * CIRCLE_POLYLINE_SEGMENTS)
  );
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = curve.startAngle + (sweep * index) / steps;
    return {
      x: curve.center.x + Math.cos(angle) * curve.radius,
      y: curve.center.y + Math.sin(angle) * curve.radius
    };
  });
}

/**
 * `∫₀¹ (x y' − y x') dt` for one bezier — twice its Green's-theorem area
 * contribution. Both coordinates are cubic polynomials, so the integrand is
 * degree 4 and integrates exactly. This is the same integral
 * `text/loops.ts` computes; it is duplicated rather than imported so
 * `regions.ts` keeps no runtime dependency on the text module's internals.
 */
function bezierSignedAreaTerm(curve: BezierRegionCurve): number {
  const coefficients = (axis: 'x' | 'y'): [number, number, number, number] => {
    const p0 = curve.a[axis];
    const p3 = curve.b[axis];
    if (curve.controls.length === 1) {
      const c = curve.controls[0]![axis];
      return [p0, 2 * (c - p0), p0 - 2 * c + p3, 0];
    }
    const c1 = curve.controls[0]![axis];
    const c2 = curve.controls[1]![axis];
    return [
      p0,
      3 * (c1 - p0),
      3 * (p0 - 2 * c1 + c2),
      -p0 + 3 * c1 - 3 * c2 + p3
    ];
  };
  const x = coefficients('x');
  const y = coefficients('y');
  const dx = [x[1], 2 * x[2], 3 * x[3]];
  const dy = [y[1], 2 * y[2], 3 * y[3]];
  const integrand = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      integrand[i + j] = integrand[i + j]! + (x[i]! * dy[j]! - y[i]! * dx[j]!);
    }
  }
  let total = 0;
  for (let k = 0; k < integrand.length; k += 1) {
    total += integrand[k]! / (k + 1);
  }
  return total;
}

function exactAreaForRegionCurves(curves: RegionCurve[]): number {
  let area = 0;
  for (const curve of curves) {
    if (curve.kind === 'bezier') {
      area += bezierSignedAreaTerm(curve) / 2;
      continue;
    }
    const start = regionCurveStart(curve);
    const end = regionCurveEnd(curve);
    area += (start.x * end.y - end.x * start.y) / 2;
    if (curve.kind === 'arc') {
      const sweep = regionCurveSweep(curve);
      area += ((curve.radius * curve.radius) / 2) * (sweep - Math.sin(sweep));
    }
  }
  return area;
}

/**
 * Exact signed area of a closed loop — positive counter-clockwise. Arcs
 * contribute their circular segment and beziers their Green's-theorem
 * integral, so nothing here depends on how finely the loop samples.
 */
export function regionLoopSignedArea(loop: RegionLoop): number {
  return exactAreaForRegionCurves(loop.curves);
}

function loopFromCurves(curves: RegionCurve[]): RegionLoop {
  const polyline: Vec2Like[] = [];
  for (const curve of curves) {
    const samples = sampleRegionCurve(curve);
    polyline.push(...samples.slice(0, -1));
  }
  return { curves, polyline };
}

/**
 * Exact union of face-adjacent arrangement cells.
 *
 * Selected cells do not overlap: shared arrangement edges appear once in each
 * direction. Canceling those pairs leaves the union's outer/hole wires, which
 * avoids a solid boolean and guarantees no internal extrusion wall.
 */
export function mergeAdjacentProfiles(
  profiles: SketchProfile[]
): SketchProfile {
  if (profiles.length === 0) {
    throw new Error('Cannot merge an empty profile selection.');
  }
  if (profiles.length === 1) {
    return profiles[0]!;
  }
  const buckets = new Map<string, RegionCurve[]>();
  for (const profile of profiles) {
    for (const loop of [profile.outer, ...profile.holes]) {
      for (const curve of loop.curves) {
        const key = curveSignature(curve);
        buckets.set(key, [...(buckets.get(key) ?? []), curve]);
      }
    }
  }
  const boundary = [...buckets.values()].flatMap((curves) =>
    curves.length % 2 === 0 ? [] : [curves[0]!]
  );
  if (boundary.length === 0) {
    throw new Error('Selected profile cells have no exterior boundary.');
  }

  const scale = Math.max(
    ...profiles.flatMap((profile) => [
      Math.abs(profile.boundingBox.min.x),
      Math.abs(profile.boundingBox.min.y),
      Math.abs(profile.boundingBox.max.x),
      Math.abs(profile.boundingBox.max.y)
    ]),
    1
  );
  const tolerance = geometryTolerance(scale);
  const samePoint = (left: Vec2Like, right: Vec2Like): boolean =>
    Math.hypot(left.x - right.x, left.y - right.y) <= tolerance;
  const remaining = [...boundary];
  const loops: RegionLoop[] = [];
  while (remaining.length > 0) {
    const first = remaining.shift()!;
    const ordered = [first];
    const start = regionCurveStart(first);
    let end = regionCurveEnd(first);
    let guard = 0;
    while (!samePoint(end, start) && guard <= boundary.length) {
      const nextIndex = remaining.findIndex(
        (curve) =>
          samePoint(regionCurveStart(curve), end) ||
          samePoint(regionCurveEnd(curve), end)
      );
      if (nextIndex < 0) {
        throw new Error('Selected profiles do not form a closed merged wire.');
      }
      let next = remaining.splice(nextIndex, 1)[0]!;
      if (!samePoint(regionCurveStart(next), end)) {
        next = reverseRegionCurve(next);
      }
      ordered.push(next);
      end = regionCurveEnd(next);
      guard += 1;
    }
    if (!samePoint(end, start)) {
      throw new Error('Selected profiles do not form a closed merged wire.');
    }
    loops.push(loopFromCurves(ordered));
  }

  const classified = loops
    .map((loop) => ({ loop, area: exactAreaForRegionCurves(loop.curves) }))
    .sort((left, right) => right.area - left.area);
  const outerValue = classified.find((candidate) => candidate.area > 0);
  if (!outerValue) {
    throw new Error('Selected profiles have no positive outer boundary.');
  }
  const holes = classified
    .filter((candidate) => candidate !== outerValue && candidate.area < 0)
    .map((candidate) => candidate.loop);
  const area = profiles.reduce((total, profile) => total + profile.area, 0);
  const centroid = profiles.reduce(
    (total, profile) => ({
      x: total.x + profile.centroid.x * profile.area,
      y: total.y + profile.centroid.y * profile.area
    }),
    { x: 0, y: 0 }
  );
  centroid.x /= area;
  centroid.y /= area;
  const sourceEntityIds = [
    ...new Set(profiles.flatMap((profile) => profile.sourceEntityIds))
  ].sort();
  const regionFingerprint = regionFingerprintOf(outerValue.loop, holes);
  return {
    profileId: profileIdOf(outerValue.loop, holes, regionFingerprint),
    regionFingerprint,
    sourceEntityIds,
    outer: outerValue.loop,
    holes,
    signedArea: area,
    area,
    centroid,
    boundingBox: profileBounds(outerValue.loop),
    validity: 'valid',
    diagnostics: [],
    samplePoint: profiles[0]!.samplePoint
  };
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
      for (
        let i = 0, j = polyline.length - 1;
        i < polyline.length;
        j = i, i += 1
      ) {
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

function polylineAreaAndCentroid(polyline: Vec2Like[]): {
  area: number;
  centroid: Vec2Like;
} {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < polyline.length; index += 1) {
    const current = polyline[index]!;
    const next = polyline[(index + 1) % polyline.length]!;
    const cross = current.x * next.y - next.x * current.y;
    twiceArea += cross;
    x += (current.x + next.x) * cross;
    y += (current.y + next.y) * cross;
  }
  const area = twiceArea / 2;
  if (Math.abs(twiceArea) <= Number.EPSILON) {
    return { area: 0, centroid: polyline[0] ?? { x: 0, y: 0 } };
  }
  return {
    area,
    centroid: { x: x / (3 * twiceArea), y: y / (3 * twiceArea) }
  };
}

function profileCentroid(outer: RegionLoop, holes: RegionLoop[]): Vec2Like {
  const outerValue = polylineAreaAndCentroid(outer.polyline);
  let weight = Math.abs(outerValue.area);
  let x = outerValue.centroid.x * weight;
  let y = outerValue.centroid.y * weight;
  for (const hole of holes) {
    const value = polylineAreaAndCentroid(hole.polyline);
    const holeWeight = Math.abs(value.area);
    weight -= holeWeight;
    x -= value.centroid.x * holeWeight;
    y -= value.centroid.y * holeWeight;
  }
  return weight > Number.EPSILON
    ? { x: x / weight, y: y / weight }
    : outerValue.centroid;
}

function profileBounds(outer: RegionLoop): {
  min: Vec2Like;
  max: Vec2Like;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of outer.polyline) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    min: { x: minX, y: minY },
    max: { x: maxX, y: maxY }
  };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

function extractSketchProfiles(
  curves: Curve[],
  tolerance: number,
  invalidEntityIds: Set<string>
): SketchProfile[] {
  if (curves.length === 0) {
    return [];
  }

  const subCurves = buildSubCurves(curves, tolerance);

  // Merge endpoints on a tolerance grid into shared nodes.
  const mergeTolerance = Math.max(tolerance, 1e-7);
  const nodes: NodeRecord[] = [];
  const nodeIndex = new Map<string, number[]>();
  const nodeFor = (point: Vec2Like): number => {
    const gridX = Math.round(point.x / mergeTolerance);
    const gridY = Math.round(point.y / mergeTolerance);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const candidates = nodeIndex.get(`${gridX + dx},${gridY + dy}`) ?? [];
        const existing = candidates.find((candidate) => {
          const node = nodes[candidate]!;
          return (
            Math.hypot(node.x - point.x, node.y - point.y) <= mergeTolerance
          );
        });
        if (existing !== undefined) {
          return existing;
        }
      }
    }
    const id = nodes.length;
    nodes.push({ x: point.x, y: point.y, outgoing: [] });
    const key = `${gridX},${gridY}`;
    nodeIndex.set(key, [...(nodeIndex.get(key) ?? []), id]);
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
    const next = outgoing[(position - 1 + outgoing.length) % outgoing.length]!;
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

  const regions: SketchProfile[] = [];
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
    const sourceEntityIds = [
      ...new Set(
        [outerLoop, ...holeRegionLoops].flatMap((loop) =>
          loop.curves.map((curve) => curve.sourceObjectId)
        )
      )
    ].sort();
    if (sourceEntityIds.some((entityId) => invalidEntityIds.has(entityId))) {
      continue;
    }
    const regionFingerprint = regionFingerprintOf(outerLoop, holeRegionLoops);
    regions.push({
      profileId: profileIdOf(outerLoop, holeRegionLoops, regionFingerprint),
      regionFingerprint,
      sourceEntityIds,
      outer: outerLoop,
      holes: holeRegionLoops,
      signedArea: area,
      area,
      centroid: profileCentroid(outerLoop, holeRegionLoops),
      boundingBox: profileBounds(outerLoop),
      validity: 'valid',
      diagnostics: [],
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

/**
 * Profiles contributed by objects that bypass the arrangement, in sketch
 * order. They are appended rather than merged into the area sort so a text
 * object's regions stay in reading order across rebuilds.
 */
function sourcedProfiles(
  objects: SketchRegionObject[],
  resolve: (value: ParamValue) => number,
  profileSource: SketchProfileSource
): SketchProfile[] {
  const profiles: SketchProfile[] = [];
  for (const object of objects) {
    if (object.data.construction === true) {
      continue;
    }
    profiles.push(...(profileSource(object, resolve) ?? []));
  }
  return profiles;
}

export function computeSketchProfileAnalysis(
  objects: SketchRegionObject[],
  resolve: (value: ParamValue) => number,
  requestedTolerance?: number,
  options?: SketchProfileAnalysisOptions
): SketchProfileAnalysis {
  const resolved = resolveSketchCurves(objects, resolve, requestedTolerance);
  const profiles = extractSketchProfiles(
    resolved.curves,
    resolved.tolerance,
    resolved.invalidEntityIds
  );
  if (options?.profileSource) {
    profiles.push(...sourcedProfiles(objects, resolve, options.profileSource));
  }
  return {
    profiles,
    diagnostics: resolved.diagnostics,
    tolerance: resolved.tolerance,
    modelScale: resolved.modelScale
  };
}

export function computeSketchRegions(
  objects: SketchRegionObject[],
  resolve: (value: ParamValue) => number,
  tolerance?: number,
  options?: SketchProfileAnalysisOptions
): SketchRegion[] {
  return computeSketchProfileAnalysis(objects, resolve, tolerance, options)
    .profiles;
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
    if (region.holes.some((hole) => pointInPolyline(point, hole.polyline))) {
      continue;
    }
    if (!best || region.area < best.area) {
      best = region;
    }
  }
  return best;
}

export function profileContainsPoint(
  profile: SketchProfile,
  point: Vec2Like
): boolean {
  return (
    point.x >= profile.boundingBox.min.x &&
    point.x <= profile.boundingBox.max.x &&
    point.y >= profile.boundingBox.min.y &&
    point.y <= profile.boundingBox.max.y &&
    pointInPolyline(point, profile.outer.polyline) &&
    !profile.holes.some((hole) => pointInPolyline(point, hole.polyline))
  );
}
