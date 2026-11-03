import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyRepresentation } from '@openzcad/shared';
import {
  CORNER_CHAMFER_VOLUME,
  filletedCornerDocument,
  threeCornerEdges
} from './fixtures/chamfer-fillet-corner';

function expectCornerTopology(
  body: Pick<BodyRepresentation, 'topology' | 'faceCount'>
) {
  expect(
    body.topology!.faces.filter(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )
  ).toHaveLength(2);
  expect(body.faceCount).toBe(12);
}

function expectCorner(body: BodyRepresentation) {
  expectCornerTopology(body);
  expect(body.volume).toBeCloseTo(CORNER_CHAMFER_VOLUME, 2);
}

describe(
  'three-edge chamfer after earlier fillets',
  { timeout: 120_000 },
  () => {
    let adapter: ExactKernelAdapter;
    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });
    afterAll(() => adapter.dispose());

    it('previews, commits, undoes, redoes and replays the corner without losing its rounds', async () => {
      const model = await filletedCornerDocument(adapter);
      const before = await adapter.syncDocument(model.document);
      expect(before.warnings).toEqual([]);
      const body = before.bodyRepresentations[model.bodyId]!;
      const edges = threeCornerEdges(body);
      expect(edges).toHaveLength(3);
      expect(edges.reduce((sum, edge) => sum + edge.length!, 0)).toBeCloseTo(
        86.5,
        6
      );
      const manager = new CommandManager({
        ...model.document,
        derived: before
      });
      const command = commandFactories.chamferEdges({
        name: 'Three-edge chamfer',
        targetBodyId: model.bodyId,
        edgeHashes: edges.map((edge) => edge.hash),
        edgeReferences: edges.map((edge) => edge.reference!),
        size: 1
      });
      const candidate = command.apply(manager.document);
      const preview = await adapter.previewGeometry(candidate);
      expect(preview.warnings).toEqual([]);
      expect(preview.analysis).toBe('pending');
      const previewBody =
        preview.bodyRepresentations[candidate.bodyOrder.at(-1)!]!;
      expect(previewBody).not.toHaveProperty('volume');
      expectCornerTopology(previewBody);
      manager.execute(command);
      const resultId = manager.document.bodyOrder.at(-1)!;
      const committed = await adapter.syncDocument(manager.document);
      expect(committed.warnings).toEqual([]);
      expectCorner(committed.bodyRepresentations[resultId]!);
      manager.undo();
      const undone = await adapter.syncDocument(manager.document);
      expect(undone.warnings).toEqual([]);
      expect(undone.bodyRepresentations[model.bodyId]!.volume).toBeCloseTo(
        body.volume,
        6
      );
      manager.redo();
      const replay = await createExactKernelAdapter();
      try {
        const reopened = JSON.parse(
          JSON.stringify(manager.document)
        ) as typeof manager.document;
        const derived = await replay.syncDocument(reopened);
        expect(derived.warnings).toEqual([]);
        expectCorner(derived.bodyRepresentations[resultId]!);
        const step = await replay.exportStep(reopened, [resultId]);
        expect(step.match(/CYLINDRICAL_SURFACE/g)).toHaveLength(2);
        const imported = importStepBody(
          createProjectDocument('Round trip', toUserId('user_corner')),
          {
            name: 'Chamfered corner',
            artifactId: 'corner-round-trip',
            sourceName: 'corner.step',
            stepText: step
          }
        );
        const roundTrip = await replay.syncDocument(imported.document);
        expect(roundTrip.warnings).toEqual([]);
        expectCorner(roundTrip.bodyRepresentations[imported.bodyId]!);
      } finally {
        replay.dispose();
      }
    });
  }
);
