/**
 * Loop geometry for text profiles: exact signed area and bounds for
 * line/quadratic/cubic boundaries, adaptive flattening, and reversal.
 *
 * Nothing in here recomputes a shared endpoint. Loops are built from point
 * objects that adjacent segments share by reference, so the doubles a
 * downstream `makeWire` sees are bit-identical on both sides of every joint.
 */
import type {
  TextBoundingBox,
  TextLoop,
  TextPoint,
  TextSegment,
  TextWinding
} from './types';

export function point(x: number, y: number): TextPoint {
  return Object.freeze({ x, y });
}

// ---------------------------------------------------------------------------
// Power-basis conversion and exact signed area.
// ---------------------------------------------------------------------------

/**
 * Coefficients `[c0, c1, c2, c3]` of `c0 + c1 t + c2 t² + c3 t³` for one axis
 * of a segment. Degree is padded so every segment shares one code path.
 */
type Cubic4 = [number, number, number, number];

function axisCoefficients(
  segment: TextSegment,
  axis: 'x' | 'y'
): Cubic4 {
  const p0 = segment.a[axis];
  const p3 = segment.b[axis];
  if (segment.kind === 'line') {
    return [p0, p3 - p0, 0, 0];
  }
  if (segment.kind === 'quadratic') {
    const c = segment.control[axis];
    return [p0, 2 * (c - p0), p0 - 2 * c + p3, 0];
  }
  const c1 = segment.control1[axis];
  const c2 = segment.control2[axis];
  return [
    p0,
    3 * (c1 - p0),
    3 * (p0 - 2 * c1 + c2),
    -p0 + 3 * c1 - 3 * c2 + p3
  ];
}

/**
 * `∫₀¹ (x y' − y x') dt` for one segment — the Green's-theorem contribution to
 * twice the enclosed signed area. Both curves are cubic polynomials, so the
 * integrand is degree 4 and integrates exactly.
 */
function segmentSignedAreaTerm(segment: TextSegment): number {
  const x = axisCoefficients(segment, 'x');
  const y = axisCoefficients(segment, 'y');
  // Derivatives, as degree-2 coefficient triples.
  const dx = [x[1], 2 * x[2], 3 * x[3]];
  const dy = [y[1], 2 * y[2], 3 * y[3]];
  // integrand[k] is the coefficient of t^k in (x·y' − y·x'), degree ≤ 5;
  // the t^5 terms cancel identically but are carried for clarity.
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

/** Positive for a counter-clockwise loop. Exact for beziers, not sampled. */
export function loopSignedArea(segments: readonly TextSegment[]): number {
  let twiceArea = 0;
  for (const segment of segments) {
    twiceArea += segmentSignedAreaTerm(segment);
  }
  return twiceArea / 2;
}

// ---------------------------------------------------------------------------
// Bounds.
// ---------------------------------------------------------------------------

function quadraticRoot(p0: number, c: number, p1: number): number[] {
  const denominator = p0 - 2 * c + p1;
  if (denominator === 0) {
    return [];
  }
  const t = (p0 - c) / denominator;
  return t > 0 && t < 1 ? [t] : [];
}

function cubicRoots(
  p0: number,
  c1: number,
  c2: number,
  p3: number
): number[] {
  const a1 = c1 - p0;
  const b1 = c2 - c1;
  const c3 = p3 - c2;
  const a = a1 - 2 * b1 + c3;
  const b = 2 * (b1 - a1);
  const c = a1;
  const inRange = (t: number): boolean => t > 0 && t < 1;
  if (a === 0) {
    if (b === 0) {
      return [];
    }
    const t = -c / b;
    return inRange(t) ? [t] : [];
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return [];
  }
  const root = Math.sqrt(discriminant);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)].filter(inRange);
}

function evaluateAxis(
  segment: TextSegment,
  axis: 'x' | 'y',
  t: number
): number {
  const [c0, c1, c2, c3] = axisCoefficients(segment, axis);
  return c0 + t * (c1 + t * (c2 + t * c3));
}

function extremaParams(segment: TextSegment, axis: 'x' | 'y'): number[] {
  if (segment.kind === 'line') {
    return [];
  }
  if (segment.kind === 'quadratic') {
    return quadraticRoot(segment.a[axis], segment.control[axis], segment.b[axis]);
  }
  return cubicRoots(
    segment.a[axis],
    segment.control1[axis],
    segment.control2[axis],
    segment.b[axis]
  );
}

/** Tight bounds — bezier extrema are solved, not approximated by the hull. */
export function segmentBounds(segment: TextSegment): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Math.min(segment.a.x, segment.b.x);
  let maxX = Math.max(segment.a.x, segment.b.x);
  let minY = Math.min(segment.a.y, segment.b.y);
  let maxY = Math.max(segment.a.y, segment.b.y);
  for (const t of extremaParams(segment, 'x')) {
    const value = evaluateAxis(segment, 'x', t);
    minX = Math.min(minX, value);
    maxX = Math.max(maxX, value);
  }
  for (const t of extremaParams(segment, 'y')) {
    const value = evaluateAxis(segment, 'y', t);
    minY = Math.min(minY, value);
    maxY = Math.max(maxY, value);
  }
  return { minX, minY, maxX, maxY };
}

export function loopBounds(
  segments: readonly TextSegment[]
): TextBoundingBox {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const segment of segments) {
    const bounds = segmentBounds(segment);
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  return { min: point(minX, minY), max: point(maxX, maxY) };
}

export function mergeBounds(
  boxes: readonly TextBoundingBox[]
): TextBoundingBox {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    minX = Math.min(minX, box.min.x);
    minY = Math.min(minY, box.min.y);
    maxX = Math.max(maxX, box.max.x);
    maxY = Math.max(maxY, box.max.y);
  }
  return { min: point(minX, minY), max: point(maxX, maxY) };
}

export function boundsOverlap(
  left: TextBoundingBox,
  right: TextBoundingBox,
  margin = 0
): boolean {
  return (
    left.min.x - margin <= right.max.x &&
    right.min.x - margin <= left.max.x &&
    left.min.y - margin <= right.max.y &&
    right.min.y - margin <= left.max.y
  );
}

// ---------------------------------------------------------------------------
// Flattening.
// ---------------------------------------------------------------------------

const MAX_FLATTEN_DEPTH = 18;

interface MutablePoint {
  x: number;
  y: number;
}

function flattenQuadratic(
  out: MutablePoint[],
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  tolerance: number,
  depth: number
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const cross = Math.abs((cx - x1) * dy - (cy - y1) * dx);
  const chord = dx * dx + dy * dy;
  if (depth >= MAX_FLATTEN_DEPTH || cross * cross <= tolerance * tolerance * chord) {
    out.push({ x: x1, y: y1 });
    return;
  }
  const ax = (x0 + cx) / 2;
  const ay = (y0 + cy) / 2;
  const bx = (cx + x1) / 2;
  const by = (cy + y1) / 2;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  flattenQuadratic(out, x0, y0, ax, ay, mx, my, tolerance, depth + 1);
  flattenQuadratic(out, mx, my, bx, by, x1, y1, tolerance, depth + 1);
}

function flattenCubic(
  out: MutablePoint[],
  x0: number,
  y0: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  x1: number,
  y1: number,
  tolerance: number,
  depth: number
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d1 = Math.abs((c1x - x1) * dy - (c1y - y1) * dx);
  const d2 = Math.abs((c2x - x1) * dy - (c2y - y1) * dx);
  const chord = dx * dx + dy * dy;
  const deviation = (d1 + d2) * (d1 + d2);
  if (depth >= MAX_FLATTEN_DEPTH || deviation <= tolerance * tolerance * chord) {
    out.push({ x: x1, y: y1 });
    return;
  }
  const ax = (x0 + c1x) / 2;
  const ay = (y0 + c1y) / 2;
  const bx = (c1x + c2x) / 2;
  const by = (c1y + c2y) / 2;
  const cx = (c2x + x1) / 2;
  const cy = (c2y + y1) / 2;
  const abx = (ax + bx) / 2;
  const aby = (ay + by) / 2;
  const bcx = (bx + cx) / 2;
  const bcy = (by + cy) / 2;
  const mx = (abx + bcx) / 2;
  const my = (aby + bcy) / 2;
  flattenCubic(out, x0, y0, ax, ay, abx, aby, mx, my, tolerance, depth + 1);
  flattenCubic(out, mx, my, bcx, bcy, cx, cy, x1, y1, tolerance, depth + 1);
}

/**
 * Closed polyline for a loop. The first point is not repeated at the end,
 * matching `RegionLoop.polyline` in `regions.ts`.
 */
export function flattenLoop(
  segments: readonly TextSegment[],
  tolerance: number
): MutablePoint[] {
  const out: MutablePoint[] = [];
  if (segments.length === 0) {
    return out;
  }
  const first = segments[0]!.a;
  out.push({ x: first.x, y: first.y });
  for (const segment of segments) {
    if (segment.kind === 'line') {
      out.push({ x: segment.b.x, y: segment.b.y });
    } else if (segment.kind === 'quadratic') {
      flattenQuadratic(
        out,
        segment.a.x,
        segment.a.y,
        segment.control.x,
        segment.control.y,
        segment.b.x,
        segment.b.y,
        tolerance,
        0
      );
    } else {
      flattenCubic(
        out,
        segment.a.x,
        segment.a.y,
        segment.control1.x,
        segment.control1.y,
        segment.control2.x,
        segment.control2.y,
        segment.b.x,
        segment.b.y,
        tolerance,
        0
      );
    }
  }
  // The loop closes on its own start point; drop the duplicate tail.
  out.pop();
  return out;
}

// ---------------------------------------------------------------------------
// Orientation.
// ---------------------------------------------------------------------------

export function reverseSegment(segment: TextSegment): TextSegment {
  if (segment.kind === 'line') {
    return { kind: 'line', a: segment.b, b: segment.a };
  }
  if (segment.kind === 'quadratic') {
    return {
      kind: 'quadratic',
      a: segment.b,
      control: segment.control,
      b: segment.a
    };
  }
  return {
    kind: 'cubic',
    a: segment.b,
    control1: segment.control2,
    control2: segment.control1,
    b: segment.a
  };
}

/** Reversal reuses the very same point objects, so joints stay bit-identical. */
export function reverseSegments(
  segments: readonly TextSegment[]
): TextSegment[] {
  const out: TextSegment[] = [];
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    out.push(reverseSegment(segments[i]!));
  }
  return out;
}

export function makeLoop(segments: readonly TextSegment[]): TextLoop {
  const signedArea = loopSignedArea(segments);
  const winding: TextWinding = signedArea >= 0 ? 'ccw' : 'cw';
  return Object.freeze({
    segments: Object.freeze([...segments]),
    winding,
    signedArea,
    boundingBox: loopBounds(segments)
  });
}

/** Returns the loop re-wound to `winding`, or the same loop if it matches. */
export function orientLoop(loop: TextLoop, winding: TextWinding): TextLoop {
  if (loop.winding === winding) {
    return loop;
  }
  return Object.freeze({
    segments: Object.freeze(reverseSegments(loop.segments)),
    winding,
    signedArea: -loop.signedArea,
    boundingBox: loop.boundingBox
  });
}
