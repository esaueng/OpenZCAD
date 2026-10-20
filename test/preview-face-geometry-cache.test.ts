import { expect, it } from 'vitest';
import { directEditBody } from '@openzcad/document-core';
import type {
  FaceTopology,
  GeometryReadyState,
  ProjectDocument
} from '@openzcad/shared';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { createNativeHolderStages } from './fixtures/hammer-holder/native-document';

interface CacheProbe {
  previewFaceGeometry: { hits: number; misses: number; digestHits: number };
}

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

const faceGeometries = (preview: GeometryReadyState, bodyId: string) =>
  preview.bodyRepresentations[bodyId as never]!.topology!.faces.map((face) => ({
    hash: face.hash,
    geometry: face.geometry
  }));

it('reuses unchanged face measurements across drag previews without changing them', async () => {
  const { secondArm } = createNativeHolderStages();
  const document = secondArm.document;
  const bodyId = secondArm.bodyId;
  const dragging = await createExactKernelAdapter();
  try {
    const base = await dragging.syncDocument(document);
    // An arm's top: moving it reshapes that arm's side faces, while the
    // plate and the other arm keep their shape.
    const face = base.bodyRepresentations[bodyId]!.topology!.faces.filter(
      (candidate) =>
        candidate.geometry?.surfaceType === 'plane' &&
        (candidate.geometry.normal?.z ?? 0) > 0.99
    ).sort((a, b) => b.geometry!.center.z - a.geometry!.center.z)[0];
    expect(face?.geometry?.center.z).toBeCloseTo(58, 6);
    const source = { ...document, derived: base };
    const probe = dragging as unknown as CacheProbe;
    // Out, further out, back to an earlier value, and inward: each preview
    // must equal a cold adapter's measurement of the same candidate.
    for (const offset of [1, 2.5, 1, -1.5]) {
      const candidate = offsetCandidate(source, bodyId, face!, offset);
      const preview = await dragging.previewGeometry(candidate, {
        deferTopology: true
      });
      expect(preview.warnings).toEqual([]);
      // The other arm also reaches 58, so an inward move keeps the top.
      expect(preview.bodyRepresentations[bodyId]!.bbox.max.z).toBeCloseTo(
        Math.max(58, 58 + offset),
        6
      );
      const cold = await createExactKernelAdapter();
      try {
        const reference = await cold.previewGeometry(candidate, {
          deferTopology: true
        });
        expect(faceGeometries(preview, bodyId)).toEqual(
          faceGeometries(reference, bodyId)
        );
      } finally {
        cold.dispose();
      }
    }
    // Most faces are untouched by the move and were measured only once.
    // A kernel with exact face digests reuses them by digest before the
    // shape key is ever built, so both kinds of reuse count.
    const { hits, digestHits, misses } = probe.previewFaceGeometry;
    expect(hits + digestHits).toBeGreaterThan(misses);
  } finally {
    dragging.dispose();
  }
}, 120_000);
