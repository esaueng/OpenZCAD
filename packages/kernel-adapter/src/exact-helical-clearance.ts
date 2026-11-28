/**
 * Whether the turns of an in-place helical sweep clear one another, decided
 * from the profile's own curves.
 *
 * A screw about an axis carries the point at radius `r`, height `z` and
 * angle `φ` to `r`, `z + pitch·θ/2π`, `φ + θ`. In the coordinates
 * `(r, h = z − pitch·φ/2π)` every point of the profile keeps its place as it
 * turns, and one full turn moves it by exactly one pitch in `h`: after a
 * turn the profile is back in the half-plane it started in, a pitch further
 * along the axis. So a coil of a full turn or more runs into itself exactly
 * when the profile, drawn in `(r, h)`, meets its own copy moved one pitch
 * along `h`. For a profile in a plane through the axis `φ` is constant and
 * `(r, h)` is simply that plane.
 *
 * Two copies of one region cannot sit one inside the other, so they meet
 * exactly when their boundaries do. The test below is therefore a distance
 * between curves: every boundary curve against every boundary curve moved
 * one pitch. Copies that only touch are refused too, since two turns meeting
 * along a curve are not a solid.
 *
 * It is not the profile's height that a turn must clear. A slanted ellipse
 * 5.5 mm from its lowest point to its highest, but with no line along the
 * axis running more than 1.45 mm inside it, clears itself at a 1.5 mm pitch;
 * and a profile's height read from points sampled on its curves comes up
 * short wherever the highest point falls between them. The kernel's own
 * check (`helicalSweepInPlace` refuses "coils would overlap") reads the
 * height that way, and on a Ø3 mm circle it made 2.9938 mm, so a one-turn
 * coil at a 2.997 mm pitch was built with its end caps overlapping in one
 * plane (issue #2188). The builder asks here before it asks the kernel.
 */
import { geometryTolerance } from '@openzcad/geometry';
import type { RemusKernel } from './remus-runtime';

type Triple = readonly [number, number, number];
/** A point of the profile in `(r, h)`. */
type Point = readonly [number, number];

/** The part of the kernel this module reads, so a test can supply a double. */
export type HelicalClearanceKernel = Pick<
  RemusKernel,
  | 'getFaceEdges'
  | 'getEdgeParamSpan'
  | 'evaluateEdgeCurve'
  | 'getNurbsCurveData'
>;

const TAU = 2 * Math.PI;
/** Pieces each polynomial span of a curve starts in, before any is halved. */
const PIECES_PER_SPAN = 8;
const MAX_PIECES_PER_EDGE = 1024;
const MAX_EDGES = 2048;
/**
 * How much further than its sampled points a piece of curve is taken to
 * stand off its chord. Read at the quarter points and the middle, a circular
 * arc is farthest at the middle and a cubic within 3% of the largest reading.
 */
const DEVIATION_ALLOWANCE = 2;
/** A piece this close to its chord, as a share of the tolerance, is its chord. */
const FLAT_SHARE = 1e-3;
/** No piece is halved below this share of its curve's parameter range. */
const MIN_PARAMETER_SHARE = 2 ** -40;
/**
 * Pairs of pieces compared before the test gives up and refuses. Curves that
 * cross or clear are settled in a few hundred; only curves running alongside
 * one another within a hair of the tolerance over a long stretch come near.
 */
const MAX_COMPARISONS = 2_000_000;
/** The least arc round the axis a profile must leave empty, in radians. */
const MIN_EMPTY_ARC = 1e-3;

function dot(a: Triple, b: Triple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Triple, b: Triple): Triple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

/** An angle difference brought into (−π, π]. */
function wrapped(angle: number): number {
  const turned = angle - TAU * Math.round(angle / TAU);
  return turned <= -Math.PI ? turned + TAU : turned;
}

/** How many polynomial pieces the edge's curve has: lines and arcs, a few. */
function spanCount(kernel: HelicalClearanceKernel, edge: number): number {
  try {
    const data = JSON.parse(kernel.getNurbsCurveData(edge)) as {
      distinctKnots?: unknown;
    };
    return Array.isArray(data.distinctKnots)
      ? Math.max(1, data.distinctKnots.length - 1)
      : 1;
  } catch {
    return 1;
  }
}

/** From the point `p` to the nearest point of the segment `a`–`b`. */
function pointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const along =
    length2 > 0
      ? Math.min(
          1,
          Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)
        )
      : 0;
  return Math.hypot(p[0] - (a[0] + dx * along), p[1] - (a[1] + dy * along));
}

/** Which side of the line `a`→`b` the point `p` lies on. */
function side(a: Point, b: Point, p: Point): number {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

/** Between the segments `a0`–`a1` and `b0`–`b1`: zero where they cross. */
function segmentDistance(a0: Point, a1: Point, b0: Point, b1: Point): number {
  const b0Side = side(a0, a1, b0);
  const b1Side = side(a0, a1, b1);
  const a0Side = side(b0, b1, a0);
  const a1Side = side(b0, b1, a1);
  if (
    ((b0Side > 0 && b1Side < 0) || (b0Side < 0 && b1Side > 0)) &&
    ((a0Side > 0 && a1Side < 0) || (a0Side < 0 && a1Side > 0))
  ) {
    return 0;
  }
  // Segments that do not cross are nearest at an end of one of them; ends
  // that only graze the other segment come out here as a distance near zero.
  return Math.min(
    pointToSegment(a0, b0, b1),
    pointToSegment(a1, b0, b1),
    pointToSegment(b0, a0, a1),
    pointToSegment(b1, a0, a1)
  );
}

/** One boundary curve of the profile, read in `(r, h)`. */
interface Curve {
  at: (t: number) => Point;
  /** The shortest parameter range a piece of it is halved to. */
  minWidth: number;
}

/**
 * A stretch of one curve between two parameters, both ends included, held
 * as its chord and a bound on how far the curve stands off that chord.
 */
interface Piece {
  curve: Curve;
  t0: number;
  t1: number;
  p0: Point;
  /** At the quarter, the middle and the three-quarter parameter. */
  p1: Point;
  p2: Point;
  p3: Point;
  p4: Point;
  deviation: number;
  /** The box round the chord, grown by the deviation. */
  rMin: number;
  rMax: number;
  hMin: number;
  hMax: number;
  halves: [Piece, Piece] | null;
}

function pieceOf(
  curve: Curve,
  t0: number,
  t1: number,
  p0: Point,
  p2: Point,
  p4: Point
): Piece {
  const p1 = curve.at(t0 + (t1 - t0) * 0.25);
  const p3 = curve.at(t0 + (t1 - t0) * 0.75);
  const deviation =
    DEVIATION_ALLOWANCE *
    Math.max(
      pointToSegment(p1, p0, p4),
      pointToSegment(p2, p0, p4),
      pointToSegment(p3, p0, p4)
    );
  if (!Number.isFinite(deviation)) throw new Error('unreadable curve');
  return {
    curve,
    t0,
    t1,
    p0,
    p1,
    p2,
    p3,
    p4,
    deviation,
    rMin: Math.min(p0[0], p4[0]) - deviation,
    rMax: Math.max(p0[0], p4[0]) + deviation,
    hMin: Math.min(p0[1], p4[1]) - deviation,
    hMax: Math.max(p0[1], p4[1]) + deviation,
    halves: null
  };
}

/** The piece's two halves, read once however many pairs ask for them. */
function halvesOf(piece: Piece): [Piece, Piece] {
  if (!piece.halves) {
    const middle = (piece.t0 + piece.t1) / 2;
    piece.halves = [
      pieceOf(piece.curve, piece.t0, middle, piece.p0, piece.p1, piece.p2),
      pieceOf(piece.curve, middle, piece.t1, piece.p2, piece.p3, piece.p4)
    ];
  }
  return piece.halves;
}

/**
 * Whether the curves come within `tolerance` of their own copy moved `shift`
 * along `h`: true where they cross, touch or pass within the tolerance, and
 * also where that could not be settled within the work allowed.
 *
 * Each pair of pieces is bounded from below by the distance between its
 * chords less what the curves stand off them. A pair bounded clear is
 * dropped; a pair of pieces flat enough to be their chords is decided by the
 * chords; any other pair is halved along its more curved piece. Every piece
 * holds both its ends, so no stretch of a curve, and no join between two
 * curves, is left unread.
 */
function meetsOwnCopy(
  pieces: readonly Piece[],
  shift: number,
  tolerance: number
): boolean {
  const flat = tolerance * FLAT_SHARE;
  const settled = (piece: Piece) =>
    piece.deviation <= flat ||
    Math.abs(piece.t1 - piece.t0) <= piece.curve.minWidth;
  const moved = (point: Point): Point => [point[0], point[1] + shift];
  // The copy is `b`, moved up by the shift.
  const apart = (a: Piece, b: Piece) =>
    a.rMin - b.rMax > tolerance ||
    b.rMin - a.rMax > tolerance ||
    a.hMin - (b.hMax + shift) > tolerance ||
    b.hMin + shift - a.hMax > tolerance;

  const stack: [Piece, Piece][] = [];
  const byRadius = [...pieces].sort((a, b) => a.rMin - b.rMin);
  for (let i = 0; i < byRadius.length; i += 1) {
    const a = byRadius[i]!;
    for (let j = i; j < byRadius.length; j += 1) {
      const b = byRadius[j]!;
      if (b.rMin - a.rMax > tolerance) break;
      if (!apart(a, b)) stack.push([a, b]);
      if (i !== j && !apart(b, a)) stack.push([b, a]);
    }
  }

  let comparisons = 0;
  for (let pair = stack.pop(); pair; pair = stack.pop()) {
    const [a, b] = pair;
    comparisons += 1;
    if (comparisons > MAX_COMPARISONS) return true;
    if (apart(a, b)) continue;
    const chords = segmentDistance(a.p0, a.p4, moved(b.p0), moved(b.p4));
    if (chords - a.deviation - b.deviation > tolerance) continue;
    const aSettled = settled(a);
    const bSettled = settled(b);
    if (aSettled && bSettled) return true;
    if (!aSettled && (bSettled || a.deviation >= b.deviation)) {
      const [first, second] = halvesOf(a);
      stack.push([first, b], [second, b]);
    } else {
      const [first, second] = halvesOf(b);
      stack.push([a, first], [a, second]);
    }
  }
  return false;
}

/**
 * The profile face's boundary in `(r, h)` about `axis` (a unit vector)
 * through `origin`, cut into its first pieces, or null when it cannot be
 * read; the kernel's own check then stands alone, as it did before.
 */
function sectionPieces(
  kernel: HelicalClearanceKernel,
  face: number,
  origin: Triple,
  axis: Triple,
  pitch: number
): { pieces: Piece[]; scale: number } | null {
  let edges: number[];
  try {
    edges = [...new Set(Array.from(kernel.getFaceEdges(face)))];
  } catch {
    return null;
  }
  if (edges.length === 0 || edges.length > MAX_EDGES) return null;

  // The frame the angle is read in: `u` toward the first point read and `v`
  // a quarter turn on from it the way the kernel turns (right-handed about
  // the axis).
  let u: Triple | null = null;
  let v: Triple | null = null;
  /** Radius, height along the axis and angle in (−π, π] of a point. */
  const locate = (point: Triple): Triple => {
    const offset: Triple = [
      point[0] - origin[0],
      point[1] - origin[1],
      point[2] - origin[2]
    ];
    const z = dot(offset, axis);
    const radial: Triple = [
      offset[0] - axis[0] * z,
      offset[1] - axis[1] * z,
      offset[2] - axis[2] * z
    ];
    const radius = Math.hypot(radial[0], radial[1], radial[2]);
    if (u === null && radius > 0) {
      u = [radial[0] / radius, radial[1] / radius, radial[2] / radius];
      v = cross(axis, u);
    }
    const angle =
      u !== null && v !== null && radius > 0
        ? Math.atan2(dot(radial, v), dot(radial, u))
        : 0;
    return [radius, z, angle];
  };

  try {
    const read = edges.map((edge) => {
      const [t0, t1] = Array.from(kernel.getEdgeParamSpan(edge));
      if (
        t0 === undefined ||
        t1 === undefined ||
        !Number.isFinite(t0) ||
        !Number.isFinite(t1) ||
        t0 === t1
      ) {
        throw new Error('unreadable edge');
      }
      const count = Math.min(
        MAX_PIECES_PER_EDGE,
        PIECES_PER_SPAN * spanCount(kernel, edge)
      );
      const place = (t: number) => {
        const p = kernel.evaluateEdgeCurve(edge, t);
        return locate([p[0]!, p[1]!, p[2]!]);
      };
      // Each first piece is read at its ends and its middle.
      const parameters = Array.from(
        { length: 2 * count + 1 },
        (_unused, index) => t0 + ((t1 - t0) * index) / (2 * count)
      );
      return { t0, t1, place, parameters, placed: parameters.map(place) };
    });

    // The angle about the axis is read on one branch across the whole
    // profile. A profile beside the axis leaves an arc round it empty, and
    // the cut goes through the middle of that arc. Each curve covers the
    // arc its angle runs over, followed from point to point (neighbouring
    // points on a curve that keeps off the axis are less than half a turn
    // apart). A profile on or round the axis leaves no arc empty and is the
    // kernel's to refuse by name.
    const covered: { from: number; to: number }[] = [];
    let scale = Math.abs(pitch);
    for (const edge of read) {
      let angle = 0;
      let low = Infinity;
      let high = -Infinity;
      edge.placed.forEach(([radius, z, raw], index) => {
        if (!Number.isFinite(z) || !Number.isFinite(radius) || !(radius > 0)) {
          throw new Error('profile on the axis');
        }
        angle = index === 0 ? raw : angle + wrapped(raw - angle);
        low = Math.min(low, angle);
        high = Math.max(high, angle);
        scale = Math.max(scale, radius, Math.abs(z));
      });
      const from = low - TAU * Math.floor((low + Math.PI) / TAU);
      covered.push({ from, to: from + (high - low) });
    }
    // Once round from the lowest start. An arc that runs on past the end of
    // that round covers the beginning of it too, so each is laid down a
    // turn earlier as well before the gaps are read.
    covered.sort((a, b) => a.from - b.from);
    const first = covered[0]!.from;
    let reach = first;
    for (const arc of covered) reach = Math.max(reach, arc.to - TAU);
    let emptyFrom = reach;
    let empty = -Infinity;
    for (const arc of [...covered, { from: first + TAU, to: first + TAU }]) {
      if (arc.from - reach > empty) {
        empty = arc.from - reach;
        emptyFrom = reach;
      }
      reach = Math.max(reach, arc.to);
    }
    if (!(empty > MIN_EMPTY_ARC)) return null;
    const centre = emptyFrom + empty / 2 + Math.PI;

    const pieces: Piece[] = [];
    for (const edge of read) {
      const section = ([radius, z, angle]: Triple): Point => [
        radius,
        z - (pitch * (centre + wrapped(angle - centre))) / TAU
      ];
      const curve: Curve = {
        at: (t) => section(edge.place(t)),
        minWidth: Math.abs(edge.t1 - edge.t0) * MIN_PARAMETER_SHARE
      };
      const points = edge.placed.map(section);
      for (let index = 0; index + 2 < points.length; index += 2) {
        pieces.push(
          pieceOf(
            curve,
            edge.parameters[index]!,
            edge.parameters[index + 2]!,
            points[index]!,
            points[index + 1]!,
            points[index + 2]!
          )
        );
      }
    }
    return { pieces, scale };
  } catch {
    return null;
  }
}

/**
 * Why the turns of this in-place helical sweep would run into one another,
 * or null when they clear or the profile cannot be read.
 *
 * Asked only of a sweep that makes a full turn: until `turns` reaches 1 the
 * profile has not come back round to where it started, and a sweep a hair
 * short of that is not rounded up to it. (A profile out of any plane through
 * the axis is spread round the axis and can meet itself sooner; that case is
 * left to the kernel's own check.) For such a profile at one turn exactly
 * this can refuse a coil whose copies in `(r, h)` meet only at points the
 * sweep stops just short of bringing together; the kernel's rule, which
 * measures the whole height, refuses every such coil as well.
 *
 * `axis` is a unit vector.
 */
export function helicalCoilOverlap(
  kernel: HelicalClearanceKernel,
  face: number,
  origin: Triple,
  axis: Triple,
  pitch: number,
  turns: number
): string | null {
  const climb = Math.abs(pitch);
  if (!(turns >= 1) || !(climb > 0) || !Number.isFinite(climb)) return null;
  const section = sectionPieces(kernel, face, origin, axis, pitch);
  if (!section) return null;
  let meets: boolean;
  try {
    meets = meetsOwnCopy(
      section.pieces,
      climb,
      geometryTolerance(section.scale)
    );
  } catch {
    return null;
  }
  return meets
    ? `helical sweep coils would overlap: one turn carries the profile ${String(climb)} along the axis, onto itself`
    : null;
}
