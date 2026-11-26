/**
 * Why the kernel refused a Split by plane, as a cause code the copy can
 * branch on (M11, K10).
 *
 * The pinned Remus `split` has no typed twin, and when no edge of the body
 * reaches across the plane its two refusals say too little on their own:
 *
 * - `invalid_input` ("cutting plane does not split the solid (entirely on
 *   one side)"). The kernel decides "one side" from the body's EDGES alone
 *   (`plane_contact` in `split.rs`), so a curved face that bows across the
 *   plane between edges clear of it reads the same as a real miss: an R5
 *   sphere cut at z = 1 is refused this way, as z = 6 is.
 * - `unsupported` ("… it only touches the body and contains edge N …"). The
 *   same refusal whether the plane lies along a lone edge or flat on a face:
 *   the kernel stops at the first edge it finds in the plane, and every
 *   boundary edge of a face in the plane is one.
 *
 * So the adapter reads no kernel prose here. It takes the category
 * `remus-operation-refusal.ts` already derived and states a cause only where
 * the target's exact B-rep proves it, from each face's surface type and
 * analytic plane and the kernel's vertex positions, never the display mesh.
 * A proof needs the body to be one closed shell of analytic planes, so that
 * it lies in the hull of its vertices; any other body gets no cause, and
 * the copy then claims none.
 *
 * - `plane_misses_body` (`invalid_input`): every vertex is on one side,
 *   within the kernel's slack, so a corner touch counts.
 * - `plane_on_face` (`unsupported`): the body is on one side, and a face
 *   lies wholly in the plane. Every vertex of it is within the slack and
 *   its normal matches the plane's to {@link SAME_NORMAL}, so no point of it
 *   strays further either.
 * - `plane_on_edge` (`unsupported`): the body is on one side, at least two
 *   vertices lie in the plane, and no face does: each has a vertex beyond the
 *   slack.
 */
import type { Vector3 } from '@openzcad/shared';

import { readFacePlaneFrame } from './exact-face-plane-frame';
import type { KernelRefusalCategory } from './kernel-refusal';
import type { RemusKernel } from './remus-runtime';

/** The cause codes a refused Split carries on `kernelRefusal.reason`. */
export type SplitRefusalReason =
  'plane_misses_body' | 'plane_on_face' | 'plane_on_edge';

/**
 * The kernel's own "on the plane" slack, as `split.rs` computes it:
 * `tol.linear.max(model_span * tol.relative)`, with the default `Tolerance`
 * (linear 1e-7, relative 1e-10) and `model_span` the diagonal of the box
 * around every edge endpoint of the outer shell.
 */
const KERNEL_LINEAR = 1e-7;
const KERNEL_RELATIVE = 1e-10;

/**
 * How closely a face's unit normal must match the plane's (‖n − ±n_f‖) for
 * its vertices to speak for all of it. The tilt moves a point at distance L
 * from a vertex by at most L·1e-12 off the plane: under the kernel's 1e-7
 * floor for any face shorter than 100 km. A face plane picked or typed from
 * the face matches exactly; a plane a hair off it, which could leave part of
 * the face beyond the slack, is left unclassified rather than guessed.
 */
const SAME_NORMAL = 1e-12;

interface FaceRead {
  surfaceType: string;
  normal?: Vector3;
  /** Vertex handles, which the faces around a vertex share. */
  vertices: number[];
}

function readFaces(kernel: RemusKernel, solid: number): FaceRead[] {
  return Array.from(kernel.getSolidFaces(solid), (face) => {
    const frame = readFacePlaneFrame(kernel, face);
    return {
      surfaceType: frame.surfaceType,
      ...(frame.normal ? { normal: frame.normal } : {}),
      vertices: Array.from(kernel.getFaceVertices(face))
    };
  });
}

function kernelSlack(points: Iterable<Vector3>): number {
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    lo.x = Math.min(lo.x, p.x);
    lo.y = Math.min(lo.y, p.y);
    lo.z = Math.min(lo.z, p.z);
    hi.x = Math.max(hi.x, p.x);
    hi.y = Math.max(hi.y, p.y);
    hi.z = Math.max(hi.z, p.z);
  }
  const span =
    hi.x >= lo.x ? Math.hypot(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z) : 0;
  return Math.max(KERNEL_LINEAR, span * KERNEL_RELATIVE);
}

/**
 * The cause of a refused split of `category`, or undefined when the exact
 * geometry cannot prove one.
 */
export function splitRefusalReason(
  kernel: RemusKernel,
  solid: number,
  planePoint: Vector3,
  planeNormal: Vector3,
  category: KernelRefusalCategory
): SplitRefusalReason | undefined {
  if (category !== 'invalid_input' && category !== 'unsupported') {
    return undefined;
  }
  const length = Math.hypot(planeNormal.x, planeNormal.y, planeNormal.z);
  if (!(length > 0)) return undefined;
  const n = {
    x: planeNormal.x / length,
    y: planeNormal.y / length,
    z: planeNormal.z / length
  };
  const d = n.x * planePoint.x + n.y * planePoint.y + n.z * planePoint.z;
  let faces: FaceRead[];
  const positions = new Map<number, Vector3>();
  try {
    // A cavity is refused before any contact test; it has no cause here.
    if (kernel.getSolidShells(solid).length !== 1) return undefined;
    faces = readFaces(kernel, solid);
    for (const face of faces) {
      for (const vertex of face.vertices) {
        if (positions.has(vertex)) continue;
        const p = kernel.getVertexPosition(vertex);
        positions.set(vertex, { x: p[0]!, y: p[1]!, z: p[2]! });
      }
    }
  } catch {
    // A face that cannot be read leaves the cause unknown, never guessed.
    return undefined;
  }
  // Only a body of analytic planes lies in the hull of its vertices.
  if (
    faces.length === 0 ||
    !faces.every(
      (face) =>
        face.surfaceType === 'plane' && face.normal && face.vertices.length > 0
    )
  ) {
    return undefined;
  }
  const eps = kernelSlack(positions.values());
  const side = new Map<number, number>();
  for (const [vertex, p] of positions) {
    side.set(vertex, n.x * p.x + n.y * p.y + n.z * p.z - d);
  }
  const distances = [...side.values()];
  const oneSided =
    distances.every((distance) => distance >= -eps) ||
    distances.every((distance) => distance <= eps);
  if (!oneSided) return undefined;
  if (category === 'invalid_input') return 'plane_misses_body';

  let unknown = false;
  for (const face of faces) {
    // A vertex beyond the slack is a point of the face off the plane.
    if (face.vertices.some((vertex) => Math.abs(side.get(vertex)!) > eps)) {
      continue;
    }
    const normal = face.normal!;
    const sign = normal.x * n.x + normal.y * n.y + normal.z * n.z < 0 ? -1 : 1;
    const tilt = Math.hypot(
      n.x - sign * normal.x,
      n.y - sign * normal.y,
      n.z - sign * normal.z
    );
    if (tilt <= SAME_NORMAL) return 'plane_on_face';
    // Every vertex on the plane, but tilted off it: part of the face may
    // stand beyond the slack.
    unknown = true;
  }
  if (unknown) return undefined;
  const onPlane = distances.filter((distance) => Math.abs(distance) <= eps);
  return onPlane.length >= 2 ? 'plane_on_edge' : undefined;
}
