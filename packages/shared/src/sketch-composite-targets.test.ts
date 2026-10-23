import { describe, expect, it } from 'vitest';
import {
  toEntityId,
  toSketchCompositeId,
  type EntityId,
  type SketchComposite,
  type SketchObjectData,
  type SketchReferenceDimension,
  type SketchReferenceDimensionData
} from './index';
import {
  createSketchCompositeCornerTarget,
  createSketchCompositeSideTarget,
  isSketchCompositeCornerTarget,
  isSketchCompositeSideTarget,
  resolveSketchCompositeCornerTarget,
  resolveSketchCompositeSideTarget,
  resolveSketchCompositeTargetIdentity,
  sketchCompositeTargetMemberIds
} from './sketch-composite-targets';
import {
  describeSketchReferenceDimension,
  isSketchReferenceDimensionData,
  resolveSketchReferenceDimension,
  sketchReferenceDimensionObjectIds,
  validateSketchReferenceDimensionData
} from './sketch-reference-dimensions';

const number = (value: number | string) =>
  typeof value === 'number' ? value : undefined;

function unresolvedReason(reason: RegExp) {
  // Vitest's asymmetric matcher has an untyped return; keep it unknown.
  const matcher: unknown = expect.stringMatching(reason);
  return { status: 'unresolved', reason: matcher };
}

function loop(
  corners: { x: number; y: number }[],
  name = 'rectangle',
  method: SketchComposite['method'] = 'corner'
) {
  const edgeIds = corners.map((_, index) =>
    toEntityId(`${name}_side_${index}`)
  );
  const objects = new Map<EntityId, SketchObjectData>(
    corners.map((p, index) => {
      const q = corners[(index + 1) % corners.length]!;
      return [
        edgeIds[index]!,
        { objectKind: 'line', x1: p.x, y1: p.y, x2: q.x, y2: q.y }
      ];
    })
  );
  const composite: SketchComposite =
    method === 'inscribed'
      ? {
          compositeId: toSketchCompositeId(`scmp_${name}`),
          compositeKind: 'polygon',
          method,
          edgeIds
        }
      : {
          compositeId: toSketchCompositeId(`scmp_${name}`),
          compositeKind: 'rectangle',
          method,
          edgeIds
        };
  return { composite, objects };
}

function rectangle(
  width = 4,
  height = 3,
  method: 'corner' | 'center' | 'three-point' = 'corner'
) {
  const result = loop(
    [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height }
    ],
    'rectangle',
    method
  );
  if (method === 'center') {
    result.composite.helperIds = [
      toEntityId('diagonal0'),
      toEntityId('diagonal1')
    ];
    result.objects.set(result.composite.helperIds[0]!, {
      objectKind: 'line',
      x1: 0,
      y1: 0,
      x2: width,
      y2: height,
      construction: true
    });
    result.objects.set(result.composite.helperIds[1]!, {
      objectKind: 'line',
      x1: width,
      y1: 0,
      x2: 0,
      y2: height,
      construction: true
    });
  }
  return result;
}

function polygon(count: number) {
  const corners = Array.from({ length: count }, (_, index) => {
    const angle = Math.PI / 2 + (index * Math.PI * 2) / count;
    return { x: 10 * Math.cos(angle), y: 10 * Math.sin(angle) };
  });
  const result = loop(corners, `polygon${count}`, 'inscribed');
  result.composite.helperIds = [toEntityId('circumcircle')];
  result.objects.set(result.composite.helperIds[0]!, {
    objectKind: 'circle',
    centerX: 0,
    centerY: 0,
    radius: 10,
    construction: true
  });
  return { ...result, corners };
}

const annotation = (
  data: SketchReferenceDimensionData
): SketchReferenceDimension => ({
  annotationId: 'sref_composite' as SketchReferenceDimension['annotationId'],
  data
});

describe('S04 held-line named target identity', () => {
  it.each(['corner', 'center', 'three-point'] as const)(
    'resolves every %s rectangle corner and real side in stored order',
    (method) => {
      const { composite, objects } = rectangle(4, 3, method);
      const corners = [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 3 },
        { x: 0, y: 3 }
      ];
      for (const [index, point] of corners.entries()) {
        const corner = createSketchCompositeCornerTarget(composite, index);
        const side = createSketchCompositeSideTarget(composite, index);
        expect(
          resolveSketchCompositeCornerTarget(
            corner,
            [composite],
            objects,
            number
          )
        ).toEqual({
          status: 'resolved',
          point,
          pointRef: { objectId: composite.edgeIds[index], point: 'start' }
        });
        expect(
          resolveSketchCompositeSideTarget(side, [composite], objects, number)
        ).toEqual({
          status: 'resolved',
          objectId: composite.edgeIds[index],
          start: point,
          end: corners[(index + 1) % 4]
        });
      }
    }
  );

  it.each([3, 6, 64])(
    'resolves %i-sided polygon targets without coordinate-derived identities',
    (count) => {
      const { composite, objects, corners } = polygon(count);
      for (let index = 0; index < count; index++) {
        const target = createSketchCompositeCornerTarget(composite, index);
        expect(
          resolveSketchCompositeCornerTarget(
            target,
            [composite],
            objects,
            number
          )
        ).toMatchObject({ status: 'resolved', point: corners[index] });
      }
      const lastSide = createSketchCompositeSideTarget(composite, count - 1);
      expect(
        resolveSketchCompositeSideTarget(lastSide, [composite], objects, number)
      ).toMatchObject({ status: 'resolved', end: corners[0] });
    }
  );

  it.each([-1, 4, 0.5, NaN, Infinity])(
    'refuses corner and side index %s rather than wrapping',
    (index) => {
      const { composite } = rectangle();
      expect(() => createSketchCompositeCornerTarget(composite, index)).toThrow(
        /scmp_rectangle.*index/
      );
      expect(() => createSketchCompositeSideTarget(composite, index)).toThrow(
        /scmp_rectangle.*index/
      );
    }
  );

  it('captures topology independently and dependency reads do not mutate it', () => {
    const { composite } = rectangle(4, 3, 'center');
    const corner = createSketchCompositeCornerTarget(composite, 0);
    const expected = [...composite.edgeIds, ...composite.helperIds!];
    composite.edgeIds.reverse();
    composite.helperIds!.reverse();
    expect(sketchCompositeTargetMemberIds(corner)).toEqual(expected);
    sketchCompositeTargetMemberIds(corner).reverse();
    expect(sketchCompositeTargetMemberIds(corner)).toEqual(expected);
  });

  it('keeps the same target through a resize and source JSON round-trip', () => {
    const before = rectangle();
    const target = createSketchCompositeCornerTarget(before.composite, 2);
    const saved = JSON.parse(JSON.stringify(target)) as typeof target;
    const after = rectangle(8, 6);
    expect(
      resolveSketchCompositeCornerTarget(
        saved,
        [after.composite],
        after.objects,
        number
      )
    ).toMatchObject({ status: 'resolved', point: { x: 8, y: 6 } });
    expect(saved).toEqual(target);
  });

  it('qualifies full topology and shape, even when the selected line survives', () => {
    const { composite, objects } = rectangle(4, 3, 'center');
    const target = createSketchCompositeCornerTarget(composite, 0);
    const reordered = {
      ...composite,
      edgeIds: [...composite.edgeIds].reverse()
    };
    expect(
      resolveSketchCompositeCornerTarget(target, [reordered], objects, number)
    ).toMatchObject(unresolvedReason(/scmp_rectangle.*ordered sides/));
    expect(
      resolveSketchCompositeCornerTarget(
        target,
        [{ ...composite, helperIds: [...composite.helperIds!].reverse() }],
        objects,
        number
      )
    ).toMatchObject(unresolvedReason(/helpers changed/));
    const missing = new Map(objects);
    missing.delete(composite.edgeIds[2]!);
    expect(
      resolveSketchCompositeCornerTarget(target, [composite], missing, number)
    ).toMatchObject(unresolvedReason(/side.*missing/));
    const opened = new Map(objects);
    opened.set(composite.edgeIds[2]!, {
      objectKind: 'line',
      x1: 4,
      y1: 4,
      x2: 0,
      y2: 3
    });
    expect(
      resolveSketchCompositeCornerTarget(target, [composite], opened, number)
    ).toMatchObject(unresolvedReason(/no longer meet/));
    const missingHelper = new Map(objects);
    missingHelper.delete(composite.helperIds![0]!);
    expect(
      resolveSketchCompositeCornerTarget(
        target,
        [composite],
        missingHelper,
        number
      )
    ).toMatchObject(unresolvedReason(/construction helper.*missing/));
  });

  it('refuses missing, foreign or duplicate owners without falling back to matching geometry', () => {
    const { composite, objects } = rectangle();
    const target = createSketchCompositeSideTarget(composite, 0);
    for (const owners of [
      [],
      [{ ...composite, compositeId: toSketchCompositeId('scmp_other') }],
      [composite, composite]
    ])
      expect(
        resolveSketchCompositeSideTarget(target, owners, objects, number)
      ).toMatchObject(
        unresolvedReason(
          /scmp_rectangle.*owning composite.*missing or ambiguous/
        )
      );
  });

  it('rejects unknown or malformed descriptors and wrong target roles', () => {
    const { composite, objects } = rectangle();
    const target = createSketchCompositeCornerTarget(composite, 0);
    const invalid = [
      { ...target, kind: 'composite-center' },
      { ...target, topology: { ...target.topology, edgeIds: new Array(4) } },
      { ...target, topology: { ...target.topology, helperIds: new Array(1) } },
      { ...target, index: 4 },
      { ...target, index: 0.1 },
      { ...target, value: 4 },
      { ...target, topology: { ...target.topology, version: 2 } },
      {
        ...target,
        topology: {
          ...target.topology,
          edgeIds: [
            composite.edgeIds[0],
            ...composite.edgeIds.slice(1, 3),
            composite.edgeIds[0]
          ]
        }
      },
      {
        ...target,
        topology: { ...target.topology, helperIds: [composite.edgeIds[0]] }
      },
      { ...target, topology: { ...target.topology, extra: true } },
      { ...target, topology: { ...target.topology, edgeIds: [] } },
      {
        ...target,
        topology: {
          ...target.topology,
          edgeIds: ['', ...composite.edgeIds.slice(1)]
        }
      }
    ];
    for (const value of invalid) {
      expect(isSketchCompositeCornerTarget(value)).toBe(false);
      expect(
        resolveSketchCompositeTargetIdentity(
          value as typeof target,
          [composite],
          objects
        ).status
      ).toBe('unresolved');
    }
    expect(isSketchCompositeSideTarget(target)).toBe(false);
    expect(
      resolveSketchCompositeSideTarget(
        target as never,
        [composite],
        objects,
        number
      ).status
    ).toBe('unresolved');
  });

  it('does not accept non-finite or throwing expression results, including helpers', () => {
    const { composite, objects } = rectangle(4, 3, 'center');
    const target = createSketchCompositeCornerTarget(composite, 0);
    const modified = new Map(objects);
    modified.set(composite.helperIds![0]!, {
      objectKind: 'line',
      x1: 'unknown',
      y1: 0,
      x2: 4,
      y2: 3,
      construction: true
    });
    for (const bad of [NaN, Infinity])
      expect(
        resolveSketchCompositeCornerTarget(
          target,
          [composite],
          modified,
          (value) => (typeof value === 'number' ? value : bad)
        ).status
      ).toBe('unresolved');
    expect(
      resolveSketchCompositeCornerTarget(
        target,
        [composite],
        modified,
        (value) => {
          if (typeof value === 'string') throw new Error('unknown parameter');
          return value;
        }
      ).status
    ).toBe('unresolved');
  });

  it('publishes the actual side endpoint even when closure residuals are within tolerance', () => {
    const { composite, objects } = rectangle();
    objects.set(composite.edgeIds[0]!, {
      objectKind: 'line',
      x1: 0,
      y1: 0,
      x2: 4,
      y2: 1e-8
    });
    expect(
      resolveSketchCompositeSideTarget(
        createSketchCompositeSideTarget(composite, 0),
        [composite],
        objects,
        number
      )
    ).toMatchObject({ status: 'resolved', end: { x: 4, y: 1e-8 } });
  });
});

describe('S02 named composite reference targets', () => {
  it.each([
    ['absolute', 5],
    ['horizontal', 4],
    ['vertical', 3]
  ] as const)(
    'measures %s corner distance and leaves targets unchanged',
    (distanceMode, expected) => {
      const { composite, objects } = rectangle();
      const reference = annotation({
        dimensionKind: 'distance',
        distanceMode,
        a: createSketchCompositeCornerTarget(composite, 0),
        b: createSketchCompositeCornerTarget(composite, 2)
      });
      const saved = structuredClone(reference);
      expect(
        resolveSketchReferenceDimension(objects, reference, number, [composite])
      ).toMatchObject({ status: 'current', value: expected });
      expect(reference).toEqual(saved);
      expect(isSketchReferenceDimensionData(reference.data)).toBe(true);
      expect(() =>
        validateSketchReferenceDimensionData(
          objects,
          reference.data,
          'sref_composite',
          [composite]
        )
      ).not.toThrow();
    }
  );

  it('measures side angles and refuses the same real line named through an alias', () => {
    const { composite, objects } = rectangle();
    const first = createSketchCompositeSideTarget(composite, 0);
    const second = createSketchCompositeSideTarget(composite, 1);
    expect(
      resolveSketchReferenceDimension(
        objects,
        annotation({ dimensionKind: 'angle', a: first, b: second }),
        number,
        [composite]
      )
    ).toMatchObject({ status: 'current', valueDeg: 90 });
    const same = annotation({
      dimensionKind: 'angle',
      a: first,
      b: composite.edgeIds[0]!
    });
    expect(
      resolveSketchReferenceDimension(objects, same, number, [composite])
    ).toMatchObject(unresolvedReason(/two distinct lines/));
    expect(() =>
      validateSketchReferenceDimensionData(objects, same.data, 'sref_alias', [
        composite
      ])
    ).toThrow(/sref_alias.*two distinct lines/);
  });

  it.each(['start', 'previous-end'] as const)(
    'rejects a logical corner paired with its %s primitive alias',
    (role) => {
      const { composite, objects } = rectangle();
      const corner = createSketchCompositeCornerTarget(composite, 0);
      const point =
        role === 'start'
          ? { objectId: composite.edgeIds[0]!, point: 'start' as const }
          : { objectId: composite.edgeIds[3]!, point: 'end' as const };
      for (const [a, b] of [
        [corner, point],
        [point, corner]
      ] as const) {
        const reference = annotation({ dimensionKind: 'distance', a, b });
        expect(
          resolveSketchReferenceDimension(objects, reference, number, [
            composite
          ])
        ).toMatchObject(unresolvedReason(/same target twice/));
        expect(() =>
          validateSketchReferenceDimensionData(
            objects,
            reference.data,
            undefined,
            [composite]
          )
        ).toThrow(/same target twice/);
      }
      const primitiveOnly = annotation({
        dimensionKind: 'distance',
        a: { objectId: composite.edgeIds[0]!, point: 'start' },
        b: { objectId: composite.edgeIds[3]!, point: 'end' }
      });
      expect(
        resolveSketchReferenceDimension(objects, primitiveOnly, number, [
          composite
        ])
      ).toMatchObject({ status: 'current', value: 0 });
    }
  );

  it('validates expression-backed ownership without prematurely resolving values', () => {
    const { composite, objects } = rectangle();
    const line = objects.get(composite.edgeIds[0]!)!;
    if (line.objectKind !== 'line') throw new Error('fixture lost line');
    line.x2 = 'width';
    const reference = annotation({
      dimensionKind: 'distance',
      a: createSketchCompositeCornerTarget(composite, 0),
      b: createSketchCompositeCornerTarget(composite, 2)
    });
    expect(() =>
      validateSketchReferenceDimensionData(objects, reference.data, undefined, [
        composite
      ])
    ).not.toThrow();
    expect(
      resolveSketchReferenceDimension(
        objects,
        reference,
        (value) => (value === 'width' ? 4 : number(value)),
        [composite]
      )
    ).toMatchObject({ status: 'current', value: 5 });
    expect(
      resolveSketchReferenceDimension(objects, reference, number, [composite])
    ).toMatchObject(unresolvedReason(/scmp_rectangle.*does not resolve/));
  });

  it('collects every saved member and helper as a dependency without needing a live owner', () => {
    const { composite } = rectangle(4, 3, 'center');
    const first = createSketchCompositeCornerTarget(composite, 0);
    const second = createSketchCompositeCornerTarget(composite, 2);
    expect(
      sketchReferenceDimensionObjectIds({
        dimensionKind: 'distance',
        a: first,
        b: second
      })
    ).toEqual([...composite.edgeIds, ...composite.helperIds!]);
    expect(
      sketchReferenceDimensionObjectIds({
        dimensionKind: 'angle',
        a: createSketchCompositeSideTarget(composite, 0),
        b: createSketchCompositeSideTarget(composite, 1)
      })
    ).toEqual([...composite.edgeIds, ...composite.helperIds!]);
  });

  it('names logical corners and sides through the caller’s friendly composite label', () => {
    const { composite } = rectangle();
    expect(
      describeSketchReferenceDimension(
        {
          dimensionKind: 'distance',
          a: createSketchCompositeCornerTarget(composite, 0),
          b: createSketchCompositeCornerTarget(composite, 2)
        },
        String,
        () => 'Rectangle 1'
      )
    ).toBe(
      'Reference distance · Rectangle 1 · Corner 1 ↔ Rectangle 1 · Corner 3'
    );
    expect(
      describeSketchReferenceDimension(
        {
          dimensionKind: 'angle',
          a: createSketchCompositeSideTarget(composite, 0),
          b: createSketchCompositeSideTarget(composite, 1)
        },
        String,
        () => 'Rectangle 1'
      )
    ).toBe('Reference angle · Rectangle 1 · Side 1 ∠ Rectangle 1 · Side 2');
  });
});
