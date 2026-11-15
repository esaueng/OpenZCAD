import { describe, expect, it } from 'vitest';
import type { SketchObjectData } from '@openzcad/shared';
import {
  describeInferredRelations,
  inferSketchRelations,
  lineDirectionLock,
  tangentArcCenter,
  type SketchInferenceObject
} from './inference';
import { collectSketchSnapTargets } from './session';

const resolve = (value: unknown) => Number(value);
const line = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): SketchInferenceObject => ({
  id,
  data: { objectKind: 'line', x1, y1, x2, y2 }
});
const arc = (
  id: string,
  cx: number,
  cy: number,
  radius: number,
  start: number,
  end: number
): SketchInferenceObject => ({
  id,
  data: {
    objectKind: 'arc',
    centerX: cx,
    centerY: cy,
    radius,
    startAngleDeg: start,
    endAngleDeg: end
  }
});
const kinds = (relations: { kind: string }[]) =>
  relations.map((relation) => relation.kind);

describe('inferSketchRelations', () => {
  it('joins a chained segment to the one before it, setting on or off', () => {
    const existing = [line('a', 0, 0, 10, 3)];
    const added = [line('b', 10, 3, 14, 20)];
    for (const autoConstrain of [false, true]) {
      const relations = inferSketchRelations(existing, added, resolve, {
        autoConstrain
      });
      expect(relations[0]).toEqual({
        kind: 'coincident',
        data: {
          constraintKind: 'coincident',
          a: { objectId: 'a', point: 'end' },
          b: { objectId: 'b', point: 'start' }
        },
        connected: true,
        optional: false
      });
    }
  });

  it('holds an end placed on a line midpoint even with the setting off', () => {
    const relations = inferSketchRelations(
      [line('a', 0, 0, 10, 0)],
      [line('b', 5, 0, 5, 8)],
      resolve,
      { autoConstrain: false }
    );
    expect(relations).toEqual([
      {
        kind: 'midpoint',
        data: {
          constraintKind: 'midpoint',
          point: { objectId: 'b', point: 'start' },
          line: 'a'
        },
        connected: true,
        optional: false
      }
    ]);
  });

  it('keeps only connected relations with the setting off', () => {
    const relations = inferSketchRelations(
      [
        line('a', 0, 0, 10, 0),
        {
          id: 'c',
          data: { objectKind: 'circle', centerX: 30, centerY: 0, radius: 2 }
        }
      ],
      [line('b', 10, 0, 30, 0)],
      resolve,
      { autoConstrain: false }
    );
    // The far end lands on the circle's centre and the line is horizontal:
    // both need the setting.
    expect(kinds(relations)).toEqual(['coincident']);
  });

  it('infers horizontal and vertical lines with the setting on', () => {
    expect(
      kinds(
        inferSketchRelations([], [line('h', 1, 2, 9, 2)], resolve, {
          autoConstrain: true
        })
      )
    ).toEqual(['horizontal']);
    expect(
      kinds(
        inferSketchRelations([], [line('v', 1, 2, 1, -9)], resolve, {
          autoConstrain: true
        })
      )
    ).toEqual(['vertical']);
    expect(
      inferSketchRelations([], [line('d', 0, 0, 3, 4)], resolve, {
        autoConstrain: true
      })
    ).toEqual([]);
  });

  it('infers a perpendicular to the oblique line a segment continues', () => {
    const relations = inferSketchRelations(
      [line('a', 0, 0, 4, 3)],
      [line('b', 4, 3, 1, 7)],
      resolve,
      { autoConstrain: true }
    );
    expect(kinds(relations)).toEqual(['coincident', 'perpendicular']);
    expect(relations[1]!.data).toEqual({
      constraintKind: 'perpendicular',
      a: 'a',
      b: 'b'
    });
    expect(relations[1]!.optional).toBe(true);
  });

  it('adds no perpendicular where axis relations already state it', () => {
    const relations = inferSketchRelations(
      [line('a', 0, 0, 10, 0)],
      [line('b', 10, 0, 10, 6)],
      resolve,
      { autoConstrain: true }
    );
    expect(kinds(relations)).toEqual(['coincident', 'vertical']);
  });

  it('adds one perpendicular for a segment closing a rotated rectangle', () => {
    // a, b, c drawn; d closes c's end back to a's start.
    const existing = [
      line('a', 0, 0, 4, 3),
      line('b', 4, 3, 1, 7),
      line('c', 1, 7, -3, 4)
    ];
    const relations = inferSketchRelations(
      existing,
      [line('d', -3, 4, 0, 0)],
      resolve,
      { autoConstrain: true }
    );
    expect(kinds(relations)).toEqual([
      'coincident',
      'coincident',
      'perpendicular'
    ]);
    expect(relations[2]!.data).toMatchObject({ a: 'c', b: 'd' });
  });

  it('infers a line leaving an arc end along its tangent', () => {
    // Quarter arc from (10, 0) to (0, 10) about the origin; the line leaves
    // its end heading -x.
    const relations = inferSketchRelations(
      [arc('r', 0, 0, 10, 0, 90)],
      [line('l', 0, 10, -6, 10)],
      resolve,
      { autoConstrain: true }
    );
    expect(kinds(relations)).toContain('tangent');
    const tangent = relations.find((relation) => relation.kind === 'tangent')!;
    expect(tangent.data).toEqual({
      constraintKind: 'tangent',
      a: 'l',
      b: 'r',
      at: { objectId: 'r', point: 'end' }
    });
  });

  it('infers an arc leaving a line end tangentially', () => {
    const relations = inferSketchRelations(
      [line('l', 0, 0, 10, 0)],
      [arc('r', 10, 5, 5, -90, 90)],
      resolve,
      { autoConstrain: true }
    );
    expect(kinds(relations)).toEqual(['coincident', 'tangent']);
    expect(relations[1]!.data).toEqual({
      constraintKind: 'tangent',
      a: 'l',
      b: 'r',
      at: { objectId: 'r', point: 'start' }
    });
  });

  it('joins a circle centre to an end it lands on, only with the setting on', () => {
    const existing = [line('a', 0, 0, 10, 0)];
    const added: SketchInferenceObject[] = [
      {
        id: 'c',
        data: { objectKind: 'circle', centerX: 10, centerY: 0, radius: 3 }
      }
    ];
    expect(
      inferSketchRelations(existing, added, resolve, { autoConstrain: false })
    ).toEqual([]);
    expect(
      inferSketchRelations(existing, added, resolve, { autoConstrain: true })
    ).toEqual([
      {
        kind: 'coincident',
        data: {
          constraintKind: 'coincident',
          a: { objectId: 'a', point: 'end' },
          b: { objectId: 'c', point: 'center' }
        },
        connected: false,
        optional: false
      }
    ]);
  });

  it('locks an end snapped to the origin, and only a snapped one', () => {
    const added = [line('a', 0, 0, 3, 4)];
    expect(
      inferSketchRelations([], added, resolve, { autoConstrain: true })
    ).toEqual([]);
    expect(
      inferSketchRelations([], added, resolve, {
        autoConstrain: true,
        hints: [{ x: 0, y: 0, kind: 'origin' }]
      })
    ).toEqual([
      {
        kind: 'origin',
        data: {
          constraintKind: 'lock',
          point: { objectId: 'a', point: 'start' },
          x: 0,
          y: 0
        },
        connected: false,
        optional: false
      }
    ]);
  });

  it('holds an end snapped to a crossing on both lines', () => {
    const existing = [line('p', 0, 0, 10, 10), line('q', 0, 8, 12, -4)];
    const targets = collectSketchSnapTargets(existing, resolve);
    const crossing = targets.find((target) => target.kind === 'intersection')!;
    expect(crossing.sourceIds).toEqual(['p', 'q']);
    const relations = inferSketchRelations(
      existing,
      [line('n', 4, 4, 20, 7)],
      resolve,
      {
        autoConstrain: true,
        hints: [
          {
            x: crossing.x,
            y: crossing.y,
            kind: 'intersection',
            sourceIds: crossing.sourceIds
          }
        ]
      }
    );
    expect(relations.map((relation) => relation.data)).toEqual([
      {
        constraintKind: 'point-on-object',
        point: { objectId: 'n', point: 'start' },
        objectId: 'p'
      },
      {
        constraintKind: 'point-on-object',
        point: { objectId: 'n', point: 'start' },
        objectId: 'q'
      }
    ]);
    // A grid point that merely lies on a line is not held there.
    expect(
      inferSketchRelations(existing, [line('m', 3, 3, 20, 7)], resolve, {
        autoConstrain: true
      })
    ).toEqual([]);
  });

  it('prefers the newest end when two ends share the point', () => {
    const relations = inferSketchRelations(
      [line('old', 0, 0, 5, 5), line('new', 9, 1, 5, 5)],
      [line('n', 5, 5, 2, 9)],
      resolve,
      { autoConstrain: false }
    );
    expect(relations).toHaveLength(1);
    expect(relations[0]!.data).toMatchObject({
      a: { objectId: 'new', point: 'end' }
    });
  });

  it('gives composite sides point relations only', () => {
    const relations = inferSketchRelations(
      [line('a', 0, 0, 10, 0)],
      [line('s0', 10, 0, 20, 0), line('s1', 20, 0, 20, 5)],
      resolve,
      { autoConstrain: true },
      false
    );
    expect(kinds(relations)).toEqual(['coincident']);
  });

  it('ignores text and parametric shapes', () => {
    const text = {
      id: 't',
      data: {
        objectKind: 'text',
        text: 'A',
        x: 0,
        y: 0,
        height: 5
      } as unknown as SketchObjectData
    };
    expect(
      inferSketchRelations([line('a', 0, 0, 1, 0)], [text], resolve, {
        autoConstrain: true
      })
    ).toEqual([]);
  });
});

describe('lineDirectionLock', () => {
  const objects = [line('a', 0, 0, 4, 3)];

  it('locks near-horizontal and near-vertical lines exactly', () => {
    expect(
      lineDirectionLock({ x: 0, y: 0 }, { x: 10, y: 0.5 }, [], resolve)
    ).toEqual({
      point: { x: 10, y: 0 },
      lock: 'horizontal'
    });
    expect(
      lineDirectionLock({ x: 0, y: 0 }, { x: 0.4, y: -9 }, [], resolve)
    ).toEqual({
      point: { x: 0, y: -9 },
      lock: 'vertical'
    });
  });

  it('locks to the perpendicular of a line ending at the anchor', () => {
    const locked = lineDirectionLock(
      { x: 4, y: 3 },
      { x: 1.1, y: 7.1 },
      objects,
      resolve
    );
    expect(locked.lock).toBe('perpendicular');
    const dx = locked.point.x - 4;
    const dy = locked.point.y - 3;
    expect(Math.abs(dx * 4 + dy * 3)).toBeLessThan(1e-12);
    // The locked end is then inferred perpendicular exactly.
    expect(
      kinds(
        inferSketchRelations(
          objects,
          [line('b', 4, 3, locked.point.x, locked.point.y)],
          resolve,
          { autoConstrain: true }
        )
      )
    ).toEqual(['coincident', 'perpendicular']);
  });

  it('locks to an arc tangent ahead of the axes', () => {
    const quarter = [arc('r', 0, 0, 10, 0, 80)];
    const end = {
      x: 10 * Math.cos((80 * Math.PI) / 180),
      y: 10 * Math.sin((80 * Math.PI) / 180)
    };
    // The tangent at 80° heads 170°: within 5° of -x as well.
    const locked = lineDirectionLock(
      end,
      { x: end.x - 10, y: end.y + 1.5 },
      quarter,
      resolve
    );
    expect(locked.lock).toBe('tangent');
    expect(
      kinds(
        inferSketchRelations(
          quarter,
          [line('l', end.x, end.y, locked.point.x, locked.point.y)],
          resolve,
          { autoConstrain: true }
        )
      )
    ).toEqual(['coincident', 'tangent']);
  });

  it('leaves a free direction alone', () => {
    expect(
      lineDirectionLock({ x: 0, y: 0 }, { x: 3, y: 4 }, [], resolve)
    ).toEqual({ point: { x: 3, y: 4 }, lock: null });
  });
});

describe('tangentArcCenter', () => {
  it('slides a near-normal centre onto the line normal', () => {
    const result = tangentArcCenter(
      { x: 10.3, y: 5 },
      [{ x: 10, y: 0 }],
      [line('l', 0, 0, 10, 0)],
      resolve
    );
    expect(result).toEqual({ center: { x: 10, y: 5 }, tangent: true });
  });

  it('keeps a centre well off the normal', () => {
    const center = { x: 14, y: 5 };
    expect(
      tangentArcCenter(
        center,
        [{ x: 10, y: 0 }],
        [line('l', 0, 0, 10, 0)],
        resolve
      )
    ).toEqual({ center, tangent: false });
  });
});

describe('describeInferredRelations', () => {
  it('names every inferred relation and how to remove one', () => {
    expect(
      describeInferredRelations('Add line', [
        'coincident',
        'horizontal',
        'coincident'
      ])
    ).toBe(
      'Add line · inferred coincident ×2, horizontal. Select a relation glyph and press Delete to remove one.'
    );
    expect(describeInferredRelations('Add line', [])).toBe('Add line.');
  });
});

describe('review #1555 regressions', () => {
  it('leaves every relation after a commit’s first to the solver', () => {
    // A rectangle's bottom side dropped onto a line's two ends: the second
    // join may restate the rectangle's own horizontal side.
    const relations = inferSketchRelations(
      [line('base', 0, 0, 6, 0)],
      [line('s0', 0, 0, 6, 0), line('s1', 6, 0, 6, 4)],
      resolve,
      { autoConstrain: false },
      false
    );
    expect(relations.map((relation) => relation.optional)).toEqual([
      false,
      true
    ]);
  });

  it('never moves an arc centre placed on a snap', () => {
    const objects = [line('l', 0, 100, 5, 100)];
    const snapped = { x: 0, y: 0 };
    expect(
      tangentArcCenter(snapped, [{ x: 5, y: 100 }], objects, resolve, [
        { x: 0, y: 0, kind: 'origin' }
      ])
    ).toEqual({ center: snapped, tangent: false });
    // The same centre unsnapped, and near the normal, does slide onto it.
    expect(
      tangentArcCenter({ x: 5.3, y: 95 }, [{ x: 5, y: 100 }], objects, resolve)
    ).toEqual({ center: { x: 5, y: 95 }, tangent: true });
  });
});
