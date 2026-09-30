import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAllEdgesFilletProposal,
  createCadDocumentDigest,
  parseAllEdgesFilletRequest,
  parseCadPatchProposal,
  type CadSelectionContext
} from '@openzcad/ai-contracts';
import {
  addPrimitiveFeature,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';

const selection: CadSelectionContext = {
  bodyIds: [],
  featureIds: [],
  topologies: []
};

describe('whole-part fillet requests', () => {
  it.each([
    'Fillet all edges',
    'add a filet on all the edges',
    'Please add a fillet to all edges',
    'Could you round every edge?',
    'Fillet each edge',
    'round over all edges'
  ])('recognizes %s without a provider', (prompt) => {
    expect(parseAllEdgesFilletRequest(prompt)).toMatchObject({
      radius: null,
      target: null
    });
  });

  it.each([
    ['Add a 1.5mm fillet to all edges', 1.5, 'mm'],
    ['Fillet all edges with a 0.5 mm radius', 0.5, 'mm'],
    ['Round every edge by 0.1 inch', 0.1, 'inch'],
    ['Fillet all edges at radius 2', 2, undefined]
  ])('reads the radius in %s', (prompt, radius, unit) => {
    expect(parseAllEdgesFilletRequest(prompt)).toMatchObject({
      radius,
      unit
    });
  });

  it.each([
    "Don't fillet all edges",
    'Explain how to fillet all edges',
    'Fillet all outside edges',
    'Fillet all edges except the hole rims',
    'Fillet the selected edges',
    'Fillet all edges and drill a hole',
    'Add a 2 mm fillet to all edges by 1 mm'
  ])('leaves other instructions to the provider: %s', (prompt) => {
    expect(parseAllEdgesFilletRequest(prompt)).toBeNull();
  });
});

describe('whole-part exact fillet proposals', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  let box: ProjectDocument;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    box = addPrimitiveFeature(
      createProjectDocument('Block', toUserId('user_fillet')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 30, depth: 20 }
      }
    );
    box = { ...box, derived: await adapter.syncDocument(box) };
  });
  afterAll(() => adapter.dispose());

  it('rounds all twelve edges and eight corners, exports, and reimports', async () => {
    const result = createAllEdgesFilletProposal(
      box,
      selection,
      'Add a fillet on all edges'
    );
    expect(result?.error).toBeUndefined();
    const proposal = parseCadPatchProposal(result!.proposal);
    expect(proposal.operations[0]).toMatchObject({
      size: 2
    });
    expect(
      proposal.operations[0]!.kind === 'add_edge_modifier' &&
        proposal.operations[0].edgeHashes
    ).toHaveLength(12);
    const preview = await preflightCadPatch(box, proposal, (candidate) =>
      adapter.syncDocument(candidate)
    );
    expect(preview.candidate.derived.warnings).toEqual([]);
    const bodyId = preview.candidate.derived.exportableBodyIds[0]!;
    const rounded = preview.candidate.derived.bodyRepresentations[bodyId]!;
    expect(rounded.volume).toBeLessThan(40 * 30 * 20);
    const surfaces = rounded.topology!.faces.map(
      (face) => face.geometry?.surfaceType
    );
    expect(surfaces.filter((type) => type === 'cylinder')).toHaveLength(12);
    expect(surfaces.filter((type) => type === 'sphere')).toHaveLength(8);
    const step = await adapter.exportStep(preview.candidate, [bodyId]);
    const imported = importStepBody(
      createProjectDocument('Round trip', toUserId('user_fillet')),
      {
        name: 'Rounded block',
        artifactId: 'round-trip',
        sourceName: 'rounded.step',
        stepText: step
      }
    );
    const rebuilt = await adapter.syncDocument(imported.document);
    expect(rebuilt.warnings).toEqual([]);
    expect(rebuilt.bodyRepresentations[imported.bodyId]!.volume).toBeCloseTo(
      rounded.volume,
      5
    );
  });

  it('includes the entire local inventory even when the provider digest is truncated', () => {
    const bodyId = box.bodyOrder[0]!;
    const body = box.derived.bodyRepresentations[bodyId]!;
    const topology = body.topology!;
    const expanded = {
      ...box,
      derived: {
        ...box.derived,
        bodyRepresentations: {
          [bodyId]: {
            ...body,
            topology: {
              ...topology,
              edges: Array.from({ length: 96 }, (_, index) => ({
                ...topology.edges[0]!,
                topologyId: `edge:${index}`,
                hash: index + 1
              }))
            }
          }
        }
      }
    };
    expect(
      createCadDocumentDigest(expanded).bodies?.[0]?.topology
        ?.edgeInventoryComplete
    ).toBe(false);
    const proposal = createAllEdgesFilletProposal(
      expanded,
      selection,
      'Fillet all edges'
    )!.proposal!;
    const operation = proposal.operations[0]!;
    expect(
      operation.kind === 'add_edge_modifier' && operation.edgeHashes
    ).toHaveLength(96);
  });

  it('resolves one selected part or an explicit name, and refuses ambiguity', () => {
    const bodyId = box.bodyOrder[0]!;
    const body = box.derived.bodyRepresentations[bodyId]!;
    const anotherId = 'body_other' as typeof bodyId;
    const twoBodies = {
      ...box,
      derived: {
        ...box.derived,
        bodyRepresentations: {
          [bodyId]: body,
          [anotherId]: { ...body, bodyId: anotherId, name: 'Lid Body' }
        }
      }
    };
    expect(
      createAllEdgesFilletProposal(twoBodies, selection, 'Fillet all edges')
        ?.error
    ).toContain('Select one part');
    const selected = { ...selection, bodyIds: [anotherId] };
    expect(
      createAllEdgesFilletProposal(twoBodies, selected, 'Fillet all edges')
        ?.proposal?.operations[0]
    ).toMatchObject({ targetBodyId: anotherId });
    expect(
      createAllEdgesFilletProposal(
        twoBodies,
        selected,
        'Fillet all edges of Block'
      )?.proposal?.operations[0]
    ).toMatchObject({ targetBodyId: bodyId });
    expect(
      createAllEdgesFilletProposal(
        twoBodies,
        { ...selection, bodyIds: [bodyId, anotherId] },
        'Fillet all edges'
      )?.error
    ).toContain('Select one part');
  });

  it('excludes periodic seams and converts explicit length units', async () => {
    const cylinder = addPrimitiveFeature(
      createProjectDocument('Cylinder', toUserId('user_fillet'), 'cm'),
      {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 2, height: 4 }
      }
    );
    const built = {
      ...cylinder,
      derived: await adapter.syncDocument(cylinder)
    };
    const proposal = createAllEdgesFilletProposal(
      built,
      selection,
      'Fillet all edges by 1 mm'
    )!.proposal!;
    const operation = proposal.operations[0]!;
    expect(operation).toMatchObject({ size: 0.1 });
    expect(
      operation.kind === 'add_edge_modifier' && operation.edgeHashes
    ).toHaveLength(2);
  });

  it('rejects a nonpositive radius and a body without exact topology', () => {
    expect(
      createAllEdgesFilletProposal(box, selection, 'Fillet all edges by -1 mm')
        ?.error
    ).toContain('positive');
    const bodyId = box.bodyOrder[0]!;
    const body = box.derived.bodyRepresentations[bodyId]!;
    const mesh = {
      ...box,
      derived: {
        ...box.derived,
        bodyRepresentations: {
          [bodyId]: { ...body, topology: undefined }
        }
      }
    };
    expect(
      createAllEdgesFilletProposal(mesh, selection, 'Fillet all edges')?.error
    ).toContain('exact solid edges');
  });

  it('preserves an imported concave bracket when the kernel cannot join all its corners', async () => {
    const kernel = new RemusKernel();
    const io = await loadRemusTranslators();
    let step: string;
    try {
      const profile = kernel.makePolygon(
        new Float64Array([
          0, 0, 0, 40, 0, 0, 40, 8, 0, 8, 8, 0, 8, 50, 0, 0, 50, 0
        ])
      );
      const solid = kernel.extrude(profile, 0, 0, 1, 20);
      step = new TextDecoder().decode(
        io.exportStep(kernel.serializeSolids(Uint32Array.of(solid)))
      );
    } finally {
      kernel.free();
    }
    const imported = importStepBody(
      createProjectDocument('Bracket', toUserId('user_fillet')),
      {
        name: 'Bracket',
        artifactId: 'bracket',
        sourceName: 'bracket.step',
        stepText: step
      }
    );
    const base = {
      ...imported.document,
      derived: await adapter.syncDocument(imported.document)
    };
    const original = JSON.stringify(base);
    const result = createAllEdgesFilletProposal(
      base,
      selection,
      'Fillet all edges by 1 mm'
    );
    expect(result?.error).toBeUndefined();
    await expect(
      preflightCadPatch(base, result!.proposal!, (candidate) =>
        adapter.syncDocument(candidate)
      )
    ).rejects.toThrow(/corner|blend|fillet/i);
    expect(JSON.stringify(base)).toBe(original);
    expect((await adapter.syncDocument(base)).warnings).toEqual([]);
  });
});
