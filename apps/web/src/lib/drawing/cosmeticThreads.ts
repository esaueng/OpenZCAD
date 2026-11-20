/**
 * M01: cosmetic threads drawn in drawing views. A tapped hole whose thread
 * is cosmetic (schema v67) keeps its tap-drill bore in the model, so no
 * projected edge shows the thread; the sheet draws it the conventional way
 * (ISO 6410-1) from the hole's callout instead:
 *
 * - looking down the bore (an end view), the major diameter as a thin
 *   three-quarter circle about the bore's axis where the bore opens toward
 *   the viewer with nothing in front of it, hidden otherwise;
 * - across the bore (a side view), the major diameter as two lines along the
 *   thread's length and the thread's limit across its end, hidden, since an
 *   internal thread lies inside the material.
 *
 * Everything is read from the model as it stands: which end of a bore opens
 * (a blind bore's floor closes the other), and, for a thread stopped short
 * in a through bore, which end lies on the hole's entry face now. A bore
 * where that cannot be settled draws no thread rather than a guessed one.
 * Views seeing the bore obliquely, section views, and views of another
 * configuration row (whose bodies this model does not hold) draw none.
 */
import {
  projectToView,
  type DrawingView,
  type DrawingViewFrame,
  type FeatureId,
  type Vector3
} from '@openzcad/shared';
import { holeOfBoreFace } from '@openzcad/document-core';
import type { HoleCalloutLookup } from './annotations';
import type { SheetStroke } from './sheetPage';

/** One cosmetic thread, in model units. */
export interface CosmeticThread {
  /** The hole it threads. */
  holeId: FeatureId;
  /** Where the thread starts: the bore's axis at its entry end. */
  entry: Vector3;
  /** Unit direction along the axis, into the bore. */
  axis: Vector3;
  /** How far the thread runs along the axis. */
  length: number;
  /** Half the thread's major diameter. */
  majorRadius: number;
  /** The bore's two ends on its axis. */
  ends: [Vector3, Vector3];
  /** Of `ends`, those that open out of the material. */
  mouths: Vector3[];
}

interface ThreadFace {
  hash: number;
  reference?: { producingFeatureId: FeatureId; lineageName: string };
  geometry?: {
    surfaceType: string;
    area?: number;
    radius?: number;
    normal?: Vector3;
    planeOffset?: number;
    axisStart?: Vector3;
    axisEnd?: Vector3;
  };
}

interface ThreadSourceBody {
  mesh?: { vertices: ArrayLike<number>; indices: ArrayLike<number> };
  topology?: {
    faces: readonly ThreadFace[];
    edges?: readonly {
      adjacentFaceHashes?: readonly number[];
      curve?: { circle?: { center: Vector3; radius: number } };
    }[];
  };
}

const sub = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
});
const dot = (a: Vector3, b: Vector3) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a: Vector3) => Math.sqrt(dot(a, a));
const cross = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});

/** Below this, relative to the bore, two points or sizes are one. */
const SAME = 1e-6;

/**
 * Whether the bore `face` opens at its axis end `at`: false where its rim
 * there bounds a cone (a drill point) or a disc of the bore's own size (a
 * flat floor), null where no rim is found there.
 */
function opensAt(
  body: ThreadSourceBody,
  face: ThreadFace,
  at: Vector3,
  radius: number
): boolean | null {
  const scale = Math.max(1, radius);
  const rims = (body.topology?.edges ?? []).filter((edge) => {
    const circle = edge.curve?.circle;
    return (
      circle !== undefined &&
      edge.adjacentFaceHashes?.includes(face.hash) === true &&
      length(sub(circle.center, at)) <= SAME * scale * 10 &&
      Math.abs(circle.radius - radius) <= SAME * scale
    );
  });
  if (rims.length === 0) return null;
  for (const rim of rims) {
    for (const hash of rim.adjacentFaceHashes ?? []) {
      if (hash === face.hash) continue;
      const other = body.topology?.faces.find((entry) => entry.hash === hash);
      const kind = other?.geometry?.surfaceType.toLowerCase();
      if (kind === 'cone') return false;
      if (
        kind === 'plane' &&
        other?.geometry?.area !== undefined &&
        Math.abs(other.geometry.area - Math.PI * radius * radius) <=
          SAME * Math.max(1, other.geometry.area)
      )
        return false;
    }
  }
  return true;
}

/** The plane of the face a hole was drilled into, found by its name now. */
function entryFacePlane(
  body: ThreadSourceBody,
  entryFace: { producingFeatureId: FeatureId; lineageName: string } | undefined
): { normal: Vector3; offset: number } | null {
  if (!entryFace) return null;
  const faces = (body.topology?.faces ?? []).filter(
    (face) =>
      face.reference?.producingFeatureId === entryFace.producingFeatureId &&
      face.reference.lineageName === entryFace.lineageName
  );
  const geometry = faces.length === 1 ? faces[0]!.geometry : undefined;
  return geometry?.normal && geometry.planeOffset !== undefined
    ? { normal: geometry.normal, offset: geometry.planeOffset }
    : null;
}

/**
 * The cosmetic threads of every bore of `bodies` a hole with a cosmetic
 * thread drilled: directly, at its sketch points, or as an M02 pattern's
 * copy (see `holeOfBoreFace`).
 */
export function cosmeticThreads(
  bodies: readonly (ThreadSourceBody | undefined)[],
  holes: HoleCalloutLookup
): CosmeticThread[] {
  const threads: CosmeticThread[] = [];
  for (const body of bodies) {
    for (const face of body?.topology?.faces ?? []) {
      const geometry = face.geometry;
      if (
        !body ||
        !face.reference ||
        geometry?.surfaceType.toLowerCase() !== 'cylinder' ||
        !geometry.axisStart ||
        !geometry.axisEnd ||
        geometry.radius === undefined
      )
        continue;
      const holeId = holeOfBoreFace(face.reference);
      const callout = holeId ? holes(holeId) : null;
      const thread = callout?.thread;
      if (!holeId || !callout || !thread?.cosmetic) continue;
      const ends: [Vector3, Vector3] = [geometry.axisStart, geometry.axisEnd];
      const bore = length(sub(ends[1], ends[0]));
      if (!(bore > 0)) continue;
      const radius = geometry.radius;
      const open = ends.map((end) => opensAt(body, face, end, radius));
      if (open.some((value) => value === null)) continue;
      const mouths = ends.filter((_end, index) => open[index]);
      let entry: Vector3 | null = null;
      if (mouths.length === 1) {
        // A blind bore: the thread starts where it opens.
        entry = mouths[0]!;
      } else if (mouths.length === 2) {
        if (thread.length === null) {
          // Through and threaded all the way: either end will do.
          entry = ends[0];
        } else {
          // Stopped short in a through bore: from the end on the hole's
          // entry face as it stands now. A copy whose ends lie on another
          // face, or on none, cannot say, so it draws nothing.
          const plane = entryFacePlane(body, callout.entryFace);
          const on = plane
            ? ends.filter(
                (end) =>
                  Math.abs(dot(end, plane.normal) - plane.offset) <=
                  SAME * Math.max(1, Math.abs(plane.offset)) * 10
              )
            : [];
          entry = on.length === 1 ? on[0]! : null;
        }
      }
      if (!entry) continue;
      const exit = entry === ends[0] ? ends[1] : ends[0];
      const into = sub(exit, entry);
      threads.push({
        holeId,
        entry,
        axis: { x: into.x / bore, y: into.y / bore, z: into.z / bore },
        length: Math.min(thread.length ?? bore, bore),
        majorRadius: thread.majorDiameter / 2,
        ends,
        mouths
      });
    }
  }
  return threads;
}

/**
 * Whether anything of `bodies` stands in front of `point`, seen along a
 * view's `direction` of sight: a ray from it toward the viewer against their
 * display meshes (Möller–Trumbore), past the point itself.
 */
export function occludedFromViewer(
  bodies: readonly (ThreadSourceBody | undefined)[],
  point: Vector3,
  direction: Vector3
): boolean {
  const d = { x: -direction.x, y: -direction.y, z: -direction.z };
  for (const body of bodies) {
    const mesh = body?.mesh;
    if (!mesh) continue;
    const v = mesh.vertices;
    const ix = mesh.indices;
    const at = (i: number): Vector3 => ({
      x: v[i * 3]!,
      y: v[i * 3 + 1]!,
      z: v[i * 3 + 2]!
    });
    for (let t = 0; t + 2 < ix.length; t += 3) {
      const a = at(ix[t]!);
      const e1 = sub(at(ix[t + 1]!), a);
      const e2 = sub(at(ix[t + 2]!), a);
      const p = cross(d, e2);
      const det = dot(e1, p);
      if (Math.abs(det) < 1e-12) continue;
      const s = sub(point, a);
      const u = dot(s, p) / det;
      if (u < 0 || u > 1) continue;
      const q = cross(s, e1);
      const w = dot(d, q) / det;
      if (w < 0 || u + w > 1) continue;
      // The bore's own mouth lies at the point; anything in front of it is
      // further along the ray.
      if (dot(e2, q) / det > 1e-6) return true;
    }
  }
  return false;
}

/** Below this the bore is square to the view (its sine or cosine). */
const SQUARE_TOLERANCE = 1e-6;
/** Segments of the three-quarter circle. */
const ARC_SEGMENTS = 48;

/**
 * The strokes `threads` draw in a view with `frame`, mapped to the paper by
 * `toPage`: a three-quarter circle seen down the bore, thin where the bore's
 * nearer end is a mouth and `occluded` finds nothing in front of it, hidden
 * otherwise; hidden lines seen across it; nothing seen obliquely.
 */
export function cosmeticThreadStrokes(
  threads: readonly CosmeticThread[],
  frame: DrawingViewFrame,
  toPage: (u: number, v: number) => [number, number],
  occluded: (point: Vector3) => boolean = () => false
): SheetStroke[] {
  const strokes: SheetStroke[] = [];
  for (const thread of threads) {
    const along = dot(thread.axis, frame.direction);
    const at = projectToView(frame, thread.entry);
    if (Math.abs(Math.abs(along) - 1) <= SQUARE_TOLERANCE) {
      // Down the bore. The gap of the three-quarter circle sits in its upper
      // right quadrant, as ISO 6410-1 draws it.
      const [first, second] = thread.ends;
      const near =
        dot(first, frame.direction) <= dot(second, frame.direction)
          ? first
          : second;
      const seen = thread.mouths.includes(near) && !occluded(near);
      const points: number[] = [];
      for (let i = 0; i <= ARC_SEGMENTS; i += 1) {
        const angle = Math.PI / 2 + (i / ARC_SEGMENTS) * (1.5 * Math.PI);
        points.push(
          ...toPage(
            at.u + thread.majorRadius * Math.cos(angle),
            at.v + thread.majorRadius * Math.sin(angle)
          )
        );
      }
      strokes.push({ kind: seen ? 'thin' : 'hidden', points });
      continue;
    }
    if (Math.abs(along) > SQUARE_TOLERANCE) continue;
    // Across the bore: the major diameter either side of the axis, and the
    // thread's limit across its end.
    const end = projectToView(frame, {
      x: thread.entry.x + thread.axis.x * thread.length,
      y: thread.entry.y + thread.axis.y * thread.length,
      z: thread.entry.z + thread.axis.z * thread.length
    });
    const du = end.u - at.u;
    const dv = end.v - at.v;
    const run = Math.hypot(du, dv);
    if (!(run > 0)) continue;
    const nu = (-dv / run) * thread.majorRadius;
    const nv = (du / run) * thread.majorRadius;
    for (const side of [1, -1]) {
      strokes.push({
        kind: 'hidden',
        points: [
          ...toPage(at.u + side * nu, at.v + side * nv),
          ...toPage(end.u + side * nu, end.v + side * nv)
        ]
      });
    }
    strokes.push({
      kind: 'hidden',
      points: [
        ...toPage(end.u + nu, end.v + nv),
        ...toPage(end.u - nu, end.v - nv)
      ]
    });
  }
  return strokes;
}

/** A view's threads and what can stand in front of them. */
export interface ViewCosmeticThreads {
  threads: CosmeticThread[];
  occluded: (point: Vector3) => boolean;
}

/**
 * The cosmetic threads a view draws: none in a section, or in a view of
 * another configuration row (see the header).
 */
export function viewCosmeticThreads(
  view: Pick<DrawingView, 'bodyIds' | 'section' | 'configurationId'>,
  bodies: Readonly<Record<string, ThreadSourceBody | undefined>>,
  holes: HoleCalloutLookup,
  direction: Vector3
): ViewCosmeticThreads {
  if (view.section || view.configurationId)
    return { threads: [], occluded: () => false };
  const shown = view.bodyIds.map((bodyId) => bodies[bodyId]);
  return {
    threads: cosmeticThreads(shown, holes),
    occluded: (point) => occludedFromViewer(shown, point, direction)
  };
}
