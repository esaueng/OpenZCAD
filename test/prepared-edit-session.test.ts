import { expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  listFeaturesInOrder,
  setParameter,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type DerivedState } from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

function comparable({ updatedAt: _time, ...derived }: DerivedState) {
  return {
    ...derived,
    bodyRepresentations: Object.fromEntries(
      Object.entries(derived.bodyRepresentations).map(([id, body]) => [
        id,
        {
          ...body,
          mesh: {
            kind: body.mesh.kind,
            triangles: body.mesh.indices.length / 3
          }
        }
      ])
    )
  };
}

it('reuses fixed exact intersections/transforms, invalidates changed operands and retires restored handles', async () => {
  let document = setParameter(
    createProjectDocument('Edit session', toUserId('test')),
    { name: 'width', expression: '10' }
  );
  for (const width of ['width', 12, 8])
    document = addPrimitiveFeature(document, {
      name: `Box ${width}`,
      primitiveKind: 'box',
      dimensions: { width, height: 10, depth: 6 }
    });
  const fixed = document.bodyOrder[1]!,
    cutter = document.bodyOrder[2]!;
  const intersection = booleanBodies(document, {
    name: 'Fixed section',
    operation: 'intersect',
    targetBodyIds: [fixed, cutter]
  });
  document = transformBody(intersection.document, {
    name: 'Fixed move',
    targetBodyId: intersection.bodyId,
    translation: { x: 30, y: 0, z: 0 }
  }).document;
  const events: RebuildCacheEvent[] = [];
  const adapter = await createExactKernelAdapter({
    onRebuildCacheEvent: (e) => events.push(e)
  });
  const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
  const intersect = vi.spyOn(RemusKernel.prototype, 'booleanWithCancellation');
  try {
    await adapter.syncDocument(document);
    intersect.mockClear();
    const changed = setParameter(document, { name: 'width', expression: '14' });
    const result = await adapter.syncDocument(changed);
    expect(events.at(-1)?.reusedPreparedFeatures).toBe(2);
    expect(intersect).not.toHaveBeenCalled();
    expect(comparable(result)).toEqual(
      comparable(await fresh.syncDocument(changed))
    );
    const preview = await adapter.previewGeometry(changed, {
      deferTopology: true
    });
    // Upstream face edits validate all affected features, including consumed
    // operands. Omitting their records falsely rejects an otherwise valid drag.
    expect(Object.keys(preview.bodyRepresentations).sort()).toEqual(
      [...changed.bodyOrder].sort()
    );
    expect(preview.bodyRepresentations[fixed]!.consumed).toBe(true);
    expect(preview.bodyRepresentations[fixed]!.mesh.indices).toHaveLength(0);
    expect(
      preview.bodyRepresentations[intersection.bodyId]!.mesh.indices.length
    ).toBeGreaterThan(0);

    const feature = listFeaturesInOrder(changed)[2]!;
    const newOperand = updateFeature(changed, {
      featureId: feature.featureId,
      data: { dimensions: { width: 7, height: 10, depth: 6 } }
    });
    intersect.mockClear();
    const rebuilt = await adapter.syncDocument(newOperand);
    expect(intersect).toHaveBeenCalled();
    expect(events.at(-1)?.reusedPreparedFeatures ?? 0).toBe(0);
    expect(comparable(rebuilt)).toEqual(
      comparable(await fresh.syncDocument(newOperand))
    );
    // Return to the earlier branch after actual checkpoint restoration.
    expect(comparable(await adapter.syncDocument(document))).toEqual(
      comparable(await fresh.syncDocument(document))
    );
  } finally {
    intersect.mockRestore();
    adapter.dispose();
    fresh.dispose();
  }
}, 120_000);

it('publishes disposable meshes with pending topology and completes all metadata on release', async () => {
  const document = addPrimitiveFeature(
    createProjectDocument('Drag', toUserId('test')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 8, depth: 6 }
    }
  );
  const adapter = await createExactKernelAdapter();
  try {
    const preview = await adapter.previewGeometry(document, {
      deferTopology: true
    });
    const body = preview.bodyRepresentations[document.bodyOrder[0]!]!;
    expect(preview).toMatchObject({
      analysis: 'pending',
      topology: 'pending',
      warnings: []
    });
    expect(body.topology?.faces).toHaveLength(6);
    expect(body.topology?.edges).toEqual([]);
    expect(body.mesh.indices.length).toBeGreaterThan(0);
    expect('volume' in body).toBe(false);
    const complete = await adapter.syncDocument(document);
    expect(complete.warnings).toEqual([]);
    const measured = complete.bodyRepresentations[document.bodyOrder[0]!]!;
    expect(measured.volume).toBeCloseTo(480, 8);
    expect(measured.topology?.faces).toHaveLength(6);
    expect(measured.bbox).toEqual(body.bbox);
    const compatible = await adapter.previewGeometry(document);
    expect(compatible.topology).toBeUndefined();
    expect(
      compatible.bodyRepresentations[document.bodyOrder[0]!]!.topology?.faces
    ).toHaveLength(6);
  } finally {
    adapter.dispose();
  }
});

it('replays a fixed intersection when an earlier feature changes operand consumption', async () => {
  let document = createProjectDocument('Consumption guard', toUserId('test'));
  for (const width of [12, 14, 8, 16])
    document = addPrimitiveFeature(document, {
      name: `Box ${width}`,
      primitiveKind: 'box',
      dimensions: { width, height: 10, depth: 6 }
    });
  const [a, b, c, d] = document.bodyOrder;
  const union = booleanBodies(document, {
    name: 'Earlier union',
    operation: 'union',
    targetBodyIds: [a!, b!]
  });
  const unionFeature = listFeaturesInOrder(union.document).at(-1)!;
  document = booleanBodies(union.document, {
    name: 'Fixed intersection',
    operation: 'intersect',
    targetBodyIds: [a!, c!]
  }).document;
  const events: RebuildCacheEvent[] = [];
  const adapter = await createExactKernelAdapter({
    onRebuildCacheEvent: (event) => events.push(event)
  });
  const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
  try {
    await adapter.syncDocument(document);
    // The exact handles and geometry of A/C stay identical. A was consumed
    // before the intersection in the first build, but is not in this one.
    const changed = updateFeature(document, {
      featureId: unionFeature.featureId,
      data: { targetBodyIds: [b!, d!] }
    });
    const result = await adapter.syncDocument(changed);
    expect(result.bodyRepresentations[a!]!.consumed).toBe(true);
    expect(events.at(-1)?.reusedPreparedFeatures ?? 0).toBe(0);
    expect(comparable(result)).toEqual(
      comparable(await fresh.syncDocument(changed))
    );
  } finally {
    adapter.dispose();
    fresh.dispose();
  }
});
