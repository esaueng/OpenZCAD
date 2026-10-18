import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  findFeature,
  listFeaturesInOrder,
  listNodesByKind,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  isInPlaceTransform,
  isTransformCopy,
  toUserId,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * M10 (schema v23): a Move/Rotate/Scale can add a copy. The copy is a body
 * of its own, owned by the transform feature like a Mirror's result, and
 * the source stays live: same volume, the expected bounds, an independent
 * BodyId, exported separately, and undone and redone as one step.
 */
describe('transform copy (M10)', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  // A 20 × 10 × 10 block from the origin: centre (10, 5, 5), volume 2000.
  const block = () => {
    const manager = new CommandManager(
      createProjectDocument('Copy', toUserId('user_m10_copy'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 10, depth: 10 }
      })
    );
    return { manager, blockId: manager.document.bodyOrder[0] as BodyId };
  };
  const zero = { x: 0, y: 0, z: 0 };

  async function bodies(document: ProjectDocument) {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const r = (value: number) => Math.round(value * 1e6) / 1e6 || 0;
    const of = (bodyId: BodyId) => {
      const body = derived.bodyRepresentations[bodyId]!;
      expect(body).toBeDefined();
      return {
        min: [r(body.bbox.min.x), r(body.bbox.min.y), r(body.bbox.min.z)],
        max: [r(body.bbox.max.x), r(body.bbox.max.y), r(body.bbox.max.z)],
        volume: Math.round(body.volume * 1e3) / 1e3,
        consumed: body.consumed === true
      };
    };
    return { derived, of };
  }

  function copyCommand(
    blockId: BodyId,
    extra: Partial<Parameters<typeof commandFactories.transformBody>[0]> = {}
  ) {
    return commandFactories.transformBody({
      name: 'Copy',
      targetBodyId: blockId,
      translation: { x: 30, y: 0, z: 0 },
      rotationDeg: zero,
      copy: true,
      ...extra
    });
  }

  it('adds an independent body and leaves the source in place', async () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(23);
    const { manager, blockId } = block();
    const command = copyCommand(blockId);
    manager.execute(command);
    const document = manager.document;
    const ids = command.payload.ids!;
    expect('bodyId' in ids).toBe(true);
    const copyId = (ids as { bodyId: BodyId }).bodyId;

    expect(copyId).not.toBe(blockId);
    expect(document.bodyOrder).toEqual([blockId, copyId]);
    const feature = findFeature(document, ids.featureId)!;
    expect(feature.bodyId).toBe(copyId);
    expect(isTransformCopy(feature.data)).toBe(true);
    expect(isInPlaceTransform(feature.data)).toBe(false);
    const names = listNodesByKind(document, 'body').map((body) => body.name);
    expect(names).toEqual(['Block Body', 'Block Body copy']);

    const { derived, of } = await bodies(document);
    expect(of(blockId)).toEqual({
      min: [0, 0, 0],
      max: [20, 10, 10],
      volume: 2000,
      consumed: false
    });
    expect(of(copyId)).toEqual({
      min: [30, 0, 0],
      max: [50, 10, 10],
      volume: 2000,
      consumed: false
    });
    // Both bodies export, each as its own solid.
    expect(derived.exportableBodyIds).toEqual([blockId, copyId]);
    const step = await adapter.exportStep(document, [blockId, copyId]);
    expect(step.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(2);
    const copyOnly = await adapter.exportStep(document, [copyId]);
    expect(copyOnly.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(1);
  });

  it('rotates and scales the copy about its pivot', async () => {
    const { manager, blockId } = block();
    const command = copyCommand(blockId, {
      translation: zero,
      rotationDeg: { x: 0, y: 0, z: 90 },
      pivot: { x: 10, y: 5, z: 5 },
      scale: 2
    });
    manager.execute(command);
    const copyId = (command.payload.ids as { bodyId: BodyId }).bodyId;
    const { of } = await bodies(manager.document);
    // Turned 90° about Z through the centre then doubled about it: the
    // 20 × 10 footprint becomes 20 × 40 around (10, 5).
    expect(of(copyId)).toMatchObject({
      min: [0, -15, -5],
      max: [20, 25, 15],
      volume: 16000
    });
    expect(of(blockId)).toMatchObject({
      min: [0, 0, 0],
      max: [20, 10, 10],
      volume: 2000
    });
  });

  it('undoes, redoes and replays as one step', async () => {
    const { manager, blockId } = block();
    const command = copyCommand(blockId);
    manager.execute(command);
    const copyId = (command.payload.ids as { bodyId: BodyId }).bodyId;
    const after = manager.document;

    manager.undo();
    expect(manager.document.bodyOrder).toEqual([blockId]);
    expect(
      listFeaturesInOrder(manager.document).map((f) => f.featureKind)
    ).toEqual(['primitive']);
    expect((await bodies(manager.document)).of(blockId).max).toEqual([
      20, 10, 10
    ]);

    manager.redo();
    expect(manager.document.bodyOrder).toEqual([blockId, copyId]);
    expect((await bodies(manager.document)).of(copyId).min).toEqual([30, 0, 0]);

    // Replay recreates the copy under the same BodyId.
    const replayed = replayCommands(
      createProjectDocument('Copy', toUserId('user_m10_copy')),
      after.commandLog
    );
    expect(replayed.bodyOrder).toEqual(after.bodyOrder);
  });

  it('follows a later edit to its source, and stays put when the source moves', async () => {
    const { manager, blockId } = block();
    const command = copyCommand(blockId);
    manager.execute(command);
    const copyId = (command.payload.ids as { bodyId: BodyId }).bodyId;
    const primitive = listFeaturesInOrder(manager.document)[0]!;
    manager.execute(
      commandFactories.updateFeature({
        featureId: primitive.featureId,
        data: { dimensions: { width: 30 } }
      })
    );
    // An in-place Move of the source after the copy moves only the source.
    manager.execute(
      commandFactories.transformBody({
        name: 'Move',
        targetBodyId: blockId,
        translation: { x: 0, y: 0, z: 50 }
      })
    );
    const { of } = await bodies(manager.document);
    expect(of(copyId)).toMatchObject({
      min: [30, 0, 0],
      max: [60, 10, 10],
      volume: 3000
    });
    expect(of(blockId)).toMatchObject({
      min: [0, 0, 50],
      max: [30, 10, 60]
    });
  });

  it('carries verified lineage, so a fillet on the copy leaves the source', async () => {
    const { manager, blockId } = block();
    const command = copyCommand(blockId);
    manager.execute(command);
    const copyId = (command.payload.ids as { bodyId: BodyId }).bodyId;
    const { derived } = await bodies(manager.document);
    const edge = derived.bodyRepresentations[copyId]!.topology!.edges.find(
      (entry) => entry.reference
    );
    expect(edge?.reference).toBeDefined();
    const fillet = commandFactories.filletEdges({
      name: 'Round copy',
      targetBodyId: copyId,
      edgeHashes: [edge!.hash],
      edgeReferences: [edge!.reference as never],
      size: 2
    });
    manager.execute(fillet);
    const roundedId = (fillet.payload.ids as { bodyId: BodyId }).bodyId;
    const { of } = await bodies(manager.document);
    expect(of(roundedId).volume).toBeLessThan(2000);
    expect(of(copyId).consumed).toBe(true);
    expect(of(blockId)).toMatchObject({ volume: 2000, consumed: false });
  });

  it('refuses to turn an existing Move into a copy', () => {
    const { manager, blockId } = block();
    manager.execute(
      commandFactories.transformBody({
        name: 'Move',
        targetBodyId: blockId,
        translation: { x: 5, y: 0, z: 0 }
      })
    );
    const move = listFeaturesInOrder(manager.document)[1]!;
    expect(() =>
      updateFeature(manager.document, {
        featureId: move.featureId,
        data: { copy: true } as never
      })
    ).toThrow(/not valid for a transform feature/);
  });
});
