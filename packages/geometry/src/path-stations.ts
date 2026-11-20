/**
 * M02 (schema v112): where a pattern along a sketch path puts its copies.
 * Pure 2D arithmetic on the sketch plane, shared by the exact build and the
 * in-place tool, so the chips stand where the build cuts. Lines and arcs
 * only, so every station is closed form: an arc's length is r·θ, and the
 * point a distance along it is a turn about its centre.
 */
import {
  ownEntry,
  type ParamValue,
  type PatternPath,
  type ProjectDocument
} from '@openzcad/shared';

export interface PathPoint2 {
  x: number;
  y: number;
}

/** A sketch line or arc of a path, resolved to numbers. */
export type PathCurve2 =
  | { kind: 'line'; id: string; start: PathPoint2; end: PathPoint2 }
  | {
      kind: 'arc';
      id: string;
      center: PathPoint2;
      radius: number;
      /** Radians; the arc runs counter-clockwise from here. */
      startAngle: number;
      /** Radians, positive: how far it runs counter-clockwise. */
      sweep: number;
    };

/** One curve of a chained path, as the path runs along it. */
interface ChainPiece {
  curve: PathCurve2;
  /** False when the path runs it from its end to its start. */
  forward: boolean;
  length: number;
}

export interface PathChain {
  pieces: ChainPiece[];
  length: number;
  closed: boolean;
}

/** Where a copy stands on the path, and which way the path runs there. */
export interface PathStation {
  point: PathPoint2;
  /** Radians, counter-clockwise from the sketch x axis. */
  tangent: number;
}

function curveStart(curve: PathCurve2): PathPoint2 {
  if (curve.kind === 'line') return curve.start;
  return {
    x: curve.center.x + curve.radius * Math.cos(curve.startAngle),
    y: curve.center.y + curve.radius * Math.sin(curve.startAngle)
  };
}

function curveEnd(curve: PathCurve2): PathPoint2 {
  if (curve.kind === 'line') return curve.end;
  const angle = curve.startAngle + curve.sweep;
  return {
    x: curve.center.x + curve.radius * Math.cos(angle),
    y: curve.center.y + curve.radius * Math.sin(angle)
  };
}

function curveLength(curve: PathCurve2): number {
  return curve.kind === 'line'
    ? Math.hypot(curve.end.x - curve.start.x, curve.end.y - curve.start.y)
    : curve.radius * curve.sweep;
}

/**
 * The path's curves joined end to end: open, from the free end of the
 * earliest-listed of its two end curves (a lone curve from its own start),
 * or closed, from where its first-listed curve begins; `reversed` starts it
 * at the other end. A string says why the curves are not one chain.
 */
export function chainPathCurves(
  curves: readonly PathCurve2[],
  reversed = false
): PathChain | string {
  if (curves.length === 0) return 'A path needs at least one curve.';
  for (const curve of curves) {
    const length = curveLength(curve);
    if (!Number.isFinite(length) || length <= 1e-9) {
      return 'A curve of the path has no length.';
    }
  }
  // Joints are judged by the curves' own size, never by how far they sit
  // from the sketch's origin: a gap is a gap wherever the path is drawn.
  const scale = Math.max(1, ...curves.map(curveLength));
  const tolerance = 1e-6 * scale;
  const same = (a: PathPoint2, b: PathPoint2) =>
    Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
  const ends = curves.map((curve) => [curveStart(curve), curveEnd(curve)]);
  // How many curve ends meet at each end of each curve.
  const meets = (point: PathPoint2, self: number) =>
    ends.reduce(
      (total, pair, index) =>
        index === self
          ? total
          : total + pair.filter((other) => same(point, other)).length,
      0
    );
  const free: { index: number; atStart: boolean }[] = [];
  for (let index = 0; index < curves.length; index += 1) {
    for (const atStart of [true, false]) {
      const point = ends[index]![atStart ? 0 : 1]!;
      const count = meets(point, index);
      if (count > 1) {
        return 'The path branches: more than two of its curves meet at one point.';
      }
      if (count === 0) free.push({ index, atStart });
    }
  }
  if (curves.length === 1) {
    // A lone curve is open from its own start unless it closes on itself.
    free.length = 0;
    if (!same(ends[0]![0]!, ends[0]![1]!)) {
      free.push({ index: 0, atStart: true }, { index: 0, atStart: false });
    }
  }
  if (free.length !== 0 && free.length !== 2) {
    return 'The curves of the path must join end to end in one chain.';
  }
  const closed = free.length === 0;
  // Walk from the start, taking at each joint the one curve that meets it.
  let current = closed
    ? { index: 0, atStart: true }
    : free.reduce((best, end) => (end.index < best.index ? end : best));
  const pieces: ChainPiece[] = [];
  const used = new Set<number>();
  for (;;) {
    const curve = curves[current.index]!;
    used.add(current.index);
    pieces.push({
      curve,
      forward: current.atStart,
      length: curveLength(curve)
    });
    const tip = ends[current.index]![current.atStart ? 1 : 0]!;
    const next = curves.findIndex(
      (_curve, index) =>
        !used.has(index) &&
        (same(ends[index]![0]!, tip) || same(ends[index]![1]!, tip))
    );
    if (next < 0) break;
    current = { index: next, atStart: same(ends[next]![0]!, tip) };
  }
  if (pieces.length !== curves.length) {
    return 'The curves of the path must join end to end in one chain.';
  }
  if (reversed) {
    pieces.reverse();
    for (const piece of pieces) piece.forward = !piece.forward;
  }
  return {
    pieces,
    length: pieces.reduce((total, piece) => total + piece.length, 0),
    closed
  };
}

function stationOn(piece: ChainPiece, along: number): PathStation {
  const { curve, forward } = piece;
  const t = forward ? along : piece.length - along;
  if (curve.kind === 'line') {
    const dx = curve.end.x - curve.start.x;
    const dy = curve.end.y - curve.start.y;
    const f = t / piece.length;
    const tangent = Math.atan2(dy, dx);
    return {
      point: { x: curve.start.x + dx * f, y: curve.start.y + dy * f },
      tangent: forward ? tangent : tangent + Math.PI
    };
  }
  const angle = curve.startAngle + t / curve.radius;
  return {
    point: {
      x: curve.center.x + curve.radius * Math.cos(angle),
      y: curve.center.y + curve.radius * Math.sin(angle)
    },
    tangent: angle + (forward ? Math.PI / 2 : -Math.PI / 2)
  };
}

/**
 * The station `distance` along the chain from its start. A distance past
 * the end (beyond a rounding slack) is null.
 */
export function pathStationAt(
  chain: PathChain,
  distance: number
): PathStation | null {
  const slack = 1e-9 * Math.max(1, chain.length);
  if (!(distance >= -slack) || distance > chain.length + slack) return null;
  let left = Math.max(0, distance);
  for (const piece of chain.pieces) {
    if (left <= piece.length || piece === chain.pieces.at(-1)) {
      return stationOn(piece, Math.min(left, piece.length));
    }
    left -= piece.length;
  }
  return null;
}

/**
 * The turn from `from` to `to`, in degrees within (−180, 180]: how far a
 * copy turns with the path between the two stations.
 */
export function pathTurnDeg(from: PathStation, to: PathStation): number {
  let turn = ((to.tangent - from.tangent) * 180) / Math.PI;
  turn = ((turn % 360) + 360) % 360;
  return turn > 180 ? turn - 360 : turn;
}

/**
 * Why `count` copies `spacing` apart do not fit on the chain, else null.
 * On a closed path the last may not come back round onto the original.
 */
export function pathPatternFitProblem(
  chain: PathChain,
  count: number,
  spacing: number
): string | null {
  if (!(spacing > 0)) {
    return 'A pattern along a path needs a spacing greater than zero.';
  }
  const reach = spacing * (count - 1);
  const slack = 1e-9 * Math.max(1, chain.length);
  const fits = chain.closed
    ? reach < chain.length - slack
    : reach <= chain.length + slack;
  if (fits) return null;
  return `${count} copies ${formatLength(spacing)} apart need ${formatLength(reach)} of path, and the path is ${formatLength(chain.length)} long${chain.closed ? ' all the way round' : ''}. Lower the count or the spacing.`;
}

function formatLength(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * The lines and arcs a path pattern runs along, read from its sketch with
 * `resolve` (the caller's parameter scope), or why they cannot be.
 */
export function pathPatternCurves(
  document: ProjectDocument,
  path: PatternPath,
  resolve: (value: ParamValue, label: string) => number
): PathCurve2[] | string {
  const sketch = Object.values(document.nodes).find(
    (node) => node?.kind === 'sketch' && node.sketchId === path.sketchId
  );
  if (sketch?.kind !== 'sketch') {
    return 'The sketch this pattern runs along is no longer there.';
  }
  const own = new Set<string>(sketch.objectIds.map(String));
  const curves: PathCurve2[] = [];
  for (const id of path.entityIds) {
    const node = own.has(id) ? ownEntry(document.nodes, id) : undefined;
    const data = node?.kind === 'sketch-object' ? node.data : undefined;
    if (data?.objectKind === 'line') {
      curves.push({
        kind: 'line',
        id,
        start: {
          x: resolve(data.x1, 'path x1'),
          y: resolve(data.y1, 'path y1')
        },
        end: { x: resolve(data.x2, 'path x2'), y: resolve(data.y2, 'path y2') }
      });
      continue;
    }
    if (data?.objectKind === 'arc') {
      const start = (resolve(data.startAngleDeg, 'arc start') * Math.PI) / 180;
      const end = (resolve(data.endAngleDeg, 'arc end') * Math.PI) / 180;
      const turn = Math.PI * 2;
      const sweep = (((end - start) % turn) + turn) % turn;
      // An arc whose angles are equal has no sweep, as the sketch says.
      if (sweep <= 1e-12) {
        return `An arc this pattern runs along has no sweep in ${sketch.name}.`;
      }
      curves.push({
        kind: 'arc',
        id,
        center: {
          x: resolve(data.centerX, 'arc centre x'),
          y: resolve(data.centerY, 'arc centre y')
        },
        radius: resolve(data.radius, 'arc radius'),
        startAngle: start,
        sweep
      });
      continue;
    }
    return `A curve this pattern runs along is no longer a line or arc of ${sketch.name}.`;
  }
  return curves;
}
