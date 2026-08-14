import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CameraController } from './CameraController';

function fakeElement(width: number, height: number): HTMLElement {
  const root = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };
  const ownerDocument = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };
  return {
    clientWidth: width,
    clientHeight: height,
    style: {},
    ownerDocument,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getRootNode: () => root
  } as unknown as HTMLElement;
}

function createController(reducedMotion = true) {
  const requestRender = vi.fn();
  const onViewChange = vi.fn();
  const onViewSettled = vi.fn();
  const controller = new CameraController({
    host: fakeElement(800, 600),
    domElement: fakeElement(800, 600),
    requestRender,
    onViewChange,
    onViewSettled,
    reducedMotion: () => reducedMotion,
    zoomToCursor: () => true,
    middleDrag: () => 'pan'
  });
  return { controller, requestRender, onViewChange, onViewSettled };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CameraController external orbit lifecycle', () => {
  it.each(['perspective', 'orthographic'] as const)(
    'keeps %s camera matrices current after an orbit step',
    (projection) => {
      const { controller } = createController();
      controller.applyProjection(projection);
      controller.beginOrbitDrag();
      controller.orbitByPixels(28, -16);
      controller.stepOrbit(performance.now());

      const camera = controller.activeCamera;
      const anchor = new THREE.Vector3(12, -7, 5);
      const projectedBeforeMatrixRefresh = anchor.clone().project(camera);
      camera.updateMatrixWorld(true);
      const projectedAfterMatrixRefresh = anchor.clone().project(camera);

      expect(
        projectedBeforeMatrixRefresh.distanceTo(projectedAfterMatrixRefresh)
      ).toBeLessThan(1e-10);
      controller.dispose();
    }
  );

  it.each(['perspective', 'orthographic'] as const)(
    'preserves target, finite distance, and %s projection',
    (projection) => {
      const { controller } = createController();
      controller.controls.target.set(7, -3, 2);
      controller.controls.update();
      controller.applyProjection(projection);
      const before = controller.capture();
      const beforeDistance = controller.activeCamera.position.distanceTo(
        new THREE.Vector3(...before.target)
      );

      controller.beginOrbitDrag();
      controller.orbitByPixels(28, -16);
      controller.endOrbitDrag();

      const after = controller.capture();
      const afterDistance = controller.activeCamera.position.distanceTo(
        new THREE.Vector3(...after.target)
      );
      expect(controller.projection).toBe(projection);
      after.target.forEach((value, index) => {
        expect(value).toBeCloseTo(before.target[index] ?? Number.NaN, 10);
      });
      expect(after.position.every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(afterDistance)).toBe(true);
      expect(afterDistance).toBeCloseTo(beforeDistance, 10);
      expect(after.orthographicZoom).toBeCloseTo(before.orthographicZoom, 10);

      controller.dispose();
    }
  );

  it('does not run a stale damping settle in the middle of a new drag', () => {
    const { controller, onViewSettled } = createController(false);
    controller.beginOrbitDrag();
    controller.orbitByPixels(20, 10);
    controller.endOrbitDrag();

    controller.beginOrbitDrag();
    controller.orbitByPixels(-8, 4);
    const settlesWhileActive = onViewSettled.mock.calls.length;
    vi.advanceTimersByTime(120);
    expect(onViewSettled).toHaveBeenCalledTimes(settlesWhileActive);

    controller.endOrbitDrag();
    vi.advanceTimersByTime(120);
    expect(onViewSettled.mock.calls.length).toBeGreaterThan(settlesWhileActive);
    controller.dispose();
  });

  it('publishes a gesture pose immediately but persists only its settled frame', () => {
    const { controller, onViewChange, onViewSettled } = createController(false);
    controller.beginOrbitDrag();
    controller.orbitByPixels(24, -12);

    expect(onViewChange).toHaveBeenCalled();
    expect(onViewChange).toHaveBeenLastCalledWith(controller.capture());
    expect(onViewSettled).not.toHaveBeenCalled();

    // A fixed-delay writer would fire here even though the pointer is held.
    vi.advanceTimersByTime(120);
    expect(onViewSettled).not.toHaveBeenCalled();

    controller.endOrbitDrag();
    vi.advanceTimersByTime(120);

    expect(onViewSettled).toHaveBeenCalledTimes(1);
    expect(onViewSettled).toHaveBeenLastCalledWith(controller.capture());
    controller.dispose();
  });

  it('keeps a re-pivot live during a hold and persists it after release', () => {
    const { controller, onViewChange, onViewSettled } = createController();
    controller.beginOrbitDrag();
    controller.pivotOn(new THREE.Vector3(12, -4, 5));
    const held = controller.capture();

    expect(onViewChange).toHaveBeenLastCalledWith(held);
    expect(onViewSettled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120);
    expect(onViewSettled).not.toHaveBeenCalled();

    controller.endOrbitDrag();
    vi.advanceTimersByTime(120);
    expect(onViewSettled).toHaveBeenCalledTimes(1);
    expect(onViewSettled).toHaveBeenLastCalledWith(controller.capture());
    controller.dispose();
  });

  it('does not persist an intermediate programmatic glide pose', () => {
    const { controller, onViewSettled } = createController(false);
    const start = performance.now();
    controller.startTween({
      position: new THREE.Vector3(0, 0, 150),
      target: new THREE.Vector3(5, 2, 1),
      near: 0.1,
      far: 4000
    });
    controller.stepTween(start + 200);
    vi.advanceTimersByTime(120);
    expect(onViewSettled).not.toHaveBeenCalled();

    controller.stepTween(start + 10_000);
    vi.advanceTimersByTime(120);
    expect(onViewSettled).toHaveBeenCalledTimes(1);
    expect(onViewSettled).toHaveBeenLastCalledWith(controller.capture());
    controller.dispose();
  });

  it('keeps orbiting world-up after a projection switch mid-glide', () => {
    const { controller } = createController(false);
    const start = performance.now();
    controller.startTween({
      position: new THREE.Vector3(0, 0.015, -150),
      target: new THREE.Vector3(0, 0, 0),
      near: 0.1,
      far: 4000
    });
    controller.stepTween(start + 260);
    // Premise: the glide is mid-flight with a slerped, non-world up.
    expect(controller.hasActiveTween).toBe(true);
    expect(
      controller.perspective.up.distanceTo(new THREE.Vector3(0, 0, 1))
    ).toBeGreaterThan(0.01);

    controller.applyProjection('orthographic');
    controller.stepTween(start + 10_000);

    const camera = controller.activeCamera;
    expect(controller.hasActiveTween).toBe(false);
    expect(camera.up.distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(
      1e-12
    );

    // A purely horizontal orbit spins about the up axis the rebound controls
    // captured, so the camera's height over the target must not change; a
    // tilted snapshot would bleed it into Z.
    const heightBefore = camera.position.z - controller.controls.target.z;
    controller.beginOrbitDrag();
    controller.orbitByPixels(40, 0);
    controller.stepOrbit(performance.now());
    controller.endOrbitDrag();
    const heightAfter = camera.position.z - controller.controls.target.z;
    expect(heightAfter).toBeCloseTo(heightBefore, 6);
    controller.dispose();
  });

  it('cancels an active external orbit and pending settle on dispose', () => {
    const { controller, requestRender, onViewChange, onViewSettled } =
      createController(false);
    controller.beginOrbitDrag();
    controller.orbitByPixels(12, -6);
    const rendersAtDispose = requestRender.mock.calls.length;
    const changesAtDispose = onViewChange.mock.calls.length;
    const settlesAtDispose = onViewSettled.mock.calls.length;

    expect(() => controller.dispose()).not.toThrow();
    vi.runOnlyPendingTimers();
    controller.endOrbitDrag();
    controller.orbitByPixels(12, -6);

    expect(controller.stepOrbit(performance.now() + 1_000)).toBe(false);
    expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
    expect(onViewChange).toHaveBeenCalledTimes(changesAtDispose);
    expect(onViewSettled).toHaveBeenCalledTimes(settlesAtDispose);
    expect(() => controller.dispose()).not.toThrow();
  });
});
