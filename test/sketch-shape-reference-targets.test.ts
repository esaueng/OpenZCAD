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
  deleteSketchObject,
  findSketch,
  getParameterScope,
  normalizeDocument,
  resolveParamValue,
  setParameter,
  updateSketchObject
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  createSketchCompositeCenterTarget,
  createSketchCompositeCornerTarget,
  isSketchReferenceDimensionData,
  isSketchShapeCornerTarget,
  resolveSketchReferenceDimension,
  sketchShapeTargets,
  toSketchReferenceAnnotationId,
  toUserId,
  type EntityId,
  type ProjectDocument,
  type SketchObjectData,
  type SketchReferenceDimensionData
} from '@openzcad/shared';

const rectangle: SketchObjectData = {
  objectKind: 'rectangle',
  width: 20,
  height: 12,
  centerX: 10,
  centerY: 6
};
const polygon: SketchObjectData = {
  objectKind: 'polygon',
  sides: 'n',
  radius: 10,
  centerX: 40,
  centerY: 0
};
const line: SketchObjectData = {
  objectKind: 'line',
  x1: 0,
  y1: 30,
  x2: 10,
  y2: 40
};

function fixture() {
  const withN = setParameter(
    createProjectDocument('Shape references', toUserId('user_test')),
    { name: 'n', expression: '6' }
  );
  const f = addSketchFeature(withN, {
    name: 'Legacy shapes',
    plane: 'XY',
    objects: [rectangle, polygon, line]
  });
  const [rect, poly, ln] = findSketch(f.document, f.sketchId)!.objectIds as [
    EntityId,
    EntityId,
    EntityId
  ];
  return { ...f, rect, poly, ln };
}

function measure(document: ProjectDocument, sketchId: string) {
  const sketch = findSketch(document, sketchId as never)!;
  const objects = new Map(
    sketch.objectIds.flatMap((id) => {
      const node = document.nodes[id];
      return node?.kind === 'sketch-object' ? [[id, node.data] as const] : [];
    })
  );
  const scope = getParameterScope(document).scope;
  const resolve = (value: number | string) => {
    try {
      return resolveParamValue(value, scope, undefined, document.units);
    } catch {
      return undefined;
    }
  };
  return (sketch.referenceDimensions ?? []).map((reference) =>
    resolveSketchReferenceDimension(
      objects,
      reference,
      resolve,
      sketch.composites
    )
  );
}

describe('S02-D legacy shape reference targets', () => {
  it('measures a legacy rectangle corner, side and centre without converting it', () => {
    const f = fixture();
    const before = structuredClone(f.document.nodes[f.rect]);
    const manager = new CommandManager(f.document);
    const diagonal: SketchReferenceDimensionData = {
      dimensionKind: 'distance',
      a: { kind: 'shape-corner', objectId: f.rect, index: 0, count: 4 },
      b: { kind: 'shape-corner', objectId: f.rect, index: 2, count: 4 }
    };
    const toLine: SketchReferenceDimensionData = {
      dimensionKind: 'distance',
      distanceMode: 'vertical',
      a: { kind: 'shape-center', objectId: f.rect },
      b: { objectId: f.ln, point: 'start' }
    };
    const angle: SketchReferenceDimensionData = {
      dimensionKind: 'angle',
      a: { kind: 'shape-side', objectId: f.rect, index: 0, count: 4 },
      b: f.ln
    };
    for (const data of [diagonal, toLine, angle])
      manager.execute(
        commandFactories.addSketchReferenceDimension({
          sketchId: f.sketchId,
          data
        })
      );
    const [d, v, a] = measure(manager.document, f.sketchId);
    expect(d).toMatchObject({ status: 'current', value: Math.hypot(20, 12) });
    // Corner 0 is the lower-left corner: (0, 0) and corner 2 is (20, 12).
    expect(d).toMatchObject({ a: { x: 0, y: 0 }, b: { x: 20, y: 12 } });
    expect(v).toMatchObject({ status: 'current', value: 24 });
    expect(a).toMatchObject({ status: 'current', dimensionKind: 'angle' });
    expect(
      a?.status === 'current' && 'valueDeg' in a ? a.valueDeg : NaN
    ).toBeCloseTo(45, 9);
    // The shape is never converted or rewritten, and nothing enters the solve.
    expect(manager.document.nodes[f.rect]).toEqual(before);
    expect(findSketch(manager.document, f.sketchId)!.constraints ?? []).toEqual(
      []
    );
    expect(
      findSketch(manager.document, f.sketchId)!.promotions
    ).toBeUndefined();

    // Resizing follows the shape; identities stay put.
    const saved = structuredClone(
      findSketch(manager.document, f.sketchId)!.referenceDimensions
    );
    manager.execute(
      commandFactories.updateSketchObject({
        sketchId: f.sketchId,
        objectId: f.rect,
        data: { ...rectangle, width: 30 }
      })
    );
    expect(measure(manager.document, f.sketchId)[0]).toMatchObject({
      value: Math.hypot(30, 12)
    });
    expect(
      findSketch(manager.document, f.sketchId)!.referenceDimensions
    ).toEqual(saved);

    // Undo/redo, full replay and reopen keep the same annotations.
    manager.undo();
    manager.redo();
    const replayed = replayCommands(f.document, manager.document.commandLog);
    expect(findSketch(replayed, f.sketchId)!.referenceDimensions).toEqual(
      saved
    );
    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(findSketch(reopened, f.sketchId)!.referenceDimensions).toEqual(
      saved
    );
    expect(reopened.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
  });

  it('numbers a legacy polygon from its top vertex and never re-indexes a changed count', () => {
    const f = fixture();
    const targets = sketchShapeTargets(f.poly, polygon, (value) =>
      value === 'n' ? 6 : Number(value)
    )!;
    expect(targets.corners).toHaveLength(6);
    const added = addSketchReferenceDimension(f.document, {
      sketchId: f.sketchId,
      data: {
        dimensionKind: 'distance',
        a: targets.corners[0]!,
        b: targets.center
      }
    });
    const [top] = measure(added.document, f.sketchId);
    expect(top).toMatchObject({ status: 'current', value: 10 });
    const corner = top?.status === 'current' && 'a' in top ? top.a : undefined;
    expect(corner?.x).toBeCloseTo(40, 9);
    expect(corner?.y).toBeCloseTo(10, 9);
    // A direct edit that changes the count refuses and keeps the shape.
    expect(() =>
      updateSketchObject(added.document, {
        sketchId: f.sketchId,
        objectId: f.poly,
        data: { ...polygon, sides: 5 }
      })
    ).toThrow(/measure this shape's corners or sides.*The shape was kept/);
    // A radius edit keeps the count and is accepted.
    expect(() =>
      updateSketchObject(added.document, {
        sketchId: f.sketchId,
        objectId: f.poly,
        data: { ...polygon, radius: 12 }
      })
    ).not.toThrow();
    // A parameter edit cannot be refused there: the reference is unresolved
    // by name instead of quietly naming a different vertex.
    const edited = setParameter(added.document, {
      name: 'n',
      expression: '5'
    });
    const objects = new Map(
      findSketch(edited, f.sketchId)!.objectIds.map((id) => [
        id,
        (edited.nodes[id] as { data: SketchObjectData }).data
      ])
    );
    const outcome = resolveSketchReferenceDimension(
      objects,
      findSketch(edited, f.sketchId)!.referenceDimensions![0]!,
      (value) => (value === 'n' ? 5 : Number(value))
    );
    expect(outcome).toMatchObject({ status: 'unresolved' });
    expect(outcome.status === 'unresolved' && outcome.reason).toMatch(
      /now has 5 sides, not 6\. Re-create the reference explicitly/
    );
  });

  it('refuses the same target twice, deletion while measured and conversion while measured', () => {
    const f = fixture();
    const corner = {
      kind: 'shape-corner' as const,
      objectId: f.rect,
      index: 1,
      count: 4
    };
    expect(() =>
      addSketchReferenceDimension(f.document, {
        sketchId: f.sketchId,
        data: { dimensionKind: 'distance', a: corner, b: { ...corner } }
      })
    ).toThrow(/two distinct points/);
    expect(() =>
      addSketchReferenceDimension(f.document, {
        sketchId: f.sketchId,
        data: {
          dimensionKind: 'angle',
          a: { kind: 'shape-side', objectId: f.rect, index: 1, count: 4 },
          b: { kind: 'shape-side', objectId: f.rect, index: 1, count: 4 }
        }
      })
    ).toThrow(/two distinct lines/);
    // A rectangle always has four sides; any other witness is refused.
    expect(() =>
      addSketchReferenceDimension(f.document, {
        sketchId: f.sketchId,
        data: {
          dimensionKind: 'distance',
          a: { kind: 'shape-corner', objectId: f.rect, index: 0, count: 5 },
          b: { objectId: f.ln, point: 'end' }
        }
      })
    ).toThrow(/a rectangle has 4 sides/);
    // A shape target on a line is refused by name.
    expect(() =>
      addSketchReferenceDimension(f.document, {
        sketchId: f.sketchId,
        data: {
          dimensionKind: 'distance',
          a: { kind: 'shape-center', objectId: f.ln },
          b: { kind: 'shape-center', objectId: f.rect }
        }
      })
    ).toThrow(/not a legacy rectangle or regular polygon/);

    const added = addSketchReferenceDimension(f.document, {
      sketchId: f.sketchId,
      data: {
        dimensionKind: 'distance',
        a: corner,
        b: { objectId: f.ln, point: 'end' }
      }
    });
    expect(() =>
      deleteSketchObject(added.document, {
        sketchId: f.sketchId,
        objectId: f.rect
      })
    ).toThrow(/Delete the reference dimensions first/);
    const manager = new CommandManager(added.document);
    expect(() =>
      manager.execute(
        commandFactories.convertLegacySketchObject({
          sketchId: f.sketchId,
          sourceObjectId: f.rect
        })
      )
    ).toThrow(/Remove or repair it first/);
    expect(manager.document).toEqual(added.document);
  });

  it('refuses malformed shape descriptors and older carriers', () => {
    const f = fixture();
    const good = { kind: 'shape-corner', objectId: f.rect, index: 0, count: 4 };
    expect(isSketchShapeCornerTarget(good)).toBe(true);
    for (const bad of [
      { ...good, index: 4 },
      { ...good, index: -1 },
      { ...good, index: 0.5 },
      { ...good, count: 2 },
      { ...good, count: 65 },
      { ...good, extra: true },
      { ...good, objectId: '' }
    ])
      expect(isSketchShapeCornerTarget(bad), JSON.stringify(bad)).toBe(false);
    expect(
      isSketchReferenceDimensionData({
        dimensionKind: 'distance',
        a: good,
        b: { kind: 'shape-center', objectId: f.rect },
        value: 5
      })
    ).toBe(false);

    const added = addSketchReferenceDimension(f.document, {
      sketchId: f.sketchId,
      data: {
        dimensionKind: 'distance',
        a: good as never,
        b: { kind: 'shape-center', objectId: f.rect }
      }
    });
    const old = structuredClone(added.document);
    Object.assign(old, { schemaVersion: 120 });
    const upgrade =
      /Shape centre and legacy shape reference targets require project schema v125 or newer/;
    expect(() => normalizeDocument(old)).toThrow(upgrade);
    expect(() => new CommandManager(old)).toThrow(upgrade);
  });
});

describe('S02-D composite centre targets', () => {
  function composites() {
    const ln = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      construction = false
    ): SketchObjectData => ({
      objectKind: 'line',
      x1,
      y1,
      x2,
      y2,
      construction
    });
    const f = addSketchFeature(
      createProjectDocument('Composite centres', toUserId('user_test')),
      {
        name: 'Held lines',
        plane: 'XY',
        objects: [
          ln(0, 0, 20, 0),
          ln(20, 0, 20, 12),
          ln(20, 12, 0, 12),
          ln(0, 12, 0, 0),
          ln(-10, 0, 0, 30)
        ]
      }
    );
    const ids = findSketch(f.document, f.sketchId)!.objectIds;
    const added = addSketchComposite(f.document, {
      sketchId: f.sketchId,
      composite: {
        compositeKind: 'rectangle',
        method: 'corner',
        edgeIds: ids.slice(0, 4)
      }
    });
    const composite = findSketch(added.document, f.sketchId)!.composites![0]!;
    return { ...f, document: added.document, composite, ids };
  }

  it('measures a corner rectangle centre through replay, undo and reopen', () => {
    const f = composites();
    const manager = new CommandManager(f.document);
    manager.execute(
      commandFactories.addSketchReferenceDimension({
        sketchId: f.sketchId,
        data: {
          dimensionKind: 'distance',
          distanceMode: 'horizontal',
          a: createSketchCompositeCenterTarget(f.composite),
          b: createSketchCompositeCornerTarget(f.composite, 1)
        }
      })
    );
    expect(measure(manager.document, f.sketchId)[0]).toMatchObject({
      status: 'current',
      value: 10,
      a: { x: 10, y: 6 }
    });
    const saved = structuredClone(
      findSketch(manager.document, f.sketchId)!.referenceDimensions
    );
    manager.undo();
    expect(
      findSketch(manager.document, f.sketchId)!.referenceDimensions ?? []
    ).toEqual([]);
    manager.redo();
    expect(
      findSketch(manager.document, f.sketchId)!.referenceDimensions
    ).toEqual(saved);
    const replayed = replayCommands(f.document, manager.document.commandLog);
    expect(findSketch(replayed, f.sketchId)!.referenceDimensions).toEqual(
      saved
    );
    // Deleting a member of the measured shape refuses until the annotation goes.
    expect(() =>
      deleteSketchObject(manager.document, {
        sketchId: f.sketchId,
        objectId: f.ids[2]!
      })
    ).toThrow(/Delete the reference dimensions first/);
  });

  it('refuses a centre that the same shape names twice and reports a broken owner', () => {
    const f = composites();
    const centre = createSketchCompositeCenterTarget(f.composite);
    expect(() =>
      addSketchReferenceDimension(f.document, {
        sketchId: f.sketchId,
        data: { dimensionKind: 'distance', a: centre, b: { ...centre } }
      })
    ).toThrow(/two distinct points/);
    const stale = { ...centre, compositeId: 'scmp_missing' as never };
    const sketch = findSketch(f.document, f.sketchId)!;
    const objects = new Map(
      sketch.objectIds.map((id) => [
        id,
        (f.document.nodes[id] as { data: SketchObjectData }).data
      ])
    );
    const outcome = resolveSketchReferenceDimension(
      objects,
      {
        annotationId: toSketchReferenceAnnotationId('sref_stale'),
        data: {
          dimensionKind: 'distance',
          a: stale,
          b: { objectId: f.ids[4]!, point: 'start' }
        }
      },
      Number,
      sketch.composites
    );
    expect(outcome).toMatchObject({ status: 'unresolved' });
    expect(outcome.status === 'unresolved' && outcome.reason).toMatch(
      /Composite "scmp_missing" centre: its owning composite is missing/
    );
  });
});
