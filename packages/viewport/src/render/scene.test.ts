import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { shouldShowGroundShadow } from './scene';

function cameraLookingFrom(x: number, y: number, z: number) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

describe('shouldShowGroundShadow', () => {
  it('shows the grounding shadow in oblique and elevation views', () => {
    expect(shouldShowGroundShadow(cameraLookingFrom(10, -10, 10), true)).toBe(
      true
    );
    expect(shouldShowGroundShadow(cameraLookingFrom(0, -10, 0), true)).toBe(
      true
    );
  });

  it('hides the shadow slab in top and bottom views or when the grid is off', () => {
    expect(shouldShowGroundShadow(cameraLookingFrom(0, 0, 10), true)).toBe(
      false
    );
    expect(shouldShowGroundShadow(cameraLookingFrom(0, 0, -10), true)).toBe(
      false
    );
    expect(shouldShowGroundShadow(cameraLookingFrom(10, -10, 10), false)).toBe(
      false
    );
  });
});
