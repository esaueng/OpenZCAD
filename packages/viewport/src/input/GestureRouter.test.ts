import { describe, expect, it } from 'vitest';
import { CLICK_THRESHOLD_PX, GestureRouter } from './GestureRouter';

function makeRouter(clickThresholdPx?: number) {
  const captured = new Set<number>();
  const element = {
    style: { cursor: '' },
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id)
  } as unknown as HTMLElement;
  let controlsEnabled = true;
  const router = new GestureRouter({
    domElement: element,
    setControlsEnabled: (enabled) => {
      controlsEnabled = enabled;
    },
    ...(clickThresholdPx === undefined ? {} : { clickThresholdPx })
  });
  return {
    router,
    element,
    captured,
    controlsEnabled: () => controlsEnabled
  };
}

const at = (x: number, y: number, pointerId = 1) =>
  ({ pointerId, clientX: x, clientY: y }) as PointerEvent;

describe('claiming a drag', () => {
  it('captures the pointer, parks the controls, and sets the cursor', () => {
    const { router, element, captured, controlsEnabled } = makeRouter();

    router.capture(at(10, 10));

    expect(captured.has(1)).toBe(true);
    expect(controlsEnabled()).toBe(false);
    expect(element.style.cursor).toBe('grabbing');
  });

  it('restores the pre-drag cursor on release', () => {
    const { router, element, captured, controlsEnabled } = makeRouter();
    element.style.cursor = 'grab';

    router.capture(at(10, 10));
    expect(element.style.cursor).toBe('grabbing');

    router.release(at(20, 20));
    expect(element.style.cursor).toBe('grab');
    expect(captured.has(1)).toBe(false);
    expect(controlsEnabled()).toBe(true);
  });

  it('honours an explicit cursor on release', () => {
    const { router, element } = makeRouter();
    router.capture(at(10, 10));
    router.release(at(20, 20), 'grab');
    expect(element.style.cursor).toBe('grab');
  });

  it('leaves the cursor alone when the gesture asks it to', () => {
    const { router, element } = makeRouter();
    element.style.cursor = 'crosshair';
    router.capture(at(10, 10), null);
    expect(element.style.cursor).toBe('crosshair');
  });
});

describe('teardown happens exactly once', () => {
  it('is safe to release twice', () => {
    const { router, controlsEnabled, captured } = makeRouter();
    router.capture(at(10, 10));

    expect(router.release(at(20, 20))).not.toBeNull();
    expect(router.release(at(20, 20))).toBeNull();
    expect(controlsEnabled()).toBe(true);
    expect(captured.size).toBe(0);
  });

  it('ignores a release for a different pointer', () => {
    const { router, controlsEnabled, captured } = makeRouter();
    router.capture(at(10, 10, 1));

    expect(router.release(at(20, 20, 2))).toBeNull();
    expect(controlsEnabled()).toBe(false);
    expect(captured.has(1)).toBe(true);
  });

  it('still restores the controls when capture was lost externally', () => {
    const { router, captured, controlsEnabled } = makeRouter();
    router.capture(at(10, 10));
    // The browser can revoke capture out from under us on pointercancel.
    captured.delete(1);

    router.release(at(20, 20));
    expect(controlsEnabled()).toBe(true);
  });

  it('reset restores a gesture that never got its pointerup', () => {
    const { router, controlsEnabled, captured } = makeRouter();
    router.capture(at(10, 10));

    router.reset();
    expect(controlsEnabled()).toBe(true);
    expect(captured.size).toBe(0);
    expect(router.active).toBeNull();
  });
});

describe('click versus drag', () => {
  it('treats a press that barely moves as a click', () => {
    const { router } = makeRouter();
    router.begin(at(100, 100));
    expect(router.hasMoved(at(102, 101))).toBe(false);
  });

  it('treats a press past the threshold as a drag', () => {
    const { router } = makeRouter();
    router.begin(at(100, 100));
    expect(router.hasMoved(at(100 + CLICK_THRESHOLD_PX + 1, 100))).toBe(true);
  });

  it('stays a drag after the pointer returns to where it started', () => {
    const { router } = makeRouter();
    router.begin(at(100, 100));

    router.track(at(140, 140));
    expect(router.hasMoved(at(100, 100))).toBe(true);
  });

  it('honours a custom threshold', () => {
    const { router } = makeRouter(20);
    router.begin(at(100, 100));
    expect(router.hasMoved(at(110, 100))).toBe(false);
    expect(router.hasMoved(at(130, 100))).toBe(true);
  });

  it('reports no movement for a pointer it never saw', () => {
    const { router } = makeRouter();
    expect(router.hasMoved(at(100, 100))).toBe(false);
  });

  it('does not park the controls for a press that stays a click', () => {
    const { router, controlsEnabled, captured } = makeRouter();
    router.begin(at(100, 100));
    expect(controlsEnabled()).toBe(true);
    expect(captured.size).toBe(0);
  });

  it('promotes a recorded press to a capture without losing its origin', () => {
    const { router } = makeRouter();
    router.begin(at(100, 100));
    const press = router.capture(at(103, 100));
    expect(press.startX).toBe(100);
    expect(press.captured).toBe(true);
  });
});
