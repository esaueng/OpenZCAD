import { expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  directEditBody,
  extrudeSketch
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type GeometryBodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';
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

function circleExtrusion(
  document: ProjectDocument,
  name: string,
  centerX: number
): ProjectDocument {
  const sketch = addSketchFeature(document, {
    name: `${name} profile`,
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [{ objectKind: 'circle', radius: 3, centerX, centerY: 0 }]
  });
  return extrudeSketch(sketch.document, {
    name,
    sketchId: sketch.sketchId,
    distance: 4
  }).document;
}

it('drag previews mesh a body the drag rebuilt once, not on every tick', async () => {
  let document: ProjectDocument = createProjectDocument(
    'Preview display reuse',
    toUserId('preview_display_reuse')
  );
  for (let index = 0; index < 17; index += 1) {
    document = addPrimitiveFeature(document, {
      name: `Box ${index}`,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 8, depth: 6 }
    });
  }
  // Features 17-20, then the edit at 21. The stable checkpoints are at 17
  // and 19, so the drag's first tick replays the untouched extrusion (20)
  // with new handles, and its committed measurement no longer applies.
  document = circleExtrusion(document, 'Edited', 40);
  document = circleExtrusion(document, 'Untouched', 80);
  const [edited, untouched] = document.bodyOrder.slice(-2) as [BodyId, BodyId];
  const adapter = await createExactKernelAdapter();
  const tessellations = countTessellations();
  try {
    const base = await adapter.syncDocument(document);
    const top = base.bodyRepresentations[edited]!.topology!.faces.find(
      (face) => (face.geometry?.normal?.z ?? 0) > 0.99
    )!;
    const source = { ...document, derived: base };
    const offsetBy = (offset: number) =>
      directEditBody(source, {
        name: 'Offset',
        targetBodyId: edited,
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
    const meshed: number[] = [];
    let first: GeometryBodyRepresentation | undefined;
    for (const offset of [1, 2, 2.5, -1]) {
      const before = tessellations.count();
      const preview = await adapter.previewGeometry(offsetBy(offset), {
        deferTopology: true
      });
      expect(preview.warnings).toEqual([]);
      meshed.push(tessellations.count() - before);
      const body = preview.bodyRepresentations[untouched]!;
      if (first) {
        // Exactly what the first tick meshed, in owned buffers.
        expect(body).toEqual(first);
        expect(body.mesh.vertices).not.toBe(first.mesh.vertices);
      } else {
        first = body;
      }
    }
    // The first tick meshes both extrusions; later ticks only the edited one.
    expect(meshed).toEqual([2, 1, 1, 1]);

    // A preview display never stands in for a complete measurement.
    const committed = offsetBy(-1);
    const synced = await adapter.syncDocument(committed);
    const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
    try {
      const expected = await fresh.syncDocument(committed);
      for (const bodyId of [edited, untouched]) {
        expect(synced.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
          expected.bodyRepresentations[bodyId]!.volume,
          9
        );
        expect(synced.bodyRepresentations[bodyId]!.topology?.edges).toEqual(
          expected.bodyRepresentations[bodyId]!.topology?.edges
        );
      }
    } finally {
      fresh.dispose();
    }
  } finally {
    tessellations.restore();
    adapter.dispose();
  }
});
