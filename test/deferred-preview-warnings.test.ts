import { expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  directEditBody,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { offsetPreviewRejection } from '../apps/web/src/lib/interaction/offsetPreview';

it.each([false, true])(
  'keeps background validation warnings scoped during a face preview (deferred=%s)',
  async (deferTopology) => {
    const adapter = await createExactKernelAdapter();
    let restoreValidation: (() => void) | undefined;
    try {
      let doc = addPrimitiveFeature(
        createProjectDocument('Warning scope', toUserId('preview_test')),
        {
          name: 'Edited box',
          primitiveKind: 'box',
          dimensions: { width: 10, height: 8, depth: 6 }
        }
      );
      doc = addPrimitiveFeature(doc, {
        name: 'Background box',
        primitiveKind: 'box',
        dimensions: { width: 2, height: 2, depth: 2 }
      });
      const bodyId = doc.bodyOrder[0]!;
      const before = await adapter.syncDocument(doc);
      const face = before.bodyRepresentations[bodyId]!.topology!.faces.find(
        (candidate) => (candidate.geometry?.normal?.x ?? 0) > 0.99
      )!;
      const geometry = face.geometry!;
      const candidate = directEditBody(doc, {
        name: 'Push valid face',
        targetBodyId: bodyId,
        operation: {
          kind: 'offset-face',
          faceHash: face.hash,
          faceReference: face.reference,
          sourceSurfaceType: 'plane',
          sourceArea: geometry.area,
          sourceCenter: geometry.center,
          sourceNormal: geometry.normal!,
          offset: 1
        }
      }).document;
      const feature = listFeaturesInOrder(candidate).at(-1)!;
      const validate = RemusKernel.prototype.validateSolidRelaxed;
      const validation = vi
        .spyOn(RemusKernel.prototype, 'validateSolidRelaxed')
        .mockImplementation(function (this: RemusKernel, solid: number) {
          const bounds = this.boundingBox(solid);
          return bounds[3]! - bounds[0]! === 2 ? 1 : validate.call(this, solid);
        });

      restoreValidation = () => {
        validation.mockRestore();
      };
      const preview = await adapter.previewGeometry(candidate, {
        deferTopology
      });
      expect(preview.warnings).toEqual([
        'Body "Background box Body" failed exact B-rep validation.'
      ]);
      expect(preview.featureWarnings).toEqual([]);
      expect(preview.bodyRepresentations[bodyId]!.bbox.max.x).toBe(11);
      expect(
        offsetPreviewRejection({
          label: feature.name,
          bodyId,
          validationTargets: [
            {
              featureName: feature.name,
              featureId: feature.featureId,
              resultBodyId: bodyId
            }
          ],
          derived: preview,
          documentMoved: false
        })
      ).toBeNull();
      const completed = await adapter.syncDocument(candidate);
      expect(completed.warnings).toEqual(preview.warnings);
      expect(completed.featureWarnings).toEqual(preview.featureWarnings);
      expect(completed.bodyRepresentations[bodyId]!.volume).toBe(528);
      expect(completed.bodyRepresentations[bodyId]!.mesh).toEqual(
        preview.bodyRepresentations[bodyId]!.mesh
      );
    } finally {
      restoreValidation?.();
      adapter.dispose();
    }
  }
);
