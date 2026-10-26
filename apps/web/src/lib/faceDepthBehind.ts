import * as THREE from 'three';
import { forEachMesh } from '@openzcad/viewport';

/**
 * How far the face as rendered stands in front of the plane through
 * `origin`, along `direction`: zero until a preview moves it. Zero when the
 * face is not in the body's topology table.
 */
export function faceLift(
  object: THREE.Object3D,
  topologyId: string,
  origin: THREE.Vector3,
  direction: THREE.Vector3
): number {
  const lifts: number[] = [];
  object.traverse((child) => {
    if (lifts.length > 0 || !(child instanceof THREE.Mesh)) {
      return;
    }
    const face = (
      child.userData as {
        topology?: {
          faces: { topologyId: string; triangleStart: number }[];
        };
      }
    ).topology?.faces.find((candidate) => candidate.topologyId === topologyId);
    if (!face) {
      return;
    }
    const geometry = (child as THREE.Mesh<THREE.BufferGeometry>).geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (!position) {
      return;
    }
    const corner = face.triangleStart * 3;
    child.updateWorldMatrix(true, false);
    const vertex = new THREE.Vector3()
      .fromBufferAttribute(position, index ? index.getX(corner) : corner)
      .applyMatrix4(child.matrixWorld);
    lifts.push(vertex.sub(origin).dot(direction.clone().normalize()));
  });
  return lifts[0] ?? 0;
}

/**
 * How deep the material runs behind the point the face was picked at: the
 * length of a line from `origin` back along `-direction` to where it leaves
 * the solid. This is the span an offset arrow's "Total" reads and draws, so
 * it changes with where on the face the pick lands — a thin tab reads its
 * thickness, the block below it reads the block — instead of the whole
 * body's reach behind the face's plane. A hole straight behind the point
 * ends the line at its wall: that is where the material ends there.
 *
 * `lift` is how far a preview has moved the face in front of the plane the
 * gesture started on (`faceLift`); the line starts on the face as rendered
 * and the depth still counts from that plane.
 *
 * Null when the line does not start inside material (the normal faces in,
 * or no surface lies behind the point).
 */
export function faceDepthBehind(
  object: THREE.Object3D,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  lift = 0
): number | null {
  const forward = direction.clone().normalize();
  const back = forward.clone().negate();
  const start = origin.clone().addScaledVector(forward, lift);
  const ray = new THREE.Ray(start, back);
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
  // The armed face's own triangles lie on the line's start; skip them.
  const tolerance = Math.max(1e-9, bounds.getSize(edge).length() * 1e-7);
  // Body meshes only: a raster section cap or a selection overlay is not
  // material, and a line stopping on a cap read the clipped span.
  forEachMesh(object, (mesh) => {
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
      const distance = hit.distanceTo(start);
      // A hit level with the nearest (an edge or vertex shared by several
      // triangles) still counts: any of them may be the one it leaves by.
      if (distance <= tolerance || distance > nearest + tolerance) {
        continue;
      }
      // Whether the line leaves or enters the solid here. Shading normals
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
      const leavesHere = facing.dot(back) > 0;
      if (distance < nearest - tolerance) {
        nearest = distance;
        leaves = leavesHere;
      } else {
        leaves ||= leavesHere;
      }
    }
  });
  return Number.isFinite(nearest) && leaves ? nearest - lift : null;
}
