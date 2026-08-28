import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  getLatestSketchId
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type FaceTopology,
  type ProjectDocument,
  type SketchPlaneRef
} from '@openzcad/shared';
import { faceSketchAttachment } from '../apps/web/src/lib/faceSketchAttachment';

/**
 * Where a face sketch's origin sits, and what that means for documents that
 * were already saved.
 *
 * A sketch's stored coordinates are measured from its plane's origin, and the
 * rebuild re-derives that origin from the live face every time. So moving the
 * anchor is not a refinement of a number — it relocates every sketch that
 * resolves through it. These tests pin both halves: a new sketch lands on the
 * face's area centroid, and a sketch written before that anchor existed keeps
 * resolving against the vertex mean it was drawn against.
 */
describe('face sketch anchor', () => {
  let kernel: ExactKernelAdapter;

  beforeAll(async () => {
    kernel = await createExactKernelAdapter();
  });

  afterAll(() => kernel.dispose());

  /** A radius-10 puck, and the cap a sketch would be placed on. */
  async function puck(): Promise<{
    document: ProjectDocument;
    bodyId: BodyId;
    cap: FaceTopology;
  }> {
    let base = createProjectDocument('Puck', toUserId('user_face_anchor'));
    base = addSketchFeature(base, {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: { objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }
    }).document;
    const extruded = extrudeSketch(base, {
      name: 'Extrude',
      sketchId: getLatestSketchId(base)!,
      distance: 8
    });
    const derived = await kernel.syncDocument(extruded.document);
    const cap = derived.bodyRepresentations[extruded.bodyId]!.topology!.faces
      .filter((face) => face.geometry?.surfaceType === 'plane')
      .reduce((best, face) =>
        face.geometry!.center.z > best.geometry!.center.z ? face : best
      );
    return {
      document: { ...extruded.document, derived },
      bodyId: extruded.bodyId,
      cap
    };
  }

  /** Centre of a boss extruded from a 2 mm circle at the sketch origin. */
  async function bossCentre(
    document: ProjectDocument,
    planeRef: SketchPlaneRef
  ): Promise<{ x: number; y: number }> {
    const { document: withSketch, sketchId } = addSketchFeature(document, {
      name: 'Boss profile',
      planeRef,
      objects: [{ objectKind: 'circle', radius: 2, centerX: 0, centerY: 0 }]
    });
    const boss = extrudeSketch(withSketch, {
      name: 'Boss',
      sketchId,
      distance: 3
    });
    const derived = await kernel.syncDocument(boss.document);
    const bbox = derived.bodyRepresentations[boss.bodyId]!.bbox;
    return {
      x: (bbox.min.x + bbox.max.x) / 2,
      y: (bbox.min.y + bbox.max.y) / 2
    };
  }

  it('puts a new sketch on the face centroid, not on its seam vertex', async () => {
    const { document, bodyId, cap } = await puck();
    const rim = cap.geometry!.center;
    // The cap's boundary is one closed circle, so its only vertex is the seam.
    expect(Math.hypot(rim.x, rim.y)).toBeCloseTo(10, 9);

    const attachment = faceSketchAttachment({
      bodyId,
      pickedHash: cap.hash,
      face: cap
    });
    expect(attachment.ok).toBe(true);
    if (!attachment.ok) return;

    const centre = await bossCentre(document, attachment.planeRef);
    expect(Math.hypot(centre.x, centre.y)).toBeLessThan(1e-6);
  });

  it('leaves a sketch saved before the centroid exactly where it was', async () => {
    const { document, bodyId, cap } = await puck();
    const geometry = cap.geometry!;
    // Byte-for-byte what the app persisted before the centroid existed: the
    // vertex mean as both the snapshot centre and the frame origin, and no
    // `sourceCentroid` to say otherwise.
    const legacy: SketchPlaneRef = {
      type: 'face',
      bodyId,
      faceHash: cap.hash,
      faceReference: cap.reference!,
      sourceArea: geometry.area,
      sourceCenter: { ...geometry.center },
      sourceNormal: { ...geometry.normal! },
      frame: {
        origin: { ...geometry.center },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        zAxis: { ...geometry.normal! }
      }
    };

    const centre = await bossCentre(document, legacy);
    // Still on the rim, a full radius out — moving it would have silently
    // relocated this boss in every document that already contains one.
    expect(Math.hypot(centre.x, centre.y)).toBeCloseTo(10, 6);
  });
});
