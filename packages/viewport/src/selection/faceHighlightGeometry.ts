import * as THREE from 'three';
import type { FaceTopology } from '@openzcad/shared';
import { forEachMesh } from '../pick/meshes';

/**
 * Builds one face-only index slice over the body's installed render buffers.
 * Sharing the position and normal attributes keeps selection shading identical
 * to the body, including its topology-aware smoothing groups.
 */
export function createFaceHighlightGeometry(
  bodyObject: THREE.Object3D,
  face: Pick<FaceTopology, 'triangleStart' | 'triangleCount'>
): THREE.BufferGeometry | null {
  const installed: THREE.BufferGeometry[] = [];
  forEachMesh(bodyObject, (mesh) => {
    if (installed.length === 0) {
      installed.push(mesh.geometry);
    }
  });
  const source = installed[0];
  if (!source) {
    return null;
  }

  const position = source.getAttribute('position');
  const normal = source.getAttribute('normal');
  const index = source.getIndex();
  const start = face.triangleStart * 3;
  const end = (face.triangleStart + face.triangleCount) * 3;
  if (
    !position ||
    !normal ||
    !index ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > index.count
  ) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', normal);
  geometry.setIndex(
    new THREE.BufferAttribute(index.array.slice(start, end), 1)
  );
  return geometry;
}
