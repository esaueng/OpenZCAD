import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installTouchLongPress,
  isTouchLongPress,
  TOUCH_LONG_PRESS_MS
} from './touchLongPress';

let now = 0;
let uninstall: () => void = () => undefined;

function pointer(
  type: string,
  target: Element,
  init: Partial<PointerEventInit> = {}
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 100,
      clientY: 100,
      ...init
    })
  );
}

function advance(ms: number) {
  now += ms;
  vi.advanceTimersByTime(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  uninstall = installTouchLongPress(document, {
    now: () => now,
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle)
  });
  document.body.innerHTML =
    '<div id="row"><span id="label">Extrude</span></div><input id="field" /><div class="viewer-host"><canvas id="canvas"></canvas></div>';
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function menus() {
  const seen: MouseEvent[] = [];
  document.addEventListener('contextmenu', (event) => {
    seen.push(event);
  });
  return seen;
}

describe('touch long press', () => {
  it('opens the pressed element’s context menu after a still hold', () => {
    const seen = menus();
    const label = document.getElementById('label')!;
    pointer('pointerdown', label);
    advance(TOUCH_LONG_PRESS_MS - 1);
    expect(seen).toHaveLength(0);
    advance(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.target).toBe(label);
    expect(isTouchLongPress(seen[0]!)).toBe(true);
    expect(seen[0]!.clientX).toBe(100);
  });

  it('swallows the click the lift makes, and only that one', () => {
    const clicks = vi.fn();
    const row = document.getElementById('row')!;
    row.addEventListener('click', clicks);
    pointer('pointerdown', row);
    advance(TOUCH_LONG_PRESS_MS);
    pointer('pointerup', row);
    row.click();
    expect(clicks).not.toHaveBeenCalled();
    row.click();
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('leaves a moved finger, a quick tap and a lifted hold alone', () => {
    const seen = menus();
    const row = document.getElementById('row')!;
    pointer('pointerdown', row);
    pointer('pointermove', row, { clientX: 115 });
    advance(TOUCH_LONG_PRESS_MS);
    pointer('pointerdown', row);
    pointer('pointerup', row);
    advance(TOUCH_LONG_PRESS_MS);
    pointer('pointerdown', row);
    pointer('pointercancel', row);
    advance(TOUCH_LONG_PRESS_MS);
    expect(seen).toHaveLength(0);
  });

  it('leaves a mouse, a pen, text fields and the viewport canvas alone', () => {
    const seen = menus();
    const row = document.getElementById('row')!;
    pointer('pointerdown', row, { pointerType: 'mouse' });
    advance(TOUCH_LONG_PRESS_MS);
    pointer('pointerdown', row, { pointerType: 'pen' });
    advance(TOUCH_LONG_PRESS_MS);
    pointer('pointerdown', document.getElementById('field')!);
    advance(TOUCH_LONG_PRESS_MS);
    pointer('pointerdown', document.getElementById('canvas')!);
    advance(TOUCH_LONG_PRESS_MS);
    expect(seen).toHaveLength(0);
  });

  it('stands down when the browser opens its own menu first', () => {
    const seen = menus();
    const row = document.getElementById('row')!;
    pointer('pointerdown', row);
    advance(TOUCH_LONG_PRESS_MS - 50);
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
    advance(100);
    expect(seen).toHaveLength(1);
    expect(isTouchLongPress(seen[0]!)).toBe(false);
  });
});
