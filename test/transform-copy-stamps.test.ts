import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  duplicateFeatureCommands,
  replayCommands
} from '@openzcad/command-system';
import {
  assertDocumentContentCommandSchema,
  assertDocumentContentSchema,
  createBodyFeatureIds,
  createProjectDocument,
  findFeature,
  listFeaturesInOrder,
  listNodesByKind,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  MAX_TRANSFORM_COPY_STAMPS,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  transformStampBodyIds,
  toUserId,
  type BodyId,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * M10 (schema v137): a Move copy stamps repeated copies, each the same
 * transform on from the copy before it. Linked, they are one History step
 * owning every copy; as separate steps, each copy is its own transform
 * copy of the one before. Either way stamp k lands where the transform
 * applied k times puts the source, as one transaction.
 */
describe('transform copy stamps (M10, v137)', { timeout: 90_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  const user = toUserId('user_m10_stamps');
  // A 20 × 10 × 10 block from the origin: volume 2000.
  const block = () => {
    const manager = new CommandManager(createProjectDocument('Stamps', user));
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

  function stampCommand(
    blockId: BodyId,
    extra: Partial<Parameters<typeof commandFactories.transformBody>[0]> = {}
  ) {
    return commandFactories.transformBody({
      name: 'Copy',
      targetBodyId: blockId,
      translation: { x: 30, y: 0, z: 0 },
      rotationDeg: zero,
      copy: true,
      stamps: 3,
      ...extra
    });
  }

  const stampIdsOf = (
    command: ReturnType<typeof stampCommand>
  ): { featureId: FeatureId; bodyIds: BodyId[] } => {
    const ids = command.payload.ids as { featureId: FeatureId; bodyId: BodyId };
    return {
      featureId: ids.featureId,
      bodyIds: [
        ids.bodyId,
        ...(command.payload.stampIds ?? []).map((stamp) => stamp.bodyId)
      ]
    };
  };

  it('stamps three linked copies as one History step', async () => {
    const { manager, blockId } = block();
    const command = stampCommand(blockId);
    manager.execute(command);
    const document = manager.document;
    expect(document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    const { featureId, bodyIds } = stampIdsOf(command);
    expect(bodyIds).toHaveLength(3);
    expect(new Set(bodyIds).size).toBe(3);
    expect(document.bodyOrder).toEqual([blockId, ...bodyIds]);
    // One History row owns every stamp.
    expect(
      listFeaturesInOrder(document).map((feature) => feature.featureKind)
    ).toEqual(['primitive', 'transform']);
    const feature = findFeature(document, featureId)!;
    expect(feature.bodyId).toBe(bodyIds[0]);
    expect(transformStampBodyIds(feature.data)).toEqual(bodyIds.slice(1));
    expect(
      listNodesByKind(document, 'body').map((body) => [
        body.name,
        body.featureId
      ])
    ).toEqual([
      ['Block Body', listFeaturesInOrder(document)[0]!.featureId],
      ['Block Body copy 1', featureId],
      ['Block Body copy 2', featureId],
      ['Block Body copy 3', featureId]
    ]);

    const { derived, of } = await bodies(document);
    expect(of(blockId)).toEqual({
      min: [0, 0, 0],
      max: [20, 10, 10],
      volume: 2000,
      consumed: false
    });
    bodyIds.forEach((bodyId, index) =>
      expect(of(bodyId)).toEqual({
        min: [30 * (index + 1), 0, 0],
        max: [30 * (index + 1) + 20, 10, 10],
        volume: 2000,
        consumed: false
      })
    );
    expect(derived.exportableBodyIds).toEqual([blockId, ...bodyIds]);
    const step = await adapter.exportStep(document, [blockId, ...bodyIds]);
    expect(step.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(4);
  });

  it('turns each stamp once more about the pivot', async () => {
    const { manager, blockId } = block();
    const command = stampCommand(blockId, {
      translation: zero,
      rotationDeg: { x: 0, y: 0, z: 90 },
      pivot: zero
    });
    manager.execute(command);
    const { bodyIds } = stampIdsOf(command);
    const { of } = await bodies(manager.document);
    // (x, y) → (−y, x) per stamp: 90°, 180° and 270° about Z.
    expect(of(bodyIds[0]!)).toMatchObject({
      min: [-10, 0, 0],
      max: [0, 20, 10],
      volume: 2000
    });
    expect(of(bodyIds[1]!)).toMatchObject({
      min: [-20, -10, 0],
      max: [0, 0, 10],
      volume: 2000
    });
    expect(of(bodyIds[2]!)).toMatchObject({
      min: [0, -20, 0],
      max: [10, 0, 10],
      volume: 2000
    });
  });

  it('undoes, redoes and replays every stamp under the same BodyIds', async () => {
    const { manager, blockId } = block();
    const command = stampCommand(blockId);
    manager.execute(command);
    const after = manager.document;
    manager.undo();
    expect(manager.document.bodyOrder).toEqual([blockId]);
    expect(listNodesByKind(manager.document, 'body')).toHaveLength(1);
    manager.redo();
    expect(manager.document.bodyOrder).toEqual(after.bodyOrder);
    const replayed = replayCommands(
      createProjectDocument('Stamps', user),
      after.commandLog
    );
    expect(replayed.bodyOrder).toEqual(after.bodyOrder);
    const { of } = await bodies(replayed);
    expect(of(stampIdsOf(command).bodyIds[2]!).min).toEqual([90, 0, 0]);
  });

  it('moves every linked stamp when the step is edited', async () => {
    const { manager, blockId } = block();
    const command = stampCommand(blockId);
    manager.execute(command);
    const { featureId, bodyIds } = stampIdsOf(command);
    const feature = findFeature(manager.document, featureId)!;
    if (feature.data.featureKind !== 'transform') throw new Error('kind');
    const edited = updateFeature(manager.document, {
      featureId,
      data: {
        transform: {
          ...feature.data.transform,
          translation: { x: 0, y: 25, z: 0 }
        }
      }
    });
    // The stamps are body wiring: the edit keeps them.
    expect(transformStampBodyIds(findFeature(edited, featureId)!.data)).toEqual(
      bodyIds.slice(1)
    );
    const { of } = await bodies(edited);
    bodyIds.forEach((bodyId, index) =>
      expect(of(bodyId)).toMatchObject({
        min: [0, 25 * (index + 1), 0],
        max: [20, 25 * (index + 1) + 10, 10]
      })
    );
    expect(() =>
      updateFeature(manager.document, {
        featureId,
        data: { stampBodyIds: [] }
      })
    ).toThrow(/not valid for a transform feature/);
  });

  it('keeps each stamp addressable, so a fillet on one leaves the rest', async () => {
    const { manager, blockId } = block();
    const command = stampCommand(blockId);
    manager.execute(command);
    const { bodyIds } = stampIdsOf(command);
    const { derived } = await bodies(manager.document);
    const middle = bodyIds[1]!;
    const edge = derived.bodyRepresentations[middle]!.topology!.edges.find(
      (entry) => entry.reference
    );
    expect(edge?.reference).toBeDefined();
    const fillet = commandFactories.filletEdges({
      name: 'Round stamp',
      targetBodyId: middle,
      edgeHashes: [edge!.hash],
      edgeReferences: [edge!.reference as never],
      size: 2
    });
    manager.execute(fillet);
    const roundedId = (fillet.payload.ids as { bodyId: BodyId }).bodyId;
    const { of } = await bodies(manager.document);
    expect(of(roundedId).volume).toBeLessThan(2000);
    expect(of(middle).consumed).toBe(true);
    expect(of(bodyIds[0]!)).toMatchObject({ volume: 2000, consumed: false });
    expect(of(bodyIds[2]!)).toMatchObject({ volume: 2000, consumed: false });
  });

  it('lands separate steps where the linked stamps land, as one transaction', async () => {
    const { manager, blockId } = block();
    let target = blockId;
    const commands = [1, 2, 3].map((index) => {
      const ids = createBodyFeatureIds();
      const command = commandFactories.transformBody({
        name: `Copy ${index}`,
        targetBodyId: target,
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 90 },
        pivot: { x: 0, y: 0, z: 0 },
        copy: true,
        ids
      });
      target = ids.bodyId;
      return command;
    });
    manager.runTransaction('3 copies', commands);
    const features = listFeaturesInOrder(manager.document);
    expect(features.map((feature) => feature.featureKind)).toEqual([
      'primitive',
      'transform',
      'transform',
      'transform'
    ]);
    const separate = manager.document.bodyOrder.slice(1);
    const { of } = await bodies(manager.document);
    expect(separate.map((bodyId) => of(bodyId).min)).toEqual([
      [-10, 0, 0],
      [-20, -10, 0],
      [0, -20, 0]
    ]);
    manager.undo();
    expect(manager.document.bodyOrder).toEqual([blockId]);
  });

  it('duplicates a linked copy with as many new stamps', () => {
    const { manager, blockId } = block();
    const command = stampCommand(blockId);
    manager.execute(command);
    const { featureId, bodyIds } = stampIdsOf(command);
    const duplicate = duplicateFeatureCommands(manager.document, featureId);
    manager.runTransaction(duplicate.label, duplicate.commands);
    const copy = findFeature(manager.document, duplicate.featureId)!;
    const stamps = transformStampBodyIds(copy.data);
    expect(stamps).toHaveLength(2);
    expect(stamps.some((bodyId) => bodyIds.includes(bodyId))).toBe(false);
    expect(manager.document.bodyOrder).toHaveLength(7);
  });

  it('refuses a stamp count out of range, or stamps on an in-place Move', () => {
    const { manager, blockId } = block();
    const document = manager.document;
    const base = {
      name: 'Copy',
      targetBodyId: blockId,
      translation: { x: 30, y: 0, z: 0 },
      copy: true
    };
    for (const stamps of [0, 2.5, MAX_TRANSFORM_COPY_STAMPS + 1]) {
      expect(() => transformBody(document, { ...base, stamps })).toThrow(
        /whole number from 1 to 50/
      );
    }
    expect(() =>
      transformBody(document, { ...base, copy: false, stamps: 2 })
    ).toThrow(/Only a copy can stamp/);
    expect(() =>
      transformBody(document, {
        ...base,
        stamps: 3,
        stampIds: []
      })
    ).toThrow(/one identity for each further stamp/);
    // The most a copy stamps builds as many bodies.
    const most = transformBody(document, {
      ...base,
      stamps: MAX_TRANSFORM_COPY_STAMPS
    });
    expect(most.document.bodyOrder).toHaveLength(MAX_TRANSFORM_COPY_STAMPS + 1);
  });

  it('refuses stamps with supplied ids but no stamp identities, so replay stays deterministic', () => {
    const { manager, blockId } = block();
    expect(() =>
      transformBody(manager.document, {
        name: 'Copy',
        targetBodyId: blockId,
        translation: { x: 30, y: 0, z: 0 },
        copy: true,
        stamps: 3,
        ids: createBodyFeatureIds()
      })
    ).toThrow(/one identity for each further stamp/);
    // The command fills them, and a replay of its log keeps them.
    const command = stampCommand(blockId);
    expect(command.payload.stampIds).toHaveLength(2);
    // An absurd count is refused before anything is allocated for it.
    const absurd = commandFactories.transformBody({
      name: 'Copy',
      targetBodyId: blockId,
      translation: { x: 1, y: 0, z: 0 },
      copy: true,
      stamps: 10_000_000
    });
    expect(absurd.payload.stampIds).toBeUndefined();
    expect(() => manager.execute(absurd)).toThrow(/whole number from 1 to 50/);
  });

  it('refuses to write stamps into a document that declares v136', () => {
    const { manager, blockId } = block();
    const older = { ...manager.document, schemaVersion: 136 as never };
    expect(() =>
      transformBody(older, {
        name: 'Copy',
        targetBodyId: blockId,
        translation: { x: 30, y: 0, z: 0 },
        copy: true,
        stamps: 2
      })
    ).toThrow(/137/);
    // One copy is still fine there.
    expect(() =>
      transformBody(older, {
        name: 'Copy',
        targetBodyId: blockId,
        translation: { x: 30, y: 0, z: 0 },
        copy: true
      })
    ).not.toThrow();
  });

  it('refuses replayed or stored stamps in a document older than v137', () => {
    expect(() =>
      assertDocumentContentCommandSchema({
        schemaVersion: 136 as never,
        commandLog: [
          { kind: 'feature.transform', payload: { copy: true, stamps: 3 } }
        ] as never,
        editHistory: undefined
      })
    ).toThrow(/137/);
    // A single copy needs nothing newer.
    expect(() =>
      assertDocumentContentCommandSchema({
        schemaVersion: 136 as never,
        commandLog: [
          { kind: 'feature.transform', payload: { copy: true, stamps: 1 } }
        ] as never,
        editHistory: undefined
      })
    ).not.toThrow();
    const { manager, blockId } = block();
    manager.execute(stampCommand(blockId));
    expect(() => assertDocumentContentSchema(manager.document)).not.toThrow();
    expect(() =>
      assertDocumentContentSchema({
        ...manager.document,
        schemaVersion: 136 as never,
        commandLog: []
      })
    ).toThrow(/137/);
  });
});
