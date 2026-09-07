import * as THREE from 'three';
import type { Vector3 } from '@openzcad/shared';

export interface CylinderPreviewProfile {
  axisStart: Vector3;
  axisEnd: Vector3;
  radius: number;
  coreRadius: number;
}

export interface CylinderProfilePreview {
  /** False outside the disposable profile's range; exact validation still owns release. */
  apply(delta: number): boolean;
  restore(): void;
  readonly cachedBytes: number;
}

type PositionAttribute =
  THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
const MAX_CACHED_BYTES = 2 * 1024 * 1024;

/**
 * Deforms the installed mesh and line endpoints without tessellation, normal
 * rebuilds, new draw calls, or per-frame allocations. Caps remain planar and
 * each rounded rim keeps its cross-section. This is a temporary tessellated
 * preview: the document and exact topology are never changed here.
 */
export function createCylinderProfilePreview(
  object: THREE.Object3D,
  profile: CylinderPreviewProfile,
  dimension: 'radius' | 'height'
): CylinderProfilePreview | null {
  const axis = new THREE.Vector3().copy(profile.axisEnd).sub(profile.axisStart);
  const span = axis.length();
  if (span <= 1e-9 || profile.coreRadius <= 1e-9) return null;
  axis.divideScalar(span);
  const attributes = new Set<PositionAttribute>();
  const geometries = new Set<THREE.BufferGeometry>();
  object.traverse((child) => {
    const geometry = (child as THREE.Mesh).geometry;
    if (!(geometry instanceof THREE.BufferGeometry)) return;
    geometries.add(geometry);
    // Fat lines' position describes their screen-space quad, not model points.
    const names = geometry.hasAttribute('instanceStart')
      ? ['instanceStart', 'instanceEnd']
      : ['position'];
    for (const name of names) {
      const attribute = geometry.getAttribute(name);
      if (attribute && attribute.itemSize === 3) attributes.add(attribute);
    }
  });
  const cachedBytes = [...attributes].reduce(
    (bytes, attribute) => bytes + attribute.count * 24,
    0
  );
  if (cachedBytes === 0 || cachedBytes > MAX_CACHED_BYTES) return null;
  const point = new THREE.Vector3();
  const entries = [...attributes].map((attribute) => {
    const original = new Float32Array(attribute.count * 3);
    const velocity = new Float32Array(original.length);
    for (let index = 0; index < attribute.count; index += 1) {
      point.fromBufferAttribute(attribute, index);
      point.toArray(original, index * 3);
      point.sub(profile.axisStart);
      const axial = point.dot(axis);
      if (dimension === 'height') {
        point
          .copy(axis)
          .multiplyScalar(THREE.MathUtils.clamp(axial / span, 0, 1));
      } else {
        point.addScaledVector(axis, -axial);
        point.divideScalar(Math.max(point.length(), profile.coreRadius));
      }
      point.toArray(velocity, index * 3);
    }
    return { attribute, original, velocity };
  });
  function write(delta: number) {
    for (const { attribute, original, velocity } of entries) {
      for (let index = 0; index < attribute.count; index += 1) {
        const offset = index * 3;
        attribute.setXYZ(
          index,
          original[offset]! + delta * velocity[offset]!,
          original[offset + 1]! + delta * velocity[offset + 1]!,
          original[offset + 2]! + delta * velocity[offset + 2]!
        );
      }
      attribute.needsUpdate = true;
    }
    for (const geometry of geometries) {
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
  }
  return {
    cachedBytes,
    apply(delta) {
      if (
        !Number.isFinite(delta) ||
        delta <= -(dimension === 'radius' ? profile.coreRadius : span) + 1e-6
      )
        return false;
      write(delta);
      return true;
    },
    restore() {
      write(0);
    }
  };
}
