import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  transformBody,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import type {
  BodyId,
  DerivedState,
  EdgeTopology,
  FaceTopology,
  ProjectDocument
} from '@openzcad/shared';
import {
  booleanEvolutionProbeNeeded,
  normalizeBooleanLineageDemand
} from '../packages/kernel-adapter/src/exact-boolean-evolution';
import * as evolutionModule from '../packages/kernel-adapter/src/exact-boolean-evolution';
import { historyFeatureDigest } from '../packages/kernel-adapter/src/exact-history-cache';

/**
 * K05 on-demand boolean evolution probe.
 *
 * Idle rebuilds still skip the probe for a terminal boolean; a transient,
 * non-persisted lineage demand (body ids whose producing booleans must
 * probe) forces it — for the result body itself or any descendant through
 * the same chain the gate tracks. The demand flips the per-feature history
 * digest so a cached carrier-only checkpoint is never reused, and the
 * worker rebuild cache keys on it separately.
 */

const user = toUserId('user_boolean_demand_probe');

function fusedPlateDocument(): { document: ProjectDocument; bodyId: BodyId } {
  let document = addPrimitiveFeature(
    createProjectDocument('Demand boolean probe', user),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 24, depth: 10 }
    }
  );
  const plateId = document.bodyOrder[0]!;
  document = addPrimitiveFeature(document, {
    name: 'Post',
    primitiveKind: 'box',
    dimensions: { width: 12, height: 24, depth: 30 }
  });
  const postId = document.bodyOrder[1]!;
  return {
    ...booleanBodies(document, {
      name: 'Fuse',
      operation: 'union',
      targetBodyIds: [plateId, postId]
    })
  };
}

function booleanFeatureOf(document: ProjectDocument) {
  const feature = listFeaturesInOrder(document).find(
    (candidate) => candidate.data.featureKind === 'boolean'
  )!;
  expect(feature, 'boolean feature').toBeDefined();
  return feature;
}

function edgesOf(derived: DerivedState, bodyId: BodyId): EdgeTopology[] {
  return derived.bodyRepresentations[bodyId]?.topology?.edges ?? [];
}

function facesOf(derived: DerivedState, bodyId: BodyId): FaceTopology[] {
  const body = derived.bodyRepresentations[bodyId];
  expect(body, 'result body').toBeDefined();
  return body!.topology!.faces;
}

function lineageKey(derived: DerivedState, bodyId: BodyId): string {
  const body = derived.bodyRepresentations[bodyId]!;
  const faces = (body.topology?.faces ?? [])
    .map((face) => [
      face.hash,
      face.reference?.lineageName ?? null,
      face.reference?.producingFeatureId ?? null
    ])
    .sort((a, b) => (a[0] as number) - (b[0] as number));
  const edges = (body.topology?.edges ?? [])
    .map((edge) => [
      edge.hash,
      edge.reference?.lineageName ?? null,
      edge.reference?.producingFeatureId ?? null
    ])
    .sort((a, b) => (a[0] as number) - (b[0] as number));
  const diagnostics = (body.topology?.lineageDiagnostics ?? [])
    .map((entry) => `${entry.kind}:${entry.status}:${entry.message}`)
    .sort();
  return JSON.stringify({ faces, edges, diagnostics });
}

describe('booleanEvolutionProbeNeeded with lineage demand', () => {
  it('is false for a terminal boolean without demand', () => {
    const { document } = fusedPlateDocument();
    expect(
      booleanEvolutionProbeNeeded(document, booleanFeatureOf(document))
    ).toBe(false);
    expect(
      booleanEvolutionProbeNeeded(
        document,
        booleanFeatureOf(document),
        []
      )
    ).toBe(false);
  });

  it('is true when the terminal result body is demanded', () => {
    const { document, bodyId } = fusedPlateDocument();
    const feature = booleanFeatureOf(document);
    expect(booleanEvolutionProbeNeeded(document, feature, [bodyId])).toBe(
      true
    );
    expect(
      booleanEvolutionProbeNeeded(document, feature, new Set([bodyId]))
    ).toBe(true);
  });

  it('still skips when an unrelated body is demanded', () => {
    const { document } = fusedPlateDocument();
    const other = addPrimitiveFeature(document, {
      name: 'Other',
      primitiveKind: 'box',
      dimensions: { width: 5, height: 5, depth: 5 }
    });
    const otherId = other.bodyOrder.at(-1)!;
    expect(
      booleanEvolutionProbeNeeded(
        other,
        booleanFeatureOf(document),
        [otherId]
      )
    ).toBe(false);
  });

  it('is true when a demanded descendant forces its ancestor boolean', () => {
    const { document, bodyId } = fusedPlateDocument();
    const moved = transformBody(document, {
      name: 'Move',
      targetBodyId: bodyId,
      translation: { x: 5, y: 0, z: 0 }
    });
    // The transform merely carries the result, so without demand the probe
    // still skips; demanding the moved body forces the ancestor boolean.
    expect(
      booleanEvolutionProbeNeeded(moved.document, booleanFeatureOf(document))
    ).toBe(false);
    expect(
      booleanEvolutionProbeNeeded(
        moved.document,
        booleanFeatureOf(document),
        [moved.bodyId]
      )
    ).toBe(true);
  });

  it('normalizes demand: dedupes, drops empty, sorts for keys', () => {
    const { bodyId } = fusedPlateDocument();
    expect(normalizeBooleanLineageDemand(undefined).size).toBe(0);
    expect(normalizeBooleanLineageDemand([]).size).toBe(0);
    expect(
      normalizeBooleanLineageDemand([bodyId, bodyId]).size
    ).toBe(1);
  });

  it('mixes demand into the history digest', () => {
    const { document, bodyId } = fusedPlateDocument();
    const feature = booleanFeatureOf(document);
    const index = listFeaturesInOrder(document).findIndex(
      (candidate) => candidate.featureId === feature.featureId
    );
    const plain = historyFeatureDigest(document, feature, index);
    const demanded = historyFeatureDigest(document, feature, index, undefined, [
      bodyId
    ]);
    const unrelated = historyFeatureDigest(
      document,
      feature,
      index,
      undefined,
      ['body_unrelated' as BodyId]
    );
    expect(demanded).not.toBe(plain);
    expect(unrelated).toBe(plain);
  });
});

describe('on-demand probe rebuild behaviour', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 60_000);

  afterAll(() => {
    adapter.dispose();
  });

  it('probes a demanded terminal boolean; undemanded still skips', async () => {
    const { document, bodyId } = fusedPlateDocument();
    const spy = vi.spyOn(evolutionModule, 'probeBooleanEntityEvolution');
    try {
      spy.mockClear();
      const skipped = await adapter.syncDocument(document);
      expect(skipped.warnings).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
      expect(
        edgesOf(skipped, bodyId).some(
          (edge) => edge.reference?.lineageName?.startsWith('boolean.edge.')
        )
      ).toBe(false);

      spy.mockClear();
      const demanded = await adapter.syncDocument(
        document,
        undefined,
        undefined,
        undefined,
        [bodyId]
      );
      expect(demanded.warnings).toEqual([]);
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      expect(
        edgesOf(demanded, bodyId).some(
          (edge) => edge.reference?.lineageName?.startsWith('boolean.edge.')
        )
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('re-probes a cached carrier-only boolean once demanded, byte for byte', async () => {
    const caching = await createExactKernelAdapter();
    try {
      const { document, bodyId } = fusedPlateDocument();
      const spy = vi.spyOn(evolutionModule, 'probeBooleanEntityEvolution');
      try {
        spy.mockClear();
        const carrier = await caching.syncDocument(document);
        expect(carrier.warnings).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
        const carrierKey = lineageKey(carrier, bodyId);

        spy.mockClear();
        const demanded = await caching.syncDocument(
          document,
          undefined,
          undefined,
          undefined,
          [bodyId]
        );
        expect(demanded.warnings).toEqual([]);
        expect(spy.mock.calls.length).toBeGreaterThan(0);
        const demandedKey = lineageKey(demanded, bodyId);
        expect(demandedKey).not.toBe(carrierKey);
        expect(
          edgesOf(demanded, bodyId).some(
            (edge) => edge.reference?.lineageName?.startsWith('boolean.edge.')
          )
        ).toBe(true);

        // A fresh adapter forced with the same demand publishes the identical
        // lineage, byte for byte: the cached carrier was not reused.
        const fresh = await createExactKernelAdapter();
        try {
          const forced = await fresh.syncDocument(
            document,
            undefined,
            undefined,
            undefined,
            [bodyId]
          );
          expect(lineageKey(forced, bodyId)).toBe(demandedKey);
        } finally {
          fresh.dispose();
        }
      } finally {
        spy.mockRestore();
      }
    } finally {
      caching.dispose();
    }
  });

  it('product regression: demanded edge pick persists a boolean.edge.* reference', async () => {
    const { document, bodyId } = fusedPlateDocument();
    // Idle rebuild publishes carrier-only lineage (no boolean edge names).
    const carrier = await adapter.syncDocument(document);
    expect(
      edgesOf(carrier, bodyId).some(
        (edge) => edge.reference?.lineageName?.startsWith('boolean.edge.')
      )
    ).toBe(false);

    // Raise demand for the terminal body and rebuild: lineage arrives.
    const demanded = await adapter.syncDocument(
      document,
      undefined,
      undefined,
      undefined,
      [bodyId]
    );
    const demandedEdges = edgesOf(demanded, bodyId);
    const picked =
      demandedEdges.find(
        (edge) => edge.reference?.lineageName?.startsWith('boolean.edge.')
      ) ?? demandedEdges[0]!;
    expect(picked, 'demanded edge').toBeDefined();

    // Commit a fillet on the picked edge, reading the CURRENT lineage at
    // commit time (as the UI must): the persisted reference carries the
    // boolean.edge.* name, matching what the pre-gate pipeline persisted.
    const rounded = filletEdges(document, {
      name: 'Round',
      targetBodyId: bodyId,
      edgeHashes: [picked.hash],
      ...(picked.reference ? { edgeReferences: [picked.reference] } : {}),
      size: 1
    });
    const filletData = listFeaturesInOrder(rounded.document).find(
      (feature) => feature.data.featureKind === 'fillet'
    )!.data;
    expect(filletData.featureKind).toBe('fillet');
    if (filletData.featureKind === 'fillet') {
      expect(filletData.edgeReferences).toBeDefined();
      expect(filletData.edgeReferences!.length).toBe(1);
      expect(
        filletData.edgeReferences![0]!.lineageName.startsWith('boolean.edge.')
      ).toBe(true);
    }
    const finished = await adapter.syncDocument(rounded.document);
    expect(finished.warnings).toEqual([]);

    // A face reference on the same demanded body keeps its carrier name.
    const demandedFaces = facesOf(demanded, bodyId);
    const namedFace = demandedFaces.find(
      (face) => face.reference?.kind === 'face' && face.reference.lineageName
    );
    expect(namedFace?.reference, 'demanded face keeps a carrier name').toBeDefined();
  });

  it('demand never reaches the persisted document or the derived echo', async () => {
    const { document, bodyId } = fusedPlateDocument();
    const before = JSON.stringify(withoutDerivedProjection(document));
    const derived = await adapter.syncDocument(
      document,
      undefined,
      undefined,
      undefined,
      [bodyId]
    );
    expect(JSON.stringify(withoutDerivedProjection(document))).toBe(before);
    expect(JSON.stringify(derived)).not.toContain(`${bodyId}demand`);
    expect(
      (derived as unknown as Record<string, unknown>).lineageDemand
    ).toBeUndefined();
    // Serialized persistence round-trips without the demand.
    const persisted = JSON.stringify(withoutDerivedProjection(document));
    expect(persisted).not.toContain('lineageDemand');
    expect(persisted).not.toContain('boolean.edge.demand');
  });
});
