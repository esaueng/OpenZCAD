import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCadDocumentDigest,
  createEditCandidateCatalog,
  expandEditCandidateProposal,
  parseCadPatchProposal,
  proposalForEditCandidate,
  type CadSelectionContext
} from '@openzcad/ai-contracts';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  importStepBody,
  listParameters
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { drillHole } from '../packages/kernel-adapter/src/exact-cylinder-ops';
import { translated } from './support/synthetic-holder';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';

const none: CadSelectionContext = {
  bodyIds: [],
  featureIds: [],
  topologies: []
};
let adapter: ExactKernelAdapter;

beforeAll(async () => {
  await loadRemusTranslators();
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

async function importedPart(
  dense = false,
  embossed = false
): Promise<ProjectDocument> {
  const kernel = new RemusKernel();
  try {
    let solid = kernel.makeBox(100, 100, 6);
    if (embossed)
      for (const x of [10, 50])
        solid = kernel.fuse(
          solid,
          translated(kernel, kernel.makeBox(5, 10, 0.4), x, 10, 6)
        );
    if (dense)
      for (let x = 0; x < 7; x++)
        for (let y = 0; y < 10; y++) {
          solid = drillHole(kernel, solid, {
            surfacePoint: { x: 10 + x * 12, y: 5 + y * 9, z: 6 },
            axis: { x: 0, y: 0, z: -1 },
            radius: 0.5,
            depth: 6,
            entryExtension: 0.01,
            exitExtension: 0.01,
            style: 'simple'
          });
        }
    const stepText = new TextDecoder().decode(
      remusTranslators().exportStep(
        kernel.serializeSolids(Uint32Array.of(solid))
      )
    );
    const { document } = importStepBody(
      createProjectDocument('Imported plate', toUserId('test_user')),
      {
        name: 'Plate',
        artifactId: 'test_plate',
        sourceName: 'plate.step',
        stepText
      }
    );
    document.derived = await adapter.syncDocument(document);
    expect(document.derived.warnings).toEqual([]);
    return document;
  } finally {
    kernel.free();
  }
}

describe('general measured edit candidates', () => {
  it('creates raised-feature visibility on a plain embossed plate without a holder recipe', async () => {
    const document = await importedPart(false, true);
    const bodyId = document.bodyOrder[0]!;
    const before = document.derived.bodyRepresentations[bodyId]!;
    const analysis = { bodyId: String(bodyId), faceHashes: [] };
    const analyzed = {
      ...document,
      derived: await adapter.syncDocument(
        document,
        undefined,
        undefined,
        analysis
      )
    };
    expect(
      analyzed.derived.bodyRepresentations[bodyId]!.topology
        ?.recognizedPlanarEmboss?.capFaceHashes
    ).toHaveLength(2);
    const catalog = createEditCandidateCatalog(analyzed, none);
    const candidate = catalog.candidates.find((item) =>
      item.parameters.some((parameter) => parameter.key === 'show_details')
    )!;
    expect(candidate).toBeDefined();
    const proposal = proposalForEditCandidate(candidate);
    const operation = proposal.operations[0]!;
    if (operation.kind !== 'use_edit_candidate')
      throw new Error('Expected candidate');
    operation.parameterNames = [{ key: 'show_details', name: 'show_text' }];
    const preflight = await preflightCadPatch(
      document,
      proposal,
      (doc, selected) =>
        adapter.syncDocument(doc, undefined, undefined, selected)
    );
    expect(preflight.targets).toHaveLength(1);
    expect(preflight.candidate.derived.warnings).toEqual([]);
    const volumes = Object.values(
      preflight.candidate.derived.bodyRepresentations
    )
      .filter((body) => !body.consumed)
      .map((body) => body.volume);
    expect(volumes).toHaveLength(2);
    expect(volumes.reduce((sum, volume) => sum + volume, 0)).toBeCloseTo(
      before.volume,
      5
    );
    const manager = new CommandManager(document);
    manager.runTransaction('Show raised details', preflight.commands);
    manager.execute(
      commandFactories.setParameter({ name: 'show_text', expression: '0' })
    );
    manager.document.derived = await adapter.syncDocument(manager.document);
    expect(manager.document.derived.exportableBodyIds).toEqual([bodyId]);
    manager.execute(
      commandFactories.setParameter({ name: 'show_text', expression: '1' })
    );
    manager.document.derived = await adapter.syncDocument(manager.document);
    expect(manager.document.derived.exportableBodyIds).toHaveLength(2);
    expect(manager.document.derived.warnings).toEqual([]);
  });
  it('uses the same exact binding for chat and the UI, with a user-chosen name', async () => {
    const document = await importedPart();
    const catalog = createEditCandidateCatalog(document, none);
    const candidate = catalog.candidates.find((item) =>
      item.parameters.some((parameter) => Number(parameter.value) === 6)
    )!;
    expect(candidate).toBeDefined();
    const direct = proposalForEditCandidate(candidate);
    const chat = structuredClone(direct);
    const operation = chat.operations[0]!;
    if (operation.kind !== 'use_edit_candidate')
      throw new Error('Expected a measured candidate');
    operation.parameterNames = [
      { key: candidate.parameters[0]!.key, name: 'wall_thickness' }
    ];
    parseCadPatchProposal(chat, createCadDocumentDigest(document));
    const expanded = expandEditCandidateProposal(document, chat);
    expect(expanded.operations[0]).toMatchObject({
      kind: 'set_parameter',
      name: 'wall_thickness',
      expression: '6'
    });
    const baseline = await preflightCadPatch(document, direct, (doc) =>
      adapter.syncDocument(doc)
    );
    const named = await preflightCadPatch(document, chat, (doc) =>
      adapter.syncDocument(doc)
    );
    const bodyId = document.bodyOrder[0]!;
    expect(named.candidate.derived.bodyRepresentations[bodyId]!.mesh).toEqual(
      baseline.candidate.derived.bodyRepresentations[bodyId]!.mesh
    );
    expect(named.candidate.derived.bodyRepresentations[bodyId]!.volume).toBe(
      document.derived.bodyRepresentations[bodyId]!.volume
    );
    for (const thickness of [5, 7]) {
      const manager = new CommandManager(named.candidate);
      manager.execute(
        commandFactories.setParameter({
          name: 'wall_thickness',
          expression: String(thickness)
        })
      );
      manager.document.derived = await adapter.syncDocument(manager.document);
      expect(manager.document.derived.warnings).toEqual([]);
      expect(
        manager.document.derived.bodyRepresentations[bodyId]!.volume
      ).toBeCloseTo(100 * 100 * thickness, 5);
      const step = await adapter.exportStep(manager.document, [bodyId]);
      expect(step).toContain('ISO-10303-21');
      const reimported = importStepBody(
        createProjectDocument('Round trip', toUserId('test_user')),
        {
          name: 'Round trip',
          artifactId: `roundtrip_${thickness}`,
          sourceName: 'roundtrip.step',
          stepText: step
        }
      ).document;
      reimported.derived = await adapter.syncDocument(reimported);
      expect(reimported.derived.warnings).toEqual([]);
      expect(
        reimported.derived.bodyRepresentations[reimported.bodyOrder[0]!]!.volume
      ).toBeCloseTo(100 * 100 * thickness, 5);
    }
  });

  it('rejects stale candidates, invented names, duplicates, and mixed mutations', async () => {
    const document = await importedPart();
    const candidate = createEditCandidateCatalog(document, none).candidates[0]!;
    const proposal = proposalForEditCandidate(candidate);
    expect(() =>
      expandEditCandidateProposal(
        { ...document, version: document.version + 1 },
        proposal
      )
    ).toThrow('stale');
    const invalid = structuredClone(proposal);
    const operation = invalid.operations[0]!;
    if (operation.kind !== 'use_edit_candidate')
      throw new Error('Expected candidate');
    operation.parameterNames = [{ key: 'invented', name: 'my_dimension' }];
    expect(() =>
      parseCadPatchProposal(invalid, createCadDocumentDigest(document))
    ).toThrow('current document analysis');
    expect(() => expandEditCandidateProposal(document, invalid)).toThrow(
      'Invalid measured parameter'
    );
    expect(() =>
      expandEditCandidateProposal(document, {
        ...proposal,
        operations: [...proposal.operations, ...proposal.operations]
      })
    ).toThrow('twice');
    expect(() =>
      expandEditCandidateProposal(document, {
        ...proposal,
        operations: [
          ...proposal.operations,
          { kind: 'set_parameter', name: 'extra', expression: '3' }
        ]
      })
    ).toThrow('separately');
  });

  it('analyzes a selected pair above the background face limit and re-proves it before binding', async () => {
    const document = await importedPart(true);
    const bodyId = document.bodyOrder[0]!;
    const before = document.derived.bodyRepresentations[bodyId]!;
    expect(before.faceCount).toBeGreaterThan(64);
    expect(before.topology?.opposingPlanarFacePairs ?? []).toEqual([]);
    const endpoints = before.topology!.faces.filter(
      (face) => Math.abs(face.geometry?.normal?.x ?? 0) > 0.99
    );
    expect(endpoints).toHaveLength(2);
    const analysis = {
      bodyId: String(bodyId),
      faceHashes: endpoints.map((face) => face.hash)
    };
    const derived = await adapter.syncDocument(
      document,
      undefined,
      undefined,
      analysis
    );
    expect(
      derived.bodyRepresentations[bodyId]!.topology?.opposingPlanarFacePairs
    ).toHaveLength(1);
    expect(derived.bodyRepresentations[bodyId]!.mesh).toEqual(before.mesh);
    const analyzed = { ...document, derived };
    const candidate = createEditCandidateCatalog(analyzed, {
      ...none,
      bodyIds: [bodyId]
    }).candidates.find((item) =>
      item.parameters.some((parameter) => Number(parameter.value) === 100)
    )!;
    expect(candidate).toBeDefined();
    expect(candidate.analysis).toEqual(analysis);
    const proposal = proposalForEditCandidate(candidate);
    parseCadPatchProposal(proposal, createCadDocumentDigest(analyzed));
    const requests: unknown[] = [];
    const preflight = await preflightCadPatch(
      document,
      proposal,
      (doc, selected) => {
        if (selected) requests.push(selected);
        return adapter.syncDocument(doc, undefined, undefined, selected);
      }
    );
    expect(requests).toEqual([analysis]);
    expect(listParameters(preflight.candidate)).toHaveLength(1);
    expect(preflight.candidate.derived.warnings).toEqual([]);
    expect(
      preflight.candidate.derived.bodyRepresentations[bodyId]!.volume
    ).toBe(before.volume);
  }, 120_000);
});
