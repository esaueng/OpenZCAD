import { describe, expect, it } from 'vitest';
import { wheelIntent, type WheelSample } from './wheelGesture';

function sample(overrides: Partial<WheelSample> = {}): WheelSample {
  return { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, ...overrides };
}

describe('wheel intent', () => {
  it('reads a pinch as zoom however it is spelled', () => {
    // Browsers synthesise ctrlKey for a trackpad pinch, so this is the one
    // unambiguous signal and it outranks every override below.
    expect(wheelIntent(sample({ deltaY: 4, ctrlKey: true }))).toBe('zoom');
    expect(wheelIntent(sample({ deltaY: 4, ctrlKey: true }), 'trackpad')).toBe(
      'zoom'
    );
  });

  it('reads a notched wheel as zoom', () => {
    expect(wheelIntent(sample({ deltaY: 100 }))).toBe('zoom');
    expect(wheelIntent(sample({ deltaY: -120 }))).toBe('zoom');
    // Line and page deltas come only from a wheel.
    expect(wheelIntent(sample({ deltaY: 3, deltaMode: 1 }))).toBe('zoom');
    expect(wheelIntent(sample({ deltaY: 1, deltaMode: 2 }))).toBe('zoom');
  });

  it('reads two fingers as pan', () => {
    // A wheel has no horizontal axis at all.
    expect(wheelIntent(sample({ deltaX: 12, deltaY: 0 }))).toBe('pan');
    expect(wheelIntent(sample({ deltaX: -3, deltaY: 2 }))).toBe('pan');
    // Vertical, but finer than a notch can produce.
    expect(wheelIntent(sample({ deltaY: 7 }))).toBe('pan');
  });

  it('lets the preference settle what the heuristic cannot', () => {
    // A precision mouse emitting small deltas would otherwise pan.
    expect(wheelIntent(sample({ deltaY: 7 }), 'mouse')).toBe('zoom');
    // A trackpad whose momentum ends in a large delta would otherwise zoom.
    expect(wheelIntent(sample({ deltaY: 140 }), 'trackpad')).toBe('pan');
  });
});
