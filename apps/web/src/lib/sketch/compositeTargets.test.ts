import { describe, expect, it, vi } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import {
  createSketchCompositeCornerTarget,
  createSketchCompositeSideTarget,
  toSketchReferenceAnnotationId,
  toSketchCompositeId,
  toUserId
} from '@openzcad/shared';
import {
  centerRectangleShape,
  compositeCommands,
  cornerRectangleShape
} from './composites';
import { collectSketchSnapTargets, SKETCH_SNAP_LIMITS } from './session';
import { sketchDimensionAnnotations } from './dimensionAnnotations';
import { planSketchTrim } from './modify';

const resolve = (value: unknown) => Number(value);

function fixture(center = false) {
  const shape = center
    ? centerRectangleShape({ x: 10, y: 6 }, { x: 20, y: 12 })!
    : cornerRectangleShape({ x: 0, y: 0 }, { x: 20, y: 12 })!;
  const commit = compositeCommands(shape, {
    kind: 'new-sketch',
    name: 'Named rectangle',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 }
  });
  const manager = new CommandManager(
    createProjectDocument('Targets', toUserId('user_test'))
  );
  manager.execute(composeCommands(commit.label, commit.commands));
  const sketch = findSketch(manager.document, commit.sketchId)!;
  const objects = sketch.objectIds.map((id) => {
    const node = manager.document.nodes[id]!;
    if (node.kind !== 'sketch-object') throw new Error('Missing shape member');
    return { id, data: node.data };
  });
  return { manager, sketch, objects, composite: sketch.composites![0]! };
}

describe('qualified composite snap targets', () => {
  it('names corners and side midpoints while preserving primitive aliases and snap ids', () => {
    const f = fixture();
    const ordinary = collectSketchSnapTargets(f.objects, resolve);
    const named = collectSketchSnapTargets(f.objects, resolve, [f.composite]);
    const corner = named.find(
      (target) =>
        target.sourceId === f.composite.edgeIds[0] &&
        target.pointRef === 'start'
    )!;
    expect(corner).toMatchObject({
      x: 0,
      y: 0,
      kind: 'endpoint',
      sourceId: f.composite.edgeIds[0],
      pointRef: 'start',
      label: 'Rectangle 1 · Corner 1',
      compositeTarget: createSketchCompositeCornerTarget(f.composite, 0)
    });
    expect(corner.id).toBe(
      ordinary.find(
        (target) =>
          target.sourceId === corner.sourceId && target.pointRef === 'start'
      )!.id
    );
    const previousEnd = named.find(
      (target) =>
        target.sourceId === f.composite.edgeIds[3] && target.pointRef === 'end'
    )!;
    expect(previousEnd.compositeTarget).toEqual(corner.compositeTarget);
    expect(previousEnd.pointRef).toBe('end');
    const midpoint = named.find(
      (target) =>
        target.sourceId === f.composite.edgeIds[0] && target.kind === 'midpoint'
    )!;
    expect(midpoint).toMatchObject({
      x: 10,
      y: 0,
      label: 'Rectangle 1 · Side 1 midpoint',
      compositeTarget: createSketchCompositeSideTarget(f.composite, 0)
    });
    expect(midpoint.pointRef).toBeUndefined();
    expect(
      named.map(
        ({ compositeTarget: _target, label: _label, ...target }) => target
      )
    ).toEqual(ordinary);
  });

  it('falls back to honest primitive snaps when the held shape is broken', () => {
    const f = fixture();
    const first = f.objects[0]!;
    if (first.data.objectKind !== 'line') throw new Error('Not a line');
    const objects = [
      { ...first, data: { ...first.data, x2: 21 } },
      ...f.objects.slice(1)
    ];
    const snaps = collectSketchSnapTargets(objects, resolve, [f.composite]);
    expect(snaps.some((target) => target.compositeTarget || target.label)).toBe(
      false
    );
    expect(snaps).toEqual(collectSketchSnapTargets(objects, resolve));
  });

  it.each(['unknown', NaN])(
    'refuses logical names for an unresolved construction helper (%s) while preserving primitive snaps',
    (value) => {
      const f = fixture(true);
      const helperId = f.composite.helperIds![0]!;
      const objects = f.objects.map((object) => {
        if (object.id !== helperId || object.data.objectKind !== 'line')
          return object;
        return { ...object, data: { ...object.data, x1: value } };
      });
      const permissive = (input: unknown) => Number(input) || 0;
      const ordinary = collectSketchSnapTargets(objects, permissive);
      const named = collectSketchSnapTargets(
        objects,
        permissive,
        [f.composite],
        (input) => Number(input)
      );
      expect(named).toEqual(ordinary);
      expect(named.some((target) => target.compositeTarget)).toBe(false);
      expect(
        collectSketchSnapTargets(objects, resolve, [f.composite]).some(
          (target) => target.compositeTarget
        )
      ).toBe(false);
    }
  );

  it('bounds broken composite records separately from the complete physical object allowance', () => {
    const f = fixture();
    const objects = Array.from(
      { length: SKETCH_SNAP_LIMITS.objects },
      (_, i) => ({
        id: `circle_${i}`,
        data: {
          objectKind: 'circle' as const,
          centerX: i,
          centerY: 0,
          radius: 1
        }
      })
    );
    const records = Array.from(
      { length: SKETCH_SNAP_LIMITS.objects },
      (_, i) => ({
        ...f.composite,
        compositeId: toSketchCompositeId(`scmp_broken_${i}`)
      })
    );
    const ordinary = collectSketchSnapTargets(objects, resolve);
    expect(collectSketchSnapTargets(objects, resolve, records)).toEqual(
      ordinary
    );
    expect(ordinary.some((target) => target.sourceId === 'circle_1023')).toBe(
      true
    );
    const evaluate = vi.fn(resolve);
    expect(() =>
      collectSketchSnapTargets(objects, evaluate, [...records, f.composite])
    ).toThrow(/limit of 1024 sketch objects/);
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe('composite dimensions and modify boundaries', () => {
  it('lays out projected corner and side-angle measurements through composite context', () => {
    const f = fixture();
    const references = [
      {
        annotationId: toSketchReferenceAnnotationId('sref_width'),
        data: {
          dimensionKind: 'distance' as const,
          distanceMode: 'horizontal' as const,
          a: createSketchCompositeCornerTarget(f.composite, 0),
          b: createSketchCompositeCornerTarget(f.composite, 2)
        }
      },
      {
        annotationId: toSketchReferenceAnnotationId('sref_angle'),
        data: {
          dimensionKind: 'angle' as const,
          a: createSketchCompositeSideTarget(f.composite, 0),
          b: createSketchCompositeSideTarget(f.composite, 1)
        }
      }
    ];
    const annotations = sketchDimensionAnnotations(
      f.objects,
      [],
      resolve,
      'mm',
      undefined,
      references,
      [f.composite]
    );
    expect(annotations).toHaveLength(2);
    expect(annotations[0]).toMatchObject({
      label: '(H 20 mm)',
      span: { start: { x: 0 }, end: { x: 20 } }
    });
    expect(annotations[0]!.span!.start.y).toBe(annotations[0]!.span!.end.y);
    expect(annotations[1]!.label).toBe('(90°)');
    expect(
      sketchDimensionAnnotations(
        f.objects,
        [],
        resolve,
        'mm',
        undefined,
        references,
        []
      )
    ).toEqual([]);
  });

  it.each(['corner', 'side'] as const)(
    'refuses trimming any owned member of a measured composite %s',
    (kind) => {
      const f = fixture();
      const data =
        kind === 'corner'
          ? {
              dimensionKind: 'distance' as const,
              a: createSketchCompositeCornerTarget(f.composite, 0),
              b: createSketchCompositeCornerTarget(f.composite, 2)
            }
          : {
              dimensionKind: 'angle' as const,
              a: createSketchCompositeSideTarget(f.composite, 0),
              b: createSketchCompositeSideTarget(f.composite, 1)
            };
      f.manager.execute(
        commandFactories.addSketchReferenceDimension({
          sketchId: f.sketch.sketchId,
          data
        })
      );
      const sketch = findSketch(f.manager.document, f.sketch.sketchId)!;
      // Neither reference directly stores the primitive side being replaced.
      // Its removal would dissolve the shape, so logical identity protects it.
      const plan = planSketchTrim(
        f.manager.document,
        sketch,
        sketch.sketchId,
        f.composite.edgeIds[kind === 'corner' ? 1 : 2]!,
        kind === 'corner' ? { x: 20, y: 6 } : { x: 10, y: 12 },
        resolve
      );
      expect(plan).toMatchObject({ status: 'refuse' });
      if (plan.status === 'refuse')
        expect(plan.reason).toMatch(/reference dimension/i);
    }
  );
});
