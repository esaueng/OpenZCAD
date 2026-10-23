import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchComposite,
  addSketchFeature,
  addSketchReferenceDimension,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import {
  createSketchCompositeCornerTarget,
  isSketchCompositeCornerTarget,
  resolveSketchReferenceDimension,
  toSketchReferenceAnnotationId,
  toUserId,
  type EntityId,
  type SketchReferenceDimensionData
} from '@openzcad/shared';

function fixture() {
  const added = addSketchFeature(
    createProjectDocument(
      'Reference restoration',
      toUserId('user_reference_restore')
    ),
    {
      name: 'Rectangle',
      plane: 'XY',
      objects: [
        { objectKind: 'line', x1: 0, y1: 0, x2: 20, y2: 0 },
        { objectKind: 'line', x1: 20, y1: 0, x2: 20, y2: 6 },
        { objectKind: 'line', x1: 20, y1: 6, x2: 0, y2: 6 },
        { objectKind: 'line', x1: 0, y1: 6, x2: 0, y2: 0 },
        { objectKind: 'line', x1: 0, y1: 0, x2: 20, y2: 6, construction: true },
        { objectKind: 'line', x1: 20, y1: 0, x2: 0, y2: 6, construction: true }
      ]
    }
  );
  const ids = findSketch(added.document, added.sketchId)!.objectIds;
  const grouped = addSketchComposite(added.document, {
    sketchId: added.sketchId,
    composite: {
      compositeKind: 'rectangle',
      method: 'center',
      edgeIds: ids.slice(0, 4),
      helperIds: ids.slice(4)
    }
  });
  const sketch = findSketch(grouped.document, added.sketchId)!;
  const composite = sketch.composites![0]!;
  const data: SketchReferenceDimensionData = {
    dimensionKind: 'distance',
    distanceMode: 'horizontal',
    a: createSketchCompositeCornerTarget(composite, 0),
    b: createSketchCompositeCornerTarget(composite, 1)
  };
  const input = {
    sketchId: added.sketchId,
    data,
    ids: { annotationId: toSketchReferenceAnnotationId('sref_restored') }
  };
  return { document: grouped.document, sketch, composite, ids, input };
}

function object(f: ReturnType<typeof fixture>, id: EntityId) {
  const node = f.document.nodes[id];
  if (node?.kind !== 'sketch-object')
    throw new Error('Expected sketch member.');
  return node;
}

function corner(f: ReturnType<typeof fixture>) {
  if (
    f.input.data.dimensionKind !== 'distance' ||
    !isSketchCompositeCornerTarget(f.input.data.a)
  )
    throw new Error('Expected named corner.');
  return f.input.data.a;
}

describe('composite annotation restoration boundaries', () => {
  it('keeps ordinary nonmeeting live Add refused, regardless of payload flags or captured ids', () => {
    const f = fixture();
    const node = object(f, f.ids[1]!);
    if (node.data.objectKind !== 'line') throw new Error('Expected a line.');
    node.data.x1 = 21;
    const before = JSON.stringify(f.document);
    expect(() => addSketchReferenceDimension(f.document, f.input)).toThrow(
      /no longer meet/
    );
    const manager = new CommandManager(f.document);
    const flagged = { ...f.input, skipValidation: true, replay: true };
    expect(() =>
      manager.execute(commandFactories.addSketchReferenceDimension(flagged))
    ).toThrow(/no longer meet/);
    expect(manager.document).toBe(f.document);
    expect(JSON.stringify(f.document)).toBe(before);
  });

  it('restores strict saved identities without inventing a measurement for an unresolved shape', () => {
    const f = fixture();
    const command = commandFactories
      .addSketchReferenceDimension(f.input)
      .serialize();
    const node = object(f, f.ids[1]!);
    if (node.data.objectKind !== 'line') throw new Error('Expected a line.');
    node.data.x1 = 21;
    const before = structuredClone(f.document);
    const restored = replayCommands(f.document, [command]);
    expect(f.document).toEqual(before);
    expect(findSketch(restored, f.input.sketchId)!.referenceDimensions).toEqual(
      [{ annotationId: f.input.ids.annotationId, data: f.input.data }]
    );
    for (const id of f.ids)
      expect(restored.nodes[id]).toEqual(before.nodes[id]);
    const reference = findSketch(restored, f.input.sketchId)!
      .referenceDimensions![0]!;
    const objects = new Map(
      f.ids.map((id) => [id, object(f, id).data] as const)
    );
    const outcome = resolveSketchReferenceDimension(
      objects,
      reference,
      Number,
      [f.composite]
    );
    expect(outcome.status).toBe('unresolved');
    if (outcome.status !== 'unresolved')
      throw new Error('Expected an unresolved shape.');
    expect(outcome.reason).toMatch(/no longer meet/);
  });

  const invalid: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      'malformed index',
      (f) => {
        corner(f).index = 0.5;
      }
    ],
    [
      'malformed topology version',
      (f) => {
        Object.assign(corner(f).topology, { version: 2 });
      }
    ],
    [
      'reordered captured sides',
      (f) => {
        corner(f).topology.edgeIds.reverse();
      }
    ],
    [
      'reordered owner sides',
      (f) => {
        f.composite.edgeIds.reverse();
      }
    ],
    [
      'foreign owner',
      (f) => {
        Object.assign(corner(f), { compositeId: 'scmp_foreign' });
      }
    ],
    [
      'duplicate owner',
      (f) => {
        f.sketch.composites!.push(structuredClone(f.composite));
      }
    ],
    [
      'missing side',
      (f) => {
        delete f.document.nodes[f.ids[2]!];
      }
    ],
    [
      'wrong side kind',
      (f) => {
        object(f, f.ids[2]!).data = {
          objectKind: 'circle',
          centerX: 0,
          centerY: 0,
          radius: 1
        };
      }
    ],
    [
      'missing helper',
      (f) => {
        delete f.document.nodes[f.ids[4]!];
      }
    ],
    [
      'wrong helper kind',
      (f) => {
        object(f, f.ids[4]!).data = {
          objectKind: 'circle',
          centerX: 0,
          centerY: 0,
          radius: 1,
          construction: true
        };
      }
    ],
    [
      'helper loses construction',
      (f) => {
        object(f, f.ids[4]!).data.construction = false;
      }
    ],
    [
      'same logical point alias',
      (f) => {
        if (f.input.data.dimensionKind === 'distance')
          f.input.data.b = { objectId: f.ids[3]!, point: 'end' };
      }
    ],
    [
      'driving value',
      (f) => {
        Object.assign(f.input.data, { value: 32 });
      }
    ],
    [
      'duplicate annotation',
      (f) => {
        f.sketch.referenceDimensions = [
          {
            annotationId: f.input.ids.annotationId,
            data: structuredClone(f.input.data)
          }
        ];
      }
    ],
    [
      'backdated schema',
      (f) => {
        Object.assign(f.document, { schemaVersion: 35 });
      }
    ]
  ];
  it.each(invalid)(
    'rejects %s on live Add and replay without changing the original',
    (_name, mutate) => {
      const f = fixture();
      mutate(f);
      const before = JSON.stringify(f.document);
      const command = commandFactories.addSketchReferenceDimension(f.input);
      expect(() => addSketchReferenceDimension(f.document, f.input)).toThrow();
      expect(() => command.apply(f.document)).toThrow();
      expect(() => replayCommands(f.document, [command.serialize()])).toThrow();
      expect(JSON.stringify(f.document)).toBe(before);
    }
  );

  it('keeps primitive-only numerical replay validation', () => {
    const f = fixture();
    const zero = object(f, f.ids[0]!);
    zero.data = { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 0 };
    const command = commandFactories.addSketchReferenceDimension({
      sketchId: f.input.sketchId,
      data: { dimensionKind: 'angle', a: f.ids[0]!, b: f.ids[1]! }
    });
    const before = JSON.stringify(f.document);
    expect(() => replayCommands(f.document, [command.serialize()])).toThrow(
      /degenerate|zero/
    );
    expect(JSON.stringify(f.document)).toBe(before);
  });
});
