import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, replayCommands } from '@openzcad/command-system';
import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type { SerializedCommand, TopologySelection } from '@openzcad/shared';
import { importedFaceDeletion } from '../apps/web/src/lib/featureDeletion';
import { directEditRejection } from '../apps/web/src/lib/directEdit';
import { importedDetail } from './fixtures/imported-detail';
import { nativeDetail } from './fixtures/native-detail';

describe('picked imported STEP detail removal', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  it.each(['hole', 'chamfer', 'fillet'] as const)(
    'heals a STEP %s, preserves the import and replays after Undo/Redo',
    async (kind) => {
      const { document, body, face } = await importedDetail(adapter, kind);
      expect(document.derived.warnings).toEqual([]);
      expect(listFeaturesInOrder(document)).toHaveLength(1);
      const removal = importedFaceDeletion(document, {
        bodyId: body.bodyId,
        kind: 'face',
        topologyId: face.topologyId,
        hash: face.hash,
        reference: face.reference
      });
      const manager = new CommandManager(document);
      manager.execute(removal.command);
      const removed = await adapter.syncDocument(manager.document);
      expect(removed.warnings).toEqual([]);
      expect(removed.bodyRepresentations[body.bodyId]!.volume).toBeCloseTo(
        12960,
        6
      );
      expect(removed.bodyRepresentations[body.bodyId]!.faceCount).toBe(6);
      expect(
        listFeaturesInOrder(manager.document).map(
          (feature) => feature.data.featureKind
        )
      ).toEqual(['imported-step', 'direct-edit']);
      const exported = await adapter.inspectStep(
        await adapter.exportStep(manager.document, [body.bodyId])
      );
      expect(exported.valid).toBe(true);
      expect(exported.solid).toBe(true);
      expect(exported.volume).toBeCloseTo(12960, 6);
      manager.undo();
      expect(
        (await adapter.syncDocument(manager.document)).bodyRepresentations[
          body.bodyId
        ]!.volume
      ).toBeCloseTo(body.volume, 6);
      manager.redo();
      const cold = replayCommands(document, [
        JSON.parse(
          JSON.stringify(removal.command.serialize())
        ) as SerializedCommand
      ]);
      const replayed = await adapter.syncDocument(cold);
      expect(replayed.warnings).toEqual([]);
      expect(replayed.bodyRepresentations[body.bodyId]!.volume).toBeCloseTo(
        12960,
        6
      );
    }
  );

  it('refuses stale, ambiguous, body and native picks before constructing an edit', async () => {
    const { document, body, face } = await importedDetail(adapter, 'hole');
    const pick: TopologySelection = {
      bodyId: body.bodyId,
      kind: 'face',
      topologyId: face.topologyId,
      hash: face.hash
    };
    expect(() =>
      importedFaceDeletion(document, { ...pick, topologyId: 'stale' })
    ).toThrow('current face');
    expect(() =>
      importedFaceDeletion(document, { bodyId: body.bodyId, kind: 'body' })
    ).toThrow('current face');
    const duplicate = structuredClone(document);
    duplicate.derived.bodyRepresentations[body.bodyId]!.topology!.faces.push({
      ...face
    });
    expect(() => importedFaceDeletion(duplicate, pick)).toThrow('current face');
    const native = await nativeDetail(adapter, 'hole');
    const derived = await adapter.syncDocument(native.document);
    expect(() =>
      importedFaceDeletion(
        { ...native.document, derived },
        { bodyId: native.bodyId, kind: 'face', hash: face.hash }
      )
    ).toThrow('current face');
  });

  it('refuses an ordinary face without deleting the imported solid', async () => {
    const { document, body } = await importedDetail(adapter, 'hole');
    const face = body.topology!.faces.find(
      (candidate) => candidate.geometry?.surfaceType === 'plane'
    )!;
    const removal = importedFaceDeletion(document, {
      bodyId: body.bodyId,
      kind: 'face',
      topologyId: face.topologyId,
      hash: face.hash
    });
    const candidate = removal.command.apply(document);
    const failed = await adapter.syncDocument(candidate);
    expect(
      directEditRejection({
        label: removal.command.label,
        warnings: failed.warnings,
        featureWarnings: failed.featureWarnings,
        bodyPresent: true,
        documentMoved: false
      })
    ).toBeTruthy();
    expect(listFeaturesInOrder(document)).toHaveLength(1);
    expect(failed.bodyRepresentations[body.bodyId]!.volume).toBeCloseTo(
      body.volume,
      6
    );
  });
});
