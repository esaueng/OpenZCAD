import { describe, expect, it } from 'vitest';
import {
  toSketchConstraintId,
  type EntityId,
  type SketchConstraint,
  type SketchConstraintData,
  type SketchObjectData
} from '@openzcad/shared';
import { sketchRelationGlyphs } from './relationGlyphs';

const id = (value: string) => value as EntityId;
let next = 0;
const constraint = (data: SketchConstraintData): SketchConstraint => ({
  constraintId: toSketchConstraintId(`c${next++}`),
  data
});
const resolve = (value: number | string) =>
  typeof value === 'number' ? value : undefined;

// A 20 × 10 rectangle as four held lines, counter-clockwise from the origin,
// plus a circle and a quarter arc.
const objects: { id: string; data: SketchObjectData }[] = [
  { id: 'bottom', data: { objectKind: 'line', x1: 0, y1: 0, x2: 20, y2: 0 } },
  { id: 'right', data: { objectKind: 'line', x1: 20, y1: 0, x2: 20, y2: 10 } },
  { id: 'top', data: { objectKind: 'line', x1: 20, y1: 10, x2: 0, y2: 10 } },
  { id: 'left', data: { objectKind: 'line', x1: 0, y1: 10, x2: 0, y2: 0 } },
  {
    id: 'hole',
    data: { objectKind: 'circle', centerX: 10, centerY: 5, radius: 2 }
  },
  {
    id: 'bend',
    data: {
      objectKind: 'arc',
      centerX: 40,
      centerY: 0,
      radius: 4,
      startAngleDeg: 0,
      endAngleDeg: 90
    }
  }
];
const rectangle = [
  constraint({ constraintKind: 'horizontal', objectId: id('bottom') }),
  constraint({ constraintKind: 'vertical', objectId: id('right') }),
  constraint({ constraintKind: 'horizontal', objectId: id('top') }),
  constraint({ constraintKind: 'vertical', objectId: id('left') }),
  constraint({
    constraintKind: 'coincident',
    a: { objectId: id('bottom'), point: 'end' },
    b: { objectId: id('right'), point: 'start' }
  }),
  constraint({
    constraintKind: 'coincident',
    a: { objectId: id('left'), point: 'end' },
    b: { objectId: id('bottom'), point: 'start' }
  }),
  constraint({
    constraintKind: 'lock',
    point: { objectId: id('bottom'), point: 'start' },
    x: 0,
    y: 0
  }),
  constraint({ constraintKind: 'parallel', a: id('bottom'), b: id('top') }),
  constraint({
    constraintKind: 'distance',
    a: { objectId: id('bottom'), point: 'start' },
    b: { objectId: id('bottom'), point: 'end' },
    value: 20
  })
];

// Point chips are keyed by a quantized position; name them by anchor here.
const label = (chip: ReturnType<typeof sketchRelationGlyphs>[number]) =>
  chip.placement === 'object'
    ? chip.key
    : `point(${chip.anchor.x},${chip.anchor.y})`;
const summary = (chips: ReturnType<typeof sketchRelationGlyphs>) =>
  Object.fromEntries(
    chips.map((chip) => [
      label(chip),
      { anchor: chip.anchor, symbols: chip.glyphs.map((g) => g.symbol) }
    ])
  );

describe('sketchRelationGlyphs', () => {
  it('puts curve relations at the curve middle and point relations on the point', () => {
    const chips = summary(
      sketchRelationGlyphs(objects, rectangle, resolve, {
        visibility: 'always'
      })
    );
    expect(chips).toEqual({
      'object:bottom': { anchor: { x: 10, y: 0 }, symbols: ['—', '∥'] },
      'object:right': { anchor: { x: 20, y: 5 }, symbols: ['|'] },
      'object:top': { anchor: { x: 10, y: 10 }, symbols: ['—', '∥'] },
      'object:left': { anchor: { x: 0, y: 5 }, symbols: ['|'] },
      // The bottom-right corner's coincident.
      'point(20,0)': { anchor: { x: 20, y: 0 }, symbols: ['•'] },
      // The origin corner: its coincident (named on `left.end`) and the lock
      // (named on `bottom.start`) are one chip because the points coincide.
      'point(0,0)': { anchor: { x: 0, y: 0 }, symbols: ['•', '▲'] }
    });
  });

  it('draws no glyph for driving dimensions, which have their own labels', () => {
    const chips = sketchRelationGlyphs(objects, [rectangle[8]!], resolve, {
      visibility: 'always'
    });
    expect(chips).toEqual([]);
  });

  it('anchors circles at 45° and arcs at mid-sweep', () => {
    const chips = sketchRelationGlyphs(
      objects,
      [constraint({ constraintKind: 'equal', a: id('hole'), b: id('bend') })],
      resolve,
      { visibility: 'always' }
    );
    const anchors = Object.fromEntries(
      chips.map((chip) => [chip.key, chip.anchor])
    );
    const r = Math.SQRT1_2;
    expect(anchors['object:hole']!.x).toBeCloseTo(10 + 2 * r, 12);
    expect(anchors['object:hole']!.y).toBeCloseTo(5 + 2 * r, 12);
    expect(anchors['object:bend']!.x).toBeCloseTo(40 + 4 * r, 12);
    expect(anchors['object:bend']!.y).toBeCloseTo(4 * r, 12);
  });

  it('marks both points and the axis of a symmetry', () => {
    const chips = sketchRelationGlyphs(
      objects,
      [
        constraint({
          constraintKind: 'symmetric',
          a: { objectId: id('top'), point: 'start' },
          b: { objectId: id('top'), point: 'end' },
          axis: id('bottom')
        })
      ],
      resolve,
      { visibility: 'always' }
    );
    expect(chips.map(label).sort()).toEqual([
      'object:bottom',
      'point(0,10)',
      'point(20,10)'
    ]);
  });

  it('shows only relations naming the selection, and nothing when hidden', () => {
    const selected = sketchRelationGlyphs(objects, rectangle, resolve, {
      visibility: 'selected',
      selectedObjectId: 'right'
    });
    expect(
      selected.flatMap((chip) => chip.glyphs.map((glyph) => glyph.kind)).sort()
    ).toEqual(['coincident', 'vertical']);
    expect(
      sketchRelationGlyphs(objects, rectangle, resolve, {
        visibility: 'selected',
        selectedObjectId: null
      })
    ).toEqual([]);
    expect(
      sketchRelationGlyphs(objects, rectangle, resolve, {
        visibility: 'hidden'
      })
    ).toEqual([]);
  });

  it('flags glyphs whose relation the last solve named as conflicting', () => {
    const parallel = rectangle[7]!;
    const chips = sketchRelationGlyphs(objects, rectangle, resolve, {
      visibility: 'always',
      conflictingConstraintIds: new Set([String(parallel.constraintId)])
    });
    const flagged = chips.flatMap((chip) =>
      chip.glyphs
        .filter((glyph) => glyph.conflicted)
        .map((glyph) => `${chip.key}:${glyph.kind}`)
    );
    expect(flagged.sort()).toEqual([
      'object:bottom:parallel',
      'object:top:parallel'
    ]);
  });

  it('marks both ends of a coincident that has not been solved yet', () => {
    const chips = sketchRelationGlyphs(
      objects,
      [
        constraint({
          constraintKind: 'coincident',
          a: { objectId: id('bottom'), point: 'start' },
          b: { objectId: id('bend'), point: 'end' }
        })
      ],
      resolve,
      { visibility: 'always' }
    );
    expect(chips.map(label).sort()).toEqual(['point(0,0)', 'point(40,4)']);
  });

  it('keeps distinct points apart in a compact sketch far from the plane origin', () => {
    // Two 10-unit segments a billion units out: the corner between them must
    // stay one chip, and the free ends must not merge into it.
    const far = 1e9;
    const chips = sketchRelationGlyphs(
      [
        {
          id: 'p',
          data: { objectKind: 'line', x1: far, y1: far, x2: far + 10, y2: far }
        },
        {
          id: 'q',
          data: {
            objectKind: 'line',
            x1: far + 10,
            y1: far,
            x2: far + 10,
            y2: far + 10
          }
        }
      ],
      [
        constraint({
          constraintKind: 'coincident',
          a: { objectId: id('p'), point: 'end' },
          b: { objectId: id('q'), point: 'start' }
        }),
        constraint({
          constraintKind: 'lock',
          point: { objectId: id('p'), point: 'start' },
          x: far,
          y: far
        }),
        constraint({
          constraintKind: 'lock',
          point: { objectId: id('q'), point: 'end' },
          x: far + 10,
          y: far + 10
        })
      ],
      resolve,
      { visibility: 'always' }
    );
    expect(
      chips
        .map((chip) => chip.glyphs.map((glyph) => glyph.kind).join('+'))
        .sort()
    ).toEqual(['coincident', 'lock', 'lock']);
  });

  it('clusters by proximity, not by the sketch extent or a rounding grid', () => {
    const lock = (objectId: string, point: 'start' | 'end') =>
      constraint({
        constraintKind: 'lock',
        point: { objectId: id(objectId), point },
        x: 0,
        y: 0
      });
    // Anchors at 0, 10 and 1e9 in one sketch: three points, three chips.
    const wide = sketchRelationGlyphs(
      [
        { id: 'a', data: { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 } },
        {
          id: 'b',
          data: { objectKind: 'line', x1: 1e9, y1: 0, x2: 1e9, y2: 5 }
        }
      ],
      [lock('a', 'start'), lock('a', 'end'), lock('b', 'start')],
      resolve,
      { visibility: 'always' }
    );
    expect(wide.map(label).sort()).toEqual([
      'point(0,0)',
      'point(10,0)',
      'point(1000000000,0)'
    ]);
    // Solver-close ends either side of any would-be grid line stay together.
    const close = sketchRelationGlyphs(
      [
        {
          id: 'p',
          data: { objectKind: 'line', x1: 0, y1: 0, x2: 4.9999999999, y2: 0 }
        },
        {
          id: 'q',
          data: { objectKind: 'line', x1: 5.0000000001, y1: 0, x2: 5, y2: 9 }
        }
      ],
      [
        constraint({
          constraintKind: 'coincident',
          a: { objectId: id('p'), point: 'end' },
          b: { objectId: id('q'), point: 'start' }
        })
      ],
      resolve,
      { visibility: 'always' }
    );
    expect(close).toHaveLength(1);
    expect(close[0]!.glyphs).toHaveLength(1);
  });

  it('skips relations whose geometry does not resolve', () => {
    const chips = sketchRelationGlyphs(
      [
        {
          id: 'driven',
          data: { objectKind: 'line', x1: 'w', y1: 0, x2: 10, y2: 0 }
        }
      ],
      [constraint({ constraintKind: 'horizontal', objectId: id('driven') })],
      resolve,
      { visibility: 'always' }
    );
    expect(chips).toEqual([]);
  });
});
