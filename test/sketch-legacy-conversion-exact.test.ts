import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  getParameterScope,
  resolveParamValue,
  revolveSketch,
  setParameter
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import { faceSketchAttachment } from '../apps/web/src/lib/faceSketchAttachment';
import { parseProjectBackup } from '../apps/web/src/lib/projectBackup';
import { resolveRegionProfiles } from '../packages/kernel-adapter/src/region-profile';

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);
afterAll(() => adapter.dispose());

function fixture(
  data: SketchObjectData,
  consumer:
    'selected-extrude' | 'default-extrude' | 'revolve' = 'selected-extrude',
  angleDeg?: number
) {
  const base = setParameter(
    createProjectDocument('Legacy conversion exact', toUserId('user_test')),
    { name: 'width', expression: '20' }
  );
  const added = addSketchFeature(base, {
    name: 'Legacy source',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [
      data,
      ...(consumer === 'selected-extrude'
        ? []
        : [
            {
              objectKind: 'rectangle' as const,
              width: 100,
              height: 100,
              centerX: 0,
              centerY: 0
            }
          ])
    ]
  });
  const sourceId = findSketch(added.document, added.sketchId)!.objectIds[0]!;
  const { scope } = getParameterScope(added.document);
  const regions = computeSketchRegions([{ id: sourceId, data }], (value) =>
    resolveParamValue(value, scope, 'test', added.document.units)
  );
  expect(regions).toHaveLength(1);
  const source = regions[0]!;
  // An old saved selected-region reference carries no provenance yet. The
  // explicit conversion must upgrade it before replacing its source object.
  const reference = {
    profileId: source.profileId,
    regionFingerprint: source.regionFingerprint,
    sourceArea: source.area,
    samplePoint: source.samplePoint,
    sourceEntityIds: [...source.sourceEntityIds]
  };
  const extruded =
    consumer === 'revolve'
      ? revolveSketch(added.document, {
          name: 'Turned plate',
          sketchId: added.sketchId,
          axis: 'vertical',
          angleDeg
        })
      : extrudeSketch(added.document, {
          name: 'Plate',
          sketchId: added.sketchId,
          distance: 5,
          operation: 'new-body',
          ...(consumer === 'selected-extrude' ? { profile: reference } : {})
        });
  return {
    initial: extruded.document,
    manager: new CommandManager(extruded.document),
    sketchId: added.sketchId,
    sourceId,
    bodyId: extruded.bodyId,
    source,
    reference
  };
}

type LegacyShape = Extract<
  SketchObjectData,
  { objectKind: 'rectangle' | 'polygon' }
>;

const rectangle: LegacyShape = {
  objectKind: 'rectangle',
  width: 'width',
  height: 12,
  centerX: 'width / 2',
  centerY: 6
};

function convert(f: ReturnType<typeof fixture>) {
  f.manager.execute(
    commandFactories.convertLegacySketchObject({
      sketchId: f.sketchId,
      sourceObjectId: f.sourceId
    })
  );
  return findSketch(f.manager.document, f.sketchId)!;
}

function faceNames(document: ProjectDocument['derived'], bodyId: BodyId) {
  return document.bodyRepresentations[bodyId]!.topology!.faces.map(
    (face) => face.reference?.lineageName
  ).sort();
}

describe(
  'legacy editable conversion on the exact kernel',
  { timeout: 120_000 },
  () => {
    const cases: [string, LegacyShape][] = [
      ['rectangle', rectangle],
      ...[3, 4, 6, 64].map(
        (sides) =>
          [
            `polygon ${sides}`,
            { objectKind: 'polygon', sides, radius: 10, centerX: 0, centerY: 0 }
          ] as [string, LegacyShape]
      )
    ];
    it.each(cases)(
      'converts %s into an independent, converged structural graph',
      async (_name, data) => {
        const f = fixture(data);
        const sketch = convert(f);
        const solved = await adapter.solveSketch(
          f.manager.document,
          f.sketchId
        );
        expect(solved.converged).toBe(true);
        expect(solved.rolledBack).toBe(false);
        expect(solved.classification).toBe('underConstrained');
        expect(solved.dof.rank).toBe(solved.dof.numEquations);
        expect(solved.maxResidual).toBeLessThan(1e-8);
        expect(sketch.promotions).toHaveLength(1);
        expect(f.manager.document.nodes[f.sourceId]).toBeUndefined();
        const built = await adapter.syncDocument(f.manager.document);
        expect(built.warnings).toEqual([]);
        const area =
          data.objectKind === 'rectangle'
            ? 240
            : Number(data.sides) *
              50 *
              Math.sin((2 * Math.PI) / Number(data.sides));
        expect(built.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
          area * 5,
          6
        );
      }
    );

    it('refuses changed authored topology before matching saved IDs, fingerprints or geometric witnesses', () => {
      const f = fixture(rectangle);
      const sketch = findSketch(f.initial, f.sketchId)!;
      const loops = f.source.sourceBoundaryLoops!;
      for (const sourceBoundaryLoops of [
        { ...loops, outer: loops.outer.slice(1) },
        {
          ...loops,
          outer: loops.outer.map((value) =>
            value.replace(f.sourceId, 'replacement_source')
          )
        },
        { outer: loops.outer.slice(0, -1), holes: [[loops.outer.at(-1)!]] }
      ]) {
        expect(() =>
          resolveRegionProfiles(
            f.initial,
            sketch,
            { profile: { ...f.reference, sourceBoundaryLoops } },
            { width: 20 }
          )
        ).toThrow(/authored boundary topology no longer matches/);
      }
      expect(
        resolveRegionProfiles(
          f.initial,
          sketch,
          { profile: f.reference },
          { width: 20 }
        )
      ).toHaveLength(1);
    });

    it.each(['default-extrude', 'revolve'] as const)(
      'builds %s from current edges after parameter rename and released deformation while preserving whole-object face/edge names',
      async (consumer) => {
        const f = fixture(rectangle, consumer);
        const expectedVolume = (width: number) =>
          consumer === 'revolve'
            ? Math.PI * width * width * 12
            : width * 12 * 5;
        const before = await adapter.syncDocument(f.initial);
        expect(before.warnings).toEqual([]);
        expect(before.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
          expectedVolume(20),
          6
        );
        const names = faceNames(before, f.bodyId);
        const edgeNames = before.bodyRepresentations[
          f.bodyId
        ]!.topology!.edges.map((edge) => edge.reference?.lineageName).sort();
        const promotion = convert(f).promotions![0]!;
        const converted = await adapter.syncDocument(f.manager.document);
        expect(converted.warnings).toEqual([]);
        expect(converted.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
          expectedVolume(20),
          6
        );
        expect(faceNames(converted, f.bodyId)).toEqual(names);
        expect(
          converted.bodyRepresentations[f.bodyId]!.topology!.edges.map(
            (edge) => edge.reference?.lineageName
          ).sort()
        ).toEqual(edgeNames);
        f.manager.execute(
          commandFactories.renameParameter({ name: 'width', newName: 'span' })
        );
        f.manager.execute(
          commandFactories.setParameter({ name: 'span', expression: '30' })
        );
        expect(
          findSketch(f.manager.document, f.sketchId)!.promotions![0]!.sourceData
        ).toEqual(rectangle);
        const renamed = await adapter.syncDocument(f.manager.document);
        expect(renamed.warnings).toEqual([]);
        expect(renamed.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
          expectedVolume(30),
          6
        );
        expect(faceNames(renamed, f.bodyId)).toEqual(names);
        f.manager.execute(
          commandFactories.releaseSketchPromotionStructure({
            sketchId: f.sketchId,
            promotionId: promotion.promotionId
          })
        );
        const corners = [
          { x: 0, y: 0 },
          { x: 40, y: 0 },
          { x: 40, y: 12 },
          { x: 0, y: 12 }
        ];
        f.manager.execute(
          composeCommands(
            'Reshape released edges',
            promotion.edgeIds.map((objectId, i) =>
              commandFactories.updateSketchObject({
                sketchId: f.sketchId,
                objectId,
                data: {
                  objectKind: 'line',
                  x1: corners[i]!.x,
                  y1: corners[i]!.y,
                  x2: corners[(i + 1) % 4]!.x,
                  y2: corners[(i + 1) % 4]!.y
                }
              })
            )
          )
        );
        const deformed = await adapter.syncDocument(f.manager.document);
        expect(deformed.warnings).toEqual([]);
        expect(deformed.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
          expectedVolume(40),
          6
        );
        expect(faceNames(deformed, f.bodyId)).toEqual(names);
      }
    );

    it.each([3, 6, 64])(
      'retains the default meaning and whole-object lineage for a converted %i-sided polygon',
      async (sides) => {
        const f = fixture(
          { objectKind: 'polygon', sides, radius: 10, centerX: 20, centerY: 0 },
          'default-extrude'
        );
        const expectedVolume = sides * 50 * Math.sin((2 * Math.PI) / sides) * 5;
        const before = await adapter.syncDocument(f.initial);
        expect(before.warnings).toEqual([]);
        expect(before.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
          expectedVolume,
          6
        );
        const faces = faceNames(before, f.bodyId);
        const edgeNames = before.bodyRepresentations[
          f.bodyId
        ]!.topology!.edges.map((edge) => edge.reference?.lineageName).sort();
        convert(f);
        const after = await adapter.syncDocument(f.manager.document);
        expect(after.warnings).toEqual([]);
        expect(after.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
          expectedVolume,
          6
        );
        expect(faceNames(after, f.bodyId)).toEqual(faces);
        expect(
          after.bodyRepresentations[f.bodyId]!.topology!.edges.map(
            (edge) => edge.reference?.lineageName
          ).sort()
        ).toEqual(edgeNames);
      }
    );

    it('keeps a default consumer independent of an unrelated repairable promotion', async () => {
      const f = fixture(
        {
          objectKind: 'rectangle',
          width: 20,
          height: 12,
          centerX: 10,
          centerY: 6
        },
        'default-extrude'
      );
      convert(f);
      const added = commandFactories.addSketchObjects({
        sketchId: f.sketchId,
        objects: [
          {
            objectKind: 'rectangle',
            width: 5,
            height: 4,
            centerX: 100,
            centerY: 100
          }
        ]
      });
      f.manager.execute(added);
      const sourceObjectId = findSketch(
        f.manager.document,
        f.sketchId
      )!.objectIds.at(-1)!;
      f.manager.execute(
        commandFactories.convertLegacySketchObject({
          sketchId: f.sketchId,
          sourceObjectId
        })
      );
      const saved = structuredClone(f.manager.document);
      const unrelated = findSketch(saved, f.sketchId)!.promotions![1]!;
      delete saved.nodes[unrelated.edgeIds[0]!];
      const result = await adapter.syncDocument(saved);
      expect(result.warnings).toEqual([]);
      expect(result.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(1200, 8);
    });

    it('retains a partial revolve’s analytic volume and deliberate hash-only references after conversion', async () => {
      const f = fixture(
        {
          objectKind: 'rectangle',
          width: 1,
          height: 1,
          centerX: 2.5,
          centerY: 0.5
        },
        'revolve',
        90
      );
      const before = await adapter.syncDocument(f.initial);
      expect(before.warnings).toEqual([]);
      expect(before.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
        (5 * Math.PI) / 4,
        6
      );
      convert(f);
      const after = await adapter.syncDocument(f.manager.document);
      expect(after.warnings).toEqual([]);
      expect(after.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
        (5 * Math.PI) / 4,
        6
      );
      expect(
        after.bodyRepresentations[f.bodyId]!.topology!.faces.every(
          (face) => face.reference === undefined
        )
      ).toBe(true);
      expect(
        after.bodyRepresentations[f.bodyId]!.topology!.edges.every(
          (edge) => edge.reference === undefined
        )
      ).toBe(true);
    });

    it.each(['selected-extrude', 'default-extrude'] as const)(
      'retains %s side/cap names and a face attachment through conversion, resize, undo and replay',
      async (consumer) => {
        const f = fixture(rectangle, consumer);
        const before = await adapter.syncDocument(f.initial);
        expect(before.warnings).toEqual([]);
        expect(before.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
          1200,
          8
        );
        const names = faceNames(before, f.bodyId);
        expect(names).toHaveLength(6);
        const front = before.bodyRepresentations[
          f.bodyId
        ]!.topology!.faces.find(
          (face) => (face.geometry?.normal?.y ?? 0) < -0.99
        )!;
        expect(front.reference?.kind).toBe('face');
        const attachment = faceSketchAttachment({
          bodyId: f.bodyId,
          pickedHash: front.hash,
          face: front
        });
        expect(attachment.ok).toBe(true);
        if (!attachment.ok) throw new Error(attachment.reason);
        expect(attachment.attachment).toBe('associative');
        expect(attachment.planeRef.type).toBe('face');
        const attached = addSketchFeature(
          { ...f.initial, derived: before },
          {
            name: 'Attached front boss',
            planeRef: attachment.planeRef,
            objects: [
              {
                objectKind: 'rectangle',
                width: 4,
                height: 2,
                centerX: 0,
                centerY: 0
              }
            ]
          }
        );
        const bossed = extrudeSketch(attached.document, {
          name: 'Boss',
          sketchId: attached.sketchId,
          distance: 2,
          operation: 'new-body'
        });
        f.initial = bossed.document;
        f.manager = new CommandManager(f.initial);
        const sketch = convert(f);
        const promotion = sketch.promotions![0]!;
        const feature = Object.values(f.manager.document.nodes).find(
          (node) =>
            node.kind === 'feature' &&
            node.data.featureKind === 'extrude' &&
            node.data.sketchId === f.sketchId
        );
        if (
          feature?.kind !== 'feature' ||
          feature.data.featureKind !== 'extrude'
        )
          throw new Error('Missing extrusion.');
        if (consumer === 'selected-extrude')
          expect(feature.data.profile).toMatchObject({
            sourceBoundaryLoops: f.source.sourceBoundaryLoops
          });
        else expect(feature.data.profile).toBeUndefined();
        const selected = resolveRegionProfiles(
          f.manager.document,
          sketch,
          {
            profile: feature.data.profile ?? {
              ...f.reference,
              sourceBoundaryLoops: f.source.sourceBoundaryLoops
            }
          },
          { width: 20 }
        );
        expect(selected).toHaveLength(1);
        expect(selected[0]!.sourceEntityIds).toEqual(
          [...promotion.edgeIds].sort()
        );
        expect(selected[0]!.sourceBoundaryLoops).toEqual(
          f.source.sourceBoundaryLoops
        );
        const converted = await adapter.syncDocument(f.manager.document);
        expect(converted.warnings).toEqual([]);
        expect(faceNames(converted, f.bodyId)).toEqual(names);
        expect(
          converted.bodyRepresentations[bossed.bodyId]!.volume
        ).toBeCloseTo(16, 8);
        const convertedBoss = converted.bodyRepresentations[bossed.bodyId]!;
        expect(
          (convertedBoss.bbox.min.x + convertedBoss.bbox.max.x) / 2
        ).toBeCloseTo(10, 8);
        f.manager.execute(
          commandFactories.setParameter({ name: 'width', expression: '30' })
        );
        const resized = await adapter.syncDocument(f.manager.document);
        expect(resized.warnings).toEqual([]);
        expect(resized.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
          1800,
          8
        );
        expect(faceNames(resized, f.bodyId)).toEqual(names);
        expect(resized.bodyRepresentations[bossed.bodyId]!.volume).toBeCloseTo(
          16,
          8
        );
        const resizedBoss = resized.bodyRepresentations[bossed.bodyId]!;
        expect(
          (resizedBoss.bbox.min.x + resizedBoss.bbox.max.x) / 2
        ).toBeCloseTo(15, 8);
        f.manager.undo();
        f.manager.undo();
        expect(f.manager.document.nodes[f.sourceId]).toBeDefined();
        expect(
          findSketch(f.manager.document, f.sketchId)!.promotions
        ).toBeUndefined();
        expect(
          (await adapter.syncDocument(f.manager.document)).bodyRepresentations[
            f.bodyId
          ]!.volume
        ).toBeCloseTo(1200, 8);
        f.manager.redo();
        f.manager.redo();
        const replayed = replayCommands(
          f.initial,
          f.manager.document.commandLog
        );
        const reopened = (
          await parseProjectBackup(
            JSON.stringify({
              format: 'openzcad-project',
              version: 1,
              document: replayed,
              files: [],
              sources: [],
              saveStates: []
            })
          )
        ).document;
        expect(findSketch(reopened, f.sketchId)!.promotions).toEqual([
          promotion
        ]);
        const rebuilt = await adapter.syncDocument(reopened);
        expect(rebuilt.warnings).toEqual([]);
        expect(rebuilt.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
          1800,
          8
        );
        expect(faceNames(rebuilt, f.bodyId)).toEqual(names);
        expect(rebuilt.bodyRepresentations[bossed.bodyId]!.volume).toBeCloseTo(
          16,
          8
        );
      }
    );
  }
);
