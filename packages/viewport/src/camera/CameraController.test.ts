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
  const controller = new CameraController({
    host: fakeElement(800, 600),
    domElement: fakeElement(800, 600),
    requestRender,
    onViewChange,
    reducedMotion: () => reducedMotion,
    zoomToCursor: () => true,
    middleDrag: () => 'pan'
  });
  return { controller, requestRender, onViewChange };
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
    const { controller, onViewChange } = createController(false);
    controller.beginOrbitDrag();
    controller.orbitByPixels(20, 10);
    controller.endOrbitDrag();

    controller.beginOrbitDrag();
    controller.orbitByPixels(-8, 4);
    const changesWhileActive = onViewChange.mock.calls.length;
    vi.advanceTimersByTime(120);
    expect(onViewChange).toHaveBeenCalledTimes(changesWhileActive);

    controller.endOrbitDrag();
    vi.advanceTimersByTime(120);
    expect(onViewChange.mock.calls.length).toBeGreaterThan(changesWhileActive);
    controller.dispose();
  });

  it('cancels an active external orbit and pending settle on dispose', () => {
    const { controller, requestRender, onViewChange } = createController(false);
    controller.beginOrbitDrag();
    controller.orbitByPixels(12, -6);
    const rendersAtDispose = requestRender.mock.calls.length;
    const changesAtDispose = onViewChange.mock.calls.length;

    expect(() => controller.dispose()).not.toThrow();
    vi.runOnlyPendingTimers();
    controller.endOrbitDrag();
    controller.orbitByPixels(12, -6);

    expect(controller.stepOrbit(performance.now() + 1_000)).toBe(false);
    expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
    expect(onViewChange).toHaveBeenCalledTimes(changesAtDispose);
    expect(() => controller.dispose()).not.toThrow();
  });
});
