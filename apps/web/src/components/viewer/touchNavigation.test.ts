import { describe, expect, it } from 'vitest';
import {
  createTouchNavigation,
  type TouchNavigationHost
} from './touchNavigation';

/** A host that logs every call, with a manual clock and timer queue. */
function setup({ claim = false, canOrbit = true } = {}) {
  const calls: string[] = [];
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const log =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(
        args.length && typeof args[0] !== 'object'
          ? `${name}(${args.map((value) => (typeof value === 'number' ? Math.round(value * 1000) / 1000 : value)).join(',')})`
          : name
      );
    };
  const host: TouchNavigationHost = {
    pressDown: log('pressDown'),
    pressClaimed: () => claim,
    pressMove: log('pressMove'),
    pressUp: log('pressUp'),
    pressCancel: log('pressCancel'),
    abandonPress: log('abandonPress'),
    canOrbit: () => canOrbit,
    beginOrbit: log('beginOrbit'),
    orbitBy: log('orbitBy'),
    beginPinch: log('beginPinch'),
    panBy: log('panBy'),
    zoomBy: log('zoomBy'),
    endNavigation: log('endNavigation'),
    longPress: log('longPress'),
    doubleTap: log('doubleTap'),
    history: log('history'),
    now: () => now,
    setTimer(run, delay) {
      const id = nextTimer++;
      timers.set(id, { at: now + delay, run });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    }
  };
  const touch = createTouchNavigation(host);
  const event = (
    pointerId: number,
    clientX: number,
    clientY: number,
    pointerType = 'touch'
  ) => ({ pointerId, clientX, clientY, pointerType }) as PointerEvent;
  return {
    calls,
    touch,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
      }
    },
    down: (id: number, x: number, y: number, type?: string) =>
      touch.down(event(id, x, y, type)),
    move: (id: number, x: number, y: number) => touch.move(event(id, x, y)),
    up: (id: number, x: number, y: number) => touch.up(event(id, x, y)),
    cancel: (id: number, x: number, y: number) => touch.cancel(event(id, x, y))
  };
}

describe('touch navigation', () => {
  it('leaves mouse and pen pointers to the viewport', () => {
    const t = setup();
    expect(t.down(1, 10, 10, 'mouse')).toBe(false);
    expect(t.down(2, 10, 10, 'pen')).toBe(false);
    expect(t.move(1, 20, 20)).toBe(false);
    expect(t.calls).toEqual([]);
  });

  it('replays a tap to the viewport as the click it is', () => {
    const t = setup();
    t.down(1, 100, 100);
    t.advance(60);
    t.up(1, 102, 101);
    expect(t.calls).toEqual(['pressDown', 'pressUp']);
    expect(t.touch.active).toBe(false);
  });

  it('runs a double click after the second tap’s own click', () => {
    const t = setup();
    t.down(1, 100, 100);
    t.advance(40);
    t.up(1, 100, 100);
    t.advance(80);
    t.down(2, 104, 100);
    t.advance(40);
    t.up(2, 104, 100);
    expect(t.calls).toEqual([
      'pressDown',
      'pressUp',
      'pressDown',
      'pressUp',
      'doubleTap'
    ]);
  });

  it('orbits a drag from empty space instead of selecting', () => {
    const t = setup();
    t.down(1, 100, 100);
    t.move(1, 130, 110);
    t.move(1, 140, 110);
    t.up(1, 140, 110);
    expect(t.calls).toEqual([
      'pressDown',
      'abandonPress(1)',
      'beginOrbit',
      'orbitBy(30,10)',
      'orbitBy(10,0)',
      'endNavigation'
    ]);
  });

  it('pans a one-finger drag where the view cannot turn', () => {
    const t = setup({ canOrbit: false });
    t.down(1, 100, 100);
    t.move(1, 100, 140);
    t.up(1, 100, 140);
    expect(t.calls).toEqual([
      'pressDown',
      'abandonPress(1)',
      'beginPinch',
      'panBy(0,40)',
      'endNavigation'
    ]);
  });

  it('pans and zooms two fingers, and drops the first finger’s click', () => {
    const t = setup();
    t.down(1, 100, 100);
    t.down(2, 200, 100);
    t.move(2, 300, 100);
    t.up(2, 300, 100);
    t.move(1, 0, 0);
    t.up(1, 0, 0);
    expect(t.calls).toEqual([
      'pressDown',
      'abandonPress(1)',
      'beginPinch',
      'panBy(50,0)',
      'zoomBy(2,200,100)',
      'endNavigation'
    ]);
  });

  it('opens the context menu for a held finger, and never clicks it', () => {
    const t = setup();
    t.down(1, 100, 100);
    t.advance(499);
    expect(t.calls).toEqual(['pressDown']);
    t.advance(1);
    t.up(1, 100, 100);
    expect(t.calls).toEqual(['pressDown', 'abandonPress(1)', 'longPress']);
  });

  it('steps history for two- and three-finger taps', () => {
    const t = setup();
    t.down(1, 100, 100);
    t.down(2, 200, 100);
    t.advance(80);
    t.up(1, 100, 100);
    t.up(2, 200, 100);
    t.advance(500);
    t.down(3, 100, 100);
    t.down(4, 150, 100);
    t.down(5, 200, 100);
    t.advance(80);
    t.up(3, 100, 100);
    t.up(4, 150, 100);
    t.up(5, 200, 100);
    expect(t.calls.filter((call) => call.startsWith('history'))).toEqual([
      'history(undo)',
      'history(redo)'
    ]);
  });

  it('hands a claimed press to the viewport and ignores other fingers', () => {
    const t = setup({ claim: true });
    t.down(1, 100, 100);
    t.move(1, 160, 100);
    t.down(2, 300, 100);
    t.move(2, 400, 100);
    t.up(2, 400, 100);
    t.advance(1000);
    t.up(1, 160, 100);
    expect(t.calls).toEqual(['pressDown', 'pressMove', 'pressUp']);
  });

  it('cancels a claimed press through the viewport', () => {
    const t = setup({ claim: true });
    t.down(1, 100, 100);
    t.cancel(1, 100, 100);
    expect(t.calls).toEqual(['pressDown', 'pressCancel']);
    expect(t.touch.active).toBe(false);
  });

  it('ends navigation and the pending press when the browser cancels', () => {
    const t = setup();
    t.down(1, 100, 100);
    t.move(1, 150, 100);
    t.cancel(1, 150, 100);
    expect(t.calls.slice(-1)).toEqual(['endNavigation']);
  });

  it('gives up a pending press and stops its timer on dispose', () => {
    const t = setup();
    t.down(1, 100, 100);
    t.touch.dispose();
    t.advance(1000);
    expect(t.calls).toEqual(['pressDown', 'abandonPress(1)']);
  });
});
