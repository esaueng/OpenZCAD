import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { isBehindCamera } from './cameraDepth';

function looking<T extends THREE.Camera>(camera: T): T {
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

describe('isBehindCamera', () => {
  it.each([
    ['perspective', looking(new THREE.PerspectiveCamera(45, 1, 0.1, 100))],
    [
      'orthographic',
      looking(new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100))
    ]
  ])('tells a %s view what it draws from what lies behind it', (_, camera) => {
    expect(isBehindCamera(new THREE.Vector3(0, 0, 0), camera)).toBe(false);
    // Past the far plane is still in front: its chip stays to be fixed.
    expect(isBehindCamera(new THREE.Vector3(0, 0, -500), camera)).toBe(false);
    expect(isBehindCamera(new THREE.Vector3(0, 0, 20), camera)).toBe(true);
  });
});
