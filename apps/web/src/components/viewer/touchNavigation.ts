import {
  TouchGestureRecognizer,
  type TouchGesture,
  type TouchGestureOptions
} from '@openzcad/viewport';

/**
 * Touch input for the 3D viewport (L02 slice 3,
 * docs/plans/ipad-touch-plan-2026-11-05.md).
 *
 * A sequence's first finger still goes to the viewport's own press handling,
 * which decides whether it landed on something to drag: a handle, the move
 * gizmo, a footprint, a sketch tool's stroke. If it did, the press is the
 * viewport's ("claimed") and the finger behaves exactly as a mouse button
 * would. Otherwise the gesture recognizer owns it: a tap replays the release
 * to the viewport as the click it is, a drag orbits (or pans where rotation
 * is off), two fingers pan and pinch-zoom, a long press opens the context
 * menu, a double tap is a double click, and two- and three-finger taps step
 * history. Every finger after the first belongs to the recognizer, so a
 * second finger can never retarget the press the viewport is tracking.
 */

export interface TouchNavigationHost {
  /** The viewport's own pointerdown handling. */
  pressDown(event: PointerEvent): void;
  /**
   * After `pressDown`: whether the press became the viewport's own drag,
   * rather than a selection click or band it can give up.
   */
  pressClaimed(event: PointerEvent): boolean;
  pressMove(event: PointerEvent): void;
  pressUp(event: PointerEvent): void;
  pressCancel(event: PointerEvent): void;
  /** Drops an unclaimed press without selecting anything. */
  abandonPress(pointerId: number): void;
  /** False where the view must not turn (a sketch faces its plane). */
  canOrbit(): boolean;
  /** Starts an orbit pivoting on the point under the press. */
  beginOrbit(press: PointerEvent): void;
  orbitBy(deltaX: number, deltaY: number): void;
  beginPinch(): void;
  panBy(deltaX: number, deltaY: number): void;
  zoomBy(scale: number, clientX: number, clientY: number): void;
  endNavigation(): void;
  /** The context menu (or pick list) for the point under a held finger. */
  longPress(event: PointerEvent): void;
  /** Runs after the second tap's own click. */
  doubleTap(event: PointerEvent): void;
  history(step: 'undo' | 'redo'): void;
  now(): number;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
}

export interface TouchNavigation {
  /** Each returns false for a pointer this layer does not own. */
  down(event: PointerEvent): boolean;
  move(event: PointerEvent): boolean;
  up(event: PointerEvent): boolean;
  cancel(event: PointerEvent): boolean;
  /** Whether a touch sequence is in progress (a native dblclick is not ours). */
  readonly active: boolean;
  dispose(): void;
}

type Route = 'claimed' | 'gesture';

export function createTouchNavigation(
  host: TouchNavigationHost,
  options: Partial<TouchGestureOptions> = {}
): TouchNavigation {
  const recognizer = new TouchGestureRecognizer(options);
  const routes = new Map<number, Route>();
  /** Latest event per finger, for gestures reported away from an event. */
  const latest = new Map<number, PointerEvent>();
  /** The first finger's press the viewport is still tracking, unclaimed. */
  let pendingPress: number | null = null;
  /** The first finger's pointerdown: where an orbit pivots. */
  let pressEvent: PointerEvent | null = null;
  let navigation: 'orbit' | 'pan' | 'pinch' | null = null;
  let timer: number | null = null;

  const sample = (event: PointerEvent) => ({
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    time: host.now()
  });

  const giveUpPress = () => {
    if (pendingPress === null) return;
    host.abandonPress(pendingPress);
    pendingPress = null;
  };

  const endNavigation = () => {
    if (navigation === null) return;
    navigation = null;
    host.endNavigation();
  };

  const apply = (gestures: TouchGesture[], event: PointerEvent | null) => {
    for (const gesture of gestures) {
      switch (gesture.type) {
        case 'tap':
          if (event && pendingPress === event.pointerId) {
            pendingPress = null;
            host.pressUp(event);
            if (gesture.count === 2) host.doubleTap(event);
          }
          break;
        case 'long-press': {
          giveUpPress();
          const held = pressEvent && latest.get(pressEvent.pointerId);
          if (held) host.longPress(held);
          break;
        }
        case 'drag':
          if (gesture.phase === 'start') {
            giveUpPress();
            if (host.canOrbit() && pressEvent) {
              navigation = 'orbit';
              host.beginOrbit(pressEvent);
            } else {
              navigation = 'pan';
              host.beginPinch();
            }
          } else if (gesture.phase === 'move') {
            if (navigation === 'orbit') host.orbitBy(gesture.dx, gesture.dy);
            if (navigation === 'pan') host.panBy(gesture.dx, gesture.dy);
          } else {
            endNavigation();
          }
          break;
        case 'pinch':
          if (gesture.phase === 'start') {
            endNavigation();
            navigation = 'pinch';
            host.beginPinch();
          } else if (gesture.phase === 'move' && navigation === 'pinch') {
            host.panBy(gesture.dx, gesture.dy);
            host.zoomBy(gesture.scale, gesture.x, gesture.y);
          } else {
            endNavigation();
          }
          break;
        case 'multi-tap':
          host.history(gesture.fingers === 2 ? 'undo' : 'redo');
          break;
      }
    }
  };

  const schedule = () => {
    if (timer !== null) host.clearTimer(timer);
    timer = null;
    const deadline = recognizer.nextDeadline();
    if (deadline === null) return;
    timer = host.setTimer(
      () => {
        timer = null;
        apply(recognizer.tick(host.now()), null);
        schedule();
      },
      Math.max(0, deadline - host.now())
    );
  };

  const finish = (pointerId: number) => {
    routes.delete(pointerId);
    latest.delete(pointerId);
    if (pendingPress === pointerId) giveUpPress();
    if (routes.size === 0) {
      endNavigation();
      pressEvent = null;
    }
    schedule();
  };

  return {
    get active() {
      return routes.size > 0;
    },

    down(event) {
      if (event.pointerType !== 'touch') return false;
      const first = routes.size === 0;
      latest.set(event.pointerId, event);
      const gestures = recognizer.down(sample(event));
      if (first) {
        pressEvent = event;
        host.pressDown(event);
        if (host.pressClaimed(event)) {
          routes.set(event.pointerId, 'claimed');
          recognizer.claim(event.pointerId);
        } else {
          routes.set(event.pointerId, 'gesture');
          pendingPress = event.pointerId;
        }
      } else {
        routes.set(event.pointerId, 'gesture');
        // A second finger means this was never the first finger's click.
        giveUpPress();
      }
      apply(gestures, event);
      schedule();
      return true;
    },

    move(event) {
      const route = routes.get(event.pointerId);
      if (!route) return false;
      latest.set(event.pointerId, event);
      const gestures = recognizer.move(sample(event));
      if (route === 'claimed') host.pressMove(event);
      else apply(gestures, event);
      schedule();
      return true;
    },

    up(event) {
      const route = routes.get(event.pointerId);
      if (!route) return false;
      latest.set(event.pointerId, event);
      const gestures = recognizer.up(sample(event));
      if (route === 'claimed') host.pressUp(event);
      else apply(gestures, event);
      finish(event.pointerId);
      return true;
    },

    cancel(event) {
      const route = routes.get(event.pointerId);
      if (!route) return false;
      const gestures = recognizer.cancel(sample(event));
      if (route === 'claimed') host.pressCancel(event);
      else apply(gestures, event);
      finish(event.pointerId);
      return true;
    },

    dispose() {
      if (timer !== null) host.clearTimer(timer);
      timer = null;
      apply(recognizer.reset(), null);
      giveUpPress();
      endNavigation();
      routes.clear();
      latest.clear();
    }
  };
}
