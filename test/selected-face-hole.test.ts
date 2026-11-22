import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCadDocumentDigest,
  createSelectedFaceHoleProposal,
  parseCadPatchProposal,
  parseSelectedFaceHoleRequest,
  type CadPatchOperation,
  type CadPatchProposal,
  type CadSelectionContext
} from '@openzcad/ai-contracts';
import {
  CommandManager,
  commandsForCadPatch,
  type AnyCommand
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';
import {
  buildModelingOperationSubmission,
  modelingFaceOptions,
  type HoleFormState
} from '../apps/web/src/lib/modelingOperations';

type HoleOperation = Extract<CadPatchOperation, { kind: 'add_hole' }>;

describe('selected-face hole requests', () => {
  it.each([
    ['Drill a hole', null, null, null],
    ['drill a 6 mm hole in the selected face', 6, 'mm', null],
    ['Please drill a 5mm through hole.', 5, 'mm', 'through'],
    ['Could you add a 0.25 inch hole through all?', 0.25, 'inch', 'through'],
    ['Drill a 4 mm diameter hole 8 mm deep', 4, 'mm', 'blind'],
    ['make a blind hole in this face', null, null, 'blind'],
    ['Drill a hole through the selected face', null, null, null]
  ])('recognizes %s without a provider', (prompt, diameter, unit, mode) => {
    expect(parseSelectedFaceHoleRequest(prompt)).toMatchObject({
      diameter,
      diameterUnit: unit ?? undefined,
      depthMode: mode
    });
  });

  it.each([
    "Don't drill a hole",
    'Explain how to drill a hole',
    'Drill a hole in the top face',
    'Drill two holes',
    'Drill a counterbored hole',
    'Drill a 6 mm hole and fillet all edges',
    'Drill a through hole 5 mm deep',
    'Drill a blind hole through all',
    'Drill a 6 mm hole at 10, 5'
  ])('leaves other instructions to the provider: %s', (prompt) => {
    expect(parseSelectedFaceHoleRequest(prompt)).toBeNull();
  });
});

describe('selected-face exact hole proposals', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  let box: ProjectDocument;
  let bodyId: BodyId;
  let top: FaceTopology;
  let side: FaceTopology;
  const derive = (candidate: ProjectDocument) =>
    adapter.syncDocument(candidate);
  const faceSelection = (face: FaceTopology): CadSelectionContext => ({
    bodyIds: [],
    featureIds: [],
    topologies: [
      {
        bodyId,
        kind: 'face',
        topologyId: face.topologyId,
        hash: face.hash,
        ...(face.reference ? { reference: face.reference } : {})
      }
    ]
  });
  const proposalFor = (prompt: string, face: FaceTopology = top) => {
    const result = createSelectedFaceHoleProposal(
      box,
      faceSelection(face),
      prompt
    );
    expect(result?.error).toBeUndefined();
    return parseCadPatchProposal(structuredClone(result!.proposal));
  };
  const withHole = (
    proposal: CadPatchProposal,
    patch: Partial<HoleOperation>
  ): CadPatchProposal => ({
    ...proposal,
    operations: [{ ...(proposal.operations[0] as HoleOperation), ...patch }]
  });

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    box = addPrimitiveFeature(
      createProjectDocument('Block', toUserId('user_hole')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 30, depth: 20 }
      }
    );
    box = { ...box, derived: await adapter.syncDocument(box) };
    bodyId = box.bodyOrder[0]!;
    const faces = box.derived.bodyRepresentations[bodyId]!.topology!.faces;
    const planar = faces.filter(
      (face) => face.geometry?.surfaceType === 'plane' && face.geometry.normal
    );
    top = planar.reduce((best, face) =>
      face.geometry!.normal!.z > best.geometry!.normal!.z ? face : best
    );
    expect(top.geometry!.normal!.z).toBeCloseTo(1, 9);
    side = planar.find((face) => face !== top)!;
  });
  afterAll(() => adapter.dispose());

  it('drills through the manual Hole command with the Hole tool payload', async () => {
    const proposal = proposalFor('Drill a 6 mm through hole');
    expect(proposal.operations).toEqual([
      expect.objectContaining({
        kind: 'add_hole',
        targetBodyId: bodyId,
        faceHash: top.hash,
        faceReference: top.reference,
        diameter: 6,
        depthMode: 'through',
        depth: null,
        position: { u: 0, v: 0 }
      })
    ]);
    const preview = await preflightCadPatch(box, proposal, derive);
    expect(preview.commands.map((command) => command.kind)).toEqual([
      'feature.hole'
    ]);
    expect(preview.candidate.derived.warnings).toEqual([]);

    // The payload the Hole card builds for the same face and values.
    const body = box.derived.bodyRepresentations[bodyId]!;
    const form: HoleFormState = {
      name: 'Hole',
      targetBodyId: bodyId,
      faceHash: top.hash,
      style: 'simple',
      diameter: '6',
      depthMode: 'through',
      depth: '10',
      counterboreDiameter: '10.8',
      counterboreDepth: '3',
      countersinkDiameter: '12',
      countersinkAngleDeg: '90',
      position: { u: '0', v: '0' }
    };
    const manual = buildModelingOperationSubmission(
      { operation: 'hole', value: form },
      modelingFaceOptions(body.topology, body)
    );
    const strip = (payload: unknown) => {
      const {
        ids: _ids,
        name: _name,
        ...rest
      } = payload as Record<string, unknown>;
      return rest;
    };
    expect(strip(preview.commands[0]!.payload)).toEqual(strip(manual.input));

    const [resultId] = preview.candidate.derived.exportableBodyIds;
    const drilled = preview.candidate.derived.bodyRepresentations[resultId!]!;
    expect(drilled.volume).toBeCloseTo(40 * 30 * 20 - Math.PI * 9 * 20, 3);
  });

  it('drills a blind hole to the asked depth in document units', async () => {
    const preview = await preflightCadPatch(
      box,
      proposalFor('Drill a 0.4 cm hole 5 mm deep'),
      derive
    );
    const [resultId] = preview.candidate.derived.exportableBodyIds;
    const drilled = preview.candidate.derived.bodyRepresentations[resultId!]!;
    const removed = 40 * 30 * 20 - drilled.volume;
    // A flat-bottomed 4 mm bore, 5 mm deep.
    expect(removed).toBeCloseTo(Math.PI * 4 * 5, 3);
  });

  it("offsets the hole along the Hole tool's own face frame, not attachmentFrame", async () => {
    // On a +Z face the Hole tool's u axis is (world X) × n = −Y and its v
    // axis is n × u = +X; the digest's attachmentFrame puts u on +X instead.
    const proposal = withHole(proposalFor('Drill a 4 mm hole 5 mm deep'), {
      position: { u: 5, v: 2 }
    });
    const preview = await preflightCadPatch(box, proposal, derive);
    const [resultId] = preview.candidate.derived.exportableBodyIds;
    const bore = preview.candidate.derived.bodyRepresentations[
      resultId!
    ]!.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    const axis = bore.geometry!.axisStart!;
    const anchor = top.geometry!.outerCentroid!;
    expect(axis.x).toBeCloseTo(anchor.x + 2, 6);
    expect(axis.y).toBeCloseTo(anchor.y - 5, 6);
  });

  it('applies as one transaction that one undo reverts', async () => {
    const preview = await preflightCadPatch(
      box,
      proposalFor('Drill a hole'),
      derive
    );
    const manager = new CommandManager(box);
    manager.runTransaction('Apply AI patch', preview.commands);
    expect(manager.document.featureOrder).toHaveLength(
      box.featureOrder.length + 1
    );
    manager.undo();
    expect(manager.document.featureOrder).toEqual(box.featureOrder);
    expect(manager.document.bodyOrder).toEqual(box.bodyOrder);
    expect(manager.canUndoIn(false)).toBe(false);
  });

  it("refuses with the manual command's own reason and changes nothing", async () => {
    const before = structuredClone(box);
    const proposal = proposalFor('Drill a hole 5 mm deep');
    await expect(
      preflightCadPatch(box, withHole(proposal, { diameter: -2 }), derive)
    ).rejects.toThrow('Hole diameter must resolve to a positive value.');
    await expect(
      preflightCadPatch(box, withHole(proposal, { depth: 0 }), derive)
    ).rejects.toThrow('Hole depth must resolve to a positive value.');
    await expect(
      preflightCadPatch(
        box,
        withHole(proposal, { diameter: 'missing_size' }),
        derive
      )
    ).rejects.toThrow(/missing_size/);
    expect(box).toEqual(before);
  });

  it('refuses ambiguous, curved and missing face selections before any preflight', () => {
    const none = { bodyIds: [bodyId], featureIds: [], topologies: [] };
    expect(createSelectedFaceHoleProposal(box, none, 'Drill a hole')).toEqual({
      error: 'Select the one flat face to drill, then ask again.'
    });
    const both = {
      ...faceSelection(top),
      topologies: [
        ...faceSelection(top).topologies,
        ...faceSelection(side).topologies
      ]
    };
    expect(createSelectedFaceHoleProposal(box, both, 'Drill a hole')).toEqual({
      error: 'Select the one flat face to drill, then ask again.'
    });
    const curved = {
      ...box,
      derived: {
        ...box.derived,
        bodyRepresentations: {
          [bodyId]: {
            ...box.derived.bodyRepresentations[bodyId]!,
            topology: {
              ...box.derived.bodyRepresentations[bodyId]!.topology!,
              faces: [
                {
                  ...top,
                  geometry: { ...top.geometry!, surfaceType: 'cylinder' }
                }
              ]
            }
          }
        }
      }
    } as ProjectDocument;
    expect(
      createSelectedFaceHoleProposal(curved, faceSelection(top), 'Drill a hole')
        ?.error
    ).toContain('only flat faces');
    expect(
      createSelectedFaceHoleProposal(
        box,
        faceSelection(top),
        'Drill a 0 mm hole'
      )?.error
    ).toContain('positive');
    expect(
      createSelectedFaceHoleProposal(box, faceSelection(top), 'Explain holes')
    ).toBeNull();
  });

  it('holds a provider add_hole to a current planar digest face', () => {
    const digest = createCadDocumentDigest(box, faceSelection(top));
    const proposal = proposalFor('Drill a hole');
    expect(parseCadPatchProposal(proposal, digest).operations).toHaveLength(1);
    expect(() =>
      parseCadPatchProposal(
        withHole(proposal, {
          faceReference: { ...top.reference!, lineageName: 'stale' }
        }),
        digest
      )
    ).toThrow(/stale or unavailable face reference/);
    const curvedDigest = structuredClone(digest);
    for (const face of curvedDigest.bodies!.flatMap(
      (body) => body.topology?.faces ?? []
    )) {
      if (face.snapshot) face.snapshot.surfaceType = 'cylinder';
    }
    expect(() => parseCadPatchProposal(proposal, curvedDigest)).toThrow(
      /planar digest face/
    );
    expect(() =>
      parseCadPatchProposal(
        withHole(proposal, { depthMode: 'blind', depth: 4 })
      )
    ).not.toThrow();
    // A through hole carries no depth; a blind one needs one.
    expect(() =>
      parseCadPatchProposal(
        withHole(proposal, { depthMode: 'through', depth: 4 })
      )
    ).toThrow('Invalid add_hole operation.');
    expect(() =>
      parseCadPatchProposal(
        withHole(proposal, { depthMode: 'blind', depth: null })
      )
    ).toThrow('Invalid add_hole operation.');
    // Topology on a body this same proposal creates does not exist yet.
    expect(() =>
      parseCadPatchProposal({
        ...proposal,
        operations: [
          {
            kind: 'add_primitive',
            name: 'Block 2',
            localId: 'block',
            primitiveKind: 'box',
            dimensions: { width: 1, height: 1, depth: 1 }
          },
          {
            ...(proposal.operations[0] as HoleOperation),
            targetBodyId: '$block'
          }
        ]
      })
    ).toThrow(/same proposal/);
  });

  it('maps through commandsForCadPatch to exactly one feature.hole command', () => {
    const commands: AnyCommand[] = commandsForCadPatch(
      box,
      proposalFor('Drill a hole')
    );
    expect(commands.map((command) => command.kind)).toEqual(['feature.hole']);
    // M01 (schema v150): measured from the face's outer boundary, as the
    // manual Hole tool measures a new hole.
    expect(commands[0]!.payload).toMatchObject({
      positionAnchor: 'outer-centroid',
      style: 'simple',
      depthMode: 'through'
    });
  });
});
