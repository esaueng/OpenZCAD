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
  resolveParamValue,
  setParameter
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { UNIT_TO_MM, toUserId, type SketchObjectData } from '@openzcad/shared';
import { parseProjectBackup } from '../apps/web/src/lib/projectBackup';

type Rectangle = Extract<SketchObjectData, { objectKind: 'rectangle' }>;

describe.each(['mm', 'cm', 'inch'] as const)(
  'unit-aware legacy conversion in %s documents',
  (units) => {
    const scale = UNIT_TO_MM[units];
    const cases: {
      label: string;
      source: Rectangle;
      expected: {
        centerX: number;
        centerY: number;
        width: number;
        height: number;
      };
    }[] = [
      {
        label: 'suffixed sizes with numeric, negative centers',
        source: {
          objectKind: 'rectangle',
          width: '2 mm',
          height: '4 mm',
          centerX: 5,
          centerY: -2
        },
        expected: {
          centerX: 5,
          centerY: -2,
          width: 2 / scale,
          height: 4 / scale
        }
      },
      {
        label: 'suffixed centers with bare numeric-string sizes',
        source: {
          objectKind: 'rectangle',
          width: '4',
          height: 3,
          centerX: '-10 mm',
          centerY: '5 mm'
        },
        expected: {
          centerX: -10 / scale,
          centerY: 5 / scale,
          width: 4,
          height: 3
        }
      },
      {
        label: 'different explicit length units',
        source: {
          objectKind: 'rectangle',
          width: '2 cm',
          height: '4 mm',
          centerX: '-1 in',
          centerY: '6 mm'
        },
        expected: {
          centerX: -25.4 / scale,
          centerY: 6 / scale,
          width: 20 / scale,
          height: 4 / scale
        }
      },
      {
        label: 'bare arithmetic and fractional centers',
        source: {
          objectKind: 'rectangle',
          width: '2 + 2',
          height: '3',
          centerX: '-5 / 2',
          centerY: 0
        },
        expected: { centerX: -2.5, centerY: 0, width: 4, height: 3 }
      }
    ];

    it.each(cases)('preserves $label', ({ source, expected }) => {
      const added = addSketchFeature(
        createProjectDocument(
          'Unit-aware rectangle',
          toUserId('user_test'),
          units
        ),
        { name: 'Rectangle', plane: 'XY', objects: [source] }
      );
      const sourceId = findSketch(added.document, added.sketchId)!
        .objectIds[0]!;
      const original = structuredClone(added.document.nodes[sourceId]);
      const manager = new CommandManager(added.document);
      manager.execute(
        commandFactories.convertLegacySketchObject({
          sketchId: added.sketchId,
          sourceObjectId: sourceId
        })
      );
      const promotion = findSketch(manager.document, added.sketchId)!
        .promotions![0]!;
      expect(promotion.sourceData).toEqual(source);
      expect(promotion.sourceObjectId).toBe(sourceId);
      const { centerX, centerY, width, height } = expected;
      const corners = [
        [centerX - width / 2, centerY - height / 2],
        [centerX + width / 2, centerY - height / 2],
        [centerX + width / 2, centerY + height / 2],
        [centerX - width / 2, centerY + height / 2]
      ];
      const scope = getParameterScope(manager.document).scope;
      promotion.edgeIds.forEach((id, index) => {
        const edge = manager.document.nodes[id]!;
        if (edge.kind !== 'sketch-object' || edge.data.objectKind !== 'line')
          throw new Error('Missing converted edge');
        const start = corners[index]!;
        const end = corners[(index + 1) % 4]!;
        for (const [raw, oracle] of [
          [edge.data.x1, start[0]!],
          [edge.data.y1, start[1]!],
          [edge.data.x2, end[0]!],
          [edge.data.y2, end[1]!]
        ] as const)
          expect(
            resolveParamValue(raw, scope, 'converted coordinate', units)
          ).toBeCloseTo(oracle, 12);
      });
      const replayed = replayCommands(
        added.document,
        manager.document.commandLog
      );
      expect(findSketch(replayed, added.sketchId)).toEqual(
        findSketch(manager.document, added.sketchId)
      );
      manager.undo();
      expect(manager.document.nodes[sourceId]).toEqual(original);
      manager.redo();
      expect(findSketch(manager.document, added.sketchId)!.promotions).toEqual([
        promotion
      ]);
    });

    it('keeps a typed length parameter live beside numeric-string centers through exact edits, undo, replay and backup', async () => {
      const base = setParameter(
        createProjectDocument(
          'Live converted length',
          toUserId('user_test'),
          units
        ),
        { name: 'span', expression: '20 mm', quantity: 'length' }
      );
      const source: Rectangle = {
        objectKind: 'rectangle',
        width: 'span + 2 mm',
        height: '4 mm',
        centerX: -3,
        centerY: '3 / 2'
      };
      const added = addSketchFeature(base, {
        name: 'Typed rectangle',
        plane: 'XY',
        objects: [source]
      });
      const sourceId = findSketch(added.document, added.sketchId)!
        .objectIds[0]!;
      const pad = extrudeSketch(added.document, {
        name: 'Live pad',
        sketchId: added.sketchId,
        distance: 2
      });
      const manager = new CommandManager(pad.document);
      manager.execute(
        commandFactories.convertLegacySketchObject({
          sketchId: added.sketchId,
          sourceObjectId: sourceId
        })
      );
      const promotion = structuredClone(
        findSketch(manager.document, added.sketchId)!.promotions![0]!
      );
      const adapter = await createExactKernelAdapter();
      try {
        const before = await adapter.syncDocument(manager.document);
        expect(before.warnings).toEqual([]);
        expect(before.bodyRepresentations[pad.bodyId]!.volume).toBeCloseTo(
          (22 * 4 * 2) / scale ** 2,
          8
        );
        manager.execute(
          commandFactories.setParameter({ name: 'span', expression: '30 mm' })
        );
        expect(
          findSketch(manager.document, added.sketchId)!.promotions
        ).toEqual([promotion]);
        const changed = await adapter.syncDocument(manager.document);
        expect(changed.warnings).toEqual([]);
        const representation = changed.bodyRepresentations[pad.bodyId]!;
        expect(representation.volume).toBeCloseTo((32 * 4 * 2) / scale ** 2, 8);
        expect(representation.bbox.min.x).toBeCloseTo(-3 - 16 / scale, 8);
        expect(representation.bbox.max.x).toBeCloseTo(-3 + 16 / scale, 8);
        manager.undo();
        const undone = await adapter.syncDocument(manager.document);
        expect(undone.warnings).toEqual([]);
        expect(undone.bodyRepresentations[pad.bodyId]!.volume).toBeCloseTo(
          (22 * 4 * 2) / scale ** 2,
          8
        );
        manager.redo();
        const replayed = replayCommands(
          pad.document,
          manager.document.commandLog
        );
        const restored = await parseProjectBackup(
          JSON.stringify({
            format: 'openzcad-project',
            version: 1,
            document: replayed,
            files: []
          })
        );
        expect(
          findSketch(restored.document, added.sketchId)!.promotions
        ).toEqual([promotion]);
        expect(promotion.sourceData).toEqual(source);
        const rebuilt = await adapter.syncDocument(restored.document);
        expect(rebuilt.warnings).toEqual([]);
        expect(rebuilt.bodyRepresentations[pad.bodyId]!.volume).toBeCloseTo(
          (32 * 4 * 2) / scale ** 2,
          8
        );
      } finally {
        adapter.dispose();
      }
    });
  }
);
