import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  gearBody,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type DerivedState } from '@openzcad/shared';
import { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import {
  between,
  edgeNamed,
  modifyEdge,
  teethOnBoss
} from '../support/gear-edge-fixtures';

function stableIds() {
  let serial = 0;
  return vi
    .spyOn(crypto, 'randomUUID')
    .mockImplementation(
      () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`
    );
}

function outputDigest(state: DerivedState) {
  const { updatedAt: _updatedAt, ...publication } = state;
  const digest = createHash('sha256').update(JSON.stringify(publication));
  for (const body of Object.values(state.bodyRepresentations)) {
    for (const data of [body.mesh.vertices, body.mesh.indices]) {
      digest.update(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      );
    }
  }
  return digest.digest('hex');
}

async function boxFixture(adapter: ExactKernelAdapter) {
  const document = addPrimitiveFeature(
    createProjectDocument('Box', toUserId('perf')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 10, depth: 10 }
    }
  );
  const bodyId = document.bodyOrder[0]!;
  const body = (await adapter.syncDocument(document)).bodyRepresentations[
    bodyId
  ]!;
  return { document, bodyId, body };
}

// Set EDGE_REBUILD_OUT to a fresh JSONL path on each revision. Stable document
// ids make the complete published body data comparable between processes.
const out = process.env.EDGE_REBUILD_OUT;
it.skipIf(!out).each([
  ['box', 'fillet'],
  ['box', 'chamfer'],
  ['gear', 'fillet'],
  ['gear', 'chamfer']
] as const)(
  'measures exact %s rebuilds with a %s',
  async (shape, operation) => {
    const ids = stableIds();
    const adapter = await createExactKernelAdapter();
    try {
      const base =
        shape === 'gear'
          ? await teethOnBoss(adapter, {
              fit: 'module',
              pitch: 0.9,
              faceWidth: 6,
              offset: 3
            })
          : await boxFixture(adapter);
      const edge =
        shape === 'gear'
          ? edgeNamed(base.body, between('cap.end', 'collar.end'))
          : base.body.topology!.edges.find((candidate) => candidate.reference)!;
      const modifier = modifyEdge(
        operation,
        base.document,
        base.bodyId,
        edge,
        0.4
      );
      const featureId = listFeaturesInOrder(modifier.document).at(
        -1
      )!.featureId;
      const cold = await createExactKernelAdapter();
      try {
        for (const [index, size] of [
          0.4, 0.41, 0.42, 0.43, 0.44, 0.45, 0.46, 0.47
        ].entries()) {
          const document = updateFeature(modifier.document, {
            featureId,
            data: operation === 'fillet' ? { radius: size } : { distance: size }
          });
          const start = performance.now();
          const state = await (index === 0 ? cold : adapter).syncDocument(
            document
          );
          const elapsedMs = performance.now() - start;
          expect(state.warnings).toEqual([]);
          const result = state.bodyRepresentations[modifier.bodyId]!;
          expect(result.volume).toBeLessThan(base.body.volume);
          appendFileSync(
            out!,
            JSON.stringify({
              shape,
              operation,
              size,
              phase:
                index === 0
                  ? 'cold-replay'
                  : index < 3
                    ? 'warmup'
                    : 'warm-edit',
              elapsedMs,
              inputEdges: base.body.topology!.edges.length,
              outputDigest: outputDigest(state)
            }) + '\n'
          );
        }
      } finally {
        cold.dispose();
      }
    } finally {
      adapter.dispose();
      ids.mockRestore();
    }
  },
  120_000
);

it.skipIf(!out).each([0, 20, 60])(
  'measures fresh generation with %i teeth (zero selects a cylinder)',
  async (teeth) => {
    const ids = stableIds();
    try {
      const empty = createProjectDocument(
        'Generation control',
        toUserId('perf')
      );
      const document =
        teeth === 0
          ? addPrimitiveFeature(empty, {
              name: 'Cylinder',
              primitiveKind: 'cylinder',
              dimensions: { radius: 6, height: 12 }
            })
          : gearBody(empty, {
              name: 'Gear',
              gearType: 'external',
              sizing: 'module',
              pitch: 1.5,
              teeth,
              faceWidth: 20,
              origin: { x: 0, y: 0, z: 0 },
              axis: { x: 0, y: 0, z: 1 }
            }).document;
      for (let sample = 0; sample < 6; sample++) {
        const adapter = await createExactKernelAdapter();
        // A separate untimed replay counts kernel calls without adding spy
        // allocations to the timings.
        const classify =
          sample === 5
            ? vi.spyOn(RemusKernel.prototype, 'classifyPoint')
            : undefined;
        try {
          const start = performance.now();
          const state = await adapter.syncDocument(document);
          const elapsedMs = performance.now() - start;
          expect(state.warnings).toEqual([]);
          expect(Object.keys(state.bodyRepresentations)).toHaveLength(1);
          appendFileSync(
            out!,
            JSON.stringify({
              teeth,
              sample,
              phase: classify ? 'classification-count' : 'fresh-generation',
              ...(classify
                ? { classifications: classify.mock.calls.length }
                : { elapsedMs }),
              outputDigest: outputDigest(state)
            }) + '\n'
          );
        } finally {
          classify?.mockRestore();
          adapter.dispose();
        }
      }
    } finally {
      ids.mockRestore();
    }
  },
  120_000
);
