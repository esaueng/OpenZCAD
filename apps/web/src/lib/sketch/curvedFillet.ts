/**
 * S05: the exact tangent fillet where an arc meets a line or another arc.
 *
 * A corner leg is a line or an arc leaving the shared joint. The fillet is a
 * circle of the asked radius tangent to both legs: its centre lies on an
 * offset of each leg — a parallel line at ±r, or a concentric circle of
 * radius R ± r — so every side combination is intersected, and the one
 * kept is the centre whose two tangent points lie on the legs themselves
 * (not on their extensions, and not past a leg's far end), nearest the
 * joint, that continues each leg smoothly (never doubling back into a
 * cusp) and turns less than half a circle. It comes back in the same shape
 * the straight fillet returns, so the batch commits it the same way.
 */
import type {
  Sketch2dPoint,
  SketchFilletGeometry
} from '@openzcad/kernel-adapter/sketch-2d-ops';

export type FilletLeg =
  | {
      kind: 'line';
      /** The joint end. */
      at: Sketch2dPoint;
      far: Sketch2dPoint;
    }
  | {
      kind: 'arc';
      at: Sketch2dPoint;
      center: Sketch2dPoint;
      radius: number;
      /** Counter-clockwise start and sweep of the stored arc, radians. */
      startRad: number;
      sweepRad: number;
      /** Which stored end the joint is. */
      end: 'start' | 'end';
      /** A whole circle standing in as a (nearly) full-turn leg. */
      circle?: true;
    };

const TAU = Math.PI * 2;
const EPS = 1e-9;

const sub = (a: Sketch2dPoint, b: Sketch2dPoint) => ({
  x: a.x - b.x,
  y: a.y - b.y
});
const len = (a: Sketch2dPoint) => Math.hypot(a.x, a.y);
const wrap = (angle: number) => ((angle % TAU) + TAU) % TAU;

/** Where a centre would touch the leg, and how far along it that is. */
function tangentOn(
  leg: FilletLeg,
  center: Sketch2dPoint
): {
  point: Sketch2dPoint;
  along: number;
  /** The leg's direction there, running away from the joint. */
  dir: Sketch2dPoint;
} | null {
  if (leg.kind === 'line') {
    const d = sub(leg.far, leg.at);
    const length = len(d);
    const t =
      ((center.x - leg.at.x) * d.x + (center.y - leg.at.y) * d.y) / length;
    if (t <= EPS * length || t >= length * (1 - EPS)) return null;
    return {
      point: {
        x: leg.at.x + (d.x / length) * t,
        y: leg.at.y + (d.y / length) * t
      },
      along: t,
      dir: { x: d.x / length, y: d.y / length }
    };
  }
  const v = sub(center, leg.center);
  const reach = len(v);
  if (reach <= EPS) return null;
  const point = {
    x: leg.center.x + (v.x / reach) * leg.radius,
    y: leg.center.y + (v.y / reach) * leg.radius
  };
  const angle = Math.atan2(point.y - leg.center.y, point.x - leg.center.x);
  // How far into the arc from its joint end, as a turn.
  const into =
    leg.end === 'start'
      ? wrap(angle - leg.startRad)
      : wrap(leg.startRad + leg.sweepRad - angle);
  if (into <= EPS || into >= leg.sweepRad - EPS) return null;
  // A circle stands in as a (nearly) whole turn; its contact belongs to
  // this corner only within half a turn of the joint, or both corners of a
  // joint could reach the same contact the long way round.
  if (leg.circle && into >= Math.PI) return null;
  const sign = leg.end === 'start' ? 1 : -1;
  return {
    point,
    along: into * leg.radius,
    dir: { x: -Math.sin(angle) * sign, y: Math.cos(angle) * sign }
  };
}

const dot = (a: Sketch2dPoint, b: Sketch2dPoint) => a.x * b.x + a.y * b.y;
/** The fillet circle's counter-clockwise direction at an angle. */
const ccwAt = (angle: number) => ({ x: -Math.sin(angle), y: Math.cos(angle) });

/**
 * Which way the fillet runs, so it continues each leg smoothly: arriving
 * from leg a's tangency it heads back along a (towards the joint), and it
 * leaves into leg b heading along b away from the joint. Null when no way
 * round does both — a fillet that would double back on a leg (a cusp).
 */
function filletTurn(
  center: Sketch2dPoint,
  ta: { point: Sketch2dPoint; dir: Sketch2dPoint },
  tb: { point: Sketch2dPoint; dir: Sketch2dPoint }
): { startsAt: 'a' | 'b'; startAngle: number; sweep: number } | null {
  const angleA = Math.atan2(ta.point.y - center.y, ta.point.x - center.x);
  const angleB = Math.atan2(tb.point.y - center.y, tb.point.x - center.x);
  const back = { x: -ta.dir.x, y: -ta.dir.y };
  // Counter-clockwise from a to b.
  if (dot(ccwAt(angleA), back) > 0.5 && dot(ccwAt(angleB), tb.dir) > 0.5) {
    return { startsAt: 'a', startAngle: angleA, sweep: wrap(angleB - angleA) };
  }
  // Clockwise from a to b: counter-clockwise from b to a.
  if (dot(ccwAt(angleA), back) < -0.5 && dot(ccwAt(angleB), tb.dir) < -0.5) {
    return { startsAt: 'b', startAngle: angleB, sweep: wrap(angleA - angleB) };
  }
  return null;
}

type Offset =
  | { kind: 'line'; p: Sketch2dPoint; d: Sketch2dPoint }
  | { kind: 'circle'; c: Sketch2dPoint; r: number };

function offsets(leg: FilletLeg, radius: number): Offset[] {
  if (leg.kind === 'line') {
    const d = sub(leg.far, leg.at);
    const length = len(d);
    const n = { x: -d.y / length, y: d.x / length };
    return [1, -1].map((side) => ({
      kind: 'line' as const,
      p: {
        x: leg.at.x + n.x * radius * side,
        y: leg.at.y + n.y * radius * side
      },
      d
    }));
  }
  return [leg.radius + radius, leg.radius - radius]
    .filter((r) => r > EPS)
    .map((r) => ({ kind: 'circle' as const, c: leg.center, r }));
}

function intersect(a: Offset, b: Offset): Sketch2dPoint[] {
  if (a.kind === 'line' && b.kind === 'line') {
    const cross = a.d.x * b.d.y - a.d.y * b.d.x;
    if (Math.abs(cross) <= EPS * len(a.d) * len(b.d)) return [];
    const w = sub(b.p, a.p);
    const t = (w.x * b.d.y - w.y * b.d.x) / cross;
    return [{ x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t }];
  }
  if (a.kind === 'circle' && b.kind === 'line') return intersect(b, a);
  if (a.kind === 'line' && b.kind === 'circle') {
    const length = len(a.d);
    const u = { x: a.d.x / length, y: a.d.y / length };
    const w = sub(a.p, b.c);
    const half = w.x * u.x + w.y * u.y;
    const disc = half * half - (w.x * w.x + w.y * w.y - b.r * b.r);
    if (disc < 0) return [];
    const root = Math.sqrt(disc);
    return [-half - root, -half + root].map((t) => ({
      x: a.p.x + u.x * t,
      y: a.p.y + u.y * t
    }));
  }
  if (a.kind !== 'circle' || b.kind !== 'circle') return [];
  const d = sub(b.c, a.c);
  const dist = len(d);
  if (dist <= EPS || dist > a.r + b.r || dist < Math.abs(a.r - b.r)) return [];
  const along = (a.r * a.r - b.r * b.r + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, a.r * a.r - along * along));
  const base = {
    x: a.c.x + (d.x / dist) * along,
    y: a.c.y + (d.y / dist) * along
  };
  return [1, -1].map((side) => ({
    x: base.x - (d.y / dist) * h * side,
    y: base.y + (d.x / dist) * h * side
  }));
}

/**
 * The fillet of `radius` between two legs meeting at their joint, or the
 * reason it does not fit.
 */
export function filletCurvedCorner(
  a: FilletLeg,
  b: FilletLeg,
  radius: number
): SketchFilletGeometry {
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error('A fillet radius must be a positive number.');
  }
  let best: {
    center: Sketch2dPoint;
    ta: Sketch2dPoint;
    tb: Sketch2dPoint;
    cost: number;
    turn: { startsAt: 'a' | 'b'; startAngle: number; sweep: number };
  } | null = null;
  for (const oa of offsets(a, radius)) {
    for (const ob of offsets(b, radius)) {
      for (const center of intersect(oa, ob)) {
        const ta = tangentOn(a, center);
        const tb = tangentOn(b, center);
        if (!ta || !tb) continue;
        // The tangencies must really be at the radius (guards the
        // degenerate inside-circle offsets).
        if (
          Math.abs(len(sub(ta.point, center)) - radius) > 1e-7 * (1 + radius) ||
          Math.abs(len(sub(tb.point, center)) - radius) > 1e-7 * (1 + radius)
        )
          continue;
        const turn = filletTurn(center, ta, tb);
        // A fillet rounds the corner: it turns less than half a circle.
        if (!turn || turn.sweep >= Math.PI) continue;
        const cost = ta.along + tb.along;
        if (!best || cost < best.cost) {
          best = { center, ta: ta.point, tb: tb.point, cost, turn };
        }
      }
    }
  }
  if (!best) {
    throw new Error(
      'No circle of that radius touches both curves between the corner and their far ends.'
    );
  }
  const { center, ta, tb, turn } = best;
  const { startsAt, startAngle, sweep } = turn;
  const startAngleDeg = (startAngle * 180) / Math.PI;
  return {
    a: ta,
    b: tb,
    center,
    radius,
    startAngleDeg,
    endAngleDeg: startAngleDeg + (sweep * 180) / Math.PI,
    startsAt
  };
}
