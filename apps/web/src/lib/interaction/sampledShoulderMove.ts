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
 * - Raising the block top around that shoulder far enough to reach the
 *   boss's rim round. The top meets the shoulder along a circle, and the
 *   rim is a torus round on the same axis above it. The shoulder is concave, so
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
  const tori = topology.faces.flatMap((f) => {
    const g = f.geometry;
    return g?.surfaceType === 'torus' &&
      g.featureType === 'blend' &&
      g.torusCenter !== undefined &&
      g.minorRadius !== undefined &&
      (g.axis === undefined || Math.abs(g.axis.z) > 0.999)
      ? [{ hash: f.hash, center: g.torusCenter, minor: g.minorRadius }]
      : [];
  });
  const shoulders = tori.filter((s) => s.center.z > level + s.minor / 2);
  // The rise reaches the rim once the shoulder's spring on the boss wall
  // (its centre height) meets the rim's. Below that the Box resize builds.
  const reachesRim = (s: (typeof tori)[number]) =>
    tori.some(
      (r) =>
        Math.hypot(r.center.x - s.center.x, r.center.y - s.center.y) < 1e-6 &&
        r.center.z > s.center.z + 1e-6 &&
        s.center.z + offset >= r.center.z - 1e-6
    );
  return boundary.some(
    (e) =>
      e.curve?.type === 'CIRCLE' &&
      shoulders.some(
        (s) =>
          s.hash !== face.hash &&
          e.adjacentFaceHashes!.includes(s.hash) &&
          reachesRim(s)
      )
  );
}
