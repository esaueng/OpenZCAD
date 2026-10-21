import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCadDocumentDigest,
  parseCadPatchProposal,
  validateCadPatchProposalAgainstDigest
} from '@openzcad/ai-contracts';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addDatumPlane,
  addPrimitiveFeature,
  attachDerivedState,
  createProjectDocument,
  findFeature,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DatumPlaneDefinition,
  type ProjectDocument
} from '@openzcad/shared';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';
import { parseProjectBackup } from '../apps/web/src/lib/projectBackup';

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);
afterAll(() => adapter.dispose());
const vector = (x: number, y: number, z: number) => ({ x, y, z });
function expectVector(
  actual: ReturnType<typeof vector>,
  expected: ReturnType<typeof vector>
) {
  for (const axis of ['x', 'y', 'z'] as const)
    expect(actual[axis]).toBeCloseTo(expected[axis], 12);
}
const point = (x: number | string, y: number | string, z: number | string) => ({
  type: 'point' as const,
  point: { x, y, z }
});
const canonical = (plane = 'XY', offset: number | string = 0) => ({
  type: 'canonical',
  plane,
  offset
});
const patch = (operations: unknown[]) =>
  parseCadPatchProposal({
    proposalId: 'datum_geometry',
    summary: 'Build on named datums',
    assumptions: [],
    operations
  });

async function sync(document: ProjectDocument) {
  return attachDerivedState(document, await adapter.syncDocument(document));
}
async function block() {
  const document = addPrimitiveFeature(
    createProjectDocument('AI datum geometry', toUserId('user_ai')),
    {
      name: 'Source block',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    }
  );
  return sync(document);
}
function topSource(document: ProjectDocument, bodyId = document.bodyOrder[0]!) {
  const face = createCadDocumentDigest(document)
    .bodies!.find((body) => body.bodyId === bodyId)!
    .topology!.faces.find((face) => (face.snapshot?.normal?.z ?? 0) > 0.99)!;
  expect(face.reference).toBeDefined();
  expect(face.snapshot?.centroid).toBeDefined();
  return {
    type: 'face',
    bodyId,
    faceHash: face.hash,
    faceReference: face.reference!,
    sourceArea: face.snapshot!.area,
    sourceCenter: face.snapshot!.center,
    sourceCentroid: face.snapshot!.centroid!,
    sourceNormal: face.snapshot!.normal!,
    frame: face.attachmentFrame!
  };
}
async function apply(manager: CommandManager, operations: unknown[]) {
  const proposal = patch(operations);
  validateCadPatchProposalAgainstDigest(
    proposal,
    createCadDocumentDigest(manager.document)
  );
  const checked = await preflightCadPatch(
    manager.document,
    proposal,
    (candidate) => adapter.syncDocument(candidate)
  );
  manager.runTransaction('Apply datum proposal', checked.commands);
  manager.commitDerivedState(checked.candidate.derived);
  return manager.document;
}
function named(document: ProjectDocument, name: string) {
  return listFeaturesInOrder(document).find(
    (feature) => feature.name === name
  )!;
}
async function backup(document: ProjectDocument) {
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
function volume(document: ProjectDocument, bodyId: BodyId) {
  return document.derived.bodyRepresentations[bodyId]!.volume;
}

describe(
  'R01 complete AI datum geometry on the exact kernel',
  { timeout: 120_000 },
  () => {
    it.each([undefined, 2] as const)(
      'preserves Front basis %s when an AI update changes the canonical source offset and reverses the plane',
      async (basisRevision) => {
        const initial = addDatumPlane(await block(), {
          name: 'Front reference',
          definition: {
            kind: 'offset',
            source: {
              type: 'canonical',
              plane: 'XZ',
              offset: 3,
              ...(basisRevision ? { basisRevision } : {})
            },
            offset: 2
          }
        });
        const manager = new CommandManager(await sync(initial.document));
        const before =
          manager.document.derived.datumFrames![initial.featureId]!;
        await apply(manager, [
          {
            kind: 'update_datum_plane',
            featureId: initial.featureId,
            definition: {
              kind: 'offset',
              source: canonical('XZ', '1 + 3'),
              offset: 2,
              reverseNormal: true
            }
          }
        ]);
        const frame = manager.document.derived.datumFrames![initial.featureId]!;
        expectVector(frame.origin, vector(0, before.normal.y * 6, 0));
        expectVector(
          frame.normal,
          vector(-before.normal.x, -before.normal.y, -before.normal.z)
        );
        const data = findFeature(manager.document, initial.featureId)!.data;
        expect(data).toMatchObject({
          definition: { source: { offset: '1 + 3' } }
        });
        if (
          data.featureKind !== 'datum-plane' ||
          data.definition.kind !== 'offset' ||
          data.definition.source.type !== 'canonical'
        )
          throw new Error('The plane construction changed.');
        expect(data.definition.source.basisRevision).toBe(basisRevision);
      }
    );

    it('builds on a qualified face plane and updates existing sketch/mirror consumers without changing identities or raw expressions', async () => {
      const baseManager = new CommandManager(await block());
      baseManager.execute(
        commandFactories.setParameter({ name: 'lift', expression: '2' })
      );
      const base = await sync(baseManager.document);
      const manager = new CommandManager(base);
      const source = topSource(base);
      await apply(manager, [
        {
          kind: 'add_datum_plane_v2',
          name: 'Face plane',
          localId: 'face_plane',
          definition: {
            kind: 'offset',
            source,
            offset: 'lift',
            reverseNormal: false
          }
        },
        {
          kind: 'add_datum_sketch',
          name: 'Attached profile',
          localId: 'profile',
          datum: '$face_plane',
          objects: [
            {
              objectKind: 'rectangle',
              centerX: 0,
              centerY: 0,
              width: 4,
              height: 6
            }
          ]
        },
        {
          kind: 'add_extrude',
          name: 'Attached pad',
          localId: 'pad',
          sketchId: '$profile',
          distance: 5,
          samplePoint: null
        },
        {
          kind: 'add_datum_plane',
          name: 'Mirror plane',
          localId: 'mirror_plane',
          definition: { kind: 'offset', source: canonical('YZ'), offset: 30 }
        },
        {
          kind: 'add_datum_mirror',
          name: 'Reflected pad',
          targetBodyId: '$pad',
          datum: '$mirror_plane'
        }
      ]);
      const before = manager.document;
      const plane = named(before, 'Face plane');
      const pad = named(before, 'Attached pad');
      const reflected = named(before, 'Reflected pad');
      expect(before.derived.datumFrames![plane.featureId]!.origin.z).toBe(12);
      expect(volume(before, pad.bodyId!)).toBeCloseTo(120, 8);
      expect(
        before.derived.bodyRepresentations[pad.bodyId!]!.bbox.min.z
      ).toBeCloseTo(12, 8);
      expect(
        before.derived.bodyRepresentations[reflected.bodyId!]!.bbox.min.x
      ).toBeCloseTo(53, 8);
      const cursor = before.editHistory!.cursor;
      await apply(manager, [
        { kind: 'set_parameter', name: 'lift', expression: '4' },
        {
          kind: 'update_datum_plane',
          featureId: plane.featureId,
          definition: {
            kind: 'offset',
            source,
            offset: 'lift + 1',
            reverseNormal: true
          }
        }
      ]);
      const updated = manager.document;
      expect(updated.editHistory!.cursor).toBe(cursor + 1);
      expect(findFeature(updated, plane.featureId)!.data).toMatchObject({
        definition: { offset: 'lift + 1', reverseNormal: true }
      });
      expect(updated.derived.datumFrames![plane.featureId]!.origin.z).toBe(15);
      expectVector(
        updated.derived.datumFrames![plane.featureId]!.normal,
        vector(0, 0, -1)
      );
      expect(
        updated.derived.bodyRepresentations[pad.bodyId!]!.bbox.min.z
      ).toBeCloseTo(10, 8);
      expect(volume(updated, reflected.bodyId!)).toBeCloseTo(120, 8);
      manager.undo();
      expect(findFeature(manager.document, plane.featureId)!.data).toEqual(
        plane.data
      );
      manager.redo();
      const replayed = await sync(
        await backup(
          replayCommands(
            base,
            manager.document.commandLog.slice(base.commandLog.length)
          )
        )
      );
      expect(findFeature(replayed, plane.featureId)!.data).toEqual(
        findFeature(updated, plane.featureId)!.data
      );
      expect(replayed.derived.bodyRepresentations[pad.bodyId!]!.bbox).toEqual(
        updated.derived.bodyRepresentations[pad.bodyId!]!.bbox
      );
      expect(replayed.derived.warnings).toEqual([]);
    });

    it('retains an exact historical face source while updating a datum whose source was consumed by a later Split', async () => {
      const base = await block();
      const manager = new CommandManager(base);
      const source = topSource(base);
      await apply(manager, [
        {
          kind: 'add_datum_plane_v2',
          name: 'Cut plane',
          localId: 'cut',
          definition: { kind: 'offset', source, offset: -5 }
        },
        {
          kind: 'add_datum_split',
          name: 'Halves',
          targetBodyId: base.bodyOrder[0],
          datum: '$cut',
          localId: 'positive',
          secondLocalId: 'negative'
        }
      ]);
      const plane = named(manager.document, 'Cut plane');
      const outputIds = manager.document.derived.exportableBodyIds;
      expect(
        outputIds
          .map((id) => volume(manager.document, id))
          .sort((a, b) => a - b)
      ).toEqual([500, 500]);
      expect(
        createCadDocumentDigest(manager.document).bodies!.find(
          (body) => body.bodyId === base.bodyOrder[0]
        )!.topology
      ).toBeUndefined();
      await apply(manager, [
        {
          kind: 'update_datum_plane',
          featureId: plane.featureId,
          definition: { kind: 'offset', source, offset: -2 }
        }
      ]);
      expect(manager.document.derived.exportableBodyIds).toEqual(outputIds);
      const values = outputIds
        .map((id) => volume(manager.document, id))
        .sort((a, b) => a - b);
      expect(values[0]).toBeCloseTo(200, 8);
      expect(values[1]).toBeCloseTo(800, 8);
      expect(
        findFeature(manager.document, plane.featureId)!.data
      ).toMatchObject({ definition: { source, offset: -2 } });
    });

    it('builds mixed vertex/typed planes, all four axis constructors and all three axis consumers in one atomic proposal', async () => {
      let document = await block();
      document = addPrimitiveFeature(document, {
        name: 'Cylinder source',
        primitiveKind: 'cylinder',
        dimensions: { radius: 3, height: 10 }
      });
      const cylinderId = document.bodyOrder.at(-1)!;
      document = addPrimitiveFeature(document, {
        name: 'Move block',
        primitiveKind: 'box',
        dimensions: { width: 2, height: 2, depth: 2 }
      });
      const moveId = document.bodyOrder.at(-1)!;
      document = addPrimitiveFeature(document, {
        name: 'Pattern block',
        primitiveKind: 'box',
        dimensions: { width: 2, height: 2, depth: 2 }
      });
      const patternId = document.bodyOrder.at(-1)!;
      const base = await sync(document);
      const digest = createCadDocumentDigest(base);
      const edge = digest
        .bodies!.find((body) => body.bodyId === base.bodyOrder[0])!
        .topology!.edges.find((edge) => {
          const witness = edge.reference?.witness;
          return (
            witness &&
            !witness.closed &&
            witness.endpoints.every((p) => p[0] === 0 && p[1] === 0)
          );
        })!;
      expect(edge.reference).toBeDefined();
      const vertex = (end: number) => ({
        type: 'edge-vertex',
        bodyId: base.bodyOrder[0],
        edgeReference: edge.reference,
        end
      });
      const side = digest
        .bodies!.find((body) => body.bodyId === cylinderId)!
        .topology!.faces.find(
          (face) => face.snapshot?.surfaceType === 'cylinder'
        )!;
      const manager = new CommandManager(base);
      await apply(manager, [
        {
          kind: 'add_datum_plane_v2',
          name: 'Three point plane',
          localId: 'three',
          definition: {
            kind: 'three-point',
            points: [vertex(0), point('5 + 5', 0, 0), point(0, 10, 0)]
          }
        },
        {
          kind: 'add_datum_plane_v2',
          name: 'Parallel point plane',
          localId: 'parallel',
          definition: {
            kind: 'parallel-point',
            source: { type: 'datum', datum: '$three' },
            point: vertex(1)
          }
        },
        {
          kind: 'add_datum_axis',
          name: 'Point axis',
          localId: 'points',
          definition: {
            kind: 'two-point',
            points: [point(30, 0, 0), point(30, 0, '5 + 5')],
            reverseDirection: true
          }
        },
        {
          kind: 'add_datum_axis',
          name: 'Edge axis',
          localId: 'edge',
          definition: {
            kind: 'edge',
            source: {
              type: 'edge',
              bodyId: base.bodyOrder[0],
              edgeReference: edge.reference
            }
          }
        },
        {
          kind: 'add_datum_axis',
          name: 'Cylinder axis',
          definition: {
            kind: 'cylinder',
            source: {
              type: 'face',
              bodyId: cylinderId,
              faceReference: side.reference
            }
          }
        },
        {
          kind: 'add_datum_axis',
          name: 'Intersection axis',
          definition: {
            kind: 'plane-intersection',
            sources: [{ type: 'datum', datum: '$three' }, canonical('YZ')]
          }
        },
        {
          kind: 'add_datum_transform',
          name: 'Axis move',
          targetBodyId: moveId,
          datum: '$points',
          angleDeg: 90,
          translation: vector(0, 0, 0)
        },
        {
          kind: 'add_datum_pattern',
          name: 'Axis ring',
          localId: 'ring',
          targetBodyId: patternId,
          datum: '$points',
          count: 4,
          angleDeg: 360
        },
        {
          kind: 'add_sketch',
          name: 'Torus profile',
          localId: 'profile',
          plane: 'XZ',
          offset: 0,
          objects: [{ objectKind: 'circle', centerX: 5, centerY: 0, radius: 1 }]
        },
        {
          kind: 'add_datum_revolve',
          name: 'Axis torus',
          sketchId: '$profile',
          datum: '$edge',
          angleDeg: 360
        }
      ]);
      const built = manager.document;
      expect(built.editHistory!.entries).toHaveLength(1);
      expect(Object.keys(built.derived.datumFrames!)).toHaveLength(2);
      expect(Object.keys(built.derived.datumAxes!)).toHaveLength(4);
      expect(
        built.derived.datumFrames![
          named(built, 'Parallel point plane').featureId
        ]!.origin.z
      ).toBe(10);
      expectVector(
        built.derived.datumAxes![named(built, 'Point axis').featureId]!
          .direction,
        vector(0, 0, -1)
      );
      expectVector(
        built.derived.bodyRepresentations[moveId]!.bbox.min,
        vector(30, 28, 0)
      );
      expectVector(
        built.derived.bodyRepresentations[moveId]!.bbox.max,
        vector(32, 30, 2)
      );
      expect(volume(built, named(built, 'Axis ring').bodyId!)).toBeCloseTo(
        32,
        8
      );
      expect(volume(built, named(built, 'Axis torus').bodyId!)).toBeCloseTo(
        10 * Math.PI ** 2,
        6
      );
      const axis = named(built, 'Point axis');
      await apply(manager, [
        {
          kind: 'update_datum_axis',
          featureId: axis.featureId,
          definition: {
            kind: 'two-point',
            points: [point(20, 0, 0), point(20, 0, 10)],
            reverseDirection: false
          }
        }
      ]);
      const changed = manager.document;
      expect(
        changed.derived.bodyRepresentations[moveId]!.bbox.min.x
      ).toBeCloseTo(18, 8);
      expect(
        changed.derived.bodyRepresentations[moveId]!.bbox.min.y
      ).toBeCloseTo(-20, 8);
      const restored = await sync(
        await backup(replayCommands(base, changed.commandLog))
      );
      expect(findFeature(restored, axis.featureId)!.data).toEqual(
        findFeature(changed, axis.featureId)!.data
      );
      expect(restored.derived.bodyRepresentations[moveId]!.bbox).toEqual(
        changed.derived.bodyRepresentations[moveId]!.bbox
      );
      expect(restored.derived.warnings).toEqual([]);
    });

    it.each([
      {
        kind: 'add_datum_plane_v2',
        name: 'Collinear plane',
        definition: {
          kind: 'three-point',
          points: [point(0, 0, 0), point(1, 0, 0), point(2, 0, 0)]
        }
      },
      {
        kind: 'add_datum_plane_v2',
        name: 'Nonparallel middle',
        definition: {
          kind: 'midplane',
          sources: [canonical('XY'), canonical('YZ')]
        }
      },
      {
        kind: 'add_datum_axis',
        name: 'Coincident axis',
        definition: {
          kind: 'two-point',
          points: [point('1 + 1', 0, 0), point(2, 0, 0)]
        }
      },
      {
        kind: 'add_datum_axis',
        name: 'Parallel intersection',
        definition: {
          kind: 'plane-intersection',
          sources: [canonical('XY'), canonical('XY', 2)]
        }
      }
    ])(
      'refuses datum-only exact degeneracy without publishing $name',
      async (operation) => {
        const manager = new CommandManager(await block());
        const original = manager.document;
        await expect(apply(manager, [operation])).rejects.toThrow();
        expect(manager.document).toBe(original);
        expect(manager.document.editHistory).toEqual(original.editHistory);
        expect(manager.document.commandLog).toEqual(original.commandLog);
      }
    );

    it('refuses an update that leaves an already-broken datum unresolved even when its failure warning is unchanged', async () => {
      const definition: DatumPlaneDefinition = {
        kind: 'three-point',
        points: [point(0, 0, 0), point(1, 0, 0), point(2, 0, 0)]
      };
      const bad = addDatumPlane(await block(), {
        name: 'Already collinear',
        definition
      });
      const manager = new CommandManager(await sync(bad.document));
      const original = manager.document;
      expect(original.derived.datumFrames?.[bad.featureId]).toBeUndefined();
      await expect(
        apply(manager, [
          { kind: 'update_datum_plane', featureId: bad.featureId, definition }
        ])
      ).rejects.toThrow(/collinear|resolve|one line/i);
      expect(manager.document).toBe(original);
      expect(manager.document.commandLog).toEqual(original.commandLog);
    });
  }
);
