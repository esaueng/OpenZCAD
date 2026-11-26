import { describe, expect, it } from 'vitest';
import {
  controlOwnsEnter,
  enterSkipsExactEntry,
  exactEntryShortcut,
  inPlaceTypedEntryKey,
  isTypingTarget
} from './exactEntryShortcut';
import { IDLE, interactionReducer } from './interaction/machine';

const armed = interactionReducer(IDLE, {
  type: 'select-region',
  target: {
    sketchId: 'sketch',
    regionFingerprint: 1,
    samplePoint: { x: 0, y: 0 },
    area: 10,
    sourceEntityIds: []
  }
});
const key = (value: string) => new KeyboardEvent('keydown', { key: value });

// Review: with a Box command running, Enter on History's "Edit not applied"
// reopen button was taken as Done and created the Box.
describe('a control that owns its Enter', () => {
  it('is the marked control or anything inside it, and nothing else', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<button data-own-enter=""><span>edit not applied</span></button><button>Box</button>';
    const [own, other] = host.querySelectorAll('button');
    expect(controlOwnsEnter(own!)).toBe(true);
    expect(controlOwnsEnter(own!.querySelector('span'))).toBe(true);
    expect(controlOwnsEnter(other!)).toBe(false);
    expect(controlOwnsEnter(null)).toBe(false);
    expect(controlOwnsEnter(window)).toBe(false);
  });
});

// U11: Enter on a focused Select other row opened the value entry for the
// pick made before the list opened, instead of confirming the row.
describe("Enter that is not the pick's value entry", () => {
  it('belongs to a marked control or a menu row; the viewport keeps it', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<button data-own-enter="">reopen</button>' +
      '<div role="menu" aria-label="Select other">' +
      '<button role="menuitem"><span>Top face</span></button></div>' +
      '<canvas></canvas><button class="tool">Box</button>';
    const own = host.querySelector('[data-own-enter]');
    const row = host.querySelector('[role="menuitem"]');
    expect(enterSkipsExactEntry(own)).toBe(true);
    expect(enterSkipsExactEntry(row)).toBe(true);
    expect(enterSkipsExactEntry(row!.querySelector('span'))).toBe(true);
    // With no menu open, Enter on the viewport or the page still opens the
    // pick's value entry.
    expect(enterSkipsExactEntry(host.querySelector('canvas'))).toBe(false);
    expect(enterSkipsExactEntry(host.querySelector('.tool'))).toBe(false);
    expect(enterSkipsExactEntry(document.body)).toBe(false);
    expect(enterSkipsExactEntry(null)).toBe(false);
    expect(enterSkipsExactEntry(window)).toBe(false);
  });
});

describe('exact entry shortcut ownership', () => {
  it.each(['0', '1', '4', '9', '-', '.'])(
    'captures the initial %s before camera shortcuts',
    (value) => {
      expect(exactEntryShortcut(armed, key(value), false, false)).toEqual({
        initial: value
      });
      expect(exactEntryShortcut(IDLE, key(value), false, false)).toBeNull();
    }
  );

  // U11 review: a held Enter that confirmed a Select other row reached the
  // viewport by auto-repeat and opened the new pick's value entry.
  it('opens the value entry on a fresh Enter only, not a held one', () => {
    expect(exactEntryShortcut(armed, key('Enter'), false, false)).toEqual({});
    const held = new KeyboardEvent('keydown', { key: 'Enter', repeat: true });
    expect(exactEntryShortcut(armed, held, false, false)).toBeNull();
    // A held digit still types: the field takes its repeats once it opens.
    const digit = new KeyboardEvent('keydown', { key: '4', repeat: true });
    expect(exactEntryShortcut(armed, digit, false, false)).toEqual({
      initial: '4'
    });
  });

  it('reopens a refused value with Enter or a replacement digit', () => {
    const failed = interactionReducer(armed, {
      type: 'validation-failed',
      diagnostic: { message: 'Radius too large' },
      value: 100
    });
    expect(exactEntryShortcut(failed, key('Enter'), false, false)).toEqual({});
    expect(exactEntryShortcut(failed, key('3'), false, false)).toEqual({
      initial: '3'
    });
    expect(interactionReducer(failed, { type: 'keypad-open' })).toMatchObject({
      phase: 'exact-entry',
      error: null
    });
  });

  it('leaves focused fields, modifiers, sketches and an in-flight validation alone', () => {
    expect(exactEntryShortcut(armed, key('1'), false, false, true)).toBeNull();
    expect(
      exactEntryShortcut(armed, key('Enter'), false, false, true)
    ).toBeNull();
    expect(exactEntryShortcut(armed, key('1'), true, false)).toBeNull();
    expect(exactEntryShortcut(armed, key('1'), false, true)).toBeNull();
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) {
      expect(
        exactEntryShortcut(
          armed,
          new KeyboardEvent('keydown', { key: '1', [modifier]: true }),
          false,
          false
        )
      ).toBeNull();
    }
    const validating = interactionReducer(armed, {
      type: 'validation-start',
      value: 3
    });
    const sketch = interactionReducer(IDLE, {
      type: 'enter-sketch',
      plane: { type: 'canonical', plane: 'XY', offset: 0 }
    });
    for (const state of [validating, sketch])
      expect(exactEntryShortcut(state, key('1'), false, false)).toBeNull();
  });

  it('recognizes nested editable text without capturing ordinary canvas keys', () => {
    for (const tag of ['input', 'select', 'textarea'])
      expect(isTypingTarget(document.createElement(tag))).toBe(true);
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    const child = document.createElement('span');
    editable.append(child);
    expect(isTypingTarget(child)).toBe(true);
    child.contentEditable = 'false';
    expect(isTypingTarget(child)).toBe(false);
    expect(isTypingTarget(document.createElement('canvas'))).toBe(false);
  });
});

describe('a key typed at a running in-place command', () => {
  it.each(['0', '1', '5', '9', '-', '.'])(
    'takes %s as the first size rather than a view shortcut',
    (value) => {
      expect(inPlaceTypedEntryKey(key(value), false)).toBe(value);
    }
  );

  it('leaves a focused field, a chord and every other key alone', () => {
    // A field is typed in; the keypad takes its own keys.
    expect(inPlaceTypedEntryKey(key('1'), true)).toBeNull();
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      expect(
        inPlaceTypedEntryKey(
          new KeyboardEvent('keydown', { key: '1', [modifier]: true }),
          false
        )
      ).toBeNull();
    }
    for (const other of ['b', 'Enter', 'Tab', 'Escape', ' ', 'F1', '10'])
      expect(inPlaceTypedEntryKey(key(other), false)).toBeNull();
    const handled = key('1');
    Object.defineProperty(handled, 'defaultPrevented', { value: true });
    expect(inPlaceTypedEntryKey(handled, false)).toBeNull();
  });
});
