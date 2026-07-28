import * as THREE from 'three';
import type { BodyRepresentation } from '@openzcad/shared';

export type ViewerBodyMaterial =
  | THREE.MeshStandardMaterial
  | THREE.MeshPhongMaterial;
export type ViewerMesh = THREE.Mesh<THREE.BufferGeometry, ViewerBodyMaterial>;

export type DirectEditAxis = 'x' | 'y' | 'z';

export interface DirectEditDirection {
  axis: DirectEditAxis;
  side: -1 | 1;
}

/**
 * Lit body meshes only. Overlay meshes (hover fills, region shading, gizmo
 * handles) use basic materials and must never pick up emissive highlighting.
 */
export function isViewerMesh(object: THREE.Object3D): object is ViewerMesh {
  return (
    object instanceof THREE.Mesh &&
    (object.material instanceof THREE.MeshStandardMaterial ||
      object.material instanceof THREE.MeshPhongMaterial)
  );
}

export function forEachMesh(
  object: THREE.Object3D,
  visit: (mesh: ViewerMesh) => void
) {
  object.traverse((child: THREE.Object3D) => {
    if (isViewerMesh(child)) {
      visit(child);
    }
  });
}

/** Walks up to the nearest ancestor tagged with a body id. */
export function findBodyId(object: THREE.Object3D): string | null {
  let current: THREE.Object3D | null = object;
  while (current) {
    const bodyId = (current.userData as { bodyId?: string }).bodyId;
    if (bodyId) {
      return bodyId;
    }
    current = current.parent;
  }
  return null;
}

export function normalForTriangle(
  body: BodyRepresentation,
  triangleStart: number
): THREE.Vector3 | null {
  const offset = triangleStart * 3;
  const indices = body.mesh.indices.slice(offset, offset + 3);
  if (indices.length !== 3) {
    return null;
  }
  const [aIndex, bIndex, cIndex] = indices;
  if (aIndex === undefined || bIndex === undefined || cIndex === undefined) {
    return null;
  }
  const a = new THREE.Vector3().fromArray(body.mesh.vertices, aIndex * 3);
  const b = new THREE.Vector3().fromArray(body.mesh.vertices, bIndex * 3);
  const c = new THREE.Vector3().fromArray(body.mesh.vertices, cIndex * 3);
  return new THREE.Triangle(a, b, c).getNormal(new THREE.Vector3());
}

/** Maps an exact picked face normal to the parametric box dimension it edits. */
export function directEditDirectionFromNormal(
  normal: Pick<THREE.Vector3, 'x' | 'y' | 'z'>
): DirectEditDirection {
  const components = [
    ['x', normal.x],
    ['y', normal.y],
    ['z', normal.z]
  ] as const;
  const [axis, value] = components.reduce((largest, candidate) =>
    Math.abs(candidate[1]) > Math.abs(largest[1]) ? candidate : largest
  );
  return { axis, side: value < 0 ? -1 : 1 };
}
