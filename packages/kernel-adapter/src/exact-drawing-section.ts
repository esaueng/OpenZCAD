import type { EdgeTopology, Vector3 } from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import type { ExactShape } from './exact-types';
import { displayTessellationForExtents } from './display-tessellation';
import {
  brepEdgeCurve,
  brepEdgeDisplayRole,
  brepSmoothEdges,
  brepVertexIds
} from './exact-brep';
import { edgeToFaceMapOf } from './exact-sync-memo';
import { edgeWitnessOf } from './exact-witnesses';
import { topologyHashOfWitness } from './topology-lineage';
import {
  drawingTessellationOfShape,
  type DrawingBodyTessellation,
  type DrawingTessellationBudget
} from './exact-drawing-tessellation';

/**
 * D03 section views: one body cut by a drawing's section plane, exactly.
 *
 * The kernel's `section` gives only the cross-section, and refuses the case
 * a section view exists for most — a plane down a bore's axis ("cylindrical
 * section parallel to axis requires authoritative cap clipping", see
 * `test/exact-section.test.ts`). A section view needs more than the cap
 * anyway: everything behind the plane is drawn too. So the body is cut by a
 * half-space instead — an exact boolean with a box on the removed side —
 * and the result goes through the same canonical drawing tessellation and
 * projection as any other view. Every line of it, the cut outline included,
 * is a kernel-sampled exact edge; only the hidden-line test and the hatch
 * fill's curved boundaries are approximate, to the display tolerance, as in
 * D01.
 *
 * The cut faces — the ones lying in the plane — are named by index into the
 * canonical `faces`, so the sheet can hatch exactly them, and the cut
 * body's edges are published as edge topology so a D02 dimension can be
 * placed on the section's own edges (a bore's floor, its depth). Their
 * identities are ADR-011 hashes of the cut body: an edge the cut leaves
 * whole keeps its source hash; one it trims or creates has a new one, with
 * no lineage name, so a model edit that moves it leaves its dimension
 * broken until re-picked, never rebound.
 *
 * The pinned kernel's exact-only booleans refuse many such cuts — a plane
 * through a box's cylindrical bore is refused at most positions, measured
 * in `test/drawing-sections.test.ts`. A refused body is not dropped: it
 * comes back whole with the refusal, and the drawing cuts its tessellation
 * instead (`apps/web/src/lib/drawing/meshSection.ts`), labelled approximate.
 */

/** The cutting plane `dot(normal, p) = depth`; `dot(normal, p) < depth` is removed. */
export interface DrawingSectionPlane {
  normal: Vector3;
  depth: number;
  /**
   * D03 (v93): a stepped section. From each step's `at` along `along` (a
   * principal axis square to the normal) onward, the plane sits at that
   * step's `depth`; before the first, at `depth`. Ascending `at`.
   */
  steps?: { along: Vector3; at: number; depth: number }[];
}

export interface DrawingSectionBody extends DrawingBodyTessellation {
  /** Indices into `faces` of the faces lying in the cutting plane. */
  cutFaces: number[];
  /** The cut body's edges, for picking and resolving dimensions. */
  edgeTopology: EdgeTopology[];
  /**
   * Why the kernel could not cut this body exactly, when it could not. The
   * tessellation is then of the whole (uncut) body, with no cut faces or
   * edges: the drawing cuts it from its mesh instead, labelled approximate,
   * and its cut edges cannot be dimensioned.
   */
  approximate?: string;
}

/** Why a section cannot be drawn; the view shows the message. */
export class DrawingSectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrawingSectionError';
  }
}

const AXES = ['x', 'y', 'z'] as const;

/** The plane's normal as a principal axis and sign, or null when inclined. */
function principalAxis(
  normal: Vector3
): { axis: 0 | 1 | 2; sign: 1 | -1 } | null {
  for (const [index, key] of AXES.entries()) {
    const value = normal[key];
    if (Math.abs(Math.abs(value) - 1) < 1e-12)
      return { axis: index as 0 | 1 | 2, sign: value > 0 ? 1 : -1 };
  }
  return null;
}

/**
 * D03 free sections (v91): a box over the removed side of an inclined plane
 * (`dot(normal, p) < depth`), a margin past the solid's bounding box on
 * every side, built axis-aligned and turned into the plane's frame (normal,
 * e1, normal × e1, so the turn is proper). Null when the plane misses the
 * box: `behind` says on which side it lies.
 */
function inclinedTool(
  kernel: RemusKernel,
  box: ArrayLike<number>,
  plane: DrawingSectionPlane
): { tool: number | null; behind: boolean; ahead: boolean } {
  const length = Math.hypot(plane.normal.x, plane.normal.y, plane.normal.z);
  if (!(Math.abs(length - 1) < 1e-9))
    throw new DrawingSectionError('A section plane needs a unit normal.');
  const n: [number, number, number] = [
    plane.normal.x,
    plane.normal.y,
    plane.normal.z
  ];
  // e1: square to n, from the world axis least along it.
  const least = n
    .map((value, index) => [Math.abs(value), index] as const)
    .sort((a, b) => a[0] - b[0])[0]![1];
  const axis: [number, number, number] = [0, 0, 0];
  axis[least] = 1;
  const along = n[least]!;
  const raw: [number, number, number] = [
    axis[0] - along * n[0],
    axis[1] - along * n[1],
    axis[2] - along * n[2]
  ];
  const rawLength = Math.hypot(...raw);
  const e1 = raw.map((value) => value / rawLength) as [number, number, number];
  const e2: [number, number, number] = [
    n[1] * e1[2] - n[2] * e1[1],
    n[2] * e1[0] - n[0] * e1[2],
    n[0] * e1[1] - n[1] * e1[0]
  ];
  const corners: [number, number, number][] = [];
  for (const x of [box[0]!, box[3]!])
    for (const y of [box[1]!, box[4]!])
      for (const z of [box[2]!, box[5]!]) corners.push([x, y, z]);
  const range = (axisVector: [number, number, number]) => {
    const values = corners.map(
      (corner) =>
        corner[0] * axisVector[0] +
        corner[1] * axisVector[1] +
        corner[2] * axisVector[2]
    );
    return [Math.min(...values), Math.max(...values)] as const;
  };
  const [nLow, nHigh] = range(n);
  const span = Math.max(
    box[3]! - box[0]!,
    box[4]! - box[1]!,
    box[5]! - box[2]!,
    1e-9
  );
  const flush = span * 1e-9;
  if (nHigh <= plane.depth + flush)
    return { tool: null, behind: false, ahead: true };
  if (nLow >= plane.depth - flush)
    return { tool: null, behind: true, ahead: false };
  const margin = span;
  const [aLow, aHigh] = range(e1);
  const [bLow, bHigh] = range(e2);
  const start = nLow - margin;
  const tool = kernel.makeBox(
    plane.depth - start,
    aHigh - aLow + 2 * margin,
    bHigh - bLow + 2 * margin
  );
  const origin = [0, 1, 2].map(
    (i) => start * n[i]! + (aLow - margin) * e1[i]! + (bLow - margin) * e2[i]!
  );
  // Row-major: local x → n, y → e1, z → e2, then the corner.
  kernel.transformSolid(
    tool,
    Float64Array.of(
      n[0],
      e1[0],
      e2[0],
      origin[0]!,
      n[1],
      e1[1],
      e2[1],
      origin[1]!,
      n[2],
      e1[2],
      e2[2],
      origin[2]!,
      0,
      0,
      0,
      1
    )
  );
  return { tool, behind: false, ahead: false };
}

/** Row-major translation, the matrix layout the kernel accepts. */
function translation(x: number, y: number, z: number): Float64Array {
  return Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);
}

/**
 * The solids of `shape` that remain behind `plane`, cut exactly where it
 * crosses them. A solid wholly behind the plane is kept as it is; one wholly
 * in front of it is dropped. `cut` says whether the plane crossed any.
 */
function cutSolids(
  kernel: RemusKernel,
  shape: ExactShape,
  plane: DrawingSectionPlane
): {
  solids: number[];
  /** Behind or across the plane, uncut: what a fallback cuts from its mesh. */
  uncut: number[];
  cut: boolean;
  refusal: string | null;
} {
  const principal = principalAxis(plane.normal);
  if (plane.steps?.length) return steppedCut(kernel, shape, plane);
  const solids: number[] = [];
  const uncut: number[] = [];
  let cut = false;
  let refusal: string | null = null;
  for (const solid of shape.solids) {
    const box = kernel.boundingBox(solid);
    if (!principal) {
      const { tool, behind, ahead } = inclinedTool(kernel, box, plane);
      if (ahead) continue;
      uncut.push(solid);
      if (behind || tool === null) {
        solids.push(solid);
        continue;
      }
      cut = true;
      let result: number;
      try {
        result = kernel.cut(solid, tool);
      } catch (error) {
        refusal ??= `The kernel could not cut it exactly (${error instanceof Error ? error.message : String(error)}).`;
        continue;
      }
      if (kernel.validateSolidRelaxed(result) !== 0) {
        refusal ??= 'The kernel cut it into an invalid solid.';
        continue;
      }
      solids.push(result);
      continue;
    }
    const { axis, sign } = principal;
    const low = box[axis]!;
    const high = box[axis + 3]!;
    // Along the axis, the kept side in world coordinates.
    const nearest = sign > 0 ? low : -high;
    const farthest = sign > 0 ? high : -low;
    const span = Math.max(
      box[3]! - box[0]!,
      box[4]! - box[1]!,
      box[5]! - box[2]!,
      1e-9
    );
    // Within this of a face, the plane is flush with it: a boolean there is
    // coplanar and the "cut" would remove nothing or everything.
    const flush = span * 1e-9;
    if (farthest <= plane.depth + flush) continue;
    uncut.push(solid);
    if (nearest >= plane.depth - flush) {
      solids.push(solid);
      continue;
    }
    cut = true;
    // A box over the removed side, a margin past the solid on every side.
    const margin = span;
    const lowCorner = [box[0]! - margin, box[1]! - margin, box[2]! - margin];
    const size = [
      box[3]! - box[0]! + 2 * margin,
      box[4]! - box[1]! + 2 * margin,
      box[5]! - box[2]! + 2 * margin
    ];
    // The plane is world coordinate `sign · depth` on the axis.
    const at = sign * plane.depth;
    if (sign > 0) {
      size[axis] = at - lowCorner[axis]!;
    } else {
      lowCorner[axis] = at;
      size[axis] = box[axis + 3]! + margin - at;
    }
    const tool = kernel.makeBox(size[0]!, size[1]!, size[2]!);
    kernel.transformSolid(
      tool,
      translation(lowCorner[0]!, lowCorner[1]!, lowCorner[2]!)
    );
    let result: number;
    try {
      result = kernel.cut(solid, tool);
    } catch (error) {
      refusal ??= `The kernel could not cut it exactly (${error instanceof Error ? error.message : String(error)}).`;
      continue;
    }
    if (kernel.validateSolidRelaxed(result) !== 0) {
      refusal ??= 'The kernel cut it into an invalid solid.';
      continue;
    }
    solids.push(result);
  }
  return { solids, uncut, cut, refusal };
}

/**
 * D03 (v93): the solids of `shape` behind a stepped section's planes. Each
 * segment of the line removes its own strip: an axis-aligned box over the
 * part in front of its depth, between its two steps along the line. At a
 * step the shallower strip's box runs on past it (what it removes there the
 * deeper one removes anyway), so the deeper box alone makes the jog face and
 * no two tool faces meet on the part. A refused cut refuses the view: a
 * stepped section has no single plane for the mesh fallback to clip by.
 */
function steppedCut(
  kernel: RemusKernel,
  shape: ExactShape,
  plane: DrawingSectionPlane
): ReturnType<typeof cutSolids> {
  const normal = principalAxis(plane.normal);
  const steps = plane.steps!;
  const lateral = principalAxis(steps[0]!.along);
  if (
    !normal ||
    !lateral ||
    lateral.axis === normal.axis ||
    steps.some((step) => principalAxis(step.along)?.axis !== lateral.axis)
  )
    throw new DrawingSectionError(
      'A stepped section needs a principal plane and a line along a principal axis.'
    );
  // Segments as [from, to) along the lateral axis (in its signed sense)
  // with their depths.
  const segments: { from: number; to: number; depth: number }[] = [];
  let from = -Infinity;
  let depth = plane.depth;
  for (const step of steps) {
    segments.push({ from, to: step.at, depth });
    from = step.at;
    depth = step.depth;
  }
  segments.push({ from, to: Infinity, depth });
  const solids: number[] = [];
  const uncut: number[] = [];
  let cut = false;
  for (const solid of shape.solids) {
    const box = kernel.boundingBox(solid);
    const span = Math.max(
      box[3]! - box[0]!,
      box[4]! - box[1]!,
      box[5]! - box[2]!,
      1e-9
    );
    const margin = span;
    const flush = span * 1e-9;
    // A coordinate's range on an axis in its signed sense.
    const range = (axis: 0 | 1 | 2, sign: 1 | -1) =>
      sign > 0
        ? ([box[axis]!, box[axis + 3]!] as const)
        : ([-box[axis + 3]!, -box[axis]!] as const);
    const [nLow, nHigh] = range(normal.axis, normal.sign);
    const [lLow, lHigh] = range(lateral.axis, lateral.sign);
    // Wholly in front of every segment's plane that reaches it: dropped.
    const reached = segments.filter(
      (segment) => segment.to > lLow && segment.from < lHigh
    );
    if (reached.every((segment) => nHigh <= segment.depth + flush)) continue;
    uncut.push(solid);
    let current = solid;
    let touched = false;
    for (const [index, segment] of segments.entries()) {
      if (!(segment.to > lLow && segment.from < lHigh)) continue;
      if (nLow >= segment.depth - flush) continue;
      // Past a step into a deeper neighbour, this strip runs on into it,
      // but never through it: half its run at most (a margin into an
      // endless one), so it never reaches a step beyond. Into a shallower
      // neighbour it stops at the step.
      const before = segments[index - 1];
      const after = segments[index + 1];
      const into = (neighbour: { from: number; to: number }) =>
        Math.min(margin, (neighbour.to - neighbour.from) / 2);
      const start =
        before && before.depth >= segment.depth
          ? segment.from - into(before)
          : Math.max(segment.from, lLow - margin);
      const end =
        after && after.depth >= segment.depth
          ? segment.to + into(after)
          : Math.min(segment.to, lHigh + margin);
      const low = [box[0]! - margin, box[1]! - margin, box[2]! - margin];
      const high = [box[3]! + margin, box[4]! + margin, box[5]! + margin];
      // Signed ranges back to world coordinates on each axis.
      const place = (axis: 0 | 1 | 2, sign: 1 | -1, a: number, b: number) => {
        if (sign > 0) {
          low[axis] = a;
          high[axis] = b;
        } else {
          low[axis] = -b;
          high[axis] = -a;
        }
      };
      place(normal.axis, normal.sign, nLow - margin, segment.depth);
      place(
        lateral.axis,
        lateral.sign,
        Number.isFinite(start) ? start : lLow - margin,
        Number.isFinite(end) ? end : lHigh + margin
      );
      const tool = kernel.makeBox(
        high[0]! - low[0]!,
        high[1]! - low[1]!,
        high[2]! - low[2]!
      );
      kernel.transformSolid(tool, translation(low[0]!, low[1]!, low[2]!));
      let result: number;
      try {
        result = kernel.cut(current, tool);
      } catch (error) {
        throw new DrawingSectionError(
          `The kernel could not cut this stepped section exactly (${error instanceof Error ? error.message : String(error)}).`
        );
      }
      if (kernel.validateSolidRelaxed(result) !== 0)
        throw new DrawingSectionError(
          'The kernel cut this stepped section into an invalid solid.'
        );
      current = result;
      touched = true;
    }
    if (touched) cut = true;
    solids.push(current);
  }
  return { solids, uncut, cut, refusal: null };
}

/** The edges of `solids` as edge topology, numbered like a body's. */
function sectionEdgeTopology(
  kernel: RemusKernel,
  solids: readonly number[]
): EdgeTopology[] {
  const out: EdgeTopology[] = [];
  let nextVertexId = 0;
  for (const solid of solids) {
    const box = kernel.boundingBox(solid);
    const tess = displayTessellationForExtents(
      box[3]! - box[0]!,
      box[4]! - box[1]!,
      box[5]! - box[2]!
    );
    const vertexIdByHandle = new Map<number, number>();
    for (const vertex of kernel.getSolidVertices(solid))
      if (!vertexIdByHandle.has(vertex))
        vertexIdByHandle.set(vertex, nextVertexId++);
    const edgeToFaces = edgeToFaceMapOf(kernel, solid);
    const smoothEdges = brepSmoothEdges(kernel, solid);
    const handles = Array.from(kernel.getSolidEdges(solid));
    const lines = kernel.meshEdgesAll(
      solid,
      tess.linearDeflection,
      tess.angularDeflection
    );
    try {
      const positions = Array.from(lines.positions);
      const offsets = [...Array.from(lines.offsets), positions.length];
      if (handles.length !== lines.edgeCount)
        throw new DrawingSectionError(
          'The section edges did not sample consistently.'
        );
      for (const [index, edge] of handles.entries()) {
        const points = positions.slice(offsets[index], offsets[index + 1]);
        const hash = topologyHashOfWitness('edge', edgeWitnessOf(kernel, edge));
        out.push({
          topologyId: `edge:${hash}`,
          hash,
          length: kernel.edgeLength(edge),
          displayRole: brepEdgeDisplayRole(
            kernel,
            edge,
            edgeToFaces,
            smoothEdges?.has(edge)
          ),
          curve: brepEdgeCurve(kernel, edge, points),
          vertexIds: brepVertexIds(
            edge,
            kernel.getEdgeVertexHandles(edge),
            vertexIdByHandle
          ),
          points
        });
      }
    } finally {
      lines.free();
    }
  }
  return out;
}

/**
 * Faces of a canonical tessellation lying in the plane: every corner within
 * a float32-scale tolerance of it.
 */
function facesInPlane(
  mesh: DrawingBodyTessellation,
  plane: DrawingSectionPlane
): number[] {
  const { vertices, indices } = mesh;
  const n = plane.normal;
  let extent = 1;
  for (const value of vertices) extent = Math.max(extent, Math.abs(value));
  const tolerance = extent * 1e-6;
  const out: number[] = [];
  mesh.faces.forEach((face, index) => {
    for (
      let t = face.triangleStart * 3;
      t < (face.triangleStart + face.triangleCount) * 3;
      t += 1
    ) {
      const v = indices[t]! * 3;
      const d =
        n.x * vertices[v]! + n.y * vertices[v + 1]! + n.z * vertices[v + 2]!;
      if (Math.abs(d - plane.depth) > tolerance) return;
    }
    if (face.triangleCount > 0) out.push(index);
  });
  return out;
}

/** Whether a sampled edge lies wholly in one step's jog plane. */
function onStep(
  edge: ArrayLike<number>,
  steps: NonNullable<DrawingSectionPlane['steps']>
): boolean {
  let extent = 1;
  for (let i = 0; i < edge.length; i += 1)
    extent = Math.max(extent, Math.abs(edge[i]!));
  const tolerance = extent * 1e-6;
  return steps.some((step) => {
    const a = step.along;
    for (let i = 0; i + 2 < edge.length; i += 3) {
      const at = a.x * edge[i]! + a.y * edge[i + 1]! + a.z * edge[i + 2]!;
      if (Math.abs(at - step.at) > tolerance) return false;
    }
    return edge.length >= 6;
  });
}

/**
 * One body behind a section plane: its canonical drawing tessellation, the
 * faces the plane cut and the edges a dimension can use. Null when the body
 * lies wholly in front of the plane. A body the kernel refuses to cut
 * comes back whole, with the refusal in `approximate`, for the drawing to
 * cut from its mesh.
 */
export function drawingSectionOfShape(
  kernel: RemusKernel,
  shape: ExactShape,
  plane: DrawingSectionPlane,
  budget?: DrawingTessellationBudget
): (DrawingSectionBody & { cut: boolean }) | null {
  if (!shape.solids.length) throw new Error('Exact body contains no solids.');
  const kept = cutSolids(kernel, shape, plane);
  if (kept.refusal !== null) {
    // Every solid the plane reaches, whole: the drawing cuts the mesh.
    return {
      ...drawingTessellationOfShape(kernel, { solids: kept.uncut }, budget),
      cutFaces: [],
      edgeTopology: [],
      approximate: kept.refusal,
      cut: true
    };
  }
  if (kept.solids.length === 0) return null;
  const mesh = drawingTessellationOfShape(
    kernel,
    { solids: kept.solids },
    budget
  );
  const steps = plane.steps ?? [];
  const planes = [
    plane,
    ...steps.map((step) => ({ ...plane, depth: step.depth }))
  ];
  const cutFaces = kept.cut
    ? [...new Set(planes.flatMap((entry) => facesInPlane(mesh, entry)))].sort(
        (a, b) => a - b
      )
    : [];
  return {
    ...mesh,
    // D03 (v93): a stepped section draws no line where it steps (the jog
    // faces are seen edge-on): edges lying wholly in a step's plane go.
    ...(steps.length > 0
      ? { edges: mesh.edges.filter((edge) => !onStep(edge, steps)) }
      : {}),
    cutFaces,
    edgeTopology: sectionEdgeTopology(kernel, kept.solids),
    cut: kept.cut
  };
}
