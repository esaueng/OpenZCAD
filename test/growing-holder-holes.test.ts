import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCadDocumentDigest,
  createGrowingHolderProposal,
  parseCadPatchProposal,
  validateCadPatchProposalAgainstDigest
} from '@openzcad/ai-contracts';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  createGrowingHolderHoleProposal,
  growingHolderHistories,
  growingHolderHoleControls,
  matchGrowingHolderHoles
} from '@openzcad/command-system';
import { createProjectDocument, setParameter } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toBodyId, toUserId, type ProjectDocument } from '@openzcad/shared';
import { describeOperation } from '../apps/web/src/lib/assistant/describe';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { syntheticHolderSolid } from './support/synthetic-holder';

const selectionOf = (bodyIds: string[] = []) => ({
  featureIds: [],
  bodyIds,
  topologies: []
});

const holeDiameters = (document: ProjectDocument, bodyId: string) =>
  (document.derived.bodyRepresentations[toBodyId(bodyId)]?.topology?.faces ?? [])
    .filter((face) => face.geometry?.featureType === 'through-hole')
    .map((face) => ({
      diameter: face.geometry!.diameter!,
      x: face.geometry!.axisStart!.x
    }))
    .sort((a, b) => a.x - b.x);

describe('growing-holder mounting-hole control', { timeout: 300_000 }, () => {
  let adapter: ExactKernelAdapter;
  /** The bracket with plain bores and its opening already parameterized. */
  let holder: ProjectDocument;
  /** The same bracket with countersunk bores. */
  let countersunk: ProjectDocument;
  let holderBodyId: string;

  async function grownHolder(countersink: boolean): Promise<ProjectDocument> {
    const kernel = new RemusKernel();
    const stepText = new TextDecoder().decode(
      remusTranslators().exportStep(
        kernel.serializeSolids(
          Uint32Array.of(syntheticHolderSolid(kernel, { countersink }))
        )
      )
    );
    kernel.free();
    const manager = new CommandManager(
      createProjectDocument('Bracket', toUserId('user_bracket'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Bracket',
        artifactId: 'bracket',
        sourceName: 'bracket.step',
        stepText
      })
    );
    const imported = {
      ...manager.document,
      derived: await adapter.syncDocument(manager.document)
    };
    const opening = createGrowingHolderProposal(imported, selectionOf())!;
    const applied = new CommandManager(imported);
    applied.runTransaction(
      'Apply opening',
      commandsForCadPatch(imported, opening)
    );
    return {
      ...applied.document,
      derived: await adapter.syncDocument(applied.document)
    };
  }

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    await loadRemusTranslators();
    holder = await grownHolder(false);
    countersunk = await grownHolder(true);
    holderBodyId = holder.derived.exportableBodyIds[0]!;
  }, 300_000);
  afterAll(() => {
    adapter.dispose();
  });

  it('measures the two mirrored bores on the carved ends', () => {
    const history = growingHolderHistories(holder)[0]!;
    const match = matchGrowingHolderHoles(holder, history);
    expect(match.status).toBe('matched');
    if (match.status !== 'matched') return;
    expect(match.pair.diameter).toBe(5);
    // Measured on the import references, which never move.
    expect(match.pair.negative.bodyId).toBe(history.pieceSources.negativeEnd);
    expect(match.pair.positive.bodyId).toBe(history.pieceSources.positiveEnd);
    expect(match.pair.negative.bodyId).toBe(holder.bodyOrder[0]);
    expect(match.pair.negative.sourceAxisStart.x).toBe(4);
    expect(match.pair.positive.sourceAxisStart.x).toBe(56);
  });

  it('drives both bores by one parameter at every opening', async () => {
    const proposal = createGrowingHolderHoleProposal(holder, selectionOf());
    expect(proposal).not.toBeNull();
    expect(proposal!.summary).toContain('two 5 mm mounting bores');
    expect(describeOperation(proposal!.operations[0]!)).toContain(
      'drive both 5 mounting bores'
    );
    const digest = createCadDocumentDigest(holder, selectionOf());
    const parsed = validateCadPatchProposalAgainstDigest(
      parseCadPatchProposal(structuredClone(proposal), digest),
      digest
    );
    const preflight = await preflightCadPatch(holder, parsed, (candidate) =>
      adapter.syncDocument(candidate)
    );
    expect(preflight.candidate.derived.warnings).toEqual([]);
    const history = growingHolderHistories(preflight.candidate)[0]!;
    const controls = growingHolderHoleControls(preflight.candidate, history);
    expect(controls).toHaveLength(2);
    // Each resize sits right before its side's base piece is carved.
    const order = preflight.candidate.featureOrder;
    const at = (featureId: string) => order.indexOf(featureId as never);
    expect(at(controls[0]!.featureId)).toBe(at(history.negativeEnd.featureId) - 1);
    expect(at(controls[1]!.featureId)).toBe(at(history.positiveEnd.featureId) - 1);
    // A second offer is withheld once the control exists.
    expect(createGrowingHolderHoleProposal(preflight.candidate, selectionOf())).toBeNull();

    for (const [width, diameter] of [
      [44, 6],
      [60, 6],
      [30, 4],
      [60, 5]
    ] as const) {
      const document = setParameter(
        setParameter(preflight.candidate, {
          name: 'hole_diameter',
          expression: String(diameter)
        }),
        { name: 'opening_width', expression: String(width) }
      );
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings, `width ${width} hole ${diameter}`).toEqual([]);
      const bodyId = derived.exportableBodyIds[0]!;
      const holes = holeDiameters({ ...document, derived }, bodyId);
      expect(holes.map((h) => h.diameter)).toEqual([diameter, diameter]);
      expect(holes[0]!.x).toBeCloseTo(30 - width / 2 - 4, 6);
      expect(holes[1]!.x).toBeCloseTo(30 + width / 2 + 4, 6);
    }
  });

  it('shrinks countersunk bores and refuses to widen ones the kernel cannot cut', async () => {
    // This bracket's countersinks break out of the 8 mm arm; the kernel
    // refuses the widening cut even when it runs through the whole arm.
    // (The hammer's countersinks sit inside its base and widen fine; see the
    // opt-in test.) Shrinking adds a ring inside the bore and always works.
    const proposal = createGrowingHolderHoleProposal(countersunk, selectionOf());
    expect(proposal).not.toBeNull();
    const preflight = await preflightCadPatch(countersunk, proposal!, (candidate) =>
      adapter.syncDocument(candidate)
    );
    expect(preflight.candidate.derived.warnings).toEqual([]);
    const shrunk = await adapter.syncDocument(
      setParameter(preflight.candidate, { name: 'hole_diameter', expression: '4' })
    );
    expect(shrunk.warnings).toEqual([]);
    expect(
      holeDiameters(
        { ...preflight.candidate, derived: shrunk },
        shrunk.exportableBodyIds[0]!
      ).map((h) => h.diameter)
    ).toEqual([4, 4]);
    const widened = await adapter.syncDocument(
      setParameter(preflight.candidate, { name: 'hole_diameter', expression: '6' })
    );
    expect(widened.warnings).toHaveLength(2);
    expect(widened.warnings[0]).toMatch(/does not fit this body/);
  });

  it('binds at any opening, not only the source width', async () => {
    // The browser failure: a proposal made after the opening was edited.
    const grown = setParameter(holder, { name: 'opening_width', expression: '60' });
    const document = { ...grown, derived: await adapter.syncDocument(grown) };
    const proposal = createGrowingHolderHoleProposal(document, selectionOf());
    expect(proposal).not.toBeNull();
    const preflight = await preflightCadPatch(document, proposal!, (candidate) =>
      adapter.syncDocument(candidate)
    );
    expect(preflight.candidate.derived.warnings).toEqual([]);
    const widened = await adapter.syncDocument(
      setParameter(preflight.candidate, { name: 'hole_diameter', expression: '6' })
    );
    expect(widened.warnings).toEqual([]);
    const holes = holeDiameters(
      { ...preflight.candidate, derived: widened },
      widened.exportableBodyIds[0]!
    );
    expect(holes.map((h) => h.diameter)).toEqual([6, 6]);
    expect(holes[0]!.x).toBeCloseTo(30 - 30 - 4, 6);
    expect(holes[1]!.x).toBeCloseTo(30 + 30 + 4, 6);
  });

  it('refuses bores the document did not measure', () => {
    const proposal = createGrowingHolderHoleProposal(holder, selectionOf())!;
    const operation = proposal.operations[0]!;
    if (operation.kind !== 'add_growing_holder_hole_control') throw new Error('kind');
    const edited = {
      ...proposal,
      operations: [
        {
          ...operation,
          holes: [
            { ...operation.holes[0]!, sourceDiameter: 5.5 },
            operation.holes[1]!
          ]
        }
      ]
    };
    expect(() => commandsForCadPatch(holder, edited)).toThrow(
      /do not exactly match the bores measured/
    );
    const digest = createCadDocumentDigest(holder, selectionOf());
    expect(() =>
      validateCadPatchProposalAgainstDigest(
        parseCadPatchProposal(
          {
            ...proposal,
            operations: [{ ...operation, targetBodyId: 'body_missing' }]
          },
          digest
        ),
        digest
      )
    ).toThrow(/not live in the current document digest/);
    expect(holderBodyId).toBe(operation.targetBodyId);
  });
});
