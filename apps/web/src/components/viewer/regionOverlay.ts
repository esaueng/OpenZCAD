import * as THREE from 'three';
import type { PlaneBasis } from '@openzcad/geometry';
import {
  REGION_COMMAND_OPACITY,
  REGION_HOVER_OPACITY,
  REGION_IDLE_OPACITY,
  REGION_SELECTED_OPACITY,
  type RegionPickData
} from '@openzcad/viewport';

export type { RegionPickData };
export {
  REGION_COMMAND_OPACITY,
  REGION_HOVER_OPACITY,
  REGION_IDLE_OPACITY,
  REGION_SELECTED_OPACITY
};

/**
 * Geometry for detected sketch regions in the viewport: hole-aware
 * triangulation of a region's sampled boundary, lifted onto its plane.
 * The resulting meshes double as pick targets and orange hover fills.
 */

export interface RegionPoint {
  x: number;
  y: number;
}

/**
 * Triangulates a region (outer boundary minus holes) in plane-local space.
 * Returns interleaved xyz positions on the plane basis plus triangle indices.
 */
export function triangulateRegionGeometry(
  outer: RegionPoint[],
  holes: RegionPoint[][],
  basis: PlaneBasis
): { positions: Float32Array; indices: number[] } {
  const outerVectors = outer.map(
    (point) => new THREE.Vector2(point.x, point.y)
  );
  const holeVectors = holes.map((hole) =>
    hole.map((point) => new THREE.Vector2(point.x, point.y))
  );
  const triangles = THREE.ShapeUtils.triangulateShape(
    outerVectors,
    holeVectors
  );
  const flat: RegionPoint[] = [...outer, ...holes.flat()];
  const positions = new Float32Array(flat.length * 3);
  flat.forEach((point, index) => {
    positions[index * 3] =
      basis.origin.x + basis.u.x * point.x + basis.v.x * point.y;
    positions[index * 3 + 1] =
      basis.origin.y + basis.u.y * point.x + basis.v.y * point.y;
    positions[index * 3 + 2] =
      basis.origin.z + basis.u.z * point.x + basis.v.z * point.y;
  });
  return { positions, indices: triangles.flat() };
}

export const REGION_FILL_COLOR = 0x4da3ff;

/** Builds the cached fill mesh for one first-class sketch profile. */
export function buildRegionMesh(
  outer: RegionPoint[],
  holes: RegionPoint[][],
  basis: PlaneBasis,
  pick: RegionPickData,
  options: { baseOpacity?: number; selected?: boolean } = {}
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  const { positions, indices } = triangulateRegionGeometry(outer, holes, basis);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const material = new THREE.MeshBasicMaterial({
    color: REGION_FILL_COLOR,
    toneMapped: false,
    transparent: true,
    opacity: options.selected
      ? REGION_SELECTED_OPACITY
      : (options.baseOpacity ?? 0),
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 9;
  mesh.userData.region = pick;
  mesh.userData.regionBaseOpacity = options.baseOpacity ?? 0;
  mesh.userData.regionSelected = options.selected === true;
  return mesh;
}
