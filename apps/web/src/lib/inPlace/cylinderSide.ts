import type { FaceGeometry, MeshGeometry, Vector3 } from '@openzcad/shared';
import type { FacePick } from './tools';

/**
 * A cylindrical face as an in-place pick carries it: its axis ends, its
 * radius, the kernel's axial length and (from the mesh) boss or bore. The
 * one place picks are built from face geometry.
 */
export function facePickCylinder(
  geometry: FaceGeometry | undefined,
  mesh: MeshGeometry | undefined,
  face: { triangleStart: number; triangleCount: number }
): FacePick['cylinder'] {
  if (
    geometry?.surfaceType !== 'cylinder' ||
    !geometry.axisStart ||
    !geometry.axisEnd ||
    geometry.radius === undefined
  ) {
    return undefined;
  }
  const boss = mesh
    ? cylinderFaceIsBoss(mesh, face, geometry.axisStart, geometry.axisEnd)
    : null;
  return {
    axisStart: geometry.axisStart,
    axisEnd: geometry.axisEnd,
    radius: geometry.radius,
    ...(geometry.axialLength === undefined
      ? {}
      : { axialLength: geometry.axialLength }),
    ...(boss === null ? {} : { boss })
  };
}

/**
 * Which side of a cylindrical face the body's material lies on, read from
 * the body's display mesh: `true` for a boss (the face bulges outward, its
 * outward normals point away from the axis), `false` for a bore, `null`
 * where the mesh cannot say (no triangles, a mesh with no enclosed volume
 * to orient its winding by, or normals that cancel).
 *
 * The mesh's winding is not assumed: its signed volume orients it. Every
 * triangle of the face then votes by its area-weighted normal against the
 * direction away from the axis at its centroid.
 */
export function cylinderFaceIsBoss(
  mesh: MeshGeometry,
  face: { triangleStart: number; triangleCount: number },
  axisStart: Vector3,
  axisEnd: Vector3
): boolean | null {
  const { vertices, indices } = mesh;
  const point = (index: number): [number, number, number] => {
    const vertex = indices[index]!;
    return [
      vertices[vertex * 3]!,
      vertices[vertex * 3 + 1]!,
      vertices[vertex * 3 + 2]!
    ];
  };
  // Six times the signed volume: positive when the winding faces outward.
  let volume = 0;
  const triangles = Math.floor(indices.length / 3);
  for (let t = 0; t < triangles; t += 1) {
    const [a, b, c] = [point(t * 3), point(t * 3 + 1), point(t * 3 + 2)];
    volume +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  if (!(Math.abs(volume) > 0)) return null;
  const axis = [
    axisEnd.x - axisStart.x,
    axisEnd.y - axisStart.y,
    axisEnd.z - axisStart.z
  ];
  const length = Math.hypot(axis[0]!, axis[1]!, axis[2]!);
  if (!(length > 0)) return null;
  const unit = axis.map((value) => value / length);
  let vote = 0;
  const end = Math.min(face.triangleStart + face.triangleCount, triangles);
  for (let t = Math.max(face.triangleStart, 0); t < end; t += 1) {
    const [a, b, c] = [point(t * 3), point(t * 3 + 1), point(t * 3 + 2)];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!
    ];
    const centroid = [0, 1, 2].map((k) => (a[k]! + b[k]! + c[k]!) / 3);
    const along =
      (centroid[0]! - axisStart.x) * unit[0]! +
      (centroid[1]! - axisStart.y) * unit[1]! +
      (centroid[2]! - axisStart.z) * unit[2]!;
    const radial = [
      centroid[0]! - axisStart.x - unit[0]! * along,
      centroid[1]! - axisStart.y - unit[1]! * along,
      centroid[2]! - axisStart.z - unit[2]! * along
    ];
    vote +=
      normal[0]! * radial[0]! +
      normal[1]! * radial[1]! +
      normal[2]! * radial[2]!;
  }
  const signed = vote * Math.sign(volume);
  return signed > 0 ? true : signed < 0 ? false : null;
}
