import type { RemusKernel } from './remus-runtime';
import type { FaceWitnessV1 } from '@openzcad/shared';
import { analyticSurfaceRecord } from './exact-brep';
import { finiteVec3, positiveFinite } from './exact-math';
import { quantizedDirectionOf, quantizedPoint } from './exact-witnesses';
import { quantizeCoordinate } from './topology-fingerprint';
import { surfaceTypeOf } from './exact-sync-memo';
import type { RemusTopologyCandidate } from './remus-lineage';

/** Angles are quantized as finely as directions: 1000× the linear quantum. */
const ANGLE_SCALE = 1000;

/**
 * The exact carrier of a cone, torus or sphere face, as a key: the surface a
 * face lies on, not its trim. Two faces share a key only when they lie on the
 * same quantized surface, so a support a command re-trims keeps its key.
 *
 * The face witness has no analytic term for these surfaces, and adding one
 * would change every saved hash of a curved face. The key is used only
 * transiently, to carry an identity across an edit; it is never stored.
 * Returns null for any other surface, or when the kernel's analytic record is
 * incomplete.
 */
export function curvedCarrierKey(
  kernel: RemusKernel,
  face: number
): string | null {
  const surfaceType = surfaceTypeOf(kernel, face);
  if (
    surfaceType !== 'cone' &&
    surfaceType !== 'torus' &&
    surfaceType !== 'sphere'
  )
    return null;
  const record = analyticSurfaceRecord(kernel, face);
  if (!record) return null;
  if (surfaceType === 'sphere') {
    const center = finiteVec3(record.center);
    const radius = positiveFinite(record.radius);
    return center && radius !== null
      ? `sphere:${quantizedPoint(center).join(',')}:${quantizeCoordinate(radius)}`
      : null;
  }
  const rawAxis = finiteVec3(record.axis);
  const axis = rawAxis ? quantizedDirectionOf(rawAxis) : null;
  if (!axis) return null;
  if (surfaceType === 'cone') {
    const apex = finiteVec3(record.apex);
    const halfAngle = positiveFinite(
      record.halfAngle ?? record.half_angle ?? record.semiAngle
    );
    return apex && halfAngle !== null && halfAngle < Math.PI / 2
      ? `cone:${axis.join(',')}:${quantizedPoint(apex).join(',')}:${quantizeCoordinate(halfAngle * ANGLE_SCALE)}`
      : null;
  }
  const center = finiteVec3(record.center);
  const majorRadius = positiveFinite(record.majorRadius ?? record.major_radius);
  const minorRadius = positiveFinite(record.minorRadius ?? record.minor_radius);
  return center && majorRadius !== null && minorRadius !== null
    ? `torus:${axis.join(',')}:${quantizedPoint(center).join(',')}:${quantizeCoordinate(majorRadius)}:${quantizeCoordinate(minorRadius)}`
    : null;
}

/**
 * {@link curvedCarrierKey} of every face candidate whose witness carries no
 * analytic term. Handles must still be live in `kernel`.
 */
export function curvedCarrierKeys(
  kernel: RemusKernel,
  candidates: readonly RemusTopologyCandidate[]
): Map<number, string> {
  const keys = new Map<number, string>();
  for (const candidate of candidates) {
    if (
      candidate.kind !== 'face' ||
      (candidate.witness as FaceWitnessV1).analytic.kind !== 'none'
    )
      continue;
    const key = curvedCarrierKey(kernel, candidate.handle);
    if (key !== null) keys.set(candidate.handle, key);
  }
  return keys;
}
