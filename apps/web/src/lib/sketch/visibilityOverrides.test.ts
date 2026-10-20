import { describe, expect, it } from 'vitest';
import { toggledSketchVisibility } from './visibilityOverrides';

describe('sketch visibility overrides', () => {
  const live = new Set(['a', 'b', 'c']);

  it('records a choice that differs from the default', () => {
    expect(toggledSketchVisibility({}, 'a', false, true, live)).toEqual({
      a: false
    });
  });

  it('drops a choice toggled back to the default', () => {
    expect(
      toggledSketchVisibility({ a: false }, 'a', true, true, live)
    ).toEqual({});
  });

  it('drops overrides for sketches no longer in the document', () => {
    expect(
      toggledSketchVisibility({ gone: false, b: true }, 'a', false, true, live)
    ).toEqual({ b: true, a: false });
  });

  it('moves the changed sketch to the newest position', () => {
    const next = toggledSketchVisibility(
      { a: false, b: false },
      'a',
      true,
      false,
      live
    );
    expect(Object.keys(next)).toEqual(['b', 'a']);
  });
});
