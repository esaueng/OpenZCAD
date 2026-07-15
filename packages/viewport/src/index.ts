import * as THREE from 'three';
import type { BodyRepresentation, MeshGeometry } from '@openzcad/shared';

function geometryFromMesh(mesh: MeshGeometry): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(mesh.vertices, 3)
  );
  geometry.setIndex(mesh.indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Builds the render object for one body: a flat-shaded mesh plus a subtle
 * feature-edge overlay for the classic CAD look. Body vertices are already
 * in world space (the kernel bakes transforms), so no placement is applied.
 */
export function createObjectForBody(body: BodyRepresentation): THREE.Object3D {
  const geometry = geometryFromMesh(body.mesh);
  const material = new THREE.MeshStandardMaterial({
    color: body.color,
    metalness: 0.06,
    roughness: 0.56
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = body.name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 24),
    new THREE.LineBasicMaterial({
      color: '#070b10',
      transparent: true,
      opacity: 0.78
    })
  );
  edges.raycast = () => undefined; // selection picks faces, not edge lines
  mesh.add(edges);
  return mesh;
}

export function fitCameraToObjects(
  camera: THREE.PerspectiveCamera,
  controlsTarget: THREE.Vector3,
  objects: THREE.Object3D[]
) {
  const box = new THREE.Box3();
  for (const object of objects) {
    box.expandByObject(object);
  }

  // Framing matches the Z-up isometric the viewer uses: right, front, above.
  // Keeping the sign of Y negative here is what stops a fit from parking the
  // camera behind the model.
  if (box.isEmpty()) {
    camera.position.set(80, -80, 80);
    controlsTarget.set(0, 0, 0);
    return;
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const distance = maxDim * 2.4;

  camera.position.set(
    center.x + distance,
    center.y - distance,
    center.z + distance
  );
  controlsTarget.copy(center);
  camera.near = 0.1;
  camera.far = distance * 10;
  camera.updateProjectionMatrix();
}
