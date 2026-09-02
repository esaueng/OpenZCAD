import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  advanceWheelZoom,
  applyAnchoredZoom,
  createZoomProjectionScratch,
  targetPlanePoint,
  wheelDeltaToLogScale
} from './wheelZoom';

function settleAt(frameMs: number, impulse: number): number {
  let pending = impulse;
  let applied = 0;
  for (let frame = 0; frame < 240 && pending !== 0; frame += 1) {
    const step = advanceWheelZoom(pending, frameMs, false);
    applied += step.appliedLogScale;
    pending = step.remainingLogScale;
  }
  expect(pending).toBe(0);
  return applied;
}

describe('wheel zoom', () => {
  it('preserves OrbitControls delta, pinch, and adaptive-speed scaling', () => {
    const pixel = wheelDeltaToLogScale({
      deltaY: 120,
      deltaMode: 0,
      ctrlKey: false,
      controlKeyActive: false,
      zoomSpeed: 1
    });
    expect(pixel).toBeCloseTo(-Math.log(0.95) * 1.2, 12);
    expect(
      wheelDeltaToLogScale({
        deltaY: 3,
        deltaMode: 1,
        ctrlKey: false,
        controlKeyActive: false,
        zoomSpeed: 2
      })
    ).toBeCloseTo(-Math.log(0.95) * 0.48 * 2, 12);
    expect(
      wheelDeltaToLogScale({
        deltaY: 1,
        deltaMode: 2,
        ctrlKey: false,
        controlKeyActive: false,
        zoomSpeed: 1
      })
    ).toBeCloseTo(-Math.log(0.95), 12);

    const pinch = wheelDeltaToLogScale({
      deltaY: -2,
      deltaMode: 0,
      ctrlKey: true,
      controlKeyActive: false,
      zoomSpeed: 1
    });
    const physicalControlWheel = wheelDeltaToLogScale({
      deltaY: -2,
      deltaMode: 0,
      ctrlKey: true,
      controlKeyActive: true,
      zoomSpeed: 1
    });
    expect(pinch).toBeCloseTo(physicalControlWheel * 10, 12);
  });

  it('reaches the same exact target at common refresh rates', () => {
    const impulse = 0.62;
    for (const frameMs of [1000 / 30, 1000 / 60, 1000 / 120]) {
      expect(settleAt(frameMs, impulse)).toBeCloseTo(impulse, 12);
    }
  });

  it('bounds a batched pinch and supports immediate reduced motion', () => {
    const smooth = advanceWheelZoom(0.8, 1000 / 60, false);
    expect(Math.abs(smooth.appliedLogScale)).toBeLessThanOrEqual(0.05 + 1e-12);
    expect(smooth.remainingLogScale).toBeGreaterThan(0);
    expect(advanceWheelZoom(-0.8, 1000 / 60, true)).toEqual({
      appliedLogScale: -0.8,
      remainingLogScale: 0
    });
  });

  it('keeps a perspective pointer anchor fixed while changing distance', () => {
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 4000);
    camera.position.set(8, -12, 10);
    camera.up.set(0, 0, 1);
    const target = new THREE.Vector3(1, 2, 0);
    camera.lookAt(target);
    const pointer = new THREE.Vector2(0.45, -0.25);
    const scratch = createZoomProjectionScratch();
    const anchor = targetPlanePoint(camera, target, pointer, scratch).clone();
    const beforeDistance = camera.position.distanceTo(target);

    expect(
      applyAnchoredZoom(camera, target, pointer, Math.log(0.8), true, scratch)
    ).toBe(true);
    const projected = anchor.clone().project(camera);
    expect(projected.x).toBeCloseTo(pointer.x, 10);
    expect(projected.y).toBeCloseTo(pointer.y, 10);
    expect(camera.position.distanceTo(target)).toBeCloseTo(
      beforeDistance * 0.8,
      10
    );
  });

  it('keeps an orthographic pointer anchor fixed while changing zoom', () => {
    const camera = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, -100, 100);
    camera.position.set(8, -12, 10);
    camera.up.set(0, 0, 1);
    const target = new THREE.Vector3(1, 2, 0);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    const pointer = new THREE.Vector2(-0.35, 0.3);
    const scratch = createZoomProjectionScratch();
    const anchor = targetPlanePoint(camera, target, pointer, scratch).clone();

    expect(
      applyAnchoredZoom(camera, target, pointer, Math.log(0.75), true, scratch)
    ).toBe(true);
    const projected = anchor.clone().project(camera);
    expect(projected.x).toBeCloseTo(pointer.x, 10);
    expect(projected.y).toBeCloseTo(pointer.y, 10);
    expect(camera.zoom).toBeCloseTo(1 / 0.75, 10);
  });

  it('leaves the target fixed for centre zoom', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    camera.position.set(10, -10, 10);
    const target = new THREE.Vector3(1, 2, 3);
    camera.lookAt(target);
    const before = target.clone();
    applyAnchoredZoom(
      camera,
      target,
      new THREE.Vector2(0.7, -0.4),
      Math.log(1.2),
      false,
      createZoomProjectionScratch()
    );
    expect(target.toArray()).toEqual(before.toArray());
  });
});
