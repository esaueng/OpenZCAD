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
  return createProfilePreview(
    object,
    (point) => {
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
    },
    dimension === 'radius' ? profile.coreRadius : span
  );
}

/**
 * A bore inside a larger body: the wall, plus the rounded rim at either end
 * (`rimStart`/`rimEnd` are their widths along the axis, 0 for a sharp rim).
 */
export interface BorePreviewProfile {
  axisStart: Vector3;
  axisEnd: Vector3;
  radius: number;
  rimStart: number;
  rimEnd: number;
}

/**
 * Pushes a bore's wall and rim blends radially and leaves the rest of the
 * body where it is. The cap a rim opens through keeps its outer boundary and
 * stays planar, since every point moves in a plane square to the axis; a
 * blend keeps its cross-section, as the exact resize keeps it. Anything not
 * on the wall or a rim band — a counterbore's other step, a floor's interior
 * — stays put, so the projection never invents motion the edit would not make.
 */
export function createBoreProfilePreview(
  object: THREE.Object3D,
  profile: BorePreviewProfile
): CylinderProfilePreview | null {
  const axis = new THREE.Vector3().copy(profile.axisEnd).sub(profile.axisStart);
  const span = axis.length();
  const radius = profile.radius;
  if (span <= 1e-9 || !(radius > 1e-9)) return null;
  axis.divideScalar(span);
  const tolerance = 1e-4 * Math.max(radius, span, 1);
  const rimStart = Math.max(0, profile.rimStart);
  const rimEnd = Math.max(0, profile.rimEnd);
  let moving = 0;
  const preview = createProfilePreview(
    object,
    (point) => {
      point.sub(profile.axisStart);
      const axial = point.dot(axis);
      point.addScaledVector(axis, -axial);
      const distance = point.length();
      const onWall =
        Math.abs(distance - radius) <= tolerance &&
        axial >= -tolerance &&
        axial <= span + tolerance;
      const inRim = (width: number, from: number) =>
        width > 0 &&
        distance >= radius - tolerance &&
        distance <= radius + width + tolerance &&
        axial >= from - tolerance &&
        axial <= from + width + tolerance;
      if (
        distance > 1e-9 &&
        (onWall || inRim(rimStart, -rimStart) || inRim(rimEnd, span))
      ) {
        point.divideScalar(distance);
        moving += 1;
      } else {
        point.set(0, 0, 0);
      }
    },
    radius
  );
  return preview && moving > 0 ? preview : null;
}

/** The two planes bounding the straight span; material beyond them moves rigidly. */
export interface LinearPreviewProfile {
  axisStart: Vector3;
  axisEnd: Vector3;
}

/** Preserves the end rounds of a recognized box while stretching its straight span. */
export function createLinearProfilePreview(
  object: THREE.Object3D,
  profile: LinearPreviewProfile
): CylinderProfilePreview | null {
  const axis = new THREE.Vector3().copy(profile.axisEnd).sub(profile.axisStart);
  const span = axis.length();
  if (!Number.isFinite(span) || span <= 1e-9) return null;
  axis.divideScalar(span);
  return createProfilePreview(
    object,
    (point) => {
      const axial = point.sub(profile.axisStart).dot(axis);
      point
        .copy(axis)
        .multiplyScalar(THREE.MathUtils.clamp(axial / span, 0, 1));
    },
    span
  );
}

function createProfilePreview(
  object: THREE.Object3D,
  velocityAt: (point: THREE.Vector3) => void,
  span: number
): CylinderProfilePreview | null {
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
      velocityAt(point);
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
      if (!Number.isFinite(delta) || delta <= -span + 1e-6) return false;
      write(delta);
      return true;
    },
    restore() {
      write(0);
    }
  };
}
