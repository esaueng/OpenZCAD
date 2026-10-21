import type { RemusKernel } from './remus-runtime';
import type { ExactShape } from './exact-types';
import { displayTessellationForExtents } from './display-tessellation';
import { brepEdgeDisplayRole } from './exact-brep';
import { edgeToFaceMapOf } from './exact-sync-memo';
import {
  ownedMeshFaceOffsets,
  ownedMeshIndices,
  ownedMeshPositions
} from './owned-mesh-output';

/**
 * One body's tessellation for D01 drawing projection, in model units.
 *
 * The display mesh is the wrong input for a drawing a user hands off: it
 * holds an earlier deflection through small edits (`heldDisplayTessellation`)
 * and the same solid comes out of a checkpoint replay with its triangles and
 * vertices in a different order than from a full rebuild. Either way the
 * same model state could draw different lines, or the same lines in a
 * different order, and export different bytes after a reload.
 *
 * This one is canonical: every solid is meshed at the nominal display
 * deflection for its own exact bounds, never a held one, and the result is
 * put in an order that depends only on its coordinates — faces, triangles
 * within a face, vertices and edge polylines alike. The same exact geometry
 * therefore always gives the same arrays, whichever build path produced it.
 */
export interface DrawingBodyTessellation {
  /** Welded-per-face xyz triples, numbered in first use by `indices`. */
  vertices: Float32Array;
  indices: Uint32Array;
  /** Triangle ranges of the body's B-rep faces, in canonical order. */
  faces: { triangleStart: number; triangleCount: number }[];
  /** Xyz polylines of the body's physical (non-seam) edges. */
  edges: Float32Array[];
}

function compareSequences(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** Compares the xyz points of `a` at `i` and `b` at `j`. */
function comparePointsAt(
  a: Float32Array,
  i: number,
  b: Float32Array,
  j: number
): number {
  return a[i]! - b[j]! || a[i + 1]! - b[j + 1]! || a[i + 2]! - b[j + 2]!;
}

/**
 * A face's triangles (nine floats each) rotated so each starts at its
 * smallest corner, winding kept, and sorted.
 */
function canonicalFace(triangles: Float32Array): Float32Array {
  const count = Math.floor(triangles.length / 9);
  const rotated = new Float32Array(count * 9);
  for (let t = 0; t < count; t += 1) {
    const o = t * 9;
    // Lead with the smallest corner; the cyclic order is the winding.
    let lead = 0;
    if (comparePointsAt(triangles, o + 3, triangles, o + lead * 3) < 0)
      lead = 1;
    if (comparePointsAt(triangles, o + 6, triangles, o + lead * 3) < 0)
      lead = 2;
    for (let k = 0; k < 3; k += 1) {
      const from = o + ((lead + k) % 3) * 3;
      rotated[o + k * 3] = triangles[from]!;
      rotated[o + k * 3 + 1] = triangles[from + 1]!;
      rotated[o + k * 3 + 2] = triangles[from + 2]!;
    }
  }
  const order = Array.from({ length: count }, (_, t) => t);
  order.sort((x, y) => {
    for (let k = 0; k < 9; k += 1) {
      const d = rotated[x * 9 + k]! - rotated[y * 9 + k]!;
      if (d !== 0) return d;
    }
    return 0;
  });
  const sorted = new Float32Array(count * 9);
  order.forEach((t, index) =>
    sorted.set(rotated.subarray(t * 9, t * 9 + 9), index * 9)
  );
  return sorted;
}

/**
 * An edge polyline read from its smaller end (a closed one, in the direction
 * that compares smaller), so an edge reads the same way whichever direction
 * the build sampled it.
 */
function canonicalPolyline(points: Float32Array): Float32Array {
  const order = comparePointsAt(points, 0, points, points.length - 3);
  if (order < 0) return points;
  const reversed = new Float32Array(points.length);
  for (let i = 0, j = points.length - 3; j >= 0; i += 3, j -= 3)
    reversed.set(points.subarray(j, j + 3), i);
  if (order > 0) return reversed;
  return compareSequences(reversed, points) < 0 ? reversed : points;
}

/**
 * Puts a body's tessellation in an order that depends only on its
 * coordinates. `faces` holds each B-rep face's triangles as nine floats per
 * triangle, in any order and rotation; `edges` holds xyz polylines in any
 * order and direction. Vertices are welded per face and numbered in first
 * use, so nothing about the input's own numbering survives.
 */
export function canonicalDrawingTessellation(
  faces: readonly Float32Array[],
  edges: readonly Float32Array[]
): DrawingBodyTessellation {
  const canonicalFaces = faces
    .filter((face) => face.length >= 9)
    .map(canonicalFace)
    .sort(compareSequences);
  const vertices: number[] = [];
  const indices: number[] = [];
  const ranges: DrawingBodyTessellation['faces'] = [];
  for (const face of canonicalFaces) {
    const ids = new Map<string, number>();
    ranges.push({
      triangleStart: indices.length / 3,
      triangleCount: face.length / 9
    });
    for (let i = 0; i < face.length; i += 3) {
      const key = `${face[i]},${face[i + 1]},${face[i + 2]}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = vertices.length / 3;
        ids.set(key, id);
        vertices.push(face[i]!, face[i + 1]!, face[i + 2]!);
      }
      indices.push(id);
    }
  }
  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    faces: ranges,
    edges: edges
      .filter((edge) => edge.length >= 6)
      .map(canonicalPolyline)
      .sort(compareSequences)
  };
}

/**
 * What one drawing-tessellation request may hold, across all its bodies: the
 * display projection's admission limit. Charged for the triangle corners and
 * edge points each solid adds (the arrays canonicalization copies), before
 * they are copied.
 */
export const MAX_DRAWING_TESSELLATION_BYTES = 32 * 1024 * 1024;

/** The bytes a request has left; shared by every body it meshes. */
export interface DrawingTessellationBudget {
  remainingBytes: number;
}

export class DrawingTessellationBudgetError extends Error {
  constructor() {
    super(
      'The model is too detailed to draw: its tessellation exceeds the drawing memory budget.'
    );
    this.name = 'DrawingTessellationBudgetError';
  }
}

function charge(budget: DrawingTessellationBudget, bytes: number): void {
  budget.remainingBytes -= bytes;
  if (budget.remainingBytes < 0) throw new DrawingTessellationBudgetError();
}

/**
 * The canonical drawing tessellation of one exact body. Throws when the body
 * has no solids, like the display projection, and refuses by name, before
 * copying, a tessellation that would overrun the request's `budget`.
 */
export function drawingTessellationOfShape(
  kernel: RemusKernel,
  shape: ExactShape,
  budget: DrawingTessellationBudget = {
    remainingBytes: MAX_DRAWING_TESSELLATION_BYTES
  }
): DrawingBodyTessellation {
  if (!shape.solids.length) throw new Error('Exact body contains no solids.');
  const faces: Float32Array[] = [];
  const edges: Float32Array[] = [];
  for (const solid of shape.solids) {
    const b = kernel.boundingBox(solid);
    // Nominal, never held: the deflection follows the exact bounds alone.
    const tess = displayTessellationForExtents(
      b[3]! - b[0]!,
      b[4]! - b[1]!,
      b[5]! - b[2]!
    );
    const mesh = kernel.tessellateSolidGroupedBinary(
      solid,
      tess.linearDeflection,
      tess.angularDeflection
    );
    try {
      const positions = ownedMeshPositions(mesh);
      const indices = ownedMeshIndices(mesh);
      const offsets = ownedMeshFaceOffsets(mesh);
      // Three float32 coordinates per corner.
      charge(budget, indices.length * 3 * 4);
      for (let f = 0; f + 1 < offsets.length; f += 1)
        faces.push(cornersOf(positions, indices, offsets[f]!, offsets[f + 1]!));
    } finally {
      mesh.free();
    }
    const edgeToFaces = edgeToFaceMapOf(kernel, solid);
    const edgeHandles = Array.from(kernel.getSolidEdges(solid));
    const lines = kernel.meshEdgesAll(
      solid,
      tess.linearDeflection,
      tess.angularDeflection
    );
    try {
      const sampled = lines.positions;
      charge(budget, sampled.length * 4);
      const points = Float32Array.from(sampled);
      const offsets = [...Array.from(lines.offsets), points.length];
      if (
        edgeHandles.length !== lines.edgeCount ||
        offsets.length !== edgeHandles.length + 1
      )
        throw new Error(
          `Edge tessellation layout mismatch: ${edgeHandles.length} handles, ${lines.edgeCount} sampled edges.`
        );
      for (let e = 0; e < edgeHandles.length; e += 1) {
        // Seams are not physical edges; a drawing never shows them.
        if (
          brepEdgeDisplayRole(kernel, edgeHandles[e]!, edgeToFaces) !== 'seam'
        )
          edges.push(points.slice(offsets[e], offsets[e + 1]));
      }
    } finally {
      lines.free();
    }
  }
  return canonicalDrawingTessellation(faces, edges);
}

/** The corners of triangles `indices[start, end)` as nine floats each. */
function cornersOf(
  positions: Float32Array,
  indices: Uint32Array,
  start: number,
  end: number
): Float32Array {
  const corners = new Float32Array((end - start) * 3);
  for (let i = start; i < end; i += 1)
    corners.set(
      positions.subarray(indices[i]! * 3, indices[i]! * 3 + 3),
      (i - start) * 3
    );
  return corners;
}
