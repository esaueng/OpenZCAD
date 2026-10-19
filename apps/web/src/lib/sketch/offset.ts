/**
 * Sketch Offset (S05, research audit ZC-014/015): a parallel copy of one
 * curve, or of the chain of curves it belongs to, at a signed distance, with
 * the corner join the user picked.
 *
 * App-side exact geometry, like Trim, Mirror and the patterns in `./modify`.
 * The kernel's planar wire offset reads only the wire's vertex polygon, so it
 * cannot offset an arc, an open chain or a single curve; doing the whole tool
 * here keeps every case on one engine and one set of witnesses.
 *
 * What a pick offsets:
 * - a circle: the concentric circle, radius r + d;
 * - with Chain on, a line or arc: the run of lines and arcs joined end to end
 *   with it, stopping where the run branches; a run that comes back to its
 *   start is a closed loop;
 * - with Chain off, or when nothing joins it: that one line or arc.
 *
 * Which way positive goes: outward for a closed loop, a circle and a lone
 * arc (the radius grows); for a multi-curve open run or a lone line, towards the
 * side of the picked curve the click landed on. A negative distance flips
 * either. A lone line keeps its length: the copy spans exactly the source.
 *
 * Joins, where two neighbouring offsets part at a corner: Miter extends two
 * straight neighbours to meet; Round (and any corner next to an arc, which
 * has no straight extension) inserts an arc about the source corner. Where
 * neighbours overlap instead, both are trimmed back to their crossing.
 *
 * Two witnesses run on every result before it is offered: no point of it may
 * lie nearer the source than the distance asked for (measured exactly, curve
 * to curve, not at samples), and no two of its curves may cross. An inward offset past a loop's collapse point fails one or the
 * other, and is refused with nothing changed.
 */
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  createId,
  toEntityId,
  type EntityId,
  type ParamValue,
  type ProjectDocument,
  type SketchConstraintData,
  type SketchId,
  type SketchNode,
  type SketchObjectData,
  type SketchPointRef
} from '@openzcad/shared';
import type {
  SketchOffsetJoin,
  SketchOffsetOptions
} from '../interaction/machine';
import {
  curveCrossings,
  curveObject,
  evaluateCurve,
  type Curve2,
  type Point2,
  type SketchModifyPlan
} from './modify';

export type { SketchOffsetJoin, SketchOffsetOptions };

/** What the Offset tool starts with: a straight-cornered chain. */
export const DEFAULT_SKETCH_OFFSET_OPTIONS: SketchOffsetOptions = {
  join: 'miter',
  chain: true
};

/**
 * The options in force when a curve was picked, plus which side of it the
 * click landed: 1 is left of the curve's stored direction (start to end; a
 * stored arc runs counter-clockwise, so its left is its inside), -1 right.
 */
export interface SketchOffsetPick extends SketchOffsetOptions {
  side: 1 | -1;
}

type Resolve = (value: ParamValue) => number | undefined;

const TAU = Math.PI * 2;
/** Endpoints this close are one joint, as the rest of the modify tools read it. */
const JOINT = 1e-6;
/** Slack on the distance witness, relative to the offset (floor of one unit). */
const WITNESS = 1e-7;

function sub(a: Point2, b: Point2): Point2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function add(a: Point2, b: Point2, scale = 1): Point2 {
  return { x: a.x + b.x * scale, y: a.y + b.y * scale };
}

function dot(a: Point2, b: Point2): number {
  return a.x * b.x + a.y * b.y;
}

function cross(a: Point2, b: Point2): number {
  return a.x * b.y - a.y * b.x;
}

function length(a: Point2): number {
  return Math.hypot(a.x, a.y);
}

function same(a: Point2, b: Point2, tol = JOINT): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tol;
}

function polar(c: Point2, r: number, angle: number): Point2 {
  return { x: c.x + Math.cos(angle) * r, y: c.y + Math.sin(angle) * r };
}

function angleOf(c: Point2, point: Point2): number {
  return Math.atan2(point.y - c.y, point.x - c.x);
}

/** The angle in (-π, π]. */
function wrapSigned(angle: number): number {
  let wrapped = angle % TAU;
  if (wrapped <= -Math.PI) wrapped += TAU;
  if (wrapped > Math.PI) wrapped -= TAU;
  return wrapped;
}

/** The angle in [0, 2π). */
function wrapPositive(angle: number): number {
  const wrapped = angle % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

function fmt(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

/**
 * One curve as the chain travels it. A line runs `a` to `b`; an arc runs
 * from angle `from` through the signed sweep `delta` (positive is
 * counter-clockwise), so a stored arc walked backwards has a negative sweep.
 */
type Travel =
  | { kind: 'line'; a: Point2; b: Point2 }
  | { kind: 'arc'; c: Point2; r: number; from: number; delta: number };

function travelStart(curve: Travel): Point2 {
  return curve.kind === 'line' ? curve.a : polar(curve.c, curve.r, curve.from);
}

function travelEnd(curve: Travel): Point2 {
  return curve.kind === 'line'
    ? curve.b
    : polar(curve.c, curve.r, curve.from + curve.delta);
}

/** Unit direction of travel at the start (`at` 0) or the end (`at` 1). */
function tangent(curve: Travel, at: 0 | 1): Point2 {
  if (curve.kind === 'line') {
    const d = sub(curve.b, curve.a);
    const l = length(d);
    return { x: d.x / l, y: d.y / l };
  }
  const angle = curve.from + (at === 1 ? curve.delta : 0);
  const sign = Math.sign(curve.delta);
  return { x: -Math.sin(angle) * sign, y: Math.cos(angle) * sign };
}

function pointAt(curve: Travel, t: number): Point2 {
  return curve.kind === 'line'
    ? add(curve.a, sub(curve.b, curve.a), t)
    : polar(curve.c, curve.r, curve.from + curve.delta * t);
}

/** The stored (counter-clockwise) curve a travelled one is. */
function storedCurve(curve: Travel): Curve2 {
  if (curve.kind === 'line') {
    return { kind: 'line', a: curve.a, b: curve.b };
  }
  return curve.delta > 0
    ? {
        kind: 'arc',
        c: curve.c,
        r: curve.r,
        start: wrapPositive(curve.from),
        sweep: curve.delta
      }
    : {
        kind: 'arc',
        c: curve.c,
        r: curve.r,
        start: wrapPositive(curve.from + curve.delta),
        sweep: -curve.delta
      };
}

/** The stored point a travelled curve starts (`at` 0) or ends (`at` 1) on. */
function storedPoint(curve: Travel, at: 0 | 1): 'start' | 'end' {
  const forward = curve.kind === 'line' || curve.delta > 0;
  return (at === 0) === forward ? 'start' : 'end';
}

/** One source curve of the chain, in travel order. */
interface Member {
  objectId: EntityId;
  data: SketchObjectData;
  travel: Travel;
  /** True when the chain walks the stored curve end to start. */
  reversed: boolean;
}

/** What one pick resolves to. */
export type OffsetSource =
  | {
      kind: 'circle';
      objectId: EntityId;
      data: SketchObjectData;
      curve: Extract<Curve2, { kind: 'circle' }>;
    }
  | { kind: 'chain'; members: Member[]; closed: boolean };

/** A line's or arc's stored start and end. */
function curveEnds(curve: Curve2): [Point2, Point2] {
  if (curve.kind === 'line') return [curve.a, curve.b];
  if (curve.kind === 'circle') {
    const point = polar(curve.c, curve.r, 0);
    return [point, point];
  }
  return [
    polar(curve.c, curve.r, curve.start),
    polar(curve.c, curve.r, curve.start + curve.sweep)
  ];
}

function memberOf(
  objectId: EntityId,
  data: SketchObjectData,
  curve: Curve2,
  reversed: boolean
): Member | null {
  if (curve.kind === 'line') {
    if (same(curve.a, curve.b)) return null;
    return {
      objectId,
      data,
      reversed,
      travel: reversed
        ? { kind: 'line', a: curve.b, b: curve.a }
        : { kind: 'line', a: curve.a, b: curve.b }
    };
  }
  if (curve.kind !== 'arc') return null;
  return {
    objectId,
    data,
    reversed,
    travel: reversed
      ? {
          kind: 'arc',
          c: curve.c,
          r: curve.r,
          from: curve.start + curve.sweep,
          delta: -curve.sweep
        }
      : {
          kind: 'arc',
          c: curve.c,
          r: curve.r,
          from: curve.start,
          delta: curve.sweep
        }
  };
}

function sketchObject(
  document: ProjectDocument,
  sketch: SketchNode,
  objectId: string
): SketchObjectData | null {
  if (!sketch.objectIds.includes(objectId as EntityId)) return null;
  const node = document.nodes[objectId as EntityId];
  return node?.kind === 'sketch-object' ? node.data : null;
}

/** A full-turn arc has no ends to join, so it offsets like the circle it is. */
function fullTurn(curve: Curve2): curve is Extract<Curve2, { kind: 'arc' }> {
  return curve.kind === 'arc' && curve.sweep >= TAU - 1e-9;
}

/**
 * Resolve the picked curve to what the offset follows. A run is only ever
 * walked through curves of the seed's own kind — construction or not — so a
 * centre rectangle's construction diagonals, which meet its corners, never
 * read as a branch in its outline.
 */
export function resolveOffsetSource(
  document: ProjectDocument,
  sketch: SketchNode,
  seedId: string,
  chain: boolean,
  resolve: Resolve
): { source: OffsetSource } | { error: string } {
  const seed = sketchObject(document, sketch, seedId);
  if (!seed) {
    return { error: 'That object is not part of this sketch.' };
  }
  if (
    seed.objectKind !== 'line' &&
    seed.objectKind !== 'arc' &&
    seed.objectKind !== 'circle'
  ) {
    return { error: 'Offset works on lines, arcs and circles.' };
  }
  const seedCurve = evaluateCurve(seed, resolve);
  if (!seedCurve) {
    return {
      error: `The selected ${seed.objectKind} has a dimension that does not evaluate.`
    };
  }
  if (seedCurve.kind === 'circle' || fullTurn(seedCurve)) {
    return {
      source: {
        kind: 'circle',
        objectId: seedId as EntityId,
        data: seed,
        curve: { kind: 'circle', c: seedCurve.c, r: seedCurve.r }
      }
    };
  }
  const first = memberOf(seedId as EntityId, seed, seedCurve, false);
  if (!first) {
    return { error: 'That line has no length to offset.' };
  }
  if (!chain) {
    return { source: { kind: 'chain', members: [first], closed: false } };
  }
  const construction = seed.construction === true;
  const candidates: {
    objectId: EntityId;
    data: SketchObjectData;
    curve: Curve2;
  }[] = [];
  for (const objectId of sketch.objectIds) {
    if (objectId === seedId) continue;
    const data = sketchObject(document, sketch, objectId);
    if (
      !data ||
      (data.objectKind !== 'line' && data.objectKind !== 'arc') ||
      (data.construction === true) !== construction
    ) {
      continue;
    }
    const curve = evaluateCurve(data, resolve);
    if (curve && !fullTurn(curve)) {
      candidates.push({ objectId, data, curve });
    }
  }
  const used = new Set<EntityId>([first.objectId]);
  /**
   * The one other curve with an end on `point`, or null at a free end, at a
   * branch, or where the run would loop back into itself.
   */
  const next = (
    point: Point2,
    forward: boolean,
    fromId: EntityId
  ): Member | null => {
    const joined = candidates.flatMap((candidate) => {
      if (candidate.objectId === fromId) return [];
      const [start, end] = curveEnds(candidate.curve);
      const atStart = same(start, point);
      if (!atStart && !same(end, point)) return [];
      // Walking forward the next curve starts here; walking back it ends here.
      return [{ candidate, reversed: forward !== atStart }];
    });
    if (joined.length !== 1) return null;
    const { candidate, reversed } = joined[0]!;
    if (used.has(candidate.objectId)) return null;
    return memberOf(
      candidate.objectId,
      candidate.data,
      candidate.curve,
      reversed
    );
  };
  const members: Member[] = [first];
  let closed = false;
  for (;;) {
    const tail = members[members.length - 1]!;
    const end = travelEnd(tail.travel);
    if (members.length > 1 && same(end, travelStart(first.travel))) {
      closed = true;
      break;
    }
    const step = next(end, true, tail.objectId);
    if (!step) break;
    used.add(step.objectId);
    members.push(step);
  }
  if (!closed) {
    for (;;) {
      const head = members[0]!;
      const step = next(travelStart(head.travel), false, head.objectId);
      if (!step) break;
      used.add(step.objectId);
      members.unshift(step);
    }
  }
  return { source: { kind: 'chain', members, closed } };
}

/** Distance from a point to one travelled curve. */
function distanceTo(point: Point2, curve: Travel): number {
  if (curve.kind === 'line') {
    const d = sub(curve.b, curve.a);
    const t = Math.max(0, Math.min(1, dot(sub(point, curve.a), d) / dot(d, d)));
    return length(sub(point, add(curve.a, d, t)));
  }
  const stored = storedCurve(curve) as Extract<Curve2, { kind: 'arc' }>;
  const along = wrapPositive(angleOf(curve.c, point) - stored.start);
  if (along <= stored.sweep) {
    return Math.abs(length(sub(point, curve.c)) - curve.r);
  }
  return Math.min(
    length(sub(point, travelStart(curve))),
    length(sub(point, travelEnd(curve)))
  );
}

/** Twice the signed area a closed chain encloses; positive is counter-clockwise. */
function signedArea(members: readonly Member[]): number {
  const points: Point2[] = [];
  for (const { travel } of members) {
    const steps = travel.kind === 'line' ? 1 : 32;
    for (let index = 0; index < steps; index += 1) {
      points.push(pointAt(travel, index / steps));
    }
  }
  let area = 0;
  points.forEach((point, index) => {
    area += cross(point, points[(index + 1) % points.length]!);
  });
  return area;
}

/** Where two curves' carriers (infinite line, whole circle) meet. */
function carrierCrossings(first: Travel, second: Travel): Point2[] {
  if (first.kind === 'line' && second.kind === 'line') {
    const d1 = sub(first.b, first.a);
    const d2 = sub(second.b, second.a);
    const denom = cross(d1, d2);
    if (Math.abs(denom) <= length(d1) * length(d2) * 1e-12) return [];
    const t = cross(sub(second.a, first.a), d2) / denom;
    return [add(first.a, d1, t)];
  }
  if (first.kind === 'line' || second.kind === 'line') {
    const [line, round] = (
      first.kind === 'line' ? [first, second] : [second, first]
    ) as [Extract<Travel, { kind: 'line' }>, Extract<Travel, { kind: 'arc' }>];
    const d = sub(line.b, line.a);
    const f = sub(line.a, round.c);
    const qa = dot(d, d);
    const qb = 2 * dot(f, d);
    const qc = dot(f, f) - round.r * round.r;
    let disc = qb * qb - 4 * qa * qc;
    if (disc < 0 && disc >= -1e-12 * (qb * qb + Math.abs(4 * qa * qc))) {
      disc = 0;
    }
    if (disc < 0) return [];
    const root = Math.sqrt(disc);
    return [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)].map((t) =>
      add(line.a, d, t)
    );
  }
  const a = first;
  const b = second;
  const d = length(sub(b.c, a.c));
  if (d < JOINT || d > a.r + b.r || d < Math.abs(a.r - b.r)) return [];
  const along = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(Math.max(a.r * a.r - along * along, 0));
  const u = { x: (b.c.x - a.c.x) / d, y: (b.c.y - a.c.y) / d };
  const mid = add(a.c, u, along);
  return [
    { x: mid.x - u.y * h, y: mid.y + u.x * h },
    { x: mid.x + u.y * h, y: mid.y - u.x * h }
  ];
}

/** Move a travelled curve's start (`at` 0) or end (`at` 1) to a point on it. */
function withEnd(curve: Travel, at: 0 | 1, point: Point2): Travel {
  if (curve.kind === 'line') {
    return at === 0 ? { ...curve, a: point } : { ...curve, b: point };
  }
  const angle = angleOf(curve.c, point);
  if (at === 0) {
    const shift = wrapSigned(angle - curve.from);
    return { ...curve, from: curve.from + shift, delta: curve.delta - shift };
  }
  const shift = wrapSigned(angle - (curve.from + curve.delta));
  return { ...curve, delta: curve.delta + shift };
}

/** One curve of the result. */
interface Piece {
  travel: Travel;
  /** The source curve it is the offset of; absent for a corner join. */
  member?: Member;
  /** A round join's source corner: the member it follows, at that member's end. */
  corner?: Member;
}

/**
 * The offset curves of a chain at `s` to its left, joined. Throws a refusal
 * the user can act on.
 */
function offsetChain(
  members: readonly Member[],
  closed: boolean,
  s: number,
  join: SketchOffsetJoin
): Piece[] {
  const offsets: Piece[] = members.map((member) => {
    const t = member.travel;
    if (t.kind === 'line') {
      const u = tangent(t, 0);
      const n = { x: -u.y, y: u.x };
      return {
        member,
        travel: { kind: 'line', a: add(t.a, n, s), b: add(t.b, n, s) }
      };
    }
    // Left of a counter-clockwise walk is the centre.
    const r = t.r - s * Math.sign(t.delta);
    if (r <= JOINT) {
      throw new Error(
        `That offset shrinks a radius-${fmt(t.r)} arc to nothing. Use a distance under ${fmt(t.r)}.`
      );
    }
    return { member, travel: { ...t, r } };
  });
  const pieces: Piece[] = [];
  const corners = closed ? members.length : members.length - 1;
  // Each join moves the end of one offset and the start of the next, so the
  // offsets are finished in place and the joins slotted between them.
  const joins: (Piece | null)[] = members.map(() => null);
  for (let index = 0; index < corners; index += 1) {
    const nextIndex = (index + 1) % members.length;
    const e = offsets[index]!;
    const f = offsets[nextIndex]!;
    const p = travelEnd(e.travel);
    const q = travelStart(f.travel);
    if (same(p, q)) {
      f.travel = withEnd(f.travel, 0, p);
      continue;
    }
    const source = members[index]!;
    const t1 = tangent(source.travel, 1);
    const t2 = tangent(members[nextIndex]!.travel, 0);
    const turn = cross(t1, t2);
    if (Math.abs(turn) < 1e-12 && dot(t1, t2) < 0) {
      throw new Error(
        'The chain folds back on itself at a corner, so the offset has no side to follow there.'
      );
    }
    const corner = travelEnd(source.travel);
    const gap = turn * s < 0;
    if (gap) {
      if (
        join === 'miter' &&
        e.travel.kind === 'line' &&
        f.travel.kind === 'line'
      ) {
        const [x] = carrierCrossings(e.travel, f.travel);
        if (!x) {
          throw new Error('Two offset lines at a corner never meet.');
        }
        e.travel = withEnd(e.travel, 1, x);
        f.travel = withEnd(f.travel, 0, x);
        continue;
      }
      const from = angleOf(corner, p);
      const delta = wrapSigned(angleOf(corner, q) - from);
      joins[index] = {
        corner: source,
        travel: { kind: 'arc', c: corner, r: Math.abs(s), from, delta }
      };
      continue;
    }
    // The neighbours overlap: trim both back to the crossing nearest the
    // corner.
    const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    const crossing = carrierCrossings(e.travel, f.travel).sort(
      (first, second) => length(sub(first, mid)) - length(sub(second, mid))
    )[0];
    if (!crossing) {
      throw new Error(
        'That offset collapses a corner of the chain. Use a smaller distance.'
      );
    }
    e.travel = withEnd(e.travel, 1, crossing);
    f.travel = withEnd(f.travel, 0, crossing);
  }
  // A trim that ran past a curve's other end has consumed it.
  offsets.forEach((piece) => {
    const original = piece.member!.travel;
    const t = piece.travel;
    if (t.kind === 'line') {
      const o = original as Extract<Travel, { kind: 'line' }>;
      if (dot(sub(t.b, t.a), sub(o.b, o.a)) <= JOINT * length(sub(o.b, o.a))) {
        throw new Error(
          'That offset is wider than a curve of the chain allows. Use a smaller distance.'
        );
      }
    } else if (
      t.delta *
        Math.sign((original as Extract<Travel, { kind: 'arc' }>).delta) <=
        1e-9 ||
      Math.abs(t.delta) > TAU
    ) {
      throw new Error(
        'That offset is wider than a curve of the chain allows. Use a smaller distance.'
      );
    }
  });
  offsets.forEach((piece, index) => {
    pieces.push(piece);
    const joinPiece = joins[index];
    if (joinPiece) pieces.push(joinPiece);
  });
  return pieces;
}

/**
 * Points of `curve` where its distance to `other` can be smallest, besides
 * the ends of both: the foot of a circle's centre on a line, and where the
 * line through two centres meets a round. Kept only where they lie on
 * `curve`; the minimum between two lines or rounds that do not cross is at
 * an end or at one of these.
 */
function interiorCandidates(curve: Travel, other: Travel): Point2[] {
  if (curve.kind === 'line') {
    if (other.kind === 'line') return [];
    const d = sub(curve.b, curve.a);
    const t = dot(sub(other.c, curve.a), d) / dot(d, d);
    return t > 0 && t < 1 ? [add(curve.a, d, t)] : [];
  }
  const stored = storedCurve(curve) as Extract<Curve2, { kind: 'arc' }>;
  const toward = (target: Point2): Point2[] => {
    const offset = sub(target, curve.c);
    const l = length(offset);
    if (l <= JOINT) return [];
    const u = { x: offset.x / l, y: offset.y / l };
    return [add(curve.c, u, curve.r), add(curve.c, u, -curve.r)];
  };
  const targets =
    other.kind === 'line'
      ? (() => {
          // The round's points nearest and farthest from the line run
          // perpendicular to it through the centre.
          const d = sub(other.b, other.a);
          const n = { x: -d.y, y: d.x };
          return toward(add(curve.c, n));
        })()
      : toward(other.c);
  return targets.filter(
    (point) =>
      wrapPositive(angleOf(curve.c, point) - stored.start) <= stored.sweep
  );
}

/**
 * The least distance between two travelled curves, exactly: zero where they
 * cross, else the least over the critical points of each against the other.
 * Sampling instead misses a near pass between samples.
 */
function curveDistance(first: Travel, second: Travel): number {
  if (curveCrossings(storedCurve(first), storedCurve(second)).length > 0) {
    return 0;
  }
  const against = (curve: Travel, other: Travel) =>
    [
      travelStart(curve),
      travelEnd(curve),
      ...interiorCandidates(curve, other)
    ].map((point) => distanceTo(point, other));
  return Math.min(...against(first, second), ...against(second, first));
}

function witness(
  pieces: readonly Piece[],
  members: readonly Member[],
  s: number,
  closed: boolean
) {
  const wanted = Math.abs(s);
  const slack = Math.max(wanted, 1) * WITNESS;
  for (const { travel } of pieces) {
    for (const member of members) {
      if (curveDistance(travel, member.travel) < wanted - slack) {
        throw new Error(
          'That offset collapses through the chain. Use a smaller distance.'
        );
      }
    }
  }
  const curves = pieces.map((piece) => storedCurve(piece.travel));
  for (let i = 0; i < curves.length; i += 1) {
    for (let j = i + 2; j < curves.length; j += 1) {
      if (closed && i === 0 && j === curves.length - 1) continue;
      if (curveCrossings(curves[i]!, curves[j]!).length > 0) {
        throw new Error(
          'That offset runs through itself. Use a smaller distance.'
        );
      }
    }
  }
}

function newEntityId(): EntityId {
  return toEntityId(createId('ent'));
}

function pointRef(
  objectId: EntityId,
  point: SketchPointRef['point']
): SketchPointRef {
  return { objectId, point };
}

/**
 * The offset to the left of the chain's walk that a pick and a signed
 * distance mean: outward for a closed loop or a lone arc, else towards the
 * clicked side of the picked curve.
 */
function leftOffset(
  source: Extract<OffsetSource, { kind: 'chain' }>,
  seedId: string,
  distance: number,
  side: 1 | -1
): number {
  const { members, closed } = source;
  if (closed) {
    const area = signedArea(members);
    if (Math.abs(area) <= JOINT) {
      throw new Error('The selected loop encloses no area.');
    }
    // Outward is right of a counter-clockwise walk.
    return area > 0 ? -distance : distance;
  }
  if (members.length === 1 && members[0]!.travel.kind === 'arc') {
    // A lone arc grows its radius, like a circle.
    return -distance * Math.sign(members[0]!.travel.delta);
  }
  const seed = members.find((member) => member.objectId === seedId);
  return distance * side * (seed?.reversed ? -1 : 1);
}

/** Which side of the picked curve a click landed on (see {@link SketchOffsetPick}). */
export function offsetClickSide(
  document: ProjectDocument,
  sketch: SketchNode,
  objectId: string,
  at: Point2 | null | undefined,
  resolve: Resolve
): 1 | -1 {
  const data = sketchObject(document, sketch, objectId);
  const curve = data ? evaluateCurve(data, resolve) : null;
  if (!curve || !at) return 1;
  if (curve.kind === 'line') {
    return cross(sub(curve.b, curve.a), sub(at, curve.a)) < 0 ? -1 : 1;
  }
  return length(sub(at, curve.c)) > curve.r ? -1 : 1;
}

/** True when the pick offsets an open run, where the click picks the side. */
export function offsetFollowsClick(source: OffsetSource): boolean {
  return (
    source.kind === 'chain' &&
    !source.closed &&
    (source.members.length > 1 || source.members[0]?.travel.kind === 'line')
  );
}

/**
 * Plan one offset: the new curves, joined end to end by coincident
 * relations, as one transaction. Each copy is also linked back to what it
 * was made from — a line parallel to its source, an arc concentric with it,
 * a round join centred on the source corner and tangent to its straight
 * neighbours — as optional relations, which the caller keeps only where a
 * solve says the sketch does not already imply them.
 */
export function planSketchOffset(
  document: ProjectDocument,
  sketch: SketchNode,
  sketchId: SketchId,
  seedId: string,
  distance: number,
  pick: SketchOffsetPick,
  resolve: Resolve
): SketchModifyPlan {
  if (!Number.isFinite(distance) || distance === 0) {
    return {
      status: 'refuse',
      reason: 'An offset distance must be a non-zero number.'
    };
  }
  const resolved = resolveOffsetSource(
    document,
    sketch,
    seedId,
    pick.chain,
    resolve
  );
  if ('error' in resolved) {
    return { status: 'refuse', reason: resolved.error };
  }
  const { source } = resolved;
  const relation = (constraint: SketchConstraintData) =>
    commandFactories.addSketchConstraint(
      { sketchId, constraint },
      'Link the offset'
    );
  if (source.kind === 'circle') {
    const radius = source.curve.r + distance;
    if (radius <= JOINT) {
      return {
        status: 'refuse',
        reason: `A radius-${fmt(source.curve.r)} circle offset by ${fmt(distance)} would have no radius left. Use an offset smaller than ${fmt(source.curve.r)}.`
      };
    }
    const id = newEntityId();
    return {
      status: 'commands',
      label: 'Offset',
      message: `Offset added a circle of radius ${fmt(radius)}.`,
      commands: [
        commandFactories.addSketchObjects(
          {
            sketchId,
            objects: [
              curveObject(
                { kind: 'circle', c: source.curve.c, r: radius },
                source.data
              )
            ],
            ids: { objectNodeIds: [id] }
          },
          'Add offset geometry'
        )
      ],
      optional: [
        relation({ constraintKind: 'concentric', a: id, b: source.objectId })
      ]
    };
  }
  let pieces: Piece[];
  try {
    const s = leftOffset(source, seedId, distance, pick.side);
    pieces = offsetChain(source.members, source.closed, s, pick.join);
    witness(pieces, source.members, s, source.closed);
  } catch (error) {
    return {
      status: 'refuse',
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const ids = pieces.map(() => newEntityId());
  const objects = pieces.map((piece) =>
    curveObject(storedCurve(piece.travel), (piece.member ?? piece.corner)!.data)
  );
  const commands: AnyCommand[] = [
    commandFactories.addSketchObjects(
      { sketchId, objects, ids: { objectNodeIds: ids } },
      'Add offset geometry'
    )
  ];
  const links = source.closed ? pieces.length : pieces.length - 1;
  for (let index = 0; index < links; index += 1) {
    const nextIndex = (index + 1) % pieces.length;
    commands.push(
      commandFactories.addSketchConstraint(
        {
          sketchId,
          constraint: {
            constraintKind: 'coincident',
            a: pointRef(ids[index]!, storedPoint(pieces[index]!.travel, 1)),
            b: pointRef(
              ids[nextIndex]!,
              storedPoint(pieces[nextIndex]!.travel, 0)
            )
          }
        },
        'Join the offset'
      )
    );
  }
  const optional: AnyCommand[] = [];
  pieces.forEach((piece, index) => {
    const id = ids[index]!;
    if (piece.member) {
      optional.push(
        relation(
          piece.travel.kind === 'line'
            ? { constraintKind: 'parallel', a: id, b: piece.member.objectId }
            : { constraintKind: 'concentric', a: id, b: piece.member.objectId }
        )
      );
      return;
    }
    const corner = piece.corner!;
    optional.push(
      relation({
        constraintKind: 'coincident',
        a: pointRef(id, 'center'),
        b: pointRef(corner.objectId, storedPoint(corner.travel, 1))
      })
    );
    const neighbours: [number, 0 | 1][] = [
      [(index - 1 + pieces.length) % pieces.length, 0],
      [(index + 1) % pieces.length, 1]
    ];
    for (const [neighbour, at] of neighbours) {
      if (pieces[neighbour]!.travel.kind === 'line') {
        optional.push(
          relation({
            constraintKind: 'tangent',
            a: ids[neighbour]!,
            b: id,
            at: pointRef(id, storedPoint(piece.travel, at))
          })
        );
      }
    }
  });
  const count = pieces.length;
  return {
    status: 'commands',
    label: 'Offset',
    message: `Offset added ${count} ${count === 1 ? 'curve' : 'curves'} at ${fmt(Math.abs(distance))}.`,
    commands,
    optional
  };
}
