import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  listFeaturesInOrder,
  normalizeDocument,
  resolveParamValue
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  documentNodesWithHistory,
  resolveSketchReferenceDimension,
  toUserId,
  type ProjectDocument,
  type SketchReferenceDistanceMode,
  type UnitSystem
} from '@openzcad/shared';
import { historyFeatureDigest } from '../packages/kernel-adapter/src/exact-history-cache';

function fixture(units: UnitSystem = 'mm') {
  const f = addSketchFeature(
    createProjectDocument('Projected references', toUserId('user_test'), units),
    {
      name: 'Diagonal',
      plane: 'XY',
      objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: '30 mm', y2: '40 mm' }]
    }
  );
  return { ...f, objectId: findSketch(f.document, f.sketchId)!.objectIds[0]! };
}

describe('S02 projected reference persistence', () => {
  it('keeps both modes along sketch axes when the referenced geometry rotates or reflects', () => {
    const f = fixture();
    const manager = new CommandManager(f.document);
    for (const distanceMode of ['horizontal', 'vertical'] as const)
      manager.execute(
        commandFactories.addSketchReferenceDimension({
          sketchId: f.sketchId,
          data: {
            dimensionKind: 'distance',
            distanceMode,
            a: { objectId: f.objectId, point: 'start' },
            b: { objectId: f.objectId, point: 'end' }
          }
        })
      );
    const references = findSketch(
      manager.document,
      f.sketchId
    )!.referenceDimensions!;
    for (const [x2, y2] of [
      [-40, 30],
      [40, 30],
      [0, 50]
    ]) {
      manager.execute(
        commandFactories.updateSketchObject({
          sketchId: f.sketchId,
          objectId: f.objectId,
          data: { objectKind: 'line', x1: 0, y1: 0, x2: x2!, y2: y2! }
        })
      );
      const node = manager.document.nodes[f.objectId]!;
      if (node.kind !== 'sketch-object') throw new Error('missing line');
      expect(
        findSketch(manager.document, f.sketchId)!.referenceDimensions
      ).toEqual(references);
      const measured = references.map((reference) =>
        resolveSketchReferenceDimension(
          new Map([[f.objectId, node.data]]),
          reference,
          (v) => (typeof v === 'number' ? v : undefined)
        )
      );
      expect(measured).toMatchObject([
        { status: 'current', value: Math.abs(x2!) },
        { status: 'current', value: Math.abs(y2!) }
      ]);
    }
  });

  it.each(['horizontal', 'vertical'] as const)(
    'replays and reopens a %s reference without changing geometry or cache keys',
    (distanceMode) => {
      const f = fixture();
      const manager = new CommandManager(f.document);
      const add = commandFactories.addSketchReferenceDimension({
        sketchId: f.sketchId,
        data: {
          dimensionKind: 'distance',
          distanceMode,
          a: { objectId: f.objectId, point: 'start' },
          b: { objectId: f.objectId, point: 'end' }
        }
      });
      manager.execute(add);
      const reference = findSketch(manager.document, f.sketchId)!
        .referenceDimensions![0]!;
      manager.execute(
        commandFactories.setSketchReferenceLabelPosition({
          sketchId: f.sketchId,
          annotationId: reference.annotationId,
          position: { x: 2, y: -3 }
        })
      );
      const expected = findSketch(manager.document, f.sketchId)!;
      expect(
        findSketch(
          replayCommands(f.document, manager.document.commandLog),
          f.sketchId
        )
      ).toEqual(expected);
      expect(
        findSketch(
          normalizeDocument(
            JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
          ),
          f.sketchId
        )
      ).toEqual(expected);
      expect(manager.document.nodes[f.objectId]).toEqual(
        f.document.nodes[f.objectId]
      );
      expect(expected.constraints).toEqual(
        findSketch(f.document, f.sketchId)!.constraints
      );
      for (const [index, feature] of listFeaturesInOrder(f.document).entries())
        expect(historyFeatureDigest(manager.document, feature, index)).toBe(
          historyFeatureDigest(f.document, feature, index)
        );
      manager.undo();
      manager.undo();
      expect(
        findSketch(manager.document, f.sketchId)!.referenceDimensions
      ).toBeUndefined();
      manager.redo();
      manager.redo();
      expect(findSketch(manager.document, f.sketchId)).toEqual(expected);
    }
  );

  it.each(['mm', 'cm', 'inch'] as const)(
    'measures projected expression coordinates in %s',
    (units) => {
      const f = fixture(units);
      const data = f.document.nodes[f.objectId]!;
      if (data.kind !== 'sketch-object') throw new Error('missing line');
      for (const [distanceMode, mm] of [
        ['horizontal', 30],
        ['vertical', 40]
      ] as const) {
        expect(
          resolveSketchReferenceDimension(
            new Map([[f.objectId, data.data]]),
            {
              annotationId: 'sref_units' as never,
              data: {
                dimensionKind: 'distance',
                distanceMode,
                a: { objectId: f.objectId, point: 'start' },
                b: { objectId: f.objectId, point: 'end' }
              }
            },
            (value) => resolveParamValue(value, {}, undefined, units)
          )
        ).toMatchObject({
          status: 'current',
          value: mm / (units === 'inch' ? 25.4 : units === 'cm' ? 10 : 1)
        });
      }
    }
  );

  it('migrates every earlier schema without inventing modes or rewriting absolute references', () => {
    const f = fixture();
    const add = commandFactories.addSketchReferenceDimension({
      sketchId: f.sketchId,
      data: {
        dimensionKind: 'distance',
        a: { objectId: f.objectId, point: 'start' },
        b: { objectId: f.objectId, point: 'end' }
      }
    });
    const absolute = add.apply(f.document);
    for (
      let version = 1;
      version < PROJECT_DOCUMENT_SCHEMA_VERSION;
      version++
    ) {
      const saved = JSON.parse(JSON.stringify(absolute)) as ProjectDocument;
      saved.schemaVersion = version as typeof PROJECT_DOCUMENT_SCHEMA_VERSION;
      const loaded = normalizeDocument(saved);
      expect(loaded).toEqual({
        ...absolute,
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION
      });
      expect(
        findSketch(loaded, f.sketchId)!.referenceDimensions![0]!.data
      ).not.toHaveProperty('distanceMode');
    }
  });

  it('refuses unknown modes in current, undo and redo nodes', () => {
    for (const location of ['current', 'undo', 'redo'] as const) {
      const f = fixture();
      const manager = new CommandManager(f.document);
      const add = commandFactories.addSketchReferenceDimension({
        sketchId: f.sketchId,
        data: {
          dimensionKind: 'distance',
          distanceMode: 'horizontal',
          a: { objectId: f.objectId, point: 'start' },
          b: { objectId: f.objectId, point: 'end' }
        }
      });
      manager.execute(add);
      if (location === 'undo')
        manager.execute(
          commandFactories.deleteSketchReferenceDimension({
            sketchId: f.sketchId,
            annotationId: add.payload.ids!.annotationId
          })
        );
      if (location === 'redo') manager.undo();
      const saved = JSON.parse(
        JSON.stringify(manager.document)
      ) as ProjectDocument;
      for (const node of documentNodesWithHistory(saved))
        if (node?.kind === 'sketch')
          for (const reference of node.referenceDimensions ?? [])
            if (reference.data.dimensionKind === 'distance')
              reference.data.distanceMode =
                'diagonal' as SketchReferenceDistanceMode;
      expect(() => normalizeDocument(saved)).toThrow(/Reference dimensions/);
    }
  });
});
