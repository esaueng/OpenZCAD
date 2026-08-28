import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  holeBody,
  type HoleInput
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type FaceTopology,
  type ProjectDocument,
  type SketchObjectData,
  type Vector3
} from '@openzcad/shared';

/**
 * Where a hole's (u, v) is measured from, and what that means for documents
 * that were already saved.
 *
 * A hole stores no world position — it re-derives one at every rebuild from
 * the resolved entry face — so the anchor that offset is added to decides
 * where the bore actually lands. Moving the anchor is therefore not a
 * refinement of a number; it relocates every hole that resolves through it.
 * These tests pin both halves: a new hole at (0, 0) lands on the entry face's
 * area centroid, and a hole drilled before that anchor existed keeps landing
 * on the vertex mean it was placed against.
 */
describe('hole entry anchor', () => {
  let kernel: ExactKernelAdapter;

  beforeAll(async () => {
    kernel = await createExactKernelAdapter();
  });

  afterAll(() => kernel.dispose());

  const BORE_RADIUS = 3;
  const HEIGHT = 8;

  /**
   * Extrudes one sketch region and returns its top cap.
   *
   * The region path is deliberate: given no profile, `extrudeSketch` extrudes
   * `objectIds[0]` alone, which is one line of the trapezoid and not a closed
   * profile at all.
   */
  async function cappedBody(
    name: string,
    objects: SketchObjectData[]
  ): Promise<{
    document: ProjectDocument;
    bodyId: BodyId;
    cap: FaceTopology;
  }> {
    const { document: sketched, sketchId } = addSketchFeature(
      createProjectDocument(name, toUserId('user_hole_anchor')),
      {
        name: 'Profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects
      }
    );
    const sketch = findSketch(sketched, sketchId)!;
    const regions = computeSketchRegions(
      sketch.objectIds.map((id) => ({
        id,
        data: (sketched.nodes[id] as { data: SketchObjectData }).data
      })),
      (value) => (typeof value === 'number' ? value : Number(value))
    );
    const region = regions.reduce((best, candidate) =>
      candidate.area > best.area ? candidate : best
    );
    const extruded = extrudeSketch(sketched, {
      name: 'Extrude',
      sketchId,
      distance: HEIGHT,
      profiles: [
        {
          profileId: region.profileId,
          regionFingerprint: region.regionFingerprint,
          samplePoint: region.centroid,
          sourceArea: region.area,
          sourceEntityIds: region.sourceEntityIds
        }
      ]
    });
    const derived = await kernel.syncDocument(extruded.document);
    expect(derived.warnings).toEqual([]);
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

  /** A radius-10 puck: one closed circular edge, so the cap has one vertex. */
  const puck = () =>
    cappedBody('Puck', [
      { objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }
    ]);

  /**
   * A trapezoid, whose cap leans its area centroid toward the wider end and
   * away from the vertex mean while keeping both well inside the material.
   *
   * The round cap cannot show the legacy half: a bore centred on its rim
   * straddles the outer wall and no longer cuts an exact solid at all.
   */
  const trapezoid = () =>
    cappedBody(
      'Trapezoid',
      (
        [
          [0, 0, 40, 0],
          [40, 0, 30, 20],
          [30, 20, 10, 20],
          [10, 20, 0, 0]
        ] as const
      ).map(([x1, y1, x2, y2]) => ({ objectKind: 'line' as const, x1, y1, x2, y2 }))
    );

  /** Drills the hole and reports where the resulting bore's axis sits. */
  async function boreAxis(
    document: ProjectDocument,
    input: Omit<HoleInput, 'name'>
  ): Promise<Vector3> {
    const drilled = holeBody(document, { name: 'Bore', ...input });
    const derived = await kernel.syncDocument(drilled.document);
    expect(derived.warnings).toEqual([]);
    const bore = derived.bodyRepresentations[
      drilled.bodyId
    ]!.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'cylinder' &&
        Math.abs((face.geometry.radius ?? 0) - BORE_RADIUS) < 1e-6
    );
    expect(bore, 'the drilled bore should exist').toBeDefined();
    return bore!.geometry!.axisStart!;
  }

  /** Everything a hole needs beyond the anchor under test. */
  const bore = (bodyId: BodyId, cap: FaceTopology) =>
    ({
      targetBodyId: bodyId,
      faceHash: cap.hash,
      ...(cap.reference ? { faceReference: cap.reference } : {}),
      style: 'simple',
      diameter: 2 * BORE_RADIUS,
      depthMode: 'through',
      position: { u: 0, v: 0 }
    }) satisfies Omit<HoleInput, 'name'>;

  it('puts a new hole in the middle of a round face, not on its seam', async () => {
    const { document, bodyId, cap } = await puck();
    const vertexMean = cap.geometry!.center;
    // The cap's boundary is one closed circle, so its only vertex is the seam:
    // a full radius from the middle, which is what made this hole miss.
    expect(Math.hypot(vertexMean.x, vertexMean.y)).toBeCloseTo(10, 9);

    const axis = await boreAxis(document, {
      ...bore(bodyId, cap),
      positionAnchor: 'centroid'
    });
    expect(Math.hypot(axis.x, axis.y)).toBeLessThan(1e-6);
  });

  it('measures a new hole from the entry face centroid', async () => {
    const { document, bodyId, cap } = await trapezoid();
    const centroid = cap.geometry!.centroid;
    expect(centroid).toBeDefined();
    // The two anchors are a millimetre apart here, so neither can pass for
    // the other at the tolerance the placement is asserted on below.
    expect(
      Math.abs(centroid!.y - cap.geometry!.center.y)
    ).toBeGreaterThan(1);

    const axis = await boreAxis(document, {
      ...bore(bodyId, cap),
      positionAnchor: 'centroid'
    });
    expect(axis.x).toBeCloseTo(centroid!.x, 6);
    expect(axis.y).toBeCloseTo(centroid!.y, 6);
  });

  it('leaves a hole drilled before the centroid exactly where it was', async () => {
    const { document, bodyId, cap } = await trapezoid();
    const vertexMean = cap.geometry!.center;

    // Byte-for-byte what the app persisted before the centroid existed: the
    // same (u, v), and no `positionAnchor` to say what it is measured from.
    const axis = await boreAxis(document, bore(bodyId, cap));

    // Still the vertex mean. Switching the anchor unconditionally would have
    // silently relocated this bore in every document that already contains one.
    expect(axis.x).toBeCloseTo(vertexMean.x, 6);
    expect(axis.y).toBeCloseTo(vertexMean.y, 6);
  });
});
