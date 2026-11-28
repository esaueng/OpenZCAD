import { describe, expect, it } from 'vitest';
import {
  blendRefusalText,
  blendSizesWithUnit,
  smallerSizeIn,
  withoutFeatureLead
} from './sizeRefusal';

const REFUSAL =
  'Feature "Chamfer": Chamfer could not be created on 1 selected edge with distance 8. Try a smaller distance: distance 2.5 builds here.';

describe('a blend refusal as its command bar reads it', () => {
  it('finds the size that builds, and nothing where none is named', () => {
    expect(smallerSizeIn(REFUSAL)).toEqual({
      dimension: 'distance',
      size: 2.5
    });
    expect(
      smallerSizeIn('Fillet could not be created. Try a smaller radius.')
    ).toBeNull();
  });

  it('drops the feature name and puts the unit after each size', () => {
    expect(blendRefusalText(REFUSAL, 'in', 'Chamfer')).toBe(
      'Chamfer could not be created on 1 selected edge with distance 8 in. Try a smaller distance: distance 2.5 in builds here.'
    );
    expect(blendRefusalText('Feature "Box": Box failed.', null)).toBe(
      'Box failed.'
    );
  });

  // The adapter quotes a size as JavaScript prints it, so a very small or
  // very large one is in exponent notation; the unit goes after the whole
  // number (preview check of f4c7f13 read "1 mm.5e-9").
  it.each([
    ['1.5e-9', 'distance'],
    ['2e-7', 'radius'],
    ['1e+21', 'distance'],
    ['-3.25e+2', 'radius']
  ] as const)('puts the unit after %s whole', (size, dimension) => {
    const refusal = `Feature "Blend": Blend could not be created on 1 selected edge with ${dimension} ${size}. The kernel could not build this edge with its current neighboring faces.`;
    expect(blendRefusalText(refusal, 'mm', 'Blend')).toBe(
      `Blend could not be created on 1 selected edge with ${dimension} ${size} mm. The kernel could not build this edge with its current neighboring faces.`
    );
  });

  it('reads and quotes an exponent size that builds', () => {
    const refusal =
      'Fillet could not be created on 1 selected edge with radius 1e+21. Try a smaller radius: radius 2.5e+20 builds here.';
    expect(smallerSizeIn(refusal)).toEqual({
      dimension: 'radius',
      size: 2.5e20
    });
    expect(blendRefusalText(refusal, 'mm')).toBe(
      'Fillet could not be created on 1 selected edge with radius 1e+21 mm. Try a smaller radius: radius 2.5e+20 mm builds here.'
    );
  });
});

// Review of #2405: units go only into the adapter's own sentence. A feature
// name with a number in it must not take the unit, and a size that has one
// already must not take a second.
describe('a unit only where the adapter quoted a size', () => {
  const SENTENCE =
    'Chamfer could not be created on 1 selected edge with distance 1.5. Try a smaller distance: distance 0.985 builds here.';
  const formatted = (unit: string) =>
    `Chamfer could not be created on 1 selected edge with distance 1.5 ${unit}. Try a smaller distance: distance 0.985 ${unit} builds here.`;

  it('strips a quoted name and writes the unit after the refused size', () => {
    expect(
      blendRefusalText(
        `Feature "Chamfer with distance 2 "Nominal"": ${SENTENCE}`,
        'in',
        'Chamfer with distance 2 "Nominal"'
      )
    ).toBe(formatted('in'));
  });

  it.each(['mm', 'in'])('never writes %s twice', (unit) => {
    expect(blendRefusalText(formatted(unit), unit)).toBe(formatted(unit));
  });

  it('keeps a name with digits and units out of it, in mm', () => {
    expect(
      blendRefusalText(
        `Feature "Edge 4 mm with distance 3 mm": ${SENTENCE}`,
        'mm',
        'Edge 4 mm with distance 3 mm'
      )
    ).toBe(formatted('mm'));
  });

  it('writes no unit into text that does not open with the adapter sentence', () => {
    // A name holding `": ` cannot be told from the lead; the text is left
    // as it is rather than given a unit in the wrong place.
    const unstripped = `Feature "Size": with distance 2": ${SENTENCE}`;
    expect(blendRefusalText(unstripped, 'in')).not.toMatch(/\d in\b/);
    expect(blendRefusalText('Bevel with distance 2 failed.', 'mm')).toBe(
      'Bevel with distance 2 failed.'
    );
  });
});

// Re-check of #2405: a feature name holding `": ` passes for the adapter's
// sentence once a lead is stripped up to it. Units are written only after
// the lead is removed as the known name, exactly; without the name, none.
describe('units only after the lead is removed as the known name', () => {
  const SPOOF =
    'Rough": Chamfer could not be created on 1 selected edge with distance 2.';
  const SENTENCE =
    'Chamfer could not be created on 1 selected edge with distance 1.5. Try a smaller distance: distance 0.985 builds here.';
  const SPOOFED = `Feature "${SPOOF}": ${SENTENCE}`;

  it('removes the lead as the name and writes the unit after the refused size', () => {
    expect(withoutFeatureLead(SPOOFED, SPOOF)).toEqual({
      text: SENTENCE,
      adapterText: true
    });
    expect(blendRefusalText(SPOOFED, 'in', SPOOF)).toBe(
      'Chamfer could not be created on 1 selected edge with distance 1.5 in. Try a smaller distance: distance 0.985 in builds here.'
    );
  });

  it('writes no unit when the name is not known, or is another', () => {
    for (const name of [undefined, null, 'Smooth']) {
      expect(withoutFeatureLead(SPOOFED, name).adapterText).toBe(false);
      expect(blendRefusalText(SPOOFED, 'in', name)).not.toMatch(/\d in\b/);
    }
  });

  it('trusts text that has no lead at all', () => {
    expect(withoutFeatureLead(SENTENCE)).toEqual({
      text: SENTENCE,
      adapterText: true
    });
  });
});

// Re-check of #2405, finding 2: the refused size already had its unit, and
// the size that builds was left bare. Each size is checked on its own.
describe('each size takes the unit on its own', () => {
  it.each(['mm', 'in'])('writes %s after a bare size that builds', (unit) => {
    expect(
      blendSizesWithUnit(
        `Chamfer could not be created on 1 selected edge with distance 1.5 ${unit}. Try a smaller distance: distance 0.985 builds here.`,
        unit
      )
    ).toBe(
      `Chamfer could not be created on 1 selected edge with distance 1.5 ${unit}. Try a smaller distance: distance 0.985 ${unit} builds here.`
    );
  });
});
