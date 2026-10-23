import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  normalizeDocument,
  renameParameter,
  deleteParameter,
  setParameter,
  updateSketchObject
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  resolveSketchPromotionBoundaryTokens,
  toEntityId,
  makeSketchCompositeBoundaryToken,
  toSketchConstraintId,
  toUserId,
  type ProjectDocument,
  type SketchObjectData
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
  sides: 6,
  radius: 10,
  centerX: 0,
  centerY: 0
};
function fixture(data: SketchObjectData = rectangle, downstream = false) {
  const initial = addSketchFeature(
    createProjectDocument('Legacy conversion', toUserId('user_test')),
    { name: 'Legacy outline', plane: 'XY', objects: [data] }
  );
  const sourceObjectId = findSketch(initial.document, initial.sketchId)!
    .objectIds[0]!;
  let base = initial.document;
  if (downstream) {
    const analysis = computeSketchProfileAnalysis(
      [{ id: sourceObjectId, data }],
      Number
    );
    const region = analysis.profiles[0]!;
    base = extrudeSketch(base, {
      name: 'Plate',
      sketchId: initial.sketchId,
      distance: 5,
      profile: {
        profileId: region.profileId,
        regionFingerprint: region.regionFingerprint,
        sourceArea: region.area,
        samplePoint: region.samplePoint,
        sourceEntityIds: region.sourceEntityIds
      },
      operation: 'new-body'
    }).document;
  }
  return {
    base,
    manager: new CommandManager(base),
    sketchId: initial.sketchId,
    sourceObjectId
  };
}
function convert(f: ReturnType<typeof fixture>) {
  f.manager.execute(
    commandFactories.convertLegacySketchObject({
      sketchId: f.sketchId,
      sourceObjectId: f.sourceObjectId
    })
  );
  return findSketch(f.manager.document, f.sketchId)!.promotions![0]!;
}

describe('explicit legacy conversion', () => {
  it.each([rectangle, polygon, { ...rectangle, construction: true }])(
    'atomically promotes $objectKind with stable identities through undo/replay/reopen',
    (data) => {
      const f = fixture(data);
      const source = structuredClone(f.base.nodes[f.sourceObjectId]);
      const p = convert(f);
      const result = structuredClone(f.manager.document);
      expect(p.sourceData).toEqual(data);
      expect(p.edgeIds).toHaveLength(data.objectKind === 'polygon' ? 6 : 4);
      expect(p.helperIds).toHaveLength(data.objectKind === 'rectangle' ? 1 : 0);
      expect(f.manager.document.nodes[f.sourceObjectId]).toBeUndefined();
      expect(
        p.edgeIds.every((id) => {
          const node = result.nodes[id];
          return (
            node?.kind === 'sketch-object' &&
            node.data.construction === data.construction
          );
        })
      ).toBe(true);
      expect(
        normalizeDocument(JSON.parse(JSON.stringify(result)) as ProjectDocument)
      ).toEqual(result);
      expect(
        findSketch(replayCommands(f.base, result.commandLog), f.sketchId)
      ).toEqual(findSketch(result, f.sketchId));
      f.manager.undo();
      expect(f.manager.document.nodes[f.sourceObjectId]).toEqual(source);
      expect(
        findSketch(f.manager.document, f.sketchId)!.promotions
      ).toBeUndefined();
      expect(p.edgeIds.every((id) => !f.manager.document.nodes[id])).toBe(true);
      f.manager.redo();
      expect(findSketch(f.manager.document, f.sketchId)).toEqual(
        findSketch(result, f.sketchId)
      );
    }
  );

  it('retains unrelated user constraints in declaration order and releases only owned structure', () => {
    const f = fixture();
    const extra = commandFactories.addSketchObjects({
      sketchId: f.sketchId,
      objects: [{ objectKind: 'line', x1: 50, y1: 0, x2: 60, y2: 0 }]
    });
    f.manager.execute(extra);
    const objectId = findSketch(f.manager.document, f.sketchId)!.objectIds[1]!;
    f.manager.execute(
      commandFactories.addSketchConstraint({
        sketchId: f.sketchId,
        constraint: {
          constraintKind: 'distance',
          a: { objectId, point: 'start' },
          b: { objectId, point: 'end' },
          value: 10
        }
      })
    );
    const users = structuredClone(
      findSketch(f.manager.document, f.sketchId)!.constraints
    );
    const p = convert(f);
    const sketch = findSketch(f.manager.document, f.sketchId)!;
    expect(sketch.constraints!.slice(0, users!.length)).toEqual(users);
    expect(
      sketch
        .constraints!.slice(users!.length)
        .every(
          (c) =>
            c.origin === 'promotion-structure' &&
            c.promotionId === p.promotionId
        )
    ).toBe(true);
    expect(() =>
      f.manager.execute(
        commandFactories.deleteSketchConstraint({
          sketchId: f.sketchId,
          constraintId: p.structureConstraintIds[0]!
        })
      )
    ).toThrow(/Release/);
    f.manager.execute(
      commandFactories.releaseSketchPromotionStructure({
        sketchId: f.sketchId,
        promotionId: p.promotionId
      })
    );
    expect(findSketch(f.manager.document, f.sketchId)!.constraints).toEqual(
      users
    );
    expect(
      findSketch(f.manager.document, f.sketchId)!.promotions![0]!
        .structureConstraintIds
    ).toEqual([]);
    expect(normalizeDocument(f.manager.document)).toEqual(f.manager.document);
    f.manager.undo();
    expect(findSketch(f.manager.document, f.sketchId)).toEqual(sketch);
  });

  it('preserves raw size expressions and derived coordinate reads rather than baking source parameters', () => {
    const f = fixture({ ...rectangle, width: 'span', centerX: 'span / 2' });
    f.manager.document = setParameter(f.manager.document, {
      name: 'span',
      expression: '20'
    });
    const p = convert(f);
    const sketch = findSketch(f.manager.document, f.sketchId)!;
    expect(
      sketch.constraints!.some(
        (c) => c.data.constraintKind === 'distance' && c.data.value === 'span'
      )
    ).toBe(true);
    expect(p.sourceData).toEqual({
      ...rectangle,
      width: 'span',
      centerX: 'span / 2'
    });
    const edge = f.manager.document.nodes[p.edgeIds[0]!]!;
    expect(
      edge.kind === 'sketch-object' &&
        edge.data.objectKind === 'line' &&
        edge.data.x2
    ).toContain('span');
    const renamed = renameParameter(f.manager.document, {
      name: 'span',
      newName: 'width'
    });
    expect(findSketch(renamed, f.sketchId)!.promotions![0]!.sourceData).toEqual(
      p.sourceData
    );
    expect(
      findSketch(renamed, f.sketchId)!.constraints!.some(
        (c) => c.data.constraintKind === 'distance' && c.data.value === 'width'
      )
    ).toBe(true);
  });

  it('preserves existing entity-wide intent without widening a bounded selection', () => {
    const f = fixture(rectangle, true);
    const feature = Object.values(f.manager.document.nodes).find(
      (n) => n.kind === 'feature' && n.data.featureKind === 'extrude'
    )!;
    if (feature.kind !== 'feature' || feature.data.featureKind !== 'extrude')
      throw new Error('Missing feature');
    feature.data.profile = { all: true, sourceEntityIds: [f.sourceObjectId] };
    const p = convert(f);
    const after = f.manager.document.nodes[feature.id];
    expect(
      after?.kind === 'feature' &&
        after.data.featureKind === 'extrude' &&
        after.data.profile
    ).toEqual({ all: true, sourceEntityIds: p.edgeIds });
  });

  it('leaves an unrelated unresolved provenance selection byte-identical', () => {
    const f = fixture(rectangle, true);
    const feature = Object.values(f.manager.document.nodes).find(
      (n) => n.kind === 'feature' && n.data.featureKind === 'extrude'
    )!;
    if (feature.kind !== 'feature' || feature.data.featureKind !== 'extrude')
      throw new Error('Missing feature');
    const reference = {
      regionFingerprint: 0,
      sourceArea: 100,
      samplePoint: { x: 0, y: 0 },
      sourceBoundaryLoops: {
        outer: Array.from({ length: 4 }, (_, i) =>
          makeSketchCompositeBoundaryToken(
            'ent_missing',
            { kind: 'rectangle', version: 1, count: 4 },
            i
          )
        ),
        holes: []
      }
    };
    feature.data.profile = reference;
    convert(f);
    const after = f.manager.document.nodes[feature.id];
    expect(
      after?.kind === 'feature' &&
        after.data.featureKind === 'extrude' &&
        after.data.profile
    ).toEqual(reference);
  });

  it('adds boundary witnesses only in the explicit replacement and protects downstream aliases', () => {
    const f = fixture(rectangle, true);
    const before = JSON.stringify(f.base);
    const p = convert(f);
    expect(JSON.stringify(f.base)).toBe(before);
    const feature = Object.values(f.manager.document.nodes).find(
      (n) => n.kind === 'feature' && n.data.featureKind === 'extrude'
    )!;
    expect(
      feature.kind === 'feature' &&
        feature.data.featureKind === 'extrude' &&
        feature.data.profile
    ).toHaveProperty('sourceBoundaryLoops');
    for (const objectId of [...p.edgeIds, p.centerSpokeId, ...p.helperIds]) {
      const document = f.manager.document;
      expect(() =>
        f.manager.execute(
          commandFactories.deleteSketchObject({
            sketchId: f.sketchId,
            objectId
          })
        )
      ).toThrow(/downstream boundary/);
      expect(f.manager.document).toBe(document);
    }
  });

  it('dissolves unconsumed ownership and all system structure when a member is explicitly deleted', () => {
    const f = fixture();
    const p = convert(f);
    const before = f.manager.document;
    f.manager.execute(
      commandFactories.deleteSketchObject({
        sketchId: f.sketchId,
        objectId: p.edgeIds[0]!
      })
    );
    const sketch = findSketch(f.manager.document, f.sketchId)!;
    expect(sketch.promotions).toBeUndefined();
    expect(sketch.constraints).toEqual([]);
    expect(f.manager.document.nodes[p.edgeIds[1]!]).toBeDefined();
    f.manager.undo();
    expect(findSketch(f.manager.document, f.sketchId)).toEqual(
      findSketch(before, f.sketchId)
    );
  });

  it('owns command and replay snapshots independently from the caller', () => {
    const f = fixture();
    const source = structuredClone(rectangle);
    const command = commandFactories.convertLegacySketchObject({
      sketchId: f.sketchId,
      sourceObjectId: f.sourceObjectId,
      expectedSource: source
    });
    if (source.objectKind === 'rectangle') source.width = 100;
    const serialized = command.serialize();
    serialized.payload.ids!.edgeIds[0] = toEntityId('ent_tampered');
    f.manager.execute(command);
    expect(
      findSketch(f.manager.document, f.sketchId)!.promotions![0]!.edgeIds[0]
    ).not.toBe('ent_tampered');
    expect(
      findSketch(f.manager.document, f.sketchId)!.promotions![0]!.sourceData
    ).toEqual(rectangle);
  });

  it.each([
    { ...rectangle, width: 0 },
    { ...rectangle, centerX: 'unknown' },
    { ...polygon, sides: 2 },
    { ...polygon, sides: 4.5 },
    { ...polygon, radius: -1 }
  ])('refuses malformed or unresolved $objectKind without mutation', (data) => {
    const f = fixture(data),
      before = JSON.stringify(f.manager.document);
    expect(() => convert(f)).toThrow();
    expect(JSON.stringify(f.manager.document)).toBe(before);
  });

  it('refuses stale sources and incomplete generated aliases atomically', () => {
    const f = fixture();
    const before = JSON.stringify(f.manager.document);
    const command = commandFactories.convertLegacySketchObject({
      sketchId: f.sketchId,
      sourceObjectId: f.sourceObjectId,
      expectedSource: { ...rectangle, construction: true }
    });
    expect(() => f.manager.execute(command)).toThrow(/changed/);
    const bad = commandFactories.convertLegacySketchObject({
      sketchId: f.sketchId,
      sourceObjectId: f.sourceObjectId
    });
    bad.payload.ids!.edgeIds = [];
    expect(() => f.manager.execute(bad)).toThrow(/incomplete/);
    expect(JSON.stringify(f.manager.document)).toBe(before);
  });

  it('does not silently drop an unsupported saved legacy operand', () => {
    const f = fixture();
    findSketch(f.manager.document, f.sketchId)!.constraints = [
      {
        constraintId: toSketchConstraintId('scon_unsupported'),
        data: { constraintKind: 'horizontal', objectId: f.sourceObjectId }
      }
    ];
    const before = JSON.stringify(f.manager.document);
    expect(() => convert(f)).toThrow(/no supported primitive alias/);
    expect(JSON.stringify(f.manager.document)).toBe(before);
  });
});

describe('boundary topology edit preflight', () => {
  it('refuses direct/replayed and expression-driven side-count changes, while old references keep the legacy path', () => {
    const f = fixture(polygon, true);
    const region = computeSketchProfileAnalysis(
      [{ id: f.sourceObjectId, data: polygon }],
      Number
    ).profiles[0]!;
    const feature = Object.values(f.manager.document.nodes).find(
      (n) => n.kind === 'feature' && n.data.featureKind === 'extrude'
    )!;
    if (
      feature.kind !== 'feature' ||
      feature.data.featureKind !== 'extrude' ||
      !feature.data.profile ||
      feature.data.profile.all
    )
      throw new Error('Missing fixture');
    const beforeLegacy = structuredClone(f.manager.document);
    feature.data.profile.sourceBoundaryLoops = region.sourceBoundaryLoops;
    const command = commandFactories.updateSketchObject({
      sketchId: f.sketchId,
      objectId: f.sourceObjectId,
      data: { ...polygon, sides: 8 }
    });
    const before = JSON.stringify(f.manager.document);
    expect(() => f.manager.execute(command)).toThrow(/topology change/);
    expect(() =>
      replayCommands(f.manager.document, [command.serialize()])
    ).toThrow(/topology change/);
    expect(JSON.stringify(f.manager.document)).toBe(before);
    expect(() =>
      updateSketchObject(beforeLegacy, {
        sketchId: f.sketchId,
        objectId: f.sourceObjectId,
        data: { ...polygon, sides: 8 }
      })
    ).not.toThrow();
    const seeded = setParameter(f.manager.document, {
      name: 'n',
      expression: '6'
    });
    const parameterized = updateSketchObject(seeded, {
      sketchId: f.sketchId,
      objectId: f.sourceObjectId,
      data: { ...polygon, sides: 'n' }
    });
    expect(() =>
      setParameter(parameterized, { name: 'n', expression: '8' })
    ).toThrow(/topology change/);
    expect(() => deleteParameter(parameterized, { name: 'n' })).toThrow(
      /topology change/
    );
    for (const sides of [6.4, 65])
      expect(() =>
        updateSketchObject(f.manager.document, {
          sketchId: f.sketchId,
          objectId: f.sourceObjectId,
          data: { ...polygon, sides }
        })
      ).toThrow(/topology change/);
    expect(() =>
      f.manager.execute(
        commandFactories.updateSketch({
          sketchId: f.sketchId,
          object: { ...polygon, sides: 8 }
        })
      )
    ).toThrow(/topology change/);
  });

  it('refuses a source kind change and deletion when a precise downstream boundary exists', () => {
    const f = fixture(rectangle, true);
    const region = computeSketchProfileAnalysis(
      [{ id: f.sourceObjectId, data: rectangle }],
      Number
    ).profiles[0]!;
    const feature = Object.values(f.manager.document.nodes).find(
      (n) => n.kind === 'feature' && n.data.featureKind === 'extrude'
    )!;
    if (
      feature.kind !== 'feature' ||
      feature.data.featureKind !== 'extrude' ||
      !feature.data.profile ||
      feature.data.profile.all
    )
      throw new Error('Missing fixture');
    feature.data.profile.sourceBoundaryLoops = region.sourceBoundaryLoops;
    expect(() =>
      f.manager.execute(
        commandFactories.updateSketchObject({
          sketchId: f.sketchId,
          objectId: f.sourceObjectId,
          data: polygon
        })
      )
    ).toThrow(/topology change/);
    expect(() =>
      f.manager.execute(
        commandFactories.deleteSketchObject({
          sketchId: f.sketchId,
          objectId: f.sourceObjectId
        })
      )
    ).toThrow(/downstream boundary/);
  });

  it('refuses a partial promotion alias map without returning a partial collection', () => {
    const f = fixture();
    const p = convert(f);
    const objects = new Map(
      findSketch(f.manager.document, f.sketchId)!.objectIds.flatMap((id) => {
        const node = f.manager.document.nodes[id];
        return node?.kind === 'sketch-object' ? [[id, node.data] as const] : [];
      })
    );
    expect(resolveSketchPromotionBoundaryTokens([p], objects).size).toBe(4);
    objects.delete(p.centerSpokeId);
    expect(() => resolveSketchPromotionBoundaryTokens([p], objects)).toThrow(
      /missing/
    );
  });
});
