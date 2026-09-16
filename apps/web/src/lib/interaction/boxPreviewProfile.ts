import type {
  BodyRepresentation,
  FaceTopology,
  Vector3
} from '@openzcad/shared';
import type { LinearPreviewProfile } from '@openzcad/viewport';

const dot = (a: Vector3, b: Vector3) => a.x * b.x + a.y * b.y + a.z * b.z;
const unit = (a: Vector3): Vector3 | null => {
  const size = Math.hypot(a.x, a.y, a.z);
  return Number.isFinite(size) && size > 1e-9
    ? { x: a.x / size, y: a.y / size, z: a.z / size }
    : null;
};

/**
 * Rendering-only profile for a lineage-proven box dimension edit. Six mutually
 * orthogonal support planes bound the box. Their trimmed side faces bound the
 * straight span: the end rounds translate intact instead of scaling. Refuse
 * additional faces crossing that span unless they are parallel cylindrical
 * edge rounds. This deliberately excludes holes, shells and general offsets.
 */
export function boxPreviewProfile(
  body: BodyRepresentation | undefined,
  direction: Vector3
): LinearPreviewProfile | null {
  const normal = unit(direction);
  const faces = body?.topology?.faces;
  if (!body || !normal || !faces) return null;
  const planes = faces.filter((face) => face.geometry?.surfaceType === 'plane');
  if (planes.length !== 6) return null;
  const normals = planes.map(
    (face) => face.geometry?.normal && unit(face.geometry.normal)
  );
  if (normals.some((n) => !n)) return null;
  for (const n of normals) {
    const products = normals.map((other) => dot(n!, other!));
    if (
      products.filter((v) => v < -1 + 1e-6).length !== 1 ||
      products.filter((v) => Math.abs(v) < 1e-6).length !== 4
    )
      return null;
  }
  const caps = planes.filter(
    (_, i) => Math.abs(dot(normals[i]!, normal)) > 1 - 1e-6
  );
  const sides = planes.filter(
    (_, i) => Math.abs(dot(normals[i]!, normal)) < 1e-6
  );
  if (caps.length !== 2 || sides.length !== 4) return null;
  const capPositions = caps.map((face) => dot(face.geometry!.center, normal));
  const minimum = Math.min(...capPositions),
    maximum = Math.max(...capPositions);
  const tolerance = Math.max(1, maximum - minimum) * 1e-5;
  const range = (face: FaceTopology): [number, number] | null => {
    let min = Infinity,
      max = -Infinity;
    const { vertices, indices } = body.mesh;
    for (
      let i = face.triangleStart * 3;
      i < (face.triangleStart + face.triangleCount) * 3;
      i++
    ) {
      const index = indices[i];
      if (index === undefined || index * 3 + 2 >= vertices.length) return null;
      const projected =
        vertices[index * 3]! * normal.x +
        vertices[index * 3 + 1]! * normal.y +
        vertices[index * 3 + 2]! * normal.z;
      min = Math.min(min, projected);
      max = Math.max(max, projected);
    }
    return Number.isFinite(min + max) ? [min, max] : null;
  };
  const ranges = sides.map(range);
  if (ranges.some((r) => !r)) return null;
  const start = Math.max(minimum, ...ranges.map((r) => r![0]));
  const end = Math.min(maximum, ...ranges.map((r) => r![1]));
  if (!Number.isFinite(start + end) || end - start <= tolerance) return null;
  for (const face of faces) {
    if (planes.includes(face)) continue;
    const extent = range(face);
    if (
      !extent ||
      extent[0] < minimum - tolerance ||
      extent[1] > maximum + tolerance
    )
      return null;
    // Rounds wholly inside the two end bands move as rigid sections.
    if (extent[1] <= start + tolerance || extent[0] >= end - tolerance)
      continue;
    const geometry = face.geometry;
    if (
      geometry?.surfaceType !== 'cylinder' ||
      !geometry.axisStart ||
      !geometry.axisEnd
    )
      return null;
    const axis = unit({
      x: geometry.axisEnd.x - geometry.axisStart.x,
      y: geometry.axisEnd.y - geometry.axisStart.y,
      z: geometry.axisEnd.z - geometry.axisStart.z
    });
    if (!axis || Math.abs(dot(axis, normal)) < 1 - 1e-6) return null;
  }
  return {
    axisStart: {
      x: normal.x * start,
      y: normal.y * start,
      z: normal.z * start
    },
    axisEnd: { x: normal.x * end, y: normal.y * end, z: normal.z * end }
  };
}
