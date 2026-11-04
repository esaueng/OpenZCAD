import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import {
  roundedBlockDocument,
  remainingVerticalEdge
} from './fixtures/chamfer-rounded-block';

describe('chamfers beside existing rounds', { timeout: 180_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  it('keeps valid geometry visible when optional continuity classification fails', async () => {
    const model = await roundedBlockDocument(adapter);
    const continuity = vi
      .spyOn(RemusKernel.prototype, 'getSolidSmoothEdges')
      .mockImplementation(() => {
        throw new Error('continuity unavailable');
      });
    const fresh = await createExactKernelAdapter();
    try {
      const result = await fresh.syncDocument(model.document);
      expect(continuity).toHaveBeenCalled();
      expect(result.warnings).toEqual([]);
      const body = result.bodyRepresentations[model.bodyId]!;
      expect(body.faceCount).toBe(13);
      expect(
        body.topology!.edges.every((edge) => edge.isSmooth === undefined)
      ).toBe(true);
    } finally {
      fresh.dispose();
      continuity.mockRestore();
    }
  });

  it('classifies smooth boundaries and accepts every sharp edge individually and together', async () => {
    const model = await roundedBlockDocument(adapter);
    const before = await adapter.syncDocument(model.document);
    expect(before.warnings).toEqual([]);
    const body = before.bodyRepresentations[model.bodyId]!;
    expect(body.faceCount).toBe(13);
    const sharp = body.topology!.edges.filter(
      (edge) => edge.displayRole !== 'seam' && edge.isSmooth !== true
    );
    expect(sharp).toHaveLength(11);
    expect(body.topology!.edges.filter((edge) => edge.isSmooth)).toHaveLength(
      17
    );
    for (const size of [0.1, 1]) {
      for (const selection of [...sharp.map((edge) => [edge]), sharp]) {
        const command = commandFactories.chamferEdges({
          name: 'Chamfer',
          targetBodyId: model.bodyId,
          size,
          edgeHashes: selection.map((edge) => edge.hash),
          edgeReferences: selection.map((edge) => edge.reference!)
        });
        const candidate = command.apply(model.document);
        const result = await adapter.syncDocument(candidate);
        expect(
          result.warnings,
          `C${size}, ${selection.map((edge) => edge.hash).join(',')}`
        ).toEqual([]);
        const chamfered =
          result.bodyRepresentations[candidate.bodyOrder.at(-1)!]!;
        expect(chamfered.volume).toBeGreaterThan(0);
        expect(chamfered.volume).toBeLessThan(body.volume);
        expect(
          chamfered.topology!.faces.some(
            (face) => face.geometry?.surfaceType === 'cylinder'
          )
        ).toBe(true);
      }
    }
  });

  it('previews, commits, undoes, redoes and reopens a vertical edge ending on a round', async () => {
    const model = await roundedBlockDocument(adapter);
    const before = await adapter.syncDocument(model.document);
    const selected = before.bodyRepresentations[
      model.bodyId
    ]!.topology!.edges.filter(remainingVerticalEdge);
    expect(selected).toHaveLength(1);
    const manager = new CommandManager({ ...model.document, derived: before });
    const command = commandFactories.chamferEdges({
      name: 'Vertical chamfer',
      targetBodyId: model.bodyId,
      size: 1,
      edgeHashes: selected.map((edge) => edge.hash),
      edgeReferences: selected.map((edge) => edge.reference!)
    });
    const preview = await adapter.previewGeometry(
      command.apply(manager.document)
    );
    expect(preview.warnings).toEqual([]);
    manager.execute(command);
    const resultId = manager.document.bodyOrder.at(-1)!;
    const committed = await adapter.syncDocument(manager.document);
    expect(committed.warnings).toEqual([]);
    const volume = committed.bodyRepresentations[resultId]!.volume;
    // Independently checked against the exact STEP result with Open CASCADE.
    expect(volume).toBeCloseTo(20952.382650440457, 1);
    manager.undo();
    expect(
      (await adapter.syncDocument(manager.document)).bodyRepresentations[
        model.bodyId
      ]!.volume
    ).toBeCloseTo(before.bodyRepresentations[model.bodyId]!.volume, 5);
    manager.redo();
    const reopened = await createExactKernelAdapter();
    try {
      const document = JSON.parse(
        JSON.stringify(manager.document)
      ) as typeof manager.document;
      const result = await reopened.syncDocument(document);
      expect(result.warnings).toEqual([]);
      expect(result.bodyRepresentations[resultId]!.volume).toBeCloseTo(
        volume,
        5
      );
      const step = await reopened.exportStep(document, [resultId]);
      expect(step).toContain('CYLINDRICAL_SURFACE');
    } finally {
      reopened.dispose();
    }
  });
});
