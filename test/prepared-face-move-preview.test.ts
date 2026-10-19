import { expect, it, vi } from 'vitest';
import { directEditBody } from '@openzcad/document-core';
import type {
  FaceTopology,
  GeometryReadyState,
  ProjectDocument
} from '@openzcad/shared';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { createNativeHolderStages } from './fixtures/hammer-holder/native-document';

function offsetCandidate(
  document: ProjectDocument,
  bodyId: string,
  face: FaceTopology,
  offset: number
): ProjectDocument {
  const geometry = face.geometry!;
  return directEditBody(document, {
    name: `Offset ${offset}`,
    targetBodyId: bodyId as never,
    operation: {
      kind: 'offset-face',
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      sourceSurfaceType: 'plane',
      sourceArea: geometry.area,
      sourceCenter: geometry.center,
      sourceNormal: geometry.normal!,
      offset
    }
  }).document;
}

const body = (preview: GeometryReadyState, bodyId: string) => {
  const representation = preview.bodyRepresentations[bodyId as never]!;
  return {
    bbox: representation.bbox,
    faces: representation.topology!.faces.map((face) => ({
      hash: face.hash,
      geometry: face.geometry
    }))
  };
};

/**
 * A drag preview moves the same face of the same restored source on every
 * frame after the first, so on kernels that ship `prepareMoveFaces` it runs
 * the prepared move. Each frame must match a cold adapter's single preview of
 * the same candidate, which never prepares. Kernels without the API run the
 * unprepared move on both sides.
 */
it('drag previews through a prepared face move match cold previews', async () => {
  const proto = RemusKernel.prototype as unknown as Record<string, unknown>;
  const preparedCalls =
    typeof proto.moveFacesPreparedJournaled === 'function'
      ? vi.spyOn(
          RemusKernel.prototype as unknown as {
            moveFacesPreparedJournaled: (h: number, d: number) => string;
          },
          'moveFacesPreparedJournaled'
        )
      : null;
  const { secondArm } = createNativeHolderStages();
  const document = secondArm.document;
  const bodyId = secondArm.bodyId;
  const dragging = await createExactKernelAdapter();
  try {
    const base = await dragging.syncDocument(document);
    const face = base.bodyRepresentations[bodyId]!.topology!.faces.filter(
      (candidate) =>
        candidate.geometry?.surfaceType === 'plane' &&
        (candidate.geometry.normal?.z ?? 0) > 0.99
    ).sort((a, b) => b.geometry!.center.z - a.geometry!.center.z)[0];
    expect(face?.geometry?.center.z).toBeCloseTo(58, 6);
    const source = { ...document, derived: base };
    // Out, further out, back, inward, then out again: every distinct
    // distance after the first is a prepared move.
    for (const offset of [1, 2.5, 1, -1.5, 3.25]) {
      const candidate = offsetCandidate(source, bodyId, face!, offset);
      const preview = await dragging.previewGeometry(candidate, {
        deferTopology: true
      });
      expect(preview.warnings).toEqual([]);
      const cold = await createExactKernelAdapter();
      try {
        const reference = await cold.previewGeometry(candidate, {
          deferTopology: true
        });
        expect(reference.warnings).toEqual([]);
        expect(body(preview, bodyId)).toEqual(body(reference, bodyId));
      } finally {
        cold.dispose();
      }
    }
    if (preparedCalls) {
      expect(preparedCalls.mock.calls.length).toBeGreaterThanOrEqual(4);
    }
  } finally {
    preparedCalls?.mockRestore();
    dragging.dispose();
  }
}, 180_000);
