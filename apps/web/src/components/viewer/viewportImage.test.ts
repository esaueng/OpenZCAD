import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fitCameraToAspect } from './viewportImage';

/** Where a world point lands in normalized device coordinates. */
function ndc(camera: THREE.Camera, point: THREE.Vector3): THREE.Vector3 {
  camera.updateMatrixWorld();
  return point.clone().project(camera);
}

describe('fitCameraToAspect', () => {
  it('keeps everything the view shows when the image is narrower or wider', () => {
    const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 1000);
    camera.position.set(0, -50, 0);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    // A point on the view's right edge, and one on its top edge.
    const halfHeight = 50 * Math.tan((20 * Math.PI) / 180);
    const right = new THREE.Vector3(halfHeight * (16 / 9), 0, 0);
    const top = new THREE.Vector3(0, 0, halfHeight);
    expect(ndc(camera, right).x).toBeCloseTo(1, 9);

    // Square: narrower, so the right edge stays the right edge.
    let restore = fitCameraToAspect(camera, 1);
    expect(ndc(camera, right).x).toBeCloseTo(1, 9);
    expect(Math.abs(ndc(camera, top).y)).toBeLessThan(1);
    restore();
    expect(camera.aspect).toBeCloseTo(16 / 9, 12);
    expect(camera.fov).toBe(40);

    // Ultra-wide: wider, so the top edge stays the top edge.
    restore = fitCameraToAspect(camera, 4);
    expect(ndc(camera, top).y).toBeCloseTo(1, 9);
    expect(Math.abs(ndc(camera, right).x)).toBeLessThan(1);
    restore();
    expect(ndc(camera, right).x).toBeCloseTo(1, 9);
  });

  it('widens an orthographic frustum the same way and restores it', () => {
    const camera = new THREE.OrthographicCamera(-16, 16, 9, -9, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    let restore = fitCameraToAspect(camera, 1);
    expect([camera.left, camera.right, camera.top, camera.bottom]).toEqual([
      -16, 16, 16, -16
    ]);
    restore();
    expect([camera.left, camera.right, camera.top, camera.bottom]).toEqual([
      -16, 16, 9, -9
    ]);
    restore = fitCameraToAspect(camera, 4);
    expect([camera.left, camera.right, camera.top, camera.bottom]).toEqual([
      -36, 36, 9, -9
    ]);
    restore();
  });
});
