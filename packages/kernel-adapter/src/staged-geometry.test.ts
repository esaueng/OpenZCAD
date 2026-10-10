import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  addPrimitiveFeature,
  createProjectDocument,
  importStepBody,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type GeometryReadyState
} from '@openzcad/shared';
import { CommandManager, commandFactories } from '@openzcad/command-system';
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
  it.each([
    ['e-analytic-fillet-plate.step', true],
    ['e-nurbs-fillet-plate.step', false]
  ] as const)(
    'previews %s without recognition and preserves the fresh full verdict',
    async (filename, supported) => {
      const adapter = await createExactKernelAdapter();
      const fresh = await createExactKernelAdapter();
      const imported = importStepBody(
        createProjectDocument('Filleted plate', toUserId('stage_test')),
        {
          name: 'Plate',
          sourceName: filename,
          artifactId: 'artifact_preview_plate',
          stepText: readFileSync(
            new URL(
              `../../../test/parity/corpus/${filename}`,
              import.meta.url
            ),
            'utf8'
          )
        }
      );
      try {
        const before = await adapter.syncDocument(imported.document);
        expect(before.warnings).toEqual([]);
        const faces =
          before.bodyRepresentations[imported.bodyId]!.topology!.faces;
        expect(
          faces.some((face) => face.geometry?.surfaceType === 'bspline')
        ).toBe(!supported);
        const top = faces.find(
          (face) =>
            face.geometry?.surfaceType === 'plane' &&
            face.geometry.normal!.z > 0.99
        )!;
        expect(top).toBeDefined();
        const command = commandFactories.directEditBody({
          name: 'Push face',
          targetBodyId: imported.bodyId,
          operation: {
            kind: 'offset-face',
            faceHash: top.hash,
            ...(top.reference ? { faceReference: top.reference } : {}),
            sourceSurfaceType: 'plane',
            sourceArea: top.geometry!.area,
            sourceCenter: top.geometry!.center,
            sourceNormal: top.geometry!.normal!,
            offset: 1
          }
        });
        const candidate = command.apply(imported.document);
        const recognition = vi.spyOn(
          RemusKernel.prototype,
          'recognizeFeatures'
        );
        try {
          const geometry = await adapter.previewGeometry(candidate);
          expect(geometry.warnings).toEqual(
            supported
              ? []
              : [
                  'Feature "Push face": offset: move-face does not support face Id(7) (nurbs): face is adjacent to selected move boundary edge 8'
                ]
          );
          expect(recognition).not.toHaveBeenCalled();
          const previewBody = geometry.bodyRepresentations[imported.bodyId]!;
          expect('volume' in previewBody).toBe(false);
          const full = await adapter.syncDocument(candidate);
          if (supported) expect(recognition).toHaveBeenCalled();
          const independent = await fresh.syncDocument(candidate);
          expect(full.warnings).toEqual(geometry.warnings);
          expect(independent.warnings).toEqual(geometry.warnings);
          const result = full.bodyRepresentations[imported.bodyId]!;
          const reference = independent.bodyRepresentations[imported.bodyId]!;
          expect(previewBody.bbox).toEqual(result.bbox);
          expect(previewBody.mesh).toEqual(result.mesh);
          expect(result.volume).toBe(reference.volume);
          expect(result.bbox).toEqual(reference.bbox);
          expect(result.mesh).toEqual(reference.mesh);
        } finally {
          recognition.mockRestore();
        }
      } finally {
        adapter.dispose();
        fresh.dispose();
      }
    },
    120_000
  );
  it('finishes a drag preview without volume analysis and still completes authoritative release', async () => {
    const adapter = await createExactKernelAdapter();
    const doc = boxes();
    const volume = vi.spyOn(RemusKernel.prototype, 'volume');
    try {
      const geometry = await adapter.previewGeometry(doc);
      const body = geometry.bodyRepresentations[doc.bodyOrder[0]!]!;
      expect(geometry.analysis).toBe('pending');
      expect(geometry.warnings).toEqual([]);
      expect('volume' in body).toBe(false);
      expect('massProperties' in body).toBe(false);
      expect(volume).not.toHaveBeenCalled();
      expect(adapter.currentMassPropertiesEpoch()).toBeNull();
      // A preview observer cannot change retained exact geometry or a release.
      body.mesh.vertices.fill(999);
      body.topology!.faces.length = 0;
      const complete = await adapter.syncDocument(doc);
      const committed = complete.bodyRepresentations[doc.bodyOrder[0]!]!;
      expect(volume).toHaveBeenCalled();
      expect(committed.volume).toBe(480);
      expect(committed.topology!.faces).toHaveLength(6);
      expect(committed.mesh.vertices.every((value) => value !== 999)).toBe(
        true
      );
      expect(adapter.currentMassPropertiesEpoch()).not.toBeNull();
    } finally {
      volume.mockRestore();
      adapter.dispose();
    }
  });

  it('retains validation warnings in a geometry-only preview and cancels stale work', async () => {
    const adapter = await createExactKernelAdapter();
    const doc = boxes();
    const validation = vi
      .spyOn(RemusKernel.prototype, 'validateSolidRelaxed')
      .mockReturnValue(1);
    try {
      const geometry = await adapter.previewGeometry(doc);
      expect(geometry.warnings).toEqual([
        'Body "Box 0 Body" failed exact B-rep validation.'
      ]);
      expect('volume' in geometry.bodyRepresentations[doc.bodyOrder[0]!]!).toBe(
        false
      );
      await expect(
        adapter.previewGeometry(doc, {
          cancellation: { isCancelled: () => true }
        })
      ).rejects.toSatisfy(isBuildCancelled);
      expect(adapter.currentMassPropertiesEpoch()).toBeNull();
      const complete = await adapter.syncDocument(doc);
      expect(geometry.warnings).toEqual(complete.warnings);
      expect(geometry.featureWarnings).toEqual(complete.featureWarnings);
    } finally {
      validation.mockRestore();
      adapter.dispose();
    }
  });
  it('owns current warning attribution, including intentional suppression', async () => {
    const manager = new CommandManager(boxes(2));
    const feature = listFeaturesInOrder(manager.document)[0]!;
    manager.execute(
      commandFactories.setNodeMetadata({
        nodeId: feature.id,
        metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
      })
    );
    const adapter = await createExactKernelAdapter();
    let published = false;
    const message =
      'Feature "Box 0": Suppressed; skipped during exact rebuild.';
    try {
      const result = await adapter.syncDocument(
        manager.document,
        undefined,
        undefined,
        undefined,
        {
          onGeometryReady: (snapshot) => {
            published = true;
            expect(snapshot.warnings).toEqual([message]);
            expect(snapshot.featureWarnings).toMatchObject([
              { featureName: 'Box 0', kind: 'suppressed', message }
            ]);
            snapshot.featureWarnings![0]!.message = 'Observer mutation';
          }
        }
      );
      expect(published).toBe(true);
      expect(result.featureWarnings).toMatchObject([
        { featureName: 'Box 0', kind: 'suppressed', message }
      ]);
      expect(result.warnings).toEqual([message]);
      expect(
        Object.values(result.bodyRepresentations).map((body) => body.volume)
      ).toEqual([480]);
    } finally {
      adapter.dispose();
    }
  });
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
