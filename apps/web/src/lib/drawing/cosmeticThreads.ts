/**
 * M01: cosmetic threads drawn in drawing views. A tapped hole whose thread
 * is cosmetic (schema v67) keeps its tap-drill bore in the model, so no
 * projected edge shows the thread; the sheet draws it the conventional way
 * (ISO 6410-1) from the hole's callout instead:
 *
 * - looking down the bore (an end view), the major diameter as a thin
 *   three-quarter circle about the bore's axis, hidden when the bore opens
 *   on the far side;
 * - across the bore (a side view), the major diameter as two lines along the
 *   thread's length and the thread's limit across its end, hidden, since an
 *   internal thread lies inside the material.
 *
 * A view that sees the bore obliquely, and a section view, draw none: the
 * conventions above are for views square to the axis, and a section's cut
 * would need the thread's own section convention.
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
}

interface ThreadSourceBody {
  topology?: {
    faces: readonly {
      reference?: {
        producingFeatureId: FeatureId;
        lineageName: string;
      };
      geometry?: {
        surfaceType: string;
        axisStart?: Vector3;
        axisEnd?: Vector3;
      };
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

/**
 * The cosmetic threads of every bore of `bodies` a hole with a cosmetic
 * thread drilled: directly, at its sketch points, or as an M02 pattern's
 * copy (see `holeOfBoreFace`). A thread with no length runs the whole bore;
 * one stopped short starts at the bore's end on the hole's entry face.
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
        !face.reference ||
        geometry?.surfaceType.toLowerCase() !== 'cylinder' ||
        !geometry.axisStart ||
        !geometry.axisEnd
      )
        continue;
      const holeId = holeOfBoreFace(face.reference);
      const callout = holeId ? holes(holeId) : null;
      const thread = callout?.thread;
      if (!holeId || !thread?.cosmetic) continue;
      const span = sub(geometry.axisEnd, geometry.axisStart);
      const bore = length(span);
      if (!(bore > 0)) continue;
      // The entry end lies on the entry face's plane; a copy moved off that
      // plane (a mirror across a parallel plane) starts at the nearer end.
      let entry = geometry.axisStart;
      let exit = geometry.axisEnd;
      const plane = callout.entryPlane;
      if (plane) {
        const off = (point: Vector3) =>
          Math.abs(dot(sub(point, plane.point), plane.normal));
        if (off(exit) < off(entry)) [entry, exit] = [exit, entry];
      }
      const into = sub(exit, entry);
      threads.push({
        holeId,
        entry,
        axis: { x: into.x / bore, y: into.y / bore, z: into.z / bore },
        length: Math.min(thread.length ?? bore, bore),
        majorRadius: thread.majorDiameter / 2
      });
    }
  }
  return threads;
}

/** Below this the bore is square to the view (its sine or cosine). */
const SQUARE_TOLERANCE = 1e-6;
/** Segments of the three-quarter circle. */
const ARC_SEGMENTS = 48;

/**
 * The strokes `threads` draw in a view with `frame`, mapped to the paper by
 * `toPage`: a thin three-quarter circle seen down the bore, hidden lines
 * seen across it, nothing seen obliquely.
 */
export function cosmeticThreadStrokes(
  threads: readonly CosmeticThread[],
  frame: DrawingViewFrame,
  toPage: (u: number, v: number) => [number, number]
): SheetStroke[] {
  const strokes: SheetStroke[] = [];
  for (const thread of threads) {
    const along = dot(thread.axis, frame.direction);
    const at = projectToView(frame, thread.entry);
    if (Math.abs(Math.abs(along) - 1) <= SQUARE_TOLERANCE) {
      // Down the bore. The gap of the three-quarter circle sits in its
      // upper right quadrant, as ISO 6410-1 draws it; the bore opens toward
      // the viewer when its axis runs away from them.
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
      strokes.push({ kind: along > 0 ? 'thin' : 'hidden', points });
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

/** The cosmetic threads a view draws: none in a section (see the header). */
export function viewCosmeticThreads(
  view: Pick<DrawingView, 'bodyIds' | 'section'>,
  bodies: Readonly<Record<string, ThreadSourceBody | undefined>>,
  holes: HoleCalloutLookup
): CosmeticThread[] {
  if (view.section) return [];
  return cosmeticThreads(
    view.bodyIds.map((bodyId) => bodies[bodyId]),
    holes
  );
}
