/**
 * S05: the exact tangent fillet where an arc meets a line or another arc.
 *
 * A corner leg is a line or an arc leaving the shared joint. The fillet is a
 * circle of the asked radius tangent to both legs: its centre lies on an
 * offset of each leg — a parallel line at ±r, or a concentric circle of
 * radius R ± r — so every side combination is intersected, and the one
 * kept is the centre whose two tangent points lie on the legs themselves
 * (not on their extensions, and not past a leg's far end), nearest the
 * joint. The arc returned is the one that rounds the joint, in the same
 * shape the straight fillet returns, so the batch commits it the same way.
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
): { point: Sketch2dPoint; along: number } | null {
  if (leg.kind === 'line') {
    const d = sub(leg.far, leg.at);
    const length = len(d);
    const t = ((center.x - leg.at.x) * d.x + (center.y - leg.at.y) * d.y) / length;
    if (t <= EPS * length || t >= length * (1 - EPS)) return null;
    return {
      point: { x: leg.at.x + (d.x / length) * t, y: leg.at.y + (d.y / length) * t },
      along: t
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
  return { point, along: into * leg.radius };
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
      p: { x: leg.at.x + n.x * radius * side, y: leg.at.y + n.y * radius * side },
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
  const base = { x: a.c.x + (d.x / dist) * along, y: a.c.y + (d.y / dist) * along };
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
  const joint = a.at;
  let best: {
    center: Sketch2dPoint;
    ta: Sketch2dPoint;
    tb: Sketch2dPoint;
    cost: number;
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
        const cost = ta.along + tb.along;
        if (!best || cost < best.cost) {
          best = { center, ta: ta.point, tb: tb.point, cost };
        }
      }
    }
  }
  if (!best) {
    throw new Error(
      'No circle of that radius touches both curves between the corner and their far ends.'
    );
  }
  const { center, ta, tb } = best;
  const angleA = Math.atan2(ta.y - center.y, ta.x - center.x);
  const angleB = Math.atan2(tb.y - center.y, tb.x - center.x);
  // Of the two arcs between the tangencies, the one that rounds the joint
  // is the one whose middle is nearer it.
  const midDistance = (from: number, sweep: number) => {
    const mid = from + sweep / 2;
    return len(
      sub(
        {
          x: center.x + radius * Math.cos(mid),
          y: center.y + radius * Math.sin(mid)
        },
        joint
      )
    );
  };
  const sweepAB = wrap(angleB - angleA);
  const startsAt: 'a' | 'b' =
    midDistance(angleA, sweepAB) <= midDistance(angleB, TAU - sweepAB)
      ? 'a'
      : 'b';
  const startAngle = startsAt === 'a' ? angleA : angleB;
  const sweep = startsAt === 'a' ? sweepAB : TAU - sweepAB;
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
