import { describe, expect, it } from 'vitest';
import { exactEntryShortcut, isTypingTarget } from './exactEntryShortcut';
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
