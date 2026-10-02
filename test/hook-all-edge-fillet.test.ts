import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAllEdgesFilletProposal,
  parseCadPatchProposal,
  type CadSelectionContext
} from '@openzcad/ai-contracts';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  importStepBody,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { CommandManager } from '@openzcad/command-system';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';

/**
 * The complete 46-edge synthetic hook through the production all-edge path:
 * the installed kernel package, the shared all-edge proposal builder behind
 * both the manual Fillet control and the assistant suggestion, and the exact
 * provider-free request string (typo included).
 *
 * Fixture (matches the upstream kernel qualification exactly): a 60x50x6
 * plate, a 60x8x10 lip, two 6x20x18 ribs, and an r4 through bore — 46 sharp
 * edges, pre 26818.4071, filleted 26670.8733 at r=1 with 12 tori
 * (8 rib mirrors + 2 lip notches + 2 hole-rim bands).
 *
 * Provenance: the pre volume is the closed form 27120-pi*96 (OCC measures the
 * native hook at 26818.4071); the post volume is a kernel measurement (OCC
 * measures the Remus STEP at 26670.8681), not a closed form. STEP round-trips
 * must agree with the measured post volume — a mesh fallback would miss by
 * orders of magnitude more than these bands.
 */
const HOOK_PRE_VOLUME = 26818.4071;
const HOOK_POST_VOLUME = 26670.8733;
const REQUEST = 'add a filet on all edges by 1 mm';

const selection: CadSelectionContext = {
  bodyIds: [],
  featureIds: [],
  topologies: []
};

async function buildHook(adapter: ExactKernelAdapter): Promise<ProjectDocument> {
  let doc = createProjectDocument('Hook', toUserId('user_hook'));
  const addBox = (
    name: string,
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number
  ) => {
    doc = addPrimitiveFeature(doc, {
      name,
      primitiveKind: 'box',
      dimensions: { width, height, depth }
    });
    const id = doc.bodyOrder.at(-1)!;
    doc = transformBody(doc, {
      name: `${name} place`,
      targetBodyId: id,
      translation: { x, y, z }
    }).document;
    return id;
  };
  const plate = addBox('Plate', 60, 50, 6, 0, 0, 0);
  const lip = addBox('Lip', 60, 8, 10, 0, 42, 6);
  const ribA = addBox('RibA', 6, 20, 18, 12, 10, 6);
  const ribB = addBox('RibB', 6, 20, 18, 42, 10, 6);
  const fused = booleanBodies(doc, {
    name: 'Fuse frame',
    operation: 'union',
    targetBodyIds: [plate, lip, ribA, ribB]
  });
  doc = fused.document;
  doc = addPrimitiveFeature(doc, {
    name: 'Bore tool',
    primitiveKind: 'cylinder',
    dimensions: { radius: 4, height: 10 }
  });
  const tool = doc.bodyOrder.at(-1)!;
  doc = transformBody(doc, {
    name: 'Centre bore',
    targetBodyId: tool,
    translation: { x: 30, y: 25, z: -2 }
  }).document;
  doc = booleanBodies(doc, {
    name: 'Drill',
    operation: 'subtract',
    targetBodyIds: [fused.bodyId, tool]
  }).document;
  return { ...doc, derived: await adapter.syncDocument(doc) };
}

describe('hook all-edge fillet', { timeout: 240_000 }, () => {
  let adapter: ExactKernelAdapter;
  let hook: ProjectDocument;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    hook = await buildHook(adapter);
  });
  afterAll(() => adapter.dispose());

  it('builds the 46-edge hook at its closed-form volume', async () => {
    const bodyId = hook.derived.exportableBodyIds[0]!;
    const body = hook.derived.bodyRepresentations[bodyId]!;
    expect(
      body.topology!.edges.filter((edge) => edge.displayRole !== 'seam')
    ).toHaveLength(46);
    expect(Math.abs(body.volume - HOOK_PRE_VOLUME)).toBeLessThan(0.05);
    expect(hook.derived.warnings).toEqual([]);
  });

  it('parses the provider-free request into a 46-edge proposal', async () => {
    const result = createAllEdgesFilletProposal(hook, selection, REQUEST);
    expect(result?.error).toBeUndefined();
    const proposal = parseCadPatchProposal(result!.proposal!);
    const operation = proposal.operations[0]!;
    expect(operation.kind).toBe('add_edge_modifier');
    expect(
      operation.kind === 'add_edge_modifier' && operation.edgeHashes
    ).toHaveLength(46);
    expect(operation).toMatchObject({ size: 1 });
  });

  it('previews the exact 12-torus result without touching the source', async () => {
    const original = JSON.stringify(hook);
    const result = createAllEdgesFilletProposal(hook, selection, REQUEST);
    const proposal = parseCadPatchProposal(result!.proposal!);
    const preview = await preflightCadPatch(hook, proposal, (candidate) =>
      adapter.syncDocument(candidate)
    );
    expect(preview.candidate.derived.warnings).toEqual([]);
    expect(preview.candidate.derived.exportableBodyIds).toHaveLength(1);
    const bodyId = preview.candidate.derived.exportableBodyIds[0]!;
    const rounded = preview.candidate.derived.bodyRepresentations[bodyId]!;
    expect(Math.abs(rounded.volume - HOOK_POST_VOLUME)).toBeLessThan(0.05);
    const surfaces = rounded.topology!.faces.map(
      (face) => face.geometry?.surfaceType
    );
    expect(surfaces.filter((type) => type === 'plane')).toHaveLength(18);
    expect(surfaces.filter((type) => type === 'cylinder')).toHaveLength(43);
    expect(surfaces.filter((type) => type === 'sphere')).toHaveLength(18);
    expect(surfaces.filter((type) => type === 'torus')).toHaveLength(12);
    // Preview only: the source document is unchanged.
    expect(JSON.stringify(hook)).toBe(original);
    expect(hook.featureOrder).toHaveLength(
      preview.candidate.featureOrder.length - 1
    );
  });

  it('edits the radius monotonically and refuses oversized atomically', async () => {
    const original = JSON.stringify(hook);
    const result = createAllEdgesFilletProposal(hook, selection, REQUEST);
    const proposal = parseCadPatchProposal(result!.proposal!);
    const resize = (size: number) => ({
      ...proposal,
      operations: proposal.operations.map((operation) =>
        operation.kind === 'add_edge_modifier'
          ? { ...operation, size }
          : operation
      )
    });
    const previewSmall = await preflightCadPatch(
      hook,
      resize(0.5),
      (candidate) => adapter.syncDocument(candidate)
    );
    const smallId = previewSmall.candidate.derived.exportableBodyIds[0]!;
    const small =
      previewSmall.candidate.derived.bodyRepresentations[smallId]!;
    expect(small.volume).toBeGreaterThan(HOOK_POST_VOLUME);
    expect(small.volume).toBeLessThan(HOOK_PRE_VOLUME);
    await expect(
      preflightCadPatch(hook, resize(10), (candidate) =>
        adapter.syncDocument(candidate)
      )
    ).rejects.toThrow(/corner|blend|fillet|radius/i);
    // Neither the edit nor the refusal commits anything.
    expect(JSON.stringify(hook)).toBe(original);
    expect((await adapter.syncDocument(hook)).warnings).toEqual([]);
  });

  it('applies in one transaction with undo, redo, reload, and STEP round-trip', async () => {
    const result = createAllEdgesFilletProposal(hook, selection, REQUEST);
    const proposal = parseCadPatchProposal(result!.proposal!);
    const preview = await preflightCadPatch(hook, proposal, (candidate) =>
      adapter.syncDocument(candidate)
    );
    const manager = new CommandManager(hook);
    const applied = manager.runTransaction('Apply AI patch', preview.commands);
    expect(applied.featureOrder).toHaveLength(hook.featureOrder.length + 1);
    expect(applied.commandLog).toHaveLength(hook.commandLog.length + 1);
    const synced = {
      ...applied,
      derived: await adapter.syncDocument(applied)
    };
    const bodyId = synced.derived.exportableBodyIds[0]!;
    const finished = synced.derived.bodyRepresentations[bodyId]!;
    expect(finished.volume).toBe(
      preview.candidate.derived.bodyRepresentations[bodyId]!.volume
    );
    expect(synced.derived.warnings).toEqual([]);

    const undone = manager.undo();
    expect(undone.featureOrder).toHaveLength(hook.featureOrder.length);
    const restored = await adapter.syncDocument(undone);
    const restoredId = restored.exportableBodyIds[0]!;
    expect(
      Math.abs(
        restored.bodyRepresentations[restoredId]!.volume - HOOK_PRE_VOLUME
      )
    ).toBeLessThan(0.05);
    const redone = manager.redo();
    expect(redone.featureOrder).toHaveLength(applied.featureOrder.length);

    const reloaded = JSON.parse(
      JSON.stringify(applied)
    ) as ProjectDocument;
    const resynced = {
      ...reloaded,
      derived: await adapter.syncDocument(reloaded)
    };
    expect(resynced.derived.bodyRepresentations[bodyId]!.volume).toBe(
      finished.volume
    );
    expect(resynced.derived.warnings).toEqual([]);

    const step = await adapter.exportStep(synced, [bodyId]);
    const roundTrip = importStepBody(
      createProjectDocument('Hook rebuilt', toUserId('user_hook')),
      {
        name: 'Rounded hook',
        artifactId: 'rounded-hook',
        sourceName: 'rounded-hook.step',
        stepText: step
      }
    );
    const rebuilt = await adapter.syncDocument(roundTrip.document);
    expect(rebuilt.warnings).toEqual([]);
    expect(
      Math.abs(
        rebuilt.bodyRepresentations[roundTrip.bodyId]!.volume -
          finished.volume
      )
    ).toBeLessThan(0.1);
  });
});
