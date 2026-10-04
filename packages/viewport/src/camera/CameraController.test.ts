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
    ((event: FakeWheelEvent) => void) | undefined;
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
  return controller.activeCamera.position.distanceTo(
    controller.controls.target
  );
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
    // With no frames drawn, the settle waits out the glide's cap once.
    vi.advanceTimersByTime(120 + 200);
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
    // Not while the release glide could still be in flight…
    vi.advanceTimersByTime(120);
    expect(onViewSettled).not.toHaveBeenCalled();
    // …but once its cap has passed, even with no frames drawn.
    vi.advanceTimersByTime(200);

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

/**
 * One clock for the frame timestamps handed to `stepOrbit`, the
 * `performance.now()` the controller reads at release, and its settle timer,
 * as in the browser: a slow frame lets that timer fire between frames.
 */
function frameClock(start = 5_000) {
  let at = start;
  vi.spyOn(performance, 'now').mockImplementation(() => at);
  return {
    tick(ms: number) {
      at += ms;
      vi.advanceTimersByTime(ms);
      return at;
    }
  };
}

/**
 * Drags the external orbit through the same 240 px over 200 ms of frames,
 * releases it, and replays the render loop at `hz` until the controller
 * reports idle. Times are ms from release, which follows the last drag frame.
 */
function flickAndRelease(hz: number) {
  const { controller, onViewSettled } = createController(false);
  const clock = frameClock();
  const frameMs = 1000 / hz;
  controller.beginOrbitDrag();
  const dragFrames = Math.max(1, Math.round(hz * 0.2));
  let now = 0;
  for (let frame = 0; frame < dragFrames; frame += 1) {
    now = clock.tick(frameMs);
    controller.orbitByPixels(240 / dragFrames, 0);
    controller.stepOrbit(now);
  }
  const releasedAt = now;
  controller.endOrbitDrag();
  const azimuths: number[] = [controller.controls.getAzimuthalAngle()];
  let lastMoveAt = releasedAt;
  let idleFrames = 0;
  for (let frame = 0; frame < 600 && idleFrames < 10; frame += 1) {
    now = clock.tick(frameMs);
    const moving = controller.stepOrbit(now);
    const azimuth = controller.controls.getAzimuthalAngle();
    if (moving) {
      // Once idle, the loop stays idle: no late landing wakes it.
      expect(idleFrames).toBe(0);
      lastMoveAt = now;
      azimuths.push(azimuth);
    } else {
      idleFrames += 1;
      expect(azimuth).toBeCloseTo(azimuths.at(-1) ?? Number.NaN, 12);
    }
  }
  const steps = azimuths.slice(1).map((value, index) => {
    return value - (azimuths[index] ?? value);
  });
  return {
    controller,
    onViewSettled,
    frameMs,
    settleMs: lastMoveAt - releasedAt,
    restingPosition: controller.activeCamera.position.clone(),
    steps
  };
}

describe('CameraController orbit release glide', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('settles within 200 ms of release at 60 Hz, then reports idle', () => {
    const { controller, onViewSettled, settleMs, steps } = flickAndRelease(60);
    // Premise: the release carried residual velocity into a visible glide.
    expect(steps.length).toBeGreaterThan(3);
    expect(settleMs).toBeLessThanOrEqual(200 + 1e-6);
    // Idle is exact: further frames neither move nor wake the loop.
    const rest = controller.activeCamera.position.clone();
    expect(controller.stepOrbit(20_000)).toBe(false);
    expect(controller.stepOrbit(20_016)).toBe(false);
    expect(controller.activeCamera.position.distanceTo(rest)).toBeLessThan(
      1e-9
    );
    vi.advanceTimersByTime(120);
    expect(onViewSettled).toHaveBeenLastCalledWith(controller.capture());
    controller.dispose();
  });

  it('decays monotonically with no overshoot', () => {
    const { controller, steps } = flickAndRelease(60);
    const direction = Math.sign(steps[0] ?? 0);
    expect(direction).not.toBe(0);
    steps.forEach((step, index) => {
      expect(Math.sign(step)).toBe(direction);
      if (index > 0) {
        expect(Math.abs(step)).toBeLessThan(Math.abs(steps[index - 1] ?? 0));
      }
    });
    controller.dispose();
  });

  it.each([5, 10, 30, 120, 144])(
    'lands on the first frame at or past 200 ms, on the same pose, at %i Hz',
    (hz) => {
      const reference = flickAndRelease(60);
      const run = flickAndRelease(hz);
      // Wall-clock from release: a slow first frame does not push it later.
      expect(run.settleMs).toBeGreaterThanOrEqual(200 - 1e-6);
      expect(run.settleMs).toBeLessThan(200 + run.frameMs - 1e-6);
      // The same drag leaves the same residue, and the glide plays all of it
      // out, so the resting pose does not depend on the frame rate.
      expect(
        run.restingPosition.distanceTo(reference.restingPosition)
      ).toBeLessThan(1e-6);
      reference.controller.dispose();
      run.controller.dispose();
    }
  );

  it('keeps the settle timer from landing a frame-starved glide early', () => {
    const reference = flickAndRelease(60);
    const { controller, onViewSettled } = createController(false);
    const clock = frameClock();
    controller.beginOrbitDrag();
    controller.orbitByPixels(240, 0);
    controller.stepOrbit(clock.tick(200));
    controller.endOrbitDrag();
    const released = controller.activeCamera.position.clone();
    const settlesAtRelease = onViewSettled.mock.calls.length;
    // 5 Hz: the settle delay passes before the next frame. No jump, and
    // nothing is persisted mid-glide.
    clock.tick(120);
    expect(controller.activeCamera.position.distanceTo(released)).toBe(0);
    expect(onViewSettled).toHaveBeenCalledTimes(settlesAtRelease);
    // The first frame at the cap lands the glide on the curve's end.
    expect(controller.stepOrbit(clock.tick(80))).toBe(true);
    expect(
      controller.activeCamera.position.distanceTo(reference.restingPosition)
    ).toBeLessThan(1e-6);
    const landed = controller.capture();
    // Persisted once the landing settles, and not before.
    clock.tick(120);
    expect(onViewSettled).toHaveBeenCalledTimes(settlesAtRelease + 1);
    const persisted = onViewSettled.mock.lastCall?.[0] as
      { position: THREE.Vector3Tuple } | undefined;
    expect(
      new THREE.Vector3(...(persisted?.position ?? [NaN, NaN, NaN])).distanceTo(
        new THREE.Vector3(...landed.position)
      )
    ).toBeLessThan(1e-9);
    expect(controller.stepOrbit(clock.tick(16))).toBe(false);
    reference.controller.dispose();
    controller.dispose();
  });

  it('lands a glide that gets no frames once the cap has passed', () => {
    const { controller, onViewSettled } = createController(false);
    const clock = frameClock();
    controller.beginOrbitDrag();
    controller.orbitByPixels(240, 0);
    controller.stepOrbit(clock.tick(16));
    controller.endOrbitDrag();
    const released = controller.activeCamera.position.clone();
    // A hidden tab draws nothing; the settle path lands it after the cap.
    clock.tick(150);
    expect(controller.activeCamera.position.distanceTo(released)).toBe(0);
    clock.tick(200);
    expect(
      controller.activeCamera.position.distanceTo(released)
    ).toBeGreaterThan(0);
    expect(onViewSettled).toHaveBeenLastCalledWith(controller.capture());
    expect(controller.stepOrbit(clock.tick(16))).toBe(false);
    controller.dispose();
  });

  it('hands a grab mid-glide back to tight tracking with no late landing', () => {
    const { controller } = createController(false);
    const clock = frameClock();
    const frameMs = 1000 / 60;
    controller.beginOrbitDrag();
    for (let frame = 0; frame < 12; frame += 1) {
      controller.orbitByPixels(20, 0);
      controller.stepOrbit(clock.tick(frameMs));
    }
    controller.endOrbitDrag();
    expect(controller.stepOrbit(clock.tick(frameMs))).toBe(true);
    // Held still, the residue drains on the drag regime's steady decay; a
    // glide left armed would land it all in one jump at the 200 ms cap.
    controller.beginOrbitDrag();
    let previous = controller.controls.getAzimuthalAngle();
    let previousStep = Infinity;
    for (let frame = 0; frame < 30; frame += 1) {
      controller.stepOrbit(clock.tick(frameMs));
      const azimuth = controller.controls.getAzimuthalAngle();
      const step = Math.abs(azimuth - previous);
      expect(step).toBeLessThanOrEqual(previousStep + 1e-12);
      previous = azimuth;
      previousStep = step;
    }
    controller.endOrbitDrag();
    controller.dispose();
  });
});

describe('CameraController wheel device detection', () => {
  it('zooms an accelerated slow notch instead of panning it', () => {
    const clock = isolatedNotchClock();
    const { controller, wheel, onViewChange } = createController();
    const target = controller.controls.target.clone();
    const distance = orbitDistance(controller);
    clock.next();
    // macOS acceleration: a slow wheel notch reaches the page as a few
    // pixels, finer than the old classifier's notch threshold.
    const event = wheel({ deltaY: -4 });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    // No pan: the target stays put and nothing was published synchronously.
    expect(controller.controls.target).toEqual(target);
    expect(onViewChange).not.toHaveBeenCalled();
    // A zoom was queued instead, and it moves the camera in.
    controller.stepZoom(1_000);
    expect(orbitDistance(controller)).toBeLessThan(distance);
    clock.restore();
    controller.dispose();
  });

  it('pans a remembered trackpad and reports a newly proved one', () => {
    const memory = { read: vi.fn(() => null), write: vi.fn() };
    const onWheelDeviceLearned = vi.fn();
    const host = fakeElement(800, 600);
    const controller = new CameraController({
      host,
      domElement: fakeElement(800, 600),
      requestRender: vi.fn(),
      onViewChange: vi.fn(),
      onViewSettled: vi.fn(),
      reducedMotion: () => true,
      zoomToCursor: () => true,
      middleDrag: () => 'pan',
      wheelDeviceMemory: memory,
      onWheelDeviceLearned
    });
    const listener = (
      host.addEventListener as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.find((call) => call[0] === 'wheel')?.[1] as (
      event: FakeWheelEvent
    ) => void;
    const packet = (overrides: Partial<FakeWheelEvent>): FakeWheelEvent => ({
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      ctrlKey: false,
      buttons: 0,
      clientX: 400,
      clientY: 300,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
      ...overrides
    });
    expect(memory.read).toHaveBeenCalledTimes(1);

    let at = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => at);
    // A diagonal swipe proves the trackpad once, and only once.
    listener(packet({ deltaX: 2, deltaY: -9 }));
    at += 16;
    listener(packet({ deltaX: 1, deltaY: -12 }));
    expect(memory.write).toHaveBeenCalledTimes(1);
    expect(memory.write).toHaveBeenCalledWith('trackpad');
    expect(onWheelDeviceLearned).toHaveBeenCalledTimes(1);

    // The next gesture pans on vertical motion rather than zooming.
    at += 1_000;
    const target = controller.controls.target.clone();
    listener(packet({ deltaY: -6 }));
    expect(controller.controls.target).not.toEqual(target);
    expect(controller.stepZoom(at)).toBe(false);
    controller.dispose();
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
