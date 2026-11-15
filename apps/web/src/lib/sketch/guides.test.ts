import { describe, expect, it } from 'vitest';
import { PLANE_BASES } from '@openzcad/geometry';
import type { SketchObjectData } from '@openzcad/shared';
import {
  extensionTargets,
  modelGuideTargets,
  tangentTargets,
  viewIsOrthogonal
} from './guides';
import { inferSketchRelations } from './inference';

const resolve = (value: unknown) => Number(value);
const line = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { id: string; data: SketchObjectData } => ({
  id,
  data: { objectKind: 'line', x1, y1, x2, y2 }
});
const XY = PLANE_BASES.XY;

describe('guideline extensions', () => {
  const objects = [line('a', 0, 0, 10, 0)];

  it('offers the foot on a line’s extension past either end', () => {
    const [past] = extensionTargets({ x: 16, y: 0.3 }, objects, resolve, 0.5);
    expect(past).toMatchObject({
      x: 16,
      y: 0,
      kind: 'extension',
      sourceId: 'a',
      guide: [
        { x: 10, y: 0 },
        { x: 16, y: 0 }
      ]
    });
    const [before] = extensionTargets(
      { x: -4, y: -0.2 },
      objects,
      resolve,
      0.5
    );
    expect(before).toMatchObject({ x: -4, y: 0, sourceId: 'a' });
    expect(before!.guide![0]).toEqual({ x: 0, y: 0 });
  });

  it('leaves the segment and its ends to the ordinary snaps', () => {
    expect(extensionTargets({ x: 5, y: 0.1 }, objects, resolve, 0.5)).toEqual(
      []
    );
    expect(
      extensionTargets({ x: 10.3, y: 0.1 }, objects, resolve, 0.5)
    ).toEqual([]);
    expect(extensionTargets({ x: 16, y: 2 }, objects, resolve, 0.5)).toEqual(
      []
    );
  });

  it('holds a drawn end on the extension it snapped to', () => {
    const relations = inferSketchRelations(
      objects,
      [line('n', 16, 0, 16, 8)],
      resolve,
      {
        autoConstrain: true,
        hints: [{ x: 16, y: 0, kind: 'extension', sourceId: 'a' }]
      }
    );
    expect(relations.map((relation) => relation.data)).toEqual([
      {
        constraintKind: 'point-on-object',
        point: { objectId: 'n', point: 'start' },
        objectId: 'a'
      },
      { constraintKind: 'vertical', objectId: 'n' }
    ]);
  });
});

describe('tangent guidelines', () => {
  const circle = {
    id: 'c',
    data: {
      objectKind: 'circle',
      centerX: 0,
      centerY: 0,
      radius: 5
    } as SketchObjectData
  };

  it('offers both tangent points of a circle from the anchor', () => {
    const targets = tangentTargets({ x: 10, y: 0 }, [circle], resolve);
    expect(targets).toHaveLength(2);
    for (const target of targets) {
      // Radius square to the line from the anchor.
      expect(Math.hypot(target.x, target.y)).toBeCloseTo(5, 12);
      expect(target.x * (target.x - 10) + target.y * target.y).toBeCloseTo(
        0,
        12
      );
      expect(target.guide![0]).toEqual({ x: 10, y: 0 });
    }
    expect(targets.map((target) => Math.sign(target.y)).sort()).toEqual([
      -1, 1
    ]);
  });

  it('keeps only an arc’s tangent points on its sweep, none from inside', () => {
    const upper = {
      id: 'r',
      data: {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 5,
        startAngleDeg: 0,
        endAngleDeg: 180
      } as SketchObjectData
    };
    const targets = tangentTargets({ x: 10, y: 0 }, [upper], resolve);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.y).toBeGreaterThan(0);
    expect(tangentTargets({ x: 1, y: 1 }, [circle], resolve)).toEqual([]);
  });

  it('infers on-curve and tangent for a line ending on a tangent point', () => {
    const [target] = tangentTargets({ x: 10, y: 0 }, [circle], resolve);
    const relations = inferSketchRelations(
      [circle],
      [line('l', 10, 0, target!.x, target!.y)],
      resolve,
      {
        autoConstrain: true,
        hints: [{ x: target!.x, y: target!.y, kind: 'tangent', sourceId: 'c' }]
      }
    );
    expect(relations.map((relation) => relation.data)).toEqual([
      {
        constraintKind: 'point-on-object',
        point: { objectId: 'l', point: 'end' },
        objectId: 'c'
      },
      { constraintKind: 'tangent', a: 'l', b: 'c' }
    ]);
    // With auto-constrain off nothing is held: neither is a joined end.
    expect(
      inferSketchRelations(
        [circle],
        [line('l', 10, 0, target!.x, target!.y)],
        resolve,
        {
          autoConstrain: false,
          hints: [
            { x: target!.x, y: target!.y, kind: 'tangent', sourceId: 'c' }
          ]
        }
      )
    ).toEqual([]);
  });
});

describe('model guidepoints', () => {
  const points = [
    { kind: 'endpoint' as const, point: { x: 1, y: 2, z: 0 } },
    { kind: 'center' as const, point: { x: 4, y: 4, z: -10 } },
    {
      kind: 'center' as const,
      point: { x: 6, y: 1, z: 0 },
      role: 'face-center' as const
    }
  ];

  it('lifts on-plane points into sketch coordinates as unreferenced snaps', () => {
    const targets = modelGuideTargets(points, XY, {
      orthogonal: false,
      planeTolerance: 1e-4
    });
    expect(targets).toEqual([
      expect.objectContaining({
        x: 1,
        y: 2,
        kind: 'endpoint',
        label: 'Model vertex'
      }),
      expect.objectContaining({
        x: 6,
        y: 1,
        kind: 'center',
        label: 'Face center'
      })
    ]);
    for (const target of targets) {
      expect(target.pointRef).toBeUndefined();
      expect(target.sourceId).toBeUndefined();
    }
  });

  it('projects off-plane points in only while the view is orthogonal', () => {
    const targets = modelGuideTargets(points, XY, {
      orthogonal: true,
      planeTolerance: 1e-4
    });
    expect(targets).toHaveLength(3);
    expect(targets[1]).toMatchObject({
      x: 4,
      y: 4,
      label: 'Hole or arc center (projected)'
    });
  });

  it('reads orthogonal views within a degree of the normal, either side', () => {
    expect(viewIsOrthogonal({ x: 0, y: 0, z: -1 }, XY.normal)).toBe(true);
    expect(viewIsOrthogonal({ x: 0, y: 0, z: 3 }, XY.normal)).toBe(true);
    expect(
      viewIsOrthogonal(
        { x: Math.sin(0.05), y: 0, z: -Math.cos(0.05) },
        XY.normal
      )
    ).toBe(false);
  });
});
