import {
  DRAWING_VIEW_FRAMES,
  type DrawingViewFrame,
  type DrawingViewOrientation
} from '@openzcad/shared';

/**
 * D01 view projection with hidden-line removal, in plain TypeScript.
 *
 * Why not the kernel's `projectEdges`: on the pinned build its occlusion test
 * is local — a point is hidden only when a step of `1e-4 · diagonal` toward
 * the camera enters the solid — so an edge behind a separate wall of the same
 * part (the far post of a U seen from the side) reads as visible, one body
 * never hides another, and curved faces get no silhouette (outline) curves,
 * so a cylinder's side view has no sides. Both were measured against the pin;
 * see `test/drawing-projection.test.ts`.
 *
 * What this does instead, from the display projection the geometry worker
 * already publishes for every body:
 *
 * - **Lines.** Every feature edge's polyline, sampled by the kernel from the
 *   exact curve (seam edges are not physical edges and are left out), plus
 *   silhouette lines of curved faces: display-mesh edges where the surface
 *   turns from facing the camera to facing away, within one face or across a
 *   smooth (tangent) boundary.
 * - **Visibility.** A projected edge segment is split wherever it crosses
 *   the edge of a triangle it passes over, and wherever it passes through a
 *   triangle's plane; between two such cuts the same triangles cover it on
 *   the same side, so each piece is classified once, at its middle:
 *   hidden when a triangle of any body in the view lies in front of it by
 *   more than a depth tolerance. No occluder is too narrow to be found.
 *
 * This is an approximation, and labelled as one: occlusion is tested against
 * the display tessellation (chordal error of its deflection) and silhouettes
 * run through mesh vertices. Exact edge geometry is used wherever an edge
 * exists. Coordinates are in model units in the view plane, u right, v up.
 */

export interface ProjectionBodyInput {
  /** World-space xyz triples. */
  vertices: Float32Array | Float64Array;
  indices: Uint32Array;
  /** Triangle ranges of the body's B-rep faces, when topology is known. */
  faces?: readonly { triangleStart: number; triangleCount: number }[];
  /** World-space xyz polylines of the body's physical edges. */
  edges: readonly (Float32Array | Float64Array | readonly number[])[];
}

export interface ViewProjectionInput {
  orientation: DrawingViewOrientation;
  hiddenLines: boolean;
  bodies: readonly ProjectionBodyInput[];
}

export interface ViewProjection {
  /** Flat `[u0, v0, u1, v1, …]` polylines in model units. */
  visible: Float64Array[];
  hidden: Float64Array[];
  /** Extent of everything the view draws, or null for an empty view. */
  bounds: { minU: number; minV: number; maxU: number; maxV: number } | null;
}

/**
 * Cosine of the largest turn between two display triangles still treated as
 * one smooth surface when the body publishes no B-rep faces to say so.
 */
const SAG_FALLBACK_SMOOTH_COS = Math.cos((15 * Math.PI) / 180);
/** Cosine of the largest dihedral still treated as a smooth surface. */
const SMOOTH_DIHEDRAL_COS = Math.cos((50 * Math.PI) / 180);

export interface Triangle {
  u0: number;
  v0: number;
  d0: number;
  u1: number;
  v1: number;
  d1: number;
  u2: number;
  v2: number;
  d2: number;
  area: number;
  /** Depth margin for this triangle: a floor plus its own chordal sag. */
  tol: number;
}

/**
 * The cells of a `size` × `size` grid that segment (x0, y0)→(x1, y1), in cell
 * units, passes through: a supercover DDA walk. At each step it moves into
 * the next cell across whichever boundary it reaches first, and through both
 * neighbours when it passes exactly through a corner, so no clipped corner of
 * a cell is skipped. Returns row-major indices, possibly repeated.
 */
export function gridCellsAlong(
  rawX0: number,
  rawY0: number,
  rawX1: number,
  rawY1: number,
  size: number
): number[] {
  // Projected points lie inside the grid's bounds up to rounding; one on the
  // far boundary would otherwise start the walk a cell off.
  const inside = (value: number) =>
    Math.min(size * (1 - 1e-12), Math.max(0, value));
  const x0 = inside(rawX0);
  const y0 = inside(rawY0);
  const x1 = inside(rawX1);
  const y1 = inside(rawY1);
  const clamp = (value: number) => Math.min(size - 1, Math.max(0, value));
  const out: number[] = [];
  const add = (i: number, j: number) => {
    if (i >= 0 && i < size && j >= 0 && j < size) out.push(j * size + i);
  };
  let i = clamp(Math.floor(x0));
  let j = clamp(Math.floor(y0));
  const iEnd = clamp(Math.floor(x1));
  const jEnd = clamp(Math.floor(y1));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const di = Math.sign(dx);
  const dj = Math.sign(dy);
  const tDeltaX = di === 0 ? Infinity : 1 / Math.abs(dx);
  const tDeltaY = dj === 0 ? Infinity : 1 / Math.abs(dy);
  let tMaxX =
    di > 0
      ? (Math.floor(x0) + 1 - x0) * tDeltaX
      : di < 0
        ? (x0 - Math.floor(x0)) * tDeltaX
        : Infinity;
  let tMaxY =
    dj > 0
      ? (Math.floor(y0) + 1 - y0) * tDeltaY
      : dj < 0
        ? (y0 - Math.floor(y0)) * tDeltaY
        : Infinity;
  add(i, j);
  for (let step = 0; step < 4 * size + 4; step += 1) {
    // The segment ends inside the current cell.
    if (Math.min(tMaxX, tMaxY) > 1) break;
    if (Math.abs(tMaxX - tMaxY) <= 1e-12) {
      // Through a corner: both side cells touch the segment.
      add(i + di, j);
      add(i, j + dj);
      i += di;
      j += dj;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    } else if (tMaxX < tMaxY) {
      i += di;
      tMaxX += tDeltaX;
    } else {
      j += dj;
      tMaxY += tDeltaY;
    }
    add(i, j);
  }
  add(iEnd, jEnd);
  return out;
}

/** Exported for tests. */
export class OcclusionGrid {
  private readonly cells: number[][];
  private readonly size: number;
  private readonly minU: number;
  private readonly minV: number;
  private readonly cellU: number;
  private readonly cellV: number;

  constructor(
    private readonly triangles: Triangle[],
    bounds: { minU: number; minV: number; maxU: number; maxV: number },
    private readonly coverTolerance: number
  ) {
    this.size = Math.max(
      8,
      Math.min(256, Math.ceil(Math.sqrt(triangles.length / 2)))
    );
    this.minU = bounds.minU;
    this.minV = bounds.minV;
    this.cellU = Math.max((bounds.maxU - bounds.minU) / this.size, 1e-12);
    this.cellV = Math.max((bounds.maxV - bounds.minV) / this.size, 1e-12);
    this.cells = Array.from({ length: this.size * this.size }, () => []);
    // Each triangle goes only into the cells it covers, row by row: clip it
    // to the row's strip and take the strip's u-range. Bounding boxes would
    // put a long thin sliver (a fan around a shared vertex) into every cell
    // of its box, which on a dense mesh runs to billions of entries.
    triangles.forEach((triangle, index) => {
      const corners = [
        [triangle.u0, triangle.v0],
        [triangle.u1, triangle.v1],
        [triangle.u2, triangle.v2]
      ] as const;
      const j0 = this.row(Math.min(triangle.v0, triangle.v1, triangle.v2));
      const j1 = this.row(Math.max(triangle.v0, triangle.v1, triangle.v2));
      for (let j = j0; j <= j1; j += 1) {
        // The strip, widened by a hair so a triangle touching its boundary
        // still lands in both rows.
        const bottom = this.minV + j * this.cellV - this.cellV * 1e-9;
        const top = this.minV + (j + 1) * this.cellV + this.cellV * 1e-9;
        let low = Infinity;
        let high = -Infinity;
        const take = (u: number) => {
          low = Math.min(low, u);
          high = Math.max(high, u);
        };
        for (let e = 0; e < 3; e += 1) {
          const [pu, pv] = corners[e]!;
          const [qu, qv] = corners[(e + 1) % 3]!;
          if (pv >= bottom && pv <= top) take(pu);
          for (const line of [bottom, top]) {
            if ((pv - line) * (qv - line) < 0)
              take(pu + ((qu - pu) * (line - pv)) / (qv - pv));
          }
        }
        if (low > high) continue;
        const i0 = this.column(low);
        const i1 = this.column(high);
        for (let i = i0; i <= i1; i += 1)
          this.cells[j * this.size + i]!.push(index);
      }
    });
  }

  /** How many triangle entries the grid holds; for tests. */
  get entryCount(): number {
    return this.cells.reduce((sum, cell) => sum + cell.length, 0);
  }

  private column(u: number): number {
    return Math.min(
      this.size - 1,
      Math.max(0, Math.floor((u - this.minU) / this.cellU))
    );
  }

  private row(v: number): number {
    return Math.min(
      this.size - 1,
      Math.max(0, Math.floor((v - this.minV) / this.cellV))
    );
  }

  /**
   * Parameters in (0, 1) where segment a→b crosses the edge of a triangle
   * it passes over (`depth: false`) or a triangle's occlusion threshold
   * (`depth: true`), sorted. A depth cut also says whether the segment's
   * start or end lies on that triangle's plane (`onA`, `onB`): the face the
   * point belongs to, which is what makes a sliver there a corner artifact. Between two of them every point is covered by
   * the same triangles on the same side, so visibility is constant there.
   */
  crossings(
    au: number,
    av: number,
    ad: number,
    bu: number,
    bv: number,
    bd: number
  ): { t: number; depth: boolean; onA?: boolean; onB?: boolean }[] {
    const du = bu - au;
    const dv = bv - av;
    // Every cell the segment passes through, by an exact supercover walk:
    // triangles are bucketed by their bounding boxes, so a triangle the
    // segment crosses is in one of these cells.
    const seen = new Set<number>();
    for (const cell of this.cellsAlong(au, av, bu, bv))
      for (const index of this.cells[cell]!) seen.add(index);
    const out: { t: number; depth: boolean; onA?: boolean; onB?: boolean }[] =
      [];
    const denomFloor = 1e-18;
    for (const index of seen) {
      const t = this.triangles[index]!;
      const corners = [
        [t.u0, t.v0],
        [t.u1, t.v1],
        [t.u2, t.v2]
      ] as const;
      for (let e = 0; e < 3; e += 1) {
        const [pu, pv] = corners[e]!;
        const [qu, qv] = corners[(e + 1) % 3]!;
        const eu = qu - pu;
        const ev = qv - pv;
        const denom = du * ev - dv * eu;
        if (Math.abs(denom) <= denomFloor) continue;
        const s = ((pu - au) * ev - (pv - av) * eu) / denom;
        const r = ((pu - au) * dv - (pv - av) * du) / denom;
        if (s > 0 && s < 1 && r >= 0 && r <= 1)
          out.push({ t: s, depth: false });
      }
      // Where the segment's depth meets this triangle's occlusion
      // threshold (an edge piercing a face, two bodies that intersect, or an
      // edge leaving a face it starts on): `occluded` tests
      // `surface < depth - tol`, so its answer flips exactly where
      // plane − depth = −tol. Both are linear along the segment. Slivers
      // this cuts at an edge's own corner are merged away afterwards.
      const plane = (u: number, v: number) => {
        const w0 = ((t.u1 - u) * (t.v2 - v) - (t.u2 - u) * (t.v1 - v)) / t.area;
        const w1 = ((t.u2 - u) * (t.v0 - v) - (t.u0 - u) * (t.v2 - v)) / t.area;
        return w0 * t.d0 + w1 * t.d1 + (1 - w0 - w1) * t.d2;
      };
      const f0 = plane(au, av) - ad + t.tol;
      const f1 = plane(bu, bv) - bd + t.tol;
      if ((f0 < 0 && f1 > 0) || (f0 > 0 && f1 < 0)) {
        const s = f0 / (f0 - f1);
        // Near the plane is not enough: the end must be on this triangle's
        // boundary, as an edge's end vertex is on the faces that meet it.
        // An unrelated occluder whose plane passes by the end bounds a real
        // interval, however short.
        if (s > 0 && s < 1)
          out.push({
            t: s,
            depth: true,
            onA:
              Math.abs(f0 - t.tol) <= t.tol &&
              onTriangleBoundary(t, au, av, ad),
            onB:
              Math.abs(f1 - t.tol) <= t.tol && onTriangleBoundary(t, bu, bv, bd)
          });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  private cellsAlong(au: number, av: number, bu: number, bv: number): number[] {
    return gridCellsAlong(
      (au - this.minU) / this.cellU,
      (av - this.minV) / this.cellV,
      (bu - this.minU) / this.cellU,
      (bv - this.minV) / this.cellV,
      this.size
    );
  }

  /** True when a triangle covers (u, v) in front of `depth`. */
  occluded(u: number, v: number, depth: number): boolean {
    const cell = this.cells[this.row(v) * this.size + this.column(u)]!;
    for (const index of cell) {
      const t = this.triangles[index]!;
      // Barycentric weights against the signed projected area. A sample on a
      // triangle's boundary counts as covered: an exclusive test let samples
      // on the diagonal shared by two triangles of one face slip through as
      // visible. Lines that only coincide with an occluder's outline are
      // reconciled afterwards (`dropCoincidentHidden`).
      const w0 = ((t.u1 - u) * (t.v2 - v) - (t.u2 - u) * (t.v1 - v)) / t.area;
      const w1 = ((t.u2 - u) * (t.v0 - v) - (t.u0 - u) * (t.v2 - v)) / t.area;
      const w2 = 1 - w0 - w1;
      const edge = this.coverTolerance;
      if (w0 < -edge || w1 < -edge || w2 < -edge) continue;
      const surface = w0 * t.d0 + w1 * t.d1 + w2 * t.d2;
      if (surface < depth - t.tol) return true;
    }
    return false;
  }
}

function dot(frame: DrawingViewFrame['x'], x: number, y: number, z: number) {
  return frame.x * x + frame.y * y + frame.z * z;
}

/** Joins unordered segments (pairs of welded vertex ids) into polylines. */
function chainSegments(segments: [number, number][]): number[][] {
  const adjacency = new Map<number, number[]>();
  segments.forEach(([a, b], index) => {
    adjacency.set(a, [...(adjacency.get(a) ?? []), index]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), index]);
  });
  const used = new Set<number>();
  const chains: number[][] = [];
  const walk = (start: number, first: number): number[] => {
    const chain = [start];
    let at = start;
    let segment: number | undefined = first;
    while (segment !== undefined && !used.has(segment)) {
      used.add(segment);
      const [a, b] = segments[segment]!;
      at = a === at ? b : a;
      chain.push(at);
      const next = adjacency.get(at) ?? [];
      // Continue only through a simple (degree-2) vertex.
      segment =
        next.length === 2 ? next.find((entry) => !used.has(entry)) : undefined;
    }
    return chain;
  };
  // Open chains start at their ends; closed loops at any vertex.
  for (const [vertex, list] of adjacency)
    if (list.length !== 2)
      for (const segment of list)
        if (!used.has(segment)) chains.push(walk(vertex, segment));
  segments.forEach((segment, index) => {
    if (!used.has(index)) chains.push(walk(segment[0], index));
  });
  return chains;
}

/**
 * Where a run's point came from: one of the line's two ends (a B-rep edge's
 * end vertex, or a silhouette's), a sample along it, or a visibility cut.
 */
type CutKind = 'end' | 'vertex' | 'edge' | 'depth' | 'corner';

interface Polyline3 {
  points: number[];
}

export interface MeshAnalysis {
  welded: number[];
  positions: number[];
  faceOf: Int32Array;
  /** Unit triangle normals, xyz per triangle (zero for a degenerate one). */
  normals: Float64Array;
  /** Welded edge key → the triangles that share it. */
  edgeTriangles: Map<number, number[]>;
  vertexCount: number;
}

/** Welds a body's display mesh and records its triangles' normals and adjacency. */
function analyzeMesh(
  body: ProjectionBodyInput,
  weldQuantum: number
): MeshAnalysis {
  const { vertices, indices } = body;
  const weld = new Map<string, number>();
  const welded: number[] = [];
  const positions: number[] = [];
  for (let i = 0; i < vertices.length / 3; i += 1) {
    const x = vertices[i * 3]!;
    const y = vertices[i * 3 + 1]!;
    const z = vertices[i * 3 + 2]!;
    const key = `${Math.round(x / weldQuantum)},${Math.round(y / weldQuantum)},${Math.round(z / weldQuantum)}`;
    let id = weld.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      weld.set(key, id);
      positions.push(x, y, z);
    }
    welded.push(id);
  }
  const triangleCount = Math.floor(indices.length / 3);
  const faceOf = new Int32Array(triangleCount).fill(-1);
  body.faces?.forEach((face, faceIndex) => {
    for (let t = 0; t < face.triangleCount; t += 1) {
      const triangle = face.triangleStart + t;
      if (triangle < triangleCount) faceOf[triangle] = faceIndex;
    }
  });
  const normals = new Float64Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t += 1) {
    const a = welded[indices[t * 3]!]! * 3;
    const b = welded[indices[t * 3 + 1]!]! * 3;
    const c = welded[indices[t * 3 + 2]!]! * 3;
    const ex = positions[b]! - positions[a]!;
    const ey = positions[b + 1]! - positions[a + 1]!;
    const ez = positions[b + 2]! - positions[a + 2]!;
    const fx = positions[c]! - positions[a]!;
    const fy = positions[c + 1]! - positions[a + 1]!;
    const fz = positions[c + 2]! - positions[a + 2]!;
    const nx = ey * fz - ez * fy;
    const ny = ez * fx - ex * fz;
    const nz = ex * fy - ey * fx;
    const length = Math.hypot(nx, ny, nz);
    if (length === 0) continue;
    normals[t * 3] = nx / length;
    normals[t * 3 + 1] = ny / length;
    normals[t * 3 + 2] = nz / length;
  }
  const edgeTriangles = new Map<number, number[]>();
  const vertexCount = positions.length / 3;
  for (let t = 0; t < triangleCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const a = welded[indices[t * 3 + k]!]!;
      const b = welded[indices[t * 3 + ((k + 1) % 3)]!]!;
      if (a === b) continue;
      const key = Math.min(a, b) * vertexCount + Math.max(a, b);
      const list = edgeTriangles.get(key);
      if (list) list.push(t);
      else edgeTriangles.set(key, [t]);
    }
  }
  return { welded, positions, faceOf, normals, edgeTriangles, vertexCount };
}

/** Whether two triangles meet across a smooth part of one surface. */
function smoothNeighbours(mesh: MeshAnalysis, p: number, q: number): boolean {
  const sameFace = mesh.faceOf[p] !== -1 && mesh.faceOf[p] === mesh.faceOf[q];
  const cosine =
    mesh.normals[p * 3]! * mesh.normals[q * 3]! +
    mesh.normals[p * 3 + 1]! * mesh.normals[q * 3 + 1]! +
    mesh.normals[p * 3 + 2]! * mesh.normals[q * 3 + 2]!;
  return sameFace || cosine >= SMOOTH_DIHEDRAL_COS;
}

/**
 * How far each display triangle may sit from the exact surface it stands
 * for: its width across each smooth neighbouring edge times the angle its
 * normal turns there, over four (the sagitta of a chord is width · angle / 8,
 * doubled for safety). Planar faces have no sag, so a tolerance built from it
 * stays local: a wall a tenth of a millimetre in front of an edge still hides
 * it on a metre-long part.
 */
export function triangleSag(
  body: ProjectionBodyInput,
  mesh: MeshAnalysis = analyzeMesh(body, 1e-9)
): Float64Array {
  const sag = new Float64Array(mesh.faceOf.length);
  const { positions, vertexCount } = mesh;
  for (const [key, list] of mesh.edgeTriangles) {
    if (list.length !== 2) continue;
    const [p, q] = list as [number, number];
    // Sag belongs to one curved surface. Two faces meeting at a crease (a
    // chamfer's 45°) are each exact planes, however shallow the angle: the
    // B-rep face decides, and only a body without faces falls back to a
    // tight angle.
    const known = mesh.faceOf[p] !== -1 && mesh.faceOf[q] !== -1;
    if (known && mesh.faceOf[p] !== mesh.faceOf[q]) continue;
    const cosine =
      mesh.normals[p * 3]! * mesh.normals[q * 3]! +
      mesh.normals[p * 3 + 1]! * mesh.normals[q * 3 + 1]! +
      mesh.normals[p * 3 + 2]! * mesh.normals[q * 3 + 2]!;
    if (!known && cosine < SAG_FALLBACK_SMOOTH_COS) continue;
    const angle = Math.acos(Math.min(1, Math.max(-1, cosine)));
    if (angle === 0) continue;
    const a = Math.floor(key / vertexCount) * 3;
    const b = (key % vertexCount) * 3;
    const shared = Math.hypot(
      positions[b]! - positions[a]!,
      positions[b + 1]! - positions[a + 1]!,
      positions[b + 2]! - positions[a + 2]!
    );
    if (shared === 0) continue;
    for (const t of [p, q]) {
      const i0 = mesh.welded[body.indices[t * 3]!]! * 3;
      const i1 = mesh.welded[body.indices[t * 3 + 1]!]! * 3;
      const i2 = mesh.welded[body.indices[t * 3 + 2]!]! * 3;
      const ex = positions[i1]! - positions[i0]!;
      const ey = positions[i1 + 1]! - positions[i0 + 1]!;
      const ez = positions[i1 + 2]! - positions[i0 + 2]!;
      const fx = positions[i2]! - positions[i0]!;
      const fy = positions[i2 + 1]! - positions[i0 + 1]!;
      const fz = positions[i2 + 2]! - positions[i0 + 2]!;
      const doubleArea = Math.hypot(
        ey * fz - ez * fy,
        ez * fx - ex * fz,
        ex * fy - ey * fx
      );
      const width = doubleArea / shared;
      sag[t] = Math.max(sag[t]!, (width * angle) / 4);
    }
  }
  return sag;
}

/**
 * The silhouette polylines of one body's curved surfaces, as world points.
 * Exported for tests.
 */
export function bodySilhouettes(
  body: ProjectionBodyInput,
  frame: DrawingViewFrame,
  weldQuantum: number,
  mesh: MeshAnalysis = analyzeMesh(body, weldQuantum)
): Polyline3[] {
  const triangleCount = mesh.faceOf.length;
  const facing = new Int8Array(triangleCount);
  for (let t = 0; t < triangleCount; t += 1) {
    // A facet seen exactly edge-on counts as facing away. A cylinder whose
    // silhouette falls mid-facet then outlines at that facet's front edge,
    // half a facet off the true curve; a wall seen along its axis (all of it
    // edge-on) meets its caps at sharp creases, which are never silhouettes.
    facing[t] =
      dot(
        frame.direction,
        mesh.normals[t * 3]!,
        mesh.normals[t * 3 + 1]!,
        mesh.normals[t * 3 + 2]!
      ) < -1e-12
        ? 1
        : -1;
  }
  const segments: [number, number][] = [];
  for (const [key, list] of mesh.edgeTriangles) {
    if (list.length !== 2) continue;
    const [p, q] = list as [number, number];
    if (facing[p] === facing[q]) continue;
    // A sharp crease between two faces is a feature edge, drawn already.
    if (!smoothNeighbours(mesh, p, q)) continue;
    segments.push([Math.floor(key / mesh.vertexCount), key % mesh.vertexCount]);
  }
  const { positions } = mesh;
  return chainSegments(segments).map((chain) => ({
    points: chain.flatMap((id) => [
      positions[id * 3]!,
      positions[id * 3 + 1]!,
      positions[id * 3 + 2]!
    ])
  }));
}

/** True when (u, v, d) lies within the triangle's tolerance of one of its sides. */
function onTriangleBoundary(
  t: Triangle,
  u: number,
  v: number,
  d: number
): boolean {
  const corners = [
    [t.u0, t.v0, t.d0],
    [t.u1, t.v1, t.d1],
    [t.u2, t.v2, t.d2]
  ] as const;
  for (let e = 0; e < 3; e += 1) {
    const p = corners[e]!;
    const q = corners[(e + 1) % 3]!;
    const eu = q[0] - p[0];
    const ev = q[1] - p[1];
    const ed = q[2] - p[2];
    const lengthSq = eu * eu + ev * ev + ed * ed;
    const f =
      lengthSq > 0
        ? Math.min(
            1,
            Math.max(
              0,
              ((u - p[0]) * eu + (v - p[1]) * ev + (d - p[2]) * ed) / lengthSq
            )
          )
        : 0;
    if (
      Math.hypot(u - p[0] - eu * f, v - p[1] - ev * f, d - p[2] - ed * f) <=
      t.tol
    )
      return true;
  }
  return false;
}

/** Four float32 units in the last place, relative to the coordinate. */
const FLOAT32_NOISE = 2 ** -21;

/**
 * How close two mesh vertices must be to count as one: a ten-millionth of
 * the body, but never more than a hundredth of its shortest triangle side,
 * so a long thin body never welds a rim of its own vertices into a point.
 */
export function weldQuantum(
  body: ProjectionBodyInput,
  diagonal: number
): number {
  const { vertices, indices } = body;
  let shortest = Infinity;
  for (let t = 0; t + 2 < indices.length; t += 3)
    for (let k = 0; k < 3; k += 1) {
      const a = indices[t + k]! * 3;
      const b = indices[t + ((k + 1) % 3)]! * 3;
      const length = Math.hypot(
        vertices[b]! - vertices[a]!,
        vertices[b + 1]! - vertices[a + 1]!,
        vertices[b + 2]! - vertices[a + 2]!
      );
      if (length > 0 && length < shortest) shortest = length;
    }
  return Math.min(diagonal * 1e-7, shortest * 1e-2);
}

/** The diagonal of a body's display-mesh bounding box (never zero). */
function bodyDiagonal(body: ProjectionBodyInput): number {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const take = (x: number, y: number, z: number) => {
    const p = [x, y, z];
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k]!, p[k]!);
      max[k] = Math.max(max[k]!, p[k]!);
    }
  };
  for (let i = 0; i + 2 < body.vertices.length; i += 3)
    take(body.vertices[i]!, body.vertices[i + 1]!, body.vertices[i + 2]!);
  for (const edge of body.edges)
    for (let i = 0; i + 2 < edge.length; i += 3)
      take(edge[i]!, edge[i + 1]!, edge[i + 2]!);
  if (!Number.isFinite(min[0]!)) return 1e-9;
  return Math.max(
    Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!),
    1e-9
  );
}

/** Projects the bodies of one view into visible and hidden polylines. */
export function projectView(input: ViewProjectionInput): ViewProjection {
  const frame = DRAWING_VIEW_FRAMES[input.orientation];
  const project = (x: number, y: number, z: number) =>
    [
      dot(frame.x, x, y, z),
      dot(frame.up, x, y, z),
      dot(frame.direction, x, y, z)
    ] as const;

  const triangles: Triangle[] = [];
  const bounds = {
    minU: Infinity,
    minV: Infinity,
    maxU: -Infinity,
    maxV: -Infinity
  };
  // Every scale that only absorbs float noise is the body's own: bodies far
  // apart (along the view or across it) must not coarsen each other.
  const scales = input.bodies.map(bodyDiagonal);
  const welds = input.bodies.map((body, bodyIndex) =>
    weldQuantum(body, scales[bodyIndex]!)
  );
  const meshes = input.bodies.map((body, bodyIndex) =>
    analyzeMesh(body, welds[bodyIndex]!)
  );
  input.bodies.forEach((body, bodyIndex) => {
    const { vertices, indices } = body;
    const sag = triangleSag(body, meshes[bodyIndex]);
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const [u0, v0, d0] = project(
        vertices[indices[t]! * 3]!,
        vertices[indices[t]! * 3 + 1]!,
        vertices[indices[t]! * 3 + 2]!
      );
      const [u1, v1, d1] = project(
        vertices[indices[t + 1]! * 3]!,
        vertices[indices[t + 1]! * 3 + 1]!,
        vertices[indices[t + 1]! * 3 + 2]!
      );
      const [u2, v2, d2] = project(
        vertices[indices[t + 2]! * 3]!,
        vertices[indices[t + 2]! * 3 + 1]!,
        vertices[indices[t + 2]! * 3 + 2]!
      );
      bounds.minU = Math.min(bounds.minU, u0, u1, u2);
      bounds.maxU = Math.max(bounds.maxU, u0, u1, u2);
      bounds.minV = Math.min(bounds.minV, v0, v1, v2);
      bounds.maxV = Math.max(bounds.maxV, v0, v1, v2);
      const area = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
      // Edge-on triangles cover no area and cannot hide anything; judged
      // against the triangle's own size, not the view's.
      const longest = Math.max(
        (u1 - u0) ** 2 + (v1 - v0) ** 2,
        (u2 - u1) ** 2 + (v2 - v1) ** 2,
        (u0 - u2) ** 2 + (v0 - v2) ** 2
      );
      if (Math.abs(area) <= longest * 1e-10) continue;
      // The floor absorbs only float noise: display meshes are float32, so
      // a vertex is good to a few units in the last place of its own
      // coordinates. Neither the body's size nor the triangle's sets it: a
      // large plate must still hide an edge a hair behind it.
      let magnitude = 0;
      for (let k = 0; k < 3; k += 1)
        for (let c = 0; c < 3; c += 1)
          magnitude = Math.max(
            magnitude,
            Math.abs(vertices[indices[t + k]! * 3 + c]!)
          );
      triangles.push({
        u0,
        v0,
        d0,
        u1,
        v1,
        d1,
        u2,
        v2,
        d2,
        area,
        tol: Math.max(magnitude * FLOAT32_NOISE, 1e-12) + sag[t / 3]!
      });
    }
  });

  // Each line keeps its body's scale: a cutoff for degenerate or sliver
  // output must not grow with empty paper between bodies far apart.
  const lines: { points: number[]; scale: number }[] = [];
  input.bodies.forEach((body, bodyIndex) => {
    const scale = scales[bodyIndex]!;
    for (const edge of body.edges)
      lines.push({ points: Array.from(edge), scale });
    for (const silhouette of bodySilhouettes(
      body,
      frame,
      welds[bodyIndex]!,
      meshes[bodyIndex]
    ))
      lines.push({ points: silhouette.points, scale });
  });
  for (const { points: line } of lines)
    for (let i = 0; i + 2 < line.length; i += 3) {
      const [u, v] = project(line[i]!, line[i + 1]!, line[i + 2]!);
      bounds.minU = Math.min(bounds.minU, u);
      bounds.maxU = Math.max(bounds.maxU, u);
      bounds.minV = Math.min(bounds.minV, v);
      bounds.maxV = Math.max(bounds.maxV, v);
    }
  if (!Number.isFinite(bounds.minU))
    return { visible: [], hidden: [], bounds: null };

  const grid = new OcclusionGrid(triangles, bounds, 1e-9);
  // Thresholds on drawn (projected) lines scale with what is drawn.
  const span = Math.max(
    Math.hypot(bounds.maxU - bounds.minU, bounds.maxV - bounds.minV),
    1e-9
  );
  const hiddenAt = (x: number, y: number, z: number): boolean => {
    const [u, v, d] = project(x, y, z);
    return grid.occluded(u, v, d);
  };

  const visible: Float64Array[] = [];
  const hidden: Float64Array[] = [];
  const emit = (points: number[], isHidden: boolean, scale: number) => {
    if (points.length < 6) return;
    let length = 0;
    for (let i = 3; i < points.length; i += 3)
      length += Math.hypot(
        points[i]! - points[i - 3]!,
        points[i + 1]! - points[i - 2]!,
        points[i + 2]! - points[i - 1]!
      );
    if (length <= scale * 1e-9) return;
    if (isHidden && !input.hiddenLines) return;
    const flat = new Float64Array((points.length / 3) * 2);
    let drawn = 0;
    for (let i = 0, j = 0; i < points.length; i += 3, j += 2) {
      const [u, v] = project(points[i]!, points[i + 1]!, points[i + 2]!);
      flat[j] = u;
      flat[j + 1] = v;
      if (j > 0) drawn += Math.hypot(u - flat[j - 2]!, v - flat[j - 1]!);
    }
    // An edge running along the view direction projects to a point.
    if (drawn <= scale * 1e-9) return;
    (isHidden ? hidden : visible).push(flat);
  };

  // Corner artifacts shorter than this, in projection, take their
  // neighbours' state: where an edge meets a face's plane at its own end,
  // the occlusion tolerance leaves a sliver that is neither clearly in front
  // nor behind, and no drawing wants it. The cutoff is the line's own body's.
  for (const { points: line, scale } of lines) {
    const minPiece = scale * 1e-4;
    const count = Math.floor(line.length / 3);
    if (count < 2) continue;
    const point = (index: number, f: number) => [
      line[index * 3]! + (line[index * 3 + 3]! - line[index * 3]!) * f,
      line[index * 3 + 1]! + (line[index * 3 + 4]! - line[index * 3 + 1]!) * f,
      line[index * 3 + 2]! + (line[index * 3 + 5]! - line[index * 3 + 2]!) * f
    ];
    // The line as points with one state per span between them. Visibility
    // changes only where a projected segment crosses an occluding
    // triangle's edge or occlusion threshold, so those cuts split it exactly
    // and each span is classified once, however narrow the occluder.
    const points: number[] = [line[0]!, line[1]!, line[2]!];
    /** What each point is: one of the line's own vertices, or a cut. */
    const kinds: CutKind[] = ['end'];
    const spans: boolean[] = [];
    for (let s = 0; s < count - 1; s += 1) {
      const [au, av, ad] = project(
        line[s * 3]!,
        line[s * 3 + 1]!,
        line[s * 3 + 2]!
      );
      const [bu, bv, bd] = project(
        line[s * 3 + 3]!,
        line[s * 3 + 4]!,
        line[s * 3 + 5]!
      );
      // Cuts closer than float noise collapse into one; the segment's own
      // end always survives, so the line keeps every one of its vertices.
      const cuts: { t: number; kind: CutKind }[] = [
        { t: 0, kind: s === 0 ? 'end' : 'vertex' }
      ];
      // A depth cut is a corner cut only when the line's own end lies on the
      // plane that made it: the face at that end. Any other occluder's
      // threshold bounds a real interval, however short.
      const found: { t: number; kind: CutKind }[] = grid
        .crossings(au, av, ad, bu, bv, bd)
        .map(({ t, depth, onA, onB }) => ({
          t,
          kind: !depth
            ? 'edge'
            : (s === 0 && onA) || (s === count - 2 && onB)
              ? 'corner'
              : 'depth'
        }));
      // Only the line's own two ends are B-rep edge ends; the samples between
      // are just points along a curve.
      found.push({ t: 1, kind: s === count - 2 ? 'end' : 'vertex' });
      for (const cut of found) {
        const last = cuts.at(-1)!;
        if (cut.t - last.t > 1e-12) cuts.push(cut);
        else if (cut.kind === 'vertex' || cut.kind === 'end')
          cuts[cuts.length - 1] = cut;
        // Coincident cuts: a footprint crossing outranks a depth one, and
        // the face at the line's end outranks other triangles of its plane
        // that do not touch the end.
        else if (
          cut.kind === 'edge' &&
          (last.kind === 'depth' || last.kind === 'corner')
        )
          last.kind = 'edge';
        else if (cut.kind === 'corner' && last.kind === 'depth')
          last.kind = 'corner';
      }
      for (let k = 0; k + 1 < cuts.length; k += 1) {
        const t0 = cuts[k]!.t;
        const t1 = cuts[k + 1]!.t;
        const [x, y, z] = point(s, (t0 + t1) / 2);
        spans.push(hiddenAt(x!, y!, z!));
        const [ex, ey, ez] = point(s, t1);
        points.push(ex!, ey!, ez!);
        kinds.push(cuts[k + 1]!.kind);
      }
    }
    if (spans.length === 0) continue;
    // Group spans into pieces of one state, then let each short piece take
    // the state before it (or after it, at the start of the line).
    const spanLength = (index: number) => {
      const [u0, v0] = project(
        points[index * 3]!,
        points[index * 3 + 1]!,
        points[index * 3 + 2]!
      );
      const [u1, v1] = project(
        points[index * 3 + 3]!,
        points[index * 3 + 4]!,
        points[index * 3 + 5]!
      );
      return Math.hypot(u1 - u0, v1 - v0);
    };
    const pieces: {
      from: number;
      to: number;
      hidden: boolean;
      length: number;
    }[] = [];
    spans.forEach((hidden, index) => {
      const last = pieces.at(-1);
      if (last && last.hidden === hidden) {
        last.to = index + 1;
        last.length += spanLength(index);
      } else
        pieces.push({
          from: index,
          to: index + 1,
          hidden,
          length: spanLength(index)
        });
    });
    // Only a corner artifact merges: a short piece between one of the
    // line's two ends and an occlusion-threshold cut, where the edge meets
    // the plane of a face at its own end. A piece beside an interior sample
    // of a curved edge, or bounded by an occluder's footprint, is a real
    // interval, however short.
    if (pieces.length > 1)
      pieces.forEach((piece, index) => {
        if (piece.length >= minPiece) return;
        const ends = [kinds[piece.from], kinds[piece.to]];
        if (!(ends.includes('end') && ends.includes('corner'))) return;
        const neighbour = pieces[index - 1] ?? pieces[index + 1];
        if (neighbour) piece.hidden = neighbour.hidden;
      });
    let start = 0;
    for (let index = 0; index < pieces.length; index += 1) {
      const next = pieces[index + 1];
      if (next && next.hidden === pieces[index]!.hidden) continue;
      const from = pieces[start]!.from;
      const to = pieces[index]!.to;
      // A run keeps its ends and the line's own vertices; cuts merged into
      // its middle are collinear with their neighbours.
      const run: number[] = [];
      for (let p = from; p <= to; p += 1)
        if (
          p === from ||
          p === to ||
          kinds[p] === 'vertex' ||
          kinds[p] === 'end'
        )
          run.push(points[p * 3]!, points[p * 3 + 1]!, points[p * 3 + 2]!);
      emit(run, pieces[index]!.hidden, scale);
      start = index + 1;
    }
  }
  return {
    visible,
    hidden: dropCoincidentHidden(hidden, visible, span * 1e-6),
    bounds
  };
}

/**
 * Hidden lines with the stretches that lie on a visible line removed, within
 * `tolerance` model units. A box's back edges coincide with its front outline
 * in a principal view; drafting draws the visible line and omits the hidden
 * one under it. Each hidden segment loses exactly the intervals that
 * collinear visible segments cover, so a gap in the visible outline of any
 * width keeps its piece of the hidden line.
 */
/** Coincidence tolerance per unit length of the lines compared. */
const LOCAL_COINCIDENCE = 1e-6;

export function dropCoincidentHidden(
  hidden: Float64Array[],
  visible: Float64Array[],
  tolerance: number
): Float64Array[] {
  if (hidden.length === 0 || visible.length === 0) return hidden;
  const segments: number[] = [];
  for (const line of visible)
    for (let i = 2; i + 1 < line.length; i += 2)
      segments.push(line[i - 2]!, line[i - 1]!, line[i]!, line[i + 1]!);
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < segments.length; i += 2) {
    minU = Math.min(minU, segments[i]!);
    maxU = Math.max(maxU, segments[i]!);
    minV = Math.min(minV, segments[i + 1]!);
    maxV = Math.max(maxV, segments[i + 1]!);
  }
  const cells = 64;
  const cellU = Math.max((maxU - minU) / cells, tolerance, 1e-12);
  const cellV = Math.max((maxV - minV) / cells, tolerance, 1e-12);
  const clamp = (value: number) => Math.min(cells - 1, Math.max(0, value));
  // Each visible segment is filed under the cells it crosses (an exact
  // walk, like the occlusion grid), not its whole bounding box: a long
  // diagonal would otherwise land in every cell of a square. Lookups take
  // each crossed cell's neighbours, which covers the tolerance band.
  const grid = new Map<number, number[]>();
  for (let s = 0; s < segments.length; s += 4) {
    const filed = new Set(
      gridCellsAlong(
        (segments[s]! - minU) / cellU,
        (segments[s + 1]! - minV) / cellV,
        (segments[s + 2]! - minU) / cellU,
        (segments[s + 3]! - minV) / cellV,
        cells
      )
    );
    for (const key of filed) {
      const list = grid.get(key);
      if (list) list.push(s);
      else grid.set(key, [s]);
    }
  }

  /** The parts of segment p→q no collinear visible segment covers, as [t0, t1]. */
  const uncovered = (
    pu: number,
    pv: number,
    qu: number,
    qv: number
  ): [number, number][] => {
    const du = qu - pu;
    const dv = qv - pv;
    const length = Math.hypot(du, dv);
    // A point is not a line; anything longer is judged by its coverage.
    if (length === 0) return [];
    const candidates = new Set<number>();
    for (const cell of gridCellsAlong(
      (pu - minU) / cellU,
      (pv - minV) / cellV,
      (qu - minU) / cellU,
      (qv - minV) / cellV,
      cells
    )) {
      // The tolerance band can reach one cell further either side.
      const ci = cell % cells;
      const cj = Math.floor(cell / cells);
      for (let j = cj - 1; j <= cj + 1; j += 1)
        for (let i = ci - 1; i <= ci + 1; i += 1)
          for (const s of grid.get(clamp(j) * cells + clamp(i)) ?? [])
            candidates.add(s);
    }
    const covered: [number, number][] = [];
    for (const s of candidates) {
      const ends = [
        [segments[s]!, segments[s + 1]!],
        [segments[s + 2]!, segments[s + 3]!]
      ] as const;
      // Collinear: both ends of the visible segment on the hidden one's line.
      const off = ends.map(
        ([u, v]) => Math.abs((u - pu) * dv - (v - pv) * du) / length
      );
      // How close counts as the same line is the compared segments' own
      // business: a view-wide figure would let a unit-sized body's parallel
      // edges merge when another body sits far across the sheet.
      const visibleLength = Math.hypot(
        segments[s + 2]! - segments[s]!,
        segments[s + 3]! - segments[s + 1]!
      );
      // The shorter of the two sets it: a long visible line must not make a
      // short hidden edge beside it look like the same line.
      const near = Math.min(
        tolerance,
        LOCAL_COINCIDENCE * Math.min(length, visibleLength)
      );
      if (off[0]! > near || off[1]! > near) continue;
      const t = ends.map(
        ([u, v]) => ((u - pu) * du + (v - pv) * dv) / (length * length)
      );
      // Exact extent: a hidden piece that only meets a visible one end to
      // end (the same edge turning hidden) loses nothing.
      const t0 = Math.max(0, Math.min(t[0]!, t[1]!));
      const t1 = Math.min(1, Math.max(t[0]!, t[1]!));
      if (t1 > t0) covered.push([t0, t1]);
    }
    covered.sort((a, b) => a[0] - b[0]);
    const gaps: [number, number][] = [];
    let at = 0;
    for (const [t0, t1] of covered) {
      if (t0 > at) gaps.push([at, t0]);
      at = Math.max(at, t1);
    }
    if (at < 1) gaps.push([at, 1]);
    // Nothing covers it: the whole segment stays, however short.
    if (covered.length === 0) return [[0, 1]];
    // Between or beside coverage, a gap no longer than the tolerance is the
    // same line, not a gap.
    return gaps.filter(
      ([t0, t1]) =>
        (t1 - t0) * length > Math.min(tolerance, LOCAL_COINCIDENCE * length)
    );
  };

  const out: Float64Array[] = [];
  for (const line of hidden) {
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 4) out.push(Float64Array.from(run));
      run = [];
    };
    for (let i = 2; i + 1 < line.length; i += 2) {
      const pu = line[i - 2]!;
      const pv = line[i - 1]!;
      const qu = line[i]!;
      const qv = line[i + 1]!;
      for (const [t0, t1] of uncovered(pu, pv, qu, qv)) {
        const au = pu + (qu - pu) * t0;
        const av = pv + (qv - pv) * t0;
        const bu = pu + (qu - pu) * t1;
        const bv = pv + (qv - pv) * t1;
        const lastU = run.at(-2);
        const lastV = run.at(-1);
        // Continue the run across a polyline vertex; start anew after a gap.
        if (
          lastU === undefined ||
          lastV === undefined ||
          Math.hypot(lastU - au, lastV - av) > tolerance
        ) {
          flush();
          run.push(au, av);
        }
        run.push(bu, bv);
      }
    }
    flush();
  }
  return out;
}
