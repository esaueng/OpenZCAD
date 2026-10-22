import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, replayCommands } from '@openzcad/command-system';
import {
  addDatumAxis,
  addDatumPlane,
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  deleteFeature,
  extrudeSketch,
  findFeature,
  listFeaturesInOrder,
  patternBody,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DatumPlaneDefinition,
  type EdgeVertexPointSource,
  type FacePlaneSource,
  type FeatureId,
  type ProjectDocument,
  type TopologySelection,
  type Vector3
} from '@openzcad/shared';
import {
  datumVertexFromEdgePick,
  edgeEnds
} from '../apps/web/src/lib/datumPlanes';
import {
  beginDatumVertexRepair,
  datumVertexRepairEdit,
  datumVertexRepairSlots,
  datumVertexSourceFailed,
  stageDatumVertexRepairPick
} from '../apps/web/src/lib/datumVertexRepair';
import { parseProjectBackup } from '../apps/web/src/lib/projectBackup';
import { affectedFeatureTargets } from '../apps/web/src/lib/affectedFeatureTargets';
import {
  validatedFeatureRejection,
  FeatureBuildError
} from '../apps/web/src/lib/featureValidation';
import { faceSketchAttachment } from '../apps/web/src/lib/faceSketchAttachment';

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);
afterAll(() => adapter.dispose());
const v = (x: number, y: number, z: number): Vector3 => ({ x, y, z });
const at = (x: number | string, y: number | string, z: number | string) => ({
  type: 'point' as const,
  point: { x, y, z }
});
const xy = { type: 'canonical' as const, plane: 'XY' as const, offset: 3 };
const oldCorners = [v(0, 0, 10), v(10, 0, 10), v(0, 10, 10)];
const newCorners = [v(30, 0, 17), v(50, 0, 17), v(30, 20, 17)];

async function synced(document: ProjectDocument) {
  // Repair starts from the current session's exact warnings. Canonical
  // persistence deliberately strips those disposable diagnostics.
  return { ...document, derived: await adapter.syncDocument(document) };
}

function box(
  document: ProjectDocument,
  name: string,
  width: number,
  height: number,
  depth: number,
  translation?: Vector3
) {
  let next = addPrimitiveFeature(document, {
    name,
    primitiveKind: 'box',
    dimensions: { width, height, depth }
  });
  const bodyId = next.bodyOrder.at(-1)!;
  const featureId = listFeaturesInOrder(next).at(-1)!.featureId;
  if (translation)
    next = transformBody(next, {
      name: `Place ${name}`,
      targetBodyId: bodyId,
      translation
    }).document;
  return { document: next, bodyId, featureId };
}

async function sources() {
  const first = box(
    createProjectDocument('Vertex repair exact', toUserId('user_test')),
    'Lost block',
    10,
    10,
    10
  );
  const second = box(
    first.document,
    'Replacement block',
    20,
    20,
    12,
    v(30, 0, 5)
  );
  const third = box(second.document, 'Collinear choice', 1, 1, 1, v(40, 0, 17));
  return { document: await synced(third.document), first, second, third };
}

function pick(
  document: ProjectDocument,
  bodyId: BodyId,
  point: Vector3,
  other?: Vector3
): {
  selection: TopologySelection;
  point: Vector3;
  source: EdgeVertexPointSource;
} {
  const same = (a: Vector3, b: Vector3) =>
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-9;
  const edge = document.derived.bodyRepresentations[
    bodyId
  ]!.topology!.edges.find((candidate) => {
    const ends = candidate.reference
      ? edgeEnds(candidate.reference.witness)
      : null;
    return (
      ends?.some((end) => same(end, point)) &&
      (!other || ends.some((end) => same(end, other)))
    );
  });
  expect(edge?.reference).toBeDefined();
  const selection: TopologySelection = {
    kind: 'edge',
    bodyId,
    topologyId: edge!.topologyId,
    hash: edge!.hash
  };
  const source = datumVertexFromEdgePick(document, selection, point);
  if ('reason' in source) throw new Error(source.reason);
  return { selection, point, source };
}

function staged(
  document: ProjectDocument,
  featureId: FeatureId,
  slots: (0 | 1 | 2)[],
  picks: ReturnType<typeof pick>[]
) {
  expect(
    datumVertexSourceFailed(
      findFeature(document, featureId)!,
      document.derived.featureWarnings ?? []
    ),
    JSON.stringify(document.derived.featureWarnings)
  ).toBe(true);
  let session = beginDatumVertexRepair(document, featureId, slots);
  for (const choice of picks)
    session = stageDatumVertexRepairPick(
      document,
      session,
      choice.selection,
      choice.point
    );
  expect(session.pendingSlot).toBeNull();
  return datumVertexRepairEdit(document, session);
}

/** The UI preflights a candidate; only a resolved candidate becomes history. */
async function commit(
  manager: CommandManager,
  edit: ReturnType<typeof datumVertexRepairEdit>
) {
  edit.command.validate(manager.document);
  const candidate = edit.command.apply(manager.document);
  const derived = await adapter.syncDocument(candidate);
  edit.validateDerived(derived);
  for (const target of affectedFeatureTargets(
    manager.document,
    edit.command.payload.featureId
  )) {
    const refusal = validatedFeatureRejection({
      ...target,
      warnings: derived.warnings,
      featureWarnings: derived.featureWarnings,
      bodyPresent: Boolean(derived.bodyRepresentations[target.resultBodyId]),
      documentMoved: false
    });
    if (refusal)
      throw new FeatureBuildError(
        `${target.featureName}: ${refusal.message}`,
        target.featureId,
        target.featureName
      );
  }
  expect(derived.warnings).toEqual([]);
  manager.execute(edit.command);
  return derived;
}

async function reopen(document: ProjectDocument) {
  return (
    await parseProjectBackup(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: [],
        sources: [],
        saveStates: []
      })
    )
  ).document;
}

function expectPad(
  derived: ProjectDocument['derived'],
  bodyId: BodyId,
  top: number
) {
  const body = derived.bodyRepresentations[bodyId]!;
  expect(body.volume).toBeCloseTo(120, 8);
  expectBounds(body.bbox, {
    min: { x: 28, y: -3, z: top - 5 },
    max: { x: 32, y: 3, z: top }
  });
}

function expectBounds(
  actual: { min: Vector3; max: Vector3 },
  expected: { min: Vector3; max: Vector3 }
) {
  for (const side of ['min', 'max'] as const)
    for (const coordinate of ['x', 'y', 'z'] as const)
      expect(actual[side][coordinate]).toBeCloseTo(
        expected[side][coordinate],
        8
      );
}

function expectVector(actual: Vector3, expected: Vector3) {
  for (const coordinate of ['x', 'y', 'z'] as const)
    expect(actual[coordinate]).toBeCloseTo(expected[coordinate], 8);
}

describe(
  'datum vertex re-pick on the exact kernel',
  { timeout: 120_000 },
  () => {
    it.each([false, true])(
      'repairs every lost three-point slot atomically and preserves typed points (%s), reversal, chained offset and attached pad through undo/replay/backup',
      async (typedMiddle) => {
        const f = await sources();
        const middle = at('30 + 20', 0, '5 + 12');
        const points = oldCorners.map(
          (point) => pick(f.document, f.first.bodyId, point).source
        ) as [
          EdgeVertexPointSource,
          EdgeVertexPointSource,
          EdgeVertexPointSource
        ];
        const plane = addDatumPlane(f.document, {
          name: 'Vertex plane',
          definition: {
            kind: 'three-point',
            points: [points[0], typedMiddle ? middle : points[1], points[2]],
            reverseNormal: true
          }
        });
        const offset = addDatumPlane(plane.document, {
          name: 'Retained offset',
          definition: {
            kind: 'offset',
            source: { type: 'datum', datumFeatureId: plane.featureId },
            offset: '1 + 1'
          }
        });
        const sketch = addSketchFeature(offset.document, {
          name: 'Attached sketch',
          planeRef: { type: 'datum', datumFeatureId: offset.featureId },
          objects: [
            {
              objectKind: 'rectangle',
              width: 4,
              height: 6,
              centerX: 0,
              centerY: 0
            }
          ]
        });
        const pad = extrudeSketch(sketch.document, {
          name: 'Attached pad',
          sketchId: sketch.sketchId,
          distance: 5,
          operation: 'new-body'
        });
        const valid = await synced(pad.document);
        expect(valid.derived.warnings).toEqual([]);
        const broken = await synced(
          deleteFeature(valid, { featureId: f.first.featureId })
        );
        expect(broken.derived.datumFrames?.[plane.featureId]).toBeUndefined();
        const manager = new CommandManager(broken);
        const slots: (0 | 1 | 2)[] = typedMiddle ? [0, 2] : [0, 1, 2];
        if (!typedMiddle) {
          const bad = staged(broken, plane.featureId, slots, [
            pick(broken, f.second.bodyId, newCorners[0]!),
            pick(broken, f.second.bodyId, newCorners[1]!),
            pick(broken, f.third.bodyId, v(40, 0, 17))
          ]);
          const untouched = manager.document;
          await expect(commit(manager, bad)).rejects.toThrow(
            /collinear|one line/i
          );
          expect(manager.document).toBe(untouched);
        }
        const edit = staged(
          broken,
          plane.featureId,
          slots,
          slots.map((index) =>
            pick(broken, f.second.bodyId, newCorners[index]!)
          )
        );
        const beforeHistory = manager.document.commandLog.length;
        const result = await commit(manager, edit);
        expect(manager.document.commandLog).toHaveLength(beforeHistory + 1);
        expect(edit.command.kind).toBe('feature.update');
        expectVector(
          result.datumFrames![plane.featureId]!.origin,
          v(30, 0, 17)
        );
        expectVector(result.datumFrames![plane.featureId]!.normal, v(0, 0, -1));
        expectPad(result, pad.bodyId, 15);
        const repaired = findFeature(manager.document, plane.featureId)!;
        expect(repaired.featureId).toBe(plane.featureId);
        expect(repaired.data).toMatchObject({
          featureKind: 'datum-plane',
          definition: { kind: 'three-point', reverseNormal: true }
        });
        if (
          typedMiddle &&
          repaired.data.featureKind === 'datum-plane' &&
          repaired.data.definition.kind === 'three-point'
        )
          expect(repaired.data.definition.points[1]).toEqual(middle);
        expect(findFeature(manager.document, offset.featureId)!.data).toEqual(
          findFeature(broken, offset.featureId)!.data
        );
        manager.undo();
        expect(findFeature(manager.document, plane.featureId)!.data).toEqual(
          findFeature(broken, plane.featureId)!.data
        );
        expect(
          (await adapter.syncDocument(manager.document)).datumFrames?.[
            plane.featureId
          ]
        ).toBeUndefined();
        manager.redo();
        const reopened = await reopen(
          replayCommands(broken, manager.document.commandLog)
        );
        expect(findFeature(reopened, plane.featureId)!.data).toEqual(
          repaired.data
        );
        const replayed = await adapter.syncDocument(reopened);
        expect(replayed.warnings).toEqual([]);
        expectPad(replayed, pad.bodyId, 15);
      }
    );

    it('repairs a parallel-at-point plane without changing its plane source or reversed direction', async () => {
      const f = await sources();
      const definition: DatumPlaneDefinition = {
        kind: 'parallel-point',
        source: xy,
        point: pick(f.document, f.first.bodyId, oldCorners[0]!).source,
        reverseNormal: true
      };
      const plane = addDatumPlane(f.document, {
        name: 'Parallel vertex plane',
        definition
      });
      const sketch = addSketchFeature(plane.document, {
        name: 'Parallel sketch',
        planeRef: { type: 'datum', datumFeatureId: plane.featureId },
        objects: [
          {
            objectKind: 'rectangle',
            width: 4,
            height: 6,
            centerX: 0,
            centerY: 0
          }
        ]
      });
      const pad = extrudeSketch(sketch.document, {
        name: 'Parallel pad',
        sketchId: sketch.sketchId,
        distance: 5,
        operation: 'new-body'
      });
      const broken = await synced(
        deleteFeature(await synced(pad.document), {
          featureId: f.first.featureId
        })
      );
      const manager = new CommandManager(broken);
      const edit = staged(
        broken,
        plane.featureId,
        [0],
        [pick(broken, f.second.bodyId, newCorners[0]!)]
      );
      const result = await commit(manager, edit);
      expectPad(result, pad.bodyId, 17);
      expect(findFeature(manager.document, plane.featureId)!.data).toEqual({
        featureKind: 'datum-plane',
        definition: {
          ...definition,
          point: pick(broken, f.second.bodyId, newCorners[0]!).source
        }
      });
    });

    it('refuses a valid repaired datum whose attached to-face extrusion would fail, without committing the repair', async () => {
      const f = await sources();
      const face = f.document.derived.bodyRepresentations[
        f.second.bodyId
      ]!.topology!.faces.find(
        (item) => (item.geometry?.normal?.z ?? 0) > 0.99
      )!;
      const attachment = faceSketchAttachment({
        bodyId: f.second.bodyId,
        pickedHash: face.hash,
        face
      });
      if (!attachment.ok || attachment.attachment !== 'associative')
        throw new Error('Expected a qualified target face.');
      const plane = addDatumPlane(f.document, {
        name: 'Repairable plane',
        definition: {
          kind: 'parallel-point',
          source: xy,
          point: pick(f.document, f.first.bodyId, oldCorners[0]!).source
        }
      });
      const sketch = addSketchFeature(plane.document, {
        name: 'Limited sketch',
        planeRef: { type: 'datum', datumFeatureId: plane.featureId },
        objects: [
          {
            objectKind: 'rectangle',
            width: 4,
            height: 6,
            centerX: 0,
            centerY: 0
          }
        ]
      });
      const pad = extrudeSketch(sketch.document, {
        name: 'Limited pad',
        sketchId: sketch.sketchId,
        distance: 1,
        operation: 'new-body',
        endCondition: 'to-face',
        toFace: attachment.planeRef as FacePlaneSource
      });
      const valid = await synced(pad.document);
      expect(valid.derived.warnings).toEqual([]);
      expect(valid.derived.bodyRepresentations[pad.bodyId]!.volume).toBeCloseTo(
        168,
        8
      );
      const broken = await synced(
        deleteFeature(valid, { featureId: f.first.featureId })
      );
      const edit = staged(
        broken,
        plane.featureId,
        [0],
        [pick(broken, f.second.bodyId, newCorners[0]!)]
      );
      const candidate = edit.command.apply(broken);
      const derived = await adapter.syncDocument(candidate);
      expect(() => edit.validateDerived(derived)).not.toThrow();
      expectVector(
        derived.datumFrames![plane.featureId]!.origin,
        newCorners[0]!
      );
      const manager = new CommandManager(broken);
      const untouched = manager.document;
      await expect(commit(manager, edit)).rejects.toThrow(
        /Limited pad.*face.*sketch plane/i
      );
      expect(manager.document).toBe(untouched);
      expect(manager.document.commandLog).toEqual(broken.commandLog);
    });

    it('refuses a replacement body created after the datum without committing a repair', async () => {
      const f = await sources();
      const plane = addDatumPlane(f.document, {
        name: 'Earlier vertex plane',
        definition: {
          kind: 'parallel-point',
          source: xy,
          point: pick(f.document, f.first.bodyId, oldCorners[0]!).source
        }
      });
      const future = box(plane.document, 'Later choice', 4, 4, 4, v(70, 0, 0));
      const broken = await synced(
        deleteFeature(await synced(future.document), {
          featureId: f.first.featureId
        })
      );
      const manager = new CommandManager(broken);
      const untouched = manager.document;
      await expect(async () => {
        const edit = staged(
          broken,
          plane.featureId,
          [0],
          [pick(broken, future.bodyId, v(70, 0, 4))]
        );
        await commit(manager, edit);
      }).rejects.toThrow(/history|before|earlier|unavailable/i);
      expect(manager.document).toBe(untouched);
      expect(manager.document.commandLog).toEqual(broken.commandLog);
    });

    it('repairs both lost axis vertices as one update and restores reversed-axis Move and circular-pattern consumers', async () => {
      const f = await sources();
      const moveBox = box(f.document, 'Move block', 2, 2, 2);
      const ringBox = box(moveBox.document, 'Pattern block', 2, 2, 2);
      const source = await synced(ringBox.document);
      const axis = addDatumAxis(source, {
        name: 'Vertex axis',
        definition: {
          kind: 'two-point',
          points: [
            pick(source, f.first.bodyId, v(0, 0, 0), v(0, 0, 10)).source,
            pick(source, f.first.bodyId, v(0, 0, 10), v(0, 0, 0)).source
          ],
          reverseDirection: true
        }
      });
      const axisRef = {
        type: 'datum-axis' as const,
        datumFeatureId: axis.featureId
      };
      const moved = transformBody(axis.document, {
        name: 'Axis move',
        targetBodyId: moveBox.bodyId,
        translation: v(0, 0, 0),
        axisRotation: { axis: axisRef, angleDeg: 90 }
      });
      const ring = patternBody(moved.document, {
        name: 'Axis ring',
        targetBodyId: ringBox.bodyId,
        patternKind: 'circular',
        count: 4,
        axis: 'z',
        axisRef,
        angleDeg: 360
      });
      const valid = await synced(ring.document);
      expect(valid.derived.warnings).toEqual([]);
      const broken = await synced(
        deleteFeature(valid, { featureId: f.first.featureId })
      );
      expect(broken.derived.datumAxes?.[axis.featureId]).toBeUndefined();
      const manager = new CommandManager(broken);
      const bad = staged(
        broken,
        axis.featureId,
        [0, 1],
        [
          pick(broken, f.second.bodyId, v(30, 0, 5), v(30, 0, 17)),
          pick(broken, f.second.bodyId, v(30, 0, 5), v(50, 0, 5))
        ]
      );
      const untouched = manager.document;
      await expect(commit(manager, bad)).rejects.toThrow(
        /coincide|separate points/i
      );
      expect(manager.document).toBe(untouched);
      const edit = staged(
        broken,
        axis.featureId,
        [0, 1],
        [
          pick(broken, f.second.bodyId, v(30, 0, 5), v(30, 0, 17)),
          pick(broken, f.second.bodyId, v(30, 0, 17), v(30, 0, 5))
        ]
      );
      const result = await commit(manager, edit);
      expectVector(result.datumAxes![axis.featureId]!.origin, v(30, 0, 5));
      expectVector(result.datumAxes![axis.featureId]!.direction, v(0, 0, -1));
      const movedBody = result.bodyRepresentations[moveBox.bodyId]!;
      expect(movedBody.volume).toBeCloseTo(8, 8);
      expectBounds(movedBody.bbox, { min: v(30, 28, 0), max: v(32, 30, 2) });
      const patterned = result.bodyRepresentations[ring.bodyId]!;
      expect(patterned.volume).toBeCloseTo(32, 8);
      expectBounds(patterned.bbox, { min: v(0, -30, 0), max: v(60, 30, 2) });
      expect(
        datumVertexRepairSlots(findFeature(manager.document, axis.featureId)!)
      ).toHaveLength(2);
      expect(manager.document.commandLog).toHaveLength(
        broken.commandLog.length + 1
      );
      manager.undo();
      expect(
        (await adapter.syncDocument(manager.document)).datumAxes?.[
          axis.featureId
        ]
      ).toBeUndefined();
      manager.redo();
      const reopened = await reopen(
        replayCommands(broken, manager.document.commandLog)
      );
      const replayed = await adapter.syncDocument(reopened);
      expect(replayed.warnings).toEqual([]);
      expect(replayed.bodyRepresentations[moveBox.bodyId]!.bbox).toEqual(
        movedBody.bbox
      );
      expect(replayed.bodyRepresentations[ring.bodyId]!.bbox).toEqual(
        patterned.bbox
      );
    });
  }
);
