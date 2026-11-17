import type { BodyId, BodyTopology, TopologySelection } from '@openzcad/shared';
import { distanceToAxis } from './interaction/filletFaceEdit';

type FaceTopology = BodyTopology['faces'][number];

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface BlendRearmPick {
  selection: TopologySelection;
  detail: { point: Vector3; normal: Vector3 };
}

/**
 * The face to re-arm on after a new fillet lands from an edge drag.
 *
 * Committing a fillet by drag used to end the gesture outright: the handle
 * and card vanished with the edges, and the only way to change the radius
 * was to find the blend face and pick it by hand. The blend face is the
 * fillet's own handle (picking one arms the edit-fillet drag), so the first
 * cylindrical blend the commit created is picked for the user, with a
 * synthetic hit at its centroid facing out from the axis — the frame the
 * pointer would have supplied.
 *
 * A new hash alone does not make a face new. A fillet that meets an earlier
 * one trims that earlier band, and the trimmed band comes back under a new
 * hash (QA 2026-11-14 finding #10: Fillet 4 landed beside Fillet 3, Fillet
 * 3's band was picked, and a typed radius edited Fillet 3). So a named band
 * is picked only when the commit's feature produced it, and a hash-only one
 * (a shelled or fused body publishes no names) only when no earlier blend
 * shares its carrier: the pick is the new fillet's, or nothing.
 */
export function newBlendFacePick(
  bodyId: BodyId,
  before: readonly FaceTopology[] | undefined,
  after: readonly FaceTopology[] | undefined,
  featureId: string | undefined
): BlendRearmPick | null {
  if (!after) return null;
  const known = new Set((before ?? []).map((face) => face.hash));
  const earlierBlends = (before ?? []).filter(
    (face) => face.geometry?.featureType === 'blend'
  );
  for (const face of after) {
    const geometry = face.geometry;
    if (
      known.has(face.hash) ||
      geometry?.featureType !== 'blend' ||
      geometry.surfaceType !== 'cylinder' ||
      !geometry.axisStart ||
      !geometry.axisEnd ||
      (face.reference
        ? String(face.reference.producingFeatureId) !== featureId
        : earlierBlends.some((previous) => sameCylinderCarrier(previous, face)))
    ) {
      continue;
    }
    const point = geometry.centroid ?? geometry.center;
    const normal = radialFromAxis(point, geometry.axisStart, geometry.axisEnd);
    if (!normal) continue;
    return {
      selection: {
        bodyId,
        kind: 'face',
        topologyId: face.topologyId,
        hash: face.hash,
        ...(face.reference ? { reference: face.reference } : {})
      },
      detail: { point, normal }
    };
  }
  return null;
}

/**
 * Whether two cylindrical blends lie on one carrier: the same radius about
 * the same axis line (both ends of B's axis on A's). Trimming a band changes
 * its extent and hash, never its carrier.
 */
function sameCylinderCarrier(left: FaceTopology, right: FaceTopology): boolean {
  const a = left.geometry;
  const b = right.geometry;
  const radius = a?.blendRadius ?? a?.radius;
  if (
    a?.surfaceType !== 'cylinder' ||
    b?.surfaceType !== 'cylinder' ||
    !a.axisStart ||
    !a.axisEnd ||
    !b.axisStart ||
    !b.axisEnd ||
    radius === undefined
  ) {
    return false;
  }
  const { axisStart, axisEnd } = a;
  const tolerance =
    1e-6 *
    Math.max(1, radius, Math.hypot(axisStart.x, axisStart.y, axisStart.z));
  const direction = {
    x: axisEnd.x - axisStart.x,
    y: axisEnd.y - axisStart.y,
    z: axisEnd.z - axisStart.z
  };
  return (
    Math.abs((b.blendRadius ?? b.radius ?? Infinity) - radius) <= tolerance &&
    distanceToAxis(b.axisStart, axisStart, direction) <= tolerance &&
    distanceToAxis(b.axisEnd, axisStart, direction) <= tolerance
  );
}

function radialFromAxis(
  point: Vector3,
  axisStart: Vector3,
  axisEnd: Vector3
): Vector3 | null {
  const axis = {
    x: axisEnd.x - axisStart.x,
    y: axisEnd.y - axisStart.y,
    z: axisEnd.z - axisStart.z
  };
  const axisLength = Math.hypot(axis.x, axis.y, axis.z);
  if (axisLength < 1e-9) return null;
  const direction = {
    x: axis.x / axisLength,
    y: axis.y / axisLength,
    z: axis.z / axisLength
  };
  const offset = {
    x: point.x - axisStart.x,
    y: point.y - axisStart.y,
    z: point.z - axisStart.z
  };
  const along =
    offset.x * direction.x + offset.y * direction.y + offset.z * direction.z;
  const radial = {
    x: offset.x - direction.x * along,
    y: offset.y - direction.y * along,
    z: offset.z - direction.z * along
  };
  const length = Math.hypot(radial.x, radial.y, radial.z);
  if (length < 1e-9) return null;
  return { x: radial.x / length, y: radial.y / length, z: radial.z / length };
}
