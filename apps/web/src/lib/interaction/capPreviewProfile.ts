import type {
  BodyRepresentation,
  FaceTopology,
  Vector3
} from '@openzcad/shared';
import type { LinearPreviewProfile } from '@openzcad/viewport';

const dot = (a: Vector3, b: Vector3) => a.x * b.x + a.y * b.y + a.z * b.z;
const minus = (a: Vector3, b: Vector3) => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
});
const length = (v: Vector3) => Math.hypot(v.x, v.y, v.z);

/**
 * Disposable preview of a terminal circular cap and its optional round. Unlike
 * primitive ancestry this also covers a cylindrical end on an extruded/boolean
 * part. Only one complete cylindrical wall may cross the deformation span;
 * everything else must be behind it, or the selected cap and its convex round.
 * Thus the other end, shoulders, holes and unrelated solids cannot stretch.
 * This is display recognition, never authorization for an exact edit.
 */
export function capPreviewProfile(
  body: BodyRepresentation | undefined,
  cap: FaceTopology | undefined
): LinearPreviewProfile | null {
  const faces = body?.topology?.faces;
  const geometry = cap?.geometry;
  if (
    !body?.exportableStep ||
    !faces ||
    !cap ||
    !faces.includes(cap) ||
    geometry?.surfaceType !== 'plane' ||
    !geometry.normal ||
    !geometry.centroid ||
    !Number.isFinite(geometry.area) ||
    geometry.area <= 0 ||
    faces.length > 64 ||
    body.mesh.indices.length > 300_000
  )
    return null;
  const magnitude = length(geometry.normal);
  if (!Number.isFinite(magnitude) || magnitude < 1e-9) return null;
  const normal = {
    x: geometry.normal.x / magnitude,
    y: geometry.normal.y / magnitude,
    z: geometry.normal.z / magnitude
  };
  const origin = geometry.centroid;
  // Work relative to the cap so large world translations don't alter the test.
  const axial = (point: Vector3) => dot(minus(point, origin), normal);
  const onAxis = (point: Vector3, tolerance: number) => {
    const p = minus(point, origin),
      t = dot(p, normal);
    return (
      Math.hypot(p.x - normal.x * t, p.y - normal.y * t, p.z - normal.z * t) <=
      tolerance
    );
  };
  const ranges = new Map<FaceTopology, [number, number]>();
  const { vertices, indices } = body.mesh;
  let covered = 0;
  for (const face of [...faces].sort(
    (a, b) => a.triangleStart - b.triangleStart
  )) {
    let min = Infinity,
      max = -Infinity;
    const end = (face.triangleStart + face.triangleCount) * 3;
    if (
      face.triangleStart * 3 !== covered ||
      face.triangleCount <= 0 ||
      end > indices.length
    )
      return null;
    covered = end;
    for (let i = face.triangleStart * 3; i < end; i++) {
      const index = indices[i]! * 3;
      if (index < 0 || index + 2 >= vertices.length) return null;
      const t =
        (vertices[index]! - origin.x) * normal.x +
        (vertices[index + 1]! - origin.y) * normal.y +
        (vertices[index + 2]! - origin.z) * normal.z;
      min = Math.min(min, t);
      max = Math.max(max, t);
    }
    if (!Number.isFinite(min + max)) return null;
    ranges.set(face, [min, max]);
  }
  if (covered !== indices.length) return null;
  const candidates: LinearPreviewProfile[] = [];
  for (const wall of faces) {
    const g = wall.geometry;
    if (
      g?.surfaceType !== 'cylinder' ||
      !g.axisStart ||
      !g.axisEnd ||
      !g.radius
    )
      continue;
    const radius = g.radius;
    const start = Math.min(axial(g.axisStart), axial(g.axisEnd));
    const end = Math.max(axial(g.axisStart), axial(g.axisEnd));
    const span = end - start;
    // Mesh extents are Float32 display coordinates, not exact-kernel tolerances.
    const tolerance = Math.max(1, radius, span) * 1e-5;
    if (
      !Number.isFinite(radius + span + g.area) ||
      g.area <= 0 ||
      radius <= tolerance ||
      span <= tolerance ||
      end > tolerance ||
      !onAxis(g.axisStart, tolerance) ||
      !onAxis(g.axisEnd, tolerance) ||
      Math.abs(g.area - 2 * Math.PI * radius * span) > g.area * 1e-4
    )
      continue;
    const extent = ranges.get(wall)!;
    if (
      Math.abs(extent[0] - start) > tolerance ||
      Math.abs(extent[1] - end) > tolerance
    )
      continue;
    const moving = faces.filter(
      (face) =>
        face !== cap &&
        face !== wall &&
        ranges.get(face)![1] > start + tolerance
    );
    let coreRadius = radius;
    if (Math.abs(end) <= tolerance) {
      if (moving.length) continue;
    } else {
      if (moving.length !== 1) continue;
      const rim = moving[0]!,
        round = rim.geometry,
        range = ranges.get(rim)!;
      if (
        round?.surfaceType !== 'torus' ||
        round.featureType !== 'blend' ||
        !round.torusCenter ||
        !round.majorRadius ||
        !round.minorRadius ||
        !onAxis(round.torusCenter, tolerance) ||
        Math.abs(axial(round.torusCenter) - end) > tolerance ||
        Math.abs(round.majorRadius + round.minorRadius - radius) > tolerance ||
        Math.abs(end + round.minorRadius) > tolerance ||
        Math.abs(range[0] - end) > tolerance ||
        Math.abs(range[1]) > tolerance
      )
        continue;
      coreRadius = round.majorRadius;
    }
    const capRange = ranges.get(cap)!;
    if (
      coreRadius <= tolerance ||
      Math.abs(capRange[0]) > tolerance ||
      Math.abs(capRange[1]) > tolerance ||
      Math.abs(geometry.area - Math.PI * coreRadius ** 2) > geometry.area * 1e-4
    )
      continue;
    candidates.push({
      axisStart: {
        x: origin.x + normal.x * start,
        y: origin.y + normal.y * start,
        z: origin.z + normal.z * start
      },
      axisEnd: {
        x: origin.x + normal.x * end,
        y: origin.y + normal.y * end,
        z: origin.z + normal.z * end
      }
    });
  }
  return candidates.length === 1 ? candidates[0]! : null;
}
