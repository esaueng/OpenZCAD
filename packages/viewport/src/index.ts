import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type {
  BodyRepresentation,
  MeshGeometry,
  PrimitiveGeometry
} from '@openzcad/shared';

function geometryFromPrimitive(
  geometry: PrimitiveGeometry
): THREE.BufferGeometry {
  if (geometry.kind === 'box') {
    const width = geometry.dimensions.width ?? 1;
    const height = geometry.dimensions.height ?? 1;
    const depth = geometry.dimensions.depth ?? 1;
    const requestedRadius = geometry.fillet?.radius ?? 0;
    const radius = Math.min(
      requestedRadius,
      Math.min(width, height, depth) / 2 - 0.05
    );
    return radius > 0
      ? new RoundedBoxGeometry(width, height, depth, 5, radius)
      : new THREE.BoxGeometry(width, height, depth);
  }

  if (geometry.kind === 'cylinder') {
    return new THREE.CylinderGeometry(
      geometry.dimensions.radius ?? 1,
      geometry.dimensions.radius ?? 1,
      geometry.dimensions.height ?? 1,
      64
    );
  }

  return new THREE.SphereGeometry(geometry.dimensions.radius ?? 1, 48, 32);
}

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
    color: new THREE.Color(body.color).lerp(new THREE.Color('#c9d1da'), 0.68),
    metalness: 0.08,
    roughness: 0.48
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = body.name;
  mesh.userData.bodyId = body.bodyId;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
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

  camera.position.set(
    center.x + distance,
    center.y + distance,
    center.z + distance
  );
  controlsTarget.copy(center);
  camera.near = 0.1;
  camera.far = distance * 10;
  camera.updateProjectionMatrix();
}
