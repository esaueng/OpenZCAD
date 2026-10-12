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
  getParameterScope,
  listFeaturesInOrder,
  normalizeDocument,
  resolveParamValue,
  setParameter
} from '@openzcad/document-core';
import {
  resolveSketchReferenceDimension,
  documentNodesWithHistory,
  sketchConstraintsForSolve,
  toSketchReferenceAnnotationId,
  toUserId,
  type ProjectDocument,
  type SketchReferenceDimensionData,
  type UnitSystem
} from '@openzcad/shared';
import { historyFeatureDigest } from '../packages/kernel-adapter/src/exact-history-cache';

function fixture(units: UnitSystem = 'mm') {
  const root = setParameter(
    {
      ...createProjectDocument('Reference dimensions', toUserId('user_test')),
      units
    },
    { name: 'length', expression: '25.4 mm' }
  );
  const added = addSketchFeature(root, {
    name: 'Sketch',
    plane: 'XY',
    objects: [
      { objectKind: 'line', x1: 0, y1: 0, x2: 'length', y2: 0 },
      { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 10 },
      { objectKind: 'circle', centerX: 20, centerY: 20, radius: 4 }
    ]
  });
  const ids = findSketch(added.document, added.sketchId)!.objectIds;
  return {
    ...added,
    document: extrudeSketch(added.document, {
      name: 'Extrude',
      sketchId: added.sketchId,
      distance: 5
    }).document,
    ids
  };
}

describe('S02 reference dimension commands', () => {
  it('validates annotations retained only by undo/redo history', () => {
    const f = fixture();
    const manager = new CommandManager(f.document);
    const command = commandFactories.addSketchReferenceDimension({
      sketchId: f.sketchId,
      data: { dimensionKind: 'radius', objectId: f.ids[2]! }
    });
    manager.execute(command);
    manager.execute(
      commandFactories.deleteSketchReferenceDimension({
        sketchId: f.sketchId,
        annotationId: command.payload.ids!.annotationId
      })
    );
    const persisted = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    for (const node of documentNodesWithHistory(persisted)) {
      if (node.kind === 'sketch' && node.referenceDimensions?.length) {
        Object.assign(node.referenceDimensions[0]!.data, { value: 99 });
        break;
      }
    }
    expect(() => normalizeDocument(persisted)).toThrow(
      /without driving values/
    );
  });
  it.each(['distance', 'radius', 'angle'] as const)(
    'adds, moves and deletes a %s reference with stable replay/undo/reopen identity',
    (kind) => {
      const { document, sketchId, ids } = fixture();
      const data: SketchReferenceDimensionData =
        kind === 'distance'
          ? {
              dimensionKind: kind,
              a: { objectId: ids[0]!, point: 'start' },
              b: { objectId: ids[0]!, point: 'end' }
            }
          : kind === 'angle'
            ? { dimensionKind: kind, a: ids[0]!, b: ids[1]! }
            : { dimensionKind: kind, objectId: ids[2]! };
      const manager = new CommandManager(document);
      const add = commandFactories.addSketchReferenceDimension({
        sketchId,
        data
      });
      manager.execute(add);
      const reference = findSketch(manager.document, sketchId)!
        .referenceDimensions![0]!;
      expect(reference.annotationId).toBe(add.payload.ids!.annotationId);
      expect(Object.keys(reference.data)).not.toContain('value');
      const before = findSketch(document, sketchId)!;
      expect(
        sketchConstraintsForSolve(findSketch(manager.document, sketchId)!)
      ).toEqual(sketchConstraintsForSolve(before));
      manager.execute(
        commandFactories.setSketchReferenceLabelPosition({
          sketchId,
          annotationId: reference.annotationId,
          position: { x: 3, y: -2 }
        })
      );
      const moved = findSketch(manager.document, sketchId)!;
      expect(moved.dimensionLabelPositions?.[reference.annotationId]).toEqual({
        x: 3,
        y: -2
      });
      const reopened = normalizeDocument(
        JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
      );
      expect(findSketch(reopened, sketchId)).toEqual(moved);
      const replayed = replayCommands(document, manager.document.commandLog);
      expect(findSketch(replayed, sketchId)).toEqual(moved);
      // Both direct sketch and downstream feature digests exclude annotations/placement.
      for (const [index, feature] of listFeaturesInOrder(document).entries())
        expect(historyFeatureDigest(manager.document, feature, index)).toBe(
          historyFeatureDigest(document, feature, index)
        );
      for (const id of ids)
        expect(manager.document.nodes[id]).toEqual(document.nodes[id]);
      manager.execute(
        commandFactories.deleteSketchReferenceDimension({
          sketchId,
          annotationId: reference.annotationId
        })
      );
      expect(
        findSketch(manager.document, sketchId)!.referenceDimensions
      ).toEqual([]);
      manager.undo();
      expect(findSketch(manager.document, sketchId)).toEqual(moved);
      manager.redo();
      expect(
        findSketch(manager.document, sketchId)!.referenceDimensions
      ).toEqual([]);
      manager.undo();
      manager.undo();
      manager.undo();
      expect(findSketch(manager.document, sketchId)).toEqual(before);
      manager.redo();
      expect(
        findSketch(manager.document, sketchId)!.referenceDimensions![0]
      ).toEqual(reference);
    }
  );

  it('refuses referenced geometry deletion atomically until its annotation is explicitly removed', () => {
    const { document, sketchId, ids } = fixture();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addSketchReferenceDimension({
        sketchId,
        data: { dimensionKind: 'radius', objectId: ids[2]! }
      })
    );
    const baseline = manager.document;
    const annotationId = findSketch(baseline, sketchId)!
      .referenceDimensions![0]!.annotationId;
    expect(() =>
      manager.execute(
        commandFactories.deleteSketchObject({ sketchId, objectId: ids[2]! })
      )
    ).toThrow(/Delete the reference dimensions first: radius/);
    expect(manager.document).toBe(baseline);
    manager.execute(
      commandFactories.deleteSketchReferenceDimension({
        sketchId,
        annotationId
      })
    );
    manager.execute(
      commandFactories.deleteSketchObject({ sketchId, objectId: ids[2]! })
    );
    expect(manager.document.nodes[ids[2]!]).toBeUndefined();
    manager.undo();
    manager.undo();
    expect(
      findSketch(manager.document, sketchId)!.referenceDimensions![0]!
        .annotationId
    ).toBe(annotationId);
    expect(manager.document.nodes[ids[2]!]).toEqual(document.nodes[ids[2]!]);
  });

  it('rejects stale/illegal/duplicate targets, driving payloads and invalid placements without history', () => {
    const { document, sketchId, ids } = fixture();
    const manager = new CommandManager(document);
    for (const data of [
      { dimensionKind: 'radius', objectId: ids[0] },
      { dimensionKind: 'radius', objectId: 'ent_missing' },
      {
        dimensionKind: 'distance',
        a: { objectId: ids[0], point: 'center' },
        b: { objectId: ids[0], point: 'end' }
      },
      { dimensionKind: 'angle', a: ids[0], b: ids[0] },
      { dimensionKind: 'radius', objectId: ids[2], value: 8 }
    ])
      expect(() =>
        manager.execute(
          commandFactories.addSketchReferenceDimension({
            sketchId,
            data: data as SketchReferenceDimensionData
          })
        )
      ).toThrow();
    expect(manager.document).toBe(document);
    const command = commandFactories.addSketchReferenceDimension({
      sketchId,
      data: { dimensionKind: 'radius', objectId: ids[2]! }
    });
    manager.execute(command);
    expect(() => manager.execute(command)).toThrow(/unique/);
    const baseline = manager.document;
    for (const position of [
      { x: NaN, y: 0 },
      { x: 1e9, y: 0 }
    ])
      expect(() =>
        manager.execute(
          commandFactories.setSketchReferenceLabelPosition({
            sketchId,
            annotationId: command.payload.ids!.annotationId,
            position
          })
        )
      ).toThrow(/position/);
    expect(() =>
      manager.execute(
        commandFactories.setSketchReferenceLabelPosition({
          sketchId,
          annotationId: toSketchReferenceAnnotationId('sref_missing'),
          position: { x: 1, y: 2 }
        })
      )
    ).toThrow(/not found/);
    expect(manager.document).toBe(baseline);
    manager.undo();
    expect(
      findSketch(manager.document, sketchId)!.referenceDimensions
    ).toBeUndefined();
  });

  it.each([
    ['mm', 25.4],
    ['cm', 2.54],
    ['inch', 1]
  ] as const)(
    'recomputes measured geometry in %s without storing a number',
    (units, expected) => {
      const { document, sketchId, ids } = fixture(units);
      const manager = new CommandManager(document);
      manager.execute(
        commandFactories.addSketchReferenceDimension({
          sketchId,
          data: {
            dimensionKind: 'distance',
            a: { objectId: ids[0]!, point: 'start' },
            b: { objectId: ids[0]!, point: 'end' }
          }
        })
      );
      const reference = findSketch(manager.document, sketchId)!
        .referenceDimensions![0]!;
      const byId = new Map(
        ids.map((id) => [
          id,
          document.nodes[id]!.kind === 'sketch-object'
            ? document.nodes[id]!.data
            : { objectKind: 'line' as const, x1: 0, y1: 0, x2: 0, y2: 0 }
        ])
      );
      expect(
        resolveSketchReferenceDimension(byId, reference, (value) =>
          resolveParamValue(
            value,
            getParameterScope(manager.document).scope,
            undefined,
            units
          )
        )
      ).toMatchObject({ status: 'current', value: expected });
      manager.execute(
        commandFactories.setParameter({ name: 'length', expression: '50.8 mm' })
      );
      expect(
        resolveSketchReferenceDimension(byId, reference, (value) =>
          resolveParamValue(
            value,
            getParameterScope(manager.document).scope,
            undefined,
            units
          )
        )
      ).toMatchObject({ status: 'current', value: expected * 2 });
      expect(
        findSketch(manager.document, sketchId)!.referenceDimensions![0]
      ).toEqual(reference);
      expect(manager.document.nodes[ids[0]!]).toEqual(document.nodes[ids[0]!]);
    }
  );

  it('normalizes structurally valid unresolved targets but refuses malformed annotations', () => {
    const { document, sketchId } = fixture();
    const sketch = findSketch(document, sketchId)!;
    sketch.referenceDimensions = [
      {
        annotationId: toSketchReferenceAnnotationId('sref_unresolved'),
        data: { dimensionKind: 'radius', objectId: 'ent_gone' as never }
      }
    ];
    expect(
      findSketch(
        normalizeDocument(
          JSON.parse(JSON.stringify(document)) as ProjectDocument
        ),
        sketchId
      )!.referenceDimensions
    ).toEqual(sketch.referenceDimensions);
    const malformed = JSON.parse(JSON.stringify(document)) as ProjectDocument;
    Object.assign(
      findSketch(malformed, sketchId)!.referenceDimensions![0]!.data,
      { value: 5 }
    );
    expect(() => normalizeDocument(malformed)).toThrow(
      /without driving values/
    );
  });
});
