import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { selectionFeature } from '../apps/web/src/lib/selectionFeature';
import { nativeDetail } from './fixtures/native-detail';
import { CommandManager, replayCommands } from '@openzcad/command-system';
import {
  deleteFeature,
  filletEdges,
  holeBody,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import { nativeFeatureDeletion } from '../apps/web/src/lib/featureDeletion';
import {
  selectedFeatureFaces,
  selectionSetFeature
} from '../apps/web/src/lib/selectionFeature';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  type ProjectDocument,
  type SerializedCommand
} from '@openzcad/shared';

describe('picked native details', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  it.each(['hole', 'chamfer'] as const)(
    'resolves a picked %s to its own feature',
    async (kind) => {
      const { document, bodyId, feature } = await nativeDetail(adapter, kind);
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId]!;
      const face = body.topology!.faces.find((entry) =>
        kind === 'hole'
          ? entry.reference?.lineageName === 'hole.face.bore'
          : entry.reference?.lineageName.startsWith(
              'modifier.chamfer.face.band-between.'
            )
      );
      expect(face).toBeDefined();
      expect(
        selectionFeature(document, body, {
          bodyId,
          kind: 'face',
          topologyId: face!.topologyId,
          hash: face!.hash,
          reference: face!.reference
        })?.featureId
      ).toBe(feature.featureId);
      for (const edge of body.topology!.edges.filter(
        (entry) =>
          entry.displayRole !== 'seam' &&
          entry.adjacentFaceHashes?.includes(face!.hash)
      )) {
        expect(
          selectionFeature(document, body, {
            bodyId,
            kind: 'edge',
            topologyId: edge.topologyId,
            hash: edge.hash,
            reference: edge.reference
          })?.featureId
        ).toBe(feature.featureId);
      }
      const removal = nativeFeatureDeletion(document, feature);
      const manager = new CommandManager(document);
      manager.execute(removal.command);
      const removed = await adapter.syncDocument(manager.document);
      removal.validateDerived(removed);
      expect(removed.warnings).toEqual([]);
      expect(
        Object.values(removed.bodyRepresentations).filter(
          (entry) => !entry.consumed
        )
      ).toHaveLength(1);
      expect(
        removed.bodyRepresentations[document.bodyOrder[0]!]!.volume
      ).toBeCloseTo(30 * 24 * 18, 6);
      manager.undo();
      const restored = await adapter.syncDocument(manager.document);
      expect(restored.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
        body.volume,
        6
      );
      manager.redo();
      expect(
        (await adapter.syncDocument(manager.document)).bodyRepresentations[
          bodyId
        ]
      ).toBeUndefined();
      const cold = replayCommands(document, [
        JSON.parse(
          JSON.stringify(removal.command.serialize())
        ) as SerializedCommand
      ]);
      expect((await adapter.syncDocument(cold)).warnings).toEqual([]);
    }
  );

  it.each([
    { style: 'simple', depthMode: 'blind' },
    { style: 'counterbore', depthMode: 'through' }
  ] as const)(
    'groups all faces of a $style $depthMode hole and rejects ambiguous identities',
    async (hole) => {
      const fixture = await nativeDetail(adapter, 'hole', hole);
      const derived = await adapter.syncDocument(fixture.document);
      expect(derived.warnings).toEqual([]);
      const faces = selectedFeatureFaces(
        fixture.document,
        derived.bodyRepresentations,
        fixture.feature
      );
      expect(faces.length).toBeGreaterThan(1);
      expect(
        selectionSetFeature(
          fixture.document,
          derived.bodyRepresentations,
          faces
        )?.featureId
      ).toBe(fixture.feature.featureId);
      const body = structuredClone(
        derived.bodyRepresentations[fixture.bodyId]!
      );
      const face = body.topology!.faces.find(
        (entry) => entry.topologyId === faces[0]!.topologyId
      )!;
      body.topology!.faces.push({
        ...face,
        topologyId: 'duplicate',
        hash: face.hash + 1
      });
      expect(selectionFeature(fixture.document, body, faces[0]!)).toBeNull();
      const paused = structuredClone(fixture.document);
      paused.nodes[fixture.feature.id] = {
        ...fixture.feature,
        metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
      };
      expect(
        selectionFeature(
          paused,
          derived.bodyRepresentations[fixture.bodyId],
          faces[0]!
        )
      ).toBeNull();
      expect(
        selectionFeature(
          fixture.document,
          derived.bodyRepresentations[fixture.bodyId],
          {
            ...faces[0]!,
            reference: {
              ...faces[0]!.reference!,
              lineageName: 'hole.face.missing'
            }
          }
        )
      ).toBeNull();
    }
  );

  it('keeps an independent later hole and an in-place move after removing the first hole', async () => {
    const first = await nativeDetail(adapter, 'hole');
    const derived = await adapter.syncDocument(first.document);
    const top = derived.bodyRepresentations[first.bodyId]!.topology!.faces.find(
      (face) => face.reference?.lineageName === 'primitive.box.face.z-max'
    )!;
    const second = holeBody(first.document, {
      name: 'Second hole',
      targetBodyId: first.bodyId,
      faceHash: top.hash,
      faceReference: top.reference,
      style: 'simple',
      diameter: 4,
      depthMode: 'through',
      position: { u: 8, v: 0 }
    });
    const moved = transformBody(second.document, {
      name: 'Move',
      targetBodyId: second.bodyId,
      translation: { x: 5, y: 0, z: 0 }
    }).document;
    const before = await adapter.syncDocument(moved);
    expect(before.warnings).toEqual([]);
    const removal = nativeFeatureDeletion(moved, first.feature);
    const candidate = removal.command.apply(moved);
    const result = await adapter.syncDocument(candidate);
    removal.validateDerived(result);
    expect(result.warnings).toEqual([]);
    expect(listFeaturesInOrder(candidate).map((entry) => entry.name)).toEqual([
      'Block',
      'Second hole',
      'Move'
    ]);
    expect(result.bodyRepresentations[second.bodyId]!.volume).toBeCloseTo(
      30 * 24 * 18 - Math.PI * 4 * 18,
      4
    );
    expect(
      (
        await adapter.syncDocument(
          JSON.parse(JSON.stringify(candidate)) as ProjectDocument
        )
      ).warnings
    ).toEqual([]);
    // An old command still has its original, non-reconnecting replay contract.
    expect(
      (
        await adapter.syncDocument(
          deleteFeature(moved, { featureId: first.feature.featureId })
        )
      ).warnings.length
    ).toBeGreaterThan(0);
  });

  it('highlights an entire two-edge chamfer and preserves an in-place move when it is deleted', async () => {
    const fixture = await nativeDetail(adapter, 'chamfer', {}, 2);
    const moved = transformBody(fixture.document, {
      name: 'Move chamfered block',
      targetBodyId: fixture.bodyId,
      translation: { x: 5, y: 10, z: 15 },
      rotationDeg: { x: 0, y: 0, z: 90 }
    }).document;
    const reopened = JSON.parse(JSON.stringify(moved)) as ProjectDocument;
    const derived = await adapter.syncDocument(reopened);
    expect(derived.warnings).toEqual([]);
    const picks = selectedFeatureFaces(
      reopened,
      derived.bodyRepresentations,
      fixture.feature
    );
    expect(picks).toHaveLength(2);
    expect(
      selectionSetFeature(reopened, derived.bodyRepresentations, picks)
        ?.featureId
    ).toBe(fixture.feature.featureId);
    const removal = nativeFeatureDeletion(reopened, fixture.feature);
    const candidate = removal.command.apply(reopened);
    const removed = await adapter.syncDocument(candidate);
    removal.validateDerived(removed);
    expect(removed.warnings).toEqual([]);
    expect(removed.bodyRepresentations[fixture.sourceId]!.volume).toBeCloseTo(
      30 * 24 * 18,
      6
    );
    expect(listFeaturesInOrder(candidate).at(-1)!.data).toMatchObject({
      targetBodyId: fixture.sourceId
    });
  });

  it('refuses removal when a later fillet needs the deleted hole rim', async () => {
    const first = await nativeDetail(adapter, 'hole');
    const derived = await adapter.syncDocument(first.document);
    const body = derived.bodyRepresentations[first.bodyId]!;
    const bore = body.topology!.faces.find(
      (face) => face.reference?.lineageName === 'hole.face.bore'
    )!;
    const rim = body.topology!.edges.find(
      (edge) =>
        edge.displayRole !== 'seam' &&
        edge.adjacentFaceHashes?.includes(bore.hash)
    )!;
    const filleted = filletEdges(first.document, {
      name: 'Hole rim fillet',
      targetBodyId: first.bodyId,
      size: 1,
      edgeHashes: [rim.hash],
      ...(rim.reference ? { edgeReferences: [rim.reference] } : {})
    }).document;
    expect((await adapter.syncDocument(filleted)).warnings).toEqual([]);
    const removal = nativeFeatureDeletion(filleted, first.feature);
    const result = await adapter.syncDocument(removal.command.apply(filleted));
    expect(() => removal.validateDerived(result)).toThrow(
      /Hole rim fillet.*still need its geometry/
    );
  });
});
