import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  advanceWheelZoom,
  applyAnchoredZoom,
  createZoomProjectionScratch,
  targetPlanePoint,
  wheelDeltaToLogScale
} from './wheelZoom';

const REFRESH_RATES_HZ = [30, 60, 120];

/** Drains one impulse at a fixed frame period and returns every step taken. */
function drainAt(
  frameMs: number,
  impulse: number,
  reducedMotion = false
): number[] {
  let pending = impulse;
  const steps: number[] = [];
  for (let frame = 0; frame < 240 && pending !== 0; frame += 1) {
    const step = advanceWheelZoom(pending, frameMs, reducedMotion);
    steps.push(step.appliedLogScale);
    pending = step.remainingLogScale;
  }
  expect(pending).toBe(0);
  return steps;
}

function settleAt(frameMs: number, impulse: number): number {
  return drainAt(frameMs, impulse).reduce((sum, step) => sum + step, 0);
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
  });

  it.each(REFRESH_RATES_HZ)(
    'bounds every rendered step at %d Hz and still lands exactly',
    (hz) => {
      const frameMs = 1000 / hz;
      const impulse = -0.8;
      const steps = drainAt(frameMs, impulse);
      const perFrameCap = 3 * (frameMs / 1000) + 1e-12;
      expect(steps.length).toBeGreaterThan(1);
      for (const step of steps) {
        // Monotonic: no step ever moves against the burst.
        expect(step).toBeLessThanOrEqual(0);
        expect(Math.abs(step)).toBeLessThanOrEqual(perFrameCap);
      }
      expect(steps.reduce((sum, step) => sum + step, 0)).toBeCloseTo(
        impulse,
        12
      );
    }
  );

  it.each(REFRESH_RATES_HZ)(
    'reduced motion ramps at a constant bounded rate at %d Hz',
    (hz) => {
      const frameMs = 1000 / hz;
      const impulse = 0.8;
      const steps = drainAt(frameMs, impulse, true);
      const perFrameCap = 6 * (frameMs / 1000);
      // A burst never lands in one frame: that was the original defect.
      expect(steps.length).toBe(Math.ceil(impulse / perFrameCap));
      for (const step of steps.slice(0, -1)) {
        expect(step).toBeCloseTo(perFrameCap, 12);
      }
      expect(steps.at(-1)).toBeGreaterThan(0);
      expect(steps.at(-1)).toBeLessThanOrEqual(perFrameCap + 1e-12);
      expect(steps.reduce((sum, step) => sum + step, 0)).toBeCloseTo(
        impulse,
        12
      );
    }
  );

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
