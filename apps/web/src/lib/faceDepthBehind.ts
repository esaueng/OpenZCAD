import * as THREE from 'three';

/**
 * How deep the material runs straight behind a face point: the distance from
 * `origin` (on the face) back along `-direction` to where that ray leaves the
 * solid. This is the span an offset arrow's "Total" reads — the thickness of
 * the part under the arrow, not the whole body's reach behind the face's
 * plane, which on a multi-lobed part measured to an unrelated lobe.
 *
 * Null when the ray does not start inside material (the normal faces in, or
 * the mesh has no surface behind the point).
 */
export function faceDepthBehind(
  object: THREE.Object3D,
  origin: THREE.Vector3,
  direction: THREE.Vector3
): number | null {
  const back = direction.clone().normalize().negate();
  const ray = new THREE.Ray(origin, back);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const hit = new THREE.Vector3();
  const facing = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let nearest = Number.POSITIVE_INFINITY;
  let leaves = false;
  object.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(object);
  // The armed face's own triangles lie on the ray's start; skip them.
  const tolerance = Math.max(1e-9, bounds.getSize(edge).length() * 1e-7);
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
    const position = mesh.geometry.getAttribute('position') as
      THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    if (!position) {
      return;
    }
    const normals = mesh.geometry.getAttribute('normal') as
      THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : position.count;
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    for (let corner = 0; corner + 2 < count; corner += 3) {
      const i = index ? index.getX(corner) : corner;
      const j = index ? index.getX(corner + 1) : corner + 1;
      const k = index ? index.getX(corner + 2) : corner + 2;
      a.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, j).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position, k).applyMatrix4(mesh.matrixWorld);
      if (!ray.intersectTriangle(a, b, c, false, hit)) {
        continue;
      }
      const distance = hit.distanceTo(origin);
      if (distance <= tolerance || distance >= nearest) {
        continue;
      }
      // Whether the ray leaves or enters the solid here. Shading normals
      // are what the viewer lights, so they face out even where a
      // double-sided material hides the winding; without them, wind.
      if (normals) {
        facing
          .fromBufferAttribute(normals, i)
          .add(edge.fromBufferAttribute(normals, j))
          .add(edge.fromBufferAttribute(normals, k))
          .applyMatrix3(normalMatrix);
      } else {
        facing.subVectors(b, a).cross(edge.subVectors(c, a));
      }
      nearest = distance;
      leaves = facing.dot(back) > 0;
    }
  });
  return Number.isFinite(nearest) && leaves ? nearest : null;
}
