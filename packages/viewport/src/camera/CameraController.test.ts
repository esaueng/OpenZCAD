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
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    getRootNode: () => root
  } as unknown as HTMLElement;
}

interface FakeWheelEvent {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  buttons: number;
  clientX: number;
  clientY: number;
  preventDefault: ReturnType<typeof vi.fn>;
  stopImmediatePropagation: ReturnType<typeof vi.fn>;
}

/** One notch of a physical wheel, in the pixel units browsers report. */
const WHEEL_NOTCH_DELTA = 120;
/** The exact log-scale one notch queues at OrbitControls' base speed. */
const NOTCH_LOG_SCALE = -Math.log(0.95) * 1.2;

function createController(reducedMotion = true) {
  const requestRender = vi.fn();
  const onViewChange = vi.fn();
  const onViewSettled = vi.fn();
  const host = fakeElement(800, 600);
  const controller = new CameraController({
    host,
    domElement: fakeElement(800, 600),
    requestRender,
    onViewChange,
    onViewSettled,
    reducedMotion: () => reducedMotion,
    zoomToCursor: () => true,
    middleDrag: () => 'pan'
  });
  const wheelListener = (
    host.addEventListener as unknown as ReturnType<typeof vi.fn>
  ).mock.calls.find((call) => call[0] === 'wheel')?.[1] as
    | ((event: FakeWheelEvent) => void)
    | undefined;
  /** Delivers one wheel packet the way the capture listener receives it. */
  const wheel = (overrides: Partial<FakeWheelEvent> = {}): FakeWheelEvent => {
    const event: FakeWheelEvent = {
      deltaX: 0,
      deltaY: -WHEEL_NOTCH_DELTA,
      deltaMode: 0,
      ctrlKey: false,
      buttons: 0,
      clientX: 560,
      clientY: 210,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
      ...overrides
    };
    expect(wheelListener).toBeDefined();
    wheelListener?.(event);
    return event;
  };
  return { controller, requestRender, onViewChange, onViewSettled, wheel };
}

/**
 * Wheel packets normally spaced far apart, so the velocity-adaptive speed
 * stays at base and every notch queues exactly `NOTCH_LOG_SCALE`.
 */
function isolatedNotchClock() {
  let at = 0;
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => at);
  return {
    next() {
      at += 10_000;
    },
    restore() {
      spy.mockRestore();
    }
  };
}

function orbitDistance(controller: CameraController): number {
  return controller.activeCamera.position.distanceTo(controller.controls.target);
}

/** Steps the zoom until it settles, returning the distance after each frame. */
function drainZoom(controller: CameraController, frameMs = 1000 / 60) {
  const distances: number[] = [];
  let now = 1_000;
  for (let frame = 0; frame < 600; frame += 1) {
    const zooming = controller.stepZoom(now);
    distances.push(orbitDistance(controller));
    if (!zooming) {
      break;
    }
    now += frameMs;
  }
  return distances;
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

describe('CameraController wheel zoom', () => {
  it('swallows a wheel packet while an external orbit or a button is held', () => {
    const { controller, wheel } = createController(false);
    const before = controller.capture();

    controller.beginOrbitDrag();
    const duringOrbit = wheel();
    // Claimed, so OrbitControls' own handler cannot dolly it in one frame.
    expect(duringOrbit.preventDefault).toHaveBeenCalledTimes(1);
    expect(duringOrbit.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(controller.stepZoom(1_000)).toBe(false);
    controller.endOrbitDrag();

    const withButton = wheel({ buttons: 1 });
    expect(withButton.preventDefault).toHaveBeenCalledTimes(1);
    expect(withButton.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(controller.stepZoom(1_016)).toBe(false);

    expect(controller.capture()).toEqual(before);
    controller.dispose();
  });

  it('spreads a burst across bounded frames even with reduced motion on', () => {
    const clock = isolatedNotchClock();
    const { controller, wheel } = createController(true);
    const start = orbitDistance(controller);
    const notches = 10;
    for (let notch = 0; notch < notches; notch += 1) {
      clock.next();
      expect(wheel().stopImmediatePropagation).toHaveBeenCalledTimes(1);
    }

    const frameMs = 1000 / 60;
    const distances = drainZoom(controller, frameMs);
    // The burst asked for ~46% closer; one frame may bring at most ~10%.
    expect(distances.length).toBeGreaterThan(1);
    let previous = start;
    for (const distance of distances) {
      expect(distance).toBeLessThanOrEqual(previous);
      expect(Math.log(previous / distance)).toBeLessThanOrEqual(
        6 * (frameMs / 1000) + 1e-9
      );
      previous = distance;
    }
    expect(distances.at(-1)).toBeCloseTo(
      start * Math.exp(-notches * NOTCH_LOG_SCALE),
      8
    );
    clock.restore();
    controller.dispose();
  });

  it('reverses mid-zoom without overshoot and lands on the net framing', () => {
    const clock = isolatedNotchClock();
    const { controller, wheel } = createController(false);
    const start = orbitDistance(controller);
    for (let notch = 0; notch < 4; notch += 1) {
      clock.next();
      wheel({ deltaY: -WHEEL_NOTCH_DELTA });
    }
    // Part way in: the first frames have to be moving closer.
    let now = 1_000;
    const frameMs = 1000 / 60;
    for (let frame = 0; frame < 3; frame += 1) {
      expect(controller.stepZoom(now)).toBe(true);
      now += frameMs;
    }
    const atReversal = orbitDistance(controller);
    expect(atReversal).toBeLessThan(start);

    for (let notch = 0; notch < 6; notch += 1) {
      clock.next();
      wheel({ deltaY: WHEEL_NOTCH_DELTA });
    }
    const distances: number[] = [];
    for (let frame = 0; frame < 600; frame += 1) {
      const zooming = controller.stepZoom(now);
      distances.push(orbitDistance(controller));
      if (!zooming) {
        break;
      }
      now += frameMs;
    }
    // Reversal takes effect on the very next frame and never doubles back.
    let previous = atReversal;
    for (const distance of distances) {
      expect(distance).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(Math.log(distance / previous)).toBeLessThanOrEqual(
        3 * (frameMs / 1000) + 1e-9
      );
      previous = distance;
    }
    // Four notches in, six out: the same framing as two notches out.
    expect(distances.at(-1)).toBeCloseTo(
      start * Math.exp(2 * NOTCH_LOG_SCALE),
      8
    );
    clock.restore();
    controller.dispose();
  });

  it('drops the remainder on a projection switch and zooms the new camera', () => {
    const clock = isolatedNotchClock();
    const { controller, wheel } = createController(false);
    clock.next();
    wheel();
    expect(controller.stepZoom(1_000)).toBe(true);

    controller.applyProjection('orthographic');
    const afterSwitch = controller.capture();
    expect(controller.stepZoom(1_016)).toBe(false);
    expect(controller.capture()).toEqual(afterSwitch);

    clock.next();
    wheel();
    const zooms: number[] = [];
    let now = 2_000;
    for (let frame = 0; frame < 600; frame += 1) {
      const zooming = controller.stepZoom(now);
      zooms.push(controller.orthographic.zoom);
      if (!zooming) {
        break;
      }
      now += 1000 / 60;
    }
    expect(zooms.length).toBeGreaterThan(1);
    let previous = afterSwitch.orthographicZoom;
    for (const zoom of zooms) {
      expect(zoom).toBeGreaterThanOrEqual(previous);
      previous = zoom;
    }
    // One notch in on the orthographic camera is the same ratio as in
    // perspective, applied to zoom instead of distance.
    expect(zooms.at(-1)).toBeCloseTo(
      afterSwitch.orthographicZoom * Math.exp(NOTCH_LOG_SCALE),
      8
    );
    clock.restore();
    controller.dispose();
  });
});
