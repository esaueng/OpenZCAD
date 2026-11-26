/**
 * Why the kernel refused a Split by plane, as a cause code the copy can
 * branch on (M11, K10).
 *
 * The pinned Remus `split` has no typed twin: it throws one of two prose
 * forms when no edge of the body reaches across the plane.
 *
 * - `invalid input: cutting plane does not split the solid (entirely on one
 *   side)` — the plane misses the body, or meets it at a single vertex.
 * - `split: unsupported configuration: the cutting plane does not cross the
 *   solid's interior; it only touches the body and contains edge N of the
 *   solid, so there is nothing to split` — the plane touches the body along
 *   an edge.
 *
 * The second form is the same text whether the plane lies along a lone edge
 * or flat on one of the body's faces: the kernel stops at the first edge it
 * finds in the plane, and every boundary edge of a face in the plane is one.
 * Those two cases want different advice, so the adapter answers the question
 * the kernel does not: does an exact planar face of the target lie in the
 * cutting plane? It reads each face's analytic normal and plane equation —
 * the kernel's exact surface, never the display mesh — and says nothing when
 * a face it cannot read (a freeform surface, or a NURBS-backed plane with no
 * analytic normal) could be the one.
 */
import type { Vector3 } from '@openzcad/shared';

import { readFacePlaneFrame } from './exact-face-plane-frame';
import type { RemusKernel } from './remus-runtime';

/** The cause codes a refused Split carries on `kernelRefusal.reason`. */
export type SplitRefusalReason =
  'plane_misses_body' | 'plane_on_face' | 'plane_on_edge';

/** Analytic surfaces that cannot lie in a plane. */
const CURVED_ANALYTIC = new Set(['cylinder', 'cone', 'sphere', 'torus']);

/**
 * Parallel faces of a real body lie a feature size apart, so this only needs
 * to admit every plane the kernel's own "touches" test admitted
 * (`max(1e-7, span·1e-10)` in Remus `split.rs`): the plane's offset from a
 * face it lies on is within that slack.
 */
const PARALLEL = 1 - 1e-9;
function onPlaneSlack(scale: number): number {
  return Math.max(1e-6, 1e-9 * scale);
}

/**
 * The cause of a refused split, or undefined when the kernel's text is not
 * one of the forms above or the contact cannot be told apart.
 */
export function splitRefusalReason(
  kernel: RemusKernel,
  solid: number,
  planePoint: Vector3,
  planeNormal: Vector3,
  kernelMessage: string
): SplitRefusalReason | undefined {
  if (/\bcutting plane does not split the solid\b/.test(kernelMessage)) {
    return 'plane_misses_body';
  }
  if (
    !/\bcutting plane does not cross the solid's interior\b/.test(kernelMessage)
  ) {
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
  try {
    let unreadable = false;
    for (const face of kernel.getSolidFaces(solid)) {
      const frame = readFacePlaneFrame(kernel, face);
      if (frame.surfaceType !== 'plane') {
        if (!CURVED_ANALYTIC.has(frame.surfaceType)) unreadable = true;
        continue;
      }
      if (!frame.normal) {
        unreadable = true;
        continue;
      }
      const facing =
        frame.normal.x * n.x + frame.normal.y * n.y + frame.normal.z * n.z;
      if (Math.abs(facing) < PARALLEL) continue;
      const { center } = frame;
      const offset = n.x * center.x + n.y * center.y + n.z * center.z - d;
      const scale = Math.max(
        Math.abs(d),
        Math.abs(center.x),
        Math.abs(center.y),
        Math.abs(center.z)
      );
      if (Math.abs(offset) <= onPlaneSlack(scale)) return 'plane_on_face';
    }
    return unreadable ? undefined : 'plane_on_edge';
  } catch {
    // A face that cannot be read leaves the contact unknown, never guessed.
    return undefined;
  }
}
