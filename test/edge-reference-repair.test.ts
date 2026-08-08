import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  attachDerivedState,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * Self-healing for legacy hash-only edge modifiers.
 *
 * A closed-edge hash embeds its circumference, so a fillet saved with
 * `edgeHashes` alone (every pre-v5 write path, most recently the assistant's
 * pre-Aug-2026 patch pipeline) dies on the first upstream radius edit. While
 * those hashes still resolve — i.e. any clean rebuild — the kernel can prove
 * a v5 reference for each selected edge and publish it as a repair. These
 * tests pin that loop end to end: discovery, persistence via
 * `CommandManager.normalize`, survival of the radius edit that used to fail,
 * and the fail-closed behaviour of documents that are already broken at rest.
 */

const user = toUserId('user_reference_repair');

function selectableEdges(body: BodyRepresentation | undefined) {
  return (body?.topology?.edges ?? []).filter(
    (edge) => edge.displayRole !== 'seam'
  );
}

function cylinderDocument(
  radius: number,
  height: number
): { document: ProjectDocument; bodyId: BodyId } {
  const document = addPrimitiveFeature(
    createProjectDocument('Reference repair', user),
    {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius, height }
    }
  );
  return { document, bodyId: document.bodyOrder.at(-1)! };
}

function withRadius(
  document: ProjectDocument,
  radius: number
): ProjectDocument {
  const cylinder = listFeaturesInOrder(document).find(
    (feature) => feature.name === 'Cylinder'
  )!;
  return updateFeature(document, {
    featureId: cylinder.featureId,
    data: { dimensions: { radius } }
  });
}

describe('edge reference repair', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  async function hashOnlyFillet(radius = 15): Promise<{
    document: ProjectDocument;
    filletBodyId: BodyId;
    filletFeatureId: string;
    edgeHashes: number[];
  }> {
    const { document, bodyId } = cylinderDocument(radius, 28);
    const base = await adapter.syncDocument(document);
    expect(base.warnings).toEqual([]);
    const edgeHashes = selectableEdges(base.bodyRepresentations[bodyId]).map(
      (edge) => edge.hash
    );
    expect(edgeHashes).toHaveLength(2);
    const filleted = filletEdges(document, {
      name: 'Round Outside Edges',
      targetBodyId: bodyId,
      edgeHashes,
      size: 2
    });
    const feature = listFeaturesInOrder(filleted.document).find(
      (candidate) => candidate.name === 'Round Outside Edges'
    )!;
    return {
      document: filleted.document,
      filletBodyId: filleted.bodyId,
      filletFeatureId: feature.featureId,
      edgeHashes
    };
  }

  it('publishes a repair for a hash-only fillet whose hashes still resolve', async () => {
    const { document, filletFeatureId, edgeHashes } = await hashOnlyFillet();
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    expect(derived.referenceRepairs).toHaveLength(1);
    const repair = derived.referenceRepairs![0]!;
    expect(repair.featureId).toBe(filletFeatureId);
    expect(repair.edgeReferences).toHaveLength(2);
    // Each proven reference matches a stored hash exactly, so persisting them
    // alongside the untouched edgeHashes satisfies the resolver's contract.
    expect(
      repair.edgeReferences.map((reference) => reference.currentHash).sort()
    ).toEqual([...edgeHashes].sort());
    for (const reference of repair.edgeReferences) {
      expect(reference.kind).toBe('edge');
      expect(reference.lineageName).toBeTruthy();
      expect(reference.producingFeatureId).toBeTruthy();
    }
  });

  it('publishes no repair when the fillet already has references', async () => {
    const { document, bodyId } = cylinderDocument(15, 28);
    const base = await adapter.syncDocument(document);
    const edges = selectableEdges(base.bodyRepresentations[bodyId]);
    const filleted = filletEdges(document, {
      name: 'Referenced fillet',
      targetBodyId: bodyId,
      edgeHashes: edges.map((edge) => edge.hash),
      edgeReferences: edges.map((edge) => edge.reference!),
      size: 2
    });
    const derived = await adapter.syncDocument(filleted.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.referenceRepairs).toBeUndefined();
  });

  it('a persisted repair survives the radius edit that used to fail', async () => {
    const { document, filletBodyId, filletFeatureId } = await hashOnlyFillet();
    const derived = await adapter.syncDocument(document);
    const repair = derived.referenceRepairs![0]!;

    // The app-side normalization: persist references, leave hashes alone.
    const repaired = updateFeature(document, {
      featureId: repair.featureId,
      data: { edgeReferences: repair.edgeReferences }
    });
    expect(repair.featureId).toBe(filletFeatureId);

    // The rebuild that proved the repair emits it once; the repaired
    // document is clean and quiet.
    const settled = await adapter.syncDocument(repaired);
    expect(settled.warnings).toEqual([]);
    expect(settled.referenceRepairs).toBeUndefined();

    // The user's original gesture: drag the cylinder radius, previews
    // included. Every step now resolves by lineage.
    for (const radius of [14.5, 14, 15.5]) {
      const after = await adapter.syncDocument(withRadius(repaired, radius));
      expect(after.warnings).toEqual([]);
      expect(after.bodyRepresentations[filletBodyId]).toBeTruthy();
    }

    // Same geometry as building the resized fillet from scratch.
    const resized = await adapter.syncDocument(withRadius(repaired, 14));
    const { document: freshDoc, bodyId: freshBody } = cylinderDocument(14, 28);
    const freshBase = await adapter.syncDocument(freshDoc);
    const freshEdges = selectableEdges(freshBase.bodyRepresentations[freshBody]);
    const freshFillet = filletEdges(freshDoc, {
      name: 'Fresh fillet',
      targetBodyId: freshBody,
      edgeHashes: freshEdges.map((edge) => edge.hash),
      edgeReferences: freshEdges.map((edge) => edge.reference!),
      size: 2
    });
    const fresh = await adapter.syncDocument(freshFillet.document);
    expect(resized.bodyRepresentations[filletBodyId]!.volume).toBeCloseTo(
      fresh.bodyRepresentations[freshFillet.bodyId]!.volume,
      6
    );
  });

  it('normalize persists a repair without stealing an undo step', async () => {
    const { document, filletFeatureId } = await hashOnlyFillet();
    const derived = await adapter.syncDocument(document);
    const repair = derived.referenceRepairs![0]!;

    const manager = new CommandManager(document);
    const versionBefore = manager.document.version;
    expect(manager.canUndo).toBe(false);

    manager.normalize(
      commandFactories.updateFeature(
        {
          featureId: repair.featureId,
          data: { edgeReferences: repair.edgeReferences }
        },
        'Repair edge references'
      )
    );

    // Persisted like an edit: version moved, command logged — but no undo
    // entry appeared for the user to trip over.
    expect(manager.document.version).toBeGreaterThan(versionBefore);
    expect(manager.canUndo).toBe(false);
    expect(manager.document.commandLog.at(-1)?.label).toBe(
      'Repair edge references'
    );
    const feature = listFeaturesInOrder(manager.document).find(
      (candidate) => candidate.featureId === filletFeatureId
    )!;
    expect(
      feature.data.featureKind === 'fillet' && feature.data.edgeReferences
    ).toHaveLength(2);

    const after = await adapter.syncDocument(
      withRadius(manager.document, 14)
    );
    expect(after.warnings).toEqual([]);
  });

  it('publishes no repair for a document already broken at rest', async () => {
    const { document, filletBodyId } = await hashOnlyFillet();
    // Saved mid-failure: the radius moved while the fillet was hash-only.
    const broken = withRadius(document, 14);
    const derived = await adapter.syncDocument(broken);
    expect(derived.warnings).toEqual([
      'Feature "Round Outside Edges": A selected edge no longer exists. ' +
        'Re-select the edges and re-create this feature.'
    ]);
    expect(derived.bodyRepresentations[filletBodyId]).toBeUndefined();
    expect(derived.referenceRepairs).toBeUndefined();
  });

  it('attachDerivedState never persists repairs into the document', async () => {
    const { document } = await hashOnlyFillet();
    const derived = await adapter.syncDocument(document);
    expect(derived.referenceRepairs).toHaveLength(1);
    const attached = attachDerivedState(document, derived);
    expect(attached.derived.referenceRepairs).toBeUndefined();
    expect(attached.derived.warnings).toEqual(derived.warnings);
  });
});
