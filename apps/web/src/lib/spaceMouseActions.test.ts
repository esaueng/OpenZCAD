import { describe, expect, it, vi } from 'vitest';
import { SPACE_MOUSE_BUTTON } from '@openzcad/viewport/space-mouse';
import {
  SPACE_MOUSE_KEY_REFERENCE,
  dispatchEmulatedKey,
  spaceMouseAction
} from './spaceMouseActions';

const press = (button: number, shift = false) => ({
  button,
  pressed: true,
  shift,
  control: false,
  alt: false
});

describe('spaceMouseAction', () => {
  it('gives every SpaceMouse Pro key an action', () => {
    const keys = Object.values(SPACE_MOUSE_BUTTON);
    expect(keys).toHaveLength(15);
    for (const button of keys) {
      expect(spaceMouseAction(press(button))).not.toBeNull();
    }
  });

  it('maps views, and their opposites with the device Shift', () => {
    expect(spaceMouseAction(press(SPACE_MOUSE_BUTTON.top))).toEqual({
      kind: 'view',
      view: 'top'
    });
    expect(spaceMouseAction(press(SPACE_MOUSE_BUTTON.top, true))).toEqual({
      kind: 'view',
      view: 'bottom'
    });
    expect(spaceMouseAction(press(SPACE_MOUSE_BUTTON.right, true))).toEqual({
      kind: 'view',
      view: 'left'
    });
    expect(spaceMouseAction(press(SPACE_MOUSE_BUTTON.front, true))).toEqual({
      kind: 'view',
      view: 'back'
    });
    expect(
      spaceMouseAction(press(SPACE_MOUSE_BUTTON.rollClockwise, true))
    ).toEqual({ kind: 'roll', direction: -1 });
    expect(spaceMouseAction(press(SPACE_MOUSE_BUTTON.one))).toEqual({
      kind: 'view',
      view: 'iso'
    });
  });

  it('acts on press only, except the keyboard keys, which also let go', () => {
    expect(
      spaceMouseAction({ ...press(SPACE_MOUSE_BUTTON.fit), pressed: false })
    ).toBeNull();
    expect(
      spaceMouseAction({ ...press(SPACE_MOUSE_BUTTON.escape), pressed: false })
    ).toEqual({ kind: 'key', key: 'Escape', pressed: false });
    expect(spaceMouseAction(press(SPACE_MOUSE_BUTTON.control))).toEqual({
      kind: 'key',
      key: 'Control',
      pressed: true
    });
    // An unknown bit (a key another model has) does nothing.
    expect(spaceMouseAction(press(30))).toBeNull();
  });

  it('documents every key in the Settings reference', () => {
    const keys = SPACE_MOUSE_KEY_REFERENCE.items.flatMap((item) => item.keys);
    for (const label of [
      'Menu',
      'Fit',
      'T',
      'R',
      'F',
      'Roll',
      '1',
      '2',
      '3',
      '4',
      'Lock',
      'Esc',
      'Shift',
      'Ctrl',
      'Alt'
    ]) {
      expect(keys).toContain(label);
    }
  });
});

describe('dispatchEmulatedKey', () => {
  it('plays Escape at the focused element so it bubbles to window', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const seen = vi.fn((event: KeyboardEvent) => event.key);
    window.addEventListener('keydown', seen);
    try {
      dispatchEmulatedKey('Escape', true);
      expect(seen).toHaveBeenCalledTimes(1);
      expect(seen.mock.results[0]?.value).toBe('Escape');
    } finally {
      window.removeEventListener('keydown', seen);
      input.remove();
    }
  });

  it('holds and releases a modifier', () => {
    const events: KeyboardEvent[] = [];
    const target = new EventTarget();
    target.addEventListener('keydown', (event) =>
      events.push(event as KeyboardEvent)
    );
    target.addEventListener('keyup', (event) =>
      events.push(event as KeyboardEvent)
    );
    dispatchEmulatedKey('Shift', true, target);
    dispatchEmulatedKey('Shift', false, target);
    expect(events.map((event) => [event.type, event.shiftKey])).toEqual([
      ['keydown', true],
      ['keyup', false]
    ]);
  });
});
