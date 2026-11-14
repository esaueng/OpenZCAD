/**
 * A planar face pushed outward until it runs into another part of its own
 * body: the bottom of a window pushed up to the top, the side of a slot
 * pushed across to the other side.
 *
 * Remus's `moveFaces` moves a face in place by re-limiting the faces it
 * shares an edge with, and the moment the swept face reaches any other face
 * it refuses ("swept face reaches nonadjacent face"): the topology would
 * change, which an in-place move does not do. Closing an opening is exactly
 * that change.
 *
 * Adding material by moving a face is the union of the body with the prism
 * the face sweeps, PROVIDED every neighbour that would have stretched is a
 * plane parallel to the push: those planes are then the prism's own sides,
 * so the union re-limits them exactly as the move would have. Under that
 * condition this is the same edit the kernel performs below the collision,
 * carried on past it. Where the prism leaves the body (a window pushed past
 * the top of its wall) the union is still the swept material, and the
 * strict validation decides whether the result is a solid.
 *
 * Anything outside the condition — a curved or slanted neighbour, a face
 * with holes in it, an inward (material-removing) push — is not handled
 * here and keeps the kernel's refusal.
 */
import type { Vec3 } from '@openzcad/geometry';
import { exactFuse } from './exact-boolean-refusal';
import { unifyAndRequireValidSolid } from './kernel-validation';
import type { RemusKernel } from './remus-runtime';

/** The kernel's refusal for a face that sweeps into a nonadjacent face. */
const NONADJACENT_COLLISION =
  /swept face reaches nonadjacent face|sweep may contact a nonadjacent|crosses a nonadjacent source boundary/i;

/** |cos| between a neighbour's normal and the push still read as parallel. */
const PARALLEL_TOLERANCE = 1e-7;

export function isNonadjacentFaceCollision(error: unknown): boolean {
  return error instanceof Error && NONADJACENT_COLLISION.test(error.message);
}

function unit(vector: Vec3): Vec3 | null {
  const size = Math.hypot(vector.x, vector.y, vector.z);
  return size > 1e-12 && Number.isFinite(size)
    ? { x: vector.x / size, y: vector.y / size, z: vector.z / size }
    : null;
}

/**
 * Whether pushing `face` outward along `outwardNormal` is the union of the
 * body with the face's swept prism: a plane with one boundary loop whose
 * every neighbour is a plane parallel to the push, and whose outward side
 * really is empty space.
 */
export function faceSweepsAsPrism(
  kernel: RemusKernel,
  solid: number,
  face: number,
  outwardNormal: Vec3,
  center: Vec3
): boolean {
  const direction = unit(outwardNormal);
  if (!direction) return false;
  if (kernel.getSurfaceType(face) !== 'plane') return false;
  if (kernel.getFaceWires(face).length !== 1) return false;
  const neighbours = Array.from(kernel.adjacentFaces(solid, face));
  if (neighbours.length === 0) return false;
  for (const neighbour of neighbours) {
    if (kernel.getSurfaceType(neighbour) !== 'plane') return false;
    const normal = kernel.getFaceNormal(neighbour);
    const cos =
      normal[0]! * direction.x +
      normal[1]! * direction.y +
      normal[2]! * direction.z;
    if (!Number.isFinite(cos) || Math.abs(cos) > PARALLEL_TOLERANCE) {
      return false;
    }
  }
  // The recorded normal is the outward one; a point just in front of the
  // face's centre must then lie outside the body. A non-convex face whose
  // centroid misses it fails this too, which only declines the fallback.
  const probe = Math.max(1e-4, Math.sqrt(kernel.faceArea(face, 0.1)) * 1e-4);
  try {
    return (
      kernel.classifyPoint(
        solid,
        center.x + direction.x * probe,
        center.y + direction.y * probe,
        center.z + direction.z * probe,
        probe * 1e-2
      ) === 'outside'
    );
  } catch {
    return false;
  }
}

/**
 * The body with `face` pushed `offset` outward past whatever it runs into,
 * or null when the push is not a prism union (see `faceSweepsAsPrism`) or
 * the union is not a valid exact solid. A null leaves the caller's own
 * refusal standing, which still describes the collision accurately.
 */
export function sweepFaceIntoBody(
  kernel: RemusKernel,
  solid: number,
  face: number,
  outwardNormal: Vec3,
  center: Vec3,
  offset: number
): number | null {
  if (!(offset > 0) || !Number.isFinite(offset)) return null;
  if (!faceSweepsAsPrism(kernel, solid, face, outwardNormal, center)) {
    return null;
  }
  const direction = unit(outwardNormal)!;
  try {
    const prism = kernel.extrude(
      kernel.copyFace(face),
      direction.x,
      direction.y,
      direction.z,
      offset
    );
    const fused = exactFuse(kernel, solid, prism);
    unifyAndRequireValidSolid(
      kernel,
      fused,
      'Pushing the face into the body did not produce a valid solid.'
    );
    return fused;
  } catch {
    return null;
  }
}
