import { expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  directEditBody,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

const proto = RemusKernel.prototype as unknown as Record<string, unknown>;
// Remus kernels before esaueng/remus#1188 have no digests; the adapter then
// reads every face, which the other preview suites cover.
const hasDigests = typeof proto.faceContentDigests === 'function';

function documentWithExtrusion(): ProjectDocument {
  let document = addPrimitiveFeature(
    createProjectDocument('Preview face digests', toUserId('face_digests')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 8, depth: 6 }
    }
  );
  const sketch = addSketchFeature(document, {
    name: 'Profile',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [{ objectKind: 'circle', radius: 3, centerX: 40, centerY: 0 }]
  });
  document = extrudeSketch(sketch.document, {
    name: 'Extrusion',
    sketchId: sketch.sketchId,
    distance: 4
  }).document;
  return document;
}

/** The published previews of four drag ticks on the box's top face. */
async function dragPreviews(document: ProjectDocument, digests: boolean) {
  const saved = proto.faceContentDigests;
  if (!digests) proto.faceContentDigests = undefined;
  const box = document.bodyOrder[0] as BodyId;
  const adapter = await createExactKernelAdapter();
  try {
    const base = await adapter.syncDocument(document);
    const top = base.bodyRepresentations[box]!.topology!.faces.find(
      (face) => (face.geometry?.normal?.z ?? 0) > 0.99
    )!;
    const source = { ...document, derived: base };
    const previews = [];
    for (const offset of [1, 2, 2.5, 1]) {
      const candidate = directEditBody(source, {
        name: 'Offset',
        targetBodyId: box,
        operation: {
          kind: 'offset-face',
          faceHash: top.hash,
          ...(top.reference ? { faceReference: top.reference } : {}),
          sourceSurfaceType: 'plane',
          sourceArea: top.geometry!.area,
          sourceCenter: top.geometry!.center,
          sourceNormal: top.geometry!.normal!,
          offset
        }
      }).document;
      const { updatedAt: _updatedAt, ...preview } =
        await adapter.previewGeometry(candidate, { deferTopology: true });
      previews.push(preview);
    }
    const cache = (
      adapter as unknown as { previewFaceGeometry: { digestHits: number } }
    ).previewFaceGeometry;
    return { previews, digestHits: cache.digestHits };
  } finally {
    adapter.dispose();
    proto.faceContentDigests = saved;
  }
}

it.skipIf(!hasDigests)(
  'drag previews publish the same faces with or without face digests',
  async () => {
    const document = documentWithExtrusion();
    const withDigests = await dragPreviews(document, true);
    const without = await dragPreviews(document, false);
    expect(withDigests.previews).toEqual(without.previews);
    expect(without.digestHits).toBe(0);
    // Every tick after the first finds the box's untouched faces by digest.
    expect(withDigests.digestHits).toBeGreaterThan(0);
  }
);
