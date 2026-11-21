import type { BodyTopology, FaceTopology } from '@openzcad/shared';
import { supportsBlendGroupEdits, supportsShoulderRise } from '../kernelBuild';

/**
 * Whether a drag of an upward planar face moves it as a local face offset,
 * so the kernel's sampled shoulder join can merge a boss's rounds. A
 * dimension edit replays history instead, and the later fillets cannot
 * round the joined shape.
 *
 * - Lowering a boss cap (bounded only by circles) into the concave shoulder
 *   round at its foot.
 * - Raising the block top around that shoulder into the boss's rim round.
 *   The top meets the shoulder along a circle. The shoulder is concave, so
 *   its torus centre stands above the top; a boss cap's convex rim has its
 *   centre below the cap, and a rising cap keeps its height edit. This needs
 *   a newer kernel (`supportsShoulderRise`).
 *
 * Either needs a body with both torus and cylinder blend faces.
 */
export function sampledShoulderMove(
  topology: BodyTopology | undefined,
  face: FaceTopology,
  offset: number,
  kernelVersion: string
): boolean {
  if (!topology || (face.geometry?.normal?.z ?? 0) <= 0.999) return false;
  const boundary = topology.edges.filter((e) =>
    e.adjacentFaceHashes?.includes(face.hash)
  );
  if (boundary.length === 0) return false;
  const blend = (surface: string) =>
    topology.faces.some(
      (f) =>
        f.geometry?.surfaceType === surface &&
        f.geometry.featureType === 'blend'
    );
  if (!blend('torus') || !blend('cylinder')) return false;
  if (offset < 0)
    return (
      supportsBlendGroupEdits(kernelVersion) &&
      boundary.every((e) => e.curve?.type === 'CIRCLE')
    );
  if (offset === 0 || !supportsShoulderRise(kernelVersion)) return false;
  const level = face.geometry!.center.z;
  const shoulders = new Set(
    topology.faces
      .filter((f) => {
        const g = f.geometry;
        return (
          g?.surfaceType === 'torus' &&
          g.featureType === 'blend' &&
          g.torusCenter !== undefined &&
          g.minorRadius !== undefined &&
          g.torusCenter.z > level + g.minorRadius / 2
        );
      })
      .map((f) => f.hash)
  );
  return boundary.some(
    (e) =>
      e.curve?.type === 'CIRCLE' &&
      e.adjacentFaceHashes!.some((h) => h !== face.hash && shoulders.has(h))
  );
}
