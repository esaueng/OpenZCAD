import { it, expect } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  importStepBody,
  directEditBody
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { createExactKernelAdapter } from './exact';
import { RemusKernel } from './remus-runtime';
import { blendCarrierSnapshot } from './exact-measure';

it.skipIf(
  typeof (RemusKernel.prototype as unknown as { prepareResizeBlend?: unknown })
    .prepareResizeBlend !== 'function'
)(
  'keeps single-band construction identity identical on prepared commit and replay',
  async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const sharp = addPrimitiveFeature(
        createProjectDocument('Prepared band', toUserId('test')),
        {
          name: 'Block',
          primitiveKind: 'box',
          dimensions: { width: 20, height: 20, depth: 20 }
        }
      );
      let state = await adapter.syncDocument(sharp);
      let id = state.exportableBodyIds[0]!;
      const edge = state.bodyRepresentations[id]!.topology!.edges.find(
        (e) => e.displayRole !== 'seam'
      )!;
      const native = filletEdges(sharp, {
        name: 'Fillet',
        targetBodyId: id,
        edgeHashes: [edge.hash],
        size: 3
      }).document;
      state = await adapter.syncDocument(native);
      const step = await adapter.exportStep(native, state.exportableBodyIds);
      let doc: ProjectDocument = importStepBody(
        createProjectDocument('Imported band', toUserId('test')),
        {
          name: 'Band',
          sourceName: 'band.step',
          artifactId: 'band',
          stepText: step
        }
      ).document;
      state = await adapter.syncDocument(doc);
      id = state.exportableBodyIds[0]!;
      for (const radius of [2, 1.5]) {
        const face = state.bodyRepresentations[id]!.topology!.faces.find(
          (f) => f.geometry?.featureType === 'blend'
        )!;
        const carrier = blendCarrierSnapshot(face.geometry)!;
        const next = directEditBody(doc, {
          name: `Band ${radius}`,
          targetBodyId: id,
          operation: {
            kind: 'resize-blend',
            faceHash: face.hash,
            faceReference: face.reference,
            surfaceClass: 'cylinder',
            recordedRadius: face.geometry!.radius!,
            recordedCenter: carrier.center,
            recordedAxis: carrier.axis,
            newRadius: radius
          }
        }).document;
        await adapter.previewGeometry(next, { deferTopology: true });
        state = await adapter.syncDocument(next);
        expect(state.warnings).toEqual([]);
        expect(
          state.bodyRepresentations[id]!.topology!.faces.some(
            (f) => f.geometry?.blendRadius === radius
          )
        ).toBe(true);
        doc = next;
      }
      const replay = await createExactKernelAdapter();
      try {
        const rebuilt = await replay.syncDocument(doc);
        expect(rebuilt.warnings).toEqual([]);
        expect(rebuilt.bodyRepresentations[id]!.mesh).toEqual(
          state.bodyRepresentations[id]!.mesh
        );
      } finally {
        replay.dispose();
      }
    } finally {
      adapter.dispose();
    }
  },
  60_000
);
