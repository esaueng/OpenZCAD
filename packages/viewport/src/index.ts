import * as THREE from 'three';
import type { BodyRepresentation, MeshGeometry, PrimitiveGeometry } from '@openzcad/shared';

function geometryFromPrimitive(geometry: PrimitiveGeometry): THREE.BufferGeometry {
  if (geometry.kind === 'box') {
    return new THREE.BoxGeometry(
      geometry.dimensions.width ?? 1,
      geometry.dimensions.height ?? 1,
      geometry.dimensions.depth ?? 1
    );
  }

  if (geometry.kind === 'cylinder') {
    return new THREE.CylinderGeometry(
      geometry.dimensions.radius ?? 1,
      geometry.dimensions.radius ?? 1,
      geometry.dimensions.height ?? 1,
      24
    );
  }

  return new THREE.SphereGeometry(geometry.dimensions.radius ?? 1, 24, 18);
}

function geometryFromMesh(mesh: MeshGeometry): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.vertices, 3));
  geometry.setIndex(mesh.indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function createObjectForBody(body: BodyRepresentation): THREE.Object3D {
  if (body.geometry.kind === 'composite') {
    const group = new THREE.Group();
    group.name = body.name;
    for (const child of body.geometry.children) {
      group.add(createObjectForBody(child));
    }
    applyTransform(group, body);
    return group;
  }

  const geometry =
    body.geometry.kind === 'mesh'
      ? geometryFromMesh(body.geometry)
      : geometryFromPrimitive(body.geometry);
  const material = new THREE.MeshStandardMaterial({
    color: body.color,
    metalness: 0.15,
    roughness: 0.72
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = body.name;
  applyTransform(mesh, body);
  return mesh;
}

function applyTransform(object: THREE.Object3D, body: BodyRepresentation) {
  object.position.set(
    body.transform.translation.x,
    body.transform.translation.y,
    body.transform.translation.z
  );
  object.rotation.set(
    THREE.MathUtils.degToRad(body.transform.rotationDeg.x),
    THREE.MathUtils.degToRad(body.transform.rotationDeg.y),
    THREE.MathUtils.degToRad(body.transform.rotationDeg.z)
  );
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

  if (box.isEmpty()) {
    camera.position.set(80, 80, 80);
    controlsTarget.set(0, 0, 0);
    return;
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const distance = maxDim * 2.4;

  camera.position.set(center.x + distance, center.y + distance, center.z + distance);
  controlsTarget.copy(center);
  camera.near = 0.1;
  camera.far = distance * 10;
  camera.updateProjectionMatrix();
}

