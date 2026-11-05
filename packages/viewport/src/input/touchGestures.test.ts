import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOUCH_GESTURE_OPTIONS,
  TouchGestureRecognizer,
  type TouchGesture
} from './touchGestures';

const { slopPx, longPressMs, doubleTapMs, multiTapMs } =
  DEFAULT_TOUCH_GESTURE_OPTIONS;

/** A recognizer plus a log of everything it reported, in order. */
function setup() {
  const recognizer = new TouchGestureRecognizer();
  const log: TouchGesture[] = [];
  const record = (gestures: TouchGesture[]) => {
    log.push(...gestures);
    return gestures;
  };
  return {
    recognizer,
    log,
    down: (pointerId: number, x: number, y: number, time: number) =>
      record(recognizer.down({ pointerId, x, y, time })),
    move: (pointerId: number, x: number, y: number, time: number) =>
      record(recognizer.move({ pointerId, x, y, time })),
    up: (pointerId: number, x: number, y: number, time: number) =>
      record(recognizer.up({ pointerId, x, y, time })),
    cancel: (pointerId: number, x: number, y: number, time: number) =>
      record(recognizer.cancel({ pointerId, x, y, time })),
    tick: (time: number) => record(recognizer.tick(time)),
    types: () =>
      log.map((gesture) =>
        'phase' in gesture ? `${gesture.type}:${gesture.phase}` : gesture.type
      )
  };
}

describe('one finger', () => {
  it('taps where it lifts when it stays inside the slop', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.move(1, 100 + slopPx - 1, 100, 40);
    expect(t.up(1, 100 + slopPx - 1, 100, 80)).toEqual([
      { type: 'tap', x: 100 + slopPx - 1, y: 100, count: 1 }
    ]);
  });

  it('counts a quick second tap nearby as a double tap, and only once', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.up(1, 100, 100, 50);
    t.down(2, 110, 105, 150);
    t.up(2, 110, 105, 50 + doubleTapMs);
    t.down(3, 110, 105, 400);
    t.up(3, 110, 105, 430);
    expect(t.log.map((g) => (g.type === 'tap' ? g.count : null))).toEqual([
      1, 2, 1
    ]);
  });

  it('keeps a slow or distant second tap single', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.up(1, 100, 100, 50);
    t.down(2, 100, 100, 200);
    t.up(2, 100, 100, 51 + doubleTapMs);
    t.down(3, 200, 100, 400);
    t.up(3, 200, 100, 420);
    expect(t.log.map((g) => (g.type === 'tap' ? g.count : null))).toEqual([
      1, 1, 1
    ]);
  });

  it('drags past the slop, reporting travel from the press point', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    expect(t.move(1, 100 + slopPx + 2, 100, 20)).toEqual([
      { type: 'drag', phase: 'start', x: 100, y: 100, dx: 0, dy: 0 },
      {
        type: 'drag',
        phase: 'move',
        x: 100 + slopPx + 2,
        y: 100,
        dx: slopPx + 2,
        dy: 0
      }
    ]);
    t.move(1, 130, 90, 40);
    const moves = t.log.filter(
      (g): g is Extract<TouchGesture, { type: 'drag' }> =>
        g.type === 'drag' && g.phase === 'move'
    );
    // Increments sum to the whole travel: nothing is lost or counted twice.
    expect(moves.reduce((sum, g) => sum + g.dx, 0)).toBeCloseTo(30, 9);
    expect(moves.reduce((sum, g) => sum + g.dy, 0)).toBeCloseTo(-10, 9);
    t.up(1, 130, 90, 60);
    expect(t.types()).toEqual([
      'drag:start',
      'drag:move',
      'drag:move',
      'drag:end'
    ]);
  });

  it('never taps after a drag that came back to where it started', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.move(1, 140, 100, 20);
    t.move(1, 100, 100, 40);
    t.up(1, 100, 100, 60);
    expect(t.log.some((g) => g.type === 'tap')).toBe(false);
  });

  it('long-presses at the deadline, then reports nothing until lift', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    expect(t.recognizer.nextDeadline()).toBe(longPressMs);
    expect(t.tick(longPressMs - 1)).toEqual([]);
    expect(t.tick(longPressMs)).toEqual([
      { type: 'long-press', x: 100, y: 100 }
    ]);
    expect(t.recognizer.nextDeadline()).toBeNull();
    t.move(1, 200, 100, longPressMs + 50);
    t.up(1, 200, 100, longPressMs + 80);
    expect(t.types()).toEqual(['long-press']);
  });

  it('still long-presses when the host timer is late, instead of tapping', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.up(1, 100, 100, longPressMs + 200);
    expect(t.types()).toEqual(['long-press']);
  });

  it('does not long-press once the finger has dragged', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.move(1, 150, 100, 30);
    expect(t.tick(longPressMs * 2)).toEqual([]);
  });
});

describe('two fingers', () => {
  it('pinches with the midpoint travel and spread ratio', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.down(2, 200, 100, 20);
    // Spread 100 → 160, midpoint 150 → 150: a pure zoom.
    t.move(1, 70, 100, 40);
    t.move(2, 230, 100, 40);
    const pinches = t.log.filter(
      (g): g is Extract<TouchGesture, { type: 'pinch' }> => g.type === 'pinch'
    );
    expect(pinches[0]).toMatchObject({ phase: 'start', x: 150, y: 100 });
    const scale = pinches
      .filter((g) => g.phase === 'move')
      .reduce((product, g) => product * g.scale, 1);
    expect(scale).toBeCloseTo(160 / 100, 9);
    // Both fingers slide 40 px down together: a pure pan.
    t.move(1, 70, 140, 60);
    t.move(2, 230, 140, 60);
    const moves = t.log.filter(
      (g): g is Extract<TouchGesture, { type: 'pinch' }> =>
        g.type === 'pinch' && g.phase === 'move'
    );
    expect(moves.reduce((sum, g) => sum + g.dy, 0)).toBeCloseTo(40, 9);
    expect(moves.reduce((sum, g) => sum + g.dx, 0)).toBeCloseTo(0, 9);
    expect(moves.reduce((p, g) => p * g.scale, 1)).toBeCloseTo(1.6, 9);
  });

  it('lets a second finger end a one-finger drag and take over as a pinch', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.move(1, 130, 100, 20);
    t.down(2, 300, 100, 40);
    t.move(2, 340, 100, 60);
    expect(t.types()).toEqual([
      'drag:start',
      'drag:move',
      'drag:end',
      'pinch:start',
      'pinch:move'
    ]);
  });

  it('turns a press that had not become anything into a two-finger gesture', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.down(2, 200, 100, 60);
    expect(t.tick(longPressMs * 2)).toEqual([]);
    t.up(1, 100, 100, 100);
    t.up(2, 200, 100, 120);
    // No tap from the first finger: the pair was a two-finger tap.
    expect(t.types()).toEqual(['multi-tap']);
  });

  it('reports a quick still pair as a two-finger tap', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.down(2, 200, 100, 30);
    t.up(2, 202, 101, 120);
    expect(t.up(1, 101, 99, 150)).toEqual([{ type: 'multi-tap', fingers: 2 }]);
  });

  it('does not tap for a slow pair or one that moved', () => {
    const slow = setup();
    slow.down(1, 100, 100, 0);
    slow.down(2, 200, 100, 30);
    slow.up(1, 100, 100, multiTapMs + 1);
    slow.up(2, 200, 100, multiTapMs + 2);
    expect(slow.log).toEqual([]);

    const moved = setup();
    moved.down(1, 100, 100, 0);
    moved.down(2, 200, 100, 30);
    moved.up(2, 200, 100, 60);
    moved.move(1, 100 + slopPx + 1, 100, 70);
    moved.up(1, 100 + slopPx + 1, 100, 90);
    expect(moved.log).toEqual([]);
  });

  it('does not orbit with the finger left behind after a pinch', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.down(2, 200, 100, 10);
    t.move(2, 260, 100, 30);
    t.up(2, 260, 100, 50);
    t.move(1, 300, 300, 70);
    t.up(1, 300, 300, 90);
    expect(t.types()).toEqual(['pinch:start', 'pinch:move', 'pinch:end']);
  });

  it('holds the scale steady while the fingers are almost together', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.down(2, 102, 100, 10);
    t.move(2, 104, 100 + slopPx + 1, 30);
    const moves = t.log.filter(
      (g): g is Extract<TouchGesture, { type: 'pinch' }> =>
        g.type === 'pinch' && g.phase === 'move'
    );
    expect(moves.every((g) => g.scale === 1)).toBe(true);
  });
});

describe('three fingers', () => {
  it('reports a quick still trio as a three-finger tap', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.down(2, 150, 100, 20);
    t.down(3, 200, 100, 40);
    t.up(1, 100, 100, 150);
    t.up(2, 150, 100, 160);
    expect(t.up(3, 200, 100, 170)).toEqual([{ type: 'multi-tap', fingers: 3 }]);
  });

  it('never pinches, even after one of the three lifts', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.down(2, 150, 100, 20);
    t.down(3, 200, 100, 40);
    t.up(3, 200, 100, 60);
    t.move(2, 250, 100, 80);
    t.up(1, 100, 100, 100);
    t.up(2, 250, 100, 120);
    expect(t.log).toEqual([]);
  });

  it('ends a pinch when a third finger lands', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.down(2, 200, 100, 10);
    t.move(2, 260, 100, 30);
    t.down(3, 300, 300, 50);
    t.move(1, 0, 0, 60);
    expect(t.types()).toEqual(['pinch:start', 'pinch:move', 'pinch:end']);
  });
});

describe('the host taking a finger', () => {
  it('yields nothing more once a press is claimed for a handle drag', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.recognizer.claim(1);
    t.move(1, 200, 100, 20);
    t.down(2, 300, 100, 30);
    t.move(2, 360, 100, 40);
    t.up(2, 360, 100, 50);
    t.up(1, 200, 100, 60);
    expect(t.log).toEqual([]);
    // The claimed press is not the first half of a double tap.
    t.down(3, 200, 100, 100);
    expect(t.up(3, 200, 100, 120)).toMatchObject([{ type: 'tap', count: 1 }]);
  });

  it('cancels a drag in progress when its finger is claimed', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.move(1, 150, 100, 20);
    expect(t.recognizer.claim(1)).toMatchObject([
      { type: 'drag', phase: 'cancel' }
    ]);
  });

  it('cancels on pointercancel and starts afresh afterwards', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.down(2, 200, 100, 10);
    t.move(2, 260, 100, 30);
    t.cancel(1, 100, 100, 40);
    t.up(2, 260, 100, 50);
    expect(t.types()).toEqual(['pinch:start', 'pinch:move', 'pinch:cancel']);
    expect(t.recognizer.pointerCount).toBe(0);
    t.down(3, 50, 50, 100);
    expect(t.up(3, 50, 50, 120)).toMatchObject([{ type: 'tap', count: 1 }]);
  });

  it('ignores samples for fingers it never saw', () => {
    const t = setup();
    expect(t.move(9, 10, 10, 0)).toEqual([]);
    expect(t.up(9, 10, 10, 0)).toEqual([]);
    expect(t.cancel(9, 10, 10, 0)).toEqual([]);
    expect(t.recognizer.claim(9)).toEqual([]);
  });

  it('reset cancels a drag and forgets the last tap', () => {
    const t = setup();
    t.down(1, 100, 100, 0);
    t.up(1, 100, 100, 20);
    t.down(2, 100, 100, 40);
    t.move(2, 150, 100, 60);
    expect(t.recognizer.reset()).toMatchObject([
      { type: 'drag', phase: 'cancel' }
    ]);
    t.down(3, 100, 100, 80);
    expect(t.up(3, 100, 100, 100)).toMatchObject([{ type: 'tap', count: 1 }]);
  });
});
