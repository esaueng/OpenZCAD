import type { Vector3 } from '@openzcad/shared';

import { faceVertexCentroid } from './exact-brep';
import type { RemusKernel } from './remus-runtime';
import { surfaceTypeOf, syncReadMemoFor } from './exact-sync-memo';

/**
 * The narrow face data consumed by planar-distance proofs.
 *
 * This deliberately excludes area, area provenance, the optional surface
 * centroid, and curved-surface metadata. Those values do not participate in
 * coplanar grouping or moved-pair verification, and measuring them here makes
 * those proof paths perform unrelated numerical integration.
 */
export interface FacePlaneFrame {
  surfaceType: string;
  center: Vector3;
  normal?: Vector3;
  planeOffset?: number;
}

/**
 * Reads the same vertex-mean center, analytic normal, and plane equation as
 * `measureFaceGeometry`, without computing any of its unrelated measurements.
 *
 * Surface and vertex-read failures still propagate. An unavailable analytic
 * normal remains a supported read with no normal or offset, so callers keep
 * rejecting that face as non-planar for editing. Failures from omitted area or
 * centroid queries cannot affect a proof whose inputs never consume them.
 */
export function readFacePlaneFrame(
  kernel: RemusKernel,
  face: number
): FacePlaneFrame {
  // The planar-distance proofs read every face's frame once per candidate
  // pair; inside a sync memo each face is read once. Callers get their own
  // copy of the shared record.
  const memo = syncReadMemoFor(kernel);
  const frame = memo
    ? memo.faceValue('plane-frame', face, () =>
        measureFacePlaneFrame(kernel, face)
      )
    : measureFacePlaneFrame(kernel, face);
  return memo
    ? {
        ...frame,
        center: { ...frame.center },
        ...(frame.normal ? { normal: { ...frame.normal } } : {})
      }
    : frame;
}

function measureFacePlaneFrame(
  kernel: RemusKernel,
  face: number
): FacePlaneFrame {
  const surfaceType = surfaceTypeOf(kernel, face);
  const center = faceVertexCentroid(kernel, face) ?? { x: 0, y: 0, z: 0 };
  const frame: FacePlaneFrame = { surfaceType, center };
  if (surfaceType !== 'plane') {
    return frame;
  }
  try {
    const normal = kernel.getFaceNormal(face);
    frame.normal = {
      x: normal[0]!,
      y: normal[1]!,
      z: normal[2]!
    };
    frame.planeOffset =
      frame.normal.x * center.x +
      frame.normal.y * center.y +
      frame.normal.z * center.z;
  } catch {
    // NURBS-backed planes have no analytic normal. Keep the same fail-closed
    // representation as the complete face measurement.
  }
  return frame;
}
