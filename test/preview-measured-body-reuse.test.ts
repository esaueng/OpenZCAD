import { expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  directEditBody
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

/** Counts `tessellateSolidGroupedBinary` calls on every kernel instance. */
function countTessellations(): { count: () => number; restore: () => void } {
  const proto = RemusKernel.prototype as unknown as Record<string, unknown>;
  const original = proto.tessellateSolidGroupedBinary as (
    ...args: unknown[]
  ) => unknown;
  let calls = 0;
  proto.tessellateSolidGroupedBinary = function (
    this: unknown,
    ...args: unknown[]
  ) {
    calls += 1;
    return original.apply(this, args);
  };
  return {
    count: () => calls,
    restore: () => {
      proto.tessellateSolidGroupedBinary = original;
    }
  };
}

it('drag previews reuse the committed measurement of bodies the edit leaves alone', async () => {
  let document: ProjectDocument = createProjectDocument(
    'Preview reuse',
    toUserId('preview_reuse')
  );
  for (const name of ['Untouched box', 'Edited box']) {
    document = addPrimitiveFeature(document, {
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 8, depth: 6 }
    });
  }
  const [untouched, edited] = document.bodyOrder as [BodyId, BodyId];
  const adapter = await createExactKernelAdapter();
  const tessellations = countTessellations();
  try {
    const base = await adapter.syncDocument(document);
    const committed = base.bodyRepresentations[untouched]!;
    const top = base.bodyRepresentations[edited]!.topology!.faces.find(
      (face) => (face.geometry?.normal?.z ?? 0) > 0.99
    )!;
    const geometry = top.geometry!;
    const source = { ...document, derived: base };
    let previous: Float32Array | undefined;
    for (const offset of [1, 2.5, -1]) {
      const candidate = directEditBody(source, {
        name: `Offset ${offset}`,
        targetBodyId: edited,
        operation: {
          kind: 'offset-face',
          faceHash: top.hash,
          ...(top.reference ? { faceReference: top.reference } : {}),
          sourceSurfaceType: 'plane',
          sourceArea: geometry.area,
          sourceCenter: geometry.center,
          sourceNormal: geometry.normal!,
          offset
        }
      }).document;
      const before = tessellations.count();
      const preview = await adapter.previewGeometry(candidate, {
        deferTopology: true
      });
      expect(preview.warnings).toEqual([]);
      // Only the edited body is meshed again.
      expect(tessellations.count() - before).toBe(1);
      expect(
        preview.bodyRepresentations[edited]!.bbox.max.z -
          base.bodyRepresentations[edited]!.bbox.max.z
      ).toBeCloseTo(offset, 9);
      // The untouched body is exactly what the commit published.
      const reused = preview.bodyRepresentations[untouched]!;
      expect(reused.mesh).toEqual(committed.mesh);
      expect(reused.bbox).toEqual(committed.bbox);
      expect(reused.topology?.edges).toEqual([]);
      expect(reused.topology?.faces).toEqual(
        committed.topology?.faces.map((face) => ({
          topologyId: face.topologyId,
          hash: face.hash,
          triangleStart: face.triangleStart,
          triangleCount: face.triangleCount,
          geometry: face.geometry
        }))
      );
      // Each preview owns its buffers: writing one leaves the cache intact.
      expect(reused.mesh.vertices).not.toBe(previous);
      reused.mesh.vertices.fill(Number.NaN);
      previous = reused.mesh.vertices;
    }
  } finally {
    tessellations.restore();
    adapter.dispose();
  }
});
