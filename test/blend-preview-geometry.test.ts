import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  attachDerivedState,
  createBodyFeatureIds,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { newBlendValidationTarget } from '../apps/web/src/lib/interaction/blendPreview';
import { newBlendFaceSelections } from '../apps/web/src/lib/interaction/filletFaceEdit';
import { offsetPreviewRejection } from '../apps/web/src/lib/interaction/offsetPreview';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';

/**
 * A fillet drag's frames rebuild geometry only (`previewGeometry`); the
 * complete rebuild runs once the hand rests. That is only safe while a frame
 * shows the same blend faces and the same refusal as the complete rebuild,
 * and it is only worth it while the frame skips the planar distance proofs.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

const along = (edge: EdgeTopology, offset: number) =>
  edge.points.filter((_, index) => index % 3 === offset);

async function bracket() {
  const manager = new CommandManager(
    createProjectDocument('Bracket', toUserId('user_blend_preview'), 'mm')
  );
  const plate = createBodyFeatureIds();
  const flange = createBodyFeatureIds();
  const union = createBodyFeatureIds();
  const box = (
    ids: ReturnType<typeof createBodyFeatureIds>,
    dimensions: Record<string, number>
  ) =>
    commandFactories.addPrimitive({
      name: 'Box',
      primitiveKind: 'box',
      dimensions,
      ids
    });
  manager.runTransaction('Plate', [
    box(plate, { width: 80, height: 40, depth: 5 })
  ]);
  manager.runTransaction('Flange', [
    box(flange, { width: 80, height: 5, depth: 40 })
  ]);
  manager.runTransaction('Union', [
    commandFactories.booleanBodies({
      name: 'Union',
      operation: 'union',
      targetBodyIds: [plate.bodyId, flange.bodyId],
      ids: union
    })
  ]);
  const document = attachDerivedState(
    manager.document,
    await adapter.syncDocument(manager.document)
  );
  // The inside corner where the flange meets the plate.
  const corner = document.derived.bodyRepresentations[
    union.bodyId
  ]!.topology!.edges.find((edge) => {
    const xs = along(edge, 0);
    return (
      along(edge, 1).every((y) => Math.abs(y - 5) < 1e-6) &&
      along(edge, 2).every((z) => Math.abs(z - 5) < 1e-6) &&
      Math.max(...xs) - Math.min(...xs) > 60
    );
  })!;
  expect(corner).toBeDefined();
  return { document, bodyId: union.bodyId, corner };
}

/**
 * A 30 × 18 × 18 block imported from STEP: imported bodies are the ones a
 * complete rebuild proves planar face-pair distances for.
 */
async function importedBlock() {
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  const stepText = new TextDecoder().decode(
    io.exportStep(kernel.serializeSolid(kernel.makeBox(30, 18, 18)))
  );
  kernel.free();
  const imported = importStepBody(
    createProjectDocument('Block', toUserId('user_blend_preview'), 'mm'),
    {
      name: 'root',
      sourceName: 'block.step',
      artifactId: 'artifact_block',
      stepText
    }
  );
  const document = attachDerivedState(
    imported.document,
    await adapter.syncDocument(imported.document)
  );
  // The block's top edge along X.
  const corner = document.derived.bodyRepresentations[
    imported.bodyId
  ]!.topology!.edges.find((edge) => {
    const xs = along(edge, 0);
    return (
      along(edge, 1).every((y) => Math.abs(y) < 1e-6) &&
      along(edge, 2).every((z) => Math.abs(z - 18) < 1e-6) &&
      Math.max(...xs) - Math.min(...xs) > 29
    );
  })!;
  expect(corner).toBeDefined();
  return { document, bodyId: imported.bodyId, corner };
}

function fillet(
  base: ProjectDocument,
  bodyId: ProjectDocument['bodyOrder'][number],
  corner: EdgeTopology,
  size: number
) {
  return commandFactories.filletEdges({
    name: 'Fillet edges 1',
    targetBodyId: bodyId,
    edgeHashes: [corner.hash],
    edgeReferences: [corner.reference!],
    size
  });
}

describe('blend drag frames', () => {
  it('show the blend faces a complete rebuild makes, without its distance proofs', async () => {
    const { document, bodyId, corner } = await importedBlock();
    const command = fillet(document, bodyId, corner, 3);
    const candidate = command.apply(document);
    // The frame first: a complete rebuild of the same candidate would leave
    // its proofs in the measurement cache for the frame to reuse.
    const frame = await adapter.previewGeometry(candidate);
    const complete = await adapter.syncDocument(candidate);

    expect(frame.analysis).toBe('pending');
    expect(frame.topology).toBeUndefined();
    const hashes = (derived: Parameters<typeof newBlendFaceSelections>[1]) =>
      newBlendFaceSelections(document, derived)
        .map((face) => face.hash)
        .sort();
    expect(hashes(frame)).toEqual(hashes(complete));
    expect(hashes(frame).length).toBeGreaterThan(0);

    const resultBodyId = command.payload.ids!.bodyId;
    expect(
      complete.bodyRepresentations[resultBodyId]?.topology
        ?.opposingPlanarFacePairs?.length
    ).toBeGreaterThan(0);
    expect(
      frame.bodyRepresentations[resultBodyId]?.topology
        ?.opposingPlanarFacePairs
    ).toBeUndefined();
  }, 120_000);

  it('refuse an oversize radius in the same words as a complete rebuild', async () => {
    const { document, bodyId, corner } = await bracket();
    const command = fillet(document, bodyId, corner, 60);
    const candidate = command.apply(document);
    const target = newBlendValidationTarget(command)!;
    const verdict = (
      derived: Parameters<typeof offsetPreviewRejection>[0]['derived']
    ) =>
      offsetPreviewRejection({
        label: command.label,
        bodyId: target.resultBodyId,
        validationTargets: [target],
        derived,
        documentMoved: false
      });

    const frame = verdict(await adapter.previewGeometry(candidate));
    const complete = verdict(await adapter.syncDocument(candidate));
    expect(complete).not.toBeNull();
    expect(frame).toEqual(complete);
  }, 120_000);
});
