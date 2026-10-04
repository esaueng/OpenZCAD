import { describe, expect, it } from 'vitest';
import {
  DISPLAY_ANGULAR_DEFLECTION,
  DISPLAY_DEFLECTION_HOLD_RATIO,
  DISPLAY_LINEAR_DEFLECTION_RATIO,
  DISPLAY_MIN_LINEAR_DEFLECTION,
  displayTessellationForExtents,
  heldDisplayTessellation
} from './display-tessellation';

describe('displayTessellationForExtents', () => {
  it('scales the chord target with the largest finite extent', () => {
    const tess = displayTessellationForExtents(74, 53, Number.NaN);
    expect(tess.linearDeflection).toBeCloseTo(
      74 * DISPLAY_LINEAR_DEFLECTION_RATIO,
      12
    );
    expect(tess.angularDeflection).toBe(DISPLAY_ANGULAR_DEFLECTION);
    expect(displayTessellationForExtents(0, 0, 0).linearDeflection).toBe(
      DISPLAY_MIN_LINEAR_DEFLECTION
    );
  });
});

describe('heldDisplayTessellation', () => {
  const nominal = displayTessellationForExtents(74, 53, 58);

  it('uses the nominal value when nothing is held', () => {
    expect(heldDisplayTessellation(nominal, undefined)).toEqual(nominal);
    expect(heldDisplayTessellation(nominal, 0)).toEqual(nominal);
    expect(heldDisplayTessellation(nominal, Number.NaN)).toEqual(nominal);
  });

  it('keeps the held value while the body stays within the band', () => {
    // A −6 mm face move on a 74 mm body: the nominal shrinks by 8 %.
    const after = displayTessellationForExtents(68, 53, 58);
    expect(after.linearDeflection).not.toBe(nominal.linearDeflection);
    const held = heldDisplayTessellation(after, nominal.linearDeflection);
    expect(held.linearDeflection).toBe(nominal.linearDeflection);
    expect(held.angularDeflection).toBe(after.angularDeflection);
    // Growth inside the band is held too.
    expect(
      heldDisplayTessellation(
        displayTessellationForExtents(90, 53, 58),
        nominal.linearDeflection
      ).linearDeflection
    ).toBe(nominal.linearDeflection);
  });

  it('re-anchors once the body has really changed size', () => {
    const grown = displayTessellationForExtents(
      74 * DISPLAY_DEFLECTION_HOLD_RATIO * 1.01,
      53,
      58
    );
    expect(
      heldDisplayTessellation(grown, nominal.linearDeflection).linearDeflection
    ).toBe(grown.linearDeflection);
    const shrunk = displayTessellationForExtents(
      74 / (DISPLAY_DEFLECTION_HOLD_RATIO * 1.01),
      53,
      58
    );
    expect(
      heldDisplayTessellation(shrunk, nominal.linearDeflection).linearDeflection
    ).toBe(shrunk.linearDeflection);
  });
});
