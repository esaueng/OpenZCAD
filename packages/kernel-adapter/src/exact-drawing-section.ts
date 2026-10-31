import type { EdgeTopology, Vector3 } from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import type { ExactShape } from './exact-types';
import { displayTessellationForExtents } from './display-tessellation';
import {
  brepEdgeCurve,
  brepEdgeDisplayRole,
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

/** The plane's normal as a principal axis and sign: views are principal. */
function principalAxis(normal: Vector3): { axis: 0 | 1 | 2; sign: 1 | -1 } {
  for (const [index, key] of AXES.entries()) {
    const value = normal[key];
    if (Math.abs(Math.abs(value) - 1) < 1e-12)
      return { axis: index as 0 | 1 | 2, sign: value > 0 ? 1 : -1 };
  }
  throw new DrawingSectionError(
    'A section plane must be normal to a principal axis.'
  );
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
  const { axis, sign } = principalAxis(plane.normal);
  const solids: number[] = [];
  const uncut: number[] = [];
  let cut = false;
  let refusal: string | null = null;
  for (const solid of shape.solids) {
    const box = kernel.boundingBox(solid);
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
          displayRole: brepEdgeDisplayRole(kernel, edge, edgeToFaces),
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
  return {
    ...mesh,
    cutFaces: kept.cut ? facesInPlane(mesh, plane) : [],
    edgeTopology: sectionEdgeTopology(kernel, kept.solids),
    cut: kept.cut
  };
}
