import { describe, expect, it } from 'vitest';
import {
  toSketchConstraintId,
  type EntityId,
  type SketchConstraint,
  type SketchConstraintData,
  type SketchObjectData
} from '@openzcad/shared';
import { sketchRelationGlyphs, widestGap } from './relationGlyphs';

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

  it('clusters a column of many curve ends in linear time', () => {
    // Sixty thousand short vertical lines stacked in one column: every end
    // shares an x, which made the old sweep compare each against all.
    const column = Array.from({ length: 60_000 }, (_, index) => ({
      id: `l${index}`,
      data: {
        objectKind: 'line' as const,
        x1: 0,
        y1: index * 10,
        x2: 0,
        y2: index * 10 + 5
      }
    }));
    const relations = [
      constraint({
        constraintKind: 'coincident',
        a: { objectId: id('l0'), point: 'end' },
        b: { objectId: id('l1'), point: 'start' }
      }),
      constraint({ constraintKind: 'vertical', objectId: id('l59999') })
    ];
    const started = performance.now();
    const chips = sketchRelationGlyphs(column, relations, resolve, {
      visibility: 'always'
    });
    // About half a second here; the quadratic sweep took about 18 s.
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(chips.map((chip) => chip.placement).sort()).toEqual([
      'object',
      'point',
      'point'
    ]);
    // The lone line end the coincident names stands off opposite its line.
    const end = chips.find(
      (chip) => chip.placement === 'point' && chip.anchor.y === 5
    )!;
    expect(end.normal.y).toBeCloseTo(1, 12);
  }, 20_000);

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

  it('hides the kinds the per-kind filter names and nothing else', () => {
    const chips = sketchRelationGlyphs(objects, rectangle, resolve, {
      visibility: 'always',
      hiddenKinds: new Set(['horizontal', 'coincident'] as const)
    });
    const kinds = chips.flatMap((chip) => chip.glyphs.map((g) => g.kind));
    expect(kinds).not.toContain('horizontal');
    expect(kinds).not.toContain('coincident');
    expect(new Set(kinds)).toEqual(new Set(['vertical', 'lock', 'parallel']));
  });

  it('marks the relation picked from its glyph as selected, on every chip it draws on', () => {
    const parallel = String(rectangle[7]!.constraintId);
    const chips = sketchRelationGlyphs(objects, rectangle, resolve, {
      visibility: 'always',
      selectedConstraintId: parallel
    });
    const selected = chips.flatMap((chip) =>
      chip.glyphs
        .filter((glyph) => glyph.selected)
        .map((glyph) => `${chip.key}:${glyph.kind}`)
    );
    expect(selected.sort()).toEqual([
      'object:bottom:parallel',
      'object:top:parallel'
    ]);
  });

  it('stands curve chips off a profile outward and off a circle radially', () => {
    // The rectangle and the hole inside it; the arc beside it would move the
    // sketch's centre off the rectangle's.
    const chips = sketchRelationGlyphs(
      objects.slice(0, 5),
      [
        ...rectangle,
        constraint({ constraintKind: 'equal', a: id('hole'), b: id('top') })
      ],
      resolve,
      { visibility: 'always' }
    );
    const normals = Object.fromEntries(
      chips.map((chip) => [chip.key, chip.normal])
    );
    // Away from the sketch's centre, so the rectangle's chips sit outside it
    // whichever way each side was drawn (`top` runs right to left).
    expect(normals['object:bottom']!.y).toBeCloseTo(-1, 12);
    expect(normals['object:top']!.y).toBeCloseTo(1, 12);
    expect(normals['object:right']!.x).toBeCloseTo(1, 12);
    expect(normals['object:left']!.x).toBeCloseTo(-1, 12);
    expect(normals['object:hole']!.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(normals['object:hole']!.y).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('stands a line through the sketch centre off its upper side', () => {
    const [chip] = sketchRelationGlyphs(
      [
        {
          id: 'alone',
          data: { objectKind: 'line', x1: 5, y1: 2, x2: -5, y2: 2 }
        }
      ],
      [constraint({ constraintKind: 'horizontal', objectId: id('alone') })],
      resolve,
      { visibility: 'always' }
    );
    expect(chip!.normal.x).toBeCloseTo(0, 12);
    expect(chip!.normal.y).toBeCloseTo(1, 12);
  });

  it('stands a corner chip outside the corner, between the curves meeting there', () => {
    const chips = sketchRelationGlyphs(objects, rectangle, resolve, {
      visibility: 'always'
    });
    const origin = chips.find(
      (chip) => chip.placement === 'point' && chip.anchor.x === 0
    )!;
    // `bottom` leaves the origin along +x and `left` arrives along −y, so
    // the open side is down-left, away from the rectangle.
    expect(origin.normal.x).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(origin.normal.y).toBeCloseTo(-Math.SQRT1_2, 12);
  });

  it('stands a midpoint chip to one side of the line passing through it', () => {
    const chips = sketchRelationGlyphs(
      [
        ...objects,
        {
          id: 'stub',
          data: { objectKind: 'line', x1: 10, y1: 0, x2: 10, y2: -6 }
        }
      ],
      [
        constraint({
          constraintKind: 'midpoint',
          point: { objectId: id('stub'), point: 'start' },
          line: id('bottom')
        })
      ],
      resolve,
      { visibility: 'always' }
    );
    const [chip] = chips;
    // The stub hangs down from the middle of `bottom`, which runs both ways:
    // the widest gap left is straight up.
    expect(chip!.normal.x).toBeCloseTo(0, 12);
    expect(chip!.normal.y).toBeCloseTo(1, 12);
  });

  it('orders point chips before curve chips, stably, whatever the constraint order', () => {
    const keys = (list: typeof rectangle) =>
      sketchRelationGlyphs(objects, list, resolve, {
        visibility: 'always'
      }).map((chip) => `${chip.placement}:${chip.anchor.x},${chip.anchor.y}`);
    const forward = keys(rectangle);
    expect(keys([...rectangle].reverse())).toEqual(forward);
    const firstObject = forward.findIndex((key) => key.startsWith('object'));
    expect(
      forward.slice(firstObject).every((key) => key.startsWith('object'))
    ).toBe(true);
    expect(forward.slice(0, firstObject)).toEqual(['point:0,0', 'point:20,0']);
  });

  it('bisects the widest gap between leaving directions', () => {
    // One direction: straight back along it.
    const back = widestGap([{ x: 1, y: 0 }]);
    expect(back.x).toBeCloseTo(-1, 12);
    expect(back.y).toBeCloseTo(0, 12);
    // Nothing known: the default diagonal, down and to the right.
    expect(widestGap([])).toEqual({ x: Math.SQRT1_2, y: -Math.SQRT1_2 });
    // Three curves at 0°, 90° and 180°: the open half is below.
    const tee = widestGap([
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: -1, y: 0 }
    ]);
    expect(tee.x).toBeCloseTo(0, 12);
    expect(tee.y).toBeCloseTo(-1, 12);
  });
});
