import { describe, expect, it } from 'vitest';
import {
  toEntityId,
  type SketchComposite,
  type SketchId,
  type SketchObjectData
} from '@openzcad/shared';
import {
  nextSketchRectangleMode,
  SKETCH_RECTANGLE_MODES
} from '../interaction/machine';
import {
  THREE_POINT_COLLINEAR_REFUSAL,
  centerRectangleShape,
  compositeCommands,
  compositeMemberUpdates,
  compositeRelations,
  compositeSizeLabel,
  cornerRectangleShape,
  dragCompositeShape,
  inscribedPolygonShape,
  resizedPolygon,
  resizedRectangleCorners,
  threePointRectangleShape,
  typedRectangleShape
} from './composites';

const ids = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => toEntityId(`${prefix}${index}`));

describe('S04 composite shapes', () => {
  it('orders an axis-aligned rectangle from its bottom-left corner, whichever way it was dragged', () => {
    expect(
      cornerRectangleShape({ x: 20, y: 12 }, { x: 0, y: 0 })?.corners
    ).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 12 },
      { x: 0, y: 12 }
    ]);
    expect(cornerRectangleShape({ x: 0, y: 0 }, { x: 20, y: 0.2 })).toBeNull();
  });

  it('mirrors a centre rectangle through its centre: (5,7) with 20×12 has corners (−5,1)/(15,13)', () => {
    const shape = centerRectangleShape({ x: 5, y: 7 }, { x: 15, y: 13 })!;
    expect(shape.composite).toEqual({
      compositeKind: 'rectangle',
      method: 'center'
    });
    expect(shape.corners[0]).toEqual({ x: -5, y: 1 });
    expect(shape.corners[2]).toEqual({ x: 15, y: 13 });
    expect(compositeSizeLabel(shape)).toBe('20 × 12');
  });

  it('keeps the dragged size of a side that was not typed', () => {
    const start = { x: 5, y: 7 };
    // The pointer is 10 right of and 6 below the press.
    const live = { x: 15, y: 1 };
    // Centre type: the drag shows 20 × 12, so typing only the width keeps
    // the height at 12, not the 6 from centre to pointer.
    const center = typedRectangleShape('center', start, live, { width: 30 });
    expect(center?.corners[0]).toEqual({ x: -10, y: 1 });
    expect(center?.corners[2]).toEqual({ x: 20, y: 13 });
    // Corner type: the drag shows 10 × 6, heading down and right.
    const corner = typedRectangleShape('corner', start, live, { height: 4 });
    expect(corner?.corners).toEqual([
      { x: 5, y: 3 },
      { x: 15, y: 3 },
      { x: 15, y: 7 },
      { x: 5, y: 7 }
    ]);
    // Both typed: the drag only picks the direction.
    expect(
      typedRectangleShape('center', start, live, { width: 4, height: 2 })
        ?.corners[0]
    ).toEqual({ x: 3, y: 6 });
  });

  it('refuses a three-point rectangle whose third point is on the first side', () => {
    expect(
      threePointRectangleShape({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 30, y: 0 })
    ).toEqual({ refusal: THREE_POINT_COLLINEAR_REFUSAL });
    expect(
      threePointRectangleShape({ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0, y: 5 })
    ).toHaveProperty('refusal');
  });

  it('labels a hexagon by circumradius and side, which are equal', () => {
    const shape = inscribedPolygonShape({ x: 0, y: 0 }, { x: 10, y: 0 }, 6)!;
    expect(compositeSizeLabel(shape)).toBe('R 10 · side 10');
    expect(shape.circle).toEqual({ center: { x: 0, y: 0 }, radius: 10 });
  });

  it('refuses a side count outside the document range', () => {
    const at = (sides: number) =>
      inscribedPolygonShape({ x: 0, y: 0 }, { x: 10, y: 0 }, sides);
    expect(at(2)).toBeNull();
    expect(at(65)).toBeNull();
    expect(at(4.5)).toBeNull();
    expect(at(64)?.corners).toHaveLength(64);
  });

  it('routes a drag to the live tool’s shape', () => {
    const start = { x: 0, y: 0 };
    const point = { x: 4, y: 3 };
    expect(
      dragCompositeShape('rectangle', 'corner', 6, start, point)?.composite
    ).toEqual({ compositeKind: 'rectangle', method: 'corner' });
    expect(
      dragCompositeShape('rectangle', 'center', 6, start, point)?.corners[0]
    ).toEqual({ x: -4, y: -3 });
    expect(
      dragCompositeShape('polygon', 'corner', 5, start, point)?.corners
    ).toHaveLength(5);
    // The three-point type is click-placed and never comes through a drag.
    expect(
      dragCompositeShape('rectangle', 'three-point', 6, start, point)
    ).toBeNull();
  });

  it('cycles the rectangle types in strip order', () => {
    expect(SKETCH_RECTANGLE_MODES.map(nextSketchRectangleMode)).toEqual([
      'center',
      'three-point',
      'corner'
    ]);
  });
});

describe('S04 composite relations and commands', () => {
  it('writes one coincident per corner, then the shape’s own relations', () => {
    const edges = ids('e', 4);
    const relations = compositeRelations(
      cornerRectangleShape({ x: 0, y: 0 }, { x: 2, y: 2 })!,
      edges,
      []
    );
    expect(relations[0]).toEqual({
      constraintKind: 'coincident',
      a: { objectId: edges[3], point: 'end' },
      b: { objectId: edges[0], point: 'start' }
    });
    expect(relations.slice(4)).toEqual([
      { constraintKind: 'horizontal', objectId: edges[0] },
      { constraintKind: 'vertical', objectId: edges[1] },
      { constraintKind: 'horizontal', objectId: edges[2] },
      { constraintKind: 'vertical', objectId: edges[3] }
    ]);
  });

  it('holds a centre rectangle’s diagonals on opposite corners', () => {
    const edges = ids('e', 4);
    const helpers = ids('h', 2);
    const relations = compositeRelations(
      centerRectangleShape({ x: 0, y: 0 }, { x: 2, y: 1 })!,
      edges,
      helpers
    );
    expect(relations.slice(8)).toEqual([
      {
        constraintKind: 'coincident',
        a: { objectId: helpers[0], point: 'start' },
        b: { objectId: edges[0], point: 'start' }
      },
      {
        constraintKind: 'coincident',
        a: { objectId: helpers[0], point: 'end' },
        b: { objectId: edges[2], point: 'start' }
      },
      {
        constraintKind: 'coincident',
        a: { objectId: helpers[1], point: 'start' },
        b: { objectId: edges[1], point: 'start' }
      },
      {
        constraintKind: 'coincident',
        a: { objectId: helpers[1], point: 'end' },
        b: { objectId: edges[3], point: 'start' }
      }
    ]);
  });

  it('puts every polygon vertex on the circumcircle and every side equal to side 0', () => {
    const edges = ids('e', 5);
    const [circle] = ids('c', 1);
    const relations = compositeRelations(
      inscribedPolygonShape({ x: 0, y: 0 }, { x: 0, y: 5 }, 5)!,
      edges,
      [circle!]
    );
    expect(relations.map((r) => r.constraintKind)).toEqual([
      ...Array<string>(5).fill('coincident'),
      ...Array<string>(5).fill('point-on-object'),
      ...Array<string>(4).fill('equal')
    ]);
  });

  it('commits into an existing sketch with every id assigned up front', () => {
    const sketchId = 'sketch_1' as SketchId;
    const commit = compositeCommands(
      inscribedPolygonShape({ x: 0, y: 0 }, { x: 0, y: 5 }, 3)!,
      { kind: 'sketch', sketchId }
    );
    expect(commit.label).toBe('Add polygon');
    expect(commit.commands.map((command) => command.kind)).toEqual([
      'sketch.object.add',
      ...Array<string>(3 + 3 + 2).fill('sketch.constraint.add'),
      'sketch.composite.add'
    ]);
    expect(commit.commands.at(-1)!.payload).toEqual({
      sketchId,
      composite: {
        compositeKind: 'polygon',
        method: 'inscribed',
        edgeIds: commit.edgeIds,
        helperIds: commit.helperIds
      },
      ids: { compositeId: commit.compositeId }
    });
  });
});

describe('S04 composite resize', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 }
  ];

  it('keeps corner 0, or the centre for a centre rectangle', () => {
    expect(resizedRectangleCorners(square, 'corner', 6, 2)).toEqual([
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 2 },
      { x: 0, y: 2 }
    ]);
    expect(resizedRectangleCorners(square, 'center', 6, 2)).toEqual([
      { x: -1, y: 1 },
      { x: 5, y: 1 },
      { x: 5, y: 3 },
      { x: -1, y: 3 }
    ]);
    expect(resizedRectangleCorners(square, 'corner', 0.1, 2)).toBeNull();
  });

  it('scales a polygon about its centre and refuses a degenerate side', () => {
    const shape = inscribedPolygonShape({ x: 1, y: 1 }, { x: 1, y: 3 }, 4)!;
    const grown = resizedPolygon(shape.corners, { x: 1, y: 1 }, 4)!;
    expect(grown.radius).toBe(4);
    expect(grown.corners[0]!.x).toBeCloseTo(1, 12);
    expect(grown.corners[0]!.y).toBeCloseTo(5, 12);
    expect(resizedPolygon(shape.corners, { x: 1, y: 1 }, 0.2)).toBeNull();
  });

  it('keeps an expression a resize does not move, and replaces one it moves', () => {
    const edges = ids('e', 4);
    const composite: SketchComposite = {
      compositeId: 'scmp_1' as SketchComposite['compositeId'],
      compositeKind: 'rectangle',
      method: 'corner',
      edgeIds: edges
    };
    const scope: Record<string, number> = { w: 4, h: 4 };
    const resolve = (value: number | string) =>
      typeof value === 'number' ? value : scope[value];
    const current = new Map<string, SketchObjectData>([
      [edges[0]!, { objectKind: 'line', x1: 0, y1: 0, x2: 'w', y2: 0 }],
      [edges[1]!, { objectKind: 'line', x1: 'w', y1: 0, x2: 'w', y2: 'h' }]
    ]);
    // A taller rectangle: side 0 does not move, side 1's top end does.
    const updates = compositeMemberUpdates(
      composite,
      resizedRectangleCorners(square, 'corner', 4, 6)!,
      current,
      undefined,
      resolve
    );
    expect(updates[0]!.data).toEqual({
      objectKind: 'line',
      x1: 0,
      y1: 0,
      x2: 'w',
      y2: 0
    });
    expect(updates[1]!.data).toEqual({
      objectKind: 'line',
      x1: 'w',
      y1: 0,
      x2: 'w',
      y2: 6
    });
  });

  it('moves every side and helper, keeping construction flags', () => {
    const edges = ids('e', 4);
    const helpers = ids('h', 2);
    const composite: SketchComposite = {
      compositeId: 'scmp_1' as SketchComposite['compositeId'],
      compositeKind: 'rectangle',
      method: 'center',
      edgeIds: edges,
      helperIds: helpers
    };
    const line: SketchObjectData = {
      objectKind: 'line',
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      construction: true
    };
    const current = new Map<string, SketchObjectData>([
      [edges[0]!, { ...line, construction: undefined }],
      [helpers[0]!, line],
      [helpers[1]!, line]
    ]);
    const updates = compositeMemberUpdates(composite, square, current);
    expect(updates.map(({ objectId }) => objectId)).toEqual([
      ...edges,
      ...helpers
    ]);
    expect(updates[0]!.data).toEqual({
      objectKind: 'line',
      x1: 0,
      y1: 0,
      x2: 4,
      y2: 0
    });
    expect(updates[5]!.data).toEqual({
      objectKind: 'line',
      x1: 4,
      y1: 0,
      x2: 0,
      y2: 4,
      construction: true
    });
  });
});
