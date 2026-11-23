import { describe, expect, it } from 'vitest';
import { measureRailBand, railBandParts } from './railBand';

function placed(
  element: HTMLElement,
  left: number,
  right: number,
  height = 100
): HTMLElement {
  element.getBoundingClientRect = () => ({
    left,
    top: 0,
    right,
    bottom: height,
    x: left,
    y: 0,
    width: right - left,
    height,
    toJSON: () => ({})
  });
  return element;
}

function island(className: string, left: number, right: number, height = 100) {
  const element = document.createElement('div');
  element.className = className;
  return placed(element, left, right, height);
}

/** A rail at a 900px window's edge, an island gap in. */
function rail(...islands: HTMLElement[]): HTMLElement {
  const element = placed(document.createElement('div'), 850, 890);
  element.className = 'instrument-rail';
  element.append(...islands);
  return element;
}

describe('the measured rail band', () => {
  it('is gap, rail, gap for a lone rail', () => {
    expect(measureRailBand(rail(island('viewer-rail', 850, 890)), 10)).toBe(60);
  });

  it('reaches the leftmost island: the relations and the readout beside the rail', () => {
    // A folded 74px mouse rail, the readout two rails wide beside it.
    const folded = rail(
      island('viewer-rail', 816, 890),
      island('sketch-relations', 766, 806),
      island('viewport-readout', 716, 806, 60)
    );
    expect(measureRailBand(folded, 10)).toBe(194);
  });

  it('skips a hidden readout and every child that is not an island', () => {
    const sketchless = rail(
      island('viewer-rail', 850, 890),
      island('viewport-readout', 0, 0, 0),
      // A flyout the rail opened is no part of the band.
      island('rail-views-panel', 400, 840)
    );
    expect(railBandParts(sketchless).map((part) => part.className)).toEqual([
      'viewer-rail',
      'viewport-readout'
    ]);
    expect(measureRailBand(sketchless, 10)).toBe(60);
  });

  it('is unmeasured with no rail or no layout', () => {
    expect(measureRailBand(null, 10)).toBeNull();
    const unlaid = document.createElement('div');
    unlaid.append(document.createElement('div'));
    expect(measureRailBand(unlaid, 10)).toBeNull();
  });
});
