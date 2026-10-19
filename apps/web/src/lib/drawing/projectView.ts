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
 *   the edge of a triangle it passes over; between two such crossings the
 *   same triangles cover it, so each piece is classified once, at its middle:
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

/** Cosine of the largest dihedral still treated as a smooth surface. */
const SMOOTH_DIHEDRAL_COS = Math.cos((50 * Math.PI) / 180);

interface Triangle {
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

class OcclusionGrid {
  private readonly cells: number[][];
  private readonly size: number;
  private readonly minU: number;
  private readonly minV: number;
  private readonly cellU: number;
  private readonly cellV: number;

  constructor(
    private readonly triangles: Triangle[],
    bounds: { minU: number; minV: number; maxU: number; maxV: number },
    private readonly depthTolerance: number,
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
    triangles.forEach((triangle, index) => {
      const i0 = this.column(Math.min(triangle.u0, triangle.u1, triangle.u2));
      const i1 = this.column(Math.max(triangle.u0, triangle.u1, triangle.u2));
      const j0 = this.row(Math.min(triangle.v0, triangle.v1, triangle.v2));
      const j1 = this.row(Math.max(triangle.v0, triangle.v1, triangle.v2));
      for (let j = j0; j <= j1; j += 1)
        for (let i = i0; i <= i1; i += 1)
          this.cells[j * this.size + i]!.push(index);
    });
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
   * it passes over, sorted. Between two of them every point is covered by
   * the same triangles, so visibility is constant there.
   */
  crossings(au: number, av: number, bu: number, bv: number): number[] {
    const du = bu - au;
    const dv = bv - av;
    // Every cell the segment passes through, by an exact supercover walk:
    // triangles are bucketed by their bounding boxes, so a triangle the
    // segment crosses is in one of these cells.
    const seen = new Set<number>();
    for (const cell of this.cellsAlong(au, av, bu, bv))
      for (const index of this.cells[cell]!) seen.add(index);
    const out: number[] = [];
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
        if (s > 0 && s < 1 && r >= 0 && r <= 1) out.push(s);
      }
    }
    return out.sort((a, b) => a - b);
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
      if (surface < depth - this.depthTolerance) return true;
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

interface Polyline3 {
  points: number[];
}

/**
 * The silhouette polylines of one body's curved surfaces, as world points.
 * Exported for tests.
 */
export function bodySilhouettes(
  body: ProjectionBodyInput,
  frame: DrawingViewFrame,
  weldQuantum: number
): Polyline3[] {
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
  const facing = new Int8Array(triangleCount);
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
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const length = Math.hypot(nx, ny, nz);
    if (length === 0) continue;
    nx /= length;
    ny /= length;
    nz /= length;
    normals[t * 3] = nx;
    normals[t * 3 + 1] = ny;
    normals[t * 3 + 2] = nz;
    // A facet seen exactly edge-on counts as facing away. A cylinder whose
    // silhouette falls mid-facet then outlines at that facet's front edge,
    // half a facet off the true curve; a wall seen along its axis (all of it
    // edge-on) meets its caps at sharp creases, which are never silhouettes.
    facing[t] = dot(frame.direction, nx, ny, nz) < -1e-12 ? 1 : -1;
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
  const segments: [number, number][] = [];
  for (const [key, list] of edgeTriangles) {
    if (list.length !== 2) continue;
    const [p, q] = list as [number, number];
    if (facing[p] === facing[q]) continue;
    const sameFace = faceOf[p] !== -1 && faceOf[p] === faceOf[q];
    const cosine =
      normals[p * 3]! * normals[q * 3]! +
      normals[p * 3 + 1]! * normals[q * 3 + 1]! +
      normals[p * 3 + 2]! * normals[q * 3 + 2]!;
    // A sharp crease between two faces is a feature edge, drawn already.
    if (!sameFace && cosine < SMOOTH_DIHEDRAL_COS) continue;
    segments.push([Math.floor(key / vertexCount), key % vertexCount]);
  }
  return chainSegments(segments).map((chain) => ({
    points: chain.flatMap((id) => [
      positions[id * 3]!,
      positions[id * 3 + 1]!,
      positions[id * 3 + 2]!
    ])
  }));
}

/** Projects the bodies of one view into visible and hidden polylines. */
export function projectView(input: ViewProjectionInput): ViewProjection {
  const frame = DRAWING_VIEW_FRAMES[input.orientation];
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const body of input.bodies)
    for (let i = 0; i < body.vertices.length; i += 3)
      for (let k = 0; k < 3; k += 1) {
        const value = body.vertices[i + k]!;
        if (value < min[k]!) min[k] = value;
        if (value > max[k]!) max[k] = value;
      }
  if (!Number.isFinite(min[0]!)) {
    min = [0, 0, 0];
    max = [0, 0, 0];
  }
  const diagonal = Math.max(
    Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!),
    1e-9
  );
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
  for (const body of input.bodies) {
    const { vertices, indices } = body;
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
      // Edge-on triangles cover no area and cannot hide anything.
      if (Math.abs(area) <= diagonal * diagonal * 1e-14) continue;
      triangles.push({ u0, v0, d0, u1, v1, d1, u2, v2, d2, area });
    }
  }

  const lines: number[][] = [];
  for (const body of input.bodies) {
    for (const edge of body.edges) lines.push(Array.from(edge));
    for (const silhouette of bodySilhouettes(body, frame, diagonal * 1e-7))
      lines.push(silhouette.points);
  }
  for (const line of lines)
    for (let i = 0; i + 2 < line.length; i += 3) {
      const [u, v] = project(line[i]!, line[i + 1]!, line[i + 2]!);
      bounds.minU = Math.min(bounds.minU, u);
      bounds.maxU = Math.max(bounds.maxU, u);
      bounds.minV = Math.min(bounds.minV, v);
      bounds.maxV = Math.max(bounds.maxV, v);
    }
  if (!Number.isFinite(bounds.minU))
    return { visible: [], hidden: [], bounds: null };

  const grid = new OcclusionGrid(
    triangles,
    bounds,
    // Display triangles sit within their chordal deflection of the exact
    // surface the edge samples lie on; a few parts in ten thousand of the
    // part's size clears that without letting a real wall through.
    diagonal * 5e-4,
    1e-9
  );
  const hiddenAt = (x: number, y: number, z: number): boolean => {
    const [u, v, d] = project(x, y, z);
    return grid.occluded(u, v, d);
  };

  const visible: Float64Array[] = [];
  const hidden: Float64Array[] = [];
  const emit = (points: number[], isHidden: boolean) => {
    if (points.length < 6) return;
    let length = 0;
    for (let i = 3; i < points.length; i += 3)
      length += Math.hypot(
        points[i]! - points[i - 3]!,
        points[i + 1]! - points[i - 2]!,
        points[i + 2]! - points[i - 1]!
      );
    if (length <= diagonal * 1e-9) return;
    if (isHidden && !input.hiddenLines) return;
    const flat = new Float64Array((points.length / 3) * 2);
    let span = 0;
    for (let i = 0, j = 0; i < points.length; i += 3, j += 2) {
      const [u, v] = project(points[i]!, points[i + 1]!, points[i + 2]!);
      flat[j] = u;
      flat[j + 1] = v;
      if (j > 0) span += Math.hypot(u - flat[j - 2]!, v - flat[j - 1]!);
    }
    // An edge running along the view direction projects to a point.
    if (span <= diagonal * 1e-9) return;
    (isHidden ? hidden : visible).push(flat);
  };

  for (const line of lines) {
    const count = Math.floor(line.length / 3);
    if (count < 2) continue;
    const point = (index: number, f: number) => [
      line[index * 3]! + (line[index * 3 + 3]! - line[index * 3]!) * f,
      line[index * 3 + 1]! + (line[index * 3 + 4]! - line[index * 3 + 1]!) * f,
      line[index * 3 + 2]! + (line[index * 3 + 5]! - line[index * 3 + 2]!) * f
    ];
    let run: number[] = [line[0]!, line[1]!, line[2]!];
    let state: boolean | null = null;
    for (let s = 0; s < count - 1; s += 1) {
      // Visibility can change only where the projected segment crosses an
      // occluding triangle's edge, so those crossings split it exactly and
      // each piece is classified once, however narrow the occluder.
      const [au, av] = project(
        line[s * 3]!,
        line[s * 3 + 1]!,
        line[s * 3 + 2]!
      );
      const [bu, bv] = project(
        line[s * 3 + 3]!,
        line[s * 3 + 4]!,
        line[s * 3 + 5]!
      );
      const cuts = [0, ...grid.crossings(au, av, bu, bv), 1];
      for (let k = 0; k + 1 < cuts.length; k += 1) {
        const t0 = cuts[k]!;
        const t1 = cuts[k + 1]!;
        if (t1 - t0 <= 1e-12) continue;
        const [x, y, z] = point(s, (t0 + t1) / 2);
        const hidden = hiddenAt(x!, y!, z!);
        if (state !== null && hidden !== state) {
          const [cx, cy, cz] = point(s, t0);
          run.push(cx!, cy!, cz!);
          emit(run, state);
          run = [cx!, cy!, cz!];
        }
        state = hidden;
      }
      run.push(line[s * 3 + 3]!, line[s * 3 + 4]!, line[s * 3 + 5]!);
    }
    if (state !== null) emit(run, state);
  }
  return {
    visible,
    hidden: dropCoincidentHidden(hidden, visible, diagonal * 1e-6),
    bounds
  };
}

/**
 * Hidden runs that lie entirely on a visible line, within `tolerance` model
 * units. A box's back edges coincide with its front outline in a principal
 * view; drafting draws the visible line and omits the hidden one under it.
 */
function dropCoincidentHidden(
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
  const grid = new Map<number, number[]>();
  for (let s = 0; s < segments.length; s += 4) {
    const i0 = clamp(
      Math.floor(
        (Math.min(segments[s]!, segments[s + 2]!) - tolerance - minU) / cellU
      )
    );
    const i1 = clamp(
      Math.floor(
        (Math.max(segments[s]!, segments[s + 2]!) + tolerance - minU) / cellU
      )
    );
    const j0 = clamp(
      Math.floor(
        (Math.min(segments[s + 1]!, segments[s + 3]!) - tolerance - minV) /
          cellV
      )
    );
    const j1 = clamp(
      Math.floor(
        (Math.max(segments[s + 1]!, segments[s + 3]!) + tolerance - minV) /
          cellV
      )
    );
    for (let j = j0; j <= j1; j += 1)
      for (let i = i0; i <= i1; i += 1) {
        const key = j * cells + i;
        const list = grid.get(key);
        if (list) list.push(s);
        else grid.set(key, [s]);
      }
  }
  const onVisible = (u: number, v: number): boolean => {
    if (
      u < minU - tolerance ||
      u > maxU + tolerance ||
      v < minV - tolerance ||
      v > maxV + tolerance
    )
      return false;
    const key =
      clamp(Math.floor((v - minV) / cellV)) * cells +
      clamp(Math.floor((u - minU) / cellU));
    for (const s of grid.get(key) ?? []) {
      const au = segments[s]!;
      const av = segments[s + 1]!;
      const du = segments[s + 2]! - au;
      const dv = segments[s + 3]! - av;
      const lengthSq = du * du + dv * dv;
      const t =
        lengthSq === 0
          ? 0
          : Math.min(
              1,
              Math.max(0, ((u - au) * du + (v - av) * dv) / lengthSq)
            );
      if (Math.hypot(u - (au + du * t), v - (av + dv * t)) <= tolerance)
        return true;
    }
    return false;
  };
  return hidden.filter((line) => {
    for (let i = 0; i + 1 < line.length; i += 2) {
      if (!onVisible(line[i]!, line[i + 1]!)) return true;
      if (i + 3 < line.length) {
        // The middle of each segment too: two ends on an outline can still
        // span a gap in it.
        for (const f of [0.25, 0.5, 0.75])
          if (
            !onVisible(
              line[i]! + (line[i + 2]! - line[i]!) * f,
              line[i + 1]! + (line[i + 3]! - line[i + 1]!) * f
            )
          )
            return true;
      }
    }
    return false;
  });
}
