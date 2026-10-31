import { ShapeUtils, Vector2 } from 'three';
import type { DrawingViewFrame } from '@openzcad/shared';

/**
 * D03's fallback section: a body cut by a half-space from its drawing
 * tessellation, for when the kernel refuses the exact cut (the pinned
 * Remus's exact-only booleans refuse many planes through a cylindrical
 * hole). Labelled approximate wherever it is drawn: the cut outline runs
 * through the tessellation's chords, to the display tolerance.
 *
 * Triangles are clipped to the kept side, edge polylines are split where
 * they cross the plane, and the cut face is rebuilt from the segments where
 * the plane crosses triangles: chained into closed loops, nested by
 * containment (outer material, hole, island…) and triangulated. An open
 * chain — a tessellation that does not close across the plane — is left
 * unfilled rather than inventing material.
 */

export interface SectionClip {
  /** The plane's normal; it must be the view's direction of sight. */
  normal: { x: number; y: number; z: number };
  /** Kept: `dot(normal, p) >= depth`. */
  depth: number;
}

export interface ClippableBody {
  vertices: ArrayLike<number>;
  indices: ArrayLike<number>;
  faces?: readonly { triangleStart: number; triangleCount: number }[];
  edges: readonly ArrayLike<number>[];
}

export interface ClippedBody {
  vertices: Float64Array;
  indices: Uint32Array;
  faces: { triangleStart: number; triangleCount: number }[];
  edges: Float64Array[];
  /** The rebuilt cut face, last in `faces`, when one closed. */
  cutFaces: number[];
}

type P3 = [number, number, number];

/** Polylines (xyz) split to the parts on the kept side of the plane. */
export function clipPolyline(
  points: ArrayLike<number>,
  distance: (p: P3) => number
): Float64Array[] {
  const out: Float64Array[] = [];
  let run: number[] = [];
  const at = (i: number): P3 => [
    points[i * 3]!,
    points[i * 3 + 1]!,
    points[i * 3 + 2]!
  ];
  const count = Math.floor(points.length / 3);
  const flush = () => {
    if (run.length >= 6) out.push(Float64Array.from(run));
    run = [];
  };
  for (let i = 0; i < count; i += 1) {
    const p = at(i);
    const d = distance(p);
    if (i > 0) {
      const q = at(i - 1);
      const e = distance(q);
      if (d >= 0 !== e >= 0) {
        const t = e / (e - d);
        const crossing: P3 = [
          q[0] + (p[0] - q[0]) * t,
          q[1] + (p[1] - q[1]) * t,
          q[2] + (p[2] - q[2]) * t
        ];
        if (d >= 0) run.push(...crossing);
        else {
          run.push(...crossing);
          flush();
        }
      }
    }
    if (d >= 0) run.push(...p);
  }
  flush();
  return out;
}

/** Chains undirected segments (by welded endpoint id) into polylines. */
function chainLoops(segments: [number, number][]): {
  ids: number[];
  closed: boolean;
}[] {
  const neighbours = new Map<number, number[]>();
  for (const [a, b] of segments) {
    if (a === b) continue;
    (neighbours.get(a) ?? neighbours.set(a, []).get(a)!).push(b);
    (neighbours.get(b) ?? neighbours.set(b, []).get(b)!).push(a);
  }
  const used = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const out: { ids: number[]; closed: boolean }[] = [];
  // Open chains first, from their ends, then the closed loops left over.
  const starts = [
    ...[...neighbours.keys()].filter((id) => neighbours.get(id)!.length !== 2),
    ...neighbours.keys()
  ];
  for (const start of starts) {
    for (const first of neighbours.get(start)!) {
      if (used.has(key(start, first))) continue;
      const ids = [start];
      let previous = start;
      let current = first;
      used.add(key(start, first));
      for (;;) {
        ids.push(current);
        if (current === start) break;
        const next = neighbours
          .get(current)!
          .find((id) => id !== previous && !used.has(key(current, id)));
        if (next === undefined) break;
        used.add(key(current, next));
        previous = current;
        current = next;
      }
      const closed = ids.length > 3 && ids[ids.length - 1] === start;
      out.push({ ids: closed ? ids.slice(0, -1) : ids, closed });
    }
  }
  return out;
}

function signedArea(loop: readonly Vector2[]): number {
  let area = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function contains(loop: readonly Vector2[], point: Vector2): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i]!;
    const b = loop[j]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

/**
 * `body` cut by `clip` in a view whose direction of sight is the plane's
 * normal, so the cut face lies square to it in the view's own (u, v).
 */
export function clipBodyToSection(
  body: ClippableBody,
  clip: SectionClip,
  frame: DrawingViewFrame
): ClippedBody {
  const n = clip.normal;
  const distance = (p: P3) => n.x * p[0] + n.y * p[1] + n.z * p[2] - clip.depth;
  const vertices: number[] = [];
  const indices: number[] = [];
  const faces: ClippedBody['faces'] = [];
  const corner = (i: number): P3 => {
    const v = body.indices[i]! * 3;
    return [body.vertices[v]!, body.vertices[v + 1]!, body.vertices[v + 2]!];
  };
  let extent = 1;
  for (let i = 0; i < body.vertices.length; i += 1)
    extent = Math.max(extent, Math.abs(body.vertices[i]!));
  const quantum = extent * 1e-7;
  // Plane crossings, welded so neighbouring triangles' segments chain.
  const crossingIds = new Map<string, number>();
  const crossings: Vector2[] = [];
  const crossingId = (p: P3) => {
    const u = frame.x.x * p[0] + frame.x.y * p[1] + frame.x.z * p[2];
    const v = frame.up.x * p[0] + frame.up.y * p[1] + frame.up.z * p[2];
    const k = `${Math.round(u / quantum)},${Math.round(v / quantum)}`;
    let id = crossingIds.get(k);
    if (id === undefined) {
      id = crossings.length;
      crossingIds.set(k, id);
      crossings.push(new Vector2(u, v));
    }
    return id;
  };
  const segments: [number, number][] = [];
  const emit = (polygon: P3[]) => {
    for (let k = 1; k + 1 < polygon.length; k += 1) {
      for (const p of [polygon[0]!, polygon[k]!, polygon[k + 1]!]) {
        indices.push(vertices.length / 3);
        vertices.push(...p);
      }
    }
  };
  const ranges = body.faces ?? [
    { triangleStart: 0, triangleCount: Math.floor(body.indices.length / 3) }
  ];
  for (const face of ranges) {
    const start = indices.length / 3;
    for (
      let t = face.triangleStart;
      t < face.triangleStart + face.triangleCount;
      t += 1
    ) {
      const tri = [corner(t * 3), corner(t * 3 + 1), corner(t * 3 + 2)];
      const d = tri.map(distance);
      if (d.every((value) => value >= 0)) {
        emit(tri);
        continue;
      }
      if (d.every((value) => value < 0)) continue;
      // Sutherland–Hodgman against the plane; the crossing points on the
      // two straddling sides make one segment of the cut outline.
      const kept: P3[] = [];
      const cut: P3[] = [];
      for (let k = 0; k < 3; k += 1) {
        const p = tri[k]!;
        const q = tri[(k + 1) % 3]!;
        const dp = d[k]!;
        const dq = d[(k + 1) % 3]!;
        if (dp >= 0) kept.push(p);
        if (dp >= 0 !== dq >= 0) {
          const s = dp / (dp - dq);
          const x: P3 = [
            p[0] + (q[0] - p[0]) * s,
            p[1] + (q[1] - p[1]) * s,
            p[2] + (q[2] - p[2]) * s
          ];
          kept.push(x);
          cut.push(x);
        }
      }
      if (kept.length >= 3) emit(kept);
      if (cut.length === 2)
        segments.push([crossingId(cut[0]!), crossingId(cut[1]!)]);
    }
    const count = indices.length / 3 - start;
    faces.push({ triangleStart: start, triangleCount: count });
  }
  const edges = body.edges.flatMap((edge) => clipPolyline(edge, distance));
  // The cut face: closed loops nested by containment, even depths material.
  const loops = chainLoops(segments)
    .filter((chain) => chain.closed && chain.ids.length >= 3)
    .map((chain) => chain.ids.map((id) => crossings[id]!));
  const lift = (p: Vector2): P3 => {
    const d = clip.depth;
    return [
      frame.x.x * p.x + frame.up.x * p.y + n.x * d,
      frame.x.y * p.x + frame.up.y * p.y + n.y * d,
      frame.x.z * p.x + frame.up.z * p.y + n.z * d
    ];
  };
  for (const loop of loops)
    edges.push(Float64Array.from([...loop, loop[0]!].flatMap((p) => lift(p))));
  const depthOf = loops.map(
    (loop, i) =>
      loops.filter((other, j) => j !== i && contains(other, loop[0]!)).length
  );
  const capStart = indices.length / 3;
  loops.forEach((outer, i) => {
    if (depthOf[i]! % 2 !== 0) return;
    const holes = loops.filter(
      (hole, j) => depthOf[j] === depthOf[i]! + 1 && contains(outer, hole[0]!)
    );
    const contour = signedArea(outer) < 0 ? [...outer].reverse() : outer;
    const holeContours = holes.map((hole) =>
      signedArea(hole) > 0 ? [...hole].reverse() : hole
    );
    const all = [...contour, ...holeContours.flat()];
    for (const triangle of ShapeUtils.triangulateShape(contour, holeContours)) {
      const [a, b, c] = triangle as [number, number, number];
      emit([lift(all[a]!), lift(all[b]!), lift(all[c]!)]);
    }
  });
  const capCount = indices.length / 3 - capStart;
  const cutFaces: number[] = [];
  if (capCount > 0) {
    cutFaces.push(faces.length);
    faces.push({ triangleStart: capStart, triangleCount: capCount });
  }
  return {
    vertices: Float64Array.from(vertices),
    indices: Uint32Array.from(indices),
    faces,
    edges,
    cutFaces
  };
}
