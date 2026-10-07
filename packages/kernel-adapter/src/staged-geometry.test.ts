import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type GeometryReadyState } from '@openzcad/shared';
import { createExactKernelAdapter } from './exact';
import { isBuildCancelled } from './exact-cancellation';
import { buildDocumentHistoryCooperatively } from './exact-build-loop';
import { CooperativeWork } from './cooperative-work';
import { RemusKernel } from './remus-runtime';

function boxes(count = 1) {
  let doc = createProjectDocument('Staged geometry', toUserId('stage_test'));
  for (let i = 0; i < count; i += 1)
    doc = addPrimitiveFeature(doc, {
      name: `Box ${i}`,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 8, depth: 6 }
    });
  return doc;
}

describe('validated geometry before analysis', () => {
  it('serializes concurrent callers while a yielded build still owns its arena', async () => {
    const adapter = await createExactKernelAdapter();
    const first = boxes(1),
      second = boxes(3);
    try {
      const [a, b] = await Promise.all([
        adapter.syncDocument(first, undefined, undefined, undefined, {
          onGeometryReady: () => {}
        }),
        adapter.syncDocument(second, undefined, undefined, undefined, {
          onGeometryReady: () => {}
        })
      ]);
      expect(
        Object.values(a.bodyRepresentations).map((body) => body.volume)
      ).toEqual([480]);
      expect(
        Object.values(b.bodyRepresentations).map((body) => body.volume)
      ).toEqual([480, 480, 480]);
      expect(a.warnings).toEqual([]);
      expect(b.warnings).toEqual([]);
    } finally {
      adapter.dispose();
    }
  });

  it('cancels safely when disposed at a task boundary', async () => {
    const adapter = await createExactKernelAdapter();
    await expect(
      adapter.syncDocument(boxes(), undefined, undefined, undefined, {
        onGeometryReady: () => adapter.dispose()
      })
    ).rejects.toSatisfy(isBuildCancelled);
    expect(adapter.currentMassPropertiesEpoch()).toBeNull();
    const fresh = await adapter.syncDocument(boxes());
    expect(Object.values(fresh.bodyRepresentations)[0]!.volume).toBe(480);
    adapter.dispose();
  });
  it('publishes no quantity and owns buffers independently of the completed result', async () => {
    const adapter = await createExactKernelAdapter();
    const doc = boxes();
    let geometry: GeometryReadyState | undefined;
    const stages: string[] = [];
    try {
      const result = await adapter.syncDocument(
        doc,
        (stage) => {
          if (stage.status === 'completed') stages.push(stage.name);
        },
        undefined,
        undefined,
        {
          onGeometryReady: (snapshot) => {
            geometry = snapshot;
            expect(snapshot.analysis).toBe('pending');
            expect(
              stages.some((name) => name.endsWith(': Geometry validation'))
            ).toBe(true);
            expect(stages.some((name) => name.endsWith(': Volume'))).toBe(
              false
            );
            const body = snapshot.bodyRepresentations[doc.bodyOrder[0]!]!;
            expect('volume' in body).toBe(false);
            // A display observer cannot corrupt retained measurement or topology.
            body.mesh.vertices.fill(999);
            body.topology!.faces.length = 0;
          }
        }
      );
      expect(geometry).toBeDefined();
      const body = result.bodyRepresentations[doc.bodyOrder[0]!]!;
      expect(body.volume).toBeCloseTo(480, 10);
      expect(body.topology!.faces).toHaveLength(6);
      expect(body.mesh.vertices.every((value) => value !== 999)).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(
        (await adapter.syncDocument(doc)).bodyRepresentations[body.bodyId]!
          .volume
      ).toBe(body.volume);
    } finally {
      adapter.dispose();
    }
  });

  it('receives a cancel message task after geometry publication, before analysis commits', async () => {
    const adapter = await createExactKernelAdapter();
    const doc = boxes();
    let cancelled = false;
    try {
      const pending = adapter.syncDocument(
        doc,
        undefined,
        undefined,
        undefined,
        {
          cancellation: { isCancelled: () => cancelled },
          onGeometryReady: () => {
            setTimeout(() => {
              cancelled = true;
            }, 0);
          }
        }
      );
      await expect(pending).rejects.toSatisfy(isBuildCancelled);
      const recovered = await adapter.syncDocument(doc);
      expect(recovered.warnings).toEqual([]);
      expect(
        recovered.bodyRepresentations[doc.bodyOrder[0]!]!.volume
      ).toBeCloseTo(480, 10);
    } finally {
      adapter.dispose();
    }
  });

  it('processes a message between features and keeps the synchronous API contract', async () => {
    const kernel = new RemusKernel();
    let cancelled = false;
    const work = new CooperativeWork(0);
    const started: number[] = [];
    try {
      const pending = buildDocumentHistoryCooperatively(
        { run: (step) => step(), checkpoint: () => work.checkpoint() },
        kernel,
        boxes(3),
        undefined,
        undefined,
        undefined,
        undefined,
        (index) => {
          if (index === 0)
            setTimeout(() => {
              cancelled = true;
            }, 0);
        },
        (index) => {
          started.push(index);
        },
        undefined,
        undefined,
        { isCancelled: () => cancelled }
      );
      await expect(pending).rejects.toSatisfy(isBuildCancelled);
      expect(started).toEqual([0]);
    } finally {
      kernel.free();
    }
  });
});
