import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createOffsetBodyPreview } from './offsetBodyPreview';

function projected(
  object: THREE.Object3D,
  point: THREE.Vector3,
  direction: THREE.Vector3
) {
  object.updateMatrixWorld(true);
  return point.clone().applyMatrix4(object.matrixWorld).dot(direction);
}

describe('offset body preview', () => {
  it('shows one stretched body with the opposite support fixed', () => {
    const object = new THREE.Object3D();
    const preview = createOffsetBodyPreview(
      object,
      new Float32Array([0, -2, 0, 5, 1, 0, 10, 3, 0]),
      { x: 1, y: 0, z: 0 }
    )!;
    expect(preview.span).toBe(10);
    expect(preview.apply(4)).toBe(true);
    const direction = new THREE.Vector3(1, 0, 0);
    expect(projected(object, new THREE.Vector3(0, 0, 0), direction)).toBe(0);
    expect(projected(object, new THREE.Vector3(5, 0, 0), direction)).toBe(7);
    expect(projected(object, new THREE.Vector3(10, 0, 0), direction)).toBe(14);
  });

  it('works along a tilted normal without changing perpendicular coordinates', () => {
    const direction = new THREE.Vector3(1, 1, 0).normalize();
    const perpendicular = new THREE.Vector3(-1, 1, 0).normalize();
    const object = new THREE.Object3D();
    const start = direction.clone().multiplyScalar(-3).add(perpendicular);
    const end = direction.clone().multiplyScalar(7).add(perpendicular);
    const preview = createOffsetBodyPreview(
      object,
      new Float32Array([...start.toArray(), ...end.toArray()]),
      direction
    )!;
    expect(preview.apply(5)).toBe(true);
    expect(projected(object, start, direction)).toBeCloseTo(-3, 5);
    expect(projected(object, end, direction)).toBeCloseTo(12, 5);
    expect(projected(object, end, perpendicular)).toBeCloseTo(1, 5);
  });

  it('restores the authoritative pose and refuses collapse or inversion', () => {
    const object = new THREE.Object3D();
    object.position.set(4, 5, 6);
    object.updateMatrix();
    const original = object.matrix.clone();
    const preview = createOffsetBodyPreview(
      object,
      new Float32Array([0, 0, 0, 0, 0, 8]),
      { x: 0, y: 0, z: 1 }
    )!;
    expect(preview.apply(-8)).toBe(false);
    expect(preview.apply(-7)).toBe(true);
    expect(object.matrix.equals(original)).toBe(false);
    preview.restore();
    expect(object.matrix.equals(original)).toBe(true);
    expect(object.matrixAutoUpdate).toBe(true);
  });

  it('fails closed for degenerate direction or geometry', () => {
    const object = new THREE.Object3D();
    expect(
      createOffsetBodyPreview(object, new Float32Array([0, 0, 0]), {
        x: 1,
        y: 0,
        z: 0
      })
    ).toBeNull();
    expect(
      createOffsetBodyPreview(object, new Float32Array([0, 0, 0, 1, 0, 0]), {
        x: 0,
        y: 0,
        z: 0
      })
    ).toBeNull();
  });
});
