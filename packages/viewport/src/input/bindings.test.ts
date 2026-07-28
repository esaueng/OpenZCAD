import { describe, expect, it } from 'vitest';
import { MIDDLE_DRAG_LABELS, pointerBindingsFor } from './bindings';

describe('pointer bindings', () => {
  it('puts the chosen action on the middle button', () => {
    expect(pointerBindingsFor('pan').middle).toBe('pan');
    expect(pointerBindingsFor('orbit').middle).toBe('orbit');
    expect(pointerBindingsFor('zoom').middle).toBe('zoom');
  });

  it('always leaves orbit on the left button', () => {
    // A laptop without a middle button must never lose the ability to orbit,
    // whatever the preference says.
    for (const action of ['pan', 'orbit', 'zoom'] as const) {
      expect(pointerBindingsFor(action).left).toBe('orbit');
    }
  });

  it('always leaves pan on the right button', () => {
    // Right-drag pans and a stationary right-click opens the context menu;
    // that pairing is load-bearing and no preference may disturb it.
    for (const action of ['pan', 'orbit', 'zoom'] as const) {
      expect(pointerBindingsFor(action).right).toBe('pan');
    }
  });

  it('names every action it offers', () => {
    for (const action of ['pan', 'orbit', 'zoom'] as const) {
      expect(MIDDLE_DRAG_LABELS[action]).toBeTruthy();
    }
  });
});
