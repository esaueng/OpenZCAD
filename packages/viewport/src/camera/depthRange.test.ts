import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { updateCameraClipping } from './depthRange';
import { presentedBounds } from './scale';

function corners(bounds: THREE.Box3) {
  const result: THREE.Vector3[] = [];
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z])
        result.push(new THREE.Vector3(x, y, z));
  return result;
}

function expectInDepth(camera: THREE.Camera, bounds: THREE.Box3) {
  for (const corner of corners(bounds)) {
    const projected = corner.project(camera);
    expect(projected.z).toBeGreaterThan(-1);
    expect(projected.z).toBeLessThan(1);
  }
}

const cabinet = new THREE.Box3(
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(2362.2, 762, 2100)
);

describe('camera depth range', () => {
  it.each(['perspective', 'orthographic'] as const)(
    'keeps the whole assembly through a %s dolly and close inspection',
    (projection) => {
      const camera =
        projection === 'perspective'
          ? new THREE.PerspectiveCamera(45, 1.6, 0.1, 4000)
          : new THREE.OrthographicCamera(-3000, 3000, 2000, -2000, -2000, 4000);
      const center = cabinet.getCenter(new THREE.Vector3());
      const direction = new THREE.Vector3(0.15, -1, 0.16).normalize();
      for (const distance of [3800, 6000, 100_000, 1600]) {
        camera.position.copy(center).addScaledVector(direction, distance);
        camera.lookAt(center);
        const position = camera.position.clone();
        const quaternion = camera.quaternion.clone();
        updateCameraClipping(camera, cabinet);
        expectInDepth(camera, cabinet);
        expect(camera.position.equals(position)).toBe(true);
        expect(camera.quaternion.equals(quaternion)).toBe(true);
        // Near tracks the model too, preserving useful thin-surface precision.
        expect(camera.near).toBeGreaterThan(1);
        expect(camera.far).toBeLessThan(distance * 20 + 10_000);
      }
    }
  );

  it('follows transformed previews and excludes hidden replacement bodies', () => {
    const root = new THREE.Group();
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(1e8, 1e8, 1e8));
    hidden.visible = false;
    const preview = new THREE.Group();
    preview.add(new THREE.Mesh(new THREE.BoxGeometry(100, 50, 1)));
    root.add(hidden, preview);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    camera.position.set(0, 0, 10_000);
    camera.lookAt(0, 0, 0);
    const bounds = new THREE.Box3();
    for (const z of [0, -20_000, 8000]) {
      preview.position.z = z;
      presentedBounds([root], bounds);
      updateCameraClipping(camera, bounds);
      expectInDepth(camera, bounds);
      expect(camera.far).toBeLessThan(400_000);
    }
  });

  it('includes sketch-only line geometry, even in a zero-thickness plane', () => {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-100, 0, 0),
      new THREE.Vector3(100, 0, 0)
    ]);
    const sketch = new THREE.Line(geometry);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    camera.position.z = 10_000;
    camera.lookAt(0, 0, 0);
    const bounds = presentedBounds([sketch], new THREE.Box3());
    updateCameraClipping(camera, bounds);
    expectInDepth(camera, bounds);
    expect(camera.near).toBeGreaterThan(1);
  });

  it('keeps a positive perspective near plane when navigating into the model', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    const bounds = new THREE.Box3(
      new THREE.Vector3(-10, -10, -10),
      new THREE.Vector3(10, 10, 10)
    );
    updateCameraClipping(camera, bounds);
    expect(camera.near).toBeGreaterThan(0);
    expect(camera.far).toBeGreaterThan(10);
    expect(new THREE.Vector3(0, 0, -0.001).project(camera).z).toBeGreaterThan(
      -1
    );
    expect(new THREE.Vector3(0, 0, 1).project(camera).z).toBeGreaterThan(1);
  });

  it.each([0.01, 1, 1000])(
    'resolves the blade clearance throughout close-up assembly motion at scale %s',
    (scale) => {
      const camera = new THREE.PerspectiveCamera(45, 1.44, 0.1, 4000);
      const target = new THREE.Vector3(0, 0, 2.425).multiplyScalar(scale);
      camera.up.set(0, 0, 1);
      camera.position.set(0, 65 * scale, 30 * scale);
      camera.lookAt(target);
      const position = camera.position.clone();
      const orientation = camera.quaternion.clone();
      const focusDistance = position.distanceTo(target);
      const lower = new THREE.Box3(
        new THREE.Vector3(-88, -45, 0).multiplyScalar(scale),
        new THREE.Vector3(96, 16, 2.4).multiplyScalar(scale)
      );
      const upper = new THREE.Box3(
        new THREE.Vector3(-86, -16, 2.45).multiplyScalar(scale),
        new THREE.Vector3(96, 43, 4.85).multiplyScalar(scale)
      );
      const depthSteps = 2 ** 24 - 1;
      for (const angle of [0, -15, -30, -55, -30, 0]) {
        const bounds = lower
          .clone()
          .union(
            upper
              .clone()
              .applyMatrix4(
                new THREE.Matrix4().makeRotationZ(
                  THREE.MathUtils.degToRad(angle)
                )
              )
          );
        updateCameraClipping(camera, bounds, focusDistance);
        // A physical 0.05 mm gap must occupy distinct depth-buffer samples,
        // even when the moving body's coarse AABB reaches behind the camera.
        const depths = [2.4, 2.45].map((z) => {
          const ndc = new THREE.Vector3(0, 0, z * scale).project(camera).z;
          expect(ndc).toBeGreaterThan(-1);
          expect(ndc).toBeLessThan(1);
          return Math.round(((ndc + 1) / 2) * depthSteps);
        });
        expect(
          Math.abs(depths[0]! - depths[1]!),
          `joint ${angle}°`
        ).toBeGreaterThan(2);
        expect(camera.position.equals(position)).toBe(true);
        expect(camera.quaternion.equals(orientation)).toBe(true);
      }
    }
  );

  it('still permits a genuinely microscopic inspection distance', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    const bounds = new THREE.Box3(
      new THREE.Vector3(-10, -10, -10),
      new THREE.Vector3(10, 10, 10)
    );
    updateCameraClipping(camera, bounds, 0.001);
    expect(new THREE.Vector3(0, 0, -0.001).project(camera).z).toBeGreaterThan(
      -1
    );
    expect(camera.near).toBeGreaterThan(0);
  });

  it('allows orthographic depth on both sides of the camera', () => {
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -2000, 4000);
    const bounds = new THREE.Box3(
      new THREE.Vector3(-1, -1, -5000),
      new THREE.Vector3(1, 1, 5000)
    );
    updateCameraClipping(camera, bounds);
    expectInDepth(camera, bounds);
  });

  it('leaves empty, invalid and wholly behind-camera perspective bounds alone', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    for (const bounds of [
      new THREE.Box3(),
      new THREE.Box3(new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(1, 1, 1)),
      new THREE.Box3(new THREE.Vector3(-1, -1, 10), new THREE.Vector3(1, 1, 20))
    ])
      updateCameraClipping(camera, bounds);
    expect(camera.near).toBe(0.1);
    expect(camera.far).toBe(4000);
  });
});
