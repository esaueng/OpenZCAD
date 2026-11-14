import { describe, expect, it } from 'vitest';
import { SKETCH_EXIT_CONFIRM_MS, sketchExitEscape } from './sketchExitConfirm';

describe('sketchExitEscape (I43)', () => {
  it('arms on the first press and leaves on a second one soon after', () => {
    const first = sketchExitEscape(null, 1_000);
    expect(first).toEqual({ leave: false, armedAt: 1_000 });
    expect(sketchExitEscape(first.armedAt, 1_400)).toEqual({
      leave: true,
      armedAt: null
    });
  });

  it('arms again, rather than leaving, once the confirmation has lapsed', () => {
    expect(
      sketchExitEscape(1_000, 1_001 + SKETCH_EXIT_CONFIRM_MS)
    ).toEqual({ leave: false, armedAt: 1_001 + SKETCH_EXIT_CONFIRM_MS });
  });
});
