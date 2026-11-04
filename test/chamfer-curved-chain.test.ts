import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type ProjectDocument,
  type BodyId
} from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { buildDocumentHistory } from '../packages/kernel-adapter/src/exact-build-loop';
import {
  CURVED_CHAIN_LENGTH,
  ROUNDED_BLOCK_VOLUME,
  curvedChamferChain,
  curvedChainDocument,
  curvedChainVolume
} from './fixtures/curved-chamfer-chain';

function expectCarriers(
  body: Pick<BodyRepresentation, 'topology' | 'faceCount'>
) {
  expect(body.faceCount).toBe(10);
  expect(
    body.topology!.faces.filter((f) => f.geometry?.surfaceType === 'cylinder')
  ).toHaveLength(1);
  expect(
    body.topology!.faces.filter((f) => f.geometry?.surfaceType === 'cone')
  ).toHaveLength(1);
}

function expectStrict(document: ProjectDocument, id: BodyId, distance: number) {
  const kernel = new RemusKernel();
  try {
    const solids = buildDocumentHistory(kernel, document).shapes.get(
      id
    )?.solids;
    expect(solids).toHaveLength(1);
    expect(kernel.validateSolid(solids![0]!)).toBe(0);
    // These trimmed curved faces use numerical volume quadrature. This probe
    // retains the sampling cap and checks the independent integral to 0.0005
    // mm³ at 1e-5 mm deflection, rather than assuming display quantities exact.
    expect(kernel.volume(solids![0]!, 1e-5)).toBeCloseTo(
      curvedChainVolume(distance),
      3
    );
    return kernel.volume(solids![0]!, 0.01);
  } finally {
    kernel.free();
  }
}

describe(
  'a chamfer across a complete straight–curved–straight chain',
  { timeout: 120_000 },
  () => {
    let adapter: ExactKernelAdapter;
    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });
    afterAll(() => adapter.dispose());

    it.each([1, 0.5, 0.1])(
      'preserves the R3 round through preview, Apply, replay and STEP at C%s',
      async (distance) => {
        const model = await curvedChainDocument(adapter);
        const source = JSON.stringify(model.document);
        const before = await adapter.syncDocument(model.document);
        expect(before.warnings).toEqual([]);
        const body = before.bodyRepresentations[model.bodyId]!;
        expect(body.volume).toBeCloseTo(ROUNDED_BLOCK_VOLUME, 6);
        const edges = curvedChamferChain(body);
        expect(edges).toHaveLength(3);
        expect(edges.map((e) => e.curve?.type).sort()).toEqual([
          'CIRCLE',
          'LINE',
          'LINE'
        ]);
        expect(edges.reduce((sum, e) => sum + e.length!, 0)).toBeCloseTo(
          CURVED_CHAIN_LENGTH,
          7
        );
        const manager = new CommandManager({
          ...model.document,
          derived: before
        });
        const command = commandFactories.chamferEdges({
          name: 'Complete curved-edge chamfer',
          targetBodyId: model.bodyId,
          edgeHashes: edges.map((e) => e.hash),
          edgeReferences: edges.map((e) => e.reference!),
          size: distance
        });
        const candidate = command.apply(manager.document);
        const id = candidate.bodyOrder.at(-1)!;
        const preview = await adapter.previewGeometry(candidate);
        expect(preview.warnings).toEqual([]);
        expect(preview.analysis).toBe('pending');
        expectCarriers(preview.bodyRepresentations[id]!);
        manager.execute(command);
        const committed = await adapter.syncDocument(manager.document);
        expect(committed.warnings).toEqual([]);
        const chamfered = committed.bodyRepresentations[id]!;
        expectCarriers(chamfered);
        expect(chamfered.mesh).toEqual(preview.bodyRepresentations[id]!.mesh);
        expect(chamfered.volume).toBeCloseTo(
          expectStrict(manager.document, id, distance),
          6
        );
        const cone = chamfered.topology!.faces.find(
          (f) => f.geometry?.surfaceType === 'cone'
        )!.geometry!;
        expect(cone.halfAngle).toBeCloseTo(Math.PI / 4, 12);
        manager.undo();
        const undone = await adapter.syncDocument(manager.document);
        expect(undone.warnings).toEqual([]);
        expect(undone.bodyRepresentations[model.bodyId]!.volume).toBeCloseTo(
          ROUNDED_BLOCK_VOLUME,
          6
        );
        manager.redo();
        const fresh = await createExactKernelAdapter();
        try {
          const reopened = JSON.parse(
            JSON.stringify(manager.document)
          ) as ProjectDocument;
          const replay = await fresh.syncDocument(reopened);
          expect(replay.warnings).toEqual([]);
          expect(replay.bodyRepresentations[id]!.volume).toBeCloseTo(
            chamfered.volume,
            6
          );
          expectCarriers(replay.bodyRepresentations[id]!);
          const step = await fresh.exportStep(reopened, [id]);
          expect(step.match(/CYLINDRICAL_SURFACE/g)).toHaveLength(1);
          expect(step.match(/CONICAL_SURFACE/g)).toHaveLength(1);
          const imported = importStepBody(
            createProjectDocument('Round trip', toUserId('user_chain')),
            {
              name: 'Curved-edge chamfer',
              artifactId: 'curved-chain-step',
              sourceName: 'curved-chain.step',
              stepText: step
            }
          );
          const roundTrip = await fresh.syncDocument(imported.document);
          expect(roundTrip.warnings).toEqual([]);
          expectStrict(imported.document, imported.bodyId, distance);
        } finally {
          fresh.dispose();
        }
        expect(JSON.stringify(model.document)).toBe(source);
      }
    );
  }
);
