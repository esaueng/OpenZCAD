import { describe, expect, it } from 'vitest';
import { resolveBoundaryRegionReference } from './profileProvenance';

const outer = Array.from(
  { length: 4 },
  (_, i) => `b1/ent_rect/rectangle/1/4/e/${i}`
);
function region(id = 'same') {
  return {
    id,
    area: 100,
    sourceBoundaryLoops: { outer, holes: [] as string[][] },
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ],
    holes: [] as { x: number; y: number }[][],
    boundingBox: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }
  };
}
const reference = {
  sourceBoundaryLoops: { outer, holes: [] },
  sourceArea: 100,
  samplePoint: { x: 5, y: 5 }
};

describe('strict saved UI profile provenance', () => {
  it('accepts changed geometry through identical complete authored topology', () => {
    const current = {
      ...region(),
      area: 200,
      sourceBoundaryLoops: { outer: [...outer].reverse(), holes: [] }
    };
    expect(resolveBoundaryRegionReference(reference, [current])).toBe(current);
  });
  it('refuses changed split multiplicity despite unchanged legacy identity and geometry', () => {
    const current = {
      ...region(),
      sourceBoundaryLoops: { outer: [...outer, outer[0]!], holes: [] }
    };
    expect(() => resolveBoundaryRegionReference(reference, [current])).toThrow(
      /topology/
    );
  });
  it('uses containment and area only to disambiguate identical provenance', () => {
    const first = region('inside');
    const outside = {
      ...region('outside'),
      outer: [
        { x: 20, y: 20 },
        { x: 30, y: 20 },
        { x: 30, y: 30 },
        { x: 20, y: 30 }
      ],
      boundingBox: { min: { x: 20, y: 20 }, max: { x: 30, y: 30 } }
    };
    expect(resolveBoundaryRegionReference(reference, [outside, first])).toBe(
      first
    );
    expect(() =>
      resolveBoundaryRegionReference(reference, [first, region('duplicate')])
    ).toThrow(/uniquely/);
  });
});
